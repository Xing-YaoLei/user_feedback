/**
 * 事务身份：生产者 + 生产者代次 + 事务 ID。
 * 同名事务在不同 epoch 下是互相独立的两个事务，
 * 旧代次的消息（数据/提交/中止）不能作用于新代次的同名事务。
 */
export interface TxnId {
  producer: string;
  epoch: number;
  txnId: string;
}

/** 消费者可见的数据记录。控制记录（commit/abort/fence）永远不会出现在读取结果里。 */
export interface DataRecord<T = unknown> {
  offset: number;
  payload: T;
  /** 缺省表示普通（非事务）数据。 */
  txnId?: TxnId;
}

export interface ReadOptions {
  /** 单次最多返回多少条数据记录；缺省表示读到当前可读边界为止。 */
  maxRecords?: number;
}

export interface ReadResult<T = unknown> {
  /** 本次返回的数据记录（可能为空）。 */
  records: DataRecord<T>[];
  /** 下一次扫描应使用的位置；控制记录与已中止数据虽不返回，仍会推进该位置。 */
  nextOffset: number;
  /**
   * true 表示请求位置已越过当前可读边界（或日志末尾），
   * 日志保持原位置不动，调用方需要等待新数据，不能由日志替它跳过障碍。
   */
  wait: boolean;
}

export type TxnState = 'pending' | 'committed' | 'aborted';

export interface TxnStatus {
  txnId: TxnId;
  state: TxnState;
  /** 该事务首条数据记录的 offset，read_committed 的可读边界取所有未决事务首条位置的最小值。 */
  firstOffset: number;
  /** 终结记录（commit/abort）或代次栅栏的 offset；未决事务为 undefined。 */
  terminalOffset?: number;
}

// ---- 日志内部记录：所有记录（含控制记录）都占有递增 offset ----

export interface PlainDataRecord<T = unknown> {
  kind: 'data';
  offset: number;
  payload: T;
}

export interface TxnDataRecord<T = unknown> {
  kind: 'txnData';
  offset: number;
  payload: T;
  txnId: TxnId;
}

export interface CommitMarker {
  kind: 'commit';
  offset: number;
  txnId: TxnId;
}

export interface AbortMarker {
  kind: 'abort';
  offset: number;
  txnId: TxnId;
}

/**
 * 代次栅栏：生产者切换到新 epoch 时写入。
 * 写入时该生产者所有旧 epoch 的未决事务被明确中止。
 */
export interface FenceRecord {
  kind: 'fence';
  offset: number;
  producer: string;
  epoch: number;
}

export type LogRecord<T = unknown> =
  | PlainDataRecord<T>
  | TxnDataRecord<T>
  | CommitMarker
  | AbortMarker
  | FenceRecord;
