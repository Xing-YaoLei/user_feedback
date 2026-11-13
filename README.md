# user_feedback 批次接入工具

把客服系统的 JSON 事件与订单系统的 CSV 事件汇入同一条分析链路。两个系统
各自升级字段、同一天的数据可能来自不同版本，工具按**记录自带的来源和版本**
选择映射，产出下游可读的统一明细，并对失败记录、重复发送、中途崩溃给出
确定性的处理保证。

仅依赖 Python 3.11+ 标准库（开发与验证环境为 Python 3.14），无第三方依赖。

---

## 1. 核心保证

| 需求 | 实现方式 |
| --- | --- |
| 导入前检查必填能否补齐、类型能否转换 | `precheck` 按 `(来源, 版本)` 静态检查目标字段、来源 schema、映射，列出不兼容字段与原因 |
| 按记录自己的来源/版本选映射 | 记录内自定义字段（如 `src`/`ver`）→ 约定字段 `_source`/`_version` → 批次清单文件级默认值 |
| JSON 缺失补默认值，显式 null 按目标格式校验 | 「字段缺失」走映射 `default`；「显式 null」不触发 default，按目标字段 `nullable` 判定 |
| 成功事件保留原事件编号与映射版本 | 统一明细附加 `_event_id`、`_mapping_version` 等溯源元数据 |
| 失败记录来源、原始位置、原因可重试 | 失败清单保存来源、版本、事件编号、`文件::行/行号`、原因码、**原始记录副本** |
| 每批处理完再发布 | 每个 run 独立目录，全部文件落盘后用一次原子 `rename` 切换 `current` 符号链接 |
| 中途退出下游继续读上一个完整结果 | 提交前任何异常都不切换 `current`，半成品 run 留下 `ABORTED` 标记 |
| 映射修正后只重试失败记录 | `retry-failures` 只读取待处理清单，成功即移出清单，已发布记录不参与 |
| 同一来源同一事件只发布一次 | 幂等键 `(source, event_id)`，命中台账即跳过；重发内容不同只告警，保留首版内容与映射版本 |

---

## 2. 目录结构

```
.
├── config/                  # 使用者维护的字段定义与映射（演示用：含不兼容项）
│   ├── target_schema.json   # 统一明细目标字段定义
│   ├── source_schemas.json  # 各来源各版本的来源 schema
│   └── mappings.json        # 按 (来源, 版本) 选择的版本化映射
├── config_fixed/            # 修正后的配置（预检通过，主演示使用）
├── config_fixed2/           # 进一步修正的映射（演示失败重试，rating 容错）
├── ingest/                  # 工具代码
│   ├── config.py            # 配置加载与校验
│   ├── readers.py           # JSONL / JSON 数组 / CSV 读取，保留原始位置
│   ├── typesys.py           # 类型系统与跨版本转换规则
│   ├── precheck.py          # 导入前兼容性检查
│   ├── transform.py         # 单条记录映射、默认值、null、类型转换
│   ├── state.py             # 台账、待处理清单、原子提交
│   ├── pipeline.py          # 批次编排（导入 / 重试）
│   └── cli.py               # 命令行入口
├── examples/
│   ├── batch1/              # 客服 JSONL v1/v2 + 订单 CSV v1
│   └── batch2/              # 订单 CSV v2 + 重复发送 + 未知版本
├── demo/                    # 一键演示与辅助脚本
└── tests/                   # 33 个 unittest 用例
```

---

## 3. 三份配置怎么写

### 3.1 目标字段定义 `target_schema.json`

```json
{
  "fields": [
    {"name": "event_id", "type": "string", "required": true, "nullable": false},
    {"name": "rating", "type": "integer", "required": false, "nullable": true}
  ]
}
```

支持的类型：`string`、`integer`、`number`、`boolean`、`datetime`（ISO 8601）、
`json`（任意结构原样透传）。`required` 控制必填，`nullable` 控制能否为 null，
两者是不同维度（字段可以必填但允许 null，也可以可选但不允许 null）。

### 3.2 来源 schema `source_schemas.json`

每个 `(source, version)` 一份，声明该版本自己的字段类型与可空性，以及记录里
携带来源/版本/事件编号的字段名：

```json
{
  "source": "support",
  "version": "v2",
  "id_field": "ticket_id",
  "source_field": "src",
  "version_field": "ver",
  "fields": [
    {"name": "score", "type": "string", "required": false, "nullable": true}
  ]
}
```

`type` 为 `null`/缺省表示自由 JSON 字段，预检不静态拦截，运行时再判定。
CSV 没有字段类型，读取后按这里的声明做来源侧类型转换。

### 3.3 版本化映射 `mappings.json`

```json
{
  "source": "support",
  "version": "v2",
  "mapping_version": "support-v2-mapping-1.0",
  "fields": [
    {"target": "event_id", "source": "ticket_id"},
    {"target": "event_type", "constant": "feedback"},
    {"target": "rating", "source": "score", "on_error": "set_null"},
    {"target": "content", "source": "message", "default": ""},
    {"target": "channel", "drop": true}
  ]
}
```

字段规则四选一/组合：

- `source`：从来源记录取值，按目标类型转换；
- `default`：来源字段**缺失**时兜底（显式 null 不生效）；
- `constant`：与记录内容无关的常量；
- `drop`：该目标字段在此来源版本下不产出（必填目标不允许 drop）；
- `on_error`：`fail`（默认，脏值整条失败）或 `set_null`（脏值降级为 null，
  仅可空目标允许），是映射修正的容错手段。

配置在加载时一次性校验（未知类型、引用不存在的字段、default 与 constant
并存、不可空字段配 set_null 等都会直接报 `config_error`）。

---

## 4. 关键语义：缺失 vs 显式 null

这是本工具最重要的区分，两条路径完全不同：

| 输入形态 | 判定 | 处理 |
| --- | --- | --- |
| JSON 里字段不存在 | 缺失 | 用映射 `default` 补；无 default 时按目标 required/nullable 决定 |
| JSON 里字段值为 `null` | 显式 null | **不触发 default**，目标可空则存 null，不可空则失败 |
| CSV 空单元格 | 归一为缺失 | 与 JSON 缺失同路径（CSV 没有 null 概念） |

示例（见 `examples/batch1/support_v2.jsonl`）：

- `score` 缺失、目标 `rating` 可空 → 输出 `rating = null`；
- `message: null` 显式 null、目标 `content` 可空 → 输出 `content = null`
  （不会被 default `""` 覆盖）；
- `message` 整个字段缺失 → 输出 `content = ""`（default 生效）。

---

## 5. 命令行用法

```bash
# 导入前预检（不兼容时退出码 2）
python3 -m ingest precheck --config config_fixed

# 按批次清单导入并原子发布（有失败且加 --strict 时退出码 2）
python3 -m ingest ingest \
  --config config_fixed --state state \
  --manifest examples/batch1/manifest.json

# 映射修正后只重试待处理清单里的失败记录
python3 -m ingest retry-failures --config config_fixed2 --state state

# 只重试指定幂等键（可重复传 --only）
python3 -m ingest retry-failures --config config_fixed2 --state state \
  --only support::T-1003

# 查看当前发布状态与失败分布
python3 -m ingest status --state state
```

所有命令都支持 `--json` 输出结构化结果，便于程序化调用。

### 批次清单格式

```json
{
  "batch_id": "2026-11-13-demo-batch1",
  "files": [
    {"path": "support_v1.jsonl"},
    {"path": "orders_v1.csv", "source": "orders", "version": "v1"}
  ]
}
```

`path` 相对清单文件解析；`format` 缺省按扩展名识别（`.jsonl`/`.json`/`.csv`）。
CSV 行内没有来源字段时，用文件级 `source`/`version` 给整行赋默认身份。

---

## 6. 状态目录与崩溃安全

每次提交在 `state/runs/run-<时间戳>-<序号>/` 生成五个文件：

| 文件 | 内容 |
| --- | --- |
| `unified.jsonl` | **本 run 新发布**的统一明细（下游按批消费） |
| `failures.jsonl` | **本 run 新失败**的记录（含来源、位置、原因、原始副本） |
| `published.jsonl` | 累计已发布台账（每个 run 自包含的完整快照，幂等依据） |
| `pending_failures.jsonl` | 累计待处理失败清单（重试的数据来源） |
| `manifest.json` | 本 run 统计与文件清单 |

`state/current` 是指向最新完整 run 的符号链接。提交流程：

1. 新 run 目录写入全部文件并 `fsync`；
2. 先建临时符号链接，再 `os.rename` 原子替换 `current`；
3. 提交前任一异常都不触碰 `current`，半成品目录标记 `ABORTED`。

因此下游固定读 `state/current/unified.jsonl`，看到的永远是某个完整批次，
不会读到写到一半的文件。历史 run 不可变，需要回溯时直接读对应目录。

### 幂等与内容漂移

- 幂等键为 `source::event_id`，台账命中即跳过，不重新映射、不覆盖；
- 重发但内容哈希不同（`_source_hash` 变化）时计入 `content_drift` 告警，
  已发布记录的原始内容与映射版本保持不变；
- 重试成功的记录从待处理清单移除，重试仍失败则 `attempts` 累加。

---

## 7. 失败原因码

| reason_code | 含义 | 能否靠改配置重试救活 |
| --- | --- | --- |
| `missing_source` / `missing_version` | 记录无法确定来源或版本 | 补清单文件级默认值 |
| `unsupported_source_version` | 来源/版本没有 schema 或映射 | 新增对应 schema 与映射 |
| `missing_mapping` | 该来源版本没有映射 | 补映射 |
| `missing_event_id` | 事件编号缺失，无法建幂等键 | 通常需上游修数据 |
| `required_missing` / `required_no_value_source` | 必填目标补不齐 | 补 source 或 default |
| `null_into_non_nullable` | 显式 null 进了不可空字段 | 放宽 nullable 或上游修数据 |
| `type_mismatch` / `source_type_mismatch` | 类型转换失败 | 改类型声明、加 `on_error` 或修数据 |
| `precheck_failed` | 来源版本预检未通过的运行时兜底 | 修配置 |

---

## 8. 一键演示与测试

```bash
# 端到端演示：预检 → 两批导入 → 幂等去重 → 映射修正 → 失败重试 → 重跑复核
python3 demo/run_demo.py

# 崩溃安全演示（提交前注入中断，验证 current 不变）
PYTHONPATH=. python3 demo/crash_demo.py

# 全部单元与端到端测试（33 个用例，纯标准库）
python3 -m unittest discover -s tests
```
