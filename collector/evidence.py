# -*- coding: utf-8 -*-
"""请求-响应关联证据留存。

每条证据记录一次完整交互：请求编号、链编号、链内序号、方法、地址、
表单参数（敏感项已遮盖）、响应状态、回传的请求编号与响应体摘要。
写入 JSONL 文件前所有内容经过 Redactor 遮盖，敏感状态原文不落盘。
"""

import json
import threading


class EvidenceLog:
    def __init__(self, path: str = None, redactor=None):
        self.path = path
        self.redactor = redactor
        self._lock = threading.Lock()
        self._records = []
        if path:
            with open(path, "w", encoding="utf-8"):
                pass  # 截断/预建文件

    def record(self, *, chain_id: str, seq: int, request_id: str, method: str,
               url: str, form: dict = None, status: int = 0,
               response_request_id: str = "", body_excerpt: str = "",
               note: str = ""):
        entry = {
            "chain_id": chain_id,
            "seq": seq,
            "request_id": request_id,
            "method": method,
            "url": url,
            "form": self._safe_form(form),
            "status": status,
            "response_request_id": response_request_id,
            "body_excerpt": self._safe_text(body_excerpt)[:500],
            "note": note,
        }
        with self._lock:
            self._records.append(entry)
            if self.path:
                with open(self.path, "a", encoding="utf-8") as fh:
                    fh.write(json.dumps(entry, ensure_ascii=False) + "\n")
        return entry

    def _safe_form(self, form):
        if form is None:
            return None
        if self.redactor is not None:
            return self.redactor.redact_mapping(form)
        return dict(form)

    def _safe_text(self, text):
        if not text:
            return ""
        if self.redactor is not None:
            return self.redactor.redact_text(text)
        return text

    def all_records(self):
        with self._lock:
            return list(self._records)

    def records_of_chain(self, chain_id: str):
        with self._lock:
            return [r for r in self._records if r["chain_id"] == chain_id]
