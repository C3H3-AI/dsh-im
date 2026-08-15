import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { IMSettingsTab } from '../plugin-src/client/index.js';
import { DINGTALK_ENDPOINTS } from '../plugin-src/client/channels/dingtalk/api.js';
import { AccountCard as DingtalkAccountCard } from '../plugin-src/client/channels/dingtalk/index.js';
import {
  BotCard as FeishuBotCard,
  FeishuSettingsTab,
} from '../plugin-src/client/channels/feishu/index.js';
import { AccountCard as WeixinAccountCard } from '../plugin-src/client/channels/weixin/index.js';

const STYLES_URL = new URL('../plugin-src/client/styles.js', import.meta.url);
const FEISHU_STYLES_URL = new URL(
  '../plugin-src/client/channels/feishu/styles.js',
  import.meta.url,
);
const CLIENT_BUNDLE_URL = new URL('../lib/client.js', import.meta.url);
const DINGTALK_CLIENT_SOURCE_URL = new URL(
  '../plugin-src/client/channels/dingtalk/index.js',
  import.meta.url,
);

test('IM settings renders three compact logo channel tabs without enable switches', () => {
  const markup = renderToStaticMarkup(React.createElement(IMSettingsTab, {
    feishuRpcCall: async () => ({ ok: true, value: {} }),
    weixinRpcCall: async () => ({ ok: true, value: {} }),
    dingtalkRpcCall: async () => ({ ok: true, value: {} }),
  }));

  assert.match(markup, /IM机器人/);
  assert.match(markup, /通过扫码把机器人接入 DeepSeek Harness/);
  assert.doesNotMatch(markup, /\d+ 个渠道|dim-channelCount/);
  assert.match(markup, />微信</);
  assert.match(markup, />飞书</);
  assert.match(markup, />钉钉</);
  assert.match(markup, /dim-logoWeixin/);
  assert.match(markup, /dim-logoFeishu/);
  assert.match(markup, /dim-logoDingtalk/);
  assert.equal((markup.match(/role="tab"/g) ?? []).length, 3);
  assert.equal((markup.match(/aria-selected="true"/g) ?? []).length, 1);
  assert.doesNotMatch(markup, /role="switch"|type="checkbox"/);
  assert.doesNotMatch(markup, /dim-chevron|扫码绑定<\/small>|扫码接入<\/small>/);
  assert.doesNotMatch(markup, />INSTANT MESSAGING<|>Channel<|>微信设置</);
});

test('the DingTalk QR card stacks within the narrow combined-channel panel', async () => {
  const styles = await readFile(STYLES_URL, 'utf8');
  assert.match(styles, /\.dim-panel \{ min-width: 0; container-type: inline-size; \}/);
  assert.match(
    styles,
    /@container \(max-width: 680px\)[\s\S]*\.dim-panel \.ddt-qrLayout \{ grid-template-columns: minmax\(0, 1fr\); justify-items: center;/,
  );
  assert.match(styles, /\.dim-panel \.ddt-qrFrame, \.dim-panel \.ddt-countdown \{ width: min\(270px, 100%\); \}/);
  assert.match(styles, /\.dim-panel \.ddt-qrColumn \{ width: 100%; min-width: 0; \}/);
  assert.match(styles, /\.dim-panel \.ddt-qrCopy \{ width: 100%; min-width: 0; overflow-wrap: anywhere; \}/);
});

test('Feishu bot cards place the application identifier under the bot name', async () => {
  const styles = await readFile(FEISHU_STYLES_URL, 'utf8');
  const markup = renderToStaticMarkup(React.createElement(FeishuBotCard, {
    connection: {
      botId: 'bot-feishu-card',
      state: 'connected',
      connected: true,
      bot: {
        name: '今天是牢梁',
        appIdMasked: 'cli_aaf4••••1234',
        domain: 'feishu',
        avatarUrl: 'https://example.com/custom-bot-avatar.png',
      },
      health: {
        summary: '长连接运行正常',
        lastCheckedAt: '2026-08-15T07:30:49.000Z',
      },
    },
    onReconnect() {},
    onRequestRemove() {},
    onConfirmRemove() {},
    onCancelRemove() {},
  }));

  assert.match(markup, /<h3[^>]*>今天是牢梁<\/h3><p[^>]*>cli_aaf4••••1234<\/p>/);
  assert.match(markup, /data-im-channel-logo="feishu"/);
  assert.doesNotMatch(markup, /custom-bot-avatar/);
  assert.equal((markup.match(/class="bxf-metric"/g) ?? []).length, 2);
  assert.match(markup, />消息通道<[^]*>最近检查</);
  assert.doesNotMatch(markup, />应用标识<|>飞书机器人</);
  assert.match(styles, /\.bxf-statusGrid \{[^}]*grid-template-columns: repeat\(2, minmax\(0, 1fr\)\)/);
});

test('Feishu keeps its three heading controls on one row without a plus icon', async () => {
  const styles = await readFile(FEISHU_STYLES_URL, 'utf8');
  const markup = renderToStaticMarkup(React.createElement(FeishuSettingsTab, {
    rpcCall: async () => ({ ok: true, value: {} }),
  }));

  assert.match(markup, /class="bxf-button bxf-bindButton"[^>]*><span>扫码绑定机器人<\/span><\/button>/);
  assert.doesNotMatch(markup, />添加机器人</);
  assert.match(styles, /\.bxf-headingTools \{[^}]*flex-wrap: nowrap;/);
  assert.match(styles, /@container \(max-width: 620px\)[^]*\.bxf-headingTools \{ gap: 6px; \}/);
  assert.doesNotMatch(styles, /\.bxf-headingTools \.bxf-button \{ margin-left: auto; \}/);
});

test('bot cards reuse the same channel brand logos as the channel rail', () => {
  const railMarkup = renderToStaticMarkup(React.createElement(IMSettingsTab, {
    feishuRpcCall: async () => ({ ok: true, value: {} }),
    weixinRpcCall: async () => ({ ok: true, value: {} }),
    dingtalkRpcCall: async () => ({ ok: true, value: {} }),
  }));
  const accountMarkup = renderToStaticMarkup(React.createElement(WeixinAccountCard, {
    account: {
      botId: 'bot-weixin-card',
      state: 'connected',
      connected: true,
      bot: { name: '微信机器人', accountIdMasked: 'wxid••••1234' },
      stats: { messagesReceived: 2, messagesReplied: 2 },
      health: { summary: '长轮询运行正常', lastCheckedAt: '2026-08-15T07:30:49.000Z' },
    },
    onReconnect() {},
    onRequestRemove() {},
    onConfirmRemove() {},
    onCancelRemove() {},
  }));

  assert.match(railMarkup, /data-im-channel-logo="weixin"/);
  assert.match(railMarkup, /data-im-channel-logo="feishu"/);
  assert.match(accountMarkup, /class="dxw-avatar"[^]*data-im-channel-logo="weixin"/);
  assert.equal((accountMarkup.match(/class="dxw-metric"/g) ?? []).length, 2);
  assert.doesNotMatch(accountMarkup, /收到 \/ 回复/);
});

test('DingTalk bot cards omit the redundant received and replied metric', () => {
  const markup = renderToStaticMarkup(React.createElement(DingtalkAccountCard, {
    account: {
      botId: 'bot-dingtalk-card',
      state: 'connected',
      connected: true,
      bot: { name: '钉钉机器人', clientIdMasked: 'ding••••oioy' },
      stats: { messagesReceived: 2, messagesReplied: 2 },
      health: { summary: 'Stream 长连接运行正常', lastCheckedAt: '2026-08-15T07:30:49.000Z' },
    },
    onReconnect() {},
    onRequestRemove() {},
    onConfirmRemove() {},
    onCancelRemove() {},
  }));

  assert.equal((markup.match(/class="ddt-metric"/g) ?? []).length, 2);
  assert.match(markup, />消息通道<[^]*>最近检查</);
  assert.doesNotMatch(markup, /收到 \/ 回复/);
});

test('the bundled DingTalk channel has no local sender approval workflow', async () => {
  const [source, bundle] = await Promise.all([
    readFile(DINGTALK_CLIENT_SOURCE_URL, 'utf8'),
    readFile(CLIENT_BUNDLE_URL, 'utf8'),
  ]);

  assert.equal('approveSender' in DINGTALK_ENDPOINTS, false);
  assert.equal('revokeSender' in DINGTALK_ENDPOINTS, false);
  assert.doesNotMatch(source, /SenderAccess|onApprove|onRevoke|approveSender|revokeSender/);
  assert.doesNotMatch(
    bundle,
    /bot\.sender\.approve|bot\.sender\.revoke|允许使用机器人的钉钉账号|批准使用/,
  );
});
