import { TransactionalLog, type TxnId } from './index.ts';

/**
 * 题目场景演示：
 * 事务 A 先写入，事务 B 随后写入并先提交。
 * read_committed 此时停在 A 的首条数据前；A 中止后再顺序读到 B。
 */
function main(): void {
  const log = new TransactionalLog<string>();

  const txnA: TxnId = { producer: 'p1', epoch: 0, txnId: 'A' };
  const txnB: TxnId = { producer: 'p1', epoch: 0, txnId: 'B' };

  log.appendData('a1', txnA); // offset 1（offset 0 是隐式栅栏）
  log.appendData('b1', txnB); // offset 2
  log.appendCommit(txnB); // offset 3，B 先提交

  console.log('--- B 已提交、A 仍未决 ---');
  console.log('read_committed 边界 LSO =', log.committedHighWatermark());

  const blocked = log.readCommitted(0);
  console.log('read_committed(0) =', JSON.stringify(blocked), '（空数据但越过栅栏控制记录，停在 A 首条前等待）');

  const dirty = log.readUncommitted(0);
  console.log('read_uncommitted(0) =', JSON.stringify(dirty.records.map((r) => r.payload)), '（未提交/已中止数据也可见）');

  log.appendAbort(txnA); // offset 4，A 中止

  console.log('\n--- A 中止之后 ---');
  console.log('read_committed 边界 LSO =', log.committedHighWatermark());

  // 从等待位置继续读：跳过 A 的中止数据，顺序读到 B。
  const after = log.readCommitted(blocked.nextOffset);
  console.log('read_committed 继续 =', JSON.stringify(after), '（跳过 a1，顺序读到 b1）');
  console.log('再读一次 =', JSON.stringify(log.readCommitted(after.nextOffset)), '（到达末尾，等待新数据）');

  console.log('\n--- 完整记录（含控制记录，各占 offset）---');
  for (const record of log.snapshot()) {
    console.log(record.offset, record);
  }
}

main();
