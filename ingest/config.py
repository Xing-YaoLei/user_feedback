"""配置加载：目标字段定义、来源 schema、版本化映射。

配置目录由使用者维护，包含三个 JSON 文件：
- target_schema.json  统一明细的字段定义
- source_schemas.json 各来源各版本自己的字段定义
- mappings.json       按 (来源, 版本) 选择的版本化映射

所有配置在加载时一次性校验，配置错误直接中断，不进入数据处理阶段。
"""

from __future__ import annotations

import json
import os
from dataclasses import dataclass, field
from typing import Any

from .errors import ConfigError, TransformError
from .typesys import validate_type_name

# 统一明细中保留的溯源元数据字段，使用者不能占用这些名字
RESERVED_META_FIELDS = frozenset(
    {
        "_source",
        "_version",
        "_event_id",
        "_mapping_version",
        "_raw_position",
        "_ingested_at",
        "_source_hash",
    }
)


@dataclass(frozen=True)
class TargetField:
    name: str
    type: str
    required: bool = False
    nullable: bool = True
    default: Any = None  # 目标侧兜底默认值（通常不使用，默认值在映射里声明）
    description: str = ""


@dataclass(frozen=True)
class SourceFieldSpec:
    name: str
    type: str | None  # None 表示自由 JSON，不做来源侧类型声明
    required: bool = False
    nullable: bool = True
    description: str = ""


@dataclass(frozen=True)
class SourceSchema:
    source: str
    version: str
    id_field: str
    source_field: str | None = None  # 记录内携带来源的字段名
    version_field: str | None = None  # 记录内携带版本的字段名
    fields: dict[str, SourceFieldSpec] = field(default_factory=dict)

    def field_spec(self, name: str) -> SourceFieldSpec | None:
        return self.fields.get(name)


@dataclass(frozen=True)
class FieldMapping:
    target: str
    source: str | None = None
    default: Any = None
    # 显式声明默认值是否有效：没有 default 键时无法区分「默认值就是 null」
    # 与「没有默认值」，所以加载时用 has_default 记录
    has_default: bool = False
    constant: Any = None
    has_constant: bool = False
    drop: bool = False  # 显式标记该目标字段在此来源版本下不产出
    # 来源值类型转换失败时的策略：
    # - "fail"（默认）：整条记录进入失败清单
    # - "set_null"：该字段降级为 null（仅可空目标字段允许配置）
    on_error: str = "fail"


@dataclass(frozen=True)
class Mapping:
    source: str
    version: str
    mapping_version: str
    field_mappings: dict[str, FieldMapping]

    def for_target(self, target_name: str) -> FieldMapping | None:
        return self.field_mappings.get(target_name)


@dataclass
class PipelineConfig:
    target_fields: dict[str, TargetField]
    source_schemas: dict[tuple[str, str], SourceSchema]
    mappings: dict[tuple[str, str], Mapping]

    # ---- 加载入口 -------------------------------------------------

    @classmethod
    def load(cls, config_dir: str) -> "PipelineConfig":
        target_path = os.path.join(config_dir, "target_schema.json")
        source_path = os.path.join(config_dir, "source_schemas.json")
        mapping_path = os.path.join(config_dir, "mappings.json")
        for path in (target_path, source_path, mapping_path):
            if not os.path.isfile(path):
                raise ConfigError(f"配置文件不存在：{path}")
        with open(target_path, encoding="utf-8") as fh:
            target_raw = json.load(fh)
        with open(source_path, encoding="utf-8") as fh:
            source_raw = json.load(fh)
        with open(mapping_path, encoding="utf-8") as fh:
            mapping_raw = json.load(fh)

        target_fields = _load_target_fields(target_raw)
        source_schemas = _load_source_schemas(source_raw)
        mappings = _load_mappings(mapping_raw, target_fields, source_schemas)
        return cls(target_fields, source_schemas, mappings)

    # ---- 查询辅助 -------------------------------------------------

    def source_schema(self, source: str, version: str) -> SourceSchema | None:
        return self.source_schemas.get((source, version))

    def mapping_for(self, source: str, version: str) -> Mapping | None:
        return self.mappings.get((source, version))


# ---------------------------------------------------------------------------
# 各配置文件的加载与校验
# ---------------------------------------------------------------------------

def _load_target_fields(raw: Any) -> dict[str, TargetField]:
    if not isinstance(raw, dict) or not isinstance(raw.get("fields"), list):
        raise ConfigError("target_schema.json 顶层需要 {\"fields\": [...]}")
    result: dict[str, TargetField] = {}
    for entry in raw["fields"]:
        if not isinstance(entry, dict) or "name" not in entry:
            raise ConfigError(f"目标字段定义非法：{entry!r}")
        name = entry["name"]
        if name in RESERVED_META_FIELDS:
            raise ConfigError(f"目标字段名 {name!r} 是系统保留的元数据字段名")
        if name in result:
            raise ConfigError(f"目标字段 {name!r} 重复定义")
        type_name = entry.get("type", "string")
        try:
            validate_type_name(type_name, f"目标字段 {name}")
        except ValueError as exc:
            raise ConfigError(str(exc)) from exc
        required = bool(entry.get("required", False))
        nullable = bool(entry.get("nullable", True))
        default = entry.get("default")
        field_obj = TargetField(
            name=name,
            type=type_name,
            required=required,
            nullable=nullable,
            default=default,
            description=entry.get("description", ""),
        )
        # 目标字段自带默认值时，立刻验证默认值本身能否通过目标类型
        if default is not None:
            from .typesys import convert

            try:
                convert(default, type_name, where=f"目标字段 {name} 的默认值")
            except TransformError as exc:
                raise ConfigError(str(exc)) from exc
        result[name] = field_obj
    if not result:
        raise ConfigError("target_schema.json 至少要定义一个目标字段")
    return result


def _load_source_schemas(raw: Any) -> dict[tuple[str, str], SourceSchema]:
    if not isinstance(raw, dict) or not isinstance(raw.get("schemas"), list):
        raise ConfigError("source_schemas.json 顶层需要 {\"schemas\": [...]}")
    result: dict[tuple[str, str], SourceSchema] = {}
    for entry in raw["schemas"]:
        if not isinstance(entry, dict):
            raise ConfigError(f"来源 schema 定义非法：{entry!r}")
        source = entry.get("source")
        version = entry.get("version")
        if not source or not version:
            raise ConfigError(f"来源 schema 缺少 source/version：{entry!r}")
        key = (str(source), str(version))
        if key in result:
            raise ConfigError(f"来源 schema {key} 重复定义")
        id_field = entry.get("id_field")
        if not id_field:
            raise ConfigError(f"来源 schema {key} 缺少 id_field 声明")
        fields: dict[str, SourceFieldSpec] = {}
        for fentry in entry.get("fields", []):
            if not isinstance(fentry, dict) or "name" not in fentry:
                raise ConfigError(f"来源 {key} 的字段定义非法：{fentry!r}")
            fname = fentry["name"]
            if fname in RESERVED_META_FIELDS:
                raise ConfigError(
                    f"来源 {key} 的字段名 {fname!r} 是系统保留名"
                )
            if fname in fields:
                raise ConfigError(f"来源 {key} 的字段 {fname!r} 重复定义")
            ftype = fentry.get("type")
            if ftype is not None:
                try:
                    validate_type_name(ftype, f"来源 {key} 字段 {fname}")
                except ValueError as exc:
                    raise ConfigError(str(exc)) from exc
            fields[fname] = SourceFieldSpec(
                name=fname,
                type=ftype,
                required=bool(fentry.get("required", False)),
                nullable=bool(fentry.get("nullable", True)),
                description=fentry.get("description", ""),
            )
        result[key] = SourceSchema(
            source=str(source),
            version=str(version),
            id_field=str(id_field),
            source_field=entry.get("source_field"),
            version_field=entry.get("version_field"),
            fields=fields,
        )
    return result


def _load_mappings(
    raw: Any,
    target_fields: dict[str, TargetField],
    source_schemas: dict[tuple[str, str], SourceSchema],
) -> dict[tuple[str, str], Mapping]:
    if not isinstance(raw, dict) or not isinstance(raw.get("mappings"), list):
        raise ConfigError("mappings.json 顶层需要 {\"mappings\": [...]}")
    result: dict[tuple[str, str], Mapping] = {}
    for entry in raw["mappings"]:
        if not isinstance(entry, dict):
            raise ConfigError(f"映射定义非法：{entry!r}")
        source = entry.get("source")
        version = entry.get("version")
        mapping_version = entry.get("mapping_version")
        if not source or not version or not mapping_version:
            raise ConfigError(
                f"映射缺少 source/version/mapping_version：{entry!r}"
            )
        key = (str(source), str(version))
        if key in result:
            raise ConfigError(f"映射 {key} 重复定义")
        if key not in source_schemas:
            raise ConfigError(
                f"映射 {key} 找不到对应的来源 schema，请先在 "
                "source_schemas.json 中声明"
            )
        schema = source_schemas[key]
        field_mappings: dict[str, FieldMapping] = {}
        for mentry in entry.get("fields", []):
            if not isinstance(mentry, dict) or "target" not in mentry:
                raise ConfigError(f"映射 {key} 的字段规则非法：{mentry!r}")
            target = mentry["target"]
            if target not in target_fields:
                raise ConfigError(
                    f"映射 {key} 引用了不存在的目标字段 {target!r}"
                )
            if target in field_mappings:
                raise ConfigError(
                    f"映射 {key} 对目标字段 {target!r} 配置了多条规则"
                )
            source_name = mentry.get("source")
            if source_name is not None and source_name not in schema.fields:
                raise ConfigError(
                    f"映射 {key} 的目标字段 {target!r} 引用了来源 schema "
                    f"中不存在的字段 {source_name!r}"
                )
            has_default = "default" in mentry
            has_constant = "constant" in mentry
            if has_default and has_constant:
                raise ConfigError(
                    f"映射 {key} 的目标字段 {target!r} 不能同时配置 "
                    "default 和 constant"
                )
            if source_name is not None and has_constant:
                raise ConfigError(
                    f"映射 {key} 的目标字段 {target!r} 不能同时配置 "
                    "source 和 constant"
                )
            on_error = str(mentry.get("on_error", "fail"))
            if on_error not in ("fail", "set_null"):
                raise ConfigError(
                    f"映射 {key} 的目标字段 {target!r} 的 on_error "
                    f"只能是 fail 或 set_null，实际为 {on_error!r}"
                )
            if on_error == "set_null":
                target_field_obj = target_fields[target]
                if not target_field_obj.nullable:
                    raise ConfigError(
                        f"映射 {key} 的目标字段 {target!r} 不可空，"
                        "不能配置 on_error=set_null"
                    )
            field_mappings[target] = FieldMapping(
                target=target,
                source=source_name,
                default=mentry.get("default"),
                has_default=has_default,
                constant=mentry.get("constant"),
                has_constant=has_constant,
                drop=bool(mentry.get("drop", False)),
                on_error=on_error,
            )
        result[key] = Mapping(
            source=str(source),
            version=str(version),
            mapping_version=str(mapping_version),
            field_mappings=field_mappings,
        )
    return result
