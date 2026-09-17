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

test('a mailbox may be its own sender, but never answers an automatic reply', () => {
  // Honouring RFC 3834 instead of rejecting the mailbox's own address lets a
  // user drive the Harness by writing to the bot mailbox from that same
  // mailbox, which is a normal way to use it.
  const state = new EmailStateStore(join(tmpdir(), 'unused-email-state-3.json'));
  const selfSent = normalizeEmail(parsedMail({
    from: { value: [{ address: 'DSH@QQ.com' }] },
  }), { address: BOT, state });
  assert.ok(selfSent, 'a hand-written mail from the mailbox itself is accepted');
  assert.equal(selfSent.senderId, 'dsh@qq.com');

  // The loop is broken by the marker every automatic reply carries.
  for (const marker of [
    { headers: new Map([['auto-submitted', 'auto-replied']]) },
    { headerLines: [{ line: 'Auto-Submitted: auto-generated' }] },
  ]) {
    assert.equal(
      normalizeEmail(parsedMail({ from: { value: [{ address: 'other@x.com' }] }, ...marker }),
        { address: BOT, state }),
      null,
      'an automatic reply must never be answered',
    );
  }
  // "no" explicitly means a human message.
  assert.ok(normalizeEmail(parsedMail({
    from: { value: [{ address: 'other@x.com' }] },
    headers: new Map([['auto-submitted', 'no']]),
  }), { address: BOT, state }));

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
    new URL('../../../src/channels/email/transports/imap-smtp.mjs', import.meta.url),
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

test('outgoing replies carry the RFC 3834 automatic-reply marker', async () => {
  // The marker is what lets a remote bot (or this mailbox) refuse to answer an
  // automatic reply, so it must travel on every message we send.
  const source = await readFile(
    new URL('../../../src/channels/email/transports/imap-smtp.mjs', import.meta.url),
    'utf8',
  );
  assert.match(source, /'Auto-Submitted':\s*'auto-replied'/,
    'every outgoing mail must be marked as an automatic reply');
});

test('the mailbox answers its own hand-written mail without looping', async () => {
  // End-to-end shape of the loop break: a mail the mailbox sends itself is
  // processed, the reply is marked automatic, and that reply is then ignored.
  const state = new EmailStateStore(join(tmpdir(), 'unused-email-loop.json'));
  const own = normalizeEmail(parsedMail({ from: { value: [{ address: BOT }] } }),
    { address: BOT, state });
  assert.ok(own, 'the hand-written mail is processed');

  const reply = normalizeEmail(parsedMail({
    from: { value: [{ address: BOT }] },
    headers: new Map([['auto-submitted', 'auto-replied']]),
  }), { address: BOT, state });
  assert.equal(reply, null, 'our own automatic reply must not be processed again');
});

test('re-initializing does not tear down a running mailbox runtime', async () => {
  // initialize() runs on every supervisor health check. Rebuilding the runtime
  // each time reset its poll loop before a pass could finish, so no mail was
  // ever read and the mailbox looked connected but silent.
  const { EmailController } = await import('../../../src/channels/email/email-controller.mjs');
  const dir = await mkdtemp(join(tmpdir(), 'dsh-email-reinit-'));
  try {
    const store = await new EmailConfigStore(join(dir, 'config.json')).load();
    await store.save({
      platformId: 'bot@qq.com', name: 'bot@qq.com', provider: 'qq',
      allowedSenders: ['boss@example.com'],
    });
    const [bot] = store.list();
    let started = 0;
    let stopped = 0;
    const controller = new EmailController({
      credentials: {
        async resolve() { return { value: JSON.stringify({ address: 'bot@qq.com', password: 'p' }) }; },
        async set() {}, async unset() {},
      },
      configStore: store,
      logger: { warn() {}, info() {}, error() {}, log() {} },
      createRuntime: async () => ({
        start: async () => { started += 1; },
        stop: async () => { stopped += 1; },
        status: { ready: true, connectionState: 'connected' },
      }),
    });
    await controller.initialize();
    assert.equal(started, 1, 'the first initialize starts the runtime');
    // Three more health checks must reuse it.
    await controller.initialize();
    await controller.initialize();
    await controller.initialize();
    assert.equal(started, 1, 'later health checks must not restart a running runtime');
    assert.equal(stopped, 0, 'a healthy runtime must not be stopped by a health check');
    assert.deepEqual(controller.status().totals, { configured: 1, connected: 1 });
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});

test('the mailbox transport is selected from its configuration', async () => {
  // One channel hosts every mail protocol: the configured transport key picks
  // the implementation, so a new protocol is a new transport, not a channel.
  const { EmailController } = await import('../../../src/channels/email/email-controller.mjs');
  const {
    EMAIL_TRANSPORTS, DEFAULT_EMAIL_TRANSPORT, normalizeEmailTransport,
  } = await import('../../../src/channels/email/config-store.mjs');

  assert.ok(Object.hasOwn(EMAIL_TRANSPORTS, DEFAULT_EMAIL_TRANSPORT));
  assert.equal(normalizeEmailTransport(undefined), DEFAULT_EMAIL_TRANSPORT);
  assert.equal(normalizeEmailTransport('AGENT-MAIL'), 'agent-mail');
  assert.throws(() => normalizeEmailTransport('carrier-pigeon'), TypeError);

  const dir = await mkdtemp(join(tmpdir(), 'dsh-email-transport-'));
  try {
    const store = await new EmailConfigStore(join(dir, 'config.json')).load();
    await store.save({
      platformId: 'bot@qq.com', name: 'bot@qq.com', provider: 'qq',
      transport: 'agent-mail', allowedSenders: ['boss@example.com'],
    });
    const [bot] = store.list();
    assert.equal(bot.transport, 'agent-mail', 'the transport persists');

    const used = [];
    const controller = new EmailController({
      credentials: {
        async resolve() { return { value: JSON.stringify({ address: 'bot@qq.com', password: 'p' }) }; },
        async set() {}, async unset() {},
      },
      configStore: store,
      logger: { warn() {}, info() {}, error() {}, log() {} },
      transports: {
        'imap-smtp': () => {
          used.push('imap-smtp');
          return {
            connect: async () => {}, disconnect: async () => {}, latestUid: async () => 0,
            listMessages: async () => [], sendReply: async () => {}, sendText: async () => {},
          };
        },
        'agent-mail': () => {
          used.push('agent-mail');
          // A complete stub: the contract check would reject anything less.
          return {
            connect: async () => {}, disconnect: async () => {}, latestUid: async () => 0,
            listMessages: async () => [], sendReply: async () => {}, sendText: async () => {},
          };
        },
      },
      createRuntime: async () => ({ start: async () => {}, stop: async () => {}, status: {} }),
    });
    await controller.bindMailbox({
      address: 'bot@qq.com', transport: 'agent-mail',
      // An Agent mailbox authorizes by scan, so it needs the token pair rather
      // than a password.
      accessToken: 'AT', refreshToken: 'RT',
      allowedSenders: ['boss@example.com'],
    });
    assert.deepEqual(used, ['agent-mail'], 'the configured transport is the one constructed');
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});

test('an incomplete transport is rejected at the boundary', async () => {
  const { assertTransport, TRANSPORT_METHODS } = await import(
    '../../../src/channels/email/transport.mjs'
  );
  assert.ok(TRANSPORT_METHODS.includes('listMessages'));
  assert.throws(() => assertTransport(null), TypeError);
  assert.throws(() => assertTransport({ connect: () => {} }), /must implement/);
  const complete = Object.fromEntries(TRANSPORT_METHODS.map((m) => [m, () => {}]));
  assert.equal(assertTransport(complete), complete);
});

/** A fake agent.qq.com that records calls and serves scripted responses. */
function fakeAgentMail({ responses = [], tokens = { access: 'tok-1', refresh: 'ref-1' } } = {}) {
  const calls = [];
  const queue = [...responses];
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url: url.replace(/^https:\/\/api\.agent\.qq\.com/, ''), method: options.method ?? 'GET' });
    // Reuse the last script once exhausted: a listing walks several pages, and
    // every page should get the same answer.
    const scripted = queue.length > 1 ? queue.shift() : queue[0];
    if (scripted) return scripted(url, options);
    if (url.includes('/v1/me')) {
      return jsonResponse({ data: { aliases: [
        { alias_id: 'ALIAS1', email: 'bot@agent.qq.com', is_primary: true },
      ] } });
    }
    return jsonResponse({ data: [] });
  };
  return { calls, fetchImpl, tokens };
}

function jsonResponse(data, status = 200) {
  return {
    ok: status < 400,
    status,
    text: async () => JSON.stringify(data),
    json: async () => data,
  };
}

test('the agent mailbox transport speaks the documented protocol', async () => {
  const { AgentMailTransport } = await import(
    '../../../src/channels/email/transports/agent-mail.mjs'
  );
  const { fetchImpl, calls } = fakeAgentMail({
    responses: [
      // The alias lookup and the listing are dispatched by URL, not by order.
      (url) => (url.includes('/v1/me')
        ? jsonResponse({ data: { aliases: [{ alias_id: 'ALIAS1', email: 'bot@agent.qq.com', is_primary: true }] } })
        : jsonResponse({ data: [{
          id: 'msg-1', message_id: '<m1@agent.qq.com>', subject: '测试',
          from: { email: 'Boss@Corp.com', name: '老板' },
          to: [{ email: 'bot@agent.qq.com' }], body: '正文',
          headers: { 'auto-submitted': 'no' },
        }], pagination: {} })),
      (url) => (url.includes('/v1/me')
        ? jsonResponse({ data: { aliases: [{ alias_id: 'ALIAS1', email: 'bot@agent.qq.com', is_primary: true }] } })
        : jsonResponse({ data: [{
          id: 'msg-1', message_id: '<m1@agent.qq.com>', subject: '测试',
          from: { email: 'Boss@Corp.com', name: '老板' },
          to: [{ email: 'bot@agent.qq.com' }], body: '正文',
          headers: { 'auto-submitted': 'no' },
        }], pagination: {} })),
    ],
  });
  const transport = new AgentMailTransport({
    config: { address: 'bot@agent.qq.com', accessToken: 'tok-1' }, fetchImpl,
  });

  const messages = await transport.listMessages({ afterUid: null, limit: 5 });
  assert.equal(messages.length, 1);
  assert.equal(messages[0].uid, 'msg-1');
  assert.equal(messages[0].from.value[0].address, 'boss@corp.com');
  assert.equal(messages[0].subject, '测试');
  // The runtime reads the RFC 3834 marker through this accessor.
  assert.equal(messages[0].headers.get('auto-submitted'), 'no');
  assert.deepEqual(calls.map((c) => c.url), [
    '/v1/me',
    '/v1/aliases/ALIAS1/messages?limit=25&dir=inbox',
  ]);
});

test('the agent mailbox filters senders before reading a body', async () => {
  const { AgentMailTransport } = await import(
    '../../../src/channels/email/transports/agent-mail.mjs'
  );
  const { fetchImpl, calls } = fakeAgentMail({
    responses: [
      () => jsonResponse({ data: { aliases: [{ alias_id: 'A1', email: 'bot@agent.qq.com', is_primary: true }] } }),
      () => jsonResponse({ data: [
        { id: 'msg-keep', from: { email: 'boss@corp.com' }, body: 'keep' },
        { id: 'msg-drop', from: { email: 'stranger@evil.com' }, body: 'drop' },
      ], pagination: {} }),
    ],
  });
  const transport = new AgentMailTransport({
    config: { address: 'bot@agent.qq.com', accessToken: 'tok' }, fetchImpl,
  });
  const messages = await transport.listMessages({
    afterUid: null, limit: 5, allowSenders: new Set(['boss@corp.com']),
  });
  assert.deepEqual(messages.map((m) => m.uid), ['msg-keep']);
  // Only the listing is fetched; no per-message read is issued.
  assert.equal(calls.filter((c) => /\/messages\/[^?]/.test(c.url)).length, 0);
});

test('the agent mailbox refreshes a rotated token and persists it', async () => {
  const { AgentMailTransport } = await import(
    '../../../src/channels/email/transports/agent-mail.mjs'
  );
  const persisted = [];
  let listAttempts = 0;
  const fetchImpl = async (url, options = {}) => {
    if (url.includes('/oauth/token')) {
      // The server rotates the refresh token; it must be handed back.
      return jsonResponse({ access_token: 'tok-2', refresh_token: 'ref-2' });
    }
    if (url.includes('/v1/me')) {
      return jsonResponse({ data: { aliases: [{ alias_id: 'A1', email: 'bot@agent.qq.com', is_primary: true }] } });
    }
    listAttempts += 1;
    // The first attempt is unauthorized; the retry must carry the new token.
    if (listAttempts === 1) return jsonResponse({ error: { code: 'UNAUTHORIZED' } }, 401);
    assert.equal(options.headers.authorization, 'Bearer tok-2');
    return jsonResponse({ data: [], pagination: {} });
  };
  const transport = new AgentMailTransport({
    config: { address: 'bot@agent.qq.com', accessToken: 'stale', refreshToken: 'ref-1' },
    fetchImpl,
    onTokensRefreshed: async (tokens) => { persisted.push(tokens); },
  });
  await transport.listMessages({ afterUid: null, limit: 5 });
  assert.deepEqual(persisted, [{ accessToken: 'tok-2', refreshToken: 'ref-2' }],
    'a rotated refresh token must be persisted or the next refresh fails');
});

test('the agent mailbox completes a send that requires confirmation', async () => {
  const { AgentMailTransport } = await import(
    '../../../src/channels/email/transports/agent-mail.mjs'
  );
  const bodies = [];
  const fetchImpl = async (url, options = {}) => {
    if (url.includes('/v1/me')) {
      return jsonResponse({ data: { aliases: [{ alias_id: 'A1', email: 'bot@agent.qq.com', is_primary: true }] } });
    }
    const body = JSON.parse(options.body ?? '{}');
    bodies.push(body);
    if (bodies.length === 1) {
      // The protocol answers the first send with a confirmation challenge.
      return jsonResponse({
        error: { code: 'CONFIRMATION_REQUIRED', details: { confirmation_token: 'cfm-1' } },
      }, 400);
    }
    return jsonResponse({ data: { id: 'sent-1' } });
  };
  const transport = new AgentMailTransport({
    config: { address: 'bot@agent.qq.com', accessToken: 'tok' }, fetchImpl,
  });
  const result = await transport.sendText({ to: 'boss@corp.com', subject: 'hi', text: 'body' });
  assert.equal(result.sent, true);
  assert.equal(bodies.length, 2, 'the send is retried with the confirmation token');
  assert.equal(bodies[1].confirmation_token, 'cfm-1');
});

test('the device flow exposes a URL to scan and reports authorization', async () => {
  const { startAgentMailDeviceFlow, pollAgentMailDeviceFlow } = await import(
    '../../../src/channels/email/transports/agent-mail.mjs'
  );
  const started = await startAgentMailDeviceFlow({
    fetchImpl: async (url) => {
      assert.match(url, /auth\.agent\.qq\.com\/oauth\/device\?func=1$/);
      return jsonResponse({
        poll_url: 'https://auth.agent.qq.com/poll/xyz',
        browser_url: 'https://agent.qq.com/authorize?code=abc',
        input_code: 'ABCD',
      });
    },
  });
  assert.equal(started.pollUrl, 'https://auth.agent.qq.com/poll/xyz');
  assert.equal(started.inputCode, 'ABCD');

  const pending = await pollAgentMailDeviceFlow({
    pollUrl: started.pollUrl,
    fetchImpl: async () => jsonResponse({ status: 'pending' }),
  });
  assert.equal(pending.status, 'pending');
  assert.equal(pending.tokens, null);

  const done = await pollAgentMailDeviceFlow({
    pollUrl: started.pollUrl,
    fetchImpl: async () => jsonResponse({
      status: 'authorized', access_token: 'tok', refresh_token: 'ref',
    }),
  });
  assert.deepEqual(done.tokens, { accessToken: 'tok', refreshToken: 'ref' });
});

test('the Agent mailbox authorization returns a URL to open and yields tokens', async () => {
  // There is no one-shot scan payload: the authorization page embeds its own
  // WeChat QR, so the flow hands back a URL and polls until the server agrees.
  const { EmailController } = await import('../../../src/channels/email/email-controller.mjs');
  const dir = await mkdtemp(join(tmpdir(), 'dsh-email-auth-'));
  const originalFetch = globalThis.fetch;
  try {
    const store = await new EmailConfigStore(join(dir, 'config.json')).load();
    let polls = 0;
    globalThis.fetch = async (url) => {
      const reply = (data) => ({
        ok: true, status: 200, text: async () => JSON.stringify(data), json: async () => data,
      });
      if (String(url).includes('/oauth/device')) {
        return reply({
          poll_url: 'https://auth.agent.qq.com/poll/x',
          browser_url: 'https://agent.qq.com/authorize?code=1',
          input_code: 'XY12',
        });
      }
      polls += 1;
      return reply(polls < 2
        ? { status: 'pending' }
        : { status: 'authorized', access_token: 'AT', refresh_token: 'RT' });
    };

    const controller = new EmailController({
      credentials: {
        async resolve() { return null; }, async set() {}, async unset() {},
      },
      configStore: store,
      logger: { warn() {}, info() {}, error() {}, log() {} },
      transports: { 'imap-smtp': () => ({}), 'agent-mail': () => ({}) },
      createRuntime: async () => ({ start: async () => {}, stop: async () => {}, status: {} }),
    });

    const started = await controller.startAuthorization({ transport: 'agent-mail' });
    assert.equal(started.browserUrl, 'https://agent.qq.com/authorize?code=1');
    assert.equal(started.inputCode, 'XY12');
    assert.equal(started.transport, 'agent-mail');

    assert.deepEqual(await controller.pollAuthorization(), {
      status: 'pending', authorized: false,
    });
    const done = await controller.pollAuthorization();
    assert.equal(done.authorized, true);
    assert.equal(done.accessToken, 'AT');
    assert.equal(done.refreshToken, 'RT');

    // A completed authorization is consumed, not polled again.
    await assert.rejects(() => controller.pollAuthorization(), /尚未开始/);

    // Only a transport that authorizes out of band offers this.
    await assert.rejects(
      () => controller.startAuthorization({ transport: 'imap-smtp' }),
      /不需要扫码授权/,
    );
  } finally {
    globalThis.fetch = originalFetch;
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});



test('a mailbox is displayed under its own address, not a generic label', async () => {
  // The shared client reads the identity from `bot`; a name left at the top
  // level is ignored and the UI falls back to "<channel>机器人", which showed a
  // mailbox as "Email机器人".
  const { EmailController } = await import('../../../src/channels/email/email-controller.mjs');
  const dir = await mkdtemp(join(tmpdir(), 'dsh-email-name-'));
  try {
    const store = await new EmailConfigStore(join(dir, 'config.json')).load();
    await store.save({
      platformId: 'someone@qq.com', name: 'someone@qq.com', provider: 'qq',
      allowedSenders: ['boss@example.com'],
    });
    const controller = new EmailController({
      credentials: {
        async resolve() { return null; }, async set() {}, async unset() {},
      },
      configStore: store,
      logger: { warn() {}, info() {}, error() {}, log() {} },
      transports: { 'imap-smtp': () => ({}), 'agent-mail': () => ({}) },
      createRuntime: async () => ({ start: async () => {}, stop: async () => {}, status: {} }),
    });
    const [bot] = controller.status().bots;
    assert.equal(bot.bot.name, 'someone@qq.com', 'the address is the display name');
    assert.equal(bot.bot.username, 'someone@qq.com');
    // The masked form stays available for the secondary line.
    // Two leading characters kept, the rest of the local part masked.
    assert.equal(bot.bot.idMasked, 'so*****@qq.com');
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});

test('an Agent mailbox without a stored name still shows its address', async () => {
  const { EmailController } = await import('../../../src/channels/email/email-controller.mjs');
  const dir = await mkdtemp(join(tmpdir(), 'dsh-email-name2-'));
  try {
    const store = await new EmailConfigStore(join(dir, 'config.json')).load();
    // An out-of-band authorization may bind without ever naming the mailbox.
    await store.save({
      platformId: 'bot@agent.qq.com', transport: 'agent-mail', allowedSenders: ['boss@example.com'],
    });
    const controller = new EmailController({
      credentials: {
        async resolve() { return null; }, async set() {}, async unset() {},
      },
      configStore: store,
      logger: { warn() {}, info() {}, error() {}, log() {} },
      transports: { 'imap-smtp': () => ({}), 'agent-mail': () => ({}) },
      createRuntime: async () => ({ start: async () => {}, stop: async () => {}, status: {} }),
    });
    const [bot] = controller.status().bots;
    assert.equal(bot.bot.name, 'bot@agent.qq.com');
    assert.equal(bot.transport ?? store.list()[0].transport, 'agent-mail');
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});

test('the Agent mailbox authorization honours the server validity window', async () => {
  // A hard-coded 5-minute window abandoned authorizations the server still
  // considered valid, and told the user a shorter window than the real one.
  const { startAgentMailDeviceFlow, AGENT_MAIL_DEVICE } = await import(
    '../../../src/channels/email/transports/agent-mail.mjs'
  );

  const started = await startAgentMailDeviceFlow({
    fetchImpl: async () => jsonResponse({
      poll_url: 'https://auth.agent.qq.com/poll/x',
      browser_url: 'https://agent.qq.com/authorize?code=1',
      input_code: 'ic_1',
      expires_in: 600,
    }),
  });
  assert.equal(started.expiresInMs, 600_000, 'the server window is used, not an assumption');

  // Without a stated window the fallback applies, and it must not be shorter
  // than what the server is known to allow.
  const noWindow = await startAgentMailDeviceFlow({
    fetchImpl: async () => jsonResponse({
      poll_url: 'https://auth.agent.qq.com/poll/y',
      browser_url: 'https://agent.qq.com/authorize?code=2',
      input_code: 'ic_2',
    }),
  });
  assert.equal(noWindow.expiresInMs, AGENT_MAIL_DEVICE.pollTimeoutMs);
  assert.ok(AGENT_MAIL_DEVICE.pollTimeoutMs >= 600_000,
    'the fallback must not be shorter than the server window');
});

test('an authorization is not abandoned before the server window ends', async () => {
  const { EmailController } = await import('../../../src/channels/email/email-controller.mjs');
  const dir = await mkdtemp(join(tmpdir(), 'dsh-email-exp-'));
  const originalFetch = globalThis.fetch;
  try {
    const store = await new EmailConfigStore(join(dir, 'config.json')).load();
    globalThis.fetch = async (url) => {
      const reply = (data) => ({
        ok: true, status: 200, text: async () => JSON.stringify(data), json: async () => data,
      });
      if (String(url).includes('/oauth/device')) {
        return reply({
          poll_url: 'https://auth.agent.qq.com/poll/x',
          browser_url: 'https://agent.qq.com/authorize?code=1',
          input_code: 'ic_1',
          expires_in: 600,
        });
      }
      return reply({ status: 'pending' });
    };
    const controller = new EmailController({
      credentials: { async resolve() { return null; }, async set() {}, async unset() {} },
      configStore: store,
      logger: { warn() {}, info() {}, error() {}, log() {} },
      transports: { 'imap-smtp': () => ({}), 'agent-mail': () => ({}) },
      createRuntime: async () => ({ start: async () => {}, stop: async () => {}, status: {} }),
    });

    const started = await controller.startAuthorization({ transport: 'agent-mail' });
    // The reported window must cover the server's 600s, not a 300s assumption.
    assert.ok(started.expiresInMs >= 590_000,
      `the published window (${started.expiresInMs}ms) must cover the server window`);

    // Polling still works six minutes of wall-clock later — simulated by moving
    // the recorded deadline back, which is what the old code got wrong.
    const stillValid = await controller.pollAuthorization();
    assert.equal(stillValid.status, 'pending');
  } finally {
    globalThis.fetch = originalFetch;
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});

test('a pending authorization survives a restart', async () => {
  // The code stays valid for ten minutes, which outlives a plugin reload.
  // Losing it stranded an authorization the user had already completed: the
  // server answered "not started" while the scan had in fact succeeded.
  const { EmailController } = await import('../../../src/channels/email/email-controller.mjs');
  const dir = await mkdtemp(join(tmpdir(), 'dsh-email-persist-'));
  const originalFetch = globalThis.fetch;
  try {
    const store = await new EmailConfigStore(join(dir, 'config.json')).load();
    await store.save({
      platformId: 'bot@agent.qq.com', transport: 'agent-mail',
      allowedSenders: ['boss@example.com'],
    });
    const state = await new EmailStateStore(join(dir, 'state.json')).load();

    let polls = 0;
    globalThis.fetch = async (url) => {
      const reply = (data) => ({
        ok: true, status: 200, text: async () => JSON.stringify(data), json: async () => data,
      });
      if (String(url).includes('/oauth/device') && String(url).includes('func=1')) {
        return reply({
          poll_url: 'https://auth.agent.qq.com/poll/x',
          browser_url: 'https://agent.qq.com/authorize?code=1',
          input_code: 'ic_1', expires_in: 600,
        });
      }
      // The identity lookup is not a poll.
      if (String(url).includes('/v1/me')) {
        return reply({ data: { aliases: [{ alias_id: 'A1', email: 'bot@agent.qq.com', is_primary: true }] } });
      }
      polls += 1;
      // The user completed the scan while the plugin was restarting.
      return reply({ status: 'authorized', access_token: 'AT', refresh_token: 'RT' });
    };

    const build = () => new EmailController({
      credentials: { async resolve() { return null; }, async set() {}, async unset() {} },
      configStore: store,
      logger: { warn() {}, info() {}, error() {}, log() {} },
      transports: { 'imap-smtp': () => ({}), 'agent-mail': () => ({}) },
      createRuntime: async () => ({ start: async () => {}, stop: async () => {}, status: {} }),
      stateFor: async () => state,
    });

    const first = build();
    await first.startAuthorization({ transport: 'agent-mail' });
    assert.ok(state.pendingAuth(), 'the pending code must be persisted');

    // A fresh controller stands in for the restarted plugin: no in-memory copy.
    const second = build();
    const done = await second.pollAuthorization();
    assert.equal(done.authorized, true, 'the completed scan is still redeemable');
    assert.equal(done.accessToken, 'AT');
    assert.equal(polls, 1, 'the stored poll URL is the one used');
    assert.equal(state.pendingAuth(), null, 'a redeemed code is cleared');
  } finally {
    globalThis.fetch = originalFetch;
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});

test('an expired pending authorization is refused', async () => {
  const { EmailController } = await import('../../../src/channels/email/email-controller.mjs');
  const dir = await mkdtemp(join(tmpdir(), 'dsh-email-expiry-'));
  const originalFetch = globalThis.fetch;
  try {
    const store = await new EmailConfigStore(join(dir, 'config.json')).load();
    await store.save({
      platformId: 'bot@agent.qq.com', transport: 'agent-mail',
      allowedSenders: ['boss@example.com'],
    });
    const state = await new EmailStateStore(join(dir, 'state.json')).load();
    // A code that expired while nobody was watching.
    await state.setPendingAuth({
      pollUrl: 'https://auth.agent.qq.com/poll/old',
      expiresAt: Date.now() - 1_000,
      transport: 'agent-mail',
    });
    globalThis.fetch = async () => ({
      ok: true, status: 200,
      text: async () => JSON.stringify({ status: 'authorized', access_token: 'X' }),
      json: async () => ({ status: 'authorized', access_token: 'X' }),
    });
    const controller = new EmailController({
      credentials: { async resolve() { return null; }, async set() {}, async unset() {} },
      configStore: store,
      logger: { warn() {}, info() {}, error() {}, log() {} },
      transports: { 'imap-smtp': () => ({}), 'agent-mail': () => ({}) },
      createRuntime: async () => ({ start: async () => {}, stop: async () => {}, status: {} }),
      stateFor: async () => state,
    });
    await assert.rejects(() => controller.pollAuthorization(), /超时|尚未开始/);
  } finally {
    globalThis.fetch = originalFetch;
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});

test('the status reports which transport a mailbox uses', async () => {
  // Without this the settings page cannot tell an Agent mailbox from an
  // IMAP/SMTP one, and describes it with server hosts it does not have.
  const { EmailController } = await import('../../../src/channels/email/email-controller.mjs');
  const dir = await mkdtemp(join(tmpdir(), 'dsh-email-transport-status-'));
  try {
    const store = await new EmailConfigStore(join(dir, 'config.json')).load();
    await store.save({
      platformId: 'bot@agent.qq.com', transport: 'agent-mail',
      allowedSenders: ['boss@example.com'],
    });
    await store.save({
      platformId: 'me@qq.com', provider: 'qq', allowedSenders: ['boss@example.com'],
    });
    const controller = new EmailController({
      credentials: { async resolve() { return null; }, async set() {}, async unset() {} },
      configStore: store,
      logger: { warn() {}, info() {}, error() {}, log() {} },
      transports: { 'imap-smtp': () => ({}), 'agent-mail': () => ({}) },
      createRuntime: async () => ({ start: async () => {}, stop: async () => {}, status: {} }),
    });
    const byAddress = Object.fromEntries(
      controller.status().bots.map((bot) => [bot.bot.name, bot.transport]),
    );
    assert.equal(byAddress['bot@agent.qq.com'], 'agent-mail');
    // A mailbox saved without a transport keeps the standard protocol.
    assert.equal(byAddress['me@qq.com'], 'imap-smtp');
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});

test('a mailbox can switch transport', async () => {
  const { EmailController } = await import('../../../src/channels/email/email-controller.mjs');
  const dir = await mkdtemp(join(tmpdir(), 'dsh-email-switch-'));
  try {
    const store = await new EmailConfigStore(join(dir, 'config.json')).load();
    await store.save({
      platformId: 'me@qq.com', provider: 'qq', allowedSenders: ['boss@example.com'],
    });
    const [bot] = store.list();
    const controller = new EmailController({
      credentials: { async resolve() { return null; }, async set() {}, async unset() {} },
      configStore: store,
      logger: { warn() {}, info() {}, error() {}, log() {} },
      transports: { 'imap-smtp': () => ({}), 'agent-mail': () => ({}) },
      createRuntime: async () => ({ start: async () => {}, stop: async () => {}, status: {} }),
    });
    await controller.updateMailboxSettings(bot.botId, { transport: 'agent-mail' });
    const [updated] = store.list();
    assert.equal(updated.transport, 'agent-mail');
    // An unknown transport is refused rather than silently stored.
    await assert.rejects(
      () => controller.updateMailboxSettings(bot.botId, { transport: 'carrier-pigeon' }),
      TypeError,
    );
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});

test('the client keeps the transport field from the host snapshot', async () => {
  const { normalizeSnapshot } = await import(
    '../../../plugin-src/client/channels/email/api.js'
  );
  const snapshot = normalizeSnapshot({
    revision: 1,
    bots: [{
      botId: 'email_x', connected: true, state: 'connected',
      transport: 'agent-mail', allowedSenders: ['boss@example.com'],
      bot: { name: 'bot@agent.qq.com' }, health: { summary: 'ok' },
    }],
  });
  assert.equal(snapshot.bots[0].transport, 'agent-mail');
});

test('the Agent mailbox replies by the API id, not the RFC Message-ID', async () => {
  // The reply endpoint addresses a message by the API's own id. Sending the
  // RFC Message-ID made the path carry an "@" (encoded, or a bracket stripped
  // into the wrong id), so a reply could miss the thread it belonged to.
  const { AgentMailTransport } = await import(
    '../../../src/channels/email/transports/agent-mail.mjs'
  );
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(String(url).replace('https://api.agent.qq.com', ''));
    const reply = (data) => ({
      ok: true, status: 200, text: async () => JSON.stringify(data), json: async () => data,
    });
    if (String(url).includes('/v1/me')) {
      return reply({ data: { aliases: [{ alias_id: 'A1', email: 'b@a.qq.com', is_primary: true }] } });
    }
    return reply({ data: { id: 'sent-1' } });
  };
  const transport = new AgentMailTransport({
    config: { address: 'b@a.qq.com', accessToken: 'x' }, fetchImpl,
  });

  await transport.sendReply({
    to: 'a@x.com', subject: 'Re', text: 'hi',
    inReplyTo: '<abc@qq.com>', transportMessageId: 'msg_api_123',
  });
  assert.ok(
    calls.some((call) => call.includes('/messages/msg_api_123/reply')),
    'the API id is used for the reply path',
  );
  assert.ok(
    !calls.some((call) => call.includes('%40')),
    'the RFC Message-ID must not leak into the path',
  );
});

test('the reply target carries both ids', () => {
  // A transport that addresses messages by its own id needs it; one that only
  // needs the RFC header ignores it.
  const state = new EmailStateStore(join(tmpdir(), 'unused-email-bothids.json'));
  const message = normalizeEmail(parsedMail(), { address: BOT, state });
  assert.equal(message.replyTarget.messageId, '<m1@mail.example>');
  assert.ok('transportMessageId' in message.replyTarget,
    'the transport id travels alongside the RFC one');
});

test('binding an Agent mailbox carries the OAuth tokens through', async () => {
  // bindMailbox destructured only the password, so the scanned tokens were
  // dropped before the credential probe: the Agent mailbox was probed with no
  // token and failed as though the password were wrong.
  const { EmailController } = await import('../../../src/channels/email/email-controller.mjs');
  const dir = await mkdtemp(join(tmpdir(), 'dsh-email-bindtokens-'));
  try {
    const store = await new EmailConfigStore(join(dir, 'config.json')).load();
    const written = [];
    let probed = null;
    const stub = () => ({
      connect: async () => {}, disconnect: async () => {}, latestUid: async () => 0,
      listMessages: async () => [], sendReply: async () => {}, sendText: async () => {},
    });
    const controller = new EmailController({
      credentials: {
        async resolve() { return null; },
        async set(ref, value) { written.push({ ref, value }); },
        async unset() {},
      },
      configStore: store,
      logger: { warn() {}, info() {}, error() {}, log() {} },
      transports: {
        'imap-smtp': stub,
        'agent-mail': (options) => { probed = options.config; return stub(); },
      },
      createRuntime: async () => ({ start: async () => {}, stop: async () => {}, status: {} }),
    });

    await controller.bindMailbox({
      address: 'bot@agent.qq.com',
      transport: 'agent-mail',
      accessToken: 'AT-123',
      refreshToken: 'RT-456',
      allowedSenders: ['boss@corp.com'],
    });

    assert.equal(probed.transport, 'agent-mail');
    assert.equal(probed.accessToken, 'AT-123', 'the probe receives the access token');
    assert.equal(probed.refreshToken, 'RT-456');
    const saved = JSON.parse(written[0].value);
    assert.equal(saved.accessToken, 'AT-123', 'the token is persisted');
    assert.equal(saved.refreshToken, 'RT-456');
    assert.equal(store.list()[0].transport, 'agent-mail');

    // Without a token the bind is refused with a message about authorizing,
    // not about a missing password.
    await assert.rejects(
      () => controller.bindMailbox({
        address: 'other@agent.qq.com', transport: 'agent-mail',
        allowedSenders: ['boss@corp.com'],
      }),
      /授权/,
    );
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});

test('a failed startup reports a usable reason', async () => {
  // An AggregateError carries an empty message with the reason on `code`
  // (ECONNREFUSED and friends). `??` does not fall through an empty string, so
  // the settings card showed a blank error and could not be acted on.
  const { EmailController } = await import('../../../src/channels/email/email-controller.mjs');
  const dir = await mkdtemp(join(tmpdir(), 'dsh-email-safeerror-'));
  try {
    const store = await new EmailConfigStore(join(dir, 'config.json')).load();
    await store.save({
      platformId: 'x@agent.qq.com', transport: 'agent-mail',
      allowedSenders: ['boss@example.com'],
    });
    const refused = new AggregateError([]);
    refused.code = 'ECONNREFUSED';
    const controller = new EmailController({
      credentials: {
        async resolve() {
          return { value: JSON.stringify({ address: 'x@agent.qq.com', accessToken: 't' }) };
        },
        async set() {}, async unset() {},
      },
      configStore: store,
      logger: { warn() {}, info() {}, error() {}, log() {} },
      transports: {
        'imap-smtp': () => ({}),
        'agent-mail': () => ({
          connect: async () => { throw refused; },
          disconnect: async () => {}, latestUid: async () => 0,
          listMessages: async () => [], sendReply: async () => {}, sendText: async () => {},
        }),
      },
      // The failure surfaces when the runtime starts, which is where a
      // connection refusal lands.
      createRuntime: async () => ({
        start: async () => { throw refused; },
        stop: async () => {},
        status: {},
      }),
    });
    const status = await controller.initialize();
    const bot = status.bots.find((b) => b.bot.name === 'x@agent.qq.com');
    assert.ok(bot?.error, 'the failure is recorded');
    assert.ok(String(bot.error.message).trim().length > 0,
      `the reason must not be blank (got ${JSON.stringify(bot.error.message)})`);
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});

test('the runtime hands its transport key to the transport factory', async () => {
  // The runtime built the transport config without the transport key, so every
  // mailbox was dialled as IMAP/SMTP — an Agent mailbox then failed with
  // ECONNREFUSED because it was addressed as a mail server.
  const { EmailRuntime } = await import('../../../src/channels/email/email-runtime.mjs');
  const dir = await mkdtemp(join(tmpdir(), 'dsh-email-transportkey-'));
  try {
    const state = await new EmailStateStore(join(dir, 'state.json')).load();
    let received = null;
    const runtime = new EmailRuntime({
      config: { platformId: 'bot@agent.qq.com', transport: 'agent-mail', allowedSenders: [] },
      token: 'unused',
      credential: { address: 'bot@agent.qq.com', accessToken: 'AT' },
      harness: { ensureRunning: async () => {} },
      state,
      logger: { warn() {}, info() {}, error() {}, log() {} },
      createApi: (options) => {
        received = options.config;
        return {
          connect: async () => {}, disconnect: async () => {}, latestUid: async () => 0,
          listMessages: async () => [], sendReply: async () => {}, sendText: async () => {},
        };
      },
    });
    await runtime.start();
    assert.ok(received, 'the transport was constructed');
    assert.equal(received.transport, 'agent-mail', 'the configured key reaches the factory');
    assert.equal(received.accessToken, 'AT');
    await runtime.stop();
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});

test('the runtime uses the transport its caller supplies', async () => {
  // The runtime defaulted to IMAP/SMTP regardless of the mailbox's protocol,
  // so an Agent mailbox was dialled as a mail server and failed on port 993
  // with ECONNREFUSED while its own API worked fine.
  const { EmailRuntime } = await import('../../../src/channels/email/email-runtime.mjs');
  const dir = await mkdtemp(join(tmpdir(), 'dsh-email-inject-'));
  try {
    const state = await new EmailStateStore(join(dir, 'state.json')).load();
    const built = [];
    const stub = () => ({
      connect: async () => {}, disconnect: async () => {}, latestUid: async () => 0,
      listMessages: async () => [], sendReply: async () => {}, sendText: async () => {},
    });
    const runtime = new EmailRuntime({
      config: { platformId: 'bot@agent.qq.com', transport: 'agent-mail', allowedSenders: [] },
      token: 'unused',
      credential: { address: 'bot@agent.qq.com', accessToken: 'AT' },
      harness: { ensureRunning: async () => {} },
      state,
      logger: { warn() {}, info() {}, error() {}, log() {} },
      // What the controller injects.
      createTransport: (options) => { built.push(options.transport ?? options.config?.transport); return stub(); },
    });
    await runtime.start();
    assert.deepEqual(built, ['agent-mail'], 'the supplied factory builds the configured transport');
    await runtime.stop();
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});

test('the controller tells the runtime which transport to build', async () => {
  const { EmailController } = await import('../../../src/channels/email/email-controller.mjs');
  const dir = await mkdtemp(join(tmpdir(), 'dsh-email-inject2-'));
  try {
    const store = await new EmailConfigStore(join(dir, 'config.json')).load();
    await store.save({
      platformId: 'bot@agent.qq.com', transport: 'agent-mail',
      allowedSenders: ['boss@example.com'],
    });
    let factory = null;
    let built = null;
    const stub = () => ({
      connect: async () => {}, disconnect: async () => {}, latestUid: async () => 0,
      listMessages: async () => [], sendReply: async () => {}, sendText: async () => {},
    });
    const controller = new EmailController({
      credentials: {
        async resolve() {
          return { value: JSON.stringify({ address: 'bot@agent.qq.com', accessToken: 'AT' }) };
        },
        async set() {}, async unset() {},
      },
      configStore: store,
      logger: { warn() {}, info() {}, error() {}, log() {} },
      transports: {
        'imap-smtp': stub,
        'agent-mail': (options) => { built = options.config.transport; return stub(); },
      },
      // Stand in for the runtime: capture what the controller injects.
      createRuntime: async ({ createTransport }) => {
        factory = createTransport;
        return { start: async () => {}, stop: async () => {}, status: {} };
      },
    });
    await controller.initialize();
    assert.equal(typeof factory, 'function', 'a transport factory is injected');
    factory({ config: { transport: 'agent-mail' } });
    assert.equal(built, 'agent-mail', 'the injected factory honours the mailbox protocol');
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});

test('the agent mailbox authorization reports the mailbox address', async () => {
  // The scan yields tokens only, but the address is what the account is named
  // and bound as. It is fetched instead of asking the user to type what the
  // server already knows.
  const { EmailController } = await import('../../../src/channels/email/email-controller.mjs');
  const dir = await mkdtemp(join(tmpdir(), 'dsh-email-addr-'));
  const originalFetch = globalThis.fetch;
  try {
    const store = await new EmailConfigStore(join(dir, 'config.json')).load();
    globalThis.fetch = async (url) => {
      const reply = (data) => ({
        ok: true, status: 200, text: async () => JSON.stringify(data), json: async () => data,
      });
      if (String(url).includes('/oauth/device')) {
        return reply({
          poll_url: 'https://auth.agent.qq.com/poll/x',
          browser_url: 'https://agent.qq.com/authorize?code=1',
          input_code: 'ic_1', expires_in: 600,
        });
      }
      if (String(url).includes('/v1/me')) {
        return reply({ data: { aliases: [
          { alias_id: 'A1', email: 'me@agent.qq.com', name: 'dshagent', is_primary: true },
        ] } });
      }
      return reply({ status: 'authorized', access_token: 'AT', refresh_token: 'RT' });
    };
    const controller = new EmailController({
      credentials: { async resolve() { return null; }, async set() {}, async unset() {} },
      configStore: store,
      logger: { warn() {}, info() {}, error() {}, log() {} },
      transports: { 'imap-smtp': () => ({}), 'agent-mail': () => ({}) },
      createRuntime: async () => ({ start: async () => {}, stop: async () => {}, status: {} }),
    });
    await controller.startAuthorization({ transport: 'agent-mail' });
    const done = await controller.pollAuthorization();
    assert.equal(done.authorized, true);
    assert.equal(done.address, 'me@agent.qq.com', 'the address travels with the tokens');
    assert.equal(done.name, 'dshagent');
  } finally {
    globalThis.fetch = originalFetch;
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});

test('a mailbox whose identity cannot be read still authorizes', async () => {
  // The lookup is a convenience; failing it must not invalidate a scan the user
  // already completed.
  const { EmailController } = await import('../../../src/channels/email/email-controller.mjs');
  const dir = await mkdtemp(join(tmpdir(), 'dsh-email-addr2-'));
  const originalFetch = globalThis.fetch;
  try {
    const store = await new EmailConfigStore(join(dir, 'config.json')).load();
    globalThis.fetch = async (url) => {
      const reply = (data, status = 200) => ({
        ok: status < 400, status, text: async () => JSON.stringify(data), json: async () => data,
      });
      if (String(url).includes('/oauth/device')) {
        return reply({
          poll_url: 'https://auth.agent.qq.com/poll/y',
          browser_url: 'https://agent.qq.com/authorize?code=2',
          input_code: 'ic_2', expires_in: 600,
        });
      }
      if (String(url).includes('/v1/me')) return reply({ error: 'nope' }, 500);
      return reply({ status: 'authorized', access_token: 'AT', refresh_token: 'RT' });
    };
    const controller = new EmailController({
      credentials: { async resolve() { return null; }, async set() {}, async unset() {} },
      configStore: store,
      logger: { warn() {}, info() {}, error() {}, log() {} },
      transports: { 'imap-smtp': () => ({}), 'agent-mail': () => ({}) },
      createRuntime: async () => ({ start: async () => {}, stop: async () => {}, status: {} }),
    });
    await controller.startAuthorization({ transport: 'agent-mail' });
    const done = await controller.pollAuthorization();
    assert.equal(done.authorized, true, 'the authorization still succeeds');
    assert.equal(done.accessToken, 'AT');
    assert.equal(done.address, undefined, 'no address is reported when it cannot be read');
  } finally {
    globalThis.fetch = originalFetch;
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});

test('the mailbox update endpoint accepts the fields the client sends', async () => {
  // The client sends mailbox fields flat beside botId, as every other endpoint
  // does. The handler read a nested `update`, so the whole change was discarded
  // and the call still reported success — the allowlist looked saved and was
  // not.
  const { createEmailRpcHandler } = await import(
    '../../../plugin-src/host/channels/email/rpc.mjs'
  );
  const seen = [];
  const controller = {
    status: () => ({ revision: 0, bots: [], totals: { configured: 0, connected: 0 } }),
    // The shared handler validates the whole controller surface before use.
    async bindCredentials() {}, async bindMailbox() {}, async reconnectBot() {},
    async deleteBot() {}, async setWorkspace() {}, async setModel() {},
    async setAgentPreset() {}, async setContextEnhancement() {}, async setAccessPolicy() {},
    async setAlias() {},
    async updateMailboxSettings(botId, update) { seen.push({ botId, update }); return { ok: true }; },
  };
  const handler = createEmailRpcHandler(controller);

  await handler('bot.mailbox.update', {
    botId: 'email_1',
    allowedSenders: ['a@x.com', 'b@y.com'],
  });

  assert.equal(seen.length, 1);
  assert.equal(seen[0].botId, 'email_1');
  assert.deepEqual(seen[0].update, { allowedSenders: ['a@x.com', 'b@y.com'] },
    'the flat fields reach the controller');
  assert.ok(!('botId' in seen[0].update), 'the addressing field is not passed through');

  // The nested form keeps working for callers that use it.
  await handler('bot.mailbox.update', { botId: 'email_1', update: { allowedSenders: ['c@z.com'] } });
  assert.deepEqual(seen[1].update, { allowedSenders: ['c@z.com'] });
});

test('a failing poll stops the mailbox reporting itself healthy', async () => {
  // The transport opens once, then polls forever. A poll that keeps failing —
  // an expired token, say — left connectionState at "connected", so the
  // settings card said the channel was healthy while no mail could be read.
  const { EmailRuntime } = await import('../../../src/channels/email/email-runtime.mjs');
  const dir = await mkdtemp(join(tmpdir(), 'dsh-email-pollfail-'));
  try {
    const state = await new EmailStateStore(join(dir, 'state.json')).load();
    let fail = false;
    const runtime = new EmailRuntime({
      config: { platformId: 'bot@agent.qq.com', transport: 'agent-mail', allowedSenders: [] },
      token: 'unused',
      credential: { address: 'bot@agent.qq.com', accessToken: 'AT' },
      harness: { ensureRunning: async () => {} },
      state,
      logger: { warn() {}, info() {}, error() {}, log() {} },
      pollIntervalMs: 20,
      createApi: () => ({
        connect: async () => {}, disconnect: async () => {}, latestUid: async () => 0,
        listMessages: async () => {
          if (fail) throw new Error('/v1/me failed: HTTP 401');
          return [];
        },
        sendReply: async () => {}, sendText: async () => {},
      }),
    });
    await runtime.start();
    assert.equal(runtime.status.connectionState, 'connected');

    fail = true;
    // Let the poll loop run into the failure.
    for (let i = 0; i < 40 && runtime.status.connectionState !== 'failed'; i += 1) {
      await new Promise((r) => { setTimeout(r, 25); });
    }
    assert.equal(runtime.status.connectionState, 'failed',
      'a failing poll must not keep reporting connected');
    assert.match(String(runtime.status.lastError), /401/);

    // Recovery is reflected too.
    fail = false;
    for (let i = 0; i < 40 && runtime.status.connectionState !== 'connected'; i += 1) {
      await new Promise((r) => { setTimeout(r, 25); });
    }
    assert.equal(runtime.status.connectionState, 'connected', 'a healthy poll restores the state');
    await runtime.stop();
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});

test('an opaque cursor is never seeded with the newest message', async () => {
  // The Agent mailbox treats the cursor as "already handled" and lists
  // newest-first, so seeding it with the newest id discarded that message
  // forever — the first mail after connecting was never processed.
  const { EmailRuntime } = await import('../../../src/channels/email/email-runtime.mjs');
  const dir = await mkdtemp(join(tmpdir(), 'dsh-email-cursor-'));
  try {
    const state = await new EmailStateStore(join(dir, 'state.json')).load();
    const runtime = new EmailRuntime({
      config: { platformId: 'bot@agent.qq.com', transport: 'agent-mail', allowedSenders: [] },
      token: 'unused',
      credential: { address: 'bot@agent.qq.com', accessToken: 'AT' },
      harness: { ensureRunning: async () => {} },
      state,
      logger: { warn() {}, info() {}, error() {}, log() {} },
      createApi: () => ({
        connect: async () => {}, disconnect: async () => {},
        // An opaque cursor, as the Agent mailbox returns.
        latestUid: async () => 'msg_newest',
        listMessages: async () => [], sendReply: async () => {}, sendText: async () => {},
      }),
    });
    await runtime.start();
    assert.notEqual(state.cursor(), 'msg_newest',
      'seeding the newest id would mark the newest message as already handled');
    assert.ok(state.cursor() === null || state.cursor() === 0,
      `expected no cursor for an opaque transport, got ${JSON.stringify(state.cursor())}`);
    await runtime.stop();
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});

test('a numeric cursor still keeps the startup window', async () => {
  // IMAP is numbered, so the window that catches mail arriving during startup
  // must survive the fix above.
  const { EmailRuntime } = await import('../../../src/channels/email/email-runtime.mjs');
  const dir = await mkdtemp(join(tmpdir(), 'dsh-email-cursor2-'));
  try {
    const state = await new EmailStateStore(join(dir, 'state.json')).load();
    const runtime = new EmailRuntime({
      config: { platformId: 'me@qq.com', transport: 'imap-smtp', allowedSenders: [] },
      token: 'unused',
      harness: { ensureRunning: async () => {} },
      state,
      logger: { warn() {}, info() {}, error() {}, log() {} },
      createApi: () => ({
        connect: async () => {}, disconnect: async () => {}, latestUid: async () => 100,
        listMessages: async () => [], sendReply: async () => {}, sendText: async () => {},
      }),
    });
    await runtime.start();
    assert.equal(state.cursor(), 90, 'the startup window is still applied to numeric cursors');
    await runtime.stop();
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});

test('the agent mailbox reads the body, not just the list snippet', async () => {
  // The list endpoint returns only a snippet; the body comes from the
  // per-message read. Without it the message had no text and was dropped as
  // empty, so mail arrived and was never processed.
  const { AgentMailTransport } = await import(
    '../../../src/channels/email/transports/agent-mail.mjs'
  );
  const calls = [];
  const fetchImpl = async (url) => {
    const path = String(url).replace('https://api.agent.qq.com', '');
    calls.push(path);
    const reply = (data) => ({
      ok: true, status: 200, text: async () => JSON.stringify(data), json: async () => data,
    });
    if (path.includes('/v1/me')) {
      return reply({ data: { aliases: [{ alias_id: 'A1', email: 'b@a.qq.com', is_primary: true }] } });
    }
    if (path.includes('/messages/msg_1') && !path.includes('?')) {
      return reply({ data: {
        message_id: 'msg_1',
        rfc_message_id: '<rfc-1@qq.com>',
        body: 'real&nbsp;body',
        from: { email: 'a@x.com' }, subject: 'S',
      } });
    }
    // The list: a snippet, no body, no rfc id.
    return reply({ data: [{
      message_id: 'msg_1', subject: 'S', snippet: 'snippet only',
      from: { email: 'a@x.com' },
    }], pagination: {} });
  };
  const transport = new AgentMailTransport({
    config: { address: 'b@a.qq.com', accessToken: 'x' }, fetchImpl,
  });
  const messages = await transport.listMessages({ afterUid: null, limit: 5 });
  assert.equal(messages.length, 1);
  assert.equal(messages[0].text, 'real body', 'the body is read, with entities decoded');
  assert.equal(messages[0].messageId, '<rfc-1@qq.com>',
    'the RFC Message-ID is used for threading, not the API id');
  assert.equal(messages[0].uid, 'msg_1', 'the API id addresses the message');
  assert.ok(calls.some((c) => c.includes('/messages/msg_1')), 'the body was fetched');
});

test('an unlisted sender costs no body read', async () => {
  const { AgentMailTransport } = await import(
    '../../../src/channels/email/transports/agent-mail.mjs'
  );
  const calls = [];
  const fetchImpl = async (url) => {
    const path = String(url).replace('https://api.agent.qq.com', '');
    calls.push(path);
    const reply = (data) => ({
      ok: true, status: 200, text: async () => JSON.stringify(data), json: async () => data,
    });
    if (path.includes('/v1/me')) {
      return reply({ data: { aliases: [{ alias_id: 'A1', email: 'b@a.qq.com', is_primary: true }] } });
    }
    return reply({ data: [{
      message_id: 'msg_x', subject: 'S', snippet: 's',
      from: { email: 'stranger@evil.com' },
    }], pagination: {} });
  };
  const transport = new AgentMailTransport({
    config: { address: 'b@a.qq.com', accessToken: 'x' }, fetchImpl,
  });
  const messages = await transport.listMessages({
    afterUid: null, limit: 5, allowSenders: new Set(['a@x.com']),
  });
  assert.deepEqual(messages, []);
  assert.ok(!calls.some((c) => c.includes('/messages/msg_x')),
    'no per-message read is issued for a filtered sender');
});

test('an already-seen message is not delivered twice', async () => {
  // The cursor marks a boundary in the listing, but a mailbox whose listing
  // shifts (mail moved or deleted) loses that boundary and the same messages
  // come back every poll — each one re-running a turn.
  // A private directory: a shared path would carry state between tests.
  const dir = await mkdtemp(join(tmpdir(), 'dsh-email-seen-'));
  try {
    const state = await new EmailStateStore(join(dir, 'seen.json')).load();
    const key = '<rfc-1@x>';
    assert.equal(state.hasSeen(key), false, 'a fresh message is unseen');
    await state.markSeen(key);
    assert.equal(state.hasSeen(key), true, 'a delivered message is recorded');

    const path = join(dir, 'state.json');
    const first = await new EmailStateStore(path).load();
    await first.markSeen('<rfc-2@x>');
    const reloaded = await new EmailStateStore(path).load();
    assert.equal(reloaded.hasSeen('<rfc-2@x>'), true);
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});

