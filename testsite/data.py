"""测试站种子数据集与事实基准（ground truth）。

爬虫禁止导入本模块：它只能通过浏览器页面发现选项与结果。
测试代码用本模块构造预期结果，与爬虫输出做比对。
"""
from __future__ import annotations

# ---- 层级选项 -----------------------------------------------------------

REGIONS = [
    ("north", "华北"),
    ("east", "华东"),
    ("south", "华南"),
    ("west", "西北"),
]

# region -> [(institution_id, label)]
INSTITUTIONS: dict[str, list[tuple[str, str]]] = {
    "north": [("bj1", "北京市第一医院"), ("bj2", "北京市第二医院"), ("tj", "天津医疗设备所")],
    "east": [("sh", "上海诊疗中心"), ("hz", "杭州分院"), ("su", "苏州研究所")],
    "south": [("gz", "广州实验室"), ("sz", "深圳基地")],
    "west": [("xa", "西安监测站")],
}

DEVICE_TYPES = [
    ("monitor", "监护仪"),
    ("ventilator", "呼吸机"),
    ("defib", "除颤仪"),
    ("ultrasound", "超声仪"),
    ("pump", "输液泵"),
]

# 机构“登记支持”的设备类型：页面会给出这些选项，但其中部分组合没有设备
# （选项存在、结果为空 —— 空分支）。
TYPE_SUPPORT: dict[str, list[str]] = {
    "bj1": ["monitor", "ventilator", "ultrasound", "pump"],
    "bj2": ["monitor", "defib", "ultrasound"],
    "tj": ["monitor", "pump"],
    "sh": ["monitor", "ventilator", "defib", "ultrasound", "pump"],
    "hz": ["ventilator", "ultrasound"],
    "su": ["monitor", "pump"],
    "gz": ["monitor", "ultrasound"],
    "sz": ["ventilator", "defib", "pump"],
    "xa": ["monitor", "pump"],
}

# 登记支持但无设备的组合（空分支）。
EMPTY_COMBOS: set[tuple[str, str, str]] = {
    ("north", "bj1", "pump"),
    ("east", "sh", "defib"),
    ("east", "su", "pump"),
    ("south", "gz", "monitor"),
    ("west", "xa", "pump"),
}


def _d(dev_id: str, name: str, model: str, maker: str) -> dict:
    return {"id": dev_id, "name": name, "model": model, "manufacturer": maker}


# (region, institution, type) -> 设备列表。
# 同一设备字典在多个组合下复用，模拟同一实体归属多个筛选组合。
_DEV: dict[tuple[str, str, str], list[dict]] = {
    ("north", "bj1", "monitor"): [
        _d("DEV-001", "床旁监护仪", "M-100", "迈瑞"),
        _d("DEV-002", "多参数监护仪", "M-200", "飞利浦"),
    ],
    ("north", "bj1", "ventilator"): [
        _d("DEV-003", "有创呼吸机", "V-500", "德尔格"),
    ],
    ("north", "bj1", "ultrasound"): [
        _d("DEV-004", "台式超声仪", "U-80", "GE"),
        _d("DEV-010", "便携超声仪", "U-20", "开立"),
    ],
    ("north", "bj2", "monitor"): [
        _d("DEV-005", "遥测监护仪", "M-300", "迈瑞"),
    ],
    ("north", "bj2", "defib"): [
        _d("DEV-006", "除颤监护仪", "D-90", "飞利浦"),
        _d("DEV-011", "自动除颤仪", "D-50", "卓尔"),
    ],
    ("north", "bj2", "ultrasound"): [
        _d("DEV-010", "便携超声仪", "U-20", "开立"),
        _d("DEV-007", "掌上超声", "U-10", "飞依诺"),
    ],
    ("north", "tj", "monitor"): [
        _d("DEV-008", "工业级监护仪", "M-900", "研祥"),
    ],
    ("north", "tj", "pump"): [
        _d("DEV-012", "智能输液泵", "P-70", "麦科田"),
        _d("DEV-009", "注射泵", "P-30", "史密斯"),
    ],
    ("east", "sh", "monitor"): [
        _d("DEV-013", "中央监护站", "M-500", "迈瑞"),
        _d("DEV-014", "中央监护系统", "M-700", "GE"),
    ],
    ("east", "sh", "ventilator"): [
        _d("DEV-015", "无创呼吸机", "V-200", "瑞思迈"),
        _d("DEV-016", "转运呼吸机", "V-90", "德尔格"),
    ],
    ("east", "sh", "ultrasound"): [
        _d("DEV-017", "四维彩超", "U-900", "GE"),
    ],
    ("east", "sh", "pump"): [
        _d("DEV-018", "靶控输液泵", "P-500", "贝朗"),
    ],
    ("east", "hz", "ventilator"): [
        _d("DEV-019", "家用呼吸机", "V-50", "瑞思迈"),
    ],
    ("east", "hz", "ultrasound"): [
        _d("DEV-020", "便携式彩超", "U-60", "索诺"),
    ],
    ("east", "su", "monitor"): [
        _d("DEV-014", "中央监护系统", "M-700", "GE"),
        _d("DEV-021", "环境监护模组", "M-50", "自研"),
    ],
    ("south", "gz", "ultrasound"): [
        _d("DEV-022", "高通量超声平台", "U-700", "迈瑞"),
    ],
    ("south", "sz", "ventilator"): [
        _d("DEV-016", "转运呼吸机", "V-90", "德尔格"),
    ],
    ("south", "sz", "defib"): [
        _d("DEV-011", "自动除颤仪", "D-50", "卓尔"),
        _d("DEV-023", "训练用除颤仪", "D-10", "莱尔"),
    ],
    ("south", "sz", "pump"): [
        _d("DEV-012", "智能输液泵", "P-70", "麦科田"),
    ],
    ("west", "xa", "monitor"): [
        _d("DEV-024", "野外监护仪", "M-70", "自研"),
    ],
}

REGION_LABELS = dict(REGIONS)
INSTITUTION_LABELS = {iid: label for items in INSTITUTIONS.values() for iid, label in items}
TYPE_LABELS = dict(DEVICE_TYPES)


def combo_key(region: str, institution: str, dev_type: str) -> str:
    return f"{region}|{institution}|{dev_type}"


def all_leaf_combos() -> list[tuple[str, str, str]]:
    """页面上可以走到的全部叶子组合（含空分支）。"""
    out: list[tuple[str, str, str]] = []
    for region, _ in REGIONS:
        for iid, _ in INSTITUTIONS[region]:
            for tid in TYPE_SUPPORT[iid]:
                out.append((region, iid, tid))
    return out


def devices_for(region: str, institution: str, dev_type: str) -> list[dict]:
    return [dict(d) for d in _DEV.get((region, institution, dev_type), [])]


def ground_truth() -> dict:
    """返回测试断言使用的事实基准。"""
    leaves = all_leaf_combos()
    non_empty = {k for k in leaves if k not in EMPTY_COMBOS}
    entities: dict[str, dict] = {}
    memberships: dict[str, set[str]] = {}
    for combo in leaves:
        for d in devices_for(*combo):
            entities[d["id"]] = d
            memberships.setdefault(d["id"], set()).add(combo_key(*combo))
    return {
        "leaves": leaves,
        "empty_combos": set(EMPTY_COMBOS),
        "non_empty_combos": non_empty,
        "entities": entities,
        "memberships": memberships,
        "total_rows": sum(len(v) for v in _DEV.values()),
    }
