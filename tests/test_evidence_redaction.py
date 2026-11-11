# -*- coding: utf-8 -*-
"""证据留存与敏感状态遮盖测试。"""

import json
import os
import tempfile

from collector.config import QueryConfig
from collector.engine import CollectionEngine
from collector.redaction import Redactor
from tests._server_base import SiteServerTestBase


class TestRedaction:

    def test_sensitive_names_are_masked(self):
        redactor = Redactor()
        masked = redactor.redact_mapping({
            "_viewstate": "abc123def4567890",
            "_nonce": "00112233aabbccdd",
            "q": "键盘",
            "category": "电子",
        })
        assert masked["q"] == "键盘"
        assert masked["category"] == "电子"
        assert "abc123def4567890" not in masked["_viewstate"]
        assert "REDACTED" in masked["_viewstate"]
        assert "00112233aabbccdd" not in masked["_nonce"]

    def test_same_value_has_stable_mask(self):
        redactor = Redactor()
        secret = "f" * 32
        assert redactor.mask_value(secret) == redactor.mask_value(secret)

    def test_text_redaction_covers_cookie_and_tokens(self):
        redactor = Redactor()
        text = ("Cookie: ASID=deadbeefcafebabe; "
                "state=0123456789abcdef0123456789abcdef")
        masked = redactor.redact_text(text)
        assert "deadbeefcafebabe" not in masked
        assert "0123456789abcdef0123456789abcdef" not in masked
        assert "REDACTED" in masked


class TestEvidence(SiteServerTestBase):

    def test_request_response_correlation_and_masking_on_disk(self):
        with tempfile.TemporaryDirectory() as tmp:
            engine = CollectionEngine(evidence_dir=tmp)
            config = QueryConfig(
                name="evidence",
                entry_url=self.base_url,
                fields={"q": "", "category": "全部"},
            )
            result = engine.run_one(config)
            self.assertEqual("ok", result["status"])

            path = os.path.join(tmp, "evidence.jsonl")
            with open(path, "r", encoding="utf-8") as fh:
                records = [json.loads(line) for line in fh if line.strip()]

            self.assertGreaterEqual(len(records), 5)  # 入口+查询+3 次翻页
            # 每条记录都带请求编号与链内序号
            for record in records:
                self.assertTrue(record["request_id"].startswith("req-evidence"))
                self.assertIsInstance(record["seq"], int)

            # 请求-响应关联：响应头回传的 request_id 必须与请求编号一致
            http_records = [r for r in records if r["method"] in ("GET", "POST")]
            for record in http_records:
                self.assertEqual(
                    record["request_id"], record["response_request_id"],
                    "请求与响应的 X-Request-Id 必须可关联",
                )

            # 落盘内容不得出现任何真实隐藏状态原文（字段名允许出现）
            for record in records:
                if record.get("form") and "_viewstate" in record["form"]:
                    self.assertIn("REDACTED", record["form"]["_viewstate"])
                    self.assertIn("REDACTED", record["form"]["_nonce"])
                # 响应体中的长令牌也必须被遮盖
                self.assertNotRegex(
                    record["body_excerpt"],
                    r'value="[0-9a-f]{16,}"',
                    "响应摘要中的隐藏状态原文必须遮盖",
                )

    def test_chain_ids_isolate_parallel_evidence(self):
        engine = CollectionEngine()
        configs = [
            QueryConfig(name="a", entry_url=self.base_url,
                        fields={"q": "", "category": "工具"}),
            QueryConfig(name="b", entry_url=self.base_url,
                        fields={"q": "", "category": "电子"}),
        ]
        engine.run_many(configs, max_workers=2)
        all_chain_ids = {r["chain_id"] for r in engine.evidence.all_records()}
        self.assertEqual(2, len(all_chain_ids))
        for prefix in ("chain-a-", "chain-b-"):
            chain = next(cid for cid in all_chain_ids if cid.startswith(prefix))
            records = engine.evidence.records_of_chain(chain)
            self.assertTrue(records)
            # 链内序号连续递增
            seqs = [r["seq"] for r in records]
            self.assertEqual(seqs, sorted(seqs))
            self.assertEqual(len(seqs), len(set(seqs)))
