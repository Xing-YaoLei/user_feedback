# -*- coding: utf-8 -*-
"""HTTP 客户端：每个采集会话独立一个实例，Cookie 互不共享。

基于标准库 http.client 手工管理 Cookie 头，避免高层库在重定向/错误响应
路径下吞掉 Set-Cookie 的问题；请求自动携带 X-Request-Id，响应头回传
同名标识，形成请求-响应关联证据。
"""

import http.client
import uuid
from dataclasses import dataclass
from http.cookies import SimpleCookie
from urllib.parse import urlsplit, urlunsplit


@dataclass
class Response:
    url: str
    status: int
    headers: dict
    body: str
    request_id: str


class HttpClient:
    def __init__(self, timeout: float = 15.0):
        self.timeout = timeout
        # name -> value，仅本会话可见
        self.cookies = {}

    def _split(self, url: str):
        parts = urlsplit(url)
        if not parts.scheme:
            raise ValueError(f"URL 缺少协议：{url}")
        return parts

    def _conn(self, parts):
        if parts.scheme == "https":
            return http.client.HTTPSConnection(parts.hostname, parts.port,
                                               timeout=self.timeout)
        return http.client.HTTPConnection(parts.hostname, parts.port,
                                          timeout=self.timeout)

    def _cookie_header(self):
        return "; ".join(f"{k}={v}" for k, v in self.cookies.items())

    def _store_cookies(self, header_values):
        for raw in header_values:
            jar = SimpleCookie()
            jar.load(raw)
            for key, morsel in jar.items():
                self.cookies[key] = morsel.value

    def _request(self, method: str, url: str, body: bytes = None,
                 content_type: str = None, request_id: str = None) -> Response:
        req_id = request_id or uuid.uuid4().hex
        parts = self._split(url)
        path = urlunsplit(("", "", parts.path or "/", parts.query, ""))
        headers = {
            "X-Request-Id": req_id,
            "Accept-Charset": "utf-8",
            "Host": parts.netloc,
            "Connection": "close",
        }
        cookie_header = self._cookie_header()
        if cookie_header:
            headers["Cookie"] = cookie_header
        if body is not None and content_type:
            headers["Content-Type"] = content_type
            headers["Content-Length"] = str(len(body))

        conn = self._conn(parts)
        try:
            conn.request(method, path, body=body, headers=headers)
            resp = conn.getresponse()
            payload = resp.read().decode("utf-8", errors="replace")
            resp_headers = {k: v for k, v in resp.getheaders()}
            status = resp.status
            # 无论 2xx 还是 4xx，Set-Cookie 都被忠实保存
            self._store_cookies(resp.headers.get_all("Set-Cookie") or [])
        finally:
            conn.close()

        return Response(
            url=url,
            status=status,
            headers=resp_headers,
            body=payload,
            request_id=resp_headers.get("X-Request-Id", req_id),
        )

    def get(self, url: str, request_id: str = None) -> Response:
        return self._request("GET", url, request_id=request_id)

    def post_form(self, url: str, fields: dict, request_id: str = None) -> Response:
        import urllib.parse
        encoded = urllib.parse.urlencode(fields).encode("utf-8")
        return self._request(
            "POST", url, body=encoded,
            content_type="application/x-www-form-urlencoded",
            request_id=request_id,
        )

    def cookie_summary(self):
        return list(self.cookies.keys())
