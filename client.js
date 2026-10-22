/**
 * dsh-history-editor — 浏览器半（单文件）。契约：window.__ModuleLoader__.load({id,factory})，
 * factory(require) 返回 { name, inject, apply }。
 *
 * 形态：只在 conversation.chat.node / key="user" 上注册（priority -1），在用户气泡原位加编辑/删除/
 * 撤回/复制。助手回复不注册任何席位：助手侧的改写、删除、复制与撤回已全部移除，助手气泡完全由
 * 宿主原生渲染，插件不碰它的 DOM、不写它的正文。
 *
 * Host 接口：
 *   GET  /history-editor/messages?sessionId=<enc>
 *        → { ok, messages:[{id,seq,role,text,editable,reason,deletable,delReason}], revision, removedIds }
 *   POST /history-editor/edit   { sessionId, seq, text, revision } → { ok, seq, revision }
 *   POST /history-editor/delete { sessionId, seq, revision }       → { ok, revision, removed, removedIds }
 *   POST /history-editor/recall { sessionId, messageId }           → { ok, boundary, text, edits }
 *
 * 关键约束（已按需求实现）：
 *   - 聊天气泡 node 只带 append 时的旧正文；一律用稳定 message.id 映射 GET 的最新正文/seq，
 *     避免气泡仍显示旧字。GET 里 editable:false（已被折叠/替换）仍然按 id 映射显示，只是编辑图标置灰。
 *   - 每个 session 的 GET 做合并（同一 tick / 同一次请求期内只发一次），不每个气泡重复拉全 history。
 *   - 挂载（含刷新、重新挂载）会重新拉取，保证映射最新正文。
 *   - 打开编辑时拉取最新 revision；保存后更新本地缓存并通知同 session 的气泡。
 *   - 保存失败（例如正在回复被后端拒绝）保留草稿与错误提示，不吞掉用户输入。
 *   - 不进模板、不改 core/index/package、不新增依赖；仅依赖宿主 React 与已存在的 native client 组件。
 */
window.__ModuleLoader__.load({
  id: "dsh-history-editor",
  factory: function (require) {
    var React = require("react");

    /* native 原子组件是可选增强：取不到就退回纯文本字形，绝不让整个气泡崩掉。 */
    var Prims = null;
    try { Prims = require("@deepseek-ai/dsh-client-ui-primitives"); } catch (err) { Prims = null; }
    function prim(name) { return Prims && Prims[name] ? Prims[name] : null; }
    /** 取第一个存在的图标导出（名字里数字是字重，跨版本会漂移），都取不到时退回文本字形。 */
    function icon(names, glyph) {
      for (var i = 0; i < names.length; i++) if (Prims && Prims[names[i]]) return Prims[names[i]];
      return function GlyphIcon() { return React.createElement("span", { "aria-hidden": "true" }, glyph); };
    }
    var IconEdit = icon(["IconEditOutlineRegular", "IconEditOutlineMedium", "IconEditOutline16"], "\u270E");
    /* 撤回图标：优先使用标准几何弧形回退箭头，与 DSH 原生线性图标的 15px/1.35px stroke 笔触完美呼应。 */
    var IconRecall = function SvgRecallIcon() {
      return React.createElement("svg", {
        viewBox: "0 0 16 16", width: "15", height: "15", fill: "none",
        stroke: "currentColor", strokeWidth: "1.35", strokeLinecap: "round", strokeLinejoin: "round",
        "aria-hidden": "true"
      }, [
        React.createElement("path", { key: "a", d: "M5.5 3.75L2.25 7L5.5 10.25" }),
        React.createElement("path", { key: "b", d: "M2.25 7H9.75C11.68 7 13.25 8.57 13.25 10.5C13.25 12.43 11.68 14 9.75 14H6" })
      ]);
    };
    /* 删除图标：内联 SVG，与撤回图标同款 15px / 1.35px 线性笔触。 */
    var IconTrash = function SvgTrashIcon() {
      return React.createElement("svg", {
        viewBox: "0 0 16 16", width: "15", height: "15", fill: "none",
        stroke: "currentColor", strokeWidth: "1.35", strokeLinecap: "round", strokeLinejoin: "round",
        "aria-hidden": "true"
      }, [
        React.createElement("path", { key: "a", d: "M2.75 4.25h10.5" }),
        React.createElement("path", { key: "b", d: "M6.25 4.25V3.4c0-.36.29-.65.65-.65h2.2c.36 0 .65.29.65.65v.85" }),
        React.createElement("path", { key: "c", d: "M4.25 4.25l.55 8.1c.03.44.4.78.84.78h4.72c.44 0 .81-.34.84-.78l.55-8.1" }),
        React.createElement("path", { key: "d", d: "M6.6 6.9v3.7M9.4 6.9v3.7" })
      ]);
    };
    var IconCopy = icon(["IconCopyOutlineRegular", "IconCopyOutlineMedium", "IconCopyOutline16"], "\u29C9");
    var IconCheck = icon(["IconCheckOutlineRegular", "IconCheckOutlineMedium", "IconCheckOutline16"], "\u2713");
    var Tooltip = prim("Tooltip");
    var FileTypeIcon = prim("FileTypeIcon");
    var JsonBlock = prim("JsonBlock");

    /* ctx 在每个会话气泡里由 apply 捕获后导出：撤回需要 sessions / uiWorkspace 这两个官方服务。 */
    var HOST = { ctx: null };
    function service(name) {
      var ctx = HOST.ctx;
      if (!ctx) return null;
      try { return typeof ctx.get === "function" ? (ctx.get(name) || null) : null; } catch (err) { return null; }
    }

    /* ---------- 会话级共享缓存（跨气泡、跨挂载；模块级，不落 localStorage） ---------- */

    var SESSIONS = Object.create(null);
    var GET_URL = "/history-editor/messages?sessionId=";
    var EDIT_URL = "/history-editor/edit";
    var RECALL_URL = "/history-editor/recall";
    var DELETE_URL = "/history-editor/delete";
    /* 撤回时新分支的就绪窗口：fork 后立刻切换，子会话物化与载入需要一点时间，但必须有界。
       允许 window.__DSH_HISTORY_EDITOR_CFG__ 覆盖，便于测试用短窗口确定性地跑完整条链路。 */
    var CFG = (typeof window !== "undefined" && window && window.__DSH_HISTORY_EDITOR_CFG__) || {};
    function num(value, fallback) { return typeof value === "number" && value > 0 ? value : fallback; }
    var READY_TIMEOUT_MS = num(CFG.readyTimeoutMs, 3000);
    var READY_POLL_MS = num(CFG.readyPollMs, 120);
    var PREFILL_TIMEOUT_MS = num(CFG.prefillTimeoutMs, 2000);

    function sess(id) {
      var k = String(id || "");
      var s = SESSIONS[k];
      if (!s) s = SESSIONS[k] = {
        byId: null, revision: null, error: "", loading: false,
        scheduled: null, inflight: null, listeners: [], writes: 0,
        // 本地已删除的 message.id：GET 回包到达前也要让气泡立即消失，
        // 否则会回退到 chat node 上的旧正文继续显示被删内容。
        removed: Object.create(null)
      };
      return s;
    }
    function notify(s) {
      var l = s.listeners.slice();
      for (var i = 0; i < l.length; i++) { try { l[i](); } catch (err) { /* 单个气泡出错不影响其它气泡 */ } }
    }
    function joinText(content) {
      var out = [];
      var list = content || [];
      for (var i = 0; i < list.length; i++) {
        var b = list[i];
        if (b && b.type === "text" && typeof b.text === "string") out.push(b.text);
      }
      return out.join("\n");
    }
    function applyRemoved(s, ids, replace) {
      var next = replace ? Object.create(null) : s.removed;
      var list = Array.isArray(ids) ? ids : [];
      for (var i = 0; i < list.length; i++) next[String(list[i])] = true;
      s.removed = next;
      if (s.byId) for (var id in next) delete s.byId[id];
    }
    function applyPayload(s, d) {
      if (!d || !d.ok) { s.error = (d && d.error) || "读取历史失败（Host 接口未就绪？）"; return; }
      var map = Object.create(null);
      var list = d.messages || [];
      for (var i = 0; i < list.length; i++) {
        var m = list[i];
        // 复制一层再入缓存：缓存归本插件所有，后续局部更新不去改 Host 返回的对象。
        if (m && m.id != null) map[String(m.id)] = {
          id: m.id, seq: m.seq, role: m.role, text: m.text, editable: m.editable, reason: m.reason,
          deletable: m.deletable, delReason: m.delReason,
          // Host 的「这条消息存在真实修订」权威标记；缺席视为未修订。
          edited: m.edited === true
        };
      }
      s.byId = map;
      s.revision = d.revision;
      s.error = "";
      // 列表缺席也可能只是压缩；只有 Host 明示的 removedIds 才能判定删除。
      applyRemoved(s, d.removedIds, true);
    }
    function fetchNow(s, sessionId) {
      s.loading = true;
      // 记下发起时的写入代数：若期间保存过，这次 GET 就是过期回包，不能覆盖刚写入的正文。
      var epoch = s.writes;
      return fetch(GET_URL + encodeURIComponent(sessionId))
        .then(function (r) { return r.json(); })
        .then(function (d) {
          s.loading = false;
          if (s.writes !== epoch) { notify(s); return; }
          applyPayload(s, d);
          notify(s);
        })
        .catch(function (err) {
          s.loading = false;
          if (s.writes !== epoch) return;
          s.error = "读取历史失败：" + String((err && err.message) || err);
          notify(s);
        });
    }
    /**
     * 合并式刷新：同一 tick 内挂载的气泡共用一个已排期的请求；请求飞行期间新来的调用复用同一请求。
     * 因此「一次挂载批次 = 一次 GET」，而刷新页面 / 重新挂载（新的 tick）都会重新拉取最新正文。
     */
    function request(s, sessionId) {
      if (s.inflight) return s.inflight;
      if (s.scheduled) return s.scheduled;
      s.scheduled = new Promise(function (resolve) {
        setTimeout(function () {
          s.scheduled = null;
          var p = fetchNow(s, sessionId);
          s.inflight = p;
          p.then(function () { s.inflight = null; }, function () { s.inflight = null; });
          p.then(resolve, resolve);
        }, 0);
      });
      return s.scheduled;
    }

    /** 挂载即重新拉取（合并），并订阅同 session 的缓存变化。 */
    function useSession(sessionId) {
      var s = sess(sessionId);
      var bump = React.useState(0)[1];
      React.useEffect(function () {
        var listener = function () { bump(function (n) { return n + 1; }); };
        s.listeners.push(listener);
        if (sessionId) request(s, sessionId);
        return function () {
          var i = s.listeners.indexOf(listener);
          if (i >= 0) s.listeners.splice(i, 1);
        };
      }, [sessionId]);
      return s;
    }

    /**
     * 撤回：官方会话控制器 fork 出子会话 → 立刻切过去（子会话必须先真实打开，scope 才会物化）→
     * 等它可读 → 把子会话前缀里被后期修订覆盖掉的文本串行重放 → 把这条消息当前保存的正文预填进输入框。
     * 只做「切分支 + 预填草稿」，不代替用户发请求；老分支保留，不删历史。
     * 任何一步失败都抛出，由调用方就地提示，绝不静默吞掉，也绝不假装成功。
     * @returns Promise<true> 全部完成后才 resolve。
     */
    function doRecall(sessionId, messageId, onPhase) {
      var sessions = service("sessions");
      if (!sessions || typeof sessions.fork !== "function") return Promise.reject(new Error("当前宿主未提供会话 fork 能力"));
      var workspace = service("uiWorkspace");
      if (!workspace || typeof workspace.openSession !== "function") {
        // 没有切换能力就不能开始：半途 fork 出孤儿分支比不做更糟。
        return Promise.reject(new Error("当前宿主未提供会话切换能力（uiWorkspace.openSession）"));
      }
      var switched = false;
      var childId = null;
      var payload = null;
      return fetch(RECALL_URL, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ sessionId: sessionId, messageId: messageId })
      })
        .then(function (r) { return r.json(); })
        .then(function (d) {
          if (!d || !d.ok) throw new Error((d && d.error) || "撤回失败。");
          if (typeof d.text !== "string") throw new Error("宿主未返回这条消息的当前正文");
          payload = d;
          return sessions.fork({ sessionId: sessionId, atSeq: d.boundary });
        })
        .then(function (id) {
          if (typeof id !== "string" || !id) throw new Error("宿主未返回新的会话标识");
          childId = id;
          // fork 成功立刻切换：子会话只有在真实打开后才会物化 scope，之后才能读和写。
          workspace.openSession(childId);
          switched = true;
          if (onPhase) onPhase("正在等待新分支就绪…");
          return waitForChild(childId);
        })
        .then(function (state) {
          if (payload.edits && payload.edits.length) {
            if (onPhase) onPhase("正在同步子会话的已修订文本…");
            return replayEdits(childId, payload.edits, state);
          }
          // 即使没有要重放的修订，也必须确认子会话已可读，否则草稿会填进一个不存在的会话。
          return state;
        })
        .then(function () {
          if (!payload.text) return false;   // 空正文不预填，避免留下空草稿
          if (onPhase) onPhase("正在预填正文…");
          return prefill(childId, payload.text);
        })
        .then(function () { return true; })
        .catch(function (err) {
          // 已经切过会话就没法把错误写回原气泡，标出来让调用方知道该换个地方提示。
          if (switched) err.switched = true;
          throw err;
        });
    }

    /** 读取某个会话的当前有效消息表（含 revision），撤回重放与气泡缓存共用同一份接口。 */
    function readMessages(sessionId) {
      return fetch(GET_URL + encodeURIComponent(sessionId))
        .then(function (r) {
          // Host 把状态放在 HTTP 上（body 只有 {ok,error}），所以必须在这里取，才能区分 404 未就绪与真故障。
          var httpStatus = r.status;
          return r.json().then(function (d) {
            if (!d || !d.ok) {
              var e = new Error((d && d.error) || "读取子会话历史失败");
              e.status = (d && typeof d.status === "number") ? d.status : httpStatus;
              throw e;
            }
            var byId = Object.create(null);
            var list = d.messages || [];
            for (var i = 0; i < list.length; i++) if (list[i] && list[i].id != null) byId[String(list[i].id)] = list[i];
            return { byId: byId, revision: d.revision };
          });
        });
    }

    /**
     * 只有「会话还没就绪」可重试。宿主对未打开的会话返回 404（"请先打开这条会话"），
     * 其余一律视为真实故障：立即抛出，绝不把权限/参数/内部错误拖成超时。
     */
    function isNotReady(err) {
      if (err && err.status !== undefined) return err.status === 404;
      // 没有状态码时（老宿主）才退回文本判断，且只认明确的「未就绪」措辞。
      return /请先打开|尚未就绪|not (yet )?(ready|found)|no such session/i.test(String((err && err.message) || err));
    }

    /** 有界等待子会话就绪：窗口内轮询读取，就绪即返回状态；超窗或非 404 错误立即失败。 */
    function waitForChild(childId) {
      var deadline = Date.now() + READY_TIMEOUT_MS;
      function attempt() {
        return readMessages(childId).catch(function (err) {
          if (!isNotReady(err)) throw err;   // 真失败：不重试、不拖延
          if (Date.now() >= deadline) {
            throw new Error("新的会话分支在 " + Math.round(READY_TIMEOUT_MS / 1000) + " 秒内仍未就绪，已停止同步（原分支未受影响）");
          }
          return waitThen(READY_POLL_MS).then(attempt);
        });
      }
      return attempt();
    }

    /**
     * 把原分支上「位于撤回点之前、已经被改过」的用户文本在子会话里重新落一次。
     * 必须串行：后一次要带上一次响应里的 revision，否则会被宿主判为历史已变化。
     */
    function replayEdits(childId, edits, state) {
      var revision = state.revision;
      var chain = Promise.resolve();
      edits.forEach(function (edit) {
        chain = chain.then(function () {
          var row = state.byId[String(edit.id)];
          if (!row) return;                             // 这条修订不在子会话前缀里，无需重放
          if (row.editable === false) throw new Error("新分支里这条消息只读，无法重放已修订文本");
          if (row.text === edit.text) return;           // 已经就是目标文字
          return fetch(EDIT_URL, {
            method: "POST", headers: { "content-type": "application/json" },
            body: JSON.stringify({ sessionId: childId, seq: row.seq, text: edit.text, revision: revision })
          }).then(function (r) { return r.json(); }).then(function (res) {
            if (!res || !res.ok) throw new Error((res && res.error) || "重放已修订文本失败");
            revision = res.revision;
            row.seq = res.seq;
            row.text = edit.text;
          });
        });
      });
      return chain;
    }

    function waitThen(ms) {
      return new Promise(function (resolve) { setTimeout(resolve, ms); });
    }

    /**
     * 预填草稿走 EasyRewrite 同一条真实路径：conversation.input.for(sessionScope).setDraft(text)。
     * 返回 Promise：作用域可能比会话切换晚一步物化，这里在窗口内重试，超时则 reject（绝不 resolve 假装成功）。
     */
    function prefill(sessionId, text) {
      if (typeof text !== "string" || text === "") return Promise.resolve(false);
      var deadline = Date.now() + PREFILL_TIMEOUT_MS;
      var write = function () {
        var sessions = service("sessions");
        if (!sessions || typeof sessions.scope !== "function") return false;
        try {
          var scope = sessions.scope(sessionId);
          var conversation = scope ? scope.get("conversation") : null;
          var input = conversation && typeof conversation.input === "object" ? conversation.input : null;
          var shell = input && typeof input.for === "function" ? input.for(scope) : null;
          if (shell && typeof shell.setDraft === "function") { shell.setDraft(text); return true; }
        } catch (err) { /* 作用域尚未物化，交给重试 */ }
        return false;
      };
      function attempt() {
        if (write()) return Promise.resolve(true);
        if (Date.now() >= deadline) {
          return Promise.reject(new Error("新分支的输入框未能在 " + Math.round(PREFILL_TIMEOUT_MS / 1000) + " 秒内就绪，正文未预填（已切到新分支，可手动粘贴）"));
        }
        return waitThen(READY_POLL_MS).then(attempt);
      }
      return attempt();
    }

    /* ---------- 气泡（保留 native 外观：正文投影 / 图片附件 / 文件卡片 / 时间 / 复制） ---------- */

    function contentParts(content) {
      var texts = [], attachments = [], rest = [], list = content || [];
      for (var i = 0; i < list.length; i++) {
        var b = list[i];
        if (b && b.type === "text" && typeof b.text === "string") texts.push(b.text);
        else if (b && b.type === "image" && b.attachment !== undefined) attachments.push({ type: "image", block: b });
        else if (b && b.type === "file" && b.attachment !== undefined) attachments.push({ type: "file", block: b });
        else if (b) rest.push(b);
      }
      return { text: texts.join(""), attachments: attachments, rest: rest };
    }
    function project(text, data, props) {
      var fn = prim("projectUserText");
      if (!fn) return text;
      try {
        return fn(text, data.referenceLabels || [], data.skillNames || [], "skill",
          props.openFile || props.openSkill ? { openFile: props.openFile, openSkill: props.openSkill } : undefined);
      } catch (err) { return text; }
    }
    function fileCard(block, index) {
      var att = block.attachment || {};
      var ext = prim("fileExtension"), size = prim("fileSizeText");
      var meta = [ext ? String(ext(att.name) || "").toUpperCase().slice(0, 8) : "", size ? size(att.bytes) : ""].filter(Boolean).join(" ");
      return React.createElement("span", { className: "cJsG2q_fileCard dsh-he-file", title: att.name, key: "f" + index }, [
        FileTypeIcon ? React.createElement(FileTypeIcon, { key: "i", path: att.name, className: "cJsG2q_fileIcon dsh-he-fileIcon" }) : null,
        React.createElement("span", { className: "cJsG2q_fileContent dsh-he-fileBody", key: "b" }, [
          React.createElement("span", { className: "cJsG2q_fileName dsh-he-fileName", key: "n" }, att.name || ""),
          React.createElement("span", { className: "cJsG2q_fileMeta dsh-he-fileMeta", key: "m" }, meta)
        ])
      ]);
    }
    function attachmentsOf(data, props) {
      var parts = contentParts(data.content);
      if (!parts.attachments.length) return null;
      var compact = parts.attachments.length > 1;
      var cells = parts.attachments.map(function (a, i) {
        if (a.type === "file") return fileCard(a.block, i);
        if (typeof props.renderMessageImages === "function") {
          try {
            return props.renderMessageImages({ images: [{ attachment: a.block.attachment }], align: "end", compact: compact, key: "i" + i });
          } catch (err) { /* 回退到占位 */ }
        }
        return React.createElement("span", { className: "cJsG2q_fileMeta dsh-he-fileMeta", key: "i" + i }, "[图片]");
      });
      return React.createElement("div", { className: "cJsG2q_attachmentRow dsh-he-attach", "data-dsh-he": "attachments" }, cells);
    }
    function clockText(time) {
      if (!time) return "";
      var d = new Date(time), n = new Date();
      var pad = function (v) { return (v < 10 ? "0" : "") + v; };
      var hm = pad(d.getHours()) + ":" + pad(d.getMinutes());
      var sameDay = d.getFullYear() === n.getFullYear() && d.getMonth() === n.getMonth() && d.getDate() === n.getDate();
      return sameDay ? hm : (d.getMonth() + 1) + "月" + d.getDate() + "日 " + hm;
    }
    function iconButton(label, Icon, onClick, extra) {
      // data-dsh-he 供真实界面核对与测试定位；同时挂载原生与插件专属类名。
      var attrs = { "data-dsh-he": (extra && extra.marker) || "action" };
      if (extra && extra.attrs) Object.assign(attrs, extra.attrs);
      var button = React.createElement("button", Object.assign({
        type: "button", className: "xD_KDq_action dsh-he-action", "aria-label": label,
        title: Tooltip ? undefined : label,
        disabled: extra && extra.disabled ? true : undefined, onClick: onClick
      }, attrs), React.createElement(Icon, {}));
      return Tooltip ? React.createElement(Tooltip, { label: label, side: "bottom" }, button) : button;
    }

    function UserBubbleEdit(props) {
      var node = props.node || {};
      var data = node.data || {};
      var sessionId = props.sessionId;
      var s = useSession(sessionId);
      var id = node.id != null ? String(node.id) : "";
      var row = (s.byId && id) ? s.byId[id] : null;
      // 已删除：宿主侧节点虽然还在 surface 上，但投影为 null，气泡必须跟着消失。
      var gone = id ? s.removed[id] === true : false;
      // 一律按稳定 id 映射当前有效正文：命中 row 时 host 是权威（气泡 node 只带 append 时的旧正文）；
      // 未命中说明这条 id 从未被改过，node 上的 append 正文即当前正文。
      var text = row ? String(row.text == null ? "" : row.text) : joinText(data.content);
      var seq = row ? row.seq : (typeof data.seq === "number" ? data.seq : null);
      var canEdit = row ? row.editable !== false : (seq !== null && text.trim() !== "");

      var editingState = React.useState(false), editing = editingState[0], setEditing = editingState[1];
      var draftState = React.useState(""), draft = draftState[0], setDraft = draftState[1];
      var errorState = React.useState(""), error = errorState[0], setError = errorState[1];
      var savingState = React.useState(false), saving = savingState[0], setSaving = savingState[1];
      var copiedState = React.useState(false), copied = copiedState[0], setCopied = copiedState[1];
      var copyingState = React.useState(false), copying = copyingState[0], setCopying = copyingState[1];
      var recallingState = React.useState(false), recalling = recallingState[0], setRecalling = recallingState[1];
      var phaseState = React.useState(""), phase = phaseState[0], setPhase = phaseState[1];
      var confirmState = React.useState(false), confirming = confirmState[0], setConfirming = confirmState[1];
      var deletingState = React.useState(false), deleting = deletingState[0], setDeleting = deletingState[1];
      var copiedTimer = React.useRef(0);
      React.useEffect(function () { return function () { if (copiedTimer.current) clearTimeout(copiedTimer.current); }; }, []);

      function openEdit() {
        if (!canEdit || saving) return;
        setDraft(text); setError(""); setEditing(true);
        request(s, sessionId); // 打开编辑即拉取最新 revision，避免保存时因 revision 过期被拒
      }
      function cancelEdit() { setEditing(false); setError(""); }

      function save() {
        if (saving || !draft.trim()) return;
        var target = (s.byId && s.byId[id]) || null;
        var targetSeq = target ? target.seq : seq;
        if (targetSeq === null) { setError("这条消息位置未知，请刷新页面后重试。"); return; }
        setSaving(true); setError("");
        fetch(EDIT_URL, {
          method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ sessionId: sessionId, seq: targetSeq, text: draft, revision: s.revision })
        })
          .then(function (r) { return r.json(); })
          .then(function (d) {
            setSaving(false);
            if (!d || !d.ok) {
              setError((d && d.error) || "保存失败。");
              request(s, sessionId); // 失败后刷新 revision；草稿留在输入框里不丢
              return;
            }
            s.revision = d.revision;
            s.writes += 1; // 让可能仍在飞行的旧 GET 作废，避免回包把刚保存的正文改回去
            // 即使 GET 还没落地也要写入这条：我们已确知它的 id、seq 与刚刚保存下来的正文。
            s.byId = s.byId || Object.create(null);
            var prevRow = s.byId[id] || { id: id, role: "user", editable: true, reason: "" };
            s.byId[id] = Object.assign({}, prevRow, { text: draft, seq: d.seq });
            notify(s);
            setEditing(false); // 保存响应已带回权威 revision，无需再多发一次 GET
          })
          .catch(function (err) { setSaving(false); setError("保存失败：" + String((err && err.message) || err)); });
      }
      function copy() {
        if (copying) return;
        setCopying(true);
        var write = prim("writeClipboard");
        var p = write ? write(text) : Promise.resolve(false);
        p.then(function (ok) {
          setCopying(false);
          if (!ok) return;
          setCopied(true);
          copiedTimer.current = window.setTimeout(function () { setCopied(false); }, 1000);
        }, function () { setCopying(false); });
      }

      /**
       * 删除：宿主侧用空 system/message 遮蔽这条消息，界面靠宿主自带的
       * ""空节点高度归零"" 规则自然消失，前后消息贴合。破坏性操作，先确认再发。
       */
      function remove() {
        if (deleting) return;
        var target = (s.byId && s.byId[id]) || null;
        var targetSeq = target ? target.seq : seq;
        if (targetSeq === null) { setError("这条消息位置未知，请刷新页面后重试。"); return; }
        setDeleting(true); setError("");
        fetch(DELETE_URL, {
          method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ sessionId: sessionId, seq: targetSeq, revision: s.revision })
        })
          .then(function (r) { return r.json(); })
          .then(function (d) {
            setDeleting(false); setConfirming(false);
            if (!d || !d.ok) {
              setError((d && d.error) || "删除失败。");
              request(s, sessionId); // 失败后刷新 revision，让用户重新确认
              return;
            }
            s.revision = d.revision;
            s.writes += 1;                       // 作废仍在飞行的旧 GET
            applyRemoved(s, d.removedIds);       // Host 返回本次删除涉及的全部 message id
            notify(s);
          })
          .catch(function (err) { setDeleting(false); setError("删除失败：" + String((err && err.message) || err)); });
      }

      /** 撤回：从这里切一条新分支并把原文放回输入框，不自动发送。 */
      function recall() {
        if (recalling || saving || editing || locked) return;
        setRecalling(true); setError(""); setPhase("");
        doRecall(sessionId, id, setPhase).then(function () {
          setRecalling(false); // 已切到子会话，本气泡随之卸载
        }, function (err) {
          setRecalling(false); setPhase("");
          var detail = String((err && err.message) || err);
          setError(err && err.switched
            ? "已切到新分支，但同步旧修订失败：" + detail + "（老分支仍保留）"
            : "撤回失败：" + detail);
        });
      }

      var parts = contentParts(data.content);
      var attachments = attachmentsOf(data, props);
      var rows = Math.min(12, Math.max(2, draft.split("\n").length));
      var locked = !canEdit;
      var lockReason = row ? (row.reason || "这条消息已被折叠或替换，只读显示保存后的文字")
        : (seq === null ? "这条消息的位置尚未同步，请稍候或刷新页面" : "这条消息没有可修改的文本");
      var canDelete = row ? row.deletable !== false : (seq !== null);
      var deleteReason = row ? (row.delReason || "这条消息不可删除")
        : (seq === null ? "这条消息的位置尚未同步，请稍候或刷新页面" : "这条消息不可删除");

      var stack = [];
      if (attachments) stack.push(attachments);
      if (editing) {
        stack.push(React.createElement("div", { className: "dsh-he-edit", "data-dsh-he": "editor", key: "ed" }, [
          React.createElement("textarea", {
            key: "t", className: "dsh-he-ta", rows: rows, value: draft, disabled: saving,
            autoFocus: true,
            "data-dsh-he": "textarea", "aria-label": "编辑这条消息的正文",
            onChange: function (ev) { setDraft(ev.target.value); },
            onKeyDown: function (ev) {
              if ((ev.ctrlKey || ev.metaKey) && ev.key === "Enter") {
                ev.preventDefault();
                save();
              } else if (ev.key === "Escape") {
                ev.preventDefault();
                cancelEdit();
              }
            }
          }),
          React.createElement("div", { className: "dsh-he-actions", key: "a" }, [
            React.createElement("span", { className: "dsh-he-count", key: "c" }, draft.length + " 字 (Ctrl+Enter 保存，Esc 取消)"),
            React.createElement("button", {
              key: "c2", type: "button", className: "dsh-he-btn", "data-dsh-he": "cancel",
              disabled: saving, onClick: cancelEdit
            }, "取消"),
            React.createElement("button", {
              key: "s2", type: "button", className: "dsh-he-btn is-primary", "data-dsh-he": "save",
              disabled: saving || !draft.trim(), "aria-busy": saving ? "true" : "false", onClick: save
            }, saving ? "保存中…" : "保存")
          ]),
          error ? React.createElement("p", { key: "e", className: "dsh-he-error", "data-dsh-he": "error", role: "alert" }, error) : null
        ]));
      } else {
        if (confirming) {
          stack.push(React.createElement("div", { className: "dsh-he-confirm", "data-dsh-he": "confirm", key: "cf" }, [
            React.createElement("p", { className: "dsh-he-confirmText", key: "t" },
              "删除这条消息？界面与之后的对话都不会再包含它。"),
            React.createElement("div", { className: "dsh-he-actions", key: "a" }, [
              React.createElement("button", {
                key: "c", type: "button", className: "dsh-he-btn", "data-dsh-he": "confirm-cancel",
                disabled: deleting, onClick: function () { setConfirming(false); setError(""); }
              }, "取消"),
              React.createElement("button", {
                key: "d", type: "button", className: "dsh-he-btn is-danger", "data-dsh-he": "confirm-delete",
                disabled: deleting, "aria-busy": deleting ? "true" : "false", onClick: remove
              }, deleting ? "删除中…" : "删除")
            ])
          ]));
        }
        if (text !== "" || parts.rest.length) {
          stack.push(React.createElement("div", {
            key: "b", className: "cJsG2q_bubble dsh-he-bubble", "data-dsh-he": "bubble"
          }, [
            project(text, data, props),
            parts.rest.map(function (block, i) {
              return JsonBlock
                ? React.createElement(JsonBlock, { key: "r" + i, label: "非文本内容", payload: block })
                : React.createElement("span", { key: "r" + i, className: "cJsG2q_fileMeta dsh-he-fileMeta" }, "[非文本内容]");
            })
          ]));
        }
        if (data.referenceLabels && data.referenceLabels.length > 0) {
          stack.push(React.createElement("div", {
            key: "ref", className: "cJsG2q_referenceSummary dsh-he-refSummary", "data-dsh-he": "referenceSummary"
          }, data.referenceLabels.join(" · ")));
        }
        if (error) stack.push(React.createElement("p", { key: "e", className: "dsh-he-error", "data-dsh-he": "error", role: "alert" }, error));
      }
      if (row && row.editable === false) stack.push(React.createElement("p", {
        key: "ro", className: "dsh-he-readonly", "data-dsh-he": "readonly"
      }, "只读：" + (row.reason || "这条消息不在当前有效上下文中")));

      var actions = React.createElement("div", {
        className: "xD_KDq_actions dsh-he-actionRow",
        "data-dsh-he": "actions",
        "data-clock": "start"
      }, [
        React.createElement("span", { className: "xD_KDq_timeStart dsh-he-time", key: "t" }, recalling && phase ? phase : clockText(data.time)),
        iconButton(copied ? "已复制" : "复制", copied ? IconCheck : IconCopy, copy, { marker: "copy", disabled: copying }),
        iconButton(recalling ? "正在撤回…" : "撤回", IconRecall, recall, { marker: "recall", disabled: locked || saving || editing || recalling || deleting }),
        iconButton(canDelete ? "删除这条消息" : deleteReason, IconTrash, function () {
          if (!canDelete || deleting) return;
          setConfirming(true); setError("");
        }, { marker: "delete", disabled: !canDelete || saving || editing || recalling || deleting }),
        iconButton(locked ? lockReason : "编辑这条消息", IconEdit, openEdit, { marker: "edit", disabled: locked || saving || editing || recalling })
      ]);

      if (gone) return null;
      return React.createElement("div", {
        className: "cJsG2q_userRow dsh-he-row",
        "data-dsh-he": "row",
        tabIndex: -1
      }, [
        React.createElement("div", { className: "cJsG2q_userStack dsh-he-stack", key: "s" }, stack),
        actions
      ]);
    }

    /* ---------- 样式：沿用 native 的视觉 token 与取色，深/浅主题自适应 ---------- */

    var CSS =
      ".cJsG2q_userRow,.dsh-he-row{flex-direction:column;align-items:flex-end;gap:6px;display:flex;position:relative}" +
      ".cJsG2q_userStack,.dsh-he-stack{min-width:0;max-width:min(calc(var(--dsh-chat-content-width,748px) * .702), 82%);flex-direction:column;align-items:flex-end;gap:8px;display:flex}" +
      ".cJsG2q_bubble,.dsh-he-bubble{background:var(--dsw-specific-bubble);border-radius:var(--dsw-radius-xl);max-width:100%;font-size:var(--dsh-content-font-size,14px);line-height:calc(22px + var(--dsh-content-font-delta,0px));color:var(--dsw-alias-label-primary);white-space:pre-wrap;word-break:break-word;padding:10px 16px;cursor:text;user-select:text;box-sizing:border-box}" +
      ".cJsG2q_attachmentRow,.dsh-he-attach{flex-wrap:wrap;justify-content:flex-end;gap:8px;max-width:100%;display:flex}" +
      ".cJsG2q_referenceSummary,.dsh-he-refSummary{color:var(--dsw-alias-label-tertiary);font-size:var(--dsh-content-font-size-secondary,13px);line-height:calc(18px + var(--dsh-content-font-delta-secondary,0px))}" +
      ".cJsG2q_fileCard,.dsh-he-file{border:.5px solid var(--dsw-alias-border-l2,rgba(0,0,0,.12));border-radius:var(--dsw-radius-xl);background:var(--dsw-specific-input-major,transparent);box-sizing:border-box;flex:0 0 240px;align-items:center;gap:10px;width:240px;min-height:64px;padding:8px 12px;display:inline-flex}" +
      ".cJsG2q_fileIcon,.dsh-he-fileIcon{flex:none;width:28px;height:28px}.cJsG2q_fileContent,.dsh-he-fileBody{flex-direction:column;flex:1;min-width:0;display:flex}" +
      ".cJsG2q_fileName,.dsh-he-fileName{white-space:nowrap;text-overflow:ellipsis;overflow:hidden;color:var(--dsw-alias-label-primary);font-size:14px;font-weight:500;line-height:22px}" +
      ".cJsG2q_fileMeta,.dsh-he-fileMeta{white-space:nowrap;text-overflow:ellipsis;overflow:hidden;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:15px}" +
      ".xD_KDq_actions,.dsh-he-actionRow{height:calc(28px + var(--dsh-content-font-delta,0px));align-items:center;gap:8px;display:flex}" +
      ".xD_KDq_timeStart,.dsh-he-time{font-size:var(--dsh-content-font-size-secondary,13px);line-height:calc(24px + var(--dsh-content-font-delta,0px));color:var(--dsw-alias-label-tertiary);white-space:nowrap;padding-right:12px}" +
      ".xD_KDq_action,.dsh-he-action{width:calc(28px + var(--dsh-content-font-delta,0px));height:calc(28px + var(--dsh-content-font-delta,0px));color:var(--dsw-alias-label-tertiary);cursor:pointer;background:transparent;border:none;border-radius:var(--dsw-radius-sm);justify-content:center;align-items:center;padding:6px;box-sizing:border-box;display:inline-flex;transition:background 120ms ease,color 120ms ease}" +
      ".xD_KDq_action svg,.dsh-he-action svg{width:calc(15px + var(--dsh-content-font-delta,0px));height:calc(15px + var(--dsh-content-font-delta,0px));flex:none}" +
      ".xD_KDq_action:hover:not(:disabled),.dsh-he-action:hover:not(:disabled){color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-interactive-bg-hover)}" +
      ".xD_KDq_action:disabled,.dsh-he-action:disabled{opacity:.4;cursor:not-allowed}" +
      ".xD_KDq_action:disabled:hover,.dsh-he-action:disabled:hover{background:transparent;color:var(--dsw-alias-label-tertiary)}" +
      "@media (hover:hover){" +
        // 只在用户气泡内隐藏操作行。这条规则若写成全局选择器，会连带压住宿主原生
        // 助手按钮行（opacity:0 后元素仍在、仍可点，但永远看不见，且没有规则能恢复它）。
        ".cJsG2q_userRow .xD_KDq_actions,.cJsG2q_userRow .dsh-he-actionRow{opacity:0;transition:opacity 80ms ease}" +
        ".cJsG2q_userRow:hover .xD_KDq_actions,.cJsG2q_userRow:focus-within .xD_KDq_actions," +
        ".cJsG2q_userRow:hover .dsh-he-actionRow,.cJsG2q_userRow:focus-within .dsh-he-actionRow," +
        ".dsh-he-row:hover .xD_KDq_actions,.dsh-he-row:focus-within .xD_KDq_actions," +
        ".dsh-he-row:hover .dsh-he-actionRow,.dsh-he-row:focus-within .dsh-he-actionRow," +
        ":is([data-chat-flow-kind=user],[data-chat-flow-kind=steering]):hover .xD_KDq_actions," +
        ":is([data-chat-flow-kind=user],[data-chat-flow-kind=steering]):hover .dsh-he-actionRow," +
        ":is([data-chat-flow-kind=user],[data-chat-flow-kind=steering]):focus-within .xD_KDq_actions," +
        ":is([data-chat-flow-kind=user],[data-chat-flow-kind=steering]):focus-within .dsh-he-actionRow{opacity:1}" +
      "}" +
      ".dsh-he-edit{width:min(calc(var(--dsh-chat-content-width,748px) * .702), 82%);flex-direction:column;gap:8px;display:flex}" +
      ".dsh-he-ta{font:inherit;font-size:var(--dsh-content-font-size,14px);line-height:calc(22px + var(--dsh-content-font-delta,0px));box-sizing:border-box;width:100%;resize:vertical;min-height:56px;padding:10px 16px;border-radius:var(--dsw-radius-xl);color:var(--dsw-alias-label-primary);border:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.3));background:var(--dsw-specific-bubble);outline:none;transition:border-color .15s ease,box-shadow .15s ease}" +
      ".dsh-he-ta:focus{border-color:var(--dsw-alias-state-business-primary,#4d6bfe);box-shadow:0 0 0 1px var(--dsw-alias-state-business-primary,#4d6bfe)}" +
      ".dsh-he-actions{flex-wrap:wrap;align-items:center;gap:8px;justify-content:flex-end;display:flex}" +
      ".dsh-he-btn{font:inherit;font-size:13px;cursor:pointer;border:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.35));border-radius:var(--dsw-radius-sm);padding:4px 12px;background:transparent;color:var(--dsw-alias-label-primary);transition:background .12s,border-color .12s}" +
      ".dsh-he-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}" +
      ".dsh-he-btn:disabled{opacity:.45;cursor:not-allowed}.dsh-he-btn.is-primary{background:var(--dsw-alias-state-business-primary,#4d6bfe);border-color:transparent;color:#fff}" +
      ".dsh-he-btn.is-primary:hover:not(:disabled){opacity:.9}" +
      ".dsh-he-count{margin:0;font-size:12px;color:var(--dsw-alias-label-tertiary)}.dsh-he-readonly{margin:0;font-size:12px;color:var(--dsw-alias-label-tertiary);line-height:16px}.dsh-he-error{margin:0;font-size:12px;color:var(--dsw-alias-state-error-primary,#e5484d)}" +
      ".dsh-he-confirm{max-width:min(calc(var(--dsh-chat-content-width,748px) * .702), 82%);flex-direction:column;gap:8px;display:flex;padding:10px 16px;border-radius:var(--dsw-radius-xl);border:1px solid var(--dsw-alias-state-error-primary,#e5484d);background:var(--dsw-specific-bubble)}" +
      ".dsh-he-confirmText{margin:0;font-size:13px;line-height:18px;color:var(--dsw-alias-label-secondary)}" +
      ".dsh-he-btn.is-danger{background:var(--dsw-alias-state-error-primary,#e5484d);border-color:transparent;color:#fff}" +
      ".dsh-he-btn.is-danger:hover:not(:disabled){opacity:.9}" +
      ".xD_KDq_action:focus-visible,.dsh-he-action:focus-visible,.dsh-he-btn:focus-visible{outline:1.5px solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:2px}";

    function apply(ctx) {
      HOST.ctx = ctx;
      /* 清理由 ctx.effect 持有：Host 不保证消费 apply 的返回值，只 return cleanup 会泄漏。
         slots.inject 内部已自绑 ctx.effect（声明期变更会自行重建/回收），这里不再重复 dispose。 */
      function effect(fn, label) {
        if (ctx && typeof ctx.effect === "function") { try { return ctx.effect(fn, label); } catch (err) { /* 退回手动 */ } }
        var dispose = fn();
        if (ctx && typeof ctx.on === "function") ctx.on("dispose", function () { try { dispose(); } catch (err) { /* ignore */ } });
        return function () { try { dispose(); } catch (err) { /* ignore */ } };
      }

      effect(function () {
        var styleTag = null;
        try {
          styleTag = document.createElement("style");
          styleTag.setAttribute("data-dsh-history-editor", "");
          styleTag.textContent = CSS;
          document.head.appendChild(styleTag);
        } catch (err) { styleTag = null; }
        return function () {
          if (styleTag && styleTag.parentNode) styleTag.parentNode.removeChild(styleTag);
        };
      }, "dsh-history-editor: styles");

      /** 注册到用户气泡的 keyed 席位；旧插件同款模式。若该 (key, priority) 已被占用则降一级再试。 */
      effect(function () {
        function mount(priority) {
          return ctx.slots.inject("conversation.chat.node", function () {
            return ctx.slots.register({
              name: "conversation.chat.node", key: "user", priority: priority,
              inject: function (sessionId) { return { sessionId: sessionId }; }
            }, UserBubbleEdit);
          });
        }
        var d = null;
        try { d = mount(-1); }
        catch (err) {
          try { d = mount(-2); }
          catch (err2) { d = null; console.warn("[dsh-history-editor] 用户气泡席位注册失败：", err2); }
        }
        // slots.inject 已随 ctx 生命周期回收；这里只做兜底，重复调用是幂等的。
        return function () {
          HOST.ctx = null;
          if (typeof d === "function") { try { d(); } catch (err) { /* ignore */ } }
        };
      }, "dsh-history-editor: user bubble seat");

      return function () { /* 生命周期归 ctx.effect；返回值保留仅为兼容旧 Host 约定 */ };
    }

    // uiWorkspace 是撤回切换分支的必需服务（与 package.json 的 dsh.client.inject 保持一致）。
    return { name: "dsh-history-editor", inject: ["slots", "sessions", "uiWorkspace"], apply: apply };
  }
});
