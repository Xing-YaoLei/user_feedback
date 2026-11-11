"""采集器行为测试（unittest，零第三方依赖）。

运行：python -m unittest discover -s tests -v
"""
import unittest

import catalog_api
import queries
from client import HttpClient, Ref
from db import DB
from harvester import Harvester


class HarvestTestBase(unittest.TestCase):
    server = None
    base_url = None

    @classmethod
    def setUpClass(cls):
        cls.server, cls.base_url = catalog_api.serve()

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()

    def run_harvest(self, roots=None, max_retries=2):
        import urllib.request
        urllib.request.urlopen(self.base_url + "/api/reset").read()  # 重置故障序列
        db = DB(":memory:")
        client = HttpClient(self.base_url)
        if roots is None:
            roots = client.list_datasets()
        run_id, status, stats = Harvester(
            client, db, max_retries=max_retries).harvest(roots)
        return db, run_id, status, stats


class TestHarvest(HarvestTestBase):
    def test_shared_reference_fetched_once_but_edges_kept(self):
        """共享引用：a1/m1 被 ds1、ds2 同时引用，只抓取一次，两条边都保留。"""
        db, run_id, _, _ = self.run_harvest()
        self.assertEqual(db.fetch_count(Ref("author", "a1", 1)), 1)
        self.assertEqual(db.fetch_count(Ref("method", "m1", 1)), 1)
        edges = db.conn.execute(
            "SELECT from_id, to_id, role FROM edges"
            " WHERE to_id='a1' AND role='author'").fetchall()
        self.assertEqual({(e["from_id"], e["role"]) for e in edges},
                         {("ds1", "author"), ("ds2", "author")})

    def test_cycle_terminates(self):
        """循环引用（i1<->m1, a1<->a2）不无限展开，各对象只抓一次。"""
        db, run_id, _, _ = self.run_harvest()
        self.assertEqual(db.fetch_count(Ref("instrument", "i1", 1)), 1)
        self.assertEqual(db.fetch_count(Ref("method", "m1", 1)), 1)
        self.assertEqual(db.fetch_count(Ref("author", "a2", 1)), 1)

    def test_missing_objects_kept_as_unresolved(self):
        """缺失对象：404/410 记为未解析引用，且指向它们的边仍然保留。"""
        db, run_id, _, _ = self.run_harvest()
        gaps = {(g["to_id"], g["reason"]) for g in db.gaps_of_run(run_id)}
        self.assertIn(("aGone", "deleted"), gaps)
        self.assertIn(("iMissing", "not_found"), gaps)
        edge = db.conn.execute(
            "SELECT 1 FROM edges WHERE from_id='ds2' AND to_id='aGone'").fetchone()
        self.assertIsNotNone(edge)

    def test_version_mismatch_not_mixed(self):
        """版本不符：清单 v1 返回 v2 时，payload 不得以 v1 入库，记缺口。"""
        db, run_id, _, _ = self.run_harvest()
        self.assertFalse(db.has_object(Ref("method", "m2", 1)))
        self.assertFalse(db.has_object(Ref("method", "m2", 2)))  # 不偷偷换成 v2
        self.assertFalse(db.has_object(Ref("dataset", "ds4", 1)))
        self.assertFalse(db.has_object(Ref("dataset", "ds4", 2)))
        reasons = {(g["to_id"], g["reason"]) for g in db.gaps_of_run(run_id)}
        self.assertIn(("m2", "version_mismatch"), reasons)
        self.assertIn(("ds4", "version_mismatch"), reasons)

    def test_partial_failure_not_reported_complete(self):
        """局部失败：iDown 永远 500，运行必须是 partial，且无关分支照常入库。"""
        db, run_id, status, _ = self.run_harvest()
        self.assertEqual(status, "partial")
        self.assertNotEqual(status, "complete")
        # 无关分支不受影响
        self.assertTrue(db.has_object(Ref("dataset", "ds1", 1)))
        self.assertTrue(db.has_object(Ref("author", "a1", 1)))
        self.assertTrue(db.has_object(Ref("instrument", "i1", 1)))
        # 失败分支有缺口记录，重试次数 = max_retries+1
        gaps = {(g["to_id"], g["reason"]) for g in db.gaps_of_run(run_id)}
        self.assertIn(("iDown", "fetch_failed"), gaps)
        self.assertEqual(db.fetch_count(Ref("instrument", "iDown", 1)), 3)

    def test_retry_eventually_succeeds(self):
        """iFlaky 前两次 503，第三次成功：有对象、无缺口。"""
        db, run_id, _, _ = self.run_harvest()
        self.assertTrue(db.has_object(Ref("instrument", "iFlaky", 1)))
        self.assertEqual(db.fetch_count(Ref("instrument", "iFlaky", 1)), 3)
        gaps = [g for g in db.gaps_of_run(run_id) if g["to_id"] == "iFlaky"]
        self.assertEqual(gaps, [])

    def test_provenance_query_from_root(self):
        """按根数据集追溯来源：ds1 可达 a1/a2/i1/m1，且环上节点只出现一次。"""
        db, run_id, _, _ = self.run_harvest()
        rows = queries.trace_provenance(db, "dataset", "ds1", 1)
        got = {(r["type"], r["id"]) for r in rows}
        self.assertEqual(got, {("dataset", "ds1"), ("author", "a1"),
                               ("author", "a2"), ("instrument", "i1"),
                               ("method", "m1")})
        ids = [r["id"] for r in rows]
        self.assertEqual(len(ids), len(set(ids)))  # 无重复

    def test_clean_run_reports_complete(self):
        """对照：只采 ds1（无缺失、无失败）时运行必须是 complete。"""
        db, run_id, status, stats = self.run_harvest(
            roots=[Ref("dataset", "ds1", 1)])
        self.assertEqual(status, "complete")
        self.assertEqual(stats["gaps"], 0)


if __name__ == "__main__":
    unittest.main()
