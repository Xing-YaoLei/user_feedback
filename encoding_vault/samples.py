"""生成本地测试站样本：混合编码、声明冲突、截断多字节、重复转码乱码。

每个样本都在 manifest 中记录真实编码与（可能错误的）对外声明，
用于验证采集解码流水线不凭声明轻信、不静默丢字节。
"""
from __future__ import annotations

import codecs
import json
from pathlib import Path

_TEMPLATE = """<!DOCTYPE html>
<html><head><meta charset="{meta_charset}"><title>{title}</title></head>
<body>
<h1>{title}</h1>
<p>姓名：{name}</p>
<p>日期：{date}</p>
<p>编号：{code}</p>
<p>备注：{note}</p>
<p>归档人：{archivist}</p>
</body></html>{tail}"""

# 每个样本：真实编码 vs 响应头声明 vs 页面 meta 声明，刻意制造冲突
SAMPLES = [
    {
        'file': 'ok-utf8.html',
        'title': '第一区户籍册（对照组）',
        'name': '李秀英', 'date': '1949年10月1日', 'code': 'A-00317',
        'note': '粮食产量 1234.5 公斤，人口 37 人',
        'archivist': '王档案馆',
        'true_encoding': 'utf-8', 'meta_charset': 'utf-8',
        'content_type': 'text/html; charset=utf-8',
        'description': 'UTF-8，三方声明一致（对照组）',
    },
    {
        'file': 'gb-as-utf8.html',
        'title': '土地改革丈量记录',
        'name': '王建国', 'date': '1953年2月18日', 'code': 'B-11042',
        'note': '耕地面积 86.75 亩，地块编号 42 号',
        'archivist': '王档案馆',
        'true_encoding': 'gb18030', 'meta_charset': 'utf-8',
        'content_type': 'text/html; charset=utf-8',
        'description': '字节是 GB18030，响应头与 meta 都谎称 UTF-8',
    },
    {
        'file': 'bom-vs-meta.html',
        'title': '供销社账目',
        'name': '张梅', 'date': '1962年7月9日', 'code': 'C-20871',
        'note': '布匹 250 尺，金额 17.30 元',
        'archivist': '王档案馆',
        'true_encoding': 'utf-8', 'meta_charset': 'gb2312', 'bom': True,
        'content_type': 'text/html',  # 响应头不带 charset
        'description': 'UTF-8 + BOM，meta 却声明 gb2312，响应头无 charset',
    },
    {
        'file': 'truncated-gb.html',
        'title': '户籍迁移存根',
        'name': '刘志强', 'date': '1971年3月25日', 'code': 'D-40109',
        'note': '迁出人口 2 人，理由属实',
        'archivist': '王档案馆',
        'true_encoding': 'gb18030', 'meta_charset': 'gb18030',
        'content_type': 'text/html; charset=gb18030',
        'tail': '卷宗完', 'truncate_last_bytes': 1,
        'description': 'GB18030，文件末尾多字节字符被截断 1 字节',
    },
    {
        'file': 'double-encoded.html',
        'title': '知青返城登记表',
        'name': '周文斌', 'date': '1978年12月30日', 'code': 'E-90013',
        'note': '返城 3 人，安置费 500 元',
        'archivist': '王档案馆',
        'true_encoding': 'utf-8', 'meta_charset': 'utf-8',
        'content_type': 'text/html; charset=utf-8',
        'double_encode': True,
        'description': 'UTF-8 文本曾被按 latin-1 误读再存为 UTF-8（重复转码乱码）',
    },
    {
        'file': 'gb18030-4byte.html',
        'title': '地名普查卡片',
        'name': '赵德柱', 'date': '1985年4月2日', 'code': 'F-55100',
        'note': '地名：𠮷家庄，海拔 612 米',
        'archivist': '王档案馆',
        'true_encoding': 'gb18030', 'meta_charset': 'gb2312',
        'content_type': 'text/html; charset=gb2312',
        'description': '声明 gb2312，实际含 GB18030 四字节字符（𠮷 U+20BB7）',
    },
]


def generate_samples(site_dir: str | Path) -> list[dict]:
    site_dir = Path(site_dir)
    site_dir.mkdir(parents=True, exist_ok=True)
    manifest = []
    for s in SAMPLES:
        html = _TEMPLATE.format(
            meta_charset=s['meta_charset'], title=s['title'], name=s['name'],
            date=s['date'], code=s['code'], note=s['note'],
            archivist=s['archivist'], tail=s.get('tail', ''))
        data = html.encode(s['true_encoding'])
        if s.get('double_encode'):
            # 模拟历史事故：UTF-8 字节被按 latin-1 解码后又存为 UTF-8
            data = html.encode('utf-8').decode('latin-1').encode('utf-8')
        if s.get('bom'):
            data = codecs.BOM_UTF8 + data
        if s.get('truncate_last_bytes'):
            data = data[:-s['truncate_last_bytes']]
        (site_dir / s['file']).write_bytes(data)
        manifest.append({
            'file': s['file'],
            'content_type': s['content_type'],
            'description': s['description'],
            'true_encoding': s['true_encoding'],
        })
    (site_dir / 'manifest.json').write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2), 'utf-8')
    return manifest
