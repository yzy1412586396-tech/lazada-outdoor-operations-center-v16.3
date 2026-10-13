(function inventoryEngineFactory(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  // Keep this public name for existing inventory UI integrations.
  if (root) root.InventoryEngineV15 = Object.freeze(api);
})(typeof window !== 'undefined' ? window : globalThis, () => {
  'use strict';
  const VERSION = '17.5';
  const TAGS = Object.freeze({PRESALE:'预售',ANOMALY:'异常',UNLISTED:'未上架',OPENED:'已开预售',ACTIVITY:'活动中'});
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
  function auditResults(results, warehouses) {
    const failures = [], occupied = new Map();
    for (const r of results) occupied.set(normalizeRawSku(r.finalSku), (occupied.get(normalizeRawSku(r.finalSku)) || 0) + 1);
    for (const r of results) {
      const positive = positiveWarehouseIds(r.finalStocks, warehouses);
      if (r.activityProtected) {
        if (r.changed) failures.push({row:r.row, reason:'active 活动保护行被修改'});
        continue; // User explicitly prioritizes active protection over warehouse cleanup.
      }
      if (positive.length > 1) failures.push({row:r.row, reason:'非活动行最终仍有多仓库存'});
      if (r.forbiddenWarehouseIds.some(id => number(r.finalStocks[id]) !== 0 || r.finalStocks[id] == null)) failures.push({row:r.row, reason:'非指定仓未写数字0'});
      if (r.flow.startsWith('flow') && (r.actualStock <= 10 || number(r.finalStocks[r.selectedWarehouseId]) !== 9999)) failures.push({row:r.row, reason:'有货库存不符合>10写9999'});
      if (r.finalSku !== r.originalSku && occupied.get(normalizeRawSku(r.finalSku)) !== 1) failures.push({row:r.row, reason:'替换SKU仍重复'});
      if (r.flow === 'flow3_same_product_replacement' && !r.allocatedSuffix && parseSku(r.finalSku).suffix !== parseSku(r.originalSku).suffix) failures.push({row:r.row, reason:'非冲突替换丢失原后缀'});
    }
    return {ok:!failures.length, failures, totalRows:results.length, changedRows:results.filter(r=>r.changed).length, unresolvedRows:results.filter(r=>r.manual).length, cleanRows:results.filter(r=>!r.manual).length};
  }
  function analyze(options={}) {
    const warehouses=options.warehouses||[], stockWarehouses=options.stockWarehouses||warehouses;
    if (!warehouses.length) throw Error('至少需要一个有效仓库映射');
    const mappedIds=new Set(warehouses.map(w=>w.id)), index=buildMabangIndex(options.mabangRows,warehouses), results=[];
    const comboPolicyCache=new Map();
    function comboPolicy(key){
      if(comboPolicyCache.has(key))return comboPolicyCache.get(key);
      const def=options.comboMap instanceof Map?options.comboMap.get(key):options.comboMap?.[key];
      const result={known:false,low:false,name:def?.name||'',checks:[]};
      if(def&&!def.invalid&&!def.conflict&&def.components?.length&&def.components.every(c=>parseSku(c.sku).kind==='ordinary'&&Number.isInteger(c.quantity)&&c.quantity>0)){
        const merged=new Map();for(const c of def.components)merged.set(parseSku(c.sku).canonical,(merged.get(parseSku(c.sku).canonical)||0)+c.quantity);
        result.known=true;let common=null;
        for(const [sku,quantity]of merged){const rec=index.bySku.get(sku);if(!rec||rec.conflict||!rec.locations.size)result.known=false;
          const locations=rec?[...rec.locations.values()]:[];const keys=new Set(locations.filter(loc=>loc.stock>=quantity).map(loc=>loc.key));
          common=common===null?keys:new Set([...common].filter(k=>keys.has(k)));
          result.checks.push({sku,quantity,name:rec?.name||'',available:rec?.best?.stock??null,warehouses:locations,ok:keys.size>0});
        }
        result.low=result.known&&common.size===0;
      }
      comboPolicyCache.set(key,result);return result;
    }
    for (const source of options.storeRows||[]) {
      const info=parseSku(source.sku), originalStocks=cloneStocks(source.stocks,stockWarehouses), exact=index.bySku.get(info.canonical);
      const r={row:source.row,skuId:clean(source.skuId),title:clean(source.title),status:clean(source.status),originalSku:clean(source.sku),canonicalSku:info.canonical,finalSku:clean(source.sku),kind:info.kind,originalStocks,finalStocks:{...originalStocks},tags:[],reasons:[],flow:'unchanged',selectedWarehouseId:'',actualStock:exact?.best?.stock??0,mabangName:exact?.name||'',componentChecks:[],nameSuggestions:[],alternatives:[],changed:false,manual:false,presale:source.presale||'unknown',presaleReason:source.presaleReason||'',mabangEvidence:exact?[...exact.locations.values()]:[],activityProtected:/^active$/i.test(clean(source.status)),forbiddenWarehouseIds:stockWarehouses.filter(w=>!mappedIds.has(w.id)).map(w=>w.id)};
      const mark=(tag,flow,reason)=>{if(tag&&!r.tags.includes(tag))r.tags.push(tag);r.flow=flow;r.reasons.push(reason)};
      const clear=reason=>{r.finalStocks=Object.fromEntries(stockWarehouses.map(w=>[w.id,0]));mark(null,'stock_cleared',reason)};
      const apply=(record,flow,reason)=>{r.selectedWarehouseId=record.best.warehouseId;r.actualStock=record.best.stock;r.mabangName=record.name;r.finalStocks=Object.fromEntries(stockWarehouses.map(w=>[w.id,w.id===record.best.warehouseId?9999:0]));mark(null,flow,reason)};
      const policy=info.kind==='combo'?comboPolicy(info.canonical):null;
      if(policy){r.mabangName=policy.name;r.componentChecks=policy.checks.map(c=>({...c}));}
      const low=policy?policy.low:!!(exact&&!exact.conflict&&exact.best&&exact.best.stock<=10);
      const unknownStock=policy?!policy.known:!exact||exact.conflict||!exact.best;
      const mappedZero=warehouses.every(w=>number(originalStocks[w.id])===0);
      const allZero=stockWarehouses.every(w=>number(originalStocks[w.id])===0);
      // An already cleared No row is a completed operation, not another shortage report.
      if (info.kind!=='invalid'&&r.presale==='no'&&mappedZero&&(low||(info.kind==='ordinary'&&!exact))&&(!r.activityProtected||allZero)) mark(null,'already_processed','库存不足、未预售，指定仓库存均为0，已处理过，无需操作');
      else if (r.activityProtected) {
        mark((low||unknownStock||r.forbiddenWarehouseIds.some(id=>number(originalStocks[id])>0)||positiveWarehouseIds(originalStocks,stockWarehouses).length>1)?TAGS.ACTIVITY:null,'activity_protected','Status=active，按活动保护规则保留原SKU及全部库存');
        if(low)r.reasons.push('该商品活动中且库存不足，暂不能清除库存或替换SKU');
        else if(unknownStock)r.reasons.push('该商品活动中，库存或组件数据未匹配/冲突，情况待核对，暂不修改');
        if(r.forbiddenWarehouseIds.some(id=>number(originalStocks[id])>0))r.reasons.push('非指定仓仍有库存，但active保护优先，活动结束后再清零');
      }
      else if (r.presale==='yes') mark(TAGS.OPENED,'presale_unchanged','已开预售，保留SKU及指定仓原库存；非指定仓按规则清零');
      else if (r.presale!=='no') mark(TAGS.ANOMALY,'manual_presale_unknown',source.presaleReason||'预售关联未知，指定仓保持原样');
      else if (info.kind==='invalid') mark(TAGS.ANOMALY,'manual_invalid_sku','SKU格式无效，指定仓保持原样');
      else if (warehouses.some(w=>originalStocks[w.id]!=null&&clean(originalStocks[w.id])!==''&&stockNumber(originalStocks[w.id])==null)) mark(TAGS.ANOMALY,'manual_invalid_stock','指定仓原库存含无效数字，请核对');
      else if (info.kind==='combo') {
        r.componentChecks=[];
        const def=options.comboMap instanceof Map?options.comboMap.get(info.canonical):options.comboMap?.[info.canonical];r.mabangName=def?.name||'';
        if(!def||def.invalid||def.conflict||!def.components?.length||def.components.some(c=>parseSku(c.sku).kind!=='ordinary'||!Number.isInteger(c.quantity)||c.quantity<=0))mark(TAGS.ANOMALY,'manual_combo_definition',def?.reason||'组合拆分定义无效，指定仓保持原样');
        else {
          const merged=new Map();for(const c of def.components)merged.set(parseSku(c.sku).canonical,(merged.get(parseSku(c.sku).canonical)||0)+c.quantity);
          let unknown=false;
          for(const [sku,quantity]of merged){const rec=index.bySku.get(sku);if(!rec||rec.conflict||!rec.locations.size)unknown=true;r.componentChecks.push({sku,quantity,available:rec?.best?.stock??null,name:rec?.name||'',warehouses:rec?[...rec.locations.values()]:[],ok:false})}
          const keys=[...new Set(r.componentChecks.flatMap(c=>c.warehouses.map(w=>w.key)))];
          const feasible=keys.filter(key=>r.componentChecks.every(c=>c.warehouses.some(w=>w.key===key&&w.stock>=c.quantity))).sort();
          if(unknown)mark(TAGS.ANOMALY,'manual_combo_source','组件库存数据缺失或冲突，不能确定缺货，指定仓保持原样');
          else if(feasible.length){r.commonWarehouse=feasible[0];for(const c of r.componentChecks){c.available=c.warehouses.find(w=>w.key===r.commonWarehouse).stock;c.ok=true}mark(null,'combo_healthy','同一实际仓库满足全部组件数量，保留组合SKU及指定仓库存')}
          else {for(const c of r.componentChecks)c.ok=c.available>=c.quantity;if(mappedZero&&allZero)mark(null,'already_processed','组合未预售、同仓组件不足且库存已为0，已处理过，无需操作');else clear('组合没有单仓同时满足全部组件数量，未预售，库存清零完成，无需缺货报备')}
        }
      }
      else if(!exact||exact.conflict||!exact.best)mark(TAGS.ANOMALY,'manual_mabang_unknown','马帮数据缺失或冲突，不能确定实际缺货，指定仓保持原样');
      else if(exact.best.stock>10)apply(exact,number(originalStocks[exact.best.warehouseId])>0?'flow1_original_warehouse':'flow2_same_sku_other_warehouse',`最大单仓可用量 ${exact.best.name} ${exact.best.stock}件，写9999，其余仓写0`);
      else {
        r.alternatives=(index.byKey4.get(info.key4)||[]).filter(rec=>rec.canonical!==info.canonical).map(rec=>({sku:rec.canonical,stock:rec.best?.stock??null,warehouse:rec.best?.name||'',conflict:rec.conflict}));
        const alt=bestAlternative(info,index,exact.best.stock);
        if(alt){r.finalSku=alt.exactSku+info.suffix;apply(alt,'flow3_same_product_replacement',`库存≤10且未预售，同款${alt.exactSku}有${alt.best.stock}件，保留原后缀${info.suffix||'（无）'}`)}
        else {
          clear(`最大可用量${exact.best.stock}≤10且未预售，没有有效更优同款，库存清零完成，无需缺货报备`);
          const originalMappedIds=positiveWarehouseIds(originalStocks,warehouses);if(!originalMappedIds.length)originalMappedIds.push(exact.best.warehouseId);
          for(const rec of index.bySku.values()){if(rec===exact||rec.conflict)continue;const score=nameSimilarity(exact.name,rec.name);if(score<.95)continue;for(const loc of rec.locations.values())if(originalMappedIds.includes(loc.warehouseId)&&loc.stock>10&&loc.stock>exact.best.stock)r.nameSuggestions.push({sku:rec.exactSku,name:rec.name,score,warehouse:loc.name,warehouseId:loc.warehouseId,stock:loc.stock})}
          r.nameSuggestions.sort((a,b)=>b.score-a.score||b.stock-a.stock||a.sku.localeCompare(b.sku));r.nameSuggestions=r.nameSuggestions.slice(0,5);
          // Candidates remain visible in this completed row; clearing alone never enters the manual list.
        }
      }
      if(!r.activityProtected){
        for(const id of r.forbiddenWarehouseIds)r.finalStocks[id]=0;
        const positive=positiveWarehouseIds(r.finalStocks,warehouses);
        if(positive.length>1){const best=chooseBestWarehouse(r.finalStocks,warehouses);for(const id of positive)if(id!==best.warehouse.id)r.finalStocks[id]=0;r.reasons.push('指定仓多仓库存已整理，只保留原数量最多的指定仓')}
      }
      r.changed=r.finalSku!==r.originalSku||stockWarehouses.some(w=>{
        const a=r.originalStocks[w.id],b=r.finalStocks[w.id];
        return (a==null||a==='')!==(b==null||b==='')||stockNumber(a)!==stockNumber(b);
      });
      r.manual=r.tags.some(t=>t!==TAGS.OPENED);results.push(r);
    }
    // Reserve all original names and earlier allocations. Never stack S1S2 or rename a protected row.
    const occupied=new Set(results.map(r=>normalizeRawSku(r.originalSku)));
    for(const r of results){if(r.finalSku===r.originalSku)continue;const desired=normalizeRawSku(r.finalSku);
      if(occupied.has(desired)){const base=parseSku(r.finalSku).canonical;let n=1;while(occupied.has(base+'S'+n))n++;r.finalSku=base+'S'+n;r.allocatedSuffix=true;r.reasons.push(`替换SKU重复，自动分配未占用后缀S${n}`)}
      occupied.add(normalizeRawSku(r.finalSku));
    }
    return {results,audit:auditResults(results,stockWarehouses),index,threshold:10,overflowValue:9999};
  }
  return{VERSION,TAGS,analyze,auditResults,buildMabangIndex,cappedStock,chooseBestWarehouse,inactiveStatus,normalizeRawSku,number,stockNumber,parseSku,positiveWarehouseIds,totalStocks,warehouseNameMatches,nameSimilarity};
});
