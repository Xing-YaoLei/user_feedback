import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import {
  MultipartParser,
  MultipartError,
  parseMultipart,
} from '../src/index.ts';
import type { Part } from '../src/index.ts';

const enc = new TextEncoder();
const dec = new TextDecoder();

function bytes(s: string): Uint8Array {
  return enc.encode(s);
}

function concat(chunks: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(chunks.reduce((a, c) => a + c.length, 0));
  let o = 0;
  for (const c of chunks) {
    out.set(c, o);
    o += c.length;
  }
  return out;
}

function chunk(data: Uint8Array, size: number): Uint8Array[] {
  const out: Uint8Array[] = [];
  for (let i = 0; i < data.length; i += size) out.push(data.slice(i, i + size));
  return out;
}

async function* toStream(chunks: Uint8Array[]): AsyncGenerator<Uint8Array> {
  for (const c of chunks) yield c;
}

async function readAll(stream: Readable): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  for await (const c of stream) chunks.push(c as Uint8Array);
  return concat(chunks);
}

interface Collected {
  type: string;
  name: string;
  value?: string;
  filename?: string;
  contentType?: string | null;
  data?: Uint8Array;
}

async function collect(parser: MultipartParser): Promise<Collected[]> {
  const out: Collected[] = [];
  for await (const part of parser) {
    if (part.type === 'file') {
      const data = await readAll(part.stream);
      out.push({
        type: 'file',
        name: part.name,
        filename: part.filename,
        contentType: part.contentType,
        data,
      });
    } else {
      out.push({ type: 'field', name: part.name, value: part.value });
    }
  }
  return out;
}

function tick(ms = 20): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function expectCode(code: string) {
  return (err: unknown) => {
    assert.ok(err instanceof MultipartError, `expected MultipartError, got ${err}`);
    assert.equal(err.code, code);
    return true;
  };
}

// ---------- 基本解析与顺序 ----------

test('按顺序解析字段与文件，同名字段/同名文件保留原顺序', async () => {
  const B = 'test-boundary-1';
  const raw =
    `--${B}\r\n` +
    'Content-Disposition: form-data; name="title"\r\n\r\n' +
    'hello world\r\n' +
    `--${B}\r\n` +
    'Content-Disposition: form-data; name="tag"\r\n\r\n' +
    'one\r\n' +
    `--${B}\r\n` +
    'Content-Disposition: form-data; name="tag"\r\n\r\n' +
    'two\r\n' +
    `--${B}\r\n` +
    'Content-Disposition: form-data; name="file"; filename="1.txt"\r\n' +
    'Content-Type: text/plain\r\n\r\n' +
    'first-file\r\n' +
    `--${B}\r\n` +
    'Content-Disposition: form-data; name="file"; filename="2.txt"\r\n\r\n' +
    'second-file\r\n' +
    `--${B}--\r\n`;
  const parts = await collect(new MultipartParser(B, toStream(chunk(bytes(raw), 7))));
  assert.deepEqual(
    parts.map((p) => p.name),
    ['title', 'tag', 'tag', 'file', 'file'],
  );
  assert.equal(parts[0].value, 'hello world');
  assert.equal(parts[1].value, 'one');
  assert.equal(parts[2].value, 'two');
  assert.equal(parts[3].filename, '1.txt');
  assert.equal(parts[3].contentType, 'text/plain');
  assert.equal(dec.decode(parts[3].data), 'first-file');
  assert.equal(parts[4].filename, '2.txt');
  assert.equal(dec.decode(parts[4].data), 'second-file');
});

test('带引号与转义的 name/filename 参数，以及不带引号的 name', async () => {
  const B = 'quoted-boundary';
  const raw =
    `--${B}\r\n` +
    'Content-Disposition: form-data; name="we\\"ird"\r\n\r\n' +
    'v1\r\n' +
    `--${B}\r\n` +
    'Content-Disposition: form-data; name=plain\r\n\r\n' +
    'v2\r\n' +
    `--${B}\r\n` +
    'Content-Disposition: form-data; name="doc"; filename="quo\\"te\\\\d.txt"\r\n\r\n' +
    'X\r\n' +
    `--${B}--\r\n`;
  const parts = await collect(new MultipartParser(B, toStream(chunk(bytes(raw), 3))));
  assert.equal(parts[0].name, 'we"ird');
  assert.equal(parts[0].value, 'v1');
  assert.equal(parts[1].name, 'plain');
  assert.equal(parts[2].filename, 'quo"te\\d.txt');
  assert.equal(dec.decode(parts[2].data), 'X');
});

test('分隔行、头部、多字节字符跨任意输入块（含逐字节块）', async () => {
  const B = 'chunky-boundary';
  const value = '你好，世界 🌍 — multipart 解析';
  const fileContent = `文件内容 ${'x'.repeat(300)} 🌍`;
  const raw =
    `--${B}\r\n` +
    'Content-Disposition: form-data; name="文本"\r\n\r\n' +
    `${value}\r\n` +
    `--${B}\r\n` +
    'Content-Disposition: form-data; name="f"; filename="报表 🌍.txt"\r\n\r\n' +
    `${fileContent}\r\n` +
    `--${B}--\r\n`;
  const data = bytes(raw);
  for (const size of [1, 2, 3, 5, 7, 13, 64, 4096]) {
    const parts = await collect(new MultipartParser(B, toStream(chunk(data, size))));
    assert.equal(parts.length, 2, `chunk size ${size}`);
    assert.equal(parts[0].name, '文本');
    assert.equal(parts[0].value, value);
    assert.equal(parts[1].filename, '报表 🌍.txt');
    assert.equal(dec.decode(parts[1].data), fileContent);
  }
  // 确定性伪随机块大小
  let seed = 42;
  const rand = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff);
  const chunks: Uint8Array[] = [];
  for (let i = 0; i < data.length; ) {
    const n = 1 + (rand() % 17);
    chunks.push(data.slice(i, i + n));
    i += n;
  }
  const parts = await collect(new MultipartParser(B, toStream(chunks)));
  assert.equal(parts[0].value, value);
  assert.equal(dec.decode(parts[1].data), fileContent);
});

test('文件内容中只有完整分隔行才结束 part，类似 boundary 的前缀原样保留', async () => {
  const B = 'prefix-boundary';
  const tricky =
    `--${B}suffix\r\n` + // 内容开头即 boundary 样字节（前面无 CRLF）
    `line\r\n--${B}suffix\r\n` + // CRLF 后 boundary 样前缀 + 垃圾后缀
    `pre\r\n--${B}-x\r\n` + // 单个连字符，不是结束标记
    `partial\r\n--${B.slice(0, B.length - 2)}\r\n` + // 不完整前缀
    `pad\r\n--${B} \tz\r\n` + // 填充后不是 CRLF
    'end';
  const raw =
    `--${B}\r\n` +
    'Content-Disposition: form-data; name="f"; filename="t.bin"\r\n\r\n' +
    tricky +
    `\r\n--${B}--\r\n`;
  const parts = await collect(new MultipartParser(B, toStream(chunk(bytes(raw), 3))));
  assert.equal(parts.length, 1);
  assert.equal(dec.decode(parts[0].data), tricky);
});

test('前言与尾声被忽略但仍计入总字节量；支持传输填充', async () => {
  const B = 'preamble-boundary';
  const preamble = 'this is preamble junk\r\n--not-a-boundary\r\nmore junk\r\n';
  const epilogue = 'trailing epilogue junk\r\nthat must be counted\r\n';
  const raw =
    preamble +
    `--${B} \t\r\n` + // 首个分隔行带传输填充
    'Content-Disposition: form-data; name="a"\r\n\r\n' +
    'v\r\n' +
    `--${B}--  \r\n` + // 结束分隔行带填充
    epilogue;
  const parser = new MultipartParser(B, toStream(chunk(bytes(raw), 4)));
  const parts = await collect(parser);
  assert.equal(parts.length, 1);
  assert.equal(parts[0].value, 'v');
  assert.equal(parser.bytesRead, bytes(raw).length);
});

test('空字段、空文件与零个 part', async () => {
  const B = 'empty-boundary';
  const raw =
    `--${B}\r\n` +
    'Content-Disposition: form-data; name="e"\r\n\r\n' +
    '\r\n' +
    `--${B}\r\n` +
    'Content-Disposition: form-data; name="f"; filename="empty.txt"\r\n\r\n' +
    `\r\n--${B}--\r\n`;
  const parts = await collect(new MultipartParser(B, toStream(chunk(bytes(raw), 5))));
  assert.equal(parts[0].value, '');
  assert.equal(parts[1].type, 'file');
  assert.equal(parts[1].data?.length, 0);

  const none = await collect(
    new MultipartParser(B, toStream(chunk(bytes(`--${B}--\r\n`), 2))),
  );
  assert.equal(none.length, 0);
});

test('源可以是 Node Readable', async () => {
  const B = 'readable-boundary';
  const raw = `--${B}\r\nContent-Disposition: form-data; name="a"\r\n\r\nv\r\n--${B}--\r\n`;
  const parts = await collect(parseMultipart(B, Readable.from(chunk(bytes(raw), 4))));
  assert.equal(parts[0].value, 'v');
});

// ---------- 背压 ----------

test('文件流提供背压：消费者不读时解析器不会无界拉取上游', async () => {
  const B = 'backpressure-boundary';
  const fileContent = 'A'.repeat(64 * 1024);
  const raw =
    `--${B}\r\n` +
    'Content-Disposition: form-data; name="f"; filename="big.bin"\r\n\r\n' +
    `${fileContent}\r\n` +
    `--${B}\r\n` +
    'Content-Disposition: form-data; name="after"\r\n\r\n' +
    'done\r\n' +
    `--${B}--\r\n`;
  const chunks = chunk(bytes(raw), 1024);
  let pulled = 0;
  async function* counted(): AsyncGenerator<Uint8Array> {
    for (const c of chunks) {
      pulled += c.length;
      yield c;
    }
  }
  const parser = new MultipartParser(B, counted());
  const gen = parser[Symbol.asyncIterator]();
  const p1 = (await gen.next()).value as Extract<Part, { type: 'file' }>;
  assert.equal(p1.type, 'file');
  await tick();
  assert.ok(
    pulled < 40 * 1024,
    `consumer 未读取时不应拉取整个文件（已拉取 ${pulled} 字节）`,
  );
  const data = await readAll(p1.stream);
  assert.equal(dec.decode(data), fileContent);
  const p2 = (await gen.next()).value as Extract<Part, { type: 'field' }>;
  assert.equal(p2.value, 'done');
  assert.ok((await gen.next()).done);
  assert.equal(pulled, bytes(raw).length);
});

// ---------- 取消当前文件（交错场景） ----------

test('交错场景：取消当前文件后有界丢弃并定位后续 part，顺序保持', async () => {
  const B = 'cancel-boundary';
  const file1 = 'A'.repeat(100 * 1024);
  const file2 = 'second-file-content';
  const raw =
    `--${B}\r\n` +
    'Content-Disposition: form-data; name="file"; filename="f1.bin"\r\n\r\n' +
    `${file1}\r\n` +
    `--${B}\r\n` +
    'Content-Disposition: form-data; name="note"\r\n\r\n' +
    'after\r\n' +
    `--${B}\r\n` +
    'Content-Disposition: form-data; name="file"; filename="f2.bin"\r\n\r\n' +
    `${file2}\r\n` +
    `--${B}--\r\n`;
  const parser = new MultipartParser(B, toStream(chunk(bytes(raw), 4096)));
  const gen = parser[Symbol.asyncIterator]();

  const p1 = (await gen.next()).value as Extract<Part, { type: 'file' }>;
  assert.equal(p1.type, 'file');
  assert.equal(p1.filename, 'f1.bin');
  const it1 = p1.stream[Symbol.asyncIterator]();
  const first = await it1.next();
  assert.ok(!first.done);
  p1.stream.destroy(); // 后端取消当前文件的消费

  const p2 = (await gen.next()).value as Extract<Part, { type: 'field' }>;
  assert.equal(p2.type, 'field');
  assert.equal(p2.name, 'note');
  assert.equal(p2.value, 'after');

  const p3 = (await gen.next()).value as Extract<Part, { type: 'file' }>;
  assert.equal(p3.filename, 'f2.bin');
  assert.equal(dec.decode(await readAll(p3.stream)), file2);
  assert.ok((await gen.next()).done);
  // 被丢弃的字节仍计入总读取量
  assert.equal(parser.bytesRead, bytes(raw).length);
});

test('取消文件后丢弃的字节仍计入单文件限额', async () => {
  const B = 'discard-file-limit';
  const file1 = 'A'.repeat(200 * 1024);
  const raw =
    `--${B}\r\n` +
    'Content-Disposition: form-data; name="f"; filename="big.bin"\r\n\r\n' +
    `${file1}\r\n` +
    `--${B}\r\n` +
    'Content-Disposition: form-data; name="a"\r\n\r\n' +
    'v\r\n' +
    `--${B}--\r\n`;
  const parser = new MultipartParser(B, toStream(chunk(bytes(raw), 4096)), {
    maxFileBytes: 100 * 1024,
  });
  const gen = parser[Symbol.asyncIterator]();
  const p1 = (await gen.next()).value as Extract<Part, { type: 'file' }>;
  const it1 = p1.stream[Symbol.asyncIterator]();
  await it1.next(); // 读一点
  p1.stream.destroy(); // 取消消费，余下内容被丢弃但仍计量
  await assert.rejects(gen.next(), expectCode('LIMIT_FILE'));
});

test('取消文件后丢弃的字节仍计入总正文限额', async () => {
  const B = 'discard-total-limit';
  const file1 = 'A'.repeat(200 * 1024);
  const raw =
    `--${B}\r\n` +
    'Content-Disposition: form-data; name="f"; filename="big.bin"\r\n\r\n' +
    `${file1}\r\n` +
    `--${B}--\r\n`;
  const total = bytes(raw).length;
  const parser = new MultipartParser(B, toStream(chunk(bytes(raw), 4096)), {
    maxTotalBytes: 100 * 1024,
  });
  const gen = parser[Symbol.asyncIterator]();
  const p1 = (await gen.next()).value as Extract<Part, { type: 'file' }>;
  const it1 = p1.stream[Symbol.asyncIterator]();
  await it1.next();
  p1.stream.destroy();
  await assert.rejects(gen.next(), expectCode('LIMIT_TOTAL'));
  assert.ok(total > 100 * 1024);
});

// ---------- 整次请求取消 ----------

test('整次请求取消：结束所有未完成的 part 并停止拉取源', async () => {
  const B = 'abort-boundary';
  const file1 = 'A'.repeat(100 * 1024);
  const raw =
    `--${B}\r\n` +
    'Content-Disposition: form-data; name="f"; filename="big.bin"\r\n\r\n' +
    `${file1}\r\n` +
    `--${B}\r\n` +
    'Content-Disposition: form-data; name="a"\r\n\r\n' +
    'v\r\n' +
    `--${B}--\r\n`;
  let sourceReturned = false;
  const chunks = chunk(bytes(raw), 4096);
  async function* src(): AsyncGenerator<Uint8Array> {
    try {
      for (const c of chunks) yield c;
    } finally {
      sourceReturned = true;
    }
  }
  const parser = new MultipartParser(B, src());
  const gen = parser[Symbol.asyncIterator]();
  const p1 = (await gen.next()).value as Extract<Part, { type: 'file' }>;
  const it1 = p1.stream[Symbol.asyncIterator]();
  const first = await it1.next();
  assert.ok(!first.done);
  await gen.return(undefined); // 整次取消
  // 未完成的文件 part 被结束：已缓冲数据交付完后收到 EOF
  let ended = false;
  for (let i = 0; i < 1000; i++) {
    if ((await it1.next()).done) {
      ended = true;
      break;
    }
  }
  assert.ok(ended, '取消后未完成的文件 part 应被结束');
  await tick();
  assert.ok(sourceReturned, '取消后应停止拉取源');
  assert.ok(parser.cancelled);
});

// ---------- 失败场景 ----------

test('缺少结束分隔符导致整次失败，已返回的 part 不代表成功', async () => {
  const B = 'truncated-boundary';
  const raw =
    `--${B}\r\n` +
    'Content-Disposition: form-data; name="a"\r\n\r\n' +
    'ok\r\n' +
    `--${B}\r\n` +
    'Content-Disposition: form-data; name="b"\r\n\r\n' +
    'partial-value-without-closing-delimiter';
  const parser = new MultipartParser(B, toStream(chunk(bytes(raw), 8)));
  const gen = parser[Symbol.asyncIterator]();
  const first = await gen.next();
  assert.equal((first.value as Extract<Part, { type: 'field' }>).value, 'ok');
  await assert.rejects(gen.next(), expectCode('MISSING_DELIMITER'));
});

test('流在 boundary 之后立刻结束也视为缺少结束分隔符', async () => {
  const B = 'eof-after-boundary';
  const raw =
    `--${B}\r\n` +
    'Content-Disposition: form-data; name="a"\r\n\r\n' +
    'v\r\n' +
    `--${B}`; // 没有 "--" 或 CRLF 就 EOF
  const parser = new MultipartParser(B, toStream(chunk(bytes(raw), 4)));
  await assert.rejects(collect(parser), expectCode('MISSING_DELIMITER'));
});

test('非法 UTF-8 字段导致整次解析失败', async () => {
  const B = 'utf8-boundary';
  const raw = concat([
    bytes(`--${B}\r\nContent-Disposition: form-data; name="a"\r\n\r\n`),
    new Uint8Array([0x61, 0xff, 0xfe, 0x62]),
    bytes(`\r\n--${B}--\r\n`),
  ]);
  await assert.rejects(
    collect(new MultipartParser(B, toStream(chunk(raw, 3)))),
    expectCode('INVALID_UTF8'),
  );
});

test('崩溃场景：源中途抛错，当前文件流与整体解析都失败', async () => {
  const B = 'crash-boundary';
  const raw =
    `--${B}\r\n` +
    'Content-Disposition: form-data; name="f"; filename="big.bin"\r\n\r\n' +
    `${'A'.repeat(64 * 1024)}\r\n` +
    `--${B}--\r\n`;
  const chunks = chunk(bytes(raw), 4096);
  async function* crashing(): AsyncGenerator<Uint8Array> {
    yield chunks[0];
    yield chunks[1];
    throw new Error('boom');
  }
  const parser = new MultipartParser(B, crashing());
  const gen = parser[Symbol.asyncIterator]();
  const p1 = (await gen.next()).value as Extract<Part, { type: 'file' }>;
  assert.equal(p1.type, 'file');
  await assert.rejects(readAll(p1.stream), /boom/);
  await assert.rejects(gen.next(), /boom/);
});

// ---------- 限额 ----------

test('头部长度限额', async () => {
  const B = 'header-limit';
  const raw =
    `--${B}\r\n` +
    `Content-Disposition: form-data; name="a"\r\n` +
    `X-Long: ${'h'.repeat(100)}\r\n\r\n` +
    `v\r\n--${B}--\r\n`;
  await assert.rejects(
    collect(
      new MultipartParser(B, toStream(chunk(bytes(raw), 8)), { maxHeaderBytes: 64 }),
    ),
    expectCode('LIMIT_HEADER'),
  );
});

test('字段长度限额', async () => {
  const B = 'field-limit';
  const raw =
    `--${B}\r\n` +
    'Content-Disposition: form-data; name="a"\r\n\r\n' +
    'this-value-is-too-long\r\n' +
    `--${B}--\r\n`;
  await assert.rejects(
    collect(
      new MultipartParser(B, toStream(chunk(bytes(raw), 4)), { maxFieldBytes: 8 }),
    ),
    expectCode('LIMIT_FIELD'),
  );
});

test('文件长度限额（消费过程中触发）', async () => {
  const B = 'file-limit';
  const raw =
    `--${B}\r\n` +
    'Content-Disposition: form-data; name="f"; filename="x.bin"\r\n\r\n' +
    '0123456789abcdef\r\n' +
    `--${B}--\r\n`;
  await assert.rejects(
    collect(
      new MultipartParser(B, toStream(chunk(bytes(raw), 2)), { maxFileBytes: 8 }),
    ),
    expectCode('LIMIT_FILE'),
  );
});

test('part 数量限额：超限时已交付的 part 不代表成功', async () => {
  const B = 'parts-limit';
  const raw =
    `--${B}\r\nContent-Disposition: form-data; name="a"\r\n\r\n1\r\n` +
    `--${B}\r\nContent-Disposition: form-data; name="b"\r\n\r\n2\r\n` +
    `--${B}--\r\n`;
  const parser = new MultipartParser(B, toStream(chunk(bytes(raw), 4)), {
    maxParts: 1,
  });
  const gen = parser[Symbol.asyncIterator]();
  const first = await gen.next();
  assert.equal((first.value as Extract<Part, { type: 'field' }>).name, 'a');
  await assert.rejects(gen.next(), expectCode('LIMIT_PARTS'));
});

test('内部缓冲限额', async () => {
  const B = 'buffer-limit-boundary';
  const raw =
    `--${B}\r\nContent-Disposition: form-data; name="a"\r\n\r\nv\r\n--${B}--\r\n`;
  await assert.rejects(
    collect(
      new MultipartParser(B, toStream([bytes(raw)]) /* 单个大块 */, {
        maxBufferBytes: 32,
      }),
    ),
    expectCode('LIMIT_BUFFER'),
  );
});

test('总正文限额：前言与尾声也计入', async () => {
  const B = 'total-limit';
  const raw =
    'preamble-'.repeat(20) +
    `\r\n--${B}\r\nContent-Disposition: form-data; name="a"\r\n\r\nv\r\n--${B}--\r\n` +
    'epilogue-'.repeat(20);
  await assert.rejects(
    collect(
      new MultipartParser(B, toStream(chunk(bytes(raw), 16)), { maxTotalBytes: 100 }),
    ),
    expectCode('LIMIT_TOTAL'),
  );
});

// ---------- 用法约束 ----------

test('文件 part 未消费也未取消就请求下一个 part 会报错', async () => {
  const B = 'unconsumed-boundary';
  const raw =
    `--${B}\r\n` +
    'Content-Disposition: form-data; name="f"; filename="x.bin"\r\n\r\n' +
    `${'A'.repeat(32 * 1024)}\r\n` +
    `--${B}\r\n` +
    'Content-Disposition: form-data; name="a"\r\n\r\n' +
    'v\r\n' +
    `--${B}--\r\n`;
  const parser = new MultipartParser(B, toStream(chunk(bytes(raw), 1024)));
  const gen = parser[Symbol.asyncIterator]();
  const p1 = (await gen.next()).value as Extract<Part, { type: 'file' }>;
  assert.equal(p1.type, 'file');
  await assert.rejects(gen.next(), expectCode('UNCONSUMED_FILE'));
});
