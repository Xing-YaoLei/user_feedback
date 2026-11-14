#!/usr/bin/env python3
"""Extract laboratory CSV attachments from EML files into JSONL records.

The scanner intentionally follows the *outer* message only:

* attachments may live in arbitrarily nested multipart bodies;
* a whole e-mail forwarded as an attachment (message/rfc822, or a part whose
  filename ends in .eml/.email) is skipped together with everything below it;
* every CSV attachment is handled independently, even when two attachments in
  one e-mail share the same filename.

Only the standard library is used.
"""

from __future__ import annotations

import argparse
import base64
import binascii
import codecs
import csv
import io
import json
import quopri
import re
import sys
from collections import Counter
from dataclasses import dataclass, field
from decimal import Decimal, InvalidOperation
from email import policy
from email.header import decode_header, make_header
from email.message import Message
from email.parser import BytesParser
from pathlib import Path
from typing import Iterable, Optional


# ---------------------------------------------------------------------------
# CSV schema
# ---------------------------------------------------------------------------

REQUIRED_FIELDS = ("sample_id", "test_item", "reading")

# Byte-order mark (U+FEFF), which some CSV exporters prepend to the header.
BOM = chr(0xFEFF)

FIELD_LABELS = {
    "sample_id": "样件号",
    "test_item": "检测项目",
    "reading": "读数",
}

# Header aliases are compared after removing case, whitespace, "_" and "-".
_RAW_ALIASES = {
    "sample_id": (
        "样件号", "样品号", "样件编号", "样品编号", "试样号", "试样编号",
        "sample_id", "sample id", "sampleid", "sample_no", "sample no",
        "sample number", "sample", "specimen_id", "specimen id", "specimen",
    ),
    "test_item": (
        "检测项目", "检测项", "测试项目", "测试项", "试验项目", "检测参数",
        "测试参数", "项目",
        "test_item", "test item", "testitem", "test", "item", "test_name",
        "test name", "parameter", "parameter name",
    ),
    "reading": (
        "读数", "读值", "读数数值", "测量值", "测定值", "检测值", "数值",
        "结果", "reading", "readings", "value", "result", "measurement",
        "measure",
    ),
}


def normalize_header(value: str) -> str:
    """Normalize a header cell for alias matching.

    Unit annotations such as ``读数(MPa)`` or ``检测项目【必填】`` are dropped,
    along with case, whitespace, underscores and hyphens.
    """
    value = value.strip().lstrip(BOM).strip().casefold()
    value = re.sub(r"[\(（\[【].*?[\)）\]】]", "", value)
    return re.sub(r"[\s_\-]+", "", value)


_ALIASES = {
    field_name: {normalize_header(alias) for alias in aliases}
    for field_name, aliases in _RAW_ALIASES.items()
}

CSV_CONTENT_TYPES = {
    "text/csv",
    "text/x-csv",
    "application/csv",
    "application/x-csv",
    "text/comma-separated-values",
    "application/comma-separated-values",
}

# A strict, finite decimal number.  Values such as "12,5", "12 %", "ND",
# "N/A", "NaN" and "Infinity" are rejected.  re.ASCII keeps non-ASCII digit
# forms out so what is accepted always renders as a plain JSON number.
READING_RE = re.compile(
    r"[+-]?(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)(?:[eE][+-]?[0-9]+)?\Z",
    re.ASCII,
)

# "=" must start a hex escape, a soft line break (optionally with trailing
# whitespace before the break), or end the payload.
INVALID_QP_RE = re.compile(
    rb"=(?![0-9A-Fa-f]{2}|[ \t]*(?:\r\n|\r|\n|\Z))"
)

# Maps lone surrogate code points (possible in paths/headers that are not
# valid UTF-8) to U+FFFD, so every emitted line is valid UTF-8.
_SURROGATE_FIX = {code: 0xFFFD for code in range(0xD800, 0xE000)}


# ---------------------------------------------------------------------------
# Result types
# ---------------------------------------------------------------------------

@dataclass
class ScanSummary:
    emails_found: int = 0
    emails_processed: int = 0
    emails_failed: int = 0
    csv_attachments: int = 0
    records: int = 0
    error_counts: Counter = field(default_factory=Counter)

    def to_dict(self) -> dict:
        return {
            "emails_found": self.emails_found,
            "emails_processed": self.emails_processed,
            "emails_failed": self.emails_failed,
            "csv_attachments": self.csv_attachments,
            "records": self.records,
            "error_counts": dict(sorted(self.error_counts.items())),
        }


def _error(
    error_type: str,
    source_email: str,
    detail: str,
    attachment_name: Optional[str] = None,
    part_index: Optional[int] = None,
    **extra,
) -> dict:
    error = {
        "error_type": error_type,
        "source_email": source_email,
        "attachment_name": attachment_name,
        "part_index": part_index,
        "detail": detail,
    }
    error.update(extra)
    return error


# ---------------------------------------------------------------------------
# MIME helpers
# ---------------------------------------------------------------------------

def _header_text(part: Message, name: str) -> str:
    try:
        value = part.get(name)
    except Exception:
        return ""
    return "" if value is None else str(value)


def _content_transfer_encoding(part: Message) -> str:
    """Return the bare transfer-encoding token (comments/params stripped)."""
    raw = _header_text(part, "Content-Transfer-Encoding")
    # Strip RFC 2045 comments and parameters, then take the first token.
    raw = re.sub(r"\([^)]*\)", " ", raw)
    raw = raw.split(";", 1)[0]
    return raw.strip().split()[0].lower() if raw.strip() else ""


def get_attachment_name(part: Message) -> Optional[str]:
    """Return the declared filename, decoding RFC 2047 words if needed."""
    name = None
    try:
        name = part.get_filename()
    except Exception:
        name = None

    if name is None:
        # Older parsers expose the Content-Type "name" parameter directly.
        try:
            name = part.get_param("name", header="content-type")
        except Exception:
            name = None

    if isinstance(name, tuple):
        # RFC 2231 style: (charset, language, value)
        name = name[2] if len(name) >= 3 else (name[0] if name else None)

    if name is None:
        return None

    if isinstance(name, bytes):
        name = name.decode("utf-8", "replace")
    else:
        name = str(name)

    if "=?" in name:
        try:
            name = str(make_header(decode_header(name)))
        except Exception:
            pass

    name = name.strip()
    return name or None


def _is_forwarded_email(part: Message) -> bool:
    """True for a complete e-mail attached/forwarded inside another e-mail."""
    if part.get_content_maintype().lower() == "message":
        return True
    if part.is_multipart():
        # Only leaf parts can be a whole e-mail; a multipart container with a
        # telling filename must not hide its legitimate nested attachments.
        return False
    name = get_attachment_name(part)
    if name:
        lowered = name.lower()
        if lowered.endswith(".eml") or lowered.endswith(".email"):
            # A genuine CSV part is never skipped just because of its filename.
            return part.get_content_type().lower() not in CSV_CONTENT_TYPES
    return False


def _is_csv_part(part: Message) -> bool:
    if part.is_multipart():
        return False
    if part.get_content_maintype().lower() == "message":
        return False

    name = get_attachment_name(part)
    if name and name.lower().endswith(".csv"):
        return True

    return part.get_content_type().lower() in CSV_CONTENT_TYPES


def _payload_bytes(part: Message) -> bytes:
    """Recover the raw (still transfer-encoded) payload bytes.

    The parser stores the literal transferred text in ``_payload`` with bytes
    >= 0x80 represented as surrogate escapes, so this is the exact source
    bytes (``get_payload(decode=False)`` may additionally re-decode them with
    the declared charset and replace invalid sequences, which would hide
    decode failures).  Both possible mappings are reversed here so the part's
    declared charset and transfer-encoding decide how the bytes are read.
    """
    try:
        payload = getattr(part, "_payload", None)
        if not isinstance(payload, (str, bytes)):
            payload = part.get_payload(decode=False)
    except Exception:
        payload = None
    if payload is None:
        return b""
    if isinstance(payload, bytes):
        return payload
    if not isinstance(payload, str):
        return b""

    try:
        return payload.encode("ascii", "surrogateescape")
    except UnicodeEncodeError:
        pass

    # Some parser/policy combinations already decoded the payload with the
    # declared charset; re-encode with the same charset to recover the bytes.
    declared = _declared_charset(part)
    if declared:
        try:
            return payload.encode(declared)
        except (LookupError, UnicodeEncodeError):
            pass

    for candidate in ("utf-8", "latin-1"):
        try:
            return payload.encode(candidate)
        except UnicodeEncodeError:
            continue

    return payload.encode("utf-8", "replace")


def _decode_transfer_encoding(part: Message) -> tuple[Optional[bytes], Optional[str], Optional[str]]:
    """Apply the part's Content-Transfer-Encoding.

    Returns (data, failure_detail, stage).  Exactly one of data/failure_detail
    is not None.
    """
    raw = _payload_bytes(part)
    cte = _content_transfer_encoding(part)

    if cte in ("", "7bit", "8bit", "binary"):
        return raw, None, None

    if cte == "base64":
        compact = re.sub(rb"[ \t\r\n]+", b"", raw)
        # Mailers occasionally omit the final padding; restore it before
        # decoding, while still rejecting non-alphabet bytes.
        if len(compact) % 4 == 2:
            compact += b"=="
        elif len(compact) % 4 == 3:
            compact += b"="
        try:
            return base64.b64decode(compact, validate=True), None, None
        except (binascii.Error, ValueError) as exc:
            return None, f"base64 decode failed: {exc}", "transfer_encoding"

    if cte == "quoted-printable":
        invalid = INVALID_QP_RE.search(raw)
        if invalid is not None:
            return (
                None,
                f"quoted-printable decode failed: invalid escape at payload byte {invalid.start()}",
                "transfer_encoding",
            )
        return quopri.decodestring(raw), None, None

    return None, f"unsupported Content-Transfer-Encoding {cte!r}", "transfer_encoding"


def _declared_charset(part: Message) -> Optional[str]:
    """Return the charset declared by the part, or None when absent.

    Only the literal Content-Type "charset" parameter counts: a part without
    one must be read as UTF-8, not as the e-mail standards' historical
    us-ascii default.
    """
    try:
        charset = part.get_param("charset", header="content-type")
    except Exception:
        return None

    if isinstance(charset, (tuple, list)):
        # RFC 2231 style: (charset_of_parameter, language, value); the charset
        # name itself is the value.
        if len(charset) >= 3:
            charset = charset[2]
        elif charset:
            charset = charset[0]
        else:
            charset = None

    if isinstance(charset, bytes):
        charset = charset.decode("ascii", "replace")

    if not isinstance(charset, str) or not charset.strip():
        return None
    return charset.strip()


def _decode_charset(part: Message, data: bytes) -> tuple[Optional[str], Optional[str]]:
    """Decode bytes using the charset declared by the part (default UTF-8)."""
    charset = _declared_charset(part) or "utf-8"

    try:
        codec = codecs.lookup(charset).name
    except (LookupError, ValueError, TypeError):
        return None, f"unknown charset {charset!r} declared by MIME part"

    try:
        text = data.decode(codec)
    except UnicodeDecodeError as exc:
        return None, f"charset {charset!r} decode failed at byte {exc.start}: {exc.reason}"
    except Exception as exc:  # defensive: some codecs may raise other errors
        return None, f"charset {charset!r} decode failed: {exc}"

    if text.startswith(BOM):
        text = text[1:]
    return text, None


# ---------------------------------------------------------------------------
# CSV parsing
# ---------------------------------------------------------------------------

def _map_headers(header: list[str]) -> tuple[dict[str, int], list[str]]:
    mapping: dict[str, int] = {}
    for index, cell in enumerate(header):
        normalized = normalize_header(cell)
        if not normalized:
            continue
        for field_name in REQUIRED_FIELDS:
            if normalized in _ALIASES[field_name]:
                mapping.setdefault(field_name, index)
                break

    missing = [FIELD_LABELS[name] for name in REQUIRED_FIELDS if name not in mapping]
    return mapping, missing


def _parse_reading(raw: str) -> tuple[Optional[Decimal], Optional[str]]:
    if raw == "":
        return None, "reading is empty"
    if READING_RE.fullmatch(raw) is None:
        return None, "reading is not a finite decimal number"
    try:
        value = Decimal(raw)
    except InvalidOperation:
        return None, "reading is not a finite decimal number"
    if not value.is_finite():
        return None, "reading is not a finite decimal number"
    return value, None


def extract_attachment_records(
    part: Message,
    source_email: str,
    attachment_name: Optional[str],
    part_index: int,
) -> tuple[list[dict], list[dict]]:
    """Extract records from one CSV attachment.

    A failure in this attachment never prevents other attachments from being
    processed; a bad row never prevents valid rows in the same attachment from
    being emitted.
    """
    records: list[dict] = []
    errors: list[dict] = []

    data, failure, stage = _decode_transfer_encoding(part)
    if failure is not None:
        errors.append(
            _error(
                "attachment_decode_failure",
                source_email,
                failure,
                attachment_name,
                part_index,
                stage=stage,
            )
        )
        return records, errors

    text, failure = _decode_charset(part, data or b"")
    if failure is not None:
        errors.append(
            _error(
                "attachment_decode_failure",
                source_email,
                failure,
                attachment_name,
                part_index,
                stage="charset",
            )
        )
        return records, errors

    header: Optional[list[str]] = None
    header_line: Optional[int] = None
    header_map: dict[str, int] = {}
    previous_line = 0
    parser_failed = False

    # A stray NUL byte makes Python's csv module abort the whole stream; it is
    # never meaningful in a CSV export, so drop it and keep parsing.
    text = text.replace("\x00", "")

    try:
        reader = csv.reader(io.StringIO(text, newline=""))
        for row in reader:
            row_line = previous_line + 1
            previous_line = reader.line_num

            # Blank lines are layout, not data.
            if not row or not any(cell.strip() for cell in row):
                continue

            if header is None:
                # Excel may prefix the file with a "sep=," directive line; it
                # parses as either one cell or ("sep=", "").
                if (
                    len(row) <= 2
                    and row
                    and row[0].strip().casefold().startswith("sep=")
                ):
                    continue
                header = row
                header_line = row_line
                header_map, missing = _map_headers(header)
                if missing:
                    errors.append(
                        _error(
                            "missing_required_columns",
                            source_email,
                            "CSV header is missing required column(s): "
                            + ", ".join(missing),
                            attachment_name,
                            part_index,
                            missing_columns=missing,
                            headers=list(header),
                            header_line=header_line,
                        )
                    )
                    return records, errors
                continue

            if len(row) != len(header):
                errors.append(
                    _error(
                        "malformed_row",
                        source_email,
                        f"row has {len(row)} column(s), header has {len(header)}",
                        attachment_name,
                        part_index,
                        csv_line=row_line,
                        expected_columns=len(header),
                        actual_columns=len(row),
                    )
                )
                continue

            sample_id = row[header_map["sample_id"]].strip()
            test_item = row[header_map["test_item"]].strip()
            raw_reading = row[header_map["reading"]].strip()

            missing_values = []
            if not sample_id:
                missing_values.append(FIELD_LABELS["sample_id"])
            if not test_item:
                missing_values.append(FIELD_LABELS["test_item"])
            if missing_values:
                errors.append(
                    _error(
                        "missing_required_value",
                        source_email,
                        "row is missing required value(s): "
                        + ", ".join(missing_values),
                        attachment_name,
                        part_index,
                        csv_line=row_line,
                        missing_fields=missing_values,
                    )
                )
                continue

            reading, reason = _parse_reading(raw_reading)
            if reading is None:
                errors.append(
                    _error(
                        "invalid_reading",
                        source_email,
                        reason or "invalid reading",
                        attachment_name,
                        part_index,
                        csv_line=row_line,
                        raw_reading=raw_reading,
                    )
                )
                continue

            records.append(
                {
                    "sample_id": sample_id,
                    "test_item": test_item,
                    "reading": reading,
                    "source_email": source_email,
                    "attachment_name": attachment_name,
                    "part_index": part_index,
                    "csv_line": row_line,
                }
            )
    except csv.Error as exc:
        parser_failed = True
        errors.append(
            _error(
                "csv_parse_failure",
                source_email,
                f"CSV parser failed after line {previous_line}: {exc}",
                attachment_name,
                part_index,
            )
        )

    # An empty attachment cannot have the required columns either; report it as
    # such rather than silently producing no records.
    if header is None and not parser_failed:
        errors.append(
            _error(
                "missing_required_columns",
                source_email,
                "CSV attachment is empty; header row not found",
                attachment_name,
                part_index,
                missing_columns=list(FIELD_LABELS.values()),
                headers=[],
                header_line=None,
            )
        )

    return records, errors


# ---------------------------------------------------------------------------
# E-mail traversal
# ---------------------------------------------------------------------------

def extract_email_records(
    message: Message,
    source_email: str,
) -> tuple[list[dict], list[dict], int]:
    """Walk the outer message and return (records, errors, csv_attachment_count).

    Parts are numbered 1, 2, 3, ... in pre-order, with the root entity as
    part 1.  A whole forwarded e-mail counts as one part and is not descended
    into, so nothing inside it is numbered or extracted.
    """
    records: list[dict] = []
    errors: list[dict] = []
    attachment_count = 0
    next_index = 1

    def visit(part: Message) -> None:
        nonlocal next_index, attachment_count

        part_index = next_index
        next_index += 1
        attachment_name = None

        try:
            # A whole e-mail forwarded as an attachment is skipped together
            # with everything inside it; it is still numbered so indices of the
            # parts around it stay stable.  The root entity is the outer e-mail
            # itself and is never skipped.
            if part_index != 1 and _is_forwarded_email(part):
                return

            if part.is_multipart():
                payload = part.get_payload()
                if isinstance(payload, list):
                    for child in payload:
                        if isinstance(child, Message):
                            visit(child)
                return

            if not _is_csv_part(part):
                return

            attachment_count += 1
            attachment_name = get_attachment_name(part)
            part_records, part_errors = extract_attachment_records(
                part, source_email, attachment_name, part_index
            )
        except Exception as exc:  # one bad part must not stop the e-mail
            errors.append(
                _error(
                    "attachment_unreadable",
                    source_email,
                    f"unexpected error while reading MIME part: "
                    f"{type(exc).__name__}: {exc}",
                    attachment_name,
                    part_index,
                    stage="unexpected",
                )
            )
            return

        records.extend(part_records)
        errors.extend(part_errors)

    visit(message)
    return records, errors, attachment_count


def parse_email(raw: bytes) -> Message:
    """Parse an EML file, keeping raw payload bytes intact.

    ``compat32`` stores the literal transferred text in the part payload,
    with 8-bit bytes represented as surrogate escapes.  That is essential here:
    the part's declared charset must decide how those bytes are read, and the
    parser must not silently replace bytes that are invalid for that charset.
    """
    return BytesParser(policy=policy.compat32).parsebytes(raw)


# ---------------------------------------------------------------------------
# JSONL output
# ---------------------------------------------------------------------------

def _decimal_literal(value: Decimal) -> str:
    """Render a finite Decimal as a valid JSON number literal.

    Decimal's own rendering is exact and keeps the value, but it may start
    with a "+" sign, which JSON does not allow.
    """
    text = str(value)
    if text.startswith("+"):
        text = text[1:]
    if text.endswith("."):
        text = text[:-1]
    return text


def _sanitize(value):
    """Replace lone surrogates so the value can always be written as UTF-8.

    Surrogates can arrive from raw 8-bit header bytes or from filesystem paths
    that are not valid UTF-8; they must never reach the JSONL writer.
    """
    if isinstance(value, str):
        if any(0xD800 <= ord(char) <= 0xDFFF for char in value):
            return value.translate(_SURROGATE_FIX)
        return value
    if isinstance(value, dict):
        return {_sanitize(k): _sanitize(v) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [_sanitize(item) for item in value]
    return value


def dumps_record(record: dict) -> str:
    """Serialize a record, preserving Decimal readings as exact JSON numbers."""
    fields = []
    for key, value in record.items():
        if key == "reading" and isinstance(value, Decimal):
            rendered = _decimal_literal(value)
        else:
            rendered = json.dumps(_sanitize(value), ensure_ascii=False)
        fields.append(f"{json.dumps(_sanitize(key), ensure_ascii=False)}: {rendered}")
    return "{" + ", ".join(fields) + "}"


def _json_line(value: dict) -> str:
    return json.dumps(_sanitize(value), ensure_ascii=False)


# ---------------------------------------------------------------------------
# Directory scanning
# ---------------------------------------------------------------------------

def _eml_files(root: Path, recursive: bool) -> list[Path]:
    if root.is_file():
        return [root]
    iterator: Iterable[Path] = root.rglob("*") if recursive else root.iterdir()
    files = [
        path
        for path in iterator
        if path.is_file() and path.suffix.casefold() == ".eml"
    ]
    return sorted(files, key=lambda path: path.relative_to(root).as_posix())


def scan_directory(
    input_path: str | Path,
    records_path: str | Path,
    errors_path: str | Path,
    recursive: bool = True,
) -> ScanSummary:
    """Scan EML files and write records/errors as JSONL.

    Per-file and per-attachment failures are reported in the errors file; this
    function only raises for unusable arguments or output paths.
    """
    root = Path(input_path)
    if not root.exists():
        raise FileNotFoundError(f"input path does not exist: {root}")
    if root.is_file() and root.suffix.casefold() != ".eml":
        raise ValueError(f"input file is not an .eml file: {root}")

    records_out = Path(records_path)
    errors_out = Path(errors_path)
    if records_out.resolve() == errors_out.resolve():
        raise ValueError("records and errors output paths must differ")

    records_out.parent.mkdir(parents=True, exist_ok=True)
    errors_out.parent.mkdir(parents=True, exist_ok=True)

    files = _eml_files(root, recursive)
    summary = ScanSummary(emails_found=len(files))

    with records_out.open("w", encoding="utf-8", newline="\n") as records_file, \
            errors_out.open("w", encoding="utf-8", newline="\n") as errors_file:
        for path in files:
            if root.is_dir():
                source_email = path.relative_to(root).as_posix()
            else:
                source_email = path.name

            try:
                raw = path.read_bytes()
                message = parse_email(raw)
            except Exception as exc:
                summary.emails_failed += 1
                error = _error(
                    "email_parse_failure",
                    source_email,
                    f"{type(exc).__name__}: {exc}",
                )
                errors_file.write(_json_line(error) + "\n")
                summary.error_counts[error["error_type"]] += 1
                continue

            try:
                records, errors, attachment_count = extract_email_records(
                    message, source_email
                )
            except Exception as exc:
                # Defensive: one pathological e-mail must not stop the scan.
                summary.emails_failed += 1
                error = _error(
                    "email_parse_failure",
                    source_email,
                    f"{type(exc).__name__}: {exc}",
                )
                errors_file.write(_json_line(error) + "\n")
                summary.error_counts[error["error_type"]] += 1
                continue

            summary.emails_processed += 1
            summary.csv_attachments += attachment_count
            summary.records += len(records)
            for record in records:
                records_file.write(dumps_record(record) + "\n")
            for error in errors:
                errors_file.write(_json_line(error) + "\n")
                summary.error_counts[error["error_type"]] += 1

    return summary


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def build_argument_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description=(
            "Extract valid laboratory CSV records from the outer message of "
            "EML files and write them as JSONL."
        )
    )
    parser.add_argument("input", help="EML file or directory to scan")
    parser.add_argument(
        "-o", "--records", default="records.jsonl", help="JSONL records output"
    )
    parser.add_argument(
        "-e", "--errors", default="errors.jsonl", help="JSONL errors output"
    )
    parser.add_argument(
        "--no-recursive",
        action="store_true",
        help="do not descend into subdirectories",
    )
    parser.add_argument(
        "--quiet", action="store_true", help="do not print the summary to stdout"
    )
    return parser


def main(argv: Optional[list[str]] = None) -> int:
    args = build_argument_parser().parse_args(argv)
    try:
        summary = scan_directory(
            args.input,
            args.records,
            args.errors,
            recursive=not args.no_recursive,
        )
    except (FileNotFoundError, ValueError) as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2
    except OSError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2

    if not args.quiet:
        result = summary.to_dict()
        result["records_path"] = str(Path(args.records))
        result["errors_path"] = str(Path(args.errors))
        print(json.dumps(result, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
