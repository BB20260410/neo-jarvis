# 交接文档：集群协同 + Electron 稳定化

日期：2026-06-01  
项目：Noe / Claude 可视化面板  
真实仓库路径：`/Users/hxx/Desktop/00_项目/05_Claude可视化面板`  
当前目标：让「集群协同」模式能真实用于项目开发，并推进到 Electron 可用形态，避免面板时不时连不上、启动失败、模型探活失败。

## 一句话总结

本轮已把「集群协同」从容易误报/卡死/探活失败的状态，推进到当前可实际运行状态：真实面板能打开，Electron 打包版能启动，Claude + Codex/GPT + Gemini CLI 三模型 live preflight 全通过，图片附件上传链路可用，完整 lint/test/e2e/package/check 均通过。

## 当前可用结论

当前可以开始用这个模式做小型真实项目试跑。  
但这仍是“本地开发可用状态”，不是正式商业分发级 App。正式 Electron 发行还需要签名、公证、asar 策略、长任务压测和正式安装包验证。

## 重要路径

- 仓库根目录：`/Users/hxx/Desktop/00_项目/05_Claude可视化面板`
- 当前面板地址：`http://127.0.0.1:51835`
- owner token 文件：`~/.noe-panel/owner-token.txt`
- 面板日志：`/tmp/noe-panel-51835.log`
- Electron 输出目录：`/Users/hxx/Desktop/00_项目/05_Claude可视化面板/out/mac-arm64`
- Electron 可执行文件：`/Users/hxx/Desktop/00_项目/05_Claude可视化面板/out/mac-arm64/Noe.app/Contents/MacOS/Noe`

## 本轮修复内容

1. owner token 裸开页面误报

- 问题：用户裸开 `127.0.0.1:51835` 时，受保护 API 轮询会产生 401 噪声，用户误以为启动失败。
- 修复：无 owner token 时前端显示恢复提示，并暂停受保护接口轮询。
- 涉及文件：`public/app.js`

2. E2E 访客态不真实

- 问题：E2E 的“裸开页面”仍然带着 `?t=...`，导致 owner-token 缺失场景没有真实覆盖。
- 修复：E2E 访客 URL 主动删除 `t` 参数。
- 涉及文件：`tests/e2e/panel-ui-walkthrough.mjs`

3. 集群项目目录误报“越权或敏感”

- 问题：正常的多层项目目录在父目录不存在时被过严拦截。
- 修复：允许安全祖先路径下创建多层缺失目录，同时继续拦截敏感 home 路径。
- 涉及文件：`src/server/routes/rooms.js`、`tests/unit/routes/rooms-list-summary.test.js`

4. 图片/视频附件上传

- 问题：浏览器标准 `multipart/form-data` 上传会返回 415。
- 修复：`/api/rooms/:id/media` 同时支持 raw binary 和 multipart/form-data，返回 `attachment` 与 `media` 双别名。
- 涉及文件：`server.js`

5. 资源守卫误阻断

- 问题：小内存场景下 `heapUsedRatio` 高会被误判为资源危险。
- 修复：加入绝对 heap 阈值，避免几十 MB 的高比例被误阻断。
- 涉及文件：`src/server/services/cluster-resource-guard.js`、`tests/unit/cluster-resource-guard.test.js`

6. ops guard 把历史 warning 当重启风险

- 问题：历史/诊断类 warning 会导致启动检查出现过度风险提示。
- 修复：区分 meta warning 和真正的资源/恢复/运行风险。
- 涉及文件：`src/server/services/cluster-ops-guard.js`、`tests/unit/cluster-ops-guard.test.js`

7. restart timeout 假失败

- 问题：`restart:panel` 15 秒等待过短，慢启动时会误报 `port_not_listening`。
- 修复：默认等待提高到 45 秒。
- 涉及文件：`scripts/restart-panel.mjs`

8. Gemini live ping 不稳定

- 问题：用户填写 `gemini-3.5-flash`，当前 Gemini CLI 0.44.1 实测返回 `ModelNotFoundError`；live ping 先试该模型会卡或失败。
- 修复：Gemini 3.x UI 输入在当前 CLI 下映射到稳定 `gemini-2.5-flash` 链；live ping 使用快速稳定链 `gemini-2.5-flash -> gemini-2.5-flash-lite`，不先消耗 pro，也不先试无效 3.x。
- 涉及文件：`src/room/GeminiSpawnAdapter.js`、`tests/unit/dispatcher/gemini-fallback-chain.test.js`

9. Electron 打包污染 Node 原生 ABI

- 问题：`electron-builder` 会把根目录 `node_modules` 中的 `better-sqlite3` 等原生模块重编成 Electron ABI，随后普通 Node 面板/单测就报 `NODE_MODULE_VERSION` 不匹配。这是此前“打包/打开 Electron 后面板又异常”的核心稳定性问题。
- 修复：新增 `scripts/package-electron.mjs` 包装打包流程，打包完成后自动 `npm rebuild better-sqlite3 node-pty @homebridge/node-pty-prebuilt-multiarch`，把根目录恢复为本地 Node ABI。
- 同时把 `package.json` 的 `package`、`dist`、`dist:all`、`dist:publish` 切到该包装脚本。
- 涉及文件：`scripts/package-electron.mjs`、`package.json`

10. live preflight 不该写预算/AgentRun

- 问题：集群 live ping 本应只是启动前轻量探活，但之前会进入预算/AgentRun 生命周期，间接触发 SQLite 原生模块，增加失败面。
- 修复：live ping 调用 adapter 时设置 `skipBudget: true`、`agentRunLifecycle: false`，只测试模型是否能回复；正式任务仍保留预算与审计。
- 涉及文件：`src/server/routes/rooms.js`、`tests/unit/routes/rooms-list-summary.test.js`

## 已完成验证

以下验证在本轮真实执行通过：

1. `npm run lint`

- 通过。

2. `npm test`

- 通过：`104 files / 983 tests`。

3. `npm run test:e2e`

- 通过：`149/149 passed`。

4. `npm run package`

- 通过，输出 `out/mac-arm64`。
- 注意：仍有非阻断 warning：`asar disabled`、未签名、重复依赖提示。

5. 打包后再次 `npm test`

- 通过：`104 files / 983 tests`。
- 证明 Electron 打包不再污染本地 Node 运行时。

6. `npm run restart:panel`

- 通过。
- 当前监听进程为 `/opt/homebrew/bin/node server.js`，端口 `51835`。

7. `npm run check:panel`

- 通过。
- health/readiness/runtime recovery/concurrency/config 均 passed。
- 仍可能出现历史趋势类 warning，但不阻断启动。

8. packaged Electron 实机烟测

- 可执行文件：`out/mac-arm64/Noe.app/Contents/MacOS/Noe`
- 结果：`ok: true`
- 标题：`Noe`
- URL：`http://127.0.0.1:51835/?electron=1`
- `/api/rooms`：HTTP 200
- 无启动失败页面。

9. 真实三模型 live preflight

目标房间：`文字传奇 · 集群协同`  
房间 ID：`58995ce1-4821-4eb0-a9e4-79886b651924`

结果：

- HTTP：`200`
- `preflightStatus: passed`
- `liveCheckStatus: passed`
- `passedCount: 3`
- `warningCount: 0`
- `blockedCount: 0`
- Claude：passed，约 8.6s
- Codex/GPT：passed，约 13.8s
- Gemini CLI：passed，约 17.5s

10. 真实网页操作烟测

- 当前面板可打开。
- 能识别「文字传奇 · 集群协同」房间。
- owner token 正常，没有缺 token banner。
- 图片附件上传成功。
- 上传返回：`storageScope: room_project_attachments`，`mime: image/png`。
- 浏览器 console 无 error。

## 当前状态判断

当前状态：可以开始真实使用「集群协同」模式做小型项目试跑。  
建议先跑一个小型游戏项目，不要一上来跑超大项目。目标是验证从需求输入、分工、执行、续跑、附件理解、交付报告是否能完整闭环。

## 仍需后续完成的事项

1. 正式 Electron App 化

- 开启/调整 `asar`，并处理需要外部访问的文件。
- macOS 签名、公证、DMG 安装包。
- 固定启动方式，减少用户对浏览器地址、owner token、端口的认知成本。

2. 长任务真实压测

- 用真实游戏项目跑 1 小时、3 小时、隔夜。
- 重点验证：模型掉线、额度耗尽、自动接手、续跑、最终交付。

3. 自愈能力继续增强

- 面板启动时自动检测 Claude/Codex/Gemini。
- 探测失败给出修复按钮。
- 运行中模型掉线自动降级，不让整个房间卡死。

4. 附件理解完善

- 当前图片上传链路已通。
- 后续要做：视频抽帧、附件预览、附件绑定任务上下文、模型读取附件证据链。

5. 项目交付闭环

- 每个房间独立项目目录。
- 自动保存需求、任务拆分、代码、日志、交付包。
- 生成最终项目交付报告和可继续开发 handoff。

6. 调度器长期稳定性

- 已有 dispatcher 离线/模拟 drill 通过。
- 仍建议在真实长任务下继续观察罕见竞态。

## 注意事项

- 本轮没有执行 git commit / push。
- 不要假设当前改动已提交。
- 如果下一窗口要提交，先检查 git diff，再分组提交。
- 不要使用 `git reset --hard` 或覆盖用户改动。
- `worker/wrangler.toml` 早前是非本轮改动，之前一直排除在 commit 外，下一窗口要继续尊重边界。

## 下一窗口建议执行顺序

1. 进入仓库：

```bash
cd /Users/hxx/Desktop/00_项目/05_Claude可视化面板
```

2. 只读确认当前健康：

```bash
npm run check:panel
```

3. 如果用户要继续做稳定性，优先做：

```bash
npm run test:e2e
```

4. 如果用户要开始真实项目，先打开：

```text
http://127.0.0.1:51835
```

如提示需要 owner token，使用：

```bash
cat ~/.noe-panel/owner-token.txt
```

或使用启动/重启命令输出的带 `?t=...` 链接。

## 下一窗口复制提示

把下面整段复制给下个 Codex 窗口：

```text
你接手的是 Noe / Claude 可视化面板项目。

真实仓库路径：/Users/hxx/Desktop/00_项目/05_Claude可视化面板
当前面板地址：http://127.0.0.1:51835
交接文档：HANDOFF_2026-06-01_集群协同_Electron稳定化.md

请先阅读交接文档，不要重新猜测项目状态。当前目标是继续把「集群协同」模式做成真正可长期用于项目开发的 Electron App。

当前已验证通过：
- npm run lint
- npm test：104 files / 983 tests
- npm run test:e2e：149/149
- npm run package
- package 后再次 npm test 通过
- npm run restart:panel
- npm run check:panel
- packaged Electron smoke 通过
- 真实三模型 live preflight 通过：Claude / Codex(GPT) / Gemini CLI 全 passed
- 真实网页烟测通过：面板能打开、集群协同房间可识别、图片附件上传成功、无浏览器错误

本轮关键修复包括：owner token 裸开保护、E2E 访客态、项目目录误报、multipart 附件上传、资源守卫误阻断、ops guard 历史 warning、restart timeout、Gemini 3.x 模型映射、Electron 打包污染 Node ABI、live ping 跳过预算/AgentRun。

注意：本轮没有 git commit / push。不要假设改动已提交。不要使用 git reset --hard。worker/wrangler.toml 如仍有非本轮改动，继续排除在外。

下一步如果用户要继续完善，优先级建议：
1. 正式 Electron App 化：asar 策略、签名、公证、DMG。
2. 长任务真实压测：小型游戏项目跑完整闭环。
3. 自愈能力：模型掉线/额度耗尽自动接手。
4. 附件理解：视频抽帧、图片/视频绑定任务上下文。
5. 项目交付闭环：每房间独立项目目录、日志、交付包、最终报告。

如果要开始真实项目，请先 npm run check:panel，确认 passed 后再打开 http://127.0.0.1:51835。
```
