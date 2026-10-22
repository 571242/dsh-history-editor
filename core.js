// Edit / delete / recall effective human user text through DSH's canonical positional replacement.
// Existing log records, message identity, attachments, and following nodes stay intact.
// Assistant replies are deliberately out of scope: they are never rewritten, deleted or copied by this plugin.
export function fail(message, status = 409) { return Object.assign(new Error(message), { status }); }
export function textOf(message) {
  return (message?.content ?? []).filter(p => p.type === 'text').map(p => p.text).join('\n');
}
/** 人类真实输入（编辑、删除与撤回只对它开放）。 */
export function isHumanUserMessage(message) {
  return message?.role === 'user' && message.source?.kind === 'user';
}
/** 可否改写文字。只开放真实用户输入。 */
export function editability(event, message) {
  if (event.type !== 'user/message' || !isHumanUserMessage(message)) return '仅开放人类用户消息；注入内容与助手回复只读';
  if (!(message.content ?? []).some(p => p.type === 'text')) return '这条消息没有可修改的文本';
  return '';
}
/** 可否删除。只开放真实用户输入；注入内容与系统提示不可。 */
export function deletability(event, message) {
  if (isHumanUserMessage(message)) return '';
  return '只开放人类用户消息；注入内容、系统提示与助手回复不可删除';
}
export function withText(message, text) {
  let inserted = false;
  const content = [];
  for (const part of message.content) {
    if (part.type !== 'text') content.push(part);
    else if (!inserted) { content.push({ type: 'text', text }); inserted = true; }
  }
  if (!inserted) throw fail('这条消息没有文本');
  return { ...message, content };
}
/** 真实替换（surfaceOp.op === 'replace'）才算"已修订"；普通追加与旧日志缺字段都返回 false。 */
export function isEditedEvent(event) {
  return event?.surfaceOp?.op === 'replace';
}
/**
 * 兼容旧日志的删除标记读取：historyEditor 或 removedIds 缺失时安全退化为空数组，
 * 绝不因为一条残缺标记就让整份历史读不出来（只读兼容，不改写真实日志）。
 */
function deleteMarkerIds(event) {
  if (event?.type !== 'system/message') return [];
  const marker = event.data?.historyEditor;
  if (!marker || marker.op !== 'delete' || !Array.isArray(marker.removedIds)) return [];
  return marker.removedIds.filter(id => typeof id === 'string');
}
/**
 * 删除载体必须携带正的 turn/step：format v4 的编码器会拒绝 turn/step === 0，
 * 这正是此前删除报 500 的真实原因。取目标位置之前最后一次开启的 turn/step，
 * 语义上属于被替换的位置，且永远为正。
 */
function carrierCoordinates(session, uptoSeq) {
  let turn = 0, step = 0;
  for (const event of session.snapshotEvents()) {
    if (event.seq > uptoSeq) break;
    if (event.type === 'turn/start' && Number.isSafeInteger(event.data?.turn) && event.data.turn > 0) { turn = event.data.turn; step = 0; }
    if (event.type === 'step/start' && Number.isSafeInteger(event.data?.step) && event.data.step > 0) step = event.data.step;
  }
  return { turn: turn > 0 ? turn : 1, step: step > 0 ? step : 1 };
}
export function createHistoryApi({ sessions, agents, tokenMeter }) {
  const locks = new Set();
  function get(id) {
    if (typeof id !== 'string' || !id) throw fail('缺少会话标识', 400);
    const session = sessions.get(id);
    if (!session) throw fail('请先打开这条会话，再编辑历史', 404);
    if (typeof session.deriveEventMessage !== 'function') throw fail('当前宿主不支持有效历史投影');
    return session;
  }
  function ensureIdle(sessionId, what) {
    const agent = agents.get(sessionId);
    if (!agent || agent.status !== 'idle' || agent.inbox?.hasPending) throw fail('请等待回复结束、排队消息处理完，再' + what);
  }
  /** 一次遍历同时给出写目标，避免删除路径为同一批节点重复推导。 */
  function snapshotSurface(session) {
    const entries = [];
    for (const seq of session.surface.nodes) {
      const event = session.eventAt(seq);
      entries.push({ seq, event, message: session.deriveEventMessage(event) });
    }
    return entries;
  }
  function list(sessionId) {
    const session = get(sessionId);
    const events = session.snapshotEvents();
    const removedIds = [...new Set(events.flatMap(deleteMarkerIds))];
    const removed = new Set(removedIds);
    const messages = [];
    for (const { seq, event, message } of snapshotSurface(session)) {
      // 删除产物的空 system/message 载体在这里投影为 null，必须跳过。
      if (!message || message.role !== 'user') continue;
      if (!isHumanUserMessage(message)) continue;
      const text = textOf(message);
      if (!text) continue;
      const reason = editability(event, message);
      const delReason = deletability(event, message);
      messages.push({ id: message.id, seq, role: message.role, text, edited: isEditedEvent(event), editable: !reason, reason, deletable: !delReason, delReason });
    }
    // Keep saved bubble text visible even after its context node is later compacted.
    const visibleIds = new Set(messages.map(message => message.id));
    const saved = new Map();
    for (const event of events) {
      if (event.type === 'user/message' && event.surfaceOp?.op === 'replace' && event.data.source?.kind === 'user') saved.set(event.data.id, event);
    }
    for (const [id, event] of saved) {
      if (visibleIds.has(id) || removed.has(id)) continue;
      const message = event.data;
      messages.push({ id, seq: event.seq, role: message.role, text: textOf(message), edited: true, editable: false, reason: '这条已修订消息已被折叠，仅显示保存后的文字', deletable: false, delReason: '这条已修订消息已被折叠，不能在当前位置删除' });
    }
    return { ok: true, messages, removedIds, revision: session.seq };
  }
  async function edit({ sessionId, seq, text, revision }) {
    const session = get(sessionId);
    if (locks.has(sessionId)) throw fail('这一会话正在保存，请等待');
    if (typeof text !== 'string' || !text.trim() || text.length > 200000) throw fail('请输入非空文本，且不超过 20 万字', 400);
    if (!Number.isSafeInteger(seq) || seq < 0) throw fail('消息位置无效', 400);
    ensureIdle(sessionId, '保存历史修改');
    if (revision !== session.seq) throw fail('历史已变化，请刷新列表后重新选择消息；草稿未丢失');
    if (!session.surface.nodes.includes(seq)) throw fail('这条消息已被替换或折叠，请刷新列表');
    const event = session.eventAt(seq);
    const original = session.deriveEventMessage(event);
    const reason = editability(event, original);
    if (reason) throw fail(reason);
    if (textOf(original) === text) return { ok: true, unchanged: true, revision: session.seq };
    const replacement = withText(original, text);
    const shadowedTokenCount = tokenMeter.estimateMessage(original);
    if (!Number.isFinite(shadowedTokenCount) || shadowedTokenCount < 0) throw fail('无法取得宿主令牌计价，未保存');
    locks.add(sessionId);
    let landed;
    try {
      // Adjacent synchronous appends: the second consumes the exact shadow-price claim.
      session.append('compaction/prune', {
        shadowedRange: { start: seq, end: seq }, shadowedSeqs: [seq], shadowedTokenCount,
      });
      landed = session.append('user/message', replacement, {
        surfaceOp: { op: 'replace', startSeq: seq, endSeq: seq }, sourceEventSeqs: [seq],
      });
      if (!await sessions.flush(session)) throw fail('修改已进入当前上下文，但宿主未确认持久化；请勿重复保存', 500);
      return { ok: true, seq: landed.seq, revision: session.seq };
    } catch (error) {
      if (landed && !String(error.message).includes('已进入当前上下文')) {
        throw fail('修改已进入当前上下文，但落盘确认失败；请勿重复保存：' + error.message, 500);
      }
      throw error;
    } finally { locks.delete(sessionId); }
  }
  /**
   * 删除：用一条空 content 的 system/message 遮蔽目标区段。空载体不投影任何消息，
   * 气泡与模型上下文因此都看不到它；它也不产生 assistant/message 事件，
   * 所以不会触碰 token-meter 的 step 配对。
   */
  async function remove({ sessionId, seq, revision }) {
    const session = get(sessionId);
    if (locks.has(sessionId)) throw fail('这一会话正在保存，请等待');
    if (!Number.isSafeInteger(seq) || seq < 0) throw fail('消息位置无效', 400);
    ensureIdle(sessionId, '删除历史消息');
    if (session.historyEditorProtocol !== 1) throw fail('请先安装历史编辑宿主补丁并重启 DSH；未写入任何删除');
    if (revision !== session.seq) throw fail('历史已变化，请刷新列表后重新选择消息');
    if (!session.surface.nodes.includes(seq)) throw fail('这条消息已被替换或折叠，请刷新列表');
    const entries = snapshotSurface(session);
    const at = entries.findIndex(entry => entry.seq === seq);
    if (at < 0) throw fail('这条消息已被替换或折叠，请刷新列表');
    const target = entries[at].message;
    const reason = deletability(entries[at].event, target);
    if (reason) throw fail(reason);
    // 系统提示坐落在 surface 节点 0；遮蔽它会破坏会话，一律拒绝。
    if (at === 0 && entries[0].event.type === 'system/message') throw fail('删除范围覆盖系统提示，已拒绝');
    // 一次只删这一条：范围就是它自己的 surface 节点。
    const shadowed = [seq];
    const removedIds = typeof target?.id === 'string' ? [target.id] : [];
    const shadowedTokenCount = tokenMeter.estimateMessage(target);
    if (!Number.isFinite(shadowedTokenCount) || shadowedTokenCount < 0) throw fail('无法取得宿主令牌计价，未删除');
    // 载体坐标必须为正：format v4 编码器拒绝 turn/step === 0（删除报 500 的真实原因）。
    const { turn, step } = carrierCoordinates(session, seq);
    locks.add(sessionId);
    let landed;
    try {
      session.append('compaction/prune', {
        shadowedRange: { start: seq, end: seq }, shadowedSeqs: shadowed, shadowedTokenCount,
      });
      landed = session.append('system/message', {
        turn, step,
        message: { id: 'del-' + seq, role: 'system', source: { kind: 'system-prompt' }, content: [] },
        historyEditor: { op: 'delete', removedIds },
      }, {
        surfaceOp: { op: 'replace', startSeq: seq, endSeq: seq }, sourceEventSeqs: shadowed,
      });
      if (!await sessions.flush(session)) throw fail('删除已进入当前上下文，但宿主未确认持久化；请勿重复操作', 500);
      return { ok: true, seq: landed.seq, revision: session.seq, removed: shadowed.length, removedIds };
    } catch (error) {
      if (landed && !String(error.message).includes('已进入当前上下文')) {
        throw fail('删除已进入当前上下文，但落盘确认失败；请勿重复操作：' + error.message, 500);
      }
      throw error;
    } finally { locks.delete(sessionId); }
  }
  function recall({ sessionId, messageId }) {
    const session = get(sessionId);
    ensureIdle(sessionId, '撤回');
    const events = session.snapshotEvents();
    const original = events.find(event =>
      event.type === 'user/message' && event.surfaceOp === 'append'
      && event.data.id === messageId && event.data.source?.kind === 'user');
    if (!original) throw fail('找不到这条原始消息', 404);
    const current = list(sessionId).messages.find(message => message.id === messageId);
    if (!current) throw fail('这条消息已不在当前有效上下文中，不能从此处撤回');
    if (!current.editable) throw fail('这条消息已经折叠，不能从此处撤回');
    let boundary = original.seq - 1;
    for (const event of events) {
      if (event.seq >= original.seq) break;
      if (event.type === 'turn/end') boundary = event.seq;
    }
    if (boundary < 0) throw fail('这条消息前没有可分支的记录，请使用新会话');
    const edits = list(sessionId).messages.filter(message => message.role === 'user' && message.editable && events.some(event => event.type === 'user/message' && event.surfaceOp === 'append' && event.seq <= boundary && event.data.id === message.id && textOf(event.data) !== message.text)).map(({ id, text }) => ({ id, text }));
    return { ok: true, boundary, text: current.text, edits };
  }
  return { list, edit, remove, recall };
}
