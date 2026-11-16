# 验证记录

## 2026-11-15：0.4.3 修复 rc.3 用户气泡无 UI

症状：0.4.2 在 DSH 0.2.2-rc.3 里对话中的用户气泡没有任何编辑/删除/撤回/复制按钮，整块席位不渲染。

根因（在已安装 app.asar 里核对，非仓库替身推断）：

- 宿主 `dsh-client-ui-chat` 的 `apply.ts` 用 `registerFactory` 注册 `conversation.chat.user.content`，其 `children` 已声明 `conversation.chat.user.images: { kind: 'single', scope: 'session' }`。
- 宿主前端 dist（`dsh-web-frontend/dist/assets/index-Ciz7DZxv.js`）里的 SlotCore 在校验声明时对已占用子槽抛 `slot "<key>" is already declared (by <declaredBy>)`；`declaredBy` 显示为工厂名。
- 0.4.2 的 `client.js` 在 `key="user"` 的 `conversation.chat.node` 注册里又写了同一 `children`，于是 `register` 当场抛错；旧代码把这次失败吞进 `try { mount(-1) } catch { try { mount(-2) } catch { console.warn } }`，最终 `registered` 为空 → 无 UI，且控制台只有一条 warn。

修复：删掉用户席位上的 `children` 声明；`ctx.slots.inject(...)` 里直接 `register` 且不再吞异常；正文/附件/引用改用 `props.renderFactorySlot("conversation.chat.user.content", …)`（参数 `content / loadImage / facts / interactive`）交给宿主渲染，插件仅保留动作行与编辑/确认壳。图片由宿主 `user.images` 正常渲染，不再重复声明。

验证（Node v24.19.0）：

- `node --check client.js / index.js / core.js / verify-runtime.js` 全部通过。
- `node --test test/client.test.mjs`：26/26，新增两条回归——①用户席位必须 `children === undefined`、正文走 `conversation.chat.user.content` 且附件映射正确；②在「重复声明宿主子槽即抛 already declared」的宿主校验下 `apply` 仍成功、`registered.length === 1`。旧 0.4.2 会在该断言处失败。
- `node --test test/*.test.mjs`（`DSH_HISTORY_EDITOR_HOST_NODE_MODULES` 指向 rc.3 完整提取目录）：54/54。
- `node --import ./test/patched-host-loader.mjs --test test/*.test.mjs`：54/54；session-only / format-only 各 4/4，gate 行为不变。
- profile 的 `node_modules/dsh-history-editor` 是 `link:F:/SPACE/dsh-history-editor`，`client.js` SHA256 与仓库一致（无镜像副本），故重载插件即加载修复。

未验证：本机 Electron GUI 的实机点击/截图（browser-skill 扩展未连接，CDP 端口未开）。逻辑层已用宿主真实源码与规则校验，GUI 需重载插件后人工确认。

## 2026-11-15：本机部署补记

根代理已在实际安装归档部署两个等长协议条目并同步 SHA256 完整性字段；未修改执行文件或真实会话。部署前已有破甲九处清洗，副本还原后与最初官方归档哈希完全一致，确认没有覆盖额外改动。副本比较只允许目标条目及其校验槽变化。

- 当前归档：F:/EXE/DeepSeek/resources/app.asar，209021953 bytes；SHA256 `66fc7b78a044a8811cbe01c0339ae94b39ef36f1543edb124aa56291c8e8f7cc`。
- 完整备份：F:/EXE/DeepSeek/resources/app.asar.bak-before-custom-022rc3-fix；SHA256 `34ce4fb01caae2114db032d2ab44472e75b0510edc0eaf456affd7040688e932`。备份保留部署前破甲清洗，不包含新删除协议。
- 逐条 OFFSET、原/新 hash、integrity 槽、清洗恢复清单位置见 host-patch/current/deployment.json。执行文件的 embedded ASAR integrity fuse 已确认关闭，没有修改 EXE、无需重签名。
- 破甲开关源码和 profile 安装副本版本 1.2.4 一致；11 项回归零失败/跳过，真实归档清洗 9/9、integrityBlocked=[]、restorable=true。
- 历史编辑器 53/53（当前宿主内存补丁完整回归）；安装后另用实际 Electron 可执行文件与 app.asar 内模块运行 backend-host-protocol/runtime-host，共 8/8，零失败/跳过。不是仅测试解包副本。
- 项目工作台 0.2.0：88/88，包含实际安装 Electron SDK 注册表、技能发现/加载集成；语法检查通过，无需改代码。仙华预设核心兼容，内置技能目录与 Office 工具为可选补齐；未改人设、模型或预设文件。

还需用户重启 DSH 一次并刷新原页面，当前进程缓存不会由磁盘补丁替换。浏览器扩展未连接，未做重启后 GUI 点击/图片显示验收，也未向真实会话写入删除以验证 Store flush。回滚软件不会撤销日志里的删除，已有删除载体仍需要 patched reader；完整备份仅在退出 DSH、确认日志兼容性后恢复。

## 2026-11-15：0.4.2 源码适配 0.2.2-rc.3

独占仓库写入，保留进入任务前 README/VERIFICATION/package/host 测试与 verify-runtime 的未提交修改。没有修改实际 app.asar、解包宿主、真实 session、armor 或 cordis 配置，也没有启动服务器或停止宿主。

根因与改动：

- rc.3 原生 Session 与聊天投影已经支持空 system/message 位置替换和 TokenMeter 回收，但严格 v4 restore 的 requireStep 拒绝关闭 step 上的删除载体。旧 rc.2 整包补丁不可使用。
- 新 builder 仅生成当前格式模块与 Session 两个等长 entry，pin 原 hash 与唯一 anchor。精确删除守卫保持 user-only、单节点、空载体、removedIds/sourceSeq 一致性与真实历史坐标；普通 append、不匹配 step、助手目标、受保护系统头和畸形替换仍拒绝。Session 能力 getter 与格式模块导出联动，缺任意 entry 不开放插件删除。
- 前端只注册 key=user，移除宿主 hash 类与 CSS 选择器，使用插件自身稳定类；声明 conversation.chat.user.images 子 slot 并用 renderSlot 传 images/loadImage/align/compact。未改新宿主聊天与 TokenMeter。
- 旧 Apply-Patch.ps1 的 Verify/Install 入口已禁用，仅保留旧版 Rollback；当前部署方案见 host-patch/CURRENT.md，必须同步 ASAR entry integrity。

使用完整当前包：F:/SPACE/Agent/.scratch/dsh-022rc3-root/node_modules；Node v24.19.0。原版 53/53、完整内存补丁 53/53、Session-only 4/4、Format-only 4/4，均零失败/跳过。新增前端图片/稳定 CSS 测试先红后绿；原版严格 replay 的 closed-step 删除失败仍有反例验证。真实 codec + restore、TokenMeter、SessionProjectionRegistry 均使用宿主实现，持久化 flush 使用桩。

最终 entry 大小与 SHA256：

- format-v3-to-v4/lib/index.js：74275 → 74275 bytes；da0b0c2e1460316e659f48f4222730962046b3634d1fb634683bb7243a7bba80 → 04b75910ce0f66da6d17b3738954238d5d00ce0ace1d4e75cc5d04bcd5bcbc5c。
- session/lib/index.js：97640 → 97640 bytes；d9911b5e1585bcb142d03ce46eb2990b3fc7c254de5a76d3ffb124bd2469216c → 7e90943d37e5f0fe240f310a2f6d9b7b7e9ecc33c2a6c594062c477b2378b99d。

未验证：实际 archive 部署/重启后能力、真实落盘 flush、浏览器点击和图片实际显示。本仓库的结果不是实机 GUI 验收。

## 2026-11-06：0.4.1 兼容修复

当前安装 DSH Desktop 0.2.2-rc.1，`app.asar` SHA256：`b80c05f6b8f403cae6fdcbf7270568f6709d19bb2242cd3eea5bab0eeed698a5`。

根因：新版 `sessions.prepare()` 会标记 Session 为未宣布、只读。旧启动自检向它 append 事件，抛出 `cannot append outside a SessionStore`；插件在注册 HTTP 路由前中止。修复只修改自检对象与重放对象的创建方式：从已注入宿主取得 Session 类，使用静态 `Session.create()` 独立快照，传递消息投影，不进入真实 Store、不宣布、不发布测试事件。保留原有写入兼容检查。

验证使用直接从当前安装包提取的模块，显式配置 `DSH_HISTORY_EDITOR_HOST_NODE_MODULES`，不是旧版临时夹具。

- 完整回归 48 项通过，0 失败、0 跳过；index/core/client/verify-runtime 语法及 git diff --check 通过。
- 新增真实新版 Store 的只读 prepare 回归、独立自检成功且不发布 Store 事件、启动通过后注册所有路由及失败时不注册。
- 真实 format-v4 编码器与 restore 验证重复用户修改、助手原文不变、撤回边界和前置修订、当前草稿；撤回准备不修改原会话。
- 真实 TokenMeter 与 SessionProjectionRegistry 验证用户改写更新有效上下文、但不重复计费。官方未打补丁宿主删除请求被拒且零写入。
- 移除测试默认回退 `.scratch/app-asar-work` 的旧版宿主，避免升级回归误报。
- 本机安装 symbolic link 保持指向工程；只重载此插件后，现场 messages/edit/delete/recall 路由可用。profile 启用配置恢复后 SHA256 与修改前一致。主程序与真实会话日志未修改。

未验证：浏览器实机点击与真实 flush 端到端。浏览器扩展未连接，桌面自动化缺少截图依赖，因此没有把协议/替身验证描述成 GUI 点击验收。删除专用宿主补丁没有更新或安装。

前端静态核对确认 fork、openSession、scope、输入框 setDraft 与用户席位仍兼容，未重写它们。另发现图片附件辅助渲染接口已漂移，旧回退可能只显示 `[图片]`；本次未扩展到附件展示重构。

## 旧版记录

2026-10-17，本机 DSH Desktop 0.2.1-rc.2，插件 0.4.0。

## 0.4.0 做了什么

删掉了助手消息的改写、删除、复制、撤回。助手侧不再注册任何界面席位（`conversation.chat.assistant-actions` 不再挂载），portal 正文投影和原生复制同步逻辑一起移除。用户消息的编辑、删除、撤回、复制没动。

顺带修了一个会导致插件根本不加载的问题。`index.js` 原先要求 runtime-check 全绿才启用，而这项检查里包含需要宿主补丁的删除路径。本机没装补丁时检查失败，整个插件就不加载，`/history-editor/*` 全部 404，`.scratch/runtime-check.json` 里记着 `ok:false`。现在检查只覆盖用户消息改写，删除改成单独探测：缺补丁时请求里明确拒绝并说明原因，插件照常启动。

## 跑过的验证

- `npm run check` 通过，`npm test` 45 项全通过。
- core 测试新增一条「助手回复既不可编辑、也不可删除、也不可撤回」：list 不返回助手回复，三种操作全部被拒且不写日志。
- backend 真实宿主测试里，`真实 v4 编码器 + restore` 用例改成用户改写/删除往返，助手原文逐字校验不变。另外加了「助手回复永远不会成为改写或删除目标」，断言 `session.seq` 不变。真实 token-meter 用例改成用户改写计价。
- client 测试的注册席位断言收缩到「只有用户席位」，并新增源码级边界用例，禁止 `conversation.chat.assistant-actions`、`AssistantActionsRow`、`assistant-edit`、`assistant-delete`、`assistant-copy`、`assistant-recall`、`dsh-he-assistantProjection`、`data-dsh-history-copy-text`、`react-dom`、`createPortal` 残留。
- 用一个临时探针（跑完已删）拿真实宿主 Session + TokenMeter 跑 `verifyRuntime` 的两种状态：没装补丁时 `ok:true`、`deletion:"needs-host-patch"`，改写和序列化重放结果正确，插件会正常加载；装了补丁时 `ok:true`、`deletion:"available"`。
- 同一个探针在本机真实安装版 0.2.1-rc.2 的未修改 app.asar 提取产物上重跑，结果一致。项目里原有夹具是 0.2.0-rc.2。
- 在同一份真实编码器上单独验证：用户改写后 `restore` 读回 `["u1:q revised","a1:A"]`，助手原文不变；未装补丁时删除返回「请先安装历史编辑宿主补丁并重启 DSH；未写入任何删除」，且 `session.seq` 不变。README 里「编辑不需要补丁、删除需要补丁」的说法就是这样确认的。

## 没验证的部分

- 编辑器和撤回流程还没在真实界面点过。浏览器自动化扩展当时没连上，所以只做了代码与宿主协议层验证，不能说 GUI 已实机验收。
- `sessions.flush` 在测试和探针里是桩，真实落盘链路没做端到端验证。
- 宿主补丁仍有版本覆盖风险：升级 DSH 后要重装，脚本发现哈希不匹配会拒绝执行，不会损坏新版本。

## 支持边界

只管用户的历史文字。助手回复、系统提示、工具记录都不可改写或删除。被压缩、折叠、已撤回的记录不在当前有效历史里，不能直接编辑。旧回答不会重新计算。完整日志导出仍含原文，不是隐私擦除。
