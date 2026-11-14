"""Functional tests for the reconciliation CLI.

Run with either ``python3 -m unittest discover -s tests -v`` or ``pytest``.
The tests use only the standard library so they run in a clean checkout.
"""

from __future__ import annotations

import json
import random
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

from reconcile.cli import main  # noqa: E402
from reconcile.records import MAX_SIZE  # noqa: E402

HEX64 = "a" * 64
HEX64_B = "b" * 64
HEX64_C = "c" * 64


class CliTestCase(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = Path(tempfile.mkdtemp(prefix="reconcile-test-"))
        self.manifest = self.tmp / "manifest.jsonl"
        self.target = self.tmp / "target.tsv"
        self.detail = self.tmp / "detail.jsonl"
        self.summary = self.tmp / "summary.json"

    def tearDown(self) -> None:
        shutil.rmtree(self.tmp, ignore_errors=True)

    # -- helpers -----------------------------------------------------------

    def write_manifest(self, records: list[dict]) -> None:
        with open(self.manifest, "w", encoding="utf-8") as handle:
            for record in records:
                handle.write(json.dumps(record))
                handle.write("\n")

    def write_target(self, rows: list[tuple[str, int, str]]) -> None:
        with open(self.target, "w", encoding="utf-8") as handle:
            handle.write("key\tsize\tsha256\n")
            for key, size, sha in rows:
                handle.write(f"{key}\t{size}\t{sha}\n")

    def run_reconcile(self, *extra: str) -> int:
        return main(
            [
                "--manifest",
                str(self.manifest),
                "--target",
                str(self.target),
                "--detail",
                str(self.detail),
                "--summary",
                str(self.summary),
                *extra,
            ]
        )

    def detail_rows(self) -> list[dict]:
        with open(self.detail, encoding="utf-8") as handle:
            return [json.loads(line) for line in handle if line.strip()]

    def detail_by_key(self) -> dict[str, dict]:
        rows = self.detail_rows()
        return {row["key"]: row for row in rows}

    def read_summary(self) -> dict:
        with open(self.summary, encoding="utf-8") as handle:
            return json.load(handle)

    # -- classification ----------------------------------------------------

    def test_four_non_conflict_statuses(self) -> None:
        self.write_manifest(
            [
                {"key": "consistent", "size": 10, "sha256": HEX64},
                {"key": "missing", "size": 20, "sha256": HEX64_B},
                {"key": "size-mismatch", "size": 30, "sha256": HEX64_C},
                {"key": "sha-mismatch", "size": 40, "sha256": HEX64},
                {"key": "both-mismatch", "size": 50, "sha256": HEX64},
            ]
        )
        self.write_target(
            [
                ("consistent", 10, HEX64),
                ("extra", 99, HEX64_B),
                ("size-mismatch", 31, HEX64_C),
                ("sha-mismatch", 40, HEX64_B),
                ("both-mismatch", 51, HEX64_C),
            ]
        )

        self.assertEqual(self.run_reconcile(), 0)
        rows = self.detail_by_key()
        self.assertEqual(rows["consistent"]["status"], "consistent")
        self.assertEqual(rows["missing"]["status"], "missing_in_target")
        self.assertEqual(rows["extra"]["status"], "extra_in_target")

        self.assertEqual(
            rows["size-mismatch"]["differing_fields"], ["size"]
        )
        self.assertEqual(
            rows["sha-mismatch"]["differing_fields"], ["sha256"]
        )
        self.assertEqual(
            rows["both-mismatch"]["differing_fields"], ["size", "sha256"]
        )
        self.assertEqual(
            rows["both-mismatch"]["status"], "content_mismatch"
        )

        counts = self.read_summary()["status_counts"]
        self.assertEqual(counts["consistent"], 1)
        self.assertEqual(counts["missing_in_target"], 1)
        self.assertEqual(counts["extra_in_target"], 1)
        self.assertEqual(counts["content_mismatch"], 3)
        self.assertEqual(counts["manifest_conflict"], 0)
        self.assertEqual(counts["target_conflict"], 0)
        self.assertEqual(self.read_summary()["total_objects"], 6)

    def test_detail_is_sorted_by_key(self) -> None:
        keys = [f"key-{i:04d}" for i in range(200)]
        shuffled = keys[:]
        random.Random(7).shuffle(shuffled)
        self.write_manifest(
            [{"key": key, "size": 1, "sha256": HEX64} for key in shuffled]
        )
        self.write_target([(key, 1, HEX64) for key in reversed(keys)])

        self.assertEqual(self.run_reconcile(), 0)
        emitted = [row["key"] for row in self.detail_rows()]
        self.assertEqual(emitted, sorted(keys))

    def test_only_differences_flag(self) -> None:
        self.write_manifest(
            [
                {"key": "ok", "size": 1, "sha256": HEX64},
                {"key": "gone", "size": 2, "sha256": HEX64_B},
            ]
        )
        self.write_target([("ok", 1, HEX64)])
        self.assertEqual(self.run_reconcile("--only-differences"), 0)
        statuses = {row["key"]: row["status"] for row in self.detail_rows()}
        self.assertNotIn("ok", statuses)
        self.assertEqual(statuses["gone"], "missing_in_target")
        # Summary still counts the consistent object.
        self.assertEqual(self.read_summary()["status_counts"]["consistent"], 1)

    # -- duplicates and conflicts -----------------------------------------

    def test_identical_duplicate_records_merge_to_one_row(self) -> None:
        self.write_manifest(
            [
                {"key": "k", "source": "s1", "size": 10, "sha256": HEX64},
                {"key": "k", "source": "s1", "size": 10, "sha256": HEX64},
                {"key": "k", "source": "s1", "size": 10, "sha256": HEX64},
            ]
        )
        self.write_target([("k", 10, HEX64)])

        self.assertEqual(self.run_reconcile(), 0)
        rows = self.detail_rows()
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["status"], "consistent")
        summary = self.read_summary()
        self.assertEqual(summary["identical_records_merged"]["manifest"], 2)

    def test_same_source_conflicting_size_is_manifest_conflict(self) -> None:
        self.write_manifest(
            [
                {"key": "k", "source": "s1", "size": 10, "sha256": HEX64},
                {"key": "k", "source": "s1", "size": 11, "sha256": HEX64},
            ]
        )
        # The target matches one of the two conflicting claims; the key must
        # still be excluded from cross-source comparison.
        self.write_target([("k", 10, HEX64)])

        self.assertEqual(self.run_reconcile(), 0)
        rows = self.detail_rows()
        self.assertEqual(len(rows), 1)
        row = rows[0]
        self.assertEqual(row["status"], "manifest_conflict")
        self.assertEqual(row["reason"], "same_source_conflicting_values")
        self.assertEqual(row["conflicts"][0]["source"], "s1")
        self.assertEqual(row["conflicts"][0]["distinct_value_count"], 2)
        self.assertEqual(
            row["conflicts"][0]["values"],
            [
                {"size": 10, "sha256": HEX64},
                {"size": 11, "sha256": HEX64},
            ],
        )
        self.assertNotIn("manifest", row)
        self.assertNotIn("target", row)
        self.assertEqual(
            self.read_summary()["status_counts"]["manifest_conflict"], 1
        )

    def test_same_source_conflicting_sha_is_manifest_conflict(self) -> None:
        self.write_manifest(
            [
                {"key": "k", "source": "s1", "size": 10, "sha256": HEX64},
                {"key": "k", "source": "s1", "size": 10, "sha256": HEX64_B},
            ]
        )
        self.write_target([("k", 10, HEX64)])

        self.assertEqual(self.run_reconcile(), 0)
        row = self.detail_rows()[0]
        self.assertEqual(row["status"], "manifest_conflict")
        self.assertEqual(
            row["conflicts"][0]["values"],
            [
                {"size": 10, "sha256": HEX64},
                {"size": 10, "sha256": HEX64_B},
            ],
        )

    def test_conflict_key_appears_once_with_many_sources(self) -> None:
        self.write_manifest(
            [
                {"key": "k", "source": "s1", "size": 10, "sha256": HEX64},
                {"key": "k", "source": "s1", "size": 12, "sha256": HEX64},
                {"key": "k", "source": "s2", "size": 10, "sha256": HEX64},
                {"key": "k", "source": "s3", "size": 10, "sha256": HEX64},
            ]
        )
        self.write_target([("k", 10, HEX64)])

        self.assertEqual(self.run_reconcile(), 0)
        rows = self.detail_rows()
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["status"], "manifest_conflict")
        self.assertEqual(rows[0]["conflicts"][0]["source"], "s1")

    def test_cross_source_disagreement_is_conflict(self) -> None:
        self.write_manifest(
            [
                {"key": "k", "source": "s1", "size": 10, "sha256": HEX64},
                {"key": "k", "source": "s2", "size": 11, "sha256": HEX64},
            ]
        )
        self.write_target([("k", 10, HEX64)])

        self.assertEqual(self.run_reconcile(), 0)
        row = self.detail_rows()[0]
        self.assertEqual(row["status"], "manifest_conflict")
        self.assertEqual(row["reason"], "cross_source_disagreement")
        self.assertEqual(len(row["distinct_manifest_values"]), 2)

    def test_different_sources_agreeing_merge_and_compare(self) -> None:
        self.write_manifest(
            [
                {"key": "k", "source": "s1", "size": 10, "sha256": HEX64},
                {"key": "k", "source": "s2", "size": 10, "sha256": HEX64},
            ]
        )
        self.write_target([("k", 10, HEX64)])
        self.assertEqual(self.run_reconcile(), 0)
        self.assertEqual(self.detail_rows()[0]["status"], "consistent")

    def test_default_source_when_field_absent(self) -> None:
        self.write_manifest(
            [
                {"key": "k", "size": 10, "sha256": HEX64},
                {"key": "k", "size": 11, "sha256": HEX64},
            ]
        )
        self.write_target([("k", 10, HEX64)])
        self.assertEqual(self.run_reconcile(), 0)
        row = self.detail_rows()[0]
        self.assertEqual(row["status"], "manifest_conflict")
        self.assertEqual(row["conflicts"][0]["source"], "default")

    def test_target_duplicate_identical_rows_merge(self) -> None:
        self.write_manifest([{"key": "k", "size": 10, "sha256": HEX64}])
        self.write_target([("k", 10, HEX64), ("k", 10, HEX64)])
        self.assertEqual(self.run_reconcile(), 0)
        self.assertEqual(self.detail_rows()[0]["status"], "consistent")
        self.assertEqual(
            self.read_summary()["identical_records_merged"]["target"], 1
        )

    def test_target_conflicting_duplicates_are_target_conflict(self) -> None:
        self.write_manifest([{"key": "k", "size": 10, "sha256": HEX64}])
        self.write_target([("k", 10, HEX64), ("k", 11, HEX64)])
        self.assertEqual(self.run_reconcile(), 0)
        row = self.detail_rows()[0]
        self.assertEqual(row["status"], "target_conflict")
        self.assertEqual(len(row["distinct_target_values"]), 2)

    def test_target_conflict_on_extra_key_is_not_compared_to_manifest(self) -> None:
        # Target-only key with contradictory rows is reported as a target
        # conflict, never silently collapsed into an "extra" row.
        self.write_manifest([{"key": "other", "size": 1, "sha256": HEX64}])
        self.write_target(
            [("k", 10, HEX64), ("k", 11, HEX64), ("other", 1, HEX64)]
        )
        self.assertEqual(self.run_reconcile(), 0)
        rows = self.detail_by_key()
        self.assertEqual(rows["k"]["status"], "target_conflict")
        self.assertEqual(rows["other"]["status"], "consistent")

    def test_many_conflicting_sources_are_capped_and_marked(self) -> None:
        from reconcile.engine import REPORT_CAP

        records = []
        for i in range(REPORT_CAP + 3):
            records.append(
                {"key": "k", "source": f"s{i:02d}", "size": i, "sha256": HEX64}
            )
            records.append(
                {"key": "k", "source": f"s{i:02d}", "size": i + 1, "sha256": HEX64}
            )
        self.write_manifest(records)
        self.write_target([("k", 0, HEX64)])
        self.assertEqual(self.run_reconcile(), 0)
        row = self.detail_rows()[0]
        self.assertEqual(row["status"], "manifest_conflict")
        self.assertLessEqual(len(row["conflicts"]), REPORT_CAP)
        self.assertTrue(row["truncated"])
        self.assertEqual(
            self.read_summary()["truncated_conflict_reports"], 1
        )

    def test_cross_source_values_are_capped_but_still_flag_conflict(self) -> None:
        from reconcile.engine import REPORT_CAP

        records = [
            {"key": "k", "source": f"s{i:02d}", "size": i, "sha256": HEX64}
            for i in range(REPORT_CAP + 2)
        ]
        self.write_manifest(records)
        self.write_target([("k", 0, HEX64)])
        self.assertEqual(self.run_reconcile(), 0)
        row = self.detail_rows()[0]
        self.assertEqual(row["status"], "manifest_conflict")
        self.assertEqual(row["reason"], "cross_source_disagreement")
        self.assertLessEqual(
            len(row["distinct_manifest_values"]), REPORT_CAP
        )
        self.assertTrue(row["truncated"])

    # -- determinism -------------------------------------------------------

    def test_shuffling_either_side_gives_identical_output(self) -> None:
        rng = random.Random(2024)
        keys = [f"obj/{i:05d}" for i in range(300)]
        manifest_records: list[dict] = []
        target_rows: list[tuple[str, int, str]] = []
        sources = ("s1", "s2")
        for index, key in enumerate(keys):
            size = 100 + index
            sha = f"{index:064x}"
            # Inject identical duplicates and a handful of conflicts.
            manifest_records.append(
                {"key": key, "source": rng.choice(sources), "size": size, "sha256": sha}
            )
            if index % 7 == 0:
                manifest_records.append(
                    {"key": key, "source": rng.choice(sources), "size": size, "sha256": sha}
                )
            if index % 37 == 0:
                manifest_records.append(
                    {"key": key, "source": "s1", "size": size + 1, "sha256": sha}
                )
            if index % 5 == 0:
                continue  # missing in target
            target_rows.append((key, size if index % 11 else size + 5, sha))
            if index % 13 == 0:
                target_rows.append((key, size if index % 11 else size + 5, sha))
        for seed in (1, 2, 99):
            shuffled_manifest = manifest_records[:]
            shuffled_target = target_rows[:]
            rng_seed = random.Random(seed)
            rng_seed.shuffle(shuffled_manifest)
            rng_seed.shuffle(shuffled_target)
            self.write_manifest(shuffled_manifest)
            self.write_target(shuffled_target)
            self.assertEqual(self.run_reconcile(), 0)
            detail = self.detail.read_bytes()
            summary = self.summary.read_bytes()
            if seed == 1:
                baseline_detail, baseline_summary = detail, summary
            else:
                self.assertEqual(detail, baseline_detail)
                self.assertEqual(summary, baseline_summary)

    # -- parsing and validation -------------------------------------------

    def test_aliases_and_unordered_target_header(self) -> None:
        self.write_manifest(
            [{"object_key": "k", "bytes": 10, "hash": HEX64.upper()}]
        )
        with open(self.target, "w", encoding="utf-8") as handle:
            handle.write("sha256\tobject_key\tbytes\n")
            handle.write(f"{HEX64}\tk\t10\n")
        self.assertEqual(self.run_reconcile(), 0)
        self.assertEqual(self.detail_rows()[0]["status"], "consistent")

    def test_sha256_compared_case_insensitively(self) -> None:
        self.write_manifest([{"key": "k", "size": 1, "sha256": HEX64.upper()}])
        self.write_target([("k", 1, HEX64)])
        self.assertEqual(self.run_reconcile(), 0)
        self.assertEqual(self.detail_rows()[0]["status"], "consistent")

    def test_blank_lines_and_crlf_are_ignored(self) -> None:
        with open(self.manifest, "wb") as handle:
            handle.write(b"\n")
            handle.write(
                (json.dumps({"key": "k", "size": 1, "sha256": HEX64}) + "\r\n").encode()
            )
            handle.write(b"\r\n")
        with open(self.target, "wb") as handle:
            handle.write(b"key\tsize\tsha256\r\n")
            handle.write(f"k\t1\t{HEX64}\r\n".encode())
        self.assertEqual(self.run_reconcile(), 0)
        self.assertEqual(self.detail_rows()[0]["status"], "consistent")

    def test_line_longer_than_limit_is_rejected(self) -> None:
        long_key = "x" * (4096 + 10)
        self.write_manifest(
            [{"key": long_key, "size": 1, "sha256": HEX64}]
        )
        self.write_target([])
        self.assertEqual(self.run_reconcile(), 2)

    def test_invalid_json_is_rejected_with_line_number(self) -> None:
        with open(self.manifest, "w", encoding="utf-8") as handle:
            handle.write('{"key": "ok", "size": 1, "sha256": "' + HEX64 + '"}\n')
            handle.write("{not json}\n")
        self.write_target([])
        self.assertEqual(self.run_reconcile(), 2)

    def test_negative_size_is_rejected(self) -> None:
        self.write_manifest([{"key": "k", "size": -1, "sha256": HEX64}])
        self.write_target([])
        self.assertEqual(self.run_reconcile(), 2)

    def test_missing_required_field_is_rejected(self) -> None:
        self.write_manifest([{"key": "k", "size": 1}])
        self.write_target([])
        self.assertEqual(self.run_reconcile(), 2)

    def test_target_header_missing_column_is_rejected(self) -> None:
        self.write_manifest([{"key": "k", "size": 1, "sha256": HEX64}])
        with open(self.target, "w", encoding="utf-8") as handle:
            handle.write("key\tsize\n")
        self.assertEqual(self.run_reconcile(), 2)

    def test_empty_inputs_produce_empty_detail_and_zero_counts(self) -> None:
        with open(self.manifest, "w", encoding="utf-8"):
            pass
        with open(self.target, "w", encoding="utf-8") as handle:
            handle.write("key\tsize\tsha256\n")
        self.assertEqual(self.run_reconcile(), 0)
        self.assertEqual(self.detail_rows(), [])
        counts = self.read_summary()["status_counts"]
        self.assertEqual(sum(counts.values()), 0)
        self.assertEqual(self.read_summary()["total_objects"], 0)

    def test_size_string_decimal_is_accepted(self) -> None:
        self.write_manifest([{"key": "k", "size": "10", "sha256": HEX64}])
        self.write_target([("k", 10, HEX64)])
        self.assertEqual(self.run_reconcile(), 0)
        self.assertEqual(self.detail_rows()[0]["status"], "consistent")

    def test_size_at_upper_bound_is_rejected(self) -> None:
        self.write_manifest(
            [{"key": "k", "size": MAX_SIZE, "sha256": HEX64}]
        )
        self.write_target([])
        self.assertEqual(self.run_reconcile(), 2)

    # -- external sort plumbing -------------------------------------------

    def test_tiny_chunks_force_multi_run_sort(self) -> None:
        # A chunk budget of 64 KiB spills almost every key into its own run
        # and exercises the multi-pass merge paths.
        keys = [f"key-{i:05d}" for i in range(500)]
        shuffled = keys[:]
        random.Random(11).shuffle(shuffled)
        self.write_manifest(
            [
                {
                    "key": key,
                    "source": "s1",
                    "size": len(key),
                    "sha256": f"{len(key):064x}",
                }
                for key in shuffled
            ]
        )
        self.write_target(
            [(key, len(key), f"{len(key):064x}") for key in keys]
        )
        code = self.run_reconcile(
            "--memory-limit-mib",
            "16",
            "--fan-in",
            "4",
        )
        self.assertEqual(code, 0)
        rows = self.detail_rows()
        self.assertEqual([row["key"] for row in rows], sorted(keys))
        self.assertTrue(
            all(row["status"] == "consistent" for row in rows)
        )

    def test_utf8_key_ordering(self) -> None:
        keys = ["z", "ä", "é", "a", "A", "中", "1"]
        shuffled = keys[:]
        random.Random(3).shuffle(shuffled)
        self.write_manifest(
            [{"key": key, "size": 1, "sha256": HEX64} for key in shuffled]
        )
        self.write_target([(key, 1, HEX64) for key in keys])
        self.assertEqual(self.run_reconcile(), 0)
        emitted = [row["key"] for row in self.detail_rows()]
        self.assertEqual(emitted, sorted(keys))


class ModuleEntryPointTest(unittest.TestCase):
    def test_module_invocation(self) -> None:
        tmp = Path(tempfile.mkdtemp(prefix="reconcile-module-"))
        try:
            manifest = tmp / "m.jsonl"
            target = tmp / "t.tsv"
            detail = tmp / "d.jsonl"
            summary = tmp / "s.json"
            manifest.write_text(
                json.dumps({"key": "k", "size": 1, "sha256": HEX64}) + "\n",
                encoding="utf-8",
            )
            target.write_text(
                f"key\tsize\tsha256\nk\t1\t{HEX64}\n", encoding="utf-8"
            )
            proc = subprocess.run(
                [
                    sys.executable,
                    "-m",
                    "reconcile",
                    "--manifest",
                    str(manifest),
                    "--target",
                    str(target),
                    "--detail",
                    str(detail),
                    "--summary",
                    str(summary),
                ],
                cwd=REPO_ROOT,
                capture_output=True,
                text=True,
            )
            self.assertEqual(proc.returncode, 0, proc.stderr)
            self.assertTrue(detail.exists())
            self.assertTrue(summary.exists())
        finally:
            shutil.rmtree(tmp, ignore_errors=True)


if __name__ == "__main__":
    unittest.main()
