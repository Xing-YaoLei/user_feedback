"""Loading the purpose manifest.

The manifest lists approved sources by master id and purpose, and approval is
resolved for a ``(purpose, master id)`` pair.  A record reaches a result file
only when its source appears in that pair's set.

Accepted shapes, all normalised to the same model:

``{"participants": {"<master id>": {"<purpose>": ["instrument", ...]}}}``
    The canonical shape: approval stated per participant and purpose.

``{"purposes": {"<purpose>": ["instrument", ...]}}``
    A purpose-wide set that applies to every participant of that purpose.
    This is the usual way to approve a whole cohort.

``{"purposes": {"<purpose>": {"sources": [...],
                              "participants": {"<master id>": [...]}}}}``
    A purpose-wide set with per-participant overrides.  An override replaces
    the purpose-wide set for that participant and may be empty, which denies
    the participant outright.

``[{"purpose": ..., "sources": [...], "participants": {...}}, ...]``
    The same information as a list of entries.

Top-level ``participants`` and ``purposes`` are the two container keys.  A
document using ``purposes`` must not carry any other top-level key; a
manifest with neither key is read as a mapping of purpose to sources.
Combining the two containers, or listing a purpose or participant twice with
conflicting approvals, is an error rather than a silent merge.  So is an
unknown source name, a purpose that approves nothing, or a participant entry
that is not a source list.

Resolution is fail-closed: a participant absent from a purpose that has no
purpose-wide sources, and a participant whose override omits the source, are
both denied.
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Dict, FrozenSet, List, Mapping, Tuple

from .errors import LinkageError
from .labels import VALID_SOURCES, normalize_source

_PARTICIPANT_KEYS = ("participants", "master_ids")

# (purpose, master id or None for a purpose-wide set, approved sources)
Entry = Tuple[str, Any, FrozenSet[str]]


@dataclass(frozen=True)
class PurposeApproval:
    """Approval for one purpose: a cohort-wide set plus per-participant sets."""

    sources: FrozenSet[str] = frozenset()
    participants: Mapping[str, FrozenSet[str]] = field(default_factory=dict)

    def approved_for(self, master_id: str) -> FrozenSet[str]:
        """The sources approved for ``master_id`` under this purpose."""
        if master_id in self.participants:
            return self.participants[master_id]
        return self.sources


@dataclass(frozen=True)
class Manifest:
    """Approved sources keyed by purpose."""

    path: str
    purposes: Mapping[str, PurposeApproval]

    def require_purpose(self, purpose: str) -> PurposeApproval:
        """Look up a purpose, raising if it is absent or has a case mismatch."""
        if purpose in self.purposes:
            return self.purposes[purpose]
        folded = {key.casefold() for key in self.purposes}
        if purpose.casefold() in folded:
            close = next(
                key for key in self.purposes if key.casefold() == purpose.casefold()
            )
            raise LinkageError(
                f"purpose {purpose!r} is not listed in the manifest "
                f"(did you mean {close!r}?); purposes are matched exactly"
            )
        known = ", ".join(sorted(self.purposes)) or "none"
        raise LinkageError(
            f"purpose {purpose!r} is not listed in the manifest "
            f"(known purposes: {known})"
        )


def load_manifest(path: Path) -> Manifest:
    """Read and validate the manifest at ``path``."""
    try:
        text = path.read_text(encoding="utf-8-sig")
    except FileNotFoundError as exc:
        raise LinkageError(f"manifest not found: {path}") from exc
    except OSError as exc:
        raise LinkageError(f"cannot read manifest {path}: {exc}") from exc
    try:
        data = json.loads(text, object_pairs_hook=_reject_duplicate_keys)
    except LinkageError:
        raise
    except json.JSONDecodeError as exc:
        raise LinkageError(f"{path}: manifest is not valid JSON: {exc}") from exc

    entries = _collect_entries(data, path)
    purposes = _build(entries, path)
    if not purposes:
        raise LinkageError(f"{path}: manifest lists no purposes")
    return Manifest(path=str(path), purposes=purposes)


def _reject_duplicate_keys(pairs: List[Tuple[str, Any]]) -> Dict[str, Any]:
    """A JSON object with the same key twice is ambiguous; refuse it."""
    result: Dict[str, Any] = {}
    for key, value in pairs:
        if key in result:
            raise LinkageError(f"manifest repeats the key {key!r}")
        result[key] = value
    return result


def _collect_entries(data: Any, path: Path) -> List[Entry]:
    if isinstance(data, list):
        return _entries_from_list(data, path)
    if not isinstance(data, dict):
        raise LinkageError(f"{path}: manifest must be a JSON object or list")

    if "purposes" in data:
        extra = sorted(set(data) - {"purposes"})
        if extra:
            raise LinkageError(
                f"{path}: 'purposes' cannot be combined with other top-level "
                f"keys ({', '.join(extra)})"
            )
        container = data["purposes"]
        if not isinstance(container, dict):
            raise LinkageError(f"{path}: 'purposes' must be an object")
        return _entries_from_mapping(container, path)

    if "participants" in data:
        extra = sorted(set(data) - {"participants"})
        if extra:
            raise LinkageError(
                f"{path}: 'participants' cannot be combined with other top-level "
                f"keys ({', '.join(extra)})"
            )
        if _is_participant_keyed(data["participants"]):
            return _entries_by_participant(data["participants"], path)
        raise LinkageError(
            f"{path}: top-level 'participants' must map master id to "
            "{purpose: [sources]}"
        )

    if "purpose" in data:
        return _entry_from_body(data["purpose"], data, path)

    if not data:
        raise LinkageError(f"{path}: manifest is empty")
    return _entries_from_mapping(data, path)


def _is_participant_keyed(container: Any) -> bool:
    return (
        isinstance(container, dict)
        and bool(container)
        and all(isinstance(value, dict) for value in container.values())
    )


def _entries_from_list(items: List[Any], path: Path) -> List[Entry]:
    entries: List[Entry] = []
    for index, item in enumerate(items, start=1):
        if not isinstance(item, dict):
            raise LinkageError(
                f"{path}: manifest entry {index} must be an object with "
                "'purpose' and 'sources'"
            )
        if "purpose" not in item:
            raise LinkageError(f"{path}: manifest entry {index} needs a 'purpose'")
        entries.extend(_entry_from_body(item["purpose"], item, path))
    return entries


def _entries_from_mapping(mapping: Dict[str, Any], path: Path) -> List[Entry]:
    entries: List[Entry] = []
    for purpose, body in mapping.items():
        entries.extend(_entry_from_body(purpose, body, path))
    return entries


def _entries_by_participant(container: Dict[str, Any], path: Path) -> List[Entry]:
    """``{"<master id>": {"<purpose>": [sources]}}``"""
    entries: List[Entry] = []
    for master_id, purposes in container.items():
        master = _master_id(master_id, f"{path}: participants")
        if not isinstance(purposes, dict):
            raise LinkageError(
                f"{path}: participant {master!r} must map purposes to source lists"
            )
        for purpose, sources in purposes.items():
            key = _purpose_name(purpose, path)
            where = f"{path}: participant {master!r}, purpose {key!r}"
            entries.append((key, master, _parse_sources(sources, where)))
    return entries


def _entry_from_body(purpose: Any, body: Any, path: Path) -> List[Entry]:
    """Entries for one purpose: the purpose-wide set, then per-participant sets."""
    key = _purpose_name(purpose, path)
    where = f"{path}: purpose {key!r}"

    if isinstance(body, dict) and "purpose" in body and body["purpose"] != purpose:
        raise LinkageError(
            f"{where}: entry says purpose {body['purpose']!r}; the key and the "
            "entry must agree"
        )

    if isinstance(body, list):
        return [(key, None, _parse_sources(body, where))]
    if not isinstance(body, dict):
        raise LinkageError(
            f"{where}: must be a list of sources or an object with 'sources'"
        )

    if "sources" not in body and not any(k in body for k in _PARTICIPANT_KEYS):
        raise LinkageError(f"{where}: needs 'sources' and/or 'participants'")

    sources = _parse_sources(body.get("sources", []), where)
    entries: List[Entry] = []
    if sources:
        entries.append((key, None, sources))

    for key_name in _PARTICIPANT_KEYS:
        if key_name not in body:
            continue
        value = body[key_name]
        if not isinstance(value, dict):
            raise LinkageError(
                f"{where}: {key_name!r} must map master id to a list of sources"
            )
        for master_id, master_sources in value.items():
            master = _master_id(master_id, where)
            entries.append(
                (
                    key,
                    master,
                    _parse_sources(master_sources, f"{where}, participant {master!r}"),
                )
            )

    if not entries:
        raise LinkageError(f"{where}: approves no sources")
    return entries


def _purpose_name(purpose: Any, path: Path) -> str:
    if not isinstance(purpose, str) or not purpose.strip():
        raise LinkageError(f"{path}: manifest has a blank or non-string purpose")
    return purpose.strip()


def _master_id(master_id: Any, where: str) -> str:
    if not isinstance(master_id, str) or not master_id.strip():
        raise LinkageError(f"{where}: has a blank or non-string master id")
    return master_id.strip()


def _parse_sources(value: Any, where: str) -> FrozenSet[str]:
    if value is None:
        return frozenset()
    if not isinstance(value, list):
        raise LinkageError(f"{where}: sources must be a list of strings")
    approved = set()
    for raw in value:
        if not isinstance(raw, str) or not raw.strip():
            raise LinkageError(f"{where}: has a blank or non-string source")
        canonical = normalize_source(raw)
        if canonical not in VALID_SOURCES:
            raise LinkageError(
                f"{where}: unknown source {raw!r}; expected one of: "
                f"{', '.join(sorted(VALID_SOURCES))}"
            )
        approved.add(canonical)
    return frozenset(approved)


def _build(entries: List[Entry], path: Path) -> Dict[str, PurposeApproval]:
    wide: Dict[str, FrozenSet[str]] = {}
    narrow: Dict[str, Dict[str, FrozenSet[str]]] = {}
    for purpose, master, sources in entries:
        if master is None:
            previous = wide.get(purpose)
            if previous is not None and previous != sources:
                raise LinkageError(
                    f"{path}: purpose {purpose!r} has conflicting purpose-wide "
                    "source lists"
                )
            wide[purpose] = sources
            narrow.setdefault(purpose, {})
            continue
        scoped = narrow.setdefault(purpose, {})
        previous = scoped.get(master)
        if previous is not None and previous != sources:
            raise LinkageError(
                f"{path}: purpose {purpose!r} lists participant {master!r} "
                "with conflicting source lists"
            )
        scoped[master] = sources

    purposes: Dict[str, PurposeApproval] = {}
    for purpose in narrow:
        approval = PurposeApproval(
            sources=wide.get(purpose, frozenset()),
            participants=dict(narrow[purpose]),
        )
        if not approval.sources and not approval.participants:
            raise LinkageError(f"{path}: purpose {purpose!r} approves no sources")
        purposes[purpose] = approval
    return purposes
