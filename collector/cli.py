# -*- coding: utf-8 -*-
"""采集器命令行入口。

用法：
    python -m collector.cli --config queries.json --evidence-dir ./out
查询配置文件为 JSON：{"queries": [ {QueryConfig 字段...}, ... ]}
"""

import argparse
import json
import os

from .config import QueryConfig
from .engine import CollectionEngine


def main(argv=None):
    parser = argparse.ArgumentParser(description="传统表单站点采集器")
    parser.add_argument("--config", required=True, help="查询配置 JSON 文件")
    parser.add_argument("--evidence-dir", default="./out", help="证据与结果输出目录")
    parser.add_argument("--workers", type=int, default=4)
    parser.add_argument("--timeout", type=float, default=15.0)
    args = parser.parse_args(argv)

    configs = QueryConfig.load_many(args.config)
    engine = CollectionEngine(evidence_dir=args.evidence_dir, timeout=args.timeout)
    results = engine.run_many(configs, max_workers=args.workers)

    os.makedirs(args.evidence_dir, exist_ok=True)
    result_path = os.path.join(args.evidence_dir, "results.json")
    with open(result_path, "w", encoding="utf-8") as fh:
        json.dump(results, fh, ensure_ascii=False, indent=2)

    for result in results:
        flag = "OK " if result["status"] == "ok" else "ERR"
        extra = (f"{result['row_count']} 行, 页序 {result['page_seq']}, "
                 f"恢复 {result['recoveries']} 次"
                 if result["status"] == "ok" else result["error"])
        print(f"[{flag}] {result['query']}: {extra}")
    print(f"\n结构化结果：{result_path}")
    print(f"关联证据：{os.path.join(args.evidence_dir, 'evidence.jsonl')}")
    return 0 if all(r["status"] == "ok" for r in results) else 1


if __name__ == "__main__":
    raise SystemExit(main())
