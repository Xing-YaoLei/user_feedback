"""协议与领域规则测试（无需 broker）。"""
import pytest

from mqtt_telemetry.protocol import (
    ProtocolError, parse_payload, to_canonical,
)


def make_raw(boot="b1", seq=1, ts=1000.0, value=21.0, unit="degC"):
    import json
    return json.dumps({"boot_id": boot, "seq": seq, "device_ts": ts,
                       "value": value, "unit": unit}).encode()


def test_parse_topic_and_payload():
    m = parse_payload("telemetry/dev-1/up", make_raw(), retained=False)
    assert m.device_id == "dev-1"
    assert m.identity == ("dev-1", "b1", 1)
    assert m.unit == "degC"


def test_bad_topic_rejected():
    with pytest.raises(ProtocolError):
        parse_payload("other/dev-1/up", make_raw())


def test_bad_json_rejected():
    with pytest.raises(ProtocolError):
        parse_payload("telemetry/dev-1/up", b"not-json")


def test_unknown_unit_rejected():
    with pytest.raises(ProtocolError):
        parse_payload("telemetry/dev-1/up", make_raw(unit="parsec"))


def test_seq_must_be_positive():
    with pytest.raises(ProtocolError):
        parse_payload("telemetry/dev-1/up", make_raw(seq=0))


def test_canonical_conversion_temperature():
    v, u = to_canonical(32.0, "degF")
    assert u == "degC"
    assert v == pytest.approx(0.0)
    v2, _ = to_canonical(273.15, "kelvin")
    assert v2 == pytest.approx(0.0)


def test_canonical_conversion_pressure_and_ratio():
    v, u = to_canonical(1.0, "kPa")
    assert (u, v) == ("hPa", pytest.approx(10.0))
    v, u = to_canonical(0.5, "ratio")
    assert (u, v) == ("percent", pytest.approx(50.0))
