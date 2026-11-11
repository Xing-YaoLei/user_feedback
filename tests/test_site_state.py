# -*- coding: utf-8 -*-
"""站点状态机语义测试：一次性隐藏状态、旧状态失败、会话链隔离。"""

import re
import urllib.error
import urllib.request
from http.cookiejar import CookieJar

from tests._server_base import SiteServerTestBase

_VS_RE = re.compile(r'name="_viewstate"\s+value="([^"]+)"')
_NONCE_RE = re.compile(r'name="_nonce"\s+value="([^"]+)"')


def _open_entry(base_url):
    jar = CookieJar()
    opener = urllib.request.build_opener(
        urllib.request.HTTPCookieProcessor(jar)
    )
    html = opener.open(base_url, timeout=10).read().decode("utf-8")
    return opener, jar, html


def _post(opener, url, fields):
    data = urllib.parse.urlencode(fields).encode("utf-8")
    req = urllib.request.Request(
        url, data=data, method="POST",
        headers={"Content-Type": "application/x-www-form-urlencoded"},
    )
    try:
        resp = opener.open(req, timeout=10)
        with resp:
            return resp.status, resp.read().decode("utf-8")
    except urllib.error.HTTPError as exc:
        with exc:
            return exc.code, exc.read().decode("utf-8")


class TestSiteStateSemantics(SiteServerTestBase):

    def test_hidden_state_rotates_on_every_response(self):
        opener, _jar, html1 = _open_entry(self.base_url)
        vs1 = _VS_RE.search(html1).group(1)
        nonce1 = _NONCE_RE.search(html1).group(1)

        html2 = opener.open(self.base_url, timeout=10).read().decode("utf-8")
        vs2 = _VS_RE.search(html2).group(1)
        nonce2 = _NONCE_RE.search(html2).group(1)

        self.assertNotEqual(vs1, vs2, "每次响应后 viewstate 必须轮转")
        self.assertNotEqual(nonce1, nonce2, "每次响应后 nonce 必须轮转")

    def test_stale_state_is_rejected_and_session_killed(self):
        opener, _jar, html = _open_entry(self.base_url)
        vs = _VS_RE.search(html).group(1)
        nonce = _NONCE_RE.search(html).group(1)

        # 第一次回发成功，状态被轮转
        status, body = _post(opener, self.base_url + "query", {
            "_viewstate": vs, "_nonce": nonce,
            "q": "", "category": "全部", "btn": "search",
        })
        self.assertEqual(status, 200)
        self.assertIn('page-type" content="results', body)

        # 复用同一对旧状态必须失败
        status2, body2 = _post(opener, self.base_url + "query", {
            "_viewstate": vs, "_nonce": nonce,
            "q": "", "category": "全部", "btn": "search",
        })
        self.assertEqual(status2, 400)
        self.assertIn('page-type" content="error', body2)
        self.assertIn("作废", body2)

        # 会话已作废：携带旧 Cookie 访问入口会得到一个全新会话（新 Cookie），
        # 新会话的状态与旧链完全无关
        resp3 = opener.open(self.base_url, timeout=10)
        html3 = resp3.read().decode("utf-8")
        new_cookies = resp3.headers.get_all("Set-Cookie") or []
        self.assertTrue(any("ASID=" in c for c in new_cookies),
                        "作废后访问入口必须下发新的会话 Cookie")
        vs3 = _VS_RE.search(html3).group(1)
        nonce3 = _NONCE_RE.search(html3).group(1)
        self.assertNotEqual(vs3, vs)
        # 新会话状态链可正常回发
        status3, body3 = _post(opener, self.base_url + "query", {
            "_viewstate": vs3, "_nonce": nonce3,
            "q": "", "category": "全部", "btn": "search",
        })
        self.assertEqual(200, status3)
        self.assertIn('page-type" content="results', body3)

    def test_separate_sessions_have_independent_state_chains(self):
        opener_a, _ja, html_a = _open_entry(self.base_url)
        opener_b, _jb, html_b = _open_entry(self.base_url)
        vs_a = _VS_RE.search(html_a).group(1)
        nonce_a = _NONCE_RE.search(html_a).group(1)
        vs_b = _VS_RE.search(html_b).group(1)
        self.assertNotEqual(vs_a, vs_b)

        # A 链正常推进
        status, body = _post(opener_a, self.base_url + "query", {
            "_viewstate": vs_a, "_nonce": nonce_a,
            "q": "", "category": "全部", "btn": "search",
        })
        self.assertEqual(status, 200)

        # B 链的状态对 A 的 Cookie 无效（跨链状态不可借用）
        status2, body2 = _post(opener_a, self.base_url + "query", {
            "_viewstate": vs_b, "_nonce": _NONCE_RE.search(html_b).group(1),
            "q": "", "category": "全部", "btn": "search",
        })
        self.assertEqual(status2, 400)
        self.assertIn("viewstate", body2)

    def test_missing_button_parameter_rejected(self):
        opener, _jar, html = _open_entry(self.base_url)
        vs = _VS_RE.search(html).group(1)
        nonce = _NONCE_RE.search(html).group(1)
        status, body = _post(opener, self.base_url + "query", {
            "_viewstate": vs, "_nonce": nonce,
            "q": "", "category": "全部",
        })
        self.assertEqual(status, 400)
        self.assertIn("btn", body)

    def test_decoy_form_action_is_dead_end(self):
        opener, _jar, _html = _open_entry(self.base_url)
        status, body = _post(opener, self.base_url + "dead-end", {"q": "x"})
        self.assertEqual(status, 404)
        self.assertIn("诱饵", body)
