"""Cold-chain gateway batch receiver.

Each gateway uploads batches as a pair of files dropped into an inbox
directory::

    {gateway_id}_batch{batch_no}.zip
    {gateway_id}_batch{batch_no}.json

The JSON manifest records the gateway id, the 1-based batch number and, for
every CSV member packed in the ZIP, its file name, byte size and SHA-256.
A pair is only validated once both files are present.  Validated batches are
released to downstream per gateway, strictly in batch order: a later batch is
held until every earlier batch of the same gateway is published.

Publishing is atomic: the ZIP members are extracted into a staging directory
and the finished directory is renamed into ``published/`` in one operation,
so downstream never observes a partial batch.
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import sqlite3
import time
import zipfile
from datetime import datetime, timezone
from pathlib import Path

# ---------------------------------------------------------------------------
# Constants and small helpers
# ---------------------------------------------------------------------------

INBOX = "inbox"
STAGING = "staging"
PUBLISHED = "published"
RECEIPTS = "receipts"
STATE_DIR = "state"
DB_NAME = "coldstore.db"

# inbox/<gw>_batch<no>.(zip|json); batch numbers are plain integers (no leading zeros)
NAME_RE = re.compile(
    r"^(?P<gw>[A-Za-z0-9][A-Za-z0-9_-]{0,63})_batch(?P<no>[1-9][0-9]*)\.(?P<kind>zip|json)$"
)
GATEWAY_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$")
PUBLISHED_RE = re.compile(r"^batch(?P<no>[0-9]+)$")
SHA256_RE = re.compile(r"^[0-9a-fA-F]{64}$")

# lifecycle states
INCOMPLETE = "incomplete"   # only one of the two pair files has arrived
BAD = "bad"                 # pair present, validation failed (re-upload allowed)
VALIDATED = "validated"     # passed validation, held behind a sequence gap
PUBLISHED = "published"     # visible to downstream
CONFLICT = "conflict"       # published batch re-arrived with different content

READABLE_STATES = {INCOMPLETE, BAD, VALIDATED, PUBLISHED, CONFLICT}


def utc_now() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%fZ")


def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as fh:
        for chunk in iter(lambda: fh.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def content_hash(gateway_id: str, batch_no: int, files: list[dict]) -> str:
    """Deterministic hash identifying a batch's logical content.

    Two arrivals with the same gateway, batch number and member set
    (name/size/sha256, order independent) produce the same hash and are
    therefore treated as the same retransmission.
    """
    payload = {
        "gateway_id": gateway_id,
        "batch_no": batch_no,
        "files": sorted(
            (
                {
                    "name": f["name"],
                    "bytes": f["bytes"],
                    "sha256": f["sha256"].lower(),
                }
                for f in files
            ),
            key=lambda item: item["name"],
        ),
    }
    blob = json.dumps(payload, sort_keys=True, separators=(",", ":")).encode("utf-8")
    return hashlib.sha256(blob).hexdigest()


def safe_member_name(name: str) -> bool:
    """Reject anything that could escape a flat output directory."""
    if not name or len(name) > 255:
        return False
    if "\x00" in name or "/" in name or "\\" in name:
        return False
    if name in (".", "..") or name.startswith("."):
        return False
    return True


def atomic_write_text(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(f".{path.name}.tmp-{os.getpid()}")
    with tmp.open("w", encoding="utf-8") as fh:
        fh.write(text)
        fh.flush()
        os.fsync(fh.fileno())
    os.replace(tmp, path)


def fsync_dir(path: Path) -> None:
    try:
        fd = os.open(str(path), os.O_RDONLY)
    except OSError:
        return
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


class ValidationError(Exception):
    """Raised with a human-readable reason when a pair fails validation."""


# ---------------------------------------------------------------------------
# Core receiver
# ---------------------------------------------------------------------------


class Receiver:
    def __init__(
        self,
        root: str | os.PathLike,
        stable_seconds: float = 2.0,
    ) -> None:
        self.root = Path(root)
        self.inbox = self.root / INBOX
        self.staging = self.root / STAGING
        self.published = self.root / PUBLISHED
        self.receipts = self.root / RECEIPTS
        self.state_dir = self.root / STATE_DIR
        self.db_path = self.state_dir / DB_NAME
        self.stable_seconds = stable_seconds
        # path -> (size, mtime_ns, first_seen_monotonic); daemon-mode stability
        self._pending: dict[str, tuple[int, int, float]] = {}
        self._ensure_dirs()
        self.conn = self._open_db()
        self.reconcile_published()

    # -- setup -------------------------------------------------------------

    def _ensure_dirs(self) -> None:
        for directory in (
            self.inbox,
            self.staging,
            self.published,
            self.receipts,
            self.state_dir,
        ):
            directory.mkdir(parents=True, exist_ok=True)

    def _open_db(self) -> sqlite3.Connection:
        conn = sqlite3.connect(str(self.db_path), timeout=30)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA journal_mode=WAL")
        conn.execute("PRAGMA foreign_keys=ON")
        conn.executescript(
            """
            CREATE TABLE IF NOT EXISTS batches (
                gateway_id        TEXT NOT NULL,
                batch_no          INTEGER NOT NULL,
                state             TEXT NOT NULL,
                receipt_id        TEXT,
                content_hash      TEXT,
                manifest_json     TEXT,
                zip_name          TEXT,
                json_name         TEXT,
                zip_fingerprint   TEXT,
                json_fingerprint  TEXT,
                error             TEXT,
                first_seen_at     TEXT NOT NULL,
                updated_at        TEXT NOT NULL,
                validated_at      TEXT,
                published_at      TEXT,
                PRIMARY KEY (gateway_id, batch_no)
            );

            CREATE TABLE IF NOT EXISTS events (
                id          INTEGER PRIMARY KEY AUTOINCREMENT,
                gateway_id  TEXT NOT NULL,
                batch_no    INTEGER NOT NULL,
                event       TEXT NOT NULL,
                detail      TEXT,
                created_at  TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_events_batch
                ON events(gateway_id, batch_no);
            """
        )
        conn.commit()
        return conn

    def close(self) -> None:
        self.conn.close()

    def _event(self, gw: str, no: int, event: str, detail: dict | None = None) -> None:
        self.conn.execute(
            "INSERT INTO events(gateway_id, batch_no, event, detail, created_at)"
            " VALUES (?, ?, ?, ?, ?)",
            (gw, no, event, json.dumps(detail or {}, ensure_ascii=False), utc_now()),
        )

    def _get_row(self, gw: str, no: int) -> sqlite3.Row | None:
        return self.conn.execute(
            "SELECT * FROM batches WHERE gateway_id=? AND batch_no=?",
            (gw, no),
        ).fetchone()

    # -- restart reconciliation --------------------------------------------

    def reconcile_published(self) -> None:
        """Rebuild state from the published directories after a restart.

        The published directory plus the receipt file are the durable truth.
        Rows missing from the DB are reconstructed; rows whose directory has
        vanished are downgraded so the normal scan can repair them.
        """
        on_disk: dict[str, set[int]] = {}
        if self.published.exists():
            for gw_dir in sorted(self.published.iterdir()):
                if not gw_dir.is_dir():
                    continue
                gw = gw_dir.name
                for batch_dir in sorted(gw_dir.iterdir()):
                    m = PUBLISHED_RE.match(batch_dir.name)
                    if m and batch_dir.is_dir():
                        on_disk.setdefault(gw, set()).add(int(m.group("no")))

        for gw, numbers in on_disk.items():
            for no in sorted(numbers):
                row = self._get_row(gw, no)
                if row is not None:
                    # Existing rows are authoritative.  In particular a
                    # CONFLICT row must survive even though the original
                    # published directory is still on disk: reconciliation
                    # must never erase a deliberately recorded conflict.
                    continue
                receipt = self._read_receipt(gw, no)
                now = utc_now()
                self.conn.execute(
                    "INSERT INTO batches(gateway_id, batch_no, state, receipt_id,"
                    " content_hash, manifest_json, first_seen_at, updated_at,"
                    " validated_at, published_at)"
                    " VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
                    " ON CONFLICT(gateway_id, batch_no) DO UPDATE SET"
                    " state=excluded.state, receipt_id=excluded.receipt_id,"
                    " content_hash=excluded.content_hash,"
                    " manifest_json=excluded.manifest_json,"
                    " published_at=COALESCE(batches.published_at, excluded.published_at),"
                    " updated_at=excluded.updated_at, error=NULL",
                    (
                        gw,
                        no,
                        PUBLISHED,
                        receipt.get("receipt_id") if receipt else None,
                        receipt.get("content_hash") if receipt else None,
                        json.dumps(receipt["files"], ensure_ascii=False)
                        if receipt and "files" in receipt
                        else None,
                        now,
                        now,
                        receipt.get("validated_at") if receipt else now,
                        receipt.get("published_at") if receipt else now,
                    ),
                )
                self._event(gw, no, "reconciled_published", {"from": "disk"})

        for row in self.conn.execute(
            "SELECT * FROM batches WHERE state=?", (PUBLISHED,)
        ).fetchall():
            target = self.published / row["gateway_id"] / f"batch{row['batch_no']}"
            if target.is_dir():
                continue
            pair = self._pair_on_disk(row["gateway_id"], row["batch_no"])
            if pair.get("zip") and pair.get("json"):
                # originals still in inbox: fall back and let the scan re-publish
                self.conn.execute(
                    "UPDATE batches SET state=?, published_at=NULL, updated_at=?,"
                    " error=? WHERE gateway_id=? AND batch_no=?",
                    (
                        VALIDATED,
                        utc_now(),
                        "published directory missing; awaiting re-publish",
                        row["gateway_id"],
                        row["batch_no"],
                    ),
                )
                self._event(
                    row["gateway_id"], row["batch_no"], "publish_dir_missing",
                    {"repair": "revalidate"},
                )
            else:
                self.conn.execute(
                    "UPDATE batches SET state=?, error=?, updated_at=?"
                    " WHERE gateway_id=? AND batch_no=?",
                    (
                        BAD,
                        "published directory missing and no local copy to repair",
                        utc_now(),
                        row["gateway_id"],
                        row["batch_no"],
                    ),
                )
        self.conn.commit()

    # -- inbox scanning -----------------------------------------------------

    @staticmethod
    def _fingerprint(path: Path) -> str:
        st = path.stat()
        return f"{st.st_size}:{st.st_mtime_ns}"

    def _is_stable(self, path: Path, fingerprint: str) -> bool:
        """A file is stable when its size/mtime have settled.

        Daemon mode remembers the first sighting; a fresh process (or
        --once) falls back to mtime age, which is why tests can pre-age files.
        """
        size, mtime_ns = fingerprint.split(":")
        size, mtime_ns = int(size), int(mtime_ns)
        key = str(path)
        now_mono = time.monotonic()
        seen = self._pending.get(key)
        if seen is None or seen[:2] != (size, mtime_ns):
            self._pending[key] = (size, mtime_ns, now_mono)
            age_ok = (time.time() - (mtime_ns / 1e9)) >= self.stable_seconds
            return age_ok
        return (now_mono - seen[2]) >= self.stable_seconds

    def _pair_on_disk(self, gw: str, no: int) -> dict[str, Path]:
        """Return whichever half-pairs currently exist in the inbox."""
        out: dict[str, Path] = {}
        for kind in ("zip", "json"):
            p = self.inbox / f"{gw}_batch{no}.{kind}"
            if p.is_file():
                out[kind] = p
        return out

    def scan_inbox(self) -> dict[tuple[str, int], dict[str, Path]]:
        pairs: dict[tuple[str, int], dict[str, Path]] = {}
        for entry in sorted(self.inbox.iterdir()):
            if not entry.is_file():
                continue
            m = NAME_RE.match(entry.name)
            if not m:
                continue  # unrelated files are ignored, not rejected
            key = (m.group("gw"), int(m.group("no")))
            pairs.setdefault(key, {})[m.group("kind")] = entry
        return pairs

    def scan_once(self) -> None:
        pairs = self.scan_inbox()
        seen_keys: set[tuple[str, int]] = set()

        for (gw, no), files in pairs.items():
            seen_keys.add((gw, no))
            row = self._get_row(gw, no)

            # Skip work we have already done on unchanged files.  BAD rows
            # always re-scan so a gateway's corrected replacement is picked
            # up even within the same mtime tick; CONFLICT rows skip only
            # while the foreign files are byte-identical to the last scan.
            if row is not None:
                fp_zip = self._fingerprint(files["zip"]) if "zip" in files else None
                fp_json = self._fingerprint(files["json"]) if "json" in files else None
                if (
                    row["state"] in (VALIDATED, PUBLISHED, CONFLICT)
                    and row["zip_fingerprint"] == fp_zip
                    and row["json_fingerprint"] == fp_json
                ):
                    continue

            if "zip" not in files or "json" not in files:
                self._handle_incomplete(gw, no, files)
                continue

            zip_path, json_path = files["zip"], files["json"]
            if not self._is_stable(zip_path, self._fingerprint(zip_path)):
                continue
            if not self._is_stable(json_path, self._fingerprint(json_path)):
                continue
            self._handle_complete_pair(gw, no, zip_path, json_path, row)

        # A previously known half-pair whose file was removed from the inbox
        # stays recorded; nothing to do here.
        self.conn.commit()
        self.publish_ready()
        self.conn.commit()

    def run(self, interval: float = 5.0, once: bool = False) -> None:
        try:
            self.scan_once()
            if once:
                return
            while True:
                self.scan_once()
                time.sleep(interval)
        except KeyboardInterrupt:
            pass
        finally:
            self.close()

    # -- state transitions --------------------------------------------------

    def _handle_incomplete(
        self, gw: str, no: int, files: dict[str, Path]
    ) -> None:
        now = utc_now()
        zip_name = files["zip"].name if "zip" in files else None
        json_name = files["json"].name if "json" in files else None
        missing = "json" if "zip" in files else "zip"
        row = self._get_row(gw, no)
        if row is None:
            self.conn.execute(
                "INSERT INTO batches(gateway_id, batch_no, state, zip_name,"
                " json_name, zip_fingerprint, json_fingerprint, error,"
                " first_seen_at, updated_at)"
                " VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                (
                    gw, no, INCOMPLETE, zip_name, json_name,
                    self._fingerprint(files["zip"]) if "zip" in files else None,
                    self._fingerprint(files["json"]) if "json" in files else None,
                    f"missing {missing} file", now, now,
                ),
            )
            self._event(gw, no, "incomplete", {"missing": missing})
        elif row["state"] != PUBLISHED:
            self.conn.execute(
                "UPDATE batches SET state=?, zip_name=?, json_name=?,"
                " zip_fingerprint=?, json_fingerprint=?, error=?, updated_at=?"
                " WHERE gateway_id=? AND batch_no=?",
                (
                    INCOMPLETE, zip_name, json_name,
                    self._fingerprint(files["zip"]) if "zip" in files else None,
                    self._fingerprint(files["json"]) if "json" in files else None,
                    f"missing {missing} file", now, gw, no,
                ),
            )

    def _handle_complete_pair(
        self,
        gw: str,
        no: int,
        zip_path: Path,
        json_path: Path,
        prior: sqlite3.Row | None,
    ) -> None:
        fp_zip = self._fingerprint(zip_path)
        fp_json = self._fingerprint(json_path)
        now = utc_now()

        try:
            manifest = self.validate_pair(gw, no, zip_path, json_path)
        except ValidationError as exc:
            reason = str(exc)
            if prior is None:
                self.conn.execute(
                    "INSERT INTO batches(gateway_id, batch_no, state, zip_name,"
                    " json_name, zip_fingerprint, json_fingerprint, error,"
                    " first_seen_at, updated_at)"
                    " VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                    (gw, no, BAD, zip_path.name, json_path.name, fp_zip, fp_json,
                     reason, now, now),
                )
            else:
                self.conn.execute(
                    "UPDATE batches SET state=?, zip_name=?, json_name=?,"
                    " zip_fingerprint=?, json_fingerprint=?, error=?, updated_at=?"
                    " WHERE gateway_id=? AND batch_no=?",
                    (BAD, zip_path.name, json_path.name, fp_zip, fp_json,
                     reason, now, gw, no),
                )
            self._event(gw, no, "validation_failed", {"reason": reason})
            return

        h = content_hash(gw, no, manifest["files"])

        # Retransmission handling for an already published batch.  The
        # published directory + its receipt are the durable truth; a CONFLICT
        # row's own hash is the *foreign* content and must never be treated
        # as authoritative.  The database PUBLISHED row is used when the
        # receipt happens to be unavailable.
        target = self.published / gw / f"batch{no}"
        disk_receipt = self._read_receipt(gw, no) if target.is_dir() else None
        published_hash: str | None = None
        published_receipt_id: str | None = None
        if disk_receipt is not None and disk_receipt.get("content_hash"):
            published_hash = disk_receipt["content_hash"]
            published_receipt_id = disk_receipt.get("receipt_id")
        elif (
            prior is not None
            and prior["state"] == PUBLISHED
            and prior["content_hash"]
        ):
            published_hash = prior["content_hash"]
            published_receipt_id = prior["receipt_id"]

        if published_hash is not None:
            if published_hash == h:
                # Identical retransmission: keep the original receipt.
                event_name = (
                    "duplicate"
                    if prior is None or prior["state"] in (PUBLISHED, CONFLICT)
                    else "revalidated_after_conflict"
                )
                if prior is None:
                    self.conn.execute(
                        "INSERT INTO batches(gateway_id, batch_no, state,"
                        " receipt_id, content_hash, manifest_json, zip_name,"
                        " json_name, zip_fingerprint, json_fingerprint,"
                        " first_seen_at, updated_at, validated_at, published_at)"
                        " VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                        (
                            gw, no, PUBLISHED,
                            published_receipt_id, h,
                            json.dumps(manifest, ensure_ascii=False),
                            zip_path.name, json_path.name, fp_zip, fp_json,
                            now, now,
                            disk_receipt.get("validated_at") if disk_receipt else now,
                            disk_receipt.get("published_at") if disk_receipt else now,
                        ),
                    )
                else:
                    self.conn.execute(
                        "UPDATE batches SET state=?, receipt_id=?, content_hash=?,"
                        " manifest_json=?, zip_fingerprint=?, json_fingerprint=?,"
                        " error=NULL, updated_at=? WHERE gateway_id=? AND batch_no=?",
                        (
                            PUBLISHED, published_receipt_id, h,
                            json.dumps(manifest, ensure_ascii=False),
                            fp_zip, fp_json, now, gw, no,
                        ),
                    )
                self._event(
                    gw, no, event_name,
                    {"receipt_id": published_receipt_id, "content_hash": h},
                )
                self._remove_inbox_pair(gw, no)
            else:
                if prior is None:
                    self.conn.execute(
                        "INSERT INTO batches(gateway_id, batch_no, state,"
                        " receipt_id, content_hash, manifest_json, zip_name,"
                        " json_name, zip_fingerprint, json_fingerprint, error,"
                        " first_seen_at, updated_at)"
                        " VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                        (
                            gw, no, CONFLICT, "rcpt_" + h, h,
                            json.dumps(manifest, ensure_ascii=False),
                            zip_path.name, json_path.name, fp_zip, fp_json,
                            "re-arrived content differs from published batch",
                            now, now,
                        ),
                    )
                else:
                    self.conn.execute(
                        "UPDATE batches SET state=?, receipt_id=?, content_hash=?,"
                        " manifest_json=?, zip_fingerprint=?, json_fingerprint=?,"
                        " error=?, updated_at=? WHERE gateway_id=? AND batch_no=?",
                        (
                            CONFLICT, "rcpt_" + h, h,
                            json.dumps(manifest, ensure_ascii=False),
                            fp_zip, fp_json,
                            "re-arrived content differs from published batch",
                            now, gw, no,
                        ),
                    )
                self._event(
                    gw, no, "conflict",
                    {
                        "published_hash": published_hash,
                        "incoming_hash": h,
                        "published_receipt_id": published_receipt_id,
                    },
                )
                # files are deliberately retained as evidence
            return

        receipt_id = "rcpt_" + h

        if prior is None:
            self.conn.execute(
                "INSERT INTO batches(gateway_id, batch_no, state, receipt_id,"
                " content_hash, manifest_json, zip_name, json_name,"
                " zip_fingerprint, json_fingerprint, first_seen_at, updated_at,"
                " validated_at)"
                " VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                (
                    gw, no, VALIDATED, receipt_id, h,
                    json.dumps(manifest, ensure_ascii=False),
                    zip_path.name, json_path.name, fp_zip, fp_json, now, now, now,
                ),
            )
            self._event(gw, no, "validated", {"content_hash": h})
        else:
            replaced = prior["state"] == VALIDATED and prior["content_hash"] != h
            self.conn.execute(
                "UPDATE batches SET state=?, receipt_id=?, content_hash=?,"
                " manifest_json=?, zip_name=?, json_name=?, zip_fingerprint=?,"
                " json_fingerprint=?, error=NULL, updated_at=?, validated_at=?"
                " WHERE gateway_id=? AND batch_no=?",
                (
                    VALIDATED, receipt_id, h,
                    json.dumps(manifest, ensure_ascii=False),
                    zip_path.name, json_path.name, fp_zip, fp_json, now, now,
                    gw, no,
                ),
            )
            self._event(
                gw, no,
                "content_replaced" if replaced else "revalidated",
                {"content_hash": h},
            )

        self._write_receipt(
            gw, no, manifest, h, receipt_id, now,
            status=VALIDATED, validated_at=now,
        )

    # -- validation ---------------------------------------------------------

    def validate_pair(
        self, gw: str, no: int, zip_path: Path, json_path: Path
    ) -> dict:
        """Validate one complete pair; raise ValidationError on any defect."""
        try:
            manifest = json.loads(json_path.read_text(encoding="utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
            raise ValidationError(f"manifest is not valid JSON: {exc}") from exc

        if not isinstance(manifest, dict):
            raise ValidationError("manifest root must be a JSON object")

        m_gw = manifest.get("gateway_id")
        m_no = manifest.get("batch_no")
        m_files = manifest.get("files")

        if not isinstance(m_gw, str) or not GATEWAY_RE.match(m_gw):
            raise ValidationError("manifest gateway_id missing or malformed")
        if m_gw != gw:
            raise ValidationError(
                f"manifest gateway_id {m_gw!r} does not match file name {gw!r}"
            )
        if isinstance(m_no, bool) or not isinstance(m_no, int) or m_no < 1:
            raise ValidationError("manifest batch_no must be an integer >= 1")
        if m_no != no:
            raise ValidationError(
                f"manifest batch_no {m_no} does not match file name batch {no}"
            )
        if not isinstance(m_files, list):
            raise ValidationError("manifest files must be a list")

        files: list[dict] = []
        seen_names: set[str] = set()
        for idx, entry in enumerate(m_files):
            if not isinstance(entry, dict):
                raise ValidationError(f"manifest files[{idx}] must be an object")
            name = entry.get("name")
            size = entry.get("bytes")
            digest = entry.get("sha256")
            if not isinstance(name, str) or not safe_member_name(name):
                raise ValidationError(
                    f"manifest files[{idx}] has an unsafe file name: {name!r}"
                )
            if name in seen_names:
                raise ValidationError(f"duplicate manifest member: {name}")
            seen_names.add(name)
            if isinstance(size, bool) or not isinstance(size, int) or size < 0:
                raise ValidationError(
                    f"manifest files[{idx}].bytes must be a non-negative integer"
                )
            if not isinstance(digest, str) or not SHA256_RE.match(digest):
                raise ValidationError(
                    f"manifest files[{idx}].sha256 must be 64 hex characters"
                )
            files.append({"name": name, "bytes": size, "sha256": digest.lower()})

        try:
            zf = zipfile.ZipFile(zip_path)
        except (zipfile.BadZipFile, OSError) as exc:
            raise ValidationError(f"cannot open ZIP: {exc}") from exc

        with zf:
            bad_crc = zf.testzip()
            if bad_crc is not None:
                raise ValidationError(f"ZIP member CRC failure: {bad_crc}")

            infos = zf.infolist()
            if len(infos) != len(seen_names):
                raise ValidationError(
                    "ZIP member count does not match manifest"
                )
            zip_names: set[str] = set()
            for info in infos:
                if info.is_dir():
                    raise ValidationError(f"ZIP contains directory entry: {info.filename!r}")
                if not safe_member_name(info.filename):
                    raise ValidationError(
                        f"unsafe ZIP member name: {info.filename!r}"
                    )
                if info.filename in zip_names:
                    raise ValidationError(
                        f"duplicate ZIP member: {info.filename}"
                    )
                zip_names.add(info.filename)

            if zip_names != seen_names:
                only_zip = sorted(zip_names - seen_names)
                only_manifest = sorted(seen_names - zip_names)
                raise ValidationError(
                    "ZIP/manifest member set mismatch "
                    f"(only in ZIP: {only_zip}, only in manifest: {only_manifest})"
                )

            by_name = {f["name"]: f for f in files}
            for info in infos:
                expected = by_name[info.filename]
                if info.file_size != expected["bytes"]:
                    raise ValidationError(
                        f"{info.filename}: size {info.file_size} != manifest "
                        f"{expected['bytes']}"
                    )
                try:
                    data = zf.read(info)
                except (zipfile.BadZipFile, OSError) as exc:
                    raise ValidationError(
                        f"cannot read {info.filename} from ZIP: {exc}"
                    ) from exc
                actual = sha256_bytes(data)
                if actual != expected["sha256"]:
                    raise ValidationError(
                        f"{info.filename}: SHA-256 mismatch "
                        f"(expected {expected['sha256'][:12]}..., got {actual[:12]}...)"
                    )

        return {"gateway_id": gw, "batch_no": no, "files": files}

    # -- publishing ---------------------------------------------------------

    def _next_expected(self, gw: str) -> int:
        no = 1
        while True:
            row = self._get_row(gw, no)
            if row is not None and row["state"] == PUBLISHED:
                no += 1
                continue
            return no

    def publish_ready(self) -> None:
        """Publish every gateway's contiguous validated run, independently."""
        gateways = {
            r["gateway_id"]
            for r in self.conn.execute(
                "SELECT DISTINCT gateway_id FROM batches"
            ).fetchall()
        }
        for gw in sorted(gateways):
            no = self._next_expected(gw)
            while True:
                row = self._get_row(gw, no)
                if row is None or row["state"] != VALIDATED:
                    break  # gap / bad / conflict blocks this gateway only
                self._publish(gw, no, row)
                no += 1

    def _publish(self, gw: str, no: int, row: sqlite3.Row) -> None:
        manifest = json.loads(row["manifest_json"])
        target = self.published / gw / f"batch{no}"
        if target.exists():  # idempotent after a crash mid-rename
            if not target.is_dir():
                raise RuntimeError(f"publish target exists and is not a directory: {target}")
        else:
            stage = (
                self.staging / gw
                / f"batch{no}.tmp-{os.getpid()}-{time.time_ns()}"
            )
            stage.mkdir(parents=True, exist_ok=True)
            try:
                with zipfile.ZipFile(self.inbox / row["zip_name"]) as zf:
                    for member in manifest["files"]:
                        data = zf.read(member["name"])  # CRC checked on read
                        out = stage / member["name"]
                        with out.open("wb") as fh:
                            fh.write(data)
                            fh.flush()
                            os.fsync(fh.fileno())
                target.parent.mkdir(parents=True, exist_ok=True)
                os.rename(stage, target)
                fsync_dir(target.parent)
            finally:
                if stage.exists():
                    for leftover in sorted(stage.rglob("*"), reverse=True):
                        leftover.unlink()
                    stage.rmdir()

        now = utc_now()
        self.conn.execute(
            "UPDATE batches SET state=?, published_at=?, updated_at=?,"
            " error=NULL WHERE gateway_id=? AND batch_no=?",
            (PUBLISHED, now, now, gw, no),
        )
        self._write_receipt(
            gw, no, manifest, row["content_hash"], row["receipt_id"],
            now, status=PUBLISHED, validated_at=row["validated_at"],
            published_at=now,
        )
        self._event(gw, no, "published", {"directory": str(target)})
        self.conn.commit()
        self._remove_inbox_pair(gw, no)

    def _remove_inbox_pair(self, gw: str, no: int) -> None:
        for kind in ("zip", "json"):
            p = self.inbox / f"{gw}_batch{no}.{kind}"
            try:
                p.unlink()
            except FileNotFoundError:
                pass
            self._pending.pop(str(p), None)

    # -- receipts -----------------------------------------------------------

    def _receipt_path(self, gw: str, no: int) -> Path:
        return self.receipts / gw / f"receipt_batch{no}.json"

    def _read_receipt(self, gw: str, no: int) -> dict | None:
        path = self._receipt_path(gw, no)
        if not path.is_file():
            return None
        try:
            return json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            return None

    def _write_receipt(
        self,
        gw: str,
        no: int,
        manifest: dict,
        hash_value: str,
        receipt_id: str,
        now: str,
        status: str,
        validated_at: str,
        published_at: str | None = None,
    ) -> None:
        existing = self._read_receipt(gw, no)
        first_received = existing.get("first_received_at", now) if existing else now
        receipt = {
            "receipt_id": receipt_id,
            "gateway_id": gw,
            "batch_no": no,
            "status": status,
            "content_hash": hash_value,
            "first_received_at": first_received,
            "validated_at": validated_at,
            "published_at": published_at,
            "files": manifest["files"],
        }
        atomic_write_text(
            self._receipt_path(gw, no),
            json.dumps(receipt, ensure_ascii=False, indent=2, sort_keys=True) + "\n",
        )

    # -- queries ------------------------------------------------------------

    def list_missing_pieces(self, gateway: str | None = None) -> list[dict]:
        sql = "SELECT * FROM batches WHERE state=?"
        args: list = [INCOMPLETE]
        if gateway:
            sql += " AND gateway_id=?"
            args.append(gateway)
        out = []
        for r in self.conn.execute(sql, args):
            have, missing = [], []
            for kind, name in (("zip", r["zip_name"]), ("json", r["json_name"])):
                (have if name else missing).append(kind)
            out.append({
                "gateway_id": r["gateway_id"],
                "batch_no": r["batch_no"],
                "have": have,
                "missing": missing,
                "reason": r["error"],
            })
        return out

    def list_bad(self, gateway: str | None = None) -> list[dict]:
        sql = "SELECT * FROM batches WHERE state=?"
        args: list = [BAD]
        if gateway:
            sql += " AND gateway_id=?"
            args.append(gateway)
        return [
            {
                "gateway_id": r["gateway_id"],
                "batch_no": r["batch_no"],
                "reason": r["error"],
                "zip": r["zip_name"],
                "json": r["json_name"],
                "updated_at": r["updated_at"],
            }
            for r in self.conn.execute(sql, args)
        ]

    def list_conflicts(self, gateway: str | None = None) -> list[dict]:
        sql = "SELECT * FROM batches WHERE state=?"
        args: list = [CONFLICT]
        if gateway:
            sql += " AND gateway_id=?"
            args.append(gateway)
        return [
            {
                "gateway_id": r["gateway_id"],
                "batch_no": r["batch_no"],
                "incoming_receipt_id": r["receipt_id"],
                "incoming_hash": r["content_hash"],
                "reason": r["error"],
                "updated_at": r["updated_at"],
            }
            for r in self.conn.execute(sql, args)
        ]

    def list_duplicates(self, gateway: str | None = None) -> list[dict]:
        sql = "SELECT * FROM events WHERE event='duplicate'"
        args: list = []
        if gateway:
            sql += " AND gateway_id=?"
            args.append(gateway)
        sql += " ORDER BY id"
        out = []
        for r in self.conn.execute(sql, args):
            detail = json.loads(r["detail"])
            out.append({
                "gateway_id": r["gateway_id"],
                "batch_no": r["batch_no"],
                "receipt_id": detail.get("receipt_id"),
                "content_hash": detail.get("content_hash"),
                "detected_at": r["created_at"],
            })
        return out

    def list_gaps(self, gateway: str | None = None) -> list[dict]:
        """Batch numbers with no record at all (distinct from bad/incomplete)."""
        gateways: set[str] = set()
        for r in self.conn.execute("SELECT DISTINCT gateway_id FROM batches"):
            gateways.add(r["gateway_id"])
        if self.published.exists():
            gateways.update(p.name for p in self.published.iterdir() if p.is_dir())
        if gateway:
            gateways = {gateway} if gateway in gateways else set()

        out = []
        for gw in sorted(gateways):
            max_no = 0
            for r in self.conn.execute(
                "SELECT MAX(batch_no) AS m FROM batches WHERE gateway_id=?", (gw,)
            ):
                max_no = r["m"] or 0
            disk_dir = self.published / gw
            if disk_dir.is_dir():
                for entry in disk_dir.iterdir():
                    m = PUBLISHED_RE.match(entry.name)
                    if m:
                        max_no = max(max_no, int(m.group("no")))
            for no in range(1, max_no + 1):
                if self._get_row(gw, no) is None:
                    out.append({"gateway_id": gw, "batch_no": no})
        return out

    def status(self, gateway: str | None = None) -> list[dict]:
        sql = "SELECT gateway_id, state, COUNT(*) AS n FROM batches"
        args: list = []
        if gateway:
            sql += " WHERE gateway_id=?"
            args.append(gateway)
        sql += " GROUP BY gateway_id, state ORDER BY gateway_id, state"
        summary: dict[str, dict[str, int]] = {}
        for r in self.conn.execute(sql, args):
            summary.setdefault(r["gateway_id"], {})[r["state"]] = r["n"]
        out = []
        for gw in sorted(summary):
            counts = summary[gw]
            out.append({
                "gateway_id": gw,
                "incomplete": counts.get(INCOMPLETE, 0),
                "bad": counts.get(BAD, 0),
                "validated_holding": counts.get(VALIDATED, 0),
                "published": counts.get(PUBLISHED, 0),
                "conflict": counts.get(CONFLICT, 0),
                "next_expected_batch": self._next_expected(gw),
            })
        return out
