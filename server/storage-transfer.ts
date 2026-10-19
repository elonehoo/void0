import { createHash, timingSafeEqual } from 'node:crypto';
import { backup, DatabaseSync } from 'node:sqlite';
import { execFileSync } from 'node:child_process';
import { chmodSync, constants, copyFileSync, existsSync, lstatSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { privateDirectory } from './private-files.js';
import { PostgreSQLStorage, type Storage, type TableName } from './storage.js';
import { Vault } from './vault.js';

const transferTables = ['projects', 'services', 'servers', 'jobs', 'settings', 'secrets'] as const;
type TransferTable = typeof transferTables[number];
type Row = Record<string, string>;
type Transfer = Record<TransferTable, Row[]>;
export interface SQLiteMigrationOptions { sourceDirectory: string; targetDirectory: string; databaseUrl: string; confirmStopped: boolean }
export interface SQLiteMigrationResult { imported: boolean; counts: Record<TransferTable, number>; sourceDigest: string }
function ordinaryFile(path: string): void {
  if (!existsSync(path) || !lstatSync(path).isFile() || lstatSync(path).isSymbolicLink()) throw new Error('源数据库和密钥必须是已存在的普通文件');
}
function stoppedSource(path: string, confirmed: boolean): void {
  if (!confirmed) throw new Error('迁移前必须停止原 void0，并明确确认已停机');
  try {
    const output = execFileSync('lsof', ['-t', '--', path], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    if (output) throw new Error('源 SQLite 数据库仍由进程使用，请停止原 void0 后重试');
  } catch (error) {
    if ((error as { status?: number }).status === 1) return;
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new Error('无法确认源数据库已停用：请先安装 lsof');
    throw error;
  }
}
function sourceRows(path: string): Transfer {
  const source = new DatabaseSync(path, { readOnly: true });
  try {
    const version = (source.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
    const application = (source.prepare('PRAGMA application_id').get() as { application_id: number }).application_id;
    if (version !== 1 || application !== 1396986443) throw new Error('源文件不是当前版本的 void0 SQLite 数据库');
    const integrity = source.prepare('PRAGMA integrity_check').get() as { integrity_check: string };
    if (integrity.integrity_check !== 'ok') throw new Error('源 SQLite 完整性检查失败');
    const result = {} as Transfer;
    for (const table of transferTables) {
      const key = table === 'settings' || table === 'secrets' ? 'key' : 'id';
      const rows = source.prepare(`SELECT * FROM "${table}" ORDER BY "${key}"`).all();
      result[table] = rows.map(row => {
        if (Object.values(row).some(value => typeof value !== 'string')) throw new Error('源数据库存在无法迁移的记录');
        const value = row as Row;
        if (table !== 'secrets') {
          let parsed: unknown;
          try { parsed = JSON.parse(value.json!); } catch { throw new Error('源数据库存在无效 JSON'); }
          if (table !== 'settings' && (!parsed || typeof parsed !== 'object' || (parsed as { id?: string }).id !== value.id)) throw new Error('源数据库记录 ID 不一致');
          if (table === 'jobs') {
            const job = parsed as { serviceId: string; serverId: string; state: string; createdAt: string };
            if (job.serviceId !== value.service_id || job.serverId !== value.server_id || job.state !== value.state || job.createdAt !== value.created_at) throw new Error('源任务资料与索引不一致');
          }
        }
        return { ...value };
      });
    }
    return result;
  } finally { source.close(); }
}
function digest(rows: Transfer): string {
  // SQL engines can return columns in a different order, so canonicalize explicitly.
  return createHash('sha256').update(JSON.stringify(transferTables.map(table => [table, rows[table].map(row => Object.fromEntries(Object.entries(row).sort(([a], [b]) => a.localeCompare(b))))]))).digest('hex');
}
async function destinationRows(database: Storage): Promise<Transfer> {
  const result = {} as Transfer;
  for (const table of transferTables) {
    const key = table === 'settings' || table === 'secrets' ? 'key' : 'id';
    result[table] = await database.all<Row>(`SELECT * FROM ${database.table(table)} ORDER BY "${key}"`);
  }
  return result;
}
function matchingKey(sourceKey: Buffer, targetPath: string): void {
  ordinaryFile(targetPath);
  const target = readFileSync(targetPath);
  if (target.length !== sourceKey.length || !timingSafeEqual(sourceKey, target)) throw new Error('目标数据目录中的 master.key 与源密钥不同，请使用新的目标目录');
}

/** Explicit offline migration: source is opened read-only and copied through SQLite's consistent backup API. */
export async function migrateSQLiteToPostgreSQL(options: SQLiteMigrationOptions): Promise<SQLiteMigrationResult> {
  const sourceDirectory = resolve(options.sourceDirectory);
  const targetDirectory = resolve(options.targetDirectory);
  if (sourceDirectory === targetDirectory) throw new Error('迁移必须使用新的目标数据目录，保留原 SQLite 和密钥');
  const sourcePath = join(sourceDirectory, 'workspace.sqlite');
  const sourceKeyPath = join(sourceDirectory, 'master.key');
  ordinaryFile(sourcePath); ordinaryFile(sourceKeyPath);
  stoppedSource(sourcePath, options.confirmStopped);
  const sourceKey = readFileSync(sourceKeyPath);
  if (sourceKey.length !== 32) throw new Error('源密钥格式无效');
  const temporary = mkdtempSync(join(tmpdir(), 'serverdesk-sqlite-import-'));
  chmodSync(temporary, 0o700);
  const snapshotPath = join(temporary, 'workspace.sqlite');
  const source = new DatabaseSync(sourcePath, { readOnly: true });
  try { await backup(source, snapshotPath); } finally { source.close(); }
  chmodSync(snapshotPath, 0o600);
  const database = new PostgreSQLStorage(options.databaseUrl);
  try {
    const rows = sourceRows(snapshotPath);
    const sourceDigest = digest(rows);
    const counts = Object.fromEntries(transferTables.map(table => [table, rows[table].length])) as Record<TransferTable, number>;
    await database.ready();
    return await database.transaction(async () => {
      const current = await destinationRows(database);
      const existing = await database.get<{ json: string }>(`SELECT json FROM ${database.table('metadata')} WHERE key='sqliteImport'`);
      if (transferTables.some(table => current[table].length) || existing) {
        if (existing && (JSON.parse(existing.json) as { sourceDigest: string }).sourceDigest === sourceDigest && digest(current) === sourceDigest) {
          matchingKey(sourceKey, join(targetDirectory, 'master.key'));
          return { imported: false, counts, sourceDigest };
        }
        throw new Error('目标 PostgreSQL 已包含数据，导入已取消；不会覆盖已有项目、凭据或设置');
      }
      const target = privateDirectory(targetDirectory);
      const targetKeyPath = join(target, 'master.key');
      if (existsSync(targetKeyPath)) matchingKey(sourceKey, targetKeyPath);
      else copyFileSync(sourceKeyPath, targetKeyPath, constants.COPYFILE_EXCL);
      chmodSync(targetKeyPath, 0o600);
      const vault = new Vault(target, database);
      await vault.ready();
      // Verify every encrypted value before committing any destination row; never export plaintext.
      for (const row of rows.secrets) vault.decrypt(row.key!, row.value!);
      for (const table of transferTables) {
        for (const row of rows[table]) {
          const columns = Object.keys(row);
          const expected = table === 'secrets' ? ['key', 'value'] : table === 'settings' ? ['key', 'json'] : table === 'jobs' ? ['id', 'service_id', 'server_id', 'state', 'created_at', 'json'] : ['id', 'json'];
          if (columns.length !== expected.length || columns.some(column => !expected.includes(column))) throw new Error('源数据库字段不受支持');
          await database.run(`INSERT INTO ${database.table(table)} (${columns.map(column => `"${column}"`).join(',')}) VALUES (${columns.map(() => '?').join(',')})`, columns.map(column => row[column]));
        }
      }
      if (digest(await destinationRows(database)) !== sourceDigest) throw new Error('迁移后数据校验失败，已撤销导入');
      await database.run(`INSERT INTO ${database.table('metadata')}(key,json) VALUES (?,?)`, ['sqliteImport', JSON.stringify({ version: 1, sourceDigest, counts, importedAt: new Date().toISOString() })]);
      return { imported: true, counts, sourceDigest };
    });
  } finally { await database.close(); rmSync(temporary, { recursive: true, force: true }); }
}

/** A local, consistent backup includes the matching key as a separate private file. */
export async function backupSQLite(sourceDirectory: string, backupDirectory: string): Promise<void> {
  const sourceRoot = resolve(sourceDirectory);
  const target = resolve(backupDirectory);
  if (sourceRoot === target || (existsSync(target) && readdirSync(target).length)) throw new Error('备份目录必须为空且不能是当前数据目录');
  const sourcePath = join(sourceRoot, 'workspace.sqlite');
  const sourceKey = join(sourceRoot, 'master.key');
  ordinaryFile(sourcePath); ordinaryFile(sourceKey);
  privateDirectory(target);
  const source = new DatabaseSync(sourcePath, { readOnly: true });
  try { await backup(source, join(target, 'workspace.sqlite')); } finally { source.close(); }
  chmodSync(join(target, 'workspace.sqlite'), 0o600);
  copyFileSync(sourceKey, join(target, 'master.key'), constants.COPYFILE_EXCL);
  chmodSync(join(target, 'master.key'), 0o600);
  sourceRows(join(target, 'workspace.sqlite'));
  writeFileSync(join(target, 'backup.json'), JSON.stringify({ version: 1, kind: 'sqlite', createdAt: new Date().toISOString() }) + '\n', { mode: 0o600, flag: 'wx' });
}
