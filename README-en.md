<p align="center">
    <img src="doc/demo/logo.png" width="80px" />
    <h1 align="center">Cloud Mail</h1>
    <p align="center">A simple, responsive email service designed to run on Cloudflare Workers 🎉</p> 
    <p align="center">
       <a href="/README.md" style="margin-left: 5px">简体中文</a> | English 
    </p>
    <p align="center">
        <a href="https://github.com/GUSHU101/longos-cloud-mail/blob/main/LICENSE" target="_blank" >
            <img src="https://img.shields.io/badge/license-MIT-green" />
        </a>    
        <a href="https://github.com/GUSHU101/longos-cloud-mail/releases" target="_blank" >
            <img src="https://img.shields.io/github/v/release/GUSHU101/longos-cloud-mail" alt="releases" />
        </a>  
        <a href="https://github.com/GUSHU101/longos-cloud-mail/issues" >
            <img src="https://img.shields.io/github/issues/GUSHU101/longos-cloud-mail" alt="issues" />
        </a>  
        <a href="https://github.com/GUSHU101/longos-cloud-mail/stargazers" target="_blank">
            <img src="https://img.shields.io/github/stars/GUSHU101/longos-cloud-mail" alt="stargazers" />
        </a>  
        <a href="https://github.com/GUSHU101/longos-cloud-mail/forks" target="_blank" >
            <img src="https://img.shields.io/github/forks/GUSHU101/longos-cloud-mail" alt="forks" />
        </a>
    </p>
    <p align="center">
        <a href="https://trendshift.io/repositories/20459" target="_blank" >
            <img src="https://trendshift.io/api/badge/repositories/20459" alt="trendshift" >
        </a>
    </p>
</p>

## Description
With only one domain, you can create multiple different email addresses, similar to major email platforms. This project can be deployed on Cloudflare Workers to reduce server costs and build your own email service.

This distribution retains the upstream license and attribution for [maillab/cloud-mail](https://github.com/maillab/cloud-mail) and adds the LONGOS self-hosted mail engine. Its canonical repository is [GUSHU101/longos-cloud-mail](https://github.com/GUSHU101/longos-cloud-mail). Current version: **v4.4.0**.
## Project Showcase

- [Live Demo](https://skymail.ink)<br>
- [Deployment Guide](https://doc.skymail.ink/en/)<br>
- [Step-by-step Cloudflare Workers deployment guide (Chinese)](./doc/CLOUDFLARE_WORKERS_DEPLOYMENT.md)<br>
- [Integrated Cloud Mail + LONGOS self-hosted delivery guide (Chinese)](./doc/LONGOS_SELF_HOSTED_DEPLOYMENT.md)<br>


| ![](/doc/demo/demo1.png) | ![](/doc/demo/demo2.png) |
|--------------------------|--------------------------|
| ![](/doc/demo/demo3.png) | ![](/doc/demo/demo4.png) |

## Features

- **💰 Low-Cost Usage**: No server required — deploy to Cloudflare Workers to reduce costs.

- **💻 Responsive Design**: Automatically adapts to both desktop and most mobile browsers.

- **📧 Email Sending**: Cloudflare, Resend, and fully self-hosted Postfix engines with bulk, inline-image, and attachment support.

- **🛡️ Admin Features**: Admin controls for user and email management with RBAC-based access control.

- **📦 Attachment Support**: Send and receive attachments, stored and downloaded via R2 object storage.

- **🔔 Email Push**: Forward received emails to Telegram bots or other email providers.

- **📡 Open API**: Supports batch user creation via API and multi-condition email queries

- **🔢 Verification Code Recognition**: Auto-detect codes via Workers AI

- **📈 Data Visualization**: Use ECharts to visualize system data, including user email growth.

- **🎨 Personalization**: Customize website title, login background, and transparency.

- **🤖 CAPTCHA**: Integrated with Turnstile CAPTCHA to prevent automated registration.

- **📜 More Features**: Under development...

## Tech Stack

- **Platform**: [Cloudflare Workers](https://developers.cloudflare.com/workers/)

- **Web Framework**: [Hono](https://hono.dev/)

- **ORM**: [Drizzle](https://orm.drizzle.team/)

- **Frontend Framework**: [Vue3](https://vuejs.org/)

- **UI Framework**: [Element Plus](https://element-plus.org/)

- **Email Service**: Cloudflare Email, [Resend](https://resend.com/), or the bundled self-hosted Postfix relay

- **Cache**: [Cloudflare KV](https://developers.cloudflare.com/kv/)

- **Database**: [Cloudflare D1](https://developers.cloudflare.com/d1/)

- **File Storage**: [Cloudflare R2](https://developers.cloudflare.com/r2/)

## Integrated LONGOS self-hosted sending

When Cloud Mail is paired with LONGOS, a Git-based Coolify Raw Compose deployment starts the website, database, workers, scheduler, and Postfix/OpenDKIM together behind Coolify's integrated Caddy. There is no second relay deployment. The Worker presents a scoped integration token only to `https://your-control-domain/_longos/mail-relay`; LONGOS validates the tenant sender before translating the request to private-network HMAC authentication.

For the exact Cloudflare Account, API Token, D1/KV/R2, GitHub Actions, custom-domain, Email Routing, initialization, upgrade, and rollback procedure, follow the [complete Cloudflare Workers deployment guide](./doc/CLOUDFLARE_WORKERS_DEPLOYMENT.md).

For a first deployment, start with the [one-command Cloud Mail + LONGOS quick start](./doc/QUICK_START.md): copy `.cloud-mail.deploy.env.example`, fill the values, and run `node scripts/deploy-cloudflare.mjs`. The tool tests and builds the application, creates or reuses D1/KV/R2, verifies the LONGOS gateway, deploys the Worker, writes secrets, and initializes the database.

Create one Cloud Mail credential on the LONGOS control site, then configure `LONGOS_RELAY_URL` and the `LONGOS_INTEGRATION_TOKEN` secret in this repository's GitHub Actions settings before running `Deploy cloud-mail to Cloudflare Workers` from `main`. That single control-site binding serves every active tenant; child sites do not create separate tokens. LONGOS resolves the tenant from the stable `+site-code` sender suffix, so storefront-domain changes do not affect mail access. LONGOS encrypts the token with `APP_KEY` so administrators can reveal it later while authentication still uses its hash. Reveal operations are rate-limited and record their latest time and count. The deployment installs the credential as a Worker secret; it is never stored in the Cloud Mail browser UI or D1. Auto mode prefers the LONGOS engine. `RELAY_SHARED_SECRET` remains only as a compatibility path for standalone or older HMAC relays.

Tenant administrators can change the default and purpose-specific sender addresses. For a domain change, the new sender domain must be signed in the relay through both `MAIL_RELAY_DOMAINS` and `MAIL_RELAY_ALLOWED_SENDER_DOMAINS`, and the LONGOS control-site administrator must assign it uniquely to that tenant. The website host and mail From domain are independent: a `www.example.com` store may send as `orders@example.com`. The mail settings page shows only the intersection of relay-signed and tenant-assigned domains. Switching the sender does not create or replace the single control-site integration token.

The `From` identity always comes from the Cloud Mail account selected by the user. The Worker verifies that the account belongs to that user and that its domain is allowed by the assigned role; the LONGOS relay does not replace it with a platform-wide default address.

Self-hosting still requires a static public IP, configurable PTR/rDNS, and outbound TCP port 25. LONGOS encrypts the integration token with `APP_KEY` for later retrieval and uses its hash for authentication; the token is also stored in GitHub Secrets and the Cloudflare Worker secret. Internal HMAC credentials remain only on the LONGOS server; neither credential is stored in the browser or D1.

## Project Structure

```
cloud-mail
├── mail-relay                 # Self-hosted HTTPS relay + Postfix + OpenDKIM
├── mail-worker				    # Backend worker project
│   ├── src                  
│   │   ├── api	 			    # API layer
│   │   ├── const  			    # Project constants
│   │   ├── dao                 # Data access layer
│   │   ├── email			    # Email processing and handling
│   │   ├── entity			    # Database entities
│   │   ├── error			    # Custom exceptions
│   │   ├── hono			    # Web framework, middleware, error handling
│   │   ├── i18n			    # Internationalization
│   │   ├── init			    # Database and cache initialization
│   │   ├── model			    # Response data models
│   │   ├── security			# Authentication and authorization
│   │   ├── service			    # Business logic layer
│   │   ├── template			# Message templates
│   │   ├── utils			    # Utility functions
│   │   └── index.js			# Entry point
│   ├── package.json			# Project dependencies
│   └── wrangler.toml			# Project configuration
│
├─ mail-vue				        # Frontend Vue project
│   ├── src
│   │   ├── axios 			    # Axios configuration
│   │   ├── components			# Custom components
│   │   ├── echarts			    # ECharts integration
│   │   ├── i18n			    # Internationalization
│   │   ├── init			    # Startup initialization
│   │   ├── layout			    # Main layout components
│   │   ├── perm			    # Permissions and access control
│   │   ├── request			    # API request layer
│   │   ├── router			    # Router configuration
│   │   ├── store			    # Global state management
│   │   ├── utils			    # Utility functions
│   │   ├── views			    # Page components
│   │   ├── app.vue			    # Root component
│   │   ├── main.js			    # Entry JS file
│   │   └── style.css			# Global styles
│   ├── package.json			# Project dependencies
└── └── env.release				# Environment configuration

```

## Sponsor

<a href="https://doc.skymail.ink/support.html">
<img width="170px" src="./doc/images/support.png" alt="">
</a>

## License

This project is licensed under the [MIT](LICENSE) license.

## Communication

[Telegram](https://t.me/cloud_mail_tg)
