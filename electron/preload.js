const { contextBridge, ipcRenderer } = require('electron');

const APP_VERSION = '16.3.0';
const DISPLAY_VERSION = '16.3';
let databaseReady = false;
let lastStorage = new Map();
let syncTimer = null;
let syncInFlight = false;
let syncPending = false;

function readStorageMap() {
  const map = new Map();
  for (let index = 0; index < localStorage.length; index += 1) {
    const key = localStorage.key(index);
    if (key !== null) map.set(key, localStorage.getItem(key) ?? '');
  }
  return map;
}

function restoreDatabaseStorage() {
  try {
    const payload = ipcRenderer.sendSync('database:load-storage');
    if (payload?.error) throw new Error(payload.error);
    if (payload?.initialized) {
      localStorage.clear();
      for (const [key, value] of payload.entries || []) localStorage.setItem(key, value);
    }
    lastStorage = readStorageMap();
    if (!payload?.initialized) {
      const result = ipcRenderer.sendSync('database:replace-storage', [...lastStorage.entries()]);
      if (!result?.ok) throw new Error(result?.error || '首次数据库初始化失败');
    }
    databaseReady = true;
  } catch (error) {
    console.error('Unable to restore SQLite data:', error);
    lastStorage = readStorageMap();
  }
}

function storageDiff() {
  const current = readStorageMap();
  const changes = [];
  const removed = [];
  for (const [key, value] of current) {
    if (!lastStorage.has(key) || lastStorage.get(key) !== value) changes.push([key, value]);
  }
  for (const key of lastStorage.keys()) if (!current.has(key)) removed.push(key);
  return { current, changes, removed };
}

async function syncStorage() {
  if (!databaseReady) return { ok: false, error: 'database unavailable' };
  if (syncInFlight) {
    syncPending = true;
    return { ok: true, queued: true };
  }
  const diff = storageDiff();
  if (!diff.changes.length && !diff.removed.length) return { ok: true, unchanged: true };
  syncInFlight = true;
  try {
    const result = await ipcRenderer.invoke('database:sync-storage', diff.changes, diff.removed);
    lastStorage = diff.current;
    return result;
  } catch (error) {
    console.error('Unable to sync SQLite data:', error);
    return { ok: false, error: error.message };
  } finally {
    syncInFlight = false;
    if (syncPending) {
      syncPending = false;
      queueMicrotask(syncStorage);
    }
  }
}

function scheduleSync(delay = 450) {
  clearTimeout(syncTimer);
  syncTimer = setTimeout(syncStorage, delay);
}

function flushStorageSync() {
  if (!databaseReady) return { ok: false, error: 'database unavailable' };
  try {
    const current = readStorageMap();
    const result = ipcRenderer.sendSync('database:replace-storage', [...current.entries()]);
    if (result?.ok) lastStorage = current;
    return result;
  } catch (error) {
    console.error('Unable to flush SQLite data:', error);
    return { ok: false, error: error.message };
  }
}

restoreDatabaseStorage();

async function secureInvoke(channel, ...args) {
  const result = await ipcRenderer.invoke(channel, ...args);
  if (!result?.ok) {
    const error = new Error(result?.error?.message || '操作失败');
    error.code = result?.error?.code || 'UNKNOWN_ERROR';
    error.details = result?.error?.details;
    throw error;
  }
  return result.data;
}

const aiEventSubscribers = new Set();
const downloadSubscribers = new Set();
const downloadDragErrorSubscribers = new Set();
ipcRenderer.on('ai:stream-event', (_event, payload) => {
  const safePayload = payload && typeof payload === 'object' ? Object.freeze({ ...payload }) : Object.freeze({ type: 'error' });
  for (const subscriber of aiEventSubscribers) {
    try { subscriber(safePayload); } catch (error) { console.error('AI event subscriber failed:', error); }
  }
});
ipcRenderer.on('downloads:changed', (_event, payload) => {
  const items = Array.isArray(payload) ? payload.map((item) => Object.freeze({ ...item })) : [];
  for (const subscriber of downloadSubscribers) {
    try { subscriber(items); } catch (error) { console.error('Download subscriber failed:', error); }
  }
});
ipcRenderer.on('downloads:drag-error', (_event, message) => {
  for (const subscriber of downloadDragErrorSubscribers) {
    try { subscriber(String(message || '文件已移动或删除')); } catch (error) { console.error('Download drag error subscriber failed:', error); }
  }
});

contextBridge.exposeInMainWorld('desktopApp', Object.freeze({
  isDesktop: true,
  platform: process.platform,
  version: APP_VERSION,
  displayVersion: DISPLAY_VERSION,
  database: Object.freeze({
    ready: databaseReady,
    flush: () => syncStorage(),
    info: () => secureInvoke('database:secure-info'),
    openFolder: () => secureInvoke('database:secure-open-folder'),
  }),
  uploads: Object.freeze({
    list: () => ipcRenderer.invoke('uploads:list'),
    read: (slot) => ipcRenderer.invoke('uploads:read', slot),
    save: (slot, metadata, bytes) => ipcRenderer.invoke('uploads:save', slot, metadata, bytes),
    remove: (slot) => ipcRenderer.invoke('uploads:delete', slot),
  }),
  downloads: Object.freeze({
    list: () => ipcRenderer.invoke('downloads:list'),
    remove: (value) => ipcRenderer.invoke('downloads:remove', value),
    open: (value) => ipcRenderer.invoke('downloads:open', value),
    openLocation: (value) => ipcRenderer.invoke('downloads:open-location', value),
    copyPath: (value) => ipcRenderer.invoke('downloads:copy-path', value),
    contextMenu: (value) => ipcRenderer.invoke('downloads:context-menu', value),
    drag: (value) => ipcRenderer.send('downloads:start-drag', value),
    onChanged: (subscriber) => {
      if (typeof subscriber !== 'function') throw new TypeError('Download subscriber must be a function');
      downloadSubscribers.add(subscriber);
      return () => downloadSubscribers.delete(subscriber);
    },
    onDragError: (subscriber) => {
      if (typeof subscriber !== 'function') throw new TypeError('Download drag error subscriber must be a function');
      downloadDragErrorSubscribers.add(subscriber);
      return () => downloadDragErrorSubscribers.delete(subscriber);
    },
  }),
  automationFolders: Object.freeze({
    choose: () => ipcRenderer.invoke('automation-folder:choose'),
    connectDesktop: (value) => ipcRenderer.invoke('automation-folder:connect-desktop', value),
    reconnect: (value) => ipcRenderer.invoke('automation-folder:reconnect', value),
    scan: (value) => ipcRenderer.invoke('automation-folder:scan', value),
    read: (value) => ipcRenderer.invoke('automation-folder:read', value),
    save: (value) => ipcRenderer.invoke('automation-folder:save', value),
    open: (value) => ipcRenderer.invoke('automation-folder:open', value),
  }),
  window: Object.freeze({
    minimize: () => ipcRenderer.invoke('window:minimize'),
    maximizeToggle: () => ipcRenderer.invoke('window:maximize-toggle'),
    close: () => ipcRenderer.invoke('window:close'),
  }),
  aiSettings: Object.freeze({
    status: () => secureInvoke('ai:status'),
    setEnabled: (enabled) => secureInvoke('ai:set-enabled', enabled),
    saveLimits: (limits) => secureInvoke('ai:save-limits', limits),
    getProviders: () => secureInvoke('ai:providers'),
    saveProviderConfig: (config) => secureInvoke('ai:provider-save', config),
    hasKey: (providerId) => secureInvoke('ai:key-status', providerId),
    saveKey: (providerId, apiKey) => secureInvoke('ai:key-save', providerId, apiKey),
    deleteKey: (providerId) => secureInvoke('ai:key-delete', providerId),
    testConnection: (providerId) => secureInvoke('ai:test-connection', providerId),
  }),
  aiChat: Object.freeze({
    createSession: (value) => secureInvoke('ai:session-create', value),
    getSessions: () => secureInvoke('ai:sessions'),
    renameSession: (value) => secureInvoke('ai:session-rename', value),
    deleteSession: (value) => secureInvoke('ai:session-delete', value),
    clearSession: (value) => secureInvoke('ai:session-clear', value),
    getMessages: (value) => secureInvoke('ai:messages', value),
    sendMessage: (value) => secureInvoke('ai:message-send', value),
    cancelRequest: (requestId) => secureInvoke('ai:request-cancel', requestId),
    summarizeSession: (value) => secureInvoke('ai:session-summarize', value),
    onEvent: (subscriber) => {
      if (typeof subscriber !== 'function') throw new TypeError('AI事件监听器必须是函数');
      aiEventSubscribers.add(subscriber);
      return () => aiEventSubscribers.delete(subscriber);
    },
  }),
  aiContext: Object.freeze({
    getOptions: () => secureInvoke('ai:context-options'),
    buildPreview: (value) => secureInvoke('ai:context-preview', value),
    confirmAndSend: (value) => secureInvoke('ai:context-confirm-send', value),
  }),
  aiMemory: Object.freeze({
    list: (value = {}) => secureInvoke('ai:memory-list', value),
    createConfirmed: (value) => secureInvoke('ai:memory-create', value),
    update: (value) => secureInvoke('ai:memory-update', value),
    disable: (value) => secureInvoke('ai:memory-disable', value),
    remove: (value) => secureInvoke('ai:memory-delete', value),
  }),
  backup: Object.freeze({
    create: (value = { reason: 'manual' }) => secureInvoke('backup:create', value),
    list: () => secureInvoke('backup:list'),
    integrity: () => secureInvoke('backup:integrity'),
    restore: (value) => secureInvoke('backup:restore', value),
    export: (value) => secureInvoke('backup:export', value),
    import: () => secureInvoke('backup:import'),
    cleanup: (value = {}) => secureInvoke('backup:cleanup', value),
    setRetention: (value) => secureInvoke('backup:set-retention', value),
  }),
  migration: Object.freeze({
    preview: () => secureInvoke('migration:preview'),
    execute: (value) => secureInvoke('migration:execute', value),
    defer: () => secureInvoke('migration:defer'),
  }),
}));

function updateDesktopBranding() {
  document.title = `Lazada户外运营中心 V${DISPLAY_VERSION}`;
  document.documentElement.classList.add('desktop-app');
  document.documentElement.dataset.appVersion = DISPLAY_VERSION;

  const brandLabel = document.getElementById('brandSystemLabel');
  if (brandLabel) brandLabel.textContent = brandLabel.textContent.replace(/^V\d+(?:\.\d+)?/, `V${DISPLAY_VERSION}`);

  const brandMark = document.querySelector('.brand-mark');
  if (brandMark && !brandMark.querySelector('img')) {
    brandMark.textContent = '';
    brandMark.style.padding = '0';
    brandMark.style.overflow = 'hidden';
    const logo = document.createElement('img');
    logo.src = './logo.png';
    logo.alt = 'Lazada户外运营中心';
    logo.style.cssText = 'display:block;width:100%;height:100%;object-fit:cover';
    brandMark.appendChild(logo);
  }

  const chip = document.querySelector('.local-chip');
  if (chip) chip.innerHTML = '<i></i>SQLite 自动保存';

  const footText = document.querySelector('.sidebar-foot > div:last-child');
  if (footText) footText.textContent = '数据和月度费用表格保存在本机数据库中。Excel 不会上传到服务器。';
}

function installWindowChrome() {
  // Preload runs in Electron's isolated world. Objects exposed through
  // contextBridge are intentionally unavailable back inside this world, so
  // checking window.desktopApp here made the title-bar installation exit
  // before creating any controls. Bind the trusted IPC calls directly.
  if (document.querySelector('.v155-window-chrome')) return;
  const chrome = document.createElement('div');
  chrome.className = 'v155-window-chrome';
  chrome.innerHTML = `
    <div class="v155-window-brand" data-window-drag aria-label="拖动窗口"></div>
    <div class="v155-window-actions" data-window-no-drag>
      <button type="button" data-window-action="minimize" aria-label="最小化" title="最小化">−</button>
      <button type="button" data-window-action="maximize" aria-label="最大化" title="最大化或还原">□</button>
      <button type="button" class="close" data-window-action="close" aria-label="关闭" title="关闭">×</button>
    </div>`;
  document.body.prepend(chrome);
  const dragSurface = chrome.querySelector('[data-window-drag]');
  let dragging = false;
  let lastDragX = 0;
  let lastDragY = 0;
  let pendingDragX = 0;
  let pendingDragY = 0;
  let dragFrame = 0;
  const flushDrag = () => {
    dragFrame = 0;
    const dx = Math.round(pendingDragX);
    const dy = Math.round(pendingDragY);
    pendingDragX = 0;
    pendingDragY = 0;
    if (dx || dy) ipcRenderer.send('window:drag-delta', { dx, dy });
  };
  const finishDrag = () => {
    if (!dragging) return;
    dragging = false;
    if (dragFrame) cancelAnimationFrame(dragFrame);
    flushDrag();
  };
  dragSurface.addEventListener('mousedown', (event) => {
    if (event.button !== 0) return;
    dragging = true;
    lastDragX = event.clientX;
    lastDragY = event.clientY;
    pendingDragX = 0;
    pendingDragY = 0;
    event.preventDefault();
  });
  window.addEventListener('mousemove', (event) => {
    if (!dragging) return;
    pendingDragX += event.clientX - lastDragX;
    pendingDragY += event.clientY - lastDragY;
    lastDragX = event.clientX;
    lastDragY = event.clientY;
    if (!dragFrame) dragFrame = requestAnimationFrame(flushDrag);
    event.preventDefault();
  }, true);
  window.addEventListener('mouseup', finishDrag, true);
  window.addEventListener('blur', finishDrag);
  chrome.querySelector('[data-window-action="minimize"]').addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    void ipcRenderer.invoke('window:minimize');
  });
  chrome.querySelector('[data-window-action="maximize"]').addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    void ipcRenderer.invoke('window:maximize-toggle');
  });
  chrome.querySelector('[data-window-action="close"]').addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    void ipcRenderer.invoke('window:close');
  });
}

async function injectDesktopAssets() {
  for (const href of ['./desktop-enhancements.css', './inventory-v15.css', './ai-observer.css']) {
    const style = document.createElement('link');
    style.rel = 'stylesheet';
    style.href = href;
    document.head.appendChild(style);
  }

  for (const source of ['./desktop-enhancements.js', './inventory-engine-v15.js', './inventory-v15.js', './business-optimizations-v14.js', './ai-observer.js']) {
    await new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = source;
      script.onload = resolve;
      script.onerror = () => reject(new Error(`无法加载 ${source}`));
      document.body.appendChild(script);
    });
  }
}

function clickElement(id) {
  const element = document.getElementById(id);
  if (element) element.click();
}

ipcRenderer.on('desktop-command', (_event, command) => {
  if (command === 'backup') clickElement('backupBtn');
  if (command === 'restore') clickElement('restoreFile');
  if (command === 'flush') flushStorageSync();
});

window.addEventListener('DOMContentLoaded', () => {
  updateDesktopBranding();
  installWindowChrome();
  injectDesktopAssets().catch((error) => console.error(error));
  document.addEventListener('change', () => scheduleSync(250), true);
  document.addEventListener('input', () => scheduleSync(900), true);
  setInterval(syncStorage, 1500);
}, { once: true });

window.addEventListener('beforeunload', () => {
  const active = document.activeElement;
  if (active && /^(INPUT|TEXTAREA|SELECT)$/.test(active.tagName)) {
    active.dispatchEvent(new Event('change', { bubbles: true }));
  }
  flushStorageSync();
});

window.addEventListener('pagehide', flushStorageSync);
