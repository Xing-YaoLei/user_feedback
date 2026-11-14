# EML 检测明细采集

从邮件目录（或单个 EML 文件）中提取实验室检测明细 CSV，输出为 JSONL。
仅使用 Python 标准库，无第三方依赖。

## 用法

```sh
python3 eml_csv_scan.py <邮件文件或目录> [-o records.jsonl] [-e errors.jsonl] \
    [--no-recursive] [--quiet]
```

- 目录默认递归查找 `*.eml`（扩展名不区分大小写），跳过其他文件。
- `-o/--records`：有效记录输出，默认 `records.jsonl`。
- `-e/--errors`：问题输出，默认 `errors.jsonl`。
- 结束时会向 stdout 打印一行 JSON 汇总（可用 `--quiet` 关闭）。

## 采集规则

- **只看外层邮件**：遍历外层邮件的全部 MIME 部件，附件可以位于任意层级的
  `multipart/*` 正文中（`mixed`、`related`、`alternative` 等）。
- **跳过转发邮件**：`message/rfc822`（或任何 `message/*`）部件，以及文件名以
  `.eml`/`.email` 结尾的叶子附件，视为“作为附件转发的整封邮件”，连同其内部
  所有内容一并跳过。
- **CSV 附件识别**：文件名以 `.csv` 结尾，或 `Content-Type` 为
  `text/csv` 及其常见变体（`application/csv`、`text/x-csv` 等）。普通正文
  （`text/plain`）即使内容像 CSV 也不会被采集。
- **同名附件**：同一封邮件里的两个附件即使文件名相同也各自独立处理，
  `part_index` 可区分。
- **传输编码**：支持 `base64` 与 `quoted-printable`，以及未编码的
  `7bit`/`8bit`/`binary`；缺失或补位不规范的 base64 会按严格规则校验。
  其他 `Content-Transfer-Encoding` 视为解码失败。
- **字符集**：以该部件 `Content-Type` 中声明的 `charset` 为准；
  **未声明时按 UTF-8 读取**（不采用邮件标准的 us-ascii 历史默认）。
- **CSV 格式**：RFC 4180（支持带引号字段、字段内逗号与换行、CRLF/LF）；
  首个非空行是表头，空行不产生记录但仍计入物理行号。

## 输出

### records.jsonl（有效记录）

每行一个 JSON 对象：

| 字段 | 含义 |
| --- | --- |
| `sample_id` | 样件号 |
| `test_item` | 检测项目 |
| `reading` | 读数（JSON 数字，保留原始精度） |
| `source_email` | 来源邮件（相对采集目录的路径；单文件时为文件名） |
| `attachment_name` | 附件文件名（可能为 `null`） |
| `part_index` | 部件序号：从 1 开始按先序遍历编号（根为 1）；转发的整封邮件算作一个部件，其内部不再编号 |
| `csv_line` | 记录在 CSV 中的物理行号（从 1 开始，表头通常为 1） |

表头支持中英文常见别名（如 `样件号`/`sample_id`、`检测项目`/`test_item`、
`读数`/`reading`），并忽略大小写、空白、下划线、连字符及括号内的单位/备注。

读数必须是有限十进制数（允许正负号、小数、科学计数法）。
`ND`、`N/A`、`NaN`、`Infinity`、`12%`、`12,5`、空值均视为无效读数。

### errors.jsonl（问题）

每行一个 JSON 对象，字段为
`error_type`、`source_email`、`attachment_name`、`part_index`、`detail`，
外加与该类型相关的附加字段。

| `error_type` | 含义 | 附加字段 |
| --- | --- | --- |
| `attachment_decode_failure` | 附件整体无法解码：传输编码解码失败或字符集解码失败 | `stage`（`transfer_encoding` / `charset`） |
| `missing_required_columns` | CSV 缺少必需列（或附件为空） | `missing_columns`、`headers`、`header_line` |
| `invalid_reading` | 读数无效 | `csv_line`、`raw_reading` |
| `missing_required_value` | 样件号或检测项目为空 | `csv_line`、`missing_fields` |
| `malformed_row` | 该行列数与表头不一致 | `csv_line`、`expected_columns`、`actual_columns` |
| `csv_parse_failure` | CSV 解析器在该附件中途失败 | — |
| `attachment_unreadable` | 读取附件时出现意外异常 | `stage` |
| `email_parse_failure` | 整封邮件无法读取（不影响其他邮件） | — |

### 隔离性

- 一个附件解码失败，不会影响同一封邮件中的其他附件。
- 一行数据有问题，不会影响同一附件中的其他有效行（有效行照常写入）。
- 一封邮件无法解析，不会影响其他邮件的处理。

## 测试

```sh
python3 -m unittest test_eml_csv_scan -v
```
