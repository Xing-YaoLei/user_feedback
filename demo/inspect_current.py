"""开发期辅助脚本：查看 current run 的统一明细与失败记录。"""

import json
import os

base = "state/current"

print("=== unified.jsonl（本批新发布的统一明细）===")
with open(os.path.join(base, "unified.jsonl"), encoding="utf-8") as fh:
    for line in fh:
        d = json.loads(line)
        print(
            d["_source"], d["_version"], d["_event_id"],
            "|", d["event_type"],
            "| rating=", repr(d["rating"]),
            "| content=", repr(d["content"])[:40],
            "|", d["_mapping_version"],
        )

print()
print("=== failures.jsonl（本批失败记录）===")
with open(os.path.join(base, "failures.jsonl"), encoding="utf-8") as fh:
    for line in fh:
        d = json.loads(line)
        print(
            d["source"], d["version"], d["event_id"],
            "|", d["reason_code"],
            "|", d["reason"],
            "|", d["position"],
        )

print()
print("=== pending_failures.jsonl 幂等键 ===")
with open(
    os.path.join(base, "pending_failures.jsonl"), encoding="utf-8"
) as fh:
    for line in fh:
        d = json.loads(line)
        print(" ", d["idempotency_key"], "attempts=", d["attempts"])
