# 巡检轨迹 × 管线区段逐点归属与到访明细

两条管线并行时，单个轨迹点可能更靠近另一条管线，但连续几个点的拓扑连续性
足以确定巡检员实际走的是哪一条。本工具读取**轨迹 CSV**与**管线 GeoJSON**
（同一套以米为单位的平面坐标），输出逐点归属、区段到访明细和轨迹切断记录。

仅依赖 Python 3 标准库（建议 3.10+），无需安装任何第三方包。

## 用法

```bash
python3 -I src/match_inspection.py \
  --trajectory testdata/trajectory.csv \
  --pipelines  testdata/pipelines.geojson \
  --outdir     output
```

常用参数（均有默认值，对应题目常量）：

| 参数 | 默认 | 含义 |
|---|---|---|
| `--radius` | 15 | 候选区段半径（米），点到折线距离 ≤ 该值才保留为候选 |
| `--max-gap` | 45 | 相邻采样点间隔超过该秒数即切断轨迹 |
| `--speed` | 2 | 最大行进速度（米/秒），预算 = 间隔秒数 × 该值 |
| `--tolerance-mm` | 500 | 近优路径总偏差容忍量（毫米） |

列名/属性名支持自动识别（见下文“字段约定”），也可用 `--inspector-col`、
`--time-col`、`--x-col`、`--y-col`、`--segment-id-prop`、`--start-prop`、
`--end-prop` 显式指定。

## 输入约定

### 轨迹 CSV

表头自动识别以下命名（大小写不敏感，含部分中文列名）：

- 巡检员：`inspector_id / inspector / worker_id / user_id / 巡检员id …`
- 采样时间：`timestamp / time / ts / datetime / 采样时间 …`，支持 ISO-8601
  （含 `Z`）、`YYYY-MM-DD HH:MM:SS` 或 Unix 秒/毫秒
- 平面坐标：`x/easting/lon/经度 …` 与 `y/northing/lat/纬度 …`，单位米

数据按巡检员、采样时间排序；**同一巡检员采样时间唯一**，重复即报错。

### 管线 GeoJSON

`FeatureCollection`，每个要素为 `LineString`，属性携带：

- 区段 ID：`segment_id / seg_id / id / 区段id …`
- 两端节点 ID：`start_node / from_node / 起点节点 …`、
  `end_node / to_node / 终点节点 …`

节点 ID 相同即视为共享端点；折线可以是任意多顶点折线，内部按折线里程计算。

## 规则与算法的对应

1. **候选生成（15 米）**：均匀网格空间索引初筛后，逐段计算点到折线的最近
   投影（垂足钳到端点），保留距离 ≤ 15 m 的**全部**区段，记录投影点、距折线
   起点的里程 `arc_m` 和垂直距离 `dist_m`。
2. **投影并列**：同一折线上多个投影等距时，取沿折线起点里程最短者；跨区段
   的等距候选全部保留（并列只影响“最近点”的选取，不影响候选集合）。
3. **相邻点转移**：
   - 留在同一区段：里程差的绝对值（允许沿折线反向行走）；
   - 经**共享端点**换段：两段到共享节点的里程之和，取所有共享节点中最短者；
   - 无共享端点且非同段：不可达。
   - 实际管线里程不得超过 `Δt × 2 m/s`。
4. **轨迹切断**（三类原因写入 `trajectory_breaks.csv`）：
   - `no_candidate`：点在 15 m 内无任何候选，该点排除、轨迹断开；
   - `time_gap`：与上一点间隔 > 45 s，在两点间断开；
   - `infeasible_transition`：加入下一点后，当前段所有可行 DP 路径都无法
     延续，则在该点之前切开、从该点重新匹配。
5. **动态规划与近优路径**：单点代价 = 投影距离四舍五入到整数毫米
   （半值向上，全程整数毫米运算避免浮点误差）。同层同区段只保留最小代价
   状态（其余被支配，已用 300 组随机网络与全路径暴力枚举交叉验证零偏差）。
   再做一次反向 DP 得到每个状态的最小后缀代价；满足
   `前缀最小代价 + 后缀最小代价 ≤ 最优总偏差 + 500 mm` 的状态，即该点在某条
   近优可行路径上可能归属的区段。
6. **确认 / 待核对**：近优集合只有 1 个区段 → `confirmed`；多于 1 个 →
   `pending`，并在输出中列出这些区段。
7. **到访合并**：同一轨迹段（block）内，连续确认到同一区段的点合并为一次
   到访；待核对点会打断合并，不同 block 之间不跨段合并。

## 输出文件（`--outdir`）

### `point_assignment.csv` — 逐点归属

| 字段 | 说明 |
|---|---|
| `inspector_id / point_index` | 巡检员及其名下全局点序号 |
| `block_id / in_block_index` | 所属轨迹段 ID 与段内序号 |
| `timestamp / x_m / y_m` | 原始时间与坐标 |
| `status` | `confirmed` / `pending` / `excluded`（无候选被排除） |
| `segment_id` | 确认时的区段；待核对/排除为空 |
| `candidate_count` | 15 m 内候选区段数 |
| `candidates_segment\|dist_m\|arc_m` | 全部候选，`区段\|距离米\|里程米`，分号分隔，按距离、里程排序 |
| `near_optimal_segments` | 近优可行路径上该点出现过的全部区段（`\|` 分隔） |
| `note` | 待核对/排除原因 |

### `segment_visits.csv` — 区段到访明细

`inspector_id, block_id, segment_id, start_time, end_time, point_count,
first_point_index, last_point_index`，即题目要求的区段、首尾时间和点数。

### `trajectory_breaks.csv` — 切断记录

`inspector_id, ended_block_id, break_at_point_index, break_at_time, reason,
detail`，`detail` 中附带间隔、行走预算与最短管线里程，便于复核。

### `summary.json`

参数、各状态点数、轨迹段数、到访/切断次数，以及每段轨迹的最优总偏差（毫米）。

## 测试与复现

```bash
# 1) 生成合成数据（testdata/，独立目录，脚本与数据分离）
python3 -I tests/make_testdata.py testdata

# 2) 单元/边界测试：投影并列、毫米舍入、15m 边界、共享端点换段、
#    反向行走、速度预算切断、500mm 容忍边界、端到端 CSV 往返
python3 -I tests/test_verify.py

# 3) 运行主程序
python3 -I src/match_inspection.py \
  --trajectory testdata/trajectory.csv \
  --pipelines  testdata/pipelines.geojson \
  --outdir     output
```

合成数据覆盖：连续可行主路径 S1→S3→S5→S6（含共享端点投影并列产生的待核对
点）、四岔节点多候选、45 秒空档、无候选点、10 秒内须走 80 m 的超限切断。

## 复杂度

设轨迹点数 N、平均候选区段数 c（受 15 m 半径约束，实际很小）：

- 候选投影：网格索引后约 O(N·c)；
- 在线 DP：每点仅增量计算一层，O(N·c²)，不随轨迹段长度重复计算；
- 反向 DP 与近优集合：O(N·c²)；
- 空间：O(N·c)。
