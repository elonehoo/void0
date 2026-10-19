# void0 独立发布器

发布器自行读取获准源码、构建 Docker 镜像、推送镜像仓库并用 Ed25519 签名。控制台只请求服务 ID 和任务 ID，业务节点依据本地公钥、服务配置、有效期与递增版本决定是否执行。普通代码更新无需 GitHub Actions、在线 Mac 或逐次人工批准。

发布器应放在控制台无法管理的另一台 Linux 主机上，或采用真正独立的管理权限；同一宿主机管理员控制的两个容器不构成隔离。以下命令以发布器专用账号执行，示例目录需预先归该账号所有。

环境变量使用 `VOID0_*`；旧 `SERVERDESK_*` 名称继续兼容，同时设置时以新名称为准。节点的 `serverdesk-agent.service` 与 `/etc/serverdesk-agent/` 是保留的内部标识。

## 准备发布器

需要 Node.js 24.14+、Python 3、Linux `flock`（`util-linux`）、Docker Engine 和可推送的镜像仓库。发布器能够读取 GitHub 源码、下载构建依赖并推送镜像；业务节点只需拉取发布后的镜像。国内节点仍受镜像传输线路影响，可选择它们访问较快的镜像仓库。

在独立主机的项目目录执行：

```sh
npm ci
npm run build
export PUBLISHER_ROOT=/srv/void0-publisher
node build/server/publisher-setup.js init "$PUBLISHER_ROOT/credentials"
cp publisher/config.example.json "$PUBLISHER_ROOT/config.json"
chmod 600 "$PUBLISHER_ROOT/config.json"
docker login registry.example.com
```

`init` 生成 `publisher.key`、`publisher.pub` 和 `api-token`，已有文件时拒绝覆盖。私钥只留在发布器；控制台仅需要 `api-token`，业务节点仅需要公钥。`docker login` 使用发布器账号的推送凭据，节点另外配置自己需要的镜像拉取权限。

编辑 `config.json`：

| 字段 | 含义 |
| --- | --- |
| `repository` / `branch` | 获准的 `owner/repo` 和分支；发布器自行读取当前提交 |
| `dockerfile` / `context` | 仓库内 Dockerfile 与构建目录 |
| `imageRepository` | 发布器推送、业务节点获准拉取的镜像仓库，不含 tag |
| `service.id` | 服务固定 ID，导入控制台时沿用；不要为每次发布更换 |
| `server.id` / `service.serverId` | 已接入 void0 OS 的实际服务器 ID，两者必须一致 |
| `service.repository` / `service.branch` | 与外层来源一致；仓库使用 `https://github.com/owner/repo` |
| `service.target` / `service.environment` | 都为 `{}`；应用秘密放在业务节点 |
| `service.containerPort` / `hostPort` / `volumes` | 实际部署端口与命名数据卷，需由节点本地授权 |

服务器 ID 可从已登录的 `/api/workspace` 响应读取，不是服务器 IP。`service.kind` 固定为 `image`，`server.connectionMode` 固定为 `agent`；模板的名称、时间等字段也是节点校验的一部分，修改模板后需重新生成并安装本地授权。

## 启动

使用本地配置文件：

```sh
export VOID0_SIGNING_KEY_FILE="$PUBLISHER_ROOT/credentials/publisher.key"
export VOID0_PUBLISHER_TOKEN_FILE="$PUBLISHER_ROOT/credentials/api-token"
export VOID0_PUBLISHER_CONFIG_FILE="$PUBLISHER_ROOT/config.json"
export VOID0_PUBLISHER_DATA_DIR="$PUBLISHER_ROOT/state"
node build/server/publisher-main.js
```

默认监听 `127.0.0.1:4321`，用 HTTPS 反向代理提供给控制台；`/healthz` 用于存活检查。需要开机自启时由 systemd 等进程管理器保存这些环境变量并启动同一个命令；启动流程使用 `flock` 防止多个进程同时写同一版本记录。

私有源码额外设置 `VOID0_PUBLISHER_GITHUB_TOKEN_FILE`，文件属于发布器账号且权限 0600；凭据只需读取获准源码和配置仓库。不要把该文件或 GitHub 凭据复制到控制台。

配置也可放在独立 GitHub 私有仓库；不设置 `VOID0_PUBLISHER_CONFIG_FILE`，改用：

```sh
unset VOID0_PUBLISHER_CONFIG_FILE
export VOID0_PUBLISHER_CONFIG_REPOSITORY=YOUR_ORG/void0-config
export VOID0_PUBLISHER_CONFIG_REF=main
export VOID0_PUBLISHER_CONFIG_PATH=void0.json
export VOID0_PUBLISHER_GITHUB_TOKEN_FILE="$PUBLISHER_ROOT/credentials/github-token"
```

`CONFIG_REF` 默认 `main`，`CONFIG_PATH` 默认 `void0.json`。本地文件和 GitHub 配置只能二选一；配置仓库与获准源码的写权限应由独立管理员保管，控制台不能拥有这些写权限。GitHub 配置会在读取服务及发布时重新获取，无需把配置数据库同步到 Git。

## 在业务节点启用 strict

先安装并配对 void0 OS，准备 Docker 和镜像拉取权限；strict 启用后，控制台不能再安装 Docker/K3s 或执行 Kubernetes 修改。把与实际配置一致的 JSON 留作生成本地授权的输入：

```sh
node build/server/publisher-setup.js policies "$PUBLISHER_ROOT/config.json" "$PUBLISHER_ROOT/node-policies" /etc/serverdesk-agent/publisher.pub
```

命令生成每台服务器的 `<serverId>.json`，已有文件时拒绝覆盖。使用 GitHub 配置时，先由独立管理员取得当前配置的本地 0600 副本，生成授权的内容必须与发布器读取的版本一致。

通过独立管理员的连接，把 `publisher.pub` 和该节点的 JSON 复制到业务节点；将示例文件名 `business-server-id.json` 换成实际生成的文件名，再在节点执行：

```sh
sudo install -o root -g root -m 0600 publisher.pub /etc/serverdesk-agent/publisher.pub
sudo install -o root -g root -m 0600 business-server-id.json /etc/serverdesk-agent/release-policy.json
sudo systemctl restart serverdesk-agent.service
sudo systemctl status serverdesk-agent.service
```

这些文件和父目录必须 root 管理、不能由其他用户写入，也不能是符号链接。网页应显示 strict；文件格式、服务器 ID 或权限有误时服务拒绝启动，不会把无效授权视为成功。首次安装和之后主动以 root 执行新安装器属于另一条信任入口，strict 无法保护用户主动运行的恶意安装代码。

应用秘密可保存在节点本地 0600 JSON 文件，例如 `/etc/serverdesk-agent/secrets/web.json`；在该服务的 `release-policy.json` 规则中增加 `environmentFile` 指向它，再重启 OS。文件只包含字符串环境变量，详见 [节点授权格式](../agent/README.md#independent-release-verification)；不要把实际秘密放进发布配置或 Git。

## 连接控制台与自动发布

将 `api-token` 的副本作为控制台账号拥有的 0600 文件保存，设置：

```sh
export VOID0_PUBLISHER_URL=https://publisher.example.com
export VOID0_PUBLISHER_TOKEN_FILE=/srv/void0/publisher-api-token
npm start
```

控制台的 PostgreSQL 地址和数据目录保持原有配置。发布器模式启动时会检查遗留 GitHub、SSH 和应用环境凭据，发现时拒绝启动并保留资料；按提示在原模式处理后再切换。正式迁移还要撤销旧 GitHub Token、轮换旧 SSH 与重要应用凭据，单纯删除记录不能清除数据库页、WAL 和历史备份中的副本。

在项目添加服务时，从发布器目录导入服务，确认绑定的是目录指定的 void0 OS 服务器。先做一次手动部署并核对实际业务，再开启自动发布；控制台每分钟检查分支提交，发布器自行构建、推送并签名，节点按授权更新镜像。网页可改显示名与自动发布开关，实际部署配置仍由独立配置和本地授权决定。

## 保存与恢复

发布器的私钥、API 凭据、配置和 `VOID0_PUBLISHER_DATA_DIR` 必须私密备份；版本记录不能随意删除或回退。节点在执行前保存已接受版本，过期或重复授权会被拒绝，失败后重试需创建新任务；恢复时保持发布器版本记录与节点记录一致。

该流程限制控制台的部署权限，不能阻止它停止发任务或伪造网页显示；应以节点状态和实际业务验收结果核对。获准源码、依赖或独立发布器被入侵后，仍可能发布有有效签名的恶意应用。部署后应通过实际业务验证正常发布、故障恢复与重启行为；定时备份与异地保存需要自行配置。
