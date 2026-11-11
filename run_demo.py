# -*- coding: utf-8 -*-
"""一键启动：演示站点（测试模式）+ 采集器配置页面。"""

import threading
import time

from collector.engine import CollectionEngine
from collector.webui import CollectorWebUI
from siteserver.app import build_server


def main():
    site, _app = build_server("127.0.0.1", 8000, test_mode=True)
    site_thread = threading.Thread(target=site.serve_forever, daemon=True)
    site_thread.start()
    time.sleep(0.3)

    engine = CollectionEngine(evidence_dir="./out")
    ui = CollectorWebUI(engine, host="127.0.0.1", port=8080)
    print("演示环境：")
    print("  站点入口       http://127.0.0.1:8000/")
    print("  采集配置页面   http://127.0.0.1:8080/")
    print("  故障注入控制端 http://127.0.0.1:8000/__test__/expire|regress|mutate")
    try:
        ui.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        site.shutdown()


if __name__ == "__main__":
    main()
