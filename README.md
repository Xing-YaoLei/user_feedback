# helpcenter_diff — 帮助中心新旧版本比对工具

帮助中心换版后，文章地址变化是正常的。本工具回答的是四个问题：

1. **哪篇正文变了** —— 同一编号、同一语言的文章，正文/标题内容差异
2. **哪份附件丢了** —— 附件文件失效，或新版不再引用，并指出引用它的文章
3. **哪些文章新版还在但从首页进不去** —— 页面存在、却没有任何入链的孤儿页面
4. **哪些链接断了 / 页面缺失 / 正文提取失败** —— 分别标明

纯 Python 标准库实现，无需安装第三方依赖，完全离线运行。

## 工作原理

```
规则 JSON（两版各一份：站点根目录、首页、识别/定位规则）
   │
   ├─ Crawler   从首页 BFS 沿站内链接采集，解析页面内相对链接，
   │            记录每条链接边（来源页 → 目标页、链接文本、深度）和断链
   ├─ Extractor 识别文章页，提取 编号/语言/标题/正文/附件地址；
   │            同一 (编号, 语言) 只生成一条记录，多个入口全部保留；
   │            全站扫描找出采集中不可达、但文件确实存在的孤儿文章页
   └─ Differ    按 (编号, 语言) 对齐两版，分类输出差异
```

## 安全运行方式（重要）

迁移组给的站点副本是**不可信数据**，可能包含同名模块（如目录里的 `json.py`）。
必须用隔离模式运行，脚本目录与数据目录分离，站点路径只通过规则参数传入：

```bash
python3 -I run_diff.py compare -r rules.json -o diff_out/
```

`-I`（隔离模式）会忽略环境变量、用户站点包和当前目录的隐式导入；
`run_diff.py` 只把自身所在的可信代码目录加入 `sys.path`。

## 规则文件

完整带注释模板见 [`docs/rules-template.json`](docs/rules-template.json)。顶层：

```json
{
  "old": { ...站点规则... },
  "new": { ...站点规则... }
}
```

站点规则要点：

| 字段 | 说明 |
|---|---|
| `root` | 站点副本目录，相对规则文件所在目录解析 |
| `crawl.index_pages` | 采集起点（首页），可多个 |
| `crawl.base_url` | 站点 URL 前缀，用于相对链接解析与两版对齐 |
| `crawl.include_patterns` / `exclude_patterns` | 采集路径的正则白/黑名单 |
| `crawl.max_pages` | 采集上限，0 不限；触发会在报告中标注结果不完整 |
| `article.url_pattern` | 用 URL 正则识别文章，捕获组取文章编号（推荐） |
| `article.id_selector` + `id_attr` | 元素模式：用页面元素的属性（或文本）取编号 |
| `article.language` | `from`: `url`（正则取语言）/ `element`（取元素属性）/ `fixed`；`default` 给兜底语言 |
| `article.title_selector` / `body_selector` | 标题、正文的 CSS 选择器 |
| `article.body_mode` | `text`（规范化纯文本，默认）或 `html`（保留标签） |
| `article.attachments.include_patterns` | 附件 URL 正则；不填则把非页面类资源都当附件 |

选择器支持标签、`#id`、`.class`、`[attr]` 及 `= != ~= ^= $= *=` 属性运算、
后代/子/相邻/兄弟组合器、逗号列表和 `:not()`。

## 命令

```bash
# 完整比对，输出 diff_out/report.json 与 diff_out/report.md
python3 -I run_diff.py compare -r rules.json -o diff_out/

# 只采集单版，调试规则是否命中（输出页面、入链、文章、断链、孤儿）
python3 -I run_diff.py crawl -r rules.json --site new -o /tmp/new-crawl.json

# 跑测试
python3 -I -m unittest discover -s tests -v
```

## 报告怎么读

**Markdown（人工阅读）** 按差异类别分章：

- 新版页面缺失 / 新版新增文章
- 正文变化 / 标题变化
- 附件丢失（区分「文件失效」与「新版不再引用」）
- 存在但无入口（孤儿）
- 正文提取失败（附失败页面与原因）
- 链接断开（来源页面、断开目标、链接文本）
- 失效附件及引用文章（附件地址 → 文章编号、语言、引用页面）

每篇文章列出两版**全部入口**：入口 URL、深度、来源页、链接文本。

**JSON（机器处理）** 结构与 Markdown 同源，关键字段：

- `article_diffs[]`：按 `(article_id, language)` 对齐，含 `categories` 标签、
  两版 `entries_*`、`pages_*`、`attachments`、`errors_*`、`orphan_*`
- `broken_links[]`：断链清单
- `dead_attachments[]`：失效附件及其引用文章
- `old_stats` / `new_stats` 与 `summary.by_category`：计数总览

附件状态取值：`ok`（存在）、`missing`（被引用但文件失效）、`absent`（该版未引用）。

## 目录结构

```
helpcenter_diff/
  dom.py        基于 html.parser 的容错 DOM
  selector.py   CSS 选择器子集引擎
  siteio.py     URL↔本地路径映射、编码探测、相对链接解析
  config.py     规则加载与校验
  crawler.py    BFS 采集、链接边与断链
  extractor.py  文章识别、字段/附件提取、孤儿扫描
  differ.py     两版对齐与差异分类
  report.py     JSON / Markdown 输出
  cli.py        命令行入口
tests/          29 个单元与端到端测试（含覆盖全部差异场景的迷你双版站点）
run_diff.py     隔离模式启动器
docs/           规则模板
```

## 设计约束

- **一个编号 × 一种语言 = 一条文章记录**；多个访问入口累加在同一条记录上，不合并丢弃
- 正文比较基于规范化文本的 SHA-256；需要标签级对比时把 `body_mode` 设为 `html`
- 外链不采集、不判活；站内资源只校验本地副本是否存在
- 目录穿越路径（如 `../../etc/passwd`）会被拦截
