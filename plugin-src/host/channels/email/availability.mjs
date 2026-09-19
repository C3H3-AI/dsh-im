/**
 * The single switch that opens or closes the email channel.
 *
 * Email shipped early: the mailbox is a token-shaped channel whose identity is
 * an address anyone can forge, so its permission model, account isolation and
 * loss-on-failure behaviour are not yet good enough to expose by default.
 * Merging the code with the channel closed keeps that work reviewable without
 * putting a half-hardened entry point in front of users.
 *
 * This module is the ONE place to change when email opens again:
 *
 *   - to ship email open, set `EMAIL_CHANNEL_ENABLED=1` in the environment, or
 *     `emailChannelEnabled: true` in the plugin config, and the entry point,
 *     the runtime and the config restore all come back with no code change;
 *   - to keep it closed, do nothing — closed is the default.
 *
 * Closing is deliberately non-destructive: it never deletes a mailbox config or
 * a credential. It only refuses to expose the entry point and to start the
 * runtime, so every existing mailbox is still there when the switch reopens.
 */

/** Environment variable that opens the email channel. */
export const EMAIL_CHANNEL_ENABLED_ENV = 'EMAIL_CHANNEL_ENABLED';

const TRUTHY = new Set(['1', 'true', 'yes', 'on']);
const FALSY = new Set(['0', 'false', 'no', 'off', '']);

function readBoolean(value) {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (TRUTHY.has(normalized)) return true;
    if (FALSY.has(normalized)) return false;
  }
  return null;
}

/**
 * Decide whether the email channel is open.
 *
 * An explicit config value wins over the environment so a deployment can pin
 * the channel without changing its environment; an unreadable value falls back
 * to the environment, and an absent one keeps the channel closed.
 */
export function isEmailChannelEnabled(config = {}, env = process.env) {
  return readBoolean(config.emailChannelEnabled)
    ?? readBoolean(env?.[EMAIL_CHANNEL_ENABLED_ENV])
    ?? false;
}

/**
 * The single host-side gate.
 *
 * Returns `null` when email is open, or a public "not available" result when it
 * is closed. Both the management RPC and the production startup consult this so
 * a closed channel can neither be configured nor connected.
 */
export function emailChannelGate(config = {}, env = process.env) {
  if (isEmailChannelEnabled(config, env)) return null;
  return Object.freeze({
    ok: false,
    error: Object.freeze({
      code: 'email-channel-disabled',
      message: 'Email is not available yet.',
      details: Object.freeze({}),
    }),
  });
}
