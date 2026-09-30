'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { fail, id, text } = require('../lib/validation');

class CredentialStore {
  constructor(safeStorage, directory) {
    this.safeStorage = safeStorage;
    this.directory = path.resolve(directory);
    fs.mkdirSync(this.directory, { recursive: true });
  }

  _ensureAvailable() {
    if (!this.safeStorage?.isEncryptionAvailable?.()) {
      fail('SAFE_STORAGE_UNAVAILABLE', '系统安全存储当前不可用，不能保存或读取API Key');
    }
  }

  _file(providerIdValue) {
    const providerId = id(providerIdValue, '服务商ID');
    return path.join(this.directory, `${providerId}.bin`);
  }

  hasKey(providerIdValue) {
    const file = this._file(providerIdValue);
    if (!fs.existsSync(file)) return { configured: false, masked: '' };
    try {
      const key = this.getKey(providerIdValue);
      return { configured: true, masked: `••••${key.slice(-4)}` };
    } catch {
      return { configured: false, masked: '', error: '密钥无法解密，请重新设置' };
    }
  }

  saveKey(providerIdValue, apiKeyValue) {
    this._ensureAvailable();
    const file = this._file(providerIdValue);
    const apiKey = text(apiKeyValue, { name: 'API Key', min: 8, max: 500, trim: true });
    const encrypted = this.safeStorage.encryptString(apiKey);
    const temporary = `${file}.${crypto.randomUUID()}.tmp`;
    fs.writeFileSync(temporary, encrypted, { flag: 'wx' });
    fs.renameSync(temporary, file);
    return { configured: true, masked: `••••${apiKey.slice(-4)}` };
  }

  getKey(providerIdValue) {
    this._ensureAvailable();
    const file = this._file(providerIdValue);
    if (!fs.existsSync(file)) fail('API_KEY_MISSING', '尚未配置API Key');
    try {
      return this.safeStorage.decryptString(fs.readFileSync(file));
    } catch {
      fail('API_KEY_DECRYPT_FAILED', 'API Key解密失败，请删除后重新设置');
    }
  }

  deleteKey(providerIdValue) {
    const file = this._file(providerIdValue);
    fs.rmSync(file, { force: true });
    return { configured: false, masked: '' };
  }
}

module.exports = { CredentialStore };
