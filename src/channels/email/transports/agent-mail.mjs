/**
 * Agent mailbox transport, backed by the official `agently-cli`.
 *
 * This transport speaks the same contract as the IMAP/SMTP one
 * (`transport.mjs`); only the wire protocol differs. All protocol knowledge —
 * OAuth, token storage, refresh, retry — belongs to the CLI, which is the only
 * implementation the server accepts refresh tokens from.
 *
 * Command shapes come from `--print-output-schema`, not guesswork.
 */

import {
  AgentMailCliError,
  cliEnv,
  isCliAvailable,
  runCli,
  startCliLogin,
} from './agently-cli.mjs';
import {
  MAX_REPLY_CHARS,
  normalizeAddress,
  stripQuotedHistory,
} from '../mail-format.mjs';
import { assertTransport, replySubject } from '../transport.mjs';

/** Re-exported so callers keep one import site for Agent mailbox errors. */
export { AgentMailCliError as AgentMailError };

/** How many messages one poll may return. */
const DEFAULT_PAGE_SIZE = 25;

/** Mailbox folders the CLI understands. */
const INBOX = 'inbox';

/**
 * Begin an authorization and return the URL the user opens or scans.
 *
 * `agently-cli auth login` prints the URL and then blocks until the scan
 * completes, so the process is left running and the caller observes the outcome
 * through `agentMailAuthorizationStatus`.
 */
export async function startAgentMailAuthorization({ signal, workspace } = {}) {
  const started = await startCliLogin({ signal, workspace });
  return {
    browserUrl: started.browserUrl,
    inputCode: started.inputCode,
    // The window belongs to the server; this is the CLI's own default.
    expiresInMs: 600_000,
  };
}

/** The authorization status, as the CLI reports it. */
export async function agentMailAuthorizationStatus({ signal, workspace } = {}) {
  try {
    const { document } = await runCli(['auth', 'status'], { signal, env: cliEnv(workspace) });
    const data = document?.data ?? {};
    return {
      loggedIn: data.logged_in === true,
      status: String(data.status ?? ''),
      message: String(data.message ?? ''),
      workspace: String(data.workspace ?? ''),
    };
  } catch (error) {
    if (error?.code === 'auth') return { loggedIn: false, status: 'not_logged_in', message: error.message };
    throw error;
  }
}

/** Force a token refresh through the CLI. */
export async function refreshAgentMailToken({ signal } = {}) {
  await runCli(['auth', 'refresh'], { signal });
  return true;
}

/** The account's own address, from `+me`. */
export async function fetchAgentMailIdentity({ signal, workspace } = {}) {
  const { document } = await runCli(['+me'], { signal, env: cliEnv(workspace) });
  const aliases = Array.isArray(document?.data?.aliases) ? document.data.aliases : [];
  const primary = aliases.find((entry) => entry?.is_primary) ?? aliases[0];
  const address = normalizeAddress(primary?.email);
  if (!address) {
    throw new AgentMailCliError('agently-cli reported no mailbox address', {
      code: 'identity-missing',
    });
  }
  return {
    address,
    aliasId: String(primary?.alias_id ?? '').trim(),
    name: String(primary?.name ?? '').trim(),
  };
}

/** One message summary or full message, in this channel's shape. */
export function normalizeAgentMailMessage(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const id = String(raw.message_id ?? '').trim();
  if (!id) return null;
  const addressOf = (entry) => normalizeAddress(entry?.email ?? entry);
  const people = (list) => (Array.isArray(list) ? list : [])
    .map((entry) => ({ address: addressOf(entry), name: entry?.name }))
    .filter((entry) => entry.address);
  return {
    // `uid` is the CLI's own id, used for every follow-up command.
    uid: id,
    // The RFC Message-ID is the thread key; it only comes with the full read.
    messageId: String(raw.rfc_message_id ?? '').trim(),
    from: { value: people(raw.from ? [raw.from] : []) },
    to: { value: people(raw.to) },
    cc: { value: people(raw.cc) },
    subject: String(raw.subject ?? ''),
    text: typeof raw.body === 'string' ? raw.body : String(raw.snippet ?? ''),
    html: '',
    // Field names follow what the runtime reads (`filename`/`size`/
    // `contentType`); the API's own names live on the right, and the earlier
    // aliases (`fileName`/`bytes`/`mediaType`) were simply ignored, so an
    // inbound attachment arrived with no name, no size and no type.
    attachments: (Array.isArray(raw.attachments) ? raw.attachments : []).map((file) => ({
      filename: String(file?.filename ?? 'attachment'),
      size: Number(file?.size) || 0,
      ...(file?.content_type ? { contentType: String(file.content_type) } : {}),
      attachmentId: String(file?.attachment_id ?? ''),
      // A large attachment exposes a download URL instead of an id.
      ...(file?.download_url ? { downloadUrl: String(file.download_url) } : {}),
    })),
    headers: { get: () => undefined },
  };
}

export class AgentMailTransport {
  #config;
  #signal;
  #connected = false;
  #address = '';
  // Indirection so tests can drive the protocol without the real binary.
  #run = runCli;
  #workspace = '';
  // undefined = not yet probed; '' = use the CLI default.
  #workspaceResolved;

  /** Test seam: swap the CLI runner. Not part of the transport contract. */
  __setRunCliForTests(impl) {
    if (typeof impl === 'function') this.#run = impl;
  }

  /**
   * The workspace to call the CLI in.
   *
   * agently-cli separates accounts per workspace, so a mailbox normally reads
   * from its own. That matters only when several workspaces have logins: with a
   * single authorized account every mailbox belongs to it, and pinning each one
   * to a workspace nobody logged into just reports "authorization required".
   * The pinned workspace is therefore used when it has a login, and the CLI's
   * default otherwise.
   */
  async #workspaceFor() {
    if (this.#workspaceResolved !== undefined) return this.#workspaceResolved;
    let resolved = '';
    if (this.#workspace) {
      try {
        const { document } = await this.#run(['auth', 'status'], { signal: this.#signal, env: cliEnv(this.#workspace) });
        if (document?.data?.logged_in === true) resolved = this.#workspace;
      } catch {
        // No login there; fall through to the CLI default.
      }
    }
    this.#workspaceResolved = resolved;
    return resolved;
  }

  /**
   * The mailbox this transport is actually talking to.
   *
   * A fallback to the CLI default is only safe when that login owns this
   * address. Reusing another mailbox's login would silently send this
   * mailbox's replies from the wrong sender, which the recipient sees as a
   * stranger answering them.
   */
  async #assertIdentity(address) {
    // Callers pass the mailbox as `address` (the runtime and the bind probe
    // both do); `platformId` is the same value under its config-store name.
    // Reading only one of them left `wanted` empty and skipped the check.
    const wanted = normalizeAddress(this.#config.address) || normalizeAddress(this.#config.platformId);
    if (!wanted) {
      throw new AgentMailCliError(
        'the mailbox address is unknown, so the CLI login cannot be verified',
        { code: 'identity-unknown' },
      );
    }
    if (address === wanted) return;
    throw new AgentMailCliError(
      `agently-cli is logged in as ${address}, not ${wanted}; authorize this mailbox separately`,
      { code: 'identity-mismatch' },
    );
  }

  /** Invalidate the cached workspace, after an authorization for instance. */
  __resetWorkspaceCache() {
    this.#workspaceResolved = undefined;
  }

  /** Call the CLI in this mailbox's workspace, resolved once and cached. */
  async #call(args, options = {}) {
    const workspace = await this.#workspaceFor();
    return this.#run(args, { ...options, env: { ...cliEnv(workspace), ...(options.env ?? {}) } });
  }

  constructor({ config, signal } = {}) {
    if (!config || typeof config !== 'object') {
      throw new TypeError('AgentMailTransport requires a config');
    }
    if (!isCliAvailable()) {
      throw new AgentMailCliError(
        'the Agent mailbox requires @tencent-qqmail/agently-cli, which is not installed',
        { code: 'cli-missing' },
      );
    }
    this.#config = config;
    this.#signal = signal;
    this.#address = normalizeAddress(config.address);
    // Stable per-mailbox workspace derived from the address, so a login is
    // never shared between two mailboxes.
    this.#workspace = String(config.workspace ?? config.platformId ?? config.address ?? '').trim();
  }

  get address() {
    return this.#address || this.#config.address || '';
  }

  get transportKey() {
    return 'agent-mail';
  }

  /** The CLI holds the session, so this only proves it is usable. */
  async connect() {
    if (this.#connected) return;
    // Goes through the instance runner so tests never spawn the real binary.
    const { document } = await this.#call(['+me'], { signal: this.#signal });
    const aliases = Array.isArray(document?.data?.aliases) ? document.data.aliases : [];
    const primary = aliases.find((entry) => entry?.is_primary) ?? aliases[0];
    const address = normalizeAddress(primary?.email);
    if (!address) {
      throw new AgentMailCliError('agently-cli reported no mailbox address', {
        code: 'identity-missing',
      });
    }
    await this.#assertIdentity(address);
    this.#address = address;
    this.#connected = true;
  }

  async disconnect() {
    // Stateless: each command is its own process, so there is nothing to close.
    this.#connected = false;
  }

  /** The newest id, used to seed a cursor. */
  async latestUid() {
    const listed = await this.listMessages({ afterUid: null, limit: 1 });
    return listed.length > 0 ? listed[0].uid : 0;
  }

  /**
   * New mail, oldest first.
   *
   * The CLI lists newest-first, so the page is reversed here. The body is
   * fetched per message because the list carries only a snippet; senders are
   * filtered first so an unlisted address costs no extra call.
   */
  async listMessages({ afterUid = null, limit = DEFAULT_PAGE_SIZE, allowSenders = null } = {}) {
    // A Set — even an empty one — means the caller supplied a policy: an
    // empty allowlist admits nobody, so no body is fetched at all. Treating
    // it as "no filter" downloaded mail the policy had already refused.
    const allowed = allowSenders instanceof Set ? allowSenders : null;
    const collected = [];
    let cursor = '';

    for (let page = 0; page < 5; page += 1) {
      const args = ['message', '+list', '--dir', INBOX, '--limit', String(DEFAULT_PAGE_SIZE)];
      if (cursor) args.push('--cursor', cursor);
      const { document } = await this.#call(args, { signal: this.#signal });
      const items = Array.isArray(document?.data?.data) ? document.data.data : [];

      // The API lists newest-first, so a page is reversed into age order before
      // the limit applies. Taking the newest `limit` entries instead skipped the
      // older backlog: with 30 messages pending and a limit of 25, the five
      // oldest were never delivered, and the cursor then advanced past them.
      const pageItems = items.slice().reverse();
      let reachedHandled = false;
      for (const raw of pageItems) {
        const id = String(raw?.message_id ?? '').trim();
        if (!id) continue;
        // The cursor is the newest already-handled id: it is skipped, and
        // everything newer than it (already collected) is kept. Breaking here
        // instead returned an empty page whenever the cursor was the oldest
        // entry on the page — which is the common case.
        if (afterUid !== null && afterUid !== undefined && id === String(afterUid)) {
          reachedHandled = true;
          continue;
        }
        if (allowed && !allowed.has(normalizeAddress(raw?.from?.email))) continue;
        collected.push(raw);
      }
      // Returning only on the limit is what lost the backlog: the oldest
      // unhandled batch is returned, and the cursor follows it forward.
      if (collected.length >= limit || reachedHandled) {
        return this.#oldestFirst(collected.slice(0, limit), allowed);
      }

      const next = String(document?.data?.pagination?.next_cursor ?? '');
      if (!next || items.length === 0) break;
      cursor = next;
    }
    return this.#oldestFirst(collected, allowed);
  }

  /** Oldest-first, with each message's body and RFC id filled in. */
  async #oldestFirst(items, allowed) {
    // The caller already ordered these oldest-first; reversing here would undo
    // the ordering the limit was applied to.
    const ordered = items.slice();
    const loaded = [];
    for (const raw of ordered) {
      loaded.push(await this.#readMessage(raw, allowed));
    }
    return loaded.filter(Boolean);
  }

  /** Read one message in full, falling back to the summary if that fails. */
  async #readMessage(raw, allowed) {
    const summary = normalizeAgentMailMessage(raw);
    if (!summary) return null;
    if (allowed && !allowed.has(normalizeAddress(summary.from?.value?.[0]?.address))) return null;
    try {
      const { document } = await this.#call(['message', '+read', '--id', summary.uid], {
        signal: this.#signal,
      });
      const full = normalizeAgentMailMessage(document?.data ?? {});
      if (!full) return summary;
      const attachments = full.attachments.length > 0 ? full.attachments : summary.attachments;
      return {
        ...summary,
        // The full read is the only place the thread id and body appear.
        messageId: full.messageId || summary.messageId,
        text: full.text || summary.text,
        html: full.html || summary.html,
        attachments: this.#withAttachmentContent(summary.uid, attachments),
        cc: full.cc.value.length > 0 ? full.cc : summary.cc,
      };
    } catch {
      // A failed read must not lose the mail; the snippet keeps it usable.
      return summary;
    }
  }

  /**
   * Attach a content loader to each attachment.
   *
   * The transport contract asks for `content`, but the API exposes only an id,
   * so the bytes are fetched from `attachment +download` on demand. A failed
   * download leaves that attachment without content rather than losing the
   * message — its name and size are still reported.
   */
  #withAttachmentContent(messageId, attachments) {
    if (!Array.isArray(attachments) || attachments.length === 0) return [];
    return attachments.map((file) => ({
      ...file,
      content: async () => {
        if (!file.attachmentId) return undefined;
        try {
          const { document } = await this.#call([
            'attachment', '+download',
            '--msg', messageId,
            '--att', file.attachmentId,
          ], { signal: this.#signal });
          const saved = document?.data?.saved_to;
          if (!saved) return undefined;
          const { readFile } = await import('node:fs/promises');
          return await readFile(saved);
        } catch {
          return undefined;
        }
      },
    }));
  }

  /** Reply, threading on the message's own RFC id. */
  async sendReply({
    to, subject, text, transportMessageId, references, attachments = [], headers,
  } = {}) {
    const body = this.#composeBody(text);
    // The CLI takes the text through --body; `--body-file -` is read as a
    // literal filename and fails with ENOENT.
    const args = [
      'message', '+reply',
      '--id', String(transportMessageId ?? ''),
    ];
    if (attachments.length > 0) {
      const uploaded = await this.#uploadAttachments(attachments);
      for (const id of uploaded) args.push('--attachment', id);
    }
    await this.#withConfirmation(args, body, headers);
    return { sent: true, to, subject: subject ?? replySubject(''), references };
  }

  /** Send a new message rather than a reply. */
  async sendText({ to, subject, text, attachments = [], headers } = {}) {
    const body = this.#composeBody(text);
    const args = ['message', '+send', '--to', String(to ?? '')];
    if (subject) args.push('--subject', String(subject));
    if (attachments.length > 0) {
      const uploaded = await this.#uploadAttachments(attachments);
      for (const id of uploaded) args.push('--attachment', id);
    }
    await this.#withConfirmation(args, body, headers);
    return { sent: true, to, subject };
  }

  /** Reply bodies are trimmed to the same ceiling as the IMAP transport. */
  #composeBody(text) {
    return stripQuotedHistory(String(text ?? '')).slice(0, MAX_REPLY_CHARS);
  }

  /** Upload local attachments and return their ids. */
  async #uploadAttachments(attachments) {
    const ids = [];
    for (const file of attachments) {
      // A path can be uploaded directly; the runtime hands over bytes instead
      // (`{ filename, content, contentType }`), which must be written out
      // first — the earlier version read only `path`, skipped every real
      // attachment, and the send still reported success.
      let path = file?.path ?? file?.filePath ?? null;
      let cleanup = null;
      if (!path) {
        const bytes = file?.content ?? file?.bytes ?? file?.data;
        if (!bytes) {
          throw new AgentMailCliError(
            `attachment ${String(file?.filename ?? '(unnamed)')} has neither a path nor content`,
            { code: 'attachment-unreadable' },
          );
        }
        const written = await this.#writeTempAttachment(file?.filename, bytes);
        if (!written) {
          throw new AgentMailCliError(
            `attachment ${String(file?.filename ?? '(unnamed)')} could not be staged for upload`,
            { code: 'attachment-unwritable' },
          );
        }
        ({ path, cleanup } = written);
      }
      try {
        const { document } = await this.#call(['attachment', '+upload', '--file', path], {
          signal: this.#signal,
        });
        const id = String(document?.data?.attachment_id ?? '').trim();
        if (id) ids.push(id);
      } finally {
        if (cleanup) await cleanup();
      }
    }
    return ids;
  }

  /** Write attachment bytes to a temp file so the CLI can upload them. */
  async #writeTempAttachment(filename, bytes) {
    try {
      const { mkdtemp, writeFile, rm } = await import('node:fs/promises');
      const { tmpdir } = await import('node:os');
      const { join, basename } = await import('node:path');
      const dir = await mkdtemp(join(tmpdir(), 'dsh-email-att-'));
      const buffer = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
      const safe = basename(String(filename ?? 'attachment')).replace(/[^\w.-]/g, '_') || 'attachment';
      const path = join(dir, safe);
      await writeFile(path, buffer);
      return { path, cleanup: () => rm(dir, { recursive: true, force: true }).catch(() => {}) };
    } catch {
      return null;
    }
  }

  /**
   * Run a sending command, completing the two-step confirmation.
   *
   * The first call returns `confirmation_token` with exit 0; resending the same
   * arguments plus that token performs the send.
   */
  async #withConfirmation(args, body, headers) {
    // agently-cli exposes no --header flag; extra headers are dropped rather
    // than passed as an argument it would reject.
    // The body travels as an argument: `--body-file -` is read as a literal
    // filename and fails with ENOENT, so stdin is not an option here.
    const withBody = [...args, '--body', body];
    const first = await this.#call(withBody, { signal: this.#signal });
    const token = String(first.document?.data?.confirmation_token ?? '').trim();
    if (!token) return first.document;
    const confirmed = await this.#call(
      [...withBody, '--confirmation-token', token],
      { signal: this.#signal },
    );
    return confirmed.document;
  }
}

assertTransport(AgentMailTransport.prototype, 'AgentMailTransport');

/**
 * Build a transport whose CLI calls are supplied by the caller.
 *
 * Tests need to drive list/read/send without the real binary; production
 * constructs `AgentMailTransport` directly.
 */
export function createAgentMailTransportForTests({ config, runCliImpl }) {
  const transport = new AgentMailTransport({ config });
  transport.__setRunCliForTests(runCliImpl);
  return transport;
}
