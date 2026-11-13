"""单条记录转换：选映射、补默认值、null 校验、类型转换。

关键语义区分（需求明确要求）：
- JSON 中「字段缺失」：可以用映射里的 default 补默认值
- JSON 中「显式 null」：默认值不生效，按目标字段的 nullable 规则校验
- CSV 空单元格：读取阶段已归一为「字段缺失」，与 JSON 缺失同路径处理
"""

from __future__ import annotations

import datetime as _dt
import hashlib
import json
from dataclasses import dataclass
from typing import Any

from .config import FieldMapping, PipelineConfig, SourceSchema
from .errors import TransformError
from .readers import RawRecord
from .typesys import convert, describe_json_type


@dataclass
class TransformedRecord:
    """转换成功的统一明细记录。"""

    unified: dict[str, Any]          # 下游读取的统一明细
    source: str
    version: str
    event_id: str
    mapping_version: str
    raw_position: str
    source_file: str
    source_hash: str


def source_hash(raw_record: dict[str, Any]) -> str:
    """对原始记录内容取稳定哈希，用于检测重复发送时内容是否被改动。"""
    payload = json.dumps(raw_record, ensure_ascii=False, sort_keys=True)
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()[:16]


class _Identity:
    """转换过程中已解析出的身份信息，失败时附加到异常上。"""

    __slots__ = ("source", "version", "event_id")

    def __init__(self) -> None:
        self.source: str | None = None
        self.version: str | None = None
        self.event_id: str | None = None


def _fail(
    message: str,
    *,
    reason_code: str,
    identity: _Identity,
) -> TransformError:
    return TransformError(
        message,
        reason_code=reason_code,
        source=identity.source,
        version=identity.version,
        event_id=identity.event_id,
    )


def transform_record(
    raw: RawRecord,
    config: PipelineConfig,
    *,
    override_source: str | None = None,
    override_version: str | None = None,
) -> TransformedRecord:
    """转换一条原始记录；任何不满足规则的情况抛 TransformError。

    override_source/version 用于失败重试：重试时以待处理清单里记录的
    原始来源/版本为准，避免上游重发时改了字段导致走错映射。
    """
    record = dict(raw.record)
    # 文件级默认来源/版本并入记录（记录内自带字段优先级更高）
    if raw.file_source is not None and "_source" not in record:
        record["_source"] = raw.file_source
    if raw.file_version is not None and "_version" not in record:
        record["_version"] = raw.file_version

    identity = _Identity()

    # 1) 确定来源/版本，并找到对应 schema 与映射。
    # 优先级：重试覆盖值 > 记录内自定义字段（schema 的 source_field/
    # version_field）> 约定字段 _source/_version > 批次清单的文件级默认值。
    source, version = _initial_source_version(
        record, raw, config, override_source, override_version
    )
    identity.source, identity.version = source, version
    schema = config.source_schema(source, version)
    if schema is not None:
        # 找到 schema 后再按它声明的自定义字段名解析一次，
        # 处理文件级默认与记录内字段并存且不一致的情况
        source, version = _resolve_from_record_or_file(
            record, raw, schema, override_source, override_version
        )
        identity.source, identity.version = source, version
        schema = config.source_schema(source, version)
    if schema is None:
        raise _fail(
            f"来源 {source!r} 版本 {version!r} 没有来源 schema 声明",
            reason_code="unsupported_source_version",
            identity=identity,
        )
    mapping = config.mapping_for(source, version)
    if mapping is None:
        raise _fail(
            f"来源 {source!r} 版本 {version!r} 没有配置映射",
            reason_code="missing_mapping",
            identity=identity,
        )

    # 2) 解析事件编号（幂等键的核心）
    event_id = record.get(schema.id_field)
    if event_id is None or (isinstance(event_id, str) and event_id == ""):
        raise _fail(
            f"事件编号字段 {schema.id_field!r} 缺失或为空，无法建立幂等键",
            reason_code="missing_event_id",
            identity=identity,
        )
    event_id = str(event_id)
    identity.event_id = event_id

    # 3) CSV 字符串值先按来源 schema 转成声明类型；JSON 原生值做可空性校验
    typed_record = _coerce_source_types(record, schema, raw.fmt, identity)

    # 4) 逐目标字段产出
    unified: dict[str, Any] = {}
    for target_name, target_field in config.target_fields.items():
        fm = mapping.for_target(target_name)
        unified[target_name] = _build_target_field(
            target_name, fm, typed_record, target_field, identity
        )

    # 5) 附加溯源元数据（保留原事件编号与使用的映射版本）
    unified["_source"] = source
    unified["_version"] = version
    unified["_event_id"] = event_id
    unified["_mapping_version"] = mapping.mapping_version
    unified["_raw_position"] = f"{raw.source_file} :: {raw.position}"
    unified["_source_hash"] = source_hash(raw.record)

    return TransformedRecord(
        unified=unified,
        source=source,
        version=version,
        event_id=event_id,
        mapping_version=mapping.mapping_version,
        raw_position=f"{raw.source_file} :: {raw.position}",
        source_file=raw.source_file,
        source_hash=unified["_source_hash"],
    )


# ---------------------------------------------------------------------------
# 内部步骤
# ---------------------------------------------------------------------------

def _initial_source_version(
    record: dict[str, Any],
    raw: RawRecord,
    config: PipelineConfig,
    override_source: str | None,
    override_version: str | None,
) -> tuple[str, str]:
    """拿到用于查找 schema 的初始 (来源, 版本)。

    解析顺序：
    1. 重试覆盖值（失败时记录的来源/版本，最可信）；
    2. 各来源 schema 声明的自定义字段名（如 src/ver），用于不带
       _source/_version 约定字段的原始事件；
    3. 约定字段 _source/_version；
    4. 批次清单提供的文件级默认值。
    """
    if override_source is not None and override_version is not None:
        return override_source, override_version

    for candidate in config.source_schemas.values():
        sf = candidate.source_field or "_source"
        vf = candidate.version_field or "_version"
        src_val = record.get(sf, raw.file_source)
        ver_val = record.get(vf, raw.file_version)
        if (
            src_val == candidate.source
            and ver_val == candidate.version
        ):
            return str(src_val), str(ver_val)

    # 没有精确匹配，但记录的自定义字段指向一个「已知来源、未知版本」：
    # 保留这对值，让后续报出准确的 unsupported_source_version，
    # 而不是笼统地报缺少来源标识
    known_sources = {s.source for s in config.source_schemas.values()}
    for candidate in config.source_schemas.values():
        sf = candidate.source_field or "_source"
        vf = candidate.version_field or "_version"
        src_val = record.get(sf, raw.file_source)
        ver_val = record.get(vf, raw.file_version)
        if src_val in known_sources and ver_val is not None:
            return str(src_val), str(ver_val)

    source = record.get("_source") or raw.file_source
    version = record.get("_version") or raw.file_version
    if source is None or source == "":
        raise TransformError(
            "记录缺少来源标识（记录内字段或批次清单均未提供 source）",
            reason_code="missing_source",
        )
    if version is None or version == "":
        raise TransformError(
            "记录缺少版本标识（记录内字段或批次清单均未提供 version）",
            reason_code="missing_version",
        )
    return str(source), str(version)


def _resolve_from_record_or_file(
    record: dict[str, Any],
    raw: RawRecord,
    schema: SourceSchema,
    override_source: str | None,
    override_version: str | None,
) -> tuple[str, str]:
    """按 schema 声明的自定义字段名做最终的来源/版本解析。"""
    if override_source is not None and override_version is not None:
        return override_source, override_version
    source = (
        record.get(schema.source_field)
        if schema.source_field
        else record.get("_source")
    )
    source = source or raw.file_source
    version = (
        record.get(schema.version_field)
        if schema.version_field
        else record.get("_version")
    )
    version = version or raw.file_version
    if source is None or source == "":
        raise TransformError(
            "记录缺少来源标识（记录内字段或批次清单均未提供 source）",
            reason_code="missing_source",
        )
    if version is None or version == "":
        raise TransformError(
            "记录缺少版本标识（记录内字段或批次清单均未提供 version）",
            reason_code="missing_version",
        )
    return str(source), str(version)


def _coerce_source_types(
    record: dict[str, Any],
    schema: SourceSchema,
    fmt: str,
    identity: "_Identity",
) -> dict[str, Any]:
    """按来源 schema 把原始值规整为声明类型。

    - JSON：值已经是带类型的原生值，只做显式 null 的可空性校验
    - CSV：值全是字符串，按 schema 声明的类型转换；未声明类型的字段保持字符串
    """
    typed: dict[str, Any] = {}
    for name, value in record.items():
        spec = schema.field_spec(name)
        if spec is None:
            # 不在来源 schema 里的字段（如 _source 等元数据）原样保留
            typed[name] = value
            continue
        if value is None:
            if not spec.nullable:
                raise _fail(
                    f"来源字段 {name!r} 收到显式 null，但该字段声明为不可空",
                    reason_code="null_into_non_nullable",
                    identity=identity,
                )
            typed[name] = None
            continue
        if spec.type is None:
            typed[name] = value
            continue
        if fmt == "csv":
            if spec.type == "json":
                # CSV 里 json 字段是一段 JSON 文本，需要解析成结构，
                # 而不是把整段文本当作普通字符串透传
                try:
                    typed[name] = json.loads(value)
                except json.JSONDecodeError as exc:
                    raise _fail(
                        f"来源字段 {name!r} 的文本 {value!r} 不是合法 JSON，"
                        f"无法解析为 json 类型：{exc.msg}",
                        reason_code="type_mismatch",
                        identity=identity,
                    ) from exc
            else:
                try:
                    typed[name] = convert(
                        value, spec.type, where=f"来源字段 {name!r}"
                    )
                except TransformError as exc:
                    raise _fail(
                        str(exc),
                        reason_code=exc.reason_code,
                        identity=identity,
                    ) from exc
        else:
            # JSON 原生类型与声明不兼容时提前失败，错误信息更贴近来源
            if not _json_value_matches(value, spec.type):
                raise _fail(
                    f"来源字段 {name!r} 的值 {value!r} 实际类型为 "
                    f"{describe_json_type(value)}，与声明类型 {spec.type} 不符",
                    reason_code="source_type_mismatch",
                    identity=identity,
                )
            typed[name] = value
    return typed


def _json_value_matches(value: Any, declared: str) -> bool:
    if declared == "json":
        return True
    if declared == "string":
        return isinstance(value, str)
    if declared == "integer":
        return isinstance(value, int) and not isinstance(value, bool)
    if declared == "number":
        return (
            isinstance(value, (int, float)) and not isinstance(value, bool)
        )
    if declared == "boolean":
        return isinstance(value, bool)
    if declared == "datetime":
        if isinstance(value, _dt.datetime):
            return True
        if isinstance(value, str):
            try:
                _dt.datetime.fromisoformat(value.strip())
            except ValueError:
                return False
            return True
    return False


def _build_target_field(
    target_name: str,
    fm: FieldMapping | None,
    typed_record: dict[str, Any],
    target_field: Any,
    identity: "_Identity",
) -> Any:
    """按映射规则产出一个目标字段的值，含缺失/null/类型的完整判定。"""
    # 没有映射规则：可选目标保持 null（不可空字段在预检阶段已拦截，
    # 这里再做一次运行时兜底）
    if fm is None or fm.drop:
        if target_field.required:
            raise _fail(
                f"必填目标字段 {target_name!r} 没有可用映射",
                reason_code="required_target_unmapped",
                identity=identity,
            )
        if not target_field.nullable:
            raise _fail(
                f"目标字段 {target_name!r} 不可空且没有映射值",
                reason_code="null_into_non_nullable",
                identity=identity,
            )
        return None

    # 常量优先：与记录内容无关
    if fm.has_constant:
        if fm.constant is None:
            if not target_field.nullable:
                raise _fail(
                    f"目标字段 {target_name!r} 的 constant 为 null，"
                    "但该字段不可空",
                    reason_code="null_into_non_nullable",
                    identity=identity,
                )
            return None
        try:
            return convert(
                fm.constant,
                target_field.type,
                where=f"目标字段 {target_name!r}",
            )
        except TransformError as exc:
            raise _fail(
                str(exc), reason_code=exc.reason_code, identity=identity
            ) from exc

    # 来源字段路径
    if fm.source is not None:
        present = fm.source in typed_record
        raw_value = typed_record.get(fm.source)
        is_explicit_null = present and raw_value is None

        if is_explicit_null:
            # 显式 null：默认值不生效，按目标格式校验
            if not target_field.nullable:
                raise _fail(
                    f"目标字段 {target_name!r} 的来源字段 {fm.source!r} "
                    "收到显式 null，但目标字段不可空",
                    reason_code="null_into_non_nullable",
                    identity=identity,
                )
            return None

        if present:
            try:
                return convert(
                    raw_value,
                    target_field.type,
                    where=(
                        f"目标字段 {target_name!r}（来源 {fm.source!r}）"
                    ),
                )
            except TransformError as exc:
                if fm.on_error == "set_null":
                    # 映射修正的容错手段：脏值降级为 null，不拖垮整条记录
                    return None
                raise _fail(
                    str(exc), reason_code=exc.reason_code, identity=identity
                ) from exc

        # 字段缺失：默认值可以兜底
        if fm.has_default:
            return _apply_default(fm, target_name, target_field, identity)
        if target_field.required:
            raise _fail(
                f"必填目标字段 {target_name!r} 的来源字段 {fm.source!r} "
                "缺失，且未配置 default",
                reason_code="required_missing",
                identity=identity,
            )
        if not target_field.nullable:
            raise _fail(
                f"目标字段 {target_name!r} 不可空，来源字段 {fm.source!r} "
                "缺失且未配置 default",
                reason_code="null_into_non_nullable",
                identity=identity,
            )
        return None

    # 没有 source，只有 default（或什么都没有）
    if fm.has_default:
        return _apply_default(fm, target_name, target_field, identity)
    if target_field.required:
        raise _fail(
            f"必填目标字段 {target_name!r} 没有 source 也没有 default",
            reason_code="required_no_value_source",
            identity=identity,
        )
    if not target_field.nullable:
        raise _fail(
            f"目标字段 {target_name!r} 不可空且没有任何取值规则",
            reason_code="null_into_non_nullable",
            identity=identity,
        )
    return None


def _apply_default(
    fm: FieldMapping,
    target_name: str,
    target_field: Any,
    identity: "_Identity",
) -> Any:
    if fm.default is None:
        if target_field.required:
            raise _fail(
                f"必填目标字段 {target_name!r} 的 default 为 null",
                reason_code="required_default_null",
                identity=identity,
            )
        if not target_field.nullable:
            raise _fail(
                f"目标字段 {target_name!r} 的 default 为 null，"
                "但该字段不可空",
                reason_code="null_into_non_nullable",
                identity=identity,
            )
        return None
    try:
        return convert(
            fm.default,
            target_field.type,
            where=f"目标字段 {target_name!r} 的默认值",
        )
    except TransformError as exc:
        raise _fail(
            str(exc), reason_code=exc.reason_code, identity=identity
        ) from exc
