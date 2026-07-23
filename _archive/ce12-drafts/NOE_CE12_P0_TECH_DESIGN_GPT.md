# CE12 P0 技术方案设计 - GPT 独立稿

生成时间：2026-06-02  
工作区：`/Users/hxx/Desktop/Neo 贾维斯`  
阶段：3. 技术方案设计  
事实源：本文件只承接 `NOE_CE12_P0_REQUIREMENTS_CANONICAL.md`，不替代它。CE01-CE11 只能表述为 Brain UI Lite 原型和复盘闭环已完成，完整 Jarvis 产品未完成。

## 0. 现场证据

- `pwd` = `/Users/hxx/Desktop/Neo 贾维斯`，本阶段只在 Noe 工作区写入。
- `.nvmrc` = `22.22.2`；当前交互 shell `node -v` = `v26.0.0`，`process.versions.modules` = `147`，所以 Node22 gate 必须先落。
- `node NOE_CE12_P0_REQUIREMENTS_VERIFY.mjs` = `60/60 checks passed`。
- 旧 e2e 入口仍活着：`scripts/e2e-with-server.mjs:135` spawn `tests/e2e/noe-brain-ui.e2e.mjs`。
- Brain UI 当前 DOM 已有 `#noeBrainArea`、`#noeLoopMetrics`、`#noeThoughtStream`、`#noeToolsList`、`#noeApprovalsList`，缺 act queue / 当前 act / 工具权限 / 失败原因 / 成本预算 / 日志入口。
- `src/loop/NoeLoop.js` 现状是 tick + 可选 `actHandler`，无持久 Act Pipeline 状态机。
- `electron-main.js` 与 `scripts/package-electron.mjs` 已存在，Electron smoke 可以基于现有打包链做，不做签名/公证。

## 1. 总体架构

CE12 不硬拼 BaiLongma，不复制整仓。Noe 保持主产品底座，只做 P0 产品化加法：

`Node22 Gate -> NoeLoop -> ActPipeline -> Permission/Budget/Approval -> ToolRegistry(dry-run) -> EvidenceLog -> Brain UI -> CE12 Evidence Index`

模块边界：

- `scripts/ensure-node22.mjs`：统一 Node22 fail-fast / re-exec gate。任何 P0 verify、e2e、package、smoke 先过它。
- `src/loop/ActPipeline.js`：新增最小执行状态机。`NoeLoop` 只负责 tick 调度，ActPipeline 负责 plan/propose/approval/dry-run/evidence/retry/cancel。
- `src/loop/ActStore.js` 或 `SqliteStore` v3 migration：持久 act queue、状态、证据引用、失败原因。优先 SQLite；测试可注入内存 store。
- `src/server/routes/noe.js`：在不破坏现有 API 的前提下扩展 `/api/noe/acts*` 与 `/api/noe/health.act`。
- `public/index.html` + `public/src/web/brain-ui.js`：新增稳定 DOM 锚点，展示执行可视化，不写真实执行逻辑。
- `tests/e2e/noe-brain-ui-p0.e2e.mjs`：新 P0 UI 证据脚本；旧 `tests/e2e/noe-brain-ui.e2e.mjs` 改为 deprecated stub 或只转发到新脚本并输出 replaced 证据，不再作为旧通过证据。
- `scripts/electron-smoke.mjs`：启动/退出/菜单/日志/打包目录 smoke，不签名、不公证。
- `src/room/MiniMaxSpawnAdapter.js`：patch-only adapter，只读 session messages / diff；不执行 shell、write、delete、move、apply_patch。
- `NOE_CE12_P0_EVIDENCE_INDEX.md`：代码阶段开始维护，记录命令、exit code、截图、日志、产物路径。

## 2. 数据模型

新增表或等价 store：

- `noe_acts(id, project_id, source, title, goal, status, risk_level, tool_id, approval_id, budget_estimate, failure_reason, retry_count, max_retries, evidence_ids, log_path, created_at, updated_at, completed_at)`
- `noe_act_events(id, act_id, ts, phase, status, payload)`；也同步追加到既有 `events`，`kind='noe_act_event'`，便于 Activity/日志入口复用。

核心对象：

- `ActPlan`：由 focus、manual tick 或 NoeLoop 生成，字段含 `goal`、`intent`、`proposedTool`、`riskLevel`、`budgetEstimate`。
- `ActDecision`：来自 `PermissionGovernance.evaluatePermission` 和 `BudgetPolicyStore.preflight`，字段含 `decision=allow|ask|deny`、`approvalId`、`blocked`、`reason`。
- `ActEvidence`：字段含 `eventId`、`activityUrl=/api/activity?...`、`logPath`、`screenshotPath`、`artifactPath`。

## 3. 数据流

1. `NoeLoop.tick({ actMode:true })` 获取 focus/memory stats。
2. `ActPipeline.plan()` 生成低成本 plan，不调用真实外部模型；默认 dry-run。
3. `ActPipeline.propose()` 选择候选 tool 或 no-op，总是先写 act queue。
4. `BudgetPolicyStore.preflight()` 检查 calls/tokens/usd，超限进入 `paused_budget`。
5. `PermissionGovernance.evaluatePermission()` 检查 tool/shell/network/file 风险；危险操作进入 `approval_required`，无审批不执行。
6. `ToolRegistry.invoke()` 仅允许 enabled + low-risk + dry-run handler；真实外发、删除、批量移动默认 `blocked_safety`。
7. `ActPipeline.recordEvidence()` 写 `events`、`noe_act_events`、`logPath`。
8. `/api/noe/health` 返回 `act.summary`，Brain UI 渲染 queue、current act、approval、permission、failure、budget、log link。

## 4. 接口设计

- `GET /api/noe/acts?status=&limit=`：返回 act queue。
- `GET /api/noe/acts/:id`：返回 act 详情和事件。
- `POST /api/noe/acts/:id/cancel`：取消 pending/planning/proposed/approval_required act。
- `POST /api/noe/acts/:id/retry`：只允许 failed_retryable，增加 `retry_count`。
- `POST /api/noe/loop/tick`：现有接口保留，响应增加 `act`。
- `GET /api/noe/health`：现有字段保留，新增 `act: { current, queue, lastFailure, budget, logUrl }`。
- MiniMax patch-only：`MiniMaxSpawnAdapter.planPatch(messages, { cwd }) -> { ok, sessionId, messagesSummary, diffs, patchText, status }`；任何执行诉求返回 `status='blocked_safety'`。

## 5. Act 状态机

主路径：

`queued -> planning -> proposed -> budget_checked -> permission_checked -> dry_run_executing -> evidence_recorded -> completed`

审批路径：

`permission_checked -> approval_required -> approved -> dry_run_executing`  
`approval_required -> rejected|cancelled`

失败路径：

- budget hard stop：`budget_checked -> paused_budget`，Loop pause，UI 展示预算原因。
- permission deny：`permission_checked -> blocked_safety`，不创建执行进程。
- timeout/handler error：`dry_run_executing -> failed_retryable`；超过 `max_retries` 后 `failed_final`。
- user cancel：任意非终态 -> `cancelled`，AbortController 中断后只写证据。

终态：`completed`、`cancelled`、`rejected`、`blocked_safety`、`failed_final`。

## 6. 失败处理策略

- Node 非 22：P0 命令先 fail-fast，打印 `.nvmrc`、当前版本、建议 `NOE_NODE_BIN`；不进入 better-sqlite3 import 链。
- 旧 e2e：入口链必须更新；旧坏证据只能写 `known_bad/deprecated/replaced`，不能写 pass。
- 危险操作：delete/move/bulk shell/network upload 默认 ask 或 deny；没有 approvalId 不执行。
- 预算超限：捕获 `BudgetLimitExceededError`，act 写 `paused_budget`，Brain UI 展示 blocked scopes。
- Electron smoke：使用隔离 `HOME`、固定 51835 或临时端口、日志落 `output/electron-smoke/`；finally 杀子进程并检查端口。
- MiniMax M3：只读 session messages/diff；`diffs` 非空、出现 shell/write/delete/move/apply_patch 意图、或路径越界时直接 `blocked_safety`。
- 协同降级：Claude/M3 不可用不阻断代码阶段；证据索引记录 solo takeover 原因和补审点。

## 7. 关键设计决策

- 加法不改存量：保留 `NoeLoop.status()` 现有字段，只新增 `pipeline/act`，避免 CE01-CE11 证据链断裂。
- 先 dry-run 后能力：P0 不接真实外发、删除、批量移动；工具市场思路仅体现在 permission/approval/manifest 边界。
- SQLite 优先：act queue 要可复现，不能只存在前端内存；事件仍复用既有 `events` 与 Activity UI。
- UI 用稳定 DOM ID 验收：新增 `#noeActQueue`、`#noeCurrentAct`、`#noeApprovalStatus`、`#noeToolPermissionStatus`、`#noeFailureReason`、`#noeBudgetStatus`、`#noeEvidenceLogLink`。
- e2e 换证据源：新 P0 e2e 脚本负责截图和 DOM 断言，旧脚本只作为废弃说明或兼容转发，不再承载历史坏证据。
- Electron smoke 不做 release：只验启动/退出/菜单/日志/打包目录，不进入签名、公证、发布。

## 8. 兼容性与回滚

- Node gate 回滚：移除 package scripts 的 wrapper 引用即可；`.nvmrc` 保留不破坏运行。
- ActPipeline 回滚：`NoeLoop` 继续 tick；关闭 `actMode` 或 feature flag `NOE_ACT_PIPELINE=0`，UI 显示 pipeline disabled。
- DB 回滚：新增 v3 表不删除旧表；回滚代码时忽略 `noe_acts/noe_act_events`。
- UI 回滚：保留原 Brain UI 面板，只隐藏新增执行可视化区域。
- e2e 回滚：`scripts/e2e-with-server.mjs` 可切回已修复的新 P0 脚本；不再切回 known_bad 证据。
- Electron smoke 回滚：删除 smoke 脚本不影响 `npm run electron` 与 `npm run package`。
- MiniMax 回滚：不注册 `MiniMaxSpawnAdapter`；保留 `MiniMaxChatAdapter` 现状。

## 9. 验证计划

- FR-P0-1：`NOE_NODE_BIN=/Users/hxx/.nvm/versions/node/v22.22.2/bin/node npm run test -- tests/unit/node22-gate.test.js`；再用当前 Node26 跑 gate，期望非 0。
- FR-P0-2：`rg -n "noe-brain-ui.e2e" scripts tests docs *.md`；`npm run test:e2e` 必须运行新 P0 脚本并产出 `output/playwright/noe-brain-ui-p0-*.png`。
- FR-P0-3：Playwright 断言 7 个 DOM ID 均可见，截图入 `output/playwright/`。
- FR-P0-4：Vitest 覆盖 plan/propose/approval/dry-run/evidence/retry/cancel 和 destructive blocked。
- FR-P0-5：`npm run package -- --mac --dir` + `node scripts/electron-smoke.mjs`，日志入 `output/electron-smoke/`。
- FR-P0-6：`NOE_CE12_P0_EVIDENCE_INDEX.md` 收集 source of truth、命令、exit code、日志、截图、产物。
- FR-P0-7：mock minimax CLI，验证 `diffs=[]` 放行文本建议，危险意图返回 `blocked_safety`。

## 10. 工程闭环 11 阶段落地

1. 用户想法：继承 Noe 主产品、完整 Jarvis 未完成、只做 P0。
2. 需求分析：以 `NOE_CE12_P0_REQUIREMENTS_CANONICAL.md` 为唯一需求事实源。
3. 技术方案：本文件定义架构、边界、数据流、接口、状态机、失败处理和回滚。
4. 排期：按 Node gate -> e2e -> ActPipeline/Brain UI -> Electron smoke -> evidence -> MiniMax patch-only 排。
5. 代码开发：只在 Noe 工作区增量实现上述模块。
6. 单元测试：覆盖 gate、pipeline、permission、budget、MiniMax safety。
7. 集成测试：覆盖 51835 Noe 启停、51735 原项目零影响、owner-token、API 数据面。
8. 功能验证：用 Browser/Playwright 截图和 DOM 断言证明执行可视化。
9. 文档编写：更新 evidence index、交接和运行命令，不写产品完成。
10. 交付验收：逐 P0 提供当前命令、exit code、截图、日志、产物路径。
11. 复盘优化：记录 Node/runtime、坏证据、权限、预算、Electron、M3 降级补审点。

## 11. 推进裁定

CE03 可推进到 CE04。当前没有 secret 泄露、路径/权限错误、原项目污染、数据破坏、不可逆操作、安全硬风险或明确事实错误。真正的代码阶段前置硬门是 FR-P0-1 Node22 gate；旧 e2e 活引用必须在 FR-P0-2 第一批修掉。
