import { apply as applyFeishu } from '@xmanrui/dsh-feishu';
import { apply as applyWeixin } from '@xmanrui/dsh-weixin';

export const name = 'dsh-im-host';
export const inject = ['connection', 'credentials', 'webServer'];

export function createImHostPlugin(internals = {}) {
  const startFeishu = internals.applyFeishu ?? applyFeishu;
  const startWeixin = internals.applyWeixin ?? applyWeixin;
  return Object.freeze({
    name,
    inject,
    async apply(ctx, config = {}) {
      await startFeishu(ctx, config.feishu ?? {});
      await startWeixin(ctx, config.weixin ?? {});
    },
  });
}

export async function apply(ctx, config = {}) {
  return createImHostPlugin().apply(ctx, config);
}
