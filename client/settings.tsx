import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { NativeSelect } from "@/components/ui/native-select";
import { useState } from "react";
import {
  CheckCircle2,
  ChevronRight,
  ExternalLink as ExternalIcon,
  Github,
  Globe2,
  KeyRound,
  Link2,
  ShieldCheck,
  Unplug,
} from "lucide-react";
import type { WorkspaceSnapshot } from "../shared/types";
import { errorText, send } from "./api";
import {
  BusyLabel,
  ErrorNotice,
  ExternalLink,
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
  const [token, setToken] = useState("");
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
          <div className="integration-card">
            <span className="integration-logo github">
              <Github size={27} />
            </span>
            <div className="integration-info">
              <h3>
                GitHub{" "}
                {integration.github.connected && (
                  <span className="badge badge-green">
                    <span className="status-dot" />
                    已连接
                  </span>
                )}
              </h3>
              <p>
                {integration.github.connected
                  ? `已连接 ${integration.github.login ?? "GitHub 账号"}，可以选择仓库和分支。`
                  : snapshot.platform?.publisherConfigured ? "GitHub 由独立发布器连接，管理后台不保存源码访问凭据。" : "选择仓库，从代码构建 Docker 镜像并自动部署。"}
              </p>
              {integration.github.error && (
                <p className="inline-error">{integration.github.error}</p>
              )}
            </div>
            <div className="integration-actions">
              {integration.github.connected && (
                <Button
                  variant="ghost" size="icon" className="icon-button"
                  aria-label="断开 GitHub"
                  onClick={() => setDisconnect("github")}
                >
                  <Unplug size={16} />
                </Button>
              )}
              <Button
                variant="outline" className="button"
                disabled={snapshot.platform?.publisherConfigured}
                onClick={() => {
                  setConnection("github");
                  setToken("");
                  setError("");
                }}
              >
                {snapshot.platform?.publisherConfigured ? "由发布器连接" : integration.github.connected ? "更新凭据" : "连接 GitHub"}
                <ChevronRight size={14} />
              </Button>
            </div>
          </div>
          <div className="integration-card">
            <span className="integration-logo">
              <span className="vercel-triangle large" />
            </span>
            <div className="integration-info">
              <h3>
                Vercel{" "}
                {integration.vercel.connected && (
                  <span className="badge badge-green">
                    <span className="status-dot" />
                    已连接
                  </span>
                )}
              </h3>
              <p>
                {integration.vercel.connected
                  ? "导入项目与运行状态，自动发布继续由 Vercel 管理。"
                  : "将 Vercel 服务加入你的项目，统一查看运行状态。"}
              </p>
              {integration.vercel.error && (
                <p className="inline-error">{integration.vercel.error}</p>
              )}
            </div>
            <div className="integration-actions">
              {integration.vercel.connected && (
                <Button
                  variant="ghost" size="icon" className="icon-button"
                  aria-label="断开 Vercel"
                  onClick={() => setDisconnect("vercel")}
                >
                  <Unplug size={16} />
                </Button>
              )}
              <Button
                variant="outline" className="button"
                onClick={() => {
                  setConnection("vercel");
                  setToken("");
                  setError("");
                }}
              >
                {integration.vercel.connected ? "更新凭据" : "连接 Vercel"}
                <ChevronRight size={14} />
              </Button>
            </div>
          </div>
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
      {connection && (
        <Modal
          title={`连接 ${connection === "github" ? "GitHub" : "Vercel"}`}
          subtitle="保存后不会再次显示 Token。"
          onClose={() => {
            setConnection(undefined);
            setToken("");
            setError("");
          }}
        >
          <form
            onSubmit={async (e) => {
              e.preventDefault();
              setBusy(true);
              setError("");
              try {
                await send(`/integrations/${connection}`, "POST", { token });
                setToken("");
                await reload();
                setConnection(undefined);
              } catch (e) {
                setError(errorText(e));
              } finally {
                setBusy(false);
              }
            }}
          >
            <div className="modal-body">
              {connection === "github" ? (
                <>
                  <p className="body-copy">
                    添加可访问目标仓库的 GitHub Token，后台用它读取代码与分支。
                  </p>
                  <Notice>
                    使用 Fine-grained Token 时，为所需仓库授予{" "}
                    <strong>Contents: Read-only</strong> 和{" "}
                    <strong>Metadata: Read-only</strong> 权限即可。
                  </Notice>
                  <ExternalLink href="https://github.com/settings/personal-access-tokens/new">
                    在 GitHub 创建 Token
                  </ExternalLink>
                </>
              ) : (
                <>
                  <p className="body-copy">
                    添加拥有目标项目访问权限的 Vercel
                    Token，用于读取项目、域名与部署状态。
                  </p>
                  <ExternalLink href="https://vercel.com/account/settings/tokens">
                    在 Vercel 创建 Token
                  </ExternalLink>
                </>
              )}
              <Field
                label={`${connection === "github" ? "GitHub" : "Vercel"} Token`}
                required
              >
                <Input
                  type="password"
                  required
                  value={token}
                  onChange={(e) => setToken(e.target.value)}
                  autoComplete="new-password"
                  spellCheck={false}
                  autoFocus
                  placeholder="粘贴 Token"
                />
              </Field>
              <ErrorNotice message={error} />
            </div>
            <div className="modal-footer">
              <Button
                type="button"
                variant="outline" className="button"
                onClick={() => {
                  setConnection(undefined);
                  setToken("");
                }}
              >
                取消
              </Button>
              <Button
                variant="default" className="button primary"
                disabled={busy || !token.trim()}
              >
                <BusyLabel busy={busy}>保存并连接</BusyLabel>
              </Button>
            </div>
          </form>
        </Modal>
      )}
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
