"""Tests for deterministic, mergeable stratified sampling.

Run with:  python3 -m unittest discover -s tests -v
"""

from __future__ import annotations

import gzip
import json
import os
import random
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from audit_sampling import (  # noqa: E402
    PageRecord,
    SamplingError,
    merge_summaries,
    priority_for,
    select_directly,
    summary_from_dict,
    summary_to_dict,
    summarize_records,
)
from audit_sampling import cli  # noqa: E402
from audit_sampling import io as stream_io  # noqa: E402


def make_records(count: int, seed: int = 0) -> list[PageRecord]:
    rng = random.Random(seed)
    languages = ["zh", "en", "ja"]
    records = []
    for index in range(count):
        records.append(
            PageRecord(
                page_id=f"page-{index:05d}",
                language=rng.choice(languages),
                confidence=round(rng.choice([0.5, 0.79, 0.799, 0.8, 0.85, 0.9, 0.95]), 3),
            )
        )
    return records


QUOTA = {"zh": {"low": 7, "high": 5}, "en": {"low": 4, "high": 3}, "ja": {"low": 2}}


def partition(records: list[PageRecord], parts: int, seed: int = 1) -> list[list[PageRecord]]:
    rng = random.Random(seed)
    shuffled = list(records)
    rng.shuffle(shuffled)
    return [shuffled[i::parts] for i in range(parts)]


class PriorityTests(unittest.TestCase):
    def test_priority_is_deterministic_and_seeded(self):
        self.assertEqual(priority_for("s", "p"), priority_for("s", "p"))
        self.assertNotEqual(priority_for("s", "p"), priority_for("t", "p"))
        self.assertEqual(len(priority_for("s", "p")), 64)

    def test_priority_avoids_concatenation_collisions(self):
        # (seed="ab", page="c") and (seed="a", page="bc") must differ.
        self.assertNotEqual(priority_for("ab", "c"), priority_for("a", "bc"))


class MergeEquivalenceTests(unittest.TestCase):
    def _summaries(self, partitions, seed="2026q4", quota=QUOTA):
        return [
            summarize_records(part, seed=seed, quota=quota, label=f"branch-{i}")
            for i, part in enumerate(partitions)
        ]

    def test_branch_merge_equals_single_pass(self):
        records = make_records(400, seed=7)
        direct = select_directly(records, seed="2026q4", quota=QUOTA)
        merged = merge_summaries(self._summaries(partition(records, 4)))
        for key, expected in direct.selected.items():
            self.assertEqual(merged_ids(merged, key), expected)
        for key, expected_count in direct.eligible.items():
            self.assertEqual(merged_eligible(merged, key), expected_count)

    def test_shuffled_input_order_yields_same_list(self):
        records = make_records(300, seed=11)
        base = merge_summaries(self._summaries([records]))
        shuffled = list(records)
        random.Random(99).shuffle(shuffled)
        again = merge_summaries(self._summaries([shuffled]))
        self.assertEqual(
            [s.selected_page_ids for s in base.strata],
            [s.selected_page_ids for s in again.strata],
        )

    def test_repartitioning_files_yields_same_list(self):
        records = make_records(500, seed=13)
        expected = merge_summaries(self._summaries([records]))
        for parts, part_seed in [(2, 1), (3, 2), (5, 3), (8, 4)]:
            merged = merge_summaries(
                self._summaries(partition(records, parts, seed=part_seed))
            )
            self.assertEqual(
                [s.selected_page_ids for s in expected.strata],
                [s.selected_page_ids for s in merged.strata],
                msg=f"partition into {parts} parts",
            )

    def test_merge_order_yields_same_list(self):
        records = make_records(260, seed=17)
        parts = partition(records, 4, seed=5)
        summaries = self._summaries(parts)
        orders = [
            summaries,
            list(reversed(summaries)),
            [summaries[2], summaries[0], summaries[3], summaries[1]],
        ]
        baseline = None
        for order in orders:
            merged = merge_summaries(order)
            snapshot = merged.selection_dict()
            if baseline is None:
                baseline = snapshot
            else:
                self.assertEqual(snapshot, baseline)

    def test_candidate_count_never_exceeds_quota(self):
        records = make_records(600, seed=19)
        for part in partition(records, 3):
            summary = summarize_records(part, seed="s", quota=QUOTA)
            for stratum in summary.strata.values():
                quota_value = QUOTA.get(stratum.language, {}).get(stratum.tier, 0)
                self.assertLessEqual(len(stratum.candidates), quota_value)

    def test_two_level_rollup_equals_single_pass(self):
        records = make_records(480, seed=53)
        direct = select_directly(records, seed="2026q4", quota=QUOTA)
        parts = partition(records, 6, seed=21)
        summaries = self._summaries(parts)
        regional = [
            merge_summaries(summaries[0:3]).as_summary(label="region-a"),
            merge_summaries(summaries[3:6]).as_summary(label="region-b"),
        ]
        merged = merge_summaries(regional)
        for key, expected in direct.selected.items():
            self.assertEqual(merged_ids(merged, key), expected)
        self.assertEqual(merged.totals["eligible"], sum(direct.eligible.values()))

    def test_underfilled_strata_report_shortfall(self):
        records = [
            PageRecord("p1", "zh", 0.9),
            PageRecord("p2", "zh", 0.75),
            PageRecord("p3", "fr", 0.95),
        ]
        merged = merge_summaries([summarize_records(records, seed="s", quota=QUOTA)])
        by_key = {(s.language, s.tier): s for s in merged.strata}
        self.assertEqual(by_key[("zh", "high")].eligible, 1)
        self.assertEqual(by_key[("zh", "high")].selected_count, 1)
        self.assertEqual(by_key[("zh", "high")].shortfall, 4)
        self.assertEqual(by_key[("zh", "low")].eligible, 1)
        self.assertEqual(by_key[("zh", "low")].shortfall, 6)
        # A language absent from all data still appears via the quota table.
        self.assertEqual(by_key[("ja", "low")].eligible, 0)
        self.assertEqual(by_key[("ja", "low")].shortfall, 2)
        # A language with data but no quota reports zero shortfall beyond 0.
        self.assertEqual(by_key[("fr", "high")].quota, 0)
        self.assertEqual(by_key[("fr", "high")].selected_count, 0)
        self.assertEqual(by_key[("fr", "high")].shortfall, 0)

    def test_threshold_boundary(self):
        records = [
            PageRecord("below", "zh", 0.799),
            PageRecord("at", "zh", 0.8),
            PageRecord("above", "zh", 0.801),
        ]
        summary = summarize_records(records, seed="s", quota=QUOTA)
        low = summary.strata[("zh", "low")]
        high = summary.strata[("zh", "high")]
        self.assertEqual([c.page_id for c in low.candidates], ["below"])
        self.assertEqual(
            sorted(c.page_id for c in high.candidates), ["above", "at"]
        )

    def test_reviewed_records_are_excluded_before_counting(self):
        records = make_records(300, seed=23)
        reviewed = {r.page_id for r in records[::3]}
        merged = merge_summaries(
            [summarize_records(records, seed="s", quota=QUOTA, reviewed_ids=reviewed)]
        )
        direct = select_directly(records, seed="s", quota=QUOTA, reviewed_ids=reviewed)
        selected = set(merged.selected_page_ids)
        self.assertFalse(selected & reviewed)
        for key, expected in direct.selected.items():
            self.assertEqual(merged_ids(merged, key), expected)

    def test_duplicate_candidates_across_branches_are_rejected(self):
        # Same page ID summarised by two branches: the ID can be a candidate in
        # both summaries, which means the inputs overlapped and must be fixed.
        records = [PageRecord(f"p{i}", "zh", 0.9) for i in range(10)]
        quota = {"zh": {"low": 0, "high": 5}}
        first = summarize_records(records, seed="s", quota=quota, label="a")
        second = summarize_records(records, seed="s", quota=quota, label="b")
        with self.assertRaises(SamplingError) as caught:
            merge_summaries([first, second])
        self.assertIn("both", str(caught.exception))

    def test_mismatched_seed_is_rejected(self):
        records = make_records(50, seed=31)
        with self.assertRaises(SamplingError):
            merge_summaries(
                [
                    summarize_records(records, seed="a", quota=QUOTA),
                    summarize_records(records, seed="b", quota=QUOTA),
                ]
            )

    def test_mismatched_quota_is_rejected(self):
        records = make_records(50, seed=37)
        with self.assertRaises(SamplingError):
            merge_summaries(
                [
                    summarize_records(records, seed="s", quota=QUOTA),
                    summarize_records(
                        records, seed="s", quota={"zh": {"low": 1, "high": 1}}
                    ),
                ]
            )


class SummarySerializationTests(unittest.TestCase):
    def test_json_round_trip_preserves_selection(self):
        records = make_records(200, seed=41)
        original = summarize_records(records, seed="s", quota=QUOTA, label="branch")
        payload = summary_to_dict(original)
        restored = summary_from_dict(json.loads(json.dumps(payload)))
        merged_a = merge_summaries([original])
        merged_b = merge_summaries([restored])
        self.assertEqual(merged_a.selection_dict(), merged_b.selection_dict())

    def test_tampered_priority_is_rejected(self):
        records = [PageRecord(f"p{i}", "zh", 0.9) for i in range(20)]
        payload = summary_to_dict(summarize_records(records, seed="s", quota=QUOTA))
        candidates = payload["strata"]["zh"]["high"]["candidates"]
        self.assertTrue(candidates, "fixture should retain at least one candidate")
        candidates[0]["priority"] = "0" * 64
        with self.assertRaises(SamplingError):
            summary_from_dict(payload)

    def test_oversized_candidate_list_is_rejected(self):
        records = [
            PageRecord(f"p{i}", "zh", 0.9) for i in range(5)
        ]
        payload = summary_to_dict(
            summarize_records(records, seed="s", quota={"zh": {"low": 0, "high": 2}})
        )
        entry = payload["strata"]["zh"]["high"]
        entry["candidates"].append(
            {"page_id": "extra", "priority": priority_for("s", "extra")}
        )
        with self.assertRaises(SamplingError):
            summary_from_dict(payload)


class StreamingTests(unittest.TestCase):
    def test_memory_shape_only_keeps_quota_candidates(self):
        balanced = {"zh": {"low": 2, "high": 2}}
        records = [PageRecord(f"p{i}", "zh", 0.9) for i in range(10000)]
        summary = summarize_records(records, seed="s", quota=balanced)
        self.assertEqual(summary.strata[("zh", "high")].eligible, 10000)
        self.assertEqual(len(summary.strata[("zh", "high")].candidates), 2)


class CliEndToEndTests(unittest.TestCase):
    def test_gzip_branch_summaries_merge_to_same_list_as_direct(self):
        records = make_records(500, seed=47)
        reviewed = {r.page_id for r in records[::7]}
        with tempfile.TemporaryDirectory() as tmp:
            quota_path = os.path.join(tmp, "quota.json")
            reviewed_path = os.path.join(tmp, "reviewed.json")
            with open(quota_path, "w", encoding="utf-8") as handle:
                json.dump(QUOTA, handle)
            with open(reviewed_path, "w", encoding="utf-8") as handle:
                json.dump(sorted(reviewed), handle)

            parts = partition(records, 3, seed=9)
            summary_paths = []
            for index, part in enumerate(parts):
                input_path = os.path.join(tmp, f"branch-{index}.jsonl.gz")
                with gzip.open(input_path, "wt", encoding="utf-8") as handle:
                    for record in part:
                        handle.write(
                            json.dumps(
                                {
                                    "page_id": record.page_id,
                                    "language": record.language,
                                    "confidence": record.confidence,
                                }
                            )
                            + "\n"
                        )
                summary_path = os.path.join(tmp, f"branch-{index}.summary.json")
                code = cli.main(
                    [
                        "summarize",
                        "--seed", "2026q4",
                        "--quota", quota_path,
                        "--reviewed", reviewed_path,
                        "--input", input_path,
                        "--out", summary_path,
                        "--label", f"branch-{index}",
                    ]
                )
                self.assertEqual(code, 0)
                summary_paths.append(summary_path)

            report_path = os.path.join(tmp, "report.json")
            selection_path = os.path.join(tmp, "selection.json")
            merge_args = ["merge"]
            for path in summary_paths:
                merge_args += ["--summary", path]
            merge_args += [
                "--quota", quota_path,
                "--report", report_path,
                "--selection", selection_path,
            ]
            self.assertEqual(cli.main(merge_args), 0)

            direct_path = os.path.join(tmp, "direct.json")
            direct_args = ["direct", "--seed", "2026q4", "--quota", quota_path,
                           "--reviewed", reviewed_path, "--out", direct_path]
            for index in range(len(parts)):
                direct_args += ["--input", os.path.join(tmp, f"branch-{index}.jsonl.gz")]
            self.assertEqual(cli.main(direct_args), 0)

            with open(selection_path, encoding="utf-8") as handle:
                selection = json.load(handle)
            selected = {entry["page_id"] for entry in selection["selected"]}
            with open(report_path, encoding="utf-8") as handle:
                report = json.load(handle)
            with open(direct_path, encoding="utf-8") as handle:
                direct_report = json.load(handle)
            direct_cli_selected = {
                page_id
                for stratum in direct_report["strata"]
                for page_id in stratum["selected_page_ids"]
            }
            self.assertEqual(direct_cli_selected, selected)

            direct = select_directly(
                records, seed="2026q4", quota=QUOTA, reviewed_ids=reviewed
            )
            expected = {
                page_id
                for ids in direct.selected.values()
                for page_id in ids
            }
            self.assertEqual(selected, expected)
            self.assertFalse(selected & reviewed)

            for stratum in report["strata"]:
                key = (stratum["language"], stratum["tier"])
                self.assertEqual(stratum["eligible"], direct.eligible[key])
                self.assertEqual(stratum["shortfall"],
                                 max(0, stratum["quota"] - stratum["selected_count"]))
            self.assertEqual(report["totals"]["selected"], len(expected))


class InputValidationTests(unittest.TestCase):
    def test_duplicate_winner_across_branches_is_rejected(self):
        # Globally unique IDs are an input contract.  Near the top of a stratum
        # a duplicated ID is very likely to surface as a candidate in both
        # summaries, and merge refuses that.
        record = PageRecord("dup", "zh", 0.9)
        summaries = [
            summarize_records(
                [record, PageRecord("z1", "zh", 0.9)], seed="s", quota=QUOTA
            ),
            summarize_records(
                [record, PageRecord("z2", "zh", 0.9)], seed="s", quota=QUOTA
            ),
        ]
        with self.assertRaises(SamplingError):
            merge_summaries(summaries)

    def test_confidence_must_be_a_probability(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = os.path.join(tmp, "bad.jsonl")
            with open(path, "w", encoding="utf-8") as handle:
                handle.write('{"page_id": "p", "language": "zh", "confidence": 1.5}\n')
            with self.assertRaises(SamplingError):
                list(stream_io.iter_page_records(path))

    def test_reviewed_ids_accept_plain_text(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = os.path.join(tmp, "reviewed.txt")
            with open(path, "w", encoding="utf-8") as handle:
                handle.write("p1\np2\n")
            self.assertEqual(stream_io.read_reviewed_ids(path), frozenset({"p1", "p2"}))


def merged_strata(merged):
    return {(s.language, s.tier): s for s in merged.strata}


def merged_ids(merged, key):
    """Selected IDs for a stratum; a quota-only stratum selects nothing."""

    stratum = merged_strata(merged).get(key)
    return () if stratum is None else stratum.selected_page_ids


def merged_eligible(merged, key):
    stratum = merged_strata(merged).get(key)
    return 0 if stratum is None else stratum.eligible


if __name__ == "__main__":
    unittest.main()
