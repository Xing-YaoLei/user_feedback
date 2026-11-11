"""手动启动测试站：python -m testsite.run [--port 8765]"""
from __future__ import annotations

import argparse
import json

from testsite.server import make_server


def main() -> None:
    parser = argparse.ArgumentParser(description="设备目录测试站")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8765)
    args = parser.parse_args()

    server = make_server(args.host, args.port)
    host, port = server.server_address
    print(f"测试站已启动: http://{host}:{port}/")
    print("故障注入接口: POST /api/control，例如")
    print(json.dumps({"fail_first": 2, "shuffle": True, "overtake": True},
                     ensure_ascii=False))
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n已停止")
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
