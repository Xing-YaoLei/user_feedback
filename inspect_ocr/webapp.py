"""本地 Web 校正页面（Flask，仅监听 127.0.0.1）。

功能：
* 列表页：按待确认数量排序；
* 校正页：原图上叠加字段来源多边形，点击字段在侧栏核对/修改，
  可拖拽/点选更新来源坐标并保存；
* 单字段确认、整页重识别（保留人工值）、修订历史查看。
"""

from __future__ import annotations

from pathlib import Path

from flask import Flask, abort, jsonify, render_template, request, send_file

from . import config, database
from .pipeline import page_overall_status, process_image, reprocess

app = Flask(__name__, template_folder=str(Path(__file__).parent / "web" / "templates"),
            static_folder=str(Path(__file__).parent / "web" / "static"))


@app.route("/")
def index():
    return render_template("index.html", pages=database.list_pages())


@app.route("/pages/<page_id>")
def review_page(page_id):
    page = database.load_page(page_id)
    if page is None:
        abort(404)
    return render_template("review.html", page=page,
                           overall=page_overall_status(page))


@app.route("/api/pages")
def api_list():
    return jsonify(database.list_pages())


@app.route("/api/pages/<page_id>")
def api_page(page_id):
    page = database.load_page(page_id)
    if page is None:
        abort(404)
    data = page.to_dict()
    data["overall_status"] = page_overall_status(page)
    data["revisions"] = database.list_revisions(page_id)
    return jsonify(data)


@app.route("/api/pages/<page_id>/image")
def api_image(page_id):
    page = database.load_page(page_id)
    if page is None:
        abort(404)
    if not Path(page.source_path).exists():
        abort(404)
    return send_file(page.source_path, mimetype="image/png")


@app.route("/api/pages/<page_id>/fields/<field_key>", methods=["PUT"])
def api_update_field(page_id, field_key):
    payload = request.get_json(force=True)
    new_value = payload.get("value")
    note = payload.get("note", "")
    polygon = payload.get("source_polygon")
    rev = database.update_field(
        page_id, field_key, new_value,
        note=note, source_polygon=polygon,
    )
    if rev is None:
        abort(404)
    return jsonify(rev.to_dict())


@app.route("/api/pages/<page_id>/fields/<field_key>/confirm", methods=["POST"])
def api_confirm(page_id, field_key):
    rev = database.confirm_field(page_id, field_key)
    if rev is None:
        abort(404)
    return jsonify(rev.to_dict())


@app.route("/api/pages/<page_id>/reprocess", methods=["POST"])
def api_reprocess(page_id):
    page = database.load_page(page_id)
    if page is None:
        abort(404)
    fresh, revisions = reprocess(page)
    database.save_page(fresh)
    for rev in revisions:
        database.add_revision(rev)
    return jsonify({
        "page": fresh.to_dict(),
        "preserved_manual_fields": [r.field_key for r in revisions],
        "reprocessed_count": fresh.reprocessed_count,
    })


@app.route("/api/ingest", methods=["POST"])
def api_ingest():
    """上传/登记一张本地图片并立即采集（multipart 或 JSON 路径）。"""
    if "file" in request.files:
        f = request.files["file"]
        dst = config.IMAGE_DIR / f.filename
        f.save(str(dst))
        path = str(dst)
    else:
        path = request.get_json(force=True).get("path")
    if not path or not Path(path).exists():
        abort(400, "缺少有效图像路径")
    page = process_image(path)
    database.save_page(page)
    return jsonify(page.to_dict())


def main() -> None:
    database.init_db()
    app.run(host="127.0.0.1", port=5050, debug=False)


if __name__ == "__main__":
    main()
