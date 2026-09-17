import { readState, rpc } from './lib.mjs';
const BOT = 'email_9b295ef4019bfd69361b3151';
const s = readState(BOT);
console.log('  mailCursor:', str(s.mailCursor));
console.log('  seen ids:', (s.seenMessageIds||[]).map(x=>String(x).slice(0,26)));
function str(v){ return v === null || v === undefined ? 'null' : String(v).slice(0,44); }

// 现在 listMessages 会返回什么
const { readFileSync } = await import('node:fs');
const { AgentMailTransport } = await import('../src/channels/email/transports/agent-mail.mjs');
const yaml = readFileSync('/home/duola/.dsh/.credentials.yaml','utf8');
const line = yaml.split('\n').find(l => l.includes('DSH_EMAIL_PASSWORD_9B295EF'));
const cred = JSON.parse(/:\s*'(.*)'\s*$/.exec(line)[1]);
const api = new AgentMailTransport({ config: cred });
const msgs = await api.listMessages({ afterUid: s.mailCursor ?? 0, limit: 25,
  allowSenders: new Set(['16991609@qq.com']) });
console.log('');
console.log('  listMessages 返回:', msgs.length, '封');
for (const m of msgs) console.log('   -', str(m.uid), '|', String(m.subject).slice(0,24));
