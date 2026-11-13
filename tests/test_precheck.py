"""导入前预检测试：必填能否补齐、类型是否兼容、不兼容字段与原因。"""

import os
import tempfile
import unittest

from tests.helpers import write_json
from ingest.config import PipelineConfig
from ingest.precheck import run_precheck


class PrecheckTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.cfg_dir = os.path.join(self.tmp, "cfg")

    def _write(self, target, sources, mappings):
        write_json(os.path.join(self.cfg_dir, "target_schema.json"), target)
        write_json(os.path.join(self.cfg_dir, "source_schemas.json"), sources)
        write_json(os.path.join(self.cfg_dir, "mappings.json"), mappings)

    def _base_target(self):
        return {
            "fields": [
                {"name": "event_id", "type": "string", "required": True, "nullable": False},
                {"name": "rating", "type": "integer", "required": False, "nullable": True},
                {"name": "content", "type": "string", "required": False, "nullable": False},
            ]
        }

    def _base_sources(self, message_nullable):
        return {
            "schemas": [
                {
                    "source": "s",
                    "version": "v1",
                    "id_field": "eid",
                    "fields": [
                        {"name": "eid", "type": "string", "required": True, "nullable": False},
                        {"name": "score", "type": "string", "required": False, "nullable": True},
                        {"name": "message", "type": "string", "required": False, "nullable": message_nullable},
                    ],
                }
            ]
        }

    def test_clean_mapping_passes(self):
        self._write(
            self._base_target(),
            self._base_sources(message_nullable=False),
            {
                "mappings": [
                    {
                        "source": "s",
                        "version": "v1",
                        "mapping_version": "m1",
                        "fields": [
                            {"target": "event_id", "source": "eid"},
                            {"target": "rating", "source": "score"},
                            {"target": "content", "source": "message", "default": ""},
                        ],
                    }
                ]
            },
        )
        report = run_precheck(PipelineConfig.load(self.cfg_dir))
        self.assertTrue(report.ok)

    def test_missing_mapping_is_error(self):
        self._write(
            self._base_target(),
            self._base_sources(message_nullable=False),
            {"mappings": []},
        )
        report = run_precheck(PipelineConfig.load(self.cfg_dir))
        pair = report.for_pair("s", "v1")
        self.assertFalse(pair.ok)
        self.assertEqual(pair.errors[0].reason_code, "missing_mapping")

    def test_required_target_without_rule_is_error(self):
        target = self._base_target()
        self._write(
            target,
            self._base_sources(message_nullable=False),
            {
                "mappings": [
                    {
                        "source": "s",
                        "version": "v1",
                        "mapping_version": "m1",
                        "fields": [
                            # 故意不映射必填的 event_id
                            {"target": "content", "source": "message", "default": ""},
                        ],
                    }
                ]
            },
        )
        report = run_precheck(PipelineConfig.load(self.cfg_dir))
        pair = report.for_pair("s", "v1")
        codes = {i.reason_code for i in pair.errors}
        self.assertIn("required_target_unmapped", codes)

    def test_incompatible_static_type_is_error(self):
        self._write(
            self._base_target(),
            {
                "schemas": [
                    {
                        "source": "s",
                        "version": "v1",
                        "id_field": "eid",
                        "fields": [
                            {"name": "eid", "type": "string", "required": True, "nullable": False},
                            {"name": "score", "type": "boolean", "required": False, "nullable": True},
                        ],
                    }
                ]
            },
            {
                "mappings": [
                    {
                        "source": "s",
                        "version": "v1",
                        "mapping_version": "m1",
                        "fields": [
                            {"target": "event_id", "source": "eid"},
                            # boolean -> integer 静态不兼容
                            {"target": "rating", "source": "score"},
                            {"target": "content", "constant": "x"},
                        ],
                    }
                ]
            },
        )
        report = run_precheck(PipelineConfig.load(self.cfg_dir))
        pair = report.for_pair("s", "v1")
        self.assertFalse(pair.ok)
        self.assertTrue(
            any(i.reason_code == "type_incompatible" for i in pair.errors)
        )

    def test_explicit_null_into_non_nullable_is_error(self):
        # 来源 message 可空、目标 content 不可空、有 default：
        # 显式 null 不触发 default，预检必须报 error
        self._write(
            self._base_target(),
            self._base_sources(message_nullable=True),
            {
                "mappings": [
                    {
                        "source": "s",
                        "version": "v1",
                        "mapping_version": "m1",
                        "fields": [
                            {"target": "event_id", "source": "eid"},
                            {"target": "content", "source": "message", "default": ""},
                        ],
                    }
                ]
            },
        )
        report = run_precheck(PipelineConfig.load(self.cfg_dir))
        pair = report.for_pair("s", "v1")
        self.assertFalse(pair.ok)
        self.assertTrue(
            any(i.reason_code == "explicit_null_not_allowed" for i in pair.errors)
        )

    def test_unused_source_field_is_warning_not_error(self):
        self._write(
            self._base_target(),
            self._base_sources(message_nullable=False),
            {
                "mappings": [
                    {
                        "source": "s",
                        "version": "v1",
                        "mapping_version": "m1",
                        "fields": [
                            {"target": "event_id", "source": "eid"},
                            {"target": "content", "source": "message", "default": ""},
                        ],
                    }
                ]
            },
        )
        report = run_precheck(PipelineConfig.load(self.cfg_dir))
        pair = report.for_pair("s", "v1")
        self.assertTrue(pair.ok)  # 警告不阻断
        self.assertTrue(
            any(i.reason_code == "source_field_unused" for i in pair.warnings)
        )


if __name__ == "__main__":
    unittest.main()
