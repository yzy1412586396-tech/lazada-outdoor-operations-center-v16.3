'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { DatabaseSync } = require('node:sqlite');
const { LATEST_SCHEMA_VERSION, migrations } = require('./schema');
const { fail, text, id, integer, number, oneOf, plainObject } = require('./lib/validation');

const HISTORY_TABLES = Object.freeze({
  daily_report: 'daily_report_history',
  inventory: 'inventory_history',
  activity_price: 'activity_price_history',
  repricing: 'repricing_history',
  expense: 'expense_history',
  sku: 'sku_history',
  anomaly: 'anomaly_history',
  operation: 'operation_logs',
});
const CONTEXT_MODULES = Object.freeze([...Object.keys(HISTORY_TABLES), 'control_price']);

const LEGACY_KEYS = new Set([
  'lazadaOpsStandaloneV2',
  'lazadaOpsPhilippinesSystemV8',
  'lazadaOpsThailandSystemV8',
  'lazadaInventoryConfigV13',
  'lazadaInventoryPresaleV12',
]);

const nowIso = () => new Date().toISOString();
const localDay = () => {
  const date = new Date();
  const offset = date.getTimezoneOffset() * 60000;
  return new Date(date.getTime() - offset).toISOString().slice(0, 10);
};
const makeId = (prefix) => `${prefix}-${crypto.randomUUID()}`;
const hash = (value) => crypto.createHash('sha256').update(String(value)).digest('hex');
const json = (value) => JSON.stringify(value ?? null);
const parseJson = (value, fallback = null) => {
  try { return JSON.parse(value); } catch { return fallback; }
};
const safeFilePart = (value) => String(value || 'backup').replace(/[^A-Za-z0-9_-]+/g, '-').slice(0, 40);
const SQLITE_HEADER = Buffer.from('SQLite format 3\0', 'utf8');

const sqliteFileHeaderIsValid = (filePath) => {
  const stat = fs.statSync(filePath);
  if (!stat.isFile() || stat.size < SQLITE_HEADER.length) return false;
  const descriptor = fs.openSync(filePath, 'r');
  try {
    const header = Buffer.alloc(SQLITE_HEADER.length);
    const bytesRead = fs.readSync(descriptor, header, 0, header.length, 0);
    return bytesRead === SQLITE_HEADER.length && header.equals(SQLITE_HEADER);
  } finally {
    fs.closeSync(descriptor);
  }
};

class OperationsDatabase {
  constructor(filePath, options = {}) {
    this.filePath = path.resolve(filePath);
    this.backupDirectory = path.resolve(options.backupDirectory || path.join(path.dirname(this.filePath), '..', 'backups'));
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    fs.mkdirSync(this.backupDirectory, { recursive: true });
    this.recovery = this._prepareDatabaseFile();
    this.wasExisting = fs.existsSync(this.filePath) && fs.statSync(this.filePath).size > 0;
    this._open();
    this._bootstrap();
    if (this.recovery) this.setMeta('last_database_recovery', json(this.recovery));
  }

  _prepareDatabaseFile() {
    if (!fs.existsSync(this.filePath)) return null;
    const quarantine = (reason, details = '') => {
      const stamp = nowIso().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
      const preservedPath = `${this.filePath}.recovered-${stamp}-${safeFilePart(reason)}`;
      try {
        fs.renameSync(this.filePath, preservedPath);
        for (const suffix of ['-wal', '-shm']) {
          const sidecar = `${this.filePath}${suffix}`;
          if (fs.existsSync(sidecar)) fs.renameSync(sidecar, `${preservedPath}${suffix}`);
        }
      } catch (error) {
        throw new Error(`本地数据库异常且无法安全隔离原文件：${error.message}`);
      }
      return {
        recoveredAt: nowIso(),
        reason,
        details: String(details || '').slice(0, 500),
        preservedFile: path.basename(preservedPath),
      };
    };

    const stat = fs.statSync(this.filePath);
    if (!stat.isFile() || stat.size === 0) return quarantine('empty-database');
    if (!sqliteFileHeaderIsValid(this.filePath)) return quarantine('invalid-sqlite-header');

    let checkDb = null;
    let recoveryReason = '';
    let recoveryDetails = '';
    try {
      checkDb = new DatabaseSync(this.filePath, { readOnly: true });
      const rows = checkDb.prepare('PRAGMA quick_check').all();
      const messages = rows.map((row) => String(row.quick_check || Object.values(row)[0] || ''));
      if (messages.length !== 1 || messages[0] !== 'ok') {
        recoveryReason = 'sqlite-integrity-failed';
        recoveryDetails = messages.join('; ');
      }
    } catch (error) {
      const message = String(error.message || error);
      if (/busy|locked|permission|access is denied|readonly/i.test(message)) {
        throw new Error(`本地数据库暂时无法访问：${message}`);
      }
      recoveryReason = 'sqlite-open-failed';
      recoveryDetails = message;
    } finally {
      try { checkDb?.close(); } catch { /* preflight handle was already closed */ }
    }
    return recoveryReason ? quarantine(recoveryReason, recoveryDetails) : null;
  }

  _open() {
    this.db = new DatabaseSync(this.filePath);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      PRAGMA busy_timeout = 5000;
      PRAGMA foreign_keys = ON;
      PRAGMA trusted_schema = OFF;
    `);
  }

  _bootstrap() {
    this.db.exec('CREATE TABLE IF NOT EXISTS app_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
    const current = this._schemaVersion();
    if (this.wasExisting && current < LATEST_SCHEMA_VERSION) this._createBackupFile('before-schema-migration', false);
    this._runMigrations(current);
    this._seedDimensions();
    this._ensureDailyBackup();
  }

  _schemaVersion() {
    const pragma = Number(this.db.prepare('PRAGMA user_version').get()?.user_version || 0);
    let meta = 0;
    try { meta = Number(this.db.prepare("SELECT value FROM app_meta WHERE key='schema_version'").get()?.value || 0); } catch { /* legacy database */ }
    return Math.max(pragma, meta);
  }

  _runMigrations(currentVersion) {
    for (const migration of migrations) {
      if (migration.version <= currentVersion) continue;
      const appliedAt = nowIso();
      this.db.exec('BEGIN IMMEDIATE');
      try {
        this.db.exec(migration.sql);
        this.db.prepare(`
          INSERT INTO app_meta(key,value) VALUES('schema_version',?)
          ON CONFLICT(key) DO UPDATE SET value=excluded.value
        `).run(String(migration.version));
        this.db.exec(`PRAGMA user_version = ${migration.version}`);
        if (migration.version >= 2) {
          this.db.prepare(`
            INSERT OR REPLACE INTO schema_migrations(version,name,applied_at,success,error_message)
            VALUES(?,?,?,?,?)
          `).run(migration.version, migration.name, appliedAt, 1, '');
        }
        this.db.exec('COMMIT');
      } catch (error) {
        try { this.db.exec('ROLLBACK'); } catch { /* already rolled back */ }
        throw new Error(`数据库迁移V${migration.version}失败：${error.message}`);
      }
    }
  }

  _seedDimensions() {
    const now = nowIso();
    const upsert = this.db.prepare(`
      INSERT INTO countries(id,code,name,active,created_at,updated_at) VALUES(?,?,?,?,?,?)
      ON CONFLICT(code) DO UPDATE SET name=excluded.name,active=excluded.active,updated_at=excluded.updated_at
    `);
    upsert.run('country-ph', 'ph', '菲律宾', 1, now, now);
    upsert.run('country-th', 'th', '泰国', 1, now, now);
  }

  _ensureDailyBackup() {
    const day = localDay();
    const last = this.getMeta('last_daily_backup');
    if (last === day) return;
    try {
      this.createBackup('daily-auto');
      this.setMeta('last_daily_backup', day);
      this.cleanupBackups({ autoOnly: true });
    } catch (error) {
      this.setMeta('last_backup_error', String(error.message || error).slice(0, 500));
    }
  }

  getMeta(key) {
    return this.db.prepare('SELECT value FROM app_meta WHERE key=?').get(String(key))?.value || '';
  }

  setMeta(key, value) {
    this.db.prepare(`
      INSERT INTO app_meta(key,value) VALUES(?,?)
      ON CONFLICT(key) DO UPDATE SET value=excluded.value
    `).run(String(key), String(value));
  }

  transaction(callback) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = callback(this.db);
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      try { this.db.exec('ROLLBACK'); } catch { /* already rolled back */ }
      throw error;
    }
  }

  loadStorage() {
    return {
      initialized: this.getMeta('storage_initialized') === '1',
      entries: this.db.prepare('SELECT key,value FROM browser_storage ORDER BY key').all().map(({ key, value }) => [key, value]),
    };
  }

  _validateStorageEntries(entries, maxItems = 500) {
    if (!Array.isArray(entries) || entries.length > maxItems) fail('VALIDATION_ERROR', '本地存储数据格式不正确');
    return entries.map((entry) => {
      if (!Array.isArray(entry) || entry.length !== 2) fail('VALIDATION_ERROR', '本地存储条目格式不正确');
      return [text(String(entry[0]), { name: '存储键', min: 1, max: 200 }), text(String(entry[1]), { name: '存储值', max: 12_000_000, trim: false })];
    });
  }

  syncStorage(changes = [], removed = []) {
    const safeChanges = this._validateStorageEntries(changes);
    if (!Array.isArray(removed) || removed.length > 500) fail('VALIDATION_ERROR', '待删除存储键格式不正确');
    const safeRemoved = removed.map((key) => text(String(key), { name: '存储键', min: 1, max: 200 }));
    const now = nowIso();
    this.transaction((db) => {
      const upsert = db.prepare(`
        INSERT INTO browser_storage(key,value,updated_at) VALUES(?,?,?)
        ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at
      `);
      const remove = db.prepare('DELETE FROM browser_storage WHERE key=?');
      for (const [key, value] of safeChanges) upsert.run(key, value, now);
      for (const key of safeRemoved) remove.run(key);
      this.setMeta('storage_initialized', '1');
      this.setMeta('last_storage_sync', now);
    });
    this._archiveStorageChanges(safeChanges, now);
    return { ok: true, syncedAt: now };
  }

  replaceStorage(entries = []) {
    const safeEntries = this._validateStorageEntries(entries);
    const now = nowIso();
    this.transaction((db) => {
      db.exec('DELETE FROM browser_storage');
      const upsert = db.prepare('INSERT INTO browser_storage(key,value,updated_at) VALUES(?,?,?)');
      for (const [key, value] of safeEntries) upsert.run(key, value, now);
      this.setMeta('storage_initialized', '1');
      this.setMeta('last_storage_sync', now);
    });
    this._archiveStorageChanges(safeEntries, now);
    return { ok: true, syncedAt: now };
  }

  _archiveStorageChanges(entries, createdAt) {
    const relevant = entries.filter(([key]) => LEGACY_KEYS.has(key));
    if (!relevant.length) return;
    try {
      this.transaction(() => {
        for (const [key, value] of relevant) {
          const sourceHash = hash(value);
          if (this.getMeta(`snapshot_hash:${key}`) === sourceHash) continue;
          const payload = parseJson(value);
          if (payload && typeof payload === 'object') this._archiveLegacyPayload(key, payload, sourceHash, createdAt, false);
          this.setMeta(`snapshot_hash:${key}`, sourceHash);
        }
      });
    } catch (error) {
      this.setMeta('last_history_archive_error', String(error.message || error).slice(0, 500));
    }
  }

  _countryFromKey(key) {
    if (/Thailand/i.test(key)) return 'th';
    return 'ph';
  }

  _upsertStore(countryCode, store, createdAt) {
    if (!store?.id) return '';
    const countryId = `country-${countryCode}`;
    const storeId = `${countryCode}:${String(store.id)}`;
    this.db.prepare(`
      INSERT INTO stores(id,country_id,external_id,name,active,created_at,updated_at) VALUES(?,?,?,?,?,?,?)
      ON CONFLICT(country_id,external_id) DO UPDATE SET name=excluded.name,active=excluded.active,updated_at=excluded.updated_at
    `).run(storeId, countryId, String(store.id), String(store.name || store.id), store.active === false ? 0 : 1, createdAt, createdAt);
    return storeId;
  }

  _upsertBusinessDatabase(countryCode, item, createdAt) {
    if (!item?.id) return '';
    const countryId = `country-${countryCode}`;
    const dbId = `${countryCode}:${String(item.id)}`;
    this.db.prepare(`
      INSERT INTO business_databases(id,country_id,external_id,name,active,created_at,updated_at) VALUES(?,?,?,?,?,?,?)
      ON CONFLICT(country_id,external_id) DO UPDATE SET name=excluded.name,active=excluded.active,updated_at=excluded.updated_at
    `).run(dbId, countryId, String(item.id), String(item.name || item.id), item.active === false ? 0 : 1, createdAt, createdAt);
    return dbId;
  }

  _insertHistory(table, record) {
    if (!Object.values(HISTORY_TABLES).includes(table) || table === 'operation_logs' || table === 'anomaly_history') {
      fail('VALIDATION_ERROR', '历史模块无效');
    }
    const columns = table === 'sku_history'
      ? '(id,batch_id,country_code,store_id,business_database_id,sku,business_date,module,version_no,payload_json,source_hash,dedupe_hash,created_at,updated_at)'
      : '(id,batch_id,country_code,store_id,business_database_id,business_date,module,version_no,payload_json,source_hash,dedupe_hash,created_at,updated_at)';
    const placeholders = table === 'sku_history' ? '(?,?,?,?,?,?,?,?,?,?,?,?,?,?)' : '(?,?,?,?,?,?,?,?,?,?,?,?,?)';
    const values = table === 'sku_history'
      ? [record.id, null, record.countryCode, record.storeId || null, record.databaseId || null, record.sku, record.businessDate, record.module, record.versionNo, record.payloadJson, record.sourceHash, record.dedupeHash, record.createdAt, record.createdAt]
      : [record.id, null, record.countryCode, record.storeId || null, record.databaseId || null, record.businessDate, record.module, record.versionNo, record.payloadJson, record.sourceHash, record.dedupeHash, record.createdAt, record.createdAt];
    this.db.prepare(`INSERT OR IGNORE INTO ${table} ${columns} VALUES ${placeholders}`).run(...values);
  }

  _archiveLegacyPayload(sourceKey, state, sourceHash, createdAt, migration) {
    const countryCode = this._countryFromKey(sourceKey);
    const stores = Array.isArray(state.stores) ? state.stores : [];
    const storeIds = new Map(stores.map((store) => [String(store.id), this._upsertStore(countryCode, store, createdAt)]));
    const databases = Array.isArray(state.databases) ? state.databases : [];
    const databaseIds = new Map(databases.map((item) => [String(item.id), this._upsertBusinessDatabase(countryCode, item, createdAt)]));
    const businessDate = createdAt.slice(0, 10);

    if (state.monthlyExpense && typeof state.monthlyExpense === 'object') {
      const payloadJson = json(state.monthlyExpense);
      const dedupeHash = hash(`expense|${countryCode}|${payloadJson}`);
      this._insertHistory('expense_history', {
        id: makeId('expense'), countryCode, storeId: '', databaseId: '', businessDate,
        module: 'expense', versionNo: Number(state.monthlyExpense.version || 1), payloadJson,
        sourceHash, dedupeHash, createdAt,
      });
    }

    if (Array.isArray(state.controlRecords) && state.controlRecords.length) {
      const payloadJson = json({ records: state.controlRecords, conflicts: state.controlConflicts || [], metadata: state.controlMetaByLibrary || state.controlMeta || {} });
      const dedupeHash = hash(`control|${countryCode}|${payloadJson}`);
      this.db.prepare(`
        INSERT OR IGNORE INTO rule_versions(
          id,country_code,store_id,business_database_id,module,version_no,title,rules_json,source,dedupe_hash,created_at,updated_at
        ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)
      `).run(makeId('rule'), countryCode, null, null, 'control_price', 1, '控价数据库快照', payloadJson, migration ? 'legacy_migration' : 'deterministic_storage_sync', dedupeHash, createdAt, createdAt);
    }

    const productMaps = state.storeProducts && typeof state.storeProducts === 'object' ? state.storeProducts : {};
    for (const [externalStoreId, products] of Object.entries(productMaps)) {
      if (!products || typeof products !== 'object') continue;
      const storeId = storeIds.get(String(externalStoreId)) || '';
      for (const [sku, product] of Object.entries(products)) {
        const payloadJson = json(product);
        this._insertHistory('sku_history', {
          id: makeId('sku'), countryCode, storeId, databaseId: '', sku: String(sku), businessDate,
          module: 'sku', versionNo: 1, payloadJson, sourceHash,
          dedupeHash: hash(`sku|${countryCode}|${externalStoreId}|${sku}|${payloadJson}`), createdAt,
        });
      }
    }

    for (const item of Array.isArray(state.history) ? state.history : []) {
      const module = /activity|活动/i.test(item.type || '') ? 'activity_price' : /repric|改价/i.test(item.type || '') ? 'repricing' : 'operation';
      const payloadJson = json(item);
      const dedupeHash = hash(`operation|${countryCode}|${payloadJson}`);
      this.db.prepare(`
        INSERT OR IGNORE INTO operation_logs(
          id,country_code,store_id,business_database_id,module,action,status,summary,payload_json,dedupe_hash,created_at,updated_at
        ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)
      `).run(makeId('op'), countryCode, null, null, module, String(item.type || 'business_operation'), Number(item.success || 0) > 0 ? 'success' : 'recorded', String(item.taskName || item.storeName || ''), payloadJson, dedupeHash, String(item.at || createdAt), String(item.at || createdAt));
      if (module !== 'operation') {
        this._insertHistory(HISTORY_TABLES[module], {
          id: makeId(module), countryCode, storeId: '', databaseId: '', businessDate: String(item.at || createdAt).slice(0, 10),
          module, versionNo: 1, payloadJson, sourceHash, dedupeHash: hash(`${module}|${countryCode}|${payloadJson}`), createdAt: String(item.at || createdAt),
        });
      }
    }

    if (/InventoryConfig/i.test(sourceKey)) {
      const payloadJson = json(state);
      this.db.prepare(`
        INSERT OR IGNORE INTO rule_versions(
          id,country_code,store_id,business_database_id,module,version_no,title,rules_json,source,dedupe_hash,created_at,updated_at
        ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)
      `).run(makeId('rule'), countryCode, null, null, 'inventory', Number(state.version || 1), '库存列映射与规则', payloadJson, migration ? 'legacy_migration' : 'deterministic_storage_sync', hash(`inventory-rule|${payloadJson}`), createdAt, createdAt);
    }
  }

  saveUpload(slotValue, metadataValue, bytes) {
    const slot = text(String(slotValue), { name: '上传槽位', min: 1, max: 200 });
    const metadata = plainObject(metadataValue || {}, '文件信息');
    const content = Buffer.from(bytes || []);
    if (content.length > 80 * 1024 * 1024) fail('FILE_TOO_LARGE', '单个上传缓存不能超过80MB');
    const now = nowIso();
    this.db.prepare(`
      INSERT INTO uploaded_files(slot,name,mime_type,last_modified,content,size,updated_at) VALUES(?,?,?,?,?,?,?)
      ON CONFLICT(slot) DO UPDATE SET name=excluded.name,mime_type=excluded.mime_type,last_modified=excluded.last_modified,
        content=excluded.content,size=excluded.size,updated_at=excluded.updated_at
    `).run(slot, text(String(metadata.name || 'uploaded-file.xlsx'), { name: '文件名', max: 260 }), text(String(metadata.type || ''), { name: '文件类型', max: 120 }), Number(metadata.lastModified) || 0, content, content.length, now);
    return { ok: true, slot, size: content.length, updatedAt: now };
  }

  readUpload(slotValue) {
    const slot = text(String(slotValue), { name: '上传槽位', min: 1, max: 200 });
    const row = this.db.prepare('SELECT slot,name,mime_type,last_modified,content,size,updated_at FROM uploaded_files WHERE slot=?').get(slot);
    if (!row) return null;
    return { slot: row.slot, name: row.name, type: row.mime_type, lastModified: row.last_modified, content: new Uint8Array(row.content), size: row.size, updatedAt: row.updated_at };
  }

  listUploads() {
    return this.db.prepare('SELECT slot,name,mime_type,last_modified,size,updated_at FROM uploaded_files ORDER BY updated_at DESC').all().map((row) => ({
      slot: row.slot, name: row.name, type: row.mime_type, lastModified: row.last_modified, size: row.size, updatedAt: row.updated_at,
    }));
  }

  deleteUpload(slotValue) {
    const slot = text(String(slotValue), { name: '上传槽位', min: 1, max: 200 });
    this.db.prepare('DELETE FROM uploaded_files WHERE slot=?').run(slot);
    return { ok: true, slot };
  }

  integrityCheck(filePath = this.filePath) {
    let checkDb = this.db;
    let shouldClose = false;
    try {
      const resolved = path.resolve(filePath);
      if (resolved !== this.filePath) {
        if (!fs.existsSync(resolved) || !sqliteFileHeaderIsValid(resolved)) {
          return { ok: false, messages: ['文件不是有效的SQLite数据库'] };
        }
        checkDb = new DatabaseSync(resolved, { readOnly: true });
        shouldClose = true;
      }
      const rows = checkDb.prepare('PRAGMA integrity_check').all();
      const messages = rows.map((row) => String(row.integrity_check || Object.values(row)[0] || ''));
      return { ok: messages.length === 1 && messages[0] === 'ok', messages };
    } catch (error) {
      return { ok: false, messages: [String(error.message || error).slice(0, 500)] };
    } finally {
      if (shouldClose) {
        try { checkDb.close(); } catch { /* invalid files can close themselves during failure */ }
      }
    }
  }

  _createBackupFile(reason, catalog = true) {
    const createdAt = nowIso();
    const backupId = makeId('backup');
    const stamp = createdAt.replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
    const fileName = `${stamp}-${safeFilePart(reason)}-${backupId.slice(-8)}.db`;
    const destination = path.join(this.backupDirectory, fileName);
    const escaped = destination.replace(/'/g, "''");
    try { this.db.exec('PRAGMA wal_checkpoint(PASSIVE)'); } catch { /* backup can continue */ }
    this.db.exec(`VACUUM INTO '${escaped}'`);
    const integrity = this.integrityCheck(destination);
    if (!integrity.ok) {
      fs.rmSync(destination, { force: true });
      fail('BACKUP_FAILED', '备份完整性检查失败');
    }
    const size = fs.statSync(destination).size;
    if (catalog && this._schemaVersion() >= 2) {
      this.db.prepare('INSERT OR REPLACE INTO backup_catalog(id,file_name,reason,size,integrity_status,created_at) VALUES(?,?,?,?,?,?)')
        .run(backupId, fileName, reason, size, 'ok', createdAt);
    }
    return { id: backupId, fileName, reason, size, integrity: 'ok', createdAt };
  }

  createBackup(reason = 'manual') {
    return this._createBackupFile(text(String(reason), { name: '备份原因', min: 1, max: 80 }), true);
  }

  listBackups() {
    const catalog = new Map(this.db.prepare('SELECT * FROM backup_catalog').all().map((row) => [row.file_name, row]));
    return fs.readdirSync(this.backupDirectory, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith('.db'))
      .map((entry) => {
        const stat = fs.statSync(path.join(this.backupDirectory, entry.name));
        const row = catalog.get(entry.name);
        return { id: row?.id || entry.name, fileName: entry.name, reason: row?.reason || 'pre-migration', size: stat.size, integrity: row?.integrity_status || 'unknown', createdAt: row?.created_at || stat.birthtime.toISOString() };
      })
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  _backupPath(fileName) {
    const safeName = path.basename(text(String(fileName), { name: '备份文件名', min: 1, max: 260 }));
    const resolved = path.resolve(this.backupDirectory, safeName);
    if (path.dirname(resolved) !== this.backupDirectory || !fs.existsSync(resolved)) fail('BACKUP_NOT_FOUND', '备份文件不存在');
    return resolved;
  }

  exportBackup(fileName, destination) {
    const source = this._backupPath(fileName);
    const target = path.resolve(destination);
    fs.copyFileSync(source, target);
    return { ok: true, size: fs.statSync(target).size };
  }

  importBackup(sourcePath) {
    const source = path.resolve(sourcePath);
    if (!fs.existsSync(source)) fail('BACKUP_NOT_FOUND', '导入的备份文件不存在');
    const integrity = this.integrityCheck(source);
    if (!integrity.ok) fail('BACKUP_INVALID', '导入文件不是完整有效的SQLite备份');
    const backup = this.createBackup('before-backup-import');
    const importedId = makeId('backup');
    const fileName = `${nowIso().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z')}-imported-${importedId.slice(-8)}.db`;
    const destination = path.join(this.backupDirectory, fileName);
    fs.copyFileSync(source, destination);
    const size = fs.statSync(destination).size;
    this.db.prepare('INSERT INTO backup_catalog(id,file_name,reason,size,integrity_status,created_at) VALUES(?,?,?,?,?,?)')
      .run(importedId, fileName, 'imported', size, 'ok', nowIso());
    return { ok: true, backupBeforeImport: backup, imported: { id: importedId, fileName, size, integrity: 'ok', createdAt: nowIso() } };
  }

  restoreBackup(fileName) {
    const source = this._backupPath(fileName);
    const integrity = this.integrityCheck(source);
    if (!integrity.ok) fail('BACKUP_INVALID', '所选备份未通过完整性检查');
    const safetyBackup = this.createBackup('before-restore');
    const temporary = `${this.filePath}.restore-${crypto.randomUUID()}`;
    fs.copyFileSync(source, temporary);
    this.close();
    try {
      fs.rmSync(`${this.filePath}-wal`, { force: true });
      fs.rmSync(`${this.filePath}-shm`, { force: true });
      fs.copyFileSync(temporary, this.filePath);
    } finally {
      fs.rmSync(temporary, { force: true });
    }
    this.wasExisting = true;
    this._open();
    this._bootstrap();
    return { ok: true, restoredFrom: path.basename(source), safetyBackup };
  }

  cleanupBackups(options = {}) {
    const retention = integer(this.getSetting('backup_retention', 30), { name: '备份保留数量', min: 3, max: 365 });
    const autoOnly = options.autoOnly !== false;
    const backups = this.listBackups().filter((item) => !autoOnly || item.reason === 'daily-auto');
    const removed = [];
    for (const item of backups.slice(retention)) {
      const target = this._backupPath(item.fileName);
      fs.rmSync(target, { force: true });
      this.db.prepare('DELETE FROM backup_catalog WHERE file_name=?').run(item.fileName);
      removed.push(item.fileName);
    }
    return { ok: true, retention, removed };
  }

  getSetting(key, fallback = null) {
    const row = this.db.prepare('SELECT value_json FROM app_settings WHERE key=?').get(String(key));
    return row ? parseJson(row.value_json, fallback) : fallback;
  }

  setSetting(key, value) {
    const safeKey = id(String(key), '设置键');
    const encoded = json(value);
    if (encoded.length > 100_000) fail('VALIDATION_ERROR', '设置内容过大');
    const now = nowIso();
    this.db.prepare(`
      INSERT INTO app_settings(key,value_json,created_at,updated_at) VALUES(?,?,?,?)
      ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json,updated_at=excluded.updated_at
    `).run(safeKey, encoded, now, now);
    return { ok: true, key: safeKey, updatedAt: now };
  }

  migrationPreview() {
    const entries = this.db.prepare('SELECT key,value,updated_at FROM browser_storage ORDER BY key').all();
    const items = [];
    let totalEstimatedRecords = 0;
    for (const row of entries) {
      const parsed = parseJson(row.value);
      const counts = parsed && typeof parsed === 'object' ? {
        stores: Array.isArray(parsed.stores) ? parsed.stores.length : 0,
        databases: Array.isArray(parsed.databases) ? parsed.databases.length : 0,
        controlRecords: Array.isArray(parsed.controlRecords) ? parsed.controlRecords.length : 0,
        storeProducts: parsed.storeProducts && typeof parsed.storeProducts === 'object' ? Object.values(parsed.storeProducts).reduce((sum, map) => sum + Object.keys(map || {}).length, 0) : 0,
        operations: Array.isArray(parsed.history) ? parsed.history.length : 0,
        expenseSnapshots: parsed.monthlyExpense ? 1 : 0,
      } : {};
      const estimated = Object.values(counts).reduce((sum, value) => sum + Number(value || 0), 0);
      totalEstimatedRecords += estimated;
      items.push({ key: row.key, bytes: Buffer.byteLength(row.value), parseable: Boolean(parsed), counts, estimated, updatedAt: row.updated_at, alreadyMigrated: Boolean(this.db.prepare('SELECT 1 FROM legacy_migration_records WHERE source_key=? AND source_hash=? LIMIT 1').get(row.key, hash(row.value))) });
    }
    return {
      status: this.getMeta('legacy_v14_migrated_at') ? 'completed' : this.getMeta('legacy_v14_deferred_at') ? 'deferred' : 'pending',
      sourceCount: entries.length,
      totalEstimatedRecords,
      items,
      originalDataWillBeKept: true,
      lastCompletedAt: this.getMeta('legacy_v14_migrated_at'),
    };
  }

  executeMigration() {
    const preview = this.migrationPreview();
    const backup = this.createBackup('before-legacy-migration');
    const report = { sourceCount: preview.sourceCount, migratedSources: 0, skippedDuplicates: 0, failedSources: [], estimatedRecords: preview.totalEstimatedRecords, originalDataKept: true };
    const reportId = makeId('migration');
    this.transaction((db) => {
      const rows = db.prepare('SELECT key,value,updated_at FROM browser_storage ORDER BY key').all();
      const record = db.prepare('INSERT OR IGNORE INTO legacy_migration_records(id,source_key,source_hash,target_table,target_id,created_at) VALUES(?,?,?,?,?,?)');
      for (const row of rows) {
        const sourceHash = hash(row.value);
        const existing = db.prepare('SELECT 1 FROM legacy_migration_records WHERE source_key=? AND source_hash=? LIMIT 1').get(row.key, sourceHash);
        if (existing) { report.skippedDuplicates += 1; continue; }
        const payload = parseJson(row.value);
        if (!payload || typeof payload !== 'object') { report.failedSources.push({ key: row.key, reason: 'JSON无法解析，原数据已保留' }); continue; }
        this._archiveLegacyPayload(row.key, payload, sourceHash, row.updated_at || nowIso(), true);
        record.run(makeId('legacy'), row.key, sourceHash, 'immutable_history', sourceHash, nowIso());
        report.migratedSources += 1;
      }
      this.setMeta('legacy_v14_migrated_at', nowIso());
      this.setMeta('legacy_v14_deferred_at', '');
      db.prepare('INSERT INTO migration_reports(id,migration_type,status,report_json,backup_id,created_at) VALUES(?,?,?,?,?,?)')
        .run(reportId, 'legacy-storage-v14', report.failedSources.length ? 'completed_with_warnings' : 'completed', json(report), backup.id, nowIso());
    });
    return { ok: true, id: reportId, backup, report, previewAfter: this.migrationPreview() };
  }

  deferMigration() {
    const at = nowIso();
    this.setMeta('legacy_v14_deferred_at', at);
    return { ok: true, deferredAt: at, originalDataKept: true };
  }

  historyFilterOptions() {
    const countries = this.db.prepare('SELECT code,name FROM countries WHERE active=1 ORDER BY code').all();
    const stores = this.db.prepare(`SELECT stores.id,stores.external_id,stores.name,countries.code AS country_code FROM stores JOIN countries ON countries.id=stores.country_id WHERE stores.active=1 ORDER BY countries.code,stores.name`).all();
    const databases = this.db.prepare(`SELECT business_databases.id,business_databases.external_id,business_databases.name,countries.code AS country_code FROM business_databases LEFT JOIN countries ON countries.id=business_databases.country_id WHERE business_databases.active=1 ORDER BY countries.code,business_databases.name`).all();
    return { countries, stores, databases, modules: [...CONTEXT_MODULES] };
  }

  getHistoryRows(moduleValue, filters = {}) {
    const module = oneOf(moduleValue, CONTEXT_MODULES, '历史模块');
    if (module === 'control_price') return this._getControlPriceHistoryRows(filters);
    const table = HISTORY_TABLES[module];
    const conditions = [];
    const params = [];
    const countryCode = String(filters.countryCode || '');
    const storeId = String(filters.storeId || '');
    const databaseId = String(filters.databaseId || '');
    const dateStart = String(filters.dateStart || '');
    const dateEnd = String(filters.dateEnd || '');
    if (countryCode) { conditions.push('country_code=?'); params.push(countryCode); }
    if (storeId && table !== 'operation_logs') { conditions.push('store_id=?'); params.push(storeId); }
    if (storeId && table === 'operation_logs') { conditions.push('store_id=?'); params.push(storeId); }
    if (databaseId) { conditions.push('business_database_id=?'); params.push(databaseId); }
    const dateColumn = table === 'operation_logs' ? 'substr(created_at,1,10)' : 'business_date';
    if (dateStart) { conditions.push(`${dateColumn}>=?`); params.push(dateStart); }
    if (dateEnd) { conditions.push(`${dateColumn}<=?`); params.push(dateEnd); }
    this._appendHistoryPayloadFilters(module, filters, conditions, params);
    const limit = integer(filters.limit || 500, { name: '历史记录数量', min: 1, max: 2000 });
    const offset = integer(filters.offset || 0, { name: '历史记录偏移量', min: 0, max: 1_000_000 });
    const where = conditions.length ? ` WHERE ${conditions.join(' AND ')}` : '';
    const totalCount = Number(this.db.prepare(`SELECT COUNT(*) AS count FROM ${table}${where}`).get(...params)?.count || 0);
    const rows = this.db.prepare(`SELECT * FROM ${table}${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`).all(...params, limit, offset);
    return { rows: rows.map((row) => ({ ...row, payload: parseJson(row.payload_json, {}) })), totalCount };
  }

  _getControlPriceHistoryRows(filters = {}) {
    const conditions = ['module=?'];
    const params = ['control_price'];
    const countryCode = String(filters.countryCode || '');
    const storeId = String(filters.storeId || '');
    const databaseId = String(filters.databaseId || '');
    const dateStart = String(filters.dateStart || '');
    const dateEnd = String(filters.dateEnd || '');
    if (countryCode) { conditions.push('country_code=?'); params.push(countryCode); }
    if (storeId) { conditions.push('(store_id=? OR store_id IS NULL)'); params.push(storeId); }
    if (databaseId) { conditions.push('(business_database_id=? OR business_database_id IS NULL)'); params.push(databaseId); }
    if (dateStart) { conditions.push('substr(created_at,1,10)>=?'); params.push(dateStart); }
    if (dateEnd) { conditions.push('substr(created_at,1,10)<=?'); params.push(dateEnd); }
    this._appendHistoryPayloadFilters('control_price', filters, conditions, params);
    const limit = integer(filters.limit || 500, { name: '控价历史记录数量', min: 1, max: 2000 });
    const offset = integer(filters.offset || 0, { name: '控价历史记录偏移量', min: 0, max: 1_000_000 });
    const where = conditions.join(' AND ');
    const totalCount = Number(this.db.prepare(`SELECT COUNT(*) AS count FROM rule_versions WHERE ${where}`).get(...params)?.count || 0);
    const rows = this.db.prepare(`
      SELECT id,country_code,store_id,business_database_id,substr(created_at,1,10) AS business_date,
        module,version_no,title,rules_json AS payload_json,source,created_at,updated_at
      FROM rule_versions WHERE ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?
    `).all(...params, limit, offset);
    return { rows: rows.map((row) => ({ ...row, payload: parseJson(row.payload_json, {}) })), totalCount };
  }

  _appendHistoryPayloadFilters(module, filters, conditions, params) {
    const resultStatus = String(filters.resultStatus || '').trim();
    if (module === 'activity_price' && resultStatus) {
      const total = "CAST(CASE WHEN json_valid(payload_json) THEN json_extract(payload_json, '$.total') END AS REAL)";
      const success = "CAST(CASE WHEN json_valid(payload_json) THEN json_extract(payload_json, '$.success') END AS REAL)";
      if (resultStatus === 'success') conditions.push(`COALESCE(${total},0)>0 AND COALESCE(${success},0)>=COALESCE(${total},0)`);
      if (resultStatus === 'failed') conditions.push(`COALESCE(${total},0)>0 AND COALESCE(${success},0)<COALESCE(${total},0)`);
    }
    const billingMonth = String(filters.billingMonth || '').trim();
    if (module === 'expense' && billingMonth) {
      conditions.push("CASE WHEN json_valid(payload_json) THEN json_extract(payload_json, '$.billingMonth') END=?");
      params.push(billingMonth);
    }
  }

  getProviderConfigs() {
    return this.db.prepare('SELECT * FROM ai_provider_configs ORDER BY provider_id').all().map((row) => ({
      providerId: row.provider_id, name: row.name, baseUrl: row.base_url, modelName: row.model_name,
      maxInputTokens: row.max_input_tokens, maxOutputTokens: row.max_output_tokens, timeoutMs: row.timeout_ms,
      streamEnabled: Boolean(row.stream_enabled), enabled: Boolean(row.enabled),
      inputCostPerMillion: row.input_cost_per_million, outputCostPerMillion: row.output_cost_per_million,
      createdAt: row.created_at, updatedAt: row.updated_at,
    }));
  }

  saveProviderConfig(config) {
    const now = nowIso();
    this.db.prepare(`
      INSERT INTO ai_provider_configs(provider_id,name,base_url,model_name,max_input_tokens,max_output_tokens,timeout_ms,stream_enabled,enabled,input_cost_per_million,output_cost_per_million,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(provider_id) DO UPDATE SET name=excluded.name,base_url=excluded.base_url,model_name=excluded.model_name,
        max_input_tokens=excluded.max_input_tokens,max_output_tokens=excluded.max_output_tokens,timeout_ms=excluded.timeout_ms,
        stream_enabled=excluded.stream_enabled,enabled=excluded.enabled,input_cost_per_million=excluded.input_cost_per_million,
        output_cost_per_million=excluded.output_cost_per_million,updated_at=excluded.updated_at
    `).run(config.providerId, config.name, config.baseUrl, config.modelName, config.maxInputTokens, config.maxOutputTokens, config.timeoutMs, config.streamEnabled ? 1 : 0, config.enabled ? 1 : 0, config.inputCostPerMillion, config.outputCostPerMillion, now, now);
    return this.getProviderConfigs().find((item) => item.providerId === config.providerId);
  }

  createChatSession({ name, providerId, modelName }) {
    const session = { id: makeId('chat'), name, providerId, modelName, createdAt: nowIso() };
    this.db.prepare('INSERT INTO ai_chat_sessions(id,name,provider_id,model_name,created_at,updated_at) VALUES(?,?,?,?,?,?)')
      .run(session.id, session.name, session.providerId, session.modelName, session.createdAt, session.createdAt);
    return session;
  }

  listChatSessions() {
    return this.db.prepare(`
      SELECT s.*,COUNT(m.id) AS message_count FROM ai_chat_sessions s
      LEFT JOIN ai_chat_messages m ON m.session_id=s.id GROUP BY s.id ORDER BY s.updated_at DESC
    `).all().map((row) => ({ id: row.id, name: row.name, providerId: row.provider_id, modelName: row.model_name, messageCount: row.message_count, createdAt: row.created_at, updatedAt: row.updated_at }));
  }

  renameChatSession(sessionId, name) {
    const now = nowIso();
    const result = this.db.prepare('UPDATE ai_chat_sessions SET name=?,updated_at=? WHERE id=?').run(name, now, sessionId);
    if (!result.changes) fail('NOT_FOUND', '会话不存在');
    return { ok: true, updatedAt: now };
  }

  deleteChatSession(sessionId) {
    const result = this.db.prepare('DELETE FROM ai_chat_sessions WHERE id=?').run(sessionId);
    if (!result.changes) fail('NOT_FOUND', '会话不存在');
    return { ok: true };
  }

  clearChatSession(sessionId) {
    const exists = this.db.prepare('SELECT 1 FROM ai_chat_sessions WHERE id=?').get(sessionId);
    if (!exists) fail('NOT_FOUND', '会话不存在');
    this.db.prepare('DELETE FROM ai_chat_messages WHERE session_id=?').run(sessionId);
    this.db.prepare('DELETE FROM ai_conversation_summaries WHERE session_id=?').run(sessionId);
    this.db.prepare('UPDATE ai_chat_sessions SET updated_at=? WHERE id=?').run(nowIso(), sessionId);
    return { ok: true };
  }

  getChatMessages(sessionId, limit = 200) {
    const safeLimit = integer(limit, { name: '消息数量', min: 1, max: 500 });
    const rows = this.db.prepare(`
      SELECT * FROM (SELECT * FROM ai_chat_messages WHERE session_id=? ORDER BY created_at DESC LIMIT ?)
      ORDER BY created_at ASC
    `).all(sessionId, safeLimit);
    const runStatement = this.db.prepare('SELECT * FROM ai_analysis_runs WHERE assistant_message_id=? ORDER BY created_at DESC LIMIT 1');
    const sourceStatement = this.db.prepare('SELECT * FROM ai_context_sources WHERE analysis_run_id=? ORDER BY created_at');
    return rows.map((row) => {
      const run = row.role === 'assistant' ? runStatement.get(row.id) : null;
      const sources = run ? sourceStatement.all(run.id).map((source) => ({
        id: source.id, sourceType: source.source_type, sourceTable: source.source_table,
        sourceRecordId: source.source_record_id, module: source.module, countryCode: source.country_code,
        storeId: source.store_id, dateStart: source.date_start, dateEnd: source.date_end,
        recordCount: source.record_count, snapshotAt: source.snapshot_at, summary: parseJson(source.summary_json, {}),
      })) : [];
      return {
        id: row.id, sessionId: row.session_id, role: row.role, content: row.content,
        requestStatus: row.request_status, errorType: row.error_type, inputTokens: row.input_tokens,
        outputTokens: row.output_tokens, estimatedCost: row.estimated_cost, createdAt: row.created_at, updatedAt: row.updated_at,
        analysis: run ? {
          id: run.id, providerId: run.provider_id, modelName: run.model_name, requestStatus: run.request_status,
          errorType: run.error_type, contextScope: parseJson(run.context_scope_json, {}), payloadHash: run.payload_hash,
          inputTokens: run.input_tokens, outputTokens: run.output_tokens, estimatedCost: run.estimated_cost,
          snapshotCreatedAt: run.snapshot_created_at, sources,
        } : null,
      };
    });
  }

  addChatMessage({ sessionId, role, content, requestStatus = 'complete', errorType = '', inputTokens = 0, outputTokens = 0, estimatedCost = 0 }) {
    const item = { id: makeId('msg'), createdAt: nowIso() };
    this.transaction((db) => {
      db.prepare(`INSERT INTO ai_chat_messages(id,session_id,role,content,request_status,error_type,input_tokens,output_tokens,estimated_cost,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)`)
        .run(item.id, sessionId, role, content, requestStatus, errorType, inputTokens, outputTokens, estimatedCost, item.createdAt, item.createdAt);
      db.prepare('UPDATE ai_chat_sessions SET updated_at=? WHERE id=?').run(item.createdAt, sessionId);
    });
    return { ...item, sessionId, role, content, requestStatus, errorType, inputTokens, outputTokens, estimatedCost };
  }

  createAnalysisRun(data) {
    const item = { id: makeId('run'), createdAt: nowIso() };
    this.db.prepare(`
      INSERT INTO ai_analysis_runs(id,session_id,user_message_id,assistant_message_id,provider_id,model_name,request_status,error_type,context_scope_json,payload_hash,input_tokens,output_tokens,estimated_cost,snapshot_created_at,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `).run(item.id, data.sessionId, data.userMessageId || null, data.assistantMessageId || null, data.providerId, data.modelName, data.requestStatus || 'pending', data.errorType || '', json(data.contextScope || {}), data.payloadHash || '', data.inputTokens || 0, data.outputTokens || 0, data.estimatedCost || 0, data.snapshotCreatedAt || '', item.createdAt, item.createdAt);
    return item;
  }

  finishAnalysisRun(runId, data) {
    const now = nowIso();
    this.db.prepare(`
      UPDATE ai_analysis_runs SET assistant_message_id=?,request_status=?,error_type=?,input_tokens=?,output_tokens=?,estimated_cost=?,updated_at=? WHERE id=?
    `).run(data.assistantMessageId || null, data.requestStatus, data.errorType || '', data.inputTokens || 0, data.outputTokens || 0, data.estimatedCost || 0, now, runId);
    return { ok: true, updatedAt: now };
  }

  addContextSources(runId, sources) {
    const statement = this.db.prepare(`
      INSERT INTO ai_context_sources(id,analysis_run_id,source_type,source_table,source_record_id,module,country_code,store_id,date_start,date_end,record_count,snapshot_at,summary_json,created_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `);
    const createdAt = nowIso();
    for (const source of sources || []) statement.run(makeId('source'), runId, source.sourceType, source.sourceTable || '', source.sourceRecordId || '', source.module || '', source.countryCode || '', source.storeId || '', source.dateStart || '', source.dateEnd || '', source.recordCount || 0, source.snapshotAt || createdAt, json(source.summary || {}), createdAt);
  }

  addUsageRecord(data) {
    const createdAt = nowIso();
    this.db.prepare(`
      INSERT INTO ai_usage_records(id,analysis_run_id,provider_id,model_name,input_tokens,output_tokens,estimated_cost,request_status,error_type,usage_date,usage_month,created_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?)
    `).run(makeId('usage'), data.analysisRunId || null, data.providerId, data.modelName, data.inputTokens || 0, data.outputTokens || 0, data.estimatedCost || 0, data.requestStatus, data.errorType || '', createdAt.slice(0, 10), createdAt.slice(0, 7), createdAt);
  }

  getUsageSummary() {
    const day = localDay();
    const month = day.slice(0, 7);
    const daily = this.db.prepare('SELECT COUNT(*) AS calls,COALESCE(SUM(estimated_cost),0) AS cost,COALESCE(SUM(input_tokens),0) AS input_tokens,COALESCE(SUM(output_tokens),0) AS output_tokens FROM ai_usage_records WHERE usage_date=?').get(day);
    const monthly = this.db.prepare('SELECT COUNT(*) AS calls,COALESCE(SUM(estimated_cost),0) AS cost FROM ai_usage_records WHERE usage_month=?').get(month);
    return { day, month, daily, monthly };
  }

  listMemories(filters = {}) {
    const conditions = [];
    const params = [];
    if (filters.enabled !== undefined) { conditions.push('enabled=?'); params.push(filters.enabled ? 1 : 0); }
    if (filters.countryCode) { conditions.push('(country_code=? OR country_code=\'\')'); params.push(filters.countryCode); }
    if (filters.storeId) { conditions.push('(store_id=? OR store_id=\'\')'); params.push(filters.storeId); }
    if (filters.businessModule) { conditions.push('(business_module=? OR business_module=\'\')'); params.push(filters.businessModule); }
    const rows = this.db.prepare(`SELECT * FROM ai_memory_items${conditions.length ? ` WHERE ${conditions.join(' AND ')}` : ''} ORDER BY enabled DESC,updated_at DESC LIMIT 500`).all(...params);
    return rows.map((row) => ({ id: row.id, title: row.title, content: row.content, memoryType: row.memory_type, countryCode: row.country_code, storeId: row.store_id, businessModule: row.business_module, source: row.source, aiSuggested: Boolean(row.ai_suggested), userConfirmed: Boolean(row.user_confirmed), enabled: Boolean(row.enabled), confirmedAt: row.confirmed_at, createdAt: row.created_at, updatedAt: row.updated_at }));
  }

  createConfirmedMemory(data) {
    if (data.userConfirmed !== true) fail('CONFIRMATION_REQUIRED', '长期记忆必须由用户明确确认');
    const item = { id: makeId('memory'), createdAt: nowIso() };
    this.db.prepare(`
      INSERT INTO ai_memory_items(id,title,content,memory_type,country_code,store_id,business_module,source,ai_suggested,user_confirmed,enabled,confirmed_at,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `).run(item.id, data.title, data.content, data.memoryType, data.countryCode || '', data.storeId || '', data.businessModule || '', data.source || 'user', data.aiSuggested ? 1 : 0, 1, data.enabled === false ? 0 : 1, item.createdAt, item.createdAt, item.createdAt);
    return { ...item, ...data, userConfirmed: true, confirmedAt: item.createdAt };
  }

  updateMemory(memoryId, data) {
    const now = nowIso();
    const result = this.db.prepare(`
      UPDATE ai_memory_items SET title=?,content=?,memory_type=?,country_code=?,store_id=?,business_module=?,source=?,ai_suggested=?,enabled=?,updated_at=? WHERE id=?
    `).run(data.title, data.content, data.memoryType, data.countryCode || '', data.storeId || '', data.businessModule || '', data.source || 'user', data.aiSuggested ? 1 : 0, data.enabled ? 1 : 0, now, memoryId);
    if (!result.changes) fail('NOT_FOUND', '长期记忆不存在');
    return { ok: true, updatedAt: now };
  }

  setMemoryEnabled(memoryId, enabled) {
    const result = this.db.prepare('UPDATE ai_memory_items SET enabled=?,updated_at=? WHERE id=?').run(enabled ? 1 : 0, nowIso(), memoryId);
    if (!result.changes) fail('NOT_FOUND', '长期记忆不存在');
    return { ok: true };
  }

  deleteMemory(memoryId) {
    const result = this.db.prepare('DELETE FROM ai_memory_items WHERE id=?').run(memoryId);
    if (!result.changes) fail('NOT_FOUND', '长期记忆不存在');
    return { ok: true };
  }

  latestConversationSummary(sessionId) {
    const row = this.db.prepare('SELECT * FROM ai_conversation_summaries WHERE session_id=? ORDER BY created_at DESC LIMIT 1').get(sessionId);
    return row ? { id: row.id, content: row.content, throughMessageId: row.through_message_id, messageCount: row.message_count, isAiGenerated: Boolean(row.is_ai_generated), providerId: row.provider_id, modelName: row.model_name, createdAt: row.created_at } : null;
  }

  addConversationSummary(data) {
    const createdAt = nowIso();
    const summaryId = makeId('summary');
    this.db.prepare(`
      INSERT INTO ai_conversation_summaries(id,session_id,content,through_message_id,message_count,is_ai_generated,provider_id,model_name,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,?)
    `).run(summaryId, data.sessionId, data.content, data.throughMessageId || '', data.messageCount || 0, data.isAiGenerated ? 1 : 0, data.providerId || '', data.modelName || '', createdAt, createdAt);
    return { id: summaryId, createdAt };
  }

  searchMemories(query, limit = 30) {
    const safeLimit = integer(limit, { name: '检索数量', min: 1, max: 100 });
    const tokens = String(query || '').trim().split(/\s+/).filter(Boolean).slice(0, 8).map((token) => `"${token.replace(/"/g, '""')}"*`).join(' ');
    if (!tokens) return [];
    return this.db.prepare(`
      SELECT m.* FROM ai_memory_fts f JOIN ai_memory_items m ON m.rowid=f.rowid
      WHERE ai_memory_fts MATCH ? AND m.enabled=1 AND m.user_confirmed=1 ORDER BY rank LIMIT ?
    `).all(tokens, safeLimit).map((row) => ({ id: row.id, title: row.title, content: row.content, memoryType: row.memory_type, countryCode: row.country_code, storeId: row.store_id, businessModule: row.business_module }));
  }

  info() {
    let size = 0;
    try { size = fs.statSync(this.filePath).size; } catch { /* database not flushed yet */ }
    const historyCount = Object.values(HISTORY_TABLES).reduce((total, table) => total + Number(this.db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count || 0), 0);
    return {
      location: 'Electron userData/data/operations.db',
      size,
      lastSync: this.getMeta('last_storage_sync'),
      uploads: Number(this.db.prepare('SELECT COUNT(*) AS count FROM uploaded_files').get().count || 0),
      schemaVersion: String(this._schemaVersion()),
      expectedSchemaVersion: String(LATEST_SCHEMA_VERSION),
      historyCount,
      backups: this.listBackups().length,
    };
  }

  close() {
    if (!this.db) return;
    try { this.db.close(); } catch { /* already closed */ }
    this.db = null;
  }
}

module.exports = { OperationsDatabase, HISTORY_TABLES, LATEST_SCHEMA_VERSION };
