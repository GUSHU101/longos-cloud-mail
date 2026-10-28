<p align="center">
  <img src="doc/demo/logo.png" width="80" alt="LONGOS Cloud Mail">
</p>
<h1 align="center">LONGOS Cloud Mail</h1>
<p align="center">Cloudflare 收件与管理界面 + LONGOS 自建 Postfix/OpenDKIM 发件</p>

## 先说清楚：是否依赖第三方发件商？

推荐部署**不依赖 Resend、SendGrid、Mailgun 或 Cloudflare Email Service 发件**。

```text
外部来信 ──> Cloudflare Email Routing ──> Cloud Mail Worker/D1/R2

Cloud Mail 网页发信 ── HTTPS 集成令牌 ──┐
                                        ├─> LONGOS 内置 Postfix/OpenDKIM ── SMTP ──> 收件方 MX
LONGOS 下单/召回邮件 ── 内网 HMAC ──────┘
```

Cloudflare Worker 不能直接连接公网 TCP 25，因此不能替代 SMTP 邮件服务器。Cloudflare 在这里负责 Worker 运行、收件路由和数据存储；真正的站外发件由 LONGOS 服务器内置的 Postfix/OpenDKIM 完成。Cloudflare Email Sending 与 Resend 仅保留为独立部署的可选兼容能力，一体化部署会锁定为 LONGOS 内置引擎，不会静默回退到第三方。

如果网站服务器没有可控 PTR/rDNS 或出站 TCP 25，可让完整 LONGOS 与 Cloud Mail 继续留在主服务器/Cloudflare，只在第二台服务器运行本仓库 `mail-relay/` 子目录的专用邮件出口组件。仓库提供专门的 Coolify Compose，把 mail-relay 与 Cloudflare Tunnel 放在同一资源中，只监听 `127.0.0.1:8788`，不占用 80/443，可与 3X-UI 共存；它不会在第二台服务器安装 Cloud Mail UI、Worker、数据库或 LONGOS。完整步骤见[第二台服务器专用邮件出口节点](./doc/REMOTE_MAIL_NODE.md)。

## 最推荐的部署方式

不需要手工创建 D1、KV、R2、JWT 密钥或 GitHub Actions Variables。

只想在部署时输入密钥、部署后不在 GitHub 或仓库中保存它们，推荐在可信电脑运行：

```powershell
git clone https://github.com/GUSHU101/longos-cloud-mail.git
Set-Location longos-cloud-mail
node scripts/deploy-wizard.mjs
```

向导会以可见文本读取并确认管理员初始密码、Cloudflare 与 LONGOS 密钥，方便部署者直接核对；部署计划和后续日志仍不显示密钥。随后会完成依赖验证、D1/KV/R2、Worker、管理员建号、Email Routing、Catch-all 与发信 DNS 验收。密码和 Token 只进入本次子进程环境，不写 `.env`、GitHub、命令行参数、Worker Secret 或日志；重复部署不会重置已有管理员密码。若网络等临时故障导致退出，向导可保留内存中的全部输入立即重试，无需再次填写。请只在本人可见且不录屏、不共享的终端中运行。

需要团队审批、审计记录和集中发布时，再使用 `Actions → Deploy cloud-mail to Cloudflare Workers`。GitHub 手动工作流没有密文输入控件，所以该方式必须把密钥保存到受保护的 `production` Environment；`node scripts/trigger-github-deployment.mjs` 只是隐藏录入并触发工作流，不能把 GitHub Environment 变成一次性密钥存储。

两种方式都会自动启用 Email Routing、把 Catch-all 指向 Worker，并读取 LONGOS 的公开 DNS 清单后直接发布 DKIM/DMARC、合并 SPF 与校准 DNS-only 邮件主机；LONGOS 会在 `MAIL_RELAY_IPS` 留空时以多源一致性安全识别服务器公网出口。Cloudflare Token 永远不会发送给 LONGOS，也无需保存到 Coolify。

完整的逐项页面路径、API Token 权限、变量表、Cloudflare Email Routing、网站关联和验收方法都集中在：

**[从零部署与关联 LONGOS（推荐，只读这一份即可）](./doc/QUICK_START.md)**

部署器会自动：

- 识别单一 Cloudflare Account；
- 为 `DOMAIN` 中的每个域自动启用 Email Routing，并幂等配置 Catch-all 到当前 Worker；
- 在 LONGOS 已配置时读取其公开 DNS 清单，由受保护的部署 Runner 直接完成出站邮件 DNS；Cloudflare Token 不会发送给 LONGOS；
- 一次性检查 Worker、D1、KV、可选 R2 及全部 Zone 权限，再创建或复用 D1、KV 和可选 R2；多个 Zone 的缺失权限会在一次运行中完整列出；R2 只有在官方精确查询明确返回不存在时才创建，权限、网络或 Cloudflare API 故障不会被误判为缺少资源；本地向导在准备依赖前检查，GitHub 则在无密钥验证完成后的生产部署步骤检查；
- 首次不填任何资源 ID：按名称自动创建 D1/KV，`R2=auto` 自动创建附件桶；升级安全复用并在摘要中显示实际 ID；
- 自动生成并在升级时保留 JWT Secret；
- 首次自动创建管理员与主邮箱，升级时保留已有密码；
- 测试 Worker、构建前端并校验 LONGOS 邮件网关；
- 原子发布 Worker Secret；
- 初始化/升级数据库，验收接口并撤销一次性初始化密钥。

## 与 LONGOS 网站如何关联

只在 LONGOS **主站控制后台**创建一次 Cloud Mail 令牌。部署时保存：

```text
LONGOS_RELAY_URL=https://主站域名/_longos/mail-relay
LONGOS_INTEGRATION_TOKEN=longos_it_...
```

这枚平台级令牌可服务全部活跃租户。租户不需要分别部署 Worker，也不接触服务器内部 HMAC 密钥。租户可以使用各自已经在邮局签名、并由主站唯一分配的发件域；店铺访问域更换不会自动改变发件域。

LONGOS 的下单、订单状态、账户、售后和弃单召回邮件直接走内部邮件中继，不必先经过 Cloud Mail。Cloud Mail 是同一邮局的网页邮箱入口，不是网站业务邮件的必经中转站。

## 核心功能

- Cloudflare Email Routing 接收邮件；
- 多域名、多用户、附件、转发和开放 API；
- D1 持久化，KV 缓存，可选 R2 附件存储；
- LONGOS 平台级系统集成令牌；
- 自建 Postfix/OpenDKIM 直投，支持租户独立发件域；
- 发件幂等、速率限制、队列健康检查与审计；
- 响应式 Vue 管理界面、验证码识别与数据统计。

## 文档导航

- [推荐：从零部署、Cloudflare 配置与网站关联](./doc/QUICK_START.md)
- [参考：Cloudflare Workers 详细部署与故障排查](./doc/CLOUDFLARE_WORKERS_DEPLOYMENT.md)
- [参考：LONGOS 自建 Postfix/OpenDKIM 与 DNS](./doc/LONGOS_SELF_HOSTED_DEPLOYMENT.md)
- [可选：主站不搬迁，使用第二台服务器的公网 IP 与 PTR/rDNS 发信](./doc/REMOTE_MAIL_NODE.md)
- [English README](./README-en.md)

`mail-relay/` 默认无需单独部署，因为 LONGOS 的 Coolify Compose 已经包含中继、Postfix 与 OpenDKIM。仅当主服务器不适合直接发信时，才按上述专用出口节点文档把 `/mail-relay/docker-compose.coolify.yml` 部署到第二台服务器；不要在第二台服务器重复部署完整 LONGOS 或 Cloud Mail，也不要为该节点启动会争抢 80/443 的 Coolify Proxy。

## 本地部署与排障

可信电脑只需安装包含 npm 的 Node.js 22 或更高版本，一次性安全部署直接运行：

```bash
node scripts/deploy-wizard.mjs
```

无需预装 pnpm 或 Corepack。若两者都不存在，部署器会从 npm 官方注册表临时安装与 CI 一致的固定版 pnpm，禁用安装脚本并在部署结束后自动删除；Cloudflare Token、管理员密码等部署凭据不会传给 npm。

只有非交互自动化或排障才需要明文配置文件：

```bash
cp .cloud-mail.deploy.env.example .cloud-mail.deploy.env
node scripts/deploy-cloudflare.mjs --validate-only
node scripts/deploy-cloudflare.mjs
```

## 安全与交付要求

- 不要把 `ADMIN_PASSWORD`、`CLOUDFLARE_API_TOKEN`、`LONGOS_INTEGRATION_TOKEN` 或 JWT 密钥写入仓库；
- GitHub 手动工作流没有密文输入类型，因此密钥绝不作为 `workflow_dispatch` 文本字段；一次性向导只使用当前进程，GitHub 触发脚本则通过标准输入把密钥写入受保护的 `production` Environment；
- 安装、审计、测试和构建全部在无密钥步骤完成，生产凭据只注入最终部署步骤；
- Fork/PR 只运行只读无密钥验证；部署仅允许仓库所有者从默认分支手动运行，他人也不能重跑所有者的历史部署；
- 只使用状态为 active 的 Cloudflare API Token，并仅授权目标账户和 Zone；Global API Key 不受支持，即使同时填写 Account ID 也不会放行；
- 自建直投需要固定公网 IP、正确 PTR/rDNS，并允许出站 TCP 25；
- SPF、DKIM、DMARC、EHLO A 记录和 PTR 必须一致；
- 首次上线先完成外部收信、Cloud Mail 网页发信、LONGOS 下单邮件、弃单召回四项验收。

凭据泄漏处置和安全报告方式见 [Security Policy](./SECURITY.md)。

## 来源与许可证

本项目保留 [maillab/cloud-mail](https://github.com/maillab/cloud-mail) 的上游来源与授权说明，并由 LONGOS 扩展自建邮件引擎和一体化部署能力。项目采用 [MIT License](./LICENSE)。
