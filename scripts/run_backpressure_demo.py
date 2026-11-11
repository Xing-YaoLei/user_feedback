"""背压演示：用极小队列（8）+ 4 台设备高速发布，制造过载丢弃。

随后可以在排障面板看到：
- overload_events 记录每次丢弃（队列大小、被丢身份）；
- 恢复后 seq 缺口统计给出实际缺失条数（缺口才是丢数据的权威口径）。

用法（采集器以小队列启动）：
  .venv/bin/python -m mqtt_telemetry.collector_app --queue-max 8 --db data/bp.db
  .venv/bin/python scripts/run_backpressure_demo.py
"""
from __future__ import annotations

import logging
import sys
import threading
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from mqtt_telemetry.config import BrokerConfig, DeviceConfig
from mqtt_telemetry.simulator import DeviceSimulator

logging.basicConfig(level=logging.INFO,
                    format="%(asctime)s %(levelname)s %(message)s")


def main() -> None:
    broker = BrokerConfig()
    stop = threading.Event()
    sims = []
    for i in range(4):
        cfg = DeviceConfig(broker=broker, interval=0.01, count=0,
                           duplicate_prob=0.1)
        sim = DeviceSimulator(f"bp-{i}", cfg, unit="degC")
        sim.wait_online()
        sims.append(sim)

    threads = [threading.Thread(target=s.run, kwargs={"stop_event": stop},
                                daemon=True) for s in sims]
    for t in threads:
        t.start()
    logging.info("高速发布 8 秒，队列容量仅 8，预期触发过载丢弃…")
    time.sleep(8)
    stop.set()
    for t in threads:
        t.join(timeout=3)
    for s in sims:
        s.stop()
    logging.info("完成，查看面板「过载事件」与「序号缺口」")


if __name__ == "__main__":
    main()
