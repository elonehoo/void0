import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { api, errorText, send } from "./api";
import { BusyLabel, ErrorNotice, ExternalLink, Field, Modal, Notice } from "./ui";

interface Authorization { configured: boolean; callbackUrl?: string; reason?: string }
interface Attempt { state: string; url: string; expiresAt: number }
export default function IntegrationConnection({
  provider,
  onClose,
  onConnected,
}: {
  provider: "github" | "vercel";
  onClose: () => void;
  onConnected: () => Promise<unknown>;
}) {
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [authorization, setAuthorization] = useState<Authorization>();
  const [attempt, setAttempt] = useState<Attempt>();
  const [showToken, setShowToken] = useState(false);
  const [popupBlocked, setPopupBlocked] = useState(false);
  const popup = useRef<Window | null>(null);
  const closing = useRef(false);
  const pollingPaused = useRef(false);
  const callbacks = useRef({ onConnected, onClose });
  callbacks.current = { onConnected, onClose };
  const name = provider === "github" ? "GitHub" : "Vercel";
  useEffect(() => {
    let cancelled = false;
    api<Authorization>(`/integrations/${provider}/authorization`).then(value => { if (!cancelled) setAuthorization(value); }).catch(cause => { if (!cancelled) setError(errorText(cause)); });
    return () => { cancelled = true; };
  }, [provider]);
  useEffect(() => {
    if (!attempt) return;
    let cancelled = false, checking = false;
    const check = async () => {
      if (checking || cancelled || pollingPaused.current) return;
      checking = true;
      try {
        const value = await api<{ status: "pending" | "succeeded" | "failed"; error?: string }>(`/integrations/${provider}/authorization/status?state=${encodeURIComponent(attempt.state)}`);
        if (cancelled || pollingPaused.current) return;
        if (value.status === "succeeded") {
          cancelled = true;
          setAttempt(undefined);
          setBusy(true);
          try { popup.current?.close(); } catch { /* Authorization completion is confirmed by the backend. */ }
          try { await callbacks.current.onConnected(); callbacks.current.onClose(); }
          catch (cause) { setError(errorText(cause)); }
          finally { setBusy(false); }
        } else if (value.status === "failed") {
          setAttempt(undefined);
          setError(value.error ?? "官方授权未完成，请重新连接。");
        } else if (Date.now() >= attempt.expiresAt) {
          setAttempt(undefined);
          setError("授权已过期，请重新连接。");
        }
      } catch (cause) {
        if (!cancelled) { setAttempt(undefined); setError(errorText(cause)); }
      } finally {
        checking = false;
        if (!cancelled && !closing.current) setBusy(false);
      }
    };
    const timer = window.setInterval(() => { void check(); }, 2000);
    void check();
    return () => { cancelled = true; window.clearInterval(timer); };
  }, [attempt, provider]);
  const close = async () => {
    if (closing.current || busy) return;
    closing.current = true;
    pollingPaused.current = true;
    setBusy(true);
    setError("");
    try {
      if (attempt) await send(`/integrations/${provider}/authorization/cancel`, "POST", { state: attempt.state });
      try { popup.current?.close(); } catch { /* The official page may have severed the window reference. */ }
      onClose();
    } catch (cause) { pollingPaused.current = false; setError(errorText(cause)); }
    finally { closing.current = false; setBusy(false); }
  };
  return (
    <Modal title={`连接 ${name}`} subtitle="优先使用官方授权，权限由平台确认；凭据只保存在你的后台。" onClose={() => { void close(); }}>
      <form onSubmit={async event => {
        event.preventDefault();
        setBusy(true);
        setError("");
        try {
          await send(`/integrations/${provider}`, "POST", { token: token.trim() });
          setToken("");
          await onConnected();
          onClose();
        } catch (cause) {
          setError(errorText(cause));
        } finally {
          setBusy(false);
        }
      }}>
        <div className="modal-body">
          {authorization ? authorization.configured ? <>
            <p className="body-copy">{provider === "github" ? "通过 GitHub App 授权访问已安装并允许的仓库。" : "通过 Vercel Integration 安装授权，选择需要管理的 Team 与项目。"}</p>
            <Button type="button" className="button primary w-full" disabled={busy || !!attempt} onClick={async () => {
              setBusy(true); setError(""); setPopupBlocked(false);
              popup.current = window.open("about:blank", "_blank", "width=600,height=760");
              if (popup.current) popup.current.opener = null;
              pollingPaused.current = false;
              try {
                const value = await send<Attempt>(`/integrations/${provider}/authorize`, "POST");
                setAttempt(value);
                if (popup.current) popup.current.location.href = value.url;
                else setPopupBlocked(true);
              } catch (cause) { popup.current?.close(); setError(errorText(cause)); }
              finally { setBusy(false); }
            }}><BusyLabel busy={busy || !!attempt}>{attempt ? "等待完成官方授权" : `前往 ${name} 授权`}</BusyLabel></Button>
            {attempt && <Notice>{popupBlocked ? "浏览器阻止了弹窗，请使用下方链接完成授权。" : "请在打开的官方页面完成授权，成功后此处会自动更新。"}<br /><ExternalLink href={attempt.url}>打开官方授权页面</ExternalLink></Notice>}
          </> : <Notice>{authorization.reason ?? "此后台尚未配置官方应用。"}{authorization.callbackUrl && <p className="field-hint break-all">应用回调地址：{authorization.callbackUrl}</p>}<ExternalLink href="https://github.com/elonehoo/void0/blob/main/docs/provider-oauth.md">查看官方授权配置说明</ExternalLink></Notice> : <p className="muted small">正在检查官方授权配置…</p>}
          <Button type="button" variant="ghost" className="button" disabled={busy || !!attempt} onClick={() => { setShowToken(!showToken); setError(""); }}>{showToken ? "收起备用连接" : "使用 Token 备用连接"}</Button>
          {showToken && <>
            {provider === "github" ? <>
              <p className="body-copy">创建 Fine-grained personal access token，选择需要部署的仓库和合适的有效期。</p>
              <Notice>读取仓库与自动检查代码版本需要 <strong>Contents: Read-only</strong> 和 <strong>Metadata: Read-only</strong>。仅在需要自动注册 GitHub Webhook 时添加 <strong>Webhooks: Read and write</strong>。</Notice>
              <ExternalLink href="https://github.com/settings/personal-access-tokens/new">在 GitHub 创建 Token</ExternalLink>
            </> : <>
              <p className="body-copy">创建可访问目标项目的 Vercel Token，Scope 选择项目所属账号或 Team，并设置合适的有效期。</p>
              <Notice>此连接用于读取项目、部署状态和管理项目域名。Vercel 的 Token 可授予所选范围内的其他操作权限，请仅选择需要管理的 Scope。</Notice>
              <ExternalLink href="https://vercel.com/account/settings/tokens">在 Vercel 创建 Token</ExternalLink>
            </>}
            <Field label={`${name} Token`} required hint="Token 只发送到你自己的 void0 后台，不会保存在浏览器中。">
              <Input type="password" required value={token} onChange={event => setToken(event.target.value)} autoComplete="new-password" spellCheck={false} autoFocus disabled={busy || !!attempt} placeholder="粘贴 Token" />
            </Field>
          </>}
          <ErrorNotice message={error} />
        </div>
        <div className="modal-footer">
          <Button type="button" variant="outline" className="button" disabled={busy} onClick={() => { void close(); }}>取消</Button>
          {showToken && <Button className="button primary" disabled={busy || !!attempt || !token.trim()}><BusyLabel busy={busy}>验证并连接</BusyLabel></Button>}
        </div>
      </form>
    </Modal>
  );
}
