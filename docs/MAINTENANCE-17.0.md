# V17.0 维护说明与注释导航

## 代码结构

| 文件 | 职责与维护边界 |
| --- | --- |
| app/index.html | 原始界面、XLSX 读取与精确模板回填、SKU 匹配、国家状态、多库选择及价格预览。内联脚本有先定义后覆盖的历史结构，修改时须检查最后生效的定义。 |
| app/themes.css / themes-runtime.js | 五套主题、字体和按钮外观；子页面同步，外观独立于业务控价。 |
| app/desktop-enhancements.js / .css | 桌面窗口按钮、表面样式与交互；不在这里改 SKU 价格逻辑。 |
| electron/window-surface.js | Windows 工作区适配、模拟最大化与还原、八方向尺寸变化、定时器清理；透明仅用于外角 alpha。 |
| electron/main.js / preload.js | 主进程窗口、IPC 桥、持久化与窗口表面状态同步。 |
| electron/database.js | SQLite 业务状态同步、历史归档、按国家及数据库过滤的控价快照。 |
| scripts/build-windows.cjs | Windows NSIS 构建入口，解决模板路径长度问题。 |
| scripts/update-windows-resources.cjs | 原生 exe 图标与版本资源更新。 |
| app/icons/application-icon.svg / build/icon.ico / icon.icns | 同一山峰图案的圆角应用图标和平台资源。 |
| tests/ | 控价边界、模板保持、关键词持久化、外观、窗口与多数据库回归。 |

## 控价隔离必须保持的约束

国家状态使用 `lazadaOpsPhilippinesSystemV8`、`lazadaOpsThailandSystemV8`、`lazadaOpsMalaysiaSystemV8`；国家内通过 `database_id` 区分本土与跨境等库，普通与泳池通过 `library_type` 区分。国家不是数据库名称，数据库名称也不能用作稳定 ID。

`databaseSelections` 分别记录 `controlDatabase`、`controlImportDatabase`、`actDatabase`、`repDatabase`。控价管理与导入选择同步；活动和全店改价各自选择。控价导入必须先捕获目标库，接受行、冲突及嵌套冲突明细均打上目标 ID；不得回退写入国家默认库。

分析捕获国家、state 和控价数组引用，异步读取结束后校验仍属于同一上下文。导出也要校验会话是否过期。只检查下拉框当前值不足以排除跨国或数据替换造成的旧结果。改价索引不得跨库复用。

`snapshotLibrary` 以数据库 ID 和普通/泳池类型归档，每组保留 24 个版本。清空、删除、恢复只处理所选库。无法识别旧记录归属时建立历史恢复库；不得猜测本土/跨境归属。SQLite `pricing-scoped-v2` 元数据用于触发新版分库归档，避免旧版哈希阻止重新迁移；跨国 ID 使用国家前缀。

## 全店改价与模板边界

`repricingProtectEarlyBird` 缺省为 true；关闭时空白 SpecialPrice 进入原匹价流程。此开关只取消空白保护，不跳过冲突、无效价格及未匹配检查。组合 SKU 优先直接控价，未命中才拆分组件并乘数量合计。马来西亚使用菲律宾规则，泰国保留既有后缀与尾码规则。

导出只写允许的 SpecialPrice 单元格，不重建整份工作簿。原 Price、SKU、隐藏工作表与其他 ZIP 部件必须保持。预览分页不能限制导出数量。测试价格均为合成受控值，不可上传平台。

## 窗口与外观

不要重新引入 clientX/clientY 加主进程 setPosition 的拖动链，窗口位移会反过来改变坐标并造成抖动。Windows 当前方案使用 Chromium 抗锯齿角部表面，避开二值 SetWindowRgn 裁剪；尺寸按 16ms 采样并只在边界改变时更新，失焦和关闭时清理定时器。最大化/还原及小屏幕适配见 window-surface.js。

Mac 截图或 Windows 表面渲染截图只能证明渲染逻辑，不能代替 Windows 10 原生窗口、DPI、任务栏、拖动和安装升级验收。字体授权必须随仓库和安装包保留。

## 运行和回归

开发 `pnpm install --frozen-lockfile` 后 `pnpm start`；构建 `pnpm dist:win`。Electron 支持 node:sqlite，普通旧版 Node 不一定可直接运行数据库测试。可以使用 Electron 自带运行时：

```sh
ELECTRON_RUN_AS_NODE=1 pnpm exec electron tests/window-surface.cjs
ELECTRON_RUN_AS_NODE=1 pnpm exec electron tests/database-pricing-scopes.cjs
LAZADA_TEST_STORE=/path/store.xlsx LAZADA_TEST_COMBO=/path/combo.xlsx pnpm exec electron tests/regression.cjs
LAZADA_KEYWORDS_TEST_OUTPUT=/tmp/lazada-keywords pnpm exec electron tests/keywords.cjs
pnpm exec electron tests/appearance.cjs
```

`tests/multi-database.cjs` 需要 `LAZADA_MULTI_OUTPUT` 指向含 local.xlsx、cross.xlsx、conflict.xlsx、activity.xlsx 的测试目录；入口设置隔离 appData，验证三国各两库、重载、截图与报告。数据需按 renderer 脚本中的预期列和合成价格准备，不使用生产数据库。`surface-visual.cjs` 用于表面渲染截图；环境参数见各测试入口。

## 未完成事项

公司 MCP 仅做过只读 SKU 与控价查询，尚未接入此软件；在线改价已暂停。现有功能是本机控价与 Excel 导出。原版本机接口访问认证与自动化文件夹授权问题仍保留在安全审查记录中，不能写成已修复。未来业务修复须另增版本并更新公告与安装包。
