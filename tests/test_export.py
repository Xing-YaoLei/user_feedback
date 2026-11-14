"""End-to-end tests for the participant linkage export.

Written with the standard library's unittest so the suite runs with no
third-party dependencies:

    python3 -m unittest discover -s tests -t .
"""

from __future__ import annotations

import csv
import json
import tempfile
import unittest
from pathlib import Path

from linkage.codes import participant_code
from linkage.crosswalk import load_crosswalk
from linkage.errors import LinkageError
from linkage.export import export
from linkage.manifest import load_manifest
from linkage.spec import (
    FIELD_ID_ALIASES,
    FIELD_PAYLOAD,
    INSTRUMENT_ID_ALIASES,
    INSTRUMENT_PAYLOAD,
    SourceSpec,
)

KEY = b"0123456789abcdef"

CROSSWALK_ROWS = [
    ("instrument", "DEV-1", "M-001"),
    ("instrument", "DEV-2", "M-002"),
    ("field", "OBS-1", "M-001"),
    ("field", "OBS-2", "M-002"),
]

INSTRUMENT_TEXT = (
    "device_registration_number,measurement_item,value\n"
    "DEV-1,height,180\n"
    "DEV-2,weight,75.5\n"
    "DEV-9,height,170\n"
)

FIELD_TEXT = (
    "observation_registration_number\tobservation_category\n"
    "OBS-1\tindoor\n"
    "OBS-2\toutdoor\n"
    "OBS-9\tindoor\n"
)


def write(path: Path, text: str) -> Path:
    path.write_text(text, encoding="utf-8")
    return path


def read_csv(path: Path) -> list:
    with path.open(encoding="utf-8", newline="") as handle:
        return list(csv.reader(handle))


def make_specs(directory: Path, instrument_text=None, field_text=None):
    specs = []
    if instrument_text is not None:
        data = write(directory / "instruments.csv", instrument_text)
        specs.append(
            SourceSpec(
                key="instrument",
                display_name="instrument measurement",
                data_path=data,
                delimiter=",",
                id_aliases=INSTRUMENT_ID_ALIASES,
                payload=INSTRUMENT_PAYLOAD,
                output_path=directory / "instruments.linked.csv",
            )
        )
    if field_text is not None:
        data = write(directory / "observations.tsv", field_text)
        specs.append(
            SourceSpec(
                key="field",
                display_name="field observation",
                data_path=data,
                delimiter="\t",
                id_aliases=FIELD_ID_ALIASES,
                payload=FIELD_PAYLOAD,
                output_path=directory / "observations.linked.csv",
            )
        )
    return specs


def make_manifest(directory: Path, purposes: dict) -> Path:
    return write(
        directory / "manifest.json", json.dumps({"purposes": purposes})
    )


def make_crosswalk(directory: Path, rows: list) -> Path:
    lines = ["source,registration_number,master_id"]
    lines.extend(f"{source},{registration},{master}" for source, registration, master in rows)
    return write(directory / "crosswalk.csv", "\n".join(lines) + "\n")


class ExportTestCase(unittest.TestCase):
    def setUp(self):
        self._tempdir = tempfile.TemporaryDirectory()
        self.addCleanup(self._tempdir.cleanup)
        self.tmp = Path(self._tempdir.name)

    def run_export(
        self, *, purpose, specs, purposes=None, crosswalk_rows=None, key=KEY, directory=None
    ):
        directory = Path(directory) if directory is not None else self.tmp
        manifest_path = make_manifest(
            directory,
            purposes if purposes is not None else {"analysis-a": ["instrument", "field"]},
        )
        crosswalk_path = make_crosswalk(
            directory, crosswalk_rows if crosswalk_rows is not None else CROSSWALK_ROWS
        )
        return export(
            purpose=purpose,
            key=key,
            manifest=load_manifest(manifest_path),
            crosswalk=load_crosswalk(crosswalk_path),
            specs=specs,
            reject_path=directory / "rejects.csv",
        )

    def rejects(self) -> list:
        return read_csv(self.tmp / "rejects.csv")


class CoreBehaviourTests(ExportTestCase):
    def test_both_sources_share_one_code_per_participant(self):
        specs = make_specs(self.tmp, INSTRUMENT_TEXT, FIELD_TEXT)
        result = self.run_export(purpose="analysis-a", specs=specs)

        instrument = read_csv(self.tmp / "instruments.linked.csv")
        field = read_csv(self.tmp / "observations.linked.csv")

        self.assertEqual(instrument[0], ["participant_code", "measurement_item", "value"])
        self.assertEqual(field[0], ["participant_code", "observation_category"])

        # DEV-1 and OBS-1 are both M-001, so they must carry the same code.
        self.assertEqual(instrument[1][0], field[1][0])
        self.assertEqual(instrument[2][0], field[2][0])
        self.assertNotEqual(instrument[1][0], instrument[2][0])

        self.assertEqual(result.emitted, 4)
        self.assertEqual(result.rejected, 2)

    def test_code_matches_documented_derivation(self):
        specs = make_specs(self.tmp, INSTRUMENT_TEXT, FIELD_TEXT)
        self.run_export(purpose="analysis-a", specs=specs)
        instrument = read_csv(self.tmp / "instruments.linked.csv")
        self.assertEqual(
            instrument[1][0], participant_code("M-001", "analysis-a", KEY)
        )

    def test_reject_list_locations_and_reasons(self):
        specs = make_specs(self.tmp, INSTRUMENT_TEXT, FIELD_TEXT)
        self.run_export(purpose="analysis-a", specs=specs)

        rejects = self.rejects()
        self.assertEqual(
            rejects[0],
            ["source_file", "line_number", "source", "registration_number", "reason"],
        )
        self.assertEqual(
            {tuple(row) for row in rejects[1:]},
            {
                ("instruments.csv", "4", "instrument", "DEV-9", "registration_missing"),
                ("observations.tsv", "4", "field", "OBS-9", "registration_missing"),
            },
        )

    def test_same_key_and_purpose_reproduce_the_same_codes(self):
        second = self.tmp / "rerun"
        second.mkdir()
        self.run_export(
            purpose="analysis-a",
            specs=make_specs(self.tmp, INSTRUMENT_TEXT, FIELD_TEXT),
        )
        self.run_export(
            purpose="analysis-a",
            specs=make_specs(second, INSTRUMENT_TEXT, FIELD_TEXT),
            directory=second,
        )
        self.assertEqual(
            read_csv(self.tmp / "instruments.linked.csv"),
            read_csv(second / "instruments.linked.csv"),
        )
        self.assertEqual(
            read_csv(self.tmp / "observations.linked.csv"),
            read_csv(second / "observations.linked.csv"),
        )

    def test_a_different_purpose_gives_the_same_participant_a_different_code(self):
        a_dir = self.tmp / "analysis-a"
        b_dir = self.tmp / "analysis-b"
        a_dir.mkdir()
        b_dir.mkdir()
        codes = {}
        for purpose, directory in (("analysis-a", a_dir), ("analysis-b", b_dir)):
            specs = make_specs(directory, INSTRUMENT_TEXT)
            self.run_export(
                purpose=purpose,
                specs=specs,
                purposes={purpose: ["instrument", "field"]},
                directory=directory,
            )
            codes[purpose] = read_csv(directory / "instruments.linked.csv")[1][0]
        self.assertNotEqual(codes["analysis-a"], codes["analysis-b"])

    def test_a_different_key_gives_a_different_code(self):
        specs = make_specs(self.tmp, INSTRUMENT_TEXT)
        self.run_export(purpose="analysis-a", specs=specs)
        first = read_csv(self.tmp / "instruments.linked.csv")[1][0]

        other = self.tmp / "other"
        other.mkdir()
        self.run_export(
            purpose="analysis-a",
            specs=make_specs(other, INSTRUMENT_TEXT),
            key=b"fedcba9876543210",
        )
        self.assertNotEqual(read_csv(other / "instruments.linked.csv")[1][0], first)

    def test_codes_do_not_leak_identifiers(self):
        specs = make_specs(self.tmp, INSTRUMENT_TEXT)
        self.run_export(purpose="analysis-a", specs=specs)
        text = (self.tmp / "instruments.linked.csv").read_text(encoding="utf-8")
        for identifier in ("M-001", "M-002", "DEV-1"):
            self.assertNotIn(identifier, text)

    def test_results_contain_only_codes_and_business_fields(self):
        specs = make_specs(self.tmp, INSTRUMENT_TEXT, FIELD_TEXT)
        self.run_export(purpose="analysis-a", specs=specs)
        instrument = read_csv(self.tmp / "instruments.linked.csv")
        field = read_csv(self.tmp / "observations.linked.csv")

        for row in instrument[1:]:
            self.assertEqual(len(row), 3)
            self.assertTrue(row[0].startswith("P-"))
        for row in field[1:]:
            self.assertEqual(len(row), 2)
            self.assertTrue(row[0].startswith("P-"))

        headers = instrument[0] + field[0]
        for forbidden in ("master_id", "registration", "device_", "observation_registration"):
            self.assertNotIn(forbidden, headers)


class PurposeGatingTests(ExportTestCase):
    def test_unapproved_source_is_rejected_not_emitted(self):
        specs = make_specs(self.tmp, INSTRUMENT_TEXT, FIELD_TEXT)
        self.run_export(
            purpose="analysis-a",
            specs=specs,
            purposes={"analysis-a": ["instrument"]},
        )

        self.assertEqual(
            read_csv(self.tmp / "observations.linked.csv"),
            [["participant_code", "observation_category"]],
        )

        reasons = {(row[2], row[3]): row[4] for row in self.rejects()[1:]}
        self.assertEqual(reasons[("field", "OBS-1")], "purpose_not_approved")
        self.assertEqual(reasons[("field", "OBS-2")], "purpose_not_approved")
        # No master id exists, so the row is reported as unmapped instead.
        self.assertEqual(reasons[("field", "OBS-9")], "registration_missing")
        self.assertNotIn(
            "purpose_not_approved",
            {row[4] for row in self.rejects()[1:] if row[2] == "instrument"},
        )

    def test_unknown_purpose_stops_the_export(self):
        specs = make_specs(self.tmp, INSTRUMENT_TEXT)
        with self.assertRaises(LinkageError) as raised:
            self.run_export(
                purpose="nope",
                specs=specs,
                purposes={"analysis-a": ["instrument"]},
            )
        self.assertIn("not listed in the manifest", str(raised.exception))
        self.assertFalse((self.tmp / "instruments.linked.csv").exists())

    def test_participant_scoped_approval_is_enforced(self):
        specs = make_specs(self.tmp, INSTRUMENT_TEXT, FIELD_TEXT)
        self.run_export(
            purpose="analysis-a",
            specs=specs,
            purposes={
                "analysis-a": {
                    "sources": ["instrument", "field"],
                    "participants": {"M-002": ["instrument"]},
                }
            },
        )

        # OBS-1 (M-001) is approved; OBS-2 (M-002) is withdrawn.
        self.assertEqual(len(read_csv(self.tmp / "observations.linked.csv")), 2)
        self.assertIn(
            ("observations.tsv", "3", "field", "OBS-2", "purpose_not_approved"),
            {tuple(row) for row in self.rejects()[1:]},
        )

    def test_empty_participant_entry_denies_that_participant(self):
        purposes = {
            "analysis-a": {
                "sources": ["instrument", "field"],
                "participants": {"M-002": []},
            }
        }
        manifest = load_manifest(
            write(self.tmp / "manifest.json", json.dumps({"purposes": purposes}))
        )
        approval = manifest.require_purpose("analysis-a")
        self.assertEqual(approval.approved_for("M-001"), frozenset({"instrument", "field"}))
        self.assertEqual(approval.approved_for("M-002"), frozenset())

        specs = make_specs(self.tmp, INSTRUMENT_TEXT, FIELD_TEXT)
        self.run_export(purpose="analysis-a", specs=specs, purposes=purposes)
        # Only the M-001 rows survive in each file (plus their header).
        self.assertEqual(len(read_csv(self.tmp / "instruments.linked.csv")), 2)
        self.assertEqual(len(read_csv(self.tmp / "observations.linked.csv")), 2)


class CrosswalkTests(ExportTestCase):
    def test_ambiguous_registration_is_rejected(self):
        ambiguous = [
            ("instrument", "DEV-1", "M-001"),
            ("instrument", "DEV-1", "M-002"),
            ("field", "OBS-1", "M-001"),
        ]
        specs = make_specs(
            self.tmp,
            "device_registration_number,measurement_item,value\nDEV-1,height,180\n",
        )
        self.run_export(purpose="analysis-a", specs=specs, crosswalk_rows=ambiguous)

        self.assertEqual(
            read_csv(self.tmp / "instruments.linked.csv"),
            [["participant_code", "measurement_item", "value"]],
        )
        self.assertEqual(
            self.rejects()[1],
            ["instruments.csv", "2", "instrument", "DEV-1", "registration_ambiguous"],
        )

    def test_registration_does_not_resolve_across_sources(self):
        specs = make_specs(
            self.tmp,
            "device_registration_number,measurement_item,value\nDEV-1,height,180\n",
        )
        self.run_export(
            purpose="analysis-a",
            specs=specs,
            crosswalk_rows=[("field", "DEV-1", "M-001")],
        )
        self.assertEqual(
            read_csv(self.tmp / "instruments.linked.csv"),
            [["participant_code", "measurement_item", "value"]],
        )

    def test_blank_registration_is_rejected(self):
        specs = make_specs(
            self.tmp,
            "device_registration_number,measurement_item,value\n,height,180\n",
        )
        self.run_export(purpose="analysis-a", specs=specs)
        self.assertEqual(
            self.rejects()[1],
            ["instruments.csv", "2", "instrument", "", "registration_missing"],
        )

    def test_short_row_is_rejected_with_its_line(self):
        text = (
            "device_registration_number,measurement_item,value\n"
            "DEV-1,height,180\n"
            "DEV-2,weight\n"
            "DEV-2,weight,75\n"
        )
        specs = make_specs(self.tmp, text)
        self.run_export(purpose="analysis-a", specs=specs)

        self.assertEqual(len(read_csv(self.tmp / "instruments.linked.csv")), 3)
        self.assertEqual(
            self.rejects()[1],
            ["instruments.csv", "3", "instrument", "", "malformed_row"],
        )

    def test_quoted_newline_does_not_shift_line_numbers(self):
        text = (
            "device_registration_number,measurement_item,value\n"
            'DEV-1,"note\nspans lines",180\n'
            "DEV-9,height,170\n"
        )
        specs = make_specs(self.tmp, text)
        self.run_export(purpose="analysis-a", specs=specs)
        # The quoted field occupies physical lines 2-3; the next row is line 4.
        self.assertEqual(
            self.rejects()[1],
            ["instruments.csv", "4", "instrument", "DEV-9", "registration_missing"],
        )

    def test_crosswalk_ignores_blank_lines_and_bom(self):
        path = write(
            self.tmp / "crosswalk.csv",
            "﻿source,registration_number,master_id\n"
            "instrument,DEV-1,M-001\n"
            "\n"
            "\n",
        )
        crosswalk = load_crosswalk(path)
        self.assertEqual(crosswalk.resolve("instrument", "DEV-1").master_id, "M-001")


class ManifestTests(ExportTestCase):
    def test_accepts_participants_keyed_by_master_id_first(self):
        path = write(
            self.tmp / "manifest.json",
            json.dumps(
                {
                    "participants": {
                        "M-001": {"analysis-a": ["instrument", "field"]},
                        "M-002": {"analysis-a": ["instrument"]},
                    }
                }
            ),
        )
        manifest = load_manifest(path)
        approval = manifest.require_purpose("analysis-a")
        self.assertEqual(approval.approved_for("M-001"), frozenset({"instrument", "field"}))
        self.assertEqual(approval.approved_for("M-002"), frozenset({"instrument"}))
        # A participant absent from the manifest has no approval.
        self.assertEqual(approval.approved_for("M-999"), frozenset())

    def test_allows_a_participant_specific_narrowing(self):
        path = write(
            self.tmp / "manifest.json",
            json.dumps(
                {
                    "purposes": {
                        "analysis-a": {
                            "sources": ["instrument", "field"],
                            "participants": {"M-002": ["instrument"]},
                        }
                    }
                }
            ),
        )
        approval = load_manifest(path).require_purpose("analysis-a")
        self.assertEqual(approval.approved_for("M-001"), frozenset({"instrument", "field"}))
        self.assertEqual(approval.approved_for("M-002"), frozenset({"instrument"}))

    def test_rejects_unknown_source(self):
        path = make_manifest(self.tmp, {"analysis-a": ["insturment"]})
        with self.assertRaises(LinkageError) as raised:
            load_manifest(path)
        self.assertIn("unknown source", str(raised.exception))

    def test_rejects_duplicate_key(self):
        path = write(
            self.tmp / "manifest.json",
            '{"purposes": {"analysis-a": ["instrument"], "analysis-a": ["field"]}}',
        )
        with self.assertRaises(LinkageError) as raised:
            load_manifest(path)
        self.assertIn("repeats the key", str(raised.exception))

    def test_rejects_a_purpose_that_approves_nothing(self):
        path = write(
            self.tmp / "manifest.json",
            '{"purposes": {"analysis-a": {"sources": []}}}',
        )
        with self.assertRaises(LinkageError) as raised:
            load_manifest(path)
        self.assertIn("approves no sources", str(raised.exception))

    def test_missing_required_column_is_an_error(self):
        specs = make_specs(
            self.tmp,
            "device_registration_number,measurement_item\nDEV-1,height\n",
        )
        with self.assertRaises(LinkageError) as raised:
            self.run_export(purpose="analysis-a", specs=specs)
        self.assertIn("missing required column", str(raised.exception))


class CodeTests(unittest.TestCase):
    def test_key_and_purpose_determine_the_code(self):
        self.assertEqual(
            participant_code("M-001", "analysis-a", KEY),
            participant_code(" M-001 ", " analysis-a ", KEY),
        )
        self.assertNotEqual(
            participant_code("M-001", "analysis-a", KEY),
            participant_code("M-002", "analysis-a", KEY),
        )

    def test_empty_key_is_refused(self):
        with self.assertRaises(LinkageError):
            participant_code("M-001", "analysis-a", b"")

    def test_blank_master_id_is_refused(self):
        with self.assertRaises(LinkageError):
            participant_code("  ", "analysis-a", KEY)


if __name__ == "__main__":
    unittest.main()
