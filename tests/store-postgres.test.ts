import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { Pool } from 'pg';
import { backupPostgreSQL, restorePostgreSQL } from '../server/postgres-backup.js';
import type { Job, Server, Service } from '../shared/types.js';
import { Store } from '../server/store.js';
import { PostgreSQLStorage, StorageUnavailableError } from '../server/storage.js';
import { backupSQLite, migrateSQLiteToPostgreSQL } from '../server/storage-transfer.js';

const testUrl = (process.env.VOID0_TEST_POSTGRES_URL??process.env.SERVERDESK_TEST_POSTGRES_URL);
const timestamp = '2026-10-19T12:00:00.000Z';
const server = (): Server => ({ id: randomUUID(), name: 'Test host', host: '127.0.0.1', port: 22, username: 'ubuntu', group: '', notes: '', createdAt: timestamp, updatedAt: timestamp });
const service = (serverId: string): Service => ({ id: randomUUID(), name: 'web', kind: 'image', serverId, target: {}, image: 'nginx:alpine', environment: { TOKEN: 'pg-test-env-never-plaintext' }, autoDeploy: false, createdAt: timestamp, updatedAt: timestamp });
const job = (value: Service): Job => ({ id: randomUUID(), serviceId: value.id, serverId: value.serverId!, type: 'deploy', source: 'manual', state: 'queued', stage: 'queued', log: '', createdAt: timestamp, updatedAt: timestamp });
async function fixture() {
  assert.ok(testUrl);
  const parsed = new URL(testUrl);
  if (!parsed.pathname.slice(1).startsWith('serverdesk_test')) throw new Error('PG 测试仅允许使用名称以 serverdesk_test 开头的专用测试数据库');
  const administrator = new Pool({ connectionString: testUrl });
  const name = `serverdesk_test_${randomUUID().replaceAll('-', '')}`;
  await administrator.query(`CREATE DATABASE "${name}"`);
  parsed.pathname = `/${name}`;
  const databaseUrl = parsed.toString();
  const directory = mkdtempSync(join(tmpdir(), 'serverdesk-pg-'));
  const store = new Store(join(directory, 'target'), { databaseUrl });
  await store.ready();
  const inspect = new Pool({ connectionString: databaseUrl });
  return { directory, databaseUrl, store, inspect, async cleanup() {
    await store.close(); await inspect.end();
    await administrator.query(`DROP DATABASE "${name}"`); await administrator.end();
    rmSync(directory, { recursive: true, force: true });
  } };
}

test('PostgreSQL writes survive reconnect and keep encrypted credentials outside public records', { skip: !testUrl }, async () => {
  const f = await fixture();
  try {
    const target = await f.store.saveServer(server());
    const resource = await f.store.saveService(service(target.id));
    await f.store.vault.set(`ssh:${target.id}`, { password: 'pg-test-ssh-never-plaintext' });
    assert.equal(await f.store.vault.hasPrefix('ssh:'), true);
    assert.equal(await f.store.vault.hasPrefix('missing_:'), false);
    await f.store.setSetting('test', { version: 1 });
    await f.store.enqueue(job(resource));
    const reopened = new Store(f.store.rootDirectory, { databaseUrl: f.databaseUrl });
    try {
      await reopened.ready();
      assert.equal((await reopened.getServer(target.id))?.credentialConfigured, true);
      assert.deepEqual(await reopened.getServiceEnvironment(resource.id), { TOKEN: 'pg-test-env-never-plaintext' });
      assert.deepEqual(await reopened.getSetting('test'), { version: 1 });
      assert.equal((await reopened.allJobs()).length, 1);
      const rows = await f.inspect.query('SELECT value FROM serverdesk.secrets');
      assert.equal(JSON.stringify(rows.rows).includes('pg-test-'), false);
      assert.equal(JSON.stringify(await reopened.snapshot()).includes('pg-test-'), false);
      const tables = await f.inspect.query("SELECT table_name FROM information_schema.tables WHERE table_schema='serverdesk'");
      assert.ok(!JSON.stringify(tables.rows).includes('master'));
      assert.equal(readFileSync(join(f.store.rootDirectory, 'master.key')).length, 32);
    } finally { await reopened.close(); }
  } finally { await f.cleanup(); }
});

test('PostgreSQL validation and encrypted metadata rollback share one transaction; concurrent jobs remain exclusive', { skip: !testUrl }, async () => {
  const f = await fixture();
  try {
    const target = server(); const resource = service(target.id);
    await assert.rejects(f.store.importSnapshot({ servers: [target], services: [resource], projects: [{ id: randomUUID(), name: 'Invalid', description: '', serviceIds: ['missing'], createdAt: timestamp, updatedAt: timestamp }], jobs: [] }), /不存在/);
    assert.equal((await f.store.allServers()).length, 0);
    assert.equal(await f.store.vault.has(`environment:${resource.id}`), false);
    await f.store.saveServer(target); await f.store.saveService(resource);
    const other = new Store(f.store.rootDirectory, { databaseUrl: f.databaseUrl });
    try {
      await other.ready();
      const outcomes = await Promise.allSettled([f.store.enqueue(job(resource)), other.enqueue(job(resource))]);
      assert.deepEqual(outcomes.map(value => value.status).sort(), ['fulfilled', 'rejected']);
      assert.equal((await f.store.allJobs()).length, 1);
      await assert.rejects(other.setServiceEnvironment(resource.id, { TOKEN: 'changed' }), /未结束/);
    } finally { await other.close(); }
  } finally { await f.cleanup(); }
});

test('PostgreSQL unrelated concurrent operations cannot join or be rolled back with another async transaction', { skip: !testUrl }, async () => {
  const f = await fixture();
  try {
    let release!: () => void; let entered!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const start = new Promise<void>(resolve => { entered = resolve; });
    const failing = f.store.transaction(async () => {
      await f.store.setSetting('rolled-back', 1);
      await f.store.transaction(async () => { await f.store.vault.set('rolled-back-secret', 'secret'); });
      entered(); await gate; throw new Error('intentional rollback');
    });
    await start;
    const independent = f.store.setSetting('committed', 2);
    release();
    await assert.rejects(failing, /intentional rollback/); await independent;
    assert.equal(await f.store.getSetting('rolled-back'), undefined);
    assert.equal(await f.store.vault.has('rolled-back-secret'), false);
    assert.equal(await f.store.getSetting('committed'), 2);
  } finally { await f.cleanup(); }
});

test('offline SQLite import preserves exact encrypted rows, jobs, settings and key; reruns are safe', { skip: !testUrl }, async () => {
  const f = await fixture();
  try {
    const sourceDirectory = join(f.directory, 'source');
    const source = new Store(sourceDirectory); await source.ready();
    const target = await source.saveServer(server()); const resource = await source.saveService(service(target.id));
    await source.saveProject({ id: randomUUID(), name: 'Imported', description: '', serviceIds: [resource.id], createdAt: timestamp, updatedAt: timestamp });
    const task = await source.enqueue(job(resource)); await source.updateJob(task.id, { state: 'succeeded', finishedAt: timestamp });
    await source.vault.set('integration:github', { token: 'pg-import-fixture-token' });
    await source.vault.set('auth:session:fixture', { csrf: 'fixture-csrf', expiresAt: timestamp });
    await source.vault.set(`jobLog:${task.id}`, 'pg-import-encrypted-log');
    await source.setSetting('agent:state', { id: 'fixture-agent', tokenHash: 'fixture-hash' });
    await source.close();
    const original = readFileSync(join(sourceDirectory, 'workspace.sqlite'));
    const originalKey = readFileSync(join(sourceDirectory, 'master.key'));
    // The fixture's freshly created target key is deliberately discarded so migration copies the source key.
    rmSync(join(f.store.rootDirectory, 'master.key'));
    const result = await migrateSQLiteToPostgreSQL({ sourceDirectory, targetDirectory: f.store.rootDirectory, databaseUrl: f.databaseUrl, confirmStopped: true });
    assert.equal(result.imported, true); assert.equal(result.counts.jobs, 1); assert.equal(result.counts.secrets, 4);
    const reopened = new Store(f.store.rootDirectory, { databaseUrl: f.databaseUrl });
    try {
      await reopened.ready();
      assert.deepEqual(await reopened.getServiceEnvironment(resource.id), { TOKEN: 'pg-test-env-never-plaintext' });
      assert.deepEqual(await reopened.vault.get('integration:github'), { token: 'pg-import-fixture-token' });
      assert.equal(await reopened.vault.get(`jobLog:${task.id}`), 'pg-import-encrypted-log');
      assert.deepEqual(await reopened.getSetting('agent:state'), { id: 'fixture-agent', tokenHash: 'fixture-hash' });
      const sourceDb = new DatabaseSync(join(sourceDirectory, 'workspace.sqlite'), { readOnly: true });
      try {
        const before = sourceDb.prepare('SELECT key,value FROM secrets ORDER BY key').all();
        const after = (await f.inspect.query('SELECT key,value FROM serverdesk.secrets ORDER BY key')).rows;
        assert.deepEqual(JSON.parse(JSON.stringify(before)), after);
      } finally { sourceDb.close(); }
      const repeat = await migrateSQLiteToPostgreSQL({ sourceDirectory, targetDirectory: f.store.rootDirectory, databaseUrl: f.databaseUrl, confirmStopped: true });
      assert.equal(repeat.imported, false);
      await reopened.setSetting('later-edit', true);
      await assert.rejects(migrateSQLiteToPostgreSQL({ sourceDirectory, targetDirectory: f.store.rootDirectory, databaseUrl: f.databaseUrl, confirmStopped: true }), /已包含数据/);
    } finally { await reopened.close(); }
    assert.deepEqual(readFileSync(join(sourceDirectory, 'workspace.sqlite')), original);
    assert.deepEqual(readFileSync(join(sourceDirectory, 'master.key')), originalKey);
    assert.deepEqual(readFileSync(join(f.store.rootDirectory, 'master.key')), originalKey);
  } finally { await f.cleanup(); }
});

test('SQLite backup can be reopened with the matching key; import refuses running source and nonempty destination', { skip: !testUrl }, async () => {
  const f = await fixture();
  const sourceDirectory = join(f.directory, 'source');
  const source = new Store(sourceDirectory); await source.ready();
  try {
    const target = await source.saveServer(server()); const resource = await source.saveService(service(target.id));
    await backupSQLite(sourceDirectory, join(f.directory, 'backup'));
    const restored = new Store(join(f.directory, 'backup'));
    try { assert.deepEqual(await restored.getServiceEnvironment(resource.id), { TOKEN: 'pg-test-env-never-plaintext' }); } finally { await restored.close(); }
    await assert.rejects(migrateSQLiteToPostgreSQL({ sourceDirectory, targetDirectory: f.store.rootDirectory, databaseUrl: f.databaseUrl, confirmStopped: true }), /仍由进程使用/);
    await source.close();
    await f.store.saveServer(server());
    await assert.rejects(migrateSQLiteToPostgreSQL({ sourceDirectory, targetDirectory: join(f.directory, 'unused'), databaseUrl: f.databaseUrl, confirmStopped: true }), /已包含数据/);
  } finally { await source.close(); await f.cleanup(); }
});

test('PostgreSQL rejects missing or mismatched local encryption keys', { skip: !testUrl }, async () => {
  const f = await fixture();
  try {
    await f.store.vault.set('fixture-secret', 'fixture-value');
    const missing = new Store(join(f.directory, 'missing'), { databaseUrl: f.databaseUrl });
    try { await assert.rejects(missing.ready(), /密钥缺失/); } finally { await missing.close(); }
    const wrongSource = new Store(join(f.directory, 'wrong')); await wrongSource.ready(); await wrongSource.close();
    const wrong = new Store(join(f.directory, 'wrong'), { databaseUrl: f.databaseUrl });
    try { await assert.rejects(wrong.ready(), /解密/); } finally { await wrong.close(); }
  } finally { await f.cleanup(); }
});


test('PostgreSQL consistent backup restores a complete Store and refuses a nonempty destination', { skip: !testUrl || !(process.env.VOID0_TEST_PG_CONTAINER??process.env.SERVERDESK_TEST_PG_CONTAINER) }, async () => {
  const source = await fixture(); const target = await fixture();
  try {
    const host = await source.store.saveServer(server()); const resource = await source.store.saveService(service(host.id));
    await source.store.saveProject({ id: randomUUID(), name: 'Backup group', description: '', serviceIds: [resource.id], createdAt: timestamp, updatedAt: timestamp });
    const task = await source.store.enqueue(job(resource)); await source.store.updateJob(task.id, { state: 'succeeded', finishedAt: timestamp });
    await source.store.vault.set('integration:github', { token: 'backup-private-token' });
    await source.store.setSetting('agent:fixture', { connected: true });
    const wrapper = join(source.directory, 'pg-client-wrapper.sh');
    writeFileSync(wrapper, `#!/bin/bash
set -euo pipefail
operation="$1"
shift
container="\${VOID0_TEST_PG_CONTAINER:-\${SERVERDESK_TEST_PG_CONTAINER:-}}"
if [ "$operation" = pg_restore ]; then
  dump="\${!#}"
  set -- "\${@:1:$#-1}"
  arguments=("$@")
  remote_list="/tmp/serverdesk-restore-list-$$"
  for ((index=0;index<\${#arguments[@]};index++)); do
    if [ "\${arguments[index]}" = --use-list ]; then
      docker cp "\${arguments[index+1]}" "$container:$remote_list" >/dev/null
      arguments[index+1]="$remote_list"
      trap 'docker exec "$container" rm -f "$remote_list" >/dev/null' EXIT
    fi
  done
  docker exec -i --env PGHOST=127.0.0.1 --env PGPORT=5432 --env PGDATABASE --env PGUSER --env PGPASSWORD "$container" pg_restore "\${arguments[@]}" < "$dump"
  exit $?
fi
exec docker exec --env PGHOST=127.0.0.1 --env PGPORT=5432 --env PGDATABASE --env PGUSER --env PGPASSWORD "$container" pg_dump "$@"
`, { mode: 0o700 });
    const backupDirectory = join(source.directory, 'backup');
    await backupPostgreSQL({ databaseUrl: source.databaseUrl, dataDirectory: source.store.rootDirectory, backupDirectory, pgDump: { executable: wrapper, arguments: ['pg_dump'] } });
    assert.equal(readFileSync(join(backupDirectory, 'database.dump')).subarray(0, 5).toString(), 'PGDMP');
    assert.equal(readFileSync(join(backupDirectory, 'backup.json'), 'utf8').includes('password'), false);
    rmSync(join(target.store.rootDirectory, 'master.key'));
    await target.store.close();
    await restorePostgreSQL({ databaseUrl: target.databaseUrl, backupDirectory, dataDirectory: target.store.rootDirectory, confirmStopped: true, pgRestore: { executable: wrapper, arguments: ['pg_restore'] } });
    const restored = new Store(target.store.rootDirectory, { databaseUrl: target.databaseUrl });
    try {
      await restored.ready();
      assert.deepEqual(await restored.snapshot(), await source.store.snapshot());
      assert.deepEqual(await restored.vault.get('integration:github'), { token: 'backup-private-token' });
      assert.deepEqual(await restored.getServiceEnvironment(resource.id), { TOKEN: 'pg-test-env-never-plaintext' });
      assert.deepEqual(await restored.getSetting('agent:fixture'), { connected: true });
      await restored.close();
      await assert.rejects(restorePostgreSQL({ databaseUrl: target.databaseUrl, backupDirectory, dataDirectory: target.store.rootDirectory, confirmStopped: true, pgRestore: { executable: wrapper, arguments: ['pg_restore'] } }), /已有数据/);
    } finally { await restored.close(); }
  } finally { await target.cleanup(); await source.cleanup(); }
});

test('PostgreSQL starts and writes with a schema owner that has no database creation or superuser permission', { skip: !testUrl }, async () => {
  const f = await fixture();
  const role = `serverdesk_app_${randomUUID().replaceAll('-', '')}`;
  let application: Store | undefined;
  const administrator = new Pool({ connectionString: testUrl });
  try {
    await f.store.close();
    await administrator.query(`CREATE ROLE "${role}" LOGIN PASSWORD 'local-permission-fixture' NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION`);
    await f.inspect.query('DROP SCHEMA serverdesk CASCADE');
    await f.inspect.query(`CREATE SCHEMA serverdesk AUTHORIZATION "${role}"`);
    const parsed = new URL(f.databaseUrl); parsed.username = role; parsed.password = 'local-permission-fixture';
    application = new Store(join(f.directory, 'restricted'), { databaseUrl: parsed.toString() });
    await application.ready();
    await application.saveServer(server());
    await application.vault.set('restricted-token', 'private-fixture');
    await application.setSetting('restricted-setting', true);
    assert.equal((await application.allServers()).length, 1);
    assert.equal(await application.vault.get('restricted-token'), 'private-fixture');
    const privileges = await f.inspect.query<{rolsuper:boolean;rolcreatedb:boolean;rolcreaterole:boolean}>('SELECT rolsuper,rolcreatedb,rolcreaterole FROM pg_roles WHERE rolname=$1', [role]);
    assert.deepEqual(privileges.rows[0], { rolsuper: false, rolcreatedb: false, rolcreaterole: false });
  } finally {
    await application?.close(); await f.cleanup();
    await administrator.query(`DROP ROLE IF EXISTS "${role}"`); await administrator.end();
  }
});


test('terminated PostgreSQL read and transaction connections return 503 and the same Store recovers', { skip: !testUrl }, async () => {
  const f = await fixture();
  let readStorage: PostgreSQLStorage | undefined;
  try {
    await f.store.setSetting('before-outage', 'preserved');
    let entered!: () => void, release!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    const transaction = f.store.transaction(async () => {
      await f.store.setSetting('interrupted-write', 'must-roll-back');
      entered(); await gate;
      await f.store.setSetting('after-interruption', 'must-not-commit');
    });
    const failed = assert.rejects(transaction, (error: unknown) => error instanceof StorageUnavailableError && error.statusCode === 503);
    await started;
    const owner = await f.inspect.query<{pid:number}>("SELECT pid FROM pg_locks WHERE locktype='advisory' AND classid=1396986443 AND objid=1 AND database=(SELECT oid FROM pg_database WHERE datname=current_database()) AND granted");
    assert.equal(owner.rows.length, 1);
    await f.inspect.query('SELECT pg_terminate_backend($1)', [owner.rows[0]!.pid]);
    await new Promise(resolve => setTimeout(resolve, 25));
    release(); await failed;
    assert.equal(await f.store.getSetting('interrupted-write'), undefined);
    assert.equal(await f.store.getSetting('after-interruption'), undefined);
    assert.equal(await f.store.getSetting('before-outage'), 'preserved');
    await f.store.setSetting('recovered-write', true);
    assert.equal(await f.store.getSetting('recovered-write'), true);

    const parsed = new URL(f.databaseUrl); parsed.searchParams.set('application_name', 'serverdesk-outage-read');
    readStorage = new PostgreSQLStorage(parsed.toString()); await readStorage.ready();
    const reading = assert.rejects(readStorage.all('SELECT pg_sleep(10)'), StorageUnavailableError);
    let reader: number | undefined;
    for (let count = 0; count < 50; count++) {
      const active = await f.inspect.query<{pid:number}>("SELECT pid FROM pg_stat_activity WHERE datname=current_database() AND application_name='serverdesk-outage-read' AND wait_event='PgSleep'");
      reader = active.rows[0]?.pid; if (reader) break;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.ok(reader); await f.inspect.query('SELECT pg_terminate_backend($1)', [reader]); await reading;
    assert.equal((await readStorage.all<{value:number}>('SELECT 1 AS value'))[0]?.value, 1);
    assert.equal(await f.store.getSetting('before-outage'), 'preserved');
  } finally { await readStorage?.close(); await f.cleanup(); }
});
