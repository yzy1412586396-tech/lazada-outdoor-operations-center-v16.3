const {app}=require('electron'),fs=require('fs'),path=require('path'),assert=require('node:assert/strict');
const root=process.env.LAZADA_TEST_APP_ROOT||path.resolve(__dirname,'..'),out=process.env.LAZADA_SWITCH_OUTPUT||'/tmp/lazada-v176-switch';fs.mkdirSync(out,{recursive:true});app.setPath('appData',path.join(out,'profile'));process.argv.push('--playwright-test');
const stock=fs.readFileSync(path.join(require('os').homedir(),'Downloads/1791797791.xlsx')).toString('base64');
const timer=setTimeout(()=>app.exit(1),120000);
app.on('browser-window-created',(_,win)=>win.webContents.once('did-finish-load',async()=>{try{
 await new Promise(r=>setTimeout(r,2400));win.setSize(1440,900);
 const result=await win.webContents.executeJavaScript(`(async()=>{
 const check=(x,m)=>{if(!x)throw Error(m)},sleep=ms=>new Promise(r=>setTimeout(r,ms));
 const api=__inventoryV15;check(api.ready,'inventory loaded');__opsDebug.switchCountry('ph');go('inventory');await sleep(200);
 await api.saveSourceForTest('mabang',new File([Uint8Array.from(atob('${stock}'),c=>c.charCodeAt(0))],'1791797791.xlsx'));
 const source=api.getSession().mabang;check(source,'source ready');
 let input=document.querySelector('[data-inv15-mabang-value]');input.value='typed';input.dispatchEvent(new Event('input',{bubbles:true}));check(api.getConfig().warehouses[0].mabangValue==='typed','typing saved');
 document.querySelector('[data-inv15-clear-keyword]').click();check(input.value===''&&api.getConfig().warehouses[0].mabangValue==='','clear without fallback');
 document.querySelector('[data-inv15-open-warehouse]').click();const choices=document.querySelectorAll('[data-inv15-pick-value]');check(choices.length>0,'full warehouse picker');const name=choices[0].dataset.inv15PickValue;choices[0].click();check(input.value===name&&api.getConfig().warehouses[0].mabangValue===name,'picker applied');
 document.querySelector('[data-inv15-clear-keyword]').click();
 document.querySelector('.inv15-special-panel').open=true;
 document.querySelector('#inv15ExcludeSku').value='1850591';document.querySelector('#inv15ExcludeMode').value='contains';document.querySelector('#inv15AddExcluded').click();
 document.querySelector('#inv15RelatedFrom').value='T5HH1850591';document.querySelector('#inv15RelatedTo').value='P1EE1111234';document.querySelector('#inv15AddRelated').click();
 check(api.getConfig().excludedSkus.length===1&&api.getConfig().relatedSkus.length===1,'special rules saved');
 const makeStore=(shift)=>{const book=XLSX.utils.book_new(),header=shift?['SellerSKU','sku.skuId','Status','extra1','extra2','CFS','高易']:['SellerSKU','sku.skuId','Status','CFS','高易'];const sheet=XLSX.utils.aoa_to_sheet([header,[],[],[],shift?['T5HH1850591','1','inactive','','',20,0]:['T5HH1850591','1','inactive',20,0]]);XLSX.utils.book_append_sheet(book,sheet,'库存');return new File([XLSX.write(book,{type:'array',bookType:'xlsx'})],'store.xlsx');};
 await api.saveSourceForTest('store',makeStore(false));check(api.getConfig().warehouses[0].storeColumn==='4','first template mapped');
 const originalStore=api.getSession().storeId;state.stores.push({id:'v176-second',name:'第二店铺',active:true});api.refreshStores();const storeSelect=document.querySelector('#inv15StoreSelect');storeSelect.value='v176-second';storeSelect.dispatchEvent(new Event('change',{bubbles:true}));await sleep(200);
 check(api.getConfig().warehouses[0].mabangValue===''&&api.getConfig().relatedSkus.length===1,'country template reused by other store');
 await api.saveSourceForTest('store',makeStore(true));check(api.getConfig().warehouses[0].storeColumn==='6'&&api.getConfig().warehouses[1].storeColumn==='7','new store maps moved columns by header');
 storeSelect.value=originalStore;storeSelect.dispatchEvent(new Event('change',{bubbles:true}));await sleep(200);
 __opsDebug.switchCountry('th');check(api.getConfig().relatedSkus.length===0,'Thai rules isolated');__opsDebug.switchCountry('ph');await sleep(200);
 check(api.getConfig().excludedSkus.length===1&&api.getConfig().relatedSkus.length===1,'PH rules restored');
 document.querySelector('[data-inv15-remove-excluded]').click();document.querySelector('[data-inv15-remove-related]').click();check(api.getConfig().excludedSkus.length===0&&api.getConfig().relatedSkus.length===0,'rules removable');
 go('activity');state.controlRecords=Array.from({length:10000},(_,i)=>({sku:'T1EE'+String(i).padStart(7,'0'),database_id:state.databases[0].id,library_type:'ordinary',la_price:100,regular_price:90,campaign_price:80,product_name_cn:'性能测试'}));saveState();
 let hiddenRenders=0,oldRender=renderControl;renderControl=function(){hiddenRenders++;return oldRender()};
 const times=[];for(let i=0;i<6;i++){const begin=performance.now();__opsDebug.switchCountry(i%2?'ph':'th');times.push(performance.now()-begin);check(document.querySelector('.page.active').id==='page-activity','stay in activity');check(!api.getSession().mabang,'hidden inventory invalidated');check(!activitySession&&!repricingSession,'old analysis invalidated');}
 renderControl=oldRender;check(hiddenRenders===0,'no hidden control renders');check(state.controlRecords.length===10000,'country state retained');
 for(const page of ['stores','control','settings','history','expenses','changelog','inventory']){go(page);const expected=document.querySelector('.page.active').id;__opsDebug.switchCountry('th');check(document.querySelector('.page.active').id===expected,'retain '+page);__opsDebug.switchCountry('ph');check(document.querySelector('.page.active').id===expected,'return '+page);await sleep(200);}
 await sleep(500);check(api.getSession().mabang===source,'reuse parsed source by isolated slot');check(api.getConfig().warehouses[0].mabangValue==='','empty keyword survives switch');
 document.querySelector('#inv15WarehouseList').scrollIntoView({behavior:'instant',block:'center'});await sleep(400);return{ok:true,times,hiddenRenders,warehouseNames:document.querySelector('#inv15WarehouseValues').children.length,keyword:api.getConfig().warehouses[0].mabangValue};
 })()`);
 assert(result.ok);fs.writeFileSync(path.join(out,'warehouse-editor.png'),(await win.webContents.capturePage()).toPNG());
 await win.webContents.executeJavaScript(`appearance.theme='night';applyAppearance();if(getComputedStyle(document.querySelector('.inv15-warehouse-row')).backgroundColor==='rgba(255, 255, 255, 0.34)')throw Error('legacy translucent warehouse background');document.querySelector('#inv15WarehouseList').scrollIntoView({behavior:'instant',block:'center'})`);await new Promise(r=>setTimeout(r,250));fs.writeFileSync(path.join(out,'warehouse-night.png'),(await win.webContents.capturePage()).toPNG());
 const reload=new Promise(r=>win.webContents.once('did-finish-load',r));win.reload();await reload;await new Promise(r=>setTimeout(r,2300));const reloaded=await win.webContents.executeJavaScript(`({keyword:__inventoryV15.getConfig().warehouses[0].mabangValue,records:state.controlRecords.length})`);assert.equal(reloaded.keyword,'');assert.equal(reloaded.records,10000);
 fs.writeFileSync(path.join(out,'report.json'),JSON.stringify({result,reloaded},null,2));console.log('COUNTRY_V176_OK',JSON.stringify({result,reloaded}));clearTimeout(timer);app.exit(0);
 }catch(e){console.error(e);clearTimeout(timer);app.exit(1)}}));require(path.join(root,'electron/main.js'));
