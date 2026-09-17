import { sendRememberedConnectionTest } from '../shared/connection-test.mjs';
import {
  EmailApi,
  normalizeAddress,
  parseMessageIds,
  resolveThreadKey,
  stripQuotedHistory,
} from './email-api.mjs';
import { createEmailBridgeStatus, EmailHarnessBridge } from './email-bridge.mjs';
import { EMAIL_CLIENT_DEFAULTS } from './config-store.mjs';

const DEFAULT_POLL_INTERVAL_MS = EMAIL_CLIENT_DEFAULTS.pollIntervalMs;

/**
 * How far behind the mailbox tip the first poll starts. Leaving a small window
 * means mail that lands while the channel is starting is not skipped, while the
 * rest of the backlog stays untouched.
 */
const FIRST_CONNECT_WINDOW = 10;

/** Skip auto-generated mail that would otherwise trigger a turn. */
const IGNORED_SENDER_PATTERNS = [
  /^(no-?reply|do-?not-?reply|mailer-daemon|postmaster|bounce)/i,
  /^(noreply|notification|notifications|newsletter|marketing)/i,
];

function isAutomatedSender(address) {
  const local = String(address ?? '').split('@')[0] ?? '';
  return IGNORED_SENDER_PATTERNS.some((pattern) => pattern.test(local));
}

/**
 * True when a message declares itself an automatic reply (RFC 3834). Any value
 * other than "no" counts, matching the standard: "auto-replied",
 * "auto-generated", "auto-notified".
 */
export function isAutoSubmitted(parsed) {
  const raw = parsed?.headers?.get?.('auto-submitted')
    ?? (Array.isArray(parsed?.headerLines)
      ? parsed.headerLines.find((line) => /^auto-submitted:/i.test(line?.line ?? ''))?.line
        ?.slice('auto-submitted:'.length)
      : undefined);
  const value = String(raw ?? '').trim().toLowerCase();
  return value !== '' && value !== 'no';
}

/** Reply subject: keep one "Re:" prefix so threads stay grouped. */
export function replySubject(subject) {
  const text = String(subject ?? '').trim();
  if (!text) return 'Re: (no subject)';
  return /^re:/i.test(text) ? text : `Re: ${text}`;
}

/** Format one address list (To/Cc) as a compact "Name <addr>" string. */
function formatAddressList(value) {
  const entries = Array.isArray(value?.value) ? value.value : [];
  return entries
    .map((entry) => {
      const address = normalizeAddress(entry?.address);
      if (!address) return null;
      const name = String(entry?.name ?? '').trim();
      return name ? `${name} <${address}>` : address;
    })
    .filter(Boolean);
}

/**
 * Compose the text the model actually receives.
 *
 * Only the body used to be forwarded, so an instruction written in the subject
 * — a natural place for one — was silently dropped, and a message that also
 * went to other recipients looked like a private note. The subject and the
 * recipient lists are therefore prepended as a small header, and the original
 * body is left untouched below it.
 */
export function mailPromptContent({ body, subject, parsed }) {
  const header = [];
  const cleanSubject = String(subject ?? '').trim();
  if (cleanSubject) header.push(`Subject: ${cleanSubject}`);

  const from = formatAddressList(parsed?.from)[0];
  if (from) header.push(`From: ${from}`);

  const to = formatAddressList(parsed?.to);
  if (to.length) header.push(`To: ${to.join(', ')}`);

  const cc = formatAddressList(parsed?.cc);
  if (cc.length) header.push(`Cc: ${cc.join(', ')}`);

  const text = String(body ?? '').trim();
  // A body-less mail (attachment only) still carries its header, so the model
  // sees what the message was about.
  if (header.length === 0) return text;
  return text ? `${header.join('\n')}\n\n${text}` : header.join('\n');
}

/**
 * Turn one parsed mail into the shared bridge's inbound message shape, or null
 * when the mail must be ignored (self-sent, automated, empty body).
 */
export function normalizeEmail(parsed, { address, state } = {}) {
  const messageId = parseMessageIds(parsed?.messageId)[0] ?? null;
  if (!messageId) return null;
  const from = normalizeAddress(parsed?.from?.value?.[0]?.address ?? parsed?.from?.text);
  if (!from) return null;
  // Loop break, per RFC 3834: anything marked as an automatic reply is never
  // answered, so this mailbox can safely be its own sender (writing to itself
  // to drive the Harness) without two bots echoing each other forever.
  if (isAutoSubmitted(parsed)) return null;
  if (isAutomatedSender(from)) return null;

  const references = parseMessageIds(parsed?.references);
  const inReplyTo = parseMessageIds(parsed?.inReplyTo);
  // A fixed binding pins the conversation, so every message routed to that
  // binding resolves to the same Harness session instead of a per-thread one.
  // Without a binding the thread chain decides, which keeps one Harness session
  // per mail thread.
  const boundSession = state?.boundSessionFor?.(from) ?? null;
  const conversationId = boundSession
    ? `bound:${boundSession}`
    : resolveThreadKey({
      messageId,
      references,
      inReplyTo,
      conversationMap: state?.threadMap ?? new Map(),
    });
  const body = stripQuotedHistory(parsed?.text ?? parsed?.html ?? '');
  const attachments = Array.isArray(parsed?.attachments) ? parsed.attachments : [];
  if (!body && attachments.length === 0) return null;

  const subject = String(parsed?.subject ?? '').trim();
  return {
    messageId,
    conversationId,
    kind: 'direct',
    senderId: from,
    addressed: true,
    // Email has no notion of a display name we can trust; the address is both.
    senderName: parsed?.from?.value?.[0]?.name || from,
    senderAlternateId: undefined,
    content: mailPromptContent({ body, subject, parsed }),
    plainText: typeof parsed?.text === 'string',
    images: [],
    files: attachments.map((attachment) => ({
      name: attachment.filename ?? 'attachment',
      size: attachment.size,
      // The shared inbound-file layer reads `mediaType` (not `mimeType`), so an
      // attachment type under any other key is silently dropped.
      ...(attachment.contentType ? { mediaType: String(attachment.contentType) } : {}),
      // The bridge streams files via a loader so large attachments are not
      // held in memory until they are actually needed.
      load: async () => attachment.content,
    })),
    reactionTarget: null,
    replyTarget: {
      to: from,
      subject: replySubject(subject),
      messageId,
      references: [...references, ...inReplyTo, messageId].slice(-10),
    },
    connectionTestTarget: { to: from, subject: 'DSH 连接测试' },
  };
}

/** Bot client handed to the shared bridge: only sending is needed here. */
class EmailBotClient {
  #api;
  #signal;
  constructor(api, signal) {
    this.#api = api;
    this.#signal = signal;
  }

  async sendText(target, text) {
    const to = target?.to;
    if (!to) {
      const error = new TypeError('Email reply requires a recipient');
      error.code = 'invalid-target';
      throw error;
    }
    return this.#api.sendReply({
      to,
      subject: target.subject,
      text,
      inReplyTo: target.messageId,
      references: target.references,
    });
  }

  sendTyping() {
    // Mail has no typing indicator; the shared bridge degrades gracefully.
    return Promise.resolve();
  }

  /**
   * Outbound artifacts arrive as the shared materialized shape
   * ({ fileName, mediaType, bytes }), the same structure every other channel
   * consumes — not the { name, content } form.
   */
  #attachmentFrom(file, fallbackName) {
    const bytes = file?.bytes ?? file?.data ?? file?.content;
    return {
      filename: file?.fileName ?? file?.name ?? fallbackName,
      content: bytes,
      ...(file?.mediaType ? { contentType: file.mediaType } : {}),
    };
  }

  async sendFile(target, file) {
    return this.#api.sendReply({
      to: target?.to,
      subject: target?.subject,
      text: '',
      inReplyTo: target?.messageId,
      references: target?.references,
      attachments: [this.#attachmentFrom(file, 'attachment')],
    });
  }

  async sendImage(target, image) {
    return this.#api.sendReply({
      to: target?.to,
      subject: target?.subject,
      text: '',
      inReplyTo: target?.messageId,
      references: target?.references,
      attachments: [this.#attachmentFrom(image, 'image')],
    });
  }
}

export function createEmailRuntimeStatus() {
  return {
    startedAt: null,
    ready: false,
    connectionState: 'idle',
    harnessReachable: false,
    lastCheckedAt: null,
    lastConnectedAt: null,
    lastError: null,
    ...createEmailBridgeStatus(),
  };
}

export class EmailRuntime {
  #config;
  #token;
  #harness;
  #state;
  #contextEnhancement;
  #accessPolicy;
  #logger;
  #replyTimeoutMs;
  #pollIntervalMs;
  #createApi;
  #status = createEmailRuntimeStatus();
  #api;
  #bridge;
  #abortController;
  #timer;
  #polling;
  #stopped = true;

  constructor({
    config, token, harness, state, contextEnhancement, accessPolicy, logger = console,
    replyTimeoutMs = 600_000, pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
    createApi = (options) => new EmailApi(options),
  }) {
    if (!config || !token || !harness || !state) {
      throw new TypeError('EmailRuntime requires config, token, Harness, and state');
    }
    this.#config = config;
    this.#token = token;
    this.#harness = harness;
    this.#state = state;
    this.#contextEnhancement = contextEnhancement;
    this.#accessPolicy = accessPolicy;
    this.#logger = logger;
    this.#replyTimeoutMs = replyTimeoutMs;
    this.#pollIntervalMs = pollIntervalMs;
    this.#createApi = createApi;
  }

  get status() {
    return structuredClone(this.#status);
  }

  async sendConnectionTest(text) {
    if (!this.#status.ready || !this.#api) {
      const error = new Error('Email mailbox is not connected');
      error.code = 'test-target-unavailable';
      throw error;
    }
    await sendRememberedConnectionTest({
      state: this.#state,
      text,
      channelLabel: 'Email',
      send: (target, value) => this.#api.sendReply({
        to: target.to,
        subject: target.subject ?? 'DSH 连接测试',
        text: value,
      }),
    });
  }

  async sendProactiveText(target, text, options = {}) {
    if (!this.#status.ready || !this.#api) {
      const error = new Error('Email mailbox is not connected');
      error.code = 'bot-not-connected';
      throw error;
    }
    const to = normalizeAddress(target?.route?.address);
    if (!to) {
      const error = new TypeError('Invalid Email proactive delivery target');
      error.code = 'invalid-target';
      throw error;
    }
    await this.#api.sendText({ to, subject: target?.route?.subject ?? 'DSH 消息', text });
    return { sent: true };
  }

  async start() {
    if (this.#status.ready) return this.status;
    await this.stop();
    this.#stopped = false;
    this.#status.startedAt = new Date().toISOString();
    this.#status.connectionState = 'connecting';
    this.#abortController = new AbortController();
    try {
      await this.#harness.ensureRunning();
      this.#status.harnessReachable = true;
      const api = this.#createApi({
        config: {
          address: this.#config.platformId,
          password: this.#token,
          imapHost: this.#config.imapHost,
          imapPort: this.#config.imapPort,
          smtpHost: this.#config.smtpHost,
          smtpPort: this.#config.smtpPort,
          mailbox: this.#config.mailbox ?? EMAIL_CLIENT_DEFAULTS.mailbox,
        },
        signal: this.#abortController.signal,
      });
      this.#api = api;
      if (this.#state.cursor() === null) {
        // On first connect the existing backlog must not be replayed as new
        // instructions, so polling starts near the mailbox tip. A small window
        // before the tip is still scanned though: a message that arrives while
        // the channel is starting up would otherwise be skipped forever. Those
        // few older messages are filtered by the sender allowlist and the
        // seen-message set, so the window cannot re-drive old requests.
        const tip = await api.latestUid();
        // IMAP numbers messages, so a small window can be stepped back to pick
        // up mail that arrived during startup. An opaque string cursor has no
        // ordering to step back through, so it starts at the tip.
        await this.#state.setCursor(
          Number.isSafeInteger(tip) ? Math.max(0, tip - FIRST_CONNECT_WINDOW) : tip,
        );
      }
      const client = new EmailBotClient(api, this.#abortController.signal);
      this.#bridge = new EmailHarnessBridge({
        bot: client,
        harness: this.#harness,
        state: this.#state,
        contextEnhancement: this.#contextEnhancement,
        accessPolicy: this.#accessPolicy,
        status: this.#status,
        logger: this.#logger,
        replyTimeoutMs: this.#replyTimeoutMs,
        signal: this.#abortController.signal,
      });
      this.#status.ready = true;
      this.#status.connectionState = 'connected';
      this.#status.lastConnectedAt = Date.now();
      this.#schedulePoll(0);
      return this.status;
    } catch (error) {
      this.#status.ready = false;
      this.#status.connectionState = 'failed';
      this.#status.lastError = error.message;
      await this.stop();
      throw error;
    }
  }

  async stop() {
    this.#stopped = true;
    clearTimeout(this.#timer);
    this.#timer = null;
    this.#abortController?.abort();
    await this.#polling?.catch(() => {});
    this.#polling = null;
    const api = this.#api;
    this.#api = null;
    this.#bridge = null;
    if (api) await api.disconnect().catch(() => {});
    this.#status.ready = false;
  }

  #schedulePoll(delay) {
    if (this.#stopped) return;
    this.#timer = setTimeout(() => {
      this.#polling = this.#poll().finally(() => this.#schedulePoll(this.#pollIntervalMs));
    }, delay);
    this.#timer.unref?.();
  }

  async #poll() {
    if (!this.#api || !this.#bridge || this.#stopped) return;
    try {
      const cursor = this.#state.cursor() ?? 0;
      // Pass the mailbox allowlist down so unlisted mail is never downloaded.
      const allowSenders = new Set(
        (this.#config.allowedSenders ?? []).map((a) => String(a).trim().toLowerCase()),
      );
      const messages = await this.#api.listMessages({ afterUid: cursor, limit: 25, allowSenders });
      for (const parsed of messages) {
        // Transports address messages by an integer UID (IMAP) or an opaque
        // string id (Agent mailbox); the cursor follows whichever it is.
        const uid = parsed?.uid;
        const message = normalizeEmail(parsed, { address: this.#config.platformId, state: this.#state });
        if (message) {
          // Remember the thread chain before the turn runs so a reply that
          // arrives while the turn is still working still joins this session.
          for (const id of [message.messageId, ...message.replyTarget.references]) {
            this.#state.rememberThreadId(id, message.conversationId);
          }
          await this.#bridge.accept(message);
        }
        if (uid !== undefined && uid !== null && uid !== '' && uid !== cursor) {
          await this.#state.setCursor(uid);
        }
      }
      this.#status.lastCheckedAt = Date.now();
      this.#status.lastError = null;
    } catch (error) {
      if (!this.#stopped) {
        this.#status.lastError = error.message;
        this.#logger.warn?.('[dsh-im:email] polling failed', error);
      }
    }
  }
}
