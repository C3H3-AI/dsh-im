import * as React from 'react';
import { EmailLogoGlyph } from '../../channel-logos.js';
import { createTokenChannelSettings } from '../shared/token-channel.js';
import { EMAIL_ENDPOINTS, emailClientApi } from './api.js';
import { installEmailStyles } from './styles.js';
import { h } from '../../i18n.js';

/**
 * Provider presets mirror the host-side table so the form can prefill hosts.
 * Keeping the copy local means the panel works before any RPC round-trip.
 */
const PROVIDERS = [
  { key: 'qq', label: 'QQ 邮箱', imapHost: 'imap.qq.com', imapPort: 993, smtpHost: 'smtp.qq.com', smtpPort: 465 },
  { key: '163', label: '163 邮箱', imapHost: 'imap.163.com', imapPort: 993, smtpHost: 'smtp.163.com', smtpPort: 465 },
  { key: 'gmail', label: 'Gmail', imapHost: 'imap.gmail.com', imapPort: 993, smtpHost: 'smtp.gmail.com', smtpPort: 465 },
  { key: 'custom', label: '自定义服务器' },
];

const PROVIDER_HINTS = {
  qq: '在 QQ 邮箱「设置 → 账户」中开启 IMAP/SMTP 服务，并生成 16 位授权码（不是登录密码）。',
  '163': '在 163 邮箱「设置 → POP3/SMTP/IMAP」中开启服务，并新增授权密码。',
  gmail: '需要先开启两步验证，再生成「应用专用密码」。',
  custom: '请填写邮箱服务商提供的 IMAP 与 SMTP 服务器地址及端口。',
};

function field(label, control, hint) {
  return h('label', { className: 'dim-emailField' },
    h('span', null, label),
    control,
    hint ? h('span', { className: 'dim-emailHint' }, hint) : null);
}

/**
 * Mailbox credential form: address + app password + provider (or explicit
 * hosts) + the sender allowlist, which is required because a mail address is
 * forgeable and an open mailbox would let anyone drive the Harness.
 */
function MailboxPanel({ busy, error, onSubmit, onCancel }) {
  const [provider, setProvider] = React.useState('qq');
  const [address, setAddress] = React.useState('');
  const [password, setPassword] = React.useState('');
  const [allowedSenders, setAllowedSenders] = React.useState('');
  const [imapHost, setImapHost] = React.useState('');
  const [imapPort, setImapPort] = React.useState('');
  const [smtpHost, setSmtpHost] = React.useState('');
  const [smtpPort, setSmtpPort] = React.useState('');
  const preset = PROVIDERS.find((entry) => entry.key === provider) ?? PROVIDERS[0];
  const custom = provider === 'custom';

  const submit = () => onSubmit({
    address: address.trim(),
    password,
    provider,
    allowedSenders: allowedSenders
      .split(/[\s,;，；]+/)
      .map((value) => value.trim())
      .filter(Boolean),
    ...(custom ? {
      imapHost: imapHost.trim(), imapPort: imapPort.trim() || undefined,
      smtpHost: smtpHost.trim(), smtpPort: smtpPort.trim() || undefined,
    } : {}),
  });

  return h('section', { className: 'ddt-card dim-surfaceCard dim-emailPanel' },
    h('h3', null, '接入邮箱'),
    h('p', null, 'DeepSeek Harness 会读取该邮箱的新邮件作为指令，并在同一邮件线程内回复处理结果。'),
    h('div', { className: 'dim-emailFields' },
      field('邮箱服务商', h('select', {
        value: provider,
        onChange: (event) => setProvider(event.target.value),
        disabled: busy,
      }, PROVIDERS.map((entry) => h('option', { key: entry.key, value: entry.key }, entry.label))),
      h('span', { className: 'dim-emailHint' }, PROVIDER_HINTS[provider])),
      field('邮箱地址', h('input', {
        type: 'email', value: address, placeholder: 'your-name@qq.com', disabled: busy,
        onChange: (event) => setAddress(event.target.value),
      })),
      field('应用密码 / 授权码', h('input', {
        type: 'password', value: password, placeholder: 'IMAP/SMTP 授权码', disabled: busy,
        onChange: (event) => setPassword(event.target.value),
      }), '不是邮箱登录密码；请在邮箱设置中单独生成。'),
      custom ? h('div', { className: 'dim-emailGrid' },
        field('IMAP 服务器', h('input', {
          value: imapHost, placeholder: 'imap.example.com', disabled: busy,
          onChange: (event) => setImapHost(event.target.value),
        })),
        field('端口', h('input', {
          value: imapPort, placeholder: '993', disabled: busy,
          onChange: (event) => setImapPort(event.target.value),
        }))) : null,
      custom ? h('div', { className: 'dim-emailGrid' },
        field('SMTP 服务器', h('input', {
          value: smtpHost, placeholder: 'smtp.example.com', disabled: busy,
          onChange: (event) => setSmtpHost(event.target.value),
        })),
        field('端口', h('input', {
          value: smtpPort, placeholder: '465', disabled: busy,
          onChange: (event) => setSmtpPort(event.target.value),
        }))) : null,
      field('允许的发件人', h('textarea', {
        value: allowedSenders, disabled: busy,
        placeholder: 'me@example.com\n同事@example.com',
        onChange: (event) => setAllowedSenders(event.target.value),
      }), '必填。只有这些地址发来的邮件会触发 Harness；多个地址用换行或逗号分隔。')),
    error ? h('p', { className: 'dim-inlineError', role: 'alert' }, error.message ?? String(error)) : null,
    h('div', { className: 'ddt-actions dim-viewActions' },
      h('button', { type: 'button', className: 'ddt-button', onClick: onCancel, disabled: busy }, '取消'),
      h('button', {
        type: 'button', className: 'ddt-button', 'data-kind': 'primary',
        onClick: submit, disabled: busy || !address.trim() || !password,
      }, busy ? '正在连接邮箱…' : '连接邮箱')));
}

/** Per-account settings: edit hosts and the allowlist without reconnecting. */
function MailboxSettings({ account, busy, error, onSave, onCancel }) {
  const [allowedSenders, setAllowedSenders] = React.useState(
    (account?.allowedSenders ?? []).join('\n'),
  );
  return h('section', { className: 'dim-emailPanel' },
    h('div', { className: 'dim-emailFields' },
      field('允许的发件人', h('textarea', {
        value: allowedSenders, disabled: busy,
        onChange: (event) => setAllowedSenders(event.target.value),
      }), '保存后会重新连接邮箱以使设置立即生效。')),
    error ? h('p', { className: 'dim-inlineError', role: 'alert' }, error.message ?? String(error)) : null,
    h('div', { className: 'ddt-actions dim-viewActions' },
      h('button', { type: 'button', className: 'ddt-button', onClick: onCancel, disabled: busy }, '取消'),
      h('button', {
        type: 'button', className: 'ddt-button', 'data-kind': 'primary', disabled: busy,
        onClick: () => onSave({
          allowedSenders: allowedSenders
            .split(/[\s,;，；]+/).map((value) => value.trim()).filter(Boolean),
        }),
      }, busy ? '正在保存…' : '保存')));
}

export const EMAIL_SETTINGS_DEFINITION = Object.freeze({
  channel: 'Email',
  endpoints: EMAIL_ENDPOINTS,
  api: emailClientApi,
  LogoGlyph: EmailLogoGlyph,
  installStyles: installEmailStyles,
  pageClass: 'dim-pageEmail',
  avatarClass: 'dim-avatarEmail',
  connectionLabel: ' IMAP/SMTP 邮箱',
  tokenPlaceholder: '',
  emptyTitle: '接入邮箱',
  emptyDescription: '使用现有邮箱收发指令：邮件进来触发 Harness，处理结果以回信形式送达。',
  platformLabel: '邮箱地址',
  // The mailbox form supplies every field itself: the address is the identity
  // and the password is the secret, so the values pass through unchanged
  // rather than being reduced to a single token.
  credentialPayload: (values) => values,
  CredentialPanel: MailboxPanel,
  credentialAriaLabel: '配置邮箱收发',
  credentialOpenLabel: '配置邮箱',
  credentialNoun: '邮箱配置',
  emptyActionLabel: '配置邮箱',
  AccountSettings: MailboxSettings,
  accountSettingsEndpoint: EMAIL_ENDPOINTS.updateMailbox,
});

const channel = createTokenChannelSettings(EMAIL_SETTINGS_DEFINITION);

export const EmailSettingsTab = channel.SettingsTab;
export const EmailAccountCard = channel.AccountCard;
