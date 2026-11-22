# Schema Registry — 注册与跨版本解析模块

纯 TypeScript 实现的 Schema 注册中心与跨版本解析计划模块，运行在 Node.js 内置
TypeScript 支持之上（可擦除类型语法，无需安装编译器或任何第三方依赖）。

## 快速开始

```bash
npm test
```

`npm test` 使用 Node 内置测试框架运行 `test/` 下的全部真实断言，覆盖兼容/不兼容
方向、递归类型分析终止、交错运行与崩溃恢复场景；断言失败时进程以非零码退出。

## 类型系统

每个 Schema 版本由**命名类型表** `types` 与一个**根类型** `root` 组成，支持：

| 类型 | 线上表示 |
| --- | --- |
| `bool` / `string` | JSON 布尔 / 字符串 |
| `i32` | 有符号 32 位整数（number，运行时校验范围） |
| `i64` | 有符号 64 位整数（**bigint，全程精确**；JSON 编解码包装为 `{"__i64__":"十进制"}`） |
| `f64` | 有限双精度浮点 |
| `array` | JSON 数组 |
| `record` | 以**稳定正整数字段编号**为键的对象；字段名可随版本改变 |
| `union` | `{ tag, value }` 带标签信封，按标签精确选择分支 |
| `ref` | 指向命名类型表的递归/命名引用 |

记录字段：读取方忽略未知编号字段；缺失字段由读取方默认值补齐；字段必填且无默认值
（或写入方合法消息可能省略它）时解析失败。

## 兼容规则（静态分析与运行时共用同一套规则）

- **数值提升**以写入类型的全部取值都能被读取类型无损表示为准：
  `i32→i32/i64/f64`、`i64→i64`、`f64→f64` 成立；`i64→f64`（2^64 个值无法全部
  精确表示）、`f64→整数` 等均拒绝。
- **联合**按标签精确匹配；写入方存在读取方没有的标签即不兼容；读取方多出的分支
  不影响旧消息读取。
- **记录**按字段编号配对；读取方必填字段若在写入方缺失或为可选字段，则不兼容。
- **递归类型**：检查器对类型节点对做记忆化，进行中的节点对按协归纳守卫递归规则
  乐观假设，仅在整条下降路径成功后才落定缓存，因此分析必然结束且对任意有限嵌套
  深度保持可靠。
- 注册时还会校验引用可解析、字段编号/名称与联合标签唯一、默认值属于其声明类型域、
  以及每个命名类型至少能表示一个有限值（最小不动点求解，同时拒绝无保护递归）。

## 方向策略

`register(schema, direction)` 与所有已登记版本核对：

- `backward`：旧版写入可由新版读取（旧 write → 新 read）
- `forward`：新版写入可由旧版读取（新 write → 旧 read）
- `bidirectional`：两个方向都检查

不兼容时抛出 `CompatibilityError`，携带类型路径 `path` 与一个**可实际编码并触发
相同失败的有限消息反例** `counterexample`；注册失败不会改变已有版本集合（原子提交）。

兼容时生成可复用的跨版本解析计划（`getPlan`/`parseAcross`，计划对象带缓存）。
不兼容版本对也可生成"尽力计划"：不兼容位置成为 trap 节点，使静态反例在解析入口
以相同 `reason` 与类型路径重现失败。

## 模块入口

```ts
import {
  SchemaRegistry,   // 注册中心：register / analyze / getPlan / parse / parseAcross
  encodeWire,       // 线上消息 → JSON 文本（i64 保持精确）
  decodeWire,       // JSON 文本 → 线上消息
  CompatibilityError, ParseError, SchemaValidationError,
} from './src/index.ts';
```

- `src/types.ts` — 类型声明与数值域常量
- `src/validate.ts` — 结构校验 + 有限值可居住性最小不动点
- `src/compat.ts` — 兼容检查器、无损数值规则、有限反例构造
- `src/plan.ts` — 可复用解析计划（声明式 recipe 图 + trap 节点 + 运行时转换）
- `src/registry.ts` — 注册中心公共 API 与原子提交
- `src/wire.ts` — 线上格式编解码
- `test/` — 9 个测试文件共 46 个用例（`helpers.ts` 为测试适配器，非测试文件）

## 最小示例

```ts
const registry = new SchemaRegistry();
registry.register(v1Schema, 'bidirectional');
const result = registry.register(v2Schema, 'backward'); // 失败则抛 CompatibilityError

const message = decodeWire(jsonTextFromOldProducer);
const domainValue = registry.parseAcross('v1', 'v2', message);
```
