# dsh-im

通过扫码把 IM 机器人接入 DeepSeek Harness。一个插件、一个设置入口，统一管理飞书和微信机器人。

> GitHub 简介：通过扫码把IM机器人接入DeepSeek Harness（支持飞书、微信、钉钉等）。

## 当前内置渠道

- 飞书：扫码创建并绑定机器人，使用长连接收发消息；
- 微信：扫码绑定微信机器人，使用腾讯 iLink 长轮询收发消息。

钉钉等其他 IM 平台可继续按同一渠道适配器结构接入；当前可操作界面仅展示已实现的飞书和微信。

## 安装

```sh
npx -y github:xmanrui/dsh-im install
```

重启 `dsh web`，然后打开「设置 → 插件 → IM机器人」。安装器会用 `dsh-im` 替换 profile 中直接安装的 `dsh-feishu` 和 `dsh-weixin`，但不删除任何渠道数据；原有飞书凭据和微信扫码绑定会继续使用。

## 设计

- Harness 中只注册一个「IM机器人」设置页；
- 左侧使用飞书和微信 Logo 切换渠道，不使用启用/停用开关；
- 两个渠道保持独立的 RPC、凭据、连接监督和会话映射；
- 浏览器只获得二维码和脱敏状态，不获得 App Secret 或 `bot_token`。

## 本地开发

```sh
npm install
npm run check
node bin/dsh-im.mjs install --source .
```

`npm run check` 运行单元测试、构建 Host/Client 产物，并验证发布包不包含凭据或独立飞书/微信设置页注册。
