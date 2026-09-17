export const EMAIL_STYLE_ID = 'xmanrui-dsh-im-email-settings';
const CSS = String.raw`
.dim-pageEmail { --ddt-accent: #2f6fd0; --ddt-accent-deep: #24559f; --ddt-accent-wash: #eef4fd; }
.dim-avatarEmail { color: #fff; background: linear-gradient(180deg, #6ea8f5 0%, #3d7fe0 50%, #24559f 100%); box-shadow: inset 0 1px 1px rgb(255 255 255 / 45%), 0 1px 3px rgb(31 35 41 / 12%); }
.dim-avatarEmail svg { display: block; }
.dim-emailPanel { padding: 20px; }
.dim-emailPanel p { color: var(--dsw-alias-label-secondary, #646a73); }
.dim-emailFields { display: grid; gap: 12px; margin: 16px 0; }
.dim-emailField { display: grid; gap: 6px; }
.dim-emailField > span { font-size: 13px; color: var(--dsw-alias-label-secondary, #646a73); }
.dim-emailField input, .dim-emailField select, .dim-emailField textarea {
  padding: 8px 10px; border: 1px solid var(--dsw-alias-border, #dee0e3); border-radius: 6px;
  background: var(--dsw-alias-bg-base, #fff); color: inherit; font: inherit;
}
.dim-emailField textarea { min-height: 76px; resize: vertical; }
.dim-emailHint { font-size: 12px; color: var(--dsw-alias-label-tertiary, #8f959e); }
.dim-emailGrid { display: grid; grid-template-columns: 1fr 120px; gap: 12px; }
.dim-emailBinding { margin-top: 20px; border-top: 1px solid var(--dsw-alias-border, #dee0e3); padding-top: 16px; }
.dim-emailBinding h4 { margin: 0 0 4px; font-size: 14px; }
.dim-emailBindingRow { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1.2fr); gap: 10px; align-items: center; }
.dim-emailBindingSender { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 13px; }
`;
export function installEmailStyles() {
  if (typeof document === 'undefined') return () => {};
  const existing = document.querySelector(`style[data-plugin-css="${EMAIL_STYLE_ID}"]`);
  if (existing) return () => {};
  const style = document.createElement('style'); style.dataset.plugin = '@xmanrui/dsh-im';
  style.dataset.pluginCss = EMAIL_STYLE_ID; style.textContent = CSS; document.head.appendChild(style);
  return () => style.remove();
}
