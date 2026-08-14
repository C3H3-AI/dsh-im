import assert from 'node:assert/strict';
import test from 'node:test';

import { createImHostPlugin, inject, name } from '../plugin-src/host/index.mjs';

test('Host composes Feishu and Weixin inside one plugin context', async () => {
  const calls = [];
  const plugin = createImHostPlugin({
    applyFeishu: async (ctx, config) => calls.push(['feishu', ctx, config]),
    applyWeixin: async (ctx, config) => calls.push(['weixin', ctx, config]),
  });
  const ctx = { marker: 'shared-context' };
  const config = { feishu: { domain: 'feishu' }, weixin: { timeout: 30 } };

  await plugin.apply(ctx, config);

  assert.equal(name, 'dsh-im-host');
  assert.deepEqual(inject, ['connection', 'credentials', 'webServer']);
  assert.deepEqual(calls, [
    ['feishu', ctx, config.feishu],
    ['weixin', ctx, config.weixin],
  ]);
});

test('Host does not start Weixin when Feishu activation fails', async () => {
  let weixinStarted = false;
  const plugin = createImHostPlugin({
    applyFeishu: async () => { throw new Error('feishu unavailable'); },
    applyWeixin: async () => { weixinStarted = true; },
  });

  await assert.rejects(() => plugin.apply({}, {}), /feishu unavailable/);
  assert.equal(weixinStarted, false);
});
