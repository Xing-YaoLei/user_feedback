# -*- coding: utf-8 -*-
"""并行采集引擎。

每个查询在独立线程中运行，各自持有独立 HttpClient / 隐藏状态链；
Redactor 与 EvidenceLog 线程安全，可跨查询共享。
"""

import os
from concurrent.futures import ThreadPoolExecutor, as_completed

from .evidence import EvidenceLog
from .redaction import Redactor
from .session import QuerySession


class CollectionEngine:
    def __init__(self, evidence_dir: str = None, timeout: float = 15.0,
                 interceptors: dict = None):
        self.evidence_dir = evidence_dir
        self.timeout = timeout
        # key=查询名 → 拦截器（测试用故障注入）
        self.interceptors = interceptors or {}
        if evidence_dir:
            os.makedirs(evidence_dir, exist_ok=True)
        self.redactor = Redactor()
        self.evidence = EvidenceLog(
            path=os.path.join(evidence_dir, "evidence.jsonl") if evidence_dir else None,
            redactor=self.redactor,
        )

    def run_one(self, config):
        session = QuerySession(
            config,
            evidence=self.evidence,
            redactor=self.redactor,
            timeout=self.timeout,
            interceptor=self.interceptors.get(config.name),
        )
        return session.collect()

    def run_many(self, configs, max_workers: int = 4):
        results = []
        with ThreadPoolExecutor(max_workers=max_workers) as pool:
            futures = {pool.submit(self.run_one, cfg): cfg for cfg in configs}
            for future in as_completed(futures):
                results.append(future.result())
        order = {cfg.name: i for i, cfg in enumerate(configs)}
        results.sort(key=lambda r: order.get(r["query"], 0))
        return results
