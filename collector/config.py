# -*- coding: utf-8 -*-
"""查询配置。"""

import json
from dataclasses import asdict, dataclass, field


@dataclass
class QueryConfig:
    name: str                                   # 查询名称（任务标识）
    entry_url: str                              # 站点入口地址（状态链的唯一起点）
    form_name: str = "search"                   # 查询表单的 name
    form_index: int = None                      # 同名表单的文档序号（可选，缺省按隐藏状态消歧）
    button_value: str = "search"                # 查询按钮的 value（按钮参数来自页面）
    button_name: str = "btn"
    fields: dict = field(default_factory=dict)  # 业务字段，如 {"q": "键盘", "category": "电子"}
    pager_form_name: str = "pager"              # 翻页表单的 name
    next_button_value: str = "next"
    max_pages: int = 10                         # 翻页上限保护
    max_recoveries: int = 2                     # 状态过期后最多从入口恢复次数

    def to_dict(self):
        return asdict(self)

    @classmethod
    def from_dict(cls, obj: dict) -> "QueryConfig":
        known = {f for f in cls.__dataclass_fields__}
        return cls(**{k: v for k, v in obj.items() if k in known})

    @classmethod
    def load_many(cls, path: str):
        with open(path, "r", encoding="utf-8") as fh:
            data = json.load(fh)
        if isinstance(data, dict):
            data = data.get("queries", [])
        return [cls.from_dict(item) for item in data]
