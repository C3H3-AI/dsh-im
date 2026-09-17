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
  assert.equal(message.content, 'Please do the thing');
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
