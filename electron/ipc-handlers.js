'use strict';

const path = require('path');
const { safeError, fail, plainObject, text, integer } = require('./lib/validation');

function registerSecureHandlers({ ipcMain, dialog, shell, database, aiService, contextBuilder, getWindow }) {
  const handle = (channel, action) => {
    ipcMain.handle(channel, async (event, ...args) => {
      try {
        const data = await action(event, ...args);
        return { ok: true, data };
      } catch (error) {
        return { ok: false, error: safeError(error) };
      }
    });
  };

  handle('ai:status', () => aiService.getStatus());
  handle('ai:set-enabled', (_event, enabled) => aiService.setAiEnabled(enabled));
  handle('ai:save-limits', (_event, limits) => aiService.saveLimits(limits));
  handle('ai:providers', () => aiService.getStatus().providers);
  handle('ai:provider-save', (_event, config) => aiService.saveProviderConfig(config));
  handle('ai:key-status', (_event, providerId) => aiService.hasKey(providerId));
  handle('ai:key-save', (_event, providerId, apiKey) => aiService.saveKey(providerId, apiKey));
  handle('ai:key-delete', (_event, providerId) => aiService.deleteKey(providerId));
  handle('ai:test-connection', (event, providerId) => aiService.testConnection(providerId, (payload) => event.sender.send('ai:stream-event', payload)));

  handle('ai:session-create', (_event, value) => aiService.createSession(value));
  handle('ai:sessions', () => aiService.listSessions());
  handle('ai:session-rename', (_event, value) => aiService.renameSession(value));
  handle('ai:session-delete', (_event, value) => aiService.deleteSession(value));
  handle('ai:session-clear', (_event, value) => aiService.clearSession(value));
  handle('ai:messages', (_event, value) => aiService.getMessages(value));
  handle('ai:message-send', (event, value) => aiService.sendMessage(value, (payload) => event.sender.send('ai:stream-event', payload)));
  handle('ai:request-cancel', (_event, requestId) => aiService.cancelRequest(requestId));
  handle('ai:session-summarize', (event, value) => aiService.summarizeSession(value, (payload) => event.sender.send('ai:stream-event', payload)));

  handle('ai:context-options', () => database.historyFilterOptions());
  handle('ai:context-preview', (_event, value) => contextBuilder.buildAnalysisPreview(value));
  handle('ai:context-confirm-send', (event, value) => aiService.confirmAndSend(value, (payload) => event.sender.send('ai:stream-event', payload)));

  handle('ai:memory-list', (_event, value) => aiService.listMemories(value || {}));
  handle('ai:memory-create', (_event, value) => aiService.createConfirmedMemory(value));
  handle('ai:memory-update', (_event, value) => aiService.updateMemory(value));
  handle('ai:memory-disable', (_event, value) => aiService.disableMemory(value));
  handle('ai:memory-delete', (_event, value) => aiService.deleteMemory(value));

  handle('backup:create', (_event, value = {}) => {
    const payload = plainObject(value, '备份参数');
    return database.createBackup(text(payload.reason || 'manual', { name: '备份原因', min: 1, max: 80 }));
  });
  handle('backup:list', () => database.listBackups());
  handle('backup:integrity', () => database.integrityCheck());
  handle('backup:restore', (_event, value) => {
    const payload = plainObject(value, '恢复参数');
    if (payload.confirmed !== true) fail('CONFIRMATION_REQUIRED', '恢复备份需要用户明确确认');
    return database.restoreBackup(text(payload.fileName, { name: '备份文件名', min: 1, max: 260 }));
  });
  handle('backup:export', async (_event, value) => {
    const payload = plainObject(value, '导出备份参数');
    const fileName = text(payload.fileName, { name: '备份文件名', min: 1, max: 260 });
    const result = await dialog.showSaveDialog(getWindow(), {
      title: '导出完整数据库备份包',
      defaultPath: path.join(process.env.USERPROFILE || '', 'Downloads', fileName.replace(/\.db$/i, '.lazada-backup')),
      filters: [{ name: 'Lazada完整备份包', extensions: ['lazada-backup'] }],
      properties: ['showOverwriteConfirmation', 'createDirectory'],
    });
    if (result.canceled || !result.filePath) return { canceled: true };
    return database.exportBackup(fileName, result.filePath);
  });
  handle('backup:import', async () => {
    const result = await dialog.showOpenDialog(getWindow(), {
      title: '导入完整数据库备份包',
      filters: [{ name: 'Lazada完整备份包', extensions: ['lazada-backup', 'db'] }],
      properties: ['openFile'],
    });
    if (result.canceled || !result.filePaths[0]) return { canceled: true };
    return database.importBackup(result.filePaths[0]);
  });
  handle('backup:cleanup', (_event, value = {}) => database.cleanupBackups({ autoOnly: value.autoOnly !== false }));
  handle('backup:set-retention', (_event, retention) => {
    const count = integer(retention, { name: '备份保留数量', min: 3, max: 365 });
    database.setSetting('backup_retention', count);
    return { ok: true, retention: count };
  });

  handle('migration:preview', () => database.migrationPreview());
  handle('migration:execute', (_event, value) => {
    const payload = plainObject(value, '迁移确认参数');
    if (payload.confirmed !== true) fail('CONFIRMATION_REQUIRED', '执行迁移需要用户明确确认');
    return database.executeMigration();
  });
  handle('migration:defer', () => database.deferMigration());

  handle('database:secure-info', () => database.info());
  handle('database:secure-open-folder', () => shell.openPath(path.dirname(database.filePath)));

  return () => {
    for (const channel of [
      'ai:status', 'ai:set-enabled', 'ai:save-limits', 'ai:providers', 'ai:provider-save', 'ai:key-status', 'ai:key-save', 'ai:key-delete', 'ai:test-connection',
      'ai:session-create', 'ai:sessions', 'ai:session-rename', 'ai:session-delete', 'ai:session-clear', 'ai:messages', 'ai:message-send', 'ai:request-cancel', 'ai:session-summarize',
      'ai:context-options', 'ai:context-preview', 'ai:context-confirm-send', 'ai:memory-list', 'ai:memory-create', 'ai:memory-update', 'ai:memory-disable', 'ai:memory-delete',
      'backup:create', 'backup:list', 'backup:integrity', 'backup:restore', 'backup:export', 'backup:import', 'backup:cleanup', 'backup:set-retention',
      'migration:preview', 'migration:execute', 'migration:defer', 'database:secure-info', 'database:secure-open-folder',
    ]) ipcMain.removeHandler(channel);
  };
}

module.exports = { registerSecureHandlers };
