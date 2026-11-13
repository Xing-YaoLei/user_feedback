"""开发期辅助脚本：查看一条订单记录的完整统一明细。"""

import json

with open("state/current/unified.jsonl", encoding="utf-8") as fh:
    for line in fh:
        d = json.loads(line)
        if d["_event_id"] == "OE-7001":
            print(json.dumps(d, ensure_ascii=False, indent=2, sort_keys=True))
            break
