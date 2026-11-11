"""Deterministic in-memory dataset backing the demo GraphQL service.

Counts (chosen so every connection spans several pages with pageSize=5):

* 6 institutions; one of them (``inst-6``) owns **zero** experiments -> empty connection
* 11 experiments; one (``exp-11``) has **zero** observations -> empty connection
* 20 unique observations, 46 experiment/observation links
* several observations are shared by 2-3 experiments (many-to-many)

Ordering is stable (id order) so cursors and checkpoints are reproducible.
"""

from __future__ import annotations

from ..models import Experiment, Institution, Observation

INSTITUTIONS: list[Institution] = [
    Institution("inst-1", "Alpha Institute"),
    Institution("inst-2", "Beta Institute"),
    Institution("inst-3", "Gamma Institute"),
    Institution("inst-4", "Delta Institute"),
    Institution("inst-5", "Epsilon Institute"),
    Institution("inst-6", "Zeta Institute (empty)"),
]

EXPERIMENTS: list[Experiment] = [
    Experiment("exp-1", "Catalyst Screening A", "inst-1"),
    Experiment("exp-2", "Catalyst Screening B", "inst-1"),
    Experiment("exp-3", "Thermal Cycling", "inst-2"),
    Experiment("exp-4", "Spectroscopy Run", "inst-2"),
    Experiment("exp-5", "Pressure Decay", "inst-3"),
    Experiment("exp-6", "Long Exposure", "inst-3"),
    Experiment("exp-7", "Pilot Reactor", "inst-4"),
    Experiment("exp-8", "Control Group", "inst-4"),
    Experiment("exp-9", "Field Sampling", "inst-5"),
    Experiment("exp-10", "Calibration", "inst-5"),
    Experiment("exp-11", "Dry Run (no observations)", "inst-5"),
]

# id, name, value, measured_at
_RAW_OBSERVATIONS: list[tuple[str, str, float, str]] = [
    ("obs-01", "baseline temperature", 20.1, "2026-01-05T09:00:00Z"),
    ("obs-02", "peak temperature", 73.4, "2026-01-05T09:15:00Z"),
    ("obs-03", "pressure sample 1", 1.02, "2026-01-06T10:00:00Z"),
    ("obs-04", "pressure sample 2", 1.05, "2026-01-06T10:30:00Z"),
    ("obs-05", "ph reading", 7.1, "2026-01-07T08:00:00Z"),
    ("obs-06", "conductivity", 0.82, "2026-01-07T08:20:00Z"),
    ("obs-07", "mass before", 12.50, "2026-01-08T11:00:00Z"),
    ("obs-08", "mass after", 11.97, "2026-01-08T14:00:00Z"),
    ("obs-09", "flow rate", 3.30, "2026-01-09T09:00:00Z"),
    ("obs-10", "turbidity", 4.2, "2026-01-09T09:45:00Z"),
    ("obs-11", "absorbance 450nm", 0.31, "2026-01-10T12:00:00Z"),
    ("obs-12", "absorbance 600nm", 0.18, "2026-01-10T12:05:00Z"),
    ("obs-13", "vibration rms", 0.07, "2026-01-11T07:30:00Z"),
    ("obs-14", "noise floor", 12.0, "2026-01-11T07:31:00Z"),
    ("obs-15", "humidity", 44.0, "2026-01-12T13:00:00Z"),
    ("obs-16", "dew point", 9.8, "2026-01-12T13:05:00Z"),
    ("obs-17", "voltage", 5.02, "2026-01-13T10:00:00Z"),
    ("obs-18", "current", 0.41, "2026-01-13T10:01:00Z"),
    ("obs-19", "gas chromatogram", 0.66, "2026-01-14T15:00:00Z"),
    ("obs-20", "residual mass", 0.53, "2026-01-14T16:30:00Z"),
]

OBSERVATIONS: list[Observation] = [
    Observation(oid, name, value, ts) for oid, name, value, ts in _RAW_OBSERVATIONS
]

# experiment_id -> ordered list of observation ids.
# Shared observations deliberately appear under multiple experiments.
EXPERIMENT_OBSERVATIONS: dict[str, list[str]] = {
    "exp-1": ["obs-01", "obs-02", "obs-05", "obs-11", "obs-12", "obs-19"],
    "exp-2": ["obs-01", "obs-03", "obs-04", "obs-07", "obs-08"],
    "exp-3": ["obs-03", "obs-04", "obs-09", "obs-10"],
    "exp-4": ["obs-11", "obs-12", "obs-13", "obs-14", "obs-15"],
    "exp-5": ["obs-05", "obs-06", "obs-16", "obs-17", "obs-18", "obs-20"],
    "exp-6": ["obs-02", "obs-15", "obs-16", "obs-17"],
    "exp-7": ["obs-07", "obs-08", "obs-09", "obs-19", "obs-20"],
    "exp-8": ["obs-06", "obs-10", "obs-13", "obs-18"],
    "exp-9": ["obs-14", "obs-15", "obs-19"],
    "exp-10": ["obs-20", "obs-17", "obs-11", "obs-05"],
    "exp-11": [],
}

INSTITUTION_EXPERIMENTS: dict[str, list[str]] = {}
for _e in EXPERIMENTS:
    INSTITUTION_EXPERIMENTS.setdefault(_e.institution_id, []).append(_e.id)
INSTITUTION_EXPERIMENTS.setdefault("inst-6", [])


class Dataset:
    """Read-only lookup facade over the in-memory tables."""

    def __init__(self) -> None:
        self.institutions = {i.id: i for i in INSTITUTIONS}
        self.experiments = {e.id: e for e in EXPERIMENTS}
        self.observations = {o.id: o for o in OBSERVATIONS}
        self.institution_experiments = {
            k: list(v) for k, v in INSTITUTION_EXPERIMENTS.items()
        }
        self.experiment_observations = {
            k: list(v) for k, v in EXPERIMENT_OBSERVATIONS.items()
        }
        # reverse link: observation -> experiments that reference it
        self.observation_experiments: dict[str, list[str]] = {}
        for exp_id, obs_ids in EXPERIMENT_OBSERVATIONS.items():
            for obs_id in obs_ids:
                self.observation_experiments.setdefault(obs_id, []).append(exp_id)

    def get_institution(self, node_id: str) -> Institution | None:
        return self.institutions.get(node_id)

    def get_experiment(self, node_id: str) -> Experiment | None:
        return self.experiments.get(node_id)

    def get_observation(self, node_id: str) -> Observation | None:
        return self.observations.get(node_id)

    def experiment_ids_of(self, institution_id: str) -> list[str]:
        return list(self.institution_experiments.get(institution_id, []))

    def observation_ids_of(self, experiment_id: str) -> list[str]:
        return list(self.experiment_observations.get(experiment_id, []))

    def experiment_ids_of_observation(self, observation_id: str) -> list[str]:
        return list(self.observation_experiments.get(observation_id, []))


_DATASET: Dataset | None = None


def dataset() -> Dataset:
    global _DATASET
    if _DATASET is None:
        _DATASET = Dataset()
    return _DATASET
