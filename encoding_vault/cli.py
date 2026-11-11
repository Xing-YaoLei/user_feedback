"""命令行入口。

用法示例：
  python -m encoding_vault.cli gen-samples --out samplesite
  python -m encoding_vault.cli serve --site samplesite --port 8765
  python -m encoding_vault.cli fetch http://127.0.0.1:8765/ok-utf8.html --data data
  python -m encoding_vault.cli decode <sha256> --data data
  python -m encoding_vault.cli override <sha256> gb18030 --data data
  python -m encoding_vault.cli demo
"""
from __future__ import annotations

import argparse
import json
import threading
from pathlib import Path

from . import acquire, pipeline, samples, server as server_mod


def _print_record(rec: dict) -> None:
    print(f"  {rec['page_id']}  {rec['decode_version']}  "
          f"编码={rec['encoding']}  来源={rec['encoding_source']}  "
          f"状态={rec['status']}  不可逆替换={len(rec['replacements'])}")
    if rec['status'] != 'ok':
        print(f"    ⚠ 需要人工复核：可用 "
              f"`python -m encoding_vault.cli override {rec['raw_sha256'][:12]}… <编码>` "
              f"指定编码重新解析")


def cmd_gen_samples(args):
    manifest = samples.generate_samples(args.out)
    print(f'已生成 {len(manifest)} 个样本到 {args.out}/')
    for e in manifest:
        print(f"  {e['file']}: {e['description']}")


def cmd_serve(args):
    server_mod.serve(args.site, args.port)


def cmd_fetch(args):
    sha = acquire.fetch(args.url, args.data)
    print(f'已保存原始字节 raw/{sha}.bin（sha256={sha[:16]}…）')


def cmd_decode(args):
    rec = pipeline.decode_page(args.sha, args.data, override=args.encoding)
    _print_record(rec)


def cmd_override(args):
    pipeline.set_override(args.data, args.sha, args.encoding)
    rec = pipeline.decode_page(args.sha, args.data, override=args.encoding)
    print(f'已登记人工指定编码 {args.encoding}，重新解析产生新版本：')
    _print_record(rec)


def cmd_demo(args):
    site_dir = Path(args.site)
    data_dir = Path(args.data)
    samples.generate_samples(site_dir)
    srv = server_mod.make_server(site_dir, 0)
    port = srv.server_address[1]
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    print(f'样本站：http://127.0.0.1:{port}/\n')

    manifest = json.loads((site_dir / 'manifest.json').read_text('utf-8'))
    try:
        for entry in manifest:
            url = f"http://127.0.0.1:{port}/{entry['file']}"
            sha = acquire.fetch(url, data_dir)
            rec = pipeline.decode_page(sha, data_dir)
            _print_record(rec)
    finally:
        srv.shutdown()
    print(f'\n对照报告见 {data_dir}/report/，结构化记录见 {data_dir}/records/')


def main(argv=None):
    ap = argparse.ArgumentParser(prog='encoding_vault',
                                 description='证据保留式网页采集与解码')
    sub = ap.add_subparsers(dest='cmd', required=True)

    p = sub.add_parser('gen-samples', help='生成本地测试站样本')
    p.add_argument('--out', default='samplesite')
    p.set_defaults(fn=cmd_gen_samples)

    p = sub.add_parser('serve', help='启动本地测试站')
    p.add_argument('--site', default='samplesite')
    p.add_argument('--port', type=int, default=8765)
    p.set_defaults(fn=cmd_serve)

    p = sub.add_parser('fetch', help='采集 URL，原始字节独立保存')
    p.add_argument('url')
    p.add_argument('--data', default='data')
    p.set_defaults(fn=cmd_fetch)

    p = sub.add_parser('decode', help='解码已采集页面（产生新版本）')
    p.add_argument('sha')
    p.add_argument('--data', default='data')
    p.add_argument('--encoding', help='人工指定编码重新解析')
    p.set_defaults(fn=cmd_decode)

    p = sub.add_parser('override', help='登记人工指定编码并重新解析')
    p.add_argument('sha')
    p.add_argument('encoding')
    p.add_argument('--data', default='data')
    p.set_defaults(fn=cmd_override)

    p = sub.add_parser('demo', help='端到端演示：生成样本→起站→采集→解码')
    p.add_argument('--site', default='samplesite')
    p.add_argument('--data', default='data')
    p.set_defaults(fn=cmd_demo)

    args = ap.parse_args(argv)
    args.fn(args)


if __name__ == '__main__':
    main()
