# CE12 P0 集成测试 - GPT 独立稿

生成时间：2026-06-02 15:12 CST  
工作区：`/Users/hxx/Desktop/Neo 贾维斯`  
阶段：7. 集成测试  
事实源：承接 `NOE_CE12_P0_REQUIREMENTS_CANONICAL.md` 与 `NOE_CE12_P0_EVIDENCE_INDEX.md`；本文件不替代需求事实源。当前只能表述为「CE12 P0 产品化基础可继续验收」，不是完整 Jarvis 产品完成。

## 1. 本阶段目标

CE07 不再只看单元假设，重点验证模块之间贯通：

- 后端 server 与 owner-token 鉴权。
- HTTP API 与 MemoryCore / FocusStack / ActStore / ApprovalStore / SQLite。
- NoeLoop actMode 与 ActPipeline handler。
- 危险 act 的 blocked_safety、敏感 act 的 approval_required、低风险 act 的 dry-run evidence。
- Brain UI 与后端数据面通过 Playwright e2e 渲染验证。
- Electron 外壳能启动、注册菜单、拉起 server、加载窗口并退出。
- 所有证据落到 `output/`，并由 `npm run verify:p0` 聚合成单一退出码。

Browser 插件路径已尝试，运行时返回：

```text
Browser is not available: iab
```

因此本阶段按 `build-web-apps:frontend-testing-debugging` 规则降级到项目内 Playwright e2e。该降级不影响 CE07 完成门槛，因为 Playwright e2e 已覆盖页面身份、非空 UI、7 个 Brain UI P0 DOM 锚点、memory 写入召回、Act Tick 数据流、截图与 console error 检查。

## 2. 新增/修改的集成测试面

### 2.1 新增脚本

`scripts/ce12-p0-integration.mjs`

职责：

- 强制 Node22：当前运行不是 Node v22 / ABI127 时 fail-fast。
- 启动真实 `server.js`，但使用随机端口、隔离 `HOME`、隔离 `PANEL_DB_PATH`。
- 等待 owner-token 文件生成。
- 用真实 HTTP 请求覆盖：
  - `/api/noe/health` 无 token 返回 401。
  - `/api/noe/memory` 写入与召回。
  - `/api/noe/focus` push/list。
  - `/api/noe/loop/start` actMode。
  - `/api/noe/loop/tick` 驱动 ActPipeline。
  - `/api/noe/acts` 暴露 completed dry-run act 与 `sqlite:events/*` logRef。
  - `/api/noe/acts/propose` 高风险 act 返回 202 approvalRequired。
  - `/api/noe/approvals` 暴露 pending approval。
  - `/api/noe/acts/:id/cancel` 取消 pending act。
  - `shell.exec` destructive act 返回 403 blocked_safety。
  - `/api/noe/health?project=noe` 聚合 memory/focus/acts。
- 用 readonly `better-sqlite3` 查询隔离 DB，确认 `noe_memory/noe_focus_stack/noe_acts/approvals/events` 均有证据。
- 清理 server 进程、确认端口释放、删除隔离 HOME。
- 写报告：
  - `output/ce12-p0/integration/integration-report-1780384457418.json`
  - `output/ce12-p0/integration/integration-report-latest.json`
  - `output/ce12-p0/integration/integration-server-1780384457418.log`

### 2.2 package 入口

`package.json`

```json
"test:p0:integration": "node scripts/ensure-node22.mjs --require-22 --exec scripts/ce12-p0-integration.mjs"
```

备用入口：

```json
"test:p0:integration:vitest": "node scripts/ensure-node22.mjs --require-22 --exec node_modules/vitest/vitest.mjs run tests/integration/noe-act-http.integration.test.js"
```

该 Vitest wrapper 已补齐为真实文件 `tests/integration/noe-act-http.integration.test.js`，避免 package script 指向不存在测试。

### 2.3 聚合器接入

`scripts/ce12-p0-verify-all.mjs`

- 新增 `--skip-integration` 参数。
- 新增 `p0_integration` 门。
- `npm run verify:p0` 现在跑 7 门：
  1. requirements_verify
  2. node22_gate
  3. p0_unit_tests
  4. act_pipeline_evidence
  5. p0_integration
  6. electron_smoke
  7. brain_ui_e2e

## 3. 实跑命令与结果

### 3.1 单跑 CE07 集成门

```bash
npm run test:p0:integration
```

实测输出摘要：

```text
=== CE12 P0 integration ===
workspace=/Users/hxx/Desktop/Neo 贾维斯
node=v22.22.2; abi=127
[PASS] Node22 runtime selected - {"node":"v22.22.2","abi":"127"}
[PASS] server starts on isolated random port - {"baseUrl":"http://127.0.0.1:50853"}
[PASS] owner token created in isolated HOME
[PASS] Noe API rejects missing owner token - {"status":401}
[PASS] memory write via HTTP persists - {"status":201}
[PASS] memory recall via HTTP reads persisted item - {"status":200,"count":1}
[PASS] focus push via HTTP persists - {"status":201}
[PASS] focus list via HTTP returns pushed item - {"status":200,"count":1}
[PASS] NoeLoop starts in actMode through API - {"status":200,"loopState":"idle","actMode":true}
[PASS] NoeLoop tick drives ActPipeline handler - {"status":200,"acted":true,"eventId":4}
[PASS] ActStore exposes dry-run completed act through API - {"status":200,"logRef":"sqlite:events/2"}
[PASS] sensitive act proposal routes to approval - {"status":202,"approvalId":"approval-1a11f940-2e3"}
[PASS] approval list exposes pending Act approval - {"status":200,"count":1}
[PASS] pending approval act can be cancelled through API - {"status":200,"finalStatus":"cancelled"}
[PASS] destructive act is blocked_safety and never executes - {"status":403,"finalStatus":"blocked_safety"}
[PASS] health endpoint aggregates memory/focus/acts after integration flow - {"status":200,"memoryVisible":1,"focusDepth":1}
[PASS] SQLite storage contains cross-module evidence - {"noe_memory":1,"noe_focus_stack":1,"noe_acts":3,"approvals":1,"dry_run_events":1,"loop_tick_events":1}
[PASS] server port cleaned up - {"port":50853}
Result: 18/18 checks passed
report=/Users/hxx/Desktop/Neo 贾维斯/output/ce12-p0/integration/integration-report-1780384457418.json
```

退出码：`0`

### 3.1.1 备用 Vitest 集成入口

```bash
npm run test:p0:integration:vitest
```

实测输出摘要：

```text
Test Files  1 passed (1)
Tests       1 passed (1)
```

退出码：`0`

### 3.2 全量 P0 聚合门

```bash
npm run verify:p0
```

实测输出摘要：

```text
PASS [FR-P0-1..7] Result: 60/60 checks passed
PASS [FR-P0-1] mode=candidate_exact selected=v22.22.2 ABI127
PASS [FR-P0-1/4/7] 40/40 tests passed
PASS [FR-P0-4] allPass=true noRealExecution=true approvals=1
PASS [FR-P0-2/3/4/6] Result: 18/18 checks passed
PASS [FR-P0-5] electron-smoke PASS
PASS [FR-P0-2/3] Result: 17/17 checks passed
汇总: 7/7 门通过
证据: /Users/hxx/Desktop/Neo 贾维斯/output/ce12-p0/p0-verify-all-1780384455838.json
结果: ALL PASS
```

退出码：`0`

## 4. UI / Electron 证据

Brain UI e2e：

- 命令：`npm run test:e2e:p0`，由 `verify:p0` 间接复跑。
- 结果：`Result: 17/17 checks passed`，无 `[FAIL]`。
- 覆盖：Brain 面板打开、7 个 P0 DOM 锚点可见、memory write/recall、Act Tick 后 act queue 更新、budget/permission/logRef 渲染。
- 截图：`output/playwright/noe-brain-ui-p0-1780384478519.png`。

Electron smoke：

- 命令：`npm run smoke:electron`，由 `verify:p0` 间接复跑。
- 结果：`electron-smoke PASS`。
- 事件：`app_ready, menu_registered, server_node_selected, server_ready, window_loaded, smoke_quit_requested`。
- 产物：`out-noe/mac-arm64/Noe.app`。
- 日志：`output/electron-smoke/electron-smoke-1780384459314.jsonl`、`output/electron-smoke/electron-smoke-1780384459314.log`。

## 5. 失败处理

- Node 不是 v22 / ABI127：`scripts/ce12-p0-integration.mjs` 直接 fail-fast；推荐入口始终用 `npm run test:p0:integration`。
- server 30 秒内未就绪：记录 `[FAIL] server starts...`，写 `integration-server-*.log`，清理进程后 exit=1。
- owner-token 未生成：记录 owner-token 路径，清理后 exit=1。
- API 状态码不符、JSON 不符、SQLite 表计数不足：对应断言 `[FAIL]`，报告写到 `integration-report-*.json`。
- destructive act 如果不是 403 / blocked_safety：视为硬失败，因为这会破坏 CE12 P0 安全边界。
- Electron/e2e 失败：`verify:p0` 汇总门返回非 0；不允许把 fast run 覆盖成全量验收。

## 6. 与工程闭环的衔接

1. 用户想法：继续遵守 Noe 工作区边界，不改原项目目录；完整 Jarvis 未完成。
2. 需求分析与拆解：7 个 P0 仍以 `NOE_CE12_P0_REQUIREMENTS_CANONICAL.md` 为事实源。
3. 技术方案设计：CE07 验证了设计中的 server/API/storage/ActPipeline/Brain UI/Electron 链路。
4. 任务分配与排期：T5/T7 的集成与证据门已补齐，`verify:p0` 从 6 门升级为 7 门。
5. 代码开发：本阶段只补测试脚本与验证入口，不扩大 Voice/Social/Jarvis 全体验。
6. 单元测试：`verify:p0` 继续复跑 P0 单测 40/40，避免集成通过但核心逻辑回归。
7. 集成测试：本文件对应当前阶段，完成 server/API/storage/UI/Electron 端到端证据。
8. 功能验证：下一阶段可直接引用 `npm run verify:p0`、UI 截图和 Electron 日志做用户可见功能验收。
9. 文档编写：CE09 应把本文件和 `NOE_CE12_P0_EVIDENCE_INDEX.md` 作为 source-of-truth 引用。
10. 交付验收：CE10 的最小验收命令应至少包含 `npm run verify:p0`，不得用 `verify:p0:fast` 替代全量。
11. 复盘优化：CE11 继续追踪 Browser iab 不可用、MiniMax M3 只读补审、以及 full/fast 证据文件命名分离。

## 7. 裁定

CE07 集成测试通过。关键链路不是只靠单元假设：真实 server、HTTP API、SQLite 存储、ActPipeline、ApprovalStore、Brain UI Playwright e2e、Electron packaged smoke 均有可复现证据。未发现 secret 泄露、路径污染、原项目污染、数据破坏、不可逆操作或安全硬阻断。
