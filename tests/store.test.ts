import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { Job, Project, Server, Service } from '../shared/types.js';
import { importDesktop } from '../server/import-desktop.js';
import { Store } from '../server/store.js';
import { Vault } from '../server/vault.js';
const timestamp = '2026-10-19T12:00:00.000Z';
function server(id: string = randomUUID()): Server { return { id, name: 'Test server', host: '127.0.0.1', port: 22, username: 'ubuntu', group: '', notes: '', createdAt: timestamp, updatedAt: timestamp }; }
function service(serverId: string, id: string = randomUUID()): Service { return { id, name: 'web', kind: 'image', serverId, target: {}, image: 'nginx:alpine', autoDeploy: false, createdAt: timestamp, updatedAt: timestamp }; }
function project(serviceIds: string[], id: string = randomUUID()): Project { return { id, name: 'Business', description: '', serviceIds, createdAt: timestamp, updatedAt: timestamp }; }
function job(value: Service, id: string = randomUUID()): Job { return { id, serviceId: value.id, serverId: value.serverId!, type: 'deploy', source: 'manual', state: 'queued', stage: 'queued', log: '', createdAt: timestamp, updatedAt: timestamp }; }
function fixture(): {
    directory: string;
    store: Store;
    cleanup: () => Promise<void>;
} {
    const directory = mkdtempSync(join(tmpdir(), 'serverdesk-store-'));
    const store = new Store(join(directory, 'data'));
    return { directory, store, cleanup: async () => { await store.close(); rmSync(directory, { recursive: true, force: true }); } };
}
test('groups contain services across servers and providers; moving is explicit and only empty projects can be deleted', async () => {
    const f = fixture();
    try {
        const first = await f.store.saveServer(server());
        const second = await f.store.saveServer(server());
        const a = await f.store.saveService(service(first.id));
        const b = await f.store.saveService(service(second.id));
        const cloud = await f.store.saveService({ ...service(first.id), serverId: undefined, kind: 'vercel', target: { vercelProjectId: 'prj_demo' } });
        const group = await f.store.saveProject(project([a.id, b.id, cloud.id]));
        assert.equal((await f.store.getProject(group.id))?.serviceIds.length, 3);
        const other = await f.store.saveProject(project([]));
        await assert.rejects(async () => await f.store.saveProject({ ...other, serviceIds: [b.id] }), /其他项目/);
        await f.store.moveServices([b.id], other.id);
        assert.deepEqual((await f.store.getProject(other.id))?.serviceIds, [b.id]);
        assert.deepEqual((await f.store.getProject(group.id))?.serviceIds, [a.id, cloud.id]);
        await assert.rejects(() => f.store.removeProject(group.id), /仍包含服务/);
        assert.deepEqual((await f.store.getProject(group.id))?.serviceIds, [a.id, cloud.id]);
        await f.store.moveServices([a.id, cloud.id], other.id);
        await f.store.removeProject(group.id);
        assert.equal(await f.store.getProject(group.id), undefined);
        assert.equal((await f.store.allServices()).length, 3);
        await assert.rejects(async () => await f.store.removeServer(first.id), /关联/);
        await f.store.removeService(a.id);
        assert.equal((await f.store.allServices()).length, 2);
    }
    finally {
        await f.cleanup();
    }
});
test('bad batch rolls back metadata and encrypted environment together', async () => {
    const f = fixture();
    try {
        const target = server();
        const resource = { ...service(target.id), environment: { SECRET_TOKEN: 'never-print-fixture-value' } };
        await assert.rejects(async () => await f.store.importSnapshot({ servers: [target], services: [resource], projects: [project(['missing'])], jobs: [] }), /不存在/);
        assert.equal((await f.store.allServers()).length, 0);
        assert.equal((await f.store.allServices()).length, 0);
        assert.equal(await f.store.vault.has(`environment:${resource.id}`), false);
    }
    finally {
        await f.cleanup();
    }
});
test('environment and integration credentials are encrypted; snapshots and SQLite contain no plaintext', async () => {
    const f = fixture();
    try {
        const target = await f.store.saveServer({ ...server(), password: 'must-not-be-stored' } as Server);
        const resource = await f.store.saveService({ ...service(target.id), environment: { TOKEN: 'fixture-env-plaintext-should-not-exist' } });
        await f.store.vault.set(`ssh:${target.id}`, { password: 'fixture-ssh-secret' });
        await f.store.vault.set('integration:github', { token: 'fixture-github-secret' });
        assert.equal(resource.environment, undefined);
        assert.equal((await f.store.getService(resource.id))?.environment, undefined);
        assert.equal(JSON.stringify(await f.store.snapshot()).includes('fixture-env'), false);
        assert.equal((await f.store.getServer(target.id))?.credentialConfigured, true);
        assert.deepEqual(await f.store.getServiceEnvironment(resource.id), { TOKEN: 'fixture-env-plaintext-should-not-exist' });
        for (const name of readdirSync(f.store.rootDirectory).filter(name => name.startsWith('workspace.sqlite'))) {
            const bytes = readFileSync(join(f.store.rootDirectory, name)).toString('latin1');
            for (const secret of ['fixture-env-plaintext-should-not-exist', 'fixture-ssh-secret', 'fixture-github-secret', 'must-not-be-stored'])
                assert.equal(bytes.includes(secret), false);
        }
        assert.equal(statSync(f.store.rootDirectory).mode & 0o777, 0o700);
        assert.equal(statSync(join(f.store.rootDirectory, 'master.key')).mode & 0o777, 0o600);
        assert.equal(statSync(join(f.store.rootDirectory, 'workspace.sqlite')).mode & 0o777, 0o600);
    }
    finally {
        await f.cleanup();
    }
});
test('credentials reopen; authentication detects tampering and missing keys', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'serverdesk-vault-'));
    try {
        const vault = new Vault(directory);
        await vault.set('token', 'fixture-token');
        await vault.close();
        const reopened = new Vault(directory);
        assert.equal(await reopened.get('token'), 'fixture-token');
        await reopened.close();
        const database = new DatabaseSync(join(directory, 'vault.sqlite'));
        const entry = JSON.parse((database.prepare('SELECT value FROM secrets WHERE key=?').get('token') as {
            value: string;
        }).value);
        entry.data = Buffer.from('tampered').toString('base64');
        database.prepare('UPDATE secrets SET value=?').run(JSON.stringify(entry));
        database.close();
        const tampered = new Vault(directory);
        await assert.rejects(async () => await tampered.get('token'), /解密/);
        await tampered.close();
        rmSync(join(directory, 'master.key'));
        const missing = new Vault(directory); await assert.rejects(missing.ready(), /密钥缺失/); await missing.close();
    }
    finally {
        rmSync(directory, { recursive: true, force: true });
    }
});
test('redirected key and database paths are rejected', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'serverdesk-symlink-'));
    try {
        const real = join(directory, 'real');
        writeFileSync(real, Buffer.alloc(32));
        symlinkSync(real, join(directory, 'master.key'));
        const redirected = new Vault(directory); await assert.rejects(redirected.ready(), /普通文件/); await redirected.close();
    }
    finally {
        rmSync(directory, { recursive: true, force: true });
    }
});
test('jobs survive restart, lock matching resources, and cannot change target', async () => {
    const f = fixture();
    try {
        const target = await f.store.saveServer(server());
        const resource = await f.store.saveService(service(target.id));
        const running = await f.store.enqueue(job(resource));
        await assert.rejects(async () => await f.store.enqueue(job(resource)), /未结束/);
        await assert.rejects(async () => await f.store.removeService(resource.id), /未结束/);
        await assert.rejects(async () => await f.store.saveServer({ ...target, host: '127.0.0.2' }), /未结束/);
        await assert.rejects(async () => await f.store.setServiceEnvironment(resource.id, { TOKEN: 'new' }), /未结束/);
        await assert.rejects(async () => await f.store.updateJob(running.id, { serverId: randomUUID() }), /不存在|目标/);
        await f.store.updateJob(running.id, { state: 'unknown', stage: 'reconnecting' });
        const reopened = new Store(f.store.rootDirectory);
        assert.equal((await reopened.getJob(running.id))?.state, 'unknown');
        await reopened.close();
        await f.store.updateJob(running.id, { state: 'succeeded', finishedAt: timestamp });
        await f.store.removeService(resource.id);
        assert.equal((await f.store.getJob(running.id))?.state, 'succeeded');
    }
    finally {
        await f.cleanup();
    }
});
test('same runtime resource cannot be registered twice and invalid refs fail', async () => {
    const f = fixture();
    try {
        const target = await f.store.saveServer(server());
        const resource = { ...service(target.id), kind: 'compose' as const, target: { composeProject: 'app', composeService: 'web' } };
        await f.store.saveService(resource);
        await assert.rejects(async () => await f.store.saveService({ ...resource, id: randomUUID() }), /重复添加/);
        await assert.rejects(async () => await f.store.saveService({ ...service(target.id), serverId: randomUUID() }), /不存在/);
        await assert.rejects(async () => await f.store.saveService({ ...service(target.id), repository: 'https://token@github.com/owner/repo' }), /不含凭据/);
        await assert.rejects(async () => await f.store.saveService({ ...service(target.id), context: '../outside' }), /构建路径/);
        await assert.rejects(async () => await f.store.saveProject(project([resource.id, resource.id])), /资料无效/);
    }
    finally {
        await f.cleanup();
    }
});
function desktopFixture(directory: string) {
    const workspacePath = join(directory, 'legacy-projects.sqlite');
    const profilesPath = join(directory, 'legacy-profiles.sqlite');
    const workspace = new DatabaseSync(workspacePath);
    const profiles = new DatabaseSync(profilesPath);
    workspace.exec('PRAGMA user_version=5');
    profiles.exec('PRAGMA user_version=1');
    for (const name of ['workspace_projects', 'workspace_services', 'projects', 'vercel_projects', 'deployments', 'auto_deployment_configurations', 'auto_deployment_events'])
        workspace.exec(`CREATE TABLE ${name}(id TEXT PRIMARY KEY,json BLOB NOT NULL)`);
    profiles.exec('CREATE TABLE profiles(id TEXT PRIMARY KEY,json BLOB NOT NULL)');
    const put = (database: DatabaseSync, table: string, value: Record<string, unknown>) => database.prepare(`INSERT INTO ${table}(id,json) VALUES (?,?)`).run(value.id as string, Buffer.from(JSON.stringify(value)));
    const first = server();
    const second = server();
    for (const target of [first, second])
        put(profiles, 'profiles', { ...target, updatedAt: 814579200, isDeleted: false });
    const groups = ['workspace-alpha', 'workspace-beta', 'workspace-gamma', 'workspace-delta', 'workspace-epsilon'];
    const counts = [4, 8, 7, 11, 7];
    const serviceIds: string[] = [];
    const projectIds: string[] = [];
    for (let group = 0; group < groups.length; group++) {
        const members: string[] = [];
        for (let index = 0; index < counts[group]; index++) {
            const id = randomUUID().toUpperCase();
            members.push(id);
            serviceIds.push(id);
            const providerId = `prj_${group}_${index}`;
            let resource: unknown;
            if (group < 2)
                resource = { server: { serverID: first.id, reference: { runtime: 'dockerCompose', group: groups[group], name: `svc-${index}` } } };
            else if (group === 2)
                resource = { server: { serverID: second.id, reference: { runtime: 'kubernetes', group: 'existing-namespace', name: `svc-${index}` } } };
            else {
                resource = { vercel: { projectID: providerId } };
                put(workspace, 'vercel_projects', { id: providerId, name: `site-${index}`, accountID: 'team_fixture', scopeSlug: 'example', scopeName: 'Example' });
            }
            put(workspace, 'workspace_services', { id, name: `service-${group}-${index}`, image: 'example/app:latest', resource });
        }
        const id = randomUUID().toUpperCase();
        projectIds.push(id);
        put(workspace, 'workspace_projects', { id, name: groups[group], serviceIDs: members, updatedAt: 814579200 });
    }
    put(workspace, 'projects', { id: randomUUID(), serverID: first.id, name: 'Original settings', services: [{ id: serviceIds[0], name: 'svc-0', environment: { TOKEN: 'legacy-archive-secret' } }] });
    put(workspace, 'auto_deployment_configurations', { id: serviceIds[0], repositoryURL: 'https://github.com/example/repo', branch: 'main', dockerfilePath: 'Dockerfile', buildContext: '.', enabled: true });
    put(workspace, 'auto_deployment_events', { id: randomUUID(), serviceID: serviceIds[0], startedAt: 814579200, finishedAt: 814579210, state: 'succeeded', stage: 'finished', log: 'legacy-archive-secret' });
    workspace.close();
    profiles.close();
    return { workspacePath, profilesPath, serviceIds, projectIds, serverIds: [first.id, second.id] };
}
test('desktop import keeps five projects, 37 exact IDs, two servers and target mappings; never enables old policies', async () => {
    const f = fixture();
    try {
        const legacy = desktopFixture(f.directory);
        const before = readFileSync(legacy.workspacePath);
        const result = await importDesktop({ ...legacy, store: f.store });
        assert.deepEqual([result.projects, result.services, result.servers], [5, 37, 2]);
        assert.deepEqual([result.importedProjects, result.importedServices, result.importedServers], [5, 37, 2]);
        assert.deepEqual(new Set((await f.store.allServices()).map(item => item.id)), new Set(legacy.serviceIds));
        assert.equal((await f.store.allServices()).filter(item => item.kind === 'compose').length, 12);
        assert.equal((await f.store.allServices()).filter(item => item.kind === 'kubernetes').length, 7);
        assert.equal((await f.store.allServices()).filter(item => item.kind === 'vercel').length, 18);
        assert.equal((await f.store.allServices()).some(item => item.autoDeploy), false);
        assert.equal((await f.store.allServers()).some(item => item.credentialConfigured), false);
        assert.equal((await f.store.getService(legacy.serviceIds[0]))?.repository, 'https://github.com/example/repo');
        assert.equal((await f.store.getService(legacy.serviceIds[0]))?.target.composeProject, 'workspace-alpha');
        assert.equal((await f.store.getService(legacy.serviceIds[12]))?.target.namespace, 'existing-namespace');
        assert.equal((await f.store.allJobs()).length, 1);
        assert.equal((await f.store.allJobs())[0].state, 'succeeded');
        assert.equal(JSON.stringify(await f.store.snapshot()).includes('legacy-archive-secret'), false);
        assert.ok(await f.store.vault.get('desktop:archive'));
        assert.deepEqual(readFileSync(legacy.workspacePath), before);
        const first = (await f.store.getProject(legacy.projectIds[0]))!;
        await f.store.saveProject({ ...first, name: 'Renamed by user' });
        await f.store.moveServices([legacy.serviceIds[0]], legacy.projectIds[1]);
        const second = await importDesktop({ ...legacy, store: f.store });
        assert.equal(second.importedServices, 0);
        assert.equal(second.importedProjects, 0);
        assert.equal((await f.store.getProject(first.id))?.name, 'Renamed by user');
        assert.equal((await f.store.getProject(first.id))?.serviceIds.includes(legacy.serviceIds[0]), false);
    }
    finally {
        await f.cleanup();
    }
});
test('desktop import collision rolls back all destination records', async () => {
    const f = fixture();
    try {
        const legacy = desktopFixture(f.directory);
        const target = await f.store.saveServer(server());
        await f.store.saveService({ ...service(target.id, legacy.serviceIds[0]), kind: 'compose', target: { composeProject: 'different', composeService: 'web' } });
        await assert.rejects(async () => await importDesktop({ ...legacy, store: f.store }), /不一致/);
        assert.equal((await f.store.allServers()).length, 1);
        assert.equal((await f.store.allServices()).length, 1);
        assert.equal((await f.store.allProjects()).length, 0);
    }
    finally {
        await f.cleanup();
    }
});
test('web store rejects a desktop or unrelated SQLite database without adding tables', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'serverdesk-foreign-'));
    try {
        const path = join(directory, 'workspace.sqlite');
        const database = new DatabaseSync(path);
        database.exec('CREATE TABLE profiles(id TEXT PRIMARY KEY,json BLOB); PRAGMA user_version=1');
        database.close();
        assert.throws(() => new Store(directory), /不是 void0 Web/);
        const reopened = new DatabaseSync(path, { readOnly: true });
        assert.deepEqual(reopened.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(row => row.name), ['profiles']);
        await reopened.close();
    }
    finally {
        rmSync(directory, { recursive: true, force: true });
    }
});


test('vault prefix checks include orphaned entries, escape literal underscores, and reveal only a boolean', async () => {
    const f = fixture();
    try {
        await f.store.vault.set('ssh:orphaned-server', { password: 'fixture-private-password' });
        await f.store.vault.set('prefixX:item', 'fixture-value');
        assert.equal(await f.store.vault.hasPrefix('ssh:'), true);
        assert.equal(await f.store.vault.hasPrefix('prefix_:'), false);
        await f.store.vault.set('prefix_:item', 'fixture-value');
        assert.equal(await f.store.vault.hasPrefix('prefix_:'), true);
        await assert.rejects(f.store.vault.hasPrefix('%'), /前缀无效/);
        await assert.rejects(f.store.vault.hasPrefix(''), /前缀无效/);
    } finally { await f.cleanup(); }
});
