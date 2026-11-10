"""Shared pytest fixtures."""

from __future__ import annotations

import pytest

from nested2arrow.contract import Contract, MergePolicy
from nested2arrow.contract import ConflictPolicy


@pytest.fixture
def contract() -> Contract:
    return Contract(batch_max_records=4)


@pytest.fixture
def quarantine_contract() -> Contract:
    return Contract(
        batch_max_records=4,
        merge=MergePolicy(
            scalar_string=ConflictPolicy.QUARANTINE,
            bool_number=ConflictPolicy.QUARANTINE,
            struct_shape=ConflictPolicy.QUARANTINE,
            int_to_float=ConflictPolicy.QUARANTINE,
            decimal_to_float=ConflictPolicy.QUARANTINE,
            float_to_decimal=ConflictPolicy.QUARANTINE,
            string_timestamp=ConflictPolicy.QUARANTINE,
            new_field_after_first_batch=ConflictPolicy.QUARANTINE,
        ),
    )
