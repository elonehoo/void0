import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import Fastify from 'fastify';
import { z } from 'zod';
import { registerConnectionRoutes, type ConnectionStatus } from '../server/connection-routes.js';
import { Store } from '../server/store.js';

async function fixture(publisherConfigured = false) {
  const directory = mkdtempSync(join(tmpdir(), 'void0-connections-'));
  const store = new Store(directory);
  await store.ready();
  const app = Fastify();
  app.setErrorHandler((error, _req, reply) => reply.code(400).send({ error: error instanceof z.ZodError ? '输入格式错误。' : (error as Error).message }));
  registerConnectionRoutes(app, { store, publisherConfigured });
  const originalFetch = globalThis.fetch;
  let fetcher: typeof fetch = async () => { throw new Error('Unexpected network call'); };
  globalThis.fetch = async (...args) => fetcher(...args);
  return {
    app, store, directory,
    token: () => randomBytes(24).toString('hex'),
    mockFetch: (value: typeof fetch) => { fetcher = value; },
    connect: (provider: string, token: string) => app.inject({ method: 'POST', url: `/api/integrations/${provider}`, payload: { token } }),
    check: (provider: string) => app.inject({ method: 'POST', url: `/api/integrations/${provider}/check` }),
    disconnect: (provider: string) => app.inject({ method: 'DELETE', url: `/api/integrations/${provider}` }),
    cleanup: async () => { globalThis.fetch = originalFetch; await app.close(); await store.close(); rmSync(directory, { recursive: true, force: true }); },
  };
}
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });

test('GitHub connection verifies the account before encrypting credentials and returns no token', async () => {
  const f = await fixture();
  try {
    const token = f.token();
    f.mockFetch(async (input, init) => {
      assert.equal(String(input), 'https://api.github.com/user');
      assert.equal(new Headers(init?.headers).get('Authorization'), `Bearer ${token}`);
      assert.equal(init?.redirect, 'error');
      return json({ login: 'example-user', email: 'private@example.com', other: token });
    });
    const response = await f.connect('github', ` ${token} `);
    assert.equal(response.statusCode, 200, response.body);
    assert.equal(response.json().login, 'example-user');
    assert.equal(response.json().connected, true);
    assert.ok(Number.isFinite(Date.parse(response.json().checkedAt)));
    assert.equal(response.body.includes(token), false);
    assert.equal(response.body.includes('private@example.com'), false);
    assert.deepEqual(await f.store.vault.get('github'), { token });
    assert.equal(await f.store.getSetting('githubLogin'), 'example-user');
    assert.equal((await f.store.getSetting<ConnectionStatus>('githubConnectionStatus'))?.error, undefined);
    for (const file of readdirSync(f.directory).filter(name => name.startsWith('workspace.sqlite'))) assert.equal(readFileSync(join(f.directory, file)).includes(Buffer.from(token)), false);
  } finally { await f.cleanup(); }
});

test('Vercel connection records only the account label and leaves existing credentials on failed replacement', async () => {
  const f = await fixture();
  try {
    const token = f.token();
    f.mockFetch(async input => {
      assert.equal(String(input), 'https://api.vercel.com/v2/user');
      return json({ user: { username: 'example-vercel', uid: 'user_example', email: 'private@example.com' } });
    });
    const first = await f.connect('vercel', token);
    assert.equal(first.statusCode, 200, first.body);
    assert.equal(first.json().login, 'example-vercel');
    assert.equal(await f.store.getSetting('vercelLogin'), 'example-vercel');
    const priorStatus = await f.store.getSetting('vercelConnectionStatus');
    f.mockFetch(async () => json({ error: { message: token } }, 401));
    const failed = await f.connect('vercel', f.token());
    assert.equal(failed.statusCode, 400);
    assert.equal(failed.body.includes(token), false);
    assert.deepEqual(await f.store.vault.get('vercel'), { token });
    assert.equal(await f.store.getSetting('vercelLogin'), 'example-vercel');
    assert.deepEqual(await f.store.getSetting('vercelConnectionStatus'), priorStatus);
  } finally { await f.cleanup(); }
});

test('checking an expired GitHub credential preserves it, records a safe error, and a later success clears the error', async () => {
  const f = await fixture();
  try {
    const token = f.token();
    await f.store.vault.set('github', { token });
    await f.store.setSetting('githubLogin', 'old-account');
    f.mockFetch(async () => json({ message: token }, 401));
    const failed = await f.check('github');
    assert.equal(failed.statusCode, 200, failed.body);
    assert.equal(failed.json().connected, false);
    assert.match(failed.json().error, /已过期/);
    assert.equal(failed.body.includes(token), false);
    assert.deepEqual(await f.store.vault.get('github'), { token });
    assert.equal(await f.store.getSetting('githubLogin'), 'old-account');
    assert.match((await f.store.getSetting<ConnectionStatus>('githubConnectionStatus'))?.error ?? '', /已过期/);
    f.mockFetch(async () => json({ login: 'current-account' }));
    const valid = await f.check('github');
    assert.equal(valid.json().connected, true);
    assert.equal(valid.json().login, 'current-account');
    assert.equal(await f.store.getSetting('githubLogin'), 'current-account');
    assert.equal((await f.store.getSetting<ConnectionStatus>('githubConnectionStatus'))?.error, undefined);
  } finally { await f.cleanup(); }
});

test('Vercel check verifies the saved account and retains credentials after a permission error', async () => {
  const f = await fixture();
  try {
    const token = f.token();
    await f.store.vault.set('vercel', { token });
    f.mockFetch(async () => json({ user: { username: 'verified-account' } }));
    const valid = await f.check('vercel');
    assert.equal(valid.json().login, 'verified-account');
    f.mockFetch(async () => json({ error: token }, 403));
    const denied = await f.check('vercel');
    assert.equal(denied.json().connected, false);
    assert.match(denied.json().error, /权限/);
    assert.equal(denied.body.includes(token), false);
    assert.deepEqual(await f.store.vault.get('vercel'), { token });
    assert.equal(await f.store.getSetting('vercelLogin'), 'verified-account');
  } finally { await f.cleanup(); }
});

test('Vercel Integration checks its installation scope without requiring User Account access', async () => {
  const f = await fixture();
  try {
    const token = f.token();
    await f.store.vault.set('vercel', { token, authorization: 'vercel-integration', installationId: 'icfg_example', teamId: 'team_example', userId: 'user_example' });
    await f.store.setSetting('vercelLogin', 'user_example');
    f.mockFetch(async input => {
      assert.equal(String(input), 'https://api.vercel.com/v1/integrations/configuration/icfg_example?teamId=team_example');
      return json({ id: 'icfg_example', teamId: 'team_example', ownerId: 'user_example' });
    });
    const valid = await f.check('vercel');
    assert.equal(valid.json().connected, true);
    assert.equal(valid.json().login, 'user_example');
    f.mockFetch(async () => json({ id: 'icfg_example', teamId: 'team_other' }));
    assert.equal((await f.check('vercel')).json().connected, false);
    assert.equal(await f.store.vault.has('vercel'), true);
  } finally { await f.cleanup(); }
});

test('transport failures and malformed account responses cannot expose credentials or replace a connection', async () => {
  const f = await fixture();
  try {
    for (const provider of ['github', 'vercel']) {
      const token = f.token();
      await f.store.vault.set(provider, { token });
      f.mockFetch(async () => { throw new Error(`Request failed with Authorization Bearer ${token}`); });
      const check = await f.check(provider);
      assert.equal(check.json().connected, false);
      assert.equal(check.body.includes(token), false);
      const connect = await f.connect(provider, token);
      assert.equal(connect.statusCode, 400);
      assert.equal(connect.body.includes(token), false);
      f.mockFetch(async () => json({ token }));
      assert.equal((await f.connect(provider, f.token())).statusCode, 400);
      assert.deepEqual(await f.store.vault.get(provider), { token });
    }
  } finally { await f.cleanup(); }
});

test('disconnecting Vercel clears identity, checks, and cached statuses while retaining services and projects', async () => {
  const f = await fixture();
  try {
    const now = new Date().toISOString();
    const service = { id: 'web', name: 'Web', kind: 'vercel' as const, target: { vercelProjectId: 'prj_example' }, autoDeploy: false, createdAt: now, updatedAt: now };
    await f.store.saveService(service);
    await f.store.saveProject({ id: 'project', name: 'Project', description: '', serviceIds: [service.id], createdAt: now, updatedAt: now });
    await f.store.vault.set('vercel', { token: f.token() });
    await f.store.setSetting('vercelLogin', 'example-account');
    await f.store.setSetting('vercelConnectionStatus', { checkedAt: now });
    await f.store.setSetting(`status:service:${service.id}`, { ready: true });
    const response = await f.disconnect('vercel');
    assert.equal(response.statusCode, 200, response.body);
    assert.equal(await f.store.vault.has('vercel'), false);
    assert.equal(await f.store.getSetting('vercelLogin'), null);
    assert.equal(await f.store.getSetting('vercelConnectionStatus'), null);
    assert.equal(await f.store.getSetting(`status:service:${service.id}`), null);
    assert.equal((await f.store.allServices()).length, 1);
    assert.deepEqual((await f.store.getProject('project'))?.serviceIds, ['web']);
  } finally { await f.cleanup(); }
});

test('GitHub disconnect requires pausing automatic source deployments', async () => {
  const f = await fixture();
  try {
    const now = new Date().toISOString();
    await f.store.saveServer({ id: 'server', name: 'Server', host: '127.0.0.1', port: 22, username: 'ubuntu', group: '', notes: '', createdAt: now, updatedAt: now });
    const service = { id: 'source', name: 'Source', kind: 'source' as const, serverId: 'server', target: {}, repository: 'https://github.com/example/repo', autoDeploy: true, createdAt: now, updatedAt: now };
    await f.store.saveService(service);
    const token = f.token();
    await f.store.vault.set('github', { token });
    assert.equal((await f.disconnect('github')).statusCode, 400);
    assert.deepEqual(await f.store.vault.get('github'), { token });
    await f.store.saveService({ ...service, autoDeploy: false });
    assert.equal((await f.disconnect('github')).statusCode, 200);
    assert.equal(await f.store.vault.has('github'), false);
  } finally { await f.cleanup(); }
});

test('independent publisher mode rejects controller GitHub credentials and checks but permits Vercel', async () => {
  const f = await fixture(true);
  try {
    let calls = 0;
    f.mockFetch(async () => { calls++; return json({ user: { username: 'example-account' } }); });
    const rejected = await f.connect('github', f.token());
    assert.equal(rejected.statusCode, 400);
    assert.match(rejected.json().error, /独立发布器/);
    assert.equal((await f.check('github')).statusCode, 400);
    assert.equal(calls, 0);
    assert.equal(await f.store.vault.has('github'), false);
    assert.equal((await f.connect('vercel', f.token())).statusCode, 200);
    assert.equal(calls, 1);
  } finally { await f.cleanup(); }
});

test('unsupported providers, missing credentials, and unsafe Token input make no external request', async () => {
  const f = await fixture();
  try {
    assert.equal((await f.connect('other', f.token())).statusCode, 400);
    assert.equal((await f.check('github')).statusCode, 400);
    assert.equal((await f.connect('github', 'bad\nheader')).statusCode, 400);
    assert.equal((await f.connect('vercel', 'short')).statusCode, 400);
    assert.equal(await f.store.vault.has('github'), false);
  } finally { await f.cleanup(); }
});

test('a slow connection check cannot overwrite replacement credentials or their account status', async () => {
  const f = await fixture();
  try {
    const oldToken = f.token(), newToken = f.token();
    await f.store.vault.set('github', { token: oldToken });
    let release!: (value: Response) => void;
    let requested!: () => void;
    const requestStarted = new Promise<void>(resolve => { requested = resolve; });
    f.mockFetch(async () => { requested(); return new Promise<Response>(resolve => { release = resolve; }); });
    const pending = f.check('github');
    await requestStarted;
    const replacementStatus = { checkedAt: new Date().toISOString() };
    await f.store.transaction(async () => {
      await f.store.vault.set('github', { token: newToken });
      await f.store.setSetting('githubLogin', 'replacement-account');
      await f.store.setSetting('githubConnectionStatus', replacementStatus);
    });
    release(json({ login: 'stale-account' }));
    const result = await pending;
    assert.equal(result.statusCode, 400);
    assert.match(result.json().error, /凭据已变更/);
    assert.deepEqual(await f.store.vault.get('github'), { token: newToken });
    assert.equal(await f.store.getSetting('githubLogin'), 'replacement-account');
    assert.deepEqual(await f.store.getSetting('githubConnectionStatus'), replacementStatus);
  } finally { await f.cleanup(); }
});
