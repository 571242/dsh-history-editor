import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHistoryApi, withText } from '../core.js';
function fixture() {
  const events = [
    { seq: 0, type: 'user/message', data: { id: 'u1', role: 'user', content: [{ type: 'text', text: 'old' }], source: { kind: 'user' } } },
    { seq: 1, type: 'assistant/message', data: { message: { id: 'a1', role: 'assistant', content: [{ type: 'text', text: 'answer' }] } } },
    { seq: 2, type: 'user/message', data: { id: 'u2', role: 'user', content: [{ type: 'text', text: 'later' }], source: { kind: 'user' } } },
  ];
  const nodes = [0, 1, 2];
  const session = {
    historyEditorProtocol: 1,
    get seq() { return events.length; }, surface: { nodes }, eventAt: n => events[n], snapshotEvents: () => events,
    // 空 system/message 载体在真实宿主里投影为 null，替身必须照做，否则会漏掉过滤逻辑。
    deriveEventMessage: ev => {
      if (ev.type === 'user/message') return ev.data;
      if (ev.type !== 'system/message' && ev.type !== 'assistant/message' && ev.type !== 'tool/result') return null;
      const message = ev.data.message;
      if (Array.isArray(message.content) && message.content.length === 0 && ev.type !== 'tool/result') return null;
      return message;
    },
    append(type, data, opts) {
      const ev = { seq: events.length, type, data, ...opts }; events.push(ev);
      const op = opts?.surfaceOp;
      if (op && typeof op === 'object') {
        const from = nodes.indexOf(op.startSeq);
        const to = nodes.indexOf(op.endSeq);
        nodes.splice(from, to - from + 1, ev.seq);
      }
      return ev;
    },
  };
  const agent = { status: 'idle', inbox: { hasPending: false } };
  const api = createHistoryApi({ sessions: { get: () => session, flush: async () => true }, agents: { get: () => agent }, tokenMeter: { estimateMessage: () => 10 } });
  return { api, events, nodes, session, agent };
}
test('early user edit keeps the assistant event and later user, retains audit and identity', async () => {
  const f = fixture(); const revision = f.api.list('s').revision;
  await f.api.edit({ sessionId: 's', seq: 0, text: 'new', revision });
  assert.deepEqual(f.api.list('s').messages.map(m => m.text), ['new', 'later']);
  assert.equal(f.events[0].data.content[0].text, 'old');
  assert.equal(f.events[4].data.id, 'u1');
  assert.equal(f.api.list('s').messages[0].id, 'u1');
  assert.equal(f.events[3].type, 'compaction/prune');
  assert.deepEqual(f.events[4].sourceEventSeqs, [0]);
});
test('same logical message can be edited repeatedly', async () => {
  const f = fixture(); await f.api.edit({ sessionId: 's', seq: 0, text: 'new', revision: 3 });
  await f.api.edit({ sessionId: 's', seq: 4, text: 'again', revision: 5 });
  assert.deepEqual(f.api.list('s').messages.map(m => m.text), ['again', 'later']);
});
test('compacted saved edits still map to the original bubble but stay read-only', async () => {
  const f = fixture(); await f.api.edit({ sessionId: 's', seq: 0, text: 'new', revision: 3 });
  f.nodes.splice(0, 1);
  const row = f.api.list('s').messages.find(message => message.id === 'u1');
  assert.equal(row.text, 'new'); assert.equal(row.editable, false);
  await assert.rejects(f.api.edit({ sessionId: 's', seq: row.seq, text: 'again', revision: 5 }), /折叠/);
});
test('stale revisions and running agents append nothing', async () => {
  const f = fixture();
  await assert.rejects(f.api.edit({ sessionId: 's', seq: 0, text: 'new', revision: 1 }), /历史已变化/);
  f.agent.status = 'running';
  await assert.rejects(f.api.edit({ sessionId: 's', seq: 0, text: 'new', revision: 3 }), /等待回复/);
  assert.equal(f.events.length, 3);
});
test('recall uses the original position and current draft after repeated editing', async () => {
  const f = fixture();
  // Mark the fixture messages as original transcript entries.
  for (const event of f.events) event.surfaceOp = 'append';
  await f.api.edit({ sessionId: 's', seq: 2, text: 'edited later', revision: 3 });
  const result = f.api.recall({ sessionId: 's', messageId: 'u2' });
  assert.equal(result.boundary, 1); assert.equal(result.text, 'edited later');
  assert.equal(f.events.length, 5);
  f.agent.status = 'running';
  assert.throws(() => f.api.recall({ sessionId: 's', messageId: 'u2' }), /等待/);
});
test('recall carries preceding saved edits and prefers a completed-turn boundary', async () => {
  const f = fixture(); for (const event of f.events) event.surfaceOp = 'append';
  f.events.push({ seq: 3, type: 'turn/end', data: {} });
  f.events.push({ seq: 4, type: 'user/message', surfaceOp: 'append', data: { id: 'u3', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'target' }] } });
  f.nodes.push(4);
  await f.api.edit({ sessionId: 's', seq: 0, text: 'saved before', revision: 5 });
  const result = f.api.recall({ sessionId: 's', messageId: 'u3' });
  assert.equal(result.boundary, 3); assert.deepEqual(result.edits, [{ id: 'u1', text: 'saved before' }]);
  assert.equal(result.text, 'target'); assert.equal(f.events.length, 7);
});
test('text edit preserves non-text blocks and whitespace', () => {
  const image = { type: 'image', attachment: { attachmentId: 'img1' } };
  const m = withText({ content: [{ type: 'text', text: 'a' }, image, { type: 'text', text: 'b' }] }, '  new\n');
  assert.deepEqual(m.content, [{ type: 'text', text: '  new\n' }, image]);
});
test('blank text and missing target rejected; no-op stays zero-write', async () => {
  const f = fixture();
  await assert.rejects(f.api.edit({ sessionId: 's', seq: 0, text: '', revision: 3 }), /非空/);
  await assert.rejects(f.api.edit({ sessionId: 's', seq: 90, text: 'new', revision: 3 }), /折叠/);
  assert.equal((await f.api.edit({ sessionId: 's', seq: 0, text: 'old', revision: 3 })).unchanged, true);
  assert.equal(f.events.length, 3);
});

/* ---------- 删除 ---------- */

test('delete user message hides it and keeps later messages intact', async () => {
  const f = fixture();
  const result = await f.api.remove({ sessionId: 's', seq: 0, revision: 3 });
  assert.deepEqual(result.removedIds, ['u1']);
  assert.deepEqual(f.api.list('s').removedIds, ['u1']);
  assert.deepEqual(f.api.list('s').messages.map(m => m.text), ['later']);
  const prune = f.events[3];
  const carrier = f.events[4];
  assert.equal(prune.type, 'compaction/prune');
  assert.deepEqual(prune.data.shadowedRange, { start: 0, end: 0 });
  assert.deepEqual(prune.data.shadowedSeqs, [0]);
  assert.equal(prune.data.shadowedTokenCount, 10);
  // 载体必须是空 system/message：这条是删除在宿主上成立的前提。
  assert.equal(carrier.type, 'system/message');
  assert.deepEqual(carrier.data.message.content, []);
  assert.equal(carrier.data.message.role, 'system');
  assert.equal(carrier.data.message.source.kind, 'system-prompt');
  assert.deepEqual(carrier.surfaceOp, { op: 'replace', startSeq: 0, endSeq: 0 });
  assert.deepEqual(carrier.sourceEventSeqs, [0]);
});

test('edited then deleted user message does not return through saved fallback', async () => {
  const f = fixture();
  await f.api.edit({ sessionId: 's', seq: 0, text: 'saved edit', revision: 3 });
  await f.api.remove({ sessionId: 's', seq: 4, revision: 5 });
  const listed = f.api.list('s');
  assert.deepEqual(listed.removedIds, ['u1']);
  assert.equal(listed.messages.some(message => message.id === 'u1'), false);
});

test('ordinary compaction does not count as deletion', () => {
  const f = fixture();
  f.events.push({ seq: 3, type: 'compaction/prune', data: { shadowedSeqs: [0] } });
  assert.deepEqual(f.api.list('s').removedIds, []);
});

test('delete of every user message empties the list', async () => {
  const f = fixture();
  await f.api.remove({ sessionId: 's', seq: 2, revision: 3 });
  await f.api.remove({ sessionId: 's', seq: 0, revision: 5 });
  assert.deepEqual(f.api.list('s').messages.map(m => m.text), []);
});

test('delete refuses injected context, stale revisions and running agents', async () => {
  const f = fixture();
  // 注入的 user 上下文（source.kind !== 'user'）只读也不是删除目标。
  f.events.push({ seq: 3, type: 'user/message', surfaceOp: 'append', data: { id: 'ctx', role: 'user', source: { kind: 'system' }, content: [{ type: 'text', text: 'injected' }] } });
  f.nodes.push(3);
  assert.equal(f.api.list('s').messages.some(m => m.id === 'ctx'), false);
  await assert.rejects(f.api.remove({ sessionId: 's', seq: 0, revision: 1 }), /历史已变化/);
  const f2 = fixture(); f2.agent.status = 'running';
  await assert.rejects(f2.api.remove({ sessionId: 's', seq: 0, revision: 3 }), /等待回复/);
  const f3 = fixture();
  await assert.rejects(f3.api.remove({ sessionId: 's', seq: 90, revision: 3 }), /折叠/);
  assert.equal(f3.events.length, 3);
});

test('delete refuses a range that would cover the system prompt', async () => {
  const f = fixture();
  f.events.unshift({ seq: 0, type: 'system/message', surfaceOp: 'append', data: { message: { id: 'sys', role: 'system', source: { kind: 'system-prompt' }, content: [{ type: 'text', text: 'SYS' }] } } });
  // 重排 seq，使 system 落在 surface 节点 0。
  f.events.forEach((event, index) => { event.seq = index; });
  f.nodes.length = 0; f.nodes.push(0, 1, 2, 3);
  await assert.rejects(f.api.remove({ sessionId: 's', seq: 0, revision: 4 }), /系统提示/);
});

test('unpatched host refuses deletion before appending anything, edit unaffected', async () => {
  const f = fixture(); delete f.session.historyEditorProtocol;
  await assert.rejects(f.api.remove({ sessionId: 's', seq: 0, revision: 3 }), /宿主补丁/);
  assert.equal(f.events.length, 3);
  await f.api.edit({ sessionId: 's', seq: 0, text: 'safe user edit', revision: 3 });
  assert.equal(f.api.list('s').messages[0].text, 'safe user edit');
});

/* ---------- 助手回复已不在功能范围内 ---------- */

test('assistant replies are neither editable nor deletable nor recallable', async () => {
  const f = fixture();
  const replies = f.api.list('s').messages.filter(message => message.role === 'assistant');
  assert.deepEqual(replies, [], 'list 不再返回助手回复');
  for (const event of f.events) event.surfaceOp = 'append';
  assert.throws(() => f.api.recall({ sessionId: 's', messageId: 'a1' }), /找不到这条原始消息/);
  await assert.rejects(f.api.edit({ sessionId: 's', seq: 1, text: 'rewrite', revision: 3 }), /仅开放人类用户消息/);
  await assert.rejects(f.api.remove({ sessionId: 's', seq: 1, revision: 3 }), /不可删除/);
  assert.equal(f.events.length, 3, '对助手回复的任何操作都不得写入日志');
});

