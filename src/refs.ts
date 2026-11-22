import {
  isArrayNode,
  isObjectNode,
  isRefNode,
  pathToString,
  type ConfigNode,
  type Path,
} from './model.ts';
import { findCycles, type GraphEdge } from './graph.ts';

/** 引用约束问题。合并不自动修复，定位后保持待解决状态，由调用方取舍后重新计算。 */
export type ReferenceIssue =
  | { type: 'dangling-reference'; refPath: string; targetId: string }
  | {
      type: 'reference-cycle';
      /** 环上的元素 ID 序列，首尾相同。 */
      elements: string[];
      /** 构成环的引用边及其所在路径。 */
      edges: { from: string; to: string; refPath: string }[];
    };

/**
 * 对合并候选做引用完整性检查：
 *  - 悬空引用：$ref 指向的元素 ID 在候选中不存在；
 *  - 引用环：沿“元素的子树中包含指向另一元素的引用”构成的图上存在环
 *    （嵌套元素会向其所有祖先元素传递引用边，自引用视为长度为 1 的环）。
 */
export function checkReferences(root: ConfigNode): ReferenceIssue[] {
  const idIndex = new Map<string, string>();
  collectIds(root, [], idIndex);
  const issues: ReferenceIssue[] = [];
  const edges: GraphEdge<{ refPath: string }>[] = [];
  walkRefs(root, [], [], idIndex, issues, edges);
  for (const cycle of findCycles(idIndex.keys(), edges)) {
    issues.push({
      type: 'reference-cycle',
      elements: cycle.elements,
      edges: cycle.edges.map((e) => ({ from: e.from, to: e.to, refPath: e.payload.refPath })),
    });
  }
  return issues;
}

function collectIds(node: ConfigNode, path: Path, index: Map<string, string>): void {
  if (isArrayNode(node)) {
    for (const el of node.$array) {
      index.set(el.id, pathToString([...path, { id: el.id }]));
      collectIds(el.value, [...path, { id: el.id }], index);
    }
    return;
  }
  if (isObjectNode(node)) {
    for (const key of Object.keys(node).sort()) {
      collectIds(node[key], [...path, key], index);
    }
  }
}

function walkRefs(
  node: ConfigNode,
  path: Path,
  ancestors: string[],
  idIndex: Map<string, string>,
  issues: ReferenceIssue[],
  edges: GraphEdge<{ refPath: string }>[],
): void {
  if (isRefNode(node)) {
    const refPath = pathToString(path);
    if (!idIndex.has(node.$ref)) {
      issues.push({ type: 'dangling-reference', refPath, targetId: node.$ref });
    } else {
      for (const from of ancestors) {
        edges.push({ from, to: node.$ref, payload: { refPath } });
      }
    }
    return;
  }
  if (isArrayNode(node)) {
    for (const el of node.$array) {
      walkRefs(el.value, [...path, { id: el.id }], [...ancestors, el.id], idIndex, issues, edges);
    }
    return;
  }
  if (isObjectNode(node)) {
    for (const key of Object.keys(node).sort()) {
      walkRefs(node[key], [...path, key], ancestors, idIndex, issues, edges);
    }
  }
}
