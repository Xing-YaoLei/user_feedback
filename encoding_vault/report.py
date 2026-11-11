"""对照页面：原始字节 ↔ 解码文本定位的静态 HTML 报告。"""
from __future__ import annotations

from html import escape

from .decode import _SENTINEL

MAX_MAP_ROWS = 4000


def _display_char(ch: str) -> str:
    if ch == _SENTINEL:
        return '�'
    if ch.strip() == '':
        return f'U+{ord(ch):04X}'
    return ch


def _hex_dump(raw: bytes, width: int = 16) -> str:
    lines = []
    for off in range(0, len(raw), width):
        chunk = raw[off:off + width]
        hexs = ' '.join(f'{b:02x}' for b in chunk)
        ascii_ = ''.join(chr(b) if 0x20 <= b < 0x7F else '·' for b in chunk)
        lines.append(f'{off:08x}  {hexs:<{width * 3}}  {ascii_}')
    return '\n'.join(lines)


def render_report(record: dict, meta: dict, raw: bytes, selected: dict) -> str:
    evidence = record['evidence']
    decl_rows = ''.join(
        f"<tr><td>{escape(d['source'])}</td><td>{escape(d['encoding'])}</td></tr>"
        for d in evidence['declarations']) or '<tr><td colspan="2">（无声明）</td></tr>'

    cand_rows = ''.join(
        '<tr{sel}><td>{name}</td><td>{src}</td><td>{der}</td>'
        '<td>{repl}</td><td>{cjk}</td><td>{score}</td></tr>'.format(
            sel=' class="sel"' if c['selected'] else '',
            name=escape(c['name']), src=escape(c['source']),
            der='是' if c['derived'] else '',
            repl=c['replacements'], cjk=c['cjk_chars'], score=c['score'])
        for c in record['candidates'])

    repl_rows = ''.join(
        '<tr><td>{ci}</td><td>{bs}–{be}</td><td class="hex">{hx}</td>'
        '<td>{reason}</td></tr>'.format(
            ci=r.get('char_index', '?'), bs=r['byte_start'], be=r['byte_end'],
            hx=escape(r['bytes_hex']), reason=escape(r['reason']))
        for r in record['replacements']) or '<tr><td colspan="4">无（零不可逆替换）</td></tr>'

    byte_map = selected.get('byte_map')
    if byte_map is None:
        map_section = ('<p>本版本为派生（双重转码恢复）结果，字符位置不直接对应原始字节；'
                       '请以上游基础候选的字节映射为准。</p>')
    else:
        rows = []
        for i, m in enumerate(byte_map[:MAX_MAP_ROWS]):
            cls = ' class="repl"' if m['replacement'] else ''
            hexbytes = raw[m['byte_start']:m['byte_end']].hex(' ')
            rows.append(
                f'<tr{cls}><td>{i}</td>'
                f'<td>{escape(_display_char(m["char"]))}</td>'
                f'<td>{m["byte_start"]}–{m["byte_end"]}</td>'
                f'<td class="hex">{escape(hexbytes)}</td></tr>')
        truncated = (f'<p>仅显示前 {MAX_MAP_ROWS} 行（共 {len(byte_map)} 字符）。</p>'
                     if len(byte_map) > MAX_MAP_ROWS else '')
        map_section = truncated + (
            '<table><thead><tr><th>字符序号</th><th>字符</th>'
            '<th>字节区间</th><th>原始字节(hex)</th></tr></thead>'
            f'<tbody>{"".join(rows)}</tbody></table>')

    fetch = meta['fetches'][-1]
    return f"""<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="utf-8">
<title>对照报告 {escape(record['page_id'])} {record['decode_version']}</title>
<style>
body {{ font-family: -apple-system, "PingFang SC", sans-serif; margin: 2em; }}
table {{ border-collapse: collapse; margin: 1em 0; font-size: 13px; }}
th, td {{ border: 1px solid #ccc; padding: 3px 8px; text-align: left; }}
tr.repl td {{ background: #ffd7d7; }}
tr.sel td {{ background: #d7ecd7; font-weight: bold; }}
.hex {{ font-family: Menlo, monospace; }}
pre {{ background: #f5f5f5; padding: 1em; overflow-x: auto; font-size: 12px; }}
h2 {{ border-bottom: 2px solid #888; padding-bottom: 4px; margin-top: 2em; }}
.badge {{ display: inline-block; padding: 2px 10px; border-radius: 4px;
  background: {'#c0392b' if record['status'] != 'ok' else '#27ae60'}; color: #fff; }}
</style></head><body>
<h1>原始字节 ↔ 文本定位对照报告</h1>
<p>页面 <b>{escape(record['page_id'])}</b>　解码版本 <b>{record['decode_version']}</b>
　状态 <span class="badge">{record['status']}</span></p>

<h2>1. 取证元信息</h2>
<table>
<tr><th>URL</th><td>{escape(fetch['url'])}</td></tr>
<tr><th>抓取时间 (UTC)</th><td>{escape(fetch['fetched_at'])}</td></tr>
<tr><th>SHA-256</th><td class="hex">{record['raw_sha256']}</td></tr>
<tr><th>原始字节数</th><td>{len(raw)}</td></tr>
<tr><th>Content-Type 响应头</th><td>{escape(str(evidence.get('content_type_header')))}</td></tr>
</table>

<h2>2. 编码声明证据{'（存在冲突！）' if evidence['conflict'] else ''}</h2>
<table><thead><tr><th>来源</th><th>声明编码</th></tr></thead>
<tbody>{decl_rows}</tbody></table>

<h2>3. 候选编码评估（当前采用：{escape(record['encoding'])}，来源：{escape(record['encoding_source'])}）</h2>
<table><thead><tr><th>编码</th><th>来源</th><th>派生</th><th>不可逆替换数</th>
<th>CJK 字符数</th><th>评分</th></tr></thead>
<tbody>{cand_rows}</tbody></table>
<p>解码策略：{escape(record['decode_policy'])}</p>

<h2>4. 不可逆替换位置（U+FFFD，共 {len(record['replacements'])} 处）</h2>
<table><thead><tr><th>字符位置</th><th>字节区间</th><th>原始字节(hex)</th>
<th>原因</th></tr></thead>
<tbody>{repl_rows}</tbody></table>

<h2>5. 字节 ↔ 字符对照表</h2>
{map_section}

<h2>6. 原始字节十六进制转储</h2>
<pre>{escape(_hex_dump(raw))}</pre>
</body></html>
"""
