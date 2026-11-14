"""End-to-end tests for the cold-chain batch receiver.

Run from the repository root:

    python3 -m unittest -v tests.test_receiver
"""

from __future__ import annotations

import io
import json
import os
import shutil
import sqlite3
import tempfile
import time
import unittest
import zipfile
from contextlib import redirect_stdout
from pathlib import Path

from coldstore.cli import main as cli_main
from coldstore.receiver import (
    BAD,
    CONFLICT,
    INCOMPLETE,
    PUBLISHED,
    VALIDATED,
    Receiver,
    ValidationError,
    content_hash,
)


# ---------------------------------------------------------------------------
# Fixture helpers
# ---------------------------------------------------------------------------


def make_csv(text: str) -> bytes:
    return text.encode("utf-8")


def build_batch(
    inbox: Path,
    gw: str,
    no: int,
    members: dict[str, bytes],
    *,
    corrupt_zip: bool = False,
    bad_manifest_json: bool = False,
    manifest_override: dict | None = None,
    tamper_member: str | None = None,
    mtime_age: float = 3600,
) -> tuple[Path, Path]:
    """Write a ZIP + manifest pair into the inbox."""
    files_meta = []
    zip_path = inbox / f"{gw}_batch{no}.zip"
    with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_DEFLATED) as zf:
        for name, data in members.items():
            payload = data
            if tamper_member == name:
                payload = data + b"\x00tampered"
            zf.writestr(name, payload)
            import hashlib

            files_meta.append(
                {
                    "name": name,
                    "bytes": len(payload),
                    "sha256": hashlib.sha256(payload).hexdigest(),
                }
            )
    if corrupt_zip:
        zip_path.write_bytes(b"PK\x03\x04 not really a zip")

    manifest = manifest_override or {
        "gateway_id": gw,
        "batch_no": no,
        "files": files_meta,
    }
    json_path = inbox / f"{gw}_batch{no}.json"
    if bad_manifest_json:
        json_path.write_text("{this is not json", encoding="utf-8")
    else:
        json_path.write_text(
            json.dumps(manifest, ensure_ascii=False), encoding="utf-8"
        )

    # Age the files so mtime-based stability checks pass with stable_seconds=0
    # being overridden per test; default receiver uses 2s and we pass 0 here.
    old = time.time() - mtime_age
    os.utime(zip_path, (old, old))
    os.utime(json_path, (old, old))
    return zip_path, json_path


def write_half(inbox: Path, gw: str, no: int, kind: str, payload: bytes) -> Path:
    p = inbox / f"{gw}_batch{no}.{kind}"
    p.write_bytes(payload)
    old = time.time() - 3600
    os.utime(p, (old, old))
    return p


def row(receiver: Receiver, gw: str, no: int):
    return receiver._get_row(gw, no)


class ReceiverTestBase(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = Path(tempfile.mkdtemp(prefix="coldstore-test-"))
        self.root = self.tmp / "data"
        self.root.mkdir()
        self.inbox = self.root / "inbox"
        self.inbox.mkdir()
        self.receiver = Receiver(self.root, stable_seconds=0)

    def tearDown(self) -> None:
        self.receiver.close()
        shutil.rmtree(self.tmp, ignore_errors=True)

    def rescan(self) -> None:
        """A brand new Receiver over the same root, i.e. process restart."""
        self.receiver.close()
        self.receiver = Receiver(self.root, stable_seconds=0)

    def published_dir(self, gw: str, no: int) -> Path:
        return self.root / "published" / gw / f"batch{no}"

    def receipt_path(self, gw: str, no: int) -> Path:
        return self.root / "receipts" / gw / f"receipt_batch{no}.json"


# ---------------------------------------------------------------------------
# Happy path and ordering
# ---------------------------------------------------------------------------


class HappyPathTests(ReceiverTestBase):
    def test_single_batch_publishes_atomically_with_receipt(self) -> None:
        build_batch(self.inbox, "gw1", 1, {"a.csv": make_csv("x,y\n1,2\n")})
        self.receiver.scan_once()

        r = row(self.receiver, "gw1", 1)
        self.assertEqual(r["state"], PUBLISHED)
        target = self.published_dir("gw1", 1)
        self.assertTrue(target.is_dir())
        self.assertEqual(
            (target / "a.csv").read_bytes(), make_csv("x,y\n1,2\n")
        )
        # inbox pair is consumed after publishing
        self.assertFalse((self.inbox / "gw1_batch1.zip").exists())
        self.assertFalse((self.inbox / "gw1_batch1.json").exists())

        receipt = json.loads(self.receipt_path("gw1", 1).read_text())
        self.assertEqual(receipt["gateway_id"], "gw1")
        self.assertEqual(receipt["batch_no"], 1)
        self.assertEqual(receipt["status"], PUBLISHED)
        self.assertTrue(receipt["receipt_id"].startswith("rcpt_"))
        self.assertEqual(len(receipt["files"]), 1)
        self.assertEqual(receipt["files"][0]["name"], "a.csv")

    def test_later_batch_held_until_earlier_publishes(self) -> None:
        # batch 42 arrives first; batch 41 is still being transferred
        build_batch(self.inbox, "gw1", 42, {"b.csv": b"forty-two"})
        self.receiver.scan_once()

        r42 = row(self.receiver, "gw1", 42)
        self.assertEqual(r42["state"], VALIDATED)
        # validated but not visible downstream
        self.assertFalse(self.published_dir("gw1", 42).exists())
        self.assertEqual(
            self.receiver.status("gw1")[0]["next_expected_batch"], 1
        )

        # gaps are reported while waiting: batches 1..41 have no records at all
        gaps = self.receiver.list_gaps("gw1")
        self.assertEqual([g["batch_no"] for g in gaps], list(range(1, 42)))

        # batch 1..40 arrive, then 41; 42 releases automatically in order
        for no in range(1, 41):
            build_batch(self.inbox, "gw1", no, {f"f{no}.csv": f"d{no}".encode()})
        build_batch(self.inbox, "gw1", 41, {"a.csv": b"forty-one"})
        self.receiver.scan_once()

        for no in range(1, 43):
            self.assertEqual(row(self.receiver, "gw1", no)["state"], PUBLISHED, no)
            self.assertTrue(self.published_dir("gw1", no).is_dir(), no)
        self.assertEqual(self.receiver.list_gaps("gw1"), [])
        self.assertEqual(
            self.receiver.status("gw1")[0]["next_expected_batch"], 43
        )

    def test_gateways_advance_independently(self) -> None:
        build_batch(self.inbox, "gwA", 2, {"a.csv": b"a2"})  # blocked on gap
        build_batch(self.inbox, "gwB", 1, {"b.csv": b"b1"})
        build_batch(self.inbox, "gwB", 2, {"b.csv": b"b2"})
        self.receiver.scan_once()

        self.assertEqual(row(self.receiver, "gwA", 2)["state"], VALIDATED)
        self.assertEqual(row(self.receiver, "gwB", 1)["state"], PUBLISHED)
        self.assertEqual(row(self.receiver, "gwB", 2)["state"], PUBLISHED)
        # gwA's gap does not block gwB
        self.assertTrue(self.published_dir("gwB", 2).is_dir())
        self.assertFalse(self.published_dir("gwA", 2).exists())


# ---------------------------------------------------------------------------
# Missing pieces / bad packages / gaps are distinguishable
# ---------------------------------------------------------------------------


class DefectTests(ReceiverTestBase):
    def test_missing_piece_tracked_and_completed_by_reupload(self) -> None:
        write_half(self.inbox, "gw1", 5, "zip", b"PK\x03\x04stub")
        self.receiver.scan_once()

        self.assertEqual(row(self.receiver, "gw1", 5)["state"], INCOMPLETE)
        missing = self.receiver.list_missing_pieces("gw1")
        self.assertEqual(len(missing), 1)
        self.assertEqual(missing[0]["batch_no"], 5)
        self.assertEqual(missing[0]["have"], ["zip"])
        self.assertEqual(missing[0]["missing"], ["json"])
        # half pair is not a bad package; earlier numbers are genuine gaps
        self.assertEqual(self.receiver.list_bad("gw1"), [])
        self.assertEqual(
            [g["batch_no"] for g in self.receiver.list_gaps("gw1")],
            [1, 2, 3, 4],
        )

        # gateway completes the pair via a corrected full re-upload
        build_batch(self.inbox, "gw1", 5, {"a.csv": b"data"})
        self.receiver.scan_once()
        self.assertEqual(row(self.receiver, "gw1", 5)["state"], VALIDATED)
        self.assertEqual(self.receiver.list_missing_pieces("gw1"), [])

    def test_bad_zip_is_bad_state_then_reupload_repairs(self) -> None:
        build_batch(
            self.inbox, "gw1", 1, {"a.csv": b"hello"}, corrupt_zip=True
        )
        self.receiver.scan_once()
        self.assertEqual(row(self.receiver, "gw1", 1)["state"], BAD)

        bad = self.receiver.list_bad("gw1")
        self.assertEqual(len(bad), 1)
        self.assertIn("ZIP", bad[0]["reason"])
        # bad package is distinct from missing-piece and gap
        self.assertEqual(self.receiver.list_missing_pieces("gw1"), [])
        self.assertEqual(self.receiver.list_gaps("gw1"), [])
        # files retained so the gateway can replace them
        self.assertTrue((self.inbox / "gw1_batch1.zip").exists())

        # corrected re-upload
        build_batch(self.inbox, "gw1", 1, {"a.csv": b"hello"})
        self.receiver.scan_once()
        self.assertEqual(row(self.receiver, "gw1", 1)["state"], PUBLISHED)
        self.assertEqual(self.receiver.list_bad("gw1"), [])

    def test_bad_manifest_json(self) -> None:
        build_batch(self.inbox, "gw1", 1, {"a.csv": b"x"}, bad_manifest_json=True)
        self.receiver.scan_once()
        self.assertEqual(row(self.receiver, "gw1", 1)["state"], BAD)
        self.assertIn("JSON", self.receiver.list_bad("gw1")[0]["reason"])

    def test_hash_mismatch_is_bad(self) -> None:
        # manifest records a wrong SHA-256 for the actual ZIP member
        build_batch(
            self.inbox, "gw1", 2,
            {"a.csv": b"real content"},
            manifest_override={
                "gateway_id": "gw1",
                "batch_no": 2,
                "files": [
                    {
                        "name": "a.csv",
                        "bytes": len(b"real content"),
                        "sha256": "0" * 64,
                    }
                ],
            },
        )
        self.receiver.scan_once()
        self.assertEqual(row(self.receiver, "gw1", 2)["state"], BAD)
        self.assertIn("SHA-256", self.receiver.list_bad()[0]["reason"])

    def test_size_mismatch_and_member_set_mismatch(self) -> None:
        # wrong declared size
        build_batch(
            self.inbox, "gw1", 1, {"a.csv": b"abc"},
            manifest_override={
                "gateway_id": "gw1",
                "batch_no": 1,
                "files": [
                    {"name": "a.csv", "bytes": 99, "sha256": _sha(b"abc")}
                ],
            },
        )
        # extra zip member missing from manifest
        build_batch(
            self.inbox, "gw1", 2,
            {"a.csv": b"a", "b.csv": b"b"},
            manifest_override={
                "gateway_id": "gw1",
                "batch_no": 2,
                "files": [
                    {"name": "a.csv", "bytes": 1, "sha256": _sha(b"a")}
                ],
            },
        )
        self.receiver.scan_once()
        reasons = {b["batch_no"]: b["reason"] for b in self.receiver.list_bad()}
        self.assertIn("size", reasons[1])
        self.assertIn("count does not match", reasons[2])

    def test_gap_does_not_confuse_bad_or_incomplete(self) -> None:
        build_batch(self.inbox, "gw1", 3, {"a.csv": b"x"})  # 1,2 absent
        write_half(self.inbox, "gw1", 5, "json", b"{}")
        self.receiver.scan_once()

        gaps = [g["batch_no"] for g in self.receiver.list_gaps("gw1")]
        self.assertEqual(gaps, [1, 2, 4])
        self.assertEqual(
            [m["batch_no"] for m in self.receiver.list_missing_pieces("gw1")],
            [5],
        )
        self.assertEqual(self.receiver.list_bad("gw1"), [])


# ---------------------------------------------------------------------------
# Duplicates and conflicts
# ---------------------------------------------------------------------------


class RetransmissionTests(ReceiverTestBase):
    def test_identical_retransmission_keeps_original_receipt(self) -> None:
        build_batch(self.inbox, "gw1", 1, {"a.csv": b"same"})
        self.receiver.scan_once()
        receipt1 = self.receipt_path("gw1", 1).read_text()
        first_received = json.loads(receipt1)["first_received_at"]

        time.sleep(0.01)
        build_batch(self.inbox, "gw1", 1, {"a.csv": b"same"})
        self.receiver.scan_once()

        receipt2 = json.loads(self.receipt_path("gw1", 1).read_text())
        self.assertEqual(receipt2["first_received_at"], first_received)
        dups = self.receiver.list_duplicates("gw1")
        self.assertEqual(len(dups), 1)
        self.assertEqual(dups[0]["batch_no"], 1)
        self.assertEqual(dups[0]["receipt_id"], receipt2["receipt_id"])
        # duplicate copy is consumed, published directory untouched
        self.assertFalse((self.inbox / "gw1_batch1.zip").exists())
        self.assertEqual(
            (self.published_dir("gw1", 1) / "a.csv").read_bytes(), b"same"
        )

    def test_different_content_after_publish_is_conflict_and_kept(self) -> None:
        build_batch(self.inbox, "gw1", 1, {"a.csv": b"original"})
        self.receiver.scan_once()
        original_receipt = self.receipt_path("gw1", 1).read_text()
        original_dir_listing = sorted(
            p.name for p in self.published_dir("gw1", 1).iterdir()
        )

        build_batch(self.inbox, "gw1", 1, {"a.csv": b"changed content"})
        self.receiver.scan_once()

        self.assertEqual(row(self.receiver, "gw1", 1)["state"], CONFLICT)
        conflicts = self.receiver.list_conflicts("gw1")
        self.assertEqual(len(conflicts), 1)
        self.assertEqual(conflicts[0]["batch_no"], 1)
        self.assertIn("differs", conflicts[0]["reason"])
        # incoming files retained as evidence, published batch immutable
        self.assertTrue((self.inbox / "gw1_batch1.zip").exists())
        self.assertEqual(
            self.receipt_path("gw1", 1).read_text(), original_receipt
        )
        self.assertEqual(
            sorted(p.name for p in self.published_dir("gw1", 1).iterdir()),
            original_dir_listing,
        )
        self.assertEqual(
            (self.published_dir("gw1", 1) / "a.csv").read_bytes(), b"original"
        )

    def test_conflict_cleared_by_correct_reupload(self) -> None:
        build_batch(self.inbox, "gw1", 1, {"a.csv": b"original"})
        self.receiver.scan_once()
        build_batch(self.inbox, "gw1", 1, {"a.csv": b"changed"})
        self.receiver.scan_once()
        self.assertEqual(row(self.receiver, "gw1", 1)["state"], CONFLICT)

        # gateway re-uploads the original content again
        build_batch(self.inbox, "gw1", 1, {"a.csv": b"original"})
        self.receiver.scan_once()
        self.assertEqual(row(self.receiver, "gw1", 1)["state"], PUBLISHED)
        self.assertEqual(self.receiver.list_conflicts("gw1"), [])
        self.assertFalse((self.inbox / "gw1_batch1.zip").exists())

    def test_conflict_survives_repeated_scans_without_reupload(self) -> None:
        # regression: unchanged conflict files must keep being reported, not
        # be silently skipped as already-processed work
        build_batch(self.inbox, "gw1", 1, {"a.csv": b"original"})
        self.receiver.scan_once()
        build_batch(self.inbox, "gw1", 1, {"a.csv": b"changed"})
        self.receiver.scan_once()
        self.receiver.scan_once()
        self.assertEqual(row(self.receiver, "gw1", 1)["state"], CONFLICT)
        self.assertEqual(len(self.receiver.list_conflicts("gw1")), 1)

    def test_conflict_survives_restart_reconciliation(self) -> None:
        # regression: a brand-new process runs reconcile_published, which
        # sees the original directory still on disk but must not erase the
        # deliberately recorded conflict
        build_batch(self.inbox, "gw1", 1, {"a.csv": b"original"})
        self.receiver.scan_once()
        build_batch(self.inbox, "gw1", 1, {"a.csv": b"changed"})
        self.receiver.scan_once()
        self.assertEqual(row(self.receiver, "gw1", 1)["state"], CONFLICT)

        self.rescan()  # new Receiver -> reconcile_published()
        self.assertEqual(row(self.receiver, "gw1", 1)["state"], CONFLICT)
        self.assertEqual(len(self.receiver.list_conflicts("gw1")), 1)
        # the published batch itself stays immutable
        self.assertEqual(
            (self.published_dir("gw1", 1) / "a.csv").read_bytes(), b"original"
        )

    def test_bad_pair_repeated_scan_stays_bad_until_replaced(self) -> None:
        build_batch(self.inbox, "gw1", 1, {"a.csv": b"x"}, corrupt_zip=True)
        self.receiver.scan_once()
        self.receiver.scan_once()
        self.assertEqual(row(self.receiver, "gw1", 1)["state"], BAD)
        build_batch(self.inbox, "gw1", 1, {"a.csv": b"x"})
        self.receiver.scan_once()
        self.assertEqual(row(self.receiver, "gw1", 1)["state"], PUBLISHED)

    def test_content_hash_order_independent(self) -> None:
        h1 = content_hash("gw", 1, [
            {"name": "a.csv", "bytes": 1, "sha256": "a" * 64},
            {"name": "b.csv", "bytes": 2, "sha256": "b" * 64},
        ])
        h2 = content_hash("gw", 1, [
            {"name": "b.csv", "bytes": 2, "sha256": "B" * 64},
            {"name": "a.csv", "bytes": 1, "sha256": "A" * 64},
        ])
        self.assertEqual(h1, h2)  # member order and hex case don't matter


# ---------------------------------------------------------------------------
# Restart / persistence
# ---------------------------------------------------------------------------


class RestartTests(ReceiverTestBase):
    def test_resume_from_published_after_restart_with_held_batch(self) -> None:
        build_batch(self.inbox, "gw1", 42, {"a.csv": b"42"})
        build_batch(self.inbox, "gw1", 1, {"a.csv": b"1"})
        self.receiver.scan_once()
        self.assertEqual(row(self.receiver, "gw1", 1)["state"], PUBLISHED)
        self.assertEqual(row(self.receiver, "gw1", 42)["state"], VALIDATED)

        # simulate process exit and re-scan: everything rebuilt from disk + DB
        self.rescan()
        self.assertEqual(row(self.receiver, "gw1", 1)["state"], PUBLISHED)
        self.assertEqual(row(self.receiver, "gw1", 42)["state"], VALIDATED)
        self.assertEqual(
            self.receiver.status("gw1")[0]["next_expected_batch"], 2
        )

        build_batch(self.inbox, "gw1", 2, {"a.csv": b"2"})
        # still blocked: gap at 3..41
        self.receiver.scan_once()
        self.assertEqual(row(self.receiver, "gw1", 42)["state"], VALIDATED)

        for no in range(3, 42):
            build_batch(self.inbox, "gw1", no, {"a.csv": f"d{no}".encode()})
        self.receiver.scan_once()
        for no in range(1, 43):
            self.assertEqual(row(self.receiver, "gw1", no)["state"], PUBLISHED)

    def test_rebuild_state_from_published_directories_without_db(self) -> None:
        build_batch(self.inbox, "gw1", 1, {"a.csv": b"1"})
        build_batch(self.inbox, "gw1", 2, {"a.csv": b"2"})
        build_batch(self.inbox, "gwX", 1, {"a.csv": b"x"})
        self.receiver.scan_once()

        # destroy the database as if it were lost; receipts + published dirs stay
        self.receiver.close()
        for p in (self.root / "state").iterdir():
            p.unlink()
        self.rescan()

        self.assertEqual(row(self.receiver, "gw1", 1)["state"], PUBLISHED)
        self.assertEqual(row(self.receiver, "gw1", 2)["state"], PUBLISHED)
        self.assertEqual(row(self.receiver, "gwX", 1)["state"], PUBLISHED)
        self.assertEqual(
            self.receiver.status("gw1")[0]["next_expected_batch"], 3
        )

    def test_published_directory_loss_is_repaired_from_inbox(self) -> None:
        build_batch(self.inbox, "gw1", 1, {"a.csv": b"keep"})
        self.receiver.scan_once()
        # published dir vanishes after publishing; pair already removed, so
        # re-stage a pair in inbox (gateway retransmits) and restart
        shutil.rmtree(self.published_dir("gw1", 1))
        build_batch(self.inbox, "gw1", 1, {"a.csv": b"keep"})
        self.rescan()
        self.receiver.scan_once()
        self.assertEqual(row(self.receiver, "gw1", 1)["state"], PUBLISHED)
        self.assertTrue((self.published_dir("gw1", 1) / "a.csv").exists())


# ---------------------------------------------------------------------------
# Security / robustness
# ---------------------------------------------------------------------------


class SecurityTests(ReceiverTestBase):
    def test_path_traversal_member_rejected(self) -> None:
        # hand-craft a ZIP with a traversal entry
        zip_path = self.inbox / "gw1_batch1.zip"
        with zipfile.ZipFile(zip_path, "w") as zf:
            zf.writestr("../evil.csv", b"x")
        manifest = {
            "gateway_id": "gw1",
            "batch_no": 1,
            "files": [
                {"name": "../evil.csv", "bytes": 1, "sha256": _sha(b"x")}
            ],
        }
        (self.inbox / "gw1_batch1.json").write_text(json.dumps(manifest))
        old = time.time() - 3600
        os.utime(zip_path, (old, old))
        os.utime(self.inbox / "gw1_batch1.json", (old, old))

        self.receiver.scan_once()
        self.assertEqual(row(self.receiver, "gw1", 1)["state"], BAD)
        self.assertIn("unsafe", self.receiver.list_bad()[0]["reason"])
        self.assertFalse((self.root / "evil.csv").exists())

    def test_manifest_gateway_mismatch_rejected(self) -> None:
        build_batch(
            self.inbox, "gw1", 1, {"a.csv": b"x"},
            manifest_override={
                "gateway_id": "gw2",
                "batch_no": 1,
                "files": [
                    {"name": "a.csv", "bytes": 1, "sha256": _sha(b"x")}
                ],
            },
        )
        self.receiver.scan_once()
        self.assertEqual(row(self.receiver, "gw1", 1)["state"], BAD)

    def test_unrelated_files_ignored(self) -> None:
        (self.inbox / "readme.txt").write_text("ignore me")
        (self.inbox / ".DS_Store").write_bytes(b"")
        build_batch(self.inbox, "gw1", 1, {"a.csv": b"x"})
        self.receiver.scan_once()
        self.assertEqual(row(self.receiver, "gw1", 1)["state"], PUBLISHED)

    def test_validator_directly_raises_on_empty_file_list_is_allowed(self) -> None:
        # zero-member batch is a legitimate empty batch
        build_batch(self.inbox, "gw1", 1, {})
        self.receiver.scan_once()
        self.assertEqual(row(self.receiver, "gw1", 1)["state"], PUBLISHED)
        self.assertTrue(self.published_dir("gw1", 1).is_dir())


# ---------------------------------------------------------------------------
# CLI smoke test
# ---------------------------------------------------------------------------


class CliTests(ReceiverTestBase):
    def test_cli_scan_once_and_queries(self) -> None:
        build_batch(self.inbox, "gw1", 2, {"a.csv": b"x"})  # gap at 1
        write_half(self.inbox, "gw1", 3, "zip", b"stub")
        build_batch(self.inbox, "gw1", 4, {"a.csv": b"x"}, corrupt_zip=True)

        buf = io.StringIO()
        with redirect_stdout(buf):
            rc = cli_main(["scan", "--root", str(self.root), "--once",
                           "--stable-seconds", "0"])
        self.assertEqual(rc, 0)
        # receiver inside CLI was closed; reopen a handle for assertions
        self.receiver.close()
        self.receiver = Receiver(self.root, stable_seconds=0)

        for command, expected_len in (
            ("list-gaps", 1),       # batch 1
            ("list-missing", 1),    # batch 3
            ("list-bad", 1),        # batch 4
        ):
            buf = io.StringIO()
            with redirect_stdout(buf):
                rc = cli_main([command, "--root", str(self.root),
                               "--gateway", "gw1"])
            self.assertEqual(rc, 0)
            self.assertEqual(len(json.loads(buf.getvalue())), expected_len,
                             command)

        buf = io.StringIO()
        with redirect_stdout(buf):
            rc = cli_main(["status", "--root", str(self.root)])
        self.assertEqual(rc, 0)
        summary = json.loads(buf.getvalue())[0]
        self.assertEqual(summary["gateway_id"], "gw1")
        self.assertEqual(summary["bad"], 1)
        self.assertEqual(summary["incomplete"], 1)
        self.assertEqual(summary["validated_holding"], 1)


# ---------------------------------------------------------------------------
# helpers
# ---------------------------------------------------------------------------


def _sha(data: bytes) -> str:
    import hashlib

    return hashlib.sha256(data).hexdigest()


if __name__ == "__main__":
    unittest.main()
