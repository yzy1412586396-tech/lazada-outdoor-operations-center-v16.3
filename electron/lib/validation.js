'use strict';

class AppError extends Error {
  constructor(code, message, details = undefined) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.details = details;
  }
}

function fail(code, message, details) {
  throw new AppError(code, message, details);
}

function plainObject(value, name = '参数') {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail('VALIDATION_ERROR', `${name}格式不正确`);
  }
  return value;
}

function text(value, options = {}) {
  const { name = '文本', min = 0, max = 1000, trim = true } = options;
  if (value === null || value === undefined) value = '';
  if (typeof value !== 'string') fail('VALIDATION_ERROR', `${name}必须是文本`);
  const result = trim ? value.trim() : value;
  if (result.length < min) fail('VALIDATION_ERROR', `${name}不能为空`);
  if (result.length > max) fail('VALIDATION_ERROR', `${name}不能超过${max}个字符`);
  return result;
}

function optionalText(value, options = {}) {
  if (value === null || value === undefined || value === '') return '';
  return text(value, options);
}

function id(value, name = 'ID') {
  const result = text(value, { name, min: 1, max: 100 });
  if (!/^[A-Za-z0-9._:-]+$/.test(result)) fail('VALIDATION_ERROR', `${name}包含无效字符`);
  return result;
}

function boolean(value, name = '开关') {
  if (typeof value !== 'boolean') fail('VALIDATION_ERROR', `${name}必须是布尔值`);
  return value;
}

function integer(value, options = {}) {
  const { name = '数字', min = Number.MIN_SAFE_INTEGER, max = Number.MAX_SAFE_INTEGER } = options;
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result < min || result > max) {
    fail('VALIDATION_ERROR', `${name}必须是${min}到${max}之间的整数`);
  }
  return result;
}

function number(value, options = {}) {
  const { name = '数字', min = -Number.MAX_VALUE, max = Number.MAX_VALUE } = options;
  const result = Number(value);
  if (!Number.isFinite(result) || result < min || result > max) {
    fail('VALIDATION_ERROR', `${name}超出允许范围`);
  }
  return result;
}

function oneOf(value, choices, name = '选项') {
  if (!choices.includes(value)) fail('VALIDATION_ERROR', `${name}无效`);
  return value;
}

function isoDate(value, options = {}) {
  const { name = '日期', allowEmpty = true } = options;
  if ((value === '' || value === null || value === undefined) && allowEmpty) return '';
  const result = text(value, { name, min: 10, max: 10 });
  if (!/^\d{4}-\d{2}-\d{2}$/.test(result) || Number.isNaN(Date.parse(`${result}T00:00:00Z`))) {
    fail('VALIDATION_ERROR', `${name}格式必须为YYYY-MM-DD`);
  }
  return result;
}

function stringArray(value, options = {}) {
  const { name = '列表', maxItems = 50, itemMax = 100 } = options;
  if (!Array.isArray(value)) fail('VALIDATION_ERROR', `${name}必须是数组`);
  if (value.length > maxItems) fail('VALIDATION_ERROR', `${name}最多允许${maxItems}项`);
  return value.map((item, index) => text(item, { name: `${name}第${index + 1}项`, max: itemMax }));
}

function safeError(error) {
  const known = error instanceof AppError;
  const code = known ? error.code : mapErrorCode(error);
  const fallback = known ? error.message : publicMessage(code);
  return { code, message: redactSecrets(fallback), details: known ? error.details : undefined };
}

function mapErrorCode(error) {
  if (error?.name === 'AbortError') return 'REQUEST_CANCELLED';
  const message = String(error?.message || '').toLowerCase();
  if (message.includes('timed out') || message.includes('timeout')) return 'REQUEST_TIMEOUT';
  if (message.includes('database is locked') || message.includes('busy')) return 'DATABASE_BUSY';
  if (message.includes('sqlite') || message.includes('database')) return 'DATABASE_ERROR';
  if (message.includes('fetch') || message.includes('network')) return 'NETWORK_ERROR';
  return 'UNKNOWN_ERROR';
}

function publicMessage(code) {
  return ({
    REQUEST_CANCELLED: '请求已取消',
    REQUEST_TIMEOUT: '请求超时，请稍后重试',
    DATABASE_BUSY: '数据库正被占用，请稍后重试',
    DATABASE_ERROR: '本地数据库操作失败',
    NETWORK_ERROR: '网络连接失败',
    UNKNOWN_ERROR: '操作失败，请查看本地错误日志',
  })[code] || '操作失败';
}

function redactSecrets(value) {
  return String(value || '')
    .replace(/(api[-_ ]?key|authorization|bearer)\s*[:=]?\s*[^\s,;]+/gi, '$1=[已隐藏]')
    .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, 'sk-[已隐藏]');
}

module.exports = {
  AppError,
  fail,
  plainObject,
  text,
  optionalText,
  id,
  boolean,
  integer,
  number,
  oneOf,
  isoDate,
  stringArray,
  safeError,
  redactSecrets,
};
