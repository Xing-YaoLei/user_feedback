import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TransactionalLog, type TxnId, type TxnStatus } from '../src/index.ts';
import { StaleEpochError, TransactionNotFoundError } from '../src/index.ts';

const txn = (producer: string, epoch: number, txnId: string): TxnId => ({ producer, epoch, txnId });

const payloads = <T>(result: { records: { payload: T }[] }): T[] =>
  result.records.map((record) => record.payload);

test('生产者切换代次时明确中止旧代次尚未结束的事务', () => {
  const log = new TransactionalLog<string>();
  const oldTxn = txn('p1', 0, 'T');
  log.appendData('old-1', oldTxn); // 隐式栅栏 offset 0，数据 offset 1

  // 新代次数据触发隐式栅栏：旧代次未决事务被中止。
  const newTxn = txn('p1', 1, 'T');
  const newOffset = log.appendData('new-1', newTxn); // 栅栏 offset 2，数据 offset 3

  const oldStatus = log.getTxnStatus(oldTxn) as TxnStatus;
  assert.equal(oldStatus.state, 'aborted');
  assert.equal(oldStatus.terminalOffset, 2); // 中止点就是栅栏位置

  // 旧事务的中止数据在 read_committed 中跳过，新事务仍未决，边界在新事务首条前。
  assert.equal(log.committedHighWatermark(), newOffset);
  const view = log.readCommitted(0);
  assert.deepEqual(view.records, []);
  assert.equal(view.nextOffset, newOffset);

  log.appendCommit(newTxn);
  assert.deepEqual(payloads(log.readCommitted(0)), ['new-1']);
});

test('显式 appendFence 中止旧代次未决事务，并返回被中止的事务列表', () => {
  const log = new TransactionalLog<string>();
  const t1 = txn('p1', 0, 'T1');
  const t2 = txn('p1', 0, 'T2');
  log.appendData('t1', t1);
  log.appendData('t2', t2);

  const fence = log.appendFence('p1', 1);
  assert.equal(fence.offset, 3);
  assert.deepEqual(
    fence.abortedTxns.map((id) => id.txnId).sort(),
    ['T1', 'T2'],
  );
  assert.equal(log.getTxnStatus(t1)?.state, 'aborted');
  assert.equal(log.getTxnStatus(t2)?.state, 'aborted');

  // 同代次栅栏幂等：无新记录、无中止事务。
  const endBefore = log.logEndOffset;
  const same = log.appendFence('p1', 1);
  assert.equal(same.offset, -1);
  assert.equal(log.logEndOffset, endBefore);
  assert.deepEqual(same.abortedTxns, []);
});

test('旧代次消息不能终结新代次同名事务（按 epoch 区分）', () => {
  const log = new TransactionalLog<string>();
  const oldTxn = txn('p1', 0, 'T');
  const newTxn = txn('p1', 1, 'T');

  log.appendData('old', oldTxn);
  log.appendData('new', newTxn); // 隐式栅栏，oldTxn 被中止，同名新事务独立存在

  // 旧代次的 abort/commit 一律按陈旧代次拒绝，不能作用于新事务。
  assert.throws(() => log.appendAbort(oldTxn), StaleEpochError);
  assert.throws(() => log.appendCommit(oldTxn), StaleEpochError);

  const newStatus = log.getTxnStatus(newTxn);
  assert.equal(newStatus?.state, 'pending');

  log.appendCommit(newTxn);
  assert.equal(log.getTxnStatus(newTxn)?.state, 'committed');
});

test('旧代次的追加数据被拒绝', () => {
  const log = new TransactionalLog<string>();
  log.appendData('v0', txn('p1', 0, 'T'));
  log.appendFence('p1', 1);

  assert.throws(() => log.appendData('stale', txn('p1', 0, 'T')), StaleEpochError);
  assert.throws(() => log.appendData('stale2', txn('p1', 0, 'OTHER')), StaleEpochError);
});

test('栅栏回退到更低代次被拒绝', () => {
  const log = new TransactionalLog<string>();
  log.appendFence('p1', 5);
  assert.throws(() => log.appendFence('p1', 4), StaleEpochError);
  assert.throws(() => log.appendFence('p1', 0), StaleEpochError);
});

test('不同生产者的代次互相独立，栅栏只中止本生产者事务', () => {
  const log = new TransactionalLog<string>();
  const p1Txn = txn('p1', 0, 'T');
  const p2Txn = txn('p2', 0, 'T');
  log.appendData('p1-data', p1Txn);
  log.appendData('p2-data', p2Txn);

  log.appendFence('p1', 1);
  assert.equal(log.getTxnStatus(p1Txn)?.state, 'aborted');
  assert.equal(log.getTxnStatus(p2Txn)?.state, 'pending');
});

test('已终结事务不受后续代次栅栏影响，栅栏只中止未决事务', () => {
  const log = new TransactionalLog<string>();
  const committed = txn('p1', 0, 'C');
  const aborted = txn('p1', 0, 'A');
  const pending = txn('p1', 0, 'P');

  log.appendData('c', committed);
  log.appendData('a', aborted);
  log.appendData('p', pending);
  log.appendCommit(committed);
  log.appendAbort(aborted);

  const fence = log.appendFence('p1', 1);
  assert.deepEqual(fence.abortedTxns.map((id) => id.txnId), ['P']);
  assert.equal(log.getTxnStatus(committed)?.state, 'committed');
  assert.equal(log.getTxnStatus(aborted)?.state, 'aborted');
});

test('新代次下同名事务是全新事务，终结不存在的新事务仍报 not found', () => {
  const log = new TransactionalLog<string>();
  log.appendData('old', txn('p1', 0, 'T'));
  log.appendFence('p1', 1);
  // epoch 1 下从未写过数据的同名事务不能直接提交。
  assert.throws(() => log.appendCommit(txn('p1', 1, 'T')), TransactionNotFoundError);
});
