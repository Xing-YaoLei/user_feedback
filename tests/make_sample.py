#!/usr/bin/env python3
"""Generate a small sample dataset under ./sample_data so the CLI can be run
by hand.  All digests are computed exactly as the pipeline expects:

* root digest  = SHA-256 of the raw draft bytes
* post digest  = SHA-256 of the normalised post-revision UTF-8 text
"""

from __future__ import annotations

import hashlib
import json
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "importer"))
import importer as imp  # noqa: E402

ROOT = os.path.join(os.path.dirname(__file__), "..", "sample_data")


def sha_raw(b: bytes) -> str:
    return hashlib.sha256(b).hexdigest()


def sha_text(t: str) -> str:
    return hashlib.sha256(t.encode("utf-8")).hexdigest()


def write_jsonl(path: str, rows: list[dict]) -> None:
    with open(path, "w", encoding="utf-8") as fh:
        for row in rows:
            fh.write(json.dumps(row, ensure_ascii=False) + "\n")


def main() -> None:
    drafts = os.path.join(ROOT, "drafts")
    os.makedirs(drafts, exist_ok=True)

    # doc1: CRLF draft, two revisions
    raw1 = "alpha\r\nbeta\r\n".encode("utf-8")
    with open(os.path.join(drafts, "doc1.txt"), "wb") as fh:
        fh.write(raw1)
    root1 = sha_raw(raw1)
    v0_1 = imp.normalise_crlf(raw1.decode("utf-8"))

    ops1 = [{"type": "replace", "start": 6, "end": 10, "text": "BETA"}]
    v1_1 = imp.validate_and_apply(v0_1, [imp.parse_op(o, 0) for o in ops1])
    post1 = sha_text(v1_1)

    ops2 = [{"type": "insert", "position": 0, "text": "NOTE: "}]
    v2_1 = imp.validate_and_apply(v1_1, [imp.parse_op(o, 0) for o in ops2])
    post2 = sha_text(v2_1)

    revisions = [
        {"doc_id": "doc1", "parent_digest": root1, "post_digest": post1, "ops": ops1},
        {"doc_id": "doc1", "parent_digest": post1, "post_digest": post2, "ops": ops2},
    ]
    write_jsonl(os.path.join(ROOT, "revisions.jsonl"), revisions)

    # UTF-16 ground truth for the raw draft (CRLF counts as two units)
    raw_str = raw1.decode("utf-8")
    u16 = {}
    unit = 0
    for idx, ch in enumerate(raw_str):
        u16[idx] = unit
        unit += 2 if ord(ch) > 0xFFFF else 1
    u16[len(raw_str)] = unit

    annotations = [
        # "alpha" at the start of the draft: clean boundary, survives migration
        {"doc_id": "doc1", "version": root1, "category": "word",
         "start": 0, "end": 5},
        # boundary 6 sits between CR and LF -> manual review
        {"doc_id": "doc1", "version": root1, "category": "bad_break",
         "start": 6, "end": 7},
        # "BETA" annotated on version 1 (post revision 1), UTF-16 [6,10)
        {"doc_id": "doc1", "version": post1, "category": "shouted",
         "start": 6, "end": 10},
    ]
    write_jsonl(os.path.join(ROOT, "annotations.jsonl"), annotations)

    print("sample data written to", os.path.normpath(ROOT))
    print("final text of doc1:", repr(v2_1))


if __name__ == "__main__":
    main()
