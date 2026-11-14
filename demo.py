"""Generate a small, self-contained demo dataset for the sampling tool.

Usage::

    python3 demo.py /tmp/audit-demo

Writes ``quota.json``, ``reviewed.json`` and two gzip JSONL branch files.
"""

from __future__ import annotations

import gzip
import json
import os
import random
import sys

QUOTA = {
    "zh": {"low": 6, "high": 4},
    "en": {"low": 3, "high": 2},
    "ja": {"low": 2, "high": 1},
}


def main(out_dir: str) -> int:
    rng = random.Random(20261114)
    os.makedirs(out_dir, exist_ok=True)

    records = []
    for index in range(400):
        records.append(
            {
                "page_id": f"NLC-2026-{index:04d}",
                "language": rng.choice(["zh", "zh", "en", "ja"]),
                # Deliberately straddle the 0.8 threshold.
                "confidence": round(rng.choice([0.62, 0.74, 0.79, 0.8, 0.88, 0.97]), 3),
            }
        )

    reviewed = sorted(record["page_id"] for record in records[::9])
    for name, payload in (("quota.json", QUOTA), ("reviewed.json", reviewed)):
        with open(os.path.join(out_dir, name), "w", encoding="utf-8") as handle:
            json.dump(payload, handle, indent=2)
            handle.write("\n")

    midpoint = len(records) // 2
    branches = (
        ("branch-a", records[:midpoint]),
        ("branch-b", records[midpoint:]),
    )
    for branch, chunk in branches:
        path = os.path.join(out_dir, f"{branch}.jsonl.gz")
        with gzip.open(path, "wt", encoding="utf-8") as handle:
            for record in chunk:
                handle.write(json.dumps(record) + "\n")

    print(f"demo data written to {out_dir}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1] if len(sys.argv) > 1 else "/tmp/audit-demo"))
