/**
 * Expression evaluation.
 *
 * Expressions are pure functions of the request context and of other
 * configuration paths. Evaluation is lazy: `$if`, `$and`, `$or` and
 * `$coalesce` evaluate only the operands they need, so an unreachable branch
 * contributes no dependencies and is never cycle-checked.
 *
 * Every dependency touched is reported through the supplied `Collector`, which
 * is what makes dependency-driven cache invalidation possible upstream.
 */

import type { Expr, LiteralValue, RefHop } from './types.ts';
import type { Collector, EvalEnvironment, EvalResult, InternalError } from './internal.ts';
import {
  QuantityError,
  addQuantities,
  compareQuantities,
  divQuantities,
  equalQuantities,
  makeQuantity,
  mulQuantities,
  quantityFromValue,
  quantityToValue,
  subQuantities,
} from './quantity.ts';
import type { Quantity } from './quantity.ts';
import {
  canonicalLiteral,
  isDeletion,
  literalTypeName,
  normalizeLayerLiteral,
} from './values.ts';

interface Operand {
  value: LiteralValue;
  /** Exact magnitude when `value` is numeric. */
  exact?: Quantity;
  /** Config path, `context:<key>`, or the hosting expression path. */
  source: string;
}

/** Numeric magnitude of an operand, preferring the exact rational. */
function quantityOf(operand: Operand): Quantity {
  return operand.exact ?? quantityFromValue(operand.value as never);
}

function invalid(env: EvalEnvironment, message: string): EvalResult {
  return {
    status: 'error',
    error: {
      code: 'invalid_expression',
      source: env.sitePath,
      sources: [env.sitePath],
      message,
      refs: [],
    },
  };
}

function dedupe(values: readonly string[]): string[] {
  const out: string[] = [];
  for (const value of values) {
    if (!out.includes(value)) out.push(value);
  }
  return out;
}

function errorAt(
  env: EvalEnvironment,
  code: InternalError['code'],
  sources: readonly string[],
  message: string,
  refs: readonly RefHop[],
  primarySource?: string,
): EvalResult {
  const unique = dedupe(sources);
  const primary =
    primarySource ??
    unique.find((source) => source !== env.sitePath) ??
    env.sitePath;
  return {
    status: 'error',
    error: {
      code,
      source: primary,
      sources: unique,
      message,
      refs: refs.map((hop) => ({ ...hop })),
    },
  };
}

function missingToError(
  env: EvalEnvironment,
  result: Extract<EvalResult, { status: 'missing' }>,
  neededBy: string,
  collector: Collector,
): EvalResult {
  const source = result.sourcePath;
  const what = result.reason === 'deleted' ? 'deleted' : 'missing';
  return {
    status: 'error',
    error: {
      code: 'missing',
      source,
      sources: [source],
      message: `${neededBy} requires "${source}", which is ${what}`,
      refs: collector.refs.map((hop) => ({ ...hop })),
    },
  };
}

function toOperand(
  result: EvalResult,
  env: EvalEnvironment,
  neededBy: string,
  collector: Collector,
): Operand | EvalResult {
  if (result.status === 'value') {
    return { value: result.value, exact: result.exact, source: result.origin };
  }
  if (result.status === 'missing') return missingToError(env, result, neededBy, collector);
  return result;
}

type Problem = Extract<EvalResult, { status: 'error' | 'missing' }>;

/** Narrows any evaluation by-product to a missing/error outcome. */
function isProblem(value: unknown): value is Problem {
  if (typeof value !== 'object' || value === null) return false;
  const status = (value as { status?: unknown }).status;
  return status === 'error' || status === 'missing';
}

function booleanOperand(
  result: EvalResult,
  env: EvalEnvironment,
  operation: string,
  collector: Collector,
): { value: boolean } | EvalResult {
  if (result.status === 'missing') return missingToError(env, result, operation, collector);
  if (result.status === 'error') return result;
  if (result.value.kind !== 'boolean') {
    return errorAt(
      env,
      'type_mismatch',
      [result.origin],
      `${operation} requires a boolean, received ${literalTypeName(result.value)}`,
      collector.refs,
    );
  }
  return { value: result.value.value };
}

function numberOperand(
  operand: Operand,
  env: EvalEnvironment,
  operation: string,
  collector: Collector,
  orderedSources: readonly string[] = [],
): Quantity | EvalResult {
  if (operand.value.kind !== 'number') {
    return errorAt(
      env,
      'type_mismatch',
      orderedSources.length > 0 ? orderedSources : [operand.source],
      `${operation} requires numbers, but "${operand.source}" is ${literalTypeName(operand.value)}`,
      collector.refs,
      operand.source,
    );
  }
  return quantityOf(operand);
}

function unitError(
  error: unknown,
  env: EvalEnvironment,
  operands: readonly Operand[],
  collector: Collector,
): EvalResult {
  const sources = operands.map((operand) => operand.source);
  if (error instanceof QuantityError) {
    const code =
      error.code === 'division_by_zero'
        ? 'division_by_zero'
        : error.code === 'unknown_unit'
          ? 'unknown_unit'
          : 'unit_mismatch';
    return errorAt(env, code, sources, error.message, collector.refs);
  }
  const message = error instanceof Error ? error.message : String(error);
  return errorAt(env, 'invalid_expression', sources, message, collector.refs);
}

function constLiteral(
  input: unknown,
  env: EvalEnvironment,
): { value: LiteralValue; exact?: Quantity } | EvalResult {
  try {
    const normalized = normalizeLayerLiteral(input, `$const in ${env.sitePath}`);
    if (isDeletion(normalized)) return invalid(env, '$const cannot produce a deletion marker');
    return normalized.kind === 'number'
      ? { value: normalized, exact: quantityFromValue(normalized) }
      : { value: normalized };
  } catch (error) {
    return invalid(env, (error as Error).message);
  }
}

const QUANTITY_TEXT = /^([+-]?(?:\d+(?:\.\d*)?|\.\d+))\s*([a-zA-Z]+)$/;

function quantityLiteral(
  input: unknown,
  env: EvalEnvironment,
): { value: LiteralValue; exact: Quantity } | EvalResult {
  try {
    if (typeof input === 'string') {
      const match = QUANTITY_TEXT.exec(input.trim());
      if (!match) return invalid(env, `$qty could not parse "${input}"`);
      const q = makeQuantity(match[1]!, match[2]!);
      return { value: quantityToValue(q), exact: q };
    }
    if (typeof input === 'object' && input !== null) {
      const raw = input as { value?: unknown; unit?: unknown };
      if (typeof raw.unit !== 'string') return invalid(env, '$qty requires a "unit"');
      if (typeof raw.value !== 'string' && typeof raw.value !== 'number') {
        return invalid(env, '$qty requires a numeric "value"');
      }
      const q = makeQuantity(raw.value, raw.unit);
      return { value: quantityToValue(q), exact: q };
    }
    return invalid(env, '$qty requires a string or { value, unit }');
  } catch (error) {
    return errorAt(env, 'unknown_unit', [env.sitePath], (error as Error).message, []);
  }
}

function operatorOf(node: Expr): string | null {
  if (typeof node !== 'object' || node === null || Array.isArray(node)) return null;
  const keys = Object.keys(node as Record<string, unknown>).filter((key) => key.startsWith('$'));
  return keys.length === 1 ? keys[0]! : null;
}

function asList(node: Expr, op: string, env: EvalEnvironment): Expr[] | EvalResult {
  const payload = (node as Record<string, unknown>)[op];
  if (!Array.isArray(payload) || payload.length === 0) {
    return invalid(env, `${op} requires a non-empty array of expressions`);
  }
  return payload as Expr[];
}

function asPair(node: Expr, op: string, env: EvalEnvironment): [Expr, Expr] | EvalResult {
  const payload = (node as Record<string, unknown>)[op];
  if (!Array.isArray(payload) || payload.length !== 2) {
    return invalid(env, `${op} requires exactly two expressions`);
  }
  return [payload[0] as Expr, payload[1] as Expr];
}

/**
 * Evaluates an expression against `env`, recording every dependency read in
 * `collector`. Expression-level problems are returned as error results rather
 * than thrown. Errors that did not already come with a chain inherit the hops
 * read so far, so every failure explains how it was reached.
 */
export function evaluateExpression(
  node: Expr,
  env: EvalEnvironment,
  collector: Collector,
): EvalResult {
  const result = evaluateNode(node, env, collector);
  if (result.status === 'error' && result.error.refs.length === 0 && collector.refs.length > 0) {
    return { status: 'error', error: { ...result.error, refs: collector.refs.map((hop) => ({ ...hop })) } };
  }
  return result;
}

function evaluateNode(node: Expr, env: EvalEnvironment, collector: Collector): EvalResult {
  const operator = operatorOf(node);
  if (!operator) {
    return invalid(env, 'expression node must contain exactly one $-prefixed operator');
  }
  const payload = (node as Record<string, unknown>)[operator];

  switch (operator) {
    case '$const': {
      const literal = constLiteral(payload, env);
      if (isProblem(literal)) return literal;
      collector.labels.push('const');
      return { status: 'value', value: literal.value, exact: literal.exact, origin: env.sitePath };
    }
    case '$qty': {
      const literal = quantityLiteral(payload, env);
      if (isProblem(literal)) return literal;
      collector.labels.push('const');
      return { status: 'value', value: literal.value, exact: literal.exact, origin: env.sitePath };
    }
    case '$ctx': {
      if (typeof payload !== 'string' || payload.length === 0) {
        return invalid(env, '$ctx requires a non-empty context key');
      }
      return env.readContext(payload, collector);
    }
    case '$ref': {
      if (typeof payload !== 'string' || payload.length === 0) {
        return invalid(env, '$ref requires a non-empty config path');
      }
      return env.ref(payload, collector);
    }
    case '$base': {
      let searchPath = env.sitePath;
      if (payload !== true) {
        if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
          return invalid(env, '$base expects true, {} or { path }');
        }
        const requested = (payload as { path?: unknown }).path;
        if (requested !== undefined) {
          if (typeof requested !== 'string' || requested.length === 0) {
            return invalid(env, '$base.path must be a non-empty string');
          }
          searchPath = requested;
        }
      }
      return env.base(searchPath, collector);
    }
    case '$if': {
      const parts = asList(node, '$if', env);
      if (!Array.isArray(parts)) return parts;
      if (parts.length !== 3) return invalid(env, '$if requires [condition, then, else]');
      const condition = booleanOperand(
        evaluateExpression(parts[0]!, env, collector),
        env,
        '$if',
        collector,
      );
      if (!('value' in condition)) return condition;
      // Only the selected branch is evaluated: it alone contributes
      // dependencies and is alone subject to cycle checks.
      return evaluateExpression(condition.value ? parts[1]! : parts[2]!, env, collector);
    }
    case '$exists': {
      const inner = evaluateExpression(payload as Expr, env, collector);
      if (inner.status === 'error') return inner;
      collector.labels.push('exists');
      return {
        status: 'value',
        value: { kind: 'boolean', value: inner.status === 'value' },
        origin: env.sitePath,
      };
    }
    case '$coalesce': {
      const parts = asList(node, '$coalesce', env);
      if (!Array.isArray(parts)) return parts;
      let lastMissing: Extract<EvalResult, { status: 'missing' }> | null = null;
      for (const part of parts) {
        const result = evaluateExpression(part, env, collector);
        if (result.status === 'value') return result;
        if (result.status === 'error') return result;
        lastMissing = result;
      }
      return (
        lastMissing ?? {
          status: 'missing',
          reason: 'absent',
          layerId: null,
          labels: ['coalesce'],
          sourcePath: env.sitePath,
        }
      );
    }
    case '$and':
    case '$or': {
      const parts = asList(node, operator, env);
      if (!Array.isArray(parts)) return parts;
      const isAnd = operator === '$and';
      for (const part of parts) {
        const evaluated = booleanOperand(
          evaluateExpression(part, env, collector),
          env,
          operator,
          collector,
        );
        if (!('value' in evaluated)) return evaluated;
        if (isAnd && !evaluated.value) {
          return { status: 'value', value: { kind: 'boolean', value: false }, origin: env.sitePath };
        }
        if (!isAnd && evaluated.value) {
          return { status: 'value', value: { kind: 'boolean', value: true }, origin: env.sitePath };
        }
      }
      return {
        status: 'value',
        value: { kind: 'boolean', value: isAnd },
        origin: env.sitePath,
      };
    }
    case '$not': {
      const inner = booleanOperand(
        evaluateExpression(payload as Expr, env, collector),
        env,
        '$not',
        collector,
      );
      if (!('value' in inner)) return inner;
      return {
        status: 'value',
        value: { kind: 'boolean', value: !inner.value },
        origin: env.sitePath,
      };
    }
    case '$eq':
    case '$ne':
    case '$lt':
    case '$lte':
    case '$gt':
    case '$gte':
      return handleComparison(node, operator, env, collector);
    case '$add':
    case '$sub':
    case '$mul':
    case '$div':
      return handleArithmetic(node, operator, env, collector);
    default:
      return invalid(env, `unknown operator ${operator}`);
  }
}

function handleComparison(
  node: Expr,
  operator: string,
  env: EvalEnvironment,
  collector: Collector,
): EvalResult {
  const pair = asPair(node, operator, env);
  if (!Array.isArray(pair)) return pair;
  const left = toOperand(evaluateExpression(pair[0]!, env, collector), env, operator, collector);
  if (isProblem(left)) return left;
  const right = toOperand(evaluateExpression(pair[1]!, env, collector), env, operator, collector);
  if (isProblem(right)) return right;

  const a = left.value;
  const b = right.value;
  const operands = [left, right];
  const sources = operands.map((operand) => operand.source);

  if (a.kind !== b.kind) {
    return errorAt(
      env,
      'type_mismatch',
      sources,
      `${operator} compares ${literalTypeName(a)} with ${literalTypeName(b)}`,
      collector.refs,
    );
  }

  if (operator === '$eq' || operator === '$ne') {
    let equal: boolean;
    if (a.kind === 'number' && b.kind === 'number') {
      try {
        equal = equalQuantities(quantityOf(left), quantityOf(right));
      } catch (error) {
        return unitError(error, env, operands, collector);
      }
    } else {
      equal = canonicalLiteral(a) === canonicalLiteral(b);
    }
    return {
      status: 'value',
      value: { kind: 'boolean', value: operator === '$eq' ? equal : !equal },
      origin: env.sitePath,
    };
  }

  let comparison: number;
  if (a.kind === 'number' && b.kind === 'number') {
    try {
      comparison = compareQuantities(quantityOf(left), quantityOf(right));
    } catch (error) {
      return unitError(error, env, operands, collector);
    }
  } else if (a.kind === 'string' && b.kind === 'string') {
    comparison = a.value < b.value ? -1 : a.value > b.value ? 1 : 0;
  } else {
    return errorAt(
      env,
      'type_mismatch',
      sources,
      `${operator} requires numbers or strings, received ${literalTypeName(a)}`,
      collector.refs,
    );
  }

  const truth =
    operator === '$lt'
      ? comparison < 0
      : operator === '$lte'
        ? comparison <= 0
        : operator === '$gt'
          ? comparison > 0
          : comparison >= 0;
  return { status: 'value', value: { kind: 'boolean', value: truth }, origin: env.sitePath };
}

function handleArithmetic(
  node: Expr,
  operator: string,
  env: EvalEnvironment,
  collector: Collector,
): EvalResult {
  // `$add` accepts two or more operands and folds left to right.
  if (operator === '$add') {
    const operands = asList(node, operator, env);
    if (!Array.isArray(operands)) return operands;
    if (operands.length < 2) return invalid(env, '$add requires at least two expressions');
    const first = toOperand(
      evaluateExpression(operands[0]!, env, collector),
      env,
      operator,
      collector,
    );
    if (isProblem(first)) return first;
    let accumulator = first;
    for (const operandNode of operands.slice(1)) {
      const next = toOperand(
        evaluateExpression(operandNode, env, collector),
        env,
        operator,
        collector,
      );
      if (isProblem(next)) return next;
      const step = applyArithmetic('$add', accumulator, next, env, collector);
      if (isProblem(step)) return step;
      accumulator = step;
    }
    return {
      status: 'value',
      value: accumulator.value,
      exact: accumulator.exact,
      origin: env.sitePath,
    };
  }

  const pair = asPair(node, operator, env);
  if (!Array.isArray(pair)) return pair;
  const left = toOperand(evaluateExpression(pair[0]!, env, collector), env, operator, collector);
  if (isProblem(left)) return left;
  const right = toOperand(evaluateExpression(pair[1]!, env, collector), env, operator, collector);
  if (isProblem(right)) return right;
  const outcome = applyArithmetic(operator, left, right, env, collector);
  if (isProblem(outcome)) return outcome;
  return {
    status: 'value',
    value: outcome.value,
    exact: outcome.exact,
    origin: env.sitePath,
  };
}

function applyArithmetic(
  operator: string,
  left: Operand,
  right: Operand,
  env: EvalEnvironment,
  collector: Collector,
): Operand | EvalResult {
  const operands = [left, right];
  const orderedSources = operands.map((operand) => operand.source);
  const leftQuantity = numberOperand(left, env, operator, collector, orderedSources);
  if (isProblem(leftQuantity)) return leftQuantity;
  const rightQuantity = numberOperand(right, env, operator, collector, orderedSources);
  if (isProblem(rightQuantity)) return rightQuantity;

  try {
    const a = leftQuantity;
    const b = rightQuantity;
    const result =
      operator === '$add'
        ? addQuantities(a, b)
        : operator === '$sub'
          ? subQuantities(a, b)
          : operator === '$mul'
            ? mulQuantities(a, b)
            : divQuantities(a, b);
    collector.labels.push(operator);
    return { value: quantityToValue(result), exact: result, source: env.sitePath };
  } catch (error) {
    return unitError(error, env, operands, collector);
  }
}
