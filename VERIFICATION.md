# 验证记录

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
