import { TOKEN_BOT_ENDPOINTS, createTokenChannelApi } from '../shared/token-api.js';

export const EMAIL_RPC_CHANNEL = '/email';
export const EMAIL_ENDPOINTS = Object.freeze({
  ...TOKEN_BOT_ENDPOINTS,
  // The mailbox binds by address + app password rather than a single token.
  bindCredentials: 'bot.bind-mailbox',
  updateMailbox: 'bot.mailbox.update',
  // Session binding controls (per-account settings panel).
  startAuth: 'bot.auth.start',
  pollAuth: 'bot.auth.poll',
  getBinding: 'bot.session-binding.get',
  setBinding: 'bot.session-binding.set',
  listSessions: 'bot.session.list',
});
/**
 * Carry the channel-specific mailbox fields through the shared snapshot
 * normalizer, which keeps an explicit field list and would otherwise drop
 * them — the settings form then showed an empty allowlist even though the
 * Host was returning it.
 */
function normalizeEmailBotExtension(value) {
  const senders = Array.isArray(value?.allowedSenders) ? value.allowedSenders : [];
  return {
    allowedSenders: senders.filter((entry) => typeof entry === 'string' && entry),
    // The saved approval choice; without it the settings checkbox opened
    // unchecked every time and silently disagreed with the Host.
    autoApprove: value?.autoApprove === true,
    // Without this the settings page cannot tell an Agent mailbox from an
    // IMAP/SMTP one, and shows server hosts that do not apply.
    ...(typeof value?.transport === 'string' && value.transport
      ? { transport: value.transport } : {}),
    ...(typeof value?.provider === 'string' && value.provider
      ? { provider: value.provider } : {}),
    ...(text(value?.imapHost) ? { imapHost: text(value.imapHost) } : {}),
    ...(Number.isSafeInteger(value?.imapPort) ? { imapPort: value.imapPort } : {}),
    ...(text(value?.smtpHost) ? { smtpHost: text(value.smtpHost) } : {}),
    ...(Number.isSafeInteger(value?.smtpPort) ? { smtpPort: value.smtpPort } : {}),
  };
}

function text(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : '';
}

const api = createTokenChannelApi('Email', ' IMAP/SMTP 邮箱', {
  normalizeBotExtension: normalizeEmailBotExtension,
});
export { api as emailClientApi };
export const unwrapRpcResult = api.unwrapRpcResult;
export const normalizeSnapshot = api.normalizeSnapshot;
export const presentError = api.presentError;
