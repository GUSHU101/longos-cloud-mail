# LONGOS Cloud Mail 从零部署与网站关联

这是正式环境的唯一推荐快速入口。无需手工创建 D1、KV、R2、JWT Secret 或 GitHub Actions Variables。若要求密钥只在部署时存在，请使用一次性本地向导；若要求 GitHub 审批与审计，请使用受保护的 `production` Environment。两种方式调用同一个部署器，结果一致。

## 1. 三部分各自负责什么

| 部分 | 负责 | 不负责 |
|---|---|---|
| Cloudflare Email Routing | 接收外部邮件并交给 Worker | 不负责 LONGOS 自建出站 SMTP |
| Cloud Mail Worker | 网页邮箱、账号、API、D1/KV/R2、通过 HTTPS 提交发件 | 不能直接连接公网 25 端口 |
| LONGOS 内置邮局 | Postfix/OpenDKIM、租户发件域授权、站外直投、下单与召回邮件 | 不保存 Cloud Mail 收件箱数据 |

推荐链路没有 Resend、SendGrid、Mailgun 等第三方发件商。Cloudflare 仍然是 Worker/收件基础设施提供方，但不代发出站邮件。

## 2. 部署前条件

- LONGOS 已通过 GitHub + Coolify Raw Docker Compose 正常运行；
- 主站 HTTPS 可访问；
- LONGOS 的 `mail-relay`、Postfix 和 OpenDKIM 容器健康；
- LONGOS 已填写邮件主机、发件域与服务器公网 IP；PTR/rDNS 已在服务器供应商处设置（其余发信 DNS 由工作流自动完成）；
- 收件域使用 Cloudflare 权威 DNS；
- Cloudflare 中目标 Zone 状态为 `Active`，`CUSTOM_DOMAIN` 没有冲突的 A、AAAA 或 CNAME；
- 首次使用 Workers 时已在 `Workers & Pages` 打开过一次产品页面；首次使用 R2 时已接受条款/开通结算，或者部署时关闭 R2；
- 服务器允许出站 TCP 25。若云厂商封锁 25 端口，自建直投无法工作，此限制不能由 Worker 绕过。

使用一次性本地向导还需要可信电脑已安装包含 npm 的 Node.js 22 或更高版本。无需另外安装 pnpm 或 Corepack：检测不到两者时，部署器会从 npm 官方注册表临时安装与 CI 一致的固定版本，禁用安装脚本、剥离部署凭据，并在进程结束时自动删除。使用 GitHub Actions 则不需要本机 Node.js。

## 3. 在 LONGOS 主站创建唯一令牌

1. 登录 LONGOS **主站控制后台**；
2. 打开 `系统 → 系统集成令牌`；
3. 点击“创建 Cloud Mail 令牌”；
4. 保存页面显示的：
   - 中继地址：`https://主站域名/_longos/mail-relay`
   - 令牌：`longos_it_` 加 64 个字符；
5. 点击健康检查，必须同时通过主站鉴权、私有中继、Postfix/OpenDKIM 和队列检查。

只创建这一次。它是平台级令牌，可服务全部活跃租户；不要在每个子站重复创建，也不要把令牌交给租户。

## 4. 创建 Cloudflare API Token

在 Cloudflare Dashboard：

1. 点击右上角头像 → `My Profile → API Tokens → Create Token → Create Custom Token`；
2. 给目标账户授予（Cloudflare 新界面显示 `Write`，旧界面可能显示 `Edit`）：
   - 首次创建 Worker：Workers 产品范围 `Admin`；后续只更新现有 Worker 可降为 `Editor`。旧权限界面对应 `Account / Workers Scripts / Edit`
   - `Account / Account Settings / Read`（自动识别单一 Account ID）
   - `Account / D1 / Write`（旧界面为 `Edit`）
   - `Account / Workers KV Storage / Write`（旧界面为 `Edit`）
   - 使用附件 R2 时：`Account / Workers R2 Storage / Write`（旧界面为 `Edit`）
   - 使用 Worker 自定义域时：目标 Zone 的 `Workers Routes / Write`（旧界面为 `Edit`）
   - `Zone / Zone / Read`（识别 `DOMAIN` 对应 Zone）
   - `Zone / DNS / Write`（旧界面为 `Edit`；发布 LONGOS 发信 A/AAAA、DKIM、SPF、DMARC）
   - `Zone / Zone Settings / Write`（旧界面为 `Edit`；自动启用 Email Routing）
   - `Zone / Email Routing Rules / Write`（旧界面为 `Edit`；自动配置 Catch-all 到 Worker）
3. Account Resources 只选择部署所用账户；Zone Resources 选择 `DOMAIN` 收件域以及 LONGOS `MAIL_RELAY_DOMAINS` 发件域所在 Zone（两者相同时只选一次）；
4. 创建后立即复制 Token。Cloudflare 只显示一次；不要复制 Global API Key，部署器会联网验证并拒绝它。

如果 Token 只能访问一个账户，部署器会自动识别 Account ID。只有 Token 可访问多个账户时，才需要在部署表单填写 `cloudflare_account_id`。

## 5. 选择部署入口

### 方式 A：一次性本地安全向导（推荐个人部署）

这是唯一做到“密钥只在本次部署进程存在”的方式：

```powershell
git clone https://github.com/GUSHU101/longos-cloud-mail.git
Set-Location longos-cloud-mail
node --version
node scripts/deploy-wizard.mjs
```

Node.js 必须为 22 或更高并包含 npm。无需先运行 `corepack enable` 或全局安装 pnpm；缺少 pnpm/Corepack 时，向导会自动准备固定版本。向导会依次询问 Worker 名称、访问域、收件域、管理员邮箱、LONGOS 网关、R2 和高级资源 ID，再以可见文本读取并二次确认管理员初始密码及所需 Token，方便本人部署时核对。确认页和后续日志只显示非敏感计划；执行时密码和 Token 只通过子进程环境传给统一部署器，不写入 `.cloud-mail.deploy.env`、GitHub、命令行参数、Worker Secret 或日志。请勿在共享终端、录屏或直播环境运行；关闭终端后不留下部署凭据。

若旧版本曾显示“找不到可安全执行的 pnpm 或 Corepack JavaScript 入口”，先运行 `git pull --ff-only origin main` 更新部署器，再重新执行向导。该错误发生在连接 Cloudflare 之前，因此不会创建资源，也不会消耗刚输入的 Token；重新运行时需再次输入凭据。

首次部署通常只需填写：

- `Cloud Mail 访问域名`：例如 `mail.example.com`，不要带 `https://`；
- `收件域`：例如 `example.com`；多个域用逗号分隔；
- `管理员邮箱`：例如 `admin@example.com`，域必须属于收件域；
- `管理员初始密码`：可见输入两次，必须为 12–30 个字符；首次部署会自动建号；
- `LONGOS 主站邮件网关`：完整填写 `https://主站/_longos/mail-relay`；
- R2 保持开启；向导会自动使用 `<Worker 名称>-attachments`。首次部署不要填写 D1/KV ID；已有生产资源迁移到本工具时才进入高级选项固定其 ID。

### 方式 B：GitHub Actions 网页部署（推荐团队审批）

GitHub 的 `workflow_dispatch` 没有 Secret 类型输入，因此密钥不能安全地出现在 **Run workflow** 表单。此方式必须：

1. 进入 `Settings → Environments → New environment` 创建 `production`；
2. Deployment branches 只允许默认分支 `main`（或选择 Protected branches）；
3. Required reviewers 选择仓库所有者；单人仓库不要启用“Prevent self-review”，否则无人能批准；
4. 添加 Environment Secrets：`ADMIN_PASSWORD`（12–30 个字符）、`CLOUDFLARE_API_TOKEN`、`LONGOS_INTEGRATION_TOKEN`；仅收信时可省略后者；
5. 普通配置只在本次 **Run workflow** 表单填写，不创建任何 Actions Variables；
6. `JWT_SECRET` 不填写，首次部署自动生成，升级自动保留。

Environment Secret 是持久存储，不是一次性输入。首次部署变绿后可以删除 `ADMIN_PASSWORD`，以后升级只验证已有管理员，不需要再次提供；若政策要求部署后不在 GitHub 保存任何部署密钥，请使用方式 A；不要把密钥伪装成 workflow 字符串输入。

### 方式 C：隐藏录入并触发 GitHub Actions

已安装 Node.js 22 和 [GitHub CLI](https://cli.github.com/) 时可运行：

```powershell
gh auth login
node scripts/trigger-github-deployment.mjs
```

它会隐藏输入并确认管理员初始密码和 Token，通过标准输入调用 `gh secret set --env production`，再用 JSON 触发工作流，密钥不会进入命令行参数或工作流输入。但它们仍会作为 Environment Secrets 保存在 GitHub，直到管理员轮换或删除；需要真正零持久化时仍应选择方式 A。

GitHub 部署会强制“仓库所有者 + 重跑人也是所有者 + 默认分支 + 手动运行”。外部 fork、PR 作者和普通协作者拿不到原仓库生产密钥。建议在 `Settings → Branches/Rules → main` 开启 PR、Code Owners 审核、`Secret-free verification` 必须通过和禁止 force push。

LONGOS 一体化模式不要设置 `RESEND_WEBHOOK_SECRET` 或 `RELAY_SHARED_SECRET`，并保持 `cloudflare_email=false`。这些属于第三方/旧版兼容模式。

## 6. 一键部署 Worker

使用方式 A 时，向导会直接运行下述全部阶段。使用方式 C 时，向导已经触发 GitHub Actions。使用方式 B 时：

1. 打开 GitHub 仓库的 `Actions`；
2. 左侧选择 `Deploy cloud-mail to Cloudflare Workers`；
3. 点击 `Run workflow`，分支保持默认分支；
4. 在表单填写收件域、管理员邮箱、访问域和 LONGOS 网关；D1/KV ID 留空，R2 保持 `auto`，部署器会直接创建缺失资源；
5. 保持“自动配置 Email Routing”开启，LONGOS 模式保持“Cloudflare Email 出站”关闭；
6. 点击绿色 `Run workflow`，等待 `Validate, test and deploy` 全部变绿。

工作流会自动测试、构建，按名称查找 D1/KV/R2，缺失时直接创建并等待 Cloudflare 控制面可读，存在时安全复用；随后校验 LONGOS 网关、创建或更新 Worker、初始化/升级 D1，并在受一次性 `INIT_SECRET` 保护的初始化请求内创建缺失的管理员账户。它会继续验收公开接口、撤销一次性初始化权限，并为每个 `DOMAIN` 启用 Email Routing、把 Catch-all 指向当前 Worker。管理员密码经 HTTPS 发送后只保存 PBKDF2 哈希；不会写入 Worker Secret。重复部署若管理员已存在会保留原密码，不会被 Environment 中的初始值重置。最后部署器从 LONGOS 读取只包含公开 DKIM/SPF/DMARC/A/AAAA 值的清单，并由 GitHub Runner 直接调用 Cloudflare 完成写入；Cloudflare Token 不会发送到 LONGOS。GitHub 摘要会列出 Worker 创建/更新状态、D1/KV ID 和 R2 桶名。重复运行是幂等升级，不会清空已有邮件。

失败时查看日志中第一条 `[失败]`，不要只看最后的退出码。修复权限、DNS 或网关后直接使用完全相同的名称与资源 ID 重跑：部署器会复用 D1/KV/R2，不会清空已有邮件。Worker 资源即使已经发布，只要收发信验收未完成，流程也不会显示为成功。

## 7. 验收自动收信配置

部署日志出现以下内容时，不需要再手工配置 Cloudflare：

```text
✓ example.com → cloud-mail
Email Routing 与 Catch-all 已自动配置
```

然后直接从 Gmail/Outlook 发信到 `任意前缀@你的域名` 做收件测试。

旧 Token 缺少权限时，已经发布的 Worker 不会回滚，但最终验收会保持红色并列出需要补充的域名和权限。给 Token 增加 `Zone:Read`、`DNS:Write`、`Zone Settings:Write`、`Email Routing Rules:Write`（旧界面名称为 `Edit`）后重跑即可自动补齐；也可以仅对日志列出的域，在 Cloudflare 的 `Email → Email Routing → Routing rules` 手工把 Catch-all 指向本次 Worker。

Email Routing 的 MX 用于**收信**，LONGOS 的 DKIM/DMARC/PTR 用于 Postfix **发信**。根域 SPF 必须只有一条；部署工作流会先配置收信再调用 LONGOS，保留 Cloudflare 的 `include:_spf.mx.cloudflare.net` 和其他发信来源，加入 `mailout` 后自动合并。只有 PTR/rDNS 与出站 TCP 25 仍必须在服务器供应商处处理。

## 8. 首次登录与发信测试

1. 访问 `https://CUSTOM_DOMAIN`；
2. 直接用部署时填写的 `ADMIN` 邮箱和管理员初始密码登录，无需再注册；
3. 在系统设置中确认邮件引擎显示“LONGOS 内置邮件服务器”；该选项会由集成令牌锁定；
4. 打开中继设置并运行“测试连接”；
5. 创建一个属于已授权发件域的邮箱账户；
6. 向 Gmail/Outlook 发送测试邮件，检查 From、DKIM、SPF 和 DMARC。

一体化模式不会“自动回退到 Resend”。如果 LONGOS 邮局异常，发件会明确失败并记录原因，避免邮件内容在不知情时交给第三方。

## 9. 验收网站业务邮件

Cloud Mail 网页发信和 LONGOS 业务邮件共用邮局，但入口不同，必须分别测试：

1. LONGOS 主站后台确认发件域已签名并唯一分配给相应租户；
2. 租户后台选择默认、订单、账户、售后和营销发件地址；
3. 发送后台测试邮件；
4. 创建真实测试订单，检查客户订单邮件与管理员提醒；
5. 触发一次不带折扣、一次带折扣的弃单召回；
6. 邮件日志中的传输方式应为 `self_hosted`；
7. 检查收件方原始邮件的 SPF、DKIM、DMARC 均为 PASS。

租户可使用不同发件域，前提是该域已经由邮局签名，并由 LONGOS 主站唯一分配给该租户。店铺访问域和邮件发件域彼此独立。

## 10. 常见问题

| 现象 | 原因与处理 |
|---|---|
| Actions 中没有 `Run workflow` | 确认工作流文件已在仓库默认分支、Actions 已启用，并从工作流详情页而非单次运行页操作 |
| GitHub Job 立即显示 Skipped | 生产工作流只允许仓库所有者、默认分支和手动触发；请由所有者重新运行，不要使用协作者账号或临时分支 |
| 一直显示 Waiting | `production` Environment 正在等待审批；单人仓库若开启 Prevent self-review 会无人可批准 |
| `Authentication error [10000]` | Token 无效、过期、账户/Zone 资源范围错误，或误用了 Global API Key；重新创建最小权限 API Token |
| 首次创建 Worker 被拒绝 | 新权限模型首次创建需要 Workers 产品范围 Admin；Worker 建成后可把 Token 降为 Editor |
| R2 创建失败 | 先在 Cloudflare R2 页面接受条款/开通结算；桶名只能含小写字母、数字、连字符且为 3–63 位；不用附件可关闭 R2 |
| D1/KV 创建后暂时查不到 | 新版会自动等待控制面同步；若等待后仍失败，不要删除已创建资源，直接用相同名称重跑 |
| 预检找不到活动 Zone | 域名尚未 Active、位于另一个账户，或 Token 没有 Zone:Read/未包含该 Zone |
| 自定义域 1014/1016 或证书超时 | 删除同名冲突 A/AAAA/CNAME，确认 Custom Domain Zone 与 Worker 在同一账户，然后用相同输入重跑 |
| Email Routing 为 `misconfigured` | 检查根域是否残留其他 MX、是否存在多条 SPF；不要同时让其他邮箱服务和 Cloudflare 接管同一域收信 |
| 失败后已经出现 D1/KV/Worker | 属于可续跑状态，不要删除资源；用相同名称和已有 ID 重跑，部署器会幂等复用 |
| 自检报告 `LONGOS_RELAY_URL 与 LONGOS_INTEGRATION_TOKEN 必须同时填写` | 旧版把 URL 传给无密钥测试、却正确移除了令牌，造成误报；执行 `git pull --ff-only origin main` 后重新运行向导 |
| 提示管理员初始密码缺失 | 新 D1 中还没有 `ADMIN` 用户；本地运行 `deploy-wizard.mjs` 可见输入，或在 `production` Environment 添加 `ADMIN_PASSWORD` 后重跑 |
| 重跑后管理员密码没有变化 | 这是防误锁设计；部署密码只创建缺失账号，不覆盖已有账号。登录后在个人设置中修改密码 |
| 日志曾出现 INIT_SECRET HTTP 200 | Cloudflare 边缘旧版本短暂传播；以 Secret 清单删除为准。新版只警告并继续，不再把成功撤销误判为部署失败 |
| Worker 能收信但不能发信 | 检查 LONGOS 令牌、主站网关健康、服务器 TCP 25 和发件域授权 |
| 403 发件域未授权 | 邮局未签名该域，或主站未把该域唯一分配给当前租户 |
| GitHub 提示 Account ID | Token 可访问多个账户；重跑时在表单的 `Cloudflare Account ID` 字段填写 32 位 ID |
| 自定义域打不开 | 检查 Worker Custom Domain、DNS Zone 与 Token 的 Workers Routes 权限 |
| 邮件进垃圾箱 | 校验 PTR/EHLO A/SPF/DKIM/DMARC，一致后对新 IP 逐步升温 |
| 云服务器封锁 25 | 向云厂商申请解封或更换允许直投的服务器；Worker 无法绕过 |
| 想使用 Resend | 这是独立兼容模式，不是 LONGOS 推荐路径；移除 LONGOS 集成后按详细参考文档配置 |

更深入的资源迁移、备份、回滚与故障处理见 [Cloudflare Workers 参考手册](./CLOUDFLARE_WORKERS_DEPLOYMENT.md)；Postfix、OpenDKIM、PTR 与租户发件域见 [LONGOS 自建邮局参考手册](./LONGOS_SELF_HOSTED_DEPLOYMENT.md)。
