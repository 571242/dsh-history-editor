// Runs only on detached, unpublished test Sessions. Never opens or mutates real history.
// 只校验插件仍然实际提供的东西：人类用户消息的改写与序列化重放。
// 删除单独探测：它会要求宿主补丁，缺补丁时是「预期拒绝」，不是启动失败。
import { createHistoryApi } from './core.js';
export async function verifyRuntime(ctx) {
  const source = { kind: 'user' };
  const modelSource = { kind: 'model', provider: 'runtime-check', model: 'runtime-check' };
  const session = ctx.sessions.prepare(undefined, { meta: { cwd: process.cwd() } });
  session.append('user/message', { id: 'probe-first', role: 'user', content: [{ type: 'text', text: 'old' }], source }, { surfaceOp: 'append' });
  session.append('turn/start', { turn: 1 });
  session.append('step/start', { turn: 1, step: 1 });
  session.append('assistant/message', { turn: 1, step: 1, stream: [], message: { id: 'probe-assistant', role: 'assistant', source: modelSource, content: [{ type: 'text', text: 'answer' }] } }, { surfaceOp: 'append' });
  session.append('step/end', { turn: 1, step: 1 });
  session.append('turn/end', { turn: 1, reason: { kind: 'completed' } });
  session.append('user/message', { id: 'probe-later', role: 'user', content: [{ type: 'text', text: 'later' }], source }, { surfaceOp: 'append' });
  const api = createHistoryApi({
    sessions: { get: () => session, flush: async () => true },
    agents: { get: () => ({ status: 'idle', inbox: { hasPending: false } }) },
    tokenMeter: ctx.tokenMeter,
  });
  const before = session.deriveMessages().map(message => message.content[0].text);
  let row = api.list('probe').messages.find(message => message.id === 'probe-first');
  await api.edit({ sessionId: 'probe', seq: row.seq, text: 'edited', revision: session.seq });
  row = api.list('probe').messages.find(message => message.id === 'probe-first');
  await api.edit({ sessionId: 'probe', seq: row.seq, text: 'edited again', revision: session.seq });
  const afterEdit = session.deriveMessages().map(message => message.content[0].text);
  // 助手回复必须始终不出现在可编辑/可删除范围内（本插件的功能边界）。
  const assistantRows = api.list('probe').messages.filter(message => message.role === 'assistant');
  const replay = ctx.sessions.prepare(undefined, { seed: JSON.parse(JSON.stringify(session.snapshotEvents())), meta: { cwd: process.cwd() } });
  const restored = replay.deriveMessages().map(message => message.content[0].text);
  const ok = JSON.stringify(afterEdit) === JSON.stringify(['edited again', 'answer', 'later'])
    && assistantRows.length === 0
    && JSON.stringify(restored) === JSON.stringify(afterEdit);
  // 删除探测：成功或「缺宿主补丁」的预期拒绝都算可接受状态。
  let deletion = 'unknown';
  try {
    const last = api.list('probe').messages.find(message => message.id === 'probe-later');
    const removed = await api.remove({ sessionId: 'probe', seq: last.seq, revision: session.seq });
    deletion = JSON.stringify(removed.removedIds) === JSON.stringify(['probe-later']) ? 'available' : 'mismatch';
  } catch (error) {
    deletion = /宿主补丁/.test(String(error.message)) ? 'needs-host-patch' : 'error: ' + error.message;
  }
  return { ok, before, afterEdit, restored, deletion,
    scope: 'Actual runtime detached Session user edit/serialized-seed replay; assistant replies excluded by design; deletion probed separately; persistence flush stubbed; no real sessions touched.' };
}
