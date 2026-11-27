# 计数 Bloom 兴趣摘要（Counting Bloom Interest Summary）

面向联邦 Broker 的计数 Bloom 摘要模块。两个主题落在同一组计数位时，撤销其中一个
**只减去该主题自己的一份贡献**，不会把另一个有效订阅的计数清零——允许碰撞、多转发，
始终不漏掉有效订阅（零假阴性，允许 Bloom 固有的假阳性）。

纯 TypeScript、零运行时依赖，基于 Node.js 内置 TypeScript 类型擦除与内置测试框架，
无需安装编译器或任何第三方包。

## 运行环境

- Node.js >= 22.6（开发验证版本：v26.8.1，npm 11.19.0）
- 无需 `npm install`（无第三方依赖）

## 运行测试

```bash
npm test
```

`npm test` 执行 `node --test test/`，运行 `test/` 下全部真实断言，覆盖碰撞计数、
幂等登记/撤销、共享主题最后撤销、位置去重、2000 步随机交错对账、崩溃重放，以及
分步重建的暂停/继续/放弃/预算中止/发布切换/多代次连续重建等场景。断言失败时进程
以非零码退出。

## 快速上手

```ts
import { CountingBloomSummary } from './src/index.ts';
import type { BloomConfig } from './src/index.ts';

// 哈希参数与向量容量由调用方指定
const config: BloomConfig = { size: 64, hashes: 4, seed: 42 };
const summary = new CountingBloomSummary(config);

// 登记身份 = (订阅者, 主题)
summary.register('broker-1', 'orders/eu');
summary.register('broker-2', 'orders/eu'); // 多订阅者共享同一主题
summary.register('broker-1', 'orders/eu'); // 重复登记：无额外影响

// 查询只访问该主题对应的哈希位置，全部 >0 才判“可能有订阅”
summary.hasSubscription('orders/eu'); // true

summary.unregister('broker-1', 'orders/eu'); // 仍有 broker-2，主题贡献保留
summary.unregister('broker-2', 'orders/eu'); // 最后一个撤销：移除主题贡献

// 与按当前有效主题集合直接重建的参考向量逐项对照
summary.verifyCurrent(); // true
```

## 分步重建（更换容量 / 哈希参数）

重建期间登记与撤销持续生效，查询始终走原代次；发布之后查询才整体切换到新摘要，
一次查询绝不会混用两代向量。

```ts
// topicBudget：候选可接受的不同有效主题数上限；超出则明确中止候选
summary.startRebuild({ size: 256, hashes: 6, seed: 99 }, { batchSize: 10, topicBudget: 1000 });

let p = summary.getRebuildProgress();
while (p !== null && p.phase !== 'aborted' && !(p.phase === 'drain' && p.remaining === 0 && p.pendingChanges === 0)) {
  p = summary.stepRebuild();   // 可分多次事件循环/任务执行
}

summary.pauseRebuild();        // 暂停（登记/撤销仍正常接收）
summary.resumeRebuild();       // 继续
summary.abortRebuild();        // 放弃：候选丢弃，已接受登记在旧代次继续有效
summary.verifyCandidate();     // 候选与直接重建参考向量逐项对照
const info = summary.publishRebuild(); // 校验通过后切换代次并释放旧向量
```

重建状态机：

```
sweep ──(队列扫完)──> drain(对账重建期间全部登记/撤销) ──> publishRebuild() ──> 新代次
  │                     │
  └── pause ──> paused ─┘                    任一阶段超预算 ──> aborted（旧代次完好）
```

## 语义与设计要点

| 需求 | 实现方式 |
| --- | --- |
| 碰撞多转发、不漏订阅 | 每个槽位是计数器而非二值位；主题加入时各位置 `+1`，撤销时各 `-1` |
| 重复登记/撤销幂等 | 每主题维护订阅者 `Set`，重复操作直接返回 `changed: false` |
| 共享主题最后撤销才移除贡献 | 仅当订阅者集合由 1 变 0 时才回写向量 |
| 同主题重复命中同位置只计一次 | `bloomPositions` 对双重哈希派生位置去重，每主题按去重位置贡献 |
| 参数由调用方指定 | `BloomConfig { size, hashes, seed }`，构造与每次重建均可指定 |
| 查询只访问对应哈希位置 | `hasSubscription` 仅读取该主题派生位置，任一为 0 即无订阅 |
| 与直接重建一致 | `buildReferenceVector` 绕过增量簿记直接重建；`verifyCurrent/verifyCandidate` 逐项对照 |
| 重建不混用两代 | 查询在单次调用内固定代次引用；重建写入候选，发布前对外不可见 |
| 超预算明确中止 | sweep 与 drain 接受新主题前检查 `topicBudget`，中止后旧代次与已接受登记不受影响 |
| 切换后释放旧向量 | 发布时清空旧 `Uint32Array` 与簿记 Map，仅保留新代次引用 |
| 崩溃恢复 | 所有变更基于确定性的 (subscriber, topic) 操作，重放操作日志即可得到相同向量（见测试） |

## 模块入口

- `src/index.ts` — 统一导出 `CountingBloomSummary`、哈希工具与全部公共类型
- `src/bloom.ts` — 摘要核心与重建状态机
- `src/hash.ts` — MurmurHash3 32 位与 Kirsch–Mitzenmacher 双重哈希定位
- `src/types.ts` — `BloomConfig`、`RebuildOptions`、`RebuildProgress` 等公共类型

### 主要 API

```ts
class CountingBloomSummary {
  constructor(config: BloomConfig)
  register(subscriber: string, topic: string): MutationResult
  unregister(subscriber: string, topic: string): MutationResult
  hasSubscription(topic: string): boolean
  subscriberCount(topic: string): number
  readonly hasActiveTopics: boolean
  readonly activeTopicCount: number
  readonly generationId: number
  readonly config: BloomConfig
  getGenerationInfo(): GenerationInfo
  buildReferenceVector(config?: BloomConfig): Uint32Array
  verifyCurrent(): boolean
  verifyCandidate(): boolean
  snapshotVector(): Uint32Array
  snapshotCandidateVector(): Uint32Array
  queryCandidate(topic: string): boolean
  startRebuild(newConfig: BloomConfig, options?: RebuildOptions): RebuildProgress
  stepRebuild(): RebuildProgress
  pauseRebuild(): RebuildProgress
  resumeRebuild(): RebuildProgress
  abortRebuild(): RebuildProgress
  publishRebuild(): GenerationInfo
  getRebuildProgress(): RebuildProgress | null
}
```

## 说明

- 哈希实现为 MurmurHash3 x86 32 位，字符串按 UTF-16 代码单元编码；位置派生采用
  `g_i(x) = (h1(x) + i·h2(x)) mod m` 的双重哈希，同一身份在同一代次内映射稳定。
- 计数向量使用 `Uint32Array`；正常使用下计数不会下溢，内部检测到下溢会直接抛错
  （代表不变量被破坏），而不是静默回绕。
- 所有数据结构与测试数据均保存在本工作区内，不访问任何外部服务。
