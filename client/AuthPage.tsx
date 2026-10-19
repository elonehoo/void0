import { useState } from "react";
import { ArrowRight, Box, LockKeyhole } from "lucide-react";
import { send, errorText, type Session } from "./api";
import { BusyLabel, ErrorNotice, Field } from "./ui";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

export interface AuthPageProps {
  session: Session;
  onComplete: () => Promise<void>;
}

/** An installation has one administrator, created only on its first start. */
export default function AuthPage({ session, onComplete }: AuthPageProps) {
  const setup = session.setupRequired;
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [setupToken, setSetupToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  return (
    <main className="auth-shell">
      <div className="auth-container">
        <div className="auth-brand">
          <Box size={23} aria-hidden="true" />
          <span>void0</span>
        </div>
        <h1>{setup ? "创建管理员密码" : "登录 void0"}</h1>
        <p>
          {setup
            ? "首次使用需要设置你自己的密码。此平台仅有一个管理员，不提供多人注册。"
            : "使用首次设置的管理员密码继续。此平台仅有一个管理员。"}
        </p>
        <form
          noValidate
          aria-busy={busy}
          onSubmit={async (event) => {
            event.preventDefault();
            if (busy) return;
            setError("");
            if (setup && !setupToken.trim()) {
              setError("请填写安装码。安装码保存在后台数据目录的 setup-token 文件中。");
              return;
            }
            if (!password) {
              setError("请输入管理员密码。");
              return;
            }
            if (setup && password.length < 12) {
              setError("管理员密码至少需要 12 个字符。");
              return;
            }
            if (password.length > 256) {
              setError("管理员密码不能超过 256 个字符。");
              return;
            }
            if (setup && password !== confirm) {
              setError("两次输入的密码不一致，请重新确认。");
              return;
            }
            setBusy(true);
            try {
              await send(setup ? "/setup" : "/login", "POST", {
                password,
                ...(setup ? { setupToken: setupToken.trim() } : {}),
              });
              await onComplete();
            } catch (cause) {
              setError(errorText(cause));
            } finally {
              setBusy(false);
            }
          }}
        >
          {setup && (
            <>
              <Field label="安装码" hint="用于确认这是你安装的后台，密码设置完成后不再需要。">
                <Input
                  type="password"
                  name="setup-token"
                  value={setupToken}
                  onChange={(event) => setSetupToken(event.target.value)}
                  autoComplete="off"
                  maxLength={256}
                  required
                  disabled={busy}
                  placeholder="安装时生成的安装码"
                />
              </Field>
              <details className="mb-5 rounded-md border bg-muted/30 px-3 py-2 text-sm text-muted-foreground">
                <summary className="cursor-pointer select-none text-foreground">在哪里查看安装码？</summary>
                <p className="mt-2 leading-relaxed">
                  在运行后台的电脑或服务器上查看数据目录中的 <code>setup-token</code> 文件。
                  新安装默认路径是 <code>.void0/setup-token</code>；旧安装可继续使用 <code>.serverdesk/setup-token</code>。Docker 容器内是 <code>/data/setup-token</code>。
                </p>
              </details>
            </>
          )}
          <Field label="管理员密码" hint={setup ? "至少 12 个字符，密码只用于此平台。" : undefined}>
            <Input
              type="password"
              name="password"
              minLength={setup ? 12 : undefined}
              maxLength={256}
              autoComplete={setup ? "new-password" : "current-password"}
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              required
              disabled={busy}
              autoFocus
              placeholder={setup ? "设置你的密码" : "输入管理员密码"}
            />
          </Field>
          {setup && (
            <Field label="确认密码">
              <Input
                type="password"
                name="confirm-password"
                minLength={12}
                maxLength={256}
                autoComplete="new-password"
                value={confirm}
                onChange={(event) => setConfirm(event.target.value)}
                required
                disabled={busy}
                placeholder="再次输入管理员密码"
              />
            </Field>
          )}
          <ErrorNotice message={error} />
          <Button className="w-full" type="submit" disabled={busy}>
            <BusyLabel busy={busy}>
              {setup ? "保存密码并进入" : "登录"}
              <ArrowRight size={15} aria-hidden="true" />
            </BusyLabel>
          </Button>
        </form>
        <div className="mt-5 flex items-start gap-2 text-xs leading-relaxed text-muted-foreground">
          <LockKeyhole size={14} className="mt-0.5 shrink-0" aria-hidden="true" />
          <span>{setup ? "密码设置后会保存在后台，重新启动无需再次创建。请妥善保存密码。" : "重新启动会保留原有密码，不会创建新账号。"}</span>
        </div>
      </div>
    </main>
  );
}
