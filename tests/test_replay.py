#!/usr/bin/env python3
"""Tests for replay.py (stdlib only: python3 -m unittest discover -s tests)."""

import csv
import io
import json
import random
import sys
import tempfile
import unittest
from contextlib import redirect_stderr, redirect_stdout
from datetime import datetime, timedelta, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import replay  # noqa: E402

BASE = datetime(2026, 11, 13, 8, 0, 0, tzinfo=timezone.utc)


def ts(minutes: float, seconds: float = 0.0) -> str:
    return (BASE + timedelta(minutes=minutes, seconds=seconds)).isoformat()


def rev(
    sample_id,
    sample_minutes,
    received_minutes,
    revision,
    *,
    value=None,
    retracted=False,
    device="dev-1",
    sample_seconds=0.0,
    received_seconds=0.0,
):
    obj = {
        "device_id": device,
        "sample_id": sample_id,
        "sample_time": ts(sample_minutes, sample_seconds),
        "received_at": ts(received_minutes, received_seconds),
        "revision": revision,
    }
    if retracted:
        obj["retracted"] = True
    else:
        obj["value"] = value
    return json.dumps(obj)


def warning(sample_minutes):
    return replay.Warning("w", BASE + timedelta(minutes=sample_minutes))


class ParsingTests(unittest.TestCase):
    def test_unknown_retraction_marker_is_an_error(self):
        with self.assertRaises(replay.ReplayError):
            replay.parse_revisions(json.dumps({
                "sample_id": "s1",
                "sample_time": ts(0),
                "received_at": ts(1),
                "revision": 1,
                "retracted": "maybe",
                "value": 1.0,
            }))

    def test_missing_value_and_no_retraction_is_an_error(self):
        with self.assertRaises(replay.ReplayError):
            replay.parse_revisions(json.dumps({
                "sample_id": "s1",
                "sample_time": ts(0),
                "received_at": ts(1),
                "revision": 1,
            }))

    def test_sample_time_is_fixed_per_sample(self):
        with self.assertRaises(replay.ReplayError):
            replay.parse_revisions("\n".join([
                rev("s1", 0, 1, 1, value=1),
                rev("s1", 5, 6, 2, value=2),
            ]))

    def test_conflicting_duplicate_line_is_an_error(self):
        with self.assertRaises(replay.ReplayError):
            replay.parse_revisions("\n".join([
                rev("s1", 0, 1, 1, value=1),
                rev("s1", 0, 1, 1, value=2),
            ]))

    def test_exact_duplicate_line_is_ignored(self):
        samples = replay.parse_revisions("\n".join([
            rev("s1", 0, 1, 1, value=1),
            rev("s1", 0, 1, 1, value=1),
        ]))
        self.assertEqual(len(samples["s1"].revisions), 1)

    def test_redelivery_keeps_earliest_receive_time(self):
        # Same revision delivered twice; the later line must not hide it from a
        # warning that happened between the two deliveries.
        samples = replay.parse_revisions("\n".join([
            rev("s1", -2, -1, 1, value=5),
            rev("s1", -2, 10, 1, value=5),
        ]))
        revision = samples["s1"].revisions[0]
        self.assertEqual(revision.line, 1)  # earliest receive time wins

    def test_retraction_may_omit_value(self):
        samples = replay.parse_revisions(rev("s1", 0, 1, 2, retracted=True))
        revision = samples["s1"].revisions[0]
        self.assertTrue(revision.retracted)
        self.assertIsNone(revision.value)

    def test_non_integer_revision_is_an_error(self):
        with self.assertRaises(replay.ReplayError):
            replay.parse_revisions(json.dumps({
                "sample_id": "s1",
                "sample_time": ts(0),
                "received_at": ts(1),
                "revision": 1.5,
                "value": 1.0,
            }))

    def test_sample_time_parsing_handles_offsets_and_z(self):
        self.assertEqual(
            replay.parse_timestamp("2026-11-13T09:00:00+01:00", "ctx"),
            replay.parse_timestamp("2026-11-13T08:00:00Z", "ctx"),
        )
        self.assertEqual(replay.parse_timestamp("2026-11-13T08:00:00Z", "ctx"), BASE)


class WindowTests(unittest.TestCase):
    def features(self, text, offset=0):
        return replay.build_features([warning(offset)], replay.parse_revisions(text))[0]

    def test_start_is_inclusive_and_warning_instant_is_exclusive(self):
        feature = self.features("\n".join([
            rev("at-start", -30, -29, 1, value=10),                        # in
            rev("before-start", -31, -30, 1, value=99),                    # out
            rev("at-warning", 0, 0, 1, value=20),                          # out
            rev("too-old", -100, -99, 1, value=50),                        # out
        ]))
        self.assertEqual([pair[0] for pair in feature.samples], ["at-start"])
        self.assertAlmostEqual(feature.mean, 10.0)
        self.assertAlmostEqual(feature.last_sample_gap_seconds, 1800.0)

    def test_window_edge_outside_is_excluded_but_inside_is_kept(self):
        feature = self.features("\n".join([
            rev("inside", -29, -28, 1, value=1),
            rev("just-outside", -30, -29, 1, value=99, sample_seconds=-1),
        ]))
        self.assertEqual(feature.samples, (("inside", 1),))

    def test_empty_window_leaves_mean_and_gap_blank(self):
        feature = self.features(rev("old", -60, -59, 1, value=5))
        self.assertEqual(feature.valid_sample_count, 0)
        self.assertIsNone(feature.mean)
        self.assertIsNone(feature.last_sample_gap_seconds)
        record = replay.feature_csv_record(feature)
        self.assertEqual(record["mean"], "")
        self.assertEqual(record["last_sample_gap_seconds"], "")
        self.assertEqual(record["sample_ids"], "")
        self.assertEqual(record["revision_numbers"], "")

    def test_gap_uses_most_recent_valid_sample(self):
        feature = self.features("\n".join([
            rev("early", -20, -19, 1, value=1),
            rev("latest", -5, -4, 1, value=3, sample_seconds=30),
            rev("dropped", -2, 0, 2, retracted=True),
        ]))
        self.assertEqual(feature.valid_sample_count, 2)
        self.assertEqual([pair[0] for pair in feature.samples], ["early", "latest"])
        self.assertAlmostEqual(feature.last_sample_gap_seconds, 270.0)

    def test_mean_uses_all_valid_samples(self):
        feature = self.features("\n".join([
            rev("a", -10, -9, 1, value=1),
            rev("b", -8, -7, 1, value=2),
            rev("c", -6, -5, 1, value=6),
        ]))
        self.assertEqual(feature.valid_sample_count, 3)
        self.assertAlmostEqual(feature.mean, 3.0)

    def test_naive_and_offset_timestamps_share_one_timeline(self):
        feature = self.features("\n".join([
            rev("a", -10, -9, 1, value=1),
            json.dumps({
                "sample_id": "b",
                "sample_time": "2026-11-13T07:55:00",
                "received_at": "2026-11-13T07:56:00",
                "revision": 1,
                "value": 3,
            }),
        ]))
        self.assertEqual([pair[0] for pair in feature.samples], ["a", "b"])


class RevisionVisibilityTests(unittest.TestCase):
    def features(self, text):
        return replay.build_features([warning(0)], replay.parse_revisions(text))[0]

    def test_highest_revision_received_by_warning_wins(self):
        feature = self.features("\n".join([
            rev("s", -1, -0.5, 1, value=1),
            rev("s", -1, 0, 2, value=2),                       # received exactly at T
            rev("s", -1, 0, 3, value=3, received_seconds=60),  # +1 min: invisible
        ]))
        self.assertEqual(feature.samples, (("s", 2),))
        self.assertAlmostEqual(feature.mean, 2.0)

    def test_retraction_at_exact_warning_time_drops_sample(self):
        feature = self.features("\n".join([
            rev("s", -1, -0.5, 1, value=1),
            rev("s", -1, 0, 2, retracted=True),
        ]))
        self.assertEqual(feature.valid_sample_count, 0)
        self.assertIsNone(feature.mean)

    def test_retraction_arriving_later_is_invisible(self):
        feature = self.features("\n".join([
            rev("s", -1, -0.5, 1, value=1),
            rev("s", -1, 5, 2, retracted=True),
        ]))
        self.assertEqual(feature.samples, (("s", 1),))

    def test_later_retraction_does_not_undo_visible_revision(self):
        feature = self.features("\n".join([
            rev("s", -1, -0.5, 1, value=1),
            rev("s", -1, -0.1, 2, value=2),
            rev("s", -1, 5, 3, retracted=True),
        ]))
        self.assertEqual(feature.samples, (("s", 2),))

    def test_sample_whose_first_revision_arrives_after_warning_is_excluded(self):
        feature = self.features("\n".join([
            rev("on-time", -2, -1, 1, value=1),
            rev("late-arrival", -3, 10, 1, value=99),  # in window, unknown at T
        ]))
        self.assertEqual(feature.samples, (("on-time", 1),))
        self.assertAlmostEqual(feature.mean, 1.0)


class EndToEndTests(unittest.TestCase):
    def run_cli(self, tmp, warnings_text, revisions_text, *extra):
        wpath = Path(tmp, "warnings.csv")
        rpath = Path(tmp, "revisions.jsonl")
        opath = Path(tmp, "out.csv")
        wpath.write_text(warnings_text, encoding="utf-8")
        rpath.write_text(revisions_text, encoding="utf-8")
        stdout, stderr = io.StringIO(), io.StringIO()
        with redirect_stdout(stdout), redirect_stderr(stderr):
            code = replay.main([
                "--warnings", str(wpath),
                "--revisions", str(rpath),
                "-o", str(opath),
                *extra,
            ])
        output = opath.read_text(encoding="utf-8") if opath.exists() else None
        return code, output, stderr.getvalue()

    def test_later_revisions_leave_earlier_warnings_untouched(self):
        warnings_text = (
            "warning_id,warning_time\n"
            f"w1,{ts(0)}\n"
            f"w2,{ts(30)}\n"
        )
        initial = "\n".join([
            rev("a", -25, -24, 1, value=5),
            rev("b", -10, -9, 1, value=10),
            rev("c", 15, 16, 1, value=20),
            rev("d", 25, 26, 1, value=30),
        ])
        with tempfile.TemporaryDirectory() as tmp:
            code, first, _ = self.run_cli(tmp, warnings_text, initial)
            self.assertEqual(code, 0)
            self.assertEqual(
                first,
                "warning_id,valid_sample_count,mean,last_sample_gap_seconds,"
                "sample_ids,revision_numbers\n"
                "w1,2,7.5,600,a|b,1|1\n"
                "w2,2,25,300,c|d,1|1\n",
            )
            baseline = Path(tmp, "out.csv")

            # The re-export now also carries revisions received after both warnings.
            later = initial + "\n" + "\n".join([
                rev("b", -10, 40, 2, retracted=True),
                rev("a", -25, 41, 2, value=500),
            ])
            code, second, stderr = self.run_cli(
                tmp, warnings_text, later, "--baseline", str(baseline)
            )
            self.assertEqual(code, 0, stderr)
            self.assertEqual(second, first)
            self.assertIn("all warnings match the previous run", stderr)

    def test_out_of_order_stream_matches_in_order(self):
        warnings_text = f"warning_id,warning_time\nw,{ts(0)}\n"
        ordered = [
            rev("a", -10, -9, 1, value=1),
            rev("b", -8, -7, 1, value=2),
            rev("a", -10, -6, 2, value=3),
            rev("b", -8, -5, 2, retracted=True),
        ]
        shuffled = ordered[:]
        random.Random(7).shuffle(shuffled)
        with tempfile.TemporaryDirectory() as tmp:
            _, out_ordered, _ = self.run_cli(tmp, warnings_text, "\n".join(ordered))
            _, out_shuffled, _ = self.run_cli(tmp, warnings_text, "\n".join(shuffled))
        self.assertEqual(out_ordered, out_shuffled)
        self.assertEqual(out_ordered.splitlines()[-1], "w,1,3,600,a,2")

    def test_self_check_passes_on_adversarial_stream(self):
        warnings_text = (
            "warning_id,warning_time\n"
            f"w1,{ts(0)}\n"
            f"w2,{ts(30)}\n"
        )
        stream = "\n".join([
            rev("b", -10, 600, 3, retracted=True),    # far-future retraction
            rev("a", -25, 601, 2, value=500),         # far-future correction
            rev("d", -10, -9, 2, value=7),
            rev("d", -10, -9.5, 1, value=1),
            rev("c", 15, 16, 1, value=20),
            rev("b", -10, -9, 1, value=10),
        ])
        with tempfile.TemporaryDirectory() as tmp:
            code, _, stderr = self.run_cli(tmp, warnings_text, stream, "--self-check")
        self.assertEqual(code, 0, stderr)
        self.assertIn("order-independent and incremental replay OK", stderr)

    def test_baseline_detects_a_changed_row(self):
        warnings_text = f"warning_id,warning_time\nw,{ts(0)}\n"
        with tempfile.TemporaryDirectory() as tmp:
            baseline = Path(tmp, "baseline.csv")
            baseline.write_text(
                "warning_id,valid_sample_count,mean,last_sample_gap_seconds,"
                "sample_ids,revision_numbers\nw,1,99,600,a,1\n",
                encoding="utf-8",
            )
            code, _, stderr = self.run_cli(
                tmp, warnings_text, rev("a", -10, -9, 1, value=1),
                "--baseline", str(baseline),
            )
        self.assertEqual(code, 1)
        self.assertIn("mean: '99' -> '1'", stderr)

    def test_baseline_reports_missing_and_extra_warnings(self):
        warnings_text = f"warning_id,warning_time\nw2,{ts(0)}\n"
        with tempfile.TemporaryDirectory() as tmp:
            baseline = Path(tmp, "baseline.csv")
            baseline.write_text(
                "warning_id,valid_sample_count,mean,last_sample_gap_seconds,"
                "sample_ids,revision_numbers\nw1,0,,,,\n",
                encoding="utf-8",
            )
            code, _, stderr = self.run_cli(
                tmp, warnings_text, "", "--baseline", str(baseline),
            )
        self.assertEqual(code, 1)
        self.assertIn("w1: warning missing from fresh replay", stderr)
        self.assertIn("w2: new warning not present in baseline", stderr)

    def test_json_output_shape(self):
        warnings_text = f"warning_id,warning_time\nw,{ts(0)}\n"
        revisions = "\n".join([
            rev("a", -10, -9, 1, value=1),
            rev("b", -5, -4, 2, value=3),
        ])
        with tempfile.TemporaryDirectory() as tmp:
            wpath = Path(tmp, "w.csv")
            rpath = Path(tmp, "r.jsonl")
            opath = Path(tmp, "o.json")
            wpath.write_text(warnings_text, encoding="utf-8")
            rpath.write_text(revisions, encoding="utf-8")
            with redirect_stdout(io.StringIO()), redirect_stderr(io.StringIO()):
                code = replay.main([
                    "--warnings", str(wpath), "--revisions", str(rpath),
                    "-o", str(opath), "--format", "json",
                ])
            payload = json.loads(opath.read_text(encoding="utf-8"))
        self.assertEqual(code, 0)
        self.assertEqual(payload, [{
            "warning_id": "w",
            "valid_sample_count": 2,
            "mean": 2.0,
            "last_sample_gap_seconds": 300.0,
            "samples": [
                {"sample_id": "a", "revision": 1},
                {"sample_id": "b", "revision": 2},
            ],
        }])

    def test_duplicate_warning_ids_are_rejected(self):
        warnings_text = f"warning_id,warning_time\nw,{ts(0)}\nw,{ts(1)}\n"
        with tempfile.TemporaryDirectory() as tmp:
            code, _, stderr = self.run_cli(tmp, warnings_text, "")
        self.assertEqual(code, 2)
        self.assertIn("duplicate warning id", stderr)

    def test_empty_window_row_renders_blank_fields(self):
        warnings_text = f"warning_id,warning_time\nw,{ts(0)}\n"
        with tempfile.TemporaryDirectory() as tmp:
            code, output, _ = self.run_cli(tmp, warnings_text, rev("late", 60, 61, 1, value=1))
        self.assertEqual(code, 0)
        rows = list(csv.DictReader(io.StringIO(output)))
        self.assertEqual(rows, [{
            "warning_id": "w",
            "valid_sample_count": "0",
            "mean": "",
            "last_sample_gap_seconds": "",
            "sample_ids": "",
            "revision_numbers": "",
        }])

    def test_event_column_marks_retraction(self):
        warnings_text = f"warning_id,warning_time\nw,{ts(0)}\n"
        revisions = "\n".join([
            rev("a", -5, -4, 1, value=4),
            json.dumps({
                "device_id": "dev-1",
                "sample_id": "a",
                "sample_time": ts(-5),
                "received_at": ts(-3),
                "revision": 2,
                "event": "retracted",
            }),
        ])
        with tempfile.TemporaryDirectory() as tmp:
            code, output, _ = self.run_cli(tmp, warnings_text, revisions)
        self.assertEqual(code, 0)
        rows = list(csv.DictReader(io.StringIO(output)))
        self.assertEqual(rows[0]["valid_sample_count"], "0")
        self.assertEqual(rows[0]["mean"], "")
        self.assertEqual(rows[0]["sample_ids"], "")


if __name__ == "__main__":
    unittest.main()
