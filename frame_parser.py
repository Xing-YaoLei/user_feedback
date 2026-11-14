"""Streaming parser for mixed legacy/new kiln-probe serial recordings.

Frame formats (all numeric fields little-endian, temperature in 0.1 C):

  legacy: AA 55 | seq u32 | temp i16 | crc32 u32      (crc over seq+temp, 6 bytes)
  v2:     AA 56 | len u16 | payload  | crc32 u32      (crc over len+payload)
          payload = 1..64 samples, each = seq u32 | temp i16 (6 bytes)

CRC32 is the standard zlib/PNG CRC-32 (poly 0xEDB88320, init/xorout 0xFFFFFFFF).

Usage:
    python3 frame_parser.py recording.bin [out.jsonl]

The parser is chunk-size invariant: feeding the same recording byte-by-byte,
in arbitrary chunks, or all at once yields the same events in the same order.
"""

import json
import struct
import sys
import zlib

PREFIX = 0xAA
LEGACY_MAGIC = 0x55
V2_MAGIC = 0x56

LEGACY_FRAME_LEN = 12            # 2 hdr + 4 seq + 2 temp + 4 crc
V2_LEN_FIELD = 2
V2_CRC_LEN = 4
SAMPLE_LEN = 6                   # seq u32 + temp i16
V2_MAX_PAYLOAD = 64 * SAMPLE_LEN

MOD = 1 << 32
HALF = 1 << 31


class FrameParser:
    """Incremental parser. feed() bytes, finish() at end of stream.

    Both return a list of event dicts (JSON-serializable) in stream order:
      - {"type": "sample", ...}        one per valid sample
      - {"type": "frame_error", ...}   bad length / CRC mismatch
      - {"type": "truncated", ...}     incomplete candidate at end of stream
    """

    def __init__(self):
        self._buf = bytearray()
        self._base = 0            # absolute stream offset of self._buf[0]
        self._last_seq = None     # last accepted (baseline) sample sequence

    def feed(self, data):
        """Consume a chunk of bytes; return events completed by it."""
        if data:
            self._buf += data
        return self._process(final=False)

    def finish(self):
        """Flush at end of stream. Reports truncated candidates and keeps
        scanning past them for complete frames hidden in the tail."""
        return self._process(final=True)

    # -- sequence number tracking -------------------------------------------

    def _sample_event(self, frame_offset, frame_type, sample_index, seq, temp_raw):
        ev = {
            "type": "sample",
            "seq": seq,
            "temp_c": round(temp_raw * 0.1, 1),
            "frame_offset": frame_offset,
            "frame_type": frame_type,
            "sample_index": sample_index,
        }
        if self._last_seq is None:
            ev["seq_status"] = "initial"
            self._last_seq = seq
            return ev
        diff = (seq - self._last_seq) % MOD
        if diff == 0:
            # duplicate: keep the sample, do not advance the baseline
            ev["seq_status"] = "duplicate"
        elif diff < HALF:
            if diff == 1:
                ev["seq_status"] = "ok"
            else:
                ev["seq_status"] = "gap"
                ev["gap"] = {
                    "after": self._last_seq,
                    "skipped_from": (self._last_seq + 1) % MOD,
                    "skipped_to": (seq - 1) % MOD,
                    "skipped": diff - 1,
                }
            self._last_seq = seq
        else:
            # regression: keep the sample, do not advance the baseline
            ev["seq_status"] = "regression"
        return ev

    # -- byte stream scanning ------------------------------------------------

    def _process(self, final):
        events = []
        buf = self._buf
        n = len(buf)
        i = 0
        while i < n:
            j = buf.find(PREFIX, i)
            if j < 0:
                i = n
                break
            if j + 1 >= n:
                # lone 0xAA at the end of the buffer
                if final:
                    events.append({
                        "type": "truncated",
                        "offset": self._base + j,
                        "frame_type": None,
                        "reason": "incomplete_header",
                        "available_bytes": 1,
                    })
                    i = j + 1
                    continue
                i = j
                break
            kind = buf[j + 1]
            if kind == LEGACY_MAGIC:
                if j + LEGACY_FRAME_LEN <= n:
                    frame = bytes(buf[j:j + LEGACY_FRAME_LEN])
                    crc_expect = struct.unpack_from("<I", frame, 8)[0]
                    if zlib.crc32(frame[2:8]) == crc_expect:
                        seq, temp = struct.unpack_from("<Ih", frame, 2)
                        events.append(self._sample_event(
                            self._base + j, "legacy", 0, seq, temp))
                        i = j + LEGACY_FRAME_LEN
                    else:
                        events.append({
                            "type": "frame_error",
                            "offset": self._base + j,
                            "frame_type": "legacy",
                            "reason": "crc_mismatch",
                        })
                        # rescan from the byte after this candidate's header:
                        # a good frame may start inside its claimed range
                        i = j + 1
                    continue
                if final:
                    events.append({
                        "type": "truncated",
                        "offset": self._base + j,
                        "frame_type": "legacy",
                        "reason": "incomplete_frame",
                        "expected_bytes": LEGACY_FRAME_LEN,
                        "available_bytes": n - j,
                    })
                    i = j + 1
                    continue
                i = j
                break
            if kind == V2_MAGIC:
                if j + 4 > n:
                    if final:
                        events.append({
                            "type": "truncated",
                            "offset": self._base + j,
                            "frame_type": "v2",
                            "reason": "incomplete_header",
                            "available_bytes": n - j,
                        })
                        i = j + 1
                        continue
                    i = j
                    break
                plen = struct.unpack_from("<H", buf, j + 2)[0]
                if (plen < SAMPLE_LEN or plen > V2_MAX_PAYLOAD
                        or plen % SAMPLE_LEN != 0):
                    events.append({
                        "type": "frame_error",
                        "offset": self._base + j,
                        "frame_type": "v2",
                        "reason": "invalid_length",
                        "length": plen,
                    })
                    i = j + 1
                    continue
                need = 2 + V2_LEN_FIELD + plen + V2_CRC_LEN
                if j + need <= n:
                    frame = bytes(buf[j:j + need])
                    crc_expect = struct.unpack_from("<I", frame, 4 + plen)[0]
                    if zlib.crc32(frame[2:4 + plen]) == crc_expect:
                        for k in range(plen // SAMPLE_LEN):
                            seq, temp = struct.unpack_from(
                                "<Ih", frame, 4 + k * SAMPLE_LEN)
                            events.append(self._sample_event(
                                self._base + j, "v2", k, seq, temp))
                        i = j + need
                    else:
                        events.append({
                            "type": "frame_error",
                            "offset": self._base + j,
                            "frame_type": "v2",
                            "reason": "crc_mismatch",
                        })
                        i = j + 1
                    continue
                if final:
                    events.append({
                        "type": "truncated",
                        "offset": self._base + j,
                        "frame_type": "v2",
                        "reason": "incomplete_frame",
                        "expected_bytes": need,
                        "available_bytes": n - j,
                    })
                    i = j + 1
                    continue
                i = j
                break
            # 0xAA not followed by a known magic: skip the prefix byte
            i = j + 1
        del buf[:i]
        self._base += i
        return events


def parse_bytes(data, chunk_size=None):
    """Parse a whole recording; chunk_size=None parses it in one shot."""
    parser = FrameParser()
    events = []
    if chunk_size is None:
        events.extend(parser.feed(data))
    else:
        for off in range(0, len(data), chunk_size):
            events.extend(parser.feed(data[off:off + chunk_size]))
    events.extend(parser.finish())
    return events


def main(argv):
    if len(argv) < 2:
        print(__doc__.strip(), file=sys.stderr)
        return 2
    src = argv[1]
    dst = argv[2] if len(argv) > 2 else None
    out = open(dst, "w") if dst else sys.stdout
    try:
        parser = FrameParser()
        with open(src, "rb") as f:
            while True:
                chunk = f.read(65536)
                if not chunk:
                    break
                for ev in parser.feed(chunk):
                    out.write(json.dumps(ev, ensure_ascii=False) + "\n")
        for ev in parser.finish():
            out.write(json.dumps(ev, ensure_ascii=False) + "\n")
    finally:
        if dst:
            out.close()
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
