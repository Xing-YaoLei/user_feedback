# 自适应 RPC 准入控制（adaptive-rpc-admission）

TypeScript / Node.js 实现的自适应 RPC 准入模块：按采样轮统计成功调用延迟，用 p90 与滑动基线动态调整并发上限，并提供 FIFO 等待、取消与独立期限。

## 运行要求

- Node.js ≥ 22.6（推荐 26，内置 TypeScript 类型擦除，无需编译器）。
- 无第三方依赖。

## 验证与启动

```bash
npm test        # 运行全部真实断言（含交错、迟到、缩容、取消、崩溃场景），失败时非零退出
npm run demo    # 合成服务演示：逐轮打印样本、基线、上限、真实占用
```

## 模块入口

- `src/admission.ts` — 核心实现（`AdmissionController`）。
- `src/index.ts` — 公共导出。
- `tests/admission.test.ts` — node:test 测试。
- `examples/demo.ts` — 可运行演示。

## 使用

```ts
import { AdmissionController, systemClock } from './src/index.ts';

const controller = new AdmissionController<Req, Res>(
  {
    initialLimit: 4,          // 初始并发数
    minLimit: 1,              // 下限
    maxLimit: 32,             // 上限
    samplesPerRound: 8,       // 每轮有效样本数 N
    baselineRounds: 3,        // 基线保留轮数 K
    tolerance: { num: 1, den: 4 }, // 延迟容忍比例（非负有理数，此处 25%）
  },
  adapter,      // { execute(req, signal) => Promise<Res> | Res }
  systemClock,  // 单调时钟：{ nowNs(): bigint }
  (report) => console.log(report), // 逐轮输出：样本、基线、上限、真实占用
);

const res = await controller.submit(req, {
  signal: abortController.signal, // 可取消
  timeoutNs: 5_000_000_000,       // 或 deadlineNs：等待阶段独立期限
});

controller.snapshot();      // 当下真实在途数、生效上限、排队数
controller.roundReports();  // 全部已封轮报告
```

## 语义要点

- **采样轮绑定**：请求在开始执行时绑定当前开放轮；每轮取最先完成的 N 个成功调用的延迟为样本。
- **延迟计量**：执行起止之间以整数纳秒计，最小记 1；失败与取消不作延迟样本。
- **p90**：样本排序后向上取整的百分位（`ceil(0.9 * n)`，1 基）。
- **基线**：含本轮在内最近 K 个已封轮 p90 的最小值。
- **上限调整**：`p90 ≤ baseline × (1 + tolerance)` 时上限 +1（不越 maxLimit）；否则
  `limit = floor(本轮起始上限 × baseline / p90)`，夹在 `[minLimit, maxLimit]`。
  容忍比例用有理数精确比较（`p90·den ≤ baseline·(den+num)`），无浮点误差。
- **封轮隔离**：封轮后旧轮迟到结果不参与新轮计算，但仍正常释放执行占用；前轮慢调用的迟到完成只减少占用，不会重新改变已封轮的决议。
- **缩容**：不取消在途调用；占用降到新上限以下才继续派发。
- **等待队列**：按到达顺序（FIFO）；每个等待者可独立取消、独立期限（仅约束等待阶段，
  派发时检查，也可周期调用 `reapExpiredWaiters()` 主动回收）。
- **执行中取消**：调用方 Promise 立即以 `CancelledError` 拒绝，但名额占用保持到适配器实际退出才归还。
- **适配器崩溃**：同步抛错或异步拒绝都按失败处理，名额立即释放，错误透传调用方。
