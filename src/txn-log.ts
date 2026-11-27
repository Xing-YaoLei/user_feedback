import {
  type AbortMarker,
  type CommitMarker,
  type DataRecord,
  type FenceRecord,
  type LogRecord,
  type ReadOptions,
  type ReadResult,
  type TxnId,
  type TxnState,
  type TxnStatus,
} from './types.ts';
import {
  ConflictTerminalError,
  InvalidArgumentError,
  InvalidOffsetError,
  StaleEpochError,
  TransactionAlreadyFinalizedError,
  TransactionNotFoundError,
  TxnLogError,
} from './errors.ts';

/** 事务身份 -> 内部状态的键。 */
export function txnKey(txnId: TxnId): string {
  return `${txnId.producer}#${txnId.epoch}#${txnId.txnId}`;
}

function cloneRecord<T>(record: LogRecord<T>): LogRecord<T> {
  switch (record.kind) {
    case 'data':
      return { kind: 'data', offset: record.offset, payload: structuredClone(record.payload) };
    case 'txnData':
      return {
        kind: 'txnData',
        offset: record.offset,
        payload: structuredClone(record.payload),
        txnId: { ...record.txnId },
      };
    case 'commit':
    case 'abort':
      return { kind: record.kind, offset: record.offset, txnId: { ...record.txnId } };
    case 'fence':
      return { kind: 'fence', offset: record.offset, producer: record.producer, epoch: record.epoch };
  }
}

interface TxnStateInternal {
  txnId: TxnId;
  state: TxnState;
  firstOffset: number;
  terminalOffset?: number;
}

export interface MarkerAppendResult {
  /** 新写入标记的 offset；幂等重放相同终态时返回既有标记的 offset。 */
  offset: number;
  /** true 表示该终态此前已经应用过，本次没有新写入任何记录。 */
  idempotent: boolean;
}

export interface FenceAppendResult {
  /** 栅栏记录 offset。 */
  offset: number;
  /** 本次栅栏明确中止的旧代次未决事务。 */
  abortedTxns: TxnId[];
}

/**
 * 单分区事务日志视图。
 *
 * 所有记录（普通数据、事务数据、commit/abort/fence 控制记录）顺序追加并占有递增 offset。
 * 读取提供两种方式：
 *  - read_uncommitted：返回所有数据记录（含未提交、已中止），控制记录跳过。
 *  - read_committed：只返回普通数据与已提交事务数据；以最早未决事务首条数据位置
 *    （LSO, last stable offset 之前）为可读边界，请求越过边界时原地等待。
 */
export class TransactionalLog<T = unknown> {
  private readonly records: LogRecord<T>[] = [];
  private readonly txns = new Map<string, TxnStateInternal>();
  /** producer -> 当前（最高）代次。 */
  private readonly producerEpoch = new Map<string, number>();

  // ---------------------------------------------------------------------------
  // 追加写入
  // ---------------------------------------------------------------------------

  /**
   * 追加一条数据记录。
   * - txnId 缺省：普通数据，立即可读，不参与事务。
   * - txnId 存在：事务数据。代次高于该生产者当前代次时会先隐式写入栅栏并中止旧代次
   *   未决事务；代次陈旧或事务已终结则拒绝。
   */
  appendData(payload: T, txnId?: TxnId): number {
    if (txnId === undefined) {
      const record: LogRecord<T> = { kind: 'data', offset: -1, payload };
      return this.appendRecord(record);
    }

    this.checkEpoch(txnId);
    const state = this.txns.get(txnKey(txnId));
    if (state !== undefined && state.state !== 'pending') {
      throw new TransactionAlreadyFinalizedError(
        `transaction ${txnKey(txnId)} is already ${state.state}; cannot append more data`,
      );
    }

    const record: LogRecord<T> = { kind: 'txnData', offset: -1, payload, txnId: { ...txnId } };
    const offset = this.appendRecord(record);

    if (state === undefined) {
      this.txns.set(txnKey(txnId), {
        txnId: { ...txnId },
        state: 'pending',
        firstOffset: offset,
      });
    }
    return offset;
  }

  /**
   * 显式写入代次栅栏：生产者切换到更高 epoch。
   * 同代次重放是幂等空操作；回退到更低代次直接拒绝。
   * 写入后该生产者所有旧 epoch 的未决事务被明确中止。
   */
  appendFence(producer: string, epoch: number): FenceAppendResult {
    const current = this.producerEpoch.get(producer);
    if (current !== undefined && epoch < current) {
      throw new StaleEpochError(
        `producer ${producer} fenced at epoch ${current}; cannot fence back to epoch ${epoch}`,
      );
    }
    if (current === epoch) {
      return { offset: -1, abortedTxns: [] };
    }
    const { fenceOffset, abortedTxns } = this.applyFence(producer, epoch);
    return { offset: fenceOffset, abortedTxns: abortedTxns.map((id) => ({ ...id })) };
  }

  /** 追加提交标记。相同终态可重复应用（幂等）；冲突终态拒绝。 */
  appendCommit(txnId: TxnId): MarkerAppendResult {
    return this.appendTerminal(txnId, 'commit');
  }

  /** 追加中止标记。相同终态可重复应用（幂等）；冲突终态拒绝。 */
  appendAbort(txnId: TxnId): MarkerAppendResult {
    return this.appendTerminal(txnId, 'abort');
  }

  // ---------------------------------------------------------------------------
  // 读取
  // ---------------------------------------------------------------------------

  /**
   * read_uncommitted：返回扫描到的所有数据记录（含未提交、已中止事务的数据）。
   * 控制记录不返回但推进扫描位置。读到日志末尾时 wait=true。
   */
  readUncommitted(offset: number, options: ReadOptions = {}): ReadResult<T> {
    this.assertOffset(offset);
    const maxRecords = this.normalizeMaxRecords(options.maxRecords);

    const records: DataRecord<T>[] = [];
    let cursor = offset;

    while (cursor < this.records.length) {
      if (maxRecords !== undefined && records.length >= maxRecords) break;
      const record = this.records[cursor];
      if (record.kind === 'data' || record.kind === 'txnData') {
        records.push(this.toDataRecord(record));
      }
      // 控制记录不返回，但仍计入扫描位置：无论什么类型游标都 +1。
      cursor += 1;
    }

    return {
      records,
      nextOffset: cursor,
      wait: cursor >= this.records.length,
    };
  }

  /**
   * read_committed：只返回普通数据与已提交事务的数据。
   * 可读边界 = 最早未决事务首条数据的位置；没有未决事务时边界即日志末尾。
   * - 已中止事务数据与控制记录：跳过不返回，但推进扫描位置（允许空数据但推进）。
   * - 请求位置 >= 边界：保持原位置，wait=true，绝不替调用方越过未决事务障碍。
   */
  readCommitted(offset: number, options: ReadOptions = {}): ReadResult<T> {
    this.assertOffset(offset);
    const maxRecords = this.normalizeMaxRecords(options.maxRecords);

    const highWatermark = this.committedHighWatermark();
    if (offset >= highWatermark) {
      // 越过/抵达当前可读边界：不能推进，调用方等待。
      return { records: [], nextOffset: offset, wait: true };
    }

    const records: DataRecord<T>[] = [];
    let cursor = offset;

    while (cursor < highWatermark) {
      if (maxRecords !== undefined && records.length >= maxRecords) break;
      const record = this.records[cursor];

      if (record.kind === 'data') {
        records.push(this.toDataRecord(record));
      } else if (record.kind === 'txnData') {
        const state = this.txns.get(txnKey(record.txnId));
        // 边界保证此前的事务均已终结；aborted 的跳过，committed 的返回。
        if (state?.state === 'committed') {
          records.push(this.toDataRecord(record));
        }
      }
      // 控制记录与已中止数据：不返回但推进扫描位置。
      cursor += 1;
    }

    return {
      records,
      nextOffset: cursor,
      wait: cursor >= highWatermark,
    };
  }

  /**
   * 当前 read_committed 可读边界（LSO）。
   * 所有未决事务首条数据 offset 的最小值；无未决事务时等于日志末尾 offset。
   */
  committedHighWatermark(): number {
    let watermark = this.records.length;
    for (const state of this.txns.values()) {
      if (state.state === 'pending' && state.firstOffset < watermark) {
        watermark = state.firstOffset;
      }
    }
    return watermark;
  }

  // ---------------------------------------------------------------------------
  // 状态查询与重放
  // ---------------------------------------------------------------------------

  /** 日志末尾 offset（下一条将写入的位置）。 */
  get logEndOffset(): number {
    return this.records.length;
  }

  getTxnStatus(txnId: TxnId): TxnStatus | undefined {
    const state = this.txns.get(txnKey(txnId));
    if (state === undefined) return undefined;
    return {
      txnId: { ...state.txnId },
      state: state.state,
      firstOffset: state.firstOffset,
      terminalOffset: state.terminalOffset,
    };
  }

  /** 按 offset 顺序返回全部记录的深拷贝（含控制记录），用于持久化/审计/重放。 */
  snapshot(): LogRecord<T>[] {
    return this.records.map((record) => cloneRecord(record));
  }

  /**
   * 从一组按 offset 排序的记录重放出一个等价日志。
   * offset 必须从 0 开始且连续，否则抛出 InvalidOffsetError。
   */
  static replay<T>(records: LogRecord<T>[]): TransactionalLog<T> {
    const log = new TransactionalLog<T>();
    records.forEach((record, index) => {
      if (record.offset !== index) {
        throw new InvalidOffsetError(
          `non-contiguous offset at index ${index}: expected ${index}, got ${record.offset}`,
        );
      }
      log.applyReplayedRecord(cloneRecord(record));
    });
    return log;
  }

  // ---------------------------------------------------------------------------
  // 内部实现
  // ---------------------------------------------------------------------------

  private appendRecord(record: LogRecord<T>): number {
    record.offset = this.records.length;
    this.records.push(record);
    return record.offset;
  }

  /** 代次守卫：旧代次消息拒绝；更高代次先隐式栅栏并中止旧代次未决事务。 */
  private checkEpoch(txnId: TxnId): void {
    const current = this.producerEpoch.get(txnId.producer);
    if (current !== undefined && txnId.epoch < current) {
      throw new StaleEpochError(
        `producer ${txnId.producer} is at epoch ${current}; rejecting epoch ${txnId.epoch} message for txn ${txnId.txnId}`,
      );
    }
    if (current === undefined || txnId.epoch > current) {
      this.applyFence(txnId.producer, txnId.epoch);
    }
  }

  /**
   * 写入栅栏并把该生产者所有更低 epoch 的未决事务转为 aborted。
   * 调用方保证 epoch 严格大于当前代次。
   */
  private applyFence(producer: string, epoch: number): { fenceOffset: number; abortedTxns: TxnId[] } {
    const fence: FenceRecord = { kind: 'fence', offset: -1, producer, epoch };
    const fenceOffset = this.appendRecord(fence);
    this.producerEpoch.set(producer, epoch);

    const abortedTxns: TxnId[] = [];
    for (const state of this.txns.values()) {
      if (
        state.txnId.producer === producer &&
        state.txnId.epoch < epoch &&
        state.state === 'pending'
      ) {
        state.state = 'aborted';
        state.terminalOffset = fenceOffset;
        abortedTxns.push({ ...state.txnId });
      }
    }
    return { fenceOffset, abortedTxns };
  }

  private appendTerminal(txnId: TxnId, kind: 'commit' | 'abort'): MarkerAppendResult {
    this.checkEpoch(txnId);

    const state = this.txns.get(txnKey(txnId));
    if (state === undefined) {
      throw new TransactionNotFoundError(
        `cannot ${kind} unknown transaction ${txnKey(txnId)}; it never wrote data`,
      );
    }
    if (state.state !== 'pending') {
      const resolved: TxnState = kind === 'commit' ? 'committed' : 'aborted';
      if (state.state === resolved) {
        // 相同终态可重复应用：幂等，不重复写记录。
        return { offset: state.terminalOffset ?? -1, idempotent: true };
      }
      throw new ConflictTerminalError(
        `transaction ${txnKey(txnId)} is already ${state.state}; cannot apply ${kind}`,
      );
    }

    const marker: CommitMarker | AbortMarker = {
      kind,
      offset: -1,
      txnId: { ...txnId },
    };
    const offset = this.appendRecord(marker);
    state.state = kind === 'commit' ? 'committed' : 'aborted';
    state.terminalOffset = offset;
    return { offset, idempotent: false };
  }

  private applyReplayedRecord(record: LogRecord<T>): void {
    switch (record.kind) {
      case 'data':
        // 重放走与在线追加相同的 offset 分配路径（appendRecord 会覆盖为当前末尾）。
        this.appendRecord(record);
        return;
      case 'txnData': {
        const existing = this.txns.get(txnKey(record.txnId));
        if (existing !== undefined && existing.state !== 'pending') {
          throw new TransactionAlreadyFinalizedError(
            `replay: transaction ${txnKey(record.txnId)} already ${existing.state}`,
          );
        }
        this.checkEpoch(record.txnId);
        const offset = this.appendRecord(record);
        if (existing === undefined) {
          this.txns.set(txnKey(record.txnId), {
            txnId: { ...record.txnId },
            state: 'pending',
            firstOffset: offset,
          });
        }
        return;
      }
      case 'fence': {
        const result = this.appendFence(record.producer, record.epoch);
        if (result.offset !== record.offset) {
          throw new TxnLogError(
            `replay: fence offset mismatch (expected ${record.offset}, got ${result.offset})`,
          );
        }
        return;
      }
      case 'commit':
      case 'abort': {
        const result = this.appendTerminal(record.txnId, record.kind);
        if (result.offset !== record.offset) {
          throw new TxnLogError(
            `replay: ${record.kind} offset mismatch (expected ${record.offset}, got ${result.offset})`,
          );
        }
        return;
      }
    }
  }

  private toDataRecord(record: LogRecord<T>): DataRecord<T> {
    if (record.kind === 'data') {
      return { offset: record.offset, payload: structuredClone(record.payload) };
    }
    if (record.kind === 'txnData') {
      return { offset: record.offset, payload: structuredClone(record.payload), txnId: { ...record.txnId } };
    }
    throw new TxnLogError(`record at offset ${record.offset} is a control record, not data`);
  }

  private assertOffset(offset: number): void {
    if (typeof offset !== 'number' || !Number.isInteger(offset) || offset < 0) {
      throw new InvalidOffsetError(`offset must be a non-negative integer, got ${String(offset)}`);
    }
  }

  private normalizeMaxRecords(maxRecords?: number): number | undefined {
    if (maxRecords === undefined) return undefined;
    if (typeof maxRecords !== 'number' || !Number.isInteger(maxRecords) || maxRecords <= 0) {
      throw new InvalidArgumentError(`maxRecords must be a positive integer, got ${String(maxRecords)}`);
    }
    return maxRecords;
  }
}
