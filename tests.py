#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""convert.py 的行为测试：字典校验、合并规则、派生项。

运行：python3 -I tests.py
全部通过时退出码为 0；任何断言失败时退出码为 1。
"""

import csv
import io
import json
import sys
import tempfile
from decimal import Decimal
from pathlib import Path

ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT))

import convert
import formula

PASSED = []
FAILED = []


def check(name, fn):
    try:
        fn()
    except Exception as e:  # noqa: BLE001 - 测试脚本需要把失败原因全部打印出来
        FAILED.append((name, f"{type(e).__name__}: {e}"))
    else:
        PASSED.append(name)


def expect_dict_error(dict_payload, needle):
    tmp = tempfile.TemporaryDirectory()
    path = Path(tmp.name) / "d.json"
    path.write_text(json.dumps(dict_payload, ensure_ascii=False), encoding="utf-8")
    try:
        convert.load_dictionary(str(path))
    except convert.DictError as e:
        assert needle in str(e), f"错误信息里没有 {needle!r}: {e}"
    else:
        raise AssertionError("应当报出字典错误但没有")
    finally:
        tmp.cleanup()


BASE_DICT = {
    "sample_id_column": "样件号",
    "round_column": "检测轮次",
    "version_column": "模板版本",
    "tolerances": {"总长": "0.05"},
    "versions": {
        "V1": {"columns": [
            {"source_column": "L", "item": "总长", "standard_unit": "mm",
             "factor": "1", "min": "0", "max": "1000"},
        ]},
    },
}


def dict_with(**overrides):
    payload = json.loads(json.dumps(BASE_DICT))
    payload.update(overrides)
    return payload


def run_convert(files, dictionary=None):
    """在临时目录里跑一次 convert，返回 (退出码, {文件名: 行列表}, 标准错误)."""
    tmp = tempfile.TemporaryDirectory()
    try:
        work = Path(tmp.name)
        dict_path = work / "dictionary.json"
        dict_path.write_text(
            json.dumps(dictionary or BASE_DICT, ensure_ascii=False),
            encoding="utf-8")
        csv_dir = work / "csv"
        csv_dir.mkdir()
        for name, text in files.items():
            (csv_dir / name).write_text(text, encoding="utf-8")

        out_dir = work / "out"
        import contextlib
        err = io.StringIO()
        with contextlib.redirect_stderr(err), contextlib.redirect_stdout(io.StringIO()):
            code = convert.main(["--dict", str(dict_path),
                                "--csv-dir", str(csv_dir), "--out", str(out_dir)])
        outputs = {}
        if out_dir.exists():
            for path in sorted(out_dir.glob("*.csv")):
                with open(path, newline="", encoding="utf-8-sig") as f:
                    outputs[path.name] = list(csv.reader(f))
        return code, outputs, err.getvalue()
    finally:
        tmp.cleanup()


def rows(outputs, name):
    data = outputs.get(name, [])
    if not data:
        return []
    header = data[0]
    return [dict(zip(header, row)) for row in data[1:]]


# ---------------------------------------------------------------------------
# 字典校验
# ---------------------------------------------------------------------------


def test_duplicate_item_mapping():
    payload = dict_with(versions={"V1": {"columns": [
        {"source_column": "L", "item": "总长", "standard_unit": "mm",
         "factor": "1", "min": "0", "max": "1000"},
        {"source_column": "L2", "item": "总长", "standard_unit": "mm",
         "factor": "1", "min": "0", "max": "1000"},
    ]}})
    expect_dict_error(payload, "重复映射")


def test_duplicate_source_column():
    payload = dict_with(versions={"V1": {"columns": [
        {"source_column": "L", "item": "总长", "standard_unit": "mm",
         "factor": "1", "min": "0", "max": "1000"},
        {"source_column": "L", "item": "宽度", "standard_unit": "mm",
         "factor": "1", "min": "0", "max": "1000"},
    ]}})
    expect_dict_error(payload, "重复映射")


def test_unknown_derived_reference():
    payload = dict_with(derived=[
        {"item": "净长", "standard_unit": "mm", "formula": "{总长} - {不存在}"}
    ])
    expect_dict_error(payload, "未知测量项")


def test_derived_cycle():
    payload = dict_with(derived=[
        {"item": "甲", "standard_unit": "mm", "formula": "{乙} + 1"},
        {"item": "乙", "standard_unit": "mm", "formula": "{甲} + 1"},
    ])
    expect_dict_error(payload, "循环依赖")


def test_derived_self_reference():
    payload = dict_with(derived=[
        {"item": "甲", "standard_unit": "mm", "formula": "{甲} + 1"},
    ])
    expect_dict_error(payload, "循环依赖")


def test_derived_unit_mismatch():
    payload = dict_with(derived=[
        {"item": "净长", "standard_unit": "mm", "formula": "{总长} / 25.4"},
    ])
    payload["versions"]["V1"]["columns"].append(
        {"source_column": "W", "item": "宽度", "standard_unit": "in",
         "factor": "1", "min": "0", "max": "100"})
    payload["tolerances"]["宽度"] = "0.1"
    payload["derived"][0]["formula"] = "{总长} + {宽度}"
    expect_dict_error(payload, "不同单位")


def test_missing_tolerance():
    payload = dict_with(tolerances={})
    expect_dict_error(payload, "缺少允许偏差")


def test_tolerance_on_derived_item():
    payload = dict_with(
        derived=[{"item": "净长", "standard_unit": "mm",
                  "formula": "{总长} - 1"}],
        tolerances={"总长": "0.05", "净长": "0.05"},
    )
    expect_dict_error(payload, "派生项")


def test_standard_unit_conflict_across_versions():
    payload = dict_with(versions={
        "V1": {"columns": [
            {"source_column": "L", "item": "总长", "standard_unit": "mm",
             "factor": "1", "min": "0", "max": "1000"}]},
        "V2": {"columns": [
            {"source_column": "L", "item": "总长", "standard_unit": "in",
             "factor": "1", "min": "0", "max": "1000"}]},
    })
    expect_dict_error(payload, "标准单位不一致")


def test_duplicate_json_key():
    tmp = tempfile.TemporaryDirectory()
    try:
        path = Path(tmp.name) / "d.json"
        path.write_text(
            '{"sample_id_column": "样件号", "round_column": "检测轮次",'
            ' "version_column": "模板版本",'
            ' "tolerances": {"总长": "0.05"},'
            ' "versions": {"V1": {"columns": ['
            '{"source_column": "L", "item": "总长", "standard_unit": "mm",'
            ' "factor": "1", "min": "0", "max": "1000"}]}},'
            ' "versions": {"V2": {"columns": ['
            '{"source_column": "L", "item": "总长", "standard_unit": "mm",'
            ' "factor": "1", "min": "0", "max": "1000"}]}}}',
            encoding="utf-8")
        try:
            convert.load_dictionary(str(path))
        except convert.DictError as e:
            assert "重复键" in str(e), e
        else:
            raise AssertionError("重复 JSON 键应被拒绝")
    finally:
        tmp.cleanup()


def test_bad_formula():
    payload = dict_with(derived=[
        {"item": "净长", "standard_unit": "mm", "formula": "{总长} -"}
    ])
    expect_dict_error(payload, "公式")


def test_unknown_dictionary_field():
    # 拼错的键必须报错，否则配置会被静默忽略
    payload = dict_with(derived=[
        {"item": "净长", "standard_unit": "mm", "formula": "{总长} - 1",
         "formular": "笔误"},
    ])
    expect_dict_error(payload, "未知字段")


def test_unknown_field_in_column_rule():
    payload = dict_with(versions={"V1": {"columns": [
        {"source_column": "L", "item": "总长", "standard_unit": "mm",
         "factor": "1", "min": "0", "max": "1000",
         "tolerance": "0.05"},
    ]}})
    expect_dict_error(payload, "未知字段")


def test_formula_no_eval_surface():
    # 只允许数字、引用、四则运算、括号
    for text in ("__import__('os')", "总长 + 1", "{总长} ** 2", "{总长} % 2"):
        payload = dict_with(derived=[
            {"item": "净长", "standard_unit": "mm", "formula": text}])
        expect_dict_error(payload, "")


# ---------------------------------------------------------------------------
# 合并规则
# ---------------------------------------------------------------------------

DICT_TWO = {
    "sample_id_column": "样件号",
    "round_column": "检测轮次",
    "version_column": "模板版本",
    "default_priority": 0,
    "sources": {"a.csv": 10, "b.csv": 20},
    "tolerances": {"总长": "0.05", "宽度": "0.1"},
    "versions": {
        "V1": {"columns": [
            {"source_column": "L", "item": "总长", "source_unit": "mm",
             "standard_unit": "mm", "factor": "1", "min": "0", "max": "1000"},
            {"source_column": "W", "item": "宽度", "source_unit": "mm",
             "standard_unit": "mm", "factor": "1", "min": "0", "max": "1000"},
        ]},
        "V2": {"columns": [
            {"source_column": "L", "item": "总长", "source_unit": "in",
             "standard_unit": "mm", "factor": "25.4", "min": "0", "max": "1000"},
            {"source_column": "W", "item": "宽度", "source_unit": "in",
             "standard_unit": "mm", "factor": "25.4", "min": "0", "max": "1000"},
        ]},
    },
    "derived": [
        {"item": "净长", "standard_unit": "mm", "formula": "{总长} - 2 * {宽度}"},
    ],
}

HEAD = "样件号,检测轮次,模板版本,L,W\n"


def test_priority_wins_when_within_tolerance():
    code, outputs, _ = run_convert({
        "a.csv": HEAD + "S1,R1,V1,100.0,50.0\n",
        "b.csv": HEAD + "S1,R1,V1,100.03,50.0\n",
    }, DICT_TWO)
    assert code == 0
    got = [r for r in rows(outputs, "measurements.csv") if r["测量项"] == "总长"]
    assert len(got) == 1, got
    assert got[0]["原文件"] == "b.csv", got[0]
    assert got[0]["标准值"] == "100.03", got[0]
    assert int(got[0]["参与比对读数"]) == 2


def test_same_priority_uses_first_file_and_line():
    code, outputs, _ = run_convert({
        "a.csv": HEAD + "S1,R1,V1,100.0,50.0\n",
        "b.csv": HEAD + "S1,R1,V1,100.02,50.0\n",
    }, {**DICT_TWO, "sources": {"a.csv": 5, "b.csv": 5}})
    assert code == 0
    got = [r for r in rows(outputs, "measurements.csv") if r["测量项"] == "总长"]
    assert got[0]["原文件"] == "a.csv", got
    assert got[0]["标准值"] == "100", got  # a.csv 的 100.0


def test_tolerance_boundary_is_inclusive():
    code, outputs, _ = run_convert({
        "a.csv": HEAD + "S1,R1,V1,100.0,50.0\n",
        "b.csv": HEAD + "S1,R1,V1,100.05,50.0\n",
    }, DICT_TWO)
    got = [r for r in rows(outputs, "measurements.csv") if r["测量项"] == "总长"]
    assert got, "差值恰好等于允许偏差时应视为一致"
    assert not [r for r in rows(outputs, "conflicts.csv") if r["测量项"] == "总长"]


def test_over_tolerance_is_conflict():
    code, outputs, _ = run_convert({
        "a.csv": HEAD + "S1,R1,V1,100.0,50.0\n",
        "b.csv": HEAD + "S1,R1,V1,100.06,50.0\n",
    }, DICT_TWO)
    conflicts = rows(outputs, "conflicts.csv")
    l_conf = [r for r in conflicts if r["测量项"] == "总长"]
    assert len(l_conf) == 2, l_conf          # 两个来源都列出，交复核
    assert not [r for r in rows(outputs, "measurements.csv")
                if r["测量项"] == "总长"]
    assert l_conf[0]["最大差"] == "0.06", l_conf[0]


def test_all_sources_kept_when_agree():
    code, outputs, _ = run_convert({
        "a.csv": HEAD + "S1,R1,V1,100.0,50.0\n",
        "b.csv": HEAD + "S1,R1,V1,100.02,50.0\n",
    }, DICT_TWO)
    sources = [r for r in rows(outputs, "sources.csv") if r["测量项"] == "总长"]
    assert len(sources) == 2, sources
    assert {r["原文件"] for r in sources} == {"a.csv", "b.csv"}
    assert sorted(r["是否采用"] for r in sources) == ["否", "是"]
    # 优先级高的排前面
    assert sources[0]["原文件"] == "b.csv", sources


def test_cross_template_units_compare_after_conversion():
    code, outputs, _ = run_convert({
        "a.csv": HEAD + "S1,R1,V1,99.99,50.0\n",
        "b.csv": HEAD + "S1,R1,V2,3.937,1.968504\n",
    }, DICT_TWO)
    got = [r for r in rows(outputs, "measurements.csv") if r["测量项"] == "总长"]
    assert len(got) == 1, got
    assert got[0]["原值"] == "3.937" and got[0]["原单位"] == "in", got[0]
    assert got[0]["标准值"] == "99.9998", got[0]


def test_invalid_readings_do_not_block_others():
    code, outputs, _ = run_convert({
        "a.csv": HEAD + "S1,R1,V1,,50.0\nS2,R1,V1,abc,50.0\n"
                         "S3,R1,V1,100.02,50.0\nS4,R1,V1,1000.1,50.0\n",
        "b.csv": HEAD + "S3,R1,V1,100.0,50.0\n",
    }, DICT_TWO)
    rej = {(r["样件号"], r["测量项"], r["拒收原因"]) for r in rows(outputs, "rejections.csv")}
    assert ("S1", "总长", "空值") in rej, rej
    assert ("S2", "总长", "非数字") in rej, rej
    assert ("S4", "总长", "超范围") in rej, rej
    # S1 的宽度仍应输出
    assert [r for r in rows(outputs, "measurements.csv")
            if r["样件号"] == "S1" and r["测量项"] == "宽度"]
    # S4 的一条读数超范围被剔除；S3 两条读数都在范围内且相差 0.02，不记冲突
    assert not [r for r in rows(outputs, "conflicts.csv") if r["样件号"] == "S3"]


def test_missing_column_reported():
    code, outputs, _ = run_convert({
        "a.csv": "样件号,检测轮次,模板版本,L\nS1,R1,V1,100\n",
    }, DICT_TWO)
    rej = rows(outputs, "rejections.csv")
    assert any(r["拒收原因"] == "缺列" and r["测量项"] == "宽度" for r in rej), rej


def test_unknown_version_and_missing_ids():
    code, outputs, _ = run_convert({
        "a.csv": HEAD + "S1,R1,V9,100.0,50.0\nS2,,V1,100.0,50.0\nR3,,,,\n",
    }, DICT_TWO)
    unknown = rows(outputs, "unknown_versions.csv")
    assert any(r["样件号"] == "S1" and r["原因"] == "未知模板版本"
               for r in unknown), unknown
    assert any(r["原因"] == "缺少模板版本" for r in unknown), unknown
    rej = rows(outputs, "rejections.csv")
    assert any(r["拒收原因"] == "缺少检测轮次" for r in rej), rej


def test_derived_computed_and_traceable():
    code, outputs, _ = run_convert({
        "a.csv": HEAD + "S1,R1,V1,100.4,10.0\n",
        "b.csv": HEAD + "S1,R1,V1,100.38,10.0\n",
    }, DICT_TWO)
    got = [r for r in rows(outputs, "measurements.csv") if r["测量项"] == "净长"]
    assert len(got) == 1, got
    assert got[0]["来源类型"] == "派生"
    assert got[0]["标准值"] == "80.38", got[0]   # 采用 b.csv 的 100.38 - 20
    assert "b.csv:2" in got[0]["输入明细"], got[0]
    assert got[0]["计算式"] == "{总长} - 2 * {宽度}"


def test_derived_chained_reference():
    d = json.loads(json.dumps(DICT_TWO))
    d["derived"] = [
        {"item": "净长", "standard_unit": "mm", "formula": "{总长} - 2 * {宽度}"},
        {"item": "内框长", "standard_unit": "mm", "formula": "{净长} - 2 * {宽度}"},
    ]
    code, outputs, _ = run_convert({
        "a.csv": HEAD + "S1,R1,V1,100.0,10.0\n",
    }, d)
    rows_m = {r["测量项"]: r for r in rows(outputs, "measurements.csv")}
    assert rows_m["净长"]["标准值"] == "80"
    assert rows_m["内框长"]["标准值"] == "60", rows_m["内框长"]
    assert "[派生]" in rows_m["内框长"]["输入明细"]


def test_derived_blocked_by_missing_input():
    code, outputs, _ = run_convert({
        "a.csv": HEAD + "S1,R1,V1,,10.0\n",
    }, DICT_TWO)
    un = rows(outputs, "uncomputable.csv")
    assert len(un) == 1, un
    assert un[0]["测量项"] == "净长"
    assert "总长" in un[0]["阻塞测量项"], un[0]
    assert "空值" in un[0]["原因"], un[0]


def test_derived_blocked_by_conflict():
    code, outputs, _ = run_convert({
        "a.csv": HEAD + "S1,R1,V1,100.0,10.0\n",
        "b.csv": HEAD + "S1,R1,V1,100.5,10.0\n",
    }, DICT_TWO)
    un = rows(outputs, "uncomputable.csv")
    assert any(r["测量项"] == "净长" for r in un), un
    assert "冲突" in un[0]["原因"], un[0]
    assert not [r for r in rows(outputs, "measurements.csv")
                if r["测量项"] == "净长"]


def test_derived_blocked_chain_reports_root_cause():
    d = json.loads(json.dumps(DICT_TWO))
    d["derived"] = [
        {"item": "净长", "standard_unit": "mm", "formula": "{总长} - 2 * {宽度}"},
        {"item": "内框长", "standard_unit": "mm", "formula": "{净长} - 1"},
    ]
    code, outputs, _ = run_convert({
        "a.csv": HEAD + "S1,R1,V1,,10.0\n",
    }, d)
    un = {r["测量项"]: r for r in rows(outputs, "uncomputable.csv")}
    assert un["净长"]["阻塞测量项"] == "总长", un["净长"]
    assert "总长" in un["内框长"]["原因"], un["内框长"]
    assert "空值" in un["内框长"]["原因"], un["内框长"]


def test_item_absent_from_template_blocks_derived():
    d = json.loads(json.dumps(DICT_TWO))
    d["versions"]["V3"] = {"columns": [
        {"source_column": "L", "item": "总长", "standard_unit": "mm",
         "factor": "1", "min": "0", "max": "1000"}]}
    code, outputs, _ = run_convert({
        "a.csv": HEAD + "S1,R1,V3,100.0,10.0\n",
    }, d)
    un = rows(outputs, "uncomputable.csv")
    assert any(r["阻塞测量项"] == "宽度" for r in un), un
    assert "缺测" in un[0]["原因"], un[0]


def test_zero_division_math_error():
    d = json.loads(json.dumps(DICT_TWO))
    d["versions"]["V1"]["columns"].append(
        {"source_column": "Z", "item": "偏移", "standard_unit": "mm",
         "factor": "1", "min": "-1000", "max": "1000"})
    d["tolerances"]["偏移"] = "0.01"
    d["derived"] = [
        {"item": "比值", "standard_unit": "mm", "formula": "{总长} / {偏移}"},
    ]
    head = "样件号,检测轮次,模板版本,L,W,Z\n"
    code, outputs, _ = run_convert({
        "a.csv": head + "S1,R1,V1,100.0,10.0,0\n",
    }, d)
    un = rows(outputs, "uncomputable.csv")
    assert any(r["原因"] == "计算错误：除数为零" for r in un), un
    assert not [r for r in rows(outputs, "measurements.csv")
                if r["测量项"] == "比值"]


def test_output_sorted_by_sample_round_item():
    code, outputs, _ = run_convert({
        "a.csv": HEAD + "S10,R1,V1,100.0,50.0\nS2,R2,V1,100.0,50.0\n"
                         "S2,R1,V1,100.0,50.0\n",
    }, DICT_TWO)
    keys = [(r["样件号"], r["检测轮次"], r["测量项"])
            for r in rows(outputs, "measurements.csv")]
    order = {"总长": 0, "宽度": 1, "净长": 2}
    expected = sorted(keys, key=lambda k: (convert.natural_key(k[0]),
                                           convert.natural_key(k[1]),
                                           order.get(k[2], 99)))
    assert keys == expected, (keys, expected)


def test_decimal_conversion_is_exact():
    assert convert.format_decimal(Decimal("3.937") * Decimal("25.4")) == "99.9998"
    assert convert.format_decimal(Decimal("100.500")) == "100.5"
    assert convert.format_decimal(Decimal("0.000")) == "0"
    assert convert.format_decimal(Decimal("-0.00")) == "0"


def test_formula_parser_precedence():
    ast = formula.parse_formula("{a} + {b} * 2")
    assert formula.evaluate(ast, {"a": Decimal(1), "b": Decimal(3)},
                            convert.CALC_CONTEXT) == Decimal(7)
    ast = formula.parse_formula("( {a} + {b} ) * 2")
    assert formula.evaluate(ast, {"a": Decimal(1), "b": Decimal(3)},
                            convert.CALC_CONTEXT) == Decimal(8)
    ast = formula.parse_formula("-{a}")
    assert formula.evaluate(ast, {"a": Decimal(5)},
                            convert.CALC_CONTEXT) == Decimal(-5)


def test_duplicate_file_name_rejected():
    tmp = tempfile.TemporaryDirectory()
    try:
        work = Path(tmp.name)
        (work / "d1").mkdir()
        (work / "d2").mkdir()
        for sub in ("d1", "d2"):
            (work / sub / "a.csv").write_text(HEAD + "S1,R1,V1,100,50\n",
                                              encoding="utf-8")
        dict_path = work / "dictionary.json"
        dict_path.write_text(json.dumps(DICT_TWO, ensure_ascii=False),
                             encoding="utf-8")
        import contextlib
        err = io.StringIO()
        with contextlib.redirect_stderr(err):
            code = convert.main(["--dict", str(dict_path),
                                 str(work / "d1" / "a.csv"),
                                 str(work / "d2" / "a.csv"),
                                 "--out", str(work / "out")])
        assert code == 2 and "同名" in err.getvalue(), (code, err.getvalue())
    finally:
        tmp.cleanup()


def test_same_file_twice_processed_once():
    tmp = tempfile.TemporaryDirectory()
    try:
        work = Path(tmp.name)
        (work / "samples").mkdir()
        (work / "samples" / "a.csv").write_text(
            HEAD + "S1,R1,V1,100.0,50.0\n", encoding="utf-8")
        dict_path = work / "dictionary.json"
        dict_path.write_text(json.dumps(DICT_TWO, ensure_ascii=False),
                             encoding="utf-8")
        out_dir = work / "out"
        import contextlib
        with contextlib.redirect_stdout(io.StringIO()):
            code = convert.main([
                "--dict", str(dict_path),
                "--csv-dir", str(work / "samples"),
                "--out", str(out_dir),
                str(work / "samples" / "a.csv"),   # 同一文件再显式列出
            ])
        assert code == 0, code
        with open(out_dir / "measurements.csv", newline="",
                  encoding="utf-8-sig") as f:
            data = list(csv.reader(f))
        body = [dict(zip(data[0], row)) for row in data[1:]]
        got = [r for r in body if r["测量项"] == "总长"]
        assert len(got) == 1 and int(got[0]["参与比对读数"]) == 1, got
    finally:
        tmp.cleanup()


def test_real_samples_run():
    tmp = tempfile.TemporaryDirectory()
    try:
        out_dir = Path(tmp.name) / "out"
        import contextlib
        stdout = io.StringIO()
        with contextlib.redirect_stdout(stdout):
            code = convert.main(["--dict", str(ROOT / "dictionary.json"),
                                 "--csv-dir", str(ROOT / "samples"),
                                 "--out", str(out_dir)])
        assert code == 0, stdout.getvalue()

        def load(name):
            with open(out_dir / name, newline="",
                      encoding="utf-8-sig") as f:
                data = list(csv.reader(f))
            return [dict(zip(data[0], row)) for row in data[1:]]

        body = load("measurements.csv")
        conflicts = load("conflicts.csv")
        rejections = load("rejections.csv")
        unknown = load("unknown_versions.csv")

        # S002 的总长在 device_a(100.0) 与 device_c(100.12) 间超出 0.05
        assert any(r["样件号"] == "S002" and r["测量项"] == "总长"
                   for r in conflicts), conflicts
        # S001 总长来自优先级更高的 device_b（英寸模板换算）
        s001 = [r for r in body
                if r["样件号"] == "S001" and r["测量项"] == "总长"]
        assert s001 and s001[0]["原文件"] == "device_b.csv", s001
        assert s001[0]["标准值"] == "100.203", s001
        # 派生项与其他测量项都在
        items = {r["测量项"] for r in body}
        assert {"总长", "宽度", "端部余量", "框边厚", "净长", "净宽"} <= items, items
        # 缺样件号、未知版本分别落进拒收与未知版本清单
        assert any(r["拒收原因"] == "缺少样件号" for r in rejections), rejections
        assert any(r["原因"] == "未知模板版本" for r in unknown), unknown
    finally:
        tmp.cleanup()


TESTS = [
    test_duplicate_item_mapping,
    test_duplicate_source_column,
    test_unknown_derived_reference,
    test_derived_cycle,
    test_derived_self_reference,
    test_derived_unit_mismatch,
    test_missing_tolerance,
    test_tolerance_on_derived_item,
    test_standard_unit_conflict_across_versions,
    test_duplicate_json_key,
    test_bad_formula,
    test_unknown_dictionary_field,
    test_unknown_field_in_column_rule,
    test_formula_no_eval_surface,
    test_priority_wins_when_within_tolerance,
    test_same_priority_uses_first_file_and_line,
    test_tolerance_boundary_is_inclusive,
    test_over_tolerance_is_conflict,
    test_all_sources_kept_when_agree,
    test_cross_template_units_compare_after_conversion,
    test_invalid_readings_do_not_block_others,
    test_missing_column_reported,
    test_unknown_version_and_missing_ids,
    test_derived_computed_and_traceable,
    test_derived_chained_reference,
    test_derived_blocked_by_missing_input,
    test_derived_blocked_by_conflict,
    test_derived_blocked_chain_reports_root_cause,
    test_item_absent_from_template_blocks_derived,
    test_zero_division_math_error,
    test_output_sorted_by_sample_round_item,
    test_decimal_conversion_is_exact,
    test_formula_parser_precedence,
    test_duplicate_file_name_rejected,
    test_same_file_twice_processed_once,
    test_real_samples_run,
]

for fn in TESTS:
    check(fn.__name__, fn)

for name in PASSED:
    print(f"PASS {name}")
for name, reason in FAILED:
    print(f"FAIL {name}: {reason}")
print(f"\n{len(PASSED)} passed, {len(FAILED)} failed")
sys.exit(1 if FAILED else 0)
