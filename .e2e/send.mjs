import { send } from './lib.mjs';
import { readFileSync } from 'node:fs';
const tag = readFileSync('/tmp/tag.txt','utf8').trim();
await send({ to:'diyhome@agent.qq.com', subject:`diyhome 测试 ${tag}`,
  text:`测试（${tag}）。请只回复"收到"两个字。` });
console.log('  已发送 → diyhome | tag:', tag);
