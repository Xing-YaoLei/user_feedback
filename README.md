# 园区班车到站数据轮询系统

纯 Python 3 标准库实现（无第三方依赖），包含轮询程序、本地模拟接口和调度员查看页面。

## 需求对照

| 需求 | 实现位置 |
| --- | --- |
| 从配置读取各园区 URL 和刷新间隔 | `shuttle/config.py`，配置样例 `config.example.json` |
| 同时最多 3 个请求 | `shuttle/poller.py`：`max_concurrency` 个工作线程 + 到期堆，全局在途不超限（`test_global_concurrency_cap_is_three`） |
| 同一园区同一时刻最多一个请求在途 | `ParkState.in_flight` 标志 + 堆中每园区仅保留最新一代条目（`test_same_park_never_overlaps`） |
| 多园区同时到期先取等待最久的 | 最小堆按 `next_due` 排序，同时间按入堆序号确定顺序（`test_due_order_longest_waiting_first`） |
| ETag 标识整份快照，200 发布新快照，304 只记录检查时间 | `If-None-Match` 条件请求；304 不替换 `last_snapshot`，只更新 `last_check_at`（`test_304_records_check_but_keeps_snapshot`） |
| 429 按 Retry-After 安排该园区下一次请求 | `_apply_result` 中 429 分支，仅重排本园区，不触碰其他园区（`test_429_uses_retry_after`、`test_other_park_unaffected_by_retry_after`） |
| 超时/5xx 有上限退避，成功后恢复常规间隔 | `shuttle/backoff.py` 指数退避（base·2^(n-1)，封顶 cap），成功清零（`test_5xx_backoff_then_success_resets`、`test_timeout_backoff`） |
| 每个园区保留最近一次成功快照 | `ParkState.last_snapshot`，调度员页面/API 可查 |
| 模拟接口可设置延迟和状态序列 | `shuttle/mock_server.py`，token：`200`/`304`/`429:秒`/`500`/`502`/`503`/`504`/`timeout:秒` |
| 请求记录核对退避时另一园区仍刷新 | `GET /control/parks/{id}/records`，`run_demo.py` 自动核对 |

## 目录结构

```
shuttle/
  backoff.py       退避计算与 Retry-After 解析
  config.py        JSON 配置加载与校验
  model.py         ParkState / Snapshot 数据模型
  logger.py        日志
  mock_server.py   本地模拟班车接口（含控制接口与请求记录）
  poller.py        轮询调度器与 HTTP 传输
  dispatcher.py    调度员 HTML 页面与 JSON API
run_poller.py      轮询程序入口
run_demo.py        端到端自动验证（模拟接口 + 轮询同进程）
config.example.json
tests/             31 个单元测试
```

## 快速开始

### 1. 端到端自动验证（推荐先跑）

```bash
python3 run_demo.py --mode quick   # 约 30 秒，Retry-After=6s
python3 run_demo.py --mode spec    # 约 38 秒，Retry-After 按需求原值 30s
```

输出包含每个园区在模拟接口侧的请求记录，以及 14 项自动核对（PASS/FAIL）。
其中关键一项：**north 收到 429 后两次请求间隔 30.06 秒，该窗口内 south 仍按自己的 2 秒间隔发起 14 次请求**。

### 2. 分开启动模拟接口与轮询程序

```bash
# 终端 A：模拟接口
python3 -m shuttle.mock_server --port 8080

# 配置园区（延迟 0.2s，先 429 再恢复；sequence 为空表示常规 ETag 行为）
curl -X POST http://127.0.0.1:8080/control/parks/north/config \
  -H 'Content-Type: application/json' \
  -d '{"delay":0.2,"sequence":["200","429:30","304"],"loop":false}'
curl -X POST http://127.0.0.1:8080/control/parks/south/config \
  -H 'Content-Type: application/json' -d '{"delay":0.2,"sequence":[]}'

# 推送初始快照（ETag 由快照内容哈希生成）
curl -X POST http://127.0.0.1:8080/control/parks/north/snapshot \
  -H 'Content-Type: application/json' -d '{"body":{"arrivals":[]}}'

# 终端 B：轮询程序
cp config.example.json config.json   # 按需修改 URL/间隔
python3 run_poller.py config.json
# 打开调度员页面：http://127.0.0.1:8090/
```

### 3. 单元测试

```bash
python3 -m unittest discover -s tests -v
```

## 模拟接口说明

数据接口：`GET /shuttle/parks/{id}`，支持 `If-None-Match`。

控制接口（POST JSON）：

| 路径 | 作用 |
| --- | --- |
| `/control/parks/{id}/config` | 设置 `delay`（秒）、`sequence`（token 数组）、`loop`（序列是否循环） |
| `/control/parks/{id}/snapshot` | 替换快照 body，ETag 自动更新 |
| `/control/parks/{id}/records/reset` | 清空请求记录 |
| `/control/reset` | 清空所有园区 |

读取接口（GET）：`/control/parks`、`/control/parks/{id}/records`。

状态序列 token：

- `200`：发布当前快照（带 ETag）
- `304`：返回 304
- `429:30`：返回 429 且 `Retry-After: 30`（秒数可改，缺省 30）
- `500` / `502` / `503` / `504`：脚本化 5xx
- `timeout:3`：保持 3 秒不响应（客户端先超时会记录 `status=null` 与断连备注）

序列为空（或一次性序列播完）时回到常规 ETag 行为：`If-None-Match` 命中返回 304，否则 200。

每条请求记录包含：序号、时间、延迟、实际耗时、响应状态、请求携带的 ETag、Retry-After、备注。

## 调度员页面

- `GET /`：HTML 监控页（2 秒自动刷新，适配浅色/深色），展示各园区状态徽标（正常/请求在途/退避中）、ETag、检查时间、失败计数、各类响应计数与最近快照内容
- `GET /api/status`：调度状态 JSON
- `GET /api/snapshots`：各园区最近一次成功快照 JSON

## 配置字段

```json
{
  "max_concurrency": 3,
  "backoff_base_seconds": 1,
  "backoff_cap_seconds": 30,
  "logfile": "shuttle.log",
  "dispatcher": {"host": "127.0.0.1", "port": 8090},
  "parks": [
    {"id": "north", "url": "http://127.0.0.1:8080/shuttle/parks/north",
     "interval_seconds": 3, "timeout_seconds": 2}
  ]
}
```

退避序列为 base、base·2、base·4…… 封顶 cap；任意一次 200/304 成功后失败计数清零，恢复 `interval_seconds` 常规间隔。
429 响应带合法 `Retry-After` 时优先使用该秒数（不计入退避失败轨道）；头缺失或非法时退回指数退避。
