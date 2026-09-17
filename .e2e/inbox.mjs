import { readFileSync } from 'node:fs';
const UA='agently-cli/1.0.15 (windows/amd64; agent/workbuddy)';
const API='https://api.agent.qq.com';
const yaml = readFileSync('/home/duola/.dsh/.credentials.yaml','utf8');
const line = yaml.split('\n').find(l => l.includes('DSH_EMAIL_PASSWORD_9B295EF'));
const d = JSON.parse(/:\s*'(.*)'\s*$/.exec(line)[1]);
const H = { authorization:`Bearer ${d.accessToken}`, 'user-agent':UA };
const me = await (await fetch(`${API}/v1/me`, { headers:H })).json();
const aid = (me?.data?.aliases||[])[0]?.alias_id;
const l = await (await fetch(`${API}/v1/aliases/${aid}/messages?limit=4&dir=inbox`, { headers:H })).json();
for (const m of (l?.data||[])) {
  console.log('  -', String(m.subject||'').slice(0,28), '|', String(m.created_at||'').slice(11,19));
}
