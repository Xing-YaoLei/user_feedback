# lease-lock-coordinator

运行在 Node.js 上的锁协调模块：调用方通过**带租约的会话**创建事务，按资源名称申请
**共享锁 / 独占锁**，支持整批申请、共享→独占升级、FIFO 防插队、等待图死锁检测、
事务截止时间、会话过期、取消通知，以及每次独占授权的 **fencing token** 写入凭证校验。

时钟完全由调用方注入（测试使用可手动步进的 `ManualClock`），模块自身不读取墙钟。

## 运行环境与入口

- Node.js ≥ 22.6（开发与验证使用 v26.8.1），直接运行 TypeScript（可擦除类型语法，无需编译器/依赖安装）
- 统一验证入口：

```bash
npm test
```

断言失败时 `node --test` 以非零码退出。所有数据均为测试内合成数据，不依赖任何外部服务。

```bash
# 手动步进的可运行示例
node examples/demo.ts
```

## 模块结构

| 文件 | 职责 |
| --- | --- |
| `src/index.ts` | 公共导出入口 |
| `src/types.ts` | 公共类型（锁模式、事件、快照、注入时钟接口等） |
| `src/clock.ts` | `ManualClock`（可逐步推进、带推进监听）与 `SystemClock` |
| `src/errors.ts` | `CoordinatorError` 及中止原因 → 错误码映射 |
| `src/lock-coordinator.ts` | 协调器全部核心逻辑 |
| `test/lock-coordinator.test.ts` | 19 个真实断言测试（含交错、死锁、过期场景） |

## 核心规则与实现位置

1. **带租约的会话 + 事务**
   - `createSession({ leaseLength })` 建立租约，`startTransaction(sessionId, { deadline })` 由协调器分配
     严格递增的创建序号 `seq`，死锁受害者选择只使用该序号。
   - `renewSession` 在租约有效时从当前时刻重算到期点；**到期当刻及之后的续租一律拒绝**，
     旧会话不会被迟到的续租恢复。

2. **整批共同授权（all-or-nothing）**
   - `acquire(tx, requests)`：一批中每个资源要么全部立即授权，要么作为一个等待组
     （`PendingGroup`）整体进入各资源 FIFO 队列尾；等待期间不产生部分持锁。
   - 已以足够模式持有的资源直接从持锁关系应答，不重复排队；同批重复资源合并为更强模式。

3. **等待升级保留原锁**
   - 共享→独占升级时，事务在整个等待期间继续持有原共享锁；队列条目以 `isUpgrade` 标记。

4. **FIFO 与防插队**
   - 每资源独立队列。队首为独占申请时，后来的共享申请也必须等待，不能越过独占申请获锁；
   - 互不冲突的其他资源由 `pump()` 每轮全量扫描继续独立授权，不会被某条阻塞队列卡住。

5. **等待图与死锁受害者**
   - 边的方向严格指向阻塞者：非队首条目 → 其前方所有排队事务；队首条目 → 该资源当前持锁者。
     普通 FIFO 队列因此只形成链而不形成环。
   - Tarjan SCC 找环；对每个成环 SCC，选择其中 `seq` 最大（最近创建）的事务作为受害者，
     **只在环内选择**，环外更年轻的事务不受牵连。
   - 受害者被终止：撤销等待（Promise 以 `DEADLOCK` 拒绝）、释放全部锁，随后 `pump()`
     继续推进其余申请。入队时与队列推进后（环可能延迟闭合）两个时机都会检测。

6. **取消 / 截止时间 / 会话过期**
   - `cancel`、事务 `deadline` 到达、会话租约到期都会终止事务：撤销等待、释放全部锁、
     发出 `transaction-end` 事件，并唤醒后续等待者。
   - 已结束的事务 ID 永久失效：ID 保留在索引中，后续任何引用都抛 `TRANSACTION_ENDED`。

7. **Fencing token 与写入凭证**
   - 每个资源维护独立严格递增计数器，**每次独占授权（含升级）都发放新 token**。
   - `validateFencingToken(tx, resource, token)` 仅在以下条件全部满足时返回 `true`：
     事务仍活跃且会话租约未过期、仍持有该资源独占锁、token 恰好是当前持有对应的那一个。
     释放、降级、过期、提交后，旧凭证立即永久失效。

8. **交错安全**
   - 时钟推进监听器在每个时间步同步处理过期与截止；`pump()` 带重入守卫；
     失效请求在被撤销的同时移出队列，任何后续推进都不会给它补发锁。

## 公共 API 速览

```ts
const clock = new ManualClock(0);
const coordinator = new LockCoordinator(clock);

coordinator.onEvent((e) => /* grant | transaction-end */);
const sessionId = coordinator.createSession({ leaseLength: 100 });
const txId = coordinator.startTransaction(sessionId, { deadline: 90 });

const locks = await coordinator.acquire(txId, [
  { resource: 'accounts/42', mode: 'shared' },
  { resource: 'ledger', mode: 'exclusive' },
]);

coordinator.renewSession(sessionId, 100);
coordinator.validateFencingToken(txId, 'ledger', locks[1]!.fencingToken!); // true

coordinator.release(txId, ['ledger']);
coordinator.commit(txId);   // 或 rollback / cancel
clock.advance(50);          // 手动推进逻辑时间，触发截止与过期
```

错误均为 `CoordinatorError`，`code` 取值：`INVALID_REQUEST`、`TRANSACTION_ENDED`、
`SESSION_EXPIRED`、`CANCELLED`、`DEADLINE_EXCEEDED`、`DEADLOCK`。

## 验证覆盖（20 个测试）

- 共享/独占兼容性、独占队首阻挡共享插队、独立资源不被阻塞
- 整批 all-or-nothing、跨资源批次与后续排队者的活性、多批申请
- 两事务相互升级死锁、三节点环、环外年轻事务不被选为受害者、失效请求不补发
- token 逐资源严格递增、升级发新 token、旧凭证释放/过期后失效
- 续租边界、迟到续租拒绝、截止时间、取消通知、结束 ID 永久失效、等待批次未决时的操作约束
- 题目要求的端到端步进场景（相互升级 → 第三笔跨资源申请 → 会话过期 → 旧凭证校验）
- 续租 / 等待升级 / 超时回调 / 取消通知交错一致性
