#!/usr/bin/env python3
"""End-to-end and unit tests for the annotation import pipeline."""

from __future__ import annotations

import hashlib
import json
import os
import subprocess
import sys
import tempfile

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "importer"))

import importer as imp  # noqa: E402


def sha(b: bytes) -> str:
    return hashlib.sha256(b).hexdigest()


def d(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def write(path: str, rows: list[dict]) -> None:
    with open(path, "w", encoding="utf-8") as fh:
        for row in rows:
            fh.write(json.dumps(row, ensure_ascii=False) + "\n")


def build_revision(parent_digest_value: str, parent_text: str, ops: list[dict]):
    """Apply ops locally and return (parent_digest, post_digest, applied_text).

    The parent digest is supplied by the caller because the root version's
    digest is computed over raw draft bytes, while later digests are computed
    over the normalised UTF-8 text.
    """
    from importer import Op, validate_and_apply

    parsed = [imp.parse_op(op, i) for i, op in enumerate(ops)]
    new_text = validate_and_apply(parent_text, parsed)
    return parent_digest_value, d(new_text), new_text


# ---------------------------------------------------------------------------
# Unit tests for the coordinate / boundary primitives
# ---------------------------------------------------------------------------

def test_crlf_normalisation_basic():
    assert imp.normalise_crlf("a\r\nb\rc\r\n") == "a\nb\rc\n"


def test_utf16_layout_bmp_and_astral():
    layout = imp.build_layout("a😀b")  # a=0, 😀=1..2, b=3
    assert layout.total_units == 4
    assert layout.boundary_status(0) is None
    assert layout.boundary_status(1) is None
    assert layout.boundary_status(2) == "boundary splits a UTF-16 surrogate pair"
    assert layout.boundary_status(3) is None
    assert layout.boundary_status(4) is None
    assert layout.boundary_status(5) is not None
    assert layout.to_codepoint(3) == 2
    assert layout.to_codepoint(1) == 1


def test_raw_draft_layout_crlf_mapping():
    raw = "A\r\nB"
    layout = imp.build_raw_draft_layout(raw)
    # UTF-16 units: A=0, CR=1, LF=2, B=3 ; normalised cp: A=0, LF=1, B=2
    assert layout.total_units == 4
    # retained cps map onto normalised positions A->0, LF->1, B->2; CR is dropped
    assert layout.norm_cp_index == [0, -1, 1, 2]
    assert imp.crlf_cut(layout, raw, 2) is True   # between CR and LF
    assert imp.crlf_cut(layout, raw, 1) is False  # before CR: ordinary boundary
    assert imp.crlf_cut(layout, raw, 0) is False  # before A
    assert imp.crlf_cut(layout, raw, 3) is False  # before B, outside the pair
    assert imp.crlf_cut(layout, raw, 4) is False  # after B / end of text
    assert imp.map_raw_boundary_to_norm(layout, 0) == 0
    assert imp.map_raw_boundary_to_norm(layout, 1) == 1   # A|CR -> A|LF
    assert imp.map_raw_boundary_to_norm(layout, 3) == 2   # before B
    assert imp.map_raw_boundary_to_norm(layout, 4) == 3   # end


def test_crlf_cut_inside_astral_text():
    raw = "x\r\n😀"
    layout = imp.build_raw_draft_layout(raw)
    # units: x=0, CR=1, LF=2, 😀 high surrogate=3, low surrogate=4
    assert layout.boundary_status(4) == "boundary splits a UTF-16 surrogate pair"
    assert layout.boundary_status(3) is None
    assert imp.crlf_cut(layout, raw, 2) is True


# ---------------------------------------------------------------------------
# Unit tests for interval migration
# ---------------------------------------------------------------------------

def conflict(ops, interval, digest="v"):
    a, b = interval
    out = imp.migrate_interval(a, b, [imp.parse_op(o, i) for i, o in enumerate(ops)], digest)
    return out


def test_migrate_insert_boundaries_not_included():
    # text "abcdef", range [1,4) = "bcd"
    ops = [
        {"type": "insert", "position": 1, "text": "X"},
        {"type": "insert", "position": 4, "text": "YY"},
    ]
    out = conflict(ops, (1, 4))
    assert out == (2, 5)  # both inserts shift, neither selected


def test_migrate_insert_inside_is_conflict():
    ops = [{"type": "insert", "position": 2, "text": "X"}]
    out = conflict(ops, (1, 4))
    assert isinstance(out, imp.Conflict)
    assert out.op.index == 0
    assert "inside" in out.reason


def test_migrate_delete_before_shifts():
    ops = [{"type": "delete", "start": 0, "end": 1}]
    assert conflict(ops, (2, 4)) == (1, 3)


def test_migrate_delete_touching_endpoints_is_safe():
    # deleting exactly the char before start or at end: no overlap
    assert conflict([{"type": "delete", "start": 0, "end": 1}], (1, 3)) == (0, 2)
    assert conflict([{"type": "delete", "start": 3, "end": 4}], (1, 3)) == (1, 3)


def test_migrate_delete_inside_conflict():
    out = conflict([{"type": "delete", "start": 2, "end": 3}], (1, 4))
    assert isinstance(out, imp.Conflict)
    assert "deletion covers" in out.reason


def test_migrate_replace_endpoint_touch_is_safe_and_shifts():
    # replace [1,2) with "ZZZ": range [2,4) starts exactly at the span end,
    # so spans do not overlap; the range shifts by the +2 net length.
    out = imp.migrate_interval(
        2, 4, [imp.parse_op({"type": "replace", "start": 1, "end": 2, "text": "ZZZ"}, 0)], "v"
    )
    assert out == (4, 6)


def test_migrate_replace_covering_range_is_conflict():
    out = conflict(
        [{"type": "replace", "start": 1, "end": 3, "text": "ZZZ"}], (2, 4)
    )
    assert isinstance(out, imp.Conflict)
    assert "replacement covers" in out.reason


def test_migrate_first_conflict_wins_across_ops():
    # two overlapping-delete ops: the earlier one must be reported
    ops = [
        {"type": "delete", "start": 5, "end": 6},   # safe for range [1,4)
        {"type": "delete", "start": 2, "end": 3},   # conflict
    ]
    out = conflict(ops, (1, 4))
    assert isinstance(out, imp.Conflict)
    assert out.op.index == 1


def test_migrate_coordinate_drift_false_positive_guard():
    # insert at position 0 grows the text; a later insert at original position 3
    # which is inside [2,5) must still be detected against the ORIGINAL interval.
    ops = [
        {"type": "insert", "position": 0, "text": "abc"},
        {"type": "insert", "position": 3, "text": "Z"},
    ]
    out = conflict(ops, (2, 5))
    assert isinstance(out, imp.Conflict)
    assert out.op.index == 1


# ---------------------------------------------------------------------------
# End-to-end fixture
# ---------------------------------------------------------------------------

def make_fixture(root: tempfile.TemporaryDirectory) -> tuple[str, str, str, str]:
    drafts = os.path.join(root, "drafts")
    os.makedirs(drafts)

    # --- doc A: CRLF draft, clean two-revision chain -------------------------
    raw_a = "hello\r\nworld\r\n".encode("utf-8")          # normalised v0: "hello\nworld\n"
    with open(os.path.join(drafts, "A.txt"), "wb") as fh:
        fh.write(raw_a)
    root_a = sha(raw_a)
    v0 = "hello\nworld\n"
    # rev 1: insert "!!" at end, delete "world" -> replace [6,11) with "earth"
    parent1, post1, v1 = build_revision(
        root_a, v0, [{"type": "replace", "start": 6, "end": 11, "text": "earth"}]
    )
    assert v1 == "hello\nearth\n"
    # rev 2: insert at the very start and inside an annotation-free spot
    parent2, post2, v2 = build_revision(
        post1,
        v1,
        [
            {"type": "insert", "position": 0, "text": ">>"},
            {"type": "insert", "position": len(v1), "text": "!!"},
        ],
    )
    assert v2 == ">>hello\nearth\n!!"

    # --- doc B: astral draft with a broken chain -----------------------------
    raw_b = "x😀y".encode("utf-8")
    with open(os.path.join(drafts, "B.txt"), "wb") as fh:
        fh.write(raw_b)
    b_parent, b_post, b_v1 = build_revision(
        sha(raw_b), "x😀y", [{"type": "insert", "position": 1, "text": "Q"}]
    )

    # --- doc C: plain LF draft, simple chain ---------------------------------
    raw_c = "abcdef".encode("utf-8")
    with open(os.path.join(drafts, "C.txt"), "wb") as fh:
        fh.write(raw_c)
    c_parent, c_post, c_v1 = build_revision(
        sha(raw_c), "abcdef", [{"type": "replace", "start": 1, "end": 3, "text": "BC"}]
    )
    assert c_v1 == "aBCdef"

    # --- doc G: astral draft, healthy chain, surrogate-cut annotation --------
    raw_g = "x😀y".encode("utf-8")
    with open(os.path.join(drafts, "G.txt"), "wb") as fh:
        fh.write(raw_g)
    g_parent, g_post, g_v1 = build_revision(
        sha(raw_g), "x😀y", [{"type": "insert", "position": 3, "text": "z"}]
    )

    revisions = [
        {"doc_id": "A", "parent_digest": parent1, "post_digest": post1,
         "ops": [{"type": "replace", "start": 6, "end": 11, "text": "earth"}]},
        {"doc_id": "A", "parent_digest": parent2, "post_digest": post2,
         "ops": [
             {"type": "insert", "position": 0, "text": ">>"},
             {"type": "insert", "position": len(v1), "text": "!!"},
         ]},
        {"doc_id": "B", "parent_digest": b_parent,
         "post_digest": "deadbeef" * 8,  # intentionally wrong
         "ops": [{"type": "insert", "position": 1, "text": "Q"}]},
        {"doc_id": "C", "parent_digest": c_parent, "post_digest": c_post,
         "ops": [{"type": "replace", "start": 1, "end": 3, "text": "BC"}]},
        {"doc_id": "G", "parent_digest": g_parent, "post_digest": g_post,
         "ops": [{"type": "insert", "position": 3, "text": "z"}]},
    ]
    rev_path = os.path.join(root, "revisions.jsonl")
    write(rev_path, revisions)

    # UTF-16 offsets (Python's utf-16-le len gives us ground truth)
    def u16(text: str) -> int:
        return len(text.encode("utf-16-le")) // 2

    annotations = [
        # A/v0: "hello" in raw CRLF draft -> raw units [0,5), safe boundary
        {"doc_id": "A", "version": sha(raw_a), "category": "greeting",
         "start": 0, "end": 5},
        # A/v0: boundary 6 sits between CR and LF (CR=5, LF=6): must be review
        {"doc_id": "A", "version": sha(raw_a), "category": "linebreak",
         "start": 6, "end": 7},
        # A/v1: "earth" in "hello\nearth\n" -> cp [6,11), utf16 same
        {"doc_id": "A", "version": post1, "category": "planet",
         "start": 6, "end": 11},
        # A/v1: empty-range annotation at position 0; inserts at 0 must not conflict
        {"doc_id": "A", "version": post1, "category": "point",
         "start": 0, "end": 0},
        # B/v0: surrogate-pair cut annotation, but B's chain is broken first;
        # the chain failure is what must reach the review queue for this doc
        {"doc_id": "B", "version": sha(raw_b), "category": "emoji",
         "start": 1, "end": 3},
        # B/v0: valid annotation, but chain is broken -> review regardless
        {"doc_id": "B", "version": sha(raw_b), "category": "plain",
         "start": 0, "end": 1},
        # G/v0: boundary 2 splits the emoji surrogate pair -> review
        {"doc_id": "G", "version": sha(raw_g), "category": "emoji",
         "start": 2, "end": 3},
        # G/v0: valid range over the astral cp, units [1,3) -> cp [1,2);
        # insert at cp 3 lands after it, so it migrates unchanged to [1,2)
        {"doc_id": "G", "version": sha(raw_g), "category": "face",
         "start": 1, "end": 3},
        # C/v0: range [1,3) = "bc"; rev1 replaces it -> conflict, rev 1 op 0
        {"doc_id": "C", "version": sha(raw_c), "category": "letters",
         "start": 1, "end": 3},
        # C/v0: range [3,5) = "de"; rev1 touches before it -> shifts by 0
        {"doc_id": "C", "version": sha(raw_c), "category": "letters2",
         "start": 3, "end": 5},
        # unknown version digest
        {"doc_id": "A", "version": "00" * 32, "category": "ghost",
         "start": 0, "end": 1},
    ]
    ann_path = os.path.join(root, "annotations.jsonl")
    write(ann_path, annotations)

    out = os.path.join(root, "out")
    return drafts, rev_path, ann_path, out


def read_jsonl(path: str) -> list[dict]:
    with open(path, encoding="utf-8") as fh:
        return [json.loads(line) for line in fh if line.strip()]


def test_end_to_end():
    with tempfile.TemporaryDirectory() as root:
        drafts, rev_path, ann_path, out = make_fixture(root)
        summary = imp.run_pipeline(drafts, rev_path, ann_path, out)
        assert summary["documents"] == 4
        assert summary["chain_errors"] == 1
        assert summary["annotations"] == 11

        migrated = read_jsonl(os.path.join(out, "migrated.jsonl"))
        review = read_jsonl(os.path.join(out, "review.jsonl"))
        errors = read_jsonl(os.path.join(out, "chain_errors.jsonl"))

        # chain error: doc B, first failing version is revision 1
        assert len(errors) == 1
        assert errors[0]["doc_id"] == "B"
        assert errors[0]["failed_version"] == 1
        assert "digest" in errors[0]["reason"]

        by_key = {(r["doc_id"], r["category"]): r for r in migrated + review}

        # greeting: v0 "hello" -> final ">>hello\nearth\n!!", cp [2,7)
        g = by_key[("A", "greeting")]
        assert g["status"] == "migrated"
        assert g["final_codepoint_range"] == [2, 7]
        assert g["excerpt"] == "hello"
        assert g["original_utf16_range"] == [0, 5]

        # linebreak: CRLF cut -> review
        lb = by_key[("A", "linebreak")]
        assert lb["status"] == "review"
        assert "CRLF" in lb["reason"]

        # planet: v1 "earth" -> final shifted by leading ">>" -> [8,13)
        p = by_key[("A", "planet")]
        assert p["status"] == "migrated"
        assert p["final_codepoint_range"] == [8, 13]
        assert p["excerpt"] == "earth"

        # point: empty range at 0 survives the insert at 0
        pt = by_key[("A", "point")]
        assert pt["status"] == "migrated"
        assert pt["final_codepoint_range"] == [2, 2]
        assert pt["excerpt"] == ""

        # emoji (B): chain failure takes precedence; still routed to review
        em = by_key[("B", "emoji")]
        assert em["status"] == "review"
        assert "version chain failed" in em["reason"]

        # plain: valid on v0 but the chain broke -> review, names failed version
        pl = by_key[("B", "plain")]
        assert pl["status"] == "review"
        assert "version chain failed" in pl["reason"]

        # emoji (G): surrogate split on a healthy chain -> review, surrogate reason
        gem = by_key[("G", "emoji")]
        assert gem["status"] == "review"
        assert "surrogate" in gem["reason"]

        # face (G): whole astral cp, units [1,3) -> cp [1,2); untouched by the
        # later insert at cp 3, excerpt is the emoji itself
        gf = by_key[("G", "face")]
        assert gf["status"] == "migrated"
        assert gf["final_codepoint_range"] == [1, 2]
        assert gf["excerpt"] == "😀"

        # letters: replaced text -> review naming revision 1 op 0
        lt = by_key[("C", "letters")]
        assert lt["status"] == "review"
        assert lt["conflict_op_index"] == 0
        assert "replacement covers" in lt["reason"]

        # letters2: [3,5) "de" -> replace before it is same length, stays [3,5)
        l2 = by_key[("C", "letters2")]
        assert l2["status"] == "migrated"
        assert l2["final_codepoint_range"] == [3, 5]
        assert l2["excerpt"] == "de"

        # ghost: unknown digest
        gh = by_key[("A", "ghost")]
        assert gh["status"] == "review"
        assert "not part of the verified chain" in gh["reason"]

        assert len(migrated) == 5
        assert len(review) == 6


def test_astral_annotation_migrates_across_revision():
    """UTF-16 ranges over astral text convert to codepoint coordinates and
    survive an insertion that shifts both BMP and astral characters."""
    with tempfile.TemporaryDirectory() as root:
        drafts = os.path.join(root, "drafts")
        os.makedirs(drafts)
        raw = "ab😀cd".encode("utf-8")
        with open(os.path.join(drafts, "H.txt"), "wb") as fh:
            fh.write(raw)
        # insert "ZZ" at position 2 (before the emoji)
        parent, post, v1 = build_revision(
            sha(raw), "ab😀cd",
            [{"type": "insert", "position": 2, "text": "ZZ"}],
        )
        write(os.path.join(root, "r.jsonl"), [
            {"doc_id": "H", "parent_digest": parent, "post_digest": post,
             "ops": [{"type": "insert", "position": 2, "text": "ZZ"}]},
        ])
        # annotate the emoji: UTF-16 units [2,4) in the draft (a0 b1 😀2..4 c5)
        write(os.path.join(root, "a.jsonl"), [
            {"doc_id": "H", "version": sha(raw), "category": "face",
             "start": 2, "end": 4},
        ])
        imp.run_pipeline(drafts, os.path.join(root, "r.jsonl"),
                         os.path.join(root, "a.jsonl"), os.path.join(root, "out"))
        migrated = read_jsonl(os.path.join(root, "out", "migrated.jsonl"))
        assert len(migrated) == 1
        rec = migrated[0]
        # cp [2,3) in v0 shifts by +2 -> cp [4,5), excerpt is still the emoji
        assert rec["final_codepoint_range"] == [4, 5]
        assert rec["excerpt"] == "😀"


def test_first_conflict_is_named_inside_a_multi_op_revision():
    with tempfile.TemporaryDirectory() as root:
        drafts = os.path.join(root, "drafts")
        os.makedirs(drafts)
        with open(os.path.join(drafts, "I.txt"), "wb") as fh:
            fh.write(b"abcdefghij")
        ops = [
            {"type": "insert", "position": 1, "text": "Q"},      # op 0, safe
            {"type": "delete", "start": 4, "end": 6},            # op 1, conflict
            {"type": "insert", "position": 9, "text": "Z"},      # op 2, safe
        ]
        parent, post, _ = build_revision(sha(b"abcdefghij"), "abcdefghij", ops)
        write(os.path.join(root, "r.jsonl"), [
            {"doc_id": "I", "parent_digest": parent, "post_digest": post, "ops": ops},
        ])
        # range [3,7): the delete [4,6) cuts through it
        write(os.path.join(root, "a.jsonl"), [
            {"doc_id": "I", "version": parent, "category": "x",
             "start": 3, "end": 7},
        ])
        imp.run_pipeline(drafts, os.path.join(root, "r.jsonl"),
                         os.path.join(root, "a.jsonl"), os.path.join(root, "out"))
        review = read_jsonl(os.path.join(root, "out", "review.jsonl"))
        assert len(review) == 1
        assert review[0]["conflict_op_index"] == 1
        assert review[0]["conflict_op"]["type"] == "delete"
        assert review[0]["conflict_version_digest"] == post


def test_pure_lf_draft_never_reports_crlf_cut():
    with tempfile.TemporaryDirectory() as root:
        drafts = os.path.join(root, "drafts")
        os.makedirs(drafts)
        raw = "ab\ncd".encode("utf-8")
        with open(os.path.join(drafts, "J.txt"), "wb") as fh:
            fh.write(raw)
        parent, post, _ = build_revision(
            sha(raw), "ab\ncd", [{"type": "insert", "position": 0, "text": "z"}]
        )
        write(os.path.join(root, "r.jsonl"), [
            {"doc_id": "J", "parent_digest": parent, "post_digest": post,
             "ops": [{"type": "insert", "position": 0, "text": "z"}]},
        ])
        # range straddling the LF: units [1,4) = "b\nc", must migrate cleanly
        write(os.path.join(root, "a.jsonl"), [
            {"doc_id": "J", "version": sha(raw), "category": "x",
             "start": 1, "end": 4},
            # reversed range -> review, not a crash
            {"doc_id": "J", "version": sha(raw), "category": "rev",
             "start": 4, "end": 1},
        ])
        imp.run_pipeline(drafts, os.path.join(root, "r.jsonl"),
                         os.path.join(root, "a.jsonl"), os.path.join(root, "out"))
        migrated = read_jsonl(os.path.join(root, "out", "migrated.jsonl"))
        review = read_jsonl(os.path.join(root, "out", "review.jsonl"))
        assert len(migrated) == 1
        assert migrated[0]["excerpt"] == "b\nc"
        assert migrated[0]["final_codepoint_range"] == [2, 5]
        assert len(review) == 1
        assert "after end offset" in review[0]["reason"]


def test_interleaved_revision_stream_is_rejected():
    records = [
        (1, {"doc_id": "X", "parent_digest": "p", "post_digest": "q", "ops": []}),
        (2, {"doc_id": "Y", "parent_digest": "p", "post_digest": "q", "ops": []}),
        (3, {"doc_id": "X", "parent_digest": "q", "post_digest": "r", "ops": []}),
    ]
    try:
        imp.group_revisions(records)
    except ValueError as exc:
        assert "not contiguous" in str(exc)
    else:
        raise AssertionError("interleaved stream must be rejected")


def test_overlapping_annotations_migrate_independently():
    with tempfile.TemporaryDirectory() as root:
        drafts = os.path.join(root, "drafts")
        os.makedirs(drafts)
        with open(os.path.join(drafts, "D.txt"), "wb") as fh:
            fh.write("abcdefgh".encode("utf-8"))
        parent, post, v1 = build_revision(
            sha(b"abcdefgh"), "abcdefgh",
            [{"type": "insert", "position": 4, "text": "XY"}],
        )
        write(os.path.join(root, "r.jsonl"), [
            {"doc_id": "D", "parent_digest": parent, "post_digest": post,
             "ops": [{"type": "insert", "position": 4, "text": "XY"}]},
        ])
        # overlapping ranges [1,5) and [3,7); insert at 4 is inside BOTH
        write(os.path.join(root, "a.jsonl"), [
            {"doc_id": "D", "version": parent, "category": "x", "start": 1, "end": 5},
            {"doc_id": "D", "version": parent, "category": "y", "start": 3, "end": 7},
        ])
        imp.run_pipeline(drafts, os.path.join(root, "r.jsonl"),
                         os.path.join(root, "a.jsonl"), os.path.join(root, "out"))
        review = read_jsonl(os.path.join(root, "out", "review.jsonl"))
        assert {r["category"] for r in review} == {"x", "y"}
        assert all(r["conflict_op_index"] == 0 for r in review)


def test_root_digest_check_uses_raw_bytes():
    with tempfile.TemporaryDirectory() as root:
        drafts = os.path.join(root, "drafts")
        os.makedirs(drafts)
        raw = "a\r\nb".encode("utf-8")
        with open(os.path.join(drafts, "E.txt"), "wb") as fh:
            fh.write(raw)
        # revision whose parent claims the digest of the NORMALISED text (wrong:
        # the root digest must be the digest of the raw draft bytes)
        wrong_parent, post, _ = build_revision(
            d("a\nb"), "a\nb", [{"type": "insert", "position": 1, "text": "z"}]
        )
        write(os.path.join(root, "r.jsonl"), [
            {"doc_id": "E", "parent_digest": wrong_parent, "post_digest": post,
             "ops": [{"type": "insert", "position": 1, "text": "z"}]},
        ])
        write(os.path.join(root, "a.jsonl"), [
            {"doc_id": "E", "version": sha(raw), "category": "c", "start": 0, "end": 1},
        ])
        imp.run_pipeline(drafts, os.path.join(root, "r.jsonl"),
                         os.path.join(root, "a.jsonl"), os.path.join(root, "out"))
        errors = read_jsonl(os.path.join(root, "out", "chain_errors.jsonl"))
        assert errors[0]["doc_id"] == "E"
        assert errors[0]["failed_version"] == 1
        review = read_jsonl(os.path.join(root, "out", "review.jsonl"))
        assert review[0]["status"] == "review"


def test_overlapping_ops_break_chain_at_first_bad_version():
    with tempfile.TemporaryDirectory() as root:
        drafts = os.path.join(root, "drafts")
        os.makedirs(drafts)
        with open(os.path.join(drafts, "F.txt"), "wb") as fh:
            fh.write(b"abcdef")
        good_parent, good_post, v1 = build_revision(
            sha(b"abcdef"), "abcdef",
            [{"type": "insert", "position": 1, "text": "z"}],
        )
        bad_ops = [{"type": "delete", "start": 0, "end": 3},
                   {"type": "delete", "start": 2, "end": 4}]  # overlaps
        write(os.path.join(root, "r.jsonl"), [
            {"doc_id": "F", "parent_digest": good_parent, "post_digest": good_post,
             "ops": [{"type": "insert", "position": 1, "text": "z"}]},
            {"doc_id": "F", "parent_digest": good_post, "post_digest": d("whatever"),
             "ops": bad_ops},
        ])
        write(os.path.join(root, "a.jsonl"), [])
        imp.run_pipeline(drafts, os.path.join(root, "r.jsonl"),
                         os.path.join(root, "a.jsonl"), os.path.join(root, "out"))
        errors = read_jsonl(os.path.join(root, "out", "chain_errors.jsonl"))
        assert errors[0]["failed_version"] == 2
        assert "overlap" in errors[0]["reason"]


def test_cli_runs(tmp_path=None):
    with tempfile.TemporaryDirectory() as root:
        drafts, rev_path, ann_path, out = make_fixture(root)
        script = os.path.join(os.path.dirname(__file__), "..", "importer", "importer.py")
        proc = subprocess.run(
            [sys.executable, "-I", script, "--drafts", drafts,
             "--revisions", rev_path, "--annotations", ann_path, "--out", out],
            capture_output=True, text=True, check=True,
        )
        summary = json.loads(proc.stdout)
        assert summary["migrated"] == 5
        assert os.path.exists(os.path.join(out, "migrated.jsonl"))


def main():
    tests = [v for k, v in sorted(globals().items()) if k.startswith("test_") and callable(v)]
    failures = 0
    for test in tests:
        try:
            test()
        except Exception as exc:  # noqa: BLE001
            failures += 1
            print(f"FAIL {test.__name__}: {type(exc).__name__}: {exc}")
        else:
            print(f"ok   {test.__name__}")
    print(f"\n{len(tests) - failures}/{len(tests)} passed")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
