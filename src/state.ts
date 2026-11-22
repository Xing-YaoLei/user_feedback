/**
 * 集群状态工具：把“当前实际副本 + 进行中副本”的输入归一化为
 * 规划器/执行器共用的内存状态，并统一计算槽位占用。
 *
 * 关键语义：
 * - 进行中副本（inflight）与实际副本一样占用 Broker 槽位；
 * - 但只有实际副本计入分区的“可用副本数 / 覆盖故障域数”；
 * - 同一 Broker 上同一分区至多有一个副本（实际或进行中）。
 */

import type {
  BrokerId,
  BrokerSpec,
  InFlightReplica,
  PartitionId,
} from './types.ts';

export interface ClusterState {
  brokers: Map<BrokerId, BrokerSpec>;
  /** 分区 -> 持有其“实际副本”的 Broker 集合。 */
  actual: Map<PartitionId, Set<BrokerId>>;
  /** slotKey(partition, broker) -> 进行中复制的 requestId。 */
  inflight: Map<string, string>;
}

/** 单元分隔符，避免 Broker 名互为后缀时的字符串匹配误伤。 */
const SLOT_SEP = '␟';

export function slotKey(partition: PartitionId, broker: BrokerId): string {
  return `${partition}${SLOT_SEP}${broker}`;
}

export function parseSlotKey(key: string): { partition: PartitionId; broker: BrokerId } {
  const idx = key.indexOf(SLOT_SEP);
  return { partition: key.slice(0, idx), broker: key.slice(idx + 1) };
}

export function buildClusterState(
  brokers: BrokerSpec[],
  current: Record<PartitionId, BrokerId[]>,
  inflight: InFlightReplica[] = [],
): ClusterState {
  const brokerMap = new Map<BrokerId, BrokerSpec>();
  for (const b of brokers) brokerMap.set(b.id, b);

  const actual = new Map<PartitionId, Set<BrokerId>>();
  for (const [partition, list] of Object.entries(current)) {
    const set = new Set<BrokerId>();
    for (const b of list) {
      if (!brokerMap.has(b)) {
        throw new Error(`current 中引用了不存在的 Broker: ${b}（分区 ${partition}）`);
      }
      set.add(b);
    }
    actual.set(partition, set);
  }

  const inflightMap = new Map<string, string>();
  for (const r of inflight) {
    if (!brokerMap.has(r.broker)) {
      throw new Error(`inflight 中引用了不存在的 Broker: ${r.broker}（分区 ${r.partition}）`);
    }
    inflightMap.set(slotKey(r.partition, r.broker), r.requestId);
  }
  return { brokers: brokerMap, actual, inflight: inflightMap };
}

export function inflightEntries(state: ClusterState): Array<{
  partition: PartitionId;
  broker: BrokerId;
  requestId: string;
}> {
  const out: Array<{ partition: PartitionId; broker: BrokerId; requestId: string }> = [];
  for (const [key, requestId] of state.inflight) {
    const { partition, broker } = parseSlotKey(key);
    out.push({ partition, broker, requestId });
  }
  return out;
}

/** Broker 上的总占用 = 实际副本数 + 进行中副本数。 */
export function usageOf(state: ClusterState, broker: BrokerId): number {
  let n = 0;
  for (const set of state.actual.values()) if (set.has(broker)) n++;
  for (const entry of inflightEntries(state)) if (entry.broker === broker) n++;
  return n;
}

export function hasReplica(state: ClusterState, partition: PartitionId, broker: BrokerId): boolean {
  return state.actual.get(partition)?.has(broker) === true
    || state.inflight.has(slotKey(partition, broker));
}

export function domainOf(state: ClusterState, broker: BrokerId): string {
  const spec = state.brokers.get(broker);
  if (!spec) throw new Error(`未知 Broker: ${broker}`);
  return spec.domain;
}

/** 分区实际副本覆盖的故障域集合。 */
export function actualDomains(state: ClusterState, partition: PartitionId): Set<string> {
  const domains = new Set<string>();
  for (const b of state.actual.get(partition) ?? []) domains.add(domainOf(state, b));
  return domains;
}
