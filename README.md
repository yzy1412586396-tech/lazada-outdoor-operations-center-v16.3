# Lazada 户外运营中心 V17.0

当前最新版：**V17.0**（安装元数据 `17.0.0`）。本仓库名称中的 v16.3 是历史名称；旧版保留在 `archive/v16.3-transfer`，最新版位于 `release/v17.0`。

这是菲律宾、泰国、马来西亚的本地 Excel 运营工具：控价数据库、活动报名、全店 SpecialPrice 改价、库存识别、日报和费用管理。马来西亚使用 MYR，SKU 匹配沿用菲律宾规则；日报及库存不代表已提供马来西亚专用模板。**没有接入公司 MCP 在线自动改价**，该功能已按用户要求暂停。

## 下载和安装

到 [最新 Release](https://github.com/yzy1412586396-tech/lazada-outdoor-operations-center-v16.3/releases/latest) 下载 Windows x64 安装包。退出旧版再覆盖安装；保持原应用身份和数据目录，不清理原有业务数据。升级前建议在应用内导出备份。Windows 安装包未签名；尚未完成 Windows 10 实机安装、四角和拖动验收，因此附件标记为候选安装包。

## 功能和改动说明

- [累计改动记录](CHANGELOG.md)：V16.4、V16.8、V16.9、V17.0 的功能、修复和边界。
- [V17.0 多数据库使用说明](docs/UPDATE-17.0.md)：三国、本土与跨境控价库的选择及隔离。
- [维护者说明与代码导航](docs/MAINTENANCE-17.0.md)：关键实现、注释索引、数据边界和回归方法。
- [验证记录](docs/VALIDATION-17.0.md)：已验证项目、安装包校验和未验证范围。
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
