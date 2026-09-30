# Lazada 户外运营中心 V16.3

本仓库保存当前在本机运行的 **V16.3.0 单机版**程序代码及功能批注。app/ 和 electron/ 从运行中的 app.asar 提取；原始 app.asar 与完整 Windows 安装包以 1 MiB 分片保存在本仓库的 GitHub Release 附件中。

## 内容

| 路径 | 内容 |
| --- | --- |
| app/ | 页面、业务逻辑、库存识别、日报费用、AI 分析界面与样式 |
| electron/ | Electron 主进程、IPC、SQLite、下载、安全存储与只读接口 |
| package.json | 安装包内的原始运行时清单，版本为 16.3.0 |
| Release 附件 | 当前已安装程序的 app.asar 和完整安装器分片 |
| scripts/restore-release.ps1 | 下载分片、还原两个文件并校验 SHA-256 |
| docs/FUNCTIONS.md | 按模块整理的功能、输入输出和注意事项 |
| docs/PROVENANCE.md | 来源、哈希、版本差异及数据边界 |
| docs/SECURITY_REVIEW.md | 原版安全审查发现及修复要求 |

## 使用与限制

Windows 用户可运行 scripts/restore-release.ps1 下载 Release 分片，还原 Lazada户外运营中心_安装版_V16.3.0_x64.exe 后安装。脚本需要已登录的 GitHub CLI（gh auth login），以访问私人仓库；还原完成会自动验证文件大小和 SHA-256。这个仓库的代码是**从已打包程序提取的运行时快照**，原始工程的构建脚本、开发依赖和测试没有包含在该安装包中，因此不能把它当作已验证可重新构建的开发工程。package.json 保持安装包原样，没有擅自补造构建配置。

程序将业务数据保存在本机 Electron userData 下；仓库不包含 SQLite 数据库、备份、导入的 Excel、下载文件、聊天记录或 API 凭据。更多细节见 [来源与边界](docs/PROVENANCE.md)。

提取出的 V16.3 运行时清单标记为 UNLICENSED；本私人仓库没有附加开源许可。

**安全审查：**当前原版代码有两项未修复的 P1 问题，涉及本机只读接口访问控制和自动化文件夹授权。详情见 [安全审查记录](docs/SECURITY_REVIEW.md)。本 PR 保持草稿，等待后续修复版本。
