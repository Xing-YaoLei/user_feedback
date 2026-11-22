import type { Type, TypePath, WireValue } from './types.ts';
import { I32_MAX, I32_MIN, I64_MAX, I64_MIN } from './types.ts';
import type { ValidatedSchema } from './validate.ts';
import { isLeaf } from './validate.ts';
import { CompatChecker, numericLossless } from './compat.ts';
import { ParseError, renderPath } from './errors.ts';
import { isPlainRecord, isWireUnion } from './wire.ts';

// ---------------------------------------------------------------------------
// Declarative resolution plan (a reusable graph of recipe nodes)
// ---------------------------------------------------------------------------

export interface LeafNode {
  kind: 'leaf';
  from: Type['kind'];
  to: Type['kind'];
  path: TypePath;
  /** Static incompatibility: every value reaching this node fails. */
  trap?: { reason: string; path: TypePath };
}

export interface ArrayNode {
  kind: 'array';
  items: number;
}

export interface RecordFieldRecipe {
  name: string;
  node: number;
  hasDefault: boolean;
  defaultValue?: WireValue;
}

export interface RecordNode {
  kind: 'record';
  fields: Map<number, RecordFieldRecipe>;
}

export type UnionBranchRecipe =
  | { trap: false; node: number }
  | { trap: true; reason: string; path: TypePath };

export interface UnionNode {
  kind: 'union';
  branches: Map<string, UnionBranchRecipe>;
}

export interface DefaultNode {
  kind: 'default';
  value: WireValue;
}

export type RecipeNode = LeafNode | ArrayNode | RecordNode | UnionNode | DefaultNode;

export interface Plan {
  writerVersion: string;
  readerVersion: string;
  compatible: boolean;
  rootNode: number;
  nodes: RecipeNode[];
  convert(message: WireValue): WireValue;
}

interface BuildContext {
  checker: CompatChecker;
  nodes: RecipeNode[];
  memo: Map<Type, Map<Type, number>>;
  writer: ValidatedSchema;
  reader: ValidatedSchema;
}

/**
 * Build a reusable cross-version resolution plan from writer schema to reader
 * schema. When the pair is incompatible the plan is still produced in
 * "best effort" mode: incompatible positions become trap nodes that fail at
 * runtime with the same reason and type path produced by static analysis, so
 * a static counterexample reproduces its failure through the parsing entry.
 */
export function buildPlan(writer: ValidatedSchema, reader: ValidatedSchema): Plan {
  const checker = new CompatChecker(writer, reader);
  const rootOutcome = checker.checkRoot();
  const ctx: BuildContext = {
    checker,
    nodes: [],
    memo: new Map(),
    writer,
    reader,
  };
  const rootNode = buildRecipe(ctx, writer.schema.root, reader.schema.root, [
    { kind: 'root' },
  ]);
  const plan: Plan = {
    writerVersion: writer.schema.version,
    readerVersion: reader.schema.version,
    compatible: rootOutcome.ok,
    rootNode,
    nodes: ctx.nodes,
    convert(message: WireValue): WireValue {
      return convertNode(ctx.nodes, rootNode, message, [{ kind: 'root' }]);
    },
  };
  return plan;
}

function buildRecipe(
  ctx: BuildContext,
  w: Type,
  r: Type,
  path: TypePath,
): number {
  const cached = ctx.memo.get(w)?.get(r);
  if (cached !== undefined) return cached;

  // Reserve an id first so recursive structures can reference themselves.
  const nodeId = ctx.nodes.length;
  ctx.nodes.push({ kind: 'default', value: undefined as unknown as WireValue });
  remember(ctx, w, r, nodeId);

  const wResolved = w.kind === 'ref' ? ctx.writer.schema.types[w.name] : w;
  const rResolved = r.kind === 'ref' ? ctx.reader.schema.types[r.name] : r;
  let node: RecipeNode;

  if (isLeaf(wResolved.kind) || isLeaf(rResolved.kind)) {
    node = buildLeaf(ctx, wResolved, rResolved, path);
  } else if (wResolved.kind !== rResolved.kind) {
    node = {
      kind: 'leaf',
      from: wResolved.kind,
      to: rResolved.kind,
      path,
      trap: { reason: 'kind-mismatch', path },
    };
  } else if (wResolved.kind === 'array') {
    const wa = wResolved as Type & { kind: 'array' };
    const ra = rResolved as Type & { kind: 'array' };
    node = {
      kind: 'array',
      items: buildRecipe(ctx, wa.items, ra.items, [
        ...path,
        { kind: 'array-item', index: 0 },
      ]),
    };
  } else if (wResolved.kind === 'record') {
    node = buildRecord(ctx, wResolved, rResolved, path);
  } else {
    node = buildUnion(ctx, wResolved, rResolved, path);
  }

  ctx.nodes[nodeId] = node;
  return nodeId;
}

function remember(ctx: BuildContext, w: Type, r: Type, id: number): void {
  let inner = ctx.memo.get(w);
  if (!inner) {
    inner = new Map();
    ctx.memo.set(w, inner);
  }
  inner.set(r, id);
}

function buildLeaf(
  ctx: BuildContext,
  w: Type,
  r: Type,
  path: TypePath,
): LeafNode {
  const leafOk =
    isLeaf(w.kind) &&
    isLeaf(r.kind) &&
    (w.kind === r.kind || numericLossless(w.kind, r.kind));
  return {
    kind: 'leaf',
    from: w.kind,
    to: r.kind,
    path,
    trap: leafOk ? undefined : { reason: 'leaf-mismatch', path },
  };
}

function buildRecord(
  ctx: BuildContext,
  w: Type,
  r: Type,
  path: TypePath,
): RecordNode {
  const wt = w as Type & { kind: 'record' };
  const rt = r as Type & { kind: 'record' };
  const writerById = new Map(wt.fields.map((f) => [f.id, f]));
  const fields = new Map<number, RecordFieldRecipe>();

  for (const rf of rt.fields) {
    const fieldPath: TypePath = [
      ...path,
      { kind: 'field', id: rf.id, name: rf.name },
    ];
    const wf = writerById.get(rf.id);
    if (!wf || (wf.hasDefault && !rf.hasDefault)) {
      if (rf.hasDefault) {
        fields.set(rf.id, {
          name: rf.name,
          node: pushNode(ctx, { kind: 'default', value: rf.default as WireValue }),
          hasDefault: true,
          defaultValue: rf.default as WireValue,
        });
      } else {
        // Reader requires a field a legal writer message may omit (absent
        // entirely, or optional on the writer side): trap node whose static
        // reason/path match the compatibility analysis exactly.
        fields.set(rf.id, {
          name: rf.name,
          node: pushNode(ctx, {
            kind: 'leaf',
            from: 'string',
            to: 'string',
            path: fieldPath,
            trap: { reason: 'missing-required-field', path: fieldPath },
          }),
          hasDefault: false,
        });
      }
      continue;
    }
    fields.set(rf.id, {
      name: rf.name,
      node: buildRecipe(ctx, wf.type, rf.type, fieldPath),
      hasDefault: rf.hasDefault,
      defaultValue: rf.hasDefault ? (rf.default as WireValue) : undefined,
    });
  }
  return { kind: 'record', fields };
}

function buildUnion(
  ctx: BuildContext,
  w: Type,
  r: Type,
  path: TypePath,
): UnionNode {
  const wt = w as Type & { kind: 'union' };
  const rt = r as Type & { kind: 'union' };
  const readerByTag = new Map(rt.branches.map((b) => [b.tag, b]));
  const branches = new Map<string, UnionBranchRecipe>();

  for (const wb of wt.branches) {
    const branchPath: TypePath = [
      ...path,
      { kind: 'union-branch', tag: wb.tag },
    ];
    const rb = readerByTag.get(wb.tag);
    if (!rb) {
      branches.set(wb.tag, {
        trap: true,
        reason: 'unknown-union-tag',
        path: branchPath,
      });
    } else {
      branches.set(wb.tag, {
        trap: false,
        node: buildRecipe(ctx, wb.type, rb.type, branchPath),
      });
    }
  }
  return { kind: 'union', branches };
}

function pushNode(ctx: BuildContext, node: RecipeNode): number {
  const id = ctx.nodes.length;
  ctx.nodes.push(node);
  return id;
}

// ---------------------------------------------------------------------------
// Runtime conversion (same classification rules as the static analysis)
// ---------------------------------------------------------------------------

function convertNode(
  nodes: RecipeNode[],
  nodeId: number,
  value: WireValue,
  path: TypePath,
): WireValue {
  const node = nodes[nodeId];
  switch (node.kind) {
    case 'default':
      return node.value;
    case 'leaf':
      return convertLeaf(node, value, path);
    case 'array':
      return convertArray(nodes, node, value, path);
    case 'record':
      return convertRecord(nodes, node, value, path);
    case 'union':
      return convertUnion(nodes, node, value, path);
  }
}

function failParse(reason: string, path: TypePath, detail: string): never {
  throw new ParseError(`${detail} at ${renderPath(path)}`, reason, path);
}

function convertLeaf(node: LeafNode, value: WireValue, path: TypePath): WireValue {
  if (node.trap) {
    failParse(
      node.trap.reason,
      node.trap.path,
      `statically incompatible leaf ${node.from} -> ${node.to}`,
    );
  }
  switch (node.to) {
    case 'bool':
      if (typeof value !== 'boolean') {
        failParse('bad-bool', path, `expected boolean, got ${typeof value}`);
      }
      return value;
    case 'string':
      if (typeof value !== 'string') {
        failParse('bad-string', path, `expected string, got ${typeof value}`);
      }
      return value;
    case 'i32':
      if (typeof value !== 'number' || !Number.isInteger(value) || value < I32_MIN || value > I32_MAX) {
        failParse('bad-i32', path, 'value is not a signed 32 bit integer');
      }
      return value;
    case 'i64':
      // Same-version i64: bigint in, bigint out. The i32 -> i64 promotion
      // accepts an in-range signed 32 bit number and widens it exactly.
      if (typeof value === 'bigint') {
        if (value < I64_MIN || value > I64_MAX) {
          failParse('bad-i64', path, 'value is not an in-range signed 64 bit bigint');
        }
        return value;
      }
      if (node.from === 'i32') {
        if (typeof value !== 'number' || !Number.isInteger(value) || value < I32_MIN || value > I32_MAX) {
          failParse('bad-i32', path, 'i32 value promoted to i64 is not a signed 32 bit integer');
        }
        return BigInt(value);
      }
      failParse('bad-i64', path, 'value is not an in-range signed 64 bit bigint');
    case 'f64': {
      // i32 -> f64 and f64 -> f64: every such wire value is a finite number.
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        failParse('bad-f64', path, 'value is not a finite f64');
      }
      return value;
    }
    default:
      failParse('internal', path, `not a leaf target: ${node.to}`);
  }
}

function convertArray(
  nodes: RecipeNode[],
  node: ArrayNode,
  value: WireValue,
  path: TypePath,
): WireValue {
  if (!Array.isArray(value)) {
    failParse('bad-array', path, `expected array, got ${typeof value}`);
  }
  return value.map((item, index) =>
    convertNode(nodes, node.items, item, [
      ...path,
      { kind: 'array-item', index },
    ]),
  );
}

function convertRecord(
  nodes: RecipeNode[],
  node: RecordNode,
  value: WireValue,
  path: TypePath,
): WireValue {
  if (!isPlainRecord(value)) {
    failParse('bad-record', path, 'expected a record object keyed by field id');
  }
  const out: Record<string, WireValue> = {};
  for (const [idText, recipe] of node.fields) {
    const key = String(idText);
    const fieldPath: TypePath = [
      ...path,
      { kind: 'field', id: Number(idText), name: recipe.name },
    ];
    if (Object.prototype.hasOwnProperty.call(value, key)) {
      const converted = convertNode(nodes, recipe.node, value[key], fieldPath);
      out[key] = converted;
    } else if (recipe.hasDefault) {
      out[key] = recipe.defaultValue as WireValue;
    } else {
      failParse(
        'missing-required-field',
        fieldPath,
        `missing required field #${idText} ('${recipe.name}')`,
      );
    }
  }
  // Unknown writer field ids are intentionally ignored by the reader.
  return out;
}

function convertUnion(
  nodes: RecipeNode[],
  node: UnionNode,
  value: WireValue,
  path: TypePath,
): WireValue {
  if (!isWireUnion(value)) {
    failParse('bad-union', path, 'expected a { tag, value } union envelope');
  }
  const branchPath: TypePath = [...path, { kind: 'union-branch', tag: value.tag }];
  const recipe = node.branches.get(value.tag);
  if (!recipe || recipe.trap) {
    failParse(
      'unknown-union-tag',
      branchPath,
      `union tag '${value.tag}' has no readable branch`,
    );
  }
  return {
    tag: value.tag,
    value: convertNode(nodes, recipe.node, value.value, branchPath),
  };
}
