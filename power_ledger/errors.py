"""用户可读错误：CLI 捕获后只输出消息，不打印堆栈。"""


class LedgerError(Exception):
    """业务校验失败或账本状态不允许该操作。"""
