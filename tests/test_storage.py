"""存储层语义测试：身份去重、重启 seq 重用、retained、单位、回拨、缺口、背压。"""
import json

import pytest

from mqtt_telemetry.protocol import Measurement
from mqtt_telemetry.storage import Storage


def meas(device="d1", boot="b1", seq=1, ts=1000.0, value=20.0,
         unit="degC", retained=False):
    return Measurement(
        device_id=device, boot_id=boot, seq=seq, device_ts=ts, value=value,
        unit=unit, retained=retained, topic=f"telemetry/{device}/up",
        raw=json.dumps({"boot_id": boot, "seq": seq}),
    )


@pytest.fixture()
def store(tmp_path):
    return Storage(str(tmp_path / "t.db"))


def test_new_measurement_ok(store):
    r = store.ingest(meas(seq=1))
    assert r.kind == "new"
    assert r.flags == []
    row = store.recent_measurements()[0]
    assert row["status"] == "ok"
    assert row["canonical_unit"] == "degC"


def test_network_duplicate_same_identity(store):
    store.ingest(meas(seq=1))
    r2 = store.ingest(meas(seq=1))  # 三元组完全一致
    assert r2.kind == "duplicate_network"
    r3 = store.ingest(meas(seq=1, retained=True))
    assert r3.kind == "duplicate_network"
    assert "retained" in r3.flags
    assert store.stats()["measurements_total"] == 1  # 不新增测量行
    assert store.stats()["duplicates"] == 2


def test_restart_seq_reuse_is_legitimate_new_measurement(store):
    store.ingest(meas(boot="b1", seq=1))
    store.ingest(meas(boot="b1", seq=2))
    # 设备重启：新 boot_id，seq 又从 1 开始
    r = store.ingest(meas(boot="b2", seq=1))
    assert r.kind == "new"
    assert "device_restart" in r.flags
    assert store.identity_exists("d1", "b2", 1)
    assert store.stats()["measurements_total"] == 3
    # 同一 boot 内 seq=1 仍然只能存在一条
    assert store.ingest(meas(boot="b2", seq=1)).kind == "duplicate_network"


def test_retained_snapshot_not_counted_as_new(store):
    r = store.ingest(meas(seq=5, retained=True))
    assert r.kind == "retained_snapshot"
    stats = store.stats()
    assert stats["snapshots"] == 1
    assert stats["measurements_total"] == 0
    # 同身份在线消息到达：快照行转正为正式测量，不新增行
    r2 = store.ingest(meas(seq=5, retained=False))
    assert r2.kind == "new"
    assert "retained_snapshot_promoted" in r2.flags
    stats2 = store.stats()
    assert stats2["measurements_total"] == 1
    assert stats2["snapshots"] == 0  # 占位快照已转正
    # 转正后写入设备状态；此后再发同身份就是网络重复
    assert store.ingest(meas(seq=5)).kind == "duplicate_network"


def test_retained_after_seen_device_is_flagged_not_snapshot(store):
    store.ingest(meas(seq=1))
    r = store.ingest(meas(seq=2, retained=True))
    assert r.kind == "new"
    assert "retained_redelivery" in r.flags
    assert store.stats()["snapshots"] == 0


def test_seq_gap_recorded(store):
    store.ingest(meas(seq=1))
    r = store.ingest(meas(seq=4))  # 缺 2,3
    assert r.kind == "new"
    assert r.gap_missing == 2
    gaps = store.gaps()
    assert len(gaps) == 1
    assert gaps[0]["missing_count"] == 2
    assert gaps[0]["expected_seq"] == 2
    assert store.stats()["gap_missing_total"] == 2


def test_unit_switch_preserves_original_and_canonical(store):
    store.ingest(meas(seq=1, value=20.0, unit="degC"))
    r = store.ingest(meas(seq=2, value=68.0, unit="degF"))
    assert "unit_switched" in r.flags
    rows = {x["seq"]: x for x in store.recent_measurements()}
    row = rows[2]
    # 原值原单位原样保留
    assert (row["value"], row["unit"]) == (68.0, "degF")
    # 同时给出折算后的标准值 68F = 20C
    assert row["canonical_value"] == pytest.approx(20.0)
    assert row["canonical_unit"] == "degC"
    assert "单位切换" in row["explanation"]


def test_clock_skew_preserves_original_ts(store):
    store.ingest(meas(seq=1, ts=1000.0))
    r = store.ingest(meas(seq=2, ts=940.0))  # 回拨 60s
    assert "clock_skew" in r.flags
    row = store.recent_measurements()[0]
    assert row["device_ts"] == 940.0  # 原始设备时间不被改写
    assert "时钟回拨" in row["explanation"]


def test_combined_flags_on_one_message(store):
    store.ingest(meas(boot="b1", seq=1, ts=1000.0, unit="degC"))
    r = store.ingest(meas(boot="b2", seq=1, ts=900.0, value=50.0,
                          unit="degF"))
    assert "device_restart" in r.flags
    assert "clock_skew" in r.flags
    assert "unit_switched" in r.flags


def test_overload_event_recorded(store):
    store.record_overload(queue_size=256, identity="d1/b1/9")
    events = store.overloads()
    assert len(events) == 1
    assert events[0]["identity"] == "d1/b1/9"
    assert store.stats()["overload_events"] == 1


def test_devices_isolated(store):
    store.ingest(meas(device="x", boot="bx", seq=1))
    store.ingest(meas(device="y", boot="by", seq=1))
    store.ingest(meas(device="x", boot="bx", seq=2))
    # x 的 seq=5 -> x 有缺口；y 不受影响
    store.ingest(meas(device="x", boot="bx", seq=5))
    gaps = store.gaps()
    assert all(g["device_id"] == "x" for g in gaps)
    assert {d["device_id"] for d in store.devices()} == {"x", "y"}


def test_boot_change_resets_gap_detection(store):
    store.ingest(meas(boot="b1", seq=10))
    # 换 boot 后 seq 从 1 起，不应误报缺口
    r = store.ingest(meas(boot="b2", seq=1))
    assert r.gap_missing == 0
    assert store.gaps() == []
