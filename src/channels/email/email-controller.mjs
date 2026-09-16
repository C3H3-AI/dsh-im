import { t } from '../shared/i18n.mjs';
import { EmailApi } from './email-api.mjs';
import {
  EMAIL_PROVIDERS,
  EmailConfigStore,
  deriveEmailBotIdentity,
  maskEmailBotId,
  normalizeEmailAddress,
  normalizeEmailAccessPolicy,
} from './config-store.mjs';
import { EmailStateStore } from './state-store.mjs';
import { EMAIL_DESCRIPTOR } from './email-bridge.mjs';

/** Credential payload for one mailbox: the login plus its app password. */
function normalizeCredential(value) {
  if (!value || typeof value !== 'object') return null;
  const address = typeof value.address === 'string' ? value.address.trim().toLowerCase() : '';
  const password = typeof value.password === 'string' ? value.password : '';
  if (!address || !password) return null;
  return { address, password };
}

export class EmailController {
  #credentials;
  #configStore;
  #createRuntime;
  #createApi;
  #deleteState;
  #logger;
  #runtimes = new Map();
  #errors = new Map();
  #revision = 0;
  #closed = false;
  #transitions = new Map();

  constructor({
    credentials,
    configStore,
    createRuntime,
    deleteState = async () => {},
    logger = console,
    createApi = (options) => new EmailApi(options),
  }) {
    if (!credentials || typeof credentials.resolve !== 'function'
      || typeof credentials.set !== 'function' || typeof credentials.unset !== 'function') {
      throw new TypeError('EmailController requires the DSH credential provider');
    }
    if (!configStore || typeof configStore.list !== 'function'
      || typeof configStore.save !== 'function' || typeof configStore.remove !== 'function') {
      throw new TypeError('EmailController requires a config store');
    }
    if (typeof createRuntime !== 'function') throw new TypeError('createRuntime is required');
    this.#credentials = credentials;
    this.#configStore = configStore;
    this.#createRuntime = createRuntime;
    this.#createApi = createApi;
    this.#deleteState = deleteState;
    this.#logger = logger;
  }

  async initialize() {
    if (this.#closed) return this.status();
    for (const config of this.#configStore.list()) {
      await this.#withBotTransition(config.botId, async () => {
        try {
          const secrets = await this.#resolveSecrets(config);
          if (!secrets) return;
          await this.#startRuntime(config, secrets);
          this.#errors.delete(config.botId);
        } catch (error) {
          this.#errors.set(config.botId, this.#safeError('connection-failed', error));
          this.#logger.warn?.(`[dsh-im:email] bot ${config.botId} failed to start:`, error);
        }
      });
    }
    return this.status();
  }

  /**
   * Connect one mailbox. The password is verified against IMAP/SMTP before it
   * is persisted, so a bad app password fails here rather than silently
   * producing a bot that never receives mail.
   */
  async bindMailbox({ address, password, provider, imapHost, imapPort, smtpHost, smtpPort, allowedSenders } = {}) {
    if (this.#closed) throw new Error(`${EMAIL_DESCRIPTOR.label} controller is closed`);
    const normalizedAddress = normalizeEmailAddress(address);
    const credential = normalizeCredential({ address: normalizedAddress, password });
    if (!credential) throw new TypeError(t('邮箱地址与应用密码均为必填'));
    const preset = EMAIL_PROVIDERS[provider] ?? null;
    const security = {
      provider: preset?.key ?? 'custom',
      imapHost: imapHost || preset?.imapHost,
      imapPort: imapPort ?? preset?.imapPort ?? 993,
      smtpHost: smtpHost || preset?.smtpHost,
      smtpPort: smtpPort ?? preset?.smtpPort ?? 465,
      allowedSenders: normalizeEmailAccessPolicy({ allowedSenders }).allowedSenders,
    };
    if (!security.imapHost || !security.smtpHost) {
      throw new TypeError(t('请选择邮箱服务商或填写 IMAP/SMTP 服务器地址'));
    }
    if (security.allowedSenders.length === 0) {
      // Fail closed: without an allowlist anyone who can guess the address
      // could drive the Harness through this mailbox.
      throw new TypeError(t('必须至少配置一个允许发件人'));
    }
    const identity = deriveEmailBotIdentity(normalizedAddress);
    await this.#withBotTransition(identity.botId, async () => {
      const previousConfig = this.#configStore.getByPlatformId(normalizedAddress);
      const previousCredential = await this.#credentials.resolve(identity.tokenRef).catch(() => undefined);
      const probe = this.#createApi({
        config: { address: normalizedAddress, password, ...security },
      });
      try {
        await probe.connect();
        await probe.disconnect();
      } catch (error) {
        this.#logger.warn?.('[dsh-im:email] credential verification failed', error);
        throw new Error(t('邮箱连接失败，请检查地址、应用密码与服务器设置'));
      }
      const config = {
        botId: identity.botId,
        platformId: normalizedAddress,
        tokenRef: identity.tokenRef,
        name: normalizedAddress,
        username: normalizedAddress,
        createdAt: previousConfig?.createdAt ?? new Date().toISOString(),
        connectedAt: new Date().toISOString(),
        ...security,
      };
      await this.#credentials.set(identity.tokenRef, JSON.stringify(credential));
      try {
        await this.#configStore.save(config);
      } catch (error) {
        await this.#restoreCredential(identity.tokenRef, previousCredential);
        throw error;
      }
      await this.#stopRuntime(identity.botId);
      try {
        await this.#startRuntime(config, credential);
        this.#errors.delete(identity.botId);
      } catch (error) {
        this.#errors.set(identity.botId, this.#safeError('connection-failed', error));
      }
      this.#touch();
    });
    return this.status();
  }

  /** Patch a subset of settings (hosts, ports, allowlist) without reconnecting. */
  async updateMailboxSettings(botId, update = {}) {
    if (this.#closed) throw new Error(`${EMAIL_DESCRIPTOR.label} controller is closed`);
    return this.#withBotTransition(botId, async () => {
      const config = this.#requireConfig(botId);
      const next = { ...config };
      if (update.provider !== undefined) next.provider = update.provider;
      if (update.imapHost !== undefined) next.imapHost = update.imapHost;
      if (update.imapPort !== undefined) next.imapPort = update.imapPort;
      if (update.smtpHost !== undefined) next.smtpHost = update.smtpHost;
      if (update.smtpPort !== undefined) next.smtpPort = update.smtpPort;
      if (update.allowedSenders !== undefined) {
        next.allowedSenders = normalizeEmailAccessPolicy({ allowedSenders: update.allowedSenders }).allowedSenders;
      }
      if (next.allowedSenders.length === 0) throw new TypeError(t('必须至少配置一个允许发件人'));
      const saved = await this.#configStore.save(next);
      // Host and allowlist changes take effect immediately.
      await this.#stopRuntime(botId);
      const secrets = await this.#resolveSecrets(saved);
      if (secrets) {
        try {
          await this.#startRuntime(saved, secrets);
          this.#errors.delete(botId);
        } catch (error) {
          this.#errors.set(botId, this.#safeError('connection-failed', error));
        }
      }
      this.#touch();
      return this.status();
    });
  }

  async reconnectBot(botId) {
    if (this.#closed) throw new Error(`${EMAIL_DESCRIPTOR.label} controller is closed`);
    return this.#withBotTransition(botId, async () => {
      const config = this.#requireConfig(botId);
      await this.#stopRuntime(botId);
      const secrets = await this.#resolveSecrets(config);
      if (!secrets) throw new Error(t('邮箱凭据已丢失，请重新绑定'));
      await this.#startRuntime(config, secrets);
      this.#errors.delete(botId);
      this.#touch();
      return this.status();
    });
  }

  async sendConnectionTest(botId) {
    const runtime = this.#runtimes.get(botId);
    if (!runtime) throw new Error(t('邮箱尚未连接'));
    await runtime.sendConnectionTest(t('邮箱通道连接正常。'));
    return { sent: true };
  }

  async sendProactiveText(botId, target, text, options = {}) {
    const runtime = this.#runtimes.get(botId);
    if (!runtime) {
      const error = new Error(t('邮箱尚未连接'));
      error.code = 'bot-not-connected';
      throw error;
    }
    return runtime.sendProactiveText(target, text, options);
  }

  async deleteBot(botId) {
    return this.#withBotTransition(botId, async () => {
      const config = this.#configStore.get(botId);
      await this.#stopRuntime(botId);
      const removed = await this.#configStore.remove(botId);
      if (removed?.tokenRef) await this.#credentials.unset(removed.tokenRef).catch(() => {});
      await this.#deleteState(botId).catch(() => {});
      this.#errors.delete(botId);
      this.#touch();
      return this.status();
    });
  }

  status() {
    const bots = this.#configStore.list().map((config) => {
      const runtime = this.#runtimes.get(config.botId);
      const error = this.#errors.get(config.botId);
      return {
        botId: config.botId,
        // The raw address is already semi-public, but the UI shows the masked
        // form for consistency with other channels.
        platformId: maskEmailBotId(config.platformId),
        name: config.name,
        provider: config.provider,
        imapHost: config.imapHost,
        imapPort: config.imapPort,
        smtpHost: config.smtpHost,
        smtpPort: config.smtpPort,
        allowedSenders: config.allowedSenders ?? [],
        createdAt: config.createdAt,
        connectedAt: config.connectedAt,
        ...(error ? { error } : {}),
        runtime: runtime?.status ?? null,
      };
    });
    return { revision: this.#revision, bots };
  }

  async close() {
    if (this.#closed) return;
    this.#closed = true;
    for (const botId of [...this.#runtimes.keys()]) {
      await this.#stopRuntime(botId).catch(() => {});
    }
  }

  // ── internals ────────────────────────────────────────────────────────────

  #requireConfig(botId) {
    const config = this.#configStore.get(botId);
    if (!config) throw new Error(t('未找到该邮箱配置'));
    return config;
  }

  async #resolveSecrets(config) {
    const raw = await this.#credentials.resolve(config.tokenRef).catch(() => undefined);
    if (!raw) return null;
    try {
      const parsed = JSON.parse(raw);
      return normalizeCredential(parsed);
    } catch {
      return null;
    }
  }

  async #startRuntime(config, credential) {
    // Production owns state/workspace resolution; the controller only passes
    // the identity and the mailbox secret through.
    const runtime = await this.#createRuntime({ botId: config.botId, config, credential });
    if (!runtime || typeof runtime.start !== 'function' || typeof runtime.stop !== 'function') {
      throw new TypeError('createRuntime returned an invalid Email runtime');
    }
    this.#runtimes.set(config.botId, runtime);
    try {
      await runtime.start();
    } catch (error) {
      this.#runtimes.delete(config.botId);
      await runtime.stop().catch(() => {});
      throw error;
    }
  }

  async #stopRuntime(botId) {
    const runtime = this.#runtimes.get(botId);
    this.#runtimes.delete(botId);
    await runtime?.stop().catch((error) => {
      this.#logger.warn?.(`[dsh-im:email] bot ${botId} failed to stop cleanly:`, error);
    });
  }

  async #restoreCredential(tokenRef, previous) {
    if (previous === undefined) await this.#credentials.unset(tokenRef).catch(() => {});
    else await this.#credentials.set(tokenRef, previous).catch(() => {});
  }

  #safeError(code, error) {
    return { code, message: error?.message ?? String(error) };
  }

  #touch() {
    this.#revision += 1;
  }

  async #withBotTransition(botId, task) {
    const previous = this.#transitions.get(botId) ?? Promise.resolve();
    const next = previous.then(task, task).finally(() => {
      if (this.#transitions.get(botId) === next) this.#transitions.delete(botId);
    });
    this.#transitions.set(botId, next);
    return next;
  }
}

export { EmailConfigStore, EmailStateStore };
