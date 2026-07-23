# Claw Panel Runtime Preflight 融合记录 2026-06-13

## 来源

- 本地 OpenClaw 源码：`/Users/hxx/Documents/Claw系audit_2026-06-09/openclaw`
- 本地 Claw Panel 痕迹：
  - `~/Library/Application Support/clawpanel`
  - `~/.openclaw/clawpanel`
  - `~/.openclaw/logs/stability`
  - 归档说明：`/Users/hxx/iCloud云盘（归档）/Documents/Codex/2026-04-26/claw-panel/claw-panel-optimization.md`
- 直接参考机制：
  - OpenClaw `src/gateway/server-methods/restart.ts`：`gateway.restart.preflight`
  - OpenClaw `src/gateway/server-methods/logs.ts`：bounded control-surface diagnostics

未读取 `~/.openclaw/clawpanel-device-key.json`，未读取或输出 secret。

## Neo 缺口

Neo 原有 `NoeDoctor` 已能用 `lsof` 粗看 `51835/51735` 是否监听，但不能回答 live 操作前最关键的问题：

- 51835 当前 PID 是谁？
- 该进程 cwd 是否就是真实仓库 `/Users/hxx/Desktop/Neo 贾维斯`？
- 启动命令是什么？
- 是否可以把它视为 Noe live panel 并安全重启/接管？
- 51735 是否只被观察、没有成为误操作目标？

这使每次 live 验证或重启都依赖人工口头检查，证据不稳定。

## 本轮落地

新增：

- `src/runtime/NoePanelRuntimePreflight.js`
- `scripts/noe-panel-runtime-preflight.mjs`
- `tests/unit/noe-panel-runtime-preflight.test.js`

修改：

- `src/runtime/NoeDoctor.js`
- `tests/unit/noe-doctor.test.js`
- `package.json`

能力：

- 只读收集 `lsof` / `ps` / process cwd。
- 判断 `51835` listener 是否属于真实 Neo 仓库。
- 输出 `safeToRestart` / `safeToStart` / blockers / warnings。
- 明确 `51735` 为 `observe_only`，不作为 restart target。
- CLI 写入 `output/noe-panel-runtime-preflight/*.json` 作为 live 操作前证据。
- Doctor 增加 `panel.runtime.preflight` finding。

安全边界：

- `secretValuesReturned:false`
- `readsOwnerToken:false`
- `restartsProcess:false`
- `touchesObserveOnlyPort:false`
- `actionsPerformed:false`

## 验证

命令：

```bash
npm run verify:noe:panel-runtime-preflight
```

结果：

- 单测通过：2 files / 7 tests
- CLI report：`output/noe-panel-runtime-preflight/panel-runtime-preflight-1781321572918.json`
- 真实 51835：
  - PID `2667`
  - cwd `/Users/hxx/Desktop/Neo 贾维斯`
  - command `/Users/hxx/.nvm/versions/node/v22.22.2/bin/node server.js`
  - `safeToRestart:true`
- 51735：
  - listenerCount `1`
  - warning `observe_only_port_51735_has_listener`
  - 未触碰

## 收益

以后任何需要 live/P6/Noe panel 验证或重启的任务，都可以先跑：

```bash
npm run verify:noe:panel-runtime-preflight
```

再根据报告决定是否重启 51835。这样把 Claw Panel 的“控制面板先预检再动作”的工程纪律变成 Neo 自己的可验证能力。

## 下一步

1. 将 `noe:panel-log-tail` 接入 Noe Brain 的 owner-token protected 运维区；UI 默认只显示摘要，展开时才显示脱敏尾部。

## 2026-06-13 后续执行记录：restart-panel 接入 preflight

目标：把 Claw Panel / OpenClaw 的“控制面动作前先做 runtime preflight”真正接入 Noe 的重启脚本，避免 `scripts/restart-panel.mjs` 在 51835 被其它 cwd 进程占用时误杀或接管。

已完成：

- `src/runtime/NoePanelRuntimePreflight.js` 新增 `evaluateNoePanelRestartPreflight()`。
- `scripts/restart-panel.mjs` 在实际 restart/start 前收集 `NoePanelRuntimePreflight`，只有 `safeToRestart` 或 `safeToStart` 为真才会进入 launchd/direct restart。
- 如果 preflight 发现 51835 listener cwd 不属于真实 repo、多 listener、cwd unknown 或 listener probe 失败，脚本返回 `restartMethod:"preflight-blocked"`、`noRestartPerformed:true`，不执行 `releasePort()`。
- no listener 与 probe failure 已区分：只有明确的 `lsof` no-match 才允许 start；`lsof` 自身不可用会被 `panel_listener_probe_failed` 阻断。
- owner-token 读取仍只在显式 ack 或 standing autonomy grant 授权下发生；preflight 自身不读取 token，不返回 secret。

验证：

- `node --check scripts/restart-panel.mjs && node --check src/runtime/NoePanelRuntimePreflight.js && node --check src/loop/NoeHeartbeat.js`
- `npm test -- tests/unit/noe-panel-runtime-preflight.test.js tests/unit/noe-heartbeat.test.js tests/unit/noe-active-job-guard.test.js`
- `npm test -- tests/unit/noe-doctor.test.js tests/unit/noe-panel-runtime-preflight.test.js`
- `git diff --check -- ':!games/cartoon-apocalypse/**'`

本次未重启或接管 51835，未触碰 51735，未读取或输出 secret 原值。

## 2026-06-13 后续执行记录：开机自检与 Noe Brain 可视化

目标：把 panel runtime preflight 从单独 CLI 证据推进到 Noe 自己的开机自检和地球运维入口，owner 进入 Noe Brain 时能直接看到 51835 是否属于真实仓库、是否可安全重启，而不是只看到装饰性健康灯。

已完成：

- `src/runtime/NoeBootSelfCheck.js` 新增 `panel_runtime_preflight` 检查。
- `compactBootSelfCheck()` 保留脱敏后的 check detail，包含 `pid`、`cwd`、`command`、`safeToRestart`、`safeToStart`、blockers/warnings、`secretValuesReturned:false`、`actionsPerformed:false`。
- `src/server/routes/noeBootSelfCheck.js` 支持注入 preflight 函数，API 单测不依赖本机 `lsof`。
- `public/mind.js` 的开机自检热点会把 `panel_runtime_preflight` 摘要写进地球侧栏：51835 属于本仓库 / 可安全重启 / 归属阻断。
- 未授权页面仍只显示“授权锁定”，不会把 protected 自检 detail 暴露到公开状态。

验证：

- `node --check src/runtime/NoeBootSelfCheck.js && node --check src/server/routes/noeBootSelfCheck.js && node --check public/mind.js`
- `npm test -- tests/unit/noe-boot-self-check.test.js tests/unit/routes/noe-boot-self-check-routes.test.js tests/unit/noe-panel-runtime-preflight.test.js tests/unit/noe-mind-world-ui.test.js`
- `node scripts/ensure-node22.mjs --require-22 --exec scripts/noe-boot-self-check.mjs --no-network --no-write`：`panel_runtime_preflight.status:"ok"`、PID `24362`、cwd `/Users/hxx/Desktop/Neo 贾维斯`、`safeToRestart:true`、`secretValuesReturned:false`、`actionsPerformed:false`。
- Playwright 截图：`/tmp/noe-boot-preflight-world-20260613.png`。未读取 owner token，因此页面显示授权锁定；布局检查通过，无明显遮挡或错位。

边界：

- 未重启或接管 51835。
- 51735 仅被 preflight observe-only 计数，未触碰。
- 未读取、输出或写入 secret 原值。

## 2026-06-13 后续执行记录：bounded log tail 只读诊断

目标：复刻 OpenClaw `logs.tail` 的控制面诊断思路，但按 Noe 边界收紧：只读、字节/行数双上限、cursor/reset/truncated 元数据、返回前统一脱敏，避免把 secret-like stdout 带进 UI 或报告。

已完成：

- 新增 `src/runtime/NoePanelLogTail.js`。
- 新增 `scripts/noe-panel-log-tail.mjs` 和 npm 脚本 `noe:panel-log-tail`。
- 新增 `verify:noe:panel-log-tail`，运行 `tests/unit/noe-panel-log-tail.test.js`。
- 默认读取 `PANEL_RESTART_LOG` 或 `/tmp/noe-panel-<port>.log`；不存在时返回 `status:"missing"`，不回退扫描其它目录。
- 读取时执行 line limit 与 byte limit；cursor 过旧或大于文件大小时返回 `reset:true`；过长输出返回 `truncated:true`。
- 返回行统一经过 `redactSensitiveText` 与 panel-log 追加规则，覆盖 API key、Authorization/Bearer、owner token、cookie、JWT、长 hex token、URL query token 等形态。
- 报告策略固定包含 `readOnly:true`、`bounded:true`、`redacted:true`、`secretValuesReturned:false`、`actionsPerformed:false`。

验证：

- `node --check src/runtime/NoePanelLogTail.js && node --check scripts/noe-panel-log-tail.mjs`
- `npm run verify:noe:panel-log-tail`
- `npm test -- tests/unit/noe-panel-runtime-preflight.test.js tests/unit/noe-boot-self-check.test.js tests/unit/routes/noe-boot-self-check-routes.test.js`
- `PANEL_RESTART_LOG=/tmp/noe-panel-log-tail-missing-20260613.log node scripts/ensure-node22.mjs --require-22 --exec scripts/noe-panel-log-tail.mjs --limit 5 --max-bytes 1024`：返回 `status:"missing"`、`lineCount:0`、`secretValuesReturned:false`、`actionsPerformed:false`。

边界：

- 本次未读取真实 panel log 内容；只跑了缺失日志 CLI 和 fixture 单测。
- 未重启或接管 51835。
- 未触碰 51735。
- 未读取、输出或写入 secret 原值。

## 2026-06-13 后续执行记录：Noe Brain 运维日志入口

目标：把 OpenClaw / Claw Panel 的 bounded log tail 从 CLI 诊断推进到 Noe Brain 的 owner-token protected 运维区。页面默认只显示摘要，owner 展开“运维日志”后才读取 51835 脱敏尾部，用于定位面板启动、健康检查、路由加载和重启后的运行问题。

已完成：

- 新增 `src/server/routes/noePanelLogTail.js`，注册 `GET /api/noe/panel-log-tail`。
- 路由必须经过 `requireOwnerToken`，不接受任意文件路径，只按 51835 默认日志路径读取。
- 返回内容复用 `collectNoePanelLogTail()` 与 `compactPanelLogTail()`，保留 `status`、`cursor`、`lineCount`、`truncated`、`reset`、limits 和策略标记。
- `src/server/routes/noe.js` 已挂载该路由。
- `public/mind.html` 新增默认折叠的“运维日志”区；折叠时不读取日志，展开或点击“刷新日志”后读取。
- `public/mind.js` 新增 `renderPanelLogTail()` / `loadPanelLogTail()`，所有控件、状态和错误提示为中文；日志行本身按原始技术输出展示，但已经过服务端脱敏。
- `public/mind.css` 新增紧凑日志面板、状态胶囊和长行换行样式。
- `verify:noe:panel-log-tail` 扩展为核心读取器、路由、Noe Brain UI 挂载三类测试。

验证：

- `node --check src/server/routes/noePanelLogTail.js && node --check public/mind.js`
- `npm run verify:noe:panel-log-tail`：3 个测试文件、14 个断言通过。
- `npm run verify:handoff`：83/83 通过。
- `git diff --check -- ':!games/cartoon-apocalypse/**'`
- live 51835 验证：重启前 PID `3654`，cwd `/Users/hxx/Desktop/Neo 贾维斯`，命令 `/Users/hxx/.nvm/versions/node/v22.22.2/bin/node server.js`；只读 preflight 返回 `safeToRestart:true`、`secretValuesReturned:false`、`actionsPerformed:false`。
- 启动方式：未使用读取 owner-token 的 `restart-panel`，而是 `kill -TERM 3654` 后用 Node 22 从真实仓库 direct spawn `server.js`，日志写入 `/tmp/noe-panel-51835.log`。
- 重启后 PID `77199`，cwd `/Users/hxx/Desktop/Neo 贾维斯`，`/health` 返回 `ok:true`，`/api/noe/readiness` 返回 `status:"passed"`，`p6ConfirmedDelivery:1`。
- 未带 owner token 请求 `/api/noe/panel-log-tail` 返回 HTTP `401`，证明路由已挂载且受 owner-token 保护；浏览器页面持有既有授权时展开“运维日志”返回 `正常 · 80 行 · 脱敏只读`。
- 截图证据：`/tmp/noe-mind-ops-log-top-20260613.png`、`/tmp/noe-mind-ops-log-open-20260613.png`、`/tmp/noe-mind-ops-log-lines-20260613.png`、`/tmp/noe-mind-ops-log-mobile-settled-20260613.png`。

边界：

- 51735 仅被 preflight observe-only 计数，未触碰。
- 未读取或输出 owner token、API key、cookie、`.env` 或 room adapter secret。
