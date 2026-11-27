# 分区日志消费恢复模块

分区日志换主并截断后，原 offset 可能被新分支内容复用，仅比较日志长度无法判断消费位置是否仍在同一分支。本模块基于 **leaderEpoch 证明 + 日志 token 绑定** 恢复消费位置，调用方无需自行猜测位点。

## 核心语义

- **本地票据**（`TicketStore`）：按顺序保存已经历的 `leaderEpoch` 及各自确认处理到的下一 offset（`nextOffset`，不含）。提供内存实现与崩溃安全的文件实现（临时文件 + rename）。
- **broker 适配器**（`BrokerAdapter`）：
  - `getLogSnapshot()` → 当前日志 token、保留起点、日志末端；
  - `queryEpoch(epoch, token)` → 该 epoch 在当前历史中的有效末端，或已不再保留的证明；回包携带计算时基于的 token；
  - `waitForTokenChange(token)` → token 变更通知；
  - `fetch(offset, token)` → 原子校验 token，拒绝把新分支数据冒充旧 token 的数据返回。
- **恢复算法**（`recoverPosition`）：相同 epoch 代表同一日志分支前缀。从票据最新 epoch 向最旧逐个求证，第一个双方都有证明的共同 epoch 即恢复点，位置取 `min(本地该 epoch 已处理边界, broker 该 epoch 有效末端)`。

## 恢复结论（`RecoveryOutcome`）

| 结论 | 含义 |
| --- | --- |
| `recovered` | 输出恢复位置 + 预期 token，调用方用 `resumeConsumption` 绑定该 token 发起首次 fetch |
| `reset-required` | 没有共同 epoch 证明，或推得位置早于保留起点 —— 要求调用方明确重置，**绝不静默跳到最新** |
| `undetermined` | 查询预算耗尽（`query-budget-exhausted`）或 token 持续不稳定（`token-unstable`） |

## 一致性保证

- 一轮内的多次 epoch 查询与首次继续 fetch 绑定**同一日志 token**；轮内 token 变更（查询被拒 / token watch 触发 / 回包 token 不符）→ 丢弃本轮全部推导，用新快照重做。
- 轮次作废后到达的**迟到回包**只计入 `stats.discardedLateReplies`，不会覆盖已经确定的新恢复结果。
- 适配器在 fetch 时**原子校验**预期 token；恢复结果确定后 token 再变，旧 token 的 fetch 被拒绝，调用方重新恢复即可。

## 目录结构

```
src/types.ts             公共类型与适配器契约
src/ticket-store.ts      本地票据（内存 / 文件实现，含校验）
src/recovery.ts          恢复算法 + resumeConsumption
src/simulated-broker.ts  本地合成 broker（换主截断 / 保留推进 / 故障注入）
src/index.ts             模块入口
examples/demo.ts         端到端演示
tests/recovery.test.ts   测试（含交错与崩溃场景）
```

## 运行

无需安装依赖（Node ≥ 22.6，直接运行可擦除类型的 TypeScript）：

```bash
npm test    # 运行全部测试（node:test，断言失败非零退出）
npm start   # 运行演示：崩溃 → 换主截断 → 恢复 → 继续消费
```

测试的临时数据全部落在 `tests/tmp/`（工作区内），结束后自动清理。
