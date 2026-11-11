# GraphQL 三层 connection 数据采集项目

机构（Institution）→ 实验（Experiment）→ 观测记录（Observation）三层关系的
GraphQL 服务与并发采集端。观测节点可被多个实验**共享**（多对多），节点与父子关系
分开存储；采集端支持独立游标、部分错误局部重试、检查点重启恢复。

## 目录结构

```
src/graphql_harvest/
├── models.py                 # 领域模型
├── server/                   # GraphQL 服务端 (aiohttp + graphql-core)
│   ├── seed.py               # 确定性内存数据集（含空连接、共享节点）
│   ├── cursors.py            # 不透明、带连接作用域的游标
│   ├── failures.py           # 确定性故障注入（HTTP 200 + data + errors）
│   ├── schema.py             # 三层 connection schema（programmatic）
│   ├── app.py                # HTTP 入口
│   └── __main__.py           # python -m graphql_harvest.server
├── collector/                # 采集端
│   ├── queries.py            # 每请求只查一个 connection 的查询文档
│   ├── client.py             # 异步客户端（信号量限流、传输级重试）
│   ├── store.py              # SQLite：节点表/关系表/检查点/失败边/死信
│   └── engine.py             # 遍历引擎（分类错误、局部重试、恢复）
├── cli.py                    # harvest run / harvest trace
└── __main__.py
examples/                     # 四个可直接运行的场景脚本
tests/                        # 25 个 pytest 用例
```

## 快速开始

```bash
python3 -m venv .venv
.venv/bin/pip install -e ".[test]"

# 终端 1：启动服务（默认 127.0.0.1:8080）
.venv/bin/python -m graphql_harvest.server

# 终端 2：采集（检查点写入 demo.db，可中断后重跑恢复）
.venv/bin/harvest run --db demo.db --page-size 5 --workers 4 --concurrency 4

# 追踪一个共享观测节点的全部来源路径与父连接检查点
.venv/bin/harvest trace obs-19 --db demo.db
```

也可以直接运行四个自包含示例（各自在临时端口起服务、用临时数据库）：

```bash
.venv/bin/python examples/01_empty_connections.py    # 空连接
.venv/bin/python examples/02_concurrent_layers.py    # 三层同时翻页
.venv/bin/python examples/03_partial_errors.py       # HTTP 200 部分错误
.venv/bin/python examples/04_restart_and_dead_letter.py  # 死信与重启恢复
```

## 数据集

| 表 | 数量 | 说明 |
|---|---|---|
| institutions | 6 | `inst-6` 没有任何实验（空 connection） |
| experiments | 11 | `exp-11` 没有任何观测（空 connection） |
| observations | 20 | 共享节点，仅存一份 |
| experiment/observation 关系 | 46 | 多对多链接，单独建表 |

例如 `obs-19` 同时属于 `exp-1`、`exp-7`、`exp-9`，但 `observations` 表只有一行。

## 关键设计

### 1. 每个父节点独立游标，不能跨父使用

游标内容为 base64url 编码的 `v1:<scope>:<index>`，其中 scope 为
`root` / `inst:<id>` / `exp:<id>`。服务端解析时**强制校验 scope**：

```text
cursor scope mismatch: cursor belongs to connection 'root',
but was used on 'inst:inst-1'
```

采集端每个连接在 `checkpoints` 表有独立一行，游标从不跨作业复制。
`tests/test_cursors.py` 与 `test_harvest.py::test_each_parent_keeps_its_own_cursor`
覆盖该保证。

### 2. 查询复杂度与并发控制

- 每个 GraphQL 请求只选择**一个 connection 的一页**，绝不嵌套展开子连接；
- 服务端 `first` 上限 `MAX_PAGE_SIZE=50`，超限直接返回错误；
- 采集端 `asyncio.Semaphore` 限制同时在途 HTTP 请求数（`--concurrency`），
  worker 池限制处理并行度（`--workers`），可选 `--min-interval` 限速；
- 有界 worker + 队列背压，父页面产出的子作业逐步入队。

### 3. HTTP 200 同时含 data 和 errors：拆分处理，不整页判定

故障通过 `X-Fail-Rules` 请求头（或 `FAIL_RULES` 环境变量）注入，规则带
`times` 预算，预算在服务运行期内共享、跨请求/重试计数。引擎按错误 `path`
分类：

| 错误类型 | path 形态 | 处理 |
|---|---|---|
| 连接级 | `.../experiments` | 整页从**同一游标**重试，本页不提交任何数据 |
| 边节点级 | `.../edges/<i>/node` | 同页存活边正常入库并调度子作业，只把失败边位置记入 `failed_edges`；检查点不前进，重取同一页（upsert 幂等，好数据不会重复） |

成功子树保留、失败路径单独重试；不会把整页当成功，也不会整页重复抓取。
超过 `--max-attempts` 的路径进入 `dead_letters`，其余数据照常完成。

### 4. 重启恢复

- 页面入库与检查点推进在**同一事务**；
- 启动时扫描 `checkpoints`：`has_next=1` 的连接按各自游标重新入队，
  已完成的连接直接跳过（再次运行示例中 0 新请求）；
- 已落库的父节点若缺少子连接检查点（进程在调度前崩溃），也会补建子作业；
- 所有节点/关系写入均为幂等 upsert，关系表带 `UNIQUE` 约束，重复抓取不会
  产生重复关系。

### 5. 节点与关系分开存储

```sql
observations(id PRIMARY KEY, ...)                  -- 共享节点一行
experiment_observations(experiment_id, observation_id, position,
                        PRIMARY KEY (experiment_id, observation_id))
institution_experiments(institution_id, experiment_id, position,
                        PRIMARY KEY (institution_id, experiment_id))
```

### 6. 来源路径与检查点追踪

`harvest trace <node-id>` 输出一个节点的完整来源路径，例如：

```text
observation obs-19 is reachable through 3 path(s):
  inst-1 (Alpha Institute) -> exp-1 (Catalyst Screening A) -> obs-19 ...
  inst-4 (Delta Institute) -> exp-7 (Pilot Reactor)        -> obs-19 ...
  inst-5 (Epsilon Institute) -> exp-9 (Field Sampling)     -> obs-19 ...

checkpoint of last parent connection: scope=exp:exp-1 done=6 has_next=0 cursor=...
```

## 测试

```bash
.venv/bin/python -m pytest
```

25 个用例覆盖：游标作用域、分页/空连接/页大小上限、部分错误两种粒度、
完整性（6/11/20 节点、46 关系）、共享节点只存一次、关系零重复、
死信隔离、取消后重启恢复、三层并发翻页、并发上限、跨 scope 游标容错、
trace 血缘查询。

## 故障规则示例

```json
[
  {"path": ["institutions"], "times": 1},
  {"path": ["institution", "experiments"], "id": "inst-3", "times": 2},
  {"path": ["experiment", "observations"], "id": "exp-5", "times": 100},
  {"path": ["experiment", "observations", "edges", 2, "node"],
   "id": "exp-7", "nodeId": "obs-09", "times": 2}
]
```

- 无 `nodeId`：连接级失败，该字段在响应中为 `null`，兄弟字段保留；
- 有 `nodeId`：仅该边的 node 失败，同页其他边不受影响；
- `times`：最多触发次数，耗尽后同样请求自动恢复成功。
