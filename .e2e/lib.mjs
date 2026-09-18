import nodemailer from 'nodemailer';
import { readFileSync } from 'node:fs';
export const QQ = '16991609@qq.com';
export function t() {
  return nodemailer.createTransport({ host:'smtp.qq.com', port:587, secure:false, requireTLS:true,
    auth:{ user:QQ, pass:'REDACTED_APP_PASSWORD' } });
}
export async function send(o) {
  const i = await t().sendMail({ from: QQ, ...o });
  return i.messageId;
}
export async function rpc(method, payload) {
  const cookie = readFileSync('/tmp/cookie.txt','utf8').trim();
  const r = await fetch('http://127.0.0.1:3080/api/dsh-im/email', {
    method:'POST', headers:{ cookie, 'content-type':'application/json' },
    body: JSON.stringify({ type:'client-request', rpcId:`t-${Date.now()}`,
      method:'dsh-im/email', payload:{ method, payload } }),
  });
  return (await r.json()).result;
}
