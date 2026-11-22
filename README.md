# 配置中心结构化三方合并

两位维护者从同一版服务配置分叉修改后，用本模块合并出可发布候选：输入共同基线与两侧最终快照，自动合并不冲突的修改，定位内容 / 顺序 / 引用三类冲突，调用方针对冲突取舍后重新计算，直到全部约束成立才产出可发布快照。

## 数据模型（`src/model.ts`）

配置节点由四类构成：

| 类别 | 表示 |
| --- | --- |
| 标量 | `string \| number \| boolean \| null` |
| 对象 | `{ [key: string]: Node }`（键无序） |
| 有序数组 | `{ $array: [{ id, value }] }`，元素带稳定 ID，顺序有语义 |
| 引用 | `{ $ref: "<element id>" }`，按 ID 指向数组元素节点 |

`$ref` / `$array` 为保留键；元素 ID 在整棵快照中全局唯一。冲突定位使用稳定 ID 路径：对象键为路径段、数组元素为 `[id]` 段，如 `/items/[web]/port`。

## 合并规则

- 互不覆盖的修改自动合并；同一位置改成相同值合并，不同值产生值冲突（`both-modified` / `added-differently`）。
- 一侧删除、另一侧修改该节点或其后代的内容或位置，产生 `delete-modified` 冲突；对侧未改动则删除生效。
- 数组按元素 ID 合并内容与增删；顺序按元素对合成：双方都未改动保留基线顺序，单侧改动采用改动侧，新增元素采用各自快照中的相对位置。
- 合成后的顺序关系成环时，`orderConflicts` 返回具体的环（元素序列 + 每条关系及其来源 `base`/`left`/`right`/`both`/`directive`）；存在多种合法顺序时按元素 ID 字典序决胜，结果确定。
- 合并候选上做引用检查：悬空引用（`dangling-reference`，含引用路径与目标 ID）与引用环（`reference-cycle`，含环上元素与每条引用边的路径）都会被定位并保持待解决。
- 只有内容、顺序、引用约束全部成立时 `publishable === true` 并返回 `snapshot`；无内容/顺序冲突但引用待解决时返回 `candidate` 供预览。
- 左右两侧交换、对象键遍历次序改变，得到等价的候选与冲突集合（测试覆盖）。

## 取舍后重新计算

`mergeConfigs` 是纯函数。针对冲突提供指令后再次调用即可：

```ts
import { mergeConfigs } from './src/index.ts';

const r1 = mergeConfigs(base, left, right);
// r1.valueConflicts / orderConflicts / referenceIssues 定位问题，且携带三侧原值

const r2 = mergeConfigs(base, left, right, {
  directives: [
    // 内容取舍：在稳定 ID 路径处强制采用 base/left/right 一侧
    { type: 'value', path: ['items', { id: 'a' }, 'v'], choice: 'left' },
    // 顺序取舍：对数组中元素对 {a, b} 强制采用一侧的先后关系
    { type: 'order', arrayPath: ['list'], a: 'a', b: 'b', choice: 'right' },
  ],
});
```

解决一个内容或顺序冲突可能进一步引出悬空引用或引用环，重新计算后会在 `referenceIssues` 中定位并保持待解决，可继续用 `value` 指令取舍（例如强制采用不含引用的那一侧、或保留被删的引用目标）。

## 运行

要求 Node.js ≥ 22.6（直接运行可擦除类型语法的 TypeScript，无需安装编译器）。

```bash
npm test     # 真实断言：合并规则、三个演示场景、左右交换/键序等价、交错编辑压力、畸形输入
npm run demo # 端到端打印三个演示场景（重排成环 / 删除×引用 / 取舍引入引用环）
```

## 目录

- `src/model.ts` — 数据模型、稳定 ID 路径、结构校验（畸形输入报明确错误而非崩溃）、结构相等
- `src/graph.ts` — 具体环提取（SCC + DFS）与按 ID 决胜的确定性拓扑排序
- `src/refs.ts` — 悬空引用与引用环检查
- `src/merge.ts` — 三方合并主流程（内容 + 顺序 + 取舍指令）
- `src/index.ts` — 模块入口
- `test/merge.test.ts` — 全部断言（`npm test`）
- `examples/demo.ts` — 三个演示场景（`npm run demo`）
