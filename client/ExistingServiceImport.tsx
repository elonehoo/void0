import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { NativeSelect } from "@/components/ui/native-select";
import { useState } from "react";
import {
  ArrowDownToLine,
  CheckCircle2,
  RefreshCw,
  Search,
  Server as ServerIcon,
} from "lucide-react";
import type {
  RuntimeService,
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
  Modal,
  Notice,
  checkedTimeText,
} from "./ui";

function runtimeKey(service: RuntimeService) {
  if (service.kind === "Kubernetes")
    return `kubernetes:${service.namespace ?? ""}:${service.deployment ?? service.name}`;
  if (service.composeProject && service.composeService)
    return `compose:${service.composeProject}:${service.composeService}`;
  return `container:${service.name}`;
}
function matches(existing: Service, runtime: RuntimeService, serverId: string) {
  if (existing.serverId !== serverId) return false;
  if (runtime.kind === "Kubernetes")
    return (
      existing.target.namespace === runtime.namespace &&
      existing.target.deployment === (runtime.deployment ?? runtime.name)
    );
  if (runtime.composeProject && runtime.composeService)
    return (
      existing.target.composeProject === runtime.composeProject &&
      existing.target.composeService === runtime.composeService
    );
  return existing.target.containerName === runtime.name;
}
function runtimeDescription(service: RuntimeService) {
  if (service.kind === "Kubernetes")
    return `Kubernetes · ${service.namespace ?? "未知命名空间"} / ${service.deployment ?? service.name}`;
  if (service.composeProject && service.composeService)
    return `Docker Compose · ${service.composeProject} / ${service.composeService}`;
  return `Docker 容器 · ${service.name}`;
}
export default function ExistingServiceImport({
  server,
  snapshot,
  onClose,
  reload,
}: {
  server: Server;
  snapshot: WorkspaceSnapshot;
  onClose: () => void;
  reload: () => Promise<unknown>;
}) {
  const [projectId, setProjectId] = useState(
    snapshot.projects.length === 1 ? snapshot.projects[0].id : "",
  );
  const [selected, setSelected] = useState<string[]>([]);
  const [search, setSearch] = useState("");
  const [busy, setBusy] = useState<"refresh" | "import">();
  const [error, setError] = useState("");
  const [result, setResult] = useState<{ imported: number; ignored: number }>();
  const status = snapshot.serverStatuses.find(
    (value) => value.serverId === server.id,
  );
  const services = [
    ...new Map(
      (status?.services ?? []).map((service) => [runtimeKey(service), service]),
    ).values(),
  ];
  const visible = services.filter((service) =>
    `${service.name} ${service.composeProject ?? ""} ${service.namespace ?? ""}`
      .toLowerCase()
      .includes(search.toLowerCase()),
  );
  const available = services.filter(
    (runtime) =>
      !snapshot.services.some((existing) =>
        matches(existing, runtime, server.id),
      ),
  );
  const chosen = available.filter((service) =>
    selected.includes(runtimeKey(service)),
  );
  const refresh = async () => {
    setBusy("refresh");
    setError("");
    try {
      await send(`/servers/${server.id}/refresh`, "POST");
      await reload();
      setSelected([]);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(undefined);
    }
  };
  return (
    <Modal
      title="导入现有服务"
      subtitle={`${server.name} · ${server.host}`}
      onClose={onClose}
      wide
    >
      <div className="modal-body">
        {result ? (
          <>
            <div className="notice">
              <CheckCircle2 size={17} />
              <span>
                已导入 <strong>{result.imported}</strong> 个服务。
                {result.ignored > 0 &&
                  `另有 ${result.ignored} 个服务已关联，未重复导入。`}
              </span>
            </div>
            <p className="body-copy">
              所选服务已加入项目。服务器上现有的容器、部署方式与数据保持不变。
            </p>
          </>
        ) : (
          <>
            <Notice>
              导入只添加管理关联，不会重建、重启或移动服务器上的服务。已有服务的自动部署默认关闭。
            </Notice>
            <Field
              label="加入项目"
              required
              hint={
                snapshot.projects.length === 0
                  ? "请关闭此窗口，新建一个项目后再导入。"
                  : undefined
              }
            >
              <NativeSelect
                value={projectId}
                onChange={(e) => setProjectId(e.target.value)}
                disabled={Boolean(busy) || snapshot.projects.length === 0}
              >
                <option value="">选择一个项目</option>
                {snapshot.projects.map((project) => (
                  <option key={project.id} value={project.id}>
                    {project.name}
                  </option>
                ))}
              </NativeSelect>
            </Field>
            <div className="section-toolbar compact">
              <div>
                <h3>
                  发现的服务 <span className="muted">{services.length}</span>
                </h3>
                <p className="field-hint">
                  {checkedTimeText(status?.checkedAt)}
                </p>
              </div>
              <Button
                variant="outline" size="sm" className="button small"
                disabled={Boolean(busy)}
                onClick={refresh}
              >
                <BusyLabel busy={busy === "refresh"}>
                  <RefreshCw size={13} />
                  检查服务器
                </BusyLabel>
              </Button>
            </div>
            {status?.error && <ErrorNotice message={status.error} />}
            {services.length > 0 ? (
              <>
                <label className="search-field full">
                  <Search size={15} />
                  <Input
                    aria-label="搜索发现的服务"
                    placeholder="搜索服务、Compose 项目或命名空间…"
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                  />
                </label>
                <div className="resource-picker vercel-picker">
                  {visible.map((runtime) => {
                    const existing = snapshot.services.find((service) =>
                      matches(service, runtime, server.id),
                    );
                    const owner = existing
                      ? snapshot.projects.find((project) =>
                          project.serviceIds.includes(existing.id),
                        )
                      : undefined;
                    return (
                      <div
                        className="resource-option"
                        key={runtimeKey(runtime)}
                      >
                        <CheckRow
                          title={
                            runtime.composeService ??
                            runtime.deployment ??
                            runtime.name
                          }
                          description={
                            existing
                              ? `已关联${owner ? `至 ${owner.name}` : "，可在项目设置中添加关联"}`
                              : runtimeDescription(runtime)
                          }
                          checked={
                            Boolean(existing) ||
                            selected.includes(runtimeKey(runtime))
                          }
                          disabled={Boolean(existing) || Boolean(busy)}
                          onChange={(checked) =>
                            setSelected(
                              checked
                                ? [...selected, runtimeKey(runtime)]
                                : selected.filter(
                                    (key) => key !== runtimeKey(runtime),
                                  ),
                            )
                          }
                        />
                        <span className="resource-type">
                          {existing
                            ? "已关联"
                            : runtime.kind === "Kubernetes"
                              ? "Kubernetes"
                              : runtime.composeProject
                                ? "Compose"
                                : "Docker"}
                        </span>
                      </div>
                    );
                  })}
                  {visible.length === 0 && (
                    <div className="small-empty">没有匹配的服务。</div>
                  )}
                </div>
              </>
            ) : (
              <Empty icon={ServerIcon} title="尚未发现服务">
                点击「检查服务器」读取 Docker 与 Kubernetes
                服务列表；需要先验证服务器指纹并保存登录凭据。
              </Empty>
            )}
            <ErrorNotice message={error} />
          </>
        )}
      </div>
      <div className="modal-footer">
        <span className="muted small">
          {result
            ? "关联信息已保存。"
            : `已选择 ${chosen.length} 个服务，不会移动已经关联的服务。`}
        </span>
        <div>
          <Button variant="outline" className="button" onClick={onClose}>
            {result ? "完成" : "取消"}
          </Button>
          {!result && (
            <Button
              variant="default" className="button primary"
              disabled={Boolean(busy) || !projectId || chosen.length === 0}
              onClick={async () => {
                setBusy("import");
                setError("");
                try {
                  const value = await send<{
                    imported: number;
                    ignored: number;
                  }>(`/servers/${server.id}/import`, "POST", {
                    projectId,
                    services: chosen,
                  });
                  await reload();
                  setResult(value);
                } catch (e) {
                  setError(errorText(e));
                } finally {
                  setBusy(undefined);
                }
              }}
            >
              <BusyLabel busy={busy === "import"}>
                <ArrowDownToLine size={15} />
                导入所选服务
              </BusyLabel>
            </Button>
          )}
        </div>
      </div>
    </Modal>
  );
}
