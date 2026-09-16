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

/** Skip auto-generated mail that would otherwise trigger a turn. */
const IGNORED_SENDER_PATTERNS = [
  /^(no-?reply|do-?not-?reply|mailer-daemon|postmaster|bounce)/i,
  /^(noreply|notification|notifications|newsletter|marketing)/i,
];

function isAutomatedSender(address) {
  const local = String(address ?? '').split('@')[0] ?? '';
  return IGNORED_SENDER_PATTERNS.some((pattern) => pattern.test(local));
}

/** Reply subject: keep one "Re:" prefix so threads stay grouped. */
export function replySubject(subject) {
  const text = String(subject ?? '').trim();
  if (!text) return 'Re: (no subject)';
  return /^re:/i.test(text) ? text : `Re: ${text}`;
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
  // Never answer our own mail: it would loop forever.
  if (address && from === normalizeAddress(address)) return null;
  if (isAutomatedSender(from)) return null;

  const references = parseMessageIds(parsed?.references);
  const inReplyTo = parseMessageIds(parsed?.inReplyTo);
  const conversationId = resolveThreadKey({
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
    content: body,
    plainText: typeof parsed?.text === 'string',
    images: [],
    files: attachments.map((attachment) => ({
      name: attachment.filename ?? 'attachment',
      size: attachment.size,
      mimeType: attachment.contentType,
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

  async sendFile(target, file) {
    const content = typeof file?.load === 'function' ? await file.load() : file?.content;
    return this.#api.sendReply({
      to: target?.to,
      subject: target?.subject,
      text: '',
      inReplyTo: target?.messageId,
      references: target?.references,
      attachments: [{ filename: file?.name ?? 'attachment', content }],
    });
  }

  async sendImage(target, image) {
    const content = typeof image?.load === 'function' ? await image.load() : image?.content;
    return this.#api.sendReply({
      to: target?.to,
      subject: target?.subject,
      text: '',
      inReplyTo: target?.messageId,
      references: target?.references,
      attachments: [{ filename: image?.name ?? 'image', content }],
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
  #password;
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
    config, password, harness, state, contextEnhancement, accessPolicy, logger = console,
    replyTimeoutMs = 600_000, pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
    createApi = (options) => new EmailApi(options),
  }) {
    if (!config || !password || !harness || !state) {
      throw new TypeError('EmailRuntime requires config, password, Harness, and state');
    }
    this.#config = config;
    this.#password = password;
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
          password: this.#password,
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
        // Start from "now": pre-existing mail in the mailbox must not be
        // replayed as new instructions on first connect.
        await this.#state.setCursor(await api.latestUid());
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
      const messages = await this.#api.listMessages({ afterUid: cursor, limit: 25 });
      for (const parsed of messages) {
        const uid = Number(parsed?.uid);
        const message = normalizeEmail(parsed, { address: this.#config.platformId, state: this.#state });
        if (message) {
          // Remember the thread chain before the turn runs so a reply that
          // arrives while the turn is still working still joins this session.
          for (const id of [message.messageId, ...message.replyTarget.references]) {
            this.#state.rememberThreadId(id, message.conversationId);
          }
          await this.#bridge.accept(message);
        }
        if (Number.isSafeInteger(uid) && uid > cursor) await this.#state.setCursor(uid);
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
