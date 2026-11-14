"""命令行入口：init / preview / confirm / show / versions / previews。"""

import argparse
import json
import sys
from datetime import datetime, timezone, timedelta

from .errors import LedgerError
from .jsonutil import LedgerEncoder
from .pipeline import confirm_preview, init_store, preview_changes
from .storage import Store
from .timeutil import BEIJING

_REASON_LABEL = {"attribution": "电表归属", "tariff": "电价"}


def _now():
    return datetime.now(tz=timezone.utc).astimezone(BEIJING)


def _print_json(obj):
    print(json.dumps(obj, indent=2, ensure_ascii=False, cls=LedgerEncoder))


# ---------------------------------------------------------------- 输出渲染

def _fmt_decimal(value):
    """去掉量化产生的尾零：100.000000 → 100，98.400000 → 98.4。"""
    if value is None:
        return "-"
    from decimal import Decimal

    if not isinstance(value, Decimal):
        value = Decimal(str(value))
    text = format(value.normalize(), "f")
    return text if "." not in text or text[-1] != "0" else text.rstrip("0").rstrip(".")


def _render_init(ledgers, version):
    print(f"已发布规则版本 {version['version']}（{version['content_hash'][:19]}…）")
    for day in sorted(ledgers):
        ledger = ledgers[day]
        print(
            f"  业务日 {day}: 读数 {ledger['reading_count']} 条，"
            f"正常 {len(ledger['readings'])} 条，异常 {len(ledger['exceptions'])} 条"
        )
        for s in ledger["summaries"]:
            print(
                f"    {s['workshop_id']} {s['workshop_name']}: "
                f"{_fmt_decimal(s['total_kwh'])} kWh / "
                f"{_fmt_decimal(s['total_cost'])} 元 / {s['reading_count']} 条"
            )


def _render_rule_diff(diff):
    print("一、规则差异")
    if not (diff["added"] or diff["removed"] or diff["changed"]):
        print("  （无差异）")
        return
    for rule in diff["added"]:
        print(f"  新增 [{rule['kind']}] {rule['rule_id']}: {_rule_brief(rule)}")
    for rule in diff["removed"]:
        print(f"  删除 [{rule['kind']}] {rule['rule_id']}: {_rule_brief(rule)}")
    for change in diff["changed"]:
        fields = "，".join(
            f"{field}: {_fmt_diff_value(before)} → {_fmt_diff_value(after)}"
            for field, (before, after) in change["fields"].items()
        )
        print(f"  修改 [{change['kind']}] {change['rule_id']}: {fields}")


def _rule_brief(rule):
    if rule["kind"] == "attribution":
        return (
            f"表 {rule['meter_id']} → {rule['workshop_id']} {rule['workshop_name']}，"
            f"区间 [{rule['valid_from']}, {rule['valid_to'] or '∞'})"
        )
    scope = rule["workshop_id"] or "全部车间"
    return (
        f"{scope} 电价 {_fmt_decimal(rule['price_per_kwh'])} 元/kWh，"
        f"区间 [{rule['valid_from']}, {rule['valid_to'] or '∞'})"
    )


def _fmt_diff_value(value):
    """规则差异字段值的展示：Decimal 去尾零，None 显示为空（长期有效）。"""
    if value is None:
        return "空（长期有效）"
    from decimal import Decimal

    if isinstance(value, Decimal):
        return _fmt_decimal(value)
    return repr(value)


def _render_preview(preview):
    _render_rule_diff(preview["rule_diff"])

    print("\n二、影响清单（按电表）")
    if not preview["impact"]:
        print("  （没有电表受影响）")
    for meter in preview["impact"]:
        reasons = "、".join(meter["reason_labels"])
        print(
            f"  电表 {meter['meter_id']}：自 {meter['first_affected_day']} 起受影响，"
            f"变更来源：{reasons}"
        )
        for d in meter["days"]:
            before, after = d["before"], d["after"]
            print(
                f"    - {d['day']}（{'、'.join(d['reason_labels'])}）: "
                f"正常读数 {before['ok_count']} → {after['ok_count']} 条，"
                f"电量 {_fmt_decimal(before['total_kwh'])} → {_fmt_decimal(after['total_kwh'])} kWh，"
                f"费用 {_fmt_decimal(before['total_cost'])} → {_fmt_decimal(after['total_cost'])} 元"
            )

    print("\n三、逐日车间汇总变化")
    if not preview["daily_changes"]:
        print("  （无变化）")
    for change in preview["daily_changes"]:
        print(f"  业务日 {change['day']}:")
        print("    before:")
        for s in change["before_summaries"]:
            print(
                f"      {s['workshop_id']} {s['workshop_name']}: "
                f"{_fmt_decimal(s['total_kwh'])} kWh / {_fmt_decimal(s['total_cost'])} 元"
            )
        print("    after:")
        for s in change["after_summaries"]:
            print(
                f"      {s['workshop_id']} {s['workshop_name']}: "
                f"{_fmt_decimal(s['total_kwh'])} kWh / {_fmt_decimal(s['total_cost'])} 元"
            )
    if preview["unchanged_days"]:
        print(f"  未变化日期: {', '.join(preview['unchanged_days'])}")

    print("\n四、异常清单变化")
    exc = preview["exception_changes"]
    if not (exc["added"] or exc["recovered"] or exc["changed"]):
        print("  （无变化）")
    for item in exc["added"]:
        print(
            f"  新增异常: {item['meter_id']} {item['reading_time']} "
            f"{item['after_code']}（{item['after_message']}）"
        )
    for item in exc["recovered"]:
        print(
            f"  恢复正常: {item['meter_id']} {item['reading_time']} "
            f"原异常 {item['before_code']}（{item['before_message']}）"
        )
    for item in exc["changed"]:
        print(
            f"  异常类型变化: {item['meter_id']} {item['reading_time']} "
            f"{item['before_code']} → {item['after_code']}"
        )

    print(
        f"\n候选规则版本: {preview['candidate_version']}；"
        f"受影响日期: {', '.join(preview['affected_days']) or '（无）'}"
    )
    print(
        f"确认命令: python3 -m power_ledger.cli confirm --store <账本目录> "
        f"--preview {preview['preview_id']}"
    )
    print("预览期间已发布结果保持不变。")


# ---------------------------------------------------------------- 子命令

def cmd_init(args):
    store, version, ledgers = init_store(
        args.store, args.readings, args.attr, args.tariff, _now()
    )
    if args.json:
        _print_json(
            {
                "store": str(store.root),
                "version": version,
                "days": sorted(ledgers),
                "ledgers": [ledgers[d] for d in sorted(ledgers)],
            }
        )
    else:
        _render_init(ledgers, version)


def cmd_preview(args):
    _store, preview = preview_changes(args.store, args.attr, args.tariff, _now())
    if args.json:
        _print_json(preview)
    else:
        _render_preview(preview)


def cmd_confirm(args):
    preview = confirm_preview(args.store, args.preview, _now())
    if args.json:
        _print_json(preview)
    else:
        print(
            f"预览 {preview['preview_id']} 已确认，规则版本切换到 "
            f"{preview['candidate_version']}。"
        )
        print(f"已重算并替换 {len(preview['affected_days'])} 个业务日: "
              f"{', '.join(preview['affected_days']) or '（无）'}")
        print("其余日期保持原样。")


def cmd_show(args):
    store = Store(args.store)
    store.require_exists()
    ledger = store.load_ledger_day(args.day)
    if args.json:
        _print_json(ledger)
        return
    print(f"业务日 {ledger['day']}（规则版本 {ledger['rules_version']}，{ledger['rules_hash'][:19]}…）")
    print("车间汇总:")
    for s in ledger["summaries"]:
        print(
            f"  {s['workshop_id']} {s['workshop_name']}: "
            f"{_fmt_decimal(s['total_kwh'])} kWh / {_fmt_decimal(s['total_cost'])} 元 / "
            f"{s['reading_count']} 条"
        )
    print(f"\n正常读数 {len(ledger['readings'])} 条:")
    for r in ledger["readings"]:
        print(
            f"  {r['reading_time']} {r['meter_id']} → {r['workshop_id']} "
            f"{r['workshop_name']}: {_fmt_decimal(r['consumption_kwh'])} kWh × "
            f"{_fmt_decimal(r['price_per_kwh'])} = {_fmt_decimal(r['cost'])} 元"
            f"（归属 {r['attribution_hits'][0]}，电价 {r['tariff_rule_id']}）"
        )
    print(f"\n异常读数 {len(ledger['exceptions'])} 条:")
    for r in ledger["exceptions"]:
        print(f"  {r['reading_time']} {r['meter_id']}: {r['exception']['code']} — {r['exception']['message']}")


def cmd_versions(args):
    store = Store(args.store)
    store.require_exists()
    versions = store.list_versions()
    if args.json:
        _print_json(versions)
        return
    meta = store.meta()
    for v in versions:
        current = "（当前）" if v["version"] == meta["current_version"] else ""
        print(f"版本 {v['version']} {current} {v['content_hash']} 来源: {v['created_from']}")


def cmd_previews(args):
    store = Store(args.store)
    store.require_exists()
    previews = store.list_previews()
    if args.json:
        _print_json(previews)
        return
    if not previews:
        print("（没有预览）")
    for p in previews:
        print(
            f"预览 {p['preview_id']}: {p['status']}，"
            f"版本 {p['base_version']} → {p['candidate_version']}，"
            f"受影响日期 {len(p['affected_days'])} 个"
        )


# ---------------------------------------------------------------- 入口

def build_parser():
    parser = argparse.ArgumentParser(
        prog="power-ledger",
        description="车间用电按北京时间业务日归集；规则变更先出影响清单，确认后只重算受影响日期。",
    )
    sub = parser.add_subparsers(dest="command", required=True)

    p_init = sub.add_parser("init", help="首次运行：读取三张表并按业务日发布")
    p_init.add_argument("--store", required=True, help="账本目录")
    p_init.add_argument("--readings", required=True, help="电表用电 CSV")
    p_init.add_argument("--attr", required=True, help="电表归属表 CSV")
    p_init.add_argument("--tariff", required=True, help="电价表 CSV")
    p_init.add_argument("--json", action="store_true", help="输出机器可读 JSON")
    p_init.set_defaults(func=cmd_init)

    p_prev = sub.add_parser("preview", help="规则变更预览（不改动已发布结果）")
    p_prev.add_argument("--store", required=True)
    p_prev.add_argument("--attr", required=True, help="新版电表归属表 CSV")
    p_prev.add_argument("--tariff", required=True, help="新版电价表 CSV")
    p_prev.add_argument("--json", action="store_true")
    p_prev.set_defaults(func=cmd_preview)

    p_conf = sub.add_parser("confirm", help="确认预览，只重算清单中的日期")
    p_conf.add_argument("--store", required=True)
    p_conf.add_argument("--preview", required=True, type=int)
    p_conf.add_argument("--json", action="store_true")
    p_conf.set_defaults(func=cmd_confirm)

    p_show = sub.add_parser("show", help="查看某业务日的已发布结果")
    p_show.add_argument("--store", required=True)
    p_show.add_argument("--day", required=True)
    p_show.add_argument("--json", action="store_true")
    p_show.set_defaults(func=cmd_show)

    p_ver = sub.add_parser("versions", help="列出规则版本")
    p_ver.add_argument("--store", required=True)
    p_ver.add_argument("--json", action="store_true")
    p_ver.set_defaults(func=cmd_versions)

    p_pre = sub.add_parser("previews", help="列出预览")
    p_pre.add_argument("--store", required=True)
    p_pre.add_argument("--json", action="store_true")
    p_pre.set_defaults(func=cmd_previews)
    return parser


def main(argv=None):
    parser = build_parser()
    args = parser.parse_args(argv)
    try:
        args.func(args)
    except LedgerError as exc:
        print(f"错误: {exc}", file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
