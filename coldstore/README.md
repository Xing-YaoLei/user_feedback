# 冷库网关批次接收程序（coldstore）

接收冷库网关上送的批次文件。每个批次是一对同时到达 `inbox/` 的文件：

```
inbox/{网关编号}_batch{批次号}.zip
inbox/{网关编号}_batch{批次号}.json
```

JSON 清单记录网关编号、从 1 开始的批次号，以及 ZIP 内每个 CSV 成员的
文件名、字节数和 SHA-256。两份文件凑齐后才校验；校验通过的批次按网关、
严格按批次号顺序发布，下游始终只看到完整的整批目录。

## 运行

```bash
# 守护模式：每 5 秒扫描一次 inbox
python3 -m coldstore.cli scan --root /var/lib/coldstore

# 单次扫描后退出（适合 cron / 一次性处理）
python3 -m coldstore.cli scan --root /var/lib/coldstore --once

# 新文件需稳定（大小/mtime 不变）的时长，默认 2 秒
python3 -m coldstore.cli scan --root /var/lib/coldstore --stable-seconds 2
```

## 查询

```bash
python3 -m coldstore.cli status          --root <root>   # 每网关状态汇总与下一期待批次
python3 -m coldstore.cli list-missing    --root <root>   # 缺件：只到了一半的配对
python3 -m coldstore.cli list-bad        --root <root>   # 坏包：凑齐但校验失败
python3 -m coldstore.cli list-gaps       --root <root>   # 缺号：完全没有任何记录的批次号
python3 -m coldstore.cli list-conflicts  --root <root>   # 已发布批次收到不同内容
python3 -m coldstore.cli list-duplicates --root <root>   # 相同内容的重复到达
python3 -m coldstore.cli receipt --root <root> --gateway gw-7 --batch 41
```

所有查询都支持 `--gateway <编号>` 限定单个网关，输出为 JSON。

## 目录布局

```
<root>/
├── inbox/                       # 扫描目录，网关把 ZIP/JSON 投递到这里
├── staging/{gw}/batch{N}.tmp-*  # 解压工作区，发布成功后即删除
├── published/{gw}/batch{N}/     # 发布目录，整批 rename 原子切换，下游只读这里
├── receipts/{gw}/receipt_batch{N}.json   # 回执（含清单与内容哈希），重启恢复依据
└── state/coldstore.db           # SQLite 状态库（批次状态行 + 事件流水）
```

## 批次状态机

| 状态 | 含义 |
|------|------|
| `incomplete` | 缺件：ZIP/JSON 只到了一份，等待另一份 |
| `bad` | 坏包：两份凑齐但校验失败，原文件保留以便网关补传 |
| `validated` | 校验通过，但因前面有缺号而暂存，对下游不可见 |
| `published` | 已整批发布，下游可见 |
| `conflict` | 已发布批次又收到**不同内容**，已发布目录保持不变，外来文件留存为证 |

三类问题严格区分，可分别查询：

- **缺件**（`list-missing`）：配对不完整；
- **坏包**（`list-bad`）：配对完整但 ZIP 损坏、哈希/字节数不符、成员集合不一致等；
- **缺号**（`list-gaps`）：在已见批次范围内、完全没有任何文件到达的批次号。

## 关键行为

- **乱序到达**：批次 42 可以先收件并通过校验，但在 41 发布前一直停在
  `validated`，不会出现在 `published/` 下；41 补齐后自动按序连续发布。
- **整批原子可见**：先解压到 `staging/`，再用一次 `rename` 把成品目录切到
  `published/`，下游不会看到半个批次。
- **网关独立**：每个网关各自维护"下一期待批次号"，一个网关的缺号不阻塞其他网关。
- **重复 vs 冲突**：内容由确定性的 `content_hash`（网关+批次号+成员名/字节数/
  SHA-256，与成员顺序、十六进制大小写无关）标识。
  - 相同批次相同内容重到 → 记 `duplicate`，沿用并保留原回执，清理新到副本；
  - 相同批次不同内容重到 → 记 `conflict`，已发布目录与原回执绝不改动。
- **补传**：`bad`/`incomplete`/`conflict` 的批次，网关用正确文件重新投递即可
  自动修复；冲突状态下补回与已发布内容一致的文件，状态恢复为 `published`。
- **重启恢复**：发布目录 + 回执是持久真相。进程重启后重新扫描，从已发布批次
  接着推进；即使 SQLite 丢失，也能仅凭 `published/` 与 `receipts/` 重建状态。
  已记录的冲突在重启对账时不会被抹掉。

## 校验规则

- 清单必须是合法 JSON，且 `gateway_id`、`batch_no` 与文件名一致（批次号 ≥ 1）；
- ZIP 必须能打开、CRC 全部正确，成员集合与清单完全一致（无多余、无缺失、无目录项）；
- 每个成员的字节数、SHA-256 逐一核对；
- 拒绝路径穿越（`../`、绝对路径、反斜杠）等不安全成员名，解压只写扁平文件名。

## 测试与演示

```bash
python3 -m unittest discover -s tests -t .          # 24 个单元/集成测试
python3 demo/demo_41_42.py /tmp/coldstore-demo      # 41/42 乱序端到端演示
```

演示覆盖：42 先到被暂存、41 半件缺件、40 坏包、补齐后按序发布、
重复沿用回执、异内容记冲突且已发布批次不变、新进程重启后状态完整恢复。
