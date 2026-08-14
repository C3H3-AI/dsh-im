// plugin-src/host/index.mjs
import { apply as applyFeishu } from "@xmanrui/dsh-feishu";
import { apply as applyWeixin } from "@xmanrui/dsh-weixin";
var name = "dsh-im-host";
var inject = ["connection", "credentials", "webServer"];
function createImHostPlugin(internals = {}) {
  const startFeishu = internals.applyFeishu ?? applyFeishu;
  const startWeixin = internals.applyWeixin ?? applyWeixin;
  return Object.freeze({
    name,
    inject,
    async apply(ctx, config = {}) {
      await startFeishu(ctx, config.feishu ?? {});
      await startWeixin(ctx, config.weixin ?? {});
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
