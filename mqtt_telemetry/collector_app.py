"""采集服务入口：python -m mqtt_telemetry.collector_app"""
from __future__ import annotations

import argparse
import logging

from .collector import Collector
from .config import BrokerConfig, CollectorConfig
from .dashboard import make_server, serve_in_thread
from .storage import Storage


def main() -> None:
    ap = argparse.ArgumentParser(description="MQTT 遥测采集服务")
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--port", type=int, default=1883)
    ap.add_argument("--db", default="data/telemetry.db")
    ap.add_argument("--queue-max", type=int, default=256)
    ap.add_argument("--slow-processing", type=float, default=0.0,
                    help="每条消息落库前额外延迟秒数，用于演示背压过载")
    ap.add_argument("--web-host", default="127.0.0.1")
    ap.add_argument("--web-port", type=int, default=8080)
    ap.add_argument("--topic", default="telemetry/+/up")
    args = ap.parse_args()

    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s %(message)s",
    )
    storage = Storage(args.db)
    collector = Collector(
        BrokerConfig(host=args.host, port=args.port),
        CollectorConfig(topic=args.topic, db_path=args.db,
                        queue_max=args.queue_max,
                        inject_process_delay=args.slow_processing,
                        web_host=args.web_host, web_port=args.web_port),
        storage,
    )
    httpd = make_server(args.web_host, args.web_port, collector, storage)
    serve_in_thread(httpd)
    logging.getLogger("collector").info(
        "排障面板: http://%s:%d", args.web_host, args.web_port)

    collector.start()
    try:
        collector.wait()
    finally:
        collector.stop()
        httpd.shutdown()


if __name__ == "__main__":
    main()
