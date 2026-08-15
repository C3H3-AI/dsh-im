# dsh-im

## 中文

通过扫码把 IM 机器人接入 DeepSeek Harness。一个插件、一个设置入口，统一管理飞书、微信、钉钉、企业微信和 QQ 机器人。

> GitHub 简介：通过扫码把IM机器人接入DeepSeek Harness（支持飞书、微信、钉钉、企业微信和QQ）。

## 界面

![IM机器人页面](docs/images/imbot.png)

## 当前内置渠道

- 飞书：扫码创建并绑定机器人，使用长连接收发消息；
- 微信：扫码绑定微信机器人，使用腾讯 iLink 长轮询收发消息；
- 钉钉：扫码创建并授权机器人，使用钉钉 Stream 长连接收消息，并通过 AI Card 流式显示 Harness 回答。
- 企业微信：使用企业微信 App 扫码创建并授权智能机器人，通过官方 WebSocket 长连接收消息，原生显示“正在思考中”、工具执行进度和流式回答。
- QQ：使用手机 QQ 扫码创建或绑定 QQ 机器人，通过 WebSocket 长连接收消息；私聊支持原生“正在输入”和流式回答，群聊在机器人被 @ 后回复。

其他 IM 平台可继续按同一渠道适配器结构接入。

## 安装

```sh
npx -y github:xmanrui/dsh-im install
```

重启 `dsh web`，然后打开「设置 → 插件 → IM机器人」。安装器会用 `dsh-im` 替换 profile 中直接安装的 `dsh-feishu`、`dsh-weixin` 和 `dsh-dingtalk`，但不删除任何渠道数据；原有渠道凭据和扫码绑定会继续使用。

钉钉接入时，请使用已加入企业/组织且有权创建机器人的钉钉账号扫描页面二维码，再在钉钉授权页点击「一键创建新机器人」。若提示“该账号还未加入组织”，请先创建组织或换用已加入组织的账号后重新扫码。插件不设置本机二次批准流程，钉钉中的机器人可见范围就是入站访问范围，请只开放给信任的组织、群或成员。

企业微信接入使用企业微信官方扫码流程，不需要手动填写 Bot ID 或 Secret。请使用已加入企业且具有机器人创建或管理权限的企业微信账号扫码，并在手机端确认创建智能机器人。扫码创建的是企业微信智能机器人，不是让插件直接登录个人微信账号。插件不设置本机二次批准流程，企业微信中的机器人可见范围就是入站访问范围，请只开放给信任的企业成员和群聊。

QQ 接入使用腾讯 QQBot v2 官方扫码流程，不需要手动填写 AppID 或 AppSecret。默认腾讯授权页会把接入方显示为“第三方机器人”；扫码成功后创建或绑定的是 QQ 开放平台机器人，并不是让插件直接控制个人 QQ 账号。扫码者会自动成为该机器人在 Harness 中的使用者，不增加本机二次批准步骤。

## 设计

- Harness 中只注册一个「IM机器人」设置页；
- 飞书、微信、钉钉、企业微信和 QQ 的 Host、客户端与运行时源码都在本仓库维护，不依赖外部独立渠道插件；
- 左侧使用渠道 Logo 切换微信、飞书、钉钉、企业微信和 QQ，不使用启用/停用开关；
- 五个渠道保持独立的 RPC、凭据、连接监督和会话映射；
- 浏览器只获得二维码和脱敏状态，不获得 App Secret、`bot_token`、钉钉 `client_secret`、企业微信 Secret、QQ `app_secret` 或原始用户标识。

## 本地开发

```sh
npm install
npm run check
node bin/dsh-im.mjs install --source .
```

`npm run check` 运行单元测试、构建 Host/Client 产物，并验证发布包不包含凭据或独立渠道设置页注册。

---

## English

Connect IM bots to DeepSeek Harness by scanning a QR code. One plugin and one settings entry provide unified management for Feishu, WeChat, DingTalk, WeCom, and QQ bots.

> GitHub description: Connect IM bots to DeepSeek Harness by scanning a QR code (supports Feishu, WeChat, DingTalk, WeCom, and QQ).

## Interface

![IM bot settings page](docs/images/imbot.png)

## Built-in channels

- Feishu: create and bind a bot by scanning a QR code, then send and receive messages over a persistent connection.
- WeChat: bind a WeChat bot by scanning a QR code, then send and receive messages through Tencent iLink long polling.
- DingTalk: create and authorize a bot by scanning a QR code, receive messages through DingTalk Stream, and stream Harness replies through AI Cards.
- WeCom: create and authorize an intelligent bot by scanning with the WeCom app, receive messages over the official WebSocket connection, and natively show a thinking state, tool progress, and streaming replies.
- QQ: create or bind a QQ bot by scanning with mobile QQ, receive messages over a WebSocket connection, stream private-chat replies with a native typing indicator, and reply in groups when mentioned.

Other IM platforms can be added through the same channel-adapter structure.

## Installation

```sh
npx -y github:xmanrui/dsh-im install
```

Restart `dsh web`, then open **Settings → Plugins → IM Bot**. The installer replaces directly installed `dsh-feishu`, `dsh-weixin`, and `dsh-dingtalk` entries in the profile with `dsh-im` without deleting channel data.

For DingTalk, scan with an account that belongs to an enterprise or organization and can create bots, then choose **Create a new bot** on the authorization page. If DingTalk reports that the account has not joined an organization, create one or switch to an account that has, then scan again. There is no second local sender-approval flow: the bot's DingTalk visibility is its inbound access scope, so restrict it to trusted organizations, groups, or members.

WeCom uses the official QR authorization flow and does not require manually entering a Bot ID or Secret. Scan with a WeCom account that belongs to an enterprise and can create or manage bots, then confirm creation of the intelligent bot in the mobile app. This creates a WeCom intelligent bot; it does not sign the plugin into a personal WeChat account. There is no second local sender-approval flow, so restrict the bot's WeCom visibility to trusted enterprise members and group chats.

QQ uses Tencent's official QQBot v2 QR flow and does not require manually entering an AppID or AppSecret. Tencent's default authorization page labels the integration as a third-party bot. Scanning creates or binds a QQ Open Platform bot; it does not give the plugin direct control of a personal QQ account. The scanner becomes the Harness user for that bot without an additional local approval step.

## Design

- Registers a single **IM Bot** settings page in Harness.
- Maintains the Feishu, WeChat, DingTalk, WeCom, and QQ Host, client, and runtime sources in this repository without external standalone channel plugins.
- Uses channel logos for WeChat, Feishu, DingTalk, WeCom, and QQ navigation without enable/disable switches.
- Keeps RPC endpoints, credentials, connection supervision, and session mappings isolated by channel.
- Sends only QR codes and redacted status data to the browser, never App Secrets, `bot_token`, DingTalk `client_secret`, WeCom Secrets, QQ `app_secret`, or raw user identifiers.

## Local development

```sh
npm install
npm run check
node bin/dsh-im.mjs install --source .
```

`npm run check` runs unit tests, builds the Host and Client artifacts, and verifies that the published package contains neither credentials nor standalone channel settings-page registrations.
