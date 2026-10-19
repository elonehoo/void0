import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { InjectOptions } from 'fastify';
import { createApp } from '../server/app.js';
import type { DeployPlan, DomainOperation, DockerDomainState, Job, RemoteJobStatus, RemoteTransport, Server, ServerStatus, Service, WorkspaceSnapshot } from '../shared/types.js';

class PlatformRemote implements RemoteTransport {
  operations: DomainOperation[] = [];
  async canControl() { return true; }
  async fingerprint() { return { fingerprint: 'SHA256:fixture', hostKey: 'fixture-host-key' }; }
  async probe(server: Server): Promise<ServerStatus> { return { serverId: server.id, checkedAt: new Date().toISOString(), dockerAvailable: true, services: [] }; }
  async bootstrap() { return { log: '' }; }
  async submit(_plan: DeployPlan): Promise<RemoteJobStatus> { throw new Error('Deployment must not run in route checks'); }
  async status(_job: Job): Promise<RemoteJobStatus> { throw new Error('Job must not run in route checks'); }
  async domain(_server: Server, _credential: unknown, operation: DomainOperation): Promise<DockerDomainState> {
    this.operations.push(structuredClone(operation));
    return { domains: [], proxyReady: true };
  }
}
async function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'void0-platform-routes-'));
  const remote = new PlatformRemote();
  const setupToken = randomBytes(24).toString('hex');
  const created = await createApp({ dataDir: directory, remote, startWorker: false, setupToken, webRoot: join(directory, 'no-web') });
  const originalFetch = globalThis.fetch;
  let cookie = '', csrf = '', externalRequests = 0;
  let fetcher: typeof fetch = async () => { throw new Error('Unexpected external request'); };
  globalThis.fetch = async (...args) => { externalRequests++; return fetcher(...args); };
  const request = (method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, payload?: InjectOptions['payload'], headers: Record<string, string> = {}) => created.app.inject({
    method, url, ...(payload === undefined ? {} : { payload }),
    headers: { host: 'localhost:4317', ...(cookie ? { cookie } : {}), ...(csrf ? { 'x-csrf-token': csrf } : {}), ...headers },
  });
  return {
    ...created, remote, request,
    token: () => randomBytes(24).toString('hex'),
    mockFetch: (value: typeof fetch) => { fetcher = value; },
    externalRequests: () => externalRequests,
    setup: async () => {
      const response = await request('POST', '/api/setup', { setupToken, password: randomBytes(24).toString('hex') });
      assert.equal(response.statusCode, 200, response.body);
      cookie = String(response.headers['set-cookie']).split(';')[0];
      csrf = response.json().csrfToken;
    },
    addImage: async () => {
      const project = await request('POST', '/api/projects', { name: 'Project' });
      const server = await request('POST', '/api/servers', { name: 'Server', host: '127.0.0.1' });
      assert.equal(project.statusCode, 200, project.body);
      assert.equal(server.statusCode, 200, server.body);
      const response = await request('POST', '/api/services', { projectId: project.json().id, name: 'Website', serverId: server.json().id, kind: 'image', image: 'nginx:alpine', hostPort: 18080, containerPort: 80 });
      assert.equal(response.statusCode, 200, response.body);
      return response.json<Service>();
    },
    cleanup: async () => { globalThis.fetch = originalFetch; await created.app.close(); rmSync(directory, { recursive: true, force: true }); },
  };
}
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });

test('real app protects connection and domain endpoints with login, request origin and CSRF checks', async () => {
  const f = await fixture();
  try {
    const mutations = [
      { method: 'POST' as const, url: '/api/integrations/github', payload: { token: f.token() } },
      { method: 'POST' as const, url: '/api/integrations/vercel', payload: { token: f.token() } },
      { method: 'POST' as const, url: '/api/integrations/github/check' },
      { method: 'POST' as const, url: '/api/integrations/vercel/check' },
      { method: 'DELETE' as const, url: '/api/integrations/github' },
      { method: 'DELETE' as const, url: '/api/integrations/vercel' },
      { method: 'POST' as const, url: '/api/services/example/domains', payload: { name: 'website.example.com' } },
      { method: 'DELETE' as const, url: '/api/services/example/domains/website.example.com' },
      { method: 'POST' as const, url: '/api/services/example/domains/website.example.com/verify' },
    ];
    for (const item of mutations) assert.equal((await f.request(item.method, item.url, item.payload)).statusCode, 401, item.url);
    assert.equal((await f.request('GET', '/api/services/example/domains')).statusCode, 401);
    assert.equal(f.externalRequests(), 0);
    assert.equal(f.remote.operations.length, 0);
    await f.setup();
    for (const item of mutations) {
      const noCsrf = await f.request(item.method, item.url, item.payload, { 'x-csrf-token': '' });
      assert.equal(noCsrf.statusCode, 403, item.url);
      const badOrigin = await f.request(item.method, item.url, item.payload, { origin: 'https://untrusted.example' });
      assert.equal(badOrigin.statusCode, 403, item.url);
    }
    assert.equal((await f.request('GET', '/api/services/example/domains', undefined, { origin: 'https://untrusted.example' })).statusCode, 403);
    assert.equal(f.externalRequests(), 0);
    assert.equal(f.remote.operations.length, 0);
    f.mockFetch(async () => json({ login: 'verified-user' }));
    assert.equal((await f.request('POST', '/api/integrations/github', { token: f.token() })).statusCode, 200);
    const service = await f.addImage();
    const domains = await f.request('GET', `/api/services/${service.id}/domains`);
    assert.equal(domains.statusCode, 200, domains.body);
    assert.deepEqual(domains.json().domains, []);
    assert.equal(f.remote.operations.at(-1)?.action, 'list');
    const invalidDomain = await f.request('POST', `/api/services/${service.id}/domains`, { name: 'https://website.example.com' });
    assert.equal(invalidDomain.statusCode, 400);
    assert.match(invalidDomain.json().error, /完整域名/);
    const missingDomain = await f.request('POST', `/api/services/${service.id}/domains/website.example.com/verify`);
    assert.equal(missingDomain.statusCode, 400);
    assert.match(missingDomain.json().error, /未绑定/);
  } finally { await f.cleanup(); }
});

test('real app workspace exposes verified connection identity and check results without credentials', async () => {
  const f = await fixture();
  try {
    await f.setup();
    const githubToken = f.token(), vercelToken = f.token();
    f.mockFetch(async input => String(input).startsWith('https://api.github.com/')
      ? json({ login: 'github-account', private: githubToken })
      : json({ user: { username: 'vercel-account', email: 'private@example.com', private: vercelToken } }));
    const github = await f.request('POST', '/api/integrations/github', { token: githubToken });
    const vercel = await f.request('POST', '/api/integrations/vercel', { token: vercelToken });
    assert.equal(github.statusCode, 200, github.body);
    assert.equal(vercel.statusCode, 200, vercel.body);
    const workspace = await f.request('GET', '/api/workspace');
    assert.equal(workspace.statusCode, 200, workspace.body);
    const summary = workspace.json<WorkspaceSnapshot>().integrations;
    assert.deepEqual(summary.github, { connected: true, login: 'github-account', checkedAt: github.json().checkedAt });
    assert.deepEqual(summary.vercel, { connected: true, login: 'vercel-account', checkedAt: vercel.json().checkedAt });
    assert.equal(workspace.body.includes(githubToken), false);
    assert.equal(workspace.body.includes(vercelToken), false);
    assert.equal(workspace.body.includes('private@example.com'), false);
    f.mockFetch(async () => json({ message: githubToken, error: { message: vercelToken } }, 401));
    for (const provider of ['github', 'vercel'] as const) {
      const check = await f.request('POST', `/api/integrations/${provider}/check`);
      assert.equal(check.statusCode, 200, check.body);
      assert.equal(check.json().connected, false);
      const after = await f.request('GET', '/api/workspace');
      const status = after.json<WorkspaceSnapshot>().integrations[provider];
      assert.equal(status.connected, true, 'failed verification does not delete the saved credentials');
      assert.equal(status.error, check.json().error);
      assert.equal(status.checkedAt, check.json().checkedAt);
      assert.equal(status.login, provider === 'github' ? 'github-account' : 'vercel-account');
      assert.equal(after.body.includes(githubToken), false);
      assert.equal(after.body.includes(vercelToken), false);
    }
    assert.equal((await f.request('GET', '/api/session')).json().authenticated, true);
    assert.equal((await f.request('DELETE', '/api/integrations/vercel')).statusCode, 200);
    const disconnected = (await f.request('GET', '/api/workspace')).json<WorkspaceSnapshot>().integrations.vercel;
    assert.equal(disconnected.connected, false);
    assert.equal(disconnected.error, undefined);
    assert.equal(disconnected.checkedAt, undefined);
  } finally { await f.cleanup(); }
});

test('real app prevents changing domain target ports or deleting a service with managed or pending domains', async () => {
  const f = await fixture();
  try {
    await f.setup();
    const service = await f.addImage();
    const domainKey = `domains:service:${service.id}`;
    await f.store.setSetting(domainKey, { names: ['website.example.com'], managedNames: ['website.example.com'] });
    const before = await f.store.getService(service.id);
    for (const change of [{ hostPort: 18081 }, { containerPort: 8080 }]) {
      const response = await f.request('PUT', `/api/services/${service.id}`, { name: service.name, ...change });
      assert.equal(response.statusCode, 400, response.body);
      assert.match(response.json().error, /仍绑定域名/);
      assert.deepEqual(await f.store.getService(service.id), before);
    }
    const rename = await f.request('PUT', `/api/services/${service.id}`, { name: 'Renamed website' });
    assert.equal(rename.statusCode, 200, rename.body);
    assert.equal((await f.store.getService(service.id))?.hostPort, 18080);
    const managedDelete = await f.request('DELETE', `/api/services/${service.id}`);
    assert.equal(managedDelete.statusCode, 400);
    assert.match(managedDelete.json().error, /域名/);
    assert.ok(await f.store.getService(service.id));
    await f.store.setSetting(domainKey, { names: [], managedNames: [], pending: { action: 'add', name: 'website.example.com', at: new Date().toISOString() } });
    const pendingEdit = await f.request('PUT', `/api/services/${service.id}`, { name: service.name, hostPort: 18082 });
    assert.equal(pendingEdit.statusCode, 400);
    const pendingDelete = await f.request('DELETE', `/api/services/${service.id}`);
    assert.equal(pendingDelete.statusCode, 400);
    assert.match(pendingDelete.json().error, /结果待确认/);
    await f.store.setSetting(domainKey, { names: [], managedNames: [] });
    const changeAfterRemoval = await f.request('PUT', `/api/services/${service.id}`, { name: service.name, hostPort: 18082 });
    assert.equal(changeAfterRemoval.statusCode, 200, changeAfterRemoval.body);
    assert.equal((await f.store.getService(service.id))?.hostPort, 18082);
    assert.equal((await f.request('DELETE', `/api/services/${service.id}`)).statusCode, 200);
    assert.equal(await f.store.getService(service.id), undefined);
    assert.equal(f.remote.operations.length, 0, 'editing and deleting records must not issue remote domain mutations');
    assert.equal(f.externalRequests(), 0);
  } finally { await f.cleanup(); }
});

test('real app exposes only exact GET provider callbacks and retains Host, Origin and method protection', async () => {
  const f = await fixture();
  try {
    for (const provider of ['github', 'vercel']) {
      const path = `/api/integrations/${provider}/callback`;
      const missingState = await f.request('GET', path);
      assert.equal(missingState.statusCode, 400, missingState.body);
      assert.match(missingState.body, /授权未完成/);
      const missingNonce = await f.request('GET', `${path}?state=${'0'.repeat(64)}&code=example-code`);
      assert.equal(missingNonce.statusCode, 400);
      assert.equal((await f.request('POST', path)).statusCode, 401);
      assert.equal((await f.request('PUT', path)).statusCode, 401);
      assert.equal((await f.request('DELETE', path)).statusCode, 401);
      assert.equal((await f.app.inject({ method: 'HEAD', url: path, headers: { host: 'localhost:4317' } })).statusCode, 401);
      assert.equal((await f.request('GET', path, undefined, { host: 'untrusted.example' })).statusCode, 403);
      assert.equal((await f.request('GET', path, undefined, { origin: 'https://untrusted.example' })).statusCode, 403);
    }
    for (const path of ['/api/integrations/other/callback', '/api/integrations/GitHub/callback', '/api/integrations/github/callback/', '/api/integrations/github/callback/extra', '/api/integrations/%67ithub/callback']) {
      assert.equal((await f.request('GET', path)).statusCode, 401, path);
    }
    await f.setup();
    for (const provider of ['github', 'vercel']) {
      const path = `/api/integrations/${provider}/callback`;
      assert.equal((await f.request('POST', path, undefined, { 'x-csrf-token': '' })).statusCode, 403);
      assert.equal((await f.request('POST', path, undefined, { origin: 'https://untrusted.example' })).statusCode, 403);
      assert.equal((await f.request('GET', path)).statusCode, 400);
    }
    assert.equal(f.externalRequests(), 0);
    assert.equal(f.remote.operations.length, 0);
    assert.equal(await f.store.vault.has('github'), false);
    assert.equal(await f.store.vault.has('vercel'), false);
  } finally { await f.cleanup(); }
});

test('real app protects authorization discovery, start and status while permitting a nonce-bound callback without the Strict admin cookie', async () => {
  const names = ['VOID0_GITHUB_CLIENT_ID', 'VOID0_GITHUB_CLIENT_SECRET'] as const;
  const originalEnvironment = Object.fromEntries(names.map(name => [name, process.env[name]]));
  process.env.VOID0_GITHUB_CLIENT_ID = 'Iv1.example';
  process.env.VOID0_GITHUB_CLIENT_SECRET = randomBytes(24).toString('hex');
  const f = await fixture();
  try {
    const state = '0'.repeat(64);
    for (const provider of ['github', 'vercel']) {
      assert.equal((await f.request('GET', `/api/integrations/${provider}/authorization`)).statusCode, 401);
      assert.equal((await f.request('GET', `/api/integrations/${provider}/authorization/status?state=${state}`)).statusCode, 401);
      assert.equal((await f.request('POST', `/api/integrations/${provider}/authorize`)).statusCode, 401);
    }
    await f.setup();
    for (const provider of ['github', 'vercel']) {
      assert.equal((await f.request('POST', `/api/integrations/${provider}/authorize`, undefined, { 'x-csrf-token': '' })).statusCode, 403);
      assert.equal((await f.request('POST', `/api/integrations/${provider}/authorize`, undefined, { origin: 'https://untrusted.example' })).statusCode, 403);
      assert.equal((await f.request('GET', `/api/integrations/${provider}/authorization`, undefined, { origin: 'https://untrusted.example' })).statusCode, 403);
      assert.equal((await f.request('GET', `/api/integrations/${provider}/authorization/status?state=${state}`, undefined, { origin: 'https://untrusted.example' })).statusCode, 403);
    }
    assert.equal(f.externalRequests(), 0);
    await f.store.setSetting('publicUrl', 'https://console.example.com');
    const availability = await f.request('GET', '/api/integrations/github/authorization');
    assert.equal(availability.statusCode, 200, availability.body);
    assert.equal(availability.json().configured, true);
    assert.equal(availability.json().callbackUrl, 'https://console.example.com/api/integrations/github/callback');
    assert.equal(availability.body.includes(process.env.VOID0_GITHUB_CLIENT_SECRET!), false);
    const started = await f.request('POST', '/api/integrations/github/authorize');
    assert.equal(started.statusCode, 200, started.body);
    const attempt = started.json<{ state: string; url: string }>();
    const nonce = String(started.headers['set-cookie']).split(';')[0];
    const pending = await f.request('GET', `/api/integrations/github/authorization/status?state=${attempt.state}`);
    assert.equal(pending.statusCode, 200, pending.body);
    assert.equal(pending.json().status, 'pending');
    assert.equal((await f.request('GET', `/api/integrations/github/authorization/status?state=${attempt.state}`, undefined, { cookie: '' })).statusCode, 401);
    const token = f.token(), refreshToken = f.token();
    f.mockFetch(async input => String(input) === 'https://github.com/login/oauth/access_token'
      ? json({ access_token: token, expires_in: 28800, refresh_token: refreshToken, refresh_token_expires_in: 15897600 })
      : json({ login: 'official-account' }));
    const callback = await f.request('GET', `/api/integrations/github/callback?${new URLSearchParams({ state: attempt.state, code: 'example-code' })}`, undefined, { cookie: nonce });
    assert.equal(callback.statusCode, 200, callback.body);
    assert.equal(callback.body.includes(token), false);
    assert.equal(callback.body.includes(refreshToken), false);
    assert.equal(callback.headers['cache-control'], 'no-store');
    assert.equal((await f.request('GET', `/api/integrations/github/authorization/status?state=${attempt.state}`)).json().status, 'succeeded');
    const workspace = await f.request('GET', '/api/workspace');
    assert.equal(workspace.json<WorkspaceSnapshot>().integrations.github.login, 'official-account');
    assert.equal(workspace.body.includes(token), false);
    assert.equal(workspace.body.includes(refreshToken), false);
    assert.equal((await f.request('GET', `/api/integrations/github/callback?state=${attempt.state}&code=example-code`, undefined, { cookie: nonce })).statusCode, 400);
    assert.equal(f.externalRequests(), 2);
  } finally {
    await f.cleanup();
    for (const name of names) { const previous = originalEnvironment[name]; if (previous === undefined) delete process.env[name]; else process.env[name] = previous; }
  }
});
