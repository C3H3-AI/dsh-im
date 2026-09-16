import { unlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

import { EmailConfigStore } from '../../../../src/channels/email/config-store.mjs';
import { EmailHarnessClient } from '../../../../src/channels/email/harness-client.mjs';
import { EmailStateStore } from '../../../../src/channels/email/state-store.mjs';
import { EmailController } from '../../../../src/channels/email/email-controller.mjs';
import { EmailRuntime } from '../../../../src/channels/email/email-runtime.mjs';
import { EMAIL_DESCRIPTOR } from '../../../../src/channels/email/email-bridge.mjs';
import {
  BotWorkspaceStore,
  createBotWorkspaceScope,
  createWorkspaceAwareController,
  observeBotWorkspaceRemovals,
} from '../../../../src/channels/shared/bot-workspace-store.mjs';
import { listAgentPresetCatalog } from '../../../../src/channels/shared/agent-preset.mjs';
import { listModelCatalog } from '../../../../src/channels/shared/model-setting.mjs';
import { createDeliveryAdapter } from '../../delivery-adapter.mjs';
import { createConnectionSupervisor } from '../wecom/connection-supervisor.mjs';
import { createHarnessCommandExecutor } from '../../harness-command-executor.mjs';
import { harnessConnection } from '../../harness-connection.mjs';
import { createHarnessSessionExecutors } from '../../harness-session-coordinator.mjs';
import {
  getInboundTtlRuntime,
  registerInboundTtlWorkspaces,
} from '../../inbound-ttl-runtime.mjs';
import {
  accessPolicyProvider,
  initialAccessPolicyFor,
} from '../shared/access-policy-production.mjs';

function pluginPaths(config) {
  const dshHome = resolve(config.dshHome ?? process.env.DSH_HOME ?? join(homedir(), '.dsh'));
  const root = resolve(config.dataDir ?? join(dshHome, 'integrations', 'dsh-email'));
  return {
    config: resolve(config.configPath ?? join(root, 'config.json')),
    bots: resolve(config.botsDir ?? join(root, 'bots')),
    workspaces: resolve(config.workspacesPath ?? join(root, 'workspaces.json')),
  };
}

export async function createProductionController(ctx, config = {}, internals = {}) {
  if (!ctx?.credentials) throw new TypeError('dsh-im Email requires ctx.credentials');
  const connection = harnessConnection(ctx, config);

  const ConfigStore = internals.ConfigStore ?? EmailConfigStore;
  const StateStore = internals.StateStore ?? EmailStateStore;
  const Harness = internals.HarnessClient ?? EmailHarnessClient;
  const Controller = internals.Controller ?? EmailController;
  const Runtime = internals.Runtime ?? EmailRuntime;
  const createSupervisor = internals.createConnectionSupervisor ?? createConnectionSupervisor;
  const baseLogger = typeof ctx.logger === 'function' ? ctx.logger('dsh-im:email') : (ctx.logger ?? console);
  // The cordis logger does not surface in the web profile journal, so every
  // level is teed to the process console to keep mail polling observable.
  const logger = {
    log: (...args) => { baseLogger.log?.(...args); console.log('[dsh-im:email]', ...args); },
    info: (...args) => { baseLogger.info?.(...args); console.info('[dsh-im:email]', ...args); },
    warn: (...args) => { baseLogger.warn?.(...args); console.warn('[dsh-im:email]', ...args); },
    error: (...args) => { baseLogger.error?.(...args); console.error('[dsh-im:email]', ...args); },
  };
  const agentPresetCatalog = () => listAgentPresetCatalog(ctx);
  const paths = pluginPaths(config);
  const configStore = await new ConfigStore(paths.config).load();
  const defaultWorkspace = resolve(config.workspace ?? process.cwd());
  const WorkspaceStore = internals.WorkspaceStore ?? BotWorkspaceStore;
  const workspaces = internals.workspaces
    ?? await new WorkspaceStore(paths.workspaces, { defaultWorkspace }).load();
  const configuredBots = configStore.list();
  await workspaces.reconcile(configuredBots.map((bot) => bot.botId));
  await Promise.all(configuredBots.map((bot) => workspaces.ensure(bot.botId, {
    defaultAgentPreset: config.agentPreset,
    initialAccessPolicy: initialAccessPolicyFor('email', bot),
  })));
  const observedConfigStore = typeof configStore.remove === 'function'
    ? observeBotWorkspaceRemovals(configStore, { workspaces })
    : configStore;
  const stateStores = new Map();
  const statePath = (botId) => resolve(paths.bots, botId, 'state.json');
  const stateFor = async (botId) => {
    let state = stateStores.get(botId);
    if (!state) {
      state = await new StateStore(statePath(botId)).load();
      stateStores.set(botId, state);
    }
    return state;
  };
  const commandExecutor = createHarnessCommandExecutor(ctx, internals.commandExecutor);
  const inboundTtl = internals.inboundTtl ?? getInboundTtlRuntime(ctx, config);
  const inboundTtlService = inboundTtl?.service ?? inboundTtl;
  registerInboundTtlWorkspaces(ctx, inboundTtlService, {
    workspaces,
    configStore: observedConfigStore,
    defaultWorkspace,
  });
  const { controlExecutor, sessionMaintenanceExecutor, fileIngressExecutor } = createHarnessSessionExecutors(ctx, {
    controlExecutor: internals.controlExecutor,
    sessionMaintenanceExecutor: internals.sessionMaintenanceExecutor,
    fileIngressExecutor: internals.fileIngressExecutor,
    inboundTtlService,
  });
  const harness = new Harness({
    ...connection,
    workspace: defaultWorkspace,
    autostart: false,
    dshBin: config.dshBin ?? 'dsh',
    ...(commandExecutor ? { commandExecutor } : {}),
    ...(controlExecutor ? { controlExecutor } : {}),
    ...(sessionMaintenanceExecutor ? { sessionMaintenanceExecutor } : {}),
    ...(fileIngressExecutor ? { fileIngressExecutor } : {}),
  });
  const modelCatalog = () => listModelCatalog(harness);
  const coreController = new Controller({
    credentials: ctx.credentials,
    configStore: observedConfigStore,
    logger,
    createRuntime: async ({ botId, config: botConfig, credential }) => {
      const state = await stateFor(botId);
      await workspaces.ensure(botId, {
        defaultAgentPreset: config.agentPreset,
        initialAccessPolicy: initialAccessPolicyFor('email', botConfig),
      });
      const workspaceScope = createBotWorkspaceScope(harness, {
        botId, workspaces, state, agentPresetCatalog,
      });
      return new Runtime({
        config: botConfig,
        password: credential.password,
        harness: workspaceScope.harness,
        state: workspaceScope.state,
        contextEnhancement: { botId, getSettings: () => workspaces.contextEnhancementFor(botId) },
        accessPolicy: accessPolicyProvider(workspaces, botId, {
          channel: 'email', config: botConfig,
        }),
        pollIntervalMs: config.pollIntervalMs,
        replyTimeoutMs: config.replyTimeoutMs ?? 600_000,
        logger: {
          error: (...args) => logger.error?.(`[${botId}]`, ...args),
          warn: (...args) => logger.warn?.(`[${botId}]`, ...args),
          info: (...args) => logger.info?.(`[${botId}]`, ...args),
          debug: (...args) => logger.debug?.(`[${botId}]`, ...args),
        },
      });
    },
    deleteState: async ({ botId }) => {
      const state = stateStores.get(botId);
      stateStores.delete(botId);
      if (state && typeof state.remove === 'function') {
        await state.remove();
      } else {
        try {
          await unlink(statePath(botId));
        } catch (error) {
          if (error?.code !== 'ENOENT') throw error;
        }
      }
    },
  });
  const controller = createWorkspaceAwareController(coreController, {
    workspaces,
    stateFor,
    agentPresetCatalog,
    modelCatalog,
  });
  const supervisor = createSupervisor({
    controller,
    harness,
    logger,
    retryDelaysMs: config.retryDelaysMs,
    healthyIntervalMs: config.healthyIntervalMs,
  }).start();
  return {
    controller,
    deliveryAdapter: createDeliveryAdapter({
      channel: 'email', workspaces, coreController, stateFor,
    }),
    ready: supervisor.ready,
    async close() {
      await supervisor.close();
      await controller.close();
      harness.stopManagedProcess();
    },
  };
}

export { EMAIL_DESCRIPTOR };
