# 网关共享缓存（Gateway Shared Cache）

用 TypeScript 在 Node.js 上实现的 HTTP 网关共享缓存。源站请求与时钟均由调用方注入，
响应正文以字节缓冲区（`Buffer`）保存，支持完整响应、单段 bytes 范围与条件校验的缓存复用。

## 运行环境

- Node.js >= 22（使用内置 `node:test` 与原生 TypeScript 可擦除类型语法，无需安装编译器或依赖）
- 无需 `npm install`，没有第三方运行时依赖

## 运行测试

```bash
npm test
```

该命令运行 `test/` 下全部真实断言测试，覆盖正常命中、片段补齐、条件响应、并发共享与
取消、LRU 回收以及 purge 交错；断言失败时进程以非零码退出。

## 模块入口

- `src/index.ts`：公共 API 导出。
- `src/cache.ts`：`GatewayCache` 核心实现。
- `src/headers.ts`：头部、Cache-Control、ETag、Range/Content-Range 解析。
- `src/ranges.ts`：字节片段的插入合并、缺口计算、覆盖判定与读取。
- `src/freshness.ts`：新鲜度、Age、可存储性与服务决策（RFC 9111 共享缓存语义）。
- `src/types.ts`：注入式时钟、源站适配器与请求/响应类型。

## 调用方接入

```ts
import { GatewayCache } from './src/index.ts';
import type { OriginFetch, Clock } from './src/index.ts';

// 1) 实现源站适配器：接收带 AbortSignal 的请求，返回状态码 + 头部 + Buffer 正文
const origin: OriginFetch = async (req) => {
  const res = await fetch(req.uri, { headers: req.headers, signal: req.signal });
  const body = Buffer.from(await res.arrayBuffer());
  return { status: res.status, headers: Object.fromEntries(res.headers), body };
};

// 2) 可选：注入时钟（测试用确定性时钟；生产环境可省略，默认 Date.now）
const clock: Clock = { now: () => Date.now() };

const cache = new GatewayCache({ maxBytes: 1024 * 1024, origin, clock });

// 3) 处理 GET；signal 可选，用于调用方独立取消
const resp = await cache.get({
  method: 'GET',
  uri: 'http://origin.test/doc',
  headers: { range: 'bytes=0-99' },
  signal: aborter.signal,
});
// resp: { status: 200 | 206 | 304, headers, body: Buffer }

// 逐 URI 清除（在途回源不中止，但其迟到结果不会写回）
cache.purge('http://origin.test/doc');

// 观察实际保留的正文区间字节与各表示明细
cache.stats();
```

## 语义与设计要点

### 表示与片段

- 每个 URI 维护若干「表示」，表示由 **Vary 变体 + 强校验器（ETag）+ 总长度** 确定。
- 正文以互不重叠、相邻即合并的字节片段保存。两个片段只有在属于同一变体、同一强 ETag
  且总长度一致时才允许合并；否则建立新表示，绝不混用不同版本的字节。
- 已覆盖的范围直接命中并合成 `206`；缺失范围计算缺口并集后回源补齐。
- 容量按实际保留的区间字节核算，区间重叠通过片段合并不重复计数；超限按 LRU 回收。

### HTTP 缓存规则

- 新鲜度：共享缓存优先 `s-maxage`，其次 `max-age`，再退到 `Expires - Date`；
  正确计算并在响应中更新 `Age`。
- 指令：`no-cache`（存储但每次重验证）、`no-store`/`private`（不入共享缓存）、
  `must-revalidate`/`proxy-revalidate`（过期禁止放行陈旧内容）。
- 请求端指令：`no-cache`、`max-age`、`max-stale`、`min-fresh`。
- 带 `Authorization` 的响应默认不缓存，仅在 `must-revalidate` / `proxy-revalidate` /
  `public` / `s-maxage` 明确授权时才进入共享缓存。
- 条件请求：网关自身重验证发 `If-None-Match`/`If-Modified-Since`；调用方的条件请求在
  新鲜表示上直接合成 `304`。`If-Range` 与当前强校验器失配时回退为完整 `200`。

### 并发、取消与清除

- 同 URI 同请求键的回源在「响应可合法复用」前提下共享，等待者拿到同一份响应。
- 每个等待者可独立取消：取消立即让该等待者失败并摘除；最后一个等待者离开时才中止
  仍未完成的回源（通过注入的 `AbortSignal`）。
- `purge(uri)` 不中止在途回源，已发起的调用仍能拿到响应；但条目身份失效后，迟到的
  `200/206` 不会重新填回，迟到的 `304` 只能更新它确实验证过、且仍存在的表示。

## 测试中的可控源站

`test/helpers/origin.ts` 提供 `ControlledOrigin`（可切换资源版本、记录每次回源的范围与
条件头部、支持 `AbortSignal`）、`Gate`（挂起/放行回源以复现交错）和 `ManualClock`
（手动推进时间）。测试仅通过三类可观察量判断结果：返回字节、回源范围/次数、缓存占用。
