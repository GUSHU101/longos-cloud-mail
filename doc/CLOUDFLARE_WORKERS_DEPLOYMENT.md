# Cloud Mail 的 Cloudflare Workers 完整部署手册

本文面向第一次部署 Cloud Mail 的用户，覆盖 Cloudflare 账户准备、D1、KV、R2、Worker、自定义域名、Email Routing、GitHub Actions、首次初始化、升级、备份、回滚和常见故障。

推荐使用仓库内置的 GitHub Actions 工作流。它会构建前端、校验配置、创建或复用 D1/KV、部署 Worker、写入 Secret，并调用受保护的初始化接口。手动 Wrangler 部署仅用于无法使用 GitHub Actions 或需要本地排障的场景。

> Cloudflare Workers 不是完整 SMTP 服务器。Cloudflare Email Routing 负责把入站邮件交给 Worker；出站发信需要 Cloudflare Email、Resend 或 LONGOS/自建中继。若选择 LONGOS 自建发信，还需继续阅读 [Cloud Mail + LONGOS 一体化自建邮件部署与升级](./LONGOS_SELF_HOSTED_DEPLOYMENT.md)。

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
| `DOMAIN` | `["example.com"]` | JSON 数组，不是逗号分隔文本 |
| `ADMIN` | `admin@example.com` | 必须使用 `DOMAIN` 中的一个域名 |
| `R2_BUCKET_NAME` | `cloud-mail-attachments` | 全账户唯一的 R2 桶名 |

## 3. 接入域名并取得 Account ID

1. 登录 [Cloudflare Dashboard](https://dash.cloudflare.com/)；
2. 选择或添加用于收信的域名；
3. 按 Cloudflare 提示把域名 NS 改为 Cloudflare 分配的名称服务器；
4. 等待站点状态变为 **Active**；
5. 在账户首页、站点 Overview 右侧或浏览器地址栏中复制 32 位十六进制 **Account ID**；
6. 记录为后续 GitHub Variable `CLOUDFLARE_ACCOUNT_ID`。

自定义 Worker 域名和 Email Routing 所在 Zone 必须属于同一个 Cloudflare 账户，否则 API Token 即使有效也不能完成路由配置。

## 4. 创建最小权限 API Token

进入 Cloudflare 的 **My Profile / API Tokens / Create Token**，可从 **Edit Cloudflare Workers** 模板开始，再确认至少包含以下权限：

| 范围 | 权限 | 级别 | 用途 |
|---|---|---|---|
| Account | Workers Scripts | Edit | 发布 Worker |
| Account | Workers KV Storage | Edit | 查找或创建 KV |
| Account | D1 | Edit | 查找或创建 D1 |
| Account | Workers R2 Storage | Edit | 本地 Wrangler 创建或管理 R2 时需要 |
| Zone | Workers Routes | Edit | 配置 Worker 自定义域名 |
| Account | Account Settings | Read | Wrangler 识别账户 |

资源范围建议设置为：

- Account Resources：只包含部署所用账户；
- Zone Resources：只包含 Cloud Mail 使用的域名；
- 不要使用 Global API Key；
- 不要把 Token 写入仓库文件、Issue、日志或 `wrangler.toml`。

创建后 Cloudflare 只完整显示一次 Token。立即复制，并在 GitHub 中保存为 Secret `CLOUDFLARE_API_TOKEN`。

官方参考：[Workers GitHub Actions](https://developers.cloudflare.com/workers/ci-cd/external-cicd/github-actions/)、[API Token 模板](https://developers.cloudflare.com/fundamentals/api/reference/template/)、[API 权限列表](https://developers.cloudflare.com/fundamentals/api/reference/permissions/)。

## 5. 准备 D1、KV 和 R2

### 5.1 D1 与 KV：推荐让工作流自动创建

首次部署时可不设置 `D1_DATABASE_ID` 和 `KV_NAMESPACE_ID`：

- 工作流先查找名称为 `D1_DATABASE_NAME` 的 D1；没有才创建；
- 工作流先查找名称为 `NAME` 的 KV；没有才创建；
- 后续运行会复用同名资源，不会每次创建新数据库。

如果账户已有生产数据，必须显式填写原 ID，避免因改名绑定到空资源：

- Cloudflare Dashboard → Storage & Databases → D1 → 选择数据库，复制 UUID；
- Cloudflare Dashboard → Storage & Databases → KV → 选择 Namespace，复制 Namespace ID；
- `D1_DATABASE_NAME` 必须与 `D1_DATABASE_ID` 对应数据库的真实名称一致。

### 5.2 R2：需要附件时先手动创建

当前工作流不会自动创建 R2 桶。需要附件功能时：

1. Cloudflare Dashboard → R2 Object Storage；
2. 首次使用时完成 R2 开通；
3. 点击 **Create bucket**；
4. 输入例如 `cloud-mail-attachments`；
5. 把完全相同的名称保存为 GitHub Variable `R2_BUCKET_NAME`。

R2 桶可以保持私有，附件由 Worker 读取。若不需要附件，可以不设置 `R2_BUCKET_NAME`，工作流会从部署配置中移除 R2 绑定。

Cloudflare Workers、D1、KV、R2 和 Workers AI 都有各自的免费额度与计费规则，额度可能调整。生产前请在 Cloudflare Dashboard 的 Billing 和官方定价页核对当前方案，不能把“可免费开始”理解为“任何用量永久免费”。

官方参考：[D1 Wrangler 命令](https://developers.cloudflare.com/workers/wrangler/commands/d1/)、[KV Wrangler 命令](https://developers.cloudflare.com/kv/reference/kv-commands/)、[R2 CLI 入门](https://developers.cloudflare.com/r2/get-started/cli/)。

## 6. 把仓库配置到 GitHub

若直接使用新版独立仓库，可 Fork [GUSHU101/longos-cloud-mail](https://github.com/GUSHU101/longos-cloud-mail)，或把正式 Release 导入自己的私有仓库。生产部署建议始终从 `main` 或明确的 Release Tag 执行，不要从未审查的临时分支部署。

进入仓库：**Settings → Secrets and variables → Actions**。

### 6.1 Variables

在 **Variables** 页签创建：

| Variable | 必填 | 示例 | 说明 |
|---|---:|---|---|
| `CLOUDFLARE_ACCOUNT_ID` | 是 | 32 位 Account ID | Cloudflare 账户 ID |
| `NAME` | 否 | `cloud-mail` | 默认 `cloud-mail` |
| `D1_DATABASE_NAME` | 否 | `cloud-mail` | 默认与 `NAME` 相同 |
| `CUSTOM_DOMAIN` | 建议 | `mail.example.com` | 不含协议和路径；留空时使用 `workers.dev` |
| `DOMAIN` | 是 | `["example.com","example.net"]` | 必须是合法 JSON 数组 |
| `ADMIN` | 是 | `admin@example.com` | 域必须包含在 `DOMAIN` 中 |
| `D1_DATABASE_ID` | 生产升级建议 | D1 UUID | 首次自动创建时可留空 |
| `KV_NAMESPACE_ID` | 生产升级建议 | 32 位 KV ID | 首次自动创建时可留空 |
| `R2_BUCKET_NAME` | 附件需要 | `cloud-mail-attachments` | 必须提前存在 |
| `PROJECT_LINK` | 否 | 仓库 HTTPS 地址 | 页面中的项目链接 |
| `AI_MODEL` | 否 | `@cf/meta/llama-3.1-8b-instruct-fast` | 默认值已提供 |
| `ANALYSIS_CACHE` | 否 | `false` | 只能填 `true` 或 `false` |
| `CF_EMAIL` | 否 | `false` | 是否加入 Cloudflare 出站邮件 binding |
| `LONGOS_RELAY_URL` | LONGOS 发信需要 | `https://admin.example.com/_longos/mail-relay` | 必须 HTTPS；不要以 `/health` 结尾 |

`CF_EMAIL=true` 只控制出站的 `send_email` binding，不会启用入站 Email Routing。使用 LONGOS 自建发信时通常保持 `false`。

### 6.2 Secrets

在 **Secrets** 页签创建：

| Secret | 必填 | 说明 |
|---|---:|---|
| `CLOUDFLARE_API_TOKEN` | 是 | 第 4 节创建的 Token |
| `JWT_SECRET` | 是 | 初始化和 JWT 签名密钥，至少 32 个 URL-safe 字符 |
| `RELAY_SHARED_SECRET` | 仅 LONGOS 发信 | 必须与 LONGOS 的 `CLOUD_MAIL_RELAY_SHARED_SECRET` 逐字一致 |

生成 `JWT_SECRET`：

```bash
openssl rand -hex 32
```

Windows PowerShell 没有 OpenSSL 时可使用：

```powershell
$bytes = New-Object byte[] 32
[Security.Cryptography.RandomNumberGenerator]::Fill($bytes)
[Convert]::ToHexString($bytes).ToLowerInvariant()
```

不要把 `JWT_SECRET` 当成管理员登录密码。首次初始化只建表；部署完成后用 `ADMIN` 地址在注册页面创建账户，该账户会被识别为管理员。

### 6.3 三种典型配置

| 场景 | `CF_EMAIL` | `LONGOS_RELAY_URL` | `RELAY_SHARED_SECRET` | R2 |
|---|---:|---|---|---|
| 仅收信 | `false` | 留空 | 留空 | 可选 |
| Cloudflare 出站 | `true` | 留空 | 留空 | 建议 |
| LONGOS 自建出站 | `false` | 填写 | 填写 | 建议 |

如使用 Cloudflare 出站邮件，必须先在 Cloudflare 账户中完成对应邮件发送产品/域名的开通和验证；加入 binding 本身不会自动取得发信资格。

## 7. 关闭重复的 Cloudflare Git Builds

本仓库以 GitHub Actions 作为唯一生产部署控制器。若此前在 Cloudflare Dashboard 连接过 Git 仓库：

1. Workers & Pages → 选择目标 Worker；
2. Settings → Builds；
3. 关闭自动生产部署，或选择 **Disable builds**；
4. 确认不会有第二套流程在推送后覆盖 Worker。

不要同时让 Cloudflare Git Builds 和 GitHub Actions 部署同一个 Worker。否则较晚完成的流程可能用缺少 D1、KV、R2、Secret 或 LONGOS 参数的配置覆盖生产版本。

## 8. 用 GitHub Actions 首次部署

### 8.1 先运行持续集成

进入 GitHub **Actions → CI → Run workflow**，选择 `main`。确认 Worker 单元测试、前端构建、Relay 测试和 Wrangler dry-run 全部通过。

### 8.2 运行生产部署

1. 进入 **Actions**；
2. 选择 **Deploy cloud-mail to Cloudflare Workers**；
3. 点击 **Run workflow**；
4. 分支选择 `main`，或选择要部署的稳定版本引用；
5. 再次点击绿色 **Run workflow**；
6. 打开本次运行，等待所有步骤变绿。

工作流会依次执行：

1. 检出指定版本；
2. 安装锁定依赖；
3. 运行依赖审计和 Worker 单元测试；
4. 校验域名、管理员、ID、布尔值、HTTPS 中继地址和 Secret；
5. 创建或复用 KV；
6. 创建或复用 D1；
7. 构建 Vue 前端并部署 Worker；
8. 用 `wrangler secret put` 写入 `jwt_secret`；
9. 如已配置，再写入 `RELAY_SHARED_SECRET`；
10. 调用 `POST /api/init` 创建或升级 D1 结构。

正常情况下最后一步显示 `Setup completed`。如果任何校验或初始化失败，本次工作流为失败状态，不应继续配置邮件路由。

首次自动创建 D1/KV 后，建议在 Cloudflare Dashboard 复制真实 ID，补写到 GitHub Variables。这样即使以后修改 `NAME`，升级仍明确绑定原生产数据。

## 9. 验证 Worker、自定义域名和初始化结果

### 9.1 查看部署状态

Cloudflare Dashboard → Workers & Pages → 目标 Worker：

- Deployments 中应出现本次新版本；
- Bindings 中应看到 D1 `db`、KV `kv`、Assets `assets`；
- 配置 R2 时应看到 `r2`；
- 配置 Workers AI 时应看到 `ai`；
- Secrets 中应看到 `jwt_secret`，但不能读取原值；
- 使用 LONGOS 时还应看到 `RELAY_SHARED_SECRET`。

### 9.2 自定义域名

当 `CUSTOM_DOMAIN=mail.example.com` 时，Wrangler 使用 Custom Domain 路由。Cloudflare 会为该主机名创建 DNS 记录并管理 TLS 证书。部署前不要创建冲突的 A、AAAA 或 CNAME 记录。

等待证书生效后访问：

```bash
curl -fsS https://mail.example.com/api/setting/websiteConfig
```

应返回 JSON，而不是 404、Cloudflare 1014/1016 或源站页面。浏览器访问 `https://mail.example.com/` 应显示 Cloud Mail 登录页。

若没有设置 `CUSTOM_DOMAIN`，在 Worker 的 **Settings → Domains & Routes** 找到 `workers.dev` 地址并使用它。若账户禁用了 `workers.dev`，必须配置自定义域名。

官方参考：[Worker Custom Domains](https://developers.cloudflare.com/workers/configuration/routing/custom-domains/)。

## 10. 配置入站 Email Routing

部署 Worker 不等于已经能收信。对 `DOMAIN` 数组中的每一个域名分别执行：

1. Cloudflare Dashboard → 选择域名；
2. Email → Email Routing；
3. 点击 **Get started / Enable Email Routing**；
4. 允许 Cloudflare 添加所需的 MX 和 SPF TXT 记录；
5. 等待页面显示 Routing enabled、DNS records configured；
6. 进入 Routing rules；
7. 建议先配置一个测试地址，例如 `test@example.com`；
8. Action 选择 **Send to a Worker**；
9. Worker 选择本次部署的 `NAME`；
10. 测试成功后，再按需要启用 Catch-all，Action 同样选择该 Worker。

注意：

- 如果域名原来已有 Google Workspace、Microsoft 365、企业邮局等 MX，启用 Email Routing 会改变入站投递路径；迁移前先备份并确认不会中断原邮箱；
- `DOMAIN` 变量只允许应用创建这些域名下的地址，不会自动修改任何 MX 或 Routing Rule；
- 多域名必须逐个启用 Email Routing 并逐个把规则指向同一 Worker；
- Email Routing 的入站处理与 `CF_EMAIL` 出站 binding 是两件独立的事；
- DNS 生效后，从外部真实邮箱发送测试邮件，不能只靠站内自发自收验证。

官方参考：[Email Routing API 与 Catch-all](https://developers.cloudflare.com/api/resources/email_routing/)、[Email Routing DNS](https://developers.cloudflare.com/api/resources/email_routing/subresources/dns/)。

## 11. 创建管理员并完成应用设置

1. 打开 Cloud Mail 注册页；
2. 使用 `ADMIN` 中配置的完整邮箱地址注册；
3. 登录后进入系统设置；
4. 检查允许注册、允许收信、角色可用域名、发件次数等限制；
5. 创建一个测试邮箱账户；
6. 根据出站方案选择邮件引擎：Cloudflare、Resend、LONGOS/自建中继或自动；
7. 使用 LONGOS 时确认中继 URL 与 GitHub Variable 一致；
8. 不要把 `JWT_SECRET` 或 `RELAY_SHARED_SECRET` 填入网页设置。

管理员身份由 `ADMIN` 环境变量中的地址判定。更改 `ADMIN` 后，只有新地址会拥有平台管理员旁路权限；因此变更前先确保新地址已注册并能登录。

## 12. 上线验收

按顺序完成以下测试：

- 首页和 `/api/setting/websiteConfig` 可访问；
- GitHub Actions 的初始化步骤返回 `success`；
- 管理员可注册、登录并打开系统设置；
- 可创建 `DOMAIN` 下的邮箱账户；
- 从外部邮箱发到测试地址，Cloud Mail 中能看到邮件；
- 回复或新建邮件时，`From` 是当前选中的邮箱，而非统一平台地址；
- 配置 R2 时，小附件和大附件都能上传、接收和下载；
- LONGOS 模式下，`https://LONGOS域名/_longos/mail-relay/health` 返回 200，测试发信成功；
- Cloudflare 日志中没有持续的 D1、KV、R2 binding missing 错误；
- D1、KV 和 R2 的 ID/名称已记录到安全的运维台账。

## 13. 本地 Wrangler 手动部署

GitHub Actions 不可用时，可以在可信电脑上手动部署。要求 Node.js 22 或更高版本、pnpm 11 和可打开浏览器完成 Cloudflare 登录。

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
```

命令会提示输入 `jwt_secret`，粘贴至少 32 位 URL-safe 随机值。使用 LONGOS 时继续：

```bash
pnpm wrangler secret put RELAY_SHARED_SECRET -c wrangler-production.toml
```

Secret 写入会创建新的 Worker 版本。写入完成后调用初始化：

```bash
curl -fsS -X POST \
  -H "Authorization: Bearer 你的JWT_SECRET" \
  -H "Content-Type: application/json" \
  -d '{}' \
  https://mail.example.com/api/init
```

响应必须是纯文本 `success`。如果是 401，通常是 `jwt_secret` 未写入当前 Worker、密钥不一致或 Authorization 格式错误。

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
- GitHub Variables 名称和值；
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

工作流不会自动创建 R2。先在同一 Cloudflare 账户创建 Bucket，名称与 `R2_BUCKET_NAME` 完全一致；不用附件则删除该 Variable 后重跑。

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

`JWT_SECRET` 必须至少 32 位且只含字母、数字、下划线或连字符。确认 GitHub Secret、Worker 的 `jwt_secret` 和请求 Bearer 值一致，然后重跑部署。

### `/api/init` 返回 500

打开 Worker Logs，优先查 D1 binding、数据库 ID、迁移 SQL 和账户权限。不要反复改名创建多个空 D1；先确认当前 Worker 实际绑定哪个数据库。

### Worker 能收信但不能发信

收信和发信是两条链路：

- Cloudflare 引擎：确认 `CF_EMAIL=true` 且账户已取得出站能力；
- Resend：确认 API Token 与发件域验证；
- LONGOS：确认健康地址 200、`LONGOS_RELAY_URL` 正确、`RELAY_SHARED_SECRET` 一致、服务器出站 TCP 25/PTR/SPF/DKIM/DMARC 正常；
- 确认发件时选中的邮箱属于当前用户且域在角色允许列表中。

### GitHub Actions 成功但随后配置被覆盖

检查 Cloudflare Git Builds 是否仍开启，或是否有另一个仓库/工作流部署同名 Worker。生产 Worker 只能保留一个部署控制器。

## 17. 上线前最终清单

- [ ] 域名在正确 Cloudflare 账户中且状态 Active
- [ ] API Token 仅授权目标账户与 Zone
- [ ] GitHub Variables 与 Secrets 分类正确
- [ ] `DOMAIN` 是 JSON 数组，`ADMIN` 使用其中一个域
- [ ] D1 名称与 ID 匹配，KV ID 指向生产 Namespace
- [ ] 需要附件时 R2 Bucket 已提前创建
- [ ] Cloudflare Git Builds 已禁用
- [ ] CI 与生产部署工作流全部通过
- [ ] `POST /api/init` 返回 `success`
- [ ] 自定义域名页面和公开配置 API 正常
- [ ] 每个收件域都已启用 Email Routing 并指向正确 Worker
- [ ] 外部收信、出站发信和附件测试通过
- [ ] D1 备份、资源 ID 和回滚版本已记录
