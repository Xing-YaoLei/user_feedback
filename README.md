# 供货清单采集（Node.js）

采购开工时查看各供应商最近一次**完整**的供货清单。某家当天没采完，页面继续显示它上一次的清单，并标明快照编号、停在哪一页、为什么停；其他供应商照常更新。

```
src/              采集端（Node.js，无第三方依赖）
  index.js        启动入口：数据目录、端口、模拟接口
  engine.js       逐页采集状态机：调度、限流排队、游标恢复、快照原子替换
  store.js        原子写入的本地存储（config / state / pending / complete）
  http.js         分页接口协议、限流 / 游标过期 / 可重试错误的分类
  server.js       看板与配置 API（只读快照、只入队采集）
  mock-server.js  本地模拟供货接口 + 故障注入管理页
  config.js       来源配置校验
  util.js         时间与文本小工具
web/              看板页面（原生 HTML/CSS/JS，无需构建）
test/             单元测试 + 采集状态机测试 + 模拟接口集成测试
```

## 运行

```bash
npm start
```

- 看板：http://127.0.0.1:4100
- 模拟供货接口：http://127.0.0.1:4110
- 模拟接口管理页（注入故障）：http://127.0.0.1:4110/debug

首次启动会自动写入三个演示来源（指向本地模拟接口），并按各自的采集时间开始采集。数据保存在 `./data`：

```
data/config.json                 来源配置
data/suppliers/<id>/state.json   调度状态与进度摘要
data/suppliers/<id>/pending.json 未收齐快照的已取页面 + 下一页游标
data/suppliers/<id>/complete.json 最近一次收齐的完整快照（页面只展示这一份）
```

环境变量：`PORT`、`MOCK_PORT`、`DATA_DIR`、`WITH_MOCK=0`（关闭内置模拟接口）、`MOCK_CONFIG`（模拟来源配置文件）。

## 采集行为

- **按来源独立调度**：每个来源按自己的采集时间、每分钟请求上限逐页请求。某一家被限流只是它自己进入等待队列，其他来源照常翻页。
- **限流**：HTTP 429 时读取对方的 `Retry-After` / `retryAfterMs`，到点后带着同一个游标重新排队，不会从头重来。
- **分页中断**：5xx / 超时 / 连接失败会指数退避重试，游标与已取页面已落盘，恢复后从失败的那一页继续。
- **游标过期**：410 或 `error=cursor_expired` 时丢弃这份半成品，立即重新取一份新快照；旧清单继续展示。
- **同一快照**：每页都比对快照编号，翻页途中快照发生变化会丢弃已取页面重新开始；只有最后一页到达、所有页面来自同一快照时才写入 `complete.json`，一次性替换旧结果。
- **进程重启**：启动时把 `pending.json` 与 `state.json` 对齐。游标还能用就接着翻页；接口返回游标过期就重新取快照。崩溃在“已替换清单但没删半成品”之间也能自愈。
- **每日一次**：当日已收齐后，下一次安排在次日采集时间；当天没采完则继续续采而不是等明天。

## 接口协议

`GET <接口地址>?pageSize=N[&cursor=X]`

```json
{ "snapshotId": "snap-1", "products": [{ "sku": "...", "name": "..." }], "nextCursor": "opaque-token" }
```

- `nextCursor` 为 `null` 表示本快照已取完。
- `429` 限流；`Retry-After` 头或 `{ "retryAfterMs": 1234 }` 指定等待时间。
- `410` 或 `{ "error": "cursor_expired" }` 表示游标失效。
- 其他 4xx 视为不可重试（暂停并记录原因），5xx / 超时 / 网络错误可重试。

接口地址、采集时间（HH:MM）、每分钟请求上限、每页条数都可以在页面“来源设置”里改，保存后按新计划执行；改地址或每页条数会自动作废旧游标并重新取快照。

## 复现故障（排查采集进度）

打开 http://127.0.0.1:4110/debug，对任一来源：

- **轮换快照 / 令游标过期**：让下一页请求返回 410。
- **定时中断**：再过 N 页后开始返回 5xx，用于重现翻页中断。
- **应用限流**：每 N 次请求返回 429，并给定等待秒数。
- **恢复接口 / 重置**：恢复正常或回到初始状态。

也可用 `curl`：

```bash
curl -X POST http://127.0.0.1:4110/admin/fresh-mart/rotate
curl -X POST http://127.0.0.1:4110/admin/fresh-mart/interrupt -d '{"pages":2}'
curl -X POST http://127.0.0.1:4110/admin/fresh-mart/rate-limit -d '{"everyRequests":3,"retryAfterMs":8000}'
curl -X POST http://127.0.0.1:4110/admin/fresh-mart/resume
curl http://127.0.0.1:4110/admin/status
```

## 测试

```bash
npm test
```

覆盖：配置校验、逐页收齐才替换、旧清单在未收齐期间保持、限流等待时间、分页中断后从原游标续采、游标过期后重新取快照、快照中途变化丢弃半成品、进程重启恢复游标、配置变更作废旧游标、游标不前进时停止。

## 看板 API

`GET /api/overview` 来源状态汇总 · `GET /api/suppliers/:id` 当前清单与未收齐缓存 · `POST /api/suppliers/:id/collect` 立即采集 · `GET /api/config` / `PUT /api/config` 来源配置 · `GET /api/health`。
