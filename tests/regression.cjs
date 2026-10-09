const {app,BrowserWindow}=require('electron');
const fs=require('fs');
const path=require('path');
const base=path.resolve(process.env.LAZADA_TEST_OUTPUT || path.join(require('os').tmpdir(),'lazada-16.4-regression'));fs.mkdirSync(path.join(base,'work'),{recursive:true});
const root=path.resolve(__dirname,'..');
app.setPath('appData',path.join(base,'work/test-profile'));
process.argv.push('--playwright-test');
const source=fs.readFileSync(process.env.LAZADA_TEST_STORE);
const combo=fs.readFileSync(process.env.LAZADA_TEST_COMBO);
const timeout=setTimeout(()=>{console.error('REGRESSION TIMEOUT');app.exit(1)},120000);
app.on('browser-window-created',(_,win)=>{
 win.webContents.once('did-finish-load',async()=>{
  try {
   await new Promise(r=>setTimeout(r,1700));
   const code=fs.readFileSync(path.join(__dirname,'regression-renderer.js'),'utf8');
   const report=await win.webContents.executeJavaScript(`window.testSource=${JSON.stringify(source.toString('base64'))};window.testCombo=${JSON.stringify(combo.toString('base64'))};(${code})()`);
   for(const item of report.exports){fs.writeFileSync(path.join(base,'work',item.name),Buffer.from(item.bytes));delete item.bytes}
   await new Promise(r=>setTimeout(r,800));
   const reloaded=new Promise(r=>win.webContents.once('did-finish-load',r));win.webContents.reload();await reloaded;await new Promise(r=>setTimeout(r,1700));
   report.reload=await win.webContents.executeJavaScript(`(()=>{window.__opsDebug.switchCountry('ph');const ph=document.querySelector('#repEarlyBirdRule').value;window.__opsDebug.switchCountry('th');const th=document.querySelector('#repEarlyBirdRule').value;return{ph,th,ok:ph==='protect'&&th==='ignore'}})()`);
   if(!report.reload.ok)throw new Error('settings did not persist across reload');
   const initial=win.getBounds();for(const width of [1100,1200,1440,1300,1500]){win.setBounds({...initial,width,height:800});await new Promise(r=>setTimeout(r,30));if(win.getBounds().width!==width)throw new Error('resize bounds unstable')};win.setBounds(initial);
   report.resize={opaque:!win.isDestroyed(),sizesChecked:5};
   fs.writeFileSync(path.join(base,'work/regression-report.json'),JSON.stringify(report,null,2));
   fs.writeFileSync(path.join(base,'work/preview.png'),(await win.webContents.capturePage()).toPNG());
   console.log(JSON.stringify(report,null,2));
   clearTimeout(timeout);app.exit(0);
  }catch(e){console.error(e);clearTimeout(timeout);app.exit(1)}
 });
});
require(path.join(root,'electron/main.js'));
