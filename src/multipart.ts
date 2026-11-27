/**
 * 流式 multipart/form-data 解析器。
 *
 * 输入：Content-Type 中的 boundary + 异步字节流。
 * 输出：有序的 part 序列（AsyncIterable<Part>）。
 *   - 普通字段：按 UTF-8 解码为字符串（fatal，非法 UTF-8 整次失败）。
 *   - 文件 part：暴露可背压的 Readable 字节流。
 *
 * 语义要点：
 *   - 同名字段 / 同名文件严格按出现顺序交付。
 *   - 仅完整的分隔行（\r\n--boundary 后跟 CRLF / "--" / 传输填充）结束一个 part；
 *     文件内容中类似 boundary 的字节前缀原样保留。
 *   - 分隔行、头部、多字节字符可以跨任意输入块。
 *   - 前言 / 尾声被忽略，但仍计入总正文字节量。
 *   - 后端取消当前文件消费（destroy 其 stream）时，解析器以常量内存有界地丢弃
 *     该 part 余下内容并定位下一 part；丢弃字节仍计入单文件与总正文限额。
 *   - 整次请求取消（中断迭代或调用 cancel()）会结束所有未完成的 part。
 *   - 头部长度、字段长度、文件长度、part 数量、内部缓冲、总正文均有限额。
 *   - 缺少结束分隔符或非法 UTF-8 字段导致整次解析失败；已经交付的 part
 *     不代表请求整体成功。
 */

import { Readable } from 'node:stream';

const CR = 0x0d;
const LF = 0x0a;
const DASH = 0x2d; // '-'
const SPACE = 0x20;
const TAB = 0x09;

const utf8Encoder = new TextEncoder();

/** 解析失败时抛出的错误，code 标识失败原因。 */
export class MultipartError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'MultipartError';
    this.code = code;
  }
}

/** 内部使用：整次请求被取消时中断驱动协程。 */
class CancelledError extends Error {
  constructor() {
    super('multipart parsing cancelled');
    this.name = 'CancelledError';
  }
}

export interface MultipartLimits {
  /** 单个 part 头部块的最大字节数（含结尾 CRLFCRLF）。 */
  maxHeaderBytes: number;
  /** 单个普通字段值的最大字节数。 */
  maxFieldBytes: number;
  /** 单个文件 part 正文的最大字节数（含被取消后丢弃的字节）。 */
  maxFileBytes: number;
  /** 一次请求允许的最大 part 数。 */
  maxParts: number;
  /** 解析器内部缓冲的最大字节数。 */
  maxBufferBytes: number;
  /** 整个请求正文的最大字节数（含前言、尾声、被丢弃的文件内容）。 */
  maxTotalBytes: number;
}

export const DEFAULT_LIMITS: MultipartLimits = {
  maxHeaderBytes: 16 * 1024,
  maxFieldBytes: 1 * 1024 * 1024,
  maxFileBytes: 64 * 1024 * 1024,
  maxParts: 1000,
  maxBufferBytes: 1 * 1024 * 1024,
  maxTotalBytes: 256 * 1024 * 1024,
};

/** 输入字节源：异步可迭代或异步迭代器，元素为字节块（兼容字符串块与 Readable）。 */
export type ByteSource =
  | AsyncIterable<Uint8Array | string>
  | AsyncIterator<Uint8Array | string>;

export type PartHeaders = Record<string, string>;

export interface FieldPart {
  type: 'field';
  name: string;
  /** 按 UTF-8 解码并校验后的字段值。 */
  value: string;
  headers: PartHeaders;
}

export interface FilePart {
  type: 'file';
  name: string;
  filename: string;
  contentType: string | null;
  headers: PartHeaders;
  /** 可背压的文件字节流；destroy() 表示后端取消当前文件的消费。 */
  stream: Readable;
}

export type Part = FieldPart | FilePart;

/**
 * 文件 part 暴露给消费者的数据流。
 * 解析器在 push() 返回 false 时等待 _read 恢复拉取，实现背压；
 * 消费者 destroy() 后，解析器转入有界丢弃模式。
 */
class FilePartStream extends Readable {
  private demandWaiter: (() => void) | null = null;
  private eof = false;

  constructor() {
    // 显式高水位线：缓冲满后 push 返回 false，解析器暂停拉取上游（背压）。
    super({ highWaterMark: 16 * 1024 });
  }

  get cancelled(): boolean {
    return this.destroyed;
  }

  get ended(): boolean {
    return this.eof;
  }

  _read(): void {
    this.wake();
  }

  _destroy(error: Error | null, callback: (error: Error | null) => void): void {
    this.wake();
    callback(error);
  }

  wake(): void {
    const waiter = this.demandWaiter;
    this.demandWaiter = null;
    if (waiter) waiter();
  }

  /** 返回 push 的结果；false 表示内部缓冲已满，调用方应等待 waitForDemand。 */
  feed(chunk: Uint8Array): boolean {
    if (this.destroyed || this.eof) return false;
    return this.push(chunk);
  }

  endOfFile(): void {
    if (this.destroyed || this.eof) return;
    this.eof = true;
    this.push(null);
  }

  fail(error: Error): void {
    if (this.destroyed || this.eof) return;
    this.eof = true;
    this.destroy(error);
  }

  waitForDemand(): Promise<void> {
    if (this.destroyed || this.eof) return Promise.resolve();
    return new Promise<void>((resolve) => {
      this.demandWaiter = resolve;
    });
  }
}

/** 带总量 / 缓冲限额计量的增量字节读取器。 */
class ByteReader {
  private buf: Uint8Array = new Uint8Array(0);
  private src: AsyncIterator<Uint8Array | string>;
  private eof = false;
  private stopped = false;
  private limits: MultipartLimits;
  private isCancelled: () => boolean;
  /** 从源读取的总字节数（含前言、尾声与被丢弃内容）。 */
  totalBytes = 0;

  constructor(source: ByteSource, limits: MultipartLimits, isCancelled: () => boolean) {
    this.limits = limits;
    this.isCancelled = isCancelled;
    const iterable = source as AsyncIterable<Uint8Array | string>;
    this.src =
      typeof iterable[Symbol.asyncIterator] === 'function'
        ? iterable[Symbol.asyncIterator]()
        : (source as AsyncIterator<Uint8Array | string>);
  }

  get buffered(): number {
    return this.buf.length;
  }

  byteAt(index: number): number {
    return this.buf[index];
  }

  /** 再读入一个块；EOF 返回 false。所有读入字节计入 totalBytes 并受限额约束。 */
  async pump(): Promise<boolean> {
    if (this.eof) return false;
    if (this.isCancelled()) throw new CancelledError();
    let result: IteratorResult<Uint8Array | string>;
    try {
      result = await this.src.next();
    } catch (err) {
      this.eof = true;
      throw err;
    }
    if (this.isCancelled()) throw new CancelledError();
    if (result.done) {
      this.eof = true;
      return false;
    }
    let chunk = result.value;
    if (typeof chunk === 'string') chunk = utf8Encoder.encode(chunk);
    else if (!(chunk instanceof Uint8Array)) chunk = new Uint8Array(chunk);
    this.totalBytes += chunk.length;
    if (this.totalBytes > this.limits.maxTotalBytes) {
      throw new MultipartError(
        'LIMIT_TOTAL',
        `total body size exceeds ${this.limits.maxTotalBytes} bytes`,
      );
    }
    const merged = new Uint8Array(this.buf.length + chunk.length);
    merged.set(this.buf, 0);
    merged.set(chunk, this.buf.length);
    this.buf = merged;
    if (this.buf.length > this.limits.maxBufferBytes) {
      throw new MultipartError(
        'LIMIT_BUFFER',
        `internal buffer exceeds ${this.limits.maxBufferBytes} bytes`,
      );
    }
    return true;
  }

  /** 停止读取并尽量通知源（用于整次取消）。 */
  async stop(): Promise<void> {
    this.eof = true;
    if (this.stopped) return;
    this.stopped = true;
    const it = this.src as { return?: () => Promise<unknown> };
    if (typeof it.return === 'function') {
      try {
        await it.return();
      } catch {
        /* 忽略源在取消时的异常 */
      }
    }
  }

  /** 在已缓冲字节中查找模式串，返回起始下标或 -1。 */
  find(pattern: Uint8Array, from = 0): number {
    const hay = this.buf;
    const n = hay.length;
    const m = pattern.length;
    outer: for (let i = Math.max(0, from); i + m <= n; i++) {
      for (let j = 0; j < m; j++) {
        if (hay[i + j] !== pattern[j]) continue outer;
      }
      return i;
    }
    return -1;
  }

  /** 取走前 n 个字节（返回副本）。 */
  take(n: number): Uint8Array {
    const out = this.buf.slice(0, n);
    this.buf = this.buf.slice(n);
    return out;
  }
}

interface Disposition {
  type: string;
  params: Record<string, string>;
}

/** 解析 Content-Disposition，支持带引号（含 \" \\ 转义）与不带引号的参数。 */
export function parseContentDisposition(value: string | undefined): Disposition | null {
  if (!value) return null;
  let i = 0;
  const n = value.length;
  const skipWs = () => {
    while (i < n && (value[i] === ' ' || value[i] === '\t')) i += 1;
  };
  skipWs();
  const typeStart = i;
  while (i < n && value[i] !== ';') i += 1;
  const type = value.slice(typeStart, i).trim().toLowerCase();
  const params: Record<string, string> = Object.create(null);
  while (i < n) {
    i += 1; // 跳过 ';'
    skipWs();
    const nameStart = i;
    while (i < n && value[i] !== '=' && value[i] !== ';') i += 1;
    const key = value.slice(nameStart, i).trim().toLowerCase();
    if (i >= n || value[i] !== '=') {
      if (i < n && value[i] === ';') continue;
      break;
    }
    i += 1; // 跳过 '='
    skipWs();
    let val: string;
    if (i < n && value[i] === '"') {
      i += 1;
      let out = '';
      while (i < n && value[i] !== '"') {
        if (value[i] === '\\' && i + 1 < n) {
          out += value[i + 1];
          i += 2;
        } else {
          out += value[i];
          i += 1;
        }
      }
      if (i < n) i += 1; // 跳过收尾引号
      val = out;
      while (i < n && value[i] !== ';') i += 1;
    } else {
      const valStart = i;
      while (i < n && value[i] !== ';') i += 1;
      val = value.slice(valStart, i).trim();
    }
    if (key) params[key] = val;
  }
  return { type, params };
}

/** 解析头部块（含结尾 CRLFCRLF），头部名小写，支持折行续行。 */
function parseHeaderBlock(raw: Uint8Array): PartHeaders {
  const text = new TextDecoder('utf-8').decode(raw);
  const lines = text.split('\r\n');
  const headers: PartHeaders = Object.create(null);
  let last: string | null = null;
  for (const line of lines) {
    if (line === '') continue;
    if ((line[0] === ' ' || line[0] === '\t') && last !== null) {
      headers[last] += ' ' + line.trim();
      continue;
    }
    const colon = line.indexOf(':');
    if (colon <= 0) {
      throw new MultipartError('BAD_HEADERS', `malformed header line: ${line}`);
    }
    const name = line.slice(0, colon).trim().toLowerCase();
    headers[name] = line.slice(colon + 1).trim();
    last = name;
  }
  return headers;
}

function missingDelimiter(): MultipartError {
  return new MultipartError(
    'MISSING_DELIMITER',
    'byte stream ended before the closing boundary delimiter',
  );
}

type QueueItem =
  | { type: 'part'; part: Part }
  | { type: 'error'; error: unknown }
  | { type: 'done' };

interface DelimiterMark {
  /** true 表示结束分隔行（--boundary--）。 */
  final: boolean;
  /** 从 "--boundary" 起点到分隔行末尾的字节数。 */
  length: number;
}

export class MultipartParser implements AsyncIterable<Part> {
  private limits: MultipartLimits;
  private reader: ByteReader;
  private boundary: Uint8Array; // "--boundary"
  private delim: Uint8Array; // "\r\n--boundary"
  private queue: QueueItem[] = [];
  private queueWaiter: (() => void) | null = null;
  private spaceWaiter: (() => void) | null = null;
  private currentFile: FilePartStream | null = null;
  private cancelledFlag = false;
  private started = false;
  private driver: Promise<void> | null = null;

  constructor(boundary: string, source: ByteSource, limits?: Partial<MultipartLimits>) {
    if (typeof boundary !== 'string' || boundary.length === 0) {
      throw new MultipartError('BAD_BOUNDARY', 'boundary must be a non-empty string');
    }
    if (boundary.length > 200 || /[\r\n]/.test(boundary)) {
      throw new MultipartError('BAD_BOUNDARY', 'boundary is too long or contains CR/LF');
    }
    this.limits = { ...DEFAULT_LIMITS, ...(limits ?? {}) };
    this.boundary = utf8Encoder.encode(`--${boundary}`);
    this.delim = utf8Encoder.encode(`\r\n--${boundary}`);
    this.reader = new ByteReader(source, this.limits, () => this.cancelledFlag);
  }

  /** 已从源读取的总字节数（含前言、尾声与被丢弃内容）。 */
  get bytesRead(): number {
    return this.reader.totalBytes;
  }

  get cancelled(): boolean {
    return this.cancelledFlag;
  }

  [Symbol.asyncIterator](): AsyncGenerator<Part, void, void> {
    return this.parts();
  }

  /**
   * 按顺序产出 part。文件 part 必须先被完整消费或显式取消（destroy），
   * 才能请求下一个 part。中断迭代即整次取消。
   */
  async *parts(): AsyncGenerator<Part, void, void> {
    if (this.started) {
      throw new MultipartError('REUSE', 'a MultipartParser can only be consumed once');
    }
    this.started = true;
    this.driver = this.run();
    let previousFile: FilePartStream | null = null;
    try {
      for (;;) {
        if (previousFile && !previousFile.destroyed && !previousFile.readableEnded) {
          throw new MultipartError(
            'UNCONSUMED_FILE',
            'the previous file part stream must be fully consumed or cancelled ' +
              'before requesting the next part',
          );
        }
        previousFile = null;
        const item = await this.dequeue();
        if (item.type === 'error') throw item.error;
        if (item.type === 'done') return;
        if (item.part.type === 'file') {
          previousFile = item.part.stream as FilePartStream;
        }
        yield item.part;
      }
    } finally {
      // 消费者中断迭代或解析出错：整次取消，结束所有未完成的 part。
      this.cancel();
      if (this.driver) {
        try {
          await this.driver;
        } catch {
          /* 错误已通过队列交付 */
        }
      }
    }
  }

  /** 整次取消：结束当前未完成的文件 part，停止拉取源。 */
  cancel(): void {
    if (this.cancelledFlag) return;
    this.cancelledFlag = true;
    const file = this.currentFile;
    if (file) {
      file.endOfFile();
      file.wake();
    }
    this.wakeQueue();
    void this.reader.stop();
  }

  // ---- 驱动协程 ----

  private async run(): Promise<void> {
    try {
      const first = await this.scanToFirstBoundary();
      if (first !== 'final') {
        let partCount = 0;
        let final = false;
        while (!final) {
          partCount += 1;
          if (partCount > this.limits.maxParts) {
            throw new MultipartError(
              'LIMIT_PARTS',
              `part count exceeds ${this.limits.maxParts}`,
            );
          }
          const headers = await this.readHeaders();
          const disposition = parseContentDisposition(headers['content-disposition']);
          if (
            !disposition ||
            disposition.type !== 'form-data' ||
            disposition.params['name'] === undefined
          ) {
            throw new MultipartError(
              'BAD_DISPOSITION',
              'part is missing a valid Content-Disposition: form-data header with a name parameter',
            );
          }
          const name = disposition.params['name'];
          const filename = disposition.params['filename'];
          if (filename === undefined) {
            const result = await this.readFieldBody();
            final = result.final;
            await this.enqueue({
              type: 'part',
              part: { type: 'field', name, value: result.value, headers },
            });
          } else {
            const stream = new FilePartStream();
            this.currentFile = stream;
            const part: FilePart = {
              type: 'file',
              name,
              filename,
              contentType: headers['content-type'] ?? null,
              headers,
              stream,
            };
            await this.enqueue({ type: 'part', part });
            final = await this.feedFileBody(stream);
            this.currentFile = null;
          }
        }
      }
      await this.drainEpilogue();
      await this.enqueue({ type: 'done' });
    } catch (err) {
      if (this.cancelledFlag || err instanceof CancelledError) return;
      const file = this.currentFile;
      if (file) file.fail(err instanceof Error ? err : new Error(String(err)));
      await this.enqueue({ type: 'error', error: err });
    }
  }

  // ---- 队列（驱动协程 -> 消费者，容量 1，提供反压） ----

  private async enqueue(item: QueueItem): Promise<void> {
    while (!this.cancelledFlag && this.queue.length >= 1) {
      await new Promise<void>((resolve) => {
        this.spaceWaiter = resolve;
      });
    }
    if (this.cancelledFlag) return;
    this.queue.push(item);
    this.wakeQueue();
  }

  private async dequeue(): Promise<QueueItem> {
    while (this.queue.length === 0) {
      if (this.cancelledFlag) return { type: 'done' };
      await new Promise<void>((resolve) => {
        this.queueWaiter = resolve;
      });
    }
    const item = this.queue.shift() as QueueItem;
    const waiter = this.spaceWaiter;
    this.spaceWaiter = null;
    if (waiter) waiter();
    return item;
  }

  private wakeQueue(): void {
    const a = this.queueWaiter;
    this.queueWaiter = null;
    if (a) a();
    const b = this.spaceWaiter;
    this.spaceWaiter = null;
    if (b) b();
  }

  // ---- 字节级解析 ----

  private async ensure(n: number): Promise<boolean> {
    while (this.reader.buffered < n) {
      if (!(await this.reader.pump())) return false;
    }
    return true;
  }

  /**
   * 判定缓冲中 off 处的 "--boundary" 是否为真正的分隔行。
   * 返回 null 表示只是内容中类似 boundary 的前缀。
   */
  private async classifyDelimiter(off: number): Promise<DelimiterMark | null> {
    const r = this.reader;
    const bLen = this.boundary.length;
    const p = off + bLen;
    if (!(await this.ensure(p + 1))) throw missingDelimiter();
    const b = r.byteAt(p);
    if (b === DASH) {
      if (!(await this.ensure(p + 2))) throw missingDelimiter();
      if (r.byteAt(p + 1) === DASH) return { final: true, length: bLen + 2 };
      return null;
    }
    if (b === SPACE || b === TAB) {
      // RFC 2046 transport padding：分隔行末尾允许空白填充。
      let q = p;
      for (;;) {
        if (!(await this.ensure(q + 1))) throw missingDelimiter();
        const c = r.byteAt(q);
        if (c === SPACE || c === TAB) {
          q += 1;
          continue;
        }
        if (c === CR) {
          if (!(await this.ensure(q + 2))) throw missingDelimiter();
          if (r.byteAt(q + 1) === LF) return { final: false, length: q + 2 - off };
          return null;
        }
        return null;
      }
    }
    if (b === CR) {
      if (!(await this.ensure(p + 2))) throw missingDelimiter();
      if (r.byteAt(p + 1) === LF) return { final: false, length: bLen + 2 };
      return null;
    }
    return null;
  }

  /** 跳过前言，定位首个分隔行；返回 'next'（还有 part）或 'final'（零个 part）。 */
  private async scanToFirstBoundary(): Promise<'next' | 'final'> {
    const r = this.reader;
    const pat = this.boundary;
    const hold = pat.length - 1;
    for (;;) {
      let idx = r.find(pat);
      while (idx < 0) {
        const drop = r.buffered - hold;
        if (drop > 0) r.take(drop); // 前言：忽略，但字节已计入总量
        if (!(await r.pump())) {
          throw new MultipartError(
            'MISSING_DELIMITER',
            'byte stream ended before any boundary delimiter',
          );
        }
        idx = r.find(pat);
      }
      const mark = await this.classifyDelimiter(idx);
      if (mark === null) {
        r.take(idx + 2); // 前言中的假 boundary，丢弃并继续
        continue;
      }
      if (idx > 0) r.take(idx); // 丢弃前言
      r.take(mark.length);
      return mark.final ? 'final' : 'next';
    }
  }

  /**
   * 扫描 part 正文，直到完整分隔行。正文经 sink 交付；
   * 类似 boundary 的前缀原样交给 sink。返回是否为结束分隔行。
   */
  private async scanBody(sink: (chunk: Uint8Array) => void | Promise<void>): Promise<boolean> {
    const r = this.reader;
    const delim = this.delim;
    const hold = delim.length - 1;
    for (;;) {
      let idx = r.find(delim);
      while (idx < 0) {
        // 保留尾部 delim.length-1 个字节，等待可能的跨块分隔行前缀。
        const emit = r.buffered - hold;
        if (emit > 0) await sink(r.take(emit));
        if (!(await r.pump())) throw missingDelimiter();
        idx = r.find(delim);
      }
      const mark = await this.classifyDelimiter(idx + 2);
      if (mark === null) {
        // 假分隔行：\r\n 属于正文，原样保留，继续扫描。
        await sink(r.take(idx + 2));
        continue;
      }
      if (idx > 0) await sink(r.take(idx));
      r.take(mark.length + 2); // 消费 "\r\n" + 分隔行
      return mark.final;
    }
  }

  private async readHeaders(): Promise<PartHeaders> {
    const r = this.reader;
    const sep = new Uint8Array([CR, LF, CR, LF]);
    for (;;) {
      const idx = r.find(sep);
      if (idx >= 0) {
        if (idx + 4 > this.limits.maxHeaderBytes) {
          throw new MultipartError(
            'LIMIT_HEADER',
            `part headers exceed ${this.limits.maxHeaderBytes} bytes`,
          );
        }
        return parseHeaderBlock(r.take(idx + 4));
      }
      if (r.buffered >= this.limits.maxHeaderBytes) {
        throw new MultipartError(
          'LIMIT_HEADER',
          `part headers exceed ${this.limits.maxHeaderBytes} bytes`,
        );
      }
      if (!(await r.pump())) {
        throw new MultipartError('UNEXPECTED_EOF', 'byte stream ended inside part headers');
      }
    }
  }

  private async readFieldBody(): Promise<{ value: string; final: boolean }> {
    const chunks: Uint8Array[] = [];
    let size = 0;
    const final = await this.scanBody((chunk) => {
      size += chunk.length;
      if (size > this.limits.maxFieldBytes) {
        throw new MultipartError(
          'LIMIT_FIELD',
          `field value exceeds ${this.limits.maxFieldBytes} bytes`,
        );
      }
      chunks.push(chunk);
    });
    // 流式 UTF-8 解码：多字节字符可以跨任意输入块；非法序列整次失败。
    const decoder = new TextDecoder('utf-8', { fatal: true });
    let value = '';
    try {
      for (const chunk of chunks) value += decoder.decode(chunk, { stream: true });
      value += decoder.decode();
    } catch {
      throw new MultipartError('INVALID_UTF8', 'field value is not valid UTF-8');
    }
    return { value, final: final };
  }

  private async feedFileBody(stream: FilePartStream): Promise<boolean> {
    let size = 0;
    const final = await this.scanBody(async (chunk) => {
      size += chunk.length;
      if (size > this.limits.maxFileBytes) {
        throw new MultipartError(
          'LIMIT_FILE',
          `file part exceeds ${this.limits.maxFileBytes} bytes`,
        );
      }
      if (stream.cancelled || stream.ended) return; // 有界丢弃：常量内存，仅计量
      if (!stream.feed(chunk)) await stream.waitForDemand();
    });
    stream.endOfFile();
    return final;
  }

  /** 尾声：忽略内容但继续读取并计入总量，直到源结束。 */
  private async drainEpilogue(): Promise<void> {
    const r = this.reader;
    for (;;) {
      if (r.buffered > 0) r.take(r.buffered);
      if (!(await r.pump())) return;
    }
  }
}
