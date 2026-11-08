import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from 'node:crypto';
import { normalizeBaseUrl, validateKey } from './gateway.js';

export const vaultError = (message, status = 400) => Object.assign(new Error(message), { status });
export const MODEL_PROTOCOLS = Object.freeze(['chat-completions', 'anthropic', 'responses']);
const text = (value, label, max = 80) => {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > max || /[\r\n]/.test(value)) throw vaultError(`${label}格式无效`);
  return value.trim();
};
const publicCredential = row => Object.fromEntries(['id', 'name', 'provider', 'baseUrl', 'protocol', 'keyHint', 'version'].map(field => [field, row[field]]).concat([['hasKey', true]]));

export class CredentialVault {
  #masterKey;
  constructor({ store, ownerId = 'local', masterKey = process.env.DATAAGENT_CREDENTIAL_MASTER_KEY }) {
    this.store = store; this.ownerId = String(ownerId); this.configKey = `credential-vault-v1:${this.ownerId}`;
    const valid = Buffer.isBuffer(masterKey) ? masterKey.length === 32 : typeof masterKey === 'string' && /^[A-Za-z0-9+/]{43}=$/.test(masterKey) && Buffer.from(masterKey, 'base64').length === 32;
    this.#masterKey = valid ? Buffer.from(masterKey, Buffer.isBuffer(masterKey) ? undefined : 'base64') : null;
    this.reason = valid ? null : masterKey ? '部署主密钥格式无效，持久凭据库已禁用；需提供32字节base64主密钥。' : '未配置部署主密钥，持久凭据库已禁用；仍可使用旧会话Key模式。';
  }
  status() { return { enabled: Boolean(this.#masterKey), available: Boolean(this.#masterKey), reason: this.reason, keyVersion: 1 }; }
  #requireKey() { if (!this.#masterKey) throw vaultError(this.reason, 503); }
  #rows() { return this.store.config(this.configKey) || []; }
  #row(id) { const row = this.#rows().find(row => row.id === id); if (!row) throw vaultError('凭据不存在或已删除', 404); return row; }
  #aad(row) { return Buffer.from(JSON.stringify([this.ownerId, row.id, row.baseUrl, row.protocol, row.version, row.encrypted.keyVersion])); }
  list() { return this.#rows().map(publicCredential); }
  get(id) { return publicCredential(this.#row(id)); }
  create(input = {}) {
    this.#requireKey();
    if (this.#rows().length >= 100) throw vaultError('每个账号最多保存100个凭据', 429);
    const row = this.#write({ id: randomUUID(), version: 0 }, input);
    this.store.config(this.configKey, [...this.#rows(), row]); return publicCredential(row);
  }
  update(id, input = {}) {
    this.#requireKey(); const row = this.#write(this.#row(id), input);
    this.store.config(this.configKey, this.#rows().map(previous => previous.id === id ? row : previous)); return publicCredential(row);
  }
  #write(previous, input) {
    const name = text(input.name ?? previous.name, '凭据名称');
    const provider = text(input.provider ?? previous.provider ?? 'OpenAI 兼容', '供应商');
    let baseUrl; try { baseUrl = normalizeBaseUrl(input.baseUrl ?? previous.baseUrl); } catch (error) { throw vaultError(error.message); }
    const protocol = input.protocol ?? previous.protocol ?? (new URL(baseUrl).hostname === 'api.anthropic.com' ? 'anthropic' : 'chat-completions');
    if (!MODEL_PROTOCOLS.includes(protocol)) throw vaultError('模型协议无效');
    const supplied = input.apiKey ?? input.key;
    let key; try { key = supplied === undefined || supplied === '' ? '' : validateKey(supplied); } catch (error) { throw vaultError(error.message); }
    if (!key && previous.version && (baseUrl !== previous.baseUrl || protocol !== previous.protocol)) throw vaultError('更换接口地址或协议后请重新输入对应的API Key');
    if (!key && previous.version) key = this.decrypt(previous.id);
    if (!key) throw vaultError('请输入API Key');
    const row = { id: previous.id, name, provider, baseUrl, protocol, version: previous.version + 1, keyHint: key.length > 8 ? key.slice(-4) : '****', encrypted: { keyVersion: 1 } };
    const nonce = randomBytes(12), cipher = createCipheriv('aes-256-gcm', this.#masterKey, nonce);
    cipher.setAAD(this.#aad(row));
    const ciphertext = Buffer.concat([cipher.update(key, 'utf8'), cipher.final()]);
    Object.assign(row.encrypted, { nonce: nonce.toString('base64'), tag: cipher.getAuthTag().toString('base64'), ciphertext: ciphertext.toString('base64') });
    return row;
  }
  decrypt(id, version) {
    this.#requireKey(); const row = this.#row(id);
    if (version !== undefined && row.version !== version) throw vaultError('凭据版本已变更，请重新创建任务', 409);
    try {
      if (row.encrypted.keyVersion !== 1) throw new Error('version');
      const decipher = createDecipheriv('aes-256-gcm', this.#masterKey, Buffer.from(row.encrypted.nonce, 'base64'));
      decipher.setAAD(this.#aad(row)); decipher.setAuthTag(Buffer.from(row.encrypted.tag, 'base64'));
      return Buffer.concat([decipher.update(Buffer.from(row.encrypted.ciphertext, 'base64')), decipher.final()]).toString('utf8');
    } catch { throw vaultError('无法解密该凭据，请检查部署主密钥及备份，或重新保存Key。', 503); }
  }
  delete(id) { this.#row(id); this.store.config(this.configKey, this.#rows().filter(row => row.id !== id)); }
}
