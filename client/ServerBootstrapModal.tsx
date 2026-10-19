import { useEffect, useState } from "react";
import { ArrowRight, RefreshCw } from "lucide-react";
import type { BootstrapPlan, Job, Server } from "../shared/types";
import { api, errorText, send } from "./api";
import { serverCanControl } from "./AgentConnection";
import { BusyLabel, ErrorNotice, Field, Loading, Modal, Notice } from "./ui";
import { Button } from "@/components/ui/button";
import { NativeSelect } from "@/components/ui/native-select";

type Runtime = "docker" | "k3s";

export default function ServerBootstrapModal({
  server,
  onClose,
  onJob,
}: {
  server: Server;
  onClose: () => void;
  onJob: (job: Job) => Promise<void>;
}) {
  const [runtime, setRuntime] = useState<Runtime>("docker");
  const [plan, setPlan] = useState<{ runtime: Runtime; value: BootstrapPlan }>();
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setPlan(undefined);
    setError("");
    api<BootstrapPlan>(`/servers/${server.id}/bootstrap?runtime=${runtime}`)
      .then((value) => {
        if (!cancelled) setPlan({ runtime, value });
      })
      .catch((error) => {
        if (!cancelled) setError(errorText(error));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [server.id, runtime, attempt]);
  const current = plan?.runtime === runtime ? plan.value : undefined;
  const connected = serverCanControl(server);
  return (
    <Modal title="安装运行环境" subtitle={server.name} onClose={onClose} wide>
      <div className="modal-body">
        {!connected && <Notice>{server.connectionMode === "agent" ? "void0 OS 当前未连接，恢复连接后才能安装运行环境。" : "请先接入 void0 OS，或在连接设置中验证主机指纹并保存 SSH 登录凭据。"}</Notice>}
        <Field label="运行环境">
          <NativeSelect
            value={runtime}
            disabled={submitting}
            onChange={(event) => setRuntime(event.target.value as Runtime)}
          >
            <option value="docker">Docker Compose</option>
            <option value="k3s">K3s（Kubernetes）</option>
          </NativeSelect>
        </Field>
        {runtime === "k3s" && (
          <Notice>
            每台服务器分别管理自己的 K3s，不会自动组成多台服务器的集群。现有 Docker 服务不会迁入 K3s。
          </Notice>
        )}
        {loading && <Loading label="正在读取安装计划…" />}
        {current && (
          <>
            <Notice>{current.message}</Notice>
            <p className="body-copy">
              确认后将在 <strong>{server.host}</strong> 执行以下命令：
            </p>
            <pre className="command-preview" tabIndex={0}>
              {current.commands.join("\n")}
            </pre>
            <div className="requirements">
              {current.requirements.map((requirement) => (
                <span key={requirement}>{requirement}</span>
              ))}
            </div>
          </>
        )}
        <ErrorNotice message={error} />
        {!loading && !current && (
          <Button variant="outline" size="sm" onClick={() => setAttempt((value) => value + 1)}>
            <RefreshCw size={14} />
            重新读取
          </Button>
        )}
      </div>
      <div className="modal-footer">
        <span className="muted small">安装开始后，关闭网页不会停止任务。</span>
        <div>
          <Button variant="outline" onClick={onClose} disabled={submitting}>
            取消
          </Button>
          <Button
            disabled={loading || submitting || !current || !connected}
            onClick={async () => {
              if (!current) return;
              setSubmitting(true);
              setError("");
              try {
                const job = await send<Job>(`/servers/${server.id}/bootstrap`, "POST", { runtime });
                await onJob(job);
              } catch (error) {
                setError(errorText(error));
              } finally {
                setSubmitting(false);
              }
            }}
          >
            <BusyLabel busy={submitting}>
              确认安装 {runtime === "k3s" ? "K3s" : "Docker"}
              <ArrowRight size={14} />
            </BusyLabel>
          </Button>
        </div>
      </div>
    </Modal>
  );
}
