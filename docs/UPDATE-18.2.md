# V18.2 · 2026-10-17

## 库存预览批量操作

- 每行左侧新增复选框，表头和工具栏都可全选当前筛选的全部页；不是只选屏幕上的100条。
- 勾选不会重绘整张预览，不会产生编辑草稿。翻页保留选择；切换国家、店铺、筛选条件或搜索内容时清空选择。
- **保留并保存修改**：保存选中行的编辑草稿；没有草稿时保留当前系统识别结果。不会隐式批准待上架商品，也不会修改冻结行或已选择保持下架的行。
- **同意上架 / 保持下架**：只处理选中的待确认上架行；其他行跳过并显示数量。保持下架仍为原表整行保留。
- **加入黑名单**：一次确认后按国家、店铺和SKU ID持久保存；立即恢复原行，清除草稿及之前的上架建议/批准状态。黑名单已冻结行不再参与选择。
- 批量保存和上架操作先对副本执行及复核，任何库存值、SKU重复或规则错误都会拒绝整批写入，保留选择及草稿供修正。
- 批量操作不替代最终二次核对确认，不会绕过导出前校验。

## Windows 窗口候选修复

前两种旧方案分别牺牲了缩放和外层圆角。本版保留 `resizable:true`，使用 Electron 44.5 已合入的原生命中测试修复：

- https://github.com/electron/electron/pull/49428
- https://github.com/electron/electron/blob/v44.5.0/shell/browser/native_window_views.cc （CanResize、Maximize、Unmaximize、GetNormalBounds）
- https://github.com/electron/electron/blob/v44.5.0/shell/browser/ui/views/frameless_view.cc （原生边缘命中）

Windows设置为透明无边框、取消厚边框；Chromium仅绘制角部alpha，应用内部保持不透明。整窗统一裁剪四角，动态弹窗仍归入裁剪容器。外边缘排除标题拖动区域，缩放交给Chromium/Windows，不增加鼠标轮询、脚本setBounds循环或二值区域裁剪。

最大化使用Electron窗口API，铺满工作区时使用方角，还原恢复22px圆角。Mac保持原生窗口方式。

**验收范围：** Mac实际UI操作与Windows外壳渲染模拟、样本导出和安装包字节校验可以在本机验证。当前没有可操作Windows10测试机；不能据此宣称Win10原生拖边、DPI、多显示器、贴边或最小化恢复已通过。Windows包保持Candidate标记，等待实机验收。
