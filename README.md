# 本地巡检单采集系统

纯本地运行的设备巡检单（两种固定版式）扫描采集系统。**不使用任何云端 OCR**：
方向检测、去斜、透视校正、版式识别、区域 OCR 全部由本地 Tesseract + OpenCV 完成。

## 核心能力

1. **先识别版式再校正/提取**：OSD 检测 90/180/270° 方向，Hough 估计小角度倾斜并去斜，
   页面角点检测（凸包四边形 + 多级降级）后做透视归一化，最后用锚点模糊匹配识别版式。
2. **按区域关联字段，绝不按 OCR 文本顺序塞表**：字段与模板归一化区域绑定，
   每个字段保存来源坐标多边形（可反算回原图）。
3. **人工确认队列**：低置信度、编号/日期格式错误、数值单位冲突、OCR 无结果
   一律标记 `needs_review`，不做静默猜测。
4. **空白字段不填零**：空白单元格 `value=None`、状态 `blank`，CSV 导出为空字符串，
   只有真实读到 0 才保留 0。
5. **校正页面可核对/修改并保存来源坐标**：Web 页面在原图叠加字段框，支持点选 4 点
   更新来源坐标、修改字段值、确认字段。
6. **重识别保留人工值与完整修订历史**：重新识别时 `manual=True` 的字段保留人工值，
   仅刷新坐标，每次修改写入 revisions 表。
7. **批量采集 + 结构化导出**：CLI 批量处理目录，导出 JSON（含坐标、置信度、修订历史）
   与 CSV（空白保持空，不写 0）。

## 目录结构

```
inspect_ocr/
  config.py        # 画布尺寸、置信度/勾选阈值、本地 Tesseract 语言
  templates.py     # 两种版式的字段区域（归一化坐标）与锚点定义
  preprocess.py    # 方向检测、Hough 去斜、角点检测、透视归一化、坐标反算
  classifier.py    # 整页 + 标题带锚点匹配的版式识别
  ocr.py           # 本地 Tesseract 封装、去噪、紧边裁剪、多假设投票
  extractor.py     # 区域级 OCR、勾选几何判定、空白/格式/单位规则校验
  models.py        # 字段结果、页面结果、修订记录数据模型
  database.py      # SQLite 持久化（页面/字段/修订历史）
  pipeline.py      # 单页处理主管线与重识别（人工值保留）
  exporter.py      # JSON / CSV 结构化导出
  generate.py      # 合成样本：倾斜、透视、噪声、缺页角、空白字段
  webapp.py        # Flask 本地校正页面（仅监听 127.0.0.1）
  cli.py           # 命令行入口
tests/             # pytest 测试（33 个）
tessdata/          # 本地语言模型（eng / chi_sim / osd）
```

## 安装与运行

```bash
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
# 系统需安装 tesseract（macOS: brew install tesseract）
# tessdata/ 已随项目放置 eng/chi_sim/osd 模型，无需联网下载
```

生成含退化的合成样本（含 ground truth JSON）：

```bash
python -m inspect_ocr.cli generate --count 20 --out data/samples
```

批量采集并导出：

```bash
python -m inspect_ocr.cli collect data/samples --out data/exports
python -m inspect_ocr.cli list
python -m inspect_ocr.cli export --format all
python -m inspect_ocr.cli reprocess <page_id>
```

启动本地校正页面：

```bash
python -m inspect_ocr.webapp   # http://127.0.0.1:5050
```

## 测试

```bash
python -m pytest tests/ -q
```

测试覆盖：样本退化注入、方向/透视/坐标往返、版式识别、字段定位与识别结果、
空白不填零、单位/格式冲突进人工、编号/日期校验、人工修订、重识别人工值保留、
CSV/JSON 导出、Web 路由。

## 设计约束与降级策略

- 角点检测按 `轮廓四边形 → 凸包内框 → Hough 直线 → 整图兜底` 多级降级，
  缺页角/断裂边框下尽量恢复，无法恢复时整页转人工而非编造字段。
- 勾选项用连通域填充比例的绝对+相对双阈值几何判定，不依赖识别勾号字符。
- 中文短文本用多预处理/PSM 假设投票；数值用 eng 并做小数点几何恢复，
  编号/日期用结构化正则强校验。
- 版式无法识别时不产生任何字段（`fields={}`），从源头避免错误关联。
