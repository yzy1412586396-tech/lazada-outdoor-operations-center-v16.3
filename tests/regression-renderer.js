async function(){
 const check=(value,message)=>{if(!value)throw new Error(message)};
 const fileFrom=(base64,name)=>new File([Uint8Array.from(atob(base64),c=>c.charCodeAt(0))],name);
 const source=fileFrom(window.testSource,'real-store.xlsx'),combo=fileFrom(window.testCombo,'real-combo.xlsx');
 const setFile=(id,file)=>{const dt=new DataTransfer();dt.items.add(file);document.getElementById(id).files=dt.files};
 const report={countries:[],exports:[]};
 const original=await openWorkbook(source),mapping=await detectTemplate(original,'repricing'),sheet=await getSheet(original,original.sheets.find(x=>x.path===mapping.sheetPath));
 const realRows=[];for(let r=mapping.dataStartRow;r<=sheet.maxRow;r++){const sku=normalizeSku(cellValue(sheet,r,mapping.skuCol));if(sku)realRows.push({sku,r,special:toFloat(cellValue(sheet,r,mapping.specialPriceCol)),price:toFloat(cellValue(sheet,r,mapping.priceCol)),title:cellValue(sheet,r,mapping.titleCol)})}
 check(realRows.length>200,'real source rows detected');
 const combos=await parseRepricingComboWorkbook(combo);
 const blank=realRows.find(x=>x.special==null&&x.price!=null&&!/X/.test(x.sku));check(blank,'real blank ordinary row');
 const comboRow=realRows.find(x=>x.special==null&&/X/.test(x.sku)&&combos.items.has(window.__skuSuffixV14.normalizeCombo(x.sku)));check(comboRow,'real blank combo row');
 const def=combos.items.get(window.__skuSuffixV14.normalizeCombo(comboRow.sku));
 report.source={rows:realRows.length,blank:realRows.filter(x=>x.special==null).length,comboDefinitions:combos.items.size,blankSku:blank.sku,comboSku:comboRow.sku,comboDefinition:def};
 for(const country of ['ph','th','my']){
  window.__opsDebug.switchCountry(country);
  const db=state.databases[0].id;
  const records=def.components.map((x,i)=>({sku:x.sku,la_price:100+i*10,product_name_cn:'测试组件',library_type:'ordinary',database_id:db,is_forbidden:0}));
  const ordinary=country==='th'?window.__opsDebug.thaiStripStoreSuffix(blank.sku):stripTrailingSVariant(blank.sku);
  records.push({sku:ordinary,la_price:777.25,product_name_cn:'测试单品',library_type:'ordinary',database_id:db,is_forbidden:0});
  state.controlRecords=records;state.controlConflicts=[];state.aliases=[];state.titleRules={pool:{include:[],exclude:[]},battery:{include:[],exclude:[]}};
  saveState();go('repricing');
  setFile('repricingFile',source);setFile('repricingComboFile',combo);
  $('#repEarlyBirdRule').value='protect';$('#repEarlyBirdRule').onchange();
  await $('#analyzeRepricingBtn').onclick();check(repricingSession,'protected session exists');
  check(repricingSession.results.find(x=>x.sellerSku===blank.sku).statusCode==='early_bird',country+' protected ordinary');
  check(!repricingWillPatch(repricingSession.results.find(x=>x.sellerSku===comboRow.sku)),country+' protected combo');
  const protectBlob=await cloneAndPatch(repricingSession,'repricing');
  report.exports.push({name:country+'-protect.xlsx',bytes:Array.from(new Uint8Array(await protectBlob.arrayBuffer()))});
  $('#repEarlyBirdRule').value='ignore';$('#repEarlyBirdRule').onchange();check(!repricingSession,'changing rule invalidates result');
  const started=performance.now();await $('#analyzeRepricingBtn').onclick();const elapsed=performance.now()-started;
  check(repricingSession,'ignore session exists');
  const row=repricingSession.results.find(x=>x.sellerSku===blank.sku),bundle=repricingSession.results.find(x=>x.sellerSku===comboRow.sku);
  check(repricingWillPatch(row)&&row.suggestedPrice===777.25,country+' empty special filled from direct price');
  check(repricingWillPatch(bundle)&&bundle.matchMethod==='combo_components',country+' empty bundle filled from components');
  check(repricingSession.results.length===realRows.length,'all real SKU rows retained');
  check($('#repricingTable').children.length===100,'preview bounded to100');
  $('#repNext').click();check(repricingPage===2,'paging');
  row.applyChange=false;check(!repricingWillPatch(row),'uncheck excludes patch');row.applyChange=true;
  row.manualPrice=812.34;check(repricingFinalPrice(row)===812.34,'manual override');row.manualPrice=null;
  const blob=await cloneAndPatch(repricingSession,'repricing');const wb=await openWorkbook(await blob.arrayBuffer());const sh=await getSheet(wb,wb.sheets.find(x=>x.path===mapping.sheetPath));
  check(cellValue(sh,blank.r,mapping.specialPriceCol)===777.25,'exported blank numeric price');
  check(cellValue(sh,comboRow.r,mapping.specialPriceCol)===bundle.suggestedPrice,'exported combo price');
  for(const r of realRows){check(cellValue(sh,r.r,mapping.skuCol)===cellValue(sheet,r.r,mapping.skuCol),'SKU unchanged');check(cellValue(sh,r.r,mapping.priceCol)===cellValue(sheet,r.r,mapping.priceCol),'Price unchanged')}
  report.exports.push({name:country+'-ignore.xlsx',bytes:Array.from(new Uint8Array(await blob.arrayBuffer()))});
  report.countries.push({country,analysisMs:Math.round(elapsed),patchCount:repricingPatchRows().length,blankPrice:row.suggestedPrice,comboPrice:bundle.suggestedPrice,storedRule:state.repricingProtectEarlyBird});
 }
 for(const country of ['ph','th','my']){
  window.__opsDebug.switchCountry(country);const db=state.databases[0].id;
  const testRows=[['SellerSKU','SpecialPrice','Price','商品标题'],['T4EE0000001',null,200,'测试'],['T4EE0000002',150,200,'测试'],['T4EE0000003',null,200,'测试'],['T4EE0000004',null,200,'测试'],['T4EE0000005',null,200,'测试'],['T4EE0000006',100,200,'测试'],['T4EE0000007',null,null,'测试']];
  const w=XLSX.utils.book_new();XLSX.utils.book_append_sheet(w,XLSX.utils.aoa_to_sheet(testRows),'template');
  const file=new File([XLSX.write(w,{type:'array',bookType:'xlsx'})],'edge-cases.xlsx');
  state.controlRecords=[1,2,3,4,6,7].map(i=>({sku:'T4EE000000'+i,la_price:i===4?0:100,library_type:'ordinary',database_id:db,is_forbidden:i===4?1:0}));
  state.controlConflicts=[{sku:'T4EE0000003',library_type:'ordinary',database_id:db,records:[]}];saveState();
  setFile('repricingFile',file);$('#repricingComboFile').value='';$('#repEarlyBirdRule').value='ignore';$('#repEarlyBirdRule').onchange();await $('#analyzeRepricingBtn').onclick();check(repricingSession,'edge session exists');
  const rows=repricingSession.results,find=i=>rows.find(x=>x.sellerSku==='T4EE000000'+i);
  check(repricingWillPatch(find(1)),'blank direct');check(repricingWillPatch(find(2)),'existing special updated');check(!repricingWillPatch(find(3))&&find(3).statusCode==='control_conflict','conflict preserved');check(!repricingWillPatch(find(4))&&find(4).statusCode==='forbidden','invalid forbidden preserved');check(!repricingWillPatch(find(5))&&find(5).statusCode==='unmatched','missing control preserved');check(!repricingWillPatch(find(6))&&find(6).statusCode==='unchanged','same price preserved');check(repricingWillPatch(find(7)),'blank special and Price');
  report.countries.find(x=>x.country===country).edgeCases=7;
 }
 window.__opsDebug.switchCountry('ph');check($('#repEarlyBirdRule').value==='ignore','ph setting restored');
 $('#repEarlyBirdRule').value='protect';$('#repEarlyBirdRule').onchange();window.__opsDebug.switchCountry('th');check($('#repEarlyBirdRule').value==='ignore','th setting independent');
 window.__opsDebug.switchCountry('ph');check($('#repEarlyBirdRule').value==='protect','ph setting independent');
 window.__opsDebug.switchCountry('th');go('repricing');setFile('repricingFile',source);setFile('repricingComboFile',combo);await $('#analyzeRepricingBtn').onclick();
 report.drag={native:getComputedStyle(document.querySelector('.v155-window-brand')).getPropertyValue('-webkit-app-region'),blur:getComputedStyle(document.querySelector('.panel')).backdropFilter};
 check(report.drag.native==='drag','native dragging enabled');check(report.drag.blur==='none','blur disabled');
 const latest=document.querySelector('#page-changelog .changelog-list .release-card');
 check(latest?.dataset.releaseVersion==='V17.0','latest release appears first');
 check(document.title.includes('17.0'),'window version updated');
 report.release={version:latest.dataset.releaseVersion,latestFirst:true};
 report.ok=true;return report;
}
