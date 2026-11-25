# 0.2.2-rc.3 最小宿主补丁

仅使用本目录的 `build-current.mjs` 与 `current/manifest.json`。上一级 app.asar、manifest.json、files 和 Install.cmd 属于 0.2.1-rc.2 旧整体补丁，禁止用于新版；旧安装入口已阻止 Verify/Install。

## 生成

PowerShell：

    $env:DSH_HISTORY_EDITOR_HOST_NODE_MODULES='F:\SPACE\Agent\.scratch\dsh-022rc3-root\node_modules'
    node host-patch/build-current.mjs

Builder 固定原始 entry SHA256、验证替换 anchor 恰好一次，保留可执行代码，只回收文档注释作长度空间并补空格。输出两个逐字节等长 entry，不改当前宿主或解包目录，不重建整个 archive。

- dsh/node_modules/@deepseek-ai/dsh-session-format-v3-to-v4/lib/index.js：74275 bytes；原 SHA256 `da0b0c2e1460316e659f48f4222730962046b3634d1fb634683bb7243a7bba80`；新 SHA256 `04b75910ce0f66da6d17b3738954238d5d00ce0ace1d4e75cc5d04bcd5bcbc5c`。
- dsh/node_modules/@deepseek-ai/dsh-session/lib/index.js：97640 bytes；原 SHA256 `d9911b5e1585bcb142d03ce46eb2990b3fc7c254de5a76d3ffb124bd2469216c`；新 SHA256 `7e90943d37e5f0fe240f310a2f6d9b7b7e9ecc33c2a6c594062c477b2378b99d`。

## 精确行为

`requireStep` 只对已声明并完整校验的删除载体放行：无打开 step，类型 system/message，空 system-prompt 消息，单节点 replace，sourceEventSeqs 恰好为目标，目标是当前 surface 的人类 user/message，removedIds 恰好匹配目标 ID，且 turn/step 对应此前实际 step/start。protectedHead 不得成为目标。审计载体畸形时即便碰巧在打开 step 内也拒绝；普通 append 与其它 event 的 turn/step 校验不变。无系统头会话只对同一精确载体豁免系统头先决条件。

格式模块导出 `historyEditorProtocol=1`；Session getter 通过 namespace 检查该导出，故只部署一份 entry 时插件 gate 保持关闭。新聊天投影、TokenMeter 原生支持替换，不修改它们。

## 集成部署契约（生成器不自动安装）

本机已由根代理完成校验后等长部署，实际回执见 current/deployment.json，验收与备份说明见 ../VERIFICATION.md。当前进程仍需重启；下列是通用集成要求，不表示已完成浏览器点击验收。

1. 记录目标 archive 的完整 SHA256，保留可回退副本；不要覆盖已有不同 hash 的备份。若同一 archive 包含其它已部署功能，备份必须保留这些功能，不能用旧官方整包回退覆盖它们。
2. ASAR 集成器解析当前 header，以 manifest 中的路径取 entry，逐项检查 packed/offset/size 与原始 SHA256；任一不符零写入拒绝。已是新 hash 的 entry 视为已安装，不重复 patch。
3. 在 staging 副本中，把 current/files 对应等长 bytes 写入原 entry span。**同步更新每个 entry 的 integrity SHA256 与 blocks，再更新 header；长度与 offset 不变不代表可略过完整性元数据。** 根代理使用 prepareIntegrityUpdate / writeEntrySpan / writeIntegrityUpdate 完成这一步。
4. 验证 staging 完整 hash、header、逐 entry 新 SHA256 和未目标 entry 的保持性。部署方在约定维护窗口作原子替换；仓库任务不停止宿主、不修改真实 app.asar。
5. 一次宿主重启后再硬刷新现有 GUI；后端模块和 Session getter 不会由浏览器刷新更新。插件加载器也需重新读取 0.4.2 的 client.js；是否自动 HMR 必须由部署方实际核验。
6. 先在独立测试 session 验证 messages/edit/delete/recall、附件和重载，再接触需要保留的真实历史。核对 delete 后助手与后续用户消息不变。

回滚：停在相同维护窗口，校验备份 SHA 后原子恢复部署前 archive，或仅还原这两个原 entry 及其原 integrity 元数据（若之后另有其它 entry 更新，优先逐 entry 回滚）。重启再硬刷新。**软件回滚不会撤销日志里的删除；已有删除载体的会话仍依赖 patched reader 重放。** 不修改、重写或删减真实日志。

## 验证

    $env:DSH_HISTORY_EDITOR_HOST_NODE_MODULES='F:\SPACE\Agent\.scratch\dsh-022rc3-root\node_modules'
    node --test test/*.test.mjs
    node --import ./test/patched-host-loader.mjs --test test/*.test.mjs
    $env:DSH_HISTORY_EDITOR_PATCH_PART='session'
    node --import ./test/patched-host-loader.mjs --test test/host-patch.test.mjs
    $env:DSH_HISTORY_EDITOR_PATCH_PART='format'
    node --import ./test/patched-host-loader.mjs --test test/host-patch.test.mjs

需要 Node 24（registerHooks）；loader 只在该测试进程里覆盖两个模块，未写入解包宿主。正常进程移除 DSH_HISTORY_EDITOR_PATCH_PART 后再跑原版测试。完整记录见 ../VERIFICATION.md。未验证实际 archive 安装、真实持久化 flush 和浏览器点击。
