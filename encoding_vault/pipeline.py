"""流水线：解码版本管理 + 结构化字段抽取与版本绑定。

每次解码产生一个新版本（v1, v2, ...），旧版本产物全部保留。
结构化记录绑定 decode_version；改编码重新解码后，本页记录全部重算，
旧版本记录快照保留在 records/history/ 供审计。
"""
from __future__ import annotations

import datetime
import json
import re
from pathlib import Path

from .decode import analyze
from .evidence import collect_evidence
from .report import render_report

# 下游结构化字段：中文、人名、数字的抽取必须基于解码文本，
# 任何清洗都不得无依据改写这些值（回归测试锁定）。
FIELD_PATTERNS = [
    ('title', re.compile(r'<title>(.*?)</title>', re.S)),
    ('姓名', re.compile(r'姓名[:：]\s*([^\s<，。]+)')),
    ('归档人', re.compile(r'归档人[:：]\s*([^\s<，。]+)')),
    ('日期', re.compile(r'\d{4}年\d{1,2}月\d{1,2}日')),
    ('编号', re.compile(r'编号[:：]\s*([A-Za-z0-9\-]+)')),
    ('数字', re.compile(r'(?<![\d.])\d+(?:\.\d+)?(?![\d.])')),
]


def page_id_for(meta: dict, sha: str) -> str:
    url = meta['fetches'][-1]['url']
    slug = url.rstrip('/').rsplit('/', 1)[-1] or 'index'
    return f'{slug}-{sha[:8]}'


def extract_records(text: str, page_id: str, version: str) -> list[dict]:
    records = []
    for field, pat in FIELD_PATTERNS:
        for m in pat.finditer(text):
            if m.groups():
                value, start = m.group(1), m.start(1)
            else:
                value, start = m.group(0), m.start()
            records.append({
                'page_id': page_id,
                'decode_version': version,
                'field': field,
                'value': value,
                'char_start': start,
                'char_end': start + len(value),
            })
    return records


def load_overrides(data_dir: Path) -> dict:
    p = data_dir / 'overrides.json'
    return json.loads(p.read_text('utf-8')) if p.exists() else {}


def set_override(data_dir: str | Path, sha: str, encoding: str) -> None:
    data_dir = Path(data_dir)
    overrides = load_overrides(data_dir)
    overrides[sha] = encoding
    (data_dir / 'overrides.json').write_text(
        json.dumps(overrides, ensure_ascii=False, indent=2), 'utf-8')


def decode_page(sha: str, data_dir: str | Path, override: str | None = None) -> dict:
    """解码一页并产出全部产物。override 为 None 时自动采用已登记的人工指定。"""
    data_dir = Path(data_dir)
    raw = (data_dir / 'raw' / f'{sha}.bin').read_bytes()
    meta = json.loads((data_dir / 'raw' / f'{sha}.json').read_text('utf-8'))
    headers = meta['fetches'][-1]['response_headers']

    if override is None:
        override = load_overrides(data_dir).get(sha)

    evidence = collect_evidence(headers, raw)
    result = analyze(raw, evidence, override=override)
    selected = result['selected']
    page_id = page_id_for(meta, sha)

    dec_dir = data_dir / 'decode' / sha
    dec_dir.mkdir(parents=True, exist_ok=True)
    existing = [p for p in dec_dir.glob('v*.json')
                if re.fullmatch(r'v\d+', p.stem)]
    version = f'v{len(existing) + 1}'

    (dec_dir / f'{version}.txt').write_text(selected['text'], 'utf-8')
    if selected['byte_map'] is not None:
        (dec_dir / f'{version}.map.json').write_text(
            json.dumps(selected['byte_map'], ensure_ascii=False, indent=1), 'utf-8')

    record = {
        'page_id': page_id,
        'raw_sha256': sha,
        'decode_version': version,
        'encoding': selected['name'],
        'encoding_source': selected['source'],
        'status': result['status'],
        'decode_policy': result['policy'],
        'override': override,
        'evidence': evidence,
        'candidates': result['candidates'],
        'replacements': selected['replacements'],
        'created_at': datetime.datetime.now(datetime.timezone.utc).isoformat(),
    }
    (dec_dir / f'{version}.json').write_text(
        json.dumps(record, ensure_ascii=False, indent=2), 'utf-8')

    # 结构化记录：绑定解码版本，本页全部重算；历史快照保留
    records = extract_records(selected['text'], page_id, version)
    rec_dir = data_dir / 'records'
    hist_dir = rec_dir / 'history'
    hist_dir.mkdir(parents=True, exist_ok=True)
    payload = ''.join(json.dumps(r, ensure_ascii=False) + '\n' for r in records)
    (rec_dir / f'{page_id}.jsonl').write_text(payload, 'utf-8')
    (hist_dir / f'{page_id}__{version}.jsonl').write_text(payload, 'utf-8')

    # 原始字节 ↔ 文本定位对照页面
    rep_dir = data_dir / 'report'
    rep_dir.mkdir(parents=True, exist_ok=True)
    html = render_report(record, meta, raw, selected)
    (rep_dir / f'{page_id}__{version}.html').write_text(html, 'utf-8')

    return record
