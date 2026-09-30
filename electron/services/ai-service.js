'use strict';

const crypto = require('crypto');
const { AppError, fail, plainObject, text, optionalText, id, boolean, integer, number, oneOf, safeError, redactSecrets } = require('../lib/validation');
const { estimateTokens } = require('./context-builder');

const FIXED_SYSTEM_PROMPT = `你是该软件中的只读运营分析助手。你只能分析用户明确提供的数据、历史摘要和问题，并输出解释、对比、异常、趋势、风险、建议及需要人工检查的事项。

你没有权限修改文件、数据、数据库、价格、库存、活动记录、费用结果、软件设置或业务规则。你不能执行任何操作，也不能声称已经执行操作。

当用户要求执行或修改时，你只能说明建议、原因、可能影响和人工操作步骤，并明确最终操作必须由用户本人完成。

不得编造未提供的数据。信息不足时必须明确说明缺少哪些信息。涉及数字时必须区分原始数据、底层代码计算结果和你的推测。

你的分析结果仅供参考，底层确定性代码和用户本人拥有最终执行权。`;

const MOCK_TEXT = 'Mock Provider 测试成功。这里是只读运营观察结果：当前数据仅用于界面与上下文链路验证，我没有修改任何文件、价格、库存、费用或业务数据库记录。最终业务操作必须由用户本人完成。';
const MAX_ATTACHMENTS = 3;
const MAX_ATTACHMENT_BYTES = 8 * 1024 * 1024;
const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
const MAX_ATTACHMENT_TEXT = 30000;
const MAX_TOTAL_ATTACHMENT_TEXT = 48000;
const IMAGE_DATA_URL = /^data:image\/(?:png|jpeg|webp|gif);base64,[A-Za-z0-9+/=]+$/;

function validateAttachments(raw, confirmed) {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) fail('VALIDATION_ERROR', '附件必须是数组');
  if (raw.length > MAX_ATTACHMENTS) fail('ATTACHMENT_LIMIT', `单次最多发送${MAX_ATTACHMENTS}个附件`);
  if (raw.length && confirmed !== true) fail('CONFIRMATION_REQUIRED', '图片和文件必须在预览后由用户确认发送');
  let totalBytes = 0;
  let totalText = 0;
  return raw.map((item, index) => {
    const value = plainObject(item, `第${index + 1}个附件`);
    const kind = oneOf(value.kind, ['text', 'image'], '附件类型');
    const name = text(value.name, { name: '附件名称', min: 1, max: 260 }).replace(/[\\/\r\n\t]/g, '_');
    const mimeType = optionalText(value.mimeType, { name: '附件MIME类型', max: 100 }).toLowerCase();
    const size = integer(value.size || 0, { name: '附件大小', min: 0, max: MAX_ATTACHMENT_BYTES });
    totalBytes += size;
    if (totalBytes > MAX_ATTACHMENT_BYTES * 2) fail('ATTACHMENT_LIMIT', '附件总大小不能超过16MB');
    if (kind === 'text') {
      const content = text(value.text, { name: `${name}的提取文本`, min: 1, max: MAX_ATTACHMENT_TEXT, trim: false });
      totalText += content.length;
      if (totalText > MAX_TOTAL_ATTACHMENT_TEXT) fail('ATTACHMENT_LIMIT', '附件提取文本过长，请减少文件或缩小内容');
      return { kind, name, mimeType, size, text: content };
    }
    if (size > MAX_IMAGE_BYTES) fail('ATTACHMENT_LIMIT', '单张图片不能超过4MB');
    const dataUrl = text(value.dataUrl, { name: `${name}的图片内容`, min: 30, max: Math.ceil(MAX_IMAGE_BYTES * 4 / 3) + 200, trim: false });
    if (!IMAGE_DATA_URL.test(dataUrl)) fail('VALIDATION_ERROR', '仅支持PNG、JPG、WEBP或GIF图片');
    return { kind, name, mimeType, size, dataUrl };
  });
}

function attachmentSummary(attachments) {
  if (!attachments.length) return '';
  return `\n\n${attachments.map((item) => `[附件：${item.name}（${item.kind === 'image' ? '图片' : '本地提取文本'}，${item.size}字节）]`).join('\n')}`;
}

class AIService {
  constructor({ database, contextBuilder, credentialStore, allowMock = false }) {
    this.database = database;
    this.contextBuilder = contextBuilder;
    this.credentialStore = credentialStore;
    this.allowMock = allowMock;
    this.activeRequests = new Map();
  }

  getStatus() {
    const providers = this._providersWithStatus();
    return {
      aiEnabled: Boolean(this.database.getSetting('ai_enabled', false)),
      providers,
      limits: this.database.getSetting('ai_limits', {}),
      usage: this.database.getUsageSummary(),
      safeStorageAvailable: Boolean(this.credentialStore.safeStorage?.isEncryptionAvailable?.()),
      observerOnly: true,
    };
  }

  _providersWithStatus() {
    const providers = this.database.getProviderConfigs().map((provider) => ({ ...provider, keyStatus: this.credentialStore.hasKey(provider.providerId) }));
    if (this.allowMock) providers.push({
      providerId: 'mock', name: 'Mock Provider（仅开发测试）', baseUrl: 'mock://local', modelName: 'mock-observer-v1',
      maxInputTokens: 12000, maxOutputTokens: 1200, timeoutMs: 10000, streamEnabled: true, enabled: true,
      inputCostPerMillion: 0, outputCostPerMillion: 0, keyStatus: { configured: true, masked: '无需密钥' }, developmentOnly: true,
    });
    return providers;
  }

  setAiEnabled(value) {
    const enabled = boolean(value, 'AI总开关');
    this.database.setSetting('ai_enabled', enabled);
    return { ok: true, enabled };
  }

  saveLimits(raw) {
    const value = plainObject(raw, '费用限制');
    const limits = {
      maxInputTokens: integer(value.maxInputTokens, { name: '单次最大输入Token', min: 1000, max: 200000 }),
      maxOutputTokens: integer(value.maxOutputTokens, { name: '单次最大输出Token', min: 64, max: 16000 }),
      dailyCalls: integer(value.dailyCalls, { name: '每日最大调用次数', min: 1, max: 10000 }),
      dailyCost: number(value.dailyCost, { name: '每日费用提醒', min: 0, max: 1_000_000 }),
      monthlyCost: number(value.monthlyCost, { name: '每月费用提醒', min: 0, max: 10_000_000 }),
      costEstimation: boolean(value.costEstimation, '费用估算开关'),
    };
    this.database.setSetting('ai_limits', limits);
    return { ok: true, limits };
  }

  saveProviderConfig(raw) {
    const config = this._validateProviderConfig(raw);
    if (config.providerId === 'mock') fail('VALIDATION_ERROR', 'Mock Provider 不能保存为正式配置');
    return this.database.saveProviderConfig(config);
  }

  _validateProviderConfig(raw) {
    const value = plainObject(raw, '服务商配置');
    const providerId = id(value.providerId, '服务商ID');
    const baseUrl = text(value.baseUrl, { name: 'Base URL', min: 8, max: 500 });
    let url;
    try { url = new URL(baseUrl); } catch { fail('VALIDATION_ERROR', 'Base URL不是有效网址'); }
    const isLocal = ['localhost', '127.0.0.1', '::1'].includes(url.hostname);
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && isLocal)) fail('VALIDATION_ERROR', 'Base URL必须使用HTTPS；仅本机地址可使用HTTP');
    if (url.username || url.password) fail('VALIDATION_ERROR', 'Base URL不能包含账号或密钥');
    return {
      providerId,
      name: text(value.name, { name: '服务商名称', min: 1, max: 80 }),
      baseUrl: baseUrl.replace(/\/+$/, ''),
      modelName: text(value.modelName, { name: '模型名称', min: 1, max: 160 }),
      maxInputTokens: integer(value.maxInputTokens, { name: '服务商最大输入Token', min: 1000, max: 2_000_000 }),
      maxOutputTokens: integer(value.maxOutputTokens, { name: '最大输出Token', min: 64, max: 100_000 }),
      timeoutMs: integer(value.timeoutMs, { name: '请求超时', min: 5000, max: 600_000 }),
      streamEnabled: boolean(value.streamEnabled, '流式输出'),
      enabled: boolean(value.enabled, '服务商启用状态'),
      inputCostPerMillion: number(value.inputCostPerMillion || 0, { name: '输入费用', min: 0, max: 1_000_000 }),
      outputCostPerMillion: number(value.outputCostPerMillion || 0, { name: '输出费用', min: 0, max: 1_000_000 }),
    };
  }

  hasKey(providerIdValue) {
    const providerId = id(providerIdValue, '服务商ID');
    if (providerId === 'mock' && this.allowMock) return { configured: true, masked: '无需密钥' };
    this._requireProvider(providerId, false);
    return this.credentialStore.hasKey(providerId);
  }

  saveKey(providerIdValue, keyValue) {
    const providerId = id(providerIdValue, '服务商ID');
    if (providerId === 'mock') fail('VALIDATION_ERROR', 'Mock Provider不保存密钥');
    this._requireProvider(providerId, false);
    return this.credentialStore.saveKey(providerId, keyValue);
  }

  deleteKey(providerIdValue) {
    const providerId = id(providerIdValue, '服务商ID');
    if (providerId === 'mock') return { configured: true, masked: '无需密钥' };
    return this.credentialStore.deleteKey(providerId);
  }

  async testConnection(providerIdValue, emit = () => {}) {
    const provider = this._requireProvider(id(providerIdValue, '服务商ID'), false);
    const requestId = `test-${crypto.randomUUID()}`;
    const controller = new AbortController();
    this.activeRequests.set(requestId, controller);
    try {
      const result = await this._callProvider(provider, [
        { role: 'system', content: FIXED_SYSTEM_PROMPT },
        { role: 'user', content: '这是用户主动发起的连接测试。请只回复：连接成功。' },
      ], { requestId, controller, maxOutputTokens: 16, emit });
      return { ok: true, providerId: provider.providerId, modelName: provider.modelName, response: result.content.slice(0, 80) };
    } finally {
      this.activeRequests.delete(requestId);
    }
  }

  createSession(raw = {}) {
    const value = plainObject(raw, '会话信息');
    const provider = this._requireProvider(value.providerId || 'deepseek', false);
    return this.database.createChatSession({
      name: text(value.name || '新会话', { name: '会话名称', min: 1, max: 100 }),
      providerId: provider.providerId,
      modelName: provider.modelName,
    });
  }

  listSessions() { return this.database.listChatSessions(); }

  renameSession(raw) {
    const value = plainObject(raw, '会话信息');
    return this.database.renameChatSession(id(value.sessionId, '会话ID'), text(value.name, { name: '会话名称', min: 1, max: 100 }));
  }

  deleteSession(raw) {
    const value = plainObject(raw, '删除会话参数');
    if (value.confirmed !== true) fail('CONFIRMATION_REQUIRED', '删除会话需要用户确认');
    return this.database.deleteChatSession(id(value.sessionId, '会话ID'));
  }

  clearSession(raw) {
    const value = plainObject(raw, '清空会话参数');
    if (value.confirmed !== true) fail('CONFIRMATION_REQUIRED', '清空会话需要用户确认');
    return this.database.clearChatSession(id(value.sessionId, '会话ID'));
  }

  getMessages(raw) {
    const value = plainObject(raw, '消息查询参数');
    return this.database.getChatMessages(id(value.sessionId, '会话ID'), integer(value.limit || 200, { name: '消息数量', min: 1, max: 500 }));
  }

  async sendMessage(raw, emit = () => {}) {
    const value = plainObject(raw, '聊天请求');
    const attachments = validateAttachments(value.attachments, value.confirmedAttachments);
    const messageText = optionalText(value.text, { name: '消息', max: 12000 });
    if (!messageText && !attachments.length) fail('VALIDATION_ERROR', '消息或附件至少需要一项');
    return this._send({
      requestId: id(value.requestId, '请求ID'),
      sessionId: id(value.sessionId, '会话ID'),
      text: messageText || '请分析我确认发送的附件内容，并说明结论、风险和需要人工复核的事项。',
      providerId: optionalText(value.providerId, { name: '服务商ID', max: 100 }),
      confirmedContext: null,
      attachments,
    }, emit);
  }

  async confirmAndSend(raw, emit = () => {}) {
    const value = plainObject(raw, '确认分析请求');
    if (value.confirmed !== true) fail('CONFIRMATION_REQUIRED', '历史数据必须先预览并由用户确认');
    const confirmedContext = this.contextBuilder.buildConfirmedAnalysisPayload(id(value.previewId, '预览ID'));
    return this._send({
      requestId: id(value.requestId, '请求ID'),
      sessionId: id(value.sessionId, '会话ID'),
      text: confirmedContext.request.question,
      providerId: optionalText(value.providerId, { name: '服务商ID', max: 100 }),
      confirmedContext,
    }, emit);
  }

  async _send(request, emit) {
    if (!this.database.getSetting('ai_enabled', false)) fail('AI_DISABLED', 'AI总开关当前已关闭');
    const sessions = this.database.listChatSessions();
    const session = sessions.find((item) => item.id === request.sessionId);
    if (!session) fail('NOT_FOUND', '会话不存在');
    const provider = this._requireProvider(request.providerId || session.providerId, true);
    const attachments = request.attachments || [];
    const imageAttachments = attachments.filter((item) => item.kind === 'image');
    if (imageAttachments.length && !['custom-openai', 'mock'].includes(provider.providerId)) {
      fail('ATTACHMENT_UNSUPPORTED', 'DeepSeek当前聊天接口只发送文字。图片请切换到支持视觉的“自定义OpenAI兼容接口”，或先把图片内容转成文字');
    }
    this._enforceUsageLimits();
    const conversation = this.contextBuilder.getRecentConversationContext(request.sessionId);
    const messages = [{ role: 'system', content: FIXED_SYSTEM_PROMPT }];
    if (conversation.summary?.content) messages.push({ role: 'system', content: `以下是用户主动生成的较早对话摘要，仅用于连续对话，不是业务数据库原始结论：\n${conversation.summary.content}` });
    for (const message of conversation.recent) {
      if (message.role === 'user' || message.role === 'assistant') messages.push({ role: message.role, content: message.content });
    }
    let userContent = request.text;
    if (request.confirmedContext) {
      userContent = `以下JSON由本地固定代码从只读历史查询构建，已展示给用户并由用户点击确认发送。你只能分析，不得修改或执行：\n${request.confirmedContext.encoded}\n\n用户问题：${request.text}`;
    }
    const textAttachments = attachments.filter((item) => item.kind === 'text');
    if (textAttachments.length) {
      userContent += `\n\n以下附件由用户在本机选择、预览并确认发送。它们是只读副本，只能用于本次分析：${textAttachments.map((item) => `\n\n--- 附件：${item.name} ---\n${item.text}`).join('')}`;
    }
    const providerUserContent = imageAttachments.length
      ? [{ type: 'text', text: userContent }, ...imageAttachments.map((item) => ({ type: 'image_url', image_url: { url: item.dataUrl, detail: 'auto' } }))]
      : userContent;
    messages.push({ role: 'user', content: providerUserContent });
    const limits = this.database.getSetting('ai_limits', {});
    const tokenSafeMessages = messages.map((message) => ({
      ...message,
      content: Array.isArray(message.content)
        ? message.content.map((part) => part.type === 'image_url' ? { type: 'image_url', image_url: { url: '[用户确认的本地图片]' } } : part)
        : message.content,
    }));
    const estimatedInput = estimateTokens(JSON.stringify(tokenSafeMessages)) + imageAttachments.length * 1200;
    const maxInput = Math.min(Number(limits.maxInputTokens || 12000), Number(provider.maxInputTokens || 12000));
    if (estimatedInput > maxInput) fail('INPUT_TOO_LARGE', `预计输入${estimatedInput} Token，超过${maxInput}上限，请缩小数据范围或生成较早对话摘要`);
    const maxOutput = Math.min(Number(limits.maxOutputTokens || 1200), Number(provider.maxOutputTokens || 1200));

    const storedUserContent = `${request.text}${attachmentSummary(attachments)}`;
    const userMessage = this.database.addChatMessage({ sessionId: request.sessionId, role: 'user', content: storedUserContent, requestStatus: 'complete' });
    const run = this.database.createAnalysisRun({
      sessionId: request.sessionId, userMessageId: userMessage.id, providerId: provider.providerId, modelName: provider.modelName,
      requestStatus: 'pending', contextScope: request.confirmedContext?.payload?.scope || {}, payloadHash: request.confirmedContext?.payloadHash || '',
      snapshotCreatedAt: request.confirmedContext?.payload?.generatedAt || '',
    });
    if (request.confirmedContext) this.database.addContextSources(run.id, request.confirmedContext.sources);

    const controller = new AbortController();
    this.activeRequests.set(request.requestId, controller);
    emit({ requestId: request.requestId, type: 'start', runId: run.id });
    try {
      const result = await this._callProvider(provider, messages, { requestId: request.requestId, controller, maxOutputTokens: maxOutput, emit });
      if (!result.content.trim()) fail('EMPTY_RESPONSE', 'AI返回内容为空');
      const inputTokens = result.inputTokens || estimatedInput;
      const outputTokens = result.outputTokens || estimateTokens(result.content);
      const estimatedCost = this._cost(provider, inputTokens, outputTokens);
      const assistantMessage = this.database.addChatMessage({ sessionId: request.sessionId, role: 'assistant', content: result.content, requestStatus: 'complete', inputTokens, outputTokens, estimatedCost });
      this.database.finishAnalysisRun(run.id, { assistantMessageId: assistantMessage.id, requestStatus: 'complete', inputTokens, outputTokens, estimatedCost });
      this.database.addUsageRecord({ analysisRunId: run.id, providerId: provider.providerId, modelName: provider.modelName, inputTokens, outputTokens, estimatedCost, requestStatus: 'complete' });
      const response = { requestId: request.requestId, runId: run.id, message: assistantMessage, usage: { inputTokens, outputTokens, estimatedCost }, sources: request.confirmedContext?.sources || [] };
      emit({ requestId: request.requestId, type: 'complete', usage: response.usage });
      return response;
    } catch (error) {
      const publicError = safeError(error);
      const status = publicError.code === 'REQUEST_CANCELLED' ? 'cancelled' : 'failed';
      this.database.finishAnalysisRun(run.id, { requestStatus: status, errorType: publicError.code });
      this.database.addUsageRecord({ analysisRunId: run.id, providerId: provider.providerId, modelName: provider.modelName, inputTokens: estimatedInput, outputTokens: 0, estimatedCost: 0, requestStatus: status, errorType: publicError.code });
      emit({ requestId: request.requestId, type: 'error', error: publicError });
      throw error;
    } finally {
      this.activeRequests.delete(request.requestId);
    }
  }

  cancelRequest(requestIdValue) {
    const requestId = id(requestIdValue, '请求ID');
    const controller = this.activeRequests.get(requestId);
    if (!controller) return { ok: false, message: '请求已结束或不存在' };
    controller.abort();
    return { ok: true };
  }

  async summarizeSession(raw, emit = () => {}) {
    const value = plainObject(raw, '摘要请求');
    if (value.confirmed !== true) fail('CONFIRMATION_REQUIRED', '生成对话摘要会调用AI，必须由用户主动确认');
    if (!this.database.getSetting('ai_enabled', false)) fail('AI_DISABLED', 'AI总开关当前已关闭');
    const sessionId = id(value.sessionId, '会话ID');
    const requestId = id(value.requestId, '请求ID');
    const session = this.database.listChatSessions().find((item) => item.id === sessionId);
    if (!session) fail('NOT_FOUND', '会话不存在');
    const provider = this._requireProvider(value.providerId || session.providerId, true);
    const messages = this.database.getChatMessages(sessionId, 500);
    if (messages.length < 8) fail('SUMMARY_NOT_NEEDED', '当前会话较短，暂时不需要摘要');
    const earlier = messages.slice(0, Math.max(1, messages.length - 12));
    const prompt = earlier.map((item) => `${item.role === 'user' ? '用户' : '助手'}：${item.content}`).join('\n\n');
    const controller = new AbortController();
    this.activeRequests.set(requestId, controller);
    try {
      const result = await this._callProvider(provider, [
        { role: 'system', content: `${FIXED_SYSTEM_PROMPT}\n\n本次任务仅对已发生的对话做忠实摘要，不得新增业务事实。` },
        { role: 'user', content: `请把以下较早对话压缩为后续聊天可用的简洁事实摘要，保留结论的不确定性和人工确认要求：\n\n${prompt}` },
      ], { requestId, controller, maxOutputTokens: 800, emit });
      const through = earlier.at(-1);
      const saved = this.database.addConversationSummary({ sessionId, content: result.content, throughMessageId: through?.id || '', messageCount: earlier.length, isAiGenerated: true, providerId: provider.providerId, modelName: provider.modelName });
      return { ok: true, ...saved, content: result.content, messageCount: earlier.length };
    } finally {
      this.activeRequests.delete(requestId);
    }
  }

  listMemories(raw = {}) {
    const value = plainObject(raw, '记忆筛选条件');
    return this.database.listMemories({
      enabled: value.enabled === undefined ? undefined : boolean(value.enabled, '启用状态'),
      countryCode: optionalText(value.countryCode, { name: '国家', max: 10 }),
      storeId: optionalText(value.storeId, { name: '店铺', max: 100 }),
      businessModule: optionalText(value.businessModule, { name: '业务模块', max: 40 }),
    });
  }

  createConfirmedMemory(raw) {
    const data = this._validateMemory(raw);
    if (raw.userConfirmed !== true) fail('CONFIRMATION_REQUIRED', '长期记忆必须由用户编辑或确认后保存');
    return this.database.createConfirmedMemory({ ...data, userConfirmed: true });
  }

  updateMemory(raw) {
    const value = plainObject(raw, '长期记忆');
    const memoryId = id(value.id, '记忆ID');
    return this.database.updateMemory(memoryId, this._validateMemory(value));
  }

  disableMemory(raw) {
    const value = plainObject(raw, '长期记忆状态');
    return this.database.setMemoryEnabled(id(value.id, '记忆ID'), boolean(value.enabled, '启用状态'));
  }

  deleteMemory(raw) {
    const value = plainObject(raw, '删除长期记忆');
    if (value.confirmed !== true) fail('CONFIRMATION_REQUIRED', '删除长期记忆需要用户确认');
    return this.database.deleteMemory(id(value.id, '记忆ID'));
  }

  _validateMemory(raw) {
    const value = plainObject(raw, '长期记忆');
    return {
      title: text(value.title, { name: '记忆标题', min: 1, max: 160 }),
      content: text(value.content, { name: '记忆内容', min: 1, max: 12000 }),
      memoryType: oneOf(value.memoryType || 'business_background', ['sku_rule', 'country_difference', 'store_relation', 'price_control', 'activity_requirement', 'user_preference', 'operation_experience', 'business_background'], '记忆类型'),
      countryCode: optionalText(value.countryCode, { name: '国家', max: 10 }),
      storeId: optionalText(value.storeId, { name: '店铺', max: 100 }),
      businessModule: optionalText(value.businessModule, { name: '业务模块', max: 40 }),
      source: optionalText(value.source || 'user', { name: '来源', max: 160 }),
      aiSuggested: Boolean(value.aiSuggested),
      enabled: value.enabled === undefined ? true : boolean(value.enabled, '启用状态'),
    };
  }

  _requireProvider(providerId, requireEnabled) {
    if (providerId === 'mock') {
      if (!this.allowMock) fail('PROVIDER_NOT_AVAILABLE', '正式版本不提供Mock Provider');
      return this._providersWithStatus().find((item) => item.providerId === 'mock');
    }
    const provider = this.database.getProviderConfigs().find((item) => item.providerId === providerId);
    if (!provider) fail('PROVIDER_NOT_FOUND', 'AI服务商配置不存在');
    if (requireEnabled && !provider.enabled) fail('PROVIDER_DISABLED', '当前AI服务商未启用');
    return provider;
  }

  _enforceUsageLimits() {
    const limits = this.database.getSetting('ai_limits', {});
    const usage = this.database.getUsageSummary();
    if (usage.daily.calls >= Number(limits.dailyCalls || 20)) fail('DAILY_CALL_LIMIT', '已达到单日最大调用次数');
    if (Number(limits.dailyCost || 0) > 0 && usage.daily.cost >= Number(limits.dailyCost)) fail('DAILY_COST_LIMIT', '已达到单日费用限制');
    if (Number(limits.monthlyCost || 0) > 0 && usage.monthly.cost >= Number(limits.monthlyCost)) fail('MONTHLY_COST_LIMIT', '已达到单月费用限制');
  }

  _cost(provider, inputTokens, outputTokens) {
    const limits = this.database.getSetting('ai_limits', {});
    if (limits.costEstimation === false) return 0;
    return (Number(inputTokens || 0) / 1_000_000) * Number(provider.inputCostPerMillion || 0)
      + (Number(outputTokens || 0) / 1_000_000) * Number(provider.outputCostPerMillion || 0);
  }

  async _callProvider(provider, messages, options) {
    if (provider.providerId === 'mock') return this._callMock(options);
    const apiKey = this.credentialStore.getKey(provider.providerId);
    const timeout = setTimeout(() => options.controller.abort(new Error('timeout')), provider.timeoutMs);
    try {
      const endpoint = provider.baseUrl.endsWith('/chat/completions') ? provider.baseUrl : `${provider.baseUrl.replace(/\/+$/, '')}/chat/completions`;
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({ model: provider.modelName, messages, max_tokens: options.maxOutputTokens, stream: Boolean(provider.streamEnabled) }),
        signal: options.controller.signal,
      });
      if (!response.ok) throw await this._httpError(response);
      if (!provider.streamEnabled) {
        const body = await response.json();
        return {
          content: String(body?.choices?.[0]?.message?.content || ''),
          inputTokens: Number(body?.usage?.prompt_tokens || 0),
          outputTokens: Number(body?.usage?.completion_tokens || 0),
        };
      }
      return this._readStream(response, options);
    } catch (error) {
      if (options.controller.signal.aborted) {
        if (options.controller.signal.reason?.message === 'timeout') fail('REQUEST_TIMEOUT', '请求超时，请稍后重试');
        fail('REQUEST_CANCELLED', '请求已取消');
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }

  async _readStream(response, options) {
    if (!response.body) fail('EMPTY_RESPONSE', '服务商未返回响应流');
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let content = '';
    let inputTokens = 0;
    let outputTokens = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() || '';
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('data:')) continue;
        const data = trimmed.slice(5).trim();
        if (!data || data === '[DONE]') continue;
        let event;
        try { event = JSON.parse(data); } catch { continue; }
        const delta = String(event?.choices?.[0]?.delta?.content || '');
        if (delta) {
          content += delta;
          options.emit({ requestId: options.requestId, type: 'chunk', content: delta });
        }
        inputTokens = Number(event?.usage?.prompt_tokens || inputTokens);
        outputTokens = Number(event?.usage?.completion_tokens || outputTokens);
      }
    }
    return { content, inputTokens, outputTokens };
  }

  async _callMock(options) {
    let content = '';
    for (const piece of MOCK_TEXT.match(/.{1,9}/gu) || []) {
      if (options.controller.signal.aborted) fail('REQUEST_CANCELLED', '请求已取消');
      await new Promise((resolve) => setTimeout(resolve, 22));
      content += piece;
      options.emit({ requestId: options.requestId, type: 'chunk', content: piece });
    }
    return { content, inputTokens: 88, outputTokens: estimateTokens(content) };
  }

  async _httpError(response) {
    let message = '';
    try {
      const body = await response.json();
      message = redactSecrets(body?.error?.message || body?.message || '');
    } catch { /* non-JSON provider response */ }
    const code = ({ 400: 'INVALID_REQUEST', 401: 'API_KEY_INVALID', 402: 'INSUFFICIENT_BALANCE', 404: 'MODEL_NOT_FOUND', 408: 'REQUEST_TIMEOUT', 413: 'INPUT_TOO_LARGE', 422: 'INVALID_REQUEST', 429: 'RATE_LIMITED', 500: 'PROVIDER_ERROR', 503: 'PROVIDER_OVERLOADED' })[response.status] || 'PROVIDER_ERROR';
    const fallback = ({ API_KEY_INVALID: 'API Key无效', INSUFFICIENT_BALANCE: 'API余额不足', MODEL_NOT_FOUND: '模型或接口不存在', REQUEST_TIMEOUT: '请求超时', INPUT_TOO_LARGE: '输入内容过大', RATE_LIMITED: '请求过于频繁，已被限流', PROVIDER_OVERLOADED: 'AI服务商当前负载过高', INVALID_REQUEST: 'AI请求参数无效' })[code] || 'AI服务商返回错误';
    return new AppError(code, message ? `${fallback}：${message.slice(0, 300)}` : fallback, { status: response.status });
  }
}

module.exports = { AIService, FIXED_SYSTEM_PROMPT, MOCK_TEXT };
