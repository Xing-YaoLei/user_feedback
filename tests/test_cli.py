"""Tests for the command-line entry point and key handling."""

from __future__ import annotations

import csv
import json
import os
import tempfile
import unittest
from pathlib import Path

from linkage import cli

KEY_HEX = "30313233343536373839616263646566"  # b"0123456789abcdef"


class CommandLineTests(unittest.TestCase):
    def setUp(self):
        self._tempdir = tempfile.TemporaryDirectory()
        self.addCleanup(self._tempdir.cleanup)
        self.dir = Path(self._tempdir.name)

        (self.dir / "instruments.csv").write_text(
            "device_registration_number,measurement_item,value\n"
            "DEV-1,height,180\n",
            encoding="utf-8",
        )
        (self.dir / "manifest.json").write_text(
            json.dumps({"purposes": {"analysis-a": ["instrument"]}}), encoding="utf-8"
        )
        (self.dir / "crosswalk.csv").write_text(
            "source,registration_number,master_id\ninstrument,DEV-1,M-001\n",
            encoding="utf-8",
        )

    def run_cli(self, *extra: str) -> int:
        return cli.main(
            [
                "--purpose",
                "analysis-a",
                "--manifest",
                str(self.dir / "manifest.json"),
                "--crosswalk",
                str(self.dir / "crosswalk.csv"),
                "--instrument-data",
                str(self.dir / "instruments.csv"),
                "--instrument-output",
                str(self.dir / "out.csv"),
                "--rejects",
                str(self.dir / "rejects.csv"),
                *extra,
            ]
        )

    def out_rows(self) -> list:
        with (self.dir / "out.csv").open(encoding="utf-8", newline="") as handle:
            return list(csv.reader(handle))

    def test_key_hex_runs_and_writes_results(self):
        self.assertEqual(self.run_cli("--key-hex", KEY_HEX), 0)
        rows = self.out_rows()
        self.assertEqual(rows[0], ["participant_code", "measurement_item", "value"])
        self.assertEqual(len(rows), 2)

    def test_key_from_environment(self):
        original = os.environ.get("LINKAGE_KEY")
        os.environ["LINKAGE_KEY"] = "0123456789abcdef"
        try:
            self.assertEqual(self.run_cli("--key-env", "LINKAGE_KEY"), 0)
        finally:
            if original is None:
                del os.environ["LINKAGE_KEY"]
            else:
                os.environ["LINKAGE_KEY"] = original
        self.assertTrue((self.dir / "out.csv").exists())

    def test_missing_environment_variable_is_an_error(self):
        original = os.environ.pop("LINKAGE_KEY", None)
        try:
            self.assertEqual(self.run_cli("--key-env", "LINKAGE_KEY"), 2)
        finally:
            if original is not None:
                os.environ["LINKAGE_KEY"] = original
        self.assertFalse((self.dir / "out.csv").exists())

    def test_key_file_strips_one_trailing_newline(self):
        (self.dir / "key.txt").write_bytes(b"0123456789abcdef\n")
        self.assertEqual(self.run_cli("--key-file", str(self.dir / "key.txt")), 0)
        with_newline = self.out_rows()

        (self.dir / "key2.txt").write_bytes(b"0123456789abcdef")
        self.assertEqual(self.run_cli("--key-file", str(self.dir / "key2.txt")), 0)
        self.assertEqual(self.out_rows(), with_newline)

    def test_hex_encoded_key_file(self):
        (self.dir / "key.hex").write_text(KEY_HEX, encoding="utf-8")
        self.assertEqual(
            self.run_cli("--key-file", str(self.dir / "key.hex"), "--key-encoding", "hex"),
            0,
        )
        from_file = self.out_rows()

        self.assertEqual(self.run_cli("--key-hex", KEY_HEX), 0)
        self.assertEqual(self.out_rows(), from_file)

    def test_empty_key_is_refused(self):
        (self.dir / "empty.key").write_bytes(b"")
        self.assertEqual(self.run_cli("--key-file", str(self.dir / "empty.key")), 2)
        self.assertFalse((self.dir / "out.csv").exists())

    def test_short_key_warns_but_runs(self):
        self.assertEqual(self.run_cli("--key-hex", "00"), 0)
        self.assertTrue((self.dir / "out.csv").exists())

    def test_output_overwriting_input_is_refused(self):
        code = cli.main(
            [
                "--purpose",
                "analysis-a",
                "--manifest",
                str(self.dir / "manifest.json"),
                "--crosswalk",
                str(self.dir / "crosswalk.csv"),
                "--instrument-data",
                str(self.dir / "instruments.csv"),
                "--instrument-output",
                str(self.dir / "instruments.csv"),
                "--rejects",
                str(self.dir / "rejects.csv"),
                "--key-hex",
                KEY_HEX,
            ]
        )
        self.assertEqual(code, 2)
        self.assertIn("DEV-1", (self.dir / "instruments.csv").read_text(encoding="utf-8"))


if __name__ == "__main__":
    unittest.main()
