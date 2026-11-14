"""园区班车到站数据轮询系统。

模块划分：
- backoff:      有上限的指数退避与 Retry-After 解析
- config:       配置加载与校验
- model:        园区运行时状态与快照数据类
- logger:       日志初始化
- mock_server:  本地模拟班车接口（可配置延迟/状态序列，记录请求）
- poller:       轮询调度器（并发上限、同园区互斥、ETag、退避）
- dispatcher:   调度员查看页面与 JSON API
"""

__all__ = [
    "backoff",
    "config",
    "model",
    "logger",
    "mock_server",
    "poller",
    "dispatcher",
]
