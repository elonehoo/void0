import { useEffect, useState } from "react";
import { Check, CheckCircle2, Copy, LoaderCircle, Radio, Unplug } from "lucide-react";
import type { AgentInfo, Server } from "../shared/types";
import { api, errorText, send } from "./api";
import { BusyLabel, dateText, ErrorNotice, Loading, Modal, Notice } from "./ui";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

interface Pairing {
  pairingToken: string;
  expiresAt: string;
  installCommand: string;
  publicUrl: string;
}

export function serverCanControl(server?: Server) {
  return server?.connectionMode === "agent"
    ? Boolean(server.agent?.configured && server.agent.online)
    : Boolean(server?.credentialConfigured);
}

export function AgentSummary({ server }: { server: Server }) {
  const info = server.agent;
  return (
    <dl className="agent-summary">
      <div><dt>连接方式</dt><dd>{server.connectionMode === "agent" ? "void0 OS" : "SSH"}</dd></div>
      <div><dt>OS 状态</dt><dd>{!info?.configured ? "未接入" : info.online ? "在线" : "离线"}</dd></div>
      <div><dt>最后心跳</dt><dd>{info?.lastSeen ? dateText(info.lastSeen) : "尚无心跳"}</dd></div>
      <div><dt>OS 版本</dt><dd>{info?.version ?? "—"}</dd></div>
      {info?.configured && <div><dt>发布保护</dt><dd>{info.deploymentProtection?.mode === "strict" ? "服务器独立校验" : "未开启独立校验"}</dd></div>}
      {info?.hostname && <div><dt>主机名</dt><dd>{info.hostname}</dd></div>}
    </dl>
  );
}

function CopyButton({ value, label }: { value: string; label: string }) {
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState("");
  return (
    <>
      <Button variant="outline" size="sm" type="button" onClick={async () => {
        try {
          await navigator.clipboard.writeText(value);
          setCopied(true);
          setError("");
          setTimeout(() => setCopied(false), 2000);
        } catch {
          setError("复制失败，请选中文字手动复制。");
        }
      }}>
        {copied ? <Check size={13} /> : <Copy size={13} />}{copied ? "已复制" : label}
      </Button>
      {error && <p className="field-hint" role="status">{error}</p>}
    </>
  );
}

export default function AgentConnection({
  server, publicUrl, onClose, onChanged,
}: {
  server: Server;
  publicUrl?: string;
  onClose: () => void;
  onChanged: () => Promise<unknown>;
}) {
  const [info, setInfo] = useState<AgentInfo>();
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [pairing, setPairing] = useState<Pairing>();
  const [error, setError] = useState("");
  const [revoke, setRevoke] = useState(false);
  const [now, setNow] = useState(Date.now());
  const [paired, setPaired] = useState(false);
  const hasPublicUrl = Boolean(publicUrl && /^https:\/\//i.test(publicUrl));
  const expired = Boolean(pairing && now >= Date.parse(pairing.expiresAt));

  useEffect(() => {
    let active = true;
    api<AgentInfo>(`/servers/${server.id}/agent`)
      .then((value) => { if (active) setInfo(value); })
      .catch((error) => { if (active) setError(errorText(error)); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [server.id]);

  useEffect(() => {
    if (!pairing || paired) return;
    let active = true;
    let checking = false;
    const check = async () => {
      setNow(Date.now());
      if (checking || Date.now() >= Date.parse(pairing.expiresAt)) return;
      checking = true;
      try {
        const value = await api<AgentInfo>(`/servers/${server.id}/agent`);
        if (!active) return;
        setInfo(value);
        setError("");
        if (value.configured && value.online && !value.pairingPending) {
          setPaired(true);
          setPairing(undefined);
          await onChanged();
        }
      } catch (error) {
        if (active) setError(errorText(error));
      } finally {
        checking = false;
      }
    };
    const interval = setInterval(() => void check(), 3000);
    void check();
    return () => { active = false; clearInterval(interval); };
  }, [pairing, paired, server.id, onChanged]);

  const generate = async () => {
    setBusy(true);
    setError("");
    setPaired(false);
    setPairing(undefined);
    try {
      const value = await send<Pairing>(`/servers/${server.id}/agent/pairing`, "POST");
      setPairing(value);
      setNow(Date.now());
    } catch (error) {
      setError(errorText(error));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title={revoke ? "断开 void0 OS 连接" : "安装 void0 OS"} subtitle={server.name} onClose={onClose} wide>
      <div className="modal-body agent-install-body">
        {loading ? <Loading label="正在读取 void0 OS 状态…" /> : revoke ? (
          <Notice>断开后，void0 将无法再通过这台服务器上的 void0 OS 发送指令或读取状态。服务器上的业务服务和数据不会删除。</Notice>
        ) : (
          <>
            <div className="agent-install-overview">
              <Radio size={18} />
              <div><strong>让服务器连接 void0</strong><p>在现有 Linux 系统中安装 void0 OS，无需重装。接入后可读取状态、安装运行环境和管理服务。</p></div>
              <Badge variant="outline" className={info?.online ? "connection-badge connected" : "connection-badge"}>
                {!info?.configured ? "未接入" : info.online ? "在线" : "离线"}
              </Badge>
            </div>
            {info?.configured && <Notice>{info.deploymentProtection?.mode === "strict" ? "服务器已开启独立校验，只执行获准发布器签名且符合本地规则的镜像部署。修改规则和安装运行环境需要在服务器终端操作。" : "当前使用兼容模式，部署指令由管理后台直接下发。开启服务器独立校验需要在服务器上配置受信任的发布器公钥和服务规则。"}</Notice>}
            {paired ? (
              <div className="agent-pair-success" role="status"><CheckCircle2 size={20} /><div><strong>void0 OS 已连接</strong><p>现在可以通过 void0 管理这台服务器。Docker 和 K3s 可按需安装。</p></div></div>
            ) : !pairing ? (
              <>
                {!hasPublicUrl && <Notice>请在「设置与连接」中保存可从服务器访问的 HTTPS 管理地址，再生成安装命令。本地地址无法用于远程 void0 OS 接入。</Notice>}
                {info?.configured && <p className="body-copy">这台服务器已经接入 void0 OS。重新配对成功后会替换原连接，生成配对码不会立即中断现有连接。</p>}
                <p className="field-hint">安装命令不包含凭据；执行后按终端提示输入一次性配对码。配对码只在本次窗口显示。</p>
                <Button disabled={busy || !hasPublicUrl} onClick={() => void generate()}>
                  <BusyLabel busy={busy}>{info?.configured ? "重新生成配对码" : "生成配对码与安装命令"}</BusyLabel>
                </Button>
              </>
            ) : (
              <ol className="agent-install-steps">
                <li>
                  <div className="agent-step-heading"><span>1</span><h3>在服务器终端运行安装命令</h3><CopyButton value={pairing.installCommand} label="复制命令" /></div>
                  <pre className="command-preview" tabIndex={0}>{pairing.installCommand}</pre>
                  <p className="field-hint">管理地址：{pairing.publicUrl}</p>
                </li>
                <li>
                  <div className="agent-step-heading"><span>2</span><h3>按终端提示输入一次性配对码</h3>{!expired && <CopyButton value={pairing.pairingToken} label="复制配对码" />}</div>
                  {expired ? <Notice>配对码已过期，请重新生成。旧码不会再次显示。</Notice> : <><code className="agent-pairing-code">{pairing.pairingToken}</code><p className="field-hint">有效期至 {dateText(pairing.expiresAt)}，请勿分享此配对码。</p></>}
                </li>
                <li>
                  <div className="agent-step-heading"><span>3</span><h3>等待 void0 OS 连接</h3></div>
                  <p className="agent-waiting" role="status">{expired ? "等待生成新的配对码" : <><LoaderCircle className="spin" size={14} />每 3 秒检查连接状态，接入后会自动确认。</>}</p>
                </li>
              </ol>
            )}
          </>
        )}
        <ErrorNotice message={error} />
      </div>
      <div className="modal-footer">
        {revoke ? <span /> : info?.configured ? <Button variant="ghost" className="text-destructive" disabled={busy} onClick={() => { setRevoke(true); setError(""); }}><Unplug size={14} />断开 void0 OS 连接</Button> : <span className="field-hint">void0 OS 与运行环境分别安装。</span>}
        <div>
          <Button variant="outline" disabled={busy} onClick={revoke ? () => setRevoke(false) : onClose}>{revoke ? "取消" : "关闭"}</Button>
          {revoke ? <Button variant="destructive" disabled={busy} onClick={async () => {
            setBusy(true);
            setError("");
            try {
              await send(`/servers/${server.id}/agent/revoke`, "POST");
              setInfo({ configured: false, online: false });
              setPairing(undefined);
              setPaired(false);
              setRevoke(false);
              await onChanged();
            } catch (error) {
              setError(errorText(error));
            } finally {
              setBusy(false);
            }
          }}><BusyLabel busy={busy}>确认断开接入</BusyLabel></Button> : expired ? <Button disabled={busy} onClick={() => void generate()}><BusyLabel busy={busy}>重新生成配对码</BusyLabel></Button> : null}
        </div>
      </div>
    </Modal>
  );
}
