import { EmailConfigStore } from '../../../../src/channels/email/config-store.mjs';
import { EmailHarnessClient } from '../../../../src/channels/email/harness-client.mjs';
import { EmailStateStore } from '../../../../src/channels/email/state-store.mjs';
import { EmailController } from '../../../../src/channels/email/email-controller.mjs';
import { EmailRuntime } from '../../../../src/channels/email/email-runtime.mjs';
import { createTokenProductionController } from '../shared/production.mjs';

/**
 * Email is a token-shaped channel: one mailbox identity plus one secret. It
 * reuses the shared token production assembly, which wires the workspace
 * scope, access policy, delivery adapter, and connection supervisor.
 */
export function createProductionController(ctx, config = {}, internals = {}) {
  return createTokenProductionController(ctx, config, internals, {
    channel: 'email',
    ConfigStore: EmailConfigStore,
    StateStore: EmailStateStore,
    HarnessClient: EmailHarnessClient,
    Controller: EmailController,
    Runtime: EmailRuntime,
    runtimeOptions: (channelConfig) => ({
      ...(channelConfig.pollIntervalMs === undefined
        ? {} : { pollIntervalMs: channelConfig.pollIntervalMs }),
    }),
    // Email fails closed: without an allowlist the mailbox must not act on
    // instructions, so the seed policy is an explicit empty allowlist rather
    // than the fully-open baseline most token channels use.
    initialAccessPolicyForBot: () => ({ allowedSenders: [] }),
  });
}
