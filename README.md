# JSON Schema 2020-12 子集请求校验模块

纯 TypeScript、零运行时依赖的 Node.js 请求校验模块，实现 JSON Schema 2020-12
语义的一个子集。使用 Node 内置 test runner 与原生 TypeScript 支持（可擦除类型
语法），无需安装编译器或任何第三方包。

## 支持的关键字与语义

- 布尔 Schema（`true` / `false`）
- 基础 `type`：`null` / `boolean` / `object` / `array` / `string` /
  `number` / `integer`（支持类型名数组）
- `properties`、`required`、`items`
- 本地 `$defs` 与 `$ref`（仅当前文档内的 JSON Pointer，如 `#/$defs/node`）
- `allOf`、`anyOf`、`oneOf`
- `unevaluatedProperties`（题目要求 `false`，同时支持任意子 Schema）

### 已求值字段（evaluated properties）的收集规则

每个对象 Schema 作用域独立维护一份“当前对象已成功求值的字段”集合：

1. `properties` 命中的字段在子 Schema 求值前即登记（2020-12 annotation 语义）。
2. `required` **只检查存在性，本身不声明字段已被求值**。
3. `anyOf`：合并**所有成功分支**的记录；失败分支的记录随其私有集合丢弃，
   绝不能为未知字段放行。
4. `oneOf`：必须恰好一个成功分支，只合并该分支的记录。
5. `allOf`：收集每个分支的记录。
6. `$ref` 是原地（in-place）引用，目标 Schema 的记录合并回同一作用域。
7. `unevaluatedProperties` 在同一作用域所有其他关键字之后消费该集合。

> 因此，同一对象的字符串字段 `a`、`b` 分别由 `anyOf` 的两个成功分支声明时，
> 即使外层 `unevaluatedProperties: false`，两者同时出现也会被放行。

### 引用循环

- **不消耗实例层级的引用循环**（仅由 `$ref` / `allOf` / `anyOf` / `oneOf`
  这类原地边构成的环）在 `loadSchema` 阶段通过 DFS 静态检测并拒绝，因为其
  求值无法借助实例层级收敛，必然无限递归。
- 经 `properties` 属性值或 `items` 数组元素**下降**的递归引用是合法的，
  求值随实例深度自然收敛。
- 同一 `$ref` 被多个实例位置复用时，每次调用独立求值、互不影响。

### 资源错误与内容错误严格区分

| 情况 | 返回 |
| --- | --- |
| 请求内容不合法 | `{ valid:false, errors:[{ instancePath, schemaPath, keyword, message }] }` |
| 实例嵌套超深 / 求值预算耗尽 | `{ valid:false, kind:'resource', code:'max-depth' \| 'evaluation-budget', errors:[] }` |
| Schema 本身非法或含原地引用环 | `loadSchema` 返回 `{ ok:false, errors:[{ schemaPath, message }] }` |

默认限制：`maxDepth = 64`、`evaluationBudget = 100000`，均可在 `validate`
第三参数中覆盖。

## 目录结构

```
src/
  types.ts      公共类型
  errors.ts     ResourceLimitError（资源异常与内容错误分离）
  pointer.ts    JSON Pointer 编解码与本地 $ref 解析
  compile.ts    Schema 加载：结构校验、$ref 解析、原地引用循环检测
  validate.ts   求值核心：分支隔离、已求值字段收集、资源预算
  index.ts      模块入口
test/
  validator.test.ts  21 个真实断言（含交错分支、递归、崩溃场景）
```

## 使用方式

```ts
import { loadSchema, validate } from './src/index.ts';

const loaded = loadSchema({
  type: 'object',
  anyOf: [
    { properties: { a: { type: 'string' } }, required: ['a'] },
    { properties: { b: { type: 'number' } }, required: ['b'] },
  ],
  unevaluatedProperties: false,
});

if (!loaded.ok) {
  throw new Error(JSON.stringify(loaded.errors)); // Schema 自身问题
}

// 典型调用方适配器：解析请求体后校验
const result = validate(loaded.schema, JSON.parse(rawRequestBody));
if (result.kind === 'resource') {
  // 413/400 资源类问题，与字段校验失败分开处理
} else if (!result.valid) {
  for (const err of result.errors) {
    // err.instancePath 如 '/b'，err.schemaPath 如 '#/anyOf/1/type'
  }
}
```

## 运行测试

```bash
npm test
```

要求 Node.js >= 22.6（本环境为 v26.8.1，原生执行 `.ts`）。断言失败时
`npm test` 以非零码退出；所有测试数据均为本地合成数据，不访问外部服务，
临时数据只产生在本工作区内。
