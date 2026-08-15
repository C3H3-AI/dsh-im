import * as React from 'react';

import {
  DingtalkLogoGlyph,
  FeishuLogoGlyph,
  QqLogoGlyph,
  WecomLogoGlyph,
  WeixinLogoGlyph,
} from './channel-logos.js';
import { DINGTALK_RPC_CHANNEL } from './channels/dingtalk/api.js';
import { DingtalkSettingsTab } from './channels/dingtalk/index.js';
import { FeishuSettingsTab } from './channels/feishu/index.js';
import { FEISHU_RPC_CHANNEL } from './channels/feishu/api.js';
import { installFeishuStyles } from './channels/feishu/styles.js';
import { QQ_RPC_CHANNEL } from './channels/qq/api.js';
import { QqSettingsTab } from './channels/qq/index.js';
import { installQqStyles } from './channels/qq/styles.js';
import { WECOM_RPC_CHANNEL } from './channels/wecom/api.js';
import { WecomSettingsTab } from './channels/wecom/index.js';
import { installWecomStyles } from './channels/wecom/styles.js';
import { WeixinSettingsTab } from './channels/weixin/index.js';
import { WEIXIN_RPC_CHANNEL } from './channels/weixin/api.js';
import { installWeixinStyles } from './channels/weixin/styles.js';
import { installImStyles } from './styles.js';

const h = React.createElement;

export const name = 'im-settings';
export const inject = ['slots', 'connection'];

const CHANNELS = Object.freeze([
  { id: 'weixin', label: '微信' },
  { id: 'feishu', label: '飞书' },
  { id: 'dingtalk', label: '钉钉' },
  { id: 'wecom', label: '企业微信' },
  { id: 'qq', label: 'QQ' },
]);

function WeixinLogo() {
  return h('span', { className: 'dim-logo dim-logoWeixin', 'aria-hidden': 'true' },
    h(WeixinLogoGlyph));
}

function FeishuLogo() {
  return h('span', { className: 'dim-logo dim-logoFeishu', 'aria-hidden': 'true' },
    h(FeishuLogoGlyph));
}

function DingtalkLogo() {
  return h('span', { className: 'dim-logo dim-logoDingtalk', 'aria-hidden': 'true' },
    h(DingtalkLogoGlyph));
}

function QqLogo() {
  return h('span', { className: 'dim-logo dim-logoQq', 'aria-hidden': 'true' }, h(QqLogoGlyph));
}

function WecomLogo() {
  return h('span', { className: 'dim-logo dim-logoWecom', 'aria-hidden': 'true' }, h(WecomLogoGlyph));
}

function ChannelLogo({ channel }) {
  if (channel === 'weixin') return h(WeixinLogo);
  if (channel === 'feishu') return h(FeishuLogo);
  if (channel === 'dingtalk') return h(DingtalkLogo);
  if (channel === 'wecom') return h(WecomLogo);
  return h(QqLogo);
}

export function IMSettingsTab({ dingtalkRpcCall, feishuRpcCall, qqRpcCall, wecomRpcCall, weixinRpcCall }) {
  const [selected, setSelected] = React.useState('weixin');
  const active = CHANNELS.find((channel) => channel.id === selected) ?? CHANNELS[0];
  return h('section', { className: 'dim-page', 'aria-label': 'IM机器人设置' },
    h('header', { className: 'dim-title' },
      h('p', null, '通过扫码把机器人接入 DeepSeek Harness'),
    ),
    h('div', { className: 'dim-layout' },
      h('nav', { className: 'dim-rail', role: 'tablist', 'aria-label': 'IM 渠道' },
        CHANNELS.map((channel) => h('button', {
          key: channel.id,
          type: 'button',
          role: 'tab',
          id: `dim-tab-${channel.id}`,
          className: 'dim-channel',
          'aria-selected': channel.id === active.id,
          'aria-controls': `dim-panel-${channel.id}`,
          onClick: () => setSelected(channel.id),
        },
        h(ChannelLogo, { channel: channel.id }),
        h('span', { className: 'dim-channelCopy' },
          h('strong', null, channel.label),
        )))),
      h('div', { className: 'dim-divider', 'aria-hidden': 'true' }),
      h('main', {
        className: 'dim-panel',
        role: 'tabpanel',
        id: `dim-panel-${active.id}`,
        'aria-labelledby': `dim-tab-${active.id}`,
      }, active.id === 'weixin'
        ? h(WeixinSettingsTab, { rpcCall: weixinRpcCall })
        : active.id === 'feishu'
          ? h(FeishuSettingsTab, { rpcCall: feishuRpcCall })
          : active.id === 'dingtalk'
            ? h(DingtalkSettingsTab, { rpcCall: dingtalkRpcCall })
            : active.id === 'wecom'
              ? h(WecomSettingsTab, { rpcCall: wecomRpcCall })
              : h(QqSettingsTab, { rpcCall: qqRpcCall })),
    ),
  );
}

export function apply(ctx) {
  ctx.effect(() => {
    const disposers = [
      installFeishuStyles(),
      installWeixinStyles(),
      installWecomStyles(),
      installQqStyles(),
      installImStyles(),
    ];
    return () => {
      for (const dispose of disposers.reverse()) dispose();
    };
  }, 'im-settings: install combined channel styles');

  const feishuRpcCall = (endpoint, payload, signal) =>
    ctx.connection.rpc.call(FEISHU_RPC_CHANNEL, endpoint, payload, signal);
  const weixinRpcCall = (endpoint, payload, signal) =>
    ctx.connection.rpc.call(WEIXIN_RPC_CHANNEL, endpoint, payload, signal);
  const dingtalkRpcCall = (endpoint, payload, signal) =>
    ctx.connection.rpc.call(DINGTALK_RPC_CHANNEL, endpoint, payload, signal);
  const qqRpcCall = (endpoint, payload, signal) =>
    ctx.connection.rpc.call(QQ_RPC_CHANNEL, endpoint, payload, signal);
  const wecomRpcCall = (endpoint, payload, signal) =>
    ctx.connection.rpc.call(WECOM_RPC_CHANNEL, endpoint, payload, signal);

  ctx.slots.inject('settings.plugins.tab', () => ctx.slots.register({
    name: 'settings.plugins.tab',
    id: 'im',
    order: 20,
    label: 'IM机器人',
    inject: () => ({ dingtalkRpcCall, feishuRpcCall, qqRpcCall, wecomRpcCall, weixinRpcCall }),
  }, IMSettingsTab));
}
