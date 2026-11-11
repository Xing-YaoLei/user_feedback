# 地图测站采集机器人（Playwright 演练项目）

一个完全本地化的演练场：Leaflet 测试地图在浏览器中展示带聚合的测站标记，
Playwright 机器人**只通过可见地图与详情弹窗**采集测站资料，不读取任何页面内部数据对象、
不调用隐藏接口。

## 目录结构

```
map-app/                 本地测试地图（Leaflet + markercluster，离线假瓦片）
  index.html             页面骨架，所有状态通过 HUD/标记/弹窗等可见 DOM 呈现
  app.js                 地图逻辑：数据闭包、模拟移动加载延迟、重合聚合标红
  styles.css
  generated/stations.js  由生成器产出的本地数据集（不挂 window）
scripts/
  generate-data.mjs      确定性生成测站数据（含稀疏区、两个密集区、3 个不可展开重合组）
  serve.mjs              白名单静态服务器；data/ 真值目录不对外暴露
src/crawler/
  geo.ts                 Web Mercator 纯函数与覆盖网格/蛇形路径
  types.ts               状态与数据类型
  state.ts               断点续扫状态的原子读写、暂停信号文件
  map-controller.ts      浏览器交互层（仅 locator/mouse/keyboard 等可见操作）
  crawler.ts             两阶段采集编排：粗级聚合展开 + 最大级细网格覆盖
  report.ts              自包含 HTML 回看报告（覆盖网格、扫描路径、未完成聚合）
  cli.ts                 命令行入口
tests/                   Playwright 验收套件
data/ground-truth.json   验收真值（HTTP 服务根目录之外，机器人无法获取）
output/                  运行产物（状态、报告、暂停信号）
```

## 快速开始

```bash
npm install
node scripts/generate-data.mjs     # install 后会自动执行
node scripts/serve.mjs             # 启动测试地图 http://127.0.0.1:4321/
npm run crawl                      # 另开终端执行采集
npx playwright test                # 运行全部验收测试
```

## 机器人工作方式（红线）

采集器源码（`src/crawler/`）遵守以下约束，并由 `tests/architecture.spec.ts` 静态扫描强制：

- **禁止** `page.evaluate` / `addInitScript` / `exposeFunction` / CDP 等页面内执行；
- **禁止** 读取 `window`、`document`、`STATION_DATASET` 等内部对象；
- **禁止** fetch/XHR、网络拦截等任何隐藏接口，只能像真人一样操作浏览器；
- 允许的动作仅限：locator 定位可见元素、鼠标点击/拖拽/滚轮、键盘、读取可见文本。

机器人可观察的信息只有：HUD 上的缩放级别/中心经纬度/加载状态/标记计数、
屏幕上的标记与聚合（位置、数字、红色 stuck 样式）、点击后出现的详情弹窗。

## 采集策略

1. **粗级聚合展开（阶段一）**：在低缩放网格逐块进入，反复点击可见聚合让地图逐级放大，
   能分离的标记全部变成可点击的单个测站。
2. **最大级细网格覆盖（阶段二）**：以最大缩放视口的 90% 为步长建立带 10% 重叠带的细网格，
   边界分块向外 overscan 半格，蛇形逐屏移动、逐屏点开详情；每屏采集后清弹窗补采一轮。
   相邻分块重叠保证边缘标记不遗漏，重复编号自动去重。
3. **收尾补扫（阶段三）**：所有网格走完后重访各分块，给标记足够时间从缩放/重排动画的
   中间态恢复稳定，补采因动画态或弹窗遮挡而未打开详情的残余标记，保证不漏点。
4. **不可展开聚合**：坐标完全重合的测站在最大级别仍保持聚合（红色脉冲标记），
   地图弹出“无法分离”提示。机器人把它们登记为**未完成聚合**，
   报告中单独列出，**绝不估算成已采集**。
5. **加载延迟**：每次移动后页面先显示加载遮罩并进入“加载中”，机器人等待 HUD 回到
   “空闲”、标记集合稳定后才操作。
6. **暂停/恢复**：`touch output/pause.flag` 会在当前分块边界原子落盘并退出；
   `npm run crawl -- --resume` 从断点继续，已采集资料与未完成记录全部保留。
7. **视口变化**：恢复时检测视口尺寸变化，自动重建覆盖网格（旧覆盖标记重访、已采集资料保留）。

## 回看报告

`output/report.html` 是自包含 SVG 报告：覆盖网格（已覆盖/待覆盖）、
扫描路径（粗网格定位/细网格逐屏覆盖/聚合展开/采集点，颜色区分）、已采集测站层、
红色未完成聚合层，以及两张明细表。

## 验收测试

| 测试文件 | 验收内容 |
| --- | --- |
| `architecture.spec.ts` | 源码无隐藏接口/页面内执行；真值无法经 HTTP 获取；页面不泄露内部对象 |
| `completeness.spec.ts` | 对照真值：可采集测站不重不漏、字段一致；重合组全部登记未完成 |
| `pause-resume.spec.ts` | 中途暂停落盘 → 恢复后覆盖完整、无重复采集 |
| `viewport.spec.ts` | 960×600 小视口跑一半 → 1440×900 恢复，网格重建后依旧完整 |
| `regions.spec.ts` | 稀疏区域（6 点）与密集区域（53 点，经历聚合展开）分别验证完整性 |
| `report.spec.ts` | 报告网格/路径/未完成聚合层与状态文件数字自洽 |

## CLI 参数

```bash
npm run crawl -- --width 1280 --height 800   # 指定视口
npm run crawl -- --max-cells 6               # 只跑前 N 个细分块（调试）
npm run crawl -- --resume                    # 断点恢复
npm run crawl -- --report-only               # 用已有状态重建 HTML 报告
touch output/pause.flag                      # 请求在分块边界暂停
```
