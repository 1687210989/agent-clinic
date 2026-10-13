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
 *
 * 数据不是「解析 markdown 文本」，而是宿主返回结构化 JSON，
 * 由这里渲染成卡片式 UI。单一事实来源在 src/report.mjs 的 analyze()。
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

    /**
     * 客户端版本号。宿主在响应里带回同一个值，用于识别
     * 「客户端已更新、宿主还跑着旧代码」这种静默不一致。
     *
     * 这个场景很常见：插件文件更新在磁盘上后，浏览器会立即拿到新
     * client.js，而宿主半是启动时装入进程的，必须重启才生效。
     * 若不显式提示，用户只会看到面板内容没变，无从判断该做什么。
     */
    const CLIENT_VERSION = '2';

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
    // 设计变量（内联，避免依赖宿主 styles 对象）
    // -----------------------------------------------------------------------
    const V = {
      bg: 'var(--color-background-primary, #fff)',
      bg2: 'var(--color-background-secondary, rgba(0,0,0,0.04))',
      text: 'var(--color-text-primary, #1f1f1f)',
      text2: 'var(--color-text-secondary, #666)',
      text3: 'var(--color-text-tertiary, #888)',
      border: 'var(--color-border-tertiary, rgba(0,0,0,0.12))',
      border2: 'var(--color-border-secondary, rgba(0,0,0,0.28))',
      mono: 'var(--font-mono, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace)',
      sans: 'var(--font-sans, system-ui, sans-serif)',
    };

    const SEV = {
      高: { color: '#A32D2D', bg: 'rgba(226,75,74,0.10)', accent: '#E24B4A' },
      中: { color: '#854F0B', bg: 'rgba(239,159,39,0.12)', accent: '#EF9F27' },
      低: { color: '#3B6D11', bg: 'rgba(99,153,34,0.12)', accent: '#639922' },
    };
    const sevOf = (s) => SEV[s] || SEV['低'];

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
        padding: '24px',
        background: 'rgba(0,0,0,0.32)',
      },
      panel: {
        width: 'min(920px, 94vw)',
        maxHeight: '88vh',
        display: 'flex',
        flexDirection: 'column',
        background: V.bg,
        color: V.text,
        border: `0.5px solid ${V.border2}`,
        borderRadius: '12px',
        overflow: 'hidden',
      },
      header: {
        display: 'flex',
        alignItems: 'center',
        gap: '10px',
        padding: '14px 18px',
        borderBottom: `0.5px solid ${V.border}`,
        flex: '0 0 auto',
      },
      title: { fontSize: '15px', fontWeight: 500, flex: '1 1 auto', fontFamily: V.sans },
      tag: { fontSize: '11px', color: V.text3, fontFamily: V.sans },
      iconBtn: {
        border: `0.5px solid ${V.border2}`,
        background: 'transparent',
        color: 'inherit',
        font: 'inherit',
        fontSize: '12px',
        padding: '4px 10px',
        borderRadius: '6px',
        cursor: 'pointer',
        fontFamily: V.sans,
      },
      closeBtn: {
        border: 'none',
        background: 'transparent',
        color: V.text2,
        fontSize: '20px',
        lineHeight: '1',
        cursor: 'pointer',
        padding: '0 6px',
        borderRadius: '6px',
      },
      body: {
        padding: '18px',
        overflow: 'auto',
        flex: '1 1 auto',
        fontFamily: V.sans,
      },

      statsWrap: {
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fit, minmax(116px, 1fr))',
        gap: '10px',
        marginBottom: '20px',
      },
      stat: {
        padding: '10px 12px',
        background: V.bg2,
        borderRadius: '8px',
      },
      statLabel: { fontSize: '11px', color: V.text3, marginBottom: '4px' },
      statValue: { fontSize: '16px', fontWeight: 500, color: V.text, fontVariantNumeric: 'tabular-nums' },

      sectionTitle: {
        fontSize: '13px',
        fontWeight: 500,
        color: V.text2,
        margin: '0 0 10px',
      },

      card: {
        border: `0.5px solid ${V.border}`,
        borderRadius: '10px',
        marginBottom: '10px',
        overflow: 'hidden',
      },
      cardHead: {
        display: 'flex',
        alignItems: 'center',
        gap: '8px',
        padding: '10px 14px',
        flexWrap: 'wrap',
      },
      badge: {
        fontSize: '11px',
        fontWeight: 500,
        padding: '2px 8px',
        borderRadius: '999px',
      },
      cardTitle: { fontSize: '13px', fontWeight: 500 },
      cardScope: { fontSize: '11px', color: V.text3, fontFamily: V.mono },
      cardBody: {
        padding: '0 14px 12px',
        fontSize: '13px',
        lineHeight: '1.65',
        color: V.text,
      },
      row: { marginTop: '8px', display: 'flex', gap: '8px', alignItems: 'baseline' },
      rowLabel: { fontSize: '11px', color: V.text3, flex: '0 0 64px' },
      rowText: { flex: '1 1 auto', wordBreak: 'break-word' },

      codeBox: {
        marginTop: '10px',
        display: 'flex',
        alignItems: 'center',
        gap: '8px',
        padding: '8px 10px',
        background: V.bg2,
        borderRadius: '6px',
        fontFamily: V.mono,
        fontSize: '11px',
        lineHeight: '1.6',
        color: V.text2,
      },
      codeText: { flex: '1 1 auto', wordBreak: 'break-all', whiteSpace: 'pre-wrap' },
      howTo: { marginTop: '6px', fontSize: '11px', color: V.text3, lineHeight: '1.6' },
      copyBtn: {
        flex: '0 0 auto',
        border: `0.5px solid ${V.border2}`,
        background: V.bg,
        color: V.text2,
        font: 'inherit',
        fontSize: '11px',
        padding: '2px 8px',
        borderRadius: '4px',
        cursor: 'pointer',
        fontFamily: V.sans,
      },

      chips: { display: 'flex', flexWrap: 'wrap', gap: '6px' },
      chip: {
        fontSize: '11px',
        padding: '3px 9px',
        borderRadius: '999px',
        background: V.bg2,
        color: V.text2,
        border: `0.5px solid ${V.border}`,
      },

      note: { fontSize: '12px', color: V.text2, lineHeight: '1.75' },
      empty: { fontSize: '13px', color: V.text2, padding: '8px 0' },
      banner: {
        display: 'flex',
        alignItems: 'flex-start',
        gap: '10px',
        padding: '10px 12px',
        marginBottom: '16px',
        background: 'rgba(239,159,39,0.12)',
        border: '0.5px solid rgba(239,159,39,0.45)',
        borderRadius: '8px',
        fontSize: '12px',
        lineHeight: '1.7',
        color: '#854F0B',
      },
      bannerTitle: { fontWeight: 500, marginBottom: '2px' },
      bannerIcon: { flex: '0 0 auto', fontSize: '14px', lineHeight: '1.4' },
      footer: {
        marginTop: '22px',
        paddingTop: '14px',
        borderTop: `0.5px solid ${V.border}`,
        fontSize: '11px',
        color: V.text3,
        display: 'flex',
        justifyContent: 'space-between',
        gap: '10px',
        flexWrap: 'wrap',
      },
    };

    // -----------------------------------------------------------------------
    // 小组件
    // -----------------------------------------------------------------------
    function CopyButton({ text, label }) {
      const [done, setDone] = React.useState(false);
      const nav = typeof navigator !== 'undefined' ? navigator : undefined;
      const can = Boolean(nav && nav.clipboard && nav.clipboard.writeText);
      const copy = () => {
        if (!can) return;
        nav.clipboard
          .writeText(text)
          .then(() => {
            setDone(true);
            setTimeout(() => setDone(false), 1400);
          })
          .catch(() => setDone(false));
      };
      return h(
        'button',
        {
          type: 'button',
          style: S.copyBtn,
          onClick: copy,
          disabled: !can,
          title: can ? '复制' : '当前环境不支持剪贴板',
        },
        done ? '已复制' : `复制${label || ''}`,
      );
    }

    function Stat({ label, value }) {
      return h(
        'div',
        { style: S.stat },
        h('div', { style: S.statLabel }, label),
        h('div', { style: S.statValue }, value),
      );
    }

    function shortLocator(loc) {
      const s = String(loc || '');
      const i = s.lastIndexOf('\\');
      return i >= 0 ? s.slice(i + 1) : s;
    }

    function FindingCard({ f }) {
      const sev = sevOf(f.severity);
      const first = (f.evidence || [])[0];
      const sess = f.scope ? String(f.scope).replace(/^session-/, '').slice(0, 12) : '';
      return h(
        'div',
        { style: Object.assign({}, S.card, { borderLeft: `3px solid ${sev.accent}` }) },
        h(
          'div',
          { style: S.cardHead },
          h('span', { style: Object.assign({}, S.badge, { color: sev.color, background: sev.bg }) }, f.severity),
          h('span', { style: S.cardTitle }, `${f.id} ${f.title}`),
          sess ? h('span', { style: S.cardScope }, sess) : null,
        ),
        h(
          'div',
          { style: S.cardBody },
          h('div', null, f.summary),
          first
            ? h(
                'div',
                { style: S.row },
                h('span', { style: S.rowLabel }, '证据'),
                h(
                  'span',
                  { style: S.rowText },
                  h('code', { style: { fontFamily: V.mono, fontSize: '12px' } }, shortLocator(first.locator)),
                ),
              )
            : null,
          f.impact
            ? h(
                'div',
                { style: S.row },
                h('span', { style: S.rowLabel }, '影响'),
                h('span', { style: S.rowText }, f.impact),
              )
            : null,
          h(
            'div',
            { style: S.row },
            h('span', { style: S.rowLabel }, '置信度'),
            h('span', { style: S.rowText }, f.confidence >= 0.8 ? '高' : '中'),
          ),
          first
            ? h(
                'div',
                { style: S.codeBox },
                h('span', { style: S.codeText }, first.locator),
                h(CopyButton, { text: first.locator, label: '定位符' }),
              )
            : null,
          first
            ? h(
                'div',
                { style: S.howTo },
                '复制定位符后，在会话里运行 ',
                h('code', { style: { fontFamily: V.mono } }, './run.sh show "<定位符>"'),
                ' 可查看原始记录亲自复核',
              )
            : null,
        ),
      );
    }

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
        h('span', null, isOpen ? '收起体检' : '体检'),
      );
    }

    // -----------------------------------------------------------------------
    // 覆盖层面板
    // -----------------------------------------------------------------------
    function ClinicPanel() {
      const isOpen = useOpen();
      const [state, setState] = React.useState({ status: 'idle', data: null, text: '', error: '' });
      const [nonce, setNonce] = React.useState(0);

      React.useEffect(() => {
        if (!isOpen) return undefined;
        let cancelled = false;
        setState((s) => ({ status: 'loading', data: s.data, text: s.text, error: '' }));

        const req =
          typeof fetch === 'function'
            ? fetch(REPORT_API, { headers: { accept: 'application/json' } })
            : Promise.reject(new Error('当前环境不提供 fetch，无法从宿主取数'));

        req
          .then((r) => r.json())
          .then((d) => {
            if (cancelled) return;
            if (d && d.ok) {
              setState({
                status: 'ok',
                data: d.data || null,
                text: d.report || '',
                error: '',
                version: d.version,
              });
            } else {
              setState({ status: 'error', data: null, text: '', error: (d && d.error) || '未知错误' });
            }
          })
          .catch((e) => {
            if (cancelled) return;
            setState({ status: 'error', data: null, text: '', error: String((e && e.message) || e) });
          });

        return () => {
          cancelled = true;
        };
      }, [isOpen, nonce]);

      if (!isOpen) return null;
      const close = () => setOpen(false);

      let body;
      if (state.status === 'loading') {
        body = h('div', { style: S.note }, '正在读取本地会话并生成体检报告…');
      } else if (state.status === 'error') {
        body = h(
          'div',
          { style: S.note },
          h('div', null, '未能取得报告：', h('code', { style: { fontFamily: V.mono } }, state.error)),
          h(
            'div',
            { style: { marginTop: '10px' } },
            '若提示服务不可用，说明宿主未挂载 webServer 服务；',
            '此时仍可在会话里直接说「体检一下」，由模型调用工具产出报告。',
          ),
        );
      } else if (!state.data) {
        body = h(
          'pre',
          { style: { margin: 0, fontFamily: V.mono, fontSize: '12px', lineHeight: '1.7', whiteSpace: 'pre-wrap' } },
          state.text,
        );
      } else {
        const hd = state.data.header;
        const stale = state.version !== CLIENT_VERSION;
        body = h(
          'div',
          null,
          stale
            ? h(
                'div',
                { style: S.banner },
                h('span', { style: S.bannerIcon }, '⚠'),
                h(
                  'div',
                  null,
                  h('div', { style: S.bannerTitle }, '宿主仍是旧版，请完全退出并重启 Harness'),
                  h(
                    'div',
                    null,
                    '插件文件已更新到磁盘，但 Harness 进程里加载的还是旧代码。',
                    '请从任务栏/托盘完全退出 DeepSeek Harness（不是关窗口）后重新打开。',
                  ),
                ),
              )
            : null,
          h(
            'div',
            { style: S.statsWrap },
            h(Stat, { label: '会话', value: String(hd.sessions) }),
            h(Stat, { label: '工具调用', value: String(hd.toolCalls) }),
            h(Stat, { label: '错误率', value: `${(hd.errorRate * 100).toFixed(1)}%` }),
            h(Stat, { label: 'input', value: hd.inputTokens.toLocaleString() }),
            h(Stat, { label: 'output', value: hd.outputTokens.toLocaleString() }),
            h(Stat, { label: 'cacheRead', value: hd.cacheReadTokens.toLocaleString() }),
          ),

          state.data.findings.length === 0
            ? h(
                'div',
                null,
                h('h3', { style: S.sectionTitle }, '未发现问题'),
                h('div', { style: S.empty }, '所有已实现的指标均未检测到异常。'),
              )
            : h(
                'div',
                null,
                h('h3', { style: S.sectionTitle }, `发现 ${state.data.findings.length} 个问题（按严重度排序）`),
                state.data.findings.map((f) => h(FindingCard, { key: `${f.id}|${f.scope || ''}`, f })),
              ),

          h('h3', { style: S.sectionTitle }, '未检测到异常的维度'),
          state.data.notDetected.length
            ? h(
                'div',
                { style: S.chips },
                state.data.notDetected.map((d) => h('span', { key: d.id, style: S.chip }, `${d.id} ${d.title}`)),
              )
            : h('div', { style: S.empty }, '（无）'),

          state.data.notImplemented.length
            ? h(
                'div',
                { style: { marginTop: '16px' } },
                h('h3', { style: S.sectionTitle }, '未实现的维度（骨架阶段）'),
                h(
                  'div',
                  { style: S.chips },
                  state.data.notImplemented.map((d) => h('span', { key: d.id, style: S.chip }, `${d.id} ${d.title}`)),
                ),
              )
            : null,

          h(
            'div',
            { style: S.footer },
            h('span', null, state.data.footer),
            h('span', null, `平台 ${hd.platform}`),
          ),
        );
      }

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
            h('span', { style: S.tag }, '只读 · 零外发'),
            h('button', { type: 'button', style: S.iconBtn, onClick: () => setNonce((n) => n + 1) }, '刷新'),
            h('button', { type: 'button', style: S.closeBtn, onClick: close, 'aria-label': '关闭' }, '×'),
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
          errors.push(`${label}(${slotName})：${String((e && e.message) || e)}`);
        }
      }
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
