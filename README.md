# 传统服务端表单站点采集器

针对 **Cookie 会话 + 隐藏状态字段 + POST 回发** 型传统站点（ASP.NET WebForms 风格）
的采集系统。纯 Python 标准库实现，无第三方依赖。

## 为什么需要状态机

目标站点的每个会话持有一对**一次性隐藏状态**（`_viewstate` / `_nonce`）：

* 任何成功响应都会轮转这对状态，页面里嵌入的是下一次回发才能用的新值；
* 复用旧状态、或借用其他查询/会话的状态，回发会被拒绝且整个会话立即作废；
* 不同查询拥有独立 Cookie 与独立状态链，不能共享。

因此采集端不能硬编码隐藏字段值，也不能自行拼接翻页地址，必须像浏览器一样：
**解析页面 → 逐字取隐藏状态与按钮参数 → POST 到表单 action → 用新页面的状态继续**。

## 目录结构

```
siteserver/            演示站点（本地）
  data.py              25 条商品数据集，每页 8 条共 4 页
  state.py             服务端会话与一次性隐藏状态机
  pages.py             入口/结果/错误页渲染（含同名表单与诱饵表单）
  app.py               HTTP 应用、回发校验、故障注入控制端 /__test__/*
  server.py            站点启动入口
collector/             采集器
  form_parser.py       HTML 表单解析与同名表单消歧、按钮参数提取
  page_parser.py       结果页结构化解析（页序、查询身份、数据行）
  http_client.py       独立 Cookie 的 HTTP 客户端（手工管理 Cookie 头）
  redaction.py         敏感状态遮盖（viewstate/nonce/cookie/token）
  evidence.py          请求-响应关联证据 JSONL 留存
  session.py           单查询状态机：回发、翻页、过期恢复、身份校验、URL 白名单
  engine.py            并行采集引擎（每查询独立线程/独立状态链）
  config.py            查询配置模型
  webui.py             查询配置 Web 页面与任务结果/证据查看
  cli.py               命令行入口
tests/                 24 个测试，覆盖全部关键场景
run_demo.py            一键启动站点 + 配置页面
queries.example.json   CLI 查询配置示例
```

## 快速开始

```bash
# 方式一：一键演示（站点 :8000 + 采集配置页面 :8080，带故障注入）
python3 run_demo.py
# 浏览器打开 http://127.0.0.1:8080/ 填写配置并提交

# 方式二：分别启动
python3 -m siteserver.server --port 8000 --test-mode   # 终端 1
python3 -m collector.cli --config queries.example.json --evidence-dir ./out
```

## 采集器关键设计

### 1. 按会话维护状态机，禁止硬编码

* 隐藏字段值**逐字取自当前页面**（`form.hidden`），按钮参数必须由
  `find_button` 在页面真实按钮中匹配，页面没有的按钮值直接报错；
* 回发/翻页地址只允许使用表单 `action`（解析为绝对 URL），
  `UrlPolicyError` 会拒绝任何不在“入口 + 页面 action”白名单内的请求，
  因此无法构造页面未提供的翻页地址。

### 2. 同名表单消歧

入口页有两个 `name="search"` 的表单、结果页有两个 `name="pager"` 的表单，
其中无隐藏状态、指向 `/dead-end` 的是诱饵。选择规则：

1. 显式 `form_index` 优先；
2. 优先 `method=post` 的回发表单；
3. 优先带隐藏状态字段的真实表单；
4. 仍无法消歧则显式失败，禁止猜测。

### 3. 并行查询与状态过期恢复

* 每个查询一个 `QuerySession` + 独立 `HttpClient`（独立 Cookie），
  线程池并行，状态链天然隔离；
* 收到 4xx / 错误页 / 隐藏状态校验失败特征时判定状态过期，
  丢弃旧 HTTP 客户端，**从入口重新建立状态链并重跑**，恢复次数有上限；
* 页序回退（响应页码 ≠ 上一页 +1）同样触发恢复。

### 4. 恢复后的结果身份校验

首次成功查询即锁定**身份锚点**（关键词、分类、首页数据行 ID 序列），
锚点一旦建立不再被任何恢复覆盖；每次恢复后重新比对，
关键词/分类/ID 序列任一不一致即判 `IdentityMismatchError` 失败，
避免把“另一个查询的结果”误当成本查询结果。

### 5. 关联证据与敏感遮盖

* 每个请求带 `X-Request-Id`，服务端原样回传，证据记录请求与响应的编号关联、
  链编号、链内序号、方法、地址、表单参数、状态码与响应摘要；
* 证据落盘（`evidence.jsonl`）前由 `Redactor` 统一遮盖：
  字段名含 viewstate/nonce/cookie/token 等的值、长十六进制令牌、Cookie 值，
  同一原文遮盖结果稳定（短哈希后缀），可关联但不泄露。

## 测试覆盖（24 项）

```bash
python3 -m unittest discover -s tests -v
```

| 场景 | 测试 |
| --- | --- |
| 隐藏状态每次响应轮转 | `test_hidden_state_rotates_on_every_response` |
| 旧状态失败且会话作废 | `test_stale_state_is_rejected_and_session_killed` |
| 不同会话状态链隔离 | `test_separate_sessions_have_independent_state_chains` |
| 缺按钮参数被拒 | `test_missing_button_parameter_rejected` |
| 同名表单消歧 | `test_same_named_forms_*`、`test_live_page_contains_two_same_named_forms` |
| 按钮参数只能来自页面 | `test_button_lookup_uses_page_values`、`test_button_parameter_must_come_from_page` |
| 全量翻页/过滤 | `test_full_query_paginates_all_four_pages`、`test_keyword_and_category_filtering` |
| **中途过期从入口恢复** | `test_expiry_mid_paging_recovers_from_entry` |
| 首次回发即过期 | `test_expiry_on_first_post_then_recovery_identity_checked` |
| 并行查询链隔离 | `test_parallel_queries_keep_independent_state_chains` |
| **页序回退触发恢复** | `test_page_order_regression_triggers_recovery` |
| **恢复后身份校验失败** | `test_identity_mismatch_after_recovery_fails_the_job` |
| 恢复次数有界 | `test_recovery_budget_is_bounded` |
| 禁止自造翻页地址 | `test_no_fabricated_paging_urls_allowed` |
| 证据关联与遮盖 | `TestEvidence`、`TestRedaction` 全部用例 |
| 配置页面 | `TestWebUI` 全部用例 |

## 故障注入控制端（仅 `--test-mode`）

| 端点 | 作用 |
| --- | --- |
| `POST /__test__/expire` | 作旧当前会话（模拟状态过期） |
| `POST /__test__/regress` | 下一次翻页返回前一页（模拟页序回退） |
| `POST /__test__/mutate` | 全局身份变异（行 ID 加 `X-` 前缀），`off=1` 关闭 |
| `POST /__test__/reset` | 清理会话级一次性标志 |
| `GET /__test__/log` | 服务端访问日志（含 request_id 关联） |
