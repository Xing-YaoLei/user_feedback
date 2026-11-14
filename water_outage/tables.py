"""表格处理：先展开 rowspan/colspan 合并单元格，再按多级表头定位列。"""

from __future__ import annotations

from .html import Node


def _span(node, attr):
    try:
        value = int(node.get(attr, "1") or "1")
    except (TypeError, ValueError):
        return 1
    return max(1, value)


def expand_table(table_node):
    """展开表格的合并单元格，返回规整的二维网格。

    每个格子是 {"text": 纯文本, "node": 原始单元格节点} 的字典；
    被 rowspan/colspan 覆盖出来的格子与源格子引用同一个节点。
    """
    occupied = {}  # (row_idx, col_idx) -> cell dict
    grid = []
    row_idx = 0

    for tr in table_node.find_all("tr"):
        if row_idx >= len(grid):
            grid.append([])
        col_idx = 0
        for cell in tr.children:
            if cell.tag not in ("td", "th"):
                continue
            # 跳过已被上方 rowspan 占据的列
            while (row_idx, col_idx) in occupied:
                col_idx += 1
            start_col = col_idx
            rowspan = _span(cell, "rowspan")
            colspan = _span(cell, "colspan")
            data = {"text": cell.get_text(" ").strip(), "node": cell}
            for delta_r in range(rowspan):
                for delta_c in range(colspan):
                    r, c = row_idx + delta_r, start_col + delta_c
                    occupied[(r, c)] = data
                    while len(grid) <= r:
                        grid.append([])
            col_idx = start_col + colspan
        row_idx += 1

    # 按已登记格子的最大列号补齐宽度，返回规整网格
    width = 0
    for (_, c) in occupied:
        width = max(width, c + 1)
    result = []
    for r in range(len(grid)):
        row = []
        for c in range(width):
            row.append(occupied.get((r, c), {"text": "", "node": None}))
        result.append(row)
    return result


def _is_header_row(row):
    cells = [cell["node"] for cell in row if cell["node"] is not None]
    if not cells:
        return False
    return all(node.tag == "th" for node in cells)


def _header_header_rows(grid, table_node):
    """优先使用 thead 中的行，否则取表体前导的全 th 行。"""
    thead = table_node.find("thead")
    if thead is not None and thead.find_all("tr"):
        header_tr_ids = {id(tr) for tr in thead.find_all("tr")}
        indices = []
        all_trs = table_node.find_all("tr")
        for idx, tr in enumerate(all_trs):
            if id(tr) in header_tr_ids:
                indices.append(idx)
        return indices
    indices = []
    for idx, row in enumerate(grid):
        if _is_header_row(row):
            indices.append(idx)
        else:
            break
    return indices


def _classify(text):
    """根据表头文本判断列类型：region / start / end / None。"""
    if not text:
        return None
    if any(key in text for key in ("开始", "起", "起始")):
        return "start"
    if any(key in text for key in ("结束", "止", "截止", "终止")):
        return "end"
    if "区域" in text or "地区" in text or "范围" in text:
        return "region"
    return None


def resolve_columns(grid, table_node):
    """识别多级表头，返回 (列映射, 表头行数)。

    列映射形如 {"region": 0, "start": 1, "end": 2}，缺列时对应键不存在。
    多级表头会把同一列上各层表头文字合并后再做关键字匹配。
    """
    header_indices = _header_header_rows(grid, table_node)
    if not header_indices:
        # 退化情况：没有 th 行时把第一行当表头
        header_indices = [0]

    width = max((len(row) for row in grid), default=0)
    column_titles = [[] for _ in range(width)]
    for r in header_indices:
        for c in range(width):
            text = grid[r][c]["text"]
            if text and text not in column_titles[c]:
                column_titles[c].append(text)

    mapping = {}
    for c, titles in enumerate(column_titles):
        joined = " ".join(titles)
        kind = _classify(joined)
        if kind and kind not in mapping:
            mapping[kind] = c
    return mapping, len(header_indices)


def parse_table(table_node):
    """完整解析一张表，返回 (数据行字典列表, 列映射)。

    数据行以规整网格的行形式返回（合并单元格已展开）。
    """
    grid = expand_table(table_node)
    mapping, header_count = resolve_columns(grid, table_node)
    body_rows = grid[header_count:]
    return body_rows, mapping
