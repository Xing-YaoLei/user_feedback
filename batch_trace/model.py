"""Data model for batch tracing."""

from __future__ import annotations

from dataclasses import dataclass, field
from fractions import Fraction


@dataclass(frozen=True, slots=True)
class PurchaseRecord:
    batch_id: str
    weight_kg: Fraction


@dataclass(frozen=True, slots=True)
class Flow:
    batch_id: str
    weight_kg: Fraction


@dataclass(frozen=True, slots=True)
class OrderRecord:
    order_id: str
    inputs: tuple[Flow, ...]
    outputs: tuple[Flow, ...]
    loss_kg: Fraction

    @property
    def input_kg(self) -> Fraction:
        return sum((f.weight_kg for f in self.inputs), Fraction(0))

    @property
    def output_kg(self) -> Fraction:
        return sum((f.weight_kg for f in self.outputs), Fraction(0))


@dataclass
class Issue:
    issue_id: str
    kind: str
    message: str
    batch_id: str | None = None
    order_id: str | None = None
    details: dict = field(default_factory=dict)
    affected_products: list[dict] = field(default_factory=list)

    def to_dict(self) -> dict:
        out: dict = {
            "id": self.issue_id,
            "type": self.kind,
            "message": self.message,
        }
        if self.batch_id is not None:
            out["batch_id"] = self.batch_id
        if self.order_id is not None:
            out["order_id"] = self.order_id
        out.update(self.details)
        out["affected_products"] = self.affected_products
        return out


class InputError(Exception):
    """A fatal problem in the input files (bad row/field), not a tracing issue."""
