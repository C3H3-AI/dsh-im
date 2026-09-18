import { send } from './lib.mjs';
import { readFileSync } from 'node:fs';
const tag = readFileSync('/tmp/tag.txt','utf8').trim();
const m1 = await send({ to:'c3h3dsh@agent.qq.com', subject:`链路测试 ${tag}`,
  text:`自动化测试（${tag}）。请回复"收到"两个字。` });
console.log('  → c3h3dsh | tag:', tag);
const m2 = await send({ to:'diyhome@agent.qq.com', subject:`链路测试 ${tag}`,
  text:`自动化测试（${tag}）。请回复"收到"两个字。` });
console.log('  → diyhome | 已发送');
