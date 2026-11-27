import { ResourceLimitError } from './errors.ts';
import { joinInstancePath, joinSchemaPath } from './pointer.ts';
import type {
  CompiledNode,
  CompiledSchema,
  LoadedSchema,
  ValidationError,
  ValidationLimits,
  ValidationResult,
} from './types.ts';

const DEFAULT_MAX_DEPTH = 64;
const DEFAULT_BUDGET = 100_000;

/**
 * 对已加载 Schema 求值一份实例（典型为解析后的请求体）。
 * 内容不合法 -> { valid:false, errors:[...] }；
 * 深度/预算耗尽 -> { valid:false, kind:'resource', errors:[] }，两者严格区分。
 */
export function validate(
  loaded: LoadedSchema,
  instance: unknown,
  limits: ValidationLimits = {},
): ValidationResult {
  const state: MutableState = {
    maxDepth: limits.maxDepth ?? DEFAULT_MAX_DEPTH,
    budget: limits.evaluationBudget ?? DEFAULT_BUDGET,
    spent: 0,
    errors: [],
  };

  try {
    runSchema(loaded.root, instance, {
      state,
      instancePath: '',
      schemaPath: '#',
      depth: 0,
    });
  } catch (err) {
    if (err instanceof ResourceLimitError) {
      return err.toResult();
    }
    throw err;
  }

  if (state.errors.length > 0) {
    return { valid: false, errors: state.errors };
  }
  return { valid: true, errors: [] };
}

/**
 * 跨整个求值过程共享的可变状态。
 * 引用类型保证深层递归与各分支中的预算消耗都累加回同一份计数，
 * 分支隔离只替换 errors，不替换共享计数。
 */
interface MutableState {
  maxDepth: number;
  budget: number;
  spent: number;
  errors: ValidationError[];
}

interface EvalContext {
  state: MutableState;
  instancePath: string;
  schemaPath: string;
  depth: number;
}

/** 一次分支（allOf/anyOf/oneOf 成员）的独立求值结果。 */
interface BranchOutcome {
  ok: boolean;
  /** 该分支作用域内成功求值的对象字段。 */
  evaluated: Set<string>;
  /** 该分支内产生的错误；是否对外暴露由外层 applicator 的整体成败决定。 */
  errors: ValidationError[];
}

/**
 * 求值单个 Schema。
 *
 * 每个对象 Schema 作用域持有一份独立的“已求值字段”集合：
 *  - properties / 成功的 applicator 分支 / $ref 目标把字段记入集合；
 *  - anyOf 合并“所有成功分支”的记录，失败分支的记录随其私有集合丢弃；
 *  - required 只检查存在性，本身不登记字段；
 *  - unevaluatedProperties 在同一作用域最后消费该集合。
 */
function runSchema(schema: CompiledSchema, instance: unknown, ctx: EvalContext): Set<string> {
  const { state } = ctx;

  if (ctx.depth > state.maxDepth) {
    throw new ResourceLimitError(
      'max-depth',
      ctx.instancePath,
      state.maxDepth,
      `实例嵌套深度超过限制 ${state.maxDepth}（位于 ${ctx.instancePath || '#'}）`,
    );
  }
  state.spent += 1;
  if (state.spent > state.budget) {
    throw new ResourceLimitError(
      'evaluation-budget',
      ctx.instancePath,
      state.budget,
      `求值预算耗尽，超过 ${state.budget} 次 Schema 求值（位于 ${ctx.instancePath || '#'}）`,
    );
  }

  if (schema === true) {
    return new Set<string>();
  }
  if (schema === false) {
    state.errors.push({
      instancePath: ctx.instancePath,
      schemaPath: ctx.schemaPath,
      keyword: 'false-schema',
      message: '实例不允许通过布尔 false Schema',
    });
    return new Set<string>();
  }

  const evaluated = new Set<string>();

  // $ref 与同级关键字按 2020-12 语义并列求值；它是原地引用，
  // 注解（已求值字段）合并回当前作用域。
  if (schema.refTarget !== undefined) {
    const refSet = runSchema(schema.refTarget, instance, {
      state,
      instancePath: ctx.instancePath,
      schemaPath: joinSchemaPath(ctx.schemaPath, '$ref'),
      depth: ctx.depth,
    });
    mergeInto(evaluated, refSet);
  }

  if (schema.type !== undefined && !matchesType(instance, schema.type)) {
    state.errors.push({
      instancePath: ctx.instancePath,
      schemaPath: joinSchemaPath(ctx.schemaPath, 'type'),
      keyword: 'type',
      message: `期望类型 ${schema.type.join(' | ')}，实际为 ${jsonTypeOf(instance)}`,
    });
  }

  if (isPlainObject(instance)) {
    if (schema.properties) {
      evalProperties(schema, instance, ctx, evaluated);
    }
    if (schema.required) {
      evalRequired(schema, instance, ctx);
    }
    if (schema.allOf) {
      evalAllOf(schema.allOf, instance, ctx, evaluated);
    }
    if (schema.anyOf) {
      evalAnyOf(schema.anyOf, instance, ctx, evaluated);
    }
    if (schema.oneOf) {
      evalOneOf(schema.oneOf, instance, ctx, evaluated);
    }
    // unevaluatedProperties 必须在同作用域所有其他关键字之后求值。
    if (schema.unevaluatedProperties !== undefined) {
      evalUnevaluated(schema.unevaluatedProperties, instance, ctx, evaluated);
    }
  } else if (Array.isArray(instance)) {
    if (schema.items) {
      evalItems(schema.items, instance, ctx);
    }
    if (schema.allOf) {
      evalAllOf(schema.allOf, instance, ctx, evaluated);
    }
    if (schema.anyOf) {
      evalAnyOf(schema.anyOf, instance, ctx, evaluated);
    }
    if (schema.oneOf) {
      evalOneOf(schema.oneOf, instance, ctx, evaluated);
    }
  } else {
    // 标量上只可能存在原地 applicator。
    if (schema.allOf) {
      evalAllOf(schema.allOf, instance, ctx, evaluated);
    }
    if (schema.anyOf) {
      evalAnyOf(schema.anyOf, instance, ctx, evaluated);
    }
    if (schema.oneOf) {
      evalOneOf(schema.oneOf, instance, ctx, evaluated);
    }
  }

  return evaluated;
}

function evalProperties(
  schema: CompiledNode,
  instance: Record<string, unknown>,
  ctx: EvalContext,
  evaluated: Set<string>,
): void {
  for (const [name, sub] of schema.properties!) {
    if (!Object.prototype.hasOwnProperty.call(instance, name)) {
      continue;
    }
    // 先登记为“已求值”，再执行子 Schema（2020-12 annotation 语义：
    // 无论子 Schema 成功与否，该属性都已被本关键字求值）。
    evaluated.add(name);
    runSchema(sub, instance[name], {
      state: ctx.state,
      instancePath: joinInstancePath(ctx.instancePath, name),
      schemaPath: joinSchemaPath(ctx.schemaPath, 'properties', name),
      depth: ctx.depth + 1,
    });
  }
}

function evalRequired(schema: CompiledNode, instance: Record<string, unknown>, ctx: EvalContext): void {
  for (const name of schema.required!) {
    if (!Object.prototype.hasOwnProperty.call(instance, name)) {
      ctx.state.errors.push({
        instancePath: ctx.instancePath,
        schemaPath: joinSchemaPath(ctx.schemaPath, 'required'),
        keyword: 'required',
        message: `缺少必填字段 "${name}"`,
      });
    }
  }
  // 注意：required 不向 evaluated 登记任何字段。
}

function evalItems(items: CompiledSchema, instance: unknown[], ctx: EvalContext): void {
  for (let i = 0; i < instance.length; i += 1) {
    runSchema(items, instance[i], {
      state: ctx.state,
      instancePath: joinInstancePath(ctx.instancePath, i),
      schemaPath: joinSchemaPath(ctx.schemaPath, 'items'),
      depth: ctx.depth + 1,
    });
  }
}

function evalAllOf(
  branches: CompiledSchema[],
  instance: unknown,
  ctx: EvalContext,
  evaluated: Set<string>,
): void {
  branches.forEach((branch, i) => {
    const outcome = runBranch(branch, instance, ctx, 'allOf', i);
    // allOf 任一失败整体即失败，因此分支错误始终对外暴露。
    if (!outcome.ok) {
      ctx.state.errors.push(...outcome.errors);
    }
    mergeInto(evaluated, outcome.evaluated);
  });
}

function evalAnyOf(
  branches: CompiledSchema[],
  instance: unknown,
  ctx: EvalContext,
  evaluated: Set<string>,
): void {
  const outcomes = branches.map((branch, i) => runBranch(branch, instance, ctx, 'anyOf', i));
  const succeeded = outcomes.filter((o) => o.ok);

  if (succeeded.length === 0) {
    // 整体失败时才暴露各失败分支的具体错误，帮助定位请求内容问题。
    for (const outcome of outcomes) {
      ctx.state.errors.push(...outcome.errors);
    }
    ctx.state.errors.push({
      instancePath: ctx.instancePath,
      schemaPath: joinSchemaPath(ctx.schemaPath, 'anyOf'),
      keyword: 'anyOf',
      message: '实例未通过 anyOf 的任何分支',
    });
    return;
  }
  // 整体成功：失败分支只是未被选中的备选，其错误不污染结果；
  // 其 evaluated 集合同样丢弃，绝不能为未知字段放行。
  // 所有成功分支的求值记录合并到当前作用域。
  for (const outcome of succeeded) {
    mergeInto(evaluated, outcome.evaluated);
  }
}

function evalOneOf(
  branches: CompiledSchema[],
  instance: unknown,
  ctx: EvalContext,
  evaluated: Set<string>,
): void {
  const outcomes = branches.map((branch, i) => runBranch(branch, instance, ctx, 'oneOf', i));
  const succeeded = outcomes.filter((o) => o.ok);

  if (succeeded.length !== 1) {
    for (const outcome of outcomes) {
      ctx.state.errors.push(...outcome.errors);
    }
    ctx.state.errors.push({
      instancePath: ctx.instancePath,
      schemaPath: joinSchemaPath(ctx.schemaPath, 'oneOf'),
      keyword: 'oneOf',
      message: `oneOf 要求恰好一个分支成功，实际 ${succeeded.length} 个`,
    });
    return;
  }
  // 恰好一个成功分支：只收集该分支的求值记录；其余分支错误不外泄。
  mergeInto(evaluated, succeeded[0].evaluated);
}

/**
 * 在隔离的错误队列中运行一个 applicator 分支以独立判定成败。
 * 分支错误先收集在 outcome 中，由外层 applicator 依据“整体是否失败”
 * 决定是否追加到共享错误列表；预算/深度计数通过共享 state 实时累加。
 */
function runBranch(
  branch: CompiledSchema,
  instance: unknown,
  ctx: EvalContext,
  keyword: 'allOf' | 'anyOf' | 'oneOf',
  index: number,
): BranchOutcome {
  const sharedErrors = ctx.state.errors;
  const branchErrors: ValidationError[] = [];
  ctx.state.errors = branchErrors;
  let evaluated: Set<string>;
  try {
    evaluated = runSchema(branch, instance, {
      state: ctx.state,
      instancePath: ctx.instancePath,
      schemaPath: joinSchemaPath(ctx.schemaPath, keyword, index),
      // 原地 applicator：实例位置与深度均不推进。
      depth: ctx.depth,
    });
  } finally {
    ctx.state.errors = sharedErrors;
  }
  return { ok: branchErrors.length === 0, evaluated, errors: branchErrors };
}

function evalUnevaluated(
  rule: CompiledSchema,
  instance: Record<string, unknown>,
  ctx: EvalContext,
  evaluated: Set<string>,
): void {
  for (const name of Object.keys(instance)) {
    if (evaluated.has(name)) {
      continue;
    }
    if (rule === false) {
      ctx.state.errors.push({
        instancePath: joinInstancePath(ctx.instancePath, name),
        schemaPath: joinSchemaPath(ctx.schemaPath, 'unevaluatedProperties'),
        keyword: 'unevaluatedProperties',
        message: `未被任何成功分支求值的字段 "${name}" 被 unevaluatedProperties:false 拒绝`,
      });
      continue;
    }
    if (rule === true) {
      continue;
    }
    runSchema(rule, instance[name], {
      state: ctx.state,
      instancePath: joinInstancePath(ctx.instancePath, name),
      schemaPath: joinSchemaPath(ctx.schemaPath, 'unevaluatedProperties'),
      depth: ctx.depth + 1,
    });
  }
}

function mergeInto(target: Set<string>, source: Set<string>): void {
  for (const key of source) {
    target.add(key);
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function jsonTypeOf(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

function matchesType(value: unknown, expected: string[]): boolean {
  for (const t of expected) {
    if (
      (t === 'null' && value === null) ||
      (t === 'boolean' && typeof value === 'boolean') ||
      (t === 'object' && isPlainObject(value)) ||
      (t === 'array' && Array.isArray(value)) ||
      (t === 'string' && typeof value === 'string') ||
      (t === 'number' && typeof value === 'number' && Number.isFinite(value)) ||
      (t === 'integer' &&
        typeof value === 'number' &&
        Number.isInteger(value) &&
        Number.isFinite(value))
    ) {
      return true;
    }
  }
  return false;
}
