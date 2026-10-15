#!/usr/bin/env node
/**
 * scripts/plugin-dom.test.mjs —— plugin/client.js 的浏览器端渲染测试（零依赖）
 *
 * 运行：node scripts/plugin-dom.test.mjs
 * 退出码 0 = 全部通过（逐条 ✓/✗，末尾汇总「通过 N · 失败 M」）
 *
 * ============================ 这个测试守什么 ============================
 *
 * plugin/client.js（约 55KB）是 DSH Web 客户端的「浏览器半」：侧边栏角标 +
 * 覆盖层面板。此前只有 Node 侧（宿主/诊断/处方层）的测试，浏览器半一行都没跑过，
 * 于是下面这类真实事故只能在用户机器上被发现：
 *
 *   - 面板现搜结果写成了 `state.live`（state 上从来没有这个字段）→ 三元恒取
 *     `state.data`，用户点「联网现搜」只有状态行变了、卡片还是旧数据。
 *     本文件用**行为断言**守住它：点按钮后渲染结果必须切换到 live 返回的整份分析，
 *     且 live 是**组件内 state**（另一个面板实例不受影响，模块级共享状态不算数）。
 *   - 无数据 / 请求失败时的降级渲染（不得抛异常、不得编造假数据）。
 *   - 角标（准实时未读数字）的更新路径与「打开面板即已读」。
 *
 * 覆盖的入口（都通过真实代码路径驱动，不 mock 业务函数）：
 *   __ModuleLoader__.load 注册 → factory(require) → exports →
 *   ClinicNavButton / ClinicPanel 的渲染、onClick、useState/useEffect/
 *   useSyncExternalStore、轮询 tick、runLive、刷新、关闭、覆盖层点击。
 *
 * ==================== 零依赖 DOM/React 桩的**能力边界** ====================
 *
 * 本文件只用 node: 内置模块。没有 jsdom、没有 npm install。因此：
 *
 *   1. client.js **本身完全不碰 document**（它只调用 React.createElement，
 *      由宿主 React 负责挂载）。所以这里的「DOM 桩」是给测试自带的
 *      **迷你 React 渲染器**用的，不是 client.js 的运行依赖。
 *   2. 迷你 React 只实现 client.js 实际用到的 4 个 API：createElement /
 *      useState / useEffect / useSyncExternalStore，并且是「整树重建 + 按
 *      路径保留 hook 槽位」的简化模型：没有 fiber、没有 reconciliation、
 *      没有 key diff、没有 memo/Suspense/StrictMode 双调用、没有 context /
 *      错误边界 / 并发渲染。React 语义层面的问题（依赖数组漏写、
 *      StrictMode 下的副作用重复执行等）**不一定**能在这里复现。
 *   3. DOM 桩没有布局与样式计算：style 只是普通对象，`var(--x, fallback)`
 *      原样保存、永不解析，getComputedStyle / offsetWidth / getBoundingClientRect
 *      全部不存在 —— **看不出**面板是否视觉错乱、错位、被遮挡。
 *   4. 没有真实事件系统：无捕获阶段选项（capture/once/passive）、无默认动作
 *      （表单提交、链接跳转、focus/blur、键盘事件）、没有真实 MouseEvent/
 *      KeyboardEvent、没有合成事件池。事件冒泡是简化实现（沿 parentNode 向上）。
 *   5. 没有 HTML 解析：innerHTML 只存字符串、不生成节点。
 *   6. 没有真实计时器：setTimeout / setInterval 被替换为「记录但不触发」的桩，
 *      因此 6 秒轮询的真实节奏、CopyButton 的 1.4 秒「已复制」复位
 *      都**没有被验证**（轮询由测试手动驱动 tick）。
 *   7. 没有真实网络：fetch 是预设响应的桩，无 HTTP、CORS、流式、AbortSignal、
 *      无响应头语义、无并发/竞态。
 *   8. 没有剪贴板 / Selection / localStorage / history / WebSocket /
 *      MutationObserver / Shadow DOM / iframe / 无障碍树。
 *
 * ⚠️ **不要以为通过这个文件就等于「在真实浏览器里验证过」。** 它验证的是
 *    「组件在给定 props/状态下的输出结构与状态机」，不是像素、不是 CSS、
 *    不是真实 React 运行时。真实浏览器回归仍需要人工打开面板确认。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLIENT_PATH = path.join(__dirname, '..', 'plugin', 'client.js');
const CLIENT_SRC = fs.readFileSync(CLIENT_PATH, 'utf8');

// ===========================================================================
// 0) 断言框架（与 scripts/smoke.mjs 的输出风格一致）
// ===========================================================================
let pass = 0;
let fail = 0;
const failures = [];

function check(name, cond, detail = '') {
  if (cond) {
    pass += 1;
    process.stdout.write(`  ✓ ${name}${detail ? `  ${detail}` : ''}\n`);
  } else {
    fail += 1;
    failures.push(name);
    process.stdout.write(`  ✗ ${name}${detail ? `  ${detail}` : ''}\n`);
  }
}

function section(title) {
  process.stdout.write(`\n${title}\n`);
}

// ===========================================================================
// 1) 极简 DOM 桩
// ===========================================================================

class StubEvent {
  constructor(type, init = {}) {
    this.type = type;
    this.target = null;
    this.currentTarget = null;
    this.defaultPrevented = false;
    this._stopped = false;
    Object.assign(this, init);
  }
  preventDefault() {
    this.defaultPrevented = true;
  }
  stopPropagation() {
    this._stopped = true;
  }
}

class StubNode {
  constructor(ownerDocument, nodeType, nodeName) {
    this.ownerDocument = ownerDocument;
    this.nodeType = nodeType;
    this.nodeName = nodeName;
    this.parentNode = null;
    this.childNodes = [];
    this._listeners = new Map();
    this._attrs = new Map();
    this._id = '';
  }
  get children() {
    return this.childNodes.filter((n) => n.nodeType === 1);
  }
  get childElementCount() {
    return this.children.length;
  }
  get firstChild() {
    return this.childNodes[0] || null;
  }
  get lastChild() {
    return this.childNodes[this.childNodes.length - 1] || null;
  }
  get nextSibling() {
    if (!this.parentNode) return null;
    const i = this.parentNode.childNodes.indexOf(this);
    return this.parentNode.childNodes[i + 1] || null;
  }
  appendChild(node) {
    if (node.parentNode) node.parentNode.removeChild(node);
    this.childNodes.push(node);
    node.parentNode = this;
    return node;
  }
  append(...nodes) {
    for (const n of nodes) this.appendChild(n);
  }
  insertBefore(node, ref) {
    if (!ref) return this.appendChild(node);
    if (node.parentNode) node.parentNode.removeChild(node);
    const i = this.childNodes.indexOf(ref);
    this.childNodes.splice(i < 0 ? this.childNodes.length : i, 0, node);
    node.parentNode = this;
    return node;
  }
  removeChild(node) {
    const i = this.childNodes.indexOf(node);
    if (i >= 0) {
      this.childNodes.splice(i, 1);
      node.parentNode = null;
    }
    return node;
  }
  remove() {
    if (this.parentNode) this.parentNode.removeChild(this);
  }
  replaceChildren(...nodes) {
    for (const c of this.childNodes) c.parentNode = null;
    this.childNodes = [];
    this.append(...nodes);
  }
  contains(node) {
    if (node === this) return true;
    return this.childNodes.some((c) => c.contains && c.contains(node));
  }
  addEventListener(type, fn) {
    if (typeof fn !== 'function') return;
    if (!this._listeners.has(type)) this._listeners.set(type, []);
    this._listeners.get(type).push(fn);
  }
  removeEventListener(type, fn) {
    const ls = this._listeners.get(type);
    if (!ls) return;
    const i = ls.indexOf(fn);
    if (i >= 0) ls.splice(i, 1);
  }
  /** 简化冒泡：沿 parentNode 向上，最后补上 document 与 window。 */
  dispatchEvent(ev) {
    if (!ev || !ev.type) throw new Error('dispatchEvent 需要一个事件对象');
    if (!ev.target) ev.target = this;
    const pathNodes = [];
    let n = this;
    while (n) {
      pathNodes.push(n);
      n = n.parentNode;
    }
    if (this.ownerDocument && !pathNodes.includes(this.ownerDocument)) pathNodes.push(this.ownerDocument);
    const win = globalThis.window;
    if (win && !pathNodes.includes(win)) pathNodes.push(win);
    for (const node of pathNodes) {
      const ls = node._listeners && node._listeners.get(ev.type);
      if (!ls || !ls.length) continue;
      ev.currentTarget = node;
      for (const fn of ls.slice()) {
        fn.call(node, ev);
        if (ev._stopped) return !ev.defaultPrevented;
      }
    }
    return !ev.defaultPrevented;
  }
  click() {
    return this.dispatchEvent(new StubEvent('click'));
  }
  setAttribute(name, value) {
    const v = String(value);
    this._attrs.set(name, v);
    if (name === 'id') this._id = v;
    else if (name === 'class') this.className = v;
    else if (name === 'disabled') this.disabled = true;
    else if (name === 'title') this.title = v;
    else if (name === 'type') this.type = v;
  }
  getAttribute(name) {
    if (this._attrs.has(name)) return this._attrs.get(name);
    if (name === 'id') return this._id || null;
    if (name === 'class') return this.className || null;
    if (name === 'title') return this.title ?? null;
    if (name === 'type') return this.type ?? null;
    return null;
  }
  hasAttribute(name) {
    return this.getAttribute(name) !== null;
  }
  removeAttribute(name) {
    this._attrs.delete(name);
  }
  get textContent() {
    let s = '';
    for (const c of this.childNodes) s += c.textContent;
    return s;
  }
  set textContent(v) {
    this.replaceChildren();
    this.appendChild(this.ownerDocument.createTextNode(String(v)));
  }
  get id() {
    return this._id || '';
  }
  set id(v) {
    this._id = String(v);
  }
  querySelector(sel) {
    return this.querySelectorAll(sel)[0] || null;
  }
  querySelectorAll(sel) {
    const groups = parseSelector(String(sel));
    const out = [];
    const walk = (node) => {
      for (const c of node.childNodes) {
        if (c.nodeType !== 1) continue;
        if (groups.some((parts) => matchesComplex(c, parts))) out.push(c);
        walk(c);
      }
    };
    walk(this);
    return out;
  }
  matches(sel) {
    return parseSelector(String(sel)).some((parts) => matchesComplex(this, parts));
  }
  closest(sel) {
    let n = this;
    while (n) {
      if (n.nodeType === 1 && n.matches(sel)) return n;
      n = n.parentNode;
    }
    return null;
  }
}

class StubText extends StubNode {
  constructor(doc, data) {
    super(doc, 3, '#text');
    this.data = String(data);
  }
  get textContent() {
    return this.data;
  }
  set textContent(v) {
    this.data = String(v);
  }
}

class StubElement extends StubNode {
  constructor(doc, tagName) {
    super(doc, 1, String(tagName).toUpperCase());
    this.tagName = this.nodeName;
    this.style = {};
    this.dataset = {};
    this.className = '';
    this.disabled = false;
  }
  get classList() {
    const node = this;
    const read = () => node.className.split(/\s+/).filter(Boolean);
    const write = (arr) => {
      node.className = arr.join(' ');
    };
    return {
      add: (...n) => write([...new Set([...read(), ...n])]),
      remove: (...n) => write(read().filter((x) => !n.includes(x))),
      contains: (n) => read().includes(n),
      toggle: (n, force) => {
        const has = read().includes(n);
        const want = force === undefined ? !has : Boolean(force);
        if (want && !has) write([...read(), n]);
        if (!want && has) write(read().filter((x) => x !== n));
        return want;
      },
      toString: () => node.className,
    };
  }
  get innerHTML() {
    return this._innerHTML ?? '';
  }
  set innerHTML(v) {
    // 能力边界：不解析 HTML，只记字符串并清空子节点（无 HTML 解析器）
    this._innerHTML = String(v);
    this.replaceChildren();
  }
}

class StubDocument extends StubNode {
  constructor() {
    super(null, 9, '#document');
    this.ownerDocument = this;
    this.documentElement = new StubElement(this, 'html');
    this.head = new StubElement(this, 'head');
    this.body = new StubElement(this, 'body');
    this.appendChild(this.documentElement);
    this.documentElement.appendChild(this.head);
    this.documentElement.appendChild(this.body);
  }
  createElement(tag) {
    return new StubElement(this, String(tag).toLowerCase());
  }
  createTextNode(data) {
    return new StubText(this, data);
  }
  getElementById(id) {
    return this.querySelector(`#${id}`);
  }
}

class StubWindow extends StubNode {
  constructor(doc) {
    super(null, 0, '#window');
    this.document = doc;
    this.location = { href: 'http://127.0.0.1:19387/', origin: 'http://127.0.0.1:19387', pathname: '/', search: '' };
    this.navigator = { userAgent: 'plugin-dom.test.mjs (零依赖 DOM 桩)', clipboard: null };
  }
}

// --- 极简选择器引擎：tag / #id / .class / [attr] / [attr="v"] / 逗号 + 后代 ---

function splitComplex(sel) {
  const parts = [];
  let cur = '';
  let depth = 0;
  for (const ch of sel) {
    if (ch === '[') depth += 1;
    else if (ch === ']') depth = Math.max(0, depth - 1);
    if (/\s/.test(ch) && depth === 0) {
      if (cur) parts.push(cur);
      cur = '';
      continue;
    }
    cur += ch;
  }
  if (cur) parts.push(cur);
  return parts;
}

function parseSimple(s) {
  const m = { tag: null, id: null, classes: [], attrs: [] };
  const re = /([a-zA-Z][\w-]*)|#([\w-]+)|\.([\w-]+)|\[([\w-]+)(?:([~^$*|]?=)"?([^"\]]*)"?)?\]|\*/g;
  let mm;
  while ((mm = re.exec(s))) {
    if (mm[1]) m.tag = mm[1].toLowerCase();
    else if (mm[2]) m.id = mm[2];
    else if (mm[3]) m.classes.push(mm[3]);
    else if (mm[4]) m.attrs.push({ name: mm[4], op: mm[5] || null, value: mm[6] ?? null });
  }
  return m;
}

function parseSelector(sel) {
  return sel
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => splitComplex(s).map(parseSimple));
}

function matchesSimple(node, m) {
  if (node.nodeType !== 1) return false;
  if (m.tag && node.tagName.toLowerCase() !== m.tag) return false;
  if (m.id && node.id !== m.id) return false;
  for (const c of m.classes) if (!node.classList.contains(c)) return false;
  for (const a of m.attrs) {
    const v = node.getAttribute(a.name);
    if (v === null) return false;
    if (!a.op) continue;
    if (a.op === '=' && v !== a.value) return false;
    if (a.op === '^=' && !v.startsWith(a.value)) return false;
    if (a.op === '$=' && !v.endsWith(a.value)) return false;
    if (a.op === '*=' && !v.includes(a.value)) return false;
  }
  return true;
}

function matchesComplex(node, parts) {
  if (!matchesSimple(node, parts[parts.length - 1])) return false;
  let i = parts.length - 2;
  let cur = node.parentNode;
  while (i >= 0 && cur) {
    if (cur.nodeType === 1 && matchesSimple(cur, parts[i])) i -= 1;
    cur = cur.parentNode;
  }
  return i < 0;
}

function text(node) {
  return node ? node.textContent : '';
}

// ===========================================================================
// 2) 极简 React 桩 + 整树渲染器（只实现 client.js 用到的 4 个 API）
// ===========================================================================

const renderErrors = [];

function flatten(child, out) {
  if (Array.isArray(child)) {
    for (const c of child) flatten(c, out);
  } else {
    out.push(child);
  }
}

function makeReact() {
  const React = {};
  React.createElement = function (type, props, ...children) {
    const p = Object.assign({}, props || {});
    const kids = [];
    for (const c of children) flatten(c, kids);
    p.children = kids;
    return { __el: true, type, props: p };
  };

  /** 取当前组件实例的第 i 个 hook 槽位（按调用顺序，与 React 规则一致） */
  function slotAt(kind, make) {
    const ctx = currentCtx;
    if (!ctx) throw new Error('hook 只能在组件渲染期间调用');
    const inst = ctx.inst;
    const i = inst.cursor;
    inst.cursor += 1;
    let slot = inst.hooks[i];
    if (!slot || slot.kind !== kind) {
      slot = make();
      slot.kind = kind;
      inst.hooks[i] = slot;
    }
    return { slot, ctx };
  }

  React.useState = function (init) {
    const { slot, ctx } = slotAt('state', () => ({
      value: typeof init === 'function' ? init() : init,
    }));
    const setState = (next) => {
      const value = typeof next === 'function' ? next(slot.value) : next;
      if (Object.is(value, slot.value)) return;
      slot.value = value;
      ctx.root.scheduleRender();
    };
    return [slot.value, setState];
  };

  React.useEffect = function (fn, deps) {
    const { slot, ctx } = slotAt('effect', () => ({ deps: undefined, cleanup: null, fn }));
    slot.fn = fn;
    ctx.pass.effects.push({ slot, deps });
  };

  React.useSyncExternalStore = function (subscribe, getSnapshot) {
    const { slot, ctx } = slotAt('sync', () => ({ subscribed: false, unsub: null }));
    if (!slot.subscribed) {
      slot.subscribed = true;
      slot.unsub = subscribe(() => ctx.root.scheduleRender());
    }
    return getSnapshot();
  };

  React.useRef = function (value) {
    const { slot } = slotAt('ref', () => ({ value }));
    return slot;
  };

  return React;
}

let currentCtx = null;

function applyProps(node, props) {
  for (const k of Object.keys(props)) {
    if (k === 'children' || k === 'key' || k === 'ref') continue;
    const v = props[k];
    if (k === 'style') {
      node.style = Object.assign({}, v);
      continue;
    }
    if (k === 'className') {
      node.className = v == null ? '' : String(v);
      continue;
    }
    if (k === 'dataset') {
      node.dataset = Object.assign({}, v);
      continue;
    }
    if (/^on[A-Z]/.test(k)) {
      if (typeof v === 'function') node.addEventListener(k.slice(2).toLowerCase(), v);
      continue;
    }
    if (v === null || v === undefined) continue;
    if (k === 'disabled') {
      node.disabled = Boolean(v);
      if (v) node.setAttribute('disabled', 'disabled');
      continue;
    }
    if (k === 'value' || k === 'checked') {
      node[k] = v;
      continue;
    }
    node.setAttribute(k, v === true ? 'true' : String(v));
  }
}

function clearChildren(node) {
  for (const c of node.childNodes) c.parentNode = null;
  node.childNodes = [];
}

function cleanupInstance(inst) {
  for (const slot of inst.hooks) {
    if (!slot) continue;
    if (slot.kind === 'effect' && typeof slot.cleanup === 'function') {
      try {
        slot.cleanup();
      } catch (e) {
        renderErrors.push(e);
      }
      slot.cleanup = null;
    }
    if (slot.kind === 'sync' && typeof slot.unsub === 'function') {
      try {
        slot.unsub();
      } catch (e) {
        renderErrors.push(e);
      }
      slot.unsub = null;
      slot.subscribed = false;
    }
  }
}

function runEffects(effects) {
  for (const e of effects) {
    const { slot, deps } = e;
    const changed =
      !slot.deps ||
      !deps ||
      deps.length !== slot.deps.length ||
      deps.some((v, i) => !Object.is(v, slot.deps[i]));
    if (!changed) continue;
    if (typeof slot.cleanup === 'function') {
      try {
        slot.cleanup();
      } catch (err) {
        renderErrors.push(err);
      }
      slot.cleanup = null;
    }
    slot.deps = deps ? deps.slice() : deps;
    try {
      const c = slot.fn();
      slot.cleanup = typeof c === 'function' ? c : null;
    } catch (err) {
      renderErrors.push(err);
    }
  }
}

function createRoot(doc, container) {
  const instances = new Map();
  let rootEl = null;
  let dirty = false;
  let rendering = false;
  let api = null;

  function scheduleRender() {
    if (rendering) {
      dirty = true;
      return;
    }
    renderPass();
  }

  function renderNode(el, parentDom, key, pass) {
    if (el === null || el === undefined || typeof el === 'boolean') return;
    if (Array.isArray(el)) {
      for (let i = 0; i < el.length; i += 1) renderNode(el[i], parentDom, `${key}.${i}`, pass);
      return;
    }
    if (typeof el === 'string' || typeof el === 'number') {
      parentDom.appendChild(doc.createTextNode(String(el)));
      return;
    }
    if (typeof el !== 'object' || !el.__el) return;
    const { type, props } = el;
    const keyPart =
      props.key !== undefined && props.key !== null ? `@${String(props.key)}` : `#${String(type)}`;
    const childKey = `${key}/${keyPart}`;

    if (typeof type === 'function') {
      let inst = instances.get(childKey);
      if (!inst) {
        inst = { hooks: [], key: childKey, cursor: 0 };
        instances.set(childKey, inst);
      }
      pass.visited.add(childKey);
      const prev = currentCtx;
      currentCtx = { inst, pass, root: api };
      inst.cursor = 0;
      let out = null;
      try {
        out = type(props);
      } catch (err) {
        renderErrors.push(err); // 渲染期异常不炸掉测试进程，交给断言观察
      } finally {
        currentCtx = prev;
      }
      renderNode(out, parentDom, childKey, pass);
      return;
    }

    const node = doc.createElement(type);
    applyProps(node, props);
    parentDom.appendChild(node);
    const kids = props.children || [];
    for (let i = 0; i < kids.length; i += 1) renderNode(kids[i], node, `${childKey}>${i}`, pass);
  }

  function renderPass() {
    let guard = 0;
    do {
      dirty = false;
      rendering = true;
      const pass = { effects: [], visited: new Set() };
      clearChildren(container);
      renderNode(rootEl, container, 'r', pass);
      for (const [k, inst] of [...instances]) {
        if (!pass.visited.has(k)) {
          cleanupInstance(inst);
          instances.delete(k);
        }
      }
      runEffects(pass.effects);
      rendering = false;
      guard += 1;
    } while (dirty && guard < 200);
    if (guard >= 200) renderErrors.push(new Error('渲染未收敛：疑似无限 setState 循环'));
  }

  api = {
    container,
    render(el) {
      rootEl = el;
      renderPass();
    },
    scheduleRender,
    get instances() {
      return instances;
    },
  };
  return api;
}

// ===========================================================================
// 3) 全局环境桩
// ===========================================================================

const intervals = [];
const timeouts = [];
const copied = [];

const REACT = makeReact();

/** Node 24 的 globalThis.navigator 只有 getter，必须用 defineProperty 覆盖。 */
function setNavigator(value) {
  Object.defineProperty(globalThis, 'navigator', { value, configurable: true, writable: true });
}

function installGlobals(doc, win) {
  globalThis.document = doc;
  globalThis.window = win;
  setNavigator({ userAgent: 'test', clipboard: { writeText: (t) => (copied.push(t), Promise.resolve()) } });
  globalThis.setInterval = (fn, ms) => {
    intervals.push({ fn, ms, alive: true });
    return intervals.length;
  };
  globalThis.clearInterval = (id) => {
    const it = intervals[id - 1];
    if (it) it.alive = false;
  };
  globalThis.setTimeout = (fn, ms) => {
    timeouts.push({ fn, ms });
    return timeouts.length;
  };
}

const world = {
  report: null,
  reportError: null,
  live: null,
  liveError: null,
  // 真实宿主的首个 /watch 响应签名必然非空（否则客户端永远不建立基线）
  watch: { ok: true, version: '14', count: 1, ids: ['C1'], signature: 'sig-1', generatedAt: 't' },
  calls: [],
};

function jsonRes(payload) {
  return {
    ok: true,
    status: 200,
    headers: { get: () => 'application/json' },
    json: () => Promise.resolve(payload),
    text: () => Promise.resolve(typeof payload === 'string' ? payload : JSON.stringify(payload)),
  };
}

function installFetch() {
  globalThis.fetch = function fetchStub(url, opts) {
    const u = String(url);
    world.calls.push({ url: u, opts: opts || null });
    if (u.endsWith('/report')) {
      if (world.reportError) return Promise.reject(new Error(world.reportError));
      return Promise.resolve(jsonRes(world.report));
    }
    if (u.endsWith('/live')) {
      if (world.liveError) return Promise.reject(new Error(world.liveError));
      return Promise.resolve(jsonRes(world.live));
    }
    if (u.endsWith('/watch')) return Promise.resolve(jsonRes(world.watch));
    return Promise.reject(new Error(`未知端点：${u}`));
  };
}

function resetWorld(overrides = {}) {
  world.report = { ok: true, version: '14', generatedAt: '2026-10-16T00:00:00.000Z', report: '# 合成报告文本', data: makeData('A') };
  world.reportError = null;
  world.live = null;
  world.liveError = null;
  world.watch = { ok: true, version: '14', count: 1, ids: ['C1'], signature: 'sig-1', generatedAt: 't' };
  world.calls = [];
  copied.length = 0;
  intervals.length = 0;
  timeouts.length = 0;
  renderErrors.length = 0;
  Object.assign(world, overrides);
}

/** 装载 client.js：捕获 __ModuleLoader__.load 并实例化 factory */
function loadClient() {
  const captured = [];
  globalThis.window.__ModuleLoader__ = { load: (m) => captured.push(m) };
  new Function(CLIENT_SRC)(); // eslint-disable-line no-new-func
  if (captured.length !== 1) throw new Error(`期望捕获 1 个模块，实际 ${captured.length} 个`);
  const descriptor = captured[0];
  const mod = descriptor.factory((name) => {
    if (name === 'react') return REACT;
    throw new Error(`未知模块请求：${name}`);
  });
  return { descriptor, mod };
}

function mountClient() {
  const doc = new StubDocument();
  const win = new StubWindow(doc);
  installGlobals(doc, win);
  installFetch();
  const { descriptor, mod } = loadClient();
  const container = doc.body;
  const root = createRoot(doc, container);
  root.render([REACT.createElement(mod.ClinicNavButton, {}), REACT.createElement(mod.ClinicPanel, {})]);
  return { doc, win, container, root, mod, descriptor };
}

const flush = () => new Promise((r) => setImmediate(r));

const firstButton = (container) => container.querySelector('button');
const buttonByText = (container, label) =>
  container.querySelectorAll('button').find((b) => text(b) === label) || null;
const has = (node, s) => text(node).includes(s);

/** 打开面板：点侧边栏角标按钮（真实路径，非直接改内部状态） */
function openPanel(container) {
  firstButton(container).click();
}

/** 轮询 tick：useClinicWatcher 通过 setInterval 注册，这里手动驱动 */
function tickWatcher(nth = 0) {
  const live = intervals.filter((i) => i.alive);
  const it = live[nth];
  if (!it) throw new Error('没有可用的轮询 interval，watcher 未注册');
  return it.fn();
}

// ===========================================================================
// 4) 合成数据（形状对齐 src/report.mjs 的 analyze() 返回）
// ===========================================================================

function rx(tag, n) {
  const isConfig = n === 1;
  return {
    targetId: `rx-${n}`,
    kind: isConfig ? 'config' : 'command',
    kindLabel: isConfig ? '改配置' : '跑命令',
    title: `【${tag}】处方 ${n}`,
    detail: `${tag} 详情第一行\n${tag} 详情第二行`,
    brief: `【${tag}】处方 ${n} 的一句话结论`,
    steps: [`【${tag}】步骤一`, `【${tag}】步骤二`, `【${tag}】步骤三`],
    command: isConfig ? '- id: spill-policy\n  config:\n    maxInlineTokens: 6000' : `agent-clinic show "${tag}#L1"`,
    because: `【${tag}】依据`,
    risk: `【${tag}】风险`,
    verify: `【${tag}】怎么确认有效`,
    source: `【${tag}】出处`,
    sourceVia: '人工核实',
    findingId: 'C1',
    action: isConfig
      ? { type: 'config', file: 'C:/home/.dsh/profiles/x/cordis.patch.yml', snippet: '- id: spill-policy\n  config:\n    maxInlineTokens: 6000' }
      : { type: 'command' },
  };
}

function makeData(tag) {
  return {
    header: {
      platform: 'DSH',
      sessions: tag === 'A' ? 3 : 7,
      lines: 100,
      toolCalls: tag === 'A' ? 120 : 340,
      errorRate: tag === 'A' ? 0.05 : 0.11,
      inputTokens: tag === 'A' ? 1000 : 2000,
      outputTokens: 250,
      cacheReadTokens: 375,
      cacheWriteTokens: 0,
      badFrames: 0,
      badLines: 0,
    },
    findings: [{ id: 'C1', title: `【${tag}】token 消耗过快`, severity: '高', summary: `【${tag}】finding 摘要`, evidence: [{ locator: 'C:/x/session.v4.jsonl.zstd#L9' }] }],
    groups: [
      {
        id: 'C1',
        title: `【${tag}】token 消耗过快`,
        category: 'C',
        severity: '高',
        count: 2,
        sessions: ['session-aaaa1111', 'session-bbbb2222'],
        tools: ['read', 'grep'],
        summary: `【${tag}】聚合结论`,
        impact: `【${tag}】影响估算`,
        confidence: 0.9,
        instances: [
          { scope: 'session-aaaa1111', summary: `【${tag}】第 1 处`, impact: '', evidence: [{ locator: 'C:/x/dl/session.v4.jsonl.zstd#L42' }] },
          { scope: 'session-bbbb2222', summary: `【${tag}】第 2 处`, impact: '', evidence: [{ locator: 'C:/x/dl/session.v4.jsonl.zstd#L77' }] },
        ],
        prescriptions: [rx(tag, 1)],
        skippedPrescriptions: [{ id: 's1', title: `【${tag}】被否决的处方`, reason: '当前值已足够', current: 'low' }],
      },
    ],
    prescriptions: [rx(tag, 1), rx(tag, 2)],
    prescriptionsOmitted: 0,
    prescriptionsPoolSize: 2,
    notDetected: [
      { id: 'A3', title: '开关闲置', note: null },
      { id: 'E4', title: '重复读取', note: `【${tag}】本机无该数据` },
    ],
    notImplemented: [{ id: 'N9', title: `【${tag}】排期中的维度` }],
    unimplementable: [{ id: 'K1', title: '隐私取舍', reason: '方案未定' }],
    levers: [
      {
        id: 'lev1',
        kind: 'config',
        kindLabel: '改配置',
        title: `【${tag}】spill 预算`,
        current: '8000',
        suggested: '6000',
        solves: `【${tag}】省 input`,
        steps: ['打开 cordis.patch.yml', '整段替换 spill-policy', '重启 Harness'],
        snippet: '- id: spill-policy\n  config:\n    maxInlineTokens: 6000',
        risk: '低',
        source: '随附默认值',
      },
    ],
    catalog: {
      version: 1,
      size: 5,
      sources: { curated: 5, registry: 2, github: 1, snapshotAt: '2026-10-16T00:00:00.000Z', live: null },
      installedCount: 1,
      installed: ['installed-plugin'],
      installedDir: 'C:/home/.dsh/profiles/x',
      error: null,
      offDomainFiltered: [],
      recommendations: [
        {
          id: 'npm:demo-pack',
          package: 'demo-pack',
          displayName: `Demo ${tag} 插件`,
          summary: `【${tag}】插件简介`,
          summaryLang: 'zh',
          capabilities: ['token-saving'],
          capabilityEvidence: [{ cap: 'token-saving', matched: '压缩' }],
          repo: 'https://example.invalid/demo-pack',
          install: { gui: '侧边栏 → 插件', cli: 'dsh plugin add demo-pack' },
          risk: '未审阅源码',
          origin: 'npm-registry',
          verifiedAt: '2026-10-16',
          installed: false,
          kindText: '社区包',
          heatText: '★ 12',
          findingIds: ['C1'],
          reasons: [`【${tag}】命中原因`],
        },
        {
          id: 'curated:already',
          package: 'installed-plugin',
          displayName: `已装的 ${tag}`,
          summary: `【${tag}】已装条目`,
          capabilities: ['long-session'],
          capabilityEvidence: [],
          origin: 'curated',
          installed: true,
          kindText: '人工核实',
          findingIds: [],
          reasons: [],
        },
        {
          id: 'gh:demo/gh',
          package: 'demo-gh',
          displayName: `GH ${tag}`,
          summary: `【${tag}】GitHub 条目`,
          capabilities: ['cost'],
          capabilityEvidence: [{ cap: 'cost', matched: '费用' }],
          origin: 'github',
          installed: false,
          kindText: '官方内置包',
          heatText: '★ 3',
          findingIds: ['C1'],
          reasons: [`【${tag}】GitHub 命中`],
        },
      ],
      matches: [],
    },
    config: { patchPath: 'C:/home/.dsh/profiles/x/cordis.patch.yml', patchExists: true, warnings: [] },
    footer: `【${tag}】页脚 · 零外发`,
  };
}

function makeLivePayload(tag) {
  return {
    ok: true,
    version: '14',
    generatedAt: '2026-10-16T00:00:00.000Z',
    live: {
      networked: true,
      elapsedMs: 1234,
      stats: { kept: 4 },
      sent: ['死循环 插件', 'token 压缩 dsh 插件'],
      degraded: false,
      errors: [],
    },
    data: makeData(tag),
  };
}

// ===========================================================================
// 开始
// ===========================================================================

process.stdout.write('\nagent-clinic 面板渲染测试（零依赖 DOM 桩）\n==========================================\n');

// --- A. 模块装载 ---------------------------------------------------------
section('A) 客户端模块装载');
{
  const doc = new StubDocument();
  const win = new StubWindow(doc);
  installGlobals(doc, win);
  installFetch();
  let captured = 0;
  let err = null;
  let descriptor = null;
  try {
    const cap = [];
    globalThis.window.__ModuleLoader__ = { load: (m) => cap.push(m) };
    new Function(CLIENT_SRC)(); // eslint-disable-line no-new-func
    captured = cap.length;
    descriptor = cap[0] || null;
  } catch (e) {
    err = e.message;
  }
  check('client.js 入口可执行并调用 __ModuleLoader__.load', err === null && captured === 1, err ? `异常=${err}` : `捕获模块数=${captured}`);
  check('模块 id 与包名一致（等于 agent-clinic）', descriptor && descriptor.id === 'agent-clinic', `id=${descriptor ? descriptor.id : '(无)'}`);

  let mod = null;
  let fErr = null;
  try {
    mod = descriptor.factory((n) => {
      if (n === 'react') return REACT;
      throw new Error(`未知模块请求：${n}`);
    });
  } catch (e) {
    fErr = e.message;
  }
  check(
    '工厂可实例化并导出 ClinicPanel / ClinicNavButton / apply / inject',
    Boolean(mod) && typeof mod.ClinicPanel === 'function' && typeof mod.ClinicNavButton === 'function' && typeof mod.apply === 'function' && Array.isArray(mod.inject),
    fErr ? `异常=${fErr}` : `导出=${mod ? Object.keys(mod).join(',') : '(无)'}`,
  );
}

// --- B. 面板关键区块渲染 -------------------------------------------------
section('B) 面板渲染关键区块（①）');
{
  resetWorld();
  const env = mountClient();
  openPanel(env.container);

  const reportCalls = world.calls.filter((c) => c.url.endsWith('/report'));
  check(
    '打开面板后请求 /api/agent-clinic/report（带 accept: application/json）',
    reportCalls.length === 1 && reportCalls[0].opts && reportCalls[0].opts.headers && reportCalls[0].opts.headers.accept === 'application/json',
    `report 请求数=${reportCalls.length} accept=${reportCalls[0] ? JSON.stringify(reportCalls[0].opts.headers) : '(无)'}`,
  );
  check('加载中先渲染进度提示（不是空白）', has(env.container, '正在读取本地会话并生成体检报告'), `实际文本长度=${text(env.container).length}`);

  await flush();
  const t = text(env.container);

  check('渲染出面板标题与「只读 · 零外发」标注', t.includes('Agent 体检报告') && t.includes('只读 · 零外发'), `含标题=${t.includes('Agent 体检报告')} 含零外发=${t.includes('只读 · 零外发')}`);
  check(
    '渲染出 header 统计（会话/工具调用/错误率/input/output/cacheRead）',
    ['会话', '工具调用', '错误率', 'input', 'output', 'cacheRead'].every((k) => t.includes(k)) && t.includes('5.0%') && t.includes('1,000'),
    `含 5.0%=${t.includes('5.0%')} 含 1,000=${t.includes('1,000')}`,
  );
  check(
    '渲染出「发现 1 类问题（共 2 处 · 按严重度排序）」',
    t.includes('发现 1 类问题') && t.includes('共 2 处'),
    `含 发现 1 类问题=${t.includes('发现 1 类问题')}`,
  );

  const firstCard = env.container.querySelectorAll('[role="button"]')[0];
  check(
    '问题卡（收起态）含严重度徽标、id+title、处方条数',
    Boolean(firstCard) && text(firstCard).includes('高') && text(firstCard).includes('【A】token 消耗过快') && text(firstCard).includes('处方 1'),
    `卡片文本=${firstCard ? text(firstCard).replace(/\s+/g, ' ').slice(0, 90) : '(未找到 role=button)'}`,
  );

  firstCard.click();
  const t2 = text(env.container);
  check(
    '展开问题卡后渲染出每一处的会话与证据定位符',
    // 会话 id 在客户端被 strip 掉 'session-' 前缀并截断到 12 字符，这里断言真实渲染结果
    t2.includes('具体是哪几处（2）') && t2.includes('aaaa1111') && t2.includes('C:/x/dl/session.v4.jsonl.zstd#L42'),
    `含处数标题=${t2.includes('具体是哪几处（2）')} 含截断会话名=${t2.includes('aaaa1111')} 含定位符=${t2.includes('C:/x/dl/session.v4.jsonl.zstd#L42')}`,
  );
  check(
    '展开问题卡后渲染出该问题的处方卡（kindLabel + title）',
    t2.includes('这个问题的处方与建议（1 条') && t2.includes('改配置') && t2.includes('【A】处方 1'),
    `含处方卡=${t2.includes('【A】处方 1')}`,
  );
  check(
    '展开问题卡后披露被否决的处方与聚合结论/影响',
    t2.includes('已否决的处方：') && t2.includes('【A】被否决的处方') && t2.includes('【A】聚合结论') && t2.includes('影响：【A】影响估算'),
    `含否决披露=${t2.includes('已否决的处方：')}`,
  );

  check(
    '渲染出全局处方区（标题 + 配置类处方改的文件路径）',
    t2.includes('处方：最该先做的 2 条') && t2.includes('配置类处方改的是：') && t2.includes('C:/home/.dsh/profiles/x/cordis.patch.yml'),
    `含处方区=${t2.includes('处方：最该先做的 2 条')} 含配置文件=${t2.includes('配置类处方改的是：')}`,
  );
  // 处方卡的「片段/分步指引/依据」都在展开态：点开它（真实折叠交互路径）
  const rxHead = env.container
    .querySelectorAll('[role="button"]')
    .find((b) => text(b).includes('【A】处方 1') && text(b).includes('改配置'));
  check('存在可展开的处方卡（收起态给出一行结论）', Boolean(rxHead), `找到=${rxHead ? text(rxHead).replace(/\s+/g, ' ').slice(0, 60) : '(未找到)'}`);
  if (rxHead) rxHead.click();
  const t2b = text(env.container);
  check(
    '展开处方卡后渲染出分步指引、可粘贴片段与文件指示、依据/风险/验证/出处',
    t2b.includes('具体怎么做') &&
      t2b.includes('【A】步骤一') &&
      t2b.includes('maxInlineTokens: 6000') &&
      t2b.includes('改这份文件（只给片段，不代你改）') &&
      t2b.includes('依据：【A】依据') &&
      t2b.includes('风险：【A】风险') &&
      t2b.includes('怎么确认有效：【A】怎么确认有效') &&
      t2b.includes('出处：【A】出处 · 人工核实'),
    `含步骤=${t2b.includes('【A】步骤一')} 含片段=${t2b.includes('maxInlineTokens: 6000')} 含依据=${t2b.includes('依据：【A】依据')}`,
  );
  check(
    '渲染出「未检测到异常的维度」chips 与 note 说明行',
    t2.includes('未检测到异常的维度') && t2.includes('A3 开关闲置') && t2.includes('E4 重复读取') && t2.includes('说明 · E4 重复读取：【A】本机无该数据'),
    `含 E4=${t2.includes('E4 重复读取')}`,
  );
  check('渲染出「未实现的维度（排期中）」', t2.includes('未实现的维度（排期中）') && t2.includes('N9 【A】排期中的维度'), `含 N9=${t2.includes('N9 【A】排期中的维度')}`);
  check('渲染出「尚未实现的维度」及原因', t2.includes('尚未实现的维度') && t2.includes('K1 隐私取舍 —— 方案未定'), `含 K1=${t2.includes('K1 隐私取舍')}`);
  check(
    '渲染出「已评估但未给出的处方」披露（F16）',
    t2.includes('已评估但未给出的处方（1）') && t2.includes('C1 · 【A】被否决的处方（当前：low） —— 未给出原因：当前值已足够'),
    `含 C1 披露=${t2.includes('已评估但未给出的处方（1）')}`,
  );
  check(
    '渲染出插件目录检索：区标题/来源统计 + 折叠态徽标（可装/已装/npm 同步/GitHub 核实/官方内置包）',
    t2.includes('插件目录检索（目录 5 条 · 本地已装 1 个）') &&
      t2.includes('目录来源：人工核实 5 条 + npm 同步 2 条 + GitHub 核实 1 条') &&
      t2.includes('可装') &&
      t2.includes('已装') &&
      t2.includes('npm 同步') &&
      t2.includes('GitHub 核实') &&
      t2.includes('官方内置包'),
    `含区标题=${t2.includes('插件目录检索（目录 5 条 · 本地已装 1 个）')} 含来源统计=${t2.includes('目录来源：人工核实 5 条 + npm 同步 2 条 + GitHub 核实 1 条')} 含 可装=${t2.includes('可装')} 含 已装=${t2.includes('已装')} 含 npm 同步=${t2.includes('npm 同步')} 含 GitHub 核实=${t2.includes('GitHub 核实')} 含 官方内置包徽标=${t2.includes('官方内置包')}`,
  );

  // 「DSH 官方内置包，通常已随 dsh-base 挂载，一般不需要再装」这条提示**只在展开态**渲染：
  //   plugin/client.js:900 `open ? h('div', ...)` 包住了整个详情块，
  //   plugin/client.js:936-941 的那条 MetaRow（label '提示'）就在里面。
  // 折叠态只渲染徽标 `hit.kindText`（'官方内置包'，见 plugin/client.js:866-881）。
  // 原先这条断言在**折叠态**文本里找 'DSH 官方内置包'，因此恒为假 —— 是断言写错了
  // 交互状态（目标文本在展开后才有），不是产品缺陷。下面走真实折叠路径点开它再断言。
  const ghRow = env.container
    .querySelectorAll('[role="button"]')
    .find((b) => text(b).includes('demo-gh'));
  check(
    '存在可展开的插件目录条目（GitHub 来源，折叠态给出包名与来源徽标）',
    Boolean(ghRow) && text(ghRow).includes('GitHub 核实') && text(ghRow).includes('可装'),
    `找到=${ghRow ? text(ghRow).replace(/\s+/g, ' ').slice(0, 80) : '(未找到)'}`,
  );
  if (ghRow) ghRow.click();
  const t2c = text(env.container);
  check(
    '展开 GitHub 条目后给出「DSH 官方内置包……一般不需要再装」提示',
    t2c.includes('提示：DSH 官方内置包，通常已随 dsh-base 挂载，一般不需要再装（可当配置参考）'),
    `含官方内置提示=${t2c.includes('DSH 官方内置包，通常已随 dsh-base 挂载')} 展开片段=${t2c.slice(t2c.indexOf('demo-gh')).replace(/\s+/g, ' ').slice(0, 160)}`,
  );
  check(
    '渲染出省 token 开关清单（当前值 → 建议值）',
    t2.includes('省 token 开关清单') && t2.includes('当前 8000 → 建议 6000') && t2.includes('【A】旋钮') === false && t2.includes('【A】spill 预算'),
    `含 8000→6000=${t2.includes('当前 8000 → 建议 6000')}`,
  );
  check('渲染出页脚与平台', t2.includes('【A】页脚 · 零外发') && t2.includes('平台 DSH'), `含页脚=${t2.includes('【A】页脚 · 零外发')}`);
  check(
    '渲染出指标图例（details，列出本次出现的编号）',
    t2.includes('指标编号是什么意思？') && t2.includes('C1 · 【A】token 消耗过快') && t2.includes('A3 · 开关闲置'),
    `含图例=${t2.includes('指标编号是什么意思？')}`,
  );
}

// --- B2. 剪贴板能力分支 --------------------------------------------------
section('B2) 复制按钮的能力分支');
{
  resetWorld();
  const env = mountClient();
  openPanel(env.container);
  await flush();
  env.container.querySelectorAll('[role="button"]')[0].click();
  const copyBtn = buttonByText(env.container, '复制定位符');
  check(
    '提供剪贴板时复制按钮可用（可点、不 disabled）',
    Boolean(copyBtn) && copyBtn.disabled === false && copyBtn.getAttribute('title') === '复制',
    `按钮=${copyBtn ? `disabled=${copyBtn.disabled} title=${copyBtn.getAttribute('title')}` : '(未找到复制定位符按钮)'}`,
  );
  if (copyBtn) copyBtn.click();
  await flush();
  check(
    '点击复制把定位符交给 navigator.clipboard.writeText',
    copied.length === 1 && copied[0] === 'C:/x/dl/session.v4.jsonl.zstd#L42',
    `copied=${JSON.stringify(copied)}`,
  );
}
{
  resetWorld();
  const doc = new StubDocument();
  const win = new StubWindow(doc);
  installGlobals(doc, win);
  setNavigator({ userAgent: 'test' }); // 不带 clipboard
  installFetch();
  const { mod } = loadClient();
  const root = createRoot(doc, doc.body);
  root.render([REACT.createElement(mod.ClinicNavButton, {}), REACT.createElement(mod.ClinicPanel, {})]);
  openPanel(doc.body);
  await flush();
  doc.body.querySelectorAll('[role="button"]')[0].click();
  const copyBtn = buttonByText(doc.body, '复制定位符');
  check(
    '未提供剪贴板时复制按钮禁用并提示（不抛异常）',
    Boolean(copyBtn) && copyBtn.disabled === true && copyBtn.getAttribute('title') === '当前环境不支持剪贴板',
    `按钮=${copyBtn ? `disabled=${copyBtn.disabled} title=${copyBtn.getAttribute('title')}` : '(未找到复制定位符按钮)'}`,
  );
}

// --- C. live 回归（②）---------------------------------------------------
section('C) 回归：联网现搜由组件自身 live 状态驱动（②）');
{
  resetWorld();
  const env = mountClient();
  // 「模块级/全局状态被污染」：面板正确的实现只读组件内 state，不该受影响
  globalThis.state = { live: { data: makeData('POLLUTED') } };
  globalThis.live = { data: makeData('POLLUTED') };
  globalThis.watchSnap = { signature: 'p', count: 99, unseen: 42 };
  openPanel(env.container);
  await flush();
  const t = text(env.container);
  check(
    '渲染不受同名全局/模块级状态污染（只读组件内 state）',
    !t.includes('【POLLUTED】') && t.includes('【A】token 消耗过快'),
    `含污染标记=${t.includes('【POLLUTED】')} 含 A 数据=${t.includes('【A】token 消耗过快')}`,
  );
  delete globalThis.state;
  delete globalThis.live;
  delete globalThis.watchSnap;

  const before = text(env.container);
  check('未点按钮前展示 report 数据（不是 live）', before.includes('【A】处方 1') && !before.includes('【B】'), `含 A=${before.includes('【A】处方 1')} 含 B=${before.includes('【B】')}`);

  world.live = makeLivePayload('B');
  const liveBtn = buttonByText(env.container, '联网现搜插件');
  check('面板头部存在「联网现搜插件」按钮', Boolean(liveBtn), `按钮=${liveBtn ? text(liveBtn) : '(未找到)'}`);
  if (liveBtn) liveBtn.click();
  await flush();
  const t3 = text(env.container);

  check(
    '点击「联网现搜插件」后渲染切换到 live 返回的整份分析（组件内 live 驱动）',
    t3.includes('【B】token 消耗过快') && t3.includes('【B】处方 1') && t3.includes('【B】页脚'),
    `含 B 分组=${t3.includes('【B】token 消耗过快')} 含 B 处方=${t3.includes('【B】处方 1')}`,
  );
  check(
    'live 生效后旧 report 数据不再出现在渲染结果里（不会恒回落 state.data）',
    !t3.includes('【A】token 消耗过快') && !t3.includes('【A】处方 1') && !t3.includes('【A】页脚'),
    `残留 A 标记=${['【A】token 消耗过快', '【A】处方 1', '【A】页脚'].filter((m) => t3.includes(m)).join('|') || '(无)'}`,
  );
  check(
    'live 到达后面板标注与检索信息更新（只发送关键词，列出实际检索词）',
    t3.includes('只读 · 本次已联网现搜插件') && t3.includes('本次联网现搜：新发现 4 条候选') && t3.includes('耗时 1.2s') && t3.includes('死循环 插件、token 压缩 dsh 插件'),
    `含检索词=${t3.includes('死循环 插件、token 压缩 dsh 插件')}`,
  );

  // live 数据必须是**实例私有**的（组件内 state），而不是模块级共享
  const doc2 = new StubDocument();
  const win2 = new StubWindow(doc2);
  const holdDoc = globalThis.document;
  const holdWin = globalThis.window;
  globalThis.document = doc2;
  globalThis.window = win2;
  const other = doc2.createElement('div');
  doc2.body.appendChild(other);
  const root2 = createRoot(doc2, other);
  root2.render([REACT.createElement(env.mod.ClinicNavButton, {}), REACT.createElement(env.mod.ClinicPanel, {})]);
  await flush();
  const otherText = text(other);
  check(
    'live 是面板实例私有：另一个面板实例仍展示 report 数据（组件 live ≠ 模块级 live）',
    otherText.includes('【A】token 消耗过快') && !otherText.includes('【B】') && !otherText.includes('本次已联网现搜插件'),
    `另一个实例含 A=${otherText.includes('【A】token 消耗过快')} 含 B=${otherText.includes('【B】')} 文本长度=${otherText.length}`,
  );
  globalThis.document = holdDoc;
  globalThis.window = holdWin;
}
{
  resetWorld();
  const env = mountClient();
  openPanel(env.container);
  await flush();
  world.liveError = '联网通道 500';
  const liveBtn = buttonByText(env.container, '联网现搜插件');
  liveBtn.click();
  await flush();
  const t = text(env.container);
  check(
    '联网现搜失败时显示错误行、保留原 report 数据、不显示假数据',
    t.includes('联网检索失败：联网通道 500') && t.includes('【A】token 消耗过快') && !t.includes('新发现'),
    `含错误行=${t.includes('联网检索失败：联网通道 500')} 含 A 数据=${t.includes('【A】token 消耗过快')}`,
  );
}

// --- D. 角标 / 轮询（③）--------------------------------------------------
section('D) 角标与准实时轮询（③）');
{
  resetWorld();
  globalThis.fetch = undefined;
  const doc = new StubDocument();
  const win = new StubWindow(doc);
  installGlobals(doc, win);
  installFetch();
  const { mod } = loadClient();
  const container = doc.body;
  const root = createRoot(doc, container);
  root.render([REACT.createElement(mod.ClinicNavButton, {}), REACT.createElement(mod.ClinicPanel, {})]);

  const watchCalls = world.calls.filter((c) => c.url.endsWith('/watch'));
  check(
    '侧边栏按钮挂载即轮询 /api/agent-clinic/watch（带 accept 头）',
    watchCalls.length === 1 && watchCalls[0].opts.headers.accept === 'application/json',
    `watch 请求数=${watchCalls.length} opts=${JSON.stringify(watchCalls[0] ? watchCalls[0].opts : null)}`,
  );
  await flush();
  check('首次建立签名时不显示未读角标（首拉不算未读）', container.querySelector('[title^="发现"]') === null, `角标节点=${container.querySelector('[title^="发现"]') ? '存在' : '无'}`);

  world.watch = { ok: true, version: '14', count: 3, ids: ['C1', 'E1', 'C1'], signature: 'sig-2', generatedAt: 't' };
  await tickWatcher(0);
  await flush();
  const badge = container.querySelector('[title="发现 2 个新问题"]');
  check(
    '签名变化且问题变多时角标 = 新增数（3 - 1 = 2）',
    Boolean(badge) && text(badge).trim() === '2',
    `角标=${badge ? text(badge).trim() : '(无)'} 全部 title=${container.querySelectorAll('span').map((s) => s.getAttribute('title')).filter(Boolean).join(',')}`,
  );

  await tickWatcher(0);
  await flush();
  const badge2 = container.querySelector('[title="发现 2 个新问题"]');
  check(
    '签名未变化时不重复增长（tick 提前返回）',
    Boolean(badge2) && text(badge2).trim() === '2',
    `角标=${badge2 ? text(badge2).trim() : '(无)'}`,
  );

  openPanel(container);
  await flush();
  check('打开面板后未读角标清零', container.querySelector('[title^="发现"]') === null, `角标节点=${container.querySelector('[title^="发现"]') ? '存在' : '无'}`);
  check('打开面板后侧边栏文案变为「收起体检」', has(container, '收起体检'), `实际文本=${text(container).slice(0, 60)}`);
}

// --- E. 降级渲染（④）-----------------------------------------------------
section('E) 无数据 / 请求失败降级（④）');
{
  resetWorld({ reportError: '连接被拒绝 ECONNREFUSED' });
  const env = mountClient();
  openPanel(env.container);
  await flush();
  const t = text(env.container);
  check(
    '报告请求失败时渲染错误提示（含原因），且不显示统计假数据',
    t.includes('未能取得报告：') && t.includes('连接被拒绝 ECONNREFUSED') && !t.includes('工具调用') && !t.includes('cacheRead'),
    `含原因=${t.includes('连接被拒绝 ECONNREFUSED')} 含统计=${t.includes('工具调用')}`,
  );
  check('请求失败时给出可操作指引（重启 Harness / 直接用工具）', t.includes('重启 Harness') && t.includes('体检一下'), `含重启指引=${t.includes('重启 Harness')}`);
  check('请求失败时无渲染期异常', renderErrors.length === 0, `异常=${renderErrors.map((e) => e.message).join(';') || '(无)'}`);
}
{
  resetWorld({ report: { ok: false, error: '宿主未注册 /report 路由' } });
  const env = mountClient();
  openPanel(env.container);
  await flush();
  const t = text(env.container);
  check(
    '宿主返回 ok:false 时展示宿主给出的错误原因',
    t.includes('未能取得报告：') && t.includes('宿主未注册 /report 路由'),
    `含原因=${t.includes('宿主未注册 /report 路由')}`,
  );
}
{
  resetWorld({ report: { ok: true, version: '14', report: '纯文本报告：会话 3 个，未发现异常。', data: null } });
  const env = mountClient();
  openPanel(env.container);
  await flush();
  const t = text(env.container);
  check(
    '只有 report 文本（无结构化 data）时按原样渲染，不编造卡片',
    t.includes('纯文本报告：会话 3 个，未发现异常。') && !t.includes('未检测到异常的维度') && !t.includes('处方：最该先做的'),
    `含纯文本=${t.includes('纯文本报告：会话 3 个，未发现异常。')} 含卡片区=${t.includes('未检测到异常的维度')}`,
  );
}
{
  resetWorld({ report: { ok: true, version: '13', report: 'x', data: makeData('A') } });
  const env = mountClient();
  openPanel(env.container);
  await flush();
  const t = text(env.container);
  check(
    '宿主版本落后（version≠CLIENT_VERSION）时显示重启提示横幅',
    t.includes('宿主仍是旧版，请完全退出并重启 Harness'),
    `含横幅=${t.includes('宿主仍是旧版，请完全退出并重启 Harness')}`,
  );
}
{
  resetWorld();
  const env = mountClient();
  delete globalThis.fetch;
  openPanel(env.container);
  await flush();
  const t = text(env.container);
  check(
    'fetch 不可用时降级为错误提示（不抛异常）',
    t.includes('当前环境不提供 fetch，无法从宿主取数') && renderErrors.length === 0,
    `含提示=${t.includes('当前环境不提供 fetch，无法从宿主取数')} 异常=${renderErrors.length}`,
  );

  // ⚠️ 待修产品缺陷（**不是**测试问题，本轮不允许改 plugin/client.js，故此处记录现状）：
  //   runLive 的无 fetch 降级分支本身是有的 —— plugin/client.js:1014-1017
  //     if (typeof fetch !== 'function') { setLiveErr('当前环境不提供 fetch，无法联网检索'); return; }
  //   但 liveErr 的**唯一**渲染点在 plugin/client.js:1166-1182，
  //   而它位于 `} else {`（即 state.data 存在的 OK 分支，见 plugin/client.js:1091/1097）之内。
  //   当报告请求本身失败（state.status === 'error'，body 见 plugin/client.js:1080-1090）时，
  //   头部按钮仍然可点（plugin/client.js:1392-1402 只在 liveBusy 时 disabled），
  //   点击会 setLiveErr 并触发重渲染，可错误分支根本不读 liveErr → **用户点了毫无反馈**。
  //   下面两条断言如实记录这一现状：点击前后渲染文本完全一致（没有任何降级提示）。
  //   缺陷修复后第一条断言应翻面（应当出现「联网检索失败：当前环境不提供 fetch，无法联网检索」）。
  const liveBtn = buttonByText(env.container, '联网现搜插件');
  check(
    '报告请求失败态下「联网现搜插件」按钮仍存在且可点',
    Boolean(liveBtn) && liveBtn.disabled === false,
    `按钮=${liveBtn ? `text=${text(liveBtn)} disabled=${liveBtn.disabled}` : '(未找到)'}`,
  );
  if (liveBtn) liveBtn.click();
  await flush();
  const tAfter = text(env.container);
  check(
    '⚠ 待修缺陷：报告请求失败态下点「联网现搜」无任何反馈（liveErr 被设置但错误分支不渲染它）',
    tAfter === t && !tAfter.includes('联网检索失败') && !tAfter.includes('无法联网检索'),
    `点击后是否与点击前逐字相同=${tAfter === t} 含「联网检索失败」=${tAfter.includes('联网检索失败')} 尾部=${tAfter.slice(-90)}`,
  );
  installFetch();
}
{
  // 正面路径：报告已经拿到（组件内 state.data 存在），再摘掉 fetch 后点「联网现搜」——
  // 这样才真实触达 runLive 的降级分支（plugin/client.js:1014-1017），
  // 且渲染走的是 liveErr 唯一被渲染的 OK 分支（plugin/client.js:1166-1182）。
  resetWorld();
  const env = mountClient();
  openPanel(env.container);
  await flush();
  delete globalThis.fetch;
  const liveBtn = buttonByText(env.container, '联网现搜插件');
  check(
    '有数据的面板头部存在可点的「联网现搜插件」按钮',
    Boolean(liveBtn) && liveBtn.disabled === false,
    `按钮=${liveBtn ? `text=${text(liveBtn)} disabled=${liveBtn.disabled}` : '(未找到)'}`,
  );
  if (liveBtn) liveBtn.click();
  await flush();
  const t = text(env.container);
  check(
    'fetch 不可用时点「联网现搜」给出降级提示（不静默失败、不抛异常）',
    t.includes('联网检索失败：当前环境不提供 fetch，无法联网检索') && renderErrors.length === 0,
    `含降级提示=${t.includes('联网检索失败：当前环境不提供 fetch，无法联网检索')} 异常=${renderErrors.map((e) => e.message).join(';') || renderErrors.length}`,
  );
  installFetch();
}
{
  resetWorld();
  const data = makeData('A');
  data.groups = [];
  data.findings = [];
  data.notDetected = [];
  data.prescriptions = [];
  data.catalog.recommendations = [];
  data.levers = [];
  world.report = { ok: true, version: '14', report: 'x', data };
  const env = mountClient();
  openPanel(env.container);
  await flush();
  const t = text(env.container);
  check('未检测到维度为空时显示「（无）」而不是空白', t.includes('未检测到异常的维度') && t.includes('（无）'), `含（无）=${t.includes('（无）')}`);
  check('无分组且无 finding 时显示「未发现问题」', t.includes('未发现问题') && t.includes('所有已实现的指标均未检测到异常'), `含未发现问题=${t.includes('未发现问题')}`);
  check('空数据时无渲染期异常', renderErrors.length === 0, `异常=${renderErrors.map((e) => e.message).join(';') || '(无)'}`);
}

// --- F. 交互路径 ---------------------------------------------------------
section('F) 交互路径');
{
  resetWorld();
  const env = mountClient();
  openPanel(env.container);
  await flush();
  const dialog = env.container.querySelector('[role="dialog"]');
  check('面板以 role=dialog 挂载（aria-label=Agent 体检报告）', Boolean(dialog) && dialog.getAttribute('aria-label') === 'Agent 体检报告', `dialog=${dialog ? dialog.getAttribute('aria-label') : '(无)'}`);

  const title = dialog.querySelectorAll('span')[0];
  if (title) title.click();
  check(
    '点击面板内部不关闭（e.target !== e.currentTarget）',
    env.container.querySelector('[role="dialog"]') !== null,
    `dialog=${env.container.querySelector('[role="dialog"]') ? '仍存在' : '已关闭'}`,
  );

  const overlay = env.container.querySelector('[role="dialog"]').parentNode;
  overlay.click();
  check('点击覆盖层自身关闭面板', env.container.querySelector('[role="dialog"]') === null, `dialog=${env.container.querySelector('[role="dialog"]') ? '仍存在' : '已卸载'}`);

  openPanel(env.container);
  await flush();

  // 「刷新」是**面板头部**的按钮：plugin/client.js:1403
  //   h('button', { type: 'button', style: S.iconBtn, onClick: () => setNonce((n) => n + 1) }, '刷新')
  // 面板关闭时整棵面板子树被卸载（plugin/client.js:1073 `if (!isOpen) return null;`），
  // 所以在 closeBtn.click() **之后**去找它必然是 null —— 原先那条断言断的是一个
  // 已经不存在的 DOM，属于测试写错了时序（断言位置紧随"关闭面板"），不是产品缺陷。
  // 这里把断言挪回面板打开态，并且不止查存在，还驱动它验证真的重新取数。
  const refresh = buttonByText(env.container, '刷新');
  const reportBefore = world.calls.filter((c) => c.url.endsWith('/report')).length;
  check(
    '面板头部存在「刷新」按钮',
    Boolean(refresh),
    `按钮=${refresh ? text(refresh) : '(未找到)'} 头部按钮=[${env.container
      .querySelectorAll('[role="dialog"] button')
      .map((b) => text(b))
      .join(' / ')}]`,
  );
  if (refresh) refresh.click();
  await flush();
  const reportAfter = world.calls.filter((c) => c.url.endsWith('/report')).length;
  check(
    '点「刷新」后重新请求 /report（nonce 递增触发取数）',
    reportAfter === reportBefore + 1 && has(env.container, 'Agent 体检报告'),
    `刷新前 report 请求数=${reportBefore} 刷新后=${reportAfter} 仍渲染面板=${has(env.container, 'Agent 体检报告')}`,
  );

  const closeBtn = buttonByText(env.container, '×');
  check('存在关闭按钮（×）', Boolean(closeBtn), `按钮=${closeBtn ? text(closeBtn) : '(未找到)'}`);
  if (closeBtn) closeBtn.click();
  check(
    '点击关闭按钮后面板卸载（open 状态回到 false）',
    env.container.querySelector('[role="dialog"]') === null && !has(env.container, 'Agent 体检报告'),
    `dialog=${env.container.querySelector('[role="dialog"]') ? '仍存在' : '已卸载'}`,
  );
  check('关闭后侧边栏文案回到「体检」', has(env.container, '体检') && !has(env.container, '收起体检'), `实际文本=${text(env.firstChild || env.container).slice(0, 40)}`);

  check('全程无渲染期异常', renderErrors.length === 0, `异常=${renderErrors.map((e) => e.message).join(';') || '(无)'}`);
}

// ===========================================================================
section('汇总');
process.stdout.write(`\n=====================\n通过 ${pass} · 失败 ${fail}\n`);
if (failures.length) process.stdout.write(`失败项：\n${failures.map((f) => `  - ${f}`).join('\n')}\n`);
process.exitCode = fail === 0 ? 0 : 1;
