"""采集：原始字节独立保存，附完整取证元数据，绝不修改内容。"""
from __future__ import annotations

import datetime
import hashlib
import json
import urllib.request
from pathlib import Path

USER_AGENT = 'encoding-vault/0.1 (evidence-preserving archiver)'


def fetch(url: str, data_dir: str | Path) -> str:
    """抓取 URL，原始字节写入 raw/<sha256>.bin，元数据写入 raw/<sha256>.json。

    返回内容的 sha256。同一内容重复抓取只追加抓取事件，不重写字节。
    """
    data_dir = Path(data_dir)
    req = urllib.request.Request(url, headers={'User-Agent': USER_AGENT})
    with urllib.request.urlopen(req) as resp:
        body = resp.read()
        headers = dict(resp.headers.items())
        status = resp.status

    sha = hashlib.sha256(body).hexdigest()
    raw_dir = data_dir / 'raw'
    raw_dir.mkdir(parents=True, exist_ok=True)

    bin_path = raw_dir / f'{sha}.bin'
    if not bin_path.exists():
        bin_path.write_bytes(body)  # 原始证据字节，之后任何环节只读
    elif bin_path.read_bytes() != body:
        raise RuntimeError(f'哈希冲突：{sha}')

    event = {
        'url': url,
        'fetched_at': datetime.datetime.now(datetime.timezone.utc).isoformat(),
        'http_status': status,
        'response_headers': headers,
    }
    meta_path = raw_dir / f'{sha}.json'
    if meta_path.exists():
        meta = json.loads(meta_path.read_text('utf-8'))
        meta['fetches'].append(event)
    else:
        meta = {'sha256': sha, 'size': len(body), 'fetches': [event]}
    meta_path.write_text(json.dumps(meta, ensure_ascii=False, indent=2), 'utf-8')
    return sha
