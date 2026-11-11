# -*- coding: utf-8 -*-
"""站点页面渲染。

页面中刻意放置同名表单：
* 入口页两个 name="search" 的表单，只有带隐藏状态的那个是真实表单；
* 结果页两个 name="pager" 的表单，诱饵表单指向不存在的 /dead-end。
"""

import html

from . import data


def _h(value) -> str:
    return html.escape(str(value), quote=True)


def render_entry(sess) -> str:
    options = "".join(
        f'<option value="{_h(c)}"{" selected" if c == sess.category else ""}>{_h(c)}</option>'
        for c in data.CATEGORIES
    )
    return f"""<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="page-type" content="entry">
<title>商品查询入口</title>
</head>
<body>
<h1>传统回发表单站点 · 商品查询</h1>

<!-- 同名诱饵表单：没有任何隐藏状态字段，提交地址也不存在 -->
<form name="search" id="search-decoy" method="post" action="/dead-end">
  <input type="text" name="q" placeholder="诱饵搜索框">
  <button type="submit" name="btn" value="search">查询</button>
</form>

<!-- 真实查询表单：携带服务端一次性隐藏状态 -->
<form name="search" id="search-real" method="post" action="/query">
  <input type="hidden" name="_viewstate" value="{_h(sess.viewstate)}">
  <input type="hidden" name="_nonce" value="{_h(sess.nonce)}">
  <label>关键词 <input type="text" name="q" value="{_h(sess.keyword)}"></label>
  <label>分类
    <select name="category">
      {options}
    </select>
  </label>
  <button type="submit" name="btn" value="search">查询</button>
  <button type="submit" name="btn" value="reset">重置条件</button>
</form>
</body>
</html>
"""


def _render_real_pager(sess, page, total_pages):
    hidden_page = page + 1  # 表单声明的“下一页”目标页，仅用于客户端顺序自检
    buttons = []
    if page > 1:
        buttons.append('<button type="submit" name="btn" value="prev">上一页</button>')
    if page < total_pages:
        buttons.append(
            '<button type="submit" name="btn" value="next">下一页</button>'
        )
    if not buttons:
        return ""
    return f"""
<form name="pager" id="pager-real" method="post" action="/pager">
  <input type="hidden" name="_viewstate" value="{_h(sess.viewstate)}">
  <input type="hidden" name="_nonce" value="{_h(sess.nonce)}">
  <input type="hidden" name="page" value="{hidden_page}">
  {"".join(buttons)}
</form>"""


def render_results(sess, rows, page: int, total_pages: int, mutated: bool = False) -> str:
    trs = []
    for item in rows:
        pid = f"X-{item.pid}" if mutated else item.pid
        trs.append(
            '<tr class="row" data-id="{pid}">'
            '<td class="pid">{pid}</td>'
            '<td class="sku">{sku}</td>'
            '<td class="name">{name}</td>'
            '<td class="category">{category}</td>'
            '<td class="price">{price}</td></tr>'.format(
                pid=_h(pid),
                sku=_h(item.sku),
                name=_h(item.name),
                category=_h(item.category),
                price=_h(item.price),
            )
        )
    rows_html = "\n".join(trs) or '<tr class="empty"><td colspan="5">无匹配记录</td></tr>'
    decoy_pager = """
<form name="pager" id="pager-decoy" method="post" action="/dead-end">
  <button type="submit" name="btn" value="next">下一页</button>
</form>"""
    return f"""<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="page-type" content="results">
<meta name="page-number" content="{page}">
<title>查询结果 第 {page} 页</title>
</head>
<body>
<h1>查询结果</h1>
<div id="query-identity" data-keyword="{_h(sess.keyword)}"
     data-category="{_h(sess.category)}">
  关键词：{_h(sess.keyword) or "（空）"} ｜ 分类：{_h(sess.category)} ｜
  第 {page} / {total_pages} 页
</div>
<table id="result-table">
<thead><tr><th>编号</th><th>SKU</th><th>名称</th><th>分类</th><th>价格</th></tr></thead>
<tbody>
{rows_html}
</tbody>
</table>
{decoy_pager}
{_render_real_pager(sess, page, total_pages)}
</body>
</html>
"""


def render_error(reason: str, status: int = 400) -> str:
    return f"""<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="page-type" content="error">
<title>请求错误</title>
</head>
<body>
<h1>请求被拒绝</h1>
<div class="error-message" data-status="{status}">{_h(reason)}</div>
<p><a href="/">返回入口重新建立会话</a></p>
</body>
</html>
"""
