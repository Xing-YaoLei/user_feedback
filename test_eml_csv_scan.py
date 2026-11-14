#!/usr/bin/env python3
"""Tests for eml_csv_scan.py (standard library only)."""

from __future__ import annotations

import base64
import json
import quopri
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import eml_csv_scan as scanner  # noqa: E402

HEADER = "样件号,检测项目,读数\r\n"


def b64(data: bytes) -> bytes:
    encoded = base64.b64encode(data).decode("ascii")
    return ("\r\n".join(encoded[i:i + 76] for i in range(0, len(encoded), 76)) + "\r\n").encode("ascii")


def eml(parts: bytes, boundary: str = "OUTER") -> bytes:
    head = (
        "From: lab@example.com\r\n"
        "To: me@example.com\r\n"
        "Subject: =?UTF-8?B?5qOA5rWL5piO57uG?=\r\n"
        "MIME-Version: 1.0\r\n"
        f'Content-Type: multipart/mixed; boundary="{boundary}"\r\n'
        "\r\n"
        f"--{boundary}\r\n"
        "Content-Type: text/plain; charset=utf-8\r\n"
        "\r\n"
        "Please find this week's results attached.\r\n"
    ).encode("utf-8")
    return head + parts + f"--{boundary}--\r\n".encode("ascii")


def csv_part(
    name: str,
    body,
    *,
    charset: str | None = "utf-8",
    cte: str = "base64",
    boundary: str = "OUTER",
    content_type: str = "text/csv",
    declared_name: str | None = None,
) -> bytes:
    if isinstance(body, str):
        body = body.encode("utf-8")
    if cte == "base64":
        payload = b64(body)
        encoding_header = "Content-Transfer-Encoding: base64\r\n"
    elif cte == "quoted-printable":
        payload = quopri.encodestring(body)
        encoding_header = "Content-Transfer-Encoding: quoted-printable\r\n"
    elif cte in ("8bit", "binary"):
        payload = body
        encoding_header = f"Content-Transfer-Encoding: {cte}\r\n"
    elif cte in ("", None):
        payload = body
        encoding_header = ""
    else:
        raise ValueError(cte)

    charset_param = f'; charset="{charset}"' if charset else ""
    header = (
        f"--{boundary}\r\n"
        f"Content-Type: {content_type}{charset_param}\r\n"
        f"{encoding_header}"
        f'Content-Disposition: attachment; filename="{declared_name or name}"\r\n'
        "\r\n"
    ).encode("ascii")
    return header + payload + b"\r\n"


def nested_part(content_type: str, child: bytes, *, boundary: str, inner: str) -> bytes:
    """Wrap ``child`` (which uses ``inner``) in a container using ``boundary``."""
    return (
        f"--{boundary}\r\n"
        f'Content-Type: {content_type}; boundary="{inner}"\r\n'
        "\r\n"
    ).encode("ascii") + child + f"--{inner}--\r\n".encode("ascii")


class ScanHarness(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.inbox = self.root / "inbox"
        self.inbox.mkdir()
        self.records_path = self.root / "records.jsonl"
        self.errors_path = self.root / "errors.jsonl"

    def write_eml(self, name: str, content: bytes, subdir: str = "") -> Path:
        target = self.inbox / subdir / name
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(content)
        return target

    def run_scan(self, recursive: bool = True):
        summary = scanner.scan_directory(
            self.inbox, self.records_path, self.errors_path, recursive=recursive
        )
        records = [
            json.loads(line)
            for line in self.records_path.read_text(encoding="utf-8").splitlines()
        ]
        errors = [
            json.loads(line)
            for line in self.errors_path.read_text(encoding="utf-8").splitlines()
        ]
        return summary, records, errors


class TestBasicExtraction(ScanHarness):
    def test_valid_rows_and_line_numbers(self):
        body = (
            "样件号,检测项目,读数\r\n"
            "S-001,拉伸强度,12.5\r\n"
            "\r\n"
            "S-002, 硬度 , -3e2\r\n"
            "S-003,冲击功,ND\r\n"
            "S-004,,1.0\r\n"
        )
        self.write_eml("week33.eml", eml(csv_part("week33.csv", body)))

        summary, records, errors = self.run_scan()

        self.assertEqual(summary.records, 2)
        self.assertEqual(summary.csv_attachments, 1)
        self.assertEqual(summary.emails_processed, 1)

        self.assertEqual([r["sample_id"] for r in records], ["S-001", "S-002"])
        self.assertEqual(records[0]["test_item"], "拉伸强度")
        self.assertEqual(records[0]["reading"], 12.5)
        self.assertEqual(records[1]["reading"], -300.0)
        self.assertEqual(
            [r["csv_line"] for r in records],
            [2, 4],
            "blank lines must still advance the physical line counter",
        )
        for record in records:
            self.assertEqual(record["source_email"], "week33.eml")
            self.assertEqual(record["attachment_name"], "week33.csv")

        by_line = {e["csv_line"]: e for e in errors}
        self.assertEqual(by_line[5]["error_type"], "invalid_reading")
        self.assertEqual(by_line[5]["raw_reading"], "ND")
        self.assertEqual(by_line[6]["error_type"], "missing_required_value")
        self.assertIn("检测项目", by_line[6]["missing_fields"])

    def test_bom_and_utf8_default_without_charset(self):
        body = "﻿样件号,检测项目,读数\nS-1,坍落度,80\n"
        self.write_eml("bom.eml", eml(csv_part("bom.csv", body, charset=None)))
        _, records, errors = self.run_scan()
        self.assertEqual(errors, [])
        self.assertEqual(len(records), 1)
        self.assertEqual(records[0]["sample_id"], "S-1")
        self.assertEqual(records[0]["reading"], 80.0)

    def test_header_aliases_and_unit_annotations(self):
        body = "sample_id,Test Item,readings\nA,compression,1\n"
        self.write_eml("en.eml", eml(csv_part("en.csv", body)))
        _, records, _ = self.run_scan()
        self.assertEqual(len(records), 1)
        self.assertEqual(records[0]["test_item"], "compression")

        body2 = "样件号,检测项目,读数(MPa)\nB,硬度,2\n"
        self.write_eml("unit.eml", eml(csv_part("unit.csv", body2)))
        _, records2, errors2 = self.run_scan()
        self.assertEqual(errors2, [])
        self.assertIn("B", [r["sample_id"] for r in records2])

    def test_quoted_fields_with_commas_and_newlines(self):
        # A field containing a newline spans two physical lines; line numbers
        # must reflect the physical position of each record's start.
        body = (
            "样件号,检测项目,读数\r\n"
            '"Q-1","拉伸, 横向",1.5\r\n'
            '"Q-2","line one\nline two",2.5\r\n'
            '"Q-3",ok,3.5\r\n'
        )
        self.write_eml("quoted.eml", eml(csv_part("quoted.csv", body)))
        _, records, errors = self.run_scan()
        self.assertEqual(errors, [])
        self.assertEqual(records[0]["test_item"], "拉伸, 横向")
        self.assertEqual(records[1]["test_item"], "line one\nline two")
        self.assertEqual([r["csv_line"] for r in records], [2, 3, 5])

    def test_sep_directive_before_header(self):
        body = "sep=,\r\n样件号,检测项目,读数\r\nS-9,硬度,1\r\n"
        self.write_eml("sep.eml", eml(csv_part("sep.csv", body)))
        _, records, errors = self.run_scan()
        self.assertEqual(errors, [])
        self.assertEqual(records[0]["sample_id"], "S-9")
        self.assertEqual(records[0]["csv_line"], 3)

    def test_reading_forms(self):
        body = (
            "样件号,检测项目,读数\n"
            "A,x,+1\n"
            "B,x,.5\n"
            "C,x,1E-3\n"
            "D,x,NaN\n"
            "E,x,Infinity\n"
            "F,x,12%\n"
            "G,x,\n"
        )
        self.write_eml("forms.eml", eml(csv_part("forms.csv", body)))
        _, records, errors = self.run_scan()
        self.assertEqual([r["sample_id"] for r in records], ["A", "B", "C"])
        self.assertEqual(records[1]["reading"], 0.5)
        self.assertEqual(len(errors), 4)
        self.assertTrue(all(e["error_type"] == "invalid_reading" for e in errors))


class TestTransferEncodings(ScanHarness):
    def test_base64_gbk_charset(self):
        body = HEADER + "样件A,硬度,55.2\r\n"
        self.write_eml(
            "gbk.eml", eml(csv_part("gbk.csv", body.encode("gbk"), charset="gbk"))
        )
        _, records, errors = self.run_scan()
        self.assertEqual(errors, [])
        self.assertEqual(records[0]["sample_id"], "样件A")
        self.assertEqual(records[0]["test_item"], "硬度")

    def test_quoted_printable_gb2312_charset(self):
        body = HEADER + "样件B,拉伸,120\r\n"
        self.write_eml(
            "qp.eml",
            eml(
                csv_part(
                    "qp.csv",
                    body.encode("gb2312"),
                    charset="gb2312",
                    cte="quoted-printable",
                )
            ),
        )
        _, records, errors = self.run_scan()
        self.assertEqual(errors, [])
        self.assertEqual(records[0]["sample_id"], "样件B")
        self.assertEqual(records[0]["reading"], 120.0)

    def test_raw_8bit_utf8(self):
        body = HEADER + "8B-1,硬度,9\r\n"
        self.write_eml(
            "raw.eml", eml(csv_part("raw.csv", body, charset="utf-8", cte="8bit"))
        )
        _, records, errors = self.run_scan()
        self.assertEqual(errors, [])
        self.assertEqual(records[0]["sample_id"], "8B-1")

    def test_bad_base64_does_not_block_sibling_attachment(self):
        # Raw payload that is not a valid base64 alphabet.
        bad = (
            b"--OUTER\r\n"
            b'Content-Type: text/csv; charset="utf-8"\r\n'
            b"Content-Transfer-Encoding: base64\r\n"
            b'Content-Disposition: attachment; filename="bad.csv"\r\n'
            b"\r\n"
            b"%%%notbase64%%%\r\n"
            b"\r\n"
        )
        good = csv_part("good.csv", HEADER + "OK-1,硬度,7\r\n")
        self.write_eml("mixed.eml", eml(bad + good))

        _, records, errors = self.run_scan()

        self.assertEqual(len(records), 1)
        self.assertEqual(records[0]["attachment_name"], "good.csv")
        self.assertEqual(len(errors), 1)
        self.assertEqual(errors[0]["error_type"], "attachment_decode_failure")
        self.assertEqual(errors[0]["attachment_name"], "bad.csv")
        self.assertEqual(errors[0]["stage"], "transfer_encoding")

    def test_unsupported_transfer_encoding_is_decode_failure(self):
        bad = (
            b"--OUTER\r\n"
            b'Content-Type: text/csv; charset="utf-8"\r\n'
            b"Content-Transfer-Encoding: uuencode\r\n"
            b'Content-Disposition: attachment; filename="uu.csv"\r\n'
            b"\r\n"
            b"begin 644 data\r\n"
            b"\r\n"
        )
        self.write_eml("uu.eml", eml(bad))
        _, records, errors = self.run_scan()
        self.assertEqual(records, [])
        self.assertEqual(errors[0]["error_type"], "attachment_decode_failure")
        self.assertEqual(errors[0]["stage"], "transfer_encoding")

    def test_unknown_charset_is_decode_failure_not_missing_columns(self):
        body = HEADER + "X-1,硬度,1\r\n"
        part = csv_part("decl.csv", body.encode("utf-8"), charset="x-unknown-charset")
        self.write_eml("badcharset.eml", eml(part))

        _, records, errors = self.run_scan()

        self.assertEqual(records, [])
        self.assertEqual(len(errors), 1)
        self.assertEqual(errors[0]["error_type"], "attachment_decode_failure")
        self.assertEqual(errors[0]["stage"], "charset")

    def test_bytes_invalid_for_declared_charset_are_decode_failure(self):
        # Declared UTF-8, but the bytes are GBK (and invalid UTF-8).
        body = HEADER + "样件G,硬度,1\r\n"
        part = csv_part("mismatch.csv", body.encode("gbk"), charset="utf-8")
        self.write_eml("mismatch.eml", eml(part))

        _, records, errors = self.run_scan()

        self.assertEqual(records, [])
        self.assertEqual(len(errors), 1)
        self.assertEqual(errors[0]["error_type"], "attachment_decode_failure")
        self.assertEqual(errors[0]["stage"], "charset")

    def test_uppercase_csv_extension_and_missing_filename(self):
        upper = csv_part("UPPER.CSV", HEADER + "U-1,硬度,1\r\n")
        unnamed = (
            b"--OUTER\r\n"
            b'Content-Type: text/csv; charset="utf-8"\r\n'
            b"Content-Transfer-Encoding: base64\r\n"
            b"\r\n" + b64((HEADER + "N-1,硬度,2\r\n").encode("utf-8")) + b"\r\n"
        )
        self.write_eml("names.eml", eml(upper + unnamed))
        _, records, errors = self.run_scan()
        self.assertEqual(errors, [])
        self.assertEqual(
            [(r["attachment_name"], r["sample_id"]) for r in records],
            [("UPPER.CSV", "U-1"), (None, "N-1")],
        )

    def test_multipart_container_named_eml_still_traversed(self):
        inner_csv = csv_part("inside.csv", HEADER + "M-1,硬度,1\r\n", boundary="INNER")
        container = nested_part(
            "multipart/mixed", inner_csv, boundary="OUTER", inner="INNER"
        )
        # Give the container a misleading filename in the multipart headers.
        container = container.replace(
            b'Content-Type: multipart/mixed; boundary="INNER"\r\n',
            b'Content-Type: multipart/mixed; boundary="INNER"\r\n'
            b'Content-Disposition: attachment; filename="archive.eml"\r\n',
            1,
        )
        self.write_eml("container.eml", eml(container))
        _, records, errors = self.run_scan()
        self.assertEqual(errors, [])
        self.assertEqual(records[0]["attachment_name"], "inside.csv")
        self.assertEqual(records[0]["sample_id"], "M-1")

    def test_invalid_quoted_printable_escape(self):
        part = (
            b"--OUTER\r\n"
            b'Content-Type: text/csv; charset="utf-8"\r\n'
            b"Content-Transfer-Encoding: quoted-printable\r\n"
            b'Content-Disposition: attachment; filename="brokenqp.csv"\r\n'
            b"\r\n"
            b"a,b,c\r\n=x1\r\n"
            b"\r\n"
        )
        self.write_eml("badqp.eml", eml(part))
        _, records, errors = self.run_scan()
        self.assertEqual(records, [])
        self.assertEqual(errors[0]["error_type"], "attachment_decode_failure")

    def test_rfc2047_filename_is_decoded(self):
        encoded = base64.b64encode("本周结果.csv".encode("utf-8")).decode("ascii")
        part = csv_part(
            "results.csv",
            HEADER + "N-1,硬度,1\r\n",
            declared_name=f"=?UTF-8?B?{encoded}?=",
        )
        self.write_eml("name.eml", eml(part))
        _, records, _ = self.run_scan()
        self.assertEqual(records[0]["attachment_name"], "本周结果.csv")


class TestNesting(ScanHarness):
    def test_deep_multipart_attachment_found(self):
        inner_csv = csv_part("deep.csv", HEADER + "D-1,硬度,3\r\n", boundary="INNER")
        mid = nested_part(
            "multipart/alternative", inner_csv, boundary="MID", inner="INNER"
        )
        deep = nested_part("multipart/related", mid, boundary="OUTER", inner="MID")
        self.write_eml("deep.eml", eml(deep))
        _, records, errors = self.run_scan()
        self.assertEqual(errors, [])
        self.assertEqual(records[0]["attachment_name"], "deep.csv")
        self.assertEqual(records[0]["sample_id"], "D-1")

    def test_plain_text_body_that_looks_like_csv_is_ignored(self):
        fake_body = (
            "--OUTER\r\n"
            "Content-Type: text/plain; charset=utf-8\r\n"
            "\r\n"
            "样件号,检测项目,读数\r\nFAKE-1,硬度,1\r\n"
            "\r\n"
        ).encode("utf-8")
        self.write_eml("fake.eml", eml(fake_body))
        _, records, _ = self.run_scan()
        self.assertEqual(records, [])

    def test_forwarded_email_and_its_contents_skipped(self):
        inner = (
            "From: old@example.com\r\n"
            "Subject: last week\r\n"
            "MIME-Version: 1.0\r\n"
            'Content-Type: multipart/mixed; boundary="LAST"\r\n'
            "\r\n"
            "--LAST\r\n"
            'Content-Type: text/csv; charset="utf-8"\r\n'
            "Content-Transfer-Encoding: base64\r\n"
            'Content-Disposition: attachment; filename="last_week.csv"\r\n'
            "\r\n"
        ).encode("ascii") + b64((HEADER + "OLD-1,硬度,1\r\n").encode("utf-8")) + b"\r\n--LAST--\r\n"

        forwarded = (
            "--OUTER\r\n"
            "Content-Type: message/rfc822\r\n"
            'Content-Disposition: attachment; filename="last_week.eml"\r\n'
            "\r\n"
        ).encode("ascii") + inner

        current = csv_part("this_week.csv", HEADER + "NEW-1,硬度,2\r\n")
        self.write_eml("fw.eml", eml(forwarded + current))

        _, records, errors = self.run_scan()

        self.assertEqual(errors, [])
        self.assertEqual(len(records), 1)
        self.assertEqual(records[0]["attachment_name"], "this_week.csv")
        self.assertEqual(records[0]["sample_id"], "NEW-1")

    def test_eml_filename_with_octet_stream_is_skipped(self):
        forwarded = (
            "--OUTER\r\n"
            "Content-Type: application/octet-stream\r\n"
            "Content-Transfer-Encoding: base64\r\n"
            'Content-Disposition: attachment; filename="Thread.eml"\r\n'
            "\r\n"
        ).encode("ascii") + b64((HEADER + "OLD-2,硬度,1\r\n").encode("utf-8"))
        self.write_eml("octet.eml", eml(forwarded))
        _, records, errors = self.run_scan()
        self.assertEqual(records, [])
        self.assertEqual(errors, [])

    def test_part_indices_are_preorder_and_stable(self):
        first = csv_part("one.csv", HEADER + "1,硬度,1\r\n")
        forwarded = (
            "--OUTER\r\n"
            "Content-Type: message/rfc822\r\n"
            "\r\n"
            "From: x@y\r\nContent-Type: text/plain\r\n\r\nhi\r\n"
        ).encode("ascii")
        second = csv_part("two.csv", HEADER + "2,硬度,2\r\n")
        # part 1: root multipart/mixed
        # part 2: text/plain body
        # part 3: one.csv
        # part 4: message/rfc822 (skipped; its inner parts are never numbered)
        # part 5: two.csv
        self.write_eml("idx.eml", eml(first + forwarded + second))
        _, records, _ = self.run_scan()
        self.assertEqual(
            [(r["attachment_name"], r["part_index"]) for r in records],
            [("one.csv", 3), ("two.csv", 5)],
        )


class TestSameFilenameAndIndependence(ScanHarness):
    def test_two_attachments_same_filename_are_both_processed(self):
        first = csv_part("results.csv", HEADER + "A-1,硬度,1\r\n")
        second = csv_part("results.csv", HEADER + "B-2,拉伸,2\r\n")
        self.write_eml("dupe.eml", eml(first + second))

        summary, records, errors = self.run_scan()

        self.assertEqual(summary.csv_attachments, 2)
        self.assertEqual(errors, [])
        self.assertEqual(
            [(r["attachment_name"], r["sample_id"]) for r in records],
            [("results.csv", "A-1"), ("results.csv", "B-2")],
        )
        self.assertNotEqual(records[0]["part_index"], records[1]["part_index"])

    def test_missing_columns_are_distinct_from_decode_failure(self):
        missing = csv_part("no_reading.csv", "样件号,检测项目\r\nX-1,硬度\r\n")
        good = csv_part("ok.csv", HEADER + "OK-2,硬度,4\r\n")
        self.write_eml("mixed2.eml", eml(missing + good))

        _, records, errors = self.run_scan()

        self.assertEqual([r["sample_id"] for r in records], ["OK-2"])
        self.assertEqual(len(errors), 1)
        self.assertEqual(errors[0]["error_type"], "missing_required_columns")
        self.assertEqual(errors[0]["missing_columns"], ["读数"])

    def test_empty_attachment_reports_missing_columns(self):
        self.write_eml("empty.eml", eml(csv_part("empty.csv", b"")))
        _, records, errors = self.run_scan()
        self.assertEqual(records, [])
        self.assertEqual(errors[0]["error_type"], "missing_required_columns")

    def test_bad_row_keeps_valid_rows(self):
        body = (
            "样件号,检测项目,读数\r\n"
            "A,硬度,1\r\n"
            "B,硬度,not-a-number\r\n"
            "C,硬度,2\r\n"
        )
        self.write_eml("rows.eml", eml(csv_part("rows.csv", body)))
        _, records, errors = self.run_scan()
        self.assertEqual([r["sample_id"] for r in records], ["A", "C"])
        self.assertEqual([e["csv_line"] for e in errors], [3])

    def test_short_row_is_malformed_not_invalid_reading(self):
        body = "样件号,检测项目,读数\r\nA,硬度,1\r\nB,硬度\r\n"
        self.write_eml("shape.eml", eml(csv_part("shape.csv", body)))
        _, records, errors = self.run_scan()
        self.assertEqual(len(records), 1)
        self.assertEqual(errors[0]["error_type"], "malformed_row")
        self.assertEqual(errors[0]["csv_line"], 3)

    def test_header_with_unit_annotation_keeps_reading_recognized(self):
        body = "样件号,检测项目,读数(MPa)\nU-1,硬度,1.5\n"
        self.write_eml("annot.eml", eml(csv_part("annot.csv", body)))
        _, records, errors = self.run_scan()
        self.assertEqual(errors, [])
        self.assertEqual(records[0]["reading"], 1.5)

    def test_missing_test_item_column_is_reported_with_header_line(self):
        body = "样件号,读数\nA,1\n"
        self.write_eml("nocol.eml", eml(csv_part("nocol.csv", body)))
        _, records, errors = self.run_scan()
        self.assertEqual(records, [])
        self.assertEqual(errors[0]["error_type"], "missing_required_columns")
        self.assertEqual(errors[0]["missing_columns"], ["检测项目"])
        self.assertEqual(errors[0]["header_line"], 1)
        self.assertEqual(errors[0]["headers"], ["样件号", "读数"])


class TestDirectoryAndOutput(ScanHarness):
    def test_nested_directory_and_relative_source_names(self):
        self.write_eml(
            "a.eml", eml(csv_part("a.csv", HEADER + "A,硬度,1\r\n")), subdir="lab1"
        )
        self.write_eml(
            "b.eml",
            eml(csv_part("b.csv", HEADER + "B,硬度,2\r\n")),
            subdir="lab2/deep",
        )

        summary, records, _ = self.run_scan(recursive=True)

        self.assertEqual(summary.emails_found, 2)
        self.assertEqual(
            sorted(r["source_email"] for r in records),
            ["lab1/a.eml", "lab2/deep/b.eml"],
        )

    def test_non_recursive(self):
        self.write_eml("top.eml", eml(csv_part("t.csv", HEADER + "T,硬度,1\r\n")))
        self.write_eml(
            "sub.eml", eml(csv_part("s.csv", HEADER + "S,硬度,1\r\n")), subdir="sub"
        )
        summary, records, _ = self.run_scan(recursive=False)
        self.assertEqual(summary.emails_found, 1)
        self.assertEqual([r["source_email"] for r in records], ["top.eml"])

    def test_non_eml_files_ignored(self):
        (self.inbox / "notes.txt").write_text("hello", encoding="utf-8")
        self.write_eml("real.eml", eml(csv_part("r.csv", HEADER + "R,硬度,1\r\n")))
        summary, records, _ = self.run_scan()
        self.assertEqual(summary.emails_found, 1)
        self.assertEqual(len(records), 1)

    def test_output_jsonl_is_strict_json(self):
        body = HEADER + "A,硬度,0.1\r\nB,硬度,1e-3\r\n"
        self.write_eml("json.eml", eml(csv_part("json.csv", body)))
        self.run_scan()
        for line in self.records_path.read_text(encoding="utf-8").splitlines():
            parsed = json.loads(line)
            self.assertIsInstance(parsed["reading"], float)
            for key in (
                "sample_id",
                "test_item",
                "reading",
                "source_email",
                "attachment_name",
                "part_index",
                "csv_line",
            ):
                self.assertIn(key, parsed)

    def test_empty_directory_produces_empty_outputs(self):
        summary, records, errors = self.run_scan()
        self.assertEqual(summary.emails_found, 0)
        self.assertEqual(records, [])
        self.assertEqual(errors, [])
        self.assertTrue(self.records_path.exists())
        self.assertTrue(self.errors_path.exists())


class TestCli(unittest.TestCase):
    def test_cli_runs_and_reports_summary(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            inbox = root / "in"
            inbox.mkdir()
            (inbox / "m.eml").write_bytes(
                eml(csv_part("m.csv", HEADER + "A,硬度,1\r\n"))
            )
            records = root / "out" / "records.jsonl"
            errors = root / "out" / "errors.jsonl"
            proc = subprocess.run(
                [
                    sys.executable,
                    str(Path(__file__).resolve().parent / "eml_csv_scan.py"),
                    str(inbox),
                    "-o",
                    str(records),
                    "-e",
                    str(errors),
                ],
                capture_output=True,
                text=True,
                check=False,
            )
            self.assertEqual(proc.returncode, 0, proc.stderr)
            summary = json.loads(proc.stdout)
            self.assertEqual(summary["records"], 1)
            self.assertEqual(summary["csv_attachments"], 1)
            self.assertTrue(records.exists())
            self.assertEqual(len(records.read_text(encoding="utf-8").splitlines()), 1)

    def test_cli_missing_input(self):
        proc = subprocess.run(
            [
                sys.executable,
                str(Path(__file__).resolve().parent / "eml_csv_scan.py"),
                "/definitely/not/here",
            ],
            capture_output=True,
            text=True,
            check=False,
        )
        self.assertEqual(proc.returncode, 2)
        self.assertIn("does not exist", proc.stderr)


if __name__ == "__main__":
    unittest.main(verbosity=2)
