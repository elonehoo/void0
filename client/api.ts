export interface Session {
  authenticated: boolean;
  setupRequired: boolean;
  setupTokenRequired?: boolean;
  csrfToken?: string;
}
let csrfToken = "";
export function setSession(session: Session) {
  csrfToken = session.csrfToken ?? "";
}
export async function api<T>(
  path: string,
  options: RequestInit = {},
): Promise<T> {
  const method = options.method ?? "GET";
  const headers = new Headers(options.headers);
  if (options.body) headers.set("Content-Type", "application/json");
  if (!["GET", "HEAD"].includes(method)) headers.set("X-CSRF-Token", csrfToken);
  const response = await fetch(`/api${path}`, {
    ...options,
    credentials: "same-origin",
    headers,
  });
  const value = await response.json().catch(() => ({}));
  if (!response.ok) {
    if (response.status === 401 && !["/login", "/setup"].includes(path))
      window.dispatchEvent(new Event("serverdesk:unauthorized"));
    throw new Error(
      typeof value.error === "string"
        ? value.error
        : `请求失败（${response.status}）`,
    );
  }
  return value as T;
}
export const send = <T>(path: string, method: string, data?: unknown) =>
  api<T>(path, {
    method,
    body: data === undefined ? undefined : JSON.stringify(data),
  });
export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : "操作未完成，请重试。";
}
