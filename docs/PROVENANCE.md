# 来源、校验与边界

## 确认的版本

- 本机正在运行的主程序：D:\lazada运营工具\lazada-outdoor-operations-center\Lazada户外运营中心.exe。
- 其 resources/app.asar 与 D:\lazada运营工具\V16.3完整安装包\win-unpacked\resources\app.asar 的 SHA-256 相同，均为 1DC3FF467935898425918FD1E0297F400EF1A7F232DDFBF9ED2AE6E67A8AB83E。
- 提取出的运行时 package.json 标明 version: 16.3.0。本仓库 app/、electron/、package.json 均来自该 app.asar。
- D:\lazada运营工具\V16.3完整安装包\Lazada户外运营中心_安装版_V16.3.0_x64.exe 的 SHA-256 为 F00014E8C04BA2AD1E5D817C2C4F039F34483CB9C60250A5070414519074D4EE，大小 103,712,296 字节。

## 同名版本差异

V16.3更新包_单机稳定版/app.asar 的 SHA-256 是 AE373F64CA83233A3CACB456E71DA5D6ED14B5230B2B459849FC2CC412FF4808，与当前安装文件不同。该更新包的说明日期为 2026-08-21；当前完整安装包所在目录的文件较新，并包含 Northstar 只读接口代码。本仓库以**当前运行文件**为唯一源码快照，不混入旧更新包或同目录的 Northstar 独立项目。

目录内旧版 V16.3更新日志与校验.txt 所列完整安装包大小和哈希与当前文件不一致，应以本文件上方对实际文件重新计算的 SHA-256 为准。

## 数据边界

主进程将用户数据定位于 Electron userData，包括 data/operations.db、backups/ 和 security/。这些位置可能存放店铺、SKU、价格、导入文件、操作历史、AI 对话及加密凭据。它们没有复制到仓库或 Release。仓库也不收录 D:\lazada运营工具 中的其他项目、历史构建、Excel 或个人图片。

artifacts/app.asar 是应用程序代码归档，不是用户数据库。Release 中的安装器是供安装使用的二进制文件；源代码结构应查看本仓库的 app/ 与 electron/。
