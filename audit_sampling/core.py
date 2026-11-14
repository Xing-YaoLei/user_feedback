"""Deterministic, order-independent stratified sampling for distributed branches.

Each page gets a priority that is a pure function of ``(seed, page_id)``.  A
stratum keeps the ``quota`` pages with the smallest priorities ("bottom-k").

A branch can therefore produce its summary in a single sequential pass, storing
only per-stratum eligibility counts and at most ``quota`` candidate records per
stratum.  Merging summaries keeps the smallest candidates of the union, which is
mathematically identical to one pass over every record at the head office:

    union of per-partition bottom-k  ==  bottom-k of the whole data set

No record ordering, file partition layout, or summary merge order can affect the
result, because the priority depends only on the seed and the page ID.
"""

from __future__ import annotations

import hashlib
import heapq
import math
from collections.abc import Iterable, Mapping, Sequence
from dataclasses import dataclass
from typing import Any

LOW_CONFIDENCE_THRESHOLD = 0.8
TIERS: tuple[str, str] = ("low", "high")
_TIER_RANK = {"low": 0, "high": 1}
_HEX_DIGITS = frozenset("0123456789abcdef")

SUMMARY_SCHEMA = "audit-sampling/summary/v1"
REPORT_SCHEMA = "audit-sampling/report/v1"
SELECTION_SCHEMA = "audit-sampling/selection/v1"

_PRIORITY_DOMAIN = b"audit-sampling/priority/v1"

QuotaTable = dict[str, dict[str, int]]
StratumKey = tuple[str, str]  # (language, tier)


class SamplingError(ValueError):
    """Raised for malformed input or inconsistent summaries."""


# ---------------------------------------------------------------------------
# small validation helpers
# ---------------------------------------------------------------------------


def _require_str(value: Any, context: str, *, allow_empty: bool = False) -> str:
    if not isinstance(value, str):
        raise SamplingError(f"{context}: expected a string, got {type(value).__name__}")
    if not allow_empty and not value:
        raise SamplingError(f"{context}: must not be empty")
    return value


def _require_nonneg_int(value: Any, context: str) -> int:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise SamplingError(f"{context}: expected a non-negative integer, got {value!r}")
    if isinstance(value, float):
        if not math.isfinite(value) or value != int(value):
            raise SamplingError(f"{context}: expected a non-negative integer, got {value!r}")
        value = int(value)
    if value < 0:
        raise SamplingError(f"{context}: must be non-negative, got {value}")
    return value


def _require_priority(value: Any, context: str) -> str:
    if (
        not isinstance(value, str)
        or len(value) != 64
        or any(ch not in _HEX_DIGITS for ch in value)
    ):
        raise SamplingError(f"{context}: expected a 64-character lowercase hex priority")
    return value


def stratum_sort_key(key: StratumKey) -> tuple[str, int]:
    """Deterministic ordering of strata for reports and selections."""

    return (key[0], _TIER_RANK[key[1]])


# ---------------------------------------------------------------------------
# priorities and strata
# ---------------------------------------------------------------------------


def priority_for(seed: str, page_id: str) -> str:
    """Return the deterministic 256-bit priority of a page for a given seed."""

    digest = hashlib.sha256()
    digest.update(_PRIORITY_DOMAIN)
    digest.update(b"\x00")
    digest.update(seed.encode("utf-8"))
    digest.update(b"\x00")
    digest.update(page_id.encode("utf-8"))
    return digest.hexdigest()


def tier_for_confidence(confidence: float) -> str:
    """Stratum tier: ``low`` when confidence is strictly below 0.8, else ``high``."""

    return "low" if confidence < LOW_CONFIDENCE_THRESHOLD else "high"


# ---------------------------------------------------------------------------
# quota table
# ---------------------------------------------------------------------------


def normalize_quota(raw: Any, *, source: str = "quota table") -> QuotaTable:
    """Validate a nested quota table and fill absent tiers with zero.

    Accepted shape::

        {"zh": {"low": 5, "high": 3}, "en": {"low": 2}}
    """

    if not isinstance(raw, Mapping):
        raise SamplingError(f"{source}: expected a JSON object")
    normalized: QuotaTable = {}
    for language, tiers in raw.items():
        _require_str(language, f"{source}: language key", allow_empty=False)
        if not isinstance(tiers, Mapping):
            raise SamplingError(
                f"{source}: quota for language {language!r} must be a JSON object"
            )
        entry = {"low": 0, "high": 0}
        for tier, value in tiers.items():
            if tier not in _TIER_RANK:
                raise SamplingError(
                    f"{source}: unknown tier {tier!r} for language {language!r}; "
                    f"expected one of {sorted(_TIER_RANK)}"
                )
            entry[tier] = _require_nonneg_int(
                value, f"{source}: quota for {language!r}/{tier}"
            )
        normalized[language] = entry
    return normalized


def quota_for(quota: Mapping[str, Mapping[str, int]], language: str, tier: str) -> int:
    return quota.get(language, {}).get(tier, 0)


def quota_strata(quota: Mapping[str, Mapping[str, int]]) -> set[StratumKey]:
    return {(language, tier) for language, tiers in quota.items() for tier in tiers}


# ---------------------------------------------------------------------------
# records and candidates
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class PageRecord:
    """One input record: a globally unique page ID, language, OCR confidence."""

    page_id: str
    language: str
    confidence: float

    def __post_init__(self) -> None:
        if not isinstance(self.page_id, str) or not self.page_id:
            raise SamplingError("record: page_id must be a non-empty string")
        if not isinstance(self.language, str) or not self.language:
            raise SamplingError("record: language must be a non-empty string")
        confidence = self.confidence
        if isinstance(confidence, bool) or not isinstance(confidence, (int, float)):
            raise SamplingError("record: confidence must be a number")
        confidence = float(confidence)
        if not math.isfinite(confidence) or not 0.0 <= confidence <= 1.0:
            raise SamplingError(
                f"record: confidence must be a finite number in [0, 1], "
                f"got {self.confidence!r}"
            )
        object.__setattr__(self, "confidence", confidence)


@dataclass(frozen=True)
class Candidate:
    """A record retained by a branch summary (priority order, then page ID)."""

    page_id: str
    priority: str

    @property
    def sort_key(self) -> tuple[str, str]:
        return (self.priority, self.page_id)

    def to_dict(self) -> dict[str, str]:
        return {"page_id": self.page_id, "priority": self.priority}


class _WorstCandidate:
    """Max-heap entry: the heap root is the largest (priority, page_id)."""

    __slots__ = ("key", "page_id", "priority")

    def __init__(self, key: tuple[str, str], page_id: str, priority: str) -> None:
        self.key = key
        self.page_id = page_id
        self.priority = priority

    def __lt__(self, other: "_WorstCandidate") -> bool:
        return self.key > other.key


class _BottomK:
    """Keep the ``quota`` smallest (priority, page_id) keys seen so far."""

    __slots__ = ("quota", "_heap")

    def __init__(self, quota: int) -> None:
        self.quota = quota
        self._heap: list[_WorstCandidate] = []

    def consider(self, page_id: str, priority: str) -> None:
        if self.quota == 0:
            return
        key = (priority, page_id)
        if len(self._heap) < self.quota:
            heapq.heappush(self._heap, _WorstCandidate(key, page_id, priority))
        elif key < self._heap[0].key:
            heapq.heapreplace(self._heap, _WorstCandidate(key, page_id, priority))

    def candidates(self) -> tuple[Candidate, ...]:
        return tuple(
            sorted(
                (Candidate(entry.page_id, entry.priority) for entry in self._heap),
                key=lambda candidate: candidate.sort_key,
            )
        )


class _Accumulator:
    __slots__ = ("eligible", "bottom")

    def __init__(self, quota: int) -> None:
        self.eligible = 0
        self.bottom = _BottomK(quota)


# ---------------------------------------------------------------------------
# branch summary
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class StratumSummary:
    language: str
    tier: str
    eligible: int
    candidates: tuple[Candidate, ...]


@dataclass(frozen=True)
class BranchSummary:
    seed: str
    quota: QuotaTable
    strata: Mapping[StratumKey, StratumSummary]
    threshold: float = LOW_CONFIDENCE_THRESHOLD
    label: str | None = None

    def __post_init__(self) -> None:
        if not isinstance(self.seed, str) or not self.seed:
            raise SamplingError("summary: seed must not be empty")
        if self.threshold != LOW_CONFIDENCE_THRESHOLD:
            raise SamplingError(
                f"summary: unsupported threshold {self.threshold!r}; "
                f"expected {LOW_CONFIDENCE_THRESHOLD}"
            )
        normalized = normalize_quota(self.quota, source="summary: quota")
        for key, stratum in self.strata.items():
            if not isinstance(key, tuple) or len(key) != 2:
                raise SamplingError(f"summary: invalid stratum key {key!r}")
            language, tier = key
            if tier not in _TIER_RANK:
                raise SamplingError(f"summary: invalid stratum tier {tier!r}")
            if (stratum.language, stratum.tier) != (language, tier):
                raise SamplingError(
                    f"summary: stratum {key!r} disagrees with its record "
                    f"({stratum.language!r}, {stratum.tier!r})"
                )
            quota_value = quota_for(normalized, language, tier)
            expected = min(quota_value, stratum.eligible)
            if len(stratum.candidates) != expected:
                raise SamplingError(
                    f"summary: stratum {key!r} holds {len(stratum.candidates)} "
                    f"candidates; expected min(quota={quota_value}, "
                    f"eligible={stratum.eligible}) = {expected}. A summary must "
                    f"retain the bottom-quota candidates of its stratum."
                )
        object.__setattr__(self, "quota", normalized)


def summarize_records(
    records: Iterable[PageRecord],
    *,
    seed: str,
    quota: Mapping[str, Mapping[str, int]],
    reviewed_ids: frozenset[str] | set[str] = frozenset(),
    label: str | None = None,
) -> BranchSummary:
    """Summarize one branch in a single pass.

    Reviewed page IDs are excluded before counting.  Every other record is
    counted into its (language, tier) stratum; only records entering the
    stratum's bottom ``quota`` are retained as candidates.  Memory use is
    therefore O(number of strata * quota), independent of input size.
    """

    seed = _require_str(seed, "seed")
    normalized_quota = normalize_quota(quota)
    accumulators: dict[StratumKey, _Accumulator] = {}

    for record in records:
        if record.page_id in reviewed_ids:
            continue
        key = (record.language, tier_for_confidence(record.confidence))
        accumulator = accumulators.get(key)
        if accumulator is None:
            accumulator = _Accumulator(quota_for(normalized_quota, key[0], key[1]))
            accumulators[key] = accumulator
        accumulator.eligible += 1
        if accumulator.bottom.quota:
            accumulator.bottom.consider(
                record.page_id, priority_for(seed, record.page_id)
            )

    strata: dict[StratumKey, StratumSummary] = {}
    for key in sorted(accumulators, key=stratum_sort_key):
        accumulator = accumulators[key]
        strata[key] = StratumSummary(
            language=key[0],
            tier=key[1],
            eligible=accumulator.eligible,
            candidates=accumulator.bottom.candidates(),
        )
    return BranchSummary(
        seed=seed,
        quota=normalized_quota,
        strata=strata,
        label=label,
    )


def summary_to_dict(summary: BranchSummary) -> dict[str, Any]:
    strata: dict[str, dict[str, Any]] = {}
    for key in sorted(summary.strata, key=stratum_sort_key):
        stratum = summary.strata[key]
        strata.setdefault(stratum.language, {})[stratum.tier] = {
            "eligible": stratum.eligible,
            "candidates": [candidate.to_dict() for candidate in stratum.candidates],
        }
    quota: dict[str, dict[str, int]] = {}
    for language in sorted(summary.quota):
        quota[language] = {
            tier: summary.quota[language][tier] for tier in TIERS
        }
    data: dict[str, Any] = {
        "schema": SUMMARY_SCHEMA,
        "seed": summary.seed,
        "threshold": summary.threshold,
        "quota": quota,
        "strata": strata,
    }
    if summary.label is not None:
        data["label"] = summary.label
    return data


def summary_from_dict(data: Any) -> BranchSummary:
    """Validate a summary loaded from JSON and rebuild the typed summary."""

    if not isinstance(data, Mapping):
        raise SamplingError("summary: expected a JSON object")
    if data.get("schema") != SUMMARY_SCHEMA:
        raise SamplingError(
            f"summary: unexpected schema {data.get('schema')!r}; "
            f"expected {SUMMARY_SCHEMA!r}"
        )
    seed = _require_str(data.get("seed"), "summary: seed")
    threshold = data.get("threshold")
    if isinstance(threshold, bool) or not isinstance(threshold, (int, float)):
        raise SamplingError("summary: threshold must be a number")
    if float(threshold) != LOW_CONFIDENCE_THRESHOLD:
        raise SamplingError(
            f"summary: threshold {threshold!r} does not match "
            f"{LOW_CONFIDENCE_THRESHOLD}"
        )
    quota = normalize_quota(data.get("quota"), source="summary: quota")
    label_raw = data.get("label")
    if label_raw is not None:
        label = _require_str(label_raw, "summary: label")
    else:
        label = None

    strata_raw = data.get("strata")
    if not isinstance(strata_raw, Mapping):
        raise SamplingError("summary: strata must be a JSON object")

    strata: dict[StratumKey, StratumSummary] = {}
    seen_page_ids: set[str] = set()
    for language, tiers_raw in strata_raw.items():
        _require_str(language, "summary: strata language key")
        if not isinstance(tiers_raw, Mapping):
            raise SamplingError(
                f"summary: strata[{language!r}] must be a JSON object"
            )
        for tier, entry in tiers_raw.items():
            if tier not in _TIER_RANK:
                raise SamplingError(
                    f"summary: unknown tier {tier!r} for language {language!r}"
                )
            context = f"summary: strata[{language!r}][{tier!r}]"
            if not isinstance(entry, Mapping):
                raise SamplingError(f"{context}: expected a JSON object")
            eligible = _require_nonneg_int(entry.get("eligible"), f"{context}.eligible")
            raw_candidates = entry.get("candidates")
            if not isinstance(raw_candidates, list):
                raise SamplingError(f"{context}.candidates: expected a JSON array")
            candidates: list[Candidate] = []
            for index, raw_candidate in enumerate(raw_candidates):
                candidate_context = f"{context}.candidates[{index}]"
                if not isinstance(raw_candidate, Mapping):
                    raise SamplingError(f"{candidate_context}: expected a JSON object")
                page_id = _require_str(
                    raw_candidate.get("page_id"), f"{candidate_context}.page_id"
                )
                priority = _require_priority(
                    raw_candidate.get("priority"), f"{candidate_context}.priority"
                )
                expected = priority_for(seed, page_id)
                if priority != expected:
                    raise SamplingError(
                        f"{candidate_context}: priority does not match seed/page_id"
                    )
                if page_id in seen_page_ids:
                    raise SamplingError(
                        f"{candidate_context}: duplicate candidate page_id "
                        f"{page_id!r} in summary"
                    )
                seen_page_ids.add(page_id)
                candidates.append(Candidate(page_id, priority))
            quota_value = quota_for(quota, language, tier)
            if len(candidates) > quota_value:
                raise SamplingError(
                    f"{context}: {len(candidates)} candidates exceed quota "
                    f"{quota_value}"
                )
            if len(candidates) != min(quota_value, eligible):
                raise SamplingError(
                    f"{context}: expected exactly min(quota, eligible) = "
                    f"{min(quota_value, eligible)} candidates, found "
                    f"{len(candidates)}; a summary must retain the bottom "
                    f"quota candidates of its stratum"
                )
            strata[(language, tier)] = StratumSummary(
                language=language,
                tier=tier,
                eligible=eligible,
                candidates=tuple(
                    sorted(candidates, key=lambda candidate: candidate.sort_key)
                ),
            )

    return BranchSummary(seed=seed, quota=quota, strata=strata, label=label)


# ---------------------------------------------------------------------------
# merge
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class StratumResult:
    language: str
    tier: str
    quota: int
    eligible: int
    selected: tuple[Candidate, ...]

    @property
    def selected_count(self) -> int:
        return len(self.selected)

    @property
    def shortfall(self) -> int:
        return max(0, self.quota - self.selected_count)

    @property
    def selected_page_ids(self) -> tuple[str, ...]:
        return tuple(candidate.page_id for candidate in self.selected)


@dataclass(frozen=True)
class MergeResult:
    seed: str
    threshold: float
    quota: QuotaTable
    strata: tuple[StratumResult, ...]
    label: str | None = None

    @property
    def selected_page_ids(self) -> tuple[str, ...]:
        return tuple(
            page_id for stratum in self.strata for page_id in stratum.selected_page_ids
        )

    def as_summary(self, label: str | None = None) -> BranchSummary:
        """Return this merge result as a branch summary.

        Because a merge already keeps the bottom ``quota`` candidates per
        stratum, merging summaries of groups is equivalent to merging the
        underlying branches directly.  This allows multi-level roll-ups.
        """

        strata = {
            (result.language, result.tier): StratumSummary(
                language=result.language,
                tier=result.tier,
                eligible=result.eligible,
                candidates=result.selected,
            )
            for result in self.strata
        }
        return BranchSummary(
            seed=self.seed,
            quota=self.quota,
            strata=strata,
            threshold=self.threshold,
            label=label if label is not None else self.label,
        )

    @property
    def totals(self) -> dict[str, int]:
        return {
            "eligible": sum(stratum.eligible for stratum in self.strata),
            "selected": sum(stratum.selected_count for stratum in self.strata),
            "shortfall": sum(stratum.shortfall for stratum in self.strata),
        }

    def report_dict(self) -> dict[str, Any]:
        return {
            "schema": REPORT_SCHEMA,
            "seed": self.seed,
            "threshold": self.threshold,
            "totals": self.totals,
            "strata": [
                {
                    "language": stratum.language,
                    "tier": stratum.tier,
                    "quota": stratum.quota,
                    "eligible": stratum.eligible,
                    "selected_count": stratum.selected_count,
                    "shortfall": stratum.shortfall,
                    "selected_page_ids": list(stratum.selected_page_ids),
                }
                for stratum in self.strata
            ],
        }

    def selection_dict(self) -> dict[str, Any]:
        return {
            "schema": SELECTION_SCHEMA,
            "seed": self.seed,
            "threshold": self.threshold,
            "selected": [
                {
                    "page_id": candidate.page_id,
                    "language": stratum.language,
                    "tier": stratum.tier,
                    "priority": candidate.priority,
                }
                for stratum in self.strata
                for candidate in stratum.selected
            ],
        }


def merge_summaries(
    summaries: Sequence[BranchSummary],
    *,
    quota: Mapping[str, Mapping[str, int]] | None = None,
) -> MergeResult:
    """Merge branch summaries into the final review list and per-stratum report.

    All summaries must have been produced with the same seed, threshold, and
    quota table.  When ``quota`` is omitted it is taken from the summaries.
    """

    if not summaries:
        raise SamplingError("merge: at least one summary is required")

    base = summaries[0]
    for index, summary in enumerate(summaries[1:], start=1):
        if summary.seed != base.seed:
            raise SamplingError(
                f"merge: summary {index} uses seed {summary.seed!r}, "
                f"but summary 0 uses {base.seed!r}"
            )
        if summary.threshold != base.threshold:
            raise SamplingError("merge: summaries use different thresholds")
        if summary.quota != base.quota:
            raise SamplingError(
                f"merge: summary {index} uses a different quota table "
                f"than summary 0"
            )

    if quota is not None:
        normalized = normalize_quota(quota, source="merge: quota table")
        if normalized != base.quota:
            raise SamplingError(
                "merge: the supplied quota table does not match the quota "
                "recorded in the summaries"
            )
        used_quota = normalized
    else:
        used_quota = {language: dict(tiers) for language, tiers in base.quota.items()}

    eligible: dict[StratumKey, int] = {}
    pools: dict[StratumKey, list[Candidate]] = {}
    candidate_origins: dict[str, str] = {}
    for index, summary in enumerate(summaries):
        label = summary.label or f"summary {index}"
        for key, stratum in summary.strata.items():
            eligible[key] = eligible.get(key, 0) + stratum.eligible
            for candidate in stratum.candidates:
                if priority_for(base.seed, candidate.page_id) != candidate.priority:
                    raise SamplingError(
                        f"merge: candidate {candidate.page_id!r} in {label!r} has "
                        f"a priority that does not match the merge seed"
                    )
                if candidate.page_id in candidate_origins:
                    raise SamplingError(
                        f"merge: page_id {candidate.page_id!r} is a candidate in "
                        f"both {candidate_origins[candidate.page_id]!r} and "
                        f"{label!r}; branches must cover disjoint page IDs"
                    )
                candidate_origins[candidate.page_id] = label
                pools.setdefault(key, []).append(candidate)

    all_keys = quota_strata(used_quota) | set(eligible) | set(pools)
    results: list[StratumResult] = []
    for key in sorted(all_keys, key=stratum_sort_key):
        language, tier = key
        quota_value = quota_for(used_quota, language, tier)
        eligible_count = eligible.get(key, 0)
        pool = sorted(pools.get(key, ()), key=lambda candidate: candidate.sort_key)
        selected = tuple(pool[:quota_value])
        expected_selected = min(quota_value, eligible_count)
        if len(selected) != expected_selected:
            raise SamplingError(
                f"merge: internal invariant violated for {language!r}/{tier}: "
                f"{len(selected)} candidates available, {eligible_count} eligible, "
                f"quota {quota_value}"
            )
        results.append(
            StratumResult(
                language=language,
                tier=tier,
                quota=quota_value,
                eligible=eligible_count,
                selected=selected,
            )
        )

    return MergeResult(
        seed=base.seed,
        threshold=base.threshold,
        quota=used_quota,
        strata=tuple(results),
        label=None,
    )


# ---------------------------------------------------------------------------
# one-shot reference sampler (used to verify merge equivalence)
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class DirectSelection:
    eligible: Mapping[StratumKey, int]
    selected: Mapping[StratumKey, tuple[str, ...]]


def select_directly(
    records: Iterable[PageRecord],
    *,
    seed: str,
    quota: Mapping[str, Mapping[str, int]],
    reviewed_ids: frozenset[str] | set[str] = frozenset(),
) -> DirectSelection:
    """Sample all records in one pass, without branch summaries.

    This is the reference implementation: for each stratum it retains the
    ``quota`` smallest (priority, page_id) keys of the whole data set.
    """

    seed = _require_str(seed, "seed")
    normalized_quota = normalize_quota(quota)
    eligible: dict[StratumKey, int] = {}
    groups: dict[StratumKey, list[tuple[str, str]]] = {}
    for record in records:
        if record.page_id in reviewed_ids:
            continue
        key = (record.language, tier_for_confidence(record.confidence))
        eligible[key] = eligible.get(key, 0) + 1
        groups.setdefault(key, []).append(
            (priority_for(seed, record.page_id), record.page_id)
        )

    selected: dict[StratumKey, tuple[str, ...]] = {}
    all_keys = quota_strata(normalized_quota) | set(eligible)
    for key in all_keys:
        eligible.setdefault(key, 0)
    for key in sorted(all_keys, key=stratum_sort_key):
        language, tier = key
        quota_value = quota_for(normalized_quota, language, tier)
        entries = sorted(groups.get(key, ()))
        selected[key] = tuple(page_id for _, page_id in entries[:quota_value])

    return DirectSelection(eligible=eligible, selected=selected)
