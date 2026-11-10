"""Tests for the type lattice and the explicit merge matrix."""

from __future__ import annotations

from nested2arrow.contract import ConflictPolicy, MergePolicy
from nested2arrow.paths import render
from nested2arrow.typesystem import (
    TArray, TBool, TDecimal, TFloat, TInt, TNull, TObject, TString,
    TTimestamp, decimal_for, merge, widen_decimal,
)


def test_integer_width_promotion_is_explicit_and_widening():
    policy = MergePolicy()
    result = merge(TInt(8), TInt(32), ("x",), policy,
                   allow_new_fields=True, precision_ceiling=38)
    assert result.node == TInt(32)
    assert result.events[0].action == "widened"
    assert "promotion" in result.events[0].detail


def test_integer_promotion_can_be_a_hard_conflict():
    policy = MergePolicy.strict()
    result = merge(TInt(16), TInt(64), ("x",), policy,
                   allow_new_fields=True, precision_ceiling=38)
    assert result.node == TInt(16)  # schema not silently changed
    assert result.events[0].is_conflict
    assert result.events[0].policy is ConflictPolicy.FAIL


def test_decimal_precision_and_scale_widen_without_narrowing():
    a = decimal_for("19.90")
    b = decimal_for("1234.5678")
    widened = widen_decimal(a, b)
    assert (widened.precision, widened.scale) == (8, 4)
    # scale never goes back down
    again = widen_decimal(widened, decimal_for("0.1"))
    assert again == widened


def test_int_merges_into_decimal_exactly():
    result = merge(TInt(64), TDecimal(4, 2), ("amount",), MergePolicy(),
                   allow_new_fields=True, precision_ceiling=38)
    assert isinstance(result.node, TDecimal)
    assert result.node.scale == 2
    assert all(not e.is_conflict for e in result.events)


def test_decimal_float_mixing_never_silently_loses_precision():
    policy = MergePolicy()  # decimal_to_float defaults to FAIL
    result = merge(TDecimal(10, 2), TFloat(), ("amount",), policy,
                   allow_new_fields=True, precision_ceiling=38)
    assert isinstance(result.node, TDecimal)
    assert result.events[0].is_conflict
    assert result.events[0].policy is ConflictPolicy.FAIL


def test_int_to_float_is_a_conflict_by_default():
    result = merge(TInt(32), TFloat(), ("x",), MergePolicy(),
                   allow_new_fields=True, precision_ceiling=38)
    assert result.events[0].is_conflict


def test_boolean_never_coerces_with_numbers_or_strings():
    for other in (TInt(32), TDecimal(5, 2), TString()):
        result = merge(TBool(), other, ("flag",), MergePolicy(),
                       allow_new_fields=True, precision_ceiling=38)
        assert result.events[0].is_conflict


def test_null_absorbs_without_changing_structural_type():
    assert merge(TNull(), TString(), ("x",), MergePolicy(),
                 allow_new_fields=True, precision_ceiling=38).node == TString()
    assert merge(TString(), TNull(), ("x",), MergePolicy(),
                 allow_new_fields=True, precision_ceiling=38).node == TString()


def test_object_vs_array_is_a_shape_conflict():
    result = merge(TObject({"a": TInt(8)}), TArray(TInt(8)), ("x",),
                   MergePolicy(), allow_new_fields=True,
                   precision_ceiling=38)
    assert result.events[0].is_conflict
    assert result.events[0].policy is ConflictPolicy.FAIL


def test_nested_object_field_merges_recursively():
    left = TObject({"meta": TObject({"n": TInt(8)})})
    right = TObject({"meta": TObject({"n": TInt(64)})})
    result = merge(left, right, (), MergePolicy(),
                   allow_new_fields=True, precision_ceiling=38)
    assert result.node.fields["meta"].fields["n"] == TInt(64)


def test_timestamp_timezone_difference_is_documented_widening():
    result = merge(TTimestamp("UTC"), TTimestamp("Asia/Shanghai"),
                   ("t",), MergePolicy(), allow_new_fields=True,
                   precision_ceiling=38)
    assert not result.events[0].is_conflict
    assert result.events[0].action == "widened"


def test_timestamp_vs_plain_string_conflicts():
    result = merge(TTimestamp(), TString(), ("t",), MergePolicy(),
                   allow_new_fields=True, precision_ceiling=38)
    assert result.events[0].is_conflict


def test_decimal_precision_ceiling_enforced():
    big = TDecimal(38, 10)
    bigger = TDecimal(40, 12)
    result = merge(big, bigger, ("x",), MergePolicy(),
                   allow_new_fields=True, precision_ceiling=38)
    assert result.events[0].is_conflict
    assert "ceiling" in result.events[0].detail


def test_render_distinguishes_array_step_from_object_key():
    from nested2arrow.paths import INDEX
    assert render(("a", INDEX, "b")) == "$.a[*].b"
    assert render(("a", "0")) == "$.a.0"
