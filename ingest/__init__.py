"""批次接入工具：把多来源、多版本的事件汇入统一明细。

模块划分：
- config:    加载目标字段定义、来源 schema、版本化映射
- readers:   读取 JSONL / JSON 数组 / CSV，保留每条记录的原始位置
- typesys:   类型系统与跨版本类型转换规则
- precheck:  按 (来源, 版本) 做导入前兼容性检查
- transform: 单条记录映射、默认值补齐、显式 null 校验、类型转换
- state:     已发布台账、失败待处理清单、单次原子提交
- pipeline:  批次编排（导入 / 仅重试失败 / 状态查询）
"""

__all__ = ["__version__"]
__version__ = "1.0.0"
