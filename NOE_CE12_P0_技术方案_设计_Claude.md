# CE12 P0 技术方案设计 — Claude 成员独立稿（实测锚定版）

阶段：3. 技术方案设计
工作区：`/Users/hxx/Desktop/Neo 贾维斯`（本稿所有读写仅在此；原项目 `/Users/hxx/Desktop/00_项目/05_Claude可视化面板` 本轮零读写）
上游事实源：`NOE_CE12_P0_REQUIREMENTS_CANONICAL.md`（60/60 PASS）。

> 事实源声明（避免 CE01 竞争稿反模式）：本文件**不是第二份需求 canonical，也不替代 CE03 设计 canonical**。它是 Claude 成员的独立技术方案视角，供落地交叉参考；需求口径仍以 `NOE_CE12_P0_REQUIREMENTS_CANONICAL.md` 为准。

---

## 0. 设计前置实测证据（grounding，避免方案空写）

本稿所有结论都先用只读/轻量命令在 Noe 工作区验证过，杜绝「凭印象设计」：

| 编号 | 命令 | 实测结果 | 影响的设计决策 |
|---|---|---|---|
| G1 | `node -v` / `node -p process.versions.modules` | `v26.0.0` / `147` | 当前交互 shell 非 22；Node22 gate 必须显式处理 |
| G2 | `cat .nvmrc` + `package.json engines` | `.nvmrc=22.22.2`，`engines.node=">=22"` | gate 下限取 `>=22`，与 engines 一致，不回退用户在用的 26 |
| G3 | `ls /Users/hxx/.nvm/versions/node/v22.22.2/bin/node` | 真实存在（112MB） | gate 的 pinned node22 路径可用，可 re-exec |
| G4 | `require('better-sqlite3')` under node26 / node22 | **两者都 LOAD_OK**（147 与 127 ABI 均加载成功） | better-sqlite3@12 走 prebuilt 多 ABI；FR-P0-1 真实风险**不是它崩**，而是 node-pty 系 + 运行时一致性 |
| G5 | `node_modules/playwright` 版本 + chromium 缓存 | `playwright@1.60.0`，`~/Library/Caches/ms-playwright/chromium-1208` 存在 | FR-P0-2 **修复**路径可行（浏览器已就绪），不必只能废弃 |
| G6 | `tests/e2e/noe-brain-ui.e2e.mjs` 头部 | 已用 `playwright` core（非 `@playwright/test`）+ camelCase `#noeBrainArea/#btnNoeBrain`（与 `brain-ui.js` DOM 对齐） | 旧坏因（错依赖+连字符选择器）实际已被修；FR-P0-2 裁定为「受管 server 跑通取证」而非废弃 |
| G7 | `ls node_modules/.bin/electron electron-builder` | 两 bin 均存在；`electron@^37.10.3` `electron-builder@^26.8.1` | FR-P0-5 Electron smoke 可落地 |
| G8 | grep minimax `cli.js` 子命令字面量 | `session` 460、`messages` 17、`diff` 14 次；`session new` 命中 | FR-P0-7 `minimax session new/messages/diff` 有真实 CLI 落点 |
| G9 | `rg noe-brain-ui.e2e` | 活引用仅 `scripts/e2e-with-server.mjs:135`，其余均为文档历史标注 | FR-P0-2 只需治理 1 处活引用 + 文档证据卫生 |
| G10 | 读 `src/approval/ApprovalStore.js:82` `createApproval()` / `listApprovals()` | 已有完整审批表（type/status/payload/dedupeKey/decisionHook） | Act Pipeline 审批闸**复用**既有 store，不新建审批子系统 |
| G11 | 读 `server.js:1629` `new NoeLoop(...)` + `:1644` `registerNoeRoutes` | NoeLoop 已注入 memory/focus/budget/audit/broadcast/clusterBusy；**未传 actHandler** | Act Pipeline 以 `actHandler` 注入即可，零改 NoeLoop 内核 |

---

## 1. 总体架构与模块边界

设计原则：**加法不改内核**。NoeLoop/ApprovalStore/Brain UI 既有结构全部保留，P0 能力以「新增模块 + 注入点 + 新增 DOM/路由」叠加，旧行为零回归。

```
┌─────────────────────────── Noe 后端 (Node ESM, 127.0.0.1:51835) ───────────────────────────┐
│                                                                                            │
│  scripts/ensure-node22.mjs  ← FR-P0-1 运行时闸（被 verify/e2e/package/server 预检引用）      │
│        │ resolveNode22() / assertNode22() / 失败 runbook                                    │
│        ▼                                                                                    │
│  server.js  ──(已存在)──► new NoeLoop({...}) ──注入──► actHandler = ActPipeline.asHandler() │
│        │                         │ tick 节律/超时/budget.preflight/3连错自停（不动）          │
│        │                         ▼                                                          │
│        │                  src/loop/ActPipeline.js  ← FR-P0-4 新增（act 级状态机）            │
│        │                         │ plan→propose→classify→approval→dry_run→evidence→retry    │
│        │                         ├── 复用 src/approval/ApprovalStore.js (G10)                │
│        │                         ├── 复用 src/budget/BudgetPolicyStore.preflight (NFR-P0-3)  │
│        │                         └── appendEvent + broadcast(noe_act_*) (NFR-P0-5)           │
│        │                                                                                    │
│        ├── src/server/routes/noe.js  ← FR-P0-3/4 扩展（+/api/noe/acts, /health 加 acts 段）  │
│        └── src/room/MiniMaxSpawnAdapter.js ← FR-P0-7 新增（patch-only 封装 minimax CLI）     │
│                                                                                            │
└────────────────────────────────────────────────────────────────────────────────────────┘
            │ WS /ws/global: noe_act_* 事件                     │ HTTP /api/noe/*（owner-token）
            ▼                                                   ▼
┌─────────────────────────── Noe 前端 public/ ───────────────────────────┐
│  public/src/web/brain-ui.js  ← FR-P0-3 扩展（act queue/审批/权限/失败/预算/日志入口渲染）   │
│  public/index.html           ← FR-P0-3 新增稳定 DOM 锚点（#noeAct* / #noeBudget* / #noeLog*）│
└──────────────────────────────────────────────────────────────────────┘

证据/打包侧：
  scripts/electron-smoke.mjs  ← FR-P0-5 新增（electron-builder --dir + 启动/退出/menu/log smoke）
  NOE_CE12_P0_EVIDENCE_INDEX.md ← FR-P0-6 新增（source of truth + 命令 + exit code + 产物路径索引）
```

模块边界（谁能做什么）：

| 模块 | 边界（允许） | 禁止（fail-closed） |
|---|---|---|
| `ensure-node22.mjs` | 探测/选择 node22、re-exec、报 runbook | 不装包、不改全局 PATH/rc |
| `ActPipeline` | plan/propose/classify/dry-run/evidence/retry/cancel | 不做真实 delete/外发/批量移动；危险动作只产 approval 或 blocked_safety |
| `ApprovalStore`（复用） | 危险动作落 pending 审批、记录决议 | — |
| `MiniMaxSpawnAdapter` | `session new/messages/diff`、保存建议文本 | 不执行 shell/write/delete/move/apply_patch；非 `diffs=[]` 即 `blocked_safety` |
| Brain UI | 只读渲染后端真值 + 触发审批/取消 | 不在前端绕过审批直接执行危险动作 |

---

## 2. 数据流（act 一次生命周期）

```
focus/memory 真值
   │ NoeLoop.tick()  (actMode=true 且 !clusterBusy)
   ▼
budget.preflight(estimate)  ──BUDGET_LIMIT_EXCEEDED──► loop.pause('budget')  (已存在，不动)
   │ ok
   ▼
ActPipeline.runOnce({focusItems, memoryStats, signal})
   │ 1) plan      → 从 focus 顶项/记忆生成候选 act（仅意图，无副作用）
   │ 2) propose   → 绑定具体 operation + 参数
   │ 3) classify  → riskLevel ∈ {safe, sensitive, dangerous}
   ├─ safe       → 4a) dry_run（模拟）→ evidence → done
   ├─ sensitive  → 4b) approvalStore.createApproval(pending) → 等决议
   │                   approved → dry_run（P0 仍只 dry_run，不真执行外发/删除）→ evidence
   │                   rejected → cancelled
   └─ dangerous  → 4c) blocked_safety（外发/删除/批量移动/高危 shell 一律拒，留建议文本）
   ▼
appendEvent({kind:'noe_act_*'})  +  broadcast({type:'noe_act_*', act})  +  activityLog.recordSafe
   ▼
WS /ws/global ──► brain-ui.js addAct()/renderActs() ──► #noeActQueue / #noeActCurrent / ...
```

关键不变量：**任何 act 在 P0 阶段都不产生真实破坏性副作用**。`executed` 状态在 P0 只对「纯本地、可逆、非外发」的安全只读型 op 开放（如生成草稿/写 memory），破坏性 op 的终态只能是 `dry_run`/`awaiting_approval`/`blocked_safety`/`cancelled`。

---

## 3. 七个 P0 的落地方案（模块 / 状态机 / 接口 / 命令 / 测试 / 回滚）

### FR-P0-1 Node22 fail-fast 与启动/依赖兼容
- **模块**：新增 `scripts/ensure-node22.mjs`，导出 `resolveNode22()`（抽自 `scripts/e2e-with-server.mjs:27` 现成逻辑，DRY）与 `assertNode22({mode})`。
- **设计决策（基于 G1/G2/G4）**：
  - 下限语义 = `>=22`，与 `engines` 一致；**低于 22 → 硬 fail-fast(exit 1)**。
  - better-sqlite3@12 在 26/22 均可加载（G4），故对 `npm start`（用户在用 Node 26）**不硬杀**，仅 `warn`（CLAUDE.md：本机 Node 26 已验证）；但 node-pty 系声明 `<25`，高于 24 时追加显式 warn + runbook。
  - ABI 关键入口（verify/e2e/package）**re-exec / spawn 到 pinned node22**（`/Users/hxx/.nvm/versions/node/v22.22.2/bin/node`，G3），与 CI 22.x 对齐。
- **接口**：`assertNode22({ mode: 'hard'|'warn', for: 'server'|'verify'|'e2e'|'package' }) → { ok, node, reexec? }`。
- **命令/证据**：`node -v`、`node -p process.versions.modules`、`node scripts/ensure-node22.mjs --check`（exit code）。
- **单测**（CE06）：mock `process.versions` 注入 18/22/26，断言 18→exit1、22→ok、26→warn 且不退出。
- **回滚**：删 `ensure-node22.mjs` 引用即恢复旧行为；e2e 内联 resolveNode22 保留为兜底，不产生硬依赖。

### FR-P0-2 旧 e2e 处理（裁定：修复取证，非废弃）
- **裁定依据**：G5（chromium 已装）+ G6（脚本已改 core 依赖 + 正确 camelCase 选择器）+ G9（活引用仅 1 处）。坏因已消除，应**跑通取真证据**而不是丢弃可用资产。
- **方案**：
  1. 经 `scripts/e2e-with-server.mjs`（受管 server，隔离 HOME + owner-token + 端口清理）跑 `npm run test:e2e`，产出 `output/playwright/noe-brain-ui-e2e-*.png` 作为 UI 硬证据。
  2. e2e 断言扩展到 FR-P0-3 的新 DOM 锚点（act queue/审批/预算/日志入口），让它同时成为 FR-P0-3 的验收脚本。
  3. **证据卫生（NFR-P0-4）**：CE10/CE11 文档里把旧脚本当 `known_bad` 的句子保留为历史标注；交付文档只引用本轮**新跑出的**截图+exit0，绝不复用旧坏证据。
- **命令/证据**：`rg "noe-brain-ui.e2e"`、`npm run test:e2e`（exit code + 截图路径）。
- **回滚**：若 CE05 实跑发现仍有不可修选择器漂移 → 降级为 `tests/e2e/noe-brain-ui.e2e.DEPRECATED.mjs` stub（打印 deprecated + exit 0 不阻断），并从 `e2e-with-server.mjs:135` 摘掉活引用，改指向 `panel-ui-walkthrough.mjs`。二选一在 CE05 用实跑结果裁定。

### FR-P0-3 Brain UI 执行可视化增强
- **模块**：扩展 `public/src/web/brain-ui.js` + `public/index.html`（在 `#noeBrainArea` 内新增分区）。
- **稳定 DOM 锚点（契约，e2e/DOM 断言依赖，命名沿用现有 camelCase）**：

| DOM id | 含义 | 数据源 |
|---|---|---|
| `#noeActQueue` | act 队列列表 | `GET /api/noe/acts` |
| `#noeActCurrent` | 当前 act + 其 state | acts[].state==running/dry_run |
| `#noeActApprovalState` | 审批状态徽标 | `/api/noe/approvals` + act.approvalId |
| `#noeToolPermissionState` | 工具权限/risk 状态 | `/api/noe/tools` riskLevel/enabled |
| `#noeActFailureReason` | 失败原因 | acts[].error / blocked_safety reason |
| `#noeBudgetState` | 成本/预算 | `/api/noe/health` budget 段 |
| `#noeLogLink` | 可复现日志入口 | act.eventId → 事件/audit 链接 |
- **数据流**：复用既有 `refreshBrain()` 10s 轮询 + `/ws/global` 推送；新增 `refreshActs()` 与 `addAct()`（仿现有 `refreshApprovals()`/`addThought()`）。
- **证据**：Playwright 截图 + `page.textContent('#noeActQueue'...)` DOM 断言输出。
- **回滚**：新分区独立 DOM 容器，删除 `#noeActExecArea` 容器即回旧视图，旧 `#noeThoughtStream` 等不受影响。

### FR-P0-4 NoeLoop → 最小 Act Pipeline
- **模块**：新增 `src/loop/ActPipeline.js`；通过 `actHandler` 注入 `new NoeLoop({...})`（server.js:1629，G11），**NoeLoop 内核零改**。
- **状态机**（act 级，见 §4 详表）：`planned→proposed→awaiting_approval→approved|rejected→dry_run→executed|blocked_safety|failed→(retrying)→cancelled`。
- **安全默认（NFR-P0-2/3）**：默认 `dry_run`，不调真实 LLM/外发；危险 op 默认 `awaiting_approval` 或 `blocked_safety`；retry 有界（默认 2 次）；cancel 走 AbortController（复用 tick 的 signal）。
- **接口**：`ActPipeline.asHandler()`（给 NoeLoop）、`runOnce()`、`list()`、`get(id)`、`cancel(id)`、`retry(id)`、`snapshot()`。
- **单测**（CE06）：危险 op 无审批→断言不执行且返回 `blocked_safety`/`awaiting_approval`；dry_run 默认不触发真实副作用（spy 断言）；retry 上限；cancel 中止。
- **回滚**：`new NoeLoop()` 不传 `actHandler` → 完全回退到现有 Lite tick（actHandler 为 null 时 tick 行为与今日一致，见 `NoeLoop.js:210`）。

### FR-P0-5 Electron smoke
- **模块**：新增 `scripts/electron-smoke.mjs`，复用 `scripts/package-electron.mjs`（G7）。
- **方案**：
  1. `node scripts/package-electron.mjs --mac --dir` → 产物落 `out-noe/`（package.json build.directories.output），**不签名/不公证**（mac.identity=null, gatekeeperAssess=false 已配）。
  2. 启动 smoke：spawn 打包产物或 `electron electron-main.js`，经 `electron-main.js` 的 `panelRequest()` 探活，校验 server 起在 51835、主窗口创建、Menu 存在、日志写入；随后优雅退出（`app.quit`/SIGTERM）。
  3. 证据：exit code + `out-noe/` 目录 `ls` + 启动/退出日志路径。
- **回滚**：smoke 是独立脚本，失败不影响 `npm run package`/`dist`；不改 electron-main 内核。

### FR-P0-6 交付状态闭环
- **模块**：新增 `NOE_CE12_P0_EVIDENCE_INDEX.md`（证据索引，单一 source of truth）。
- **内容**：每个 P0 → {source of truth 文件、运行命令、exit code、日志/截图/产物路径、状态}。状态分级严格区分「阶段完成 stage_done」与「产品完成 product_done」；本轮只允许写 `产品化基础可继续验收`，禁止「完整 Jarvis 已交付」（VERIFY.mjs:99 已对此设硬检）。
- **回滚**：纯文档，无运行时风险。

### FR-P0-7 MiniMaxSpawnAdapter patch-only 原型
- **模块**：新增 `src/room/MiniMaxSpawnAdapter.js`，继承 `RoomAdapter`，仿 `CodexSpawnAdapter` spawn 范式（G8 确认 CLI 子命令存在）。
- **patch-only 状态机**：`session_new → read_messages → read_diff → verify(diffs==[]) → save_suggestion(text only)`；任一环节要求 shell/write/delete/move/apply_patch、或 `diff` 非空/不可解析 → **`blocked_safety`**（fail-closed，G4 同理：不确定即拒）。
- **安全默认（NFR-P0-6）**：adapter 自身强制 patch-only，**不依赖 Mavis permission**；即使外部 permissionMode 异常也不放行执行。
- **接口**：`async patchPlan({sessionPrompt}) → { sessionId, messages, diffs, status: 'ok'|'blocked_safety', suggestion }`。
- **单测/集成**（CE06/CE07）：mock CLI 返回非空 diff → 断言 `blocked_safety`；返回 `diffs=[]` → 断言 status ok 且只保存文本、无任何 fs/exec 调用（spy 断言）。
- **回滚**：adapter 不在默认 dispatcher 注册即完全 inert；M3 仍可走既有 `MiniMaxChatAdapter`（chat-only 审计）。

---

## 4. Act Pipeline 状态机（详表）

| from | event | to | 副作用 | 失败处理 |
|---|---|---|---|---|
| `planned` | propose() | `proposed` | 绑定 operation | 无 operation → `cancelled` |
| `proposed` | classify=safe | `dry_run` | — | — |
| `proposed` | classify=sensitive | `awaiting_approval` | createApproval(pending) | createApproval 抛错 → `failed` |
| `proposed` | classify=dangerous | `blocked_safety` | 仅存建议文本 | 终态 |
| `awaiting_approval` | approve | `approved` | decisionHook 触发 | 过期 → `cancelled` |
| `awaiting_approval` | reject | `rejected`→`cancelled` | — | — |
| `approved` | run | `dry_run` | 模拟执行+证据 | P0 不进 `executed`（破坏性） |
| `dry_run` | ok | `executed`(仅安全只读) / `done` | appendEvent+broadcast | — |
| `dry_run`/`approved` | error | `failed` | 记 error+eventId | errorCount<2 → `retrying` |
| `retrying` | run | `dry_run` | 退避重试 | 超上限 → `failed`(终态) |
| any(非终态) | cancel() | `cancelled` | abortController.abort | — |

终态：`executed(安全) / blocked_safety / failed / cancelled / done`。NoeLoop 既有状态（`stopped/idle/ticking/paused/paused_budget`）**保持不变**，act 状态是**正交的新维度**，经新字段暴露，不污染 `loop.status()`（守住 Q-P0-3 兼容边界）。

---

## 5. 接口契约汇总

**HTTP（均 `requireOwnerToken`，仿 noe.js 既有风格 try/catch + `{ok,error}`）**
| 方法 | 路径 | 说明 | 兼容性 |
|---|---|---|---|
| GET | `/api/noe/acts?status=&limit=` | act 队列 + 状态 | 新增 |
| POST | `/api/noe/acts/:id/cancel` | 取消 act | 新增 |
| POST | `/api/noe/acts/:id/retry` | 重试 failed act | 新增 |
| GET | `/api/noe/health` | **扩展** `acts:{queued,running,awaitingApproval,blocked,failed}` + `budget:{...}` | 加字段，旧字段不删 |

**WS `/ws/global`**：新增 `noe_act_planned|proposed|awaiting_approval|dry_run|blocked_safety|failed|done`，沿用 `data.type.startsWith('noe_')` 既有前端分流（brain-ui.js:123），旧 `noe_loop_*` 不变。

**DOM**：见 FR-P0-3 锚点表（契约锁定，e2e 依赖）。

---

## 6. 失败处理策略（统一）

| 失败面 | 策略 | 已存在/新增 |
|---|---|---|
| tick 异常 | 累计 errorCount，≥3 自动 `stop(reason=error)` + audit | 已存在（NoeLoop.js:148-172），不动 |
| 预算超限 | `pause('budget')`，UI 显示 paused_budget | 已存在（:204）+ UI 新增 `#noeBudgetState` |
| 危险 op 无审批 | `awaiting_approval`（敏感）/ `blocked_safety`（破坏性），绝不执行 | 新增（ActPipeline） |
| act 执行错误 | `failed` + eventId + 有界 retry | 新增 |
| MiniMax 非 `diffs=[]` | `blocked_safety`，只存文本 | 新增（fail-closed） |
| Node 运行时不符 | <22 hard exit1 / 高版本 warn+runbook / ABI 入口 re-exec node22 | 新增（ensure-node22） |
| Electron 起不来 | smoke 超时 → 非零 exit + 日志尾部，不影响 dist | 新增 |
| 协同降级（NFR-P0-7） | M3 掉线只记补审点不阻塞；Claude 掉线 GPT+M3 推进 | 流程约束 |

---

## 7. 兼容性与回滚策略

- **加法架构**：7 个 P0 全部是「新增模块/路由/DOM/脚本」或「向后兼容地扩字段」，无破坏式改写。
- **NoeLoop**：不传 `actHandler` 即 100% 回退 Lite tick（G11 + NoeLoop.js:210 已是可选分支）。
- **路由**：仅新增端点 + `/health` 加字段；前端旧 `refreshBrain()` 读不到新字段时按既有 `|| 0` 兜底，老 UI 不崩。
- **e2e**：修复优先；不可修则降级 deprecated stub（FR-P0-2 回滚分支）。
- **运行时**：ensure-node22 对 `npm start` 仅 warn，不夺走用户在用的 Node 26；ABI 入口才 re-exec。
- **逐项回滚开关**：每个新模块都能通过「移除注入点/删脚本/删 DOM 容器」单独回退，互不牵连。

---

## 8. 风险收敛矩阵（主要风险如何收敛）

| 风险 | 收敛手段 | 验证证据（CE05+） |
|---|---|---|
| Node 运行时漂移致 ABI/原生崩 | ensure-node22 下限 fail-fast + ABI 入口 re-exec node22 | `node scripts/ensure-node22.mjs --check` exit code |
| 复用已知坏 e2e（NFR-P0-4） | 重跑取新证据 + 历史只标 known_bad，禁复用 | `npm run test:e2e` 新截图 + exit0 |
| 危险动作误执行（NG-2/NFR-P0-2） | ActPipeline 默认 dry_run + 破坏性 blocked_safety + 复用 approvalStore | 审批阻断单测 + dry-run evidence 日志 |
| 烧模型额度（NFR-P0-3） | 默认 dry-run 不调真实 LLM；budget.preflight 前置 | mock budget 单测 + 默认不外呼断言 |
| M3 越权执行（NG-5/NFR-P0-6） | adapter 自建 patch-only guard，非 `diffs=[]` 即 blocked_safety，不依赖 Mavis | `diffs=[]` + blocked_safety 集成证据 |
| 原项目污染（NG-3/NFR-P0-1） | 全部路径限定 Noe；脚本校验 `process.cwd()` | 交付报告写入 diff 路径清单 |
| 阶段完成被当产品完成（UR-CE12-1） | 证据索引强制 stage_done≠product_done + VERIFY 硬检 | `NOE_CE12_P0_EVIDENCE_INDEX.md` + verify |

---

## 9. 工程闭环 11 阶段衔接

1. 用户想法 / 2. 需求：已闭环（canonical 60/60），本稿继承不推翻。
3. **技术方案（本阶段）**：输出上述架构/边界/数据流/接口/状态机/失败处理/回滚 → 可直接指导 CE05。
4. 任务排期：建议序 FR-P0-1 → FR-P0-2 →（FR-P0-3‖FR-P0-4）→ FR-P0-5 → FR-P0-6 ⊃ FR-P0-7（贯穿证据闭环）；只排 7 个 P0，Voice/Social/Jarvis 全体验 excluded。
5. 代码：按 §3 模块路径落地。
6. 单测：覆盖每个 P0 的 §3「单测」项。
7. 集成：51835 起停 + 51735 零影响 + owner-token + acts 数据源 + MiniMax `diffs=[]`。
8. 功能验证：Playwright 截图 + §5 DOM 断言。
9. 文档：更新 EVIDENCE_INDEX + 交接。
10. 验收：每 P0 命令+exit code+证据齐；只允许「产品化基础可继续验收」。
11. 复盘：记录运行时/坏证据/UI 证据链/Electron/MiniMax 权限/降级改进项。

---

## 10. CE03 裁定（Claude）

**同意推进到 CE04（任务分配与排期）。**

依据：
1. 7 个 P0 已全部映射到**真实磁盘模块路径 + 状态机 + 接口 + 命令 + 测试 + 回滚**，每条关键断言有 G1–G11 实测证据，无凭印象设计。
2. 主要风险都有明确收敛手段（§8），且与 canonical 的 NG/NFR/证据要求逐条对齐。
3. 架构为「加法不改内核」，兼容性与逐项回滚清晰（§7）。
4. 无 secret 泄露 / 路径权限错误 / 原项目污染 / 数据破坏 / 不可逆操作 / 安全风险 / 事实错误等硬阻断。

后续补审点：
- FR-P0-2 最终「修复 vs 降级 deprecated」由 CE05 实跑 `npm run test:e2e` 结果裁定（本稿已给两分支）。
- FR-P0-1 对 `npm start` 是否需要从 warn 升级为可选 hard 由 node-pty 实测稳定性定（CE05）。
- FR-P0-7 `minimax session diff` 输出格式以 CE05 实跑首个 session 为准，adapter 已 fail-closed 兜底不确定性。
- MiniMax M3 中文侧审计意见待其在线后回补（NFR-P0-7 补审点）。
