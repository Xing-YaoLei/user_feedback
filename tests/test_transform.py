"""单条记录转换语义测试：缺失补默认、显式 null 校验、CSV 转换、容错。"""

import json
import tempfile
import unittest

from tests.helpers import load_test_config
from ingest.errors import TransformError
from ingest.readers import RawRecord
from ingest.transform import transform_record


class TransformSemanticsTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.config = load_test_config(self.tmp)

    def _json_raw(self, record, source_file="x.jsonl", position="line 1"):
        return RawRecord(
            record=record,
            source_file=source_file,
            position=position,
            fmt="jsonl",
        )

    def test_missing_field_uses_default_but_explicit_null_does_not(self):
        # 缺失 message：补 default ""
        raw_missing = self._json_raw(
            {
                "ticket_id": "T1",
                "src": "support",
                "ver": "v1",
                "customer_id": "U1",
                "created_at": "2026-11-10T09:00:00+08:00",
            }
        )
        out_missing = transform_record(raw_missing, self.config)
        self.assertEqual(out_missing.unified["content"], "")

        # 显式 null：default 不生效，按目标可空性保留 null
        raw_null = self._json_raw(
            {
                "ticket_id": "T2",
                "src": "support",
                "ver": "v1",
                "customer_id": "U2",
                "created_at": "2026-11-10T09:00:00+08:00",
                "message": None,
            }
        )
        out_null = transform_record(raw_null, self.config)
        self.assertIsNone(out_null.unified["content"])

    def test_csv_empty_cell_is_treated_as_missing_not_null(self):
        raw = RawRecord(
            record={
                "order_event_id": "O1",
                "buyer_id": "B1",
                "event_ts": "2026-11-10T09:00:00+08:00",
                "event_name": "order_paid",
                # remark 空单元格已在读取层被剔除（缺失）
            },
            source_file="o.csv",
            position="row 2",
            fmt="csv",
            file_source="orders",
            file_version="v1",
        )
        out = transform_record(raw, self.config)
        # 缺失走 default
        self.assertEqual(out.unified["content"], "")

    def test_csv_string_rating_converted_to_integer(self):
        # 用 support 来源，但 CSV 里 rating 是字符串；schema 声明 integer
        raw = RawRecord(
            record={
                "ticket_id": "T9",
                "customer_id": "U9",
                "created_at": "2026-11-10T09:00:00+08:00",
                "rating": "4",
            },
            source_file="s.csv",
            position="row 2",
            fmt="csv",
            file_source="support",
            file_version="v1",
        )
        out = transform_record(raw, self.config)
        self.assertEqual(out.unified["rating"], 4)
        self.assertIsInstance(out.unified["rating"], int)

    def test_csv_json_field_parsed_to_structure(self):
        raw = RawRecord(
            record={
                "order_event_id": "O2",
                "buyer_id": "B2",
                "event_ts": "2026-11-10T09:00:00+08:00",
                "event_name": "order_placed",
                "payload": '{"amount": 100, "items": [1, 2]}',
            },
            source_file="o.csv",
            position="row 3",
            fmt="csv",
            file_source="orders",
            file_version="v1",
        )
        out = transform_record(raw, self.config)
        self.assertEqual(
            out.unified["extra"], {"amount": 100, "items": [1, 2]}
        )

    def test_bad_csv_json_field_fails_with_position_context(self):
        raw = RawRecord(
            record={
                "order_event_id": "O3",
                "buyer_id": "B3",
                "event_ts": "2026-11-10T09:00:00+08:00",
                "event_name": "order_placed",
                "payload": "{not-json}",
            },
            source_file="o.csv",
            position="row 4",
            fmt="csv",
            file_source="orders",
            file_version="v1",
        )
        with self.assertRaises(TransformError) as ctx:
            transform_record(raw, self.config)
        self.assertEqual(ctx.exception.reason_code, "type_mismatch")
        self.assertEqual(ctx.exception.source, "orders")
        self.assertEqual(ctx.exception.event_id, "O3")

    def test_json_wrong_declared_type_fails_at_source_coercion(self):
        raw = self._json_raw(
            {
                "ticket_id": "T3",
                "src": "support",
                "ver": "v1",
                "customer_id": "U3",
                "created_at": "2026-11-10T09:00:00+08:00",
                "rating": "not-a-number",  # schema 声明 integer
            }
        )
        with self.assertRaises(TransformError) as ctx:
            transform_record(raw, self.config)
        self.assertEqual(ctx.exception.reason_code, "source_type_mismatch")
        self.assertEqual(ctx.exception.event_id, "T3")

    def test_missing_event_id_raises_and_is_captured(self):
        raw = self._json_raw(
            {
                "ticket_id": "",
                "src": "support",
                "ver": "v1",
                "customer_id": "U4",
                "created_at": "2026-11-10T09:00:00+08:00",
            }
        )
        with self.assertRaises(TransformError) as ctx:
            transform_record(raw, self.config)
        self.assertEqual(ctx.exception.reason_code, "missing_event_id")

    def test_unknown_source_version_fails(self):
        raw = self._json_raw(
            {
                "ticket_id": "T4",
                "src": "support",
                "ver": "v99",
                "customer_id": "U4",
                "created_at": "2026-11-10T09:00:00+08:00",
            }
        )
        with self.assertRaises(TransformError) as ctx:
            transform_record(raw, self.config)
        self.assertEqual(ctx.exception.reason_code, "unsupported_source_version")

    def test_provenance_meta_preserved(self):
        raw = self._json_raw(
            {
                "ticket_id": "T5",
                "src": "support",
                "ver": "v1",
                "customer_id": "U5",
                "created_at": "2026-11-10T09:00:00+08:00",
            }
        )
        out = transform_record(raw, self.config)
        self.assertEqual(out.event_id, "T5")
        self.assertEqual(out.mapping_version, "support-v1-1")
        self.assertEqual(out.unified["_source"], "support")
        self.assertEqual(out.unified["_version"], "v1")
        self.assertEqual(out.unified["_event_id"], "T5")
        self.assertEqual(out.unified["_mapping_version"], "support-v1-1")
        self.assertIn("x.jsonl :: line 1", out.unified["_raw_position"])

    def test_on_error_set_null_downgrades_dirty_value(self):
        # 复用已生成的配置目录，改写映射与来源 schema
        import os

        from tests.helpers import write_json

        cfg_dir = os.path.join(self.tmp, "config")
        mapping_path = os.path.join(cfg_dir, "mappings.json")
        with open(mapping_path, encoding="utf-8") as fh:
            mappings = json.load(fh)
        for m in mappings["mappings"]:
            if m["source"] == "support":
                for f in m["fields"]:
                    if f["target"] == "rating":
                        f["on_error"] = "set_null"
        # 来源 rating 放宽为 string，使脏值进入目标转换阶段
        src_path = os.path.join(cfg_dir, "source_schemas.json")
        with open(src_path, encoding="utf-8") as fh:
            sources = json.load(fh)
        for s in sources["schemas"]:
            if s["source"] == "support":
                for f in s["fields"]:
                    if f["name"] == "rating":
                        f["type"] = "string"
        write_json(mapping_path, mappings)
        write_json(src_path, sources)

        from ingest.config import PipelineConfig

        config = PipelineConfig.load(cfg_dir)
        raw = self._json_raw(
            {
                "ticket_id": "T6",
                "src": "support",
                "ver": "v1",
                "customer_id": "U6",
                "created_at": "2026-11-10T09:00:00+08:00",
                "rating": "not-a-number",
            }
        )
        out = transform_record(raw, config)
        self.assertIsNone(out.unified["rating"])


if __name__ == "__main__":
    unittest.main()
