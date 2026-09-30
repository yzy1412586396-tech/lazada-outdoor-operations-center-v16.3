'use strict';

const crypto = require('crypto');
const { SqliteRetrievalService } = require('./retrieval-service');
const { fail, plainObject, text, optionalText, id, boolean, integer, oneOf, isoDate, stringArray } = require('../lib/validation');

const ALLOWED_MODULES = ['daily_report', 'inventory', 'control_price', 'activity_price', 'repricing', 'expense', 'sku', 'anomaly', 'operation'];
const ALLOWED_INDICATORS = ['count', 'sum', 'average', 'min', 'max', 'trend', 'change', 'anomaly'];
const SENSITIVE_KEY = /phone|mobile|email|address|recipient|buyer|customer|name|电话|手机|邮箱|地址|收件|买家|客户/i;
const SKU_KEY = /(^|_)(sku|seller_sku|shop_sku)($|_)/i;
const TITLE_KEY = /title|product_name|商品标题|商品名称|中文名称/i;

const deepClone = (value) => JSON.parse(JSON.stringify(value));
const estimateTokens = (value) => Math.ceil(String(value || '').length / 2);

class ContextBuilder {
  constructor(database) {
    this.database = database;
    this.retrieval = new SqliteRetrievalService(database);
    this.previews = new Map();
  }

  getDailyReportContext(filters) { return this._getModuleContext('daily_report', filters); }
  getInventoryContext(filters) { return this._getModuleContext('inventory', filters); }
  getControlPriceContext(filters) { return this._getModuleContext('control_price', filters); }
  getActivityContext(filters) { return this._getModuleContext('activity_price', filters); }
  getRepricingContext(filters) { return this._getModuleContext('repricing', filters); }
  getExpenseContext(filters) { return this._getModuleContext('expense', filters); }
  getOperationHistoryContext(filters) { return this._getModuleContext('operation', filters); }

  getConfirmedMemories(filters) {
    const scope = plainObject(filters || {}, '记忆筛选条件');
    return deepClone(this.retrieval.searchConfirmedMemories(optionalText(scope.query, { name: '检索词', max: 6000 }), {
      countryCode: optionalText(scope.countryCode, { name: '国家', max: 10 }),
      storeId: optionalText(scope.storeId, { name: '店铺', max: 100 }),
      businessModule: optionalText(scope.businessModule, { name: '业务模块', max: 40 }),
    }));
  }

  getRecentConversationContext(sessionIdValue) {
    const sessionId = id(sessionIdValue, '会话ID');
    const limits = this.database.getSetting('context_limits', {});
    const recentLimit = integer(limits.recentMessages || 12, { name: '最近消息数量', min: 2, max: 30 });
    const messages = this.database.getChatMessages(sessionId, 500);
    const recent = messages.slice(-recentLimit).map(({ role, content, createdAt }) => ({ role, content, createdAt }));
    const olderCount = Math.max(0, messages.length - recent.length);
    const summary = olderCount ? this.database.latestConversationSummary(sessionId) : null;
    return deepClone({ recent, olderCount, summary: summary ? { content: summary.content, throughMessageId: summary.throughMessageId, messageCount: summary.messageCount, isAiGenerated: summary.isAiGenerated } : null });
  }

  _validateRequest(raw) {
    const request = plainObject(raw || {}, '上下文请求');
    const limits = this.database.getSetting('context_limits', {});
    const safeMax = integer(limits.maxDetailRows || 500, { name: '最大明细行数安全上限', min: 50, max: 2000 });
    const modules = request.modules === undefined ? [] : stringArray(request.modules, { name: '数据模块', maxItems: ALLOWED_MODULES.length, itemMax: 30 }).map((value) => oneOf(value, ALLOWED_MODULES, '数据模块'));
    const indicators = request.indicators === undefined ? ['count', 'average', 'min', 'max', 'anomaly'] : stringArray(request.indicators, { name: '分析指标', maxItems: ALLOWED_INDICATORS.length, itemMax: 20 }).map((value) => oneOf(value, ALLOWED_INDICATORS, '分析指标'));
    const dateStart = isoDate(request.dateStart, { name: '开始日期', allowEmpty: true });
    const dateEnd = isoDate(request.dateEnd, { name: '结束日期', allowEmpty: true });
    if (dateStart && dateEnd && dateStart > dateEnd) fail('VALIDATION_ERROR', '开始日期不能晚于结束日期');
    if (dateStart && dateEnd) {
      const days = Math.ceil((Date.parse(`${dateEnd}T00:00:00Z`) - Date.parse(`${dateStart}T00:00:00Z`)) / 86400000);
      if (days > 730) fail('CONTEXT_RANGE_TOO_LARGE', '单次分析日期范围不能超过730天，请缩小范围');
    }
    return {
      sessionId: request.sessionId ? id(request.sessionId, '会话ID') : '',
      question: text(request.question || '', { name: '问题', min: 1, max: 6000 }),
      countryCode: optionalText(request.countryCode, { name: '国家', max: 10 }),
      storeId: optionalText(request.storeId, { name: '店铺', max: 100 }),
      databaseId: optionalText(request.databaseId, { name: '业务数据库', max: 100 }),
      dateStart,
      dateEnd,
      modules,
      indicators,
      includeSku: request.includeSku === undefined ? false : boolean(request.includeSku, '包含SKU'),
      includeTitles: request.includeTitles === undefined ? false : boolean(request.includeTitles, '包含商品标题'),
      includeDetails: request.includeDetails === undefined ? false : boolean(request.includeDetails, '包含明细'),
      maxDetailRows: integer(request.maxDetailRows || limits.defaultDetailRows || 100, { name: '明细行数', min: 1, max: safeMax }),
      includeAnomalies: request.includeAnomalies === undefined ? true : boolean(request.includeAnomalies, '包含异常'),
      includeRecentChat: request.includeRecentChat === undefined ? false : boolean(request.includeRecentChat, '包含最近聊天'),
      includeMemories: request.includeMemories === undefined ? false : boolean(request.includeMemories, '包含长期记忆'),
    };
  }

  _getModuleContext(module, filters) {
    const result = this.database.getHistoryRows(module, filters);
    const rows = Array.isArray(result) ? result : (Array.isArray(result?.rows) ? result.rows : []);
    const totalCount = Number.isSafeInteger(Number(result?.totalCount)) ? Number(result.totalCount) : rows.length;
    const includeDetails = Boolean(filters.includeDetails);
    const maxRows = Number(filters.maxDetailRows || 100);
    const pruned = rows.map((row) => ({
      id: row.id,
      countryCode: row.country_code || '',
      storeId: row.store_id || '',
      businessDatabaseId: row.business_database_id || '',
      businessDate: row.business_date || String(row.created_at || '').slice(0, 10),
      createdAt: row.created_at,
      payload: this._prunePayload(row.payload || {}, filters),
    }));
    const numericSummary = this._numericSummary(pruned.map((row) => row.payload));
    return {
      module,
      recordCount: totalCount,
      returnedCount: rows.length,
      offset: Number(filters.offset || 0),
      limit: Number(filters.limit || rows.length || 0),
      numericSummary,
      records: includeDetails ? pruned.slice(0, maxRows) : [],
      referencedIds: rows.map((row) => row.id),
      hasMore: Number(filters.offset || 0) + rows.length < totalCount,
      truncated: includeDetails && Number(filters.offset || 0) + rows.length < totalCount,
    };
  }

  _prunePayload(value, filters, depth = 0) {
    if (depth > 5) return '[已在底层汇总]';
    if (Array.isArray(value)) {
      const arrayLimit = Math.max(10, Math.min(Number(filters.maxArrayItems || 500), 500));
      return value.slice(0, arrayLimit).map((item) => this._prunePayload(item, filters, depth + 1));
    }
    if (!value || typeof value !== 'object') return value;
    const result = {};
    for (const [key, item] of Object.entries(value)) {
      if (!filters.includeSku && SKU_KEY.test(key)) continue;
      if (!filters.includeTitles && TITLE_KEY.test(key)) continue;
      if (SENSITIVE_KEY.test(key)) {
        result[key] = '[可能敏感字段已隐藏]';
        continue;
      }
      result[key] = this._prunePayload(item, filters, depth + 1);
    }
    return result;
  }

  _numericSummary(payloads) {
    const buckets = new Map();
    let visited = 0;
    const walk = (value, prefix = '', depth = 0) => {
      if (visited > 20000 || depth > 4) return;
      visited += 1;
      if (typeof value === 'number' && Number.isFinite(value)) {
        const key = prefix || 'value';
        const bucket = buckets.get(key) || [];
        if (bucket.length < 5000) bucket.push(value);
        buckets.set(key, bucket);
        return;
      }
      if (Array.isArray(value)) {
        for (const item of value.slice(0, 1000)) walk(item, prefix, depth + 1);
      } else if (value && typeof value === 'object') {
        for (const [key, item] of Object.entries(value)) walk(item, prefix ? `${prefix}.${key}` : key, depth + 1);
      }
    };
    for (const payload of payloads) walk(payload);
    const summary = {};
    for (const [key, values] of buckets) {
      if (!values.length) continue;
      const sum = values.reduce((total, value) => total + value, 0);
      summary[key] = { count: values.length, sum, average: sum / values.length, min: Math.min(...values), max: Math.max(...values) };
      if (Object.keys(summary).length >= 80) break;
    }
    return summary;
  }

  buildAnalysisPreview(rawRequest) {
    this._purgeExpiredPreviews();
    const request = this._validateRequest(rawRequest);
    const modules = [...request.modules];
    if (request.includeAnomalies && !modules.includes('anomaly')) modules.push('anomaly');
    const datasets = [];
    const sources = [];
    let detailRows = 0;
    for (const module of modules) {
      const context = this._getModuleContext(module, {
        countryCode: request.countryCode,
        storeId: request.storeId,
        databaseId: request.databaseId,
        dateStart: request.dateStart,
        dateEnd: request.dateEnd,
        limit: request.includeDetails ? Math.min(2000, request.maxDetailRows * 4) : 1000,
        includeDetails: request.includeDetails,
        maxDetailRows: Math.max(1, request.maxDetailRows - detailRows),
        includeSku: request.includeSku,
        includeTitles: request.includeTitles,
      });
      detailRows += context.records.length;
      datasets.push(context);
      sources.push({
        sourceType: 'business_history', sourceTable: module, sourceRecordId: context.referencedIds.slice(0, 200).join(','),
        module, countryCode: request.countryCode, storeId: request.storeId, dateStart: request.dateStart,
        dateEnd: request.dateEnd, recordCount: context.recordCount, snapshotAt: nowIso(),
        summary: { referencedIds: context.referencedIds.slice(0, 200), truncated: context.truncated },
      });
    }
    const memories = request.includeMemories ? this.getConfirmedMemories({ query: request.question, countryCode: request.countryCode, storeId: request.storeId, businessModule: modules[0] || '' }).slice(0, 30) : [];
    if (memories.length) sources.push({ sourceType: 'confirmed_memory', sourceTable: 'ai_memory_items', sourceRecordId: memories.map((item) => item.id).join(','), module: modules[0] || '', countryCode: request.countryCode, storeId: request.storeId, recordCount: memories.length, snapshotAt: nowIso(), summary: { ids: memories.map((item) => item.id) } });
    const conversation = request.includeRecentChat && request.sessionId ? this.getRecentConversationContext(request.sessionId) : null;
    if (conversation) sources.push({ sourceType: 'conversation', sourceTable: 'ai_chat_messages', sourceRecordId: request.sessionId, module: '', countryCode: '', storeId: '', recordCount: conversation.recent.length, snapshotAt: nowIso(), summary: { olderCount: conversation.olderCount, hasSummary: Boolean(conversation.summary) } });

    const payload = deepClone({
      scope: {
        countryCode: request.countryCode, storeId: request.storeId, databaseId: request.databaseId,
        dateStart: request.dateStart, dateEnd: request.dateEnd, modules, indicators: request.indicators,
        includes: { sku: request.includeSku, titles: request.includeTitles, details: request.includeDetails, anomalies: request.includeAnomalies, recentChat: request.includeRecentChat, confirmedMemories: request.includeMemories },
      },
      datasets,
      confirmedMemories: memories.map(({ id: memoryId, title, content, memoryType, countryCode, storeId, businessModule }) => ({ memoryId, title, content, memoryType, countryCode, storeId, businessModule })),
      conversation,
      userQuestion: request.question,
      generatedAt: nowIso(),
    });
    const encoded = JSON.stringify(payload);
    const estimatedTokenCount = estimateTokens(encoded);
    const contextLimits = this.database.getSetting('context_limits', {});
    const maxCharacters = integer(contextLimits.maxInputCharacters || 24000, { name: '最大上下文字符数', min: 4000, max: 200000 });
    if (encoded.length > maxCharacters) fail('CONTEXT_TOO_LARGE', `本次上下文约${encoded.length}字符，超过${maxCharacters}字符安全上限，请缩小日期范围或关闭明细`);
    const previewId = `preview-${crypto.randomUUID()}`;
    const expiresAt = Date.now() + 10 * 60 * 1000;
    this.previews.set(previewId, { request, payload, sources, encoded, expiresAt });
    return {
      previewId,
      expiresAt: new Date(expiresAt).toISOString(),
      summary: {
        dataSources: sources.map((source) => source.sourceType), modules, dateStart: request.dateStart, dateEnd: request.dateEnd,
        countryCode: request.countryCode, storeId: request.storeId, databaseId: request.databaseId,
        fields: this._collectFields(payload).slice(0, 80), recordCount: datasets.reduce((sum, item) => sum + item.recordCount, 0),
        detailRows, estimatedCharacters: encoded.length, estimatedTokens: estimatedTokenCount,
        includesSku: request.includeSku, includesTitles: request.includeTitles,
        containsPotentiallySensitiveInformation: SENSITIVE_KEY.test(encoded) || encoded.includes('[可能敏感字段已隐藏]'),
        confirmedMemoryCount: memories.length, recentMessageCount: conversation?.recent?.length || 0,
      },
      dataPreview: payload,
    };
  }

  buildConfirmedAnalysisPayload(previewIdValue) {
    this._purgeExpiredPreviews();
    const previewId = id(previewIdValue, '预览ID');
    const item = this.previews.get(previewId);
    if (!item) fail('PREVIEW_EXPIRED', '发送预览已过期，请重新生成并确认');
    return deepClone({ previewId, request: item.request, payload: item.payload, sources: item.sources, encoded: item.encoded, payloadHash: crypto.createHash('sha256').update(item.encoded).digest('hex') });
  }

  _collectFields(value, prefix = '', fields = new Set(), depth = 0) {
    if (!value || typeof value !== 'object' || depth > 4 || fields.size >= 100) return [...fields];
    if (Array.isArray(value)) {
      for (const item of value.slice(0, 3)) this._collectFields(item, prefix, fields, depth + 1);
    } else {
      for (const [key, item] of Object.entries(value)) {
        const full = prefix ? `${prefix}.${key}` : key;
        fields.add(full);
        this._collectFields(item, full, fields, depth + 1);
      }
    }
    return [...fields];
  }

  _purgeExpiredPreviews() {
    const now = Date.now();
    for (const [key, value] of this.previews) if (value.expiresAt < now) this.previews.delete(key);
  }
}

function nowIso() { return new Date().toISOString(); }

module.exports = { ContextBuilder, ALLOWED_MODULES, ALLOWED_INDICATORS, estimateTokens };
