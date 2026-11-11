# -*- coding: utf-8 -*-
"""本地演示站点启动入口。

用法：
    python -m siteserver.server [--host 127.0.0.1] [--port 8000] [--test-mode]
--test-mode 会开放 /__test__/* 故障注入控制端，仅供测试与演示恢复流程。
"""

import argparse

from .app import build_server


def main(argv=None):
    parser = argparse.ArgumentParser(description="传统回发表单演示站点")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8000)
    parser.add_argument("--test-mode", action="store_true",
                        help="启用 /__test__/* 故障注入控制端")
    args = parser.parse_args(argv)

    httpd, app = build_server(args.host, args.port, test_mode=args.test_mode)
    mode = "测试模式（故障注入已启用）" if app.test_mode else "普通模式"
    print(f"演示站点运行在 http://{args.host}:{args.port}/  [{mode}]")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        httpd.server_close()


if __name__ == "__main__":
    main()
