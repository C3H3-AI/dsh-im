import { createProductionController } from './production.mjs';
import { installEmailRpc } from './rpc.mjs';

export const name = 'dsh-im-email-host';
export const inject = ['connection', 'credentials', 'typertGateway'];

export async function apply(ctx, config = {}) {
  if (config?.controller) return installEmailRpc(ctx, config.controller, config.rpcAuthority);
  const production = await createProductionController(ctx, config, config.internals ?? {});
  const unregisterDelivery = config.deliveryService && production.deliveryAdapter
    ? config.deliveryService.registerAdapter(production.deliveryAdapter) : undefined;
  const disposeRpc = installEmailRpc(ctx, production.controller, config.rpcAuthority);
  ctx.effect(() => async () => {
    await unregisterDelivery?.(); await production.close();
  }, 'dsh-im: close Email connections');
  return disposeRpc;
}

export { createProductionController } from './production.mjs';
export { EMAIL_ENDPOINTS, EMAIL_RPC_CHANNEL, EMAIL_RPC_ENDPOINTS,
  createEmailRpcHandler, installEmailRpc } from './rpc.mjs';
