import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useState } from "react";
import {
  CheckCircle2,
  ChevronRight,
  Github,
  Globe2,
  ShieldCheck,
  Unplug,
} from "lucide-react";
import type { WorkspaceSnapshot } from "../shared/types";
import { errorText, send } from "./api";
import IntegrationConnection from "./IntegrationConnection";
import {
  BusyLabel,
  ErrorNotice,
  Field,
  Modal,
  Notice,
} from "./ui";

export function SettingsPage({
  snapshot,
  reload,
}: {
  snapshot: WorkspaceSnapshot;
  reload: () => Promise<unknown>;
}) {
  const [connection, setConnection] = useState<"github" | "vercel">();
  const [disconnect, setDisconnect] = useState<"github" | "vercel">();
  const [checking, setChecking] = useState<"github" | "vercel">();
  const [connectionNotice, setConnectionNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [publicUrl, setPublicUrl] = useState(
    snapshot.integrations.publicUrl ?? "",
  );
  const [saved, setSaved] = useState(false);
  const integration = snapshot.integrations;
  return (
    <>
      <div className="page-heading">
        <div>
          <div className="eyebrow">工作空间</div>
          <h1>设置与连接</h1>
          <p>连接代码来源与云平台，凭据保存在你的管理后台。</p>
        </div>
      </div>
      <div className="settings-content">
        {snapshot.platform && <section className="settings-section">
          <div className="settings-section-heading"><h2>数据与发布</h2><p>管理数据与业务服务器上的应用数据分别保存。</p></div>
          <dl className="agent-summary">
            <div><dt>管理数据库</dt><dd>{snapshot.platform.storage === "postgresql" ? "PostgreSQL" : "SQLite"}</dd></div>
            <div><dt>独立发布器</dt><dd>{snapshot.platform.publisherConfigured ? "已配置" : "尚未配置"}</dd></div>
          </dl>
          <p className="field-hint">{snapshot.platform.publisherConfigured ? "部署内容由独立发布器确定并签名。服务器是否开启独立校验，可在服务器详情中查看。" : "当前由管理后台直接安排部署。配置独立发布器并在服务器开启校验后，可限制后台能够执行的发布内容。"}</p>
        </section>}
        <section className="settings-section">
          <div className="settings-section-heading">
            <h2>平台连接</h2>
            <p>一次连接，供工作空间中的所有项目使用。</p>
          </div>
          {(["github", "vercel"] as const).map(provider => {
            const details = integration[provider];
            const name = provider === "github" ? "GitHub" : "Vercel";
            const publisherManaged = provider === "github" && snapshot.platform?.publisherConfigured;
            return <div className="integration-card" key={provider}>
              <span className={`integration-logo ${provider === "github" ? "github" : ""}`}>
                {provider === "github" ? <Github size={27} /> : <span className="vercel-triangle large" />}
              </span>
              <div className="integration-info">
                <h3>{name}{details.connected && <span className={`badge ${details.error ? "badge-red" : "badge-green"}`}><span className="status-dot" />{details.error ? "连接异常" : "已连接"}</span>}</h3>
                <p>{publisherManaged
                  ? "GitHub 由独立发布器连接，管理后台不保存源码访问凭据。"
                  : details.connected
                    ? `账号：${details.login ?? name}。${provider === "github" ? "可以选择仓库、分支并发布代码。" : "可以导入项目、查看部署状态并绑定域名。"}`
                    : provider === "github" ? "连接 GitHub，选择仓库并部署 Docker 服务。" : "连接 Vercel，将托管服务放进你的项目。"}</p>
                {details.checkedAt && <p className="muted small">上次检查：{new Date(details.checkedAt).toLocaleString("zh-CN")}</p>}
                {details.error && <p className="inline-error" role="alert">{details.error}</p>}
              </div>
              <div className="integration-actions">
                {details.connected && <>
                  <Button variant="outline" className="button" disabled={!!checking || busy || publisherManaged} onClick={async () => {
                    setChecking(provider);
                    setError("");
                    setConnectionNotice("");
                    try {
                      const result = await send<{ connected: boolean }>(`/integrations/${provider}/check`, "POST");
                      await reload();
                      if (result.connected) setConnectionNotice(`${name} 连接有效。`);
                    } catch (cause) { setError(errorText(cause)); }
                    finally { setChecking(undefined); }
                  }}><BusyLabel busy={checking === provider}>检查连接</BusyLabel></Button>
                  <Button variant="ghost" size="icon" className="icon-button" aria-label={`断开 ${name}`} disabled={!!checking || busy} onClick={() => { setDisconnect(provider); setError(""); setConnectionNotice(""); }}><Unplug size={16} /></Button>
                </>}
                <Button variant="outline" className="button" disabled={publisherManaged || !!checking || busy} onClick={() => { setConnection(provider); setError(""); setConnectionNotice(""); }}>
                  {publisherManaged ? "由发布器连接" : details.connected ? "更新凭据" : `连接 ${name}`}<ChevronRight size={14} />
                </Button>
              </div>
            </div>;
          })}
          {connectionNotice && <p className="saved-label" role="status"><CheckCircle2 size={14} />{connectionNotice}</p>}
        </section>
        <section className="settings-section">
          <div className="settings-section-heading">
            <h2>访问地址</h2>
            <p>部署到管理服务器后，填写这个后台的 HTTPS 地址。</p>
          </div>
          <form
            className="settings-form-card"
            onSubmit={async (e) => {
              e.preventDefault();
              setBusy(true);
              setSaved(false);
              setError("");
              try {
                await send("/settings", "POST", {
                  publicUrl: publicUrl.trim(),
                });
                await reload();
                setSaved(true);
              } catch (e) {
                setError(errorText(e));
              } finally {
                setBusy(false);
              }
            }}
          >
            <Field
              label="管理后台地址"
              hint="本地验收时可以留空；代码检查与服务器上的任务仍可运行。"
            >
              <div className="input-with-icon">
                <Globe2 size={16} />
                <Input
                  type="url"
                  value={publicUrl}
                  onChange={(e) => {
                    setPublicUrl(e.target.value);
                    setSaved(false);
                  }}
                  placeholder="https://deploy.example.com"
                />
              </div>
            </Field>
            <div className="settings-form-bottom">
              <span className="muted small">
                {integration.webhookConfigured
                  ? "已配置外部访问地址"
                  : "尚未配置外部访问地址"}
              </span>
              <div>
                {saved && (
                  <span className="saved-label">
                    <CheckCircle2 size={14} />
                    已保存
                  </span>
                )}
                <Button variant="outline" className="button" disabled={busy}>
                  <BusyLabel busy={busy}>保存地址</BusyLabel>
                </Button>
              </div>
            </div>
          </form>
        </section>
        <section className="settings-section">
          <div className="settings-section-heading">
            <h2>数据与凭据</h2>
          </div>
          <div className="security-note">
            <ShieldCheck size={20} />
            <div>
              <strong>数据保存在管理服务器上</strong>
              <p>
                项目、发布记录与连接配置保存在后台；登录凭据单独加密保存。请备份数据目录及加密密钥，迁移管理服务器时需要一起恢复。
              </p>
            </div>
          </div>
        </section>
        <ErrorNotice message={!connection && !disconnect ? error : undefined} />
      </div>
      {connection && <IntegrationConnection provider={connection} onClose={() => setConnection(undefined)} onConnected={reload} />}
      {disconnect && (
        <Modal
          title={`断开 ${disconnect === "github" ? "GitHub" : "Vercel"} 连接`}
          onClose={() => setDisconnect(undefined)}
        >
          <div className="modal-body">
            <Notice>
              {disconnect === "github"
                ? "断开后，后台将无法获取仓库代码，依赖这个连接的后续发布会失败。"
                : "断开后，无法继续更新 Vercel 服务的状态。"}
            </Notice>
            <p className="body-copy">已导入的项目与服务仍然保留。</p>
            <ErrorNotice message={error} />
          </div>
          <div className="modal-footer">
            <Button variant="outline" className="button" onClick={() => setDisconnect(undefined)}>
              取消
            </Button>
            <Button
              variant="destructive" className="button danger-solid"
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                setError("");
                try {
                  await send(`/integrations/${disconnect}`, "DELETE");
                  await reload();
                  setDisconnect(undefined);
                } catch (e) {
                  setError(errorText(e));
                } finally {
                  setBusy(false);
                }
              }}
            >
              <BusyLabel busy={busy}>确认断开</BusyLabel>
            </Button>
          </div>
        </Modal>
      )}
    </>
  );
}
