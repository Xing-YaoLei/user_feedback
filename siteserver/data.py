# -*- coding: utf-8 -*-
"""演示数据集：25 条商品记录，每页 8 条，共 4 页。"""

from dataclasses import dataclass


@dataclass(frozen=True)
class Product:
    pid: str
    sku: str
    name: str
    category: str
    price: str


CATEGORIES = ("全部", "工具", "文具", "电子", "耗材")

PRODUCTS = [
    Product("P001", "SKU-1001", "精密螺丝刀套装", "工具", "129.00"),
    Product("P002", "SKU-1002", "内六角扳手组", "工具", "58.50"),
    Product("P003", "SKU-1003", "数显游标卡尺", "工具", "219.00"),
    Product("P004", "SKU-1004", "热熔胶枪", "工具", "39.90"),
    Product("P005", "SKU-1005", "防静电镊子", "工具", "18.00"),
    Product("P006", "SKU-1006", "钢卷尺 5 米", "工具", "25.00"),
    Product("P007", "SKU-1007", "美工刀", "文具", "9.90"),
    Product("P008", "SKU-1008", "中性笔十支装", "文具", "15.00"),
    Product("P009", "SKU-1009", "荧光记号笔", "文具", "8.00"),
    Product("P010", "SKU-1010", "A5 笔记本", "文具", "12.50"),
    Product("P011", "SKU-1011", "订书机", "文具", "22.00"),
    Product("P012", "SKU-1012", "便利贴四色", "文具", "6.50"),
    Product("P013", "SKU-1013", "文件收纳盒", "文具", "34.00"),
    Product("P014", "SKU-1014", "桌面计算器", "电子", "49.00"),
    Product("P015", "SKU-1015", "USB 分线器", "电子", "36.80"),
    Product("P016", "SKU-1016", "无线鼠标", "电子", "89.00"),
    Product("P017", "SKU-1017", "机械键盘", "电子", "299.00"),
    Product("P018", "SKU-1018", "蓝牙耳机", "电子", "199.00"),
    Product("P019", "SKU-1019", "移动电源", "电子", "129.00"),
    Product("P020", "SKU-1020", "HDMI 线缆", "电子", "29.90"),
    Product("P021", "SKU-1021", "硒鼓墨盒", "耗材", "188.00"),
    Product("P022", "SKU-1022", "A4 复印纸", "耗材", "28.00"),
    Product("P023", "SKU-1023", "标签打印纸", "耗材", "45.00"),
    Product("P024", "SKU-1024", "装订夹条", "耗材", "11.00"),
    Product("P025", "SKU-1025", "色带架", "耗材", "76.00"),
]

PAGE_SIZE = 8


def query_products(keyword: str, category: str):
    """按关键词（名称/SKU 模糊匹配）与分类过滤，返回全部命中记录。"""
    keyword = (keyword or "").strip().lower()
    category = (category or "全部").strip() or "全部"
    matched = []
    for item in PRODUCTS:
        if category != "全部" and item.category != category:
            continue
        if keyword and keyword not in item.name.lower() and keyword not in item.sku.lower():
            continue
        matched.append(item)
    return matched


def page_slice(rows, page: int):
    start = (page - 1) * PAGE_SIZE
    return rows[start:start + PAGE_SIZE]
