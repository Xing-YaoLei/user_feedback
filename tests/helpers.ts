/**
 * 测试公共设施：KV 命令模型、确定性集群装配、推进与重试工具。
 * 所有临时数据都放在本次工作区的 .test-tmp 下。
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DeterministicScheduler } from '../src/scheduler.ts';
import { SimTransport, type TransportPolicy } from '../src/transport.ts';
import { RaftNode } from '../src/raft.ts';
import { NotLeaderError, type NodeId, type RaftMessage } from '../src/types.ts';
// ---------------------------------------------------------------------------
// KV 状态机：调用方提供的确定性归约函数
// ---------------------------------------------------------------------------

export type KvCommand =
  | { op: 'set'; key: string; value: string }
  | { op: 'delete'; key: string };

export type KvState = Record<string, string>;

export function kvReducer(state: KvState, command: KvCommand): KvState {
  const next: KvState = { ...state };
  if (command.op === 'set') next[command.key] = command.value;
  else delete next[command.key];
  return next;
}

// ---------------------------------------------------------------------------
// 集群装配
// ---------------------------------------------------------------------------

export interface Cluster {
  scheduler: DeterministicScheduler;
  transport: SimTransport<KvCommand>;
  nodes: Map<NodeId, RaftNode<KvState, KvCommand>>;
  dataRoot: string;
  ids: NodeId[];
}

let clusterSeq = 0;

export function createCluster(
  ids: NodeId[],
  options: { seed?: number; policy?: TransportPolicy<KvCommand> } = {},
): Cluster {
  const dataRoot = mkdtempSync(join(tmpdir(), 'raft-test-'));
  const scheduler = new DeterministicScheduler(options.seed ?? 42);
  const transport = new SimTransport<KvCommand>(scheduler, options.policy ?? {});
  const nodes = new Map<NodeId, RaftNode<KvState, KvCommand>>();

  for (const id of ids) {
    const node = new RaftNode<KvState, KvCommand>({
      id,
      dataDir: join(dataRoot, id),
      bootstrapVoters: ids,
      reducer: kvReducer,
      initialState: {},
      scheduler,
      transport,
      electionTimeoutMin: 150,
      electionTimeoutMax: 300,
      heartbeatInterval: 60,
    });
    node.start();
    nodes.set(id, node);
  }
  clusterSeq++;
  return { scheduler, transport, nodes, dataRoot, ids: [...ids] };
}

export function destroyCluster(cluster: Cluster): void {
  for (const node of cluster.nodes.values()) node.stop();
  rmSync(cluster.dataRoot, { recursive: true, force: true });
}

/** 在保留持久化目录的前提下停止节点（模拟崩溃/停机）。 */
export function stopNode(cluster: Cluster, id: NodeId): void {
  cluster.nodes.get(id)?.stop();
}

/** 用同一 dataDir 重新启动节点，模拟进程重启后的状态恢复。 */
export function restartNode(cluster: Cluster, id: NodeId): RaftNode<KvState, KvCommand> {
  const previous = cluster.nodes.get(id);
  if (previous && !previous.isStopped) previous.stop();

  const node = new RaftNode<KvState, KvCommand>({
    id,
    dataDir: join(cluster.dataRoot, id),
    bootstrapVoters: cluster.ids,
    reducer: kvReducer,
    initialState: {},
    scheduler: cluster.scheduler,
    transport: cluster.transport,
    electionTimeoutMin: 150,
    electionTimeoutMax: 300,
    heartbeatInterval: 60,
  });
  node.start();
  cluster.nodes.set(id, node);
  return node;
}

/**
 * 向集群加入一个全新节点（独立空 dataDir）。
 * 它以学习者身份启动：初始引导配置不含自身，因此不会发起选举；
 * 领导者通过 AppendEntries 为其追平日志，配置条目到位后它自动成为投票成员。
 */
export function addNode(cluster: Cluster, id: NodeId): RaftNode<KvState, KvCommand> {
  if (cluster.nodes.has(id)) throw new Error(`node already exists: ${id}`);
  const node = new RaftNode<KvState, KvCommand>({
    id,
    dataDir: join(cluster.dataRoot, id),
    bootstrapVoters: cluster.ids,
    reducer: kvReducer,
    initialState: {},
    scheduler: cluster.scheduler,
    transport: cluster.transport,
    electionTimeoutMin: 150,
    electionTimeoutMax: 300,
    heartbeatInterval: 60,
  });
  node.start();
  cluster.nodes.set(id, node);
  return node;
}

// ---------------------------------------------------------------------------
// 推进与观察工具
// -------------------------------------------------------------------------

/** 推进虚拟时钟一个调度批次（稳态心跳常驻，按批次推进而非等堆清空）。 */
export function run(cluster: Cluster, maxSteps = 20_000): number {
  return cluster.scheduler.advance(maxSteps);
}

/**
 * 找到当前领导者。
 * 分区期间可能存在多个自认领导者：合法的那个赢得了当前配置多数派，
 * 因而拥有更高任期。这里返回任期最高的领导者；同任期多个则视为尚未收敛。
 */
export function findLeader(cluster: Cluster): RaftNode<KvState, KvCommand> | null {
  const leaders = [...cluster.nodes.values()].filter((n) => n.status().role === 'leader');
  if (leaders.length === 0) return null;
  let best = leaders[0]!;
  for (const node of leaders.slice(1)) {
    if (node.status().currentTerm > best.status().currentTerm) best = node;
    else if (node.status().currentTerm === best.status().currentTerm) return null;
  }
  return best;
}

/** 推进到选出可识别的领导者为止，失败返回 null。 */
export function awaitLeader(cluster: Cluster, maxSteps = 100_000): RaftNode<KvState, KvCommand> | null {
  let remaining = maxSteps;
  while (remaining > 0) {
    const leader = findLeader(cluster);
    if (leader) return leader;
    const executed = cluster.scheduler.advance(5_000);
    remaining -= executed;
    if (executed === 0) break;
  }
  return findLeader(cluster);
}

/** 让一个 Promise 结果落地（微任务在当前同步执行流后自动冲刷）。 */
export function flushMicrotasks(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

// ---------------------------------------------------------------------------
// 带重试的客户端操作（领导者切换时 NotLeaderError 是预期行为）
// ---------------------------------------------------------------------------

/**
 * 等待一个由 Raft 内部事件结算的 Promise（对外版本）。
 * 用于测试直接对特定节点调用 read()/propose() 的场景，
 * 内部交替推进虚拟时钟与微任务，并在出现更高任期领导者时提前失败。
 */
export function settleOperation<T>(
  cluster: Cluster,
  node: RaftNode<KvState, KvCommand>,
  promise: Promise<T>,
): Promise<T> {
  return settle(cluster, node, promise);
}

/**
 * 等待一个由 Raft 内部事件结算的 Promise。
 * 承诺的 resolve/reject 发生在 scheduler.advance 的同步回调里，
 * 因此这里交替推进虚拟时钟与让出微任务，直到承诺落地或预算耗尽。
 *
 * 若等待期间出现了任期更高的领导者（典型：分区后多数派侧重新选举），
 * 本节点已失去法定领导权，提前以 NotLeaderError 失败，交由调用方重试。
 */
async function settle<T>(
  cluster: Cluster,
  node: RaftNode<KvState, KvCommand>,
  promise: Promise<T>,
): Promise<T> {
  let result: { value?: T; error?: unknown } | null = null;
  promise.then(
    (value) => { result = { value }; },
    (error) => { result = { error }; },
  );
  const startTerm = node.status().currentTerm;
  let guard = 0;
  while (result === null && guard < 250) {
    cluster.scheduler.advance(2_000);
    await new Promise((resolve) => setTimeout(resolve, 0));
    guard++;
    const current = findLeader(cluster);
    if (current && current !== node && current.status().currentTerm > startTerm) {
      throw new NotLeaderError(current.id);
    }
    if (node.isStopped) throw new NotLeaderError(node.knownLeader);
  }
  if (result === null) throw new Error('operation did not settle within scheduling budget');
  if ('error' in result!) throw result.error;
  return result.value!;
}

export async function clientPropose(
  cluster: Cluster,
  command: KvCommand,
  attempts = 8,
): Promise<{ index: number; leaderId: NodeId }> {
  let lastError: unknown;
  for (let i = 0; i < attempts; i++) {
    const leader = awaitLeader(cluster);
    if (!leader) {
      run(cluster);
      continue;
    }
    try {
      const index = await settle(cluster, leader, leader.propose(command));
      return { index, leaderId: leader.id };
    } catch (error) {
      lastError = error;
      if (!(error instanceof NotLeaderError)) throw error;
      run(cluster);
    }
  }
  throw new Error(`propose failed after ${attempts} attempts: ${String(lastError)}`);
}

export async function clientRead(
  cluster: Cluster,
  key: string,
  attempts = 8,
): Promise<{ value: string | undefined; leaderId: NodeId }> {
  let lastError: unknown;
  for (let i = 0; i < attempts; i++) {
    const leader = awaitLeader(cluster);
    if (!leader) {
      run(cluster);
      continue;
    }
    try {
      const value = await settle(cluster, leader, leader.read((state: KvState) => state[key]));
      return { value, leaderId: leader.id };
    } catch (error) {
      lastError = error;
      if (!(error instanceof NotLeaderError)) throw error;
      run(cluster);
    }
  }
  throw new Error(`read failed after ${attempts} attempts: ${String(lastError)}`);
}

/**
 * 客户端发起成员替换并等待完成。
 * 配置变更可能跨越领导者切换：每次拿到当前领导者后用同一目标重新发起，
 * beginConfigChange 会幂等接续日志中已在进行的同目标变更。
 */
export async function clientConfigChange(
  cluster: Cluster,
  targetVoters: NodeId[],
  attempts = 12,
): Promise<{ index: number; leaderId: NodeId }> {
  let lastError: unknown;
  for (let i = 0; i < attempts; i++) {
    const leader = awaitLeader(cluster);
    if (!leader) {
      run(cluster);
      continue;
    }
    try {
      const index = await settle(cluster, leader, leader.beginConfigChange(targetVoters));
      return { index, leaderId: leader.id };
    } catch (error) {
      lastError = error;
      if (!(error instanceof NotLeaderError)) throw error;
      run(cluster);
    }
  }
  throw new Error(`config change failed after ${attempts} attempts: ${String(lastError)}`);
}

/** 收集全部节点的已应用 KV 状态，用于一致性核对。 */
export function appliedStates(cluster: Cluster): Record<NodeId, KvState> {
  const out: Record<NodeId, KvState> = {};
  for (const [id, node] of cluster.nodes) out[id] = node.status().lastApplied >= 0 ? snapshotOf(node) : {};
  return out;
}

export function snapshotOf(node: RaftNode<KvState, KvCommand>): KvState {
  // 通过 read 走线性一致路径会改变调度，测试核对改用 status + 只读文件快照。
  return (node as unknown as { state: KvState }).state;
}

/** 分区策略：隔离某个节点的双向流量（滞留而非丢弃，便于后续补投）。 */
export function isolatePolicy(
  isolatedId: NodeId,
  base: TransportPolicy<KvCommand> = {},
): TransportPolicy<KvCommand> {
  const involves = (message: RaftMessage<KvCommand>): boolean => {
    const addressed = message as RaftMessage<KvCommand> & { __to?: NodeId };
    const to = addressed.__to;
    if (to === isolatedId) return true;
    const source =
      message.type === 'RequestVote' ? message.candidateId
        : message.type === 'AppendEntries' ? message.leaderId
          : message.type === 'RequestVoteResp' ? message.voterId
            : message.followerId;
    return source === isolatedId;
  };
  return {
    ...base,
    holdPolicy: (message) => involves(message) || base.holdPolicy?.(message) === true,
  };
}
