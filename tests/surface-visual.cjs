const {app}=require('electron'),fs=require('fs'),path=require('path');
const root=path.resolve(__dirname,'..'),out=process.env.LAZADA_SURFACE_TEST_OUTPUT;fs.mkdirSync(out,{recursive:true});process.argv.push('--playwright-test','--surface-renderer-test');
const timer=setTimeout(()=>app.exit(1),60000);
app.on('browser-window-created',(_,win)=>win.webContents.once('did-finish-load',async()=>{try{
 await new Promise(r=>setTimeout(r,2400));
 const report=[];
 for(const theme of ['glass-light','forest','sand','violet','night']){
  for(const size of [[1100,700],[1440,900]]){
   win.setBounds({x:0,y:0,width:size[0],height:size[1]});
   await win.webContents.executeJavaScript(`document.documentElement.dataset.desktopPlatform='win32';appearance.theme='${theme}';applyAppearance();go('control')`);
   await new Promise(r=>setTimeout(r,300));
   report.push(await win.webContents.executeJavaScript(`(()=>{const rect=e=>{const b=e.getBoundingClientRect();return{x:b.x,y:b.y,width:b.width,height:b.height}};return{theme:appearance.theme,viewport:{width:innerWidth,height:innerHeight},body:rect(document.body),app:rect(document.querySelector('.app')),clip:getComputedStyle(document.body).clipPath,wrapper:document.querySelector('#desktopWindowSurface')?rect(document.querySelector('#desktopWindowSurface')):null}})()`));
   fs.writeFileSync(path.join(out,theme+'-'+size.join('x')+'.png'),(await win.webContents.capturePage()).toPNG());
  }
 }
 for(const zoom of [1.25,1.5,1]){
  win.webContents.setZoomFactor(zoom);await new Promise(r=>setTimeout(r,200));fs.writeFileSync(path.join(out,'zoom-'+zoom+'.png'),(await win.webContents.capturePage()).toPNG());
 }
 await win.webContents.executeJavaScript(`const overlay=document.createElement('div');overlay.id='surfaceTestOverlay';overlay.style.cssText='position:fixed;inset:0;background:#ff3333;z-index:500000';document.body.appendChild(overlay)`);
 await new Promise(r=>setTimeout(r,200));
 const overlayParent=await win.webContents.executeJavaScript(`document.querySelector('#surfaceTestOverlay').parentElement.id`);if(overlayParent!=='desktopWindowSurface')throw Error('Dynamic overlay bypassed surface');
 fs.writeFileSync(path.join(out,'overlay.png'),(await win.webContents.capturePage()).toPNG());await win.webContents.executeJavaScript(`document.querySelector('#surfaceTestOverlay').remove()`);
 win.windowsSurface.toggleMaximize();await new Promise(r=>setTimeout(r,200));fs.writeFileSync(path.join(out,'maximized.png'),(await win.webContents.capturePage()).toPNG());
 win.windowsSurface.toggleMaximize();await new Promise(r=>setTimeout(r,200));fs.writeFileSync(path.join(out,'restored.png'),(await win.webContents.capturePage()).toPNG());
 win.focus();win.blur();await new Promise(r=>setTimeout(r,200));fs.writeFileSync(path.join(out,'unfocused.png'),(await win.webContents.capturePage()).toPNG());
 win.minimize();await new Promise(r=>setTimeout(r,100));win.restore();await new Promise(r=>setTimeout(r,200));fs.writeFileSync(path.join(out,'minimize-restored.png'),(await win.webContents.capturePage()).toPNG());
 if(report.some(r=>r.wrapper.x!==0||r.wrapper.y!==0||r.wrapper.width!==r.viewport.width||r.wrapper.height!==r.viewport.height))throw Error('Surface not equal to viewport');
 fs.writeFileSync(path.join(out,'report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report));clearTimeout(timer);app.exit(0);
 }catch(e){console.error(e);clearTimeout(timer);app.exit(1)}}));require(path.join(root,'electron/main.js'));
