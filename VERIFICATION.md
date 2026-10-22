# 验证记录

日期：2026-10-17；本机 DSH Desktop 0.2.1-rc.2（插件 0.4.0：助手侧功能已移除）。

## 本轮变更（0.4.0）

助手消息的**改写、删除、复制、撤回**全部移除，助手侧不再注册任何界面席位（`conversation.chat.assistant-actions` 不再挂载），也不再有 portal 正文投影与原生复制同步逻辑。用户消息的编辑/删除/撤回/复制保持不变。

同时修掉一个真实故障：`index.js` 原先要求 runtime-check 全绿才启用插件，而该检查包含需要宿主补丁的删除路径——本机未装补丁时插件整块不加载（`/history-editor/*` 全部 404，`.scratch/runtime-check.json` 记录 `ok:false`）。现在检查只覆盖用户消息改写，删除改为单独探测：缺补丁时删除在请求里明确拒绝并说明原因，插件照常启动。

## 已确认（本轮）

- `npm run check` 通过；`npm test` 45 项全通过。
- core 测试：新增「助手回复既不可编辑、也不可删除、也不可撤回」——list 不返回助手回复，三种操作全部被拒且不写日志。
- backend 真实宿主测试：`真实 v4 编码器 + restore` 用例改为用户改写/删除往返，助手原文逐字校验不变；新增「助手回复永远不会成为改写或删除目标」，断言 `session.seq` 不变；真实 token-meter 用例改为用户改写计价。
- client 测试：注册席位断言收缩为「只有用户席位」；新增源码级边界用例，禁止 `conversation.chat.assistant-actions / AssistantActionsRow / assistant-edit / assistant-delete / assistant-copy / assistant-recall / dsh-he-assistantProjection / data-dsh-history-copy-text / react-dom / createPortal` 残留。
- 启动探针（用完已删）：用真实宿主 Session + TokenMeter 跑 `verifyRuntime` 两态——
  - 未装补丁：`ok:true`、`deletion:"needs-host-patch"`，改写与序列化重放结果正确 → 插件会正常加载。
  - 已装补丁：`ok:true`、`deletion:"available"`。
- 上面这条探针在**本机真实安装版 0.2.1-rc.2 的未修改 app.asar 提取产物**上重跑，结果一致（项目里原有夹具是 0.2.0-rc.2）。
- 同一份真实编码器上单独验证：用户改写 → `restore` 读回 `["u1:q revised","a1:A"]`，助手原文不变；删除在未装补丁时返回「请先安装历史编辑宿主补丁并重启 DSH；未写入任何删除」且 `session.seq` 不变。README 中「编辑不需要补丁、删除需要补丁」的表述由此坐实。

## 上轮遗留（未变）

- 编辑器与撤回流程的真实界面点击验收仍未做（浏览器自动化扩展未连接）；本轮只做代码与宿主协议层验证，不声称 GUI 已实机验收。
- `sessions.flush` 在测试与启动探针里是桩，真实落盘链路未端到端验证。
- 宿主补丁的版本覆盖风险仍在：升级 DSH 后需重装，脚本发现哈希不匹配会拒绝执行。

## 支持边界

仅用户历史文字。助手回复、系统提示、工具记录均不可改写或删除。被压缩、折叠、已撤回的记录不在当前有效历史中，不可直接编辑。旧回答不会重新计算。完整日志导出仍含原文，不是隐私擦除。
