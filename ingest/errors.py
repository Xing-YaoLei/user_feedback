"""错误类型定义。

所有错误都带机器可读的 code，方便失败记录落盘后被重试流程程序化处理。
"""

from __future__ import annotations


class IngestError(Exception):
    """工具内错误的基类。"""

    code = "ingest_error"


class ConfigError(IngestError):
    """字段定义 / schema / 映射本身配置有误（与数据无关）。"""

    code = "config_error"


class UnsupportedSourceError(IngestError):
    """出现了配置里没有声明的 (来源, 版本) 组合。"""

    code = "unsupported_source_version"


class TransformError(IngestError):
    """单条记录转换失败（缺必填、显式 null 不可空、类型转不过去等）。"""

    code = "transform_error"

    def __init__(
        self,
        message: str,
        *,
        reason_code: str = "transform_error",
        source: str | None = None,
        version: str | None = None,
        event_id: str | None = None,
    ):
        super().__init__(message)
        self.reason_code = reason_code
        # 失败前已经解析出来的身份信息，供失败台账准确记录来源
        self.source = source
        self.version = version
        self.event_id = event_id
