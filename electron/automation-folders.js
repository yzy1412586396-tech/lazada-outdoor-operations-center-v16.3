'use strict';

const fs = require('fs');
const path = require('path');

const INPUT_EXTENSIONS = new Set(['.xls', '.xlsx', '.xlsm']);
const MAX_INPUT_BYTES = 120 * 1024 * 1024;

function normalizePath(value) {
  return path.resolve(String(value || ''));
}

function isWithin(root, target) {
  const normalizedRoot = normalizePath(root);
  const normalizedTarget = normalizePath(target);
  const relative = path.relative(normalizedRoot, normalizedTarget);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function safeFolderName(value) {
  const name = String(value || '').trim();
  if (!name || name === '.' || name === '..' || /[\\/:*?"<>|\x00-\x1f]/.test(name)) {
    throw new Error('文件夹名称无效，请只输入普通文字、数字、空格、点、横线或下划线');
  }
  return name.slice(0, 80);
}

function safeOutputName(value) {
  const name = path.basename(String(value || '').trim());
  if (!name || name !== String(value || '').trim() || !/\.xlsx$/i.test(name) || /[\\/:*?"<>|\x00-\x1f]/.test(name)) {
    throw new Error('输出文件名必须是有效的 .xlsx 文件名');
  }
  return name.slice(0, 180);
}

function availableOutputPath(folderPath, fileName) {
  const first = path.join(folderPath, fileName);
  if (!fs.existsSync(first)) return first;
  const parsed = path.parse(fileName);
  for (let index = 2; index <= 999; index += 1) {
    const candidate = path.join(folderPath, `${parsed.name} (${index})${parsed.ext}`);
    if (!fs.existsSync(candidate)) return candidate;
  }
  throw new Error('同名文件过多，请先整理目标文件夹');
}

function registerAutomationFolderHandlers({ app, ipcMain, dialog, shell, getWindow }) {
  const allowedRoots = new Map();
  const rootsFor = (event) => {
    const key = event.sender.id;
    if (!allowedRoots.has(key)) allowedRoots.set(key, new Set());
    return allowedRoots.get(key);
  };
  const allowRoot = (event, root) => {
    const resolved = normalizePath(root);
    rootsFor(event).add(resolved);
    return resolved;
  };
  const requireRoot = (event, root) => {
    const resolved = normalizePath(root);
    const allowed = [...rootsFor(event)].some((candidate) => candidate === resolved);
    if (!allowed) throw new Error('该文件夹尚未由你选择或连接');
    return resolved;
  };
  const requireFile = (event, filePath) => {
    const resolved = normalizePath(filePath);
    const root = [...rootsFor(event)].find((candidate) => isWithin(candidate, resolved));
    if (!root) throw new Error('该文件不在已连接的数据文件夹中');
    return resolved;
  };

  ipcMain.handle('automation-folder:choose', async (event) => {
    const result = await dialog.showOpenDialog(getWindow(), {
      title: '选择店铺数据文件夹',
      defaultPath: app.getPath('desktop'),
      properties: ['openDirectory', 'createDirectory'],
    });
    if (result.canceled || !result.filePaths[0]) return { canceled: true };
    const folderPath = allowRoot(event, result.filePaths[0]);
    return { canceled: false, folderPath, name: path.basename(folderPath) };
  });

  ipcMain.handle('automation-folder:connect-desktop', async (event, value = {}) => {
    const folderName = safeFolderName(value.folderName);
    const desktop = normalizePath(app.getPath('desktop'));
    const folderPath = path.join(desktop, folderName);
    if (!isWithin(desktop, folderPath)) throw new Error('只能在桌面内创建数据文件夹');
    await fs.promises.mkdir(folderPath, { recursive: true });
    allowRoot(event, folderPath);
    return { folderPath, name: folderName, created: true };
  });

  ipcMain.handle('automation-folder:reconnect', async (event, value = {}) => {
    const folderPath = normalizePath(value.folderPath);
    const stats = await fs.promises.stat(folderPath);
    if (!stats.isDirectory()) throw new Error('已保存的数据文件夹不存在');
    allowRoot(event, folderPath);
    return { folderPath, name: path.basename(folderPath) };
  });

  ipcMain.handle('automation-folder:scan', async (event, value = {}) => {
    const folderPath = requireRoot(event, value.folderPath);
    const entries = await fs.promises.readdir(folderPath, { withFileTypes: true });
    const files = [];
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      if (entry.name.startsWith('~$')) continue;
      const extension = path.extname(entry.name).toLowerCase();
      if (!INPUT_EXTENSIONS.has(extension)) continue;
      const filePath = path.join(folderPath, entry.name);
      const stats = await fs.promises.stat(filePath);
      if (stats.size > MAX_INPUT_BYTES) continue;
      files.push({ name: entry.name, extension, size: stats.size, modifiedAt: stats.mtime.toISOString(), filePath });
    }
    files.sort((a, b) => a.name.localeCompare(b.name, 'zh-CN', { numeric: true, sensitivity: 'base' }));
    return { folderPath, files };
  });

  ipcMain.handle('automation-folder:read', async (event, value = {}) => {
    const filePath = requireFile(event, value.filePath);
    const extension = path.extname(filePath).toLowerCase();
    if (!INPUT_EXTENSIONS.has(extension)) throw new Error('只允许读取 xls、xlsx 或 xlsm 表格');
    const stats = await fs.promises.stat(filePath);
    if (!stats.isFile() || stats.size > MAX_INPUT_BYTES) throw new Error('文件不存在或体积超过120MB');
    return { name: path.basename(filePath), bytes: await fs.promises.readFile(filePath), size: stats.size };
  });

  ipcMain.handle('automation-folder:save', async (event, value = {}) => {
    const folderPath = requireRoot(event, value.folderPath);
    const fileName = safeOutputName(value.fileName);
    const bytes = Buffer.from(value.bytes || []);
    if (!bytes.length || bytes.length > MAX_INPUT_BYTES) throw new Error('输出表格为空或体积超过120MB');
    const targetPath = availableOutputPath(folderPath, fileName);
    const tempPath = `${targetPath}.${process.pid}.${Date.now()}.tmp`;
    try {
      await fs.promises.writeFile(tempPath, bytes, { flag: 'wx' });
      await fs.promises.rename(tempPath, targetPath);
    } catch (error) {
      await fs.promises.rm(tempPath, { force: true }).catch(() => {});
      throw error;
    }
    return { filePath: targetPath, fileName: path.basename(targetPath), size: bytes.length };
  });

  ipcMain.handle('automation-folder:open', async (event, value = {}) => {
    const folderPath = requireRoot(event, value.folderPath);
    return { result: await shell.openPath(folderPath) };
  });

  ipcMain.on('render-process-gone', (event) => allowedRoots.delete(event.sender.id));
}

module.exports = {
  INPUT_EXTENSIONS,
  isWithin,
  safeFolderName,
  safeOutputName,
  registerAutomationFolderHandlers,
};
