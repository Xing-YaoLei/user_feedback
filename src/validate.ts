import { I32_MAX, I32_MIN, I64_MAX, I64_MIN } from './types.ts';
import type { Schema, Type, WireValue } from './types.ts';
import { SchemaValidationError } from './errors.ts';

/**
 * Result of validating a schema:
 *  - `samples` maps every named type (and the root) to a finite, encodable
 *    value that inhabits the type. The least-fixpoint computation also proves
 *    that the type can represent at least one finite value.
 */
export interface ValidatedSchema {
  schema: Schema;
  samples: Map<string, WireValue>;
  rootSample: WireValue;
}

const LEAF_KINDS = new Set(['bool', 'string', 'i32', 'i64', 'f64']);

export function isLeaf(kind: Type['kind']): boolean {
  return LEAF_KINDS.has(kind);
}

export function validateSchema(schema: Schema): ValidatedSchema {
  if (schema === null || typeof schema !== 'object') {
    throw new SchemaValidationError('schema must be an object');
  }
  if (typeof schema.version !== 'string' || schema.version.length === 0) {
    throw new SchemaValidationError('schema.version must be a non-empty string');
  }
  if (schema.types === null || typeof schema.types !== 'object' || Array.isArray(schema.types)) {
    throw new SchemaValidationError('schema.types must be a named type table object');
  }
  if (schema.root === null || typeof schema.root !== 'object') {
    throw new SchemaValidationError('schema.root must be a type node');
  }

  const typeNames = Object.keys(schema.types);
  for (const name of typeNames) {
    // Type table keys are user supplied strings; validate the node.
    validateNode(schema, schema.types[name], `types.${name}`);
  }
  validateNode(schema, schema.root, 'root');

  // Least-fixpoint computation of finite inhabitants.
  const { samples, rootSample } = computeFiniteSamples(schema);
  return { schema, samples, rootSample };
}

function validateNode(schema: Schema, t: unknown, where: string): void {
  if (t === null || typeof t !== 'object' || Array.isArray(t)) {
    throw new SchemaValidationError(`${where}: type node must be an object`);
  }
  const node = t as Type;
  switch (node.kind) {
    case 'bool':
    case 'string':
    case 'i32':
    case 'i64':
    case 'f64':
      return;
    case 'array':
      if (!node.items || typeof node.items !== 'object') {
        throw new SchemaValidationError(`${where}: array type needs an items type`);
      }
      validateNode(schema, node.items, `${where}.items`);
      return;
    case 'ref':
      if (typeof node.name !== 'string' || node.name.length === 0) {
        throw new SchemaValidationError(`${where}: ref name must be a non-empty string`);
      }
      if (!Object.prototype.hasOwnProperty.call(schema.types, node.name)) {
        throw new SchemaValidationError(
          `${where}: ref '${node.name}' does not resolve to any named type`,
        );
      }
      return;
    case 'record': {
      if (!Array.isArray(node.fields)) {
        throw new SchemaValidationError(`${where}: record fields must be an array`);
      }
      const seenIds = new Set<number>();
      const seenNames = new Set<string>();
      for (const [i, field] of node.fields.entries()) {
        const fw = `${where}.fields[${i}]`;
        if (!Number.isInteger(field.id) || field.id <= 0) {
          throw new SchemaValidationError(`${fw}: field id must be a positive integer`);
        }
        if (seenIds.has(field.id)) {
          throw new SchemaValidationError(`${fw}: duplicate field id ${field.id}`);
        }
        seenIds.add(field.id);
        if (typeof field.name !== 'string' || field.name.length === 0) {
          throw new SchemaValidationError(`${fw}: field name must be a non-empty string`);
        }
        if (seenNames.has(field.name)) {
          throw new SchemaValidationError(`${fw}: duplicate field name '${field.name}'`);
        }
        seenNames.add(field.name);
        validateNode(schema, field.type, `${fw}.type`);
        if (field.hasDefault) {
          validateValue(schema, field.type, field.default, `${fw}.default`);
        }
      }
      return;
    }
    case 'union': {
      if (!Array.isArray(node.branches) || node.branches.length === 0) {
        throw new SchemaValidationError(`${where}: union must have at least one branch`);
      }
      const seenTags = new Set<string>();
      for (const [i, branch] of node.branches.entries()) {
        const bw = `${where}.branches[${i}]`;
        if (typeof branch.tag !== 'string' || branch.tag.length === 0) {
          throw new SchemaValidationError(`${bw}: branch tag must be a non-empty string`);
        }
        if (seenTags.has(branch.tag)) {
          throw new SchemaValidationError(`${bw}: duplicate union tag '${branch.tag}'`);
        }
        seenTags.add(branch.tag);
        validateNode(schema, branch.type, `${bw}.type`);
      }
      return;
    }
    default:
      throw new SchemaValidationError(
        `${where}: unknown type kind '${(node as { kind?: unknown }).kind}'`,
      );
  }
}

/** Validate that a default value is a valid in-domain value of its type. */
function validateValue(
  schema: Schema,
  t: Type,
  v: unknown,
  where: string,
  seen: Set<string> = new Set(),
): void {
  switch (t.kind) {
    case 'bool':
      if (typeof v !== 'boolean') {
        throw new SchemaValidationError(`${where}: expected boolean default`);
      }
      return;
    case 'string':
      if (typeof v !== 'string') {
        throw new SchemaValidationError(`${where}: expected string default`);
      }
      return;
    case 'i32':
      if (typeof v !== 'number' || !Number.isInteger(v) || v < I32_MIN || v > I32_MAX) {
        throw new SchemaValidationError(`${where}: expected signed 32 bit integer default`);
      }
      return;
    case 'i64':
      if (typeof v !== 'bigint' || v < I64_MIN || v > I64_MAX) {
        throw new SchemaValidationError(
          `${where}: expected signed 64 bit bigint default`,
        );
      }
      return;
    case 'f64':
      if (typeof v !== 'number' || !Number.isFinite(v)) {
        throw new SchemaValidationError(`${where}: expected finite f64 default`);
      }
      return;
    case 'array':
      if (!Array.isArray(v)) {
        throw new SchemaValidationError(`${where}: expected array default`);
      }
      v.forEach((item, i) => validateValue(schema, t.items, item, `${where}[${i}]`, seen));
      return;
    case 'ref':
      if (seen.has(t.name)) {
        throw new SchemaValidationError(
          `${where}: default value cannot contain a recursive reference`,
        );
      }
      seen.add(t.name);
      validateValue(schema, schema.types[t.name], v, where, seen);
      seen.delete(t.name);
      return;
    case 'record': {
      if (v === null || typeof v !== 'object' || Array.isArray(v)) {
        throw new SchemaValidationError(`${where}: expected record default`);
      }
      const obj = v as Record<string, unknown>;
      for (const field of t.fields) {
        const key = String(field.id);
        if (Object.prototype.hasOwnProperty.call(obj, key)) {
          validateValue(schema, field.type, obj[key], `${where}.#${field.id}`, seen);
        } else if (!field.hasDefault) {
          throw new SchemaValidationError(
            `${where}: record default missing required field #${field.id}`,
          );
        }
      }
      return;
    }
    case 'union': {
      if (
        v === null ||
        typeof v !== 'object' ||
        typeof (v as { tag?: unknown }).tag !== 'string' ||
        !('value' in (v as object))
      ) {
        throw new SchemaValidationError(`${where}: union default must be { tag, value }`);
      }
      const envelope = v as { tag: string; value: unknown };
      const branch = t.branches.find((b) => b.tag === envelope.tag);
      if (!branch) {
        throw new SchemaValidationError(
          `${where}: union default uses unknown tag '${envelope.tag}'`,
        );
      }
      validateValue(schema, branch.type, envelope.value, `${where}<${envelope.tag}>`, seen);
      return;
    }
  }
}

/**
 * Compute a finite inhabitant for every named type and for the root via a
 * least-fixpoint iteration. Named types that never acquire an inhabitant
 * cannot represent any finite value and make the schema invalid (this also
 * rejects every unguarded recursive type, e.g. `A = ref A`).
 */
function computeFiniteSamples(schema: Schema): {
  samples: Map<string, WireValue>;
  rootSample: WireValue;
} {
  const samples = new Map<string, WireValue>();
  const names = Object.keys(schema.types);

  let changed = true;
  while (changed) {
    changed = false;
    for (const name of names) {
      if (samples.has(name)) continue;
      const built = tryBuild(schema, schema.types[name], samples, new Set());
      if (built !== undefined) {
        samples.set(name, built);
        changed = true;
      }
    }
  }

  for (const name of names) {
    if (!samples.has(name)) {
      throw new SchemaValidationError(
        `named type '${name}' cannot represent any finite value ` +
          '(unguarded recursion or a required field of an uninhabited type)',
      );
    }
  }

  const rootSample = tryBuild(schema, schema.root, samples, new Set());
  if (rootSample === undefined) {
    throw new SchemaValidationError('schema root cannot represent any finite value');
  }
  return { samples, rootSample };
}

/**
 * Try to construct one minimal finite value of `t` using already-known
 * inhabitants. Returns undefined when the type is not yet known inhabited.
 */
function tryBuild(
  schema: Schema,
  t: Type,
  known: Map<string, WireValue>,
  onStack: Set<string>,
): WireValue | undefined {
  switch (t.kind) {
    case 'bool':
      return false;
    case 'string':
      return '';
    case 'i32':
      return 0;
    case 'i64':
      return 0n;
    case 'f64':
      return 0;
    case 'array':
      // The empty array is always a finite inhabitant.
      return [];
    case 'ref':
      if (onStack.has(t.name)) return undefined;
      return known.get(t.name);
    case 'record': {
      const out: Record<string, WireValue> = {};
      for (const field of t.fields) {
        if (field.hasDefault) continue; // reader fills defaults; minimal value omits them
        const built = tryBuild(schema, field.type, known, onStack);
        if (built === undefined) return undefined;
        out[String(field.id)] = built;
      }
      return out;
    }
    case 'union': {
      for (const branch of t.branches) {
        const built = tryBuild(schema, branch.type, known, onStack);
        if (built !== undefined) return { tag: branch.tag, value: built };
      }
      return undefined;
    }
  }
}

export {
  F64_EXACT_INT_MAX,
  F64_EXACT_INT_MIN,
  I32_MAX,
  I32_MIN,
  I64_MAX,
  I64_MIN,
} from './types.ts';
