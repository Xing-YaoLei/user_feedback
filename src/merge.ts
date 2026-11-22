import {
  ABSENT,
  deepEqual,
  isArrayNode,
  isObjectNode,
  pathToString,
  validateConfig,
  type ArrayNode,
  type ConfigNode,
  type MaybeNode,
  type ObjectNode,
  type Path,
} from './model.ts';
import { findCycles, topoSort, type GraphEdge } from './graph.ts';
import { checkReferences, type ReferenceIssue } from './refs.ts';

export type Side = 'base' | 'left' | 'right';

/**
 * 内容取舍指令：在指定稳定 ID 路径处，强制采用某一侧（或基线）的子树。
 * 可用于解决值冲突，也可用于消除悬空引用 / 引用环（例如强制采用不含引用的那一侧）。
 */
export interface ValueDirective {
  type: 'value';
  path: Path;
  choice: Side;
}

/** 顺序取舍指令：对指定数组中的元素对 {a, b}，强制采用某一侧（或基线）的先后关系。 */
export interface OrderDirective {
  type: 'order';
  arrayPath: Path;
  a: string;
  b: string;
  choice: Side;
}

export type Directive = ValueDirective | OrderDirective;

export type ValueConflictReason =
  | 'both-modified' // 两侧改成不同值（含类型不一致）
  | 'delete-modified' // 一侧删除，另一侧修改了该节点或其后代的内容/位置
  | 'added-differently'; // 两侧各自新增了不同的值

/** 值冲突。base/left/right 保留三侧原值（ABSENT 表示该侧不存在），保证每次预览可追溯。 */
export interface ValueConflict {
  type: 'value';
  reason: ValueConflictReason;
  /** 稳定 ID 路径，如 /services/[web]/port。 */
  path: string;
  base: MaybeNode;
  left: MaybeNode;
  right: MaybeNode;
}

/** 顺序关系的来源：base=双方均未改动；left/right=单侧改动；both=双方一致改动；directive=取舍指令。 */
export type RelationOrigin = 'base' | 'left' | 'right' | 'both' | 'directive';

export interface OrderRelation {
  before: string;
  after: string;
  origin: RelationOrigin;
  /** origin 为 'directive' 时记录所采用的一侧。 */
  choice?: Side;
}

export interface OrderCycle {
  /** 环上的元素 ID 序列，首尾相同。 */
  elements: string[];
  /** 构成环的每条顺序关系及其来源。 */
  relations: OrderRelation[];
}

export interface ConflictingPair {
  a: string;
  b: string;
  /** 各侧对该元素对的先后关系（[先, 后]），null 表示该侧不同时包含两元素。 */
  base: [string, string] | null;
  left: [string, string] | null;
  right: [string, string] | null;
}

/** 顺序冲突：合成后的顺序关系成环，给出具体环与每条关系的来源。 */
export interface OrderConflict {
  type: 'order';
  arrayPath: string;
  cycles: OrderCycle[];
  conflictingPairs: ConflictingPair[];
}

export interface MergeOptions {
  directives?: Directive[];
}

export interface MergeResult {
  /** 内容、顺序、引用三类约束全部成立时为 true，此时 snapshot 一定存在。 */
  publishable: boolean;
  /** 可发布快照（仅当 publishable）。 */
  snapshot?: ConfigNode;
  /** 无内容/顺序冲突时的合并候选；可能仍带待解决的引用问题。 */
  candidate?: ConfigNode;
  valueConflicts: ValueConflict[];
  orderConflicts: OrderConflict[];
  referenceIssues: ReferenceIssue[];
}

interface MergeCtx {
  valueDirectives: Map<string, Side>;
  orderDirectives: Map<string, Side>;
  /** 所有指令涉及的路径（值指令路径 + 顺序指令的数组路径），用于判断子树内是否有指令。 */
  directivePaths: string[];
  valueConflicts: ValueConflict[];
  orderConflicts: OrderConflict[];
}

/**
 * 结构化三方合并。纯函数：调用方针对冲突给出 directives 后再次调用即可重新计算。
 * 左右两侧交换、对象键遍历次序改变，都会得到等价的候选与冲突集合。
 */
export function mergeConfigs(
  base: ConfigNode,
  left: ConfigNode,
  right: ConfigNode,
  options: MergeOptions = {},
): MergeResult {
  validateConfig(base, '', new Set());
  validateConfig(left, '', new Set());
  validateConfig(right, '', new Set());

  const ctx: MergeCtx = {
    valueDirectives: new Map(),
    orderDirectives: new Map(),
    directivePaths: [],
    valueConflicts: [],
    orderConflicts: [],
  };
  for (const d of options.directives ?? []) {
    if (d.type === 'value') {
      const p = pathToString(d.path);
      ctx.valueDirectives.set(p, d.choice);
      ctx.directivePaths.push(p);
    } else if (d.type === 'order') {
      ctx.orderDirectives.set(orderKey(d.arrayPath, d.a, d.b), d.choice);
      ctx.directivePaths.push(pathToString(d.arrayPath));
    } else {
      throw new Error(`unknown directive type: ${(d as Directive).type}`);
    }
  }

  const merged = mergeNode(base, left, right, [], ctx);
  const result: MergeResult = {
    publishable: false,
    valueConflicts: ctx.valueConflicts,
    orderConflicts: ctx.orderConflicts,
    referenceIssues: [],
  };
  if (ctx.valueConflicts.length === 0 && ctx.orderConflicts.length === 0 && merged !== ABSENT) {
    result.candidate = merged;
    result.referenceIssues = checkReferences(merged);
    if (result.referenceIssues.length === 0) {
      result.publishable = true;
      result.snapshot = merged;
    }
  }
  return result;
}

function orderKey(arrayPath: Path, a: string, b: string): string {
  const [x, y] = a < b ? [a, b] : [b, a];
  return `${pathToString(arrayPath)} ${JSON.stringify([x, y])}`;
}

function pickSide(choice: Side, b: MaybeNode, l: MaybeNode, r: MaybeNode): MaybeNode {
  const v = choice === 'base' ? b : choice === 'left' ? l : r;
  return v === ABSENT ? ABSENT : structuredClone(v);
}

/** 当前路径的子树内（不含自身）是否存在指令；有则不能走整体快速返回，必须逐层递归。 */
function hasDirectiveBelow(ctx: MergeCtx, pathStr: string): boolean {
  const prefix = pathStr === '/' ? '/' : `${pathStr}/`;
  return ctx.directivePaths.some((p) => p.startsWith(prefix));
}

function mergeNode(b: MaybeNode, l: MaybeNode, r: MaybeNode, path: Path, ctx: MergeCtx): MaybeNode {
  const pathStr = pathToString(path);
  const directive = ctx.valueDirectives.get(pathStr);
  if (directive !== undefined) return pickSide(directive, b, l, r);

  // 子树内有指令时不能整体快速返回，需递归让深层指令生效
  const below = hasDirectiveBelow(ctx, pathStr);
  if (!below) {
    if (deepEqual(l, r)) return l; // 两侧一致（含都删除、改成相同值）
    if (deepEqual(b, l)) return r; // 仅右侧改动
    if (deepEqual(b, r)) return l; // 仅左侧改动
  }

  const lIsObj = l !== ABSENT && isObjectNode(l);
  const rIsObj = r !== ABSENT && isObjectNode(r);
  const bIsObj = b !== ABSENT && isObjectNode(b);
  if (lIsObj && rIsObj && (b === ABSENT || bIsObj || below)) {
    return mergeObject(bIsObj ? (b as ObjectNode) : {}, l as ObjectNode, r as ObjectNode, path, ctx);
  }
  const lIsArr = l !== ABSENT && isArrayNode(l);
  const rIsArr = r !== ABSENT && isArrayNode(r);
  const bIsArr = b !== ABSENT && isArrayNode(b);
  if (lIsArr && rIsArr && (b === ABSENT || bIsArr || below)) {
    return mergeArray(bIsArr ? (b as ArrayNode) : { $array: [] }, l as ArrayNode, r as ArrayNode, path, ctx);
  }
  if (below) {
    // 指令在此不可达（两侧非同种容器），退回无指令快速路径
    if (deepEqual(l, r)) return l;
    if (deepEqual(b, l)) return r;
    if (deepEqual(b, r)) return l;
  }

  const reason =
    l === ABSENT || r === ABSENT ? 'delete-modified' : b === ABSENT ? 'added-differently' : 'both-modified';
  ctx.valueConflicts.push({ type: 'value', reason, path: pathToString(path), base: b, left: l, right: r });
  return ABSENT;
}

function getOwn(obj: ObjectNode, key: string): MaybeNode {
  return Object.prototype.hasOwnProperty.call(obj, key) ? obj[key] : ABSENT;
}

function mergeObject(
  b: ObjectNode,
  l: ObjectNode,
  r: ObjectNode,
  path: Path,
  ctx: MergeCtx,
): ObjectNode {
  const keys = new Set<string>([...Object.keys(b), ...Object.keys(l), ...Object.keys(r)]);
  const out: ObjectNode = {};
  // 按键名字典序遍历，保证结果与输入的键遍历次序无关
  for (const key of [...keys].sort()) {
    const v = mergeNode(getOwn(b, key), getOwn(l, key), getOwn(r, key), [...path, key], ctx);
    if (v !== ABSENT) out[key] = v;
  }
  return out;
}

function elementMap(node: ArrayNode): Map<string, ConfigNode> {
  const m = new Map<string, ConfigNode>();
  for (const el of node.$array) m.set(el.id, el.value);
  return m;
}

function mergeArray(
  b: ArrayNode,
  l: ArrayNode,
  r: ArrayNode,
  path: Path,
  ctx: MergeCtx,
): MaybeNode {
  const bMap = elementMap(b);
  const lMap = elementMap(l);
  const rMap = elementMap(r);
  const ids = [...new Set([...bMap.keys(), ...lMap.keys(), ...rMap.keys()])].sort();

  // 内容合并：按元素 ID 对齐后递归三路合并（增删即“该侧 ABSENT”）
  const values = new Map<string, ConfigNode>();
  const conflictsBefore = ctx.valueConflicts.length;
  for (const id of ids) {
    const bv = bMap.has(id) ? bMap.get(id)! : ABSENT;
    const lv = lMap.has(id) ? lMap.get(id)! : ABSENT;
    const rv = rMap.has(id) ? rMap.get(id)! : ABSENT;
    const v = mergeNode(bv, lv, rv, [...path, { id }], ctx);
    if (v !== ABSENT) values.set(id, v);
  }
  // 数组内部有内容冲突时不再合成顺序，等调用方取舍后重算
  if (ctx.valueConflicts.length !== conflictsBefore) return ABSENT;

  const survivors = ids.filter((id) => values.has(id));
  const order = computeOrder([...bMap.keys()], [...lMap.keys()], [...rMap.keys()], survivors, path, ctx);
  if (order.conflict) {
    ctx.orderConflicts.push(order.conflict);
    return ABSENT;
  }
  return { $array: order.order!.map((id) => ({ id, value: values.get(id)! })) };
}

type Rel = [string, string];

function positionMap(ids: string[]): Map<string, number> {
  const m = new Map<string, number>();
  ids.forEach((id, i) => m.set(id, i));
  return m;
}

function relationOf(pos: Map<string, number>, x: string, y: string): Rel | null {
  const px = pos.get(x);
  const py = pos.get(y);
  if (px === undefined || py === undefined) return null;
  return px < py ? [x, y] : [y, x];
}

function sameRelation(p: Rel | null, q: Rel | null): boolean {
  if (p === null || q === null) return p === q;
  return p[0] === q[0] && p[1] === q[1];
}

/**
 * 顺序合并：对幸存元素的每一对 {a, b} 合成一条先后关系——
 * 双方都未改动保留基线顺序；单侧改动采用改动侧；新增元素采用各自快照中的相对位置；
 * 双方改动不一致时两条关系都进入约束图（必然成环并被报告）。
 * 所有关系成环时返回具体环与每条关系的来源；无环时按元素 ID 决胜做确定性拓扑排序。
 */
function computeOrder(
  baseIds: string[],
  leftIds: string[],
  rightIds: string[],
  survivors: string[],
  path: Path,
  ctx: MergeCtx,
): { order?: string[]; conflict?: OrderConflict } {
  const posB = positionMap(baseIds);
  const posL = positionMap(leftIds);
  const posR = positionMap(rightIds);
  const relations: OrderRelation[] = [];
  const conflictingPairs: ConflictingPair[] = [];
  const sorted = [...survivors].sort();

  for (let i = 0; i < sorted.length; i++) {
    for (let j = i + 1; j < sorted.length; j++) {
      const a = sorted[i];
      const b = sorted[j];
      const choice = ctx.orderDirectives.get(orderKey(path, a, b));
      if (choice !== undefined) {
        const rel = relationOf(choice === 'base' ? posB : choice === 'left' ? posL : posR, a, b);
        if (rel) relations.push({ before: rel[0], after: rel[1], origin: 'directive', choice });
        continue;
      }
      const rB = relationOf(posB, a, b);
      const rL = relationOf(posL, a, b);
      const rR = relationOf(posR, a, b);
      if (sameRelation(rL, rR)) {
        if (rL) {
          relations.push({ before: rL[0], after: rL[1], origin: sameRelation(rL, rB) ? 'base' : 'both' });
        }
      } else if (sameRelation(rL, rB)) {
        if (rR) relations.push({ before: rR[0], after: rR[1], origin: 'right' });
      } else if (sameRelation(rR, rB)) {
        if (rL) relations.push({ before: rL[0], after: rL[1], origin: 'left' });
      } else {
        conflictingPairs.push({ a, b, base: rB, left: rL, right: rR });
        if (rL) relations.push({ before: rL[0], after: rL[1], origin: 'left' });
        if (rR) relations.push({ before: rR[0], after: rR[1], origin: 'right' });
      }
    }
  }

  const edges: GraphEdge<OrderRelation>[] = relations.map((rel) => ({
    from: rel.before,
    to: rel.after,
    payload: rel,
  }));
  const cycles = findCycles(sorted, edges);
  if (cycles.length > 0) {
    return {
      conflict: {
        type: 'order',
        arrayPath: pathToString(path),
        cycles: cycles.map((c) => ({ elements: c.elements, relations: c.edges.map((e) => e.payload) })),
        conflictingPairs,
      },
    };
  }
  return { order: topoSort(sorted, relations.map((rel) => ({ from: rel.before, to: rel.after }))) };
}
