# Vernier

Electron 桌面工具：读 CSV / XLSX / Parquet → 只读表格预览 → 选列 → 出图 → MATLAB 式缩放 / 数据游标。

第一版刻意只做这条主线，把交互手感放在第一位；编辑、公式、多 sheet 联动留待后续。

## 快速开始

```bash
npm install
npm run gen:sample        # samples/signals_1m.csv (100 万行), small.csv, workbook.xlsx
npm run dev               # 开发模式
npm test                  # 单元测试 (vitest)
npm run e2e               # 构建并用 Playwright 驱动真实 Electron 窗口
npm run dist:dir          # electron-builder 打包 (当前平台, 未压缩目录)
```

## 发布

**版本号来自 git tag**，`package.json` 里的 `0.0.0` 只是占位。`scripts/version.mjs` 规则：

| 情况 | 版本号 |
|---|---|
| CI 中由 tag `v1.2.3` 触发（`APP_VERSION`） | `1.2.3` |
| HEAD 恰好在 tag `v1.2.3` 上 | `1.2.3` |
| tag 之后又有 3 个提交 | `1.2.4-dev.3+g<sha>` |

构建时注入主进程、preload 与渲染进程（`__APP_VERSION__`），打包时写入安装包元数据（`-c.extraMetadata.version`）。

推送 `v*` tag 触发 `.github/workflows/release.yml`：校验（tag 格式、类型检查、单元测试）→
macOS（x64 + arm64 的 dmg/zip）、Windows（x64 NSIS 安装包）、Linux（x64 AppImage）并行打包 →
创建 GitHub Release，附带 SHA256SUMS 以及应用内升级所需的 `latest*.yml` / blockmap。

```bash
git tag v0.2.0 && git push origin v0.2.0
```

构建未签名：macOS 首次打开需右键「打开」，Windows 可能出现 SmartScreen 提示。

## 版本检测与升级

- 启动后自动检查 GitHub 最新 Release（可在「关于」中关闭），有新版本时标题栏出现提示
- **Windows（NSIS）/ Linux（AppImage）**：应用内下载（electron-updater，显示进度）→「重启并安装」
- **macOS**：未签名的应用无法原地替换，升级按钮直接打开对应架构的 `.dmg` 下载
- macOS 应用菜单「检查更新…」，或点击状态栏右下角版本号打开「关于」

## 界面

- 自绘标题栏：logo、打开文件、数据集 / 工作表切换、当前文件名、更新提示、外观切换、关于；macOS 保留红绿灯，Windows / Linux 保留原生窗口按钮（随主题变色）
- 外观：浅色（默认）/ 深色 / 跟随系统，同步到原生主题
- 关于：版本、作者 [Jelatine](https://github.com/Jelatine)、仓库地址、运行环境
- logo 源在 `scripts/gen-icons.mjs`，`npm run gen:icons` 生成 icns / ico（含安装包图标）/ Linux png / 界面 SVG

## 三层架构

```
表格 UI (AG Grid, 无限行模型)          绘图引擎 (uPlot + 自绘层)
        │  RowRange {start,end}                 │  SeriesRequest {tableId, x, ys}
        ▼                                       ▼
            列式数据核心 (DuckDB-WASM worker + Arrow)
```

三层之间只传引用：`tableId`、列 ID（`c0..cN`）、行区间。表格按可见区间取一块显示单元格；
绘图拿到的是 `Float64Array` 列。没有任何一层持有整表的 `Array<Object>`。

| 建议 | 实现 |
|---|---|
| 列式存储，不用 `Array<Object>` | 数据只在 DuckDB-WASM（独立 worker + WASM 堆）里；取出时是 Arrow → `Float64Array`（单块无空值时零拷贝视图）。`src/renderer/src/core/DataCore.ts` |
| DuckDB-WASM 做分析 | CSV/Parquet 通过 `BROWSER_FILEREADER` 懒读取直接进 DuckDB；侧栏 SQL 面板对原列名视图写 SQL，结果物化为新数据集 |
| 字符串字典编码 | XLSX 在 worker 中直接组装 Arrow 列：数值 Float64、文本 `Dictionary<Utf8, Int32>`。`core/xlsxConvert.ts` |
| 解析放 Worker，transferable 零拷贝 | XLSX 字节 transfer 给 worker，Arrow IPC 结果再 transfer 回来；拖放 / 文件选择的 `File` 句柄直接交给 DuckDB，不经 IPC |
| 坐标变换只写一份 | `plot/scale.ts` 的 `Scale`：`dataToPx / pxToData / zoomAt / pan / zoomToPxRect`，所有交互和游标定位都走它 |
| 滚轮以光标为锚点，Ctrl/Shift 单轴 | `Scale.zoomAt`；在 X 轴 / Y 轴区域滚动也只缩放该轴 |
| 最近点：有序二分，散点网格 | `plot/nearest.ts`：`nearestSorted`（二分 + 双向剪枝）、`GridIndex`（均匀网格环形搜索） |
| 降采样与取点分离 | 渲染用 M4（每像素列 first/min/max/last，`plot/decimate.ts`）；取点永远回原始数组，游标给出真实行号 |
| 双阶段重绘 | 交互中下一帧用 1/4 分辨率 M4，停止 100 ms 后全精度（像素级精确或原始点） |
| 游标可固定，存 `{seriesId, index}` | `DataTip` 只存样本引用，缩放/平移后由 `Scale` 重新定位；可拖动沿曲线移动 |
| contextIsolation + preload | `contextIsolation: true`、`sandbox: true`、`nodeIntegration: false`；页面走自定义 `app://` 协议 + 严格 CSP（无 `unsafe-eval`） |
| electron-builder，无原生模块 | DuckDB 用 WASM 版，三平台同一份产物 |

## 交互（MATLAB 风格）

| 操作 | 效果 |
|---|---|
| 滚轮 | 以光标为锚点缩放；`Ctrl` 仅 X，`Shift` 仅 Y；在坐标轴上滚动只缩放该轴 |
| 拖动（浏览模式） / 中键拖动 | 平移 |
| `Shift`+拖动，或框选缩放模式（`Z`）拖动 | 框选缩放；框很扁 → 只缩放 X，很窄 → 只缩放 Y |
| 单击曲线（浏览模式） | 放置数据游标，表格自动滚动到对应行 |
| 拖动游标圆点 | 沿曲线移动（吸附原始样本） |
| 右键游标 / 选中后 `Delete` | 删除游标 |
| 双击 / `R` / ⌘0 | 复位坐标轴 |
| `F` | 按当前 X 范围自适应 Y |
| 方向键 / `+` `-` | 平移 / 缩放 |
| 图例单击 | 显示/隐藏曲线 |
| 表头单击 / ⌥单击 | 加入/移出 Y / 设为 X |

X 非单调时（如李萨如曲线）默认散点；切到"线"按行顺序连线（MATLAB `plot(x,y)` 语义），取点改用二维网格索引。
"分图"布局下每个 Y 一个坐标区，X 轴联动。

## 已验证的数据（本机 e2e）

- 100 万行 × 10 列 CSV：导入到出图 < 1 s；全量视图 M4 绘制约 4.4k 个顶点，单帧约 2 ms；保留每一个单样本尖峰，单击尖峰得到真实行号与原值
- 滚轮缩放后光标下数据坐标不变（误差 < 1e-6 视宽），游标 DOM 位置与样本像素一致

## 目录

```
src/main/            Electron 主进程：app:// 协议、CSP、菜单、系统打开文件
src/preload/         最小 bridge：菜单命令、系统打开的文件字节、ready
src/renderer/src/
  core/              DataCore (DuckDB-WASM)、Arrow 转换、XLSX worker
  grid/              TableView (AG Grid 无限行模型)
  plot/              Scale、decimate (M4)、nearest、PlotView (uPlot 包装 + 交互)
  main.ts            App：选择状态、布局、联动
tests/               单元测试
e2e/                 Playwright + Electron 端到端测试
scripts/gen-sample.mjs
```

## 后续路线

- 千万点级：OffscreenCanvas / WebGL 渲染层（`PlotView` 的自绘路径已与 uPlot 解耦）
- 大 XLSX 流式解析；多 sheet 同时加载
- 编辑、公式（评估 Univer）、ExcelJS 导出
- 多坐标区自由布局、第二 Y 轴改为分图、游标导出到表格
