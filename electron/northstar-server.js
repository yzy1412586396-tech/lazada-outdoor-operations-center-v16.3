const crypto = require('crypto');
const http = require('http');
const { ContextBuilder } = require('./services/context-builder');

const API_PREFIX = '/api/v16';
const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_PORT = 35800;
const BUSINESS_KEY_PREFIXES = Object.freeze([
  'lazadaOps',
  'lazadaDaily',
  'lazada_daily_report_',
  'lazadaInventory',
]);
const SENSITIVE_KEY_PARTS = Object.freeze([
  'password',
  'passwd',
  'token',
  'cookie',
  'secret',
  'credential',
  'authorization',
  'apikey',
  'api_key',
]);
const HISTORY_MODULES = Object.freeze([
  'daily_report',
  'inventory',
  'control_price',
  'activity_price',
  'repricing',
  'expense',
  'sku',
  'anomaly',
  'operation',
]);

function isSafeBusinessKey(value) {
  const key = String(value || '').trim();
  if (!key || !BUSINESS_KEY_PREFIXES.some((prefix) => key.startsWith(prefix))) return false;
  const normalized = key.toLowerCase();
  return !SENSITIVE_KEY_PARTS.some((part) => normalized.includes(part));
}

function sanitizeStorageEntries(entries) {
  if (!Array.isArray(entries)) return [];
  return entries
    .filter((entry) => Array.isArray(entry) && entry.length === 2 && isSafeBusinessKey(entry[0]))
    .map(([key, value]) => [String(key), String(value ?? '')]);
}

function snapshotVersion(entries) {
  return crypto.createHash('sha256').update(JSON.stringify(entries)).digest('hex').slice(0, 16);
}

function responseHeaders(extra = {}) {
  return {
    'Access-Control-Allow-Headers': 'Accept, Content-Type',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Origin': '*',
    'Cache-Control': 'no-store',
    'Content-Type': 'application/json; charset=utf-8',
    'X-Content-Type-Options': 'nosniff',
    ...extra,
  };
}

function sendJson(res, status, payload) {
  const body = Buffer.from(JSON.stringify(payload), 'utf8');
  res.writeHead(status, responseHeaders({ 'Content-Length': String(body.length) }));
  res.end(body);
}

class NorthstarReadOnlyServer {
  constructor(options = {}) {
    if (!options.database) throw new TypeError('NorthstarReadOnlyServer requires a database');
    this.database = options.database;
    this.host = String(options.host || DEFAULT_HOST);
    this.port = Number.isInteger(Number(options.port)) ? Number(options.port) : DEFAULT_PORT;
    this.version = String(options.version || 'unknown');
    this.contextBuilder = options.contextBuilder || new ContextBuilder(this.database);
    this.startedAt = new Date().toISOString();
    this.server = null;
  }

  _storageSnapshot() {
    const storage = this.database.loadStorage();
    const entries = sanitizeStorageEntries(storage?.entries);
    return {
      initialized: Boolean(storage?.initialized),
      entries,
      version: snapshotVersion(entries),
      serverTime: new Date().toISOString(),
    };
  }

  _uploads() {
    const rows = this.database.listUploads();
    if (!Array.isArray(rows)) return [];
    return rows.map((item) => ({
      slot: String(item?.slot || ''),
      name: String(item?.name || ''),
      type: String(item?.type || ''),
      lastModified: Number(item?.lastModified) || 0,
      size: Number(item?.size) || 0,
      updatedAt: String(item?.updatedAt || ''),
    }));
  }

  _catalog() {
    const raw = typeof this.database.historyFilterOptions === 'function'
      ? this.database.historyFilterOptions()
      : {};
    const safeList = (items, fields) => (Array.isArray(items) ? items : []).map((item) => {
      const result = {};
      for (const field of fields) if (item && item[field] !== undefined) result[field] = String(item[field] ?? '');
      return result;
    });
    return {
      countries: safeList(raw.countries, ['code', 'name']),
      stores: safeList(raw.stores, ['id', 'external_id', 'name', 'country_code']),
      databases: safeList(raw.databases, ['id', 'external_id', 'name', 'country_code']),
      modules: HISTORY_MODULES,
      readOnly: true,
    };
  }

  _history(url) {
    const module = String(url.searchParams.get('module') || '').trim();
    if (!HISTORY_MODULES.includes(module)) {
      const error = new Error('历史模块无效');
      error.code = 'VALIDATION_ERROR';
      throw error;
    }
    const parseText = (key, max = 100) => String(url.searchParams.get(key) || '').trim().slice(0, max);
    const dateStart = parseText('dateStart', 10);
    const dateEnd = parseText('dateEnd', 10);
    const validDate = (value) => !value || (/^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`)));
    if (!validDate(dateStart) || !validDate(dateEnd) || (dateStart && dateEnd && dateStart > dateEnd)) {
      const error = new Error('日期筛选条件无效');
      error.code = 'VALIDATION_ERROR';
      throw error;
    }
    const parsedLimit = Number(url.searchParams.get('limit') || 100);
    if (!Number.isSafeInteger(parsedLimit) || parsedLimit < 1 || parsedLimit > 200) {
      const error = new Error('历史记录数量必须是1到200之间的整数');
      error.code = 'VALIDATION_ERROR';
      throw error;
    }
    const parsedOffset = Number(url.searchParams.get('offset') || 0);
    if (!Number.isSafeInteger(parsedOffset) || parsedOffset < 0 || parsedOffset > 1_000_000) {
      const error = new Error('历史记录偏移量必须是0到1000000之间的整数');
      error.code = 'VALIDATION_ERROR';
      throw error;
    }
    const parsedArrayLimit = Number(url.searchParams.get('arrayLimit') || 50);
    if (!Number.isSafeInteger(parsedArrayLimit) || parsedArrayLimit < 10 || parsedArrayLimit > 200) {
      const error = new Error('嵌套明细数量必须是10到200之间的整数');
      error.code = 'VALIDATION_ERROR';
      throw error;
    }
    const resultStatus = parseText('resultStatus', 20);
    if (resultStatus && !['success', 'failed'].includes(resultStatus)) {
      const error = new Error('活动结果筛选条件无效');
      error.code = 'VALIDATION_ERROR';
      throw error;
    }
    const billingMonth = parseText('billingMonth', 7);
    if (billingMonth && !/^\d{4}-(0[1-9]|1[0-2])$/.test(billingMonth)) {
      const error = new Error('费用账期必须是YYYY-MM格式');
      error.code = 'VALIDATION_ERROR';
      throw error;
    }
    const filters = {
      countryCode: parseText('countryCode', 10),
      storeId: parseText('storeId', 100),
      databaseId: parseText('databaseId', 100),
      dateStart,
      dateEnd,
      limit: parsedLimit,
      offset: parsedOffset,
      resultStatus,
      billingMonth,
      includeDetails: true,
      maxDetailRows: parsedLimit,
      maxArrayItems: parsedArrayLimit,
      includeSku: url.searchParams.get('includeSku') !== 'false',
      includeTitles: false,
    };
    const context = this.contextBuilder._getModuleContext(module, filters);
    return {
      module,
      filters: {
        countryCode: filters.countryCode,
        storeId: filters.storeId,
        databaseId: filters.databaseId,
        dateStart,
        dateEnd,
        limit: parsedLimit,
        offset: parsedOffset,
        resultStatus,
        billingMonth,
        arrayLimit: parsedArrayLimit,
        includeSku: filters.includeSku,
      },
      recordCount: context.recordCount,
      returnedCount: context.returnedCount,
      offset: parsedOffset,
      limit: parsedLimit,
      hasMore: Boolean(context.hasMore),
      numericSummary: context.numericSummary,
      records: context.records,
      referencedIds: context.referencedIds,
      truncated: Boolean(context.truncated),
      readOnly: true,
      generatedAt: new Date().toISOString(),
    };
  }

  _handle(req, res) {
    if (req.method === 'OPTIONS') {
      res.writeHead(204, responseHeaders({ 'Content-Length': '0' }));
      res.end();
      return;
    }
    if (req.method !== 'GET') {
      sendJson(res, 405, { ok: false, error: { code: 'READ_ONLY_API', message: 'Northstar 接口仅允许读取' } });
      return;
    }

    let pathname = '';
    try {
      pathname = new URL(req.url || '/', `http://${this.host}`).pathname;
    } catch {
      sendJson(res, 400, { ok: false, error: { code: 'INVALID_REQUEST', message: '请求地址无效' } });
      return;
    }

    try {
      if (pathname === `${API_PREFIX}/health` || pathname === '/api/northstar/v1/health') {
        sendJson(res, 200, {
          ok: true,
          data: {
            service: 'lazada-operations-center-northstar-api',
            version: this.version,
            readOnly: true,
            startedAt: this.startedAt,
          },
        });
        return;
      }

      if (pathname === `${API_PREFIX}/storage` || pathname === '/api/northstar/v1/storage') {
        sendJson(res, 200, { ok: true, data: this._storageSnapshot() });
        return;
      }

      if (pathname === `${API_PREFIX}/storage/version`) {
        const snapshot = this._storageSnapshot();
        sendJson(res, 200, { ok: true, data: { version: snapshot.version, serverTime: snapshot.serverTime } });
        return;
      }

      if (pathname === `${API_PREFIX}/uploads` || pathname === '/api/northstar/v1/uploads') {
        sendJson(res, 200, { ok: true, data: this._uploads() });
        return;
      }

      if (pathname === '/api/northstar/v1/catalog') {
        sendJson(res, 200, { ok: true, data: this._catalog() });
        return;
      }

      if (pathname === '/api/northstar/v1/history') {
        sendJson(res, 200, { ok: true, data: this._history(new URL(req.url || '/', `http://${this.host}`)) });
        return;
      }

      if (pathname === '/api/northstar/v1/snapshot') {
        const storage = this._storageSnapshot();
        sendJson(res, 200, { ok: true, data: { ...storage, uploads: this._uploads() } });
        return;
      }

      sendJson(res, 404, { ok: false, error: { code: 'NOT_FOUND', message: '接口不存在' } });
    } catch (error) {
      const status = error?.code === 'VALIDATION_ERROR' ? 400 : 500;
      sendJson(res, status, {
        ok: false,
        error: { code: 'READ_FAILED', message: `读取运营中心数据失败：${String(error?.message || error).slice(0, 300)}` },
      });
    }
  }

  start() {
    if (this.server) return Promise.resolve(this.address());
    this.startedAt = new Date().toISOString();
    this.server = http.createServer((req, res) => this._handle(req, res));
    return new Promise((resolve, reject) => {
      const onError = (error) => {
        this.server = null;
        reject(error);
      };
      this.server.once('error', onError);
      this.server.listen(this.port, this.host, () => {
        this.server.removeListener('error', onError);
        resolve(this.address());
      });
    });
  }

  address() {
    const address = this.server?.address();
    return {
      host: this.host,
      port: typeof address === 'object' && address ? address.port : this.port,
      readOnly: true,
    };
  }

  stop() {
    if (!this.server) return Promise.resolve();
    const server = this.server;
    this.server = null;
    return new Promise((resolve) => server.close(() => resolve()));
  }
}

module.exports = {
  API_PREFIX,
  BUSINESS_KEY_PREFIXES,
  DEFAULT_HOST,
  DEFAULT_PORT,
  NorthstarReadOnlyServer,
  isSafeBusinessKey,
  sanitizeStorageEntries,
  snapshotVersion,
};
