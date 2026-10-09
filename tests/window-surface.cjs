const assert=require('assert/strict'), {EventEmitter}=require('events');
const {resizeBounds,fitBoundsToWorkArea,installWindowsSurface}=require('../electron/window-surface');
const b={x:50,y:70,width:1440,height:900},p={x:0,y:0};
assert.deepEqual(resizeBounds(b,p,{x:100,y:90},'nw'),{x:150,y:160,width:1340,height:810});
assert.deepEqual(resizeBounds(b,p,{x:9999,y:9999},'nw'),{x:390,y:270,width:1100,height:700});
assert.deepEqual(resizeBounds(b,p,{x:-9999,y:-9999},'se'),{x:50,y:70,width:1100,height:700});
assert.deepEqual(resizeBounds(b,p,{x:100,y:90},'ne'),{x:50,y:160,width:1540,height:810});
assert.throws(()=>resizeBounds(b,p,p,'invalid'));
const win=new EventEmitter();let bounds={...b};win.getBounds=()=>({...bounds});win.setBounds=x=>{bounds={...x}};win.isDestroyed=()=>false;win.webContents={send:()=>{}};win.getMinimumSize=()=>[1100,700];
const screen=new EventEmitter();screen.getCursorScreenPoint=()=>({x:0,y:0});screen.getDisplayMatching=()=>({workArea:{x:0,y:0,width:1920,height:1040}});
const s=installWindowsSurface(win,screen);assert.equal(s.isMaximized(),false);s.toggleMaximize();assert.equal(s.isMaximized(),true);assert.deepEqual(s.getNormalBounds(),b);assert.equal(s.startResize('e'),false);s.toggleMaximize();assert.deepEqual(bounds,b);assert.equal(s.startResize('invalid'),false);assert.equal(s.startResize('e'),true);win.emit('blur');win.emit('closed');assert.equal(screen.listenerCount('display-metrics-changed'),0);console.log('Resize anchoring, minimum bounds, maximize/restore and cleanup passed. Windows native behavior NOT tested.');

assert.deepEqual(fitBoundsToWorkArea({width:1440,height:900,x:100,y:100},{x:0,y:0,width:1220,height:736}),{x:0,y:0,width:1220,height:736});
assert.deepEqual(fitBoundsToWorkArea({width:1400,height:900,x:-1800,y:500},{x:-1280,y:0,width:1280,height:680}),{x:-1280,y:0,width:1280,height:680});
