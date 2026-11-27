/**
 * 公共类型定义。
 *
 * 支持的 2020-12 子集关键字：
 *   布尔 Schema；基础 type；properties；required；items；
 *   本地 $defs / $ref；allOf；anyOf；oneOf；unevaluatedProperties: false。
 */

/** 未编译的原始 Schema：布尔值或关键字对象。 */
export type RawSchema = boolean | RawSchemaObject;

export interface RawSchemaObject {
  type?: JsonSchemaTypeName | JsonSchemaTypeName[];
  properties?: Record<string, RawSchema>;
  required?: string[];
  items?: RawSchema;
  $defs?: Record<string, RawSchema>;
  $ref?: string;
  allOf?: RawSchema[];
  anyOf?: RawSchema[];
  oneOf?: RawSchema[];
  unevaluatedProperties?: RawSchema;
  [keyword: string]: unknown;
}

export type JsonSchemaTypeName =
  | 'null'
  | 'boolean'
  | 'object'
  | 'array'
  | 'string'
  | 'number'
  | 'integer';

/** 编译后的对象 Schema 节点（布尔 Schema 不产生节点）。 */
export interface CompiledNode {
  /** 该节点在根 Schema 内的 JSON Pointer，例如 ''、'/properties/a'、'/$defs/node'。 */
  readonly pointer: string;
  type?: JsonSchemaTypeName[];
  properties?: Map<string, CompiledSchema>;
  required?: string[];
  items?: CompiledSchema;
  allOf?: CompiledSchema[];
  anyOf?: CompiledSchema[];
  oneOf?: CompiledSchema[];
  unevaluatedProperties?: CompiledSchema;
  /** 解析后的 $ref 目标；与同级关键字按 2020-12 语义一起求值。 */
  refTarget?: CompiledSchema;
  refPointer?: string;
}

/** 编译后的 Schema 表示：true/false 或对象节点。 */
export type CompiledSchema = boolean | CompiledNode;

/** 单条校验失败记录（资源错误不走此结构）。 */
export interface ValidationError {
  /** 实例位置，JSON Pointer 字符串；根为 ''。 */
  instancePath: string;
  /** Schema 位置，以 '#' 开头的 JSON Pointer，例如 '#/anyOf/0/properties/a'。 */
  schemaPath: string;
  /** 机器可读的关键字名，'type' | 'required' | ... 或 'false-schema'。 */
  keyword: string;
  /** 人类可读说明。 */
  message: string;
}

/** 深度或求值预算耗尽等资源类错误，与请求内容不合法严格区分。 */
export interface ResourceError {
  kind: 'resource';
  code: 'max-depth' | 'evaluation-budget';
  message: string;
  /** 触发限制时的实例位置。 */
  instancePath: string;
  limit: number;
}

export interface ValidationSuccess {
  valid: true;
  errors: [];
}

export interface ValidationFailure {
  valid: false;
  errors: ValidationError[];
}

export type ValidationResult =
  | ValidationSuccess
  | ValidationFailure
  | (ResourceError & { valid: false; errors: [] });

/** Schema 加载（编译）阶段错误，例如结构非法或纯原地引用循环。 */
export interface SchemaLoadError {
  /** 出错子 Schema 的 JSON Pointer。 */
  schemaPath: string;
  message: string;
}

export interface LoadedSchema {
  root: CompiledSchema;
}

export interface LoadSuccess {
  ok: true;
  schema: LoadedSchema;
}

export interface LoadFailure {
  ok: false;
  errors: SchemaLoadError[];
}

export type LoadResult = LoadSuccess | LoadFailure;

/** validate 的可选资源限制。 */
export interface ValidationLimits {
  /** 实例嵌套最大深度（根为 0），默认 64。 */
  maxDepth?: number;
  /** 单次校验允许求值的 Schema 节点总数，默认 100000。 */
  evaluationBudget?: number;
}
