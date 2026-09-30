(function inventoryEngineFactory(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.InventoryEngineV15 = Object.freeze(api);
})(typeof window !== 'undefined' ? window : globalThis, () => {
  'use strict';

  const VERSION = '15.0';
  const TAGS = Object.freeze({
    PRESALE: '预售',
    ANOMALY: '异常',
    UNLISTED: '未上架',
  });

  function clean(value) {
    return String(value ?? '').trim();
  }

  function normalizeRawSku(value) {
    return clean(value).replace(/\s+/g, '').toUpperCase();
  }

  function parseSku(value) {
    const raw = normalizeRawSku(value);
    const canonical = raw.replace(/S\d+$/i, '');
    const ordinary = canonical.match(/^([TP][A-Z0-9]{10})$/i);
    const combo = canonical.match(/^([TP][A-Z0-9]{10})(X\d*)$/i);
    const kind = combo ? 'combo' : ordinary ? 'ordinary' : 'invalid';
    const base11 = combo ? combo[1].toUpperCase() : ordinary ? ordinary[1].toUpperCase() : '';
    return {
      raw,
      canonical,
      kind,
      base11,
      key4: base11 ? base11.slice(-4) : '',
      duplicateSuffixRemoved: raw !== canonical,
    };
  }

  function number(value) {
    if (value === null || value === undefined || value === '' || typeof value === 'boolean') return 0;
    if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
    const parsed = Number(clean(value).replace(/[, \s₱฿¥￥]/g, ''));
    return Number.isFinite(parsed) ? parsed : 0;
  }

  function warehouseNameMatches(actualName, acceptedValues) {
    const actual = clean(actualName).toLowerCase();
    const accepted = (Array.isArray(acceptedValues) ? acceptedValues : clean(acceptedValues).split(/[|,，;；]+/))
      .map((value) => clean(value).toLowerCase())
      .filter(Boolean);
    if (!accepted.length) return true;
    return accepted.some((keyword) => actual.includes(keyword));
  }

  function cloneStocks(stocks, warehouses) {
    return Object.fromEntries(warehouses.map((warehouse) => [warehouse.id, stocks?.[warehouse.id] ?? null]));
  }

  function totalStocks(stocks, warehouses) {
    return warehouses.reduce((sum, warehouse) => sum + Math.max(0, number(stocks?.[warehouse.id])), 0);
  }

  function positiveWarehouseIds(stocks, warehouses) {
    return warehouses.filter((warehouse) => number(stocks?.[warehouse.id]) > 0).map((warehouse) => warehouse.id);
  }

  function cappedStock(actual, threshold = 30, overflowValue = 9999) {
    const available = Math.max(0, number(actual));
    return available > Math.max(0, number(threshold)) ? overflowValue : available;
  }

  function chooseBestWarehouse(stocks, warehouses) {
    return warehouses
      .map((warehouse, order) => ({ warehouse, order, stock: Math.max(0, number(stocks?.[warehouse.id])) }))
      .filter((item) => item.stock > 0)
      .sort((left, right) => right.stock - left.stock || left.order - right.order)[0] || null;
  }

  function buildMabangIndex(rows, warehouses) {
    const bySku = new Map();
    for (const row of rows || []) {
      const info = parseSku(row.sku);
      if (info.kind !== 'ordinary') continue;
      const sourceSku = clean(row.sku);
      let record = bySku.get(info.canonical);
      if (!record) {
        record = {
          canonical: info.canonical,
          exactSku: info.duplicateSuffixRemoved ? info.canonical : sourceSku,
          name: clean(row.name),
          stocks: Object.fromEntries(warehouses.map((warehouse) => [warehouse.id, 0])),
          sourceSkus: new Set(),
        };
        bySku.set(info.canonical, record);
      }
      if (!info.duplicateSuffixRemoved) record.exactSku = sourceSku;
      if (!record.name && row.name) record.name = clean(row.name);
      record.sourceSkus.add(info.raw);
      for (const warehouse of warehouses) {
        record.stocks[warehouse.id] += Math.max(0, number(row.stocks?.[warehouse.id]));
      }
    }

    const byKey4 = new Map();
    for (const record of bySku.values()) {
      record.total = totalStocks(record.stocks, warehouses);
      record.sourceSkus = [...record.sourceSkus];
      const key4 = record.canonical.slice(-4);
      if (!byKey4.has(key4)) byKey4.set(key4, []);
      byKey4.get(key4).push(record);
    }
    return { bySku, byKey4 };
  }

  function bestAlternative(info, index, warehouses) {
    const candidates = [];
    for (const record of index.byKey4.get(info.key4) || []) {
      if (record.canonical === info.canonical) continue;
      const best = chooseBestWarehouse(record.stocks, warehouses);
      if (best) candidates.push({ record, best });
    }
    return candidates.sort((left, right) => (
      right.best.stock - left.best.stock
      || left.record.canonical.localeCompare(right.record.canonical)
      || left.best.order - right.best.order
    ))[0] || null;
  }

  function sameStocks(left, right, warehouses) {
    return warehouses.every((warehouse) => {
      const a = left?.[warehouse.id];
      const b = right?.[warehouse.id];
      if ((a === null || a === '') && (b === null || b === '')) return true;
      return number(a) === number(b) && !((a === null || a === '') !== (b === null || b === ''));
    });
  }

  function addTag(result, tag) {
    if (!result.tags.includes(tag)) result.tags.push(tag);
  }

  function inactiveStatus(value) {
    return /(^|\s|[_-])inactive($|\s|[_-])/i.test(clean(value));
  }

  function comboEntry(comboMap, canonical) {
    if (!comboMap) return null;
    if (comboMap instanceof Map) return comboMap.get(canonical) || null;
    return comboMap[canonical] || null;
  }

  function applyStockDecision(result, warehouseId, actualStock, flow, reason, warehouses, threshold, overflowValue) {
    result.finalStocks = Object.fromEntries(warehouses.map((warehouse) => [warehouse.id, null]));
    result.finalStocks[warehouseId] = cappedStock(actualStock, threshold, overflowValue);
    result.selectedWarehouseId = warehouseId;
    result.actualStock = actualStock;
    result.flow = flow;
    result.reasons.push(reason);
  }

  function analyze(options = {}) {
    const warehouses = Array.isArray(options.warehouses) ? options.warehouses.filter((item) => item?.id) : [];
    if (!warehouses.length) throw new Error('至少需要一个有效仓库映射');
    const threshold = Math.max(0, number(options.threshold ?? 30));
    const overflowValue = Math.max(1, number(options.overflowValue ?? 9999));
    const index = buildMabangIndex(options.mabangRows || [], warehouses);
    const results = [];

    for (const source of options.storeRows || []) {
      const info = parseSku(source.sku);
      const sourceSku = clean(source.sku);
      const originalStocks = cloneStocks(source.stocks, warehouses);
      const result = {
        row: source.row,
        title: clean(source.title),
        status: clean(source.status),
        originalSku: sourceSku,
        canonicalSku: info.canonical,
        finalSku: sourceSku,
        kind: info.kind,
        originalStocks,
        finalStocks: cloneStocks(originalStocks, warehouses),
        tags: [],
        reasons: [],
        flow: 'unchanged',
        selectedWarehouseId: '',
        actualStock: 0,
        mabangName: '',
        componentChecks: [],
        changed: false,
        manual: false,
      };
      const openedWarehouses = positiveWarehouseIds(originalStocks, warehouses);

      if (openedWarehouses.length > 1) {
        addTag(result, TAGS.ANOMALY);
        result.flow = 'manual_multi_store_warehouse';
        result.reasons.push(`店铺表同一 SKU 有 ${openedWarehouses.length} 个仓库库存大于 0，按安全规则保持整行原样`);
      } else if (info.kind === 'invalid') {
        addTag(result, TAGS.ANOMALY);
        result.flow = 'manual_invalid_sku';
        result.reasons.push('SKU 不符合“11 位普通 SKU / 11 位 SKU + X 或 X数字”的规则，保持整行原样');
      } else if (info.kind === 'combo') {
        const definition = comboEntry(options.comboMap, info.canonical);
        if (!definition || definition.invalid || definition.conflict) {
          addTag(result, TAGS.ANOMALY);
          result.flow = 'manual_combo_definition';
          result.reasons.push(definition?.reason || '组合拆分表中没有找到该组合 SKU 的有效拆分关系');
        } else {
          const missing = [];
          for (const component of definition.components || []) {
            const componentInfo = parseSku(component.sku);
            const required = Math.max(1, number(component.quantity || 1));
            const record = componentInfo.kind === 'ordinary' ? index.bySku.get(componentInfo.canonical) : null;
            const available = record ? totalStocks(record.stocks, warehouses) : 0;
            const check = {
              sku: componentInfo.canonical || normalizeRawSku(component.sku),
              quantity: required,
              available,
              name: record?.name || '',
              ok: available >= required,
            };
            result.componentChecks.push(check);
            if (!check.ok) missing.push(check);
          }
          if (!result.componentChecks.length) {
            addTag(result, TAGS.ANOMALY);
            result.flow = 'manual_combo_definition';
            result.reasons.push('组合拆分定义没有有效的普通 SKU 组件');
          } else if (missing.length) {
            addTag(result, TAGS.PRESALE);
            result.flow = 'manual_combo_component_stock';
            result.reasons.push(`组合组件库存不足：${missing.map((item) => `${item.sku} 需要 ${item.quantity}，可用 ${item.available}`).join('；')}；组合行保持原样`);
          } else {
            result.flow = 'combo_healthy';
            result.reasons.push(`组合的 ${result.componentChecks.length} 个普通 SKU 组件库存均满足对应数量，组合行保持原样`);
          }
        }
      } else {
        const currentWarehouseId = openedWarehouses[0] || '';
        const exact = index.bySku.get(info.canonical);
        result.mabangName = exact?.name || '';
        if (currentWarehouseId && number(exact?.stocks?.[currentWarehouseId]) > 0) {
          const actual = number(exact.stocks[currentWarehouseId]);
          const warehouse = warehouses.find((item) => item.id === currentWarehouseId);
          applyStockDecision(result, currentWarehouseId, actual, 'flow1_original_warehouse', `${warehouse?.name || currentWarehouseId} 对应 SKU 可用库存 ${actual}，按阈值写入店铺库存`, warehouses, threshold, overflowValue);
        } else {
          const sameSkuBest = exact ? chooseBestWarehouse(exact.stocks, warehouses) : null;
          if (sameSkuBest) {
            applyStockDecision(result, sameSkuBest.warehouse.id, sameSkuBest.stock, 'flow2_same_sku_other_warehouse', `原店铺仓库无货；同一 SKU 在 ${sameSkuBest.warehouse.name} 可用库存 ${sameSkuBest.stock}，已选择库存最多的仓库`, warehouses, threshold, overflowValue);
          } else {
            const alternative = bestAlternative(info, index, warehouses);
            if (alternative) {
              result.finalSku = alternative.record.exactSku;
              result.mabangName = alternative.record.name;
              applyStockDecision(result, alternative.best.warehouse.id, alternative.best.stock, 'flow3_same_product_replacement', `原 SKU 全仓无货；后四位 ${info.key4} 匹配到 ${alternative.record.exactSku}，${alternative.best.warehouse.name} 可用库存 ${alternative.best.stock}`, warehouses, threshold, overflowValue);
            } else {
              addTag(result, TAGS.PRESALE);
              result.flow = 'manual_no_stock';
              result.reasons.push(exact
                ? `马帮商品“${exact.name || exact.canonical}”所有映射仓库均无货，且未找到后四位 ${info.key4} 相同的有货 SKU；整行保持原样`
                : `马帮未找到 ${info.canonical}，且未找到后四位 ${info.key4} 相同的有货 SKU；整行保持原样`);
            }
          }
        }
      }

      const finalPositive = positiveWarehouseIds(result.finalStocks, warehouses);
      if (finalPositive.length > 0 && inactiveStatus(result.status)) {
        addTag(result, TAGS.UNLISTED);
        result.reasons.push('最终店铺库存大于 0，但 Status 为 Inactive，需要人工上架或核对商品状态');
      }
      result.changed = result.finalSku !== result.originalSku || !sameStocks(result.originalStocks, result.finalStocks, warehouses);
      result.manual = result.tags.length > 0;
      results.push(result);
    }

    const audit = auditResults(results, warehouses, threshold, overflowValue);
    return { results, audit, index, threshold, overflowValue };
  }

  function auditResults(results, warehouses, threshold = 30, overflowValue = 9999) {
    const failures = [];
    let changedRows = 0;
    let unresolvedRows = 0;
    for (const result of results || []) {
      const positives = positiveWarehouseIds(result.finalStocks, warehouses);
      if (result.changed) changedRows += 1;
      if (result.manual) unresolvedRows += 1;
      if (result.changed && positives.length > 1) failures.push({ row: result.row, reason: '系统修改后的行出现多个仓库库存' });
      if (positives.length > 1 && !result.tags.includes(TAGS.ANOMALY)) failures.push({ row: result.row, reason: '多仓库存行未标记异常' });
      if (result.flow.startsWith('flow')) {
        const value = number(result.finalStocks[result.selectedWarehouseId]);
        const expected = cappedStock(result.actualStock, threshold, overflowValue);
        if (value !== expected) failures.push({ row: result.row, reason: `写入库存 ${value} 与规则值 ${expected} 不一致` });
      }
      if (result.flow === 'flow3_same_product_replacement' && parseSku(result.finalSku).duplicateSuffixRemoved) {
        failures.push({ row: result.row, reason: '替换 SKU 仍包含 S数字 后缀' });
      }
    }
    return {
      ok: failures.length === 0,
      failures,
      totalRows: (results || []).length,
      changedRows,
      unresolvedRows,
      cleanRows: (results || []).length - unresolvedRows,
    };
  }

  return {
    VERSION,
    TAGS,
    analyze,
    auditResults,
    buildMabangIndex,
    cappedStock,
    chooseBestWarehouse,
    inactiveStatus,
    normalizeRawSku,
    number,
    parseSku,
    positiveWarehouseIds,
    totalStocks,
    warehouseNameMatches,
  };
});
