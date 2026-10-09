const {app}=require('electron'),fs=require('fs'),path=require('path');
const root=path.resolve(__dirname,'..');
const out=path.resolve(process.env.LAZADA_APPEARANCE_TEST_OUTPUT||path.join(require('os').tmpdir(),'lazada-appearance-check'));fs.mkdirSync(out,{recursive:true});app.setPath('appData',path.join(out,'profile'));process.argv.push('--playwright-test');
const timer=setTimeout(()=>app.exit(1),90000);
app.on('browser-window-created',(_,win)=>win.webContents.once('did-finish-load',async()=>{try{
 await new Promise(r=>setTimeout(r,2500));win.setSize(1440,900);
 let reports=[];
 for(const theme of ['glass-light','forest','sand','violet','night']){
 const result=await win.webContents.executeJavaScript(`(async()=>{appearance.theme='${theme}';applyAppearance();document.querySelector('[data-page="settings"]').click();document.querySelector('#appearancePanel').scrollIntoView();await document.fonts.ready;await new Promise(r=>setTimeout(r,350));const p=document.querySelector('#appearancePanel'),button=p.querySelector('.btn.primary');return{theme:document.documentElement.dataset.theme,font:document.fonts.check('14px "Lazada Noto"'),cards:p.querySelectorAll('.theme-card').length,background:getComputedStyle(p).backgroundColor,button:getComputedStyle(button).backgroundColor,round:getComputedStyle(document.querySelector('.app')).borderRadius,transparency:!!document.querySelector('#backgroundTransparency'),frameTheme:document.querySelector('iframe').contentDocument.documentElement.dataset.theme}})()`);
 await new Promise(r=>setTimeout(r,200));fs.writeFileSync(path.join(out,theme+'.png'),(await win.webContents.capturePage()).toPNG());reports.push(result);
 }
 await win.webContents.executeJavaScript(`document.querySelector('#appearanceFontFamily').value='serif';document.querySelector('#appearanceFontFamily').onchange();document.fonts.ready`);
 const choices=await win.webContents.executeJavaScript(`(()=>{document.querySelector('#appearanceFontSize').value='16';document.querySelector('#appearanceFontSize').onchange();document.querySelector('#appearanceButtonStyle').value='pill';document.querySelector('#appearanceButtonStyle').onchange();return{font:getComputedStyle(document.querySelector('#appearancePanel .btn')).fontSize,radius:getComputedStyle(document.querySelector('#appearancePanel .btn')).borderRadius}})()`);
 const reload=new Promise(r=>win.webContents.once('did-finish-load',r));win.reload();await reload;await new Promise(r=>setTimeout(r,2300));const persisted=await win.webContents.executeJavaScript(`({theme:appearance.theme,fontSize:appearance.fontSize,buttonStyle:appearance.buttonStyle,fontFamily:appearance.fontFamily})`);
 if(persisted.fontFamily!=='serif'||persisted.theme!=='night'||choices.font!=='16px'||choices.radius!=='24px')throw Error('Appearance persistence failed');
 fs.writeFileSync(path.join(out,'report.json'),JSON.stringify({reports,choices,persisted},null,2));console.log(JSON.stringify({reports,choices,persisted}));clearTimeout(timer);app.exit(0);
 }catch(e){console.error(e);clearTimeout(timer);app.exit(1)}}));require(path.join(root,'electron/main.js'));
