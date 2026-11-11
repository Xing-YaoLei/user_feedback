"""Domain model.

The domain is a three-level tree *with sharing*:

    Institution 1 -- * Experiment * -- * Observation

The experiment/observation relation is many-to-many.  An observation is one
shared node that can be linked from several experiments; the links themselves
are stored separately from the nodes (see :mod:`graphql_harvest.collector.store`).
"""

from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class Institution:
    id: str
    name: str
    kind: str = "inst"


@dataclass(frozen=True)
class Experiment:
    id: str
    name: str
    institution_id: str
    kind: str = "exp"


@dataclass(frozen=True)
class Observation:
    id: str
    name: str
    value: float
    measured_at: str
    kind: str = "obs"
