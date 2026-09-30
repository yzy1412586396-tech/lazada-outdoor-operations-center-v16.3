(() => {
  'use strict';

  const CONFIG_KEY = 'lazadaInventoryConfigV13';
  const PRESALE_KEY = 'lazadaInventoryPresaleV12';
  const clean = (value) => String(value ?? '').trim();
  const escapeHtml = (value) => clean(value).replace(/[&<>'"]/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;',
  }[character]));
  const number = (value) => {
    const parsed = Number(clean(value).replace(/[₱฿¥￥,\s]/g, ''));
    return Number.isFinite(parsed) ? parsed : 0;
  };
  const q = (selector, root = document) => root.querySelector(selector);
  const qa = (selector, root = document) => [...root.querySelectorAll(selector)];
  const session = {
    store: null,
    mabang: null,
    results: [],
    visibleLimit: 160,
    filter: 'action',
    query: '',
    threshold: 30,
    storeId: null,
  };

  function defaultConfig() {
    return {
      version: 1,
      storeSku: '', storeSkuHeader: '', storeTitle: '', storeTitleHeader: '', storeStatus: '', storeStatusHeader: '',
      mabangSku: '', mabangSkuHeader: '', mabangName: '', mabangNameHeader: '', mabangWarehouse: '', mabangWarehouseHeader: '',
      warehouses: [
        { id: 'cfs', name: 'CFS', storeColumn: '', storeHeader: '', mabangStockColumn: '', mabangStockHeader: '', mabangValue: 'CFS' },
        { id: 'gaoyi', name: '高易', storeColumn: '', storeHeader: '', mabangStockColumn: '', mabangStockHeader: '', mabangValue: '高易' },
      ],
    };
  }

  function loadConfig() {
    try {
      const saved = JSON.parse(localStorage.getItem(CONFIG_KEY) || 'null');
      if (!saved || typeof saved !== 'object') return defaultConfig();
      const merged = { ...defaultConfig(), ...saved };
      merged.warehouses = Array.isArray(saved.warehouses) && saved.warehouses.length
        ? saved.warehouses.map((warehouse, index) => ({
          id: clean(warehouse.id) || `warehouse-${index + 1}`,
          name: clean(warehouse.name) || `库存 ${index + 1}`,
          storeColumn: clean(warehouse.storeColumn),
          storeHeader: clean(warehouse.storeHeader),
          mabangStockColumn: clean(warehouse.mabangStockColumn),
          mabangStockHeader: clean(warehouse.mabangStockHeader),
          mabangValue: clean(warehouse.mabangValue),
        }))
        : defaultConfig().warehouses;
      return merged;
    } catch {
      return defaultConfig();
    }
  }

  let config = loadConfig();
  let presales;
  try { presales = JSON.parse(localStorage.getItem(PRESALE_KEY) || '{}'); } catch { presales = {}; }

  function saveConfig() {
    localStorage.setItem(CONFIG_KEY, JSON.stringify(config));
    window.desktopApp?.database?.flush();
  }

  function savePresales() {
    localStorage.setItem(PRESALE_KEY, JSON.stringify(presales));
  }

  function country() { return window.currentCountry || 'ph'; }
  function selectedStoreId() { return session.storeId || window.selectedStoreId || state?.stores?.[0]?.id || 'default'; }
  function isPresale(sku) { return Boolean(presales?.[country()]?.[selectedStoreId()]?.[sku]); }
  function setPresale(sku, enabled) {
    presales[country()] ||= {};
    presales[country()][selectedStoreId()] ||= {};
    if (enabled) presales[country()][selectedStoreId()][sku] = { on: true, updatedAt: new Date().toISOString() };
    else delete presales[country()][selectedStoreId()][sku];
    savePresales();
  }

  function columnName(numberValue) {
    let name = '';
    let value = Number(numberValue);
    while (value) {
      value -= 1;
      name = String.fromCharCode(65 + (value % 26)) + name;
      value = Math.floor(value / 26);
    }
    return name;
  }

  function columnOptions(columns, selected, placeholder = '未选择') {
    return `<option value="">${placeholder}</option>` + (columns || []).map((column) => (
      `<option value="${column.c}" ${String(column.c) === String(selected) ? 'selected' : ''}>${columnName(column.c)}列 · ${escapeHtml(column.h || '未命名')}</option>`
    )).join('');
  }

  function findColumn(columns, keywords, strict = false) {
    for (const keyword of keywords) {
      const expected = keyword.toLowerCase();
      const found = columns.find((column) => {
        const header = clean(column.h).toLowerCase();
        return strict ? header === expected : header.includes(expected);
      });
      if (found) return String(found.c);
    }
    return '';
  }

  function resolveColumn(columns, savedColumn, savedHeader, guesses = []) {
    if (savedHeader) {
      const exact = columns.find((column) => clean(column.h).toLowerCase() === clean(savedHeader).toLowerCase());
      if (exact) return String(exact.c);
    }
    if (savedColumn && columns.some((column) => String(column.c) === String(savedColumn))) return String(savedColumn);
    return findColumn(columns, guesses, true) || findColumn(columns, guesses);
  }

  function headerFor(columns, column) {
    return clean(columns?.find((item) => String(item.c) === String(column))?.h);
  }

  function isBattery(title) {
    try { return Boolean(classifyTitle(title).isBattery); }
    catch { return /battery|power station|户外电源|储能电源|แบตเตอรี่/i.test(title); }
  }

  function skuInfo(rawValue, title = '') {
    const raw = normalizeSku(rawValue);
    const battery = isBattery(title);
    const comboPosition = raw.search(/X/i);
    const isCombo = comboPosition >= 11;
    const beforeCombo = isCombo ? raw.slice(0, comboPosition) : raw;
    const candidate = beforeCombo.slice(0, 11);
    const valid = /^[TP][A-Z0-9]{10}$/i.test(candidate);
    let base = window.__skuSuffixV14?.normalize
      ? window.__skuSuffixV14.normalize(beforeCombo, selectedStoreId(), title)
      : beforeCombo;
    if (!window.__skuSuffixV14 && !battery) base = base.replace(/S[A-Z0-9]*$/i, '');
    const batterySuffixRemoved = battery && base !== beforeCombo;
    if (valid && (!battery || batterySuffixRemoved)) base = candidate;
    const core = valid ? candidate : base.slice(0, 11);
    return { raw, isBattery: battery, isCombo, base, core, key: core.slice(-4), valid };
  }

  async function inspectFile(file, kind) {
    const workbook = await openWorkbook(file);
    let best = null;
    for (const definition of workbook.sheets.filter((sheet) => sheet.state === 'visible')) {
      const sheet = await getSheet(workbook, definition);
      for (let row = 1; row <= Math.min(sheet.maxRow, 20); row += 1) {
        const columns = [];
        for (let column = 1; column <= Math.min(sheet.maxCol, 160); column += 1) {
          columns.push({ c: column, h: clean(cellValue(sheet, row, column)) });
        }
        const skuScore = kind === 'store'
          ? (findColumn(columns, ['SellerSKU', '卖家SKU'], true) ? 12 : (findColumn(columns, ['SKU']) ? 7 : 0))
          : (findColumn(columns, ['库存SKU编号', 'SKU编号'], true) ? 12 : (findColumn(columns, ['SKU']) ? 7 : 0));
        const otherScore = kind === 'store'
          ? (findColumn(columns, ['库存']) ? 2 : 0)
          : (findColumn(columns, ['仓库']) ? 3 : 0) + (findColumn(columns, ['库存']) ? 3 : 0);
        const score = skuScore + otherScore;
        if (!best || score > best.score) best = { score, workbook, definition, sheet, row, columns };
      }
    }
    if (!best || best.score < 7) throw new Error(kind === 'store' ? '没有识别到店铺 SellerSKU 表头' : '没有识别到马帮库存 SKU 表头');
    return best;
  }

  function applySavedMappings(kind, data) {
    const columns = data.columns;
    if (kind === 'store') {
      config.storeSku = resolveColumn(columns, config.storeSku, config.storeSkuHeader, ['SellerSKU', '卖家SKU', 'SKU']);
      config.storeTitle = resolveColumn(columns, config.storeTitle, config.storeTitleHeader, ['商品标题', '产品名称', 'title']);
      config.storeStatus = resolveColumn(columns, config.storeStatus, config.storeStatusHeader, ['商品状态', 'status']);
      for (const warehouse of config.warehouses) {
        warehouse.storeColumn = resolveColumn(columns, warehouse.storeColumn, warehouse.storeHeader, [warehouse.name]);
        warehouse.storeHeader = headerFor(columns, warehouse.storeColumn);
      }
    } else {
      config.mabangSku = resolveColumn(columns, config.mabangSku, config.mabangSkuHeader, ['库存SKU编号', 'SKU编号', 'SKU']);
      config.mabangName = resolveColumn(columns, config.mabangName, config.mabangNameHeader, ['中文名称', '商品名称', '产品名称']);
      config.mabangWarehouse = resolveColumn(columns, config.mabangWarehouse, config.mabangWarehouseHeader, ['仓库名称', '仓库']);
      for (const warehouse of config.warehouses) {
        warehouse.mabangStockColumn = resolveColumn(columns, warehouse.mabangStockColumn, warehouse.mabangStockHeader, ['仓位库存', '可用库存', `${warehouse.name}库存`, '库存']);
        warehouse.mabangStockHeader = headerFor(columns, warehouse.mabangStockColumn);
      }
    }
    saveConfig();
  }

  async function loadFile(kind, file) {
    if (!file) return;
    const status = q(kind === 'store' ? '#inv13StoreStatus' : '#inv13MabangStatus');
    status.innerHTML = '<div class="callout info"><strong>正在读取表格</strong><div class="inv13-progress"><i></i></div></div>';
    await new Promise((resolve) => requestAnimationFrame(resolve));
    try {
      const data = await inspectFile(file, kind);
      data.file = file;
      data.valueCache = new Map();
      session[kind] = data;
      applySavedMappings(kind, data);
      renderBaseMappings();
      renderWarehouseManager();
      status.innerHTML = `<div class="callout good"><strong>已识别 ${escapeHtml(file.name)}</strong>${escapeHtml(data.definition.name)} · 表头第 ${data.row} 行 · ${data.sheet.maxRow} 行 × ${data.sheet.maxCol} 列</div>`;
    } catch (error) {
      status.innerHTML = `<div class="callout danger"><strong>读取失败</strong>${escapeHtml(error.message)}</div>`;
      toast(error.message, 'err');
      throw error;
    }
  }

  function distinctWarehouseValues() {
    const data = session.mabang;
    const column = config.mabangWarehouse;
    if (!data || !column) return [];
    if (data.valueCache.has(column)) return data.valueCache.get(column);
    const values = new Set();
    for (let row = data.row + 1; row <= data.sheet.maxRow; row += 1) {
      const value = clean(cellValue(data.sheet, row, Number(column)));
      if (value) values.add(value);
      if (values.size >= 300) break;
    }
    const result = [...values].sort((a, b) => a.localeCompare(b, 'zh-CN'));
    data.valueCache.set(column, result);
    return result;
  }

  function renderBaseMappings() {
    const storeColumns = session.store?.columns || [];
    const mabangColumns = session.mabang?.columns || [];
    const storeBox = q('#inv13StoreBaseMap');
    const mabangBox = q('#inv13MabangBaseMap');
    if (storeBox) storeBox.innerHTML = `
      <label>SellerSKU（必选）<select data-inv13-base="storeSku">${columnOptions(storeColumns, config.storeSku)}</select></label>
      <label>商品标题<select data-inv13-base="storeTitle">${columnOptions(storeColumns, config.storeTitle)}</select></label>
      <label>商品状态<select data-inv13-base="storeStatus">${columnOptions(storeColumns, config.storeStatus)}</select></label>`;
    if (mabangBox) mabangBox.innerHTML = `
      <label>库存SKU编号（必选）<select data-inv13-base="mabangSku">${columnOptions(mabangColumns, config.mabangSku)}</select></label>
      <label>商品名称<select data-inv13-base="mabangName">${columnOptions(mabangColumns, config.mabangName)}</select></label>
      <label>仓库名称列<select data-inv13-base="mabangWarehouse">${columnOptions(mabangColumns, config.mabangWarehouse, '不按仓库名称筛选')}</select></label>`;
  }

  function renderWarehouseManager() {
    const box = q('#inv13WarehouseList');
    if (!box) return;
    const storeColumns = session.store?.columns || [];
    const mabangColumns = session.mabang?.columns || [];
    const values = distinctWarehouseValues();
    q('#inv13WarehouseValues').innerHTML = values.map((value) => `<option value="${escapeHtml(value)}"></option>`).join('');
    box.innerHTML = config.warehouses.length ? config.warehouses.map((warehouse) => `
      <div class="inv13-warehouse-row" data-warehouse-id="${escapeHtml(warehouse.id)}">
        <label>库存显示名称<input data-inv13-warehouse-name value="${escapeHtml(warehouse.name)}" placeholder="例如：CFS"></label>
        <label>店铺表格库存列<select data-inv13-store-column>${columnOptions(storeColumns, warehouse.storeColumn)}</select></label>
        <label>马帮表格库存列<select data-inv13-mabang-stock>${columnOptions(mabangColumns, warehouse.mabangStockColumn)}</select></label>
        <label>对应马帮仓库名称<input data-inv13-mabang-value list="inv13WarehouseValues" value="${escapeHtml(warehouse.mabangValue)}" placeholder="留空表示全部行"></label>
        <button class="btn danger sm" type="button" data-inv13-delete-warehouse>删除</button>
      </div>`).join('') : '<div class="inv13-empty-mapping">还没有库存映射，请点击“新增库存”。</div>';
    const badge = q('#inv13WarehouseCount');
    if (badge) badge.textContent = `${config.warehouses.length} 个库存`;
  }

  function addWarehouse() {
    const id = `warehouse-${Date.now()}`;
    config.warehouses.push({ id, name: `新库存 ${config.warehouses.length + 1}`, storeColumn: '', storeHeader: '', mabangStockColumn: '', mabangStockHeader: '', mabangValue: '' });
    saveConfig();
    renderWarehouseManager();
    q(`[data-warehouse-id="${id}"] input`)?.focus();
  }

  function deleteWarehouse(id) {
    const warehouse = config.warehouses.find((item) => item.id === id);
    config.warehouses = config.warehouses.filter((item) => item.id !== id);
    saveConfig();
    renderWarehouseManager();
    toast(`已删除库存：${warehouse?.name || '未命名'}`, 'ok');
  }

  function updateWarehouse(element) {
    const row = element.closest('[data-warehouse-id]');
    const warehouse = config.warehouses.find((item) => item.id === row?.dataset.warehouseId);
    if (!warehouse) return;
    if (element.matches('[data-inv13-warehouse-name]')) warehouse.name = clean(element.value) || '未命名库存';
    if (element.matches('[data-inv13-store-column]')) {
      warehouse.storeColumn = element.value;
      warehouse.storeHeader = headerFor(session.store?.columns, element.value);
    }
    if (element.matches('[data-inv13-mabang-stock]')) {
      warehouse.mabangStockColumn = element.value;
      warehouse.mabangStockHeader = headerFor(session.mabang?.columns, element.value);
    }
    if (element.matches('[data-inv13-mabang-value]')) warehouse.mabangValue = clean(element.value);
    saveConfig();
  }

  function updateBaseMapping(element) {
    const key = element.dataset.inv13Base;
    config[key] = element.value;
    const columns = key.startsWith('store') ? session.store?.columns : session.mabang?.columns;
    config[`${key}Header`] = headerFor(columns, element.value);
    if (key === 'mabangWarehouse' && session.mabang) session.mabang.valueCache.clear();
    saveConfig();
    if (key === 'mabangWarehouse') renderWarehouseManager();
  }

  function mappedWarehouses() {
    return config.warehouses.filter((warehouse) => warehouse.storeColumn && warehouse.mabangStockColumn);
  }

  function normalizedWarehouseValues(value) {
    return clean(value).toLowerCase().split(/[|,，;；]+/).map((item) => item.trim()).filter(Boolean);
  }

  function warehouseData(warehouses) {
    const data = session.mabang;
    if (!config.mabangSku) throw new Error('马帮表格必须选择库存 SKU 编号列');
    const map = {};
    const all = [];
    for (let row = data.row + 1; row <= data.sheet.maxRow; row += 1) {
      const raw = clean(cellValue(data.sheet, row, Number(config.mabangSku)));
      if (!raw) continue;
      const name = config.mabangName ? clean(cellValue(data.sheet, row, Number(config.mabangName))) : '';
      const warehouseName = config.mabangWarehouse ? clean(cellValue(data.sheet, row, Number(config.mabangWarehouse))) : '';
      const info = skuInfo(raw, name);
      map[info.base] ||= { raw: info.raw, name, key: info.key, stocks: {} };
      for (const warehouse of warehouses) {
        const acceptedNames = normalizedWarehouseValues(warehouse.mabangValue);
        if (acceptedNames.length && !acceptedNames.includes(warehouseName.toLowerCase())) continue;
        const stock = number(cellValue(data.sheet, row, Number(warehouse.mabangStockColumn)));
        map[info.base].stocks[warehouse.id] = (map[info.base].stocks[warehouse.id] || 0) + stock;
      }
      all.push({ ...info, name, stocks: map[info.base].stocks });
    }
    return { map, all };
  }

  function storeRows(warehouses) {
    const data = session.store;
    if (!config.storeSku) throw new Error('店铺表格必须选择 SellerSKU 列');
    const rows = [];
    for (let row = data.row + 1; row <= data.sheet.maxRow; row += 1) {
      const raw = clean(cellValue(data.sheet, row, Number(config.storeSku)));
      if (!raw) continue;
      const title = config.storeTitle ? clean(cellValue(data.sheet, row, Number(config.storeTitle))) : '';
      const info = skuInfo(raw, title);
      const storeStocks = Object.fromEntries(warehouses.map((warehouse) => [warehouse.id, number(cellValue(data.sheet, row, Number(warehouse.storeColumn)))]));
      rows.push({
        row,
        ...info,
        title,
        status: config.storeStatus ? clean(cellValue(data.sheet, row, Number(config.storeStatus))) : '',
        storeStocks,
      });
    }
    return rows;
  }

  function totalStocks(stocks, warehouses) {
    return warehouses.reduce((sum, warehouse) => sum + number(stocks?.[warehouse.id]), 0);
  }

  function classifyResult(item, mabangStocks, warehouses, threshold, alternatives) {
    const issues = [];
    const codes = [];
    const storeTotal = totalStocks(item.storeStocks, warehouses);
    const mabangTotal = totalStocks(mabangStocks, warehouses);
    for (const warehouse of warehouses) {
      const opened = number(item.storeStocks[warehouse.id]);
      const actual = number(mabangStocks[warehouse.id]);
      if (opened > 0 && actual <= 0) {
        codes.push('wrongWarehouse');
        const available = warehouses.filter((other) => number(mabangStocks[other.id]) > 0).map((other) => other.name).join('、');
        issues.push(`${warehouse.name}店铺库存已开启，但马帮对应库存为 0${available ? `；当前有货库存：${available}` : ''}`);
      }
      if (actual > 0 && actual < threshold) {
        codes.push('low');
        issues.push(`${warehouse.name}库存偏低，仅剩 ${actual}`);
      }
    }
    if (storeTotal > 0 && mabangTotal <= 0) {
      codes.push('outOfStock');
      issues.push('所有已映射的马帮库存都为 0，店铺仍然开着库存');
    }
    if (item.isCombo && mabangTotal <= 0) {
      codes.push('comboBlocked');
      issues.push('组合 SKU 关联的基础普通 SKU 缺货，当前组合不能销售');
    }
    const severe = codes.some((code) => ['wrongWarehouse', 'outOfStock', 'comboBlocked'].includes(code));
    const level = severe ? 'danger' : codes.includes('low') ? 'warn' : 'good';
    let action = '库存与仓库映射正常';
    if (codes.includes('outOfStock')) action = alternatives.length ? '优先选择右侧同款有货 SKU；若暂不替换，请关闭库存或开启预售' : '没有找到同款有货 SKU，请关闭店铺库存或开启预售';
    else if (codes.includes('wrongWarehouse')) action = '把店铺库存调整到实际有货的库存，或更换为对应库存有货的同款 SKU';
    else if (codes.includes('comboBlocked')) action = '关闭该组合商品库存，并核对组合组件';
    else if (codes.includes('low')) action = '库存偏低，建议补货、降低店铺库存或提前开启预售';
    return { issues: [...new Set(issues)], codes: [...new Set(codes)], level, action };
  }

  async function analyze() {
    if (country() !== 'ph') return toast('库存识别当前只启用菲律宾规则，请先切换菲律宾系统', 'err');
    if (!session.store || !session.mabang) return toast('请先上传店铺商品表和马帮库存表', 'err');
    const warehouses = mappedWarehouses();
    if (!warehouses.length) return toast('请至少完整设置一个库存：店铺库存列 + 马帮库存列', 'err');
    const button = q('#inv13Analyze');
    button.disabled = true;
    button.textContent = '正在分析…';
    await new Promise((resolve) => requestAnimationFrame(resolve));
    try {
      session.threshold = Math.max(0, number(q('#inv13Threshold').value || 30));
      const warehouseResult = warehouseData(warehouses);
      const rows = storeRows(warehouses);
      const alternativesByKey = {};
      for (const record of Object.values(warehouseResult.map)) {
        const total = totalStocks(record.stocks, warehouses);
        const info = skuInfo(record.raw, record.name);
        if (!info.valid || total <= 0) continue;
        (alternativesByKey[info.key] ||= new Map()).set(info.base, { sku: info.base, stocks: { ...record.stocks }, total, name: record.name });
      }
      session.results = rows.map((item) => {
        const mabangStocks = warehouseResult.map[item.base]?.stocks || {};
        const alternatives = [...(alternativesByKey[item.key]?.values() || [])]
          .filter((alternative) => alternative.sku !== item.base && alternative.total > 0)
          .sort((a, b) => b.total - a.total);
        const risk = classifyResult(item, mabangStocks, warehouses, session.threshold, alternatives);
        return { ...item, mabangStocks, alternatives, ...risk, presale: isPresale(item.raw) };
      });
      session.visibleLimit = 160;
      renderResults();
      toast(`库存识别完成：${session.results.length} 个 SKU，${warehouses.length} 个库存`, 'ok');
    } catch (error) {
      console.error(error);
      toast(error.message, 'err');
    } finally {
      button.disabled = false;
      button.textContent = '开始库存识别';
    }
  }

  function matchesFilter(item, filter) {
    if (filter === 'action') return item.level === 'danger';
    if (filter === 'outOfStock') return item.codes.includes('outOfStock');
    if (filter === 'wrongWarehouse') return item.codes.includes('wrongWarehouse');
    if (filter === 'low') return item.codes.includes('low');
    if (filter === 'combo') return item.codes.includes('comboBlocked');
    if (filter === 'presale') return item.presale;
    if (filter === 'normal') return item.level === 'good';
    return true;
  }

  function filteredResults() {
    const query = session.query.toLowerCase();
    return session.results.filter((item) => {
      const searchText = `${item.raw} ${item.base} ${item.title} ${item.alternatives.map((alternative) => alternative.sku).join(' ')}`.toLowerCase();
      const searchMatch = window.__fuzzySearchV14?.matches
        ? window.__fuzzySearchV14.matches(searchText, query, 'inv13Search')
        : (!query || searchText.includes(query));
      return searchMatch && matchesFilter(item, session.filter);
    }).sort((a, b) => (
      Number(a.presale) - Number(b.presale)
      || ({ danger: 0, warn: 1, good: 2 }[a.level] - { danger: 0, warn: 1, good: 2 }[b.level])
      || a.raw.localeCompare(b.raw)
    ));
  }

  function counts() {
    const rows = session.results;
    return {
      action: rows.filter((item) => item.level === 'danger' && !item.presale).length,
      outOfStock: rows.filter((item) => item.codes.includes('outOfStock')).length,
      wrongWarehouse: rows.filter((item) => item.codes.includes('wrongWarehouse')).length,
      low: rows.filter((item) => item.codes.includes('low')).length,
      combo: rows.filter((item) => item.codes.includes('comboBlocked')).length,
      presale: rows.filter((item) => item.presale).length,
      normal: rows.filter((item) => item.level === 'good').length,
      all: rows.length,
    };
  }

  function highlightedSku(sku) {
    const value = escapeHtml(sku);
    return value.length > 4 ? `${value.slice(0, -4)}<mark>${value.slice(-4)}</mark>` : value;
  }

  function stockClass(value) {
    return value <= 0 ? 'stock-zero' : value < session.threshold ? 'stock-low' : 'stock-ok';
  }

  function stockLines(stocks, warehouses) {
    return warehouses.map((warehouse) => {
      const value = number(stocks?.[warehouse.id]);
      return `<div class="inv13-stock-line"><span>${escapeHtml(warehouse.name)}</span><b class="${stockClass(value)}">${value}</b></div>`;
    }).join('');
  }

  function cardHtml(item, warehouses) {
    const reasons = item.issues.length ? item.issues.map((reason) => `<div>• ${escapeHtml(reason)}</div>`).join('') : '库存与仓库映射正常';
    const alternatives = item.alternatives.length ? item.alternatives.slice(0, 12).map((alternative) => `
      <div class="inv13-alt"><code>${highlightedSku(alternative.sku)}</code><span>${warehouses.map((warehouse) => `${escapeHtml(warehouse.name)} ${number(alternative.stocks[warehouse.id])}`).join(' · ')}</span></div>`).join('') : '<div class="inv12-no-alt">没有找到基础 11 位 SKU 后四位相同且任一库存有货的替代 SKU。</div>';
    return `<article class="inv12-card ${item.level} ${item.presale ? 'presale' : ''}" data-sku="${escapeHtml(item.raw)}">
      <div class="inv12-card-head"><div><div class="inv12-sku-line"><span class="inv12-sku">${highlightedSku(item.raw)}</span>${item.isCombo ? '<span class="chip warn">组合SKU</span>' : '<span class="chip muted">普通SKU</span>'}${item.isBattery ? '<span class="chip blue">电池S/SE保留</span>' : ''}<span class="chip ${item.level}">${item.level === 'danger' ? '需要处理' : item.level === 'warn' ? '库存偏低' : '正常'}</span></div><div class="inv12-title">${escapeHtml(item.title || '无商品标题')}</div></div><label class="inv12-presale"><input type="checkbox" data-inv13-presale="${escapeHtml(item.raw)}" ${item.presale ? 'checked' : ''}>已开预售</label></div>
      <div class="inv12-card-grid inv13-card-grid">
        <div class="inv12-cell"><div class="inv12-label">店铺表格库存</div><div class="inv13-stock-list">${stockLines(item.storeStocks, warehouses)}</div></div>
        <div class="inv12-cell"><div class="inv12-label">马帮实际库存</div><div class="inv13-stock-list">${stockLines(item.mabangStocks, warehouses)}</div></div>
        <div class="inv12-cell"><div class="inv12-label">风险与建议</div><div class="inv12-reason">${reasons}</div><div class="inv12-action">${escapeHtml(item.action)}</div></div>
        <div class="inv12-cell"><div class="inv12-label">同款有货替代 SKU</div><div class="inv13-alts">${alternatives}</div></div>
      </div></article>`;
  }

  function metricHtml(key, label, value) {
    return `<button class="inv12-metric ${session.filter === key ? 'active' : ''}" data-inv13-filter="${key}"><span>${label}</span><b>${value}</b></button>`;
  }

  function renderResults() {
    const warehouses = mappedWarehouses();
    const values = counts();
    q('#inv13Metrics').innerHTML = [
      metricHtml('action', '待处理', values.action), metricHtml('outOfStock', '全部缺货', values.outOfStock),
      metricHtml('wrongWarehouse', '库存错位', values.wrongWarehouse), metricHtml('low', '库存偏低', values.low),
      metricHtml('presale', '已开预售', values.presale), metricHtml('all', '全部SKU', values.all),
    ].join('');
    const filtered = filteredResults();
    const visible = filtered.slice(0, session.visibleLimit);
    q('#inv13Count').textContent = `当前 ${filtered.length} / 全部 ${session.results.length}`;
    q('#inv13List').innerHTML = visible.length ? visible.map((item) => cardHtml(item, warehouses)).join('') : '<div class="inv12-empty">当前筛选没有结果。</div>';
    q('#inv13More').innerHTML = filtered.length > visible.length ? `<button class="btn light" id="inv13MoreButton">继续显示 ${Math.min(160, filtered.length - visible.length)} 条</button>` : '';
    q('#inv13MoreButton')?.addEventListener('click', () => { session.visibleLimit += 160; renderResults(); });
  }

  function exportCsv(scope) {
    if (!session.results.length) return toast('请先完成库存识别', 'err');
    const warehouses = mappedWarehouses();
    const rows = scope === 'filtered' ? filteredResults() : session.results;
    const headers = ['店铺原始SKU', '清洗后SKU', '商品标题', 'SKU类型'];
    for (const warehouse of warehouses) headers.push(`店铺-${warehouse.name}`, `马帮-${warehouse.name}`);
    headers.push('风险等级', '风险代码', '风险原因', '建议操作', '已开预售', '同款替换SKU');
    const quote = (value) => `"${String(value ?? '').replaceAll('"', '""')}"`;
    const lines = rows.map((item) => {
      const values = [item.raw, item.base, item.title, item.isCombo ? '组合' : '普通'];
      for (const warehouse of warehouses) values.push(item.storeStocks[warehouse.id] || 0, item.mabangStocks[warehouse.id] || 0);
      values.push(item.level, item.codes.join('|'), item.issues.join('；'), item.action, item.presale ? '是' : '否', item.alternatives.map((alternative) => `${alternative.sku}(${warehouses.map((warehouse) => `${warehouse.name}:${alternative.stocks[warehouse.id] || 0}`).join(',')})`).join('；'));
      return values.map(quote).join(',');
    });
    const blob = new Blob([`\ufeff${headers.map(quote).join(',')}\r\n${lines.join('\r\n')}`], { type: 'text/csv;charset=utf-8' });
    const storeName = state.stores?.find((store) => store.id === selectedStoreId())?.name || '店铺';
    downloadBlob(blob, `库存识别_${storeName}_${new Date().toISOString().slice(0, 10)}.csv`);
  }

  function populateStores() {
    const select = q('#inv13StoreSelect');
    if (!select) return;
    const stores = state?.stores || [];
    const previous = session.storeId || select.value;
    select.innerHTML = stores.map((store) => `<option value="${escapeHtml(store.id)}">${escapeHtml(store.name)}${store.active === false ? '（已停用）' : ''}</option>`).join('');
    if (stores.some((store) => store.id === previous)) select.value = previous;
    session.storeId = select.value || stores[0]?.id || '';
  }

  function clearUpload(kind) {
    session[kind] = null;
    session.results = [];
    const input = q(kind === 'store' ? '#inv13StoreFile' : '#inv13MabangFile');
    if (input) input.value = '';
    const status = q(kind === 'store' ? '#inv13StoreStatus' : '#inv13MabangStatus');
    if (status) status.innerHTML = '<div class="callout info"><strong>已清除上传表格</strong>可以重新选择文件。</div>';
    renderBaseMappings();
    renderWarehouseManager();
    q('#inv13List').innerHTML = '<div class="inv12-empty">上传两张表并开始识别后，这里会展示结果。</div>';
    q('#inv13Metrics').innerHTML = '';
    q('#inv13Count').textContent = '尚未分析';
  }

  function installPage() {
    const page = q('#page-inventory');
    if (!page) throw new Error('库存识别页面不存在');
    page.innerHTML = `
      <div class="inventory-v12-hero"><div><div class="eyebrow">Inventory intelligence V13</div><h2>库存识别 · 自定义库存与马帮列映射</h2><p>每个库存都可以改名，并分别指定店铺库存列、马帮库存列和马帮仓库名称。系统只读取你选择的列，不修改原文件。</p><div class="inv13-hero-badge"><span class="chip good">自定义库存</span><span class="chip blue">映射自动保存</span><span class="chip muted" id="inv13WarehouseCount">2 个库存</span></div></div><div class="hero-side"><span class="chip warn">菲律宾规则</span><strong>库存数量不再写死</strong><small>可增加第三、第四个库存</small></div></div>
      <div class="inv12-ops"><details open><summary><span>上传、基础列与库存对应关系</span></summary><div class="inv12-ops-body">
        <div class="inv12-upload-grid">
          <div class="inv12-source"><h4>① 店铺全店商品表</h4><p>选择 SellerSKU、标题，以及每个库存对应的店铺列。</p><div class="drop"><strong>选择店铺商品表</strong><input type="file" id="inv13StoreFile" accept=".xlsx,.xlsm"><span>上传后所有列都可以手动选择</span></div><div id="inv13StoreStatus" style="margin-top:9px"></div><div id="inv13StoreBaseMap" class="inv13-base-map"></div></div>
          <div class="inv12-source"><h4>② 马帮库存详细表</h4><p>选择 SKU、仓库名称列，以及每个库存要读取的马帮库存列。</p><div class="drop"><strong>选择马帮库存表</strong><input type="file" id="inv13MabangFile" accept=".xlsx,.xlsm"><span>支持长表仓库筛选和多库存列</span></div><div id="inv13MabangStatus" style="margin-top:9px"></div><div id="inv13MabangBaseMap" class="inv13-base-map"></div></div>
        </div>
        <div class="inv13-manager"><div class="inv13-manager-head"><div><strong>库存名称与列对应关系</strong><small>“马帮仓库名称”留空时，该库存列会汇总全部行；可用 | 或逗号填写多个仓库名称。</small></div><button class="btn primary sm" type="button" id="inv13AddWarehouse">＋ 新增库存</button></div><datalist id="inv13WarehouseValues"></datalist><div class="inv13-warehouse-list" id="inv13WarehouseList"></div></div>
        <div class="inv12-runbar"><label>分析店铺<select id="inv13StoreSelect"></select></label><label>低库存阈值<input id="inv13Threshold" type="number" min="0" value="30"></label><button class="btn primary" id="inv13Analyze">开始库存识别</button><button class="btn light" id="inv13ExportAll">导出全部结果</button><span class="small-note">库存名称、列设置和预售状态会自动保存到本机数据库。</span></div>
      </div></details></div>
      <div class="inv12-board"><div class="inv12-board-head"><div class="inv12-board-title"><div><h3>库存预警看板</h3><p>看板和导出列会跟随你设置的库存数量自动变化。</p></div><div class="inv12-board-actions"><button class="btn light sm" id="inv13ExportFiltered">导出当前筛选</button></div></div><div class="inv12-metrics" id="inv13Metrics"></div><div class="inv12-filters"><input id="inv13Search" placeholder="搜索店铺SKU、清洗SKU、标题或替代SKU"><select id="inv13Filter"><option value="action">只看需要处理</option><option value="outOfStock">全部库存都没货</option><option value="wrongWarehouse">库存对应错误</option><option value="low">库存偏低</option><option value="combo">组合不能卖</option><option value="presale">已开预售</option><option value="normal">正常有货</option><option value="all">全部SKU</option></select><span class="inv12-count" id="inv13Count">尚未分析</span></div></div><div class="inv12-list" id="inv13List"><div class="inv12-empty">上传两张表并开始识别后，这里会展示结果。</div></div><div class="inv12-more" id="inv13More"></div><div class="inv12-note">判断严格按照你设置的库存映射执行。电池SKU后缀是否保留由“数据设置 → 电池SKU后缀规则”按店铺决定；同款候选仍按基础11位SKU后四位识别。</div></div>`;

    renderBaseMappings();
    renderWarehouseManager();
    populateStores();

    q('#inv13StoreFile').onchange = (event) => loadFile('store', event.target.files?.[0]).catch(console.error);
    q('#inv13MabangFile').onchange = (event) => loadFile('mabang', event.target.files?.[0]).catch(console.error);
    q('#inv13AddWarehouse').onclick = addWarehouse;
    q('#inv13Analyze').onclick = analyze;
    q('#inv13ExportAll').onclick = () => exportCsv('all');
    q('#inv13ExportFiltered').onclick = () => exportCsv('filtered');
    q('#inv13StoreSelect').onchange = (event) => {
      session.storeId = event.target.value;
      session.results.forEach((item) => { item.presale = isPresale(item.raw); });
      renderResults();
    };
    q('#inv13Filter').onchange = (event) => { session.filter = event.target.value; session.visibleLimit = 160; renderResults(); };
    let searchTimer;
    q('#inv13Search').oninput = (event) => {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(() => { session.query = clean(event.target.value); session.visibleLimit = 160; renderResults(); }, 140);
    };
    page.addEventListener('change', (event) => {
      const target = event.target;
      if (target.matches('[data-inv13-base]')) updateBaseMapping(target);
      if (target.matches('[data-inv13-warehouse-name],[data-inv13-store-column],[data-inv13-mabang-stock],[data-inv13-mabang-value]')) updateWarehouse(target);
      if (target.matches('[data-inv13-presale]')) {
        setPresale(target.dataset.inv13Presale, target.checked);
        const item = session.results.find((row) => row.raw === target.dataset.inv13Presale);
        if (item) item.presale = target.checked;
        renderResults();
      }
    });
    page.addEventListener('click', (event) => {
      const deleteButton = event.target.closest('[data-inv13-delete-warehouse]');
      if (deleteButton) deleteWarehouse(deleteButton.closest('[data-warehouse-id]').dataset.warehouseId);
      const metric = event.target.closest('[data-inv13-filter]');
      if (metric) {
        session.filter = metric.dataset.inv13Filter;
        q('#inv13Filter').value = session.filter;
        session.visibleLimit = 160;
        renderResults();
      }
    });

    qa('#countrySwitch [data-country]').forEach((button) => button.addEventListener('click', () => setTimeout(populateStores, 80)));
    q('#nav [data-page="inventory"]')?.addEventListener('click', () => setTimeout(populateStores, 0));
    window.addEventListener('stores-changed-v14', (event) => {
      const requested = clean(event.detail?.selectedStoreId);
      if ((state?.stores || []).some((store) => store.id === requested)) session.storeId = requested;
      populateStores();
    });
    window.__inventoryV13 = {
      ready: true,
      clearUpload,
      refreshStores: populateStores,
      getConfig: () => JSON.parse(JSON.stringify(config)),
      getSession: () => session,
      getStores: () => (state?.stores || []).map((store) => ({ id: store.id, name: store.name, active: store.active !== false })),
      normalizeSkuForTest: skuInfo,
    };
  }

  try { installPage(); }
  catch (error) {
    console.error('Inventory V13 failed:', error);
    window.__inventoryV13 = { ready: false, error: error.message, getConfig: () => config };
  }
})();
