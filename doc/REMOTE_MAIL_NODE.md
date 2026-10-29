# LONGOS 主服务器 + 第二台专用邮件出口节点

完整的 Cloud Mail UI、Worker 和数据层不部署到第二台服务器。LONGOS 与 Cloud Mail 继续按原方案在主服务器/Cloudflare 上运行；第二台服务器只从本仓库的 `mail-relay/` 子目录运行 Postfix、OpenDKIM、HMAC API 和 Cloudflare Tunnel。

Coolify 使用同一个 GitHub 仓库地址只是为了取得版本化源码；`Base directory=/mail-relay` 和 `Compose location=/docker-compose.coolify.yml` 会把实际构建与运行范围限制在邮件出口组件，不会在第二台服务器启动 `mail-worker`、`mail-vue`、数据库或 LONGOS。

```text
Cloud Mail Worker ── Bearer Token ──┐
                                    ├─> LONGOS（主服务器）
LONGOS 业务邮件 ────────────────────┘          │
                                                │ HTTPS + HMAC
                                                ▼
                                  Cloudflare Tunnel（出站 7844）
                                                │
                                                ▼
                             127.0.0.1:8788 mail-relay（第二台）
                                                │ SMTP 25 出站
                                                ▼
                                           收件方 MX
```

PTR/rDNS 不是 HTTP 反向代理，也不是普通 Cloudflare DNS 记录。它属于第二台服务器公网 IP 的所有者，必须在该 VPS/IP 服务商后台设置。Cloudflare Tunnel 只负责把 HMAC API 安全送到本机回环地址，不会改变 SMTP 出口 IP。

## 一、第二台服务器的前置条件

- 固定、非共享的公网 IPv4（或已完整配置的 IPv6）；
- 服务商允许出站 TCP 25；
- 服务商控制台允许把该 IP 的 PTR/rDNS 设置成 `mailout.example.com`；
- `mailout.example.com` 的 A/AAAA 使用 DNS Only，正向指回同一个 IP；
- Docker、Docker Compose V2，或已由 Coolify验证并安装；
- 防火墙允许 `cloudflared` 向外连接 7844/TCP 和 7844/UDP。

不需要开放入站 25、80、443 或 8788。已有 3X-UI 可以继续独占 80/443。邮件主机 `mailout.example.com` 必须灰云；API 域名 `relay-api.example.com` 由 Cloudflare Tunnel 创建并代理。

## 二、在 Coolify 中接入第二台服务器

1. 在主服务器 Coolify 中打开 `Servers -> New server`，通过 SSH 添加第二台服务器；
2. 验证成功后，服务器必须显示 `Connection: Ready`；
3. 打开该服务器的 `Proxy -> Configuration`；
4. 如果当前是 Traefik/Caddy，保持它停止，点击 `Switch Proxy` 并选择 `Custom (None)`；
5. **不要点击 `Start Proxy`**，不要停止 3X-UI，也不要为该服务器填写 Wildcard domain。

Coolify验证服务器时可能短暂重启 Docker。已有生产容器时应先备份 3X-UI 配置并安排维护窗口。切换为 `Custom (None)` 后，Coolify只负责构建和管理资源，不会再尝试占用 80/443。

## 三、创建 Cloudflare Tunnel

在 Cloudflare 控制台进入 `Networking -> Tunnels`：

1. 创建 remotely-managed Tunnel，例如 `longos-mail-relay`；
2. 在 `Routes` 中添加 `Published application`；
3. Hostname 填写 `relay-api.example.com`；
4. Service URL 填写 `http://127.0.0.1:8788`；
5. 打开 `Add replica`，复制命令中的 `eyJ...` Tunnel Token；
6. 不要给这个主机名叠加需要浏览器登录的 Cloudflare Access 策略，也不要配置 Cache Everything。

Tunnel Token 等同于连接器凭据，只能保存为 Coolify Secret。泄露后应在 Cloudflare 立即 Rotate token。普通 Tunnel 使用出站 QUIC/HTTP2，不绑定第二台服务器的 80/443。

## 四、只创建邮件出口组件的 Coolify Git 应用

在 Coolify 的 `LONGOS -> production` 环境中新建 Public Repository。资源名称建议填写 `LONGOS Remote Mail Node`，明确它不是完整 Cloud Mail：

| 设置 | 值 |
|---|---|
| Repository | `https://github.com/GUSHU101/longos-cloud-mail` |
| Branch | `main` |
| Destination server | 第二台服务器 |
| Build pack | Docker Compose |
| Base directory | `/mail-relay` |
| Docker compose location | `/docker-compose.coolify.yml` |
| Compose deployment | Raw |
| Connect to predefined network | 关闭 |
| Domains | 留空，不添加任何域名 |

该 Compose 只启动两个容器：

- `relay`：Postfix、OpenDKIM 和 HMAC API，只映射到宿主机 `127.0.0.1:8788`；
- `cloudflared`：通过 host network 访问该回环端口，只向 Cloudflare 建立出站连接。

Compose 不声明 80/443，不依赖 Coolify Proxy，也不会加入 3X-UI 的 Docker 网络。

## 五、在 Coolify 中填写可视化变量

公开设置可以参考 [`mail-relay/coolify.env.example`](../mail-relay/coolify.env.example) 粘贴到 Environment Variables 的 Developer view：

```dotenv
MAIL_NODE_PROFILE_VERSION=1
MAIL_HOSTNAME=mailout.example.com
MAIL_PUBLIC_IPS=<第二台服务器真实公网 IP>
MAIL_DOMAINS=example.com
ALLOWED_SENDER_DOMAINS=example.com
DKIM_SELECTOR=mail2026
INET_PROTOCOLS=ipv4
RELAY_HTTP_PORT=8788
MAIL_NODE_VOLUME_PREFIX=longos-remote-mail
TUNNEL_PROTOCOL=auto
TUNNEL_LOG_LEVEL=info
TUNNEL_METRICS_ADDRESS=127.0.0.1:20246
CLOUDFLARED_IMAGE=cloudflare/cloudflared:2026.10.5
RELAY_MEMORY_LIMIT=768m
RELAY_MEMORY_RESERVATION=256m
RELAY_PIDS_LIMIT=256
TUNNEL_MEMORY_LIMIT=256m
TUNNEL_MEMORY_RESERVATION=64m
TUNNEL_PIDS_LIMIT=128
```

这组公开变量现在由 LONGOS 后台“邮件设置 -> 全平台邮件出口拓扑 -> 第二台服务器部署参数”按同一版本契约生成，可直接复制或下载 `.env`；不要手工把 Secret 补进下载文件。`MAIL_NODE_PROFILE_VERSION` 不匹配时远端节点会拒绝启动，避免旧后台参数静默套用到不兼容的新节点。

`MAIL_NODE_VOLUME_PREFIX` 首次部署后不要修改，否则 Compose 会创建一套新卷，看起来像 DKIM、队列和幂等记录“丢失”。

默认内存与进程上限针对一台同时运行 3X-UI 的 2 GiB VPS：relay 最多 768 MiB，cloudflared 最多 256 MiB。不要在没有监控的情况下删除这些上限；如果实际大附件并发较高，应先增加服务器内存，再逐步调高 relay 限额。`TUNNEL_METRICS_ADDRESS` 只绑定回环地址，用于 Docker readiness，不应改成 `0.0.0.0`。

以下三项必须在 Normal view 单独添加，启用 Secret，并关闭 Build Variable：

| 第二台服务器变量 | 安全来源 |
|---|---|
| `LONGOS_RELAY_SHARED_SECRET` | 主 LONGOS 资源的 `SERVICE_PASSWORD_64_MAILRELAY` 实际值 |
| `CLOUD_MAIL_RELAY_SHARED_SECRET` | 主 LONGOS 资源的 `SERVICE_PASSWORD_64_CLOUDMAIL` 实际值 |
| `TUNNEL_TOKEN` | Cloudflare Tunnel 的 `eyJ...` Token |

两条 HMAC 密钥必须不同、各不少于 32 个字符。不要重新生成一组只存在于第二台服务器的密钥，否则主站签名无法通过。不要把这些值粘贴到 Git、截图、聊天、Dockerfile或 Build Argument。

Compose 会把三个值转换为只读 Docker Secret 文件：relay 通过 `*_FILE` 读取两条 HMAC 密钥，cloudflared 通过官方 `TUNNEL_TOKEN_FILE` 读取 Tunnel Token。因此密钥正文不会出现在容器的配置环境列表或进程命令行中。Coolify里仍须启用 Secret，并关闭 Build Variable，避免密钥进入镜像构建阶段。

若需要团队级复用，可以在 LONGOS 项目创建两个 Secret Shared Variables，再让主站和远端资源引用它们；已有生产站不要在未核对值的情况下直接替换主站自动生成的 `SERVICE_PASSWORD_*`。

## 六、部署与本机验收

保存变量后点击 Deploy。部署成功时应同时看到 `relay` healthy、`cloudflared` running。

在 Coolify 的远端服务器 Terminal 中检查：

```bash
docker ps --format 'table {{.Names}}\t{{.Status}}\t{{.Ports}}'
curl -fsS http://127.0.0.1:8788/health
```

正确结果必须满足：

- relay 为 healthy；
- `127.0.0.1:8788->3000/tcp`，不能是 `0.0.0.0:8788`；
- cloudflared 为 healthy，日志出现已注册的 tunnel connection；
- 3X-UI 仍然拥有原来的 80/443。

然后从任意外部网络验证：

```bash
curl -fsS https://relay-api.example.com/health
```

cloudflared 的健康检查会调用本机 metrics `/ready`，确认连接器至少已经建立可服务连接；LONGOS 的外部检查再验证真实公网路由和 relay `/health`。如果本机健康而公网返回 502，检查 Tunnel Route 是否精确指向 `http://127.0.0.1:8788`，以及 cloudflared 是否使用 `network_mode: host`。如果 Tunnel 无法连接，检查第二台服务器出站 7844/TCP、7844/UDP 和 DNS。

## 七、在 LONGOS 后台连接第二台服务器

进入控制站后台 `系统 -> 基础设置 -> 邮件设置 -> 全平台邮件出口拓扑`，选择“第二台服务器出口”，填写：

- 中继 HTTPS 地址：`https://relay-api.example.com`，不添加端口和 `/health`；
- 邮件主机名：`mailout.example.com`；
- 邮件出口公网 IP：第二台服务器真实公网 IP；
- DKIM 签名域、允许发件域和平台默认发件域：`example.com`；
- DKIM Selector：与远端 `DKIM_SELECTOR` 完全一致。

后台保存的是公开拓扑，不接收或显示 HMAC 私密值。保存后通过 LONGOS 共享 storage 立即作用于 app、worker、scheduler 和所有租户，不需要为了修改公开拓扑重新部署主站。点击“立即检测”会核对远端身份、Postfix、OpenDKIM、队列、DKIM、公网 IP、A/AAAA 和 PTR。

Cloud Mail Worker 仍然只连接主服务器：

```dotenv
LONGOS_RELAY_URL=https://主站控制域名/_longos/mail-relay
LONGOS_INTEGRATION_TOKEN=longos_it_...
```

不要把 Cloud Mail Worker 直接指向第二台服务器。主站网关负责租户、发件域和权限校验，然后才通过隔离的 HMAC 客户端身份调用邮件节点。

## 八、设置 DNS、PTR、SPF、DKIM 和 DMARC

在第二台服务器的 VPS/IP 服务商控制台设置：

```text
<第二台服务器公网 IP> -> mailout.example.com
```

在 Cloudflare DNS 中至少需要：

```text
mailout.example.com       A     <第二台服务器公网 IP>    # DNS Only
example.com               TXT   "v=spf1 ip4:<第二台服务器公网 IP> -all"
_dmarc.example.com        TXT   "v=DMARC1; p=none; rua=mailto:dmarc@example.com"
```

DKIM 公钥从 LONGOS 后台诊断页或 relay 持久卷生成的公开清单复制。Cloudflare、Coolify、3X-UI 和 HTTPS Tunnel 都不能代替 IP 服务商创建 PTR。如果服务商禁止 PTR、封锁出站 TCP 25 或提供共享 NAT IP，这台服务器不适合作为直投邮件节点。

## 九、升级、备份与回滚

- GitHub 更新后由 Coolify Webhook 自动部署，或在资源页点击 Deploy；
- 升级前备份 `postfix-spool`、`dkim-keys`、`relay-dns` 和 `relay-state` 四个命名卷；
- 不要通过删除卷解决健康检查问题；DKIM 私钥和防重复投递日志都在卷中；
- cloudflared 使用审核过的版本标签。升级 `CLOUDFLARED_IMAGE` 前先查看 Cloudflare Release，再重新部署；
- 回滚选择上一提交并保留相同的 `MAIL_NODE_VOLUME_PREFIX`；
- Tunnel Token 轮换后只更新 Coolify Secret 并 Redeploy，不需要更换 API 域名或 HMAC 密钥。

## 十、不使用 Coolify/Cloudflare Tunnel 的兼容部署

仓库仍保留 `mail-relay/docker-compose.yml`，用于手动 `.env` 部署。只有第二台服务器已经有能够按域名安全分流的 Nginx/Caddy 时，才把 `relay-api.example.com` 反代到 `127.0.0.1:8788`。

3X-UI 已直接占用 80/443 的服务器不要再启动第二套 Nginx、Caddy、Traefik 或 Coolify Proxy；优先使用本文的 `docker-compose.coolify.yml + Cloudflare Tunnel` 路径。
