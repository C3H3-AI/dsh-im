import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  normalizeAddress,
  parseMessageIds,
  resolveThreadKey,
  stripQuotedHistory,
} from '../../../src/channels/email/email-api.mjs';
import {
  EMAIL_PROVIDERS,
  EmailConfigStore,
  maskEmailBotId,
  normalizeEmailAccessPolicy,
  normalizeEmailAddress,
  normalizeEmailAllowedSenders,
} from '../../../src/channels/email/config-store.mjs';
import { EmailStateStore } from '../../../src/channels/email/state-store.mjs';
import { normalizeEmail, replySubject } from '../../../src/channels/email/email-runtime.mjs';

const BOT = 'dsh@qq.com';

function parsedMail(overrides = {}) {
  return {
    messageId: '<m1@mail.example>',
    from: { value: [{ address: 'user@example.com', name: 'User' }] },
    subject: 'Do the thing',
    text: 'Please do the thing',
    ...overrides,
  };
}

test('stripQuotedHistory removes English and Chinese reply history', () => {
  assert.equal(
    stripQuotedHistory('New instruction\n\nOn Mon, Jan 1 2026 at 10:00, A <a@b.c> wrote:\n> old'),
    'New instruction',
  );
  assert.equal(
    stripQuotedHistory('新指令\n\n在 2026年1月1日 写道：\n> 旧内容'),
    '新指令',
  );
  assert.equal(stripQuotedHistory('Plain body only'), 'Plain body only');
  // A leading "From:" line marks the start of a forwarded block.
  assert.equal(stripQuotedHistory('Body\n\nFrom: someone@example.com'), 'Body');
});

test('parseMessageIds extracts bracketed ids and tolerates missing headers', () => {
  assert.deepEqual(parseMessageIds('<a@b.c> <d@e.f>'), ['<a@b.c>', '<d@e.f>']);
  assert.deepEqual(parseMessageIds(['<a@b.c>', '<d@e.f>']), ['<a@b.c>', '<d@e.f>']);
  assert.deepEqual(parseMessageIds(undefined), []);
  assert.deepEqual(parseMessageIds('no ids here'), []);
});

test('resolveThreadKey joins a reply chain and opens a new thread otherwise', () => {
  const conversationMap = new Map([['<root@mail>', 'email:thread-1']]);
  assert.equal(
    resolveThreadKey({ messageId: '<r@mail>', references: '<root@mail>', conversationMap }),
    'email:thread-1',
  );
  assert.equal(
    resolveThreadKey({ messageId: '<r@mail>', inReplyTo: '<root@mail>', conversationMap }),
    'email:thread-1',
  );
  assert.equal(
    resolveThreadKey({ messageId: '<fresh@mail>', conversationMap }),
    '<fresh@mail>',
  );
});

test('normalizeAddress lowercases and unwraps display names', () => {
  assert.equal(normalizeAddress('User Name <USER@Example.COM>'), 'user@example.com');
  assert.equal(normalizeAddress('  bare@example.com '), 'bare@example.com');
});

test('normalizeEmail builds a bridge message and a threaded reply target', () => {
  const state = new EmailStateStore(join(tmpdir(), 'unused-email-state.json'));
  const message = normalizeEmail(parsedMail(), { address: BOT, state });
  assert.equal(message.senderId, 'user@example.com');
  assert.equal(message.kind, 'direct');
  // The subject and sender are prepended so the model sees them.
  assert.match(message.content, /^Subject: Do the thing$/m);
  assert.match(message.content, /^From: User <user@example\.com>$/m);
  assert.match(message.content, /Please do the thing$/);
  assert.equal(message.conversationId, '<m1@mail.example>');
  assert.equal(message.replyTarget.to, 'user@example.com');
  assert.equal(message.replyTarget.subject, 'Re: Do the thing');
  assert.equal(message.replyTarget.messageId, '<m1@mail.example>');
  assert.deepEqual(message.replyTarget.references, ['<m1@mail.example>']);
});

test('normalizeEmail keeps a reply inside the existing conversation', () => {
  const state = new EmailStateStore(join(tmpdir(), 'unused-email-state-2.json'));
  const first = normalizeEmail(parsedMail(), { address: BOT, state });
  for (const id of [first.messageId, ...first.replyTarget.references]) {
    state.rememberThreadId(id, first.conversationId);
  }
  const reply = normalizeEmail(parsedMail({
    messageId: '<m2@mail.example>',
    references: '<m1@mail.example>',
    subject: 'Re: Do the thing',
    text: 'One more thing',
  }), { address: BOT, state });
  assert.equal(reply.conversationId, first.conversationId);
});

test('normalizeEmail drops self-sent, automated, and empty mail', () => {
  const state = new EmailStateStore(join(tmpdir(), 'unused-email-state-3.json'));
  const selfSent = normalizeEmail(parsedMail({
    from: { value: [{ address: 'DSH@QQ.com' }] },
  }), { address: BOT, state });
  assert.equal(selfSent, null, 'mail from the mailbox itself must not loop back');
  const automated = normalizeEmail(parsedMail({
    from: { value: [{ address: 'noreply@shop.example' }] },
  }), { address: BOT, state });
  assert.equal(automated, null, 'no-reply senders must be ignored');
  const empty = normalizeEmail(parsedMail({ text: '   ' }), { address: BOT, state });
  assert.equal(empty, null, 'a body-less mail must be ignored');
});

test('normalizeEmail still forwards a body-less mail that carries an attachment', () => {
  const state = new EmailStateStore(join(tmpdir(), 'unused-email-state-4.json'));
  const message = normalizeEmail(parsedMail({
    text: '',
    attachments: [{ filename: 'report.csv', size: 3, contentType: 'text/csv', content: Buffer.from('a,b') }],
  }), { address: BOT, state });
  assert.ok(message, 'an attachment-only mail is still actionable');
  assert.equal(message.files.length, 1);
  assert.equal(message.files[0].name, 'report.csv');
});

test('replySubject applies exactly one Re: prefix', () => {
  assert.equal(replySubject('Hello'), 'Re: Hello');
  assert.equal(replySubject('Re: Hello'), 'Re: Hello');
  assert.equal(replySubject('RE: Hello'), 'RE: Hello');
  assert.equal(replySubject(''), 'Re: (no subject)');
});

test('email addresses are normalized and validated', () => {
  assert.equal(normalizeEmailAddress('  User@QQ.COM '), 'user@qq.com');
  for (const invalid of ['', 'not-an-address', 'no-at.example', 'a@b', 'a b@c.d']) {
    assert.throws(() => normalizeEmailAddress(invalid), TypeError, `expected ${invalid} to be rejected`);
  }
});

test('the sender allowlist validates, dedupes, and lowercases', () => {
  assert.deepEqual(
    [...normalizeEmailAllowedSenders(['A@QQ.com', 'b@163.COM', 'a@qq.com'])],
    ['a@qq.com', 'b@163.com'],
  );
  assert.deepEqual([...normalizeEmailAllowedSenders(undefined)], []);
  assert.throws(() => normalizeEmailAllowedSenders('nope'), TypeError);
  assert.throws(() => normalizeEmailAllowedSenders(['bad']), TypeError);
});

test('email access policy defaults to an empty allowlist', () => {
  assert.deepEqual([...normalizeEmailAccessPolicy({}).allowedSenders], []);
  assert.deepEqual(
    [...normalizeEmailAccessPolicy({ allowedSenders: ['x@y.z'] }).allowedSenders],
    ['x@y.z'],
  );
});

test('maskEmailBotId hides the local part but keeps the domain readable', () => {
  assert.equal(maskEmailBotId('zhangsan@qq.com'), 'zh******@qq.com');
  assert.equal(maskEmailBotId('a@163.com'), 'a*@163.com');
});

test('provider presets expose IMAP and SMTP endpoints', () => {
  assert.equal(EMAIL_PROVIDERS.qq.imapHost, 'imap.qq.com');
  assert.equal(EMAIL_PROVIDERS.qq.smtpPort, 465);
  assert.equal(EMAIL_PROVIDERS['163'].smtpHost, 'smtp.163.com');
  assert.equal(EMAIL_PROVIDERS.gmail.imapPort, 993);
});

test('EmailConfigStore persists mailbox settings and reloads them', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-email-config-'));
  const path = join(dir, 'config.json');
  try {
    const store = await new EmailConfigStore(path).load();
    await store.save({
      platformId: 'user@qq.com',
      name: 'user@qq.com',
      provider: 'qq',
      allowedSenders: ['boss@example.com'],
    });
    const reloaded = await new EmailConfigStore(path).load();
    const [bot] = reloaded.list();
    assert.equal(bot.platformId, 'user@qq.com');
    assert.equal(bot.imapHost, 'imap.qq.com');
    assert.equal(bot.smtpPort, 465);
    assert.deepEqual([...bot.allowedSenders], ['boss@example.com']);
    // A partial save must keep the previously stored fields.
    await reloaded.save({ platformId: 'user@qq.com', name: 'user@qq.com', allowedSenders: ['other@example.com'] });
    const [updated] = (await new EmailConfigStore(path).load()).list();
    assert.equal(updated.imapHost, 'imap.qq.com');
    assert.deepEqual([...updated.allowedSenders], ['other@example.com']);
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});

test('EmailStateStore bounds the remembered thread-id map', () => {
  const state = new EmailStateStore(join(tmpdir(), 'unused-email-state-5.json'));
  for (let index = 0; index < 2_100; index += 1) {
    state.rememberThreadId(`<m${index}@mail>`, `email:thread-${index}`);
  }
  // The newest ids survive; the oldest are evicted.
  assert.equal(state.conversationForThreadId('<m2099@mail>'), 'email:thread-2099');
  assert.equal(state.conversationForThreadId('<m0@mail>'), null);
  assert.equal(state.threadMap.size, 2_000);
});

test('EmailController reads the mailbox secret from the credential wrapper', async () => {
  // Regression guard: parameters.resolve() returns a wrapper whose payload is
  // on `.value`. Parsing the wrapper itself threw and was swallowed, so the
  // mailbox looked configured while its runtime never started.
  const { EmailController } = await import('../../../src/channels/email/email-controller.mjs');
  const dir = await mkdtemp(join(tmpdir(), 'dsh-email-cred-'));
  try {
    const store = await new EmailConfigStore(join(dir, 'config.json')).load();
    await store.save({
      platformId: 'user@qq.com',
      name: 'user@qq.com',
      provider: 'qq',
      allowedSenders: ['boss@example.com'],
    });
    const [bot] = store.list();
    const started = [];
    const controller = new EmailController({
      credentials: {
        // Mirror the real provider: a wrapper object, not a bare string.
        async resolve() { return { value: JSON.stringify({ address: 'user@qq.com', password: 'app-pass' }) }; },
        async set() {},
        async unset() {},
      },
      configStore: store,
      logger: { warn() {}, info() {}, error() {}, log() {} },
      createRuntime: async ({ botId, config, token }) => {
        started.push({ botId, password: token });
        return { start: async () => {}, stop: async () => {}, status: { ready: true, connectionState: 'connected' } };
      },
    });
    await controller.initialize();
    assert.equal(started.length, 1, 'the mailbox runtime must start when the secret resolves');
    assert.equal(started[0].password, 'app-pass');
    const status = controller.status();
    assert.deepEqual(status.totals, { configured: 1, connected: 1 });
    assert.equal(status.bots[0].connected, true);
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});

test('outbound artifacts use the shared materialized field names', async () => {
  // The artifact layer materializes files as { fileName, mediaType, bytes };
  // reading { name, content } instead silently sent an unnamed empty attachment.
  const source = await readFile(
    new URL('../../../src/channels/email/email-runtime.mjs', import.meta.url),
    'utf8',
  );
  const mapping = source.slice(source.indexOf('#attachmentFrom('), source.indexOf('async sendFile'));
  assert.match(mapping, /file\?\.fileName/, 'the artifact file name lives on .fileName');
  assert.match(mapping, /file\?\.bytes/, 'the artifact payload lives on .bytes');
  assert.match(mapping, /file\?\.mediaType/, 'the artifact type lives on .mediaType');
  // .content may only appear as a trailing fallback, never as the primary read.
  assert.match(mapping, /file\?\.bytes \?\? /, 'bytes must be the primary payload read');
});

test('inbound attachments declare mediaType for the shared file layer', async () => {
  // inbound-file reads `mediaType`; a `mimeType` key is ignored.
  const state = new EmailStateStore(join(tmpdir(), 'unused-email-state-6.json'));
  const message = normalizeEmail({
    messageId: '<attach@mail>',
    from: { value: [{ address: 'boss@example.com' }] },
    subject: 'Report',
    text: 'See attached',
    attachments: [{
      filename: 'sales.csv', size: 8, contentType: 'text/csv',
      content: Buffer.from('a,b\n1,2\n'),
    }],
  }, { address: BOT, state });
  assert.equal(message.files.length, 1);
  assert.equal(message.files[0].mediaType, 'text/csv');
  assert.equal(message.files[0].mimeType, undefined, 'mimeType is not the field the layer reads');
});

test('polling only downloads mail from allowlisted senders', async () => {
  // The monitored mailbox also receives ordinary personal mail. Its body must
  // never be requested, so filtering happens on the envelope before the source
  // fetch — not after the message is already downloaded.
  const source = await readFile(
    new URL('../../../src/channels/email/email-api.mjs', import.meta.url),
    'utf8',
  );
  const listStart = source.indexOf('async listMessages');
  const list = source.slice(listStart, source.indexOf('await this.#imap.mailboxOpen(mailbox', listStart));
  const envelopeStage = list.indexOf('allowSenders');
  const sourceFetch = list.indexOf('this.#fetchSource');
  assert.ok(envelopeStage > 0, 'listMessages must consult the sender allowlist');
  assert.ok(sourceFetch > envelopeStage, 'the allowlist must be applied before the body fetch');
  // Every body fetch sits in the second pass, after the envelope loop closes.
  assert.match(list, /for \(const uid of accepted\)/, 'bodies are fetched from the accepted list only');
});

test('changing the mailbox allowlist pushes the matching access policy', async () => {
  // The mailbox allowlist and the Harness access policy are separate stores.
  // Updating only the allowlist left the policy holding the old senders, so
  // the channel kept rejecting every new sender even though it was listed.
  const { EmailController } = await import('../../../src/channels/email/email-controller.mjs');
  const dir = await mkdtemp(join(tmpdir(), 'dsh-email-policy-'));
  try {
    const store = await new EmailConfigStore(join(dir, 'config.json')).load();
    await store.save({
      platformId: 'bot@qq.com', name: 'bot@qq.com', provider: 'qq',
      allowedSenders: ['old@example.com'],
    });
    const [bot] = store.list();
    const synced = [];
    const controller = new EmailController({
      credentials: {
        async resolve() { return { value: JSON.stringify({ address: 'bot@qq.com', password: 'p' }) }; },
        async set() {}, async unset() {},
      },
      configStore: store,
      logger: { warn() {}, info() {}, error() {}, log() {} },
      createRuntime: async () => ({ start: async () => {}, stop: async () => {}, status: {} }),
      syncAccessPolicy: async (botId, policy) => { synced.push({ botId, policy }); },
    });
    await controller.updateMailboxSettings(bot.botId, {
      allowedSenders: ['new@example.com', 'other@example.com'],
    });
    assert.equal(synced.length, 1, 'the access policy must be synced when the allowlist changes');
    assert.deepEqual(
      synced[0].policy.direct.allowlist.users.map((u) => u.id),
      ['new@example.com', 'other@example.com'],
    );
    assert.equal(synced[0].policy.direct.mode, 'allowlist');
    assert.equal(synced[0].policy.group.mode, 'allowlist');
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});

test('mail routing follows sender binding, then account binding, then a new session', async () => {
  // Three levels of freedom: a per-sender pin, an account-wide pin, or nothing
  // (each mail thread starts its own Harness session).
  const state = new EmailStateStore(join(tmpdir(), 'unused-email-binding.json'));
  const mail = (address, id) => ({
    messageId: `<${id}@x>`,
    from: { value: [{ address }] },
    to: { value: [{ address: BOT }] },
    subject: id,
    text: 'hi',
  });

  // Level 3: unbound — each message maps to its own thread.
  assert.notEqual(
    normalizeEmail(mail('a@x.com', 'm1'), { address: BOT, state }).conversationId,
    normalizeEmail(mail('a@x.com', 'm2'), { address: BOT, state }).conversationId,
  );

  // Level 2: account-wide pin — every sender shares one conversation.
  await state.setEmailBindings({ account: 'session-FIXED', senders: {} });
  assert.equal(
    normalizeEmail(mail('a@x.com', 'm3'), { address: BOT, state }).conversationId,
    'bound:session-FIXED',
  );
  assert.equal(
    normalizeEmail(mail('b@x.com', 'm4'), { address: BOT, state }).conversationId,
    'bound:session-FIXED',
  );

  // Level 1: a sender pin wins over the account pin.
  await state.setEmailBindings({ account: 'session-FIXED', senders: { 'b@x.com': 'session-VIP' } });
  assert.equal(
    normalizeEmail(mail('a@x.com', 'm5'), { address: BOT, state }).conversationId,
    'bound:session-FIXED',
  );
  assert.equal(
    normalizeEmail(mail('b@x.com', 'm6'), { address: BOT, state }).conversationId,
    'bound:session-VIP',
  );
});

test('a bound conversation resolves to the pinned session instead of creating one', async () => {
  // Without the mapping the resolver misses the key and starts a fresh session,
  // so the pin would appear to save but have no effect.
  const state = new EmailStateStore(join(tmpdir(), 'unused-email-binding-2.json'));
  await state.setEmailBindings({ account: 'session-ABC', senders: { 'vip@x.com': 'session-VIP' } });
  assert.equal(state.sessionFor('direct:bound:session-ABC'), 'session-ABC');
  // The bridge prefixes the chat kind, so the marker is not at offset 0.
  assert.equal(state.sessionFor('direct:bound:session-VIP'), 'session-VIP');
  assert.equal(state.sessionFor('direct:<thread@x>'), null);
});

test('session bindings survive a reload', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-email-bind-'));
  const path = join(dir, 'state.json');
  try {
    const first = await new EmailStateStore(path).load();
    await first.setEmailBindings({ account: 'session-1', senders: { 'a@x.com': 'session-2' } });
    const reloaded = await new EmailStateStore(path).load();
    assert.equal(reloaded.boundSessionFor('a@x.com'), 'session-2');
    assert.equal(reloaded.boundSessionFor('other@x.com'), 'session-1');
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});

test('the model sees the subject and the recipient lists', async () => {
  // Only the body used to be forwarded, so an instruction written in the
  // subject was dropped and a message with other recipients looked private.
  const state = new EmailStateStore(join(tmpdir(), 'unused-email-headers.json'));
  const message = normalizeEmail({
    messageId: '<hdr@x>',
    from: { value: [{ address: 'boss@corp.com', name: '老板' }] },
    to: { value: [{ address: BOT }] },
    cc: { value: [{ address: 'team@corp.com', name: '团队' }] },
    subject: '统计销售数据',
    text: '统计上个月的数据',
  }, { address: BOT, state });
  assert.match(message.content, /^Subject: 统计销售数据$/m);
  assert.match(message.content, /^From: 老板 <boss@corp\.com>$/m);
  assert.match(message.content, new RegExp(`^To: ${BOT}$`, 'm'));
  assert.match(message.content, /^Cc: 团队 <team@corp\.com>$/m);
  assert.match(message.content, /统计上个月的数据/);
});

test('several senders can be pinned to the same session', async () => {
  const state = new EmailStateStore(join(tmpdir(), 'unused-email-multi.json'));
  await state.setEmailBindings({
    account: null,
    senders: { 'a@x.com': 'session-SHARED', 'b@x.com': 'session-SHARED' },
  });
  assert.equal(state.boundSessionFor('a@x.com'), 'session-SHARED');
  assert.equal(state.boundSessionFor('b@x.com'), 'session-SHARED');
  // A different sender still starts its own thread.
  assert.equal(state.boundSessionFor('c@x.com'), null);
});

test('the mailbox fields survive the client snapshot normalizer', async () => {
  // The shared normalizer keeps an explicit field list, so a channel-specific
  // field is dropped unless the channel declares it — the settings form then
  // showed an empty allowlist even though the Host returned it.
  const { normalizeSnapshot } = await import('../../../plugin-src/client/channels/email/api.js');
  const snapshot = normalizeSnapshot({
    revision: 1,
    bots: [{
      botId: 'email_x', connected: true, state: 'connected',
      allowedSenders: ['a@x.com', 'b@y.com'],
      provider: 'qq', imapHost: 'imap.qq.com', imapPort: 993,
      smtpHost: 'smtp.qq.com', smtpPort: 587,
      bot: { name: 'u@qq.com' }, health: { summary: 'ok' },
    }],
  });
  const bot = snapshot.bots[0];
  assert.deepEqual(bot.allowedSenders, ['a@x.com', 'b@y.com']);
  assert.equal(bot.imapPort, 993);
  assert.equal(bot.smtpPort, 587);
  assert.equal(bot.provider, 'qq');
});
