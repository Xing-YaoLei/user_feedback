/** 事务日志相关错误的基类。 */
export class TxnLogError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

/** 生产者已经进入更高代次，旧代次的消息被拒绝（旧消息不能终结新代次同名事务）。 */
export class StaleEpochError extends TxnLogError {}

/** 对从未写入过数据的事务追加终结标记。 */
export class TransactionNotFoundError extends TxnLogError {}

/** 向已经终结（committed/aborted）的事务继续追加数据。 */
export class TransactionAlreadyFinalizedError extends TxnLogError {}

/** 冲突终态：事务已经是另一种终态，再次应用不同的终结标记。 */
export class ConflictTerminalError extends TxnLogError {}

/** 非法 offset（非整数、负数）或重放时 offset 不连续。 */
export class InvalidOffsetError extends TxnLogError {}

/** 非法读取参数（如 maxRecords 非正整数）。 */
export class InvalidArgumentError extends TxnLogError {}
