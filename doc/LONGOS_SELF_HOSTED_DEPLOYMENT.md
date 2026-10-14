# Cloud Mail + LONGOS 一体化自建邮件部署与升级

本文适用于新版独立仓库 `GUSHU101/longos-cloud-mail` 的 `main` 分支和正式 Release，目标是在同一台服务器部署 LONGOS 网站、Postfix 和 OpenDKIM，并让 Cloudflare Worker 通过 LONGOS 的 HTTPS 入口发信。服务器端不需要再单独克隆或部署本仓库的 `mail-relay` 目录。

Cloudflare 账户、API Token 权限、D1/KV/R2 创建、自定义域名、Email Routing、GitHub Actions 首次部署、初始化、备份和回滚的逐步操作已独立整理为：[Cloudflare Workers 完整部署手册](./CLOUDFLARE_WORKERS_DEPLOYMENT.md)。请先完成该手册，再回到本文接入 LONGOS 出站邮件。

## 1. 架构与边界

```text
浏览器
  │
  ├─ Cloud Mail UI / API ── Cloudflare Worker
  │                              │ HTTPS + HMAC
  │                              ▼
  └─ LONGOS 店铺 ───────── LONGOS /_longos/mail-relay
                                 │ Docker 私有网络
                                 ▼
                         Postfix + OpenDKIM
                                 │ TCP 25
                                 ▼
                              收件方 MX
```

- Cloudflare 负责 Worker、网站 HTTPS 和 DNS，不代替 SMTP 服务器。
- LONGOS `./install.sh` 会把邮件中继作为网站 Docker Compose 栈的一部分安装。
- LONGOS 和 Cloud Mail 使用不同的 HMAC 密钥；Cloud Mail 只能使用分配给它的客户端身份。
- 入站收信仍按 Cloud Mail 原有的 Cloudflare Email Routing 配置；本文替换的是出站发信路径。
- LONGOS 的订单、账户、客服、营销和弃单召回邮件直接使用同一个内置中继，不需要经过 Cloud Mail Worker。

## 2. 部署前检查

服务器必须满足以下条件：

- Linux、Docker 和 Docker Compose V2；
- 固定公网 IPv4；
- 服务商允许出站 TCP 25；
- 服务商控制台可以设置 PTR/rDNS；
- 80/443 入站端口可用；
- 发信域名的 DNS 可管理。

推荐为不同用途使用不同主机名：

| 用途 | 示例 | Cloudflare 状态 |
|---|---|---|
| LONGOS 控制站点 | `admin.example.com` | 可代理 |
| Cloud Mail Worker | `mail.example.com` | Worker 自定义域 |
| SMTP EHLO/PTR | `mailout.example.com` | 必须 DNS Only |
| 发件域 | `example.com` | 发布 SPF/DKIM/DMARC |

如果云服务商封禁 TCP 25，代码、Cloudflare 或更换端口都无法让 Postfix 直接投递到收件方 MX；需要更换允许邮件投递的服务器或申请解封。

## 3. 首次安装 LONGOS

在完整 LONGOS 源码目录执行安装器。以下变量只是示例，请替换成真实域名和管理员信息：

```bash
cd /opt/longos
chmod +x install.sh

DOMAIN=admin.example.com \
SAAS_BASE_DOMAIN=shops.example.com \
SAAS_TLS_EMAIL=ops@example.com \
MAIL_RELAY_HOSTNAME=mailout.example.com \
MAIL_RELAY_DOMAINS=example.com \
MAIL_RELAY_ALLOWED_SENDER_DOMAINS=example.com \
MAIL_RELAY_PLATFORM_SENDER_DOMAIN=example.com \
./install.sh
```

选择 Docker/Nginx 或 Docker/Apache 模式。Docker 是一体化邮件引擎的受支持部署方式；纯宝塔或手工 LNMP 路径不会安装内置邮件服务器。

> 如果现有站点是宝塔/LNMP 部署，访问 `/_longos/mail-relay/health` 返回 404 表示中继尚未安装，不是 Cloud Mail 地址填写错误。在该健康检查返回 200 前，不要配置 `LONGOS_RELAY_URL`，否则 Cloud Mail 的自建发信会必然失败。

安装器会自动生成并写入 `.env`：

```text
LONGOS_MAIL_RELAY_ENABLED=true
MAIL_RELAY_ENDPOINT=http://mail-relay:3000
MAIL_RELAY_PUBLIC_URL=https://admin.example.com/_longos/mail-relay
MAIL_RELAY_SHARED_SECRET=<LONGOS 内部客户端密钥>
CLOUD_MAIL_RELAY_SHARED_SECRET=<Cloud Mail 专用密钥>
```

不要让两个密钥使用相同值，也不要把它们提交到 Git、写入网页设置或保存到 D1。

### 安装后健康检查

```bash
docker compose --profile nginx ps
docker compose exec -T mail-relay node -e "fetch('http://127.0.0.1:3000/health').then(async r => { console.log(r.status, await r.text()); if (!r.ok) process.exit(1) })"
curl -fsS https://admin.example.com/_longos/mail-relay/health
```

Apache 部署时把第一条命令中的 `nginx` 改成 `apache`。公网健康检查只证明 HTTPS 路由可达；真正的 `/v1/send` 请求还必须通过 HMAC、时间戳、nonce、客户端身份和发件域校验。

## 4. 配置 DNS、PTR、SPF、DKIM 和 DMARC

假设服务器公网 IPv4 是 `203.0.113.10`：

```text
mailout.example.com       A     203.0.113.10                         # DNS Only
example.com               TXT   "v=spf1 ip4:203.0.113.10 -all"
_dmarc.example.com        TXT   "v=DMARC1; p=none; rua=mailto:dmarc@example.com"
```

在服务器供应商控制台设置 PTR/rDNS：

```text
203.0.113.10 -> mailout.example.com
```

正向 A 记录和反向 PTR 必须互相匹配。`mailout.example.com` 不可开启 Cloudflare 橙云代理，因为 Cloudflare 普通代理不转发 SMTP。

查看安装器生成的 DKIM TXT 记录：

```bash
docker compose exec -T mail-relay sh -c "find /var/lib/dkim -name '*.txt' -type f -exec cat {} \;"
```

将输出的 TXT 记录逐条发布到 Cloudflare DNS。初次上线建议先使用 `p=none` 观察 DMARC 报告；确认 SPF、DKIM 对齐和正常投递后，再逐步改为 `quarantine` 或 `reject`。

## 5. 配置 GitHub Actions

打开 GitHub 仓库：

```text
Settings -> Secrets and variables -> Actions
```

### Variables

| 名称 | 示例 | 说明 |
|---|---|---|
| `NAME` | `cloud-mail` | Worker、D1、KV 默认名称 |
| `D1_DATABASE_NAME` | `cloud-mail` | D1 真实名称；默认与 `NAME` 相同 |
| `CUSTOM_DOMAIN` | `mail.example.com` | 不带协议和路径 |
| `DOMAIN` | `["example.com"]` | 必须是 JSON 数组 |
| `ADMIN` | `admin@example.com` | Cloud Mail 管理员地址 |
| `CLOUDFLARE_ACCOUNT_ID` | `...` | Cloudflare 账户 ID |
| `D1_DATABASE_ID` | `...` | 可留空，由工作流查找或创建 |
| `KV_NAMESPACE_ID` | `...` | 可留空，由工作流查找或创建 |
| `R2_BUCKET_NAME` | `cloud-mail` | 使用附件时填写已有 Bucket |
| `PROJECT_LINK` | 仓库或站点地址 | 可选 |
| `AI_MODEL` | `@cf/meta/llama-3.1-8b-instruct-fast` | 可选 |
| `CF_EMAIL` | `false` | 自建出站时可保持 `false` |
| `ANALYSIS_CACHE` | `false` | 可选 |
| `LONGOS_RELAY_URL` | `https://admin.example.com/_longos/mail-relay` | 必须为 HTTPS |

### Secrets

| 名称 | 值 |
|---|---|
| `CLOUDFLARE_API_TOKEN` | 能部署 Worker 并管理所用 D1/KV/自定义域的令牌 |
| `JWT_SECRET` | 至少 32 位随机值，可用 `openssl rand -hex 32` 生成 |
| `RELAY_SHARED_SECRET` | LONGOS `.env` 中 `CLOUD_MAIL_RELAY_SHARED_SECRET` 的原值 |

`RELAY_SHARED_SECRET` 必须与 LONGOS 的 Cloud Mail 专用密钥逐字一致，不能填 `MAIL_RELAY_SHARED_SECRET`。工作流会把 `JWT_SECRET` 和 `RELAY_SHARED_SECRET` 直接写入 Cloudflare Worker Secret，不会放入 `wrangler.toml`、网页或数据库。

首次部署可以不填 `D1_DATABASE_ID` 和 `KV_NAMESPACE_ID`；工作流会优先查找与 `D1_DATABASE_NAME` 同名的 D1 和与 `NAME` 同名的 KV，不存在时才创建。已有生产数据时，建议显式填写原 D1/KV ID，避免绑定到新资源；`D1_DATABASE_NAME` 必须与该 ID 对应数据库的真实名称一致。

`LONGOS_RELAY_URL` 和 `RELAY_SHARED_SECRET` 必须成对配置。只有以下命令成功后才应填写：

```bash
curl -fsS https://admin.example.com/_longos/mail-relay/health
```

## 6. 从 GitHub 部署正式版

正式代码位于：

```text
main
```

生产部署为手动、失败即停的 GitHub Actions 工作流。代码推送到 `main` 只执行测试，不会在密钥或绑定未校验时自动覆盖生产 Worker。

GitHub 页面操作：

1. 进入 `Actions`；
2. 选择 `Deploy cloud-mail to Cloudflare Workers`；
3. 点击 `Run workflow`；
4. 分支保持 `main`；
5. 等待构建、D1/KV 绑定、Worker 生产部署、Secret 写入和数据库初始化全部成功。

也可以使用 GitHub CLI：

```bash
gh workflow run deploy-cloudflare.yml --ref main --repo GUSHU101/longos-cloud-mail
gh run watch --exit-status
```

不要同时使用 Cloudflare Git Builds 和 GitHub Actions 部署同一个 Worker。本项目的一体化方案使用 GitHub Actions，因此应在 Cloudflare Worker 的 `Settings -> Builds` 中打开 `Disable builds`。Cloudflare Git Builds 的非生产分支默认执行：

```text
npx wrangler versions upload
```

该命令只创建预览版本，日志中出现 `Version Preview URL` 不等于已替换生产流量。一体化部署请使用上述 GitHub Actions 入口；它会生成带 D1、KV、R2、自定义域和 LONGOS 中继配置的 `wrangler-action.toml`，然后执行真正的 `wrangler deploy`。

部署后立即验证：

```bash
curl -fsS https://mail.example.com/ >/dev/null
curl -fsS https://mail.example.com/api/setting/websiteConfig
```

再打开 Cloud Mail 的“系统设置”，确认页面已出现邮件引擎和 LONGOS 中继配置。

## 7. Cloud Mail 与 LONGOS 后台设置

Cloud Mail：

1. 使用管理员账户进入“系统设置”；
2. 邮件引擎保持“自动（兼容模式）”即可；
3. 当 `LONGOS_RELAY_URL` 和 Worker Secret 都存在时，自动模式优先选择自建中继；
4. 发信时选择实际 Cloud Mail 邮箱账户，`From` 会使用该账户，不会统一改写成 LONGOS 默认邮箱；
5. 角色必须有权使用该邮箱域名。

LONGOS：

1. 进入“系统设置 -> 邮件设置”；
2. 选择“内置邮件服务器（推荐）”；
3. 分别配置默认、订单、账户、退货/客服和营销发件身份；
4. 启用订单/账户/退货等需要的邮件通知；
5. 使用页面中的测试邮件验证投递。

共享平台发件域下，普通租户使用 `<purpose>+<site-code>@<platform-domain>`，例如：

```text
orders+shop-a@example.com
account+shop-a@example.com
support+shop-a@example.com
marketing+shop-a@example.com
```

这样每个租户和业务分类都有独立身份，同时共用一个已经完成 SPF/DKIM 的平台域。

## 8. 新增或更换租户发件域

更换店铺访问域不会自动改写邮件发件域。若要同步更换发件域，应按以下顺序执行：

1. 在 LONGOS 控制面验证新域名归属；
2. 把新域加入 `.env` 的 `MAIL_RELAY_DOMAINS` 和 `MAIL_RELAY_ALLOWED_SENDER_DOMAINS`；
3. 重建邮件中继，保留原域直到迁移结束；
4. 发布新域的 SPF、DKIM 和 DMARC；
5. 使用测试邮箱检查 SPF/DKIM/DMARC 均为 pass；
6. 在租户后台切换默认和各业务分类发件身份；
7. 确认旧队列清空后再从允许列表移除旧域。

重建命令：

```bash
docker compose --profile nginx up -d --build --force-recreate mail-relay
docker compose exec -T mail-relay sh -c "find /var/lib/dkim -name '*.txt' -type f -exec cat {} \;"
```

DKIM 私钥和 Postfix 队列位于 Docker 持久卷，普通容器重建不会丢失。不要执行 `docker compose down -v`，除非明确要删除数据库、队列和 DKIM 持久数据。

## 9. 升级

### 9.1 升级 Cloud Mail 正式主线

```bash
git remote set-url origin https://github.com/GUSHU101/longos-cloud-mail.git
git fetch --tags origin
git switch main
git pull --ff-only origin main
```

代码同步后，在 GitHub Actions 手动运行部署工作流并选择 `main` 或明确的稳定 Tag。工作流会重新构建前端和 Worker，并调用初始化接口执行兼容的 D1 结构升级。升级前先按 [Cloudflare Workers 完整部署手册](./CLOUDFLARE_WORKERS_DEPLOYMENT.md#14-升级前备份) 导出 D1 备份。

### 9.2 升级 LONGOS

升级前备份数据库、`.env`、上传文件和 Docker 持久卷。更新源码后：

```bash
docker compose --profile nginx up -d --build
docker compose exec -T nginx php artisan saas:upgrade
```

Apache 模式将 profile 和应用服务名改为 `apache`。非 SaaS 单店模式执行：

```bash
docker compose --profile nginx up -d --build
docker compose exec -T nginx php artisan migrate --force
docker compose exec -T nginx php artisan optimize:clear
docker compose exec -T nginx php artisan queue:restart
```

包含弃单邮件召回功能的版本必须完成数据库迁移。升级后后台会出现“订单 -> 邮件召回订单”，可配置等待时间、冷却期、发送次数、链接有效期和模板，并可选择是否附带当前有效的折扣码。该功能使用 LONGOS 内置中继，不需要为 Cloud Mail 增加额外服务器。

## 10. 验收清单

- `docker compose ps` 中网站、Caddy、worker、scheduler、MySQL 和 `mail-relay` 均健康；
- `https://<LONGOS域名>/_longos/mail-relay/health` 返回成功；
- GitHub Actions 的 Worker 部署、Secret 写入和数据库初始化步骤均成功；
- Cloud Mail 的自动引擎可以用当前选中账户发信；
- LONGOS 的订单、账户、营销和弃单召回测试邮件均可投递；
- 收件原文显示 SPF、DKIM 和 DMARC 为 pass；
- `From` 是选中的租户/分类地址，没有被统一改写；
- `mailout` 为 DNS Only，PTR 与 A 记录一致；
- 未对公网开放 25、3000 或 8788 作为无认证中继入口。

## 11. 常见故障

### Worker 报 `RELAY_SHARED_SECRET is not configured`

GitHub Secret 未设置或部署工作流没有执行“配置内置邮件中继密钥”步骤。补充 Secret 后重新运行部署。

### 返回 401

通常是 Worker Secret 与 LONGOS `CLOUD_MAIL_RELAY_SHARED_SECRET` 不一致、时间偏差过大或请求签名失效。同步密钥并检查服务器 NTP。

### 返回 403

发件域不在允许列表、Cloud Mail 账户不属于当前用户、角色无权使用该域，或客户端身份与签名上下文不一致。不要通过关闭校验解决，应修正账户和域名授权。

### API 接受但对方收不到

检查 Postfix 队列和日志：

```bash
docker compose exec -T mail-relay postqueue -p
docker compose logs --since 30m mail-relay
```

重点检查出站 TCP 25、PTR、SPF、DKIM、DMARC、IP 信誉以及退信原因。Cloudflare 橙云不能修复 SMTP 投递或 IP 信誉问题。

### 所有邮件仍使用同一个地址

- Cloud Mail 发信前应选择目标邮箱账户；
- LONGOS 应分别配置默认、订单、账户、客服和营销发件身份；
- 共享平台域按 `<purpose>+<site-code>@domain` 分配地址；
- 检查租户是否错误继承了平台默认身份。
