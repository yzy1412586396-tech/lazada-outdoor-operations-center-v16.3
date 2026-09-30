(() => {
  'use strict';

  const STORAGE_KEY = 'lazadaDailyExpensePluginV1';
  const TYPE_LABELS = {
    core: '生意参谋', ads: '全站广告', affiliate: '超级联盟',
    income: 'Income', promo: '推广费用', mabang: '补单表',
  };
  const DEFAULT_TEMPLATE_KEYWORD = '菲律宾日报';
  const DEFAULT_KEYWORDS = { core: '生意参谋', ads: '广告', affiliate: '联盟', income: 'income', promo: '推广费用', mabang: '补单' };
  const DEFAULT_PREFIXES = { trailgo: 'T', taketopmall: 'K', nordcamp: 'N', winoutdoor: 'W' };
  const defaultState = () => ({
    installed: false,
    folderPath: '',
    folderName: '',
    dates: { dailyStart: '', dailyEnd: '', adStart: '', adEnd: '', affiliateStart: '', affiliateEnd: '' },
    manual: { exchangeRate: '', performance: '', ratio: '' },
    templateKeyword: DEFAULT_TEMPLATE_KEYWORD,
    typeKeywords: { ...DEFAULT_KEYWORDS },
    storeKeywords: {},
    lastScan: null,
  });
  let settings = loadSettings();
  let scanCache = null;
  let pipelineRunning = false;

  function loadSettings() {
    try {
      const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null') || {};
      return {
        ...defaultState(), ...saved,
        dates: { ...defaultState().dates, ...(saved.dates || {}) },
        manual: { ...defaultState().manual, ...(saved.manual || {}) },
        templateKeyword: String(saved.templateKeyword || DEFAULT_TEMPLATE_KEYWORD),
        typeKeywords: { ...DEFAULT_KEYWORDS, ...(saved.typeKeywords || {}) },
        storeKeywords: { ...(saved.storeKeywords || {}) },
      };
    } catch { return defaultState(); }
  }
  function saveSettings() { localStorage.setItem(STORAGE_KEY, JSON.stringify(settings)); }
  function esc(value) { return String(value ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch])); }
  function normalize(value) { return String(value || '').toLowerCase().replace(/[\s_\-·.]+/g, ''); }
  function fee360Value(cost) {
    const direct = Number(cost?.fee360);
    if (Number.isFinite(direct)) return direct;
    return (Array.isArray(cost?.custom) ? cost.custom : [])
      .filter((item) => /^(360|360费用)$/.test(normalize(item?.name)))
      .reduce((sum, item) => sum + (Number(item?.final) || 0), 0);
  }
  function yieldToUi() {
    return new Promise((resolve) => {
      const schedule = typeof requestAnimationFrame === 'function' ? requestAnimationFrame : (callback) => setTimeout(callback, 0);
      schedule(() => setTimeout(resolve, 0));
    });
  }
  function inferPrefix(name) { const key = normalize(name); return Object.entries(DEFAULT_PREFIXES).find(([needle]) => key.includes(needle))?.[1] || ''; }
  function waitFor(test, timeout = 15000, interval = 80) {
    return new Promise((resolve, reject) => {
      const started = Date.now();
      const tick = () => {
        try { const value = test(); if (value) return resolve(value); }
        catch (error) { return reject(error); }
        if (Date.now() - started >= timeout) return reject(new Error('等待界面响应超时'));
        setTimeout(tick, interval);
      };
      tick();
    });
  }
  function monthEnd(date) {
    const match = String(date || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!match) return '';
    const year = Number(match[1]), month = Number(match[2]);
    const day = new Date(year, month, 0).getDate();
    return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  }
  function dateLabel(date) {
    const match = String(date || '').match(/^\d{4}-(\d{2})-(\d{2})$/);
    return match ? `${Number(match[1])}.${Number(match[2])}` : '未选择日期';
  }
  function setProgress(percent, title, detail = '') {
    const box = document.getElementById('dailyExpenseProgress');
    if (!box) return;
    box.classList.add('show');
    box.querySelector('i').style.width = `${Math.max(0, Math.min(100, percent))}%`;
    box.querySelector('strong').textContent = title;
    box.querySelector('span').textContent = detail;
  }
  function setResult(message, type = 'good') {
    const box = document.getElementById('dailyExpenseResult');
    if (box) box.innerHTML = `<div class="${type}">${esc(message)}</div>`;
  }

  function ensurePages() {
    const nav = document.getElementById('nav');
    const main = document.querySelector('main.main');
    if (!nav || !main) return;
    nav.querySelector('[data-page="plugin-center"]')?.remove();
    document.getElementById('page-plugin-center')?.remove();
    if (!document.getElementById('page-daily-expense-plugin')) {
      const page = document.createElement('section');
      page.id = 'page-daily-expense-plugin';
      page.className = 'page plugin-page';
      main.appendChild(page);
    }
    ensurePluginToolbar();
    syncPluginNav();
    renderPluginCenter();
  }
  function ensurePluginToolbar() {
    if (document.getElementById('v161PluginsButton')) return;
    const button = document.createElement('button');
    button.id = 'v161PluginsButton'; button.type = 'button'; button.title = '查看可安装插件';
    button.innerHTML = '◇ 插件 <span id="v161PluginsBadge" hidden>0</span>';
    const panel = document.createElement('div');
    panel.id = 'v161PluginsPanel'; panel.setAttribute('aria-hidden', 'true');
    const context = document.createElement('div');
    context.id = 'v161PluginContext'; context.hidden = true;
    context.innerHTML = '<button type="button" data-plugin-context="uninstall">卸载一键日报费用插件</button>';
    document.body.append(button, panel, context);
    const closePanel = () => { panel.classList.remove('show'); panel.setAttribute('aria-hidden', 'true'); context.hidden = true; };
    button.addEventListener('click', (event) => {
      event.stopPropagation();
      document.getElementById('v152DownloadsPanel')?.classList.remove('show');
      const show = !panel.classList.contains('show');
      panel.classList.toggle('show', show); panel.setAttribute('aria-hidden', show ? 'false' : 'true');
      context.hidden = true; if (show) renderPluginCenter();
    });
    panel.addEventListener('contextmenu', (event) => {
      const card = event.target.closest('[data-plugin-market-card]');
      if (!card || !settings.installed) return;
      event.preventDefault(); event.stopPropagation(); context.hidden = false;
      const left = Math.min(event.clientX, window.innerWidth - 230);
      const top = Math.min(event.clientY, window.innerHeight - 52);
      context.style.left = `${Math.max(8, left)}px`; context.style.top = `${Math.max(8, top)}px`;
    });
    context.querySelector('[data-plugin-context="uninstall"]').addEventListener('click', () => {
      uninstallPlugin(); closePanel();
    });
    document.addEventListener('click', (event) => {
      if (event.target.closest('#v152DownloadsButton')) closePanel();
      else if (!panel.contains(event.target) && event.target !== button && !context.contains(event.target)) closePanel();
    }, true);
    document.addEventListener('keydown', (event) => { if (event.key === 'Escape') closePanel(); });
  }
  function updatePluginBadge() {
    const badge = document.getElementById('v161PluginsBadge');
    if (!badge) return;
    badge.textContent = settings.installed ? '1' : '0'; badge.hidden = !settings.installed;
  }
  function installPlugin() {
    settings.installed = true; saveSettings(); syncPluginNav(); renderPluginCenter(); toast('一键日报费用插件已安装并启用', 'ok');
  }
  function uninstallPlugin() {
    settings.installed = false; saveSettings(); syncPluginNav(); renderPluginCenter(); toast('插件已卸载，日报、费用和业务数据未受影响', 'ok');
  }
  function syncPluginNav() {
    const nav = document.getElementById('nav');
    if (!nav) return;
    let button = nav.querySelector('[data-page="daily-expense-plugin"]');
    if (settings.installed && !button) {
      button = document.createElement('button');
      button.dataset.page = 'daily-expense-plugin';
      button.innerHTML = '<span class="ico">▣</span>一键日报费用';
      nav.querySelector('[data-page="dailyreport"]')?.after(button);
      button.onclick = () => go('daily-expense-plugin');
    } else if (!settings.installed && button) button.remove();
    updatePluginBadge();
  }
  function showPluginPage(page) {
    if (page === 'plugin-center') {
      document.getElementById('v161PluginsButton')?.click();
      return;
    }
    document.querySelectorAll('.page').forEach((node) => node.classList.toggle('active', node.id === `page-${page}`));
    document.querySelectorAll('#nav button').forEach((node) => node.classList.toggle('active', node.dataset.page === page));
    const title = document.getElementById('pageTitle');
    const sub = document.getElementById('pageSub');
    if (title) title.textContent = '一键日报费用导出';
    if (sub) sub.textContent = '扫描数据文件夹，生成日报、月度费用表并回填AI–AM列';
    renderAutomationPage();
    void syncDailyStores(false);
    window.scrollTo({ top: 0, behavior: 'auto' });
  }
  function renderPluginCenter() {
    const panel = document.getElementById('v161PluginsPanel');
    if (!panel) return;
    panel.innerHTML = `<div class="plugin-popover-head"><div><strong>插件中心</strong><span>按需安装 · 本机运行</span></div><span class="plugin-count">1 个插件</span></div>
      <div class="plugin-market-card plugin-popover-card" data-plugin-market-card="daily-expense" title="${settings.installed ? '右键可卸载插件' : '点击安装插件'}"><div class="plugin-market-title"><div class="plugin-market-icon">▣</div><div><h3>一键日报费用导出</h3><p>自动匹配数据文件夹，生成日报与月度费用表并回填 AI–AM。</p><small>${settings.installed ? '已安装 · 右键可卸载' : '未安装 · 安装后才显示业务模块'}</small></div></div><div class="plugin-market-actions"><span class="chip ${settings.installed ? 'good' : 'muted'}">${settings.installed ? '已安装' : '未安装'}</span>${settings.installed ? '<button class="btn light" id="openDailyExpensePlugin">打开</button>' : '<button class="btn primary" id="installDailyExpensePlugin">安装</button>'}</div></div>`;
    panel.querySelector('#installDailyExpensePlugin')?.addEventListener('click', installPlugin);
    panel.querySelector('#openDailyExpensePlugin')?.addEventListener('click', () => { panel.classList.remove('show'); panel.setAttribute('aria-hidden', 'true'); go('daily-expense-plugin'); });
    updatePluginBadge();
  }

  function renderAutomationPage() {
    const page = document.getElementById('page-daily-expense-plugin');
    if (!page || !settings.installed) return;
    page.innerHTML = `<div class="plugin-hero"><div><div class="eyebrow">Daily + expense automation</div><h2>一键日报费用导出</h2><p>所有文件只在本机读取。日期留空时自动采用已匹配表格中的全部日期，最后按区间最后一天命名。</p></div><div class="plugin-hero-actions"><button class="btn light" id="pluginSyncStores">同步日报店铺</button><button class="btn primary" id="pluginRun">开始一键处理</button></div></div>
      <div class="plugin-card"><div class="plugin-card-head"><div><div class="eyebrow">Data folder</div><h3>连接当天店铺数据文件夹</h3><p>可以选择已有文件夹，或按名称在桌面创建并连接；兼容 xls、xlsx、xlsm。</p></div></div><div class="plugin-folder-row"><label class="plugin-field"><span>桌面文件夹名称</span><input id="pluginFolderName" value="${esc(settings.folderName)}" placeholder="例如 8.17店铺数据"></label><button class="btn light" id="pluginCreateFolder">在桌面创建/连接</button><button class="btn light" id="pluginChooseFolder">选择文件夹</button><button class="btn primary" id="pluginScanFolder">扫描表格</button></div><div class="plugin-folder-path">${settings.folderPath ? esc(settings.folderPath) : '尚未连接数据文件夹'}</div></div>
      <div class="plugin-card"><details class="plugin-fold" open><summary>日期与月度费用手填参数（可收起）</summary><div class="plugin-fold-body"><div class="plugin-grid"><label class="plugin-field"><span>日报开始日期（可留空）</span><input type="date" data-plugin-date="dailyStart" value="${esc(settings.dates.dailyStart)}"></label><label class="plugin-field"><span>日报结束日期（可留空）</span><input type="date" data-plugin-date="dailyEnd" value="${esc(settings.dates.dailyEnd)}"></label><label class="plugin-field"><span>1元人民币兑换当前币种</span><input inputmode="decimal" data-plugin-manual="exchangeRate" value="${esc(settings.manual.exchangeRate)}" placeholder="例如 9.08"></label><label class="plugin-field"><span>本月业绩</span><input inputmode="decimal" data-plugin-manual="performance" value="${esc(settings.manual.performance)}"></label><label class="plugin-field"><span>本月可用费用比例</span><input inputmode="decimal" data-plugin-manual="ratio" value="${esc(settings.manual.ratio)}" placeholder="例如 0.078"></label></div><div style="height:13px"></div><div class="plugin-grid"><label class="plugin-field"><span>广告费用开始（可留空）</span><input type="date" data-plugin-date="adStart" value="${esc(settings.dates.adStart)}"></label><label class="plugin-field"><span>广告费用结束（可留空）</span><input type="date" data-plugin-date="adEnd" value="${esc(settings.dates.adEnd)}"></label><label class="plugin-field"><span>联盟费用开始（可留空）</span><input type="date" data-plugin-date="affiliateStart" value="${esc(settings.dates.affiliateStart)}"></label><label class="plugin-field"><span>联盟费用结束（可留空）</span><input type="date" data-plugin-date="affiliateEnd" value="${esc(settings.dates.affiliateEnd)}"></label></div></div></details></div>
      <div class="plugin-card"><details class="plugin-fold" open><summary>文件名关键词规则（可修改并自动保存）</summary><div class="plugin-fold-body"><div class="plugin-grid"><label class="plugin-field"><span>日报模板关键词</span><input data-plugin-template-key value="${esc(settings.templateKeyword)}" placeholder="例如 菲律宾日报"></label>${Object.entries(TYPE_LABELS).map(([key, label]) => `<label class="plugin-field"><span>${esc(label)}关键词</span><input data-plugin-type-key="${key}" value="${esc(settings.typeKeywords[key])}"></label>`).join('')}</div><div style="height:13px"></div><div style="overflow-x:auto"><table class="plugin-mapping"><thead><tr><th>日报店铺</th><th>店铺文件前缀/关键词</th><th>规则示例</th></tr></thead><tbody id="pluginStoreRules"><tr><td colspan="3">正在读取日报模块店铺…</td></tr></tbody></table></div></div></details></div>
      <div class="plugin-card"><div class="plugin-card-head"><div><div class="eyebrow">File matching</div><h3>文件匹配预览</h3><p>先匹配最新日报模板，再按店铺匹配日报三表、Income、推广费用和可选补单表；未上传补单表默认0。</p></div></div><div id="pluginFileSummary" class="plugin-file-summary"><div class="plugin-result"><div class="warn">请先连接并扫描数据文件夹。</div></div></div><div class="plugin-progress" id="dailyExpenseProgress"><strong>等待开始</strong><div class="plugin-progress-bar"><i></i></div><span></span></div><div class="plugin-result" id="dailyExpenseResult"></div></div>`;
    bindAutomationPage();
    if (scanCache) renderScanSummary(scanCache);
  }
  function bindAutomationPage() {
    document.querySelectorAll('[data-plugin-date]').forEach((input) => input.addEventListener('change', () => { settings.dates[input.dataset.pluginDate] = input.value; saveSettings(); }));
    document.querySelectorAll('[data-plugin-manual]').forEach((input) => input.addEventListener('change', () => { settings.manual[input.dataset.pluginManual] = input.value.trim(); saveSettings(); }));
    document.querySelector('[data-plugin-template-key]')?.addEventListener('change', (event) => { settings.templateKeyword = event.target.value.trim() || DEFAULT_TEMPLATE_KEYWORD; saveSettings(); if (scanCache) renderScanSummary(scanCache); });
    document.querySelectorAll('[data-plugin-type-key]').forEach((input) => input.addEventListener('change', () => { settings.typeKeywords[input.dataset.pluginTypeKey] = input.value.trim(); saveSettings(); if (scanCache) renderScanSummary(scanCache); }));
    document.getElementById('pluginFolderName')?.addEventListener('change', (event) => { settings.folderName = event.target.value.trim(); saveSettings(); });
    document.getElementById('pluginCreateFolder')?.addEventListener('click', connectDesktopFolder);
    document.getElementById('pluginChooseFolder')?.addEventListener('click', chooseFolder);
    document.getElementById('pluginScanFolder')?.addEventListener('click', scanFolder);
    document.getElementById('pluginSyncStores')?.addEventListener('click', () => syncDailyStores(true));
    document.getElementById('pluginRun')?.addEventListener('click', runPipeline);
  }

  async function dailyDocument() {
    window.loadDailyReportModule?.();
    const frame = document.getElementById('dailyReportFrame');
    if (!frame) throw new Error('日报模块不存在');
    return waitFor(() => frame.contentDocument?.getElementById('shopGrid') && frame.contentDocument, 20000);
  }
  function storeNamesFromDaily(doc) {
    return [...doc.querySelectorAll('.shop-card .shop-name')].map((node) => node.textContent.trim()).filter(Boolean);
  }
  async function syncDailyStores(showToast) {
    try {
      const doc = await dailyDocument();
      const names = storeNamesFromDaily(doc);
      names.forEach((name) => { if (!(name in settings.storeKeywords)) settings.storeKeywords[name] = inferPrefix(name); });
      Object.keys(settings.storeKeywords).forEach((name) => { if (!names.includes(name)) delete settings.storeKeywords[name]; });
      saveSettings();
      const tbody = document.getElementById('pluginStoreRules');
      if (tbody) {
        tbody.innerHTML = names.map((name) => `<tr><td>${esc(name)}</td><td><input data-plugin-store-key="${esc(name)}" value="${esc(settings.storeKeywords[name] || '')}" placeholder="例如 T"></td><td>${esc(settings.storeKeywords[name] || '?')}广告.xlsx / ${esc(settings.storeKeywords[name] || '?')}income.xlsx</td></tr>`).join('');
        tbody.querySelectorAll('[data-plugin-store-key]').forEach((input) => input.addEventListener('change', () => { settings.storeKeywords[input.dataset.pluginStoreKey] = input.value.trim(); saveSettings(); if (scanCache) renderScanSummary(scanCache); }));
      }
      if (showToast) toast(`已同步 ${names.length} 个日报店铺`, 'ok');
      return names;
    } catch (error) {
      const tbody = document.getElementById('pluginStoreRules');
      if (tbody) tbody.innerHTML = `<tr><td colspan="3">${esc(error.message)}</td></tr>`;
      if (showToast) toast(error.message, 'err');
      return [];
    }
  }
  async function connectDesktopFolder() {
    try {
      const name = document.getElementById('pluginFolderName')?.value.trim();
      const result = await window.desktopApp.automationFolders.connectDesktop({ folderName: name });
      settings.folderName = result.name; settings.folderPath = result.folderPath; saveSettings(); renderAutomationPage(); await syncDailyStores(false); await scanFolder();
    } catch (error) { setResult(error.message, 'danger'); }
  }
  async function chooseFolder() {
    try {
      const result = await window.desktopApp.automationFolders.choose();
      if (result.canceled) return;
      settings.folderName = result.name; settings.folderPath = result.folderPath; saveSettings(); renderAutomationPage(); await syncDailyStores(false); await scanFolder();
    } catch (error) { setResult(error.message, 'danger'); }
  }
  async function reconnectFolder() {
    if (!settings.folderPath) return false;
    try { await window.desktopApp.automationFolders.reconnect({ folderPath: settings.folderPath }); return true; }
    catch { return false; }
  }
  async function scanFolder() {
    try {
      if (!settings.folderPath) throw new Error('请先选择或创建店铺数据文件夹');
      if (!(await reconnectFolder())) throw new Error('已保存的数据文件夹不存在，请重新连接');
      scanCache = await window.desktopApp.automationFolders.scan({ folderPath: settings.folderPath });
      settings.lastScan = new Date().toISOString(); saveSettings(); renderScanSummary(scanCache); setResult(`已扫描 ${scanCache.files.length} 个表格文件`, 'good');
      return scanCache;
    } catch (error) { scanCache = null; setResult(error.message, 'danger'); throw error; }
  }
  function matchingFiles(storeName, type, scan = scanCache) {
    if (!scan) return [];
    const storeKey = normalize(settings.storeKeywords[storeName] || '');
    const typeKey = normalize(settings.typeKeywords[type] || '');
    if (!storeKey || !typeKey) return [];
    return scan.files.filter((file) => {
      const name = normalize(file.name.replace(/\.(xlsx?|xlsm)$/i, ''));
      const storeMatches = storeKey.length <= 2 ? name.startsWith(storeKey) : name.includes(storeKey);
      return storeMatches && name.includes(typeKey);
    }).sort((a, b) => String(b.modifiedAt).localeCompare(String(a.modifiedAt)));
  }
  function selectedFile(storeName, type) { return matchingFiles(storeName, type)[0] || null; }
  function matchingTemplateFiles(scan = scanCache) {
    if (!scan) return [];
    const keyword = normalize(settings.templateKeyword || DEFAULT_TEMPLATE_KEYWORD);
    if (!keyword) return [];
    return scan.files.filter((file) => {
      if (!/\.xlsx$/i.test(file.name)) return false;
      const name = normalize(file.name.replace(/\.xlsx$/i, ''));
      return name.includes(keyword) && !/(日报费用|月度费用)/.test(name);
    }).sort((a, b) => String(b.modifiedAt).localeCompare(String(a.modifiedAt)));
  }
  function selectedTemplateFile(scan = scanCache) { return matchingTemplateFiles(scan)[0] || null; }
  function renderScanSummary(scan) {
    const box = document.getElementById('pluginFileSummary');
    if (!box) return;
    const stores = Object.keys(settings.storeKeywords);
    if (!stores.length) { box.innerHTML = '<div class="plugin-result"><div class="warn">请先同步日报店铺。</div></div>'; return; }
    const templates = matchingTemplateFiles(scan), template = templates[0];
    const templateRow = `<div class="plugin-template-row ${template ? 'ok' : 'missing'}"><strong>日报模板</strong><span title="${esc(template?.name || '未匹配')}">${template ? esc(template.name) + (templates.length > 1 ? ` · 取最新(${templates.length})` : '') : `未匹配“${esc(settings.templateKeyword || DEFAULT_TEMPLATE_KEYWORD)}”`}</span><small>${template ? '运行前会自动验证历史日期并设为本次模板' : '必须把含历史日报的 .xlsx 模板放进当前文件夹'}</small></div>`;
    box.innerHTML = templateRow + stores.map((store) => `<div class="plugin-file-row"><div>${esc(store)}</div>${Object.keys(TYPE_LABELS).map((type) => { const files = matchingFiles(store, type, scan), chosen = files[0]; return `<div class="${chosen ? 'ok' : 'missing'}" title="${esc(chosen?.name || '未匹配')}">${chosen ? esc(chosen.name) + (files.length > 1 ? ` · 取最新(${files.length})` : '') : (type === 'mabang' ? '未上传 · 按0' : '未匹配')}</div>`; }).join('')}</div>`).join('');
  }

  async function readAsFile(meta, targetWindow = window) {
    const result = await window.desktopApp.automationFolders.read({ filePath: meta.filePath });
    const bytes = result.bytes instanceof Uint8Array ? result.bytes : new Uint8Array(result.bytes?.data || result.bytes || []);
    return new targetWindow.File([bytes], result.name, { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', lastModified: Date.now() });
  }
  function normalizeDate(value) {
    if (value instanceof Date && !Number.isNaN(value.getTime())) return [value.getFullYear(), String(value.getMonth() + 1).padStart(2, '0'), String(value.getDate()).padStart(2, '0')].join('-');
    if (typeof value === 'number' && Number.isFinite(value) && window.XLSX?.SSF) {
      const d = XLSX.SSF.parse_date_code(value); if (d) return `${d.y}-${String(d.m).padStart(2, '0')}-${String(d.d).padStart(2, '0')}`;
    }
    const text = String(value || '').trim().replace(/^'+/, '');
    if (/^\d{8}$/.test(text)) return `${text.slice(0, 4)}-${text.slice(4, 6)}-${text.slice(6, 8)}`;
    const match = text.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/);
    return match ? `${match[1]}-${String(match[2]).padStart(2, '0')}-${String(match[3]).padStart(2, '0')}` : '';
  }
  function addDays(date, days) {
    const parsed = new Date(`${date}T00:00:00Z`);
    if (Number.isNaN(parsed.getTime())) return '';
    parsed.setUTCDate(parsed.getUTCDate() + days);
    return parsed.toISOString().slice(0, 10);
  }
  function continuityGap(templateEnd, requestedStart) {
    if (!templateEnd || !requestedStart) return null;
    const expected = addDays(templateEnd, 1);
    if (!expected || requestedStart <= expected) return null;
    return { from: expected, to: addDays(requestedStart, -1) };
  }
  async function inspectDailyTemplate(meta) {
    if (!meta) throw new Error('当前文件夹没有匹配到日报模板');
    const result = await window.desktopApp.automationFolders.read({ filePath: meta.filePath });
    const bytes = result.bytes instanceof Uint8Array ? result.bytes : new Uint8Array(result.bytes?.data || result.bytes || []);
    // Keep Excel dates as serial numbers and decode through SSF. Date objects
    // can shift one day when Electron and Windows use different time zones.
    const workbook = XLSX.read(bytes, { type: 'array', cellDates: false });
    const sheet = workbook.Sheets['日报结果页'] || workbook.Sheets['Daily Report'];
    if (!sheet) throw new Error(`日报模板“${meta.name}”缺少“日报结果页”工作表`);
    const dates = new Set();
    XLSX.utils.sheet_to_json(sheet, { header: 1, raw: true, defval: null, blankrows: false }).forEach((row) => {
      row.slice(0, 5).forEach((value) => { const date = normalizeDate(value); if (date) dates.add(date); });
    });
    const ordered = [...dates].sort();
    if (!ordered.length) throw new Error(`日报模板“${meta.name}”没有识别到任何历史日期`);
    return { name: meta.name, firstDate: ordered[0], lastDate: ordered[ordered.length - 1] };
  }
  async function setDailyTemplate(doc, meta) {
    const input = doc.getElementById('templateFile');
    if (!input) throw new Error('日报模块缺少模板上传位置');
    const alert = doc.getElementById('alert');
    if (alert) { alert.className = 'alert'; alert.textContent = ''; }
    const transfer = new doc.defaultView.DataTransfer();
    transfer.items.add(await readAsFile(meta, doc.defaultView));
    input.files = transfer.files;
    input.dispatchEvent(new doc.defaultView.Event('change', { bubbles: true }));
    await waitFor(() => {
      const currentAlert = doc.getElementById('alert');
      const message = currentAlert?.textContent || '';
      if (currentAlert?.classList.contains('error')) throw new Error(`日报模板验证失败：${message}`);
      return message.includes('日报模板已验证') && currentAlert;
    }, 60000);
  }
  async function inferDateRange(stores) {
    const found = new Set();
    const seen = new Set();
    for (const store of stores) for (const type of ['core', 'ads', 'affiliate']) {
      const meta = selectedFile(store, type); if (!meta || seen.has(meta.filePath)) continue; seen.add(meta.filePath);
      const result = await window.desktopApp.automationFolders.read({ filePath: meta.filePath });
      const bytes = result.bytes instanceof Uint8Array ? result.bytes : new Uint8Array(result.bytes?.data || result.bytes || []);
      const workbook = XLSX.read(bytes, { type: 'array', cellDates: false });
      workbook.SheetNames.forEach((sheetName) => XLSX.utils.sheet_to_json(workbook.Sheets[sheetName], { header: 1, raw: true, defval: null, blankrows: false }).forEach((row) => { const date = normalizeDate(row[0]); if (date) found.add(date); }));
    }
    const dates = [...found].sort();
    if (!dates.length) throw new Error('日期留空，但已匹配表格中没有识别到日期');
    return [dates[0], dates[dates.length - 1]];
  }
  async function setDailyInput(doc, storeName, type, meta) {
    const card = [...doc.querySelectorAll('.shop-card')].find((item) => normalize(item.querySelector('.shop-name')?.textContent) === normalize(storeName));
    if (!card) throw new Error(`日报模块中找不到店铺：${storeName}`);
    const input = card.querySelector(`input[data-action="file"][data-type="${type}"]`);
    if (!input) throw new Error(`${storeName} 缺少 ${TYPE_LABELS[type]} 上传位置`);
    const transfer = new doc.defaultView.DataTransfer();
    if (meta) transfer.items.add(await readAsFile(meta, doc.defaultView));
    input.files = transfer.files;
    input.dispatchEvent(new doc.defaultView.Event('change', { bubbles: true }));
    const statusId = `status-${input.dataset.shopId}-${type}`;
    const status = await waitFor(() => { const node = doc.getElementById(statusId); return node && !node.textContent.includes('正在读取') && !node.textContent.includes('日期范围已变化') && node; }, 30000);
    if (status.textContent.trim().startsWith('✕')) throw new Error(`${storeName} ${TYPE_LABELS[type]}：${status.textContent}`);
  }
  async function captureDailyWorkbook(doc) {
    const win = doc.defaultView;
    const proto = win.HTMLAnchorElement.prototype;
    const originalClick = proto.click;
    let timer;
    return new Promise((resolve, reject) => {
      const restore = () => { proto.click = originalClick; clearTimeout(timer); };
      proto.click = function pluginCaptureClick() {
        const name = String(this.download || '');
        const href = String(this.href || '');
        if (/\.xlsx$/i.test(name) && href.startsWith('blob:')) {
          win.fetch(href).then((response) => response.arrayBuffer()).then((buffer) => { restore(); resolve({ name, bytes: new Uint8Array(buffer) }); }).catch((error) => { restore(); reject(error); });
          return;
        }
        return originalClick.call(this);
      };
      timer = setTimeout(() => { restore(); reject(new Error('日报生成超时，请确认日报模板已经保存')); }, 120000);
      doc.getElementById('generateBtn')?.click();
    });
  }

  async function prepareDaily(stores, start, end) {
    const templateMeta = selectedTemplateFile();
    if (!templateMeta) throw new Error(`当前文件夹未匹配到日报模板，请放入文件名包含“${settings.templateKeyword || DEFAULT_TEMPLATE_KEYWORD}”的 .xlsx 文件`);
    const coverage = await inspectDailyTemplate(templateMeta);
    const gap = continuityGap(coverage.lastDate, start);
    if (gap) throw new Error(`日报模板“${coverage.name}”最后日期是 ${coverage.lastDate}，本次从 ${start} 开始，中间缺少 ${gap.from} 至 ${gap.to}。已停止生成，避免漏掉历史日报。`);
    const doc = await dailyDocument();
    setProgress(11, '正在验证日报模板', `${coverage.name} · 历史数据至 ${coverage.lastDate}`);
    await setDailyTemplate(doc, templateMeta);
    const startInput = doc.getElementById('startDate'), endInput = doc.getElementById('endDate');
    startInput.value = start; endInput.value = end;
    startInput.dispatchEvent(new doc.defaultView.Event('change', { bubbles: true }));
    await waitFor(() => endInput.value === end, 5000);
    endInput.dispatchEvent(new doc.defaultView.Event('change', { bubbles: true }));
    let completed = 0;
    for (const store of stores) for (const type of ['core', 'ads', 'affiliate']) {
      const meta = selectedFile(store, type);
      await setDailyInput(doc, store, type, meta);
      completed += 1;
      setProgress(12 + Math.round(completed / Math.max(1, stores.length * 3) * 28), '正在导入日报来源', `${store} · ${TYPE_LABELS[type]}${meta ? '' : '（缺失按0）'}`);
    }
    const capture = await captureDailyWorkbook(doc);
    return { doc, ...capture };
  }
  async function prepareExpense(stores, endDate) {
    const bridge = window.__expenseV13;
    if (!bridge?.ready) throw new Error('月度费用模块尚未准备完成');
    const manual = settings.manual;
    for (const [key, label] of [['exchangeRate', '汇率'], ['performance', '本月业绩'], ['ratio', '本月可用费用比例']]) if (!String(manual[key] || '').trim() || !Number.isFinite(Number(manual[key]))) throw new Error(`请填写有效的${label}`);
    const billingMonth = endDate.slice(0, 7);
    bridge.beginBatch?.();
    try {
      bridge.setGlobalFields({
        exchangeRate: manual.exchangeRate, performance: manual.performance, ratio: manual.ratio,
        billingMonth, billingEnd: monthEnd(endDate),
        adDateEnabled: Boolean(settings.dates.adStart || settings.dates.adEnd), adStart: settings.dates.adStart, adEnd: settings.dates.adEnd,
        affiliateDateEnabled: Boolean(settings.dates.affiliateStart || settings.dates.affiliateEnd), affiliateStart: settings.dates.affiliateStart, affiliateEnd: settings.dates.affiliateEnd,
      });
      const expenseStores = bridge.getStores();
      let completed = 0;
      for (const expenseStore of expenseStores) {
        const dailyName = stores.find((name) => normalize(name) === normalize(expenseStore.name));
        if (!dailyName) continue;
        for (const [type, fileType] of [['income', 'income'], ['promo', 'promo'], ['mabang', 'mabang']]) {
          const meta = selectedFile(dailyName, fileType);
          bridge.clearUploadSilent(expenseStore.id, type);
          if (meta) {
            await bridge.restoreUpload(expenseStore.id, type, await readAsFile(meta));
            if (!bridge.hasUpload(expenseStore.id, type)) throw new Error(`${expenseStore.name} ${TYPE_LABELS[fileType]}读取失败，请检查文件格式`);
          }
          completed += 1;
          setProgress(50 + Math.round(completed / Math.max(1, expenseStores.length * 3) * 22), '正在计算月度费用', `${expenseStore.name} · ${TYPE_LABELS[fileType]}${meta ? '' : '（缺失按0）'}`);
          await yieldToUi();
        }
      }
      const calculation = bridge.calculateForPlugin();
      const bytes = new Uint8Array(bridge.buildWorkbookForPlugin());
      return { calculation, bytes };
    } finally {
      bridge.endBatch?.();
    }
  }

  function parseXml(text) {
    const doc = new DOMParser().parseFromString(text, 'application/xml');
    const error = doc.getElementsByTagName('parsererror')[0];
    if (error) throw new Error(`Excel XML解析失败：${error.textContent.slice(0, 100)}`);
    return doc;
  }
  function serializeXml(doc) { let text = new XMLSerializer().serializeToString(doc); if (!text.startsWith('<?xml')) text = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' + text; return text; }
  function byLocal(node, name) { return [...node.getElementsByTagNameNS('*', name)]; }
  function directChild(node, name) { return [...node.childNodes].find((child) => child.nodeType === 1 && child.localName === name) || null; }
  function colIndex(ref) { let total = 0; for (const ch of String(ref).match(/^[A-Z]+/)?.[0] || '') total = total * 26 + ch.charCodeAt(0) - 64; return total - 1; }
  function cellValue(cell, shared) {
    const type = cell.getAttribute('t');
    if (type === 'inlineStr') return byLocal(cell, 't').map((node) => node.textContent || '').join('');
    const value = directChild(cell, 'v')?.textContent || '';
    return type === 's' ? (shared[Number(value)] || '') : value;
  }
  function normalizeZipPath(base, target) {
    if (target.startsWith('/')) return target.slice(1);
    const parts = `${base}/${target}`.split('/'), output = [];
    parts.forEach((part) => { if (!part || part === '.') return; if (part === '..') output.pop(); else output.push(part); });
    return output.join('/');
  }
  async function workbookPaths(zip) {
    const workbookDoc = parseXml(await zip.file('xl/workbook.xml').async('string'));
    const relDoc = parseXml(await zip.file('xl/_rels/workbook.xml.rels').async('string'));
    const rels = {}; byLocal(relDoc, 'Relationship').forEach((rel) => { rels[rel.getAttribute('Id')] = rel.getAttribute('Target'); });
    const map = {}; byLocal(workbookDoc, 'sheet').forEach((sheet) => { const id = sheet.getAttributeNS('http://schemas.openxmlformats.org/officeDocument/2006/relationships', 'id') || sheet.getAttribute('r:id'); map[sheet.getAttribute('name')] = normalizeZipPath('xl', rels[id]); });
    return { map, workbookDoc };
  }
  async function sharedStrings(zip) {
    const file = zip.file('xl/sharedStrings.xml'); if (!file) return [];
    const doc = parseXml(await file.async('string'));
    return byLocal(doc, 'si').map((item) => byLocal(item, 't').map((node) => node.textContent || '').join(''));
  }
  function setNumericCell(doc, row, reference, number) {
    let cell = [...row.children].find((node) => node.localName === 'c' && node.getAttribute('r') === reference);
    if (!cell) {
      cell = doc.createElementNS('http://schemas.openxmlformats.org/spreadsheetml/2006/main', 'c'); cell.setAttribute('r', reference);
      const target = colIndex(reference), before = [...row.children].find((node) => node.localName === 'c' && colIndex(node.getAttribute('r')) > target);
      if (before) row.insertBefore(cell, before); else row.appendChild(cell);
    }
    while (cell.firstChild) cell.removeChild(cell.firstChild);
    cell.removeAttribute('t');
    const value = doc.createElementNS('http://schemas.openxmlformats.org/spreadsheetml/2006/main', 'v'); value.textContent = String(Number(number) || 0); cell.appendChild(value);
  }
  function excelSerial(date) { const [year, month, day] = date.split('-').map(Number); return Math.round((Date.UTC(year, month - 1, day) - Date.UTC(1899, 11, 30)) / 86400000); }
  async function patchDailyCosts(bytes, endDate, expenseCalculation, zipLib, zipRealm = window) {
    const ZipUint8Array = zipRealm?.Uint8Array || Uint8Array;
    const zipInput = bytes instanceof ZipUint8Array ? bytes : ZipUint8Array.from(bytes);
    const zip = await zipLib.loadAsync(zipInput);
    const { map, workbookDoc } = await workbookPaths(zip);
    const sheetPath = map['日报结果页'] || map['Daily Report'] || Object.values(map).find((value) => /worksheets\/sheet/i.test(value));
    if (!sheetPath) throw new Error('日报半成品中找不到日报结果页');
    const shared = await sharedStrings(zip), doc = parseXml(await zip.file(sheetPath).async('string'));
    const targetSerial = excelSerial(endDate), costs = new Map(expenseCalculation.stores.map((store) => [normalize(store.name), store]));
    let patched = 0; const missingStores = new Set();
    byLocal(doc, 'row').forEach((row) => {
      const values = {}; [...row.children].filter((node) => node.localName === 'c').forEach((cell) => { values[colIndex(cell.getAttribute('r'))] = cellValue(cell, shared); });
      let storeIndex = 4;
      if (Math.trunc(Number(values[2])) !== targetSerial) {
        if (Math.trunc(Number(values[1])) !== targetSerial) return;
        storeIndex = 3;
      }
      const storeName = String(values[storeIndex] || '').trim(); if (!storeName) return;
      const cost = costs.get(normalize(storeName));
      if (!cost) { missingStores.add(storeName); return; }
      const rowNumber = row.getAttribute('r');
      setNumericCell(doc, row, `AI${rowNumber}`, Math.abs(Number(cost.ad) || 0));
      setNumericCell(doc, row, `AJ${rowNumber}`, Math.abs(Number(cost.replenishment) || 0));
      setNumericCell(doc, row, `AK${rowNumber}`, Math.abs(Number(cost.affiliate) || 0));
      setNumericCell(doc, row, `AL${rowNumber}`, Math.abs(Number(cost.strategy) || 0));
      setNumericCell(doc, row, `AM${rowNumber}`, Math.abs(fee360Value(cost)));
      patched += 1;
    });
    if (!patched) throw new Error(`日报中没有找到 ${endDate} 的店铺行，未写入任何费用`);
    zip.file(sheetPath, serializeXml(doc));
    let calc = byLocal(workbookDoc, 'calcPr')[0];
    if (!calc) { calc = workbookDoc.createElementNS('http://schemas.openxmlformats.org/spreadsheetml/2006/main', 'calcPr'); workbookDoc.documentElement.appendChild(calc); }
    calc.setAttribute('calcMode', 'auto'); calc.setAttribute('fullCalcOnLoad', '1'); calc.setAttribute('forceFullCalc', '1'); calc.setAttribute('calcId', '0');
    zip.file('xl/workbook.xml', serializeXml(workbookDoc));
    const output = await zip.generateAsync({ type: 'uint8array', compression: 'STORE' });
    return { bytes: output, patched, missingStores: [...missingStores] };
  }

  async function runPipeline() {
    if (pipelineRunning) return;
    pipelineRunning = true;
    const button = document.getElementById('pluginRun'); if (button) { button.disabled = true; button.textContent = '正在处理…'; }
    try {
      setResult('正在准备一键处理，请不要关闭软件。', 'warn');
      setProgress(3, '准备数据文件夹', settings.folderPath || '尚未连接');
      const scan = scanCache || await scanFolder();
      const stores = await syncDailyStores(false);
      if (!stores.length) throw new Error('日报模块中没有可处理的店铺');
      const missingPrefixes = stores.filter((name) => !String(settings.storeKeywords[name] || '').trim());
      if (missingPrefixes.length) throw new Error(`请先填写店铺文件关键词：${missingPrefixes.join('、')}`);
      let start = settings.dates.dailyStart, end = settings.dates.dailyEnd;
      if (!start && !end) [start, end] = await inferDateRange(stores);
      else { start = start || end; end = end || start; }
      if (start > end) throw new Error('日报开始日期不能晚于结束日期');
      setProgress(10, '生成日报半成品', `${start} 至 ${end}`);
      const daily = await prepareDaily(stores, start, end);
      setProgress(46, '日报半成品已生成', daily.name);
      const expense = await prepareExpense(stores, end);
      setProgress(76, '月度费用已计算', '正在写出月度费用表');
      const label = dateLabel(end);
      const monthlySaved = await window.desktopApp.automationFolders.save({ folderPath: scan.folderPath, fileName: `${label}月度费用表.xlsx`, bytes: expense.bytes });
      setProgress(84, '月度费用表已保存', monthlySaved.fileName);
      const final = await patchDailyCosts(daily.bytes, end, expense.calculation, daily.doc.defaultView.JSZip, daily.doc.defaultView);
      if (final.missingStores.length) throw new Error(`费用模块缺少这些日报店铺，已停止最终导出：${final.missingStores.join('、')}`);
      const finalBytes = final.bytes instanceof Uint8Array ? final.bytes : Uint8Array.from(final.bytes);
      const finalSaved = await window.desktopApp.automationFolders.save({ folderPath: scan.folderPath, fileName: `${label}日报费用.xlsx`, bytes: finalBytes });
      setProgress(100, '全部完成', `${finalSaved.fileName} · 已回填 ${final.patched} 个店铺行`);
      setResult(`已生成 ${monthlySaved.fileName} 和 ${finalSaved.fileName}。AI=广告费用，AJ=补单费用，AK=联盟费用，AL=战略卖家计划参与费，AM=各店铺360费用；费用已转为绝对值并按数字写入。`, 'good');
    } catch (error) {
      console.error('[daily-expense-plugin]', error);
      setProgress(100, '处理已停止', error.message || String(error));
      setResult(error.message || String(error), 'danger');
    } finally {
      pipelineRunning = false;
      if (button) { button.disabled = false; button.textContent = '开始一键处理'; }
    }
  }

  function install() {
    ensurePages();
    const previousGo = go;
    go = function pluginAwareGo(page) {
      if (page === 'plugin-center' || page === 'daily-expense-plugin') {
        if (page === 'daily-expense-plugin' && !settings.installed) return showPluginPage('plugin-center');
        return showPluginPage(page);
      }
      return previousGo(page);
    };
    window.__dailyExpensePluginV1 = Object.freeze({ ready: true, installed: () => settings.installed, matchFiles: matchingFiles, matchTemplates: matchingTemplateFiles, inspectTemplate: inspectDailyTemplate, normalizeDate, continuityGap, patchDailyCosts });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', install); else install();
})();
