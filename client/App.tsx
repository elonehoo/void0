import { useCallback, useEffect, useState } from "react";
import {
  Activity,
  ArrowDownToLine,
  ArrowLeft,
  ArrowRight,
  Box,
  CheckCircle2,
  ChevronRight,
  Clock3,
  ExternalLink as ExternalIcon,
  FolderClosed,
  GitBranch,
  Github,
  Layers3,
  LoaderCircle,
  LogOut,
  MoreHorizontal,
  Plus,
  RefreshCw,
  Search,
  Server as ServerIcon,
  Settings2,
  TerminalSquare,
  X,
} from "lucide-react";
import type {
  Job,
  Project,
  Server,
  Service,
  WorkspaceSnapshot,
} from "../shared/types";
import { api, errorText, send, setSession, type Session } from "./api";
import {
  Brand,
  BusyLabel,
  CheckRow,
  checkedTimeText,
  dateText,
  Empty,
  ErrorNotice,
  ExternalLink,
  Field,
  isFresh,
  JobBadge,
  Loading,
  Modal,
  Notice,
  relativeTime,
  repositoryLabel,
  repositoryURL,
  ResourceLabel,
  serviceState,
  stageText,
  StatusBadge,
} from "./ui";
import {
  ProjectEditor,
  ServerEditor,
  ServiceEditor,
  VercelImport,
} from "./editors";
import { SettingsPage } from "./settings";
import ExistingServiceImport from "./ExistingServiceImport";
import AuthPage from "./AuthPage";
import ServerBootstrapModal from "./ServerBootstrapModal";
import AgentConnection, { AgentSummary, serverCanControl } from "./AgentConnection";
import { KubernetesControls, KubernetesLogs } from "./KubernetesControls";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Separator } from "@/components/ui/separator";

type Route =
  | { page: "project"; id: string }
  | { page: "servers" }
  | { page: "settings" }
  | { page: "activity" };
type Popup =
  | { kind: "project"; project?: Project }
  | { kind: "server"; server?: Server }
  | { kind: "agent"; server: Server }
  | { kind: "service"; project: Project; service?: Service }
  | { kind: "import"; project: Project }
  | { kind: "detail"; service: Service }
  | { kind: "job"; job: Job }
  | { kind: "deploy"; service: Service }
  | null;
export default function App() {
  const [session, setCurrentSession] = useState<Session>();
  const [snapshot, setSnapshot] = useState<WorkspaceSnapshot>();
  const [error, setError] = useState("");
  const [route, setRoute] = useState<Route>({ page: "servers" });
  const [initialized, setInitialized] = useState(false);
  const [popup, setPopup] = useState<Popup>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [query, setQuery] = useState("");
  const sessionRefresh = useCallback(async () => {
    const value = await api<Session>("/session");
    setSession(value);
    setCurrentSession(value);
    return value;
  }, []);
  const reload = useCallback(async () => {
    const value = await api<WorkspaceSnapshot>("/workspace");
    setSnapshot(value);
    setError("");
    return value;
  }, []);
  useEffect(() => {
    sessionRefresh().catch((e) => setError(errorText(e)));
    const unauthorized = () => {
      setCurrentSession(undefined);
      setSnapshot(undefined);
      sessionRefresh().catch((e) => setError(errorText(e)));
    };
    window.addEventListener("serverdesk:unauthorized", unauthorized);
    return () =>
      window.removeEventListener("serverdesk:unauthorized", unauthorized);
  }, [sessionRefresh]);
  useEffect(() => {
    if (!session?.authenticated) return;
    reload()
      .then((value) => {
        if (!initialized) {
          if (value.projects[0])
            setRoute({ page: "project", id: value.projects[0].id });
          setInitialized(true);
        }
      })
      .catch((e) => setError(errorText(e)));
    const interval = setInterval(() => {
      reload().catch((e) => setError(errorText(e)));
    }, 10000);
    return () => clearInterval(interval);
  }, [session?.authenticated, reload, initialized]);
  const changed = async () => {
    await reload();
    setPopup(null);
  };
  const refresh = async () => {
    setRefreshing(true);
    try {
      await reload();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setRefreshing(false);
    }
  };
  if (!session)
    return (
      <div className="auth-shell">
        <Brand />
        {error ? (
          <ErrorNotice message={error} />
        ) : (
          <Loading label="正在连接 void0…" />
        )}
      </div>
    );
  if (!session.authenticated)
    return (
      <AuthPage
        session={session}
        onComplete={async () => {
          await sessionRefresh();
        }}
      />
    );
  if (!snapshot)
    return (
      <div className="auth-shell">
        <Brand />
        {error ? (
          <>
            <ErrorNotice message={error} />
            <Button variant="outline" onClick={refresh}>
              重试
            </Button>
          </>
        ) : (
          <Loading />
        )}
      </div>
    );
  const project =
    route.page === "project"
      ? snapshot.projects.find((p) => p.id === route.id)
      : undefined;
  const selectedService =
    popup && "service" in popup && popup.service
      ? (snapshot.services.find((s) => s.id === popup.service?.id) ??
        popup.service)
      : undefined;
  const projectForService = (service: Service) =>
    snapshot.projects.find((p) => p.serviceIds.includes(service.id));
  const routeTitle =
    project?.name ??
    (route.page === "servers"
      ? "服务器"
      : route.page === "activity"
        ? "任务记录"
        : route.page === "settings"
          ? "设置与连接"
          : "项目");
  return (
    <div className="app-shell">
      <aside className="sidebar">
        <nav className="primary-nav">
          <Button
            variant="ghost"
            className={route.page === "servers" ? "active" : ""}
            onClick={() => setRoute({ page: "servers" })}
          >
            <ServerIcon />
            <span>服务器</span>
            <small>{snapshot.servers.length}</small>
          </Button>
          <Button
            variant="ghost"
            className={route.page === "activity" ? "active" : ""}
            onClick={() => setRoute({ page: "activity" })}
          >
            <Activity />
            <span>任务记录</span>
          </Button>
        </nav>
        <div className="side-section-heading">
          <span>项目</span>
          <Button
            variant="ghost"
            size="icon"
            aria-label="新建项目"
            onClick={() => setPopup({ kind: "project" })}
          >
            <Plus size={14} />
          </Button>
        </div>
        <nav className="project-nav">
          {snapshot.projects.map((p) => (
            <Button
              key={p.id}
              variant="ghost"
              className={project?.id === p.id ? "active" : ""}
              onClick={() => {
                setRoute({ page: "project", id: p.id });
                setQuery("");
              }}
            >
              <FolderClosed />
              <span>{p.name}</span>
              <small>{p.serviceIds.length}</small>
            </Button>
          ))}
          {!snapshot.projects.length && (
            <span className="side-empty">还没有项目</span>
          )}
        </nav>
        <div className="sidebar-bottom">
          <Button
            variant="ghost"
            className={route.page === "settings" ? "active" : ""}
            onClick={() => setRoute({ page: "settings" })}
          >
            <Settings2 />
            <span>设置与连接</span>
          </Button>
          <Separator />
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" className="account-control">
                <span className="account-avatar">A</span>
                <span>
                  管理员<small>void0 {snapshot.version}</small>
                </span>
                <MoreHorizontal size={16} />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="w-48">
              <DropdownMenuLabel>管理员</DropdownMenuLabel>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                onClick={() =>
                  send("/logout", "POST")
                    .then(() => {
                      setSnapshot(undefined);
                      return sessionRefresh();
                    })
                    .catch((e) => setError(errorText(e)))
                }
              >
                <LogOut />
                退出登录
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </aside>
      <main className="main-panel">
        <header className="topbar">
          <div className="breadcrumb">
            <span>工作空间</span>
            <ChevronRight size={13} />
            <strong>{routeTitle}</strong>
          </div>
          <div className="topbar-actions">
            <span className="selfhosted-label">Self-hosted</span>
            <Button
              variant="ghost"
              size="icon"
              aria-label="刷新工作空间"
              onClick={refresh}
            >
              <RefreshCw size={15} className={refreshing ? "spin" : ""} />
            </Button>
          </div>
        </header>
        <div className="mobile-project-nav">
          <select
            aria-label="切换项目"
            value={route.page === "project" ? route.id : ""}
            onChange={(e) => {
              if (e.target.value)
                setRoute({ page: "project", id: e.target.value });
            }}
          >
            <option value="">选择项目</option>
            {snapshot.projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
          <Button
            variant="outline"
            size="icon"
            aria-label="新建项目"
            onClick={() => setPopup({ kind: "project" })}
          >
            <Plus size={15} />
          </Button>
        </div>
        <div className="page-content">
          {error && <ErrorNotice message={error} />}
          {route.page === "project" &&
            (project ? (
              <ProjectPage
                key={project.id}
                project={project}
                snapshot={snapshot}
                query={query}
                setQuery={setQuery}
                onEdit={() => setPopup({ kind: "project", project })}
                onAdd={() => setPopup({ kind: "service", project })}
                onImport={() => setPopup({ kind: "import", project })}
                onService={(service) => setPopup({ kind: "detail", service })}
                onJob={(job) => setPopup({ kind: "job", job })}
              />
            ) : (
              <Empty
                title="项目不存在"
                action={
                  <Button
                    variant="outline"
                    onClick={() => setPopup({ kind: "project" })}
                  >
                    新建项目
                  </Button>
                }
              />
            ))}
          {route.page === "servers" && (
            <ServersPage
              snapshot={snapshot}
              onAdd={() => setPopup({ kind: "server" })}
              onEdit={(server) => setPopup({ kind: "server", server })}
              reload={reload}
              onJob={(job) => setPopup({ kind: "job", job })}
            />
          )}
          {route.page === "activity" && (
            <ActivityPage
              snapshot={snapshot}
              onJob={(job) => setPopup({ kind: "job", job })}
            />
          )}
          {route.page === "settings" && (
            <SettingsPage snapshot={snapshot} reload={reload} />
          )}
        </div>
      </main>
      {popup?.kind === "project" && (
        <ProjectEditor
          project={popup.project}
          snapshot={snapshot}
          onClose={() => setPopup(null)}
          onSaved={async (id) => {
            await changed();
            setRoute({ page: "project", id });
          }}
          onDeleted={async () => {
            const next = await reload();
            setPopup(null);
            setRoute(
              next.projects[0]
                ? { page: "project", id: next.projects[0].id }
                : { page: "servers" },
            );
          }}
        />
      )}
      {popup?.kind === "server" && (
        <ServerEditor
          server={popup.server}
          onClose={() => setPopup(null)}
          onSaved={changed}
          onAgent={async (server) => {
            await reload();
            setPopup({ kind: "agent", server });
          }}
        />
      )}
      {popup?.kind === "agent" && (
        <AgentConnection
          server={snapshot.servers.find((s) => s.id === popup.server.id) ?? popup.server}
          publicUrl={snapshot.integrations.publicUrl}
          onClose={() => setPopup(null)}
          onChanged={reload}
        />
      )}
      {popup?.kind === "service" && (
        <ServiceEditor
          service={popup.service}
          project={popup.project}
          snapshot={snapshot}
          onClose={() => setPopup(null)}
          onSaved={changed}
        />
      )}
      {popup?.kind === "import" && (
        <VercelImport
          project={popup.project}
          snapshot={snapshot}
          onClose={() => setPopup(null)}
          onSaved={changed}
        />
      )}
      {popup?.kind === "detail" && selectedService && (
        <ServiceDetail
          service={selectedService}
          snapshot={snapshot}
          onClose={() => setPopup(null)}
          onEdit={() => {
            const p = projectForService(selectedService);
            if (p)
              setPopup({
                kind: "service",
                project: p,
                service: selectedService,
              });
          }}
          onDeploy={() =>
            setPopup({ kind: "deploy", service: selectedService })
          }
          onJob={(job) => setPopup({ kind: "job", job })}
          reload={reload}
        />
      )}
      {popup?.kind === "deploy" && selectedService && (
        <DeployConfirm
          service={selectedService}
          snapshot={snapshot}
          onClose={() => setPopup(null)}
          onJob={async (job) => {
            await reload();
            setPopup({ kind: "job", job });
          }}
        />
      )}
      {popup?.kind === "job" && (
        <JobDetail
          initial={popup.job}
          snapshot={snapshot}
          onClose={() => setPopup(null)}
          reload={reload}
        />
      )}
    </div>
  );
}
function ProjectPage({
  project,
  snapshot,
  query,
  setQuery,
  onEdit,
  onAdd,
  onImport,
  onService,
  onJob,
}: {
  project: Project;
  snapshot: WorkspaceSnapshot;
  query: string;
  setQuery: (s: string) => void;
  onEdit: () => void;
  onAdd: () => void;
  onImport: () => void;
  onService: (s: Service) => void;
  onJob: (j: Job) => void;
}) {
  const services = project.serviceIds
    .map((id) => snapshot.services.find((s) => s.id === id))
    .filter((s): s is Service => Boolean(s));
  const visible = services.filter((s) =>
    `${s.name} ${s.repository ?? ""} ${snapshot.servers.find((v) => v.id === s.serverId)?.name ?? ""}`
      .toLowerCase()
      .includes(query.toLowerCase()),
  );
  const jobs = snapshot.jobs
    .filter((j) => project.serviceIds.includes(j.serviceId))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const running = jobs.filter((j) => ["queued", "running"].includes(j.state));
  const ready = services.filter(
    (s) =>
      serviceState(snapshot.serviceStatuses.find((v) => v.serviceId === s.id))
        .tone === "green",
  ).length;
  const hasFreshStatus = services.some((service) => {
    const status = snapshot.serviceStatuses.find(
      (value) => value.serviceId === service.id,
    );
    return status && isFresh(status.checkedAt);
  });
  const locations = new Set(
    services
      .map((s) => (s.kind === "vercel" ? "vercel" : s.serverId))
      .filter(Boolean),
  ).size;
  return (
    <>
      <div className="page-heading">
        <div>
          <h1>{project.name}</h1>
          {project.description && <p>{project.description}</p>}
          <div className="project-meta">
            <span>{services.length} 个服务</span>
            <span className="metadata-dot" />
            <span>{locations} 个部署位置</span>
            <span className="metadata-dot" />
            <span>{hasFreshStatus ? `${ready} 个已确认运行` : "待检查"}</span>
          </div>
        </div>
        <div className="heading-actions">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" size="icon" aria-label="项目操作">
                <MoreHorizontal size={16} />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onClick={onEdit}>
                <Settings2 />
                项目设置
              </DropdownMenuItem>
              <DropdownMenuItem onClick={onImport}>
                <ArrowDownToLine />
                导入 Vercel 服务
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          <Button onClick={onAdd} size="sm">
            <Plus size={15} />
            添加服务
          </Button>
        </div>
      </div>
      {running.length > 0 && (
        <button className="running-banner" onClick={() => onJob(running[0])}>
          <LoaderCircle size={14} className="spin" />
          <span>
            {snapshot.services.find((s) => s.id === running[0].serviceId)
              ?.name ?? "服务"}{" "}
            正在部署
          </span>
          <small>{stageText(running[0].stage)}</small>
          <ChevronRight size={14} />
        </button>
      )}
      <Tabs defaultValue="services" className="workspace-tabs">
        <div className="page-tabs-bar">
          <TabsList variant="line">
            <TabsTrigger value="services">
              服务 <span>{services.length}</span>
            </TabsTrigger>
            <TabsTrigger value="deployments">
              任务记录 <span>{jobs.length}</span>
            </TabsTrigger>
          </TabsList>
        </div>
        <TabsContent value="services">
          <div className="table-toolbar">
            <div className="table-search">
              <Search size={14} />
              <Input
                placeholder="搜索服务…"
                aria-label="搜索服务"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
              {query && (
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label="清空搜索"
                  onClick={() => setQuery("")}
                >
                  <X size={13} />
                </Button>
              )}
            </div>
            <Button variant="outline" size="sm" onClick={onImport}>
              <ArrowDownToLine size={14} />
              导入 Vercel
            </Button>
          </div>
          {visible.length ? (
            <div className="data-table service-table">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="service-name-column">服务</TableHead>
                    <TableHead>状态</TableHead>
                    <TableHead>代码来源</TableHead>
                    <TableHead>部署位置</TableHead>
                    <TableHead>最近检查</TableHead>
                    <TableHead className="w-10" />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {visible.map((service) => {
                    const status = snapshot.serviceStatuses.find(
                      (s) => s.serviceId === service.id,
                    );
                    const source = service.repository
                      ? repositoryLabel(service.repository)
                      : service.kind === "vercel"
                        ? "Vercel Git"
                        : (service.image ?? kindText(service.kind));
                    return (
                      <TableRow
                        key={service.id}
                        className="clickable-row"
                        onClick={() => onService(service)}
                      >
                        <TableCell>
                          <button
                            className="service-name"
                            onClick={(e) => {
                              e.stopPropagation();
                              onService(service);
                            }}
                          >
                            <span className="row-service-icon">
                              {service.kind === "vercel" ? (
                                <span className="vercel-triangle" />
                              ) : service.repository ? (
                                <GitBranch size={15} />
                              ) : (
                                <Box size={15} />
                              )}
                            </span>
                            <span>
                              {service.name}
                              <small>{kindText(service.kind)}</small>
                            </span>
                          </button>
                        </TableCell>
                        <TableCell>
                          <StatusBadge status={status} />
                        </TableCell>
                        <TableCell>
                          <div className="table-source">
                            <span>{source}</span>
                            {service.repository && (
                              <small>
                                <GitBranch size={11} />
                                {service.branch ?? "main"}
                                {service.autoDeploy && (
                                  <span className="auto-label">自动部署</span>
                                )}
                              </small>
                            )}
                          </div>
                        </TableCell>
                        <TableCell>
                          <ResourceLabel
                            service={service}
                            servers={snapshot.servers}
                          />
                        </TableCell>
                        <TableCell className="time-cell">
                          {relativeTime(status?.checkedAt)}
                        </TableCell>
                        <TableCell>
                          <Button
                            variant="ghost"
                            size="icon"
                            className="row-open-button"
                            aria-label={`查看 ${service.name}`}
                            onClick={(e) => {
                              e.stopPropagation();
                              onService(service);
                            }}
                          >
                            <ChevronRight size={14} />
                          </Button>
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </div>
          ) : (
            <Empty
              icon={query ? Search : Box}
              title={query ? "没有匹配的服务" : "项目中还没有服务"}
              action={
                !query && (
                  <Button onClick={onAdd} size="sm">
                    <Plus size={15} />
                    添加服务
                  </Button>
                )
              }
            >
              {query
                ? "试试其他名称。"
                : "从 GitHub 仓库、Docker 镜像或已有资源添加服务。"}
            </Empty>
          )}
          <div className="table-footnote">
            <span>{visible.length} 个服务</span>
            <span>状态依据最近 2 分钟的检查</span>
          </div>
        </TabsContent>
        <TabsContent value="deployments">
          {jobs.length ? (
            <JobList jobs={jobs} snapshot={snapshot} onJob={onJob} />
          ) : (
            <Empty icon={TerminalSquare} title="暂无任务记录">
              这个项目的构建、发布和服务操作会显示在这里。
            </Empty>
          )}
        </TabsContent>
      </Tabs>
    </>
  );
}
function kindText(kind: string) {
  return (
    (
      {
        compose: "Docker Compose",
        kubernetes: "Kubernetes",
        container: "Docker 容器",
        image: "Docker 镜像",
        source: "GitHub 仓库",
        vercel: "Vercel",
      } as Record<string, string>
    )[kind] ?? kind
  );
}
function bytes(value?: number) {
  if (value === undefined) return "—";
  return value >= 1024 ** 3
    ? `${(value / 1024 ** 3).toFixed(1)} GB`
    : `${Math.round(value / 1024 ** 2)} MB`;
}
function PercentValue({ value, detail }: { value?: number; detail?: string }) {
  return (
    <div className="resource-value">
      <span>
        {value === undefined
          ? "—"
          : `${Math.round(Math.min(100, Math.max(0, value)))}%`}
      </span>
      {value !== undefined && (
        <span className="mini-meter">
          <span style={{ width: `${Math.min(100, Math.max(0, value))}%` }} />
        </span>
      )}
      {detail && <small>{detail}</small>}
    </div>
  );
}
function ServersPage({
  snapshot,
  onAdd,
  onEdit,
  reload,
  onJob,
}: {
  snapshot: WorkspaceSnapshot;
  onAdd: () => void;
  onEdit: (s: Server) => void;
  reload: () => Promise<unknown>;
  onJob: (j: Job) => void;
}) {
  const [busy, setBusy] = useState<string>();
  const [error, setError] = useState("");
  const [expanded, setExpanded] = useState<string>();
  const [importServer, setImportServer] = useState<Server>();
  const [bootstrap, setBootstrap] = useState<Server>();
  const [agentServer, setAgentServer] = useState<Server>();
  const check = async (server: Server) => {
    setBusy(server.id);
    setError("");
    try {
      await send(`/servers/${server.id}/refresh`, "POST");
      await reload();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(undefined);
    }
  };
  return (
    <>
      <div className="page-heading">
        <div>
          <h1>服务器</h1>
          <p>连接、检查并管理你的部署资源。</p>
        </div>
        <Button size="sm" onClick={onAdd}>
          <Plus size={15} />
          连接服务器
        </Button>
      </div>
      <ErrorNotice message={error} />
      {snapshot.servers.length ? (
        <>
          <div className="table-toolbar">
            <span className="table-caption">
              {snapshot.servers.length} 台服务器
            </span>
            <span className="table-caption">void0 OS / SSH</span>
          </div>
          <div className="data-table server-table">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>服务器</TableHead>
                  <TableHead>连接状态</TableHead>
                  <TableHead>CPU</TableHead>
                  <TableHead>内存</TableHead>
                  <TableHead>磁盘</TableHead>
                  <TableHead>最近检查</TableHead>
                  <TableHead className="w-10" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {snapshot.servers.map((server) => {
                  const status = snapshot.serverStatuses.find(
                    (s) => s.serverId === server.id,
                  );
                  const usesAgent = server.connectionMode === "agent";
                  const healthy =
                    status && isFresh(status.checkedAt) && !status.error && serverCanControl(server);
                  const memory =
                    healthy &&
                    status.memoryTotal &&
                    status.memoryAvailable !== undefined
                      ? (100 * (status.memoryTotal - status.memoryAvailable)) /
                        status.memoryTotal
                      : undefined;
                  const disk =
                    healthy &&
                    status.diskTotal &&
                    status.diskAvailable !== undefined
                      ? (100 * (status.diskTotal - status.diskAvailable)) /
                        status.diskTotal
                      : undefined;
                  return (
                    <TableRow
                      key={server.id}
                      className={expanded === server.id ? "selected-row" : ""}
                    >
                      <TableCell>
                        <button
                          className="service-name server-name"
                          onClick={() =>
                            setExpanded(
                              expanded === server.id ? undefined : server.id,
                            )
                          }
                        >
                          <span className="row-service-icon">
                            <ServerIcon size={15} />
                          </span>
                          <span>
                            {server.name}
                            <small>
                              {server.username}@{server.host}
                            </small>
                          </span>
                        </button>
                      </TableCell>
                      <TableCell>
                        <Badge
                          variant="outline"
                          className={`connection-badge ${(usesAgent ? server.agent?.configured && server.agent.online : healthy) ? "connected" : status?.error ? "connection-error" : ""}`}
                        >
                          <span className="status-dot" />
                          {usesAgent
                            ? !server.agent?.configured ? "OS 未接入" : server.agent.online ? "OS 在线" : "OS 离线"
                            : healthy ? "SSH 已连接" : status?.error ? "SSH 连接失败" : server.credentialConfigured ? "SSH 待检查" : "SSH 未配置"}
                        </Badge>
                      </TableCell>
                      <TableCell>
                        <PercentValue
                          value={healthy ? status.cpuPercent : undefined}
                        />
                      </TableCell>
                      <TableCell>
                        <PercentValue
                          value={memory}
                          detail={
                            healthy
                              ? `${bytes(status.memoryAvailable)} 可用`
                              : undefined
                          }
                        />
                      </TableCell>
                      <TableCell>
                        <PercentValue
                          value={disk}
                          detail={
                            healthy
                              ? `${bytes(status.diskAvailable)} 可用`
                              : undefined
                          }
                        />
                      </TableCell>
                      <TableCell className="time-cell">
                        {relativeTime(status?.checkedAt)}
                      </TableCell>
                      <TableCell>
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <Button
                              variant="ghost"
                              size="icon"
                              aria-label={`${server.name} 操作`}
                            >
                              <MoreHorizontal size={15} />
                            </Button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end">
                            <DropdownMenuItem
                              onClick={() =>
                                setExpanded(
                                  expanded === server.id
                                    ? undefined
                                    : server.id,
                                )
                              }
                            >
                              <ServerIcon />
                              查看详情
                            </DropdownMenuItem>
                            <DropdownMenuItem onClick={() => setAgentServer(server)}>
                              <TerminalSquare />
                              {server.agent?.configured ? "管理 void0 OS" : "安装 void0 OS"}
                            </DropdownMenuItem>
                            <DropdownMenuItem onClick={() => onEdit(server)}>
                              <Settings2 />
                              连接设置
                            </DropdownMenuItem>
                            <DropdownMenuItem
                              disabled={busy === server.id || !serverCanControl(server)}
                              onClick={() => check(server)}
                            >
                              <RefreshCw />
                              检查依赖
                            </DropdownMenuItem>
                            <DropdownMenuItem
                              onClick={() => setImportServer(server)}
                            >
                              <ArrowDownToLine />
                              导入现有服务
                            </DropdownMenuItem>
                            <DropdownMenuSeparator />
                            <DropdownMenuItem
                              disabled={busy === server.id || !serverCanControl(server)}
                              onClick={() => setBootstrap(server)}
                            >
                              <Plus />
                              安装运行环境
                            </DropdownMenuItem>
                          </DropdownMenuContent>
                        </DropdownMenu>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>
          {expanded &&
            (() => {
              const server = snapshot.servers.find((s) => s.id === expanded)!;
              const status = snapshot.serverStatuses.find(
                (s) => s.serverId === server.id,
              );
              const current =
                status && isFresh(status.checkedAt) && !status.error && serverCanControl(server);
              return (
                <section className="server-inspector">
                  <div className="server-inspector-heading">
                    <div>
                      <h2>{server.name}</h2>
                      <p>
                        {server.host}:{server.port}
                      </p>
                    </div>
                    <Button
                      variant="ghost"
                      size="icon"
                      aria-label="收起服务器详情"
                      onClick={() => setExpanded(undefined)}
                    >
                      <X size={15} />
                    </Button>
                  </div>
                  <AgentSummary server={server} />
                  {server.connectionMode === "agent" && !server.agent?.online && <Notice>void0 OS 当前未连接，恢复连接后才能向服务器发送指令。</Notice>}
                  {server.connectionMode !== "agent" && !server.credentialConfigured && <Notice>尚未配置 SSH 登录凭据。可安装 void0 OS 接入，或在连接设置中配置 SSH。</Notice>}
                  {status?.error && <ErrorNotice message={status.error} />}
                  <div className="server-dependencies">
                    {["Docker", "Compose", "Git", "K3s"].map((name, i) => {
                      const ok = current
                        ? [
                            status.dockerAvailable,
                            status.composeAvailable,
                            status.gitAvailable,
                            status.k3sAvailable,
                          ][i]
                        : undefined;
                      return (
                        <span key={name}>
                          {ok === true ? (
                            <CheckCircle2 size={13} />
                          ) : (
                            <Clock3 size={13} />
                          )}
                          <strong>{name}</strong>
                          <span>
                            {ok === undefined
                              ? "未检查"
                              : ok
                                ? "已安装"
                                : "未安装"}
                          </span>
                        </span>
                      );
                    })}
                    <span className="server-discovery-count">
                      {current
                        ? `已发现 ${status.services?.length ?? 0} 个服务`
                        : "服务列表待检查"}
                    </span>
                  </div>
                  {current && status.k3sAvailable && (
                    <p className="server-k3s-summary">
                      <strong>{status.k3sVersion ?? "K3s 版本未知"}</strong>
                      <span>
                        {status.k3sReady === true ? "节点就绪" : status.k3sReady === false ? "节点未就绪" : "节点状态未确认"}
                      </span>
                      {status.k3sNodeCount !== undefined && <span>{status.k3sNodeCount} 个节点</span>}
                    </p>
                  )}
                  <div className="server-inspector-actions">
                    <Button variant="outline" size="sm" onClick={() => setAgentServer(server)}>
                      <TerminalSquare size={14} />
                      {server.agent?.configured ? "管理 void0 OS" : "安装 void0 OS"}
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => onEdit(server)}
                    >
                      <Settings2 size={14} />
                      连接设置
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={busy === server.id || !serverCanControl(server)}
                      onClick={() => check(server)}
                    >
                      <BusyLabel busy={busy === server.id}>
                        <RefreshCw size={14} />
                        检查依赖
                      </BusyLabel>
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => setImportServer(server)}
                    >
                      <ArrowDownToLine size={14} />
                      导入现有服务
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={busy === server.id || !serverCanControl(server)}
                      onClick={() => setBootstrap(server)}
                    >
                      <Plus size={14} />
                      安装运行环境
                    </Button>
                  </div>
                </section>
              );
            })()}
        </>
      ) : (
        <Empty
          icon={ServerIcon}
          title="尚未连接服务器"
          action={
            <Button size="sm" onClick={onAdd}>
              <Plus size={15} />
              连接服务器
            </Button>
          }
        >
          使用 void0 OS 接入，或保留 SSH 连接方式。
        </Empty>
      )}
      {agentServer && (
        <AgentConnection
          server={snapshot.servers.find((s) => s.id === agentServer.id) ?? agentServer}
          publicUrl={snapshot.integrations.publicUrl}
          onClose={() => setAgentServer(undefined)}
          onChanged={reload}
        />
      )}
      {importServer && (
        <ExistingServiceImport
          server={importServer}
          snapshot={snapshot}
          onClose={() => setImportServer(undefined)}
          reload={reload}
        />
      )}
      {bootstrap && (
        <ServerBootstrapModal
          server={snapshot.servers.find((s) => s.id === bootstrap.id) ?? bootstrap}
          onClose={() => setBootstrap(undefined)}
          onJob={async (job) => {
            setBootstrap(undefined);
            await reload();
            onJob(job);
          }}
        />
      )}
    </>
  );
}
function ActivityPage({
  snapshot,
  onJob,
}: {
  snapshot: WorkspaceSnapshot;
  onJob: (j: Job) => void;
}) {
  return (
    <>
      <div className="page-heading">
        <div>
          <h1>任务记录</h1>
          <p>工作空间中的服务操作、构建、发布与依赖安装。</p>
        </div>
        <Badge variant="secondary">{snapshot.jobs.length} 条记录</Badge>
      </div>
      {snapshot.jobs.length ? (
        <JobList
          jobs={[...snapshot.jobs].sort((a, b) =>
            b.createdAt.localeCompare(a.createdAt),
          )}
          snapshot={snapshot}
          onJob={onJob}
        />
      ) : (
        <Empty icon={TerminalSquare} title="暂无任务记录">
          安装依赖、操作或部署服务后，可在这里查看进度与结果。
        </Empty>
      )}
    </>
  );
}
function jobLabel(job: Job) {
  if (job.type === "bootstrap") return job.bootstrap?.runtime === "k3s" ? "安装 K3s" : "安装 Docker";
  if (job.type === "kubernetes") return job.action ? ({ restart: "重启 Kubernetes 服务", stop: "停止 Kubernetes 服务", start: "启动 Kubernetes 服务" } as const)[job.action] : "Kubernetes 服务操作";
  return "部署服务";
}
function JobList({
  jobs,
  snapshot,
  onJob,
}: {
  jobs: Job[];
  snapshot: WorkspaceSnapshot;
  onJob: (j: Job) => void;
}) {
  return (
    <div className="data-table jobs-table">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>服务 / 任务</TableHead>
            <TableHead>状态</TableHead>
            <TableHead>执行阶段</TableHead>
            <TableHead>触发方式</TableHead>
            <TableHead>时间</TableHead>
            <TableHead className="w-10" />
          </TableRow>
        </TableHeader>
        <TableBody>
          {jobs.map((job) => (
            <TableRow
              key={job.id}
              className="clickable-row"
              onClick={() => onJob(job)}
            >
              <TableCell>
                <button
                  className="service-name"
                  onClick={(e) => {
                    e.stopPropagation();
                    onJob(job);
                  }}
                >
                  <span className="row-service-icon">
                    {["running", "queued"].includes(job.state) ? (
                      <LoaderCircle size={14} className="spin" />
                    ) : (
                      <GitBranch size={14} />
                    )}
                  </span>
                  <span>
                    {snapshot.services.find((s) => s.id === job.serviceId)
                      ?.name ??
                      snapshot.servers.find((s) => s.id === job.serverId)
                        ?.name ??
                      "服务"}
                    <small>
                      {jobLabel(job)}
                      {job.type === "deploy" && job.revision && ` · ${job.revision.slice(0, 7)}`}
                    </small>
                  </span>
                </button>
              </TableCell>
              <TableCell>
                <JobBadge job={job} />
              </TableCell>
              <TableCell className="secondary-cell">
                {stageText(job.stage)}
              </TableCell>
              <TableCell className="secondary-cell">
                {job.source === "github" ? "代码更新" : "手动"}
              </TableCell>
              <TableCell className="time-cell">
                {dateText(job.createdAt)}
              </TableCell>
              <TableCell>
                <ChevronRight size={14} className="text-muted-foreground" />
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
function ServiceDetail({
  service,
  snapshot,
  onClose,
  onEdit,
  onDeploy,
  onJob,
  reload,
}: {
  service: Service;
  snapshot: WorkspaceSnapshot;
  onClose: () => void;
  onEdit: () => void;
  onDeploy: () => void;
  onJob: (j: Job) => void;
  reload: () => Promise<unknown>;
}) {
  const [returnFocus] = useState(() =>
    document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null,
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const status = snapshot.serviceStatuses.find(
    (s) => s.serviceId === service.id,
  );
  const server = snapshot.servers.find((s) => s.id === service.serverId);
  const jobs = snapshot.jobs
    .filter((j) => j.serviceId === service.id)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const canDeploy =
    service.kind === "source" ||
    service.kind === "image" ||
    (service.kind === "compose" && Boolean(service.repository));
  const canEdit = !["vercel", "kubernetes", "container"].includes(service.kind);
  return (
    <Sheet
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <SheetContent
        className="service-sheet"
        onCloseAutoFocus={(event) => {
          if (returnFocus?.isConnected && !returnFocus.matches(":disabled")) {
            event.preventDefault();
            returnFocus.focus({ preventScroll: true });
          }
        }}
      >
        <SheetHeader>
          <div className="sheet-service-heading">
            <span className="row-service-icon">
              {service.kind === "vercel" ? (
                <span className="vercel-triangle" />
              ) : (
                <Box size={17} />
              )}
            </span>
            <div>
              <SheetTitle>{service.name}</SheetTitle>
              <SheetDescription>{kindText(service.kind)}</SheetDescription>
            </div>
          </div>
        </SheetHeader>
        <div className="service-sheet-content">
          <div className="sheet-status-row">
            <StatusBadge status={status} />
            <span>{relativeTime(status?.checkedAt)}</span>
            <Button
              variant="ghost"
              size="icon"
              aria-label="检查服务状态"
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                setError("");
                try {
                  await send(`/services/${service.id}/refresh`, "POST");
                  await reload();
                } catch (e) {
                  setError(errorText(e));
                } finally {
                  setBusy(false);
                }
              }}
            >
              <RefreshCw size={14} className={busy ? "spin" : ""} />
            </Button>
          </div>
          <ErrorNotice message={error} />
          {status?.message && (
            <p className="service-status-message">{status.message}</p>
          )}
          <Tabs defaultValue="overview">
            <TabsList variant="line" className="w-full justify-start">
              <TabsTrigger value="overview">概览</TabsTrigger>
              {service.kind === "kubernetes" && <TabsTrigger value="logs">运行日志</TabsTrigger>}
              <TabsTrigger value="history">
                {service.kind === "kubernetes" ? "操作记录" : "部署记录"} <span>{jobs.length}</span>
              </TabsTrigger>
            </TabsList>
            <TabsContent value="overview">
              <dl className="service-properties">
                <div>
                  <dt>部署位置</dt>
                  <dd>
                    {server?.name ?? "Vercel"}
                    {server && <small>{server.host}</small>}
                  </dd>
                </div>
                <div>
                  <dt>自动部署</dt>
                  <dd>
                    {service.kind === "vercel"
                      ? "由 Vercel 管理"
                      : service.autoDeploy
                        ? "已开启"
                        : "未开启"}
                  </dd>
                </div>
                {service.repository && (
                  <>
                    <div>
                      <dt>代码仓库</dt>
                      <dd>
                        <ExternalLink href={repositoryURL(service.repository)}>
                          {repositoryLabel(service.repository)}
                        </ExternalLink>
                      </dd>
                    </div>
                    <div>
                      <dt>发布分支</dt>
                      <dd>
                        <GitBranch size={13} />
                        {service.branch ?? "未配置"}
                      </dd>
                    </div>
                    <div>
                      <dt>构建配置</dt>
                      <dd>
                        <code>
                          {service.context ?? "."} /{" "}
                          {service.dockerfile ?? "Dockerfile"}
                        </code>
                      </dd>
                    </div>
                  </>
                )}
                {service.target.composeProject && (
                  <div>
                    <dt>Compose</dt>
                    <dd>
                      {service.target.composeProject} /{" "}
                      {service.target.composeService}
                    </dd>
                  </div>
                )}
                {service.target.namespace && (
                  <div>
                    <dt>Kubernetes</dt>
                    <dd>
                      {service.target.namespace} / {service.target.deployment}
                    </dd>
                  </div>
                )}
                {service.image && (
                  <div>
                    <dt>镜像</dt>
                    <dd>
                      <code>{service.image}</code>
                    </dd>
                  </div>
                )}
                {status?.url && (
                  <div>
                    <dt>访问地址</dt>
                    <dd>
                      <ExternalLink href={status.url}>
                        {status.url.replace(/^https?:\/\//, "")}
                      </ExternalLink>
                    </dd>
                  </div>
                )}
              </dl>
              {service.kind === "kubernetes" && (
                <KubernetesControls
                  service={service}
                  server={server}
                  activeJob={jobs.find((job) => ["queued", "running", "unknown"].includes(job.state))}
                  reload={reload}
                  onJob={onJob}
                />
              )}
              {service.kind === "container" && (
                <Notice>
                  当前可查看独立容器的状态；配置代码发布需要使用 Docker Compose
                  服务。
                </Notice>
              )}
              {service.kind === "vercel" && (
                <Notice>构建与自动发布继续由 Vercel 的 Git 集成处理。</Notice>
              )}
            </TabsContent>
            {service.kind === "kubernetes" && (
              <TabsContent value="logs"><KubernetesLogs service={service} server={server} /></TabsContent>
            )}
            <TabsContent value="history">
              {jobs.length ? (
                <div className="sheet-jobs">
                  {jobs.map((job) => (
                    <button
                      className="sheet-job-row"
                      key={job.id}
                      onClick={() => onJob(job)}
                    >
                      <div>
                        <JobBadge job={job} />
                        <small>{dateText(job.createdAt)}</small>
                      </div>
                      <span>
                        {stageText(job.stage)}
                        {job.revision && (
                          <code>{job.revision.slice(0, 7)}</code>
                        )}
                      </span>
                      <ChevronRight size={14} />
                    </button>
                  ))}
                </div>
              ) : (
                <div className="small-empty">
                  {service.kind === "kubernetes" ? "暂无通过 void0 操作的记录。" : "暂无通过 void0 发布的记录。"}
                </div>
              )}
            </TabsContent>
          </Tabs>
        </div>
        {(canEdit || canDeploy) && <SheetFooter className="service-sheet-footer">
          <div>
            {canEdit && (
              <Button variant="outline" onClick={onEdit}>
                <Settings2 size={14} />
                配置服务
              </Button>
            )}
            {canDeploy && (
              <Button onClick={onDeploy}>
                部署
                <ArrowRight size={14} />
              </Button>
            )}
          </div>
        </SheetFooter>}
      </SheetContent>
    </Sheet>
  );
}
function DeployConfirm({
  service,
  snapshot,
  onClose,
  onJob,
}: {
  service: Service;
  snapshot: WorkspaceSnapshot;
  onClose: () => void;
  onJob: (j: Job) => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const server = snapshot.servers.find((s) => s.id === service.serverId);
  return (
    <Modal title="确认部署" subtitle={service.name} onClose={onClose}>
      <div className="modal-body">
        <p className="body-copy">
          本次部署将更新以下服务。执行开始后，关闭网页不会停止部署。
        </p>
        <dl className="review-list">
          <div>
            <dt>目标服务器</dt>
            <dd>
              {server?.name}
              <small>{server?.host}</small>
            </dd>
          </div>
          <div>
            <dt>服务</dt>
            <dd>
              {service.target.composeProject
                ? `${service.target.composeProject} / ${service.target.composeService}`
                : service.name}
            </dd>
          </div>
          <div>
            <dt>{service.repository ? "代码仓库" : "镜像"}</dt>
            <dd>{service.repository ?? service.image}</dd>
          </div>
          {service.repository && (
            <>
              <div>
                <dt>分支</dt>
                <dd>{service.branch}</dd>
              </div>
              <div>
                <dt>构建文件</dt>
                <dd>
                  {service.context ?? "."} /{" "}
                  {service.dockerfile ?? "Dockerfile"}
                </dd>
              </div>
            </>
          )}
        </dl>
        <Notice>
          构建与发布由后台和目标服务器执行，进度与结果会保存在部署记录中。
        </Notice>
        <ErrorNotice message={error} />
      </div>
      <div className="modal-footer">
        <Button variant="outline" onClick={onClose}>
          取消
        </Button>
        <Button
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            setError("");
            try {
              await onJob(
                await send<Job>(`/services/${service.id}/deploy`, "POST"),
              );
            } catch (e) {
              setError(errorText(e));
            } finally {
              setBusy(false);
            }
          }}
        >
          <BusyLabel busy={busy}>
            确认部署
            <ArrowRight size={15} />
          </BusyLabel>
        </Button>
      </div>
    </Modal>
  );
}
function JobDetail({
  initial,
  snapshot,
  onClose,
  reload,
}: {
  initial: Job;
  snapshot: WorkspaceSnapshot;
  onClose: () => void;
  reload: () => Promise<unknown>;
}) {
  const [job, setJob] = useState(initial);
  const [acknowledge, setAcknowledge] = useState(false);
  const [reviewed, setReviewed] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const refresh = useCallback(async () => {
    try {
      const value = await api<Job>(`/jobs/${initial.id}`);
      setJob(value);
      setError("");
      if (!["queued", "running"].includes(value.state)) await reload();
    } catch (e) {
      setError(errorText(e));
    }
  }, [initial.id, reload]);
  useEffect(() => {
    void refresh();
    if (!["queued", "running", "unknown"].includes(job.state)) return;
    const t = setInterval(() => {
      void refresh();
    }, 2500);
    return () => clearInterval(t);
  }, [refresh, job.state]);
  const name =
    snapshot.services.find((s) => s.id === job.serviceId)?.name ??
    snapshot.servers.find((s) => s.id === job.serverId)?.name ??
    "部署";
  return (
    <Modal
      title={name}
      subtitle={`${jobLabel(job)}记录`}
      onClose={onClose}
      wide
    >
      <div className="modal-body job-detail">
        <div className="job-detail-header">
          <JobBadge job={job} />
          <strong>{stageText(job.stage)}</strong>
          <span>{dateText(job.createdAt)}</span>
          <Button
            variant="ghost"
            size="icon"
            aria-label="刷新任务记录"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              await refresh();
              setBusy(false);
            }}
          >
            <RefreshCw size={15} className={busy ? "spin" : ""} />
          </Button>
        </div>
        {job.message && (
          <div className="notice">
            <span>{job.message}</span>
          </div>
        )}
        <ErrorNotice message={error} />
        <>
          {acknowledge && (
            <div className="acknowledge-review">
              <Notice>
                此操作只将这条记录标记为已处理，不会停止服务器上的任务。请先确认服务器上的任务已经结束，避免新部署与旧任务同时运行。
              </Notice>
              <CheckRow
                title="已检查服务器，确认可以解除这条待确认记录"
                checked={reviewed}
                onChange={setReviewed}
              />
            </div>
          )}
        </>
        <div className="log-heading">
          <span>
            <TerminalSquare size={14} />
            执行日志
          </span>
          <small>
            {["running", "queued"].includes(job.state)
              ? "每 2.5 秒更新"
              : "记录已保存"}
          </small>
        </div>
        <pre className="job-log" tabIndex={0}>
          {job.log || "等待服务器返回日志…"}
        </pre>
        <div className="job-metadata">
          <span>
            {job.source === "github" ? "GitHub 代码更新" : "手动执行"}
          </span>
          {job.revision && <code>{job.revision.slice(0, 12)}</code>}
          <span>#{job.id.slice(0, 8)}</span>
        </div>
      </div>
      <div className="modal-footer">
        <span className="muted small">关闭网页后，后台仍会继续记录进度。</span>
        <div>
          {job.state === "unknown" &&
            (acknowledge ? (
              <Button
                variant="outline"
                disabled={busy || !reviewed}
                onClick={async () => {
                  setBusy(true);
                  setError("");
                  try {
                    const updated = await send<Job>(
                      `/jobs/${job.id}/acknowledge`,
                      "POST",
                    );
                    setJob(updated);
                    setAcknowledge(false);
                    await reload();
                  } catch (e) {
                    setError(errorText(e));
                  } finally {
                    setBusy(false);
                  }
                }}
              >
                <BusyLabel busy={busy}>确认已处理</BusyLabel>
              </Button>
            ) : (
              <Button variant="outline" onClick={() => setAcknowledge(true)}>
                处理待确认记录
              </Button>
            ))}
          <Button variant="outline" onClick={onClose}>
            关闭
          </Button>
        </div>
      </div>
    </Modal>
  );
}
