# V17.8：原生窗口与有效操作结果

2026-10-14的中间工作记录：未独立发布，窗口和无效操作过滤修正合并进入V18.0；库存最终规则以UPDATE-18.0.md为准。

## 为什么流程一会显示9999→9999

原逻辑按“原仓有货”归类，没有先用最终SKU和全部库存列对比原值。流程一因此包含没有变化的商品；截图中的10条是筛选后的无效操作结果，并非系统只分析10个商品。现在原SKU及库存均未变化的流程一/二行归为“无需调整”，保持原行XML。默认“需要处理”只显示changed或manual行；流程一/二/三统计仅计真实修改。仍可查看全部结果，导出也保留全表商品，筛选不裁剪导出。

## Windows窗口改动与限制

V17.7用户Windows10反馈拖边缘和正常窗口调整仍失效。此前Mac模拟渲染路径测试不能证明Windows原生窗口有效。删除透明、resizable:false、maximizable:false及JS光标轮询拖动组合，使用不透明frameless窗口、thickFrame:true、resizable:true、maximizable:true；按钮调用原生maximize/unmaximize，持久化normalBounds。

依据[Electron窗口样式文档](https://www.electronjs.org/docs/latest/tutorial/custom-window-styles)，透明窗口不支持可靠缩放；[窗口参数文档](https://www.electronjs.org/docs/latest/api/base-window)规定thickFrame用于Windows无框窗口的原生调整大小边框。Windows10外层使用原生边界，无法承诺与Mac外层圆角完全一致；内部圆角与主题继续保留。

## 验证方法

tests/inventory-v180-unit.cjs覆盖9999原值不变、9000→9999及非指定仓清零等差异。tests/inventory-v180.cjs读取本地四表、校验全469行、默认有效操作、筛选计数、完整原模板导出、国家/店铺隔离和一万行分页性能；用户文件不进入仓库。

原生窗口验证检查实际BrowserWindow可调整/可最大化、原生最大化/还原和渲染层移除旧拖动覆盖。Mac视觉检查和打包文件一致性不能代替Windows10真机拖边验收，候选包需在用户Windows环境确认。
