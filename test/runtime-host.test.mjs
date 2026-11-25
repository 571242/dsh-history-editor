import { test } from 'node:test';
import assert from 'node:assert/strict';
import { verifyRuntime } from '../verify-runtime.js';
import { apply } from '../index.js';
import { loadHost, hostNodeModules } from './host-path.mjs';

const host = hostNodeModules() ? await loadHost() : null;
const skip = host ? false : '设置 DSH_HISTORY_EDITOR_HOST_NODE_MODULES 指向当前宿主包以验证启动兼容性';

function fixture() {
  const ctx = new host.Context();
  const sessions = new host.SessionStore(ctx);
  const publications = [];
  for (const name of ['session/created', 'session/event']) ctx.on(name, () => publications.push(name));
  const tokenMeter = new host.TokenMeter(ctx);
  return { ctx, sessions, publications, tokenMeter };
}

test('新版 prepare 只读：自检只写独立 Session，不发布真实 Store 事件', { skip }, async () => {
  const f = fixture();
  try {
    const prepared = f.sessions.prepare(undefined, { meta: { cwd: process.cwd() } });
    assert.throws(() => prepared.append('user/message', {}), /cannot append outside a SessionStore/);
    const report = await verifyRuntime(f);
    assert.equal(report.ok, true);
    assert.deepEqual(report.afterEdit, ['edited again', 'answer', 'later']);
    assert.deepEqual(report.restored, report.afterEdit);
    assert.ok(['available', 'needs-host-patch'].includes(report.deletion));
    assert.deepEqual(f.publications, []);
  } finally { await f.ctx.fiber.dispose(); }
});

test('插件启动通过真实宿主自检后注册全部 HTTP 路由，失败时不注册', { skip }, async () => {
  const f = fixture();
  const routes = [];
  try {
    await apply({
      ...f,
      webServer: { register: route => { routes.push(route); return () => {}; } },
      effect: fn => fn(),
    });
    assert.deepEqual(routes.map(route => route.path), [
      '/history-editor/messages', '/history-editor/edit', '/history-editor/delete', '/history-editor/recall',
    ]);
    assert.deepEqual(f.publications, []);
    const rejected = [];
    await assert.rejects(apply({
      sessions: { prepare() { throw new Error('incompatible host'); } },
      webServer: { register: route => rejected.push(route) },
    }), /宿主兼容检查失败/);
    assert.deepEqual(rejected, []);
    // Leave the diagnostic report from the successful path, not the deliberate failure probe.
    await apply({ ...f, webServer: { register: () => () => {} }, effect: fn => fn() });
  } finally { await f.ctx.fiber.dispose(); }
});
