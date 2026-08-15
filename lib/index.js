// plugin-src/host/channels/dingtalk/production.mjs
import { unlink as unlink3 } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

// src/channels/dingtalk/config-store.mjs
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
var EMPTY_DOCUMENT = Object.freeze({ version: 1, bots: Object.freeze([]) });
var STORED_BOT_KEYS = /* @__PURE__ */ new Set(["clientId", "secretRef", "approvedSenders"]);
function cleanString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}
function digest(value) {
  return createHash("sha256").update(value).digest("hex");
}
function safeBotId(value) {
  const id = cleanString(value);
  return id && /^dt_[a-f0-9]{24}$/.test(id) ? id : null;
}
function safeSecretRef(value) {
  const ref = cleanString(value);
  return ref && /^DSH_DINGTALK_BOT_SECRET_[A-F0-9]{24}$/.test(ref) ? ref : null;
}
function safeSenderKey(value) {
  const key = cleanString(value);
  return key && /^dt_sender_[a-f0-9]{32}$/.test(key) ? key : null;
}
function normalizeApprovedSender(value) {
  const record = typeof value === "string" ? { staffId: value } : value;
  if (!record || typeof record !== "object" || Array.isArray(record)) return null;
  const senderKey = safeSenderKey(record.senderKey);
  const staffId = cleanString(record.staffId);
  if (!senderKey || !staffId) return null;
  return Object.freeze({
    senderKey,
    staffId,
    displayName: cleanString(record.displayName),
    approvedAt: cleanString(record.approvedAt)
  });
}
function normalizeApprovedSenders(value) {
  if (!Array.isArray(value)) return null;
  const senders = value.map(normalizeApprovedSender);
  if (senders.some((sender) => sender === null)) return null;
  const ids = /* @__PURE__ */ new Set();
  const keys = /* @__PURE__ */ new Set();
  for (const sender of senders) {
    if (ids.has(sender.staffId) || keys.has(sender.senderKey)) return null;
    ids.add(sender.staffId);
    keys.add(sender.senderKey);
  }
  return Object.freeze(senders);
}
function deriveDingtalkBotIdentity(clientId) {
  const value = cleanString(clientId);
  if (!value) throw new TypeError("clientId is required");
  const valueDigest = digest(value).slice(0, 24);
  return Object.freeze({
    botId: `dt_${valueDigest}`,
    secretRef: `DSH_DINGTALK_BOT_SECRET_${valueDigest.toUpperCase()}`
  });
}
function deriveDingtalkSenderKey() {
  return `dt_sender_${randomUUID().replaceAll("-", "")}`;
}
function maskDingtalkSenderId(staffId) {
  const value = cleanString(staffId);
  if (!value) return "\u9489\u9489\u7528\u6237";
  return "\u8EAB\u4EFD\u5DF2\u9690\u85CF";
}
function maskDingtalkClientId(clientId) {
  const value = cleanString(clientId);
  if (!value) return "\u9489\u9489\u673A\u5668\u4EBA";
  if (value.length <= 8) return `${value.slice(0, 2)}\u2022\u2022\u2022\u2022`;
  return `${value.slice(0, 4)}\u2022\u2022\u2022\u2022${value.slice(-4)}`;
}
function normalizeBot(value, { stored = false } = {}) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  if ("clientSecret" in value || "client_secret" in value || "deviceCode" in value) return null;
  if (stored && Object.keys(value).some((key) => !STORED_BOT_KEYS.has(key))) return null;
  const clientId = cleanString(value.clientId);
  const secretRef = safeSecretRef(value.secretRef);
  const approvedSenders = normalizeApprovedSenders(value.approvedSenders ?? []);
  if (!clientId || !secretRef || !approvedSenders) return null;
  const identity = deriveDingtalkBotIdentity(clientId);
  if (identity.secretRef !== secretRef) return null;
  const suppliedBotId = value.botId === void 0 ? identity.botId : safeBotId(value.botId);
  if (suppliedBotId !== identity.botId) return null;
  return Object.freeze({
    botId: identity.botId,
    clientId,
    secretRef,
    approvedSenders
  });
}
function normalizeDocument(value) {
  if (!value || value.version !== 1 || !Array.isArray(value.bots)) return null;
  const bots = value.bots.map((bot) => normalizeBot(bot, { stored: true }));
  if (bots.some((bot) => bot === null)) return null;
  const botIds = /* @__PURE__ */ new Set();
  const clientIds = /* @__PURE__ */ new Set();
  const secretRefs = /* @__PURE__ */ new Set();
  for (const bot of bots) {
    if (botIds.has(bot.botId) || clientIds.has(bot.clientId) || secretRefs.has(bot.secretRef)) {
      return null;
    }
    botIds.add(bot.botId);
    clientIds.add(bot.clientId);
    secretRefs.add(bot.secretRef);
  }
  return Object.freeze({ version: 1, bots: Object.freeze(bots) });
}
function storedDocument(document) {
  return {
    version: 1,
    bots: document.bots.map((bot) => ({
      clientId: bot.clientId,
      secretRef: bot.secretRef,
      approvedSenders: bot.approvedSenders.map((sender) => ({
        senderKey: sender.senderKey,
        staffId: sender.staffId,
        displayName: sender.displayName,
        approvedAt: sender.approvedAt
      }))
    }))
  };
}
var DingtalkConfigStore = class {
  #path;
  #value = EMPTY_DOCUMENT;
  #writeQueue = Promise.resolve();
  /** @param {string} path Absolute or process-relative configuration file path. */
  constructor(path) {
    if (!cleanString(path)) throw new TypeError("config path is required");
    this.#path = path;
  }
  /** @returns {Promise<DingtalkConfigStore>} Loaded store. */
  async load() {
    try {
      const normalized = normalizeDocument(JSON.parse(await readFile(this.#path, "utf8")));
      if (!normalized) throw new Error("dsh-dingtalk config contains invalid bot data");
      this.#value = normalized;
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
      this.#value = EMPTY_DOCUMENT;
    }
    return this;
  }
  /** @returns {Array<object>} Cloned bot configurations with derived bot IDs. */
  list() {
    return structuredClone(this.#value.bots);
  }
  /** @param {string} botId Derived bot ID. @returns {object|null} Bot configuration. */
  get(botId) {
    const found = this.#value.bots.find((bot) => bot.botId === botId);
    return found ? structuredClone(found) : null;
  }
  /** @param {string} clientId DingTalk client ID. @returns {object|null} Bot configuration. */
  getByClientId(clientId) {
    const found = this.#value.bots.find((bot) => bot.clientId === clientId);
    return found ? structuredClone(found) : null;
  }
  /** @param {object} value Bot configuration without a client secret. @returns {Promise<object>} Saved config. */
  async save(value) {
    const normalized = normalizeBot(value);
    if (!normalized) throw new Error("Refusing to persist invalid dsh-dingtalk bot data");
    return this.#mutate((bots) => {
      const collision = bots.find(
        (bot) => (bot.clientId === normalized.clientId || bot.secretRef === normalized.secretRef) && bot.botId !== normalized.botId
      );
      if (collision) throw new Error("Duplicate DingTalk bot identity");
      const index = bots.findIndex((bot) => bot.botId === normalized.botId);
      if (index === -1) bots.push(normalized);
      else bots[index] = normalized;
      return structuredClone(normalized);
    });
  }
  /** @param {string} botId Derived bot ID. @returns {Promise<object|null>} Removed config. */
  async remove(botId) {
    if (!safeBotId(botId)) throw new TypeError("Invalid DingTalk bot id");
    return this.#mutate((bots) => {
      const index = bots.findIndex((bot) => bot.botId === botId);
      if (index === -1) return null;
      const [removed] = bots.splice(index, 1);
      return structuredClone(removed);
    });
  }
  /** Removes the configuration file and resets the in-memory store. */
  async clear() {
    const operation = this.#writeQueue.then(async () => {
      try {
        await unlink(this.#path);
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
      }
      this.#value = EMPTY_DOCUMENT;
    });
    this.#writeQueue = operation.then(() => void 0, () => void 0);
    await operation;
  }
  async #mutate(mutator) {
    let result;
    const operation = this.#writeQueue.then(async () => {
      const bots = [...this.#value.bots];
      result = mutator(bots);
      const document = Object.freeze({ version: 1, bots: Object.freeze(bots) });
      await this.#write(document);
      this.#value = document;
    });
    this.#writeQueue = operation.then(() => void 0, () => void 0);
    await operation;
    return result;
  }
  async #write(document) {
    await mkdir(dirname(this.#path), { recursive: true, mode: 448 });
    const temporary = `${this.#path}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, `${JSON.stringify(storedDocument(document), null, 2)}
`, {
        encoding: "utf8",
        flag: "wx",
        mode: 384
      });
      await rename(temporary, this.#path);
    } catch (error) {
      try {
        await unlink(temporary);
      } catch (cleanupError) {
        if (cleanupError?.code !== "ENOENT") throw new AggregateError([error, cleanupError]);
      }
      throw error;
    }
  }
};

// src/channels/dingtalk/device-auth.mjs
var DEFAULT_REGISTRATION_BASE_URL = "https://oapi.dingtalk.com";
var REGISTRATION_SOURCE = "DING_DWS_CLAW";
function cleanString2(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}
function positiveNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}
function normalizeBaseUrl(value) {
  let url;
  try {
    url = new URL(cleanString2(value) ?? DEFAULT_REGISTRATION_BASE_URL);
  } catch {
    throw new TypeError("DingTalk registration base URL must be a valid HTTPS URL");
  }
  const isDingtalkHost2 = url.hostname === "dingtalk.com" || url.hostname.endsWith(".dingtalk.com");
  if (url.protocol !== "https:" || url.port || !isDingtalkHost2 || url.username || url.password || url.search || url.hash) {
    throw new TypeError("DingTalk registration base URL must be a valid HTTPS URL");
  }
  url.pathname = url.pathname.replace(/\/+$/, "");
  return url.href.replace(/\/$/, "");
}
function readNow(clock) {
  const value = typeof clock?.now === "function" ? clock.now() : clock();
  if (!Number.isFinite(value)) throw new TypeError("clock must return a finite timestamp");
  return value;
}
function assertRecord(value, action) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new DingtalkDeviceAuthError(
      "invalid-response",
      `DingTalk ${action} returned an invalid response`,
      action
    );
  }
  if (Number(value.errcode) !== 0) {
    throw new DingtalkDeviceAuthError(
      "api-error",
      `DingTalk ${action} request was rejected`,
      action
    );
  }
  return value;
}
var DingtalkDeviceAuthError = class extends Error {
  /**
   * @param {string} code Stable failure code.
   * @param {string} message Safe diagnostic that does not include response credentials.
   * @param {string} action Registration stage that failed.
   * @param {{cause?: unknown}} [options] Optional underlying error.
   */
  constructor(code, message, action, options = {}) {
    super(message, options);
    this.name = "DingtalkDeviceAuthError";
    this.code = code;
    this.action = action;
  }
};
var DingtalkDeviceAuth = class {
  #fetch;
  #clock;
  #baseUrl;
  #timeoutMs;
  /**
   * @param {{fetch?: typeof globalThis.fetch, clock?: {now(): number}|(()=>number), baseUrl?: string, timeoutMs?: number}} [options]
   * Device-registration dependencies.
   */
  constructor({
    fetch: fetch2 = globalThis.fetch,
    clock = Date,
    baseUrl = DEFAULT_REGISTRATION_BASE_URL,
    timeoutMs = 15e3
  } = {}) {
    if (typeof fetch2 !== "function") throw new TypeError("fetch is required");
    if (typeof clock !== "function" && typeof clock?.now !== "function") {
      throw new TypeError("clock must be a function or expose now()");
    }
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      throw new TypeError("timeoutMs must be a positive number");
    }
    this.#fetch = fetch2;
    this.#clock = clock;
    this.#baseUrl = normalizeBaseUrl(baseUrl);
    this.#timeoutMs = timeoutMs;
  }
  /**
   * Starts a QR registration and returns the host-only device code with QR metadata.
   * @param {{signal?: AbortSignal}} [options] Optional cancellation signal.
   * @returns {Promise<object>} Device registration details.
   */
  async start({ signal } = {}) {
    const initialized = await this.#post(
      "/app/registration/init",
      { source: REGISTRATION_SOURCE },
      "initialization",
      signal
    );
    const nonce = cleanString2(initialized.nonce);
    if (!nonce) {
      throw new DingtalkDeviceAuthError(
        "missing-nonce",
        "DingTalk registration initialization did not return a nonce",
        "initialization"
      );
    }
    const begun = await this.#post(
      "/app/registration/begin",
      { nonce },
      "begin",
      signal
    );
    const deviceCode = cleanString2(begun.device_code);
    const verificationUrl = cleanString2(begun.verification_uri_complete);
    if (!deviceCode || !verificationUrl) {
      throw new DingtalkDeviceAuthError(
        "incomplete-registration",
        "DingTalk registration did not return complete QR metadata",
        "begin"
      );
    }
    const expiresInSeconds = positiveNumber(begun.expires_in, 7200);
    const pollIntervalMs = positiveNumber(begun.interval, 5) * 1e3;
    return Object.freeze({
      deviceCode,
      verificationUrl,
      verificationUri: cleanString2(begun.verification_uri),
      userCode: cleanString2(begun.user_code),
      expiresAt: readNow(this.#clock) + expiresInSeconds * 1e3,
      pollIntervalMs
    });
  }
  /**
   * Polls one registration attempt.
   * @param {{deviceCode: string, signal?: AbortSignal}|string} request Host-only device code.
   * @returns {Promise<object>} Normalized registration state and credentials on success.
   */
  async poll(request) {
    const deviceCode = cleanString2(typeof request === "string" ? request : request?.deviceCode);
    const signal = typeof request === "object" ? request?.signal : void 0;
    if (!deviceCode) throw new TypeError("deviceCode is required");
    const response = await this.#post(
      "/app/registration/poll",
      { device_code: deviceCode },
      "poll",
      signal
    );
    const rawStatus = cleanString2(response.status)?.toUpperCase();
    const status = ["WAITING", "SUCCESS", "FAIL", "EXPIRED"].includes(rawStatus) ? rawStatus : "UNKNOWN";
    return Object.freeze({
      status,
      clientId: cleanString2(response.client_id),
      clientSecret: cleanString2(response.client_secret),
      failReason: cleanString2(response.fail_reason)
    });
  }
  async #post(path, body, action, signal) {
    let response;
    const timeoutSignal = AbortSignal.timeout(this.#timeoutMs);
    const requestSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
    try {
      response = await this.#fetch(`${this.#baseUrl}${path}`, {
        method: "POST",
        headers: {
          accept: "application/json",
          "content-type": "application/json"
        },
        body: JSON.stringify(body),
        redirect: "error",
        signal: requestSignal
      });
    } catch (error) {
      if (signal?.aborted) throw signal.reason ?? error;
      if (timeoutSignal.aborted) {
        throw new DingtalkDeviceAuthError(
          "timeout",
          `DingTalk ${action} request timed out`,
          action,
          { cause: error }
        );
      }
      if (error?.name === "AbortError") throw error;
      throw new DingtalkDeviceAuthError(
        "network-error",
        `DingTalk ${action} request could not be completed`,
        action,
        { cause: error }
      );
    }
    if (!response || response.ok === false || typeof response.json !== "function") {
      throw new DingtalkDeviceAuthError(
        "http-error",
        `DingTalk ${action} request failed`,
        action
      );
    }
    let value;
    try {
      value = await response.json();
    } catch (error) {
      throw new DingtalkDeviceAuthError(
        "invalid-json",
        `DingTalk ${action} returned invalid JSON`,
        action,
        { cause: error }
      );
    }
    return assertRecord(value, action);
  }
};

// src/channels/dingtalk/dingtalk-controller.mjs
import { randomUUID as randomUUID2 } from "node:crypto";
var ACTIVE_ATTEMPT_STATES = /* @__PURE__ */ new Set(["starting", "pending", "connecting"]);
var TERMINAL_ATTEMPT_STATES = /* @__PURE__ */ new Set(["connected", "expired", "failed", "cancelled"]);
function cleanString3(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}
function safeError(code, message) {
  return Object.freeze({ code, message });
}
function nowFrom(clock) {
  return typeof clock?.now === "function" ? clock.now() : clock();
}
function isoNow(clock) {
  return new Date(nowFrom(clock)).toISOString();
}
function abortError() {
  return new DOMException("DingTalk provisioning was cancelled", "AbortError");
}
function publicAttempt(record) {
  if (!record) return null;
  return {
    attemptId: record.id,
    status: record.state,
    ...record.verificationUrl ? { verificationUrl: record.verificationUrl } : {},
    ...record.expiresAt ? { expiresAt: record.expiresAt } : {},
    ...record.pollIntervalMs ? { pollIntervalMs: record.pollIntervalMs } : {},
    ...record.botId ? { botId: record.botId } : {},
    ...record.alreadyConnected ? { alreadyConnected: true } : {},
    ...record.error ? { error: structuredClone(record.error) } : {}
  };
}
function runtimeStatus(runtime) {
  if (!runtime) return {};
  const value = typeof runtime.status === "function" ? runtime.status() : runtime.status;
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}
function isRuntimeConnected(runtime, status) {
  if (!runtime) return false;
  if (status.connected === false || status.ready === false) return false;
  const state = cleanString3(
    status.dingtalkStreamState ?? status.dingtalkConnectionState ?? status.connectionState ?? status.state
  )?.toLowerCase();
  if (["failed", "error", "offline", "disconnected", "stopped"].includes(state)) return false;
  return status.connected === true || status.ready === true || state === "connected" || state === "ready";
}
function normalizePendingSender(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const staffId = cleanString3(value.staffId ?? value.senderStaffId ?? value.senderId);
  if (!staffId) return null;
  const suppliedRequestId = cleanString3(value.requestId);
  const opaqueRequestId = suppliedRequestId && /^ding_sender_[A-Za-z0-9_-]{1,100}$/.test(suppliedRequestId) && !suppliedRequestId.includes(staffId) ? suppliedRequestId : null;
  if (!opaqueRequestId) return null;
  return {
    requestId: opaqueRequestId,
    staffId,
    displayName: cleanString3(value.displayName ?? value.senderName ?? value.senderNick) ?? "\u9489\u9489\u7528\u6237",
    requestedAt: cleanString3(value.requestedAt)
  };
}
function internalPendingSenders(status) {
  if (!Array.isArray(status.pendingSenders)) return [];
  const seen = /* @__PURE__ */ new Set();
  const senders = [];
  for (const value of status.pendingSenders) {
    const sender = normalizePendingSender(value);
    if (!sender || seen.has(sender.staffId)) continue;
    seen.add(sender.staffId);
    senders.push(sender);
  }
  return senders;
}
function publicPendingSender(sender) {
  return {
    requestId: sender.requestId,
    displayName: sender.displayName,
    senderIdMasked: maskDingtalkSenderId(sender.staffId),
    requestedAt: sender.requestedAt
  };
}
function publicApprovedSender(sender) {
  return {
    senderKey: sender.senderKey,
    displayName: cleanString3(sender.displayName) ?? "\u9489\u9489\u7528\u6237",
    senderIdMasked: maskDingtalkSenderId(sender.staffId),
    approvedAt: cleanString3(sender.approvedAt)
  };
}
var DingtalkController = class {
  #deviceAuth;
  #credentials;
  #configStore;
  #createRuntime;
  #deleteState;
  #logger;
  #clock;
  #runtimes = /* @__PURE__ */ new Map();
  #errors = /* @__PURE__ */ new Map();
  #attempts = /* @__PURE__ */ new Map();
  #activeAttemptId = null;
  #transitions = /* @__PURE__ */ new Map();
  #revision = 0;
  #closed = false;
  /**
   * @param {object} options Controller dependencies.
   * @param {object} options.deviceAuth Host-only DingTalk device auth client.
   * @param {object} options.credentials DSH credential provider.
   * @param {object} options.configStore Loaded DingTalk config store.
   * @param {Function} options.createRuntime Runtime factory.
   * @param {Function} [options.deleteState] Per-bot state cleanup callback.
   * @param {Console} [options.logger] Host logger.
   * @param {{now(): number}|(()=>number)} [options.clock] Injectable clock.
   */
  constructor({
    deviceAuth,
    credentials,
    configStore,
    createRuntime,
    deleteState = async () => {
    },
    logger = console,
    clock = Date
  }) {
    if (!deviceAuth || typeof deviceAuth.start !== "function" || typeof deviceAuth.poll !== "function") {
      throw new TypeError("DingtalkController requires a DingTalk device auth client");
    }
    if (!credentials || typeof credentials.resolve !== "function" || typeof credentials.set !== "function" || typeof credentials.unset !== "function") {
      throw new TypeError("DingtalkController requires the DSH credential provider");
    }
    if (!configStore || typeof configStore.list !== "function" || typeof configStore.get !== "function" || typeof configStore.getByClientId !== "function" || typeof configStore.save !== "function" || typeof configStore.remove !== "function") {
      throw new TypeError("DingtalkController requires a loaded config store");
    }
    if (typeof createRuntime !== "function") throw new TypeError("createRuntime is required");
    if (typeof deleteState !== "function") throw new TypeError("deleteState must be a function");
    if (typeof clock !== "function" && typeof clock?.now !== "function") {
      throw new TypeError("clock must be a function or expose now()");
    }
    this.#deviceAuth = deviceAuth;
    this.#credentials = credentials;
    this.#configStore = configStore;
    this.#createRuntime = createRuntime;
    this.#deleteState = deleteState;
    this.#logger = logger;
    this.#clock = clock;
  }
  /** Starts all configured DingTalk runtimes whose secrets are available. */
  async initialize() {
    if (this.#closed) return this.status();
    for (const config of this.#configStore.list()) {
      const current = this.#runtimes.get(config.botId);
      try {
        if (isRuntimeConnected(current, runtimeStatus(current))) continue;
      } catch {
      }
      await this.#withBotTransition(config.botId, async () => {
        const latest = this.#configStore.get(config.botId);
        if (!latest || this.#closed) return;
        const clientSecret = await this.#resolveSecret(latest.secretRef);
        if (!clientSecret) {
          this.#errors.set(
            latest.botId,
            safeError("missing-secret", "\u9489\u9489\u673A\u5668\u4EBA\u51ED\u636E\u7F3A\u5931\uFF0C\u8BF7\u79FB\u9664\u540E\u91CD\u65B0\u626B\u7801\u3002")
          );
          this.#touch();
          return;
        }
        try {
          await this.#startRuntime(latest, clientSecret);
          this.#errors.delete(latest.botId);
        } catch {
          this.#errors.set(
            latest.botId,
            safeError("connection-failed", "\u9489\u9489\u8FDE\u63A5\u672A\u5C31\u7EEA\uFF0C\u8BF7\u7A0D\u540E\u91CD\u8BD5\u3002")
          );
          this.#logger.warn?.(`[dsh-dingtalk] bot ${latest.botId} failed to initialize`);
        }
        this.#touch();
      });
    }
    return this.status();
  }
  /** Starts one DingTalk QR registration, cancelling any prior active attempt. */
  async startProvisioning({ signal } = {}) {
    if (this.#closed) throw new Error("dsh-dingtalk controller is closed");
    if (this.#activeAttemptId) await this.cancelProvisioning(this.#activeAttemptId);
    const record = {
      id: randomUUID2(),
      state: "starting",
      controller: new AbortController(),
      deviceCode: null,
      verificationUrl: null,
      expiresAt: null,
      pollIntervalMs: null,
      pollTask: null,
      botId: null,
      alreadyConnected: false,
      error: null
    };
    this.#attempts.set(record.id, record);
    this.#activeAttemptId = record.id;
    this.#touch();
    const abortFromRequest = () => record.controller.abort(signal?.reason);
    if (signal?.aborted) abortFromRequest();
    else signal?.addEventListener("abort", abortFromRequest, { once: true });
    try {
      const begun = await this.#deviceAuth.start({ signal: record.controller.signal });
      this.#assertAttemptActive(record);
      record.deviceCode = cleanString3(begun.deviceCode);
      record.verificationUrl = cleanString3(begun.verificationUrl);
      record.expiresAt = Number(begun.expiresAt);
      record.pollIntervalMs = Number(begun.pollIntervalMs);
      if (!record.deviceCode || !record.verificationUrl || !Number.isFinite(record.expiresAt) || !Number.isFinite(record.pollIntervalMs) || record.pollIntervalMs <= 0) {
        throw new Error("DingTalk device auth returned incomplete registration metadata");
      }
      record.state = "pending";
      this.#touch();
      return publicAttempt(record);
    } catch (error) {
      if (record.controller.signal.aborted || error?.name === "AbortError") {
        record.state = "cancelled";
        record.error = safeError("cancelled", "\u626B\u7801\u63A5\u5165\u5DF2\u53D6\u6D88\u3002");
      } else {
        record.state = "failed";
        record.error = safeError("qr-start-failed", "\u65E0\u6CD5\u751F\u6210\u9489\u9489\u4E8C\u7EF4\u7801\uFF0C\u8BF7\u7A0D\u540E\u91CD\u8BD5\u3002");
      }
      if (this.#activeAttemptId === record.id) this.#activeAttemptId = null;
      this.#touch();
      if (record.state === "failed") throw error;
      return publicAttempt(record);
    } finally {
      signal?.removeEventListener("abort", abortFromRequest);
    }
  }
  /** Polls one QR registration without exposing its device code or returned secret. */
  async registrationStatus(attemptId) {
    const record = this.#attempts.get(attemptId);
    if (!record) return null;
    if (TERMINAL_ATTEMPT_STATES.has(record.state) || record.state === "starting") {
      return publicAttempt(record);
    }
    if (nowFrom(this.#clock) >= record.expiresAt) {
      record.state = "expired";
      record.error = safeError("expired", "\u4E8C\u7EF4\u7801\u5DF2\u8FC7\u671F\uFF0C\u8BF7\u91CD\u65B0\u751F\u6210\u3002");
      if (this.#activeAttemptId === record.id) this.#activeAttemptId = null;
      this.#touch();
      return publicAttempt(record);
    }
    if (!record.pollTask) {
      const task = this.#pollRegistration(record).finally(() => {
        if (record.pollTask === task) record.pollTask = null;
      });
      record.pollTask = task;
    }
    await record.pollTask;
    return publicAttempt(record);
  }
  /** Cancels an active QR registration. */
  async cancelProvisioning(attemptId) {
    const record = this.#attempts.get(attemptId);
    if (!record) return null;
    if (!TERMINAL_ATTEMPT_STATES.has(record.state)) {
      record.controller.abort();
      await record.pollTask?.catch(() => void 0);
      if (!TERMINAL_ATTEMPT_STATES.has(record.state)) record.state = "cancelled";
      record.error ??= safeError("cancelled", "\u626B\u7801\u63A5\u5165\u5DF2\u53D6\u6D88\u3002");
    }
    if (this.#activeAttemptId === record.id) this.#activeAttemptId = null;
    this.#touch();
    return publicAttempt(record);
  }
  /** Replaces one bot runtime using its stored credential. */
  async reconnectBot(botId) {
    const config = this.#configStore.get(botId);
    if (!config) throw new Error("Unknown DingTalk bot");
    await this.#withBotTransition(botId, async () => {
      const clientSecret = await this.#resolveSecret(config.secretRef);
      if (!clientSecret) throw new Error("The DingTalk client secret is missing");
      try {
        await this.#startRuntime(config, clientSecret);
        this.#errors.delete(botId);
      } catch (error) {
        this.#errors.set(
          botId,
          safeError("connection-failed", "\u9489\u9489\u8FDE\u63A5\u4ECD\u672A\u5C31\u7EEA\uFF0C\u8BF7\u7A0D\u540E\u91CD\u8BD5\u3002")
        );
        throw error;
      } finally {
        this.#touch();
      }
    });
    return this.status();
  }
  /** Removes one bot, its secret, runtime, and local conversation state. */
  async deleteBot(botId) {
    const config = this.#configStore.get(botId);
    if (!config) throw new Error("Unknown DingTalk bot");
    await this.#withBotTransition(botId, async () => {
      const previousSecret = await this.#credentials.resolve(config.secretRef).catch(() => void 0);
      await this.#stopRuntime(botId);
      try {
        await this.#credentials.unset(config.secretRef);
        await this.#configStore.remove(botId);
      } catch (error) {
        if (cleanString3(previousSecret?.value)) {
          await this.#credentials.set(config.secretRef, previousSecret.value).catch(() => void 0);
          await this.#startRuntime(config, previousSecret.value).catch(() => void 0);
        }
        throw new Error("Unable to remove the DingTalk bot safely.", { cause: error });
      }
      try {
        await this.#deleteState({ botId, config });
      } catch {
        this.#logger.warn?.(`[dsh-dingtalk] bot ${botId} state cleanup failed`);
      }
      this.#errors.delete(botId);
      this.#touch();
    });
    return this.status();
  }
  /** Approves one opaque pending-sender request for a bot. */
  async approveSender(botId, requestId) {
    const config = this.#configStore.get(botId);
    if (!config) throw new Error("Unknown DingTalk bot");
    const runtime = this.#runtimes.get(botId);
    const direct = typeof runtime?.pendingSender === "function" ? normalizePendingSender(runtime.pendingSender(requestId)) : null;
    const pending = internalPendingSenders(runtimeStatus(runtime));
    const sender = direct?.requestId === requestId ? direct : pending.find((candidate) => candidate.requestId === requestId);
    if (!sender) throw new Error("Unknown DingTalk sender approval request");
    if (config.approvedSenders.some((approved) => approved.staffId === sender.staffId)) {
      return this.status();
    }
    const updated = {
      ...config,
      approvedSenders: [
        ...config.approvedSenders,
        {
          senderKey: deriveDingtalkSenderKey(),
          staffId: sender.staffId,
          displayName: sender.displayName,
          approvedAt: isoNow(this.#clock)
        }
      ]
    };
    await this.#saveAndRestart(config, updated);
    return this.status();
  }
  /** Revokes one approved sender by its browser-safe sender key. */
  async revokeSender(botId, senderKey) {
    const config = this.#configStore.get(botId);
    if (!config) throw new Error("Unknown DingTalk bot");
    const index = config.approvedSenders.findIndex(
      (sender) => sender.senderKey === senderKey
    );
    if (index === -1) throw new Error("Unknown approved DingTalk sender");
    const approvedSenders = [...config.approvedSenders];
    approvedSenders.splice(index, 1);
    await this.#saveAndRestart(config, { ...config, approvedSenders });
    return this.status();
  }
  /** Returns browser-safe bot, health, and sender-approval state. */
  status() {
    const bots = this.#configStore.list().map((config) => {
      const runtime = this.#runtimes.get(config.botId);
      let currentStatus = {};
      try {
        currentStatus = runtimeStatus(runtime);
      } catch {
        currentStatus = { state: "error" };
      }
      const connected = isRuntimeConnected(runtime, currentStatus);
      const accountError = this.#errors.get(config.botId);
      const state = connected ? "connected" : accountError ? "error" : "offline";
      const approvedIds = new Set(config.approvedSenders.map((sender) => sender.staffId));
      const pending = internalPendingSenders(currentStatus).filter((sender) => !approvedIds.has(sender.staffId)).map(publicPendingSender);
      return {
        botId: config.botId,
        state,
        connected,
        configured: true,
        bot: {
          name: "\u9489\u9489\u673A\u5668\u4EBA",
          clientIdMasked: maskDingtalkClientId(config.clientId)
        },
        health: {
          status: connected ? "healthy" : accountError ? "error" : "offline",
          summary: connected ? "\u9489\u9489 Stream \u6D88\u606F\u8FDE\u63A5\u8FD0\u884C\u6B63\u5E38" : accountError?.message ?? "\u9489\u9489\u6D88\u606F\u8FDE\u63A5\u5F53\u524D\u79BB\u7EBF",
          lastCheckedAt: currentStatus.lastCheckedAt ?? null
        },
        stats: {
          messagesReceived: Number(currentStatus.messagesReceived) || 0,
          messagesReplied: Number(currentStatus.messagesReplied) || 0
        },
        senders: {
          pending,
          approved: config.approvedSenders.map(publicApprovedSender)
        },
        error: accountError ? structuredClone(accountError) : null
      };
    });
    const connectedCount = bots.filter((bot) => bot.connected).length;
    const active = this.#activeAttemptId ? this.#attempts.get(this.#activeAttemptId) : null;
    return {
      schemaVersion: 1,
      revision: this.#revision,
      state: active && ACTIVE_ATTEMPT_STATES.has(active.state) ? "provisioning" : bots.length === 0 ? "disconnected" : connectedCount === bots.length ? "connected" : connectedCount > 0 ? "degraded" : "offline",
      bots,
      totals: { configured: bots.length, connected: connectedCount },
      ...active && ACTIVE_ATTEMPT_STATES.has(active.state) ? { provisioning: publicAttempt(active) } : {}
    };
  }
  /** Cancels provisioning and stops every bot runtime. */
  async close() {
    if (this.#closed) return;
    this.#closed = true;
    if (this.#activeAttemptId) await this.cancelProvisioning(this.#activeAttemptId);
    await Promise.allSettled([...this.#runtimes.keys()].map((botId) => this.#stopRuntime(botId)));
    await Promise.allSettled([...this.#transitions.values()]);
    await Promise.allSettled([...this.#runtimes.keys()].map((botId) => this.#stopRuntime(botId)));
  }
  async #pollRegistration(record) {
    try {
      this.#assertAttemptActive(record);
      const response = await this.#deviceAuth.poll({
        deviceCode: record.deviceCode,
        signal: record.controller.signal
      });
      this.#assertAttemptActive(record);
      const state = cleanString3(response.status)?.toUpperCase();
      if (state === "WAITING") {
        record.state = "pending";
        record.error = null;
      } else if (state === "SUCCESS") {
        const clientId = cleanString3(response.clientId);
        const clientSecret = cleanString3(response.clientSecret);
        if (!clientId || !clientSecret) throw new Error("DingTalk returned incomplete credentials");
        record.state = "connecting";
        record.error = null;
        this.#touch();
        const activation = await this.#activateBot(record, { clientId, clientSecret });
        record.botId = activation.botId;
        record.alreadyConnected = activation.alreadyConnected;
        record.state = "connected";
        if (this.#activeAttemptId === record.id) this.#activeAttemptId = null;
      } else if (state === "EXPIRED") {
        record.state = "expired";
        record.error = safeError("expired", "\u4E8C\u7EF4\u7801\u5DF2\u8FC7\u671F\uFF0C\u8BF7\u91CD\u65B0\u751F\u6210\u3002");
        if (this.#activeAttemptId === record.id) this.#activeAttemptId = null;
      } else if (state === "FAIL") {
        record.state = "failed";
        record.error = safeError("authorization-failed", "\u9489\u9489\u672A\u5B8C\u6210\u673A\u5668\u4EBA\u6388\u6743\uFF0C\u8BF7\u91CD\u65B0\u626B\u7801\u3002");
        if (this.#activeAttemptId === record.id) this.#activeAttemptId = null;
      } else {
        record.state = "pending";
        record.error = safeError("poll-pending", "\u9489\u9489\u6388\u6743\u72B6\u6001\u6682\u65F6\u4E0D\u53EF\u7528\uFF0C\u6B63\u5728\u91CD\u8BD5\u3002");
      }
    } catch (error) {
      if (record.controller.signal.aborted || error?.name === "AbortError") {
        record.state = "cancelled";
        record.error = safeError("cancelled", "\u626B\u7801\u63A5\u5165\u5DF2\u53D6\u6D88\u3002");
        if (this.#activeAttemptId === record.id) this.#activeAttemptId = null;
      } else if (record.state === "connecting") {
        record.state = "failed";
        record.error = safeError(
          "activation-failed",
          "\u9489\u9489\u5DF2\u6388\u6743\uFF0C\u4F46\u65E0\u6CD5\u5B89\u5168\u4FDD\u5B58\u63A5\u5165\u914D\u7F6E\u3002"
        );
        if (this.#activeAttemptId === record.id) this.#activeAttemptId = null;
        this.#logger.error?.("[dsh-dingtalk] bot activation failed");
      } else {
        record.state = "pending";
        record.error = safeError("poll-failed", "\u9489\u9489\u6388\u6743\u67E5\u8BE2\u6682\u65F6\u5931\u8D25\uFF0C\u6B63\u5728\u91CD\u8BD5\u3002");
      }
    } finally {
      this.#touch();
      this.#pruneAttempts();
    }
  }
  async #activateBot(record, { clientId, clientSecret }) {
    const identity = deriveDingtalkBotIdentity(clientId);
    const previousConfig = this.#configStore.getByClientId(clientId);
    const previousSecret = await this.#credentials.resolve(identity.secretRef).catch(() => void 0);
    const config = {
      botId: identity.botId,
      clientId,
      secretRef: identity.secretRef,
      approvedSenders: previousConfig?.approvedSenders ?? []
    };
    return this.#withBotTransition(identity.botId, async () => {
      const rollback = async () => {
        await this.#stopRuntime(identity.botId);
        if (previousConfig) await this.#configStore.save(previousConfig).catch(() => void 0);
        else if (this.#configStore.get(identity.botId)) {
          await this.#configStore.remove(identity.botId).catch(() => void 0);
        }
        await this.#restoreCredential(identity.secretRef, previousSecret);
        if (previousConfig && cleanString3(previousSecret?.value)) {
          await this.#startRuntime(previousConfig, previousSecret.value).catch(() => void 0);
        }
      };
      await this.#credentials.set(identity.secretRef, clientSecret);
      try {
        this.#assertAttemptActive(record);
        await this.#configStore.save(config);
        this.#assertAttemptActive(record);
      } catch (error) {
        await rollback();
        throw error;
      }
      try {
        await this.#startRuntime(config, clientSecret);
        this.#assertAttemptActive(record);
        this.#errors.delete(identity.botId);
      } catch (error) {
        if (record.controller.signal.aborted || this.#activeAttemptId !== record.id) {
          await rollback();
          throw abortError();
        }
        this.#errors.set(
          identity.botId,
          safeError("connection-failed", "\u9489\u9489\u5DF2\u63A5\u5165\uFF0C\u4F46\u6D88\u606F\u8FDE\u63A5\u6682\u672A\u5C31\u7EEA\uFF0C\u8BF7\u7A0D\u540E\u91CD\u8BD5\u3002")
        );
        this.#logger.warn?.("[dsh-dingtalk] authorized bot saved but its connection is not ready");
      }
      return { botId: identity.botId, alreadyConnected: Boolean(previousConfig) };
    });
  }
  async #saveAndRestart(previousConfig, nextConfig) {
    return this.#withBotTransition(previousConfig.botId, async () => {
      const clientSecret = await this.#resolveSecret(previousConfig.secretRef);
      if (!clientSecret) throw new Error("The DingTalk client secret is missing");
      await this.#configStore.save(nextConfig);
      try {
        await this.#startRuntime(nextConfig, clientSecret);
        this.#errors.delete(previousConfig.botId);
      } catch (error) {
        await this.#configStore.save(previousConfig).catch(() => void 0);
        await this.#startRuntime(previousConfig, clientSecret).catch(() => void 0);
        this.#errors.set(
          previousConfig.botId,
          safeError("connection-failed", "\u9489\u9489\u8FDE\u63A5\u672A\u5C31\u7EEA\uFF0C\u8BF7\u7A0D\u540E\u91CD\u8BD5\u3002")
        );
        throw error;
      } finally {
        this.#touch();
      }
    });
  }
  async #startRuntime(config, clientSecret) {
    if (this.#closed) throw abortError();
    await this.#stopRuntime(config.botId);
    if (this.#closed) throw abortError();
    const runtime = await this.#createRuntime({
      botId: config.botId,
      config: structuredClone(config),
      clientSecret
    });
    if (!runtime || typeof runtime.start !== "function" || typeof runtime.stop !== "function") {
      throw new TypeError("createRuntime returned an invalid DingTalk runtime");
    }
    if (this.#closed) {
      await runtime.stop().catch(() => void 0);
      throw abortError();
    }
    this.#runtimes.set(config.botId, runtime);
    try {
      await runtime.start();
      if (this.#closed) {
        await runtime.stop().catch(() => void 0);
        throw abortError();
      }
    } catch (error) {
      if (this.#runtimes.get(config.botId) === runtime) this.#runtimes.delete(config.botId);
      await runtime.stop().catch(() => void 0);
      throw error;
    }
  }
  async #stopRuntime(botId) {
    const runtime = this.#runtimes.get(botId);
    this.#runtimes.delete(botId);
    await runtime?.stop().catch(() => {
      this.#logger.warn?.(`[dsh-dingtalk] bot ${botId} failed to stop cleanly`);
    });
  }
  async #resolveSecret(secretRef) {
    const result = await this.#credentials.resolve(secretRef).catch(() => void 0);
    return cleanString3(result?.value);
  }
  async #restoreCredential(secretRef, previous) {
    try {
      if (cleanString3(previous?.value)) await this.#credentials.set(secretRef, previous.value);
      else await this.#credentials.unset(secretRef);
    } catch {
      this.#logger.error?.(`[dsh-dingtalk] failed to restore credential ${secretRef}`);
    }
  }
  #assertAttemptActive(record) {
    if (record.controller.signal.aborted || this.#activeAttemptId !== record.id) throw abortError();
  }
  #withBotTransition(botId, operation) {
    if (this.#closed) return Promise.reject(new Error("dsh-dingtalk controller is closed"));
    const previous = this.#transitions.get(botId) ?? Promise.resolve();
    const current = previous.catch(() => void 0).then(operation);
    const settled = current.finally(() => {
      if (this.#transitions.get(botId) === settled) this.#transitions.delete(botId);
    });
    this.#transitions.set(botId, settled);
    return settled;
  }
  #pruneAttempts() {
    for (const [id, record] of this.#attempts) {
      if (id !== this.#activeAttemptId && TERMINAL_ATTEMPT_STATES.has(record.state) && this.#attempts.size > 16) {
        this.#attempts.delete(id);
      }
    }
  }
  #touch() {
    this.#revision += 1;
  }
};

// src/channels/dingtalk/dingtalk-api.mjs
import { randomUUID as randomUUID3 } from "node:crypto";
var DINGTALK_REGISTRATION_BASE_URL = "https://oapi.dingtalk.com/";
var DINGTALK_API_BASE_URL = "https://api.dingtalk.com/";
var DINGTALK_REGISTRATION_SOURCE = "DING_DWS_CLAW";
var DINGTALK_AI_CARD_TEMPLATE_ID = "02fcf2f4-5e02-4a85-b672-46d1f715543e.schema";
var DEFAULT_TIMEOUT_MS = 15e3;
var REGISTRATION_STATUSES = /* @__PURE__ */ new Set(["WAITING", "SUCCESS", "FAIL", "EXPIRED"]);
var DingtalkApiError = class extends Error {
  constructor(code, message, options = {}) {
    super(message, options);
    this.name = "DingtalkApiError";
    this.code = code;
    this.status = options.status;
  }
};
function nonEmptyString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}
function isDingtalkHost(hostname) {
  const normalized = hostname.toLowerCase().replace(/\.$/, "");
  return normalized === "dingtalk.com" || normalized.endsWith(".dingtalk.com");
}
function normalizeTrustedUrl(value, { label, requireSubdomain = true } = {}) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new DingtalkApiError("invalid-url", `${label ?? "\u9489\u9489\u670D\u52A1"}\u8FD4\u56DE\u4E86\u65E0\u6548\u5730\u5740\u3002`);
  }
  const normalizedHost = url.hostname.toLowerCase().replace(/\.$/, "");
  const trustedHost = requireSubdomain ? normalizedHost !== "dingtalk.com" && isDingtalkHost(normalizedHost) : isDingtalkHost(normalizedHost);
  if (url.protocol !== "https:" || !trustedHost || url.port && url.port !== "443") {
    throw new DingtalkApiError("untrusted-url", `${label ?? "\u9489\u9489\u670D\u52A1"}\u5730\u5740\u4E0D\u53D7\u4FE1\u4EFB\u3002`);
  }
  if (url.username || url.password) {
    throw new DingtalkApiError("untrusted-url", `${label ?? "\u9489\u9489\u670D\u52A1"}\u5730\u5740\u4E0D\u53D7\u4FE1\u4EFB\u3002`);
  }
  return url;
}
function normalizeDingtalkSessionWebhook(value) {
  const text = nonEmptyString(value);
  if (!text) throw new DingtalkApiError("invalid-session-webhook", "\u9489\u9489\u6D88\u606F\u6CA1\u6709\u53EF\u7528\u7684\u56DE\u590D\u5730\u5740\u3002");
  const url = normalizeTrustedUrl(text, { label: "\u9489\u9489\u56DE\u590D", requireSubdomain: false });
  url.hash = "";
  return url.toString();
}
function splitDingtalkText(value, maxChars = 4e3) {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text) return [];
  if (!Number.isInteger(maxChars) || maxChars < 1) throw new TypeError("maxChars must be a positive integer");
  if (text.length <= maxChars) return [text];
  const chunks = [];
  let remaining = text;
  while (remaining.length > maxChars) {
    let splitAt = remaining.lastIndexOf("\n", maxChars);
    if (splitAt < Math.floor(maxChars * 0.6)) splitAt = maxChars;
    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt).replace(/^\n+/, "");
  }
  if (remaining) chunks.push(remaining);
  return chunks;
}
function abortError2(signal) {
  if (signal?.reason instanceof Error) return signal.reason;
  return new DOMException("The operation was aborted", "AbortError");
}
function abortableDelay(ms, signal) {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve6, reject) => {
    if (signal?.aborted) {
      reject(abortError2(signal));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve6();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortError2(signal));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
async function requestJson(fetchImpl, url, {
  body,
  signal,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  headers = {},
  method = "POST",
  action = "request"
} = {}) {
  const controller = new AbortController();
  let timedOut = false;
  const onAbort = () => controller.abort(signal?.reason);
  if (signal?.aborted) throw abortError2(signal);
  signal?.addEventListener("abort", onAbort, { once: true });
  const timer = timeoutMs > 0 ? setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs) : null;
  try {
    const response = await fetchImpl(url, {
      method,
      redirect: "error",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body ?? {}),
      signal: controller.signal
    });
    if (!response.ok) {
      throw new DingtalkApiError(
        "http-error",
        `\u9489\u9489\u670D\u52A1\u8BF7\u6C42\u5931\u8D25\uFF08HTTP ${response.status}\uFF09\u3002`,
        { status: response.status }
      );
    }
    try {
      return await response.json();
    } catch (error) {
      throw new DingtalkApiError("invalid-response", "\u9489\u9489\u670D\u52A1\u8FD4\u56DE\u4E86\u65E0\u6CD5\u89E3\u6790\u7684\u54CD\u5E94\u3002", { cause: error });
    }
  } catch (error) {
    if (signal?.aborted) throw abortError2(signal);
    if (timedOut) throw new DingtalkApiError("timeout", "\u9489\u9489\u670D\u52A1\u8BF7\u6C42\u8D85\u65F6\u3002", { cause: error });
    if (error instanceof DingtalkApiError) throw error;
    throw new DingtalkApiError("network-error", `\u6682\u65F6\u65E0\u6CD5\u5B8C\u6210\u9489\u9489${action}\u8BF7\u6C42\u3002`, { cause: error });
  } finally {
    if (timer) clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  }
}
function normalizeCardTarget(target) {
  if (target?.type === "user") {
    const userId = nonEmptyString(target.userId);
    if (userId) return { type: "user", userId };
  }
  if (target?.type === "group") {
    const openConversationId = nonEmptyString(target.openConversationId);
    if (openConversationId) return { type: "group", openConversationId };
  }
  throw new TypeError("DingTalk AI Card target is invalid");
}
function cardData(text, flowStatus) {
  return {
    cardParamMap: {
      flowStatus,
      msgContent: normalizeDingtalkCardMarkdown(text),
      staticMsgContent: "",
      sys_full_json_obj: JSON.stringify({ order: ["msgContent"] }),
      config: JSON.stringify({ autoLayout: true })
    }
  };
}
function cardDeliverBody(cardInstanceId, target, robotCode) {
  const base = { outTrackId: cardInstanceId, userIdType: 1 };
  if (target.type === "group") {
    return {
      ...base,
      openSpaceId: `dtv1.card//IM_GROUP.${target.openConversationId}`,
      imGroupOpenDeliverModel: { robotCode }
    };
  }
  return {
    ...base,
    openSpaceId: `dtv1.card//IM_ROBOT.${target.userId}`,
    imRobotOpenDeliverModel: {
      spaceType: "IM_ROBOT",
      robotCode,
      extension: { dynamicSummary: "true" }
    }
  };
}
function normalizeDingtalkCardMarkdown(value) {
  const text = typeof value === "string" ? value.replace(/\r\n?/g, "\n") : "";
  const lines = text.split("\n");
  let inCodeBlock = false;
  return lines.map((line, index) => {
    const fenced = /^\s{0,3}```/.test(line);
    const currentInCodeBlock = inCodeBlock;
    if (fenced) inCodeBlock = !inCodeBlock;
    if (index === lines.length - 1) return line;
    if (currentInCodeBlock || fenced || inCodeBlock || !line || !lines[index + 1]) return `${line}
`;
    if (/^\s{0,3}(?:[-*+] |\d+[.)] |#{1,6} |\||> )/.test(lines[index + 1])) return `${line}
`;
    return `${line}<br>`;
  }).join("");
}
function assertRegistrationOk(value, action) {
  if (!value || typeof value !== "object" || value.errcode !== 0) {
    throw new DingtalkApiError(
      "registration-rejected",
      `\u9489\u9489\u626B\u7801${action}\u5931\u8D25\u3002`
    );
  }
  return value;
}
function positiveNumber2(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}
function createDingtalkApi({
  fetchImpl = fetch,
  registrationBaseUrl = process.env.DINGTALK_REGISTRATION_BASE_URL || DINGTALK_REGISTRATION_BASE_URL,
  registrationSource = process.env.DINGTALK_REGISTRATION_SOURCE || DINGTALK_REGISTRATION_SOURCE,
  now = () => Date.now(),
  cardMinIntervalMs = 50,
  cardBackoffMs = 1e3,
  delay: delay2 = abortableDelay
} = {}) {
  if (typeof fetchImpl !== "function") throw new TypeError("fetchImpl must be a function");
  if (typeof now !== "function") throw new TypeError("now must be a function");
  if (!Number.isFinite(cardMinIntervalMs) || cardMinIntervalMs < 0) {
    throw new TypeError("cardMinIntervalMs must be a non-negative number");
  }
  if (!Number.isFinite(cardBackoffMs) || cardBackoffMs < 0) {
    throw new TypeError("cardBackoffMs must be a non-negative number");
  }
  if (typeof delay2 !== "function") throw new TypeError("delay must be a function");
  const registrationBase = normalizeTrustedUrl(registrationBaseUrl, {
    label: "\u9489\u9489\u6CE8\u518C\u670D\u52A1",
    requireSubdomain: false
  });
  const apiBase = new URL(DINGTALK_API_BASE_URL);
  const source = nonEmptyString(registrationSource);
  if (!source) throw new TypeError("registrationSource is required");
  const tokenCache = /* @__PURE__ */ new Map();
  const tokenRequests = /* @__PURE__ */ new Map();
  let cardSlotTail = Promise.resolve();
  let nextCardRequestAt = 0;
  const endpoint = (base, pathname) => new URL(pathname.replace(/^\//, ""), base);
  async function accessToken({ clientId, clientSecret, signal }) {
    const appKey = nonEmptyString(clientId);
    const appSecret = nonEmptyString(clientSecret);
    if (!appKey || !appSecret) throw new TypeError("clientId and clientSecret are required");
    const cached = tokenCache.get(appKey);
    if (cached && cached.expiresAt > now()) return cached.token;
    if (tokenRequests.has(appKey)) return tokenRequests.get(appKey);
    const request = (async () => {
      const value = await requestJson(fetchImpl, endpoint(apiBase, "v1.0/oauth2/accessToken"), {
        body: { appKey, appSecret },
        signal,
        action: "\u9274\u6743"
      });
      const token = nonEmptyString(value?.accessToken);
      if (!token) throw new DingtalkApiError("invalid-access-token", "\u9489\u9489\u670D\u52A1\u6CA1\u6709\u8FD4\u56DE\u8BBF\u95EE\u4EE4\u724C\u3002");
      const expiresInSeconds = positiveNumber2(value?.expireIn ?? value?.expiresIn, 7200);
      const refreshAfterMs = Math.max(1e3, (expiresInSeconds - 60) * 1e3);
      tokenCache.set(appKey, { token, expiresAt: now() + refreshAfterMs });
      return token;
    })().finally(() => tokenRequests.delete(appKey));
    tokenRequests.set(appKey, request);
    return request;
  }
  function acquireCardRequestSlot(signal) {
    const acquire = async () => {
      const waitMs = Math.max(0, nextCardRequestAt - now());
      if (waitMs > 0) await delay2(waitMs, signal);
      nextCardRequestAt = Math.max(nextCardRequestAt, now()) + cardMinIntervalMs;
    };
    const slot = cardSlotTail.then(acquire, acquire);
    cardSlotTail = slot.catch(() => void 0);
    return slot;
  }
  async function cardRequest(pathname, options) {
    await acquireCardRequestSlot(options.signal);
    try {
      return await requestJson(fetchImpl, endpoint(apiBase, pathname), options);
    } catch (error) {
      if (!(error instanceof DingtalkApiError) || error.status !== 403) throw error;
      await delay2(cardBackoffMs, options.signal);
      await acquireCardRequestSlot(options.signal);
      return requestJson(fetchImpl, endpoint(apiBase, pathname), options);
    }
  }
  async function failCard({ clientId, clientSecret, cardInstanceId, text, signal }) {
    const instanceId = nonEmptyString(cardInstanceId);
    const content = nonEmptyString(text);
    if (!instanceId) throw new TypeError("cardInstanceId is required");
    if (!content) throw new TypeError("text is required");
    const token = await accessToken({ clientId, clientSecret, signal });
    const headers = { "x-acs-dingtalk-access-token": token };
    const requests = [
      cardRequest("v1.0/card/streaming", {
        method: "PUT",
        body: {
          outTrackId: instanceId,
          guid: randomUUID3(),
          key: "msgContent",
          content: normalizeDingtalkCardMarkdown(content),
          isFull: true,
          isFinalize: false,
          isError: true
        },
        headers,
        signal,
        action: "AI Card \u5931\u8D25\u6536\u53E3"
      }),
      cardRequest("v1.0/card/instances", {
        method: "PUT",
        body: {
          outTrackId: instanceId,
          cardData: cardData(content, "5"),
          cardUpdateOptions: { updateCardDataByKey: true }
        },
        headers,
        signal,
        action: "AI Card \u5931\u8D25\u72B6\u6001"
      })
    ];
    const results = await Promise.allSettled(requests);
    if (results.every(({ status }) => status === "rejected")) throw results[0].reason;
    return true;
  }
  return Object.freeze({
    async beginRegistration({ signal } = {}) {
      const initialized = assertRegistrationOk(await requestJson(
        fetchImpl,
        endpoint(registrationBase, "app/registration/init"),
        { body: { source }, signal, action: "\u521D\u59CB\u5316" }
      ), "\u521D\u59CB\u5316");
      const nonce = nonEmptyString(initialized.nonce);
      if (!nonce) throw new DingtalkApiError("invalid-registration", "\u9489\u9489\u626B\u7801\u521D\u59CB\u5316\u7F3A\u5C11 nonce\u3002");
      const begun = assertRegistrationOk(await requestJson(
        fetchImpl,
        endpoint(registrationBase, "app/registration/begin"),
        { body: { nonce }, signal, action: "\u521B\u5EFA" }
      ), "\u521B\u5EFA");
      const deviceCode = nonEmptyString(begun.device_code);
      const verificationUriComplete = nonEmptyString(begun.verification_uri_complete);
      if (!deviceCode || !verificationUriComplete) {
        throw new DingtalkApiError("invalid-registration", "\u9489\u9489\u626B\u7801\u670D\u52A1\u8FD4\u56DE\u7684\u4FE1\u606F\u4E0D\u5B8C\u6574\u3002");
      }
      const verificationUrl = normalizeTrustedUrl(verificationUriComplete, {
        label: "\u9489\u9489\u626B\u7801",
        requireSubdomain: false
      }).toString();
      return {
        deviceCode,
        userCode: nonEmptyString(begun.user_code) ?? void 0,
        verificationUri: nonEmptyString(begun.verification_uri) ?? void 0,
        verificationUriComplete: verificationUrl,
        expiresInSeconds: positiveNumber2(begun.expires_in, 7200),
        intervalSeconds: positiveNumber2(begun.interval, 5)
      };
    },
    async pollRegistration({ deviceCode, signal } = {}) {
      const code = nonEmptyString(deviceCode);
      if (!code) throw new TypeError("deviceCode is required");
      const polled = assertRegistrationOk(await requestJson(
        fetchImpl,
        endpoint(registrationBase, "app/registration/poll"),
        { body: { device_code: code }, signal, action: "\u72B6\u6001\u67E5\u8BE2" }
      ), "\u72B6\u6001\u67E5\u8BE2");
      const status = nonEmptyString(polled.status)?.toUpperCase();
      if (!status || !REGISTRATION_STATUSES.has(status)) {
        throw new DingtalkApiError("invalid-registration-status", "\u9489\u9489\u626B\u7801\u670D\u52A1\u8FD4\u56DE\u4E86\u65E0\u6CD5\u8BC6\u522B\u7684\u72B6\u6001\u3002");
      }
      const result = {
        status,
        failReason: nonEmptyString(polled.fail_reason) ?? void 0
      };
      if (status === "SUCCESS") {
        result.clientId = nonEmptyString(polled.client_id) ?? void 0;
        result.clientSecret = nonEmptyString(polled.client_secret) ?? void 0;
        if (!result.clientId || !result.clientSecret) {
          throw new DingtalkApiError("missing-credentials", "\u9489\u9489\u626B\u7801\u5DF2\u786E\u8BA4\uFF0C\u4F46\u6CA1\u6709\u8FD4\u56DE\u673A\u5668\u4EBA\u51ED\u636E\u3002");
        }
      }
      return result;
    },
    accessToken,
    async createAiCard({ clientId, clientSecret, target, initialText, signal }) {
      const appKey = nonEmptyString(clientId);
      const appSecret = nonEmptyString(clientSecret);
      const content = nonEmptyString(initialText);
      if (!appKey || !appSecret) throw new TypeError("clientId and clientSecret are required");
      if (!content) throw new TypeError("initialText is required");
      const normalizedTarget = normalizeCardTarget(target);
      const token = await accessToken({ clientId: appKey, clientSecret: appSecret, signal });
      const cardInstanceId = `dsh_${randomUUID3()}`;
      const headers = { "x-acs-dingtalk-access-token": token };
      let delivered = false;
      try {
        await cardRequest("v1.0/card/instances", {
          body: {
            cardTemplateId: DINGTALK_AI_CARD_TEMPLATE_ID,
            outTrackId: cardInstanceId,
            cardData: {
              cardParamMap: { config: JSON.stringify({ autoLayout: true }) }
            },
            callbackType: "STREAM",
            imGroupOpenSpaceModel: { supportForward: true },
            imRobotOpenSpaceModel: { supportForward: true }
          },
          headers,
          signal,
          action: "AI Card \u521B\u5EFA"
        });
        await cardRequest("v1.0/card/instances/deliver", {
          body: cardDeliverBody(cardInstanceId, normalizedTarget, appKey),
          headers,
          signal,
          action: "AI Card \u6295\u653E"
        });
        delivered = true;
        await cardRequest("v1.0/card/instances", {
          method: "PUT",
          body: { outTrackId: cardInstanceId, cardData: cardData(content, "2") },
          headers,
          signal,
          action: "AI Card \u542F\u52A8"
        });
        await cardRequest("v1.0/card/streaming", {
          method: "PUT",
          body: {
            outTrackId: cardInstanceId,
            guid: randomUUID3(),
            key: "msgContent",
            content: normalizeDingtalkCardMarkdown(content).replace(/\n+$/, ""),
            isFull: true,
            isFinalize: false,
            isError: false
          },
          headers,
          signal,
          action: "AI Card \u542F\u52A8"
        });
      } catch (error) {
        if (delivered) {
          const cleanupSignal = AbortSignal.timeout(5e3);
          await failCard({
            clientId: appKey,
            clientSecret: appSecret,
            cardInstanceId,
            text: "\u6D88\u606F\u5904\u7406\u5931\u8D25\uFF0C\u8BF7\u7A0D\u540E\u91CD\u8BD5\u3002",
            signal: cleanupSignal
          }).catch(() => void 0);
        }
        throw error;
      }
      return { cardInstanceId };
    },
    async updateAiCard({ clientId, clientSecret, cardInstanceId, text, signal }) {
      const instanceId = nonEmptyString(cardInstanceId);
      const content = nonEmptyString(text);
      if (!instanceId) throw new TypeError("cardInstanceId is required");
      if (!content) throw new TypeError("text is required");
      const token = await accessToken({ clientId, clientSecret, signal });
      await cardRequest("v1.0/card/streaming", {
        method: "PUT",
        body: {
          outTrackId: instanceId,
          guid: randomUUID3(),
          key: "msgContent",
          content: normalizeDingtalkCardMarkdown(content).replace(/\n+$/, ""),
          isFull: true,
          isFinalize: false,
          isError: false
        },
        headers: { "x-acs-dingtalk-access-token": token },
        signal,
        action: "AI Card \u66F4\u65B0"
      });
      return true;
    },
    async finishAiCard({ clientId, clientSecret, cardInstanceId, text, signal }) {
      const instanceId = nonEmptyString(cardInstanceId);
      const content = nonEmptyString(text);
      if (!instanceId) throw new TypeError("cardInstanceId is required");
      if (!content) throw new TypeError("text is required");
      const token = await accessToken({ clientId, clientSecret, signal });
      const headers = { "x-acs-dingtalk-access-token": token };
      const normalizedContent = normalizeDingtalkCardMarkdown(content);
      await cardRequest("v1.0/card/streaming", {
        method: "PUT",
        body: {
          outTrackId: instanceId,
          guid: randomUUID3(),
          key: "msgContent",
          content: normalizedContent,
          isFull: true,
          isFinalize: true,
          isError: false
        },
        headers,
        signal,
        action: "AI Card \u5B8C\u6210"
      });
      let completed = true;
      const completionRequest = {
        method: "PUT",
        body: {
          outTrackId: instanceId,
          cardData: cardData(content, "3"),
          cardUpdateOptions: { updateCardDataByKey: true }
        },
        headers,
        signal,
        action: "AI Card \u6536\u53E3"
      };
      try {
        await cardRequest("v1.0/card/instances", completionRequest);
      } catch {
        try {
          await cardRequest("v1.0/card/instances", completionRequest);
        } catch {
          completed = false;
        }
      }
      return { delivered: true, completed };
    },
    failAiCard: failCard,
    async sendText({ clientId, clientSecret, sessionWebhook, text, signal }) {
      const content = nonEmptyString(text);
      if (!content) throw new TypeError("text is required");
      const webhook = normalizeDingtalkSessionWebhook(sessionWebhook);
      const token = await accessToken({ clientId, clientSecret, signal });
      const response = await requestJson(fetchImpl, webhook, {
        body: { msgtype: "text", text: { content } },
        headers: { "x-acs-dingtalk-access-token": token },
        signal,
        action: "\u6D88\u606F\u56DE\u590D"
      });
      if (response?.errcode !== void 0 && response.errcode !== 0 || response?.code !== void 0 && response.code !== 0) {
        throw new DingtalkApiError("send-rejected", "\u9489\u9489\u670D\u52A1\u62D2\u7EDD\u4E86\u56DE\u590D\u6D88\u606F\u3002");
      }
      return true;
    },
    clearAccessToken(clientId) {
      const appKey = nonEmptyString(clientId);
      if (appKey) tokenCache.delete(appKey);
    }
  });
}

// src/channels/dingtalk/dingtalk-card-stream.mjs
var DEFAULT_UPDATE_INTERVAL_MS = 500;
var FAILURE_TEXT = "\u6D88\u606F\u5904\u7406\u5931\u8D25\uFF0C\u8BF7\u7A0D\u540E\u91CD\u8BD5\u3002";
function requiredText(value, name2) {
  if (typeof value !== "string") throw new TypeError(`${name2} must be a string`);
  return value;
}
function requiredCredential(value, name2) {
  if (typeof value !== "string" || !value.trim()) {
    throw new TypeError(`${name2} is required`);
  }
  return value.trim();
}
function createDingTalkCardStream({
  api,
  clientId,
  clientSecret,
  target,
  signal,
  logger = console,
  updateIntervalMs = DEFAULT_UPDATE_INTERVAL_MS,
  clock = () => Date.now(),
  timer = {
    setTimeout: (callback, delay2) => globalThis.setTimeout(callback, delay2),
    clearTimeout: (handle) => globalThis.clearTimeout(handle)
  }
} = {}) {
  if (!api || typeof api.createAiCard !== "function" || typeof api.updateAiCard !== "function" || typeof api.finishAiCard !== "function") {
    throw new TypeError("DingTalk AI Card API is required");
  }
  const normalizedClientId = requiredCredential(clientId, "clientId");
  const normalizedClientSecret = requiredCredential(clientSecret, "clientSecret");
  if (target === void 0 || target === null) throw new TypeError("target is required");
  if (!Number.isFinite(updateIntervalMs) || updateIntervalMs < 0) {
    throw new TypeError("updateIntervalMs must be a non-negative number");
  }
  if (typeof clock !== "function") throw new TypeError("clock must be a function");
  if (typeof timer?.setTimeout !== "function" || typeof timer?.clearTimeout !== "function") {
    throw new TypeError("timer must provide setTimeout and clearTimeout");
  }
  const readClock = () => {
    const value = clock();
    if (!Number.isFinite(value)) throw new TypeError("clock must return a finite timestamp");
    return value;
  };
  readClock();
  let phase = signal?.aborted ? "aborted" : "idle";
  let cardRequest = null;
  let pendingText = null;
  let scheduledUpdate = null;
  let updateWorker = null;
  let finishPromise = null;
  let cleanupPromise = null;
  let lastUpdateAt = 0;
  const clearScheduledUpdate = () => {
    if (scheduledUpdate === null) return;
    timer.clearTimeout(scheduledUpdate);
    scheduledUpdate = null;
  };
  const removeAbortListener = () => signal?.removeEventListener("abort", onAbort);
  const close = (nextPhase) => {
    phase = nextPhase;
    pendingText = null;
    clearScheduledUpdate();
    removeAbortListener();
  };
  const cleanupCard = () => {
    if (!cardRequest || typeof api.failAiCard !== "function") return Promise.resolve(false);
    if (!cleanupPromise) {
      cleanupPromise = api.failAiCard({
        ...cardRequest,
        text: FAILURE_TEXT,
        signal: AbortSignal.timeout(5e3)
      }).then(
        () => true,
        () => false
      );
    }
    return cleanupPromise;
  };
  const fail = (operation) => {
    if (phase === "failed" || phase === "finished" || phase === "aborted") return;
    void cleanupCard();
    close("failed");
    logger?.error?.(`[dsh-dingtalk] AI Card ${operation} failed`);
  };
  function onAbort() {
    if (phase === "finished" || phase === "failed" || phase === "aborted") return;
    void cleanupCard();
    close("aborted");
  }
  if (phase !== "aborted") signal?.addEventListener("abort", onAbort, { once: true });
  const launchUpdate = () => {
    if (phase !== "active" || updateWorker || pendingText === null) return;
    const delay2 = Math.max(0, lastUpdateAt + updateIntervalMs - readClock());
    if (delay2 > 0) {
      scheduledUpdate = timer.setTimeout(() => {
        scheduledUpdate = null;
        launchUpdate();
      }, delay2);
      return;
    }
    const text = pendingText;
    pendingText = null;
    updateWorker = (async () => {
      try {
        await api.updateAiCard({ ...cardRequest, text, finished: false });
        lastUpdateAt = readClock();
      } catch {
        if (signal?.aborted || phase === "aborted") return;
        fail("update");
      }
    })().finally(() => {
      updateWorker = null;
      if (phase === "active" && pendingText !== null) launchUpdate();
    });
  };
  const start = async (initialText) => {
    requiredText(initialText, "initialText");
    if (phase !== "idle") return false;
    phase = "starting";
    try {
      const created = await api.createAiCard({
        clientId: normalizedClientId,
        clientSecret: normalizedClientSecret,
        target,
        initialText,
        signal
      });
      const cardInstanceId = typeof created?.cardInstanceId === "string" ? created.cardInstanceId.trim() : "";
      if (!cardInstanceId) throw new TypeError("DingTalk did not return a card instance id");
      cardRequest = Object.freeze({
        clientId: normalizedClientId,
        clientSecret: normalizedClientSecret,
        target,
        cardInstanceId,
        signal
      });
      if (phase !== "starting") {
        void cleanupCard();
        return false;
      }
      lastUpdateAt = readClock();
      phase = "active";
      return true;
    } catch {
      if (signal?.aborted || phase === "aborted") {
        close("aborted");
        return false;
      }
      fail("creation");
      return false;
    }
  };
  const push = (progressText3) => {
    requiredText(progressText3, "progressText");
    if (phase !== "active") return;
    pendingText = progressText3;
    if (!scheduledUpdate && !updateWorker) launchUpdate();
  };
  const finish = (finalText) => {
    requiredText(finalText, "finalText");
    if (phase === "finished") return Promise.resolve(true);
    if (phase === "finishing") return finishPromise;
    if (phase !== "active") return Promise.resolve(false);
    phase = "finishing";
    pendingText = null;
    clearScheduledUpdate();
    const activeUpdate = updateWorker;
    finishPromise = (async () => {
      if (activeUpdate) await activeUpdate;
      if (phase !== "finishing") return false;
      try {
        await api.finishAiCard({ ...cardRequest, text: finalText });
        if (phase !== "finishing") return false;
        close("finished");
        return true;
      } catch {
        if (signal?.aborted || phase === "aborted") {
          close("aborted");
          return false;
        }
        fail("finish");
        return false;
      }
    })();
    return finishPromise;
  };
  return Object.freeze({ start, push, finish });
}

// src/channels/dingtalk/dingtalk-bridge.mjs
var CARD_INITIAL_TEXT = "\u5DF2\u8FDE\u63A5 DeepSeek Harness\uFF0C\u6B63\u5728\u601D\u8003\u2026";
var CARD_ERROR_TEXT = "\u6D88\u606F\u5904\u7406\u5931\u8D25\uFF0C\u8BF7\u7A0D\u540E\u91CD\u8BD5\u3002";
var HELP_TEXT = [
  "\u9489\u9489\u673A\u5668\u4EBA\u5DF2\u8FDE\u63A5 DeepSeek Harness\u3002",
  "",
  "\u76F4\u63A5\u53D1\u9001\u6587\u5B57\u5373\u53EF\u7EE7\u7EED\u5F53\u524D\u4F1A\u8BDD\u3002",
  "/new  \u5F00\u542F\u4E00\u4E2A\u5168\u65B0\u4F1A\u8BDD",
  "/status  \u68C0\u67E5\u8FDE\u63A5\u72B6\u6001",
  "/help  \u663E\u793A\u672C\u5E2E\u52A9"
].join("\n");
function nonEmptyString2(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}
function senderStaffId(message) {
  return nonEmptyString2(message?.senderStaffId) ?? nonEmptyString2(message?.senderId);
}
function conversationKey(message, sender) {
  if (String(message?.conversationType) === "2") {
    const conversationId = nonEmptyString2(message?.conversationId);
    if (!conversationId) throw new Error("DingTalk group message has no conversation id");
    return `group:${conversationId}`;
  }
  return `p2p:${sender}`;
}
function cardTarget(message, sender) {
  if (String(message?.conversationType) === "2") {
    return { type: "group", openConversationId: nonEmptyString2(message?.conversationId) };
  }
  return { type: "user", userId: sender };
}
function progressText(update) {
  if (update?.type === "text" && nonEmptyString2(update.text)) return update.text;
  if (update?.type === "tool") {
    if (update.name === "web_search") return "_\u6B63\u5728\u641C\u7D22\u7F51\u7EDC\u5E76\u6574\u7406\u4FE1\u606F\u2026_";
    return `_\u6B63\u5728\u4F7F\u7528 ${nonEmptyString2(update.name) ?? "\u5DE5\u5177"}\u2026_`;
  }
  return `_${nonEmptyString2(update?.text) ?? "\u6B63\u5728\u5904\u7406\u2026"}_`;
}
function ensureStats(status) {
  status.stats ??= {};
  for (const key of ["messagesReceived", "messagesReplied", "messagesRejected", "messagesIgnored"]) {
    status[key] ??= 0;
    status.stats[key] = status[key];
  }
  status.pendingSenders ??= [];
}
function increment(status, key) {
  status[key] = (status[key] ?? 0) + 1;
  status.stats ??= {};
  status.stats[key] = status[key];
}
function createDingtalkBridgeStatus({ pendingSenders = [] } = {}) {
  return {
    messagesReceived: 0,
    messagesReplied: 0,
    messagesRejected: 0,
    messagesIgnored: 0,
    lastMessageAt: null,
    lastReplyAt: null,
    lastRejectedAt: null,
    lastError: null,
    pendingSenders: structuredClone(pendingSenders),
    stats: {
      messagesReceived: 0,
      messagesReplied: 0,
      messagesRejected: 0,
      messagesIgnored: 0
    }
  };
}
var DingtalkHarnessBridge = class {
  #api;
  #clientId;
  #clientSecret;
  #harness;
  #state;
  #status;
  #logger;
  #replyTimeoutMs;
  #maxMessageChars;
  #signal;
  #queues = /* @__PURE__ */ new Map();
  #acceptedMessageIds = /* @__PURE__ */ new Set();
  constructor({
    api,
    clientId,
    clientSecret,
    harness,
    state,
    status = createDingtalkBridgeStatus(),
    logger = console,
    replyTimeoutMs = 6e5,
    maxMessageChars = 4e3,
    signal
  }) {
    if (!api || typeof api.sendText !== "function") throw new TypeError("DingTalk API is required");
    if (!nonEmptyString2(clientId) || !nonEmptyString2(clientSecret)) {
      throw new TypeError("DingTalk app credentials are required");
    }
    if (!harness || !state) throw new TypeError("Harness client and state store are required");
    this.#api = api;
    this.#clientId = clientId.trim();
    this.#clientSecret = clientSecret.trim();
    this.#harness = harness;
    this.#state = state;
    this.#status = status;
    this.#logger = logger;
    this.#replyTimeoutMs = replyTimeoutMs;
    this.#maxMessageChars = maxMessageChars;
    this.#signal = signal;
    ensureStats(this.#status);
    this.#refreshPendingSenders();
  }
  get status() {
    this.#refreshPendingSenders();
    return structuredClone(this.#status);
  }
  accept(message) {
    if (this.#signal?.aborted) return Promise.resolve();
    const messageId = nonEmptyString2(message?.msgId);
    const sender = senderStaffId(message);
    if (!messageId || !sender || this.#state.hasSeen(messageId) || this.#acceptedMessageIds.has(messageId)) return Promise.resolve();
    this.#acceptedMessageIds.add(messageId);
    let key;
    try {
      key = conversationKey(message, sender);
    } catch {
      this.#acceptedMessageIds.delete(messageId);
      increment(this.#status, "messagesRejected");
      this.#status.lastRejectedAt = (/* @__PURE__ */ new Date()).toISOString();
      return Promise.resolve();
    }
    const previous = this.#queues.get(key) ?? Promise.resolve();
    const current = previous.catch(() => void 0).then(() => this.#process(message, messageId, sender, key)).finally(() => {
      this.#acceptedMessageIds.delete(messageId);
      if (this.#queues.get(key) === current) this.#queues.delete(key);
    });
    this.#queues.set(key, current);
    return current;
  }
  async waitForIdle() {
    await Promise.allSettled([...this.#queues.values()]);
  }
  async #process(message, messageId, sender, key) {
    this.#signal?.throwIfAborted();
    if (this.#state.hasSeen(messageId)) return;
    await this.#state.markSeen(messageId);
    increment(this.#status, "messagesReceived");
    this.#status.lastMessageAt = (/* @__PURE__ */ new Date()).toISOString();
    if (String(message.conversationType) === "2" && message.isInAtList !== true) {
      increment(this.#status, "messagesIgnored");
      return;
    }
    let sessionWebhook;
    try {
      sessionWebhook = normalizeDingtalkSessionWebhook(message.sessionWebhook);
    } catch {
      increment(this.#status, "messagesRejected");
      this.#status.lastRejectedAt = (/* @__PURE__ */ new Date()).toISOString();
      this.#status.lastError = "\u9489\u9489\u6D88\u606F\u6CA1\u6709\u5B89\u5168\u7684\u56DE\u590D\u5730\u5740\u3002";
      return;
    }
    const text = message?.msgtype === "text" ? nonEmptyString2(message?.text?.content) : null;
    let cardStream = null;
    let cardStarted = false;
    try {
      if (!text) {
        await this.#send(sessionWebhook, "\u76EE\u524D\u4EC5\u652F\u6301\u6587\u5B57\u6D88\u606F\u3002");
        return;
      }
      const command = text.toLowerCase();
      if (command === "/help") {
        await this.#send(sessionWebhook, HELP_TEXT);
        return;
      }
      if (command === "/status") {
        await this.#harness.ensureRunning({ signal: this.#signal });
        await this.#send(sessionWebhook, "\u9489\u9489\u673A\u5668\u4EBA\u4E0E DeepSeek Harness \u8FDE\u63A5\u6B63\u5E38\u3002");
        return;
      }
      if (command === "/new") {
        await this.#state.clearSession(key);
        await this.#send(sessionWebhook, "\u5DF2\u5F00\u542F\u65B0\u4F1A\u8BDD\u3002\u8BF7\u53D1\u9001\u4F60\u7684\u95EE\u9898\u3002");
        return;
      }
      let sessionId = this.#state.sessionFor(key);
      if (!sessionId || !await this.#harness.sessionExists(sessionId, { signal: this.#signal })) {
        sessionId = await this.#harness.createSession({ signal: this.#signal });
        await this.#state.setSession(key, sessionId);
      }
      if (typeof this.#api.createAiCard === "function" && typeof this.#api.updateAiCard === "function" && typeof this.#api.finishAiCard === "function") {
        cardStream = createDingTalkCardStream({
          api: this.#api,
          clientId: this.#clientId,
          clientSecret: this.#clientSecret,
          target: cardTarget(message, sender),
          signal: this.#signal,
          logger: this.#logger
        });
        cardStarted = await cardStream.start(CARD_INITIAL_TEXT);
      }
      const answer = await this.#harness.ask(sessionId, text, {
        timeoutMs: this.#replyTimeoutMs,
        signal: this.#signal,
        onUpdate: cardStarted ? (update) => cardStream.push(progressText(update)) : void 0
      });
      const streamed = cardStarted && await cardStream.finish(answer);
      if (!streamed) await this.#send(sessionWebhook, answer);
      increment(this.#status, "messagesReplied");
      this.#status.lastReplyAt = (/* @__PURE__ */ new Date()).toISOString();
      this.#status.lastError = null;
    } catch {
      if (this.#signal?.aborted) return;
      this.#status.lastError = "\u9489\u9489\u6D88\u606F\u5904\u7406\u5931\u8D25\u3002";
      this.#logger.error?.("[dsh-dingtalk] failed to process an inbound message");
      try {
        const streamed = cardStarted && await cardStream.finish(CARD_ERROR_TEXT);
        if (!streamed) await this.#send(sessionWebhook, CARD_ERROR_TEXT);
      } catch {
        this.#logger.error?.("[dsh-dingtalk] failed to send the safe error reply");
      }
    }
  }
  #refreshPendingSenders() {
    if (typeof this.#state.pendingSenders === "function") {
      this.#status.pendingSenders = this.#state.pendingSenders();
    }
  }
  async #send(sessionWebhook, text) {
    for (const chunk of splitDingtalkText(text, this.#maxMessageChars)) {
      this.#signal?.throwIfAborted();
      await this.#api.sendText({
        clientId: this.#clientId,
        clientSecret: this.#clientSecret,
        sessionWebhook,
        text: chunk,
        signal: this.#signal
      });
    }
  }
};

// src/channels/dingtalk/dingtalk-runtime.mjs
function nonEmptyString3(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}
function approvedSenderIds(config) {
  const entries = Array.isArray(config?.approvedSenders) ? config.approvedSenders : config?.approvedSenders instanceof Set ? [...config.approvedSenders] : [];
  return new Set(entries.map((entry) => nonEmptyString3(
    typeof entry === "string" ? entry : entry?.staffId
  )).filter(Boolean));
}
function approvedSenderCount(config) {
  return approvedSenderIds(config).size;
}
function streamIsOpen(client) {
  return client?.connected === true || client?.socket?.readyState === 1;
}
function abortable(promise, signal) {
  return new Promise((resolve6, reject) => {
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    const onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    Promise.resolve(promise).then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve6(value);
      },
      (error) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      }
    );
  });
}
async function waitForStreamOpen(client, pollIntervalMs, signal) {
  while (true) {
    signal?.throwIfAborted();
    if (streamIsOpen(client)) return;
    await new Promise((resolve6, reject) => {
      const timer = setTimeout(() => {
        signal?.removeEventListener("abort", onAbort);
        resolve6();
      }, pollIntervalMs);
      const onAbort = () => {
        clearTimeout(timer);
        reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
      };
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  }
}
async function connectStream(client, timeoutMs, pollIntervalMs, signal) {
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  const connectSignal = AbortSignal.any([signal, timeoutSignal]);
  let connectSettled = false;
  const connectTask = Promise.resolve().then(() => client.connect()).finally(() => {
    connectSettled = true;
  });
  try {
    await abortable(connectTask, connectSignal);
    await waitForStreamOpen(client, pollIntervalMs, connectSignal);
  } catch (error) {
    if (connectSignal.aborted) {
      if (!connectSettled) {
        void connectTask.then(() => client.disconnect()).catch(() => void 0);
      }
      if (signal.aborted) throw signal.reason;
      throw new Error(`DingTalk Stream handshake timed out after ${timeoutMs}ms`);
    }
    throw error;
  }
}
async function defaultStreamFactory({ clientId, clientSecret }) {
  const { DWClient, TOPIC_ROBOT } = await import("dingtalk-stream");
  return {
    client: new DWClient({
      clientId,
      clientSecret,
      endpoint: "https://api.dingtalk.com",
      autoReconnect: false,
      keepAlive: true,
      debug: false
    }),
    topic: TOPIC_ROBOT
  };
}
function createDingtalkRuntimeStatus({
  pendingSenders = [],
  approvedSenders = 0
} = {}) {
  return {
    startedAt: null,
    ready: false,
    dingtalkStreamState: "idle",
    harnessReachable: false,
    lastConnectedAt: null,
    lastCheckedAt: null,
    lastCallbackAt: null,
    authorizationMode: "sender-staff-id-approval",
    approvedSenderCount: approvedSenders,
    ...createDingtalkBridgeStatus({ pendingSenders })
  };
}
var DingtalkRuntime = class {
  #config;
  #clientSecret;
  #harness;
  #state;
  #logger;
  #replyTimeoutMs;
  #maxMessageChars;
  #connectTimeoutMs;
  #connectPollIntervalMs;
  #api;
  #streamFactory;
  #status;
  #client = null;
  #bridge = null;
  #topic = null;
  #starting = null;
  #connectionMonitor = null;
  #abortController = null;
  #callbackTasks = /* @__PURE__ */ new Set();
  constructor({
    config,
    clientSecret,
    harness,
    state,
    logger = console,
    replyTimeoutMs = 6e5,
    maxMessageChars = 4e3,
    connectTimeoutMs = 15e3,
    connectPollIntervalMs = 25,
    api = createDingtalkApi(),
    streamFactory = defaultStreamFactory
  }) {
    if (!config || !nonEmptyString3(config.clientId) || !nonEmptyString3(clientSecret)) {
      throw new TypeError("DingtalkRuntime requires app credentials");
    }
    if (!harness || !state) throw new TypeError("DingtalkRuntime requires Harness and state");
    if (typeof streamFactory !== "function") throw new TypeError("streamFactory must be a function");
    this.#config = config;
    this.#clientSecret = clientSecret.trim();
    this.#harness = harness;
    this.#state = state;
    this.#logger = logger;
    this.#replyTimeoutMs = replyTimeoutMs;
    this.#maxMessageChars = maxMessageChars;
    this.#connectTimeoutMs = connectTimeoutMs;
    this.#connectPollIntervalMs = connectPollIntervalMs;
    this.#api = api;
    this.#streamFactory = streamFactory;
    this.#status = createDingtalkRuntimeStatus({
      pendingSenders: this.#pendingSenders(),
      approvedSenders: approvedSenderCount(config)
    });
  }
  get status() {
    if (this.#bridge) {
      const bridgeStatus = this.#bridge.status;
      Object.assign(this.#status, bridgeStatus);
    } else {
      this.#status.pendingSenders = this.#pendingSenders();
    }
    return structuredClone(this.#status);
  }
  pendingSender(requestId) {
    return typeof this.#state.pendingSender === "function" ? this.#state.pendingSender(requestId) : null;
  }
  pendingSenders() {
    return this.#pendingSenders();
  }
  async start() {
    if (this.#client && this.#status.ready) return this.status;
    if (this.#starting) return this.#starting;
    this.#starting = this.#start().finally(() => {
      this.#starting = null;
    });
    return this.#starting;
  }
  async #start() {
    await this.stop();
    const abortController = new AbortController();
    this.#abortController = abortController;
    const { signal } = abortController;
    this.#status.startedAt = (/* @__PURE__ */ new Date()).toISOString();
    this.#status.dingtalkStreamState = "connecting";
    this.#status.lastError = null;
    try {
      await this.#harness.ensureRunning({ signal });
      this.#status.harnessReachable = true;
      if (typeof this.#state.removePendingSenderByStaffId === "function") {
        for (const staffId of approvedSenderIds(this.#config)) {
          await this.#state.removePendingSenderByStaffId(staffId);
        }
        this.#status.pendingSenders = this.#pendingSenders();
      }
      this.#bridge = new DingtalkHarnessBridge({
        api: this.#api,
        clientId: this.#config.clientId,
        clientSecret: this.#clientSecret,
        approvedSenders: this.#config.approvedSenders,
        harness: this.#harness,
        state: this.#state,
        status: this.#status,
        logger: this.#logger,
        replyTimeoutMs: this.#replyTimeoutMs,
        maxMessageChars: this.#maxMessageChars,
        signal
      });
      const created = await this.#streamFactory({
        clientId: this.#config.clientId,
        clientSecret: this.#clientSecret
      });
      signal.throwIfAborted();
      this.#client = created?.client ?? created;
      this.#topic = created?.topic ?? created?.TOPIC_ROBOT ?? "/v1.0/im/bot/messages/get";
      if (!this.#client || typeof this.#client.registerCallbackListener !== "function" || typeof this.#client.connect !== "function" || typeof this.#client.disconnect !== "function" || typeof this.#client.socketCallBackResponse !== "function") {
        throw new TypeError("streamFactory returned an invalid DingTalk Stream client");
      }
      const client = this.#client;
      const bridge = this.#bridge;
      client.registerCallbackListener(this.#topic, (response) => {
        if (this.#client !== client || this.#bridge !== bridge) return;
        const callbackMessageId = nonEmptyString3(response?.headers?.messageId);
        if (callbackMessageId) {
          try {
            client.socketCallBackResponse(callbackMessageId, { success: true });
          } catch {
            this.#logger.warn?.("[dsh-dingtalk] unable to acknowledge an inbound callback");
          }
        }
        const task = Promise.resolve().then(async () => {
          if (this.#bridge !== bridge) return;
          let message;
          try {
            message = typeof response?.data === "string" ? JSON.parse(response.data) : response?.data;
          } catch {
            this.#status.lastError = "\u9489\u9489\u6D88\u606F\u683C\u5F0F\u65E0\u6548\u3002";
            this.#logger.warn?.("[dsh-dingtalk] ignored an invalid callback payload");
            return;
          }
          if (!message || typeof message !== "object") return;
          this.#status.lastCallbackAt = Date.now();
          await bridge.accept(message);
        }).catch(() => {
          if (signal.aborted || this.#bridge !== bridge) return;
          this.#status.lastError = "\u9489\u9489\u6D88\u606F\u5904\u7406\u5931\u8D25\u3002";
          this.#logger.error?.("[dsh-dingtalk] callback processing failed");
        }).finally(() => this.#callbackTasks.delete(task));
        this.#callbackTasks.add(task);
      });
      await connectStream(
        client,
        this.#connectTimeoutMs,
        this.#connectPollIntervalMs,
        signal
      );
      this.#status.ready = true;
      this.#status.dingtalkStreamState = "connected";
      this.#status.lastConnectedAt = Date.now();
      this.#status.lastCheckedAt = Date.now();
      this.#status.lastError = null;
      this.#connectionMonitor = setInterval(() => {
        const connected = streamIsOpen(client);
        this.#status.ready = connected;
        this.#status.dingtalkStreamState = connected ? "connected" : "reconnecting";
        this.#status.lastCheckedAt = Date.now();
        if (connected) this.#status.lastError = null;
      }, 1e3);
      this.#connectionMonitor.unref?.();
      return this.status;
    } catch (error) {
      const aborted = signal.aborted;
      this.#status.ready = false;
      this.#status.dingtalkStreamState = aborted ? "idle" : "failed";
      this.#status.lastError = aborted ? null : error?.message ?? String(error);
      await this.stop({ preserveError: !aborted });
      throw error;
    }
  }
  async stop({ preserveError = false } = {}) {
    const lastError = preserveError ? this.#status.lastError : null;
    const abortController = this.#abortController;
    this.#abortController = null;
    abortController?.abort(new DOMException("DingTalk runtime stopped", "AbortError"));
    if (this.#connectionMonitor) clearInterval(this.#connectionMonitor);
    this.#connectionMonitor = null;
    this.#status.ready = false;
    const client = this.#client;
    this.#client = null;
    this.#topic = null;
    if (client) {
      try {
        await client.disconnect();
      } catch {
        this.#logger.warn?.("[dsh-dingtalk] DingTalk Stream disconnect failed");
      }
    }
    await Promise.allSettled([...this.#callbackTasks]);
    this.#callbackTasks.clear();
    if (this.#bridge) await this.#bridge.waitForIdle();
    this.#bridge = null;
    this.#status.dingtalkStreamState = preserveError ? "failed" : "idle";
    this.#status.lastError = lastError;
    return this.status;
  }
  #pendingSenders() {
    return typeof this.#state.pendingSenders === "function" ? this.#state.pendingSenders() : [];
  }
};

// src/channels/dingtalk/harness-client.mjs
import { spawn } from "node:child_process";
import { randomUUID as randomUUID4 } from "node:crypto";
function sleep(ms, signal) {
  return new Promise((resolve6, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve6();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
function assistantMessageText(event) {
  return (event?.data?.message?.content ?? []).filter((part) => part.type === "text" && typeof part.text === "string").map((part) => part.text).join("\n").trim();
}
var HarnessReplyTracker = class {
  #promptRpcId;
  #lastSeq;
  #openTurn = null;
  #targetTurn = null;
  #stepText = /* @__PURE__ */ new Map();
  #latestText = "";
  #finished = false;
  #reason = null;
  constructor({ promptRpcId, afterSeq = -1 }) {
    this.#promptRpcId = promptRpcId;
    this.#lastSeq = afterSeq;
  }
  get finished() {
    return this.#finished;
  }
  get answer() {
    return this.#latestText.trim();
  }
  get reason() {
    return this.#reason;
  }
  consume(entries) {
    let update = null;
    const ordered = [...entries].map((entry) => entry?.event ?? entry).filter(Boolean).sort((left, right) => (left.seq ?? -1) - (right.seq ?? -1));
    for (const event of ordered) {
      const seq = event.seq ?? -1;
      if (seq <= this.#lastSeq) continue;
      this.#lastSeq = seq;
      if (event.type === "turn/start") this.#openTurn = event.data?.turn ?? null;
      if (event.type === "user/message" && event.data?.source?.rpcId === this.#promptRpcId) {
        this.#targetTurn = this.#openTurn;
        continue;
      }
      if (this.#targetTurn === null) continue;
      if (event.type === "turn/end") {
        if (event.data?.turn !== this.#targetTurn) continue;
        this.#finished = true;
        this.#reason = event.data?.reason ?? null;
        this.#openTurn = null;
        continue;
      }
      if (event.data?.turn !== this.#targetTurn) continue;
      if (event.type === "assistant/chunk" && event.data?.chunk?.type === "text-delta") {
        const step = event.data?.step ?? 0;
        const index = event.data.chunk.index ?? 0;
        const key = `${step}:${index}`;
        this.#stepText.set(key, (this.#stepText.get(key) ?? "") + event.data.chunk.text);
        const prefix = `${step}:`;
        const text = [...this.#stepText.entries()].filter(([partKey]) => partKey.startsWith(prefix)).sort(([left], [right]) => Number(left.split(":")[1]) - Number(right.split(":")[1])).map(([, part]) => part).join("\n").trim();
        if (text && text !== this.#latestText) {
          this.#latestText = text;
          update = { type: "text", text };
        }
        continue;
      }
      if (event.type === "assistant/message") {
        const text = assistantMessageText(event);
        if (text && text !== this.#latestText) {
          this.#latestText = text;
          update = { type: "text", text };
        }
        continue;
      }
      if (event.type === "tool/call") {
        update = { type: "tool", name: event.data?.name ?? "\u5DE5\u5177" };
      } else if (event.type === "tool/result") {
        update = { type: "status", text: "\u6B63\u5728\u6574\u7406\u7ED3\u679C\u2026" };
      }
    }
    return update;
  }
};
var HarnessRpcError = class extends Error {
  constructor(method, error) {
    super(`${method}: ${error?.message ?? "unknown Harness RPC error"}`);
    this.name = "HarnessRpcError";
    this.method = method;
    this.code = error?.code ?? "internal";
    this.details = error?.details ?? {};
  }
};
var HarnessClient = class {
  #baseUrl;
  #workspace;
  #agentPreset;
  #autostart;
  #dshBin;
  #fetch;
  #managedProcess = null;
  constructor({
    baseUrl,
    workspace,
    agentPreset = "standard",
    autostart = false,
    dshBin = "dsh",
    fetchImpl = fetch
  }) {
    this.#baseUrl = new URL(baseUrl);
    this.#workspace = workspace;
    this.#agentPreset = agentPreset;
    this.#autostart = autostart;
    this.#dshBin = dshBin;
    this.#fetch = fetchImpl;
  }
  async rpc(method, payload = {}, timeoutMs = 3e4, options = {}) {
    const rpcId = options.rpcId ?? `dingtalk-${randomUUID4()}`;
    const timeoutSignal = AbortSignal.timeout(timeoutMs);
    const signal = options.signal ? AbortSignal.any([options.signal, timeoutSignal]) : timeoutSignal;
    const response = await this.#fetch(new URL(`/api/${method}`, this.#baseUrl), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: "client-request", rpcId, method, payload }),
      signal
    });
    if (!response.ok) throw new Error(`Harness transport ${method} failed: HTTP ${response.status}`);
    const body = await response.json();
    if (body?.type !== "server-response" || body?.rpcId !== rpcId) {
      throw new Error(`Harness returned an invalid response for ${method}`);
    }
    if (!body.result?.ok) throw new HarnessRpcError(method, body.result?.error);
    return body.result.value;
  }
  async health(options = {}) {
    await this.rpc("host.describe", {}, 5e3, options);
    return true;
  }
  async ensureRunning(options = {}) {
    try {
      return await this.health(options);
    } catch (firstError) {
      if (!this.#autostart) throw firstError;
    }
    if (!this.#managedProcess || this.#managedProcess.exitCode !== null) {
      const port = this.#baseUrl.port || (this.#baseUrl.protocol === "https:" ? "443" : "80");
      this.#managedProcess = spawn(this.#dshBin, [
        "web",
        "--host",
        this.#baseUrl.hostname,
        "--port",
        port
      ], {
        cwd: this.#workspace,
        env: process.env,
        stdio: ["ignore", "inherit", "inherit"]
      });
      this.#managedProcess.on("error", (error) => {
        console.error("[dsh-dingtalk] failed to start Harness:", error.message);
      });
    }
    const deadline = Date.now() + 6e4;
    let lastError;
    while (Date.now() < deadline) {
      await sleep(1e3, options.signal);
      try {
        return await this.health(options);
      } catch (error) {
        lastError = error;
      }
    }
    throw new Error(`Harness did not become ready: ${lastError?.message ?? "timeout"}`);
  }
  async workspaceId(options = {}) {
    const { items } = await this.rpc("workspace.list", {}, 3e4, options);
    const existing = items.find((item) => item.path === this.#workspace);
    if (existing) return existing.workspaceId;
    const created = await this.rpc("workspace.create", { path: this.#workspace }, 3e4, options);
    return created.workspace.workspaceId;
  }
  async createSession(options = {}) {
    await this.ensureRunning(options);
    const workspaceId = await this.workspaceId(options);
    const created = await this.rpc("session.create", {
      workspaceId,
      agentPreset: this.#agentPreset
    }, 3e4, options);
    return created.sessionId;
  }
  async sessionExists(sessionId, options = {}) {
    try {
      await this.rpc("session.history", { sessionId, maxMessages: 1 }, 3e4, options);
      return true;
    } catch (error) {
      if (error instanceof HarnessRpcError && error.code === "session-not-found") return false;
      throw error;
    }
  }
  async ask(sessionId, text, options = {}) {
    if (typeof options === "number") options = { timeoutMs: options };
    const timeoutMs = options.timeoutMs ?? 6e5;
    const signal = options.signal;
    const onUpdate = typeof options.onUpdate === "function" ? options.onUpdate : null;
    await this.ensureRunning({ signal });
    const before = await this.rpc(
      "session.history",
      { sessionId, maxMessages: 1 },
      3e4,
      { signal }
    );
    const baselineSeq = Math.max(-1, ...(before.events ?? []).map(({ event }) => event.seq ?? -1));
    const promptRpcId = `dingtalk-${randomUUID4()}`;
    const tracker = new HarnessReplyTracker({ promptRpcId, afterSeq: baselineSeq });
    await this.rpc("session.prompt", {
      sessionId,
      mode: "queue",
      content: [{ type: "text", text }],
      clientTimeZone: Intl.DateTimeFormat().resolvedOptions().timeZone
    }, 3e4, { rpcId: promptRpcId, signal });
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      await sleep(300, signal);
      const history = await this.rpc(
        "session.history",
        { sessionId, maxMessages: 50 },
        3e4,
        { signal }
      );
      const update = tracker.consume(history.events ?? []);
      if (update && onUpdate) {
        try {
          await onUpdate(update);
        } catch (error) {
          console.warn("[dsh-dingtalk] ignored a progress update failure:", error.message);
        }
      }
      if (!tracker.finished) continue;
      if (tracker.answer) return tracker.answer;
      throw new Error(
        `Harness turn ended without a text reply${tracker.reason ? ` (${JSON.stringify(tracker.reason)})` : ""}`
      );
    }
    throw new Error(`Harness reply timed out after ${Math.round(timeoutMs / 1e3)} seconds`);
  }
  stopManagedProcess() {
    if (this.#managedProcess?.exitCode === null) this.#managedProcess.kill("SIGTERM");
  }
};

// src/channels/dingtalk/state-store.mjs
import { randomUUID as randomUUID5 } from "node:crypto";
import { mkdir as mkdir2, readFile as readFile2, rename as rename2, unlink as unlink2, writeFile as writeFile2 } from "node:fs/promises";
import { dirname as dirname2 } from "node:path";
var EMPTY_STATE = Object.freeze({
  version: 1,
  sessions: {},
  seenMessageIds: [],
  pendingSenders: {}
});
function nonEmptyString4(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}
function displayName(value) {
  return (nonEmptyString4(value) ?? "\u9489\u9489\u7528\u6237").slice(0, 100);
}
function normalizePendingSender2(value, fallbackRequestId) {
  if (!value || typeof value !== "object") return null;
  const requestId = nonEmptyString4(value.requestId) ?? nonEmptyString4(fallbackRequestId);
  const staffId = nonEmptyString4(value.staffId);
  const requestedAt = nonEmptyString4(value.requestedAt) ?? nonEmptyString4(value.lastSeenAt);
  const lastSeenAt = nonEmptyString4(value.lastSeenAt) ?? requestedAt;
  if (!requestId || !staffId || !requestedAt || !lastSeenAt) return null;
  return {
    requestId,
    staffId,
    displayName: displayName(value.displayName ?? value.nick),
    requestedAt,
    lastSeenAt
  };
}
function normalizeState(value) {
  if (!value || typeof value !== "object") return structuredClone(EMPTY_STATE);
  const sessions = {};
  if (value.sessions && typeof value.sessions === "object" && !Array.isArray(value.sessions)) {
    for (const [key, sessionId] of Object.entries(value.sessions)) {
      const normalizedKey = nonEmptyString4(key);
      const normalizedSession = nonEmptyString4(sessionId);
      if (normalizedKey && normalizedSession) sessions[normalizedKey] = normalizedSession;
    }
  }
  const pendingSenders = {};
  const entries = Array.isArray(value.pendingSenders) ? value.pendingSenders.map((entry) => [entry?.requestId, entry]) : Object.entries(value.pendingSenders && typeof value.pendingSenders === "object" ? value.pendingSenders : {});
  for (const [key, candidate] of entries) {
    const pending = normalizePendingSender2(candidate, key);
    if (!pending) continue;
    const duplicate = Object.values(pendingSenders).find((entry) => entry.staffId === pending.staffId);
    if (!duplicate || duplicate.lastSeenAt < pending.lastSeenAt) {
      if (duplicate) delete pendingSenders[duplicate.requestId];
      pendingSenders[pending.requestId] = pending;
    }
  }
  return {
    version: 1,
    sessions,
    seenMessageIds: Array.isArray(value.seenMessageIds) ? [...new Set(value.seenMessageIds.map(nonEmptyString4).filter(Boolean))].slice(-1e3) : [],
    pendingSenders
  };
}
var DingtalkStateStore = class {
  #path;
  #state = structuredClone(EMPTY_STATE);
  #writeQueue = Promise.resolve();
  #idFactory;
  #now;
  constructor(path, { idFactory = randomUUID5, now = () => (/* @__PURE__ */ new Date()).toISOString() } = {}) {
    if (!nonEmptyString4(path)) throw new TypeError("state path is required");
    if (typeof idFactory !== "function" || typeof now !== "function") {
      throw new TypeError("idFactory and now must be functions");
    }
    this.#path = path;
    this.#idFactory = idFactory;
    this.#now = now;
  }
  async load() {
    try {
      this.#state = normalizeState(JSON.parse(await readFile2(this.#path, "utf8")));
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
      this.#state = structuredClone(EMPTY_STATE);
      await this.#persist();
    }
    return this;
  }
  sessionFor(key) {
    return this.#state.sessions[key] ?? null;
  }
  async setSession(key, sessionId) {
    const normalizedKey = nonEmptyString4(key);
    const normalizedSession = nonEmptyString4(sessionId);
    if (!normalizedKey || !normalizedSession) throw new TypeError("key and sessionId are required");
    this.#state.sessions[normalizedKey] = normalizedSession;
    await this.#persist();
  }
  async clearSession(key) {
    const normalizedKey = nonEmptyString4(key);
    if (!normalizedKey || !(normalizedKey in this.#state.sessions)) return;
    delete this.#state.sessions[normalizedKey];
    await this.#persist();
  }
  hasSeen(messageId) {
    const id = nonEmptyString4(messageId);
    return Boolean(id && this.#state.seenMessageIds.includes(id));
  }
  async markSeen(messageId) {
    const id = nonEmptyString4(messageId);
    if (!id) throw new TypeError("messageId is required");
    if (this.hasSeen(id)) return;
    this.#state.seenMessageIds.push(id);
    if (this.#state.seenMessageIds.length > 1e3) {
      this.#state.seenMessageIds.splice(0, this.#state.seenMessageIds.length - 1e3);
    }
    await this.#persist();
  }
  pendingSenders() {
    return Object.values(this.#state.pendingSenders).sort((left, right) => left.requestedAt.localeCompare(right.requestedAt)).map((entry) => structuredClone(entry));
  }
  pendingSender(requestId) {
    const id = nonEmptyString4(requestId);
    const entry = id ? this.#state.pendingSenders[id] : null;
    return entry ? structuredClone(entry) : null;
  }
  async recordPendingSender(staffIdOrEntry, name2, seenAt) {
    const input = staffIdOrEntry && typeof staffIdOrEntry === "object" ? staffIdOrEntry : { staffId: staffIdOrEntry, displayName: name2, lastSeenAt: seenAt };
    const staffId = nonEmptyString4(input.staffId);
    if (!staffId) throw new TypeError("staffId is required");
    const timestamp = nonEmptyString4(input.lastSeenAt) ?? nonEmptyString4(input.requestedAt) ?? this.#now();
    const existing = Object.values(this.#state.pendingSenders).find((entry2) => entry2.staffId === staffId);
    const entry = {
      requestId: existing?.requestId ?? `ding_sender_${this.#idFactory()}`,
      staffId,
      displayName: displayName(input.displayName ?? input.nick ?? name2),
      requestedAt: existing?.requestedAt ?? timestamp,
      lastSeenAt: timestamp
    };
    this.#state.pendingSenders[entry.requestId] = entry;
    await this.#persist();
    return structuredClone(entry);
  }
  async removePendingSender(requestId) {
    const id = nonEmptyString4(requestId);
    if (!id || !this.#state.pendingSenders[id]) return false;
    delete this.#state.pendingSenders[id];
    await this.#persist();
    return true;
  }
  async removePendingSenderByStaffId(staffId) {
    const id = nonEmptyString4(staffId);
    const pending = id ? Object.values(this.#state.pendingSenders).find((entry) => entry.staffId === id) : null;
    return pending ? this.removePendingSender(pending.requestId) : false;
  }
  snapshot() {
    return structuredClone(this.#state);
  }
  async remove() {
    await this.#writeQueue;
    try {
      await unlink2(this.#path);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    this.#state = structuredClone(EMPTY_STATE);
  }
  async #persist() {
    const snapshot = `${JSON.stringify(this.#state, null, 2)}
`;
    const operation = this.#writeQueue.then(async () => {
      await mkdir2(dirname2(this.#path), { recursive: true, mode: 448 });
      const temporary = `${this.#path}.tmp`;
      await writeFile2(temporary, snapshot, { encoding: "utf8", mode: 384 });
      await rename2(temporary, this.#path);
    });
    this.#writeQueue = operation.then(() => void 0, () => void 0);
    await operation;
  }
};

// plugin-src/host/channels/dingtalk/connection-supervisor.mjs
var DEFAULT_RETRY_DELAYS_MS = Object.freeze([250, 1e3, 3e3, 5e3, 1e4, 3e4]);
function retryDelays(value) {
  if (!Array.isArray(value) || value.length === 0) return [...DEFAULT_RETRY_DELAYS_MS];
  const valid = value.filter((delay2) => Number.isFinite(delay2) && delay2 >= 0);
  return valid.length > 0 ? valid : [...DEFAULT_RETRY_DELAYS_MS];
}
var ConnectionSupervisor = class {
  #controller;
  #harness;
  #logger;
  #retryDelays;
  #healthyIntervalMs;
  #setTimeout;
  #clearTimeout;
  #timer = null;
  #running = null;
  #retryIndex = 0;
  #closed = false;
  #started = false;
  #ready;
  #resolveReady;
  constructor({
    controller,
    harness,
    logger = console,
    retryDelaysMs,
    healthyIntervalMs = 15e3,
    setTimeoutImpl = setTimeout,
    clearTimeoutImpl = clearTimeout
  }) {
    if (!controller || typeof controller.initialize !== "function" || typeof controller.status !== "function") {
      throw new TypeError("ConnectionSupervisor requires a controller");
    }
    if (!harness || typeof harness.ensureRunning !== "function") {
      throw new TypeError("ConnectionSupervisor requires a Harness client");
    }
    this.#controller = controller;
    this.#harness = harness;
    this.#logger = logger;
    this.#retryDelays = retryDelays(retryDelaysMs);
    this.#healthyIntervalMs = Number.isFinite(healthyIntervalMs) && healthyIntervalMs >= 0 ? healthyIntervalMs : 15e3;
    this.#setTimeout = setTimeoutImpl;
    this.#clearTimeout = clearTimeoutImpl;
    this.#ready = new Promise((resolve6) => {
      this.#resolveReady = resolve6;
    });
  }
  get ready() {
    return this.#ready;
  }
  start() {
    if (this.#started || this.#closed) return this;
    this.#started = true;
    this.#schedule(0);
    return this;
  }
  async close() {
    if (this.#closed) return;
    this.#closed = true;
    if (this.#timer !== null) this.#clearTimeout(this.#timer);
    this.#timer = null;
    await this.#running?.catch(() => void 0);
    this.#resolveReady?.(null);
    this.#resolveReady = null;
  }
  #schedule(delayMs) {
    if (this.#closed) return;
    this.#timer = this.#setTimeout(() => {
      this.#timer = null;
      void this.#run();
    }, delayMs);
    this.#timer?.unref?.();
  }
  async #run() {
    if (this.#closed || this.#running) return;
    const operation = this.#reconcile();
    this.#running = operation;
    try {
      await operation;
    } finally {
      if (this.#running === operation) this.#running = null;
    }
  }
  async #reconcile() {
    try {
      await this.#harness.ensureRunning();
      if (this.#closed) return;
      const status = await this.#controller.initialize();
      if (this.#closed) return;
      this.#resolveReady?.(status);
      this.#resolveReady = null;
      const { configured, connected } = status.totals;
      if (connected < configured) {
        const delayMs = this.#retryDelays[Math.min(this.#retryIndex, this.#retryDelays.length - 1)];
        this.#retryIndex += 1;
        this.#logger.warn?.(
          `[dsh-dingtalk] ${connected}/${configured} bots connected; retrying in ${delayMs}ms`
        );
        this.#schedule(delayMs);
        return;
      }
      this.#retryIndex = 0;
      this.#schedule(this.#healthyIntervalMs);
    } catch (error) {
      if (this.#closed) return;
      const delayMs = this.#retryDelays[Math.min(this.#retryIndex, this.#retryDelays.length - 1)];
      this.#retryIndex += 1;
      this.#logger.warn?.(
        `[dsh-dingtalk] connection reconciliation failed; retrying in ${delayMs}ms`,
        error
      );
      this.#schedule(delayMs);
    }
  }
};
function createConnectionSupervisor(options) {
  return new ConnectionSupervisor(options);
}

// plugin-src/host/channels/dingtalk/production.mjs
function harnessOrigin(webServer, configured) {
  if (configured !== void 0) return new URL(configured);
  const port = webServer?.port;
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("dsh-dingtalk requires an initialized DSH webServer port");
  }
  return new URL(`http://127.0.0.1:${port}`);
}
function pluginPaths(config) {
  const dshHome = resolve(config.dshHome ?? process.env.DSH_HOME ?? join(homedir(), ".dsh"));
  const root = resolve(config.dataDir ?? join(dshHome, "integrations", "dsh-dingtalk"));
  return {
    root,
    config: resolve(config.configPath ?? join(root, "config.json")),
    bots: resolve(config.botsDir ?? join(root, "bots"))
  };
}
async function createProductionController(ctx, config = {}, internals = {}) {
  if (!ctx?.credentials) throw new TypeError("dsh-dingtalk requires ctx.credentials");
  if (!ctx?.webServer) throw new TypeError("dsh-dingtalk requires ctx.webServer");
  const ConfigStore = internals.ConfigStore ?? DingtalkConfigStore;
  const DeviceAuth = internals.DeviceAuth ?? DingtalkDeviceAuth;
  const StateStore2 = internals.StateStore ?? DingtalkStateStore;
  const Harness = internals.HarnessClient ?? HarnessClient;
  const Controller = internals.Controller ?? DingtalkController;
  const Runtime = internals.Runtime ?? DingtalkRuntime;
  const createSupervisor = internals.createConnectionSupervisor ?? createConnectionSupervisor;
  const logger = typeof ctx.logger === "function" ? ctx.logger("dsh-dingtalk") : ctx.logger ?? console;
  const paths = pluginPaths(config);
  const configStore = await new ConfigStore(paths.config).load();
  const deviceAuth = internals.deviceAuth ?? new DeviceAuth({
    baseUrl: config.registrationBaseUrl
  });
  const stateStores = /* @__PURE__ */ new Map();
  const statePath = (botId) => resolve(paths.bots, botId, "state.json");
  const stateFor = async (botId) => {
    let state = stateStores.get(botId);
    if (!state) {
      state = await new StateStore2(statePath(botId)).load();
      stateStores.set(botId, state);
    }
    return state;
  };
  const harness = new Harness({
    baseUrl: harnessOrigin(ctx.webServer, config.harnessBaseUrl),
    workspace: resolve(config.workspace ?? process.cwd()),
    agentPreset: config.agentPreset ?? "standard",
    autostart: false,
    dshBin: config.dshBin ?? "dsh"
  });
  const controller = new Controller({
    deviceAuth,
    credentials: ctx.credentials,
    configStore,
    logger,
    createRuntime: async ({ botId, config: botConfig, clientSecret }) => {
      const state = await stateFor(botId);
      return new Runtime({
        config: botConfig,
        clientSecret,
        harness,
        state,
        replyTimeoutMs: config.replyTimeoutMs ?? 6e5,
        maxMessageChars: config.maxMessageChars ?? 4e3,
        connectTimeoutMs: config.connectTimeoutMs ?? 15e3,
        logger: {
          error: (...args) => logger.error?.(`[${botId}]`, ...args),
          warn: (...args) => logger.warn?.(`[${botId}]`, ...args),
          info: (...args) => logger.info?.(`[${botId}]`, ...args),
          debug: (...args) => logger.debug?.(`[${botId}]`, ...args)
        }
      });
    },
    deleteState: async ({ botId }) => {
      const state = stateStores.get(botId);
      stateStores.delete(botId);
      if (state && typeof state.remove === "function") {
        await state.remove();
        return;
      }
      try {
        await unlink3(statePath(botId));
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
      }
    }
  });
  const supervisor = createSupervisor({
    controller,
    harness,
    logger,
    retryDelaysMs: config.retryDelaysMs,
    healthyIntervalMs: config.healthyIntervalMs
  }).start();
  return {
    controller,
    ready: supervisor.ready,
    async close() {
      await supervisor.close();
      await controller.close();
      harness.stopManagedProcess();
    }
  };
}

// plugin-src/host/channels/dingtalk/rpc.mjs
import QRCode from "qrcode";
var DINGTALK_RPC_CHANNEL = "/dingtalk";
var DINGTALK_ENDPOINTS = Object.freeze({
  status: "connection.status",
  beginProvisioning: "provision.begin",
  pollProvisioning: "provision.poll",
  cancelProvisioning: "provision.cancel",
  reconnectBot: "bot.reconnect",
  deleteBot: "bot.delete",
  approveSender: "bot.sender.approve",
  revokeSender: "bot.sender.revoke"
});
var DINGTALK_RPC_ENDPOINTS = Object.freeze(Object.values(DINGTALK_ENDPOINTS));
var FORBIDDEN_PUBLIC_KEYS = /* @__PURE__ */ new Set([
  "clientSecret",
  "client_secret",
  "deviceCode",
  "device_code",
  "secretRef",
  "staffId",
  "senderStaffId",
  "verificationUrl",
  "verificationUri",
  "userCode"
]);
function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function exactKeys(value, allowed) {
  return isRecord(value) && Object.keys(value).every((key) => allowed.includes(key));
}
function validId(value) {
  return typeof value === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(value);
}
function payloadFailure(endpoint, payload) {
  if (!isRecord(payload)) return "Payload must be an object.";
  if (endpoint === DINGTALK_ENDPOINTS.status) {
    return exactKeys(payload, []) ? null : "connection.status does not accept fields.";
  }
  if (endpoint === DINGTALK_ENDPOINTS.beginProvisioning) {
    return exactKeys(payload, ["locale"]) && (payload.locale === void 0 || payload.locale === "zh-CN") ? null : "provision.begin received unsupported fields.";
  }
  if ([DINGTALK_ENDPOINTS.pollProvisioning, DINGTALK_ENDPOINTS.cancelProvisioning].includes(endpoint)) {
    return exactKeys(payload, ["attemptId"]) && validId(payload.attemptId) ? null : `${endpoint} requires an attemptId.`;
  }
  if (endpoint === DINGTALK_ENDPOINTS.reconnectBot) {
    return exactKeys(payload, ["botId"]) && validId(payload.botId) ? null : "bot.reconnect requires a botId.";
  }
  if (endpoint === DINGTALK_ENDPOINTS.deleteBot) {
    return exactKeys(payload, ["botId", "confirm"]) && validId(payload.botId) && payload.confirm === true ? null : "bot.delete requires a botId and confirm=true.";
  }
  if (endpoint === DINGTALK_ENDPOINTS.approveSender) {
    return exactKeys(payload, ["botId", "requestId", "confirm"]) && validId(payload.botId) && validId(payload.requestId) && payload.confirm === true ? null : "bot.sender.approve requires botId, requestId, and confirm=true.";
  }
  if (endpoint === DINGTALK_ENDPOINTS.revokeSender) {
    return exactKeys(payload, ["botId", "senderKey", "confirm"]) && validId(payload.botId) && validId(payload.senderKey) && payload.confirm === true ? null : "bot.sender.revoke requires botId, senderKey, and confirm=true.";
  }
  return "Unknown DingTalk endpoint.";
}
function badRequest(message) {
  return { ok: false, error: { code: "bad-request", message } };
}
function cancelled() {
  return { ok: false, error: { code: "cancelled", message: "The request was cancelled." } };
}
function internalFailure() {
  return {
    ok: false,
    error: { code: "dingtalk-operation-failed", message: "\u9489\u9489\u64CD\u4F5C\u5931\u8D25\uFF0C\u8BF7\u7A0D\u540E\u91CD\u8BD5\u3002" }
  };
}
function sanitizePublic(value) {
  if (Array.isArray(value)) return value.map(sanitizePublic);
  if (!isRecord(value)) return value;
  const safe = {};
  for (const [key, child] of Object.entries(value)) {
    if (!FORBIDDEN_PUBLIC_KEYS.has(key)) safe[key] = sanitizePublic(child);
  }
  return safe;
}
async function qrDataUrl(value) {
  return QRCode.toDataURL(value, {
    type: "image/png",
    errorCorrectionLevel: "M",
    margin: 2,
    width: 320
  });
}
async function withEncodedQr(value, encodeQr) {
  if (!value || typeof value.verificationUrl !== "string") return sanitizePublic(value);
  return sanitizePublic({
    ...value,
    qrCodeDataUrl: await encodeQr(value.verificationUrl)
  });
}
async function publicStatus(status, encodeQr) {
  const value = structuredClone(status);
  if (value?.provisioning) {
    value.provisioning = await withEncodedQr(value.provisioning, encodeQr);
  }
  return sanitizePublic(value);
}
function assertController(controller) {
  for (const method of [
    "status",
    "startProvisioning",
    "registrationStatus",
    "cancelProvisioning",
    "reconnectBot",
    "deleteBot",
    "approveSender",
    "revokeSender"
  ]) {
    if (typeof controller?.[method] !== "function") {
      throw new TypeError(`A complete DingTalk controller is required (${method})`);
    }
  }
}
function createDingtalkRpcHandler(controller, { encodeQr = qrDataUrl } = {}) {
  assertController(controller);
  const qrCache = /* @__PURE__ */ new Map();
  const cachedEncode = (url) => {
    let encoded = qrCache.get(url);
    if (!encoded) {
      if (qrCache.size >= 16) qrCache.delete(qrCache.keys().next().value);
      encoded = Promise.resolve().then(() => encodeQr(url));
      qrCache.set(url, encoded);
    }
    return encoded;
  };
  return async (endpoint, payload, signal) => {
    if (signal?.aborted) return cancelled();
    if (!DINGTALK_RPC_ENDPOINTS.includes(endpoint)) return badRequest("Unknown DingTalk endpoint.");
    const invalid = payloadFailure(endpoint, payload);
    if (invalid) return badRequest(invalid);
    try {
      let value;
      if (endpoint === DINGTALK_ENDPOINTS.status) {
        value = await publicStatus(await controller.status(), cachedEncode);
      } else if (endpoint === DINGTALK_ENDPOINTS.beginProvisioning) {
        const started = await controller.startProvisioning({ signal });
        if (signal?.aborted) {
          await controller.cancelProvisioning(started.attemptId);
          return cancelled();
        }
        value = await withEncodedQr(started, cachedEncode);
      } else if (endpoint === DINGTALK_ENDPOINTS.pollProvisioning) {
        const current = await controller.registrationStatus(payload.attemptId);
        if (!current) return badRequest("The provisioning attempt no longer exists.");
        value = await withEncodedQr(current, cachedEncode);
      } else if (endpoint === DINGTALK_ENDPOINTS.cancelProvisioning) {
        value = await controller.cancelProvisioning(payload.attemptId);
        if (!value) return badRequest("The provisioning attempt no longer exists.");
        value = sanitizePublic(value);
      } else if (endpoint === DINGTALK_ENDPOINTS.reconnectBot) {
        value = await publicStatus(await controller.reconnectBot(payload.botId), cachedEncode);
      } else if (endpoint === DINGTALK_ENDPOINTS.deleteBot) {
        value = await publicStatus(await controller.deleteBot(payload.botId), cachedEncode);
      } else if (endpoint === DINGTALK_ENDPOINTS.approveSender) {
        value = await publicStatus(
          await controller.approveSender(payload.botId, payload.requestId),
          cachedEncode
        );
      } else {
        value = await publicStatus(
          await controller.revokeSender(payload.botId, payload.senderKey),
          cachedEncode
        );
      }
      return signal?.aborted ? cancelled() : { ok: true, value };
    } catch {
      return signal?.aborted ? cancelled() : internalFailure();
    }
  };
}
function installDingtalkRpc(ctx, controller, options) {
  if (!ctx?.connection?.rpc || typeof ctx.connection.rpc.handle !== "function") {
    throw new TypeError("DSH Host Connection RPC is required");
  }
  return ctx.connection.rpc.handle(
    DINGTALK_RPC_CHANNEL,
    createDingtalkRpcHandler(controller, options),
    { authority: "loopback" }
  );
}

// plugin-src/host/channels/dingtalk/index.mjs
async function apply(ctx, config = {}) {
  if (config?.controller) return installDingtalkRpc(ctx, config.controller, config.rpcOptions);
  const production = await createProductionController(ctx, config, config.internals);
  const disposeRpc = installDingtalkRpc(ctx, production.controller, config.rpcOptions);
  ctx.effect(() => async () => {
    await production.close();
  }, "dsh-dingtalk: close bot connections");
  return disposeRpc;
}

// plugin-src/host/channels/feishu/controller.mjs
var ACTIVE_REGISTRATION_STATES = /* @__PURE__ */ new Set([
  "starting",
  "qr_ready",
  "polling",
  "slow_down",
  "domain_switched"
]);
function credentialResult(result) {
  const appId = result?.client_id ?? result?.appId;
  const appSecret = result?.client_secret ?? result?.appSecret;
  if (typeof appId !== "string" || appId.length === 0 || typeof appSecret !== "string" || appSecret.length === 0) {
    throw new TypeError("Feishu registration returned invalid credentials");
  }
  return {
    appId,
    appSecret,
    userInfo: result?.user_info ?? result?.userInfo
  };
}
async function readConnectionStatus(connectionManager) {
  if (typeof connectionManager.status !== "function") return {};
  return await connectionManager.status();
}
function isConnected(status) {
  if (status?.connected === true) return true;
  return status?.ready === true && status?.feishuLongConnectionState === "connected" && status?.harnessReachable === true;
}
var ProvisioningBackedController = class {
  #credentialStore;
  #connectionManager;
  #registrationOptions;
  #manager;
  #knownConfigured = false;
  #lastError = null;
  constructor({
    createProvisioningManager,
    credentialStore,
    connectionManager,
    registrationOptions = {}
  } = {}) {
    if (typeof createProvisioningManager !== "function") {
      throw new TypeError("createProvisioningManager is required");
    }
    if (!credentialStore || typeof credentialStore.save !== "function" || typeof credentialStore.clear !== "function") {
      throw new TypeError("credentialStore.save/clear are required");
    }
    if (!connectionManager || typeof connectionManager.connect !== "function" || typeof connectionManager.disconnect !== "function") {
      throw new TypeError("connectionManager.connect/disconnect are required");
    }
    if (registrationOptions === null || typeof registrationOptions !== "object" || Array.isArray(registrationOptions)) {
      throw new TypeError("registrationOptions must be an object");
    }
    this.#credentialStore = credentialStore;
    this.#connectionManager = connectionManager;
    this.#registrationOptions = structuredClone(registrationOptions);
    this.#manager = createProvisioningManager({
      onCredentials: (result) => this.#acceptCredentials(result)
    });
    if (!this.#manager || typeof this.#manager.start !== "function" || typeof this.#manager.status !== "function" || typeof this.#manager.cancel !== "function") {
      throw new TypeError("The provisioning manager must implement start/status/cancel");
    }
  }
  async startRegistration() {
    this.#lastError = null;
    await this.#manager.start(structuredClone(this.#registrationOptions));
    return this.status();
  }
  async cancelRegistration() {
    await this.#manager.cancel();
    return this.status();
  }
  async disconnect() {
    await this.#manager.cancel();
    await this.#connectionManager.disconnect();
    try {
      await this.#credentialStore.clear();
      this.#knownConfigured = false;
      this.#lastError = null;
    } catch {
      this.#lastError = {
        code: "credential_removal_failed",
        message: "Unable to remove the Feishu credentials."
      };
    }
    return this.status();
  }
  async status() {
    const registration = await this.#manager.status();
    const connection = await readConnectionStatus(this.#connectionManager);
    const connected = isConnected(connection);
    let configured = this.#knownConfigured;
    if (typeof this.#credentialStore.configured === "function") {
      try {
        configured = await this.#credentialStore.configured();
      } catch {
        configured = this.#knownConfigured;
      }
    }
    let phase = "unconfigured";
    if (connected) phase = "connected";
    else if (ACTIVE_REGISTRATION_STATES.has(registration?.state)) phase = "registering";
    else if (registration?.state === "saving") phase = "connecting";
    else if (this.#lastError || registration?.state === "error") phase = "error";
    else if (configured) phase = "disconnected";
    return {
      phase,
      connected,
      configured,
      registration,
      connection,
      error: this.#lastError ?? registration?.error ?? null
    };
  }
  async close() {
    await this.#manager.cancel();
    await this.#connectionManager.disconnect();
  }
  async #acceptCredentials(result) {
    const credentials = credentialResult(result);
    try {
      await this.#credentialStore.save(credentials);
      this.#knownConfigured = true;
      await this.#connectionManager.connect(credentials);
      this.#lastError = null;
    } catch {
      this.#lastError = {
        code: "connection_failed",
        message: "The bot was created, but its connection could not be started."
      };
      throw new Error("Unable to activate the Feishu connection.");
    }
  }
};
function createProvisioningBackedController(options) {
  return new ProvisioningBackedController(options);
}

// plugin-src/host/channels/feishu/production.mjs
import { homedir as homedir2 } from "node:os";
import { join as join2, resolve as resolve2 } from "node:path";
import { unlink as unlink5 } from "node:fs/promises";
import * as Lark from "@larksuiteoapi/node-sdk";

// plugin-src/host/channels/feishu/connection-supervisor.mjs
var DEFAULT_RETRY_DELAYS_MS2 = Object.freeze([250, 1e3, 3e3, 5e3, 1e4, 3e4]);
function safeDelay(value, fallback) {
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}
function safeRetryDelays(value) {
  if (!Array.isArray(value) || value.length === 0) return [...DEFAULT_RETRY_DELAYS_MS2];
  const delays = value.map((delay2) => safeDelay(delay2, -1)).filter((delay2) => delay2 >= 0);
  return delays.length > 0 ? delays : [...DEFAULT_RETRY_DELAYS_MS2];
}
function totals(status) {
  const configured = Number.isInteger(status?.totals?.configured) ? status.totals.configured : Array.isArray(status?.bots) ? status.bots.length : 0;
  const connected = Number.isInteger(status?.totals?.connected) ? status.totals.connected : Array.isArray(status?.bots) ? status.bots.filter((bot) => bot?.connected === true).length : 0;
  return { configured, connected };
}
var ConnectionSupervisor2 = class {
  #controller;
  #harness;
  #logger;
  #retryDelaysMs;
  #healthyIntervalMs;
  #setTimeout;
  #clearTimeout;
  #timer = null;
  #running = null;
  #retryIndex = 0;
  #started = false;
  #closed = false;
  #ready;
  #resolveReady;
  constructor({
    controller,
    harness,
    logger = console,
    retryDelaysMs,
    healthyIntervalMs = 15e3,
    setTimeoutImpl = setTimeout,
    clearTimeoutImpl = clearTimeout
  }) {
    if (!controller || typeof controller.initialize !== "function" || typeof controller.status !== "function") {
      throw new TypeError("ConnectionSupervisor requires a controller");
    }
    if (!harness || typeof harness.ensureRunning !== "function") {
      throw new TypeError("ConnectionSupervisor requires a Harness client");
    }
    this.#controller = controller;
    this.#harness = harness;
    this.#logger = logger;
    this.#retryDelaysMs = safeRetryDelays(retryDelaysMs);
    this.#healthyIntervalMs = safeDelay(healthyIntervalMs, 15e3);
    this.#setTimeout = setTimeoutImpl;
    this.#clearTimeout = clearTimeoutImpl;
    this.#ready = new Promise((resolve6) => {
      this.#resolveReady = resolve6;
    });
  }
  get ready() {
    return this.#ready;
  }
  start() {
    if (this.#started || this.#closed) return this;
    this.#started = true;
    this.#schedule(0);
    return this;
  }
  async close() {
    if (this.#closed) return;
    this.#closed = true;
    if (this.#timer !== null) {
      this.#clearTimeout(this.#timer);
      this.#timer = null;
    }
    await this.#running?.catch(() => void 0);
    this.#resolveReady?.(null);
    this.#resolveReady = null;
  }
  #schedule(delayMs) {
    if (this.#closed) return;
    this.#timer = this.#setTimeout(() => {
      this.#timer = null;
      void this.#run();
    }, delayMs);
    this.#timer?.unref?.();
  }
  async #run() {
    if (this.#closed || this.#running) return;
    const operation = this.#reconcile();
    this.#running = operation;
    try {
      await operation;
    } finally {
      if (this.#running === operation) this.#running = null;
    }
  }
  async #reconcile() {
    try {
      await this.#harness.ensureRunning();
    } catch (error) {
      if (this.#closed) return;
      this.#retry("Harness Host is not ready", error);
      return;
    }
    if (this.#closed) return;
    try {
      await this.#controller.initialize();
      if (this.#closed) return;
      const status = this.#controller.status();
      this.#resolveReady?.(status);
      this.#resolveReady = null;
      const current = totals(status);
      if (current.connected < current.configured) {
        const delay2 = this.#retryDelaysMs[Math.min(this.#retryIndex, this.#retryDelaysMs.length - 1)];
        this.#retryIndex += 1;
        this.#logger.warn?.(
          `[dsh-feishu] ${current.connected}/${current.configured} bots connected; retrying automatically in ${delay2}ms`
        );
        this.#schedule(delay2);
        return;
      }
      this.#retryIndex = 0;
      this.#schedule(this.#healthyIntervalMs);
    } catch (error) {
      if (this.#closed) return;
      this.#retry("Bot connection reconciliation failed", error);
    }
  }
  #retry(message, error) {
    const delay2 = this.#retryDelaysMs[Math.min(this.#retryIndex, this.#retryDelaysMs.length - 1)];
    this.#retryIndex += 1;
    this.#logger.warn?.(
      `[dsh-feishu] ${message}; retrying automatically in ${delay2}ms`,
      error
    );
    this.#schedule(delay2);
  }
};
function createConnectionSupervisor2(options) {
  return new ConnectionSupervisor2(options);
}

// src/channels/feishu/feishu-app.mjs
function endpointFor(domain, path) {
  const origin = domain === "lark" ? "https://open.larksuite.com" : "https://open.feishu.cn";
  return new URL(path, origin);
}
async function jsonResponse(response, operation) {
  let body;
  try {
    body = await response.json();
  } catch {
    throw new Error(`${operation} returned a non-JSON response`);
  }
  if (!response.ok || body?.code !== 0) {
    throw new Error(`${operation} failed: ${body?.msg || `HTTP ${response.status}`}`);
  }
  return body;
}
async function verifyFeishuApp({
  appId,
  appSecret,
  domain = "feishu",
  fetchImpl = fetch,
  timeoutMs = 15e3
}) {
  if (!appId || !appSecret) throw new Error("Feishu credentials are incomplete");
  const tokenResponse = await fetchImpl(endpointFor(domain, "/open-apis/auth/v3/tenant_access_token/internal"), {
    method: "POST",
    headers: { "content-type": "application/json; charset=utf-8" },
    body: JSON.stringify({ app_id: appId, app_secret: appSecret }),
    signal: AbortSignal.timeout(timeoutMs)
  });
  const tokenBody = await jsonResponse(tokenResponse, "Feishu authentication");
  if (!tokenBody.tenant_access_token) {
    throw new Error("Feishu authentication returned no tenant access token");
  }
  const botResponse = await fetchImpl(endpointFor(domain, "/open-apis/bot/v3/info/"), {
    headers: { authorization: `Bearer ${tokenBody.tenant_access_token}` },
    signal: AbortSignal.timeout(timeoutMs)
  });
  const botBody = await jsonResponse(botResponse, "Feishu bot verification");
  const bot = botBody.bot ?? {};
  return Object.freeze({
    appId,
    name: bot.app_name ?? bot.bot_name ?? null,
    openId: bot.open_id ?? null,
    activated: bot.activate_status ?? null
  });
}

// src/channels/feishu/message-utils.mjs
function conversationKey2(event) {
  const chatType = event?.message?.chat_type;
  if (chatType === "p2p") {
    const senderId = event?.sender?.sender_id?.open_id || event?.sender?.sender_id?.user_id;
    if (!senderId) throw new Error("Feishu p2p event has no sender id");
    return `p2p:${senderId}`;
  }
  const chatId = event?.message?.chat_id;
  if (!chatId) throw new Error("Feishu group event has no chat id");
  return `group:${chatId}`;
}
function extractText(event) {
  if (event?.message?.message_type !== "text") return null;
  let parsed;
  try {
    parsed = JSON.parse(event.message.content);
  } catch {
    return null;
  }
  let text = typeof parsed.text === "string" ? parsed.text : "";
  for (const mention of event.message.mentions ?? []) {
    if (typeof mention.key === "string" && mention.key) text = text.replaceAll(mention.key, "");
  }
  return text.trim();
}
function splitText(text, maxChars = 9e3) {
  if (text.length <= maxChars) return [text];
  const chunks = [];
  let remaining = text;
  while (remaining.length > maxChars) {
    let splitAt = remaining.lastIndexOf("\n", maxChars);
    if (splitAt < Math.floor(maxChars * 0.6)) splitAt = maxChars;
    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt).replace(/^\n+/, "");
  }
  if (remaining) chunks.push(remaining);
  return chunks;
}
function isBotSender(event) {
  return event?.sender?.sender_type === "bot";
}
function isAllowedSender(event, allowedOpenIds) {
  if (!allowedOpenIds || allowedOpenIds.size === 0) return false;
  const senderOpenId = event?.sender?.sender_id?.open_id;
  return typeof senderOpenId === "string" && allowedOpenIds.has(senderOpenId);
}

// src/channels/feishu/bridge.mjs
var HELP_TEXT2 = [
  "\u5317\u6C47\u661F\u6CB3 AIOS \u5DF2\u8FDE\u63A5 DeepSeek Harness\u3002",
  "",
  "\u76F4\u63A5\u53D1\u9001\u95EE\u9898\u5373\u53EF\u7EE7\u7EED\u5F53\u524D\u4F1A\u8BDD\u3002",
  "/new  \u5F00\u542F\u4E00\u4E2A\u5168\u65B0\u4F1A\u8BDD",
  "/status  \u68C0\u67E5\u8FDE\u63A5\u72B6\u6001",
  "/help  \u663E\u793A\u672C\u5E2E\u52A9"
].join("\n");
var FeishuHarnessBridge = class {
  #client;
  #channel;
  #harness;
  #state;
  #queues = /* @__PURE__ */ new Map();
  #acceptedMessageIds = /* @__PURE__ */ new Set();
  #status;
  #allowedSenderOpenIds;
  #replyTimeoutMs;
  constructor({
    client,
    channel,
    harness,
    state,
    status,
    allowedSenderOpenIds = /* @__PURE__ */ new Set(),
    replyTimeoutMs = 6e5
  }) {
    this.#client = client;
    this.#channel = channel;
    this.#harness = harness;
    this.#state = state;
    this.#status = status;
    this.#allowedSenderOpenIds = allowedSenderOpenIds;
    this.#replyTimeoutMs = replyTimeoutMs;
  }
  accept(event) {
    const messageId = event?.message?.message_id;
    if (!messageId || isBotSender(event) || event?.message?.message_type !== "text") return;
    if (!isAllowedSender(event, this.#allowedSenderOpenIds)) {
      this.#status.messagesRejected += 1;
      this.#status.lastRejectedAt = (/* @__PURE__ */ new Date()).toISOString();
      console.warn("[bridge] ignored a message from a sender outside the allowlist");
      return;
    }
    if (this.#state.hasSeen(messageId) || this.#acceptedMessageIds.has(messageId)) return;
    this.#acceptedMessageIds.add(messageId);
    const processingReaction = this.#addReaction(messageId, "OnIt");
    const key = conversationKey2(event);
    const previous = this.#queues.get(key) ?? Promise.resolve();
    const task = previous.catch(() => void 0).then(() => this.#handle(event, key)).then(() => this.#finishReaction(messageId, processingReaction, "DONE")).catch(async (error) => {
      console.error("[bridge] message handling failed:", error.message);
      this.#status.lastError = error.message;
      await this.#finishReaction(messageId, processingReaction, "ERROR");
      await this.#send(
        event.message.chat_id,
        "\u5904\u7406\u5931\u8D25\uFF0C\u8BF7\u7A0D\u540E\u91CD\u8BD5\u3002\u5982\u679C\u95EE\u9898\u6301\u7EED\uFF0C\u8BF7\u5728 DeepSeek Harness \u7684\u98DE\u4E66\u63D2\u4EF6\u9875\u9762\u68C0\u67E5\u8FDE\u63A5\u72B6\u6001\u3002"
      ).catch(() => void 0);
    }).finally(() => {
      this.#acceptedMessageIds.delete(messageId);
      if (this.#queues.get(key) === task) this.#queues.delete(key);
    });
    this.#queues.set(key, task);
  }
  async waitForIdle() {
    await Promise.allSettled([...this.#queues.values()]);
  }
  async #handle(event, key) {
    const messageId = event.message.message_id;
    await this.#state.markSeen(messageId);
    this.#status.lastMessageAt = (/* @__PURE__ */ new Date()).toISOString();
    this.#status.messagesReceived += 1;
    const text = extractText(event);
    if (!text) return;
    if (text === "/help") {
      await this.#send(event.message.chat_id, HELP_TEXT2);
      return;
    }
    if (text === "/new") {
      await this.#state.clearSession(key);
      await this.#send(event.message.chat_id, "\u5DF2\u5F00\u542F\u5168\u65B0 Harness \u4F1A\u8BDD\u3002");
      return;
    }
    if (text === "/status") {
      await this.#harness.ensureRunning();
      await this.#send(event.message.chat_id, "\u98DE\u4E66\u673A\u5668\u4EBA\u4E0E DeepSeek Harness \u8FDE\u63A5\u6B63\u5E38\u3002");
      return;
    }
    let sessionId = this.#state.sessionFor(key);
    if (!sessionId || !await this.#harness.sessionExists(sessionId)) {
      sessionId = await this.#harness.createSession();
      await this.#state.setSession(key, sessionId);
    }
    console.info(`[bridge] processing ${event.message.chat_type} message ${messageId} in ${sessionId}`);
    await this.#answerWithStream(event, sessionId, text);
    this.#status.messagesReplied += 1;
    this.#status.lastReplyAt = (/* @__PURE__ */ new Date()).toISOString();
    this.#status.lastError = null;
  }
  async #answerWithStream(event, sessionId, text) {
    const chatId = event.message.chat_id;
    const messageId = event.message.message_id;
    if (!this.#channel?.stream) {
      const answer = await this.#harness.ask(sessionId, text, { timeoutMs: this.#replyTimeoutMs });
      for (const chunk of splitText(answer)) await this.#send(chatId, chunk);
      this.#status.streamFallbacks = (this.#status.streamFallbacks ?? 0) + 1;
      return;
    }
    let promptStarted = false;
    let completedAnswer = "";
    try {
      await this.#channel.stream(chatId, {
        markdown: async (controller) => {
          promptStarted = true;
          completedAnswer = await this.#harness.ask(sessionId, text, {
            timeoutMs: this.#replyTimeoutMs,
            onUpdate: async (update) => {
              await controller.setContent(this.#progressText(update));
              this.#status.streamUpdates = (this.#status.streamUpdates ?? 0) + 1;
            }
          });
          await controller.setContent(completedAnswer);
        }
      }, { replyTo: messageId });
      this.#status.streamResponses = (this.#status.streamResponses ?? 0) + 1;
    } catch (error) {
      this.#status.streamErrors = (this.#status.streamErrors ?? 0) + 1;
      if (completedAnswer) {
        console.warn("[bridge] native Feishu stream failed after generation; sending final text:", error.message);
        for (const chunk of splitText(completedAnswer)) await this.#send(chatId, chunk);
        this.#status.streamFallbacks = (this.#status.streamFallbacks ?? 0) + 1;
        return;
      }
      if (promptStarted) throw error;
      console.warn("[bridge] native Feishu stream unavailable; using text fallback:", error.message);
      const answer = await this.#harness.ask(sessionId, text, { timeoutMs: this.#replyTimeoutMs });
      for (const chunk of splitText(answer)) await this.#send(chatId, chunk);
      this.#status.streamFallbacks = (this.#status.streamFallbacks ?? 0) + 1;
    }
  }
  #progressText(update) {
    if (update.type === "text" && update.text) return update.text;
    if (update.type === "tool") {
      if (update.name === "web_search") return "_\u6B63\u5728\u641C\u7D22\u7F51\u7EDC\u5E76\u6574\u7406\u4FE1\u606F\u2026_";
      return `_\u6B63\u5728\u4F7F\u7528 ${update.name || "\u5DE5\u5177"}\u2026_`;
    }
    return `_${update.text || "\u6B63\u5728\u5904\u7406\u2026"}_`;
  }
  async #addReaction(messageId, emojiType) {
    if (!this.#channel?.addReaction) return null;
    try {
      const reactionId = await this.#channel.addReaction(messageId, emojiType);
      this.#status.reactionsAdded = (this.#status.reactionsAdded ?? 0) + 1;
      return reactionId;
    } catch (error) {
      this.#status.reactionErrors = (this.#status.reactionErrors ?? 0) + 1;
      console.warn(`[bridge] unable to add ${emojiType} reaction:`, error.message);
      return null;
    }
  }
  async #finishReaction(messageId, processingReaction, finalEmojiType) {
    const reactionId = await processingReaction;
    if (reactionId && this.#channel?.removeReaction) {
      try {
        await this.#channel.removeReaction(messageId, reactionId);
        this.#status.reactionsRemoved = (this.#status.reactionsRemoved ?? 0) + 1;
      } catch (error) {
        this.#status.reactionErrors = (this.#status.reactionErrors ?? 0) + 1;
        console.warn("[bridge] unable to remove processing reaction:", error.message);
      }
    }
    await this.#addReaction(messageId, finalEmojiType);
  }
  async #send(chatId, text) {
    const response = await this.#client.im.v1.message.create({
      params: { receive_id_type: "chat_id" },
      data: {
        receive_id: chatId,
        msg_type: "text",
        content: JSON.stringify({ text })
      }
    });
    if (response?.code && response.code !== 0) {
      throw new Error(`Feishu send failed: ${response.msg || response.code}`);
    }
  }
};

// src/channels/feishu/feishu-channel.mjs
var STREAM_ELEMENT_ID = "stream_md";
var DEFAULT_INITIAL_TEXT = "\u5DF2\u8FDE\u63A5 DeepSeek Harness\uFF0C\u6B63\u5728\u601D\u8003\u2026";
var MAX_STREAM_CHARS = 28e3;
function assertApiSuccess(operation, response) {
  if (response?.code && response.code !== 0) {
    throw new Error(`${operation} failed: ${response.msg || response.code}`);
  }
  return response;
}
function summaryOf(text) {
  const summary = String(text ?? "").replace(/\s+/g, " ").trim();
  return summary.length <= 50 ? summary : `${summary.slice(0, 49)}\u2026`;
}
function streamingCard(initialText) {
  return {
    schema: "2.0",
    config: {
      streaming_mode: true,
      summary: { content: "\u6B63\u5728\u751F\u6210\u2026" },
      streaming_config: {
        print_frequency_ms: { default: 70 },
        print_step: { default: 1 },
        print_strategy: "fast"
      }
    },
    body: {
      elements: [{
        tag: "markdown",
        element_id: STREAM_ELEMENT_ID,
        content: initialText
      }]
    }
  };
}
var VerifiedFeishuChannel = class {
  #client;
  #initialText;
  constructor({ client, initialText = DEFAULT_INITIAL_TEXT }) {
    this.#client = client;
    this.#initialText = initialText;
  }
  async stream(chatId, input, options = {}) {
    if (typeof input?.markdown !== "function") {
      throw new Error("Feishu stream requires a markdown producer");
    }
    let messageId = null;
    const cardResponse = assertApiSuccess("Feishu card.create", await this.#client.cardkit.v1.card.create({
      data: {
        type: "card_json",
        data: JSON.stringify(streamingCard(this.#initialText))
      }
    }));
    const cardId = cardResponse?.data?.card_id;
    if (!cardId) throw new Error("Feishu card.create returned no card_id");
    try {
      messageId = await this.#sendCard(chatId, cardId, options.replyTo);
      let sequence = 0;
      let lastContent = this.#initialText;
      const controller = {
        messageId,
        setContent: async (content) => {
          const next = String(content ?? "") || "\u2026";
          if (next === lastContent) return;
          if (next.length > MAX_STREAM_CHARS) {
            throw new Error(`Feishu stream content exceeds ${MAX_STREAM_CHARS} characters`);
          }
          const response = await this.#client.cardkit.v1.cardElement.content({
            path: { card_id: cardId, element_id: STREAM_ELEMENT_ID },
            data: {
              content: next,
              sequence: ++sequence,
              uuid: `content_${cardId}_${sequence}`
            }
          });
          assertApiSuccess("Feishu cardElement.content", response);
          lastContent = next;
        }
      };
      await input.markdown(controller);
      const finishResponse = await this.#client.cardkit.v1.card.settings({
        path: { card_id: cardId },
        data: {
          settings: JSON.stringify({
            config: {
              streaming_mode: false,
              summary: { content: summaryOf(lastContent) || "\u56DE\u7B54\u5B8C\u6210" }
            }
          }),
          sequence: ++sequence,
          uuid: `settings_${cardId}_${sequence}`
        }
      });
      assertApiSuccess("Feishu card.settings", finishResponse);
      return { messageId };
    } catch (error) {
      if (messageId) await this.#recall(messageId);
      throw error;
    }
  }
  async #sendCard(chatId, cardId, replyTo) {
    const content = JSON.stringify({ type: "card", data: { card_id: cardId } });
    const response = replyTo ? await this.#client.im.v1.message.reply({
      path: { message_id: replyTo },
      data: { msg_type: "interactive", content }
    }) : await this.#client.im.v1.message.create({
      params: { receive_id_type: "chat_id" },
      data: { receive_id: chatId, msg_type: "interactive", content }
    });
    assertApiSuccess("Feishu message send", response);
    const messageId = response?.data?.message_id;
    if (!messageId) throw new Error("Feishu message send returned no message_id");
    return messageId;
  }
  async #recall(messageId) {
    try {
      const response = await this.#client.im.v1.message.delete({
        path: { message_id: messageId }
      });
      assertApiSuccess("Feishu message delete", response);
    } catch (error) {
      console.warn("[bridge] unable to recall a failed streaming card:", error.message);
    }
  }
  async addReaction(messageId, emojiType) {
    const response = assertApiSuccess("Feishu reaction.create", await this.#client.im.v1.messageReaction.create({
      path: { message_id: messageId },
      data: { reaction_type: { emoji_type: emojiType } }
    }));
    const reactionId = response?.data?.reaction_id;
    if (!reactionId) throw new Error("Feishu reaction.create returned no reaction_id");
    return reactionId;
  }
  async removeReaction(messageId, reactionId) {
    assertApiSuccess("Feishu reaction.delete", await this.#client.im.v1.messageReaction.delete({
      path: { message_id: messageId, reaction_id: reactionId }
    }));
  }
};

// src/channels/feishu/feishu-runtime.mjs
function createBridgeStatus({ allowedSenderCount = 1 } = {}) {
  return {
    startedAt: null,
    ready: false,
    feishuLongConnectionState: "idle",
    harnessReachable: false,
    messagesReceived: 0,
    messagesReplied: 0,
    messagesRejected: 0,
    reactionsAdded: 0,
    reactionsRemoved: 0,
    reactionErrors: 0,
    streamResponses: 0,
    streamUpdates: 0,
    streamFallbacks: 0,
    streamErrors: 0,
    lastMessageAt: null,
    lastReplyAt: null,
    lastRejectedAt: null,
    lastError: null,
    agentPreset: "standard",
    authorizationMode: "sender-open-id-allowlist",
    allowedSenderCount
  };
}
var FeishuRuntime = class {
  #lark;
  #appId;
  #appSecret;
  #domain;
  #ownerOpenIds;
  #harness;
  #state;
  #replyTimeoutMs;
  #connectTimeoutMs;
  #logger;
  #client = null;
  #bridge = null;
  #wsClient = null;
  #starting = null;
  #status;
  constructor({
    lark,
    appId,
    appSecret,
    domain = "feishu",
    ownerOpenId,
    ownerOpenIds,
    harness,
    state,
    replyTimeoutMs = 6e5,
    connectTimeoutMs = 15e3,
    logger = console
  }) {
    if (!lark) throw new Error("FeishuRuntime requires the Feishu SDK");
    if (!appId || !appSecret) throw new Error("FeishuRuntime requires app credentials");
    const allowedOwners = Array.isArray(ownerOpenIds) ? ownerOpenIds : [ownerOpenId];
    const normalizedOwners = [...new Set(allowedOwners.filter((value) => typeof value === "string" && value))];
    if (normalizedOwners.length === 0) throw new Error("FeishuRuntime requires at least one owner open_id");
    if (!harness) throw new Error("FeishuRuntime requires a Harness client");
    if (!state) throw new Error("FeishuRuntime requires a state store");
    this.#lark = lark;
    this.#appId = appId;
    this.#appSecret = appSecret;
    this.#domain = domain;
    this.#ownerOpenIds = normalizedOwners;
    this.#harness = harness;
    this.#state = state;
    this.#replyTimeoutMs = replyTimeoutMs;
    this.#connectTimeoutMs = connectTimeoutMs;
    this.#logger = logger;
    this.#status = createBridgeStatus({ allowedSenderCount: normalizedOwners.length });
  }
  get status() {
    return structuredClone(this.#status);
  }
  async start() {
    if (this.#wsClient && this.#status.ready) return this.status;
    if (this.#starting) return this.#starting;
    this.#starting = this.#start().finally(() => {
      this.#starting = null;
    });
    return this.#starting;
  }
  async #start() {
    this.#status.startedAt = (/* @__PURE__ */ new Date()).toISOString();
    this.#status.feishuLongConnectionState = "connecting";
    this.#status.lastError = null;
    try {
      await this.#harness.ensureRunning();
      this.#status.harnessReachable = true;
      const sdkDomain = this.#domain === "lark" ? this.#lark.Domain.Lark : this.#lark.Domain.Feishu;
      const larkConfig = {
        appId: this.#appId,
        appSecret: this.#appSecret,
        domain: sdkDomain
      };
      this.#client = new this.#lark.Client(larkConfig);
      const channel = new VerifiedFeishuChannel({
        client: this.#client,
        initialText: "\u5DF2\u8FDE\u63A5 DeepSeek Harness\uFF0C\u6B63\u5728\u601D\u8003\u2026"
      });
      this.#bridge = new FeishuHarnessBridge({
        client: this.#client,
        channel,
        harness: this.#harness,
        state: this.#state,
        status: this.#status,
        allowedSenderOpenIds: new Set(this.#ownerOpenIds),
        replyTimeoutMs: this.#replyTimeoutMs
      });
      const dispatcher = new this.#lark.EventDispatcher({}).register({
        "im.message.receive_v1": (event) => {
          this.#bridge.accept(event);
          return {};
        },
        "im.message.reaction.created_v1": () => ({}),
        "im.message.reaction.deleted_v1": () => ({})
      });
      let settleReady;
      let settleError;
      const ready = new Promise((resolve6, reject) => {
        let settled = false;
        const timer = setTimeout(() => {
          if (settled) return;
          settled = true;
          reject(new Error(`Feishu WebSocket handshake timed out after ${this.#connectTimeoutMs}ms`));
        }, this.#connectTimeoutMs);
        settleReady = () => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve6();
        };
        settleError = (error) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          reject(error);
        };
      });
      this.#wsClient = new this.#lark.WSClient({
        ...larkConfig,
        loggerLevel: this.#lark.LoggerLevel.info,
        handshakeTimeoutMs: 15e3,
        onReady: () => {
          this.#status.feishuLongConnectionState = "connected";
          this.#status.ready = true;
          this.#status.lastError = null;
          settleReady();
        },
        onError: (error) => {
          this.#status.feishuLongConnectionState = "failed";
          this.#status.ready = false;
          this.#status.lastError = error?.message ?? String(error);
          this.#logger.error("[dsh-feishu] Feishu long connection failed:", this.#status.lastError);
          settleError(error);
        },
        onReconnecting: () => {
          this.#status.feishuLongConnectionState = "reconnecting";
          this.#status.ready = false;
        },
        onReconnected: () => {
          this.#status.feishuLongConnectionState = "connected";
          this.#status.ready = true;
          this.#status.lastError = null;
        }
      });
      await this.#wsClient.start({ eventDispatcher: dispatcher }).catch((error) => {
        settleError(error);
      });
      await ready;
      return this.status;
    } catch (error) {
      this.#status.ready = false;
      this.#status.feishuLongConnectionState = "failed";
      this.#status.lastError = error?.message ?? String(error);
      await this.stop({ preserveError: true });
      throw error;
    }
  }
  async stop({ preserveError = false } = {}) {
    const error = preserveError ? this.#status.lastError : null;
    this.#status.ready = false;
    if (this.#wsClient) {
      this.#wsClient.close({ force: true });
      this.#wsClient = null;
    }
    if (this.#bridge) {
      await this.#bridge.waitForIdle();
      this.#bridge = null;
    }
    this.#client = null;
    this.#status.feishuLongConnectionState = preserveError ? "failed" : "idle";
    this.#status.lastError = error;
    return this.status;
  }
};

// src/channels/feishu/harness-client.mjs
import { spawn as spawn2 } from "node:child_process";
import { randomUUID as randomUUID6 } from "node:crypto";
var sleep2 = (ms) => new Promise((resolve6) => setTimeout(resolve6, ms));
function messageText(event) {
  return (event?.data?.message?.content ?? []).filter((part) => part.type === "text" && typeof part.text === "string").map((part) => part.text).join("\n").trim();
}
var HarnessReplyTracker2 = class {
  #promptRpcId;
  #lastSeq;
  #openTurn = null;
  #targetTurn = null;
  #stepText = /* @__PURE__ */ new Map();
  #latestText = "";
  #finished = false;
  #reason = null;
  constructor({ promptRpcId, afterSeq = -1 }) {
    this.#promptRpcId = promptRpcId;
    this.#lastSeq = afterSeq;
  }
  get finished() {
    return this.#finished;
  }
  get answer() {
    return this.#latestText.trim();
  }
  get reason() {
    return this.#reason;
  }
  consume(entries) {
    let update = null;
    const ordered = [...entries].map((entry) => entry?.event ?? entry).filter(Boolean).sort((left, right) => (left.seq ?? -1) - (right.seq ?? -1));
    for (const event of ordered) {
      const seq = event.seq ?? -1;
      if (seq <= this.#lastSeq) continue;
      this.#lastSeq = seq;
      if (event.type === "turn/start") {
        this.#openTurn = event.data?.turn ?? null;
      }
      if (event.type === "user/message" && event.data?.source?.rpcId === this.#promptRpcId) {
        this.#targetTurn = this.#openTurn;
        continue;
      }
      if (this.#targetTurn === null) continue;
      if (event.type === "turn/end") {
        if (event.data?.turn !== this.#targetTurn) continue;
        this.#finished = true;
        this.#reason = event.data?.reason ?? null;
        this.#openTurn = null;
        continue;
      }
      if (event.data?.turn !== this.#targetTurn) continue;
      if (event.type === "assistant/chunk" && event.data?.chunk?.type === "text-delta") {
        const step = event.data?.step ?? 0;
        const index = event.data.chunk.index ?? 0;
        const key = `${step}:${index}`;
        this.#stepText.set(key, (this.#stepText.get(key) ?? "") + event.data.chunk.text);
        const stepPrefix = `${step}:`;
        const text = [...this.#stepText.entries()].filter(([partKey]) => partKey.startsWith(stepPrefix)).sort(([left], [right]) => Number(left.split(":")[1]) - Number(right.split(":")[1])).map(([, part]) => part).join("\n").trim();
        if (text && text !== this.#latestText) {
          this.#latestText = text;
          update = { type: "text", text };
        }
        continue;
      }
      if (event.type === "assistant/message") {
        const text = messageText(event);
        if (text && text !== this.#latestText) {
          this.#latestText = text;
          update = { type: "text", text };
        }
        continue;
      }
      if (event.type === "tool/call") {
        update = { type: "tool", name: event.data?.name ?? "\u5DE5\u5177" };
      } else if (event.type === "tool/result") {
        update = { type: "status", text: "\u6B63\u5728\u6574\u7406\u7ED3\u679C\u2026" };
      }
    }
    return update;
  }
};
var HarnessRpcError2 = class extends Error {
  constructor(method, error) {
    super(`${method}: ${error?.message ?? "unknown Harness RPC error"}`);
    this.name = "HarnessRpcError";
    this.method = method;
    this.code = error?.code ?? "internal";
    this.details = error?.details ?? {};
  }
};
var HarnessClient2 = class {
  #baseUrl;
  #workspace;
  #agentPreset;
  #autostart;
  #dshBin;
  #managedProcess = null;
  constructor({ baseUrl, workspace, agentPreset, autostart, dshBin }) {
    this.#baseUrl = new URL(baseUrl);
    this.#workspace = workspace;
    this.#agentPreset = agentPreset;
    this.#autostart = autostart;
    this.#dshBin = dshBin;
  }
  async rpc(method, payload = {}, timeoutMs = 3e4, options = {}) {
    const rpcId = options.rpcId ?? `feishu-${randomUUID6()}`;
    const response = await fetch(new URL(`/api/${method}`, this.#baseUrl), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: "client-request", rpcId, method, payload }),
      signal: AbortSignal.timeout(timeoutMs)
    });
    if (!response.ok) throw new Error(`Harness transport ${method} failed: HTTP ${response.status}`);
    const body = await response.json();
    if (body?.type !== "server-response" || body?.rpcId !== rpcId) {
      throw new Error(`Harness returned an invalid response for ${method}`);
    }
    if (!body.result?.ok) throw new HarnessRpcError2(method, body.result?.error);
    return body.result.value;
  }
  async health() {
    await this.rpc("host.describe", {}, 5e3);
    return true;
  }
  async ensureRunning() {
    try {
      return await this.health();
    } catch (firstError) {
      if (!this.#autostart) throw firstError;
    }
    if (!this.#managedProcess || this.#managedProcess.exitCode !== null) {
      const port = this.#baseUrl.port || (this.#baseUrl.protocol === "https:" ? "443" : "80");
      this.#managedProcess = spawn2(this.#dshBin, [
        "web",
        "--host",
        this.#baseUrl.hostname,
        "--port",
        port
      ], {
        cwd: this.#workspace,
        env: process.env,
        stdio: ["ignore", "inherit", "inherit"]
      });
      this.#managedProcess.on("error", (error) => {
        console.error("[bridge] failed to start Harness:", error.message);
      });
    }
    const deadline = Date.now() + 6e4;
    let lastError;
    while (Date.now() < deadline) {
      await sleep2(1e3);
      try {
        return await this.health();
      } catch (error) {
        lastError = error;
      }
    }
    throw new Error(`Harness did not become ready: ${lastError?.message ?? "timeout"}`);
  }
  async workspaceId() {
    const { items } = await this.rpc("workspace.list", {});
    const existing = items.find((item) => item.path === this.#workspace);
    if (existing) return existing.workspaceId;
    const created = await this.rpc("workspace.create", { path: this.#workspace });
    return created.workspace.workspaceId;
  }
  async createSession() {
    await this.ensureRunning();
    const workspaceId = await this.workspaceId();
    const created = await this.rpc("session.create", {
      workspaceId,
      agentPreset: this.#agentPreset
    });
    return created.sessionId;
  }
  async sessionExists(sessionId) {
    try {
      await this.rpc("session.history", { sessionId, maxMessages: 1 });
      return true;
    } catch (error) {
      if (error instanceof HarnessRpcError2 && error.code === "session-not-found") return false;
      throw error;
    }
  }
  async ask(sessionId, text, options = {}) {
    if (typeof options === "number") options = { timeoutMs: options };
    const timeoutMs = options.timeoutMs ?? 6e5;
    const onUpdate = typeof options.onUpdate === "function" ? options.onUpdate : null;
    await this.ensureRunning();
    const before = await this.rpc("session.history", { sessionId, maxMessages: 1 });
    const baselineSeq = Math.max(-1, ...(before.events ?? []).map(({ event }) => event.seq ?? -1));
    const promptRpcId = `feishu-${randomUUID6()}`;
    const tracker = new HarnessReplyTracker2({ promptRpcId, afterSeq: baselineSeq });
    await this.rpc("session.prompt", {
      sessionId,
      mode: "queue",
      content: [{ type: "text", text }],
      clientTimeZone: Intl.DateTimeFormat().resolvedOptions().timeZone
    }, 3e4, { rpcId: promptRpcId });
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      await sleep2(300);
      const history = await this.rpc("session.history", { sessionId, maxMessages: 50 });
      const update = tracker.consume(history.events ?? []);
      if (update && onUpdate) {
        try {
          await onUpdate(update);
        } catch (error) {
          console.warn("[bridge] ignored a progress update failure:", error.message);
        }
      }
      if (!tracker.finished) continue;
      if (tracker.answer) return tracker.answer;
      throw new Error(`Harness turn ended without a text reply${tracker.reason ? ` (${JSON.stringify(tracker.reason)})` : ""}`);
    }
    throw new Error(`Harness reply timed out after ${Math.round(timeoutMs / 1e3)} seconds`);
  }
  stopManagedProcess() {
    if (this.#managedProcess?.exitCode === null) this.#managedProcess.kill("SIGTERM");
  }
};

// src/channels/feishu/plugin-config-store.mjs
import { createHash as createHash2 } from "node:crypto";
import { mkdir as mkdir3, readFile as readFile3, rename as rename3, unlink as unlink4, writeFile as writeFile3 } from "node:fs/promises";
import { dirname as dirname3 } from "node:path";
var LEGACY_FEISHU_SECRET_REF = "DSH_FEISHU_APP_SECRET";
function cleanString4(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}
function safeId(value) {
  const id = cleanString4(value);
  return id && /^[A-Za-z0-9_-]{1,128}$/.test(id) ? id : null;
}
function legacyBotId(appId) {
  return `bot_${createHash2("sha256").update(appId).digest("hex").slice(0, 24)}`;
}
function normalizeOwners(value) {
  const candidates = Array.isArray(value.ownerOpenIds) ? value.ownerOpenIds : [value.ownerOpenId];
  return [...new Set(candidates.map(cleanString4).filter(Boolean))];
}
function normalizeBot2(value, { legacy = false } = {}) {
  if (!value || typeof value !== "object") return null;
  const appId = cleanString4(value.appId);
  const ownerOpenIds = normalizeOwners(value);
  if (!appId || ownerOpenIds.length === 0) return null;
  const id = safeId(value.id) ?? (legacy ? legacyBotId(appId) : null);
  const secretRef = cleanString4(value.secretRef) ?? (legacy ? LEGACY_FEISHU_SECRET_REF : null);
  if (!id || !secretRef) return null;
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(secretRef)) return null;
  const domain = value.domain === "lark" ? "lark" : "feishu";
  return Object.freeze({
    id,
    appId,
    secretRef,
    ownerOpenIds: Object.freeze(ownerOpenIds),
    domain,
    botName: cleanString4(value.botName),
    botOpenId: cleanString4(value.botOpenId),
    activated: value.activated ?? null,
    deletionPending: value.deletionPending === true,
    connectedAt: cleanString4(value.connectedAt),
    createdAt: cleanString4(value.createdAt) ?? cleanString4(value.connectedAt)
  });
}
function normalizeDocument2(value) {
  if (!value || typeof value !== "object") return null;
  if (value.version === 2 && Array.isArray(value.bots)) {
    const bots = value.bots.map((bot) => normalizeBot2(bot));
    if (bots.some((bot) => bot === null)) {
      throw new Error("dsh-feishu config contains an invalid bot entry");
    }
    const ids = /* @__PURE__ */ new Set();
    const refs = /* @__PURE__ */ new Set();
    const appIds = /* @__PURE__ */ new Set();
    for (const bot of bots) {
      if (ids.has(bot.id) || refs.has(bot.secretRef) || appIds.has(bot.appId)) {
        throw new Error("dsh-feishu config contains duplicate bot identities");
      }
      ids.add(bot.id);
      refs.add(bot.secretRef);
      appIds.add(bot.appId);
    }
    return { value: Object.freeze({ version: 2, bots: Object.freeze(bots) }), migrated: false };
  }
  const legacyBot = normalizeBot2(value, { legacy: true });
  if (!legacyBot) return null;
  return {
    value: Object.freeze({ version: 2, bots: Object.freeze([legacyBot]) }),
    migrated: true
  };
}
var PluginConfigStore = class {
  #path;
  #value = Object.freeze({ version: 2, bots: Object.freeze([]) });
  #writeQueue = Promise.resolve();
  constructor(path) {
    this.#path = path;
  }
  async load() {
    try {
      const parsed = JSON.parse(await readFile3(this.#path, "utf8"));
      const normalized = normalizeDocument2(parsed);
      if (!normalized) throw new Error("dsh-feishu config is incomplete or invalid");
      this.#value = normalized.value;
      if (normalized.migrated) await this.#writeDocument(this.#value);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
      this.#value = Object.freeze({ version: 2, bots: Object.freeze([]) });
    }
    return this;
  }
  /** Backward-compatible single-bot view used by the original controller. */
  get() {
    const bot = this.#value.bots[0];
    if (!bot) return null;
    const result = structuredClone(bot);
    result.ownerOpenId = result.ownerOpenIds[0];
    return result;
  }
  list() {
    return structuredClone(this.#value.bots);
  }
  getBot(id) {
    const bot = this.#value.bots.find((candidate) => candidate.id === id);
    return bot ? structuredClone(bot) : null;
  }
  /** Backward-compatible save replaces the original single-bot view. */
  async save(value) {
    const fallback = { ...value };
    if (!fallback.id) fallback.id = legacyBotId(cleanString4(fallback.appId) ?? "invalid");
    if (!fallback.secretRef) fallback.secretRef = LEGACY_FEISHU_SECRET_REF;
    const normalized = normalizeBot2(fallback);
    if (!normalized) throw new Error("Refusing to persist incomplete dsh-feishu configuration");
    await this.#replaceBots([normalized]);
    return this.get();
  }
  async saveBot(value) {
    const normalized = normalizeBot2(value);
    if (!normalized) throw new Error("Refusing to persist incomplete dsh-feishu bot configuration");
    return this.#mutate((bots) => {
      const collision = bots.find((bot) => bot.secretRef === normalized.secretRef && bot.id !== normalized.id);
      if (collision) throw new Error("Refusing to share a credential reference between Feishu bots");
      const appCollision = bots.find((bot) => bot.appId === normalized.appId && bot.id !== normalized.id);
      if (appCollision) throw new Error("Refusing to persist the same Feishu app twice");
      const index = bots.findIndex((bot) => bot.id === normalized.id);
      if (index === -1) bots.push(normalized);
      else bots[index] = normalized;
      return structuredClone(normalized);
    });
  }
  async removeBot(id) {
    if (!safeId(id)) throw new TypeError("Invalid Feishu bot id");
    return this.#mutate((bots) => {
      const index = bots.findIndex((bot) => bot.id === id);
      if (index === -1) return null;
      const [removed] = bots.splice(index, 1);
      return structuredClone(removed);
    });
  }
  async clear() {
    const operation = this.#writeQueue.then(async () => {
      try {
        await unlink4(this.#path);
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
      }
      this.#value = Object.freeze({ version: 2, bots: Object.freeze([]) });
    });
    this.#writeQueue = operation.then(() => void 0, () => void 0);
    await operation;
  }
  async #replaceBots(bots) {
    const document = Object.freeze({ version: 2, bots: Object.freeze([...bots]) });
    const operation = this.#writeQueue.then(async () => {
      await this.#writeDocument(document);
      this.#value = document;
    });
    this.#writeQueue = operation.then(() => void 0, () => void 0);
    await operation;
  }
  async #mutate(mutator) {
    let result;
    const operation = this.#writeQueue.then(async () => {
      const bots = [...this.#value.bots];
      result = mutator(bots);
      const document = Object.freeze({ version: 2, bots: Object.freeze(bots) });
      await this.#writeDocument(document);
      this.#value = document;
    });
    this.#writeQueue = operation.then(() => void 0, () => void 0);
    await operation;
    return result;
  }
  async #writeDocument(document) {
    await mkdir3(dirname3(this.#path), { recursive: true, mode: 448 });
    const temporary = `${this.#path}.tmp`;
    await writeFile3(temporary, `${JSON.stringify(document, null, 2)}
`, { encoding: "utf8", mode: 384 });
    await rename3(temporary, this.#path);
  }
};

// src/channels/feishu/multi-bot-controller.mjs
import { randomUUID as randomUUID7 } from "node:crypto";

// src/channels/feishu/registration-manager.mjs
var ACTIVE_STATES = /* @__PURE__ */ new Set([
  "starting",
  "qr_ready",
  "polling",
  "slow_down",
  "domain_switched",
  "saving"
]);
var SDK_POLLING_STATES = /* @__PURE__ */ new Set([
  "polling",
  "slow_down",
  "domain_switched"
]);
var REGISTRATION_STATES = Object.freeze({
  IDLE: "idle",
  STARTING: "starting",
  QR_READY: "qr_ready",
  POLLING: "polling",
  SLOW_DOWN: "slow_down",
  DOMAIN_SWITCHED: "domain_switched",
  SAVING: "saving",
  SUCCEEDED: "succeeded",
  EXPIRED: "expired",
  CANCELLED: "cancelled",
  ERROR: "error"
});
function errorCode(error) {
  if (["access_denied", "expired_token", "abort"].includes(error?.code)) return error.code;
  return "registration_failed";
}
function publicError(error) {
  const code = errorCode(error);
  const messages = {
    access_denied: "Registration was denied.",
    abort: "Registration was cancelled.",
    expired_token: "The registration QR code expired."
  };
  return {
    code,
    message: messages[code] ?? "Unable to register the Feishu app."
  };
}
function expirySeconds(value) {
  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds <= 0) {
    throw new TypeError("registerApp onQRCodeReady returned an invalid expireIn");
  }
  return seconds;
}
function copyUserInfo(userInfo) {
  if (userInfo === void 0) return void 0;
  if (userInfo === null || typeof userInfo !== "object" || Array.isArray(userInfo)) {
    throw new TypeError("registerApp returned invalid user_info");
  }
  return { ...userInfo };
}
var RegistrationManager = class {
  #registerApp;
  #onCredentials;
  #now;
  #setTimeout;
  #clearTimeout;
  #attempt = 0;
  #active = null;
  #snapshot;
  constructor({
    registerApp,
    onCredentials,
    now = Date.now,
    setTimeout: setTimeoutFn = globalThis.setTimeout,
    clearTimeout: clearTimeoutFn = globalThis.clearTimeout
  } = {}) {
    if (typeof registerApp !== "function") {
      throw new TypeError("RegistrationManager requires a registerApp function");
    }
    if (typeof onCredentials !== "function") {
      throw new TypeError("RegistrationManager requires an onCredentials function");
    }
    if (typeof now !== "function" || typeof setTimeoutFn !== "function" || typeof clearTimeoutFn !== "function") {
      throw new TypeError("RegistrationManager clock dependencies must be functions");
    }
    this.#registerApp = registerApp;
    this.#onCredentials = onCredentials;
    this.#now = now;
    this.#setTimeout = setTimeoutFn;
    this.#clearTimeout = clearTimeoutFn;
    this.#snapshot = this.#makeSnapshot(null, REGISTRATION_STATES.IDLE);
  }
  start(registerOptions = {}) {
    if (registerOptions === null || typeof registerOptions !== "object" || Array.isArray(registerOptions)) {
      throw new TypeError("Registration options must be an object");
    }
    this.#supersedeActiveAttempt();
    const run = {
      id: ++this.#attempt,
      controller: new AbortController(),
      qrCodeUrl: null,
      expiresAt: null,
      pollIntervalSeconds: null,
      expiryTimer: null
    };
    this.#active = run;
    this.#snapshot = this.#makeSnapshot(run, REGISTRATION_STATES.STARTING);
    const options = {
      ...registerOptions,
      signal: run.controller.signal,
      onQRCodeReady: (info) => this.#onQRCodeReady(run, info),
      onStatusChange: (info) => this.#onStatusChange(run, info)
    };
    const registration = Promise.resolve().then(() => this.#registerApp(options));
    void registration.then(
      (result) => this.#onRegistrationSucceeded(run, result),
      (error) => this.#onRegistrationFailed(run, error)
    );
    return this.status();
  }
  status() {
    this.#expireIfNeeded();
    const snapshot = { ...this.#snapshot };
    if (snapshot.error) snapshot.error = { ...snapshot.error };
    const run = this.#active;
    if (run && run.expiresAt !== null && ACTIVE_STATES.has(snapshot.state)) {
      snapshot.remainingSeconds = Math.max(0, Math.ceil((run.expiresAt - this.#now()) / 1e3));
    }
    return snapshot;
  }
  cancel() {
    const run = this.#active;
    if (!run) return this.status();
    this.#finishRun(run, REGISTRATION_STATES.CANCELLED, {
      error: {
        code: "abort",
        message: "Registration was cancelled."
      }
    });
    run.controller.abort();
    return this.status();
  }
  #isCurrent(run) {
    return this.#active === run;
  }
  #makeSnapshot(run, state, extra = {}) {
    const snapshot = {
      state,
      attempt: run?.id ?? this.#attempt,
      updatedAt: this.#now(),
      ...extra
    };
    if (run?.qrCodeUrl && ACTIVE_STATES.has(state)) {
      snapshot.qrCodeUrl = run.qrCodeUrl;
      snapshot.expiresAt = run.expiresAt;
    }
    if (run?.pollIntervalSeconds !== null && ACTIVE_STATES.has(state)) {
      snapshot.pollIntervalSeconds = run.pollIntervalSeconds;
    }
    return snapshot;
  }
  #setRunState(run, state, extra = {}) {
    if (!this.#isCurrent(run)) return;
    this.#snapshot = this.#makeSnapshot(run, state, extra);
  }
  #onQRCodeReady(run, info) {
    if (!this.#isCurrent(run)) return;
    if (typeof info?.url !== "string" || !info.url) {
      throw new TypeError("registerApp onQRCodeReady returned an invalid URL");
    }
    const seconds = expirySeconds(info.expireIn);
    run.qrCodeUrl = info.url;
    run.expiresAt = this.#now() + seconds * 1e3;
    this.#clearExpiryTimer(run);
    run.expiryTimer = this.#setTimeout(() => this.#expireRun(run), seconds * 1e3);
    run.expiryTimer?.unref?.();
    this.#setRunState(run, REGISTRATION_STATES.QR_READY);
  }
  #onStatusChange(run, info) {
    if (!this.#isCurrent(run) || !SDK_POLLING_STATES.has(info?.status)) return;
    if (info.status === REGISTRATION_STATES.SLOW_DOWN && Number.isFinite(Number(info.interval))) {
      run.pollIntervalSeconds = Number(info.interval);
    }
    this.#setRunState(run, info.status);
  }
  async #onRegistrationSucceeded(run, result) {
    if (!this.#isCurrent(run)) return;
    const clientId = result?.client_id;
    const clientSecret = result?.client_secret;
    if (typeof clientId !== "string" || !clientId || typeof clientSecret !== "string" || !clientSecret) {
      this.#finishRun(run, REGISTRATION_STATES.ERROR, {
        error: {
          code: "invalid_credentials",
          message: "Feishu registration returned invalid credentials."
        }
      });
      return;
    }
    let userInfo;
    try {
      userInfo = copyUserInfo(result.user_info);
    } catch {
      this.#finishRun(run, REGISTRATION_STATES.ERROR, {
        error: {
          code: "invalid_credentials",
          message: "Feishu registration returned invalid credentials."
        }
      });
      return;
    }
    this.#clearExpiryTimer(run);
    run.qrCodeUrl = null;
    run.expiresAt = null;
    run.pollIntervalSeconds = null;
    this.#setRunState(run, REGISTRATION_STATES.SAVING);
    try {
      await this.#onCredentials({
        client_id: clientId,
        client_secret: clientSecret,
        user_info: userInfo
      });
    } catch {
      if (this.#isCurrent(run)) {
        this.#finishRun(run, REGISTRATION_STATES.ERROR, {
          error: {
            code: "credentials_callback_failed",
            message: "Unable to store the Feishu credentials."
          }
        });
      }
      return;
    }
    if (this.#isCurrent(run)) {
      this.#finishRun(run, REGISTRATION_STATES.SUCCEEDED);
    }
  }
  #onRegistrationFailed(run, error) {
    if (!this.#isCurrent(run)) return;
    const code = errorCode(error);
    if (code === "expired_token") {
      this.#finishRun(run, REGISTRATION_STATES.EXPIRED, {
        error: publicError(error)
      });
      return;
    }
    if (code === "abort") {
      this.#finishRun(run, REGISTRATION_STATES.CANCELLED, {
        error: publicError(error)
      });
      return;
    }
    this.#finishRun(run, REGISTRATION_STATES.ERROR, {
      error: publicError(error)
    });
  }
  #expireIfNeeded() {
    const run = this.#active;
    if (run && run.expiresAt !== null && this.#now() >= run.expiresAt) {
      this.#expireRun(run);
    }
  }
  #expireRun(run) {
    if (!this.#isCurrent(run)) return;
    this.#finishRun(run, REGISTRATION_STATES.EXPIRED, {
      error: {
        code: "expired_token",
        message: "The registration QR code expired."
      }
    });
    run.controller.abort();
  }
  #finishRun(run, state, extra = {}) {
    if (!this.#isCurrent(run)) return;
    this.#clearExpiryTimer(run);
    this.#snapshot = this.#makeSnapshot(run, state, extra);
    this.#active = null;
  }
  #clearExpiryTimer(run) {
    if (run.expiryTimer !== null) {
      this.#clearTimeout(run.expiryTimer);
      run.expiryTimer = null;
    }
  }
  #supersedeActiveAttempt() {
    const previous = this.#active;
    if (!previous) return;
    this.#clearExpiryTimer(previous);
    this.#active = null;
    previous.controller.abort();
  }
};

// src/channels/feishu/plugin-controller.mjs
var REQUIRED_TENANT_SCOPES = Object.freeze([
  "im:message.p2p_msg:readonly",
  "im:message.group_at_msg:readonly",
  "im:message:send_as_bot",
  "im:message.reactions:write_only",
  "im:message:recall",
  "cardkit:card:write"
]);

// src/channels/feishu/multi-bot-controller.mjs
var ACTIVE_REGISTRATION_STATES2 = /* @__PURE__ */ new Set([
  "starting",
  "qr_ready",
  "polling",
  "slow_down",
  "domain_switched"
]);
var MUTABLE_REGISTRATION_STATES = /* @__PURE__ */ new Set([...ACTIVE_REGISTRATION_STATES2, "saving"]);
function idleConnection() {
  return {
    ready: false,
    feishuLongConnectionState: "idle",
    harnessReachable: false
  };
}
function connectionStatus(runtime) {
  return runtime ? runtime.status : idleConnection();
}
function isConnected2(connection) {
  return connection.ready === true && connection.feishuLongConnectionState === "connected" && connection.harnessReachable === true;
}
function maskedAppId(appId) {
  return appId.length > 12 ? `${appId.slice(0, 8)}\u2022\u2022\u2022\u2022${appId.slice(-4)}` : "cli_\u2022\u2022\u2022\u2022";
}
function publicBot(config) {
  return {
    name: config.botName,
    appIdMasked: maskedAppId(config.appId),
    activated: config.activated,
    domain: config.domain
  };
}
function botPhase({ connected, error, connection }) {
  if (connected) return "connected";
  if (error || connection.feishuLongConnectionState === "failed") return "error";
  return "disconnected";
}
function makeBotId() {
  return `bot_${randomUUID7().replaceAll("-", "")}`;
}
function makeRegistrationId() {
  return `reg_${randomUUID7().replaceAll("-", "")}`;
}
function secretRefFor(botId) {
  return `DSH_FEISHU_APP_SECRET_${botId.slice(4).toUpperCase()}`;
}
var MultiBotDshFeishuController = class {
  #registerApp;
  #verifyApp;
  #credentials;
  #configStore;
  #createRuntime;
  #deleteState;
  #createBotId;
  #createRegistrationId;
  #runtimes = /* @__PURE__ */ new Map();
  #botErrors = /* @__PURE__ */ new Map();
  #registrations = /* @__PURE__ */ new Map();
  #botOwnership = /* @__PURE__ */ new Map();
  #latestRegistrationId = null;
  #configTransition = Promise.resolve();
  #botTransitions = /* @__PURE__ */ new Map();
  #revision = 1;
  #closed = false;
  constructor({
    registerApp,
    verifyApp,
    credentials,
    configStore,
    createRuntime,
    deleteState = async () => {
    },
    createBotId = makeBotId,
    createRegistrationId = makeRegistrationId
  }) {
    if (typeof registerApp !== "function") throw new Error("registerApp is required");
    if (typeof verifyApp !== "function") throw new Error("verifyApp is required");
    if (!credentials) throw new Error("credentials service is required");
    if (!configStore || typeof configStore.list !== "function") {
      throw new Error("multi-bot config store is required");
    }
    if (typeof createRuntime !== "function") throw new Error("createRuntime is required");
    if (typeof deleteState !== "function") throw new Error("deleteState must be a function");
    this.#registerApp = registerApp;
    this.#verifyApp = verifyApp;
    this.#credentials = credentials;
    this.#configStore = configStore;
    this.#createRuntime = createRuntime;
    this.#deleteState = deleteState;
    this.#createBotId = createBotId;
    this.#createRegistrationId = createRegistrationId;
  }
  async initialize() {
    if (this.#closed) return this.status();
    const bots = this.#configStore.list();
    let attempted = false;
    await Promise.allSettled(bots.map((config) => this.#withBotTransition(config.id, async () => {
      const current = connectionStatus(this.#runtimes.get(config.id));
      if (isConnected2(current) || current.feishuLongConnectionState === "connecting" || current.feishuLongConnectionState === "reconnecting") {
        return;
      }
      attempted = true;
      if (config.deletionPending) {
        this.#botErrors.set(config.id, {
          code: "deletion_pending",
          message: "\u673A\u5668\u4EBA\u6B63\u5728\u7B49\u5F85\u5B8C\u6210\u672C\u5730\u5220\u9664\uFF0C\u8BF7\u91CD\u8BD5\u79FB\u9664\u3002"
        });
        return;
      }
      let resolved;
      try {
        resolved = await this.#credentials.resolve(config.secretRef);
      } catch {
        this.#botErrors.set(config.id, {
          code: "missing_credentials",
          message: "\u65E0\u6CD5\u8BFB\u53D6\u673A\u5668\u4EBA\u51ED\u636E\uFF0C\u8BF7\u68C0\u67E5\u51ED\u636E\u5B58\u50A8\u3002"
        });
        return;
      }
      if (!resolved?.value) {
        this.#botErrors.set(config.id, {
          code: "missing_credentials",
          message: "\u673A\u5668\u4EBA\u51ED\u636E\u7F3A\u5931\uFF0C\u8BF7\u5220\u9664\u540E\u91CD\u65B0\u626B\u7801\u63A5\u5165\u3002"
        });
        return;
      }
      try {
        await this.#startRuntime(config, resolved.value);
        this.#botErrors.delete(config.id);
      } catch {
        this.#botErrors.set(config.id, {
          code: "connection_failed",
          message: "\u673A\u5668\u4EBA\u6682\u65F6\u65E0\u6CD5\u8FDE\u63A5\u98DE\u4E66\uFF0C\u8BF7\u91CD\u8BD5\u3002"
        });
      }
    })));
    if (attempted) this.#touch();
    return this.status();
  }
  startRegistration() {
    this.#assertOpen();
    const id = this.#createRegistrationId();
    if (typeof id !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(id) || this.#registrations.has(id)) {
      throw new Error("Registration id generator returned an invalid or duplicate id");
    }
    const record = { id, manager: null, botId: null, createdNew: false, cancelled: false };
    record.manager = new RegistrationManager({
      registerApp: this.#registerApp,
      onCredentials: (result) => this.#serializeConfig(() => this.#acceptCredentials(record, result))
    });
    this.#registrations.set(id, record);
    this.#latestRegistrationId = id;
    this.#trimRegistrations();
    record.manager.start({
      source: "deepseek-harness",
      createOnly: true,
      appPreset: {
        name: "{user} \u7684\u5317\u6C47\u661F\u6CB3 AI \u52A9\u624B",
        desc: "\u8FDE\u63A5\u98DE\u4E66\u4E0E DeepSeek Harness\uFF0C\u5728\u804A\u5929\u4E2D\u4F7F\u7528\u4F01\u4E1A AI \u52A9\u624B\u3002"
      },
      addons: {
        preset: false,
        scopes: { tenant: [...REQUIRED_TENANT_SCOPES] },
        events: { items: { tenant: ["im.message.receive_v1"] } }
      }
    });
    this.#touch();
    return this.registrationStatus(id);
  }
  hasRegistration(attemptId) {
    return this.#registrations.has(attemptId);
  }
  registrationStatus(attemptId) {
    const record = this.#registrations.get(attemptId);
    if (!record) return null;
    return this.#status({ registration: record, selectedBotId: record.botId });
  }
  async cancelRegistration(attemptId = this.#latestRegistrationId) {
    const record = this.#registrations.get(attemptId);
    if (!record) return this.status();
    if (!MUTABLE_REGISTRATION_STATES.has(record.manager.status().state)) {
      return this.registrationStatus(attemptId);
    }
    record.cancelled = true;
    record.manager.cancel();
    await this.#serializeConfig(async () => {
      if (record.createdNew && record.botId && this.#botOwnership.get(record.botId) === record.id && this.#configStore.getBot(record.botId)) {
        await this.#withBotTransition(record.botId, () => this.#deleteBot(record.botId));
      }
    });
    this.#touch();
    return this.registrationStatus(attemptId) ?? this.status();
  }
  status(botId) {
    return this.#status({
      registration: this.#registrations.get(this.#latestRegistrationId) ?? null,
      selectedBotId: botId
    });
  }
  async reconnectBot(botId) {
    this.#assertOpen();
    return this.#withBotTransition(botId, async () => {
      const config = this.#requireBot(botId);
      if (config.deletionPending) {
        this.#botErrors.set(botId, {
          code: "deletion_pending",
          message: "\u673A\u5668\u4EBA\u6B63\u5728\u7B49\u5F85\u5B8C\u6210\u672C\u5730\u5220\u9664\uFF0C\u8BF7\u91CD\u8BD5\u79FB\u9664\u3002"
        });
        return this.status(botId);
      }
      if (isConnected2(connectionStatus(this.#runtimes.get(botId)))) {
        return this.status(botId);
      }
      let resolved;
      try {
        resolved = await this.#credentials.resolve(config.secretRef);
      } catch {
        resolved = null;
      }
      if (!resolved?.value) {
        this.#botErrors.set(botId, {
          code: "missing_credentials",
          message: "\u673A\u5668\u4EBA\u51ED\u636E\u7F3A\u5931\uFF0C\u8BF7\u5220\u9664\u540E\u91CD\u65B0\u626B\u7801\u63A5\u5165\u3002"
        });
        this.#touch();
        return this.status(botId);
      }
      try {
        await this.#startRuntime(config, resolved.value);
        this.#botErrors.delete(botId);
      } catch {
        this.#botErrors.set(botId, {
          code: "connection_failed",
          message: "\u673A\u5668\u4EBA\u6682\u65F6\u65E0\u6CD5\u8FDE\u63A5\u98DE\u4E66\uFF0C\u8BF7\u91CD\u8BD5\u3002"
        });
      }
      this.#touch();
      return this.status(botId);
    });
  }
  async disconnectBot(botId) {
    this.#assertOpen();
    return this.#withBotTransition(botId, async () => {
      this.#requireBot(botId);
      await this.#stopRuntime(botId);
      this.#botErrors.delete(botId);
      this.#touch();
      return this.status(botId);
    });
  }
  async deleteBot(botId) {
    this.#assertOpen();
    return this.#serializeConfig(() => this.#withBotTransition(botId, async () => {
      this.#requireBot(botId);
      await this.#deleteBot(botId);
      this.#touch();
      return this.status();
    }));
  }
  // Compatibility methods for the original one-bot browser contract.
  async reconnect() {
    const bot = this.#configStore.list()[0];
    return bot ? this.reconnectBot(bot.id) : this.status();
  }
  async disconnect() {
    const bot = this.#configStore.list()[0];
    return bot ? this.deleteBot(bot.id) : this.status();
  }
  async close() {
    if (this.#closed) return;
    this.#closed = true;
    for (const record of this.#registrations.values()) {
      if (MUTABLE_REGISTRATION_STATES.has(record.manager.status().state)) {
        record.cancelled = true;
        record.manager.cancel();
      }
    }
    await this.#configTransition;
    await Promise.allSettled([...this.#botTransitions.values()]);
    await Promise.allSettled([...this.#runtimes.keys()].map((id) => this.#stopRuntime(id)));
  }
  #status({ registration, selectedBotId } = {}) {
    const bots = this.#configStore.list().map((config) => {
      const connection = connectionStatus(this.#runtimes.get(config.id));
      const connected = isConnected2(connection);
      const error = this.#botErrors.get(config.id) ?? null;
      return {
        botId: config.id,
        phase: botPhase({ connected, error, connection }),
        connected,
        configured: true,
        bot: publicBot(config),
        connection,
        error
      };
    });
    const registrationSnapshot = registration ? this.#registrationSnapshot(registration) : {
      state: "idle",
      attempt: 0,
      updatedAt: Date.now()
    };
    const registering = ACTIVE_REGISTRATION_STATES2.has(registrationSnapshot.state);
    const connecting = registrationSnapshot.state === "saving";
    const registrationOwnsProjection = Boolean(registration) && (registering || connecting);
    const selected = bots.find((bot) => bot.botId === selectedBotId) ?? (registrationOwnsProjection ? null : bots[0] ?? null);
    const aggregateConnected = bots.some((bot) => bot.connected);
    let phase = selected?.phase ?? "unconfigured";
    if (registering) phase = "registering";
    else if (connecting) phase = "connecting";
    else if (registrationSnapshot.state === "error" && !selected) phase = "error";
    return {
      schemaVersion: 2,
      revision: this.#revision,
      phase,
      connected: selected?.connected ?? false,
      configured: bots.length > 0,
      bot: selected?.bot ?? null,
      connection: selected?.connection ?? idleConnection(),
      error: selected?.error ?? registrationSnapshot.error ?? null,
      registration: registrationSnapshot,
      bots,
      totals: {
        configured: bots.length,
        connected: bots.filter((bot) => bot.connected).length
      },
      anyConnected: aggregateConnected
    };
  }
  #registrationSnapshot(record) {
    const snapshot = record.manager.status();
    return {
      ...snapshot,
      attempt: record.id,
      ...record.botId ? { botId: record.botId } : {}
    };
  }
  async #acceptCredentials(record, result) {
    if (record.cancelled) throw new Error("Registration was cancelled");
    const appId = result.client_id;
    const appSecret = result.client_secret;
    const ownerOpenId = result.user_info?.open_id;
    const domain = result.user_info?.tenant_brand === "lark" ? "lark" : "feishu";
    if (!ownerOpenId) throw new Error("Feishu registration returned no owner open_id");
    const bot = await this.#verifyApp({ appId, appSecret, domain });
    if (record.cancelled) throw new Error("Registration was cancelled");
    const existing = this.#configStore.list().find((candidate) => candidate.appId === appId);
    const botId = existing?.id ?? this.#createBotId();
    if (typeof botId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(botId) || !existing && this.#configStore.getBot(botId)) {
      throw new Error("Bot id generator returned an invalid or duplicate id");
    }
    const secretRef = existing?.secretRef ?? secretRefFor(botId);
    const previousOwnership = this.#botOwnership.get(botId);
    const previousSecret = await this.#credentials.resolve(secretRef).catch(() => void 0);
    await this.#credentials.set(secretRef, appSecret);
    let config;
    try {
      config = await this.#configStore.saveBot({
        ...existing,
        id: botId,
        appId,
        secretRef,
        ownerOpenIds: [.../* @__PURE__ */ new Set([...existing?.ownerOpenIds ?? [], ownerOpenId])],
        domain,
        botName: bot.name,
        botOpenId: bot.openId,
        activated: bot.activated,
        deletionPending: false,
        connectedAt: (/* @__PURE__ */ new Date()).toISOString(),
        createdAt: existing?.createdAt ?? (/* @__PURE__ */ new Date()).toISOString()
      });
      record.botId = botId;
      record.createdNew = !existing;
      this.#botOwnership.set(botId, record.id);
    } catch (error) {
      try {
        await this.#restoreCredential(secretRef, previousSecret);
      } catch (restoreError) {
        throw new Error("Unable to restore the Feishu credential after a config failure.", {
          cause: restoreError
        });
      }
      throw error;
    }
    if (record.cancelled) {
      if (record.createdNew) {
        await this.#withBotTransition(botId, () => this.#deleteBot(botId));
      } else {
        await this.#configStore.saveBot(existing);
        await this.#restoreCredential(secretRef, previousSecret);
        if (previousOwnership) this.#botOwnership.set(botId, previousOwnership);
        else this.#botOwnership.delete(botId);
      }
      throw new Error("Registration was cancelled");
    }
    let cancellationRolledBack = false;
    try {
      await this.#withBotTransition(botId, () => this.#startRuntime(config, appSecret));
      if (record.cancelled) {
        if (record.createdNew) {
          await this.#withBotTransition(botId, () => this.#deleteBot(botId));
        } else {
          await this.#configStore.saveBot(existing);
          await this.#restoreCredential(secretRef, previousSecret);
          if (previousOwnership) this.#botOwnership.set(botId, previousOwnership);
          else this.#botOwnership.delete(botId);
          if (previousSecret?.value && !existing.deletionPending) {
            await this.#withBotTransition(botId, () => this.#startRuntime(existing, previousSecret.value));
          } else {
            await this.#withBotTransition(botId, () => this.#stopRuntime(botId));
          }
        }
        cancellationRolledBack = true;
        throw new Error("Registration was cancelled");
      }
      this.#botErrors.delete(botId);
      this.#touch();
    } catch (error) {
      if (record.cancelled) {
        if (!cancellationRolledBack && record.createdNew && this.#configStore.getBot(botId)) {
          await this.#withBotTransition(botId, () => this.#deleteBot(botId));
        } else if (!cancellationRolledBack && existing) {
          await this.#configStore.saveBot(existing);
          await this.#restoreCredential(secretRef, previousSecret);
          if (previousOwnership) this.#botOwnership.set(botId, previousOwnership);
          else this.#botOwnership.delete(botId);
          if (!this.#closed && previousSecret?.value && !existing.deletionPending) {
            await this.#withBotTransition(botId, () => this.#startRuntime(existing, previousSecret.value));
          } else {
            await this.#withBotTransition(botId, () => this.#stopRuntime(botId));
          }
        }
        this.#touch();
        throw error;
      }
      if (existing && previousSecret?.value) {
        try {
          await this.#configStore.saveBot(existing);
          await this.#restoreCredential(secretRef, previousSecret);
          if (previousOwnership) this.#botOwnership.set(botId, previousOwnership);
          else this.#botOwnership.delete(botId);
          if (!existing.deletionPending) {
            await this.#withBotTransition(botId, () => this.#startRuntime(existing, previousSecret.value));
            this.#botErrors.delete(botId);
          } else {
            await this.#withBotTransition(botId, () => this.#stopRuntime(botId));
            this.#botErrors.set(botId, {
              code: "deletion_pending",
              message: "\u673A\u5668\u4EBA\u6B63\u5728\u7B49\u5F85\u5B8C\u6210\u672C\u5730\u5220\u9664\uFF0C\u8BF7\u91CD\u8BD5\u79FB\u9664\u3002"
            });
          }
          this.#touch();
          throw error;
        } catch (restoreError) {
          if (restoreError === error) throw error;
          this.#botErrors.set(botId, {
            code: "connection_failed",
            message: "\u673A\u5668\u4EBA\u8FDE\u63A5\u66F4\u65B0\u5931\u8D25\uFF0C\u4E14\u539F\u8FDE\u63A5\u65E0\u6CD5\u6062\u590D\uFF0C\u8BF7\u91CD\u8BD5\u3002"
          });
          this.#touch();
          throw new Error("Unable to restore the previous Feishu bot connection.", {
            cause: restoreError
          });
        }
      }
      this.#botErrors.set(botId, {
        code: "connection_failed",
        message: "\u673A\u5668\u4EBA\u5DF2\u7ECF\u521B\u5EFA\uFF0C\u4F46\u957F\u8FDE\u63A5\u672A\u5C31\u7EEA\uFF0C\u8BF7\u70B9\u51FB\u91CD\u8BD5\u3002"
      });
      this.#touch();
      throw error;
    }
  }
  async #startRuntime(config, appSecret) {
    await this.#stopRuntime(config.id);
    const runtime = await this.#createRuntime({
      botId: config.id,
      config,
      appSecret
    });
    this.#runtimes.set(config.id, runtime);
    try {
      await runtime.start();
    } catch (error) {
      if (this.#runtimes.get(config.id) === runtime) this.#runtimes.delete(config.id);
      await runtime.stop({ preserveError: true }).catch(() => void 0);
      throw error;
    }
  }
  async #stopRuntime(botId) {
    const runtime = this.#runtimes.get(botId);
    this.#runtimes.delete(botId);
    if (runtime) await runtime.stop();
  }
  async #deleteBot(botId) {
    let config = this.#configStore.getBot(botId);
    if (!config) return;
    if (!config.deletionPending) {
      config = await this.#configStore.saveBot({ ...config, deletionPending: true });
    }
    await this.#stopRuntime(botId);
    try {
      await this.#credentials.unset(config.secretRef);
    } catch (error) {
      this.#botErrors.set(botId, {
        code: "credential_removal_failed",
        message: "\u65E0\u6CD5\u5220\u9664\u673A\u5668\u4EBA\u51ED\u636E\uFF0C\u8BF7\u7A0D\u540E\u91CD\u8BD5\u3002"
      });
      throw new Error("Unable to remove the Feishu credential.", { cause: error });
    }
    try {
      await this.#deleteState({ botId, config });
    } catch (error) {
      this.#botErrors.set(botId, {
        code: "state_cleanup_failed",
        message: "\u65E0\u6CD5\u5220\u9664\u673A\u5668\u4EBA\u7684\u672C\u5730\u4F1A\u8BDD\u6570\u636E\uFF0C\u8BF7\u7A0D\u540E\u91CD\u8BD5\u3002"
      });
      throw new Error("Unable to remove the Feishu bot session state.", { cause: error });
    }
    await this.#configStore.removeBot(botId);
    this.#botErrors.delete(botId);
    this.#botOwnership.delete(botId);
  }
  async #restoreCredential(secretRef, previous) {
    if (previous?.value) await this.#credentials.set(secretRef, previous.value);
    else await this.#credentials.unset(secretRef);
  }
  #requireBot(botId) {
    const config = this.#configStore.getBot(botId);
    if (!config) throw new Error("Unknown Feishu bot");
    return config;
  }
  #assertOpen() {
    if (this.#closed) throw new Error("The Feishu controller is closed");
  }
  #serializeConfig(operation) {
    const result = this.#configTransition.then(operation, operation);
    this.#configTransition = result.then(() => void 0, () => void 0);
    return result;
  }
  #withBotTransition(botId, operation) {
    const previous = this.#botTransitions.get(botId) ?? Promise.resolve();
    const result = previous.then(operation, operation);
    const tail = result.then(() => void 0, () => void 0);
    this.#botTransitions.set(botId, tail);
    void tail.finally(() => {
      if (this.#botTransitions.get(botId) === tail) this.#botTransitions.delete(botId);
    });
    return result;
  }
  #trimRegistrations() {
    if (this.#registrations.size <= 32) return;
    for (const [id, record] of this.#registrations) {
      if (id === this.#latestRegistrationId) continue;
      const state = record.manager.status().state;
      if (!ACTIVE_REGISTRATION_STATES2.has(state) && state !== "saving") {
        this.#registrations.delete(id);
      }
      if (this.#registrations.size <= 32) break;
    }
  }
  #touch() {
    this.#revision += 1;
  }
};

// src/channels/feishu/state-store.mjs
import { mkdir as mkdir4, readFile as readFile4, rename as rename4, writeFile as writeFile4 } from "node:fs/promises";
import { dirname as dirname4 } from "node:path";
var EMPTY_STATE2 = Object.freeze({ version: 1, sessions: {}, seenMessageIds: [] });
var StateStore = class {
  #path;
  #state = structuredClone(EMPTY_STATE2);
  #writeQueue = Promise.resolve();
  constructor(path) {
    this.#path = path;
  }
  async load() {
    try {
      const parsed = JSON.parse(await readFile4(this.#path, "utf8"));
      this.#state = {
        version: 1,
        sessions: parsed.sessions && typeof parsed.sessions === "object" ? parsed.sessions : {},
        seenMessageIds: Array.isArray(parsed.seenMessageIds) ? parsed.seenMessageIds.slice(-1e3) : []
      };
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
      await this.#persist();
    }
    return this;
  }
  sessionFor(key) {
    return this.#state.sessions[key] ?? null;
  }
  async setSession(key, sessionId) {
    this.#state.sessions[key] = sessionId;
    await this.#persist();
  }
  async clearSession(key) {
    delete this.#state.sessions[key];
    await this.#persist();
  }
  hasSeen(messageId) {
    return this.#state.seenMessageIds.includes(messageId);
  }
  async markSeen(messageId) {
    if (this.hasSeen(messageId)) return;
    this.#state.seenMessageIds.push(messageId);
    if (this.#state.seenMessageIds.length > 1e3) {
      this.#state.seenMessageIds.splice(0, this.#state.seenMessageIds.length - 1e3);
    }
    await this.#persist();
  }
  snapshot() {
    return structuredClone(this.#state);
  }
  async #persist() {
    const snapshot = JSON.stringify(this.#state, null, 2) + "\n";
    this.#writeQueue = this.#writeQueue.then(async () => {
      await mkdir4(dirname4(this.#path), { recursive: true, mode: 448 });
      const temporary = `${this.#path}.tmp`;
      await writeFile4(temporary, snapshot, { encoding: "utf8", mode: 384 });
      await rename4(temporary, this.#path);
    });
    await this.#writeQueue;
  }
};

// plugin-src/host/channels/feishu/production.mjs
function harnessOrigin2(webServer, configured) {
  if (configured !== void 0) return new URL(configured);
  const port = webServer?.port;
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("dsh-feishu requires an initialized DSH webServer port");
  }
  return new URL(`http://127.0.0.1:${port}`);
}
function pluginPaths2(config) {
  const dshHome = resolve2(config.dshHome ?? process.env.DSH_HOME ?? join2(homedir2(), ".dsh"));
  const root = resolve2(config.dataDir ?? join2(dshHome, "integrations", "dsh-feishu"));
  return {
    root,
    config: resolve2(config.configPath ?? join2(root, "config.json")),
    legacyState: resolve2(config.statePath ?? join2(root, "state.json")),
    bots: resolve2(config.botsDir ?? join2(root, "bots"))
  };
}
async function createProductionController2(ctx, config = {}, internals = {}) {
  if (!ctx?.credentials) throw new TypeError("dsh-feishu requires ctx.credentials");
  if (!ctx?.webServer) throw new TypeError("dsh-feishu requires ctx.webServer");
  const lark = internals.lark ?? Lark;
  const Controller = internals.Controller ?? MultiBotDshFeishuController;
  const ConfigStore = internals.ConfigStore ?? PluginConfigStore;
  const SessionStateStore = internals.StateStore ?? StateStore;
  const Harness = internals.HarnessClient ?? HarnessClient2;
  const Runtime = internals.FeishuRuntime ?? FeishuRuntime;
  const verifyApp = internals.verifyFeishuApp ?? verifyFeishuApp;
  const createSupervisor = internals.createConnectionSupervisor ?? createConnectionSupervisor2;
  const logger = typeof ctx.logger === "function" ? ctx.logger("dsh-feishu") : ctx.logger ?? console;
  const paths = pluginPaths2(config);
  const configStore = await new ConfigStore(paths.config).load();
  const stateStores = /* @__PURE__ */ new Map();
  const statePathFor = (botConfig) => !botConfig.id || !botConfig.secretRef || botConfig.secretRef === LEGACY_FEISHU_SECRET_REF ? paths.legacyState : resolve2(paths.bots, botConfig.id, "state.json");
  const stateFor = async (botConfig) => {
    const stateKey = botConfig.id ?? "__legacy__";
    let state = stateStores.get(stateKey);
    if (!state) {
      state = await new SessionStateStore(statePathFor(botConfig)).load();
      stateStores.set(stateKey, state);
    }
    return state;
  };
  const harness = new Harness({
    baseUrl: harnessOrigin2(ctx.webServer, config.harnessBaseUrl),
    workspace: resolve2(config.workspace ?? process.cwd()),
    agentPreset: config.agentPreset ?? "standard",
    // This plugin is already hosted by a running DSH process. Starting a
    // second DSH would create a competing server and lifecycle.
    autostart: false,
    dshBin: config.dshBin ?? "dsh"
  });
  const controller = new Controller({
    registerApp: (options) => lark.registerApp(options),
    verifyApp,
    credentials: ctx.credentials,
    configStore,
    createRuntime: async ({ botId, config: botConfig, appSecret }) => {
      const state = await stateFor(botConfig);
      return new Runtime({
        lark,
        appId: botConfig.appId,
        appSecret,
        domain: botConfig.domain,
        ownerOpenIds: botConfig.ownerOpenIds ?? [botConfig.ownerOpenId],
        harness,
        state,
        replyTimeoutMs: config.replyTimeoutMs ?? 6e5,
        logger: {
          error: (...args) => logger.error?.(`[${botId ?? botConfig.id}]`, ...args),
          warn: (...args) => logger.warn?.(`[${botId ?? botConfig.id}]`, ...args),
          info: (...args) => logger.info?.(`[${botId ?? botConfig.id}]`, ...args),
          debug: (...args) => logger.debug?.(`[${botId ?? botConfig.id}]`, ...args)
        }
      });
    },
    deleteState: async ({ botId, config: botConfig }) => {
      stateStores.delete(botId);
      try {
        await unlink5(statePathFor(botConfig));
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
      }
    }
  });
  const supervisor = createSupervisor({
    controller,
    harness,
    logger,
    retryDelaysMs: config.retryDelaysMs,
    healthyIntervalMs: config.healthyIntervalMs
  }).start();
  return {
    controller,
    ready: supervisor.ready,
    async close() {
      await supervisor.close();
      await controller.close();
      harness.stopManagedProcess();
    }
  };
}

// plugin-src/host/channels/feishu/rpc.mjs
import QRCode2 from "qrcode";

// plugin-src/client/channels/feishu/api.js
var FEISHU_RPC_CHANNEL = "/feishu";
var FEISHU_ENDPOINTS = Object.freeze({
  status: "connection.status",
  beginProvisioning: "provision.begin",
  pollProvisioning: "provision.poll",
  cancelProvisioning: "provision.cancel",
  reconnectBot: "bot.reconnect",
  disconnectBot: "bot.disconnect",
  deleteBot: "bot.delete",
  // Kept for rolling upgrades. The multi-bot UI never calls these endpoints.
  testConnection: "connection.test",
  disconnect: "connection.disconnect"
});

// plugin-src/host/channels/feishu/rpc.mjs
var FEISHU_MULTI_ENDPOINTS = Object.freeze({
  reconnectBot: "bot.reconnect",
  disconnectBot: "bot.disconnect",
  deleteBot: "bot.delete"
});
var FEISHU_RPC_ENDPOINTS = Object.freeze([
  .../* @__PURE__ */ new Set([...Object.values(FEISHU_ENDPOINTS), ...Object.values(FEISHU_MULTI_ENDPOINTS)])
]);
var REGISTRATION_STATES2 = /* @__PURE__ */ new Set([
  "idle",
  "starting",
  "qr_ready",
  "polling",
  "slow_down",
  "domain_switched",
  "saving",
  "succeeded",
  "expired",
  "cancelled",
  "error"
]);
var SAFE_ID = /^[A-Za-z0-9_-]{1,128}$/;
var PUBLIC_ERROR_MESSAGES = Object.freeze({
  abort: "Registration was cancelled.",
  access_denied: "Registration was denied.",
  expired_token: "The registration QR code expired.",
  invalid_credentials: "Feishu returned invalid app credentials.",
  credentials_callback_failed: "Unable to activate the Feishu connection.",
  registration_failed: "Unable to register the Feishu app.",
  connection_failed: "The bot was created, but its connection could not be started.",
  credential_removal_failed: "Unable to remove the Feishu credentials.",
  state_cleanup_failed: "Unable to remove the bot session data. Please retry.",
  deletion_pending: "Bot deletion is incomplete. Retry removal to finish cleanup.",
  missing_credentials: "The bot credentials are missing. Delete it and scan again."
});
var POLL_STATUS_BY_REGISTRATION = Object.freeze({
  idle: "pending",
  starting: "pending",
  qr_ready: "pending",
  polling: "pending",
  slow_down: "pending",
  domain_switched: "pending",
  saving: "connecting",
  succeeded: "connected",
  expired: "expired",
  cancelled: "failed",
  error: "failed"
});
function isPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
function hasOnlyKeys(value, allowed) {
  return isPlainObject(value) && Reflect.ownKeys(value).every((key) => typeof key === "string" && allowed.has(key));
}
function finiteNumber(value) {
  return Number.isFinite(value) ? value : void 0;
}
function safeOpaqueId(value) {
  return typeof value === "string" && SAFE_ID.test(value);
}
function publicError2(error) {
  if (!error || typeof error !== "object") return null;
  const code = typeof error.code === "string" && Object.hasOwn(PUBLIC_ERROR_MESSAGES, error.code) ? error.code : "registration_failed";
  return { code, message: PUBLIC_ERROR_MESSAGES[code] };
}
function publicRegistration(registration) {
  if (!registration || typeof registration !== "object") return { state: "idle", attempt: 0 };
  const state = REGISTRATION_STATES2.has(registration.state) ? registration.state : "error";
  const attempt = safeOpaqueId(registration.attempt) ? registration.attempt : finiteNumber(registration.attempt) ?? 0;
  const result = { state, attempt };
  const updatedAt = finiteNumber(registration.updatedAt);
  const expiresAt = finiteNumber(registration.expiresAt);
  const remainingSeconds = finiteNumber(registration.remainingSeconds);
  const pollIntervalSeconds = finiteNumber(registration.pollIntervalSeconds);
  if (updatedAt !== void 0) result.updatedAt = updatedAt;
  if (typeof registration.qrCodeUrl === "string" && registration.qrCodeUrl.length > 0) {
    result.qrCodeUrl = registration.qrCodeUrl;
  }
  if (expiresAt !== void 0) result.expiresAt = expiresAt;
  if (remainingSeconds !== void 0) result.remainingSeconds = remainingSeconds;
  if (pollIntervalSeconds !== void 0) result.pollIntervalSeconds = pollIntervalSeconds;
  if (safeOpaqueId(registration.botId)) result.botId = registration.botId;
  const error = publicError2(registration.error);
  if (error) result.error = error;
  return result;
}
function connectionFacts(connection) {
  const source = connection && typeof connection === "object" ? connection : {};
  const connected = source.connected === true || source.ready === true && source.feishuLongConnectionState === "connected" && source.harnessReachable === true;
  return {
    connected,
    ready: source.ready === true,
    harnessReachable: source.harnessReachable === true
  };
}
function publicBot2(bot) {
  const source = bot && typeof bot === "object" ? bot : {};
  const result = {
    name: typeof source.name === "string" && source.name.length > 0 ? source.name : "\u98DE\u4E66\u673A\u5668\u4EBA"
  };
  if (typeof source.avatarUrl === "string") result.avatarUrl = source.avatarUrl;
  if (typeof source.appIdMasked === "string") result.appIdMasked = source.appIdMasked;
  if (typeof source.tenantName === "string") result.tenantName = source.tenantName;
  if (source.domain === "feishu" || source.domain === "lark") result.domain = source.domain;
  if (typeof source.activated === "boolean" || typeof source.activated === "number") {
    result.activated = source.activated;
  }
  return result;
}
function publicHealth(status, connected) {
  if (connected) return { status: "healthy", summary: "\u957F\u8FDE\u63A5\u8FD0\u884C\u6B63\u5E38", lastCheckedAt: Date.now() };
  if (status?.configured === true) {
    return { status: "offline", summary: "\u673A\u5668\u4EBA\u5C1A\u672A\u8FDE\u63A5", lastCheckedAt: Date.now() };
  }
  return { status: "offline", summary: "\u5C1A\u672A\u63A5\u5165\u98DE\u4E66\u673A\u5668\u4EBA", lastCheckedAt: Date.now() };
}
function connectionState(status, registration, connected) {
  if (connected) return "connected";
  if (status?.phase === "error" || registration.state === "error") return "error";
  if (status?.phase === "connecting" || registration.state === "saving") return "connecting";
  if (status?.phase === "registering" || ["starting", "qr_ready", "polling", "slow_down", "domain_switched"].includes(registration.state)) {
    return "provisioning";
  }
  return "disconnected";
}
async function qrCodeDataUrl(verificationUrl) {
  return QRCode2.toDataURL(verificationUrl, {
    errorCorrectionLevel: "M",
    margin: 1,
    width: 320,
    type: "image/png"
  });
}
async function publicProvisioning(registration, encodeQr) {
  if (!registration.qrCodeUrl) return void 0;
  return {
    attemptId: String(registration.attempt),
    verificationUrl: registration.qrCodeUrl,
    qrCodeDataUrl: await encodeQr(registration.qrCodeUrl),
    expiresAt: registration.expiresAt ?? Date.now() + 5 * 6e4,
    pollIntervalMs: Math.max(800, Math.min(1e4, (registration.pollIntervalSeconds ?? 1.8) * 1e3))
  };
}
function publicBotEntry(entry) {
  const source = entry && typeof entry === "object" ? entry : {};
  if (!safeOpaqueId(source.botId)) return null;
  const facts = connectionFacts(source.connection);
  const connected = source.connected === true || facts.connected;
  const registration = { state: "idle" };
  const result = {
    botId: source.botId,
    state: connectionState(source, registration, connected),
    connected,
    configured: source.configured === true,
    bot: publicBot2(source.bot),
    health: publicHealth(source, connected)
  };
  const error = publicError2(source.error);
  if (error) result.error = error;
  return result;
}
async function toPublicFeishuStatus(status, { encodeQr = qrCodeDataUrl } = {}) {
  const source = status && typeof status === "object" ? status : {};
  const registration = publicRegistration(source.registration);
  const facts = connectionFacts(source.connection);
  const connected = source.connected === true || facts.connected;
  const provisioning = await publicProvisioning(registration, encodeQr);
  const error = publicError2(source.error) ?? registration.error ?? null;
  const bots = Array.isArray(source.bots) ? source.bots.map(publicBotEntry).filter(Boolean) : [];
  const snapshot = {
    schemaVersion: source.schemaVersion === 2 ? 2 : 1,
    revision: Number.isSafeInteger(source.revision) && source.revision >= 0 ? source.revision : 0,
    state: connectionState(source, registration, connected),
    connected,
    configured: source.configured === true,
    bot: publicBot2(source.bot),
    health: publicHealth(source, connected),
    bots,
    totals: {
      configured: bots.length || (source.configured === true ? 1 : 0),
      connected: bots.length ? bots.filter((bot) => bot.connected).length : connected ? 1 : 0
    }
  };
  if (provisioning) snapshot.provisioning = provisioning;
  if (error) snapshot.error = error;
  return snapshot;
}
function badRequest2(message) {
  return { ok: false, error: { code: "bad-request", message, details: { issues: [] } } };
}
function cancelled2() {
  return { ok: false, error: { code: "cancelled", message: "The Feishu request was cancelled.", details: {} } };
}
function internalFailure2() {
  return { ok: false, error: { code: "internal", message: "The Feishu integration operation failed.", details: {} } };
}
function validPayload(endpoint, payload) {
  if (endpoint === FEISHU_ENDPOINTS.status) {
    return hasOnlyKeys(payload, /* @__PURE__ */ new Set()) ? null : "This endpoint accepts an empty payload only.";
  }
  if (endpoint === FEISHU_ENDPOINTS.testConnection) {
    return hasOnlyKeys(payload, /* @__PURE__ */ new Set()) ? null : "This endpoint accepts an empty payload only.";
  }
  if (endpoint === FEISHU_ENDPOINTS.beginProvisioning) {
    if (!hasOnlyKeys(payload, /* @__PURE__ */ new Set(["locale", "replaceAttemptId"]))) {
      return "Provisioning accepts locale and replaceAttemptId only.";
    }
    if (payload.locale !== void 0 && payload.locale !== "zh-CN") return "The provisioning locale must be zh-CN.";
    if (payload.replaceAttemptId !== void 0 && !safeOpaqueId(payload.replaceAttemptId)) {
      return "replaceAttemptId must be a valid opaque id.";
    }
    return null;
  }
  if (endpoint === FEISHU_ENDPOINTS.pollProvisioning || endpoint === FEISHU_ENDPOINTS.cancelProvisioning) {
    return hasOnlyKeys(payload, /* @__PURE__ */ new Set(["attemptId"])) && safeOpaqueId(payload.attemptId) ? null : "A single valid attemptId is required.";
  }
  if (endpoint === FEISHU_ENDPOINTS.disconnect) {
    return hasOnlyKeys(payload, /* @__PURE__ */ new Set(["removeCredentials"])) && payload.removeCredentials === true ? null : "Disconnect requires removeCredentials=true.";
  }
  if (endpoint === FEISHU_MULTI_ENDPOINTS.reconnectBot || endpoint === FEISHU_MULTI_ENDPOINTS.disconnectBot) {
    return hasOnlyKeys(payload, /* @__PURE__ */ new Set(["botId"])) && safeOpaqueId(payload.botId) ? null : "A single valid botId is required.";
  }
  if (endpoint === FEISHU_MULTI_ENDPOINTS.deleteBot) {
    return hasOnlyKeys(payload, /* @__PURE__ */ new Set(["botId", "confirm"])) && safeOpaqueId(payload.botId) && payload.confirm === true ? null : "Deleting a bot requires a valid botId and confirm=true.";
  }
  return "Unknown Feishu endpoint.";
}
function abortableDelay2(milliseconds, signal) {
  return new Promise((resolve6, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new Error("aborted"));
      return;
    }
    const timer = setTimeout(done, milliseconds);
    timer.unref?.();
    function done() {
      signal?.removeEventListener("abort", aborted);
      resolve6();
    }
    function aborted() {
      clearTimeout(timer);
      reject(signal.reason ?? new Error("aborted"));
    }
    signal?.addEventListener("abort", aborted, { once: true });
  });
}
async function statusForRegistration(controller, attemptId) {
  if (typeof controller.registrationStatus === "function") {
    return controller.registrationStatus(attemptId);
  }
  return controller.status();
}
async function waitForQr(controller, initial, attemptId, signal) {
  let current = initial;
  const deadline = Date.now() + 15e3;
  for (; ; ) {
    const registration = publicRegistration(current?.registration);
    if (registration.qrCodeUrl) return current;
    if (["error", "expired", "cancelled"].includes(registration.state)) {
      throw new Error("Provisioning stopped before the QR code was ready.");
    }
    if (Date.now() >= deadline) throw new Error("Provisioning QR code timed out.");
    await abortableDelay2(50, signal);
    current = await statusForRegistration(controller, attemptId);
    if (!current) throw new Error("The provisioning attempt is no longer active.");
  }
}
function sameAttempt(status, attemptId) {
  return String(publicRegistration(status?.registration).attempt) === attemptId;
}
function pollStatus(status) {
  const registration = publicRegistration(status?.registration);
  if (registration.state === "succeeded") {
    const connected = registration.botId && (status?.connected === true || connectionFacts(status?.connection).connected);
    return connected ? "connected" : "connecting";
  }
  return POLL_STATUS_BY_REGISTRATION[registration.state] ?? "failed";
}
function assertController2(controller) {
  if (!controller || typeof controller.status !== "function" || typeof controller.startRegistration !== "function" || typeof controller.cancelRegistration !== "function" || typeof controller.disconnect !== "function") {
    throw new TypeError("A Feishu controller with status/start/cancel/disconnect is required");
  }
}
function createFeishuRpcHandler(controller, { encodeQr = qrCodeDataUrl } = {}) {
  assertController2(controller);
  const qrCache = /* @__PURE__ */ new Map();
  const attemptQr = /* @__PURE__ */ new Map();
  const cachedEncodeQr = (url) => {
    let encoded = qrCache.get(url);
    if (!encoded) {
      if (qrCache.size >= 32) qrCache.delete(qrCache.keys().next().value);
      encoded = Promise.resolve().then(() => encodeQr(url));
      qrCache.set(url, encoded);
    }
    return encoded;
  };
  return async (endpoint, payload, signal) => {
    if (signal?.aborted) return cancelled2();
    if (!FEISHU_RPC_ENDPOINTS.includes(endpoint)) return badRequest2("Unknown Feishu endpoint.");
    const payloadFailure5 = validPayload(endpoint, payload);
    if (payloadFailure5) return badRequest2(payloadFailure5);
    try {
      let value;
      if (endpoint === FEISHU_ENDPOINTS.status) {
        value = await toPublicFeishuStatus(await controller.status(), { encodeQr: cachedEncodeQr });
      } else if (endpoint === FEISHU_ENDPOINTS.beginProvisioning) {
        if (payload.replaceAttemptId) {
          await controller.cancelRegistration(payload.replaceAttemptId);
        }
        const started = await controller.startRegistration({ locale: payload.locale });
        const attemptId = String(publicRegistration(started?.registration).attempt);
        const ready = await waitForQr(controller, started, attemptId, signal);
        value = (await toPublicFeishuStatus(ready, { encodeQr: cachedEncodeQr })).provisioning;
        if (!value) throw new Error("Provisioning did not produce a QR code.");
        attemptQr.set(attemptId, value.verificationUrl);
      } else if (endpoint === FEISHU_ENDPOINTS.pollProvisioning) {
        const current = await statusForRegistration(controller, payload.attemptId);
        if (!current || !sameAttempt(current, payload.attemptId)) {
          return badRequest2("The provisioning attempt is no longer active.");
        }
        const registration = publicRegistration(current.registration);
        const connection = await toPublicFeishuStatus(current, { encodeQr: cachedEncodeQr });
        value = {
          status: pollStatus(current),
          ...registration.botId ? { botId: registration.botId } : {},
          ...connection.provisioning ? { provisioning: connection.provisioning } : {},
          ...registration.botId && connection.connected ? { connection } : {},
          ...connection.error ? { message: connection.error.message } : {}
        };
        if (["connected", "expired", "failed"].includes(value.status)) {
          const url = attemptQr.get(payload.attemptId);
          if (url) qrCache.delete(url);
          attemptQr.delete(payload.attemptId);
        }
      } else if (endpoint === FEISHU_ENDPOINTS.cancelProvisioning) {
        const current = await statusForRegistration(controller, payload.attemptId);
        if (!current || !sameAttempt(current, payload.attemptId)) {
          return badRequest2("The provisioning attempt is no longer active.");
        }
        const multi = typeof controller.registrationStatus === "function";
        const registration = publicRegistration(current.registration);
        if (!multi && registration.state === "saving") await controller.disconnect();
        else await controller.cancelRegistration(payload.attemptId);
        const url = attemptQr.get(payload.attemptId);
        if (url) qrCache.delete(url);
        attemptQr.delete(payload.attemptId);
        value = { status: "failed", message: "Registration was cancelled." };
      } else if (endpoint === FEISHU_ENDPOINTS.testConnection) {
        const current = await controller.status();
        const alreadyConnected = current?.connected === true || connectionFacts(current?.connection).connected;
        const checked = alreadyConnected || typeof controller.reconnect !== "function" ? current : await controller.reconnect();
        value = await toPublicFeishuStatus(checked, { encodeQr: cachedEncodeQr });
      } else if (endpoint === FEISHU_ENDPOINTS.disconnect) {
        value = await toPublicFeishuStatus(await controller.disconnect(), { encodeQr: cachedEncodeQr });
      } else if (endpoint === FEISHU_MULTI_ENDPOINTS.reconnectBot) {
        if (typeof controller.reconnectBot !== "function") throw new Error("Multi-bot reconnect is unavailable");
        value = await toPublicFeishuStatus(await controller.reconnectBot(payload.botId), { encodeQr: cachedEncodeQr });
      } else if (endpoint === FEISHU_MULTI_ENDPOINTS.disconnectBot) {
        if (typeof controller.disconnectBot !== "function") throw new Error("Multi-bot disconnect is unavailable");
        value = await toPublicFeishuStatus(await controller.disconnectBot(payload.botId), { encodeQr: cachedEncodeQr });
      } else {
        if (typeof controller.deleteBot !== "function") throw new Error("Multi-bot delete is unavailable");
        value = await toPublicFeishuStatus(await controller.deleteBot(payload.botId), { encodeQr: cachedEncodeQr });
      }
      if (signal?.aborted) return cancelled2();
      return { ok: true, value };
    } catch {
      return signal?.aborted ? cancelled2() : internalFailure2();
    }
  };
}
function installFeishuRpc(ctx, controller, options) {
  if (!ctx?.connection?.rpc || typeof ctx.connection.rpc.handle !== "function") {
    throw new TypeError("DSH Host Connection RPC is required");
  }
  return ctx.connection.rpc.handle(
    FEISHU_RPC_CHANNEL,
    createFeishuRpcHandler(controller, options),
    { authority: "loopback" }
  );
}

// plugin-src/host/channels/feishu/index.mjs
function controllerFrom(ctx, config) {
  if (config?.controller) return config.controller;
  if (typeof config?.createController === "function") return config.createController();
  if (typeof config?.createProvisioningManager === "function") {
    return createProvisioningBackedController(config);
  }
  return void 0;
}
async function apply2(ctx, config = {}) {
  const controller = controllerFrom(ctx, config);
  if (controller) return installFeishuRpc(ctx, controller);
  const production = await createProductionController2(ctx, config);
  const disposeRpc = installFeishuRpc(ctx, production.controller);
  ctx.effect(() => async () => {
    await production.close();
  }, "dsh-feishu: close controller and live connection");
  return disposeRpc;
}

// plugin-src/host/channels/qq/production.mjs
import { unlink as unlink8 } from "node:fs/promises";
import { homedir as homedir3 } from "node:os";
import { join as join3, resolve as resolve3 } from "node:path";

// src/channels/qq/config-store.mjs
import { createHash as createHash3 } from "node:crypto";
import { mkdir as mkdir5, readFile as readFile5, rename as rename5, unlink as unlink6, writeFile as writeFile5 } from "node:fs/promises";
import { dirname as dirname5 } from "node:path";
var EMPTY_DOCUMENT2 = Object.freeze({ version: 1, bots: Object.freeze([]) });
function cleanString5(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}
function safeBotId2(value) {
  const id = cleanString5(value);
  return id && /^qq_[a-f0-9]{24}$/.test(id) ? id : null;
}
function safeSecretRef2(value) {
  const ref = cleanString5(value);
  return ref && /^DSH_QQBOT_APP_SECRET_[A-F0-9]{24}$/.test(ref) ? ref : null;
}
function deriveQqBotIdentity(appId) {
  const raw = cleanString5(appId);
  if (!raw) throw new TypeError("appId is required");
  const digest2 = createHash3("sha256").update(raw).digest("hex").slice(0, 24);
  return {
    botId: `qq_${digest2}`,
    secretRef: `DSH_QQBOT_APP_SECRET_${digest2.toUpperCase()}`
  };
}
function maskQqAppId(appId) {
  const value = cleanString5(appId) ?? "";
  if (value.length <= 10) return value ? `${value.slice(0, 3)}\u2022\u2022\u2022` : "QQ\u673A\u5668\u4EBA";
  return `${value.slice(0, 6)}\u2022\u2022\u2022\u2022${value.slice(-4)}`;
}
function normalizeBot3(value) {
  if (!value || typeof value !== "object") return null;
  const appId = cleanString5(value.appId);
  const ownerUserOpenid = cleanString5(value.ownerUserOpenid);
  const botId = safeBotId2(value.botId);
  const secretRef = safeSecretRef2(value.secretRef);
  if (!appId || !ownerUserOpenid || !botId || !secretRef) return null;
  const derived = deriveQqBotIdentity(appId);
  if (derived.botId !== botId || derived.secretRef !== secretRef) return null;
  return Object.freeze({
    botId,
    appId,
    secretRef,
    ownerUserOpenid,
    createdAt: cleanString5(value.createdAt) ?? (/* @__PURE__ */ new Date()).toISOString(),
    connectedAt: cleanString5(value.connectedAt)
  });
}
function normalizeDocument3(value) {
  if (!value || value.version !== 1 || !Array.isArray(value.bots)) return null;
  const bots = value.bots.map(normalizeBot3);
  if (bots.some((bot) => bot === null)) return null;
  const ids = /* @__PURE__ */ new Set();
  const appIds = /* @__PURE__ */ new Set();
  const refs = /* @__PURE__ */ new Set();
  for (const bot of bots) {
    if (ids.has(bot.botId) || appIds.has(bot.appId) || refs.has(bot.secretRef)) return null;
    ids.add(bot.botId);
    appIds.add(bot.appId);
    refs.add(bot.secretRef);
  }
  return Object.freeze({ version: 1, bots: Object.freeze(bots) });
}
var QqConfigStore = class {
  #path;
  #value = EMPTY_DOCUMENT2;
  #writeQueue = Promise.resolve();
  constructor(path) {
    this.#path = path;
  }
  async load() {
    try {
      const normalized = normalizeDocument3(JSON.parse(await readFile5(this.#path, "utf8")));
      if (!normalized) throw new Error("dsh-im QQ config contains invalid bot data");
      this.#value = normalized;
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
      this.#value = EMPTY_DOCUMENT2;
    }
    return this;
  }
  list() {
    return structuredClone(this.#value.bots);
  }
  get(botId) {
    const bot = this.#value.bots.find((candidate) => candidate.botId === botId);
    return bot ? structuredClone(bot) : null;
  }
  getByAppId(appId) {
    const bot = this.#value.bots.find((candidate) => candidate.appId === appId);
    return bot ? structuredClone(bot) : null;
  }
  async save(value) {
    const normalized = normalizeBot3(value);
    if (!normalized) throw new Error("Refusing to persist incomplete QQ bot data");
    return this.#mutate((bots) => {
      const appCollision = bots.find(
        (bot) => bot.appId === normalized.appId && bot.botId !== normalized.botId
      );
      const refCollision = bots.find(
        (bot) => bot.secretRef === normalized.secretRef && bot.botId !== normalized.botId
      );
      if (appCollision || refCollision) throw new Error("Duplicate QQ bot identity");
      const index = bots.findIndex((bot) => bot.botId === normalized.botId);
      if (index === -1) bots.push(normalized);
      else bots[index] = normalized;
      return structuredClone(normalized);
    });
  }
  async remove(botId) {
    if (!safeBotId2(botId)) throw new TypeError("Invalid QQ bot id");
    return this.#mutate((bots) => {
      const index = bots.findIndex((bot) => bot.botId === botId);
      if (index === -1) return null;
      const [removed] = bots.splice(index, 1);
      return structuredClone(removed);
    });
  }
  async clear() {
    const operation = this.#writeQueue.then(async () => {
      try {
        await unlink6(this.#path);
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
      }
      this.#value = EMPTY_DOCUMENT2;
    });
    this.#writeQueue = operation.then(() => void 0, () => void 0);
    await operation;
  }
  async #mutate(mutator) {
    let result;
    const operation = this.#writeQueue.then(async () => {
      const bots = [...this.#value.bots];
      result = mutator(bots);
      const document = Object.freeze({ version: 1, bots: Object.freeze(bots) });
      await this.#write(document);
      this.#value = document;
    });
    this.#writeQueue = operation.then(() => void 0, () => void 0);
    await operation;
    return result;
  }
  async #write(document) {
    await mkdir5(dirname5(this.#path), { recursive: true, mode: 448 });
    const temporary = `${this.#path}.tmp`;
    await writeFile5(temporary, `${JSON.stringify(document, null, 2)}
`, {
      encoding: "utf8",
      mode: 384
    });
    await rename5(temporary, this.#path);
  }
};

// src/channels/weixin/harness-client.mjs
import { spawn as spawn3 } from "node:child_process";
import { randomUUID as randomUUID8 } from "node:crypto";
var sleep3 = (ms) => new Promise((resolve6) => setTimeout(resolve6, ms));
function assistantMessageText2(event) {
  return (event?.data?.message?.content ?? []).filter((part) => part.type === "text" && typeof part.text === "string").map((part) => part.text).join("\n").trim();
}
var HarnessReplyTracker3 = class {
  #promptRpcId;
  #lastSeq;
  #openTurn = null;
  #targetTurn = null;
  #stepText = /* @__PURE__ */ new Map();
  #latestText = "";
  #finished = false;
  #reason = null;
  constructor({ promptRpcId, afterSeq = -1 }) {
    this.#promptRpcId = promptRpcId;
    this.#lastSeq = afterSeq;
  }
  get finished() {
    return this.#finished;
  }
  get answer() {
    return this.#latestText.trim();
  }
  get reason() {
    return this.#reason;
  }
  consume(entries) {
    let update = null;
    const ordered = [...entries].map((entry) => entry?.event ?? entry).filter(Boolean).sort((left, right) => (left.seq ?? -1) - (right.seq ?? -1));
    for (const event of ordered) {
      const seq = event.seq ?? -1;
      if (seq <= this.#lastSeq) continue;
      this.#lastSeq = seq;
      if (event.type === "turn/start") this.#openTurn = event.data?.turn ?? null;
      if (event.type === "user/message" && event.data?.source?.rpcId === this.#promptRpcId) {
        this.#targetTurn = this.#openTurn;
        continue;
      }
      if (this.#targetTurn === null) continue;
      if (event.type === "turn/end") {
        if (event.data?.turn !== this.#targetTurn) continue;
        this.#finished = true;
        this.#reason = event.data?.reason ?? null;
        this.#openTurn = null;
        continue;
      }
      if (event.data?.turn !== this.#targetTurn) continue;
      if (event.type === "assistant/chunk" && event.data?.chunk?.type === "text-delta") {
        const step = event.data?.step ?? 0;
        const index = event.data.chunk.index ?? 0;
        const key = `${step}:${index}`;
        this.#stepText.set(key, (this.#stepText.get(key) ?? "") + event.data.chunk.text);
        const prefix = `${step}:`;
        const text = [...this.#stepText.entries()].filter(([partKey]) => partKey.startsWith(prefix)).sort(([left], [right]) => Number(left.split(":")[1]) - Number(right.split(":")[1])).map(([, part]) => part).join("\n").trim();
        if (text && text !== this.#latestText) {
          this.#latestText = text;
          update = { type: "text", text };
        }
        continue;
      }
      if (event.type === "assistant/message") {
        const text = assistantMessageText2(event);
        if (text && text !== this.#latestText) {
          this.#latestText = text;
          update = { type: "text", text };
        }
        continue;
      }
      if (event.type === "tool/call") {
        update = { type: "tool", name: event.data?.name ?? "\u5DE5\u5177" };
      } else if (event.type === "tool/result") {
        update = { type: "status", text: "\u6B63\u5728\u6574\u7406\u7ED3\u679C\u2026" };
      }
    }
    return update;
  }
};
var HarnessRpcError3 = class extends Error {
  constructor(method, error) {
    super(`${method}: ${error?.message ?? "unknown Harness RPC error"}`);
    this.name = "HarnessRpcError";
    this.method = method;
    this.code = error?.code ?? "internal";
    this.details = error?.details ?? {};
  }
};
var HarnessClient3 = class {
  #baseUrl;
  #workspace;
  #agentPreset;
  #autostart;
  #dshBin;
  #managedProcess = null;
  constructor({ baseUrl, workspace, agentPreset = "standard", autostart = false, dshBin = "dsh" }) {
    this.#baseUrl = new URL(baseUrl);
    this.#workspace = workspace;
    this.#agentPreset = agentPreset;
    this.#autostart = autostart;
    this.#dshBin = dshBin;
  }
  async rpc(method, payload = {}, timeoutMs = 3e4, options = {}) {
    const rpcId = options.rpcId ?? `weixin-${randomUUID8()}`;
    const response = await fetch(new URL(`/api/${method}`, this.#baseUrl), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: "client-request", rpcId, method, payload }),
      signal: AbortSignal.timeout(timeoutMs)
    });
    if (!response.ok) throw new Error(`Harness transport ${method} failed: HTTP ${response.status}`);
    const body = await response.json();
    if (body?.type !== "server-response" || body?.rpcId !== rpcId) {
      throw new Error(`Harness returned an invalid response for ${method}`);
    }
    if (!body.result?.ok) throw new HarnessRpcError3(method, body.result?.error);
    return body.result.value;
  }
  async health() {
    await this.rpc("host.describe", {}, 5e3);
    return true;
  }
  async ensureRunning() {
    try {
      return await this.health();
    } catch (firstError) {
      if (!this.#autostart) throw firstError;
    }
    if (!this.#managedProcess || this.#managedProcess.exitCode !== null) {
      const port = this.#baseUrl.port || (this.#baseUrl.protocol === "https:" ? "443" : "80");
      this.#managedProcess = spawn3(this.#dshBin, [
        "web",
        "--host",
        this.#baseUrl.hostname,
        "--port",
        port
      ], {
        cwd: this.#workspace,
        env: process.env,
        stdio: ["ignore", "inherit", "inherit"]
      });
      this.#managedProcess.on("error", (error) => {
        console.error("[dsh-weixin] failed to start Harness:", error.message);
      });
    }
    const deadline = Date.now() + 6e4;
    let lastError;
    while (Date.now() < deadline) {
      await sleep3(1e3);
      try {
        return await this.health();
      } catch (error) {
        lastError = error;
      }
    }
    throw new Error(`Harness did not become ready: ${lastError?.message ?? "timeout"}`);
  }
  async workspaceId() {
    const { items } = await this.rpc("workspace.list", {});
    const existing = items.find((item) => item.path === this.#workspace);
    if (existing) return existing.workspaceId;
    const created = await this.rpc("workspace.create", { path: this.#workspace });
    return created.workspace.workspaceId;
  }
  async createSession() {
    await this.ensureRunning();
    const workspaceId = await this.workspaceId();
    const created = await this.rpc("session.create", {
      workspaceId,
      agentPreset: this.#agentPreset
    });
    return created.sessionId;
  }
  async sessionExists(sessionId) {
    try {
      await this.rpc("session.history", { sessionId, maxMessages: 1 });
      return true;
    } catch (error) {
      if (error instanceof HarnessRpcError3 && error.code === "session-not-found") return false;
      throw error;
    }
  }
  async ask(sessionId, text, options = {}) {
    if (typeof options === "number") options = { timeoutMs: options };
    const timeoutMs = options.timeoutMs ?? 6e5;
    const onUpdate = typeof options.onUpdate === "function" ? options.onUpdate : null;
    await this.ensureRunning();
    const before = await this.rpc("session.history", { sessionId, maxMessages: 1 });
    const baselineSeq = Math.max(-1, ...(before.events ?? []).map(({ event }) => event.seq ?? -1));
    const promptRpcId = `weixin-${randomUUID8()}`;
    const tracker = new HarnessReplyTracker3({ promptRpcId, afterSeq: baselineSeq });
    await this.rpc("session.prompt", {
      sessionId,
      mode: "queue",
      content: [{ type: "text", text }],
      clientTimeZone: Intl.DateTimeFormat().resolvedOptions().timeZone
    }, 3e4, { rpcId: promptRpcId });
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      await sleep3(300);
      const history = await this.rpc("session.history", { sessionId, maxMessages: 50 });
      const update = tracker.consume(history.events ?? []);
      if (update && onUpdate) {
        try {
          await onUpdate(update);
        } catch (error) {
          console.warn("[dsh-weixin] ignored a progress update failure:", error.message);
        }
      }
      if (!tracker.finished) continue;
      if (tracker.answer) return tracker.answer;
      throw new Error(
        `Harness turn ended without a text reply${tracker.reason ? ` (${JSON.stringify(tracker.reason)})` : ""}`
      );
    }
    throw new Error(`Harness reply timed out after ${Math.round(timeoutMs / 1e3)} seconds`);
  }
  stopManagedProcess() {
    if (this.#managedProcess?.exitCode === null) this.#managedProcess.kill("SIGTERM");
  }
};

// src/channels/qq/harness-client.mjs
var QqHarnessClient = class extends HarnessClient3 {
};

// src/channels/qq/qq-controller.mjs
import { randomUUID as randomUUID9 } from "node:crypto";
var ACTIVE_ATTEMPT_STATES2 = /* @__PURE__ */ new Set(["starting", "pending", "refreshing", "connecting"]);
var TERMINAL_ATTEMPT_STATES2 = /* @__PURE__ */ new Set(["connected", "failed", "cancelled"]);
var QR_TTL_MS = 5 * 6e4;
function cleanString6(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}
function safeError2(code, message) {
  return Object.freeze({ code, message });
}
function publicAttempt2(record) {
  if (!record) return null;
  return {
    attemptId: record.id,
    status: record.state,
    qrRevision: record.qrRevision,
    pollIntervalMs: 1e3,
    ...record.verificationUrl ? { verificationUrl: record.verificationUrl } : {},
    ...record.expiresAt ? { expiresAt: record.expiresAt } : {},
    ...record.botId ? { botId: record.botId } : {},
    ...record.error ? { error: structuredClone(record.error) } : {}
  };
}
var QqController = class {
  #qrAuth;
  #credentials;
  #configStore;
  #createRuntime;
  #deleteState;
  #logger;
  #runtimes = /* @__PURE__ */ new Map();
  #errors = /* @__PURE__ */ new Map();
  #attempts = /* @__PURE__ */ new Map();
  #activeAttemptId = null;
  #transitions = /* @__PURE__ */ new Map();
  #revision = 0;
  #closed = false;
  constructor({
    qrAuth,
    credentials,
    configStore,
    createRuntime,
    deleteState = async () => {
    },
    logger = console
  }) {
    if (!qrAuth || typeof qrAuth.start !== "function") throw new TypeError("QQ QR auth is required");
    if (!credentials || typeof credentials.resolve !== "function" || typeof credentials.set !== "function" || typeof credentials.unset !== "function") {
      throw new TypeError("QqController requires the DSH credential provider");
    }
    if (!configStore || typeof configStore.list !== "function" || typeof configStore.save !== "function" || typeof configStore.remove !== "function") {
      throw new TypeError("QqController requires a config store");
    }
    if (typeof createRuntime !== "function") throw new TypeError("createRuntime is required");
    this.#qrAuth = qrAuth;
    this.#credentials = credentials;
    this.#configStore = configStore;
    this.#createRuntime = createRuntime;
    this.#deleteState = deleteState;
    this.#logger = logger;
  }
  async initialize() {
    if (this.#closed) return this.status();
    for (const config of this.#configStore.list()) {
      await this.#withBotTransition(config.botId, async () => {
        if (this.#closed || this.#runtimes.get(config.botId)?.status?.ready) return;
        const appSecret = await this.#resolveSecret(config.secretRef);
        if (!appSecret) {
          this.#errors.set(config.botId, safeError2("missing-secret", "QQ \u673A\u5668\u4EBA\u51ED\u636E\u7F3A\u5931\uFF0C\u8BF7\u79FB\u9664\u540E\u91CD\u65B0\u626B\u7801\u3002"));
          return;
        }
        try {
          await this.#startRuntime(config, appSecret);
          this.#errors.delete(config.botId);
        } catch (error) {
          this.#errors.set(config.botId, safeError2("connection-failed", "QQ \u8FDE\u63A5\u672A\u5C31\u7EEA\uFF0C\u63D2\u4EF6\u4F1A\u81EA\u52A8\u91CD\u8BD5\u3002"));
          this.#logger.warn?.(`[dsh-im:qq] bot ${config.botId} failed to initialize:`, error);
        } finally {
          this.#touch();
        }
      });
    }
    return this.status();
  }
  async startProvisioning() {
    if (this.#closed) throw new Error("QQ controller is closed");
    if (this.#activeAttemptId) await this.cancelProvisioning(this.#activeAttemptId);
    let firstQrResolve;
    let firstQrReject;
    const firstQr = new Promise((resolve6, reject) => {
      firstQrResolve = resolve6;
      firstQrReject = reject;
    });
    const record = {
      id: randomUUID9(),
      state: "starting",
      createdAt: Date.now(),
      expiresAt: null,
      qrRevision: 0,
      verificationUrl: null,
      controller: new AbortController(),
      dispose: null,
      task: null,
      error: null,
      botId: null
    };
    this.#attempts.set(record.id, record);
    this.#activeAttemptId = record.id;
    this.#touch();
    try {
      record.dispose = this.#qrAuth.start({
        onQrDisplayed: (url) => {
          if (record.controller.signal.aborted || TERMINAL_ATTEMPT_STATES2.has(record.state)) return;
          const verificationUrl = cleanString6(url);
          if (!verificationUrl) return;
          record.verificationUrl = verificationUrl;
          record.qrRevision += 1;
          record.expiresAt = Date.now() + QR_TTL_MS;
          record.state = "pending";
          this.#touch();
          firstQrResolve();
        },
        onQrExpired: () => {
          if (record.controller.signal.aborted || TERMINAL_ATTEMPT_STATES2.has(record.state)) return;
          record.state = "refreshing";
          record.verificationUrl = null;
          record.expiresAt = null;
          this.#touch();
        },
        onSuccess: (credentials) => {
          if (record.controller.signal.aborted || TERMINAL_ATTEMPT_STATES2.has(record.state)) return;
          record.task = this.#completeProvisioning(record, credentials);
        },
        onFailure: (error) => {
          if (record.controller.signal.aborted || TERMINAL_ATTEMPT_STATES2.has(record.state)) return;
          record.state = "failed";
          record.error = safeError2("qr-connect-failed", "QQ \u626B\u7801\u670D\u52A1\u6682\u65F6\u4E0D\u53EF\u7528\uFF0C\u8BF7\u91CD\u65B0\u751F\u6210\u4E8C\u7EF4\u7801\u3002");
          if (this.#activeAttemptId === record.id) this.#activeAttemptId = null;
          this.#touch();
          firstQrReject(error);
        }
      }, { signal: record.controller.signal });
      await firstQr;
      return publicAttempt2(record);
    } catch (error) {
      if (record.controller.signal.aborted) {
        record.state = "cancelled";
        record.error = safeError2("cancelled", "\u626B\u7801\u7ED1\u5B9A\u5DF2\u53D6\u6D88\u3002");
      } else if (!TERMINAL_ATTEMPT_STATES2.has(record.state)) {
        record.state = "failed";
        record.error = safeError2("qr-start-failed", "\u65E0\u6CD5\u751F\u6210 QQ \u4E8C\u7EF4\u7801\uFF0C\u8BF7\u7A0D\u540E\u91CD\u8BD5\u3002");
      }
      if (this.#activeAttemptId === record.id) this.#activeAttemptId = null;
      this.#touch();
      throw error;
    }
  }
  registrationStatus(attemptId) {
    return publicAttempt2(this.#attempts.get(attemptId));
  }
  async cancelProvisioning(attemptId) {
    const record = this.#attempts.get(attemptId);
    if (!record) return null;
    if (!TERMINAL_ATTEMPT_STATES2.has(record.state)) {
      record.controller.abort();
      record.dispose?.();
      await record.task?.catch(() => void 0);
      if (!TERMINAL_ATTEMPT_STATES2.has(record.state)) record.state = "cancelled";
      record.error ??= safeError2("cancelled", "\u626B\u7801\u7ED1\u5B9A\u5DF2\u53D6\u6D88\u3002");
    }
    if (this.#activeAttemptId === record.id) this.#activeAttemptId = null;
    this.#touch();
    return publicAttempt2(record);
  }
  async reconnectBot(botId) {
    const config = this.#configStore.get(botId);
    if (!config) throw new Error("Unknown QQ bot");
    await this.#withBotTransition(botId, async () => {
      const secret = await this.#resolveSecret(config.secretRef);
      if (!secret) throw new Error("QQ bot secret is missing");
      try {
        await this.#startRuntime(config, secret);
        this.#errors.delete(botId);
      } catch (error) {
        this.#errors.set(botId, safeError2("connection-failed", "QQ \u8FDE\u63A5\u4ECD\u672A\u5C31\u7EEA\uFF0C\u8BF7\u7A0D\u540E\u91CD\u8BD5\u3002"));
        throw error;
      } finally {
        this.#touch();
      }
    });
    return this.status();
  }
  async deleteBot(botId) {
    const config = this.#configStore.get(botId);
    if (!config) throw new Error("Unknown QQ bot");
    await this.#withBotTransition(botId, async () => {
      const previous = await this.#credentials.resolve(config.secretRef).catch(() => void 0);
      await this.#stopRuntime(botId);
      try {
        await this.#credentials.unset(config.secretRef);
        await this.#configStore.remove(botId);
      } catch (error) {
        if (previous?.value) {
          await this.#credentials.set(config.secretRef, previous.value).catch(() => void 0);
          await this.#startRuntime(config, previous.value).catch(() => void 0);
        }
        throw new Error("Unable to remove the QQ bot safely.", { cause: error });
      }
      await this.#deleteState({ botId, config }).catch((error) => {
        this.#logger.warn?.(`[dsh-im:qq] bot ${botId} state cleanup failed:`, error);
      });
      this.#errors.delete(botId);
      this.#touch();
    });
    return this.status();
  }
  status() {
    const bots = this.#configStore.list().map((config) => {
      const runtimeStatus2 = this.#runtimes.get(config.botId)?.status ?? null;
      const connected = runtimeStatus2?.ready === true && runtimeStatus2.qqConnectionState === "connected" && runtimeStatus2.harnessReachable === true;
      const state = connected ? "connected" : runtimeStatus2?.qqConnectionState === "connecting" ? "connecting" : this.#errors.has(config.botId) || runtimeStatus2?.qqConnectionState === "failed" ? "error" : "offline";
      return {
        botId: config.botId,
        state,
        connected,
        configured: true,
        bot: { name: "QQ\u673A\u5668\u4EBA", appIdMasked: maskQqAppId(config.appId) },
        health: {
          status: connected ? "healthy" : state === "error" ? "error" : "offline",
          summary: connected ? "QQ WebSocket \u957F\u8FDE\u63A5\u8FD0\u884C\u6B63\u5E38" : state === "error" ? "QQ \u8FDE\u63A5\u672A\u5C31\u7EEA\uFF0C\u63D2\u4EF6\u4F1A\u81EA\u52A8\u91CD\u8BD5" : "QQ \u8FDE\u63A5\u5F53\u524D\u79BB\u7EBF",
          lastCheckedAt: runtimeStatus2?.lastCheckedAt ?? null,
          lastConnectedAt: runtimeStatus2?.lastConnectedAt ?? null
        },
        stats: {
          messagesReceived: runtimeStatus2?.messagesReceived ?? 0,
          messagesReplied: runtimeStatus2?.messagesReplied ?? 0
        },
        error: structuredClone(this.#errors.get(config.botId) ?? null)
      };
    });
    const connectedCount = bots.filter((bot) => bot.connected).length;
    const active = this.#activeAttemptId ? this.#attempts.get(this.#activeAttemptId) : null;
    return {
      schemaVersion: 1,
      revision: this.#revision,
      state: active && ACTIVE_ATTEMPT_STATES2.has(active.state) ? "provisioning" : bots.length === 0 ? "disconnected" : connectedCount === bots.length ? "connected" : connectedCount > 0 ? "degraded" : "offline",
      bots,
      totals: { configured: bots.length, connected: connectedCount },
      ...active && ACTIVE_ATTEMPT_STATES2.has(active.state) ? { provisioning: publicAttempt2(active) } : {}
    };
  }
  async close() {
    if (this.#closed) return;
    this.#closed = true;
    if (this.#activeAttemptId) await this.cancelProvisioning(this.#activeAttemptId);
    await Promise.allSettled([...this.#runtimes.keys()].map((botId) => this.#stopRuntime(botId)));
  }
  async #completeProvisioning(record, credentials) {
    try {
      record.state = "connecting";
      record.verificationUrl = null;
      record.expiresAt = null;
      this.#touch();
      const credential = Array.isArray(credentials) ? credentials[0] : null;
      const appId = cleanString6(credential?.appId);
      const appSecret = cleanString6(credential?.appSecret);
      const ownerUserOpenid = cleanString6(credential?.userOpenid);
      if (!appId || !appSecret || !ownerUserOpenid) {
        throw new Error("QQ authorization returned incomplete credentials");
      }
      record.botId = await this.#activateBot(record, { appId, appSecret, ownerUserOpenid });
      record.state = "connected";
      record.error = null;
    } catch (error) {
      if (record.controller.signal.aborted) {
        record.state = "cancelled";
        record.error = safeError2("cancelled", "\u626B\u7801\u7ED1\u5B9A\u5DF2\u53D6\u6D88\u3002");
      } else {
        record.state = "failed";
        record.error = safeError2("activation-failed", "QQ \u5DF2\u6388\u6743\uFF0C\u4F46\u65E0\u6CD5\u5B89\u5168\u4FDD\u5B58\u63A5\u5165\u914D\u7F6E\u3002");
        this.#logger.error?.("[dsh-im:qq] provisioning failed:", error);
      }
    } finally {
      record.dispose?.();
      if (this.#activeAttemptId === record.id) this.#activeAttemptId = null;
      this.#touch();
    }
  }
  async #activateBot(record, { appId, appSecret, ownerUserOpenid }) {
    const identity = deriveQqBotIdentity(appId);
    const previousConfig = this.#configStore.getByAppId(appId);
    const previousSecret = await this.#credentials.resolve(identity.secretRef).catch(() => void 0);
    const config = {
      botId: identity.botId,
      appId,
      secretRef: identity.secretRef,
      ownerUserOpenid,
      createdAt: previousConfig?.createdAt ?? (/* @__PURE__ */ new Date()).toISOString(),
      connectedAt: (/* @__PURE__ */ new Date()).toISOString()
    };
    return this.#withBotTransition(identity.botId, async () => {
      await this.#credentials.set(identity.secretRef, appSecret);
      try {
        if (record.controller.signal.aborted) throw new DOMException("Cancelled", "AbortError");
        await this.#configStore.save(config);
      } catch (error) {
        await this.#restoreCredential(identity.secretRef, previousSecret);
        throw error;
      }
      try {
        if (record.controller.signal.aborted) throw new DOMException("Cancelled", "AbortError");
        await this.#startRuntime(config, appSecret);
        this.#errors.delete(identity.botId);
      } catch (error) {
        if (record.controller.signal.aborted) {
          await this.#stopRuntime(identity.botId);
          if (previousConfig) await this.#configStore.save(previousConfig).catch(() => void 0);
          else await this.#configStore.remove(identity.botId).catch(() => void 0);
          await this.#restoreCredential(identity.secretRef, previousSecret);
          throw error;
        }
        this.#errors.set(identity.botId, safeError2("connection-failed", "QQ \u673A\u5668\u4EBA\u5DF2\u7ED1\u5B9A\uFF0C\u6D88\u606F\u8FDE\u63A5\u6682\u672A\u5C31\u7EEA\u3002"));
        this.#logger.warn?.(`[dsh-im:qq] bot ${identity.botId} activation connection failed:`, error);
      }
      this.#touch();
      return identity.botId;
    });
  }
  async #startRuntime(config, appSecret) {
    await this.#stopRuntime(config.botId);
    const runtime = await this.#createRuntime({ botId: config.botId, config, appSecret });
    if (!runtime || typeof runtime.start !== "function" || typeof runtime.stop !== "function") {
      throw new TypeError("createRuntime returned an invalid QQ runtime");
    }
    this.#runtimes.set(config.botId, runtime);
    try {
      await runtime.start();
    } catch (error) {
      await runtime.stop().catch(() => void 0);
      this.#runtimes.delete(config.botId);
      throw error;
    }
  }
  async #stopRuntime(botId) {
    const runtime = this.#runtimes.get(botId);
    this.#runtimes.delete(botId);
    await runtime?.stop().catch((error) => {
      this.#logger.warn?.(`[dsh-im:qq] bot ${botId} failed to stop cleanly:`, error);
    });
  }
  async #resolveSecret(ref) {
    const result = await this.#credentials.resolve(ref).catch(() => void 0);
    return cleanString6(result?.value);
  }
  async #restoreCredential(ref, previous) {
    if (previous?.value) await this.#credentials.set(ref, previous.value).catch(() => void 0);
    else await this.#credentials.unset(ref).catch(() => void 0);
  }
  #withBotTransition(botId, operation) {
    const previous = this.#transitions.get(botId) ?? Promise.resolve();
    const current = previous.catch(() => void 0).then(operation);
    const settled = current.finally(() => {
      if (this.#transitions.get(botId) === settled) this.#transitions.delete(botId);
    });
    this.#transitions.set(botId, settled);
    return settled;
  }
  #touch() {
    this.#revision += 1;
  }
};

// src/channels/qq/qq-runtime.mjs
import { QQBot, typingIndicator } from "@tencent-connect/qqbot-nodejs";

// src/channels/qq/qq-bridge.mjs
var HELP_TEXT3 = [
  "QQ \u673A\u5668\u4EBA\u5DF2\u8FDE\u63A5 DeepSeek Harness\u3002",
  "",
  "\u76F4\u63A5\u53D1\u9001\u6587\u5B57\u5373\u53EF\u7EE7\u7EED\u5F53\u524D\u4F1A\u8BDD\u3002",
  "/new  \u5F00\u542F\u4E00\u4E2A\u5168\u65B0\u4F1A\u8BDD",
  "/status  \u68C0\u67E5\u8FDE\u63A5\u72B6\u6001",
  "/help  \u663E\u793A\u672C\u5E2E\u52A9"
].join("\n");
function conversationKey3(message) {
  return `${message.kind}:${message.kind === "group" ? message.groupOpenid : message.senderId}`;
}
function safeText(message) {
  return typeof message?.content === "string" ? message.content.trim() : "";
}
function createQqBridgeStatus() {
  return {
    messagesReceived: 0,
    messagesReplied: 0,
    messagesRejected: 0,
    lastMessageAt: null,
    lastReplyAt: null,
    lastRejectedAt: null,
    lastError: null
  };
}
var QqHarnessBridge = class {
  #bot;
  #ownerUserOpenid;
  #harness;
  #state;
  #status;
  #logger;
  #replyTimeoutMs;
  #queues = /* @__PURE__ */ new Map();
  constructor({
    bot,
    ownerUserOpenid,
    harness,
    state,
    status = createQqBridgeStatus(),
    logger = console,
    replyTimeoutMs = 6e5
  }) {
    if (!bot || typeof bot.sendText !== "function") throw new TypeError("QQ bot client is required");
    if (!ownerUserOpenid) throw new TypeError("QQ scanner identity is required");
    if (!harness || !state) throw new TypeError("Harness client and state store are required");
    this.#bot = bot;
    this.#ownerUserOpenid = ownerUserOpenid;
    this.#harness = harness;
    this.#state = state;
    this.#status = status;
    this.#logger = logger;
    this.#replyTimeoutMs = replyTimeoutMs;
  }
  get status() {
    return structuredClone(this.#status);
  }
  accept(message) {
    const key = conversationKey3(message);
    const previous = this.#queues.get(key) ?? Promise.resolve();
    const current = previous.catch(() => void 0).then(() => this.#process(message)).finally(() => {
      if (this.#queues.get(key) === current) this.#queues.delete(key);
    });
    this.#queues.set(key, current);
    return current;
  }
  async waitForIdle() {
    await Promise.allSettled([...this.#queues.values()]);
  }
  async #process(message) {
    const messageId = typeof message?.messageId === "string" ? message.messageId : "";
    const sender = typeof message?.senderId === "string" ? message.senderId : "";
    if (!messageId || !sender || message.senderIsBot === true) return;
    if (!["c2c", "group"].includes(message.kind) || this.#state.hasSeen(messageId)) return;
    this.#status.messagesReceived += 1;
    this.#status.lastMessageAt = (/* @__PURE__ */ new Date()).toISOString();
    if (sender !== this.#ownerUserOpenid) {
      this.#status.messagesRejected += 1;
      this.#status.lastRejectedAt = (/* @__PURE__ */ new Date()).toISOString();
      return;
    }
    if (message.kind === "group" && message.rawEventType !== "GROUP_AT_MESSAGE_CREATE") return;
    const target = message.replyTarget;
    const text = safeText(message);
    try {
      if (!text) {
        await this.#bot.sendText(target, "\u76EE\u524D\u4EC5\u652F\u6301\u6587\u5B57\u6D88\u606F\u3002");
        await this.#state.markSeen(messageId);
        return;
      }
      const command = text.toLowerCase();
      if (command === "/help") {
        await this.#bot.sendText(target, HELP_TEXT3);
        await this.#state.markSeen(messageId);
        return;
      }
      if (command === "/status") {
        await this.#harness.ensureRunning();
        await this.#bot.sendText(target, "QQ \u673A\u5668\u4EBA\u4E0E DeepSeek Harness \u8FDE\u63A5\u6B63\u5E38\u3002");
        await this.#state.markSeen(messageId);
        return;
      }
      const key = conversationKey3(message);
      if (command === "/new") {
        await this.#state.clearSession(key);
        await this.#bot.sendText(target, "\u5DF2\u5F00\u542F\u65B0\u4F1A\u8BDD\u3002\u8BF7\u53D1\u9001\u4F60\u7684\u95EE\u9898\u3002");
        await this.#state.markSeen(messageId);
        return;
      }
      let sessionId = this.#state.sessionFor(key);
      if (!sessionId || !await this.#harness.sessionExists(sessionId)) {
        sessionId = await this.#harness.createSession();
        await this.#state.setSession(key, sessionId);
      }
      let stream = null;
      let streamFinished = false;
      if (message.kind === "c2c" && target?.msgId && typeof this.#bot.openStream === "function") {
        try {
          stream = this.#bot.openStream({ target });
        } catch (error) {
          this.#logger.warn?.("[dsh-im:qq] unable to start a QQ stream; using a text reply:", error);
        }
      }
      const answer = await this.#harness.ask(sessionId, text, {
        timeoutMs: this.#replyTimeoutMs,
        onUpdate: stream ? async (update) => {
          const progress = update.type === "text" ? update.text : update.type === "tool" ? `\u6B63\u5728\u4F7F\u7528${update.name}\u2026` : update.text;
          if (progress) await stream.update(progress);
        } : void 0
      });
      if (stream) {
        try {
          await stream.update(answer);
          await stream.complete();
          streamFinished = true;
        } catch (error) {
          stream.cancel?.();
          this.#logger.warn?.("[dsh-im:qq] QQ stream finalization failed; using a text reply:", error);
        }
      }
      if (!streamFinished) await this.#bot.sendText(target, answer);
      await this.#state.markSeen(messageId);
      this.#status.messagesReplied += 1;
      this.#status.lastReplyAt = (/* @__PURE__ */ new Date()).toISOString();
      this.#status.lastError = null;
    } catch (error) {
      this.#status.lastError = error?.message ?? String(error);
      this.#logger.error?.("[dsh-im:qq] failed to process an inbound message:", error);
      try {
        await this.#bot.sendText(target, "\u6D88\u606F\u5904\u7406\u5931\u8D25\uFF0C\u8BF7\u7A0D\u540E\u91CD\u8BD5\u3002");
        await this.#state.markSeen(messageId);
      } catch (sendError) {
        this.#logger.error?.("[dsh-im:qq] failed to send the safe error reply:", sendError);
      }
    }
  }
};

// src/channels/qq/qq-runtime.mjs
function timeoutError() {
  const error = new Error("QQ WebSocket did not become ready in time");
  error.code = "connect-timeout";
  return error;
}
function createQqRuntimeStatus() {
  return {
    startedAt: null,
    ready: false,
    qqConnectionState: "idle",
    harnessReachable: false,
    lastCheckedAt: null,
    lastConnectedAt: null,
    lastError: null,
    ...createQqBridgeStatus()
  };
}
var QqRuntime = class {
  #config;
  #appSecret;
  #harness;
  #state;
  #logger;
  #replyTimeoutMs;
  #connectTimeoutMs;
  #createBot;
  #typingMiddleware;
  #status = createQqRuntimeStatus();
  #bot = null;
  #bridge = null;
  #abortController = null;
  #runTask = null;
  #starting = null;
  constructor({
    config,
    appSecret,
    harness,
    state,
    logger = console,
    replyTimeoutMs = 6e5,
    connectTimeoutMs = 2e4,
    createBot = (options) => new QQBot(options),
    typingMiddleware = typingIndicator
  }) {
    if (!config || !appSecret || !harness || !state) {
      throw new TypeError("QqRuntime requires config, app secret, Harness, and state");
    }
    this.#config = config;
    this.#appSecret = appSecret;
    this.#harness = harness;
    this.#state = state;
    this.#logger = logger;
    this.#replyTimeoutMs = replyTimeoutMs;
    this.#connectTimeoutMs = connectTimeoutMs;
    this.#createBot = createBot;
    this.#typingMiddleware = typingMiddleware;
  }
  get status() {
    return structuredClone(this.#status);
  }
  async start() {
    if (this.#status.ready && this.#bot) return this.status;
    if (this.#starting) return this.#starting;
    this.#starting = this.#start().finally(() => {
      this.#starting = null;
    });
    return this.#starting;
  }
  async #start() {
    await this.stop();
    this.#status.startedAt = (/* @__PURE__ */ new Date()).toISOString();
    this.#status.qqConnectionState = "connecting";
    this.#status.lastError = null;
    await this.#harness.ensureRunning();
    this.#status.harnessReachable = true;
    const sdkLogger = {
      error: (...args) => this.#logger.error?.(...args),
      warn: (...args) => this.#logger.warn?.(...args),
      info: (...args) => this.#logger.info?.(...args),
      debug: () => {
      }
    };
    const bot = this.#createBot({
      appId: this.#config.appId,
      appSecret: this.#appSecret,
      accountId: this.#config.botId,
      logger: sdkLogger,
      transport: "websocket",
      tokenPrefetch: "sync"
    });
    if (!bot || typeof bot.start !== "function" || typeof bot.stop !== "function") {
      throw new TypeError("QQ bot factory returned an invalid client");
    }
    this.#bot = bot;
    this.#bridge = new QqHarnessBridge({
      bot,
      ownerUserOpenid: this.#config.ownerUserOpenid,
      harness: this.#harness,
      state: this.#state,
      status: this.#status,
      logger: this.#logger,
      replyTimeoutMs: this.#replyTimeoutMs
    });
    bot.use?.(this.#typingMiddleware({
      keepAlive: true,
      predicate: (ctx) => ctx?.message?.senderId === this.#config.ownerUserOpenid
    }));
    const controller = new AbortController();
    this.#abortController = controller;
    let readyResolve;
    let readyReject;
    const ready = new Promise((resolve6, reject) => {
      readyResolve = resolve6;
      readyReject = reject;
    });
    const onReady = () => {
      const now = Date.now();
      this.#status.ready = true;
      this.#status.qqConnectionState = "connected";
      this.#status.lastCheckedAt = now;
      this.#status.lastConnectedAt = now;
      this.#status.lastError = null;
      readyResolve();
    };
    const onError = (error) => {
      if (!this.#status.ready) readyReject(error);
      else {
        this.#status.lastError = error?.message ?? String(error);
        this.#logger.warn?.(`[dsh-im:qq] bot ${this.#config.botId} connection error:`, error);
      }
    };
    const onMessage = (_ctx, message) => this.#bridge?.accept(message);
    bot.on("ready", onReady);
    bot.on("resumed", onReady);
    bot.on("error", onError);
    bot.on("message", onMessage);
    const runTask = Promise.resolve().then(() => bot.start(controller.signal));
    this.#runTask = runTask;
    runTask.catch((error) => {
      if (controller.signal.aborted) return;
      readyReject(error);
      this.#status.ready = false;
      this.#status.qqConnectionState = "failed";
      this.#status.lastError = error?.message ?? String(error);
      this.#logger.error?.(`[dsh-im:qq] bot ${this.#config.botId} connection stopped:`, error);
    });
    let timer;
    try {
      await Promise.race([
        ready,
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(timeoutError()), this.#connectTimeoutMs);
        })
      ]);
      this.#status.ready = true;
      this.#status.qqConnectionState = "connected";
      this.#status.lastCheckedAt = Date.now();
      this.#status.lastConnectedAt = Date.now();
      return this.status;
    } catch (error) {
      this.#status.ready = false;
      this.#status.qqConnectionState = "failed";
      this.#status.lastError = error?.message ?? String(error);
      await this.stop();
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }
  async stop() {
    const bot = this.#bot;
    const bridge = this.#bridge;
    const runTask = this.#runTask;
    this.#abortController?.abort();
    this.#abortController = null;
    this.#bot = null;
    this.#bridge = null;
    this.#runTask = null;
    try {
      bot?.stop();
    } catch (error) {
      this.#logger.warn?.(`[dsh-im:qq] bot ${this.#config.botId} failed to stop cleanly:`, error);
    }
    await Promise.race([
      runTask?.catch(() => void 0) ?? Promise.resolve(),
      new Promise((resolve6) => setTimeout(resolve6, 2e3))
    ]);
    await bridge?.waitForIdle();
    this.#status.ready = false;
    this.#status.qqConnectionState = "idle";
    return this.status;
  }
};

// src/channels/qq/qr-auth.mjs
import { startQrConnect } from "@tencent-connect/qqbot-connector";
var QqQrAuth = class {
  #start;
  #source;
  constructor({ start = startQrConnect, source = "deepseek-harness" } = {}) {
    if (typeof start !== "function") throw new TypeError("QQ QR connector is required");
    this.#start = start;
    this.#source = source;
  }
  start(callbacks, { signal } = {}) {
    if (!callbacks || typeof callbacks.onSuccess !== "function" || typeof callbacks.onFailure !== "function") {
      throw new TypeError("QQ QR callbacks are required");
    }
    return this.#start(callbacks, {
      displayQrCodeToConsole: false,
      source: this.#source,
      signal
    });
  }
};

// src/channels/qq/state-store.mjs
import { mkdir as mkdir6, readFile as readFile6, rename as rename6, unlink as unlink7, writeFile as writeFile6 } from "node:fs/promises";
import { dirname as dirname6 } from "node:path";
var EMPTY_STATE3 = Object.freeze({ version: 1, sessions: {}, seenMessageIds: [] });
function normalizeState2(value) {
  if (!value || typeof value !== "object") return structuredClone(EMPTY_STATE3);
  const sessions = {};
  if (value.sessions && typeof value.sessions === "object" && !Array.isArray(value.sessions)) {
    for (const [key, sessionId] of Object.entries(value.sessions)) {
      if (typeof key === "string" && typeof sessionId === "string" && sessionId) {
        sessions[key] = sessionId;
      }
    }
  }
  return {
    version: 1,
    sessions,
    seenMessageIds: Array.isArray(value.seenMessageIds) ? value.seenMessageIds.filter((id) => typeof id === "string").slice(-1e3) : []
  };
}
var QqStateStore = class {
  #path;
  #state = structuredClone(EMPTY_STATE3);
  #writeQueue = Promise.resolve();
  constructor(path) {
    this.#path = path;
  }
  async load() {
    try {
      this.#state = normalizeState2(JSON.parse(await readFile6(this.#path, "utf8")));
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
      this.#state = structuredClone(EMPTY_STATE3);
      await this.#persist();
    }
    return this;
  }
  sessionFor(key) {
    return this.#state.sessions[key] ?? null;
  }
  async setSession(key, sessionId) {
    this.#state.sessions[key] = sessionId;
    await this.#persist();
  }
  async clearSession(key) {
    delete this.#state.sessions[key];
    await this.#persist();
  }
  hasSeen(messageId) {
    return this.#state.seenMessageIds.includes(messageId);
  }
  async markSeen(messageId) {
    if (this.hasSeen(messageId)) return;
    this.#state.seenMessageIds.push(messageId);
    if (this.#state.seenMessageIds.length > 1e3) {
      this.#state.seenMessageIds.splice(0, this.#state.seenMessageIds.length - 1e3);
    }
    await this.#persist();
  }
  snapshot() {
    return structuredClone(this.#state);
  }
  async remove() {
    try {
      await unlink7(this.#path);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    this.#state = structuredClone(EMPTY_STATE3);
  }
  async #persist() {
    const snapshot = `${JSON.stringify(this.#state, null, 2)}
`;
    const operation = this.#writeQueue.then(async () => {
      await mkdir6(dirname6(this.#path), { recursive: true, mode: 448 });
      const temporary = `${this.#path}.tmp`;
      await writeFile6(temporary, snapshot, { encoding: "utf8", mode: 384 });
      await rename6(temporary, this.#path);
    });
    this.#writeQueue = operation.then(() => void 0, () => void 0);
    await operation;
  }
};

// plugin-src/host/channels/qq/connection-supervisor.mjs
var DEFAULT_RETRY_DELAYS_MS3 = Object.freeze([250, 1e3, 3e3, 5e3, 1e4, 3e4]);
function retryDelays2(value) {
  if (!Array.isArray(value) || value.length === 0) return [...DEFAULT_RETRY_DELAYS_MS3];
  const valid = value.filter((delay2) => Number.isFinite(delay2) && delay2 >= 0);
  return valid.length > 0 ? valid : [...DEFAULT_RETRY_DELAYS_MS3];
}
var ConnectionSupervisor3 = class {
  #controller;
  #harness;
  #logger;
  #retryDelays;
  #healthyIntervalMs;
  #setTimeout;
  #clearTimeout;
  #timer = null;
  #running = null;
  #retryIndex = 0;
  #closed = false;
  #started = false;
  #ready;
  #resolveReady;
  constructor({
    controller,
    harness,
    logger = console,
    retryDelaysMs,
    healthyIntervalMs = 15e3,
    setTimeoutImpl = setTimeout,
    clearTimeoutImpl = clearTimeout
  }) {
    if (!controller || typeof controller.initialize !== "function" || typeof controller.status !== "function") {
      throw new TypeError("ConnectionSupervisor requires a controller");
    }
    if (!harness || typeof harness.ensureRunning !== "function") {
      throw new TypeError("ConnectionSupervisor requires a Harness client");
    }
    this.#controller = controller;
    this.#harness = harness;
    this.#logger = logger;
    this.#retryDelays = retryDelays2(retryDelaysMs);
    this.#healthyIntervalMs = Number.isFinite(healthyIntervalMs) && healthyIntervalMs >= 0 ? healthyIntervalMs : 15e3;
    this.#setTimeout = setTimeoutImpl;
    this.#clearTimeout = clearTimeoutImpl;
    this.#ready = new Promise((resolve6) => {
      this.#resolveReady = resolve6;
    });
  }
  get ready() {
    return this.#ready;
  }
  start() {
    if (this.#started || this.#closed) return this;
    this.#started = true;
    this.#schedule(0);
    return this;
  }
  async close() {
    if (this.#closed) return;
    this.#closed = true;
    if (this.#timer !== null) this.#clearTimeout(this.#timer);
    this.#timer = null;
    await this.#running?.catch(() => void 0);
    this.#resolveReady?.(null);
    this.#resolveReady = null;
  }
  #schedule(delayMs) {
    if (this.#closed) return;
    this.#timer = this.#setTimeout(() => {
      this.#timer = null;
      void this.#run();
    }, delayMs);
    this.#timer?.unref?.();
  }
  async #run() {
    if (this.#closed || this.#running) return;
    const operation = this.#reconcile();
    this.#running = operation;
    try {
      await operation;
    } finally {
      if (this.#running === operation) this.#running = null;
    }
  }
  async #reconcile() {
    try {
      await this.#harness.ensureRunning();
      if (this.#closed) return;
      const status = await this.#controller.initialize();
      if (this.#closed) return;
      this.#resolveReady?.(status);
      this.#resolveReady = null;
      const { configured, connected } = status.totals;
      if (connected < configured) {
        const delay2 = this.#retryDelays[Math.min(this.#retryIndex, this.#retryDelays.length - 1)];
        this.#retryIndex += 1;
        this.#logger.warn?.(`[dsh-im:qq] ${connected}/${configured} bots connected; retrying in ${delay2}ms`);
        this.#schedule(delay2);
        return;
      }
      this.#retryIndex = 0;
      this.#schedule(this.#healthyIntervalMs);
    } catch (error) {
      if (this.#closed) return;
      const delay2 = this.#retryDelays[Math.min(this.#retryIndex, this.#retryDelays.length - 1)];
      this.#retryIndex += 1;
      this.#logger.warn?.(`[dsh-im:qq] connection reconciliation failed; retrying in ${delay2}ms`, error);
      this.#schedule(delay2);
    }
  }
};
function createConnectionSupervisor3(options) {
  return new ConnectionSupervisor3(options);
}

// plugin-src/host/channels/qq/production.mjs
function harnessOrigin3(webServer, configured) {
  if (configured !== void 0) return new URL(configured);
  const port = webServer?.port;
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("dsh-im QQ requires an initialized DSH webServer port");
  }
  return new URL(`http://127.0.0.1:${port}`);
}
function pluginPaths3(config) {
  const dshHome = resolve3(config.dshHome ?? process.env.DSH_HOME ?? join3(homedir3(), ".dsh"));
  const root = resolve3(config.dataDir ?? join3(dshHome, "integrations", "dsh-qq"));
  return {
    config: resolve3(config.configPath ?? join3(root, "config.json")),
    bots: resolve3(config.botsDir ?? join3(root, "bots"))
  };
}
async function createProductionController3(ctx, config = {}, internals = {}) {
  if (!ctx?.credentials) throw new TypeError("dsh-im QQ requires ctx.credentials");
  if (!ctx?.webServer) throw new TypeError("dsh-im QQ requires ctx.webServer");
  const ConfigStore = internals.ConfigStore ?? QqConfigStore;
  const StateStore2 = internals.StateStore ?? QqStateStore;
  const Harness = internals.HarnessClient ?? QqHarnessClient;
  const Controller = internals.Controller ?? QqController;
  const Runtime = internals.Runtime ?? QqRuntime;
  const QrAuth = internals.QrAuth ?? QqQrAuth;
  const createSupervisor = internals.createConnectionSupervisor ?? createConnectionSupervisor3;
  const logger = typeof ctx.logger === "function" ? ctx.logger("dsh-im:qq") : ctx.logger ?? console;
  const paths = pluginPaths3(config);
  const configStore = await new ConfigStore(paths.config).load();
  const qrAuth = internals.qrAuth ?? new QrAuth({ source: config.qrSource ?? "deepseek-harness" });
  const stateStores = /* @__PURE__ */ new Map();
  const statePath = (botId) => resolve3(paths.bots, botId, "state.json");
  const stateFor = async (botId) => {
    let state = stateStores.get(botId);
    if (!state) {
      state = await new StateStore2(statePath(botId)).load();
      stateStores.set(botId, state);
    }
    return state;
  };
  const harness = new Harness({
    baseUrl: harnessOrigin3(ctx.webServer, config.harnessBaseUrl),
    workspace: resolve3(config.workspace ?? process.cwd()),
    agentPreset: config.agentPreset ?? "standard",
    autostart: false,
    dshBin: config.dshBin ?? "dsh"
  });
  const controller = new Controller({
    qrAuth,
    credentials: ctx.credentials,
    configStore,
    logger,
    createRuntime: async ({ botId, config: botConfig, appSecret }) => new Runtime({
      config: botConfig,
      appSecret,
      harness,
      state: await stateFor(botId),
      replyTimeoutMs: config.replyTimeoutMs ?? 6e5,
      connectTimeoutMs: config.connectTimeoutMs ?? 2e4,
      logger: {
        error: (...args) => logger.error?.(`[${botId}]`, ...args),
        warn: (...args) => logger.warn?.(`[${botId}]`, ...args),
        info: (...args) => logger.info?.(`[${botId}]`, ...args),
        debug: (...args) => logger.debug?.(`[${botId}]`, ...args)
      }
    }),
    deleteState: async ({ botId }) => {
      const state = stateStores.get(botId);
      stateStores.delete(botId);
      if (state && typeof state.remove === "function") return state.remove();
      try {
        await unlink8(statePath(botId));
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
      }
    }
  });
  const supervisor = createSupervisor({
    controller,
    harness,
    logger,
    retryDelaysMs: config.retryDelaysMs,
    healthyIntervalMs: config.healthyIntervalMs
  }).start();
  return {
    controller,
    ready: supervisor.ready,
    async close() {
      await supervisor.close();
      await controller.close();
      harness.stopManagedProcess();
    }
  };
}

// plugin-src/host/channels/qq/rpc.mjs
import QRCode3 from "qrcode";
var QQ_RPC_CHANNEL = "/qq";
var QQ_ENDPOINTS = Object.freeze({
  status: "connection.status",
  beginProvisioning: "provision.begin",
  pollProvisioning: "provision.poll",
  cancelProvisioning: "provision.cancel",
  reconnectBot: "bot.reconnect",
  deleteBot: "bot.delete"
});
var QQ_RPC_ENDPOINTS = Object.freeze(Object.values(QQ_ENDPOINTS));
var FORBIDDEN_PUBLIC_KEYS2 = /* @__PURE__ */ new Set([
  "appSecret",
  "app_secret",
  "secretRef",
  "ownerUserOpenid",
  "userOpenid",
  "verificationUrl"
]);
function isRecord2(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function exactKeys2(value, allowed) {
  return isRecord2(value) && Object.keys(value).every((key) => allowed.includes(key));
}
function validId2(value) {
  return typeof value === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(value);
}
function payloadFailure2(endpoint, payload) {
  if (!isRecord2(payload)) return "Payload must be an object.";
  if (endpoint === QQ_ENDPOINTS.status) return exactKeys2(payload, []) ? null : "connection.status does not accept fields.";
  if (endpoint === QQ_ENDPOINTS.beginProvisioning) {
    return exactKeys2(payload, ["locale"]) && (payload.locale === void 0 || payload.locale === "zh-CN") ? null : "provision.begin received unsupported fields.";
  }
  if ([QQ_ENDPOINTS.pollProvisioning, QQ_ENDPOINTS.cancelProvisioning].includes(endpoint)) {
    return exactKeys2(payload, ["attemptId"]) && validId2(payload.attemptId) ? null : `${endpoint} requires an attemptId.`;
  }
  if (endpoint === QQ_ENDPOINTS.reconnectBot) {
    return exactKeys2(payload, ["botId"]) && validId2(payload.botId) ? null : "bot.reconnect requires a botId.";
  }
  if (endpoint === QQ_ENDPOINTS.deleteBot) {
    return exactKeys2(payload, ["botId", "confirm"]) && validId2(payload.botId) && payload.confirm === true ? null : "bot.delete requires a botId and confirm=true.";
  }
  return "Unknown QQ endpoint.";
}
function sanitizePublic2(value) {
  if (Array.isArray(value)) return value.map(sanitizePublic2);
  if (!isRecord2(value)) return value;
  const safe = {};
  for (const [key, child] of Object.entries(value)) {
    if (!FORBIDDEN_PUBLIC_KEYS2.has(key)) safe[key] = sanitizePublic2(child);
  }
  return safe;
}
async function qrDataUrl2(value) {
  return QRCode3.toDataURL(value, {
    type: "image/png",
    errorCorrectionLevel: "M",
    margin: 2,
    width: 320
  });
}
async function withEncodedQr2(value, encodeQr) {
  if (!value || typeof value.verificationUrl !== "string") return sanitizePublic2(value);
  return sanitizePublic2({ ...value, qrCodeDataUrl: await encodeQr(value.verificationUrl) });
}
async function publicStatus2(status, encodeQr) {
  const value = structuredClone(status);
  if (value?.provisioning) value.provisioning = await withEncodedQr2(value.provisioning, encodeQr);
  return sanitizePublic2(value);
}
function createQqRpcHandler(controller, { encodeQr = qrDataUrl2 } = {}) {
  for (const method of ["status", "startProvisioning", "registrationStatus", "cancelProvisioning", "reconnectBot", "deleteBot"]) {
    if (typeof controller?.[method] !== "function") throw new TypeError(`A complete QQ controller is required (${method})`);
  }
  const qrCache = /* @__PURE__ */ new Map();
  const cachedEncode = (url) => {
    let encoded = qrCache.get(url);
    if (!encoded) {
      if (qrCache.size >= 16) qrCache.delete(qrCache.keys().next().value);
      encoded = Promise.resolve().then(() => encodeQr(url));
      qrCache.set(url, encoded);
    }
    return encoded;
  };
  return async (endpoint, payload, signal) => {
    if (signal?.aborted) return { ok: false, error: { code: "cancelled", message: "The request was cancelled." } };
    if (!QQ_RPC_ENDPOINTS.includes(endpoint)) return { ok: false, error: { code: "bad-request", message: "Unknown QQ endpoint." } };
    const invalid = payloadFailure2(endpoint, payload);
    if (invalid) return { ok: false, error: { code: "bad-request", message: invalid } };
    try {
      let value;
      if (endpoint === QQ_ENDPOINTS.status) value = await publicStatus2(await controller.status(), cachedEncode);
      else if (endpoint === QQ_ENDPOINTS.beginProvisioning) value = await withEncodedQr2(await controller.startProvisioning(), cachedEncode);
      else if (endpoint === QQ_ENDPOINTS.pollProvisioning) {
        const current = await controller.registrationStatus(payload.attemptId);
        if (!current) return { ok: false, error: { code: "bad-request", message: "The provisioning attempt no longer exists." } };
        value = await withEncodedQr2(current, cachedEncode);
      } else if (endpoint === QQ_ENDPOINTS.cancelProvisioning) {
        value = sanitizePublic2(await controller.cancelProvisioning(payload.attemptId));
      } else if (endpoint === QQ_ENDPOINTS.reconnectBot) {
        value = await publicStatus2(await controller.reconnectBot(payload.botId), cachedEncode);
      } else {
        value = await publicStatus2(await controller.deleteBot(payload.botId), cachedEncode);
      }
      return signal?.aborted ? { ok: false, error: { code: "cancelled", message: "The request was cancelled." } } : { ok: true, value };
    } catch {
      return signal?.aborted ? { ok: false, error: { code: "cancelled", message: "The request was cancelled." } } : { ok: false, error: { code: "qq-operation-failed", message: "QQ \u64CD\u4F5C\u5931\u8D25\uFF0C\u8BF7\u7A0D\u540E\u91CD\u8BD5\u3002" } };
    }
  };
}
function installQqRpc(ctx, controller, options) {
  if (!ctx?.connection?.rpc || typeof ctx.connection.rpc.handle !== "function") {
    throw new TypeError("DSH Host Connection RPC is required");
  }
  return ctx.connection.rpc.handle(QQ_RPC_CHANNEL, createQqRpcHandler(controller, options), { authority: "loopback" });
}

// plugin-src/host/channels/qq/index.mjs
async function apply3(ctx, config = {}) {
  if (config?.controller) return installQqRpc(ctx, config.controller, config.rpcOptions);
  const production = await createProductionController3(ctx, config, config.internals);
  const disposeRpc = installQqRpc(ctx, production.controller, config.rpcOptions);
  ctx.effect(() => async () => production.close(), "dsh-im: close QQ bot connections");
  return disposeRpc;
}

// plugin-src/host/channels/wecom/production.mjs
import { unlink as unlink11 } from "node:fs/promises";
import { homedir as homedir4 } from "node:os";
import { join as join4, resolve as resolve4 } from "node:path";

// src/channels/wecom/config-store.mjs
import { createHash as createHash4 } from "node:crypto";
import { mkdir as mkdir7, readFile as readFile7, rename as rename7, unlink as unlink9, writeFile as writeFile7 } from "node:fs/promises";
import { dirname as dirname7 } from "node:path";
var EMPTY_DOCUMENT3 = Object.freeze({ version: 1, bots: Object.freeze([]) });
function cleanString7(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}
function safeIntegrationId(value) {
  const id = cleanString7(value);
  return id && /^wecom_[a-f0-9]{24}$/.test(id) ? id : null;
}
function safeSecretRef3(value) {
  const ref = cleanString7(value);
  return ref && /^DSH_WECOM_BOT_SECRET_[A-F0-9]{24}$/.test(ref) ? ref : null;
}
function deriveWecomBotIdentity(remoteBotId) {
  const raw = cleanString7(remoteBotId);
  if (!raw) throw new TypeError("Enterprise WeChat bot ID is required");
  const digest2 = createHash4("sha256").update(raw).digest("hex").slice(0, 24);
  return {
    botId: `wecom_${digest2}`,
    secretRef: `DSH_WECOM_BOT_SECRET_${digest2.toUpperCase()}`
  };
}
function maskWecomBotId(remoteBotId) {
  const value = cleanString7(remoteBotId) ?? "";
  if (!value) return "\u4F01\u4E1A\u5FAE\u4FE1\u673A\u5668\u4EBA";
  if (value.length <= 10) return `${value.slice(0, 3)}\u2022\u2022\u2022`;
  return `${value.slice(0, 6)}\u2022\u2022\u2022\u2022${value.slice(-4)}`;
}
function normalizeBot4(value) {
  if (!value || typeof value !== "object") return null;
  const botId = safeIntegrationId(value.botId);
  const remoteBotId = cleanString7(value.remoteBotId);
  const secretRef = safeSecretRef3(value.secretRef);
  if (!botId || !remoteBotId || !secretRef) return null;
  const derived = deriveWecomBotIdentity(remoteBotId);
  if (derived.botId !== botId || derived.secretRef !== secretRef) return null;
  return Object.freeze({
    botId,
    remoteBotId,
    secretRef,
    createdAt: cleanString7(value.createdAt) ?? (/* @__PURE__ */ new Date()).toISOString(),
    connectedAt: cleanString7(value.connectedAt)
  });
}
function normalizeDocument4(value) {
  if (!value || value.version !== 1 || !Array.isArray(value.bots)) return null;
  const bots = value.bots.map(normalizeBot4);
  if (bots.some((bot) => bot === null)) return null;
  const ids = /* @__PURE__ */ new Set();
  const remoteIds = /* @__PURE__ */ new Set();
  const refs = /* @__PURE__ */ new Set();
  for (const bot of bots) {
    if (ids.has(bot.botId) || remoteIds.has(bot.remoteBotId) || refs.has(bot.secretRef)) return null;
    ids.add(bot.botId);
    remoteIds.add(bot.remoteBotId);
    refs.add(bot.secretRef);
  }
  return Object.freeze({ version: 1, bots: Object.freeze(bots) });
}
var WecomConfigStore = class {
  #path;
  #value = EMPTY_DOCUMENT3;
  #writeQueue = Promise.resolve();
  constructor(path) {
    this.#path = path;
  }
  async load() {
    try {
      const normalized = normalizeDocument4(JSON.parse(await readFile7(this.#path, "utf8")));
      if (!normalized) throw new Error("dsh-im Enterprise WeChat config contains invalid bot data");
      this.#value = normalized;
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
      this.#value = EMPTY_DOCUMENT3;
    }
    return this;
  }
  list() {
    return structuredClone(this.#value.bots);
  }
  get(botId) {
    const bot = this.#value.bots.find((candidate) => candidate.botId === botId);
    return bot ? structuredClone(bot) : null;
  }
  getByRemoteBotId(remoteBotId) {
    const bot = this.#value.bots.find((candidate) => candidate.remoteBotId === remoteBotId);
    return bot ? structuredClone(bot) : null;
  }
  async save(value) {
    const normalized = normalizeBot4(value);
    if (!normalized) throw new Error("Refusing to persist incomplete Enterprise WeChat bot data");
    return this.#mutate((bots) => {
      const remoteCollision = bots.find(
        (bot) => bot.remoteBotId === normalized.remoteBotId && bot.botId !== normalized.botId
      );
      const refCollision = bots.find(
        (bot) => bot.secretRef === normalized.secretRef && bot.botId !== normalized.botId
      );
      if (remoteCollision || refCollision) throw new Error("Duplicate Enterprise WeChat bot identity");
      const index = bots.findIndex((bot) => bot.botId === normalized.botId);
      if (index === -1) bots.push(normalized);
      else bots[index] = normalized;
      return structuredClone(normalized);
    });
  }
  async remove(botId) {
    if (!safeIntegrationId(botId)) throw new TypeError("Invalid Enterprise WeChat bot ID");
    return this.#mutate((bots) => {
      const index = bots.findIndex((bot) => bot.botId === botId);
      if (index === -1) return null;
      const [removed] = bots.splice(index, 1);
      return structuredClone(removed);
    });
  }
  async clear() {
    const operation = this.#writeQueue.then(async () => {
      try {
        await unlink9(this.#path);
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
      }
      this.#value = EMPTY_DOCUMENT3;
    });
    this.#writeQueue = operation.then(() => void 0, () => void 0);
    await operation;
  }
  async #mutate(mutator) {
    let result;
    const operation = this.#writeQueue.then(async () => {
      const bots = [...this.#value.bots];
      result = mutator(bots);
      const document = Object.freeze({ version: 1, bots: Object.freeze(bots) });
      await this.#write(document);
      this.#value = document;
    });
    this.#writeQueue = operation.then(() => void 0, () => void 0);
    await operation;
    return result;
  }
  async #write(document) {
    await mkdir7(dirname7(this.#path), { recursive: true, mode: 448 });
    const temporary = `${this.#path}.tmp`;
    await writeFile7(temporary, `${JSON.stringify(document, null, 2)}
`, {
      encoding: "utf8",
      mode: 384
    });
    await rename7(temporary, this.#path);
  }
};

// src/channels/wecom/harness-client.mjs
var WecomHarnessClient = class extends HarnessClient3 {
};

// src/channels/wecom/qr-auth.mjs
var GENERATE_URL = "https://work.weixin.qq.com/ai/qc/generate";
var POLL_URL = "https://work.weixin.qq.com/ai/qc/query_result";
var QR_TTL_MS2 = 5 * 6e4;
var POLL_INTERVAL_MS = 3e3;
function defaultPlatform() {
  if (process.platform === "win32") return 2;
  if (process.platform === "linux") return 3;
  return 1;
}
function cleanString8(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}
function safeVerificationUrl(value) {
  const raw = cleanString8(value);
  if (!raw) return null;
  try {
    const url = new URL(raw);
    return url.protocol === "https:" && url.hostname === "work.weixin.qq.com" && (!url.port || url.port === "443") ? url.href : null;
  } catch {
    return null;
  }
}
function combinedSignal(signal, timeoutMs) {
  return signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs);
}
async function requestJson2(fetchImpl, url, signal) {
  const response = await fetchImpl(url, {
    method: "GET",
    redirect: "error",
    signal: combinedSignal(signal, 1e4),
    headers: { accept: "application/json" }
  });
  if (!response.ok) throw new Error(`Enterprise WeChat QR service returned HTTP ${response.status}`);
  return response.json();
}
var WecomQrAuth = class {
  #fetch;
  #clock;
  #source;
  #platform;
  constructor({
    fetch: fetchImpl = globalThis.fetch,
    clock = () => Date.now(),
    source = "deepseek-harness",
    platform = defaultPlatform()
  } = {}) {
    if (typeof fetchImpl !== "function") throw new TypeError("A fetch implementation is required");
    this.#fetch = fetchImpl;
    this.#clock = clock;
    this.#source = source;
    this.#platform = [1, 2, 3].includes(platform) ? platform : defaultPlatform();
  }
  async start({ signal } = {}) {
    const url = new URL(GENERATE_URL);
    url.searchParams.set("source", this.#source);
    url.searchParams.set("plat", String(this.#platform));
    const body = await requestJson2(this.#fetch, url, signal);
    const scode = cleanString8(body?.data?.scode);
    const verificationUrl = safeVerificationUrl(body?.data?.auth_url);
    if (!scode || !verificationUrl) throw new Error("Enterprise WeChat QR service returned invalid data");
    return {
      scode,
      verificationUrl,
      expiresAt: this.#clock() + QR_TTL_MS2,
      pollIntervalMs: POLL_INTERVAL_MS
    };
  }
  async poll({ scode, signal } = {}) {
    const code = cleanString8(scode);
    if (!code) throw new TypeError("Enterprise WeChat QR poll code is required");
    const url = new URL(POLL_URL);
    url.searchParams.set("scode", code);
    const body = await requestJson2(this.#fetch, url, signal);
    const state = cleanString8(body?.data?.status)?.toLowerCase();
    if (state === "success") {
      const remoteBotId = cleanString8(body?.data?.bot_info?.botid);
      const secret = cleanString8(body?.data?.bot_info?.secret);
      if (!remoteBotId || !secret) throw new Error("Enterprise WeChat QR result omitted bot credentials");
      return { status: "success", remoteBotId, secret };
    }
    if (["expired", "timeout"].includes(state)) return { status: "expired" };
    if (["fail", "failed", "error"].includes(state)) return { status: "failed" };
    return { status: "waiting" };
  }
};

// src/channels/wecom/state-store.mjs
import { mkdir as mkdir8, readFile as readFile8, rename as rename8, unlink as unlink10, writeFile as writeFile8 } from "node:fs/promises";
import { dirname as dirname8 } from "node:path";
var EMPTY_STATE4 = Object.freeze({ version: 1, sessions: {}, seenMessageIds: [] });
function normalizeState3(value) {
  if (!value || typeof value !== "object") return structuredClone(EMPTY_STATE4);
  const sessions = {};
  if (value.sessions && typeof value.sessions === "object" && !Array.isArray(value.sessions)) {
    for (const [key, sessionId] of Object.entries(value.sessions)) {
      if (typeof key === "string" && typeof sessionId === "string" && sessionId) sessions[key] = sessionId;
    }
  }
  return {
    version: 1,
    sessions,
    seenMessageIds: Array.isArray(value.seenMessageIds) ? value.seenMessageIds.filter((id) => typeof id === "string").slice(-1e3) : []
  };
}
var WecomStateStore = class {
  #path;
  #state = structuredClone(EMPTY_STATE4);
  #writeQueue = Promise.resolve();
  constructor(path) {
    this.#path = path;
  }
  async load() {
    try {
      this.#state = normalizeState3(JSON.parse(await readFile8(this.#path, "utf8")));
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
      this.#state = structuredClone(EMPTY_STATE4);
      await this.#persist();
    }
    return this;
  }
  sessionFor(key) {
    return this.#state.sessions[key] ?? null;
  }
  async setSession(key, sessionId) {
    this.#state.sessions[key] = sessionId;
    await this.#persist();
  }
  async clearSession(key) {
    delete this.#state.sessions[key];
    await this.#persist();
  }
  hasSeen(messageId) {
    return this.#state.seenMessageIds.includes(messageId);
  }
  async markSeen(messageId) {
    if (this.hasSeen(messageId)) return;
    this.#state.seenMessageIds.push(messageId);
    if (this.#state.seenMessageIds.length > 1e3) {
      this.#state.seenMessageIds.splice(0, this.#state.seenMessageIds.length - 1e3);
    }
    await this.#persist();
  }
  async remove() {
    try {
      await unlink10(this.#path);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    this.#state = structuredClone(EMPTY_STATE4);
  }
  async #persist() {
    const snapshot = `${JSON.stringify(this.#state, null, 2)}
`;
    const operation = this.#writeQueue.then(async () => {
      await mkdir8(dirname8(this.#path), { recursive: true, mode: 448 });
      const temporary = `${this.#path}.tmp`;
      await writeFile8(temporary, snapshot, { encoding: "utf8", mode: 384 });
      await rename8(temporary, this.#path);
    });
    this.#writeQueue = operation.then(() => void 0, () => void 0);
    await operation;
  }
};

// src/channels/wecom/wecom-controller.mjs
import { randomUUID as randomUUID10 } from "node:crypto";
var ACTIVE_ATTEMPT_STATES3 = /* @__PURE__ */ new Set(["pending", "connecting"]);
var TERMINAL_ATTEMPT_STATES3 = /* @__PURE__ */ new Set(["connected", "failed", "cancelled", "expired"]);
function cleanString9(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}
function safeError3(code, message) {
  return Object.freeze({ code, message });
}
function publicAttempt3(record) {
  if (!record) return null;
  return {
    attemptId: record.id,
    status: record.state,
    pollIntervalMs: record.pollIntervalMs,
    qrRevision: record.qrRevision,
    ...record.verificationUrl ? { verificationUrl: record.verificationUrl } : {},
    ...record.expiresAt ? { expiresAt: record.expiresAt } : {},
    ...record.botId ? { botId: record.botId } : {},
    ...record.error ? { error: structuredClone(record.error) } : {}
  };
}
var WecomController = class {
  #qrAuth;
  #credentials;
  #configStore;
  #createRuntime;
  #deleteState;
  #logger;
  #runtimes = /* @__PURE__ */ new Map();
  #errors = /* @__PURE__ */ new Map();
  #attempts = /* @__PURE__ */ new Map();
  #activeAttemptId = null;
  #transitions = /* @__PURE__ */ new Map();
  #revision = 0;
  #closed = false;
  constructor({
    qrAuth,
    credentials,
    configStore,
    createRuntime,
    deleteState = async () => {
    },
    logger = console
  }) {
    if (!qrAuth || typeof qrAuth.start !== "function" || typeof qrAuth.poll !== "function") {
      throw new TypeError("Enterprise WeChat QR auth is required");
    }
    if (!credentials || typeof credentials.resolve !== "function" || typeof credentials.set !== "function" || typeof credentials.unset !== "function") {
      throw new TypeError("WecomController requires the DSH credential provider");
    }
    if (!configStore || typeof configStore.list !== "function" || typeof configStore.save !== "function" || typeof configStore.remove !== "function") {
      throw new TypeError("WecomController requires a config store");
    }
    if (typeof createRuntime !== "function") throw new TypeError("createRuntime is required");
    this.#qrAuth = qrAuth;
    this.#credentials = credentials;
    this.#configStore = configStore;
    this.#createRuntime = createRuntime;
    this.#deleteState = deleteState;
    this.#logger = logger;
  }
  async initialize() {
    if (this.#closed) return this.status();
    for (const config of this.#configStore.list()) {
      await this.#withBotTransition(config.botId, async () => {
        const existing = this.#runtimes.get(config.botId)?.status;
        if (this.#closed || existing?.ready || existing?.wecomConnectionState === "connecting") return;
        const secret = await this.#resolveSecret(config.secretRef);
        if (!secret) {
          this.#errors.set(config.botId, safeError3("missing-secret", "\u4F01\u4E1A\u5FAE\u4FE1\u673A\u5668\u4EBA\u51ED\u636E\u7F3A\u5931\uFF0C\u8BF7\u79FB\u9664\u540E\u91CD\u65B0\u626B\u7801\u3002"));
          return;
        }
        try {
          await this.#startRuntime(config, secret);
          this.#errors.delete(config.botId);
        } catch (error) {
          this.#errors.set(config.botId, safeError3("connection-failed", "\u4F01\u4E1A\u5FAE\u4FE1\u8FDE\u63A5\u672A\u5C31\u7EEA\uFF0C\u63D2\u4EF6\u4F1A\u81EA\u52A8\u91CD\u8BD5\u3002"));
          this.#logger.warn?.(`[dsh-im:wecom] bot ${config.botId} failed to initialize`);
        } finally {
          this.#touch();
        }
      });
    }
    return this.status();
  }
  async startProvisioning() {
    if (this.#closed) throw new Error("Enterprise WeChat controller is closed");
    if (this.#activeAttemptId) await this.cancelProvisioning(this.#activeAttemptId);
    const record = {
      id: randomUUID10(),
      state: "pending",
      createdAt: Date.now(),
      expiresAt: null,
      pollIntervalMs: 3e3,
      qrRevision: 1,
      verificationUrl: null,
      scode: null,
      botId: null,
      error: null,
      controller: new AbortController(),
      polling: null,
      transition: null
    };
    this.#attempts.set(record.id, record);
    this.#activeAttemptId = record.id;
    this.#touch();
    try {
      const started = await this.#qrAuth.start({ signal: record.controller.signal });
      record.scode = cleanString9(started.scode);
      record.verificationUrl = cleanString9(started.verificationUrl);
      record.expiresAt = Number(started.expiresAt);
      record.pollIntervalMs = Math.min(1e4, Math.max(500, Number(started.pollIntervalMs) || 3e3));
      if (!record.scode || !record.verificationUrl || !Number.isFinite(record.expiresAt)) {
        throw new Error("Enterprise WeChat QR auth returned incomplete data");
      }
      this.#touch();
      return publicAttempt3(record);
    } catch (error) {
      record.state = record.controller.signal.aborted ? "cancelled" : "failed";
      record.error = record.controller.signal.aborted ? safeError3("cancelled", "\u626B\u7801\u7ED1\u5B9A\u5DF2\u53D6\u6D88\u3002") : safeError3("qr-start-failed", "\u65E0\u6CD5\u751F\u6210\u4F01\u4E1A\u5FAE\u4FE1\u4E8C\u7EF4\u7801\uFF0C\u8BF7\u7A0D\u540E\u91CD\u8BD5\u3002");
      this.#finishAttempt(record);
      throw error;
    }
  }
  async registrationStatus(attemptId) {
    const record = this.#attempts.get(attemptId);
    if (!record || TERMINAL_ATTEMPT_STATES3.has(record.state)) return publicAttempt3(record);
    if (record.state === "connecting") {
      await record.transition?.catch(() => void 0);
      return publicAttempt3(record);
    }
    if (Date.now() >= record.expiresAt) {
      record.state = "expired";
      record.error = safeError3("expired", "\u4F01\u4E1A\u5FAE\u4FE1\u4E8C\u7EF4\u7801\u5DF2\u8FC7\u671F\uFF0C\u8BF7\u91CD\u65B0\u751F\u6210\u3002");
      record.controller.abort();
      this.#finishAttempt(record);
      return publicAttempt3(record);
    }
    if (!record.polling) {
      const polling = this.#pollAttempt(record).finally(() => {
        if (record.polling === polling) record.polling = null;
      });
      record.polling = polling;
    }
    await record.polling.catch(() => void 0);
    return publicAttempt3(record);
  }
  async cancelProvisioning(attemptId) {
    const record = this.#attempts.get(attemptId);
    if (!record) return null;
    if (!TERMINAL_ATTEMPT_STATES3.has(record.state)) {
      record.controller.abort();
      await Promise.allSettled([record.polling, record.transition].filter(Boolean));
      if (!TERMINAL_ATTEMPT_STATES3.has(record.state)) record.state = "cancelled";
      record.error ??= safeError3("cancelled", "\u626B\u7801\u7ED1\u5B9A\u5DF2\u53D6\u6D88\u3002");
      this.#finishAttempt(record);
    }
    return publicAttempt3(record);
  }
  async reconnectBot(botId) {
    const config = this.#configStore.get(botId);
    if (!config) throw new Error("Unknown Enterprise WeChat bot");
    await this.#withBotTransition(botId, async () => {
      const secret = await this.#resolveSecret(config.secretRef);
      if (!secret) throw new Error("Enterprise WeChat bot secret is missing");
      try {
        await this.#startRuntime(config, secret);
        this.#errors.delete(botId);
      } catch (error) {
        this.#errors.set(botId, safeError3("connection-failed", "\u4F01\u4E1A\u5FAE\u4FE1\u8FDE\u63A5\u4ECD\u672A\u5C31\u7EEA\uFF0C\u8BF7\u7A0D\u540E\u91CD\u8BD5\u3002"));
        throw error;
      } finally {
        this.#touch();
      }
    });
    return this.status();
  }
  async deleteBot(botId) {
    const config = this.#configStore.get(botId);
    if (!config) throw new Error("Unknown Enterprise WeChat bot");
    await this.#withBotTransition(botId, async () => {
      const previous = await this.#credentials.resolve(config.secretRef).catch(() => void 0);
      await this.#stopRuntime(botId);
      try {
        await this.#credentials.unset(config.secretRef);
        await this.#configStore.remove(botId);
      } catch (error) {
        if (previous?.value) {
          await this.#credentials.set(config.secretRef, previous.value).catch(() => void 0);
          await this.#startRuntime(config, previous.value).catch(() => void 0);
        }
        throw new Error("Unable to remove the Enterprise WeChat bot safely.", { cause: error });
      }
      await this.#deleteState({ botId, config }).catch((error) => {
        this.#logger.warn?.(`[dsh-im:wecom] bot ${botId} state cleanup failed:`, error);
      });
      this.#errors.delete(botId);
      this.#touch();
    });
    return this.status();
  }
  status() {
    const bots = this.#configStore.list().map((config) => {
      const runtimeStatus2 = this.#runtimes.get(config.botId)?.status ?? null;
      const connected = runtimeStatus2?.ready === true && runtimeStatus2.wecomConnectionState === "connected" && runtimeStatus2.harnessReachable === true;
      const state = connected ? "connected" : runtimeStatus2?.wecomConnectionState === "connecting" ? "connecting" : this.#errors.has(config.botId) || runtimeStatus2?.wecomConnectionState === "failed" ? "error" : "offline";
      return {
        botId: config.botId,
        state,
        connected,
        configured: true,
        bot: { name: "\u4F01\u4E1A\u5FAE\u4FE1\u673A\u5668\u4EBA", appIdMasked: maskWecomBotId(config.remoteBotId) },
        health: {
          status: connected ? "healthy" : state === "error" ? "error" : "offline",
          summary: connected ? "\u4F01\u4E1A\u5FAE\u4FE1 WebSocket \u957F\u8FDE\u63A5\u8FD0\u884C\u6B63\u5E38" : state === "error" ? "\u4F01\u4E1A\u5FAE\u4FE1\u8FDE\u63A5\u672A\u5C31\u7EEA\uFF0C\u63D2\u4EF6\u4F1A\u81EA\u52A8\u91CD\u8BD5" : "\u4F01\u4E1A\u5FAE\u4FE1\u8FDE\u63A5\u5F53\u524D\u79BB\u7EBF",
          lastCheckedAt: runtimeStatus2?.lastCheckedAt ?? null,
          lastConnectedAt: runtimeStatus2?.lastConnectedAt ?? null
        },
        stats: {
          messagesReceived: runtimeStatus2?.messagesReceived ?? 0,
          messagesReplied: runtimeStatus2?.messagesReplied ?? 0
        },
        error: structuredClone(this.#errors.get(config.botId) ?? null)
      };
    });
    const connectedCount = bots.filter((bot) => bot.connected).length;
    const active = this.#activeAttemptId ? this.#attempts.get(this.#activeAttemptId) : null;
    return {
      schemaVersion: 1,
      revision: this.#revision,
      state: active && ACTIVE_ATTEMPT_STATES3.has(active.state) ? "provisioning" : bots.length === 0 ? "disconnected" : connectedCount === bots.length ? "connected" : connectedCount > 0 ? "degraded" : "offline",
      bots,
      totals: { configured: bots.length, connected: connectedCount },
      ...active && ACTIVE_ATTEMPT_STATES3.has(active.state) ? { provisioning: publicAttempt3(active) } : {}
    };
  }
  async close() {
    if (this.#closed) return;
    this.#closed = true;
    if (this.#activeAttemptId) await this.cancelProvisioning(this.#activeAttemptId);
    await Promise.allSettled([...this.#runtimes.keys()].map((botId) => this.#stopRuntime(botId)));
  }
  async #pollAttempt(record) {
    try {
      const result = await this.#qrAuth.poll({ scode: record.scode, signal: record.controller.signal });
      if (record.controller.signal.aborted || TERMINAL_ATTEMPT_STATES3.has(record.state)) return;
      if (result.status === "waiting") return;
      if (result.status === "expired") {
        record.state = "expired";
        record.error = safeError3("expired", "\u4F01\u4E1A\u5FAE\u4FE1\u4E8C\u7EF4\u7801\u5DF2\u8FC7\u671F\uFF0C\u8BF7\u91CD\u65B0\u751F\u6210\u3002");
        this.#finishAttempt(record);
        return;
      }
      if (result.status !== "success") {
        record.state = "failed";
        record.error = safeError3("qr-connect-failed", "\u4F01\u4E1A\u5FAE\u4FE1\u626B\u7801\u6CA1\u6709\u5B8C\u6210\uFF0C\u8BF7\u91CD\u65B0\u751F\u6210\u4E8C\u7EF4\u7801\u3002");
        this.#finishAttempt(record);
        return;
      }
      record.state = "connecting";
      record.verificationUrl = null;
      record.expiresAt = null;
      record.scode = null;
      this.#touch();
      const transition = this.#completeProvisioning(record, result);
      record.transition = transition;
      await transition;
    } catch (error) {
      if (record.controller.signal.aborted) return;
      record.state = "failed";
      record.error = safeError3("qr-connect-failed", "\u4F01\u4E1A\u5FAE\u4FE1\u626B\u7801\u670D\u52A1\u6682\u65F6\u4E0D\u53EF\u7528\uFF0C\u8BF7\u91CD\u65B0\u751F\u6210\u4E8C\u7EF4\u7801\u3002");
      this.#logger.warn?.("[dsh-im:wecom] QR polling failed");
      this.#finishAttempt(record);
    }
  }
  async #completeProvisioning(record, result) {
    try {
      const remoteBotId = cleanString9(result.remoteBotId);
      const secret = cleanString9(result.secret);
      if (!remoteBotId || !secret) throw new Error("Enterprise WeChat authorization returned incomplete credentials");
      record.botId = await this.#activateBot(record, { remoteBotId, secret });
      record.state = "connected";
      record.error = null;
    } catch (error) {
      if (record.controller.signal.aborted) {
        record.state = "cancelled";
        record.error = safeError3("cancelled", "\u626B\u7801\u7ED1\u5B9A\u5DF2\u53D6\u6D88\u3002");
      } else {
        record.state = "failed";
        record.error = safeError3("activation-failed", "\u4F01\u4E1A\u5FAE\u4FE1\u5DF2\u6388\u6743\uFF0C\u4F46\u65E0\u6CD5\u5B89\u5168\u4FDD\u5B58\u63A5\u5165\u914D\u7F6E\u3002");
        this.#logger.error?.("[dsh-im:wecom] provisioning failed");
      }
    } finally {
      this.#finishAttempt(record);
    }
  }
  async #activateBot(record, { remoteBotId, secret }) {
    const identity = deriveWecomBotIdentity(remoteBotId);
    const previousConfig = this.#configStore.getByRemoteBotId(remoteBotId);
    const previousSecret = await this.#credentials.resolve(identity.secretRef).catch(() => void 0);
    const config = {
      botId: identity.botId,
      remoteBotId,
      secretRef: identity.secretRef,
      createdAt: previousConfig?.createdAt ?? (/* @__PURE__ */ new Date()).toISOString(),
      connectedAt: (/* @__PURE__ */ new Date()).toISOString()
    };
    return this.#withBotTransition(identity.botId, async () => {
      await this.#credentials.set(identity.secretRef, secret);
      try {
        if (record.controller.signal.aborted) throw new DOMException("Cancelled", "AbortError");
        await this.#configStore.save(config);
      } catch (error) {
        await this.#restoreCredential(identity.secretRef, previousSecret);
        throw error;
      }
      try {
        if (record.controller.signal.aborted) throw new DOMException("Cancelled", "AbortError");
        await this.#startRuntime(config, secret);
        this.#errors.delete(identity.botId);
      } catch (error) {
        if (record.controller.signal.aborted) {
          await this.#stopRuntime(identity.botId);
          if (previousConfig) await this.#configStore.save(previousConfig).catch(() => void 0);
          else await this.#configStore.remove(identity.botId).catch(() => void 0);
          await this.#restoreCredential(identity.secretRef, previousSecret);
          throw error;
        }
        this.#errors.set(identity.botId, safeError3("connection-failed", "\u4F01\u4E1A\u5FAE\u4FE1\u673A\u5668\u4EBA\u5DF2\u7ED1\u5B9A\uFF0C\u6D88\u606F\u8FDE\u63A5\u6682\u672A\u5C31\u7EEA\u3002"));
        this.#logger.warn?.(`[dsh-im:wecom] bot ${identity.botId} activation connection failed`);
      }
      this.#touch();
      return identity.botId;
    });
  }
  async #startRuntime(config, secret) {
    await this.#stopRuntime(config.botId);
    const runtime = await this.#createRuntime({ botId: config.botId, config, secret });
    if (!runtime || typeof runtime.start !== "function" || typeof runtime.stop !== "function") {
      throw new TypeError("createRuntime returned an invalid Enterprise WeChat runtime");
    }
    this.#runtimes.set(config.botId, runtime);
    try {
      await runtime.start();
    } catch (error) {
      await runtime.stop().catch(() => void 0);
      this.#runtimes.delete(config.botId);
      throw error;
    }
  }
  async #stopRuntime(botId) {
    const runtime = this.#runtimes.get(botId);
    this.#runtimes.delete(botId);
    await runtime?.stop().catch((error) => {
      this.#logger.warn?.(`[dsh-im:wecom] bot ${botId} failed to stop cleanly:`, error);
    });
  }
  async #resolveSecret(ref) {
    const result = await this.#credentials.resolve(ref).catch(() => void 0);
    return cleanString9(result?.value);
  }
  async #restoreCredential(ref, previous) {
    if (previous?.value) await this.#credentials.set(ref, previous.value).catch(() => void 0);
    else await this.#credentials.unset(ref).catch(() => void 0);
  }
  #withBotTransition(botId, operation) {
    const previous = this.#transitions.get(botId) ?? Promise.resolve();
    const current = previous.catch(() => void 0).then(operation);
    const settled = current.finally(() => {
      if (this.#transitions.get(botId) === settled) this.#transitions.delete(botId);
    });
    this.#transitions.set(botId, settled);
    return settled;
  }
  #finishAttempt(record) {
    record.scode = null;
    record.verificationUrl = null;
    record.expiresAt = null;
    if (this.#activeAttemptId === record.id) this.#activeAttemptId = null;
    this.#touch();
    const terminal = [...this.#attempts.values()].filter((attempt) => TERMINAL_ATTEMPT_STATES3.has(attempt.state));
    while (terminal.length > 16) this.#attempts.delete(terminal.shift().id);
  }
  #touch() {
    this.#revision += 1;
  }
};

// src/channels/wecom/wecom-runtime.mjs
import { WSAuthFailureError, WSClient, WSReconnectExhaustedError } from "@wecom/aibot-node-sdk";

// src/channels/wecom/wecom-bridge.mjs
import { generateReqId } from "@wecom/aibot-node-sdk";
var HELP_TEXT4 = [
  "\u4F01\u4E1A\u5FAE\u4FE1\u673A\u5668\u4EBA\u5DF2\u8FDE\u63A5 DeepSeek Harness\u3002",
  "",
  "\u76F4\u63A5\u53D1\u9001\u6587\u5B57\u5373\u53EF\u7EE7\u7EED\u5F53\u524D\u4F1A\u8BDD\u3002",
  "/new  \u5F00\u542F\u4E00\u4E2A\u5168\u65B0\u4F1A\u8BDD",
  "/status  \u68C0\u67E5\u8FDE\u63A5\u72B6\u6001",
  "/help  \u663E\u793A\u672C\u5E2E\u52A9"
].join("\n");
var MAX_REPLY_BYTES = 18e3;
function bodyOf(frame) {
  return frame?.body && typeof frame.body === "object" ? frame.body : {};
}
function conversationKey4(frame) {
  const body = bodyOf(frame);
  return body.chattype === "group" ? `group:${body.chatid}` : `direct:${body.from?.userid}`;
}
function messageText2(frame) {
  const body = bodyOf(frame);
  if (body.msgtype === "text") return typeof body.text?.content === "string" ? body.text.content.trim() : "";
  if (body.msgtype === "voice") return typeof body.voice?.content === "string" ? body.voice.content.trim() : "";
  if (body.msgtype === "mixed" && Array.isArray(body.mixed?.msg_item)) {
    return body.mixed.msg_item.filter((item) => item?.msgtype === "text" && typeof item.text?.content === "string").map((item) => item.text.content).join("\n").trim();
  }
  return "";
}
function splitUtf8(text, maxBytes = MAX_REPLY_BYTES) {
  const source = String(text ?? "").trim();
  if (!source) return [];
  const chunks = [];
  let current = "";
  let bytes = 0;
  for (const character of source) {
    const size = Buffer.byteLength(character);
    if (current && bytes + size > maxBytes) {
      chunks.push(current);
      current = character;
      bytes = size;
    } else {
      current += character;
      bytes += size;
    }
  }
  if (current) chunks.push(current);
  return chunks;
}
function progressText2(update) {
  if (update?.type === "text") return update.text;
  if (update?.type === "tool") return `\u6B63\u5728\u4F7F\u7528${update.name}\u2026`;
  return update?.text;
}
function createWecomBridgeStatus() {
  return {
    messagesReceived: 0,
    messagesReplied: 0,
    messagesRejected: 0,
    lastMessageAt: null,
    lastReplyAt: null,
    lastRejectedAt: null,
    lastError: null
  };
}
var WecomHarnessBridge = class {
  #client;
  #harness;
  #state;
  #status;
  #logger;
  #replyTimeoutMs;
  #generateReqId;
  #queues = /* @__PURE__ */ new Map();
  constructor({
    client,
    harness,
    state,
    status = createWecomBridgeStatus(),
    logger = console,
    replyTimeoutMs = 6e5,
    generateStreamId = generateReqId
  }) {
    if (!client || typeof client.replyStream !== "function" || typeof client.sendMessage !== "function") {
      throw new TypeError("Enterprise WeChat client is required");
    }
    if (!harness || !state) throw new TypeError("Harness client and state store are required");
    this.#client = client;
    this.#harness = harness;
    this.#state = state;
    this.#status = status;
    this.#logger = logger;
    this.#replyTimeoutMs = replyTimeoutMs;
    this.#generateReqId = generateStreamId;
  }
  get status() {
    return structuredClone(this.#status);
  }
  accept(frame) {
    const key = conversationKey4(frame);
    const previous = this.#queues.get(key) ?? Promise.resolve();
    const current = previous.catch(() => void 0).then(() => this.#process(frame)).finally(() => {
      if (this.#queues.get(key) === current) this.#queues.delete(key);
    });
    this.#queues.set(key, current);
    return current;
  }
  async waitForIdle() {
    await Promise.allSettled([...this.#queues.values()]);
  }
  async #sendActive(chatId, text) {
    for (const chunk of splitUtf8(text)) {
      await this.#client.sendMessage(chatId, { msgtype: "markdown", markdown: { content: chunk } });
    }
  }
  async #sendImmediate(frame, chatId, text) {
    const chunks = splitUtf8(text);
    if (chunks.length === 0) return;
    try {
      await this.#client.replyStream(frame, this.#generateReqId("stream"), chunks[0], true);
      for (const chunk of chunks.slice(1)) {
        await this.#client.sendMessage(chatId, { msgtype: "markdown", markdown: { content: chunk } });
      }
    } catch {
      await this.#sendActive(chatId, text);
    }
  }
  async #process(frame) {
    const body = bodyOf(frame);
    const messageId = typeof body.msgid === "string" ? body.msgid : "";
    const senderId = typeof body.from?.userid === "string" ? body.from.userid : "";
    const chatId = body.chattype === "group" ? body.chatid : senderId;
    if (!messageId || !senderId || !chatId || !["single", "group"].includes(body.chattype)) return;
    if (this.#state.hasSeen(messageId)) return;
    this.#status.messagesReceived += 1;
    this.#status.lastMessageAt = (/* @__PURE__ */ new Date()).toISOString();
    const text = messageText2(frame);
    let streamId = null;
    let streamStarted = false;
    try {
      if (!text) {
        await this.#sendImmediate(frame, chatId, "\u76EE\u524D\u652F\u6301\u6587\u5B57\u3001\u8BED\u97F3\u8F6C\u5199\u548C\u56FE\u6587\u6DF7\u6392\u4E2D\u7684\u6587\u5B57\u6D88\u606F\u3002");
        await this.#state.markSeen(messageId);
        return;
      }
      const command = text.toLowerCase();
      if (command === "/help") {
        await this.#sendImmediate(frame, chatId, HELP_TEXT4);
        await this.#state.markSeen(messageId);
        return;
      }
      if (command === "/status") {
        await this.#harness.ensureRunning();
        await this.#sendImmediate(frame, chatId, "\u4F01\u4E1A\u5FAE\u4FE1\u673A\u5668\u4EBA\u4E0E DeepSeek Harness \u8FDE\u63A5\u6B63\u5E38\u3002");
        await this.#state.markSeen(messageId);
        return;
      }
      const key = conversationKey4(frame);
      if (command === "/new") {
        await this.#state.clearSession(key);
        await this.#sendImmediate(frame, chatId, "\u5DF2\u5F00\u542F\u65B0\u4F1A\u8BDD\u3002\u8BF7\u53D1\u9001\u4F60\u7684\u95EE\u9898\u3002");
        await this.#state.markSeen(messageId);
        return;
      }
      let sessionId = this.#state.sessionFor(key);
      if (!sessionId || !await this.#harness.sessionExists(sessionId)) {
        sessionId = await this.#harness.createSession();
        await this.#state.setSession(key, sessionId);
      }
      streamId = this.#generateReqId("stream");
      try {
        await this.#client.replyStream(frame, streamId, "\u6B63\u5728\u601D\u8003\u4E2D\u2026", false);
        streamStarted = true;
      } catch (error) {
        this.#logger.warn?.("[dsh-im:wecom] unable to start a stream; using an active reply:", error);
      }
      const answer = await this.#harness.ask(sessionId, text, {
        timeoutMs: this.#replyTimeoutMs,
        onUpdate: streamStarted && typeof this.#client.replyStreamNonBlocking === "function" ? async (update) => {
          const progress = splitUtf8(progressText2(update))[0];
          if (progress) await this.#client.replyStreamNonBlocking(frame, streamId, progress, false);
        } : void 0
      });
      const chunks = splitUtf8(answer || "\u4EFB\u52A1\u5DF2\u5B8C\u6210\uFF0C\u4F46\u6CA1\u6709\u751F\u6210\u53EF\u663E\u793A\u7684\u6587\u672C\u3002");
      let finalSent = false;
      if (streamStarted && chunks.length > 0) {
        try {
          await this.#client.replyStream(frame, streamId, chunks[0], true);
          for (const chunk of chunks.slice(1)) {
            await this.#client.sendMessage(chatId, { msgtype: "markdown", markdown: { content: chunk } });
          }
          finalSent = true;
        } catch (error) {
          this.#logger.warn?.("[dsh-im:wecom] stream finalization failed; using an active reply:", error);
        }
      }
      if (!finalSent) await this.#sendActive(chatId, answer);
      await this.#state.markSeen(messageId);
      this.#status.messagesReplied += 1;
      this.#status.lastReplyAt = (/* @__PURE__ */ new Date()).toISOString();
      this.#status.lastError = null;
    } catch (error) {
      this.#status.lastError = error?.message ?? String(error);
      this.#logger.error?.("[dsh-im:wecom] failed to process an inbound message");
      try {
        if (streamStarted && streamId) {
          await this.#client.replyStream(frame, streamId, "\u6D88\u606F\u5904\u7406\u5931\u8D25\uFF0C\u8BF7\u7A0D\u540E\u91CD\u8BD5\u3002", true);
        } else {
          await this.#sendImmediate(frame, chatId, "\u6D88\u606F\u5904\u7406\u5931\u8D25\uFF0C\u8BF7\u7A0D\u540E\u91CD\u8BD5\u3002");
        }
        await this.#state.markSeen(messageId);
      } catch {
        this.#logger.error?.("[dsh-im:wecom] failed to send the safe error reply");
      }
    }
  }
};

// src/channels/wecom/wecom-runtime.mjs
function timeoutError2() {
  const error = new Error("Enterprise WeChat WebSocket authentication timed out");
  error.code = "connect-timeout";
  return error;
}
function createWecomRuntimeStatus() {
  return {
    startedAt: null,
    ready: false,
    wecomConnectionState: "idle",
    harnessReachable: false,
    lastCheckedAt: null,
    lastConnectedAt: null,
    lastError: null,
    ...createWecomBridgeStatus()
  };
}
var WecomRuntime = class {
  #config;
  #secret;
  #harness;
  #state;
  #logger;
  #replyTimeoutMs;
  #connectTimeoutMs;
  #maxReconnectAttempts;
  #createClient;
  #status = createWecomRuntimeStatus();
  #client = null;
  #bridge = null;
  #starting = null;
  #startController = null;
  constructor({
    config,
    secret,
    harness,
    state,
    logger = console,
    replyTimeoutMs = 6e5,
    connectTimeoutMs = 2e4,
    maxReconnectAttempts = 10,
    createClient = (options) => new WSClient(options)
  }) {
    if (!config || !secret || !harness || !state) {
      throw new TypeError("WecomRuntime requires config, secret, Harness, and state");
    }
    this.#config = config;
    this.#secret = secret;
    this.#harness = harness;
    this.#state = state;
    this.#logger = logger;
    this.#replyTimeoutMs = replyTimeoutMs;
    this.#connectTimeoutMs = connectTimeoutMs;
    this.#maxReconnectAttempts = maxReconnectAttempts;
    this.#createClient = createClient;
  }
  get status() {
    return structuredClone(this.#status);
  }
  async start() {
    if (this.#status.ready && this.#client) return this.status;
    if (this.#starting) return this.#starting;
    const controller = new AbortController();
    this.#startController = controller;
    this.#starting = this.#start(controller.signal).finally(() => {
      if (this.#startController === controller) this.#startController = null;
      this.#starting = null;
    });
    return this.#starting;
  }
  async #start(signal) {
    await this.#stopActive();
    signal.throwIfAborted();
    this.#status.startedAt = (/* @__PURE__ */ new Date()).toISOString();
    this.#status.wecomConnectionState = "connecting";
    this.#status.lastError = null;
    await this.#harness.ensureRunning();
    this.#status.harnessReachable = true;
    const silentSdkLogger = { debug() {
    }, info() {
    }, warn() {
    }, error() {
    } };
    const client = this.#createClient({
      botId: this.#config.remoteBotId,
      secret: this.#secret,
      logger: silentSdkLogger,
      maxReconnectAttempts: this.#maxReconnectAttempts
    });
    if (!client || typeof client.connect !== "function" || typeof client.disconnect !== "function") {
      throw new TypeError("Enterprise WeChat client factory returned an invalid client");
    }
    this.#client = client;
    this.#bridge = new WecomHarnessBridge({
      client,
      harness: this.#harness,
      state: this.#state,
      status: this.#status,
      logger: this.#logger,
      replyTimeoutMs: this.#replyTimeoutMs
    });
    let readyResolve;
    let readyReject;
    let authenticated = false;
    const ready = new Promise((resolve6, reject) => {
      readyResolve = resolve6;
      readyReject = reject;
    });
    const onAuthenticated = () => {
      if (this.#client !== client || signal.aborted) return;
      authenticated = true;
      const now = Date.now();
      this.#status.ready = true;
      this.#status.wecomConnectionState = "connected";
      this.#status.lastCheckedAt = now;
      this.#status.lastConnectedAt = now;
      this.#status.lastError = null;
      readyResolve();
    };
    const onDisconnected = () => {
      if (this.#client !== client) return;
      this.#status.ready = false;
      this.#status.wecomConnectionState = "connecting";
      this.#status.lastCheckedAt = Date.now();
    };
    const onReconnecting = () => {
      if (this.#client !== client) return;
      this.#status.ready = false;
      this.#status.wecomConnectionState = "connecting";
      this.#status.lastCheckedAt = Date.now();
    };
    const onError = (error) => {
      if (this.#client !== client) return;
      const terminal = error instanceof WSAuthFailureError || error instanceof WSReconnectExhaustedError;
      if (!authenticated && terminal) readyReject(error);
      if (terminal) {
        this.#status.ready = false;
        this.#status.wecomConnectionState = "failed";
      }
      this.#status.lastError = terminal ? error.name : "connection-error";
      this.#logger.warn?.(`[dsh-im:wecom] bot ${this.#config.botId} connection error`);
    };
    const onMessage = (frame) => this.#bridge?.accept(frame);
    client.on("authenticated", onAuthenticated);
    client.on("disconnected", onDisconnected);
    client.on("reconnecting", onReconnecting);
    client.on("error", onError);
    client.on("message", onMessage);
    let timer;
    try {
      client.connect();
      await Promise.race([
        ready,
        new Promise((_, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        }),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(timeoutError2()), this.#connectTimeoutMs);
        })
      ]);
      return this.status;
    } catch (error) {
      if (signal.aborted) {
        await this.#stopActive();
        throw error;
      }
      this.#status.ready = false;
      this.#status.wecomConnectionState = "failed";
      this.#status.lastError = error?.message ?? String(error);
      await this.#stopActive();
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }
  async stop() {
    const starting = this.#starting;
    this.#startController?.abort(new DOMException("Enterprise WeChat runtime stopped", "AbortError"));
    await this.#stopActive();
    await starting?.catch(() => void 0);
    return this.status;
  }
  async #stopActive() {
    const client = this.#client;
    const bridge = this.#bridge;
    this.#client = null;
    this.#bridge = null;
    try {
      client?.disconnect();
      client?.removeAllListeners?.();
    } catch (error) {
      this.#logger.warn?.(`[dsh-im:wecom] bot ${this.#config.botId} failed to stop cleanly`);
    }
    await bridge?.waitForIdle();
    this.#status.ready = false;
    this.#status.wecomConnectionState = "idle";
  }
};

// plugin-src/host/channels/wecom/connection-supervisor.mjs
var DEFAULT_RETRY_DELAYS_MS4 = Object.freeze([250, 1e3, 3e3, 5e3, 1e4, 3e4]);
function retryDelays3(value) {
  if (!Array.isArray(value) || value.length === 0) return [...DEFAULT_RETRY_DELAYS_MS4];
  const valid = value.filter((delay2) => Number.isFinite(delay2) && delay2 >= 0);
  return valid.length > 0 ? valid : [...DEFAULT_RETRY_DELAYS_MS4];
}
var ConnectionSupervisor4 = class {
  #controller;
  #harness;
  #logger;
  #retryDelays;
  #healthyIntervalMs;
  #setTimeout;
  #clearTimeout;
  #timer = null;
  #running = null;
  #retryIndex = 0;
  #closed = false;
  #started = false;
  #ready;
  #resolveReady;
  constructor({
    controller,
    harness,
    logger = console,
    retryDelaysMs,
    healthyIntervalMs = 15e3,
    setTimeoutImpl = setTimeout,
    clearTimeoutImpl = clearTimeout
  }) {
    if (!controller || typeof controller.initialize !== "function" || typeof controller.status !== "function") {
      throw new TypeError("ConnectionSupervisor requires a controller");
    }
    if (!harness || typeof harness.ensureRunning !== "function") {
      throw new TypeError("ConnectionSupervisor requires a Harness client");
    }
    this.#controller = controller;
    this.#harness = harness;
    this.#logger = logger;
    this.#retryDelays = retryDelays3(retryDelaysMs);
    this.#healthyIntervalMs = Number.isFinite(healthyIntervalMs) && healthyIntervalMs >= 0 ? healthyIntervalMs : 15e3;
    this.#setTimeout = setTimeoutImpl;
    this.#clearTimeout = clearTimeoutImpl;
    this.#ready = new Promise((resolve6) => {
      this.#resolveReady = resolve6;
    });
  }
  get ready() {
    return this.#ready;
  }
  start() {
    if (this.#started || this.#closed) return this;
    this.#started = true;
    this.#schedule(0);
    return this;
  }
  async close() {
    if (this.#closed) return;
    this.#closed = true;
    if (this.#timer !== null) this.#clearTimeout(this.#timer);
    this.#timer = null;
    await this.#running?.catch(() => void 0);
    this.#resolveReady?.(null);
    this.#resolveReady = null;
  }
  #schedule(delayMs) {
    if (this.#closed) return;
    this.#timer = this.#setTimeout(() => {
      this.#timer = null;
      void this.#run();
    }, delayMs);
    this.#timer?.unref?.();
  }
  async #run() {
    if (this.#closed || this.#running) return;
    const operation = this.#reconcile();
    this.#running = operation;
    try {
      await operation;
    } finally {
      if (this.#running === operation) this.#running = null;
    }
  }
  async #reconcile() {
    try {
      await this.#harness.ensureRunning();
      if (this.#closed) return;
      const status = await this.#controller.initialize();
      if (this.#closed) return;
      this.#resolveReady?.(status);
      this.#resolveReady = null;
      const { configured, connected } = status.totals;
      if (connected < configured) {
        const delay2 = this.#retryDelays[Math.min(this.#retryIndex, this.#retryDelays.length - 1)];
        this.#retryIndex += 1;
        this.#logger.warn?.(`[dsh-im:wecom] ${connected}/${configured} bots connected; retrying in ${delay2}ms`);
        this.#schedule(delay2);
        return;
      }
      this.#retryIndex = 0;
      this.#schedule(this.#healthyIntervalMs);
    } catch (error) {
      if (this.#closed) return;
      const delay2 = this.#retryDelays[Math.min(this.#retryIndex, this.#retryDelays.length - 1)];
      this.#retryIndex += 1;
      this.#logger.warn?.(`[dsh-im:wecom] connection reconciliation failed; retrying in ${delay2}ms`, error);
      this.#schedule(delay2);
    }
  }
};
function createConnectionSupervisor4(options) {
  return new ConnectionSupervisor4(options);
}

// plugin-src/host/channels/wecom/production.mjs
function harnessOrigin4(webServer, configured) {
  if (configured !== void 0) return new URL(configured);
  const port = webServer?.port;
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("dsh-im Enterprise WeChat requires an initialized DSH webServer port");
  }
  return new URL(`http://127.0.0.1:${port}`);
}
function pluginPaths4(config) {
  const dshHome = resolve4(config.dshHome ?? process.env.DSH_HOME ?? join4(homedir4(), ".dsh"));
  const root = resolve4(config.dataDir ?? join4(dshHome, "integrations", "dsh-wecom"));
  return {
    config: resolve4(config.configPath ?? join4(root, "config.json")),
    bots: resolve4(config.botsDir ?? join4(root, "bots"))
  };
}
async function createProductionController4(ctx, config = {}, internals = {}) {
  if (!ctx?.credentials) throw new TypeError("dsh-im Enterprise WeChat requires ctx.credentials");
  if (!ctx?.webServer) throw new TypeError("dsh-im Enterprise WeChat requires ctx.webServer");
  const ConfigStore = internals.ConfigStore ?? WecomConfigStore;
  const StateStore2 = internals.StateStore ?? WecomStateStore;
  const Harness = internals.HarnessClient ?? WecomHarnessClient;
  const Controller = internals.Controller ?? WecomController;
  const Runtime = internals.Runtime ?? WecomRuntime;
  const QrAuth = internals.QrAuth ?? WecomQrAuth;
  const createSupervisor = internals.createConnectionSupervisor ?? createConnectionSupervisor4;
  const logger = typeof ctx.logger === "function" ? ctx.logger("dsh-im:wecom") : ctx.logger ?? console;
  const paths = pluginPaths4(config);
  const configStore = await new ConfigStore(paths.config).load();
  const qrAuth = internals.qrAuth ?? new QrAuth({
    source: config.qrSource ?? "deepseek-harness",
    platform: config.qrPlatform
  });
  const stateStores = /* @__PURE__ */ new Map();
  const statePath = (botId) => resolve4(paths.bots, botId, "state.json");
  const stateFor = async (botId) => {
    let state = stateStores.get(botId);
    if (!state) {
      state = await new StateStore2(statePath(botId)).load();
      stateStores.set(botId, state);
    }
    return state;
  };
  const harness = new Harness({
    baseUrl: harnessOrigin4(ctx.webServer, config.harnessBaseUrl),
    workspace: resolve4(config.workspace ?? process.cwd()),
    agentPreset: config.agentPreset ?? "standard",
    autostart: false,
    dshBin: config.dshBin ?? "dsh"
  });
  const controller = new Controller({
    qrAuth,
    credentials: ctx.credentials,
    configStore,
    logger,
    createRuntime: async ({ botId, config: botConfig, secret }) => new Runtime({
      config: botConfig,
      secret,
      harness,
      state: await stateFor(botId),
      replyTimeoutMs: config.replyTimeoutMs ?? 6e5,
      connectTimeoutMs: config.connectTimeoutMs ?? 2e4,
      maxReconnectAttempts: config.maxReconnectAttempts ?? 10,
      logger: {
        error: (...args) => logger.error?.(`[${botId}]`, ...args),
        warn: (...args) => logger.warn?.(`[${botId}]`, ...args),
        info: (...args) => logger.info?.(`[${botId}]`, ...args),
        debug: (...args) => logger.debug?.(`[${botId}]`, ...args)
      }
    }),
    deleteState: async ({ botId }) => {
      const state = stateStores.get(botId);
      stateStores.delete(botId);
      if (state && typeof state.remove === "function") return state.remove();
      try {
        await unlink11(statePath(botId));
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
      }
    }
  });
  const supervisor = createSupervisor({
    controller,
    harness,
    logger,
    retryDelaysMs: config.retryDelaysMs,
    healthyIntervalMs: config.healthyIntervalMs
  }).start();
  return {
    controller,
    ready: supervisor.ready,
    async close() {
      await supervisor.close();
      await controller.close();
      harness.stopManagedProcess();
    }
  };
}

// plugin-src/host/channels/wecom/rpc.mjs
import QRCode4 from "qrcode";
var WECOM_RPC_CHANNEL = "/wecom";
var WECOM_ENDPOINTS = Object.freeze({
  status: "connection.status",
  beginProvisioning: "provision.begin",
  pollProvisioning: "provision.poll",
  cancelProvisioning: "provision.cancel",
  reconnectBot: "bot.reconnect",
  deleteBot: "bot.delete"
});
var WECOM_RPC_ENDPOINTS = Object.freeze(Object.values(WECOM_ENDPOINTS));
var FORBIDDEN_PUBLIC_KEYS3 = /* @__PURE__ */ new Set([
  "secret",
  "secretRef",
  "scode",
  "remoteBotId",
  "verificationUrl",
  "bot_info",
  "botid"
]);
function isRecord3(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function exactKeys3(value, allowed) {
  return isRecord3(value) && Object.keys(value).every((key) => allowed.includes(key));
}
function validId3(value) {
  return typeof value === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(value);
}
function payloadFailure3(endpoint, payload) {
  if (!isRecord3(payload)) return "Payload must be an object.";
  if (endpoint === WECOM_ENDPOINTS.status) return exactKeys3(payload, []) ? null : "connection.status does not accept fields.";
  if (endpoint === WECOM_ENDPOINTS.beginProvisioning) {
    return exactKeys3(payload, ["locale"]) && (payload.locale === void 0 || payload.locale === "zh-CN") ? null : "provision.begin received unsupported fields.";
  }
  if ([WECOM_ENDPOINTS.pollProvisioning, WECOM_ENDPOINTS.cancelProvisioning].includes(endpoint)) {
    return exactKeys3(payload, ["attemptId"]) && validId3(payload.attemptId) ? null : `${endpoint} requires an attemptId.`;
  }
  if (endpoint === WECOM_ENDPOINTS.reconnectBot) {
    return exactKeys3(payload, ["botId"]) && validId3(payload.botId) ? null : "bot.reconnect requires a botId.";
  }
  if (endpoint === WECOM_ENDPOINTS.deleteBot) {
    return exactKeys3(payload, ["botId", "confirm"]) && validId3(payload.botId) && payload.confirm === true ? null : "bot.delete requires a botId and confirm=true.";
  }
  return "Unknown Enterprise WeChat endpoint.";
}
function sanitizePublic3(value) {
  if (Array.isArray(value)) return value.map(sanitizePublic3);
  if (!isRecord3(value)) return value;
  const safe = {};
  for (const [key, child] of Object.entries(value)) {
    if (!FORBIDDEN_PUBLIC_KEYS3.has(key)) safe[key] = sanitizePublic3(child);
  }
  return safe;
}
async function qrDataUrl3(value) {
  return QRCode4.toDataURL(value, {
    type: "image/png",
    errorCorrectionLevel: "M",
    margin: 2,
    width: 320
  });
}
async function withEncodedQr3(value, encodeQr) {
  if (!value || typeof value.verificationUrl !== "string") return sanitizePublic3(value);
  return sanitizePublic3({ ...value, qrCodeDataUrl: await encodeQr(value.verificationUrl) });
}
async function publicStatus3(status, encodeQr) {
  const value = structuredClone(status);
  if (value?.provisioning) value.provisioning = await withEncodedQr3(value.provisioning, encodeQr);
  return sanitizePublic3(value);
}
function createWecomRpcHandler(controller, { encodeQr = qrDataUrl3 } = {}) {
  for (const method of ["status", "startProvisioning", "registrationStatus", "cancelProvisioning", "reconnectBot", "deleteBot"]) {
    if (typeof controller?.[method] !== "function") {
      throw new TypeError(`A complete Enterprise WeChat controller is required (${method})`);
    }
  }
  const qrCache = /* @__PURE__ */ new Map();
  const cachedEncode = (url) => {
    let encoded = qrCache.get(url);
    if (!encoded) {
      if (qrCache.size >= 16) qrCache.delete(qrCache.keys().next().value);
      encoded = Promise.resolve().then(() => encodeQr(url));
      qrCache.set(url, encoded);
    }
    return encoded;
  };
  return async (endpoint, payload, signal) => {
    if (signal?.aborted) return { ok: false, error: { code: "cancelled", message: "The request was cancelled." } };
    if (!WECOM_RPC_ENDPOINTS.includes(endpoint)) {
      return { ok: false, error: { code: "bad-request", message: "Unknown Enterprise WeChat endpoint." } };
    }
    const invalid = payloadFailure3(endpoint, payload);
    if (invalid) return { ok: false, error: { code: "bad-request", message: invalid } };
    try {
      let value;
      if (endpoint === WECOM_ENDPOINTS.status) value = await publicStatus3(await controller.status(), cachedEncode);
      else if (endpoint === WECOM_ENDPOINTS.beginProvisioning) {
        value = await withEncodedQr3(await controller.startProvisioning(), cachedEncode);
      } else if (endpoint === WECOM_ENDPOINTS.pollProvisioning) {
        const current = await controller.registrationStatus(payload.attemptId);
        if (!current) return { ok: false, error: { code: "bad-request", message: "The provisioning attempt no longer exists." } };
        value = await withEncodedQr3(current, cachedEncode);
      } else if (endpoint === WECOM_ENDPOINTS.cancelProvisioning) {
        value = sanitizePublic3(await controller.cancelProvisioning(payload.attemptId));
      } else if (endpoint === WECOM_ENDPOINTS.reconnectBot) {
        value = await publicStatus3(await controller.reconnectBot(payload.botId), cachedEncode);
      } else {
        value = await publicStatus3(await controller.deleteBot(payload.botId), cachedEncode);
      }
      return signal?.aborted ? { ok: false, error: { code: "cancelled", message: "The request was cancelled." } } : { ok: true, value };
    } catch {
      return signal?.aborted ? { ok: false, error: { code: "cancelled", message: "The request was cancelled." } } : { ok: false, error: { code: "wecom-operation-failed", message: "\u4F01\u4E1A\u5FAE\u4FE1\u64CD\u4F5C\u5931\u8D25\uFF0C\u8BF7\u7A0D\u540E\u91CD\u8BD5\u3002" } };
    }
  };
}
function installWecomRpc(ctx, controller, options) {
  if (!ctx?.connection?.rpc || typeof ctx.connection.rpc.handle !== "function") {
    throw new TypeError("DSH Host Connection RPC is required");
  }
  return ctx.connection.rpc.handle(
    WECOM_RPC_CHANNEL,
    createWecomRpcHandler(controller, options),
    { authority: "loopback" }
  );
}

// plugin-src/host/channels/wecom/index.mjs
async function apply4(ctx, config = {}) {
  if (config?.controller) return installWecomRpc(ctx, config.controller, config.rpcOptions);
  const production = await createProductionController4(ctx, config, config.internals);
  const disposeRpc = installWecomRpc(ctx, production.controller, config.rpcOptions);
  ctx.effect(() => async () => production.close(), "dsh-im: close Enterprise WeChat bot connections");
  return disposeRpc;
}

// plugin-src/host/channels/weixin/production.mjs
import { unlink as unlink14 } from "node:fs/promises";
import { homedir as homedir5 } from "node:os";
import { join as join5, resolve as resolve5 } from "node:path";

// src/channels/weixin/config-store.mjs
import { createHash as createHash5 } from "node:crypto";
import { mkdir as mkdir9, readFile as readFile9, rename as rename9, unlink as unlink12, writeFile as writeFile9 } from "node:fs/promises";
import { dirname as dirname9 } from "node:path";

// src/channels/weixin/weixin-api.mjs
import { randomBytes, randomUUID as randomUUID11 } from "node:crypto";
var WEIXIN_QR_BASE_URL = "https://ilinkai.weixin.qq.com/";
var WEIXIN_PROTOCOL_VERSION = "2.4.6";
var DEFAULT_BOT_TYPE = "3";
var ILINK_APP_ID = "bot";
var ILINK_CLIENT_VERSION = 2 << 16 | 4 << 8 | 6;
var DEFAULT_TIMEOUT_MS2 = 15e3;
var DEFAULT_LONG_POLL_TIMEOUT_MS = 35e3;
var LOGIN_STATUSES = /* @__PURE__ */ new Set([
  "wait",
  "scaned",
  "confirmed",
  "expired",
  "scaned_but_redirect",
  "need_verifycode",
  "verify_code_blocked",
  "binded_redirect"
]);
var WeixinApiError = class extends Error {
  constructor(code, message, options = {}) {
    super(message, options);
    this.name = "WeixinApiError";
    this.code = code;
    this.status = options.status;
  }
};
function nonEmptyString5(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}
function isWeixinHost(hostname) {
  const normalized = hostname.toLowerCase().replace(/\.$/, "");
  return normalized === "weixin.qq.com" || normalized.endsWith(".weixin.qq.com");
}
function normalizeWeixinApiBaseUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new WeixinApiError("invalid-base-url", "\u5FAE\u4FE1\u670D\u52A1\u8FD4\u56DE\u4E86\u65E0\u6548\u7684\u8FDE\u63A5\u5730\u5740\u3002");
  }
  if (url.protocol !== "https:" || !isWeixinHost(url.hostname) || url.port !== "" && url.port !== "443") {
    throw new WeixinApiError("untrusted-base-url", "\u5FAE\u4FE1\u670D\u52A1\u8FD4\u56DE\u4E86\u4E0D\u53D7\u4FE1\u4EFB\u7684\u8FDE\u63A5\u5730\u5740\u3002");
  }
  url.username = "";
  url.password = "";
  url.search = "";
  url.hash = "";
  if (!url.pathname.endsWith("/")) url.pathname += "/";
  return url.toString();
}
function normalizeWeixinQrUrl(value) {
  const text = nonEmptyString5(value);
  if (!text) throw new WeixinApiError("invalid-qr", "\u5FAE\u4FE1\u670D\u52A1\u6CA1\u6709\u8FD4\u56DE\u626B\u7801\u5730\u5740\u3002");
  let url;
  try {
    url = new URL(text);
  } catch {
    throw new WeixinApiError("invalid-qr", "\u5FAE\u4FE1\u670D\u52A1\u8FD4\u56DE\u4E86\u65E0\u6548\u7684\u626B\u7801\u5730\u5740\u3002");
  }
  if (url.protocol !== "https:" || !isWeixinHost(url.hostname)) {
    throw new WeixinApiError("untrusted-qr", "\u5FAE\u4FE1\u670D\u52A1\u8FD4\u56DE\u4E86\u4E0D\u53D7\u4FE1\u4EFB\u7684\u626B\u7801\u5730\u5740\u3002");
  }
  return url.toString();
}
function commonHeaders() {
  return {
    "iLink-App-Id": ILINK_APP_ID,
    "iLink-App-ClientVersion": String(ILINK_CLIENT_VERSION)
  };
}
function authenticatedHeaders(token) {
  const headers = {
    ...commonHeaders(),
    "content-type": "application/json",
    AuthorizationType: "ilink_bot_token",
    "X-WECHAT-UIN": Buffer.from(String(randomBytes(4).readUInt32BE(0)), "utf8").toString("base64")
  };
  if (nonEmptyString5(token)) headers.Authorization = `Bearer ${token.trim()}`;
  return headers;
}
function baseInfo() {
  return {
    channel_version: WEIXIN_PROTOCOL_VERSION,
    bot_agent: "DeepSeekHarness/0.1.0"
  };
}
function abortError3(signal) {
  if (signal?.reason instanceof Error) return signal.reason;
  return new DOMException("The operation was aborted", "AbortError");
}
async function requestJson3(fetchImpl, {
  method,
  baseUrl,
  endpoint,
  body,
  token,
  timeoutMs = DEFAULT_TIMEOUT_MS2,
  signal,
  authenticated = true
}) {
  const trustedBase = normalizeWeixinApiBaseUrl(baseUrl);
  const url = new URL(endpoint, trustedBase);
  if (!isWeixinHost(url.hostname)) {
    throw new WeixinApiError("untrusted-endpoint", "\u62D2\u7EDD\u8BBF\u95EE\u4E0D\u53D7\u4FE1\u4EFB\u7684\u5FAE\u4FE1\u670D\u52A1\u5730\u5740\u3002");
  }
  const controller = new AbortController();
  let timedOut = false;
  const onAbort = () => controller.abort(signal?.reason);
  if (signal?.aborted) throw abortError3(signal);
  signal?.addEventListener("abort", onAbort, { once: true });
  const timer = timeoutMs > 0 ? setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs) : null;
  try {
    const response = await fetchImpl(url, {
      method,
      headers: authenticated ? authenticatedHeaders(token) : commonHeaders(),
      ...body === void 0 ? {} : { body: JSON.stringify(body) },
      signal: controller.signal
    });
    if (!response.ok) {
      throw new WeixinApiError(
        "http-error",
        `\u5FAE\u4FE1\u670D\u52A1\u8BF7\u6C42\u5931\u8D25\uFF08HTTP ${response.status}\uFF09\u3002`,
        { status: response.status }
      );
    }
    try {
      return await response.json();
    } catch (error) {
      throw new WeixinApiError("invalid-response", "\u5FAE\u4FE1\u670D\u52A1\u8FD4\u56DE\u4E86\u65E0\u6CD5\u89E3\u6790\u7684\u54CD\u5E94\u3002", { cause: error });
    }
  } catch (error) {
    if (signal?.aborted) throw abortError3(signal);
    if (timedOut) {
      throw new WeixinApiError("timeout", "\u5FAE\u4FE1\u670D\u52A1\u8BF7\u6C42\u8D85\u65F6\u3002", { cause: error });
    }
    if (error instanceof WeixinApiError) throw error;
    throw new WeixinApiError("network-error", "\u6682\u65F6\u65E0\u6CD5\u8BBF\u95EE\u5FAE\u4FE1\u670D\u52A1\u3002", { cause: error });
  } finally {
    if (timer) clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  }
}
function validateLoginResponse(value) {
  if (!value || typeof value !== "object" || !LOGIN_STATUSES.has(value.status)) {
    throw new WeixinApiError("invalid-login-status", "\u5FAE\u4FE1\u670D\u52A1\u8FD4\u56DE\u4E86\u65E0\u6CD5\u8BC6\u522B\u7684\u626B\u7801\u72B6\u6001\u3002");
  }
  return value;
}
function createWeixinApi({ fetchImpl = fetch } = {}) {
  if (typeof fetchImpl !== "function") throw new TypeError("fetchImpl must be a function");
  return Object.freeze({
    async beginLogin({ localTokens = [], botType = DEFAULT_BOT_TYPE, signal } = {}) {
      const tokens = [...new Set(localTokens.map(nonEmptyString5).filter(Boolean))].slice(-10);
      const response = await requestJson3(fetchImpl, {
        method: "POST",
        baseUrl: WEIXIN_QR_BASE_URL,
        endpoint: `ilink/bot/get_bot_qrcode?bot_type=${encodeURIComponent(botType)}`,
        body: { local_token_list: tokens },
        timeoutMs: 1e4,
        signal
      });
      const qrcode = nonEmptyString5(response?.qrcode);
      if (!qrcode) throw new WeixinApiError("invalid-qr", "\u5FAE\u4FE1\u670D\u52A1\u6CA1\u6709\u8FD4\u56DE\u4E8C\u7EF4\u7801\u4EE4\u724C\u3002");
      return {
        qrcode,
        qrcodeUrl: normalizeWeixinQrUrl(response.qrcode_img_content)
      };
    },
    async pollLogin({ qrcode, baseUrl = WEIXIN_QR_BASE_URL, verifyCode, signal }) {
      const qr = nonEmptyString5(qrcode);
      if (!qr) throw new TypeError("qrcode is required");
      let endpoint = `ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(qr)}`;
      if (nonEmptyString5(verifyCode)) endpoint += `&verify_code=${encodeURIComponent(verifyCode.trim())}`;
      const response = await requestJson3(fetchImpl, {
        method: "GET",
        baseUrl,
        endpoint,
        timeoutMs: DEFAULT_LONG_POLL_TIMEOUT_MS,
        signal,
        authenticated: false
      });
      return validateLoginResponse(response);
    },
    async getUpdates({ baseUrl, token, getUpdatesBuf = "", timeoutMs, signal }) {
      try {
        return await requestJson3(fetchImpl, {
          method: "POST",
          baseUrl,
          endpoint: "ilink/bot/getupdates",
          body: { get_updates_buf: getUpdatesBuf, base_info: baseInfo() },
          token,
          timeoutMs: timeoutMs ?? DEFAULT_LONG_POLL_TIMEOUT_MS,
          signal
        });
      } catch (error) {
        if (error instanceof WeixinApiError && error.code === "timeout") {
          return { ret: 0, msgs: [], get_updates_buf: getUpdatesBuf };
        }
        throw error;
      }
    },
    async sendText({ baseUrl, token, toUserId, text, contextToken, runId, signal }) {
      const recipient = nonEmptyString5(toUserId);
      const content = nonEmptyString5(text);
      if (!recipient || !content) throw new TypeError("toUserId and text are required");
      const response = await requestJson3(fetchImpl, {
        method: "POST",
        baseUrl,
        endpoint: "ilink/bot/sendmessage",
        token,
        signal,
        body: {
          msg: {
            from_user_id: "",
            to_user_id: recipient,
            client_id: `dsh-weixin-${randomUUID11()}`,
            message_type: 2,
            message_state: 2,
            item_list: [{ type: 1, text_item: { text: content } }],
            ...nonEmptyString5(contextToken) ? { context_token: contextToken.trim() } : {},
            ...nonEmptyString5(runId) ? { run_id: runId.trim() } : {}
          },
          base_info: baseInfo()
        }
      });
      if (response?.ret !== void 0 && response.ret !== 0) {
        throw new WeixinApiError("send-rejected", "\u5FAE\u4FE1\u670D\u52A1\u62D2\u7EDD\u4E86\u56DE\u590D\u6D88\u606F\u3002");
      }
      return true;
    },
    async notifyStart({ baseUrl, token, signal }) {
      const response = await requestJson3(fetchImpl, {
        method: "POST",
        baseUrl,
        endpoint: "ilink/bot/msg/notifystart",
        token,
        signal,
        timeoutMs: 1e4,
        body: { base_info: baseInfo() }
      });
      if (response?.ret !== void 0 && response.ret !== 0) {
        throw new WeixinApiError("start-rejected", "\u5FAE\u4FE1\u8D26\u53F7\u8FDE\u63A5\u542F\u52A8\u5931\u8D25\u3002");
      }
      return response;
    },
    async notifyStop({ baseUrl, token, signal }) {
      return requestJson3(fetchImpl, {
        method: "POST",
        baseUrl,
        endpoint: "ilink/bot/msg/notifystop",
        token,
        signal,
        timeoutMs: 1e4,
        body: { base_info: baseInfo() }
      });
    }
  });
}
function extractWeixinText(message) {
  for (const item of message?.item_list ?? []) {
    if (item?.type === 1 && typeof item.text_item?.text === "string") {
      const text = item.text_item.text.trim();
      if (text) return text;
    }
    if (item?.type === 3 && typeof item.voice_item?.text === "string") {
      const text = item.voice_item.text.trim();
      if (text) return text;
    }
  }
  return null;
}
function weixinMessageId(message) {
  if (message?.message_id !== void 0 && message.message_id !== null) {
    return String(message.message_id);
  }
  return nonEmptyString5(message?.client_id);
}
function splitWeixinText(text, maxChars = 4e3) {
  if (text.length <= maxChars) return [text];
  const chunks = [];
  let remaining = text;
  while (remaining.length > maxChars) {
    let splitAt = remaining.lastIndexOf("\n", maxChars);
    if (splitAt < Math.floor(maxChars * 0.6)) splitAt = maxChars;
    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt).replace(/^\n+/, "");
  }
  if (remaining) chunks.push(remaining);
  return chunks;
}

// src/channels/weixin/config-store.mjs
var EMPTY_DOCUMENT4 = Object.freeze({ version: 1, accounts: Object.freeze([]) });
function cleanString10(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}
function safeBotId3(value) {
  const id = cleanString10(value);
  return id && /^wx_[a-f0-9]{24}$/.test(id) ? id : null;
}
function safeTokenRef(value) {
  const ref = cleanString10(value);
  return ref && /^DSH_WEIXIN_BOT_TOKEN_[A-F0-9]{24}$/.test(ref) ? ref : null;
}
function deriveWeixinBotIdentity(accountId) {
  const raw = cleanString10(accountId);
  if (!raw) throw new TypeError("accountId is required");
  const digest2 = createHash5("sha256").update(raw).digest("hex").slice(0, 24);
  return {
    botId: `wx_${digest2}`,
    tokenRef: `DSH_WEIXIN_BOT_TOKEN_${digest2.toUpperCase()}`
  };
}
function maskWeixinAccountId(accountId) {
  const value = cleanString10(accountId) ?? "";
  if (value.length <= 10) return value ? `${value.slice(0, 3)}\u2022\u2022\u2022` : "\u5FAE\u4FE1\u673A\u5668\u4EBA";
  return `${value.slice(0, 6)}\u2022\u2022\u2022\u2022${value.slice(-4)}`;
}
function normalizeAccount(value) {
  if (!value || typeof value !== "object") return null;
  const accountId = cleanString10(value.accountId);
  const ownerUserId = cleanString10(value.ownerUserId);
  const botId = safeBotId3(value.botId);
  const tokenRef = safeTokenRef(value.tokenRef);
  if (!accountId || !ownerUserId || !botId || !tokenRef) return null;
  const derived = deriveWeixinBotIdentity(accountId);
  if (derived.botId !== botId || derived.tokenRef !== tokenRef) return null;
  let baseUrl;
  try {
    baseUrl = normalizeWeixinApiBaseUrl(value.baseUrl);
  } catch {
    return null;
  }
  return Object.freeze({
    botId,
    accountId,
    tokenRef,
    ownerUserId,
    baseUrl,
    createdAt: cleanString10(value.createdAt) ?? (/* @__PURE__ */ new Date()).toISOString(),
    connectedAt: cleanString10(value.connectedAt)
  });
}
function normalizeDocument5(value) {
  if (!value || value.version !== 1 || !Array.isArray(value.accounts)) return null;
  const accounts = value.accounts.map(normalizeAccount);
  if (accounts.some((account) => account === null)) return null;
  const ids = /* @__PURE__ */ new Set();
  const accountIds = /* @__PURE__ */ new Set();
  const refs = /* @__PURE__ */ new Set();
  for (const account of accounts) {
    if (ids.has(account.botId) || accountIds.has(account.accountId) || refs.has(account.tokenRef)) {
      return null;
    }
    ids.add(account.botId);
    accountIds.add(account.accountId);
    refs.add(account.tokenRef);
  }
  return Object.freeze({ version: 1, accounts: Object.freeze(accounts) });
}
var WeixinConfigStore = class {
  #path;
  #value = EMPTY_DOCUMENT4;
  #writeQueue = Promise.resolve();
  constructor(path) {
    this.#path = path;
  }
  async load() {
    try {
      const normalized = normalizeDocument5(JSON.parse(await readFile9(this.#path, "utf8")));
      if (!normalized) throw new Error("dsh-weixin config contains invalid account data");
      this.#value = normalized;
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
      this.#value = EMPTY_DOCUMENT4;
    }
    return this;
  }
  list() {
    return structuredClone(this.#value.accounts);
  }
  get(botId) {
    const account = this.#value.accounts.find((candidate) => candidate.botId === botId);
    return account ? structuredClone(account) : null;
  }
  getByAccountId(accountId) {
    const account = this.#value.accounts.find((candidate) => candidate.accountId === accountId);
    return account ? structuredClone(account) : null;
  }
  async save(value) {
    const normalized = normalizeAccount(value);
    if (!normalized) throw new Error("Refusing to persist incomplete dsh-weixin account data");
    return this.#mutate((accounts) => {
      const accountCollision = accounts.find(
        (account) => account.accountId === normalized.accountId && account.botId !== normalized.botId
      );
      const refCollision = accounts.find(
        (account) => account.tokenRef === normalized.tokenRef && account.botId !== normalized.botId
      );
      if (accountCollision || refCollision) throw new Error("Duplicate Weixin account identity");
      const index = accounts.findIndex((account) => account.botId === normalized.botId);
      if (index === -1) accounts.push(normalized);
      else accounts[index] = normalized;
      return structuredClone(normalized);
    });
  }
  async remove(botId) {
    if (!safeBotId3(botId)) throw new TypeError("Invalid Weixin bot id");
    return this.#mutate((accounts) => {
      const index = accounts.findIndex((account) => account.botId === botId);
      if (index === -1) return null;
      const [removed] = accounts.splice(index, 1);
      return structuredClone(removed);
    });
  }
  async clear() {
    const operation = this.#writeQueue.then(async () => {
      try {
        await unlink12(this.#path);
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
      }
      this.#value = EMPTY_DOCUMENT4;
    });
    this.#writeQueue = operation.then(() => void 0, () => void 0);
    await operation;
  }
  async #mutate(mutator) {
    let result;
    const operation = this.#writeQueue.then(async () => {
      const accounts = [...this.#value.accounts];
      result = mutator(accounts);
      const document = Object.freeze({ version: 1, accounts: Object.freeze(accounts) });
      await this.#write(document);
      this.#value = document;
    });
    this.#writeQueue = operation.then(() => void 0, () => void 0);
    await operation;
    return result;
  }
  async #write(document) {
    await mkdir9(dirname9(this.#path), { recursive: true, mode: 448 });
    const temporary = `${this.#path}.tmp`;
    await writeFile9(temporary, `${JSON.stringify(document, null, 2)}
`, {
      encoding: "utf8",
      mode: 384
    });
    await rename9(temporary, this.#path);
  }
};

// src/channels/weixin/state-store.mjs
import { mkdir as mkdir10, readFile as readFile10, rename as rename10, unlink as unlink13, writeFile as writeFile10 } from "node:fs/promises";
import { dirname as dirname10 } from "node:path";
var EMPTY_STATE5 = Object.freeze({
  version: 1,
  sessions: {},
  seenMessageIds: [],
  getUpdatesBuf: ""
});
function normalizeState4(value) {
  if (!value || typeof value !== "object") return structuredClone(EMPTY_STATE5);
  const sessions = {};
  if (value.sessions && typeof value.sessions === "object" && !Array.isArray(value.sessions)) {
    for (const [key, sessionId] of Object.entries(value.sessions)) {
      if (typeof key === "string" && typeof sessionId === "string" && sessionId) {
        sessions[key] = sessionId;
      }
    }
  }
  return {
    version: 1,
    sessions,
    seenMessageIds: Array.isArray(value.seenMessageIds) ? value.seenMessageIds.filter((id) => typeof id === "string").slice(-1e3) : [],
    getUpdatesBuf: typeof value.getUpdatesBuf === "string" ? value.getUpdatesBuf : ""
  };
}
var WeixinStateStore = class {
  #path;
  #state = structuredClone(EMPTY_STATE5);
  #writeQueue = Promise.resolve();
  constructor(path) {
    this.#path = path;
  }
  async load() {
    try {
      this.#state = normalizeState4(JSON.parse(await readFile10(this.#path, "utf8")));
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
      this.#state = structuredClone(EMPTY_STATE5);
      await this.#persist();
    }
    return this;
  }
  sessionFor(key) {
    return this.#state.sessions[key] ?? null;
  }
  async setSession(key, sessionId) {
    this.#state.sessions[key] = sessionId;
    await this.#persist();
  }
  async clearSession(key) {
    delete this.#state.sessions[key];
    await this.#persist();
  }
  hasSeen(messageId) {
    return this.#state.seenMessageIds.includes(messageId);
  }
  async markSeen(messageId) {
    if (this.hasSeen(messageId)) return;
    this.#state.seenMessageIds.push(messageId);
    if (this.#state.seenMessageIds.length > 1e3) {
      this.#state.seenMessageIds.splice(0, this.#state.seenMessageIds.length - 1e3);
    }
    await this.#persist();
  }
  getUpdatesBuf() {
    return this.#state.getUpdatesBuf;
  }
  async setGetUpdatesBuf(value) {
    if (typeof value !== "string" || value === this.#state.getUpdatesBuf) return;
    this.#state.getUpdatesBuf = value;
    await this.#persist();
  }
  snapshot() {
    return structuredClone(this.#state);
  }
  async remove() {
    try {
      await unlink13(this.#path);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    this.#state = structuredClone(EMPTY_STATE5);
  }
  async #persist() {
    const snapshot = `${JSON.stringify(this.#state, null, 2)}
`;
    const operation = this.#writeQueue.then(async () => {
      await mkdir10(dirname10(this.#path), { recursive: true, mode: 448 });
      const temporary = `${this.#path}.tmp`;
      await writeFile10(temporary, snapshot, { encoding: "utf8", mode: 384 });
      await rename10(temporary, this.#path);
    });
    this.#writeQueue = operation.then(() => void 0, () => void 0);
    await operation;
  }
};

// src/channels/weixin/weixin-controller.mjs
import { randomUUID as randomUUID12 } from "node:crypto";
var ACTIVE_ATTEMPT_STATES4 = /* @__PURE__ */ new Set([
  "starting",
  "pending",
  "scanned",
  "needs_verification",
  "connecting"
]);
var TERMINAL_ATTEMPT_STATES4 = /* @__PURE__ */ new Set(["connected", "expired", "failed", "cancelled"]);
var QR_TTL_MS3 = 5 * 6e4;
function cleanString11(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}
function abortError4() {
  return new DOMException("Provisioning was cancelled", "AbortError");
}
function apiBaseFromServer(value, fallback) {
  const raw = cleanString11(value);
  if (!raw) return normalizeWeixinApiBaseUrl(fallback);
  return normalizeWeixinApiBaseUrl(raw.includes("://") ? raw : `https://${raw}`);
}
function publicAttempt4(record) {
  if (!record) return null;
  return {
    attemptId: record.id,
    status: record.state,
    ...record.verificationUrl ? { verificationUrl: record.verificationUrl } : {},
    ...record.expiresAt ? { expiresAt: record.expiresAt } : {},
    pollIntervalMs: 1e3,
    ...record.state === "needs_verification" ? { verificationRequired: true } : {},
    ...record.botId ? { botId: record.botId } : {},
    ...record.alreadyConnected ? { alreadyConnected: true } : {},
    ...record.error ? { error: structuredClone(record.error) } : {}
  };
}
function safeAccountError(code, message) {
  return Object.freeze({ code, message });
}
var WeixinController = class {
  #api;
  #credentials;
  #configStore;
  #createRuntime;
  #deleteState;
  #logger;
  #runtimes = /* @__PURE__ */ new Map();
  #errors = /* @__PURE__ */ new Map();
  #attempts = /* @__PURE__ */ new Map();
  #activeAttemptId = null;
  #transitions = /* @__PURE__ */ new Map();
  #revision = 0;
  #closed = false;
  constructor({
    api,
    credentials,
    configStore,
    createRuntime,
    deleteState = async () => {
    },
    logger = console
  }) {
    if (!api || typeof api.beginLogin !== "function" || typeof api.pollLogin !== "function") {
      throw new TypeError("WeixinController requires a Weixin API client");
    }
    if (!credentials || typeof credentials.resolve !== "function" || typeof credentials.set !== "function" || typeof credentials.unset !== "function") {
      throw new TypeError("WeixinController requires the DSH credential provider");
    }
    if (!configStore || typeof configStore.list !== "function" || typeof configStore.save !== "function" || typeof configStore.remove !== "function") {
      throw new TypeError("WeixinController requires a config store");
    }
    if (typeof createRuntime !== "function") throw new TypeError("createRuntime is required");
    this.#api = api;
    this.#credentials = credentials;
    this.#configStore = configStore;
    this.#createRuntime = createRuntime;
    this.#deleteState = deleteState;
    this.#logger = logger;
  }
  async initialize() {
    if (this.#closed) return this.status();
    for (const config of this.#configStore.list()) {
      const current = this.#runtimes.get(config.botId);
      if (current?.status?.ready === true) continue;
      await this.#withBotTransition(config.botId, async () => {
        const latest = this.#configStore.get(config.botId);
        if (!latest || this.#closed) return;
        try {
          const token = await this.#resolveToken(latest.tokenRef);
          if (!token) {
            this.#errors.set(
              latest.botId,
              safeAccountError("missing-token", "\u767B\u5F55\u51ED\u636E\u7F3A\u5931\uFF0C\u8BF7\u79FB\u9664\u8D26\u53F7\u540E\u91CD\u65B0\u626B\u7801\u3002")
            );
            return;
          }
          await this.#startRuntime(latest, token);
          this.#errors.delete(latest.botId);
        } catch (error) {
          this.#errors.set(
            latest.botId,
            safeAccountError("connection-failed", "\u5FAE\u4FE1\u8FDE\u63A5\u672A\u5C31\u7EEA\uFF0C\u63D2\u4EF6\u4F1A\u81EA\u52A8\u91CD\u8BD5\u3002")
          );
          this.#logger.warn?.(`[dsh-weixin] account ${latest.botId} failed to initialize:`, error);
        } finally {
          this.#touch();
        }
      });
    }
    return this.status();
  }
  async startProvisioning() {
    if (this.#closed) throw new Error("dsh-weixin controller is closed");
    if (this.#activeAttemptId) await this.cancelProvisioning(this.#activeAttemptId);
    const record = {
      id: randomUUID12(),
      state: "starting",
      createdAt: Date.now(),
      expiresAt: Date.now() + QR_TTL_MS3,
      controller: new AbortController(),
      pendingVerifyCode: null,
      verifyResolve: null,
      currentBaseUrl: WEIXIN_QR_BASE_URL,
      error: null,
      botId: null,
      task: null
    };
    this.#attempts.set(record.id, record);
    this.#activeAttemptId = record.id;
    this.#touch();
    try {
      const localTokens = (await Promise.all(
        this.#configStore.list().slice(-10).map(async (config) => this.#resolveToken(config.tokenRef))
      )).filter(Boolean);
      const login = await this.#api.beginLogin({
        localTokens,
        signal: record.controller.signal
      });
      this.#assertAttemptActive(record);
      record.qrcode = login.qrcode;
      record.verificationUrl = login.qrcodeUrl;
      record.state = "pending";
      record.expiresAt = Date.now() + QR_TTL_MS3;
      this.#touch();
      record.task = this.#runProvisioning(record);
      return publicAttempt4(record);
    } catch (error) {
      if (record.controller.signal.aborted) {
        record.state = "cancelled";
        record.error = safeAccountError("cancelled", "\u626B\u7801\u7ED1\u5B9A\u5DF2\u53D6\u6D88\u3002");
      } else {
        record.state = "failed";
        record.error = safeAccountError(
          error instanceof WeixinApiError ? error.code : "qr-start-failed",
          error instanceof WeixinApiError ? error.message : "\u65E0\u6CD5\u751F\u6210\u5FAE\u4FE1\u4E8C\u7EF4\u7801\uFF0C\u8BF7\u7A0D\u540E\u91CD\u8BD5\u3002"
        );
      }
      if (this.#activeAttemptId === record.id) this.#activeAttemptId = null;
      this.#touch();
      throw error;
    }
  }
  registrationStatus(attemptId) {
    return publicAttempt4(this.#attempts.get(attemptId));
  }
  async submitVerification(attemptId, verifyCode) {
    const record = this.#attempts.get(attemptId);
    if (!record || record.state !== "needs_verification") {
      throw new Error("The provisioning attempt is not waiting for a verification code");
    }
    const code = cleanString11(verifyCode);
    if (!code || !/^\d{4,8}$/.test(code)) {
      throw new TypeError("Verification code must contain 4 to 8 digits");
    }
    record.pendingVerifyCode = code;
    record.state = "scanned";
    record.verifyResolve?.();
    record.verifyResolve = null;
    this.#touch();
    return publicAttempt4(record);
  }
  async cancelProvisioning(attemptId) {
    const record = this.#attempts.get(attemptId);
    if (!record) return null;
    if (!TERMINAL_ATTEMPT_STATES4.has(record.state)) {
      record.controller.abort();
      record.verifyResolve?.();
      record.verifyResolve = null;
      await record.task?.catch(() => void 0);
      if (!TERMINAL_ATTEMPT_STATES4.has(record.state)) record.state = "cancelled";
      record.error ??= safeAccountError("cancelled", "\u626B\u7801\u7ED1\u5B9A\u5DF2\u53D6\u6D88\u3002");
    }
    if (this.#activeAttemptId === record.id) this.#activeAttemptId = null;
    this.#touch();
    return publicAttempt4(record);
  }
  async reconnectBot(botId) {
    const config = this.#configStore.get(botId);
    if (!config) throw new Error("Unknown Weixin account");
    await this.#withBotTransition(botId, async () => {
      const token = await this.#resolveToken(config.tokenRef);
      if (!token) throw new Error("The Weixin token is missing");
      try {
        await this.#startRuntime(config, token);
        this.#errors.delete(botId);
      } catch (error) {
        this.#errors.set(botId, safeAccountError("connection-failed", "\u5FAE\u4FE1\u8FDE\u63A5\u4ECD\u672A\u5C31\u7EEA\uFF0C\u8BF7\u7A0D\u540E\u91CD\u8BD5\u3002"));
        throw error;
      } finally {
        this.#touch();
      }
    });
    return this.status();
  }
  async deleteBot(botId) {
    const config = this.#configStore.get(botId);
    if (!config) throw new Error("Unknown Weixin account");
    await this.#withBotTransition(botId, async () => {
      const previousToken = await this.#credentials.resolve(config.tokenRef).catch(() => void 0);
      await this.#stopRuntime(botId);
      try {
        await this.#credentials.unset(config.tokenRef);
        await this.#configStore.remove(botId);
      } catch (error) {
        if (previousToken?.value) {
          await this.#credentials.set(config.tokenRef, previousToken.value).catch(() => void 0);
          await this.#startRuntime(config, previousToken.value).catch(() => void 0);
        }
        throw new Error("Unable to remove the Weixin account safely.", { cause: error });
      }
      try {
        await this.#deleteState({ botId, config });
      } catch (error) {
        this.#logger.warn?.(`[dsh-weixin] account ${botId} state cleanup failed:`, error);
      }
      this.#errors.delete(botId);
      this.#touch();
    });
    return this.status();
  }
  status() {
    const accounts = this.#configStore.list().map((config) => {
      const runtimeStatus2 = this.#runtimes.get(config.botId)?.status ?? null;
      const connected = runtimeStatus2?.ready === true && runtimeStatus2.weixinConnectionState === "connected" && runtimeStatus2.harnessReachable === true;
      const state = connected ? "connected" : runtimeStatus2?.weixinConnectionState === "connecting" ? "connecting" : this.#errors.has(config.botId) || runtimeStatus2?.weixinConnectionState === "failed" ? "error" : "offline";
      const error = this.#errors.get(config.botId) ?? (state === "error" ? safeAccountError("connection-failed", "\u5FAE\u4FE1\u8FDE\u63A5\u672A\u5C31\u7EEA\uFF0C\u63D2\u4EF6\u4F1A\u81EA\u52A8\u91CD\u8BD5\u3002") : null);
      return {
        botId: config.botId,
        state,
        connected,
        configured: true,
        bot: {
          name: "\u5FAE\u4FE1\u673A\u5668\u4EBA",
          accountIdMasked: maskWeixinAccountId(config.accountId)
        },
        health: {
          status: connected ? "healthy" : state === "error" ? "error" : "offline",
          summary: connected ? "\u5FAE\u4FE1\u6D88\u606F\u957F\u8F6E\u8BE2\u8FD0\u884C\u6B63\u5E38" : state === "error" ? "\u5FAE\u4FE1\u8FDE\u63A5\u672A\u5C31\u7EEA\uFF0C\u63D2\u4EF6\u4F1A\u81EA\u52A8\u91CD\u8BD5" : "\u5FAE\u4FE1\u8FDE\u63A5\u5F53\u524D\u79BB\u7EBF",
          lastCheckedAt: runtimeStatus2?.lastCheckedAt ?? null
        },
        stats: {
          messagesReceived: runtimeStatus2?.messagesReceived ?? 0,
          messagesReplied: runtimeStatus2?.messagesReplied ?? 0
        },
        error: error ? structuredClone(error) : null
      };
    });
    const connectedCount = accounts.filter((account) => account.connected).length;
    const active = this.#activeAttemptId ? this.#attempts.get(this.#activeAttemptId) : null;
    return {
      schemaVersion: 1,
      revision: this.#revision,
      state: active && ACTIVE_ATTEMPT_STATES4.has(active.state) ? "provisioning" : accounts.length === 0 ? "disconnected" : connectedCount === accounts.length ? "connected" : connectedCount > 0 ? "degraded" : "offline",
      bots: accounts,
      totals: { configured: accounts.length, connected: connectedCount },
      ...active && ACTIVE_ATTEMPT_STATES4.has(active.state) ? { provisioning: publicAttempt4(active) } : {}
    };
  }
  async close() {
    if (this.#closed) return;
    this.#closed = true;
    if (this.#activeAttemptId) await this.cancelProvisioning(this.#activeAttemptId);
    await Promise.allSettled([...this.#runtimes.keys()].map((botId) => this.#stopRuntime(botId)));
  }
  async #runProvisioning(record) {
    try {
      while (!record.controller.signal.aborted && Date.now() < record.expiresAt) {
        if (record.state === "needs_verification" && !record.pendingVerifyCode) {
          await new Promise((resolve6) => {
            record.verifyResolve = resolve6;
            if (record.controller.signal.aborted) resolve6();
          });
          record.verifyResolve = null;
          this.#assertAttemptActive(record);
        }
        const response = await this.#api.pollLogin({
          qrcode: record.qrcode,
          baseUrl: record.currentBaseUrl,
          verifyCode: record.pendingVerifyCode,
          signal: record.controller.signal
        });
        this.#assertAttemptActive(record);
        if (response.status === "wait") {
          record.state = "pending";
        } else if (response.status === "scaned") {
          record.pendingVerifyCode = null;
          record.state = "scanned";
        } else if (response.status === "need_verifycode") {
          record.pendingVerifyCode = null;
          record.state = "needs_verification";
        } else if (response.status === "verify_code_blocked") {
          record.state = "failed";
          record.error = safeAccountError("verification-blocked", "\u914D\u5BF9\u7801\u591A\u6B21\u9519\u8BEF\uFF0C\u8BF7\u91CD\u65B0\u751F\u6210\u4E8C\u7EF4\u7801\u3002");
          break;
        } else if (response.status === "expired") {
          record.state = "expired";
          record.error = safeAccountError("expired", "\u4E8C\u7EF4\u7801\u5DF2\u8FC7\u671F\uFF0C\u8BF7\u91CD\u65B0\u751F\u6210\u3002");
          break;
        } else if (response.status === "scaned_but_redirect") {
          record.currentBaseUrl = apiBaseFromServer(response.redirect_host, record.currentBaseUrl);
          record.state = "scanned";
        } else if (response.status === "binded_redirect") {
          const existing = this.#configStore.list().find(
            (config) => this.#runtimes.get(config.botId)?.status?.ready === true
          ) ?? this.#configStore.list()[0];
          if (!existing) {
            record.state = "failed";
            record.error = safeAccountError("already-bound", "\u8BE5\u5FAE\u4FE1\u8D26\u53F7\u5DF2\u7ED1\u5B9A\uFF0C\u4F46\u672C\u673A\u6CA1\u6709\u53EF\u6062\u590D\u7684\u51ED\u636E\u3002");
          } else {
            record.state = "connected";
            record.botId = existing.botId;
            record.alreadyConnected = true;
          }
          break;
        } else if (response.status === "confirmed") {
          const token = cleanString11(response.bot_token);
          const accountId = cleanString11(response.ilink_bot_id);
          const ownerUserId = cleanString11(response.ilink_user_id);
          if (!token || !accountId || !ownerUserId) {
            throw new WeixinApiError("incomplete-login", "\u5FAE\u4FE1\u6388\u6743\u6210\u529F\uFF0C\u4F46\u8FD4\u56DE\u7684\u8D26\u53F7\u51ED\u636E\u4E0D\u5B8C\u6574\u3002");
          }
          record.state = "connecting";
          this.#touch();
          const baseUrl = apiBaseFromServer(response.baseurl, record.currentBaseUrl);
          record.botId = await this.#activateAccount(record, {
            token,
            accountId,
            ownerUserId,
            baseUrl
          });
          record.state = "connected";
          record.error = null;
          break;
        }
        this.#touch();
      }
      if (!record.controller.signal.aborted && Date.now() >= record.expiresAt && !TERMINAL_ATTEMPT_STATES4.has(record.state)) {
        record.state = "expired";
        record.error = safeAccountError("expired", "\u4E8C\u7EF4\u7801\u5DF2\u8FC7\u671F\uFF0C\u8BF7\u91CD\u65B0\u751F\u6210\u3002");
      }
    } catch (error) {
      if (record.controller.signal.aborted || error?.name === "AbortError") {
        record.state = "cancelled";
        record.error = safeAccountError("cancelled", "\u626B\u7801\u7ED1\u5B9A\u5DF2\u53D6\u6D88\u3002");
      } else {
        record.state = "failed";
        record.error = safeAccountError(
          error instanceof WeixinApiError ? error.code : "activation-failed",
          error instanceof WeixinApiError ? error.message : "\u5FAE\u4FE1\u5DF2\u6388\u6743\uFF0C\u4F46\u65E0\u6CD5\u4FDD\u5B58\u51ED\u636E\u6216\u542F\u52A8\u6D88\u606F\u8FDE\u63A5\u3002"
        );
        this.#logger.error?.("[dsh-weixin] provisioning failed:", error);
      }
    } finally {
      record.pendingVerifyCode = null;
      record.verifyResolve?.();
      record.verifyResolve = null;
      if (this.#activeAttemptId === record.id) this.#activeAttemptId = null;
      this.#touch();
      this.#pruneAttempts();
    }
  }
  async #activateAccount(record, { token, accountId, ownerUserId, baseUrl }) {
    const identity = deriveWeixinBotIdentity(accountId);
    const previousConfig = this.#configStore.getByAccountId(accountId);
    const config = {
      botId: identity.botId,
      accountId,
      tokenRef: identity.tokenRef,
      ownerUserId,
      baseUrl,
      createdAt: previousConfig?.createdAt ?? (/* @__PURE__ */ new Date()).toISOString(),
      connectedAt: (/* @__PURE__ */ new Date()).toISOString()
    };
    const previousToken = await this.#credentials.resolve(identity.tokenRef).catch(() => void 0);
    return this.#withBotTransition(identity.botId, async () => {
      await this.#credentials.set(identity.tokenRef, token);
      try {
        this.#assertAttemptActive(record);
        await this.#configStore.save(config);
        this.#assertAttemptActive(record);
        await this.#startRuntime(config, token);
        this.#assertAttemptActive(record);
        this.#errors.delete(identity.botId);
        this.#touch();
        return identity.botId;
      } catch (error) {
        await this.#stopRuntime(identity.botId);
        if (previousConfig) await this.#configStore.save(previousConfig).catch(() => void 0);
        else if (this.#configStore.get(identity.botId)) {
          await this.#configStore.remove(identity.botId).catch(() => void 0);
        }
        await this.#restoreCredential(identity.tokenRef, previousToken);
        if (previousConfig && previousToken?.value) {
          await this.#startRuntime(previousConfig, previousToken.value).catch(() => void 0);
        }
        throw error;
      }
    });
  }
  async #startRuntime(config, token) {
    await this.#stopRuntime(config.botId);
    const runtime = await this.#createRuntime({ botId: config.botId, config, token });
    if (!runtime || typeof runtime.start !== "function" || typeof runtime.stop !== "function") {
      throw new TypeError("createRuntime returned an invalid Weixin runtime");
    }
    try {
      await runtime.start();
      this.#runtimes.set(config.botId, runtime);
    } catch (error) {
      await runtime.stop().catch(() => void 0);
      throw error;
    }
  }
  async #stopRuntime(botId) {
    const runtime = this.#runtimes.get(botId);
    this.#runtimes.delete(botId);
    await runtime?.stop().catch((error) => {
      this.#logger.warn?.(`[dsh-weixin] account ${botId} failed to stop cleanly:`, error);
    });
  }
  async #resolveToken(ref) {
    const result = await this.#credentials.resolve(ref).catch(() => void 0);
    return cleanString11(result?.value);
  }
  async #restoreCredential(ref, previous) {
    try {
      if (previous?.value) await this.#credentials.set(ref, previous.value);
      else await this.#credentials.unset(ref);
    } catch (error) {
      this.#logger.error?.(`[dsh-weixin] failed to restore credential ${ref}:`, error);
    }
  }
  #assertAttemptActive(record) {
    if (record.controller.signal.aborted || this.#activeAttemptId !== record.id) throw abortError4();
  }
  #withBotTransition(botId, operation) {
    const previous = this.#transitions.get(botId) ?? Promise.resolve();
    const current = previous.catch(() => void 0).then(operation);
    const settled = current.finally(() => {
      if (this.#transitions.get(botId) === settled) this.#transitions.delete(botId);
    });
    this.#transitions.set(botId, settled);
    return settled;
  }
  #pruneAttempts() {
    for (const [id, record] of this.#attempts) {
      if (id !== this.#activeAttemptId && TERMINAL_ATTEMPT_STATES4.has(record.state) && this.#attempts.size > 16) {
        this.#attempts.delete(id);
      }
    }
  }
  #touch() {
    this.#revision += 1;
  }
};

// src/channels/weixin/weixin-bridge.mjs
var HELP_TEXT5 = [
  "\u5FAE\u4FE1\u5DF2\u8FDE\u63A5 DeepSeek Harness\u3002",
  "",
  "\u76F4\u63A5\u53D1\u9001\u6587\u5B57\u6216\u5E26\u6587\u5B57\u8BC6\u522B\u7ED3\u679C\u7684\u8BED\u97F3\u5373\u53EF\u7EE7\u7EED\u5F53\u524D\u4F1A\u8BDD\u3002",
  "/new  \u5F00\u542F\u4E00\u4E2A\u5168\u65B0\u4F1A\u8BDD",
  "/status  \u68C0\u67E5\u8FDE\u63A5\u72B6\u6001",
  "/help  \u663E\u793A\u672C\u5E2E\u52A9"
].join("\n");
function conversationKey5(userId) {
  return `p2p:${userId}`;
}
function createWeixinBridgeStatus() {
  return {
    messagesReceived: 0,
    messagesReplied: 0,
    messagesRejected: 0,
    lastMessageAt: null,
    lastReplyAt: null,
    lastRejectedAt: null,
    lastError: null
  };
}
var WeixinHarnessBridge = class {
  #api;
  #baseUrl;
  #token;
  #ownerUserId;
  #harness;
  #state;
  #status;
  #logger;
  #replyTimeoutMs;
  #maxMessageChars;
  #queues = /* @__PURE__ */ new Map();
  constructor({
    api,
    baseUrl,
    token,
    ownerUserId,
    harness,
    state,
    status = createWeixinBridgeStatus(),
    logger = console,
    replyTimeoutMs = 6e5,
    maxMessageChars = 4e3
  }) {
    if (!api || typeof api.sendText !== "function") throw new TypeError("Weixin API is required");
    if (!baseUrl || !token || !ownerUserId) throw new TypeError("Weixin account credentials are required");
    if (!harness || !state) throw new TypeError("Harness client and state store are required");
    this.#api = api;
    this.#baseUrl = baseUrl;
    this.#token = token;
    this.#ownerUserId = ownerUserId;
    this.#harness = harness;
    this.#state = state;
    this.#status = status;
    this.#logger = logger;
    this.#replyTimeoutMs = replyTimeoutMs;
    this.#maxMessageChars = maxMessageChars;
  }
  get status() {
    return structuredClone(this.#status);
  }
  accept(message) {
    const sender = typeof message?.from_user_id === "string" ? message.from_user_id : "";
    const previous = this.#queues.get(sender) ?? Promise.resolve();
    const current = previous.catch(() => void 0).then(() => this.#process(message)).finally(() => {
      if (this.#queues.get(sender) === current) this.#queues.delete(sender);
    });
    this.#queues.set(sender, current);
    return current;
  }
  async waitForIdle() {
    await Promise.allSettled([...this.#queues.values()]);
  }
  async #process(message) {
    if (message?.message_type === 2) return;
    const messageId = weixinMessageId(message);
    const sender = typeof message?.from_user_id === "string" ? message.from_user_id : "";
    if (!messageId || !sender) return;
    if (this.#state.hasSeen(messageId)) return;
    this.#status.messagesReceived += 1;
    this.#status.lastMessageAt = (/* @__PURE__ */ new Date()).toISOString();
    if (sender !== this.#ownerUserId) {
      this.#status.messagesRejected += 1;
      this.#status.lastRejectedAt = (/* @__PURE__ */ new Date()).toISOString();
      return;
    }
    const contextToken = typeof message.context_token === "string" ? message.context_token : void 0;
    const runId = typeof message.run_id === "string" ? message.run_id : void 0;
    const text = extractWeixinText(message);
    try {
      if (!text) {
        await this.#send(sender, "\u76EE\u524D\u4EC5\u652F\u6301\u6587\u5B57\u6D88\u606F\uFF0C\u4EE5\u53CA\u5FAE\u4FE1\u5DF2\u8F6C\u6210\u6587\u5B57\u7684\u8BED\u97F3\u6D88\u606F\u3002", contextToken, runId);
        await this.#state.markSeen(messageId);
        return;
      }
      const command = text.trim().toLowerCase();
      if (command === "/help") {
        await this.#send(sender, HELP_TEXT5, contextToken, runId);
        await this.#state.markSeen(messageId);
        return;
      }
      if (command === "/status") {
        await this.#harness.ensureRunning();
        await this.#send(sender, "\u5FAE\u4FE1\u4E0E DeepSeek Harness \u8FDE\u63A5\u6B63\u5E38\u3002", contextToken, runId);
        await this.#state.markSeen(messageId);
        return;
      }
      if (command === "/new") {
        await this.#state.clearSession(conversationKey5(sender));
        await this.#send(sender, "\u5DF2\u5F00\u542F\u65B0\u4F1A\u8BDD\u3002\u8BF7\u53D1\u9001\u4F60\u7684\u95EE\u9898\u3002", contextToken, runId);
        await this.#state.markSeen(messageId);
        return;
      }
      const key = conversationKey5(sender);
      let sessionId = this.#state.sessionFor(key);
      if (!sessionId || !await this.#harness.sessionExists(sessionId)) {
        sessionId = await this.#harness.createSession();
        await this.#state.setSession(key, sessionId);
      }
      const answer = await this.#harness.ask(sessionId, text, { timeoutMs: this.#replyTimeoutMs });
      await this.#send(sender, answer, contextToken, runId);
      await this.#state.markSeen(messageId);
      this.#status.messagesReplied += 1;
      this.#status.lastReplyAt = (/* @__PURE__ */ new Date()).toISOString();
      this.#status.lastError = null;
    } catch (error) {
      this.#status.lastError = error?.message ?? String(error);
      this.#logger.error?.("[dsh-weixin] failed to process an inbound message:", error);
      try {
        await this.#send(sender, "\u6D88\u606F\u5904\u7406\u5931\u8D25\uFF0C\u8BF7\u7A0D\u540E\u91CD\u8BD5\u3002", contextToken, runId);
        await this.#state.markSeen(messageId);
      } catch (sendError) {
        this.#logger.error?.("[dsh-weixin] failed to send the safe error reply:", sendError);
      }
    }
  }
  async #send(toUserId, text, contextToken, runId) {
    for (const chunk of splitWeixinText(text, this.#maxMessageChars)) {
      await this.#api.sendText({
        baseUrl: this.#baseUrl,
        token: this.#token,
        toUserId,
        text: chunk,
        contextToken,
        runId
      });
    }
  }
};

// src/channels/weixin/weixin-runtime.mjs
function delay(ms, signal) {
  return new Promise((resolve6, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
      return;
    }
    const finish = () => {
      signal?.removeEventListener("abort", onAbort);
      resolve6();
    };
    const timer = setTimeout(finish, ms);
    const onAbort = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
function createWeixinRuntimeStatus() {
  return {
    startedAt: null,
    ready: false,
    weixinConnectionState: "idle",
    harnessReachable: false,
    lastCheckedAt: null,
    lastError: null,
    ...createWeixinBridgeStatus()
  };
}
var WeixinRuntime = class {
  #api;
  #config;
  #token;
  #harness;
  #state;
  #logger;
  #replyTimeoutMs;
  #maxMessageChars;
  #status = createWeixinRuntimeStatus();
  #bridge = null;
  #abortController = null;
  #monitor = null;
  #starting = null;
  constructor({
    api,
    config,
    token,
    harness,
    state,
    logger = console,
    replyTimeoutMs = 6e5,
    maxMessageChars = 4e3
  }) {
    if (!api || !config || !token || !harness || !state) {
      throw new TypeError("WeixinRuntime requires API, account, token, Harness, and state");
    }
    this.#api = api;
    this.#config = config;
    this.#token = token;
    this.#harness = harness;
    this.#state = state;
    this.#logger = logger;
    this.#replyTimeoutMs = replyTimeoutMs;
    this.#maxMessageChars = maxMessageChars;
  }
  get status() {
    return structuredClone(this.#status);
  }
  async start() {
    if (this.#status.ready && this.#monitor) return this.status;
    if (this.#starting) return this.#starting;
    this.#starting = this.#start().finally(() => {
      this.#starting = null;
    });
    return this.#starting;
  }
  async #start() {
    await this.stop();
    this.#status.startedAt = (/* @__PURE__ */ new Date()).toISOString();
    this.#status.weixinConnectionState = "connecting";
    this.#status.lastError = null;
    try {
      await this.#harness.ensureRunning();
      this.#status.harnessReachable = true;
      await this.#api.notifyStart({
        baseUrl: this.#config.baseUrl,
        token: this.#token
      });
      this.#bridge = new WeixinHarnessBridge({
        api: this.#api,
        baseUrl: this.#config.baseUrl,
        token: this.#token,
        ownerUserId: this.#config.ownerUserId,
        harness: this.#harness,
        state: this.#state,
        status: this.#status,
        logger: this.#logger,
        replyTimeoutMs: this.#replyTimeoutMs,
        maxMessageChars: this.#maxMessageChars
      });
      this.#abortController = new AbortController();
      this.#status.ready = true;
      this.#status.weixinConnectionState = "connected";
      this.#status.lastCheckedAt = Date.now();
      const signal = this.#abortController.signal;
      this.#monitor = this.#runMonitor(signal).catch((error) => {
        if (signal.aborted) return;
        this.#status.ready = false;
        this.#status.weixinConnectionState = "failed";
        this.#status.lastError = error?.message ?? String(error);
        this.#logger.error?.(`[dsh-weixin] account ${this.#config.botId} monitor stopped:`, error);
      });
      return this.status;
    } catch (error) {
      this.#status.ready = false;
      this.#status.weixinConnectionState = "failed";
      this.#status.lastError = error?.message ?? String(error);
      throw error;
    }
  }
  async #runMonitor(signal) {
    let consecutiveFailures = 0;
    while (!signal.aborted) {
      try {
        const response = await this.#api.getUpdates({
          baseUrl: this.#config.baseUrl,
          token: this.#token,
          getUpdatesBuf: this.#state.getUpdatesBuf(),
          signal
        });
        if (signal.aborted) return;
        const rejected = response?.ret !== void 0 && response.ret !== 0 || response?.errcode !== void 0 && response.errcode !== 0;
        if (rejected) {
          const code = response.errcode ?? response.ret;
          throw new WeixinApiError(
            code === -14 ? "stale-token" : "updates-rejected",
            code === -14 ? "\u5FAE\u4FE1\u767B\u5F55\u51ED\u636E\u5DF2\u5931\u6548\uFF0C\u8BF7\u79FB\u9664\u8D26\u53F7\u540E\u91CD\u65B0\u626B\u7801\u3002" : "\u5FAE\u4FE1\u6D88\u606F\u540C\u6B65\u8BF7\u6C42\u88AB\u62D2\u7EDD\u3002"
          );
        }
        consecutiveFailures = 0;
        this.#status.ready = true;
        this.#status.weixinConnectionState = "connected";
        this.#status.lastCheckedAt = Date.now();
        this.#status.lastError = null;
        for (const message of response?.msgs ?? []) {
          await this.#bridge.accept(message);
        }
        if (typeof response?.get_updates_buf === "string" && response.get_updates_buf) {
          await this.#state.setGetUpdatesBuf(response.get_updates_buf);
        }
      } catch (error) {
        if (signal.aborted) return;
        consecutiveFailures += 1;
        this.#status.lastError = error?.message ?? String(error);
        this.#logger.warn?.(
          `[dsh-weixin] account ${this.#config.botId} poll failed (${consecutiveFailures}/3):`,
          error
        );
        if (error instanceof WeixinApiError && error.code === "stale-token") throw error;
        if (consecutiveFailures >= 3) throw error;
        await delay(Math.min(2e3 * 2 ** (consecutiveFailures - 1), 1e4), signal);
      }
    }
  }
  async stop() {
    const monitor = this.#monitor;
    const bridge = this.#bridge;
    const wasStarted = Boolean(this.#abortController || monitor || this.#status.ready);
    this.#abortController?.abort();
    this.#abortController = null;
    this.#monitor = null;
    await monitor?.catch(() => void 0);
    await bridge?.waitForIdle();
    this.#bridge = null;
    if (wasStarted) {
      try {
        await this.#api.notifyStop({
          baseUrl: this.#config.baseUrl,
          token: this.#token,
          signal: AbortSignal.timeout(1e4)
        });
      } catch (error) {
        this.#logger.warn?.(`[dsh-weixin] account ${this.#config.botId} stop notification failed:`, error);
      }
    }
    this.#status.ready = false;
    this.#status.weixinConnectionState = "idle";
    return this.status;
  }
};

// plugin-src/host/channels/weixin/connection-supervisor.mjs
var DEFAULT_RETRY_DELAYS_MS5 = Object.freeze([250, 1e3, 3e3, 5e3, 1e4, 3e4]);
function retryDelays4(value) {
  if (!Array.isArray(value) || value.length === 0) return [...DEFAULT_RETRY_DELAYS_MS5];
  const valid = value.filter((delay2) => Number.isFinite(delay2) && delay2 >= 0);
  return valid.length > 0 ? valid : [...DEFAULT_RETRY_DELAYS_MS5];
}
var ConnectionSupervisor5 = class {
  #controller;
  #harness;
  #logger;
  #retryDelays;
  #healthyIntervalMs;
  #setTimeout;
  #clearTimeout;
  #timer = null;
  #running = null;
  #retryIndex = 0;
  #closed = false;
  #started = false;
  #ready;
  #resolveReady;
  constructor({
    controller,
    harness,
    logger = console,
    retryDelaysMs,
    healthyIntervalMs = 15e3,
    setTimeoutImpl = setTimeout,
    clearTimeoutImpl = clearTimeout
  }) {
    if (!controller || typeof controller.initialize !== "function" || typeof controller.status !== "function") {
      throw new TypeError("ConnectionSupervisor requires a controller");
    }
    if (!harness || typeof harness.ensureRunning !== "function") {
      throw new TypeError("ConnectionSupervisor requires a Harness client");
    }
    this.#controller = controller;
    this.#harness = harness;
    this.#logger = logger;
    this.#retryDelays = retryDelays4(retryDelaysMs);
    this.#healthyIntervalMs = Number.isFinite(healthyIntervalMs) && healthyIntervalMs >= 0 ? healthyIntervalMs : 15e3;
    this.#setTimeout = setTimeoutImpl;
    this.#clearTimeout = clearTimeoutImpl;
    this.#ready = new Promise((resolve6) => {
      this.#resolveReady = resolve6;
    });
  }
  get ready() {
    return this.#ready;
  }
  start() {
    if (this.#started || this.#closed) return this;
    this.#started = true;
    this.#schedule(0);
    return this;
  }
  async close() {
    if (this.#closed) return;
    this.#closed = true;
    if (this.#timer !== null) this.#clearTimeout(this.#timer);
    this.#timer = null;
    await this.#running?.catch(() => void 0);
    this.#resolveReady?.(null);
    this.#resolveReady = null;
  }
  #schedule(delayMs) {
    if (this.#closed) return;
    this.#timer = this.#setTimeout(() => {
      this.#timer = null;
      void this.#run();
    }, delayMs);
    this.#timer?.unref?.();
  }
  async #run() {
    if (this.#closed || this.#running) return;
    const operation = this.#reconcile();
    this.#running = operation;
    try {
      await operation;
    } finally {
      if (this.#running === operation) this.#running = null;
    }
  }
  async #reconcile() {
    try {
      await this.#harness.ensureRunning();
      if (this.#closed) return;
      const status = await this.#controller.initialize();
      if (this.#closed) return;
      this.#resolveReady?.(status);
      this.#resolveReady = null;
      const { configured, connected } = status.totals;
      if (connected < configured) {
        const delayMs = this.#retryDelays[Math.min(this.#retryIndex, this.#retryDelays.length - 1)];
        this.#retryIndex += 1;
        this.#logger.warn?.(
          `[dsh-weixin] ${connected}/${configured} accounts connected; retrying in ${delayMs}ms`
        );
        this.#schedule(delayMs);
        return;
      }
      this.#retryIndex = 0;
      this.#schedule(this.#healthyIntervalMs);
    } catch (error) {
      if (this.#closed) return;
      const delayMs = this.#retryDelays[Math.min(this.#retryIndex, this.#retryDelays.length - 1)];
      this.#retryIndex += 1;
      this.#logger.warn?.(`[dsh-weixin] connection reconciliation failed; retrying in ${delayMs}ms`, error);
      this.#schedule(delayMs);
    }
  }
};
function createConnectionSupervisor5(options) {
  return new ConnectionSupervisor5(options);
}

// plugin-src/host/channels/weixin/production.mjs
function harnessOrigin5(webServer, configured) {
  if (configured !== void 0) return new URL(configured);
  const port = webServer?.port;
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("dsh-weixin requires an initialized DSH webServer port");
  }
  return new URL(`http://127.0.0.1:${port}`);
}
function pluginPaths5(config) {
  const dshHome = resolve5(config.dshHome ?? process.env.DSH_HOME ?? join5(homedir5(), ".dsh"));
  const root = resolve5(config.dataDir ?? join5(dshHome, "integrations", "dsh-weixin"));
  return {
    root,
    config: resolve5(config.configPath ?? join5(root, "config.json")),
    accounts: resolve5(config.accountsDir ?? join5(root, "accounts"))
  };
}
async function createProductionController5(ctx, config = {}, internals = {}) {
  if (!ctx?.credentials) throw new TypeError("dsh-weixin requires ctx.credentials");
  if (!ctx?.webServer) throw new TypeError("dsh-weixin requires ctx.webServer");
  const ConfigStore = internals.ConfigStore ?? WeixinConfigStore;
  const StateStore2 = internals.StateStore ?? WeixinStateStore;
  const Harness = internals.HarnessClient ?? HarnessClient3;
  const Controller = internals.Controller ?? WeixinController;
  const Runtime = internals.Runtime ?? WeixinRuntime;
  const api = internals.api ?? createWeixinApi();
  const createSupervisor = internals.createConnectionSupervisor ?? createConnectionSupervisor5;
  const logger = typeof ctx.logger === "function" ? ctx.logger("dsh-weixin") : ctx.logger ?? console;
  const paths = pluginPaths5(config);
  const configStore = await new ConfigStore(paths.config).load();
  const stateStores = /* @__PURE__ */ new Map();
  const statePath = (botId) => resolve5(paths.accounts, botId, "state.json");
  const stateFor = async (botId) => {
    let state = stateStores.get(botId);
    if (!state) {
      state = await new StateStore2(statePath(botId)).load();
      stateStores.set(botId, state);
    }
    return state;
  };
  const harness = new Harness({
    baseUrl: harnessOrigin5(ctx.webServer, config.harnessBaseUrl),
    workspace: resolve5(config.workspace ?? process.cwd()),
    agentPreset: config.agentPreset ?? "standard",
    autostart: false,
    dshBin: config.dshBin ?? "dsh"
  });
  const controller = new Controller({
    api,
    credentials: ctx.credentials,
    configStore,
    logger,
    createRuntime: async ({ botId, config: accountConfig, token }) => {
      const state = await stateFor(botId);
      return new Runtime({
        api,
        config: accountConfig,
        token,
        harness,
        state,
        replyTimeoutMs: config.replyTimeoutMs ?? 6e5,
        maxMessageChars: config.maxMessageChars ?? 4e3,
        logger: {
          error: (...args) => logger.error?.(`[${botId}]`, ...args),
          warn: (...args) => logger.warn?.(`[${botId}]`, ...args),
          info: (...args) => logger.info?.(`[${botId}]`, ...args),
          debug: (...args) => logger.debug?.(`[${botId}]`, ...args)
        }
      });
    },
    deleteState: async ({ botId }) => {
      const state = stateStores.get(botId);
      stateStores.delete(botId);
      if (state && typeof state.remove === "function") {
        await state.remove();
        return;
      }
      try {
        await unlink14(statePath(botId));
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
      }
    }
  });
  const supervisor = createSupervisor({
    controller,
    harness,
    logger,
    retryDelaysMs: config.retryDelaysMs,
    healthyIntervalMs: config.healthyIntervalMs
  }).start();
  return {
    controller,
    ready: supervisor.ready,
    async close() {
      await supervisor.close();
      await controller.close();
      harness.stopManagedProcess();
    }
  };
}

// plugin-src/host/channels/weixin/rpc.mjs
import QRCode5 from "qrcode";
var WEIXIN_RPC_CHANNEL = "/weixin";
var WEIXIN_ENDPOINTS = Object.freeze({
  status: "connection.status",
  beginProvisioning: "provision.begin",
  pollProvisioning: "provision.poll",
  submitVerification: "provision.verify",
  cancelProvisioning: "provision.cancel",
  reconnectBot: "bot.reconnect",
  deleteBot: "bot.delete"
});
var WEIXIN_RPC_ENDPOINTS = Object.freeze(Object.values(WEIXIN_ENDPOINTS));
function isRecord4(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function exactKeys4(value, allowed) {
  return isRecord4(value) && Object.keys(value).every((key) => allowed.includes(key));
}
function validId4(value) {
  return typeof value === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(value);
}
function payloadFailure4(endpoint, payload) {
  if (!isRecord4(payload)) return "Payload must be an object.";
  if (endpoint === WEIXIN_ENDPOINTS.status) {
    return exactKeys4(payload, []) ? null : "connection.status does not accept fields.";
  }
  if (endpoint === WEIXIN_ENDPOINTS.beginProvisioning) {
    return exactKeys4(payload, ["locale"]) && (payload.locale === void 0 || payload.locale === "zh-CN") ? null : "provision.begin received unsupported fields.";
  }
  if ([WEIXIN_ENDPOINTS.pollProvisioning, WEIXIN_ENDPOINTS.cancelProvisioning].includes(endpoint)) {
    return exactKeys4(payload, ["attemptId"]) && validId4(payload.attemptId) ? null : `${endpoint} requires an attemptId.`;
  }
  if (endpoint === WEIXIN_ENDPOINTS.submitVerification) {
    return exactKeys4(payload, ["attemptId", "verifyCode"]) && validId4(payload.attemptId) && typeof payload.verifyCode === "string" && /^\d{4,8}$/.test(payload.verifyCode) ? null : "provision.verify requires an attemptId and a 4-to-8-digit code.";
  }
  if (endpoint === WEIXIN_ENDPOINTS.reconnectBot) {
    return exactKeys4(payload, ["botId"]) && validId4(payload.botId) ? null : "bot.reconnect requires a botId.";
  }
  if (endpoint === WEIXIN_ENDPOINTS.deleteBot) {
    return exactKeys4(payload, ["botId", "confirm"]) && validId4(payload.botId) && payload.confirm === true ? null : "bot.delete requires a botId and confirm=true.";
  }
  return "Unknown Weixin endpoint.";
}
function badRequest3(message) {
  return { ok: false, error: { code: "bad-request", message } };
}
function cancelled3() {
  return { ok: false, error: { code: "cancelled", message: "The request was cancelled." } };
}
function internalFailure3() {
  return {
    ok: false,
    error: { code: "weixin-operation-failed", message: "\u5FAE\u4FE1\u64CD\u4F5C\u5931\u8D25\uFF0C\u8BF7\u7A0D\u540E\u91CD\u8BD5\u3002" }
  };
}
async function qrDataUrl4(value) {
  return QRCode5.toDataURL(value, {
    type: "image/png",
    errorCorrectionLevel: "M",
    margin: 2,
    width: 320
  });
}
async function withEncodedQr4(value, encodeQr) {
  if (!value || !value.verificationUrl) return value;
  return {
    ...value,
    qrCodeDataUrl: await encodeQr(value.verificationUrl)
  };
}
async function publicStatus4(status, encodeQr) {
  const safe = structuredClone(status);
  if (safe.provisioning) safe.provisioning = await withEncodedQr4(safe.provisioning, encodeQr);
  return safe;
}
function assertController3(controller) {
  if (!controller || typeof controller.status !== "function" || typeof controller.startProvisioning !== "function" || typeof controller.registrationStatus !== "function" || typeof controller.submitVerification !== "function" || typeof controller.cancelProvisioning !== "function" || typeof controller.reconnectBot !== "function" || typeof controller.deleteBot !== "function") {
    throw new TypeError("A complete Weixin controller is required");
  }
}
function createWeixinRpcHandler(controller, { encodeQr = qrDataUrl4 } = {}) {
  assertController3(controller);
  const qrCache = /* @__PURE__ */ new Map();
  const cachedEncode = (url) => {
    let encoded = qrCache.get(url);
    if (!encoded) {
      if (qrCache.size >= 16) qrCache.delete(qrCache.keys().next().value);
      encoded = Promise.resolve().then(() => encodeQr(url));
      qrCache.set(url, encoded);
    }
    return encoded;
  };
  return async (endpoint, payload, signal) => {
    if (signal?.aborted) return cancelled3();
    if (!WEIXIN_RPC_ENDPOINTS.includes(endpoint)) return badRequest3("Unknown Weixin endpoint.");
    const invalid = payloadFailure4(endpoint, payload);
    if (invalid) return badRequest3(invalid);
    try {
      let value;
      if (endpoint === WEIXIN_ENDPOINTS.status) {
        value = await publicStatus4(await controller.status(), cachedEncode);
      } else if (endpoint === WEIXIN_ENDPOINTS.beginProvisioning) {
        const started = await controller.startProvisioning();
        if (signal?.aborted) {
          await controller.cancelProvisioning(started.attemptId);
          return cancelled3();
        }
        value = await withEncodedQr4(started, cachedEncode);
      } else if (endpoint === WEIXIN_ENDPOINTS.pollProvisioning) {
        const current = await controller.registrationStatus(payload.attemptId);
        if (!current) return badRequest3("The provisioning attempt no longer exists.");
        value = await withEncodedQr4(current, cachedEncode);
      } else if (endpoint === WEIXIN_ENDPOINTS.submitVerification) {
        value = await withEncodedQr4(
          await controller.submitVerification(payload.attemptId, payload.verifyCode),
          cachedEncode
        );
      } else if (endpoint === WEIXIN_ENDPOINTS.cancelProvisioning) {
        value = await controller.cancelProvisioning(payload.attemptId);
        if (!value) return badRequest3("The provisioning attempt no longer exists.");
      } else if (endpoint === WEIXIN_ENDPOINTS.reconnectBot) {
        value = await publicStatus4(await controller.reconnectBot(payload.botId), cachedEncode);
      } else {
        value = await publicStatus4(await controller.deleteBot(payload.botId), cachedEncode);
      }
      return signal?.aborted ? cancelled3() : { ok: true, value };
    } catch {
      return signal?.aborted ? cancelled3() : internalFailure3();
    }
  };
}
function installWeixinRpc(ctx, controller, options) {
  if (!ctx?.connection?.rpc || typeof ctx.connection.rpc.handle !== "function") {
    throw new TypeError("DSH Host Connection RPC is required");
  }
  return ctx.connection.rpc.handle(
    WEIXIN_RPC_CHANNEL,
    createWeixinRpcHandler(controller, options),
    { authority: "loopback" }
  );
}

// plugin-src/host/channels/weixin/index.mjs
async function apply5(ctx, config = {}) {
  if (config?.controller) return installWeixinRpc(ctx, config.controller, config.rpcOptions);
  const production = await createProductionController5(ctx, config, config.internals);
  const disposeRpc = installWeixinRpc(ctx, production.controller, config.rpcOptions);
  ctx.effect(() => async () => {
    await production.close();
  }, "dsh-weixin: close account connections");
  return disposeRpc;
}

// plugin-src/host/index.mjs
var name = "dsh-im-host";
var inject = ["connection", "credentials", "webServer"];
function createImHostPlugin(internals = {}) {
  const startFeishu = internals.applyFeishu ?? apply2;
  const startWeixin = internals.applyWeixin ?? apply5;
  const startDingtalk = internals.applyDingtalk ?? apply;
  const startWecom = internals.applyWecom ?? apply4;
  const startQq = internals.applyQq ?? apply3;
  return Object.freeze({
    name,
    inject,
    async apply(ctx, config = {}) {
      await startFeishu(ctx, config.feishu ?? {});
      await startWeixin(ctx, config.weixin ?? {});
      await startDingtalk(ctx, config.dingtalk ?? {});
      await startWecom(ctx, config.wecom ?? {});
      await startQq(ctx, config.qq ?? {});
    }
  });
}
async function apply6(ctx, config = {}) {
  return createImHostPlugin().apply(ctx, config);
}
export {
  apply6 as apply,
  createImHostPlugin,
  inject,
  name
};
