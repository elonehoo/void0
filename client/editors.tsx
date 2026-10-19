import PublisherServiceEditor,{type ServiceEditorProps} from './PublisherServiceEditor';
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { NativeSelect } from "@/components/ui/native-select";
import { Switch } from "@/components/ui/switch";
import { useEffect, useState } from "react";
import {
  ArrowLeft,
  ArrowRight,
  Box,
  Check,
  CheckCircle2,
  ChevronRight,
  FolderClosed,
  GitBranch,
  Github,
  KeyRound,
  LoaderCircle,
  Plus,
  Search,
  Server as ServerIcon,
  ShieldCheck,
  Trash2,
} from "lucide-react";
import type {
  GitHubRepository,
  Project,
  Server,
  Service,
  WorkspaceSnapshot,
} from "../shared/types";
import { api, errorText, send } from "./api";
import {
  BusyLabel,
  CheckRow,
  Empty,
  ErrorNotice,
  Field,
  Loading,
  Modal,
  Notice,
  repositoryLabel,
  ResourceLabel,
} from "./ui";

export function ProjectEditor({
  project,
  snapshot,
  onClose,
  onSaved,
  onDeleted,
}: {
  project?: Project;
  snapshot: WorkspaceSnapshot;
  onClose: () => void;
  onSaved: (id: string) => Promise<void>;
  onDeleted: () => Promise<void>;
}) {
  const [name, setName] = useState(project?.name ?? "");
  const [description, setDescription] = useState(project?.description ?? "");
  const [selected, setSelected] = useState(project?.serviceIds ?? []);
  const [search, setSearch] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [deleting, setDeleting] = useState(false);
  const visible = snapshot.services.filter((s) =>
    s.name.toLowerCase().includes(search.toLowerCase()),
  );
  return (
    <Modal
      title={deleting ? "删除项目分组" : project ? "项目设置" : "新建项目"}
      subtitle={
        deleting
          ? project?.name
          : "按业务组织服务，项目可以同时包含多台服务器和 Vercel 的服务。"
      }
      onClose={onClose}
      wide
    >
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          if (deleting) return;
          setBusy(true);
          setError("");
          try {
            const value = await send<Project>(
              project ? `/projects/${project.id}` : "/projects",
              project ? "PUT" : "POST",
              { name, description, serviceIds: selected },
            );
            await onSaved(value.id);
          } catch (e) {
            setError(errorText(e));
          } finally {
            setBusy(false);
          }
        }}
      >
        <div className="modal-body">
          {deleting ? (
            <>
              <Notice>
                只删除「{project?.name}
                」的分组信息。服务器、服务、数据与部署记录都会保留。
              </Notice>
              <p className="body-copy">这些服务之后仍可被加入其他项目。</p>
            </>
          ) : (
            <>
              <div className="form-grid">
                <Field label="项目名称" required>
                  <Input
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    required
                    maxLength={80}
                    placeholder="例如 my-project"
                    autoFocus
                  />
                </Field>
                <Field label="描述">
                  <Input
                    value={description}
                    onChange={(e) => setDescription(e.target.value)}
                    maxLength={300}
                    placeholder="这个项目用来做什么？"
                  />
                </Field>
              </div>
              <div className="section-toolbar compact">
                <h3>
                  关联服务 <span className="muted">{selected.length}</span>
                </h3>
                <label className="search-field">
                  <Search size={14} />
                  <Input
                    placeholder="搜索服务…"
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                  />
                </label>
              </div>
              <div className="resource-picker">
                {visible.length ? (
                  visible.map((service) => {
                    const owner = snapshot.projects.find(
                      (p) =>
                        p.id !== project?.id &&
                        p.serviceIds.includes(service.id),
                    );
                    return (
                      <div className="resource-option" key={service.id}>
                        <CheckRow
                          title={service.name}
                          description={
                            owner
                              ? `当前属于 ${owner.name}，选中后移入此项目`
                              : service.kind === "vercel"
                                ? "Vercel"
                                : (snapshot.servers.find(
                                    (s) => s.id === service.serverId,
                                  )?.name ?? "未分组")
                          }
                          checked={selected.includes(service.id)}
                          onChange={(checked) =>
                            setSelected(
                              checked
                                ? [...selected, service.id]
                                : selected.filter((id) => id !== service.id),
                            )
                          }
                        />
                        <span className="resource-type">
                          {service.kind === "vercel"
                            ? "Vercel"
                            : service.kind === "kubernetes"
                              ? "Kubernetes"
                              : "Docker"}
                        </span>
                      </div>
                    );
                  })
                ) : (
                  <div className="small-empty">
                    {search
                      ? "没有匹配的服务。"
                      : "暂无可关联服务，创建项目后可以添加。"}
                  </div>
                )}
              </div>
            </>
          )}
          <ErrorNotice message={error} />
        </div>
        <div className="modal-footer">
          {project && !deleting ? (
            <Button
              type="button"
              variant="ghost" className="button danger subtle text-destructive"
              onClick={() => setDeleting(true)}
            >
              <Trash2 size={14} />
              删除分组
            </Button>
          ) : (
            <span />
          )}
          <div>
            <Button
              type="button"
              variant="outline" className="button"
              onClick={deleting ? () => setDeleting(false) : onClose}
            >
              {deleting ? "返回" : "取消"}
            </Button>
            {deleting ? (
              <Button
                type="button"
                variant="destructive" className="button danger-solid"
                disabled={busy}
                onClick={async () => {
                  setBusy(true);
                  setError("");
                  try {
                    await send(`/projects/${project!.id}`, "DELETE");
                    await onDeleted();
                  } catch (e) {
                    setError(errorText(e));
                  } finally {
                    setBusy(false);
                  }
                }}
              >
                <BusyLabel busy={busy}>确认删除分组</BusyLabel>
              </Button>
            ) : (
              <Button
                variant="default" className="button primary"
                disabled={busy || !name.trim()}
              >
                <BusyLabel busy={busy}>
                  {project ? "保存设置" : "创建项目"}
                </BusyLabel>
              </Button>
            )}
          </div>
        </div>
      </form>
    </Modal>
  );
}

export function ServerEditor({
  server,
  onClose,
  onSaved,
  onAgent,
}: {
  server?: Server;
  onClose: () => void;
  onSaved: () => Promise<void>;
  onAgent: (server: Server) => Promise<void>;
}) {
  const [name, setName] = useState(server?.name ?? "");
  const [host, setHost] = useState(server?.host ?? "");
  const [port, setPort] = useState(String(server?.port ?? 22));
  const [username, setUsername] = useState(server?.username ?? "ubuntu");
  const [notes, setNotes] = useState(server?.notes ?? "");
  const [saved, setSaved] = useState(server);
  const [accessMethod, setAccessMethod] = useState<"ssh" | "agent">(server?.connectionMode ?? (server ? "ssh" : "agent"));
  const [step, setStep] = useState<"details" | "credential">("details");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [fingerprint, setFingerprint] = useState<{
    fingerprint: string;
    hostKey: string;
  }>();
  const [reviewed, setReviewed] = useState(false);
  const [authMethod, setAuthMethod] = useState<"key" | "password">("key");
  const [password, setPassword] = useState("");
  const [privateKey, setPrivateKey] = useState("");
  const saveDetails = async () => {
    const value = await send<Server>(
      saved ? `/servers/${saved.id}` : "/servers",
      saved ? "PUT" : "POST",
      {
        name,
        host,
        connectionMode: accessMethod,
        port: Number(port),
        username,
        group: server?.group ?? "",
        notes,
      },
    );
    setSaved(value);
    return value;
  };
  const review = async () => {
    setBusy(true);
    setError("");
    try {
      const value = await saveDetails();
      const fp = await send<{ fingerprint: string; hostKey: string }>(
        `/servers/${value.id}/fingerprint`,
        "POST",
      );
      setFingerprint(fp);
      setReviewed(false);
      setStep("credential");
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      title={
        step === "credential"
          ? "验证服务器身份"
          : server
            ? "服务器连接设置"
            : "连接服务器"
      }
      subtitle={
        step === "credential"
          ? `${username}@${host}:${port}`
          : "通过 void0 OS 接入，也可使用 SSH 连接。"
      }
      onClose={onClose}
    >
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setError("");
          try {
            if (step === "details") {
              const value = await saveDetails();
              if (accessMethod === "agent" && !value.agent?.configured) {
                await onAgent(value);
                return;
              }
            } else {
              if (!saved || !fingerprint || !reviewed)
                throw new Error("请先核对服务器指纹。");
              await send(`/servers/${saved.id}/credentials`, "POST", {
                hostKey: fingerprint.hostKey,
                fingerprint: fingerprint.fingerprint,
                ...(authMethod === "key" ? { privateKey } : { password }),
              });
              setPrivateKey("");
              setPassword("");
            }
            await onSaved();
          } catch (e) {
            setError(errorText(e));
          } finally {
            setBusy(false);
          }
        }}
      >
        <div className="modal-body">
          {step === "details" ? (
            <>
              <Field label="显示名称" required>
                <Input
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  required
                  maxLength={100}
                  placeholder="例如 production-eu"
                  autoFocus
                />
              </Field>
              <Field label="接入方式">
                <NativeSelect value={accessMethod} onChange={(event) => setAccessMethod(event.target.value as "agent" | "ssh")}>
                  <option value="agent">void0 OS（主动连接管理平台）</option>
                  <option value="ssh">SSH（兼容方式）</option>
                </NativeSelect>
              </Field>
              <div className={`form-grid ${accessMethod === "ssh" ? "host-grid" : "agent-host-grid"}`}>
                <Field label="IP 地址或主机名" required>
                  <Input
                    value={host}
                    onChange={(e) => setHost(e.target.value)}
                    required
                    placeholder="203.0.113.10"
                    autoComplete="off"
                  />
                </Field>
                {accessMethod === "ssh" && <Field label="SSH 端口" required>
                  <Input
                    type="number"
                    min={1}
                    max={65535}
                    value={port}
                    onChange={(e) => setPort(e.target.value)}
                    required
                  />
                </Field>}
              </div>
              {accessMethod === "ssh" && <Field label="用户名" required>
                <Input
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  required
                  placeholder="ubuntu"
                  autoComplete="off"
                />
              </Field>}
              <Field label="备注">
                <Textarea
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                  rows={2}
                  placeholder="可选，方便日后识别这台服务器"
                />
              </Field>
              {accessMethod === "agent" ? (
                <Notice>
                  {server?.agent?.configured
                    ? `void0 OS ${server.agent.online ? "在线" : "离线"}。安装运行环境与接入分别管理，Docker 和 K3s 可按需安装。`
                    : "保存后可生成安装命令和一次性配对码，在服务器终端完成接入。无需向 void0 保存 SSH 密码。"}
                </Notice>
              ) : server?.credentialConfigured ? (
                <div className="credential-summary">
                  <ShieldCheck size={17} />
                  <span>已保存 SSH 登录凭据，保存连接信息不会显示或替换凭据。</span>
                </div>
              ) : (
                <Notice>需要验证主机指纹并配置 SSH 登录凭据，才能通过 SSH 管理服务。</Notice>
              )}
              {server?.connectionMode === "agent" && accessMethod === "ssh" && <p className="field-hint">当前通过 void0 OS 管理。配置 SSH 凭据后仍保留 void0 OS 连接，可在 void0 OS 设置中断开连接。</p>}
            </>
          ) : (
            <>
              <div className="fingerprint-card">
                <ShieldCheck size={22} />
                <div>
                  <strong>服务器 SSH 指纹</strong>
                  <code>{fingerprint?.fingerprint}</code>
                </div>
              </div>
              {server?.fingerprint &&
                server.fingerprint !== fingerprint?.fingerprint && (
                  <ErrorNotice message="这台服务器的指纹与原先保存的不同。确认服务器已更换或重装后再继续。" />
                )}
              <CheckRow
                title="已核对这台服务器的指纹"
                description="请与云厂商控制台或可信终端中的指纹对照。"
                checked={reviewed}
                onChange={setReviewed}
              />
              <div className="segmented auth-method">
                <Button
                  type="button"
                  variant={authMethod === "key" ? "secondary" : "ghost"} aria-pressed={authMethod === "key"} className={authMethod === "key" ? "selected" : ""}
                  onClick={() => {
                    setAuthMethod("key");
                    setPassword("");
                  }}
                >
                  SSH 私钥
                </Button>
                <Button
                  type="button"
                  variant={authMethod === "password" ? "secondary" : "ghost"} aria-pressed={authMethod === "password"} className={authMethod === "password" ? "selected" : ""}
                  onClick={() => {
                    setAuthMethod("password");
                    setPrivateKey("");
                  }}
                >
                  密码
                </Button>
              </div>
              {authMethod === "key" ? (
                <Field
                  label="SSH 私钥"
                  hint="粘贴完整的私钥内容；不支持需要交互输入口令的密钥。"
                >
                  <Textarea
                    className="monospace"
                    rows={6}
                    value={privateKey}
                    onChange={(e) => setPrivateKey(e.target.value)}
                    required
                    placeholder="-----BEGIN OPENSSH PRIVATE KEY-----"
                    spellCheck={false}
                    autoComplete="off"
                  />
                </Field>
              ) : (
                <Field label="登录密码">
                  <Input
                    type="password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    required
                    autoComplete="new-password"
                    placeholder="服务器登录密码"
                  />
                </Field>
              )}
              <p className="field-hint">
                凭据由管理后台保存，保存后不会再次显示。
              </p>
            </>
          )}
          <ErrorNotice message={error} />
        </div>
        <div className="modal-footer">
          <Button
            type="button"
            variant="outline" className="button"
            onClick={step === "credential" ? () => setStep("details") : onClose}
          >
            {step === "credential" ? (
              <>
                <ArrowLeft size={14} />
                返回
              </>
            ) : (
              "取消"
            )}
          </Button>
          <div>
            {step === "details" && accessMethod === "agent" && server?.agent?.configured && <Button type="button" variant="outline" disabled={busy} onClick={async () => {
              setBusy(true);
              setError("");
              try { await onAgent(await saveDetails()); }
              catch (error) { setError(errorText(error)); }
              finally { setBusy(false); }
            }}>管理 void0 OS</Button>}
            {step === "details" && accessMethod === "ssh" && (
              <Button
                type="button"
                variant="outline" className="button"
                disabled={
                  busy || !name.trim() || !host.trim() || !username.trim()
                }
                onClick={review}
              >
                <BusyLabel busy={busy}>
                  <KeyRound size={14} />
                  {server?.credentialConfigured
                    ? "更换登录凭据"
                    : "配置登录凭据"}
                </BusyLabel>
              </Button>
            )}
            <Button
              variant="default" className="button primary"
              disabled={
                busy ||
                (step === "credential" &&
                  (!reviewed ||
                    !(authMethod === "key" ? privateKey.trim() : password)))
              }
            >
              <BusyLabel busy={busy}>
                {step === "details" ? accessMethod === "agent" && !server?.agent?.configured ? "保存并安装 void0 OS" : "保存服务器" : "保存 SSH 凭据"}
              </BusyLabel>
            </Button>
          </div>
        </div>
      </form>
    </Modal>
  );
}

export function ServiceEditor(props:ServiceEditorProps) {
  return props.snapshot.platform?.publisherConfigured ? <PublisherServiceEditor {...props}/> : <ControllerServiceEditor {...props}/>;
}

function ControllerServiceEditor({
  service,
  project,
  snapshot,
  onClose,
  onSaved,
}: {
  service?: Service;
  project: Project;
  snapshot: WorkspaceSnapshot;
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const existing = Boolean(service);
  const compose = service?.kind === "compose";
  const [kind, setKind] = useState<"source" | "image">(
    !service || service.repository || service.kind === "source" || compose
      ? "source"
      : "image",
  );
  const [name, setName] = useState(service?.name ?? "");
  const [serverId, setServerId] = useState(
    service?.serverId ??
      (snapshot.servers.length === 1 ? snapshot.servers[0].id : ""),
  );
  const [repository, setRepository] = useState(
    service?.repository ? repositoryLabel(service.repository) : "",
  );
  const [branch, setBranch] = useState(service?.branch ?? "main");
  const [dockerfile, setDockerfile] = useState(
    service?.dockerfile ?? "Dockerfile",
  );
  const [context, setContext] = useState(service?.context ?? ".");
  const [image, setImage] = useState(service?.image ?? "");
  const [containerPort, setContainerPort] = useState(
    service?.containerPort ? String(service.containerPort) : "80",
  );
  const [hostPort, setHostPort] = useState(
    service?.hostPort ? String(service.hostPort) : "",
  );
  const [autoDeploy, setAutoDeploy] = useState(service?.autoDeploy ?? false);
  const [replaceEnvironment, setReplaceEnvironment] = useState(!existing);
  const [environment, setEnvironment] = useState("");
  const [replaceVolumes, setReplaceVolumes] = useState(!existing);
  const [volumes, setVolumes] = useState("");
  const [repositories, setRepositories] = useState<GitHubRepository[]>([]);
  const [branches, setBranches] = useState<string[]>([]);
  const [repositoryError, setRepositoryError] = useState("");
  const [loadingRepos, setLoadingRepos] = useState(false);
  const [loadingBranches, setLoadingBranches] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    if (!snapshot.integrations.github.connected) return;
    let live = true;
    setLoadingRepos(true);
    api<{ repositories: GitHubRepository[] }>("/github/repositories")
      .then((value) => {
        if (live) setRepositories(value.repositories);
      })
      .catch((e) => {
        if (live) setRepositoryError(errorText(e));
      })
      .finally(() => {
        if (live) setLoadingRepos(false);
      });
    return () => {
      live = false;
    };
  }, [snapshot.integrations.github.connected]);
  useEffect(() => {
    setBranches([]);
    if (
      !snapshot.integrations.github.connected ||
      !/^[-\w.]+\/[-\w.]+$/.test(repository)
    )
      return;
    let live = true;
    setLoadingBranches(true);
    api<{ branches: string[] }>(
      `/github/branches?repository=${encodeURIComponent(repository)}`,
    )
      .then((value) => {
        if (live) {
          setBranches(value.branches);
          setRepositoryError("");
        }
      })
      .catch((e) => {
        if (live) setRepositoryError(errorText(e));
      })
      .finally(() => {
        if (live) setLoadingBranches(false);
      });
    return () => {
      live = false;
    };
  }, [repository, snapshot.integrations.github.connected]);
  const parseEnvironment = () => {
    const values: Record<string, string> = {};
    for (const line of environment.split("\n")) {
      if (!line.trim() || line.trimStart().startsWith("#")) continue;
      const at = line.indexOf("=");
      if (at < 1 || !/^[_a-zA-Z][_a-zA-Z0-9]*$/.test(line.slice(0, at)))
        throw new Error("环境变量格式应为 NAME=value，每行一项。");
      values[line.slice(0, at)] = line.slice(at + 1);
    }
    return values;
  };
  const parseVolumes = () =>
    volumes
      .split("\n")
      .filter((line) => line.trim())
      .map((line) => {
        const at = line.indexOf(":");
        if (at < 1 || !line.slice(at + 1).startsWith("/"))
          throw new Error("存储卷格式应为 volume-name:/path，每行一项。");
        return { name: line.slice(0, at), mountPath: line.slice(at + 1) };
      });
  return (
    <Modal
      title={existing ? "配置服务" : "添加服务"}
      subtitle={`${project.name} · ${compose ? "保留现有 Compose 服务，只配置代码发布。" : "选择代码仓库或镜像，并指定部署位置。"}`}
      onClose={onClose}
      wide
    >
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setError("");
          try {
            const payload: Record<string, unknown> = {
              projectId: project.id,
              name,
              serverId,
              autoDeploy: kind === "source" ? autoDeploy : false,
            };
            if (!existing) payload.kind = kind;
            if (kind === "source") {
              Object.assign(payload, {
                repository,
                branch,
                dockerfile,
                context,
              });
            } else {
              payload.image = image;
            }
            if (!compose) {
              payload.containerPort = Number(containerPort);
              if (hostPort) payload.hostPort = Number(hostPort);
              if (replaceEnvironment) payload.environment = parseEnvironment();
              if (replaceVolumes) payload.volumes = parseVolumes();
            }
            await send(
              service ? `/services/${service.id}` : "/services",
              service ? "PUT" : "POST",
              payload,
            );
            await onSaved();
          } catch (e) {
            setError(errorText(e));
          } finally {
            setBusy(false);
          }
        }}
      >
        <div className="modal-body">
          <div className="source-selector">
            <Button
              type="button"
              variant="outline" aria-pressed={kind === "source"} className={kind === "source" ? "selected" : ""}
              disabled={existing && service?.kind === "image"}
              onClick={() => setKind("source")}
            >
              <Github size={21} />
              <strong>GitHub 仓库</strong>
              <small>从代码构建并部署</small>
              {kind === "source" && <CheckCircle2 size={15} />}
            </Button>
            <Button
              type="button"
              variant="outline" aria-pressed={kind === "image"} className={kind === "image" ? "selected" : ""}
              disabled={existing && service?.kind !== "image"}
              onClick={() => setKind("image")}
            >
              <Box size={21} />
              <strong>Docker 镜像</strong>
              <small>部署现有镜像</small>
              {kind === "image" && <CheckCircle2 size={15} />}
            </Button>
          </div>
          <div className="form-grid">
            <Field label="服务名称" required>
              <Input
                required
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="例如 web-api"
                maxLength={80}
              />
            </Field>
            <Field label="部署服务器" required>
              <NativeSelect
                required
                disabled={existing}
                value={serverId}
                onChange={(e) => setServerId(e.target.value)}
              >
                <option value="">选择一台服务器</option>
                {snapshot.servers.map((server) => (
                  <option key={server.id} value={server.id}>
                    {server.name} · {server.host}
                  </option>
                ))}
              </NativeSelect>
            </Field>
          </div>
          {snapshot.servers.length === 0 && (
            <Notice>请先在「服务器」页面添加并连接一台服务器。</Notice>
          )}
          {kind === "source" ? (
            <>
              <div className="section-label">
                <Github size={15} />
                <span>代码来源</span>
              </div>
              {!snapshot.integrations.github.connected && (
                <Notice>
                  需要在「设置与连接」中连接 GitHub，才能选择仓库并获取代码。
                </Notice>
              )}
              <div className="form-grid">
                <Field
                  label="GitHub 仓库"
                  required
                  hint={
                    loadingRepos
                      ? "正在获取仓库列表…"
                      : `${repositories.length} 个可访问仓库；可输入 owner/repository。`
                  }
                >
                  <Input
                    list="github-repositories"
                    required
                    value={repository}
                    onChange={(e) => {
                      const repo = repositories.find(
                        (r) => r.fullName === e.target.value,
                      );
                      setRepository(e.target.value);
                      if (repo && !existing) setBranch(repo.defaultBranch);
                    }}
                    placeholder="owner/repository"
                    autoComplete="off"
                  />
                  <datalist id="github-repositories">
                    {repositories.map((r) => (
                      <option key={r.id} value={r.fullName}>
                        {r.private ? "私有仓库" : "公开仓库"}
                      </option>
                    ))}
                  </datalist>
                </Field>
                <Field
                  label="发布分支"
                  required
                  hint={
                    loadingBranches
                      ? "正在获取分支…"
                      : "提交到这个分支的代码会用于部署。"
                  }
                >
                  <Input
                    list="github-branches"
                    required
                    value={branch}
                    onChange={(e) => setBranch(e.target.value)}
                    placeholder="main"
                    autoComplete="off"
                  />
                  <datalist id="github-branches">
                    {branches.map((b) => (
                      <option key={b} value={b} />
                    ))}
                  </datalist>
                </Field>
              </div>
              {repositoryError && <ErrorNotice message={repositoryError} />}
              <div className="form-grid">
                <Field label="Dockerfile 路径" required>
                  <Input
                    required
                    value={dockerfile}
                    onChange={(e) => setDockerfile(e.target.value)}
                    placeholder="Dockerfile"
                  />
                </Field>
                <Field label="构建目录" required>
                  <Input
                    required
                    value={context}
                    onChange={(e) => setContext(e.target.value)}
                    placeholder="."
                  />
                </Field>
              </div>
              <div className="automation-setting">
                <div>
                  <strong>代码更新后自动部署</strong>
                  <p>后台持续检查这个分支；浏览器关闭后仍会执行。</p>
                </div>
                <Switch
                  aria-label="代码更新后自动部署"
                  checked={autoDeploy}
                  onCheckedChange={setAutoDeploy}
                />
              </div>
              {autoDeploy && (
                <p className="field-hint">
                  只跟踪选定分支。保存配置后开始检查，进度会出现在部署记录中。
                </p>
              )}
            </>
          ) : (
            <Field
              label="镜像地址"
              required
              hint="公共镜像可直接使用；私有镜像需要目标服务器具备拉取权限。"
            >
              <Input
                required
                value={image}
                onChange={(e) => setImage(e.target.value)}
                placeholder="nginx:stable 或 registry.example.com/team/app:tag"
                spellCheck={false}
              />
            </Field>
          )}
          {compose ? (
            <Notice>
              目标为{" "}
              <strong>
                {service?.target.composeProject} /{" "}
                {service?.target.composeService}
              </strong>
              。现有端口、环境变量、网络和存储卷继续使用原来的 Compose 配置。
            </Notice>
          ) : (
            <details className="advanced-settings" open={!existing}>
              <summary>
                端口、环境变量与存储
                <ChevronRight size={14} />
              </summary>
              <div className="advanced-body">
                <div className="form-grid">
                  <Field label="容器端口" required>
                    <Input
                      type="number"
                      min={1}
                      max={65535}
                      value={containerPort}
                      required
                      onChange={(e) => setContainerPort(e.target.value)}
                    />
                  </Field>
                  <Field label="服务器端口" hint="不填写则不向服务器开放端口。">
                    <Input
                      type="number"
                      min={1}
                      max={65535}
                      value={hostPort}
                      onChange={(e) => setHostPort(e.target.value)}
                      placeholder="可选，例如 8080"
                    />
                  </Field>
                </div>
                {existing && (
                  <CheckRow
                    title="替换环境变量"
                    description="原有值不会显示；勾选后将以新输入的全部内容替换。"
                    checked={replaceEnvironment}
                    onChange={setReplaceEnvironment}
                  />
                )}
                <Field
                  label="环境变量"
                  hint="每行 NAME=value；包含密码的值保存后不会再次显示。"
                >
                  <Textarea
                    className="monospace"
                    rows={4}
                    disabled={!replaceEnvironment}
                    value={environment}
                    onChange={(e) => setEnvironment(e.target.value)}
                    placeholder={
                      existing && !replaceEnvironment
                        ? "保留服务器上原有的环境变量"
                        : "NODE_ENV=production"
                    }
                    spellCheck={false}
                    autoComplete="off"
                  />
                </Field>
                {existing && (
                  <CheckRow
                    title="替换存储卷配置"
                    description="请完整填写需要保留的存储卷。"
                    checked={replaceVolumes}
                    onChange={setReplaceVolumes}
                  />
                )}
                <Field label="存储卷" hint="每行 volume-name:/container/path。">
                  <Textarea
                    className="monospace"
                    rows={2}
                    disabled={!replaceVolumes}
                    value={volumes}
                    onChange={(e) => setVolumes(e.target.value)}
                    placeholder="app-data:/app/data"
                    spellCheck={false}
                  />
                </Field>
              </div>
            </details>
          )}
          <ErrorNotice message={error} />
        </div>
        <div className="modal-footer">
          <span className="muted small">
            {autoDeploy
              ? "开启自动部署后，后台会检查并发布所选分支。"
              : "保存后可检查配置，再确认部署。"}
          </span>
          <div>
            <Button type="button" variant="outline" className="button" onClick={onClose}>
              取消
            </Button>
            <Button
              variant="default" className="button primary"
              disabled={
                busy ||
                !serverId ||
                (kind === "source" &&
                  autoDeploy &&
                  !snapshot.integrations.github.connected)
              }
            >
              <BusyLabel busy={busy}>
                {existing ? "保存配置" : "添加服务"}
              </BusyLabel>
            </Button>
          </div>
        </div>
      </form>
    </Modal>
  );
}

export function VercelImport({
  project,
  snapshot,
  onClose,
  onSaved,
}: {
  project: Project;
  snapshot: WorkspaceSnapshot;
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const [projects, setProjects] = useState<
    Array<{
      id: string;
      name: string;
      accountId?: string;
      scopeSlug?: string;
      framework?: string;
    }>
  >([]);
  const [selected, setSelected] = useState<string[]>([]);
  const [loading, setLoading] = useState(
    snapshot.integrations.vercel.connected,
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [search, setSearch] = useState("");
  useEffect(() => {
    if (!snapshot.integrations.vercel.connected) return;
    let live = true;
    api<{ projects: typeof projects }>("/vercel/projects")
      .then((value) => {
        if (live) setProjects(value.projects);
      })
      .catch((e) => {
        if (live) setError(errorText(e));
      })
      .finally(() => {
        if (live) setLoading(false);
      });
    return () => {
      live = false;
    };
  }, [snapshot.integrations.vercel.connected]);
  return (
    <Modal
      title="导入 Vercel 服务"
      subtitle={`加入 ${project.name}，与其他服务一起管理。`}
      onClose={onClose}
    >
      <div className="modal-body">
        {!snapshot.integrations.vercel.connected ? (
          <Empty icon={GitBranch} title="尚未连接 Vercel">
            请在「设置与连接」中添加 Vercel Token，然后返回导入。
          </Empty>
        ) : loading ? (
          <Loading label="正在获取 Vercel 项目…" />
        ) : (
          <>
            <label className="search-field full">
              <Search size={15} />
              <Input
                placeholder="搜索 Vercel 项目…"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
            </label>
            <div className="resource-picker vercel-picker">
              {projects
                .filter((p) =>
                  p.name.toLowerCase().includes(search.toLowerCase()),
                )
                .map((item) => {
                  const service = snapshot.services.find(
                    (s) => s.target.vercelProjectId === item.id,
                  );
                  const owner = service
                    ? snapshot.projects.find((p) =>
                        p.serviceIds.includes(service.id),
                      )
                    : undefined;
                  const elsewhere = owner && owner.id !== project.id;
                  const included = owner?.id === project.id;
                  return (
                    <CheckRow
                      key={item.id}
                      title={item.name}
                      description={
                        included
                          ? "已在此项目中"
                          : elsewhere
                            ? `已在 ${owner.name} 中，请通过项目设置移动`
                            : (item.scopeSlug ?? item.framework ?? "Vercel")
                      }
                      checked={included || selected.includes(item.id)}
                      disabled={Boolean(owner)}
                      onChange={(checked) =>
                        setSelected(
                          checked
                            ? [...selected, item.id]
                            : selected.filter((id) => id !== item.id),
                        )
                      }
                    />
                  );
                })}
              {projects.length === 0 && (
                <div className="small-empty">没有可导入的 Vercel 项目。</div>
              )}
            </div>
          </>
        )}
        <ErrorNotice message={error} />
      </div>
      <div className="modal-footer">
        <span className="muted small">
          只关联服务，不改变 Vercel 的部署设置。
        </span>
        <div>
          <Button variant="outline" className="button" onClick={onClose}>
            取消
          </Button>
          <Button
            variant="default" className="button primary"
            disabled={busy || !selected.length}
            onClick={async () => {
              setBusy(true);
              setError("");
              try {
                await send("/vercel/import", "POST", {
                  projectId: project.id,
                  projectIds: selected,
                });
                await onSaved();
              } catch (e) {
                setError(errorText(e));
              } finally {
                setBusy(false);
              }
            }}
          >
            <BusyLabel busy={busy}>
              导入 {selected.length || ""} 个服务
            </BusyLabel>
          </Button>
        </div>
      </div>
    </Modal>
  );
}
