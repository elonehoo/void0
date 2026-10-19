import { Children, cloneElement, isValidElement, useId, useState, type ReactNode } from "react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/native-select";
import { Textarea } from "@/components/ui/textarea";
import {
  AlertCircle,
  ArrowUpRight,
  Box,
  Check,
  CheckCircle2,
  Clock3,
  GitBranch,
  LoaderCircle,
  Server,
  X,
  type LucideIcon,
} from "lucide-react";
import type {
  Job,
  Service,
  ServiceStatus,
  Server as ServerProfile,
} from "../shared/types";

export function Icon({
  icon: Icon,
  ...props
}: {
  icon: LucideIcon;
  size?: number;
  className?: string;
}) {
  return (
    <Icon
      size={props.size ?? 16}
      strokeWidth={1.65}
      className={props.className}
    />
  );
}
export function Brand({ compact = false }: { compact?: boolean }) {
  return (
    <div className="brand">
      <span className="brand-mark">
        <Box size={21} strokeWidth={1.7} />
      </span>
      {!compact && (
        <span>
          void0
        </span>
      )}
    </div>
  );
}
export function Modal({
  title,
  subtitle,
  children,
  onClose,
  wide = false,
}: {
  title: string;
  subtitle?: string;
  children: ReactNode;
  onClose: () => void;
  wide?: boolean;
}) {
  const [returnFocus] = useState<HTMLElement | null>(() =>
    typeof document !== "undefined" && document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null,
  );
  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          if (returnFocus?.isConnected) returnFocus.focus({ preventScroll: true });
        }}
        className={`modal ${wide ? "modal-wide sm:max-w-3xl" : "sm:max-w-xl"} flex max-h-[calc(100dvh-3rem)] min-h-0 flex-col gap-0 overflow-hidden p-0 [&>form]:flex [&>form]:min-h-0 [&>form]:flex-1 [&>form]:flex-col [&_.modal-body]:min-h-0 [&_.modal-body]:overflow-y-auto [&_.modal-footer]:sticky [&_.modal-footer]:bottom-0 [&_.modal-footer]:shrink-0 [&_.modal-footer]:bg-background`}
      >
        <DialogHeader className="modal-head shrink-0 border-b px-6 py-5 text-left">
          <DialogTitle className="text-lg font-semibold tracking-tight">{title}</DialogTitle>
          <DialogDescription className={subtitle ? "text-sm leading-relaxed text-muted-foreground" : "sr-only"}>
            {subtitle ?? `配置${title}`}
          </DialogDescription>
        </DialogHeader>
        {children}
      </DialogContent>
    </Dialog>
  );
}
export function Field({
  label,
  hint,
  children,
  required = false,
}: {
  label: string;
  hint?: string;
  children: ReactNode;
  required?: boolean;
}) {
  const controlId = useId();
  let linked = false;
  const connect = (nodes: ReactNode): ReactNode => Children.map(nodes, (node) => {
    if (!isValidElement<Record<string, unknown>>(node)) return node;
    if (!linked && [Input, Textarea, NativeSelect, "input", "textarea", "select"].includes(node.type as typeof Input)) {
      linked = true;
      return cloneElement(node, { id: controlId });
    }
    return node.props.children ? cloneElement(node, { children: connect(node.props.children as ReactNode) }) : node;
  });
  const controls = connect(children);
  return (
    <div className="field space-y-2">
      <Label htmlFor={controlId} className="field-label text-sm font-medium leading-none">
        {label}
        {required && <span className="required text-destructive" aria-hidden="true"> *</span>}
      </Label>
      {controls}
      {hint && <p className="field-hint text-sm leading-relaxed text-muted-foreground">{hint}</p>}
    </div>
  );
}
export function ErrorNotice({ message }: { message?: string }) {
  return message ? (
    <Alert variant="destructive" className="notice error">
      <AlertCircle size={16} />
      <AlertDescription>{message}</AlertDescription>
    </Alert>
  ) : null;
}
export function Notice({ children }: { children: ReactNode }) {
  return (
    <Alert className="notice">
      <AlertCircle size={16} />
      <AlertDescription>{children}</AlertDescription>
    </Alert>
  );
}

export function Empty({
  icon: EmptyIcon = Box,
  title,
  children,
  action,
}: {
  icon?: LucideIcon;
  title: string;
  children?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="empty-state">
      <span className="empty-icon">
        <EmptyIcon size={24} />
      </span>
      <h3>{title}</h3>
      {children && <p>{children}</p>}
      {action}
    </div>
  );
}
export function Loading({ label = "正在读取…" }: { label?: string }) {
  return (
    <div className="loading-state">
      <LoaderCircle size={19} className="spin" />
      {label}
    </div>
  );
}
export function BusyLabel({
  busy,
  children,
}: {
  busy: boolean;
  children: ReactNode;
}) {
  return (
    <>
      {busy && <LoaderCircle size={14} className="spin" />}
      {children}
    </>
  );
}
export function validTimestamp(value?: string): number | undefined {
  if (!value) return undefined;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && timestamp > 0 ? timestamp : undefined;
}
export function dateText(value?: string) {
  const timestamp = validTimestamp(value);
  if (timestamp === undefined) return "尚无记录";
  return new Date(timestamp).toLocaleString("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}
export function relativeTime(value?: string) {
  const timestamp = validTimestamp(value);
  if (timestamp === undefined) return "尚未检查";
  const secs = Math.max(0, Math.floor((Date.now() - timestamp) / 1000));
  return secs < 60
    ? "刚刚"
    : secs < 3600
      ? `${Math.floor(secs / 60)} 分钟前`
      : secs < 86400
        ? `${Math.floor(secs / 3600)} 小时前`
        : dateText(value);
}
export function checkedTimeText(value?: string) {
  return validTimestamp(value) === undefined
    ? "尚未检查"
    : `检查于 ${relativeTime(value)}`;
}
export function isFresh(value?: string) {
  const timestamp = validTimestamp(value);
  return (
    timestamp !== undefined &&
    timestamp <= Date.now() + 30000 &&
    Date.now() - timestamp < 120000
  );
}
export function serviceState(status?: ServiceStatus) {
  if (!status || !isFresh(status.checkedAt))
    return { label: "未确认", tone: "neutral", icon: Clock3 };
  if (status.state === "deploying")
    return { label: "正在部署", tone: "purple", icon: LoaderCircle };
  if (status.state === "running" && status.ready)
    return { label: "运行中", tone: "green", icon: CheckCircle2 };
  if (status.state === "stopped")
    return { label: "已停止", tone: "neutral", icon: Clock3 };
  if (status.state === "error")
    return { label: "检查失败", tone: "red", icon: AlertCircle };
  return { label: "未确认", tone: "neutral", icon: Clock3 };
}
export function StatusBadge({ status }: { status?: ServiceStatus }) {
  const value = serviceState(status);
  return (
    <Badge variant="outline" className={`badge badge-${value.tone}`}>
      <span
        className={`status-dot ${value.tone === "purple" ? "pulse" : ""}`}
      />
      {value.label}
    </Badge>
  );
}
const jobLabels: Record<Job["state"], string> = {
  queued: "等待执行",
  running: "执行中",
  succeeded: "已完成",
  failed: "失败",
  unknown: "结果待确认",
  rolled_back: "已恢复旧版本",
  rollback_failed: "恢复失败",
  cancelled: "已取消",
};
export function JobBadge({ job }: { job: Job }) {
  const tone =
    job.state === "succeeded"
      ? "green"
      : ["failed", "rollback_failed"].includes(job.state)
        ? "red"
        : ["queued", "running"].includes(job.state)
          ? "purple"
          : "neutral";
  return (
    <Badge variant="outline" className={`badge badge-${tone}`}>
      <span className="status-dot" />
      {jobLabels[job.state] ?? job.state}
    </Badge>
  );
}
const stages: Record<string, string> = {
  queued: "等待执行",
  preparing: "准备部署",
  cloning: "获取代码",
  checkout: "获取代码",
  building: "构建镜像",
  pulling: "下载镜像",
  deploying: "更新服务",
  starting: "启动服务",
  checking: "检查服务",
  healthcheck: "检查服务",
  rolling_back: "恢复旧版本",
  succeeded: "部署完成",
  completed: "已完成",
  failed: "部署失败",
  installing: "安装依赖",
  probing: "检查依赖",
  ready: "服务就绪",
  submitted: "已提交服务器",
  unknown: "等待确认",
};
export function stageText(stage: string) {
  return stages[stage] ?? stage;
}
export function ResourceLabel({
  service,
  servers,
}: {
  service: Service;
  servers: ServerProfile[];
}) {
  return (
    <span className="resource-label">
      <Icon icon={service.kind === "vercel" ? GitBranch : Server} size={13} />
      {service.kind === "vercel"
        ? "Vercel"
        : (servers.find((s) => s.id === service.serverId)?.name ??
          "未关联服务器")}
    </span>
  );
}
export function ExternalLink({
  href,
  children,
  className = "text-link",
}: {
  href: string;
  children: ReactNode;
  className?: string;
}) {
  const safe = /^https?:\/\//i.test(href);
  return safe ? (
    <a className={className} href={href} target="_blank" rel="noreferrer">
      {children}
      <ArrowUpRight size={13} />
    </a>
  ) : (
    <span>{children}</span>
  );
}
export function CheckRow({
  title,
  description,
  checked,
  onChange,
  disabled = false,
}: {
  title: string;
  description?: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
}) {
  const controlId = useId();
  return (
    <div className={`check-row ${disabled ? "disabled" : ""}`}>
      <Checkbox
        id={controlId}
        checked={checked}
        onCheckedChange={(value) => onChange(value === true)}
        disabled={disabled}
        className="mt-0.5 shrink-0"
      />
      <Label htmlFor={controlId} className={`flex min-w-0 flex-1 cursor-pointer flex-col items-start gap-1 text-sm ${disabled ? "cursor-default text-muted-foreground" : ""}`}>
        <strong className="font-medium leading-snug">{title}</strong>
        {description && <small className="text-sm font-normal leading-relaxed text-muted-foreground">{description}</small>}
      </Label>
    </div>
  );
}

export function repositoryLabel(value: string) {
  return value
    .replace(/^https:\/\/github\.com\//i, "")
    .replace(/\.git\/?$/, "")
    .replace(/\/$/, "");
}
export function repositoryURL(value: string) {
  return `https://github.com/${repositoryLabel(value)}`;
}
