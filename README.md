# 设备测量数据转换工具

质检收到的设备模板中，同一列名（如 `L`）在不同模板版本里单位不同（旧模板毫米、新模板英寸）。
本工具按 **JSON 字段字典** 把设备导出的宽表 CSV 展开为统一标准单位的测量明细，
新增模板时维护人员只需更新字典，无需改动代码。

## 用法

```bash
# 批量处理一个目录下的全部 CSV
python3 convert.py --dict dictionary.json --csv-dir samples --out out

# 或指定若干文件
python3 convert.py --dict dictionary.json --out out a.csv b.csv
```

仅依赖 Python 3 标准库。输出目录下生成三个文件（UTF-8 带 BOM，可直接用 Excel 打开）：

| 文件 | 内容 |
|---|---|
| `measurements.csv` | 合格测量明细：样件号、测量项、标准值、标准单位、模板版本、原文件、行号、列名、原值、原单位 |
| `rejections.csv` | 拒收清单：空值 / 非数字 / 超范围（另含"缺列"，即字典声明的列在 CSV 中不存在），附原文件、行号、列名、原值 |
| `unknown_versions.csv` | 模板版本无法识别的行，整行单独列出，不产生任何明细 |

处理规则：

- 每行按 `模板版本` 列选择字典中对应版本的列映射；
- 先做十进制换算（`Decimal`：标准值 = 原值 × factor），**再**按标准单位的 [min, max] 闭区间判断；
- 某个测量项被拒收不影响同一行其他合格测量项照常输出；
- 行号指 CSV 文件中的物理行号（表头为第 1 行）。

## 字段字典（dictionary.json）

```json
{
  "sample_id_column": "样件号",
  "version_column": "模板版本",
  "versions": {
    "TPL-2.0": {
      "columns": [
        {
          "source_column": "L",        // CSV 中的原列名
          "item": "长度",              // 标准测量项
          "source_unit": "in",         // 原单位（仅记录用）
          "standard_unit": "mm",       // 标准单位
          "factor": "25.4",            // 换算系数：标准值 = 原值 × factor
          "min": "90",                 // 允许范围下限（标准单位，可省略或为 null）
          "max": "110"                 // 允许范围上限（标准单位，可省略或为 null）
        }
      ]
    }
  }
}
```

### 新增模板版本

1. 在 `versions` 下以设备导出的版本字符串为键新增一节；
2. 为每个需要转换的列添加一条映射，填好 `factor`（如英寸→毫米为 `"25.4"`，无需换算为 `"1"`）；
3. 数值一律写成字符串，保证十进制精确换算；
4. 保存后先跑一次工具：若同一版本内两列映射到了同一测量项，工具会在**处理任何数据之前**报出冲突并以退出码 2 停止，修正字典后重跑即可。

## 示例

`samples/` 下有两份示例导出（`TPL-1.0` 毫米、`TPL-2.0` 英寸，覆盖空值、非数字、超范围、未知版本等情形），
`dictionary.json` 为对应字典。运行：

```bash
python3 convert.py --dict dictionary.json --csv-dir samples --out out
```

例如 `TPL-2.0` 行中 `L=3.937`（英寸）会换算为 `99.9998 mm` 后按 90–110 mm 判定；
同一行 `L` 超范围被拒收时，`W` 合格仍照常输出明细。
