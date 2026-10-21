# LONGOS Cloud Mail 从零部署与网站关联

这是正式环境的唯一推荐快速入口。无需手工创建 D1、KV、R2、JWT Secret 或 GitHub Actions Variables。普通配置在每次部署的表单中填写；密钥通过受保护的 Environment 或安全部署向导提交。

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
- 服务器允许出站 TCP 25。若云厂商封锁 25 端口，自建直投无法工作，此限制不能由 Worker 绕过。

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
2. 给目标账户授予：
   - `Account / Workers Scripts / Edit`
   - `Account / Account Settings / Read`（自动识别单一 Account ID）
   - `Account / D1 / Edit`
   - `Account / Workers KV Storage / Edit`
   - 使用附件 R2 时：`Account / Workers R2 Storage / Edit`
   - 使用 Worker 自定义域时：目标 Zone 的 `Workers Routes / Edit`
   - `Zone / Zone / Read`（识别 `DOMAIN` 对应 Zone）
   - `Zone / DNS / Edit`（发布 LONGOS 发信 A/AAAA、DKIM、SPF、DMARC）
   - `Zone / Zone Settings / Edit`（自动启用 Email Routing）
   - `Zone / Email Routing Rules / Edit`（自动配置 Catch-all 到 Worker）
3. Account Resources 只选择部署所用账户；Zone Resources 选择 `DOMAIN` 收件域以及 LONGOS `MAIL_RELAY_DOMAINS` 发件域所在 Zone（两者相同时只选一次）；
4. 创建后立即复制 Token。Cloudflare 只显示一次；不要复制 Global API Key，部署器会联网验证并拒绝它。

如果 Token 只能访问一个账户，部署器会自动识别 Account ID。只有 Token 可访问多个账户时，才需要在部署表单填写 `cloudflare_account_id`。

## 5. 部署时填写配置，不再预建 Variables

GitHub 的 `workflow_dispatch` 只提供字符串、布尔值、选项和 Environment 输入，没有会隐藏内容的 Secret 输入。因此本项目明确分开处理：

- Worker 名称、域名、Account ID、D1/KV/R2、CORS、AI 和路由开关全部在本次 **Run workflow** 表单中填写，不读取任何 `vars.*`；
- `CLOUDFLARE_API_TOKEN` 与 `LONGOS_INTEGRATION_TOKEN` 绝不放进表单，否则值会成为工作流事件数据；它们只通过 `production` Environment 进入最终部署步骤；
- `JWT_SECRET` 不要求填写，首次部署自动生成，升级自动保留。

### 方式 A：全网页部署

1. 进入 `Settings → Environments → New environment` 创建 `production`；
2. Deployment branches 只允许默认分支 `main`（或选择 Protected branches）；
3. Required reviewers 选择仓库所有者；单人仓库不要启用“Prevent self-review”，否则无人能批准；
4. 在本次部署前把 `CLOUDFLARE_API_TOKEN` 和 `LONGOS_INTEGRATION_TOKEN` 保存为该 Environment 的 Secrets；仅收信时可不填后者；
5. 不要创建任何 Actions Variables，也不要把密钥放进 Repository Secrets、README、Issue 或截图。

### 方式 B：部署时隐藏输入密钥并自动触发（更省步骤）

电脑已安装 Node.js 22 和 [GitHub CLI](https://cli.github.com/) 时，在仓库根目录运行：

```powershell
gh auth login
node scripts/trigger-github-deployment.mjs
```

向导会读取目标仓库和默认分支，只先询问域名、管理员、LONGOS 网关和是否启用 R2；已有资源 ID、CORS、AI 等收在一个可选的“高级配置”分支中。密钥输入不回显；随后它通过标准输入调用 `gh secret set --env production`，由 GitHub CLI 在本机加密后上传，并用 JSON 触发工作流。密钥不会进入命令行参数、工作流输入、仓库文件或日志。`production` 不存在时向导会创建它；首次运行后仍建议在网页中加上默认分支限制和所有者审批。

部署工作流还会在代码层强制“仓库所有者 + 重跑人也是所有者 + 默认分支 + 手动运行”。外部 fork、PR 作者和普通协作者无法调用原仓库的生产部署，也不能重跑所有者过去的部署。安装依赖、漏洞审计、测试与前端构建先在独立无密钥步骤完成；生产 Secret 只注入最终部署步骤。

再到 `Settings → Branches/Rules → main` 开启 Require a pull request、Require review from Code Owners、Require status checks（选择 `Secret-free verification`）、禁止 force push；仓库已经通过 `.github/CODEOWNERS` 把所有生产代码变更绑定给 `@GUSHU101` 审核。

不要设置 `CF_EMAIL`、`RESEND_WEBHOOK_SECRET` 或 `RELAY_SHARED_SECRET`。它们属于第三方/旧版兼容模式，LONGOS 一体化自建发信不需要。

## 6. 一键部署 Worker

使用方式 B 时，向导完成后已经触发部署，无需再操作网页。使用方式 A 时：

1. 打开 GitHub 仓库的 `Actions`；
2. 左侧选择 `Deploy cloud-mail to Cloudflare Workers`；
3. 点击 `Run workflow`，分支保持默认分支；
4. 在表单填写收件域、管理员邮箱、访问域和 LONGOS 网关；其余资源字段可接受默认值或留空自动创建；
5. 保持“自动配置 Email Routing”开启，LONGOS 模式保持“Cloudflare Email 出站”关闭；
6. 点击绿色 `Run workflow`，等待 `Validate, test and deploy` 全部变绿。

工作流会自动测试、构建、创建或复用资源、校验 LONGOS 网关、部署 Worker、初始化/升级 D1、验收公开接口、撤销一次性初始化权限，并为每个 `DOMAIN` 启用 Email Routing、把 Catch-all 指向当前 Worker。随后它从 LONGOS 读取只包含公开 DKIM/SPF/DMARC/A/AAAA 值的清单，并由 GitHub Runner 直接调用 Cloudflare 完成写入；Cloudflare Token 不会发送到 LONGOS。重复运行是幂等升级，不会清空已有邮件。

失败时直接展开红色步骤。日志会指出缺少的变量、Cloudflare 权限、主站网关、发信 DNS、Email Routing 最终状态或自定义域证书等待情况，无需猜测。Worker 资源即使已经发布，只要收发信验收未完成，工作流也不会显示为绿色。

## 7. 验收自动收信配置

部署日志出现以下内容时，不需要再手工配置 Cloudflare：

```text
✓ example.com → cloud-mail
Email Routing 与 Catch-all 已自动配置
```

然后直接从 Gmail/Outlook 发信到 `任意前缀@你的域名` 做收件测试。

旧 Token 缺少权限时，已经发布的 Worker 不会回滚，但最终验收会保持红色并列出需要补充的域名和权限。给 Token 增加 `Zone:Read`、`DNS:Edit`、`Zone Settings:Edit`、`Email Routing Rules:Edit` 后重跑工作流即可自动补齐；也可以仅对日志列出的域，在 Cloudflare 的 `Email → Email Routing → Routing rules` 手工把 Catch-all 指向本次 Worker。

Email Routing 的 MX 用于**收信**，LONGOS 的 DKIM/DMARC/PTR 用于 Postfix **发信**。根域 SPF 必须只有一条；部署工作流会先配置收信再调用 LONGOS，保留 Cloudflare 的 `include:_spf.mx.cloudflare.net` 和其他发信来源，加入 `mailout` 后自动合并。只有 PTR/rDNS 与出站 TCP 25 仍必须在服务器供应商处处理。

## 8. 首次登录与发信测试

1. 访问 `https://CUSTOM_DOMAIN`；
2. 用 `ADMIN` 邮箱注册并登录；
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
| Worker 能收信但不能发信 | 检查 LONGOS 令牌、主站网关健康、服务器 TCP 25 和发件域授权 |
| 403 发件域未授权 | 邮局未签名该域，或主站未把该域唯一分配给当前租户 |
| GitHub 提示 Account ID | Token 可访问多个账户；重跑时在表单的 `Cloudflare Account ID` 字段填写 32 位 ID |
| 自定义域打不开 | 检查 Worker Custom Domain、DNS Zone 与 Token 的 Workers Routes 权限 |
| 邮件进垃圾箱 | 校验 PTR/EHLO A/SPF/DKIM/DMARC，一致后对新 IP 逐步升温 |
| 云服务器封锁 25 | 向云厂商申请解封或更换允许直投的服务器；Worker 无法绕过 |
| 想使用 Resend | 这是独立兼容模式，不是 LONGOS 推荐路径；移除 LONGOS 集成后按详细参考文档配置 |

更深入的资源迁移、备份、回滚与故障处理见 [Cloudflare Workers 参考手册](./CLOUDFLARE_WORKERS_DEPLOYMENT.md)；Postfix、OpenDKIM、PTR 与租户发件域见 [LONGOS 自建邮局参考手册](./LONGOS_SELF_HOSTED_DEPLOYMENT.md)。
