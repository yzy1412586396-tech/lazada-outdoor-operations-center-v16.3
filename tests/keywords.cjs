const {app}=require('electron'), fs=require('fs'), path=require('path'), assert=require('assert/strict');
const root=path.resolve(__dirname,'..'), out=process.env.LAZADA_KEYWORDS_TEST_OUTPUT;
fs.mkdirSync(out,{recursive:true});process.argv.push('--playwright-test');
const timer=setTimeout(()=>app.exit(1),60000);
app.on('browser-window-created',(_,win)=>win.webContents.once('did-finish-load',async()=>{try{
 await new Promise(r=>setTimeout(r,2300));
 const defaults=await win.webContents.executeJavaScript(`(()=>{__opsDebug.switchCountry('th');return structuredClone(state.titleRules)})()`);
 assert(defaults.pool.include.includes('สระว่ายน้ำ'));
 const expected=await win.webContents.executeJavaScript(`(()=>{document.querySelector('[data-page="settings"]').click();const del=[...document.querySelectorAll('[data-rule-delete]')].find(b=>b.parentElement.textContent.includes('สระว่ายน้ำ'));if(!del)throw Error('UI delete missing');del.click();const removed=state.titleRules.pool.include.includes('สระว่ายน้ำ');if(removed)throw Error('UI delete did not remove Thai word');state.titleRules={pool:{include:['custom pool'],exclude:[]},battery:{include:[],exclude:['custom exception']}};saveState();const th=structuredClone(state.titleRules);__opsDebug.switchCountry('ph');state.titleRules={pool:{include:[],exclude:['custom ph']},battery:{include:['my battery'],exclude:[]}};saveState();const ph=structuredClone(state.titleRules);__opsDebug.switchCountry('th');return{ph,th,afterSwitch:structuredClone(state.titleRules)}})()`);
 assert.deepEqual(expected.th,expected.afterSwitch);
 await win.webContents.executeJavaScript('desktopApp.database.flush()');
 const loaded=new Promise(r=>win.webContents.once('did-finish-load',r));win.reload();await loaded;await new Promise(r=>setTimeout(r,2300));
 const actual=await win.webContents.executeJavaScript(`(()=>{const th=structuredClone(state.titleRules);__opsDebug.switchCountry('ph');const ph=structuredClone(state.titleRules);document.querySelector('[data-page="changelog"]').click();return{th,ph,version:desktopApp.displayVersion,footer:!!document.querySelector('.sidebar-foot'),oldRelease:[...document.querySelectorAll('[data-release-version]')].some(e=>['V16.4.1','V16.4.2'].includes(e.dataset.releaseVersion))}})()`);
 assert.deepEqual(actual.th,expected.th);assert.deepEqual(actual.ph,expected.ph);assert.equal(actual.footer,false);assert.equal(actual.oldRelease,false);assert.equal(actual.version,'17.0');
 const report={newCountryHasDefaults:true,uiDelete:true,countrySwitchAndReloadPreserveEmptyArrays:true,actual};fs.writeFileSync(path.join(out,'report.json'),JSON.stringify(report,null,2));console.log(report);clearTimeout(timer);app.exit(0);
 }catch(e){console.error(e);clearTimeout(timer);app.exit(1)}}));require(path.join(root,'electron/main.js'));
