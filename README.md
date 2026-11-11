# user_feedback

## 科研数据目录关联采集器

按引用扩展采集的演示系统，纯 Python 标准库实现（≥3.9），无第三方依赖。

### 组成

| 文件 | 说明 |
|---|---|
| `catalog_api.py` | 测试目录接口（http.server），内置共享引用 / 循环 / 删除 / 版本变化 / 局部故障样例 |
| `client.py` | HTTP 客户端，保留服务端返回的版本号 |
| `harvester.py` | 采集器：任务=(type,id,version)，同任务合并、边全保留、循环终止、失败隔离重试 |
| `db.py` | SQLite 关系库：objects / edges / gaps / fetch_log / runs |
| `queries.py` | 按根数据集追溯来源（递归 CTE，环保护 + 节点去重） |
| `viewer.py` | 查看页面：引用图（SVG，未解析引用虚线红框）+ 缺口表 |
| `demo.py` | 端到端演示 |
| `tests/` | unittest 测试（8 个用例） |

### 行为规则

- **合并请求**：同一对象同一版本一次运行只抓一次；每条引用边（含角色）独立入库。
- **循环引用**：已入队任务不再扩展，环（i1↔m1、a1↔a2）自然终止。
- **缺失对象**：404/410 不重试，作为未解析引用写入 `gaps`，指向它的边保留。
- **版本不符**：清单标 v1 而服务端返回 v2 时，payload 不入库、不展开，记
  `version_mismatch` 缺口 —— 两个版本绝不混用。
- **失败隔离**：5xx/网络错误重试 `max_retries` 次；最终失败只给该分支记缺口，
  其他无关分支照常入库。运行状态只有存在零缺口时才为 `complete`，否则 `partial`。

### 使用

```bash
python3 demo.py                 # 启动测试接口 -> 采集 -> 打印摘要，写 catalog.db
python3 demo.py --serve         # 同上，并启动查看页面 http://127.0.0.1:8000/
python3 viewer.py catalog.db    # 只启动查看页面
python3 -m unittest discover -s tests -v   # 运行测试
```

### 测试覆盖

- 共享引用只抓一次、各引用边保留
- 循环引用终止且各对象只抓一次
- 缺失对象记为未解析引用且边保留
- 版本不符不混用（v1/v2 均不入库）
- **局部失败（iDown 永远 500）运行状态为 `partial` 而非 `complete`，无关分支正常入库**
- 临时故障（iFlaky 前两次 503）重试后成功
- 按根数据集追溯来源，环上节点只出现一次
- 对照组：无缺口运行报告 `complete`
