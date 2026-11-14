#!/usr/bin/env python3
"""Tests for probe_sync.py."""

from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
import unittest
from fractions import Fraction

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from probe_sync import (  # noqa: E402
    InputError,
    Process,
    ProbeSample,
    SyncPoint,
    analyze,
    build_session_calibrations,
    calibrate_count,
)

SCRIPT = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "probe_sync.py")


def sample(row, device, session, count, amplitude):
    return ProbeSample(row, device, session, count, amplitude)


def sync(row, device, session, count, utc):
    return SyncPoint(row, device, session, count, utc)


def process(index, device, pid, start, end):
    return Process(index, device, pid, start, end)


class CalibrationTests(unittest.TestCase):
    def test_linear_interpolation_is_exact(self):
        calibration = build_session_calibrations(
            [sync(1, "d", "s", 0, 1_000_000), sync(2, "d", "s", 100, 1_100_000)]
        )[("d", "s")]
        self.assertEqual(calibrate_count(calibration, 25), Fraction(1_025_000))
        self.assertEqual(calibrate_count(calibration, 1), Fraction(1_001_000))

    def test_interpolation_uses_adjacent_pair_only(self):
        calibration = build_session_calibrations(
            [
                sync(1, "d", "s", 0, 0),
                sync(2, "d", "s", 10, 100),
                sync(3, "d", "s", 20, 1_000),
            ]
        )[("d", "s")]
        # Between 10 and 20 the slope is 90 us per count, not 10.
        self.assertEqual(calibrate_count(calibration, 15), Fraction(550))

    def test_outside_anchor_range_is_uncalibrated(self):
        calibration = build_session_calibrations(
            [sync(1, "d", "s", 100, 1_000), sync(2, "d", "s", 200, 2_000)]
        )[("d", "s")]
        self.assertIsNone(calibrate_count(calibration, 99))
        self.assertIsNone(calibrate_count(calibration, 201))
        self.assertEqual(calibrate_count(calibration, 100), Fraction(1_000))
        self.assertEqual(calibrate_count(calibration, 200), Fraction(2_000))

    def test_single_anchor_cannot_interpolate(self):
        calibration = build_session_calibrations([sync(1, "d", "s", 5, 500)])[("d", "s")]
        self.assertIsNone(calibrate_count(calibration, 5))

    def test_same_count_different_time_rejects_session(self):
        calibration = build_session_calibrations(
            [
                sync(1, "d", "s", 10, 1_000),
                sync(2, "d", "s", 20, 2_000),
                sync(3, "d", "s", 10, 1_001),
            ]
        )[("d", "s")]
        self.assertIsNotNone(calibration.issue)
        self.assertIn("two different times", calibration.issue)
        self.assertIsNone(calibrate_count(calibration, 15))

    def test_backwards_time_rejects_session(self):
        calibration = build_session_calibrations(
            [sync(1, "d", "s", 10, 2_000), sync(2, "d", "s", 20, 1_000)]
        )[("d", "s")]
        self.assertIsNotNone(calibration.issue)
        self.assertIn("backwards", calibration.issue)
        self.assertIsNone(calibrate_count(calibration, 15))

    def test_sessions_are_independent_across_counter_reset(self):
        calibrations = build_session_calibrations(
            [
                sync(1, "d", "s1", 0, 0),
                sync(2, "d", "s1", 100, 1_000),
                sync(3, "d", "s2", 0, 5_000),
                sync(4, "d", "s2", 100, 6_000),
            ]
        )
        self.assertEqual(calibrate_count(calibrations[("d", "s1")], 50), Fraction(500))
        self.assertEqual(calibrate_count(calibrations[("d", "s2")], 50), Fraction(5_500))

    def test_out_of_order_sync_rows_are_sorted(self):
        calibration = build_session_calibrations(
            [sync(1, "d", "s", 100, 1_000), sync(2, "d", "s", 0, 0)]
        )[("d", "s")]
        self.assertIsNone(calibration.issue)
        self.assertEqual(calibrate_count(calibration, 50), Fraction(500))


class AttributionTests(unittest.TestCase):
    def setUp(self):
        self.sync = [
            sync(1, "d", "s", 0, 1_000_000),
            sync(2, "d", "s", 100, 1_100_000),
        ]

    def test_half_open_boundaries(self):
        processes = [
            process(0, "d", "P1", 1_050_000, 1_100_000),
            process(1, "d", "P2", 1_100_000, 1_200_000),
        ]
        samples = [
            sample(2, "d", "s", 50, 1.0),  # exactly at P1 start
            sample(3, "d", "s", 100, 2.0),  # exactly at P1 end == P2 start
        ]
        report = analyze(samples, self.sync, processes)
        self.assertEqual(report.processes[0].valid_samples, 1)
        self.assertEqual(report.processes[0].peak.row, 2)
        self.assertEqual(report.processes[1].valid_samples, 1)
        self.assertEqual(report.processes[1].peak.row, 3)
        self.assertEqual(report.unlocated, [])
        self.assertEqual(report.uncalibrated, [])

    def test_tie_prefers_earliest_calibrated_time(self):
        processes = [process(0, "d", "P1", 1_000_000, 1_200_000)]
        samples = [
            sample(2, "d", "s", 80, 5.0),  # later in time, listed first
            sample(3, "d", "s", 20, 5.0),  # earlier in time, listed second
        ]
        report = analyze(samples, self.sync, processes)
        self.assertEqual(report.processes[0].valid_samples, 2)
        self.assertEqual(report.processes[0].peak.row, 3)

    def test_tie_on_time_falls_back_to_row_order(self):
        processes = [process(0, "d", "P1", 1_000_000, 1_200_000)]
        samples = [
            sample(5, "d", "s", 40, 5.0),
            sample(9, "d", "s", 40, 5.0),
        ]
        report = analyze(samples, self.sync, processes)
        self.assertEqual(report.processes[0].peak.row, 5)

    def test_higher_amplitude_beats_earlier_time(self):
        processes = [process(0, "d", "P1", 1_000_000, 1_200_000)]
        samples = [
            sample(2, "d", "s", 10, 4.0),
            sample(3, "d", "s", 90, 4.5),
        ]
        report = analyze(samples, self.sync, processes)
        self.assertEqual(report.processes[0].peak.row, 3)

    def test_process_with_no_samples_has_no_peak(self):
        processes = [process(0, "d", "P1", 2_000_000, 3_000_000)]
        report = analyze([sample(2, "d", "s", 50, 1.0)], self.sync, processes)
        self.assertEqual(report.processes[0].valid_samples, 0)
        self.assertIsNone(report.processes[0].peak)
        self.assertEqual(len(report.unlocated), 1)

    def test_unlocated_and_uncalibrated_are_separate(self):
        processes = [process(0, "d", "P1", 1_000_000, 1_060_000)]
        samples = [
            sample(2, "d", "s", 50, 1.0),  # calibrated, inside P1
            sample(3, "d", "s", 75, 2.0),  # calibrated, in no process
            sample(4, "d", "s", 500, 3.0),  # outside anchored range
            sample(5, "d", "unknown", 10, 4.0),  # session with no sync points
        ]
        report = analyze(samples, self.sync, processes)
        self.assertEqual([r.row for r in report.unlocated], [3])
        self.assertEqual([s.row for s, _ in report.uncalibrated], [4, 5])
        self.assertIn("calibrated range", report.uncalibrated[0][1])
        self.assertIn("no sync points", report.uncalibrated[1][1])

    def test_rejected_session_samples_are_uncalibrated(self):
        processes = [process(0, "d", "P1", 0, 20_000)]
        # count 5 maps later in time than count 10 -> backwards, whole session bad.
        bad_sync = [
            sync(1, "d", "s", 0, 0),
            sync(2, "d", "s", 10, 10_000),
            sync(3, "d", "s", 5, 11_000),
        ]
        report = analyze([sample(2, "d", "s", 5, 1.0)], bad_sync, processes)
        self.assertEqual(report.uncalibrated[0][1], "session rejected")
        self.assertEqual(report.processes[0].valid_samples, 0)
        self.assertEqual(len(report.sessions), 1)
        self.assertEqual(report.sessions[0].status, "rejected")
        self.assertIn("backwards", report.sessions[0].issue)

    def test_two_devices_with_same_session_id_are_isolated(self):
        syncs = self.sync + [sync(3, "e", "s", 0, 500_000), sync(4, "e", "s", 100, 600_000)]
        processes = [
            process(0, "d", "PD", 1_000_000, 1_200_000),
            process(1, "e", "PE", 500_000, 600_000),
        ]
        samples = [sample(2, "d", "s", 50, 1.0), sample(3, "e", "s", 50, 2.0)]
        report = analyze(samples, syncs, processes)
        self.assertEqual(report.processes[0].peak.row, 2)
        self.assertEqual(report.processes[1].peak.row, 3)

    def test_unrounded_time_is_used_for_classification(self):
        # count 0 -> 0 us, count 3 -> 10 us, so count 2 -> 20/3 us ~ 6.667 us.
        syncs = [sync(1, "d", "s", 0, 0), sync(2, "d", "s", 3, 10)]
        processes = [process(0, "d", "P1", 7, 10)]
        report = analyze([sample(2, "d", "s", 2, 1.0)], syncs, processes)
        self.assertEqual(report.processes[0].valid_samples, 0)
        self.assertEqual(len(report.unlocated), 1)
        self.assertEqual(report.unlocated[0].utc_us, Fraction(20, 3))

    def test_below_range_reason(self):
        syncs = [sync(1, "d", "s", 10, 1_000_000), sync(2, "d", "s", 100, 1_100_000)]
        processes = [process(0, "d", "P1", 0, 2_000_000)]
        report = analyze([sample(2, "d", "s", 0, 1.0)], syncs, processes)
        self.assertIn("below calibrated range", report.uncalibrated[0][1])

    def test_single_anchor_reason(self):
        processes = [process(0, "d", "P1", 0, 2_000_000)]
        report = analyze([sample(2, "d", "s", 100, 1.0)], self.sync[1:], processes)
        self.assertIn("only 1 sync point", report.uncalibrated[0][1])

    def test_overlapping_processes_are_rejected(self):
        processes = [
            process(0, "d", "P1", 1_000_000, 1_100_000),
            process(1, "d", "P2", 1_050_000, 1_200_000),
        ]
        with self.assertRaises(InputError):
            analyze([sample(2, "d", "s", 50, 1.0)], self.sync, processes)

    def test_adjacent_processes_do_not_overlap(self):
        processes = [
            process(0, "d", "P1", 1_000_000, 1_100_000),
            process(1, "d", "P2", 1_100_000, 1_200_000),
        ]
        report = analyze([sample(2, "d", "s", 100, 1.0)], self.sync, processes)
        self.assertEqual(report.processes[0].valid_samples, 0)
        self.assertEqual(report.processes[1].valid_samples, 1)


class EndToEndTests(unittest.TestCase):
    def test_cli_reads_three_files(self):
        with tempfile.TemporaryDirectory() as tmp:
            probe = os.path.join(tmp, "probe.csv")
            syncs = os.path.join(tmp, "sync.csv")
            procs = os.path.join(tmp, "process.json")
            with open(probe, "w", encoding="utf-8") as handle:
                handle.write("device_id,session_id,count,amplitude\n")
                handle.write("d,s,50,1.25\n")
                handle.write("d,s,150,3.5\n")
            with open(syncs, "w", encoding="utf-8") as handle:
                handle.write("device_id,session_id,count,utc_us\n")
                handle.write("d,s,0,1000000\n")
                handle.write("d,s,100,1100000\n")
                handle.write("d,s,200,1300000\n")
            with open(procs, "w", encoding="utf-8") as handle:
                json.dump(
                    [
                        {"device_id": "d", "process_id": "P1", "start_utc_us": 1050000, "end_utc_us": 1150000},
                        {"device_id": "d", "process_id": "P2", "start_utc_us": 1150000, "end_utc_us": 1250000},
                    ],
                    handle,
                )
            result = subprocess.run(
                [sys.executable, "-I", SCRIPT, probe, syncs, procs, "--json"],
                capture_output=True,
                text=True,
                check=False,
            )
            self.assertEqual(result.returncode, 0, result.stderr)
            payload = json.loads(result.stdout)
            self.assertEqual(payload["processes"][0]["valid_samples"], 1)
            self.assertEqual(payload["processes"][0]["peak"]["input_row"], 2)
            self.assertEqual(payload["processes"][1]["valid_samples"], 1)
            self.assertEqual(payload["processes"][1]["peak"]["input_row"], 3)
            self.assertEqual(payload["processes"][1]["peak"]["calibrated_utc_us"], 1_200_000)
            self.assertEqual(payload["uncalibrated"], [])


if __name__ == "__main__":
    unittest.main()
