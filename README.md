# 服务网格节点健康与选路模块

根据真实调用结果调整可选节点：滑动窗口评分、连续失败隔离（按轮次退避、名额上限）、
隔离到期后的受控探测恢复，凭证绑定节点代次与健康阶段，迟到结果只进诊断记录。

## 运行环境

- Node.js ≥ 22.6（开发验证使用 v26.8.1），利用内置 TypeScript 类型擦除直接运行 `.ts`，无需编译器、无第三方依赖。
- 测试使用 Node 内置测试框架（`node:test`）+ 本地合成数据与调用方适配器，不依赖真实外部服务。

## 验证与启动

```bash
npm test    # 运行全部真实断言（含跨地域交错场景），断言失败时非零退出
npm start   # 运行演示脚本（选路 → 隔离 → 探测恢复，打印事件轨迹与快照）
```

## 模块入口

- `src/index.ts` → `createHealthRouter(config)` / `HealthRouter`
- `src/health-router.ts` → 全部类型与实现

```ts
import { createHealthRouter } from './src/index.ts';

const router = createHealthRouter({
  clock: () => now,                 // 时钟由调用方注入
  policy: {
    windowMs: 300,                  // 滑动统计窗口
    consecutiveFailureThreshold: 2, // 连续失败阈值
    maxIsolations: 2,               // 隔离数量上限（按服务计）
    baseIsolationMs: 200,           // 隔离期基础时长（按连续轮次指数退避、封顶）
    isolationBackoffFactor: 2,
    maxIsolationMs: 1000,
    probe: { concurrency: 2, successThreshold: 2, roundMs: 100 },
  },
  services: {
    svc: {
      regionPriority: ['east', 'west'],          // 地域优先级
      nodes: [{ id: 'a', region: 'east', generation: 1 }], // 节点代次
    },
  },
});
```

## API 摘要

| 方法 | 说明 |
| --- | --- |
| `acquire(service, { allowDegraded? })` | 领取流量凭证。健康候选按地域优先级 + 节点ID；无健康候选且显式 `allowDegraded` 时在待隔离节点中按失败评分 + 节点ID 稳定选择；否则返回 `unavailable`（暂不可用） |
| `acquireProbe(service)` | 领取探测凭证。每轮最多并发 `probe.concurrency` 个；无名额返回 `none` |
| `report(credential, outcome)` | 报告结果：`success` / `remote-error` / `cancelled` / `local-timeout`。未知凭证抛错 |
| `setNodes(service, nodes)` | 更新节点集合；代次变更视为新节点并重置健康状态 |
| `inspect(service)` | 快照：候选集合、各节点状态/阶段/评分/窗口计数/探测轮信息 |
| `events()` / `diagnostics()` | 状态迁移事件轨迹、迟到/重复结果的诊断记录 |
| `tick()` | 显式推进时钟驱动的迁移（每次调用其它方法时也会惰性推进） |

## 关键语义

- **滑动窗口**：远端结果（成功/远端错误）按完成时刻（report 时的注入时钟）进入窗口，
  评分 = 远端错误 / 有效样本；调用方取消与本地排队超时单独计数，不进窗口。
- **隔离**：连续远端失败达阈值 → 隔离；隔离期 `base * factor^(轮次-1)` 封顶。
  名额（isolated + probing）触顶后，其余异常节点保持**待隔离**，普通选路避开；
  名额释放后按错误率高→低、节点ID 小→大补入。
- **探测恢复**：隔离到期开启一轮探测（有截止时间），累计 `successThreshold` 个有效成功才恢复；
  任一远端失败或截止到达 → 重新隔离（轮次 +1）；取消/本地超时的探测归还名额以便补充。
- **凭证**：绑定节点代次与健康阶段（每次状态迁移阶段 +1）。旧代次/旧阶段的迟到结果、
  重复报告只进诊断记录——不能关闭新的隔离轮次，也不占用新一轮探测名额。
- **一致性**：多个探测同时完成时按 report 顺序逐个原子应用，状态转换与其后的选路结果彼此一致。

## 目录结构

```
src/health-router.ts   核心实现（类型 + HealthRouter + createHealthRouter）
src/index.ts           模块入口（re-export）
src/demo.ts            演示脚本（npm start）
test/health-router.test.ts  单元测试（窗口/阈值/上限/退避/探测/凭证/一致性）
test/scenario.test.ts       跨地域交错场景：窗口淘汰、隔离上限触顶、取消探测、旧成功回报
```
