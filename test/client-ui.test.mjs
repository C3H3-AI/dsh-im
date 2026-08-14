import assert from 'node:assert/strict';
import test from 'node:test';

import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { IMSettingsTab } from '../plugin-src/client/index.js';

test('IM settings renders three compact logo channel tabs without enable switches', () => {
  const markup = renderToStaticMarkup(React.createElement(IMSettingsTab, {
    feishuRpcCall: async () => ({ ok: true, value: {} }),
    weixinRpcCall: async () => ({ ok: true, value: {} }),
    dingtalkRpcCall: async () => ({ ok: true, value: {} }),
  }));

  assert.match(markup, /IM机器人/);
  assert.match(markup, /通过扫码把机器人接入 DeepSeek Harness/);
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
