"""命令行入口：样本生成、批量采集、单页重识别、结构化导出。

示例
----
python -m inspect_ocr.cli generate --count 12 --out data/samples
python -m inspect_ocr.cli collect data/samples --out data/exports
python -m inspect_ocr.cli reprocess <page_id>
python -m inspect_ocr.cli export --format all
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

from . import config, database
from .exporter import export_batch_csv, export_batch_json
from .generate import generate_dataset
from .models import STATUS_NEEDS_REVIEW
from .pipeline import page_overall_status, process_image, reprocess

IMG_SUFFIXES = {".png", ".jpg", ".jpeg", ".tif", ".tiff", ".bmp"}


def cmd_generate(args) -> int:
    metas = generate_dataset(args.out, count=args.count, seed_base=args.seed)
    print(f"已生成 {len(metas)} 张样本 -> {Path(args.out).resolve()}")
    for m in metas[:5]:
        print(" ", m["file"], "空白字段:", m["blanked_fields"])
    if len(metas) > 5:
        print(f"  ... 其余 {len(metas) - 5} 张略")
    return 0


def cmd_collect(args) -> int:
    database.init_db()
    in_dir = Path(args.path)
    images = sorted(p for p in in_dir.rglob("*") if p.suffix.lower() in IMG_SUFFIXES)
    if not images:
        print(f"目录下未找到图像: {in_dir}", file=sys.stderr)
        return 2
    n_review = 0
    for img in images:
        try:
            page = process_image(str(img))
        except Exception as exc:  # 单页失败不阻断批量
            print(f"[失败] {img.name}: {exc}", file=sys.stderr)
            continue
        database.save_page(page)
        flag = "待人工" if page_overall_status(page) == STATUS_NEEDS_REVIEW else "通过"
        if flag == "待人工":
            n_review += 1
        print(f"[{flag}] {img.name} -> 版式={page.template_name} "
              f"字段={len(page.fields)} id={page.page_id[:8]}")
    print(f"\n采集完成：共 {len(images)} 张，其中 {n_review} 张需人工确认。")
    if args.out:
        j = export_batch_json(Path(args.out) / "batch.json")
        c = export_batch_csv(Path(args.out) / "batch.csv")
        print(f"结构化导出: {j}\n            {c}")
    return 0


def cmd_reprocess(args) -> int:
    page = database.load_page(args.page_id)
    if page is None:
        print(f"未找到页面: {args.page_id}", file=sys.stderr)
        return 2
    fresh, revisions = reprocess(page)
    database.save_page(fresh)
    for rev in revisions:
        database.add_revision(rev)
    print(f"重识别完成：保留 {len(revisions)} 个人工确认值，"
          f"累计重识别 {fresh.reprocessed_count} 次。")
    return 0


def cmd_export(args) -> int:
    out = Path(args.out or config.EXPORT_DIR)
    out.mkdir(parents=True, exist_ok=True)
    if args.format in ("json", "all"):
        print("JSON:", export_batch_json(out / "batch.json"))
    if args.format in ("csv", "all"):
        print("CSV :", export_batch_csv(out / "batch.csv"))
    return 0


def cmd_list(_args) -> int:
    for s in database.list_pages():
        print(f"{s['page_id'][:8]}  版式={s['template_id']}  "
              f"待确认={s['n_needs_review']}/{s['n_fields']}  "
              f"人工修改={s['n_manual']}  {Path(s['source_path']).name}")
    return 0


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(description="本地巡检单扫描采集工具（无云端 OCR）")
    sub = p.add_subparsers(dest="cmd", required=True)

    g = sub.add_parser("generate", help="生成合成样本")
    g.add_argument("--count", type=int, default=12)
    g.add_argument("--out", default=str(config.DATA_DIR / "samples"))
    g.add_argument("--seed", type=int, default=1000)
    g.set_defaults(func=cmd_generate)

    c = sub.add_parser("collect", help="批量采集目录内图像")
    c.add_argument("path")
    c.add_argument("--out", default=None, help="采集后导出目录")
    c.set_defaults(func=cmd_collect)

    r = sub.add_parser("reprocess", help="对已存页面重新识别（保留人工值）")
    r.add_argument("page_id")
    r.set_defaults(func=cmd_reprocess)

    e = sub.add_parser("export", help="结构化导出")
    e.add_argument("--format", choices=["json", "csv", "all"], default="all")
    e.add_argument("--out", default=None)
    e.set_defaults(func=cmd_export)

    ls = sub.add_parser("list", help="列出已采集页面")
    ls.set_defaults(func=cmd_list)
    return p


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    return args.func(args)


if __name__ == "__main__":
    raise SystemExit(main())
