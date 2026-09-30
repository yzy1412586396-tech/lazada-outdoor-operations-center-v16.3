(() => {
  'use strict';

  const bridge = window.desktopApp;
  if (!bridge?.aiSettings || !bridge?.aiChat || !bridge?.aiContext || !bridge?.aiMemory) return;

  // V16.3: AI分析模板暂未启用前端入口。完整代码、只读桥接和本地数据
  // 仍保留在本文件，后续需要重新启用时只需经过评审后恢复入口，不要删除本模块。
  const AI_ANALYSIS_TEMPLATE_ENABLED = false;

  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
  const escapeHtml = (value) => String(value ?? '').replace(/[&<>'"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[char]);
  const formatBytes = (value) => {
    const size = Number(value || 0);
    if (size < 1024) return `${size} B`;
    if (size < 1024 ** 2) return `${(size / 1024).toFixed(1)} KB`;
    return `${(size / 1024 ** 2).toFixed(1)} MB`;
  };
  const formatCost = (value) => `¥${Number(value || 0).toFixed(4)}`;
  const state = {
    status: null,
    providers: [],
    providerId: 'deepseek',
    sessions: [],
    sessionId: '',
    messages: [],
    activeRequestId: '',
    streamText: '',
    streamRenderPending: false,
    preview: null,
    contextOptions: { countries: [], stores: [], databases: [], modules: [] },
    memories: [],
    editingMemoryId: '',
    lastAssistantText: '',
    attachments: [],
  };

  function safeMarkdown(value) {
    const parts = String(value || '').split(/```/);
    return parts.map((part, index) => {
      if (index % 2) return `<pre>${escapeHtml(part)}</pre>`;
      let safe = escapeHtml(part);
      safe = safe.replace(/^###\s+(.+)$/gm, '<h4>$1</h4>');
      safe = safe.replace(/^##\s+(.+)$/gm, '<h3>$1</h3>');
      safe = safe.replace(/^#\s+(.+)$/gm, '<h2>$1</h2>');
      safe = safe.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
      safe = safe.replace(/`([^`\n]+)`/g, '<code>$1</code>');
      return safe.split(/\n{2,}/).map((paragraph) => `<p>${paragraph.replace(/\n/g, '<br>')}</p>`).join('');
    }).join('');
  }

  function notice(target, message, type = 'info') {
    const element = typeof target === 'string' ? $(target) : target;
    if (!element) return;
    element.className = `ai14-message ${type}`;
    element.textContent = message;
  }

  function errorMessage(error) {
    return error?.message || '操作失败，请稍后重试';
  }

  function installNavigation() {
    const nav = $('#nav');
    if (!nav) return;
    if (!nav.querySelector('[data-page="ai-observer"]')) {
      const button = document.createElement('button');
      button.dataset.page = 'ai-observer';
      button.innerHTML = '<span class="ico">✦</span>AI分析模板<span class="chip blue" style="margin-left:auto">只读</span>';
      const changelog = nav.querySelector('[data-page="changelog"]');
      nav.insertBefore(button, changelog || null);
      button.onclick = () => window.go('ai-observer');
    }
    if (!nav.querySelector('[data-page="data-safety"]')) {
      const button = document.createElement('button');
      button.dataset.page = 'data-safety';
      button.innerHTML = '<span class="ico">▣</span>数据安全与备份';
      const settings = nav.querySelector('[data-page="settings"]');
      settings?.after(button);
      button.onclick = () => window.go('data-safety');
    }
  }

  function installPages() {
    const main = $('main.main');
    if (!main) return;
    if (!$('#page-ai-observer')) {
      const page = document.createElement('section');
      page.className = 'page ai14-page';
      page.id = 'page-ai-observer';
      page.innerHTML = aiPageHtml();
      main.appendChild(page);
      const hero = page.querySelector('.ai14-hero');
      const analysis = page.querySelector('#ai14AnalysisTemplate');
      const chat = page.querySelector('#ai14ChatPanel');
      const settings = page.querySelector('#ai14SettingsPanel');
      if (hero && analysis && chat && settings) {
        hero.after(analysis);
        analysis.after(chat);
        chat.after(settings);
      }
    }
    if (!$('#page-data-safety')) {
      const page = document.createElement('section');
      page.className = 'page ai14-page';
      page.id = 'page-data-safety';
      page.innerHTML = safetyPageHtml();
      main.appendChild(page);
    }
    const previousGo = window.go;
    window.go = function goV14(pageName) {
      if (!['ai-observer', 'data-safety'].includes(pageName)) return previousGo(pageName);
      $$('.page').forEach((page) => page.classList.toggle('active', page.id === `page-${pageName}`));
      $$('#nav button').forEach((button) => button.classList.toggle('active', button.dataset.page === pageName));
      $('#pageTitle').textContent = pageName === 'ai-observer' ? 'AI分析模板' : '数据安全与备份';
      $('#pageSub').textContent = pageName === 'ai-observer' ? '自由选择一个或多个业务模块，预览后进行只读联合分析' : '数据库迁移、完整性检查、备份与恢复';
      window.scrollTo({ top: 0 });
      if (pageName === 'ai-observer') refreshAiPage();
      if (pageName === 'data-safety') refreshSafetyPage();
    };
  }

  function aiPageHtml() {
    return `
      <div class="ai14-hero"><div><div class="ai14-eyebrow">AI Analysis Template</div><h2>AI分析模板</h2><p>先在日报、库存、控价、活动报名、全店改价、费用等模块完成工作，再回到这里自由选择一个或多个模块联合分析。AI只读取你明确预览并确认发送的摘要，不会出现在业务模块中，也不能修改任何业务结果。</p></div><div class="ai14-observer-seal"><strong>Observer only · 只读观察</strong><span>可联合分析控价、活动报名与日报等多模块。普通聊天默认不携带任何业务历史。</span></div></div>
      <div class="ai14-panel" id="ai14SettingsPanel"><div class="ai14-panel-head"><div><div class="ai14-eyebrow">Optional AI Connection</div><h3>AI连接设置（可选）</h3><p>不接入或暂时不想使用AI时保持关闭即可；业务模块不受影响。</p></div><div class="ai14-actions"><label class="ai14-switch"><span>AI总开关</span><input type="checkbox" id="ai14Enabled"></label><button class="ai14-btn sm" id="ai14ToggleSettings">展开设置</button></div></div><div class="ai14-panel-body ai14-settings-body ai14-collapsed">
        <div class="ai14-form-grid">
          <label class="ai14-field"><span>服务商</span><select id="ai14Provider"></select></label>
          <label class="ai14-field"><span>服务商名称</span><input id="ai14ProviderName" maxlength="80"></label>
          <label class="ai14-field"><span>模型名称（可修改）</span><input id="ai14Model" maxlength="160"></label>
          <label class="ai14-field wide"><span>Base URL</span><input id="ai14BaseUrl" maxlength="500"></label>
          <label class="ai14-field"><span>请求超时（毫秒）</span><input id="ai14Timeout" type="number" min="5000" max="600000"></label>
          <label class="ai14-field"><span>Provider最大输入Token</span><input id="ai14ProviderInput" type="number" min="1000"></label>
          <label class="ai14-field"><span>Provider最大输出Token</span><input id="ai14ProviderOutput" type="number" min="64"></label>
          <label class="ai14-field"><span>输入费用 / 百万Token</span><input id="ai14InputCost" type="number" min="0" step="0.0001"></label>
          <label class="ai14-field"><span>输出费用 / 百万Token</span><input id="ai14OutputCost" type="number" min="0" step="0.0001"></label>
          <div class="ai14-field"><span>Provider选项</span><div class="ai14-option-grid"><label class="ai14-check"><input type="checkbox" id="ai14ProviderEnabled">启用</label><label class="ai14-check"><input type="checkbox" id="ai14Stream">流式输出</label></div></div>
          <label class="ai14-field wide"><span>API Key（保存后立即清空输入框）</span><input id="ai14ApiKey" type="password" autocomplete="new-password" placeholder="不会回显完整密钥"></label>
        </div>
        <div class="ai14-actions" style="margin-top:12px"><button class="ai14-btn primary" id="ai14SaveProvider">保存服务商配置</button><button class="ai14-btn" id="ai14SaveKey">保存密钥</button><button class="ai14-btn" id="ai14Test">测试连接</button><button class="ai14-btn danger" id="ai14DeleteKey">删除密钥</button><span id="ai14KeyState" class="chip muted">未配置</span></div>
        <details style="margin-top:14px"><summary style="cursor:pointer;color:var(--accent);font-size:11px;font-weight:850">费用与调用限制</summary><div class="ai14-form-grid" style="margin-top:12px"><label class="ai14-field"><span>单次最大输入Token</span><input id="ai14LimitInput" type="number" min="1000"></label><label class="ai14-field"><span>单次最大输出Token</span><input id="ai14LimitOutput" type="number" min="64"></label><label class="ai14-field"><span>单日最大调用次数</span><input id="ai14LimitCalls" type="number" min="1"></label><label class="ai14-field"><span>单日费用上限</span><input id="ai14LimitDailyCost" type="number" min="0" step="0.01"></label><label class="ai14-field"><span>单月费用上限</span><input id="ai14LimitMonthlyCost" type="number" min="0" step="0.01"></label><label class="ai14-check"><input id="ai14CostEstimation" type="checkbox">启用费用估算</label></div><button class="ai14-btn" style="margin-top:10px" id="ai14SaveLimits">保存费用限制</button></details>
        <div class="ai14-status-row"><div class="ai14-stat"><span>连接 / 密钥</span><b id="ai14ConnectionStat">未配置</b></div><div class="ai14-stat"><span>本次Token</span><b id="ai14CurrentTokens">0</b></div><div class="ai14-stat"><span>今日调用次数</span><b id="ai14TodayCalls">0</b></div><div class="ai14-stat"><span>今日 / 本月预估费用</span><b id="ai14Costs">¥0 / ¥0</b></div></div>
        <div id="ai14StatusMessage" class="ai14-message info" style="margin-top:12px">AI关闭时不会产生任何网络请求。</div>
      </div></div>
      <div class="ai14-panel" id="ai14ChatPanel"><div class="ai14-panel-head"><div><div class="ai14-eyebrow">Local Chat</div><h3>本地AI聊天</h3><p>聊天记录保存在本机SQLite。普通发送不会自动附带业务数据；附件必须由你选择并再次确认。</p></div><div class="ai14-actions"><button class="ai14-btn sm" id="ai14NewSession">新建会话</button><button class="ai14-btn sm" id="ai14RenameSession">改名</button><button class="ai14-btn sm" id="ai14Summarize">生成较早对话摘要</button><button class="ai14-btn danger sm" id="ai14ClearSession">清空</button><button class="ai14-btn danger sm" id="ai14DeleteSession">删除</button></div></div><div class="ai14-chat"><aside class="ai14-sessions"><div class="ai14-eyebrow">Sessions</div><div class="ai14-session-list" id="ai14SessionList"></div></aside><div class="ai14-chat-main"><div class="ai14-message-list" id="ai14Messages"></div><div class="ai14-composer"><textarea id="ai14ChatInput" maxlength="12000" placeholder="普通聊天默认不读取业务数据。Enter发送，Shift+Enter换行。"></textarea><div class="ai14-attachment-toolbar"><input id="ai14AttachmentInput" type="file" multiple hidden accept="image/png,image/jpeg,image/webp,image/gif,.xlsx,.xls,.xlsm,.csv,.txt,.md,.json,.log,.xml,.html"><button class="ai14-btn sm" id="ai14AddAttachment" type="button">＋ 添加图片或文件</button><small>最多3个；图片单张4MB，文件单个8MB。Excel/CSV/文本先在本机提取内容。</small></div><div class="ai14-attachment-list" id="ai14Attachments"></div><div class="ai14-composer-bar"><small>AI仅输出文字建议，不执行操作。DeepSeek当前仅支持文字附件；图片需使用支持视觉的自定义OpenAI兼容模型。</small><div class="ai14-actions"><button class="ai14-btn" id="ai14Regenerate">重新生成</button><button class="ai14-btn danger" id="ai14Stop" disabled>停止生成</button><button class="ai14-btn primary" id="ai14Send">发送</button></div></div></div></div></div></div>
      <div class="ai14-panel ai14-template-panel" id="ai14AnalysisTemplate"><div class="ai14-panel-head"><div><div class="ai14-eyebrow">Cross-module Analysis</div><h3>选择AI分析模板与业务范围</h3><p>可只选一个模块，也可把控价、活动报名、日报等多个模块放在同一次预览中关联分析。</p></div><span class="chip blue" id="ai14TemplateName">自定义组合</span></div><div class="ai14-panel-body">
        <div class="ai14-template-strip"><span>快捷模板</span><button class="ai14-btn sm" data-ai14-template="pricing-activity-daily">控价＋活动＋日报</button><button class="ai14-btn sm" data-ai14-template="pricing-activity">控价＋活动</button><button class="ai14-btn sm" data-ai14-template="daily-inventory-expense">日报＋库存＋费用</button><button class="ai14-btn sm" data-ai14-template="full-review">全链路复盘</button><button class="ai14-btn sm" data-ai14-template="custom">清空并自定义</button><span class="ai14-template-note">模板只负责选择数据，不会自动调用AI</span></div>
        <div class="ai14-quick-ranges"><button class="ai14-btn sm" data-ai14-range="today">今天</button><button class="ai14-btn sm" data-ai14-range="7">最近7天</button><button class="ai14-btn sm" data-ai14-range="30">最近30天</button><button class="ai14-btn sm" data-ai14-range="90">最近90天</button><button class="ai14-btn sm" data-ai14-range="month">本月</button><button class="ai14-btn sm" data-ai14-range="last-month">上月</button></div>
        <div class="ai14-form-grid"><label class="ai14-field"><span>国家</span><select id="ai14Country"><option value="">全部国家</option></select></label><label class="ai14-field"><span>店铺</span><select id="ai14Store"><option value="">全部店铺</option></select></label><label class="ai14-field"><span>业务数据库</span><select id="ai14Database"><option value="">全部数据库</option></select></label><label class="ai14-field"><span>开始日期</span><input id="ai14DateStart" type="date"></label><label class="ai14-field"><span>结束日期</span><input id="ai14DateEnd" type="date"></label><label class="ai14-field"><span>最大明细行数</span><input id="ai14DetailLimit" type="number" min="1" max="500" value="100"></label><label class="ai14-field wide"><span>本次分析问题</span><textarea id="ai14ContextQuestion" maxlength="6000" placeholder="例如：分析最近30天费用变化和异常，并列出需要人工复核的事项。"></textarea></label></div>
        <div style="margin-top:12px"><span class="ai14-eyebrow">数据模块（可多选）</span><div class="ai14-module-grid" id="ai14Modules"><label class="ai14-check"><input type="checkbox" value="daily_report">日报</label><label class="ai14-check"><input type="checkbox" value="inventory">库存</label><label class="ai14-check"><input type="checkbox" value="control_price">控价</label><label class="ai14-check"><input type="checkbox" value="activity_price">活动报名</label><label class="ai14-check"><input type="checkbox" value="repricing">全店改价</label><label class="ai14-check"><input type="checkbox" value="expense">月度费用</label><label class="ai14-check"><input type="checkbox" value="sku">SKU历史</label><label class="ai14-check"><input type="checkbox" value="operation">操作历史</label></div></div>
        <div style="margin-top:12px"><span class="ai14-eyebrow">指标与内容</span><div class="ai14-option-grid" id="ai14ContextFlags"><label class="ai14-check"><input data-indicator type="checkbox" value="count" checked>数量</label><label class="ai14-check"><input data-indicator type="checkbox" value="average" checked>平均值</label><label class="ai14-check"><input data-indicator type="checkbox" value="min" checked>最小值</label><label class="ai14-check"><input data-indicator type="checkbox" value="max" checked>最大值</label><label class="ai14-check"><input data-indicator type="checkbox" value="trend" checked>趋势</label><label class="ai14-check"><input id="ai14IncludeSku" type="checkbox">包含SKU</label><label class="ai14-check"><input id="ai14IncludeTitles" type="checkbox">包含商品标题</label><label class="ai14-check"><input id="ai14IncludeDetails" type="checkbox">包含明细</label><label class="ai14-check"><input id="ai14IncludeAnomalies" type="checkbox" checked>包含异常</label><label class="ai14-check"><input id="ai14IncludeChat" type="checkbox">包含最近聊天</label><label class="ai14-check"><input id="ai14IncludeMemories" type="checkbox">包含已确认长期记忆</label></div></div>
        <div class="ai14-actions" style="margin-top:14px"><button class="ai14-btn" id="ai14BuildPreview">生成发送预览</button><button class="ai14-btn primary" id="ai14ConfirmSend" disabled>确认发送并分析</button><span style="color:var(--muted);font-size:10px">预览10分钟内有效</span></div><div id="ai14ContextStatus" class="ai14-message info" style="margin-top:12px">尚未生成预览，当前不会发送任何业务数据。</div><div id="ai14Preview"></div>
      </div></div>
      <div class="ai14-panel"><div class="ai14-panel-head"><div><div class="ai14-eyebrow">Confirmed Memory</div><h3>用户确认的长期记忆</h3><p>AI不能自动永久保存。每条内容都必须在这里由用户编辑并确认。</p></div><button class="ai14-btn" id="ai14UseLastAnswer">把最后回答放入待确认区</button></div><div class="ai14-panel-body"><div class="ai14-memory-layout"><div><div class="ai14-memory-list" id="ai14MemoryList"></div></div><div><div class="ai14-form-grid"><label class="ai14-field"><span>标题</span><input id="ai14MemoryTitle" maxlength="160"></label><label class="ai14-field"><span>类型</span><select id="ai14MemoryType"><option value="sku_rule">SKU规则</option><option value="country_difference">国家差异</option><option value="store_relation">店铺关系</option><option value="price_control">控价原则</option><option value="activity_requirement">活动要求</option><option value="user_preference">用户偏好</option><option value="operation_experience">运营经验</option><option value="business_background" selected>固定业务背景</option></select></label><label class="ai14-field"><span>国家</span><input id="ai14MemoryCountry" maxlength="10" placeholder="可留空"></label><label class="ai14-field"><span>店铺ID</span><input id="ai14MemoryStore" maxlength="100" placeholder="可留空"></label><label class="ai14-field"><span>业务模块</span><input id="ai14MemoryModule" maxlength="40" placeholder="可留空"></label><label class="ai14-field"><span>来源</span><input id="ai14MemorySource" maxlength="160" value="user"></label><label class="ai14-field wide"><span>内容（保存前请人工核对）</span><textarea id="ai14MemoryContent" maxlength="12000"></textarea></label><label class="ai14-check"><input id="ai14MemoryEnabled" type="checkbox" checked>启用此记忆</label></div><div class="ai14-actions" style="margin-top:12px"><button class="ai14-btn primary" id="ai14SaveMemory">确认并保存长期记忆</button><button class="ai14-btn" id="ai14ResetMemory">清空编辑区</button></div><div id="ai14MemoryStatus" class="ai14-message info" style="margin-top:11px">未经点击“确认并保存”的内容不会进入长期记忆。</div></div></div></div></div>
    `;
  }

  function safetyPageHtml() {
    return `
      <div class="ai14-hero"><div><div class="ai14-eyebrow">Local Data Safety</div><h2>数据安全与备份</h2><p>数据库位于Electron userData目录，软件更新不会覆盖。恢复操作前会自动再备份当前数据库，所有迁移都使用事务并保留原始旧数据。</p></div><div class="ai14-observer-seal"><strong>SQLite · Local only</strong><span>外键约束、WAL、版本迁移、完整性检查和错误回滚均已启用。</span></div></div>
      <div class="ai14-panel"><div class="ai14-panel-head"><div><div class="ai14-eyebrow">Database</div><h3>本地数据库状态</h3><p>出于安全边界，renderer不获取真实绝对路径或SQL接口。</p></div><div class="ai14-actions"><button class="ai14-btn" id="ai14OpenDataFolder">打开数据目录</button><button class="ai14-btn" id="ai14Integrity">完整性检查</button></div></div><div class="ai14-panel-body"><div class="ai14-db-metrics" id="ai14DbMetrics"></div><div id="ai14IntegrityStatus" class="ai14-message info" style="margin-top:12px">尚未执行完整性检查。</div></div></div>
      <div class="ai14-grid"><div class="ai14-panel"><div class="ai14-panel-head"><div><div class="ai14-eyebrow">Backups</div><h3>备份与恢复</h3><p>每日首次启动自动备份；默认保留最近30个自动备份。</p></div><div class="ai14-actions"><button class="ai14-btn primary" id="ai14BackupNow">立即备份</button><button class="ai14-btn" id="ai14ImportBackup">导入备份包</button></div></div><div class="ai14-panel-body"><div class="ai14-actions" style="margin-bottom:12px"><label class="ai14-field" style="max-width:190px"><span>自动备份保留数量</span><input id="ai14Retention" type="number" min="3" max="365" value="30"></label><button class="ai14-btn" id="ai14SaveRetention">保存数量</button><button class="ai14-btn" id="ai14CleanupBackups">清理过旧自动备份</button></div><div class="ai14-backup-list" id="ai14BackupList"></div><div id="ai14BackupStatus" class="ai14-message info" style="margin-top:12px">恢复必须由用户再次确认，且恢复前会先备份当前数据库。</div></div></div>
      <div class="ai14-panel"><div class="ai14-panel-head"><div><div class="ai14-eyebrow">Migration</div><h3>旧数据迁移</h3><p>先预览数量和重复项，再备份并事务迁移；旧localStorage镜像不会被清空。</p></div></div><div class="ai14-panel-body"><div id="ai14MigrationSummary" class="ai14-message info">正在检查旧数据…</div><div id="ai14MigrationList" style="display:grid;gap:8px;margin-top:11px"></div><div class="ai14-actions" style="margin-top:12px"><button class="ai14-btn" id="ai14MigrationPreview">重新预览</button><button class="ai14-btn primary" id="ai14MigrationExecute">确认备份并迁移</button><button class="ai14-btn" id="ai14MigrationDefer">暂不迁移</button></div></div></div></div>
    `;
  }

  async function refreshAiPage() {
    await Promise.allSettled([loadStatus(), loadSessions(), loadContextOptions(), loadMemories()]);
  }

  async function loadStatus() {
    try {
      state.status = await bridge.aiSettings.status();
      state.providers = state.status.providers;
      const select = $('#ai14Provider');
      const previous = state.providerId;
      select.innerHTML = state.providers.map((provider) => `<option value="${escapeHtml(provider.providerId)}">${escapeHtml(provider.name)}${provider.developmentOnly ? ' · 开发测试' : ''}</option>`).join('');
      state.providerId = state.providers.some((provider) => provider.providerId === previous) ? previous : (state.providers.find((provider) => provider.enabled)?.providerId || state.providers[0]?.providerId || 'deepseek');
      select.value = state.providerId;
      $('#ai14Enabled').checked = state.status.aiEnabled;
      const limits = state.status.limits || {};
      $('#ai14LimitInput').value = limits.maxInputTokens || 12000;
      $('#ai14LimitOutput').value = limits.maxOutputTokens || 1200;
      $('#ai14LimitCalls').value = limits.dailyCalls || 20;
      $('#ai14LimitDailyCost').value = limits.dailyCost ?? 10;
      $('#ai14LimitMonthlyCost').value = limits.monthlyCost ?? 100;
      $('#ai14CostEstimation').checked = limits.costEstimation !== false;
      $('#ai14TodayCalls').textContent = state.status.usage?.daily?.calls || 0;
      $('#ai14Costs').textContent = `${formatCost(state.status.usage?.daily?.cost)} / ${formatCost(state.status.usage?.monthly?.cost)}`;
      renderProvider();
    } catch (error) {
      notice('#ai14StatusMessage', errorMessage(error), 'danger');
    }
  }

  function selectedProvider() { return state.providers.find((provider) => provider.providerId === state.providerId); }

  function renderProvider() {
    const provider = selectedProvider();
    if (!provider) return;
    $('#ai14ProviderName').value = provider.name;
    $('#ai14BaseUrl').value = provider.baseUrl;
    $('#ai14Model').value = provider.modelName;
    $('#ai14Timeout').value = provider.timeoutMs;
    $('#ai14ProviderInput').value = provider.maxInputTokens;
    $('#ai14ProviderOutput').value = provider.maxOutputTokens;
    $('#ai14InputCost').value = provider.inputCostPerMillion || 0;
    $('#ai14OutputCost').value = provider.outputCostPerMillion || 0;
    $('#ai14ProviderEnabled').checked = provider.enabled;
    $('#ai14Stream').checked = provider.streamEnabled;
    const configured = provider.keyStatus?.configured;
    $('#ai14KeyState').className = `chip ${configured ? 'good' : 'muted'}`;
    $('#ai14KeyState').textContent = configured ? `已配置 ${provider.keyStatus.masked || ''}` : '未配置';
    $('#ai14ConnectionStat').textContent = provider.providerId === 'mock' ? 'Mock就绪' : configured ? '密钥已配置' : '未配置';
    const developmentOnly = Boolean(provider.developmentOnly);
    for (const id of ['ai14ProviderName', 'ai14BaseUrl', 'ai14Model', 'ai14Timeout', 'ai14ProviderInput', 'ai14ProviderOutput', 'ai14InputCost', 'ai14OutputCost', 'ai14ProviderEnabled', 'ai14Stream', 'ai14SaveProvider', 'ai14SaveKey', 'ai14DeleteKey']) $( `#${id}` ).disabled = developmentOnly;
  }

  async function saveProvider() {
    const provider = selectedProvider();
    if (!provider || provider.developmentOnly) return;
    try {
      await bridge.aiSettings.saveProviderConfig({
        providerId: provider.providerId,
        name: $('#ai14ProviderName').value,
        baseUrl: $('#ai14BaseUrl').value,
        modelName: $('#ai14Model').value,
        timeoutMs: Number($('#ai14Timeout').value),
        maxInputTokens: Number($('#ai14ProviderInput').value),
        maxOutputTokens: Number($('#ai14ProviderOutput').value),
        inputCostPerMillion: Number($('#ai14InputCost').value || 0),
        outputCostPerMillion: Number($('#ai14OutputCost').value || 0),
        enabled: $('#ai14ProviderEnabled').checked,
        streamEnabled: $('#ai14Stream').checked,
      });
      notice('#ai14StatusMessage', '服务商配置已保存，模型名称和费用参数可随时修改。', 'good');
      await loadStatus();
    } catch (error) { notice('#ai14StatusMessage', errorMessage(error), 'danger'); }
  }

  async function saveKey() {
    const key = $('#ai14ApiKey').value.trim();
    if (!key) return notice('#ai14StatusMessage', '请输入API Key', 'warn');
    try {
      await bridge.aiSettings.saveKey(state.providerId, key);
      $('#ai14ApiKey').value = '';
      notice('#ai14StatusMessage', 'API Key已由系统安全存储加密保存，renderer不会读取或回显完整内容。', 'good');
      await loadStatus();
    } catch (error) { $('#ai14ApiKey').value = ''; notice('#ai14StatusMessage', errorMessage(error), 'danger'); }
  }

  async function testConnection() {
    notice('#ai14StatusMessage', '正在执行用户主动发起的连接测试…', 'info');
    try {
      const result = await bridge.aiSettings.testConnection(state.providerId);
      notice('#ai14StatusMessage', `${result.providerId} / ${result.modelName} 连接成功。`, 'good');
    } catch (error) { notice('#ai14StatusMessage', errorMessage(error), 'danger'); }
  }

  async function loadSessions() {
    try {
      state.sessions = await bridge.aiChat.getSessions();
      if (!state.sessions.length) {
        const session = await bridge.aiChat.createSession({ name: '运营观察 · 新会话', providerId: state.providerId || 'deepseek' });
        state.sessions = [session];
      }
      if (!state.sessions.some((session) => session.id === state.sessionId)) state.sessionId = state.sessions[0].id;
      renderSessions();
      await loadMessages();
    } catch (error) { notice('#ai14StatusMessage', errorMessage(error), 'danger'); }
  }

  function renderSessions() {
    $('#ai14SessionList').innerHTML = state.sessions.map((session) => `<button class="ai14-session ${session.id === state.sessionId ? 'active' : ''}" data-ai14-session="${escapeHtml(session.id)}"><strong>${escapeHtml(session.name)}</strong><span>${session.messageCount || 0} 条 · ${escapeHtml(session.modelName || '')}</span></button>`).join('');
  }

  async function loadMessages() {
    if (!state.sessionId) return;
    state.messages = await bridge.aiChat.getMessages({ sessionId: state.sessionId, limit: 300 });
    state.lastAssistantText = [...state.messages].reverse().find((message) => message.role === 'assistant')?.content || '';
    renderMessages();
  }

  function renderMessages() {
    const list = $('#ai14Messages');
    if (!list) return;
    const messages = [...state.messages];
    if (state.activeRequestId && state.streamText) messages.push({ id: 'streaming', role: 'assistant', content: state.streamText, requestStatus: 'streaming', createdAt: new Date().toISOString() });
    list.innerHTML = messages.length ? messages.map((message) => {
      const assistant = message.role === 'assistant';
      const analysis = message.analysis;
      const sourceHtml = analysis?.sources?.length ? `<details class="ai14-source"><summary><strong>本次分析来源</strong> · ${analysis.sources.reduce((sum, item) => sum + Number(item.recordCount || 0), 0)} 条引用</summary>${analysis.sources.map((source) => `<div>${escapeHtml(source.module || source.sourceType)} · ${escapeHtml(source.dateStart || '')}${source.dateEnd ? ` 至 ${escapeHtml(source.dateEnd)}` : ''} · 快照 ${escapeHtml(source.snapshotAt || '')}</div>`).join('')}</details>` : '';
      return `<article class="ai14-bubble ${assistant ? 'assistant' : 'user'} ${message.requestStatus === 'streaming' ? 'pending' : ''}"><div class="ai14-bubble-meta"><span>${assistant ? '只读AI观察' : '用户'}</span><span>${escapeHtml(String(message.createdAt || '').replace('T', ' ').slice(0, 19))}</span></div><div class="ai14-markdown">${assistant ? safeMarkdown(message.content) : `<p>${escapeHtml(message.content).replace(/\n/g, '<br>')}</p>`}</div>${assistant && message.id !== 'streaming' ? `<div class="ai14-actions" style="margin-top:9px"><button class="ai14-btn sm" data-copy-ai14="${escapeHtml(message.id)}">复制回答</button>${analysis ? `<span style="font-size:9px;color:var(--muted)">Token ${analysis.inputTokens || 0}+${analysis.outputTokens || 0} · ${formatCost(analysis.estimatedCost)}</span>` : ''}</div>${sourceHtml}` : ''}</article>`;
    }).join('') : '<div class="ai14-message info">当前会话还没有消息。普通聊天不会自动读取业务数据库。</div>';
    list.scrollTop = list.scrollHeight;
  }

  function scheduleStreamRender() {
    if (state.streamRenderPending) return;
    state.streamRenderPending = true;
    requestAnimationFrame(() => { state.streamRenderPending = false; renderMessages(); });
  }

  const ATTACHMENT_LIMITS = Object.freeze({ count: 3, fileBytes: 8 * 1024 * 1024, imageBytes: 4 * 1024 * 1024, textChars: 30000, totalTextChars: 48000 });
  const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);
  const TEXT_EXTENSIONS = new Set(['csv', 'txt', 'md', 'json', 'log', 'xml', 'html']);
  const EXCEL_EXTENSIONS = new Set(['xlsx', 'xls', 'xlsm']);

  function fileExtension(name) {
    return String(name || '').split('.').pop().toLowerCase();
  }

  function readAsDataUrl(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result || ''));
      reader.onerror = () => reject(new Error(`无法读取图片：${file.name}`));
      reader.readAsDataURL(file);
    });
  }

  async function parseAttachment(file) {
    const extension = fileExtension(file.name);
    const mimeType = String(file.type || '').toLowerCase();
    if (IMAGE_TYPES.has(mimeType) || ['png', 'jpg', 'jpeg', 'webp', 'gif'].includes(extension)) {
      if (file.size > ATTACHMENT_LIMITS.imageBytes) throw new Error(`${file.name}超过单张图片4MB限制`);
      const dataUrl = await readAsDataUrl(file);
      if (!/^data:image\/(?:png|jpeg|webp|gif);base64,/i.test(dataUrl)) throw new Error(`${file.name}不是受支持的图片格式`);
      return { id: crypto.randomUUID(), kind: 'image', name: file.name, mimeType: mimeType || `image/${extension === 'jpg' ? 'jpeg' : extension}`, size: file.size, dataUrl, preview: dataUrl, truncated: false };
    }
    if (file.size > ATTACHMENT_LIMITS.fileBytes) throw new Error(`${file.name}超过单个文件8MB限制`);
    let extracted = '';
    if (EXCEL_EXTENSIONS.has(extension)) {
      if (!window.XLSX) throw new Error('Excel组件未加载，暂时无法读取该附件');
      const workbook = window.XLSX.read(await file.arrayBuffer(), { type: 'array', cellDates: true });
      const sections = [];
      for (const sheetName of workbook.SheetNames.slice(0, 8)) {
        const csv = window.XLSX.utils.sheet_to_csv(workbook.Sheets[sheetName], { blankrows: false });
        sections.push(`工作表：${sheetName}\n${csv}`);
        if (sections.join('\n\n').length >= ATTACHMENT_LIMITS.textChars) break;
      }
      extracted = sections.join('\n\n');
    } else if (TEXT_EXTENSIONS.has(extension) || mimeType.startsWith('text/')) {
      extracted = await file.text();
    } else {
      throw new Error(`${file.name}暂不支持。当前支持图片、Excel、CSV、TXT、MD、JSON、LOG、XML和HTML`);
    }
    if (!extracted.trim()) throw new Error(`${file.name}没有可发送的文本内容`);
    const truncated = extracted.length > ATTACHMENT_LIMITS.textChars;
    extracted = extracted.slice(0, ATTACHMENT_LIMITS.textChars);
    return { id: crypto.randomUUID(), kind: 'text', name: file.name, mimeType, size: file.size, text: extracted, preview: extracted.slice(0, 180), truncated };
  }

  function renderAttachments() {
    const list = $('#ai14Attachments');
    if (!list) return;
    if (!state.attachments.length) {
      list.innerHTML = '';
      list.classList.remove('visible');
      return;
    }
    list.classList.add('visible');
    list.innerHTML = state.attachments.map((item) => `<div class="ai14-attachment">${item.kind === 'image' ? `<img src="${item.preview}" alt="">` : '<div class="ai14-attachment-file">FILE</div>'}<div class="ai14-attachment-copy"><strong>${escapeHtml(item.name)}</strong><span>${item.kind === 'image' ? '图片将发送给支持视觉的模型' : `已在本机提取 ${item.text.length.toLocaleString()} 字符${item.truncated ? '（已截断）' : ''}`} · ${formatBytes(item.size)}</span></div><button type="button" class="ai14-attachment-remove" data-ai14-remove-attachment="${item.id}" title="移除附件">×</button></div>`).join('');
  }

  async function addAttachments(fileList) {
    const files = [...(fileList || [])];
    for (const file of files) {
      if (state.attachments.length >= ATTACHMENT_LIMITS.count) {
        notice('#ai14StatusMessage', `单次最多添加${ATTACHMENT_LIMITS.count}个附件`, 'warn');
        break;
      }
      try {
        const attachment = await parseAttachment(file);
        const currentText = state.attachments.reduce((sum, item) => sum + (item.kind === 'text' ? item.text.length : 0), 0);
        if (attachment.kind === 'text' && currentText + attachment.text.length > ATTACHMENT_LIMITS.totalTextChars) throw new Error('附件提取文本总量超过48000字符，请减少文件或内容');
        state.attachments.push(attachment);
        notice('#ai14StatusMessage', `${file.name}已在本机读取并加入待发送区，尚未上传给AI`, 'good');
      } catch (error) {
        notice('#ai14StatusMessage', errorMessage(error), 'danger');
      }
    }
    renderAttachments();
  }

  async function sendChat(textValue) {
    const content = String(textValue || '').trim();
    const attachments = state.attachments.map(({ id: attachmentId, preview, truncated, ...item }) => item);
    if ((!content && !attachments.length) || state.activeRequestId) return;
    if (attachments.some((item) => item.kind === 'image') && state.providerId === 'deepseek') {
      notice('#ai14StatusMessage', 'DeepSeek当前聊天接口只接收文字。请切换到支持视觉的自定义OpenAI兼容模型后再发送图片', 'warn');
      return;
    }
    if (attachments.length) {
      const names = attachments.map((item) => item.name).join('、');
      if (!window.confirm(`确认把以下附件内容发送给当前AI服务商进行只读分析吗？\n\n${names}\n\n软件只会保存附件名称和大小，不会把附件二进制或完整提取文本写进聊天数据库。`)) return;
    }
    if (!state.sessionId) await loadSessions();
    const requestId = `req-${crypto.randomUUID()}`;
    state.activeRequestId = requestId;
    state.streamText = '';
    $('#ai14Stop').disabled = false;
    $('#ai14Send').disabled = true;
    try {
      const result = await bridge.aiChat.sendMessage({ requestId, sessionId: state.sessionId, text: content, providerId: state.providerId, attachments, confirmedAttachments: attachments.length > 0 });
      $('#ai14CurrentTokens').textContent = `${result.usage.inputTokens} + ${result.usage.outputTokens}`;
      state.attachments = [];
      renderAttachments();
      $('#ai14ChatInput').value = '';
      await Promise.all([loadMessages(), loadStatus()]);
    } catch (error) {
      notice('#ai14StatusMessage', errorMessage(error), error.code === 'REQUEST_CANCELLED' ? 'warn' : 'danger');
      await loadMessages().catch(() => {});
    } finally {
      state.activeRequestId = '';
      state.streamText = '';
      $('#ai14Stop').disabled = true;
      $('#ai14Send').disabled = false;
      renderMessages();
    }
  }

  async function loadContextOptions() {
    try {
      state.contextOptions = await bridge.aiContext.getOptions();
      $('#ai14Country').innerHTML = '<option value="">全部国家</option>' + state.contextOptions.countries.map((item) => `<option value="${escapeHtml(item.code)}">${escapeHtml(item.name)}</option>`).join('');
      renderContextScopeOptions();
    } catch (error) { notice('#ai14ContextStatus', errorMessage(error), 'danger'); }
  }

  function renderContextScopeOptions() {
    const country = $('#ai14Country').value;
    const stores = state.contextOptions.stores.filter((item) => !country || item.country_code === country);
    const databases = state.contextOptions.databases.filter((item) => !country || item.country_code === country);
    $('#ai14Store').innerHTML = '<option value="">全部店铺</option>' + stores.map((item) => `<option value="${escapeHtml(item.id)}">${escapeHtml(item.name)}</option>`).join('');
    $('#ai14Database').innerHTML = '<option value="">全部数据库</option>' + databases.map((item) => `<option value="${escapeHtml(item.id)}">${escapeHtml(item.name)}</option>`).join('');
  }

  const ANALYSIS_TEMPLATES = Object.freeze({
    'pricing-activity-daily': {
      name: '控价＋活动＋日报',
      modules: ['control_price', 'activity_price', 'daily_report'],
      question: '请关联分析控价、活动报名与日报结果：找出价格策略与销售表现之间的异常、风险和需要人工复核的事项。',
    },
    'pricing-activity': {
      name: '控价＋活动',
      modules: ['control_price', 'activity_price'],
      question: '请对比控价与活动报名结果，分析报名价偏差、无法报名原因、潜在价格风险及需要人工核对的SKU。',
    },
    'daily-inventory-expense': {
      name: '日报＋库存＋费用',
      modules: ['daily_report', 'inventory', 'expense'],
      question: '请关联日报、库存与月度费用，分析销售、库存和费用投入的异常变化，并给出人工检查清单。',
    },
    'full-review': {
      name: '全链路复盘',
      modules: ['daily_report', 'inventory', 'control_price', 'activity_price', 'repricing', 'expense'],
      question: '请对所选日期范围做全链路运营复盘，关联销售、库存、控价、活动、全店改价和费用，说明趋势、风险、异常与人工复核优先级。',
    },
    custom: { name: '自定义组合', modules: [], question: '' },
  });

  function setAnalysisTemplate(templateId) {
    const template = ANALYSIS_TEMPLATES[templateId] || ANALYSIS_TEMPLATES.custom;
    const selected = new Set(template.modules);
    $$('#ai14Modules input').forEach((input) => { input.checked = selected.has(input.value); });
    $('#ai14TemplateName').textContent = template.name;
    if (template.question) $('#ai14ContextQuestion').value = template.question;
    if (templateId === 'custom') $('#ai14ContextQuestion').value = '';
    state.preview = null;
    $('#ai14ConfirmSend').disabled = true;
    $('#ai14Preview').innerHTML = '';
    notice('#ai14ContextStatus', `${template.name}已选择。请调整范围并生成发送预览；当前尚未调用AI。`, 'info');
  }

  function markCustomTemplate() {
    $('#ai14TemplateName').textContent = '自定义组合';
    state.preview = null;
    $('#ai14ConfirmSend').disabled = true;
  }

  function contextRequest() {
    return {
      sessionId: state.sessionId,
      question: $('#ai14ContextQuestion').value,
      countryCode: $('#ai14Country').value,
      storeId: $('#ai14Store').value,
      databaseId: $('#ai14Database').value,
      dateStart: $('#ai14DateStart').value,
      dateEnd: $('#ai14DateEnd').value,
      modules: $$('#ai14Modules input:checked').map((input) => input.value),
      indicators: $$('#ai14ContextFlags [data-indicator]:checked').map((input) => input.value),
      includeSku: $('#ai14IncludeSku').checked,
      includeTitles: $('#ai14IncludeTitles').checked,
      includeDetails: $('#ai14IncludeDetails').checked,
      maxDetailRows: Number($('#ai14DetailLimit').value || 100),
      includeAnomalies: $('#ai14IncludeAnomalies').checked,
      includeRecentChat: $('#ai14IncludeChat').checked,
      includeMemories: $('#ai14IncludeMemories').checked,
    };
  }

  async function buildPreview() {
    state.preview = null;
    $('#ai14ConfirmSend').disabled = true;
    if (!$$('#ai14Modules input:checked').length) {
      notice('#ai14ContextStatus', '请至少选择一个要分析的业务模块；普通聊天请使用下方聊天区域。', 'warn');
      return;
    }
    notice('#ai14ContextStatus', '正在由本地固定代码执行只读查询和汇总…', 'info');
    try {
      const preview = await bridge.aiContext.buildPreview(contextRequest());
      state.preview = preview;
      const summary = preview.summary;
      $('#ai14Preview').innerHTML = `<div class="ai14-preview"><div class="ai14-preview-summary"><div><span>模块 / 来源</span><b>${escapeHtml(summary.modules.join('、') || '无业务模块')}</b></div><div><span>引用记录 / 明细</span><b>${summary.recordCount} / ${summary.detailRows}</b></div><div><span>预计字符 / Token</span><b>${summary.estimatedCharacters} / ${summary.estimatedTokens}</b></div><div><span>敏感信息提示</span><b>${summary.containsPotentiallySensitiveInformation ? '可能包含，已隐藏已知字段' : '未发现'}</b></div></div><pre>${escapeHtml(JSON.stringify(preview.dataPreview, null, 2))}</pre></div>`;
      notice('#ai14ContextStatus', `预览已生成：${summary.recordCount}条引用，预计${summary.estimatedTokens} Token。请检查后再确认发送。`, summary.containsPotentiallySensitiveInformation ? 'warn' : 'good');
      $('#ai14ConfirmSend').disabled = false;
    } catch (error) { notice('#ai14ContextStatus', errorMessage(error), 'danger'); }
  }

  async function confirmContextSend() {
    if (!state.preview || state.activeRequestId) return;
    const confirmed = window.confirm('确认把当前预览中显示的数据摘要发送给所选AI服务商进行只读分析吗？');
    if (!confirmed) return;
    const requestId = `req-${crypto.randomUUID()}`;
    state.activeRequestId = requestId;
    state.streamText = '';
    $('#ai14ConfirmSend').disabled = true;
    $('#ai14Stop').disabled = false;
    try {
      const result = await bridge.aiContext.confirmAndSend({ requestId, sessionId: state.sessionId, providerId: state.providerId, previewId: state.preview.previewId, confirmed: true });
      $('#ai14CurrentTokens').textContent = `${result.usage.inputTokens} + ${result.usage.outputTokens}`;
      notice('#ai14ContextStatus', '只读分析完成，回答与本次引用来源已保存到本地聊天历史。', 'good');
      await Promise.all([loadMessages(), loadStatus()]);
    } catch (error) { notice('#ai14ContextStatus', errorMessage(error), error.code === 'REQUEST_CANCELLED' ? 'warn' : 'danger'); }
    finally {
      state.activeRequestId = '';
      state.streamText = '';
      $('#ai14Stop').disabled = true;
      $('#ai14ConfirmSend').disabled = !state.preview;
      renderMessages();
    }
  }

  function setQuickRange(range) {
    const today = new Date();
    const iso = (date) => {
      const offset = date.getTimezoneOffset() * 60000;
      return new Date(date.getTime() - offset).toISOString().slice(0, 10);
    };
    let start = new Date(today);
    let end = new Date(today);
    if (/^\d+$/.test(range)) start.setDate(today.getDate() - Number(range) + 1);
    if (range === 'month') start = new Date(today.getFullYear(), today.getMonth(), 1);
    if (range === 'last-month') { start = new Date(today.getFullYear(), today.getMonth() - 1, 1); end = new Date(today.getFullYear(), today.getMonth(), 0); }
    $('#ai14DateStart').value = iso(start);
    $('#ai14DateEnd').value = iso(end);
  }

  async function loadMemories() {
    try {
      state.memories = await bridge.aiMemory.list({});
      renderMemories();
    } catch (error) { notice('#ai14MemoryStatus', errorMessage(error), 'danger'); }
  }

  function renderMemories() {
    $('#ai14MemoryList').innerHTML = state.memories.length ? state.memories.map((item) => `<article class="ai14-memory ${item.enabled ? '' : 'disabled'}"><div class="ai14-memory-head"><h4>${escapeHtml(item.title)}</h4><span class="chip ${item.enabled ? 'good' : 'muted'}">${item.enabled ? '启用' : '停用'}</span></div><p>${escapeHtml(item.content)}</p><small>${escapeHtml(item.memoryType)} · ${escapeHtml(item.countryCode || '全部国家')} · 确认 ${escapeHtml(String(item.confirmedAt || '').slice(0, 10))}</small><div class="ai14-memory-actions"><button class="ai14-btn sm" data-memory-edit="${escapeHtml(item.id)}">编辑</button><button class="ai14-btn sm" data-memory-toggle="${escapeHtml(item.id)}">${item.enabled ? '禁用' : '启用'}</button><button class="ai14-btn danger sm" data-memory-delete="${escapeHtml(item.id)}">删除</button></div></article>`).join('') : '<div class="ai14-message info">暂无长期记忆。AI不会自动保存任何内容。</div>';
  }

  function resetMemoryEditor() {
    state.editingMemoryId = '';
    $('#ai14MemoryTitle').value = '';
    $('#ai14MemoryType').value = 'business_background';
    $('#ai14MemoryCountry').value = '';
    $('#ai14MemoryStore').value = '';
    $('#ai14MemoryModule').value = '';
    $('#ai14MemorySource').value = 'user';
    $('#ai14MemoryContent').value = '';
    $('#ai14MemoryEnabled').checked = true;
    $('#ai14SaveMemory').textContent = '确认并保存长期记忆';
  }

  function editMemory(memoryId) {
    const item = state.memories.find((memory) => memory.id === memoryId);
    if (!item) return;
    state.editingMemoryId = item.id;
    $('#ai14MemoryTitle').value = item.title;
    $('#ai14MemoryType').value = item.memoryType;
    $('#ai14MemoryCountry').value = item.countryCode;
    $('#ai14MemoryStore').value = item.storeId;
    $('#ai14MemoryModule').value = item.businessModule;
    $('#ai14MemorySource').value = item.source;
    $('#ai14MemoryContent').value = item.content;
    $('#ai14MemoryEnabled').checked = item.enabled;
    $('#ai14SaveMemory').textContent = '确认并更新长期记忆';
  }

  async function saveMemory() {
    const payload = {
      title: $('#ai14MemoryTitle').value,
      content: $('#ai14MemoryContent').value,
      memoryType: $('#ai14MemoryType').value,
      countryCode: $('#ai14MemoryCountry').value,
      storeId: $('#ai14MemoryStore').value,
      businessModule: $('#ai14MemoryModule').value,
      source: $('#ai14MemorySource').value || 'user',
      aiSuggested: $('#ai14MemorySource').value === 'ai_suggestion',
      enabled: $('#ai14MemoryEnabled').checked,
      userConfirmed: true,
    };
    try {
      if (state.editingMemoryId) await bridge.aiMemory.update({ id: state.editingMemoryId, ...payload });
      else await bridge.aiMemory.createConfirmed(payload);
      notice('#ai14MemoryStatus', '长期记忆已由用户确认并保存。', 'good');
      resetMemoryEditor();
      await loadMemories();
    } catch (error) { notice('#ai14MemoryStatus', errorMessage(error), 'danger'); }
  }

  async function refreshSafetyPage() {
    await Promise.allSettled([loadDatabaseInfo(), loadBackups(), loadMigrationPreview()]);
  }

  async function loadDatabaseInfo() {
    try {
      const info = await bridge.database.info();
      $('#ai14DbMetrics').innerHTML = [['数据库位置', info.location], ['Schema版本', `${info.schemaVersion} / ${info.expectedSchemaVersion}`], ['数据库大小', formatBytes(info.size)], ['业务历史', info.historyCount], ['备份数量', info.backups]].map(([label, value]) => `<div class="ai14-stat"><span>${escapeHtml(label)}</span><b>${escapeHtml(value)}</b></div>`).join('');
    } catch (error) { notice('#ai14IntegrityStatus', errorMessage(error), 'danger'); }
  }

  async function loadBackups() {
    try {
      const backups = await bridge.backup.list();
      $('#ai14BackupList').innerHTML = backups.length ? backups.map((item) => `<div class="ai14-backup"><div><strong>${escapeHtml(item.fileName)}</strong><span>${escapeHtml(item.reason)} · ${formatBytes(item.size)} · ${escapeHtml(String(item.createdAt).replace('T', ' ').slice(0, 19))} · 完整性 ${escapeHtml(item.integrity)}</span></div><div class="ai14-actions"><button class="ai14-btn sm" data-backup-export="${escapeHtml(item.fileName)}">导出</button><button class="ai14-btn danger sm" data-backup-restore="${escapeHtml(item.fileName)}">恢复</button></div></div>`).join('') : '<div class="ai14-message info">暂无备份。</div>';
    } catch (error) { notice('#ai14BackupStatus', errorMessage(error), 'danger'); }
  }

  async function loadMigrationPreview() {
    try {
      const preview = await bridge.migration.preview();
      notice('#ai14MigrationSummary', `状态：${preview.status}。检测到${preview.sourceCount}个旧存储源，预计${preview.totalEstimatedRecords}条可迁移记录；原数据将完整保留。`, preview.status === 'completed' ? 'good' : 'info');
      $('#ai14MigrationList').innerHTML = preview.items.map((item) => `<div class="ai14-migration-item"><strong>${escapeHtml(item.key)} ${item.alreadyMigrated ? '· 已迁移' : ''}</strong>${formatBytes(item.bytes)} · ${item.parseable ? 'JSON可解析' : '无法自动解析'} · 预计${item.estimated || 0}条 · ${escapeHtml(JSON.stringify(item.counts || {}))}</div>`).join('');
    } catch (error) { notice('#ai14MigrationSummary', errorMessage(error), 'danger'); }
  }

  async function copyAnswer(messageId) {
    const message = state.messages.find((item) => item.id === messageId);
    if (!message) return;
    try { await navigator.clipboard.writeText(message.content); }
    catch {
      const area = document.createElement('textarea');
      area.value = message.content;
      document.body.appendChild(area);
      area.select();
      document.execCommand('copy');
      area.remove();
    }
    notice('#ai14StatusMessage', '回答已复制。', 'good');
  }

  function bindEvents() {
    $('#ai14ToggleSettings').onclick = () => {
      const body = $('#ai14SettingsPanel .ai14-settings-body');
      const collapsed = body.classList.toggle('ai14-collapsed');
      $('#ai14ToggleSettings').textContent = collapsed ? '展开设置' : '收起设置';
    };
    $('#ai14Provider').onchange = (event) => { state.providerId = event.target.value; renderProvider(); };
    $('#ai14Enabled').onchange = async (event) => { try { await bridge.aiSettings.setEnabled(event.target.checked); notice('#ai14StatusMessage', event.target.checked ? 'AI已启用；仍只会在用户点击发送时调用。' : 'AI已关闭，不会产生网络请求。', 'good'); await loadStatus(); } catch (error) { notice('#ai14StatusMessage', errorMessage(error), 'danger'); } };
    $('#ai14SaveProvider').onclick = saveProvider;
    $('#ai14SaveKey').onclick = saveKey;
    $('#ai14Test').onclick = testConnection;
    $('#ai14DeleteKey').onclick = async () => { if (!window.confirm('确认删除当前服务商的加密API Key吗？')) return; try { await bridge.aiSettings.deleteKey(state.providerId); await loadStatus(); notice('#ai14StatusMessage', 'API Key已删除。', 'good'); } catch (error) { notice('#ai14StatusMessage', errorMessage(error), 'danger'); } };
    $('#ai14SaveLimits').onclick = async () => { try { await bridge.aiSettings.saveLimits({ maxInputTokens: Number($('#ai14LimitInput').value), maxOutputTokens: Number($('#ai14LimitOutput').value), dailyCalls: Number($('#ai14LimitCalls').value), dailyCost: Number($('#ai14LimitDailyCost').value), monthlyCost: Number($('#ai14LimitMonthlyCost').value), costEstimation: $('#ai14CostEstimation').checked }); notice('#ai14StatusMessage', '费用和调用限制已保存。', 'good'); await loadStatus(); } catch (error) { notice('#ai14StatusMessage', errorMessage(error), 'danger'); } };
    $('#ai14NewSession').onclick = async () => { const name = window.prompt('新会话名称', '运营观察 · 新会话'); if (!name) return; try { const session = await bridge.aiChat.createSession({ name, providerId: state.providerId }); state.sessionId = session.id; await loadSessions(); } catch (error) { notice('#ai14StatusMessage', errorMessage(error), 'danger'); } };
    $('#ai14RenameSession').onclick = async () => { const current = state.sessions.find((item) => item.id === state.sessionId); if (!current) return; const name = window.prompt('修改会话名称', current.name); if (!name) return; await bridge.aiChat.renameSession({ sessionId: current.id, name }); await loadSessions(); };
    $('#ai14ClearSession').onclick = async () => { if (!state.sessionId || !window.confirm('确认清空当前会话的全部消息和摘要吗？')) return; await bridge.aiChat.clearSession({ sessionId: state.sessionId, confirmed: true }); await loadSessions(); };
    $('#ai14DeleteSession').onclick = async () => { if (!state.sessionId || !window.confirm('确认删除当前会话吗？此操作只删除本地AI会话，不影响业务历史。')) return; await bridge.aiChat.deleteSession({ sessionId: state.sessionId, confirmed: true }); state.sessionId = ''; await loadSessions(); };
    $('#ai14Summarize').onclick = async () => { if (!state.sessionId || !window.confirm('生成较早对话摘要会发起一次AI请求，确认继续吗？')) return; const requestId = `summary-${crypto.randomUUID()}`; state.activeRequestId = requestId; try { const result = await bridge.aiChat.summarizeSession({ sessionId: state.sessionId, providerId: state.providerId, requestId, confirmed: true }); notice('#ai14StatusMessage', `已生成${result.messageCount}条较早消息的AI摘要。`, 'good'); } catch (error) { notice('#ai14StatusMessage', errorMessage(error), 'danger'); } finally { state.activeRequestId = ''; } };
    $('#ai14SessionList').onclick = async (event) => { const button = event.target.closest('[data-ai14-session]'); if (!button) return; state.sessionId = button.dataset.ai14Session; renderSessions(); await loadMessages(); };
    $('#ai14AddAttachment').onclick = () => $('#ai14AttachmentInput').click();
    $('#ai14AttachmentInput').onchange = async (event) => { await addAttachments(event.target.files); event.target.value = ''; };
    $('#ai14Attachments').onclick = (event) => { const button = event.target.closest('[data-ai14-remove-attachment]'); if (!button) return; state.attachments = state.attachments.filter((item) => item.id !== button.dataset.ai14RemoveAttachment); renderAttachments(); };
    $('#ai14Send').onclick = () => { const input = $('#ai14ChatInput'); sendChat(input.value); };
    $('#ai14ChatInput').onkeydown = (event) => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); $('#ai14Send').click(); } };
    $('#ai14Stop').onclick = async () => { if (state.activeRequestId) await bridge.aiChat.cancelRequest(state.activeRequestId).catch(() => {}); };
    $('#ai14Regenerate').onclick = () => { const last = [...state.messages].reverse().find((message) => message.role === 'user'); if (!last) return; if (/\[附件：/.test(last.content)) return notice('#ai14StatusMessage', '重新生成附件分析前，请重新添加原附件并确认发送；软件不会在数据库中保留附件正文或图片', 'warn'); sendChat(last.content); };
    $('#ai14Messages').onclick = (event) => { const button = event.target.closest('[data-copy-ai14]'); if (button) copyAnswer(button.dataset.copyAi14); };
    $('#ai14Country').onchange = renderContextScopeOptions;
    $$('.ai14-quick-ranges [data-ai14-range]').forEach((button) => button.onclick = () => setQuickRange(button.dataset.ai14Range));
    $$('[data-ai14-template]').forEach((button) => button.onclick = () => setAnalysisTemplate(button.dataset.ai14Template));
    $$('#ai14Modules input').forEach((input) => input.onchange = markCustomTemplate);
    $('#ai14BuildPreview').onclick = buildPreview;
    $('#ai14ConfirmSend').onclick = confirmContextSend;
    $('#ai14SaveMemory').onclick = saveMemory;
    $('#ai14ResetMemory').onclick = resetMemoryEditor;
    $('#ai14UseLastAnswer').onclick = () => { if (!state.lastAssistantText) return notice('#ai14MemoryStatus', '当前没有AI回答可放入待确认区。', 'warn'); resetMemoryEditor(); $('#ai14MemoryTitle').value = '待确认的AI建议'; $('#ai14MemoryContent').value = state.lastAssistantText; $('#ai14MemorySource').value = 'ai_suggestion'; notice('#ai14MemoryStatus', '内容仅放入编辑区，尚未成为长期记忆。请核对、修改并确认保存。', 'warn'); };
    $('#ai14MemoryList').onclick = async (event) => { const edit = event.target.closest('[data-memory-edit]'); const toggle = event.target.closest('[data-memory-toggle]'); const remove = event.target.closest('[data-memory-delete]'); if (edit) editMemory(edit.dataset.memoryEdit); if (toggle) { const item = state.memories.find((memory) => memory.id === toggle.dataset.memoryToggle); await bridge.aiMemory.disable({ id: item.id, enabled: !item.enabled }); await loadMemories(); } if (remove && window.confirm('确认删除这条长期记忆吗？')) { await bridge.aiMemory.remove({ id: remove.dataset.memoryDelete, confirmed: true }); await loadMemories(); } };
    $('#ai14OpenDataFolder').onclick = () => bridge.database.openFolder();
    $('#ai14Integrity').onclick = async () => { notice('#ai14IntegrityStatus', '正在检查数据库完整性…', 'info'); try { const result = await bridge.backup.integrity(); notice('#ai14IntegrityStatus', result.ok ? '数据库完整性检查通过。' : `发现问题：${result.messages.join('；')}`, result.ok ? 'good' : 'danger'); } catch (error) { notice('#ai14IntegrityStatus', errorMessage(error), 'danger'); } };
    $('#ai14BackupNow').onclick = async () => { try { const result = await bridge.backup.create({ reason: 'manual' }); notice('#ai14BackupStatus', `备份成功：${result.fileName}`, 'good'); await Promise.all([loadBackups(), loadDatabaseInfo()]); } catch (error) { notice('#ai14BackupStatus', errorMessage(error), 'danger'); } };
    $('#ai14ImportBackup').onclick = async () => { try { const result = await bridge.backup.import(); if (!result.canceled) notice('#ai14BackupStatus', '备份包已导入到本地备份列表，尚未恢复。', 'good'); await loadBackups(); } catch (error) { notice('#ai14BackupStatus', errorMessage(error), 'danger'); } };
    $('#ai14SaveRetention').onclick = async () => { try { const result = await bridge.backup.setRetention(Number($('#ai14Retention').value)); notice('#ai14BackupStatus', `自动备份保留数量已设为${result.retention}。`, 'good'); } catch (error) { notice('#ai14BackupStatus', errorMessage(error), 'danger'); } };
    $('#ai14CleanupBackups').onclick = async () => { try { const result = await bridge.backup.cleanup({ autoOnly: true }); notice('#ai14BackupStatus', `已清理${result.removed.length}个过旧自动备份。`, 'good'); await loadBackups(); } catch (error) { notice('#ai14BackupStatus', errorMessage(error), 'danger'); } };
    $('#ai14BackupList').onclick = async (event) => { const exportButton = event.target.closest('[data-backup-export]'); const restoreButton = event.target.closest('[data-backup-restore]'); if (exportButton) { try { await bridge.backup.export({ fileName: exportButton.dataset.backupExport }); } catch (error) { notice('#ai14BackupStatus', errorMessage(error), 'danger'); } } if (restoreButton) { const confirmed = window.confirm('恢复会替换当前数据库。系统会先自动备份当前数据库，确认继续吗？'); if (!confirmed) return; try { const result = await bridge.backup.restore({ fileName: restoreButton.dataset.backupRestore, confirmed: true }); notice('#ai14BackupStatus', `恢复成功，恢复前安全备份：${result.safetyBackup.fileName}`, 'good'); await refreshSafetyPage(); } catch (error) { notice('#ai14BackupStatus', errorMessage(error), 'danger'); } } };
    $('#ai14MigrationPreview').onclick = loadMigrationPreview;
    $('#ai14MigrationExecute').onclick = async () => { if (!window.confirm('确认先自动备份，再把可识别旧数据事务迁移到V14历史表吗？旧数据不会删除。')) return; try { const result = await bridge.migration.execute({ confirmed: true }); notice('#ai14MigrationSummary', `迁移完成：${result.report.migratedSources}个来源，跳过重复${result.report.skippedDuplicates}个，警告${result.report.failedSources.length}个。`, result.report.failedSources.length ? 'warn' : 'good'); await refreshSafetyPage(); } catch (error) { notice('#ai14MigrationSummary', errorMessage(error), 'danger'); } };
    $('#ai14MigrationDefer').onclick = async () => { await bridge.migration.defer(); notice('#ai14MigrationSummary', '已选择暂不迁移。旧数据保持原样，可随时回来继续。', 'info'); };
  }

  bridge.aiChat.onEvent((event) => {
    if (!state.activeRequestId || event.requestId !== state.activeRequestId) return;
    if (event.type === 'chunk') { state.streamText += event.content || ''; scheduleStreamRender(); }
    if (event.type === 'error') notice('#ai14StatusMessage', event.error?.message || 'AI请求失败', 'danger');
  });

  try {
    installNavigation();
    installPages();
    bindEvents();
    setQuickRange('30');
    resetMemoryEditor();
    window.__aiObserverV14 = { ready: true, refreshAiPage, refreshSafetyPage, observerOnly: true, enabled: AI_ANALYSIS_TEMPLATE_ENABLED };
  } catch (error) {
    console.error('AI Observer V14 failed:', error);
    window.__aiObserverV14 = { ready: false, error: error.message, observerOnly: true };
  }
})();
