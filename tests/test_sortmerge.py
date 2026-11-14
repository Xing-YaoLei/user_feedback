"""Unit tests for the external merge sort and record encoding."""

from __future__ import annotations

import random
import shutil
import tempfile
import unittest
from pathlib import Path

from reconcile.records import (
    ManifestRecord,
    TargetRecord,
    decode_key,
    decode_manifest,
    decode_target,
    encode_manifest,
    encode_target,
    split_key,
)
from reconcile.sortmerge import external_sort


class RecordEncodingTest(unittest.TestCase):
    def test_manifest_round_trip(self) -> None:
        record = ManifestRecord("k", "s1", 123456789, "a" * 64)
        payload = encode_manifest(record)
        self.assertEqual(decode_manifest(payload), record)
        self.assertEqual(decode_key(split_key(payload)), "k")

    def test_target_round_trip(self) -> None:
        record = TargetRecord("k/中", 99, "b" * 64)
        payload = encode_target(record)
        self.assertEqual(decode_target(payload), record)
        self.assertEqual(decode_key(split_key(payload)), "k/中")

    def test_encoding_order_is_field_order(self) -> None:
        smaller = encode_manifest(ManifestRecord("a", "s1", 1, "a" * 64))
        bigger_key = encode_manifest(ManifestRecord("b", "s0", 9, "z" * 64))
        bigger_source = encode_manifest(
            ManifestRecord("a", "s2", 9, "z" * 64)
        )
        self.assertLess(smaller, bigger_key)
        self.assertLess(smaller, bigger_source)

    def test_size_is_zero_padded_so_numeric_order_matches_bytes(self) -> None:
        small = encode_target(TargetRecord("k", 9, "a" * 64))
        large = encode_target(TargetRecord("k", 10, "a" * 64))
        self.assertLess(small, large)


class ExternalSortTest(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = Path(tempfile.mkdtemp(prefix="reconcile-sort-test-"))

    def tearDown(self) -> None:
        shutil.rmtree(self.tmp, ignore_errors=True)

    def _records(self, n: int) -> list[bytes]:
        return [
            encode_target(
                TargetRecord(f"key-{i:06d}", i, f"{(i * 7) % 997:064x}")
            )
            for i in range(n)
        ]

    def test_in_memory_path_sorted(self) -> None:
        records = self._records(500)
        random.Random(5).shuffle(records)
        result = list(
            external_sort(iter(records), str(self.tmp), "t", 1 << 20, 8)
        )
        self.assertEqual(result, sorted(records))
        self.assertEqual(list(self.tmp.glob("*.run")), [])

    def test_spilled_multi_pass_sort_sorted_and_deterministic(self) -> None:
        records = self._records(2000)
        expected = sorted(records)
        baseline = None
        for seed in (1, 2):
            shuffled = records[:]
            random.Random(seed).shuffle(shuffled)
            subdir = self.tmp / f"pass{seed}"
            subdir.mkdir()
            # 4 KiB chunks force many runs; fan-in 4 forces repeated merges.
            result = list(
                external_sort(
                    iter(shuffled), str(subdir), "s", 4096, 4
                )
            )
            self.assertEqual(result, expected)
            if baseline is None:
                baseline = result
            else:
                self.assertEqual(result, baseline)
            # All intermediate run files are removed.
            self.assertEqual(list(subdir.glob("*.run")), [])

    def test_duplicates_are_preserved(self) -> None:
        records = self._records(10) * 3
        random.Random(9).shuffle(records)
        result = list(
            external_sort(iter(records), str(self.tmp), "d", 2048, 4)
        )
        self.assertEqual(len(result), 30)
        self.assertEqual(result, sorted(records))


if __name__ == "__main__":
    unittest.main()
