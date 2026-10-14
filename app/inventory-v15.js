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
    presale: null,
    context: null,
    results: [],
    reviewDrafts:new Map(),reviewed:false,
    audit: null,
    storeId: '',
    filter: 'actionable',
    query: '',
    visibleLimit: 100,
    restoring: false,
    restoreToken: 0,
    exporting: false,
    uploading:new Set(),
  };

  const q = (selector, root = document) => root.querySelector(selector);
  const qa = (selector, root = document) => [...root.querySelectorAll(selector)];
  const clean = (value) => String(value ?? '').trim();
  const escapeHtml = (value) => clean(value).replace(/[&<>'"]/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;',
  }[character]));

  function defaultConfig() {
    return {
      version: 5,excludedSkus:[],relatedSkus:[],
      threshold: 10,
      overflowValue: 9999,
      storeSku: '', storeSkuHeader: '', storeSkuId: '', storeSkuIdHeader: '',
      presaleSkuId: '', presaleSkuIdHeader: '', presaleEnable: '', presaleEnableHeader: '', presaleSku: '', presaleSkuHeader: '', storeTitle: '', storeTitleHeader: '', storeStatus: '', storeStatusHeader: '',
      mabangSku: '', mabangSkuHeader: '', mabangName: '', mabangNameHeader: '', mabangWarehouse: '', mabangWarehouseHeader: '',
      warehouses: [
        { id: 'cfs', name: 'CFS', storeColumn: '', storeHeader: '', mabangStockColumn: '', mabangStockHeader: '', mabangValue: 'CFS' },
        { id: 'gaoyi', name: '高易', storeColumn: '', storeHeader: '', mabangStockColumn: '', mabangStockHeader: '', mabangValue: '高易' },
      ],
    };
  }

  function loadConfig() {
    try {
      let saved = JSON.parse(localStorage.getItem(configKey()) || localStorage.getItem(CONFIG_KEY) || localStorage.getItem(LEGACY_CONFIG_KEY) || 'null')||defaultConfig();
      let common=JSON.parse(localStorage.getItem(sharedConfigKey())||'null');
      // One-time migration keeps the configured country's warehouse template,
      // rather than giving every new store a fresh CFS/高易 default.
      if(!common){
        const candidates=[saved];for(let i=0;i<localStorage.length;i++){const key=localStorage.key(i);if(key.startsWith(CONFIG_KEY+':'+country()+':')){try{candidates.push(JSON.parse(localStorage.getItem(key)))}catch{}}}
        const rank=x=>(x?.warehouses||[]).reduce((n,w)=>n+(w.storeHeader?4:0)+(w.mabangStockHeader?2:0)+(!['CFS','高易',''].includes(w.mabangValue)?1:0),0);
        const best=candidates.filter(Boolean).sort((a,b)=>rank(b)-rank(a))[0];common=sharedConfig(best||saved);localStorage.setItem(sharedConfigKey(),JSON.stringify(common));
      }
      saved={...saved,...common};
      const merged = { ...defaultConfig(), ...saved, version: 5 };
      merged.threshold = 10;
      merged.overflowValue = 9999;
      merged.warehouses = Array.isArray(saved.warehouses) && saved.warehouses.length
        ? saved.warehouses.map((warehouse, index) => ({
          id: clean(warehouse.id) || `warehouse-${index + 1}`,
          name: clean(warehouse.name) || `仓库 ${index + 1}`,
          storeColumn: clean(warehouse.storeColumn),
          storeHeader: clean(warehouse.storeHeader),
          mabangStockColumn: Number(saved.version)>=4?clean(warehouse.mabangStockColumn):'',
          mabangStockHeader: Number(saved.version)>=4?clean(warehouse.mabangStockHeader):'',
          mabangValue: clean(warehouse.mabangValue),
        }))
        : (Array.isArray(saved.warehouses)?[]:defaultConfig().warehouses);
      return merged;
    } catch {
      return defaultConfig();
    }
  }

  function sharedConfigKey(){return `${CONFIG_KEY}:shared:${country()}`;}
  function sharedConfig(value){return Object.fromEntries(['warehouses','excludedSkus','relatedSkus','mabangSku','mabangSkuHeader','mabangName','mabangNameHeader','mabangWarehouse','mabangWarehouseHeader'].map(key=>[key,value[key]??(key.endsWith('Skus')?[]:'')]));}
  let config = loadConfig();

  let configFlushTimer;
  function saveConfig() {
    localStorage.setItem(configKey(), JSON.stringify(config));
    localStorage.setItem(sharedConfigKey(),JSON.stringify(sharedConfig(config)));
    clearTimeout(configFlushTimer);configFlushTimer=setTimeout(()=>window.desktopApp?.database?.flush(),450);
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
  function configKey() { return `${CONFIG_KEY}:${country()}:${selectedStoreId()}`; }
  function contextKey() { return `${country()}:${selectedStoreId()}`; }
  function slotFor(kind) {
    return ['store','presale'].includes(kind)
      ? `inventory-v15:${country()}:${selectedStoreId()}:${kind}`
      : `inventory-v15:${country()}:shared:${kind}`;
  }

  // No shared-config fallback: SKU ID freezes belong to exactly one country/store.
  const blacklistKey=(storeId=selectedStoreId())=>`lazadaInventoryBlacklistV18:${country()}:${storeId}`;
  function readBlacklist(storeId){try{const rows=JSON.parse(localStorage.getItem(blacklistKey(storeId))||'[]');return Array.isArray(rows)?rows.filter(x=>clean(x.skuId)):[];}catch{return[];}}
  function writeBlacklist(rows,storeId){localStorage.setItem(blacklistKey(storeId),JSON.stringify(rows));window.desktopApp?.database?.flush();}
  function resetReview(){session.reviewRevision=(session.reviewRevision||0)+1;session.reviewed=false;if(q('#inv18Reviewed'))q('#inv18Reviewed').checked=false;}
  function refreshAudit(){resetReview();session.audit=engine.auditResults(session.results,stockWarehouses());renderResults();}
  function freezeBlacklisted(r){Object.assign(r,{blacklisted:true,frozen:true,preserveRow:true,pendingRelist:false,relistDecision:null,proposal:null,manualEdited:false,selectedWarehouseId:'',needsClosePresale:false,finalSku:r.originalSku,finalStatus:r.status,finalStocks:{...r.originalStocks},tags:[],reasons:['店铺黑名单冻结，原行保留'],flow:'blacklisted'});engine.recalculate(r,stockWarehouses());}
  function blacklistRow(r){
    if(!r.skuId)return toast('SKU ID缺失，不能加入黑名单','err');
    const scope=contextKey();openInventoryDialog('加入店铺黑名单',`<p>确认冻结 SKU ID <b>${escapeHtml(r.skuId)}</b>？</p><p>${escapeHtml(r.originalSku)} · ${escapeHtml(r.title)}</p><p>以后当前店铺识别到此ID，整行保留。</p><button class="btn primary" data-confirm-blacklist>确认加入</button>`);
    q('[data-confirm-blacklist]').onclick=()=>{if(scope!==contextKey())return closeInventoryDialog();const rows=readBlacklist();if(!rows.some(x=>x.skuId===r.skuId)){rows.push({skuId:r.skuId,sku:r.originalSku,title:r.title,createdAt:new Date().toISOString()});writeBlacklist(rows);}for(const item of session.results)if(item.skuId===r.skuId){freezeBlacklisted(item);session.reviewDrafts.delete(item.row);}closeInventoryDialog();refreshAudit();};
  }
  function closeInventoryDialog(){const dialog=q('#inv18Dialog');if(dialog?.open)dialog.close();dialog?.remove();}
  function openInventoryDialog(title,html){closeInventoryDialog();const dialog=document.createElement('dialog');dialog.id='inv18Dialog';dialog.className='inv18-dialog';dialog.innerHTML=`<header><h3>${escapeHtml(title)}</h3><button class="btn light sm" data-close-inventory-dialog aria-label="关闭弹窗">×</button></header><div>${html}</div>`;(q('#desktopWindowSurface')||document.body).appendChild(dialog);q('[data-close-inventory-dialog]',dialog).onclick=closeInventoryDialog;dialog.addEventListener('close',()=>dialog.remove(),{once:true});dialog.showModal();}
  function showBlacklist(storeId=selectedStoreId()){
    const rows=readBlacklist(storeId),scope=country();
    openInventoryDialog('店铺黑名单库',`<label>店铺<select id="inv18BlacklistStore">${(state.stores||[]).map(x=>`<option value="${escapeHtml(x.id)}" ${x.id===storeId?'selected':''}>${escapeHtml(x.name)}</option>`).join('')}</select></label><div class="inv18-blacklist-rows">${rows.length?rows.map((r,i)=>`<div><span><b>${escapeHtml(r.skuId)}</b> · ${escapeHtml(r.sku)}<small>${escapeHtml(r.title)}</small></span><button class="btn light sm" data-unblock="${i}">移出黑名单</button></div>`).join(''):'<p class="muted">此店铺暂无黑名单商品。</p>'}</div>`);
    q('#inv18BlacklistStore').onchange=event=>showBlacklist(event.target.value);
    qa('[data-unblock]').forEach(button=>button.onclick=()=>{if(scope!==country())return closeInventoryDialog();const next=readBlacklist(storeId);next.splice(Number(button.dataset.unblock),1);writeBlacklist(next,storeId);if(storeId===selectedStoreId())clearAnalysis();showBlacklist(storeId);toast('已移出黑名单，下次识别恢复处理');});
  }
  function editReviewRow(row,element){
    const r=session.results.find(x=>x.row===row);if(!r)return;
    try{const stocks=Object.fromEntries(qa('[data-review-stock]',element).map(input=>[input.dataset.reviewStock,r.forbiddenWarehouseIds.includes(input.dataset.reviewStock)?0:input.value]));engine.applyReview(r,{finalSku:q('[data-review-sku]',element).value,finalStatus:q('[data-review-status]',element).value,finalStocks:stocks},session.results,stockWarehouses());session.reviewDrafts.delete(row);refreshAudit();toast('此行人工修改已保存');}catch(error){toast(error.message,'err');}
  }
  function sourceLabel(kind) {
    return { store: '店铺库存表', mabang: '马帮库存表', combo: '组合拆分表', presale: '店铺预售表' }[kind] || kind;
  }

  function sourceScope(kind) {
    if (['store','presale'].includes(kind)) {
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
        const skuScore = kind === 'presale'
          ? (findColumn(columns,['sku.skuId','SKU ID','skuId'],true) ? 15 : 0)
          : kind === 'store' ? (findColumn(columns,['SellerSKU','卖家SKU'],true) ? 15 : 0)
          : (findColumn(columns,['库存SKU编号','SKU编号'],true) ? 15 : 0);
        const otherScore = kind === 'presale'
          ? (findColumn(columns,['预售(相对天数) Enable','Pre-Order','Preorder','预售'],true) ? 8 : 0)
          : kind === 'store' ? (findColumn(columns,['库存']) ? 3 : 0) + (findColumn(columns,['status','状态']) ? 2 : 0)
          : (findColumn(columns,['仓库']) ? 4 : 0) + (findColumn(columns,['库存']) ? 4 : 0);
        const score = skuScore + otherScore;
        if (!best || score > best.score) best = { score, workbook, definition, sheet, row, columns };
      }
    }
    if (!best || best.score < 15) throw new Error(kind === 'store' ? '没有识别到店铺 SellerSKU 表头' : '没有识别到马帮库存 SKU 表头');
    const skuColumn = kind === 'presale' ? findColumn(best.columns,['SellerSKU'],true) : kind === 'store'
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
        const quantity = quantityColumn&&clean(rawQuantity)!=='' ? engine.number(rawQuantity) : 0;
        if (componentInfo.kind !== 'ordinary') {
          invalidReason = `组件 ${rawComponent} 不是有效的 11 位普通 SKU`;
          break;
        }
        if (!Number.isInteger(quantity) || quantity <= 0) {
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
    for(const invalid of invalidRows){const key=engine.parseSku(invalid.sku);if(key.kind==='combo')comboMap.set(key.canonical,{invalid:true,components:[],reason:invalid.reason});}
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
      config.storeSkuId = resolveColumn(columns, config.storeSkuId, config.storeSkuIdHeader, ['sku.skuId','SKU ID','skuId']);
      config.storeSkuIdHeader = headerFor(columns,config.storeSkuId);
      config.storeTitle = resolveColumn(columns, config.storeTitle, config.storeTitleHeader, ['商品标题', '产品名称', 'title']);
      config.storeStatus = resolveColumn(columns, config.storeStatus, config.storeStatusHeader, ['status', '商品状态', '状态']);
      config.storeSkuHeader = headerFor(columns, config.storeSku);
      config.storeTitleHeader = headerFor(columns, config.storeTitle);
      config.storeStatusHeader = headerFor(columns, config.storeStatus);
      for (const warehouse of config.warehouses) {
        warehouse.storeColumn = resolveColumn(columns, warehouse.storeColumn, warehouse.storeHeader, [warehouse.name]);
        warehouse.storeHeader = headerFor(columns, warehouse.storeColumn);
      }
    } else if (kind === 'presale') {
      for (const [key,guesses] of [['presaleSkuId',['sku.skuId','SKU ID','skuId']],['presaleEnable',['预售(相对天数) Enable','Pre-Order','Preorder','预售']],['presaleSku',['SellerSKU']]]) {
        config[key]=resolveColumn(columns,config[key],config[key+'Header'],guesses);config[key+'Header']=headerFor(columns,config[key]);
      }
    } else {
      config.mabangSku = resolveColumn(columns, config.mabangSku, config.mabangSkuHeader, ['库存SKU编号', 'SKU编号', 'SKU']);
      config.mabangName = resolveColumn(columns, config.mabangName, config.mabangNameHeader, ['中文名称', '商品名称', '产品名称']);
      config.mabangWarehouse = resolveColumn(columns, config.mabangWarehouse, config.mabangWarehouseHeader, ['仓库名称', '仓库']);
      config.mabangSkuHeader = headerFor(columns, config.mabangSku);
      config.mabangNameHeader = headerFor(columns, config.mabangName);
      config.mabangWarehouseHeader = headerFor(columns, config.mabangWarehouse);
      for (const warehouse of config.warehouses) {
        warehouse.mabangStockColumn = resolveColumn(columns, warehouse.mabangStockColumn, warehouse.mabangStockHeader, ['可用库存量', '可用库存', 'Available Stock', `${warehouse.name}可用库存`]);
        warehouse.mabangStockHeader = headerFor(columns, warehouse.mabangStockColumn);
      }
    }
    saveConfig();
  }

  function sourceStatusHtml(kind) {
    const source = session[kind];
    if (!source) return '<div class="inv15-source-empty"><b>尚未保存</b></div>';
    const details = kind === 'combo'
      ? `${source.comboMap.size} 个组合 · ${source.componentReferences} 个组件引用`
      : `${Math.max(0,source.sheet.maxRow-(source.dataStartRow||source.row+1)+1)} 行`;
    return `<div class="inv15-source-saved"><div><b>${escapeHtml(source.name)}</b><span>${details}</span></div><div><span>${formatBytes(source.size)}</span><span>${formatDate(source.updatedAt)}</span></div></div>`;
  }

  function renderSourceStatuses() {
    for (const kind of ['store', 'mabang', 'presale', 'combo']) {
      const target = q(`#inv15${kind[0].toUpperCase()}${kind.slice(1)}Status`);
      if (target) target.innerHTML = sourceStatusHtml(kind);
      const clearButton = q(`[data-inv15-clear="${kind}"]`);
      if (clearButton) clearButton.disabled = !session[kind];
    }
    const ready = ['store', 'mabang', 'presale', 'combo'].filter((kind) => session[kind]).length;
    const badge = q('#inv15KnowledgeReady');
    if (badge) {
      badge.textContent = `${ready} / 4 已就绪`;
      badge.className = `chip ${ready === 4 ? 'good' : 'warn'}`;
    }
    const button = q('#inv15Analyze');
    if (button) button.disabled = ready !== 4 || session.restoring;
  }

  async function parseSource(kind, buffer) {
    return kind === 'combo' ? inspectComboWorkbook(buffer) : inspectWorkbook(buffer, kind);
  }

  async function saveSource(kind, file) {
    if (!file) return;
    const uploadScope=slotFor(kind);if(session.uploading.has(uploadScope))return toast('此表正在导入，请稍候','err');session.uploading.add(uploadScope);
    const status = q(`#inv15${kind[0].toUpperCase()}${kind.slice(1)}Status`);
    const scrollTop = window.scrollY;
    const sourceContext=contextKey(),slot=slotFor(kind);
    if (status) status.innerHTML = '<div class="inv15-source-loading"><i></i><b>正在校验并保存到本机知识库…</b></div>';
    try {
      const buffer = await file.arrayBuffer();
      const parsed = await parseSource(kind, buffer);
      if(sourceContext!==contextKey())throw Error('店铺或国家已切换，请在目标店铺重新上传');
      const record = await window.desktopApp.uploads.save(slot, {
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
      if(sourceContext!==contextKey())return;
      session[kind] = parsed;
      cacheSource(slot,parsed);
      if (kind !== 'combo') applySavedMappings(kind, parsed);
      clearAnalysis();
      renderAllInventory();
      toast(`${sourceLabel(kind)}已更新并保存，下次打开自动恢复`, 'ok');
    } catch (error) {
      console.error(error);
      renderSourceStatuses();
      toast(`${sourceLabel(kind)}读取失败：${error.message}`, 'err');
    } finally {
      session.uploading.delete(uploadScope);
      const input = q(`#inv15${kind[0].toUpperCase()}${kind.slice(1)}File`);
      if (input) { input.value = ''; input.blur(); }
      requestAnimationFrame(() => requestAnimationFrame(() => window.scrollTo({ top: scrollTop, left: 0, behavior: 'auto' })));
    }
  }

  // Parsed workbooks are immutable source data. Keep a bounded cache by upload
  // slot and revision; mappings and results remain scoped to country + store.
  const parsedSourceCache = new Map();
  let sourcesNeedRestore=false;
  function cacheSource(slot, source) {
    parsedSourceCache.delete(slot);parsedSourceCache.set(slot, source);
    while(parsedSourceCache.size>12)parsedSourceCache.delete(parsedSourceCache.keys().next().value);
  }
  async function restoreSource(kind, token = session.restoreToken) {
    try {
      const slot=slotFor(kind);
      const record = await window.desktopApp.uploads.read(slot);
      if (token !== session.restoreToken) return;
      if (!record) {
        session[kind] = null;parsedSourceCache.delete(slot);
        return;
      }
      const cached=parsedSourceCache.get(slot);
      if(cached && cached.updatedAt===record.updatedAt && cached.name===record.name){session[kind]=cached;if(kind!=='combo')applySavedMappings(kind,cached);return;}
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
      cacheSource(slot,parsed);
      if (kind !== 'combo') applySavedMappings(kind, parsed);
    } catch (error) {
      console.error(`Unable to restore inventory ${kind}:`, error);
      session[kind] = null;
      toast(`已保存的${sourceLabel(kind)}无法恢复：${error.message}`, 'err');
    }
  }

  async function restoreAllSources(options = {}) {
    sourcesNeedRestore=false;
    const token = ++session.restoreToken;
    session.restoring = true;
    renderSourceStatuses();
    if (options.storeOnly) {
      session.store = null;session.presale=null;
      await Promise.all(['store','presale'].map(kind=>restoreSource(kind,token)));
    } else {
      session.store = null;
      session.mabang = null;
      session.combo = null;session.presale=null;
      await Promise.all(['store', 'mabang', 'presale', 'combo'].map((kind) => restoreSource(kind, token)));
    }
    if (token !== session.restoreToken) return;
    session.restoring = false;
    clearAnalysis();
    renderAllInventory();
  }

  async function clearSource(kind) {
    const sourceContext=contextKey(),slot=slotFor(kind);
    await window.desktopApp.uploads.remove(slot);
    parsedSourceCache.delete(slot);
    if(sourceContext!==contextKey())return;
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
    const presaleBox=q('#inv15PresaleBaseMap');
    if(presaleBox)presaleBox.innerHTML=[['presaleSkuId','SKU ID（必选）'],['presaleEnable','预售 Yes / No（必选）'],['presaleSku','SellerSKU（核对）']].map(([key,label])=>`<label>${label}<select data-inv15-base="${key}">${columnOptions(session.presale?.columns||[],config[key])}</select></label>`).join('');
    if (storeBox) storeBox.innerHTML = `
      <label>SellerSKU（必选）<select data-inv15-base="storeSku">${columnOptions(storeColumns, config.storeSku)}</select></label>
      <label>SKU ID（关联预售）<select data-inv15-base="storeSkuId">${columnOptions(storeColumns, config.storeSkuId)}</select></label>
      <label>店铺商品标题<select data-inv15-base="storeTitle">${columnOptions(storeColumns, config.storeTitle)}</select></label>
      <label>Status 上下架状态（必选）<select data-inv15-base="storeStatus">${columnOptions(storeColumns, config.storeStatus)}</select></label>`;
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
        <label>马帮仓库<span class="inv15-keyword-editor"><input data-inv15-mabang-value list="inv15WarehouseValues" value="${escapeHtml(warehouse.mabangValue)}" placeholder="选择仓库或填写关键字"><button type="button" class="btn light sm" data-inv15-open-warehouse aria-label="选择 ${escapeHtml(warehouse.name)} 马帮仓库">⌄</button><button type="button" class="btn light sm" data-inv15-clear-keyword aria-label="清空 ${escapeHtml(warehouse.name)} 仓库关键字">×</button></span></label>
        <button class="btn danger sm" type="button" data-inv15-delete-warehouse>删除</button>
      </div>`).join('') : '<div class="inv15-empty">还没有仓库映射，请新增仓库。</div>';
    q('#inv15WarehouseCount').textContent = `${config.warehouses.length} 个仓库`;
  }

  function openWarehousePicker(button){
    const picker=q('#inv15WarehousePicker'),row=button.closest('[data-warehouse-id]');picker.dataset.warehouseId=row.dataset.warehouseId;
    picker.innerHTML=distinctWarehouseValues().map(value=>`<button type="button" data-inv15-pick-value="${escapeHtml(value)}">${escapeHtml(value)}</button>`).join('')||'<span>请先导入马帮库存表</span>';
    const rect=button.getBoundingClientRect();picker.style.left=Math.max(12,rect.right-330)+'px';picker.style.top=Math.min(rect.bottom+4,window.innerHeight-240)+'px';picker.showPopover();
  }
  function renderSpecialSkus(){
    q('#inv15ExcludedList').innerHTML=(config.excludedSkus||[]).map((rule,i)=>`<div class="inv15-special-item"><span>${escapeHtml(rule.sku)}</span><span>${rule.mode==='contains'?'包含':'完全匹配'}</span><button type="button" data-inv15-remove-excluded="${i}" aria-label="删除跳过SKU ${escapeHtml(rule.sku)}">×</button></div>`).join('');
    q('#inv15RelatedList').innerHTML=(config.relatedSkus||[]).map((rule,i)=>`<div class="inv15-special-item"><span>${escapeHtml(rule.from)} → ${escapeHtml(rule.to)}</span><button type="button" data-inv15-remove-related="${i}" aria-label="删除关联 ${escapeHtml(rule.from)}">×</button></div>`).join('');
  }
  function addSpecialRule(kind){
    if(kind==='excluded'){const sku=engine.normalizeRawSku(q('#inv15ExcludeSku').value),mode=q('#inv15ExcludeMode').value;if(!sku)return;config.excludedSkus=config.excludedSkus||[];if(!config.excludedSkus.some(r=>r.sku===sku&&r.mode===mode))config.excludedSkus.push({sku,mode});q('#inv15ExcludeSku').value='';}
    else {const from=engine.normalizeRawSku(q('#inv15RelatedFrom').value),to=engine.normalizeRawSku(q('#inv15RelatedTo').value);if(engine.parseSku(from).kind==='invalid'||engine.parseSku(to).kind==='invalid'||engine.parseSku(from).canonical===engine.parseSku(to).canonical)return toast('请填写两个不同的有效SKU','err');config.relatedSkus=config.relatedSkus||[];if(config.relatedSkus.some(r=>engine.parseSku(r.from).canonical===engine.parseSku(from).canonical))return toast('这个SKU已有对应关系，请先删除旧关联','err');config.relatedSkus.push({from,to});q('#inv15RelatedFrom').value=q('#inv15RelatedTo').value='';}
    saveConfig();clearAnalysis();renderSpecialSkus();
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
    const columns = key.startsWith('store') ? session.store?.columns : key.startsWith('presale') ? session.presale?.columns : session.mabang?.columns;
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
      const warehouseName = config.mabangWarehouse ? clean(cellValue(data.sheet, row, Number(config.mabangWarehouse))) : '';
      const locations=[];
      for(const warehouse of warehouses){
        const accepted=normalizedWarehouseValues(warehouse.mabangValue);
        if(engine.warehouseNameMatches(warehouseName,accepted))locations.push({key:warehouseName||warehouse.id,warehouseId:warehouse.id,name:warehouseName||warehouse.name,stock:cellValue(data.sheet,row,Number(warehouse.mabangStockColumn))});
      }
      rows.push({row,sku,name,locations});
    }
    return rows;
  }

  function stockWarehouses() {
    const mapped=mappedWarehouses(),seen=new Set(mapped.map(w=>Number(w.storeColumn)));
    // Include all stock columns in checks/exports, even when unused warehouse mappings are absent.
    return mapped.concat((session.store?.columns||[]).filter(c=>!seen.has(c.c)&&/仓|warehouse/i.test(c.h)&&!/SKU|状态|status/i.test(c.h)).map(c=>({id:'unmapped-'+c.c,name:c.h,storeColumn:String(c.c)})));
  }

  function readPresaleIndex() {
    if(!config.presaleSkuId||!config.presaleEnable)throw Error('预售表必须选择 SKU ID 和 Yes / No 列');
    const index=new Map(),data=session.presale;
    for(let row=data.dataStartRow;row<=data.sheet.maxRow;row++){
      const id=clean(cellValue(data.sheet,row,Number(config.presaleSkuId)));if(!id)continue;
      const raw=clean(cellValue(data.sheet,row,Number(config.presaleEnable))).toLowerCase();
      const value=['yes','是','true','1'].includes(raw)?'yes':['no','否','false','0'].includes(raw)?'no':'unknown';
      const sku=config.presaleSku?clean(cellValue(data.sheet,row,Number(config.presaleSku))):'';
      const old=index.get(id);index.set(id,old&&(old.value!==value||old.sku!==sku)?{value:'unknown',sku:'',reason:'预售表相同 SKU ID 存在冲突'}:{value,sku,row});
    }
    return index;
  }

  function readStoreRows(warehouses) {
    const data = session.store;
    if (!config.storeSku || !config.storeSkuId || !config.storeStatus) throw new Error('店铺库存表必须选择 SellerSKU、SKU ID 和 Status 列（用于上下架判断）');
    const presales=readPresaleIndex();
    const rows = [];
    for (let row = data.dataStartRow || data.row + 1; row <= data.sheet.maxRow; row += 1) {
      const sku = clean(cellValue(data.sheet, row, Number(config.storeSku)));
      if (!sku) continue;
      const stocks = Object.fromEntries(warehouses.map((warehouse) => [warehouse.id, cellValue(data.sheet, row, Number(warehouse.storeColumn))]));
      const skuId=clean(cellValue(data.sheet,row,Number(config.storeSkuId))),pre=presales.get(skuId);
      const stale=pre?.sku&&engine.normalizeRawSku(pre.sku)!==engine.normalizeRawSku(sku);
      rows.push({
        row,
        sku,skuId,presale:stale?'unknown':pre?.value||'unknown',presaleReason:stale?'预售表同 SKU ID 的 SellerSKU 与店铺表不同，请更新表格':pre?.reason||'预售状态缺失或无法识别',
        title: config.storeTitle ? clean(cellValue(data.sheet, row, Number(config.storeTitle))) : '',
        status: config.storeStatus ? clean(cellValue(data.sheet, row, Number(config.storeStatus))) : '',
        stocks,
      });
    }
    return rows;
  }

  function clearAnalysis() {
    session.reviewDrafts.clear();resetReview();
    session.results = [];
    session.audit = null;session.context=null;
    if(q('#inv15ExportReview'))q('#inv15ExportReview').hidden=true;
    if(q('#inv15ExportWorkbook'))q('#inv15ExportWorkbook').disabled=true;
    if(q('#inv15ExportManual'))q('#inv15ExportManual').disabled=true;
    session.visibleLimit = 100;session.page=1;
    const list = q('#inv15ResultList');
    if (list) list.innerHTML = '<div class="inv15-empty">四张表就绪后，点击“执行库存识别”。</div>';
    if (q('#inv15Metrics')) q('#inv15Metrics').innerHTML = '';
    if (q('#inv15ResultCount')) q('#inv15ResultCount').textContent = '尚未分析';
    if (q('#inv15Audit')) q('#inv15Audit').innerHTML = '';
  }

  async function analyzeInventory() {
    if (!session.store || !session.mabang || !session.presale || !session.combo) return toast('请先让四张表格知识库全部就绪', 'err');
    const warehouses = mappedWarehouses();
    if (!warehouses.length) return toast('请至少完成一个仓库的店铺列与马帮列映射', 'err');
    const analysisContext=contextKey();
    const button = q('#inv15Analyze');
    button.disabled = true;
    button.textContent = '正在执行规则并复核…';
    await new Promise((resolve) => requestAnimationFrame(resolve));
    try {
      if(analysisContext!==contextKey()||session.restoring)throw Error('店铺或国家已切换，请重新执行识别');
      if(new Set(warehouses.map(w=>w.storeColumn)).size!==warehouses.length)throw Error('多个仓库映射使用了同一店铺库存列');
      if(warehouses.some(w=>!w.mabangValue)||!config.mabangWarehouse)throw Error('请设置马帮仓库名称列和每个仓库的匹配关键字');
      config.threshold = 10;config.overflowValue = 9999;
      const scope=contextKey();
      saveConfig();
      const analysis = engine.analyze({
        storeRows: readStoreRows(stockWarehouses()),
        stockWarehouses: stockWarehouses(),
        mabangRows: readMabangRows(warehouses),
        comboMap: session.combo.comboMap,
        warehouses,
        threshold: config.threshold,
        overflowValue: config.overflowValue,excludedSkus:config.excludedSkus,relatedSkus:config.relatedSkus,blacklistIds:readBlacklist().map(x=>x.skuId),
      });
      session.context=scope;session.results = analysis.results;session.filter='actionable';session.query='';q('#inv15Filter').value='actionable';q('#inv15Search').value='';
      session.reviewDrafts.clear();resetReview();session.audit = analysis.audit;
      session.visibleLimit = 100;session.page=1;
      renderResults();
      toast(`识别完成：${analysis.audit.changedRows} 行将更新，${analysis.audit.unresolvedRows} 行需人工处理`, analysis.audit.ok ? 'ok' : 'err');
    } catch (error) {
      console.error(error);
      toast(`库存识别失败：${error.message}`, 'err');
    } finally {
      button.textContent = '执行库存识别';
      renderSourceStatuses();
    }
  }

  const FLOW_LABELS = {pending_relist:'下架有货 · 待确认',relisted:'已同意上架',kept_inactive:'保持下架',shortage_inactive:'缺货下架',blacklisted:'黑名单冻结',manual_status:'上下架状态待核对',manual_sku_id:'SKU ID待核对',
    already_compliant:'无需调整',special_invalid_sku:'SKU特殊提示',special_excluded:'跳过识别',related_sku_replacement:'关联SKU替换',already_processed:'已处理 · 跳过',stock_cleared:'库存已清零',
    flow1_original_warehouse: '流程一 · 原仓有货',
    flow2_same_sku_other_warehouse: '流程二 · 同 SKU 转仓',
    flow3_same_product_replacement: '流程三 · 同款换 SKU',
    combo_healthy: '组合组件有货',
    manual_combo_component_stock: '组合组件缺货',
    manual_combo_definition: '组合定义异常',
    manual_multi_store_warehouse: '店铺多仓异常',
    manual_no_stock: '库存不足 · 已清空',
    manual_invalid_sku: 'SKU 格式异常',
    manual_multi_consolidated:'原多仓例外 · 保留最大仓',presale_unchanged:'已开预售 · 保持原样',manual_presale_unknown:'预售状态待核对',manual_mabang_unknown:'马帮库存待核对',manual_unmapped_stock:'仓库映射待补全',manual_sku_collision:'替换 SKU 重复',
    unchanged: '保持原样',
  };

  function tagHtml(tag) {
    const type = tag === engine.TAGS.ANOMALY ? 'danger' : 'warn';
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

  // Review-only classification follows final saved status, including manual edits.
  function needsDelisting(r){return r.changed&&!r.preserveRow&&!r.blacklisted&&clean(r.status).toLowerCase()!=='inactive'&&clean(r.finalStatus).toLowerCase()==='inactive';}
  function resultMatchesFilter(result) {
    if(session.filter==='delist')return needsDelisting(result);
    if(session.filter==='actionable')return result.changed||result.manual;
    if(session.filter==='relist')return result.pendingRelist;
    if(session.filter==='closepresale')return result.needsClosePresale;
    if(session.filter==='blacklist')return result.blacklisted;
    if(session.filter==='unchanged')return !result.changed&&!result.manual;
    if (session.filter === 'changed') return result.changed;
    if (session.filter === 'manual') return result.manual;
    if (session.filter === 'presale') return result.presale==='yes';
    if(session.filter==='special')return result.tags.includes(engine.TAGS.SPECIAL)||result.flow==='special_excluded';
    if(session.filter==='related')return result.flow==='related_sku_replacement';
    if (session.filter === 'anomaly') return result.tags.includes(engine.TAGS.ANOMALY);
    if (session.filter === 'processed') return ['already_processed','stock_cleared'].includes(result.flow);
    if (session.filter === 'combo') return result.kind === 'combo';
    if (session.filter.startsWith('flow')) return result.flow === session.filter&&result.changed;
    return true;
  }

  function filteredResults() {
    const query = session.query.toLowerCase();
    return session.results.filter((result) => {
      const text = `${result.skuId} ${result.status} ${result.finalStatus} ${result.originalSku} ${result.finalSku} ${result.title} ${result.mabangName} ${result.reasons.join(' ')}`.toLowerCase();
      const queryMatch = window.__fuzzySearchV14?.matches
        ? window.__fuzzySearchV14.matches(text, query, 'inventoryV15Search')
        : (!query || text.includes(query));
      return queryMatch && resultMatchesFilter(result);
    }).sort((left, right) => (
      Number(!!right.pendingRelist) - Number(!!left.pendingRelist)
      || Number(right.manual) - Number(left.manual)
      || Number(right.changed) - Number(left.changed)
      || left.row - right.row
    ));
  }

  function resultCounts() {
    return {
      all: session.results.length,
      changed: session.results.filter((item) => item.changed).length,
      flow1: session.results.filter((item) => item.changed&&item.flow === 'flow1_original_warehouse').length,
      flow2: session.results.filter((item) => item.changed&&item.flow === 'flow2_same_sku_other_warehouse').length,
      flow3: session.results.filter((item) => item.changed&&item.flow === 'flow3_same_product_replacement').length,
      manual: session.results.filter((item) => item.manual).length,
      presale: session.results.filter((item) => item.presale==='yes').length,
      anomaly: session.results.filter((item) => item.tags.includes(engine.TAGS.ANOMALY)).length,
      unlisted: session.results.filter((item) => item.tags.includes(engine.TAGS.UNLISTED)).length,
      combo: session.results.filter((item) => item.kind === 'combo').length,
    };
  }

  function metricButton(filter, label, value, tone = '') {
    return `<button class="inv15-metric ${tone} ${session.filter === filter ? 'active' : ''}" data-inv15-filter="${filter}"><span>${label}</span><b>${value}</b></button>`;
  }

  function reviewStockInput(r,shown,w,disabled){return `<label><span title="${escapeHtml(w.name)}">${escapeHtml(w.name)}<small>原值 ${escapeHtml(r.originalStocks[w.id]??'空')}</small></span><input aria-label="${escapeHtml(w.name)} 最终库存 第${r.row}行" data-review-stock="${escapeHtml(w.id)}" type="number" min="0" step="1" value="${escapeHtml(shown.finalStocks[w.id]??'')}" ${disabled}></label>`;}
  function resultRowHtml(r,warehouses){
    const locked=r.frozen||r.pendingRelist||r.blacklisted||r.relistDecision==='kept',disabled=locked?'disabled':'';
    const draft=session.reviewDrafts.get(r.row);const shown=draft?{...r,...draft,finalStocks:{...r.finalStocks,...draft.finalStocks}}:r;
    return `<tr class="inv15-result ${r.pendingRelist?'inv18-urgent':r.manual?'manual':r.changed?'changed':'clean'}" data-review-row="${r.row}" ${draft?'data-dirty="true"':''}>
      <td><span class="inv18-source-row">第${r.row}行 · ${escapeHtml(r.skuId)}</span><strong>${escapeHtml(r.originalSku)}</strong><small class="inv18-mabang-name" title="${escapeHtml(r.originalMabangName||'')}">马帮中文名：${escapeHtml(r.originalMabangName||'未匹配中文名称')}</small><small title="${escapeHtml(r.title)}">${escapeHtml(r.title)}</small><div class="inv15-tags">${needsDelisting(r)?'<span class="chip warn">需下架</span>':''}${r.tags.map(tagHtml).join('')}<span class="chip muted">${escapeHtml(FLOW_LABELS[r.flow]||r.flow)}</span></div></td>
      <td><label class="inv18-mini-label">最终 SellerSKU</label><input data-review-sku value="${escapeHtml(shown.finalSku)}" ${disabled}><small>${r.presale==='yes'?'预售 Yes':r.presale==='no'?'预售 No':'预售未知'}</small><small>原状态 ${escapeHtml(r.status)}</small><select data-review-status ${disabled}><option value="active" ${shown.finalStatus==='active'?'selected':''}>active · 上架</option><option value="inactive" ${shown.finalStatus==='inactive'?'selected':''}>inactive · 下架</option></select></td>
      <td><div class="inv18-stocks">${warehouses.filter(w=>!r.forbiddenWarehouseIds.includes(w.id)).map(w=>reviewStockInput(r,shown,w,disabled)).join('')}</div>${r.forbiddenWarehouseIds.length?`<details class="inv18-other-stock"><summary>非指定仓 · ${r.forbiddenWarehouseIds.length} 个${r.forbiddenWarehouseIds.some(id=>engine.number(r.originalStocks[id])>0)?' · 原有库存':''}</summary><div class="inv18-stocks">${warehouses.filter(w=>r.forbiddenWarehouseIds.includes(w.id)).map(w=>reviewStockInput(r,shown,w,'disabled')).join('')}</div></details>`:''}</td>
      <td><div class="inv18-reasons">${r.reasons.map(x=>`<p>${escapeHtml(x)}</p>`).join('')}${r.pendingRelist&&r.proposal?`<b>建议 ${escapeHtml(r.proposal.finalSku)}</b><p>${warehouses.filter(w=>engine.number(r.proposal.finalStocks[w.id])>0).map(w=>escapeHtml(w.name)+'：'+r.proposal.finalStocks[w.id]).join('；')}</p>`:''}</div><div class="inv18-actions">${r.pendingRelist?`<div class="inv18-actions"><button class="btn primary sm" data-relist="yes">同意上架</button><button class="btn light sm" data-relist="no">保持下架</button></div>`:!locked?'<button class="btn light sm" data-save-review>保存本行修改</button>':''}${r.relistDecision&&!r.blacklisted&&!r.frozen?'<button class="btn light sm" data-reconsider>重新选择上架处理</button>':''}</div></td>
      <td class="inv18-freeze"><button class="btn light sm" data-blacklist-row ${r.blacklisted||!r.skuId?'disabled':''} aria-label="冻结 SKU ID ${escapeHtml(r.skuId)}" title="加入店铺黑名单">×</button></td></tr>`;
  }

  function renderResults() {
    if (!session.results.length) return clearAnalysis();
    const warehouses = stockWarehouses();
    const counts = resultCounts();
    q('#inv15Metrics').innerHTML = [
      metricButton('all', '全部 SKU', counts.all),
      metricButton('actionable','需要处理',session.results.filter(r=>r.changed||r.manual).length),
      metricButton('unchanged','无需调整',session.results.filter(r=>!r.changed&&!r.manual).length),
      metricButton('changed', '将修改', counts.changed, 'good'),
      metricButton('delist','需下架',session.results.filter(needsDelisting).length,'warn'),
      metricButton('flow1_original_warehouse', '流程一', counts.flow1),
      metricButton('flow2_same_sku_other_warehouse', '流程二', counts.flow2),
      metricButton('flow3_same_product_replacement', '流程三', counts.flow3),
      metricButton('manual', '人工处理', counts.manual, 'danger'),
      metricButton('presale', '已开预售', counts.presale, 'warn'),
      metricButton('anomaly', '异常', counts.anomaly, 'danger'),
      metricButton('special','特殊提示',session.results.filter(r=>r.tags.includes(engine.TAGS.SPECIAL)||r.flow==='special_excluded').length),
      metricButton('relist','下架有货待确认',session.results.filter(r=>r.pendingRelist).length,'danger'),
      metricButton('closepresale','有货需关预售',session.results.filter(r=>r.needsClosePresale).length,'warn'),
      metricButton('blacklist','黑名单冻结',session.results.filter(r=>r.blacklisted).length),
      metricButton('processed', '已处理',session.results.filter(r=>['already_processed','stock_cleared'].includes(r.flow)).length),
      metricButton('combo', '组合 SKU', counts.combo),
    ].join('');
    const filtered = filteredResults();
    const pages=Math.max(1,Math.ceil(filtered.length/100));session.page=Math.min(session.page||1,pages);
    const visible = filtered.slice((session.page-1)*100,session.page*100);
    q('#inv15ResultCount').textContent = `已分析 ${session.results.length} 条 · 筛选结果 ${filtered.length} 条`;
    q('#inv15ResultList').innerHTML = visible.length ? `<table class="inv18-review-table"><thead><tr><th>商品 / 判断</th><th>SKU / 上下架 / 预售</th><th>库存核对与修改</th><th>原因 / 人工确认</th><th>冻结</th></tr></thead><tbody>${visible.map(r=>resultRowHtml(r,warehouses)).join('')}</tbody></table>` : '<div class="inv15-empty">当前筛选没有结果。</div>';
    q('#inv15More').innerHTML=`<span>第 ${session.page}/${pages} 页 · 每页100条 · 导出包含全部结果</span><button class="btn light" id="inv15Prev" ${session.page===1?'disabled':''}>上一页</button><button class="btn light" id="inv15Next" ${session.page===pages?'disabled':''}>下一页</button>`;
    q('#inv15Prev').onclick=()=>{session.page--;renderResults()};q('#inv15Next').onclick=()=>{session.page++;renderResults()};
    const audit = session.audit;
    q('#inv15Audit').innerHTML = audit?.ok
      ? `<div class="inv15-audit good"><b>✓ 最终规则复核通过</b><span>${audit.changedRows} 行将写入修改；${audit.unresolvedRows} 行需人工处理；</span></div>`
      : `<div class="inv15-audit danger"><b>最终规则复核未通过</b><span>${audit?.failures?.map((item) => `第${item.row}行：${item.reason}`).join('；') || '未知错误'}</span></div>`;
    const pending=session.results.some(r=>r.pendingRelist);q('#inv18Reviewed').disabled=pending||!audit?.ok;
    q('#inv18ReviewHint').textContent=pending?'请先逐条选择同意上架或保持下架':'核对完成后勾选确认，即可导出';
    q('#inv15ExportWorkbook').disabled = !audit?.ok||!session.reviewed||pending||session.reviewDrafts.size>0;
    q('#inv15ExportReview').hidden=!!audit?.ok;
    q('#inv15ExportManual').disabled = !counts.manual;
  }

  function quoteCsv(value) {
    return `"${String(value ?? '').replaceAll('"', '""')}"`;
  }

  function exportManualList() {
    const warehouses = stockWarehouses();
    const rows = session.results.filter((result) => result.manual);
    if (!rows.length) return toast('当前没有需人工处理的 SKU', 'err');
    const headers = ['SKU ID','预售状态','当前马帮仓库可用量','同款查询结果','中文候选（仅供人工确认）','组合组件明细','来源文件','原表行号', '标签', '原SellerSKU', '最终SellerSKU', '店铺标题', '马帮商品名称', 'Status', '处理流程', '原库存', '最终库存', '原因'];
    const lines = rows.map((result) => [
      result.skuId,result.presale,JSON.stringify(result.mabangEvidence),JSON.stringify(result.alternatives),JSON.stringify(result.nameSuggestions),JSON.stringify(result.componentChecks),JSON.stringify(['mabang','store','presale','combo'].map(k=>({type:k,name:session[k]?.name,updatedAt:session[k]?.updatedAt}))),
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
    downloadBlob(blob, `${storeName}_V18.1库存人工处理名单_${new Date().toISOString().slice(0, 10)}.csv`);
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

  async function buildInventoryWorkbook(options={}) {
    if(!options.reviewOnly&&(!session.reviewed||session.reviewDrafts.size||session.results.some(r=>r.pendingRelist)))throw Error('请先完成下架有货商品确认，并勾选二次核对完成');
    if(!options.reviewOnly&&!session.audit?.ok)throw Error('存在未解决的多仓库存异常，正式导出已阻止；可下载预览供核对');
    if(session.context!==contextKey()||session.restoring)throw Error('国家或店铺已变化，请重新识别');
    const sourceContext=session.context,reviewRevision=session.reviewRevision,warehouses = stockWarehouses();
    const workbook = await openWorkbook(session.store.buffer.slice(0));
    await prepareInventoryStyles(workbook);
    const definition = workbook.sheets.find((item) => item.path === session.store.definition.path);
    if (!definition) throw new Error('导出时找不到原店铺工作表');
    const sheet = await getSheet(workbook, definition);
    for (const result of session.results) {
      // V18.1: protected and already-completed rows retain original XML, including cell types.
      if(result.preserveRow||(result.flow==='already_processed'&&!result.changed))continue;
      setInventoryTextCell(workbook, sheet, result.row, Number(config.storeSku), result.finalSku);
      if (config.storeStatus) setInventoryTextCell(workbook, sheet, result.row, Number(config.storeStatus), result.finalStatus);
      for (const warehouse of warehouses) {
        const value=result.finalStocks[warehouse.id];
        if(value!=null&&clean(value)!==''&&engine.stockNumber(value)==null&&!result.changed)continue;
        setInventoryNumberCell(workbook, sheet, result.row, Number(warehouse.storeColumn), value);
      }
    }
    workbook.zip.file(definition.path, serializeXml(sheet.doc));
    flushInventoryStyles(workbook);
    const buffer = await workbook.zip.generateAsync({ type: 'arraybuffer', compression: 'DEFLATE', compressionOptions: { level: 6 } });
    if(sourceContext!==contextKey()||session.context!==sourceContext||session.reviewRevision!==reviewRevision)throw Error('生成期间国家、店铺或人工核对内容发生变化，导出已停止');
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
      if (!['inlineStr','s'].includes(skuCell?.getAttribute('t'))) failures.push(`第${result.row}行 SellerSKU 文本格式`);
      if (config.storeStatus) {
        if(clean(cellValue(sheet,result.row,Number(config.storeStatus)))!==result.finalStatus)failures.push(`第${result.row}行 Status值`);
        const statusCell = rowNode && inv15FindCell(rowNode, Number(config.storeStatus));
        if (!['inlineStr','s'].includes(statusCell?.getAttribute('t'))) failures.push(`第${result.row}行 Status 文本格式`);
      }
      for (const warehouse of warehouses) {
        const expected = result.finalStocks[warehouse.id];
        const actual = cellValue(sheet, result.row, Number(warehouse.storeColumn));
        if (expected === null || expected === undefined || expected === '') {
          if (actual !== null && clean(actual) !== '') failures.push(`第${result.row}行 ${warehouse.name} 应为空`);
        } else if (engine.number(actual) !== engine.number(expected)) failures.push(`第${result.row}行 ${warehouse.name} 库存`);
        if(expected!=null&&clean(expected)!==''&&engine.stockNumber(expected)==null&&!result.changed)continue;
        if(result.preserveRow||(result.flow==='already_processed'&&!result.changed))continue;
        const stockCell = rowNode && inv15FindCell(rowNode, Number(warehouse.storeColumn));
        if (expected !== null && expected !== undefined && expected !== '' && stockCell?.hasAttribute('t')) failures.push(`第${result.row}行 ${warehouse.name} 数字格式`);
      }
    }
    if (failures.length) throw new Error(`成品 Excel 二次识别失败：${failures.slice(0, 8).join('、')}${failures.length > 8 ? `等 ${failures.length} 项` : ''}`);
    return { ok: true, checkedRows: session.results.length };
  }

  async function exportInventoryWorkbook() {
    if (session.exporting) return;
    if(session.reviewDrafts.size)return toast('请先保存本行修改，再确认导出','err');
    if (!session.audit?.ok || !session.results.length) return toast('请先完成库存识别与最终规则复核', 'err');
    session.exporting = true;
    const button = q('#inv15ExportWorkbook');
    button.disabled = true;
    button.textContent = '正在生成并二次识别…';
    try {
      const blob = await buildInventoryWorkbook();
      const storeName = state?.stores?.find((store) => store.id === selectedStoreId())?.name || '店铺';
      const filename = `${storeName}_V18.1库存更新_${new Date().toISOString().slice(0, 10)}.xlsx`;
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
    renderSpecialSkus();
    const threshold = q('#inv15Threshold');
    const overflow = q('#inv15Overflow');
    if (threshold && document.activeElement !== threshold) threshold.value = String(config.threshold);
    if (overflow && document.activeElement !== overflow) overflow.value = String(config.overflowValue);
    if (session.results.length) renderResults();
  }

  function installCardDropZones(page){
    let hideTimer;const cards=qa('.inv15-source-card',page),kinds=['store','mabang','presale','combo'];
    const reset=()=>{clearTimeout(hideTimer);page.classList.remove('inv181-files-drag');cards.forEach(card=>card.classList.remove('inv181-drop-target'));};
    const isFileDrag=event=>Array.from(event.dataTransfer?.types||[]).includes('Files');
    for(const card of cards){const kind=kinds.find(key=>card.classList.contains(key));card.dataset.sourceKind=kind;const hint=document.createElement('div');hint.className='inv181-drop-hint';hint.textContent='松开以导入'+sourceLabel(kind);card.appendChild(hint);}
    page.addEventListener('dragover',event=>{if(!isFileDrag(event))return;event.preventDefault();page.classList.add('inv181-files-drag');const target=event.target.closest('.inv15-source-card');cards.forEach(card=>card.classList.toggle('inv181-drop-target',card===target));event.dataTransfer.dropEffect=target?'copy':'none';clearTimeout(hideTimer);hideTimer=setTimeout(reset,1200);},true);
    page.addEventListener('drop',event=>{if(!isFileDrag(event))return;event.preventDefault();event.stopImmediatePropagation();const card=event.target.closest('.inv15-source-card'),files=Array.from(event.dataTransfer?.files||[]);reset();if(!card)return toast('请将文件拖入对应表格卡片','err');if(files.length!==1||!/^.*\.(xlsx|xlsm)$/i.test(files[0]?.name||''))return toast('每次请拖入一张 XLSX 或 XLSM 表格','err');void saveSource(card.dataset.sourceKind,files[0]);},true);
    window.addEventListener('dragend',reset);window.addEventListener('blur',reset);window.addEventListener('country-changed',reset);window.addEventListener('dragleave',event=>{if(!event.relatedTarget&&event.clientX===0&&event.clientY===0)reset();});
  }

  function installPage() {
    const page = q('#page-inventory');
    if (!page) throw new Error('库存识别页面不存在');
    page.className = 'page inv15-page';
    page.innerHTML = `
      <section class="inv15-hero">
        <div class="inv15-hero-copy">

          <h2>四表库存识别</h2>


        </div>
        <div class="inv15-hero-state"><b id="inv15KnowledgeReady">0 / 4 已就绪</b></div>
      </section>

      <section class="inv15-sources">
        <article class="inv15-source-card store">
          <div class="inv15-source-head"><span>02</span><div><h3>店铺库存表</h3><p id="inv15StoreScope" hidden></p></div></div>
          <label class="inv15-drop"><input id="inv15StoreFile" data-clear-installed="1" type="file" accept=".xlsx,.xlsm"></label>
          <button class="inv15-clear" type="button" data-inv15-clear="store">清除已保存表 2</button>
          <div id="inv15StoreStatus"></div>
          <details class="inv15-map"><summary>店铺基础列设置</summary><div class="inv15-map-grid" id="inv15StoreBaseMap"></div></details>
        </article>

        <article class="inv15-source-card mabang">
          <div class="inv15-source-head"><span>01</span><div><h3>马帮库存表</h3></div></div>
          <label class="inv15-drop"><input id="inv15MabangFile" data-clear-installed="1" type="file" accept=".xlsx,.xlsm"></label>
          <button class="inv15-clear" type="button" data-inv15-clear="mabang">清除已保存表 1</button>
          <div id="inv15MabangStatus"></div>
          <details class="inv15-map"><summary>马帮基础列设置</summary><div class="inv15-map-grid" id="inv15MabangBaseMap"></div></details>
        </article>

        <article class="inv15-source-card presale">
          <div class="inv15-source-head"><span>03</span><div><h3>店铺预售表</h3></div></div>
          <label class="inv15-drop"><input id="inv15PresaleFile" data-clear-installed="1" type="file" accept=".xlsx,.xlsm"></label>
          <button class="inv15-clear" type="button" data-inv15-clear="presale">清除已保存表 3</button>
          <div id="inv15PresaleStatus"></div>
          <details class="inv15-map"><summary>预售关联列设置</summary><div class="inv15-map-grid" id="inv15PresaleBaseMap"></div></details>
        </article>

        <article class="inv15-source-card combo">
          <div class="inv15-source-head"><span>04</span><div><h3>组合拆分表</h3></div></div>
          <label class="inv15-drop"><input id="inv15ComboFile" data-clear-installed="1" type="file" accept=".xlsx,.xlsm"></label>
          <button class="inv15-clear" type="button" data-inv15-clear="combo">清除已保存表 4</button>
          <div id="inv15ComboStatus"></div>
          <div class="inv15-combo-summary" id="inv15ComboSummary"></div>
        </article>
      </section>

      <section class="inv15-panel inv15-mapping-panel">
        <div class="inv15-panel-head">
          <div><h3>仓库与库存列对应</h3></div>
          <div class="inv15-panel-actions"><span class="chip muted" id="inv15WarehouseCount">2 个仓库</span><button class="btn primary sm" id="inv15AddWarehouse" type="button">＋ 新增仓库</button></div>
        </div>
        <datalist id="inv15WarehouseValues"></datalist><div id="inv15WarehousePicker" popover class="inv15-warehouse-picker"></div>
        <div id="inv15WarehouseList" class="inv15-warehouse-list"></div>
      </section>

      <details class="inv15-panel inv15-special-panel"><summary>特殊 SKU</summary><div class="inv15-special-content">
        <section><h3>跳过识别</h3><div class="inv15-special-inputs"><input id="inv15ExcludeSku" placeholder="SKU 或匹配内容"><select id="inv15ExcludeMode"><option value="exact">完全匹配</option><option value="contains">包含</option></select><button type="button" class="btn primary sm" id="inv15AddExcluded">新增</button></div><div id="inv15ExcludedList"></div></section>
        <section><h3>关联 SKU</h3><div class="inv15-special-inputs"><input id="inv15RelatedFrom" placeholder="原SKU"><span>→</span><input id="inv15RelatedTo" placeholder="替换SKU"><button type="button" class="btn primary sm" id="inv15AddRelated">新增</button></div><div id="inv15RelatedList"></div></section>
      </div></details>
      <section class="inv15-command">
        <div class="inv15-command-inputs">
          <label>分析店铺<select id="inv15StoreSelect"></select></label>
          <label>不足阈值（固定）<input id="inv15Threshold" type="number" value="10" readonly></label>
          <label>超过阈值写入<input id="inv15Overflow" type="number" value="9999" readonly></label>
        </div>
        <div class="inv18-command-actions"><button class="inv15-run" id="inv15Analyze" type="button">执行库存识别</button><button class="btn light" id="inv18Blacklist" type="button">黑名单库</button></div>

      </section>

      <section class="inv15-panel inv15-results-panel">
        <div class="inv15-panel-head results">
          <div><h3>库存判断与人工二次核对</h3></div>
          <div class="inv15-panel-actions"><button class="btn light" id="inv15ExportReview" hidden>导出预览供核对</button><button class="btn light" id="inv15ExportManual" disabled>导出人工处理名单</button><button class="btn primary" id="inv15ExportWorkbook" disabled>导出最终店铺库存表</button></div>
        </div>
        <div id="inv15Audit"></div><label class="inv18-review-confirm"><input type="checkbox" id="inv18Reviewed">已完成二次核对</label><span id="inv18ReviewHint"></span>
        <div class="inv15-metrics" id="inv15Metrics"></div>
        <div class="inv15-toolbar">
          <input id="inv15Search" placeholder="搜索 SKU、店铺标题、马帮商品或原因">
          <select id="inv15Filter">
            <option value="actionable">需要处理</option><option value="unchanged">无需调整</option><option value="all">全部结果</option>
            <option value="changed">只看将修改</option><option value="delist">需下架</option>
            <option value="flow1_original_warehouse">流程一 · 原仓有货</option>
            <option value="flow2_same_sku_other_warehouse">流程二 · 同 SKU 转仓</option>
            <option value="flow3_same_product_replacement">流程三 · 同款换 SKU</option>
            <option value="manual">全部人工处理</option>
            <option value="presale">已开预售</option>
            <option value="anomaly">异常标签</option><option value="special">特殊提示 / 跳过识别</option><option value="related">关联SKU替换</option>
            <option value="relist">下架有货待确认</option><option value="closepresale">有货需关预售</option><option value="blacklist">黑名单冻结</option><option value="processed">已处理</option>
            <option value="combo">组合 SKU</option>
          </select>
          <div class="inv15-filter-status"><span id="inv15ResultCount">尚未分析</span><button type="button" class="btn light sm" id="inv15ShowAll">显示全部</button></div>
        </div>
        <div id="inv15ResultList" class="inv15-result-list"><div class="inv15-empty">四张表就绪后，点击“执行库存识别”。</div></div>
        <div id="inv15More" class="inv15-more"></div>
      </section>`;

    const sourceGrid=q('.inv15-sources',page);for(const kind of ['mabang','store','presale','combo'])sourceGrid.appendChild(q('.inv15-source-card.'+kind,page));
    installCardDropZones(page);
    populateStores();
    q('#inv15StoreScope').textContent = sourceScope('store');
    q('#inv15Threshold').value = String(config.threshold);
    q('#inv15Overflow').value = String(config.overflowValue);
    q('#inv15StoreFile').addEventListener('change', (event) => saveSource('store', event.target.files?.[0]));
    q('#inv15MabangFile').addEventListener('change', (event) => saveSource('mabang', event.target.files?.[0]));
    q('#inv15PresaleFile').addEventListener('change',event=>saveSource('presale',event.target.files?.[0]));
    q('#inv15ComboFile').addEventListener('change', (event) => saveSource('combo', event.target.files?.[0]));
    qa('[data-inv15-clear]').forEach((button) => button.addEventListener('click', () => askClearSource(button.dataset.inv15Clear)));
    q('#inv15AddWarehouse').addEventListener('click', addWarehouse);
    q('#inv15AddExcluded').onclick=()=>addSpecialRule('excluded');q('#inv15AddRelated').onclick=()=>addSpecialRule('related');
    q('#inv15WarehousePicker').onclick=event=>{const button=event.target.closest('[data-inv15-pick-value]');if(!button)return;const row=qa('.inv15-warehouse-row[data-warehouse-id]').find(r=>r.dataset.warehouseId===q('#inv15WarehousePicker').dataset.warehouseId);const input=row?.querySelector('[data-inv15-mabang-value]');if(input){input.value=button.dataset.inv15PickValue;updateWarehouse(input);}q('#inv15WarehousePicker').hidePopover();};
    q('#inv15Analyze').addEventListener('click', analyzeInventory);
    q('#inv18Blacklist').onclick=()=>showBlacklist();
    q('#inv18Reviewed').onchange=event=>{session.reviewed=event.target.checked;q('#inv15ExportWorkbook').disabled=!session.reviewed||!session.audit?.ok||session.reviewDrafts.size>0||session.results.some(r=>r.pendingRelist);};
    q('#inv15ExportReview').addEventListener('click',async()=>{try{const blob=await buildInventoryWorkbook({reviewOnly:true});downloadBlob(blob,`${state.stores.find(x=>x.id===selectedStoreId())?.name||'店铺'}_库存预览_含待确认行_V18.1.xlsx`)}catch(error){toast(error.message,'err')}});
    q('#inv15ExportManual').addEventListener('click', exportManualList);
    q('#inv15ExportWorkbook').addEventListener('click', exportInventoryWorkbook);
    q('#inv15StoreSelect').addEventListener('change', async (event) => {
      closeInventoryDialog();
      session.storeId = event.target.value;config=loadConfig();
      window.selectedStoreId = session.storeId;
      q('#inv15StoreScope').textContent = sourceScope('store');
      await restoreAllSources({ storeOnly: true });
    });
    q('#inv15Threshold').addEventListener('change', (event) => { config.threshold = Math.max(0, engine.number(event.target.value)); saveConfig(); clearAnalysis(); });
    q('#inv15Overflow').addEventListener('change', (event) => { config.overflowValue = Math.max(1, engine.number(event.target.value)); saveConfig(); clearAnalysis(); });
    q('#inv15ShowAll').onclick=()=>{session.filter='all';session.query='';session.page=1;q('#inv15Filter').value='all';q('#inv15Search').value='';renderResults();};
    q('#inv15Filter').addEventListener('change', (event) => { session.filter = event.target.value; session.visibleLimit = 100; renderResults(); });
    let searchTimer;
    q('#inv15Search').addEventListener('input', (event) => {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(() => { session.query = clean(event.target.value); session.visibleLimit = 100; renderResults(); }, 140);
    });
    page.addEventListener('change', (event) => {
      const target = event.target;
      if(target.matches('[data-review-status]'))target.dispatchEvent(new Event('input',{bubbles:true}));
      if (target.matches('[data-inv15-base]')) updateBaseMapping(target);
      if (target.matches('[data-inv15-warehouse-name],[data-inv15-store-column],[data-inv15-mabang-stock],[data-inv15-mabang-value]')) updateWarehouse(target);
      if(target.matches('[data-inv15-choose-warehouse]')&&target.value){const input=target.closest('[data-warehouse-id]').querySelector('[data-inv15-mabang-value]');input.value=target.value;updateWarehouse(input);target.value='';}
    });
    page.addEventListener('input',event=>{if(event.target.closest('[data-review-row]')){resetReview();q('#inv15ExportWorkbook').disabled=true;const row=event.target.closest('[data-review-row]');row.dataset.dirty='true';session.reviewDrafts.set(Number(row.dataset.reviewRow),{finalSku:q('[data-review-sku]',row).value,finalStatus:q('[data-review-status]',row).value,finalStocks:Object.fromEntries(qa('[data-review-stock]',row).map(x=>[x.dataset.reviewStock,x.value]))});}if(event.target.matches('[data-inv15-mabang-value]'))updateWarehouse(event.target);});
    page.addEventListener('click', (event) => {
      const reviewRow=event.target.closest('[data-review-row]');
      if(reviewRow){const r=session.results.find(x=>x.row===Number(reviewRow.dataset.reviewRow));if(!r)return;
        if(event.target.closest('[data-blacklist-row]')){blacklistRow(r);return;}
        const relist=event.target.closest('[data-relist]');if(relist){engine.decideRelist(r,relist.dataset.relist==='yes',stockWarehouses());refreshAudit();return;}
        if(event.target.closest('[data-reconsider]')){Object.assign(r,{finalSku:r.originalSku,finalStatus:r.status,finalStocks:{...r.originalStocks},preserveRow:true,pendingRelist:true,relistDecision:null,flow:'pending_relist',reasons:['下架商品有货或有可换SKU，等待人工同意上架；确认前整行保留']});if(!r.tags.includes('下架商品有货'))r.tags.push('下架商品有货');session.reviewDrafts.delete(r.row);refreshAudit();return;}
        if(event.target.closest('[data-save-review]')){editReviewRow(r.row,reviewRow);return;}
      }

      const openPicker=event.target.closest('[data-inv15-open-warehouse]');if(openPicker){openWarehousePicker(openPicker);return;}
      const removeExcluded=event.target.closest('[data-inv15-remove-excluded]'),removeRelated=event.target.closest('[data-inv15-remove-related]');
      if(removeExcluded||removeRelated){const kind=removeExcluded?'excludedSkus':'relatedSkus',index=Number(removeExcluded?removeExcluded.dataset.inv15RemoveExcluded:removeRelated.dataset.inv15RemoveRelated);config[kind].splice(index,1);saveConfig();clearAnalysis();renderSpecialSkus();return;}
      const clearKeyword=event.target.closest('[data-inv15-clear-keyword]');
      if(clearKeyword){const input=clearKeyword.closest('[data-warehouse-id]').querySelector('[data-inv15-mabang-value]');input.value='';updateWarehouse(input);input.focus();return;}
      const deleteButton = event.target.closest('[data-inv15-delete-warehouse]');
      if (deleteButton) deleteWarehouse(deleteButton.closest('[data-warehouse-id]').dataset.warehouseId);
      const metric = event.target.closest('[data-inv15-filter]');
      if (metric) {
        session.filter = metric.dataset.inv15Filter;
        q('#inv15Filter').value = session.filter;
        session.visibleLimit = 100;session.page=1;
        renderResults();
      }
    });

    window.addEventListener('country-changed', () => {
      closeInventoryDialog();
      if(q('#inv15WarehousePicker').matches(':popover-open'))q('#inv15WarehousePicker').hidePopover();
      for(const id of ['inv15ExcludeSku','inv15RelatedFrom','inv15RelatedTo'])q('#'+id).value='';
      populateStores();config=loadConfig();
      q('#inv15StoreScope').textContent = sourceScope('store');
      // Invalidate immediately; parse saved Excel only when this page is visible.
      ++session.restoreToken;session.restoring=false;sourcesNeedRestore=true;
      session.store=session.presale=session.mabang=session.combo=null;clearAnalysis();
      renderAllInventory();
      if(q('#page-inventory').classList.contains('active'))restoreAllSources();
    });
    q('#nav [data-page="inventory"]')?.addEventListener('click', () => {populateStores();if(!session.store&&!session.restoring)restoreAllSources();});
    window.addEventListener('stores-changed-v14', (event) => {
      const requested = clean(event.detail?.selectedStoreId);
      if ((state?.stores || []).some((store) => store.id === requested)) session.storeId = requested;
      populateStores();
    });

    const previousGo=go;
    go=function(page){const result=previousGo(page);if(page==='inventory'){populateStores();if(sourcesNeedRestore&&!session.restoring)restoreAllSources();}return result;};
    renderAllInventory();
    restoreAllSources();
  }

  function refreshStores() {
    const previous = selectedStoreId();
    populateStores();
    if (selectedStoreId() !== previous) { config=loadConfig();restoreAllSources({ storeOnly: true }); }
  }

  try {
    installPage();
    window.__inventoryV15 = {
      ready: true,
      version: engine.VERSION,
      getConfig: () => JSON.parse(JSON.stringify(config)),
      getSession: () => session,
      saveSourceForTest: saveSource,
      renderForTest: renderResults,
      exportManualForTest: exportManualList,
      getStores: () => (state?.stores || []).map((store) => ({ id: store.id, name: store.name, active: store.active !== false })),
      refreshStores,
      restoreAllSources,
      clearSource,
      analyze: analyzeInventory,
      buildWorkbookForTest: () => buildInventoryWorkbook({reviewOnly:true}),
      buildFinalForTest:()=>buildInventoryWorkbook(),
      verifyWorkbookForTest: verifyInventoryWorkbook,
      engine,
      readBlacklist,writeBlacklist,showBlacklist,blacklistRow,
      decideRelistForTest:(row,approved)=>{engine.decideRelist(session.results.find(x=>x.row===row),approved,stockWarehouses());refreshAudit();},
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
