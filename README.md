# pro117 — 幂等 RPC 入口（TypeScript / Node.js）

单管理进程的 RPC 幂等网关：本地目录持久化状态，副作用**不支持幂等**，因此
「执行已发生但结果未保存」的崩溃窗口必须靠**票据 + 对账**解决，而不是重试执行。

## 快速开始

```bash
npm test          # 全部断言 + 崩溃/并发场景，失败时非零退出
```

无需安装依赖、无需编译：Node 直接运行 TypeScript（要求 Node ≥ 22.6，本仓库在
v26.8.1 上验证）。所有临时数据都落在本工作区的 `.tmp/` 下。

启动管理进程：

```bash
node src/main.ts \
  --state .tmp/state \
  --adapter ./adapters/local-effect-adapter.ts \
  --adapter-config '{"effectFile":".tmp/effects.jsonl"}' \
  --endpoint .tmp/endpoint.json \
  --work .tmp
```

`--endpoint` 指向的文件只包含 `{transport, host, port, pid}`，由客户端读取。
默认 `--transport tcp`（绑定 127.0.0.1 的随机端口）；也可用
`--transport unix --socket <path>`。

对账 / 运维 CLI（通过同一 RPC socket，绝不直接写状态目录）：

```bash
node src/ops.ts --endpoint .tmp/endpoint.json list
node src/ops.ts --endpoint .tmp/endpoint.json show   --ticket <id>
node src/ops.ts --endpoint .tmp/endpoint.json key    --tenant t --method m --key k
node src/ops.ts --endpoint .tmp/endpoint.json reconcile --ticket <id> --proof '{"kind":"completed",...}'
node src/ops.ts --endpoint .tmp/endpoint.json reconcile --ticket <id> --proof @proof.json
node src/ops.ts --endpoint .tmp/endpoint.json reclaim --ticket <id> [--reason admin|ttl]
node src/ops.ts --endpoint .tmp/endpoint.json reclaim-expired
```

## 模块入口

| 文件 | 用途 |
| --- | --- |
| `src/index.ts` | 公共入口：`IdempotencyGateway`、`createGatewayServer`、`GatewayClient`、错误类型 |
| `src/manager.ts` | 核心状态机：invoke / recover / reconcile / reclaim |
| `src/store.ts` | 崩溃安全存储：原子写 + fsync、单属主锁、临时文件清扫 |
| `src/server.ts` | NDJSON RPC 服务与 `runServerCli` |
| `src/client.ts` | RPC 客户端（含 `startInvoke`/`cancelWaiter` 等待者取消） |
| `src/ops.ts` | 运维 CLI |
| `adapters/local-effect-adapter.ts` | 本地非幂等副作用模拟器 |

嵌入式用法：

```ts
import { IdempotencyGateway, BusinessError } from './src/index.ts';

const gateway = new IdempotencyGateway({
  stateDirectory: '.tmp/state',
  adapter: { async execute({ ticketId, body }) { /* 真正的副作用 */ return { ok: true }; } },
});

const result = await gateway.invoke({
  tenant: 'acme', method: 'orders.create', idempotencyKey: 'k-1',
  body: new TextEncoder().encode('{"orderId":"o-1"}'),
});
// result.outcome: { type: 'success', value } | { type: 'business_error', error }
```

## 语义契约

**键的隔离。** 键 = `(tenant, method, idempotencyKey)`，用长度前缀拼接后哈希，
`("a","bc")` 与 `("ab","c")` 不会碰撞。磁盘布局为
`keys/<keyHash>/{entry.json,tickets/,intents/}`，各租户互相不可见。

**同键同字节 → 共享一次执行。** 请求体按**原始字节**做 sha256，两次调用只要字节
相同就复用同一票据；并发调用者加入同一 in-flight 执行（测试用 250ms 挂起来证明
只有一个适配器调用）。适配器返回的结果先 fsync 落盘，才交给调用者。

**同键不同字节 → `KEY_CONFLICT`。** 请求体在键首次被占用时就永久绑定；冲突既不
执行也不返回缓存结果，即便结果载荷已被回收也仍是冲突（而非 `RESULT_EXPIRED`）。

**执行前先落事实。** 每次执行按顺序持久化并 fsync：① 票据 ② 账目（ledger，记录
head）③ 执行意图（`intents/<ticketId>.json`，“可能已执行”的事实），之后才调用
适配器。`test/crash-matrix.test.ts` 用 `--fault-after-writes N` 在四个精确边界
硬退出进程，逐一验证恢复行为。

**确定完成的业务错误是终态。** 适配器抛出 `BusinessError` 表示“明确完成且被拒绝”，
网关把它保存为 `business_error` 终态结果；后续同键调用返回该错误而不执行。

**崩溃恢复只标记、不重放。** 启动时任何仍为 `pending` 的票据改为 `indeterminate`
并记录原因（是否已写入执行意图），**绝不自动补执行**。遗留在 `pending` 且无活跃
执行的票据在运行期同样转为不确定并拒绝重试。

**对账是唯一的放行口。** `reconcile` 接收执行方对票据的不可反转终态证明：

- `{kind:'completed', proofId, outcome}` → 票据变成终态并保存该结果；之后（以及
  崩溃重启后）所有调用都读到同一结果，不再执行。
- `{kind:'not_executed', proofId}` → 证明“确定没有执行且不会再执行”，**只有这种
  证明**允许下一次 invoke 建立新票据并重试（序列号 +1，旧票据保留在账目中）。

证明 ID 全库单次使用：同一 ID 配不同内容或不同票据 → `PROOF_REPLAYED`；完全相同的
证明可重发（幂等，用于修复“证明已落盘、票据未更新”的崩溃）。证明可附带
`tenant/method/idempotencyKey` 做绑定校验，不匹配 → `PROOF_MISMATCH`。

**证明不可反转，且每张票据只接受第一份证明。** 应用证明前，先落
`attestations/<ticketId>.json` 固定首个证明的 `proofId` 与内容哈希。若崩溃发生在
“证明已落盘、票据未更新”之间，重启后票据仍是不确定；此时**不能**用另一份内容不同的
证明（例如用 `not_executed` 覆盖已记录的 `completed`）来解锁 —— 会得到
`PROOF_MISMATCH`，只有逐字节相同的原证明才能续做。这样对账过程本身也无法被用来放行
第二次执行。被拒绝的证明（身份不符、ID 复用到别的票据）不会留下这层固定记录。

**少见的边界都偏向安全。** 引擎在“可能已执行”与“确定没执行”之间无法区分时，一律
选择 `indeterminate`（拒绝自动重试），把决定权交给对账证明。

## 载荷回收与幂等事实

等待者取消（`cancelWaiter` / `AbortSignal`）只让该等待者收到
`WAITER_CANCELLED`：共享执行继续跑完并落盘，账目不删除，后续调用仍是缓存命中。

结果载荷可以回收（`reclaim` 管理员触发 / `reclaimExpired` 按 `--outcome-ttl-ms`
到期，默认 24h）。回收只清除 `outcome`，保留票据、账目、请求摘要、以及被丢弃载荷的
摘要（`reclaimedOutcomeDigest`）。此后同键调用返回 `RESULT_EXPIRED`，**不能**
重新执行 —— 测试验证了回收、以及回收后再次重启，实际副作用始终只有一次。

## 崩溃场景（题目要求的核心验证）

`test/crash.test.ts` 的主场景：

1. 两个并发请求争用同键；适配器先把副作用写进本地效果日志，再按
   `holdAfterEffectMs` 挂起。
2. 等效果日志出现 1 条后，对管理进程 `SIGKILL`（无清理、无 flush）。
3. 重启：启动报告列出一张 `indeterminate` 票据；磁盘上只有 1 张票据、1 条实际效果；
   对账前任何重试都被拒绝且不执行。
4. 补入 `completed` 证明后，两个重试读到**完全相同**的结果；效果仍为 1 次。
5. 回收结果后调用报 `RESULT_EXPIRED`；再重启仍如此；效果始终 1 次。

## 文件与进程安全

- 每次写入都是「临时文件 → fsync → rename → fsync 目录」，崩溃只会留下旧文件或
  新文件，不会留下半截 JSON；遗留临时文件启动时清扫。
- `OWNER.json` 用 `O_EXCL` 保证同一状态目录只有一个管理进程；属主进程已死
  （同机 pid 不存在）时可接管，异机属主一律视为存活（共享目录场景）。
- 损坏的 JSON 报 `STORE_CORRUPT`，绝不静默当作空状态重置。

## 测试布局

```
test/idempotency.test.ts   单次执行、并发共享、字节冲突、租户隔离、业务错误终态
test/crash.test.ts         核心崩溃窗口 + 两份重试 + 回收不放行
test/crash-matrix.test.ts  四个持久化边界的精确崩溃点 + 对账中途崩溃修复/防篡改
test/reconcile.test.ts     两种证明、证明全局唯一、绑定校验、回收语义
test/attestation.test.ts   证明不可反转、幂等重放、跨票据 ID 复用
test/cancellation.test.ts  取消单个/全部等待者不影响共享执行与账目
test/storage.test.ts       原子写、损坏检测、单属主锁、账目重建、执行意图时序
test/validation.test.ts    输入校验、坏报文、未知操作、单属主、同连接流水线
test/edge-cases.test.ts    重启缓存、结果写入失败、大报文、字节级区分
test/ops-cli.test.ts       运维 CLI 端到端（列表/查询/对账/回收）
test/transport.test.ts     unix socket 传输
```
