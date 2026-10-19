# 官方平台授权

void0 支持 GitHub App 用户授权和 Vercel Integration 安装授权。两者都需要管理员注册自己的官方应用；未配置时网页会明确提示，Token 仍可作为备用连接方式。不会要求用户把 Client Secret 填入网页。

先设置稳定的 `VOID0_PUBLIC_URL=https://panel.example.com`，并确认可通过 HTTPS 访问。仅本机测试允许 `http://localhost`、`http://127.0.0.1` 或 `http://[::1]`；OAuth 平台自身仍可能拒绝本地域名。修改地址后需要同步修改官方应用的回调地址。

## GitHub App

在 [GitHub App 设置](https://github.com/settings/apps/new) 注册应用：

- Homepage URL：你的 void0 地址。
- Callback URL：`https://panel.example.com/api/integrations/github/callback`，应与网页显示值完全一致。
- Repository permissions：读取代码需要 `Contents: Read-only`；`Metadata: Read-only` 默认授予。仅需自动注册 Webhook 时增加 `Webhooks: Read and write`，不需要源码写入权限。
- 保持用户访问 Token 到期功能开启。void0 使用 PKCE，并在后台刷新短期用户 Token；refresh token 到期或授权被撤销后，仍需重新授权。
- 将 App 安装到需要部署的账号或组织，只选择需要的仓库；用户自身也必须有访问权限。仅授权用户身份不会自动给 App 安装仓库。

将生成的 Client ID 和 Client Secret 保存在管理后台的环境配置中：

```text
VOID0_GITHUB_CLIENT_ID=你的_GitHub_App_Client_ID
VOID0_GITHUB_CLIENT_SECRET=你的_GitHub_App_Client_Secret
```

这里使用 Client ID，不是 App ID，也不需要将 App 私钥交给网页。注册应用不会在 void0 自动发生。

## Vercel Integration

在 [Vercel Integration Console](https://vercel.com/dashboard/integrations/console) 创建连接现有账号的 Integration；使用 Integration OAuth 安装流程，不能使用仅供身份登录的 Sign in with Vercel 应用。

- Redirect URL：`https://panel.example.com/api/integrations/vercel/callback`，应与网页显示值完全一致。
- 授予读取目标项目、部署状态和域名，以及添加、移除项目域名所需的权限。若无需管理域名，可减少权限，但相应网页操作会被 Vercel 拒绝。
- 填写自己的名称、说明及图标，获取 Client ID、Client Secret 和 Integration Slug。是否可直接安装、是否需审核，由 Vercel 的 Integration 规则决定。

后台配置：

```text
VOID0_VERCEL_CLIENT_ID=你的_Integration_Client_ID
VOID0_VERCEL_CLIENT_SECRET=你的_Integration_Client_Secret
VOID0_VERCEL_INTEGRATION_SLUG=你的-integration-slug
```

用户在 Vercel 官方安装页面选择 Team 与项目。void0 保存交换结果中的 `team_id` 和 `installation_id`，按安装范围请求项目；不会把安装 Token 当成可遍历所有 Team 的个人 Token。Integration 返回长期 Token，此流程没有 Sign in with Vercel 的刷新接口。

## 使用及断开

重启后台加载环境变量，在“设置与连接”或添加服务弹窗中选择官方授权。弹窗被浏览器拦截时，可使用网页提供的官方授权链接；成功后当前项目和表单会保留。

授权需要原管理员会话仍然有效，使用一次性状态和独立的 HttpOnly Cookie，十分钟后失效。Token 和 refresh token 加密保存在后台，不会通过回调 URL 返回浏览器。请备份数据目录和加密密钥，严格限制管理后台的访问。

“断开连接”仅删除 void0 保存的凭据，不会卸载外部应用或删除外部项目。需要完全撤销时，在 GitHub/Vercel 官方账号设置中撤销或卸载；Vercel 卸载 Integration 可能同时删除该 Integration 创建的环境变量、Webhook 等资源，操作前应核对。

参考：[GitHub App 授权和 PKCE](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-a-user-access-token-for-a-github-app)、[GitHub 用户 Token 刷新](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/refreshing-user-access-tokens)、[Vercel 外部安装流程](https://vercel.com/docs/integrations/create-integration/submit-integration)、[Vercel Integration Token 与 Team 范围](https://vercel.com/docs/integrations/create-integration/vercel-api-integrations)。
