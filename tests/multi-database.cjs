const {app}=require('electron'),fs=require('fs'),path=require('path'),assert=require('assert/strict');
const root=path.resolve(__dirname,'..'),out=process.env.LAZADA_MULTI_OUTPUT;fs.mkdirSync(out,{recursive:true});app.setPath('appData',path.join(out,'profile'));process.argv.push('--playwright-test','--surface-renderer-test');
const files=Object.fromEntries(['local','cross','conflict','activity'].map(n=>[n,fs.readFileSync(path.join(out,n+'.xlsx')).toString('base64')]));
const timer=setTimeout(()=>app.exit(1),120000);
app.on('browser-window-created',(_,win)=>win.webContents.once('did-finish-load',async()=>{try{
 await new Promise(r=>setTimeout(r,2000));
 const result=await win.webContents.executeJavaScript(`window.multiFiles=${JSON.stringify(files)};(${fs.readFileSync(path.join(__dirname,'multi-database-renderer.js'),'utf8')})()`);
 await win.webContents.executeJavaScript('desktopApp.database.flush()');
 fs.writeFileSync(path.join(out,'control-three-countries.png'),(await win.webContents.capturePage()).toPNG());
 const done=new Promise(r=>win.webContents.once('did-finish-load',r));win.reload();await done;await new Promise(r=>setTimeout(r,2000));
 const reloaded=await win.webContents.executeJavaScript(`(()=>{const out={};for(const c of ['ph','th','my']){__opsDebug.switchCountry(c);out[c]={selections:structuredClone(state.databaseSelections),records:structuredClone(state.controlRecords),conflicts:structuredClone(state.controlConflicts)};}go('repricing');return out})()`);
 for(const c of ['ph','th','my']){assert.deepEqual(reloaded[c].records,result[c].records);assert.deepEqual(reloaded[c].conflicts,result[c].conflicts);assert.deepEqual(reloaded[c].selections,result[c].selections);}
 fs.writeFileSync(path.join(out,'repricing-malaysia.png'),(await win.webContents.capturePage()).toPNG());
 await win.webContents.executeJavaScript("go('activity')");await new Promise(r=>setTimeout(r,200));fs.writeFileSync(path.join(out,'activity-malaysia.png'),(await win.webContents.capturePage()).toPNG());
 await win.webContents.executeJavaScript("go('control')");await new Promise(r=>setTimeout(r,200));fs.writeFileSync(path.join(out,'control-malaysia.png'),(await win.webContents.capturePage()).toPNG());
 win.setBounds({width:1100,height:700});await new Promise(r=>setTimeout(r,200));fs.writeFileSync(path.join(out,'control-small.png'),(await win.webContents.capturePage()).toPNG());
 fs.writeFileSync(path.join(out,'report.json'),JSON.stringify({ok:true,result,reloaded},null,2));console.log('MULTI_DATABASE_OK');clearTimeout(timer);app.exit(0);
 }catch(e){console.error(e);clearTimeout(timer);app.exit(1)}}));require(path.join(root,'electron/main.js'));
