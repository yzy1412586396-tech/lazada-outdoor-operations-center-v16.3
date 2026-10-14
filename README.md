# Lazada 户外运营中心 V18.1

当前最新版：**V18.1**（安装元数据 `18.1.0`）。本仓库名称中的 v16.3 是历史名称；旧版保留在 `archive/v16.3-transfer`，最新版位于 `codex/v18.1-inventory-labels`。

当前启用菲律宾、泰国两个国家，马来西亚入口暂时移除并保留既有数据。这是本地 Excel 运营工具：控价数据库、活动报名、全店 SpecialPrice 改价、库存识别、日报和费用管理。马来西亚历史实现与限制见 V17.0 更新说明。**没有接入公司 MCP 在线自动改价**，该功能已按用户要求暂停。

## 下载和安装

到 [最新 Release](https://github.com/yzy1412586396-tech/lazada-outdoor-operations-center-v16.3/releases/latest) 下载 Windows x64 安装包。退出旧版再覆盖安装；保持原应用身份和数据目录，不清理原有业务数据。升级前建议在应用内导出备份。Windows 安装包未签名；尚未完成 Windows 10 实机安装、四角和拖动验收，因此附件标记为候选安装包。

## 功能和改动说明

- [V18.1 预览优化](docs/UPDATE-18.1.md)：需下架筛选及原SKU对应的马帮中文名称。

- [V18.0 验证记录](docs/VALIDATION-18.0.md)：实际操作、四表导出、性能与平台验证边界。
- [V18.0 上下架、人工核对与黑名单](docs/UPDATE-18.0.md)：纠正active/inactive语义、缺货下架、下架有货人工确认、可编辑预览、按国家店铺SKU ID冻结和有货需关预售。
- [本轮窗口修正](docs/UPDATE-17.8.md)：合并到V18.0，未单独发布17.8。
- [V17.7 历史尝试](docs/UPDATE-17.7.md)：该版自定义窗口缩放未通过用户 Windows 10 实测，V18.0 已替换该方案。

- [V17.6 共用仓库与特殊SKU](docs/UPDATE-17.6.md)：国家共用模板、活动商品条件处理、特殊提示、跳过及关联替换。
- [V17.5 国家切换和关键字编辑](docs/UPDATE-17.5.md)：保留模块、按需刷新、来源缓存、关键字清空及重选。
- [V17.4 活动库存保护与清零规则](docs/UPDATE-17.4.md)：active保护、重复后缀自动分配、指定仓清零和完成行跳过。
- [V17.3 四表库存识别初版](docs/UPDATE-17.3.md)：预售保护、10件边界、后缀保留、组合同仓及正式导出拦截。
- [V17.3 验证记录](docs/VALIDATION-17.3.md)：真实四表、隔离与原模板核对。
- [累计改动记录](CHANGELOG.md)：V16.4、V16.8、V16.9、V17.0、V17.1、V17.2 的功能、修复和边界。
- [V17.2 活动提醒与交互说明](docs/UPDATE-17.2.md)：空价与报名资格提醒修复、红行置顶；V17.1 交互功能继续保留。
- [V17.0 多数据库使用说明](docs/UPDATE-17.0.md)：三国、本土与跨境控价库的选择及隔离。
- [维护者说明与代码导航](docs/MAINTENANCE-17.0.md)：关键实现、注释索引、数据边界和回归方法。
- [验证记录](docs/VALIDATION-17.2.md)：已验证项目、安装包校验和未验证范围。
- [原版模块说明](docs/FUNCTIONS.md)、[原版来源](docs/PROVENANCE.md)、[安全审查记录](docs/SECURITY_REVIEW.md)。后两份属于历史记录，不能当作当前构建配置。

## 开发和构建

使用 Node.js 22 或更新的兼容版本，以及支持 `pnpm-workspace.yaml` 中 `allowBuilds` 的 pnpm 版本；建议 pnpm 10。Electron 固定为 44.5.0，electron-builder 固定为 26.0.12。

```sh
pnpm install --frozen-lockfile
pnpm start
pnpm dist:win
```

Windows 构建产物写入 `dist/`。`scripts/build-windows.cjs` 缩短 NSIS 模板路径，避免依赖目录导致 260 字符路径限制；`scripts/update-windows-resources.cjs` 写入图标和版本资源。Mac 本地部署和 Windows 使用相同业务代码。Mac 签名安装器不在当前 Release 内。

程序从 V16.3 已打包运行时快照继续维护，部分历史业务代码保留在 `app/index.html` 的内联脚本中；本次补齐了依赖锁、构建脚本、字体授权和测试，不能将历史归档的不可重建说明套用到当前分支。

## 数据与授权

源码和 Release 不包含用户 SQLite 数据库、导入 Excel、备份、API 凭据或公司 MCP 查询结果。运行数据保存在 Electron userData 下。应用代码沿用 `UNLICENSED`，公开仓库不意味着授予开源使用许可；内置字体的独立 OFL 授权在 `app/fonts/`。

原版两项 P1 安全审查问题仍未在此维护版解决，详见安全审查记录。公开源码和安装包哈希不等于安全审查或 Windows 真机验收通过。
