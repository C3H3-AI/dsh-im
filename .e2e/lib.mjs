import nodemailer from 'nodemailer';
export const QQ = '16991609@qq.com';
export async function send(o) {
  const t = nodemailer.createTransport({ host:'smtp.qq.com', port:587, secure:false, requireTLS:true,
    auth:{ user:QQ, pass:'REDACTED_APP_PASSWORD' } });
  return (await t.sendMail({ from: QQ, ...o })).messageId;
}
