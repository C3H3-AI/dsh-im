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
];
await Promise.all(required.map((path) => access(resolve(root, path))));

const [client, host, patch, manifestText, executable] = await Promise.all([
  readFile(resolve(root, 'lib/client.js'), 'utf8'),
  readFile(resolve(root, 'lib/index.js'), 'utf8'),
  readFile(resolve(root, 'cordis.patch.yml'), 'utf8'),
  readFile(resolve(root, 'package.json'), 'utf8'),
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
if (!host.includes('@xmanrui/dsh-feishu')
  || !host.includes('@xmanrui/dsh-weixin')
  || !host.includes('@xmanrui/dsh-dingtalk')) {
  throw new Error('host bundle does not compose all three channel providers');
}
if (!patch.includes("name: '@xmanrui/dsh-im'") || /dsh-(?:feishu|weixin|dingtalk)/.test(patch)) {
  throw new Error('bundle patch must activate only dsh-im');
}
for (const name of ['@xmanrui/dsh-feishu', '@xmanrui/dsh-weixin', '@xmanrui/dsh-dingtalk']) {
  const spec = manifest.dependencies?.[name];
  if (typeof spec !== 'string'
    || !/^https:\/\/github\.com\/[^/]+\/[^/]+\/archive\/[0-9a-f]{40}\.tar\.gz$/.test(spec)) {
    throw new Error(`${name} must use a pinned public HTTPS archive`);
  }
}
if ((executable.mode & 0o111) === 0) throw new Error('dsh-im CLI is not executable');
if (/private-bot-token|must-be-rolled-back|DEEPSEEK_API_KEY=/.test(client + host)) {
  throw new Error('built artifacts contain a test or environment secret marker');
}

console.log('Verified dsh-im package artifacts.');
