(() => {
  'use strict';

  const engine = window.InventoryEngineV15;
  if (!engine) throw new Error('V15 库存规则引擎未加载');

  const CONFIG_KEY = 'lazadaInventoryConfigV15';
  const LEGACY_CONFIG_KEY = 'lazadaInventoryConfigV13';
  const MIME_XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
  const session = {
    store: null,
    mabang: null,
    combo: null,
    results: [],
    audit: null,
    storeId: '',
    filter: 'all',
    query: '',
    visibleLimit: 200,
    restoring: false,
    restoreToken: 0,
    exporting: false,
  };

  const q = (selector, root = document) => root.querySelector(selector);
  const qa = (selector, root = document) => [...root.querySelectorAll(selector)];
  const clean = (value) => String(value ?? '').trim();
  const escapeHtml = (value) => clean(value).replace(/[&<>'"]/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;',
  }[character]));

  function defaultConfig() {
    return {
      version: 3,
      threshold: 30,
      overflowValue: 9999,
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
      const saved = JSON.parse(localStorage.getItem(CONFIG_KEY) || localStorage.getItem(LEGACY_CONFIG_KEY) || 'null');
      if (!saved || typeof saved !== 'object') return defaultConfig();
      const merged = { ...defaultConfig(), ...saved, version: 3 };
      merged.threshold = Math.max(0, engine.number(saved.threshold ?? 30));
      merged.overflowValue = Math.max(1, engine.number(saved.overflowValue ?? 9999));
      merged.warehouses = Array.isArray(saved.warehouses) && saved.warehouses.length
        ? saved.warehouses.map((warehouse, index) => ({
          id: clean(warehouse.id) || `warehouse-${index + 1}`,
          name: clean(warehouse.name) || `仓库 ${index + 1}`,
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

  function saveConfig() {
    localStorage.setItem(CONFIG_KEY, JSON.stringify(config));
    window.desktopApp?.database?.flush();
  }

  function toast(message, type = 'ok') {
    if (typeof window.toast === 'function') return window.toast(message, type);
    const target = q('#toast');
    if (!target) return;
    target.textContent = message;
    target.className = `toast show ${type === 'err' ? 'err' : 'ok'}`;
    clearTimeout(toast.timer);
    toast.timer = setTimeout(() => { target.className = 'toast'; }, 3600);
  }

  function country() { return window.currentCountry || 'ph'; }
  function selectedStoreId() { return session.storeId || window.selectedStoreId || state?.stores?.[0]?.id || 'default'; }
  function slotFor(kind) {
    return kind === 'store'
      ? `inventory-v15:${country()}:${selectedStoreId()}:store`
      : `inventory-v15:${country()}:shared:${kind}`;
  }

  function sourceLabel(kind) {
    return { store: '店铺库存表', mabang: '马帮库存表', combo: '组合拆分表' }[kind] || kind;
  }

  function sourceScope(kind) {
    if (kind === 'store') {
      const storeName = state?.stores?.find((store) => store.id === selectedStoreId())?.name || '当前店铺';
      return `${storeName} 独立保存`;
    }
    return `${country() === 'th' ? '泰国' : '菲律宾'}系统共享`;
  }

  function bytesToArrayBuffer(bytes) {
    if (bytes instanceof ArrayBuffer) return bytes.slice(0);
    if (ArrayBuffer.isView(bytes)) return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    return new Uint8Array(bytes || []).buffer;
  }

  function formatBytes(value) {
    const bytes = Number(value) || 0;
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  }

  function formatDate(value) {
    if (!value) return '';
    try { return new Date(value).toLocaleString('zh-CN'); } catch { return clean(value); }
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

  function findColumn(columns, guesses, strict = false) {
    for (const guess of guesses) {
      const expected = clean(guess).toLowerCase();
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
    } else if (savedColumn && columns.some((column) => String(column.c) === String(savedColumn))) {
      return String(savedColumn);
    }
    return findColumn(columns, guesses, true) || findColumn(columns, guesses);
  }

  function headerFor(columns, column) {
    return clean(columns?.find((item) => String(item.c) === String(column))?.h);
  }

  async function inspectWorkbook(buffer, kind) {
    const workbook = await openWorkbook(buffer.slice(0));
    let best = null;
    for (const definition of workbook.sheets.filter((sheet) => sheet.state === 'visible')) {
      const sheet = await getSheet(workbook, definition);
      for (let row = 1; row <= Math.min(sheet.maxRow, 25); row += 1) {
        const columns = [];
        for (let column = 1; column <= Math.min(sheet.maxCol, 200); column += 1) {
          columns.push({ c: column, h: clean(cellValue(sheet, row, column)) });
        }
        const skuScore = kind === 'store'
          ? (findColumn(columns, ['SellerSKU', '卖家SKU'], true) ? 15 : (findColumn(columns, ['SKU']) ? 7 : 0))
          : (findColumn(columns, ['库存SKU编号', 'SKU编号'], true) ? 15 : (findColumn(columns, ['SKU']) ? 7 : 0));
        const otherScore = kind === 'store'
          ? (findColumn(columns, ['库存']) ? 3 : 0) + (findColumn(columns, ['status', '状态']) ? 2 : 0)
          : (findColumn(columns, ['仓库']) ? 4 : 0) + (findColumn(columns, ['库存']) ? 4 : 0);
        const score = skuScore + otherScore;
        if (!best || score > best.score) best = { score, workbook, definition, sheet, row, columns };
      }
    }
    if (!best || best.score < 7) throw new Error(kind === 'store' ? '没有识别到店铺 SellerSKU 表头' : '没有识别到马帮库存 SKU 表头');
    const skuColumn = kind === 'store'
      ? (findColumn(best.columns, ['SellerSKU', '卖家SKU'], true) || findColumn(best.columns, ['SKU']))
      : (findColumn(best.columns, ['库存SKU编号', 'SKU编号'], true) || findColumn(best.columns, ['SKU']));
    best.dataStartRow = best.row + 1;
    if (skuColumn) {
      for (let row = best.row + 1; row <= best.sheet.maxRow; row += 1) {
        if (engine.parseSku(cellValue(best.sheet, row, Number(skuColumn))).kind !== 'invalid') {
          best.dataStartRow = row;
          break;
        }
      }
    }
    best.buffer = buffer.slice(0);
    best.valueCache = new Map();
    return best;
  }

  function normalizedHeader(value) {
    return clean(value).replace(/[\s_\-]+/g, '').toLowerCase();
  }

  async function inspectComboWorkbook(buffer) {
    const workbook = await openWorkbook(buffer.slice(0));
    let detected = null;
    for (const definition of workbook.sheets.filter((sheet) => sheet.state === 'visible')) {
      const sheet = await getSheet(workbook, definition);
      for (let row = 1; row <= Math.min(sheet.maxRow, 25); row += 1) {
        const headers = [];
        for (let column = 1; column <= Math.min(sheet.maxCol, 220); column += 1) headers.push(normalizedHeader(cellValue(sheet, row, column)));
        const comboColumn = headers.findIndex((header) => header === '组合sku编码' || header === '组合sku') + 1;
        const relationColumns = headers.map((header, index) => ({ header, column: index + 1 }))
          .filter((item) => /^关联sku编号\d*$/i.test(item.header));
        if (comboColumn && relationColumns.length) {
          detected = { workbook, definition, sheet, row, headers, comboColumn, relationColumns };
          break;
        }
      }
      if (detected) break;
    }
    if (!detected) throw new Error('组合拆分表必须包含“组合sku编码”和至少一列“关联sku编号”。');
    const quantityColumns = new Map();
    detected.headers.forEach((header, index) => {
      const match = header.match(/^关联sku捆绑数量(\d*)$/i);
      if (match) quantityColumns.set(match[1] || '1', index + 1);
    });
    const nameColumn = detected.headers.findIndex((header) => header === '组合sku中文名称' || header === '组合商品名称') + 1;
    const candidates = new Map();
    const invalidRows = [];
    let componentReferences = 0;
    for (let row = detected.row + 1; row <= detected.sheet.maxRow; row += 1) {
      const rawCombo = clean(cellValue(detected.sheet, row, detected.comboColumn));
      if (!rawCombo) continue;
      const comboInfo = engine.parseSku(rawCombo);
      if (comboInfo.kind !== 'combo') {
        invalidRows.push({ row, sku: rawCombo, reason: '组合 SKU 格式无效' });
        continue;
      }
      const components = [];
      let invalidReason = '';
      for (const relation of detected.relationColumns) {
        const rawComponent = clean(cellValue(detected.sheet, row, relation.column));
        if (!rawComponent) continue;
        const componentInfo = engine.parseSku(rawComponent);
        const suffix = relation.header.match(/(\d*)$/)?.[1] || '1';
        const quantityColumn = quantityColumns.get(suffix);
        const rawQuantity = quantityColumn ? cellValue(detected.sheet, row, quantityColumn) : 1;
        const quantity = clean(rawQuantity) === '' ? 1 : engine.number(rawQuantity);
        if (componentInfo.kind !== 'ordinary') {
          invalidReason = `组件 ${rawComponent} 不是有效的 11 位普通 SKU`;
          break;
        }
        if (!Number.isFinite(quantity) || quantity <= 0) {
          invalidReason = `组件 ${componentInfo.canonical} 的捆绑数量无效`;
          break;
        }
        components.push({ sku: componentInfo.canonical, quantity });
      }
      if (invalidReason || !components.length) {
        invalidRows.push({ row, sku: comboInfo.canonical, reason: invalidReason || '没有关联普通 SKU' });
        continue;
      }
      const merged = new Map();
      for (const component of components) merged.set(component.sku, (merged.get(component.sku) || 0) + component.quantity);
      const entry = {
        comboSku: comboInfo.canonical,
        name: nameColumn ? clean(cellValue(detected.sheet, row, nameColumn)) : '',
        components: [...merged].map(([sku, quantity]) => ({ sku, quantity })),
        sourceRow: row,
      };
      componentReferences += entry.components.length;
      if (!candidates.has(comboInfo.canonical)) candidates.set(comboInfo.canonical, []);
      candidates.get(comboInfo.canonical).push(entry);
    }
    const comboMap = new Map();
    const conflicts = [];
    const duplicates = [];
    for (const [sku, entries] of candidates) {
      const unique = new Map(entries.map((entry) => [JSON.stringify(entry.components), entry]));
      if (unique.size === 1) {
        comboMap.set(sku, [...unique.values()][0]);
        if (entries.length > 1) duplicates.push(...entries.slice(1).map((entry) => entry.sourceRow));
      } else {
        comboMap.set(sku, { conflict: true, components: [], reason: '组合拆分表中同一组合 SKU 存在不同拆分定义' });
        conflicts.push(sku);
      }
    }
    if (!comboMap.size && !invalidRows.length) throw new Error('组合拆分表中没有可用数据。');
    return {
      workbook,
      definition: detected.definition,
      sheet: detected.sheet,
      row: detected.row,
      buffer: buffer.slice(0),
      comboMap,
      invalidRows,
      conflicts,
      duplicates,
      componentReferences,
    };
  }

  function applySavedMappings(kind, data) {
    const columns = data.columns;
    if (kind === 'store') {
      config.storeSku = resolveColumn(columns, config.storeSku, config.storeSkuHeader, ['SellerSKU', '卖家SKU', 'SKU']);
      config.storeTitle = resolveColumn(columns, config.storeTitle, config.storeTitleHeader, ['商品标题', '产品名称', 'title']);
      config.storeStatus = resolveColumn(columns, config.storeStatus, config.storeStatusHeader, ['status', '商品状态', '状态']);
      config.storeSkuHeader = headerFor(columns, config.storeSku);
      config.storeTitleHeader = headerFor(columns, config.storeTitle);
      config.storeStatusHeader = headerFor(columns, config.storeStatus);
      for (const warehouse of config.warehouses) {
        warehouse.storeColumn = resolveColumn(columns, warehouse.storeColumn, warehouse.storeHeader, [warehouse.name]);
        warehouse.storeHeader = headerFor(columns, warehouse.storeColumn);
      }
    } else {
      config.mabangSku = resolveColumn(columns, config.mabangSku, config.mabangSkuHeader, ['库存SKU编号', 'SKU编号', 'SKU']);
      config.mabangName = resolveColumn(columns, config.mabangName, config.mabangNameHeader, ['中文名称', '商品名称', '产品名称']);
      config.mabangWarehouse = resolveColumn(columns, config.mabangWarehouse, config.mabangWarehouseHeader, ['仓库名称', '仓库']);
      config.mabangSkuHeader = headerFor(columns, config.mabangSku);
      config.mabangNameHeader = headerFor(columns, config.mabangName);
      config.mabangWarehouseHeader = headerFor(columns, config.mabangWarehouse);
      for (const warehouse of config.warehouses) {
        warehouse.mabangStockColumn = resolveColumn(columns, warehouse.mabangStockColumn, warehouse.mabangStockHeader, ['可用库存', '仓位库存', `${warehouse.name}库存`, '库存']);
        warehouse.mabangStockHeader = headerFor(columns, warehouse.mabangStockColumn);
      }
    }
    saveConfig();
  }

  function sourceStatusHtml(kind) {
    const source = session[kind];
    if (!source) return `<div class="inv15-source-empty"><b>尚未保存</b><span>${escapeHtml(sourceScope(kind))} · 上传后下次自动恢复</span></div>`;
    const details = kind === 'combo'
      ? `${source.comboMap.size} 个组合 · ${source.componentReferences} 个组件引用`
      : `${escapeHtml(source.definition.name)} · 表头第 ${source.row} 行 · 数据从第 ${source.dataStartRow || source.row + 1} 行开始 · ${source.sheet.maxRow} 行`;
    return `<div class="inv15-source-saved"><div><b>${escapeHtml(source.name)}</b><span>${details}</span></div><div><span>${formatBytes(source.size)}</span><span>${formatDate(source.updatedAt)}</span></div></div>`;
  }

  function renderSourceStatuses() {
    for (const kind of ['store', 'mabang', 'combo']) {
      const target = q(`#inv15${kind[0].toUpperCase()}${kind.slice(1)}Status`);
      if (target) target.innerHTML = sourceStatusHtml(kind);
      const clearButton = q(`[data-inv15-clear="${kind}"]`);
      if (clearButton) clearButton.disabled = !session[kind];
    }
    const ready = ['store', 'mabang', 'combo'].filter((kind) => session[kind]).length;
    const badge = q('#inv15KnowledgeReady');
    if (badge) {
      badge.textContent = `${ready} / 3 已就绪`;
      badge.className = `chip ${ready === 3 ? 'good' : 'warn'}`;
    }
    const button = q('#inv15Analyze');
    if (button) button.disabled = ready !== 3;
  }

  async function parseSource(kind, buffer) {
    return kind === 'combo' ? inspectComboWorkbook(buffer) : inspectWorkbook(buffer, kind);
  }

  async function saveSource(kind, file) {
    if (!file) return;
    const status = q(`#inv15${kind[0].toUpperCase()}${kind.slice(1)}Status`);
    const scrollTop = window.scrollY;
    if (status) status.innerHTML = '<div class="inv15-source-loading"><i></i><b>正在校验并保存到本机知识库…</b></div>';
    try {
      const buffer = await file.arrayBuffer();
      const parsed = await parseSource(kind, buffer);
      const record = await window.desktopApp.uploads.save(slotFor(kind), {
        name: file.name,
        type: file.type || MIME_XLSX,
        lastModified: file.lastModified || Date.now(),
      }, new Uint8Array(buffer));
      Object.assign(parsed, {
        name: file.name,
        type: file.type || MIME_XLSX,
        size: file.size,
        updatedAt: record?.updatedAt || new Date().toISOString(),
      });
      session[kind] = parsed;
      if (kind !== 'combo') applySavedMappings(kind, parsed);
      clearAnalysis();
      renderAllInventory();
      toast(`${sourceLabel(kind)}已更新并保存，下次打开自动恢复`, 'ok');
    } catch (error) {
      console.error(error);
      renderSourceStatuses();
      toast(`${sourceLabel(kind)}读取失败：${error.message}`, 'err');
    } finally {
      const input = q(`#inv15${kind[0].toUpperCase()}${kind.slice(1)}File`);
      if (input) { input.value = ''; input.blur(); }
      requestAnimationFrame(() => requestAnimationFrame(() => window.scrollTo({ top: scrollTop, left: 0, behavior: 'auto' })));
    }
  }

  async function restoreSource(kind, token = session.restoreToken) {
    try {
      const record = await window.desktopApp.uploads.read(slotFor(kind));
      if (token !== session.restoreToken) return;
      if (!record) {
        session[kind] = null;
        return;
      }
      const buffer = bytesToArrayBuffer(record.content);
      const parsed = await parseSource(kind, buffer);
      if (token !== session.restoreToken) return;
      Object.assign(parsed, {
        name: record.name,
        type: record.type || MIME_XLSX,
        size: record.size || buffer.byteLength,
        updatedAt: record.updatedAt,
      });
      session[kind] = parsed;
      if (kind !== 'combo') applySavedMappings(kind, parsed);
    } catch (error) {
      console.error(`Unable to restore inventory ${kind}:`, error);
      session[kind] = null;
      toast(`已保存的${sourceLabel(kind)}无法恢复：${error.message}`, 'err');
    }
  }

  async function restoreAllSources(options = {}) {
    const token = ++session.restoreToken;
    session.restoring = true;
    renderSourceStatuses();
    if (options.storeOnly) {
      session.store = null;
      await restoreSource('store', token);
    } else {
      session.store = null;
      session.mabang = null;
      session.combo = null;
      await Promise.all(['store', 'mabang', 'combo'].map((kind) => restoreSource(kind, token)));
    }
    if (token !== session.restoreToken) return;
    session.restoring = false;
    clearAnalysis();
    renderAllInventory();
  }

  async function clearSource(kind) {
    await window.desktopApp.uploads.remove(slotFor(kind));
    session[kind] = null;
    clearAnalysis();
    renderAllInventory();
    toast(`${sourceLabel(kind)}已从本机知识库清除`, 'ok');
  }

  function askClearSource(kind) {
    const action = () => clearSource(kind).catch((error) => toast(error.message, 'err'));
    if (typeof window.showModal === 'function') {
      window.showModal(`清除${sourceLabel(kind)}`, `<div class="callout danger"><strong>确认清除？</strong>只清除${escapeHtml(sourceScope(kind))}的缓存，不影响电脑中的原 Excel 文件。</div>`, action);
    } else action();
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
      if (values.size >= 500) break;
    }
    const result = [...values].sort((left, right) => left.localeCompare(right, 'zh-CN'));
    data.valueCache.set(column, result);
    return result;
  }

  function renderBaseMappings() {
    const storeColumns = session.store?.columns || [];
    const mabangColumns = session.mabang?.columns || [];
    const storeBox = q('#inv15StoreBaseMap');
    const mabangBox = q('#inv15MabangBaseMap');
    if (storeBox) storeBox.innerHTML = `
      <label>SellerSKU（必选）<select data-inv15-base="storeSku">${columnOptions(storeColumns, config.storeSku)}</select></label>
      <label>店铺商品标题<select data-inv15-base="storeTitle">${columnOptions(storeColumns, config.storeTitle)}</select></label>
      <label>Status 状态<select data-inv15-base="storeStatus">${columnOptions(storeColumns, config.storeStatus)}</select></label>`;
    if (mabangBox) mabangBox.innerHTML = `
      <label>库存 SKU 编号（必选）<select data-inv15-base="mabangSku">${columnOptions(mabangColumns, config.mabangSku)}</select></label>
      <label>马帮商品名称<select data-inv15-base="mabangName">${columnOptions(mabangColumns, config.mabangName)}</select></label>
      <label>马帮仓库名称列<select data-inv15-base="mabangWarehouse">${columnOptions(mabangColumns, config.mabangWarehouse, '不按仓库名称筛选')}</select></label>`;
  }

  function renderWarehouseManager() {
    const box = q('#inv15WarehouseList');
    if (!box) return;
    const storeColumns = session.store?.columns || [];
    const mabangColumns = session.mabang?.columns || [];
    q('#inv15WarehouseValues').innerHTML = distinctWarehouseValues().map((value) => `<option value="${escapeHtml(value)}"></option>`).join('');
    box.innerHTML = config.warehouses.length ? config.warehouses.map((warehouse) => `
      <div class="inv15-warehouse-row" data-warehouse-id="${escapeHtml(warehouse.id)}">
        <label>仓库显示名称<input data-inv15-warehouse-name value="${escapeHtml(warehouse.name)}" placeholder="例如：CFS"></label>
        <label>店铺库存列<select data-inv15-store-column>${columnOptions(storeColumns, warehouse.storeColumn)}</select></label>
        <label>马帮库存列<select data-inv15-mabang-stock>${columnOptions(mabangColumns, warehouse.mabangStockColumn)}</select></label>
        <label>马帮仓库名称关键字<input data-inv15-mabang-value list="inv15WarehouseValues" value="${escapeHtml(warehouse.mabangValue)}" placeholder="包含匹配，可用 | 分隔多个关键字"></label>
        <button class="btn danger sm" type="button" data-inv15-delete-warehouse>删除</button>
      </div>`).join('') : '<div class="inv15-empty">还没有仓库映射，请新增仓库。</div>';
    q('#inv15WarehouseCount').textContent = `${config.warehouses.length} 个仓库`;
  }

  function addWarehouse() {
    const id = `warehouse-${Date.now()}`;
    config.warehouses.push({ id, name: `新仓库 ${config.warehouses.length + 1}`, storeColumn: '', storeHeader: '', mabangStockColumn: '', mabangStockHeader: '', mabangValue: '' });
    saveConfig();
    renderWarehouseManager();
  }

  function deleteWarehouse(id) {
    const warehouse = config.warehouses.find((item) => item.id === id);
    config.warehouses = config.warehouses.filter((item) => item.id !== id);
    saveConfig();
    clearAnalysis();
    renderWarehouseManager();
    toast(`已删除仓库映射：${warehouse?.name || '未命名'}`, 'ok');
  }

  function updateWarehouse(element) {
    const row = element.closest('[data-warehouse-id]');
    const warehouse = config.warehouses.find((item) => item.id === row?.dataset.warehouseId);
    if (!warehouse) return;
    if (element.matches('[data-inv15-warehouse-name]')) warehouse.name = clean(element.value) || '未命名仓库';
    if (element.matches('[data-inv15-store-column]')) {
      warehouse.storeColumn = element.value;
      warehouse.storeHeader = headerFor(session.store?.columns, element.value);
    }
    if (element.matches('[data-inv15-mabang-stock]')) {
      warehouse.mabangStockColumn = element.value;
      warehouse.mabangStockHeader = headerFor(session.mabang?.columns, element.value);
    }
    if (element.matches('[data-inv15-mabang-value]')) warehouse.mabangValue = clean(element.value);
    saveConfig();
    clearAnalysis();
  }

  function updateBaseMapping(element) {
    const key = element.dataset.inv15Base;
    config[key] = element.value;
    const columns = key.startsWith('store') ? session.store?.columns : session.mabang?.columns;
    config[`${key}Header`] = headerFor(columns, element.value);
    if (key === 'mabangWarehouse' && session.mabang) session.mabang.valueCache.clear();
    saveConfig();
    clearAnalysis();
    if (key === 'mabangWarehouse') renderWarehouseManager();
  }

  function mappedWarehouses() {
    return config.warehouses.filter((warehouse) => warehouse.storeColumn && warehouse.mabangStockColumn);
  }

  function normalizedWarehouseValues(value) {
    return clean(value).toLowerCase().split(/[|,，;；]+/).map((item) => item.trim()).filter(Boolean);
  }

  function readMabangRows(warehouses) {
    const data = session.mabang;
    if (!config.mabangSku) throw new Error('马帮库存表必须选择库存 SKU 编号列');
    const rows = [];
    for (let row = data.dataStartRow || data.row + 1; row <= data.sheet.maxRow; row += 1) {
      const sku = clean(cellValue(data.sheet, row, Number(config.mabangSku)));
      if (!sku) continue;
      const name = config.mabangName ? clean(cellValue(data.sheet, row, Number(config.mabangName))) : '';
      const warehouseName = config.mabangWarehouse ? clean(cellValue(data.sheet, row, Number(config.mabangWarehouse))).toLowerCase() : '';
      const stocks = {};
      for (const warehouse of warehouses) {
        const accepted = normalizedWarehouseValues(warehouse.mabangValue);
        stocks[warehouse.id] = !engine.warehouseNameMatches(warehouseName, accepted)
          ? 0
          : engine.number(cellValue(data.sheet, row, Number(warehouse.mabangStockColumn)));
      }
      rows.push({ row, sku, name, stocks });
    }
    return rows;
  }

  function readStoreRows(warehouses) {
    const data = session.store;
    if (!config.storeSku) throw new Error('店铺库存表必须选择 SellerSKU 列');
    const rows = [];
    for (let row = data.dataStartRow || data.row + 1; row <= data.sheet.maxRow; row += 1) {
      const sku = clean(cellValue(data.sheet, row, Number(config.storeSku)));
      if (!sku) continue;
      const stocks = Object.fromEntries(warehouses.map((warehouse) => [warehouse.id, cellValue(data.sheet, row, Number(warehouse.storeColumn))]));
      rows.push({
        row,
        sku,
        title: config.storeTitle ? clean(cellValue(data.sheet, row, Number(config.storeTitle))) : '',
        status: config.storeStatus ? clean(cellValue(data.sheet, row, Number(config.storeStatus))) : '',
        stocks,
      });
    }
    return rows;
  }

  function clearAnalysis() {
    session.results = [];
    session.audit = null;
    session.visibleLimit = 200;
    const list = q('#inv15ResultList');
    if (list) list.innerHTML = '<div class="inv15-empty">三个知识库就绪后，点击“执行 V15 库存识别”。</div>';
    if (q('#inv15Metrics')) q('#inv15Metrics').innerHTML = '';
    if (q('#inv15ResultCount')) q('#inv15ResultCount').textContent = '尚未分析';
    if (q('#inv15Audit')) q('#inv15Audit').innerHTML = '';
  }

  async function analyzeInventory() {
    if (!session.store || !session.mabang || !session.combo) return toast('请先让三个表格知识库全部就绪', 'err');
    const warehouses = mappedWarehouses();
    if (!warehouses.length) return toast('请至少完成一个仓库的店铺列与马帮列映射', 'err');
    const button = q('#inv15Analyze');
    button.disabled = true;
    button.textContent = '正在执行规则并复核…';
    await new Promise((resolve) => requestAnimationFrame(resolve));
    try {
      config.threshold = Math.max(0, engine.number(q('#inv15Threshold').value || 30));
      config.overflowValue = Math.max(1, engine.number(q('#inv15Overflow').value || 9999));
      saveConfig();
      const analysis = engine.analyze({
        storeRows: readStoreRows(warehouses),
        mabangRows: readMabangRows(warehouses),
        comboMap: session.combo.comboMap,
        warehouses,
        threshold: config.threshold,
        overflowValue: config.overflowValue,
      });
      session.results = analysis.results;
      session.audit = analysis.audit;
      session.visibleLimit = 200;
      renderResults();
      toast(`识别完成：${analysis.audit.changedRows} 行将更新，${analysis.audit.unresolvedRows} 行需人工处理`, analysis.audit.ok ? 'ok' : 'err');
    } catch (error) {
      console.error(error);
      toast(`库存识别失败：${error.message}`, 'err');
    } finally {
      button.textContent = '执行 V15 库存识别';
      renderSourceStatuses();
    }
  }

  const FLOW_LABELS = {
    flow1_original_warehouse: '流程一 · 原仓有货',
    flow2_same_sku_other_warehouse: '流程二 · 同 SKU 转仓',
    flow3_same_product_replacement: '流程三 · 同款换 SKU',
    combo_healthy: '组合组件有货',
    manual_combo_component_stock: '组合组件缺货',
    manual_combo_definition: '组合定义异常',
    manual_multi_store_warehouse: '店铺多仓异常',
    manual_no_stock: '全仓无货',
    manual_invalid_sku: 'SKU 格式异常',
    unchanged: '保持原样',
  };

  function tagHtml(tag) {
    const type = tag === engine.TAGS.ANOMALY ? 'danger' : tag === engine.TAGS.UNLISTED ? 'blue' : 'warn';
    return `<span class="chip ${type}">${escapeHtml(tag)}</span>`;
  }

  function stockText(stocks, warehouses) {
    return warehouses.map((warehouse) => {
      const value = stocks?.[warehouse.id];
      const display = value === null || value === '' || value === undefined ? '空' : engine.number(value);
      const active = engine.number(value) > 0 ? 'active' : '';
      return `<span class="inv15-stock-pill ${active}"><i>${escapeHtml(warehouse.name)}</i><b>${display}</b></span>`;
    }).join('');
  }

  function resultMatchesFilter(result) {
    if (session.filter === 'changed') return result.changed;
    if (session.filter === 'manual') return result.manual;
    if (session.filter === 'presale') return result.tags.includes(engine.TAGS.PRESALE);
    if (session.filter === 'anomaly') return result.tags.includes(engine.TAGS.ANOMALY);
    if (session.filter === 'unlisted') return result.tags.includes(engine.TAGS.UNLISTED);
    if (session.filter === 'combo') return result.kind === 'combo';
    if (session.filter.startsWith('flow')) return result.flow === session.filter;
    return true;
  }

  function filteredResults() {
    const query = session.query.toLowerCase();
    return session.results.filter((result) => {
      const text = `${result.originalSku} ${result.finalSku} ${result.title} ${result.mabangName} ${result.reasons.join(' ')}`.toLowerCase();
      const queryMatch = window.__fuzzySearchV14?.matches
        ? window.__fuzzySearchV14.matches(text, query, 'inventoryV15Search')
        : (!query || text.includes(query));
      return queryMatch && resultMatchesFilter(result);
    }).sort((left, right) => (
      Number(right.manual) - Number(left.manual)
      || Number(right.changed) - Number(left.changed)
      || left.row - right.row
    ));
  }

  function resultCounts() {
    return {
      all: session.results.length,
      changed: session.results.filter((item) => item.changed).length,
      flow1: session.results.filter((item) => item.flow === 'flow1_original_warehouse').length,
      flow2: session.results.filter((item) => item.flow === 'flow2_same_sku_other_warehouse').length,
      flow3: session.results.filter((item) => item.flow === 'flow3_same_product_replacement').length,
      manual: session.results.filter((item) => item.manual).length,
      presale: session.results.filter((item) => item.tags.includes(engine.TAGS.PRESALE)).length,
      anomaly: session.results.filter((item) => item.tags.includes(engine.TAGS.ANOMALY)).length,
      unlisted: session.results.filter((item) => item.tags.includes(engine.TAGS.UNLISTED)).length,
      combo: session.results.filter((item) => item.kind === 'combo').length,
    };
  }

  function metricButton(filter, label, value, tone = '') {
    return `<button class="inv15-metric ${tone} ${session.filter === filter ? 'active' : ''}" data-inv15-filter="${filter}"><span>${label}</span><b>${value}</b></button>`;
  }

  function resultRowHtml(result, warehouses) {
    const tags = result.tags.length ? result.tags.map(tagHtml).join('') : '<span class="chip good">自动通过</span>';
    const skuChange = result.finalSku !== result.originalSku
      ? `<code>${escapeHtml(result.originalSku)}</code><span class="inv15-arrow">→</span><code class="changed">${escapeHtml(result.finalSku)}</code>`
      : `<code>${escapeHtml(result.originalSku)}</code>`;
    const title = result.title || '店铺表未提供标题';
    const mabang = result.mabangName ? `<small>马帮：${escapeHtml(result.mabangName)}</small>` : '<small>马帮：无名称或未匹配</small>';
    const components = result.componentChecks.length
      ? `<div class="inv15-components">${result.componentChecks.map((item) => `<span class="${item.ok ? 'ok' : 'bad'}">${escapeHtml(item.sku)} · ${item.available}/${item.quantity}</span>`).join('')}</div>`
      : '';
    return `<article class="inv15-result ${result.manual ? 'manual' : result.changed ? 'changed' : 'clean'}">
      <div class="inv15-result-top">
        <div class="inv15-tags">${tags}<span class="chip muted">${escapeHtml(FLOW_LABELS[result.flow] || result.flow)}</span></div>
        <span class="inv15-row-number">原表第 ${result.row} 行</span>
      </div>
      <div class="inv15-result-grid">
        <div class="inv15-result-cell sku"><label>SellerSKU</label><div class="inv15-sku-change">${skuChange}</div><p>${escapeHtml(title)}</p>${mabang}</div>
        <div class="inv15-result-cell"><label>店铺原库存</label><div class="inv15-stock-stack">${stockText(result.originalStocks, warehouses)}</div></div>
        <div class="inv15-result-cell"><label>最终写入库存</label><div class="inv15-stock-stack">${stockText(result.finalStocks, warehouses)}</div></div>
        <div class="inv15-result-cell reason"><label>判定明细</label><div>${result.reasons.map((reason) => `<p>• ${escapeHtml(reason)}</p>`).join('')}</div>${components}</div>
      </div>
    </article>`;
  }

  function renderResults() {
    if (!session.results.length) return clearAnalysis();
    const warehouses = mappedWarehouses();
    const counts = resultCounts();
    q('#inv15Metrics').innerHTML = [
      metricButton('all', '全部 SKU', counts.all),
      metricButton('changed', '自动更新', counts.changed, 'good'),
      metricButton('flow1_original_warehouse', '流程一', counts.flow1),
      metricButton('flow2_same_sku_other_warehouse', '流程二', counts.flow2),
      metricButton('flow3_same_product_replacement', '流程三', counts.flow3),
      metricButton('manual', '人工处理', counts.manual, 'danger'),
      metricButton('presale', '预售', counts.presale, 'warn'),
      metricButton('anomaly', '异常', counts.anomaly, 'danger'),
      metricButton('unlisted', '未上架', counts.unlisted, 'blue'),
      metricButton('combo', '组合 SKU', counts.combo),
    ].join('');
    const filtered = filteredResults();
    const visible = filtered.slice(0, session.visibleLimit);
    q('#inv15ResultCount').textContent = `当前 ${filtered.length} / 全部 ${session.results.length}`;
    q('#inv15ResultList').innerHTML = visible.length ? visible.map((result) => resultRowHtml(result, warehouses)).join('') : '<div class="inv15-empty">当前筛选没有结果。</div>';
    q('#inv15More').innerHTML = filtered.length > visible.length ? `<button class="btn light" id="inv15MoreButton">继续显示 ${Math.min(200, filtered.length - visible.length)} 条</button>` : '';
    q('#inv15MoreButton')?.addEventListener('click', () => { session.visibleLimit += 200; renderResults(); });
    const audit = session.audit;
    q('#inv15Audit').innerHTML = audit?.ok
      ? `<div class="inv15-audit good"><b>✓ 最终规则复核通过</b><span>${audit.changedRows} 行自动更新；${audit.unresolvedRows} 行保持原样并进入人工名单；导出时还会重新读取成品 Excel 验证格式。</span></div>`
      : `<div class="inv15-audit danger"><b>最终规则复核未通过</b><span>${audit?.failures?.map((item) => `第${item.row}行：${item.reason}`).join('；') || '未知错误'}</span></div>`;
    q('#inv15ExportWorkbook').disabled = !audit?.ok;
    q('#inv15ExportManual').disabled = !counts.manual;
  }

  function quoteCsv(value) {
    return `"${String(value ?? '').replaceAll('"', '""')}"`;
  }

  function exportManualList() {
    const warehouses = mappedWarehouses();
    const rows = session.results.filter((result) => result.manual);
    if (!rows.length) return toast('当前没有需人工处理的 SKU', 'err');
    const headers = ['原表行号', '标签', '原SellerSKU', '最终SellerSKU', '店铺标题', '马帮商品名称', 'Status', '处理流程', '原库存', '最终库存', '原因'];
    const lines = rows.map((result) => [
      result.row,
      result.tags.join('|'),
      result.originalSku,
      result.finalSku,
      result.title,
      result.mabangName,
      result.status,
      FLOW_LABELS[result.flow] || result.flow,
      warehouses.map((warehouse) => `${warehouse.name}:${result.originalStocks[warehouse.id] ?? ''}`).join('|'),
      warehouses.map((warehouse) => `${warehouse.name}:${result.finalStocks[warehouse.id] ?? ''}`).join('|'),
      result.reasons.join('；'),
    ].map(quoteCsv).join(','));
    const blob = new Blob([`\ufeff${headers.map(quoteCsv).join(',')}\r\n${lines.join('\r\n')}`], { type: 'text/csv;charset=utf-8' });
    const storeName = state?.stores?.find((store) => store.id === selectedStoreId())?.name || '店铺';
    downloadBlob(blob, `${storeName}_V15库存人工处理名单_${new Date().toISOString().slice(0, 10)}.csv`);
  }

  async function prepareInventoryStyles(workbook) {
    if (workbook.inventoryStyleContext) return workbook.inventoryStyleContext;
    const path = 'xl/styles.xml';
    const file = workbook.zip.file(path);
    if (!file) {
      workbook.inventoryStyleContext = { path, doc: null, cellXfs: null, cache: new Map(), dirty: false };
      return workbook.inventoryStyleContext;
    }
    const doc = parseXml(await file.async('string'));
    const cellXfs = doc.getElementsByTagNameNS('*', 'cellXfs')[0] || null;
    workbook.inventoryStyleContext = { path, doc, cellXfs, cache: new Map(), dirty: false };
    return workbook.inventoryStyleContext;
  }

  function inventoryStyleIndex(workbook, baseIndex, kind) {
    const context = workbook.inventoryStyleContext;
    if (!context?.cellXfs) return null;
    const safeBase = Number.isFinite(Number(baseIndex)) ? Number(baseIndex) : 0;
    const formatId = kind === 'text' ? '49' : '1';
    const key = `${safeBase}:${formatId}`;
    if (context.cache.has(key)) return context.cache.get(key);
    const styles = [...context.cellXfs.children].filter((node) => node.localName === 'xf');
    const base = styles[safeBase] || styles[0];
    if (!base) return null;
    if (base.getAttribute('numFmtId') === formatId) {
      context.cache.set(key, safeBase);
      return safeBase;
    }
    const style = base.cloneNode(true);
    style.setAttribute('numFmtId', formatId);
    style.setAttribute('applyNumberFormat', '1');
    context.cellXfs.appendChild(style);
    const index = [...context.cellXfs.children].filter((node) => node.localName === 'xf').length - 1;
    context.cellXfs.setAttribute('count', String(index + 1));
    context.cache.set(key, index);
    context.dirty = true;
    return index;
  }

  function flushInventoryStyles(workbook) {
    const context = workbook.inventoryStyleContext;
    if (context?.dirty && context.doc) workbook.zip.file(context.path, serializeXml(context.doc));
  }

  function inv15FindRow(sheet, rowNumber) {
    return [...sheet.doc.getElementsByTagNameNS('*', 'row')].find((row) => Number(row.getAttribute('r')) === Number(rowNumber)) || null;
  }

  function inv15FindCell(row, columnNumber) {
    const reference = `${colLetters(columnNumber)}${row.getAttribute('r')}`;
    return [...row.getElementsByTagNameNS('*', 'c')].find((cell) => cell.getAttribute('r') === reference) || null;
  }

  function inv15EnsureCell(sheet, rowNumber, columnNumber) {
    let row = inv15FindRow(sheet, rowNumber);
    const sheetData = sheet.doc.getElementsByTagNameNS('*', 'sheetData')[0];
    if (!row) {
      row = sheet.doc.createElementNS(NS, 'row');
      row.setAttribute('r', String(rowNumber));
      const beforeRow = [...sheetData.children].find((item) => item.localName === 'row' && Number(item.getAttribute('r')) > rowNumber);
      beforeRow ? sheetData.insertBefore(row, beforeRow) : sheetData.appendChild(row);
    }
    let cell = inv15FindCell(row, columnNumber);
    if (!cell) {
      cell = sheet.doc.createElementNS(NS, 'c');
      cell.setAttribute('r', `${colLetters(columnNumber)}${rowNumber}`);
      const beforeCell = [...row.getElementsByTagNameNS('*', 'c')].find((item) => colNum(item.getAttribute('r')) > columnNumber);
      beforeCell ? row.insertBefore(cell, beforeCell) : row.appendChild(cell);
    }
    return { row, cell };
  }

  function clearCellContent(cell) {
    for (const child of [...cell.childNodes]) {
      if (child.nodeType === 1 && ['v', 'f', 'is'].includes(child.localName)) cell.removeChild(child);
    }
  }

  function setInventoryTextCell(workbook, sheet, rowNumber, columnNumber, value) {
    const { cell } = inv15EnsureCell(sheet, rowNumber, columnNumber);
    const baseStyle = Number(cell.getAttribute('s') || 0);
    clearCellContent(cell);
    cell.setAttribute('t', 'inlineStr');
    const inline = sheet.doc.createElementNS(NS, 'is');
    const text = sheet.doc.createElementNS(NS, 't');
    text.setAttributeNS('http://www.w3.org/XML/1998/namespace', 'xml:space', 'preserve');
    text.textContent = clean(value);
    inline.appendChild(text);
    cell.appendChild(inline);
    const style = inventoryStyleIndex(workbook, baseStyle, 'text');
    if (style !== null) cell.setAttribute('s', String(style));
  }

  function setInventoryNumberCell(workbook, sheet, rowNumber, columnNumber, value) {
    const { cell } = inv15EnsureCell(sheet, rowNumber, columnNumber);
    const baseStyle = Number(cell.getAttribute('s') || 0);
    clearCellContent(cell);
    cell.removeAttribute('t');
    if (value === null || value === undefined || value === '') return;
    const parsed = engine.number(value);
    if (!Number.isFinite(parsed)) throw new Error(`第 ${rowNumber} 行库存不是有效数字`);
    const valueNode = sheet.doc.createElementNS(NS, 'v');
    valueNode.textContent = String(parsed);
    cell.appendChild(valueNode);
    const style = inventoryStyleIndex(workbook, baseStyle, 'number');
    if (style !== null) cell.setAttribute('s', String(style));
  }

  async function buildInventoryWorkbook() {
    const warehouses = mappedWarehouses();
    const workbook = await openWorkbook(session.store.buffer.slice(0));
    await prepareInventoryStyles(workbook);
    const definition = workbook.sheets.find((item) => item.path === session.store.definition.path);
    if (!definition) throw new Error('导出时找不到原店铺工作表');
    const sheet = await getSheet(workbook, definition);
    for (const result of session.results) {
      setInventoryTextCell(workbook, sheet, result.row, Number(config.storeSku), result.finalSku);
      if (config.storeStatus) setInventoryTextCell(workbook, sheet, result.row, Number(config.storeStatus), result.status);
      for (const warehouse of warehouses) {
        setInventoryNumberCell(workbook, sheet, result.row, Number(warehouse.storeColumn), result.finalStocks[warehouse.id]);
      }
    }
    workbook.zip.file(definition.path, serializeXml(sheet.doc));
    flushInventoryStyles(workbook);
    const buffer = await workbook.zip.generateAsync({ type: 'arraybuffer', compression: 'DEFLATE', compressionOptions: { level: 6 } });
    await verifyInventoryWorkbook(buffer, warehouses);
    return new Blob([buffer], { type: MIME_XLSX });
  }

  async function verifyInventoryWorkbook(buffer, warehouses) {
    const workbook = await openWorkbook(buffer.slice(0));
    const definition = workbook.sheets.find((item) => item.path === session.store.definition.path);
    const sheet = await getSheet(workbook, definition);
    const failures = [];
    for (const result of session.results) {
      if (clean(cellValue(sheet, result.row, Number(config.storeSku))) !== result.finalSku) failures.push(`第${result.row}行 SellerSKU`);
      const rowNode = inv15FindRow(sheet, result.row);
      const skuCell = rowNode && inv15FindCell(rowNode, Number(config.storeSku));
      if (skuCell?.getAttribute('t') !== 'inlineStr') failures.push(`第${result.row}行 SellerSKU 文本格式`);
      if (config.storeStatus) {
        const statusCell = rowNode && inv15FindCell(rowNode, Number(config.storeStatus));
        if (statusCell?.getAttribute('t') !== 'inlineStr') failures.push(`第${result.row}行 Status 文本格式`);
      }
      for (const warehouse of warehouses) {
        const expected = result.finalStocks[warehouse.id];
        const actual = cellValue(sheet, result.row, Number(warehouse.storeColumn));
        if (expected === null || expected === undefined || expected === '') {
          if (actual !== null && clean(actual) !== '') failures.push(`第${result.row}行 ${warehouse.name} 应为空`);
        } else if (engine.number(actual) !== engine.number(expected)) failures.push(`第${result.row}行 ${warehouse.name} 库存`);
        const stockCell = rowNode && inv15FindCell(rowNode, Number(warehouse.storeColumn));
        if (expected !== null && expected !== undefined && expected !== '' && stockCell?.hasAttribute('t')) failures.push(`第${result.row}行 ${warehouse.name} 数字格式`);
      }
    }
    if (failures.length) throw new Error(`成品 Excel 二次识别失败：${failures.slice(0, 8).join('、')}${failures.length > 8 ? `等 ${failures.length} 项` : ''}`);
    return { ok: true, checkedRows: session.results.length };
  }

  async function exportInventoryWorkbook() {
    if (session.exporting) return;
    if (!session.audit?.ok || !session.results.length) return toast('请先完成库存识别与最终规则复核', 'err');
    session.exporting = true;
    const button = q('#inv15ExportWorkbook');
    button.disabled = true;
    button.textContent = '正在生成并二次识别…';
    try {
      const blob = await buildInventoryWorkbook();
      const storeName = state?.stores?.find((store) => store.id === selectedStoreId())?.name || '店铺';
      const filename = `${storeName}_V15库存更新_${new Date().toISOString().slice(0, 10)}.xlsx`;
      downloadBlob(blob, filename);
      toast(`已生成 ${filename}；原模板结构保留，成品二次识别通过`, 'ok');
    } catch (error) {
      console.error(error);
      toast(`导出已阻止：${error.message}`, 'err');
    } finally {
      session.exporting = false;
      button.textContent = '导出最终店铺库存表';
      button.disabled = !session.audit?.ok;
    }
  }

  function populateStores() {
    const select = q('#inv15StoreSelect');
    if (!select) return;
    const stores = state?.stores || [];
    const previous = session.storeId || select.value || window.selectedStoreId;
    select.innerHTML = stores.map((store) => `<option value="${escapeHtml(store.id)}">${escapeHtml(store.name)}${store.active === false ? '（已停用）' : ''}</option>`).join('');
    if (stores.some((store) => store.id === previous)) select.value = previous;
    session.storeId = select.value || stores[0]?.id || '';
  }

  function renderComboSummary() {
    const target = q('#inv15ComboSummary');
    if (!target) return;
    if (!session.combo) {
      target.innerHTML = '<span>组合表上传后自动识别“组合sku编码、关联sku编号、捆绑数量”。</span>';
      return;
    }
    target.innerHTML = `<span>有效组合 <b>${session.combo.comboMap.size}</b></span><span>组件引用 <b>${session.combo.componentReferences}</b></span><span>无效行 <b>${session.combo.invalidRows.length}</b></span><span>冲突组合 <b>${session.combo.conflicts.length}</b></span>`;
  }

  function renderAllInventory() {
    renderSourceStatuses();
    renderBaseMappings();
    renderWarehouseManager();
    renderComboSummary();
    const threshold = q('#inv15Threshold');
    const overflow = q('#inv15Overflow');
    if (threshold && document.activeElement !== threshold) threshold.value = String(config.threshold);
    if (overflow && document.activeElement !== overflow) overflow.value = String(config.overflowValue);
    if (session.results.length) renderResults();
  }

  function installPage() {
    const page = q('#page-inventory');
    if (!page) throw new Error('库存识别页面不存在');
    page.className = 'page inv15-page';
    page.innerHTML = `
      <section class="inv15-hero">
        <div class="inv15-hero-copy">
          <div class="eyebrow">Inventory knowledge workspace · V15</div>
          <h2>三表库存知识库</h2>
          <p>店铺库存、马帮库存和组合拆分表独立保存、独立更新。规则引擎按原仓、转仓、同款换 SKU 的顺序处理普通商品，并对组合组件、多仓异常和 Inactive 商品进行安全拦截。</p>
          <div class="inv15-hero-badges"><span class="chip good">本机 SQLite</span><span class="chip blue">原格式 Excel</span><span class="chip warn">二次成品复核</span></div>
        </div>
        <div class="inv15-hero-state"><span>Knowledge base</span><b id="inv15KnowledgeReady">0 / 3 已就绪</b><small>关闭软件后仍保留</small></div>
      </section>

      <section class="inv15-sources">
        <article class="inv15-source-card store">
          <div class="inv15-source-head"><span>01</span><div><h3>店铺库存表</h3><p id="inv15StoreScope">当前店铺独立保存</p></div></div>
          <label class="inv15-drop"><input id="inv15StoreFile" data-clear-installed="1" type="file" accept=".xlsx,.xlsm"><b>上传或更新表 1</b><span>保留为最终导出的原始模板</span></label>
          <button class="inv15-clear" type="button" data-inv15-clear="store">清除已保存表 1</button>
          <div id="inv15StoreStatus"></div>
          <details class="inv15-map"><summary>店铺基础列设置</summary><div class="inv15-map-grid" id="inv15StoreBaseMap"></div></details>
        </article>

        <article class="inv15-source-card mabang">
          <div class="inv15-source-head"><span>02</span><div><h3>马帮库存表</h3><p>当前国家系统共享保存</p></div></div>
          <label class="inv15-drop"><input id="inv15MabangFile" data-clear-installed="1" type="file" accept=".xlsx,.xlsm"><b>上传或更新表 2</b><span>读取普通 SKU、仓库和可用库存</span></label>
          <button class="inv15-clear" type="button" data-inv15-clear="mabang">清除已保存表 2</button>
          <div id="inv15MabangStatus"></div>
          <details class="inv15-map"><summary>马帮基础列设置</summary><div class="inv15-map-grid" id="inv15MabangBaseMap"></div></details>
        </article>

        <article class="inv15-source-card combo">
          <div class="inv15-source-head"><span>03</span><div><h3>组合拆分表</h3><p>当前国家系统共享保存</p></div></div>
          <label class="inv15-drop"><input id="inv15ComboFile" data-clear-installed="1" type="file" accept=".xlsx,.xlsm"><b>上传或更新表 3</b><span>自动读取组合及多个普通 SKU 组件</span></label>
          <button class="inv15-clear" type="button" data-inv15-clear="combo">清除已保存表 3</button>
          <div id="inv15ComboStatus"></div>
          <div class="inv15-combo-summary" id="inv15ComboSummary"></div>
        </article>
      </section>

      <section class="inv15-panel inv15-mapping-panel">
        <div class="inv15-panel-head">
          <div><div class="eyebrow">Warehouse mapping</div><h3>仓库与库存列对应</h3><p>马帮仓库按名称关键字包含匹配，可用“|”或逗号填写多个关键字；例如“CFS”可匹配“菲律宾CFS-HB仓-1308”。同一 SKU 在多个马帮仓库有货时只选择可用库存最多的仓库。</p></div>
          <div class="inv15-panel-actions"><span class="chip muted" id="inv15WarehouseCount">2 个仓库</span><button class="btn primary sm" id="inv15AddWarehouse" type="button">＋ 新增仓库</button></div>
        </div>
        <datalist id="inv15WarehouseValues"></datalist>
        <div id="inv15WarehouseList" class="inv15-warehouse-list"></div>
      </section>

      <section class="inv15-command">
        <div class="inv15-command-inputs">
          <label>分析店铺<select id="inv15StoreSelect"></select></label>
          <label>库存阈值<input id="inv15Threshold" type="number" min="0" value="30"></label>
          <label>超过阈值写入<input id="inv15Overflow" type="number" min="1" value="9999"></label>
        </div>
        <button class="inv15-run" id="inv15Analyze" type="button">执行 V15 库存识别</button>
        <div class="inv15-command-note"><b>严格顺序</b><span>原仓有货 → 同 SKU 转仓 → 后四位同款换 SKU → 保持原样并进入人工名单</span></div>
      </section>

      <section class="inv15-panel inv15-results-panel">
        <div class="inv15-panel-head results">
          <div><div class="eyebrow">Final inventory review</div><h3>最终库存结果与人工处理名单</h3><p>“预售 / 异常 / 未上架”标签只进入人工名单，不会擅自添加到原 Excel 列中。</p></div>
          <div class="inv15-panel-actions"><button class="btn light" id="inv15ExportManual" disabled>导出人工处理名单</button><button class="btn primary" id="inv15ExportWorkbook" disabled>导出最终店铺库存表</button></div>
        </div>
        <div id="inv15Audit"></div>
        <div class="inv15-metrics" id="inv15Metrics"></div>
        <div class="inv15-toolbar">
          <input id="inv15Search" placeholder="搜索 SKU、店铺标题、马帮商品或原因">
          <select id="inv15Filter">
            <option value="all">全部结果</option>
            <option value="changed">只看自动更新</option>
            <option value="flow1_original_warehouse">流程一 · 原仓有货</option>
            <option value="flow2_same_sku_other_warehouse">流程二 · 同 SKU 转仓</option>
            <option value="flow3_same_product_replacement">流程三 · 同款换 SKU</option>
            <option value="manual">全部人工处理</option>
            <option value="presale">预售标签</option>
            <option value="anomaly">异常标签</option>
            <option value="unlisted">未上架标签</option>
            <option value="combo">组合 SKU</option>
          </select>
          <span id="inv15ResultCount">尚未分析</span>
        </div>
        <div id="inv15ResultList" class="inv15-result-list"><div class="inv15-empty">三个知识库就绪后，点击“执行 V15 库存识别”。</div></div>
        <div id="inv15More" class="inv15-more"></div>
      </section>`;

    populateStores();
    q('#inv15StoreScope').textContent = sourceScope('store');
    q('#inv15Threshold').value = String(config.threshold);
    q('#inv15Overflow').value = String(config.overflowValue);
    q('#inv15StoreFile').addEventListener('change', (event) => saveSource('store', event.target.files?.[0]));
    q('#inv15MabangFile').addEventListener('change', (event) => saveSource('mabang', event.target.files?.[0]));
    q('#inv15ComboFile').addEventListener('change', (event) => saveSource('combo', event.target.files?.[0]));
    qa('[data-inv15-clear]').forEach((button) => button.addEventListener('click', () => askClearSource(button.dataset.inv15Clear)));
    q('#inv15AddWarehouse').addEventListener('click', addWarehouse);
    q('#inv15Analyze').addEventListener('click', analyzeInventory);
    q('#inv15ExportManual').addEventListener('click', exportManualList);
    q('#inv15ExportWorkbook').addEventListener('click', exportInventoryWorkbook);
    q('#inv15StoreSelect').addEventListener('change', async (event) => {
      session.storeId = event.target.value;
      window.selectedStoreId = session.storeId;
      q('#inv15StoreScope').textContent = sourceScope('store');
      await restoreAllSources({ storeOnly: true });
    });
    q('#inv15Threshold').addEventListener('change', (event) => { config.threshold = Math.max(0, engine.number(event.target.value)); saveConfig(); clearAnalysis(); });
    q('#inv15Overflow').addEventListener('change', (event) => { config.overflowValue = Math.max(1, engine.number(event.target.value)); saveConfig(); clearAnalysis(); });
    q('#inv15Filter').addEventListener('change', (event) => { session.filter = event.target.value; session.visibleLimit = 200; renderResults(); });
    let searchTimer;
    q('#inv15Search').addEventListener('input', (event) => {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(() => { session.query = clean(event.target.value); session.visibleLimit = 200; renderResults(); }, 140);
    });
    page.addEventListener('change', (event) => {
      const target = event.target;
      if (target.matches('[data-inv15-base]')) updateBaseMapping(target);
      if (target.matches('[data-inv15-warehouse-name],[data-inv15-store-column],[data-inv15-mabang-stock],[data-inv15-mabang-value]')) updateWarehouse(target);
    });
    page.addEventListener('click', (event) => {
      const deleteButton = event.target.closest('[data-inv15-delete-warehouse]');
      if (deleteButton) deleteWarehouse(deleteButton.closest('[data-warehouse-id]').dataset.warehouseId);
      const metric = event.target.closest('[data-inv15-filter]');
      if (metric) {
        session.filter = metric.dataset.inv15Filter;
        q('#inv15Filter').value = session.filter;
        session.visibleLimit = 200;
        renderResults();
      }
    });

    qa('#countrySwitch [data-country]').forEach((button) => button.addEventListener('click', () => setTimeout(() => {
      populateStores();
      q('#inv15StoreScope').textContent = sourceScope('store');
      restoreAllSources();
    }, 100)));
    q('#nav [data-page="inventory"]')?.addEventListener('click', () => setTimeout(populateStores, 0));
    window.addEventListener('stores-changed-v14', (event) => {
      const requested = clean(event.detail?.selectedStoreId);
      if ((state?.stores || []).some((store) => store.id === requested)) session.storeId = requested;
      populateStores();
    });

    renderAllInventory();
    restoreAllSources();
  }

  function refreshStores() {
    const previous = selectedStoreId();
    populateStores();
    if (selectedStoreId() !== previous) restoreAllSources({ storeOnly: true });
  }

  try {
    installPage();
    window.__inventoryV15 = {
      ready: true,
      version: engine.VERSION,
      getConfig: () => JSON.parse(JSON.stringify(config)),
      getSession: () => session,
      getStores: () => (state?.stores || []).map((store) => ({ id: store.id, name: store.name, active: store.active !== false })),
      refreshStores,
      restoreAllSources,
      clearSource,
      analyze: analyzeInventory,
      buildWorkbookForTest: buildInventoryWorkbook,
      verifyWorkbookForTest: verifyInventoryWorkbook,
      engine,
    };
    window.__inventoryV13 = {
      ready: true,
      version: engine.VERSION,
      getConfig: window.__inventoryV15.getConfig,
      getSession: window.__inventoryV15.getSession,
      getStores: window.__inventoryV15.getStores,
      refreshStores,
      clearUpload: (kind) => clearSource(kind === 'warehouse' ? 'mabang' : kind),
      normalizeSkuForTest: engine.parseSku,
    };
  } catch (error) {
    console.error('Inventory V15 failed:', error);
    window.__inventoryV15 = { ready: false, error: error.message, getConfig: () => config };
  }
})();
