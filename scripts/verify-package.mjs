import { access, readFile, stat } from 'node:fs/promises';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const required = [
  'lib/index.js',
  'lib/client.js',
  'bin/dsh-im.mjs',
  'cordis.patch.yml',
  'README.md',
  'THIRD_PARTY_NOTICES.md',
  'plugin-src/client/channels/dingtalk/index.js',
  'plugin-src/host/channels/feishu/index.mjs',
  'plugin-src/host/channels/weixin/index.mjs',
  'plugin-src/host/channels/dingtalk/index.mjs',
  'plugin-src/host/channels/qq/index.mjs',
  'plugin-src/host/channels/wecom/index.mjs',
  'plugin-src/host/channels/telegram/index.mjs',
  'plugin-src/host/channels/discord/index.mjs',
  'src/channels/feishu/feishu-runtime.mjs',
  'src/channels/weixin/weixin-runtime.mjs',
  'src/channels/dingtalk/dingtalk-runtime.mjs',
  'src/channels/qq/qq-runtime.mjs',
  'src/channels/wecom/wecom-runtime.mjs',
  'src/channels/telegram/telegram-runtime.mjs',
  'src/channels/discord/discord-runtime.mjs',
];
await Promise.all(required.map((path) => access(resolve(root, path))));

const [client, host, patch, manifestText, lockText, hostSource, clientSource, executable] = await Promise.all([
  readFile(resolve(root, 'lib/client.js'), 'utf8'),
  readFile(resolve(root, 'lib/index.js'), 'utf8'),
  readFile(resolve(root, 'cordis.patch.yml'), 'utf8'),
  readFile(resolve(root, 'package.json'), 'utf8'),
  readFile(resolve(root, 'package-lock.json'), 'utf8'),
  readFile(resolve(root, 'plugin-src/host/index.mjs'), 'utf8'),
  readFile(resolve(root, 'plugin-src/client/index.js'), 'utf8'),
  stat(resolve(root, 'bin/dsh-im.mjs')),
]);
const manifest = JSON.parse(manifestText);

if (!client.includes('id: "@xmanrui/dsh-im"')) {
  throw new Error('client bundle does not register the dsh-im loader id');
}
if (!client.includes('id: "im"') || !client.includes('label: "IM\\u673A\\u5668\\u4EBA"')) {
  throw new Error('client bundle does not register the IM机器人 settings tab');
}
if ((client.match(/ctx\.slots\.inject\("settings\.plugins\.tab"/g) ?? []).length !== 1) {
  throw new Error('client bundle must register exactly one settings tab');
}
if (/role:\s*["']switch|type:\s*["']checkbox/.test(client)) {
  throw new Error('client bundle contains a channel enable switch');
}
if (!client.includes('container-type: inline-size')
  || !client.includes('@container (max-width: 680px)')) {
  throw new Error('client bundle does not contain the narrow-panel DingTalk QR layout');
}
for (const marker of ['/feishu', '/weixin', '/dingtalk', '/wecom', '/qq', '/telegram', '/discord']) {
  if (!host.includes(marker)) {
    throw new Error(`host bundle does not contain the internal ${marker} RPC provider`);
  }
}
if (/@xmanrui\/dsh-(?:feishu|weixin|dingtalk)/.test(host)) {
  throw new Error('host bundle still imports an external channel plugin');
}
if (/@xmanrui\/dsh-(?:feishu|weixin|dingtalk)/.test(
  manifestText + lockText + hostSource + clientSource,
)) {
  throw new Error('source or package metadata still depends on an external channel plugin');
}
if (!patch.includes("name: '@xmanrui/dsh-im'") || /dsh-(?:feishu|weixin|dingtalk)/.test(patch)) {
  throw new Error('bundle patch must activate only dsh-im');
}
for (const name of ['@xmanrui/dsh-feishu', '@xmanrui/dsh-weixin', '@xmanrui/dsh-dingtalk']) {
  if (manifest.dependencies?.[name]) {
    throw new Error(`${name} must not remain an external dependency`);
  }
}
const directDependencies = {
  '@larksuiteoapi/node-sdk': '1.73.0',
  'dingtalk-stream': '2.1.4',
  '@tencent-connect/qqbot-connector': '1.2.0',
  '@tencent-connect/qqbot-nodejs': '1.0.4',
  '@wecom/aibot-node-sdk': '1.0.7',
  qrcode: '1.5.4',
};
for (const [name, version] of Object.entries(directDependencies)) {
  if (manifest.dependencies?.[name] !== version) {
    throw new Error(`${name} must be a pinned direct dependency at ${version}`);
  }
}
if ((executable.mode & 0o111) === 0) throw new Error('dsh-im CLI is not executable');
if (/private-bot-token|must-be-rolled-back|DEEPSEEK_API_KEY=/.test(client + host)) {
  throw new Error('built artifacts contain a test or environment secret marker');
}

console.log('Verified dsh-im package artifacts.');
