/**
 * Tencent Agent Mail transport (agent.qq.com).
 *
 * Not a standard mailbox: it authorizes by QR code, reads mail by long-polling
 * an event stream, and speaks HTTP instead of IMAP/SMTP. Everything above the
 * transport — thread mapping, the sender allowlist, quote stripping, session
 * binding, loop prevention — is shared with the IMAP/SMTP transport.
 *
 * Protocol notes live in docs/agent-mail-protocol.md.
 */
import { normalizeAddress, parseMessageIds } from '../mail-format.mjs';

const API_BASE = 'https://api.agent.qq.com';
const AUTH_BASE = 'https://auth.agent.qq.com';
// Public, version-bound constants from the official CLI (agently-cli v1.0.15).
const CLIENT_ID = 'cli_002e8cd1f5e97858';
const CLIENT_VERSION = '1.0.15';
// The server validates the client identity by User-Agent; an unrecognized one
// is rejected as "unsupported client", so the official CLI value is required.
const USER_AGENT = 'agently-cli/1.0.15 (windows/amd64; agent/workbuddy)';
const REQUEST_TIMEOUT_MS = 15_000;
const POLL_TIMEOUT_MS = 25_000;
/** How many messages one poll may return. */
const DEFAULT_PAGE_SIZE = 25;

export class AgentMailError extends Error {
  constructor(message, { code = 'agent-mail-error', status = null } = {}) {
    super(message);
    this.name = 'AgentMailError';
    this.code = code;
    this.status = status;
  }
}

/** Device-flow constants, exported so the settings UI can drive authorization. */
export const AGENT_MAIL_DEVICE = Object.freeze({
  authBase: AUTH_BASE,
  clientId: CLIENT_ID,
  clientVersion: CLIENT_VERSION,
  userAgent: USER_AGENT,
  pollIntervalMs: 5_000,
  // Fallback only: the server states expires_in per flow (currently 600s) and
  // startAgentMailDeviceFlow returns that. Assuming a shorter window abandons
  // authorizations the server still considers valid.
  pollTimeoutMs: 600_000,
});

/**
 * Start the QR device flow: returns the URL to show as a code and the poll
 * endpoint to watch. The authorization page embeds its own WeChat QR, so the
 * caller displays this URL rather than a one-shot scan payload.
 */
export async function startAgentMailDeviceFlow({
  fetchImpl = fetch,
  hostname = 'dsh',
  signal,
} = {}) {
  const response = await fetchImpl(`${AUTH_BASE}/oauth/device?func=1`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'user-agent': USER_AGENT },
    body: JSON.stringify({
      app_id: CLIENT_ID,
      cli_agentname: 'WorkBuddy',
      cli_agentua: 'workbuddy',
      cli_hostname: hostname,
      cli_ua: USER_AGENT,
      cli_version: CLIENT_VERSION,
    }),
    signal,
  });
  if (!response.ok) {
    throw new AgentMailError(`device flow init failed: HTTP ${response.status}`, {
      code: 'device-flow-failed', status: response.status,
    });
  }
  const body = await response.json().catch(() => null);
  if (!body?.poll_url) {
    throw new AgentMailError('device flow returned no poll_url', { code: 'device-flow-invalid' });
  }
  const expiresIn = Number(body.expires_in);
  return {
    pollUrl: String(body.poll_url),
    browserUrl: String(body.browser_url ?? ''),
    inputCode: String(body.input_code ?? ''),
    // The server states how long the code stays valid; honour it rather than
    // assuming a window, which previously expired the flow early.
    expiresInMs: Number.isFinite(expiresIn) && expiresIn > 0
      ? expiresIn * 1_000
      : AGENT_MAIL_DEVICE.pollTimeoutMs,
  };
}

/** Poll the device flow once. Returns the tokens when the user has authorized. */
export async function pollAgentMailDeviceFlow({ pollUrl, fetchImpl = fetch, signal } = {}) {
  const response = await fetchImpl(pollUrl, {
    headers: { 'user-agent': USER_AGENT },
    signal,
  });
  if (!response.ok) {
    throw new AgentMailError(`device poll failed: HTTP ${response.status}`, {
      code: 'device-poll-failed', status: response.status,
    });
  }
  const body = await response.json().catch(() => null);
  if (!body || typeof body !== 'object') {
    throw new AgentMailError('device poll returned a non-JSON response', {
      code: 'device-poll-invalid',
    });
  }
  const status = String(body.status ?? 'pending');
  if (status !== 'authorized') return { status, tokens: null };
  if (!body.access_token) {
    throw new AgentMailError('authorized but no access_token returned', {
      code: 'device-poll-invalid',
    });
  }
  return {
    status,
    tokens: {
      accessToken: String(body.access_token),
      refreshToken: String(body.refresh_token ?? ''),
    },
  };
}

/** Fetch wrapper with the SDK's required headers and an explicit timeout. */
async function request(fetchImpl, url, { method = 'GET', token, body, signal } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  const onAbort = () => controller.abort();
  signal?.addEventListener?.('abort', onAbort, { once: true });
  try {
    const headers = { 'user-agent': USER_AGENT, accept: 'application/json' };
    if (token) headers.authorization = `Bearer ${token}`;
    if (body !== undefined) headers['content-type'] = 'application/json';
    const response = await fetchImpl(url, {
      method,
      headers,
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      signal: controller.signal,
    });
    const text = await response.text();
    let parsed = null;
    try { parsed = text ? JSON.parse(text) : null; } catch { parsed = text; }
    return { status: response.status, body: parsed };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener?.('abort', onAbort);
  }
}

/** Map one API message onto the mailparser-shaped object the runtime expects. */
export function normalizeAgentMailMessage(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const id = String(raw.id ?? raw.message_id ?? '').trim();
  if (!id) return null;
  const bodyText = typeof raw.body === 'string'
    ? raw.body
    : typeof raw.text === 'string' ? raw.text : '';
  return {
    uid: id,
    messageId: String(raw.message_id ?? raw.messageId ?? id),
    from: { value: [{ address: normalizeAddress(raw.from?.email ?? raw.from), name: raw.from?.name }] },
    to: { value: (Array.isArray(raw.to) ? raw.to : []).map((entry) => ({
      address: normalizeAddress(entry?.email ?? entry), name: entry?.name,
    })).filter((entry) => entry.address) },
    cc: { value: (Array.isArray(raw.cc) ? raw.cc : []).map((entry) => ({
      address: normalizeAddress(entry?.email ?? entry), name: entry?.name,
    })).filter((entry) => entry.address) },
    subject: String(raw.subject ?? ''),
    text: bodyText,
    html: typeof raw.body_html === 'string' ? raw.body_html : '',
    attachments: (Array.isArray(raw.attachments) ? raw.attachments : []).map((file) => ({
      filename: String(file?.name ?? file?.filename ?? 'attachment'),
      contentType: String(file?.content_type ?? file?.contentType ?? 'application/octet-stream'),
      size: Number.isSafeInteger(file?.size) ? file.size : undefined,
      // Downloaded lazily so a poll of headers does not pull every attachment.
      attachmentId: String(file?.id ?? file?.attachment_id ?? ''),
    })),
    headers: { get: (name) => {
      const key = String(name).toLowerCase();
      const value = raw.headers?.[key] ?? raw.headers?.[name];
      return typeof value === 'string' ? value : undefined;
    } },
  };
}

export class AgentMailTransport {
  #config;
  #signal;
  #fetch;
  #token;
  #refreshToken;
  #onTokensRefreshed;
  #aliasId = null;
  #email = '';
  #connected = false;

  constructor({ config, signal, fetchImpl = fetch, onTokensRefreshed = null } = {}) {
    if (!config?.address && !config?.accessToken) {
      throw new TypeError('AgentMailTransport requires an address or an access token');
    }
    this.#config = config;
    this.#signal = signal;
    this.#fetch = fetchImpl;
    this.#token = config.accessToken ?? '';
    this.#refreshToken = config.refreshToken ?? '';
    this.#onTokensRefreshed = typeof onTokensRefreshed === 'function' ? onTokensRefreshed : null;
  }

  get address() {
    return this.#config.address ?? this.#email;
  }

  async connect() {
    if (this.#connected) return;
    await this.#requireAlias();
    this.#connected = true;
  }

  async disconnect() {
    // Stateless HTTP: nothing to tear down, but the call must be idempotent.
    this.#connected = false;
  }

  /**
   * The runtime treats the cursor as an opaque, ordered value. The API pages by
   * an opaque cursor string, so the newest seen message id is used as one.
   */
  async latestUid() {
    const listed = await this.listMessages({ afterUid: null, limit: 1 });
    return listed.length > 0 ? listed[0].uid : 0;
  }

  /**
   * New mail, oldest first. The API exposes a cursor rather than an id range,
   * so `afterUid` is the id of the last message already processed; messages up
   * to and including it are skipped.
   */
  async listMessages({ afterUid = null, limit = DEFAULT_PAGE_SIZE, allowSenders = null } = {}) {
    const allowed = allowSenders instanceof Set && allowSenders.size > 0 ? allowSenders : null;
    const aliasId = await this.#requireAlias();
    const collected = [];
    let cursor = '';
    // The API pages newest-first; walk until the already-seen id is reached or
    // enough messages have been gathered.
    for (let page = 0; page < 5; page += 1) {
      const query = [`limit=${DEFAULT_PAGE_SIZE}`, 'dir=inbox'];
      if (cursor) query.push(`cursor=${encodeURIComponent(cursor)}`);
      const { status, body } = await this.#request('GET', `/v1/aliases/${aliasId}/messages?${query.join('&')}`);
      if (status >= 400) {
        throw new AgentMailError(`list messages failed: HTTP ${status}`, {
          code: 'list-failed', status,
        });
      }
      const items = Array.isArray(body?.data) ? body.data : [];
      for (const raw of items) {
        const id = String(raw?.id ?? raw?.message_id ?? '');
        if (afterUid !== null && afterUid !== undefined && id === String(afterUid)) {
          return this.#oldestFirst(collected, allowed);
        }
        if (allowed) {
          const from = normalizeAddress(raw?.from?.email ?? raw?.from);
          if (!from || !allowed.has(from)) continue;
        }
        collected.push(raw);
        if (collected.length >= limit) return this.#oldestFirst(collected, allowed);
      }
      cursor = String(body?.pagination?.next_cursor ?? body?.pagination?.cursor ?? '');
      if (!cursor || items.length === 0) break;
    }
    return this.#oldestFirst(collected, allowed);
  }

  /** Attachments download separately, so they are attached here as loaders. */
  #oldestFirst(items, allowed) {
    return items
      .slice()
      .reverse()
      .map((raw) => normalizeAgentMailMessage(raw))
      .filter(Boolean)
      .map((message) => {
        if (message.attachments.length === 0) return message;
        const aliasId = this.#aliasId;
        return {
          ...message,
          attachments: message.attachments.map((file) => ({
            ...file,
            load: async () => {
              if (!file.attachmentId) return Buffer.alloc(0);
              const { status, body } = await this.#request(
                'GET',
                `/v1/aliases/${aliasId}/messages/${message.uid}/attachments/${file.attachmentId}`,
              );
              if (status >= 400) {
                throw new AgentMailError(`attachment download failed: HTTP ${status}`, {
                  code: 'attachment-failed', status,
                });
              }
              return body;
            },
          })),
        };
      })
      .filter((message) => !allowed || allowed.has(normalizeAddress(message.from?.value?.[0]?.address)));
  }

  async sendReply({
    to, subject, text, inReplyTo, transportMessageId, references, attachments = [],
  } = {}) {
    const aliasId = await this.#requireAlias();
    // The reply endpoint addresses the message by the API's own id, not the RFC
    // Message-ID header. A transport id is preferred; the RFC one is only a
    // fallback for a runtime that did not supply it.
    const apiId = String(transportMessageId ?? '').trim()
      || stripBrackets(parseMessageIds(inReplyTo)[0] ?? '');
    // A reply inside a known thread uses the reply endpoint so the server keeps
    // the conversation headers; otherwise it is a fresh message.
    if (apiId) {
      const payload = {
        body: String(text ?? ''),
        body_format: 'PLAIN',
        reply_all: false,
        ...(attachments.length ? { attachments: await this.#encodeAttachments(attachments) } : {}),
      };
      const sent = await this.#sendWithConfirmation(
        `/v1/aliases/${aliasId}/messages/${encodeURIComponent(apiId)}/reply`,
        payload,
      );
      return { sent: true, messageId: sent?.data?.id ?? null };
    }
    return this.sendText({ to, subject, text, attachments });
  }

  async sendText({ to, subject, text, attachments = [] } = {}) {
    const aliasId = await this.#requireAlias();
    const payload = {
      to: [{ email: normalizeAddress(to) }],
      subject: String(subject ?? ''),
      body: String(text ?? ''),
      body_format: 'PLAIN',
      ...(attachments.length ? { attachments: await this.#encodeAttachments(attachments) } : {}),
    };
    const sent = await this.#sendWithConfirmation(`/v1/aliases/${aliasId}/messages/send`, payload);
    return { sent: true, messageId: sent?.data?.id ?? null };
  }

  async #encodeAttachments(attachments) {
    return Promise.all(attachments.map(async (file) => ({
      name: String(file?.filename ?? 'attachment'),
      content: Buffer.from(file?.content ?? '').toString('base64'),
      content_type: file?.contentType ?? 'application/octet-stream',
    })));
  }

  /**
   * The server may answer the first send with CONFIRMATION_REQUIRED; resending
   * with the returned token completes it. This is part of the protocol, not an
   * error.
   */
  async #sendWithConfirmation(path, payload) {
    const first = await this.#request('POST', path, payload);
    const error = first.body?.error;
    if (first.status < 400 && error?.code !== 'CONFIRMATION_REQUIRED') {
      return first.body;
    }
    if (error?.code === 'CONFIRMATION_REQUIRED') {
      const details = error.details ?? {};
      const token = details.confirmation_token ?? details.confirmationToken;
      if (!token) {
        throw new AgentMailError('send requires confirmation but returned no token', {
          code: 'confirmation-missing',
        });
      }
      const confirmed = await this.#request('POST', path, { ...payload, confirmation_token: token });
      if (confirmed.status >= 400) {
        throw new AgentMailError(`send confirmation failed: HTTP ${confirmed.status}`, {
          code: 'send-failed', status: confirmed.status,
        });
      }
      return confirmed.body;
    }
    throw new AgentMailError(`send failed: HTTP ${first.status}`, {
      code: 'send-failed', status: first.status,
    });
  }

  /** One API call with Bearer auth; a 401 refreshes once and retries. */
  async #request(method, path, body) {
    const first = await request(this.#fetch, `${API_BASE}${path}`, {
      method, token: this.#token, body, signal: this.#signal,
    });
    if (first.status !== 401 || !this.#refreshToken) return first;
    const refreshed = await this.#refresh();
    if (!refreshed) return first;
    return request(this.#fetch, `${API_BASE}${path}`, {
      method, token: this.#token, body, signal: this.#signal,
    });
  }

  /** Exchange the refresh token; the server rotates it, so it is persisted. */
  async #refresh() {
    const form = new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: this.#refreshToken,
      client_id: CLIENT_ID,
      clientversion: CLIENT_VERSION,
    });
    const response = await this.#fetch(`${AUTH_BASE}/oauth/token`, {
      method: 'POST',
      headers: { 'user-agent': USER_AGENT, 'content-type': 'application/x-www-form-urlencoded' },
      body: form.toString(),
    }).catch(() => null);
    if (!response?.ok) return false;
    const body = await response.json().catch(() => null);
    if (!body?.access_token) return false;
    this.#token = String(body.access_token);
    if (body.refresh_token) this.#refreshToken = String(body.refresh_token);
    // A rotated refresh token must survive a restart, or the next refresh fails.
    await this.#onTokensRefreshed?.({
      accessToken: this.#token,
      refreshToken: this.#refreshToken,
    });
    return true;
  }

  /** Resolve the account's alias id, caching it for the connection's lifetime. */
  async #requireAlias() {
    if (this.#aliasId) return this.#aliasId;
    const { status, body } = await this.#request('GET', '/v1/me');
    if (status >= 400) {
      throw new AgentMailError(`/v1/me failed: HTTP ${status}`, {
        code: 'identity-failed', status,
      });
    }
    const aliases = Array.isArray(body?.data?.aliases) ? body.data.aliases : [];
    const primary = aliases.find((entry) => entry?.is_primary) ?? aliases[0];
    const aliasId = String(primary?.alias_id ?? '').trim();
    if (!aliasId) {
      throw new AgentMailError('no alias_id returned by /v1/me', { code: 'identity-missing' });
    }
    this.#aliasId = aliasId;
    this.#email = String(primary?.email ?? '').trim();
    return aliasId;
  }
}

/** Message ids travel with angle brackets; the API path does not use them. */
function stripBrackets(value) {
  return String(value ?? '').replace(/^<|>$/g, '');
}
