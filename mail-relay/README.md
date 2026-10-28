# Cloud Mail 自建发信中继

该组件将 HTTPS 请求安全地提交给本机 Postfix，再由 Postfix 直接投递到收件方 MX。它不依赖 Resend、Mailgun、SendGrid 或 SendCloud。

## 必要条件

- 固定公网 IPv4，且服务商允许出站 TCP 25。
- 可为公网 IP 设置 PTR，PTR 必须指向 `MAIL_HOSTNAME`。
- `MAIL_HOSTNAME` 的 DNS A 记录必须反向指向同一个公网 IP，并设置为 Cloudflare DNS Only。
- 发信域名需要配置 SPF、DKIM 和 DMARC。
- 主机上已有 Nginx、Caddy 或其他 HTTPS 反向代理。

## 部署

通常使用 LONGOS 无需执行本节：LONGOS 的 Coolify Raw Compose 已把相同组件并入网站栈。唯一例外是主服务器没有可控 PTR/rDNS 或出站 TCP 25，此时 LONGOS 与 Cloud Mail 仍留在主服务器，只在第二台服务器部署本目录作为专用邮件出口节点。最新版 LONGOS 控制站后台会生成本目录所需的公开配置清单；两条 HMAC 密钥仍需通过服务器 Secret 配置。请按[第二台服务器专用邮件出口节点](../doc/REMOTE_MAIL_NODE.md)操作，Cloud Mail 仍只连接 LONGOS 主站。

LONGOS 用户请直接阅读[一体化自建邮件部署与升级教程](../doc/LONGOS_SELF_HOSTED_DEPLOYMENT.md)，其中包含 Cloudflare、GitHub Actions、DNS/PTR、租户发件域和升级步骤。

```bash
cd mail-relay
cp .env.example .env
openssl rand -hex 32
# 编辑 .env，填入域名、公网 IP 和生成的独立客户端密钥
docker compose up -d --build
docker compose logs -f relay
```

容器只把 API 暴露到主机的 `127.0.0.1:8788`。请在现有 Web 服务器中添加 HTTPS 反向代理，例如 Nginx：

```nginx
server {
    listen 443 ssl http2;
    server_name relay-api.example.com;

    client_max_body_size 25m;

    location / {
        proxy_pass http://127.0.0.1:8788;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-Proto https;
    }
}
```

`relay-api.example.com` 可以使用 Cloudflare 代理；`mailout.example.com` 必须为 DNS Only。不要把 8788 端口直接开放到公网。

## DNS

假设服务器 IP 为 `203.0.113.10`：

```text
mailout.example.com  A     203.0.113.10
example.com          TXT   "v=spf1 ip4:203.0.113.10 -all"
_dmarc.example.com   TXT   "v=DMARC1; p=none; rua=mailto:dmarc@example.com"
```

PTR 由服务器供应商设置：

```text
203.0.113.10 -> mailout.example.com
```

`MAIL_PUBLIC_IPS` 必须填写该节点真实 SMTP 出口公网 IP。LONGOS 会以 HMAC 读取 `/v1/identity` 的主机名、IP 和 DKIM 公钥并交叉核对配置；接口不返回私钥、HMAC 密钥、队列内容或邮件内容。PTR 无法由这个接口、Cloudflare 或 HTTPS 反向代理代设，仍必须在 IP 服务商后台完成。

首次启动会生成 2048 位 DKIM 密钥并在日志中打印 TXT 记录。也可以随时查看：

```bash
docker compose exec relay sh -c "find /var/lib/dkim -name '*.txt' -type f -exec cat {} \;"
```

## Cloudflare Worker

将 `.env` 中相同的密钥保存为 Worker secret：

```bash
cd ../mail-worker
printf '%s' '你的随机密钥' | npx wrangler secret put RELAY_SHARED_SECRET
```

单独部署 Cloud Mail 时可使用兼容的 `RELAY_SHARED_SECRET`。多客户端环境建议改用 `LONGOS_RELAY_SHARED_SECRET` 和 `CLOUD_MAIL_RELAY_SHARED_SECRET` 隔离密钥；三个变量中至少配置一个，且长度不少于 32 个字符。

然后运行一次 Cloud Mail 数据库初始化/升级，在系统设置中选择“自建邮件服务器”，填写：

```text
https://relay-api.example.com
```

## 安全边界

- API 使用 HMAC-SHA256、时间戳和一次性 nonce 验证请求。
- 仅允许 `ALLOWED_SENDER_DOMAINS` 中的发件域名。
- Cloud Mail 在 Worker 内同时校验发件账户归属和角色域名权限；中继只接受选中账户的发件地址。
- 签名载荷包含用户/账户上下文，日志只记录租户键、账户 ID 和发件域，不记录邮件内容。
- Postfix 仅监听容器回环地址，不能作为公网 Open Relay。
- API 有请求体、附件、To/Cc/Bcc 总人数、单发件身份每分钟请求数、并发投递和连接数限制。
- 成功提交的幂等回执会持久化到 `relay-state` 卷；容器重启后重复的 `requestId` 不会再次投递，默认保留 24 小时。
- 中继会在调用本机 sendmail **之前**同步落盘 `pending` 意图，并在失败时写 `released`、成功时写 `accepted`；若主机在 Postfix 接收后的极小窗口内断电，重启后会把该任务标记为“状态不确定”并拒绝自动重复发信。
- `/health` 同时检查 Postfix、OpenDKIM、持久化回执目录、幂等日志容量和 Postfix 队列深度；队列或仍有效的回执达到上限时会失败关闭并停止接收新任务，绝不会为了腾空间删除防重复记录。
- 密钥只保存在服务器 `.env` 和 Cloudflare Worker secret 中，不能提交到 Git。
