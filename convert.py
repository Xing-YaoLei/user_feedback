#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""多设备测量结果合并工具。

读取多台设备导出的宽表 CSV 与可更新的 JSON 字段字典，按
“样件号 + 检测轮次 + 测量项” 合并读数：

1. 每条数据行带样件号、检测轮次和模板版本，按版本选用字典里的列映射；
2. 先用 Decimal 做十进制单位换算，再剔除空值、非数字、超范围
   （以及字典声明但 CSV 中不存在的列）读数；
3. 同一样件、轮次、测量项下，剩余读数的最大值与最小值之差不超过该测量项
   配置的允许偏差时，采用优先级最高的来源；同优先级按文件名、行号取第一条，
   并保留全部参与比对的来源；
4. 差值超出允许偏差时，全部读数记为冲突，交质检复核，不产生有效值；
5. 字典可定义派生项，公式用 {测量项} 引用其他测量项（也可以是派生项），
   例如 "{总长} - {端部余量} * 2"；输入项缺测或冲突时，派生项标为
   无法计算，并指出阻塞它的测量项及原因；
6. 处理任何数据之前校验字典：重复键、未知字段、重复映射、未知引用、
   循环依赖、标准单位不一致、缺少允许偏差等，发现问题立即停止。

用法：
    python3 convert.py --dict dictionary.json --csv-dir samples --out out
    python3 convert.py --dict dictionary.json --out out a.csv b.csv

仅依赖 Python 3 标准库。
"""

import argparse
import csv
import json
import re
import sys
from dataclasses import dataclass, field
from decimal import (Context, Decimal, DecimalException, DivisionByZero,
                     InvalidOperation, localcontext)
from pathlib import Path
from typing import Dict, List, Optional

sys.path.insert(0, str(Path(__file__).resolve().parent))
import formula

# 换算与派生计算统一使用高精度十进制上下文，避免二进制浮点误差
CALC_CONTEXT = Context(prec=50)

REASON_EMPTY = "空值"
REASON_MISSING_COLUMN = "缺列"
REASON_NON_NUMERIC = "非数字"
REASON_OUT_OF_RANGE = "超范围"
REASON_CONVERT_ERROR = "换算失败"
REASON_MISSING_SAMPLE = "缺少样件号"
REASON_MISSING_ROUND = "缺少检测轮次"
REASON_COLUMN_COUNT = "列数与表头不符"
REASON_MISSING_VERSION = "缺少模板版本"
REASON_UNKNOWN_VERSION = "未知模板版本"

DISPOSITION_ADOPTED = "是"
DISPOSITION_AGREED = "否"
DISPOSITION_CONFLICT = "冲突"

STATUS_OK = "ok"
STATUS_CONFLICT = "conflict"
STATUS_MISSING = "missing"

SOURCE_TYPE_DEVICE = "设备读数"
SOURCE_TYPE_DERIVED = "派生"

MEASUREMENT_HEADER = [
    "样件号", "检测轮次", "测量项", "来源类型", "标准值", "标准单位",
    "模板版本", "原文件", "行号", "列名", "原值", "原单位", "优先级",
    "参与比对读数", "计算式", "输入明细",
]
SOURCE_HEADER = [
    "样件号", "检测轮次", "测量项", "标准值", "标准单位", "模板版本",
    "原文件", "行号", "列名", "原值", "原单位", "优先级", "是否采用",
]
CONFLICT_HEADER = [
    "样件号", "检测轮次", "测量项", "允许偏差", "最大差", "读数个数",
    "标准值", "标准单位", "模板版本", "原文件", "行号", "列名",
    "原值", "原单位", "优先级",
]
UNCOMPUTABLE_HEADER = [
    "样件号", "检测轮次", "测量项", "标准单位", "计算式", "阻塞测量项", "原因",
]
REJECTION_HEADER = [
    "样件号", "检测轮次", "测量项", "拒收原因", "模板版本",
    "原文件", "行号", "列名", "原值",
]
UNKNOWN_HEADER = ["样件号", "检测轮次", "模板版本", "原文件", "行号", "原因"]


class DictError(Exception):
    """字段字典或输入文件结构不合法。"""


# ---------------------------------------------------------------------------
# 数值工具
# ---------------------------------------------------------------------------

# 只接受普通十进制写法（可带科学计数法后缀）。用 re.ASCII 让 \d 只匹配 0-9，
# 否则全角/阿拉伯数字也会通过，而 Decimal 对它们会抛异常；
# 下划线分组、NaN、Infinity 等写法也在这里被挡下。
NUMBER_RE = re.compile(
    r"[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d{1,3})?", re.ASCII)


def parse_decimal(text, what):
    """把字典里的字符串解析为 Decimal；不合法抛 DictError。"""
    if isinstance(text, bool) or not isinstance(text, (str, int)):
        raise DictError(f"{what} 必须写成十进制字符串: {text!r}")
    raw = str(text).strip()
    if not NUMBER_RE.fullmatch(raw):
        raise DictError(f"{what} 不是有效数字: {text!r}")
    value = Decimal(raw)
    if not value.is_finite():
        raise DictError(f"{what} 必须是有限数字: {text!r}")
    return value


def format_decimal(value):
    """精确输出十进制：不使用科学计数法，去掉多余的 0，不做任何舍入。"""
    text = format(value, "f")
    if "." in text:
        text = text.rstrip("0").rstrip(".")
    if text in ("-0", ""):
        return "0"
    return text


def natural_key(text):
    """让 S2 排在 S10 之前的排序键（纯文本与纯数字都能安全比较）。

    只把 ASCII 数字当作数字段，避免上标/全角等字符让 int() 抛异常。
    """
    key = []
    for part in re.split(r"(\d+)", str(text)):
        if not part:
            continue
        if part.isascii() and part.isdigit():
            key.append((0, int(part), ""))
        else:
            key.append((1, 0, part))
    return key


# ---------------------------------------------------------------------------
# 字典结构与校验
# ---------------------------------------------------------------------------

@dataclass
class ColumnRule:
    source_column: str
    item: str
    source_unit: str
    standard_unit: str
    factor: Decimal
    min: Optional[Decimal]
    max: Optional[Decimal]


@dataclass
class DerivedRule:
    item: str
    standard_unit: str
    formula_text: str
    ast: tuple
    refs: List[str]


@dataclass
class Dictionary:
    sample_id_column: str
    round_column: str
    version_column: str
    default_priority: int
    sources: Dict[str, int]
    tolerances: Dict[str, Decimal]
    versions: Dict[str, List[ColumnRule]]
    standard_units: Dict[str, str]
    item_order: List[str]
    derived: List[DerivedRule]

    def item_index(self):
        return {item: i for i, item in enumerate(self.item_order)}

    def priority_for(self, file_name):
        return self.sources.get(file_name, self.default_priority)


@dataclass
class Reading:
    sample_id: str
    round: str
    item: str
    version: str
    file: str
    line: int
    column: str
    raw: str
    source_unit: str
    standard: Decimal
    standard_unit: str
    priority: int

    def sort_key(self):
        # 优先级高的在前；同优先级按文件名、行号取第一条
        return (-self.priority, self.file, self.line)


@dataclass
class ItemResult:
    status: str
    value: Optional[Decimal] = None
    reading: Optional[Reading] = None
    readings: Optional[List[Reading]] = None
    reason: str = ""
    # 缺测/冲突的根因测量项；派生项沿依赖链冒泡，便于一次看到真正阻塞它的输入
    blockers: List[str] = field(default_factory=list)


def _reject_duplicate_keys(pairs):
    obj = {}
    for key, value in pairs:
        if key in obj:
            raise DictError(f"字典中存在重复键 {key!r}（JSON 会静默覆盖，已拒绝加载）")
        obj[key] = value
    return obj


def _load_json(path):
    try:
        with open(path, encoding="utf-8") as f:
            return json.load(f, object_pairs_hook=_reject_duplicate_keys)
    except FileNotFoundError:
        raise DictError(f"字典文件不存在: {path}")
    except OSError as e:
        raise DictError(f"无法读取字典文件 {path}: {e}")
    except UnicodeDecodeError as e:
        raise DictError(f"字典文件 {path} 不是 UTF-8 编码: {e}")
    except json.JSONDecodeError as e:
        raise DictError(f"字典文件不是合法 JSON: {e}")


def _require_str(obj, key, where):
    value = obj.get(key)
    if not isinstance(value, str) or not value.strip():
        raise DictError(f"{where} 的 {key!r} 必须是非空字符串")
    return value.strip()


def _check_keys(obj, allowed, where):
    """拒绝未知字段：拼错的键若不报错，会被静默忽略，等于配置没生效。"""
    extra = sorted(str(key) for key in set(obj) - set(allowed))
    if extra:
        raise DictError(f"{where} 含未知字段 {extra}，可用字段: {sorted(allowed)}")


TOP_LEVEL_KEYS = {
    "sample_id_column", "round_column", "version_column",
    "default_priority", "sources", "tolerances", "versions", "derived",
}
VERSION_KEYS = {"columns"}
COLUMN_RULE_KEYS = {"source_column", "item", "source_unit", "standard_unit",
                    "factor", "min", "max"}
DERIVED_RULE_KEYS = {"item", "standard_unit", "formula"}


def _parse_column_rule(raw, where):
    if not isinstance(raw, dict):
        raise DictError(f"{where} 必须是对象")
    _check_keys(raw, COLUMN_RULE_KEYS, where)
    for key in ("source_column", "item", "standard_unit", "factor"):
        if key not in raw:
            raise DictError(f"{where} 缺少字段 {key!r}")
    rule = ColumnRule(
        source_column=_require_str(raw, "source_column", where),
        item=_require_str(raw, "item", where),
        source_unit=str(raw.get("source_unit") or "").strip(),
        standard_unit=_require_str(raw, "standard_unit", where),
        factor=parse_decimal(raw["factor"], f"{where} 的 factor"),
        min=parse_decimal(raw["min"], f"{where} 的 min")
        if raw.get("min") is not None else None,
        max=parse_decimal(raw["max"], f"{where} 的 max")
        if raw.get("max") is not None else None,
    )
    if rule.factor == 0:
        raise DictError(f"{where} 的 factor 不能为 0")
    if (rule.min is not None and rule.max is not None
            and rule.min > rule.max):
        raise DictError(f"{where} 的 min 大于 max")
    return rule


def _parse_versions(raw_versions):
    if not isinstance(raw_versions, dict) or not raw_versions:
        raise DictError("字典必须包含非空的 versions 对象")
    versions = {}
    order = []           # 标准测量项的声明顺序
    standard_units = {}
    for version, body in raw_versions.items():
        if not isinstance(body, dict):
            raise DictError(f"版本 {version!r} 必须是对象")
        _check_keys(body, VERSION_KEYS, f"版本 {version!r}")
        columns = body.get("columns")
        if not isinstance(columns, list) or not columns:
            raise DictError(f"版本 {version!r} 必须包含非空的 columns 列表")
        rules, seen_cols, seen_items = [], {}, {}
        for i, raw in enumerate(columns):
            where = f"版本 {version!r} 第 {i + 1} 个列映射"
            rule = _parse_column_rule(raw, where)
            if rule.source_column in seen_cols:
                raise DictError(
                    f"版本 {version!r} 内原列 {rule.source_column!r} 重复映射"
                    f"（第 {seen_cols[rule.source_column]} 条与第 {i + 1} 条）")
            if rule.item in seen_items:
                raise DictError(
                    f"版本 {version!r} 内测量项 {rule.item!r} 被重复映射"
                    f"（原列 {seen_items[rule.item]!r} 与 {rule.source_column!r}）")
            seen_cols[rule.source_column] = i + 1
            seen_items[rule.item] = rule.source_column
            if rule.item in standard_units:
                if standard_units[rule.item] != rule.standard_unit:
                    raise DictError(
                        f"测量项 {rule.item!r} 在不同版本的标准单位不一致："
                        f"{standard_units[rule.item]!r} 与 {rule.standard_unit!r}")
            else:
                standard_units[rule.item] = rule.standard_unit
                order.append(rule.item)
            rules.append(rule)
        versions[version] = rules
    return versions, standard_units, order


def _parse_tolerances(raw, standard_items, derived_names, item_order):
    if raw is None:
        raise DictError(
            "字典必须包含 tolerances 对象，为每个标准测量项配置允许的读数偏差")
    if not isinstance(raw, dict):
        raise DictError("tolerances 必须是对象（测量项 -> 允许偏差）")
    tolerances = {}
    for item, value in raw.items():
        if item in derived_names:
            raise DictError(f"派生项 {item!r} 不应配置允许读数偏差（派生值不参与比对）")
        if item not in standard_items:
            raise DictError(f"tolerances 引用了未知的测量项 {item!r}")
        tol = parse_decimal(value, f"测量项 {item!r} 的允许偏差")
        if tol < 0:
            raise DictError(f"测量项 {item!r} 的允许偏差不能为负数: {value!r}")
        tolerances[item] = tol
    missing = [item for item in item_order if item not in tolerances]
    if missing:
        raise DictError(f"以下标准测量项缺少允许偏差配置: {missing}")
    return tolerances


def _parse_derived(raw_derived, standard_items, standard_units,
                   tolerances_declared):
    if raw_derived is None:
        raw_derived = []
    if not isinstance(raw_derived, list):
        raise DictError("derived 必须是列表")

    # 第一遍：收集派生项名称和单位，保证公式可以引用定义在后面的派生项
    declared = []
    for i, raw in enumerate(raw_derived):
        where = f"derived 第 {i + 1} 项"
        if not isinstance(raw, dict):
            raise DictError(f"{where} 必须是对象")
        _check_keys(raw, DERIVED_RULE_KEYS, where)
        item = _require_str(raw, "item", where)
        if item in standard_items:
            raise DictError(f"派生项 {item!r} 与标准测量项重名，公式引用会产生歧义")
        if item in declared:
            raise DictError(f"派生项 {item!r} 重复定义（第 {declared.index(item) + 1} "
                            f"项与第 {i + 1} 项）")
        if item in tolerances_declared:
            raise DictError(f"派生项 {item!r} 不应配置允许读数偏差（派生值不参与比对）")
        declared.append(item)
        standard_units[item] = _require_str(raw, "standard_unit", where)
    known = set(standard_items) | set(declared)

    # 第二遍：解析公式并检查引用
    rules = []
    for i, raw in enumerate(raw_derived):
        where = f"derived 第 {i + 1} 项"
        item = raw["item"].strip()
        unit = standard_units[item]
        text = _require_str(raw, "formula", where)
        try:
            ast = formula.parse_formula(text)
        except formula.FormulaError as e:
            raise DictError(f"{where}（{item!r}）公式不合法: {e}")
        refs = formula.formula_references(ast)
        unknown = [ref for ref in refs if ref not in known]
        if unknown:
            raise DictError(f"派生项 {item!r} 引用了未知测量项: {unknown}")
        rules.append(DerivedRule(item=item, standard_unit=unit,
                                 formula_text=text, ast=ast, refs=refs))

    # 公式只做数值加减乘除，不做单位换算：引用项必须与派生项同单位
    for rule in rules:
        wrong = [f"{ref}({standard_units[ref]})" for ref in rule.refs
                 if standard_units[ref] != rule.standard_unit]
        if wrong:
            raise DictError(
                f"派生项 {rule.item!r} 的标准单位是 {rule.standard_unit!r}，"
                f"却引用了不同单位的测量项: {wrong}；公式不做单位换算")
    return rules


def _topological_order(derived_rules):
    """按依赖顺序返回派生项；存在循环依赖时抛 DictError。"""
    by_name = {rule.item: rule for rule in derived_rules}
    state = {}          # 0=未访问 1=访问中 2=已完成
    ordered = []
    cycles = []

    def visit(name, stack):
        mark = state.get(name, 0)
        if mark == 2:
            return
        if mark == 1:
            start = stack.index(name)
            cycles.append(" -> ".join(stack[start:] + [name]))
            return
        state[name] = 1
        for ref in by_name[name].refs:
            if ref in by_name:
                visit(ref, stack + [name])
        state[name] = 2
        ordered.append(by_name[name])

    for rule in derived_rules:
        visit(rule.item, [])
    if cycles:
        raise DictError("派生项存在循环依赖: " + "；".join(cycles))
    return ordered


def _parse_sources(raw_sources, raw_default):
    sources = {}
    if raw_sources is None:
        raw_sources = {}
    if not isinstance(raw_sources, dict):
        raise DictError("sources 必须是对象（文件名 -> 优先级整数）")
    for name, value in raw_sources.items():
        if not isinstance(name, str) or not name.strip():
            raise DictError(f"sources 的文件名不合法: {name!r}")
        priority = _parse_priority(value, f"来源 {name!r} 的优先级")
        name = name.strip()
        if name in sources:
            raise DictError(f"sources 中文件名 {name!r} 重复配置")
        sources[name] = priority
    default = _parse_priority(raw_default if raw_default is not None else 0,
                             "default_priority")
    return sources, default


def _parse_priority(value, what):
    if isinstance(value, bool) or not isinstance(value, int):
        raise DictError(f"{what} 必须是整数: {value!r}")
    return value


def load_dictionary(path):
    """加载并校验字段字典；返回 Dictionary，任何问题都抛 DictError。

    校验在读取任何 CSV 数据之前完成：重复键、重复映射、未知引用、
    循环依赖、标准单位不一致、缺少允许偏差等。
    """
    raw = _load_json(path)
    if not isinstance(raw, dict):
        raise DictError("字典顶层必须是 JSON 对象")
    _check_keys(raw, TOP_LEVEL_KEYS, "字典顶层")
    sample_id_column = _require_str(raw, "sample_id_column", "字典")
    round_column = _require_str(raw, "round_column", "字典")
    version_column = _require_str(raw, "version_column", "字典")
    meta_columns = [sample_id_column, round_column, version_column]
    if len(set(meta_columns)) != 3:
        raise DictError(f"样件号/检测轮次/模板版本列名不能重复: {meta_columns}")

    versions, standard_units, item_order = _parse_versions(raw.get("versions"))
    standard_items = set(standard_units)

    raw_tolerances = raw.get("tolerances")
    if raw_tolerances is not None and not isinstance(raw_tolerances, dict):
        raise DictError("tolerances 必须是对象（测量项 -> 允许偏差）")
    raw_tolerances = raw_tolerances or {}

    # 传入副本：派生项的单位只用于公式单位检查，不能混进标准测量项集合
    all_units = dict(standard_units)
    derived_rules = _parse_derived(raw.get("derived"), standard_items,
                                   all_units, raw_tolerances)
    derived_names = {rule.item for rule in derived_rules}
    tolerances = _parse_tolerances(raw.get("tolerances"), standard_items,
                                   derived_names, item_order)
    derived_rules = _topological_order(derived_rules)
    sources, default_priority = _parse_sources(
        raw.get("sources"), raw.get("default_priority"))

    item_order = item_order + [rule.item for rule in derived_rules]
    return Dictionary(
        sample_id_column=sample_id_column,
        round_column=round_column,
        version_column=version_column,
        default_priority=default_priority,
        sources=sources,
        tolerances=tolerances,
        versions=versions,
        standard_units=standard_units,
        item_order=item_order,
        derived=derived_rules,
    )


# ---------------------------------------------------------------------------
# 读取 CSV
# ---------------------------------------------------------------------------

def _open_csv(path):
    """以 UTF-8（兼容 BOM）打开 CSV；打不开时转成 DictError。"""
    try:
        return open(path, newline="", encoding="utf-8-sig")
    except OSError as e:
        raise DictError(f"无法读取 CSV 文件 {path}: {e}")


def read_csv_rows(path, dictionary):
    """读取并校验一个 CSV 的表头，逐行产出 (物理行号, {列名: 值}, 是否多出无名值)。

    表头去空白后使用；重复列名或缺少元数据列都在处理数据前报错。
    完全空白的行直接跳过。
    """
    try:
        with _open_csv(path) as f:
            reader = csv.reader(f)
            header = next(reader, None)
            if header is None:
                raise DictError(f"CSV 文件 {path} 是空文件（缺少表头）")
            header = [name.strip() for name in header]
            named = [name for name in header if name]
            duplicated = sorted({name for name in named if named.count(name) > 1})
            if duplicated:
                raise DictError(f"CSV 文件 {path} 表头存在重复列名: {duplicated}")
            missing = [name for name in (dictionary.sample_id_column,
                                         dictionary.round_column,
                                         dictionary.version_column)
                       if name not in header]
            if missing:
                raise DictError(f"CSV 文件 {path} 缺少必需列: {missing}")
            for values in reader:
                line_no = reader.line_num
                if not values or not any(value.strip() for value in values):
                    continue          # 空白行（含只有逗号的行）直接跳过
                row = {}
                for index, name in enumerate(header):
                    if name:
                        row[name] = values[index] if index < len(values) else ""
                # 只有多出非空值才算错位：多出的值没有列名，无法追溯
                overflow = any(value.strip() for value in values[len(header):])
                yield line_no, row, overflow
    except UnicodeDecodeError as e:
        raise DictError(f"CSV 文件 {path} 不是 UTF-8 编码: {e}")
    except csv.Error as e:
        raise DictError(f"CSV 文件 {path} 解析失败: {e}")
    except OSError as e:
        raise DictError(f"读取 CSV 文件 {path} 失败: {e}")


def read_csv_file(path, dictionary, readings_by_key, rejections,
                  unknown_rows, observed):
    """读取一个设备 CSV，收集读数、拒收、未知版本记录。"""
    file_name = path.name
    priority = dictionary.priority_for(file_name)
    for line_no, row, overflow in read_csv_rows(path, dictionary):
        sample_id = (row.get(dictionary.sample_id_column) or "").strip()
        round_id = (row.get(dictionary.round_column) or "").strip()
        version = (row.get(dictionary.version_column) or "").strip()

        rules = dictionary.versions.get(version)
        if rules is None:
            reason = REASON_MISSING_VERSION if not version else REASON_UNKNOWN_VERSION
            unknown_rows.append([sample_id, round_id, version,
                                 file_name, line_no, reason])
            continue
        if not sample_id or not round_id:
            reason = REASON_MISSING_SAMPLE if not sample_id else REASON_MISSING_ROUND
            rejections.append([sample_id, round_id, "", reason, version,
                               file_name, line_no, "", ""])
            continue
        if overflow:
            # 多出的值没有列名可对应，通常是漏了引号导致整行错位，整行不可信
            rejections.append([sample_id, round_id, "", REASON_COLUMN_COUNT,
                               version, file_name, line_no, "", ""])
            continue
        observed.add((sample_id, round_id))

        for rule in rules:
            col = rule.source_column
            base_tail = [version, file_name, line_no, col]
            if col not in row:
                rejections.append([sample_id, round_id, rule.item,
                                   REASON_MISSING_COLUMN] + base_tail + [""])
                continue
            raw_value = (row.get(col) or "").strip()
            if raw_value == "":
                rejections.append([sample_id, round_id, rule.item,
                                   REASON_EMPTY] + base_tail + [""])
                continue
            if not NUMBER_RE.fullmatch(raw_value):
                rejections.append([sample_id, round_id, rule.item,
                                   REASON_NON_NUMERIC] + base_tail
                                  + [raw_value])
                continue
            original = Decimal(raw_value)
            if not original.is_finite():
                rejections.append([sample_id, round_id, rule.item,
                                   REASON_NON_NUMERIC] + base_tail
                                  + [raw_value])
                continue
            # 先按十进制换算到标准单位，再按标准单位的闭区间判定
            try:
                with localcontext(CALC_CONTEXT):
                    standard = original * rule.factor
            except DecimalException:
                rejections.append([sample_id, round_id, rule.item,
                                   REASON_CONVERT_ERROR] + base_tail
                                  + [raw_value])
                continue
            if ((rule.min is not None and standard < rule.min)
                    or (rule.max is not None and standard > rule.max)):
                rejections.append([sample_id, round_id, rule.item,
                                   REASON_OUT_OF_RANGE] + base_tail
                                  + [raw_value])
                continue
            reading = Reading(
                sample_id=sample_id, round=round_id, item=rule.item,
                version=version, file=file_name, line=line_no,
                column=col, raw=raw_value, source_unit=rule.source_unit,
                standard=standard, standard_unit=rule.standard_unit,
                priority=priority,
            )
            readings_by_key.setdefault(
                (sample_id, round_id, rule.item), []).append(reading)


# ---------------------------------------------------------------------------
# 合并与派生
# ---------------------------------------------------------------------------

def _rejection_summary(rows):
    """把一组拒收记录压缩成原因摘要，例如“缺测：读数全部被剔除（空值 1 条）”。"""
    counts = {}
    for row in rows:
        counts[row[3]] = counts.get(row[3], 0) + 1
    if not counts:
        return ""
    parts = [f"{reason} {count} 条" for reason, count in counts.items()]
    return "缺测：读数全部被剔除（" + "、".join(parts) + "）"


def resolve_readings(dictionary, readings_by_key, rejections):
    """对每个 样件+轮次+测量项 分组做偏差比对与来源选择。"""
    results = {}
    sources_rows = []
    conflict_rows = []

    for key, readings in readings_by_key.items():
        sample_id, round_id, item = key
        tol = dictionary.tolerances[item]
        ordered = sorted(readings, key=Reading.sort_key)
        values = [r.standard for r in ordered]
        with localcontext(CALC_CONTEXT):
            span = max(values) - min(values)

        if span <= tol:
            adopted = ordered[0]
            results[key] = ItemResult(STATUS_OK, adopted.standard, adopted,
                                      ordered, "")
            for reading in ordered:
                sources_rows.append(
                    [sample_id, round_id, item, format_decimal(reading.standard),
                     reading.standard_unit, reading.version, reading.file,
                     reading.line, reading.column, reading.raw,
                     reading.source_unit, reading.priority,
                     DISPOSITION_ADOPTED if reading is adopted
                     else DISPOSITION_AGREED])
        else:
            results[key] = ItemResult(
                STATUS_CONFLICT, None, None, ordered,
                f"读数最大差 {format_decimal(span)} 超过允许偏差 "
                f"{format_decimal(tol)}")
            for reading in ordered:
                conflict_rows.append(
                    [sample_id, round_id, item, format_decimal(tol),
                     format_decimal(span), len(ordered),
                     format_decimal(reading.standard), reading.standard_unit,
                     reading.version, reading.file, reading.line,
                     reading.column, reading.raw, reading.source_unit,
                     reading.priority])
                sources_rows.append(
                    [sample_id, round_id, item, format_decimal(reading.standard),
                     reading.standard_unit, reading.version, reading.file,
                     reading.line, reading.column, reading.raw,
                     reading.source_unit, reading.priority,
                     DISPOSITION_CONFLICT])
    # 全部读数都被剔除的分组：记录缺测原因，供派生项指出阻塞点
    by_group = {}
    for row in rejections:
        by_group.setdefault((row[0], row[1], row[2]), []).append(row)
    for (sample_id, round_id, item), group_rows in by_group.items():
        key = (sample_id, round_id, item)
        if key in results or item not in dictionary.tolerances:
            continue
        results[key] = ItemResult(
            STATUS_MISSING, None, None, None, _rejection_summary(group_rows),
            [item])
    return results, sources_rows, conflict_rows


def _input_detail(derived_names, key, refs, results, values):
    """派生项输入的可追溯摘要：直接输入的设备读数带上原文件与行号。"""
    parts = []
    for ref in refs:
        ref_result = results.get(key + (ref,))
        value = format_decimal(values[ref])
        if ref in derived_names:
            parts.append(f"{ref}={value}[派生]")
        else:
            reading = ref_result.reading if ref_result else None
            if reading is None:
                parts.append(f"{ref}={value}")
            else:
                parts.append(f"{ref}={value}[{reading.file}:{reading.line}]")
    return "；".join(parts)


def compute_derived(dictionary, results, measurements,
                    uncomputable, observed):
    """按依赖顺序计算派生项；记录无法计算的派生项及阻塞原因。"""
    derived_names = {rule.item for rule in dictionary.derived}
    for sample_id, round_id in sorted(observed):
        key = (sample_id, round_id)
        values = {}
        for rule in dictionary.derived:
            blockers = []
            root_causes = []
            for ref in rule.refs:
                ref_result = results.get(key + (ref,))
                if ref_result is None:
                    blockers.append((ref, "缺测：该轮次没有该测量项读数"))
                    root_causes.append(ref)
                elif ref_result.status == STATUS_CONFLICT:
                    detail = ref_result.reason or "待复核"
                    blockers.append((ref, f"冲突（{detail}）"))
                    root_causes.append(ref)
                elif ref_result.status == STATUS_MISSING:
                    if ref in derived_names:
                        # 沿依赖链给出根因文本与最底层被阻塞的输入项
                        blockers.append((ref, f"无法计算（{ref_result.reason}）"))
                        root_causes.extend(ref_result.blockers or [ref])
                    else:
                        blockers.append((ref, ref_result.reason or "缺测"))
                        root_causes.append(ref)
                else:
                    values[ref] = ref_result.value
            if blockers:
                reason = "输入项不可用：" + "；".join(
                    f"{name} {why}" for name, why in blockers)
                unique_roots = list(dict.fromkeys(root_causes))
                results[key + (rule.item,)] = ItemResult(
                    STATUS_MISSING, None, None, None, reason, unique_roots)
                uncomputable.append(
                    [sample_id, round_id, rule.item, rule.standard_unit,
                     rule.formula_text, "、".join(unique_roots), reason])
                continue
            try:
                value = formula.evaluate(rule.ast, values, CALC_CONTEXT)
                if not value.is_finite():
                    raise InvalidOperation
            except DivisionByZero:
                reason = "计算错误：除数为零"
            except (InvalidOperation, DecimalException):
                reason = "计算错误：十进制运算失败"
            else:
                results[key + (rule.item,)] = ItemResult(
                    STATUS_OK, value, None, None, "")
                measurements.append(
                    [sample_id, round_id, rule.item, SOURCE_TYPE_DERIVED,
                     format_decimal(value), rule.standard_unit,
                     "", "", "", "", "", "", "",
                     "", rule.formula_text,
                     _input_detail(derived_names, key, rule.refs, results,
                                   values)])
                continue

            results[key + (rule.item,)] = ItemResult(
                STATUS_MISSING, None, None, None, reason, list(rule.refs))
            uncomputable.append(
                [sample_id, round_id, rule.item, rule.standard_unit,
                 rule.formula_text, "、".join(rule.refs), reason])


# ---------------------------------------------------------------------------
# 输出
# ---------------------------------------------------------------------------

def write_csv(path, header, rows):
    # utf-8-sig 带 BOM，质检可直接用 Excel 打开中文表头
    with open(path, "w", newline="", encoding="utf-8-sig") as f:
        writer = csv.writer(f)
        writer.writerow(header)
        writer.writerows(rows)


def sort_rows(dictionary, rows, tail=None):
    index = dictionary.item_index()

    def key(row):
        base = (natural_key(row[0]), natural_key(row[1]),
                index.get(row[2], len(index)), row[2])
        return base + (tuple(tail(row)) if tail else ())
    return sorted(rows, key=key)


def build_measurement_rows(results):
    """有效明细：设备读数每组一行（采用项），派生项每个可计算值一行。"""
    rows = []
    for (sample_id, round_id, item), result in results.items():
        if result.status != STATUS_OK or result.reading is None:
            continue
        reading = result.reading
        rows.append([
            sample_id, round_id, item, SOURCE_TYPE_DEVICE,
            format_decimal(result.value), reading.standard_unit,
            reading.version, reading.file, reading.line, reading.column,
            reading.raw, reading.source_unit, reading.priority,
            len(result.readings),
            "", "",
        ])
    return rows


def main(argv=None):
    parser = argparse.ArgumentParser(
        description="按字段字典把多台设备的宽表 CSV 合并为测量明细")
    parser.add_argument("--dict", dest="dict_path", required=True,
                        help="JSON 字段字典路径")
    parser.add_argument("--csv-dir", dest="csv_dir",
                        help="批量处理该目录下全部 .csv 文件")
    parser.add_argument("--out", dest="out_dir", default="out",
                        help="输出目录（默认 out/）")
    parser.add_argument("csv_files", nargs="*", help="要处理的 CSV 文件")
    args = parser.parse_args(argv)

    try:
        dictionary = load_dictionary(args.dict_path)
    except DictError as e:
        print(f"字典错误，未处理任何数据: {e}", file=sys.stderr)
        return 2

    files = [Path(name) for name in args.csv_files]
    if args.csv_dir:
        csv_dir = Path(args.csv_dir)
        if not csv_dir.is_dir():
            print(f"目录不存在: {csv_dir}", file=sys.stderr)
            return 2
        files.extend(sorted(csv_dir.glob("*.csv")))
    # 同一文件既在目录里又被显式列出时只处理一次
    seen_paths = set()
    unique_files = []
    for path in files:
        resolved = path.resolve()
        if resolved in seen_paths:
            continue
        seen_paths.add(resolved)
        unique_files.append(path)
    files = unique_files
    for path in files:
        if not path.is_file():
            print(f"文件不存在: {path}", file=sys.stderr)
            return 2
    if not files:
        print("没有可处理的 CSV 文件", file=sys.stderr)
        return 2

    # 优先级和追溯信息都以文件名为准，同名文件会让来源无法区分
    by_name = {}
    for path in files:
        by_name.setdefault(path.name, []).append(str(path))
    clash = {name: paths for name, paths in by_name.items() if len(paths) > 1}
    if clash:
        print("存在同名 CSV 文件，无法按文件名区分来源:", file=sys.stderr)
        for name, paths in sorted(clash.items()):
            print(f"  - {name}: {paths}", file=sys.stderr)
        return 2
    unlisted = sorted(path.name for path in files
                      if path.name not in dictionary.sources)
    if unlisted:
        print(f"提示: 以下文件未在字典 sources 中配置优先级，"
              f"使用默认值 {dictionary.default_priority}: {unlisted}",
              file=sys.stderr)

    readings_by_key = {}
    rejections, unknown_rows = [], []
    observed = set()
    try:
        # 先读完全部数据再写输出：任何文件或表头错误都不会留下半成品
        for path in files:
            read_csv_file(path, dictionary, readings_by_key, rejections,
                          unknown_rows, observed)
    except DictError as e:
        print(f"输入文件错误，未处理任何数据: {e}", file=sys.stderr)
        return 2

    results, sources_rows, conflict_rows = resolve_readings(
        dictionary, readings_by_key, rejections)
    measurements = build_measurement_rows(results)
    uncomputable = []
    compute_derived(dictionary, results, measurements, uncomputable, observed)

    out_dir = Path(args.out_dir)
    try:
        out_dir.mkdir(parents=True, exist_ok=True)
        write_csv(out_dir / "measurements.csv", MEASUREMENT_HEADER,
                  sort_rows(dictionary, measurements))
        write_csv(out_dir / "sources.csv", SOURCE_HEADER,
                  sort_rows(dictionary, sources_rows,
                            lambda r: (-r[11], r[6], r[7])))
        write_csv(out_dir / "conflicts.csv", CONFLICT_HEADER,
                  sort_rows(dictionary, conflict_rows,
                            lambda r: (r[8], r[9], r[10])))
        write_csv(out_dir / "uncomputable.csv", UNCOMPUTABLE_HEADER,
                  sort_rows(dictionary, uncomputable))
        write_csv(out_dir / "rejections.csv", REJECTION_HEADER,
                  sort_rows(dictionary, rejections,
                            lambda r: (r[4], r[5], r[6])))
        write_csv(out_dir / "unknown_versions.csv", UNKNOWN_HEADER,
                  sorted(unknown_rows,
                         key=lambda r: (natural_key(r[0]), natural_key(r[1]),
                                        r[2], r[3], r[4])))
    except OSError as e:
        print(f"写出结果失败: {e}", file=sys.stderr)
        return 2

    print(f"处理完成: {len(files)} 个文件")
    print(f"  有效明细 {len(measurements)} 条 -> {out_dir / 'measurements.csv'}")
    print(f"  比对来源 {len(sources_rows)} 条 -> {out_dir / 'sources.csv'}")
    print(f"  待复核冲突 {len(set(tuple(r[:3]) for r in conflict_rows))} 组"
          f"（{len(conflict_rows)} 条读数） -> {out_dir / 'conflicts.csv'}")
    print(f"  无法计算 {len(uncomputable)} 条 -> {out_dir / 'uncomputable.csv'}")
    print(f"  拒收 {len(rejections)} 条 -> {out_dir / 'rejections.csv'}")
    print(f"  未识别版本 {len(unknown_rows)} 行 -> {out_dir / 'unknown_versions.csv'}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
