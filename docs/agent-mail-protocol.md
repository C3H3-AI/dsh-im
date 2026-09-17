# 腾讯 Agent 邮箱（agent.qq.com）协议要点

> 来源：逆向 `@tencent-qqmail/agently-cli` v1.0.15，交叉验证于
> [C3H3-AI/cn_im_hub](https://github.com/C3H3-AI/cn_im_hub) 的 `providers/agent_mail/`。
> 版本绑定常量，腾讯改版可能失效。

## 常量

| 名称 | 值 |
|---|---|
| API_BASE | `https://api.agent.qq.com` |
| AUTH_BASE | `https://auth.agent.qq.com` |
| CLIENT_ID | `cli_002e8cd1f5e97858`（公开常量，版本相关）|
| CLIENT_VERSION | `1.0.15` |
| UA | `agently-cli/1.0.15 (windows/amd64; agent/workbuddy)` |

**UA 是必须的**：服务器按 User-Agent 校验客户端身份，自定义标识会被拒为 `unsupported client`。

## OAuth 设备流（微信扫码）

1. `POST {AUTH_BASE}/oauth/device?func=1`（JSON body）
   ```json
   { "app_id": CLIENT_ID, "cli_agentname": "WorkBuddy", "cli_agentua": "workbuddy",
     "cli_hostname": "homeassistant", "cli_ua": UA, "cli_version": CLIENT_VERSION }
   ```
   → `{ poll_url, browser_url, input_code }`

   **注意**：`agent.qq.com` 没有单次扫码端点（`scan_url` 恒空）。授权页内嵌微信登录二维码，
   所以流程是「打开 browser_url → 页面内扫码登录并确认授权」，不是扫一次码就完事。

2. `GET {poll_url}` —— 每 5 秒轮询，超时 300 秒
   → `{ status: "pending" | "authorized", access_token, refresh_token }`

3. 刷新：`POST {AUTH_BASE}/oauth/token`（form-encoded）
   ```
   grant_type=refresh_token & refresh_token=... & client_id=... & clientversion=...
   ```
   → 新 `access_token` + **轮换的** `refresh_token`（必须回写持久化，否则下次刷新失败）

## REST API

所有请求带 `Authorization: Bearer <access_token>` 与 `User-Agent: UA`。
401 → 刷新一次后重试。**显式设 15 秒超时**（默认 5 分钟会把 setup/reload 挂死）。

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/v1/me` | `data.aliases[]`，取 `is_primary` 的 alias_id/email/name |
| GET | `/v1/aliases/{aid}/messages?limit&dir&cursor` | 列消息 |
| GET | `/v1/aliases/{aid}/messages/{id}` | 读单封 |
| GET | `/v1/aliases/{aid}/messages/search?q&search_in&limit&cursor` | 搜索 |
| POST | `/v1/aliases/{aid}/messages/send` | `{to:[{email}],cc,bcc,subject,body,body_format}` |
| POST | `/v1/aliases/{aid}/messages/{id}/reply` | `{body,body_format,reply_all}` |
| POST | `/v1/aliases/{aid}/messages/{id}/forward` | `{to,include_attachments}` |
| DELETE | `/v1/aliases/{aid}/messages/{id}` | 移入回收站 |
| GET | `/v1/aliases/{aid}/messages/{id}/attachments/{aid}` | 原始字节 |
| GET | `/v1/aliases/{aid}/events/wait?timeout=25` | **长轮询**新邮件推送（准实时）|

## 两步确认

发信可能返回 `error.code === "CONFIRMATION_REQUIRED"` 与 `details.confirmation_token`；
带该 token 重新提交同一 payload 即可（自动处理）。

## 与标准 IMAP/SMTP 的差异

| 维度 | 标准邮箱 | Agent 邮箱 |
|---|---|---|
| 认证 | 邮箱授权码 | **OAuth 扫码** |
| 收信 | IMAP 轮询 | **长轮询 `/events/wait`**（准实时）|
| 依赖 | imapflow + nodemailer | 纯 HTTP |
| 适用范围 | 任意邮箱 | 仅腾讯 Agent 邮箱 |
