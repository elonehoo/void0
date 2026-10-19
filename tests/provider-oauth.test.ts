import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import { getProviderToken, registerProviderOAuth, type ProviderCredential } from '../server/provider-oauth.js';
import { registerConnectionRoutes } from '../server/connection-routes.js';
import { Store } from '../server/store.js';

type Provider = 'github' | 'vercel';
const random = () => randomBytes(24).toString('hex');
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
async function fixture(options: { publisherConfigured?: boolean; environment?: Record<string, string | undefined>; publicUrl?: string } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'void0-provider-oauth-'));
  const store = new Store(directory);
  await store.ready();
  await store.setSetting('publicUrl', options.publicUrl ?? 'https://console.example.com');
  const sessionId = random();
  await store.vault.set(`session:${sessionId}`, { expires: Date.now() + 3_600_000 });
  const environment = options.environment ?? { VOID0_GITHUB_CLIENT_ID: 'Iv1.example', VOID0_GITHUB_CLIENT_SECRET: random(), VOID0_VERCEL_CLIENT_ID: 'oac_example', VOID0_VERCEL_CLIENT_SECRET: random(), VOID0_VERCEL_INTEGRATION_SLUG: 'example-integration' };
  const app = Fastify();
  await app.register(cookie);
  app.addHook('onRequest', async req => { req.sessionId = typeof req.headers['x-test-session'] === 'string' ? req.headers['x-test-session'] : undefined; });
  app.setErrorHandler((error, _req, reply) => reply.code(400).send({ error: (error as Error).message }));
  registerProviderOAuth(app, { store, publisherConfigured: options.publisherConfigured ?? false, environment });
  registerConnectionRoutes(app, { store, publisherConfigured: options.publisherConfigured ?? false });
  const originalFetch = globalThis.fetch;
  let calls = 0;
  let fetcher: typeof fetch = async () => { throw new Error('Unexpected external request'); };
  globalThis.fetch = async (...args) => { calls++; return fetcher(...args); };
  return {
    app, store, directory, sessionId, environment,
    calls: () => calls,
    mockFetch: (value: typeof fetch) => { fetcher = value; },
    authorization: (provider: Provider) => app.inject({ method: 'GET', url: `/api/integrations/${provider}/authorization`, headers: { 'x-test-session': sessionId } }),
    start: async (provider: Provider) => {
      const response = await app.inject({ method: 'POST', url: `/api/integrations/${provider}/authorize`, headers: { 'x-test-session': sessionId } });
      assert.equal(response.statusCode, 200, response.body);
      const { state, url, expiresAt } = response.json<{ state: string; url: string; expiresAt: number }>();
      const nonce = String(response.headers['set-cookie']).split(';')[0];
      return { state, url: new URL(url), expiresAt, nonce, response, key: `oauth:${provider}:${createHash('sha256').update(state).digest('hex')}` };
    },
    callback: (provider: Provider, state: string, nonce: string, extra: Record<string, string> = {}) => app.inject({ method: 'GET', url: `/api/integrations/${provider}/callback?${new URLSearchParams({ state, code: random(), ...extra })}`, headers: { cookie: nonce } }),
    status: (provider: Provider, state: string, owner = sessionId) => app.inject({ method: 'GET', url: `/api/integrations/${provider}/authorization/status?state=${state}`, headers: { 'x-test-session': owner } }),
    cancel: (provider: Provider, state: string, owner = sessionId) => app.inject({ method: 'POST', url: `/api/integrations/${provider}/authorization/cancel`, payload: { state }, headers: { 'x-test-session': owner } }),
    cleanup: async () => { globalThis.fetch = originalFetch; await app.close(); await store.close(); rmSync(directory, { recursive: true, force: true }); },
  };
}

test('official authorization configuration exposes only availability, callback address and safe reasons', async () => {
  const f = await fixture();
  try {
    for (const provider of ['github', 'vercel'] as const) {
      const response = await f.authorization(provider);
      assert.deepEqual(response.json(), { configured: true, callbackUrl: `https://console.example.com/api/integrations/${provider}/callback` });
      assert.equal(response.body.includes(f.environment.VOID0_GITHUB_CLIENT_SECRET!), false);
      assert.equal(response.body.includes(f.environment.VOID0_VERCEL_CLIENT_SECRET!), false);
    }
    f.environment.VOID0_GITHUB_CLIENT_SECRET = undefined;
    const missing = await f.authorization('github');
    assert.equal(missing.json().configured, false);
    assert.match(missing.json().reason, /尚未配置/);
    await f.store.setSetting('publicUrl', 'http://public.example.com');
    assert.equal((await f.authorization('vercel')).json().configured, false);
    await f.store.setSetting('publicUrl', 'http://127.0.0.1:4317');
    assert.equal((await f.authorization('vercel')).json().configured, true);
    assert.equal(f.calls(), 0);
  } finally { await f.cleanup(); }
});

test('GitHub App uses S256 PKCE, a ten-minute single-use state and a separate HttpOnly Lax nonce cookie', async () => {
  const f = await fixture();
  try {
    const attempt = await f.start('github');
    assert.equal(attempt.url.origin + attempt.url.pathname, 'https://github.com/login/oauth/authorize');
    assert.equal(attempt.url.searchParams.get('client_id'), f.environment.VOID0_GITHUB_CLIENT_ID);
    assert.equal(attempt.url.searchParams.get('scope'), 'offline_access');
    assert.equal(attempt.url.searchParams.get('code_challenge_method'), 'S256');
    assert.equal(attempt.url.searchParams.get('state'), attempt.state);
    assert.ok(attempt.expiresAt > Date.now() + 590_000 && attempt.expiresAt <= Date.now() + 600_000);
    const cookies = String(attempt.response.headers['set-cookie']);
    assert.match(cookies, /HttpOnly/i); assert.match(cookies, /SameSite=Lax/i); assert.match(cookies, /Secure/i);
    assert.match(cookies, /Max-Age=600/i); assert.match(cookies, /Path=\/api\/integrations\/github\/callback/i);
    const value = await f.store.vault.get<{ verifier: string; sessionId: string; used: boolean }>(attempt.key);
    assert.equal(value?.sessionId, f.sessionId);
    assert.equal(value?.used, false);
    assert.equal(createHash('sha256').update(value!.verifier).digest('base64url'), attempt.url.searchParams.get('code_challenge'));
    for (const file of readdirSync(f.directory).filter(name => name.startsWith('workspace.sqlite'))) {
      const bytes = readFileSync(join(f.directory, file));
      assert.equal(bytes.includes(Buffer.from(attempt.state)), false);
      assert.equal(bytes.includes(Buffer.from(value!.verifier)), false);
    }
    assert.equal((await f.status('github', attempt.state)).json().status, 'pending');
    assert.equal((await f.status('github', attempt.state, 'another-session')).statusCode, 400);
  } finally { await f.cleanup(); }
});

test('GitHub callback succeeds without the Strict admin cookie, validates identity and rejects replay', async () => {
  const f = await fixture();
  try {
    const attempt = await f.start('github'), accessToken = random(), refreshToken = random();
    f.mockFetch(async (input, init) => {
      if (String(input) === 'https://github.com/login/oauth/access_token') {
        assert.equal(init?.method, 'POST'); assert.equal(init?.redirect, 'error');
        const form = new URLSearchParams(String(init?.body));
        assert.equal(form.get('client_secret'), f.environment.VOID0_GITHUB_CLIENT_SECRET);
        assert.equal(form.get('redirect_uri'), 'https://console.example.com/api/integrations/github/callback');
        assert.equal(createHash('sha256').update(form.get('code_verifier')!).digest('base64url'), attempt.url.searchParams.get('code_challenge'));
        return json({ access_token: accessToken, expires_in: 28800, refresh_token: refreshToken, refresh_token_expires_in: 15897600, token_type: 'bearer' });
      }
      assert.equal(String(input), 'https://api.github.com/user');
      return json({ login: 'authorized-user', private: accessToken });
    });
    const result = await f.callback('github', attempt.state, attempt.nonce);
    assert.equal(result.statusCode, 200, result.body);
    assert.match(result.body, /连接成功/);
    assert.equal(result.body.includes(accessToken), false);
    assert.equal(result.body.includes(refreshToken), false);
    const saved = await f.store.vault.get<ProviderCredential>('github');
    assert.equal(saved?.token, accessToken); assert.equal(saved?.refreshToken, refreshToken);
    assert.equal(saved?.authorization, 'github-app'); assert.ok(saved!.expiresAt! > Date.now());
    assert.equal(await f.store.getSetting('githubLogin'), 'authorized-user');
    assert.equal((await f.status('github', attempt.state)).json().status, 'succeeded');
    assert.equal((await f.callback('github', attempt.state, attempt.nonce)).statusCode, 400);
    assert.equal(f.calls(), 2);
  } finally { await f.cleanup(); }
});

test('callback rejects wrong nonce, expired state and logged-out initiating sessions before contacting a provider', async () => {
  const f = await fixture();
  try {
    const attempt = await f.start('github');
    assert.equal((await f.callback('github', attempt.state, `void0_oauth_github=${random()}`)).statusCode, 400);
    assert.equal((await f.callback('github', attempt.state, '')).statusCode, 400);
    const entry = await f.store.vault.get<Record<string, unknown>>(attempt.key);
    await f.store.vault.set(attempt.key, { ...entry, expiresAt: Date.now() - 1 });
    assert.equal((await f.callback('github', attempt.state, attempt.nonce)).statusCode, 400);
    const next = await f.start('github');
    await f.store.vault.delete(`session:${f.sessionId}`);
    assert.equal((await f.callback('github', next.state, next.nonce)).statusCode, 400);
    assert.equal((await f.status('github', next.state)).statusCode, 400);
    assert.equal(f.calls(), 0);
    assert.equal(await f.store.vault.has('github'), false);
  } finally { await f.cleanup(); }
});

test('authorization failures never replace an existing credential or return upstream secrets', async () => {
  const f = await fixture();
  try {
    const existing = random();
    await f.store.vault.set('github', { token: existing });
    await f.store.setSetting('githubLogin', 'existing-account');
    const attempt = await f.start('github');
    f.mockFetch(async () => json({ error: 'bad_verification_code', error_description: f.environment.VOID0_GITHUB_CLIENT_SECRET }, 400));
    const response = await f.callback('github', attempt.state, attempt.nonce);
    assert.equal(response.statusCode, 400);
    assert.equal(response.body.includes(existing), false);
    assert.equal(response.body.includes(f.environment.VOID0_GITHUB_CLIENT_SECRET!), false);
    assert.deepEqual(await f.store.vault.get('github'), { token: existing });
    assert.equal(await f.store.getSetting('githubLogin'), 'existing-account');
    assert.equal((await f.status('github', attempt.state)).json().status, 'failed');
    assert.equal((await f.callback('github', attempt.state, attempt.nonce)).statusCode, 400);
    assert.equal(f.calls(), 1);
  } finally { await f.cleanup(); }
});

test('Vercel uses Integration installation flow, stores exchange-authoritative Team scope and completes only a vercel.com next URL', async () => {
  const f = await fixture();
  try {
    const attempt = await f.start('vercel'), token = random();
    assert.equal(attempt.url.origin + attempt.url.pathname, 'https://vercel.com/integrations/example-integration/new');
    assert.equal(attempt.url.searchParams.get('state'), attempt.state);
    assert.equal(attempt.url.searchParams.has('code_challenge'), false);
    f.mockFetch(async (input, init) => {
      if (String(input) === 'https://api.vercel.com/v2/oauth/access_token') {
        assert.equal(init?.method, 'POST');
        const form = new URLSearchParams(String(init?.body));
        assert.equal(form.get('client_id'), f.environment.VOID0_VERCEL_CLIENT_ID);
        assert.equal(form.get('redirect_uri'), 'https://console.example.com/api/integrations/vercel/callback');
        assert.equal(form.has('code_verifier'), false);
        return json({ access_token: token, token_type: 'Bearer', user_id: 'user_authoritative', team_id: 'team_authoritative', installation_id: 'icfg_example' });
      }
      assert.equal(String(input), 'https://api.vercel.com/v2/user');
      return json({ error: 'User Account permission is intentionally absent' }, 403);
    });
    const next = 'https://vercel.com/integrations/example-integration/complete?configurationId=icfg_example';
    const response = await f.callback('vercel', attempt.state, attempt.nonce, { configurationId: 'icfg_example', teamId: 'team_untrusted_query', next });
    assert.equal(response.statusCode, 303, response.body);
    assert.equal(response.headers.location, next);
    assert.deepEqual(await f.store.vault.get('vercel'), { token, authorization: 'vercel-integration', installationId: 'icfg_example', userId: 'user_authoritative', teamId: 'team_authoritative' });
    assert.equal(await f.store.getSetting('vercelLogin'), 'user_authoritative');
    assert.equal((await f.status('vercel', attempt.state)).json().status, 'succeeded');
  } finally { await f.cleanup(); }
});

test('Vercel callback rejects unsafe completion URLs and mismatched installation IDs without saving tokens', async () => {
  const f = await fixture();
  try {
    const attempt = await f.start('vercel');
    const denied = await f.callback('vercel', attempt.state, attempt.nonce, { next: 'https://vercel.com.attacker.example/' });
    assert.equal(denied.statusCode, 400);
    assert.equal(f.calls(), 0);
    const second = await f.start('vercel');
    f.mockFetch(async () => json({ access_token: random(), user_id: 'user_example', team_id: null, installation_id: 'icfg_other' }));
    assert.equal((await f.callback('vercel', second.state, second.nonce, { configurationId: 'icfg_expected' })).statusCode, 400);
    assert.equal(await f.store.vault.has('vercel'), false);
    assert.equal(f.calls(), 1);
  } finally { await f.cleanup(); }
});

test('independent publisher mode cannot initiate GitHub App authorization', async () => {
  const f = await fixture({ publisherConfigured: true });
  try {
    const availability = await f.authorization('github');
    assert.equal(availability.json().configured, false);
    assert.match(availability.json().reason, /独立发布器/);
    const denied = await f.app.inject({ method: 'POST', url: '/api/integrations/github/authorize', headers: { 'x-test-session': f.sessionId } });
    assert.equal(denied.statusCode, 400);
    assert.equal((await f.authorization('vercel')).json().configured, true);
    assert.equal(f.calls(), 0);
  } finally { await f.cleanup(); }
});

test('GitHub refresh is serialized, rotates both encrypted tokens, and remains compatible with personal tokens', async () => {
  const f = await fixture();
  try {
    const oldToken = random(), oldRefresh = random(), nextToken = random(), nextRefresh = random();
    await f.store.vault.set('github', { token: oldToken, authorization: 'github-app', expiresAt: Date.now() - 1000, refreshToken: oldRefresh, refreshExpiresAt: Date.now() + 100_000 });
    await f.store.setSetting('githubLogin', 'previously-verified-account');
    f.mockFetch(async (input, init) => {
      if (String(input).includes('/login/oauth/access_token')) {
        const form = new URLSearchParams(String(init?.body));
        assert.equal(form.get('grant_type'), 'refresh_token');
        assert.equal(form.get('refresh_token'), oldRefresh);
        await new Promise(resolve => setTimeout(resolve, 10));
        return json({ access_token: nextToken, expires_in: 28800, refresh_token: nextRefresh, refresh_token_expires_in: 15897600 });
      }
      throw new Error('Refreshing a verified credential must not depend on optional account metadata');
    });
    const values = await Promise.all(Array.from({ length: 8 }, () => getProviderToken(f.store, 'github', { environment: f.environment })));
    assert.deepEqual(values, Array(8).fill(nextToken));
    assert.equal(f.calls(), 1);
    const saved = await f.store.vault.get<ProviderCredential>('github');
    assert.equal(saved?.token, nextToken); assert.equal(saved?.refreshToken, nextRefresh);
    assert.equal(await f.store.getSetting('githubLogin'), 'previously-verified-account');
    const personal = random(); await f.store.vault.set('github', { token: personal });
    assert.equal(await getProviderToken(f.store, 'github'), personal);
    const vercel = random(); await f.store.vault.set('vercel', { token: vercel, teamId: 'team_example' });
    assert.equal(await getProviderToken(f.store, 'vercel'), vercel);
    assert.equal(f.calls(), 1);
  } finally { await f.cleanup(); }
});

test('GitHub refresh failure preserves credentials, records a safe error and never echoes provider secrets', async () => {
  const f = await fixture();
  try {
    const token = random(), refreshToken = random();
    const original: ProviderCredential = { token, authorization: 'github-app', expiresAt: Date.now() - 1, refreshToken, refreshExpiresAt: Date.now() + 60_000 };
    await f.store.vault.set('github', original);
    f.mockFetch(async () => { throw new Error(`${token} ${refreshToken} ${f.environment.VOID0_GITHUB_CLIENT_SECRET}`); });
    await assert.rejects(getProviderToken(f.store, 'github', { environment: f.environment }), error => error instanceof Error && /重新连接/.test(error.message) && !error.message.includes(token) && !error.message.includes(refreshToken));
    assert.deepEqual(await f.store.vault.get('github'), original);
    assert.match((await f.store.getSetting<{ error: string }>('githubConnectionStatus'))?.error ?? '', /无法续期/);
  } finally { await f.cleanup(); }
});

test('refresh completing after local disconnect never recreates the deleted connection', async () => {
  const f = await fixture();
  try {
    await f.store.vault.set('github', { token: random(), authorization: 'github-app', expiresAt: Date.now() - 1, refreshToken: random() });
    let release!: () => void, began!: () => void;
    const started = new Promise<void>(resolve => { began = resolve; });
    f.mockFetch(async input => {
      if (String(input).includes('/login/oauth/access_token')) { began(); await new Promise<void>(resolve => { release = resolve; }); return json({ access_token: random(), expires_in: 28800, refresh_token: random(), refresh_token_expires_in: 15897600 }); }
      return json({ login: 'old-account' });
    });
    const pending = getProviderToken(f.store, 'github', { environment: f.environment });
    await started;
    await f.store.vault.delete('github'); release();
    assert.equal(await pending, undefined);
    assert.equal(await f.store.vault.has('github'), false);
  } finally { await f.cleanup(); }
});

test('disconnecting or replacing a connection invalidates an earlier OAuth callback and preserves the latest credentials', async () => {
  const f = await fixture();
  try {
    const initial = random(); await f.store.vault.set('github', { token: initial });
    const disconnected = await f.start('github');
    assert.equal((await f.app.inject({ method: 'DELETE', url: '/api/integrations/github' })).statusCode, 200);
    const oldAfterDisconnect = await f.callback('github', disconnected.state, disconnected.nonce);
    assert.equal(oldAfterDisconnect.statusCode, 400);
    assert.equal(await f.store.vault.has('github'), false);
    assert.equal((await f.status('github', disconnected.state)).json().status, 'failed');
    assert.equal(f.calls(), 0);
    const replaced = await f.start('github'), replacement = random();
    f.mockFetch(async input => { assert.equal(String(input), 'https://api.github.com/user'); return json({ login: 'new-account' }); });
    const connected = await f.app.inject({ method: 'POST', url: '/api/integrations/github', payload: { token: replacement } });
    assert.equal(connected.statusCode, 200, connected.body);
    const oldAfterReplacement = await f.callback('github', replaced.state, replaced.nonce);
    assert.equal(oldAfterReplacement.statusCode, 400);
    assert.deepEqual(await f.store.vault.get('github'), { token: replacement });
    assert.equal(await f.store.getSetting('githubLogin'), 'new-account');
    assert.equal(oldAfterReplacement.body.includes(replacement), false);
    assert.equal(oldAfterReplacement.body.includes(initial), false);
    assert.equal(f.calls(), 1);
  } finally { await f.cleanup(); }
});

test('disconnecting or replacing credentials during OAuth exchange prevents the completed callback from overwriting them', async () => {
  const f = await fixture();
  try {
    for (const action of ['disconnect', 'replace']) {
      const attempt = await f.start('github'), authorized = random(), replacement = random();
      let release!: () => void, began!: () => void;
      const started = new Promise<void>(resolve => { began = resolve; });
      f.mockFetch(async (input, init) => {
        if (String(input) === 'https://github.com/login/oauth/access_token') {
          began(); await new Promise<void>(resolve => { release = resolve; });
          return json({ access_token: authorized, expires_in: 28800, refresh_token: random(), refresh_token_expires_in: 15897600 });
        }
        const isReplacement = new Headers(init?.headers).get('Authorization') === `Bearer ${replacement}`;
        return json({ login: isReplacement ? 'replacement-account' : 'obsolete-account' });
      });
      const pending = f.callback('github', attempt.state, attempt.nonce);
      await started;
      const changed = await f.app.inject(action === 'disconnect' ? { method: 'DELETE', url: '/api/integrations/github' } : { method: 'POST', url: '/api/integrations/github', payload: { token: replacement } });
      assert.equal(changed.statusCode, 200, changed.body);
      release();
      const response = await pending;
      assert.equal(response.statusCode, 400);
      assert.equal(response.body.includes(authorized), false);
      assert.equal(response.body.includes(replacement), false);
      if (action === 'disconnect') assert.equal(await f.store.vault.has('github'), false);
      else { assert.deepEqual(await f.store.vault.get('github'), { token: replacement }); assert.equal(await f.store.getSetting('githubLogin'), 'replacement-account'); }
      assert.equal((await f.status('github', attempt.state)).json().status, 'failed');
    }
  } finally { await f.cleanup(); }
});

test('starting a new authorization invalidates the previous window even when its old nonce is supplied', async () => {
  const f = await fixture();
  try {
    const previous = await f.start('github'), latest = await f.start('github');
    assert.equal((await f.callback('github', previous.state, previous.nonce)).statusCode, 400);
    assert.equal((await f.status('github', previous.state)).json().status, 'failed');
    assert.equal((await f.status('github', latest.state)).json().status, 'pending');
    assert.equal(f.calls(), 0);
  } finally { await f.cleanup(); }
});

test('cancelling authorization is bound to the original session and prevents the old official page from connecting', async () => {
  const f = await fixture();
  try {
    const token = random(); await f.store.vault.set('github', { token });
    const attempt = await f.start('github');
    assert.equal((await f.cancel('github', attempt.state, 'another-session')).statusCode, 400);
    assert.equal((await f.status('github', attempt.state)).json().status, 'pending');
    const cancelled = await f.cancel('github', attempt.state);
    assert.equal(cancelled.statusCode, 200, cancelled.body);
    assert.equal(cancelled.json().cancelled, true);
    assert.equal((await f.cancel('github', attempt.state)).statusCode, 200, 'cancellation is idempotent');
    assert.equal((await f.status('github', attempt.state)).json().status, 'failed');
    const callback = await f.callback('github', attempt.state, attempt.nonce);
    assert.equal(callback.statusCode, 400);
    assert.equal(callback.body.includes(token), false);
    assert.deepEqual(await f.store.vault.get('github'), { token });
    assert.equal(f.calls(), 0);
  } finally { await f.cleanup(); }
});

test('cancelling an exchange in progress blocks its result and cannot invalidate a newer authorization', async () => {
  const f = await fixture();
  try {
    const previous = await f.start('github'), obsolete = random();
    let release!: () => void, began!: () => void;
    const started = new Promise<void>(resolve => { began = resolve; });
    f.mockFetch(async input => {
      if (String(input) === 'https://github.com/login/oauth/access_token') {
        began(); await new Promise<void>(resolve => { release = resolve; });
        return json({ access_token: obsolete });
      }
      return json({ login: 'obsolete-account' });
    });
    const pending = f.callback('github', previous.state, previous.nonce);
    await started;
    assert.equal((await f.cancel('github', previous.state)).statusCode, 200);
    release();
    const blocked = await pending;
    assert.equal(blocked.statusCode, 400);
    assert.equal(blocked.body.includes(obsolete), false);
    assert.equal(await f.store.vault.has('github'), false);
    const latest = await f.start('github'), latestToken = random();
    assert.equal((await f.cancel('github', previous.state)).statusCode, 200);
    assert.equal((await f.status('github', latest.state)).json().status, 'pending');
    f.mockFetch(async input => String(input) === 'https://github.com/login/oauth/access_token' ? json({ access_token: latestToken }) : json({ login: 'latest-account' }));
    assert.equal((await f.callback('github', latest.state, latest.nonce)).statusCode, 200);
    assert.equal((await f.store.vault.get<ProviderCredential>('github'))?.token, latestToken);
    assert.equal(await f.store.getSetting('githubLogin'), 'latest-account');
    assert.equal((await f.cancel('github', latest.state)).statusCode, 400, 'a completed connection is not silently disconnected');
    assert.equal((await f.store.vault.get<ProviderCredential>('github'))?.token, latestToken);
  } finally { await f.cleanup(); }
});
