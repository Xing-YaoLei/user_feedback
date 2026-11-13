"""开发期辅助脚本：查看待处理失败清单与已发布的重复事件内容。"""

import json

print("=== pending_failures.jsonl ===")
with open("state/current/pending_failures.jsonl", encoding="utf-8") as fh:
    for line in fh:
        d = json.loads(line)
        print(
            d["idempotency_key"],
            "|", d["reason_code"],
            "| attempts:", d["attempts"],
            "|", d["position"],
        )

print()
print("=== 已发布的 T-1001（应为首次内容 rating=5）===")
with open("state/current/published.jsonl", encoding="utf-8") as fh:
    for line in fh:
        d = json.loads(line)
        if d["idempotency_key"] == "support::T-1001":
            rec = d["record"]
            print(
                "rating=", rec["rating"],
                "| content=", rec["content"],
                "| mapping=", d["mapping_version"],
                "| published_run=", d["published_run_id"],
            )
