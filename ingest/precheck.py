"""导入前预检：按 (来源, 版本) 检查必填字段能否补齐、类型能否转换。

预检只看配置（目标 schema + 来源 schema + 映射），不依赖具体数据文件，
因此同一份配置只需预检一次；其结论会在运行时用于快速拒绝不兼容的记录。

判定口径：
- error   该来源版本的映射本身不可用，记录会直接失败（必填无来源、
           显式/默认值的静态类型不兼容、映射引用了不存在的来源字段等）
- warning 不阻断导入，但提示使用者注意：有来源字段没有被任何映射使用、
           映射未覆盖可选目标字段等
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

from .config import FieldMapping, PipelineConfig, SourceSchema, TargetField
from .typesys import is_compatible


@dataclass
class FieldIssue:
    field: str
    severity: str  # "error" | "warning"
    reason_code: str
    message: str

    def to_dict(self) -> dict[str, Any]:
        return {
            "field": self.field,
            "severity": self.severity,
            "reason_code": self.reason_code,
            "message": self.message,
        }


@dataclass
class PairReport:
    source: str
    version: str
    issues: list[FieldIssue] = field(default_factory=list)

    @property
    def ok(self) -> bool:
        return not any(i.severity == "error" for i in self.issues)

    @property
    def errors(self) -> list[FieldIssue]:
        return [i for i in self.issues if i.severity == "error"]

    @property
    def warnings(self) -> list[FieldIssue]:
        return [i for i in self.issues if i.severity == "warning"]

    def to_dict(self) -> dict[str, Any]:
        return {
            "source": self.source,
            "version": self.version,
            "ok": self.ok,
            "errors": [i.to_dict() for i in self.errors],
            "warnings": [i.to_dict() for i in self.warnings],
        }


@dataclass
class PrecheckReport:
    pair_reports: dict[tuple[str, str], PairReport]

    @property
    def ok(self) -> bool:
        return all(r.ok for r in self.pair_reports.values())

    def for_pair(self, source: str, version: str) -> PairReport | None:
        return self.pair_reports.get((source, version))

    def to_dict(self) -> dict[str, Any]:
        return {
            "ok": self.ok,
            "pairs": [
                self.pair_reports[key].to_dict()
                for key in sorted(self.pair_reports)
            ],
        }


def run_precheck(
    config: PipelineConfig,
    pairs: list[tuple[str, str]] | None = None,
) -> PrecheckReport:
    """对指定的 (来源, 版本) 列表做预检；None 表示覆盖全部已配置来源。"""
    if pairs is None:
        pairs = sorted(config.source_schemas)
    reports: dict[tuple[str, str], PairReport] = {}
    for source, version in pairs:
        key = (source, version)
        report = PairReport(source, version)
        schema = config.source_schema(source, version)
        if schema is None:
            report.issues.append(
                FieldIssue(
                    field="*",
                    severity="error",
                    reason_code="missing_source_schema",
                    message=(
                        f"来源 {source!r} 版本 {version!r} 没有来源 schema 声明，"
                        "无法判断字段与类型"
                    ),
                )
            )
            reports[key] = report
            continue
        mapping = config.mapping_for(source, version)
        if mapping is None:
            report.issues.append(
                FieldIssue(
                    field="*",
                    severity="error",
                    reason_code="missing_mapping",
                    message=(
                        f"来源 {source!r} 版本 {version!r} 没有配置映射，"
                        "记录无法进入统一明细"
                    ),
                )
            )
            reports[key] = report
            continue

        used_source_fields: set[str] = set()
        for target_name, target_field in config.target_fields.items():
            fm = mapping.for_target(target_name)
            if fm is None:
                # 没有任何规则：必填目标一定补不齐；可选目标保持缺失（合法）
                if target_field.required:
                    report.issues.append(
                        FieldIssue(
                            field=target_name,
                            severity="error",
                            reason_code="required_target_unmapped",
                            message=(
                                f"必填目标字段 {target_name!r} 没有映射规则，"
                                "既无来源字段也无默认值"
                            ),
                        )
                    )
                else:
                    report.issues.append(
                        FieldIssue(
                            field=target_name,
                            severity="warning",
                            reason_code="optional_target_unmapped",
                            message=(
                                f"可选目标字段 {target_name!r} 没有映射规则，"
                                "产出记录中该字段将为 null"
                            ),
                        )
                    )
                continue
            if fm.source is not None:
                used_source_fields.add(fm.source)
            _check_field_mapping(fm, target_field, schema, report)

        # 反向检查：来源字段没有被任何映射使用（升级新增字段最容易漏配）
        for source_field_name in sorted(schema.fields):
            if source_field_name not in used_source_fields:
                report.issues.append(
                    FieldIssue(
                        field=source_field_name,
                        severity="warning",
                        reason_code="source_field_unused",
                        message=(
                            f"来源字段 {source_field_name!r} 未被任何映射使用，"
                            "如为新版本新增字段请确认是否需要接入"
                        ),
                    )
                )
        reports[key] = report
    return PrecheckReport(reports)


def _check_field_mapping(
    fm: FieldMapping,
    target_field: TargetField,
    schema: SourceSchema,
    report: PairReport,
) -> None:
    """检查单条目标字段的映射规则。"""
    label = f"目标字段 {target_field.name!r}"

    if fm.drop:
        if target_field.required:
            report.issues.append(
                FieldIssue(
                    field=target_field.name,
                    severity="error",
                    reason_code="required_target_dropped",
                    message=f"{label} 是必填字段，不能标记为 drop",
                )
            )
        return

    if fm.has_constant:
        # 常量在配置加载后就是目标侧的 Python 值，静态验证其类型
        if fm.constant is None:
            if not target_field.nullable:
                report.issues.append(
                    FieldIssue(
                        field=target_field.name,
                        severity="error",
                        reason_code="null_into_non_nullable",
                        message=f"{label} 的 constant 为 null，但目标字段不可空",
                    )
                )
            return
        if not is_compatible(
            _python_type_name(fm.constant), target_field.type
        ):
            report.issues.append(
                FieldIssue(
                    field=target_field.name,
                    severity="error",
                    reason_code="type_incompatible",
                    message=(
                        f"{label} 的 constant 值 {fm.constant!r} 类型为 "
                        f"{_python_type_name(fm.constant)}，无法转换为目标类型 "
                        f"{target_field.type}"
                    ),
                )
            )
        return

    if fm.source is not None:
        source_spec = schema.field_spec(fm.source)
        # 配置加载阶段已保证 source 存在，这里仅作防御性检查
        if source_spec is None:
            report.issues.append(
                FieldIssue(
                    field=target_field.name,
                    severity="error",
                    reason_code="unknown_source_field",
                    message=(
                        f"{label} 引用的来源字段 {fm.source!r} 不在来源 schema 中"
                    ),
                )
            )
            return
        # 静态类型兼容性（nullable 来源可能给 null，null 的合法性在运行时
        # 结合「显式 null / 缺失」语义判断；这里只看非 null 值的转换）
        if source_spec.type is not None and not is_compatible(
            source_spec.type, target_field.type
        ):
            report.issues.append(
                FieldIssue(
                    field=target_field.name,
                    severity="error",
                    reason_code="type_incompatible",
                    message=(
                        f"{label} 的来源字段 {fm.source!r} 声明类型为 "
                        f"{source_spec.type}，无法转换为目标类型 "
                        f"{target_field.type}"
                    ),
                )
            )
        # 来源字段既可能缺失、又没有默认值兜底时，必填目标补不齐
        if target_field.required and not source_spec.required and not fm.has_default:
            report.issues.append(
                FieldIssue(
                    field=target_field.name,
                    severity="error",
                    reason_code="required_may_be_missing",
                    message=(
                        f"{label} 必填，但来源字段 {fm.source!r} 非必填且没有 "
                        "配置 default，记录缺失该字段时无法补齐"
                    ),
                )
            )
        # 来源字段允许显式 null、目标字段不可空时：显式 null 不会触发 default，
        # 运行时必然失败，预检提前报出
        if source_spec.nullable and not target_field.nullable and not fm.has_constant:
            report.issues.append(
                FieldIssue(
                    field=target_field.name,
                    severity="error",
                    reason_code="explicit_null_not_allowed",
                    message=(
                        f"{label} 不可空，但来源字段 {fm.source!r} 允许显式 null；"
                        "显式 null 不会使用 default，需要先在来源侧保证非空，"
                        "或把目标字段改为可空"
                    ),
                )
            )
        if fm.has_default:
            _check_default_type(fm, target_field, report)
        return

    # 没有 source 也没有 constant：只能靠 default
    if fm.has_default:
        if fm.default is None:
            if target_field.required:
                report.issues.append(
                    FieldIssue(
                        field=target_field.name,
                        severity="error",
                        reason_code="required_default_null",
                        message=f"{label} 必填，default 不能为 null",
                    )
                )
            elif not target_field.nullable:
                report.issues.append(
                    FieldIssue(
                        field=target_field.name,
                        severity="error",
                        reason_code="null_into_non_nullable",
                        message=(
                            f"{label} 的 default 为 null，但目标字段不可空"
                        ),
                    )
                )
        else:
            _check_default_type(fm, target_field, report)
        return

    # 既无 source、constant，也无 default：必填目标无法补齐
    if target_field.required:
        report.issues.append(
            FieldIssue(
                field=target_field.name,
                severity="error",
                reason_code="required_no_value_source",
                message=(
                    f"{label} 必填，但映射没有提供 source、constant 或 default"
                ),
            )
        )


def _check_default_type(
    fm: FieldMapping, target_field: TargetField, report: PairReport
) -> None:
    if fm.default is None:
        return  # null 的可空性已在调用处处理
    inferred = _python_type_name(fm.default)
    if not is_compatible(inferred, target_field.type):
        report.issues.append(
            FieldIssue(
                field=target_field.name,
                severity="error",
                reason_code="type_incompatible",
                message=(
                    f"目标字段 {target_field.name!r} 的 default 值 {fm.default!r} "
                    f"类型为 {inferred}，无法转换为目标类型 {target_field.type}"
                ),
            )
        )


def _python_type_name(value: Any) -> str:
    """把配置里的 JSON 常量推断成类型系统里的类型名。"""
    if isinstance(value, bool):
        return "boolean"
    if isinstance(value, int):
        return "integer"
    if isinstance(value, float):
        return "number"
    if isinstance(value, str):
        return "string"
    if isinstance(value, (dict, list)):
        return "json"
    return "json"
