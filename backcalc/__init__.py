"""回算工具：校准记录的双时态查询与增量重算。

模块划分：
- timeutil:  时间解析与归一化（统一 UTC、可字典序比较的文本）
- io_utils:  CSV / JSONL 批次文件读取与字段校验
- store:     SQLite schema 与纯数据访问
- engine:    选记录、冲突回退、快照构建、增量重算等业务语义
- cli:       命令行入口
"""

__all__ = ["timeutil", "io_utils", "store", "engine", "cli"]
