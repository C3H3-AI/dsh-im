import { AGENT, send } from './lib.mjs';
const tag = `E2E-${Date.now().toString().slice(-6)}`;
const mid = await send({ to: AGENT, subject: `收信测试 ${tag}`, text: '自动化测试：请回复"收到"。' });
console.log('  tag:', tag);
console.log('  messageId:', mid);
