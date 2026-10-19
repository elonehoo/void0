import { spawn } from 'node:child_process';
import { createHash, timingSafeEqual } from 'node:crypto';
import { chmodSync, closeSync, constants, copyFileSync, existsSync, lstatSync, mkdtempSync, openSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { PostgreSQLStorage } from './storage.js';
import { privateDirectory } from './private-files.js';
import { Vault } from './vault.js';

interface Command { executable: string; arguments?: string[] }
interface BackupOptions { databaseUrl: string; dataDirectory: string; backupDirectory: string; pgDump?: Command }
interface RestoreOptions { databaseUrl: string; backupDirectory: string; dataDirectory: string; confirmStopped: boolean; pgRestore?: Command }
const tables = ['projects', 'services', 'servers', 'jobs', 'settings', 'secrets'] as const;
function ordinaryFile(path: string): void { if (!existsSync(path) || !lstatSync(path).isFile() || lstatSync(path).isSymbolicLink()) throw new Error('备份数据和密钥必须是普通文件'); }
function environment(databaseUrl: string): NodeJS.ProcessEnv {
  const parsed = new URL(databaseUrl);
  if (!['postgres:', 'postgresql:'].includes(parsed.protocol)) throw new Error('PostgreSQL 连接地址无效');
  const env: NodeJS.ProcessEnv = { ...process.env, PGHOST: parsed.hostname, PGPORT: parsed.port || '5432', PGDATABASE: decodeURIComponent(parsed.pathname.slice(1)), PGUSER: decodeURIComponent(parsed.username), PGPASSWORD: decodeURIComponent(parsed.password), PGCONNECT_TIMEOUT: '10' };
  const options: Record<string, string> = { sslmode: 'PGSSLMODE', sslrootcert: 'PGSSLROOTCERT', sslcert: 'PGSSLCERT', sslkey: 'PGSSLKEY', sslcrl: 'PGSSLCRL', channel_binding: 'PGCHANNELBINDING' };
  for (const [key, value] of Object.entries(options)) if (parsed.searchParams.has(key)) env[value] = parsed.searchParams.get(key)!;
  return env;
}
async function run(command: Command, arguments_: string[], databaseUrl: string, output?: number): Promise<void> {
  const parsed = new URL(databaseUrl);
  const secretValues = [databaseUrl, parsed.password, decodeURIComponent(parsed.password)].filter(Boolean);
  await new Promise<void>((resolve_, reject) => {
    const child = spawn(command.executable, [...(command.arguments ?? []), ...arguments_], { env: environment(databaseUrl), stdio: ['ignore', output ?? 'ignore', 'pipe'] });
    let errorText = '';
    child.stderr?.on('data', (chunk: Buffer) => { errorText = (errorText + chunk.toString('utf8')).slice(-8192); });
    child.on('error', error => reject((error as NodeJS.ErrnoException).code === 'ENOENT' ? new Error('请安装与数据库版本匹配的 PostgreSQL 客户端工具（pg_dump / pg_restore）') : error));
    child.on('close', code => {
      if (code === 0) resolve_();
      else {
        for (const secret of secretValues) errorText = errorText.replaceAll(secret, '[redacted]');
        reject(new Error(`PostgreSQL 备份工具失败：${errorText.trim() || `exit ${code}`}`));
      }
    });
  });
}
function fileDigest(path: string): string { return createHash('sha256').update(readFileSync(path)).digest('hex'); }
function prepareKey(source: string, target: string): void {
  ordinaryFile(source);
  const key = readFileSync(source);
  if (key.length !== 32) throw new Error('备份密钥格式无效');
  if (existsSync(target)) {
    ordinaryFile(target); const other = readFileSync(target);
    if (key.length !== other.length || !timingSafeEqual(key, other)) throw new Error('目标目录已有不同的密钥，请使用新的目标数据目录');
  } else copyFileSync(source, target, constants.COPYFILE_EXCL);
  chmodSync(target, 0o600);
}

/** pg_dump provides a consistent online snapshot; the encryption key remains a separate private file. */
export async function backupPostgreSQL(options: BackupOptions): Promise<void> {
  const target = resolve(options.backupDirectory), source = resolve(options.dataDirectory);
  if (source === target || (existsSync(target) && readdirSync(target).length)) throw new Error('备份目录必须为空且不能是当前数据目录');
  ordinaryFile(join(source, 'master.key'));
  privateDirectory(target);
  const database = new PostgreSQLStorage(options.databaseUrl);
  try {
    await database.ready();
    const vault = new Vault(source, database); await vault.ready();
    const dump = join(target, 'database.dump');
    const fd = openSync(dump, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try { await run(options.pgDump ?? { executable: 'pg_dump' }, ['--format=custom', '--no-owner', '--no-privileges', '--schema=serverdesk'], options.databaseUrl, fd); }
    finally { closeSync(fd); }
    prepareKey(join(source, 'master.key'), join(target, 'master.key'));
    writeFileSync(join(target, 'backup.json'), JSON.stringify({ version: 1, kind: 'postgresql', createdAt: new Date().toISOString(), dumpSha256: fileDigest(dump), keySha256: fileDigest(join(target, 'master.key')) }) + '\n', { mode: 0o600, flag: 'wx' });
  } finally { await database.close(); }
}

/** Only an offline empty void0 target may be restored; pg_restore itself is one transaction. */
export async function restorePostgreSQL(options: RestoreOptions): Promise<void> {
  if (!options.confirmStopped) throw new Error('恢复前必须停止目标 void0，并明确确认已停机');
  const source = resolve(options.backupDirectory), target = resolve(options.dataDirectory);
  if (source === target) throw new Error('恢复必须使用单独的数据目录');
  const dump = join(source, 'database.dump'); ordinaryFile(dump); ordinaryFile(join(source, 'backup.json')); ordinaryFile(join(source, 'master.key'));
  const manifest = JSON.parse(readFileSync(join(source, 'backup.json'), 'utf8')) as { version: number; kind: string; dumpSha256: string; keySha256: string };
  if (manifest.version !== 1 || manifest.kind !== 'postgresql' || manifest.dumpSha256 !== fileDigest(dump) || manifest.keySha256 !== fileDigest(join(source, 'master.key'))) throw new Error('PostgreSQL 备份格式或校验值无效');
  const database = new PostgreSQLStorage(options.databaseUrl);
  try {
    await database.ready();
    await database.transaction(async () => {
      const connections = await database.get<{count:string}>("SELECT count(*) AS count FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid() AND backend_type='client backend'");
      if (Number(connections?.count)) throw new Error('恢复目标仍有其他数据库连接，请停止 void0 并关闭其他连接后重试');
      for (const table of tables) {
        const row = await database.get<{ count: string }>(`SELECT count(*) AS count FROM ${database.table(table)}`);
        if (Number(row?.count)) throw new Error('恢复目标已有数据，恢复已取消');
      }
      const metadata = await database.all<{ key: string }>(`SELECT key FROM ${database.table('metadata')}`);
      if (metadata.some(row => row.key !== 'schema')) throw new Error('恢复目标已有导入记录，恢复已取消');
      privateDirectory(target);
      if (existsSync(join(target, 'workspace.sqlite'))) throw new Error('恢复目标目录包含 SQLite，请使用新的数据目录');
      prepareKey(join(source, 'master.key'), join(target, 'master.key'));
    });
  } finally { await database.close(); }
  // Preserve the pre-created schema so restoring needs schema ownership, never CREATE on the database.
  const temporary = mkdtempSync(join(tmpdir(), 'serverdesk-pg-restore-')); chmodSync(temporary, 0o700);
  const listPath = join(temporary, 'restore.list');
  try {
    const fd = openSync(listPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try { await run(options.pgRestore ?? { executable: 'pg_restore' }, ['--list', dump], options.databaseUrl, fd); } finally { closeSync(fd); }
    const list = readFileSync(listPath, 'utf8').split('\n').filter(line => !/^\d+; \d+ \d+ SCHEMA - serverdesk(?: |$)/.test(line)).join('\n');
    writeFileSync(listPath, list, { mode: 0o600 });
    // No password appears in command arguments, process output, or the backup manifest.
    await run(options.pgRestore ?? { executable: 'pg_restore' }, ['--clean', '--if-exists', '--single-transaction', '--exit-on-error', '--no-owner', '--no-privileges', '--use-list', listPath, '--dbname', environment(options.databaseUrl).PGDATABASE!, dump], options.databaseUrl);
  } finally { rmSync(temporary, { recursive: true, force: true }); }
  const restored = new PostgreSQLStorage(options.databaseUrl);
  try {
    await restored.ready();
    const vault = new Vault(target, restored); await vault.ready();
    for (const entry of await restored.all<{ key: string; value: string }>(`SELECT key,value FROM ${restored.table('secrets')}`)) vault.decrypt(entry.key, entry.value);
  } finally { await restored.close(); }
}
