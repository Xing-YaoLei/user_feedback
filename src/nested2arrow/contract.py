"""Configurable conversion contract.

The contract decides how *inferred* types evolve across batches and what
happens when two values on the same JSON path are incompatible. Nothing here
ever causes a silent string conversion or silent precision loss: every
unresolvable situation is either promoted by an explicit rule or recorded as a
conflict (fail / quarantine).
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field, replace
from enum import Enum
from pathlib import Path
from typing import Any, Mapping


class ConflictPolicy(str, Enum):
    """What to do when a path cannot hold both observed types."""

    FAIL = "fail"          # abort the run with a documented conflict
    QUARANTINE = "quarantine"  # keep the offending record out of the data files
    PROMOTE = "promote"    # apply the (explicit, bounded) promotion matrix


class TimestampPolicy(str, Enum):
    """How timestamps are stored and reconstructed."""

    UTC = "utc"              # normalize every aware instant to UTC
    KEEP_OFFSET = "keep_offset"  # store offset separately to restore it


@dataclass(frozen=True)
class MergePolicy:
    int_to_int: ConflictPolicy = ConflictPolicy.PROMOTE      # width promotion
    int_to_decimal: ConflictPolicy = ConflictPolicy.PROMOTE  # widening, exact
    decimal_widen: ConflictPolicy = ConflictPolicy.PROMOTE   # precision/scale
    int_to_float: ConflictPolicy = ConflictPolicy.FAIL       # precision loss
    decimal_to_float: ConflictPolicy = ConflictPolicy.FAIL
    float_to_decimal: ConflictPolicy = ConflictPolicy.FAIL
    bool_number: ConflictPolicy = ConflictPolicy.FAIL
    scalar_string: ConflictPolicy = ConflictPolicy.FAIL      # object/array/...
    string_timestamp: ConflictPolicy = ConflictPolicy.FAIL
    struct_shape: ConflictPolicy = ConflictPolicy.FAIL       # object <-> array
    new_field_after_first_batch: ConflictPolicy = ConflictPolicy.FAIL
    timestamp_offset: ConflictPolicy = ConflictPolicy.PROMOTE

    @classmethod
    def strict(cls) -> "MergePolicy":
        """Nothing promotes automatically except the always-exact int/decimal widening."""
        return cls(
            int_to_int=ConflictPolicy.FAIL,
            int_to_decimal=ConflictPolicy.PROMOTE,
            decimal_widen=ConflictPolicy.PROMOTE,
            timestamp_offset=ConflictPolicy.PROMOTE,
        )

    @classmethod
    def lenient(cls) -> "MergePolicy":
        """All explicit promotions allowed; still never stringifies anything."""
        return cls(
            int_to_int=ConflictPolicy.PROMOTE,
            int_to_decimal=ConflictPolicy.PROMOTE,
            decimal_widen=ConflictPolicy.PROMOTE,
            int_to_float=ConflictPolicy.PROMOTE,
            decimal_to_float=ConflictPolicy.PROMOTE,
            float_to_decimal=ConflictPolicy.QUARANTINE,
            bool_number=ConflictPolicy.QUARANTINE,
            scalar_string=ConflictPolicy.QUARANTINE,
            string_timestamp=ConflictPolicy.QUARANTINE,
            struct_shape=ConflictPolicy.QUARANTINE,
            new_field_after_first_batch=ConflictPolicy.QUARANTINE,
            timestamp_offset=ConflictPolicy.PROMOTE,
        )


@dataclass(frozen=True)
class Contract:
    """Full conversion configuration."""

    merge: MergePolicy = field(default_factory=MergePolicy)
    default_policy: ConflictPolicy = ConflictPolicy.FAIL
    timestamp: TimestampPolicy = TimestampPolicy.UTC
    # Path -> one of: bool|int|decimal|float|string|timestamp|json
    # Explicitly typing a path skips inference; incompatible values conflict.
    type_overrides: Mapping[str, str] = field(default_factory=dict)
    max_decimal_precision: int = 38       # decimal128 ceiling
    use_decimal256: bool = False          # raise ceiling to 76
    allow_naive_datetime: bool = False    # ISO strings without offset
    naive_datetime_tz: str = "UTC"
    batch_max_records: int = 10_000
    presence_column: str = "__present__"
    fail_on_error: bool = True            # any parse/type error -> non-zero exit

    @property
    def decimal_precision_ceiling(self) -> int:
        return 76 if self.use_decimal256 else self.max_decimal_precision

    def with_overrides(self, **changes: Any) -> "Contract":
        return replace(self, **changes)

    def to_dict(self) -> dict[str, Any]:
        return {
            "merge": {k: v.value for k, v in self.merge.__dict__.items()},
            "default_policy": self.default_policy.value,
            "timestamp": self.timestamp.value,
            "type_overrides": dict(self.type_overrides),
            "max_decimal_precision": self.max_decimal_precision,
            "use_decimal256": self.use_decimal256,
            "allow_naive_datetime": self.allow_naive_datetime,
            "naive_datetime_tz": self.naive_datetime_tz,
            "batch_max_records": self.batch_max_records,
            "presence_column": self.presence_column,
            "fail_on_error": self.fail_on_error,
        }

    @classmethod
    def from_dict(cls, data: Mapping[str, Any]) -> "Contract":
        data = dict(data)
        merge_data = data.pop("merge", {}) or {}
        merge = MergePolicy(
            **{k: ConflictPolicy(v) for k, v in merge_data.items()}
        ) if merge_data else MergePolicy()
        if "timestamp" in data:
            data["timestamp"] = TimestampPolicy(data["timestamp"])
        if "default_policy" in data:
            data["default_policy"] = ConflictPolicy(data["default_policy"])
        data["type_overrides"] = dict(data.get("type_overrides", {}))
        known = {f for f in cls.__dataclass_fields__}  # type: ignore[attr-defined]
        return cls(merge=merge, **{k: v for k, v in data.items() if k in known})

    @classmethod
    def load(cls, path: str | Path) -> "Contract":
        with open(path, "r", encoding="utf-8") as fh:
            return cls.from_dict(json.load(fh))

    def dump(self, path: str | Path) -> None:
        Path(path).write_text(
            json.dumps(self.to_dict(), indent=2, ensure_ascii=False),
            encoding="utf-8",
        )
