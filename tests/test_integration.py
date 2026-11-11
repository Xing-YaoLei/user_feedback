"""端到端集成测试：真实 mosquitto broker + 模拟器 + 采集器。

需要本机已装 mosquitto 且端口可用；未检测到 broker 时整模块 skip。
每个测试使用独立端口与独立 DB，互不干扰。

覆盖需求：
- 重连前后记录身份一致（持久会话补投 -> duplicate_network，不产生第二条）；
- 设备重启后 seq 重用被识别为新测量而非重复；
- 单位转换在真实链路中正确落库；
- 缺口统计正确；
- retained 消息在首次订阅时按快照处理；
- 背压过载事件可观测。
"""
from __future__ import annotations

import json
import shutil
import socket
import subprocess
import time
import uuid

import pytest

from mqtt_telemetry.collector import Collector
from mqtt_telemetry.config import BrokerConfig, CollectorConfig, DeviceConfig
from mqtt_telemetry.simulator import DeviceSimulator
from mqtt_telemetry.storage import Storage

pytestmark = pytest.mark.skipif(
    shutil.which("mosquitto") is None, reason="本机未安装 mosquitto"
)


def _free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


@pytest.fixture()
def broker(tmp_path):
    port = _free_port()
    conf = tmp_path / "mosq.conf"
    conf.write_text(
        f"listener {port} 127.0.0.1\n"
        "allow_anonymous true\n"
        f"persistence true\npersistence_location {tmp_path}/mosq/\n"
        "max_queued_messages 5000\n"
    )
    proc = subprocess.Popen(
        ["mosquitto", "-c", str(conf)],
        stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True,
    )
    deadline = time.time() + 5
    while time.time() < deadline:
        with socket.socket() as s:
            if s.connect_ex(("127.0.0.1", port)) == 0:
                break
        time.sleep(0.1)
    else:
        proc.terminate()
        pytest.fail("mosquitto 未能在 5s 内就绪")
    yield port
    proc.terminate()
    proc.wait(timeout=5)


@pytest.fixture()
def pipeline(tmp_path, broker):
    db = tmp_path / f"t-{uuid.uuid4().hex[:6]}.db"
    storage = Storage(str(db))
    bc = BrokerConfig(port=broker, client_id=f"col-{uuid.uuid4().hex[:8]}")
    cfg = CollectorConfig(queue_max=128, db_path=str(db))
    collector = Collector(bc, cfg, storage)
    collector.start()
    deadline = time.time() + 5
    while not collector.counters.connected and time.time() < deadline:
        time.sleep(0.05)
    yield collector, storage
    collector.stop()


def wait_until(predicate, timeout=8.0, interval=0.1):
    deadline = time.time() + timeout
    while time.time() < deadline:
        if predicate():
            return True
        time.sleep(interval)
    return False


def make_sim(device_id, port, **kw):
    cfg = DeviceConfig(broker=BrokerConfig(port=port), interval=0.05, **kw)
    sim = DeviceSimulator(device_id, cfg)
    assert sim.wait_online(timeout=5)
    return sim


def test_basic_pipeline_and_identity_across_reconnect(pipeline, broker):
    """重连前后身份一致：补投只增加 dup_count，测量不新增。"""
    collector, storage = pipeline
    sim = make_sim("dev-x", broker)
    for _ in range(5):
        sim.tick()
        time.sleep(0.05)
    assert wait_until(lambda: storage.stats()["measurements_total"] == 5)

    # 模拟采集器网络停摆：停掉 paho 网络循环（设备与 broker 仍正常），
    # 设备继续发，broker 因 clean_session=false 为离线客户端缓存 QoS1 消息
    collector.client.loop_stop()
    collector.counters.connected = False
    for _ in range(3):
        sim.tick()
        time.sleep(0.05)
    time.sleep(0.5)
    # 离线期间新测量尚未入库
    assert storage.stats()["measurements_total"] == 5

    # 网络恢复：重建连接，持久会话补投 3 条
    collector.client.reconnect()
    collector.client.loop_start()
    assert wait_until(lambda: collector.counters.connected)
    assert wait_until(lambda: storage.stats()["measurements_total"] == 8)

    # 重连后再发同身份报文（显式重发最后一条）-> 网络重复
    last = json.dumps({
        "boot_id": sim.boot_id, "seq": sim.seq,
        "device_ts": time.time(), "value": 1.0, "unit": "degC",
    })
    sim.client.publish(sim.topic, last, qos=1).wait_for_publish(timeout=3)
    assert wait_until(lambda: storage.stats()["duplicates"] >= 1)
    assert storage.stats()["measurements_total"] == 8  # 身份不变，不新增
    assert storage.identity_exists("dev-x", sim.boot_id, sim.seq)
    sim.stop()


def test_restart_seq_reuse_distinguished_from_duplicate(pipeline, broker):
    collector, storage = pipeline
    sim = make_sim("dev-r", broker)
    for _ in range(3):
        sim.tick()
        time.sleep(0.05)
    assert wait_until(lambda: storage.stats()["measurements_total"] == 3)
    boot1 = sim.boot_id

    sim.restart()  # 新 boot_id，seq 归 1
    for _ in range(2):
        sim.tick()
        time.sleep(0.05)
    assert wait_until(
        lambda: storage.stats()["measurements_total"] == 5)

    # 两个 boot 周期都各自拥有 seq=1，且都只入库一次
    assert storage.identity_exists("dev-r", boot1, 1)
    assert storage.identity_exists("dev-r", sim.boot_id, 1)
    rows = storage.recent_measurements(limit=20)
    restart_rows = [r for r in rows
                    if r["boot_id"] == sim.boot_id and "device_restart" in r["flags"]]
    assert restart_rows and restart_rows[0]["seq"] == 1
    sim.stop()


def test_unit_conversion_over_real_link(pipeline, broker):
    collector, storage = pipeline
    sim = make_sim("dev-u", broker, unit_schedule={2: "degF"})
    sim.tick()  # seq1 degC
    time.sleep(0.05)
    sim.tick()  # seq2 degF
    assert wait_until(lambda: storage.stats()["measurements_total"] == 2)
    rows = {r["seq"]: r for r in storage.recent_measurements(limit=10)}
    assert rows[1]["unit"] == "degC"
    assert rows[2]["unit"] == "degF"
    assert rows[2]["canonical_unit"] == "degC"
    # F -> C 折算正确
    assert rows[2]["canonical_value"] == pytest.approx(
        rows[2]["value"] * 5 / 9 - 32 * 5 / 9, rel=1e-9)
    assert "unit_switched" in rows[2]["flags"]
    sim.stop()


def test_gap_statistics(pipeline, broker):
    collector, storage = pipeline
    sim = make_sim("dev-g", broker)
    sim.tick()  # seq1
    time.sleep(0.05)
    # 跳过 2,3,4，直接发 seq5
    for _ in range(3):
        sim.seq += 1  # 消耗序号但不发布
    sim.tick()      # seq5
    assert wait_until(lambda: len(storage.gaps()) == 1)
    gap = storage.gaps()[0]
    assert gap["missing_count"] == 3
    assert gap["expected_seq"] == 2 and gap["observed_seq"] == 5
    sim.stop()


def test_retained_message_treated_as_snapshot(broker, tmp_path):
    """采集器订阅前 broker 上已存在 retained；新采集器订阅即收到快照。"""
    import paho.mqtt.client as mqtt
    # 1) 预置 retained 消息（此时还没有任何采集器订阅）
    pub = mqtt.Client(callback_api_version=mqtt.CallbackAPIVersion.VERSION2,
                      client_id=f"pre-{uuid.uuid4().hex[:6]}")
    pub.connect("127.0.0.1", broker)
    pub.loop_start()
    payload = json.dumps({"boot_id": "boot-snap", "seq": 99,
                          "device_ts": time.time(), "value": 1.5,
                          "unit": "degC"})
    pub.publish("telemetry/dev-snap/up", payload, qos=1, retain=True
                ).wait_for_publish(timeout=3)
    pub.loop_stop()
    pub.disconnect()
    time.sleep(0.3)

    # 2) 新采集器启动并订阅 -> 立即收到 retained，按快照处理
    db = tmp_path / "snap.db"
    storage = Storage(str(db))
    bc = BrokerConfig(port=broker, client_id=f"snap-{uuid.uuid4().hex[:8]}")
    collector = Collector(bc, CollectorConfig(queue_max=64, db_path=str(db)), storage)
    collector.start()
    try:
        assert wait_until(lambda: collector.counters.connected)
        assert wait_until(lambda: storage.stats()["snapshots"] == 1)
        assert storage.stats()["measurements_total"] == 0  # 快照不算新测量

        # 3) 设备真实上线，同 seq 不同 boot -> 新测量，快照行被转正
        sim = make_sim("dev-snap", broker)
        sim.boot_id = "boot-live"
        sim.tick()
        assert wait_until(lambda: storage.stats()["measurements_total"] == 1)
        sim.stop()
    finally:
        collector.stop()


def test_backpressure_overload_is_recorded(broker, tmp_path):
    """队列容量 1：高速发布必然出现过载丢弃，overload_events 有明确记录。"""
    storage = Storage(str(tmp_path / "bp.db"))
    bc = BrokerConfig(port=broker, client_id=f"bp-{uuid.uuid4().hex[:8]}")
    collector = Collector(bc, CollectorConfig(queue_max=1, db_path=str(tmp_path / "bp.db")),
                          storage)
    collector.start()
    try:
        assert wait_until(lambda: collector.counters.connected)
        sims = [make_sim(f"bp-{i}", broker) for i in range(3)]
        for _ in range(40):
            for s in sims:
                s.tick()
        assert wait_until(lambda: storage.stats()["overload_events"] > 0, timeout=10)
        for s in sims:
            s.stop()
    finally:
        collector.stop()
