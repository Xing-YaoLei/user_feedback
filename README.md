# 长轮询分区读取模块（long-poll-reader）

在 Node.js 上运行的 TypeScript 长轮询读取模块：消费端等到"足够多"的数据再返回，
同时保证在"判定数据不足"与"挂上通知订阅"之间落地的追加不会丢失。

- 运行时：Node.js ≥ 22.18（使用内置的 TypeScript 类型擦除，无需编译器）
- 测试：`npm test`（Node 内置测试框架，真实断言，无外部服务）
- 示例：`npm start`（`examples/demo.ts`）

## 快速开始

```bash
npm test      # 完整验证（含交错/崩溃竞态场景）
npm start     # 端到端示例：等待、装包、续读、取消
```

源码结构：

| 文件 | 作用 |
| --- | --- |
| `src/types.ts` | 公开类型：`LogAdapter`、`ReadRequest`、`ReadResult` 等 |
| `src/reader.ts` | `LongPollReader`：长轮询、装包、共享通知订阅 |
| `src/adapters/in-memory.ts` | 内存 `LogAdapter`（供本地验证，也可直接复用） |
| `src/index.ts` | 统一导出入口 |
| `tests/*.test.ts` | 装包规则、竞态、上限、压力测试 |

```ts
import { InMemoryLogAdapter, LongPollReader } from './src/index.ts';

const adapter = new InMemoryLogAdapter(['orders', 'payments']);
const reader = new LongPollReader(adapter);

const result = await reader.read({
  partitions: ['orders', 'payments'],
  startOffsets: { orders: 0, payments: 0 },
  minBytes: 1024,
  maxBytes: 4096,
  maxRecords: 32,
  waitMs: 5000,
  signal: ac.signal,           // 可选：只取消这一次读取
});
// result.nextOffsets 即下一次读取的 startOffsets
```

## 日志适配器契约

读取端只依赖两个能力，见 `src/types.ts` 中的 `LogAdapter`：

```ts
interface LogAdapter {
  partitions(): readonly string[];
  snapshotRevision(): number;                                  // 单调不回退
  snapshot(partition: string, revision?: number): PartitionSnapshot;
  subscribe(listener: (c: ChangeNotification) => void, sinceRevision?: number): () => void;
  byteLength(record: LogRecord): number;
}
```

`PartitionSnapshot` 在给定 `revision` 上钉住：`records[i]` 的偏移为
`startOffset + i`，`records.length === nextOffset - startOffset`，且**不包含**
在该 `revision` 之后追加的记录。同一 `revision` 下各分区的快照是一致的。

`subscribe(listener, sinceRevision)` 必须**接续**：对每一个 `revision > sinceRevision`
的变化都投递一次通知（包括在 `subscribe` 调用返回之前就已落地的变化），允许同步回放
与重复投递。这条契约正是"判定不足 → 订阅"窗口内追加不丢失的依据。

`ChangeNotification.partitions` 列出发生推进的分区；读取端再按自身关心的分区过滤。

## 读取语义

### 装包

1. 先取一次 `snapshotRevision()`，记为 `R`；本轮所有分区快照都钉在 `R`。
   **返回决定使用的正是这一轮确定的各分区读取上界**；之后追加的记录一律留给下一次读取。
2. 按请求给出的分区顺序**轮流**取记录，每轮每个分区最多取一条；本轮已无记录的分区
   直接跳过，各分区内部顺序保持不变。
3. 达到 `minBytes` 立即停止本轮装包（不会为了凑整轮而多取）。
4. 下一条放不下 `maxBytes` 时结束装包，该条留给下一次读取。
5. **首条记录本身超过 `maxBytes` 时允许单独返回它**（且只返回它）。
6. `maxRecords` 是记录数的硬上限。
7. 任何情况下装包都不会超过 `maxBytes` / `maxRecords`（超大首条按上条规则例外）。

`nextOffset` 始终指向"已返回的最后一条之后"，所以续读既不重复也不跳过。

### 等待与返回

每次 `read()` 恰好结算一次，`status` 为三者之一：

| status | 含义 |
| --- | --- |
| `min-bytes` | 装包达到 `minBytes`（`minBytes = 0` 时也立即返回，装到上限为止） |
| `deadline` | 等待期限到达；返回当时能装下的内容（可能为空），仍不越过上限。分区列表为空时无从等待，也立即返回此状态（若 `minBytes = 0` 则为 `min-bytes`） |
| `cancelled` | `AbortSignal` 结束了本次等待；不返回装包（`revision === null`） |

等待期限 `waitMs` 从调用时刻算起。等待中收到**关心分区**的变更会立刻重新装包；
不相关分区的变更不会唤醒该等待者。

### 不丢失的保证

- 判定"数据不足"后，读取端以**当时的快照修订 `R`** 作为 `sinceRevision` 去订阅；
  `R` 与订阅之间落地的追加会被适配器回放，因此不会丢。
- 唤醒标志在读取修订**之前**清零：之后到来的通知要么已体现在 `R` 的快照中，要么
  留下标志使循环在挂起前立即复查——不存在"清标志与挂起之间"的窗口。
- 超时与取消交错时，每个请求只结算一次；`finish()` 内部断言防止二次结算。

### 共享订阅

- 每个 `LongPollReader` 只有一条适配器订阅，被所有在途读取共享。
- 订阅按集合引用计数：某个等待者结束（完成 / 超时 / 取消）时，只有它**是最后一个**
  使用者才撤下订阅；关闭其中一个等待者不会拆掉其他等待者仍需要的订阅。
- 较慢的读取可能以更旧的基线修订挂起：此时以旧修订重放订阅，速度快者最多多收若干
  重复通知（仅触发一次无需等待的复查），不会漏掉变化。

## 可重复的本地验证

`npm test` 使用 Node 内置测试框架与本地合成数据（`InMemoryLogAdapter`），断言失败时
以非零码退出。覆盖：

- `tests/adapter.test.ts`：快照钉修订、接续回放、订阅中途追加、退订、裁剪窗口
- `tests/packing.test.ts`：轮流装包、跳过空分区、minBytes 达标、字节/记录上限、
  超大首条、`nextOffset` 续读、裁剪偏移、请求校验
- `tests/races.test.ts`：判定→订阅窗口追加、订阅建立窗口追加、同一轮修订、
  共享订阅与最后一个使用者撤订、取消只结束自己、按分区唤醒、交错时只结算一次
- `tests/limits.test.ts`：等待中追加也不越过上限、超大首条与 `maxRecords` 组合
- `tests/stress.test.ts`：60 路并发读取 + 80 次追加 + 随机取消，无泄漏；
  反复短读取恰好排干每条记录一次

所有临时数据都留在本工作区内（内存适配器不写磁盘）。
