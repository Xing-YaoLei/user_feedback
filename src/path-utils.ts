/**
 * 纯函数工具：路径合法性校验与确定性选路比较器。
 * 不依赖任何运行时状态，便于独立单元测试。
 */
import type { Candidate, SelectedRoute, SourceId } from './types.ts';

/** 字典序比较两个域 ID 序列（按元素逐段比较） */
export function compareDomainIdSequence(a: readonly string[], b: readonly string[]): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    if (a[i] < b[i]) return -1;
    if (a[i] > b[i]) return 1;
  }
  return a.length - b.length;
}

/**
 * 候选路径合法性：
 * 1. 路径非空且首跳必须是来源稳定 ID；
 * 2. 路径中出现本域 -> 拒绝（防止环路回流）；
 * 3. 路径内部存在重复域 -> 拒绝（公告本身已带环）。
 */
export function isAcceptablePath(
  path: readonly string[],
  source: SourceId,
  selfId: string,
): boolean {
  if (path.length === 0) return false;
  if (path[0] !== source.stableId) return false;
  const seen = new Set<string>();
  for (const dom of path) {
    if (dom === selfId) return false;
    if (seen.has(dom)) return false;
    seen.add(dom);
  }
  return true;
}

/** 候选的总代价 = 邻居公告路径代价（已在候选中隐含为链路累加）由调用方计算后传入比较 */
export interface RankedCandidate extends Candidate {
  /** 拼接本域后的完整路径：来源 -> ... -> 邻居 -> 本域 */
  fullPath: readonly string[];
  totalCost: number;
}

/**
 * 选路比较器，依次比较：
 *   1) 总代价（小者优）
 *   2) 跳数（少者优）
 *   3) 域 ID 序列字典序（小者优）
 * 保证同一输入集合得到确定的唯一最优候选。
 */
export function compareRanked(a: RankedCandidate, b: RankedCandidate): number {
  if (a.totalCost !== b.totalCost) return a.totalCost - b.totalCost;
  const hopsA = a.fullPath.length - 1;
  const hopsB = b.fullPath.length - 1;
  if (hopsA !== hopsB) return hopsA - hopsB;
  return compareDomainIdSequence(a.fullPath, b.fullPath);
}

/** 比较两个已选路由是否等价（选路输入未变时避免无谓重公告） */
export function sameSelectedRoute(a: SelectedRoute | null, b: SelectedRoute | null): boolean {
  if (a === null || b === null) return a === b;
  return (
    a.destination === b.destination &&
    a.totalCost === b.totalCost &&
    a.hops === b.hops &&
    a.version === b.version &&
    a.source.stableId === b.source.stableId &&
    a.source.gen === b.source.gen &&
    compareDomainIdSequence(a.fullPath, b.fullPath) === 0
  );
}

/** 断言为非负整数链路代价 */
export function assertNonNegativeIntCost(cost: number): void {
  if (!Number.isInteger(cost) || cost < 0) {
    throw new Error(`链路代价必须是非负整数，收到: ${String(cost)}`);
  }
}
