import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { recoverPosition, resumeConsumption } from '../src/recovery.ts';
import {
  FileTicketStore,
  InMemoryTicketStore,
  TicketValidationError,
} from '../src/ticket-store.ts';
import { SimulatedBroker } from '../src/simulated-broker.ts';
import {
  ResetRequiredError,
  RetentionError,
  TokenMismatchError,
} from '../src/types.ts';

const tmpRoot = join(import.meta.dirname, 'tmp');
const delay = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

before(async () => {
  await mkdir(tmpRoot, { recursive: true });
});

after(async () => {
  await rm(tmpRoot, { recursive: true, force: true });
});

test('日志未分叉时从最新共同 epoch 恢复并继续 fetch', async () => {
  const broker = new SimulatedBroker();
  broker.append(0, 100); // epoch 0: 0-99
  broker.append(1, 150); // epoch 1: 100-249
  const store = new InMemoryTicketStore([
    { leaderEpoch: 0, nextOffset: 100 },
    { leaderEpoch: 1, nextOffset: 180 },
  ]);

  const result = await recoverPosition(store, broker, { queryBudget: 10 });
  assert.equal(result.outcome.kind, 'recovered');
  if (result.outcome.kind !== 'recovered') return;
  assert.equal(result.outcome.position, 180);
  assert.equal(result.outcome.leaderEpoch, 1);
  assert.equal(result.outcome.token, broker.currentToken());
  assert.equal(result.stats.rounds, 1);
  assert.equal(result.stats.epochQueries, 1);

  const batch = await resumeConsumption(broker, result);
  assert.equal(batch.records.length, 70);
  assert.equal(batch.records[0].offset, 180);
  assert.equal(batch.records[0].leaderEpoch, 1);
});

test('换主截断后回退到更旧的共同 epoch，位置取本地边界与 broker 有效末端的较小值', async () => {
  const broker = new SimulatedBroker();
  broker.append(0, 100);
  broker.append(1, 150); // epoch 1: 100-249
  // 截断到 150：epoch 1 只剩 100-149；新分支 epoch 2 复用 150 起的 offset。
  broker.truncateAndReassign(150);
  broker.append(2, 70); // epoch 2: 150-219

  const store = new InMemoryTicketStore([
    { leaderEpoch: 0, nextOffset: 100 },
    { leaderEpoch: 1, nextOffset: 200 }, // 本地已处理到 200，超过 broker 侧 epoch 1 有效末端
  ]);

  const result = await recoverPosition(store, broker, { queryBudget: 10 });
  assert.equal(result.outcome.kind, 'recovered');
  if (result.outcome.kind !== 'recovered') return;
  // min(本地 200, broker epoch1 有效末端 150) = 150
  assert.equal(result.outcome.position, 150);
  assert.equal(result.outcome.leaderEpoch, 1);

  const batch = await resumeConsumption(broker, result);
  assert.equal(batch.records[0].offset, 150);
  assert.equal(batch.records[0].leaderEpoch, 2); // 读到的是新分支数据
});

test('整个 epoch 被截掉时从双方最后一个共同 epoch 恢复', async () => {
  const broker = new SimulatedBroker();
  broker.append(0, 100);
  broker.append(1, 150);
  broker.truncateAndReassign(100); // epoch 1 整体消失
  broker.append(2, 80); // epoch 2: 100-179

  const store = new InMemoryTicketStore([
    { leaderEpoch: 0, nextOffset: 100 },
    { leaderEpoch: 1, nextOffset: 200 },
  ]);

  const result = await recoverPosition(store, broker, { queryBudget: 10 });
  assert.equal(result.outcome.kind, 'recovered');
  if (result.outcome.kind !== 'recovered') return;
  assert.equal(result.outcome.leaderEpoch, 0);
  assert.equal(result.outcome.position, 100); // min(100, epoch0 有效末端 100)
});

test('没有共同 epoch 证明时要求显式重置，不静默跳到最新', async () => {
  const broker = new SimulatedBroker();
  broker.append(9, 50); // broker 只有 epoch 9
  const store = new InMemoryTicketStore([
    { leaderEpoch: 5, nextOffset: 10 },
    { leaderEpoch: 6, nextOffset: 20 },
  ]);

  const result = await recoverPosition(store, broker, { queryBudget: 10 });
  assert.equal(result.outcome.kind, 'reset-required');
  if (result.outcome.kind !== 'reset-required') return;
  assert.equal(result.outcome.reason, 'no-common-epoch');
  // 调用方无法凭此结论继续消费
  await assert.rejects(resumeConsumption(broker, result), ResetRequiredError);
});

test('推得位置早于保留起点时要求显式重置', async () => {
  const broker = new SimulatedBroker();
  broker.append(0, 100);
  broker.append(1, 100);
  broker.applyRetention(50); // 保留起点推进到 50
  const store = new InMemoryTicketStore([{ leaderEpoch: 0, nextOffset: 30 }]);

  const result = await recoverPosition(store, broker, { queryBudget: 10 });
  assert.equal(result.outcome.kind, 'reset-required');
  if (result.outcome.kind !== 'reset-required') return;
  assert.equal(result.outcome.reason, 'before-retention-start');
  await assert.rejects(resumeConsumption(broker, result), ResetRequiredError);
  // 直接 fetch 保留起点之前的位置同样被适配器拒绝
  await assert.rejects(broker.fetch(30, broker.currentToken()), RetentionError);
});

test('空票据没有共同证明，要求显式重置', async () => {
  const broker = new SimulatedBroker();
  broker.append(0, 50);
  const result = await recoverPosition(new InMemoryTicketStore(), broker, {
    queryBudget: 5,
  });
  assert.equal(result.outcome.kind, 'reset-required');
  if (result.outcome.kind !== 'reset-required') return;
  assert.equal(result.outcome.reason, 'no-common-epoch');
  assert.equal(result.stats.epochQueries, 0);
});

test('查询中途 token 变更：丢弃本轮推导并用新 token 重做', async () => {
  const broker = new SimulatedBroker();
  broker.append(0, 100);
  broker.append(1, 150);
  let flipped = false;
  broker.hooks.beforeQueryResponse = () => {
    if (!flipped) {
      flipped = true;
      broker.truncateAndReassign(100); // epoch 1 整体被截掉，token 更换
      broker.append(2, 120); // epoch 2: 100-219
    }
  };
  const store = new InMemoryTicketStore([
    { leaderEpoch: 0, nextOffset: 100 },
    { leaderEpoch: 1, nextOffset: 200 },
  ]);

  const result = await recoverPosition(store, broker, { queryBudget: 10 });
  assert.equal(result.outcome.kind, 'recovered');
  if (result.outcome.kind !== 'recovered') return;
  assert.equal(result.outcome.position, 100); // 共同 epoch 只剩 0
  assert.equal(result.outcome.token, broker.currentToken()); // 绑定的是新 token
  assert.equal(result.stats.rounds, 2); // 第一轮作废重做

  const batch = await resumeConsumption(broker, result);
  assert.equal(batch.records[0].leaderEpoch, 2); // 新分支数据只在新 token 下返回
});

test('查询预算耗尽返回未定', async () => {
  const broker = new SimulatedBroker();
  broker.append(9, 50); // 与票据没有任何共同 epoch
  const store = new InMemoryTicketStore([
    { leaderEpoch: 3, nextOffset: 10 },
    { leaderEpoch: 4, nextOffset: 20 },
    { leaderEpoch: 5, nextOffset: 30 },
    { leaderEpoch: 6, nextOffset: 40 },
    { leaderEpoch: 7, nextOffset: 50 },
  ]);

  const result = await recoverPosition(store, broker, { queryBudget: 2 });
  assert.equal(result.outcome.kind, 'undetermined');
  if (result.outcome.kind !== 'undetermined') return;
  assert.equal(result.outcome.reason, 'query-budget-exhausted');
  assert.equal(result.stats.epochQueries, 2);
});

test('token 持续不稳定时返回未定而不是死循环', async () => {
  const broker = new SimulatedBroker();
  broker.append(0, 50);
  broker.hooks.beforeQueryResponse = () => {
    broker.truncateAndReassign(0); // 每次查询都换 token
  };
  const store = new InMemoryTicketStore([{ leaderEpoch: 0, nextOffset: 10 }]);

  const result = await recoverPosition(store, broker, {
    queryBudget: 50,
    maxRounds: 3,
  });
  assert.equal(result.outcome.kind, 'undetermined');
  if (result.outcome.kind !== 'undetermined') return;
  assert.equal(result.outcome.reason, 'token-unstable');
  assert.equal(result.stats.rounds, 3);
});

test('迟到回包不能覆盖已经确定的新恢复结果', async () => {
  const broker = new SimulatedBroker();
  broker.append(0, 100);
  broker.append(1, 150); // epoch 1: 100-249
  broker.validateTokenAtResponse = false; // 模拟滞后副本：按请求时快照迟到应答
  broker.queryDelayMs = 40;
  const store = new InMemoryTicketStore([
    { leaderEpoch: 0, nextOffset: 100 },
    { leaderEpoch: 1, nextOffset: 200 },
  ]);

  // 查询在途时集群换主截断
  setTimeout(() => {
    broker.truncateAndReassign(120); // epoch 1 只剩 100-119
    broker.append(2, 80); // epoch 2: 120-199
  }, 10);

  const result = await recoverPosition(store, broker, { queryBudget: 10 });
  assert.equal(result.outcome.kind, 'recovered');
  if (result.outcome.kind !== 'recovered') return;
  assert.equal(result.outcome.position, 120); // min(200, epoch1 有效末端 120)
  assert.equal(result.outcome.token, broker.currentToken());
  assert.equal(result.stats.rounds, 2);

  // 等迟到回包落地：它必须被丢弃，结果不变
  await delay(100);
  assert.ok(
    result.stats.discardedLateReplies >= 1,
    `expected late replies to be discarded, got ${result.stats.discardedLateReplies}`,
  );
  assert.equal(result.outcome.position, 120);
});

test('恢复结果确定后 token 再变：旧 token 的 fetch 被原子拒绝，需重新恢复', async () => {
  const broker = new SimulatedBroker();
  broker.append(0, 100);
  broker.append(1, 150);
  const store = new InMemoryTicketStore([
    { leaderEpoch: 0, nextOffset: 100 },
    { leaderEpoch: 1, nextOffset: 180 },
  ]);

  const first = await recoverPosition(store, broker, { queryBudget: 10 });
  assert.equal(first.outcome.kind, 'recovered');
  if (first.outcome.kind !== 'recovered') return;

  // 结果确定后集群再次换主截断
  broker.truncateAndReassign(150);
  broker.append(2, 70);

  // 适配器原子校验：绝不把新分支数据冒充旧 token 的数据返回
  await assert.rejects(
    broker.fetch(first.outcome.position, first.outcome.token),
    TokenMismatchError,
  );

  // 调用方重新恢复，拿到新 token 后继续
  const second = await recoverPosition(store, broker, { queryBudget: 10 });
  assert.equal(second.outcome.kind, 'recovered');
  if (second.outcome.kind !== 'recovered') return;
  assert.equal(second.outcome.position, 150); // min(180, epoch1 有效末端 150)
  const batch = await resumeConsumption(broker, second);
  assert.equal(batch.records[0].offset, 150);
  assert.equal(batch.records[0].leaderEpoch, 2);
});

test('崩溃重启：文件票据重载后跨换主恢复，无需调用方猜测位点', async () => {
  const dir = await mkdtemp(join(tmpRoot, 'crash-'));
  const ticketPath = join(dir, 'ticket.json');

  const broker = new SimulatedBroker();
  broker.append(0, 50); // epoch 0: 0-49
  broker.append(1, 70); // epoch 1: 50-119

  // 崩溃前：消费进度落盘
  const before1 = new FileTicketStore(ticketPath);
  await before1.save([
    { leaderEpoch: 0, nextOffset: 50 },
    { leaderEpoch: 1, nextOffset: 80 },
  ]);

  // 崩溃期间：集群在 50 处截断（epoch 1 整体消失），epoch 2 复用 50 起的 offset
  broker.truncateAndReassign(50);
  broker.append(2, 90); // epoch 2: 50-139

  // 重启：新实例从磁盘重载票据
  const after1 = new FileTicketStore(ticketPath);
  const result = await recoverPosition(after1, broker, { queryBudget: 10 });
  assert.equal(result.outcome.kind, 'recovered');
  if (result.outcome.kind !== 'recovered') return;
  assert.equal(result.outcome.leaderEpoch, 0);
  assert.equal(result.outcome.position, 50);

  // 继续消费并把新进度落盘（含新 epoch）
  const batch = await resumeConsumption(broker, result);
  assert.equal(batch.records[0].offset, 50);
  assert.equal(batch.records[0].leaderEpoch, 2);
  const last = batch.records[batch.records.length - 1];
  await after1.save([
    { leaderEpoch: 0, nextOffset: 50 },
    { leaderEpoch: 2, nextOffset: last.offset + 1 },
  ]);
  const reloaded = await new FileTicketStore(ticketPath).load();
  assert.deepEqual(reloaded, [
    { leaderEpoch: 0, nextOffset: 50 },
    { leaderEpoch: 2, nextOffset: 140 },
  ]);
});

test('损坏票据被拒绝：epoch 必须严格递增、offset 单调不减', async () => {
  assert.throws(
    () =>
      new InMemoryTicketStore([
        { leaderEpoch: 2, nextOffset: 10 },
        { leaderEpoch: 1, nextOffset: 20 },
      ]),
    TicketValidationError,
  );
  assert.throws(
    () =>
      new InMemoryTicketStore([
        { leaderEpoch: 1, nextOffset: 50 },
        { leaderEpoch: 2, nextOffset: 40 },
      ]),
    TicketValidationError,
  );

  const dir = await mkdtemp(join(tmpRoot, 'corrupt-'));
  const ticketPath = join(dir, 'ticket.json');
  await writeFile(ticketPath, 'not json');
  await assert.rejects(new FileTicketStore(ticketPath).load(), TicketValidationError);
});
