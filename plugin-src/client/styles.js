export const IM_STYLE_ID = 'xmanrui-dsh-im-settings';

const CSS = String.raw`
.dim-page {
  --dim-blue: #3370ff;
  --dim-blue-soft: color-mix(in srgb, var(--dim-blue) 9%, transparent);
  width: 100%;
  max-width: 1080px;
  padding: 2px 0 30px;
  color: var(--dsw-alias-label-primary, #1f2329);
  box-sizing: border-box;
}
.dim-page *, .dim-page *::before, .dim-page *::after { box-sizing: border-box; }
.dim-title { display: flex; align-items: center; justify-content: space-between; gap: 22px; margin: 0 0 26px; }
.dim-title p { margin: 0; color: var(--dsw-alias-label-secondary, #646a73); font-size: 13px; line-height: 20px; white-space: nowrap; }
.dim-channelCount { flex: none; padding: 6px 11px; border-radius: 999px; color: var(--dsw-alias-label-secondary, #646a73); background: var(--dsw-alias-fill-secondary, #f2f3f5); font-size: 11px; white-space: nowrap; }
.dim-layout { display: grid; grid-template-columns: 188px 1px minmax(0, 1fr); gap: 26px; align-items: start; }
.dim-rail { display: grid; gap: 12px; }
.dim-channel { width: 100%; min-height: 76px; display: grid; grid-template-columns: 42px minmax(0, 1fr) 14px; align-items: center; gap: 12px; padding: 13px 12px; border: 1px solid transparent; border-radius: 16px; color: inherit; background: var(--dsw-alias-bg-layer-3, #fff); box-shadow: 0 5px 18px rgb(31 35 41 / 5%); font: inherit; text-align: left; cursor: pointer; transition: border-color .16s ease, background .16s ease, box-shadow .16s ease, transform .16s ease; }
.dim-channel:hover { transform: translateY(-1px); border-color: color-mix(in srgb, var(--dim-blue) 25%, transparent); box-shadow: 0 8px 24px rgb(31 35 41 / 8%); }
.dim-channel[aria-selected="true"] { border-color: color-mix(in srgb, var(--dim-blue) 52%, transparent); color: var(--dim-blue); background: var(--dim-blue-soft); box-shadow: 0 0 0 1px color-mix(in srgb, var(--dim-blue) 8%, transparent), 0 10px 26px rgb(51 112 255 / 10%); }
.dim-channel:focus-visible { outline: 2px solid color-mix(in srgb, var(--dim-blue) 68%, white); outline-offset: 2px; }
.dim-logo { width: 42px; height: 42px; display: grid; place-items: center; border-radius: 12px; box-shadow: 0 1px 4px rgb(31 35 41 / 8%); }
.dim-logo svg { display: block; width: 27px; height: 27px; }
.dim-logoWeixin { color: white; background: #07c160; }
.dim-logoWeixin svg { width: 25px; height: 25px; }
.dim-logoFeishu { background: white; border: 1px solid var(--dsw-alias-line-border, #e5e6eb); }
.dim-logoFeishu svg { width: 30px; height: 30px; }
.dim-channelCopy { min-width: 0; display: grid; gap: 2px; }
.dim-channelCopy strong { overflow: hidden; color: inherit; font-size: 15px; line-height: 21px; font-weight: 680; text-overflow: ellipsis; white-space: nowrap; }
.dim-channelCopy small { overflow: hidden; color: var(--dsw-alias-label-tertiary, #8f959e); font-size: 10px; line-height: 16px; text-overflow: ellipsis; white-space: nowrap; }
.dim-chevron { color: var(--dsw-alias-label-tertiary, #8f959e); font-size: 22px; line-height: 1; transform: translateY(-1px); }
.dim-channel[aria-selected="true"] .dim-chevron { color: var(--dim-blue); }
.dim-divider { width: 1px; min-height: 520px; background: var(--dsw-alias-line-divider, #eef0f3); }
.dim-panel { min-width: 0; }
.dim-panel .bxf-page, .dim-panel .dxw-page { width: 100%; max-width: none; padding: 0 0 24px; }
.dim-panel .bxf-heading, .dim-panel .dxw-heading { justify-content: flex-end; }
.dim-panel .bxf-headingTools, .dim-panel .dxw-tools { width: 100%; justify-content: flex-end; }
@media (max-width: 840px) {
  .dim-title { align-items: flex-start; }
  .dim-layout { grid-template-columns: minmax(0, 1fr); gap: 18px; }
  .dim-rail { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .dim-divider { display: none; }
  .dim-channel { min-height: 68px; }
}
@media (max-width: 560px) {
  .dim-title { flex-direction: column; gap: 10px; }
  .dim-title p { white-space: normal; }
  .dim-rail { grid-template-columns: minmax(0, 1fr); }
}
@media (prefers-reduced-motion: reduce) {
  .dim-page * { transition-duration: .01ms !important; }
}
`;

export function installImStyles() {
  if (typeof document === 'undefined') return () => {};
  const existing = document.querySelector(`style[data-plugin-css="${IM_STYLE_ID}"]`);
  if (existing) return () => {};
  const style = document.createElement('style');
  style.dataset.plugin = '@xmanrui/dsh-im';
  style.dataset.pluginCss = IM_STYLE_ID;
  style.textContent = CSS;
  document.head.appendChild(style);
  return () => style.remove();
}
