import assert from 'node:assert/strict';
import test from 'node:test';

import { WecomController } from '../../../src/channels/wecom/wecom-controller.mjs';
import {
  createWecomRpcHandler,
  WECOM_ENDPOINTS,
} from '../../../plugin-src/host/channels/wecom/rpc.mjs';

test('Enterprise WeChat QR success stores Secret off-config and starts its runtime', async () => {
  const values = new Map();
  const configs = [];
  let runtimeArgs;
  const controller = new WecomController({
    qrAuth: {
      start: async () => ({
        scode: 'host-only-code',
        verificationUrl: 'https://work.weixin.qq.com/ai/qc/auth?ticket=opaque',
        expiresAt: Date.now() + 10_000,
        pollIntervalMs: 500,
      }),
      poll: async () => ({ status: 'success', remoteBotId: 'remote-bot', secret: 'private-secret' }),
    },
    credentials: {
      resolve: async (ref) => values.has(ref) ? { value: values.get(ref) } : undefined,
      set: async (ref, value) => values.set(ref, value),
      unset: async (ref) => values.delete(ref),
    },
    configStore: {
      list: () => [...configs],
      get: (id) => configs.find((value) => value.botId === id) ?? null,
      getByRemoteBotId: (id) => configs.find((value) => value.remoteBotId === id) ?? null,
      save: async (value) => { configs.splice(0, configs.length, value); },
      remove: async () => null,
    },
    createRuntime: async (args) => {
      runtimeArgs = args;
      return {
        status: { ready: true, wecomConnectionState: 'connected', harnessReachable: true },
        start: async () => {},
        stop: async () => {},
      };
    },
  });
  const started = await controller.startProvisioning();
  const completed = await controller.registrationStatus(started.attemptId);
  assert.equal(completed.status, 'connected');
  const status = controller.status();
  assert.equal(status.bots[0].connected, true);
  assert.equal(values.get(configs[0].secretRef), 'private-secret');
  assert.equal(runtimeArgs.secret, 'private-secret');
  assert.doesNotMatch(JSON.stringify(status), /private-secret|secretRef|remote-bot|host-only-code/);
});

test('Enterprise WeChat RPC encodes the QR on Host and strips every authorization field', async () => {
  const handler = createWecomRpcHandler({
    status: () => ({ bots: [], totals: { configured: 0, connected: 0 } }),
    startProvisioning: async () => ({
      attemptId: 'attempt_1',
      status: 'pending',
      verificationUrl: 'https://work.weixin.qq.com/ai/qc/auth?ticket=opaque',
      scode: 'never-public',
      secret: 'never-public',
      remoteBotId: 'never-public',
      expiresAt: Date.now() + 1_000,
    }),
    registrationStatus: async () => null,
    cancelProvisioning: async () => ({}),
    reconnectBot: async () => ({}),
    deleteBot: async () => ({}),
  }, { encodeQr: async () => 'data:image/png;base64,YWJjZA==' });
  const result = await handler(WECOM_ENDPOINTS.beginProvisioning, { locale: 'zh-CN' });
  assert.equal(result.ok, true);
  assert.equal(result.value.qrCodeDataUrl, 'data:image/png;base64,YWJjZA==');
  assert.doesNotMatch(JSON.stringify(result), /work\.weixin|never-public|remoteBotId|scode|secret/);
});
