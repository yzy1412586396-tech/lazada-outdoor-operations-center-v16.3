(function inventoryEngineFactory(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  // Keep this public name for existing inventory UI integrations.
  if (root) root.InventoryEngineV15 = Object.freeze(api);
})(typeof window !== 'undefined' ? window : globalThis, () => {
  'use strict';
  const VERSION = '17.3';
  const TAGS = Object.freeze({PRESALE:'预售',ANOMALY:'异常',UNLISTED:'未上架',OPENED:'已开预售'});
  const clean = value => String(value ?? '').trim();
  const normalizeRawSku = value => clean(value).replace(/\s+/g,'').toUpperCase();
  function parseSku(value) {
    const raw=normalizeRawSku(value),canonical=raw.replace(/S\d+$/i,''),m=canonical.match(/^([TPV][A-Z0-9]{10})(X\d*)?$/);
    return {raw,canonical,kind:m?(m[2]?'combo':'ordinary'):'invalid',base11:m?.[1]||'',key4:m?.[1].slice(-4)||'',suffix:clean(value).match(/S\d+$/i)?.[0]||'',duplicateSuffixRemoved:raw!==canonical};
  }
  function stockNumber(value) {
    if (value==null||clean(value)===''||typeof value==='boolean') return null;
    const n=Number(clean(value).replace(/[,\s\u00a0]/g,''));return Number.isFinite(n)?n:null;
  }
  const number=value=>stockNumber(value)??0;
  function warehouseNameMatches(name,accepted) {
    const keys=(Array.isArray(accepted)?accepted:clean(accepted).split(/[|,，;；]+/)).map(x=>clean(x).toLowerCase()).filter(Boolean);
    return keys.length>0&&keys.some(x=>clean(name).toLowerCase().includes(x));
  }
  const cloneStocks=(stocks,warehouses)=>Object.fromEntries(warehouses.map(w=>[w.id,stocks?.[w.id]??null]));
  const positiveWarehouseIds=(stocks,warehouses)=>warehouses.filter(w=>number(stocks?.[w.id])>0).map(w=>w.id);
  const totalStocks=(stocks,warehouses)=>warehouses.reduce((n,w)=>n+Math.max(0,number(stocks?.[w.id])),0);
  // User-confirmed boundary: 10 is insufficient. Never use the former 30 threshold.
  const cappedStock=actual=>number(actual)>10?9999:null;
  const inactiveStatus=value=>/^inactive$/i.test(clean(value));
  function chooseBestWarehouse(stocks,warehouses) {
    return warehouses.map((warehouse,order)=>({warehouse,order,stock:number(stocks?.[warehouse.id])})).filter(x=>x.stock>0).sort((a,b)=>b.stock-a.stock||a.order-b.order)[0]||null;
  }
  function buildMabangIndex(rows,warehouses) {
    const bySku=new Map(),byKey4=new Map();
    for(const row of rows||[]) {
      const info=parseSku(row.sku);if(info.kind!=='ordinary')continue;
      let rec=bySku.get(info.canonical);
      if(!rec){rec={canonical:info.canonical,exactSku:info.canonical,name:clean(row.name),locations:new Map(),stocks:{},conflict:false,sourceRows:[]};bySku.set(info.canonical,rec)}
      rec.sourceRows.push(row.row);if(!rec.name)rec.name=clean(row.name);
      // Physical warehouse keys prevent adding counts or combining components across two real warehouses.
      const locations=row.locations||warehouses.filter(w=>Object.hasOwn(row.stocks||{},w.id)).map(w=>({key:w.id,warehouseId:w.id,name:w.name,stock:row.stocks[w.id]}));
      for(const loc of locations){const key=clean(loc.key||loc.warehouseId).toLowerCase(),stock=stockNumber(loc.stock),prior=rec.locations.get(key);
        if(stock==null||prior&&(prior.stock!==stock||prior.warehouseId!==loc.warehouseId)){rec.conflict=true;continue}
        rec.locations.set(key,{...loc,key,stock,sourceRow:row.row});rec.stocks[loc.warehouseId]=Math.max(number(rec.stocks[loc.warehouseId]),Math.max(0,stock));
      }
    }
    for(const rec of bySku.values()){rec.best=[...rec.locations.values()].sort((a,b)=>b.stock-a.stock||a.key.localeCompare(b.key))[0]||null;if(!byKey4.has(rec.canonical.slice(-4)))byKey4.set(rec.canonical.slice(-4),[]);byKey4.get(rec.canonical.slice(-4)).push(rec)}
    return{bySku,byKey4};
  }
  // Normalized character edit similarity. Suggestions never trigger an automatic SKU change.
  function nameSimilarity(left,right) {
    const norm=x=>clean(x).normalize('NFKC').toLowerCase().replace(/[\s\p{P}\p{S}]/gu,'');
    const a=Array.from(norm(left)),b=Array.from(norm(right));if(!a.length||!b.length)return 0;if(a.join('')===b.join(''))return 1;
    if(Math.abs(a.length-b.length)/Math.max(a.length,b.length)>.05)return 0;
    let prev=Array.from({length:b.length+1},(_,i)=>i);
    for(let i=1;i<=a.length;i++){const next=[i];for(let j=1;j<=b.length;j++)next[j]=Math.min(next[j-1]+1,prev[j]+1,prev[j-1]+(a[i-1]===b[j-1]?0:1));prev=next}
    return 1-prev[b.length]/Math.max(a.length,b.length);
  }
  function bestAlternative(info,index,current) {
    return (index.byKey4.get(info.key4)||[]).filter(r=>r.canonical!==info.canonical&&!r.conflict&&r.best?.stock>10&&r.best.stock>current)
      .sort((a,b)=>b.best.stock-a.best.stock||a.canonical.localeCompare(b.canonical))[0]||null;
  }
  function auditResults(results,warehouses) {
    const failures=[];for(const r of results){const ids=positiveWarehouseIds(r.finalStocks,warehouses);
      if(r.changed&&ids.length>1)failures.push({row:r.row,reason:'自动修改后出现多仓库存'});
      if(ids.length>1)failures.push({row:r.row,reason:'最终仍有多个仓库库存，请人工修正后重新识别'});
      if(r.presale==='yes'&&r.changed)failures.push({row:r.row,reason:'已开预售行被自动修改'});
      if(r.kind==='combo'&&r.changed)failures.push({row:r.row,reason:'组合行被自动修改'});
      if(r.flow.startsWith('flow')&&(r.actualStock<=10||number(r.finalStocks[r.selectedWarehouseId])!==9999))failures.push({row:r.row,reason:'有货写入不符合 >10 填9999'});
      if(r.flow==='flow3_same_product_replacement'&&parseSku(r.finalSku).suffix!==parseSku(r.originalSku).suffix)failures.push({row:r.row,reason:'替换后原后缀丢失'});
    }
    return{ok:!failures.length,failures,totalRows:results.length,changedRows:results.filter(r=>r.changed).length,unresolvedRows:results.filter(r=>r.manual).length,cleanRows:results.filter(r=>!r.manual).length};
  }
  function analyze(options={}) {
    const warehouses=options.warehouses||[],stockWarehouses=options.stockWarehouses||warehouses;if(!warehouses.length)throw Error('至少需要一个有效仓库映射');
    const index=buildMabangIndex(options.mabangRows,warehouses),results=[];
    for(const source of options.storeRows||[]) {
      const info=parseSku(source.sku),originalStocks=cloneStocks(source.stocks,stockWarehouses),exact=index.bySku.get(info.canonical);
      const r={row:source.row,skuId:clean(source.skuId),title:clean(source.title),status:clean(source.status),originalSku:clean(source.sku),canonicalSku:info.canonical,finalSku:clean(source.sku),kind:info.kind,originalStocks,finalStocks:{...originalStocks},tags:[],reasons:[],flow:'unchanged',selectedWarehouseId:'',actualStock:exact?.best?.stock??0,mabangName:exact?.name||'',componentChecks:[],nameSuggestions:[],alternatives:[],changed:false,manual:false,presale:source.presale||'unknown',presaleReason:source.presaleReason||'',mabangEvidence:exact?[...exact.locations.values()]:[]};
      const mark=(tag,flow,reason)=>{if(!r.tags.includes(tag))r.tags.push(tag);r.flow=flow;r.reasons.push(reason)};
      const apply=(record,flow,reason)=>{r.selectedWarehouseId=record.best.warehouseId;r.actualStock=record.best.stock;r.mabangName=record.name;r.finalStocks=Object.fromEntries(stockWarehouses.map(w=>[w.id,w.id===record.best.warehouseId?9999:null]));r.flow=flow;r.reasons.push(reason)};
      const originalIds=positiveWarehouseIds(originalStocks,stockWarehouses);
      if(r.presale==='yes')mark(TAGS.OPENED,'presale_unchanged','SKU ID 关联预售 Yes，原 SKU、库存和仓库均保持原样');
      else if(r.presale!=='no')mark(TAGS.ANOMALY,'manual_presale_unknown',source.presaleReason||'SKU ID 未找到唯一有效预售状态，保持原样');
      else if(stockWarehouses.some(w=>source.stocks?.[w.id]!=null&&clean(source.stocks[w.id])!==''&&stockNumber(source.stocks[w.id])==null))mark(TAGS.ANOMALY,'manual_invalid_stock','原店铺库存含非数字值，保持原样');
      else if(info.kind==='invalid')mark(TAGS.ANOMALY,'manual_invalid_sku','SKU 格式无效，保持原样');
      else if(originalIds.some(id=>!warehouses.some(w=>w.id===id)))mark(TAGS.ANOMALY,'manual_unmapped_stock','未映射仓库已有正库存，请先补全仓库对应关系；保持原样');
      else if(info.kind==='combo') {
        const def=options.comboMap instanceof Map?options.comboMap.get(info.canonical):options.comboMap?.[info.canonical];r.mabangName=def?.name||'';
        if(!def||def.invalid||def.conflict||!def.components?.length||def.components.some(c=>parseSku(c.sku).kind!=='ordinary'||!Number.isInteger(c.quantity)||c.quantity<=0))mark(TAGS.ANOMALY,'manual_combo_definition',def?.reason||'没有唯一有效的组合拆分定义，保持原样');
        else {
          const merged=new Map();for(const c of def.components)merged.set(parseSku(c.sku).canonical,(merged.get(parseSku(c.sku).canonical)||0)+c.quantity);
          let unknown=false;
          for(const [sku,quantity]of merged){const rec=index.bySku.get(sku);if(!rec||rec.conflict||!rec.locations.size)unknown=true;r.componentChecks.push({sku,quantity,available:rec?.best?.stock??null,name:rec?.name||'',warehouses:rec?[...rec.locations.values()]:[],ok:false})}
          const allKeys=[...new Set(r.componentChecks.flatMap(c=>c.warehouses.map(w=>w.key)))];
          const feasible=allKeys.filter(key=>r.componentChecks.every(c=>c.warehouses.some(w=>w.key===key&&w.stock>=c.quantity))).sort();
          if(unknown)mark(TAGS.ANOMALY,'manual_combo_source','组件库存缺失或冲突，不能判定缺货；组合行保持原样');
          else if(feasible.length){r.commonWarehouse=feasible[0];for(const c of r.componentChecks){c.available=c.warehouses.find(w=>w.key===r.commonWarehouse).stock;c.ok=true}r.flow='combo_healthy';r.reasons.push(`全部组件在同一个马帮仓库“${r.commonWarehouse}”满足所需数量，组合整行保持原样`)}
          else {for(const c of r.componentChecks)c.ok=c.available>=c.quantity;mark(TAGS.PRESALE,'manual_combo_component_stock','没有单一仓库能同时满足全部组件数量，禁止跨仓相加；组合整行保持原样')}
        }
      } else if(!exact||exact.conflict||!exact.best)mark(TAGS.ANOMALY,'manual_mabang_unknown','当前 SKU 在所选马帮仓库中缺少有效库存或库存记录冲突，保持原样');
      else if(exact.best.stock>10)apply(exact,originalIds[0]===exact.best.warehouseId?'flow1_original_warehouse':'flow2_same_sku_other_warehouse',`同 SKU 全部映射仓库中库存最多：${exact.best.name} ${exact.best.stock} 件，写入9999，其余库存清空`);
      else {
        r.alternatives=(index.byKey4.get(info.key4)||[]).filter(rec=>rec.canonical!==info.canonical).map(rec=>({sku:rec.canonical,stock:rec.best?.stock??null,warehouse:rec.best?.name||'',conflict:rec.conflict}));
        const alt=bestAlternative(info,index,exact.best.stock);
        if(alt){r.finalSku=alt.exactSku+info.suffix;apply(alt,'flow3_same_product_replacement',`当前最大可用库存 ${exact.best.stock}≤10，预售 No；同款 ${alt.exactSku} 在 ${alt.best.name} 有 ${alt.best.stock} 件，替换并保留后缀 ${info.suffix||'（无）'}`)}
        else {
          r.finalStocks=Object.fromEntries(stockWarehouses.map(w=>[w.id,null]));mark(TAGS.PRESALE,'manual_no_stock',`当前最大可用库存 ${exact.best.stock}≤10，预售 No，无库存>10的更优同款；所有库存清空，需人工处理`);
          const originalMappedIds=originalIds.length?originalIds:[exact.best.warehouseId];
          for(const rec of index.bySku.values()){if(rec===exact||rec.conflict)continue;const score=nameSimilarity(exact.name,rec.name);if(score<.95)continue;
            for(const loc of rec.locations.values())if(originalMappedIds.includes(loc.warehouseId)&&loc.stock>10&&loc.stock>exact.best.stock)r.nameSuggestions.push({sku:rec.exactSku,name:rec.name,score,warehouse:loc.name,warehouseId:loc.warehouseId,stock:loc.stock})}
          r.nameSuggestions.sort((a,b)=>b.score-a.score||b.stock-a.stock||a.sku.localeCompare(b.sku));r.nameSuggestions=r.nameSuggestions.slice(0,5);
          if(r.nameSuggestions.length)r.reasons.push('发现同映射仓库内中文名称相似度≥95%的有货候选，仅列入人工明细，不自动替换');
        }
      }
      // Final validation follows processing. Ordinary No rows may resolve pre-existing multiwarehouse stock.
      if(positiveWarehouseIds(r.finalStocks,stockWarehouses).length>1){if(!r.tags.includes(TAGS.ANOMALY))r.tags.push(TAGS.ANOMALY);r.reasons.push('最终库存校验发现多个仓库同时有库存，请人工检查')}
      if(positiveWarehouseIds(r.finalStocks,stockWarehouses).length&&inactiveStatus(r.status)){r.tags.push(TAGS.UNLISTED);r.reasons.push('最终库存>0且Status为Inactive，需人工核对上架')}
      r.changed=r.finalSku!==r.originalSku||stockWarehouses.some(w=>r.finalStocks[w.id]!==r.originalStocks[w.id]);r.manual=r.tags.some(t=>t!==TAGS.OPENED);results.push(r);
    }
    // A replacement can collide with another original SellerSKU. Restore those rows rather than invent a suffix.
    const counts=new Map();for(const r of results){const key=normalizeRawSku(r.finalSku);counts.set(key,(counts.get(key)||0)+1)}
    for(const r of results)if(r.finalSku!==r.originalSku&&(counts.get(normalizeRawSku(r.finalSku))>1||results.some(other=>other!==r&&normalizeRawSku(other.originalSku)===normalizeRawSku(r.finalSku)))){r.finalSku=r.originalSku;r.finalStocks=Object.fromEntries(stockWarehouses.map(w=>[w.id,null]));r.changed=stockWarehouses.some(w=>r.originalStocks[w.id]!=null);r.manual=true;r.flow='manual_sku_collision';r.tags.push(TAGS.ANOMALY,TAGS.PRESALE);const original=index.bySku.get(r.canonicalSku);r.mabangName=original?.name||'';r.actualStock=original?.best?.stock??0;r.selectedWarehouseId='';r.reasons.push('替换后的SellerSKU与其他刊登重复，不更换SKU；当前未预售且库存不足，清空库存并列人工确认');if(positiveWarehouseIds(r.finalStocks,stockWarehouses).length>1&&!r.tags.includes(TAGS.ANOMALY))r.tags.push(TAGS.ANOMALY)}
    return{results,audit:auditResults(results,stockWarehouses),index,threshold:10,overflowValue:9999};
  }
  return{VERSION,TAGS,analyze,auditResults,buildMabangIndex,cappedStock,chooseBestWarehouse,inactiveStatus,normalizeRawSku,number,stockNumber,parseSku,positiveWarehouseIds,totalStocks,warehouseNameMatches,nameSimilarity};
});
