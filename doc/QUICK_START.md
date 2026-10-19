# Cloud Mail + LONGOS 最短部署流程

这份文档只保留首次上线必须完成的步骤。需要权限明细、备份、迁移和故障处理时，再阅读[完整 Cloudflare 手册](./CLOUDFLARE_WORKERS_DEPLOYMENT.md)与[LONGOS 自建邮局手册](./LONGOS_SELF_HOSTED_DEPLOYMENT.md)。

## 先理解一件事

LONGOS 下单通知、订单状态通知和弃单召回邮件，与 Cloud Mail 网页发信是**两条经过不同鉴权的入口，但共用同一个 Postfix/OpenDKIM 邮局**：

```text
LONGOS 下单/召回 ── 内网 HMAC ─────────┐
                                      ├─> LONGOS 自建中继 ─> Postfix/OpenDKIM ─> 收件方 MX
Cloud Mail 网页 ─ Bearer 集成令牌 ──> 主站网关 ┘
```

- 网站业务邮件不需要先进入 Cloud Mail 网页或 D1；
- Cloud Mail Worker 不能取得网站内部 HMAC 密钥；
- Worker 只持有一枚可撤销的 LONGOS 系统集成令牌；
- 一个主站令牌可服务所有活跃租户，租户不需要重复部署 Worker；
- LONGOS 必须已经按其 `docs/CONFIGURATION.md` 使用 GitHub + Coolify Raw Docker Compose 部署；该栈会自动启动邮件中继，不需要另装服务器组件或执行容器命令。

## 第一步：确认 LONGOS 邮局已经工作

1. 在 LONGOS 主站后台打开“系统集成令牌”；
2. 创建一枚 **Cloud Mail** 令牌；
3. 复制页面显示的两项内容：
   - 中继地址：`https://主站域名/_longos/mail-relay`
   - 令牌：`longos_it_...`
4. 不要把令牌发给租户，也不要填写到 Cloud Mail 网页表单中；部署工具会把它写入 Worker Secret；
5. 如果后台健康检查不是绿色，先修复 LONGOS 的 `mail-relay`、Postfix、OpenDKIM、发件域和 DNS，Cloud Mail 部署不会掩盖这个问题。

## 第二步：准备 Cloudflare

只需人工准备两项：

1. Cloudflare Account ID；
2. 一个 API Token，至少包含 Workers Scripts、D1、KV、R2 与 Workers Routes 的编辑权限，并只授权本次使用的账户和 Zone。

D1、KV 和 R2 不需要预先手动创建；下面的部署工具会按名称查找，存在则复用，不存在才创建。

## 第三步：一条命令部署

电脑安装 Node.js 22 或更高版本，然后在仓库根目录执行：

```bash
cp .cloud-mail.deploy.env.example .cloud-mail.deploy.env
```

Windows PowerShell 使用：

```powershell
Copy-Item .cloud-mail.deploy.env.example .cloud-mail.deploy.env
```

编辑 `.cloud-mail.deploy.env`，至少填写：

- `CLOUDFLARE_ACCOUNT_ID`
- `CLOUDFLARE_API_TOKEN`
- `CUSTOM_DOMAIN`，例如 `mail.example.com`
- `DOMAIN`，例如 `["example.com"]`
- `ADMIN`，例如 `admin@example.com`
- `JWT_SECRET`，首次生成后升级时保持不变
- `LONGOS_RELAY_URL`
- `LONGOS_INTEGRATION_TOKEN`

然后运行：

```bash
node scripts/deploy-cloudflare.mjs
```

只想先检查配置、不连接 Cloudflare 或修改线上资源时，可运行：

```bash
node scripts/deploy-cloudflare.mjs --validate-only
```

该命令自动完成：

1. 按锁文件安装 Worker 与 Vue 依赖；
2. 执行单元测试和正式前端构建；
3. 创建或复用 D1、KV、R2；
4. 验证 LONGOS 集成令牌和私有邮局健康状态；
5. 生成不会提交到 Git 的生产 Wrangler 配置；
6. 在同一次 Worker 发布中写入 JWT、一次性初始化密钥和 LONGOS 令牌；
7. 等待自定义域证书生效；
8. 初始化或升级 D1、验证公开配置接口，并立即撤销一次性初始化密钥和已停用的旧 Secret。

以后升级仍运行同一条命令。它不会创建第二套同名数据库，也不会清空邮件数据。

## 第四步：启用收信

Cloudflare Dashboard 中对 `DOMAIN` 的每个域名执行一次：

1. 打开 **Email Routing**；
2. 按提示发布 Cloudflare 给出的 MX/TXT 记录；
3. 在 Routing Rules 中把 Catch-all 目标设为刚部署的 Worker；
4. 从 Gmail、Outlook 等外部邮箱发一封测试邮件。

Email Routing 只负责“收信”。LONGOS 自建 Postfix 负责“发信”，两者不要混为一项设置。

## 第五步：创建管理员和发件账户

1. 打开 `https://CUSTOM_DOMAIN`；
2. 使用 `.cloud-mail.deploy.env` 的 `ADMIN` 地址注册并登录；
3. 在 Cloud Mail 中创建实际要使用的发件账户；
4. 系统设置的邮件引擎选“自动”或“LONGOS 自建邮件服务器”；
5. 点击中继健康检查，必须显示系统集成令牌模式且状态正常；
6. 发一封站外测试邮件，确认 From 是当前选中账户。

## 第六步：验收 LONGOS 下单与召回邮件

这些测试必须在对应租户后台完成，不能只测试 Cloud Mail 网页发信：

1. 在 LONGOS“邮件设置”选择“自建邮件引擎”；
2. 确认默认、订单、账户、售后、营销发件地址均来自“邮局已签名 + 主站已分配”的域名；
3. 点击后台测试邮件并检查“邮件日志”；
4. 创建一笔真实测试订单，确认客户下单邮件和管理员订单提醒均到达；
5. 将测试订单保持未付款并满足召回时间条件；
6. 在“邮件召回订单”预览后发送一次不带折扣的邮件；
7. 再用另一笔订单发送带折扣码的召回邮件，验证链接、购物车恢复与折扣应用；
8. 邮件日志应显示 `order_new` 或 `abandoned_order_recovery`，传输方式为 `self_hosted`；
9. 若第一次提交超时，不要更换投递 ID。新版中继会用持久化幂等日志防止重复下单或召回邮件。

## 失败时先看哪里

| 现象 | 先检查 |
|---|---|
| 部署工具在 LONGOS 健康检查处停止 | 主站令牌是否有效、URL 是否为主站 `/_longos/mail-relay`、Docker 邮局是否健康 |
| 403 发件域未授权 | 邮局是否签名该域、主站是否把该发件域唯一分配给当前租户、共享平台域地址是否含 `+site-code` |
| 下单邮件没有产生 | LONGOS 邮件设置是否启用订单通知、队列 Worker 是否运行、邮件日志是否有失败记录 |
| 召回页面显示成功但未收到 | 查看召回记录、邮件日志和中继队列；不要只看 Cloud Mail 收件箱 |
| Worker 能收信不能发信 | Cloud Mail 是否选中了有权限的发件账户，LONGOS 网关健康检查是否为 200 |
| 邮件进入垃圾箱 | PTR、EHLO A 记录、SPF、DKIM、DMARC 是否一致；新 IP 是否需要逐步升温 |
