"""生成迷你双版站点 fixture，覆盖比对工具的全部差异场景。

场景地图：
  1001 zh  两版都有，正文被改动            -> body_changed
  1001 en  两版都有，标题被改动            -> title_changed
  1002 zh  新版页面缺失                    -> missing_in_new
  1003 zh  新版新增                        -> missing_in_old
  1004 zh  附件文件新版丢失                -> attachment_lost (missing)
  1005 zh  附件新版不再引用                -> attachment_lost (absent)
  1006 zh  新版页面仍在但首页无入口（孤儿） -> orphan
  1007 zh  新版正文选择器无匹配            -> extract_failed
  1008 zh  新版有页面但内部链接断开        -> broken_link
  1009 zh  同一篇两个入口（分类页+首页）   -> 多入口保留
  1010 zh  附件地址失效                    -> dead_attachment + 引用文章
"""

from __future__ import annotations

from pathlib import Path

OLD_FILES = {
    "index.html": """<!doctype html><html lang="zh">
<head><meta charset="utf-8"><title>帮助中心</title></head>
<body>
<h1>帮助中心首页</h1>
<nav>
  <a href="/articles/1001-zh.html">入门指南</a>
  <a href="/articles/1002-zh.html">旧版独有文章</a>
  <a href="/articles/1004-zh.html">附件文章一</a>
  <a href="/articles/1005-zh.html">附件文章二</a>
  <a href="/articles/1006-zh.html">会变孤儿的文章</a>
  <a href="/articles/1007-zh.html">会提取失败的文章</a>
  <a href="/articles/1008-zh.html">断链文章</a>
  <a href="/articles/1009-zh.html">多入口文章</a>
  <a href="/articles/1010-zh.html">失效附件文章</a>
  <a href="/category/guide.html">分类页</a>
</nav>
<a href="/en/articles/1001-en.html">English getting started</a>
</body></html>""",

    "category/guide.html": """<!doctype html><html lang="zh"><body>
<h1>分类页</h1>
<a href="/articles/1009-zh.html">多入口文章（分类入口）</a>
<a href="../articles/1001-zh.html">入门指南（相对路径）</a>
</body></html>""",

    "articles/1001-zh.html": """<!doctype html><html lang="zh"><body>
<h1 class="article-title">入门指南</h1>
<div class="article-body"><p>第一步：打开开关。</p><p>第二步：检查指示灯。</p></div>
<a href="/index.html">返回首页</a>
</body></html>""",

    "en/articles/1001-en.html": """<!doctype html><html lang="en"><body>
<h1 class="article-title">Getting Started</h1>
<div class="article-body"><p>Step one: turn it on.</p></div>
</body></html>""",

    "articles/1002-zh.html": """<!doctype html><html lang="zh"><body>
<h1 class="article-title">旧版独有文章</h1>
<div class="article-body"><p>这篇在新版会被删掉。</p></div>
</body></html>""",

    "articles/1004-zh.html": """<!doctype html><html lang="zh"><body>
<h1 class="article-title">附件文章一</h1>
<div class="article-body">
<p>请下载手册：<a href="/files/manual-1004.pdf">手册 PDF</a></p>
</div></body></html>""",

    "articles/1005-zh.html": """<!doctype html><html lang="zh"><body>
<h1 class="article-title">附件文章二</h1>
<div class="article-body">
<p>表格：<a href="/files/table-1005.xlsx">表格</a></p>
</div></body></html>""",

    "articles/1006-zh.html": """<!doctype html><html lang="zh"><body>
<h1 class="article-title">会变孤儿的文章</h1>
<div class="article-body"><p>新版页面还在，但没有任何页面链接到它。</p></div>
</body></html>""",

    "articles/1007-zh.html": """<!doctype html><html lang="zh"><body>
<h1 class="article-title">会提取失败的文章</h1>
<div class="article-body"><p>旧版正文正常。</p></div>
</body></html>""",

    "articles/1008-zh.html": """<!doctype html><html lang="zh"><body>
<h1 class="article-title">断链文章</h1>
<div class="article-body"><p>正文。</p></div>
</body></html>""",

    "articles/1009-zh.html": """<!doctype html><html lang="zh"><body>
<h1 class="article-title">多入口文章</h1>
<div class="article-body"><p>首页和分类页都能到这里。</p></div>
</body></html>""",

    "articles/1010-zh.html": """<!doctype html><html lang="zh"><body>
<h1 class="article-title">失效附件文章</h1>
<div class="article-body">
<p><a href="/files/broken-1010.pdf">已经失效的附件</a></p>
</div></body></html>""",

    "files/manual-1004.pdf": "%PDF-1.4 old manual",
    "files/table-1005.xlsx": "old xlsx bytes",
    # 1010 引用的 broken-1010.pdf 故意不存在
}

NEW_FILES = {
    "index.html": """<!doctype html><html lang="zh">
<head><meta charset="utf-8"><title>帮助中心新版</title></head>
<body>
<h1>帮助中心首页</h1>
<nav>
  <a href="/help/article/1001-zh.html">入门指南</a>
  <a href="/help/article/1003-zh.html">新版新增文章</a>
  <a href="/help/article/1004-zh.html">附件文章一</a>
  <a href="/help/article/1005-zh.html">附件文章二</a>
  <a href="/help/article/1007-zh.html">会提取失败的文章</a>
  <a href="/help/article/1008-zh.html">断链文章</a>
  <a href="/help/article/1009-zh.html">多入口文章</a>
  <a href="/help/article/1010-zh.html">失效附件文章</a>
  <a href="/category/guide.html">分类页</a>
</nav>
<a href="/en/help/article/1001-en.html">English guide</a>
</body></html>""",

    "category/guide.html": """<!doctype html><html lang="zh"><body>
<h1>分类页</h1>
<a href="/help/article/1009-zh.html">多入口文章（分类入口）</a>
</body></html>""",

    # 1001 zh：正文改动
    "help/article/1001-zh.html": """<!doctype html><html lang="zh"><body>
<h1 class="article-title">入门指南</h1>
<div class="article-body"><p>第一步：接通电源。</p><p>第二步：检查指示灯。</p><p>第三步：联网。</p></div>
</body></html>""",

    # 1001 en：标题改动
    "en/help/article/1001-en.html": """<!doctype html><html lang="en"><body>
<h1 class="article-title">Getting Started Guide</h1>
<div class="article-body"><p>Step one: turn it on.</p></div>
</body></html>""",

    # 1003 新增
    "help/article/1003-zh.html": """<!doctype html><html lang="zh"><body>
<h1 class="article-title">新版新增文章</h1>
<div class="article-body"><p>这篇旧版没有。</p></div>
</body></html>""",

    # 1004：附件文件在新版丢失（链接还在，文件没了）
    "help/article/1004-zh.html": """<!doctype html><html lang="zh"><body>
<h1 class="article-title">附件文章一</h1>
<div class="article-body">
<p>请下载手册：<a href="/files/manual-1004.pdf">手册 PDF</a></p>
</div></body></html>""",

    # 1005：附件不再被引用（文件保留也没关系，这里直接不放）
    "help/article/1005-zh.html": """<!doctype html><html lang="zh"><body>
<h1 class="article-title">附件文章二</h1>
<div class="article-body"><p>正文直接给了表格内容，不再附文件。</p></div>
</body></html>""",

    # 1006：孤儿页面，文件存在但无入链
    "help/article/1006-zh.html": """<!doctype html><html lang="zh"><body>
<h1 class="article-title">会变孤儿的文章</h1>
<div class="article-body"><p>新版页面还在，但没有任何页面链接到它。</p></div>
</body></html>""",

    # 1007：正文容器 class 变了，规则仍按旧选择器 -> 提取失败
    "help/article/1007-zh.html": """<!doctype html><html lang="zh"><body>
<h1 class="article-title">会提取失败的文章</h1>
<div class="rich-content"><p>新版正文容器改名了。</p></div>
</body></html>""",

    # 1008：页面里有一条指向不存在页面的断链
    "help/article/1008-zh.html": """<!doctype html><html lang="zh"><body>
<h1 class="article-title">断链文章</h1>
<div class="article-body"><p>正文。</p>
<a href="/help/article/9999-zh.html">不存在的相关文章</a>
</div></body></html>""",

    "help/article/1009-zh.html": """<!doctype html><html lang="zh"><body>
<h1 class="article-title">多入口文章</h1>
<div class="article-body"><p>首页和分类页都能到这里。</p></div>
</body></html>""",

    "help/article/1010-zh.html": """<!doctype html><html lang="zh"><body>
<h1 class="article-title">失效附件文章</h1>
<div class="article-body">
<p><a href="/files/broken-1010.pdf">已经失效的附件</a></p>
</div></body></html>""",

    # 1002 缺失；files/manual-1004.pdf 缺失；table-1005.xlsx 也不放
}


def write_site(root: Path, files: dict[str, str]) -> None:
    for rel, content in files.items():
        target = root / rel
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(content, encoding="utf-8")


def build_sites(base: Path) -> tuple[Path, Path]:
    old_root = base / "old"
    new_root = base / "new"
    write_site(old_root, OLD_FILES)
    write_site(new_root, NEW_FILES)
    return old_root, new_root


RULES_TEMPLATE = {
    "old": {
        "crawl": {"index_pages": ["index.html"], "base_url": "http://help.test/"},
        "article": {
            "url_pattern": r"/articles/(\d+)-",
            "language": {"from": "url", "pattern": r"/(en)/", "group": 1,
                         "default": "zh"},
            "title_selector": "h1.article-title",
            "body_selector": "div.article-body",
            "attachments": {
                "include_patterns": [r"\.(pdf|xlsx?|docx?|zip)$"],
            },
        },
    },
    "new": {
        "crawl": {"index_pages": ["index.html"], "base_url": "http://help.test/"},
        "article": {
            "url_pattern": r"/help/article/(\d+)-",
            "language": {"from": "url", "pattern": r"/(en)/", "group": 1,
                         "default": "zh"},
            "title_selector": "h1.article-title",
            "body_selector": "div.article-body",
            "attachments": {
                "include_patterns": [r"\.(pdf|xlsx?|docx?|zip)$"],
            },
        },
    },
}


def build_rules(base: Path) -> Path:
    import json
    old_root, new_root = build_sites(base)
    rules = {
        "old": {**RULES_TEMPLATE["old"], "root": str(old_root)},
        "new": {**RULES_TEMPLATE["new"], "root": str(new_root)},
    }
    # 英文文章路径 /en/articles/ 与 /en/help/article/ 也要被 url_pattern 命中
    rules["old"]["article"]["url_pattern"] = r"/(?:articles|help/article)/(\d+)-"
    rules["new"]["article"]["url_pattern"] = r"/(?:articles|help/article)/(\d+)-"
    path = base / "rules.json"
    path.write_text(json.dumps(rules, ensure_ascii=False), encoding="utf-8")
    return path
