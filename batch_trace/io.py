"""读取采购批次 CSV 与加工单 JSONL。"""

from __future__ import annotations

import csv
import json
from decimal import Decimal, InvalidOperation
from fractions import Fraction
from pathlib import Path

from .model import Flow, InputError, OrderRecord, PurchaseRecord

BATCH_ID_KEYS = ("batch_id", "批号", "batch", "id")
WEIGHT_KEYS = ("weight_kg", "入库重量", "weight", "重量")


def parse_weight(raw: object, where: str) -> Fraction:
    if isinstance(raw, bool) or raw is None:
        raise InputError(f"{where}：重量必须是数字")
    if isinstance(raw, (int, float)):
        try:
            value = Fraction(Decimal(str(raw)))
        except InvalidOperation as exc:
            raise InputError(f"{where}：无法解析重量 {raw!r}") from exc
    elif isinstance(raw, str):
        text = raw.strip()
        if not text:
            raise InputError(f"{where}：重量为空")
        try:
            value = Fraction(Decimal(text))
        except InvalidOperation as exc:
            raise InputError(f"{where}：无法解析重量 {raw!r}") from exc
    else:
        raise InputError(f"{where}：重量必须是数字")
    return value


def _pick(row: dict, keys: tuple[str, ...]) -> object | None:
    for key in keys:
        if key in row and row[key] is not None:
            return row[key]
    return None


def _require_text(row: dict, keys: tuple[str, ...], where: str) -> str:
    value = _pick(row, keys)
    if value is None or not str(value).strip():
        raise InputError(f"{where}：缺少 {keys[0]}")
    return str(value).strip()


def load_purchases(path: str | Path) -> list[PurchaseRecord]:
    path = Path(path)
    records: list[PurchaseRecord] = []
    try:
        handle = path.open("r", encoding="utf-8-sig", newline="")
    except OSError as exc:
        raise InputError(f"无法读取采购批次文件 {path}：{exc}") from exc
    with handle:
        reader = csv.DictReader(handle)
        if not reader.fieldnames:
            raise InputError(f"采购批次文件 {path} 为空或缺少表头")
        reader.fieldnames = [name.strip() for name in reader.fieldnames]
        for lineno, row in enumerate(reader, start=2):
            where = f"{path.name} 第 {lineno} 行"
            batch_id = _require_text(row, BATCH_ID_KEYS, where)
            weight = _pick(row, WEIGHT_KEYS)
            if weight is None:
                raise InputError(f"{where}：缺少入库重量列（weight_kg）")
            records.append(
                PurchaseRecord(batch_id=batch_id, weight_kg=parse_weight(weight, where))
            )
    return records


def _load_flows(raw: object, where: str, kind: str) -> tuple[Flow, ...]:
    if raw is None:
        return ()
    if not isinstance(raw, list):
        raise InputError(f"{where}：{kind} 必须是数组")
    flows = []
    for n, item in enumerate(raw, start=1):
        if not isinstance(item, dict):
            raise InputError(f"{where}：{kind} 第 {n} 项必须是对象")
        batch_id = _require_text(item, BATCH_ID_KEYS, f"{where} 的{kind}第 {n} 项")
        weight = _pick(item, WEIGHT_KEYS)
        if weight is None:
            raise InputError(f"{where}：{kind}第 {n} 项缺少重量（weight_kg）")
        flows.append(
            Flow(batch_id=batch_id, weight_kg=parse_weight(weight, f"{where} 的{kind}第 {n} 项"))
        )
    return tuple(flows)


def load_orders(path: str | Path) -> list[OrderRecord]:
    path = Path(path)
    orders: list[OrderRecord] = []
    try:
        handle = path.open("r", encoding="utf-8-sig")
    except OSError as exc:
        raise InputError(f"无法读取加工单文件 {path}：{exc}") from exc
    with handle:
        for lineno, line in enumerate(handle, start=1):
            text = line.strip()
            if not text:
                continue
            where = f"{path.name} 第 {lineno} 行"
            try:
                raw = json.loads(text)
            except json.JSONDecodeError as exc:
                raise InputError(f"{where}：不是合法 JSON（{exc.msg}）") from exc
            if not isinstance(raw, dict):
                raise InputError(f"{where}：每行必须是一个 JSON 对象")
            order_id = _require_text(raw, ("order_id", "加工单号", "id"), where)
            loss = _pick(raw, ("loss_kg", "loss", "损耗"))
            orders.append(
                OrderRecord(
                    order_id=order_id,
                    inputs=_load_flows(raw.get("inputs", raw.get("投入")), where, "投入"),
                    outputs=_load_flows(raw.get("outputs", raw.get("产出")), where, "产出"),
                    loss_kg=parse_weight(loss, f"{where} 的损耗") if loss is not None else Fraction(0),
                )
            )
    return orders
