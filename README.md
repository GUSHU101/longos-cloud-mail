<p align="center">
    <img src="doc/demo/logo.png" width="80px" />
    <h1 align="center">Cloud Mail</h1>
    <p align="center">基于 Cloudflare 的简约响应式邮箱服务，支持邮件发送、附件收发 🎉</p> 
    <p align="center">
        简体中文 | <a href="/README-en.md" style="margin-left: 5px">English </a>
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


## 项目简介

只需要一个域名，就可以创建多个不同的邮箱，类似各大邮箱平台。本项目支持部署到 Cloudflare Workers，降低服务器成本，搭建自己的邮箱服务。

本发行版保留 [maillab/cloud-mail](https://github.com/maillab/cloud-mail) 的上游授权与来源说明，并集成 LONGOS 自建邮件引擎。新版独立仓库为 [GUSHU101/longos-cloud-mail](https://github.com/GUSHU101/longos-cloud-mail)，当前正式版本：**v4.1.0**。

## 项目展示

- [在线演示](https://skymail.ink)<br>
- [部署文档](https://doc.skymail.ink)<br>

| ![](/doc/demo/demo1.png) | ![](/doc/demo/demo2.png) |
|-----------------------|-----------------------|
| ![](/doc/demo/demo3.png) | ![](/doc/demo/demo4.png) |




## 功能介绍

- **💰 低成本使用**： 可部署到 Cloudflare Workers 降低服务器成本

- **💻 响应式设计**：响应式布局自动适配PC和大部分手机端浏览器

- **📧 邮件发送**：支持 Cloudflare、Resend 和完全自建的 Postfix 邮件引擎，支持群发、内嵌图片和附件

- **🛡️ 管理员功能**：可以对用户，邮件进行管理，RABC权限控制对功能及使用资源限制

- **📦 附件收发**：支持收发附件，使用R2对象存储保存和下载文件

- **🔔 邮件推送**：接收邮件后可以转发到TG机器人或其他服务商邮箱

- **📡 开放API**：支持使用API批量生成用户，多条件查询邮件 

- **🔢 验证码识别**：使用Workers AI，自动识别邮件验证码 

- **📈 数据可视化**：使用ECharts对系统数据详情，用户邮件增长可视化显示

- **🎨 个性化设置**：可以自定义网站标题，登录背景，透明度

- **🤖 人机验证**：集成Turnstile人机验证，防止人机批量注册

- **📜 更多功能**：正在开发中...



## 技术栈

- **平台**：[Cloudflare Workers](https://developers.cloudflare.com/workers/)

- **Web框架**：[Hono](https://hono.dev/)

- **ORM：**[Drizzle](https://orm.drizzle.team/)

- **前端框架**：[Vue3](https://vuejs.org/) 

- **UI框架**：[Element Plus](https://element-plus.org/) 

- **邮件发送：** Cloudflare Email、[Resend](https://resend.com/) 或仓库内置的自建 Postfix 中继

- **缓存**：[Cloudflare KV](https://developers.cloudflare.com/kv/)

- **数据库**：[Cloudflare D1](https://developers.cloudflare.com/d1/)

- **文件存储**：[Cloudflare R2](https://developers.cloudflare.com/r2/)

## LONGOS 一体化自建发信

如 Cloud Mail 与 LONGOS 配套使用，LONGOS 的 Docker 安装模式会在执行根目录 `./install.sh` 时随网站自动构建并启动 Postfix/OpenDKIM；不需要进入 `mail-relay` 目录，也不需要单独部署第二套服务。Cloudflare Worker 通过 LONGOS 网站的 `https://站点域名/_longos/mail-relay` 提交 HMAC 签名请求。纯宝塔/LNMP 安装不会启动该中继；健康地址返回 404 时不应在 Worker 中配置中继地址。

完整的服务器要求、首次安装、Cloudflare/GitHub Actions 变量、DNS/PTR、租户发件域、升级与故障排查请参阅：[Cloud Mail + LONGOS 一体化自建邮件部署与升级](./doc/LONGOS_SELF_HOSTED_DEPLOYMENT.md)。

在本仓库 GitHub Actions 中配置 `LONGOS_RELAY_URL`，并把 LONGOS `.env` 的 `CLOUD_MAIL_RELAY_SHARED_SECRET` 保存为同名的 `RELAY_SHARED_SECRET` 后，从 `main` 分支手动运行 `Deploy cloud-mail to Cloudflare Workers`。工作流会完成生产部署并写入 Worker Secret，后台“自动”模式会优先使用 LONGOS 内置引擎。Cloudflare Git Builds 应保持禁用，避免两套流程同时覆盖 Worker。LONGOS 应用和 Cloud Mail 使用不同的签名密钥。独立使用 Cloud Mail、未安装 LONGOS 时，仍可按 [`mail-relay`](./mail-relay/README.md) 的通用方式部署。

发件时的 `From` 始终来自用户当前选中的 Cloud Mail 账户。Worker 会校验该账户属于当前用户且其域名在角色权限内，不会统一改写成 LONGOS 的默认邮箱。

自建模式仍需要固定公网 IP、可设置 PTR/rDNS，并且服务器允许出站 TCP 25。API 密钥只保存在 LONGOS 服务器环境变量、GitHub Secret 和 Cloudflare Worker Secret 中，不写入网页或 D1。

## 目录结构

```
cloud-mail
├── mail-relay                 # 自建 HTTPS Relay + Postfix + OpenDKIM
├── mail-worker				    # worker后端项目
│   ├── src                  
│   │   ├── api	 			    # api接口层			
│   │   ├── const  			    # 项目常量
│   │   ├── dao                 # 数据访问层
│   │   ├── email			    # 邮件处理接收
│   │   ├── entity			    # 数据库实体
│   │   ├── error			    # 自定义异常
│   │   ├── hono			    # web框架配置、拦截器、全局异常等
│   │   ├── i18n			    # 语言国际化
│   │   ├── init			    # 数据库缓存初始化
│   │   ├── model			    # 响应体数据封装
│   │   ├── security			# 身份权限认证
│   │   ├── service			    # 业务服务层
│   │   ├── template			# 消息模板
│   │   ├── utils			    # 工具类
│   │   └── index.js			# 入口文件
│   ├── pageckge.json			# 项目依赖
│   └── wrangler.toml			# 项目配置
│
├── mail-vue				    # vue前端项目
│   ├── src
│   │   ├── axios 			    # axios配置
│   │   ├── components			# 自定义组件
│   │   ├── echarts			    # echarts组件导入
│   │   ├── i18n			    # 语言国际化
│   │   ├── init			    # 入站初始化
│   │   ├── layout			    # 主体布局组件
│   │   ├── perm			    # 权限认证
│   │   ├── request			    # api接口
│   │   ├── router			    # 路由配置
│   │   ├── store			    # 全局状态管理
│   │   ├── utils			    # 工具类
│   │   ├── views			    # 页面组件
│   │   ├── app.vue			    # 入口组件
│   │   ├── main.js			    # 入口js
│   │   └── style.css			# 全局css
│   ├── package.json			# 项目依赖
└── └── env.release				# 项目配置
```

## 赞助

<a href="https://doc.skymail.ink/support.html" >
<img width="170px" src="./doc/images/support.png" alt="">
</a>

## 许可证

本项目采用 [MIT](LICENSE) 许可证	


## 交流

[Telegram](https://t.me/cloud_mail_tg)



