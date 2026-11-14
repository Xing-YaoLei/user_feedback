#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""设备测量数据转换工具。

将设备导出的宽表 CSV 按 JSON 字段字典展开为统一的测量明细：

- 按模板版本做十进制单位换算（Decimal：原值 × 换算系数 = 标准单位值）；
- 先换算，再按标准单位的允许范围判定；
- 空值 / 非数字 / 超范围分别记入拒收清单，同一行其他合格测量项照常输出；
- 无法识别模板版本的行单独列出；
- 字典把同一版本的两列映射到同一测量项时，在处理数据前报出冲突并退出。

用法：
    python3 convert.py --dict dictionary.json --csv-dir samples --out out
    python3 convert.py --dict dictionary.json --out out a.csv b.csv
"""

import argparse
import csv
import json
import sys
from decimal import Decimal, InvalidOperation
from pathlib import Path

REASON_EMPTY = "空值"
REASON_MISSING_COLUMN = "缺列"
REASON_NON_NUMERIC = "非数字"
REASON_OUT_OF_RANGE = "超范围"

MEASUREMENT_HEADER = ["样件号", "测量项", "标准值", "标准单位", "模板版本",
                      "原文件", "行号", "列名", "原值", "原单位"]
REJECTION_HEADER = ["样件号", "测量项", "拒收原因", "模板版本",
                    "原文件", "行号", "列名", "原值"]
UNKNOWN_HEADER = ["样件号", "模板版本", "原文件", "行号"]


class DictError(Exception):
    """字段字典本身不合法（区别于字典冲突）。"""


def _parse_decimal(text, what):
    try:
        return Decimal(str(text))
    except InvalidOperation:
        raise DictError(f"{what} 不是有效数字: {text!r}")


def load_dictionary(path):
    """加载并校验字段字典。

    返回 (样件号列名, 版本列名, {版本: [列规则, ...]}, [冲突描述, ...])。
    结构不合法抛 DictError；同一版本两列映射到同一测量项时记入冲突列表，
    由调用方在处理数据前报出。
    """
    try:
        with open(path, encoding="utf-8") as f:
            raw = json.load(f)
    except FileNotFoundError:
        raise DictError(f"字典文件不存在: {path}")
    except json.JSONDecodeError as e:
        raise DictError(f"字典文件不是合法 JSON: {e}")

    if not isinstance(raw, dict):
        raise DictError("字典顶层必须是 JSON 对象")
    sample_id_column = raw.get("sample_id_column")
    version_column = raw.get("version_column")
    if not sample_id_column or not version_column:
        raise DictError("字典必须声明 sample_id_column 和 version_column")
    versions_raw = raw.get("versions")
    if not isinstance(versions_raw, dict) or not versions_raw:
        raise DictError("字典必须包含非空的 versions 对象")

    rules_by_version = {}
    conflicts = []
    for version, body in versions_raw.items():
        columns = (body or {}).get("columns")
        if not isinstance(columns, list) or not columns:
            raise DictError(f"版本 {version!r} 必须包含非空的 columns 列表")
        rules = []
        for i, col in enumerate(columns):
            where = f"版本 {version!r} 第 {i + 1} 个列映射"
            if not isinstance(col, dict):
                raise DictError(f"{where} 必须是对象")
            for key in ("source_column", "item", "standard_unit", "factor"):
                if key not in col:
                    raise DictError(f"{where} 缺少字段 {key!r}")
            rule = {
                "source_column": str(col["source_column"]),
                "item": str(col["item"]),
                "source_unit": str(col.get("source_unit", "")),
                "standard_unit": str(col["standard_unit"]),
                "factor": _parse_decimal(col["factor"], f"{where} 的 factor"),
                "min": _parse_decimal(col["min"], f"{where} 的 min")
                       if col.get("min") is not None else None,
                "max": _parse_decimal(col["max"], f"{where} 的 max")
                       if col.get("max") is not None else None,
            }
            if (rule["min"] is not None and rule["max"] is not None
                    and rule["min"] > rule["max"]):
                raise DictError(f"{where} 的 min 大于 max")
            rules.append(rule)
        # 冲突检查：同一版本内不允许两列映射到同一测量项
        by_item = {}
        for rule in rules:
            by_item.setdefault(rule["item"], []).append(rule["source_column"])
        for item, cols in by_item.items():
            if len(cols) > 1:
                conflicts.append(
                    f"版本 {version!r}: 列 {cols} 都映射到了测量项 {item!r}")
        rules_by_version[version] = rules
    return sample_id_column, version_column, rules_by_version, conflicts


def _fmt_decimal(d):
    # normalize 去掉多余的 0，format 'f' 避免科学计数法
    return format(d.normalize(), "f")


def process_file(path, sample_id_column, version_column, rules_by_version,
                 measurements, rejections, unknown_rows):
    with open(path, newline="", encoding="utf-8-sig") as f:
        reader = csv.DictReader(f)
        if reader.fieldnames is None:
            return
        for row in reader:
            line_no = reader.line_num  # 文件物理行号（表头为第 1 行）
            sample_id = (row.get(sample_id_column) or "").strip()
            version = (row.get(version_column) or "").strip()
            rules = rules_by_version.get(version)
            if rules is None:
                unknown_rows.append([sample_id, version, path.name, line_no])
                continue
            for rule in rules:
                col = rule["source_column"]
                base = [sample_id, rule["item"]]
                tail = [version, path.name, line_no, col]
                if col not in row:
                    rejections.append(base + [REASON_MISSING_COLUMN] + tail + [""])
                    continue
                raw_value = (row.get(col) or "").strip()
                if raw_value == "":
                    rejections.append(base + [REASON_EMPTY] + tail + [""])
                    continue
                try:
                    original = Decimal(raw_value)
                except InvalidOperation:
                    original = None
                if original is None or not original.is_finite():
                    rejections.append(
                        base + [REASON_NON_NUMERIC] + tail + [raw_value])
                    continue
                # 先做十进制单位换算，再按标准单位的范围判断
                standard = original * rule["factor"]
                if ((rule["min"] is not None and standard < rule["min"])
                        or (rule["max"] is not None and standard > rule["max"])):
                    rejections.append(
                        base + [REASON_OUT_OF_RANGE] + tail + [raw_value])
                    continue
                measurements.append(
                    [sample_id, rule["item"], _fmt_decimal(standard),
                     rule["standard_unit"], version, path.name, line_no,
                     col, raw_value, rule["source_unit"]])


def _write_csv(path, header, rows):
    # utf-8-sig 方便质检直接用 Excel 打开中文表头
    with open(path, "w", newline="", encoding="utf-8-sig") as f:
        writer = csv.writer(f)
        writer.writerow(header)
        writer.writerows(rows)


def main(argv=None):
    parser = argparse.ArgumentParser(
        description="按字段字典把设备宽表 CSV 转换为统一测量明细")
    parser.add_argument("--dict", dest="dict_path", required=True,
                        help="JSON 字段字典路径")
    parser.add_argument("--csv-dir", dest="csv_dir",
                        help="批量处理该目录下全部 .csv 文件")
    parser.add_argument("--out", dest="out_dir", default="out",
                        help="输出目录（默认 out/）")
    parser.add_argument("csv_files", nargs="*", help="要处理的 CSV 文件")
    args = parser.parse_args(argv)

    try:
        (sample_id_column, version_column,
         rules_by_version, conflicts) = load_dictionary(args.dict_path)
    except DictError as e:
        print(f"字典错误: {e}", file=sys.stderr)
        return 2
    if conflicts:
        print("字段字典存在冲突，未处理任何数据，请修正后重试:", file=sys.stderr)
        for c in conflicts:
            print(f"  - {c}", file=sys.stderr)
        return 2

    files = list(args.csv_files)
    if args.csv_dir:
        files.extend(str(p) for p in sorted(Path(args.csv_dir).glob("*.csv")))
    if not files:
        print("没有可处理的 CSV 文件", file=sys.stderr)
        return 2

    measurements, rejections, unknown_rows = [], [], []
    for name in files:
        process_file(Path(name), sample_id_column, version_column,
                     rules_by_version, measurements, rejections, unknown_rows)

    out_dir = Path(args.out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    _write_csv(out_dir / "measurements.csv", MEASUREMENT_HEADER, measurements)
    _write_csv(out_dir / "rejections.csv", REJECTION_HEADER, rejections)
    _write_csv(out_dir / "unknown_versions.csv", UNKNOWN_HEADER, unknown_rows)

    print(f"处理完成: {len(files)} 个文件")
    print(f"  测量明细 {len(measurements)} 条 -> {out_dir / 'measurements.csv'}")
    print(f"  拒收     {len(rejections)} 条 -> {out_dir / 'rejections.csv'}")
    print(f"  未识别版本 {len(unknown_rows)} 行 -> {out_dir / 'unknown_versions.csv'}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
