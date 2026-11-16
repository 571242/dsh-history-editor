# DSH 用户消息历史编辑与删除

## 0.4.3：修复 rc.3 下用户气泡 UI 完全不显示

0.4.2 在 DSH 0.2.2-rc.3 上整块用户席位不渲染。根因：rc.3 的宿主已在它自己的 `conversation.chat.user.content` 工厂里声明了子槽 `conversation.chat.user.images`；0.4.2 又在 `key="user"` 的 `conversation.chat.node` 注册上重复声明同一子槽。SlotCore 的唯一声明规则当场抛 `slot "conversation.chat.user.images" is already declared`，激活失败，而旧代码把这个异常吞进 `try/catch`，于是「一个按钮都没有」，而不是报错。

0.4.3 的改动：用户席位注册**不再声明任何子槽**；激活期不再吞异常；正文/附件/引用改为调用宿主 `renderFactorySlot("conversation.chat.user.content", …)` 渲染（与原生气泡完全一致），插件只补「复制 / 撤回 / 删除 / 编辑」动作行与编辑/确认壳。图片因此仍由宿主 `conversation.chat.user.images` 正常显示，不会重复声明。`test/client.test.mjs` 增加两条回归：席位不得带子槽、以及在「重复声明即抛错」的宿主校验下 `apply` 仍能成功注册。

本版本只改插件前端 `client.js`（profile 走 `link:F:/SPACE/dsh-history-editor`，没有镜像副本），不触碰 app.asar、真实会话或宿主补丁。改动后需要**重载插件**（或硬刷新页面）让浏览器重新拉 `client.js`；后端宿主补丁与 0.4.2 相同，无需重新部署。

## 0.4.2：兼容 DSH 0.2.2-rc.3

保留 0.4.1 的独立 `Session.create()` 启动探针，不向只读 `sessions.prepare()` append，也不发布真实 Store 事件。前端去掉宿主构建哈希类名，使用插件稳定 CSS；~~图片按 rc.3 的 `conversation.chat.user.images` 子 slot 渲染并传递 `loadImage`~~（该做法即在 rc.3 上导致整块 UI 消失，0.4.3 已撤销，改为透传宿主 `user.content` 工厂）。

删除补丁现只修改当前版两个等长 entry：严格格式校验器和 Session 能力 gate。仅放行无打开 step、指向单条人类用户消息的空删除载体；普通 append、助手目标、受保护系统头和畸形替换仍拒绝。两份 entry 缺任一份都不会开放插件删除。聊天投影与 TokenMeter 已原生支持 replacement，不重复打补丁。

这次仓库修复没有修改实际安装包、真实 session 或配置；宿主 entry 的统一部署与 ASAR header SHA 更新由集成方执行。不得使用旧版整体补丁。详见 [部署说明](host-patch/CURRENT.md) 与 [验证记录](VERIFICATION.md)。

升级回归需把 `DSH_HISTORY_EDITOR_HOST_NODE_MODULES` 指向当前安装包的完整提取目录，再运行 `npm test`；补丁叠加测试运行 `node --import ./test/patched-host-loader.mjs --test test/*.test.mjs`（Node 24，内存覆盖，不修改宿主副本）。

在用户气泡原位编辑或删除已经发过的消息，后续消息保留，不新建分支、不自动重发。

- **只作用于用户消息**：编辑文字、删除、撤回、复制。
- **助手回复完全不在范围内**：不改写、不删除、不复制、不撤回，也不注册任何助手侧界面席位。助手气泡及其原生按钮（复制／分支）完全由宿主渲染，插件不碰它的 DOM。

保存不发送新请求、不重算旧回答，只更新该气泡显示与下次请求使用的有效上下文。

## 快速使用

- 用户消息：气泡下方「复制 / 撤回 / 删除 / 编辑」。
- 删除需二次确认；删除后气泡与后续请求都不再包含它。
- 撤回保留原分支，从该消息之前的安全边界 fork 新分支并切过去，不自动发送。
- 注入上下文（系统提示、压缩摘要等）只读。正在回复或历史已变化时拒绝操作。
- 已被压缩折叠的消息不能继续改上下文；之前保存的修订仍用于显示。

## 宿主补丁

只有**删除**需要 [当前版补丁](host-patch/CURRENT.md)。编辑、复制、撤回不需要。未安装时删除被明确拒绝且零写入，插件仍会启动。

运行 `node host-patch/build-current.mjs NODE_MODULES OUTPUT_DIR` 可生成当前版两个等长 entry 和逐 entry 原/新 SHA256。源 entry 哈希或唯一 anchor 不匹配立即拒绝。默认输出在 `host-patch/current/`。

`host-patch/app.asar`、根 manifest 和旧 files 都是 **0.2.1-rc.2 旧产物**，不得用于 rc.3；旧 `Apply-Patch.ps1` 的 Verify/Install 已禁用，仅保留旧版本的 Rollback 分支。当前补丁不整体替换 archive；集成部署必须先备份 archive、校验 entry，再同步写 entry bytes 和 header integrity，并验证回读。部署与回滚步骤见当前版说明。仓库脚本不关闭或启动 DSH。

### 风险

- **用删除改过历史的会话依赖这个补丁才能正常载入**。回滚官方文件后，含删除记录的会话可能读不出来——回滚前先确认，或回滚后重新装回补丁。
- **软件升级会覆盖补丁**。升级后需重新安装；脚本发现版本哈希不匹配会拒绝执行，而不是损坏新版本。
- 编辑只影响该会话后续请求使用的上下文，不是隐私擦除：原文仍保留在追加式日志中。

## 实现与验证

插件侧（index.js / core.js / client.js）：

- 后端复用宿主正式的单节点区间替换与令牌计价协议，原始日志不被覆盖。
- 删除载体带合法 turn/step——这正是此前报 system/message turn must be a non-negative safe integer 的原因。
- 删除范围由日志中的删除标记（historyEditor.removedIds）恢复，刷新后不会复活；普通压缩不算删除。
- 先编辑再删除的消息不会因 saved fallback 复活。
- 前端按稳定 message id 映射修订，不用 React 内部字段猜消息身份。

验证结果（2026-11-15，rc.3 完整提取宿主）：

- 原版与完整补丁覆盖各 53 项通过，0 失败、0 跳过；Session-only / Format-only 各 4 项通过，gate 均关闭。
- 真实 format-v4 严格 restore 验证重复编辑、删除、无系统头删除、助手原文不变；畸形载体、未知 step、助手目标、系统头与普通乱序 append 都被拒。
- 真实 TokenMeter 验证用户改写/删除更新有效上下文，且不重复计入模型请求费用。
- 客户端替身验证图片子 slot / loadImage / 附件与稳定 CSS；只注册 user 席位。

未做：实际安装包部署、真实 flush 端到端与浏览器点击验收；不能把替身/codec 测试当作 GUI 实机结果。

升级宿主后需要复核接口适配。
