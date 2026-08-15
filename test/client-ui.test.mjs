import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { IMSettingsTab } from '../plugin-src/client/index.js';
import { DINGTALK_ENDPOINTS } from '../plugin-src/client/channels/dingtalk/api.js';
import {
  AccountCard as DingtalkAccountCard,
  DingtalkSettingsTab,
} from '../plugin-src/client/channels/dingtalk/index.js';
import {
  BotCard as FeishuBotCard,
  FeishuSettingsTab,
} from '../plugin-src/client/channels/feishu/index.js';
import {
  AccountCard as WeixinAccountCard,
  WeixinSettingsTab,
} from '../plugin-src/client/channels/weixin/index.js';
import {
  AccountCard as WecomAccountCard,
  WecomSettingsTab,
} from '../plugin-src/client/channels/wecom/index.js';

const STYLES_URL = new URL('../plugin-src/client/styles.js', import.meta.url);
const FEISHU_STYLES_URL = new URL(
  '../plugin-src/client/channels/feishu/styles.js',
  import.meta.url,
);
const WEIXIN_STYLES_URL = new URL(
  '../plugin-src/client/channels/weixin/styles.js',
  import.meta.url,
);
const DINGTALK_STYLES_URL = new URL(
  '../plugin-src/client/channels/dingtalk/styles.js',
  import.meta.url,
);
const WECOM_STYLES_URL = new URL(
  '../plugin-src/client/channels/wecom/styles.js',
  import.meta.url,
);
const FEISHU_SOURCE_URL = new URL(
  '../plugin-src/client/channels/feishu/index.js',
  import.meta.url,
);
const WEIXIN_SOURCE_URL = new URL(
  '../plugin-src/client/channels/weixin/index.js',
  import.meta.url,
);
const CLIENT_BUNDLE_URL = new URL('../lib/client.js', import.meta.url);
const DINGTALK_CLIENT_SOURCE_URL = new URL(
  '../plugin-src/client/channels/dingtalk/index.js',
  import.meta.url,
);
const WECOM_SOURCE_URL = new URL(
  '../plugin-src/client/channels/wecom/index.js',
  import.meta.url,
);

test('IM settings renders five compact logo channel tabs without enable switches', () => {
  const markup = renderToStaticMarkup(React.createElement(IMSettingsTab, {
    feishuRpcCall: async () => ({ ok: true, value: {} }),
    weixinRpcCall: async () => ({ ok: true, value: {} }),
    dingtalkRpcCall: async () => ({ ok: true, value: {} }),
    wecomRpcCall: async () => ({ ok: true, value: {} }),
    qqRpcCall: async () => ({ ok: true, value: {} }),
  }));

  assert.match(markup, /IM机器人/);
  assert.match(markup, /通过扫码把机器人接入 DeepSeek Harness/);
  assert.doesNotMatch(markup, /\d+ 个渠道|dim-channelCount/);
  assert.match(markup, />微信</);
  assert.match(markup, />飞书</);
  assert.match(markup, />钉钉</);
  assert.match(markup, />企业微信</);
  assert.match(markup, />QQ</);
  assert.match(markup, /dim-logoWeixin/);
  assert.match(markup, /dim-logoFeishu/);
  assert.match(markup, /dim-logoDingtalk/);
  assert.match(markup, /dim-logoWecom/);
  assert.match(markup, /dim-logoQq/);
  assert.equal((markup.match(/role="tab"/g) ?? []).length, 5);
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
  assert.match(markup, /class="bxf-card bxf-botCard dim-botCard"/);
  assert.match(markup, /class="bxf-healthPill dim-botHealth"/);
  assert.match(markup, /<button[^>]*aria-label="检查连接今天是牢梁"[^>]*><span>检查连接<\/span><\/button>/);
  assert.match(markup, /class="bxf-connectedFooter dim-cardFooter"/);
  assert.equal((markup.match(/dim-cardAction(?: |")/g) ?? []).length, 2);
  assert.doesNotMatch(markup, /连接状态：|bxf-divider/);
  assert.doesNotMatch(markup, /custom-bot-avatar/);
  assert.equal((markup.match(/class="bxf-metric dim-botMetric"/g) ?? []).length, 2);
  assert.match(markup, />消息通道<[^]*>最近检查</);
  assert.doesNotMatch(markup, />应用标识<|>飞书机器人</);
  assert.match(styles, /\.bxf-statusGrid \{[^}]*grid-template-columns: repeat\(2, minmax\(0, 1fr\)\)/);
});

test('Feishu keeps its heading controls on one row without a plus icon', async () => {
  const styles = await readFile(FEISHU_STYLES_URL, 'utf8');
  const markup = renderToStaticMarkup(React.createElement(FeishuSettingsTab, {
    rpcCall: async () => ({ ok: true, value: {} }),
  }));

  assert.match(markup, /class="bxf-button bxf-bindButton dim-scanButton"[^>]*><span>扫码绑定机器人<\/span><\/button>/);
  assert.doesNotMatch(markup, />添加机器人</);
  assert.match(styles, /\.bxf-headingTools \{[^}]*justify-content: space-between;[^}]*flex-wrap: nowrap;/);
  assert.match(styles, /@container \(max-width: 620px\)[^]*\.bxf-headingTools \{ gap: 6px; \}/);
  assert.doesNotMatch(styles, /\.bxf-headingTools \.bxf-button \{ margin-left: auto; \}/);
});

test('scan actions align left while online totals align right in every channel', async () => {
  const [imStyles, feishuStyles, weixinStyles, dingtalkStyles, wecomStyles, feishuSource, weixinSource, dingtalkSource, wecomSource] = await Promise.all([
    readFile(STYLES_URL, 'utf8'),
    readFile(FEISHU_STYLES_URL, 'utf8'),
    readFile(WEIXIN_STYLES_URL, 'utf8'),
    readFile(DINGTALK_STYLES_URL, 'utf8'),
    readFile(WECOM_STYLES_URL, 'utf8'),
    readFile(FEISHU_SOURCE_URL, 'utf8'),
    readFile(WEIXIN_SOURCE_URL, 'utf8'),
    readFile(DINGTALK_CLIENT_SOURCE_URL, 'utf8'),
    readFile(WECOM_SOURCE_URL, 'utf8'),
  ]);

  assert.match(imStyles, /\.dim-panel \.bxf-headingTools, \.dim-panel \.dxw-tools, \.dim-panel \.ddt-tools \{[^}]*justify-content: space-between;/);
  assert.match(feishuStyles, /\.bxf-headingTools \{[^}]*justify-content: space-between;/);
  assert.match(weixinStyles, /\.dxw-tools \{[^}]*justify-content: space-between;/);
  assert.match(dingtalkStyles, /\.ddt-tools \{[^}]*justify-content: space-between;/);
  assert.match(wecomStyles, /\.dwecom-page/);

  const headingSource = (source) => source.slice(
    source.indexOf('function Heading'),
    source.indexOf('function LoadingView'),
  );
  const feishuHeading = headingSource(feishuSource);
  const weixinHeading = headingSource(weixinSource);
  const dingtalkHeading = headingSource(dingtalkSource);
  const wecomHeading = headingSource(wecomSource);
  assert.ok(feishuHeading.indexOf('扫码绑定机器人') < feishuHeading.indexOf('bxf-totalBadge'));
  assert.ok(weixinHeading.indexOf('扫码绑定微信') < weixinHeading.indexOf('dxw-badge'));
  assert.ok(dingtalkHeading.indexOf('扫码接入钉钉') < dingtalkHeading.indexOf('ddt-badge'));
  assert.ok(wecomHeading.indexOf('扫码绑定企业微信机器人') < wecomHeading.indexOf('ddt-badge'));

  for (const heading of [feishuHeading, weixinHeading, dingtalkHeading, wecomHeading]) {
    assert.match(heading, /dim-scanButton/);
    assert.match(heading, /dim-onlineBadge/);
  }
  assert.doesNotMatch(weixinHeading, /dxw-dot/);
  assert.doesNotMatch(dingtalkHeading, /ddt-dot/);
  assert.match(imStyles, /\.dim-panel \.bxf-headingTools \.dim-scanButton,[^}]*border: 1px solid #1677ff;[^}]*border-radius: 8px;[^}]*background: #1677ff;[^}]*box-shadow: none;/);
  assert.match(imStyles, /\.dim-panel \.bxf-headingTools \.dim-onlineBadge,[^}]*border-radius: 999px;[^}]*background: var\(--dsw-alias-fill-secondary, #f2f3f5\);[^}]*font-size: 12px;/);
});

test('channel headings omit the redundant local credential badge', () => {
  const components = [FeishuSettingsTab, WeixinSettingsTab, DingtalkSettingsTab, WecomSettingsTab];

  for (const Component of components) {
    const markup = renderToStaticMarkup(React.createElement(Component, {
      rpcCall: async () => ({ ok: true, value: {} }),
    }));
    assert.doesNotMatch(markup, /凭据仅保存在本机/);
  }
});

test('all channel settings states use the DingTalk page treatment', async () => {
  const [styles, feishuSource, weixinSource, dingtalkSource, wecomSource] = await Promise.all([
    readFile(STYLES_URL, 'utf8'),
    readFile(FEISHU_SOURCE_URL, 'utf8'),
    readFile(WEIXIN_SOURCE_URL, 'utf8'),
    readFile(DINGTALK_CLIENT_SOURCE_URL, 'utf8'),
    readFile(WECOM_SOURCE_URL, 'utf8'),
  ]);

  for (const Component of [FeishuSettingsTab, WeixinSettingsTab, DingtalkSettingsTab, WecomSettingsTab]) {
    const markup = renderToStaticMarkup(React.createElement(Component, {
      rpcCall: async () => ({ ok: true, value: {} }),
    }));
    assert.match(markup, /dim-channelPage/);
    assert.match(markup, /dim-surfaceCard dim-loadingView/);
    assert.match(markup, /dim-spinner/);
  }

  for (const source of [feishuSource, weixinSource, dingtalkSource, wecomSource]) {
    for (const className of [
      'dim-channelPage',
      'dim-surfaceCard',
      'dim-loadingView',
      'dim-emptyView',
      'dim-qrLayout',
      'dim-inlineError',
      'dim-listHeading',
      'dim-confirm',
    ]) {
      assert.match(source, new RegExp(className));
    }
  }

  assert.match(styles, /\.dim-panel \.dim-channelPage \{[^}]*flex-direction: column;[^}]*gap: 18px;/);
  assert.match(styles, /\.dim-panel \.dim-surfaceCard \{[^}]*border-radius: 14px;[^}]*box-shadow: 0 1px 2px/);
  assert.match(styles, /\.dim-panel \.dim-loadingView \{[^}]*padding: 38px;[^}]*text-align: center;/);
  assert.match(styles, /\.dim-panel \.dim-emptyView \{[^}]*grid-template-columns: minmax\(0, 1fr\) 180px;[^}]*gap: 30px;/);
  assert.match(styles, /\.dim-panel \.dim-qrLayout \{[^}]*grid-template-columns: 300px minmax\(0, 1fr\);[^}]*gap: 34px;[^}]*align-items: start;/);
  assert.match(styles, /\.dim-panel \.dim-viewActions \.bxf-button,[^}]*min-height: 34px;[^}]*border-radius: 8px;[^}]*font-size: 13px;/);
  assert.match(styles, /\.dim-panel \.dim-inlineError \{[^}]*padding: 22px;[^}]*background:/);
  assert.match(styles, /\.dim-panel \.dim-confirm \{[^}]*padding: 18px 24px;[^}]*border-top: 1px solid/);
});

test('bot cards reuse the same channel brand logos as the channel rail', () => {
  const railMarkup = renderToStaticMarkup(React.createElement(IMSettingsTab, {
    feishuRpcCall: async () => ({ ok: true, value: {} }),
    weixinRpcCall: async () => ({ ok: true, value: {} }),
    dingtalkRpcCall: async () => ({ ok: true, value: {} }),
    wecomRpcCall: async () => ({ ok: true, value: {} }),
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
  assert.match(railMarkup, /data-im-channel-logo="wecom"/);
  assert.match(accountMarkup, /class="dxw-card dim-botCard"/);
  assert.match(accountMarkup, /class="dxw-avatar dim-botAvatar"[^]*data-im-channel-logo="weixin"/);
  assert.match(accountMarkup, /class="dxw-health dim-botHealth"/);
  assert.match(accountMarkup, /class="dxw-accountFooter dim-cardFooter"/);
  assert.equal((accountMarkup.match(/dim-cardAction(?: |")/g) ?? []).length, 2);
  assert.equal((accountMarkup.match(/class="dxw-metric dim-botMetric"/g) ?? []).length, 2);
  assert.doesNotMatch(accountMarkup, /收到 \/ 回复/);
});

test('Enterprise WeChat cards reuse the rail logo and compact action treatment', () => {
  const markup = renderToStaticMarkup(React.createElement(WecomAccountCard, {
    account: {
      botId: 'wecom-card', state: 'connected', connected: true,
      bot: { name: '企业微信机器人', appIdMasked: 'bot••••001' },
      health: { summary: '企业微信 WebSocket 长连接运行正常', lastCheckedAt: Date.now() },
    },
    onReconnect() {}, onRequestRemove() {}, onConfirmRemove() {}, onCancelRemove() {},
  }));
  assert.match(markup, /data-im-channel-logo="wecom"/);
  assert.equal((markup.match(/dim-cardAction(?: |")/g) ?? []).length, 2);
  assert.equal((markup.match(/class="ddt-metric dim-botMetric"/g) ?? []).length, 2);
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

  assert.match(markup, /class="ddt-card dim-botCard"/);
  assert.match(markup, /class="ddt-health dim-botHealth"/);
  assert.equal((markup.match(/class="ddt-metric dim-botMetric"/g) ?? []).length, 2);
  assert.match(markup, /class="ddt-accountFooter dim-cardFooter"/);
  assert.equal((markup.match(/dim-cardAction(?: |")/g) ?? []).length, 2);
  assert.match(markup, />消息通道<[^]*>最近检查</);
  assert.doesNotMatch(markup, /收到 \/ 回复/);
});

test('all channel card action buttons stay on one row', async () => {
  const [imStyles, feishuStyles, weixinStyles, dingtalkStyles] = await Promise.all([
    readFile(STYLES_URL, 'utf8'),
    readFile(FEISHU_STYLES_URL, 'utf8'),
    readFile(WEIXIN_STYLES_URL, 'utf8'),
    readFile(DINGTALK_STYLES_URL, 'utf8'),
  ]);

  assert.match(feishuStyles, /\.bxf-botActions \{[^}]*flex-wrap: nowrap;/);
  assert.match(weixinStyles, /\.dxw-accountFooter \.dxw-actions \{[^}]*flex-wrap: nowrap;/);
  assert.match(dingtalkStyles, /\.ddt-accountFooter \.ddt-actions \{[^}]*flex-wrap: nowrap;/);
  assert.match(imStyles, /\.dim-panel \.dim-cardFooter \{[^}]*gap: 15px;[^}]*padding-top: 16px;[^}]*border-top: 1px solid/);
  assert.match(imStyles, /\.dim-panel \.dim-cardActions \.dim-cardAction \{[^}]*min-height: 34px;[^}]*border-radius: 8px;[^}]*font-size: 13px;/);
  assert.match(imStyles, /\.dim-panel \.dim-cardActions \.dim-cardAction\[data-kind="danger"\] \{[^}]*#d54941/);
  assert.doesNotMatch(feishuStyles, /\.bxf-connectedFooter \{[^}]*flex-direction: column/);
  assert.doesNotMatch(weixinStyles, /\.dxw-accountFooter \{[^}]*flex-direction: column/);
  assert.doesNotMatch(dingtalkStyles, /\.ddt-accountFooter \{[^}]*flex-direction: column/);
});

test('all channel bot cards use the DingTalk card treatment', async () => {
  const styles = await readFile(STYLES_URL, 'utf8');

  assert.match(styles, /\.dim-panel \.dim-botCard \{[^}]*border-radius: 14px;[^}]*background: var\(--dsw-alias-bg-body, #fff\);[^}]*box-shadow: 0 1px 2px/);
  assert.match(styles, /\.dim-panel \.dim-botCardBody \{[^}]*padding: 24px;/);
  assert.match(styles, /\.dim-panel \.dim-botCardTop \{[^}]*align-items: flex-start;[^}]*gap: 16px;/);
  assert.match(styles, /\.dim-panel \.dim-botAvatar \{[^}]*width: 42px;[^}]*height: 42px;[^}]*border-radius: 12px;/);
  assert.match(styles, /\.dim-panel \.dim-botName h3 \{[^}]*font-size: 15px;/);
  assert.match(styles, /\.dim-panel \.dim-botCard \.dim-botHealth \{[^}]*background: transparent;[^}]*font-size: 12px;[^}]*font-weight: 400;/);
  assert.match(styles, /\.dim-panel \.dim-botMetrics \{[^}]*grid-template-columns: repeat\(2, minmax\(0, 1fr\)\);[^}]*gap: 10px;[^}]*margin: 20px 0;/);
  assert.match(styles, /\.dim-panel \.dim-botMetric \{[^}]*padding: 12px;[^}]*border: 0;[^}]*border-radius: 9px;/);
  assert.match(styles, /\.dim-panel \.dim-botMetric dd \{[^}]*margin: 5px 0 0;[^}]*font-size: 13px;[^}]*font-weight: 400;/);
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
