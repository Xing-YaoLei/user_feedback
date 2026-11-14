"""端到端流程：首次发布、规则变更预览、确认发布。

设计约束（见 README）：

* 预览期间不改动任何已发布结果；
* 确认只重算并替换预览清单中的日期，其余日期原样保留；
* 重算基于已存储的全部原始读数（累计增量需要跨日的上一条读数），
  但只写回受影响日期；
* 确认前复核原始读数与已发布账本的字节哈希，任何并发变化整次拒绝。
"""

from decimal import Decimal

from .csv_input import load_attribution, load_readings, load_tariff
from .engine import build_daily_ledgers, evaluate_readings, ledger_core
from .errors import LedgerError
from .jsonutil import content_hash
from .rules import (
    diff_rules,
    flatten_rules,
    hash_rules,
    prepare_rules,
    rule_from_json,
)
from .storage import Store, make_version, source_summary, write_json
from .timeutil import business_day, iso, parse_beijing


# ---------------------------------------------------------------- 读数序列化

def _raw_reading_for_json(item, mode):
    out = {
        "meter_id": item["meter_id"],
        "reading_time": iso(item["ts"]),
        "row_no": item["row_no"],
    }
    if mode == "cumulative":
        out["meter_reading"] = item["meter_reading"]
    else:
        out["consumption_kwh"] = item["consumption_kwh"]
    return out


def _raw_reading_from_json(data, mode):
    item = {
        "meter_id": data["meter_id"],
        "ts": parse_beijing(data["reading_time"]),
        "row_no": data["row_no"],
    }
    if mode == "cumulative":
        item["meter_reading"] = Decimal(str(data["meter_reading"]))
    else:
        item["consumption_kwh"] = Decimal(str(data["consumption_kwh"]))
    return item


def _rules_from_version(version_doc):
    attr = [rule_from_json(r) for r in version_doc["rules"]["attribution"]]
    tariff = [rule_from_json(r) for r in version_doc["rules"]["tariff"]]
    return attr, tariff


def _load_all_stored_readings(store):
    """读取全部业务日的原始读数，恢复为引擎输入形态。"""
    meta = store.meta()
    all_items, mode = [], None
    for day in meta["days"]:
        payload = store.load_readings_day(day)
        mode = payload["mode"]
        all_items.extend(_raw_reading_from_json(r, mode) for r in payload["readings"])
    if not all_items:
        raise LedgerError("账本中没有任何已存储的原始读数")
    return mode, all_items


def _ledger_with_rules(day, core, version_id, rules_hash, generated_at):
    return {
        "day": day,
        "rules_version": version_id,
        "rules_hash": rules_hash,
        "generated_at": generated_at,
        "summaries": core["summaries"],
        "readings": core["readings"],
        "exceptions": core["exceptions"],
        "reading_count": len(core["readings"]) + len(core["exceptions"]),
    }


# ---------------------------------------------------------------- 首次运行

def init_store(store_root, readings_path, attr_path, tariff_path, now):
    """读取三张表 → 生成规则版本 1 → 按业务日逐日发布。"""
    store = Store(store_root)
    mode, readings = load_readings(readings_path)
    attr_rules = prepare_rules(load_attribution(attr_path))
    tariff_rules = prepare_rules(load_tariff(tariff_path))

    summary = source_summary(readings_path, attr_path, tariff_path, mode, readings)
    store.init_empty(summary)

    version = make_version(1, attr_rules, tariff_rules, summary, "init")
    store.write_version(version)

    evaluated = evaluate_readings(mode, readings, flatten_rules(attr_rules, tariff_rules))
    ledgers = build_daily_ledgers(evaluated)

    # 原始读数按业务日落盘，作为后续预览/确认的比较基线
    by_day = {}
    for item in readings:
        day = business_day(item["ts"])
        by_day.setdefault(day, []).append(_raw_reading_for_json(item, mode))

    generated_at = iso(now)
    days = sorted(ledgers)
    for day in days:
        store.save_readings_day(day, {"day": day, "mode": mode, "readings": by_day[day]})
        core = ledger_core(ledgers[day])
        store.save_ledger_day(
            day,
            _ledger_with_rules(day, core, 1, version["content_hash"], generated_at),
        )

    meta = store.meta()
    meta["current_version"] = 1
    meta["version_seq"] = 1
    meta["days"] = days
    store.save_meta(meta)
    return store, version, ledgers


# ---------------------------------------------------------------- 影响分析

def _reading_key(rec):
    return rec["meter_id"], rec["reading_time"]


def _attr_resolution(rec):
    """归属的实际解析结果键：状态 + 车间 id/名称（正常时）。"""
    if rec.get("attribution_status") == "ok":
        return ("ok", rec.get("workshop_id"), rec.get("workshop_name"))
    return (rec.get("attribution_status"), None, None)


def _tariff_resolution(rec):
    """电价的实际解析结果键：状态 + 规则 id + 单价（正常时）。

    同一条电价规则只改价格时 rule_id 不变，必须把单价纳入比较，
    否则纯调价不会被识别为电价原因。
    """
    if rec.get("tariff_status") == "ok":
        return ("ok", rec.get("tariff_rule_id"), rec.get("price_per_kwh"))
    return (rec.get("tariff_status"), None, None)


def _reasons(old_rec, new_rec):
    """判断一条读数的变化来自归属还是电价。

    语义对齐 README：原因反映**实际解析结果**，而不是规则文本本身——
    仅收紧区间终点这类不改变区间内命中结果的修改，不会给区间内读数打标。

    * 归属原因：归属解析结果变化（车间 id/名称变化，或一边正常、一边归属异常）；
    * 电价原因：两个版本归属解析一致且都正常时，电价解析结果变化
      （调价、换规则、从电价异常恢复、或新出现电价异常）。归属修复带来的
      电价命中变化属于归属原因，不算连锁的电价原因。

    输入类异常（首条无基线、回退、负增量、重复时刻）在两个版本下都不参与
    规则解析，不产生任何原因。
    """
    input_codes = {
        "first_reading_no_previous",
        "reading_rollback",
        "negative_increment",
        "duplicate_reading",
    }
    if (
        old_rec.get("exception", {}).get("code") in input_codes
        or new_rec.get("exception", {}).get("code") in input_codes
    ):
        return []

    reasons = []
    if _attr_resolution(old_rec) != _attr_resolution(new_rec):
        reasons.append("attribution")

    # 只有归属解析一致且都正常时，电价变化才单独归因；否则归到归属原因
    both_attr_ok = (
        old_rec.get("attribution_status") == "ok"
        and new_rec.get("attribution_status") == "ok"
    )
    if (
        both_attr_ok
        and _attr_resolution(old_rec) == _attr_resolution(new_rec)
        and _tariff_resolution(old_rec) != _tariff_resolution(new_rec)
    ):
        reasons.append("tariff")
    return reasons


_REASON_LABEL = {"attribution": "电表归属", "tariff": "电价"}


def _day_meter_slice(records):
    """某电表某日一批读数的 before/after 汇总切片。"""
    ok = [r for r in records if r["status"] == "ok"]
    workshops = sorted({r["workshop_id"] for r in ok})
    return {
        "workshops": workshops,
        "ok_count": len(ok),
        "exception_count": len(records) - len(ok),
        "total_kwh": sum((r["consumption_kwh"] for r in ok), Decimal("0")),
        "total_cost": sum((r["cost"] for r in ok), Decimal("0")),
    }


def _exception_changes(old_evaled, new_evaled):
    old_map = {_reading_key(r): r for r in old_evaled if r["status"] == "exception"}
    new_map = {_reading_key(r): r for r in new_evaled if r["status"] == "exception"}
    added, recovered, changed = [], [], []
    for key in sorted(set(new_map) - set(old_map)):
        added.append(_exception_brief(new_map[key], None))
    for key in sorted(set(old_map) - set(new_map)):
        recovered.append(_exception_brief(new_map.get(key), old_map[key]))
    for key in sorted(set(old_map) & set(new_map)):
        old_code = old_map[key]["exception"]["code"]
        new_code = new_map[key]["exception"]["code"]
        if old_code != new_code:
            changed.append(_exception_brief(new_map[key], old_map[key]))
    return {"added": added, "recovered": recovered, "changed": changed}


def _exception_brief(new_rec, old_rec):
    ref = new_rec or old_rec
    out = {
        "meter_id": ref["meter_id"],
        "reading_time": ref["reading_time"],
        "day": ref["day"],
    }
    if old_rec is not None:
        out["before_code"] = old_rec["exception"]["code"]
        out["before_message"] = old_rec["exception"]["message"]
    if new_rec is not None:
        out["after_code"] = new_rec["exception"]["code"]
        out["after_message"] = new_rec["exception"]["message"]
    return out


def analyze_impact(old_evaled, new_evaled, old_ledgers, new_ledgers):
    """对比两个版本下的评估结果，生成影响清单、逐日变化与异常变化。"""
    if len(old_evaled) != len(new_evaled):
        raise LedgerError("内部错误：两个版本评估的读数数量不一致")
    pairs = []
    for old_rec, new_rec in zip(old_evaled, new_evaled):
        if _reading_key(old_rec) != _reading_key(new_rec):
            raise LedgerError("内部错误：两个版本的读数顺序不一致，无法对比")
        pairs.append((old_rec, new_rec))

    # ---- 逐条读数定位受影响日期与原因 --------------------------------
    affected_days = set()
    meter_days = {}  # meter -> day -> {"reasons": set, "old": [...], "new": [...]}
    for old_rec, new_rec in pairs:
        day = new_rec["day"]
        if _reading_core(old_rec) != _reading_core(new_rec):
            affected_days.add(day)
        reasons = _reasons(old_rec, new_rec)
        if reasons:
            slot = meter_days.setdefault(new_rec["meter_id"], {}).setdefault(
                day, {"reasons": set(), "old": [], "new": []}
            )
            slot["reasons"].update(reasons)
            slot["old"].append(old_rec)
            slot["new"].append(new_rec)

    impact = []
    for meter_id in sorted(meter_days):
        day_slots = meter_days[meter_id]
        day_entries = []
        all_reasons = set()
        for day in sorted(day_slots):
            slot = day_slots[day]
            all_reasons.update(slot["reasons"])
            day_entries.append(
                {
                    "day": day,
                    "reasons": sorted(slot["reasons"]),
                    "reason_labels": [_REASON_LABEL[r] for r in sorted(slot["reasons"])],
                    "before": _day_meter_slice(slot["old"]),
                    "after": _day_meter_slice(slot["new"]),
                }
            )
        impact.append(
            {
                "meter_id": meter_id,
                "first_affected_day": min(day_slots),
                "reasons": sorted(all_reasons),
                "reason_labels": [_REASON_LABEL[r] for r in sorted(all_reasons)],
                "days": day_entries,
            }
        )

    # ---- 逐日车间汇总变化 ---------------------------------------------
    all_days = sorted(set(old_ledgers) | set(new_ledgers))
    daily_changes, unchanged_days = [], []
    after_core_hashes = {}
    for day in all_days:
        old_core = ledger_core(old_ledgers[day])
        new_core = ledger_core(new_ledgers[day])
        if old_core == new_core:
            unchanged_days.append(day)
            continue
        daily_changes.append(
            {
                "day": day,
                "before_summaries": old_core["summaries"],
                "after_summaries": new_core["summaries"],
            }
        )
        after_core_hashes[day] = content_hash(new_core)

    return {
        "affected_days": sorted(affected_days),
        "unchanged_days": unchanged_days,
        "impact": impact,
        "daily_changes": daily_changes,
        "exception_changes": _exception_changes(old_evaled, new_evaled),
        "after_core_hashes": after_core_hashes,
    }


def _reading_core(rec):
    """单条读数受规则影响的可比内容。"""
    keys = (
        "status",
        "workshop_id",
        "workshop_name",
        "tariff_rule_id",
        "price_per_kwh",
        "consumption_kwh",
        "cost",
        "exception",
    )
    return {k: rec.get(k) for k in keys}


# ---------------------------------------------------------------- 预览

def preview_changes(store_root, attr_path, tariff_path, now):
    """加载新版规则并生成预览；不触碰 ledger/ 下任何已发布结果。"""
    store = Store(store_root)
    store.require_exists()
    meta = store.meta()
    base_version_id = meta["current_version"]
    if base_version_id is None:
        raise LedgerError("账本还没有已发布的规则版本，无法预览变更")
    base_version = store.load_version(base_version_id)
    old_attr, old_tariff = _rules_from_version(base_version)

    new_attr = prepare_rules(load_attribution(attr_path))
    new_tariff = prepare_rules(load_tariff(tariff_path))
    new_hash = hash_rules(new_attr, new_tariff)
    if new_hash == base_version["content_hash"]:
        raise LedgerError("新版规则与当前版本内容完全相同，没有可预览的变化")

    rule_diff = diff_rules(
        flatten_rules(old_attr, old_tariff), flatten_rules(new_attr, new_tariff)
    )

    mode, readings = _load_all_stored_readings(store)
    old_evaled = evaluate_readings(mode, readings, flatten_rules(old_attr, old_tariff))
    new_evaled = evaluate_readings(mode, readings, flatten_rules(new_attr, new_tariff))
    old_ledgers = build_daily_ledgers(old_evaled)
    new_ledgers = build_daily_ledgers(new_evaled)

    analysis = analyze_impact(old_evaled, new_evaled, old_ledgers, new_ledgers)

    candidate_seq = meta["version_seq"] + 1
    candidate_summary = dict(meta["source_summary"])
    candidate_summary.update(
        {
            "attribution_csv": str(attr_path),
            "tariff_csv": str(tariff_path),
        }
    )
    candidate = make_version(
        candidate_seq, new_attr, new_tariff, candidate_summary, "preview"
    )
    store.write_version(candidate)  # 版本一旦生成即不可变

    preview_id = meta["preview_seq"] + 1
    baseline_hashes = {day: store.hash_day_inputs(day) for day in analysis["affected_days"]}
    preview = {
        "preview_id": preview_id,
        "status": "pending",
        "created_at": iso(now),
        "base_version": base_version_id,
        "candidate_version": candidate_seq,
        "candidate_version_hash": new_hash,
        "rule_diff": rule_diff,
        "affected_days": analysis["affected_days"],
        "unchanged_days": analysis["unchanged_days"],
        "impact": analysis["impact"],
        "daily_changes": analysis["daily_changes"],
        "exception_changes": analysis["exception_changes"],
        "after_core_hashes": analysis["after_core_hashes"],
        "baseline_hashes": baseline_hashes,
    }
    store.write_preview(preview)
    meta["preview_seq"] = preview_id
    meta["version_seq"] = candidate_seq
    store.save_meta(meta)
    return store, preview


# ---------------------------------------------------------------- 确认

def confirm_preview(store_root, preview_id, now):
    """确认预览：校验通过后只替换受影响日期的已发布结果。"""
    store = Store(store_root)
    store.require_exists()
    meta = store.meta()
    preview = store.load_preview(preview_id)

    # ---- 1. 状态与基线校验（全部通过前不写任何业务文件） --------------
    if preview["status"] == "confirmed":
        raise LedgerError(f"预览 {preview_id} 已确认过，同一预览不能重复确认")
    if preview["status"] == "rejected":
        raise LedgerError(f"预览 {preview_id} 已被拒绝: {preview.get('reject_reason', '')}")
    if meta["current_version"] != preview["base_version"]:
        _reject(
            store,
            preview,
            f"当前规则版本已变为 {meta['current_version']}，"
            f"预览基于版本 {preview['base_version']}，请重新生成预览",
        )
    if meta["current_version"] is None:
        raise LedgerError("账本还没有已发布的规则版本")

    mismatches = store.verify_day_hashes(
        preview["affected_days"], preview["baseline_hashes"]
    )
    if mismatches:
        _reject(store, preview, f"预览后底层数据发生变化: {mismatches}")

    candidate = store.load_version(preview["candidate_version"])
    if candidate["content_hash"] != preview["candidate_version_hash"]:
        _reject(store, preview, "候选规则版本的内容哈希与预览记录不一致")
    new_attr, new_tariff = _rules_from_version(candidate)

    # ---- 2. 用已存储的全部原始读数重算 --------------------------------
    mode, readings = _load_all_stored_readings(store)
    evaled = evaluate_readings(mode, readings, flatten_rules(new_attr, new_tariff))
    ledgers = build_daily_ledgers(evaled)

    for day in preview["affected_days"]:
        if day not in ledgers:
            _reject(store, preview, f"重算结果缺少受影响日期 {day}")
        recomputed_hash = content_hash(ledger_core(ledgers[day]))
        if recomputed_hash != preview["after_core_hashes"].get(day):
            _reject(
                store,
                preview,
                f"日期 {day} 的重算结果与预览不一致，可能是原始读数已变化",
            )

    # ---- 3. 校验通过，只写受影响日期 ----------------------------------
    generated_at = iso(now)
    for day in preview["affected_days"]:
        core = ledger_core(ledgers[day])
        store.save_ledger_day(
            day,
            _ledger_with_rules(
                day, core, candidate["version"], candidate["content_hash"], generated_at
            ),
        )

    preview["status"] = "confirmed"
    preview["confirmed_at"] = generated_at
    store.write_preview(preview)

    meta["current_version"] = candidate["version"]
    store.save_meta(meta)
    return preview


def _reject(store, preview, reason):
    """把预览标记为 rejected 并抛出错误（预览文件不属于已发布结果）。"""
    preview["status"] = "rejected"
    preview["reject_reason"] = reason
    write_json(store.preview_path(preview["preview_id"]), preview)
    raise LedgerError(f"确认被拒绝：{reason}")
