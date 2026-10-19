import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { env } from './config.js';
import { GitHub, Vercel } from './integrations.js';
import type { Store } from './store.js';

type Provider = 'github' | 'vercel';
type Environment = Record<string, string | undefined>;
export interface ProviderCredential {
  token: string;
  authorization?: 'github-app' | 'vercel-integration';
  expiresAt?: number;
  refreshToken?: string;
  refreshExpiresAt?: number;
  teamId?: string;
  installationId?: string;
  userId?: string;
}
interface AuthorizationState {
  provider: Provider;
  generation: number;
  sessionId: string;
  nonceHash: string;
  expiresAt: number;
  callbackUrl: string;
  verifier?: string;
  used: boolean;
  status: 'pending' | 'succeeded' | 'failed';
  error?: string;
}
interface Configuration { clientId: string; clientSecret: string; slug?: string; callbackUrl: string }
const providers = z.enum(['github', 'vercel']);
const opaque = z.string().regex(/^[0-9a-f]{64}$/);
const secret = z.string().min(8).max(8192).regex(/^[\x21-\x7e]+$/);
const label = z.string().trim().min(1).max(160).refine(value => !/[\x00-\x1f\x7f]/.test(value));
const tokenResponse = z.object({ access_token: secret, token_type: z.string().optional(), expires_in: z.number().int().positive().max(31_536_000).optional(), refresh_token: secret.optional(), refresh_token_expires_in: z.number().int().positive().max(31_536_000).optional() });
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const stateKey = (provider: Provider, state: string) => `oauth:${provider}:${hash(state)}`;
const nonceCookie = (provider: Provider) => `void0_oauth_${provider}`;
const cookiePath = (provider: Provider) => `/api/integrations/${provider}/callback`;
const callbackMessage = '授权未完成，请关闭此窗口并在 void0 重新连接。';
function equal(left: string | undefined, right: string): boolean { if (!left) return false; const a = Buffer.from(left), b = Buffer.from(right); return a.length === b.length && timingSafeEqual(a, b); }
function origin(input: string): string {
  const value = new URL(input);
  if (!['http:', 'https:'].includes(value.protocol) || value.username || value.password || value.search || value.hash || value.pathname !== '/') throw new Error('请配置不含路径或参数的管理后台地址。');
  if (value.protocol !== 'https:' && !['localhost', '127.0.0.1', '[::1]'].includes(value.hostname)) throw new Error('官方授权需要 HTTPS 管理后台地址；HTTP 只允许本机回环地址。');
  return value.origin;
}
async function configuration(store: Store, provider: Provider, environment: Environment): Promise<{ configuration?: Configuration; callbackUrl?: string; reason?: string }> {
  const publicUrl = await store.getSetting<string>('publicUrl') || env('PUBLIC_URL', environment);
  if (!publicUrl) return { reason: '请先在设置中填写管理后台的 HTTPS 访问地址，再配置官方应用。' };
  let base: string;
  try { base = origin(publicUrl); } catch { return { reason: '管理后台地址需要使用 HTTPS；HTTP 只允许本机回环地址。' }; }
  const callbackUrl = `${base}/api/integrations/${provider}/callback`;
  const clientId = env(`${provider.toUpperCase()}_CLIENT_ID`, environment)?.trim();
  const clientSecret = env(`${provider.toUpperCase()}_CLIENT_SECRET`, environment)?.trim();
  const slug = provider === 'vercel' ? env('VERCEL_INTEGRATION_SLUG', environment)?.trim() : undefined;
  if (!clientId || !clientSecret || provider === 'vercel' && !slug) return { callbackUrl, reason: provider === 'github' ? '尚未配置 GitHub App 的 Client ID 和 Client Secret。' : '尚未配置 Vercel Integration 的 Client ID、Client Secret 和 Slug。' };
  if (!/^[A-Za-z0-9_.-]{1,256}$/.test(clientId) || !secret.safeParse(clientSecret).success || slug && !/^[a-z0-9][a-z0-9-]{0,99}$/.test(slug)) return { callbackUrl, reason: '官方应用配置格式不正确，请检查后台环境变量。' };
  return { callbackUrl, configuration: { clientId, clientSecret, slug, callbackUrl } };
}
async function exchange(provider: Provider, body: URLSearchParams, request: typeof fetch = fetch): Promise<unknown> {
  try {
    const response = await request(provider === 'github' ? 'https://github.com/login/oauth/access_token' : 'https://api.vercel.com/v2/oauth/access_token', {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(20_000),
      headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' }, body,
    });
    if (!response.ok) throw new Error();
    const value: unknown = await response.json();
    if (!value || typeof value !== 'object' || 'error' in value) throw new Error();
    return value;
  } catch { throw new Error(`${provider === 'github' ? 'GitHub' : 'Vercel'} 官方授权未完成，请重新连接。`); }
}
function githubCredential(value: unknown, now: number): ProviderCredential {
  const parsed = tokenResponse.parse(value);
  if (parsed.expires_in && !parsed.refresh_token) throw new Error('GitHub 未返回可续期的授权，请重新连接。');
  return { token: parsed.access_token, authorization: 'github-app', ...(parsed.expires_in ? { expiresAt: now + parsed.expires_in * 1000 } : {}), ...(parsed.refresh_token ? { refreshToken: parsed.refresh_token } : {}), ...(parsed.refresh_token_expires_in ? { refreshExpiresAt: now + parsed.refresh_token_expires_in * 1000 } : {}) };
}
async function verifiedIdentity(provider: Provider, token: string, fallback?: string): Promise<string> {
  if (provider === 'github') return label.parse((await new GitHub(token).user()).login);
  try {
    const response = await new Vercel(token).api<{ user?: { username?: string; name?: string } }>('/v2/user');
    return label.parse(response.user?.username || response.user?.name);
  } catch {
    // An Integration may not request User Account access. The code exchange's user_id is authoritative.
    return label.parse(fallback);
  }
}
const refreshes = new WeakMap<Store, Promise<string | undefined>>();

export async function connectionGeneration(store: Store, provider: Provider): Promise<number> {
  return z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).parse(await store.getSetting<number>(`${provider}ConnectionGeneration`) ?? 0);
}
export async function advanceConnectionGeneration(store: Store, provider: Provider): Promise<number> {
  const next = await connectionGeneration(store, provider) + 1;
  if (!Number.isSafeInteger(next)) throw new Error('连接版本无效，请检查后台数据。');
  await store.setSetting(`${provider}ConnectionGeneration`, next);
  return next;
}

/** Legacy personal tokens remain supported; expiring GitHub App credentials refresh only on the server. */
export async function getProviderToken(store: Store, provider: Provider, options: { environment?: Environment } = {}): Promise<string | undefined> {
  const saved = await store.vault.get<ProviderCredential>(provider);
  if (!saved) return undefined;
  if (provider !== 'github' || saved.authorization !== 'github-app' || !saved.expiresAt || saved.expiresAt > Date.now() + 60_000) return saved.token;
  const pending = refreshes.get(store); if (pending) return pending;
  const refreshing = (async () => {
    const current = await store.vault.get<ProviderCredential>('github');
    if (!current) return undefined;
    if (current.authorization !== 'github-app' || !current.expiresAt || current.expiresAt > Date.now() + 60_000) return current.token;
    try {
      const clientId = env('GITHUB_CLIENT_ID', options.environment ?? process.env);
      const clientSecret = env('GITHUB_CLIENT_SECRET', options.environment ?? process.env);
      if (!clientId || !clientSecret || !current.refreshToken || current.refreshExpiresAt && current.refreshExpiresAt <= Date.now()) throw new Error();
      const response = await exchange('github', new URLSearchParams({ client_id: clientId, client_secret: clientSecret, grant_type: 'refresh_token', refresh_token: current.refreshToken }));
      const next = githubCredential(response, Date.now());
      return await store.transaction(async () => {
        const latest = await store.vault.get<ProviderCredential>('github');
        if (latest?.token !== current.token || latest.refreshToken !== current.refreshToken) return latest?.token;
        // GitHub has already invalidated the previous pair. Persist rotation before optional identity calls.
        await store.vault.set('github', next);
        await store.setSetting('githubConnectionStatus', { checkedAt: new Date().toISOString() });
        return next.token;
      });
    } catch {
      const failure = await store.transaction(async () => {
        const latest = await store.vault.get<ProviderCredential>('github');
        if (latest?.token !== current.token || latest.refreshToken !== current.refreshToken) return { token: latest?.token, failed: false };
        await store.setSetting('githubConnectionStatus', { checkedAt: new Date().toISOString(), error: 'GitHub 授权无法续期，请重新连接。' });
        return { failed: true };
      });
      if (failure.failed) throw new Error('GitHub 授权无法续期，请重新连接。');
      return failure.token;
    }
  })();
  refreshes.set(store, refreshing);
  try { return await refreshing; } finally { if (refreshes.get(store) === refreshing) refreshes.delete(store); }
}

export function registerProviderOAuth(app: FastifyInstance, { store, publisherConfigured, environment = process.env }: { store: Store; publisherConfigured: boolean; environment?: Environment }): void {
  const providerOf = (params: unknown) => providers.parse((params as { provider: string }).provider);
  const available = async (provider: Provider) => {
    const result = await configuration(store, provider, environment);
    return provider === 'github' && publisherConfigured ? { ...result, configuration: undefined, reason: 'GitHub 由独立发布器连接，管理后台不能保存 GitHub 授权。' } : result;
  };
  app.get('/api/integrations/:provider/authorization', async req => {
    const result = await available(providerOf(req.params));
    return { configured: !!result.configuration, ...(result.callbackUrl ? { callbackUrl: result.callbackUrl } : {}), ...(result.reason ? { reason: result.reason } : {}) };
  });
  app.post('/api/integrations/:provider/authorize', async (req, reply) => {
    const provider = providerOf(req.params), result = await available(provider);
    if (!result.configuration) throw new Error(result.reason);
    if (!req.sessionId) throw new Error('请重新登录后授权。');
    const session = await store.vault.get<{ expires: number }>(`session:${req.sessionId}`);
    if (!session || session.expires <= Date.now()) throw new Error('请重新登录后授权。');
    const state = randomBytes(32).toString('hex'), nonce = randomBytes(32).toString('hex'), verifier = provider === 'github' ? randomBytes(32).toString('base64url') : undefined;
    const expiresAt = Date.now() + 600_000;
    await store.transaction(async () => {
      const generation = await advanceConnectionGeneration(store, provider);
      const entry: AuthorizationState = { provider, generation, sessionId: req.sessionId!, nonceHash: hash(nonce), expiresAt, callbackUrl: result.configuration!.callbackUrl, ...(verifier ? { verifier } : {}), used: false, status: 'pending' };
      const index = await store.getSetting<Array<{ key: string; expiresAt: number }>>('oauthStateIndex') ?? [];
      const keep = index.filter(item => item.expiresAt > Date.now()).slice(-31);
      for (const item of index) if (!keep.some(row => row.key === item.key)) await store.vault.delete(item.key);
      const key = stateKey(provider, state); await store.vault.set(key, entry);
      await store.setSetting('oauthStateIndex', [...keep, { key, expiresAt }]);
    });
    const url = provider === 'github' ? new URL('https://github.com/login/oauth/authorize') : new URL(`https://vercel.com/integrations/${result.configuration.slug}/new`);
    url.searchParams.set('state', state);
    if (provider === 'github') {
      url.searchParams.set('client_id', result.configuration.clientId);
      url.searchParams.set('redirect_uri', result.configuration.callbackUrl);
      url.searchParams.set('scope', 'offline_access');
      url.searchParams.set('code_challenge', createHash('sha256').update(verifier!).digest('base64url'));
      url.searchParams.set('code_challenge_method', 'S256');
    }
    reply.setCookie(nonceCookie(provider), nonce, { httpOnly: true, sameSite: 'lax', secure: result.configuration.callbackUrl.startsWith('https:'), path: cookiePath(provider), maxAge: 600 });
    return { url: url.toString(), state, expiresAt };
  });
  app.get('/api/integrations/:provider/authorization/status', async req => {
    const provider = providerOf(req.params), { state } = z.object({ state: opaque }).strict().parse(req.query);
    const saved = await store.vault.get<AuthorizationState>(stateKey(provider, state));
    if (!req.sessionId || !saved || saved.sessionId !== req.sessionId || saved.expiresAt <= Date.now()) throw new Error('授权已过期，请重新连接。');
    const session = await store.vault.get<{ expires: number }>(`session:${req.sessionId}`);
    if (!session || session.expires <= Date.now()) throw new Error('请重新登录后授权。');
    if (saved.status === 'pending' && saved.generation !== await connectionGeneration(store, provider)) return { status: 'failed', error: '连接状态已变更，请重新授权。' };
    return { status: saved.status, ...(saved.error ? { error: saved.error } : {}) };
  });
  app.post('/api/integrations/:provider/authorization/cancel', async req => {
    const provider = providerOf(req.params), { state } = z.object({ state: opaque }).strict().parse(req.body);
    await store.transaction(async () => {
      const key = stateKey(provider, state), saved = await store.vault.get<AuthorizationState>(key);
      if (!req.sessionId || !saved || saved.sessionId !== req.sessionId) throw new Error('授权已过期或不属于当前登录，无法取消。');
      const session = await store.vault.get<{ expires: number }>(`session:${req.sessionId}`);
      if (!session || session.expires <= Date.now()) throw new Error('请重新登录后取消授权。');
      if (saved.status === 'succeeded') throw new Error('授权已经完成，请重新检查连接状态。');
      if (saved.status === 'failed') return;
      await store.vault.set(key, { ...saved, used: true, status: 'failed', error: '授权已取消，请重新连接。' });
      // Cancelling an older window must not invalidate a newer authorization attempt.
      if (saved.generation === await connectionGeneration(store, provider)) await advanceConnectionGeneration(store, provider);
    });
    return { cancelled: true };
  });
  app.get('/api/integrations/:provider/callback', async (req, reply) => {
    const provider = providerOf(req.params);
    const query = z.object({ state: opaque, code: z.string().min(1).max(2048).optional(), error: z.string().max(1024).optional(), configurationId: z.string().max(256).optional(), next: z.string().max(2048).optional() }).passthrough().safeParse(req.query);
    if (!query.success) return reply.code(400).type('text/plain; charset=utf-8').send(callbackMessage);
    const key = stateKey(provider, query.data.state);
    let saved: AuthorizationState;
    try {
      saved = await store.transaction(async () => {
        const value = await store.vault.get<AuthorizationState>(key), nonce = req.cookies[nonceCookie(provider)];
        if (!value || value.used || value.provider !== provider || value.generation !== await connectionGeneration(store, provider) || value.expiresAt <= Date.now() || !nonce || !equal(hash(nonce), value.nonceHash)) throw new Error();
        const session = await store.vault.get<{ expires: number }>(`session:${value.sessionId}`);
        if (!session || session.expires <= Date.now()) throw new Error();
        await store.vault.set(key, { ...value, used: true });
        return value;
      });
    } catch { return reply.code(400).type('text/plain; charset=utf-8').send(callbackMessage); }
    reply.clearCookie(nonceCookie(provider), { path: cookiePath(provider) });
    try {
      const result = await available(provider);
      if (!result.configuration || result.configuration.callbackUrl !== saved.callbackUrl || query.data.error || !query.data.code) throw new Error();
      let next: string | undefined;
      if (provider === 'vercel' && query.data.next) {
        const destination = new URL(query.data.next);
        if (destination.origin !== 'https://vercel.com' || destination.username || destination.password) throw new Error();
        next = destination.toString();
      }
      const { clientId, clientSecret, callbackUrl } = result.configuration;
      const raw = await exchange(provider, new URLSearchParams({ client_id: clientId, client_secret: clientSecret, code: query.data.code, redirect_uri: callbackUrl, ...(saved.verifier ? { code_verifier: saved.verifier } : {}) }));
      let credential: ProviderCredential, fallback: string | undefined;
      if (provider === 'github') credential = githubCredential(raw, Date.now());
      else {
        const value = z.object({ access_token: secret, user_id: label, team_id: label.nullable().optional(), installation_id: label }).parse(raw);
        if (query.data.configurationId && value.installation_id !== query.data.configurationId) throw new Error();
        credential = { token: value.access_token, authorization: 'vercel-integration', installationId: value.installation_id, userId: value.user_id, ...(value.team_id ? { teamId: value.team_id } : {}) };
        fallback = value.user_id;
      }
      const login = await verifiedIdentity(provider, credential.token, fallback);
      await store.transaction(async () => {
        const session = await store.vault.get<{ expires: number }>(`session:${saved.sessionId}`);
        if (!session || session.expires <= Date.now()) throw new Error();
        if (saved.generation !== await connectionGeneration(store, provider)) throw new Error();
        await store.vault.set(provider, credential);
        await advanceConnectionGeneration(store, provider);
        await store.setSetting(`${provider}Login`, login);
        await store.setSetting(`${provider}ConnectionStatus`, { checkedAt: new Date().toISOString() });
        await store.vault.set(key, { ...saved, used: true, status: 'succeeded' });
      });
      if (next) return reply.code(303).redirect(next);
      return reply.type('text/html; charset=utf-8').send('<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>void0 · 授权完成</title><body><h1>连接成功</h1><p>授权已安全保存，可以关闭此窗口并返回 void0。</p></body></html>');
    } catch {
      await store.vault.set(key, { ...saved, used: true, status: 'failed', error: callbackMessage });
      return reply.code(400).type('text/plain; charset=utf-8').send(callbackMessage);
    }
  });
}
