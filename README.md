# user_feedback — 实验分析工具

对齐分流日志与转化日志，按用户生成观察结果，输出分层转化率、总体/加权差值，
并对小样本提供分层精确置换检验。纯 Python 标准库实现，无第三方依赖。

## 输入文件

均为 UTF-8 CSV，首行为表头。

| 文件 | 列 | 说明 |
| --- | --- | --- |
| 分流日志 | `user_id, layer, group, assigned_at` | 用户、所属层、实验组、分组时间 |
| 转化日志 | `user_id, converted_at[, coverage_at]` | 每个用户可有多条转化记录；`coverage_at` 为可选的逐用户覆盖时间 |
| 层权重（可选） | `layer, weight` | 各用户层的固定权重，可只覆盖部分层 |

覆盖时间（日志已完整覆盖到的时间）有两种给法：转化日志里的逐用户 `coverage_at` 列，
或 CLI 的 `--coverage`（时间戳字符串，或只含一个时间戳的文件路径）；逐用户列优先。

## 口径定义

1. **按用户对齐**：以分流日志为准，每个用户一条观察结果。转化日志里存在、
   分流日志里不存在的用户记为告警并忽略；同一用户多条转化取最早一条。
2. **七天窗口**：转化只统计 `assigned_at <= converted_at <= assigned_at + 7天`
   的记录（两端闭区间）。窗口外、分组前的转化不计入。
3. **待观察**：覆盖时间早于该用户窗口结束时间时，七天尚未被日志完整覆盖，
   记为待观察（pending），不进入转化率分母；完整覆盖后无转化则记为已观察未转化。
4. **分层统计**：按层 × 组给出已观察人数、待观察人数、转化人数与转化率。
5. **总体差值**：跨层合并所有已观察用户后，处理组转化率 − 对照组转化率。
6. **加权分层差值**：只对有权重的层计算 `Σ(权重 × 层差值)`。
   - 有权重的层若任一组没有有效观测（已观察人数为 0 或缺组），该层标记**数据不足**，
     不参与加权；
   - 默认输出按参与层权重**重归一化**的差值，同时给出原始权重口径
     （未覆盖层按 0 贡献）与权重覆盖率，便于判断跳过层的影响。
7. **置换检验（双侧）**：原假设为层内标签可交换。每层保持原来的分组人数不变，
   在层内重新分配处理/对照标签；统计量为与主分析同口径的加权分层差值，
   p 值为双侧尾部概率。层内结果无变异（全转化或全未转化）的层自动排除并说明原因。
   - 总排列数不超过 `--exact-limit`（默认 200,000）时做**精确枚举**，
     同一转化数对应的多种标签排列按多重性计数；
   - 超过上限时回退到固定种子的**蒙特卡洛抽样**（超几何抽样，默认 10,000 次，
     观测排列本身计入，分母 n+1），结果可复现。
   - 没有任何可检验层时输出"数据不足"，不编造 p 值。

## 用法

```bash
python3 -m exp_analysis.cli \
  --assignments sample_data/assignments.csv \
  --conversions sample_data/conversions.csv \
  --weights sample_data/weights.csv \
  --coverage sample_data/coverage.txt \
  --control control --treatment treatment \
  --out-observations out/observations.csv \
  --out-summary out/summary.csv
```

常用参数：`--window-days`（默认 7）、`--no-permutation`、`--exact-limit`、
`--mc-reps`、`--seed`。组名默认 `control` / `treatment`。

## 输出

- 控制台：数据告警、分层结果、总体差值、加权分层差值、置换检验结果。
- `--out-observations`：每用户一条，含窗口起止、覆盖时间、状态与是否转化。
- `--out-summary`：每层/每组的人数、转化率、层差值与数据不足标记。

## 测试

```bash
python3 -m unittest discover -s tests -v
```

16 个用例覆盖窗口边界（恰好分组时刻/窗口结束时刻计入）、待观察判定、
逐用户覆盖时间、数据不足层、加权口径，以及精确检验与独立全枚举/Fisher 口径的
交叉验证。

## 代码结构

```
exp_analysis/
  io_utils.py     输入读取与时间解析（无时区时间按 UTC）
  analysis.py     用户对齐、七天窗口、分层/总体/加权统计
  permutation.py  分层精确置换检验与蒙特卡洛回退
  report.py       文本报告与 CSV 导出
  cli.py          命令行入口
tests/            unittest 用例
sample_data/      示例输入（含待观察、窗口外转化、数据不足等情形）
```
