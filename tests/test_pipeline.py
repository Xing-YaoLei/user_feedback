"""端到端流水线测试：批次发布、幂等去重、失败重试、原子提交。"""

import json
import os
import tempfile
import unittest

from tests.helpers import build_config_dir, write_json, write_text
from ingest.config import PipelineConfig
from ingest.pipeline import ingest_batch, retry_failures
from ingest.state import StateStore, iter_jsonl, make_idempotency_key


class PipelineEndToEndTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.cfg_dir = build_config_dir(self.tmp)
        self.config = PipelineConfig.load(self.cfg_dir)
        self.state_dir = os.path.join(self.tmp, "state")
        self.store = StateStore(self.state_dir)
        self.data_dir = os.path.join(self.tmp, "data")

    def _manifest(self, files):
        path = os.path.join(self.data_dir, "manifest.json")
        write_json(path, {"batch_id": "b", "files": files})
        return path

    def _read_jsonl(self, run_dir, name):
        return list(iter_jsonl(os.path.join(run_dir, name)))

    def test_successful_batch_publishes_unified_and_manifest(self):
        support = os.path.join(self.data_dir, "support.jsonl")
        write_text(
            support,
            "\n".join(
                [
                    json.dumps(
                        {
                            "ticket_id": "T1",
                            "src": "support",
                            "ver": "v1",
                            "customer_id": "U1",
                            "created_at": "2026-11-10T09:00:00+08:00",
                            "rating": 5,
                        }
                    ),
                ]
            ),
        )
        manifest = self._manifest([{"path": "support.jsonl"}])
        result = ingest_batch(manifest, self.config, self.store)

        self.assertEqual(result.stats["published"], 1)
        self.assertEqual(result.stats["failed"], 0)
        current = self.store.current_run_dir()
        unified = self._read_jsonl(current, "unified.jsonl")
        self.assertEqual(len(unified), 1)
        self.assertEqual(unified[0]["_event_id"], "T1")
        self.assertEqual(unified[0]["_mapping_version"], "support-v1-1")
        # 累计台账与本批快照一致
        ledger = self._read_jsonl(current, "published.jsonl")
        self.assertEqual(len(ledger), 1)

    def test_failures_record_source_position_reason_and_raw(self):
        support = os.path.join(self.data_dir, "support.jsonl")
        write_text(
            support,
            json.dumps(
                {
                    "ticket_id": "T2",
                    "src": "support",
                    "ver": "v1",
                    "customer_id": "U2",
                    "created_at": "2026-11-10T09:00:00+08:00",
                    "rating": "garbage",
                }
            ),
        )
        manifest = self._manifest([{"path": "support.jsonl"}])
        result = ingest_batch(manifest, self.config, self.store)
        self.assertEqual(result.stats["failed"], 1)

        current = self.store.current_run_dir()
        failures = self._read_jsonl(current, "failures.jsonl")
        self.assertEqual(len(failures), 1)
        f = failures[0]
        self.assertEqual(f["source"], "support")
        self.assertEqual(f["version"], "v1")
        self.assertEqual(f["event_id"], "T2")
        self.assertEqual(f["reason_code"], "source_type_mismatch")
        self.assertIn("line 1", f["position"])
        # 原始记录被完整保存，供无原文件重试
        self.assertEqual(f["raw_record"]["ticket_id"], "T2")

        pending = self._read_jsonl(current, "pending_failures.jsonl")
        self.assertEqual(len(pending), 1)

    def test_duplicate_event_published_only_once_and_content_retained(self):
        support = os.path.join(self.data_dir, "support.jsonl")
        record = {
            "ticket_id": "T3",
            "src": "support",
            "ver": "v1",
            "customer_id": "U3",
            "created_at": "2026-11-10T09:00:00+08:00",
            "rating": 5,
            "message": "原始内容",
        }
        write_text(support, json.dumps(record))
        manifest = self._manifest([{"path": "support.jsonl"}])
        ingest_batch(manifest, self.config, self.store)

        # 上游重发，同一事件编号但内容被改动
        changed = dict(record, rating=1, message="被改动的内容")
        write_text(support, json.dumps(changed))
        result2 = ingest_batch(manifest, self.config, self.store)
        self.assertEqual(result2.stats["duplicates"], 1)
        self.assertEqual(result2.stats["published"], 0)
        self.assertEqual(len(result2.content_drift), 1)

        current = self.store.current_run_dir()
        ledger = self._read_jsonl(current, "published.jsonl")
        self.assertEqual(len(ledger), 1)  # 仍然只有一条
        self.assertEqual(ledger[0]["record"]["rating"], 5)  # 首次内容
        self.assertEqual(ledger[0]["record"]["content"], "原始内容")
        self.assertEqual(ledger[0]["mapping_version"], "support-v1-1")

    def test_retry_only_reprocesses_failures_and_removes_on_success(self):
        support = os.path.join(self.data_dir, "support.jsonl")
        bad = {
            "ticket_id": "T4",
            "src": "support",
            "ver": "v1",
            "customer_id": "U4",
            "created_at": "2026-11-10T09:00:00+08:00",
            "rating": "garbage",
        }
        good = {
            "ticket_id": "T5",
            "src": "support",
            "ver": "v1",
            "customer_id": "U5",
            "created_at": "2026-11-10T09:00:00+08:00",
            "rating": 3,
        }
        write_text(support, "\n".join(json.dumps(r) for r in (bad, good)))
        manifest = self._manifest([{"path": "support.jsonl"}])
        ingest_batch(manifest, self.config, self.store)

        # 修正配置：放宽来源 rating 为 string + on_error=set_null
        self._loosen_rating_with_set_null()
        revised = PipelineConfig.load(self.cfg_dir)
        result = retry_failures(revised, self.store)

        self.assertEqual(result.stats["retried"], 1)  # 只重试失败的 T4
        self.assertEqual(result.stats["retry_succeeded"], 1)
        current = self.store.current_run_dir()
        pending = self._read_jsonl(current, "pending_failures.jsonl")
        self.assertEqual(pending, [])  # 成功后移出待处理清单
        ledger = self._read_jsonl(current, "published.jsonl")
        keys = {row["idempotency_key"] for row in ledger}
        self.assertIn(make_idempotency_key("support", "T4"), keys)
        # T4 使用修正后的映射版本
        t4 = next(
            row for row in ledger if row["idempotency_key"].endswith("T4")
        )
        self.assertEqual(t4["mapping_version"], "support-v1-2")
        self.assertIsNone(t4["record"]["rating"])

    def test_retry_failure_keeps_entry_and_increments_attempts(self):
        support = os.path.join(self.data_dir, "support.jsonl")
        write_text(
            support,
            json.dumps(
                {
                    "ticket_id": "T6",
                    "src": "support",
                    "ver": "v1",
                    "customer_id": "U6",
                    "created_at": "2026-11-10T09:00:00+08:00",
                    "rating": "garbage",
                }
            ),
        )
        manifest = self._manifest([{"path": "support.jsonl"}])
        ingest_batch(manifest, self.config, self.store)
        # 不修正配置直接重试，仍然失败
        result = retry_failures(self.config, self.store)
        self.assertEqual(result.stats["retry_failed"], 1)
        current = self.store.current_run_dir()
        pending = self._read_jsonl(current, "pending_failures.jsonl")
        self.assertEqual(len(pending), 1)
        self.assertEqual(pending[0]["attempts"], 2)

    def test_retry_works_after_original_file_is_removed(self):
        # 待处理清单保存了原始记录副本，原文件被移走也应能重试
        support = os.path.join(self.data_dir, "support.jsonl")
        write_text(
            support,
            json.dumps(
                {
                    "ticket_id": "T61",
                    "src": "support",
                    "ver": "v1",
                    "customer_id": "U61",
                    "created_at": "2026-11-10T09:00:00+08:00",
                    "rating": "garbage",
                }
            ),
        )
        manifest = self._manifest([{"path": "support.jsonl"}])
        ingest_batch(manifest, self.config, self.store)
        # 模拟原数据文件已被归档/删除
        os.remove(support)
        self.assertFalse(os.path.exists(support))

        self._loosen_rating_with_set_null()
        revised = PipelineConfig.load(self.cfg_dir)
        result = retry_failures(revised, self.store)
        self.assertEqual(result.stats["retry_succeeded"], 1)
        current = self.store.current_run_dir()
        pending = self._read_jsonl(current, "pending_failures.jsonl")
        self.assertEqual(pending, [])
        # 原始位置仍保留在发布记录里，便于追溯
        ledger = self._read_jsonl(current, "published.jsonl")
        t61 = next(
            row for row in ledger if row["idempotency_key"].endswith("T61")
        )
        self.assertIn("support.jsonl", t61["raw_position"])

    def test_interrupted_run_keeps_current_on_previous_complete_result(self):
        support = os.path.join(self.data_dir, "support.jsonl")
        write_text(
            support,
            json.dumps(
                {
                    "ticket_id": "T7",
                    "src": "support",
                    "ver": "v1",
                    "customer_id": "U7",
                    "created_at": "2026-11-10T09:00:00+08:00",
                    "rating": 5,
                }
            ),
        )
        manifest = self._manifest([{"path": "support.jsonl"}])
        first = ingest_batch(manifest, self.config, self.store)
        good_current = self.store.current_run_dir()

        # 在 commit 内部、切换 current 之前中断
        from ingest import state as state_mod

        real_commit = state_mod.OpenRun.commit

        def crashing_commit(self_run):
            partial = os.path.join(self_run.run_dir, "unified.jsonl")
            with open(partial, "w", encoding="utf-8") as fh:
                fh.write("{}\n")
            raise KeyboardInterrupt("模拟中断")

        state_mod.OpenRun.commit = crashing_commit
        try:
            with self.assertRaises(KeyboardInterrupt):
                ingest_batch(manifest, self.config, self.store)
        finally:
            state_mod.OpenRun.commit = real_commit

        # current 没有变化，下游读到的仍是第一个完整 run
        self.assertEqual(self.store.current_run_dir(), good_current)
        ledger = self._read_jsonl(good_current, "published.jsonl")
        self.assertEqual(len(ledger), 1)

    def test_each_run_is_self_contained_snapshot(self):
        support = os.path.join(self.data_dir, "support.jsonl")
        write_text(
            support,
            json.dumps(
                {
                    "ticket_id": "T8",
                    "src": "support",
                    "ver": "v1",
                    "customer_id": "U8",
                    "created_at": "2026-11-10T09:00:00+08:00",
                    "rating": 5,
                }
            ),
        )
        manifest = self._manifest([{"path": "support.jsonl"}])
        ingest_batch(manifest, self.config, self.store)
        run1 = self.store.current_run_dir()

        write_text(
            support,
            json.dumps(
                {
                    "ticket_id": "T9",
                    "src": "support",
                    "ver": "v1",
                    "customer_id": "U9",
                    "created_at": "2026-11-10T09:00:00+08:00",
                    "rating": 2,
                }
            ),
        )
        ingest_batch(manifest, self.config, self.store)
        run2 = self.store.current_run_dir()

        # 新 run 的累计台账包含两条，且 run1 目录内容保持不变
        self.assertEqual(
            len(self._read_jsonl(run2, "published.jsonl")), 2
        )
        self.assertEqual(
            len(self._read_jsonl(run1, "published.jsonl")), 1
        )
        # 新 run 的本批快照只含当批新记录
        self.assertEqual(
            len(self._read_jsonl(run2, "unified.jsonl")), 1
        )

    def test_mixed_json_and_csv_batch_uses_per_record_mapping(self):
        support = os.path.join(self.data_dir, "support.jsonl")
        orders = os.path.join(self.data_dir, "orders.csv")
        write_text(
            support,
            json.dumps(
                {
                    "ticket_id": "M1",
                    "src": "support",
                    "ver": "v1",
                    "customer_id": "U1",
                    "created_at": "2026-11-10T09:00:00+08:00",
                    "rating": 5,
                }
            ),
        )
        write_text(
            orders,
            "order_event_id,buyer_id,event_ts,event_name,remark,payload\n"
            'M2,B2,2026-11-10T10:00:00+08:00,order_paid,,"{""amount"": 10}"\n',
        )
        manifest = self._manifest(
            [
                {"path": "support.jsonl"},
                {"path": "orders.csv", "source": "orders", "version": "v1"},
            ]
        )
        result = ingest_batch(manifest, self.config, self.store)
        self.assertEqual(result.stats["published"], 2)
        current = self.store.current_run_dir()
        unified = self._read_jsonl(current, "unified.jsonl")
        by_id = {row["_event_id"]: row for row in unified}
        # 两条记录各自选用自己来源版本的映射版本号
        self.assertEqual(by_id["M1"]["_mapping_version"], "support-v1-1")
        self.assertEqual(by_id["M2"]["_mapping_version"], "orders-v1-1")
        # CSV 的 json 字段被解析成结构
        self.assertEqual(by_id["M2"]["extra"], {"amount": 10})
        # 订单没有 channel/rating 概念，drop 后为 null
        self.assertIsNone(by_id["M2"]["rating"])

    def test_explicit_null_is_not_overwritten_by_default_end_to_end(self):
        # content 映射带 default ""，但显式 null 必须保留为 null
        support = os.path.join(self.data_dir, "support.jsonl")
        write_text(
            support,
            json.dumps(
                {
                    "ticket_id": "N1",
                    "src": "support",
                    "ver": "v1",
                    "customer_id": "U1",
                    "created_at": "2026-11-10T09:00:00+08:00",
                    "message": None,
                }
            ),
        )
        manifest = self._manifest([{"path": "support.jsonl"}])
        ingest_batch(manifest, self.config, self.store)
        current = self.store.current_run_dir()
        unified = self._read_jsonl(current, "unified.jsonl")
        self.assertIsNone(unified[0]["content"])  # 不是 default 的 ""

    def _loosen_rating_with_set_null(self):
        src_path = os.path.join(self.cfg_dir, "source_schemas.json")
        with open(src_path, encoding="utf-8") as fh:
            sources = json.load(fh)
        for s in sources["schemas"]:
            if s["source"] == "support":
                for f in s["fields"]:
                    if f["name"] == "rating":
                        f["type"] = "string"
        write_json(src_path, sources)

        mapping_path = os.path.join(self.cfg_dir, "mappings.json")
        with open(mapping_path, encoding="utf-8") as fh:
            mappings = json.load(fh)
        for m in mappings["mappings"]:
            if m["source"] == "support":
                m["mapping_version"] = "support-v1-2"
                for f in m["fields"]:
                    if f["target"] == "rating":
                        f["on_error"] = "set_null"
        write_json(mapping_path, mappings)


if __name__ == "__main__":
    unittest.main()
