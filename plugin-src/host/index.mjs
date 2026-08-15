import { apply as applyDingtalk } from './channels/dingtalk/index.mjs';
import { apply as applyFeishu } from './channels/feishu/index.mjs';
import { apply as applyQq } from './channels/qq/index.mjs';
import { apply as applyWecom } from './channels/wecom/index.mjs';
import { apply as applyWeixin } from './channels/weixin/index.mjs';

export const name = 'dsh-im-host';
export const inject = ['connection', 'credentials', 'webServer'];

export function createImHostPlugin(internals = {}) {
  const startFeishu = internals.applyFeishu ?? applyFeishu;
  const startWeixin = internals.applyWeixin ?? applyWeixin;
  const startDingtalk = internals.applyDingtalk ?? applyDingtalk;
  const startWecom = internals.applyWecom ?? applyWecom;
  const startQq = internals.applyQq ?? applyQq;
  return Object.freeze({
    name,
    inject,
    async apply(ctx, config = {}) {
      await startFeishu(ctx, config.feishu ?? {});
      await startWeixin(ctx, config.weixin ?? {});
      await startDingtalk(ctx, config.dingtalk ?? {});
      await startWecom(ctx, config.wecom ?? {});
      await startQq(ctx, config.qq ?? {});
    },
  });
}

export async function apply(ctx, config = {}) {
  return createImHostPlugin().apply(ctx, config);
}
