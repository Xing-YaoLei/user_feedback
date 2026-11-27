import { ResourceLimitError } from './errors.ts';
import { encodeToken, parseLocalRef } from './pointer.ts';
import type {
  CompiledNode,
  CompiledSchema,
  JsonSchemaTypeName,
  LoadResult,
  RawSchema,
  RawSchemaObject,
  SchemaLoadError,
} from './types.ts';

/** 加载阶段允许的 Schema 嵌套深度，防止恶意深嵌套 Schema 直接撑爆调用栈。 */
const MAX_SCHEMA_DEPTH = 500;

const VALID_TYPES: ReadonlySet<string> = new Set([
  'null',
  'boolean',
  'object',
  'array',
  'string',
  'number',
  'integer',
]);

const RECOGNIZED_KEYWORDS = [
  'type',
  'properties',
  'required',
  'items',
  '$defs',
  '$ref',
  'allOf',
  'anyOf',
  'oneOf',
  'unevaluatedProperties',
] as const;

/**
 * 加载并编译一份 Schema。
 * 加载失败（结构非法、远程/悬空引用、纯原地引用循环）时返回 ok:false，
 * 不抛异常；资源类问题（Schema 嵌套过深）以 ResourceLimitError 抛出，
 * 与内容性错误区分。
 */
export function loadSchema(raw: unknown): LoadResult {
  const errors: SchemaLoadError[] = [];
  const nodesByPointer = new Map<string, CompiledNode>();
  /** 布尔 Schema 节点同样登记，供 $ref 解析查找。 */
  const boolNodes = new Map<string, boolean>();
  /** 待解析的 $ref：节点 pointer -> 原始 $ref 字符串。 */
  const pendingRefs = new Map<string, string>();

  const root = compileNode(raw, '');

  if (errors.length > 0) {
    return { ok: false, errors };
  }

  // 第二遍：解析所有本地 $ref。
  for (const [pointer, ref] of pendingRefs) {
    const targetPointer = parseLocalRef(ref);
    if (targetPointer === null) {
      errors.push({
        schemaPath: pointer,
        message: `$ref 仅支持当前文档内的本地 JSON Pointer 引用，收到: ${ref}`,
      });
      continue;
    }
    const target = nodesByPointer.get(targetPointer);
    if (target === undefined) {
      // 目标可能是布尔 Schema（布尔 Schema 不产生 CompiledNode，
      // 单独登记在 boolNodes 中）。
      const boolTarget = boolNodes.get(targetPointer);
      if (boolTarget === undefined) {
        errors.push({
          schemaPath: pointer,
          message: `$ref 指向不存在的位置: ${ref}`,
        });
        continue;
      }
      attachRef(pointer, boolTarget, ref);
      continue;
    }
    attachRef(pointer, target, ref);
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }

  // 第三遍：拒绝不消耗实例层级的引用循环（纯“原地”边构成的环）。
  detectInPlaceCycles();

  if (errors.length > 0) {
    return { ok: false, errors };
  }

  return { ok: true, schema: { root } };

  function attachRef(pointer: string, target: CompiledSchema, ref: string): void {
    const node = nodesByPointer.get(pointer);
    if (node) {
      node.refTarget = target;
      node.refPointer = ref;
    }
  }

  function compileNode(node: unknown, pointer: string, depth = 0): CompiledSchema {
    if (depth > MAX_SCHEMA_DEPTH) {
      throw new ResourceLimitError(
        'max-depth',
        '',
        MAX_SCHEMA_DEPTH,
        `Schema 嵌套深度超过限制 ${MAX_SCHEMA_DEPTH}`,
      );
    }

    if (typeof node === 'boolean') {
      boolNodes.set(pointer, node);
      return node;
    }
    if (node === null || typeof node !== 'object' || Array.isArray(node)) {
      errors.push({
        schemaPath: pointer,
        message: 'Schema 必须是布尔值或关键字对象',
      });
      return {};
    }

    const rawObj = node as RawSchemaObject;
    const compiled: CompiledNode = { pointer };
    nodesByPointer.set(pointer, compiled);

    for (const key of Object.keys(rawObj)) {
      if (!(RECOGNIZED_KEYWORDS as readonly string[]).includes(key)) {
        // 子集外的注解类关键字（title、description 等）直接忽略。
        continue;
      }
      const value = rawObj[key];
      switch (key) {
        case 'type': {
          const list = Array.isArray(value) ? value : [value];
          if (list.length === 0 || !list.every((t) => typeof t === 'string' && VALID_TYPES.has(t))) {
            errors.push({
              schemaPath: pointer,
              message: `type 必须是合法类型名或其非空数组，收到: ${JSON.stringify(value)}`,
            });
          } else {
            compiled.type = list as JsonSchemaTypeName[];
          }
          break;
        }
        case 'properties': {
          if (value === null || typeof value !== 'object' || Array.isArray(value)) {
            errors.push({ schemaPath: pointer, message: 'properties 必须是对象' });
            break;
          }
          const map = new Map<string, CompiledSchema>();
          for (const propName of Object.keys(value as Record<string, RawSchema>)) {
            map.set(
              propName,
              compileNode(
                (value as Record<string, RawSchema>)[propName],
                `${pointer}/properties/${encodeToken(propName)}`,
                depth + 1,
              ),
            );
          }
          compiled.properties = map;
          break;
        }
        case 'required': {
          if (!Array.isArray(value) || !value.every((v) => typeof v === 'string')) {
            errors.push({ schemaPath: pointer, message: 'required 必须是字符串数组' });
            break;
          }
          if (new Set(value).size !== value.length) {
            errors.push({ schemaPath: pointer, message: 'required 中存在重复字段名' });
          }
          compiled.required = [...value];
          break;
        }
        case 'items': {
          compiled.items = compileNode(value, `${pointer}/items`, depth + 1);
          break;
        }
        case '$defs': {
          if (value === null || typeof value !== 'object' || Array.isArray(value)) {
            errors.push({ schemaPath: pointer, message: '$defs 必须是对象' });
            break;
          }
          for (const defName of Object.keys(value as Record<string, RawSchema>)) {
            compileNode(
              (value as Record<string, RawSchema>)[defName],
              `${pointer}/$defs/${encodeToken(defName)}`,
              depth + 1,
            );
          }
          break;
        }
        case '$ref': {
          if (typeof value !== 'string') {
            errors.push({ schemaPath: pointer, message: '$ref 必须是字符串' });
          } else {
            pendingRefs.set(pointer, value);
          }
          break;
        }
        case 'allOf':
        case 'anyOf':
        case 'oneOf': {
          if (!Array.isArray(value)) {
            errors.push({ schemaPath: pointer, message: `${key} 必须是 Schema 数组` });
            break;
          }
          const list: CompiledSchema[] = value.map((sub, i) =>
            compileNode(sub, `${pointer}/${key}/${i}`, depth + 1),
          );
          if (key === 'allOf') compiled.allOf = list;
          else if (key === 'anyOf') compiled.anyOf = list;
          else compiled.oneOf = list;
          break;
        }
        case 'unevaluatedProperties': {
          compiled.unevaluatedProperties = compileNode(
            value,
            `${pointer}/unevaluatedProperties`,
            depth + 1,
          );
          break;
        }
      }
    }

    return compiled;
  }

  /**
   * 纯原地边（in-place edge）：$ref、allOf/anyOf/oneOf 的成员。
   * 这类边不向下进入新的实例位置；若它们构成环，求值无法借助实例层级
   * 收敛而必然无限递归，必须在加载阶段拒绝。
   * 下降边（properties 的值、items、unevaluatedProperties 的值）配合
   * 有限实例深度天然收敛，即使引用递归结构也合法。
   */
  function inPlaceNeighbors(node: CompiledNode): CompiledSchema[] {
    const out: CompiledSchema[] = [];
    if (node.refTarget !== undefined) out.push(node.refTarget);
    for (const list of [node.allOf, node.anyOf, node.oneOf]) {
      if (list) out.push(...list);
    }
    return out;
  }

  /** 全部邻接边（原地边 + 下降边），用于计算根可达子图。 */
  function allNeighbors(node: CompiledNode): CompiledSchema[] {
    const out = inPlaceNeighbors(node);
    if (node.properties) out.push(...node.properties.values());
    if (node.items !== undefined) out.push(node.items);
    if (node.unevaluatedProperties !== undefined) out.push(node.unevaluatedProperties);
    return out;
  }

  function detectInPlaceCycles(): void {
    // 第一步：从根出发沿所有边标记可达节点。不可达的 $defs（从未被引用）
    // 不参与任何求值，即使内部含环也不应导致整份 Schema 被拒绝。
    const reachable = new Set<string>();
    const walkReachable = (schema: CompiledSchema): void => {
      if (typeof schema === 'boolean') return;
      if (reachable.has(schema.pointer)) return;
      reachable.add(schema.pointer);
      for (const neighbor of allNeighbors(schema)) {
        walkReachable(neighbor);
      }
    };
    walkReachable(root);

    // 第二步：仅在可达子图上沿原地边做 DFS 三色标记。
    // 0=未访问 1=在当前 DFS 栈中 2=已完成
    const state = new Map<string, 0 | 1 | 2>();
    for (const pointer of reachable) state.set(pointer, 0);

    const visit = (schema: CompiledSchema, via: string): void => {
      if (typeof schema === 'boolean') return;
      const mark = state.get(schema.pointer) ?? 0;
      if (mark === 1) {
        errors.push({
          schemaPath: via,
          message:
            '检测到不消耗实例层级的引用循环（$ref/allOf/anyOf/oneOf 构成的纯原地环），加载时拒绝',
        });
        return;
      }
      if (mark === 2) return;
      state.set(schema.pointer, 1);
      for (const neighbor of inPlaceNeighbors(schema)) {
        visit(neighbor, schema.pointer);
      }
      state.set(schema.pointer, 2);
    };

    for (const pointer of reachable) {
      if ((state.get(pointer) ?? 0) === 0) {
        visit(nodesByPointer.get(pointer)!, pointer);
      }
    }
  }
}
