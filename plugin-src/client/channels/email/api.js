import { TOKEN_BOT_ENDPOINTS, createTokenChannelApi } from '../shared/token-api.js';

export const EMAIL_RPC_CHANNEL = '/email';
export const EMAIL_ENDPOINTS = Object.freeze({
  ...TOKEN_BOT_ENDPOINTS,
  // The mailbox binds by address + app password rather than a single token.
  bindCredentials: 'bot.bind-mailbox',
  updateMailbox: 'bot.mailbox.update',
});
const api = createTokenChannelApi('Email', ' IMAP/SMTP 邮箱');
export { api as emailClientApi };
export const unwrapRpcResult = api.unwrapRpcResult;
export const normalizeSnapshot = api.normalizeSnapshot;
export const presentError = api.presentError;
