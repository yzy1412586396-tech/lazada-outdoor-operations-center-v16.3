const {app}=require('electron'),fs=require('fs'),path=require('path'),assert=require('node:assert/strict'),{EventEmitter}=require('events');
const root=process.env.LAZADA_TEST_APP_ROOT||path.resolve(__dirname,'..'),out=process.env.LAZADA_RESIZE_OUTPUT||'/tmp/lazada-v177-resize';fs.mkdirSync(out,{recursive:true});app.setPath('appData',path.join(out,'profile'));process.argv.push('--playwright-test','--surface-renderer-test');const timer=setTimeout(()=>app.exit(1),120000),sleep=ms=>new Promise(r=>setTimeout(r,ms));
const {installWindowsSurface,resizeBounds}=require(path.join(root,'electron/window-surface'));
app.on('browser-window-created',(_,win)=>win.webContents.once('did-finish-load',async()=>{try{
 await sleep(2300);let cursor={x:500,y:500};const screen=new EventEmitter();screen.getCursorScreenPoint=()=>cursor;screen.getDisplayMatching=()=>({workArea:{x:0,y:0,width:1280,height:780}});win.windowsSurface=installWindowsSurface(win,screen);const results=[];
 for(const edge of ['n','s','e','w','ne','nw','se','sw']){
  win.setBounds({x:40,y:40,width:1050,height:650});await sleep(60);const before=win.getBounds();cursor={x:500,y:500};
  const point=await win.webContents.executeJavaScript(`(()=>{const h=document.querySelector('.edge-${edge}'),r=h.getBoundingClientRect(),x=r.x+r.width/2,y=r.y+r.height/2;return{x:Math.round(x),y:Math.round(y),hit:document.elementFromPoint(x,y)?.className,width:r.width,height:r.height}})()`);assert(point.hit.includes('edge-'+edge),'edge hit '+edge);
  win.webContents.sendInputEvent({type:'mouseDown',x:point.x,y:point.y,button:'left',clickCount:1});await sleep(40);
  assert.equal(await win.webContents.executeJavaScript("document.documentElement.dataset.windowResizing"),'true','resize start '+edge);
  await win.webContents.executeJavaScript(`document.querySelector('.edge-${edge}').dispatchEvent(new Event('lostpointercapture'))`);
  cursor={x:530,y:530};await sleep(80);const after=win.getBounds(),expected=resizeBounds(before,{x:500,y:500},cursor,edge,{width:900,height:560});assert.deepEqual(after,expected,'drag bounds '+edge);
  win.webContents.sendInputEvent({type:'mouseUp',x:point.x,y:point.y,button:'left',clickCount:1});await sleep(50);assert.notEqual(await win.webContents.executeJavaScript("document.documentElement.dataset.windowResizing"),'true','release '+edge);cursor={x:560,y:560};await sleep(40);assert.deepEqual(win.getBounds(),after,'stops after release '+edge);results.push({edge,before,after,hit:point});
 }
 const original=win.getBounds();win.windowsSurface.toggleMaximize();assert(win.windowsSurface.isMaximized());win.windowsSurface.toggleMaximize();assert(!win.windowsSurface.isMaximized());assert.deepEqual(win.getBounds(),original);
 win.setBounds({x:40,y:40,width:900,height:560});await win.webContents.executeJavaScript("go('inventory')");await sleep(250);fs.writeFileSync(path.join(out,'small-window.png'),(await win.webContents.capturePage()).toPNG());
 fs.writeFileSync(path.join(out,'report.json'),JSON.stringify({ok:true,results,minimum:win.getMinimumSize(),windowsNativeTested:false},null,2));console.log('RESIZE_RENDERER_OK',JSON.stringify({edges:results.length,minimum:win.getMinimumSize(),maxRestore:true,windowsNativeTested:false}));clearTimeout(timer);app.exit(0);
 }catch(e){console.error(e);clearTimeout(timer);app.exit(1)}}));require(path.join(root,'electron/main.js'));
