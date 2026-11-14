"""规则集：区间匹配、rule_id 生成与版本间差异。

匹配区间统一为 ``[valid_from, valid_to)``：含起点、不含终点；
``valid_to`` 为空表示长期有效。
"""

from .errors import LedgerError
from .jsonutil import canonical_bytes, content_hash
from .timeutil import iso

# 排序键：valid_from 在前、rule_id 在后，保证「匹配多条」时列出顺序稳定
_HIT_SORT = ("valid_from", "rule_id")


def rule_for_json(rule):
    """把规则转成可落盘的纯 JSON 形态（datetime 转 ISO 字符串）。"""
    out = dict(rule)
    out["valid_from"] = iso(rule["valid_from"])
    out["valid_to"] = iso(rule["valid_to"]) if rule["valid_to"] is not None else None
    return out


def rule_from_json(data):
    """落盘规则转回内存形态（ISO 字符串转带时区 datetime）。"""
    from .timeutil import parse_beijing

    out = dict(data)
    out["valid_from"] = parse_beijing(data["valid_from"])
    out["valid_to"] = parse_beijing(data["valid_to"]) if data["valid_to"] else None
    from decimal import Decimal

    if "price_per_kwh" in out:
        out["price_per_kwh"] = Decimal(str(data["price_per_kwh"]))
    return out


def _generated_id(rule):
    """rule_id 缺省时按规则内容生成稳定 ID。"""
    import hashlib

    payload = rule_for_json(rule)
    payload.pop("rule_id", None)
    digest = hashlib.sha256(canonical_bytes(payload)).hexdigest()[:12]
    prefix = "A" if rule["kind"] == "attribution" else "T"
    return f"{prefix}-auto-{digest}"


def prepare_rules(rules):
    """填充缺省 rule_id，并校验显式 rule_id 在各自表内唯一。"""
    seen = set()
    prepared = []
    for rule in rules:
        out = dict(rule)
        rid = out["rule_id"] or _generated_id(out)
        if rid in seen:
            kind = "归属" if out["kind"] == "attribution" else "电价"
            raise LedgerError(f"{kind}表中 rule_id 重复: {rid}")
        seen.add(rid)
        out["rule_id"] = rid
        prepared.append(out)
    return prepared


def _in_window(rule, ts):
    if ts < rule["valid_from"]:
        return False
    if rule["valid_to"] is not None and ts >= rule["valid_to"]:
        return False
    return True


def match_attribution(rules, meter_id, ts):
    """返回 ``(status, hits)``；status 为 ok / no_attribution / multiple_attribution。"""
    hits = [
        r
        for r in rules
        if r["kind"] == "attribution" and r["meter_id"] == meter_id and _in_window(r, ts)
    ]
    hits.sort(key=lambda r: (r["valid_from"], r["rule_id"]))
    if not hits:
        return "no_attribution", hits
    if len(hits) > 1:
        return "multiple_attribution", hits
    return "ok", hits


def match_tariff(rules, workshop_id, ts):
    """返回 ``(status, hits)``；空 workshop_id 的电价对所有车间生效。"""
    hits = [
        r
        for r in rules
        if r["kind"] == "tariff"
        and (not r["workshop_id"] or r["workshop_id"] == workshop_id)
        and _in_window(r, ts)
    ]
    hits.sort(key=lambda r: (r["valid_from"], r["rule_id"]))
    if not hits:
        return "no_tariff", hits
    if len(hits) > 1:
        return "multiple_tariff", hits
    return "ok", hits


def _rule_identity(rule):
    """版本间识别同一条规则用的键：显式/生成后的 rule_id + 类型。"""
    return (rule["kind"], rule["rule_id"])


def _rule_body(rule):
    """差异比较用的规则内容（不含可变 rule_id 本身）。"""
    body = rule_for_json(rule)
    body.pop("rule_id", None)
    return body


def diff_rules(old_rules, new_rules):
    """对比两个规则集，返回 added / removed / changed 三个列表。

    changed 元素形如 ``{"rule_id", "kind", "before": {...}, "after": {...},
    "fields": {字段: (旧值, 新值)}}``，仅列出真正变化的字段。
    """
    old_map = {_rule_identity(r): r for r in old_rules}
    new_map = {_rule_identity(r): r for r in new_rules}

    added, removed, changed = [], [], []
    for key, rule in sorted(new_map.items()):
        if key not in old_map:
            added.append(rule_for_json(rule))
    for key, rule in sorted(old_map.items()):
        if key not in new_map:
            removed.append(rule_for_json(rule))
    for key in sorted(set(old_map) & set(new_map)):
        before_body = _rule_body(old_map[key])
        after_body = _rule_body(new_map[key])
        if before_body == after_body:
            continue
        fields = {}
        for field in sorted(set(before_body) | set(after_body)):
            if before_body.get(field) != after_body.get(field):
                fields[field] = [before_body.get(field), after_body.get(field)]
        changed.append(
            {
                "rule_id": key[1],
                "kind": key[0],
                "before": before_body,
                "after": after_body,
                "fields": fields,
            }
        )
    return {"added": added, "removed": removed, "changed": changed}


def rules_payload(attr_rules, tariff_rules):
    """版本落盘用的规则快照。"""
    return {
        "attribution": [rule_for_json(r) for r in attr_rules],
        "tariff": [rule_for_json(r) for r in tariff_rules],
    }


def hash_rules(attr_rules, tariff_rules):
    return content_hash(rules_payload(attr_rules, tariff_rules))


def flatten_rules(attr_rules, tariff_rules):
    """合并为一个列表，供匹配函数使用。"""
    return list(attr_rules) + list(tariff_rules)
