# user_feedback — 标注导入与版本迁移管线

训练管线只读取访谈的最终修订版，但审核员的标注可能基于初稿或任何中间版本。
本工具重建每份文档的版本链、校验全部摘要，并把标注从其来源版本迁移到最终文本；
无法自动迁移的标注进入人工复核，并指出首个冲突的版本与操作。

## 运行

```bash
python3 importer/importer.py \
  --drafts      sample_data/drafts \
  --revisions   sample_data/revisions.jsonl \
  --annotations sample_data/annotations.jsonl \
  --out         sample_data/out
```

无第三方依赖，需要 Python 3.10+。建议以隔离模式运行读取不可信数据的命令：
`python3 -I importer/importer.py ...`。

## 输入约定

### 1. 初稿目录 `--drafts`

每份文档一个 `<doc_id>.txt`，UTF-8 编码，允许 CRLF 行尾。

- **初稿摘要 = 原始字节的 SHA-256**（在任何规范化之前计算）。
- 摘要核对通过后才把 `CRLF` 规范化为 `LF`（孤立的 `\r` 不动），得到版本 0。

### 2. 修订流水 `--revisions`（JSONL，按文档排列）

同一文档的记录必须连续出现，每条修订记录：

```json
{
  "doc_id": "doc1",
  "parent_digest": "<父版本 SHA-256>",
  "post_digest":   "<修订后 SHA-256>",
  "ops": [ {"type": "insert", "position": 6, "text": "..." } ]
}
```

- 版本 0 之后的所有摘要均为**规范化文本 UTF-8 编码的 SHA-256**。
- 同组操作的区间都基于**修订前**规范化文本的**码点坐标**，按位置排序且互不重叠；
  插入文本只允许 LF 行尾。
- 操作类型：
  - `insert`：`position` 为插入点（`0..len`），字段 `text`
  - `delete`：`[start, end)` 右端不包含
  - `replace`：`[start, end)` + `text`
- 校验顺序：父摘要 → 操作合法性（越界 / 重叠）→ 应用 → 修订后摘要。
  任一失败即判定该文档版本链在当前版本出错，停止该文档并继续处理其他文档。

### 3. 标注流水 `--annotations`（JSONL）

```json
{
  "doc_id": "doc1",
  "version": "<来源版本 SHA-256>",
  "category": "word",
  "start": 0,
  "end": 5
}
```

- `start` / `end` 是**从零开始、右端不包含的 UTF-16 码元区间**（与 JS
  `substring` 语义一致；星平面字符占两个码元）。
- 字段名同时接受常见别名：`document_id`/`doc`、`version_digest`/`source_version`/
  `sha256`、`start_utf16`、`end_utf16`、`label` 等。

## 坐标与边界规则

### UTF-16 → 码点

- 标注区间先在其**来源版本**上解释为码点坐标，再逐版本迁移。
- 初稿标注额外检查两类非法边界，命中即人工复核：
  - 边界落在 **CR 与 LF 之间**（规范化后该位置消失）；
  - 边界把**代理对切成两半**（高/低代理项之间）。
- 后续版本只含规范化文本，因此只检查代理对切割。

### 迁移语义（逐修订、逐操作）

- 标注之前的编辑只平移坐标。
- **恰好插在标注两端的文字不纳入选区**：插入点 `p` 仅当 `start < p < end`
  （严格内部）才算冲突；`p == start` 或 `p == end` 只平移。
- 删除 / 替换与选区有任何码点重叠（`op.start < end && op.end > start`）即冲突，
  选区端点相接不算重叠。
- 冲突检测始终对照**修订前的原始区间**，避免前面操作造成的坐标漂移产生误判；
  复核记录给出首次冲突的版本摘要与组内操作序号 `conflict_op_index`。
- 同一文档的重叠标注彼此独立迁移，互不影响。

## 输出（`--out`）

| 文件 | 内容 |
| --- | --- |
| `migrated.jsonl` | 仍有效的标注：最终文本码点区间 `final_codepoint_range`、片段 `excerpt`，并保留 `category`、来源版本摘要、原始 UTF-16 偏移 |
| `review.jsonl` | 需人工复核的标注及原因（CRLF/代理对边界、删除或替换覆盖、区间内部插入、来源版本不在链中、版本链失败等） |
| `chain_errors.jsonl` | 每条断链文档一条：首个出错版本号（0 = 初稿，1 = 第一次修订）与原因 |
| `summary.json` | 文档数、断链数、标注总数、迁移数、复核数 |

一条版本链失败只影响该文档；其他文档继续导入。

## 测试

```bash
python3 -I tests/test_pipeline.py     # 21 个单元 / 端到端测试
python3 -I tests/make_sample.py       # 重新生成 sample_data/
```

测试覆盖：CRLF 规范化与边界切割、代理对切割、星平面字符的 UTF-16↔码点换算、
插入端点不纳入选区、删除/替换重叠冲突、多操作组内首个冲突定位、坐标漂移误判防护、
重叠标注独立迁移、原始字节摘要核对、断链在首个出错版本报告且隔离其他文档、
按文档排列校验与 CLI 运行。
