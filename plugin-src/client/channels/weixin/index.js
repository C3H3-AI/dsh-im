import * as React from 'react';

import {
  WEIXIN_ENDPOINTS,
  WEIXIN_RPC_CHANNEL,
  formatRemaining,
  normalizeProvisioning,
  normalizeSnapshot,
  presentError,
  safeQrSource,
  safeVerificationUrl,
  unwrapRpcResult,
} from './api.js';
import { installWeixinStyles } from './styles.js';

const h = React.createElement;

export const name = 'weixin-settings';
export const inject = ['slots', 'connection'];

function WeixinIcon({ size = 26 }) {
  return h('svg', {
    width: size,
    height: size,
    viewBox: '0 0 24 24',
    fill: 'none',
    xmlns: 'http://www.w3.org/2000/svg',
    'aria-hidden': 'true',
  },
  h('path', {
    d: 'M9.7 4.2c-4.15 0-7.5 2.72-7.5 6.08 0 1.91 1.08 3.61 2.78 4.72l-.7 2.35 2.75-1.37c.84.25 1.73.38 2.67.38 4.14 0 7.5-2.72 7.5-6.08S13.84 4.2 9.7 4.2Z',
    fill: 'currentColor', opacity: '.96',
  }),
  h('path', {
    d: 'M14.4 8.2c4.08 0 7.4 2.66 7.4 5.95 0 1.78-.97 3.38-2.5 4.47l.58 2-2.36-1.18c-.97.43-2.03.65-3.12.65-4.09 0-7.4-2.66-7.4-5.94 0-3.29 3.31-5.95 7.4-5.95Z',
    fill: 'currentColor', stroke: 'white', strokeWidth: '.8',
  }),
  h('circle', { cx: '7.25', cy: '9.5', r: '1', fill: 'white' }),
  h('circle', { cx: '11.55', cy: '9.5', r: '1', fill: 'white' }),
  h('circle', { cx: '12.1', cy: '13.2', r: '.9', fill: 'white' }),
  h('circle', { cx: '16.3', cy: '13.2', r: '.9', fill: 'white' }));
}

const Button = React.forwardRef(function Button(
  { children, kind = 'secondary', className = '', ...props },
  ref,
) {
  return h('button', {
    ...props,
    ref,
    type: 'button',
    className: `dxw-button ${className}`.trim(),
    'data-kind': kind,
  }, children);
});

function Heading({ totals, adding, busy, onAdd, addButtonRef }) {
  return h('div', { className: 'dxw-heading' },
    h('div', { className: 'dxw-tools' },
      totals.configured > 0
        ? h('div', { className: 'dxw-badge' },
            h('span', { className: 'dxw-dot', 'data-tone': totals.connected > 0 ? 'success' : 'warning' }),
            h('span', null, `${totals.connected} / ${totals.configured} 在线`))
        : null,
      h('div', { className: 'dxw-badge', title: 'bot_token 仅保存在 Harness Host 凭据服务中' },
        h('span', null, '凭据仅保存在本机')),
      h(Button, {
        kind: 'primary',
        onClick: onAdd,
        disabled: adding || busy,
        ref: addButtonRef,
      }, adding ? '正在绑定' : '扫码绑定微信'),
    ),
  );
}

function LoadingView() {
  return h('div', { className: 'dxw-card dxw-loading', 'aria-busy': 'true' },
    h('div', { className: 'dxw-spinner' }),
    h('span', null, '正在读取微信连接状态…'));
}

function EmptyView({ onStart, busy }) {
  return h('div', { className: 'dxw-card' },
    h('div', { className: 'dxw-cardBody dxw-empty' },
      h('div', null,
        h('div', { className: 'dxw-stateLabel' },
          h('span', { className: 'dxw-dot' }), h('span', null, '尚未绑定微信')),
        h('h3', null, '扫一次码，就能在微信里使用 Harness'),
        h('p', null, '二维码由腾讯微信 iLink 服务签发。用手机微信扫描并确认后，账号凭据会直接写入 Harness Host，浏览器不会收到 bot_token。'),
        h('div', { className: 'dxw-actions' },
          h(Button, { kind: 'primary', onClick: onStart, disabled: busy },
            busy ? '正在生成二维码…' : '生成微信二维码')),
      ),
      h('div', { className: 'dxw-logo', 'aria-hidden': 'true' }, h(WeixinIcon, { size: 64 })),
    ));
}

function QrPanel({ provision, now, busy, onRefresh, onCancel }) {
  const [imageFailed, setImageFailed] = React.useState(false);
  const source = safeQrSource(provision.qrCodeDataUrl);
  const href = safeVerificationUrl(provision.verificationUrl);
  const remaining = Math.max(0, provision.expiresAt - now);
  const expired = remaining === 0 || provision.status === 'expired';
  const duration = Math.max(1, provision.durationMs ?? 5 * 60_000);
  const progress = Math.round(Math.min(1, remaining / duration) * 100);
  React.useEffect(() => setImageFailed(false), [source]);

  return h('div', { className: 'dxw-card' },
    h('div', { className: 'dxw-cardBody dxw-qrLayout' },
      h('div', { className: 'dxw-qrColumn' },
        h('div', { className: 'dxw-qrFrame' },
          source && !imageFailed
            ? h('img', {
                src: source,
                alt: '用于把微信机器人绑定到 DeepSeek Harness 的一次性二维码',
                onError: () => setImageFailed(true),
              })
            : h('div', { className: 'dxw-qrFallback' }, '二维码图片未就绪，请使用备用链接。'),
          expired ? h('div', { className: 'dxw-expired' }, '二维码已过期\n请重新生成') : null,
        ),
        h('div', { className: 'dxw-countdown' },
          h('div', null, h('span', null, '二维码有效时间'), h('strong', null, formatRemaining(remaining))),
          h('div', { className: 'dxw-progress', 'aria-hidden': 'true' },
            h('span', { style: { '--dxw-progress': `${progress}%` } })),
        )),
      h('div', { className: 'dxw-qrCopy' },
        h('div', { className: 'dxw-stateLabel' },
          h('span', { className: 'dxw-dot', 'data-tone': provision.status === 'scanned' ? 'success' : 'warning' }),
          h('span', null, provision.status === 'scanned' ? '已扫码，请在手机上确认' : '等待微信扫码')),
        h('h3', null, expired ? '二维码已失效' : '使用手机微信扫描二维码'),
        h('p', null, '请在手机上核对并确认授权。部分账号会额外显示一个配对数字，页面会在需要时提示输入。'),
        h('ol', { className: 'dxw-steps' },
          h('li', null, '打开手机微信并扫描左侧二维码'),
          h('li', null, '在微信中确认连接该机器人'),
          h('li', null, '保持本页打开，等待消息长轮询变为在线')),
        h('div', { className: 'dxw-actions' },
          expired
            ? h(Button, { kind: 'primary', onClick: onRefresh, disabled: busy }, '重新生成二维码')
            : null,
          href ? h('a', {
            className: 'dxw-button', href, target: '_blank', rel: 'noopener noreferrer',
          }, '打开备用链接') : null,
          !expired ? h(Button, { onClick: onRefresh, disabled: busy }, '换一个二维码') : null,
          h(Button, { onClick: onCancel, disabled: busy }, '取消')),
      ),
    ));
}

function VerificationPanel({ provision, busy, onSubmit, onCancel }) {
  const [code, setCode] = React.useState('');
  const valid = /^\d{4,8}$/.test(code);
  React.useEffect(() => setCode(''), [provision.attemptId]);
  return h('div', { className: 'dxw-card' },
    h('form', {
      className: 'dxw-verify',
      onSubmit: (event) => {
        event.preventDefault();
        if (valid && !busy) onSubmit(code);
      },
    },
    h('div', { className: 'dxw-stateLabel' },
      h('span', { className: 'dxw-dot', 'data-tone': 'warning' }), h('span', null, '需要配对码')),
    h('h3', null, '输入手机微信显示的数字'),
    h('p', null, '这是微信附加的安全确认步骤。配对码只用于本次扫码轮询，不会写入配置或日志。'),
    h('div', { className: 'dxw-codeRow' },
      h('input', {
        className: 'dxw-input',
        value: code,
        inputMode: 'numeric',
        autoComplete: 'one-time-code',
        maxLength: 8,
        'aria-label': '微信配对码',
        onChange: (event) => setCode(event.target.value.replace(/\D/g, '').slice(0, 8)),
        autoFocus: true,
      }),
      h('button', {
        type: 'submit',
        className: 'dxw-button',
        'data-kind': 'primary',
        disabled: !valid || busy,
      }, busy ? '正在验证…' : '继续连接')),
    h(Button, { onClick: onCancel, disabled: busy }, '取消绑定')));
}

function ProgressPanel({ scanned, onCancel, busy }) {
  return h('div', { className: 'dxw-card dxw-loading', 'aria-busy': 'true' },
    h('div', { className: 'dxw-spinner' }),
    h('h3', null, scanned ? '微信已确认，正在启动消息连接' : '正在准备微信二维码'),
    h('p', null, scanned ? '正在保存凭据并验证 Harness 与微信长轮询。' : '正在联系腾讯微信 iLink 服务。'),
    onCancel ? h('div', { className: 'dxw-actions', style: { justifyContent: 'center', marginTop: 14 } },
      h(Button, { onClick: onCancel, disabled: busy }, '取消')) : null);
}

function ProvisionError({ provision, busy, onRetry, onClose }) {
  const error = provision.error ?? { code: 'WEIXIN_PROVISION_FAILED', message: '微信绑定没有完成' };
  return h('div', { className: 'dxw-card' },
    h('div', { className: 'dxw-error', role: 'alert' },
      h('h3', null, provision.status === 'expired' ? '二维码已过期' : '微信没有绑定完成'),
      h('p', null, error.message),
      h('span', { className: 'dxw-errorCode' }, error.code),
      h('div', { className: 'dxw-actions' },
        h(Button, { kind: 'primary', onClick: onRetry, disabled: busy }, '重新生成二维码'),
        h(Button, { onClick: onClose, disabled: busy }, '关闭'))));
}

function checkedTime(timestamp) {
  if (!timestamp) return '尚未检查';
  try {
    return new Intl.DateTimeFormat('zh-CN', {
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    }).format(new Date(timestamp));
  } catch {
    return '刚刚';
  }
}

function AccountCard({ account, busy, removing, onReconnect, onRequestRemove, onConfirmRemove, onCancelRemove }) {
  const state = busy === 'reconnect' ? 'connecting' : account.state;
  const tone = account.connected ? 'success' : state === 'error' ? 'error' : 'warning';
  return h('article', { className: 'dxw-card', tabIndex: -1, 'data-bot-id': account.botId },
    h('div', { className: 'dxw-cardBody' },
      h('div', { className: 'dxw-accountTop' },
        h('div', { className: 'dxw-accountIdentity' },
          h('div', { className: 'dxw-avatar', 'aria-hidden': 'true' }, h(WeixinIcon, { size: 27 })),
          h('div', null, h('h3', null, account.bot.name), h('p', null, account.bot.accountIdMasked))),
        h('div', { className: 'dxw-health' },
          h('span', { className: 'dxw-dot', 'data-tone': tone }),
          h('span', null, account.connected ? '运行正常' : state === 'connecting' ? '正在连接' : '连接未就绪'))),
      h('dl', { className: 'dxw-metrics' },
        h('div', { className: 'dxw-metric' }, h('dt', null, '消息通道'),
          h('dd', null, account.connected ? 'iLink 长轮询' : '离线')),
        h('div', { className: 'dxw-metric' }, h('dt', null, '收到 / 回复'),
          h('dd', null, `${account.stats.messagesReceived} / ${account.stats.messagesReplied}`)),
        h('div', { className: 'dxw-metric' }, h('dt', null, '最近检查'),
          h('dd', null, checkedTime(account.health.lastCheckedAt)))),
      h('div', { className: 'dxw-accountFooter' },
        h('div', { className: 'dxw-summary' }, account.error?.message ?? account.health.summary),
        h('div', { className: 'dxw-actions' },
          h(Button, { onClick: onReconnect, disabled: Boolean(busy) },
            busy === 'reconnect' ? '检查中…' : account.connected ? '检查连接' : '重试连接'),
          h(Button, { kind: 'danger', onClick: onRequestRemove, disabled: Boolean(busy) }, '移除接入')))),
    removing ? h('div', { className: 'dxw-confirm', role: 'alertdialog' },
      h('strong', null, '从此 Harness 移除这个微信账号？'),
      h('p', null, '这会停止消息连接，并删除本机保存的 bot_token、账号配置和会话映射。其他微信账号不受影响。'),
      h('div', { className: 'dxw-actions' },
        h(Button, { onClick: onCancelRemove, disabled: busy === 'delete' }, '保留账号'),
        h(Button, { kind: 'danger', onClick: onConfirmRemove, disabled: busy === 'delete' },
          busy === 'delete' ? '正在移除…' : '确认移除')))
      : null);
}

function AccountList(props) {
  return h('section', null,
    h('div', { className: 'dxw-listHeading' }, h('h3', null, '已接入的微信账号'), h('span', null, `${props.bots.length} 个`)),
    h('ul', { className: 'dxw-list' }, props.bots.map((account) => h('li', { key: account.botId },
      h(AccountCard, {
        account,
        busy: props.busyByBot[account.botId],
        removing: props.removeTarget === account.botId,
        onReconnect: () => props.onReconnect(account),
        onRequestRemove: () => props.onRequestRemove(account),
        onConfirmRemove: () => props.onConfirmRemove(account),
        onCancelRemove: props.onCancelRemove,
      })))));
}

const EMPTY_TOTALS = Object.freeze({ configured: 0, connected: 0 });

export function WeixinSettingsTab({ rpcCall }) {
  const [model, setModel] = React.useState({
    phase: 'loading', bots: [], totals: EMPTY_TOTALS, revision: 0, error: null,
  });
  const [provision, setProvision] = React.useState(null);
  const [busy, setBusy] = React.useState(false);
  const [busyByBot, setBusyByBot] = React.useState({});
  const [removeTarget, setRemoveTarget] = React.useState(null);
  const [notice, setNotice] = React.useState('');
  const [now, setNow] = React.useState(() => Date.now());
  const addButtonRef = React.useRef(null);

  const announce = React.useCallback((value) => {
    setNotice('');
    if (value) window.requestAnimationFrame(() => setNotice(value));
  }, []);
  const invoke = React.useCallback(async (endpoint, payload = {}, signal) => {
    return unwrapRpcResult(await rpcCall(endpoint, payload, signal));
  }, [rpcCall]);
  const loadStatus = React.useCallback(async ({ signal, silent = false } = {}) => {
    if (!silent) setModel((current) => ({ ...current, phase: 'loading', error: null }));
    try {
      const snapshot = normalizeSnapshot(await invoke(WEIXIN_ENDPOINTS.status, {}, signal));
      setModel({
        phase: 'ready', bots: snapshot.bots, totals: snapshot.totals,
        revision: snapshot.revision, error: null,
      });
      if (snapshot.provisioning) {
        setProvision((current) => !current || current.attemptId === snapshot.provisioning.attemptId
          ? { ...current, ...snapshot.provisioning, durationMs: current?.durationMs ?? 5 * 60_000 }
          : current);
      }
      return snapshot;
    } catch (error) {
      if (error?.name === 'AbortError') return undefined;
      setModel((current) => ({
        ...current,
        phase: silent && current.phase === 'ready' ? 'ready' : 'error',
        error: presentError(error),
      }));
      return undefined;
    }
  }, [invoke]);

  React.useEffect(() => {
    const controller = new AbortController();
    void loadStatus({ signal: controller.signal });
    return () => controller.abort();
  }, [loadStatus]);

  React.useEffect(() => {
    if (model.phase !== 'ready') return undefined;
    const controller = new AbortController();
    let running = false;
    const timer = window.setInterval(async () => {
      if (running) return;
      running = true;
      await loadStatus({ signal: controller.signal, silent: true });
      running = false;
    }, 15_000);
    return () => {
      controller.abort();
      window.clearInterval(timer);
    };
  }, [loadStatus, model.phase]);

  React.useEffect(() => {
    if (!provision || !['pending', 'scanned'].includes(provision.status)) return undefined;
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [provision?.attemptId, provision?.status]);

  const startProvisioning = React.useCallback(async ({ replace = false } = {}) => {
    setBusy(true);
    try {
      if (replace && provision?.attemptId) {
        await invoke(WEIXIN_ENDPOINTS.cancelProvisioning, { attemptId: provision.attemptId });
      }
      setProvision({ status: 'starting' });
      const started = normalizeProvisioning(await invoke(WEIXIN_ENDPOINTS.beginProvisioning, { locale: 'zh-CN' }));
      setNow(Date.now());
      setProvision({ ...started, durationMs: Math.max(1, started.expiresAt - Date.now()) });
      announce('微信二维码已生成，请使用手机微信扫描。');
    } catch (error) {
      setProvision({
        status: 'failed',
        error: presentError(error),
        ...(provision?.attemptId ? { attemptId: provision.attemptId } : {}),
      });
    } finally {
      setBusy(false);
    }
  }, [announce, invoke, provision?.attemptId]);

  const cancelProvisioning = React.useCallback(async () => {
    setBusy(true);
    try {
      if (provision?.attemptId && !['failed', 'expired', 'cancelled'].includes(provision.status)) {
        await invoke(WEIXIN_ENDPOINTS.cancelProvisioning, { attemptId: provision.attemptId });
      }
      setProvision(null);
      announce('已取消微信绑定。');
      window.requestAnimationFrame(() => addButtonRef.current?.focus());
    } catch (error) {
      setProvision((current) => ({ ...current, status: 'failed', error: presentError(error) }));
    } finally {
      setBusy(false);
    }
  }, [announce, invoke, provision?.attemptId, provision?.status]);

  const submitVerification = React.useCallback(async (verifyCode) => {
    if (!provision?.attemptId) return;
    setBusy(true);
    try {
      const next = normalizeProvisioning(await invoke(WEIXIN_ENDPOINTS.submitVerification, {
        attemptId: provision.attemptId,
        verifyCode,
      }));
      setProvision((current) => ({ ...current, ...next }));
      announce('配对码已提交，正在等待微信确认。');
    } catch (error) {
      setProvision((current) => ({ ...current, status: 'failed', error: presentError(error) }));
    } finally {
      setBusy(false);
    }
  }, [announce, invoke, provision?.attemptId]);

  React.useEffect(() => {
    const attemptId = provision?.attemptId;
    if (!attemptId || !['pending', 'scanned', 'connecting'].includes(provision.status)) return undefined;
    const controller = new AbortController();
    let timer;
    const poll = async () => {
      try {
        const result = normalizeProvisioning(await invoke(
          WEIXIN_ENDPOINTS.pollProvisioning,
          { attemptId },
          controller.signal,
        ));
        if (result.status === 'connected') {
          const snapshot = await loadStatus({ signal: controller.signal, silent: true });
          const account = snapshot?.bots.find((bot) => bot.botId === result.botId);
          if (!account?.connected) {
            setProvision((current) => current?.attemptId === attemptId
              ? { ...current, ...result, status: 'connecting' }
              : current);
            timer = window.setTimeout(poll, result.pollIntervalMs);
            return;
          }
          setProvision(null);
          announce(result.alreadyConnected
            ? '这个微信账号已经绑定并保持在线。'
            : '微信已绑定，可以开始向已绑定的机器人发消息。');
          return;
        }
        setProvision((current) => current?.attemptId === attemptId
          ? { ...current, ...result, durationMs: current.durationMs }
          : current);
        if (['pending', 'scanned', 'connecting'].includes(result.status)) {
          timer = window.setTimeout(poll, result.pollIntervalMs);
        }
      } catch (error) {
        if (error?.name === 'AbortError') return;
        setProvision((current) => current?.attemptId === attemptId
          ? { ...current, status: 'failed', error: presentError(error) }
          : current);
      }
    };
    timer = window.setTimeout(poll, provision.pollIntervalMs ?? 1_000);
    return () => {
      controller.abort();
      window.clearTimeout(timer);
    };
  }, [announce, invoke, loadStatus, provision?.attemptId, provision?.status, provision?.pollIntervalMs]);

  const setBotBusy = React.useCallback((botId, value) => {
    setBusyByBot((current) => {
      const next = { ...current };
      if (value) next[botId] = value;
      else delete next[botId];
      return next;
    });
  }, []);

  const reconnect = React.useCallback(async (account) => {
    setBotBusy(account.botId, 'reconnect');
    try {
      const snapshot = normalizeSnapshot(await invoke(WEIXIN_ENDPOINTS.reconnectBot, { botId: account.botId }));
      setModel((current) => ({ ...current, bots: snapshot.bots, totals: snapshot.totals, revision: snapshot.revision }));
      const refreshed = snapshot.bots.find((bot) => bot.botId === account.botId);
      announce(refreshed?.connected ? '微信连接检查完成。' : '微信仍未连接，插件会继续自动重试。');
    } catch (error) {
      announce(`连接检查失败：${presentError(error).message}`);
    } finally {
      setBotBusy(account.botId, null);
    }
  }, [announce, invoke, setBotBusy]);

  const remove = React.useCallback(async (account) => {
    setBotBusy(account.botId, 'delete');
    try {
      const snapshot = normalizeSnapshot(await invoke(WEIXIN_ENDPOINTS.deleteBot, {
        botId: account.botId,
        confirm: true,
      }));
      setModel((current) => ({ ...current, bots: snapshot.bots, totals: snapshot.totals, revision: snapshot.revision }));
      setRemoveTarget(null);
      announce('微信账号及本机凭据已移除。');
    } catch (error) {
      announce(`移除失败：${presentError(error).message}`);
    } finally {
      setBotBusy(account.botId, null);
    }
  }, [announce, invoke, setBotBusy]);

  let provisionView = null;
  if (provision?.status === 'starting') {
    provisionView = h(ProgressPanel, { busy });
  } else if (['pending', 'scanned'].includes(provision?.status)) {
    provisionView = h(QrPanel, {
      provision, now, busy,
      onRefresh: () => void startProvisioning({ replace: true }),
      onCancel: () => void cancelProvisioning(),
    });
  } else if (provision?.status === 'needs_verification') {
    provisionView = h(VerificationPanel, {
      provision, busy,
      onSubmit: (code) => void submitVerification(code),
      onCancel: () => void cancelProvisioning(),
    });
  } else if (provision?.status === 'connecting') {
    provisionView = h(ProgressPanel, {
      scanned: true, busy, onCancel: () => void cancelProvisioning(),
    });
  } else if (provision && ['failed', 'expired', 'cancelled'].includes(provision.status)) {
    provisionView = h(ProvisionError, {
      provision, busy,
      onRetry: () => void startProvisioning({ replace: Boolean(provision.attemptId) }),
      onClose: () => void cancelProvisioning(),
    });
  }

  return h('section', { className: 'dxw-page', 'aria-label': '微信设置' },
    h(Heading, {
      totals: model.totals,
      adding: Boolean(provision),
      busy,
      onAdd: () => void startProvisioning(),
      addButtonRef,
    }),
    h('div', { className: 'dxw-visuallyHidden', role: 'status', 'aria-live': 'polite' }, notice),
    model.error && model.phase === 'ready'
      ? h('div', { className: 'dxw-statusNotice' }, `状态刷新失败：${model.error.message}`)
      : null,
    model.phase === 'loading'
      ? h(LoadingView)
      : model.phase === 'error'
        ? h('div', { className: 'dxw-card' },
            h('div', { className: 'dxw-error' },
              h('h3', null, '无法读取微信状态'),
              h('p', null, model.error?.message ?? '请稍后重试'),
              h(Button, { onClick: () => void loadStatus() }, '重新读取')))
        : h(React.Fragment, null,
            provisionView,
            model.bots.length === 0 && !provision
              ? h(EmptyView, { onStart: () => void startProvisioning(), busy })
              : null,
            model.bots.length > 0
              ? h(AccountList, {
                  bots: model.bots,
                  busyByBot,
                  removeTarget,
                  onReconnect: (account) => void reconnect(account),
                  onRequestRemove: (account) => setRemoveTarget(account.botId),
                  onConfirmRemove: (account) => void remove(account),
                  onCancelRemove: () => setRemoveTarget(null),
                })
              : null),
  );
}

export function apply(ctx) {
  ctx.effect(() => installWeixinStyles(), 'weixin-settings: install client styles');
  const rpcCall = (endpoint, payload, signal) =>
    ctx.connection.rpc.call(WEIXIN_RPC_CHANNEL, endpoint, payload, signal);
  ctx.slots.inject('settings.plugins.tab', () => ctx.slots.register({
    name: 'settings.plugins.tab',
    id: 'weixin',
    order: 30,
    label: '微信',
    inject: () => ({ rpcCall }),
  }, WeixinSettingsTab));
}
