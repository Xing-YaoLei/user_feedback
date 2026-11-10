"""JSON-path style structural paths.

A path is a tuple of steps. Object steps are ``str`` keys; array steps are the
``INDEX`` sentinel so that ``{"a": [1]}`` and ``{"a": {"0": 1}}`` never collide
and presence sets are unambiguous during round-trip reconstruction.
"""

from __future__ import annotations

from typing import Tuple, Union


class _IndexStep:
    _instance: "_IndexStep|None" = None

    def __new__(cls) -> "_IndexStep":
        if cls._instance is None:
            cls._instance = super().__new__(cls)
        return cls._instance

    def __repr__(self) -> str:
        return "INDEX"

    def __bool__(self) -> bool:
        return False


INDEX = _IndexStep()
Step = Union[str, _IndexStep]
Path = Tuple[Step, ...]
ROOT: Path = ()


def render(path: Path) -> str:
    """Render to a JSONPath-like dotted path, e.g. ``$.items[*].price``."""
    out = "$"
    for step in path:
        if isinstance(step, _IndexStep):
            out += "[*]"
        else:
            out += "." + str(step)
    return out


def child(path: Path, step: Step) -> Path:
    return path + (step,)


def prefix_of(prefix: Path, path: Path) -> bool:
    return path[: len(prefix)] == prefix
