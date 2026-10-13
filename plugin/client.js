/**
 * agent-clinic 客户端模块（DSH Web 客户端「浏览器半」）
 *
 * 契约来源：逆向 @shengsheng/dsh-taskboard 的 lib/client.js 产物确认。
 *
 *   window.__ModuleLoader__.load({
 *     id: '<包名>',                       // 必须等于 package.json 的 name
 *     factory: (require) => module.exports
 *   })
 *
 * 要点：
 *   - 纯 JavaScript：无 JSX、无 TypeScript、不需要构建步骤
 *   - React 由宿主的浏览器模块表提供，用 require('react') 取，切勿自带一份
 *   - 模块导出 inject（依赖的客户端服务名）与 apply(ctx)
 *   - 通过 ctx.get('slots') 拿插槽服务，再 slots.register 挂 UI
 *
 * 本文件挂两个位置：
 *   - sidebar.footer.action —— 侧边栏底部按钮（点击开合面板）
 *   - shell.overlay         —— 覆盖层面板（展示体检报告）
 */

window.__ModuleLoader__.load({
  id: 'agent-clinic',
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });

    var React = require('react');
    var h = React.createElement;

    /** 客户端依赖的宿主服务 */
    const inject = ['slots'];

    /** 收集挂载失败信息，便于在宿主 console 中排查 */
    const errors = [];

    const REPORT_API = '/api/agent-clinic/report';

    // -----------------------------------------------------------------------
    // 极简共享状态：按钮与面板需要同一个「开合」状态
    // -----------------------------------------------------------------------
    let open = false;
    const listeners = new Set();

    function setOpen(next) {
      if (open === next) return;
      open = next;
      listeners.forEach((l) => {
        try {
          l();
        } catch {
          /* 单个订阅者出错不影响其他 */
        }
      });
    }
    function subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    }
    function getSnapshot() {
      return open;
    }
    function useOpen() {
      return React.useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
    }

    // -----------------------------------------------------------------------
    // 样式（内联，避免依赖宿主 styles 对象）
    // -----------------------------------------------------------------------
    const S = {
      navBtn: {
        display: 'flex',
        alignItems: 'center',
        gap: '8px',
        width: '100%',
        padding: '6px 10px',
        background: 'transparent',
        border: 'none',
        borderRadius: '6px',
        color: 'inherit',
        font: 'inherit',
        fontSize: '13px',
        cursor: 'pointer',
        textAlign: 'left',
      },
      overlay: {
        position: 'absolute',
        inset: '0',
        zIndex: 40,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: 'rgba(0,0,0,0.35)',
      },
      panel: {
        width: 'min(860px, 92vw)',
        maxHeight: '86vh',
        display: 'flex',
        flexDirection: 'column',
        background: 'var(--color-background-primary, #fff)',
        color: 'var(--color-text-primary, #111)',
        border: '0.5px solid var(--color-border-tertiary, rgba(0,0,0,0.15))',
        borderRadius: '12px',
        overflow: 'hidden',
      },
      header: {
        display: 'flex',
        alignItems: 'center',
        gap: '10px',
        padding: '12px 16px',
        borderBottom: '0.5px solid var(--color-border-tertiary, rgba(0,0,0,0.15))',
      },
      title: { fontSize: '14px', fontWeight: 500, flex: '1 1 auto' },
      sub: { fontSize: '12px', opacity: 0.6 },
      close: {
        border: 'none',
        background: 'transparent',
        color: 'inherit',
        fontSize: '18px',
        lineHeight: '1',
        cursor: 'pointer',
        padding: '2px 8px',
        borderRadius: '6px',
      },
      body: {
        padding: '12px 16px',
        overflow: 'auto',
        flex: '1 1 auto',
      },
      pre: {
        margin: 0,
        fontFamily: 'var(--font-mono, ui-monospace, SFMono-Regular, Menlo, monospace)',
        fontSize: '12px',
        lineHeight: '1.6',
        whiteSpace: 'pre-wrap',
        wordBreak: 'break-word',
      },
      hint: { fontSize: '12px', opacity: 0.7, lineHeight: '1.7' },
      code: {
        fontFamily: 'var(--font-mono, ui-monospace, monospace)',
        fontSize: '12px',
        background: 'var(--color-background-secondary, rgba(0,0,0,0.05))',
        padding: '1px 5px',
        borderRadius: '4px',
      },
      refresh: {
        border: '0.5px solid var(--color-border-secondary, rgba(0,0,0,0.3))',
        background: 'transparent',
        color: 'inherit',
        font: 'inherit',
        fontSize: '12px',
        padding: '3px 10px',
        borderRadius: '6px',
        cursor: 'pointer',
      },
    };

    // -----------------------------------------------------------------------
    // 侧边栏按钮
    // -----------------------------------------------------------------------
    function ClinicNavButton() {
      const isOpen = useOpen();
      return h(
        'button',
        {
          type: 'button',
          style: S.navBtn,
          title: 'Agent 体检诊所 —— 用可复核证据诊断 Agent 使用体验',
          onClick: () => setOpen(!isOpen),
        },
        h('span', { 'aria-hidden': 'true' }, '🩺'),
        h('span', null, '体检'),
      );
    }

    // -----------------------------------------------------------------------
    // 覆盖层面板
    // -----------------------------------------------------------------------
    function ClinicPanel() {
      const isOpen = useOpen();
      const [state, setState] = React.useState({ status: 'idle', report: '', error: '' });
      const [nonce, setNonce] = React.useState(0);

      React.useEffect(() => {
        if (!isOpen) return undefined;
        let cancelled = false;
        setState((s) => ({ ...s, status: 'loading' }));

        const req =
          typeof fetch === 'function'
            ? fetch(REPORT_API, { headers: { accept: 'application/json' } })
            : Promise.reject(new Error('当前环境不提供 fetch，无法从宿主取数'));

        req
          .then((r) => r.json())
          .then((data) => {
            if (cancelled) return;
            if (data && data.ok) setState({ status: 'ok', report: data.report || '', error: '' });
            else setState({ status: 'error', report: '', error: (data && data.error) || '未知错误' });
          })
          .catch((e) => {
            if (cancelled) return;
            setState({ status: 'error', report: '', error: String((e && e.message) || e) });
          });

        return () => {
          cancelled = true;
        };
      }, [isOpen, nonce]);

      if (!isOpen) return null;

      const close = () => setOpen(false);

      const body =
        state.status === 'loading'
          ? h('div', { style: S.hint }, '正在读取本地会话并生成体检报告…')
          : state.status === 'error'
            ? h(
                'div',
                { style: S.hint },
                h('div', null, '未能取得报告：', h('code', { style: S.code }, state.error)),
                h(
                  'div',
                  { style: { marginTop: '10px' } },
                  '若提示服务不可用，说明宿主未挂载 webServer 服务；',
                  '此时仍可在会话里直接说「体检一下」，由模型调用工具产出报告。',
                ),
              )
            : h('pre', { style: S.pre }, state.report);

      return h(
        'div',
        {
          style: S.overlay,
          onClick: (e) => {
            if (e.target === e.currentTarget) close();
          },
        },
        h(
          'div',
          { style: S.panel, role: 'dialog', 'aria-label': 'Agent 体检报告' },
          h(
            'div',
            { style: S.header },
            h('span', { style: S.title }, 'Agent 体检报告'),
            h('span', { style: S.sub }, '只读 · 零外发'),
            state.status === 'ok'
              ? h('button', { type: 'button', style: S.refresh, onClick: () => setNonce((n) => n + 1) }, '刷新')
              : null,
            h(
              'button',
              { type: 'button', style: S.close, onClick: close, 'aria-label': '关闭' },
              '×',
            ),
          ),
          h('div', { style: S.body }, body),
        ),
      );
    }

    // -----------------------------------------------------------------------
    // 插件主体
    // -----------------------------------------------------------------------
    async function apply(ctx) {
      const slots = typeof ctx.get === 'function' ? ctx.get('slots') : ctx.slots;
      if (!slots || typeof slots.inject !== 'function' || typeof slots.register !== 'function') {
        throw new Error('agent-clinic: 无法取得 slots 服务');
      }

      // 逐个注册并隔离：未声明的插槽会在注册时抛错，不应拖垮整个插件。
      // 宿主只在启动时装载客户端模块，因此这里失败没有第二次机会，
      // 必须让已成功的部分继续工作。
      const mounts = [
        ['sidebar.footer.action', 'agent-clinic.nav', ClinicNavButton, '侧边栏入口'],
        ['shell.overlay', 'agent-clinic.panel', ClinicPanel, '报告面板'],
      ];
      for (const [slotName, id, Component, label] of mounts) {
        try {
          slots.inject(slotName, () => slots.register({ name: slotName, id }, Component));
        } catch (e) {
          // 无法在这里访问宿主 console 之外的通道，吞掉但保留信息在闭包中
          errors.push(`${label}(${slotName})：${String((e && e.message) || e)}`);
        }
      }
      // eslint-disable-next-line no-console
      if (typeof console !== 'undefined' && errors.length) {
        console.warn('[agent-clinic] 部分 UI 未挂载：', errors.join('; '));
      }
    }

    exports.inject = inject;
    exports.apply = apply;
    exports.ClinicNavButton = ClinicNavButton;
    exports.ClinicPanel = ClinicPanel;
    return module.exports;
  },
});
