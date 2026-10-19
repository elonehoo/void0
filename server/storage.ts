import { AsyncLocalStorage } from 'node:async_hooks';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { Pool, type PoolClient, type QueryResultRow } from 'pg';
import { privateFile } from './private-files.js';

/** A temporary connection failure is retryable; never expose driver URLs, credentials, or raw socket messages. */
export class StorageUnavailableError extends Error {
  readonly statusCode = 503;
  readonly code = 'STORAGE_UNAVAILABLE';
  constructor() { super('数据库暂时不可用，请稍后重试'); this.name = 'StorageUnavailableError'; }
}
const connectionCodes = new Set(['57P01', '57P02', '57P03', 'ECONNREFUSED', 'ECONNRESET', 'ECONNABORTED', 'ETIMEDOUT', 'EPIPE', 'ENETUNREACH', 'EHOSTUNREACH', 'ENOTFOUND', 'EAI_AGAIN', 'ERR_SOCKET_CLOSED', 'ERR_STREAM_DESTROYED']);
export function normalizePostgreSQLError(error: unknown): unknown {
  if (error instanceof StorageUnavailableError || !error || typeof error !== 'object') return error;
  const details = error as { code?: unknown; message?: unknown; errors?: unknown[] };
  const code = typeof details.code === 'string' ? details.code : undefined;
  if (code && (code.startsWith('08') || connectionCodes.has(code))) return new StorageUnavailableError();
  // A real SQLSTATE (for example permission, syntax, or constraint errors) takes precedence over its message.
  if (code && /^[0-9A-Z]{5}$/.test(code)) return error;
  if (Array.isArray(details.errors) && details.errors.some(item => normalizePostgreSQLError(item) instanceof StorageUnavailableError)) return new StorageUnavailableError();
  const message = typeof details.message === 'string' ? details.message : '';
  if (/connection (?:terminated(?: unexpectedly| due to connection timeout)?|closed)|terminat(?:ed|ing) connection|timeout exceeded when trying to connect|client has encountered a connection error and is not queryable|cannot use a pool after calling end/i.test(message)) return new StorageUnavailableError();
  return error;
}

export type TableName = 'projects' | 'services' | 'servers' | 'jobs' | 'settings' | 'secrets' | 'metadata';
export interface Storage {
  readonly kind: 'sqlite' | 'postgresql';
  ready(): Promise<void>;
  table(name: TableName): string;
  all<T extends Record<string, unknown> = Record<string, unknown>>(sql: string, values?: unknown[]): Promise<T[]>;
  get<T extends Record<string, unknown> = Record<string, unknown>>(sql: string, values?: unknown[]): Promise<T | undefined>;
  run(sql: string, values?: unknown[]): Promise<void>;
  transaction<T>(operation: () => T | Promise<T>): Promise<T>;
  close(): Promise<void>;
}
const applicationID = 1396986443;
const names: TableName[] = ['projects', 'services', 'servers', 'jobs', 'settings', 'secrets'];
const definitions = [
  'projects (id TEXT PRIMARY KEY NOT NULL,json TEXT NOT NULL)',
  'services (id TEXT PRIMARY KEY NOT NULL,json TEXT NOT NULL)',
  'servers (id TEXT PRIMARY KEY NOT NULL,json TEXT NOT NULL)',
  'jobs (id TEXT PRIMARY KEY NOT NULL,service_id TEXT NOT NULL,server_id TEXT NOT NULL,state TEXT NOT NULL,created_at TEXT NOT NULL,json TEXT NOT NULL)',
  'settings (key TEXT PRIMARY KEY NOT NULL,json TEXT NOT NULL)',
  'secrets (key TEXT PRIMARY KEY NOT NULL,value TEXT NOT NULL)',
];

/** One connection, serialized operations, and async-context scoped transactions. */
export class SQLiteStorage implements Storage {
  readonly kind = 'sqlite';
  private readonly database: DatabaseSync;
  private readonly context = new AsyncLocalStorage<{ active: boolean }>();
  private pending: Promise<void> = Promise.resolve();
  private closed = false;
  constructor(root: string, standaloneVault = false) {
    const path = join(root, standaloneVault ? 'vault.sqlite' : 'workspace.sqlite');
    privateFile(path);
    this.database = new DatabaseSync(path);
    try {
      privateFile(path);
      if (standaloneVault) {
        this.database.exec('PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS secrets (key TEXT PRIMARY KEY NOT NULL,value TEXT NOT NULL)');
      } else {
        const version = (this.database.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
        const marker = (this.database.prepare('PRAGMA application_id').get() as { application_id: number }).application_id;
        const tables = new Set(this.database.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all().map(row => row.name as string));
        if (version > 1) throw new Error('数据版本高于当前程序支持的版本');
        if ((marker !== 0 && marker !== applicationID) || (version === 0 && tables.size > 0) || (version === 1 && !names.filter(name => name !== 'secrets').every(name => tables.has(name)))) throw new Error('目标数据库不是 void0 Web 数据库，请使用新的数据目录');
        this.database.exec('PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;');
        this.database.exec(`BEGIN IMMEDIATE; ${definitions.map(definition => `CREATE TABLE IF NOT EXISTS ${definition};`).join(' ')} CREATE INDEX IF NOT EXISTS jobs_by_service ON jobs(service_id,created_at DESC); PRAGMA user_version=1; PRAGMA application_id=${applicationID}; COMMIT;`);
      }
    } catch (error) { this.database.close(); throw error; }
  }
  async ready(): Promise<void> { if (this.closed) throw new Error('数据库已关闭'); }
  table(name: TableName): string { return `"${name}"`; }
  private async exclusive<T>(operation: () => T | Promise<T>): Promise<T> {
    if (this.context.getStore()?.active) return operation();
    const previous = this.pending;
    let release!: () => void;
    this.pending = new Promise<void>(resolve => { release = resolve; });
    await previous;
    const context = { active: true };
    try { await this.ready(); return await this.context.run(context, operation); } finally { context.active = false; release(); }
  }
  async all<T extends Record<string, unknown>>(sql: string, values: unknown[] = []): Promise<T[]> {
    return this.exclusive(() => this.database.prepare(sql).all(...values as (string | number | null | Uint8Array | bigint)[]) as T[]);
  }
  async get<T extends Record<string, unknown>>(sql: string, values: unknown[] = []): Promise<T | undefined> { return (await this.all<T>(sql, values))[0]; }
  async run(sql: string, values: unknown[] = []): Promise<void> { await this.exclusive(() => { this.database.prepare(sql).run(...values as (string | number | null | Uint8Array | bigint)[]); }); }
  async transaction<T>(operation: () => T | Promise<T>): Promise<T> {
    if (this.context.getStore()?.active) return operation();
    return this.exclusive(async () => {
      this.database.exec('BEGIN IMMEDIATE');
      try { const value = await operation(); this.database.exec('COMMIT'); return value; }
      catch (error) { this.database.exec('ROLLBACK'); throw error; }
    });
  }
  async close(): Promise<void> { if (this.closed) return; await this.exclusive(() => { this.database.close(); this.closed = true; }); }
}

/** All workspace writes commit before resolving. Transaction clients never escape their async context. */
export class PostgreSQLStorage implements Storage {
  readonly kind = 'postgresql';
  private readonly pool: Pool;
  private readonly context = new AsyncLocalStorage<{ client: PoolClient; active: boolean }>();
  private readonly initialization: Promise<void>;
  private closed = false;
  constructor(databaseUrl: string) {
    let parsed: URL;
    try { parsed = new URL(databaseUrl); } catch { throw new Error('PostgreSQL 连接地址无效'); }
    if (!['postgres:', 'postgresql:'].includes(parsed.protocol)) throw new Error('仅支持 PostgreSQL 连接地址');
    this.pool = new Pool({ connectionString: databaseUrl, max: 10, connectionTimeoutMillis: 10000, idleTimeoutMillis: 30000 });
    // Idle network errors must not crash the process or print a credential-bearing connection URL.
    this.pool.on('error', () => {});
    this.initialization = this.initialize().catch(error => { throw normalizePostgreSQLError(error); });
    void this.initialization.catch(() => {});
  }
  table(name: TableName): string { return `"serverdesk"."${name}"`; }
  private async initialize(): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SET LOCAL synchronous_commit=on');
      await client.query('SELECT pg_advisory_xact_lock($1, $2)', [applicationID, 1]);
      const durability = await client.query<{ fsync: string }>('SHOW fsync');
      if (durability.rows[0]?.fsync !== 'on') throw new Error('PostgreSQL 必须启用 fsync 后才能保存部署任务');
      const namespace = await client.query("SELECT 1 FROM pg_namespace WHERE nspname='serverdesk'");
      if (!namespace.rows.length) await client.query('CREATE SCHEMA serverdesk');
      const tables = await client.query<{ table_name: string }>("SELECT table_name FROM information_schema.tables WHERE table_schema='serverdesk' AND table_type='BASE TABLE'");
      const present = new Set(tables.rows.map(row => row.table_name));
      if (present.size) {
        if (!present.has('metadata') || !names.every(name => present.has(name)) || [...present].some(name => ![...names, 'metadata'].includes(name as TableName))) throw new Error('目标 PostgreSQL 的 serverdesk schema 不是 void0 数据库');
        const metadata = await client.query<{ json: string }>(`SELECT json FROM ${this.table('metadata')} WHERE key='schema'`);
        if (!metadata.rows[0]) throw new Error('PostgreSQL 数据版本标记缺失');
        const marker = JSON.parse(metadata.rows[0].json) as { applicationId: number; version: number };
        if (marker.applicationId !== applicationID || marker.version !== 1) throw new Error('PostgreSQL 数据版本不受支持');
      } else {
        for (const definition of definitions) {
          const [name, ...tail] = definition.split(' ');
          await client.query(`CREATE TABLE ${this.table(name as TableName)} ${tail.join(' ')}`);
        }
        await client.query(`CREATE INDEX jobs_by_service ON ${this.table('jobs')}(service_id,created_at DESC)`);
        await client.query(`CREATE TABLE ${this.table('metadata')} (key TEXT PRIMARY KEY NOT NULL,json TEXT NOT NULL)`);
        await client.query(`INSERT INTO ${this.table('metadata')}(key,json) VALUES ('schema',$1)`, [JSON.stringify({ applicationId: applicationID, version: 1 })]);
      }
      await client.query('COMMIT');
    } catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error; }
    finally { client.release(); }
  }
  async ready(): Promise<void> { if (this.closed) throw new Error('数据库已关闭'); await this.initialization; }
  private parameters(sql: string): string { let index = 0; return sql.replace(/\?/g, () => `$${++index}`); }
  async all<T extends Record<string, unknown>>(sql: string, values: unknown[] = []): Promise<T[]> {
    try {
      await this.ready();
      const transaction = this.context.getStore();
      const client = transaction?.active ? transaction.client : undefined;
      const result = client ? await client.query<T & QueryResultRow>(this.parameters(sql), values) : await this.pool.query<T & QueryResultRow>(this.parameters(sql), values);
      return result.rows;
    } catch (error) { throw normalizePostgreSQLError(error); }
  }
  async get<T extends Record<string, unknown>>(sql: string, values: unknown[] = []): Promise<T | undefined> { return (await this.all<T>(sql, values))[0]; }
  async run(sql: string, values: unknown[] = []): Promise<void> {
    if (!this.context.getStore()?.active) { await this.transaction(() => this.run(sql, values)); return; }
    await this.all(sql, values);
  }
  async transaction<T>(operation: () => T | Promise<T>): Promise<T> {
    try {
      await this.ready();
      if (this.context.getStore()?.active) return await operation();
      const client = await this.pool.connect();
      const context = { client, active: true };
      let connectionFailed = false;
      let asynchronousConnectionError: unknown;
      const onConnectionError = (error: unknown) => { connectionFailed = true; asynchronousConnectionError = normalizePostgreSQLError(error); };
      client.on('error', onConnectionError);
      try {
        await client.query('BEGIN');
        await client.query('SET LOCAL synchronous_commit=on');
        // Cross-record validation and mutation share the same lock, even across void0 processes.
        await client.query('SELECT pg_advisory_xact_lock($1, $2)', [applicationID, 1]);
        const value = await this.context.run(context, operation);
        if (asynchronousConnectionError) throw asynchronousConnectionError;
        await client.query('COMMIT');
        return value;
      } catch (error) {
        connectionFailed = normalizePostgreSQLError(error) instanceof StorageUnavailableError;
        await client.query('ROLLBACK').catch(rollbackError => { if (normalizePostgreSQLError(rollbackError) instanceof StorageUnavailableError) connectionFailed = true; });
        throw error;
      } finally { context.active = false; client.removeListener('error', onConnectionError); client.release(connectionFailed); }
    } catch (error) { throw normalizePostgreSQLError(error); }
  }
  async close(): Promise<void> { if (this.closed) return; this.closed = true; await this.initialization.catch(() => {}); await this.pool.end(); }
}
