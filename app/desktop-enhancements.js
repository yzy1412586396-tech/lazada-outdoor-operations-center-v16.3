(() => {
  'use strict';

  const VERSION = '17.2';
  // V16.3 feature flag: the AI analysis template remains in the source and
  // bridge for a later re-enable, but is intentionally not exposed in the
  // current frontend. Do not delete the AI module; change this flag only in a
  // planned release after the feature has been reviewed again.
  const AI_ANALYSIS_TEMPLATE_ENABLED = false;
  const ADVANCED_THEMES = {};
  const restoredExpenseSlots = new Set();
  const clearedExpenseSlots = new Set();
  let uploadMetadata = new Map();

  const q = (selector, root = document) => root.querySelector(selector);
  const qa = (selector, root = document) => [...root.querySelectorAll(selector)];
  const debounce = (fn, delay) => {
    let timer;
    return function debounced(...args) {
      clearTimeout(timer);
      timer = setTimeout(() => fn.apply(this, args), delay);
    };
  };

  function setVersionBranding() {
    const desiredTitle = `Lazada户外运营中心 V${VERSION}`;
    if (document.title !== desiredTitle) document.title = desiredTitle;
    const label = q('#brandSystemLabel');
    const desiredLabel = `V${VERSION} · ${({ph:'菲律宾系统',th:'泰国系统',my:'马来西亚系统'})[window.currentCountry] || '菲律宾系统'}`;
    if (label && label.textContent !== desiredLabel) label.textContent = desiredLabel;
    const current = q('#page-changelog .changelog-current');
    const desiredCurrent = `当前版本 V${VERSION}`;
    if (current && current.textContent !== desiredCurrent) current.textContent = desiredCurrent;
  }

  function hideDisabledAiTemplate(targetDocument = document) {
    if (AI_ANALYSIS_TEMPLATE_ENABLED || !targetDocument) return;
    targetDocument.querySelectorAll('[data-page="ai-observer"], #page-ai-observer').forEach((element) => {
      element.hidden = true;
      element.setAttribute('aria-hidden', 'true');
      element.dataset.featureState = 'disabled-until-reenabled';
      element.classList.add('v15-feature-disabled');
      element.style.setProperty('display', 'none', 'important');
    });
  }

  function installThemes() {
    if (typeof THEMES !== 'object' || typeof appearance !== 'object') return;
    Object.assign(THEMES, ADVANCED_THEMES);
    applyAppearance(false);
  }

  function installReleaseNotes() {
    const list = q('#page-changelog .changelog-list');
    if (!list) return;
    qa('.release-card strong', list).forEach((strong) => {
      if (strong.textContent.includes('当前')) strong.textContent = '版本更新记录';
    });
    const releases = [
      {version:'V17.2',date:'2026-10-10',type:'维护更新',major:false,title:'活动提醒资格修正与红行置顶',items:['修复空报名价被当成零、误显示0%并标红的问题；空价或无效价显示无法计算。','只有有效且勾选导出的报名行参与低价提醒，门槛不足、未匹配和其他不能报名的行不再标红。','全部低价提醒行在分页前统一置顶，优先于主推异常行；手动改价或取消导出后同步重新排序。','提醒仍只影响预览，不写入Excel原表，菲律宾和泰国一致生效。']},
      {version:'V17.1',date:'2026-10-10',type:'维护更新',major:false,title:'活动低价提醒、预设管理与预览性能',items:['活动报名新增可填写的报名价÷售价提醒值，低于提醒值的行高亮显示；手动改价同步更新，提醒不写入原模板、不改变报名资格。','未匹配 SKU 门槛规则只允许点击小方框切换，蓝色背景和文字不再误触。','活动预设列表每项增加独立删除按钮，删除后保存；活动结果每页100条，分页不限制全量导出。','最近下载右键菜单进入最顶层，修复被下载列表覆盖的问题。','暂时移除马来西亚入口，保留原数据；菲律宾和泰国继续独立保存各项设置。']},
      {version:'V17.0',date:'2026-10-08',type:'维护更新',major:false,title:'三国多控价数据库隔离与选择',items:['修复手动列映射导入总是写入国家默认库的问题，导入、冲突、版本、元数据均按所选数据库保存。','控价管理、控价导入、活动报名、全店改价分别保存当前国家的数据库选择；更换库后清除旧预览。','马来西亚新增独立 MYR 空间，按菲律宾同款 SKU 规则匹配，三国数据不混用。','修复活动分析国家变量与异步切换上下文；控价更新后清除匹配缓存，拒绝把其他国家备份恢复到当前国家。']},
      {version:'V16.9',date:'2026-10-07',type:'维护更新',major:false,title:'Windows 四角与窗口可见范围',items:['使用独立的固定圆角表面，根页面保持透明，修复 body 背景传播到窗口画布导致四角变方的问题。','动态弹层也进入同一圆角表面；主题切换、页面缩放和窗口大小变化时，四角与视口四边同步。','启动和还原时按显示器实际工作区限制窗口范围，避免下边缘超出屏幕；小屏幕的最小尺寸同步适配。','Windows 首次显示等待界面样式准备完成，减少初始化阶段方角闪现。','已完成透明窗口渲染及四角像素检查；Windows 10 原生表现继续通过候选版试用确认。']},
      {version:'V16.8',date:'2026-10-07',type:'维护更新',major:false,title:'主题、筛选词与品牌图标',items:['合并此前界面与窗口的维护内容，版本号按小更新增加 0.1 的规则统一为 V16.8。','保留晴空蓝、松林绿、暖沙金、雾紫、午夜蓝五套完整主题，以及内置思源黑体、思源宋体、三档字号和三种按钮形状；设置自动保存。','修复泰国系统启动和国家切换时重新添加默认筛选词的问题；用户删除或清空的识别词、排除词保持原样，新建系统才初始化默认词。','移除侧栏底部数据库说明；山峰与太阳 logo 改为浅色背景、深蓝山峰、橙色太阳，并同步应用窗口及软件图标；应用图标采用平滑圆角方形与透明外侧。','移除 Windows 二值窗口区域裁剪，改用抗锯齿圆角表面方案及独立边缘缩放；Windows 10 外窗效果仍待真机视觉验收，当前不作为已验收安装版发布。','Mac 保持原生窗口圆角与原生拖动，全店改价早鸟价选择器及全部业务功能继续保留。']},
      {version:'V16.4',date:'2026-10-07',type:'维护更新',major:false,title:'全店改价与窗口性能',items:['菲律宾、泰国全店改价新增早鸟价规则选择，关闭后空白 SpecialPrice 也按现有 LA控价匹配回填。','使用原生窗口拖动和不透明窗口，减少拖动抖动及玻璃模糊绘制开销。','全店改价预览每页100条，导出仍包含全部 SKU；单次分析复用控价索引。']},
      {
        version: 'V13.0', date: '2026-07-15', type: '大更新', major: true, title: '版本更新记录',
        items: [
          '把网页工具正式封装为Windows Electron桌面软件，增加安装版、便携版和可覆盖安装的独立更新包。',
          '业务数据从关闭即丢失升级为本机SQLite持久化，月度费用、店铺、控价、库存配置和操作记录可在重启后继续使用。',
          '所有Excel上传入口统一增加“清除已上传表格”，月度费用上传文件支持本机数据库缓存与恢复。',
          '库存识别新增店铺表格仓库列与马帮库存列的自定义对应，可新增、修改、删除仓库及库存名称。',
          '修复库存识别店铺来源与店铺管理不同步，统一使用店铺管理中的国家、店铺和启停状态。',
          '修复日报模板改名等按钮事件，补齐可操作控件的状态校验与错误提示。',
          '新增多套高级主题、数据库状态面板、自动保存提示和搜索/表格渲染性能优化。',
        ],
      },
      {
        version: 'V14.0', date: '2026-07-16', type: '大更新', major: true, title: '版本更新记录', legacySelector: '[data-v14-release]',
        items: [
          '新增严格隔离的“AI运营观察室”：AI只读分析，不能修改Excel、价格、库存、费用、业务数据库或调用任何业务执行函数。',
          'SQLite升级为V14历史架构，增加业务历史、AI聊天、分析来源、使用量、用户确认记忆、对话摘要、迁移报告和FTS检索。',
          '新增DeepSeek与自定义OpenAI兼容Provider；API Key通过Electron safeStorage加密，仅主进程解密。',
          '历史数据必须先预览、显示范围与Token估算，再由用户点击确认发送；普通聊天不自动携带业务数据。',
          '新增“数据安全与备份”：每日首次启动自动备份、手动备份、完整性检查、导入导出、恢复前安全备份与旧数据事务迁移。',
          '电池SKU后缀可在数据设置中按店铺选择保留或去掉，并自定义允许去掉的后缀。',
          '马帮测评表新增交易编号去重规则：保留测评费用10行，合并相同交易编号0费用行的订单核算金额。',
          '全部搜索入口新增可选模糊搜索，并更新品牌Logo与视觉细节。',
        ],
      },
      {
        version: 'V14.1', date: '2026-07-16', type: '小更新', major: false, title: '版本更新记录',
        items: [
          '修复AI页面样式覆盖全局隐藏规则的问题：AI区域不再出现在日报、库存、控价、活动、全店改价等业务模块底部。',
          '“AI运营观察室”升级为唯一的“AI分析模板”入口，支持自由多选日报、库存、控价、活动报名、全店改价、费用等模块进行联合分析。',
          '新增控价＋活动＋日报、控价＋活动、日报＋库存＋费用、全链路复盘等快捷分析模板；服务商与API Key设置默认收起。',
          '全店改价新增可选组合SKU关系表：直接控价未匹配时，按关联普通SKU及捆绑数量累加LA控价；库存字段全部忽略。',
          '更新公告改为追加式版本历史，恢复并保留V13.0、V14.0详细说明，今后升级不再覆盖旧版本记录。',
        ],
      },
      {
        version: 'V14.2', date: '2026-07-16', type: '小更新', major: false, title: '版本更新记录',
        items: [
          '马帮测评表重复交易编号改为严格两阶段处理：第一步分别去除测评费用10或0且后续字段相同的重复行，无论10还是0都只保留一行。',
          '第一步完成后，同一交易编号仍同时存在10与0费用时，保留10费用行，把所有保留下来的0费用行“订单核算金额（原始货币）”累加到10费用行，再进入后续费用计算。',
          'AI分析模板聊天框新增图片和文件附件：支持PNG/JPG/WEBP/GIF、Excel、CSV及常见文本文件，本地生成预览后必须由用户再次确认才会发送。',
          '附件安全边界升级：DeepSeek文字接口不会误发图片；图片仅允许发送给支持视觉的自定义OpenAI兼容模型；聊天数据库只保存附件名称和大小，不保存图片二进制或完整文件正文。',
          '新增附件数量、单文件大小、提取文本总量、输入Token和服务商能力限制，并补充马帮规则、AI隔离和安装包冒烟测试。',
        ],
      },
      {
        version: 'V14.3', date: '2026-07-21', type: '小更新', major: false, title: '版本更新记录',
        items: [
          '修复日报汇总的菲律宾与泰国两个系统：新增店铺和店铺改名全部改为页内输入控件，不再依赖Electron中不稳定的系统弹窗。',
          '修复组合SKU店铺后缀匹配：XS、XS1、XS2以及X1S、X1S1、X1S2等编码在直接控价和组合关系查找前统一清洗，普通SKU不受组合专用规则影响。',
          '使用真实店铺表样本验证T4EE1751914XS1、T4EE1751914X1S1等编码可正确对应组合表标准编码。',
          '活动报名新增默认关闭的“未匹配SKU门槛比例规则”：平时活动达到97%、大促活动达到96%时按平台门槛价报名，未达到即剔除。',
          '门槛比例规则仅处理真正未匹配与组合未匹配的SKU；控价冲突、泳池库缺失、电池后缀风险、禁售和无效价格仍保持安全拦截。',
        ],
      },
      {
        version: 'V14.4', date: '2026-07-21', type: '小更新', major: false, title: '版本更新记录',
        items: [
          '活动报名的未匹配SKU门槛比例规则继续保留独立总开关，默认关闭，用户可以随时决定是否启用。',
          '平时活动最低比例和大促活动最低比例不再写死为0.97/0.96，改为两个可独立编辑并保存的数值。',
          '比例支持三位小数和0至10范围，例如0.975代表97.5%；不同国家系统分别保存自己的当前设置。',
          '分析时按本次保存值判断，符合条件仍按平台门槛价报名，不符合则剔除；结果原因会显示实际计算比例和实际要求值。',
          '控价冲突、泳池库缺失、电池后缀风险、禁售、价格无效和库存不足仍保持原安全拦截，不受自定义比例影响。',
        ],
      },
      {
        version: 'V15.0', date: '2026-08-05', type: '大更新', major: true, title: '当前大版本',
        items: [
          '库存识别升级为三表独立知识库：店铺库存表按店铺保存，马帮库存表和组合拆分表按国家系统共享保存，三张表均可独立更新或清除，重启软件自动恢复。',
          '重写 SKU 底层规则：普通 SKU 严格按 11 位识别，组合 SKU 按 11 位加 X 或 X数字识别，店铺末尾 S1、S2、S3 等重复后缀在匹配时自动清除。',
          '普通商品按“原仓有货、同 SKU 转仓、后四位同款换 SKU”三段流程处理；可用库存大于30写入数字9999，否则写实际数字，并确保系统改动行仅一个仓库有库存。',
          '新增组合拆分校验：按表3逐项读取普通 SKU 和捆绑数量；全部组件有货时保持组合行不动，任一组件库存不足时保持原样并加入预售人工名单。',
          '新增多仓异常、预售和未上架人工标签；店铺原行多仓有库存时不做任何改动，最终有库存但 Status 为 Inactive 时自动列入未上架名单。',
          '最终导出保持店铺原 Excel 模板结构，只回填 SellerSKU 与库存；SellerSKU、Status 固定文本格式，库存固定数字格式，导出前对成品工作簿进行第二次识别校验。',
          '按真实 Trail Go 模板适配：自动跳过表头后的说明行；马帮仓库改为名称关键字包含匹配，例如“CFS”可识别“菲律宾CFS-HB仓-1308”，并兼容“可用库存量”列。',
          '修复重复下载和上传表格后页面跳到底部的问题；库存工作台升级为玻璃卡片布局，并新增霓虹玻璃、深海玻璃、落日玻璃和银雾玻璃四套配色。',
        ],
      },
      {
        version: 'V15.1', date: '2026-08-07', type: '小更新', major: false, title: '当前维护版',
        items: [
          '修复所有表格导出时连续出现两个保存窗口的问题：统一交由 Electron 原生下载流程显示一次保存窗口。',
          '保留导出文件的默认名称、保存目录选择、新建文件夹和覆盖旧文件确认，不改变任何业务模块的导出内容。',
          '新增桌面下载策略回归测试，防止后续版本再次同时启用系统保存窗口和程序手动保存窗口。',
          '同步提供可覆盖现有版本的 V15.1 更新包，以及供新电脑直接安装的 V15.1 完整安装包。',
        ],
      },
      {
        version: 'V15.2', date: '2026-08-12', type: '维护更新', major: false, title: '当前维护版',
        items: [
          '右上角新增“最近下载”面板：显示文件名称、大小、下载状态、实时接收进度和完成时间，下载完成后立即刷新。',
          '最近下载记录会保存在本机；文件被移动或删除后自动标记为“失效”，失效文件不可打开或拖动。',
          '最近下载支持点击打开文件、右键打开所在位置和复制文件路径，也支持拖动文件到资源管理器或其他目录。',
          '修复上传表格后页面偶发跳到最底部的问题，上传前后的横向和纵向滚动位置会自动恢复。',
          '修复月度费用表字段选择被上传操作重置的问题：按国家、店铺和表格类型保留已有有效选择，只有选择失效时才重新自动识别。',
          '本次为 V15.2 的本地桌面维护版，局域网功能保持关闭，不改变库存识别底层规则。',
        ],
      },
      {
        version: 'V15.3', date: '2026-08-12', type: '问题修复', major: false, title: '当前维护版',
        items: [
          '修复最近下载在文件已经下载完成后仍显示“下载中 0%”的问题：完成事件现在直接更新正式下载记录，并同步最终文件大小、接收字节数、保存路径和完成时间。',
          '修复右键菜单无反应的问题：右键操作改为按下载记录 ID 定位，文件路径变化或记录刷新后仍能正确打开菜单。',
          '修复拖动文件无效的问题：拖动时先阻止网页默认拖拽，再调用 Electron 原生文件拖拽，并按记录 ID 启动拖动。',
          '增加下载目录兜底校验：软件发现文件已落在下载目录且大小完整时，会自动纠正为“已完成”，不再长期显示“下载中”。',
          '本次不改变库存识别底层规则，不启用局域网模式，不清除现有数据库和业务数据。',
        ],
      },
      {
        version: 'V15.4', date: '2026-08-12', type: '界面更新', major: false, title: '当前维护版',
        items: [
          '全局外观切换为液态毛玻璃主题：深色背景、半透明层叠面板、边缘高光、柔和光晕和更清晰的层级关系。',
          '重做左侧导航、顶部栏、首页卡片、库存识别工作台、表格、弹窗和最近下载面板的玻璃材质表现。',
          '新增首次进入的默认玻璃主题，同时保留其它主题配色；设置页可随时切换，主题设置不影响库存规则和业务数据。',
          '保留上传滚动位置、月度费用字段记忆、下载右键菜单、原生拖动、失效判断和单次保存窗口等 V15.3 行为修复。',
          '本次只调整前端视觉层和版本标识，不启用局域网功能，不清除现有数据库和业务数据。',
        ],
      },
      {
        version: 'V15.5', date: '2026-08-12', type: '界面与交互更新', major: false, title: '当前维护版',
        items: [
          '新增云雾玻璃主题：窗口底层支持透出桌面壁纸，模块使用轻量白色半透明玻璃、柔和阴影和椭圆圆角，移除厚重白边与霓虹装饰。',
          '桌面窗口改为无边框透明窗口，新增简洁的最小化、最大化和关闭控制，保留标题栏拖动区域。',
          '统一主要操作按钮为简洁蓝色，减少视觉噪音；库存识别、三表数据、控价数据和业务规则保持不变。',
          '最近下载支持右键删除下载记录；删除只移除列表记录，不删除磁盘文件，文件打开、打开位置、复制路径和拖动功能继续保留。',
          '优化文件拖动反馈，使用透明拖动图标，避免拖出带黑色 Logo 的大块预览。',
          '本次不启用局域网功能，不清除现有 SQLite 数据、库存表、组合拆分表和业务数据。',
        ],
      },
      {
        version: 'V15.6', date: '2026-08-12', type: '问题修复', major: false, title: '当前维护版',
        items: [
          '修复最近下载记录右键无反应：现在使用稳定的应用内右键菜单，可打开文件、打开所在位置、复制路径或删除记录。',
          '删除下载记录只清理最近下载列表，不删除硬盘上的实际文件；文件已经移动或删除时会继续显示“失效”。',
          '文件拖动改为单独的“拖动文件”把手，避免拖动整个下载卡片导致界面被拖走；拖出时使用透明预览，不再显示黑色应用 Logo。',
          '下载完成后立即以完成事件刷新记录，并同步最终文件大小、路径和完成时间；继续保留后台兜底校验。',
          '本次不改变库存识别规则、三表数据、控价数据库、业务数据和局域网状态。',
        ],
      },
      {
        version: 'V15.7', date: '2026-08-12', type: '玻璃主题重做', major: false, title: '版本更新记录',
        items: [
          '收敛为唯一的白色毛玻璃主题，移除其它配色主题和主题切换入口，不再让其它颜色参与界面渲染。',
          '应用外圈改为空白透明留空，工作台保持悬浮尺寸，四角使用椭圆圆角，不再与屏幕底部或边缘连死。',
          '右上角加入三个圆形悬浮窗口按钮：最小化、最大化和关闭；按钮使用白色毛玻璃底，不再使用黑色横向标题栏。',
          '侧栏、顶部栏、首页模块、库存识别模块、表格和弹窗改为不透字的白色毛玻璃，能透光但不会直接看见桌面文字干扰工作。',
          '最近下载入口和展开菜单固定在窗口右上角，不随工作台内容滚动或移动；右边界去除额外色带和可见外框。',
          '上传表格后同时恢复窗口页面和工作台内部滚动位置，库存识别规则、三表数据、控价数据库和业务功能不变。',
        ],
      },
      {
        version: 'V15.8', date: '2026-08-12', type: '界面可用性修复', major: false, title: '版本更新记录',
        items: [
          '修复右上角最小化、最大化和关闭按钮未创建的问题：窗口控制按钮改为直接绑定桌面进程通道，三个圆形悬浮按钮会稳定显示并响应点击。',
          '数据设置新增“背景透明度”和“模块透明度”两套独立设置：均支持连续滑动、五档快捷预设和本机自动保存，重启软件后继续沿用。',
          '背景透明度只控制工作台、主内容区与侧栏；模块透明度单独控制卡片、表格和输入框，既能看见玻璃质感，也能避免桌面文字干扰工作。',
          '窗口按钮与最近下载入口降低白色遮罩、增强玻璃模糊和悬浮阴影，并与下方工作台留出透明间隔，不再贴在工作台边缘。',
          '隐藏工作台右侧灰色滚动条轨道和滑块，消除贴在圆角边缘的异色竖条；鼠标滚轮、触控板和键盘滚动保持可用。',
          '窗口控制区域、最近下载入口和业务工作区重新划分点击层级，避免透明标题层遮挡页面操作。',
          '本次不修改库存识别规则、三表知识库、控价数据库、SQLite 数据和其它业务功能。',
        ],
      },
      {
        version: 'V15.9', date: '2026-08-13', type: '稳定性与交互修复', major: false, title: '版本更新记录',
        items: [
          '修复透明标题拖拽层错误覆盖整个窗口的问题：拖拽区域严格限制在顶部 52px，业务工作台不再把点击误判为拖动窗口。',
          '修复版本文字监听器反复触发自身导致窗口假死的问题；顶部拖窗改为受控位移通道，下载入口和业务按钮保持独立点击层。',
          '活动库存补充负数、无效数字、库存不足与30件门槛校验；改价补充平台门槛、早鸟保护和两位小数边界；月度费用补充负数、括号金额、闰年日期和零天数保护。',
          '库存识别使用真实三表完成451行端到端验收，并补充边界值、随机不变量、组合拆分、仓库唯一库存和导出格式回归。',
          'SQLite新增启动前完整性预检：0字节或损坏数据库会先隔离保留原文件再建立可用库；空文件和损坏备份不会被误接收。',
          '交互验收改为 Electron 窗口坐标真实输入，不再以程序内部 click() 作为通过依据；覆盖侧栏、首页业务入口、最近下载、窗口按钮和窗口拖动。',
          '保留背景透明度与模块透明度独立调节、五档预设和自动保存；库存规则、三表知识库及控价数据库的既有业务数据不迁移。',
        ],
      },
      {
        version: 'V15.10', date: '2026-08-17', type: '界面与可用性更新', major: false, title: '版本更新记录',
        items: [
          '设置页新增按钮透明度：与背景透明度、模块透明度分开调节，提供连续滑动和五档预设，并自动保存到本机。',
          '重做表格上传区域：保留原生文件选择和清除逻辑，改为白色毛玻璃文件卡片，显示文件名、读取状态和清除按钮，避免原生控件样式影响使用。',
          '优化库存识别的上传区、仓库映射区和输入控件的层次、间距与玻璃材质；不改变库存匹配、导出和数据库逻辑。',
          'AI分析模板当前未开启：前端入口和页面隐藏，AI源码、只读桥接和数据结构保留，并在源码中标注后续可重新启用。',
          '已按反馈撤销模块切换过场动画，恢复即时切换，避免视觉变形、额外重绘和低性能设备上的卡顿。',
          '版本升级为 V15.10，局域网功能保持关闭，既有业务数据和库存识别规则保持不变。',
        ],
      },
      {
        version: 'V16.1', date: '2026-08-19', type: '大版本更新', major: true, title: '版本更新记录',
        items: [
          '按使用反馈彻底撤销模块切换过场动画，恢复即时切换，减少额外重绘并避免低性能电脑出现视觉变形或卡顿。',
          '月度费用前端把广告费用与战略卖家计划参与费分开展示，同时保留原推广相关计费合计、手动覆盖、费用公式和加工流程；原计算核心未改。',
          '新增可选“一键日报费用导出”插件：自动扫描当天店铺数据文件夹，按可编辑关键词匹配日报、广告、联盟、Income、推广费用和可选补单表。',
          '插件支持 xls、xlsx、xlsm；日报与费用日期可收起、可留空采用全部日期并自动保存；补单表未上传时按0处理。',
          '修复日报 iframe 与主工作台之间传递 Excel 二进制时的跨窗口类型兼容问题，并兼容新旧日报结果页的日期、店铺列布局，避免最终回填阶段中断。',
          '一键流程按日期生成月度费用表和日报费用表，并将广告、补单、联盟、战略卖家参与费及360以绝对值数字写入日报 AI 至 AM 列。',
          '右上角在最近下载左侧新增插件按钮，可查看插件是否安装；安装后才显示业务入口，已安装插件支持右键卸载。',
          '背景、模块、按钮透明度拆分为三套0%至100%连续设置，每套提供10档快捷值并自动保存；蓝色主按钮保持清晰可识别。',
          '优化窄窗口响应式布局、日报模块毛玻璃主题、文件选择区域与日期记忆，避免窗口缩小时卡片和输入控件被挤压。',
          'AI分析模板继续保留在源码与只读桥接中，但 V16.1 前端入口保持关闭，后续需要时可按标记重新启用。',
          '本版本不启用局域网功能，不迁移现有业务数据库，不修改库存识别底层规则，也不清除已保存的三表知识库与控价数据。',
        ],
      },
      {
        version: 'V16.2', date: '2026-08-20', type: '日报数据修复', major: false, title: '版本更新记录',
        items: [
          '修复一键日报费用继续使用浏览器旧模板的问题：旧模板若只到8月14日，会导致本次8月17日起的数据直接追加，8月15日至16日因此在成品中缺失。',
          '一键流程现在会从当前店铺数据文件夹自动匹配最新日报模板，默认关键词为“菲律宾日报”，并在文件匹配预览中明确显示实际采用的模板文件。',
          '新增日报模板关键词设置，可自行修改并自动保存；自动排除“日报费用”和“月度费用”成品，防止把最终导出文件误当成下次模板。',
          '新增历史日期连续性保护：运行前读取模板“日报结果页”的最后日期，若与本次日报开始日期之间存在断层，立即停止导出并列出缺失日期，避免静默漏数。',
          '修复亚洲时区下 Excel 日期被UTC转换后提前一天的问题，并修正月底日期计算；8月16日现在稳定识别为8月16日，8月账期结束日保持8月31日。',
          '已用真实文件确认：菲律宾日报模板包含8月15日至16日，问题发生在模板选择阶段，并非月度费用计算或AI至AM费用回填阶段。',
          'V16.1 的一键插件、透明度、费用拆分和响应式界面全部保留；库存识别规则、月度费用公式、控价数据库和原始Excel均未改动。',
        ],
      },
      {
        version: 'V16.3', date: '2026-08-21', type: '费用回填与性能修复', major: false, title: '当前版本',
        items: [
          '修正一键日报费用的AM列：不再写入固定数字360，改为逐店读取月度费用模块中名称为“360”或“360费用”的实际最终金额。',
          'AM列遵循原有费用回填规则：采用每个店铺各自的自动识别或手动覆盖最终值，负数转绝对值，并以Excel数字格式写入。',
          '一键流程批量导入Income、推广费用和补单表时，月度费用页面由每张表重复整页重绘改为整批完成后只重绘一次，同时在文件间主动让出渲染帧。',
          '最近下载保留事件实时更新，取消面板关闭时每秒无条件查询和重建列表；仅在内容变化或面板打开时刷新，降低周期性卡顿。',
          '库存识别规则、月度费用公式、360费用自身的识别与手动覆盖过程均未改动；本版本继续保持单机模式。',
        ],
      },
    ];
    for (const release of releases.sort((a, b) => a.date.localeCompare(b.date) || a.version.localeCompare(b.version,undefined,{numeric:true}))) {
      const exists = list.querySelector(`[data-release-version="${release.version}"]`) || (release.legacySelector ? list.querySelector(release.legacySelector) : null);
      if (exists) {
        exists.dataset.releaseVersion = release.version;
        continue;
      }
      const article = document.createElement('article');
      article.className = 'release-card';
      article.dataset.releaseVersion = release.version;
      article.innerHTML = `<div class="release-head"><div class="release-head-left"><span class="release-version">${release.version}</span><div><strong>${release.title}</strong><small>${release.date}</small></div></div><span class="release-tag ${release.major ? 'major' : 'patch'}">${release.type}</span></div><div class="release-body"><ul>${release.items.map((item) => `<li>${item}</li>`).join('')}</ul></div>`;
      list.prepend(article);
    }
    setVersionBranding();
  }

  function formatBytes(value) {
    const bytes = Number(value) || 0;
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  }

  function installScrollStability(targetDocument = document) {
    if (!targetDocument?.documentElement || targetDocument.documentElement.dataset.scrollStableV152) return;
    targetDocument.documentElement.dataset.scrollStableV152 = '1';
      targetDocument.addEventListener('change', (event) => {
        const input = event.target?.closest?.('input[type="file"]');
        if (!input) return;
        const view = targetDocument.defaultView || window;
        const left = view.scrollX;
        const top = view.scrollY;
      const scroller = input.closest('.main') || targetDocument.querySelector('.main');
      const scrollTop = scroller?.scrollTop || 0;
      const scrollLeft = scroller?.scrollLeft || 0;
      const restore = () => {
        view.scrollTo({ left, top, behavior: 'auto' });
        if (scroller) scroller.scrollTo({ left: scrollLeft, top: scrollTop, behavior: 'auto' });
      };
      restore();
      [16, 80, 180, 360].forEach((delay) => view.setTimeout(restore, delay));
    }, true);
  }

  function downloadText(value) {
    return String(value ?? '').replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]));
  }

  function downloadSize(value) {
    const bytes = Number(value) || 0;
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
    if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
    return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
  }

  function installDownloadPanel() {
    if (!window.desktopApp?.downloads || q('#v152DownloadsButton')) return;
    const actions = q('.top-actions');
    if (!actions) return;
    const style = document.createElement('style');
    style.id = 'v152-downloads-style';
    style.textContent = `
      #v152DownloadsButton{position:relative;border:0;background:rgba(255,255,255,.72);color:#245fc9;cursor:pointer;backdrop-filter:blur(22px);-webkit-backdrop-filter:blur(22px);box-shadow:0 8px 20px rgba(55,78,106,.13)}
      #v152DownloadsBadge{position:absolute;top:-6px;right:-5px;min-width:16px;height:16px;padding:0 4px;border-radius:99px;background:#3478f6;color:#fff;font:700 10px/16px Arial;text-align:center;box-shadow:0 0 0 2px rgba(255,255,255,.86)}
      .v152-downloads-panel{position:fixed;z-index:10001;top:64px;right:18px;width:min(430px,calc(100vw - 36px));max-height:min(600px,calc(100vh - 88px));overflow:auto;padding:10px;border:0;border-radius:20px;background:rgba(255,255,255,.86);box-shadow:0 20px 65px rgba(45,68,94,.18);backdrop-filter:blur(30px) saturate(1.04);-webkit-backdrop-filter:blur(30px) saturate(1.04);display:none;color:#24384d}
      .v152-downloads-panel.show{display:block}.v152-downloads-head{display:flex;justify-content:space-between;align-items:center;padding:7px 8px 10px}.v152-downloads-head strong{font-size:14px}.v152-downloads-head span{color:#6a7a8c;font-size:10px}.v152-download-item{display:grid;grid-template-columns:34px 1fr;gap:9px;width:100%;padding:10px 8px;border-top:1px solid rgba(79,106,135,.10);background:transparent;color:#24384d;text-align:left}.v152-download-item:hover{background:rgba(52,120,246,.07)}.v152-download-item.unavailable{opacity:.62}.v152-download-icon{width:27px;height:27px;border-radius:50%;background:rgba(52,120,246,.12);display:grid;place-items:center;color:#3478f6;font-weight:700;font-size:13px}.v152-download-item.unavailable .v152-download-icon{background:rgba(96,126,160,.16);color:#6a7a8c}.v152-download-main{min-width:0}.v152-download-open{display:block;width:100%;padding:0;border:0;background:transparent;color:inherit;text-align:left;cursor:pointer}.v152-download-open:focus-visible,.v152-download-drag:focus-visible{outline:2px solid rgba(52,120,246,.52);outline-offset:2px;border-radius:6px}.v152-download-name{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12px}.v152-download-meta{display:flex;gap:7px;margin-top:4px;color:#6a7a8c;font-size:10px;flex-wrap:wrap}.v152-download-progress{height:5px;margin-top:7px;border-radius:999px;background:rgba(92,120,150,.15);overflow:hidden}.v152-download-progress i{display:block;height:100%;background:#3478f6;transition:width .15s ease}.v152-download-tools{display:flex;align-items:center;gap:6px;margin-top:7px}.v152-download-drag{display:inline-flex;align-items:center;gap:5px;padding:3px 7px;border:0;border-radius:7px;background:rgba(52,120,246,.08);color:#536579;font-size:10px;cursor:grab}.v152-download-drag:hover{background:rgba(52,120,246,.15);color:#245fc9}.v152-download-drag:active{cursor:grabbing}.v152-download-drag[disabled]{opacity:.45;cursor:not-allowed}.v152-download-grip{font-size:12px;letter-spacing:-2px}.v152-download-empty{padding:26px 10px;text-align:center;color:#6a7a8c;font-size:12px}
      .v152-download-context{position:fixed;z-index:10020;min-width:164px;padding:5px;border:0;border-radius:14px;background:rgba(255,255,255,.92);color:#24384d;box-shadow:0 16px 45px rgba(45,68,94,.18);backdrop-filter:blur(26px);-webkit-backdrop-filter:blur(26px)}.v152-download-context[hidden]{display:none}.v152-download-context button{display:block;width:100%;padding:8px 10px;border:0;border-radius:7px;background:transparent;color:#24384d;text-align:left;font-size:11px;cursor:pointer}.v152-download-context button:hover{background:rgba(52,120,246,.08)}.v152-download-context button.danger{color:#245fc9}.v152-download-context button:disabled{opacity:.42;cursor:not-allowed}.v152-download-context .separator{height:1px;margin:4px 3px;background:rgba(79,106,135,.10)}
    `;
    document.head.appendChild(style);
    const button = document.createElement('button');
    button.id = 'v152DownloadsButton';
    button.className = 'store-pill';
    button.type = 'button';
    button.title = '查看最近下载';
    button.innerHTML = '⇩ 最近下载 <span id="v152DownloadsBadge" hidden>0</span>';
    document.body.appendChild(button);
    const panel = document.createElement('div');
    panel.id = 'v152DownloadsPanel';
    panel.className = 'v152-downloads-panel';
    panel.innerHTML = '<div class="v152-downloads-head"><strong>最近下载</strong><span>点击打开 · 右键菜单 · 拖动把手导出文件</span></div><div id="v152DownloadsList"></div>';
    document.body.appendChild(panel);
    const contextMenu = document.createElement('div');
    contextMenu.className = 'v152-download-context';
    contextMenu.setAttribute('popover', 'manual');
    contextMenu.hidden = true;
    contextMenu.innerHTML = '<button type="button" data-download-context="open">打开文件</button><button type="button" data-download-context="location">打开所在位置</button><button type="button" data-download-context="copy">复制文件路径</button><div class="separator"></div><button type="button" class="danger" data-download-context="remove">删除下载记录</button>';
    document.body.appendChild(contextMenu);
    const list = q('#v152DownloadsList', panel);
    let latestItems = [];
    let contextItem = null;
    let renderSignature = '';
    let pendingRenderItems = null;
    let renderFrame = 0;
    const closeContextMenu = () => { contextItem = null; if(contextMenu.matches(':popover-open'))contextMenu.hidePopover(); contextMenu.hidden = true; };
    const openContextMenu = (event, item) => {
      if (!item?.id) return;
      contextItem = item;
      const available = Boolean(item.path) && item.available !== false;
      q('[data-download-context="open"]', contextMenu).disabled = !available;
      q('[data-download-context="location"]', contextMenu).disabled = !available;
      q('[data-download-context="copy"]', contextMenu).disabled = !item.path;
      contextMenu.hidden = false;
      // V17.1：top layer 不受下载面板 z-index 或圆角容器的裁剪影响。
      if(!contextMenu.matches(':popover-open'))contextMenu.showPopover();
      const left = Math.min(event.clientX, window.innerWidth - contextMenu.offsetWidth - 8);
      const top = Math.min(event.clientY, window.innerHeight - contextMenu.offsetHeight - 8);
      contextMenu.style.left = `${Math.max(8, left)}px`;
      contextMenu.style.top = `${Math.max(60, top)}px`;
    };
    window.addEventListener('resize', closeContextMenu);
    const render = (items = []) => {
      latestItems = Array.isArray(items) ? items : [];
      const signature = JSON.stringify(latestItems.map((item) => [item.id, item.name, item.state, item.size, item.received, item.path, item.available, item.completedAt]));
      if (signature === renderSignature) return;
      renderSignature = signature;
      if (contextItem && !latestItems.some((item) => item.id === contextItem.id)) closeContextMenu();
      const completed = latestItems.filter((item) => item.state === 'completed');
      const badge = q('#v152DownloadsBadge');
      if (badge) { badge.textContent = String(Math.min(completed.length, 99)); badge.hidden = completed.length === 0; }
      list.innerHTML = latestItems.length ? latestItems.slice(0, 15).map((item) => {
        const unavailable = item.state === 'completed' && item.available === false;
        const total = Number(item.size) || 0;
        const received = Number(item.received) || 0;
        const percent = total > 0 ? Math.min(100, Math.round(received * 100 / total)) : item.state === 'completed' ? 100 : 0;
        const state = unavailable ? '失效' : item.state === 'completed' ? '已完成' : item.state === 'progressing' ? `下载中 ${percent}%` : item.state === 'paused' ? '已暂停' : item.state;
        const progress = item.state === 'completed' || item.state === 'progressing' || item.state === 'paused' ? `<div class="v152-download-progress"><i style="width:${percent}%"></i></div>` : '';
        const canDrag = Boolean(item.path) && !unavailable;
        return `<div class="v152-download-item${unavailable ? ' unavailable' : ''}" data-download-id="${downloadText(item.id)}"><span class="v152-download-icon">⇩</span><span class="v152-download-main"><button class="v152-download-open" type="button" data-download-open="${downloadText(item.id)}"><span class="v152-download-name">${downloadText(item.name || '导出文件')}</span><span class="v152-download-meta"><span>${downloadSize(received)} / ${downloadSize(total)}</span><span>${state}</span><span>${downloadText(item.completedAt ? new Date(item.completedAt).toLocaleString('zh-CN') : '正在下载')}</span></span>${progress}</button><span class="v152-download-tools"><button class="v152-download-drag" type="button" draggable="${canDrag ? 'true' : 'false'}" data-download-drag="${downloadText(item.id)}" ${canDrag ? '' : 'disabled'} title="拖到资源管理器或其他目录"><span class="v152-download-grip">⠿</span>拖动文件</button></span></span></div>`;
      }).join('') : '<div class="v152-download-empty">还没有最近下载</div>';
      qa('.v152-download-item', panel).forEach((entry) => {
        const item = latestItems.find((candidate) => candidate.id === entry.dataset.downloadId);
        entry.addEventListener('contextmenu', (event) => {
          event.preventDefault();
          event.stopPropagation();
          openContextMenu(event, item);
        });
      });
      qa('[data-download-open]', panel).forEach((entry) => {
        const item = latestItems.find((candidate) => candidate.id === entry.dataset.downloadOpen);
        entry.addEventListener('click', () => {
          if (!item?.path || (item.state === 'completed' && item.available === false)) return toast('文件已移动或删除', 'err');
          window.desktopApp.downloads.open(item.id).catch((error) => toast(error.message || '文件无法打开', 'err'));
        });
      });
      qa('[data-download-drag]', panel).forEach((entry) => {
        const item = latestItems.find((candidate) => candidate.id === entry.dataset.downloadDrag);
        entry.addEventListener('dragstart', (event) => {
          if (!item?.path || (item.state === 'completed' && item.available === false)) { event.preventDefault(); return; }
          event.preventDefault();
          event.dataTransfer.effectAllowed = 'copy';
          window.desktopApp.downloads.drag(item.id);
        });
      });
    };
    const scheduleRender = (items) => {
      pendingRenderItems = items;
      if (renderFrame) return;
      renderFrame = requestAnimationFrame(() => {
        renderFrame = 0;
        const next = pendingRenderItems;
        pendingRenderItems = null;
        render(next);
      });
    };
    qa('[data-download-context]', contextMenu).forEach((entry) => entry.addEventListener('click', async () => {
      const item = contextItem;
      const action = entry.dataset.downloadContext;
      closeContextMenu();
      if (!item?.id) return;
      try {
        if (action === 'remove') await window.desktopApp.downloads.remove(item.id);
        else if (action === 'open') await window.desktopApp.downloads.open(item.id);
        else if (action === 'location') await window.desktopApp.downloads.openLocation(item.id);
        else if (action === 'copy' && item.path) { await window.desktopApp.downloads.copyPath(item.id); toast('文件路径已复制'); }
      } catch (error) { toast(error.message || '操作失败', 'err'); }
    }));
    button.addEventListener('click', (event) => {
      event.stopPropagation();
      const showing = panel.classList.toggle('show');
      if (showing) window.desktopApp.downloads.list().then(scheduleRender).catch(() => {});
    });
    document.addEventListener('click', (event) => { if (!panel.contains(event.target) && event.target !== button) panel.classList.remove('show'); closeContextMenu(); });
    document.addEventListener('keydown', (event) => { if (event.key === 'Escape') closeContextMenu(); });
    window.desktopApp.downloads.onDragError((message) => toast(message, 'err'));
    window.desktopApp.downloads.list().then(scheduleRender).catch(() => scheduleRender([]));
    window.desktopApp.downloads.onChanged(scheduleRender);
    window.setInterval(() => {
      if (panel.classList.contains('show')) window.desktopApp.downloads.list().then(scheduleRender).catch(() => {});
    }, 3000);
  }

  async function refreshDatabasePanel() {
    const panel = q('#databaseV13');
    if (!panel || !window.desktopApp?.database) return;
    try {
      const info = await window.desktopApp.database.info();
      q('[data-db-stat="status"]', panel).textContent = window.desktopApp.database.ready ? '运行中 · 自动保存' : '连接异常';
      q('[data-db-stat="size"]', panel).textContent = formatBytes(info.size);
      q('[data-db-stat="uploads"]', panel).textContent = `${info.uploads} 个费用表格`;
      q('[data-db-stat="sync"]', panel).textContent = info.lastSync ? new Date(info.lastSync).toLocaleString('zh-CN') : '等待首次保存';
      q('[data-db-path]', panel).textContent = info.location;
    } catch (error) {
      q('[data-db-stat="status"]', panel).textContent = '读取失败';
      console.error(error);
    }
  }

  function installDatabasePanel() {
    const settings = q('#page-settings');
    if (!settings || q('#databaseV13')) return;
    const panel = document.createElement('div');
    panel.className = 'panel database-v13';
    panel.id = 'databaseV13';
    panel.innerHTML = `
      <div class="panel-head"><div><div class="eyebrow">SQLite database</div><h3>本地数据库与自动保存</h3><p>关闭程序前会强制保存；使用过程中每 1.5 秒检查一次变化。安装、便携和更新版本均读取同一份本机数据。</p></div><span class="chip good">V14 历史库</span></div>
      <div class="database-status-grid">
        <div class="database-stat"><span>数据库状态</span><b data-db-stat="status">正在检查</b></div>
        <div class="database-stat"><span>数据库大小</span><b data-db-stat="size">—</b></div>
        <div class="database-stat"><span>已保存费用表</span><b data-db-stat="uploads">—</b></div>
        <div class="database-stat"><span>最近自动保存</span><b data-db-stat="sync">—</b></div>
      </div>
      <div class="callout info" style="margin-top:12px"><strong>数据库位置</strong><span data-db-path style="word-break:break-all">正在读取…</span></div>
      <div class="database-actions"><button class="btn primary sm" id="databaseSaveNow">立即保存</button><button class="btn light sm" id="databaseOpenFolder">打开数据库目录</button></div>`;
    settings.insertBefore(panel, settings.firstElementChild);
    const spacer = document.createElement('div');
    spacer.style.height = '14px';
    panel.after(spacer);
    q('#databaseSaveNow').onclick = async () => {
      const result = await window.desktopApp.database.flush();
      toast(result?.ok ? '数据已保存到 SQLite 数据库' : `保存失败：${result?.error || '未知错误'}`, result?.ok ? 'ok' : 'err');
      refreshDatabasePanel();
    };
    q('#databaseOpenFolder').onclick = () => window.desktopApp.database.openFolder();
    refreshDatabasePanel();
  }

  function expenseSlot(input) {
    if (!input.matches('[data-exp-upload]')) return '';
    const [storeId, type] = input.dataset.expUpload.split('|');
    return `expense:${window.currentCountry || 'ph'}:${storeId}:${type}`;
  }

  function installGlassFilePicker(input) {
    if (!input || input.dataset.glassFilePickerInstalled) return input?.closest('.desktop-file-field');
    const parent = input.parentElement;
    if (!parent) return null;
    const ownerDocument = input.ownerDocument || document;
    const field = ownerDocument.createElement('div');
    field.className = 'desktop-file-field';
    field.dataset.fileInputId = input.id || input.dataset.expUpload || '';
    parent.insertBefore(field, input);
    field.appendChild(input);
    input.dataset.glassFilePickerInstalled = '1';
    input.classList.add('desktop-file-native');

    const choose = ownerDocument.createElement('button');
    choose.type = 'button';
    choose.className = 'desktop-file-choose';
    choose.innerHTML = '<span class="desktop-file-choose-icon">＋</span><span>选择表格</span>';
    choose.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      input.click();
    });
    const name = ownerDocument.createElement('span');
    name.className = 'desktop-file-name';
    name.textContent = '尚未选择表格';
    field.append(choose, name);
    input.addEventListener('change', () => updateFilePickerName(input), true);
    updateFilePickerName(input);
    return field;
  }

  function updateFilePickerName(input) {
    const field = input?.closest('.desktop-file-field');
    if (!field) return;
    const name = field.querySelector('.desktop-file-name');
    if (!name) return;
    const file = input.files?.[0];
    const slot = expenseSlot(input);
    const meta = slot ? uploadMetadata.get(slot) : null;
    const active = Boolean(file || meta || (slot && window.__expenseV13?.hasUpload(...input.dataset.expUpload.split('|'))));
    name.textContent = file?.name || meta?.name || (active ? '已读取到本机数据库' : '尚未选择表格');
    name.title = name.textContent;
    field.classList.toggle('has-file', active);
  }

  function updateClearButton(input) {
    const field = input.closest('.desktop-file-field') || input.parentElement;
    const button = field?.querySelector(`.desktop-clear-upload[data-clear-input="${CSS.escape(input.id || input.dataset.expUpload || '')}"]`);
    updateFilePickerName(input);
    if (!button) return;
    const slot = expenseSlot(input);
    let active = Boolean(input.files?.length);
    if (slot) active = active || uploadMetadata.has(slot) || Boolean(window.__expenseV13?.hasUpload(...input.dataset.expUpload.split('|')));
    button.disabled = !active;
    const state = button.nextElementSibling;
    if (state?.classList.contains('desktop-file-state')) {
      const file = input.files?.[0];
      const meta = slot ? uploadMetadata.get(slot) : null;
      state.textContent = file?.name || meta?.name || (active ? '已读取' : '未上传');
    }
  }

  async function persistExpenseUpload(input, file) {
    const slot = expenseSlot(input);
    if (!slot || !file || !window.desktopApp?.uploads) return;
    clearedExpenseSlots.delete(slot);
    restoredExpenseSlots.add(slot);
    try {
      const bytes = await file.arrayBuffer();
      await window.desktopApp.uploads.save(slot, {
        name: file.name,
        type: file.type,
        lastModified: file.lastModified,
      }, bytes);
      uploadMetadata.set(slot, { slot, name: file.name, size: file.size, updatedAt: new Date().toISOString() });
      updateClearButton(input);
      refreshDatabasePanel();
    } catch (error) {
      console.error('Unable to persist expense upload:', error);
      toast(`表格已读取，但数据库保存失败：${error.message}`, 'err');
    }
  }

  async function restoreExpenseUpload(input) {
    const slot = expenseSlot(input);
    if (!slot || restoredExpenseSlots.has(slot) || clearedExpenseSlots.has(slot) || !uploadMetadata.has(slot)) return;
    restoredExpenseSlots.add(slot);
    try {
      const record = await window.desktopApp.uploads.read(slot);
      if (!record || !input.isConnected) return;
      const file = new File([record.content], record.name, { type: record.type || '', lastModified: record.lastModified || Date.now() });
      const transfer = new DataTransfer();
      transfer.items.add(file);
      input.files = transfer.files;
      input.dataset.dbRestoring = '1';
      input.dispatchEvent(new Event('change', { bubbles: true }));
      delete input.dataset.dbRestoring;
      updateClearButton(input);
    } catch (error) {
      console.error('Unable to restore expense upload:', error);
    }
  }

  async function clearSelectedFile(input) {
    const slot = expenseSlot(input);
    if (slot) {
      clearedExpenseSlots.add(slot);
      restoredExpenseSlots.add(slot);
      uploadMetadata.delete(slot);
      await window.desktopApp.uploads.remove(slot);
      const [storeId, type] = input.dataset.expUpload.split('|');
      window.__expenseV13?.clearUpload(storeId, type);
      refreshDatabasePanel();
      return;
    }

    const id = input.id;
    if (id === 'controlFile') {
      try { resetControlMapper(); } catch { input.value = ''; }
      const message = q('#controlImportMsg');
      if (message) message.innerHTML = '<div class="callout info"><strong>已清除上传表格</strong>可以重新选择控价文件。</div>';
    } else if (id === 'activityFile') {
      input.value = '';
      try { activitySession = null; } catch { /* not initialized */ }
      q('#activityResult')?.classList.add('hidden');
      if (q('#activityMsg')) q('#activityMsg').innerHTML = '';
    } else if (id === 'repricingFile') {
      input.value = '';
      try { repricingSession = null; } catch { /* not initialized */ }
      q('#repricingResult')?.classList.add('hidden');
      if (q('#repricingMsg')) q('#repricingMsg').innerHTML = '';
    } else if (id === 'repricingComboFile') {
      input.value = '';
      try { repricingSession = null; } catch { /* not initialized */ }
      q('#repricingResult')?.classList.add('hidden');
      if (q('#repricingMsg')) q('#repricingMsg').innerHTML = '';
      if (q('#repricingComboMsg')) q('#repricingComboMsg').innerHTML = '<div class="callout info"><strong>已清除组合SKU关系表</strong>本次将只使用控价库的直接匹配。</div>';
    } else if (id === 'inv13StoreFile') {
      window.__inventoryV13?.clearUpload('store');
    } else if (id === 'inv13MabangFile') {
      window.__inventoryV13?.clearUpload('mabang');
    } else {
      input.value = '';
      input.dispatchEvent(new Event('change', { bubbles: true }));
    }
    updateClearButton(input);
    toast('已清除上传的表格', 'ok');
  }

  function installClearButton(input) {
    if (!input || input.tagName !== 'INPUT' || input.type !== 'file') return;
    const acceptsSpreadsheet = /xls|xlsx|xlsm|csv/i.test(input.accept || '') || input.matches('[data-exp-upload]');
    if (!acceptsSpreadsheet) return;
    installGlassFilePicker(input);
    if (input.id === 'restoreFile' || input.dataset.clearInstalled) {
      updateFilePickerName(input);
      return;
    }
    input.dataset.clearInstalled = '1';
    const key = input.id || input.dataset.expUpload || `file-${Date.now()}`;
    const ownerDocument = input.ownerDocument || document;
    const button = ownerDocument.createElement('button');
    button.type = 'button';
    button.className = 'desktop-clear-upload';
    button.dataset.clearInput = key;
    button.textContent = '清除上传的表格';
    const state = ownerDocument.createElement('span');
    state.className = 'desktop-file-state';
    button.onclick = (event) => {
      event.preventDefault();
      event.stopPropagation();
      clearSelectedFile(input).catch((error) => toast(error.message, 'err'));
    };
    const field = input.closest('.desktop-file-field') || input.parentElement;
    field?.append(button, state);
    input.addEventListener('change', () => {
      const file = input.files?.[0];
      if (file && input.matches('[data-exp-upload]') && !input.dataset.dbRestoring) persistExpenseUpload(input, file);
      updateClearButton(input);
    }, true);
    updateClearButton(input);
    restoreExpenseUpload(input);
  }

  function scanFileInputs(root = document) {
    if (root instanceof HTMLInputElement) installClearButton(root);
    qa('input[type="file"]', root).forEach(installClearButton);
  }

  function observeDocument(targetDocument) {
    hideDisabledAiTemplate(targetDocument);
    scanFileInputs(targetDocument);
    const observer = new MutationObserver((records) => {
      for (const record of records) for (const node of record.addedNodes) {
        if (node.nodeType === Node.ELEMENT_NODE) {
          scanFileInputs(node);
          hideDisabledAiTemplate(targetDocument);
        }
      }
    });
    observer.observe(targetDocument.body, { childList: true, subtree: true });
  }

  function installIframeSupport() {
    const enhance = (frame) => {
      try {
        const doc = frame.contentDocument;
        if (!doc?.body || doc.documentElement.dataset.desktopGlassV161) return;
        doc.documentElement.dataset.desktopGlassV161 = '1';
        const style = doc.createElement('style');
        style.id = 'desktop-daily-glass-v161';
        style.textContent = `
          :root{--bg:transparent!important;--panel:rgba(255,255,255,.76)!important;--text:#24384d!important;--muted:#687b8f!important;--line:rgba(79,106,135,.11)!important;--green:#3478f6!important;--green2:#276de7!important;--green-soft:rgba(52,120,246,.10)!important;--shadow:0 14px 36px rgba(45,68,94,.08)!important;color-scheme:light}
          html,body{background:transparent!important;color:#24384d!important}body{min-width:0!important}.page{max-width:none!important;padding:22px 20px 54px!important}
          .hero,.section-title{gap:14px!important}.hero h1{font-size:27px!important}.privacy,.panel,.shop-card,.actions,.loading-card{border:0!important;background:rgba(255,255,255,.72)!important;box-shadow:0 12px 34px rgba(45,68,94,.07)!important;backdrop-filter:blur(28px) saturate(1.04)!important;-webkit-backdrop-filter:blur(28px) saturate(1.04)!important}
          .panel{padding:18px!important}.shop-head{background:rgba(255,255,255,.32)!important;border-bottom-color:rgba(79,106,135,.08)!important}.upload-item,.metric,.table-wrap{border-color:rgba(79,106,135,.10)!important;background:rgba(255,255,255,.30)!important}.upload-item{border-style:dashed!important;padding:11px!important}
          input[type=date],input[type=number],input[type=text],select,.table-input{border:0!important;background:rgba(255,255,255,.76)!important;color:#24384d!important;box-shadow:inset 0 1px rgba(255,255,255,.72),0 5px 15px rgba(45,68,94,.05)!important}
          *{backdrop-filter:none!important;-webkit-backdrop-filter:none!important}.primary{background:#3478f6!important;box-shadow:0 8px 20px rgba(52,120,246,.20)!important}.secondary,.mini-btn{border:0!important;background:rgba(255,255,255,.68)!important;color:#35506b!important}.status.ok,summary{color:#3478f6!important}.badge.ok{background:rgba(52,120,246,.10)!important;color:#3478f6!important}
          .desktop-file-field{position:relative;display:grid;grid-template-columns:auto minmax(0,1fr);align-items:center;gap:7px;width:100%;min-height:39px;padding:6px 7px;border:1px solid rgba(52,120,246,.18);border-radius:12px;background:rgba(255,255,255,.62);box-shadow:inset 0 1px rgba(255,255,255,.72),0 6px 16px rgba(45,68,94,.05);overflow:hidden}.desktop-file-native{position:absolute!important;inset:0!important;width:100%!important;height:100%!important;opacity:0!important;cursor:pointer!important}.desktop-file-choose{position:relative;z-index:2;min-height:27px;padding:0 10px;border:0;border-radius:8px;background:rgba(52,120,246,.10);color:#245fc9;font-size:10px;font-weight:800}.desktop-file-name,.desktop-file-state{position:relative;z-index:2;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#6a7a8c;font-size:10px;pointer-events:none}.desktop-clear-upload{position:relative;z-index:3;margin:0;padding:6px 9px;border:0;border-radius:8px;background:rgba(255,255,255,.62);color:#536579;cursor:pointer}
          th{background:rgba(229,238,248,.76)!important;color:#41617f!important}td,th{border-bottom-color:rgba(79,106,135,.08)!important}.actions{background:rgba(255,255,255,.78)!important}
          @media(max-width:1050px){.page{padding:18px 14px 48px!important}.top-grid{grid-template-columns:repeat(2,minmax(0,1fr))!important}.shop-grid{grid-template-columns:1fr!important}.uploads{grid-template-columns:repeat(3,minmax(0,1fr))!important}.money-grid{grid-template-columns:repeat(2,minmax(0,1fr))!important}.template-box{align-items:stretch!important}.template-box input{max-width:none!important}.desktop-file-field{min-width:0!important}.hero{display:flex!important}.privacy{margin-top:0!important}}
          @media(max-width:760px){.top-grid,.uploads,.money-grid,.extra-grid{grid-template-columns:1fr!important}.hero{display:block!important}.privacy{display:inline-block!important;margin-top:12px!important}.actions{position:relative!important;bottom:auto!important;align-items:stretch!important;flex-direction:column!important}.primary{width:100%!important}}
        `;
        doc.head.appendChild(style);
        observeDocument(doc);
        if (frame.id === 'dailyReportFrame') {
          const start = doc.getElementById('startDate');
          const end = doc.getElementById('endDate');
          const dateKey = 'lazadaDailyReportDatesV161';
          try {
            const saved = JSON.parse(localStorage.getItem(dateKey) || '{}');
            if (start && saved.start) start.value = saved.start;
            if (end && saved.end) end.value = saved.end;
          } catch { /* keep embedded defaults */ }
          const persistDates = () => {
            try { localStorage.setItem(dateKey, JSON.stringify({ start: start?.value || '', end: end?.value || '' })); }
            catch { /* storage remains optional */ }
          };
          start?.addEventListener('change', persistDates);
          end?.addEventListener('change', persistDates);
        }
      } catch { /* cross-origin frame, not used by the offline app */ }
    };
    qa('iframe').forEach((frame) => {
      frame.addEventListener('load', () => enhance(frame));
      if (frame.contentDocument?.readyState === 'complete' && frame.contentDocument.body) enhance(frame);
    });
  }

  function optimizeSearchInputs() {
    for (const id of ['controlSearch', 'activitySearch', 'repricingSearch']) {
      const input = q(`#${id}`);
      if (!input?.oninput || input.dataset.debouncedV13) continue;
      input.dataset.debouncedV13 = '1';
      input.oninput = debounce(input.oninput, 120);
    }
  }

  async function install() {
    setVersionBranding();
    installThemes();
    installReleaseNotes();
    installDownloadPanel();
    installDatabasePanel();
    optimizeSearchInputs();
    try {
      uploadMetadata = new Map((await window.desktopApp.uploads.list()).map((item) => [item.slot, item]));
    } catch (error) {
      console.error('Unable to list saved uploads:', error);
    }
    observeDocument(document);
    installScrollStability(document);
    hideDisabledAiTemplate(document);
    installIframeSupport();
    scanFileInputs();
    // Inventory and expense modules are injected by preload after this layer.
    // Re-assert the release branding once they finish their legacy bootstrap.
    window.setTimeout(setVersionBranding, 650);
    window.setTimeout(setVersionBranding, 1400);
    qa('#countrySwitch [data-country]').forEach((button) => button.addEventListener('click', () => setTimeout(() => {
      setVersionBranding();
      scanFileInputs();
    }, 90)));
    const brandLabel = q('#brandSystemLabel');
    if (brandLabel) new MutationObserver(setVersionBranding).observe(brandLabel, { childList: true, characterData: true, subtree: true });
    const releaseCurrent = q('#page-changelog .changelog-current');
    if (releaseCurrent) new MutationObserver(setVersionBranding).observe(releaseCurrent, { childList: true, characterData: true, subtree: true });
    window.__desktopEnhancementsV13 = { ready: true, refreshDatabasePanel, scanFileInputs, aiAnalysisTemplateEnabled: AI_ANALYSIS_TEMPLATE_ENABLED };
  }

  install().catch((error) => {
    console.error('V13 desktop enhancements failed:', error);
    window.__desktopEnhancementsV13 = { ready: false, error: error.message };
  });
})();
