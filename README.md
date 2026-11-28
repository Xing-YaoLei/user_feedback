# SWIM 风格成员协议（TypeScript / Node.js）

一个零外部依赖、可完全控制时钟与网络的成员协议模块。节点通过少量邻居探测维护成员视图：
直接 ping 失败后升级为指定数量助手参与的间接探测，仍无有效应答才进入**有期限的怀疑**，
怀疑期内没有更高声明序号的反驳才确认死亡。所有状态更新随探测报文以流言方式传播，
并通过周期性摘要交换（anti-entropy）补足丢失的更新。

仅使用 Node 内置测试框架与原生 TypeScript 类型擦除，无需安装编译器或第三方包即可运行。

## 快速开始

```bash
npm test
```

`npm test` 运行 `node --test test/`，包含真实断言以及题目要求的全部交错/崩溃场景，
断言失败时进程以非零码退出。所有数据均为测试内合成数据，不访问任何外部服务。

要求 Node >= 22.6（开发验证环境为 Node v26.8.1）。

## 模块入口

```ts
import {
  MembershipNode,          // 协议节点
  VirtualClock,            // 确定性虚拟时钟
  InMemoryTransport,       // 可控的内存传输（链路断开 / 暂停 / 截留恢复）
  createRoundRobinSelectors,
  defaultSelectors,
  mergeUpdate, compareEntries, // 纯状态合并规则，可独立单测
} from './src/index.ts';
```

- `src/types.ts` — 身份、成员记录、报文、配置等全部类型
- `src/membership.ts` — 纯函数化的状态比较与合并规则（协议语义核心）
- `src/node.ts` — `MembershipNode`：探测状态机、反驳、怀疑定时器、流言队列、摘要同步、审计
- `src/clock.ts` — `VirtualClock`：时间只在 `advance()` 时前进，定时器按时间顺序同步触发
- `src/transport.ts` — `InMemoryTransport`：定向链路 up/down、节点暂停/恢复、报文历史与统计

## 节点身份与状态优先级

身份 = 稳定 ID + 启动代次 `incarnation` + 存活声明序号 `seq`。
状态为 `alive | suspected | dead | left`，其中 `dead`/`left` 终结当前代次身份。

合并两条同一 ID 的记录时（`compareEntries` / `mergeUpdate`）：

1. **代次优先**：严格更大的 `incarnation` 覆盖一切（同 ID 重启）；旧代次流言/迟到应答一律拒绝。
2. 同代次内 `dead`/`left` 终结身份，同代次任何后续记录都不能推翻；`left` 优先于 `dead`。
3. 非终结记录先比较 `seq`：更大的存活声明序号构成对怀疑的反驳。
4. 同 `seq` 下状态强度：`left > dead > suspected > alive`（同序号怀疑优先于存活）。
5. **完全相同的怀疑是 no-op**：保留首次的 `suspectDeadline`，重复传播不会延长怀疑期限。

## 探测状态机

```
ping（直接探测，绑定轮次 round 与目标身份快照）
  ├─ 有效 ack（轮次 + 稳定 ID 匹配，身份为当前或更新）→ 探测成功
  └─ directTimeout → indirect-ping 发给 k 个助手
        ├─ 助手 ping 目标并回 indirect-ack(success=true) → 探测成功
        └─ indirectTimeout 仍无有效应答 → 提出有期限怀疑（suspectTimeout）
              ├─ 期限内收到更高 seq 的 alive（节点自我反驳）→ 解除怀疑
              └─ 期限到达仍未反驳 → dead，并继续随流言传播
```

- 应答严格绑定**具体探测轮次**与**目标稳定 ID**；旧轮次、旧身份的迟到 ack 记入
  `stale-ack-ignored` 审计并丢弃，不能回滚状态。
- 活节点收到针对**当前身份**的怀疑时，提升自己的 `seq` 发出 alive 反驳（`refutation`）。
- 已确认死亡的身份只能以更高 `incarnation` 重新加入（`restart()`）；旧代次的持续流言
  （alive/suspected/dead）全部被拒绝，无法复活旧身份。
- 主动 `leave()` 生成终结性 `left` 更新并立即传播，同时停止本节点后续探测；
  同代次内 `left` 不会被后到的 `dead` 覆盖。

## 有界传播与摘要修复

- 每个出站报文附带的流言更新数受 `maxPiggyback` 限制。
- 待转发队列受 `maxPendingQueue` 限制，每个成员 ID 只保留最新一条；队列满时淘汰最旧条目
  （审计 `pending-evict`），同一 ID 的就地替换不刷新其排队位置。
- 每个报文都携带当前视图摘要；接收方用 `scanDigest` 摄入自己缺失或落后的记录。
- 周期性 `digest-sync` 双向交换摘要并回传完整差异记录，保证报文/队列上限导致的丢失最终被修复。
- 已死/已离开节点仍参与摘要候选，从而能够发现其高代次重启；但不会再被直接探测。

## 可控性

- **时钟**：`VirtualClock.advance(ms)` 手动推进，无真实定时器，测试完全确定。
- **目标选择**：`Selectors.pickTarget / pickHelpers / pickDigestPeer` 全部可注入；
  测试用 `forcedTargetSelector` 强制探测目标，用轮询选择器保证所有邻居被覆盖。
- **传输**：`setBidirectionalLink` 控制链路通断，`pauseNode/resumeNode` 截留并按序补发报文，
  用于构造迟到消息与暂停-恢复交错。

## 场景与测试映射

| 需求验证点 | 测试文件 / 用例 |
| --- | --- |
| 直接链路断开但间接探测成功 | `test/indirect-probe.test.ts` |
| 被怀疑节点暂停后恢复、提升 seq 反驳 | `test/suspicion.test.ts`（resume before deadline） |
| 怀疑期限到达未反驳则确认死亡 | `test/suspicion.test.ts`（unrefuted → death） |
| 确认死亡后同 ID 高代次重启 | `test/restart.test.ts`（restart with incarnation 2） |
| 旧流言持续回流不能恢复旧身份 | `test/restart.test.ts`（stale gossip reflow） |
| 重复怀疑不延长期限 | `test/restart.test.ts` + `test/membership.test.ts` |
| 代次/序号/状态优先级、left 优先 dead | `test/membership.test.ts` |
| 主动离开传播并终结探测 | `test/convergence.test.ts`、`test/protocol-rules.test.ts` |
| 报文附带数与待转发队列上限 | `test/convergence.test.ts`（bounded piggyback / pending queue） |
| 摘要交换补足丢失更新 | `test/convergence.test.ts`（digest repair） |
| 稳定网络下身份与状态收敛一致 | `test/convergence.test.ts`（convergence） |
| 迟到旧应答不能回滚身份 | `test/protocol-rules.test.ts` |
| 每次怀疑/反驳/死亡决定可解释 | 节点 `getAuditLog()`，`test/protocol-rules.test.ts` |

## 审计轨迹

每个节点通过 `getAuditLog()` 返回带虚拟时间戳的决策记录，事件包括
`probe-direct-start`、`probe-indirect-start`、`probe-success`、`indirect-probe-failed`、
`suspicion-raised`、`duplicate-suspect-ignored`、`refutation`、`death-confirmed`、
`alive-accepted`、`dead-accepted`、`left-accepted`、`stale-ack-ignored`、
`stale-indirect-ack-ignored`、`pending-evict`、`restart`、`leave` 等，
可据此完整解释每一次怀疑、反驳与死亡决定。
