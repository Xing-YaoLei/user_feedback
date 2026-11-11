"""基于 Playwright 的浏览器会话。

只允许通过页面 DOM 与页面状态工作（不直接调用后台接口、不读取后台数据）。
核心一致性原则：
  结果区签名必须等于 当前三个下拉框选中值拼出的条件标识，且页面不处于
  loading / error 状态，才认为“筛选条件和结果标识一致”，此时才采集。
"""
from __future__ import annotations

import random
from dataclasses import dataclass

from playwright.sync_api import Locator, Page, TimeoutError as PWTimeoutError, sync_playwright

# 页面里的元素选择器
SEL_REGION = "#region-select"
SEL_INSTITUTION = "#institution-select"
SEL_TYPE = "#type-select"
SEL_QUERY_BTN = "#query-btn"
SEL_STATUS = "#status"
SEL_SIGNATURE = "#signature"
SEL_ROWS = 'table[data-result-table="1"] tbody tr[data-device-id]'
SEL_EMPTY = '#results [data-empty="1"]'


class StaleOrLoadingError(RuntimeError):
    """结果与当前筛选条件不一致（仍在加载 / 旧内容残留 / 超时）。可重试。"""


class PageQueryError(RuntimeError):
    """页面明确报错（如 500 横幅）。可重试，绝不能当成空分支。"""


@dataclass
class PageDevice:
    id: str
    name: str
    model: str
    manufacturer: str


# 在浏览器内执行的判断脚本：返回当前页面状态快照。
_EVAL_STATE = """
() => {
  const q = (sel) => document.querySelector(sel);
  const region = q('#region-select').value;
  const institution = q('#institution-select').value;
  const type = q('#type-select').value;
  const status = q('#status').dataset.state || '';
  const signature = q('#signature').dataset.signature || '';
  const expected = [region, institution, type].filter(Boolean).join('|');
  const rows = Array.from(document.querySelectorAll('%s')).map((tr) => ({
    id: tr.querySelector('.cell-id').textContent.trim(),
    name: tr.querySelector('.cell-name').textContent.trim(),
    model: tr.querySelector('.cell-model').textContent.trim(),
    manufacturer: tr.querySelector('.cell-maker').textContent.trim(),
  }));
  const emptyVisible = !!q('%s');
  return {region, institution, type, status, signature, expected, rows, emptyVisible};
}
""" % (SEL_ROWS, SEL_EMPTY)


class BrowserSession:
    def __init__(self, base_url: str, headless: bool = True,
                 settle_timeout_ms: int = 15000,
                 poll_interval_ms: int = 120) -> None:
        self.base_url = base_url.rstrip("/")
        self.headless = headless
        self.settle_timeout_ms = settle_timeout_ms
        self.poll_interval_ms = poll_interval_ms
        self._pw = None
        self._browser = None
        self.page: Page | None = None

    # -- 生命周期 ---------------------------------------------------------
    def __enter__(self) -> "BrowserSession":
        self._pw = sync_playwright().start()
        self._browser = self._pw.chromium.launch(headless=self.headless)
        self.page = self._browser.new_page()
        self.page.goto(self.base_url + "/", wait_until="domcontentloaded")
        self._wait_select_ready(SEL_REGION)
        return self

    def __exit__(self, *exc) -> None:
        try:
            if self._browser:
                self._browser.close()
        finally:
            if self._pw:
                self._pw.stop()

    # -- 下拉框交互 -------------------------------------------------------
    @staticmethod
    def _options(select: Locator) -> list[tuple[str, str]]:
        handle = select.element_handle()
        values = handle.eval_on_selector_all(
            "option",
            "els => els.map(o => [o.value, o.textContent.trim()])",
        )
        # 占位 option 的 value 为 ""，丢弃
        return [(v, label) for v, label in values if v]

    def _wait_select_ready(self, selector: str) -> None:
        """等待下拉框启用、至少有一个真实选项，且不再显示“加载中/请先选择”占位。

        页面下级选项通过异步 fetch 填充；仅等 enabled 可能在 fetch 完成前
        就返回，随后到达的重置逻辑会清空已选值。这里用占位项消失作为
        “加载已完成”的事件信号（非固定时长等待）。
        """
        locator = self.page.locator(selector)
        locator.wait_for(state="visible")
        self.page.wait_for_function(
            """(sel) => {
                const el = document.querySelector(sel);
                if (!el || el.disabled) return false;
                const real = Array.from(el.options).filter(o => o.value !== '');
                if (real.length === 0) return false;
                // 占位项仍写着“加载中”说明 fetch 尚未完成
                const head = el.options[0];
                if (head && head.value === '' && head.textContent.includes('加载')) {
                    return false;
                }
                return true;
            }""",
            arg=selector,
            timeout=self.settle_timeout_ms,
        )

    def read_options(self, level: str) -> list[tuple[str, str]]:
        selector = {"region": SEL_REGION, "institution": SEL_INSTITUTION,
                    "type": SEL_TYPE}[level]
        self._wait_select_ready(selector)
        return self._options(self.page.locator(selector))

    def select(self, level: str, value: str) -> None:
        selector = {"region": SEL_REGION, "institution": SEL_INSTITUTION,
                    "type": SEL_TYPE}[level]
        # Playwright 的 select_option 会派发可信的原生 change 事件，
        # 前端监听器能正常收到；切勿再手动 dispatch，否则同一处理器
        # 并发执行两次，两个异步重置/填充周期交错会产生竞态。
        self.page.select_option(selector, value)

    def select_institution(self, value: str) -> None:
        self.select("institution", value)
        self._wait_select_ready(SEL_TYPE)
        # 机构 change 触发的类型填充是异步流程；等网络空闲确保整个联动
        # 周期落地，避免迟到的重置逻辑清空后续选择
        self.page.wait_for_load_state("networkidle",
                                      timeout=self.settle_timeout_ms)

    def select_region(self, value: str) -> None:
        self.select("region", value)
        self._wait_select_ready(SEL_INSTITUTION)
        self.page.wait_for_load_state("networkidle",
                                      timeout=self.settle_timeout_ms)

    def select_type(self, value: str) -> None:
        # select() 内部已派发 change；这里只需等待按钮启用
        self.select("type", value)
        self.page.locator(SEL_QUERY_BTN).wait_for(state="visible")
        self.page.wait_for_function(
            "() => !document.querySelector('#query-btn').disabled",
            timeout=self.settle_timeout_ms,
        )

    # -- 查询与一致性等待 -------------------------------------------------
    def query_and_collect(self, region: str, institution: str,
                          dev_type: str) -> list[PageDevice]:
        """点击查询，等待条件/结果标识一致后采集当前页数据。"""
        expected_prefix = f"{region}|{institution}|{dev_type}"
        # 类型切换后按钮经 change 事件重新启用；等它可点击，避免抢跑
        self.page.wait_for_function(
            "() => !document.querySelector('#query-btn').disabled",
            timeout=self.settle_timeout_ms,
        )
        self.page.click(SEL_QUERY_BTN)
        deadline_ms = self.settle_timeout_ms
        try:
            self.page.wait_for_function(
                """({prefix, rowsSel, emptySel}) => {
                    const q = (s) => document.querySelector(s);
                    const status = q('#status').dataset.state || '';
                    // 错误状态单独由 Python 侧识别并抛可重试异常
                    if (status === 'error') return true;
                    const sig = q('#signature').dataset.signature || '';
                    // 签名形如 region|institution|type|count；
                    // 必须以前缀 + 分隔符开头，空签名/旧组合签名都不满足
                    const sigMatches = sig.startsWith(prefix + '|');
                    const emptyVisible = !!q(emptySel);
                    const hasRows = document.querySelectorAll(rowsSel).length > 0;
                    // 注意：必须返回布尔值，返回对象会被当成 truthy 误判完成
                    return status === 'ready' && sigMatches
                        && (emptyVisible || hasRows);
                }""",
                arg={"prefix": expected_prefix, "rowsSel": SEL_ROWS,
                     "emptySel": SEL_EMPTY},
                timeout=deadline_ms,
                polling=self.poll_interval_ms,
            )
        except PWTimeoutError as exc:
            snapshot = self.page.evaluate(_EVAL_STATE)
            raise StaleOrLoadingError(
                f"结果在 {deadline_ms}ms 内未与条件 {expected_prefix} 一致；"
                f"当前 status={snapshot['status']} signature={snapshot['signature']!r}"
            ) from exc

        snapshot = self.page.evaluate(_EVAL_STATE)
        if snapshot["status"] == "error":
            raise PageQueryError(
                f"页面报告加载错误（条件 {expected_prefix}），旧结果保留中，需重试"
            )
        # 双保险：Python 侧再核对一次签名与选中值
        if not snapshot["signature"].startswith(expected_prefix + "|"):
            raise StaleOrLoadingError(
                f"签名不一致：期望前缀 {expected_prefix}，实际 {snapshot['signature']!r}"
            )
        if snapshot["region"] != region or snapshot["institution"] != institution \
                or snapshot["type"] != dev_type:
            raise StaleOrLoadingError("下拉框选中值与目标条件不一致")

        if snapshot["emptyVisible"]:
            return []
        if not snapshot["rows"]:
            # 既没有空标识也没有数据行：状态不完整，按不一致处理（可重试）
            raise StaleOrLoadingError("结果区既无数据行也无空标识，状态不完整")
        return [PageDevice(**row) for row in snapshot["rows"]]


def compute_backoff_seconds(attempt: int, base: float = 0.4, cap: float = 4.0,
                            jitter: float = 0.2) -> float:
    """指数退避 + 抖动。attempt 从 1 开始（第 1 次失败后的等待）。"""
    delay = min(cap, base * (2 ** (attempt - 1)))
    return delay + random.uniform(0, jitter)
