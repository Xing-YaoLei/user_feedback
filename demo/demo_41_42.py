#!/usr/bin/env python3
"""End-to-end demonstration of the 41/42 out-of-order scenario.

Run from the repository root:

    python3 -I demo/demo_41_42.py /tmp/coldstore-demo

The script drives the real CLI and library code (no mocks), showing:

1. batch 42 is received and validated but held invisible behind a gap
2. missing-piece / bad / gap queries stay distinguishable
3. once batch 41 (and the missing run) arrives, everything publishes in order
4. identical retransmission reuses the original receipt; different content
   is recorded as a conflict without touching the published batch
5. a restart reconstructs state from the published directories
"""

from __future__ import annotations

import hashlib
import io
import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
import zipfile
from contextlib import redirect_stdout
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from coldstore.cli import main as cli_main  # noqa: E402


def sha(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def drop_batch(
    inbox: Path,
    gw: str,
    no: int,
    members: dict[str, bytes],
    *,
    hash_override: dict[str, str] | None = None,
) -> None:
    manifest = {"gateway_id": gw, "batch_no": no, "files": []}
    with zipfile.ZipFile(inbox / f"{gw}_batch{no}.zip", "w") as zf:
        for name, data in members.items():
            zf.writestr(name, data)
            digest = hash_override[name] if hash_override and name in hash_override \
                else sha(data)
            manifest["files"].append(
                {"name": name, "bytes": len(data), "sha256": digest}
            )
    (inbox / f"{gw}_batch{no}.json").write_text(
        json.dumps(manifest, ensure_ascii=False), encoding="utf-8"
    )
    # make each drop look like a finished, settled write: distinct mtime
    # across drops and old enough to pass the stability window immediately
    tick = time.time_ns()
    for suffix in (".zip", ".json"):
        p = inbox / f"{gw}_batch{no}{suffix}"
        os.utime(p, ns=(tick - 10_000_000_000, tick - 10_000_000_000))


def cli(*args: str) -> object:
    buf = io.StringIO()
    with redirect_stdout(buf):
        rc = cli_main(list(args))
    assert rc == 0, args
    if args[0] == "scan":
        return None
    return json.loads(buf.getvalue())


def heading(title: str) -> None:
    print(f"\n=== {title} ===")


def main() -> int:
    data_root = Path(sys.argv[1]) if len(sys.argv) > 1 else Path(
        tempfile.mkdtemp(prefix="coldstore-demo-")
    )
    if data_root.exists():
        shutil.rmtree(data_root)
    inbox = data_root / "inbox"
    inbox.mkdir(parents=True)

    # --- 42 arrives while 41 is still uploading -------------------------
    drop_batch(inbox, "gw-7", 42, {"readings.csv": b"sensor,temp\n42,-18\n"})
    # a half-uploaded pair for 41 (ZIP only) and a damaged batch 40
    (inbox / "gw-7_batch41.zip").write_bytes(b"PK\x03\x04 partial upload")
    drop_batch(inbox, "gw-7", 40, {"bad.csv": b"x"})
    (inbox / "gw-7_batch40.zip").write_bytes(b"broken zip")
    cli("scan", "--root", str(data_root), "--once", "--stable-seconds", "0")

    heading("after 42 received, 41 half-uploaded, 40 damaged")
    print("status      :", json.dumps(cli("status", "--root", str(data_root)),
                                     ensure_ascii=False))
    print("missing 41  :", json.dumps(cli("list-missing", "--root", str(data_root))))
    print("bad 40      :", json.dumps(cli("list-bad", "--root", str(data_root))))
    gaps = cli("list-gaps", "--root", str(data_root))
    print("gap count   :", len(gaps), "(batches 1..39)")
    visible = sorted(p.name for p in (data_root / "published").glob("gw-7/*"))
    print("published   :", visible, "<- 42 is invisible downstream")

    # --- repair and fill the run ----------------------------------------
    (inbox / "gw-7_batch41.zip").unlink()
    for no in range(1, 40):
        drop_batch(inbox, "gw-7", no, {f"f{no}.csv": f"data-{no}".encode()})
    drop_batch(inbox, "gw-7", 40, {"readings.csv": b"sensor,temp\n40,-18\n"})
    drop_batch(inbox, "gw-7", 41, {"readings.csv": b"sensor,temp\n41,-18\n"})
    cli("scan", "--root", str(data_root), "--once", "--stable-seconds", "0")

    heading("after the full run arrives")
    status = cli("status", "--root", str(data_root))[0]
    print("status      :", json.dumps(status, ensure_ascii=False))
    assert status["published"] == 42 and status["next_expected_batch"] == 43
    visible = sorted(p.name for p in (data_root / "published" / "gw-7").iterdir())
    print("published   :", visible[:3], "...", visible[-2:])
    receipt_41 = cli("receipt", "--root", str(data_root),
                     "--gateway", "gw-7", "--batch", "41")
    print("receipt 41  :", receipt_41["receipt_id"], receipt_41["status"])

    # --- duplicate vs conflict -------------------------------------------
    time.sleep(0.01)
    drop_batch(inbox, "gw-7", 41, {"readings.csv": b"sensor,temp\n41,-18\n"})
    # same file names, different bytes -> different content hash
    drop_batch(inbox, "gw-7", 42, {"readings.csv": b"sensor,temp\n42,-99\n"})
    cli("scan", "--root", str(data_root), "--once", "--stable-seconds", "0")

    heading("retransmissions: 41 identical, 42 changed")
    dups = cli("list-duplicates", "--root", str(data_root))
    print("duplicates  :", json.dumps(dups, ensure_ascii=False))
    conflicts = cli("list-conflicts", "--root", str(data_root))
    print("conflicts   :", json.dumps(conflicts, ensure_ascii=False))
    assert (data_root / "published" / "gw-7" / "batch42" / "readings.csv").read_bytes() \
        == b"sensor,temp\n42,-18\n", "published batch must stay immutable"

    # --- restart: rebuild from published directories ---------------------
    heading("simulated restart (new process scan)")
    # a fresh interpreter pointing at the package by absolute path
    rc = subprocess.run(
        [sys.executable, "-I", str(ROOT / "coldstore"), "scan",
         "--root", str(data_root), "--once"],
        cwd=ROOT, capture_output=True, text=True,
    )
    assert rc.returncode == 0, rc.stderr
    post = cli("status", "--root", str(data_root))[0]
    print("status      :", json.dumps(post, ensure_ascii=False))
    # 41 batches remain published; batch 42 is a conflict (not published),
    # so the next expected batch is held at 42
    assert post["published"] == 41 and post["conflict"] == 1
    assert post["next_expected_batch"] == 42
    # the original published batch 42 is untouched
    assert (data_root / "published" / "gw-7" / "batch42" / "readings.csv") \
        .read_bytes() == b"sensor,temp\n42,-18\n"

    print("\nDEMO OK — data left at:", data_root)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
