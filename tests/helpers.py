"""测试共用的临时配置与数据构造工具。"""

from __future__ import annotations

import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from ingest.config import PipelineConfig  # noqa: E402


def write_json(path: str, payload: object) -> None:
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as fh:
        json.dump(payload, fh, ensure_ascii=False, indent=2)


def write_text(path: str, text: str) -> None:
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as fh:
        fh.write(text)


def build_config_dir(root: str, *, target_content_nullable: bool = True) -> str:
    """构造一套最小但覆盖两来源两版本的配置。"""
    cfg = os.path.join(root, "config")
    write_json(
        os.path.join(cfg, "target_schema.json"),
        {
            "fields": [
                {"name": "event_id", "type": "string", "required": True, "nullable": False},
                {"name": "event_type", "type": "string", "required": True, "nullable": False},
                {"name": "user_id", "type": "string", "required": True, "nullable": False},
                {"name": "event_time", "type": "datetime", "required": True, "nullable": False},
                {"name": "rating", "type": "integer", "required": False, "nullable": True},
                {
                    "name": "content",
                    "type": "string",
                    "required": False,
                    "nullable": target_content_nullable,
                },
                {"name": "extra", "type": "json", "required": False, "nullable": True},
            ]
        },
    )
    write_json(
        os.path.join(cfg, "source_schemas.json"),
        {
            "schemas": [
                {
                    "source": "support",
                    "version": "v1",
                    "id_field": "ticket_id",
                    "source_field": "src",
                    "version_field": "ver",
                    "fields": [
                        {"name": "ticket_id", "type": "string", "required": True, "nullable": False},
                        {"name": "customer_id", "type": "string", "required": True, "nullable": False},
                        {"name": "created_at", "type": "datetime", "required": True, "nullable": False},
                        {"name": "rating", "type": "integer", "required": False, "nullable": True},
                        {"name": "message", "type": "string", "required": False, "nullable": True},
                        {"name": "tags", "type": "json", "required": False, "nullable": True},
                    ],
                },
                {
                    "source": "orders",
                    "version": "v1",
                    "id_field": "order_event_id",
                    "fields": [
                        {"name": "order_event_id", "type": "string", "required": True, "nullable": False},
                        {"name": "buyer_id", "type": "string", "required": True, "nullable": False},
                        {"name": "event_ts", "type": "datetime", "required": True, "nullable": False},
                        {"name": "event_name", "type": "string", "required": True, "nullable": False},
                        {"name": "remark", "type": "string", "required": False, "nullable": True},
                        {"name": "payload", "type": "json", "required": False, "nullable": True},
                    ],
                },
            ]
        },
    )
    write_json(
        os.path.join(cfg, "mappings.json"),
        {
            "mappings": [
                {
                    "source": "support",
                    "version": "v1",
                    "mapping_version": "support-v1-1",
                    "fields": [
                        {"target": "event_id", "source": "ticket_id"},
                        {"target": "event_type", "constant": "feedback"},
                        {"target": "user_id", "source": "customer_id"},
                        {"target": "event_time", "source": "created_at"},
                        {"target": "rating", "source": "rating"},
                        {"target": "content", "source": "message", "default": ""},
                        {"target": "extra", "source": "tags"},
                    ],
                },
                {
                    "source": "orders",
                    "version": "v1",
                    "mapping_version": "orders-v1-1",
                    "fields": [
                        {"target": "event_id", "source": "order_event_id"},
                        {"target": "event_type", "source": "event_name"},
                        {"target": "user_id", "source": "buyer_id"},
                        {"target": "event_time", "source": "event_ts"},
                        {"target": "rating", "drop": True},
                        {"target": "content", "source": "remark", "default": ""},
                        {"target": "extra", "source": "payload"},
                    ],
                },
            ]
        },
    )
    return cfg


def load_test_config(root: str) -> PipelineConfig:
    return PipelineConfig.load(build_config_dir(root))
