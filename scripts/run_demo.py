"""端到端演示场景（配合 scripts/start_broker.sh 与采集服务使用）。

建议先启动采集器：
  scripts/start_broker.sh
  .venv/bin/python -m mqtt_telemetry.collector_app --db data/demo.db
另开终端运行：
  .venv/bin/python scripts/run_demo.py

场景覆盖：
- dev-A：发 4 条 -> 【采集器离线】期间设备继续发（broker 持久会话排队）
  -> 设备重启（新 boot_id，seq 从 1 重用）-> 单位 degC->degF
  -> 【采集器恢复】积压补投；验证重连后身份幂等与重启 seq 重用的区分。
- dev-B：重复投递 + 第 3 条时钟回拨 60s。
- dev-C：在采集器离线窗口发布 retained，恢复订阅时应识别为快照而非新测量。

采集器进程是独立进程，本脚本通过 /api/state 读取其统计；离线/恢复需要
在采集器终端用 Ctrl-C 之外的方式控制，因此本脚本默认采用“进程内演示”：
直接在本进程内嵌一个 Collector，可精确控制 loop_stop / reconnect。
"""
from __future__ import annotations

import logging
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from mqtt_telemetry.collector import Collector
from mqtt_telemetry.config import BrokerConfig, CollectorConfig, DeviceConfig
from mqtt_telemetry.simulator import DeviceSimulator
from mqtt_telemetry.storage import Storage

logging.basicConfig(level=logging.INFO,
                    format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("demo")


def wait_measurements(storage: Storage, expected: int, timeout: float = 8.0) -> bool:
    deadline = time.time() + timeout
    while time.time() < deadline:
        if storage.stats()["measurements_total"] >= expected:
            return True
        time.sleep(0.1)
    return False


def main() -> None:
    broker = BrokerConfig()
    storage = Storage("data/demo.db")
    collector = Collector(
        broker,
        CollectorConfig(queue_max=256, db_path="data/demo.db", web_port=8090),
        storage,
    )
    collector.start()
    time.sleep(1.0)
    assert collector.counters.connected, "采集器连不上 broker，先跑 scripts/start_broker.sh"

    cfg_a = DeviceConfig(broker=broker, interval=0.3)
    a = DeviceSimulator("dev-A", cfg_a, unit="degC")
    cfg_b = DeviceConfig(broker=broker, interval=0.3, duplicate_prob=0.8,
                         clock_skew_schedule={3: -60.0})
    b = DeviceSimulator("dev-B", cfg_b, unit="degC")
    for sim in (a, b):
        sim.wait_online()

    log.info("== 阶段1: dev-A/dev-B 各发 4 条（dev-B 含重复与时钟回拨）==")
    for _ in range(4):
        a.tick()
        b.tick()
        time.sleep(0.3)
    assert wait_measurements(storage, 8), storage.stats()

    log.info("== 阶段2: 采集器网络停摆（loop_stop），设备继续工作 ==")
    collector.client.loop_stop()
    collector.counters.connected = False
    time.sleep(0.3)

    log.info("== 阶段3: 离线期间 dev-A 重启（新 boot_id，seq 重用）并发 3 条 ==")
    a.restart()
    for i in range(3):
        if i == 1:
            a.unit = "degF"  # 重启后的新周期切换单位
        a.tick()
        time.sleep(0.3)
    b.tick()  # dev-B 也在离线窗口发一条

    log.info("== 阶段4: 离线窗口发布一条 retained（dev-C 首次出现）==")
    import json
    import paho.mqtt.client as mqtt
    snap = mqtt.Client(callback_api_version=mqtt.CallbackAPIVersion.VERSION2,
                       client_id="dev-C-retained")
    snap.connect(broker.host, broker.port)
    snap.loop_start()
    snap.publish(
        "telemetry/dev-C/up",
        json.dumps({"boot_id": "boot-c-snap", "seq": 1,
                    "device_ts": time.time(), "value": 55.2, "unit": "percent"}),
        qos=1, retain=True,
    ).wait_for_publish(timeout=3)
    snap.loop_stop()
    snap.disconnect()

    offline_total = storage.stats()["measurements_total"]
    log.info("离线期间库内测量数保持 %d 不变", offline_total)

    log.info("== 阶段5: 采集器恢复，reconnect + loop_start，持久会话补投 ==")
    collector.client.reconnect()
    collector.client.loop_start()
    deadline = time.time() + 8
    while time.time() < deadline and not collector.counters.connected:
        time.sleep(0.1)
    assert collector.counters.connected

    log.info("== 阶段6: 恢复后 dev-A 再发 2 条 ==")
    for _ in range(2):
        a.tick()
        time.sleep(0.3)
    time.sleep(1.5)

    stats = storage.stats()
    log.info("最终统计: %s", stats)
    assert stats["duplicates"] >= 1, "dev-B 的重复投递应被识别"
    assert stats["anomalies"] >= 3, "应包含重启/单位/回拨异常"

    rows = storage.recent_measurements(limit=100)
    # retained 快照可能已被同身份在线消息转正；两种形态都证明快照逻辑生效
    assert any(
        r["status"] == "retained_snapshot"
        or "retained_snapshot_promoted" in r["flags"]
        for r in rows
    ), "dev-C 的 retained 消息应先按快照处理"
    restarts = [r for r in rows
                if r["device_id"] == "dev-A" and "device_restart" in r["flags"]]
    assert restarts, "dev-A 应存在 device_restart 标记"
    log.info("重启记录: device=%s 新boot=%s seq=%d（seq 在新 boot 内合法重用）",
             restarts[0]["device_id"], restarts[0]["boot_id"][:8], restarts[0]["seq"])
    # 重启后两个 boot 周期各自拥有 seq=1，互不冲突
    assert storage.identity_exists("dev-A", a.boot_id, 1)
    assert any(r["device_id"] == "dev-A" and r["seq"] == 1
               and r["boot_id"] != a.boot_id for r in rows)

    for sim in (a, b):
        sim.stop()
    collector.stop()
    log.info("演示结束。可用 sqlite3 data/demo.db 查看数据，或重新启动采集器看面板")


if __name__ == "__main__":
    main()
