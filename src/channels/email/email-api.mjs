/**
 * Email transport: IMAP receive + SMTP send + MIME parsing.
 *
 * The channel talks to one dedicated mailbox (a bot identity). Inbound mail is
 * polled over IMAP and normalized into the shared bridge's message shape;
 * outbound replies go back over SMTP as replies in the same mail thread, so a
 * mail conversation maps 1:1 onto a Harness conversation.
 */
import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
import nodemailer from 'nodemailer';

/** Reply text longer than this is truncated so it survives mail gateways. */
const MAX_REPLY_CHARS = 100_000;

/**
 * Quoted-history markers. Mail clients append the whole prior conversation to
 * every reply; leaving it in place would grow the prompt each turn and confuse
 * the model, so the body is cut at the first marker.
 */
const QUOTE_MARKERS = [
  /^On .{10,120} wrote:$/mi,
  /^-{2,}\s*Original Message\s*-{2,}$/mi,
  /^在 .{4,60}(写道|寫道)[:：]?\s*$/mi,
  /^-{2,}\s*原始邮件\s*-{2,}$/mi,
  /^\s*_{10,}\s*$/m,
  /^From:\s.+$/mi,
  /^发件人[:：]\s*.+$/mi,
];

/** Cut a mail body at the first quoted-history marker. */
export function stripQuotedHistory(text) {
  const body = String(text ?? '').replace(/\r\n/g, '\n');
  let cut = body.length;
  for (const marker of QUOTE_MARKERS) {
    const match = marker.exec(body);
    if (match && match.index > 0 && match.index < cut) cut = match.index;
  }
  return body
    .slice(0, cut)
    .split('\n')
    .filter((line) => !/^\s*>/.test(line))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Derive the transport security mode from the port, which is how mail clients
 * decide in practice: 465 is implicit TLS, 587 and 25 negotiate STARTTLS, and
 * anything else is left to the explicit `secure` flag. Treating 587 as
 * implicit TLS is the classic misconfiguration that makes SMTP hang.
 */
export function smtpSecurity(port, secure) {
  if (secure === true) return { secure: true };
  if (secure === false) return { secure: false, requireTLS: true };
  if (port === 465) return { secure: true };
  if (port === 587 || port === 25 || port === 2525) return { secure: false, requireTLS: true };
  return { secure: false };
}

/** IMAP uses implicit TLS on 993 and STARTTLS otherwise. */
export function imapSecurity(port, secure) {
  if (secure !== undefined) return { secure: secure !== false };
  return { secure: port === 993 };
}

/** Collect every message id from a header value (References / In-Reply-To). */
export function parseMessageIds(value) {
  if (!value) return [];
  const raw = Array.isArray(value) ? value.join(' ') : String(value);
  return (raw.match(/<[^<>@\s]+@[^<>\s]+>/g) ?? []).map((id) => id.trim());
}

/**
 * Resolve the thread key for a message: an existing conversation is reused when
 * the reply chain points at a message we have seen before, otherwise the
 * message starts a new conversation.
 */
export function resolveThreadKey({ messageId, references = [], inReplyTo = [], conversationMap }) {
  const chain = [...parseMessageIds(references), ...parseMessageIds(inReplyTo)];
  for (let index = chain.length - 1; index >= 0; index -= 1) {
    const key = conversationMap.get(chain[index]);
    if (key) return key;
  }
  return parseMessageIds(messageId)[0] ?? `email:${Date.now()}`;
}

/** Lowercase a bare address, keeping only the addr-spec part. */
export function normalizeAddress(value) {
  const text = String(value ?? '').trim().toLowerCase();
  const angled = /<([^<>]+)>/.exec(text);
  return (angled ? angled[1] : text).trim();
}

export class EmailApi {
  #config;
  #signal;
  #imap = null;
  #transport = null;

  constructor({ config, signal } = {}) {
    if (!config?.address || !config?.password) {
      throw new TypeError('EmailApi requires an address and password');
    }
    this.#config = config;
    this.#signal = signal;
  }

  get address() {
    return this.#config.address;
  }

  /** Open the IMAP connection and select the monitored mailbox. */
  async connect() {
    if (this.#imap) return;
    const client = new ImapFlow({
      host: this.#config.imapHost,
      port: this.#config.imapPort,
      ...imapSecurity(this.#config.imapPort, this.#config.imapSecure),
      auth: { user: this.#config.address, pass: this.#config.password },
      logger: false,
      ...(this.#config.rejectUnauthorized === false ? { tls: { rejectUnauthorized: false } } : {}),
    });
    client.on('error', () => { /* surfaced by the caller's poll/connection state */ });
    await client.connect();
    await client.mailboxOpen(this.#config.mailbox ?? 'INBOX');
    this.#imap = client;
  }

  async disconnect() {
    const client = this.#imap;
    this.#imap = null;
    if (client) await client.logout().catch(() => client.close?.());
  }

  /** Highest UID currently in the mailbox, used to skip pre-existing mail. */
  async latestUid() {
    await this.connect();
    const status = await this.#imap.status(this.#config.mailbox ?? 'INBOX', { uidNext: true, messages: true });
    const next = Number(status?.uidNext);
    return Number.isFinite(next) && next > 1 ? next - 1 : 0;
  }

  /**
   * Fetch messages with a UID greater than `afterUid`.
   *
   * The sender is read from the lightweight envelope first and checked against
   * `allowSenders` before the body is requested. A monitored mailbox also
   * receives ordinary personal mail, and that content must not be downloaded
   * or parsed at all — not merely filtered after the fact.
   */
  async listMessages({ afterUid = 0, limit = 25, allowSenders = null } = {}) {
    await this.connect();
    const mailbox = this.#config.mailbox ?? 'INBOX';
    const allowed = allowSenders instanceof Set && allowSenders.size > 0 ? allowSenders : null;

    // Step 1: read only the lightweight envelopes. ImapFlow cannot run a second
    // fetch while one is being iterated, so the accepted UIDs are collected
    // first and their bodies pulled afterwards.
    const accepted = [];
    for await (const message of this.#imap.fetch(
      { uid: `${afterUid + 1}:*` },
      { uid: true, envelope: true },
      { uid: true },
    )) {
      // A range fetch that matches nothing still yields the last message, so
      // the UID bound is re-checked here.
      if (!Number.isFinite(message.uid) || message.uid <= afterUid) continue;
      if (allowed) {
        const from = normalizeAddress(message.envelope?.from?.[0]?.address);
        if (!from || !allowed.has(from)) continue;
      }
      accepted.push(message.uid);
      if (accepted.length >= limit) break;
    }

    // Step 2: fetch and parse the bodies of accepted senders only. Mail from
    // anyone else is never downloaded, so its content is not read at all.
    const found = [];
    for (const uid of accepted) {
      const source = await this.#fetchSource(uid);
      if (!source) continue;
      const parsed = await simpleParser(source);
      // Carry the UID alongside the parsed mail: it is the polling cursor and
      // is not part of the RFC822 source.
      parsed.uid = uid;
      found.push(parsed);
    }
    await this.#imap.mailboxOpen(mailbox, { readOnly: false }).catch(() => {});
    return found;
  }

  /** Read one message's RFC822 source by UID. */
  async #fetchSource(uid) {
    try {
      const message = await this.#imap.fetchOne(String(uid), { source: true }, { uid: true });
      return message?.source ?? null;
    } catch {
      return null;
    }
  }

  /** Send a reply inside the originating thread. */
  async sendReply({ to, subject, text, inReplyTo, references, attachments = [] } = {}) {
    const body = String(text ?? '').slice(0, MAX_REPLY_CHARS);
    const transport = await this.#transportFor();
    const info = await transport.sendMail({
      from: this.#config.from ?? this.#config.address,
      to,
      subject: subject || '(no subject)',
      text: body,
      // RFC 3834: mark this as an automatic reply so any bot on the other side
      // (including this mailbox replying to itself) can refuse to auto-answer
      // it. That is the standard loop break, and it lets a mailbox accept its
      // own address as a sender without risking an endless exchange.
      headers: { 'Auto-Submitted': 'auto-replied' },
      ...(inReplyTo ? { inReplyTo } : {}),
      ...(references?.length ? { references: references.join(' ') } : {}),
      ...(attachments.length ? { attachments } : {}),
    });
    return { sent: true, messageId: info?.messageId ?? null };
  }

  /** Send a standalone message (proactive delivery, no thread). */
  async sendText({ to, subject, text, attachments = [] } = {}) {
    return this.sendReply({ to, subject, text, attachments });
  }

  async #transportFor() {
    if (this.#transport) return this.#transport;
    this.#transport = nodemailer.createTransport({
      host: this.#config.smtpHost,
      port: this.#config.smtpPort,
      ...smtpSecurity(this.#config.smtpPort, this.#config.smtpSecure),
      auth: { user: this.#config.address, pass: this.#config.password },
      ...(this.#config.rejectUnauthorized === false ? { tls: { rejectUnauthorized: false } } : {}),
    });
    return this.#transport;
  }
}
