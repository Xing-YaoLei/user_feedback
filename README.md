# lease-registry

一个零依赖、可嵌入 Node.js 进程的服务发现注册目录（TypeScript，使用 Node 内置
测试框架与可擦除 TypeScript 类型语法，无需安装编译器）。实现了类 etcd 的核心语义：

- **全局递增修订号（revision）**：每次原子批量变更分配一个修订号；同批次的所有
  注册/删除在点查、分页和订阅中整体可见。
- **快照分页**：分页令牌绑定首次读取时的目录修订号，后续页面始终物化同一份不可变
  快照。分页进行中的新增、删除、键序变化都不会造成跨页遗漏或重复。
- **可恢复增量订阅（watch）**：从指定修订号之后接续；前缀过滤掉的修订号仍会推进
  可恢复的 progress 游标，用 `startRevision = progress + 1` 即可精确续传。
- **会话租约与代次围栏（fencing）**：实例绑定会话与 per-key 单调 generation。
  同名实例被新会话接管后，旧会话迟到的续租、删除、过期回调只能作用于旧代次，
  全部以 `GenerationConflictError` / `SessionExpiredError` 拒绝。
- **历史压缩（compaction）**：压缩保留每个 key 的最新版本（含墓碑）与代次水位；
  超出保留范围的分页/订阅游标返回明确的 `CursorExpiredError` 与重建依据
  （`RebuildBasis`：重新分页的快照修订号 + 新 watch 起点）。
- **独立的游标存活与容量限制**：分页游标与 watch 各自有 TTL、容量上限；慢订阅者
  触及积压上限时只驱逐该 watch 并携带重建依据，正常写入与其他订阅者继续推进。
- **资源回收**：关闭或过期游标后释放其历史占用；所有游标关闭并压缩后
  `retainedRevisions/retainedEvents` 归零。

## 目录结构

```
src/
  types.ts      公共类型、错误类型、注册表配置
  clock.ts      ManualClock（确定性测试时钟）/ SystemClock（墙钟）
  emitter.ts    零依赖类型化事件发射器
  registry.ts   核心注册表：租约、MVCC、批量提交、压缩、分页、watch
  client.ts     DiscoveryClient：分页全量同步 + 增量 watch + 自动重建
  scenario.ts   题目要求的完整交错执行场景（可直接 `npm run demo` 运行）
  index.ts      公共导出入口
test/
  registry.test.ts   注册表语义单元测试（22 个）
  client.test.ts     客户端适配器测试（5 个）
  scenario.test.ts   端到端交错场景断言（10 个）
```

## 运行验证

```bash
npm test     # node --test，37 个真实断言，失败时非零退出
npm run demo # 打印交错场景的每一步基线、变更批次、恢复位置与最终收敛结果
```

测试全部使用本地合成数据与调用方适配器（`ManualClock` + 内存注册表），不依赖任何
外部服务；临时数据只存在于本次工作区进程内。

## 快速上手

```ts
import { Registry, ManualClock, DiscoveryClient } from './src/index.ts';

const clock = new ManualClock();
const registry = new Registry(
  { pageTtlMs: 30_000, watchTtlMs: 60_000, watchBacklogLimit: 128 },
  clock,
);

// 1. 会话 + 一次原子批量注册（整批共用 revision 1）
registry.createSession({ id: 'billing', ttlMs: 5_000 });
registry.mutate('billing', [
  { type: 'put', key: 'services/billing/1', data: { host: '10.0.0.1' } },
  { type: 'put', key: 'services/billing/2', data: { host: '10.0.0.2' } },
]);

// 2. 分页读取：第一页绑定快照修订号，令牌在后续页复用
const page1 = registry.list({ prefix: 'services/billing/', pageSize: 1 });
const page2 = registry.list({
  prefix: 'services/billing/',
  pageSize: 1,
  pageToken: page1.nextPageToken!,
});
// page1.revision === page2.revision —— 同一份不可变快照

// 3. 拿到快照修订号后接续订阅，恰好接收该修订号之后的变更
const watch = registry.watch({
  prefix: 'services/billing/',
  startRevision: page1.revision + 1,
});
const messages = watch.consume();      // WatchMessage[]
const progress = watch.progress;        // 可恢复游标（含被前缀过滤的修订号）

// 4. 代次围栏：新会话接管同名实例
registry.createSession({ id: 'billing-2', ttlMs: 5_000 });
registry.mutate('billing-2', [
  { type: 'put', key: 'services/billing/1', data: { host: '10.0.0.9' } }, // generation 2
]);
// 旧会话的迟到操作被拒绝，且不产生新修订号
registry.keepAlive('billing', { key: 'services/billing/1', generation: 1 }); // throws
registry.mutate('billing', [
  { type: 'delete', key: 'services/billing/1', expectedGeneration: 1 },       // throws
]);

// 5. 压缩后过期游标返回明确的重建信号
registry.compact(registry.currentRevision);
try {
  watch.consume();
} catch (error) {
  // error.rebuildBasis.snapshotRevision -> 重新分页的基线
  // error.rebuildBasis.resumeAfterRevision -> 新 watch 起点 = 该值 + 1
}

// 6. 高层适配器：自动分页同步 + watch 收敛 + 游标过期后自动重建
const client = new DiscoveryClient(registry, { prefix: 'services/' });
client.start();
client.pumpWatch();
client.listInstances();
```

## 关键语义说明

### 修订号与批量原子性

`mutate(sessionId, mutations[])` 先对整批做校验（会话存活、代次匹配、同批次不得
重复操作同一 key），任一失败则整批回滚、不分配修订号；校验通过后所有事件共用一个
新修订号写入 MVCC 版本链并一次性对所有读和 watch 可见。会话过期触发的摘除同样是
一个独立批次（一个修订号），且会跳过已被其他会话接管的 key。

### 分页快照

`list()` 首次调用把当前修订号写进不透明令牌（base64url 编码，内含游标 id、快照
修订号、前缀）。后续页面用 `lastKey` 键边界（而非数组下标）在该修订号的物化快照上
重新切片，因此快照之后的插入/删除/重排既不会漏行也不会重复。TTL 到期、容量 LRU
驱逐、历史压缩都会使下一次用令牌读取抛出带原因（`liveness` / `capacity` /
`compacted`）的 `CursorExpiredError`。

### watch 进度与积压

- 每个 watch 维护 `lastProgress`：每观察到一个修订号就推进，即使该修订号的事件全部
  被前缀过滤。空队列 `consume()` 返回合成的 progress 心跳，恢复时传
  `startRevision = progress + 1` 不会重放任何旧修订号。
- backlog 只统计实际排队、尚未消费的匹配变更消息数；显式历史重放（resume）直接
  入队，由消费方在下一次 `consume()` 排空。实时投递使 backlog 超过
  `watchBacklogLimit` 时，该 watch 被单独驱逐（reason `backlog`），写入路径和其他
  watch 不受影响。

### 压缩与代次水位

`compact(targetRevision)` 删除不高于目标修订号的修订日志与旧 key 版本，保留：
修订日志中目标之后的全部记录、每个 key 不高于目标的最新版本（墓碑保留，使删除在
压缩后仍不可见且 point read 返回 null），以及独立的 per-key generation 水位。因此
压缩后重新注册同名实例，generation 仍然严格单调。无法从保留历史满足的游标立即收到
`cursorExpired` 事件，并在下一次使用时抛出 `CursorExpiredError`。

## 场景脚本记录的内容

`src/scenario.ts` 在一个 `ManualClock` 上确定性地编排：分页进行中批量摘除 →
同名实例被新会话重注册（代次 2）→ 旧会话迟到续租/删除被围栏 → 旧会话过期 →
慢订阅者积压超限被驱逐（带重建依据）→ 健康订阅者持续推进 → 前缀过滤的修订号
跳跃进入 progress → 历史压缩 → 过期分页令牌与旧 watch 游标返回重建信号 →
客户端按重建依据重新分页并在快照修订号之后接续 watch → 最终重建目录与注册表在
选定修订号上完全一致。每一步的时间、每页基线、变更批次、恢复位置都记录在返回的
`ScenarioReport` 中，`test/scenario.test.ts` 对其做完整断言。
