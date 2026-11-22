/**
 * 配置数据模型。
 *
 * 配置节点（ConfigNode）由以下四类构成：
 *  - 标量：string | number | boolean | null
 *  - 对象：{ [key: string]: ConfigNode }（键无序，遍历次序不影响语义）
 *  - 有序数组：{ $array: [{ id, value }] }，每个元素带稳定 ID，顺序有语义
 *  - 引用：{ $ref: "<element id>" }，按 ID 指向某个数组元素节点
 *
 * `$ref` / `$array` 为保留键；元素 ID 在整棵快照中全局唯一（校验时强制）。
 */

export type Scalar = string | number | boolean | null;

export interface RefNode {
  $ref: string;
}

export interface ArrayElement {
  id: string;
  value: ConfigNode;
}

export interface ArrayNode {
  $array: ArrayElement[];
}

export type ObjectNode = { [key: string]: ConfigNode };

export type ConfigNode = Scalar | RefNode | ArrayNode | ObjectNode;

/** 三路合并中表示“该侧不存在此节点”的哨兵值（用于删除语义与冲突报告）。 */
export const ABSENT = Symbol('absent');
export type MaybeNode = ConfigNode | typeof ABSENT;

/** 稳定 ID 路径：对象键用字符串段，数组元素用 { id } 段。 */
export type PathSeg = string | { id: string };
export type Path = PathSeg[];

export function pathToString(path: Path): string {
  if (path.length === 0) return '/';
  return '/' + path.map((s) => (typeof s === 'string' ? s : `[${s.id}]`)).join('/');
}

export function isRefNode(node: ConfigNode): node is RefNode {
  return (
    typeof node === 'object' &&
    node !== null &&
    !Array.isArray(node) &&
    Object.prototype.hasOwnProperty.call(node, '$ref')
  );
}

export function isArrayNode(node: ConfigNode): node is ArrayNode {
  return (
    typeof node === 'object' &&
    node !== null &&
    !Array.isArray(node) &&
    Object.prototype.hasOwnProperty.call(node, '$array')
  );
}

export function isObjectNode(node: ConfigNode): node is ObjectNode {
  return (
    typeof node === 'object' &&
    node !== null &&
    !Array.isArray(node) &&
    !isRefNode(node) &&
    !isArrayNode(node)
  );
}

/**
 * 校验快照结构合法性。畸形输入（原生数组、非字符串 $ref、重复元素 ID 等）
 * 抛出带路径的明确错误，而不是在合并中途崩溃。
 * elementIds 由调用方提供，用于强制元素 ID 全局唯一。
 */
export function validateConfig(node: unknown, path: string, elementIds: Set<string>): void {
  if (node === null) return;
  const t = typeof node;
  if (t === 'string' || t === 'boolean') return;
  if (t === 'number') {
    if (!Number.isFinite(node)) {
      throw new Error(`Invalid config node at ${path}: non-finite number`);
    }
    return;
  }
  if (t !== 'object' || Array.isArray(node)) {
    throw new Error(
      `Invalid config node at ${path}: raw arrays and ${t} values are not supported; use { $array: [...] } for arrays`,
    );
  }
  const obj = node as Record<string, unknown>;
  const keys = Object.keys(obj);
  if (keys.includes('$ref')) {
    if (keys.length !== 1 || typeof obj.$ref !== 'string') {
      throw new Error(`Invalid $ref at ${path}: expected { $ref: "<element id>" }`);
    }
    return;
  }
  if (keys.includes('$array')) {
    if (keys.length !== 1 || !Array.isArray(obj.$array)) {
      throw new Error(`Invalid $array at ${path}: expected { $array: [{ id, value }] }`);
    }
    const local = new Set<string>();
    for (const el of obj.$array as unknown[]) {
      const e = el as { id?: unknown; value?: unknown };
      if (
        typeof e !== 'object' ||
        e === null ||
        typeof e.id !== 'string' ||
        !Object.prototype.hasOwnProperty.call(e, 'value')
      ) {
        throw new Error(`Invalid array element at ${path}: expected { id: string, value: node }`);
      }
      if (local.has(e.id)) {
        throw new Error(`Invalid config: duplicate element id '${e.id}' in array at ${path}`);
      }
      local.add(e.id);
      if (elementIds.has(e.id)) {
        throw new Error(
          `Invalid config: element id '${e.id}' at ${path}/[${e.id}] is not globally unique`,
        );
      }
      elementIds.add(e.id);
      validateConfig(e.value, `${path}/[${e.id}]`, elementIds);
    }
    return;
  }
  for (const key of keys) {
    if (key.startsWith('$')) {
      throw new Error(`Invalid config node at ${path}: reserved key '${key}'`);
    }
    validateConfig(obj[key], `${path}/${key}`, elementIds);
  }
}

/** 结构相等：对象键次序无关，数组元素顺序与 ID 有关。 */
export function deepEqual(a: MaybeNode, b: MaybeNode): boolean {
  if (a === ABSENT || b === ABSENT) return a === b;
  if (a === null || b === null) return a === b;
  if (typeof a !== 'object' || typeof b !== 'object') return a === b;
  const aRef = isRefNode(a);
  const bRef = isRefNode(b);
  if (aRef || bRef) return aRef && bRef && a.$ref === (b as RefNode).$ref;
  const aArr = isArrayNode(a);
  const bArr = isArrayNode(b);
  if (aArr || bArr) {
    if (!aArr || !bArr) return false;
    const ae = a.$array;
    const be = (b as ArrayNode).$array;
    if (ae.length !== be.length) return false;
    for (let i = 0; i < ae.length; i++) {
      if (ae[i].id !== be[i].id || !deepEqual(ae[i].value, be[i].value)) return false;
    }
    return true;
  }
  const aKeys = Object.keys(a);
  const bKeys = Object.keys(b);
  if (aKeys.length !== bKeys.length) return false;
  for (const key of aKeys) {
    if (!Object.prototype.hasOwnProperty.call(b, key)) return false;
    if (!deepEqual((a as ObjectNode)[key], (b as ObjectNode)[key])) return false;
  }
  return true;
}
