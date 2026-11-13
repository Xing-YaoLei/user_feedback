"""批次编排：导入新数据、仅重试失败记录、状态查询。

处理流程（ingest）：
1. 读取批次清单，逐文件逐记录读取；
2. 解析来源/版本，做配置级预检（不兼容的来源版本直接失败，不再逐字段试错）；
3. 查台账：已发布的同幂等键记录直接跳过，保留原内容与映射版本；
4. 未发布记录走映射转换，成功写入本批统一明细并入累计台账；
   失败写入失败记录（含来源、原始位置、原因）并入待处理清单；
5. 全部处理完一次性原子提交，下游看到的永远是完整批次。

retry-failures 不读外部输入，只从待处理清单取记录重跑；重试成功即移出
待处理清单，重试失败则保留并累加尝试次数。
"""

from __future__ import annotations

import json
import os
from dataclasses import dataclass, field
from typing import Any

from .config import PipelineConfig
from .errors import IngestError, TransformError
from .precheck import PrecheckReport, run_precheck
from .readers import RawRecord, read_file
from .state import (
    FailureEntry,
    LedgerEntry,
    OpenRun,
    StateStore,
    make_idempotency_key,
    _now_iso,
)
from .transform import source_hash, transform_record


@dataclass
class BatchResult:
    run_id: str
    mode: str
    stats: dict[str, Any]
    run_dir: str
    precheck: dict[str, Any]
    # 本 run 内重复发送但内容发生变化的幂等键（仅提示，不阻断）
    content_drift: list[dict[str, str]] = field(default_factory=list)


def load_manifest(manifest_path: str) -> dict[str, Any]:
    with open(manifest_path, encoding="utf-8") as fh:
        manifest = json.load(fh)
    if not isinstance(manifest, dict) or not isinstance(
        manifest.get("files"), list
    ):
        raise IngestError(
            f"批次清单 {manifest_path} 格式非法，需要顶层对象且含 files 数组"
        )
    return manifest


def _resolve_file_path(manifest_path: str, file_entry: str | dict[str, Any]) -> str:
    if isinstance(file_entry, str):
        rel = file_entry
    elif isinstance(file_entry, dict):
        rel = file_entry.get("path", "")
    else:
        raise IngestError(f"批次清单中的文件条目非法：{file_entry!r}")
    if not rel:
        raise IngestError(f"批次清单中的文件条目缺少 path：{file_entry!r}")
    base_dir = os.path.dirname(os.path.abspath(manifest_path))
    candidate = rel if os.path.isabs(rel) else os.path.join(base_dir, rel)
    if not os.path.isfile(candidate):
        raise IngestError(f"批次清单引用的数据文件不存在：{candidate}")
    return candidate


def _file_settings(file_entry: str | dict[str, Any]) -> dict[str, Any]:
    if isinstance(file_entry, dict):
        return {
            "format": file_entry.get("format"),
            "source": file_entry.get("source"),
            "version": file_entry.get("version"),
        }
    return {"format": None, "source": None, "version": None}


def ingest_batch(
    manifest_path: str,
    config: PipelineConfig,
    store: StateStore,
) -> BatchResult:
    """执行一次完整批次导入。"""
    manifest = load_manifest(manifest_path)
    precheck_report = run_precheck(config)
    run = store.begin_run(mode="ingest")
    drift: list[dict[str, str]] = []
    try:
        for file_entry in manifest["files"]:
            path = _resolve_file_path(manifest_path, file_entry)
            settings = _file_settings(file_entry)
            for raw in read_file(
                path,
                fmt=settings["format"],
                file_source=settings["source"],
                file_version=settings["version"],
            ):
                _process_one(
                    raw,
                    config,
                    store,
                    run,
                    precheck_report,
                    drift,
                    mode="ingest",
                )
        run.commit()
    except BaseException:
        # 任何异常（含中途退出）都不提交：current 保持指向上一个完整 run
        _rollback(run)
        raise
    return BatchResult(
        run_id=run.run_id,
        mode="ingest",
        stats=run.stats.to_dict(),
        run_dir=run.run_dir,
        precheck=precheck_report.to_dict(),
        content_drift=drift,
    )


def retry_failures(
    config: PipelineConfig,
    store: StateStore,
    *,
    only_keys: set[str] | None = None,
) -> BatchResult:
    """只重试待处理清单里的失败记录；成功的记录不参与，也不会被重发。"""
    pending = store.load_pending()
    if only_keys is not None:
        pending = {k: v for k, v in pending.items() if k in only_keys}
    precheck_report = run_precheck(config)
    run = store.begin_run(mode="retry-failures")
    drift: list[dict[str, str]] = []
    run.stats.retried = len(pending)
    try:
        for entry in sorted(pending.values(), key=lambda e: e.idempotency_key):
            raw = RawRecord(
                record=dict(entry.raw_record),
                source_file=entry.source_file,
                position=entry.position,
                fmt=entry.fmt,
                file_source=entry.file_source,
                file_version=entry.file_version,
            )
            # 重试时强制使用失败时记录的来源/版本，保证映射选择稳定
            _process_one(
                raw,
                config,
                store,
                run,
                precheck_report,
                drift,
                mode="retry",
                override_source=entry.source,
                override_version=entry.version,
                prior_attempts=entry.attempts,
            )
        run.commit()
    except BaseException:
        _rollback(run)
        raise
    return BatchResult(
        run_id=run.run_id,
        mode="retry-failures",
        stats=run.stats.to_dict(),
        run_dir=run.run_dir,
        precheck=precheck_report.to_dict(),
        content_drift=drift,
    )


# ---------------------------------------------------------------------------
# 单条记录处理
# ---------------------------------------------------------------------------

def _process_one(
    raw: RawRecord,
    config: PipelineConfig,
    store: StateStore,
    run: OpenRun,
    precheck_report: PrecheckReport,
    drift: list[dict[str, str]],
    *,
    mode: str,
    override_source: str | None = None,
    override_version: str | None = None,
    prior_attempts: int = 1,
) -> None:
    run.stats.received += 1
    try:
        result = transform_record(
            raw,
            config,
            override_source=override_source,
            override_version=override_version,
        )
    except TransformError as exc:
        _handle_failure(
            raw,
            exc,
            run,
            mode,
            override_source=override_source,
            override_version=override_version,
            prior_attempts=prior_attempts,
        )
        return

    key = make_idempotency_key(result.source, result.event_id)

    # 幂等：同一来源的同一事件只发布一次
    existing = run.ledger_entry(key)
    if existing is not None:
        run.stats.duplicates += 1
        if existing.source_hash != result.source_hash:
            drift.append(
                {
                    "idempotency_key": key,
                    "published_hash": existing.source_hash,
                    "received_hash": result.source_hash,
                    "note": "重复发送的内容与已发布记录不同，已保留首次发布内容",
                }
            )
        return

    # 预检层面的硬错误：配置不可用，转换本应已失败；这里做双保险
    pair_report = precheck_report.for_pair(result.source, result.version)
    if pair_report is not None and not pair_report.ok:
        exc = TransformError(
            "预检未通过："
            + "；".join(issue.message for issue in pair_report.errors),
            reason_code="precheck_failed",
        )
        _handle_failure(
            raw,
            exc,
            run,
            mode,
            override_source=override_source,
            override_version=override_version,
            prior_attempts=prior_attempts,
            fallback_identity=(result.source, result.version, result.event_id),
        )
        return

    entry = LedgerEntry(
        idempotency_key=key,
        source=result.source,
        version=result.version,
        event_id=result.event_id,
        mapping_version=result.mapping_version,
        source_hash=result.source_hash,
        published_run_id=run.run_id,
        published_at=_now_iso(),
        raw_position=result.raw_position,
        record=result.unified,
    )
    run.record_published(entry)
    run.stats.published += 1
    if mode == "retry":
        run.stats.retry_succeeded += 1


def _handle_failure(
    raw: RawRecord,
    exc: TransformError,
    run: OpenRun,
    mode: str,
    *,
    override_source: str | None,
    override_version: str | None,
    prior_attempts: int,
    fallback_identity: tuple[str, str, str] | None = None,
) -> None:
    # 失败记录也要尽量确定身份，保证重试能按幂等键找回。
    # 优先用转换过程中已解析出的身份，其次用重试覆盖值，最后才回退到原始字段。
    source = exc.source or override_source
    version = exc.version or override_version
    event_id = exc.event_id
    if fallback_identity is not None:
        fb_source, fb_version, fb_event = fallback_identity
        source = source or fb_source
        version = version or fb_version
        event_id = event_id or fb_event
    if source is None:
        source = str(raw.record.get("_source") or raw.file_source or "unknown")
    if version is None:
        version = str(raw.record.get("_version") or raw.file_version or "unknown")

    hash_value = source_hash(raw.record)
    if event_id is None:
        # 连事件编号都缺失时，用内容哈希构造稳定键，保证同一坏数据不会无限新增
        event_id = f"unidentifiable:{hash_value}"
    key = make_idempotency_key(source, event_id)

    failure = FailureEntry(
        idempotency_key=key,
        source=source,
        version=version,
        event_id=event_id,
        source_file=raw.source_file,
        position=raw.position,
        reason_code=exc.reason_code,
        reason=str(exc),
        source_hash=hash_value,
        failed_at=_now_iso(),
        raw_record=raw.record,
        fmt=raw.fmt,
        file_source=raw.file_source,
        file_version=raw.file_version,
        attempts=prior_attempts,
        last_run_id=run.run_id,
    )
    run.record_failure(failure)
    run.stats.failed += 1
    if mode == "retry":
        run.stats.retry_failed += 1


def _rollback(run: OpenRun) -> None:
    """提交前崩溃：清理未完成的 run 目录，历史 run 与 current 不受影响。"""
    try:
        if os.path.isdir(run.run_dir) and not os.listdir(run.run_dir):
            os.rmdir(run.run_dir)
        elif os.path.isdir(run.run_dir):
            # 有部分文件也整体保留为证据，但绝不切换 current
            marker = os.path.join(run.run_dir, "ABORTED")
            with open(marker, "w", encoding="utf-8") as fh:
                fh.write("run aborted before commit; current link unchanged\n")
    except OSError:
        pass
