import { createTokenBotRpcHandler } from '../shared/rpc.mjs';
import { registerManagementRpc } from '../../../management-rpc.mjs';
import { resolveRpcAuthority } from '../../rpc-authority.mjs';

export const EMAIL_RPC_CHANNEL = '/email';
export const EMAIL_ENDPOINTS = Object.freeze({
  status: 'connection.status',
  bindMailbox: 'bot.bind-mailbox',
  updateMailbox: 'bot.mailbox.update',
  reconnectBot: 'bot.reconnect',
  deleteBot: 'bot.delete',
  setWorkspace: 'bot.workspace.set',
  setModel: 'bot.model.set',
  setAgentPreset: 'bot.agent-preset.set',
  setContextEnhancement: 'bot.context-enhancement.set',
  setAccessPolicy: 'bot.access-policy.set',
  setAlias: 'bot.alias.set',
  // Session binding: read the current bindings, change them, and list the
  // candidate sessions for the picker.
  // QR device flow for transports that authorize out of band (Agent mailbox).
  startAuth: 'bot.auth.start',
  pollAuth: 'bot.auth.poll',
  getBinding: 'bot.session-binding.get',
  setBinding: 'bot.session-binding.set',
  listSessions: 'bot.session.list',
});
export const EMAIL_RPC_ENDPOINTS = Object.freeze(Object.values(EMAIL_ENDPOINTS));

function failure(code, error) {
  return {
    ok: false,
    error: {
      code: error?.code ?? code,
      message: error?.message ?? String(error),
      details: error?.details ?? {},
    },
  };
}

function withRpcDetails(result) {
  if (result?.ok !== false) return result;
  return { ...result, error: { ...result.error, details: result.error?.details ?? {} } };
}

/**
 * Mailbox-specific endpoints are handled here; everything else (status,
 * reconnect, delete, workspace, model, preset, alias, access policy) goes
 * through the shared token-bot handler, which already knows the endpoint
 * payload shapes.
 */
export function createEmailRpcHandler(controller) {
  const shared = createTokenBotRpcHandler(controller, { channel: 'Email' });
  return async (endpoint, payload, signal) => {
    if (endpoint === EMAIL_ENDPOINTS.bindMailbox) {
      try {
        return { ok: true, value: await controller.bindMailbox(payload ?? {}) };
      } catch (error) {
        return withRpcDetails({
          ok: false,
          error: {
            code: error?.code ?? 'email-bind-failed',
            message: error?.message ?? String(error),
            details: error?.details ?? {},
          },
        });
      }
    }
    if (endpoint === EMAIL_ENDPOINTS.startAuth) {
      try {
        return { ok: true, value: await controller.startAuthorization(payload ?? {}) };
      } catch (error) {
        return failure('email-auth-failed', error);
      }
    }
    if (endpoint === EMAIL_ENDPOINTS.pollAuth) {
      try {
        return { ok: true, value: await controller.pollAuthorization(payload ?? {}) };
      } catch (error) {
        return failure('email-auth-failed', error);
      }
    }
    if (endpoint === EMAIL_ENDPOINTS.getBinding) {
      try {
        return { ok: true, value: await controller.getSessionBinding(payload?.botId) };
      } catch (error) {
        return failure('email-binding-failed', error);
      }
    }
    if (endpoint === EMAIL_ENDPOINTS.setBinding) {
      try {
        return { ok: true, value: await controller.setSessionBinding(payload?.botId, payload ?? {}) };
      } catch (error) {
        return failure('email-binding-failed', error);
      }
    }
    if (endpoint === EMAIL_ENDPOINTS.listSessions) {
      try {
        return { ok: true, value: await controller.listSessions(payload?.botId) };
      } catch (error) {
        return failure('email-sessions-failed', error);
      }
    }
    if (endpoint === EMAIL_ENDPOINTS.updateMailbox) {
      try {
        return {
          ok: true,
          value: await controller.updateMailboxSettings(payload?.botId, payload?.update ?? {}),
        };
      } catch (error) {
        return withRpcDetails({
          ok: false,
          error: {
            code: error?.code ?? 'email-update-failed',
            message: error?.message ?? String(error),
            details: error?.details ?? {},
          },
        });
      }
    }
    return withRpcDetails(await shared(endpoint, payload, signal));
  };
}

export function installEmailRpc(ctx, controller, authority) {
  return registerManagementRpc(
    ctx,
    EMAIL_RPC_CHANNEL,
    createEmailRpcHandler(controller),
    { authority: resolveRpcAuthority(authority) },
  );
}
