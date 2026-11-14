# 停水公告采集与解析

从列表页出发采集停水公告详情，展开表格合并单元格、识别多级表头，输出可按区域查询的
停水时段 JSONL，并对缺列、时间颠倒等问题生成异常清单。仅依赖 Python 标准库。

## 目录结构

```
water_outage/        采集解析包
  html.py            HTML 节点树解析（基于 html.parser）
  fetch.py           页面抓取，支持 http(s) 与 file://，处理相对地址与锚点
  crawl.py           列表页遍历：rel="next" 翻页、data-notice 详情链接、回环终止
  tables.py          rowspan/colspan 展开 + 多级表头列识别
  timeparse.py       中英文时间解析，统一输出 ISO 格式
  notice.py          详情页解析、版次/编号提取、异常判定
  pipeline.py        整体编排与区域查询
  cli.py             命令行入口
sample_site/         本地样站（跨页重复 / 翻页回环 / 多级表头 / 两类异常）
tests/               单元测试与端到端测试
```

## 快速开始

```bash
# 方式一：直接用 file:// 地址，无需启动服务
python3 -m water_outage.cli \
  "$(pwd)/sample_site/list/page1.html" \
  -o outages.jsonl -a anomalies.jsonl

# 方式二：启动本地样站后走 HTTP
./serve_sample.sh            # http://127.0.0.1:8000/list/page1.html
python3 -m water_outage.cli http://127.0.0.1:8000/list/page1.html

# 只看某个区域的停水时段
python3 -m water_outage.cli <列表页URL> --region 朝阳区
```

## 输出格式

`outages.jsonl` 每行一条记录，对应一个区域的一段停水时段：

```json
{"notice_id": "GS-2026-001", "version": 3, "region": "朝阳区望京街道",
 "start_time": "2026-11-16T23:00:00", "end_time": "2026-11-17T05:30:00",
 "source_url": "http://.../notices/001.html"}
```

`anomalies.jsonl` 每行一条异常，含公告编号、版次、出错位置与原因：

```json
{"notice_id": "GS-2026-002", "version": 1, "source_url": "...",
 "error_type": "time_order", "location": "表1 第4行",
 "detail": "结束时间 '2026-11-21 10:00' 不晚于开始时间 '2026-11-21 22:00'"}
```

## 处理规则

- **翻页**：从列表页起沿 `rel="next"` 线性遍历；相对地址按页面（含 `<base>`）解析，
  去掉 `#锚点` 后比较；next 回指任一已访问页面时立即结束，不会死循环。
- **详情链接**：只收集带 `data-notice` 属性的 `<a>`；同一详情页在多个列表页重复出现
  （仅锚点不同）按去锚点 URL 去重。
- **版次**：同一公告编号可能对应多个详情页，以详情页自身标注的最高数字版次为准，
  历史版次不参与输出。编号/版次优先读 `<meta name="notice-id|notice-version">`，
  回退到正文里的“公告编号”“第N版”文本。
- **表格**：先把 rowspan/colspan 展开成规整网格，再合并多级表头各层文字，
  按关键字识别区域、开始时间、结束时间三列。
- **异常即跳过整则公告**：
  - 最新版表格缺任一必需列 → `missing_columns`；
  - 任一行结束时间不晚于开始时间 → `time_order`；
  - 时间文本无法解析 → `invalid_time`（仅跳过该行，并在异常清单注明位置）。
  前两类会跳过该公告的全部时段，异常清单保留版次与出错位置。

## 样站复现的场景

| 文件 | 场景 |
| --- | --- |
| `list/page1.html`、`page2.html` | 同一 `001.html` 跨页重复、锚点不同 |
| `list/page3.html` | `rel="next"` 带锚点回指 page1，触发回环终止 |
| `notices/001.html` | 两级表头（rowspan+colspan）与三个区域行 |
| `notices/001_v1/v2.html` | 同公告历史版次，验证最高版次生效 |
| `notices/002.html` | 结束时间早于开始时间 |
| `notices/003.html` | 最新版缺结束时间列 |
| `notices/004.html` | 中文“年月日时分”时间格式 |

## 测试

```bash
python3 -m unittest discover -s tests -v
```
