import assert from 'node:assert/strict';
import test from 'node:test';

import { QqController } from '../../../src/channels/qq/qq-controller.mjs';
import { QQ_ENDPOINTS, createQqRpcHandler } from '../../../plugin-src/host/channels/qq/rpc.mjs';

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

test('QQ QR success stores the secret off-config and starts a scanner-owned runtime', async () => {
  const qr = deferred();
  let callbacks;
  const values = new Map();
  const configs = [];
  let runtimeArgs;
  const controller = new QqController({
    qrAuth: {
      start(next) {
        callbacks = next;
        queueMicrotask(() => next.onQrDisplayed('https://q.qq.com/connect?task=opaque'));
        return () => {};
      },
    },
    credentials: {
      resolve: async (ref) => values.has(ref) ? { value: values.get(ref) } : undefined,
      set: async (ref, value) => values.set(ref, value),
      unset: async (ref) => values.delete(ref),
    },
    configStore: {
      list: () => [...configs],
      get: (id) => configs.find((value) => value.botId === id) ?? null,
      getByAppId: (id) => configs.find((value) => value.appId === id) ?? null,
      save: async (value) => { configs.splice(0, configs.length, value); },
      remove: async () => null,
    },
    createRuntime: async (args) => {
      runtimeArgs = args;
      return { status: { ready: true, qqConnectionState: 'connected', harnessReachable: true }, start: async () => {}, stop: async () => {} };
    },
  });
  const started = await controller.startProvisioning();
  assert.equal(started.status, 'pending');
  callbacks.onSuccess([{ appId: 'app-id', appSecret: 'private-secret', userOpenid: 'scanner-openid' }]);
  while (controller.registrationStatus(started.attemptId).status !== 'connected') await new Promise((resolve) => setImmediate(resolve));
  const status = controller.status();
  assert.equal(status.bots[0].connected, true);
  assert.equal(configs[0].ownerUserOpenid, 'scanner-openid');
  assert.equal(values.get(configs[0].secretRef), 'private-secret');
  assert.equal(runtimeArgs.appSecret, 'private-secret');
  assert.doesNotMatch(JSON.stringify(status), /private-secret|scanner-openid|secretRef/);
  qr.resolve();
});

test('QQ RPC turns the host-only QR URL into an image and strips credential fields', async () => {
  const handler = createQqRpcHandler({
    status: () => ({ bots: [], totals: { configured: 0, connected: 0 } }),
    startProvisioning: async () => ({
      attemptId: 'attempt_1', status: 'pending', verificationUrl: 'https://q.qq.com/opaque',
      appSecret: 'never-public', ownerUserOpenid: 'never-public', expiresAt: Date.now() + 1_000,
    }),
    registrationStatus: () => null,
    cancelProvisioning: async () => ({}),
    reconnectBot: async () => ({}),
    deleteBot: async () => ({}),
  }, { encodeQr: async () => 'data:image/png;base64,YWJjZA==' });
  const result = await handler(QQ_ENDPOINTS.beginProvisioning, { locale: 'zh-CN' });
  assert.equal(result.ok, true);
  assert.equal(result.value.qrCodeDataUrl, 'data:image/png;base64,YWJjZA==');
  assert.doesNotMatch(JSON.stringify(result), /q\.qq\.com|never-public|ownerUserOpenid|appSecret/);
});
