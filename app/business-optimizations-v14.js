(() => {
  'use strict';

  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
  const esc = (value) => String(value ?? '').replace(/[&<>'"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[char]);
  const FUZZY_KEY = 'lazadaFuzzySearchV14';
  let fuzzyConfig = {};
  try { fuzzyConfig = JSON.parse(localStorage.getItem(FUZZY_KEY) || '{}'); } catch { fuzzyConfig = {}; }

  function normalized(value) {
    return String(value ?? '').toLowerCase().normalize('NFKC').replace(/[\s\-_/.,，。:：;；()（）\[\]【】]+/g, '');
  }

  function isSubsequence(text, query) {
    let index = 0;
    for (const char of text) if (char === query[index]) index += 1;
    return index === query.length;
  }

  function editDistanceWithin(left, right, maximum) {
    if (Math.abs(left.length - right.length) > maximum) return false;
    let previous = Array.from({ length: right.length + 1 }, (_, index) => index);
    for (let i = 1; i <= left.length; i += 1) {
      const current = [i];
      let rowMinimum = current[0];
      for (let j = 1; j <= right.length; j += 1) {
        current[j] = Math.min(current[j - 1] + 1, previous[j] + 1, previous[j - 1] + (left[i - 1] === right[j - 1] ? 0 : 1));
        rowMinimum = Math.min(rowMinimum, current[j]);
      }
      if (rowMinimum > maximum) return false;
      previous = current;
    }
    return previous[right.length] <= maximum;
  }

  function fuzzyMatch(textValue, queryValue) {
    const text = normalized(textValue);
    const query = normalized(queryValue);
    if (!query || text.includes(query)) return true;
    if (query.length >= 2 && isSubsequence(text, query)) return true;
    if (query.length < 3 || query.length > 32) return false;
    const distance = query.length >= 8 ? 2 : 1;
    const tokens = String(textValue ?? '').toLowerCase().split(/[\s,，;；/|]+/).map(normalized).filter(Boolean);
    return tokens.some((token) => editDistanceWithin(token, query, distance));
  }

  function fuzzyEnabled(inputId) { return Boolean(fuzzyConfig[inputId]); }

  function matches(textValue, queryValue, inputId) {
    if (!String(queryValue || '').trim()) return true;
    return fuzzyEnabled(inputId) ? fuzzyMatch(textValue, queryValue) : String(textValue ?? '').toLowerCase().includes(String(queryValue).toLowerCase());
  }

  function installFuzzyToggle(input) {
    if (!input?.id || input.dataset.fuzzyV14Installed) return;
    input.dataset.fuzzyV14Installed = '1';
    const label = document.createElement('label');
    label.className = 'fuzzy-v14-toggle';
    label.title = '开启后支持字符跳跃匹配和少量拼写误差；关闭时保持原来的包含搜索。';
    label.innerHTML = `<input type="checkbox" ${fuzzyEnabled(input.id) ? 'checked' : ''}><span>模糊搜索</span>`;
    input.insertAdjacentElement('afterend', label);
    $('input', label).onchange = (event) => {
      fuzzyConfig[input.id] = event.target.checked;
      localStorage.setItem(FUZZY_KEY, JSON.stringify(fuzzyConfig));
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
    };
  }

  function scanSearchInputs(root = document) {
    $$('input', root).filter((input) => /搜索|search/i.test(`${input.placeholder || ''} ${input.getAttribute('aria-label') || ''}`)).forEach(installFuzzyToggle);
  }

  function defaultSuffixConfig() {
    return { version: 1, defaultBatteryMode: 'preserve', defaultBatterySuffixes: ['S', 'SE', 'S1', 'S2', 'S3'], stores: {} };
  }

  function suffixConfig() {
    if (typeof state !== 'object' || !state) return defaultSuffixConfig();
    if (!state.skuSuffixRulesV14 || typeof state.skuSuffixRulesV14 !== 'object') state.skuSuffixRulesV14 = defaultSuffixConfig();
    const config = state.skuSuffixRulesV14;
    config.stores ||= {};
    config.defaultBatterySuffixes = Array.isArray(config.defaultBatterySuffixes) ? config.defaultBatterySuffixes : defaultSuffixConfig().defaultBatterySuffixes;
    return config;
  }

  function storeSuffixRule(storeId) {
    const config = suffixConfig();
    const rule = config.stores?.[storeId] || {};
    return {
      batteryMode: ['preserve', 'remove'].includes(rule.batteryMode) ? rule.batteryMode : config.defaultBatteryMode,
      batterySuffixes: Array.isArray(rule.batterySuffixes) && rule.batterySuffixes.length ? rule.batterySuffixes : config.defaultBatterySuffixes,
    };
  }

  function batteryByTitle(title) {
    try { return Boolean(classifyTitle(title || '').isBattery); }
    catch { return /battery|batteries|电池|锂电池|แบตเตอรี่/i.test(String(title || '')); }
  }

  function removeConfiguredSuffix(skuValue, suffixes) {
    const sku = String(skuValue || '').trim().toUpperCase();
    const ordered = [...new Set((suffixes || []).map((value) => String(value).trim().toUpperCase()).filter(Boolean))].sort((a, b) => b.length - a.length);
    const core = sku.slice(0, 11);
    const tail = sku.slice(11);
    if (/^[TP][A-Z0-9]{10}$/i.test(core) && tail && ordered.includes(tail)) return core;
    for (const suffix of ordered) if (sku.endsWith(suffix) && sku.length > suffix.length) return sku.slice(0, -suffix.length);
    return sku;
  }

  function normalizeComboStoreSuffix(skuValue) {
    const sku = String(skuValue || '').trim().toUpperCase();
    const comboIndex = sku.indexOf('X', 11);
    if (comboIndex < 11) return sku;
    const suffixMatch = sku.match(/S(?:\d+)?$/i);
    if (!suffixMatch || suffixMatch.index <= comboIndex) return sku;
    return sku.slice(0, suffixMatch.index);
  }

  function normalizeSkuSuffix(skuValue, storeId, title = '') {
    const sku = normalizeComboStoreSuffix(skuValue);
    const battery = batteryByTitle(title);
    if (battery) {
      const rule = storeSuffixRule(storeId);
      return rule.batteryMode === 'remove' ? removeConfiguredSuffix(sku, rule.batterySuffixes) : sku;
    }
    return sku.replace(/S\d+$/i, '');
  }

  function shouldStripBattery(storeId, sku, title) {
    return batteryByTitle(title) && storeSuffixRule(storeId).batteryMode === 'remove' && normalizeSkuSuffix(sku, storeId, title) !== String(sku || '').trim().toUpperCase();
  }

  function installSkuSettings() {
    const settings = $('#page-settings');
    if (!settings || $('#skuSuffixSettingsV14')) return;
    const panel = document.createElement('div');
    panel.className = 'panel sku14-settings';
    panel.id = 'skuSuffixSettingsV14';
    panel.innerHTML = `<div class="panel-head"><div><div class="eyebrow">SKU suffix rules</div><h3>电池SKU后缀规则</h3><p>按店铺决定电池商品的S类后缀是保留还是去掉。只影响SKU匹配与库存识别，不会修改原Excel。</p></div><button class="btn primary" id="saveSkuSuffixV14">保存后缀设置</button></div><div class="callout info"><strong>安全说明</strong>默认继续保留电池后缀，保持原业务结果。只有你明确把某个店铺设为“去掉”后，该店铺才按填写的后缀列表清洗。</div><div class="sku14-store-rules" id="skuSuffixStoreListV14"></div>`;
    const appearance = $('#appearancePanel');
    if (appearance) appearance.before(panel); else settings.appendChild(panel);
    renderSkuRules();
    $('#saveSkuSuffixV14').onclick = saveSkuRules;
  }

  function renderSkuRules() {
    const config = suffixConfig();
    const stores = Array.isArray(state?.stores) ? state.stores : [];
    $('#skuSuffixStoreListV14').innerHTML = stores.map((store) => {
      const rule = storeSuffixRule(store.id);
      return `<div class="sku14-rule" data-sku-rule-store="${esc(store.id)}"><label class="ai14-field"><span>店铺</span><input value="${esc(store.name)}" disabled></label><label class="ai14-field"><span>电池后缀处理</span><select data-sku-rule-mode><option value="preserve" ${rule.batteryMode === 'preserve' ? 'selected' : ''}>保留后缀（默认）</option><option value="remove" ${rule.batteryMode === 'remove' ? 'selected' : ''}>去掉指定后缀</option></select></label><label class="ai14-field"><span>可去掉的后缀（逗号分隔）</span><input data-sku-rule-suffixes value="${esc(rule.batterySuffixes.join(', '))}" placeholder="S, SE, S1, S2"></label></div>`;
    }).join('') || '<div class="empty">请先在店铺管理中新增店铺。</div>';
    if (!config.defaultBatteryMode) config.defaultBatteryMode = 'preserve';
  }

  function saveSkuRules() {
    const config = suffixConfig();
    for (const row of $$('[data-sku-rule-store]')) {
      const storeId = row.dataset.skuRuleStore;
      const suffixes = $('[data-sku-rule-suffixes]', row).value.split(/[,，;；\n]+/).map((value) => value.trim().toUpperCase()).filter(Boolean).slice(0, 30);
      config.stores[storeId] = { batteryMode: $('[data-sku-rule-mode]', row).value, batterySuffixes: suffixes.length ? [...new Set(suffixes)] : [...config.defaultBatterySuffixes] };
    }
    state.skuSuffixRulesV14 = config;
    saveState();
    window.desktopApp?.database?.flush();
    toast('电池SKU后缀规则已保存');
  }

  window.__fuzzySearchV14 = Object.freeze({ matches, enabled: fuzzyEnabled, scan: scanSearchInputs });
  window.__skuSuffixV14 = Object.freeze({ config: suffixConfig, ruleForStore: storeSuffixRule, normalize: normalizeSkuSuffix, normalizeCombo: normalizeComboStoreSuffix, shouldStrip: shouldStripBattery });

  try {
    installSkuSettings();
    scanSearchInputs();
    const observer = new MutationObserver((mutations) => {
      for (const mutation of mutations) for (const node of mutation.addedNodes) if (node.nodeType === 1) scanSearchInputs(node);
    });
    observer.observe(document.body, { childList: true, subtree: true });
    window.__businessOptimizationsV14 = { ready: true, fuzzyMatch, normalizeSkuSuffix, normalizeComboStoreSuffix, renderSkuRules };
  } catch (error) {
    console.error('Business optimizations V14 failed:', error);
    window.__businessOptimizationsV14 = { ready: false, error: error.message };
  }
})();
