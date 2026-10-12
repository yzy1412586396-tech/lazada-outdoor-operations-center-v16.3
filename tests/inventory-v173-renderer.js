async()=>{
 const check=(x,m)=>{if(!x)throw Error(m)},api=window.__inventoryV15,sleep=ms=>new Promise(r=>setTimeout(r,ms));
 check(api?.ready,'inventory ready');go('inventory');await sleep(500);
 const records=window.inventoryFixtures;for(const [kind,entry]of Object.entries(records)){const bytes=Uint8Array.from(atob(entry.base64),c=>c.charCodeAt(0));await api.saveSourceForTest(kind,new File([bytes],entry.name));check(api.getSession()[kind],'parsed '+kind)}
 check(document.querySelector('#inv15KnowledgeReady').textContent.startsWith('4 / 4'),'four source slots');
 const cfg=api.getConfig();check(cfg.storeSkuId==='5'&&cfg.presaleSkuId==='5'&&cfg.presaleEnable==='6','SKU ID + Enable detected');check(cfg.threshold===10,'legacy30 migrated');check(cfg.warehouses.every(w=>w.mabangStockColumn==='29'),'available stock column AC29, not bin stock T20');
 check(cfg.warehouses.find(w=>w.id==='cfs').storeColumn==='17','CFS detected');check(cfg.warehouses.find(w=>w.id==='gaoyi').storeColumn==='15','highyi detected');
 const start=performance.now();await api.analyze();const ms=performance.now()-start,session=api.getSession();
 check(session.results.length===469,'all469 rows despite A1 dimension '+session.results.length);check(session.audit&&session.audit.failures.length===2&&session.audit.failures.every(x=>x.reason.includes('最终仍有多个仓库')),'only2 unresolved original multiwarehouse rows');check(document.querySelector('#inv15ExportWorkbook').disabled,'final export blocked on multiwarehouse');
 for(const r of session.results){if(r.presale==='yes')check(!r.changed,'presale Yes unchanged');if(r.kind==='combo')check(!r.changed,'combo unchanged');if(r.changed)check(Object.values(r.finalStocks).filter(x=>Number(x)>0).length<=1,'one warehouse');if(r.finalSku!==r.originalSku)check(api.engine.parseSku(r.originalSku).suffix===api.engine.parseSku(r.finalSku).suffix,'suffix preserved')}
 check(document.querySelectorAll('.inv15-result').length===100,'bounded100 DOM');document.querySelector('#inv15Next').click();check(document.querySelectorAll('.inv15-result').length===100,'second page');
 const blob=await api.buildWorkbookForTest(),buffer=await blob.arrayBuffer();const verification=await api.verifyWorkbookForTest(buffer,[...cfg.warehouses.filter(w=>w.storeColumn&&w.mabangStockColumn),...api.getSession().store.columns.filter(c=>/仓|warehouse/i.test(c.h)&&!cfg.warehouses.some(w=>Number(w.storeColumn)===c.c)).map(c=>({id:'unmapped-'+c.c,name:c.h,storeColumn:String(c.c)}))]);
 const bytes=Array.from(new Uint8Array(buffer));
 const results=session.results.map(r=>({...r}));
 session.filter='manual';session.page=1;api.renderForTest();
 const before=session.results;session.results=Array.from({length:10000},(_,i)=>({...before[i%before.length],row:i+5}));session.page=1;const begin=performance.now();api.renderForTest();const tenKms=performance.now()-begin;check(document.querySelectorAll('.inv15-result').length===100,'10k capped');session.results=before;session.page=1;api.renderForTest();
 const report={rows:results.length,analysisMs:ms,preview10kMs:tenKms,audit:session.audit,presales:Object.fromEntries(['yes','no','unknown'].map(k=>[k,results.filter(r=>r.presale===k).length])),flows:Object.fromEntries([...new Set(results.map(r=>r.flow))].map(k=>[k,results.filter(r=>r.flow===k).length])),sources:Object.fromEntries(Object.keys(records).map(k=>[k,{name:session[k].name,updatedAt:session[k].updatedAt}])),verification,results,bytes};
 const originalDownload=downloadBlob;let manualBlob;downloadBlob=(b)=>{manualBlob=b};try{api.exportManualForTest()}finally{downloadBlob=originalDownload};report.manualBytes=Array.from(new Uint8Array(await manualBlob.arrayBuffer()));
 return report;
}
