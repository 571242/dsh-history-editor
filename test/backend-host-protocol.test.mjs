// 真实宿主协议测试：用当前安装版 format-v4 编码器 + restore 验证用户改写与撤回。
// 删除只在宿主补丁可用时验证成功路径；官方宿主必须零写入拒绝。
// 没有真实宿主时整体 skip，并给出配置方法；本文件不依赖 .scratch 的具体路径。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHistoryApi } from '../core.js';
import { loadHost, hostNodeModules } from './host-path.mjs';

const host = hostNodeModules() ? await loadHost() : null;
const skip = host ? false : '找不到真实宿主包：设置 DSH_HISTORY_EDITOR_HOST_NODE_MODULES 后重跑；找到但损坏的宿主会直接报错，不会跳过';

const HDR = { version: 4, id: 'backend-host', createdAt: 1, isSeeded: false, cwd: 'F:/SPACE/dsh-history-editor', delegationDepth: 0 };
const modelSource = { kind: 'model', provider: 'test', model: 'test' };
const userSource = { kind: 'user' };

/** 与真实会话一致：system/message 是受保护的 surface 头，且落在已开启的 turn/step 内。 */
function build(session) {
  session.append('turn/start', { turn: 1 });
  session.append('step/start', { turn: 1, step: 1 });
  session.append('system/message', { turn: 1, step: 1, message: { id: 'sys', role: 'system', source: { kind: 'system-prompt' }, content: [{ type: 'text', text: 'SYS' }] } }, { surfaceOp: 'append' });
  session.append('user/message', { id: 'u1', role: 'user', source: userSource, content: [{ type: 'text', text: 'question' }] }, { surfaceOp: 'append' });
  session.append('assistant/message', { turn: 1, step: 1, stream: [], message: { id: 'a1', role: 'assistant', source: modelSource, content: [{ type: 'text', text: 'first' }] } }, { surfaceOp: 'append' });
  session.append('assistant/message', { turn: 1, step: 1, stream: [], message: { id: 'a2', role: 'assistant', source: modelSource, content: [{ type: 'text', text: 'final' }] } }, { surfaceOp: 'append' });
  session.append('step/end', { turn: 1, step: 1 });
  session.append('turn/end', { turn: 1, reason: { kind: 'completed' } });
  session.append('user/message', { id: 'u2', role: 'user', source: userSource, content: [{ type: 'text', text: 'later' }] }, { surfaceOp: 'append' });
  return session;
}

function apiFor(session, meter) {
  return createHistoryApi({
    sessions: { get: () => session, flush: async () => true },
    agents: { get: () => ({ status: 'idle', inbox: { hasPending: false } }) },
    tokenMeter: meter ?? { estimateMessage: () => 7 },
  });
}

/** 走真实 format-v4：逐事件编码 → createRestore → decodeRow → finish → Session.fromRestore。 */
function encodeAndRestore(catalog, Session, session) {
  const rows = session.snapshotEvents().map(event => JSON.parse(JSON.stringify(catalog.encodeCurrentEvent(event))));
  const restore = catalog.createRestore(catalog.encodeCurrentHeader(HDR, 0), { recovery: 'strict', validation: 'current' });
  for (const row of rows) restore.decodeRow(row);
  const artifact = restore.finish();
  return Session.fromRestore('backend-host', artifact.events, artifact.header, artifact.inheritedEventCount ?? 0, undefined);
}

test('新版撤回：当前修订正文与前置修订经过真实 codec 重放仍保持一致', { skip }, async () => {
  const session = build(host.Session.create('backend-host', undefined, HDR));
  const api = apiFor(session);
  let row = api.list('s').messages.find(message => message.id === 'u1');
  await api.edit({ sessionId: 's', seq: row.seq, text: 'saved prefix', revision: session.seq });
  row = api.list('s').messages.find(message => message.id === 'u2');
  await api.edit({ sessionId: 's', seq: row.seq, text: 'saved draft', revision: session.seq });
  const before = session.seq;
  const recall = api.recall({ sessionId: 's', messageId: 'u2' });
  assert.equal(recall.boundary, 7);
  assert.equal(recall.text, 'saved draft');
  assert.deepEqual(recall.edits, [{ id: 'u1', text: 'saved prefix' }]);
  assert.equal(session.seq, before, '撤回准备不改原会话');
  const restored = encodeAndRestore(host.catalog, host.Session, session);
  assert.deepEqual(apiFor(restored).recall({ sessionId: 's', messageId: 'u2' }), recall);
});

const texts = session => session.deriveMessages().filter(Boolean).map(message => ({
  id: message.id, text: (message.content ?? []).filter(part => part.type === 'text').map(part => part.text).join('\n'),
}));

test('真实 v4 编码器 + restore：用户改写往返一致；删除按宿主补丁验证', { skip }, async () => {
  const { Session, catalog } = host;
  const session = build(Session.create('backend-host', undefined, HDR));
  const api = apiFor(session);

  // 基线：编码/还原必须无损（先证明没有误报）。
  assert.deepEqual(texts(encodeAndRestore(catalog, Session, session)).map(row => row.id), ['sys', 'u1', 'a1', 'a2', 'u2']);
  // 助手回复不在本插件的可见/可写范围内。
  assert.deepEqual(api.list('s').messages.map(message => message.role), ['user', 'user']);

  // 用户改写两次：坐标来自被替换位置，替换后历史必须被真实日志接受并读回。
  let row = api.list('s').messages.find(message => message.id === 'u1');
  await api.edit({ sessionId: 's', seq: row.seq, text: 'edited once', revision: session.seq });
  row = api.list('s').messages.find(message => message.id === 'u1');
  await api.edit({ sessionId: 's', seq: row.seq, text: 'edited twice', revision: session.seq });
  assert.equal(api.list('s').messages.find(message => message.id === 'u1').text, 'edited twice');
  assert.equal(api.list('s').messages.find(message => message.id === 'u1').edited, true);
  const afterEdit = encodeAndRestore(catalog, Session, session);
  assert.deepEqual(texts(afterEdit).map(r => r.id), ['sys', 'u1', 'a1', 'a2', 'u2']);
  assert.equal(texts(afterEdit).find(r => r.id === 'u1').text, 'edited twice');
  // 助手原文一字不改。
  assert.equal(texts(afterEdit).find(r => r.id === 'a2').text, 'final');

  // 删除用户消息：空 system/message 载体，带审计标记。
  const target = api.list('s').messages.find(message => message.id === 'u2');
  if (session.historyEditorProtocol !== 1) {
    const revision = session.seq;
    await assert.rejects(api.remove({ sessionId: 's', seq: target.seq, revision }), /宿主补丁/);
    assert.equal(session.seq, revision, '官方宿主拒绝删除时不得写入任何事件');
    return;
  }
  const removed = await api.remove({ sessionId: 's', seq: target.seq, revision: session.seq });
  assert.deepEqual(removed.removedIds, ['u2']);
  assert.deepEqual(api.list('s').messages.map(message => message.id), ['u1']);
  const afterRemove = encodeAndRestore(catalog, Session, session);
  assert.deepEqual(texts(afterRemove).map(r => r.id), ['sys', 'u1', 'a1', 'a2']);
  assert.deepEqual(texts(afterRemove).find(r => r.id === 'a1').text, 'first');
  assert.deepEqual(apiFor(afterRemove).list('s').removedIds, ['u2']);
});

test('助手回复永远不会成为改写或删除目标', { skip }, async () => {
  const { Session, catalog } = host;
  const session = build(Session.create('backend-host', undefined, HDR));
  const api = apiFor(session);
  const before = session.seq;
  const assistant = session.snapshotEvents().find(event => event.type === 'assistant/message');
  const seq = assistant.seq;
  await assert.rejects(api.edit({ sessionId: 's', seq, text: 'rewrite', revision: before }), /仅开放人类用户消息/);
  await assert.rejects(api.remove({ sessionId: 's', seq, revision: before }), session.historyEditorProtocol === 1 ? /不可删除/ : /宿主补丁/);
  assert.equal(session.seq, before, '对助手回复的任何操作都不得追加事件');
  assert.deepEqual(texts(encodeAndRestore(catalog, Session, session)).map(r => r.id), ['sys', 'u1', 'a1', 'a2', 'u2']);
});

test('宿主仍拒绝普通 append 的乱序 turn/step（校验未被禁用）', { skip }, async () => {
  const { Session, catalog } = host;
  const session = build(Session.create('backend-host', undefined, HDR));
  // 没有开启的 turn/step，普通 append 的助手消息必须照旧被拒。
  session.append('assistant/message', { turn: 1, step: 1, stream: [], message: { id: 'a3', role: 'assistant', source: modelSource, content: [{ type: 'text', text: 'z' }] } }, { surfaceOp: 'append' });
  assert.throws(() => encodeAndRestore(catalog, Session, session), /does not match an open turn and step/);
});

test('删除载体必须是正坐标：turn/step 0 被编码器拒绝', { skip }, async () => {
  const { Session, catalog } = host;
  const session = Session.create('backend-host', undefined, HDR);
  session.append('turn/start', { turn: 1 });
  session.append('step/start', { turn: 1, step: 1 });
  session.append('user/message', { id: 'u1', role: 'user', source: userSource, content: [{ type: 'text', text: 'q' }] }, { surfaceOp: 'append' });
  session.append('compaction/prune', { shadowedRange: { start: 2, end: 2 }, shadowedSeqs: [2], shadowedTokenCount: 7 });
  session.append('system/message', { turn: 0, step: 0, message: { id: 'del', role: 'system', source: { kind: 'system-prompt' }, content: [] }, historyEditor: { op: 'delete', removedIds: ['u1'] } }, { surfaceOp: { op: 'replace', startSeq: 2, endSeq: 2 }, sourceEventSeqs: [2] });
  assert.throws(() => session.snapshotEvents().forEach(event => catalog.encodeCurrentEvent(event)), /turn must be positive/);
});

test('真实计价服务：用户改写更新上下文但不重复计费', {skip}, async () => {
  const ctx=new host.Context();
  const projections=new host.SessionProjectionRegistry(ctx);
  const meter=new host.TokenMeter(ctx);
  if (typeof meter[host.Service.init] === 'function') await meter[host.Service.init]();
  const session=build(host.Session.create('backend-host',undefined,HDR));
  const before=meter.measure(session);
  const api=apiFor(session,meter);
  const row=api.list('s').messages.find(m=>m.id==='u1');
  const editStart=session.seq;
  await api.edit({sessionId:'s',seq:row.seq,text:'longer replacement text '.repeat(12),revision:session.seq});
  const after=meter.measure(session);
  assert.ok(after.surfaceTokens>before.surfaceTokens);
  const updated=api.list('s').messages.find(m=>m.id==='u1');
  if (session.historyEditorProtocol === 1) {
    await api.remove({sessionId:'s',seq:updated.seq,revision:session.seq});
    assert.ok(meter.measure(session).surfaceTokens<after.surfaceTokens);
  } else {
    const revision = session.seq;
    await assert.rejects(api.remove({sessionId:'s',seq:updated.seq,revision}), /宿主补丁/);
    assert.equal(session.seq, revision);
  }
  const usage=projections.registrations.get('tokenUsage').def;
  let state=usage.init();
  const first={type:'assistant/message',surfaceOp:'append',data:{turn:1,step:1,usage:{inputTokens:20,outputTokens:4}}};
  const second={type:'assistant/message',surfaceOp:'append',data:{turn:2,step:1,usage:{inputTokens:30,outputTokens:8}}};
  state=usage.apply(state,first);state=usage.apply(state,second);
  const saved=structuredClone(state);
  for (const event of session.snapshotEvents().slice(editStart)) state=usage.apply(state,event);
  assert.deepEqual(state,saved, '用户历史修改不重复计入模型请求费用');
  await ctx.fiber.dispose();
});
