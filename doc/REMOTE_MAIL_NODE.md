# 主服务器运行 LONGOS + Cloud Mail，第二台服务器仅负责邮件出口

这是固定公网 IP、PTR/rDNS 或 TCP 25 不能放在网站服务器时的推荐拓扑。`LONGOS` 与 Cloud Mail Worker 的关联方式不变；第二台服务器不部署商城、数据库、Cloud Mail Worker 或管理后台，只运行 `mail-relay/` 中的 Postfix、OpenDKIM 和 HMAC API。

```text
Cloud Mail Worker ── Bearer Token ──┐
                                    ├─> LONGOS（主服务器）
LONGOS 业务邮件 ────────────────────┘          │
                                                │ HTTPS + HMAC
                                                ▼
                               mail-relay（第二台服务器）
                                                │ SMTP 25 出站
                                                ▼
                                           收件方 MX
```

PTR/rDNS 不是 HTTP 反向代理，也不是普通 Cloudflare DNS 记录。它属于第二台服务器公网 IP 的所有者，必须在该 VPS/IP 服务商后台设置。HTTPS 反向代理只用于保护 HMAC API；它不会改变 SMTP 出口 IP。

## 一、第二台服务器的前置条件

- 固定、非共享的公网 IPv4（或已完整配置的 IPv6）；
- 服务商允许出站 TCP 25；
- 服务商控制台允许把该 IP 的 PTR/rDNS 设置成 `mailout.example.com`；
- `mailout.example.com` 的 A/AAAA 使用 DNS Only，正向指回同一个 IP；
- 已有 Nginx、Caddy 或其他 HTTPS 入口，可把一个独立 API 域名反代到 `127.0.0.1:8788`。

网站域名可以继续使用 Cloudflare 橙云。邮件主机 `mailout.example.com` 必须灰云；API 域名（例如 `relay-api.example.com`）可以被 Cloudflare 代理，但不能缓存、改写或绕过 HTTPS。

## 二、部署第二台服务器的邮件节点

```bash
git clone https://github.com/GUSHU101/longos-cloud-mail.git
cd longos-cloud-mail/mail-relay
cp .env.example .env
docker compose up -d --build
docker compose logs -f relay
```

至少修改以下变量：

```dotenv
MAIL_HOSTNAME=mailout.example.com
MAIL_PUBLIC_IPS=<第二台服务器的真实公网 IP>
MAIL_DOMAINS=example.com
ALLOWED_SENDER_DOMAINS=example.com
LONGOS_RELAY_SHARED_SECRET=<与 LONGOS Coolify 中 SERVICE_PASSWORD_64_MAILRELAY 相同>
CLOUD_MAIL_RELAY_SHARED_SECRET=<与 LONGOS Coolify 中 SERVICE_PASSWORD_64_CLOUDMAIL 相同>
```

两条 HMAC 密钥必须不同、各不少于 32 个字符，只保存在两台服务器的 Secret 环境中。不要把它们写入 Git、Cloudflare Worker、浏览器或聊天记录。

容器只监听宿主机 `127.0.0.1:8788`。在第二台服务器已有的 Web 入口中，把 `https://relay-api.example.com` 反向代理到这个地址。不要公开 8788，也不要开放入站 SMTP 25。示例 Nginx：

```nginx
server {
    listen 443 ssl http2;
    server_name relay-api.example.com;
    client_max_body_size 32m;

    location / {
        proxy_pass http://127.0.0.1:8788;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-Proto https;
        proxy_read_timeout 65s;
    }
}
```

## 三、让主服务器使用第二台服务器

在 LONGOS 的 Coolify 环境变量中设置：

```dotenv
MAIL_RELAY_ENDPOINT=https://relay-api.example.com
MAIL_RELAY_HOSTNAME=mailout.example.com
MAIL_RELAY_IPS=<第二台服务器的真实公网 IP>
MAIL_RELAY_AUTO_DETECT_IPS=false
MAIL_RELAY_DOMAINS=example.com
MAIL_RELAY_ALLOWED_SENDER_DOMAINS=example.com
```

然后 Redeploy LONGOS。Compose 仍会保留同机中继容器及其持久卷，但业务投递和 Cloud Mail 网关会改走外部 HTTPS 节点。LONGOS 使用 HMAC 从第二台服务器读取仅含主机名、公网 IP 和 DKIM 公钥的身份清单；私钥永远不会离开邮件节点。若两台服务器的主机名、IP、selector、签名域或 DKIM 不一致，DNS 同步会失败关闭，不会把错误身份发布到公网。

Cloud Mail 仍只配置主服务器：

```dotenv
LONGOS_RELAY_URL=https://主站域名/_longos/mail-relay
LONGOS_INTEGRATION_TOKEN=longos_it_...
```

不要把 Cloud Mail Worker 直接指向第二台服务器。主站网关负责租户、发件域和权限校验，然后才通过 HMAC 调用邮件节点。

## 四、设置并验收 PTR/rDNS

在第二台服务器的 VPS/IP 服务商控制台设置：

```text
<第二台服务器公网 IP> -> mailout.example.com
```

等待服务商的反向 DNS 生效后，在 LONGOS 后台“系统 → 基础设置 → 邮件设置”点击“立即检测”。必须同时通过：

- 外置中继 HTTPS、Postfix、OpenDKIM、队列和回执存储；
- `mailout.example.com` 的 A/AAAA 等于第二台服务器的公网 IP；
- 该 IP 的 PTR 返回 `mailout.example.com`；
- SPF、DKIM、DMARC；
- 测试邮件和真实下单邮件。

Cloudflare、Nginx、Caddy 和 3X-UI 都不能替 IP 服务商创建 PTR。如果服务商不允许设置 PTR、封禁 TCP 25 或分配的是共享 NAT IP，这台服务器不适合作为直投邮件节点，应更换可控制 rDNS 的 IP/VPS 或使用合规 SMTP 服务商。
