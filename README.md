# user_feedback

## match_scans_photos.py — 扫描记录 ↔ 照片匹配（漏拍修复）

修复台连扫两件档案时相机偶尔漏拍一张，按顺序编号会错配。本工具按
最优匹配重新配对，只导出所有最优配法都认可的确定配对，其余交修复员核对。

### 规则

- 候选：同一工位且 |时间差| ≤ 1500ms（可用 `--window-ms` 调整）
- 每次扫描、每张照片最多使用一次
- 以工位为单位：先最大化匹配数，再最小化已匹配记录的时间差总和
- 若最优配法有多种，只导出所有最优配法都同意的配对

### 输入

- 扫描 CSV：`scan_id,archive_id,station,timestamp_ms`（列名可用 `--scan-cols` 改）
- 照片 JSONL：`{"photo_id","file_path","station","timestamp_ms"}`（键名可用 `--photo-cols` 改）

### 用法

```bash
python3 match_scans_photos.py --scans scans.csv --photos photos.jsonl --out-dir out
```

### 输出

| 文件 | 内容 |
|---|---|
| `matches.csv` | 确定配对清单，可直接导入档案系统 |
| `review.csv` | 未匹配扫描，状态分三种：`no_candidate`（无候选）、`never_matched`（有候选但所有最优配法都未匹配）、`disputed`（最优配法间有分歧）；分歧记录列出涉及的候选照片供核对 |
| `unused_photos.csv` | 任何最优配法都用不到的照片（信息性） |

### 示例

`examples/` 下的样例数据覆盖五种典型情形（正常一一对应、两扫抢一张、
无候选、唯一最优、两种最优配法平局）：

```bash
python3 match_scans_photos.py --scans examples/scans.csv --photos examples/photos.jsonl --out-dir out
```
