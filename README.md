# 偏移血缘模块（Offset Lineage）

在 Node.js 上实现的流式桥接偏移血缘库。源输入按分区连续登记，阶段之间可以过滤、拆分、合并；
下游终端确认沿真实血缘反向换算为上游**可连续提交的位置**。状态持久化在本地目录，支持崩溃恢复、
世代切换、历史压缩与容量背压。纯 TypeScript，零运行时依赖，使用 Node 内置测试框架，
`npm test` 即可完成全部本地验证（断言失败时以非零码退出）。

## 目录结构

```
src/
  index.ts      统一模块入口
  types.ts      身份四元组、拓扑、查询结果等领域类型
  errors.ts     带稳定 code 的错误层级（BackpressureError 等）
  interval.ts   离散偏移区间集合（乱序合并、空洞、连续前缀前沿）
  store.ts      LineageStore：登记/封口/确认/传播/持久化/压缩/背压
tests/
  interval.test.ts   区间集合单元测试
  pipeline.test.ts   两源合并→再拆两目标的全链路场景测试
  recovery.test.ts   多分区、WAL 崩溃恢复、压缩与世代摘要测试
```

## 核心模型

- **记录身份**：`{ stage, partition, generation, offset }` 四元组。同一
  `(stage, partition, generation)`（SPG）内偏移必须从 0 开始、无空洞连续登记。
- **血缘 DAG**：`registerOutput(output, inputs[])` 支持多输入合并（fan-in）与一对多分裂
  （fan-out）；同一输入可产生多个后继，同一后继可依赖多个输入。
- **封口 `seal`**：声明某条记录的全部后继已登记。**零后继封口显式表示该记录被过滤**，
  封口即退役。
- **终端确认 `confirm`**：仅 sink 可确认；确认可以乱序，内部用离散区间集合保留空洞，
  `getSinkReport` 同时给出累计连续前沿与全部离散确认区间。
- **完备性传播**：非 sink 记录在「已封口且所有后继完备」时完备；sink 在「已封口且已确认」
  时完备。源分区只有在记录已封口、且全部可达终端输出都已确认时，才按连续前缀推进
  **提交前沿**（`getSourceCommitFrontier`），空洞不会被跳过。
- **世代隔离**：世代是身份的一部分。世代切换后偏移可从 0 复用，旧世代确认无法误命中新世代
  记录；未知世代的确认被拒绝，被压缩覆盖的迟到确认按世代识别为幂等 no-op。
- **持久化**：目录内 `wal.log`（仅追加事件日志）+ `snapshot.json`（快照）。打开时先载入快照、
  再重放 WAL，随后重算全部派生事实，并校验**已发布安全前沿只增不减**。
- **压缩 `compact`**：仅删除「已完备、位于本 SPG 完备前缀内、且关联边的两端一起删除」的
  事实，删除范围由每 SPG 摘要覆盖；压缩后相同查询得到与压缩前一致的前沿与终端报告。
- **背压**：按存活（未完备）记录计数，构造时可给 `capacity`。容量不足时新登记抛
  `BackpressureError`，且校验先于落盘、不留半成品；合法封口与终端确认继续释放占用。
- **可解释性**：`explainSourcePosition` 逐个说明源位置为何被阻挡（`unsealed` /
  `unconfirmed` / `unregistered` / `cycle`），或已经 `committable` / `committed`。

## 快速上手

```ts
import { LineageStore, type Topology } from "./src/index.ts";

const topology: Topology = {
  stages: [
    { name: "sourceA", kind: "source" },
    { name: "merge", kind: "intermediate" },
    { name: "sinkL", kind: "sink" },
    { name: "sinkR", kind: "sink" },
  ],
  edges: [
    { from: "sourceA", to: "merge" },
    { from: "merge", to: "sinkL" },
    { from: "merge", to: "sinkR" },
  ],
};

const store = LineageStore.open("./data/lineage", topology, { capacity: 1000 });

store.registerRecord({ stage: "sourceA", partition: 0, generation: 0, offset: 0 });
store.registerOutput(
  { stage: "merge", partition: 0, generation: 0, offset: 0 },
  [{ stage: "sourceA", partition: 0, generation: 0, offset: 0 }],
);
// 分裂到两个目标分区
store.registerOutput({ stage: "sinkL", partition: 0, generation: 0, offset: 0 }, [
  { stage: "merge", partition: 0, generation: 0, offset: 0 },
]);
store.registerOutput({ stage: "sinkR", partition: 0, generation: 0, offset: 0 }, [
  { stage: "merge", partition: 0, generation: 0, offset: 0 },
]);

// 零后继封口 = 过滤：store.seal(filteredRecord)

// 全部封口后，确认两个终端，源前沿才会推进到 1
store.seal({ stage: "sourceA", partition: 0, generation: 0, offset: 0 });
store.seal({ stage: "merge", partition: 0, generation: 0, offset: 0 });
store.seal({ stage: "sinkL", partition: 0, generation: 0, offset: 0 });
store.seal({ stage: "sinkR", partition: 0, generation: 0, offset: 0 });
store.confirm({ stage: "sinkL", partition: 0, generation: 0, offset: 0 });
store.confirm({ stage: "sinkR", partition: 0, generation: 0, offset: 0 });

store.getSourceCommitFrontier("sourceA", 0, 0); // 1
store.explainSourcePosition("sourceA", 0, 0, 0); // { state: "committed", ... }
store.getSinkReport("sinkL", 0, 0); // 累计前沿 + 离散区间
store.compact(); // 仅压缩摘要已覆盖的事实
store.close();
```

## 验证

```bash
npm test
```

要求 Node.js ≥ 22.6（原生运行可擦除类型语法的 TypeScript，无需编译器、无需安装依赖）。
测试使用操作系统临时目录中的合成数据，结束后自动清理，不访问任何外部服务。

### 场景测试逐项核对的内容

`tests/pipeline.test.ts` 构造 `sourceA/sourceB → mergeM → splitX → sinkL/sinkR` 流水线，
覆盖：

1. **交错确认空洞**：先确认 offset 2 再确认 offset 0，终端报告保留离散区间，源前沿不跳过空洞；
2. **过滤输入**：零后继封口立即退役，但连续前沿仍等待前面的位置；
3. **共享后继**：两个源汇入同一后继，一次终端确认同时释放两侧；
4. **阶段/世代切换**：世代切换后偏移复用，旧确认不命中新世代，未知世代与越界偏移被拒绝；
5. **重启**：关闭后重新打开，重放未完成血缘，已发布前沿保持成立，流水线可继续推进；
6. **压缩前后等价**：相同输入在压缩前后得到完全一致的源前沿与终端报告，迟到确认仍识别世代；
7. **背压**：容量满时新登记被拒且无残留，封口/确认释放槽位后登记恢复；
8. **原子校验**：非法登记/封口不写 WAL、不改内存状态。
