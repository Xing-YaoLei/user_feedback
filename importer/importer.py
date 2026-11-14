#!/usr/bin/env python3
"""Annotation import / migration pipeline.

Inputs
------
1. A directory of UTF-8 draft files named ``<doc_id>.txt``.  The draft digest
   is computed over the *raw bytes*; CRLF is normalised to LF only afterwards.
2. A JSONL revision stream arranged by document (all records of one document
   contiguous, in order).  Each revision carries the parent digest, the
   post-revision digest and a group of insert / delete / replace operations
   whose ranges are codepoint coordinates on the pre-revision normalised
   text, sorted by position and mutually non-overlapping.  Insert text uses
   LF line endings.
3. A JSONL annotation stream.  Every annotation carries the document id, the
   SHA-256 of the version it was made against, a category and a zero-based,
   end-exclusive UTF-16 range.

The pipeline rebuilds every version chain, verifies all digests, interprets
annotations on their declared source version, migrates them across the
revisions that follow, and emits the still-valid annotations in final-text
codepoint coordinates.  Annotations whose selected text was deleted/replaced
or whose interior received an insertion -- plus initial-draft annotations
whose boundary cuts a CRLF sequence or a surrogate pair -- are routed to
manual review, naming the first version and operation that conflicted.

A broken chain for one document is reported at the first failing version and
never blocks the other documents.
"""

from __future__ import annotations

import argparse
import bisect
import hashlib
import json
import os
import sys
from dataclasses import dataclass, field
from typing import Any, Iterable


# ---------------------------------------------------------------------------
# Small helpers
# ---------------------------------------------------------------------------

def sha256_hex(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def digest_text(text: str) -> str:
    """Digest of a normalised version: SHA-256 of its UTF-8 encoding."""
    return sha256_hex(text.encode("utf-8"))


def normalise_crlf(text: str) -> str:
    """CRLF -> LF.  Lone CR characters are deliberately left untouched."""
    return text.replace("\r\n", "\n")


def _pick(record: dict, *names: str) -> Any:
    for name in names:
        if name in record:
            return record[name]
    raise KeyError(f"missing field, expected one of {names}")


# ---------------------------------------------------------------------------
# UTF-16 boundary handling
# ---------------------------------------------------------------------------

@dataclass
class Utf16Layout:
    """Precomputed UTF-16 layout of a codepoint string."""

    unit_starts: list[int]          # UTF-16 unit index where each cp starts
    total_units: int
    norm_cp_index: list[int] | None = None  # cp index after normalisation (-1 for dropped CR)

    def boundary_status(self, unit: int) -> str | None:
        """Return None when ``unit`` is a legal UTF-16 boundary, else a reason."""
        if unit < 0 or unit > self.total_units:
            return "UTF-16 offset out of range"
        if unit == 0 or unit == self.total_units:
            return None
        idx = bisect.bisect_left(self.unit_starts, unit)
        # idx is the first cp whose start unit >= unit.  Equal means a legal
        # boundary; otherwise unit sits inside the previous cp, which can only
        # be the middle of a surrogate pair (BMP cps are exactly one unit).
        if idx < len(self.unit_starts) and self.unit_starts[idx] == unit:
            return None
        return "boundary splits a UTF-16 surrogate pair"

    def to_codepoint(self, unit: int) -> int:
        """Codepoint offset of a legal UTF-16 unit boundary."""
        return bisect.bisect_left(self.unit_starts, unit)


def build_layout(text: str) -> Utf16Layout:
    starts: list[int] = []
    u = 0
    for ch in text:
        starts.append(u)
        u += 2 if ord(ch) > 0xFFFF else 1
    return Utf16Layout(starts, u)


def build_raw_draft_layout(raw: str) -> Utf16Layout:
    """Layout for an unnormalised draft.

    ``norm_cp_index`` maps every retained codepoint to its index in the
    CRLF-normalised text.  A CR that is part of a CRLF pair gets -1.
    """
    starts: list[int] = []
    norm_index: list[int] = []
    u = 0
    norm_cp = 0
    for idx, ch in enumerate(raw):
        starts.append(u)
        u += 2 if ord(ch) > 0xFFFF else 1
        if ch == "\r" and idx + 1 < len(raw) and raw[idx + 1] == "\n":
            norm_index.append(-1)
        else:
            norm_index.append(norm_cp)
            norm_cp += 1
    return Utf16Layout(starts, u, norm_index)


def crlf_cut(layout: Utf16Layout, raw: str, unit: int) -> bool:
    """True when a UTF-16 boundary falls between the CR and LF of a CRLF pair.

    Such a boundary has no counterpart after CRLF->LF normalisation (the two
    units collapse into one codepoint), so the annotation cannot be mapped.
    Boundaries before the CR or after the LF are ordinary character
    boundaries and map cleanly onto the normalised line-break position.
    """
    for idx, start in enumerate(layout.unit_starts):
        if (
            raw[idx] == "\r"
            and idx + 1 < len(raw)
            and raw[idx + 1] == "\n"
            and start + 1 == unit  # CR and LF are BMP: one UTF-16 unit each
        ):
            return True
    return False


def map_raw_boundary_to_norm(layout: Utf16Layout, unit: int) -> int:
    """Map a legal raw-text UTF-16 boundary to a normalised codepoint offset."""
    assert layout.norm_cp_index is not None
    if unit == 0:
        return 0
    if unit == layout.total_units:
        return max(layout.norm_cp_index) + 1
    cp_idx = bisect.bisect_left(layout.unit_starts, unit)
    j = cp_idx
    while layout.norm_cp_index[j] < 0:  # skip CRLF-contained CRs (at most one)
        j += 1
    return layout.norm_cp_index[j]


# ---------------------------------------------------------------------------
# Revisions
# ---------------------------------------------------------------------------

@dataclass
class Op:
    kind: str           # "insert" | "delete" | "replace"
    position: int       # pre-revision codepoint coordinate (insert point or span start)
    end: int            # span end for delete/replace, equal to position for insert
    text: str           # inserted/replacement text ("" for delete)
    index: int          # 0-based position inside the operation group

    @property
    def span(self) -> tuple[int, int]:
        return self.position, self.end

    def as_dict(self) -> dict:
        out: dict[str, Any] = {"type": self.kind, "position": self.position}
        if self.kind != "insert":
            out["end"] = self.end
        if self.kind != "delete":
            out["text"] = self.text
        out["op_index"] = self.index
        return out


@dataclass
class Revision:
    parent_digest: str
    post_digest: str
    ops: list[Op]
    line_no: int


class ChainError(Exception):
    """A version-chain failure: processing of this document must stop."""


def parse_op(raw_op: dict, index: int) -> Op:
    kind = str(_pick(raw_op, "type", "op", "kind")).lower()
    if kind not in ("insert", "delete", "replace"):
        raise ChainError(f"unknown operation type {kind!r}")
    text = raw_op.get("text", raw_op.get("insert", raw_op.get("replacement", "")))
    if text is None:
        text = ""
    if not isinstance(text, str):
        raise ChainError("operation text must be a string")
    if "\r" in text:
        raise ChainError("inserted text must use LF line endings")
    if kind == "insert":
        p = int(_pick(raw_op, "position", "pos", "p", "start", "s"))
        return Op(kind, p, p, text, index)
    start = int(_pick(raw_op, "start", "s", "position", "pos"))
    end = int(_pick(raw_op, "end", "e"))
    return Op(kind, start, end, text, index)


def validate_and_apply(text: str, ops: list[Op]) -> str:
    """Validate one operation group against pre-revision ``text`` and apply it."""
    ordered = sorted(enumerate(ops), key=lambda pair: (pair[1].position, pair[0]))
    ordered_ops = [op for _, op in ordered]
    n = len(text)
    cursor = 0
    parts: list[str] = []
    for op in ordered_ops:
        if op.kind == "insert":
            if not 0 <= op.position <= n:
                raise ChainError(
                    f"insert position {op.position} out of range (text length {n})"
                )
            if op.position < cursor:
                raise ChainError("operations overlap")
            parts.append(text[cursor:op.position])
            parts.append(op.text)
            cursor = op.position
            continue
        s, e = op.position, op.end
        if not 0 <= s < e <= n:
            raise ChainError(f"operation span [{s}, {e}) out of range (length {n})")
        if s < cursor:
            raise ChainError("operations overlap")
        parts.append(text[cursor:s])
        if op.kind == "replace":
            parts.append(op.text)
        cursor = e
    parts.append(text[cursor:])
    return "".join(parts)


# ---------------------------------------------------------------------------
# Interval migration
# ---------------------------------------------------------------------------

@dataclass
class Conflict:
    version_digest: str
    op: Op
    reason: str


def migrate_interval(
    start: int, end: int, ops: list[Op], version_digest: str
) -> tuple[int, int] | Conflict:
    """Migrate a codepoint interval across one revision.

    Conflict detection always uses the original pre-revision interval so that
    shifts caused by earlier operations cannot create false positives.
    """
    a0, b0 = start, end
    new_a, new_b = a0, b0
    for op in sorted(ops, key=lambda o: (o.position, o.index)):
        if op.kind == "insert":
            p = op.position
            if a0 < p < b0:
                return Conflict(
                    version_digest, op, "insertion falls inside the annotated range"
                )
            if p <= a0:
                new_a += len(op.text)
                new_b += len(op.text)
        else:
            s, e = op.span
            # Overlap test on codepoint spans, end-exclusive on both sides.
            if s < b0 and e > a0:
                reason = (
                    "replacement covers an annotated character"
                    if op.kind == "replace"
                    else "deletion covers an annotated character"
                )
                return Conflict(version_digest, op, reason)
            if e <= a0:
                delta = len(op.text) - (e - s)
                new_a += delta
                new_b += delta
    return new_a, new_b


# ---------------------------------------------------------------------------
# Loading
# ---------------------------------------------------------------------------

def load_jsonl(path: str) -> list[tuple[int, dict]]:
    records: list[tuple[int, dict]] = []
    with open(path, "r", encoding="utf-8") as fh:
        for line_no, line in enumerate(fh, 1):
            line = line.strip()
            if not line:
                continue
            try:
                record = json.loads(line)
            except json.JSONDecodeError as exc:
                raise ValueError(f"{path}:{line_no}: invalid JSON: {exc}") from exc
            if not isinstance(record, dict):
                raise ValueError(f"{path}:{line_no}: JSONL record must be an object")
            records.append((line_no, record))
    return records


def group_revisions(
    records: list[tuple[int, dict]],
) -> dict[str, list[Revision]]:
    """Group the document-arranged revision stream by document id.

    All records of one document must be contiguous; a document that reappears
    after another document was seen violates the document-arranged contract.
    """
    grouped: dict[str, list[Revision]] = {}
    seen_closed: set[str] = set()
    current_doc: str | None = None
    for line_no, record in records:
        kind = str(record.get("type", record.get("kind", "revision"))).lower()
        if kind in ("root", "draft", "initial"):
            # Optional root declarations are consumed while documents are built.
            continue
        if "revisions" in record and isinstance(record["revisions"], list):
            doc_id = str(_pick(record, "doc_id", "document_id", "doc"))
            if doc_id in seen_closed:
                raise ValueError(
                    f"line {line_no}: revision stream must be arranged by "
                    f"document; {doc_id!r} records are not contiguous"
                )
            out = grouped.setdefault(doc_id, [])
            for sub in record["revisions"]:
                out.append(_parse_revision(sub, line_no))
            seen_closed.add(doc_id)
            current_doc = None
            continue
        doc_id = str(_pick(record, "doc_id", "document_id", "doc"))
        if doc_id != current_doc:
            if doc_id in seen_closed:
                raise ValueError(
                    f"line {line_no}: revision stream must be arranged by "
                    f"document; {doc_id!r} records are not contiguous"
                )
            if current_doc is not None:
                seen_closed.add(current_doc)
            current_doc = doc_id
        grouped.setdefault(doc_id, []).append(_parse_revision(record, line_no))
    return grouped


def _parse_revision(record: dict, line_no: int) -> Revision:
    parent = _pick(record, "parent_digest", "parent_sha256", "base_digest", "parent")
    post = _pick(
        record,
        "post_digest",
        "result_digest",
        "new_digest",
        "digest",
        "post_sha256",
    )
    raw_ops = _pick(record, "ops", "operations")
    if not isinstance(raw_ops, list):
        raise ChainError(f"line {line_no}: operations must be a list")
    ops = [parse_op(raw, idx) for idx, raw in enumerate(raw_ops)]
    return Revision(str(parent), str(post), ops, line_no)


def root_digest_overrides(records: list[tuple[int, dict]]) -> dict[str, str]:
    overrides: dict[str, str] = {}
    for _, record in records:
        kind = str(record.get("type", record.get("kind", ""))).lower()
        if kind in ("root", "draft", "initial"):
            doc_id = str(_pick(record, "doc_id", "document_id", "doc"))
            digest = _pick(record, "root_digest", "draft_digest", "digest")
            overrides[doc_id] = str(digest)
    return overrides


@dataclass
class Annotation:
    doc_id: str
    version_digest: str
    category: str
    utf16_start: int
    utf16_end: int
    line_no: int


def load_annotations(path: str) -> list[Annotation]:
    annotations: list[Annotation] = []
    for line_no, record in load_jsonl(path):
        annotations.append(
            Annotation(
                doc_id=str(_pick(record, "doc_id", "document_id", "doc")),
                version_digest=str(
                    _pick(
                        record,
                        "version",
                        "version_digest",
                        "source_version",
                        "source_sha256",
                        "sha256",
                    )
                ),
                category=str(_pick(record, "category", "label")),
                utf16_start=int(_pick(record, "start", "start_utf16", "start_offset")),
                utf16_end=int(_pick(record, "end", "end_utf16", "end_offset")),
                line_no=line_no,
            )
        )
    return annotations


# ---------------------------------------------------------------------------
# Per-document pipeline
# ---------------------------------------------------------------------------

@dataclass
class BuiltDocument:
    doc_id: str
    versions: list[str] = field(default_factory=list)          # normalised texts
    digests: list[str] = field(default_factory=list)           # one digest per version
    chain_error: str | None = None
    failed_version: int | None = None                          # 0-based version index


def build_document(
    doc_id: str,
    draft_path: str | None,
    revisions: list[Revision],
    root_override: str | None,
) -> BuiltDocument:
    doc = BuiltDocument(doc_id=doc_id)
    if draft_path is None:
        doc.chain_error = "draft file is missing"
        doc.failed_version = 0
        return doc
    try:
        with open(draft_path, "rb") as fh:
            raw_bytes = fh.read()
    except OSError as exc:
        doc.chain_error = f"cannot read draft: {exc}"
        doc.failed_version = 0
        return doc

    root_digest = sha256_hex(raw_bytes)
    if root_override is not None and root_override != root_digest:
        doc.chain_error = (
            f"root digest mismatch: declared {root_override}, computed {root_digest}"
        )
        doc.failed_version = 0
        return doc
    try:
        raw_text = raw_bytes.decode("utf-8")
    except UnicodeDecodeError as exc:
        doc.chain_error = f"draft is not valid UTF-8: {exc}"
        doc.failed_version = 0
        return doc

    text = normalise_crlf(raw_text)
    doc.versions.append(text)
    doc.digests.append(root_digest)

    for rev_idx, rev in enumerate(revisions, start=1):
        if rev.parent_digest != doc.digests[-1]:
            doc.chain_error = (
                f"revision {rev_idx} (line {rev.line_no}): parent digest "
                f"{rev.parent_digest} does not match previous version "
                f"{doc.digests[-1]}"
            )
            doc.failed_version = rev_idx
            return doc
        try:
            new_text = validate_and_apply(text, rev.ops)
        except ChainError as exc:
            doc.chain_error = (
                f"revision {rev_idx} (line {rev.line_no}): {exc}"
            )
            doc.failed_version = rev_idx
            return doc
        actual = digest_text(new_text)
        if actual != rev.post_digest:
            doc.chain_error = (
                f"revision {rev_idx} (line {rev.line_no}): post-revision digest "
                f"mismatch: declared {rev.post_digest}, computed {actual}"
            )
            doc.failed_version = rev_idx
            return doc
        text = new_text
        doc.versions.append(text)
        doc.digests.append(rev.post_digest)
    return doc


def run_pipeline(
    drafts_dir: str,
    revisions_path: str,
    annotations_path: str,
    out_dir: str,
) -> dict[str, int]:
    revision_records = load_jsonl(revisions_path)
    grouped = group_revisions(revision_records)
    root_overrides = root_digest_overrides(revision_records)
    annotations = load_annotations(annotations_path)

    draft_files: dict[str, str] = {}
    if os.path.isdir(drafts_dir):
        for name in sorted(os.listdir(drafts_dir)):
            if name.endswith(".txt"):
                draft_files[name[:-4]] = os.path.join(drafts_dir, name)

    doc_ids = sorted(
        set(grouped) | set(draft_files) | {ann.doc_id for ann in annotations}
    )

    # Keep the parsed revision groups accessible while migrating.
    built: dict[str, BuiltDocument] = {}
    raw_layouts: dict[str, tuple[Utf16Layout, str]] = {}
    chain_errors: list[dict] = []

    for doc_id in doc_ids:
        doc = build_document(
            doc_id,
            draft_files.get(doc_id),
            grouped.get(doc_id, []),
            root_overrides.get(doc_id),
        )
        built[doc_id] = doc
        if doc.chain_error is not None:
            chain_errors.append(
                {
                    "doc_id": doc_id,
                    "failed_version": doc.failed_version,
                    "reason": doc.chain_error,
                }
            )
        if doc_id in draft_files:
            with open(draft_files[doc_id], "rb") as fh:
                raw_bytes = fh.read()
            # build_document already rejected invalid UTF-8 for chain-valid docs.
            try:
                raw_text = raw_bytes.decode("utf-8")
            except UnicodeDecodeError:
                raw_text = None
            if raw_text is not None:
                raw_layouts[doc_id] = (build_raw_draft_layout(raw_text), raw_text)

    migrated: list[dict] = []
    review: list[dict] = []

    for ann in annotations:
        doc = built.get(ann.doc_id)
        if doc is None:
            review.append(
                {
                    "doc_id": ann.doc_id,
                    "category": ann.category,
                    "source_version_digest": ann.version_digest,
                    "original_utf16_range": [ann.utf16_start, ann.utf16_end],
                    "annotation_line": ann.line_no,
                    "status": "review",
                    "reason": "document is unknown to the import",
                }
            )
            continue
        if doc.chain_error is not None:
            review.append(
                {
                    "doc_id": ann.doc_id,
                    "category": ann.category,
                    "source_version_digest": ann.version_digest,
                    "original_utf16_range": [ann.utf16_start, ann.utf16_end],
                    "annotation_line": ann.line_no,
                    "status": "review",
                    "reason": (
                        f"version chain failed at version {doc.failed_version}: "
                        f"{doc.chain_error}"
                    ),
                }
            )
            continue

        record = _migrate_one(ann, doc, grouped.get(ann.doc_id, []), raw_layouts)
        if record["status"] == "review":
            review.append(record)
        else:
            migrated.append(record)

    os.makedirs(out_dir, exist_ok=True)
    _write_jsonl(os.path.join(out_dir, "migrated.jsonl"), migrated)
    _write_jsonl(os.path.join(out_dir, "review.jsonl"), review)
    _write_jsonl(os.path.join(out_dir, "chain_errors.jsonl"), chain_errors)

    summary = {
        "documents": len(doc_ids),
        "chain_errors": len(chain_errors),
        "annotations": len(annotations),
        "migrated": len(migrated),
        "review": len(review),
    }
    with open(os.path.join(out_dir, "summary.json"), "w", encoding="utf-8") as fh:
        json.dump(summary, fh, ensure_ascii=False, indent=2)
        fh.write("\n")
    return summary


def _migrate_one(
    ann: Annotation,
    doc: BuiltDocument,
    revisions: list[Revision],
    raw_layouts: dict[str, tuple[Utf16Layout, str]],
) -> dict:
    base: dict[str, Any] = {
        "doc_id": ann.doc_id,
        "category": ann.category,
        "source_version_digest": ann.version_digest,
        "original_utf16_range": [ann.utf16_start, ann.utf16_end],
        "annotation_line": ann.line_no,
    }

    if ann.version_digest not in doc.digests:
        return {
            **base,
            "status": "review",
            "reason": "source version digest is not part of the verified chain",
        }
    source_idx = doc.digests.index(ann.version_digest)
    source_text = doc.versions[source_idx]

    if source_idx == 0:
        layout, raw_text = raw_layouts[ann.doc_id]
        for boundary in (ann.utf16_start, ann.utf16_end):
            reason = layout.boundary_status(boundary)
            if reason is not None:
                return {**base, "status": "review", "reason": reason}
            if crlf_cut(layout, raw_text, boundary):
                return {
                    **base,
                    "status": "review",
                    "reason": "boundary cuts through a CRLF sequence in the draft",
                }
        cp_start = map_raw_boundary_to_norm(layout, ann.utf16_start)
        cp_end = map_raw_boundary_to_norm(layout, ann.utf16_end)
    else:
        layout = build_layout(source_text)
        for boundary in (ann.utf16_start, ann.utf16_end):
            reason = layout.boundary_status(boundary)
            if reason is not None:
                return {**base, "status": "review", "reason": reason}
        cp_start = layout.to_codepoint(ann.utf16_start)
        cp_end = layout.to_codepoint(ann.utf16_end)

    if cp_start > cp_end:
        return {
            **base,
            "status": "review",
            "reason": "start offset is after end offset after normalisation",
        }

    a, b = cp_start, cp_end
    for rev_offset, rev in enumerate(revisions[source_idx:], start=source_idx + 1):
        version_digest = doc.digests[rev_offset]
        outcome = migrate_interval(a, b, rev.ops, version_digest)
        if isinstance(outcome, Conflict):
            return {
                **base,
                "status": "review",
                "reason": outcome.reason,
                "conflict_version_digest": outcome.version_digest,
                "conflict_op_index": outcome.op.index,
                "conflict_op": outcome.op.as_dict(),
            }
        a, b = outcome

    final_text = doc.versions[-1]
    return {
        **base,
        "status": "migrated",
        "final_codepoint_range": [a, b],
        "excerpt": final_text[a:b],
    }


def _write_jsonl(path: str, rows: Iterable[dict]) -> None:
    with open(path, "w", encoding="utf-8") as fh:
        for row in rows:
            fh.write(json.dumps(row, ensure_ascii=False))
            fh.write("\n")


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Rebuild version chains and migrate annotations to final text."
    )
    parser.add_argument("--drafts", required=True, help="directory of <doc_id>.txt")
    parser.add_argument("--revisions", required=True, help="JSONL revision stream")
    parser.add_argument("--annotations", required=True, help="JSONL annotations")
    parser.add_argument("--out", required=True, help="output directory")
    args = parser.parse_args(argv)

    try:
        summary = run_pipeline(
            args.drafts, args.revisions, args.annotations, args.out
        )
    except (OSError, ValueError, ChainError) as exc:
        # Fatal input problems (missing files, malformed JSONL, stream ordering).
        print(f"import aborted: {exc}", file=sys.stderr)
        return 1
    print(json.dumps(summary, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
