"""计算引擎：增量计算、逐条读数匹配、异常清单、业务日车间汇总。

每条读数只在其**发生时刻**取一次归属与电价。输入类异常
（首条累计读数、累计回退、负增量、重复时刻）与规则类异常
（匹配 0 条 / 多条）都进异常清单，不混入车间汇总。
"""

from decimal import Decimal

from .jsonutil import Q6
from .rules import match_attribution, match_tariff, rule_for_json
from .timeutil import business_day, iso

ZERO = Decimal("0")


def _money(amount):
    """金额、电量统一量化到 6 位小数，去掉多余的零。"""
    return amount.quantize(Q6)


def evaluate_readings(mode, readings, all_rules):
    """对全部读数做增量计算与规则匹配。

    返回带评估结果的读数列表（顺序与输入一致），每条包含：
    原始字段、``day``、``consumption_kwh``、``status``、匹配命中、
    归属/电价/费用或 ``exception`` 描述。
    """
    # 累计模式需要按表计时间序维护上一条有效读数
    sorted_index = sorted(range(len(readings)), key=lambda i: (readings[i]["meter_id"], readings[i]["ts"]))
    last_value = {}  # meter_id -> 上一条有效累计读数

    evaluated = [None] * len(readings)
    for idx in sorted_index:
        item = readings[idx]
        meter_id = item["meter_id"]
        ts = item["ts"]
        rec = {
            "meter_id": meter_id,
            "reading_time": iso(ts),
            "day": business_day(ts),
            "row_no": item["row_no"],
        }
        if "meter_reading" in item:
            rec["meter_reading"] = item["meter_reading"]
        if "consumption_kwh" in item:
            rec["input_consumption_kwh"] = item["consumption_kwh"]

        # ---- 1. 增量 ----------------------------------------------------
        input_error = None
        if mode == "incremental":
            delta = item["consumption_kwh"]
            if delta < 0:
                input_error = "negative_increment"
        else:
            value = item["meter_reading"]
            if meter_id not in last_value:
                input_error = "first_reading_no_previous"
                delta = None
                # 首条读数本身无法算增量，但它是后续读数的基线
                last_value[meter_id] = value
            else:
                previous = last_value[meter_id]
                delta = value - previous
                if delta < 0:
                    input_error = "reading_rollback"
                    delta = None
            # 回退不推进基线；正常读数（含 delta=0）才推进
            if input_error is None:
                last_value[meter_id] = value

        if input_error is None:
            rec["consumption_kwh"] = _money(delta)

        # ---- 2. 规则匹配（输入异常时不参与，但仍给出 day） --------------
        if input_error is not None:
            rec["status"] = "exception"
            rec["exception"] = {
                "code": input_error,
                "message": _EXCEPTION_MESSAGES[input_error],
            }
            evaluated[idx] = rec
            continue

        attr_status, attr_hits = match_attribution(all_rules, meter_id, ts)
        rec["attribution_status"] = attr_status
        rec["attribution_hits"] = [h["rule_id"] for h in attr_hits]

        if attr_status != "ok":
            rec["status"] = "exception"
            rec["exception"] = {
                "code": attr_status,
                "message": _EXCEPTION_MESSAGES[attr_status],
                "matched_rules": [rule_for_json(h) for h in attr_hits],
            }
            evaluated[idx] = rec
            continue

        attr = attr_hits[0]
        rec["workshop_id"] = attr["workshop_id"]
        rec["workshop_name"] = attr["workshop_name"]

        tariff_status, tariff_hits = match_tariff(all_rules, attr["workshop_id"], ts)
        rec["tariff_status"] = tariff_status
        rec["tariff_hits"] = [h["rule_id"] for h in tariff_hits]

        if tariff_status != "ok":
            rec["status"] = "exception"
            rec["exception"] = {
                "code": tariff_status,
                "message": _EXCEPTION_MESSAGES[tariff_status],
                "matched_rules": [rule_for_json(h) for h in tariff_hits],
            }
            evaluated[idx] = rec
            continue

        tariff = tariff_hits[0]
        price = tariff["price_per_kwh"]
        rec["tariff_rule_id"] = tariff["rule_id"]
        rec["price_per_kwh"] = _money(price)
        rec["cost"] = _money(rec["consumption_kwh"] * price)
        rec["status"] = "ok"
        evaluated[idx] = rec

    return evaluated


_EXCEPTION_MESSAGES = {
    "first_reading_no_previous": "该表计的首条累计读数，缺少上一条读数，无法计算增量",
    "reading_rollback": "累计读数小于上一条读数（读数回退），增量无法计算",
    "negative_increment": "增量读数为负数",
    "duplicate_reading": "同一表计同一时刻出现两条读数",
    "no_attribution": "发生时刻未匹配到任何电表归属规则",
    "multiple_attribution": "发生时刻匹配到多条电表归属规则",
    "no_tariff": "发生时刻未匹配到任何电价规则",
    "multiple_tariff": "发生时刻匹配到多条电价规则",
}


def _public_reading(rec):
    """对外输出的读数记录（当前结构已无内部字段，保留函数以隔离未来调整）。"""
    return dict(rec)


def build_daily_ledgers(evaluated):
    """把评估结果按北京业务日分组，生成每日账本。"""
    days = {}
    for rec in evaluated:
        day = rec["day"]
        bucket = days.setdefault(
            day,
            {"summaries": {}, "readings": [], "exceptions": []},
        )
        if rec["status"] == "ok":
            bucket["readings"].append(_public_reading(rec))
            summary = bucket["summaries"].setdefault(
                rec["workshop_id"],
                {
                    "workshop_id": rec["workshop_id"],
                    "workshop_name": rec["workshop_name"],
                    "total_kwh": ZERO,
                    "total_cost": ZERO,
                    "reading_count": 0,
                },
            )
            # 同名车间的名称以最新命中的归属规则为准（一般保持一致）
            summary["workshop_name"] = rec["workshop_name"]
            summary["total_kwh"] += rec["consumption_kwh"]
            summary["total_cost"] += rec["cost"]
            summary["reading_count"] += 1
        else:
            bucket["exceptions"].append(_public_reading(rec))

    ledgers = {}
    for day, bucket in sorted(days.items()):
        summaries = []
        for workshop_id in sorted(bucket["summaries"]):
            s = bucket["summaries"][workshop_id]
            summaries.append(
                {
                    "workshop_id": workshop_id,
                    "workshop_name": s["workshop_name"],
                    "total_kwh": _money(s["total_kwh"]),
                    "total_cost": _money(s["total_cost"]),
                    "reading_count": s["reading_count"],
                }
            )
        readings = sorted(bucket["readings"], key=lambda r: (r["meter_id"], r["reading_time"]))
        exceptions = sorted(
            bucket["exceptions"], key=lambda r: (r["meter_id"], r["reading_time"])
        )
        ledgers[day] = {
            "day": day,
            "summaries": summaries,
            "readings": readings,
            "exceptions": exceptions,
            "reading_count": len(readings) + len(exceptions),
        }
    return ledgers


def ledger_core(ledger):
    """账本中受规则影响的可比部分（汇总 + 逐条匹配结果 + 异常）。"""
    return {
        "summaries": ledger["summaries"],
        "readings": ledger["readings"],
        "exceptions": ledger["exceptions"],
    }
