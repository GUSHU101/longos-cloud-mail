# LONGOS Cloud Mail 从零部署与网站关联

这是正式环境的唯一推荐快速入口。正常部署全程通过 GitHub 和 Cloudflare 网页完成，不需要在本地执行命令，也不需要手工创建 D1、KV、R2 或 JWT Secret。

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
- 发件域已完成 SPF、DKIM、DMARC，服务器公网 IP 已配置 PTR/rDNS；
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
3. Account Resources 只选择部署所用账户；Zone Resources 只选择收件域所在 Zone；
4. 创建后立即复制 Token。Cloudflare 只显示一次。

如果 Token 只能访问一个账户，部署器会自动识别 Account ID。只有 Token 可访问多个账户时，才需要额外填写 `CLOUDFLARE_ACCOUNT_ID`。

## 5. 在 GitHub 保存部署配置

进入本仓库：`Settings → Secrets and variables → Actions`。

### Secrets（敏感，必须）

| Name | Value |
|---|---|
| `CLOUDFLARE_API_TOKEN` | 第 4 步创建的 Cloudflare Token |
| `LONGOS_INTEGRATION_TOKEN` | 第 3 步复制的 `longos_it_...` |

不要把这两个值放进 Variables、README、Issue 或截图。

### Variables（非敏感，必须）

| Name | 示例 | 说明 |
|---|---|---|
| `DOMAIN` | `example.com` | 收件域；多个使用 `example.com,example.net` |
| `ADMIN` | `admin@example.com` | Cloud Mail 管理员地址，域名必须属于 `DOMAIN` |
| `CUSTOM_DOMAIN` | `mail.example.com` | Cloud Mail 网页访问域名 |
| `LONGOS_RELAY_URL` | `https://shop.example.com/_longos/mail-relay` | 必须是 LONGOS 主站，不是租户子站 |

### Variables（可选）

| Name | 默认值/用途 |
|---|---|
| `NAME` | `cloud-mail` |
| `D1_DATABASE_NAME` | 与 `NAME` 相同 |
| `R2_BUCKET_NAME` | 留空不启用 R2；填写如 `cloud-mail-attachments` 启用附件对象存储 |
| `CLOUDFLARE_ACCOUNT_ID` | 单账户 Token 自动识别；多账户时填写 |
| `CORS_ORIGINS` | 默认 `[]`，只有确实存在跨域前端时才配置 |

不要创建 `JWT_SECRET`：首次部署会安全随机生成，升级时会保留线上 Secret。只有主动注销全部会话时才手工设置它进行轮换。

不要设置 `CF_EMAIL`、`RESEND_WEBHOOK_SECRET` 或 `RELAY_SHARED_SECRET`。它们属于第三方/旧版兼容模式，LONGOS 一体化自建发信不需要。

## 6. 一键部署 Worker

1. 打开 GitHub 仓库的 `Actions`；
2. 左侧选择 `Deploy cloud-mail to Cloudflare Workers`；
3. 点击 `Run workflow`；
4. 若第 5 步已保存 Variables，表单可保持空白；也可以在表单临时覆盖 Worker 名称、访问域、收件域、管理员邮箱和 LONGOS 网关；
5. 等待 `Validate, test and deploy` 全部变绿。

工作流会自动测试、构建、创建或复用资源、校验 LONGOS 网关、部署 Worker、初始化/升级 D1、验收公开接口并撤销一次性初始化权限。重复运行是升级，不会清空已有邮件。

失败时直接展开红色步骤。日志会指出缺少的变量、Cloudflare 权限、主站网关状态或自定义域证书等待情况，无需猜测。

## 7. 在 Cloudflare 打开收信

对 `DOMAIN` 中的每个域名分别执行：

1. Cloudflare Dashboard → 选择域名 → `Email → Email Routing`；
2. 点击启用并确认 Cloudflare 提供的 MX/TXT DNS 记录；
3. 打开 `Routing rules`；
4. 编辑 `Catch-all address`，Action 选择 `Send to a Worker`；
5. 选择刚部署的 `cloud-mail` Worker 并保存；
6. 从 Gmail/Outlook 发信到 `任意前缀@你的域名` 做收件测试。

Email Routing 的 MX 用于**收信**。SPF/DKIM/DMARC/PTR 用于 LONGOS Postfix **发信**，两套 DNS 记录同时存在并不冲突。

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
| GitHub 提示 Account ID | Token 可访问多个账户；新增 Variable `CLOUDFLARE_ACCOUNT_ID` |
| 自定义域打不开 | 检查 Worker Custom Domain、DNS Zone 与 Token 的 Workers Routes 权限 |
| 邮件进垃圾箱 | 校验 PTR/EHLO A/SPF/DKIM/DMARC，一致后对新 IP 逐步升温 |
| 云服务器封锁 25 | 向云厂商申请解封或更换允许直投的服务器；Worker 无法绕过 |
| 想使用 Resend | 这是独立兼容模式，不是 LONGOS 推荐路径；移除 LONGOS 集成后按详细参考文档配置 |

更深入的资源迁移、备份、回滚与故障处理见 [Cloudflare Workers 参考手册](./CLOUDFLARE_WORKERS_DEPLOYMENT.md)；Postfix、OpenDKIM、PTR 与租户发件域见 [LONGOS 自建邮局参考手册](./LONGOS_SELF_HOSTED_DEPLOYMENT.md)。
