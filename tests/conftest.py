"""pytest 共享夹具：生成带真值的合成样本并提供临时数据库。"""

from __future__ import annotations

import importlib

import pytest

from inspect_ocr import config, generate


@pytest.fixture()
def tmp_workspace(tmp_path, monkeypatch):
    """把数据目录重定向到临时路径，避免污染真实 data/。"""
    monkeypatch.setattr(config, "DATA_DIR", tmp_path)
    monkeypatch.setattr(config, "DB_PATH", tmp_path / "inspect.db")
    monkeypatch.setattr(config, "IMAGE_DIR", tmp_path / "images")
    monkeypatch.setattr(config, "EXPORT_DIR", tmp_path / "exports")
    for d in (config.DATA_DIR, config.IMAGE_DIR, config.EXPORT_DIR):
        d.mkdir(parents=True, exist_ok=True)
    import inspect_ocr.database as db
    importlib.reload(db)
    db.init_db(config.DB_PATH)
    return tmp_path


@pytest.fixture(scope="session")
def samples_dir(tmp_path_factory):
    """会话级合成数据集（含倾斜/噪声/缺页角/空白/90 度旋转）。"""
    out = tmp_path_factory.mktemp("samples")
    metas = generate.generate_dataset(str(out), count=10, seed_base=2000)
    return out, metas
