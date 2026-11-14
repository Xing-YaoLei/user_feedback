"""批次来源追溯测试。"""

from __future__ import annotations

import json
import subprocess
import sys
import tempfile
import unittest
from fractions import Fraction
from pathlib import Path

from batch_trace import (
    Flow,
    InputError,
    OrderRecord,
    PurchaseRecord,
    build_engine,
    load_orders,
    load_purchases,
    round_kg,
)

ROOT = Path(__file__).resolve().parent.parent


def P(batch_id: str, weight: str | int) -> PurchaseRecord:
    return PurchaseRecord(batch_id, Fraction(str(weight)))


def O(
    order_id: str,
    inputs: list[tuple[str, str | int]],
    outputs: list[tuple[str, str | int]],
    loss: str | int = 0,
) -> OrderRecord:
    return OrderRecord(
        order_id,
        tuple(Flow(b, Fraction(str(w))) for b, w in inputs),
        tuple(Flow(b, Fraction(str(w))) for b, w in outputs),
        Fraction(str(loss)),
    )


def contrib(result: dict) -> dict[str, float]:
    return {c["purchase_batch_id"]: c["weight_kg"] for c in result["contributions"]}


class BaseTracingTests(unittest.TestCase):
    def test_six_four_split_applies_to_every_output(self) -> None:
        engine = build_engine(
            [P("P001", 100), P("P002", 80)],
            [O("M-01", [("P001", 60), ("P002", 40)], [("A1", 30), ("A2", 60)], 10)],
        )
        self.assertEqual(contrib(engine.query("A1")), {"P001": 18.0, "P002": 12.0})
        self.assertEqual(contrib(engine.query("A2")), {"P001": 36.0, "P002": 24.0})

    def test_partial_withdrawal_takes_origin_proportionally(self) -> None:
        engine = build_engine(
            [P("P001", 100), P("P002", 80)],
            [
                O("M-01", [("P001", 60), ("P002", 40)], [("A1", 30), ("A2", 60)], 10),
                O("M-02", [("A1", 10)], [("B1", 9)], 1),
            ],
        )
        a1 = engine.query("A1", basis="remaining")
        self.assertEqual(a1["remaining_kg"], 20.0)
        self.assertEqual(contrib(a1), {"P001": 12.0, "P002": 8.0})
        self.assertEqual(contrib(engine.query("B1")), {"P001": 5.4, "P002": 3.6})

    def test_default_basis_is_full_output(self) -> None:
        engine = build_engine(
            [P("P001", 100), P("P002", 80)],
            [
                O("M-01", [("P001", 60), ("P002", 40)], [("A1", 30), ("A2", 60)], 10),
                O("M-02", [("A1", 10)], [("B1", 9)], 1),
            ],
        )
        a1 = engine.query("A1")
        self.assertEqual(a1["basis"], "produced")
        self.assertEqual(a1["accounted_kg"], 30.0)
        self.assertEqual(contrib(a1), {"P001": 18.0, "P002": 12.0})
        self.assertEqual(a1["remaining_kg"], 20.0)

    def test_basis_produced_reports_full_output(self) -> None:
        engine = build_engine(
            [P("P001", 100), P("P002", 80)],
            [
                O("M-01", [("P001", 60), ("P002", 40)], [("A1", 30), ("A2", 60)], 10),
                O("M-02", [("A1", 10)], [("B1", 9)], 1),
            ],
        )
        self.assertEqual(contrib(engine.query("A1", basis="produced")), {"P001": 18.0, "P002": 12.0})

    def test_multi_round_chain_with_withdrawals(self) -> None:
        engine = build_engine(
            [P("P001", 100), P("P002", 80)],
            [
                O("M-01", [("P001", 60), ("P002", 40)], [("A1", 30), ("A2", 60)], 10),
                O("M-02", [("A1", 10)], [("B1", 9)], 1),
                O("M-03", [("A2", 20)], [("C1", 19)], 1),
                O("M-04", [("C1", 5)], [("D1", 4)], 1),
            ],
        )
        self.assertEqual(contrib(engine.query("D1")), {"P001": 2.4, "P002": 1.6})
        c1 = engine.query("C1", basis="remaining")
        self.assertEqual(c1["remaining_kg"], 14.0)
        self.assertEqual(contrib(c1), {"P001": 8.4, "P002": 5.6})
        self.assertEqual(contrib(engine.query("C1")), {"P001": 11.4, "P002": 7.6})

    def test_rounding_to_three_decimals(self) -> None:
        engine = build_engine(
            [P("P003", 50), P("P004", 40)],
            [O("M-05", [("P003", 50), ("P004", 40)], [("E1", 87)], 3)],
        )
        result = engine.query("E1")
        self.assertEqual(contrib(result), {"P003": 48.333, "P004": 38.667})

    def test_order_order_does_not_matter(self) -> None:
        purchases = [P("P001", 100), P("P002", 80)]
        orders = [
            O("M-01", [("P001", 60), ("P002", 40)], [("A1", 30), ("A2", 60)], 10),
            O("M-02", [("A1", 10)], [("B1", 9)], 1),
            O("M-03", [("A2", 20)], [("C1", 19)], 1),
        ]
        forwards = build_engine(purchases, orders).query("C1")
        backwards = build_engine(purchases, list(reversed(orders))).query("C1")
        self.assertEqual(forwards["contributions"], backwards["contributions"])
        self.assertEqual(forwards["remaining_kg"], backwards["remaining_kg"])

    def test_exact_mixture_ratios_survive_multiple_rounds(self) -> None:
        engine = build_engine(
            [P("X", 1), P("Y", 2)],
            [
                O("M1", [("X", 1), ("Y", 2)], [("T", 3)], 0),
                O("M2", [("T", 1)], [("U", 1)], 0),
            ],
        )
        result = engine.query("U")
        self.assertEqual(result["status"], "ok")
        relative = {c["purchase_batch_id"]: c["weight_kg"] for c in result["contributions"]}
        self.assertEqual(relative, {"X": 0.333, "Y": 0.667})


class IssueDetectionTests(unittest.TestCase):
    def test_missing_batch_taints_downstream_only(self) -> None:
        engine = build_engine(
            [P("P001", 100)],
            [
                O("M-01", [("P001", 50), ("GHOST", 50)], [("A1", 99)], 1),
                O("M-02", [("A1", 10)], [("B1", 9)], 1),
                O("M-03", [("P001", 10)], [("C1", 9)], 1),
            ],
        )
        kinds = [i.kind for i in engine.issues]
        self.assertIn("missing-batch", kinds)
        self.assertEqual(engine.query("A1")["status"], "affected")
        self.assertEqual(engine.query("B1")["status"], "affected")
        self.assertEqual(engine.query("C1")["status"], "ok")
        self.assertEqual(contrib(engine.query("C1")), {"P001": 9.0})
        missing = [i for i in engine.issues if i.kind == "missing-batch"][0]
        self.assertEqual(missing.batch_id, "GHOST")
        self.assertEqual({p["batch_id"] for p in missing.affected_products}, {"A1", "B1"})
        affected = engine.query("B1")
        self.assertEqual(affected["chain"][0]["id"], "GHOST")
        self.assertIn("缺失批号", affected["chain_text"])

    def test_duplicate_source_taints_all_candidates(self) -> None:
        engine = build_engine(
            [P("DUP", 10), P("DUP", 20)],
            [O("M-01", [("DUP", 5)], [("A1", 4)], 1)],
        )
        dup = [i for i in engine.issues if i.kind == "duplicate-source"][0]
        self.assertEqual(len(dup.details["claims"]), 2)
        self.assertEqual(engine.query("A1")["status"], "affected")
        self.assertEqual(dup.affected_products[0]["batch_id"], "A1")
        self.assertIn("来源重复", dup.affected_products[0]["chain"][0]["reason"])

    def test_duplicate_produced_batch_id(self) -> None:
        engine = build_engine(
            [P("P001", 100)],
            [
                O("M-01", [("P001", 50)], [("A1", 49)], 1),
                O("M-02", [("P001", 50)], [("A1", 49)], 1),
            ],
        )
        self.assertEqual([i.kind for i in engine.issues], ["duplicate-source"])

    def test_cycle_is_detected_and_contained(self) -> None:
        engine = build_engine(
            [P("P001", 100)],
            [
                O("M-01", [("A1", 5)], [("B1", 5)], 0),
                O("M-02", [("B1", 5)], [("A1", 5)], 0),
                O("M-04", [("P001", 10)], [("C1", 9)], 1),
            ],
        )
        cycle = [i for i in engine.issues if i.kind == "cycle"][0]
        self.assertEqual([i.kind for i in engine.issues], ["cycle"])
        self.assertEqual(cycle.details["orders"], ["M-01", "M-02"])
        self.assertEqual(cycle.details["cycle_path"], ["M-01", "M-02", "M-01"])
        self.assertEqual(cycle.details["batch_ids"], ["A1", "B1"])
        self.assertEqual(engine.query("A1")["status"], "affected")
        self.assertEqual(engine.query("B1")["status"], "affected")
        self.assertEqual(engine.query("C1")["status"], "ok")
        self.assertEqual(contrib(engine.query("C1")), {"P001": 9.0})
        b1 = engine.query("B1")
        self.assertIn("M-01 → 加工单 M-02", b1["chain_text"])
        self.assertIn("循环引用", b1["chain_text"])

    def test_imbalance_taints_order_outputs(self) -> None:
        engine = build_engine(
            [P("P001", 100)],
            [
                O("M-01", [("P001", 50)], [("A1", 49)], 0),
                O("M-02", [("P001", 10)], [("C1", 9)], 1),
            ],
        )
        imbalance = [i for i in engine.issues if i.kind == "imbalance"][0]
        self.assertEqual(imbalance.order_id, "M-01")
        self.assertEqual(imbalance.details["difference_kg"], 1.0)
        self.assertEqual(engine.query("A1")["status"], "affected")
        self.assertEqual(contrib(engine.query("C1")), {"P001": 9.0})

    def test_cross_order_over_withdrawal(self) -> None:
        engine = build_engine(
            [P("P001", 10)],
            [
                O("M-01", [("P001", 8)], [("A1", 8)], 0),
                O("M-02", [("P001", 5)], [("C1", 5)], 0),
            ],
        )
        over = [i for i in engine.issues if i.kind == "over-withdrawal"][0]
        self.assertEqual(over.batch_id, "P001")
        self.assertEqual(over.details["excess_kg"], 3.0)
        self.assertEqual(engine.query("A1")["status"], "affected")
        self.assertEqual(engine.query("C1")["status"], "affected")

    def test_exact_withdrawal_is_not_an_issue(self) -> None:
        engine = build_engine(
            [P("P001", 10)],
            [
                O("M-01", [("P001", 6)], [("A1", 6)], 0),
                O("M-02", [("P001", 4)], [("C1", 4)], 0),
                O("M-03", [("A1", 6)], [("D1", 6)], 0),
            ],
        )
        self.assertEqual(engine.issues, [])
        self.assertEqual(engine.query("D1")["status"], "ok")
        screen = engine.query("P001")
        self.assertEqual(screen["status"], "ok")
        self.assertEqual(screen["remaining_kg"], 0.0)

    def test_problem_products_excluded_others_computed(self) -> None:
        engine = build_engine(
            [P("P001", 100), P("P002", 100)],
            [
                O("M-01", [("P001", 50), ("NOPE", 50)], [("A1", 99)], 1),
                O("M-02", [("P002", 60)], [("B1", 55)], 5),
            ],
        )
        report = engine.report()
        self.assertEqual(report["summary"]["computed_products"], 1)
        self.assertEqual([p["batch_id"] for p in report["products"]], ["B1"])
        self.assertEqual(contrib(report["products"][0]), {"P002": 55.0})

    def test_issue_ids_are_stable_and_traceable(self) -> None:
        engine = build_engine(
            [P("P001", 100), P("DUP", 1), P("DUP", 2)],
            [
                O("M-01", [("GHOST", 10)], [("A1", 10)], 0),
                O("M-02", [("DUP", 5)], [("B1", 5)], 0),
            ],
        )
        ids = [i.issue_id for i in engine.issues]
        self.assertEqual(ids, [f"I{n:03d}" for n in range(1, len(ids) + 1)])
        for item in engine.report()["tainted_batches"]:
            self.assertIn(item["issue_id"], ids)
            self.assertTrue(item["chain_text"])

    def test_unknown_batch(self) -> None:
        engine = build_engine([P("P001", 10)], [])
        result = engine.query("NOPE")
        self.assertEqual(result["status"], "unknown")

    def test_batch_can_be_affected_by_multiple_issues(self) -> None:
        engine = build_engine(
            [P("P001", 100)],
            [
                O("M-01", [("P001", 50)], [("A1", 49)], 0),
                O("M-02", [("A1", 10)], [("B1", 9)], 0),
                O("M-03", [("A1", 10)], [("C1", 9)], 0),
            ],
        )
        self.assertEqual([i.kind for i in engine.issues], ["imbalance"] * 3)
        a1 = engine.query("A1")
        self.assertEqual(a1["status"], "affected")
        self.assertEqual(a1["issue_id"], "I001")
        b1 = engine.query("B1")
        self.assertEqual(b1["issue_ids"], ["I001", "I002"])
        self.assertEqual(b1["issue_id"], "I001")
        self.assertEqual(b1["chain_text"].split(" → ")[-1], "批号 B1")
        self.assertEqual(
            [p["batch_id"] for p in engine.issues[0].affected_products],
            ["A1", "B1", "C1"],
        )
        self.assertEqual(
            [p["batch_id"] for p in engine.issues[1].affected_products], ["B1"]
        )

    def test_long_chain_is_iterative(self) -> None:
        orders = []
        previous = "P001"
        for n in range(500):
            out = f"S{n:03d}"
            orders.append(O(f"M{n:03d}", [(previous, 1)], [(out, 1)], 0))
            previous = out
        engine = build_engine([P("P001", 1000)], orders)
        self.assertEqual(engine.issues, [])
        result = engine.query(previous)
        self.assertEqual(result["status"], "ok")
        self.assertEqual(contrib(result), {"P001": 1.0})


class LoaderTests(unittest.TestCase):
    def test_chinese_headers_and_alt_keys(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            csv_path = Path(tmp) / "p.csv"
            csv_path.write_text("批号,入库重量\n甲批,60\n乙批,40\n", encoding="utf-8")
            jsonl_path = Path(tmp) / "o.jsonl"
            rows = [
                {
                    "加工单号": "M-01",
                    "投入": [{"批号": "甲批", "重量": 60}, {"批号": "乙批", "重量": 40}],
                    "产出": [{"批号": "A1", "重量": 100}],
                    "损耗": 0,
                }
            ]
            jsonl_path.write_text(
                "\n".join(json.dumps(r, ensure_ascii=False) for r in rows) + "\n",
                encoding="utf-8",
            )
            purchases = load_purchases(csv_path)
            orders = load_orders(jsonl_path)
        self.assertEqual([p.batch_id for p in purchases], ["甲批", "乙批"])
        self.assertEqual(orders[0].inputs[1].weight_kg, Fraction(40))

    def test_missing_header_weight_column(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "bad.csv"
            path.write_text("batch_id\nP001\n", encoding="utf-8")
            with self.assertRaises(InputError):
                load_purchases(path)

    def test_bad_json_line(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "bad.jsonl"
            path.write_text("{not json}\n", encoding="utf-8")
            with self.assertRaises(InputError):
                load_orders(path)

    def test_empty_weight_is_input_error(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "bad.csv"
            path.write_text("batch_id,weight_kg\nP001,\n", encoding="utf-8")
            with self.assertRaises(InputError):
                load_purchases(path)

    def test_round_kg_half_up(self) -> None:
        self.assertEqual(round_kg(Fraction(1, 8000)), 0.0)
        self.assertEqual(round_kg(Fraction(1, 2000)), 0.001)
        self.assertEqual(round_kg(Fraction(-1, 2000)), -0.001)


class CliTests(unittest.TestCase):
    def test_cli_report_and_query(self) -> None:
        cmd = [
            sys.executable,
            "-m",
            "batch_trace",
            "--purchases",
            str(ROOT / "examples" / "purchases.csv"),
            "--orders",
            str(ROOT / "examples" / "orders.jsonl"),
            "--report",
        ]
        proc = subprocess.run(
            cmd, cwd=ROOT, capture_output=True, text=True, check=False
        )
        self.assertEqual(proc.returncode, 0, proc.stderr)
        payload = json.loads(proc.stdout)
        d1 = next(p for p in payload["products"] if p["batch_id"] == "D1")
        self.assertEqual(
            {c["purchase_batch_id"]: c["weight_kg"] for c in d1["contributions"]},
            {"P001": 2.4, "P002": 1.6},
        )
        self.assertEqual(payload["issues"], [])

    def test_cli_on_files_with_issues_returns_one(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            csv_path = Path(tmp) / "p.csv"
            csv_path.write_text("batch_id,weight_kg\nP001,10\n", encoding="utf-8")
            jsonl_path = Path(tmp) / "o.jsonl"
            rows = [
                {"order_id": "M-01", "inputs": [{"batch_id": "P001", "weight_kg": 6}],
                 "outputs": [{"batch_id": "A1", "weight_kg": 6}], "loss_kg": 0},
                {"order_id": "M-02", "inputs": [{"batch_id": "P001", "weight_kg": 5}],
                 "outputs": [{"batch_id": "B1", "weight_kg": 5}], "loss_kg": 0},
            ]
            jsonl_path.write_text(
                "\n".join(json.dumps(r) for r in rows) + "\n", encoding="utf-8"
            )
            cmd = [
                sys.executable, "-m", "batch_trace", "--report",
                "--purchases", str(csv_path), "--orders", str(jsonl_path),
            ]
            proc = subprocess.run(cmd, cwd=ROOT, capture_output=True, text=True, check=False)
        self.assertEqual(proc.returncode, 1)
        payload = json.loads(proc.stdout)
        kinds = {i["type"] for i in payload["issues"]}
        self.assertEqual(kinds, {"over-withdrawal"})
        self.assertEqual(
            {p["batch_id"] for p in payload["issues"][0]["affected_products"]},
            {"A1", "B1"},
        )

    def test_cli_query_unknown_batch_exit_code(self) -> None:
        cmd = [
            sys.executable,
            "-m",
            "batch_trace",
            "NOPE",
            "--purchases",
            str(ROOT / "examples" / "purchases.csv"),
            "--orders",
            str(ROOT / "examples" / "orders.jsonl"),
        ]
        proc = subprocess.run(
            cmd, cwd=ROOT, capture_output=True, text=True, check=False
        )
        self.assertEqual(proc.returncode, 1)
        self.assertEqual(json.loads(proc.stdout)["results"][0]["status"], "unknown")


if __name__ == "__main__":
    unittest.main()
