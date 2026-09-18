import { send } from './lib.mjs';
import { readFileSync } from 'node:fs';
const tag = readFileSync('/tmp/tag.txt','utf8').trim();
for (const to of ['c3h3dsh@agent.qq.com', 'diyhome@agent.qq.com']) {
  await send({ to, subject:`最终验证 ${tag}`, text:`测试（${tag}）。请只回复"收到"。` });
  console.log('  已发送 →', to);
}
