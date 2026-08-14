// plugin-src/host/index.mjs
import { apply as applyDingtalk } from "@xmanrui/dsh-dingtalk";
import { apply as applyFeishu } from "@xmanrui/dsh-feishu";
import { apply as applyWeixin } from "@xmanrui/dsh-weixin";
var name = "dsh-im-host";
var inject = ["connection", "credentials", "webServer"];
function createImHostPlugin(internals = {}) {
  const startFeishu = internals.applyFeishu ?? applyFeishu;
  const startWeixin = internals.applyWeixin ?? applyWeixin;
  const startDingtalk = internals.applyDingtalk ?? applyDingtalk;
  return Object.freeze({
    name,
    inject,
    async apply(ctx, config = {}) {
      await startFeishu(ctx, config.feishu ?? {});
      await startWeixin(ctx, config.weixin ?? {});
      await startDingtalk(ctx, config.dingtalk ?? {});
    }
  });
}
async function apply(ctx, config = {}) {
  return createImHostPlugin().apply(ctx, config);
}
export {
  apply,
  createImHostPlugin,
  inject,
  name
};
