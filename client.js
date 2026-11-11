// Agensi sign-in card — the plugin page half.
//
// Shows what the host half knows about the credential (signed in or not, when it expires)
// and drives the OAuth flow from the page instead of a terminal: the button asks the host
// to start an authorization, then opens the Agensi page in a new tab. The browser's
// callback lands on the host's loopback listener, which stores the token; this card sees
// the new state on its next poll.
//
// A client half cannot import modules, so the dictionaries live here and `locale/*.json`
// carries only the plugin title and description. The UI language is the harness preference
// (the `locale` service), never the OS language.

window.__ModuleLoader__.load({
  id: 'dsh-agensi-mcp',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    const NS = 'dsh-agensi-mcp';
    const ROUTE = '/api/dsh-agensi-mcp';
    /** Poll cadence; shorter while an authorization is waiting for the browser. */
    const POLL_IDLE_MS = 15_000;
    const POLL_ACTIVE_MS = 2_000;

    const I18N = {
      en: {
        title: 'Agensi sign-in',
        signedIn: 'Signed in',
        signedOut: 'Not signed in',
        expired: 'Expired',
        checking: 'Checking…',
        expires: 'Expires',
        remaining: 'left',
        scope: 'Scopes',
        noExpiry: 'no expiry reported',
        signIn: 'Sign in to Agensi',
        reauth: 'Sign in again',
        signOut: 'Sign out',
        waiting: 'Waiting for the browser…',
        waitingHint: 'Finish signing in on the Agensi page. If no tab opened, open this link:',
        cancel: 'Cancel',
        openLink: 'Open the Agensi page',
        signedOutHint: 'Signing in opens the Agensi page once; the token stays on this machine.',
        signedInHint: 'Tools are available to the agent as mcp__agensi__*.',
        expiredHint: 'The token expired. A refresh is attempted automatically; signing in again always works.',
        signingIn: 'Starting sign-in…',
        signingOut: 'Signing out…',
        loginFailed: 'Could not start sign-in.',
        logoutFailed: 'Could not sign out.',
        statusFailed: 'The plugin host did not answer.',
        noHost: 'No host bridge in this window.',
        popupBlocked: 'The browser blocked the tab — use the link below.',
        refreshed: 'renewed',
      },
      zh: {
        title: 'Agensi 登录',
        signedIn: '已登录',
        signedOut: '未登录',
        expired: '已过期',
        checking: '检查中…',
        expires: '过期时间',
        remaining: '后到期',
        scope: '授权范围',
        noExpiry: '未返回过期时间',
        signIn: '登录 Agensi',
        reauth: '重新登录',
        signOut: '退出登录',
        waiting: '等待浏览器授权…',
        waitingHint: '请在 Agensi 页面完成登录。如果浏览器没打开新标签，请点这个链接：',
        cancel: '取消',
        openLink: '打开 Agensi 登录页',
        signedOutHint: '登录只会打开一次 Agensi 页面，令牌保存在本机。',
        signedInHint: 'Agent 现在可以使用 mcp__agensi__* 工具。',
        expiredHint: '令牌已过期。插件会自动续期；重新登录一定可以恢复。',
        signingIn: '正在发起登录…',
        signingOut: '正在退出…',
        loginFailed: '无法发起登录。',
        logoutFailed: '退出登录失败。',
        statusFailed: '插件宿主没有响应。',
        noHost: '当前窗口没有宿主通道。',
        popupBlocked: '浏览器拦截了新标签，请用下面的链接。',
        refreshed: '已续期',
      },
    };

    /**
     * The harness locale service is the only correct source of the UI language;
     * `document.documentElement.lang` is what the harness writes on every switch, and the
     * browser language is the last fallback.
     *
     * @param {object|undefined} service - `ctx.locale`.
     * @returns {'zh'|'en'} language key.
     */
    const pickLocale = (service) => {
      try {
        const active =
          service && typeof service.getSnapshot === 'function' ? service.getSnapshot().active : null;
        if (typeof active === 'string') {
          const value = active.toLowerCase();
          if (value.startsWith('zh')) return 'zh';
          if (value.startsWith('en')) return 'en';
        }
      } catch {
        /* fall through */
      }
      try {
        const lang = String(document.documentElement.lang || '').toLowerCase();
        if (lang.startsWith('zh')) return 'zh';
        if (lang.startsWith('en')) return 'en';
      } catch {
        /* no document */
      }
      try {
        return String(navigator.language || '').toLowerCase().startsWith('zh') ? 'zh' : 'en';
      } catch {
        return 'en';
      }
    };

    const localeListeners = new Set();
    const notifyLocale = () => {
      for (const listener of Array.from(localeListeners)) {
        try {
          listener();
        } catch {
          /* one broken card must not stop the others */
        }
      }
    };

    const BORDER = '1px solid var(--dsw-alias-border-l1)';
    const s = {
      card: {
        display: 'flex',
        flexDirection: 'column',
        gap: 10,
        padding: '12px 14px',
        border: BORDER,
        borderRadius: 10,
        fontSize: 13,
        color: 'inherit',
      },
      head: { display: 'flex', alignItems: 'center', gap: 8 },
      headTitle: { fontSize: 12, fontWeight: 600, opacity: 0.9 },
      status: {
        marginLeft: 'auto',
        display: 'inline-flex',
        alignItems: 'center',
        gap: 5,
        fontSize: 12,
        opacity: 0.75,
      },
      dot: (state) => ({
        width: 6,
        height: 6,
        borderRadius: '50%',
        background:
          state === 'signedIn'
            ? 'var(--dsw-alias-state-business-primary)'
            : state === 'expired'
              ? '#d14343'
              : 'var(--dsw-alias-border-l1)',
      }),
      rows: { display: 'flex', flexDirection: 'column', gap: 4 },
      row: { display: 'flex', gap: 8, fontSize: 12, alignItems: 'baseline' },
      label: { opacity: 0.55, minWidth: 68 },
      value: { wordBreak: 'break-all' },
      mono: { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace' },
      actions: { display: 'flex', alignItems: 'center', gap: 10, minHeight: 18 },
      btn: (primary) => ({
        height: 32,
        boxSizing: 'border-box',
        padding: '0 14px',
        fontSize: 12,
        fontWeight: primary ? 600 : 400,
        borderRadius: 6,
        cursor: primary ? 'pointer' : 'default',
        whiteSpace: 'nowrap',
        border: primary ? '1px solid transparent' : BORDER,
        background: primary ? 'var(--dsw-alias-state-business-primary)' : 'transparent',
        color: primary ? '#fff' : 'inherit',
      }),
      btnDisabled: { opacity: 0.55, cursor: 'default' },
      link: {
        padding: 0,
        fontSize: 12,
        border: 'none',
        background: 'transparent',
        color: 'inherit',
        opacity: 0.65,
        cursor: 'pointer',
        textDecoration: 'underline',
        textUnderlineOffset: 2,
        whiteSpace: 'nowrap',
      },
      hint: { fontSize: 11, opacity: 0.5, lineHeight: 1.4 },
      ok: { fontSize: 12, color: 'var(--dsw-alias-state-business-primary)' },
      err: { fontSize: 12, color: '#d14343', lineHeight: 1.4 },
    };

    /**
     * Read the host's view of the credential.
     *
     * @returns {Promise<object>} status payload, or `{ unavailable: true }`.
     */
    const readStatus = async () => {
      try {
        const response = await fetch(ROUTE + '/status', {
          headers: { accept: 'application/json' },
          cache: 'no-store',
        });
        if (!response.ok) return { unavailable: true, error: 'HTTP ' + response.status };
        return await response.json();
      } catch (error) {
        return { unavailable: true, error: String(error && error.message ? error.message : error) };
      }
    };

    /**
     * POST one of the host's state-changing routes.
     *
     * @param {string} name - `login`, `cancel` or `logout`.
     * @returns {Promise<object>} parsed answer, or `{ error }`.
     */
    const post = async (name) => {
      try {
        const response = await fetch(ROUTE + '/' + name, {
          method: 'POST',
          headers: { accept: 'application/json' },
        });
        const body = await response.json().catch(() => ({}));
        if (!response.ok) return { error: body.error || 'HTTP ' + response.status, ...body };
        return body;
      } catch (error) {
        return { error: String(error && error.message ? error.message : error) };
      }
    };

    /**
     * Human wording for a token state.
     *
     * @param {object} status - host status.
     * @returns {'signedIn'|'expired'|'signedOut'} key.
     */
    const stateKey = (status) => {
      if (!status || status.unavailable) return 'signedOut';
      if (status.signedIn) return 'signedIn';
      if (status.expiresAt) return 'expired';
      return 'signedOut';
    };

    /**
     * Absolute local time plus a coarse countdown, in the UI language.
     *
     * @param {number} timestamp - milliseconds since epoch.
     * @param {(key: string) => string} t - translator.
     * @returns {string} e.g. `15:42 · 42 min`.
     */
    const formatExpiry = (timestamp, t, lang) => {
      const date = new Date(timestamp);
      const time = (() => {
        try {
          return new Intl.DateTimeFormat(lang === 'zh' ? 'zh-CN' : 'en-GB', {
            hour: '2-digit',
            minute: '2-digit',
          }).format(date);
        } catch {
          return date.toLocaleTimeString();
        }
      })();
      const minutes = Math.round((timestamp - Date.now()) / 60_000);
      if (minutes <= 0) return time;
      const left =
        minutes < 60
          ? lang === 'zh'
            ? minutes + ' 分钟'
            : minutes + ' min'
          : lang === 'zh'
            ? Math.floor(minutes / 60) + ' 小时 ' + (minutes % 60) + ' 分钟'
            : Math.floor(minutes / 60) + ' h ' + (minutes % 60) + ' min';
      return time + ' · ' + left + ' ' + t('remaining');
    };

    /**
     * The card: status, expiry, and the three actions the host exposes.
     *
     * @param {{t: (key: string) => string, lang: () => 'zh'|'en'}} props - translator.
     * @returns {object} React element.
     */
    function AgensiCard(props) {
      const t = props.t;
      const [status, setStatus] = React.useState(null);
      const [busy, setBusy] = React.useState(null);
      const [message, setMessage] = React.useState(null);
      const aliveRef = React.useRef(true);
      const [, bumpLocale] = React.useReducer((n) => n + 1, 0);

      React.useEffect(() => {
        aliveRef.current = true;
        localeListeners.add(bumpLocale);
        return () => {
          aliveRef.current = false;
          localeListeners.delete(bumpLocale);
        };
      }, []);

      const refresh = React.useCallback(async () => {
        const next = await readStatus();
        if (aliveRef.current) setStatus(next);
        return next;
      }, []);

      React.useEffect(() => {
        void refresh();
      }, [refresh]);

      // Poll: slowly when idle, quickly while the browser is expected to come back.
      const waitingForBrowser = Boolean(status && status.login && status.login.active);
      React.useEffect(() => {
        const period = waitingForBrowser ? POLL_ACTIVE_MS : POLL_IDLE_MS;
        const timer = setInterval(() => {
          void refresh();
        }, period);
        return () => clearInterval(timer);
      }, [refresh, waitingForBrowser]);

      const startLogin = async () => {
        setBusy('login');
        setMessage(null);
        const answer = await post('login');
        if (answer && answer.authorizeUrl) {
          setStatus(answer);
          try {
            const opened = window.open(answer.authorizeUrl, '_blank', 'noopener,noreferrer');
            if (!opened) setMessage({ kind: 'warn', text: t('popupBlocked') });
          } catch {
            setMessage({ kind: 'warn', text: t('popupBlocked') });
          }
        } else {
          setMessage({ kind: 'err', text: (answer && answer.error) || t('loginFailed') });
          await refresh();
        }
        if (aliveRef.current) setBusy(null);
      };

      const cancelLogin = async () => {
        setBusy('cancel');
        await post('cancel');
        await refresh();
        if (aliveRef.current) setBusy(null);
      };

      const signOut = async () => {
        setBusy('logout');
        setMessage(null);
        const answer = await post('logout');
        if (answer && answer.error) setMessage({ kind: 'err', text: answer.error });
        await refresh();
        if (aliveRef.current) setBusy(null);
      };

      const lang = typeof props.lang === 'function' ? props.lang() : 'en';
      const key = stateKey(status);
      const loginActive = Boolean(status && status.login && status.login.active);
      const dateText =
        status && status.expiresAt
          ? formatExpiry(status.expiresAt, t, lang)
          : t('noExpiry');
      const authorizeUrl = loginActive && status.login.authorizeUrl ? status.login.authorizeUrl : null;

      const stateLabel = status === null ? t('checking') : t(key);
      const hint =
        key === 'signedIn' ? t('signedInHint') : key === 'expired' ? t('expiredHint') : t('signedOutHint');

      const children = [
        h(
          'div',
          { key: 'head', style: s.head },
          h('span', { style: s.headTitle }, t('title')),
          h(
            'span',
            { style: s.status },
            h('span', { style: s.dot(key) }),
            h('span', null, stateLabel),
          ),
        ),
        h(
          'div',
          { key: 'rows', style: s.rows },
          h(
            'div',
            { style: s.row },
            h('span', { style: s.label }, t('expires')),
            h('span', { style: { ...s.value, ...s.mono } }, status === null ? '—' : dateText),
          ),
          status && status.scope
            ? h(
                'div',
                { style: s.row },
                h('span', { style: s.label }, t('scope')),
                h('span', { style: { ...s.value, ...s.mono } }, status.scope),
              )
            : null,
        ),
      ];

      if (loginActive) {
        children.push(
          h(
            'div',
            { key: 'waiting', style: s.hint },
            h('div', null, t('waiting')),
            authorizeUrl
              ? h(
                  'div',
                  null,
                  t('waitingHint') + ' ',
                  h(
                    'a',
                    { href: authorizeUrl, target: '_blank', rel: 'noreferrer' },
                    t('openLink'),
                  ),
                )
              : null,
          ),
        );
        children.push(
          h(
            'div',
            { key: 'actions', style: s.actions },
            h('button', { type: 'button', style: s.btn(false), onClick: cancelLogin, disabled: busy === 'cancel' }, t('cancel')),
          ),
        );
      } else {
        children.push(
          h(
            'div',
            { key: 'actions', style: s.actions },
            h(
              'button',
              {
                type: 'button',
                style: { ...s.btn(true), ...(busy ? s.btnDisabled : {}) },
                onClick: startLogin,
                disabled: Boolean(busy),
              },
              busy === 'login' ? t('signingIn') : key === 'signedIn' ? t('reauth') : t('signIn'),
            ),
            key === 'signedIn'
              ? h(
                  'button',
                  { type: 'button', style: s.link, onClick: signOut, disabled: busy === 'logout' },
                  busy === 'logout' ? t('signingOut') : t('signOut'),
                )
              : null,
          ),
        );
      }

      children.push(h('div', { key: 'hint', style: s.hint }, hint));
      if (message) {
        children.push(
          h('div', { key: 'msg', style: message.kind === 'err' ? s.err : s.hint }, message.text),
        );
      }
      if (status && status.error) {
        children.push(h('div', { key: 'status-error', style: s.err }, status.error));
      }

      return h('div', { style: s.card, 'data-agensi-card': true }, ...children.filter(Boolean));
    }

    /**
     * Resolve a key through the harness dictionaries first, then the local ones.
     *
     * @param {object|undefined} locale - `ctx.locale`.
     * @returns {(key: string) => string} translator.
     */
    const makeT = (locale) => {
      let bound;
      try {
        if (locale && typeof locale.bind === 'function') bound = locale.bind(NS);
      } catch {
        bound = undefined;
      }
      return (key) => {
        if (typeof bound === 'function') {
          try {
            const text = bound(key);
            if (typeof text === 'string' && text !== '' && text !== key) return text;
          } catch {
            /* fall through to the local dictionary */
          }
        }
        const dict = I18N[pickLocale(locale)] || I18N.en;
        return typeof dict[key] === 'string' ? dict[key] : key;
      };
    };

    return {
      // `locale` and `slots` must be declared: Cordis rejects undeclared service access.
      inject: ['slots', 'locale'],
      apply(ctx) {
        const locale = ctx.locale;
        const t = makeT(locale);
        const lang = () => pickLocale(locale);

        if (locale) {
          ctx.effect(() => {
            try {
              return locale.register(NS, I18N);
            } catch {
              return undefined;
            }
          }, 'agensi-mcp: locale dictionaries');
          if (typeof locale.subscribe === 'function') {
            ctx.effect(() => locale.subscribe(notifyLocale), 'agensi-mcp: locale subscription');
          }
        }

        // The card belongs in the plugin page's config slot; a settings section breaks
        // harness startup, and the plugin page is where a user looks for it anyway.
        ctx.slots.inject('plugins.bundle.config', () =>
          ctx.slots.register({ name: 'plugins.bundle.config', key: NS }, () =>
            h(AgensiCard, { t, lang }),
          ),
        );
      },
    };
  },
});
