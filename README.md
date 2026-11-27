# 单分区事务日志视图（TypeScript / Node.js）

从零实现的单分区事务日志：追加输入包含普通数据、带事务身份的数据以及提交/中止标记；
提供 `read_uncommitted` 与 `read_committed` 两种读取方式，支持生产者代次（epoch）栅栏。
仅依赖 Node.js 内置能力（内置测试框架 + 可擦除 TypeScript 语法的原生类型擦除），无需安装任何依赖。

## 运行环境与入口

- Node.js ≥ 22.6（开发验证环境：Node v26.8.1 / npm 11.19.0）
- 运行测试（真实断言，失败时非零退出）：

  ```bash
  npm test
  ```

- 运行题目场景演示：

  ```bash
  npm run demo
  ```

- 模块入口：`src/index.ts`；核心实现：`src/txn-log.ts`

## 数据模型

所有记录顺序追加并占有连续递增的整数 offset（从 0 开始），共五类：

| kind      | 含义 | 是否返回给消费者 |
| --------- | ---- | ---------------- |
| `data`    | 普通（非事务）数据 | 是 |
| `txnData` | 事务数据，携带事务身份 | read_uncommitted 是；read_committed 仅已提交时是 |
| `commit`  | 事务提交标记 | 否（控制记录） |
| `abort`   | 事务中止标记 | 否（控制记录） |
| `fence`   | 生产者代次栅栏 | 否（控制记录） |

控制记录不返回给消费者，但**仍计入扫描位置**（游标会越过它们）。

事务身份 `TxnId = { producer, epoch, txnId }` 三段组成；同名事务在不同 epoch 下互相独立。

## 读取语义

### `readUncommitted(offset, options?)`

- 返回扫描路径上的所有数据记录（含未提交、已中止事务的数据），控制记录跳过。
- 读到日志末尾时 `wait: true`；返回 `nextOffset` 作为下次扫描位置。

### `readCommitted(offset, options?)`

- 只返回普通数据与**已提交**事务的数据；已中止事务的数据跳过。
- 可读边界（LSO）= 所有未决事务首条数据 offset 的最小值；没有未决事务时边界即日志末尾。
- **请求位置 ≥ 边界时保持原位置不动并返回 `wait: true`**，日志不替调用方跳过未决事务障碍；
  待事务终结、边界推进后，调用方从同一位置继续即可顺序读到新放开的数据。
- 允许“返回空数据但推进”：当游标落在已确定中止的数据或控制记录上时，这些记录不返回，
  但 `nextOffset` 会向前推进。
- `maxRecords` 可选，分页时达到条数上限即返回（`wait: false`），下次从 `nextOffset` 继续。

### 题目场景

事务 A 先写、事务 B 后写并先提交时，B 的数据也被 A 这个最早未决事务挡在边界之后；
read_committed 停在 A 的首条数据前等待。A 中止后边界放开，从等待位置继续扫描会跳过 A 的
中止数据，顺序读到 B 的已提交数据。完整演示见 `src/demo.ts`，断言见
`test/txn-log.test.ts` 首个用例。

## 追加与终态规则

- `appendData(payload, txnId?)`：无 `txnId` 为普通数据；有 `txnId` 为事务数据。
- `appendCommit(txnId)` / `appendAbort(txnId)`：
  - **相同终态可重复应用**：幂等，不重复写记录，返回既有标记 offset 与 `idempotent: true`。
  - **冲突终态拒绝**：已提交再中止、已中止再提交均抛 `ConflictTerminalError`。
  - 对从未写过数据的事务终结抛 `TransactionNotFoundError`。
- **向已终结事务追加数据**抛 `TransactionAlreadyFinalizedError`。

## 生产者代次（epoch）

- 首次见到某生产者的事务消息时，隐式写入该 epoch 的 `fence` 记录；也可显式调用
  `appendFence(producer, epoch)`。
- 切换到更高 epoch 时，**明确中止该生产者所有旧 epoch 的未决事务**（中止点记为栅栏 offset），
  已终结事务不受影响。
- 旧 epoch 的数据与 commit/abort 消息一律抛 `StaleEpochError`——
  **旧消息不能终结新 epoch 的同名事务**。
- 栅栏只能前进不能后退；同 epoch 栅栏为幂等空操作。不同生产者的代次互相独立。

## 持久化与重放

- `snapshot()` 返回含控制记录在内的完整日志深拷贝；`TransactionalLog.replay(records)`
  可从记录序列重放出等价日志（要求 offset 从 0 连续，否则抛 `InvalidOffsetError`）。
- 测试中包含重放等价性断言：重放前后水位、事务状态、两种读取结果完全一致。

## 目录结构

```
src/
  types.ts      事务身份、日志记录、读取结果等类型
  errors.ts     分层错误类型
  txn-log.ts    TransactionalLog 核心实现
  index.ts      模块入口
  demo.ts       题目场景演示（npm run demo）
test/
  txn-log.test.ts  读取/终态/重放语义（16 个用例）
  epoch.test.ts    代次栅栏专题（8 个用例）
package.json    npm test / npm run demo
tsconfig.json   仅用于编辑器类型检查（noEmit，代码由 Node 原生擦除类型运行）
```
