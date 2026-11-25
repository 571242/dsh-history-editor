import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { patchEntry } from '../host-patch/build-current.mjs';
import { loadHost, hostNodeModules } from './host-path.mjs';
const host = hostNodeModules() ? await loadHost() : null;
const skip = host ? false : 'Set DSH_HISTORY_EDITOR_HOST_NODE_MODULES';
const HDR = { version: 4, id: 'patch-test', createdAt: 1, isSeeded: false, cwd: 'F:/SPACE/dsh-history-editor', delegationDepth: 0 };
function build(head = true) {
  const s = host.Session.create('patch-test', undefined, HDR);
  s.append('turn/start', { turn: 1 }); s.append('step/start', { turn: 1, step: 1 });
  if (head) s.append('system/message', { turn: 1, step: 1, message: { id: 'sys', role: 'system', source: { kind: 'system-prompt' }, content: [{ type: 'text', text: 'SYS' }] } }, { surfaceOp: 'append' });
  const u = s.append('user/message', { id: 'u', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'USER' }] }, { surfaceOp: 'append' });
  const a = s.append('assistant/message', { turn: 1, step: 1, stream: [], message: { id: 'a', role: 'assistant', source: { kind: 'model', provider: 'test', model: 'test' }, content: [{ type: 'text', text: 'ANSWER' }] } }, { surfaceOp: 'append' });
  s.append('step/end', { turn: 1, step: 1 }); s.append('turn/end', { turn: 1, reason: { kind: 'completed' } });
  return { s, u, a };
}
function rows(s) { return s.snapshotEvents().map(e => JSON.parse(JSON.stringify(host.catalog.encodeCurrentEvent(e)))); }
function restore(input) {
  const r = host.catalog.createRestore(host.catalog.encodeCurrentHeader(HDR, 0), { recovery: 'strict', validation: 'current' });
  for (const row of input) r.decodeRow(row);
  const artifact = r.finish();
  return host.Session.fromRestore('patch-test', artifact.events, artifact.header, artifact.inheritedEventCount ?? 0);
}
function carrier(s, seq, id) {
  s.append('compaction/prune', { shadowedRange: { start: seq, end: seq }, shadowedSeqs: [seq], shadowedTokenCount: 1 });
  s.append('system/message', { turn: 1, step: 1, message: { id: 'del', role: 'system', source: { kind: 'system-prompt' }, content: [] }, historyEditor: { op: 'delete', removedIds: [id] } }, { surfaceOp: { op: 'replace', startSeq: seq, endSeq: seq }, sourceEventSeqs: [seq] });
}
test('current entry patch remains equal-length and rejects unknown anchors', { skip }, () => {
  for (const rel of ['@deepseek-ai/dsh-session/lib/index.js', '@deepseek-ai/dsh-session-format-v3-to-v4/lib/index.js']) {
    const bytes = readFileSync(path.join(host.root, rel));
    assert.equal(patchEntry(rel, bytes).length, bytes.length);
    assert.throws(() => patchEntry(rel, Buffer.from('unknown host')), /anchor|Unrecognized/);
  }
});
test('capability fails closed when only one entry is deployed', { skip }, () => {
  const expected = process.env.DSH_HISTORY_EDITOR_PATCH_PART === 'both';
  assert.equal(host.Session.create('capability').historyEditorProtocol === 1, expected);
});
test('closed-step delete replay requires both capability entries; no system head also works', { skip }, () => {
  for (const head of [true, false]) {
    const { s, u } = build(head); carrier(s, u.seq, 'u');
    if (s.historyEditorProtocol !== 1) {
      if (process.env.DSH_HISTORY_EDITOR_PATCH_PART !== 'format') assert.throws(() => restore(rows(s)), /open turn and step/);
      continue;
    }
    const result = restore(rows(s));
    assert.deepEqual(result.deriveMessages().filter(Boolean).map(m => m.id), head ? ['sys', 'a'] : ['a']);
    assert.equal(result.historyEditorProtocol, 1);
  }
});
test('strict replay rejects malformed, wrong-coordinate, assistant and protected-head delete carriers', { skip }, () => {
  if (!process.env.DSH_HISTORY_EDITOR_PATCH_PART && host.Session.create('x').historyEditorProtocol !== 1) return;
  if (process.env.DSH_HISTORY_EDITOR_PATCH_PART === 'session') return;
  const { s, u, a } = build(); carrier(s, u.seq, 'u');
  const valid = rows(s);
  const mutations = [
    event => { event.data.historyEditor.removedIds = ['other']; },
    event => { event.data.message.content = [{ type: 'text', text: 'not empty' }]; },
    event => { event.data.step = 99; },
    event => { event.sourceEventSeqs = []; },
    event => { event.surfaceOp.endSeq = a.seq; event.sourceEventSeqs = [u.seq, a.seq]; },
    event => { event.surfaceOp.startSeq = event.surfaceOp.endSeq = a.seq; event.sourceEventSeqs = [a.seq]; event.data.historyEditor.removedIds = ['a']; },
    event => { event.surfaceOp.startSeq = event.surfaceOp.endSeq = 2; event.sourceEventSeqs = [2]; event.data.historyEditor.removedIds = ['sys']; },
  ];
  for (const mutate of mutations) {
    const copy = structuredClone(valid);
    // Format rows use a compact envelope; decode mutation is tested through logical events instead.
    const events = structuredClone(s.snapshotEvents()); mutate(events.at(-1));
    assert.throws(() => restore(events.map(e => host.catalog.encodeCurrentEvent(e))), /history deletion|replacement|protected|sourceEventSeqs/);
    assert.deepEqual(copy, valid);
  }
});
