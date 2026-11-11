"""Web 校正页面冒烟测试：路由、字段更新 API、重识别 API。"""

from __future__ import annotations

from inspect_ocr.webapp import app


def _ingest(samples_dir):
    out, _ = samples_dir
    img = sorted(out.glob("*.png"))[0]
    client = app.test_client()
    resp = client.post("/api/ingest", json={"path": str(img)})
    assert resp.status_code == 200
    return client, resp.get_json()["page_id"]


def test_index_and_review_pages(samples_dir, tmp_workspace):
    client, pid = _ingest(samples_dir)
    assert client.get("/").status_code == 200
    r = client.get(f"/pages/{pid}")
    assert r.status_code == 200
    assert "字段校正".encode() in r.data


def test_image_and_api(samples_dir, tmp_workspace):
    client, pid = _ingest(samples_dir)
    assert client.get(f"/api/pages/{pid}/image").status_code == 200
    data = client.get(f"/api/pages/{pid}").get_json()
    assert data["template_id"] in ("A", "B")
    assert "source_polygon" in next(iter(data["fields"].values()))


def test_update_field_via_api(samples_dir, tmp_workspace):
    client, pid = _ingest(samples_dir)
    key = "device_id"
    resp = client.put(f"/api/pages/{pid}/fields/{key}",
                      json={"value": "EQ-222222", "note": "页面修改"})
    assert resp.status_code == 200
    after = client.get(f"/api/pages/{pid}").get_json()
    assert after["fields"][key]["value"] == "EQ-222222"
    assert after["fields"][key]["manual"] is True
    assert any(r["note"] == "页面修改" for r in after["revisions"])


def test_reprocess_api_preserves_manual(samples_dir, tmp_workspace):
    client, pid = _ingest(samples_dir)
    client.put(f"/api/pages/{pid}/fields/remark",
               json={"value": "锁定备注", "note": "重识别前修改"})
    resp = client.post(f"/api/pages/{pid}/reprocess")
    assert resp.status_code == 200
    body = resp.get_json()
    assert "remark" in body["preserved_manual_fields"]
    after = client.get(f"/api/pages/{pid}").get_json()
    assert after["fields"]["remark"]["value"] == "锁定备注"


def test_update_missing_page_404(tmp_workspace):
    client = app.test_client()
    r = client.put("/api/pages/nope/fields/x", json={"value": "v"})
    assert r.status_code == 404
