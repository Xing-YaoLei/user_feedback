# user_feedback

## encoding_vault — 历史资料网页的证据保留式采集与解码

针对编码声明错误的历史资料网页（UTF-8 / GB18030 混合、响应头 / BOM / meta
声明冲突、截断多字节字符、重复转码乱码）的采集与解码流水线。

### 核心原则

1. **原始字节独立保存**：抓取内容按 SHA-256 存为 `data/raw/<sha>.bin`，
   任何后续环节只读不改；响应头等取证元数据存于同名 `.json`。
2. **不轻信声明**：响应头、BOM、HTML meta 三类声明全部记录并检测冲突；
   候选编码按评分（常用汉字占比、不可逆替换数、高位拉丁字符等）选择。
3. **绝不静默丢字节**：全程 `errors='replace'` + 逐条日志，禁用 `ignore`；
   每处 U+FFFD 都记录字节区间、原始字节、原因和字符位置。
4. **人工可介入**：证据不足时状态为 `needs_review`，可指定编码重新解析，
   每次解析产生新版本（v1、v2…），旧版本产物全部保留。
5. **下游绑定解码版本**：结构化记录（姓名/日期/编号/数字等）都带
   `decode_version` 与字符偏移；改编码后本页记录全部重算，历史快照留存。

### 快速开始

```bash
# 端到端演示：生成样本站 → 起本地服务 → 采集 → 解码 → 出报告
python3 -m encoding_vault.cli demo

# 或分步执行
python3 -m encoding_vault.cli gen-samples --out samplesite
python3 -m encoding_vault.cli serve --site samplesite --port 8765 &
python3 -m encoding_vault.cli fetch http://127.0.0.1:8765/gb-as-utf8.html
python3 -m encoding_vault.cli decode <sha256>
python3 -m encoding_vault.cli override <sha256> gb18030   # 人工指定编码重解析
```

### 产物布局

```
data/
  raw/<sha>.bin|.json        # 原始证据字节 + 取证元数据
  decode/<sha>/vN.{json,txt,map.json}   # 每版解码：证据、候选、替换位置、字节映射
  records/<page>.jsonl       # 结构化记录（绑定 decode_version）
  records/history/           # 各版本记录快照
  report/<page>__vN.html     # 原始字节 ↔ 文本定位对照页面
  overrides.json             # 人工指定编码登记
```

### 样本站覆盖的故障模式

| 样本 | 故障 |
|---|---|
| ok-utf8 | 三方声明一致（对照组） |
| gb-as-utf8 | GB18030 字节谎称 UTF-8 |
| bom-vs-meta | UTF-8 BOM 与 meta gb2312 冲突 |
| truncated-gb | 末尾多字节字符被截断 |
| double-encoded | UTF-8→latin-1→UTF-8 重复转码乱码 |
| gb18030-4byte | 声明 gb2312 实含 GB18030 四字节字 |

### 回归测试

```bash
python3 -m unittest discover -s tests -v
```

14 个测试锁定：原始字节不被改动、乱码可被正确恢复、截断字节留痕、
中文/人名/数字在结构化记录中逐字一致、字符偏移可回切验证、
人工指定编码后记录按新版本重算且旧版本保留。
