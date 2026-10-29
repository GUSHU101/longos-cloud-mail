# Cloud Mail 的 Cloudflare Workers 完整部署手册

本文面向第一次部署 Cloud Mail 的用户，覆盖 Cloudflare 账户准备、D1、KV、R2、Worker、自定义域名、Email Routing、GitHub Actions、首次初始化、升级、备份、回滚和常见故障。

个人部署优先使用 `node scripts/deploy-wizard.mjs`，密钥只在本次进程中存在；需要 GitHub 审批、集中审计和多人运维时使用仓库内置的 GitHub Actions。两者调用同一个部署器，都会构建前端、校验配置、创建或复用 D1/KV/R2、验证 LONGOS 网关、部署 Worker、写入 Worker Secret，并调用受保护的初始化接口。只想看必须步骤时先阅读[从零部署与网站关联](./QUICK_START.md)。手工 Wrangler 配置只用于排障。

> Cloudflare Workers 不是完整 SMTP 服务器，也不能直接连接公网 TCP 25。Cloudflare Email Routing 负责把入站邮件交给 Worker；推荐由 LONGOS 内置 Postfix/OpenDKIM 直投站外邮件，不依赖第三方发件商。Cloudflare Email/Resend 只作为独立部署的兼容选项。

## 1. 部署完成后会有哪些资源

| 资源 | 作用 | 是否必须 |
|---|---|---|
| Worker | 运行 API、收信逻辑和前端静态资源 | 必须 |
| D1 | 保存用户、邮箱账户、邮件索引和系统设置 | 必须 |
| KV | 保存登录状态、缓存和短期数据 | 必须 |
| R2 | 保存邮件附件和对象文件 | 建议；不用附件时可不配置 |
| Workers AI | 邮件分析等 AI 功能 | 配置文件已绑定；实际调用按账户用量计费 |
| Custom Domain | 例如 `mail.example.com`，用于打开 Web 页面和调用 API | 建议；也可暂用 `workers.dev` |
| Email Routing | 把发往 `@example.com` 的邮件路由给 Worker | 收信必须 |

`CUSTOM_DOMAIN` 与收件域不是同一个概念：

- `mail.example.com` 可以是 Cloud Mail 的网页/API 地址；
- `example.com`、`example.net` 可以是用户实际创建邮箱的收件域；
- 每个收件域都必须在 Cloudflare 中单独启用 Email Routing。

## 2. 部署前准备

请先准备：

- 一个 Cloudflare 账户；
- 至少一个已接入该账户、状态为 Active 的域名；
- 一个能运行 GitHub Actions 的 GitHub 仓库；
- Cloud Mail 新版仓库的 `main` 分支或正式 Release；
- 若使用自定义域名，准备一个未被 A、AAAA 或 CNAME 占用的子域，例如 `mail.example.com`；
- 若接入 LONGOS 自建发信，LONGOS 的健康地址必须先返回 HTTP 200。

建议先确定下列值，后续保持一致：

| 名称 | 示例 | 说明 |
|---|---|---|
| `NAME` | `cloud-mail` | Worker 名称，也是默认 KV 名称 |
| `D1_DATABASE_NAME` | `cloud-mail` | D1 名称；不填写时与 `NAME` 相同 |
| `CUSTOM_DOMAIN` | `mail.example.com` | 不含 `https://` 和路径 |
| `DOMAIN` | `example.com` | 单域直接填写；多域可用逗号分隔或 JSON 数组 |
| `ADMIN` | `admin@example.com` | 必须使用 `DOMAIN` 中的一个域名 |
| `ADMIN_PASSWORD` | 12–30 字符强密码 | 仅首次创建管理员；已有管理员不会被重置 |
| `R2_BUCKET_NAME` | `auto` | 自动派生 `<NAME>-attachments` 并创建/复用；留空关闭 |

## 3. 接入域名并取得 Account ID

1. 登录 [Cloudflare Dashboard](https://dash.cloudflare.com/)；
2. 选择或添加用于收信的域名；
3. 按 Cloudflare 提示把域名 NS 改为 Cloudflare 分配的名称服务器；
4. 等待站点状态变为 **Active**；
5. 当 API Token 只允许访问一个账户时，部署器会自动识别 Account ID；
6. 只有 Token 能访问多个账户时，才复制 32 位 **Account ID**，在运行部署时填入表单的 `cloudflare_account_id`。

自定义 Worker 域名和 Email Routing 所在 Zone 必须属于同一个 Cloudflare 账户，否则 API Token 即使有效也不能完成路由配置。

## 4. 创建最小权限 API Token

进入 Cloudflare 的 **My Profile / API Tokens / Create Token**，可从 **Edit Cloudflare Workers** 模板开始，再确认至少包含以下权限：

| 范围 | 权限 | 级别 | 用途 |
|---|---|---|---|
| Workers 产品范围 | Admin（首次）/ Editor（升级） | Write | 创建或更新 Worker；旧界面对应 Account / Workers Scripts / Edit |
| Account | Workers KV Storage | Write（旧界面 Edit） | 查找或创建 KV |
| Account | D1 | Write（旧界面 Edit） | 查找或创建 D1 |
| Account | Workers R2 Storage | Write（旧界面 Edit） | Wrangler 创建或管理 R2 时需要 |
| Zone | Workers Routes | Write（旧界面 Edit） | 配置 Worker 自定义域名 |
| Account | Account Settings | Read | Wrangler 识别账户 |
| Zone | Zone | Read | 按 `DOMAIN` 识别活动 Zone |
| Zone | DNS | Write（旧界面 Edit） | 通过 LONGOS 同步 A/AAAA、DKIM、SPF 与 DMARC |
| Zone | Zone Settings | Write（旧界面 Edit） | 自动启用 Email Routing 及所需 MX/SPF |
| Zone | Email Routing Rules | Write（旧界面 Edit） | 自动把 Catch-all 指向当前 Worker |

资源范围建议设置为：

- Account Resources：只包含部署所用账户；
- Zone Resources：只包含收件 `DOMAIN` 与 LONGOS `MAIL_RELAY_DOMAINS` 涉及的域名；
- 不要使用 Global API Key；
- 不要把 Token 写入仓库文件、Issue、日志或 `wrangler.toml`。

创建后 Cloudflare 只完整显示一次 Token。立即复制，并通过一次性本地向导或受保护的 `production` Environment 提供为 `CLOUDFLARE_API_TOKEN`。部署器会先调用 Cloudflare Token Verify API，只有状态为 `active` 的 API Token 才会继续；Global API Key 即使同时填写 Account ID 也会被拒绝。

Dashboard 登录账号的管理员身份不会自动补齐 API Token 的权限；Token 只拥有创建时选中的权限和资源范围。部署器会并行读取 Worker、D1、KV 与启用时的 R2 账户 API；本地向导在准备 pnpm、安装依赖、测试和构建之前执行，GitHub 则在独立无密钥验证完成后的生产部署步骤开头执行。若多项缺失，会在同一条错误中列出资源名、HTTP 状态、Cloudflare 错误码和应补权限。该只读检查不会创建资源；读取成功也不能代替自动创建/更新所需的 Write 或 Workers Admin 权限。

官方参考：[Workers GitHub Actions](https://developers.cloudflare.com/workers/ci-cd/external-cicd/github-actions/)、[API Token 模板](https://developers.cloudflare.com/fundamentals/api/reference/template/)、[API 权限列表](https://developers.cloudflare.com/fundamentals/api/reference/permissions/)。

## 5. 准备 D1、KV 和 R2

### 5.1 D1 与 KV：推荐让工作流自动创建

首次部署不要设置 `D1_DATABASE_ID` 和 `KV_NAMESPACE_ID`：

- 工作流先查找名称为 `D1_DATABASE_NAME` 的 D1；没有才创建；
- 工作流先查找名称为 `NAME` 的 KV；没有才创建；
- 后续运行会复用同名资源，不会每次创建新数据库。

如果账户已有生产数据，必须显式填写原 ID，避免因改名绑定到空资源：

- Cloudflare Dashboard → Storage & Databases → D1 → 选择数据库，复制 UUID；
- Cloudflare Dashboard → Storage & Databases → KV → 选择 Namespace，复制 Namespace ID；
- `D1_DATABASE_NAME` 必须与 `D1_DATABASE_ID` 对应数据库的真实名称一致。

### 5.2 R2：由部署工具或工作流自动创建

保持 `R2_BUCKET_NAME=auto` 时，引导工具或 GitHub Actions 会从 Worker 名称派生 `<NAME>-attachments`。部署器先查询同名桶，存在则复用，不存在才创建，并在发布 Worker 前再次读取验收。Cloudflare 账户第一次使用 R2 时若要求接受服务条款或开通结算，请先在 Dashboard 的 R2 Object Storage 页面完成该账户级确认，然后重跑部署。

R2 桶可以保持私有，附件由 Worker 读取。若不需要附件，可以不设置 `R2_BUCKET_NAME`，工作流会从部署配置中移除 R2 绑定。

Cloudflare Workers、D1、KV、R2 和 Workers AI 都有各自的免费额度与计费规则，额度可能调整。生产前请在 Cloudflare Dashboard 的 Billing 和官方定价页核对当前方案，不能把“可免费开始”理解为“任何用量永久免费”。

官方参考：[D1 Wrangler 命令](https://developers.cloudflare.com/workers/wrangler/commands/d1/)、[KV Wrangler 命令](https://developers.cloudflare.com/kv/reference/kv-commands/)、[R2 CLI 入门](https://developers.cloudflare.com/r2/get-started/cli/)。

## 6. 把仓库配置到 GitHub

若直接使用新版独立仓库，可 Fork [GUSHU101/longos-cloud-mail](https://github.com/GUSHU101/longos-cloud-mail)，或把正式 Release 导入自己的私有仓库。生产部署建议始终从 `main` 或明确的 Release Tag 执行，不要从未审查的临时分支部署。

无需在 **Settings → Secrets and variables → Actions → Variables** 创建任何条目。一次性本地向导在当前终端询问全部配置；GitHub Actions 的非敏感配置由每次部署的 **Run workflow** 表单提供，生产 Secrets 使用受保护的 `production` Environment。

### 6.1 Run workflow 表单

| 表单输入 | 必填 | 示例 | 说明 |
|---|---:|---|---|
| `worker_name` | 否 | `cloud-mail` | Worker 和默认 KV 名称 |
| `custom_domain` | 建议 | `mail.example.com` | 不含协议和路径；留空时使用 `workers.dev` |
| `mail_domains` | 是 | `example.com,example.net` | 收件域，逗号分隔 |
| `admin_email` | 是 | `admin@example.com` | 域必须包含在收件域中 |
| `longos_relay_url` | LONGOS 发信需要 | `https://admin.example.com/_longos/mail-relay` | 公共域名、标准 HTTPS 443、固定路径 |
| `cloudflare_account_id` | 多账户 Token 才需要 | 32 位 Account ID | 单账户 Token 自动识别 |
| `d1_database_name` | 否 | `cloud-mail` | 留空时与 Worker 名相同 |
| `d1_database_id` | 生产升级建议 | D1 UUID | 首次可留空自动查找或创建 |
| `kv_namespace_id` | 生产升级建议 | 32 位 KV ID | 首次可留空自动查找或创建 |
| `r2_bucket_name` | 否 | `auto` | 默认自动命名、创建或复用；清空则关闭附件 |
| `project_link` | 否 | 仓库 HTTPS 地址 | 页面中的项目链接 |
| `ai_model` | 否 | `@cf/meta/llama-3.1-8b-instruct-fast` | 已提供默认值 |
| `cors_origins` | 否 | `["https://admin.example.com"]` | 同源保持默认 `[]` |
| `auto_configure_email_routing` | 否 | `true` | 自动配置收信 MX/SPF 与 Catch-all |
| `cloudflare_email` | 独立兼容模式 | `false` | LONGOS 一体化模式保持关闭 |
| `analysis_cache` | 否 | `false` | 邮件分析缓存开关 |

`cloudflare_email=true` 只控制出站的 `send_email` binding，不会启用入站 Email Routing。使用 LONGOS 自建发信时保持 `false`。

### 6.2 Secrets

GitHub 手动工作流没有 Secret 类型的输入字段，不要把密钥伪装成字符串表单字段。真正的部署时一次性输入使用 `node scripts/deploy-wizard.mjs`；它不会写 GitHub Secrets 或本地配置文件。GitHub Actions 部署则必须在 `Settings → Environments → production` 保存密钥。`node scripts/trigger-github-deployment.mjs` 可以隐藏录入并触发工作流，但底层仍是 `gh secret set --env production`，凭据会持久保存在 Environment，直到管理员删除或轮换。

给 `production` 配置默认分支限制和仓库所有者审批，并删除同名 Repository Secrets。工作流还会拒绝非所有者触发、非所有者重跑或非默认分支的生产部署。依赖安装、审计、测试和构建先在独立无密钥步骤完成，只在最后部署步骤注入凭据。公开 fork 和 PR 使用另一个只读验证工作流，不引用任何 Secrets。另在 `main` 分支规则中启用 PR、Code Owners 审核、`Secret-free verification` 必须通过和禁止 force push。

| Secret | 必填 | 说明 |
|---|---:|---|
| `ADMIN_PASSWORD` | 首次部署 | 管理员初始密码；只经初始化请求使用，不会保存为 Worker Secret；重复部署不覆盖原密码 |
| `CLOUDFLARE_API_TOKEN` | 是 | 第 4 节创建的 Token；网页或安全向导在部署时提交 |
| `JWT_SECRET` | 否 | 留空时首次自动生成，升级保留；仅主动轮换时设置 |
| `LONGOS_INTEGRATION_TOKEN` | 仅 LONGOS 发信 | 在 LONGOS 后台创建；与表单的 `longos_relay_url` 成对使用 |
| `RESEND_WEBHOOK_SECRET` | 仅 Resend 状态回调 | Resend 为 Webhook 签发的 `whsec_...` 密钥，不能使用 API Token 代替 |

首次部署成功后可以从 `production` Environment 删除 `ADMIN_PASSWORD`。后续升级会验证并保留已有管理员；只有更换 `ADMIN` 且新地址尚无账户时才需要重新添加初始密码。

如需主动轮换 `JWT_SECRET`（会注销现有会话），可生成新值：

```bash
openssl rand -hex 32
```

Windows PowerShell 没有 OpenSSL 时可使用：

```powershell
$bytes = New-Object byte[] 32
[Security.Cryptography.RandomNumberGenerator]::Fill($bytes)
[Convert]::ToHexString($bytes).ToLowerInvariant()
```

不要把 `JWT_SECRET` 当成管理员登录密码。通常不要创建它：工作流首次部署自动生成 Worker Secret，升级时保留原值。工作流还会为每次部署自动生成独立的 `INIT_SECRET`，仅在本次数据库初始化期间存在，验收成功后立即撤销。初始化会在 `ADMIN` 尚不存在时用 `ADMIN_PASSWORD` 自动创建管理员和主邮箱；密码经 HTTPS 发送后只保存 PBKDF2 哈希，不会保存成 Worker Secret。已有管理员的密码绝不被重复部署覆盖。

### 6.3 配置 Resend 投递状态回调（仅使用 Resend 时）

1. 先完成 Worker 自定义域部署，确认 `https://mail.example.com` 可以访问；
2. 在 Resend 创建 Webhook，Endpoint 填写 `https://mail.example.com/api/webhooks`；
3. 至少订阅 `email.sent`、`email.delivered`、`email.bounced`、`email.complained`、`email.delivery_delayed` 和 `email.failed`；
4. 复制该 Webhook 的 Signing Secret，而不是 Resend API Token；
5. 将 Signing Secret 保存为 GitHub Actions Secret `RESEND_WEBHOOK_SECRET`；
6. 重新运行生产部署工作流，使密钥写入 Cloudflare Worker Secret。

Worker 会使用原始请求体及 `svix-id`、`svix-timestamp`、`svix-signature` 校验签名。未配置密钥、签名错误、时间戳过期或载荷过大时均不会修改邮件状态。

### 6.4 三种典型配置

| 场景 | 表单 `cloudflare_email` | `LONGOS_RELAY_URL` | `LONGOS_INTEGRATION_TOKEN` | R2 |
|---|---:|---|---|---|
| 仅收信 | `false` | 留空 | 留空 | 可选 |
| Cloudflare 出站 | `true` | 留空 | 留空 | 建议 |
| LONGOS 自建出站 | `false` | 填写 | 填写 | 建议 |

如使用 Cloudflare 出站邮件，必须先在 Cloudflare 账户中完成对应邮件发送产品/域名的开通和验证；加入 binding 本身不会自动取得发信资格。

## 7. 关闭重复的 Cloudflare Git Builds

每个生产 Worker 只能保留一个部署控制器。若选择本仓库的 GitHub Actions 或本地一键部署器，请关闭此前在 Cloudflare Dashboard 连接的 Git Builds：

1. Workers & Pages → 选择目标 Worker；
2. Settings → Builds；
3. 关闭自动生产部署，或选择 **Disable builds**；
4. 确认不会有第二套流程在推送后覆盖 Worker。

不要让 Cloudflare Git Builds、GitHub Actions 和本地命令同时部署同一个 Worker。GitHub Actions 与本地命令虽然复用同一部署器，也应固定选择一种作为日常生产入口，避免并发发布和版本倒退。

## 8. 用 GitHub Actions 首次部署

### 8.1 先运行持续集成

进入 GitHub **Actions → CI → Run workflow**，选择 `main`。确认 Worker 单元测试、前端构建、Relay 测试和 Wrangler dry-run 全部通过。

### 8.2 运行生产部署

1. 进入 **Actions**；
2. 选择 **Deploy cloud-mail to Cloudflare Workers**；
3. 点击 **Run workflow**；
4. 分支保持仓库默认分支；
5. 填写本次部署表单，至少提供收件域和管理员邮箱；LONGOS 发信再提供网关 URL；
6. 再次点击绿色 **Run workflow**，打开本次运行并等待所有步骤变绿。

若使用 `node scripts/trigger-github-deployment.mjs`，向导已经完成以上表单与触发操作。若使用 `node scripts/deploy-wizard.mjs`，部署在本机直接执行，不会产生 GitHub Actions 运行记录。

工作流会依次执行：

1. 检出指定版本并调用与本地部署相同的 `scripts/deploy-cloudflare.mjs`；
2. 按锁文件安装 Worker 与 Vue 依赖；
3. 运行 Worker 测试、生产依赖审计和 Vue 正式构建；独立 Relay 由 CI 单独验证；
4. 校验域名、管理员、ID、布尔值、HTTPS 中继地址和 Secret；
5. 在生产凭据注入后、任何 Cloudflare 资源变更前验证 API Token、Account ID、Worker/D1/KV/R2 账户 API、收件 Zone、自定义域父 Zone、Email Routing 读取权限和 LONGOS 网关健康；本地向导会把这一步提前到准备 pnpm 之前；
6. 创建或复用 D1、KV 和 R2；
7. 生成临时生产配置：首次自动生成、升级保留 `jwt_secret`，写入一次性 `INIT_SECRET` 及 LONGOS Secret；
8. 自动撤销配置中已停用的旧 Secret；
9. 重试 `POST /api/init` 直到自定义域证书就绪，验收公开配置接口，并撤销和复核一次性 `INIT_SECRET`；
10. 启用 Email Routing、配置 Catch-all、同步 LONGOS DKIM/SPF/DMARC/A/AAAA，等待 DNS 状态收敛后完成最终验收。

正常情况下最后显示 `[完成] Cloud Mail 已部署`。如果任何校验、测试、网关健康检查或初始化失败，本次工作流为失败状态，不应继续配置邮件路由。

生产依赖审计会区分漏洞报告与 npm 安全公告服务的瞬时网络故障。本地部署仅在明确识别到超时、DNS、连接重置、限流或服务端错误且没有返回漏洞报告时警告并继续；发现中危以上漏洞或无法分类的错误仍立即失败。GitHub Actions 始终严格执行，安全公告服务不可用也会失败，因此本地警告不能视为“审计通过”。

部署 Worker 前还会对构建产物执行确定性资源预检：拒绝空目录、符号链接、疑似密钥文件、超过 20,000 个静态文件或超过 25 MiB 的单文件，并输出文件数、总大小、最大文件及资源清单哈希。20,000 是 Cloudflare 免费版的保守上限；付费版虽然允许更多文件，但 LONGOS 默认仍使用较低边界，保证同一发布包可在不同账户计划间迁移。

若 `assets-upload-session` 返回 Cloudflare 平台侧 5xx、`10013`、连接重置或超时，部署器会以 5、15、30 秒退避自动重试，最多共尝试四次。鉴权、配置、绑定和代码验证错误不会重试。四次都失败时，部署器不会替换线上 Worker，并在系统临时目录生成不含 Token、管理员密码和 Worker Secret 的 JSON 支持报告；该报告包含资源清单摘要、Wrangler/Node 版本、错误码和本机 Wrangler 日志位置，可直接随工单提交给 Cloudflare。

首次自动创建 D1/KV 后，GitHub 部署摘要会显示真实 ID。只要保持 Worker 与 D1 名称不变，后续部署会自动复用，不要求重复填写 ID；只有迁移、改名或存在同名资源时才需要显式固定 `d1_database_id` 与 `kv_namespace_id`。

## 9. 验证 Worker、自定义域名和初始化结果

### 9.1 查看部署状态

Cloudflare Dashboard → Workers & Pages → 目标 Worker：

- Deployments 中应出现本次新版本；
- Bindings 中应看到 D1 `db`、KV `kv`、Assets `assets`；
- 配置 R2 时应看到 `r2`；
- 配置 Workers AI 时应看到 `ai`；
- Secrets 中应看到 `jwt_secret`；一次性 `INIT_SECRET` 在初始化验收完成后应已被删除；
- 使用 LONGOS 时还应看到 `LONGOS_INTEGRATION_TOKEN`。
- 使用 Resend 状态回调时还应看到 `RESEND_WEBHOOK_SECRET`。

### 9.2 自定义域名

当 `CUSTOM_DOMAIN=mail.example.com` 时，Wrangler 使用 Custom Domain 路由。Cloudflare 会为该主机名创建 DNS 记录并管理 TLS 证书。部署前不要创建冲突的 A、AAAA 或 CNAME 记录。

等待证书生效后访问：

```bash
curl -fsS https://mail.example.com/api/setting/websiteConfig
```

应返回 JSON，而不是 404、Cloudflare 1014/1016 或源站页面。浏览器访问 `https://mail.example.com/` 应显示 Cloud Mail 登录页。

若没有设置 `CUSTOM_DOMAIN`，在 Worker 的 **Settings → Domains & Routes** 找到 `workers.dev` 地址并使用它。若账户禁用了 `workers.dev`，必须配置自定义域名。

官方参考：[Worker Custom Domains](https://developers.cloudflare.com/workers/configuration/routing/custom-domains/)。

## 10. 验收入站 Email Routing 自动配置

推荐权限完整时，部署器会对 `DOMAIN` 数组中的每个域自动完成：

1. 识别活动 Zone；
2. 启用 Email Routing 并添加 Cloudflare 所需 MX/SPF；
3. 读取当前 Catch-all；已经指向目标 Worker 时保持不动；
4. 否则把 Catch-all 幂等更新为 `Send to a Worker → NAME`；
5. 对返回结果再次验收；状态仍为 `misconfigured` 时明确提示 MX/SPF 冲突，不误报全部成功；
6. 若配置了 LONGOS 网关，从其受保护端点读取只含公开值的 DNS 清单，再由 GitHub Runner 使用本次 Token 发布发信身份记录；Cloudflare Token 不会发送给 LONGOS。

如果这些域仍由 Google Workspace、Microsoft 365 或其他邮箱服务商接收邮件，请在本次 **Run workflow** 表单关闭 `auto_configure_email_routing`，或在一次性向导的高级选项中关闭自动路由，避免切换 MX；Cloud Mail 要正式接管收信时再开启并重跑。

日志中的 `✓ example.com → cloud-mail` 表示 Catch-all 已完成；部署器会在 LONGOS 合并 SPF 后再次轮询，只有 Email Routing DNS 状态为 `ready` 时最终验收才为绿色。旧 Token 缺少新权限时不会回滚已发布的 Worker，但流程会准确失败并列出需补充的域；增加 `Zone:Read`、`DNS:Write`、`Zone Settings:Write`、`Email Routing Rules:Write`（旧界面名称为 `Edit`）后重跑即可。

注意：

- 如果域名原来已有 Google Workspace、Microsoft 365、企业邮局等 MX，启用 Email Routing 会改变入站投递路径；迁移前先备份并确认不会中断原邮箱；
- 自动化只操作 `DOMAIN` 明确列出的 Zone，不扫描或修改账户内其他域；
- 多域名会逐个启用 Email Routing 并指向同一 Worker，单域失败不隐藏其他域的结果；
- Email Routing 的入站处理与表单 `cloudflare_email` 对应的出站 binding 是两件独立的事；
- DNS 生效后，从外部真实邮箱发送测试邮件，不能只靠站内自发自收验证。

官方参考：[Email Routing API 与 Catch-all](https://developers.cloudflare.com/api/resources/email_routing/)、[Email Routing DNS](https://developers.cloudflare.com/api/resources/email_routing/subresources/dns/)。

## 11. 创建管理员并完成应用设置

1. 打开 Cloud Mail 登录页；
2. 使用 `ADMIN` 与部署时输入的 `ADMIN_PASSWORD` 直接登录，无需注册；
3. 登录后建议在个人设置中确认或修改密码；
4. 检查允许注册、允许收信、角色可用域名、发件次数等限制；
5. 创建一个测试邮箱账户；
6. LONGOS 一体化部署会自动锁定“LONGOS 内置邮件服务器”，不允许静默回退第三方；
7. 使用 LONGOS 时确认中继 URL 与本次部署输入一致；
8. 不要把 `JWT_SECRET` 或 `LONGOS_INTEGRATION_TOKEN` 填入网页设置。

管理员身份由 `ADMIN` 环境变量中的地址判定。更改 `ADMIN` 后，部署器会在新地址不存在时创建它；若该地址已存在则保留其原密码。变更前仍应确认新地址归属正确，避免把已有普通用户提升为管理员。

## 12. 上线验收

按顺序完成以下测试：

- 首页和 `/api/setting/websiteConfig` 可访问；
- GitHub Actions 的初始化步骤返回 `success`；
- 管理员可直接登录并打开系统设置；
- 可创建 `DOMAIN` 下的邮箱账户；
- 从外部邮箱发到测试地址，Cloud Mail 中能看到邮件；
- 回复或新建邮件时，`From` 是当前选中的邮箱，而非统一平台地址；
- 配置 R2 时，小附件和大附件都能上传、接收和下载；
- LONGOS 模式下，携带 `Authorization: Bearer <LONGOS_INTEGRATION_TOKEN>` 访问 `https://LONGOS域名/_longos/mail-relay/health` 返回 200，测试发信成功；
- Cloudflare 日志中没有持续的 D1、KV、R2 binding missing 错误；
- D1、KV 和 R2 的 ID/名称已记录到安全的运维台账。

## 13. 本地一键部署与 Wrangler 手动排障

正式本地部署不需要创建配置文件，优先在仓库根目录使用一次性安全向导：

```powershell
node scripts/deploy-wizard.mjs
```

它会在当前终端以可见文本读取 Token，方便本人核对，但部署摘要和后续日志不会回显；凭据只通过子进程环境运行统一部署器，不会写入文件。请勿在共享终端、录屏或直播环境使用。以下配置文件方式适合自动化或排障；真实文件会被 Git 忽略，但仍会在磁盘保存明文凭据：

```bash
cp .cloud-mail.deploy.env.example .cloud-mail.deploy.env
# 编辑本地配置后执行
node scripts/deploy-cloudflare.mjs
```

Windows PowerShell 复制命令为 `Copy-Item .cloud-mail.deploy.env.example .cloud-mail.deploy.env`。真实配置和生成的 `mail-worker/wrangler.generated.toml` 都已加入 `.gitignore`。以下小节仅用于部署工具失败后的逐步排障。

GitHub Actions 不可用时，可以在可信电脑上手动部署。正式向导只要求包含 npm 的 Node.js 22 或更高版本；若本机没有 pnpm/Corepack，会安全地临时准备固定版 pnpm。只有执行下面的逐条 Wrangler 手动排障命令时，才需要自行安装 pnpm 11 并打开浏览器完成 Cloudflare 登录。

Windows Node.js 24 可能不再附带 Corepack。不要为此改用来源不明的全局安装脚本；更新仓库后直接重新运行 `node scripts/deploy-wizard.mjs`。部署器会固定 pnpm 版本和 npm 官方注册表、禁用依赖安装脚本、从 npm 子进程环境中删除 Token/Secret/Password 等凭据，并在退出时清理临时目录。

### 13.1 安装并登录

```bash
corepack enable
pnpm --dir mail-worker install --frozen-lockfile
pnpm --dir mail-vue install --frozen-lockfile
cd mail-worker
pnpm wrangler login
pnpm wrangler whoami
```

服务器无浏览器时不要复制个人全局密钥。使用最小权限 Token 设置临时环境变量：

```bash
export CLOUDFLARE_API_TOKEN='仅当前会话使用的Token'
export CLOUDFLARE_ACCOUNT_ID='32位AccountID'
```

PowerShell：

```powershell
$env:CLOUDFLARE_API_TOKEN = '仅当前会话使用的Token'
$env:CLOUDFLARE_ACCOUNT_ID = '32位AccountID'
```

### 13.2 创建资源

```bash
pnpm wrangler d1 create cloud-mail
pnpm wrangler kv namespace create cloud-mail
pnpm wrangler r2 bucket create cloud-mail-attachments
```

记录前两条命令输出的 D1 UUID 和 KV Namespace ID。R2 不需要时跳过第三条。

### 13.3 建立生产配置

复制模板，不要直接修改提交到 Git 的模板：

```bash
cp wrangler-action.toml wrangler-production.toml
```

PowerShell：

```powershell
Copy-Item wrangler-action.toml wrangler-production.toml
```

编辑 `wrangler-production.toml` 并替换所有 `${...}` 占位符：

```toml
name = "cloud-mail"

[[routes]]
pattern = "mail.example.com"
custom_domain = true

[[d1_databases]]
binding = "db"
database_name = "cloud-mail"
database_id = "实际D1 UUID"

[[kv_namespaces]]
binding = "kv"
id = "实际KV ID"

[[r2_buckets]]
binding = "r2"
bucket_name = "cloud-mail-attachments"

[vars]
domain = ["example.com"]
admin = "admin@example.com"
analysis_cache = false
ai_model = "@cf/meta/llama-3.1-8b-instruct-fast"
longos_relay_url = ""
```

不用 R2 时删除整个 `[[r2_buckets]]` 段；不用自定义域名时删除整个 `[[routes]]` 段；不用 LONGOS 时保留空的 `longos_relay_url` 或删除该行。不要在 `[vars]` 中加入 `jwt_secret`、API Token 或 Relay Secret。

使用 Cloudflare 出站 binding 时追加：

```toml
[[send_email]]
name = "email"
```

### 13.4 测试、部署并写入 Secret

```bash
pnpm run test:unit
pnpm audit --prod --audit-level moderate
pnpm wrangler deploy -c wrangler-production.toml
pnpm wrangler secret put jwt_secret -c wrangler-production.toml
pnpm wrangler secret put INIT_SECRET -c wrangler-production.toml
```

两个 Secret 必须分别生成，不能使用相同值；均粘贴至少 32 位 URL-safe 随机字符。使用 LONGOS 时继续：

```bash
pnpm wrangler secret put LONGOS_INTEGRATION_TOKEN -c wrangler-production.toml
```

使用 Resend 状态回调时继续写入 Webhook Signing Secret：

```bash
pnpm wrangler secret put RESEND_WEBHOOK_SECRET -c wrangler-production.toml
```

Secret 写入会创建新的 Worker 版本。写入完成后调用初始化：

```bash
curl -fsS -X POST \
  -H "Authorization: Bearer 你的INIT_SECRET" \
  -H "Content-Type: application/json" \
  -d '{}' \
  https://mail.example.com/api/init
```

响应必须是纯文本 `success`。如果是 401，通常是 `INIT_SECRET` 未写入当前 Worker、密钥不一致或 Authorization 格式错误。

初始化成功后立即撤销这枚一次性密钥：

```bash
pnpm wrangler secret delete INIT_SECRET -c wrangler-production.toml
```

再次使用原 Bearer 值请求 `/api/init` 应返回 401；公开配置接口仍应正常。自动一键部署器会自动完成撤销与复核。

官方参考：[Wrangler 配置](https://developers.cloudflare.com/workers/wrangler/configuration/)、[Worker Secrets](https://developers.cloudflare.com/workers/configuration/secrets/)。

## 14. 升级前备份

生产升级前至少备份 D1，并记录当前 Worker Deployment ID：

```bash
cd mail-worker
pnpm wrangler d1 export cloud-mail --remote --output ../backup-cloud-mail-YYYYMMDD.sql
```

同时记录：

- D1 UUID、KV Namespace ID、R2 Bucket 名；
- 当前 Git Tag/Commit；
- Cloudflare Worker 的当前 Deployment/Version；
- 最近一次部署表单中的非敏感配置；
- Secret 是否存在，不要导出 Secret 原值到普通工单。

然后：

1. 把仓库同步到新的稳定版；
2. 先运行 CI；
3. 在部署工作流中选择新的 `main` 或 Tag；
4. 等待 `/api/init` 成功；
5. 重做第 12 节验收。

初始化接口采用兼容升级逻辑，但数据库备份仍是必须步骤。Cloudflare Worker 版本回滚不会自动回滚 D1、KV 或 R2 数据。

## 15. 回滚

代码部署异常时，可在 Cloudflare Dashboard 的 Worker → Deployments 中选择上一个正常版本并回滚，或本地执行：

```bash
cd mail-worker
pnpm wrangler rollback --name cloud-mail
```

也可以在 GitHub Actions 中选择上一个稳定 Tag 重新运行生产部署。注意：

- 回滚 Worker 代码不会恢复数据库；
- 如果新版本已执行不可兼容的数据迁移，必须评估并恢复 D1 备份；
- KV 登录状态和 R2 附件不会随 Worker 版本回滚；
- 回滚后重新验证首页、登录、收信、发信和附件。

官方参考：[Workers Rollbacks](https://developers.cloudflare.com/workers/versions-and-deployments/rollbacks/)。

## 16. 常见故障

### `Authentication error [code: 10000]`

API Token 无效、过期、账户范围不对或权限不足。重新创建最小权限 Token，并确认 GitHub Secret 没有多余空格或换行。

### `D1 database not found` 或 binding 名称错误

确认 `D1_DATABASE_ID` 属于当前账户，`D1_DATABASE_NAME` 是该数据库的真实名称，Worker Bindings 中的变量名必须为 `db`。

### `KV namespace ... not found`

确认 KV ID 是生产 Namespace ID，不是 preview ID；Bindings 中变量名必须为 `kv`。

### `R2 bucket ... not found`

当前引导工具和 GitHub Actions 都会按 `R2_BUCKET_NAME` 查找 Bucket，不存在时自动创建。若仍报错，请确认 API Token 具有当前账户的 R2 编辑权限，且 Bucket 名称符合小写命名规则；不使用附件则留空 `R2_BUCKET_NAME` 后重跑。

### 自定义域名报 1014、1016、证书等待或显示别的网站

确认域名 Zone 在同一账户，删除冲突的 A/AAAA/CNAME，等待 Custom Domain 状态变为 Active。不要把 `CUSTOM_DOMAIN` 写成 URL。

### 首页正常但收不到邮件

重点检查 Email Routing，而不是 Worker 网页路由：

- 收件域是否已启用 Email Routing；
- MX 是否被 Cloudflare 验证；
- Catch-all 或目标地址规则是否指向正确 Worker；
- 多个域是否逐一配置；
- Worker Logs 中 `email()` handler 是否有事件和异常。

### `/api/init` 返回 401

GitHub Actions 会自动生成并写入 `INIT_SECRET`；直接重跑部署即可。手动部署时，确认 Worker 的 `INIT_SECRET` 与请求 Bearer 值一致，且至少 32 位并只含字母、数字、下划线或连字符。

### `/api/init` 返回 500

打开 Worker Logs，优先查 D1 binding、数据库 ID、迁移 SQL 和账户权限。不要反复改名创建多个空 D1；先确认当前 Worker 实际绑定哪个数据库。

### Worker 能收信但不能发信

收信和发信是两条链路：

- Cloudflare 引擎：确认部署表单 `cloudflare_email=true` 且账户已取得出站能力；
- Resend：确认 API Token 与发件域验证；
- LONGOS：确认带 Bearer 令牌的健康地址返回 200、`LONGOS_RELAY_URL` 正确、系统集成令牌有效、服务器出站 TCP 25/PTR/SPF/DKIM/DMARC 正常；
- 确认发件时选中的邮箱属于当前用户且域在角色允许列表中。

### GitHub Actions 成功但随后配置被覆盖

检查 Cloudflare Git Builds 是否仍开启，或是否有另一个仓库/工作流部署同名 Worker。生产 Worker 只能保留一个部署控制器。

## 17. 上线前最终清单

- [ ] 域名在正确 Cloudflare 账户中且状态 Active
- [ ] API Token 仅授权目标账户与 Zone
- [ ] 一次性部署的密钥只在本地向导进程；GitHub 部署的密钥只在受保护的 `production` Environment
- [ ] `mail_domains`/`DOMAIN` 至少包含一个有效域名，`ADMIN` 使用其中一个域
- [ ] D1 名称与 ID 匹配，KV ID 指向生产 Namespace
- [ ] 需要附件时已填写 R2 Bucket 名称，且账户已开通 R2（Bucket 由部署器复用或创建）
- [ ] Cloudflare Git Builds 已禁用
- [ ] CI 与生产部署工作流全部通过
- [ ] `POST /api/init` 返回 `success`
- [ ] 自定义域名页面和公开配置 API 正常
- [ ] 每个收件域都已启用 Email Routing 并指向正确 Worker
- [ ] 外部收信、出站发信和附件测试通过
- [ ] D1 备份、资源 ID 和回滚版本已记录
