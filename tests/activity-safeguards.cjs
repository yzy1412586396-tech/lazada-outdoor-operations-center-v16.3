const {app,clipboard}=require('electron'),fs=require('fs'),path=require('path'),assert=require('assert/strict');
const root=process.env.LAZADA_TEST_APP_ROOT||path.resolve(__dirname,'..'),out=process.env.LAZADA_ACTIVITY_TEST_OUTPUT||path.join(require('os').tmpdir(),'lazada-v171-safety');fs.mkdirSync(out,{recursive:true});process.argv.push('--playwright-test');if(process.env.LAZADA_WINDOWS_SURFACE==='1')process.argv.push('--surface-renderer-test');
const timer=setTimeout(()=>app.exit(1),120000);
app.on('browser-window-created',(_,win)=>win.webContents.once('did-finish-load',async()=>{try{
 await new Promise(r=>setTimeout(r,2400));win.setSize(1440,900);
 const report=await win.webContents.executeJavaScript('('+fs.readFileSync(path.join(__dirname,'activity-safeguards-renderer.js'),'utf8')+')()');
 await win.webContents.executeJavaScript('state.activityPriceRatioWarning=0.95;renderActivityResult()');
 await new Promise(r=>setTimeout(r,3200));
 for(const theme of ['glass-light','forest','sand','violet','night']){
  await win.webContents.executeJavaScript(`appearance.theme='${theme}';applyAppearance();go('activity');$('#activityTable').closest('.panel').scrollIntoView();`);await new Promise(r=>setTimeout(r,220));fs.writeFileSync(path.join(out,'preview-'+theme+'.png'),(await win.webContents.capturePage()).toPNG());
 }
 await win.webContents.executeJavaScript(`appearance.theme='glass-light';applyAppearance();go('activity');document.querySelector('.main').scrollTop=0;$('#actPresetTrigger').click()`);await new Promise(r=>setTimeout(r,220));fs.writeFileSync(path.join(out,'form-presets.png'),(await win.webContents.capturePage()).toPNG());
 await win.webContents.executeJavaScript(`$('#actPresetList').hidePopover();$('#v152DownloadsButton').click()`);await new Promise(r=>setTimeout(r,220));
 const menu=await win.webContents.executeJavaScript(`(()=>{const entry=document.querySelector('[data-download-id="v171-test-download"]');if(!entry)throw Error('download fixture missing');entry.dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true,clientX:innerWidth-70,clientY:120}));const menu=document.querySelector('.v152-download-context'),button=menu.querySelector('[data-download-context="copy"]'),rect=button.getBoundingClientRect();return{open:menu.matches(':popover-open'),top:document.elementFromPoint(rect.x+8,rect.y+8)===button,bounds:{x:rect.x,y:rect.y,width:rect.width,height:rect.height}}})()`);assert(menu.open&&menu.top,'context menu top layer hit test');report.downloadMenu=menu;
 await new Promise(r=>setTimeout(r,250));
 fs.writeFileSync(path.join(out,'download-context.png'),(await win.webContents.capturePage()).toPNG());
 await win.webContents.executeJavaScript(`document.querySelector('[data-download-context="copy"]').click()`);await new Promise(r=>setTimeout(r,150));assert.equal(await clipboard.readText(),path.join(out,'menu-test.txt'));
 await win.webContents.executeJavaScript(`document.querySelector('[data-download-id="v171-test-download"]').dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true,clientX:innerWidth-70,clientY:innerHeight-5}));document.querySelector('[data-download-context="remove"]').click()`);await new Promise(r=>setTimeout(r,150));assert((await win.webContents.executeJavaScript('desktopApp.downloads.list()')).every(x=>x.id!=='v171-test-download'));assert(fs.existsSync(path.join(out,'menu-test.txt')),'remove record keeps file');
 await win.webContents.executeJavaScript('desktopApp.database.flush()');const done=new Promise(r=>win.webContents.once('did-finish-load',r));win.reload();await done;await new Promise(r=>setTimeout(r,2000));
 report.reload=await win.webContents.executeJavaScript(`(()=>{const out={};for(const c of ['ph','th']){__opsDebug.switchCountry(c);out[c]={ratio:state.activityPriceRatioWarning,presets:state.presets}}out.my=localStorage.getItem('lazadaOpsMalaysiaSystemV8');return out})()`);
 assert.equal(report.reload.ph.ratio,0.95);assert.equal(report.reload.th.ratio,0.9);assert(report.reload.ph.presets.includes('保留预设')&&!report.reload.ph.presets.includes('待删预设'));assert(report.reload.my.includes('keep-existing-malaysia-data'));
 fs.writeFileSync(path.join(out,'report.json'),JSON.stringify(report,null,2));console.log('ACTIVITY_SAFEGUARDS_OK',JSON.stringify(report));clearTimeout(timer);app.exit(0);
 }catch(e){console.error(e);clearTimeout(timer);app.exit(1)}}));
require(path.join(root,'electron/main.js'));
const fixture=path.join(out,'menu-test.txt');fs.writeFileSync(fixture,'safe UI fixture');fs.writeFileSync(path.join(app.getPath('userData'),'recent-downloads.json'),JSON.stringify([{id:'v171-test-download',name:'右键菜单测试文件.txt',path:fixture,state:'completed',size:15,received:15,completedAt:new Date().toISOString()}]));
