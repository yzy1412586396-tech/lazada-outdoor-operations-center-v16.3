const { app, BrowserWindow, Menu, dialog, shell, session, ipcMain, safeStorage, clipboard, nativeImage } = require('electron');
const fs = require('fs');
const path = require('path');
const { OperationsDatabase } = require('./database');
const { ContextBuilder } = require('./services/context-builder');
const { CredentialStore } = require('./services/credential-store');
const { AIService } = require('./services/ai-service');
const { registerSecureHandlers } = require('./ipc-handlers');
const { configureDownloadItem } = require('./download-policy');
const { registerAutomationFolderHandlers } = require('./automation-folders');
const { NorthstarReadOnlyServer } = require('./northstar-server');

const APP_NAME = 'Lazada户外运营中心';
const APP_VERSION = '16.3.0';
const DISPLAY_VERSION = '16.3';
const TRANSPARENT_DRAG_ICON = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
const isSmokeTest = process.argv.includes('--smoke-test');
const isRealInventoryTest = process.argv.includes('--real-inventory-test');
const isUiTest = process.argv.includes('--ui-test');
const isPlaywrightTest = process.argv.includes('--playwright-test');
let mainWindow = null;
let saveTimer = null;
let operationsDatabase = null;
let northstarServer = null;
let recentDownloads = [];
const activeDownloadIds = new Set();

app.setName(APP_NAME);

if (isSmokeTest || isUiTest || isPlaywrightTest) {
  app.disableHardwareAcceleration();
  const testKind = isSmokeTest ? 'smoke' : (isUiTest ? 'ui' : 'playwright');
  const testDataDirectory = path.join(app.getPath('temp'), `lazada-outdoor-operations-${testKind}-${process.pid}`);
  fs.mkdirSync(testDataDirectory, { recursive: true });
  app.setPath('userData', testDataDirectory);
  // The Codex/CI host already runs the whole test process inside its own OS
  // sandbox. Chromium's nested renderer sandbox cannot start there on some
  // Windows hosts (render-process exit 49), so disable only the nested layer
  // for explicit test launches. Production keeps BrowserWindow sandboxing on.
  app.commandLine.appendSwitch('no-sandbox');
  app.commandLine.appendSwitch('disable-setuid-sandbox');
  // Test windows use software rendering so Electron UI regression checks are
  // not affected by the host machine's DirectX/GPU driver state.
  // Playwright owns Chromium's debugging transport. Forcing in-process GPU
  // together with a transparent frameless window can crash that renderer
  // before index.html is committed, so keep those stronger switches only on
  // the main-process smoke/native-input harnesses.
  if (!isPlaywrightTest) {
    app.commandLine.appendSwitch('disable-gpu');
    app.commandLine.appendSwitch('disable-gpu-compositing');
    app.commandLine.appendSwitch('in-process-gpu');
  }
  app.commandLine.appendSwitch('disable-disk-cache');
} else {
  const durableDataDirectory = path.join(app.getPath('appData'), APP_NAME);
  fs.mkdirSync(durableDataDirectory, { recursive: true });
  app.setPath('userData', durableDataDirectory);
}

app.setAppUserModelId('com.lazada.outdoor.operations');

const gotSingleInstanceLock = (isSmokeTest || isUiTest || isPlaywrightTest) ? true : app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
  if (isSmokeTest) app.exit(1);
  else app.quit();
}

function stateFile() {
  return path.join(app.getPath('userData'), 'window-state.json');
}

function readWindowState() {
  try {
    const state = JSON.parse(fs.readFileSync(stateFile(), 'utf8'));
    return {
      width: Math.max(1100, Number(state.width) || 1440),
      height: Math.max(700, Number(state.height) || 900),
      x: Number.isFinite(state.x) ? state.x : undefined,
      y: Number.isFinite(state.y) ? state.y : undefined,
      maximized: Boolean(state.maximized),
    };
  } catch {
    return { width: 1440, height: 900, maximized: false };
  }
}

function writeWindowState(win) {
  if (!win || win.isDestroyed() || isSmokeTest) return;
  const bounds = win.isMaximized() ? win.getNormalBounds() : win.getBounds();
  const payload = { ...bounds, maximized: win.isMaximized() };
  try {
    fs.mkdirSync(app.getPath('userData'), { recursive: true });
    fs.writeFileSync(stateFile(), JSON.stringify(payload, null, 2), 'utf8');
  } catch (error) {
    console.error('Unable to persist window state:', error);
  }
}

function scheduleWindowStateSave(win) {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => writeWindowState(win), 250);
}

function sendCommand(command) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('desktop-command', command);
  }
}

function databaseFile() {
  return path.join(app.getPath('userData'), 'data', 'operations.db');
}

function registerDatabaseHandlers() {
  operationsDatabase = new OperationsDatabase(databaseFile(), {
    backupDirectory: path.join(app.getPath('userData'), 'backups'),
  });
  const contextBuilder = new ContextBuilder(operationsDatabase);
  const credentialStore = new CredentialStore(safeStorage, path.join(app.getPath('userData'), 'security'));
  const aiService = new AIService({
    database: operationsDatabase,
    contextBuilder,
    credentialStore,
    allowMock: !app.isPackaged || isSmokeTest,
  });

  ipcMain.on('database:load-storage', (event) => {
    try { event.returnValue = operationsDatabase.loadStorage(); }
    catch (error) { event.returnValue = { initialized: false, entries: [], error: error.message }; }
  });

  ipcMain.on('database:replace-storage', (event, entries) => {
    try { event.returnValue = operationsDatabase.replaceStorage(entries); }
    catch (error) { event.returnValue = { ok: false, error: error.message }; }
  });

  ipcMain.handle('database:sync-storage', (_event, changes, removed) => (
    operationsDatabase.syncStorage(changes, removed)
  ));
  ipcMain.handle('database:info', () => operationsDatabase.info());
  ipcMain.handle('database:open-folder', () => shell.openPath(path.dirname(databaseFile())));
  ipcMain.handle('uploads:list', () => operationsDatabase.listUploads());
  ipcMain.handle('uploads:read', (_event, slot) => operationsDatabase.readUpload(slot));
  ipcMain.handle('uploads:save', (_event, slot, metadata, bytes) => (
    operationsDatabase.saveUpload(slot, metadata, bytes)
  ));
  ipcMain.handle('uploads:delete', (_event, slot) => operationsDatabase.deleteUpload(slot));

  registerSecureHandlers({
    ipcMain,
    dialog,
    shell,
    database: operationsDatabase,
    aiService,
    contextBuilder,
    getWindow: () => mainWindow,
  });
  return contextBuilder;
}

function startNorthstarReadOnlyApi(contextBuilder) {
  if (isSmokeTest || isUiTest || isPlaywrightTest || northstarServer) return;
  const configuredPort = Number(process.env.NORTHSTAR_OPERATIONS_CENTER_PORT || 35800);
  northstarServer = new NorthstarReadOnlyServer({
    database: operationsDatabase,
    contextBuilder,
    host: '127.0.0.1',
    port: Number.isInteger(configuredPort) && configuredPort > 0 && configuredPort < 65536 ? configuredPort : 35800,
    version: APP_VERSION,
  });
  northstarServer.start()
    .then(({ host, port }) => console.log(`[northstar-api] read-only API listening on http://${host}:${port}`))
    .catch((error) => {
      console.error('[northstar-api] unable to start read-only API:', error.message);
      northstarServer = null;
    });
}

function buildMenu() {
  const template = [
    {
      label: '文件',
      submenu: [
        { label: '导出数据备份', accelerator: 'CmdOrCtrl+S', click: () => sendCommand('backup') },
        { label: '导入数据备份', accelerator: 'CmdOrCtrl+O', click: () => sendCommand('restore') },
        { type: 'separator' },
        {
          label: '打开下载文件夹',
          click: () => shell.openPath(app.getPath('downloads')),
        },
        {
          label: '打开本地数据库目录',
          click: () => shell.openPath(path.dirname(databaseFile())),
        },
        { type: 'separator' },
        { label: '退出', role: 'quit' },
      ],
    },
    {
      label: '编辑',
      submenu: [
        { role: 'undo', label: '撤销' },
        { role: 'redo', label: '重做' },
        { type: 'separator' },
        { role: 'cut', label: '剪切' },
        { role: 'copy', label: '复制' },
        { role: 'paste', label: '粘贴' },
        { role: 'selectAll', label: '全选' },
      ],
    },
    {
      label: '视图',
      submenu: [
        { role: 'reload', label: '重新加载' },
        { type: 'separator' },
        { role: 'resetZoom', label: '恢复默认缩放' },
        { role: 'zoomIn', label: '放大' },
        { role: 'zoomOut', label: '缩小' },
        { type: 'separator' },
        { role: 'togglefullscreen', label: '全屏' },
      ],
    },
    {
      label: '帮助',
      submenu: [
        {
          label: '使用说明',
          click: () => dialog.showMessageBox(mainWindow, {
            type: 'info',
            title: '使用说明',
            message: `${APP_NAME} V${DISPLAY_VERSION}`,
            detail: '数据会自动保存到本机 SQLite 数据库。月度费用上传的表格也会保存在数据库中，重新打开可自动恢复。Excel 文件只在本机处理，不会上传到服务器。',
            buttons: ['知道了'],
          }),
        },
        {
          label: '关于',
          click: () => dialog.showMessageBox(mainWindow, {
            type: 'info',
            title: `关于${APP_NAME}`,
            message: `${APP_NAME} V${DISPLAY_VERSION}`,
            detail: `Electron ${process.versions.electron}\nChromium ${process.versions.chrome}\nNode.js ${process.versions.node}`,
            buttons: ['关闭'],
          }),
        },
      ],
    },
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function configureSession() {
  const appSession = session.defaultSession;
  appSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
  appSession.setPermissionCheckHandler(() => false);

  appSession.on('will-download', (_event, item) => {
    configureDownloadItem(item, app.getPath('downloads'));
    const record = {
      id: `download-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      name: path.basename(item.getFilename() || '导出文件'),
      size: Number(item.getTotalBytes()) || 0,
      received: 0,
      state: 'progressing',
      startedAt: new Date().toISOString(),
      completedAt: '',
      path: '',
      available: null,
    };
    activeDownloadIds.add(record.id);
    recentDownloads = [record, ...recentDownloads.filter((entry) => entry.name !== record.name)].slice(0, 30);
    saveRecentDownloads();
    publishRecentDownloads();
    const update = () => {
      const received = Number(item.getReceivedBytes());
      const size = Number(item.getTotalBytes());
      let savePath = '';
      try { savePath = item.getSavePath() || ''; } catch { /* path may not be assigned yet */ }
      const current = recentDownloads.find((entry) => entry.id === record.id);
      if (!current) return;
      current.received = Number.isFinite(received) ? received : current.received;
      current.size = Number.isFinite(size) && size > 0 ? size : current.size;
      current.state = item.isPaused() ? 'paused' : 'progressing';
      if (savePath) current.path = savePath;
      current.available = current.path ? fs.existsSync(current.path) : null;
      publishRecentDownloads();
    };
    item.on('updated', update);
    item.once('done', (_event, state) => {
      const current = recentDownloads.find((entry) => entry.id === record.id);
      if (!current) return;
      const received = Number(item.getReceivedBytes());
      const size = Number(item.getTotalBytes());
      let savePath = '';
      try { savePath = item.getSavePath() || ''; } catch { /* keep the last known path */ }
      current.received = Number.isFinite(received) ? received : current.received;
      current.size = Number.isFinite(size) && size > 0 ? size : current.size;
      current.state = state === 'complete' ? 'completed' : state;
      current.completedAt = new Date().toISOString();
      if (savePath) current.path = savePath;
      current.available = current.path ? fs.existsSync(current.path) : false;
      if (current.state === 'completed') {
        current.received = Math.max(current.received, current.size);
        if (current.path && current.available) {
          try { current.received = Math.max(current.received, fs.statSync(current.path).size); } catch { /* keep DownloadItem bytes */ }
        }
      }
      saveRecentDownloads();
      publishRecentDownloads();
      activeDownloadIds.delete(record.id);
    });
  });
}

function recentDownloadsFile() {
  return path.join(app.getPath('userData'), 'recent-downloads.json');
}

function loadRecentDownloads() {
  try {
    const value = JSON.parse(fs.readFileSync(recentDownloadsFile(), 'utf8'));
    recentDownloads = Array.isArray(value) ? value.slice(0, 30) : [];
  } catch {
    recentDownloads = [];
  }
  refreshRecentDownloadAvailability();
}

function saveRecentDownloads() {
  try {
    fs.mkdirSync(path.dirname(recentDownloadsFile()), { recursive: true });
    fs.writeFileSync(recentDownloadsFile(), JSON.stringify(recentDownloads, null, 2), 'utf8');
  } catch (error) {
    console.warn('[downloads] unable to persist recent downloads:', error.message);
  }
}

function publishRecentDownloads() {
  refreshRecentDownloadAvailability();
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('downloads:changed', recentDownloads);
}

function refreshRecentDownloadAvailability() {
  let changed = false;
  recentDownloads = recentDownloads.map((record) => {
    let nextPath = record.path || '';
    if (!nextPath && record.name) {
      const candidate = path.join(app.getPath('downloads'), path.basename(record.name));
      if (fs.existsSync(candidate)) nextPath = candidate;
    }
    const available = nextPath ? fs.existsSync(nextPath) : null;
    const next = { ...record, path: nextPath, available };
    if (available && next.state === 'progressing' && !activeDownloadIds.has(next.id)) {
      try {
        const size = fs.statSync(nextPath).size;
        if ((next.size > 0 && size >= next.size) || (next.size <= 0 && size > 0)) {
          next.received = Math.max(Number(next.received) || 0, size);
          next.state = 'completed';
          next.completedAt = next.completedAt || new Date(fs.statSync(nextPath).mtimeMs).toISOString();
        }
      } catch { /* the file can disappear while the list is refreshing */ }
    }
    if (record.path !== next.path || record.available !== next.available || record.state !== next.state
      || record.received !== next.received || record.completedAt !== next.completedAt) changed = true;
    return next;
  });
  if (changed) saveRecentDownloads();
  return recentDownloads;
}

function resolveRecentDownload(value) {
  const text = String(value || '');
  const record = recentDownloads.find((entry) => entry.id === text
    || (entry.path && path.resolve(entry.path) === path.resolve(text)));
  if (!record) throw new Error('下载记录不存在');
  if (!record.path && record.name) {
    const candidate = path.join(app.getPath('downloads'), path.basename(record.name));
    if (fs.existsSync(candidate)) {
      record.path = candidate;
      record.available = true;
      saveRecentDownloads();
    }
  }
  return record;
}

function registerDownloadHandlers() {
  ipcMain.handle('downloads:list', () => refreshRecentDownloadAvailability());
  ipcMain.handle('downloads:remove', (_event, value) => {
    const record = resolveRecentDownload(value);
    recentDownloads = recentDownloads.filter((entry) => entry.id !== record.id);
    activeDownloadIds.delete(record.id);
    saveRecentDownloads();
    publishRecentDownloads();
    return { ok: true };
  });
  ipcMain.handle('downloads:open', async (_event, value) => {
    const record = resolveRecentDownload(value);
    if (!fs.existsSync(record.path)) throw new Error('文件已移动或删除');
    return { ok: true, result: await shell.openPath(record.path) };
  });
  ipcMain.handle('downloads:open-location', async (_event, value) => {
    const record = resolveRecentDownload(value);
    if (!fs.existsSync(record.path)) throw new Error('文件已移动或删除');
    shell.showItemInFolder(record.path);
    return { ok: true };
  });
  ipcMain.handle('downloads:copy-path', (_event, value) => {
    const record = resolveRecentDownload(value);
    if (!record.path) throw new Error('文件路径不可用');
    clipboard.writeText(record.path);
    return { ok: true };
  });
  ipcMain.handle('downloads:context-menu', async (event, value) => {
    const record = resolveRecentDownload(value);
    const available = fs.existsSync(record.path);
    const window = BrowserWindow.fromWebContents(event.sender);
    const menu = Menu.buildFromTemplate([
      { label: '打开文件', enabled: available, click: () => { if (fs.existsSync(record.path)) void shell.openPath(record.path); } },
      { label: '打开文件所在位置', enabled: available, click: () => { if (fs.existsSync(record.path)) shell.showItemInFolder(record.path); } },
      { type: 'separator' },
      { label: '复制文件路径', enabled: Boolean(record.path), click: () => clipboard.writeText(record.path) },
      { label: '删除下载记录', click: () => {
        recentDownloads = recentDownloads.filter((entry) => entry.id !== record.id);
        activeDownloadIds.delete(record.id);
        saveRecentDownloads();
        publishRecentDownloads();
      } },
    ]);
    menu.popup({ window: window && !window.isDestroyed() ? window : undefined });
    return { ok: true, available };
  });
  ipcMain.on('downloads:start-drag', (event, value) => {
    try {
      const record = resolveRecentDownload(value);
      if (!fs.existsSync(record.path)) throw new Error('文件已移动或删除');
      event.sender.startDrag({
        file: record.path,
        // A real transparent bitmap is more reliable on Windows than
        // nativeImage.createEmpty(), which can fall back to the app icon.
        icon: nativeImage.createFromDataURL(TRANSPARENT_DRAG_ICON),
      });
    } catch (error) {
      event.sender.send('downloads:drag-error', String(error.message || '文件已移动或删除'));
    }
  });
}

function registerWindowHandlers() {
  const getOwnedWindow = (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win || win !== mainWindow || win.isDestroyed()) throw new Error('窗口不可用');
    return win;
  };
  ipcMain.handle('window:minimize', (event) => { getOwnedWindow(event).minimize(); return { ok: true }; });
  ipcMain.handle('window:maximize-toggle', (event) => {
    const win = getOwnedWindow(event);
    if (win.isMaximized()) win.unmaximize(); else win.maximize();
    return { ok: true, maximized: win.isMaximized() };
  });
  ipcMain.handle('window:close', (event) => { getOwnedWindow(event).close(); return { ok: true }; });
  ipcMain.on('window:drag-delta', (event, value) => {
    const win = getOwnedWindow(event);
    const clampDelta = (input) => Math.max(-200, Math.min(200, Math.round(Number(input) || 0)));
    const dx = clampDelta(value?.dx);
    const dy = clampDelta(value?.dy);
    if (!dx && !dy) return;
    if (win.isMaximized()) win.unmaximize();
    const bounds = win.getBounds();
    win.setPosition(bounds.x + dx, bounds.y + dy, false);
  });
}

function runUiTest(win) {
  const reportDirectory = path.join(app.getPath('temp'), 'lazada-v16.3-test-artifacts');
  fs.mkdirSync(reportDirectory, { recursive: true });
  const reportPath = path.join(reportDirectory, 'v16.3-native-input-test-r1.json');
  const progressPath = path.join(reportDirectory, 'v16.3-native-input-progress-r1.log');
  let currentStage = 'registered';
  const recordStage = (stage) => {
    currentStage = stage;
    fs.appendFileSync(progressPath, `${new Date().toISOString()} ${stage}\r\n`);
  };
  fs.writeFileSync(progressPath, '');
  recordStage('listener-registered');
  win.webContents.once('did-finish-load', async () => {
    recordStage('did-finish-load');
    const timeout = setTimeout(() => {
      fs.writeFileSync(reportPath, JSON.stringify({ passed: false, error: 'UI test timeout', stage: currentStage }, null, 2));
      app.exit(1);
    }, 30000);
    try {
      recordStage('waiting-for-renderer');
      const startedAt = Date.now();
      while (Date.now() - startedAt < 15000) {
        const ready = await win.webContents.executeJavaScript(`Boolean(
          document.querySelector('#backgroundTransparency')
          && document.querySelector('#moduleTransparency')
          && document.querySelector('#buttonTransparency')
          && document.querySelector('#v152DownloadsButton')
          && document.querySelector('#v161PluginsButton')
          && document.querySelectorAll('[data-window-action]').length === 3
          && typeof applyAppearance === 'function'
        )`).catch(() => false);
        if (ready) break;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      recordStage('renderer-ready');
      win.showInactive();
      await new Promise((resolve) => setTimeout(resolve, 250));
      recordStage('collecting-renderer-state');
      const rendererReport = await win.webContents.executeJavaScript(`(async () => {
        const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
        const samples = [];
        for (const sample of [{ background:22,module:16,button:18 },{ background:48,module:32,button:42 },{ background:72,module:58,button:72 }]) {
          appearance.backgroundTransparency=sample.background;
          appearance.moduleTransparency=sample.module;
          appearance.buttonTransparency=sample.button;
          applyAppearance(true);
          const css=getComputedStyle(document.documentElement);
          samples.push({ ...sample, workbenchAlpha:css.getPropertyValue('--glass-workbench-alpha').trim(), panelAlpha:css.getPropertyValue('--glass-panel-alpha').trim(), buttonAlpha:css.getPropertyValue('--glass-button-alpha').trim() });
          await pause(30);
        }
        const downloadButton=document.querySelector('#v152DownloadsButton');
        const pluginsButton=document.querySelector('#v161PluginsButton');
        appearance.backgroundTransparency=48;
        appearance.moduleTransparency=32;
        appearance.buttonTransparency=42;
        applyAppearance(true);
        go('dashboard');
        const appRect=document.querySelector('.app').getBoundingClientRect();
        const downloadRect=downloadButton.getBoundingClientRect();
        const pluginsRect=pluginsButton.getBoundingClientRect();
        const controls=[...document.querySelectorAll('[data-window-action]')].map((button)=>{const rect=button.getBoundingClientRect();return{action:button.dataset.windowAction,width:rect.width,height:rect.height,top:rect.top,rightGap:innerWidth-rect.right,pointerEvents:getComputedStyle(button).pointerEvents}});
        const saved=JSON.parse(localStorage.getItem('lazadaOpsAppearanceV1')||'{}');
        const chromeRect=document.querySelector('.v155-window-chrome').getBoundingClientRect();
        const brandRect=document.querySelector('.v155-window-brand').getBoundingClientRect();
        const brandStyle=getComputedStyle(document.querySelector('.v155-window-brand'));
        const dragX=Math.round(Math.min(520,brandRect.right-30)),dragY=Math.round(brandRect.top+brandRect.height/2);
        const dragHit=document.elementFromPoint(dragX,dragY);
        return { samples,appTop:appRect.top,download:{top:downloadRect.top,rightGap:innerWidth-downloadRect.right,width:downloadRect.width,height:downloadRect.height},plugins:{top:pluginsRect.top,rightGap:innerWidth-pluginsRect.right,width:pluginsRect.width,height:pluginsRect.height},controls,chrome:{top:chromeRect.top,bottom:chromeRect.bottom,height:chromeRect.height},brand:{top:brandRect.top,bottom:brandRect.bottom,height:brandRect.height,pointerEvents:brandStyle.pointerEvents,appRegion:brandStyle.getPropertyValue('-webkit-app-region'),dragPoint:{x:dragX,y:dragY,hitClass:String(dragHit?.className||'')}},saved,scrollbarWidth:getComputedStyle(document.querySelector('.main'),'::-webkit-scrollbar').width };
      })()`);
      recordStage('renderer-state-collected');
      const nativeClicks = [];
      const clickAtSelector = async (name, selector, verify) => {
        recordStage(`${name}:locating`);
        const point = await win.webContents.executeJavaScript(`(() => {
          const element=document.querySelector(${JSON.stringify(selector)});
          if(!element)return null;
          const rect=element.getBoundingClientRect();
          const x=Math.round(rect.left+rect.width/2),y=Math.round(rect.top+rect.height/2);
          const hit=document.elementFromPoint(x,y);
          return{x,y,selector:${JSON.stringify(selector)},hitTag:hit?.tagName||'',hitId:hit?.id||'',hitClass:String(hit?.className||''),hitPage:hit?.closest?.('[data-page]')?.dataset?.page||'',hitAction:hit?.closest?.('[data-window-action]')?.dataset?.windowAction||''};
        })()`);
        if (!point) throw new Error(`Missing native-click target: ${name}`);
        recordStage(`${name}:located x=${point.x} y=${point.y} hit=${point.hitTag}#${point.hitId}.${point.hitClass}`);
        const started = Date.now();
        win.webContents.sendInputEvent({ type:'mouseMove', x:point.x, y:point.y, movementX:0, movementY:0 });
        recordStage(`${name}:mouse-moved`);
        win.webContents.sendInputEvent({ type:'mouseDown', x:point.x, y:point.y, button:'left', clickCount:1 });
        recordStage(`${name}:mouse-down-sent`);
        win.webContents.sendInputEvent({ type:'mouseUp', x:point.x, y:point.y, button:'left', clickCount:1 });
        recordStage(`${name}:mouse-up-sent`);
        await new Promise((resolve) => setTimeout(resolve, 140));
        recordStage(`${name}:verifying`);
        const state = await verify();
        recordStage(`${name}:verified=${Boolean(state)}`);
        nativeClicks.push({ name, ...point, elapsedMs:Date.now()-started, passed:Boolean(state), state });
      };
      recordStage('click-stores');
      await clickAtSelector('stores-nav', '#nav [data-page="stores"]', () => win.webContents.executeJavaScript(`document.querySelector('#page-stores')?.classList.contains('active')`));
      recordStage('click-inventory');
      await clickAtSelector('inventory-nav', '#nav [data-page="inventory"]', () => win.webContents.executeJavaScript(`document.querySelector('#page-inventory')?.classList.contains('active')`));
      recordStage('click-settings');
      await clickAtSelector('settings-nav', '#nav [data-page="settings"]', () => win.webContents.executeJavaScript(`document.querySelector('#page-settings')?.classList.contains('active')`));
      await win.webContents.executeJavaScript(`go('dashboard')`);
      recordStage('click-hero-activity');
      await clickAtSelector('hero-activity', '[data-go="activity"]', () => win.webContents.executeJavaScript(`document.querySelector('#page-activity')?.classList.contains('active')`));
      recordStage('click-download-open');
      await clickAtSelector('downloads-open', '#v152DownloadsButton', () => win.webContents.executeJavaScript(`document.querySelector('#v152DownloadsPanel')?.classList.contains('show')`));
      recordStage('click-download-close');
      await clickAtSelector('downloads-close', '#v152DownloadsButton', () => win.webContents.executeJavaScript(`!document.querySelector('#v152DownloadsPanel')?.classList.contains('show')`));
      recordStage('click-plugins-open');
      await clickAtSelector('plugins-open', '#v161PluginsButton', () => win.webContents.executeJavaScript(`document.querySelector('#v161PluginsPanel')?.classList.contains('show')`));
      recordStage('click-plugins-close');
      await clickAtSelector('plugins-close', '#v161PluginsButton', () => win.webContents.executeJavaScript(`!document.querySelector('#v161PluginsPanel')?.classList.contains('show')`));
      recordStage('drag-window');
      const beforeDrag = win.getBounds();
      const dragStart = rendererReport.brand.dragPoint;
      win.webContents.sendInputEvent({ type:'mouseMove', x:dragStart.x, y:dragStart.y, movementX:0, movementY:0 });
      win.webContents.sendInputEvent({ type:'mouseDown', x:dragStart.x, y:dragStart.y, button:'left', clickCount:1 });
      for (let step = 1; step <= 6; step += 1) {
        win.webContents.sendInputEvent({ type:'mouseMove', x:dragStart.x + step * 10, y:dragStart.y + step * 4, movementX:10, movementY:4 });
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      win.webContents.sendInputEvent({ type:'mouseUp', x:dragStart.x + 60, y:dragStart.y + 24, button:'left', clickCount:1 });
      await new Promise((resolve) => setTimeout(resolve, 220));
      const afterDrag = win.getBounds();
      const dragWorked = Math.abs(afterDrag.x - beforeDrag.x) >= 20 || Math.abs(afterDrag.y - beforeDrag.y) >= 10;
      if (dragWorked) win.setBounds(beforeDrag);
      recordStage('click-maximize');
      await clickAtSelector('maximize', '[data-window-action="maximize"]', async () => win.isMaximized());
      const maximizeWorked = win.isMaximized();
      if (maximizeWorked) win.unmaximize();
      const screenshotPath = path.join(reportDirectory, 'v16.3-glass-default.png');
      const controlsValid = rendererReport.controls.length === 3 && rendererReport.controls.every((item) => item.width === 34 && item.height === 34 && item.pointerEvents === 'auto');
      const alphaRangesDiffer = new Set(rendererReport.samples.map((item) => item.workbenchAlpha)).size === 3 && new Set(rendererReport.samples.map((item) => item.panelAlpha)).size === 3 && new Set(rendererReport.samples.map((item) => item.buttonAlpha)).size === 3;
      const layoutValid = rendererReport.appTop - (rendererReport.controls[0].top + rendererReport.controls[0].height) === 8 && rendererReport.download.top === rendererReport.controls[0].top && rendererReport.download.height === 34 && rendererReport.download.rightGap === 142 && rendererReport.plugins.top === 10 && rendererReport.plugins.height === 34 && rendererReport.plugins.rightGap === 258;
      const dragLayerValid = rendererReport.chrome.height === 52 && rendererReport.chrome.bottom === 52
        && rendererReport.brand.height === 52 && rendererReport.brand.bottom === 52
        && rendererReport.brand.pointerEvents === 'auto' && rendererReport.brand.appRegion === 'no-drag'
        && rendererReport.brand.dragPoint.hitClass.includes('v155-window-brand');
      const nativeInputValid = nativeClicks.every((item) => item.passed && item.elapsedMs < 500);
      const passed = nativeInputValid && controlsValid && alphaRangesDiffer && layoutValid && dragLayerValid && dragWorked && rendererReport.scrollbarWidth === '0px' && maximizeWorked;
      const report = { ...rendererReport, nativeClicks, dragTest:{before:beforeDrag,after:afterDrag,worked:dragWorked}, maximizeWorked, dragLayerValid, screenshotPath: null, screenshotWarning: null, passed };
      recordStage('capturing-screenshot');
      try {
        win.showInactive();
        await new Promise((resolve) => setTimeout(resolve, 250));
        fs.writeFileSync(screenshotPath, (await win.webContents.capturePage()).toPNG());
        report.screenshotPath = screenshotPath;
      } catch (screenshotError) {
        report.screenshotWarning = screenshotError.message;
      }
      recordStage('writing-final-report');
      console.log(`UI_TEST_RESULT: ${JSON.stringify(report)}`);
      fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
      recordStage(`complete passed=${passed}`);
      clearTimeout(timeout);
      app.exit(passed ? 0 : 1);
    } catch (error) {
      clearTimeout(timeout);
      console.error('UI_TEST_FAILED:', error.stack || error.message);
      fs.writeFileSync(reportPath, JSON.stringify({ passed: false, error: error.stack || error.message }, null, 2));
      app.exit(1);
    }
  });
}

function runSmokeTest(win) {
  let realInventoryPayload = null;
  if (isRealInventoryTest) {
    const definitions = [
      ['store', process.env.INV15_STORE_SAMPLE],
      ['mabang', process.env.INV15_MABANG_SAMPLE],
      ['combo', process.env.INV15_COMBO_SAMPLE],
    ];
    const missing = definitions.filter(([, filePath]) => !filePath || !fs.existsSync(filePath));
    if (missing.length) {
      console.error(`SMOKE_TEST_FAILED: missing real inventory sample(s): ${missing.map(([kind]) => kind).join(', ')}`);
      app.exit(1);
      return;
    }
    realInventoryPayload = Object.fromEntries(definitions.map(([kind, filePath]) => [kind, {
      name: path.basename(filePath),
      base64: fs.readFileSync(filePath).toString('base64'),
    }]));
  }
  const timeout = setTimeout(() => {
    console.error('SMOKE_TEST_FAILED: timed out');
    app.exit(1);
  }, 60000);

  win.webContents.once('did-finish-load', async () => {
    try {
      const result = await win.webContents.executeJavaScript(`new Promise((resolve, reject) => {
        const started = Date.now();
        const inspect = () => {
          if (window.__desktopEnhancementsV13?.ready && window.__inventoryV15?.ready && window.__businessOptimizationsV14?.ready && window.__aiObserverV14?.ready) {
            try { go('expenses'); } catch {}
            setTimeout(async () => {
              let inventoryAnalysis = false;
              let inventoryExport = false;
              let inventoryPersistence = false;
              let inventorySkuRules = false;
              let realInventorySample = ${isRealInventoryTest ? 'false' : 'true'};
              let realInventoryDetails = null;
              let inventoryError = '';
              let mabangDedupe = false;
              let fuzzySearch = false;
              let batterySuffixRule = false;
               let activityFallbackConfig = false;
               let activityStockBoundaries = false;
               let pricingBoundaries = false;
               let expenseBoundaries = false;
              let aiObserver = false;
              let aiTemplateIsolated = false;
              let aiSettingsCollapsed = false;
              let comboRepricing = false;
              let releaseHistoryRetained = false;
              let dataSafety = false;
              let restrictedBridge = false;
              let noKeyStart = false;
              let mockChat = false;
              let attachmentChat = false;
              let contextPreview = false;
              let contextSend = false;
              let dailyRename = false;
              let inventoryStoreLink = false;
              let storeManagementButtons = false;
              let databaseSchema = '';
              const makeWorkbookFile = (name, sheetName, rows) => {
                const workbook = XLSX.utils.book_new();
                XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet(rows), sheetName);
                const bytes = XLSX.write(workbook, { type: 'array', bookType: 'xlsx' });
                return new File([bytes], name, { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
              };
              const assignFile = (input, file) => {
                const transfer = new DataTransfer();
                transfer.items.add(file);
                input.files = transfer.files;
                input.dispatchEvent(new Event('change', { bubbles: true }));
              };
              const realInventoryPayload = ${JSON.stringify(realInventoryPayload)};
              const fileFromBase64 = (definition) => {
                const binary = atob(definition.base64);
                const bytes = new Uint8Array(binary.length);
                for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
                return new File([bytes], definition.name, { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
              };
              const waitFor = (predicate, limit = 8000) => new Promise((done, fail) => {
                const began = Date.now();
                const check = async () => {
                  let matched = false;
                  try { matched = await predicate(); } catch { matched = false; }
                  if (matched) done();
                  else if (Date.now() - began > limit) fail(new Error('smoke test timeout'));
                  else setTimeout(check, 80);
                };
                check();
              });
              try {
                go('inventory');
                assignFile(document.getElementById('inv15StoreFile'), makeWorkbookFile('store.xlsx', '商品', [
                  ['SellerSKU', '商品标题', 'Status', 'CFS库存', '高易库存'],
                  ['选填', '必填', '选填', '选填', '选填'],
                  ['SKU是每个产品变体的唯一标识符', '模板说明', '', '', ''],
                  ['请输入少于200个字符', '模板填写说明', '', '', ''],
                  ['T1234567890S1', 'Outdoor chair', 'active', 5, 0]
                ]));
                assignFile(document.getElementById('inv15MabangFile'), makeWorkbookFile('mabang.xlsx', '库存', [
                  ['库存SKU编号', '仓库', '可用库存量', '商品名称'],
                  ['T1234567890', '菲律宾CFS-HB仓-1308', 0, 'Outdoor chair'],
                  ['T1234567890', '菲律宾高易-HB仓-1308', 20, 'Outdoor chair']
                ]));
                assignFile(document.getElementById('inv15ComboFile'), makeWorkbookFile('combo.xlsx', '组合', [
                  ['组合sku编码', '组合sku中文名称', '关联sku编号1', '关联sku捆绑数量1'],
                  ['T1234567890X1', 'Outdoor chair combo', 'T1234567890', 1]
                ]));
                await waitFor(() => window.__inventoryV15.getSession().store && window.__inventoryV15.getSession().mabang && window.__inventoryV15.getSession().combo);
                document.getElementById('inv15Analyze').click();
                await waitFor(() => window.__inventoryV15.getSession().results.length === 1);
                const sample = window.__inventoryV15.getSession().results[0];
                inventoryAnalysis = sample.flow === 'flow2_same_sku_other_warehouse'
                  && sample.finalStocks.gaoyi === 20 && sample.finalStocks.cfs === null
                  && window.__inventoryV15.getSession().store.dataStartRow === 5;
                const exportBlob = await window.__inventoryV15.buildWorkbookForTest();
                const exportWorkbook = await openWorkbook(await exportBlob.arrayBuffer());
                const exportSheet = await getSheet(exportWorkbook, exportWorkbook.sheets[0]);
                inventoryExport = cellValue(exportSheet, 5, 1) === 'T1234567890S1'
                  && cellValue(exportSheet, 5, 4) === null && cellValue(exportSheet, 5, 5) === 20;
                const savedUploads = await window.desktopApp.uploads.list();
                const savedInventorySources = ['store', 'mabang', 'combo'].every(kind => savedUploads.some(item => item.slot.includes('inventory-v15:') && item.slot.endsWith(':' + kind)));
                await window.__inventoryV15.restoreAllSources();
                await waitFor(() => window.__inventoryV15.getSession().store && window.__inventoryV15.getSession().mabang && window.__inventoryV15.getSession().combo);
                inventoryPersistence = savedInventorySources
                  && window.__inventoryV15.getSession().store.name === 'store.xlsx'
                  && window.__inventoryV15.getSession().mabang.name === 'mabang.xlsx'
                  && window.__inventoryV15.getSession().combo.name === 'combo.xlsx';
                inventorySkuRules = window.__inventoryV15.engine.parseSku('T5HH1850591S2').canonical === 'T5HH1850591'
                  && window.__inventoryV15.engine.parseSku('T3HH0623544X1S1').canonical === 'T3HH0623544X1'
                  && window.__inventoryV15.engine.warehouseNameMatches('菲律宾CFS-HB仓-1308', 'CFS');
                if (realInventoryPayload) {
                  assignFile(document.getElementById('inv15StoreFile'), fileFromBase64(realInventoryPayload.store));
                  assignFile(document.getElementById('inv15MabangFile'), fileFromBase64(realInventoryPayload.mabang));
                  assignFile(document.getElementById('inv15ComboFile'), fileFromBase64(realInventoryPayload.combo));
                  await waitFor(() => {
                    const current = window.__inventoryV15.getSession();
                    return current.store?.name === realInventoryPayload.store.name
                      && current.mabang?.name === realInventoryPayload.mabang.name
                      && current.combo?.name === realInventoryPayload.combo.name;
                  }, 25000);
                  document.getElementById('inv15Analyze').click();
                  await waitFor(() => window.__inventoryV15.getSession().results.length === 451, 25000);
                  const realSession = window.__inventoryV15.getSession();
                  const flowCounts = realSession.results.reduce((counts, row) => {
                    counts[row.flow] = (counts[row.flow] || 0) + 1;
                    return counts;
                  }, {});
                  const realBlob = await window.__inventoryV15.buildWorkbookForTest();
                  const realBuffer = await realBlob.arrayBuffer();
                  const realWorkbook = await openWorkbook(realBuffer.slice(0));
                  const realTemplate = await getSheet(realWorkbook, realWorkbook.sheets.find(sheet => sheet.name === 'template'));
                  const preservedManualSku = realSession.results.find(row => row.row === 307)?.finalSku === 'TKZP001';
                  realInventoryDetails = {
                    dataStartRow: realSession.store.dataStartRow,
                    audit: realSession.audit,
                    flowCounts,
                    sheetCount: realWorkbook.sheets.length,
                    instructionCell: cellValue(realTemplate, 2, 8),
                    firstCfs: cellValue(realTemplate, 5, 13),
                    firstGaoyi: cellValue(realTemplate, 5, 15),
                    preservedManualSku,
                  };
                  realInventorySample = realSession.store.dataStartRow === 5
                    && realSession.audit?.ok === true
                    && realSession.audit.totalRows === 451
                    && realSession.audit.changedRows === 268
                    && realSession.audit.unresolvedRows === 141
                    && flowCounts.flow1_original_warehouse === 240
                    && flowCounts.flow2_same_sku_other_warehouse === 21
                    && flowCounts.flow3_same_product_replacement === 7
                    && flowCounts.manual_multi_store_warehouse === 7
                    && realWorkbook.sheets.length === 4
                    && cellValue(realTemplate, 2, 8) === '选填'
                    && cellValue(realTemplate, 5, 13) === 9999
                    && cellValue(realTemplate, 5, 15) === null
                    && preservedManualSku;
                  await window.desktopApp.uploads.save('smoke-real-inventory-output', {
                    name: 'Trail-Go-V15-real-output.xlsx', type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', lastModified: Date.now(),
                  }, new Uint8Array(realBuffer));
                }
              } catch (error) {
                inventoryError = error.message;
              }
              try {
                const firstStoreId = state.stores[0].id;
                go('expenses');
                const mabangInput = document.querySelector('[data-exp-upload="' + firstStoreId + '|mabang"]');
                assignFile(mabangInput, makeWorkbookFile('mabang-review.xlsx', '测评', [
                  ['交易编号', '订单核算金额（原始货币）', '测评费用', '后续字段'],
                  ['A', 100, 10, 'same'],
                  ['A', 100, 10, 'same'],
                  ['B', 100, 10, 'main'],
                  ['B', 999, 10, 'main'],
                  ['B', 20, 0, 'extra-a'],
                  ['B', 999, 0, 'extra-a'],
                  ['B', 30, 0, 'extra-b'],
                  ['C', 50, 0, 'zero-only'],
                  ['C', 80, 0, 'zero-only']
                ]));
                await waitFor(() => window.__expenseV13.hasUpload(firstStoreId, 'mabang'));
                const prepared = window.__expenseV13.prepareMabangRowsForTest(firstStoreId);
                mabangDedupe = prepared.rows.find(row => row.order === 'A')?.amount === 100
                  && prepared.rows.find(row => row.order === 'B')?.amount === 150
                  && prepared.rows.find(row => row.order === 'C')?.amount === 50
                  && prepared.stats.dedupedTenRows === 2 && prepared.stats.dedupedZeroRows === 2
                  && prepared.stats.mergedZeroRows === 2;
                window.__desktopEnhancementsV13.scanFileInputs();
                await waitFor(() => document.querySelectorAll('#page-expenses .desktop-clear-upload').length >= document.querySelectorAll('#page-expenses input[data-exp-upload]').length);
                state.skuSuffixRulesV14 = { version: 1, defaultBatteryMode: 'preserve', defaultBatterySuffixes: ['S', 'SE'], stores: { [firstStoreId]: { batteryMode: 'remove', batterySuffixes: ['SE'] } } };
                batterySuffixRule = window.__businessOptimizationsV14.normalizeSkuSuffix('T1234567890SE', firstStoreId, 'lithium battery') === 'T1234567890'
                  && window.__businessOptimizationsV14.normalizeComboStoreSuffix('T4EE1751914XS1') === 'T4EE1751914X'
                  && window.__businessOptimizationsV14.normalizeComboStoreSuffix('T4EE1751914X1S2') === 'T4EE1751914X1';
                fuzzySearch = window.__businessOptimizationsV14.fuzzyMatch('Win Outdoor', 'wntdor');
                go('activity');
                document.getElementById('activityFallbackRegularRatio').value = '0.945';
                document.getElementById('activityFallbackCampaignRatio').value = '0.915';
                document.getElementById('activityFallbackCampaignRatio').dispatchEvent(new Event('change', { bubbles: true }));
                document.getElementById('activityThresholdFallback').checked = true;
                document.getElementById('activityThresholdFallback').dispatchEvent(new Event('change', { bubbles: true }));
                await waitFor(() => state.activityThresholdFallback === true && state.activityFallbackRegularRatio === 0.945 && state.activityFallbackCampaignRatio === 0.915);
                activityFallbackConfig = activityFallbackDecision(true, 'regular', 94.5, 100, state.activityFallbackRegularRatio, state.activityFallbackCampaignRatio).eligible
                  && !activityFallbackDecision(true, 'campaign', 91.49, 100, state.activityFallbackRegularRatio, state.activityFallbackCampaignRatio).eligible
                  && document.getElementById('activityFallbackRatioSummary').textContent.includes('94.5%');
                const stockMapping = { campaignStockCol: 7 };
                const invalidRequested = {};
                const invalidAvailable = {};
                const cappedStock = {};
                activityStockBoundaries = !applyActivityStock(invalidRequested, stockMapping, -1, 10, 'cap')
                  && invalidRequested.statusCode === 'stock_shortage'
                  && !applyActivityStock(invalidAvailable, stockMapping, 5, -1, 'cap')
                  && invalidAvailable.statusCode === 'stock_shortage'
                  && applyActivityStock(cappedStock, stockMapping, 8, 3, 'cap')
                  && cappedStock.campaignStock === 3;

                const fallbackPricingRow = { manualPrice: null, suggestedPrice: 94.5, manualInclude: true, thresholdPrice: 94.5 };
                const blockedFallbackPricingRow = { manualPrice: null, suggestedPrice: null, manualInclude: false, thresholdPrice: 94.5 };
                const repricingNormal = { manualPrice: null, suggestedPrice: 88.88, applyChange: true, isEarlyBird: false };
                const repricingEarly = { manualPrice: 99, suggestedPrice: 88.88, applyChange: true, isEarlyBird: true };
                pricingBoundaries = activityFinalPrice(fallbackPricingRow) === 94.5 && activityCanExport(fallbackPricingRow)
                  && !activityCanExport(blockedFallbackPricingRow)
                  && repricingWillPatch(repricingNormal) && !repricingWillPatch(repricingEarly)
                  && roundPrice(1.005) === 1.01 && parseThreshold('0 < Price ≤ 100') === 100;

                const expenseHelpers = window.__expenseV13.helpersForTest;
                expenseBoundaries = expenseHelpers.n('(1,234.50)') === -1234.5
                  && expenseHelpers.n('₱ -88.25') === -88.25
                  && expenseHelpers.n('无效') === 0
                  && expenseHelpers.inRange('2026-08-01', '2026-08-01', '2026-08-31')
                  && !expenseHelpers.inRange('2026-09-01', '2026-08-01', '2026-08-31')
                  && JSON.stringify(expenseHelpers.monthRange('2024-02')) === JSON.stringify(['2024-02-01', '2024-02-29'])
                  && expenseHelpers.remainingDays('2000-01-01') === 0
                  && expenseHelpers.calculations().final.avgDailyAvailable === 0
                  && Number.isFinite(expenseHelpers.calculations().final.dailyOrders);

                go('stores');
                document.getElementById('addStoreBtn').click();
                await waitFor(() => document.getElementById('newStoreName'));
                document.getElementById('newStoreName').value = 'Smoke 联动店铺';
                document.getElementById('modalOk').click();
                await waitFor(() => state.stores.some(store => store.name === 'Smoke 联动店铺'));
                const linkedStore = state.stores.find(store => store.name === 'Smoke 联动店铺');
                go('inventory');
                window.__inventoryV15.refreshStores();
                const addedOption = [...document.getElementById('inv15StoreSelect').options].find(option => option.value === linkedStore.id);
                go('stores');
                document.querySelector('[data-store="' + linkedStore.id + '"]').click();
                document.getElementById('editStoreBtn').click();
                await waitFor(() => document.getElementById('editStoreName'));
                document.getElementById('editStoreName').value = 'Smoke 已改名店铺';
                document.getElementById('modalOk').click();
                await waitFor(() => state.stores.some(store => store.id === linkedStore.id && store.name === 'Smoke 已改名店铺'));
                go('inventory');
                window.__inventoryV15.refreshStores();
                const renamedOption = [...document.getElementById('inv15StoreSelect').options].find(option => option.value === linkedStore.id);
                inventoryStoreLink = Boolean(addedOption && renamedOption?.textContent.includes('Smoke 已改名店铺'));
                go('stores');
                document.querySelector('[data-store="' + linkedStore.id + '"]').click();
                document.getElementById('deleteStoreBtn').click();
                await waitFor(() => document.getElementById('modalTitle').textContent.includes('删除店铺'));
                document.getElementById('modalOk').click();
                await waitFor(() => !state.stores.some(store => store.id === linkedStore.id));
                window.__inventoryV15.refreshStores();
                storeManagementButtons = ![...document.getElementById('inv15StoreSelect').options].some(option => option.value === linkedStore.id);

                go('dailyreport');
                await waitFor(() => document.getElementById('dailyReportFrame')?.contentDocument?.querySelector('button[data-action="rename"]'), 15000);
                const dailyDocument = document.getElementById('dailyReportFrame').contentDocument;
                const dailyTemplate = dailyDocument.getElementById('templateType');
                let dailySystemsPassed = 0;
                for (const [template, label] of [['philippines', '菲律宾'], ['thailand', '泰国']]) {
                  dailyTemplate.value = template;
                  dailyTemplate.dispatchEvent(new Event('change', { bubbles: true }));
                  await waitFor(() => dailyDocument.getElementById('shopCount')?.textContent.includes(label));
                  dailyDocument.getElementById('addShop').click();
                  await waitFor(() => dailyDocument.getElementById('shopAddEditor')?.style.display === 'flex');
                  const newName = 'Smoke ' + label + '新增店铺';
                  dailyDocument.getElementById('newShopName').value = newName;
                  dailyDocument.getElementById('saveNewShop').click();
                  await waitFor(() => [...dailyDocument.querySelectorAll('.shop-name')].some(element => element.textContent === newName));
                  const newCard = [...dailyDocument.querySelectorAll('.shop-card')].find(card => card.querySelector('.shop-name')?.textContent === newName);
                  newCard.querySelector('button[data-action="rename"]').click();
                  await waitFor(() => newCard.querySelector('input[data-rename-editor]') && newCard.querySelector('button[data-action="save-rename"]'));
                  const renamed = 'Smoke ' + label + '已改名';
                  newCard.querySelector('input[data-rename-editor]').value = renamed;
                  newCard.querySelector('button[data-action="save-rename"]').click();
                  await waitFor(() => [...dailyDocument.querySelectorAll('.shop-name')].some(element => element.textContent === renamed));
                  dailySystemsPassed += 1;
                }
                dailyRename = dailySystemsPassed === 2;

                go('dashboard');
                aiObserver = Boolean(document.getElementById('page-ai-observer') && document.querySelector('[data-page="ai-observer"]')?.textContent.includes('AI分析模板'));
                aiTemplateIsolated = getComputedStyle(document.getElementById('page-ai-observer')).display === 'none'
                  && getComputedStyle(document.getElementById('page-data-safety')).display === 'none';
                aiSettingsCollapsed = document.querySelector('#ai14SettingsPanel .ai14-settings-body')?.classList.contains('ai14-collapsed') === true;
                const releaseVersions = [...document.querySelectorAll('#page-changelog [data-release-version]')].map(card => card.dataset.releaseVersion);
                releaseHistoryRetained = ['V14.4', 'V14.3', 'V14.2', 'V14.1', 'V14.0', 'V13.0'].every(version => releaseVersions.includes(version));
                const comboWorkbook = makeWorkbookFile('combo-sku.xlsx', '组合关系', [
                  ['组合sku编码', '组合sku中文名称', '总组合库存', '总可用组合库存', '关联sku编号1', '关联sku捆绑数量1', '关联sku编号2', '关联sku捆绑数量2'],
                  ['T4EE1751914X1', 'Smoke组合商品', 999, 888, 'SMOKEA0001', 2, 'SMOKEB0001', 1]
                ]);
                const parsedCombo = await window.__repricingComboV141.parseWorkbook(comboWorkbook);
                const smokeDatabaseId = state.databases[0].id;
                currentMatchDatabaseId = smokeDatabaseId;
                state.controlRecords.push(
                  { sku: 'SMOKEA0001', product_name_cn: 'Smoke普通A', la_price: 100, is_forbidden: 0, is_combo: 0, library_type: 'ordinary', database_id: smokeDatabaseId },
                  { sku: 'SMOKEB0001', product_name_cn: 'Smoke普通B', la_price: 150, is_forbidden: 0, is_combo: 0, library_type: 'ordinary', database_id: smokeDatabaseId }
                );
                const resolvedCombo = window.__repricingComboV141.resolve('T4EE1751914X1S1', firstStoreId, parsedCombo);
                comboRepricing = parsedCombo.items.size === 1 && parsedCombo.inventoryColumnsIgnored === true
                  && resolvedCombo.method === 'combo_components' && resolvedCombo.record.la_price === 350
                  && resolvedCombo.matched === 'T4EE1751914X1';
                dataSafety = Boolean(document.getElementById('page-data-safety') && document.querySelector('[data-page="data-safety"]'));
                const info = await window.desktopApp.database.info();
                databaseSchema = info.schemaVersion;
                restrictedBridge = !Object.hasOwn(info, 'path') && typeof window.require === 'undefined'
                  && typeof window.desktopApp.database.query === 'undefined' && typeof window.desktopApp.ipcRenderer === 'undefined';
                const status = await window.desktopApp.aiSettings.status();
                noKeyStart = status.aiEnabled === false && status.providers.some(provider => provider.providerId === 'deepseek' && !provider.keyStatus.configured);
                await window.desktopApp.aiSettings.setEnabled(true);
                const aiSession = await window.desktopApp.aiChat.createSession({ name: 'Smoke Mock', providerId: 'mock' });
                const mock = await window.desktopApp.aiChat.sendMessage({ requestId: 'req-smoke-chat', sessionId: aiSession.id, text: '只读测试', providerId: 'mock' });
                mockChat = mock.message.content.includes('没有修改任何文件');
                go('ai-observer');
                assignFile(document.getElementById('ai14AttachmentInput'), new File(['ui attachment preview'], 'ui-smoke.txt', { type: 'text/plain' }));
                await waitFor(() => document.querySelectorAll('#ai14Attachments .ai14-attachment').length === 1);
                const attachmentUi = document.getElementById('ai14Attachments').textContent.includes('ui-smoke.txt');
                document.querySelector('#ai14Attachments [data-ai14-remove-attachment]')?.click();
                const attachmentSecret = 'SMOKE-ATTACHMENT-MUST-NOT-PERSIST';
                await window.desktopApp.aiChat.sendMessage({
                  requestId: 'req-smoke-attachment', sessionId: aiSession.id, text: '附件隔离测试', providerId: 'mock', confirmedAttachments: true,
                  attachments: [{ kind: 'text', name: 'smoke.txt', mimeType: 'text/plain', size: attachmentSecret.length, text: attachmentSecret }]
                });
                const savedMessages = await window.desktopApp.aiChat.getMessages({ sessionId: aiSession.id, limit: 100 });
                attachmentChat = attachmentUi && Boolean(document.getElementById('ai14AttachmentInput') && document.getElementById('ai14AddAttachment'))
                  && savedMessages.some(message => message.role === 'user' && message.content.includes('smoke.txt'))
                  && savedMessages.every(message => !message.content.includes(attachmentSecret));
                const preview = await window.desktopApp.aiContext.buildPreview({
                  sessionId: aiSession.id, question: '联合分析控价活动日报测试', countryCode: 'ph', modules: ['control_price', 'activity_price', 'daily_report'], indicators: ['count'],
                  includeSku: false, includeTitles: false, includeDetails: false, maxDetailRows: 100,
                  includeAnomalies: false, includeRecentChat: false, includeMemories: false
                });
                contextPreview = preview.summary.detailRows === 0 && preview.previewId.startsWith('preview-')
                  && preview.summary.modules.includes('control_price') && preview.summary.modules.length === 3;
                const analyzed = await window.desktopApp.aiContext.confirmAndSend({ requestId: 'req-smoke-context', sessionId: aiSession.id, providerId: 'mock', previewId: preview.previewId, confirmed: true });
                contextSend = analyzed.sources.length === 3 && analyzed.message.content.includes('只读');
              } catch (error) {
                inventoryError = inventoryError ? inventoryError + ' | V14: ' + error.message : 'V14: ' + error.message;
              }
              resolve({
              title: document.title,
              xlsxVersion: window.XLSX && window.XLSX.version,
              navItems: document.querySelectorAll('#nav button[data-page]').length,
              pages: document.querySelectorAll('main .page').length,
              dashboard: Boolean(document.getElementById('page-dashboard')),
              settings: Boolean(document.getElementById('page-settings')),
              inventory: Boolean(document.getElementById('page-inventory')),
              desktopBridge: Boolean(window.desktopApp && window.desktopApp.isDesktop),
              databaseReady: Boolean(window.desktopApp?.database?.ready),
              themeCount: typeof THEMES === 'object' ? Object.keys(THEMES).length : 0,
              warehouseCount: window.__inventoryV15.getConfig().warehouses.length,
              spreadsheetInputs: [...document.querySelectorAll('input[type="file"]')].filter(input => /xls|xlsx|xlsm|csv/i.test(input.accept || '') || input.hasAttribute('data-exp-upload')).length,
              clearButtons: document.querySelectorAll('.desktop-clear-upload').length,
              inventoryClearButtons: document.querySelectorAll('.inv15-clear').length,
              expenseInputs: document.querySelectorAll('#page-expenses input[data-exp-upload]').length,
              expenseClearButtons: document.querySelectorAll('#page-expenses .desktop-clear-upload').length,
              expenseBridge: Boolean(window.__expenseV13?.ready),
              databasePanel: Boolean(document.getElementById('databaseV13')),
              aiObserver,
              aiTemplateIsolated,
              aiSettingsCollapsed,
              comboRepricing,
              releaseHistoryRetained,
              dataSafety,
              restrictedBridge,
              noKeyStart,
              mockChat,
              attachmentChat,
              contextPreview,
              contextSend,
              dailyRename,
              inventoryStoreLink,
              storeManagementButtons,
              databaseSchema,
              mabangDedupe,
              fuzzySearch,
              batterySuffixRule,
              activityFallbackConfig,
              activityStockBoundaries,
              pricingBoundaries,
              expenseBoundaries,
              inventoryAnalysis,
              inventoryExport,
              inventoryPersistence,
              inventorySkuRules,
              realInventorySample,
              realInventoryDetails,
              inventoryError,
              version: window.desktopApp?.version
              });
            }, 300);
            return;
          }
          if (Date.now() - started > 18000) reject(new Error('V15 enhancements did not initialize'));
          else setTimeout(inspect, 100);
        };
        inspect();
      })`);
      const ok = result.title.includes('Lazada') && result.xlsxVersion && result.navItems >= 13 && result.pages >= 13
        && result.dashboard && result.settings && result.inventory && result.desktopBridge
        && result.databaseReady && result.themeCount === 1 && result.warehouseCount >= 2
        && result.spreadsheetInputs > 0 && result.clearButtons + result.inventoryClearButtons >= result.spreadsheetInputs
        && result.expenseInputs > 0 && result.expenseClearButtons >= result.expenseInputs
        && result.inventoryAnalysis && result.inventoryExport && result.inventoryPersistence && result.inventorySkuRules && result.realInventorySample
        && result.mabangDedupe && result.fuzzySearch && result.batterySuffixRule && result.activityFallbackConfig
        && result.activityStockBoundaries && result.pricingBoundaries && result.expenseBoundaries
        && result.dailyRename && result.inventoryStoreLink && result.storeManagementButtons
        && result.aiObserver && result.aiTemplateIsolated && result.aiSettingsCollapsed && result.comboRepricing && result.releaseHistoryRetained
        && result.dataSafety && result.restrictedBridge && result.noKeyStart
        && result.mockChat && result.attachmentChat && result.contextPreview && result.contextSend && result.databaseSchema === '5'
        && result.expenseBridge && result.databasePanel
        && result.version === APP_VERSION;
      console.log(`SMOKE_TEST_RESULT: ${JSON.stringify(result)}`);
      if (isRealInventoryTest) {
        const realExport = operationsDatabase.readUpload('smoke-real-inventory-output');
        if (!realExport) throw new Error('Real inventory export was not saved');
        const realExportPath = path.join(app.getPath('temp'), 'lazada-inventory-v15-real-output.xlsx');
        fs.writeFileSync(realExportPath, Buffer.from(realExport.content));
        console.log(`SMOKE_TEST_REAL_EXPORT: ${realExportPath}`);
      }
      await win.webContents.executeJavaScript(`
        window.go('inventory');
        document.documentElement.dataset.theme = 'glass-light';
        window.scrollTo({top:0,left:0,behavior:'auto'});
      `);
      await new Promise((resolve) => setTimeout(resolve, 700));
      const previewState = await win.webContents.executeJavaScript(`
        window.go('inventory');
        document.querySelectorAll('.page').forEach(page => page.classList.toggle('active', page.id === 'page-inventory'));
        document.querySelectorAll('#nav button').forEach(button => button.classList.toggle('active', button.dataset.page === 'inventory'));
        document.getElementById('pageTitle').textContent = '库存识别';
        document.getElementById('pageSub').textContent = 'V15 三表知识库、自动改表与最终复核';
        window.scrollTo({top:0,left:0,behavior:'auto'});
        ({ activePage: document.querySelector('.page.active')?.id, title: document.getElementById('pageTitle')?.textContent });
      `);
      console.log(`SMOKE_TEST_PREVIEW_STATE: ${JSON.stringify(previewState)}`);
      win.showInactive();
      await new Promise((resolve) => setTimeout(resolve, 350));
      const previewPath = path.join(app.getPath('temp'), 'lazada-inventory-v15-preview.png');
      const preview = await win.webContents.capturePage();
      win.hide();
      fs.writeFileSync(previewPath, preview.toPNG());
      console.log(`SMOKE_TEST_SCREENSHOT: ${previewPath}`);
      clearTimeout(timeout);
      app.exit(ok && previewState.activePage === 'page-inventory' ? 0 : 1);
    } catch (error) {
      clearTimeout(timeout);
      console.error('SMOKE_TEST_FAILED:', error);
      app.exit(1);
    }
  });
}

function createWindow() {
  const state = readWindowState();
  const win = new BrowserWindow({
    title: `${APP_NAME} V${DISPLAY_VERSION}`,
    width: state.width,
    height: state.height,
    x: state.x,
    y: state.y,
    minWidth: 1100,
    minHeight: 700,
    show: false,
    autoHideMenuBar: true,
    frame: false,
    transparent: !isPlaywrightTest,
    hasShadow: false,
    backgroundColor: isPlaywrightTest ? '#F1F5F9' : '#00000000',
    icon: path.join(__dirname, '..', 'build', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      spellcheck: false,
    },
  });

  mainWindow = win;
  win.webContents.on('render-process-gone', (_event, details) => {
    console.error('RENDER_PROCESS_GONE:', JSON.stringify(details));
  });
  win.webContents.on('did-fail-load', (_event, code, description, url, isMainFrame) => {
    console.error('DID_FAIL_LOAD:', JSON.stringify({ code, description, url, isMainFrame }));
  });
  if (state.maximized && !isSmokeTest && !isUiTest) win.maximize();

  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });

  win.webContents.on('will-navigate', (event, url) => {
    if (url !== win.webContents.getURL()) {
      event.preventDefault();
      if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    }
  });

  win.on('resize', () => scheduleWindowStateSave(win));
  win.on('move', () => scheduleWindowStateSave(win));
  win.on('maximize', () => scheduleWindowStateSave(win));
  win.on('unmaximize', () => scheduleWindowStateSave(win));
  win.on('close', () => writeWindowState(win));
  win.on('closed', () => { mainWindow = null; });

  if (isSmokeTest) {
    runSmokeTest(win);
  } else if (isUiTest) {
    runUiTest(win);
    win.once('ready-to-show', () => win.show());
  } else {
    win.once('ready-to-show', () => win.show());
  }

  win.loadFile(path.join(__dirname, '..', 'app', 'index.html'));
  return win;
}

app.on('second-instance', () => {
  if (!mainWindow) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
});

app.whenReady().then(() => {
  loadRecentDownloads();
  registerDownloadHandlers();
  registerWindowHandlers();
  const contextBuilder = registerDatabaseHandlers();
  startNorthstarReadOnlyApi(contextBuilder);
  registerAutomationFolderHandlers({ app, ipcMain, dialog, shell, getWindow: () => mainWindow });
  configureSession();
  buildMenu();
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => app.quit());
app.on('will-quit', () => {
  void northstarServer?.stop();
  operationsDatabase?.close();
});
