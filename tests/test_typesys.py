"""类型系统与跨版本转换规则测试。"""

import datetime as dt
import unittest

from ingest.errors import TransformError
from ingest.typesys import convert, is_compatible


class TypeSystemTest(unittest.TestCase):
    def test_string_to_integer_and_float_to_integer(self):
        self.assertEqual(convert("42", "integer"), 42)
        self.assertEqual(convert(3.0, "integer"), 3)

    def test_float_with_fraction_rejected_for_integer(self):
        with self.assertRaises(TransformError) as ctx:
            convert(3.5, "integer")
        self.assertEqual(ctx.exception.reason_code, "type_mismatch")

    def test_numeric_string_to_integer_rejects_garbage(self):
        with self.assertRaises(TransformError):
            convert("12x", "integer")

    def test_boolean_literals_from_csv_strings(self):
        self.assertIs(convert("true", "boolean"), True)
        self.assertIs(convert("FALSE", "boolean"), False)
        self.assertIs(convert("1", "boolean"), True)
        self.assertIs(convert("no", "boolean"), False)
        with self.assertRaises(TransformError):
            convert("maybe", "boolean")

    def test_bool_not_silently_coerced_to_number(self):
        with self.assertRaises(TransformError):
            convert(True, "integer")
        with self.assertRaises(TransformError):
            convert(False, "number")

    def test_datetime_iso_parsing_including_z(self):
        parsed = convert("2026-11-11T08:00:00Z", "datetime")
        self.assertEqual(
            parsed, dt.datetime(2026, 11, 11, 8, 0, tzinfo=dt.UTC)
        )
        with self.assertRaises(TransformError):
            convert("11/11/2026", "datetime")

    def test_json_type_passes_through_any_structure(self):
        payload = {"a": [1, 2], "b": {"c": "d"}}
        self.assertIs(convert(payload, "json"), payload)

    def test_integer_widens_to_number_but_not_reverse(self):
        self.assertTrue(is_compatible("integer", "number"))
        self.assertFalse(is_compatible("number", "integer"))

    def test_boolean_compatibility_matrix(self):
        self.assertTrue(is_compatible("boolean", "string"))
        self.assertFalse(is_compatible("boolean", "integer"))
        # 字符串可经布尔字面量转换，静态视为兼容
        self.assertTrue(is_compatible("string", "boolean"))
        # 布尔不能进时间类型
        self.assertFalse(is_compatible("boolean", "datetime"))

    def test_unknown_source_type_treated_as_runtime_risk(self):
        # 自由 JSON（None 类型声明）预检不拦截，运行时再判定
        self.assertTrue(is_compatible(None, "integer"))
        self.assertTrue(is_compatible(None, "datetime"))


if __name__ == "__main__":
    unittest.main()
