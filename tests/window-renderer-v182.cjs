// Rendering on this host does NOT certify Windows HWND hit testing or DWM.
const {app}=require('electron'),fs=require('fs'),path=require('path'),assert=require('node:assert/strict');
const root=process.env.LAZADA_TEST_APP_ROOT||path.resolve(__dirname,'..'),out=process.env.LAZADA_WINDOW_OUTPUT||'/tmp/lazada-v182-renderer';fs.mkdirSync(out,{recursive:true});process.argv.push('--playwright-test','--surface-renderer-test');
const wait=ms=>new Promise(r=>setTimeout(r,ms)),timer=setTimeout(()=>app.exit(1),90000);
app.on('browser-window-created',(_,win)=>win.webContents.once('did-finish-load',async()=>{try{await wait(2000);const states=[];
 for(const theme of ['glass-light','forest','sand','violet','night'])for(const size of [[900,560],[1440,900]]){
  win.setSize(...size);await win.webContents.executeJavaScript(`appearance.theme='${theme}';applyAppearance();go('inventory')`);await wait(100);
  const state=await win.webContents.executeJavaScript(`(()=>{const s=document.querySelector('#desktopWindowSurface'),r=s.getBoundingClientRect();return{theme:appearance.theme,width:innerWidth,height:innerHeight,surfaceWidth:r.width,surfaceHeight:r.height,radius:getComputedStyle(s).borderBottomRightRadius,bodyBg:getComputedStyle(document.body).backgroundColor}})()`);
  assert.equal(state.radius,'22px');assert.equal(state.bodyBg,'rgba(0, 0, 0, 0)');assert.equal(state.width,state.surfaceWidth);assert.equal(state.height,state.surfaceHeight);states.push(state);fs.writeFileSync(path.join(out,theme+'-'+size.join('x')+'.png'),(await win.webContents.capturePage()).toPNG());
 }
 for(const zoom of [1.25,1.5,1]){win.webContents.setZoomFactor(zoom);await wait(100);fs.writeFileSync(path.join(out,'zoom-'+zoom+'.png'),(await win.webContents.capturePage()).toPNG());}
 await win.webContents.executeJavaScript(`const el=document.createElement('div');el.id='clipProbe';el.style.cssText='position:fixed;inset:0;background:#e02030;z-index:9999999';document.body.appendChild(el)`);await wait(100);
 assert.equal(await win.webContents.executeJavaScript(`document.querySelector('#clipProbe').parentElement.id`),'desktopWindowSurface');fs.writeFileSync(path.join(out,'dynamic-overlay.png'),(await win.webContents.capturePage()).toPNG());
 fs.writeFileSync(path.join(out,'report.json'),JSON.stringify({host:process.platform,windowsNativeVerified:false,states},null,2));console.log('WINDOW_RENDERER_V182_OK');clearTimeout(timer);app.exit(0);
 }catch(e){console.error(e);clearTimeout(timer);app.exit(1)}}));require(path.join(root,'electron/main.js'));
