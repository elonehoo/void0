# void0

void0 是自托管的服务器与服务管理平台。通过网页按项目组织 Docker 服务、服务器和 Vercel 站点；同一项目可以包含不同服务器上的服务。

前端使用 React、Vite 和 shadcn/ui，后台使用 Node.js，支持 PostgreSQL 和 SQLite。每台业务服务器安装 **void0 OS**：运行在现有 Ubuntu / Debian 上的管理程序，无需重装操作系统。

## 功能

- 项目与服务分组、服务器资源状态、容器日志和部署进度。
- Docker 镜像部署、源码构建、已有 Compose 服务导入和更新。
- 自动检查 GitHub 分支更新；支持独立发布器构建、镜像签名和节点本地校验。
- 容器就绪检查与失败版本恢复，保留原有数据卷。
- Vercel 项目接入与自定义域名管理；可选 K3s 状态与 Deployment 操作。
- 单管理员、一次性初始化、凭据加密，以及数据库备份和恢复工具。

## 本机运行

需要 Node.js 24.14 或更高版本。

```sh
npm ci
npm run build
npm start
```

打开 <http://127.0.0.1:4317>。首次使用时，读取后台数据目录中的 `setup-token`，在网页创建至少 12 位的管理员密码；每套安装只有一个管理员，不提供多人注册。初始化完成后，重启不会覆盖密码。

新安装的数据目录默认为 `.void0/`；已有 `.serverdesk/` 安装保留兼容。可用 `VOID0_DATA_DIR` 显式指定目录。开发时分别运行 `npm run dev` 和 `npm run dev:client`，前端地址为 <http://127.0.0.1:5173>。

下文使用 `VOID0_*` 环境变量；原有 `SERVERDESK_*` 名称继续兼容，同时设置时以 `VOID0_*` 为准。现有 systemd 服务名、节点目录、数据库表名等内部标识保留兼容名称，不应只因品牌更新而手动改名。

## Docker 部署

需要 Docker Engine 和 Docker Compose。

```sh
docker compose up -d --build
docker compose exec app cat /data/setup-token
```

默认只监听 `127.0.0.1:4317`，容器数据目录为 `/data`。远程初始化可通过 SSH 转发访问：

```sh
ssh -L 4317:127.0.0.1:4317 user@your-server
```

使用公网域名时，将域名解析到控制台服务器，开放 80 和 443，在 `.env` 中设置：

```dotenv
VOID0_DOMAIN=panel.example.com
VOID0_PUBLIC_URL=https://panel.example.com
```

```sh
docker compose --profile public up -d --build
```

Caddy 提供 HTTPS。控制台容器不挂载宿主机 Docker socket，以非 root 用户运行；`/healthz` 提供健康检查。远程业务节点必须能够通过 HTTPS 访问控制台地址。

### PostgreSQL

新安装可使用 Compose 提供的 PostgreSQL：

```sh
node script/setup-postgres.mjs .void0-postgres.env
docker compose --env-file .void0-postgres.env -f compose.yaml -f compose.postgres.yaml up -d --build
```

生成的环境文件权限为 `0600`，不会覆盖已有文件；不要提交到 Git。数据库端口不公开，后台使用受限的应用账号。需要公网 HTTPS 时，将域名变量也写入这个环境文件，并在同一 Compose 命令中添加 `--profile public`。

外部 PostgreSQL 可用 `VOID0_DATABASE_URL` 配置；未设置时使用 SQLite。数据库之外还必须保留数据目录中的 `master.key`，仅有数据库备份无法恢复加密记录。已有 SQLite 安装应完成[显式迁移](#sqlite-迁移与备份)，不能直接切换连接地址。

## 接入业务服务器

1. 在“设置与连接”保存业务节点可访问的 HTTPS 控制台地址。
2. 添加服务器，打开“安装 void0 OS”，生成配对码，在目标服务器终端执行安装命令。配对码交互输入，有效期 15 分钟，只能使用一次。
3. 连接后查看资源状态，按需安装 Docker / Compose，或导入已有服务。接入本身不会重部署容器、搬动业务数据或安装 Docker / K3s。
4. 先创建项目，再在项目内添加或导入服务。自动发布默认关闭；非空项目必须先移动或移除服务才能删除，移除管理记录不会删除云端业务资源。

void0 OS 在 Ubuntu / Debian 上作为 root systemd 服务运行，主动连接控制台，不监听网络端口。节点只接受随安装包提供的固定操作，不提供任意远程 Shell；控制 Docker 和安装运行环境仍需要较高权限。完整安装、协议和授权说明见 [void0 OS](agent/README.md)。

也可使用 SSH：保存凭据前须核对主机指纹，指纹变化会阻止连接。OS 离线不会自动切换 SSH 或重发部署任务。

K3s 为可选功能，接入不依赖 Kubernetes。现有 Deployment 支持状态、日志、启动、停止和重启；不会自动改造成 Docker 服务。

## 连接 GitHub 和 Vercel

在左下角管理员菜单打开“设置与连接”。正式安装推荐配置 [GitHub App / Vercel Integration 官方授权](docs/provider-oauth.md)，用户在官方网页选择仓库、工作空间和项目；管理员需要先注册自己的应用并配置固定回调地址。未配置官方应用时网页会明确提示，个人 Token 作为备用方式提供，不会假装已经授权。

添加源码服务、导入 Vercel 时也可直接连接，成功后保留当前项目和表单。设置页可检查凭据是否仍有效，检查失败不会删除原凭据。Docker 镜像和已有服务器服务无需先连接这两个平台；独立发布器模式下 GitHub 由发布器连接。

新增服务必须指定存在的项目，导入也需要目标项目；同一项目仍可包含不同服务器和 Vercel 的服务。移动已有服务通过目标项目设置完成，项目编辑不能取消服务归属。历史未归类的管理记录保留，可在项目设置中收纳。

## 服务域名

打开项目中的服务，在“域名”页绑定、检查或移除自定义域名。网页显示需要添加的 A / AAAA / CNAME / TXT 记录，并分别显示等待解析、等待证书及可访问状态。DNS 记录仍在域名服务商设置；void0 不购买域名，也不自动修改 DNS。

Docker 域名支持已运行的 HTTP 服务，必须发布独立的主机端口。void0 OS 或具备免交互 sudo 权限的 SSH 连接会核验容器身份、实际端口和 HTTP 响应，再配置独立 Caddy；证书数据持久保存。节点需要空闲的 80 / 443 端口及公网入口，已有代理占用端口时会拒绝操作，不替换原代理。接入旧 OS 后需要更新程序才支持新域名操作；开启 strict 发布保护的节点拒绝后台直接修改域名。

Vercel 使用项目域名接口完成添加、所有权验证及移除，并读取官方推荐 DNS 记录。安装授权限定到对应工作空间；Vercel 自动生成的域名仍由 Vercel 管理。移除域名绑定不会注销域名、删除 DNS 或停止应用。void0 管理的绑定尚未解除时，不能修改部署目标、端口或删除服务记录。

## 无人值守发布与安全边界

推荐使用 **独立发布器 + 节点 strict 模式**。发布器自行读取获准仓库与分支、构建镜像、推送镜像仓库并签名；业务节点根据本地公钥、服务授权、有效期和递增版本校验后部署。普通代码更新不需要 GitHub Actions、在线个人电脑或逐次人工批准。配置步骤见 [独立发布器](publisher/README.md)。

- 发布器须由独立权限管理，控制台不能持有签名私钥、改写获准配置或控制发布器主机。同一管理员控制的同宿主机容器不构成独立信任。
- strict 模式只接受 void0 管理的 `image` 服务和获准镜像仓库的固定 `@sha256:` 摘要。新增端口、数据卷等配置需要节点管理员更新本地授权。
- strict 节点拒绝源码直传、导入 Compose 的更新、Docker / K3s 安装和 Kubernetes 修改。启用前应准备好运行环境，应用秘密可保存在节点本地的私有环境文件中。
- 控制台的独立发布器模式拒绝保留 GitHub、SSH 和应用环境凭据；切换前需处理旧记录并撤销或轮换旧凭据，旧数据库页及备份中的副本不会因删除记录而消失。

兼容模式允许控制台通过 OS 或 SSH 直接构建和更新服务，并支持自动检查 GitHub 更新及 push 通知。它便于接入已有服务，**不能在控制台被入侵后提供独立的部署授权保护**；数据库从 SQLite 换成 PostgreSQL 不会改变这一点。

签名保护的是发布授权，不保证源码本身安全，也不能阻止控制台中断任务或显示错误状态。获准源码、依赖、独立发布器或业务节点 root 被入侵仍可能影响应用。初次安装及更新 OS 会运行 root 代码，须通过可信渠道审阅和获取安装程序。

### 部署行为

更新只针对选定的 Docker / Compose 服务；其他容器和数据卷保留。就绪检查失败时尝试恢复上一镜像，**不会恢复数据库内容或文件写入**；容器就绪也不能代替实际业务验收。

任务在业务节点运行，关闭浏览器不影响执行；后台或连接中断后通过记录查询结果，不自动重发。业务节点重启不会自动续跑中断的构建，状态不明的任务需要核对后处理。导入的独立容器和 Kubernetes Deployment 目前不支持通过源码发布流程更新。

独立发布器承担源码和依赖下载，业务节点仍需拉取镜像；跨境链路与私有依赖需要自行配置。Vercel 构建和自动发布继续由其 Git 集成管理，void0 的域名操作只针对所选项目，不改动发布配置。

## SQLite 迁移与备份

迁移与恢复前停止目标后台；不要同时启动旧、新后台。维护环境需要项目依赖、`lsof` 及目标 PostgreSQL 的受限连接。数据库客户端还需安装匹配版本的 `pg_dump` / `pg_restore`；不要为维护公开 PostgreSQL 端口。

配置应用账号的 `VOID0_DATABASE_URL`，以新的数据目录和空 PostgreSQL 为目标：

```sh
npm run backup:sqlite -- .void0 ./backups/before-postgres
npm run migrate:postgres -- --source-dir .void0 --target-dir .void0-postgres --confirm-stopped
```

迁移只读原 SQLite，检查完整性、解密能力和数据一致性，拒绝覆盖已有 PostgreSQL 数据。成功后使用同一连接地址及 `VOID0_DATA_DIR=.void0-postgres` 启动并核对登录、项目、服务器与任务。回到旧 SQLite 前必须停新后台，迁移后的新增记录不会自动同步回去。旧安装请将示例的 `.void0` 替换为实际数据目录。

PostgreSQL 在线备份与停止后的恢复：

```sh
npm run backup:postgres -- .void0-postgres ./backups/snapshot
npm run restore:postgres -- ./backups/snapshot .void0-restored --confirm-stopped
```

备份包含数据库、匹配的 `master.key` 和校验记录，备份目录必须按秘密资料保管；恢复使用空 PostgreSQL 和新的数据目录。SQLite 可继续使用 `backup:sqlite`，停后台后将备份中的 `workspace.sqlite` 和 `master.key` 放入新的私有数据目录。

项目不会自动配置定时或异地备份。控制台数据库与密钥、发布器私钥与版本记录、节点本地环境文件、业务数据卷应分别备份，并定期验证恢复。不要将数据库、环境文件、密钥或备份提交到 Git；GitHub 私有仓库只适合保存不含秘密的发布配置与历史。

## 开发与维护

```sh
npm run build
npm test
```

测试覆盖认证、来源检查、凭据保存、任务恢复、节点授权和发布流程。可选的真实 Docker 测试会创建临时本机资源，应在隔离开发环境运行：

```sh
VOID0_DOCKER_SMOKE=1 node_modules/.bin/tsx --test tests/remote-docker.test.ts
python3 -m unittest discover -s agent/tests -v
```

不要将测试配置指向生产服务器。提交前检查代码、测试和文档；报告问题时隐藏密码、Token、私钥、配对码、连接地址中的凭据和日志中的应用秘密。

安全问题请按 [安全报告说明](SECURITY.md) 处理，避免在公开 Issue 中附带可利用的细节或凭据。

## 许可证

[MIT](LICENSE)
