# Cloud Mail + LONGOS 一体化自建邮件部署与升级

如需最快上线，请先按[Cloud Mail + LONGOS 最短部署流程](./QUICK_START.md)执行；本文保留服务器、DNS、租户发件域、升级和故障恢复的完整细节。

本文适用于新版独立仓库 `GUSHU101/longos-cloud-mail` 的 `main` 分支和正式 Release，目标是在同一台服务器部署 LONGOS 网站、Postfix 和 OpenDKIM，并让 Cloudflare Worker 通过 LONGOS 的 HTTPS 入口发信。服务器端不需要再单独克隆或部署本仓库的 `mail-relay` 目录。

Cloudflare 账户、API Token 权限、D1/KV/R2 创建、自定义域名、Email Routing、GitHub Actions 首次部署、初始化、备份和回滚的逐步操作已独立整理为：[Cloudflare Workers 完整部署手册](./CLOUDFLARE_WORKERS_DEPLOYMENT.md)。请先完成该手册，再回到本文接入 LONGOS 出站邮件。

## 1. 架构与边界

```text
浏览器
  │
  ├─ Cloud Mail UI / API ── Cloudflare Worker
  │                              │ HTTPS + Bearer 集成令牌
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
- LONGOS 的 Coolify Raw Compose 会把邮件中继作为网站栈的一部分自动安装和升级。
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

LONGOS 正式环境只使用 GitHub + Coolify Raw Docker Compose + Coolify 集成 Caddy。完整步骤见 LONGOS 仓库的 `docs/CONFIGURATION.md`；核心流程如下：

1. 在 Coolify 服务器级 Proxy 中选择 Caddy，并关闭默认请求处理器覆盖；
2. 从 `GUSHU101/LONGOS` 创建 Git-based Docker Compose 应用；
3. Compose 路径填写 `/docker-compose.yml`，启用 Raw Compose，并连接 external `coolify` 网络；
4. 至少设置 `DOMAIN`、`SAAS_BASE_DOMAIN` 和 `ADMIN_EMAIL`；
5. 建议同时设置 `MAIL_RELAY_HOSTNAME`、`MAIL_RELAY_DOMAINS`、`MAIL_RELAY_ALLOWED_SENDER_DOMAINS` 和 `MAIL_RELAY_PLATFORM_SENDER_DOMAIN`；
6. 点击 Deploy。首次安装、数据库、队列、调度器、Postfix/OpenDKIM、Caddy 路由和后续升级都自动完成。

Coolify 自动生成并持久保存 APP_KEY、数据库密码、管理员初始密码、边缘鉴权密钥和两个内部邮件 HMAC 密钥。不要手工填写或复制任何 `SERVICE_*` 值，也不要把内部 `MAIL_RELAY_SHARED_SECRET` / `CLOUD_MAIL_RELAY_SHARED_SECRET` 放入 GitHub、Cloudflare、网页或 D1。

### 安装后健康检查

在 Coolify 资源页确认 `app`、`mysql` 和 `mail-relay` 为 healthy，worker 与 scheduler 持续运行。随后在 LONGOS 主站后台创建 Cloud Mail 系统集成令牌，再在 Cloud Mail“系统设置 → LONGOS 内置邮件服务器”点击“测试连接”。

该检查会携带 `cloud-mail:health` 权限访问主站 `/_longos/mail-relay/health`，并由 LONGOS 在私有网络签名访问中继；成功才表示 HTTPS 网关、令牌、中继、Postfix 和 OpenDKIM 当前可用。真正的 `/v1/send` 请求还会额外校验 `cloud-mail:send` 权限和当前租户发件域。

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

在 LONGOS 主站后台“邮件设置/诊断”复制实际生成的 DKIM TXT，并逐条发布到 DNS。初次上线建议先使用 `p=none` 观察 DMARC 报告；确认 SPF、DKIM 对齐和正常投递后，再逐步改为 `quarantine` 或 `reject`。

## 5. 配置 GitHub Actions

不再预先创建 Actions Variables。所有非敏感配置在每次部署的 **Run workflow** 表单中填写：

| 表单字段 | 示例 | 说明 |
|---|---|---|
| `worker_name` | `cloud-mail` | Worker、D1、KV 默认名称 |
| `custom_domain` | `mail.example.com` | 不带协议和路径 |
| `mail_domains` | `example.com` | 单域直接填写；多域逗号分隔 |
| `admin_email` | `admin@example.com` | Cloud Mail 管理员地址 |
| `cloudflare_account_id` | `...` | 多账户 Token 才填写；单账户自动识别 |
| `d1_database_name` | `cloud-mail` | 默认与 Worker 名相同 |
| `d1_database_id` | `...` | 首次可留空，由工作流查找或创建 |
| `kv_namespace_id` | `...` | 首次可留空，由工作流查找或创建 |
| `r2_bucket_name` | `cloud-mail-attachments` | 使用附件时填写 |
| `project_link` | 仓库或站点地址 | 可选 |
| `ai_model` | `@cf/meta/llama-3.1-8b-instruct-fast` | 默认值已提供 |
| `cloudflare_email` | `false` | LONGOS 自建出站保持关闭 |
| `analysis_cache` | `false` | 可选 |
| `longos_relay_url` | `https://admin.example.com/_longos/mail-relay` | 公共域名、标准 HTTPS 443、固定路径 |
| `cors_origins` | `[]` | 同源保持默认；跨域客户端填 HTTPS Origin JSON 数组 |

### Secrets

GitHub 没有密文 `workflow_dispatch` 输入类型，因此下列值不能放入 Run workflow 表单。部署前把它们保存到 `Settings → Environments → production`，或运行 `node scripts/trigger-github-deployment.mjs` 在部署向导中隐藏输入并自动触发。向导通过 stdin 上传密钥，不会把值放进命令参数或工作流事件。

| 名称 | 值 |
|---|---|
| `CLOUDFLARE_API_TOKEN` | 能部署 Worker，并管理 D1/KV、自定义域、Email Routing 与发信 DNS 的受限令牌 |
| `JWT_SECRET` | 通常不创建；首次自动生成并在升级时保留，主动轮换时才设置 |
| `LONGOS_INTEGRATION_TOKEN` | 在 LONGOS 后台“系统集成令牌”创建的 Cloud Mail 令牌 |

`production` Environment 应只允许默认分支并要求仓库所有者审批；删除同名 Repository Secrets。部署工作流只允许仓库所有者手动部署默认分支，生产凭据也只注入最终部署步骤。

`LONGOS_INTEGRATION_TOKEN` 只在 LONGOS 主站控制域名后台创建一次，权限限定为 `cloud-mail:send` 和 `cloud-mail:health`，即可服务全部有效租户。普通租户后台无需、也不会提供重复绑定。令牌由 LONGOS 使用 `APP_KEY` 加密保存，可在后台随时显示、复制，也可查看过期时间、最后调用时间、最后显示时间和显示次数并立即撤销。显示接口按管理员限流。工作流会自动维护 `jwt_secret` 并把该令牌写入 Cloudflare Worker Secret，不会放入 `wrangler.toml`、网页或 D1。部署最后从受保护的 LONGOS 端点读取只含公开值的邮件 DNS 清单，Cloudflare 写操作始终由 GitHub Runner 执行；Cloudflare Token 不会发送给 LONGOS，因此 Coolify 不必再保存第二份。旧版仅保存哈希的令牌需重新创建。轮换 `APP_KEY` 时须先把旧密钥加入 `APP_PREVIOUS_KEYS`；下一次显示令牌时 LONGOS 会自动使用当前密钥重新加密。`APP_KEY` 和仍在使用的旧密钥都必须纳入安全备份。

首次部署可以不填 `D1_DATABASE_ID` 和 `KV_NAMESPACE_ID`；工作流会优先查找与 `D1_DATABASE_NAME` 同名的 D1 和与 `NAME` 同名的 KV，不存在时才创建。已有生产数据时，建议显式填写原 D1/KV ID，避免绑定到新资源；`D1_DATABASE_NAME` 必须与该 ID 对应数据库的真实名称一致。

`LONGOS_RELAY_URL` 和 `LONGOS_INTEGRATION_TOKEN` 必须成对配置。创建令牌后可使用以下方式验证：

```bash
curl -fsS -H "Authorization: Bearer <LONGOS_INTEGRATION_TOKEN>" \
  https://admin.example.com/_longos/mail-relay/health
```

对应的无命令行验证方式是进入 Cloud Mail “系统设置 → LONGOS 内置邮件服务器”，点击“测试连接”。该检查会真实验证 Worker Secret、LONGOS 令牌权限、HTTPS 网关和私有中继，不是单纯检查配置字段。

一套 Cloud Mail 服务多个 LONGOS 子站时，`LONGOS_RELAY_URL` 必须指向控制站 HTTPS 域名，经任何租户域名调用都会被拒绝。网关从 `<purpose>+<site-code>@<platform-domain>` 解析稳定站点 code，在控制库核验租户仍为 active 后才投递，并会覆盖请求中不可信的租户字段。更换子站商店域名不改变站点 code，不需换令牌、重新部署 Worker 或重建邮箱。

无中断轮换步骤：创建新令牌 → 通过安全部署向导或 Environment 更新 Secret 并重新部署 Worker → 在 Cloud Mail 中测试连接 → 撤销旧令牌。

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
5. 填写收件域、管理员邮箱、LONGOS 网关及本次资源设置；
6. 等待构建、D1/KV 绑定、Worker 生产部署、Secret 写入和数据库初始化全部成功。

也可以使用 GitHub CLI：

```bash
node scripts/trigger-github-deployment.mjs
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
2. 配置 `LONGOS_RELAY_URL` 和 Worker Secret `LONGOS_INTEGRATION_TOKEN` 后，邮件引擎会锁定为“LONGOS 内置邮件服务器”；
3. 邮局异常时明确失败并记录原因，不会静默改用 Cloudflare Email 或 Resend；
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

1. 在 Coolify 环境变量中把新域加入 `MAIL_RELAY_DOMAINS` 和 `MAIL_RELAY_ALLOWED_SENDER_DOMAINS`；
2. 点击 Redeploy，保留原域直到迁移结束；
3. 发布新域的 SPF、DKIM 和 DMARC；
4. 在 LONGOS 主站“租户站点”中将该已签名发件域唯一分配给目标租户；
5. 使用测试邮箱检查 SPF/DKIM/DMARC 均为 pass；
6. 在租户后台切换默认和各业务分类发件身份；
7. 确认旧队列清空后，先解除旧发件域的租户分配，再从中继允许列表移除旧域。

LONGOS 邮件设置页会自动列出“中继已签名”且“主站已分配给当前租户”的域名，租户管理员可直接在默认或业务分类发件邮箱中选用。网站访问域与发件域是两类独立资源，例如 `www.example.com` 店铺可分配 `example.com` 作为发件域。保存和真正投递都会重复校验域名归属；更换发件域不需要新建 Cloud Mail 令牌或重新绑定子站。

一体化升级会自动创建发件域分配表，并迁移旧版中能安全确定租户归属的已签名域。无法明确推断归属的域不会自动授权，由主站管理员在“租户站点”中分配即可。

> Cloudflare Worker 的 `domain` 变量控制 Cloud Mail 可创建/接收的邮箱域；LONGOS 服务器的 `MAIL_RELAY_DOMAINS` 和 `MAIL_RELAY_ALLOWED_SENDER_DOMAINS` 控制出站签名与发件许可。要使用新域对外发信，不能只更新 Worker `domain`，必须同时完成上述中继配置。

Redeploy 后在 LONGOS 后台复制新域的 DKIM 记录。DKIM 私钥和 Postfix 队列位于 Coolify 管理的命名卷，普通部署不会丢失。不要删除 MySQL、邮件或 LONGOS 持久卷来“强制重装”。

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

升级前在 Coolify 备份 MySQL 和所有 LONGOS 命名卷。把审核后的代码推送到 Coolify 绑定分支，使用 Auto Deploy 或点击 Deploy；新容器会取得共享部署锁并自动执行 `saas:upgrade --if-needed`，无需在容器中运行 Composer、npm、迁移或队列命令。

包含弃单邮件召回功能的版本会由同一入口自动完成数据库迁移。升级后后台会出现“订单 -> 邮件召回订单”，可配置等待时间、冷却期、发送次数、链接有效期和模板，并可选择是否附带当前有效的折扣码。该功能使用 LONGOS 内置中继，不需要为 Cloud Mail 增加额外服务器。

## 10. 验收清单

- Coolify 中 `app`、MySQL 和 `mail-relay` 均健康，worker 与 scheduler 持续运行，服务器级 Caddy 正常；
- 携带 `LONGOS_INTEGRATION_TOKEN` 访问 `https://<LONGOS域名>/_longos/mail-relay/health` 返回成功；
- GitHub Actions 的 Worker 部署、Secret 写入和数据库初始化步骤均成功；
- Cloud Mail 的自动引擎可以用当前选中账户发信；
- LONGOS 的订单、账户、营销和弃单召回测试邮件均可投递；
- 收件原文显示 SPF、DKIM 和 DMARC 为 pass；
- `From` 是选中的租户/分类地址，没有被统一改写；
- `mailout` 为 DNS Only，PTR 与 A 记录一致；
- 未对公网开放 25、3000 或 8788 作为无认证中继入口。

## 11. 常见故障

### Worker 报 `LONGOS_INTEGRATION_TOKEN is not configured`

GitHub Secret 未设置或部署工作流没有执行“配置 LONGOS 系统集成令牌”步骤。在 LONGOS 后台重新创建令牌，补充 Secret 后重新运行部署。

### 返回 401

通常是令牌已过期、已撤销、缺少 Cloud Mail 权限，或 Worker Secret 填写错误。在 LONGOS 的系统集成令牌页检查末尾标识与最后使用时间；必要时撤销旧令牌并创建新令牌。

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
