/**
 * 演示：消费到一半崩溃 → 集群换主截断（旧 offset 被新分支复用）→
 * 依据本地票据与 broker 证明恢复位置，绑定 token 继续消费。
 */
import { InMemoryTicketStore } from '../src/ticket-store.ts';
import { recoverPosition, resumeConsumption } from '../src/recovery.ts';
import { SimulatedBroker } from '../src/simulated-broker.ts';

const broker = new SimulatedBroker();
broker.append(0, 100); // epoch 0: offset 0-99
broker.append(1, 150); // epoch 1: offset 100-249

// 本地票据：epoch 0 处理完，epoch 1 处理到 180。
const store = new InMemoryTicketStore([
  { leaderEpoch: 0, nextOffset: 100 },
  { leaderEpoch: 1, nextOffset: 180 },
]);

// 崩溃期间：集群在 150 处截断并选出新 leader，epoch 2 从 150 复用 offset。
broker.truncateAndReassign(150);
broker.append(2, 70); // epoch 2: offset 150-219

const result = await recoverPosition(store, broker, { queryBudget: 10 });
console.log('recovery outcome:', result.outcome);
console.log('stats:', result.stats);

const batch = await resumeConsumption(broker, result);
console.log(
  `resumed fetch: ${batch.records.length} records, first = offset ${batch.records[0]?.offset} (epoch ${batch.records[0]?.leaderEpoch})`,
);
