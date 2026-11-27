import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TransactionalLog, type TxnId } from '../src/index.ts';
import {
  ConflictTerminalError,
  InvalidArgumentError,
  InvalidOffsetError,
  TransactionAlreadyFinalizedError,
  TransactionNotFoundError,
} from '../src/index.ts';

const txn = (producer: string, epoch: number, txnId: string): TxnId => ({ producer, epoch, txnId });

const offsets = <T>(result: { records: { offset: number }[] }): number[] =>
  result.records.map((record) => record.offset);

const payloads = <T>(result: { records: { payload: T }[] }): T[] =>
  result.records.map((record) => record.payload);

test('题目场景：A 先写、B 后写先提交，read_committed 停在 A 首条前，A 中止后顺序读到 B', () => {
  const log = new TransactionalLog<string>();
  const a = txn('p1', 0, 'A');
  const b = txn('p1', 0, 'B');

  const aOffset = log.appendData('a1', a);
  const bOffset = log.appendData('b1', b);
  const bCommit = log.appendCommit(b);

  // B 已提交、A 未决：边界停在 A 的首条数据位置，B 即使已提交也不能越过 A 返回。
  assert.equal(log.committedHighWatermark(), aOffset);

  const blocked = log.readCommitted(0);
  assert.deepEqual(payloads(blocked), []);
  assert.equal(blocked.nextOffset, aOffset); // 越过了栅栏控制记录，停在 A 首条前
  assert.equal(blocked.wait, true);

  // 不能替调用方跳过障碍：同一位置反复读，位置不变。
  const blockedAgain = log.readCommitted(blocked.nextOffset);
  assert.equal(blockedAgain.nextOffset, aOffset);
  assert.equal(blockedAgain.wait, true);

  // read_uncommitted 不受边界限制，A/B 数据都可见。
  const dirty = log.readUncommitted(0);
  assert.deepEqual(payloads(dirty), ['a1', 'b1']);
  assert.equal(dirty.nextOffset, log.logEndOffset);
  assert.equal(dirty.wait, true);

  log.appendAbort(a);

  // A 中止后边界推进到日志末尾；从原等待位置继续，跳过 a1 后顺序读到 b1。
  assert.equal(log.committedHighWatermark(), log.logEndOffset);
  const resolved = log.readCommitted(blocked.nextOffset);
  assert.deepEqual(payloads(resolved), ['b1']);
  assert.deepEqual(offsets(resolved), [bOffset]);
  assert.equal(resolved.nextOffset, log.logEndOffset);
  assert.equal(resolved.wait, true);
});

test('普通数据不参与事务，在两种读取方式下立即可见', () => {
  const log = new TransactionalLog<string>();
  log.appendData('plain-1');
  log.appendData('plain-2');

  const committed = log.readCommitted(0);
  assert.deepEqual(payloads(committed), ['plain-1', 'plain-2']);
  assert.equal(committed.wait, true);

  const uncommitted = log.readUncommitted(0);
  assert.deepEqual(payloads(uncommitted), ['plain-1', 'plain-2']);
});

test('read_committed 只返回已提交事务数据，中止事务数据被跳过但仍推进扫描位置', () => {
  const log = new TransactionalLog<string>();
  const x = txn('p1', 0, 'X');
  log.appendData('x1', x);
  log.appendAbort(x);
  log.appendData('after-abort');

  const result = log.readCommitted(0);
  assert.deepEqual(payloads(result), ['after-abort']);
  // 栅栏(0)、x1(1)、abort(2) 全部计入扫描位置。
  assert.equal(result.nextOffset, 4);
  assert.equal(result.wait, true);

  // read_uncommitted 仍能看到已中止的 x1。
  assert.deepEqual(payloads(log.readUncommitted(0)), ['x1', 'after-abort']);
});

test('控制记录（commit/abort/fence）不返回给消费者但计入扫描位置', () => {
  const log = new TransactionalLog<string>();
  const x = txn('p1', 0, 'X');
  log.appendData('x1', x); // offset 1
  log.appendCommit(x); // offset 2

  const result = log.readCommitted(0);
  assert.deepEqual(offsets(result), [1]);
  assert.equal(result.nextOffset, 3);
});

test('允许返回空数据但推进：对已中止事务区域的分段扫描只推进不返回数据', () => {
  const log = new TransactionalLog<string>();
  const x = txn('p1', 0, 'X');
  const pending = txn('p1', 0, 'P');
  log.appendData('x1', x); // fence(0) x1(1) abort(2)
  log.appendAbort(x);
  log.appendData('p1', pending); // p1(3)，未决事务把边界挡在 offset 3

  assert.equal(log.committedHighWatermark(), 3);

  // 从已中止数据开始扫：x1 跳过、abort 控制记录跳过，空数据但推进到边界。
  const first = log.readCommitted(1);
  assert.deepEqual(first.records, []);
  assert.equal(first.nextOffset, 3);
  assert.equal(first.wait, true); // 游标抵达未决事务边界

  // 边界上保持原位置等待，不能替调用方跳过障碍。
  const blocked = log.readCommitted(first.nextOffset);
  assert.deepEqual(blocked.records, []);
  assert.equal(blocked.nextOffset, 3);
  assert.equal(blocked.wait, true);

  // 未决事务中止后边界放开，同一位置继续扫描。
  log.appendAbort(pending);
  log.appendData('tail');
  const resumed = log.readCommitted(3);
  assert.deepEqual(payloads(resumed), ['tail']);
  assert.equal(resumed.wait, true);
});

test('maxRecords 分页：到达条数上限时不等待，可从 nextOffset 继续', () => {
  const log = new TransactionalLog<string>();
  const x = txn('p1', 0, 'X');
  log.appendData('x1', x);
  log.appendData('x2', x);
  log.appendCommit(x);
  log.appendData('tail');

  const page1 = log.readCommitted(0, { maxRecords: 1 });
  assert.deepEqual(payloads(page1), ['x1']);
  assert.equal(page1.wait, false);

  const page2 = log.readCommitted(page1.nextOffset, { maxRecords: 1 });
  assert.deepEqual(payloads(page2), ['x2']);
  assert.equal(page2.wait, false);

  const page3 = log.readCommitted(page2.nextOffset);
  assert.deepEqual(payloads(page3), ['tail']);
  assert.equal(page3.wait, true);

  // read_uncommitted 同样支持分页。
  const dirtyPage = log.readUncommitted(0, { maxRecords: 2 });
  assert.deepEqual(payloads(dirtyPage), ['x1', 'x2']);
  assert.equal(dirtyPage.wait, false);
});

test('未决事务之后的普通数据与已提交数据在 read_committed 中被障碍挡住', () => {
  const log = new TransactionalLog<string>();
  const slow = txn('p1', 0, 'slow');
  const fast = txn('p1', 0, 'fast');

  log.appendData('slow-1', slow); // offset 1，最早未决
  log.appendData('plain-between'); // offset 2
  log.appendData('fast-1', fast); // offset 3
  log.appendCommit(fast); // offset 4

  assert.equal(log.committedHighWatermark(), 1);
  const blocked = log.readCommitted(0);
  assert.deepEqual(blocked.records, []);
  assert.equal(blocked.nextOffset, 1);
  assert.equal(blocked.wait, true);

  log.appendCommit(slow);
  const all = log.readCommitted(0);
  assert.deepEqual(payloads(all), ['slow-1', 'plain-between', 'fast-1']);
  assert.equal(all.wait, true);
});

test('多个未决事务时边界取最早首条位置；逐个终结后边界随之推进', () => {
  const log = new TransactionalLog<string>();
  const a = txn('p1', 0, 'A');
  const b = txn('p1', 0, 'B');

  log.appendData('a1', a); // 1
  log.appendData('b1', b); // 2
  assert.equal(log.committedHighWatermark(), 1);

  log.appendCommit(a);
  // A 终结后，B 成为最早未决，边界推进到 B 的首条位置。
  assert.equal(log.committedHighWatermark(), 2);

  const partial = log.readCommitted(0);
  assert.deepEqual(payloads(partial), ['a1']);
  assert.equal(partial.nextOffset, 2);
  assert.equal(partial.wait, true);

  log.appendCommit(b);
  assert.equal(log.committedHighWatermark(), log.logEndOffset);
  assert.deepEqual(payloads(log.readCommitted(0)), ['a1', 'b1']);
});

test('相同终态标记可重复应用且幂等，不新增记录', () => {
  const log = new TransactionalLog<string>();
  const x = txn('p1', 0, 'X');
  log.appendData('x1', x);
  const first = log.appendCommit(x);
  assert.equal(first.idempotent, false);

  const again = log.appendCommit(x);
  assert.equal(again.idempotent, true);
  assert.equal(again.offset, first.offset);
  assert.equal(log.logEndOffset, 3); // 栅栏 + 数据 + 一次 commit，没有重复标记

  const a = txn('p2', 0, 'A');
  log.appendData('a1', a);
  const abort1 = log.appendAbort(a);
  const abort2 = log.appendAbort(a);
  assert.equal(abort2.idempotent, true);
  assert.equal(abort2.offset, abort1.offset);
});

test('冲突终态被拒绝：commit 后 abort、abort 后 commit 均报错', () => {
  const log = new TransactionalLog<string>();
  const x = txn('p1', 0, 'X');
  log.appendData('x1', x);
  log.appendCommit(x);
  assert.throws(() => log.appendAbort(x), ConflictTerminalError);

  const y = txn('p1', 0, 'Y');
  log.appendData('y1', y);
  log.appendAbort(y);
  assert.throws(() => log.appendCommit(y), ConflictTerminalError);
});

test('向已终结事务追加数据被拒绝', () => {
  const log = new TransactionalLog<string>();
  const x = txn('p1', 0, 'X');
  log.appendData('x1', x);
  log.appendCommit(x);
  assert.throws(() => log.appendData('x2', x), TransactionAlreadyFinalizedError);

  const y = txn('p1', 0, 'Y');
  log.appendData('y1', y);
  log.appendAbort(y);
  assert.throws(() => log.appendData('y2', y), TransactionAlreadyFinalizedError);
});

test('对不存在的事务追加终结标记被拒绝', () => {
  const log = new TransactionalLog<string>();
  assert.throws(() => log.appendCommit(txn('p1', 0, 'ghost')), TransactionNotFoundError);
  assert.throws(() => log.appendAbort(txn('p1', 0, 'ghost')), TransactionNotFoundError);
});

test('非法 offset 与 maxRecords 抛出参数错误', () => {
  const log = new TransactionalLog<string>();
  log.appendData('v');

  assert.throws(() => log.readCommitted(-1), InvalidOffsetError);
  assert.throws(() => log.readCommitted(1.5), InvalidOffsetError);
  assert.throws(() => log.readUncommitted(-1), InvalidOffsetError);
  assert.throws(() => log.readCommitted(0, { maxRecords: 0 }), InvalidArgumentError);
  assert.throws(() => log.readCommitted(0, { maxRecords: -2 }), InvalidArgumentError);
  assert.throws(() => log.readCommitted(0, { maxRecords: 1.5 }), InvalidArgumentError);
});

test('snapshot 与 replay：重放后的日志与原日志终态、读取结果完全等价', () => {
  const log = new TransactionalLog<string>();
  const a = txn('p1', 0, 'A');
  const b = txn('p2', 0, 'B');
  log.appendData('a1', a);
  log.appendData('plain');
  log.appendData('b1', b);
  log.appendCommit(b);
  log.appendAbort(a);
  log.appendData('tail');

  const replayed = TransactionalLog.replay(log.snapshot());
  assert.equal(replayed.logEndOffset, log.logEndOffset);
  assert.equal(replayed.committedHighWatermark(), log.committedHighWatermark());
  assert.deepEqual(replayed.snapshot(), log.snapshot());
  assert.deepEqual(replayed.readCommitted(0), log.readCommitted(0));
  assert.deepEqual(replayed.readUncommitted(0), log.readUncommitted(0));
  assert.deepEqual(replayed.getTxnStatus(a), log.getTxnStatus(a));
  assert.deepEqual(replayed.getTxnStatus(b), log.getTxnStatus(b));
});

test('replay 拒绝不连续的 offset', () => {
  const log = new TransactionalLog<string>();
  log.appendData('v');
  const snapshot = log.snapshot();
  snapshot[0]!.offset = 99;
  assert.throws(() => TransactionalLog.replay(snapshot), InvalidOffsetError);
});

test('所有记录（含控制记录）占有连续递增 offset', () => {
  const log = new TransactionalLog<string>();
  const x = txn('p1', 0, 'X');
  const expected: string[] = ['fence', 'txnData', 'abort', 'data'];
  log.appendData('x1', x);
  log.appendAbort(x);
  log.appendData('plain');

  log.snapshot().forEach((record, index) => {
    assert.equal(record.offset, index);
    assert.equal(record.kind, expected[index]);
  });
  assert.equal(log.logEndOffset, 4);
});
