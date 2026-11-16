/**
 * client.js 行为测试：用极小的 React/宿主替身加载真实浏览器半产物，验证
 * 「按稳定 id 映射正文、单次 GET、编辑/保存/取消、删除确认、失败保留草稿、撤回分支」。
 * 助手侧完全不注册席位，也不再参与改写/删除/复制——有用例守住这条边界。
 * 不触碰真实会话，也不需要浏览器。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const SRC = readFileSync(fileURLToPath(new URL('../client.js', import.meta.url)), 'utf8');

/* ---------------- 极小 React 替身 ---------------- */

function createMiniReact(React) {
  let current = null;
  React.__refRecords = [];
  React.createElement = function (type, props) {
    const children = [];
    for (let i = 2; i < arguments.length; i++) {
      const c = arguments[i];
      if (c === null || c === undefined || c === false) continue;
      if (Array.isArray(c)) children.push(...c.flat(Infinity).filter(x => x !== null && x !== undefined && x !== false));
      else children.push(c);
    }
    const element = { type, props: { ...(props || {}), children } };
    if (props && props.ref) React.__refRecords.push({ ref: props.ref });
    return element;
  };
  React.useState = function (init) {
    const i = current.idx++;
    if (!(i in current.hooks)) current.hooks[i] = typeof init === 'function' ? init() : init;
    return [current.hooks[i], (v) => {
      // 卸载后 setState 在真实 React 里是无效写入 + 告警；这里显式计数，供测试断言。
      if (!current) { React.__lateSetState = (React.__lateSetState || 0) + 1; return; }
      current.hooks[i] = typeof v === 'function' ? v(current.hooks[i]) : v;
    }];
  };
  React.useEffect = function (fn, deps) {
    const i = current.idx++;
    const prev = current.hooks[i];
    const changed = !prev || deps === undefined || !prev.deps || deps.length !== prev.deps.length || deps.some((d, k) => d !== prev.deps[k]);
    if (changed) {
      if (prev && prev.cleanup) prev.cleanup();
      const slot = { deps, cleanup: undefined };
      current.hooks[i] = slot;
      current.pendingEffects.push({ slot, fn });
    }
  };
  React.useRef = function (v) {
    const i = current.idx++;
    if (!(i in current.hooks)) current.hooks[i] = { current: v };
    return current.hooks[i];
  };
  const bridge = {
    begin(instance) { current = instance; instance.idx = 0; instance.pendingEffects = []; },
    end(instance) {
      // 真实 React 在提交阶段绑定 ref，再跑被动副作用；夹具必须同序。
      if (bridge.onBeforeEffects) bridge.onBeforeEffects();
      for (const e of instance.pendingEffects) e.slot.cleanup = e.fn();
    },
    dispose(instance) {
      current = null;   // 组件已卸载；此后的任何 setState 都是迟到写入，计入 __lateSetState
      for (const h of instance.hooks) if (h && h.cleanup) { h.cleanup(); h.cleanup = undefined; }
    },
  };
  React.__bridge = bridge;
  return bridge;
}

/** 可反复渲染的最小挂载点（保持 hook 状态）。 */
function mount(Comp, props, bridge, beforeEffects) {
  const instance = { hooks: [], idx: 0, pendingEffects: [] };
  const inst = {
    tree: null,
    render() { bridge.begin(instance); inst.tree = Comp(props); bridge.end(instance); return inst.tree; },
    unmount() { bridge.dispose(instance); },
  };
  // 真实 React 先提交 DOM/绑定 ref，再跑被动副作用；夹具沿用同一顺序。
  if (beforeEffects) bridge.onBeforeEffects = beforeEffects;
  inst.render();
  return inst;
}

/* ---------------- 宿主替身 ---------------- */

function boot({ fetchImpl, primitives, React, ctxGet, cfg, modules } = {}) {
  const ReactStub = React || {};
  const bridge = createMiniReact(ReactStub);
  const effects = [];
  const registered = [];
  let captured = null;
  // 用短窗口让撤回的等待/超时链路确定性跑完，不必真等 3 秒。
  const windowObj = {
    __ModuleLoader__: { load: (def) => { captured = def; } },
    __DSH_HISTORY_EDITOR_CFG__: cfg || { readyTimeoutMs: 300, readyPollMs: 20, prefillTimeoutMs: 300 },
    setTimeout, clearTimeout,
  };
  const documentObj = {
    head: { appendChild() {}, removeChild() {} },
    createElement: () => ({ setAttribute() {}, style: {}, textContent: '' }),
  };
  const fetchCalls = [];
  const doFetch = fetchImpl || (() => Promise.resolve({ json: () => Promise.resolve({ ok: true, messages: [], revision: 0 }) }));
  const fetchFn = (url, init) => { fetchCalls.push({ url, init }); return doFetch(url, init); };
  const requireStub = (name) => {
    if (name === 'react') return ReactStub;
    if (modules && Object.prototype.hasOwnProperty.call(modules, name)) return modules[name];
    if (primitives === undefined) throw new Error('primitives unavailable');
    return primitives;
  };

  const fn = new Function('window', 'document', 'console', 'setTimeout', 'clearTimeout', 'fetch', 'require', SRC);
  fn(windowObj, documentObj, console, setTimeout, clearTimeout, fetchFn, requireStub);
  assert.ok(captured && captured.id === 'dsh-history-editor', 'client 必须通过 ModuleLoader 注册');
  const mod = captured.factory(requireStub);

  const ctx = {
    effect(fn, label) { effects.push({ label }); return fn(); },
    on() {},
    get(name) { return ctxGet ? ctxGet(name) : null; },
    slots: {
      inject(key, cb) {
        assert.equal(key, 'conversation.chat.node', '只应注入用户气泡席位');
        return cb();
      },
      register(options, component) { registered.push({ options, component }); return () => {}; },
    },
  };
  mod.apply(ctx);
  return { mod, ctx, registered, effects, fetchCalls, React: ReactStub, mountWith: (Comp, props, beforeEffects) => mount(Comp, props, bridge, beforeEffects) };
}

const flush = () => new Promise(r => setTimeout(r, 5));
/**
 * 等到撤回流程真正结束再断言：轮询到 error 出现、或某条副作用（draft/post）发生、
 * 或超过给定上限。避免在 helper 还没跑完时快照到中间态（error 仍为 ''）。
 */
async function settle(inst, isDone, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  inst.render();
  while (Date.now() < deadline) {
    if (isDone()) { inst.render(); return; }
    await new Promise(r => setTimeout(r, 10));
    inst.render();
  }
  inst.render();
}
function walk(node, out = []) {
  if (!node || typeof node !== 'object') return out;
  out.push(node);
  for (const c of (node.props && node.props.children) || []) walk(c, out);
  return out;
}
const find = (tree, marker) => walk(tree).find(n => n.props && n.props['data-dsh-he'] === marker);
const textOf = (node) => (typeof node === 'string' || typeof node === 'number') ? String(node)
  : (node && node.props ? ((node.props.children || []).map(textOf).join('')) : '');
const editButtonIn = (tree) => find(tree, 'edit');
function nodeOf(id, seq, text) {
  return { id, kind: 'user', key: 'user:k' + id, anchorSeq: seq, data: { seq, time: 1700000000000, content: [{ type: 'text', text }] } };
}
const okGet = (messages, revision = 5, removedIds = []) => () => Promise.resolve({
  json: () => Promise.resolve({ ok: true, revision, removedIds: [...removedIds], messages: messages.map(m => ({ ...m })) })
});
const ONE = [{ id: 'u1', seq: 0, role: 'user', text: '原文', editable: true, reason: '' }];

/* ---------------- 测试 ---------------- */

test('rc.3 正文/图片交给宿主 user.content 工厂；用户席位不再重复声明子槽', async () => {
  assert.doesNotMatch(SRC, /cJsG2q_|xD_KDq_|LOmM4q_|_1KfHza_/);
  const { registered, mountWith } = boot();
  // 关键回归（0.4.2 无 UI 根因）：rc.3 宿主已在 conversation.chat.user.content 工厂里
  // 声明 conversation.chat.user.images；本插件若再声明，SlotCore 会以
  // "slot ...user.images is already declared" 中止激活，用户席位整个不渲染。
  assert.equal(registered[0].options.children, undefined, '用户席位不得声明任何子槽');
  const calls = [], loadImage = () => 'test-url';
  const node = nodeOf('image', 1, 'caption');
  const attachment = { name: 'photo.png', bytes: 10, hash: 'test' };
  node.data.content.push({ type: 'image', attachment }, { type: 'file', attachment: { name: 'notes.txt', bytes: 4 } });
  const inst = mountWith(registered[0].component, {
    sessionId: 'images', node, loadImage,
    renderFactorySlot(name, props) { calls.push({ name, props }); return 'host-rendered-body'; },
  });
  assert.equal(calls[0].name, 'conversation.chat.user.content');
  assert.deepEqual(calls[0].props.content.attachments, [
    { type: 'image', image: { attachment } },
    { type: 'file', file: { name: 'notes.txt', bytes: 4 } },
  ]);
  assert.equal(calls[0].props.content.text, 'caption');
  assert.equal(calls[0].props.loadImage, loadImage);
  assert.equal(calls[0].props.interactive, true);
  assert.match(textOf(find(inst.tree, 'hostContent')), /host-rendered-body/);
});

test('重复声明宿主子槽会被 rc.3 拒绝；修复后 apply 仍成功注册用户席位', () => {
  // 模拟 rc.3 SlotCore 的唯一声明规则：某子槽已被宿主声明，再次声明即抛错。
  const HOST_DECLARED = 'conversation.chat.user.images';
  let captured = null;
  const ReactStub = {};
  createMiniReact(ReactStub);
  const windowObj = {
    __ModuleLoader__: { load: (def) => { captured = def; } },
    __DSH_HISTORY_EDITOR_CFG__: { readyTimeoutMs: 300, readyPollMs: 20, prefillTimeoutMs: 300 },
    setTimeout, clearTimeout,
  };
  const documentObj = { head: { appendChild() {}, removeChild() {} }, createElement: () => ({ setAttribute() {}, style: {}, textContent: '' }) };
  const requireStub = (name) => { if (name === 'react') return ReactStub; throw new Error('primitives unavailable'); };
  const fn = new Function('window', 'document', 'console', 'setTimeout', 'clearTimeout', 'fetch', 'require', SRC);
  fn(windowObj, documentObj, console, setTimeout, clearTimeout, () => Promise.reject(new Error('no fetch')), requireStub);
  const mod = captured.factory(requireStub);
  const registered = [];
  const assertNoDup = (options) => {
    for (const key of Object.keys(options.children || {})) {
      if (key === HOST_DECLARED) throw new Error('slot "' + key + '" is already declared (by factory "conversation.chat.user.content")');
    }
  };
  const ctx = {
    effect: (f) => f(),
    on() {},
    get() { return null; },
    slots: {
      inject(_key, cb) { return cb(); },
      register(options, component) { assertNoDup(options); registered.push({ options, component }); return () => {}; },
      registerFactory(options) { assertNoDup(options); return () => {}; },
    },
  };
  // 旧 0.4.2 会在这里抛 already declared；修复后必须顺利注册。
  assert.doesNotThrow(() => mod.apply(ctx));
  assert.equal(registered.length, 1);
  assert.equal(registered[0].options.name, 'conversation.chat.node');
  assert.equal(registered[0].options.key, 'user');
  assert.equal(registered[0].options.children, undefined);
});

test('只注册用户气泡席位：助手侧席位已移除', () => {
  const { registered, effects } = boot();
  assert.equal(registered.length, 1, '只保留用户席位');
  assert.equal(registered[0].options.name, 'conversation.chat.node');
  assert.equal(registered[0].options.key, 'user');
  assert.equal(effects.some(e => /dock/i.test(e.label || '')), false, '不得注册 input.dock');
  assert.ok(effects.length >= 2, '样式与席位都应绑定到 ctx.effect');
});

test('源码不再包含任何助手侧改写/删除/复制/撤回的实现痕迹', () => {
  for (const gone of [
    'conversation.chat.assistant-actions', 'AssistantActionsRow', 'assistant-edit', 'assistant-delete',
    'assistant-copy', 'assistant-recall', 'dsh-he-assistantProjection', 'data-dsh-history-copy-text',
    "require(\"react-dom\")", 'createPortal',
  ]) {
    assert.equal(SRC.includes(gone), false, '仍残留助手侧实现：' + gone);
  }
});

test('同一批挂载只发一次 GET；重新挂载会重新拉取', async () => {
  const { registered, fetchCalls, mountWith } = boot({ fetchImpl: okGet([], 3) });
  const Comp = registered[0].component;
  const props = { sessionId: 's1', node: nodeOf('u1', 0, 'apple'), renderMessageImages: null };
  const a = mountWith(Comp, props);
  const b = mountWith(Comp, { sessionId: 's1', node: nodeOf('u2', 2, 'banana'), renderMessageImages: null });
  await flush();
  assert.equal(fetchCalls.filter(c => c.url.startsWith('/history-editor/messages')).length, 1, '两个气泡共用一个 GET');
  a.unmount(); b.unmount();
  const c = mountWith(Comp, props); // 重新挂载 = 新的一批
  await flush();
  assert.equal(fetchCalls.length, 2, '重新挂载必须重新拉取');
  c.unmount();
});

test('用稳定 id 映射当前正文；editable:false 仍按 id 显示但编辑置灰', async () => {
  const { registered, mountWith } = boot({
    fetchImpl: okGet([
      { id: 'u1', seq: 0, role: 'user', text: '映射后的新正文', editable: true, reason: '' },
      { id: 'u9', seq: 7, role: 'user', text: '已折叠的保存文字', editable: false, reason: '这条已修订消息已被折叠，仅显示保存后的文字' },
    ], 9),
  });
  const Comp = registered[0].component;
  const fresh = mountWith(Comp, { sessionId: 's1', node: nodeOf('u1', 0, '旧字'), renderMessageImages: null });
  const gone = mountWith(Comp, { sessionId: 's1', node: nodeOf('u9', 4, '旧字'), renderMessageImages: null });
  await flush(); fresh.render(); gone.render();
  assert.match(textOf(find(fresh.tree, 'bubble')), /映射后的新正文/, '气泡必须用 id 映射后的正文');
  assert.match(textOf(find(gone.tree, 'bubble')), /已折叠的保存文字/, '折叠消息按 id 显示保存后的文字');
  assert.ok(find(gone.tree, 'readonly'), '折叠消息给出只读说明');
  assert.ok(editButtonIn(gone.tree).props.disabled, '折叠消息的编辑图标必须置灰');
  assert.ok(!editButtonIn(fresh.tree).props.disabled, '正常消息可编辑');
});

test('点击编辑在该气泡位置变 textarea，取消回到气泡', async () => {
  const { registered, mountWith } = boot({ fetchImpl: okGet(ONE) });
  const Comp = registered[0].component;
  const inst = mountWith(Comp, { sessionId: 's1', node: nodeOf('u1', 0, '旧字'), renderMessageImages: null });
  await flush(); inst.render();
  const btn = editButtonIn(inst.tree);
  assert.ok(btn, '存在编辑图标');
  btn.props.onClick();
  inst.render();
  const ta = find(inst.tree, 'textarea');
  assert.equal(ta.props.value, '原文', '编辑框填入映射后的当前正文');
  assert.ok(find(inst.tree, 'save') && find(inst.tree, 'cancel'), '出现保存/取消');
  find(inst.tree, 'cancel').props.onClick();
  inst.render();
  assert.ok(!find(inst.tree, 'textarea'), '取消后回到气泡');
  assert.ok(find(inst.tree, 'bubble'));
});

test('保存提交映射后的 seq 与 revision，成功后更新缓存与气泡', async () => {
  const posts = [];
  // 有状态的宿主替身：POST 真的改掉当前正文，之后的 GET 返回保存后的文字（与真实后端一致）。
  let stored = { ...ONE[0] };
  let revision = 5;
  const { registered, mountWith } = boot({
    fetchImpl: (url, init) => {
      if (init && init.method === 'POST') {
        posts.push(JSON.parse(init.body));
        stored = { ...stored, text: JSON.parse(init.body).text };
        revision += 1;
        return Promise.resolve({ json: () => Promise.resolve({ ok: true, seq: 42, revision }) });
      }
      return Promise.resolve({ json: () => Promise.resolve({ ok: true, revision, messages: [{ ...stored }] }) });
    },
  });
  const Comp = registered[0].component;
  const inst = mountWith(Comp, { sessionId: 's1', node: nodeOf('u1', 0, '旧字'), renderMessageImages: null });
  await flush(); inst.render();
  editButtonIn(inst.tree).props.onClick();
  inst.render();
  find(inst.tree, 'textarea').props.onChange({ target: { value: '改好的正文' } });
  inst.render();
  find(inst.tree, 'save').props.onClick();
  await flush(); inst.render();
  assert.deepEqual(posts, [{ sessionId: 's1', seq: 0, text: '改好的正文', revision: 5 }]);
  assert.ok(!find(inst.tree, 'textarea'), '保存成功后退出编辑态');
  assert.match(textOf(find(inst.tree, 'bubble')), /改好的正文/, '气泡立即显示新正文');
});

test('保存期间飞行的旧 GET 不会把刚保存的正文改回去', async () => {
  let release;
  const gate = new Promise(r => { release = r; });
  let stored = { ...ONE[0] };
  const { registered, mountWith } = boot({
    fetchImpl: async (url, init) => {
      if (init && init.method === 'POST') {
        stored = { ...stored, text: JSON.parse(init.body).text };
        return { json: () => Promise.resolve({ ok: true, seq: 9, revision: 8 }) };
      }
      const snapshot = { ...stored };
      if (snapshot.text === '原文') await gate; // 首个 GET 卡住，模拟慢回包
      return { json: () => Promise.resolve({ ok: true, revision: 5, messages: [snapshot] }) };
    },
  });
  const Comp = registered[0].component;
  const inst = mountWith(Comp, { sessionId: 's1', node: nodeOf('u1', 0, '旧字'), renderMessageImages: null });
  await flush(); inst.render();
  find(inst.tree, 'edit').props.onClick();
  inst.render();
  find(inst.tree, 'textarea').props.onChange({ target: { value: '新正文' } });
  inst.render();
  find(inst.tree, 'save').props.onClick();
  await flush(); inst.render();
  release(); // 旧的过期回包此刻到达
  await flush(); inst.render();
  assert.match(textOf(find(inst.tree, 'bubble')), /新正文/, '过期回包不得覆盖保存结果');
});

test('后端拒绝保存时保留草稿并显示错误', async () => {
  const { registered, mountWith } = boot({
    fetchImpl: (url, init) => {
      if (init && init.method === 'POST') return Promise.resolve({ json: () => Promise.resolve({ ok: false, error: '请等待回复结束、排队消息处理完，再保存历史修改' }) });
      return okGet(ONE)();
    },
  });
  const Comp = registered[0].component;
  const inst = mountWith(Comp, { sessionId: 's1', node: nodeOf('u1', 0, '旧字'), renderMessageImages: null });
  await flush(); inst.render();
  editButtonIn(inst.tree).props.onClick();
  inst.render();
  find(inst.tree, 'textarea').props.onChange({ target: { value: '写了一半' } });
  inst.render();
  find(inst.tree, 'save').props.onClick();
  await flush(); inst.render();
  const err = find(inst.tree, 'error');
  assert.ok(err, '显示后端拒绝原因');
  assert.match(textOf(err), /等待回复结束/);
  assert.equal(find(inst.tree, 'textarea').props.value, '写了一半', '草稿必须保留');
  assert.ok(find(inst.tree, 'save'), '仍停留在编辑态，可重试');
});

test('没有有效正文的 node 不给编辑入口', async () => {
  const { registered, mountWith } = boot({ fetchImpl: okGet([], 1) });
  const Comp = registered[0].component;
  const inst = mountWith(Comp, {
    sessionId: 's1', renderMessageImages: null,
    node: { id: 'img1', data: { seq: 0, content: [{ type: 'image', attachment: { attachmentId: 'a' } }] } },
  });
  await flush(); inst.render();
  assert.ok(editButtonIn(inst.tree).props.disabled, '无可改文本时编辑图标置灰');
});

test('没有 primitive 依赖时也不崩（退回文本字形）', async () => {
  const { registered, mountWith } = boot({ primitives: undefined, fetchImpl: okGet(ONE) });
  const Comp = registered[0].component;
  const inst = mountWith(Comp, { sessionId: 's1', node: nodeOf('u1', 0, '旧字'), renderMessageImages: null });
  await flush(); inst.render();
  assert.match(textOf(find(inst.tree, 'bubble')), /原文/);
  assert.ok(editButtonIn(inst.tree), '无 primitives 时编辑入口仍在');
  assert.ok(find(inst.tree, 'recall'), '撤回入口同样存在');
});

test('撤回：fork 后立刻 openSession，子会话先不可读→打开后才就绪，最后预填', async () => {
  const events = [];
  let childReady = false;
  const forked = [];
  const drafts = [];
  const posts = [];
  let childRevision = 20;
  const childRow = { id: 'u1', seq: 0, role: 'user', text: '旧的第一条', editable: true, reason: '' };
  const host = {
    sessions: {
      fork: (opts) => { forked.push(opts); return Promise.resolve('child-1'); },
      scope: (id) => ({
        get: (n) => n === 'conversation' ? { input: { for: () => ({ setDraft: (t) => drafts.push([id, t]) }) } } : null,
      }),
    },
    uiWorkspace: {
      openSession: (id) => { events.push(['openSession', id]); childReady = true; }, // 只有真打开过才可就绪
    },
  };
  const { registered, mountWith } = boot({
    ctxGet: (name) => host[name] || null,
    fetchImpl: (url, init) => {
      if (init && init.method === 'POST' && url === '/history-editor/recall') {
        return Promise.resolve({ json: () => Promise.resolve({
          ok: true, boundary: 6, text: '这条的当前正文', edits: [{ id: 'u1', text: '改过的第一条' }],
        }) });
      }
      if (init && init.method === 'POST' && url === '/history-editor/edit') {
        const body = JSON.parse(init.body);
        posts.push(body);
        childRow.text = body.text;
        childRevision += 1;
        return Promise.resolve({ json: () => Promise.resolve({ ok: true, seq: body.seq, revision: childRevision }) });
      }
      if (url.includes('sessionId=child-1')) {
        events.push(['read', childReady]);
        // 未就绪时 Host 以 HTTP 404 回应（body 只有 ok/error）——客户端必须只看状态码。
        if (!childReady) return Promise.resolve({ status: 404, json: () => Promise.resolve({ ok: false, error: '请先打开这条会话，再编辑历史' }) });
        return Promise.resolve({ status: 200, json: () => Promise.resolve({ ok: true, revision: childRevision, messages: [{ ...childRow }] }) });
      }
      return okGet([
        { id: 'u1', seq: 0, role: 'user', text: '改过的第一条', editable: true, reason: '' },
        { id: 'u2', seq: 2, role: 'user', text: '这条的当前正文', editable: true, reason: '' },
      ])();
    },
  });
  const Comp = registered[0].component;
  const inst = mountWith(Comp, { sessionId: 's1', node: nodeOf('u2', 2, '旧字'), renderMessageImages: null });
  await flush(); inst.render();
  find(inst.tree, 'recall').props.onClick();
  // 等预填真正发生（流程末端）再断言，否则会快照到中间态。
  await settle(inst, () => drafts.length > 0);
  assert.deepEqual(forked, [{ sessionId: 's1', atSeq: 6 }], 'fork 用后端给的 boundary');
  // 关键时序：openSession 必须发生在第一次读取之前（否则 live Host 里子会话根本不存在）
  assert.deepEqual(events[0], ['openSession', 'child-1'], 'fork 成功立刻切换，不能等读完再切');
  assert.ok(events.some(e => e[0] === 'read'), '切换后才会去读子会话');
  assert.deepEqual(posts, [{ sessionId: 'child-1', seq: 0, text: '改过的第一条', revision: 20 }], '重放带子会话 revision');
  assert.deepEqual(drafts, [['child-1', '这条的当前正文']], '最后才预填正文');
  assert.equal(forked.length, 1, '没有发生任何生成请求');
});

test('撤回：子会话始终不可读时有界超时报错，不假装成功', async () => {
  const drafts = [];
  let opened = false;
  const { registered, mountWith } = boot({
    ctxGet: (name) => name === 'sessions'
      ? { fork: () => Promise.resolve('child-1'), scope: () => ({ get: () => ({ input: { for: () => ({ setDraft: (t) => drafts.push(t) }) } }) }) }
      : (name === 'uiWorkspace' ? { openSession: () => { opened = true; } } : null),
    fetchImpl: (url, init) => {
      if (init && init.method === 'POST' && url === '/history-editor/recall') {
        return Promise.resolve({ json: () => Promise.resolve({ ok: true, boundary: 6, text: '正文', edits: [] }) });
      }
      if (url.includes('sessionId=child-1')) {
        return Promise.resolve({ status: 404, json: () => Promise.resolve({ ok: false, error: '请先打开这条会话，再编辑历史' }) });
      }
      return okGet(ONE)();
    },
  });
  const Comp = registered[0].component;
  const inst = mountWith(Comp, { sessionId: 's1', node: nodeOf('u1', 0, '旧字'), renderMessageImages: null });
  await flush(); inst.render();
  find(inst.tree, 'recall').props.onClick();
  // 等有界超时真正落地（error 出现）再断言，不要在半途快照。
  await settle(inst, () => !!find(inst.tree, 'error'));
  assert.ok(opened, '仍然要真实打开过子会话');
  assert.match(textOf(find(inst.tree, 'error')), /仍未就绪/, '有界超时要明确报错');
  assert.deepEqual(drafts, [], '未就绪时绝不预填，也不 resolve 成功');
});

test('撤回：非就绪类错误立即抛出，不做无谓重试', async () => {
  let reads = 0;
  const { registered, mountWith } = boot({
    ctxGet: (name) => name === 'sessions'
      ? { fork: () => Promise.resolve('child-1'), scope: () => null }
      : (name === 'uiWorkspace' ? { openSession: () => {} } : null),
    fetchImpl: (url, init) => {
      if (init && init.method === 'POST' && url === '/history-editor/recall') {
        return Promise.resolve({ json: () => Promise.resolve({ ok: true, boundary: 6, text: '正文', edits: [] }) });
      }
      if (url.includes('sessionId=child-1')) {
        reads += 1;
        // 非 404 是真实故障：必须立刻失败，不能重试成超时。
        return Promise.resolve({ status: 500, json: () => Promise.resolve({ ok: false, error: '当前宿主不支持有效历史投影' }) });
      }
      return okGet(ONE)();
    },
  });
  const Comp = registered[0].component;
  const inst = mountWith(Comp, { sessionId: 's1', node: nodeOf('u1', 0, '旧字'), renderMessageImages: null });
  await flush(); inst.render();
  find(inst.tree, 'recall').props.onClick();
  await settle(inst, () => !!find(inst.tree, 'error'));
  assert.match(textOf(find(inst.tree, 'error')), /不支持有效历史投影/);
  assert.equal(reads, 1, '真实故障只读一次，不得重试成超时');
});

test('撤回：输入框迟迟不物化时 prefill 超时失败，不 resolve 成功', async () => {
  const { registered, mountWith } = boot({
    ctxGet: (name) => name === 'sessions'
      ? { fork: () => Promise.resolve('child-1'), scope: () => null } // setDraft 永远不可用
      : (name === 'uiWorkspace' ? { openSession: () => {} } : null),
    fetchImpl: (url, init) => {
      if (init && init.method === 'POST' && url === '/history-editor/recall') {
        return Promise.resolve({ json: () => Promise.resolve({ ok: true, boundary: 6, text: '正文', edits: [] }) });
      }
      if (url.includes('sessionId=child-1')) {
        return Promise.resolve({ json: () => Promise.resolve({ ok: true, revision: 3, messages: [] }) });
      }
      return okGet(ONE)();
    },
  });
  const Comp = registered[0].component;
  const inst = mountWith(Comp, { sessionId: 's1', node: nodeOf('u1', 0, '旧字'), renderMessageImages: null });
  await flush(); inst.render();
  find(inst.tree, 'recall').props.onClick();
  await settle(inst, () => !!find(inst.tree, 'error'));
  assert.match(textOf(find(inst.tree, 'error')), /输入框未能|未预填/, 'prefill 失败必须报错');
});

test('撤回：缺 uiWorkspace.openSession 时直接拒绝，不 fork 出孤儿分支', async () => {
  let forked = 0;
  const { registered, mountWith } = boot({
    ctxGet: (name) => name === 'sessions' ? { fork: () => { forked += 1; return Promise.resolve('child-1'); }, scope: () => null } : null,
    fetchImpl: okGet(ONE),
  });
  const Comp = registered[0].component;
  const inst = mountWith(Comp, { sessionId: 's1', node: nodeOf('u1', 0, '旧字'), renderMessageImages: null });
  await flush(); inst.render();
  find(inst.tree, 'recall').props.onClick();
  await settle(inst, () => !!find(inst.tree, 'error'));
  assert.equal(forked, 0, '没有切换能力就不能先 fork');
  assert.match(textOf(find(inst.tree, 'error')), /会话切换能力/);
});

test('撤回失败时提示原因且不切会话', async () => {
  const opened = [];
  const { registered, mountWith } = boot({
    ctxGet: (name) => name === 'sessions' ? { fork: () => Promise.resolve('child-1'), scope: () => null } : (name === 'uiWorkspace' ? { openSession: (id) => opened.push(id) } : null),
    fetchImpl: (url, init) => {
      if (init && init.method === 'POST') return Promise.resolve({ json: () => Promise.resolve({ ok: false, error: '这条消息之前没有完整回合，无法撤回' }) });
      return okGet(ONE)();
    },
  });
  const Comp = registered[0].component;
  const inst = mountWith(Comp, { sessionId: 's1', node: nodeOf('u1', 0, '旧字'), renderMessageImages: null });
  await flush(); inst.render();
  find(inst.tree, 'recall').props.onClick();
  await settle(inst, () => !!find(inst.tree, 'error'));
  assert.deepEqual(opened, [], '失败时不得切换会话');
  assert.match(textOf(find(inst.tree, 'error')), /没有完整回合/);
});

test('气泡保持正常交互：不劫持点击复制，稳定类名不随宿主构建漂移', async () => {
  const { registered, mountWith } = boot({ fetchImpl: okGet(ONE) });
  const Comp = registered[0].component;
  const inst = mountWith(Comp, { sessionId: 's1', node: nodeOf('u1', 0, '正常的文字'), renderMessageImages: null });
  await flush(); inst.render();

  const bubble = find(inst.tree, 'bubble');
  assert.ok(bubble, '存在气泡');
  assert.equal(bubble.props.onClick, undefined, '普通气泡绝不劫持整块点击复制');
  assert.equal(bubble.props.title, undefined, '普通气泡绝不展示复制提示');
  assert.match(bubble.props.className, /dsh-he-bubble/, '包含插件稳定 bubble 类名');

  const row = find(inst.tree, 'row');
  assert.match(row.props.className, /dsh-he-row/, '外层挂载插件稳定 row 类名');

  const actions = find(inst.tree, 'actions');
  assert.ok(actions, '存在操作栏');
  assert.match(actions.props.className, /dsh-he-actionRow/, '操作栏挂载插件稳定 actionRow 类名');

  const copyBtn = find(inst.tree, 'copy');
  const recallBtn = find(inst.tree, 'recall');
  const editBtn = find(inst.tree, 'edit');
  assert.ok(copyBtn && recallBtn && editBtn, '复制、撤回、编辑三键齐全');
  assert.match(copyBtn.props.className, /dsh-he-action/, '复制小按键拥有插件稳定 action 类名');
  assert.match(recallBtn.props.className, /dsh-he-action/, '撤回小按键拥有插件稳定 action 类名');
  assert.match(editBtn.props.className, /dsh-he-action/, '编辑小按键拥有插件稳定 action 类名');
});

test('编辑输入框快捷键：Esc 取消，Ctrl+Enter 保存', async () => {
  let savedText = '';
  const { registered, mountWith } = boot({
    fetchImpl: (url, init) => {
      if (init && init.method === 'POST') {
        savedText = JSON.parse(init.body).text;
        return Promise.resolve({ json: () => Promise.resolve({ ok: true, seq: 1, revision: 2 }) });
      }
      return okGet(ONE)();
    },
  });
  const Comp = registered[0].component;
  const inst = mountWith(Comp, { sessionId: 's1', node: nodeOf('u1', 0, '初始文字'), renderMessageImages: null });
  await flush(); inst.render();

  find(inst.tree, 'edit').props.onClick();
  inst.render();

  const ta = find(inst.tree, 'textarea');
  // 模拟按 Esc 取消
  let escPrevented = false;
  ta.props.onKeyDown({ key: 'Escape', ctrlKey: false, metaKey: false, preventDefault: () => { escPrevented = true; } });
  inst.render();
  assert.ok(escPrevented, 'Esc 触发并阻止默认');
  assert.ok(!find(inst.tree, 'textarea'), 'Esc 取消后退出编辑态');

  // 重新进入编辑态并测试 Ctrl+Enter
  find(inst.tree, 'edit').props.onClick();
  inst.render();
  find(inst.tree, 'textarea').props.onChange({ target: { value: '通过快捷键保存' } });
  inst.render();
  const currentTa = find(inst.tree, 'textarea');
  let enterPrevented = false;
  currentTa.props.onKeyDown({ key: 'Enter', ctrlKey: true, metaKey: false, preventDefault: () => { enterPrevented = true; } });
  await flush(); inst.render();
  assert.ok(enterPrevented, 'Ctrl+Enter 触发并阻止默认');
  assert.equal(savedText, '通过快捷键保存', 'Ctrl+Enter 成功触发保存');
  assert.ok(!find(inst.tree, 'textarea'), '保存后恢复为气泡');
});

/* ---------------- 删除 ---------------- */

test('删除需要二次确认；取消不发起任何请求', async () => {
  const { registered, mountWith, fetchCalls } = boot({ fetchImpl: okGet(ONE) });
  const Comp = registered[0].component;
  const inst = mountWith(Comp, { sessionId: 's1', node: nodeOf('u1', 0, '原文'), renderMessageImages: null });
  await flush(); inst.render();
  find(inst.tree, 'delete').props.onClick();
  inst.render();
  assert.ok(find(inst.tree, 'confirm'), '出现确认条');
  assert.match(textOf(find(inst.tree, 'confirm')), /删除这条消息/);
  find(inst.tree, 'confirm-cancel').props.onClick();
  inst.render();
  assert.ok(!find(inst.tree, 'confirm'), '取消后确认条消失');
  assert.ok(find(inst.tree, 'bubble'), '气泡仍在');
  assert.equal(fetchCalls.filter(c => c.url === '/history-editor/delete').length, 0, '取消不得发请求');
});

test('确认后提交 seq 与 revision，成功后气泡移除', async () => {
  const posts = [];
  let revision = 5;
  const { registered, mountWith } = boot({
    fetchImpl: (url, init) => {
      if (init && init.method === 'POST') {
        posts.push({ url, body: JSON.parse(init.body) });
        revision += 1;
        return Promise.resolve({ json: () => Promise.resolve({ ok: true, revision, removed: 1, removedIds: ['u1'] }) });
      }
      return okGet(ONE, revision)();
    },
  });
  const Comp = registered[0].component;
  const inst = mountWith(Comp, { sessionId: 's1', node: nodeOf('u1', 0, '原文'), renderMessageImages: null });
  await flush(); inst.render();
  find(inst.tree, 'delete').props.onClick();
  inst.render();
  find(inst.tree, 'confirm-delete').props.onClick();
  await flush(); inst.render();
  assert.equal(posts.length, 1);
  assert.equal(posts[0].url, '/history-editor/delete');
  assert.deepEqual(posts[0].body, { sessionId: 's1', seq: 0, revision: 5 });
  assert.ok(!find(inst.tree, 'confirm'), '成功后退出确认态');
  assert.ok(!find(inst.tree, 'bubble'), '目标气泡从界面移除');
});

test('后端拒绝删除时显示原因且气泡保留', async () => {
  const { registered, mountWith } = boot({
    fetchImpl: (url, init) => {
      if (init && init.method === 'POST') return Promise.resolve({ json: () => Promise.resolve({ ok: false, error: '请等待回复结束、排队消息处理完，再删除历史消息' }) });
      return okGet(ONE)();
    },
  });
  const Comp = registered[0].component;
  const inst = mountWith(Comp, { sessionId: 's1', node: nodeOf('u1', 0, '原文'), renderMessageImages: null });
  await flush(); inst.render();
  find(inst.tree, 'delete').props.onClick();
  inst.render();
  find(inst.tree, 'confirm-delete').props.onClick();
  await flush(); inst.render();
  const err = find(inst.tree, 'error');
  assert.ok(err, '显示拒绝原因');
  assert.match(textOf(err), /等待回复结束/);
  assert.ok(find(inst.tree, 'bubble'), '气泡必须保留');
});

test('不可删除的消息：删除键置灰且点击不进入确认', async () => {
  const { registered, mountWith } = boot({
    fetchImpl: okGet([
      { id: 'u1', seq: 0, role: 'user', text: '原文', editable: true, reason: '', deletable: false, delReason: '这条已修订消息已被折叠，不能在当前位置删除' },
    ]),
  });
  const Comp = registered[0].component;
  const inst = mountWith(Comp, { sessionId: 's1', node: nodeOf('u1', 0, '原文'), renderMessageImages: null });
  await flush(); inst.render();
  const btn = find(inst.tree, 'delete');
  assert.ok(btn.props.disabled, '删除键置灰');
  btn.props.onClick();
  inst.render();
  assert.ok(!find(inst.tree, 'confirm'), '置灰时点击不进入确认');
});

test('CSS 回归：隐藏操作行的规则必须限定在用户气泡内', () => {
  // 真实事故：隐藏规则写成全局选择器后，助手按钮行被永久压成 opacity:0，
  // 元素仍在、仍可点，但永远看不见，且没有任何规则能恢复它。
  const styleBlock = SRC.match(/var CSS =([\s\S]*?);\n\n    function apply/);
  assert.ok(styleBlock, 'client.js 必须包含 CSS 定义');
  const css = (styleBlock[1].match(/"((?:[^"\\]|\\.)*)"/g) || [])
    .map(s => s.slice(1, -1).replace(/\\"/g, '"')).join('');

  // 所有把操作行设为 opacity:0 的规则，必须逐条限定在用户气泡内。
  const rules = css.match(/[^{}]*\{[^{}]*opacity:0[^{}]*\}/g) || [];
  const hiders = rules.filter(rule => /\.dsh-he-actionRow/.test(rule.split('{')[0]));
  assert.ok(hiders.length > 0, '用户气泡仍应有 hover 显隐规则');
  for (const rule of hiders) {
    for (const sel of rule.split('{')[0].split(',').map(s => s.trim())) {
      if (!/\.dsh-he-actionRow/.test(sel)) continue;
      assert.match(sel, /\.dsh-he-row/,
        '隐藏操作行的选择器必须限定在用户气泡内，否则会连带压住宿主原生的助手按钮行：' + sel);
    }
  }
});

test('removedIds 是刷新后的唯一删除依据；列表缺席本身不算删除', async () => {
  const goneBoot = boot({ fetchImpl: okGet([], 7, ['u1']) });
  const Gone = goneBoot.registered[0].component;
  const gone = goneBoot.mountWith(Gone, { sessionId: 'removed-refresh', node: nodeOf('u1', 0, '旧节点正文'), renderMessageImages: null });
  await flush(); gone.render();
  assert.ok(!find(gone.tree, 'bubble'), '刷新后 Host 明示 removedIds 的气泡必须隐藏');

  const compactBoot = boot({ fetchImpl: okGet([], 7, []) });
  const Compact = compactBoot.registered[0].component;
  const compact = compactBoot.mountWith(Compact, { sessionId: 'compressed-refresh', node: nodeOf('u1', 0, '压缩但未删除'), renderMessageImages: null });
  await flush(); compact.render();
  assert.match(textOf(find(compact.tree, 'bubble')), /压缩但未删除/, '不得用 list 缺席推断删除');
});
