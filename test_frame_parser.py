"""Tests for frame_parser. Run: python3 -m unittest test_frame_parser -v"""

import json
import random
import struct
import unittest
import zlib

from frame_parser import FrameParser, parse_bytes


def legacy_frame(seq, temp):
    body = struct.pack("<Ih", seq, temp)
    return b"\xAA\x55" + body + struct.pack("<I", zlib.crc32(body))


def v2_frame(samples):
    payload = b"".join(struct.pack("<Ih", s, t) for s, t in samples)
    body = struct.pack("<H", len(payload)) + payload
    return b"\xAA\x56" + body + struct.pack("<I", zlib.crc32(body))


def corrupt_crc(frame):
    return frame[:-4] + struct.pack("<I", struct.unpack("<I", frame[-4:])[0] ^ 0xFF)


def samples_of(events):
    return [e for e in events if e["type"] == "sample"]


class TestFrames(unittest.TestCase):
    def test_legacy_frame(self):
        events = parse_bytes(legacy_frame(42, 256))
        self.assertEqual(len(events), 1)
        ev = events[0]
        self.assertEqual(ev["type"], "sample")
        self.assertEqual(ev["seq"], 42)
        self.assertEqual(ev["temp_c"], 25.6)
        self.assertEqual(ev["frame_offset"], 0)
        self.assertEqual(ev["frame_type"], "legacy")
        self.assertEqual(ev["sample_index"], 0)
        self.assertEqual(ev["seq_status"], "initial")

    def test_legacy_negative_temp(self):
        (ev,) = parse_bytes(legacy_frame(1, -250))
        self.assertEqual(ev["temp_c"], -25.0)

    def test_v2_frame_multiple_samples(self):
        frame = v2_frame([(10, 100), (11, 110), (12, 120)])
        events = parse_bytes(frame)
        self.assertEqual(len(events), 3)
        for k, ev in enumerate(events):
            self.assertEqual(ev["frame_type"], "v2")
            self.assertEqual(ev["frame_offset"], 0)
            self.assertEqual(ev["sample_index"], k)
            self.assertEqual(ev["seq"], 10 + k)
            self.assertEqual(ev["temp_c"], 10.0 + k)

    def test_v2_max_payload(self):
        frame = v2_frame([(i, 0) for i in range(64)])
        events = parse_bytes(frame)
        self.assertEqual(len(samples_of(events)), 64)

    def test_mixed_frames_with_noise(self):
        stream = (b"\x00\x01" + legacy_frame(1, 0) + b"\xAA\x99"
                  + v2_frame([(2, 10), (3, 20)]) + legacy_frame(4, 30))
        events = parse_bytes(stream)
        seqs = [e["seq"] for e in samples_of(events)]
        self.assertEqual(seqs, [1, 2, 3, 4])
        offsets = [e["frame_offset"] for e in samples_of(events)]
        self.assertEqual(offsets, [2, 16, 16, 36])

    def test_bad_crc_rescans_inside_claimed_range(self):
        good = legacy_frame(7, 200)
        # bad legacy candidate at 0; a complete good frame starts at offset 3
        for fill in range(256):
            stream = b"\xAA\x55" + bytes([fill]) + good
            cand = stream[:12]
            if zlib.crc32(cand[2:8]) != struct.unpack("<I", cand[8:12])[0]:
                break
        else:
            self.fail("could not build a failing candidate")
        events = parse_bytes(stream)
        self.assertEqual(events[0]["type"], "frame_error")
        self.assertEqual(events[0]["offset"], 0)
        self.assertEqual(events[0]["reason"], "crc_mismatch")
        self.assertEqual(events[1]["type"], "sample")
        self.assertEqual(events[1]["frame_offset"], 3)
        self.assertEqual(events[1]["seq"], 7)

    def test_v2_bad_crc(self):
        events = parse_bytes(corrupt_crc(v2_frame([(5, 50)])))
        self.assertEqual(len(events), 1)
        self.assertEqual(events[0]["reason"], "crc_mismatch")
        self.assertEqual(events[0]["frame_type"], "v2")

    def test_v2_invalid_lengths(self):
        for plen in (0, 5, 7, 385, 1000):
            stream = b"\xAA\x56" + struct.pack("<H", plen) + b"\x00" * 8
            events = parse_bytes(stream)
            errs = [e for e in events if e.get("reason") == "invalid_length"]
            self.assertTrue(errs, plen)
            self.assertEqual(errs[0]["length"], plen)

    def test_truncated_tail_then_hidden_frame(self):
        # v2 candidate claims 36 payload bytes but the file ends early;
        # a complete legacy frame hides inside its claimed range
        stream = b"\xAA\x56\x24\x00" + legacy_frame(3, 100)
        events = parse_bytes(stream)
        self.assertEqual(events[0]["type"], "truncated")
        self.assertEqual(events[0]["offset"], 0)
        self.assertEqual(events[0]["frame_type"], "v2")
        self.assertEqual(events[0]["expected_bytes"], 44)
        self.assertEqual(events[0]["available_bytes"], 16)
        self.assertEqual(events[1]["type"], "sample")
        self.assertEqual(events[1]["frame_offset"], 4)
        self.assertEqual(events[1]["seq"], 3)

    def test_truncated_legacy_and_lone_prefix(self):
        events = parse_bytes(legacy_frame(9, 0)[:7])
        self.assertEqual(len(events), 1)
        self.assertEqual(events[0]["type"], "truncated")
        self.assertEqual(events[0]["frame_type"], "legacy")
        self.assertEqual(events[0]["available_bytes"], 7)

        events = parse_bytes(b"\x01\x02\xAA")
        self.assertEqual(len(events), 1)
        self.assertEqual(events[0]["type"], "truncated")
        self.assertEqual(events[0]["offset"], 2)
        self.assertIsNone(events[0]["frame_type"])

    def test_truncated_v2_header_only(self):
        events = parse_bytes(b"\xAA\x56\x0C")
        self.assertEqual(events[0]["type"], "truncated")
        self.assertEqual(events[0]["reason"], "incomplete_header")


class TestSequenceTracking(unittest.TestCase):
    def statuses(self, seqs):
        stream = b"".join(legacy_frame(s, 0) for s in seqs)
        return parse_bytes(stream)

    def test_gap_duplicate_regression(self):
        events = self.statuses([1, 5, 5, 0, 6])
        st = [e["seq_status"] for e in events]
        self.assertEqual(st, ["initial", "gap", "duplicate", "regression", "ok"])
        gap = events[1]["gap"]
        self.assertEqual(gap["after"], 1)
        self.assertEqual(gap["skipped_from"], 2)
        self.assertEqual(gap["skipped_to"], 4)
        self.assertEqual(gap["skipped"], 3)
        # duplicate and regression kept their samples but did not move baseline
        self.assertEqual(events[2]["seq"], 5)
        self.assertEqual(events[3]["seq"], 0)
        # baseline was still 5 after the regression, so 6 is a plain advance
        self.assertEqual(events[4]["seq_status"], "ok")

    def test_wraparound(self):
        events = self.statuses([0xFFFFFFFE, 0xFFFFFFFF, 0, 1])
        self.assertEqual([e["seq_status"] for e in events],
                         ["initial", "ok", "ok", "ok"])

    def test_wraparound_gap(self):
        events = self.statuses([0xFFFFFFFF, 2])
        self.assertEqual(events[1]["seq_status"], "gap")
        gap = events[1]["gap"]
        self.assertEqual(gap["skipped_from"], 0)
        self.assertEqual(gap["skipped_to"], 1)
        self.assertEqual(gap["skipped"], 2)

    def test_duplicate_at_wrap(self):
        events = self.statuses([0xFFFFFFFF, 0xFFFFFFFF])
        self.assertEqual(events[1]["seq_status"], "duplicate")


class TestChunkInvariance(unittest.TestCase):
    def build_stream(self):
        parts = [
            b"\xDE\xAD",                       # noise
            legacy_frame(100, 210),
            v2_frame([(101, 220), (102, 230), (103, 240)]),
            corrupt_crc(legacy_frame(104, 0)),  # bad CRC -> rescan
            legacy_frame(104, 250),             # same seq as baseline? gap path
            b"\xAA\x56\x12\x00",               # truncated v2 candidate at tail
            legacy_frame(105, 260),             # hidden inside its range
            b"\xAA",                            # lone prefix at EOF
        ]
        return b"".join(parts)

    def test_chunk_sizes_give_identical_events(self):
        stream = self.build_stream()
        reference = parse_bytes(stream)
        for size in (1, 2, 3, 5, 7, 13, 64):
            with self.subTest(size=size):
                self.assertEqual(parse_bytes(stream, size), reference)

    def test_random_chunking(self):
        stream = self.build_stream()
        reference = parse_bytes(stream)
        rng = random.Random(20261114)
        parser = FrameParser()
        events = []
        i = 0
        while i < len(stream):
            step = rng.randint(1, 17)
            events.extend(parser.feed(stream[i:i + step]))
            i += step
        events.extend(parser.finish())
        self.assertEqual(events, reference)

    def test_tail_events(self):
        events = parse_bytes(self.build_stream())
        kinds = [e["type"] for e in events]
        self.assertIn("frame_error", kinds)
        self.assertIn("truncated", kinds)
        truncated = [e for e in events if e["type"] == "truncated"]
        self.assertEqual(len(truncated), 2)  # v2 candidate + lone 0xAA
        # the frame hidden in the truncated candidate's range is still found
        seqs = [e["seq"] for e in samples_of(events)]
        self.assertEqual(seqs, [100, 101, 102, 103, 104, 105])

    def test_json_serializable(self):
        for ev in parse_bytes(self.build_stream()):
            json.dumps(ev)


if __name__ == "__main__":
    unittest.main()
