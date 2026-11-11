"""端到端演示：启动测试接口 -> 采集 -> 打印摘要 -> 生成查看页面数据库。

用法：python demo.py [--serve]
  --serve  采集完成后启动查看页面（默认端口 8000）
"""
import sys

import catalog_api
import queries
from client import HttpClient
from db import DB
from harvester import Harvester


def main():
    server, base_url = catalog_api.serve()
    try:
        db = DB("catalog.db")
        client = HttpClient(base_url)
        roots = client.list_datasets()
        print(f"清单根数据集: {[(r.type, r.id, r.version) for r in roots]}")

        run_id, status, stats = Harvester(client, db, max_retries=2).harvest(roots)
        print(f"运行 #{run_id} 状态: {status}  统计: {stats}")

        print("\n缺口:")
        for g in db.gaps_of_run(run_id):
            print(f"  [{g['reason']}] {g['to_type']}:{g['to_id']}:v{g['to_version']}"
                  f"  {g['detail'] or ''}")

        print("\n按根数据集 ds1 追溯来源:")
        for row in queries.trace_provenance(db, "dataset", "ds1", 1):
            print(f"  {'  ' * row['depth']}{row['type']}:{row['id']}:v{row['version']}")

        db.close()
        print("\n数据库已写入 catalog.db")
        if "--serve" in sys.argv:
            import viewer
            viewer.serve("catalog.db", 8000)
    finally:
        server.shutdown()


if __name__ == "__main__":
    main()
