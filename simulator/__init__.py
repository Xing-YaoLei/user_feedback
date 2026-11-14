"""纸卷检测机模拟器：在固定路径上写 UTF-8 JSONL，并执行轮转。"""

from .machine_sim import PaperRollMachine, Record

__all__ = ["PaperRollMachine", "Record"]
