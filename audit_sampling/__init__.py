"""Deterministic, mergeable stratified sampling for distributed branch summaries.

See :mod:`audit_sampling.core` for the algorithm and :mod:`audit_sampling.cli`
for the command line interface.
"""

from .core import (
    LOW_CONFIDENCE_THRESHOLD,
    BranchSummary,
    Candidate,
    DirectSelection,
    MergeResult,
    PageRecord,
    SamplingError,
    StratumResult,
    StratumSummary,
    merge_summaries,
    normalize_quota,
    priority_for,
    quota_for,
    select_directly,
    stratum_sort_key,
    summary_from_dict,
    summary_to_dict,
    summarize_records,
    tier_for_confidence,
)
from .io import (
    iter_page_records,
    iter_page_records_many,
    read_reviewed_ids,
    write_json,
)

__all__ = [
    "LOW_CONFIDENCE_THRESHOLD",
    "BranchSummary",
    "Candidate",
    "DirectSelection",
    "MergeResult",
    "PageRecord",
    "SamplingError",
    "StratumResult",
    "StratumSummary",
    "merge_summaries",
    "normalize_quota",
    "priority_for",
    "quota_for",
    "select_directly",
    "stratum_sort_key",
    "summary_from_dict",
    "summary_to_dict",
    "summarize_records",
    "tier_for_confidence",
    "iter_page_records",
    "iter_page_records_many",
    "read_reviewed_ids",
    "write_json",
]

__version__ = "1.0.0"
