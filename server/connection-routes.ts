import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { GitHub, IntegrationError, Vercel } from './integrations.js';
import { advanceConnectionGeneration, connectionGeneration, getProviderToken, type ProviderCredential } from './provider-oauth.js';
import type { Store } from './store.js';

type Provider = 'github' | 'vercel';
export interface ConnectionStatus { checkedAt: string; error?: string }
const credentialSchema = z.object({ token: z.string().trim().min(8).max(4096).regex(/^[\x21-\x7e]+$/) }).strict();
const accountName = z.string().trim().min(1).max(160).refine(value => !/[\x00-\x1f\x7f]/.test(value));
const providerSchema = z.enum(['github', 'vercel']);

async function identity(provider: Provider, token: string): Promise<string> {
  if (provider === 'github') return accountName.parse((await new GitHub(token).user()).login);
  const response = await new Vercel(token).api<{ user?: { username?: string; name?: string; uid?: string; id?: string } }>('/v2/user');
  return accountName.parse(response.user?.username || response.user?.name || response.user?.uid || response.user?.id);
}
function connectionError(provider: Provider, error: unknown): string {
  // Provider classes only expose fixed messages; transport errors can contain request credentials.
  return error instanceof IntegrationError ? error.message : `${provider === 'github' ? 'GitHub' : 'Vercel'} 连接检查失败，请稍后重试或更新 Token。`;
}
function allowControllerConnection(provider: Provider, publisherConfigured: boolean): void {
  if (provider === 'github' && publisherConfigured) throw new Error('独立发布器模式由发布器连接 GitHub，管理后台不保存 GitHub Token。请手动填写仓库地址。');
}

export function registerConnectionRoutes(app: FastifyInstance, { store, publisherConfigured }: { store: Store; publisherConfigured: boolean }): void {
  app.post('/api/integrations/:provider', async req => {
    const provider = providerSchema.parse((req.params as { provider: string }).provider);
    allowControllerConnection(provider, publisherConfigured);
    const { token } = credentialSchema.parse(req.body);
    const generation = await connectionGeneration(store, provider);
    let login: string;
    try { login = await identity(provider, token); }
    catch (error) { throw new Error(connectionError(provider, error)); }
    const checkedAt = new Date().toISOString();
    await store.transaction(async () => {
      if (generation !== await connectionGeneration(store, provider)) throw new Error('连接状态已变更，请重新连接。');
      await store.vault.set(provider, { token });
      await advanceConnectionGeneration(store, provider);
      await store.setSetting(`${provider}Login`, login);
      await store.setSetting(`${provider}ConnectionStatus`, { checkedAt } satisfies ConnectionStatus);
    });
    return { connected: true, login, checkedAt };
  });

  app.post('/api/integrations/:provider/check', async req => {
    const provider = providerSchema.parse((req.params as { provider: string }).provider);
    allowControllerConnection(provider, publisherConfigured);
    let current = await store.vault.get<ProviderCredential>(provider);
    if (!current) throw new Error(`请先连接 ${provider === 'github' ? 'GitHub' : 'Vercel'}。`);
    let login: string | undefined;
    let error: string | undefined;
    try {
      const token = await getProviderToken(store, provider);
      const latest = await store.vault.get<ProviderCredential>(provider);
      if (!token || latest?.token !== token) throw new Error('连接凭据已变更，请重新检查。');
      current = latest;
      if (provider === 'vercel' && current.authorization === 'vercel-integration') {
        if (!current.installationId) throw new Error('Vercel 安装记录缺失，请重新授权。');
        const query = current.teamId ? `?teamId=${encodeURIComponent(current.teamId)}` : '';
        const value = await new Vercel(token).api<{ id?: string; teamId?: string | null }>(`/v1/integrations/configuration/${encodeURIComponent(current.installationId)}${query}`);
        if (value.id !== current.installationId || 'teamId' in value && (value.teamId ?? undefined) !== current.teamId) throw new Error('Vercel 安装范围已变更，请重新授权。');
        login = accountName.parse(await store.getSetting<string>('vercelLogin') || current.userId);
      } else login = await identity(provider, token);
    }
    catch (cause) { error = connectionError(provider, cause); }
    const checkedAt = new Date().toISOString();
    await store.transaction(async () => {
      // Do not let a slow check overwrite the identity/status of replacement credentials.
      if ((await store.vault.get<{ token: string }>(provider))?.token !== current.token) throw new Error('连接凭据已变更，请重新检查。');
      await store.setSetting(`${provider}ConnectionStatus`, { checkedAt, ...(error ? { error } : {}) } satisfies ConnectionStatus);
      if (login) await store.setSetting(`${provider}Login`, login);
    });
    return { connected: !error, ...(login ? { login } : {}), checkedAt, ...(error ? { error } : {}) };
  });

  app.delete('/api/integrations/:provider', async req => {
    const provider = providerSchema.parse((req.params as { provider: string }).provider);
    await store.transaction(async () => {
      if (provider === 'github' && (await store.allServices()).some(service => service.autoDeploy)) throw new Error('请先暂停所有源码服务的自动发布，再断开 GitHub。');
      await store.vault.delete(provider);
      await advanceConnectionGeneration(store, provider);
      await store.setSetting(`${provider}Login`, null);
      await store.setSetting(`${provider}ConnectionStatus`, null);
      if (provider === 'vercel') {
        for (const service of (await store.allServices()).filter(service => service.kind === 'vercel')) await store.setSetting(`status:service:${service.id}`, null);
      }
    });
    return { ok: true };
  });
}
