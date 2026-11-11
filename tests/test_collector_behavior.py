# -*- coding: utf-8 -*-
"""采集器端到端行为测试。"""

import threading
import urllib.request

from collector.config import QueryConfig
from collector.engine import CollectionEngine
from collector.evidence import EvidenceLog
from collector.redaction import Redactor
from collector.session import QuerySession, UrlPolicyError
from tests._server_base import SiteServerTestBase


def _config(name, base_url, **overrides):
    params = dict(
        name=name,
        entry_url=base_url,
        form_name="search",
        button_value="search",
        fields={"q": "", "category": "全部"},
        pager_form_name="pager",
        next_button_value="next",
        max_pages=10,
        max_recoveries=2,
    )
    params.update(overrides)
    return QueryConfig(**params)


def _session_cookie(session: QuerySession) -> str:
    cookies = session.http.cookies
    if not cookies:
        return ""
    name, value = next(iter(cookies.items()))
    return f"{name}={value}"


def _records_by_prefix(evidence, prefix: str):
    """chain_id 带短哈希后缀，按前缀取回整条链的证据。"""
    matched = [cid for cid in {r["chain_id"] for r in evidence.all_records()}
               if cid.startswith(prefix)]
    assert len(matched) == 1, f"前缀 {prefix} 匹配到 {matched}"
    return evidence.records_of_chain(matched[0])


def _fire_once(base_url: str, action: str, at_seq: int):
    """构造拦截器：在链内第 at_seq 次请求前触发一次故障注入。

    拦截器运行在 seq 自增之前，因此即将发出的请求编号满足
    session._seq + 1 == at_seq。
    """
    fired = {"done": False}
    lock = threading.Lock()

    def interceptor(_phase, _url, session: QuerySession):
        with lock:
            if fired["done"]:
                return
            cookie = _session_cookie(session)
            # 恢复链的入口 GET 尚无 Cookie，不能也不需要注入；
            # 故障只作用于带会话的回发请求（POST 时 Cookie 必然已建立）。
            # 拦截器在 seq 自增之后运行，因此直接比对当前 _seq。
            if _phase != "before_post" or not cookie:
                return
            if at_seq is not None and session._seq != at_seq:
                return
            fired["done"] = True
        req = urllib.request.Request(
            base_url + f"__test__/{action}",
            data=b"", method="POST", headers={"Cookie": cookie},
        )
        urllib.request.urlopen(req, timeout=10).read()

    return interceptor, fired


class TestCollectorBehavior(SiteServerTestBase):

    def test_full_query_paginates_all_four_pages(self):
        engine = CollectionEngine()
        result = engine.run_one(_config("all", self.base_url))
        self.assertEqual("ok", result["status"])
        self.assertEqual(25, result["row_count"])
        self.assertEqual([1, 2, 3, 4], result["page_seq"])
        self.assertEqual(0, result["recoveries"])
        # 结构化结果字段完整
        first = result["rows"][0]
        self.assertEqual({"id", "pid", "sku", "name", "category", "price"},
                         set(first.keys()))
        # 页内顺序稳定
        ids = [r["id"] for r in result["rows"]]
        self.assertEqual("P001", ids[0])
        self.assertEqual("P025", ids[-1])

    def test_keyword_and_category_filtering(self):
        engine = CollectionEngine()
        result = engine.run_one(_config(
            "elec", self.base_url,
            fields={"q": "", "category": "电子"},
        ))
        self.assertEqual("ok", result["status"])
        self.assertEqual(7, result["row_count"])
        self.assertTrue(all(r["category"] == "电子" for r in result["rows"]))

    def test_expiry_mid_paging_recovers_from_entry(self):
        # 序列：1=GET 入口, 2=POST 查询(第1页), 3=POST 翻页(第2页) ...
        # 在第 4 次请求（翻第 3 页）前作总会话 → 旧状态链失效
        interceptor, fired = _fire_once(self.base_url, "expire", at_seq=4)
        engine = CollectionEngine()
        session = QuerySession(
            _config("expire-mid", self.base_url),
            evidence=engine.evidence, redactor=engine.redactor,
            interceptor=interceptor,
        )
        result = session.collect()
        self.assertTrue(fired["done"], "故障注入应当被触发")
        self.assertEqual("ok", result["status"], result.get("error"))
        self.assertEqual(25, result["row_count"])
        self.assertEqual([1, 2, 3, 4], result["page_seq"])
        self.assertEqual(1, result["recoveries"])
        self.assertEqual(2, result["chain_attempts"])

    def test_expiry_on_first_post_then_recovery_identity_checked(self):
        # 第 2 次请求（首次查询回发）前作总会话
        interceptor, fired = _fire_once(self.base_url, "expire", at_seq=2)
        engine = CollectionEngine()
        session = QuerySession(
            _config("expire-first", self.base_url,
                    fields={"q": "笔", "category": "文具"}),
            evidence=engine.evidence, redactor=engine.redactor,
            interceptor=interceptor,
        )
        result = session.collect()
        self.assertTrue(fired["done"])
        self.assertEqual("ok", result["status"], result.get("error"))
        self.assertEqual(1, result["recoveries"])
        self.assertTrue(all("笔" in r["name"] for r in result["rows"]))

    def test_parallel_queries_keep_independent_state_chains(self):
        engine = CollectionEngine()
        configs = [
            _config("q-tools", self.base_url,
                    fields={"q": "", "category": "工具"}),
            _config("q-elec", self.base_url,
                    fields={"q": "", "category": "电子"}),
            _config("q-paper", self.base_url,
                    fields={"q": "纸", "category": "耗材"}),
        ]
        results = engine.run_many(configs, max_workers=3)
        self.assertEqual(["q-tools", "q-elec", "q-paper"],
                         [r["query"] for r in results])
        for result in results:
            self.assertEqual("ok", result["status"], result.get("error"))

        counts = {r["query"]: r["row_count"] for r in results}
        self.assertEqual(6, counts["q-tools"])
        self.assertEqual(7, counts["q-elec"])
        # “纸”命中 A4 复印纸与标签打印纸两条
        self.assertEqual(2, counts["q-paper"])

        # 服务端访问日志应出现至少 3 个不同会话 Cookie，证明链互不共享
        sids = {e["sid"] for e in self.app.access_log if e["sid"]}
        self.assertGreaterEqual(len(sids), 3)

        # 证据按 chain_id 隔离（slug 带短哈希后缀，按前缀断言）
        chain_ids = {r["chain_id"] for r in engine.evidence.all_records()}
        self.assertEqual(3, len(chain_ids))
        for prefix in ("chain-q-tools-", "chain-q-elec-", "chain-q-paper-"):
            self.assertTrue(
                any(cid.startswith(prefix) for cid in chain_ids),
                f"缺少以 {prefix} 开头的链：{chain_ids}",
            )

    def test_page_order_regression_triggers_recovery(self):
        # 第 3 次请求（第一次翻页）前注入页序回退
        interceptor, fired = _fire_once(self.base_url, "regress", at_seq=3)
        engine = CollectionEngine()
        session = QuerySession(
            _config("regress", self.base_url),
            evidence=engine.evidence, redactor=engine.redactor,
            interceptor=interceptor,
        )
        result = session.collect()
        self.assertTrue(fired["done"])
        self.assertEqual("ok", result["status"], result.get("error"))
        self.assertEqual(1, result["recoveries"])
        self.assertEqual([1, 2, 3, 4], result["page_seq"])
        # 证据中保留了页序回退的现场
        notes = " ".join(
            r.get("note", "") + r.get("body_excerpt", "")
            for r in engine.evidence.all_records()
        )
        self.assertIn("页序", notes)

    def test_identity_mismatch_after_recovery_fails_the_job(self):
        # 全量数据集（4 页），利用翻页制造第二次恢复：
        # 1) 首个查询 POST 前武装全局变异并作总会话 → 第 1 次恢复，
        #    恢复链返回变异身份（X- 前缀），采集器记录为固定身份锚点；
        # 2) 恢复链第一次翻页 POST 前作总会话 → 第 2 次恢复，
        #    同时关闭全局变异，使新链返回正常 ID；
        # 3) 新链首页身份与变异锚点不一致 → 身份校验必须失败。
        stage = {"expired_first": False, "pager_seen": 0,
                 "expired_second": False, "disarmed": False}

        def interceptor(phase, _url, session: QuerySession):
            cookie = _session_cookie(session)
            if not stage["expired_first"]:
                if phase == "before_post" and cookie and session._seq == 2:
                    self.arm_mutate(cookie)
                    self.force_expire(cookie)
                    stage["expired_first"] = True
                return
            if phase == "before_post" and _url.endswith("/pager"):
                stage["pager_seen"] += 1
                if stage["pager_seen"] == 1 and not stage["expired_second"]:
                    # 第一次翻页：关闭变异并作旧，强制第二次恢复
                    self.app.global_mutate = False
                    self.force_expire(cookie)
                    stage["disarmed"] = True
                    stage["expired_second"] = True

        engine = CollectionEngine()
        session = QuerySession(
            _config("mutate", self.base_url, max_recoveries=3),
            evidence=engine.evidence, redactor=engine.redactor,
            interceptor=interceptor,
        )
        result = session.collect()
        self.assertTrue(stage["expired_first"] and stage["expired_second"]
                        and stage["disarmed"])
        self.assertEqual("failed", result["status"])
        self.assertIn("IdentityMismatchError", result["error"])
        self.assertIn("ID 序列不一致", result["error"])

    def test_recovery_budget_is_bounded(self):
        # 每次请求都作总会话，恢复次数耗尽后任务失败而不是无限重试
        def always_expire(_phase, _url, session):
            cookie = _session_cookie(session)
            if not cookie:
                return
            req = urllib.request.Request(
                self.base_url + "__test__/expire",
                data=b"", method="POST", headers={"Cookie": cookie},
            )
            urllib.request.urlopen(req, timeout=10).read()

        engine = CollectionEngine()
        session = QuerySession(
            _config("doomed", self.base_url, max_recoveries=2),
            evidence=engine.evidence, redactor=engine.redactor,
            interceptor=always_expire,
        )
        result = session.collect()
        self.assertEqual("failed", result["status"])
        self.assertEqual(2, result["recoveries"])
        self.assertEqual(3, result["chain_attempts"])

    def test_no_fabricated_paging_urls_allowed(self):
        engine = CollectionEngine()
        session = QuerySession(
            _config("url-policy", self.base_url),
            evidence=EvidenceLog(), redactor=Redactor(),
        )
        # 白名单初始只有入口；任何未由页面提供的地址都被拒绝
        with self.assertRaises(UrlPolicyError):
            session._do_post(self.base_url + "pager", {"btn": "next"},
                             step="fabricated")

        result = engine.run_one(_config("url-ok", self.base_url))
        self.assertEqual("ok", result["status"])
        # 全部请求地址仅限入口与页面表单 action（/query、/pager）
        urls = {r["url"].rstrip("/") for r in
                _records_by_prefix(engine.evidence, "chain-url-ok-")
                if r["method"] in ("GET", "POST")}
        allowed = {self.base_url.rstrip("/"),
                   self.base_url.rstrip("/") + "/query",
                   self.base_url.rstrip("/") + "/pager"}
        self.assertTrue(urls <= allowed, f"出现越界地址：{urls - allowed}")

    def test_button_parameter_must_come_from_page(self):
        # 使用页面上真实存在的 reset 按钮：重置后按全部分类返回
        engine = CollectionEngine()
        result = engine.run_one(_config(
            "reset-btn", self.base_url, button_value="reset",
            fields={"q": "键盘", "category": "电子"},
        ))
        self.assertEqual("ok", result["status"])
        self.assertEqual(25, result["row_count"])  # 重置 → 无条件全量
        # 证据中的按钮参数来自页面按钮定义
        posted = [r for r in
                  _records_by_prefix(engine.evidence, "chain-reset-btn-")
                  if r["method"] == "POST"]
        self.assertTrue(any(r["form"].get("btn") == "reset" for r in posted))
