# 多级筛选设备目录采集系统

从一个只提供 **地区 → 机构 → 设备类型** 三级联动筛选入口的网页采集设备目录。
包含三部分：

| 模块 | 作用 |
| --- | --- |
| `testsite/` | 本地测试站（纯标准库 HTTP 服务 + 前端页面），内置多种故障注入 |
| `crawler/` | Playwright 爬虫：逐层发现、一致性校验后采集、去重留归属、断点续跑 |
| `tests/` | pytest 全量验证（站点、浏览器会话、引擎、约束） |

## 快速开始

```bash
# 依赖（本机已带 chromium 缓存）
.venv/bin/pip install -r requirements.txt

# 1. 启动测试站
.venv/bin/python -m testsite.run --port 8765

# 2. 另开终端运行爬虫（状态写到 out/run1）
.venv/bin/python -m crawler.cli --url http://127.0.0.1:8765 --state-dir out/run1

# 再次运行同一条命令 = 断点续跑，已完成/空分支自动跳过
.venv/bin/python -m crawler.cli --url http://127.0.0.1:8765 --state-dir out/run1

# 跑测试
.venv/bin/python -m pytest -q
```

运行中按 `Ctrl-C`：当前组合处理完后**优雅暂停**（再按一次立即退出），
进度已逐组合原子落盘；重跑命令即恢复。

## 测试站特征（模拟真实难点）

页面行为（`testsite/static/app.js`）：

- 下级选项依赖上级，未选上级时下拉禁用；部分机构“登记支持”某类型但**无数据**（空分支）。
- 切换筛选后结果**异步刷新，加载期间保留旧内容**，不立即清空。
- 请求失败时旧内容与旧签名保留，只显示错误横幅 —— 不能把失败误判为空。
- 结果带**签名** `region|institution|type|count`（结果标识），空结果渲染显式空标识。
- 晚到的旧响应仍会渲染（前端不防竞态），由采集方凭签名识别。

故障注入（`POST /api/control`，测试通过该接口配置）：

| 参数 | 效果 |
| --- | --- |
| `fail_first` / `fail_remaining` | devices 接口前 N 次 / 剩余 N 次返回 500，之后恢复 |
| `slow_mode` | 响应整体变慢，拉长“旧内容残留”窗口 |
| `overtake` | 每个组合首个 devices 请求延迟，复现旧响应晚到覆盖新结果 |
| `shuffle` | 打乱选项顺序（爬虫必须按 id 而非位置选择） |
| `delay_range` | 随机延迟区间 |

## 爬虫关键设计（`crawler/`）

1. **逐层发现，不枚举后台**：只通过浏览器读取下拉框选项来发现
   地区/机构/类型，源码不导入 `testsite.data`（有测试强制检查）。
2. **条件与结果标识一致后才采集**：点击查询后轮询页面，仅当
   状态为 `ready`、结果签名以当前三级条件前缀开头、且数据行或空标识就位时才读数；
   loading 中或签名仍是旧组合（旧内容残留 / 旧响应晚到）时继续等待。
3. **失败不剪枝**：错误横幅 / 一致性超时触发指数退避重试；
   重试耗尽标记 `failed` 保留在树中，续跑继续重试，绝不写成 `empty`。
4. **空分支是“确认过的空”**：只有正常返回且页面给出空标识才记 `empty`。
5. **实体去重 + 归属保留**：同一设备在多个组合出现时只存一条实体，
   `sources` 记录它出现过的全部筛选组合。
6. **断点续跑**：每处理完一个组合就原子写 `state.json`；
   重跑时 `done/empty` 跳过，`failed/pending` 重试。
7. **不盲等**：所有等待都基于 DOM 状态/事件（`wait_for_function`、
   `networkidle`），唯一的 `time.sleep` 是退避算法（有 AST 测试强制）。

## 输出文件（状态目录）

- `state.json` — 每个组合的状态（done/empty/failed/pending）、尝试次数、设备 id
- `devices.json` — 去重后的设备实体，含 `sources` 归属组合列表
- `coverage_tree.json` — 地区/机构/类型嵌套的**分支覆盖树**
- `events.jsonl` — 事件流：start / discover / captured / empty_branch /
  retry / branch_failed / pause_requested / resume / done

## 测试覆盖（`tests/`）

- `test_site_api.py`：三级联动、空结果显式标识、500 后恢复、选项乱序
- `test_browser_session.py`：正常采集、空分支、错误横幅保留旧内容、慢响应旧内容、
  跨组合旧响应晚到（签名闸门）、乱序下按 id 选择
- `test_crawler_engine.py`：全量结果与事实基准比对、空分支不剪枝、
  瞬时失败重试、失败续跑恢复、暂停/恢复跳过已完成分支、乱序筛选次序、
  重复实体去重留归属、slow_mode / overtake 全量爬取、禁止导入后台数据
- `test_constraints.py`：退避指数、禁止固定秒数盲等（AST）、状态原子写与重载
