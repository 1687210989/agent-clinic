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
    const WATCH_API = '/api/agent-clinic/watch';
    /** 「联网现搜插件」端点：只有点按钮才会请求，面板默认零外发 */
    const LIVE_API = '/api/agent-clinic/live';
    const POLL_MS = 6000;

    /**
     * 客户端版本号。宿主在响应里带回同一个值，用于识别
     * 「客户端已更新、宿主还跑着旧代码」这种静默不一致。
     *
     * 这个场景很常见：插件文件更新在磁盘上后，浏览器会立即拿到新
     * client.js，而宿主半是启动时装入进程的，必须重启才生效。
     * 若不显式提示，用户只会看到面板内容没变，无从判断该做什么。
     */
    const CLIENT_VERSION = '15';

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
    // 准实时：轮询宿主轻量状态，签名变化才拉全量报告
    //
    // 宿主用 fs.watch 盯 ~/.dsh/sessions，把「有没有变化」压成一个签名；
    // 这里每 6 秒问一次，签名没变就什么都不做（不重复解析 4~5 个会话文件）。
    // 签名变了就：① 给侧边栏按钮加未读角标 ② 面板开着就自动刷新内容。
    // -----------------------------------------------------------------------
    let watchSnap = { signature: '', count: 0, unseen: 0 };
    const watchListeners = new Set();
    const panelRefreshListeners = new Set();

    function setWatchSnap(next) {
      watchSnap = next;
      watchListeners.forEach((l) => {
        try {
          l();
        } catch {
          /* ignore */
        }
      });
    }
    function subscribeWatch(l) {
      watchListeners.add(l);
      return () => watchListeners.delete(l);
    }
    function useWatchSnap() {
      return React.useSyncExternalStore(subscribeWatch, () => watchSnap, () => watchSnap);
    }
    /** 通知面板重新拉取报告（面板内部用 nonce 触发） */
    function requestPanelRefresh() {
      panelRefreshListeners.forEach((l) => {
        try {
          l();
        } catch {
          /* ignore */
        }
      });
    }

    /** 在常驻的侧边栏按钮里启动唯一轮询器 */
    function useClinicWatcher() {
      React.useEffect(() => {
        let cancelled = false;
        const tick = async () => {
          if (cancelled || typeof fetch !== 'function') return;
          try {
            const r = await fetch(WATCH_API, { headers: { accept: 'application/json' } });
            const d = await r.json();
            if (cancelled || !d || !d.ok) return;
            if (d.signature === watchSnap.signature) return;

            const firstTime = watchSnap.signature === '';
            const grew = (d.count || 0) > watchSnap.count;
            setWatchSnap({
              signature: d.signature,
              count: d.count || 0,
              // 首次拉取不算未读；之后问题变多才算「新发现」
              unseen: firstTime ? 0 : grew ? (d.count || 0) - watchSnap.count + watchSnap.unseen : 0,
            });
            if (!firstTime) requestPanelRefresh();
          } catch {
            /* 网络抖动、宿主未就绪：忽略，下次轮询再试 */
          }
        };
        tick();
        const id = setInterval(tick, POLL_MS);
        return () => {
          cancelled = true;
          clearInterval(id);
        };
      }, []);
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

    /**
     * 问题卡片（**同类型已合并**）：一类问题一张卡。
     *
     * 收起态：严重度 + 指标 + 「N 处」+ 聚合结论 + 处方数；
     * 展开后：每一处的会话 / 结论 / 证据定位（可复制），再挂这个问题的处方与建议。
     * 合并不会丢信息 —— 每一处照样能看到自己的定位符。
     */
    function GroupCard({ g }) {
      const [open, setOpen] = React.useState(false);
      const [showAll, setShowAll] = React.useState(false);
      const sev = sevOf(g.severity);
      const attached = g.prescriptions || [];
      const instances = g.instances || [];
      const shown = showAll ? instances : instances.slice(0, 5);
      return h(
        'div',
        { style: Object.assign({}, S.card, { borderLeft: `3px solid ${sev.accent}` }) },
        h(
          'div',
          {
            style: Object.assign({}, S.cardHead, { cursor: 'pointer' }),
            onClick: () => setOpen((o) => !o),
            role: 'button',
            'aria-expanded': open,
          },
          h('span', { style: Object.assign({}, S.badge, { color: sev.color, background: sev.bg }) }, g.severity),
          h('span', { style: S.cardTitle }, `${g.id} ${g.title}`),
          g.count > 1
            ? h(
                'span',
                {
                  style: {
                    fontSize: '11px',
                    color: V.text3,
                    background: 'rgba(127,127,127,0.12)',
                    borderRadius: '999px',
                    padding: '1px 8px',
                  },
                },
                `${g.count} 处`,
              )
            : String(g.sessions?.[0] || '')
              ? h('span', { style: S.cardScope }, String(g.sessions[0]).replace(/^session-/, '').slice(0, 12))
              : null,
          h('span', { style: { flex: '1 1 auto' } }),
          attached.length ? h('span', { style: { fontSize: '11px', color: V.text3 } }, `处方 ${attached.length}`) : null,
          h('span', { style: { fontSize: '11px', color: V.text3 } }, open ? '收起 ▾' : '展开 ▸'),
        ),
        h(
          'div',
          { style: { marginTop: '6px', fontSize: '12px', color: V.text2, lineHeight: '1.7' } },
          g.summary,
        ),
        g.impact
          ? h('div', { style: { marginTop: '2px', fontSize: '11px', color: V.text3 } }, `影响：${g.impact}`)
          : null,
        open
          ? h(
              'div',
              { style: S.cardBody },
              h(
                'div',
                { style: { fontSize: '11px', color: V.text3, lineHeight: '1.7' } },
                `置信度：${g.confidence >= 0.8 ? '高' : '中'}`,
                g.sessions && g.sessions.length
                  ? ` · 涉及会话：${g.sessions.map((s) => String(s).replace(/^session-/, '').slice(0, 8)).join('、')}`
                  : '',
                g.tools && g.tools.length ? ` · 涉及工具：${g.tools.join('、')}` : '',
              ),
              h(
                'div',
                { style: { marginTop: '8px' } },
                h(
                  'div',
                  { style: { fontSize: '11px', fontWeight: 500, color: V.text2, marginBottom: '6px' } },
                  `具体是哪几处（${g.count}）`,
                ),
                shown.map((inst, i) =>
                  h(
                    'div',
                    {
                      key: i,
                      style: {
                        padding: '7px 10px',
                        marginBottom: '6px',
                        borderRadius: '8px',
                        background: 'rgba(127,127,127,0.06)',
                      },
                    },
                    h(
                      'div',
                      { style: { fontSize: '12px', color: V.text2, lineHeight: '1.6' } },
                      h(
                        'span',
                        { style: { fontFamily: V.mono, fontSize: '11px', color: V.text3, marginRight: '6px' } },
                        String(inst.scope || '(全局)').replace(/^session-/, '').slice(0, 12),
                      ),
                      inst.summary,
                    ),
                    inst.impact
                      ? h('div', { style: { fontSize: '11px', color: V.text3, marginTop: '2px' } }, inst.impact)
                      : null,
                    inst.evidence && inst.evidence[0]
                      ? h(
                          'div',
                          { style: S.codeBox },
                          h('span', { style: S.codeText }, inst.evidence[0].locator),
                          h(CopyButton, { text: inst.evidence[0].locator, label: '定位符' }),
                        )
                      : null,
                  ),
                ),
                instances.length > 5
                  ? h(
                      'button',
                      {
                        type: 'button',
                        style: S.copyBtn,
                        onClick: () => setShowAll((v) => !v),
                      },
                      showAll ? '只看前 5 处' : `显示全部 ${instances.length} 处`,
                    )
                  : null,
              ),
              h(
                'div',
                { style: S.howTo },
                '复制定位符后，在会话里运行 ',
                h('code', { style: { fontFamily: V.mono } }, './run.sh show "<定位符>"'),
                ' 可查看原始记录亲自复核',
              ),
              g.skippedPrescriptions && g.skippedPrescriptions.length
                ? h(
                    'div',
                    { style: S.howTo },
                    '已否决的处方：',
                    g.skippedPrescriptions.map((s) => `${s.title}（${s.reason}）`).join('；'),
                  )
                : null,
              attached.length
                ? h(
                    'div',
                    { style: { marginTop: '10px' } },
                    h(
                      'div',
                      { style: { fontSize: '11px', fontWeight: 500, color: V.text2, marginBottom: '6px' } },
                      `这个问题的处方与建议（${attached.length} 条 · 同类问题共用）`,
                    ),
                    attached.map((rx, i) => h(RxCard, { key: rx.targetId || i, rx })),
                  )
                : h('div', { style: S.howTo }, '这个问题没有对症处方 —— 本工具不会硬凑。'),
            )
          : null,
      );
    }

    // 处方按类型配色：改配置 / 跑命令 / 装插件 / 改设置 / 行为建议
    const KIND_STYLE = {
      config: { fg: '#3B6D11', bg: 'rgba(99,153,34,0.12)', bd: 'rgba(99,153,34,0.45)', card: 'rgba(99,153,34,0.06)' },
      command: { fg: '#8B5CF6', bg: 'rgba(139,92,246,0.14)', bd: 'rgba(139,92,246,0.45)', card: 'rgba(139,92,246,0.06)' },
      plugin: { fg: '#185FA5', bg: 'rgba(24,95,165,0.12)', bd: 'rgba(24,95,165,0.45)', card: 'rgba(24,95,165,0.06)' },
      settings: { fg: '#B45309', bg: 'rgba(180,83,9,0.12)', bd: 'rgba(180,83,9,0.45)', card: 'rgba(180,83,9,0.06)' },
      behavior: { fg: '#3B6D11', bg: 'rgba(99,153,34,0.12)', bd: 'rgba(99,153,34,0.45)', card: 'rgba(99,153,34,0.06)' },
    };

    function MetaRow({ label, text }) {
      if (!text) return null;
      return h(
        'div',
        { style: { marginTop: '6px', fontSize: '11px', color: V.text3, lineHeight: '1.7' } },
        `${label}：`,
        String(text),
      );
    }

    /** 分步操作指引（展开后显示的第一块） */
    function Steps({ steps }) {
      if (!steps || !steps.length) return null;
      return h(
        'div',
        {
          style: {
            marginTop: '8px',
            padding: '10px 12px',
            borderRadius: '8px',
            background: 'rgba(127,127,127,0.08)',
          },
        },
        h('div', { style: { fontSize: '11px', fontWeight: 500, color: V.text2, marginBottom: '6px' } }, '具体怎么做'),
        h(
          'ol',
          { style: { margin: 0, paddingLeft: '18px', fontSize: '12px', lineHeight: '1.8', color: V.text2 } },
          steps.map((s, i) => h('li', { key: i, style: { marginBottom: '2px' } }, s)),
        ),
      );
    }

    /** 可折叠处方卡：收起只给一行结论，展开才是全部内容 */
    function RxCard({ rx }) {
      const [open, setOpen] = React.useState(false);
      const k = KIND_STYLE[rx.kind] || KIND_STYLE.behavior;
      const isConfig = rx.action && rx.action.type === 'config';
      const snippet = isConfig ? rx.action.snippet || rx.command : null;
      const cli = !isConfig ? rx.command : null;
      const brief = rx.brief || String(rx.detail || '').split('\n')[0];
      return h(
        'div',
        {
          style: {
            border: `0.5px solid ${k.bd}`,
            background: k.card,
            borderRadius: '10px',
            padding: '10px 14px',
            marginBottom: '10px',
          },
        },
        h(
          'div',
          {
            style: { display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer' },
            onClick: () => setOpen((o) => !o),
            role: 'button',
            'aria-expanded': open,
          },
          h(
            'span',
            {
              style: {
                fontSize: '11px',
                fontWeight: 500,
                padding: '2px 8px',
                borderRadius: '999px',
                color: k.fg,
                background: k.bg,
                flex: '0 0 auto',
              },
            },
            rx.kindLabel || (rx.kind === 'install' ? '装插件' : '行为建议'),
          ),
          h('span', { style: { fontSize: '13px', fontWeight: 500 } }, rx.title),
          rx.findingId ? h('span', { style: S.cardScope }, `针对 ${rx.findingId}`) : null,
          h('span', { style: { flex: '1 1 auto' } }),
          h('span', { style: { fontSize: '11px', color: V.text3, flex: '0 0 auto' } }, open ? '收起 ▾' : '展开 ▸'),
        ),
        h(
          'div',
          {
            style: {
              marginTop: '6px',
              fontSize: '12px',
              lineHeight: '1.6',
              color: V.text2,
              wordBreak: 'break-word',
            },
          },
          brief,
        ),
        open
          ? h(
              'div',
              null,
              String(rx.detail || '')
                .split('\n')
                .map((line, i) =>
                  h('div', { key: i, style: { marginTop: '6px', fontSize: '12px', lineHeight: '1.7', color: V.text2 } }, line),
                ),
              h(Steps, { steps: rx.steps }),
              snippet
                ? h(
                    'div',
                    { style: { marginTop: '8px' } },
                    isConfig && rx.action?.file
                      ? h(
                          'div',
                          { style: S.howTo },
                          '改这份文件（只给片段，不代你改）：',
                          h('code', { style: { fontFamily: V.mono } }, rx.action.file),
                        )
                      : null,
                    h(
                      'div',
                      { style: S.codeBox },
                      h('span', { style: S.codeText }, snippet),
                      h(CopyButton, { text: snippet, label: '片段' }),
                    ),
                  )
                : null,
              cli
                ? h(
                    'div',
                    { style: S.codeBox },
                    h('span', { style: S.codeText }, cli),
                    h(CopyButton, { text: cli, label: '命令' }),
                  )
                : null,
              rx.action && rx.action.type === 'settings' && rx.action.where
                ? h('div', { style: S.howTo }, '改哪里：', h('code', { style: { fontFamily: V.mono } }, rx.action.where))
                : null,
              h(MetaRow, { label: '依据', text: rx.because }),
              h(MetaRow, { label: '风险', text: rx.risk }),
              h(MetaRow, { label: '怎么确认有效', text: rx.verify }),
              h(MetaRow, { label: '出处', text: [rx.source, rx.sourceVia].filter(Boolean).join(' · ') }),
            )
          : null,
      );
    }

    /** 省 token 开关清单：陈列本机真实存在的旋钮（不是体检结论），同样可折叠 */
    function LeverRow({ lv }) {
      const [open, setOpen] = React.useState(false);
      const k = KIND_STYLE[lv.kind] || KIND_STYLE.config;
      return h(
        'div',
        {
          style: {
            border: `0.5px solid ${k.bd}`,
            background: k.card,
            borderRadius: '10px',
            padding: '10px 12px',
            marginBottom: '8px',
          },
        },
        h(
          'div',
          {
            style: { display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer' },
            onClick: () => setOpen((o) => !o),
            role: 'button',
            'aria-expanded': open,
          },
          h(
            'span',
            {
              style: {
                fontSize: '11px',
                fontWeight: 500,
                padding: '2px 8px',
                borderRadius: '999px',
                color: k.fg,
                background: k.bg,
                flex: '0 0 auto',
              },
            },
            lv.kindLabel,
          ),
          h('span', { style: { fontSize: '12px', fontWeight: 500 } }, lv.title),
          h('span', { style: { flex: '1 1 auto' } }),
          h('span', { style: { fontSize: '11px', color: V.text3, flex: '0 0 auto' } }, open ? '收起 ▾' : '展开 ▸'),
        ),
        lv.current || lv.suggested
          ? h(
              'div',
              { style: { marginTop: '4px', fontSize: '11px', color: V.text3, fontFamily: V.mono, wordBreak: 'break-word' } },
              `当前 ${lv.current || '(未读到)'} → 建议 ${lv.suggested || '按需'}`,
            )
          : null,
        open
          ? h(
              'div',
              null,
              h('div', { style: { marginTop: '6px', fontSize: '12px', color: V.text2, lineHeight: '1.6' } }, lv.solves),
              h(Steps, { steps: lv.steps }),
              lv.snippet
                ? h(
                    'div',
                    { style: S.codeBox },
                    h('span', { style: S.codeText }, lv.snippet),
                    h(CopyButton, { text: lv.snippet, label: '片段' }),
                  )
                : null,
              lv.install && lv.install.gui ? h('div', { style: S.howTo }, '安装：', lv.install.gui) : null,
              lv.install && lv.install.cli
                ? h(
                    'div',
                    { style: S.codeBox },
                    h('span', { style: S.codeText }, lv.install.cli),
                    h(CopyButton, { text: lv.install.cli, label: '命令' }),
                  )
                : null,
              h(MetaRow, { label: '风险', text: lv.risk }),
              h(MetaRow, { label: '出处', text: lv.source }),
            )
          : null,
      );
    }

    /** 插件目录检索命中项：可折叠，展开看到能力标签与"为什么命中" */
    function CatalogRow({ hit }) {
      const [open, setOpen] = React.useState(false);
      const k = KIND_STYLE.plugin;
      return h(
        'div',
        {
          style: {
            border: `0.5px solid ${k.bd}`,
            background: k.card,
            borderRadius: '10px',
            padding: '9px 12px',
            marginBottom: '8px',
          },
        },
        h(
          'div',
          {
            style: { display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer' },
            onClick: () => setOpen((o) => !o),
            role: 'button',
            'aria-expanded': open,
          },
          h(
            'span',
            {
              style: {
                fontSize: '11px',
                fontWeight: 500,
                padding: '2px 8px',
                borderRadius: '999px',
                color: k.fg,
                background: k.bg,
                flex: '0 0 auto',
              },
            },
            hit.installed ? '已装' : '可装',
          ),
          h('span', { style: { fontSize: '12px', fontWeight: 500 } }, hit.displayName),
          h('span', { style: S.cardScope }, hit.package),
          hit.findingIds && hit.findingIds.length
            ? h(
                'span',
                {
                  style: {
                    fontSize: '10px',
                    color: V.text3,
                    border: `0.5px solid ${V.border || 'rgba(127,127,127,0.3)'}`,
                    borderRadius: '999px',
                    padding: '0 6px',
                  },
                },
                `→ ${hit.findingIds.join(' / ')}`,
              )
            : null,
          hit.origin === 'npm-registry'
            ? h('span', { style: { fontSize: '10px', color: V.text3 } }, 'npm 同步')
            : hit.origin === 'github'
              ? h('span', { style: { fontSize: '10px', color: V.text3 } }, 'GitHub 核实')
              : null,
          hit.kindText && hit.kindText !== '人工核实'
            ? h(
                'span',
                {
                  style: {
                    fontSize: '10px',
                    color: V.text3,
                    border: `0.5px solid ${V.border || 'rgba(127,127,127,0.3)'}`,
                    borderRadius: '999px',
                    padding: '0 6px',
                    flex: '0 0 auto',
                  },
                },
                hit.kindText,
              )
            : null,
          hit.heatText
            ? h(
                'span',
                { style: { fontSize: '10px', color: V.text3, flex: '0 0 auto' }, title: '热度只用于同分排序，不参与对症打分' },
                hit.heatText,
              )
            : null,
          h('span', { style: { flex: '1 1 auto' } }),
          h('span', { style: { fontSize: '11px', color: V.text3, flex: '0 0 auto' } }, open ? '收起 ▾' : '展开 ▸'),
        ),
        h(
          'div',
          { style: { marginTop: '4px', fontSize: '12px', color: V.text2, lineHeight: '1.6' } },
          hit.summaryLang === 'en'
            ? h('span', { style: { color: V.text3, marginRight: '4px' } }, '（英文原文）')
            : null,
          hit.summary,
        ),
        open
          ? h(
              'div',
              null,
              h(
                'div',
                { style: { marginTop: '6px', fontSize: '11px', color: V.text3, lineHeight: '1.7' } },
                '能力标签：',
                (hit.capabilities || []).join(' / '),
              ),
              h(
                'div',
                { style: { marginTop: '4px', fontSize: '11px', color: V.text3, lineHeight: '1.7' } },
                '命中原因：',
                (hit.reasons || []).join('；'),
              ),
              hit.capabilityEvidence && hit.capabilityEvidence.length
                ? h(
                    'div',
                    { style: { marginTop: '2px', fontSize: '11px', color: V.text3, lineHeight: '1.7' } },
                    '能力依据（目录描述里命中的词）：',
                    hit.capabilityEvidence.map((e) => `${e.cap}←「${e.matched}」`).join('、'),
                  )
                : null,
              !hit.installed && hit.install && hit.install.gui
                ? h('div', { style: S.howTo }, '安装：', hit.install.gui)
                : null,
              !hit.installed && hit.install && hit.install.cli
                ? h(
                    'div',
                    { style: S.codeBox },
                    h('span', { style: S.codeText }, hit.install.cli),
                    h(CopyButton, { text: hit.install.cli, label: '命令' }),
                  )
                : null,
              h(MetaRow, { label: '热度', text: hit.heatText }),
              hit.kindText === '官方内置包'
                ? h(MetaRow, {
                    label: '提示',
                    text: 'DSH 官方内置包，通常已随 dsh-base 挂载，一般不需要再装（可当配置参考）',
                  })
                : null,
              h(MetaRow, { label: '风险', text: hit.risk }),
              h(MetaRow, { label: '核实', text: [hit.verifiedAt, hit.repo].filter(Boolean).join(' · ') }),
            )
          : null,
      );
    }

    // -----------------------------------------------------------------------
    // 侧边栏按钮
    // -----------------------------------------------------------------------
    function ClinicNavButton() {
      const isOpen = useOpen();
      const w = useWatchSnap();
      useClinicWatcher();

      // 打开面板即视为已读
      React.useEffect(() => {
        if (isOpen && watchSnap.unseen > 0) setWatchSnap({ ...watchSnap, unseen: 0 });
      }, [isOpen]);

      return h(
        'button',
        {
          type: 'button',
          style: Object.assign({}, S.navBtn, { position: 'relative' }),
          title: 'Agent 体检诊所 —— 用可复核证据诊断 Agent 使用体验',
          onClick: () => setOpen(!isOpen),
        },
        h('span', { 'aria-hidden': 'true' }, '🩺'),
        h('span', { style: { flex: '1 1 auto' } }, isOpen ? '收起体检' : '体检'),
        w.unseen > 0
          ? h(
              'span',
              {
                title: `发现 ${w.unseen} 个新问题`,
                style: {
                  flex: '0 0 auto',
                  minWidth: '17px',
                  height: '17px',
                  padding: '0 5px',
                  borderRadius: '999px',
                  background: '#E24B4A',
                  color: '#fff',
                  fontSize: '10px',
                  lineHeight: '17px',
                  textAlign: 'center',
                  fontWeight: 500,
                },
              },
              String(w.unseen),
            )
          : null,
      );
    }

    // -----------------------------------------------------------------------
    // 覆盖层面板
    // -----------------------------------------------------------------------
    function ClinicPanel() {
      const isOpen = useOpen();
      const [state, setState] = React.useState({ status: 'idle', data: null, text: '', error: '' });
      const [nonce, setNonce] = React.useState(0);
      // 联网现搜：独立状态，不随普通刷新被清掉（见下方 runLive）
      const [live, setLive] = React.useState(null);
      const [liveBusy, setLiveBusy] = React.useState(false);
      const [liveErr, setLiveErr] = React.useState('');

      /**
       * 「发现问题后联网找方案」—— 点按钮才联网。
       * 面板默认仍然是零外发的：不点这个按钮，宿主不会发起任何外部请求。
       */
      const runLive = () => {
        if (typeof fetch !== 'function') {
          setLiveErr('当前环境不提供 fetch，无法联网检索');
          return;
        }
        setLiveBusy(true);
        setLiveErr('');
        fetch(LIVE_API, { headers: { accept: 'application/json' } })
          .then((r) => r.json())
          .then((dd) => {
            if (dd && dd.ok) setLive({ info: dd.live || null, data: dd.data || null });
            else setLiveErr((dd && dd.error) || '联网检索失败');
          })
          .catch((e) => setLiveErr(String((e && e.message) || e)))
          .finally(() => setLiveBusy(false));
      };

      React.useEffect(() => {
        if (!isOpen) return undefined;
        let cancelled = false;
        setState((s) => ({ status: 'loading', data: s.data, text: s.text, error: '' }));

        // 轮询器发现签名变化时，顺手把面板内容也刷新掉
        const onWatch = () => {
          if (!cancelled) setNonce((n) => n + 1);
        };
        panelRefreshListeners.add(onWatch);

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
          panelRefreshListeners.delete(onWatch);
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
            '若提示 404 或服务不可用，说明宿主进程还在跑**旧插件代码**，请完全退出并重启 Harness；',
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
        // 「联网现搜」返回的是**完整的一份分析结果**（含按现搜目录重算的处方），
        // 所以拿到后整体替换展示数据，而不是只往里塞几条插件 ——
        // 否则"问题卡上的处方"和"插件列表"会来自两次不同的分析，对不上。
        // ⚠️ 这里读的是**组件内的 `live` state**（本文件 line 1005），
        //    而不是 state 对象上那个并不存在的 live 字段 —— 写成后者会让三元
        //    恒取 state.data：按钮看起来"没生效"（只有状态行变了，卡片还是旧数据）。
        //    冒烟里有断言守住这一点。
        const d = live && live.data ? live.data : state.data;
        const hd = d.header;
        // F16：汇总各分组里被否决的处方，稍后与"尚未实现"一起渲染
        const skippedList = (d.groups || []).flatMap((g) =>
          (g.skippedPrescriptions || []).map((s) => ({ ...s, findingId: g.id })),
        );
        const configPath = (d.config && d.config.patchPath) || null;
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

          (() => {
            // 术语图例：报告与面板里一直只有 C1/A3/E5 这样的编号，
            // 用户看不懂就直接放弃。这里把本次出现的指标 id → 名称列全。
            const terms = new Map();
            for (const f of d.findings || []) terms.set(f.id, f.title);
            for (const g of d.groups || []) terms.set(g.id, g.title);
            for (const n of d.notDetected || []) terms.set(n.id, n.title);
            if (!terms.size) return null;
            return h(
              'details',
              { style: { marginTop: '10px', fontSize: '11px', color: V.text3 } },
              h('summary', { style: { cursor: 'pointer' } }, '指标编号是什么意思？（展开图例）'),
              h(
                'div',
                { style: { marginTop: '6px', lineHeight: '1.8' } },
                [...terms.entries()].map(([id, title]) =>
                  h('div', { key: id }, `${id} · ${title}`)),
              ),
            );
          })(),

          liveBusy || live || liveErr
            ? h(
                'div',
                { style: { ...S.howTo, marginTop: '10px' } },
                liveBusy
                  ? '正在联网检索插件（npm + GitHub，只发送问题类型关键词，不发送会话内容）…'
                  : liveErr
                    ? `联网检索失败：${liveErr}。若提示 404，说明宿主进程还在跑旧插件代码，完全退出并重启 Harness 后重试。`
                    : `本次联网现搜：新发现 ${(live.info && live.info.stats && live.info.stats.kept) || 0} 条候选，` +
                      `耗时 ${(((live.info && live.info.elapsedMs) || 0) / 1000).toFixed(1)}s` +
                      `${live.info && live.info.degraded ? '（部分通道降级，见下）' : ''}。` +
                      `实际发出的检索词：${((live.info && live.info.sent) || []).join('、') || '(无)'}` +
                      (live.info && live.info.errors && live.info.errors.length
                        ? ` ⚠ ${live.info.errors.join('；')}`
                        : ''),
              )
            : null,

          (d.groups && d.groups.length) || d.findings.length === 0
            ? (d.groups || []).length === 0
              ? h(
                  'div',
                  null,
                  h('h3', { style: S.sectionTitle }, '未发现问题'),
                  h('div', { style: S.empty }, '所有已实现的指标均未检测到异常。'),
                )
              : h(
                  'div',
                  null,
                  h(
                    'h3',
                    { style: S.sectionTitle },
                    `发现 ${d.groups.length} 类问题（共 ${d.groups.reduce(
                      (n, g) => n + g.count,
                      0,
                    )} 处 · 按严重度排序）`,
                  ),
                  h(
                    'div',
                    { style: S.howTo },
                    '同一指标的多处命中已合并成一张卡（不再重复展示）。点开卡片：能看到每一处的会话与证据定位，以及**这个问题的处方与建议**。',
                  ),
                  d.groups.map((g) => h(GroupCard, { key: g.id, g })),
                )
            : h(
                'div',
                null,
                h('h3', { style: S.sectionTitle }, `发现 ${d.findings.length} 个问题（按严重度排序）`),
                h('div', { style: S.empty }, '（宿主未返回合并视图，请更新插件后重启以启用同类型合并）'),
              ),

          d.prescriptions && d.prescriptions.length
            ? h(
                'div',
                { style: { marginTop: '20px' } },
                h(
                  'h3',
                  { style: S.sectionTitle },
                  `处方：最该先做的 ${d.prescriptions.length} 条（唯一可执行产出，从各问题里挑出）`,
                ),
                configPath
                  ? h(
                      'div',
                      { style: S.howTo },
                      '配置类处方改的是：',
                      h('code', { style: { fontFamily: V.mono } }, configPath),
                      '（本工具只读它，不代你改）',
                    )
                  : null,
                d.prescriptions.map((rx, i) => h(RxCard, { key: rx.targetId || i, rx })),
                d.config && d.config.warnings && d.config.warnings.length
                  ? h('div', { style: S.howTo }, `配置读取提示：${d.config.warnings.join('；')}`)
                  : null,
              )
            : null,

          h('h3', { style: S.sectionTitle }, '未检测到异常的维度'),
          d.notDetected.length
            ? h(
                'div',
                { style: S.chips },
                d.notDetected.map((d) =>
                  h(
                    'span',
                    { key: d.id, style: S.chip, title: d.note || '未检测到异常' },
                    `${d.id} ${d.title}`,
                  )),
              )
            : h('div', { style: S.empty }, '（无）'),

          d.notDetected.some((d) => d.note)
            ? h(
                'div',
                { style: { marginTop: '8px', fontSize: '11px', color: V.text3, lineHeight: '1.7' } },
                d.notDetected
                  .filter((d) => d.note)
                  .map((d) => `说明 · ${d.id} ${d.title}：${d.note}`)
                  .join('；'),
              )
            : null,

          d.notImplemented && d.notImplemented.length
            ? h(
                'div',
                { style: { marginTop: '16px' } },
                h('h3', { style: S.sectionTitle }, '未实现的维度（排期中）'),
                h(
                  'div',
                  { style: S.chips },
                  d.notImplemented.map((d) =>
                    h('span', { key: d.id, style: S.chip }, `${d.id} ${d.title}`)),
                ),
              )
            : null,

          d.unimplementable && d.unimplementable.length
            ? h(
                'div',
                { style: { marginTop: '16px' } },
                // 第二轮评估 F1：原来写「DSH 数据源缺失」—— 实测 E3/N3/N4 的数据都在日志里
                // （已实现并移出本列表），剩下的 K1/K2 是隐私取舍下的方案未定，不是平台做不到。
                h('h3', { style: S.sectionTitle }, '尚未实现的维度（原因见下，都不是"平台做不到"）'),
                h(
                  'div',
                  { style: { fontSize: '11px', color: V.text3, lineHeight: '1.8' } },
                  d.unimplementable.map((d) =>
                    h('div', { key: d.id }, `${d.id} ${d.title} —— ${d.reason}`)),
                ),
              )
            : null,

          // F16：把"被否决的处方"也显示出来 —— 面板此前只显示给出来的处方，
          // 用户无法区分"被规则挡掉"与"根本没有这条建议"。
          skippedList.length
            ? h(
                'div',
                { style: { marginTop: '16px' } },
                h('h3', { style: S.sectionTitle }, `已评估但未给出的处方（${skippedList.length}）`),
                h(
                  'div',
                  { style: { fontSize: '11px', color: V.text3, lineHeight: '1.8' } },
                  skippedList.map((s, i) =>
                    h(
                      'div',
                      { key: `${s.findingId}-${s.id}-${i}` },
                      `${s.findingId} · ${s.title}${s.current ? `（当前：${s.current}）` : ''} —— 未给出原因：${s.reason}`,
                    ),
                  ),
                ),
              )
            : null,

          d.catalog && d.catalog.recommendations && d.catalog.recommendations.length
            ? h(
                'div',
                { style: { marginTop: '20px' } },
                h(
                  'h3',
                  { style: S.sectionTitle },
                  `插件目录检索（目录 ${d.catalog.size} 条 · 本地已装 ${d.catalog.installedCount} 个）`,
                ),
                d.catalog.sources
                  ? h(
                      'div',
                      { style: S.howTo },
                      `目录来源：人工核实 ${d.catalog.sources.curated} 条 + npm 同步 ${d.catalog.sources.registry} 条` +
                        (d.catalog.sources.github
                          ? ` + GitHub 核实 ${d.catalog.sources.github} 条`
                          : '') +
                        (d.catalog.sources.snapshotAt
                          ? `（同步于 ${String(d.catalog.sources.snapshotAt).slice(0, 10)}）`
                          : '（快照未同步，可跑 ./run.sh catalog-sync）'),
                    )
                  : null,
                h(
                  'div',
                  { style: S.howTo },
                  '按「能力标签 + 关键词」检索出来的插件 —— 同一个插件只列一次，**装过的不再推荐**。',
                ),
                d.catalog.recommendations.map((hit, i) => h(CatalogRow, { key: hit.id || i, hit })),
              )
            : null,

          d.levers && d.levers.length
            ? h(
                'div',
                { style: { marginTop: '20px' } },
                h('h3', { style: S.sectionTitle }, '省 token 开关清单'),
                h(
                  'div',
                  { style: S.howTo },
                  '这是工具陈列，不是体检结论 —— 本次未触发对应指标，列出来是因为你随时可以拧它们。',
                ),
                d.levers.map((lv, i) => h(LeverRow, { key: lv.id || i, lv })),
              )
            : null,

          h(
            'div',
            { style: S.footer },
            h('span', null, d.footer),
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
            h(
              'span',
              { style: S.tag },
              live ? '只读 · 本次已联网现搜插件' : '只读 · 零外发',
            ),
            h(
              'button',
              {
                type: 'button',
                style: { ...S.iconBtn, opacity: liveBusy ? 0.55 : 1 },
                disabled: liveBusy,
                title: '按本次发现的问题，实时去 npm / GitHub 检索插件（只发送问题类型关键词）',
                onClick: runLive,
              },
              liveBusy ? '检索中…' : '联网现搜插件',
            ),
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
