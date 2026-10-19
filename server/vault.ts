import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { closeSync, constants, existsSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { privateDirectory, privateFile } from './private-files.js';
import { SQLiteStorage, type Storage } from './storage.js';
export { privateDirectory, privateFile } from './private-files.js';

/** Entries are encrypted independently with their key as authenticated context. */
export class Vault {
  private readonly database: Storage;
  private masterKey!: Buffer;
  private readonly ownsDatabase: boolean;
  private readonly initialization: Promise<void>;

  constructor(rootDirectory: string, database?: Storage) {
    const root = privateDirectory(rootDirectory);
    this.ownsDatabase = database === undefined;
    this.database = database ?? new SQLiteStorage(root, true);
    this.initialization = this.initialize(root);
    void this.initialization.catch(() => {});
  }
  private async initialize(root: string): Promise<void> {
    await this.database.ready();
    const keyPath = join(root, 'master.key');
    if (!existsSync(keyPath)) {
      const count = await this.database.get<{ count: number | string }>(`SELECT count(*) AS count FROM ${this.database.table('secrets')}`);
      if (Number(count?.count)) throw new Error('加密密钥缺失，无法读取现有凭据');
      let fd: number | undefined;
      try {
        fd = openSync(keyPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
        writeFileSync(fd, randomBytes(32));
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
      finally { if (fd !== undefined) closeSync(fd); }
    }
    privateFile(keyPath);
    this.masterKey = readFileSync(keyPath);
    if (this.masterKey.length !== 32) throw new Error('加密密钥格式无效');
    const existing = await this.database.get<{ key: string; value: string }>(`SELECT key,value FROM ${this.database.table('secrets')} LIMIT 1`);
    if (existing) this.decrypt(existing.key, existing.value);
  }
  async ready(): Promise<void> { await this.initialization; }
  async has(key: string): Promise<boolean> { await this.ready(); this.validateKey(key); return !!await this.database.get(`SELECT 1 FROM ${this.database.table('secrets')} WHERE key=?`, [key]); }
  async hasPrefix(prefix: string): Promise<boolean> {
    await this.ready();
    if (!/^[A-Za-z0-9:_-]{1,512}$/.test(prefix)) throw new Error('凭据前缀无效');
    const pattern = prefix.replace(/[!%_]/g, character => `!${character}`) + '%';
    return !!await this.database.get(`SELECT 1 FROM ${this.database.table('secrets')} WHERE key LIKE ? ESCAPE '!' LIMIT 1`, [pattern]);
  }
  async get<T = string>(key: string): Promise<T | undefined> {
    await this.ready(); this.validateKey(key);
    const row = await this.database.get<{ value: string }>(`SELECT value FROM ${this.database.table('secrets')} WHERE key=?`, [key]);
    return row ? this.decrypt<T>(key, row.value) : undefined;
  }
  decrypt<T = string>(key: string, encrypted: string): T {
    this.validateKey(key);
    if (!this.masterKey) throw new Error('凭据存储尚未初始化');
    try {
      const entry = JSON.parse(encrypted) as { version: number; iv: string; tag: string; data: string };
      if (entry.version !== 1) throw new Error('version');
      const decipher = createDecipheriv('aes-256-gcm', this.masterKey, Buffer.from(entry.iv, 'base64'));
      decipher.setAAD(Buffer.from(key));
      decipher.setAuthTag(Buffer.from(entry.tag, 'base64'));
      return JSON.parse(Buffer.concat([decipher.update(Buffer.from(entry.data, 'base64')), decipher.final()]).toString('utf8')) as T;
    } catch { throw new Error('凭据无法解密，请检查密钥和备份'); }
  }
  encrypt<T>(key: string, value: T): string {
    this.validateKey(key);
    if (!this.masterKey) throw new Error('凭据存储尚未初始化');
    const json = JSON.stringify(value);
    if (json === undefined || Buffer.byteLength(json) > 32 * 1024 * 1024) throw new Error('凭据内容无效或过大');
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.masterKey, iv);
    cipher.setAAD(Buffer.from(key));
    const data = Buffer.concat([cipher.update(json, 'utf8'), cipher.final()]);
    return JSON.stringify({ version: 1, iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: data.toString('base64') });
  }
  async set<T>(key: string, value: T): Promise<void> {
    await this.ready();
    const encrypted = this.encrypt(key, value);
    await this.database.run(`INSERT INTO ${this.database.table('secrets')} (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`, [key, encrypted]);
  }
  async delete(key: string): Promise<void> { await this.ready(); this.validateKey(key); await this.database.run(`DELETE FROM ${this.database.table('secrets')} WHERE key=?`, [key]); }
  async close(): Promise<void> { await this.initialization.catch(() => {}); if (this.ownsDatabase) await this.database.close(); }
  private validateKey(key: string): void {
    if (!key || key.length > 512 || /[\u0000-\u001f\u007f]/.test(key)) throw new Error('凭据名称无效');
  }
}
