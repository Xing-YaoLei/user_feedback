#!/usr/bin/env python3
"""轮询程序入口：python run_poller.py config.json"""

from __future__ import annotations

import argparse
import logging
import signal
import time

from shuttle.config import load_config
from shuttle.dispatcher import DispatcherServer
from shuttle.logger import setup_logging
from shuttle.poller import Scheduler


def main() -> None:
    parser = argparse.ArgumentParser(description="园区班车到站数据轮询程序")
    parser.add_argument("config", help="JSON 配置文件路径")
    args = parser.parse_args()

    config = load_config(args.config)
    setup_logging(logging.INFO, config.logfile)

    scheduler = Scheduler(config)
    dispatcher = None
    if config.dispatcher is not None:
        dispatcher = DispatcherServer(
            scheduler, host=config.dispatcher.host, port=config.dispatcher.port
        )

    scheduler.start()
    if dispatcher is not None:
        dispatcher.start()
        print(f"调度员页面: {dispatcher.url}")

    stop = False

    def handle_signal(signum, frame):  # noqa: ANN001
        nonlocal stop
        stop = True

    signal.signal(signal.SIGINT, handle_signal)
    signal.signal(signal.SIGTERM, handle_signal)

    try:
        while not stop:
            time.sleep(0.5)
    finally:
        scheduler.stop()
        if dispatcher is not None:
            dispatcher.stop()


if __name__ == "__main__":
    main()
