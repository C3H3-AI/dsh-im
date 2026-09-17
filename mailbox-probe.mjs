import { ImapFlow } from 'imapflow';
const c = new ImapFlow({
  host: 'imap.qq.com', port: 993, secure: true, logger: false,
  auth: { user: '16991609@qq.com', pass: 'REDACTED_APP_PASSWORD' },
});
await c.connect();
console.log('=== 邮箱文件夹清单 ===');
const boxes = await c.list();
for (const b of boxes) {
  const name = b.path;
  try {
    const st = await c.status(name, { messages: true, uidNext: true });
    console.log(`  ${name.padEnd(24)} 邮件数: ${String(st.messages).padEnd(6)} uidNext: ${st.uidNext}`);
  } catch { console.log(`  ${name} (无法读取状态)`); }
}
// 查最新几封的主题
for (const box of ['INBOX', 'Sent Messages', 'Sent']) {
  try {
    await c.mailboxOpen(box);
    const uids = await c.search({ all: true }, { uid: true });
    if (!uids?.length) continue;
    const recent = uids.slice(-3);
    console.log(`\n=== ${box} 最新 ${recent.length} 封 ===`);
    for await (const m of c.fetch({ uid: recent.join(',') }, { uid: true, envelope: true }, { uid: true })) {
      console.log(`  UID ${m.uid} | ${String(m.envelope?.subject ?? '').slice(0, 60)}`);
    }
  } catch (e) { /* 文件夹不存在 */ }
}
await c.logout();
