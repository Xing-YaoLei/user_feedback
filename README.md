# 请求拦截器运行模块（Interceptor Runtime）

在 Node.js（原生 TypeScript 类型擦除，无需编译器、无第三方依赖）上实现的请求拦截器运行模块。
拦截器插件接收 `(ctx, next, signal)`，可以：

- 调用 `next()` 进入后续链路（洋葱模型，每个 `next` 只允许调用一次）；
- 通过 `ctx.deferCleanup(fn)` 登记异步清理动作；
- 通过 `ctx.spawn()` 递归发起经过**同一套拦截器**的子请求；
- 通过 `ctx.response` 输出响应流；
- 通过 `ctx.signal` 感知取消，并由 `ctx.reportDiagnostic` 上报迟到事件。

## 运行环境

- Node.js >= 22.6（开发与验证使用 Node v26，依赖内置 `node:test` 与可擦除 TypeScript 语法）
- 无需 `npm install`，无第三方运行时依赖。

## 快速开始

```ts
import { InterceptorRuntime } from './src/index.ts';
import type { Interceptor } from './src/index.ts';

const chain: Interceptor[] = [
  async (ctx, next) => {
    ctx.deferCleanup(() => console.log('L0 cleanup（最先注册、最后执行）'));
    await next();
  },
  async (ctx, next) => {
    // 发起一个经过同一套拦截器的子请求
    const child = await ctx.spawn({ id: `${ctx.scopeId}>child` });
    console.log('子请求结果：', child.status, child.scopeId);
    await next();
  },
  async (ctx) => {
    ctx.response.write('hello');
    ctx.response.end();
  },
];

const runtime = new InterceptorRuntime(chain);

// 并发的根请求之间完全隔离
const outcome = await runtime.dispatch({ id: 'root-1' });
console.log(outcome);
```

## 测试

```bash
npm test
```

- 使用 Node 内置测试框架（`node --test`），运行真实断言；
- 覆盖主场景（两个并发根请求：重入自身、遗漏 await `next`、取消后迟到失败；另一条持续输出响应流）
  与单元语义（重复 next、取消传播、流错误、上下文隔离、错误去重与稳定排序、深层嵌套清理等）；
- 断言失败时进程以非零码退出；所有数据均为测试内合成，不访问任何外部服务。

## 核心语义

### 1. 在途执行跟踪（即使插件遗漏 await）

每个被调用的 `next()` 都计入所在作用域的 `pendingCount`。插件提前 `return` 而没有 `await`
已启动的后续链路时，运行模块仍通过 `track()` 跟踪那段 Promise；清理边界会 `whenIdle()`
等待它**真正退出**后才开始清理。所有游离 Promise 都同步挂有兜底 rejection 处理器，
不会产生 `unhandledRejection`。

### 2. 子请求、上下文继承与修改视图

- `ctx.spawn()` 创建子作用域，子请求经过同一套拦截器链；
- 子上下文以父上下文为**原型**：读操作穿透到父级，写操作只落在子视图（兄弟请求、并发根请求互不可见）；
- 子作用域拥有独立的 `scopeId`、取消信号、响应流、清理队列，但 `requestId` 始终是原根请求 ID；
- 子请求的 Promise 在创建当刻就带兜底处理器，调用方何时 `await` 都不会产生异步 rejection 警告。

### 3. 取消传播

- 父作用域 `abort` 时用同一 `reason` 向下传播到全部已存在的子作用域；
- 取消后**停止接收新的子请求**：`spawn()` 立即以 `AbortError` 拒绝，且不会创建新作用域；
- 已经开始的执行不会被强行打断，而是等其自行退出后再进入清理。

### 4. 分层清理边界

作用域关闭（`close()`）严格按以下顺序：

1. 等待本作用域全部在途执行退出；
2. 等待所有子作用域关闭（子作用域内部递归遵循同一顺序 → **先子后父**）；
3. 等待仍在输出的响应流终结：取消时销毁（`destroyed`），业务失败时以流错误结束（`error`）；
4. 本作用域清理动作按**逆注册顺序**逐个 `await`，单个清理失败不阻断其余清理；
5. 标记关闭并唤醒等待者。

### 5. 错误模型

- **业务错误优先于清理错误**；
- 同类错误稳定排序：跨作用域按作用域创建序号（`scopeSeq`），作用域内业务错误按发生序号、
  清理错误按清理注册序号；
- 结果保留 `mainError` 与 `additionalErrors`（原始错误对象引用不变）；
- **同一异常沿多层 `next` 传播只记录一次**：运行时级别按对象引用（`WeakSet`）/原始值去重；
- `dispatch`/`spawn` 失败时 reject 的错误上附带 `outcome` 字段，包含完整结果。

### 6. 响应流与迟到调用诊断

- 响应流的 `end`/`fail`/`destroy` 是终结动作，生命周期内最多生效一次（`responseTerminationCount` 恒 ≤ 1）；
- 响应已开始输出后发生业务失败，以**流错误**终结并保留清理诊断；
- 作用域关闭之后的迟到 `next`、迟到 `spawn`、迟到清理登记、迟到流终结、迟到业务失败，
  均通过诊断入口 `runtime.getDiagnostics()` / `getDiagnosticsFor(requestId)` 报告，
  每条 `DiagnosticEvent` 都带原请求 ID、作用域 ID 与时间戳。

## 目录结构

```
src/
  index.ts            模块公共出口
  runtime.ts          InterceptorRuntime：根请求调度、并发隔离、错误去重、诊断入口
  scope.ts            RequestScope：洋葱调度、在途跟踪、取消传播、分层清理、错误排序
  response-stream.ts  ResponseStream：单次终结保证与迟到终结诊断
  diagnostics.ts      DiagnosticCollector：带请求 ID 的诊断收集器
  types.ts            公共类型
test/
  runtime.test.ts     主场景（两个并发根请求的完整交错/崩溃/取消/清理观察）
  unit.test.ts        单元语义测试
  helpers.ts          测试辅助
```

## 主要入口类型

- `new InterceptorRuntime(chain: Interceptor[])`
- `runtime.dispatch(options?: { id?; signal?; init?; chain? }): Promise<RequestOutcome>`
- `runtime.cancelRoot(requestId, reason?)` / `runtime.cancelAll(reason?)`
- `runtime.settleAll(): Promise<RequestOutcome[]>`
- `runtime.getDiagnostics()` / `runtime.getDiagnosticsFor(requestId)`
- 插件上下文：`ctx.deferCleanup` / `ctx.spawn` / `ctx.response` / `ctx.signal` / `ctx.reportDiagnostic`
