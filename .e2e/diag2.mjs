import { readFileSync } from 'node:fs';
const UA='agently-cli/1.0.15 (windows/amd64; agent/workbuddy)';
const API='https://api.agent.qq.com';
const yaml = readFileSync('/home/duola/.dsh/.credentials.yaml','utf8');
const line = yaml.split('\n').find(l => l.includes('DSH_EMAIL_PASSWORD_9B295EF'));
const d = JSON.parse(/:\s*'(.*)'\s*$/.exec(line)[1]);
const H = { authorization:`Bearer ${d.accessToken}`, 'user-agent':UA };
const me = await (await fetch(`${API}/v1/me`, { headers:H })).json();
const aid = (me?.data?.aliases||[])[0]?.alias_id;

// 游标那封在哪
const TARGET = 'msg_cwXddwXvLIkmkAEX3DPwxIDhLP5NNX0m1WtuP7I7';
for (const dir of ['inbox','sent']) {
  const l = await (await fetch(`${API}/v1/aliases/${aid}/messages?limit=50&dir=${dir}`, { headers:H })).json();
  const msgs = l?.data || [];
  const found = msgs.findIndex(m => m.message_id === TARGET);
  console.log(`  ${dir}: ${msgs.length} 封 | 游标在其中: ${found >= 0 ? '第 '+found+' 位' : '不在'}`);
  console.log(`     分页: ${JSON.stringify(l?.pagination)}`);
}
