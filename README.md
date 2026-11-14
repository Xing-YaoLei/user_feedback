# user_feedback

从手册目录页出发，生成每章一份 JSONL 的搜索索引，并单独输出异常清单。

## 用法

```bash
python3 -m indexer --toc site/index.html --out build
```

- `--toc`：手册目录页（本地路径或 `file://` / `http(s)://` URL）
- `--out`：输出目录
- `--root`：可选，用于把输出中的 URL 显示成相对路径；默认取目录页所在目录

输出：

```
build/
  index/
    guide-chapter-1.jsonl
    guide-chapter-2.jsonl
    ...
  exceptions.jsonl
  manifest.json
```

每章 JSONL 的第一行是章节元数据，其后按正文原顺序排列段落：

```json
{"type":"chapter","chapter_url":"guide/chapter-1.html","title":"第 1 章 普通链接","paragraphs":4}
{"type":"paragraph","text":"本章全部使用普通链接，不展开任何片段。","source":"guide/chapter-1.html","anchor":"overview"}
{"type":"paragraph","text":"安装之前请先确认系统版本满足要求。","source":"shared/basics.html","anchor":"install"}
```

`source` 是该段实际来源页，`anchor` 是它所属的片段锚点（章节自身段落为其所在小节标题的锚点，
没有则为 `null`）。

`exceptions.jsonl` 的每一行记录一个被排除的章节：

```json
{"type":"exception","chapter":"guide/chapter-5.html","title":"第 5 章 循环引用","kind":"cycle",
 "message":"检测到循环引用：guide/chapter-5.html -> shared/advanced.html#loop-a -> shared/advanced.html#loop-b -> shared/advanced.html#loop-a",
 "chain":[...],"include_chain":["guide/chapter-5.html","shared/advanced.html#loop-a","shared/advanced.html#loop-b","shared/advanced.html#loop-a"]}
```

`kind` 为 `cycle`、`missing-anchor`、`missing-page`（章节页本身缺失也记为 `missing-page`）。

## 采集规则

- 章节目录来自目录页里的链接，按出现顺序处理。
- 正文按文档顺序取 `<p>`；普通链接只保留可见文字（含其中的 `<strong>` 等内联元素的文字）。
- `<a data-include href="...">` 用它指向的片段段落替换链接本身。片段内的段落可以再包含别的片段。
- 相对地址按“出现该链接的页面”解析，所以 `guide/sub/chapter-3.html` 里的
  `../../shared/basics.html#install` 指向 `shared/basics.html`。
- 同一片段在同一章里出现几次就输出几次，不做去重；只有同一页 + 同一片段再次出现在
  **当前引用链**上才判为循环。
- 一次采集中同一页面只读取、只解析一次；该页的多个锚点共用这次读取。
- 某章出现循环、目标页面不存在或锚点不存在时，整章写入 `exceptions.jsonl`，不生成它的
  JSONL；其他章继续处理。

## 锚点的范围

支持这些写法：

- `<section id>` / `<div id>` / `<article id>` 等容器：容器内全部段落。
- 带 `id` 的标题：该标题到下一个同级/更高级标题（或下一个带 id 的元素）之间的段落。
- 带 `id` 的 `<p>`：该段本身。
- 带 `id` 的内联元素：其所在块的区间。
- 旧式空锚点 `<a id>` / `<a name>`：其后连续的兄弟块。

## 本地示例站点

`site/` 同时覆盖了这些情况：

| 页面 | 覆盖点 |
| --- | --- |
| `site/index.html` | 目录页 |
| `site/guide/chapter-1.html` | 普通链接只保留可见文字 |
| `site/guide/chapter-2.html` | 跨目录共享片段、片段内再引用片段 |
| `site/guide/sub/chapter-3.html` | 两级相对路径（`../../`） |
| `site/guide/sub/chapter-4.html` | 同一片段在一章内出现三次 |
| `site/guide/chapter-5.html` | 循环引用（`loop-a` ↔ `loop-b`） |
| `site/guide/chapter-6.html` | 锚点缺失 |
| `site/guide/chapter-7.html` | 目标页面缺失 |

## 测试

```bash
python3 -m unittest discover -s tests -v
```

## 实现说明

- `indexer/htmlnode.py`：标准库 `html.parser` 之上的一棵小 DOM，以及锚点区间解析。
- `indexer/crawl.py`：页面缓存、TOC 解析、正文展开、循环检测、输出。
- 只处理 `<p>` 作为正文单位；标题、列表项等其他块不进入索引。
- 段落被内联 include 截断时，按出现位置拆成多条记录，片段段落插在中间；
  只含标点的残片会被丢弃。
