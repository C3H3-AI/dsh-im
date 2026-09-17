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

/**
 * Session binding: how incoming mail maps onto Harness sessions.
 *
 * Three levels, highest first:
 *   1. a per-sender binding,
 *   2. the account-wide binding,
 *   3. no binding — every mail thread starts its own session.
 */
/**
 * Session ids are long uuids. The picker shows the title, falling back to a
 * shortened id, because the per-sender column is too narrow for the full id.
 */
function shortenSessionId(sessionId) {
  const text = String(sessionId ?? '');
  return text.length <= 20 ? text : `${text.slice(0, 8)}…${text.slice(-6)}`;
}

/**
 * Pickers are narrow, so a very long title is trimmed from the middle with the
 * tail kept — automation titles carry their distinguishing timestamp at the
 * end. The full id remains the option's tooltip.
 */
function sessionLabel(session) {
  const title = String(session?.title ?? '').trim();
  if (!title) return shortenSessionId(session?.sessionId);
  if (title.length <= 22) return title;
  // 13px CJK / 7px latin: 22 visible characters stay inside the ~200px the
  // narrowest picker gives the label.
  return `${title.slice(0, 12)}…${title.slice(-8)}`;
}

function SessionBindingPanel({ account, rpcCall, endpoints, onChanged, disabled }) {
  const [binding, setBinding] = React.useState(null);
  const [sessions, setSessions] = React.useState([]);
  const [accountSession, setAccountSession] = React.useState('');
  const [senderRows, setSenderRows] = React.useState([]);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState(null);
  const [notice, setNotice] = React.useState(null);

  // The card receives the raw RPC bridge, whose response wraps the payload in
  // { ok, value }; the settings panel works with the unwrapped value.
  const invoke = React.useCallback(async (endpoint, payload) => {
    const response = await rpcCall(endpoint, payload);
    if (response && typeof response === 'object' && 'ok' in response) {
      if (response.ok === false) {
        throw new Error(response.error?.message ?? '请求失败');
      }
      return response.value;
    }
    return response;
  }, [rpcCall]);

  const load = React.useCallback(async () => {
    if (typeof rpcCall !== 'function') return;
    try {
      const [current, listed] = await Promise.all([
        invoke(endpoints.getBinding, { botId: account.botId }),
        invoke(endpoints.listSessions, { botId: account.botId }),
      ]);
      setBinding(current);
      setAccountSession(current?.account ?? '');
      const senders = current?.senders ?? {};
      setSenderRows((current?.knownSenders ?? []).map((address) => ({
        address, sessionId: senders[address] ?? '',
      })));
      setSessions(Array.isArray(listed?.sessions) ? listed.sessions : []);
    } catch (loadError) {
      setError(loadError);
    }
  }, [account.botId, endpoints, invoke, rpcCall]);

  React.useEffect(() => { void load(); }, [load]);

  const persist = async (nextAccount, nextRows) => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const senders = {};
      for (const row of nextRows) {
        if (row?.address && row.sessionId) senders[row.address] = row.sessionId;
      }
      await invoke(endpoints.setBinding, {
        botId: account.botId,
        account: nextAccount || null,
        senders,
      });
      setNotice('会话绑定已保存。');
      await onChanged?.({ silent: true });
    } catch (saveError) {
      setError(saveError);
    } finally {
      setBusy(false);
    }
  };

  const options = (selected, placeholder) => [
    h('option', { key: '__none', value: '' }, placeholder),
    ...sessions.map((session) => h('option', {
      key: session.sessionId,
      value: session.sessionId,
      // The full id is a long uuid; it stays available as the tooltip and the
      // value, while the visible label keeps the title within the narrow
      // per-sender column.
      title: session.sessionId,
    }, sessionLabel(session))),
    // Keep an unknown-but-set id selectable so loading never silently drops it.
    ...(selected && !sessions.some((s) => s.sessionId === selected)
      ? [h('option', { key: selected, value: selected, title: selected }, shortenSessionId(selected))]
      : []),
  ];

  // The picker truncates long titles, so the current choice is echoed in full
  // underneath it; nothing is lost to the narrow column.
  const selectionHint = (sessionId) => {
    if (!sessionId) return null;
    const found = sessions.find((session) => session.sessionId === sessionId);
    const title = String(found?.title ?? '').trim();
    if (!title || title.length <= 28) return null;
    // Split so the prefix is translated while the title stays verbatim.
    return h('span', { className: 'dim-emailHint dim-emailBindingSelected', title },
      '已选：', title);
  };

  const locked = disabled || busy;

  return h('section', { className: 'dim-emailPanel dim-emailBinding' },
    h('h4', null, '会话绑定'),
    h('p', { className: 'dim-emailHint' },
      '不绑定则每封新邮件开启一个新会话；绑定固定会话后，来信都在该会话内继续。'),
    h('div', { className: 'dim-emailFields' },
      field('固定会话（账号级）',
        h('select', {
          value: accountSession,
          disabled: locked,
          onChange: (event) => setAccountSession(event.target.value),
        }, options(accountSession, '不绑定（每封新邮件新建会话）')),
        selectionHint(accountSession)),
      senderRows.length
        ? h('div', { className: 'dim-emailFields' },
          h('span', { className: 'dim-emailHint' }, '按发件人覆盖（优先于账号级）'),
          ...senderRows.map((row, index) => h('div', { key: row.address, className: 'dim-emailBindingRow' },
            h('span', { className: 'dim-emailBindingSender', title: row.address }, row.address),
            h('select', {
              value: row.sessionId,
              disabled: locked,
              onChange: (event) => {
                const next = [...senderRows];
                next[index] = { ...row, sessionId: event.target.value };
                setSenderRows(next);
              },
            }, options(row.sessionId, '跟随账号级')))),
          // Several senders often belong together; one click points them all at
          // the same session instead of repeating the choice per row.
          h('div', { className: 'ddt-actions dim-viewActions' },
            h('button', {
              type: 'button', className: 'ddt-button', disabled: locked || !accountSession,
              onClick: () => setSenderRows(senderRows.map((row) => ({ ...row, sessionId: accountSession }))),
            }, '所有发件人同上')))
        : h('p', { className: 'dim-emailHint' }, '尚无可覆盖的发件人（先在上方配置允许的发件人）。')),
    error ? h('p', { className: 'dim-inlineError', role: 'alert' }, error.message ?? String(error)) : null,
    notice ? h('p', { className: 'dim-emailHint', role: 'status' }, notice) : null,
    h('div', { className: 'ddt-actions dim-viewActions' },
      h('button', {
        type: 'button', className: 'ddt-button', disabled: locked,
        onClick: () => { void persist(accountSession, senderRows); },
      }, busy ? '正在保存…' : '保存绑定'),
      h('button', {
        type: 'button', className: 'ddt-button', disabled: locked,
        onClick: () => {
          setAccountSession('');
          const cleared = senderRows.map((row) => ({ ...row, sessionId: '' }));
          setSenderRows(cleared);
          void persist('', cleared);
        },
      }, '清除绑定')));
}

/** Per-account settings: edit hosts and the allowlist without reconnecting. */
function MailboxSettings({ account, busy, error, onSave, onCancel, rpcCall, endpoints, onChanged }) {
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
      }, busy ? '正在保存…' : '保存')),
    h(SessionBindingPanel, {
      account, rpcCall, endpoints, onChanged, disabled: busy,
    }));
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
