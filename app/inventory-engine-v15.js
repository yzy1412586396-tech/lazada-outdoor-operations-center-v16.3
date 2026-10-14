(function inventoryEngineFactory(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  // Keep this public name for existing inventory UI integrations.
  if (root) root.InventoryEngineV15 = Object.freeze(api);
})(typeof window !== 'undefined' ? window : globalThis, () => {
  'use strict';
  const VERSION = '18.1';
  const TAGS = Object.freeze({PRESALE:'预售',ANOMALY:'异常',UNLISTED:'未上架',OPENED:'已开预售',SPECIAL:'特殊提示'});
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
  // V18: active/inactive are listing states, never campaign protection.
  function recalculate(r,warehouses){
    r.changed=r.finalSku!==r.originalSku||r.finalStatus!==r.status||warehouses.some(w=>{
      const a=r.originalStocks[w.id],b=r.finalStocks[w.id];
      return (a==null||a==='')!==(b==null||b==='')||stockNumber(a)!==stockNumber(b);
    });
    r.manual=!!(!r.blacklisted&&(r.pendingRelist||r.tags.includes(TAGS.ANOMALY)||r.needsClosePresale));
    return r;
  }
  function auditResults(results,warehouses){
    const failures=[],occupied=new Map();
    for(const r of results)occupied.set(normalizeRawSku(r.finalSku),(occupied.get(normalizeRawSku(r.finalSku))||0)+1);
    for(const r of results){
      recalculate(r,warehouses);
      if(r.preserveRow){if(r.changed)failures.push({row:r.row,reason:'冻结原行被修改'});continue;}
      if(r.forbiddenWarehouseIds.some(id=>stockNumber(r.finalStocks[id])!==0))failures.push({row:r.row,reason:'非指定仓必须为数字0'});
      if(!r.preserveMappedStocks&&positiveWarehouseIds(r.finalStocks,warehouses).length>1)failures.push({row:r.row,reason:'最终库存不能多仓有货'});
      if(!['active','inactive'].includes(clean(r.finalStatus).toLowerCase()))failures.push({row:r.row,reason:'Status必须为active或inactive'});
      if(r.finalSku!==r.originalSku&&occupied.get(normalizeRawSku(r.finalSku))!==1)failures.push({row:r.row,reason:'替换SKU重复'});
      if(!r.manualEdited&&!r.preserveMappedStocks&&r.selectedWarehouseId&&number(r.finalStocks[r.selectedWarehouseId])!==9999)failures.push({row:r.row,reason:'系统分配的有货仓应写9999'});
    }
    return{ok:!failures.length,failures,totalRows:results.length,changedRows:results.filter(r=>r.changed).length,unresolvedRows:results.filter(r=>r.manual).length,cleanRows:results.filter(r=>!r.manual).length};
  }
  function applyReview(r,patch,results,warehouses){
    if(r.blacklisted||r.frozen)throw Error('冻结商品不能修改，请先移出黑名单或调整跳过规则');
    if(r.pendingRelist)throw Error('请先选择同意上架或保持下架');
    const next={...r,finalStocks:{...r.finalStocks},tags:[...r.tags]};
    if(patch.finalSku!==undefined){if(!clean(patch.finalSku))throw Error('SellerSKU不能为空');next.finalSku=clean(patch.finalSku);}
    if(patch.finalStatus!==undefined){if(!['active','inactive'].includes(patch.finalStatus))throw Error('Status只能是active或inactive');next.finalStatus=patch.finalStatus;}
    if(patch.finalStocks)for(const [id,value]of Object.entries(patch.finalStocks)){const n=stockNumber(value);if(n===null||n<0||!Number.isInteger(n))throw Error('库存必须为非负整数');next.finalStocks[id]=n;}
    if(results.some(x=>x!==r&&(normalizeRawSku(x.finalSku)===normalizeRawSku(next.finalSku)||x.proposal&&normalizeRawSku(x.proposal.finalSku)===normalizeRawSku(next.finalSku))))throw Error('此SKU已被其他商品或待上架建议占用');
    next.preserveRow=false;next.preserveMappedStocks=false;next.manualEdited=true;
    const audit=auditResults(results.map(x=>x===r?next:x),warehouses);if(!audit.ok)throw Error(audit.failures.map(x=>'第'+x.row+'行：'+x.reason).join('；'));
    Object.assign(r,next);return r;
  }
  function decideRelist(r,approved,warehouses){
    if(r.blacklisted||r.frozen)throw Error('冻结商品不能上架');
    if(!r.pendingRelist||!r.proposal)throw Error('此商品没有待确认上架建议');
    r.pendingRelist=false;r.relistDecision=approved?'approved':'kept';r.reasons=r.reasons.filter(x=>!x.startsWith('下架商品有货或有可换SKU'));
    r.tags=r.tags.filter(t=>t!=='下架商品有货');
    if(approved){Object.assign(r,{finalSku:r.proposal.finalSku,finalStocks:{...r.proposal.finalStocks},finalStatus:'active',selectedWarehouseId:r.proposal.selectedWarehouseId,preserveRow:false,preserveMappedStocks:false,flow:'relisted'});r.reasons.push('已人工同意上架，应用建议SKU及仓库');}
    else{r.preserveRow=true;r.flow='kept_inactive';r.reasons.push('已选择保持下架，原行保留');}
    recalculate(r,warehouses);return r;
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
    // Explicit related-product rules are only a fallback after same-product
    // candidates. A replacement must have >10 capacity in one mapped warehouse.
    function linkedReplacement(info){
      for(const rule of options.relatedSkus||[]){
        if(!rule.from||!rule.to||parseSku(rule.from).canonical!==info.canonical)continue;
        const target=parseSku(rule.to);if(target.canonical===info.canonical)continue;
        const ordinary=index.bySku.get(target.canonical);
        if(target.kind==='ordinary'&&ordinary&&!ordinary.conflict&&ordinary.best?.stock>10)return ordinary;
        if(target.kind==='combo'){
          const policy=comboPolicy(target.canonical);if(!policy.known||policy.low)continue;
          const keys=[...new Set(policy.checks.flatMap(c=>c.warehouses.map(w=>w.key)))];
          const available=keys.map(key=>{const loc=policy.checks[0].warehouses.find(w=>w.key===key);const stock=Math.min(...policy.checks.map(c=>Math.floor((c.warehouses.find(w=>w.key===key)?.stock??0)/c.quantity)));return loc&&stock>10?{...loc,stock}:null}).filter(Boolean).sort((a,b)=>b.stock-a.stock||a.key.localeCompare(b.key));
          if(available.length)return{canonical:target.canonical,exactSku:target.canonical,name:policy.name,best:available[0]};
        }
      }
      return null;
    }
    const blocked=new Set((options.blacklistIds||[]).map(clean));
    for(const source of options.storeRows||[]){
      const info=parseSku(source.sku),exact=index.bySku.get(info.canonical),originalStocks=cloneStocks(source.stocks,stockWarehouses);
      const r={row:source.row,skuId:clean(source.skuId),title:clean(source.title),status:clean(source.status),finalStatus:clean(source.status),originalSku:clean(source.sku),canonicalSku:info.canonical,finalSku:clean(source.sku),kind:info.kind,originalStocks,finalStocks:{...originalStocks},tags:[],reasons:[],flow:'unchanged',selectedWarehouseId:'',actualStock:exact?.best?.stock??0,mabangName:exact?.name||'',componentChecks:[],nameSuggestions:[],alternatives:[],changed:false,manual:false,presale:source.presale||'unknown',presaleReason:source.presaleReason||'',mabangEvidence:exact?[...exact.locations.values()]:[],activityProtected:false,forbiddenWarehouseIds:stockWarehouses.filter(w=>!mappedIds.has(w.id)).map(w=>w.id)};
      const mark=(tag,flow,reason)=>{if(tag&&!r.tags.includes(tag))r.tags.push(tag);r.flow=flow;r.reasons.push(reason)};
      const freeze=(tag,flow,reason)=>{r.preserveRow=true;mark(tag,flow,reason)};
      const policy=info.kind==='combo'?comboPolicy(info.canonical):null;
      if(policy){r.mabangName=policy.name;r.componentChecks=policy.checks;}
      // Left-hand SKU keeps its own source name even when final SKU is replaced.
      r.originalMabangName=r.mabangName;
      const low=policy?policy.low:!!(exact&&!exact.conflict&&exact.best&&exact.best.stock<=10);
      const unknown=policy?!policy.known:!exact||exact.conflict||!exact.best;
      const mappedZero=warehouses.every(w=>number(originalStocks[w.id])===0);
      const excluded=(options.excludedSkus||[]).some(rule=>{const sku=normalizeRawSku(rule.sku);return sku&&(rule.mode==='contains'?info.raw.includes(sku):info.raw===sku)});
      let target=null,flow='flow1_original_warehouse';
      if(!unknown&&!low){
        if(info.kind==='ordinary'){target=exact;flow=number(originalStocks[exact.best.warehouseId])>0?'flow1_original_warehouse':'flow2_same_sku_other_warehouse';}
        else{
          const keys=policy.checks[0]?.warehouses.map(w=>w.key)||[];
          const available=keys.map(key=>{const loc=policy.checks[0].warehouses.find(w=>w.key===key);const stock=Math.min(...policy.checks.map(c=>Math.floor((c.warehouses.find(w=>w.key===key)?.stock??0)/c.quantity)));return loc&&stock>0?{...loc,stock}:null}).filter(Boolean).sort((a,b)=>b.stock-a.stock||a.key.localeCompare(b.key));
          if(available.length)target={canonical:info.canonical,exactSku:info.canonical,name:policy.name,best:available[0]};flow='combo_healthy';
        }
      }else if(!unknown&&low){target=(info.kind==='ordinary'?bestAlternative(info,index,exact.best.stock):null)||linkedReplacement(info);flow=target&&info.kind==='ordinary'&&target.canonical.slice(-4)===info.key4?'flow3_same_product_replacement':'related_sku_replacement';}
      r.hasStock=!!target;
      if(blocked.has(r.skuId)){r.blacklisted=true;r.frozen=true;freeze(null,'blacklisted','店铺黑名单冻结，原行保留');}
      else if(excluded){r.frozen=true;freeze(null,'special_excluded','已设置跳过识别，原行保留');}
      else if(info.kind==='invalid'){r.frozen=true;freeze(TAGS.SPECIAL,'special_invalid_sku','SKU格式特殊，原行保留');}
      else if(!r.skuId)freeze(TAGS.ANOMALY,'manual_sku_id','SKU ID缺失，不能安全关联预售及黑名单');
      else if(!['active','inactive'].includes(r.status.toLowerCase()))freeze(TAGS.ANOMALY,'manual_status','上下架状态未知，原行保留');
      else if(unknown)freeze(TAGS.ANOMALY,policy?'manual_combo_source':'manual_mabang_unknown','库存数据缺失或冲突，不能确定缺货，原行保留');
      else if(r.presale!=='yes'&&r.presale!=='no')freeze(TAGS.ANOMALY,'manual_presale_unknown',source.presaleReason||'预售状态未知，原行保留');
      else if(warehouses.some(w=>originalStocks[w.id]!=null&&clean(originalStocks[w.id])!==''&&stockNumber(originalStocks[w.id])===null))freeze(TAGS.ANOMALY,'manual_invalid_stock','指定仓原库存含无效数字，原行保留');
      else if(target){
        r.actualStock=target.best.stock;r.selectedWarehouseId=target.best.warehouseId;r.mabangName=target.name;
        const targetSku=target.canonical===info.canonical?r.originalSku:target.exactSku+info.suffix;
        const targetStocks=Object.fromEntries(stockWarehouses.map(w=>[w.id,w.id===target.best.warehouseId?9999:0]));
        if(r.presale==='yes'){r.needsClosePresale=true;r.tags.push('有货需关预售');}
        if(inactiveStatus(r.status)){
          r.proposal={finalSku:targetSku,finalStocks:targetStocks,selectedWarehouseId:target.best.warehouseId};r.pendingRelist=true;
          freeze('下架商品有货','pending_relist','下架商品有货或有可换SKU，等待人工同意上架；确认前整行保留');
        }else{r.finalSku=targetSku;r.finalStocks=targetStocks;mark(null,flow,'有货，选择最大单仓可用量 '+target.best.name+' '+target.best.stock+'；该仓写9999，其余仓写0');}
      }else if(low&&r.presale==='no'){
        r.preserveMappedStocks=true;
        if(mappedZero)mark(null,'already_processed','确认缺货、未预售、无替换且指定仓库存已为0，保留上下架状态及指定仓库存');
        else{r.finalStatus='inactive';mark(null,'shortage_inactive','确认缺货、未预售且无替换，改为inactive，指定仓库存保持原值');}
      }else{r.preserveMappedStocks=true;mark(null,'presale_unchanged','缺货已开预售且无有货替换，保留SKU、上下架及指定仓库存');}
      if(!r.preserveRow){for(const id of r.forbiddenWarehouseIds)r.finalStocks[id]=0;}
      recalculate(r,stockWarehouses);
      if(!r.changed&&!r.manual&&!r.preserveRow){r.preserveRow=true;if(r.flow.startsWith('flow')){r.flow='already_compliant';r.reasons=['库存已符合目标，无需调整'];}}
      results.push(r);
    }
    // Reserve proposed relist names too, so later approval cannot create a collision.
    const occupied=new Set(results.map(r=>normalizeRawSku(r.originalSku)));
    for(const r of results){const proposal=r.proposal;const name=proposal?proposal.finalSku:r.finalSku;if(name===r.originalSku)continue;let allocated=name;
      if(occupied.has(normalizeRawSku(name))){const base=parseSku(name).canonical;let n=1;while(occupied.has(base+'S'+n))n++;allocated=base+'S'+n;r.allocatedSuffix=true;r.reasons.push('替换SKU重复，分配后缀S'+n);}
      if(proposal)proposal.finalSku=allocated;else r.finalSku=allocated;occupied.add(normalizeRawSku(allocated));recalculate(r,stockWarehouses);
    }
    return {results,audit:auditResults(results,stockWarehouses),index,threshold:10,overflowValue:9999};
  }
  return{VERSION,TAGS,analyze,auditResults,applyReview,decideRelist,recalculate,buildMabangIndex,cappedStock,chooseBestWarehouse,inactiveStatus,normalizeRawSku,number,stockNumber,parseSku,positiveWarehouseIds,totalStocks,warehouseNameMatches,nameSimilarity};
});
