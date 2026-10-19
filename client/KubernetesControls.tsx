import { useCallback, useEffect, useState } from "react";
import { Play, RefreshCw, RotateCw, Square, TerminalSquare } from "lucide-react";
import type { Job, Server, Service } from "../shared/types";
import { api, errorText, send } from "./api";
import { serverCanControl } from "./AgentConnection";
import { BusyLabel, ErrorNotice, Modal, Notice, dateText } from "./ui";
import { Button } from "@/components/ui/button";

type Action = "restart" | "stop" | "start";
const actionNames: Record<Action, string> = { restart: "重启", stop: "停止", start: "启动" };

export function KubernetesControls({
  service,
  server,
  activeJob,
  reload,
  onJob,
}: {
  service: Service;
  server?: Server;
  activeJob?: Job;
  reload: () => Promise<unknown>;
  onJob: (job: Job) => void;
}) {
  const [confirmation, setConfirmation] = useState<"restart" | "stop">();
  const [busy, setBusy] = useState<Action>();
  const [error, setError] = useState("");
  const connected = serverCanControl(server);
  const disabled = Boolean(busy || activeJob || !connected);
  const execute = async (action: Action) => {
    setBusy(action);
    setError("");
    try {
      const job = await send<Job>(`/services/${service.id}/actions`, "POST", { action });
      setConfirmation(undefined);
      await reload();
      onJob(job);
    } catch (error) {
      setError(errorText(error));
    } finally {
      setBusy(undefined);
    }
  };
  return (
    <div className="kubernetes-controls">
      <Notice>支持查看日志、启动、停止和重启；源码构建与自动发布尚未支持。</Notice>
      {!connected && <p className="field-hint">请先接入 void0 OS，或在服务器连接设置中配置 SSH。OS 离线时无法执行操作。</p>}
      {activeJob && (
        <div className="kubernetes-pending-job">
          <span>这个服务已有待完成或待确认的任务。</span>
          <Button variant="link" size="sm" onClick={() => onJob(activeJob)}>查看进度</Button>
        </div>
      )}
      <div className="kubernetes-action-row">
        <Button variant="outline" size="sm" disabled={disabled} onClick={() => void execute("start")}>
          <BusyLabel busy={busy === "start"}><Play size={14} />启动</BusyLabel>
        </Button>
        <Button variant="outline" size="sm" disabled={disabled} onClick={() => { setError(""); setConfirmation("restart"); }}>
          <RotateCw size={14} />重启
        </Button>
        <Button variant="outline" size="sm" disabled={disabled} onClick={() => { setError(""); setConfirmation("stop"); }}>
          <Square size={14} />停止
        </Button>
      </div>
      {!confirmation && <ErrorNotice message={error} />}
      {confirmation && (
        <Modal title={`确认${actionNames[confirmation]}服务`} subtitle={service.name} onClose={() => setConfirmation(undefined)}>
          <div className="modal-body">
            <p className="body-copy">
              {confirmation === "stop"
                ? "将服务副本数设为 0，服务会停止响应请求。平台会保存当前副本数，之后可通过「启动」恢复。"
                : "将重新启动这个服务的 Pod，期间服务可能短暂不可用。"}
            </p>
            <dl className="review-list">
              <div><dt>服务器</dt><dd>{server?.name}<small>{server?.host}</small></dd></div>
              <div><dt>服务</dt><dd>{service.target.namespace} / {service.target.deployment}</dd></div>
            </dl>
            <ErrorNotice message={error} />
          </div>
          <div className="modal-footer">
            <Button variant="outline" disabled={Boolean(busy)} onClick={() => setConfirmation(undefined)}>取消</Button>
            <Button disabled={disabled} onClick={() => void execute(confirmation)}>
              <BusyLabel busy={Boolean(busy)}>确认{actionNames[confirmation]}</BusyLabel>
            </Button>
          </div>
        </Modal>
      )}
    </div>
  );
}

export function KubernetesLogs({ service, server }: { service: Service; server?: Server }) {
  const [log, setLog] = useState("");
  const [checkedAt, setCheckedAt] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const connected = serverCanControl(server);
  const refresh = useCallback(async () => {
    setBusy(true);
    setError("");
    try {
      const value = await api<{ log: string }>(`/services/${service.id}/logs`);
      setLog(value.log);
      setCheckedAt(new Date().toISOString());
    } catch (error) {
      setError(errorText(error));
    } finally {
      setBusy(false);
    }
  }, [service.id]);
  useEffect(() => {
    if (connected) void refresh();
  }, [connected, refresh]);
  return (
    <div className="kubernetes-logs">
      <div className="log-heading">
        <span><TerminalSquare size={14} />运行日志</span>
        <Button variant="outline" size="sm" disabled={busy || !connected} onClick={() => void refresh()}>
          <RefreshCw size={13} className={busy ? "spin" : ""} />刷新日志
        </Button>
      </div>
      {!connected && <Notice>服务器连接后可读取运行日志。请检查 void0 OS 是否在线，或配置 SSH 连接。</Notice>}
      <ErrorNotice message={error} />
      {connected && <pre className="job-log kubernetes-runtime-log" tabIndex={0} aria-label={`${service.name} 运行日志`}>
        {log || (busy ? "正在读取日志…" : checkedAt ? "暂无运行日志。" : "尚未读取日志。")}
      </pre>}
      {checkedAt && <p className="field-hint">读取于 {dateText(checkedAt)}，点击刷新读取最新日志。</p>}
    </div>
  );
}
