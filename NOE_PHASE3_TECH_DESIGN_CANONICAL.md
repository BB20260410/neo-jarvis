# Noe / Neo 贾维斯 — 阶段 3「技术方案设计」CANONICAL

生成时间：2026-06-02
工作区：`/Users/hxx/Desktop/Neo 贾维斯`
阶段：3. 技术方案设计
继承：`NOE_PHASE1_目标契约_CANONICAL.md`（目标/边界/红线）、`NOE_PHASE2_REQUIREMENTS_CANONICAL.md`（UR-1..6 / FR-00..11 / NFR / Q-1..Q-7）
结论：本文件给出可落地的架构、模块边界、数据流、接口、状态机、失败处理与回滚策略；关闭全部缺口 Q-1..Q-7；可推进阶段 4「任务分配与排期」。

---

## 0. 设计前一手核验（本轮实测，非文档声明）

| 核验项 | 实测结果 | 证据 |
|---|---|---|
| 端口锚定 | Noe 默认 `51835`，可 `PORT` 覆盖 | `server.js:317,4596,4725` |
| 数据根 | `~/.noe-panel/panel.db`，`PANEL_DB_PATH` 可覆盖 | `src/storage/SqliteStore.js:15-19` |
| 存储驱动 | better-sqlite3 12.10.0 / SQLite 3.53.1，单例 `getDb()` | `SqliteStore.js:8,342-344` |
| 迁移框架 | `SCHEMA_MIGRATIONS` 版本化、事务内执行、升级前自动 `.bak` | `SqliteStore.js:350-411` |
| **FTS5 / trigram** | **可用（Node 22.22.2 实跑 `{fts5:true,trigram:true}`）→ Memory 召回零新增依赖** | 本轮 node 探针 |
| 预算闸门 | `preflight()` 超限抛 `BudgetLimitExceededError` | `src/budget/BudgetPolicyStore.js:381-430` |
| 成本核算 | `CostTracker.record(usd,tokens,model)` | `src/cost/CostTracker.js:53-64` |
| 后台循环范式 | `AutopilotScheduler` `setInterval`+`this.running` 重入锁，默认 `enabled:false` | `src/autopilot/AutopilotScheduler.js:27-41`、`AutopilotStore.js:108` |
| owner-token 守卫 | 全 `/api/`+`/v1/` 强制（4 豁免端点），timing-safe | `src/server/auth/owner-token.js:32-46`、`server.js:360-379` |
| 权限决策 | `evaluatePermission()→allow/ask/deny` | `src/permissions/PermissionGovernance.js` |
| 审批工单 | `ApprovalStore.createApproval/decide` + dedupeKey | `src/approval/ApprovalStore.js` |
| 危险模式 | `DangerousPatternDetector` 22 规则（critical/high/low） | `src/safety/DangerousPatternDetector.js` |
| 审计日志 | `ActivityLog.record/recordSafe`，敏感字段自动 `[REDACTED]` | `src/audit/ActivityLog.js` |
| MCP 校验 | `McpStore` sanitize：禁 shell metachar + 命令黑名单 | `src/mcp/McpStore.js` |
| 隔离验收 | `NOE_M1_ISOLATION_SMOKE.mjs` 真启停证明 51835↔51735 零影响 | 现存脚本 |
| **Node ABI 风险** | **Node 26 下原生模块 ABI 不匹配（127 vs 147）→ 运行版必须锁 22.x** | 本轮 node26 报错 |

设计第一原则：**加法不改存量**。所有新增 = 新表（迁移 v2）+ 新模块 + 新路由 + 新 tab；不改现有 17 张表、不改现有路由、不改现有 UI 主流程；NoeLoop 与工具执行**默认关**，装上代码到显式开启前对现有面板零可观察影响。

---

## 1. 总体架构（分层 + 新增组件落点）

```
┌──────────────────────────────────────────────────────────────────────┐
│  前端 (public/)                                                         │
│   现有面板 SPA  ──新增──▶  Brain UI Lite tab (public/src/web/brain-ui.js)│
│                            5 面板：Loop · Focus · 思考流 · 记忆召回      │
│                                   · 工具审批 · 健康                       │
└───────────────▲──────────────────────────────────────────────────────┘
                │ HTTP(owner-token) / WS 事件
┌───────────────┴──────────────────────────────────────────────────────┐
│  HTTP 层 (src/server/routes/)                                          │
│   现有 40+ 路由  ──新增──▶  noe.js  (/api/noe/loop|memory|focus|        │
│                             tools|approvals|health)  自动套 owner-token │
└───────────────▲──────────────────────────────────────────────────────┘
                │ 内部接口调用
┌───────────────┴──────────────────────────────────────────────────────┐
│  领域服务层 (src/)                                                      │
│  ┌── 新增核心 ──────────────┐   ┌── 复用既有（不改） ───────────────┐  │
│  │ src/loop/NoeLoop.js      │──▶│ budget/BudgetPolicyStore.preflight │  │
│  │   可启停 TICK 状态机      │──▶│ cost/CostTracker.record           │  │
│  │ src/memory/MemoryCore.js │   │ permissions/PermissionGovernance  │  │
│  │   user/project/task/     │──▶│ approval/ApprovalStore            │  │
│  │   focus/evidence 记忆     │   │ safety/DangerousPatternDetector   │  │
│  │ src/memory/FocusStack.js │   │ audit/ActivityLog.record          │  │
│  │ src/capabilities/        │──▶│ mcp/McpStore (sanitize)           │  │
│  │   ToolRegistry.js         │   │ workspace/WorkspaceManager(路径)   │  │
│  └──────────────────────────┘   └───────────────────────────────────┘  │
└───────────────▲──────────────────────────────────────────────────────┘
                │ getDb() 单例
┌───────────────┴──────────────────────────────────────────────────────┐
│  存储层 (src/storage/SqliteStore.js) — ~/.noe-panel/panel.db          │
│   现有 17 表  ──迁移 v2 新增──▶  noe_memory · noe_memory_fts(trigram)  │
│                                   · noe_focus_stack · noe_tools         │
│   复用现有：embeddings(向量预留) · approvals · events(审计/思考流)       │
└──────────────────────────────────────────────────────────────────────┘
```

进程模型：**全部 in-process**，挂在现有 `node server.js` 单进程内（不引入独立 worker，避免跨进程 DB 锁与生命周期复杂度）。后台仅 NoeLoop 一个新 `setInterval`，复用 graceful shutdown。

---

## 2. 模块边界与职责（新增）

| 模块 | 路径 | 职责 | 不做什么（边界） | 关联需求 |
|---|---|---|---|---|
| NoeLoop | `src/loop/NoeLoop.js` | 可启停 TICK 状态机；默认本地状态轮询（focus 刷新/记忆维护/健康），不烧额度 | 不 spawn `claude -p`/`codex -p`；默认不触发 room；不直连付费 API | FR-04、NFR-COST-1、Q-2、Q-7 |
| MemoryCore | `src/memory/MemoryCore.js` | Noe 自有记忆 CRUD + FTS5 trigram 关键词召回 + 项目隔离 + 软删除 | 不直迁 BaiLongma 整库 schema；不默认接 embedding | FR-05、Q-1、Q-3 |
| FocusStack | `src/memory/FocusStack.js` | push/refresh(重复命中计数)/pop(压缩摘要)/沉淀 Memory；重启恢复 | 旧焦点不污染新任务 | FR-06 |
| ToolRegistry | `src/capabilities/ToolRegistry.js` | 工具 manifest 注册(ajv 校验)+风险分级→权限门→审批→审计的执行编排 | 未知工具默认不可执行；无 approval 的高危被阻断 | FR-08、Q-5 |
| noe 路由 | `src/server/routes/noe.js` | 暴露 loop/memory/focus/tools/approvals/health 只读+受控写接口 | 不绕过 owner-token；写接口需权限门 | FR-07、FR-09 |
| Brain UI Lite | `public/src/web/brain-ui.js` + index.html 新 tab | 展示 5 类状态，订阅 WS/轮询 | 不遮挡现有主流程 | FR-07、FR-09、UR-6 |

`MemoryCore`/`FocusStack` 放 `src/memory/`（与现有 `src/knowledge`、`src/context` 同级，语义清晰）；`NoeLoop` 独立 `src/loop/`，**刻意不混进 `src/autopilot/`**——Autopilot 是「事件驱动的房间自动化」，NoeLoop 是「意识 tick」，两者概念正交，但 NoeLoop 复用 Autopilot 的 `start/stop/this.running` 范式。

---

## 3. 数据模型（迁移 v2，加法）

新增迁移追加到 `SqliteStore.js` 的 `SCHEMA_MIGRATIONS`（version: 2），事务内执行，升级前自动 `.bak`（框架已具备）。**不动现有 17 表**。

```sql
-- ① Noe 记忆主表（user/project/task/focus/evidence）
CREATE TABLE IF NOT EXISTS noe_memory (
  id TEXT PRIMARY KEY,                 -- uuid
  scope TEXT NOT NULL,                 -- user|project|task|focus|evidence
  project_id TEXT,                     -- 项目隔离键；NULL=全局/user 级
  kind TEXT NOT NULL,                  -- fact|preference|decision|evidence|summary
  title TEXT,
  body TEXT NOT NULL,
  tags TEXT,                           -- JSON array
  source_type TEXT,                    -- loop|user|room|tool
  source_id TEXT,
  importance INTEGER NOT NULL DEFAULT 0,
  hit_count INTEGER NOT NULL DEFAULT 0,
  embedding_ref TEXT,                  -- 关联 embeddings.ref_id（语义召回延后，Q-3）
  hidden INTEGER NOT NULL DEFAULT 0,   -- 软删除/隐藏（不物理删）
  created_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
  updated_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
);
CREATE INDEX IF NOT EXISTS idx_noe_memory_scope ON noe_memory(scope, project_id, hidden);
CREATE INDEX IF NOT EXISTS idx_noe_memory_updated ON noe_memory(updated_at);

-- ② FTS5 trigram 关键词召回（独立表 + 触发器同步；mem_id UNINDEXED 反查主表）
CREATE VIRTUAL TABLE IF NOT EXISTS noe_memory_fts
  USING fts5(mem_id UNINDEXED, title, body, tags, tokenize='trigram');
-- 触发器：insert/update(非 hidden)/delete 时同步 FTS（建表脚本随迁移落地）

-- ③ Focus Stack（Noe 自有，非直迁 BaiLongma focus_stack）
CREATE TABLE IF NOT EXISTS noe_focus_stack (
  id TEXT PRIMARY KEY,
  project_id TEXT,
  title TEXT NOT NULL,
  detail TEXT,
  status TEXT NOT NULL DEFAULT 'active',   -- active|popped
  depth INTEGER NOT NULL DEFAULT 0,
  hit_count INTEGER NOT NULL DEFAULT 0,     -- refresh 重复命中计数
  compressed_summary TEXT,                  -- pop 时压缩摘要
  absorbed_memory_id TEXT,                  -- 沉淀到 noe_memory 的 id
  created_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
  updated_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
  popped_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_noe_focus_status ON noe_focus_stack(project_id, status, depth);

-- ④ 工具注册表（manifest + 风险等级 + 启用态）
CREATE TABLE IF NOT EXISTS noe_tools (
  id TEXT PRIMARY KEY,                  -- tool id（manifest.id）
  manifest TEXT NOT NULL,              -- JSON（ajv 校验后存）
  risk_level TEXT NOT NULL,            -- low|medium|high|critical
  enabled INTEGER NOT NULL DEFAULT 0,  -- 默认禁用（FR-08 红线）
  installed_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
  updated_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
);
```

**Q-1 裁定**：Memory Core **并入** `~/.noe-panel/panel.db`（单库，复用 `getDb()` 单例 + 迁移框架 + WAL + `.bak`），**不**另起独立 store——避免双库事务/备份/路径治理重复。向量复用既有 `embeddings` 表（`embedding_ref` 外联），不重复造列。
**Q-3 裁定**：**先 FTS5 trigram 关键词召回**（本机已验证可用，零新增依赖）；embedding 语义召回延后到 P1+，opt-in，复用 `embeddings` 表，单独评估本地模型成本与隐私。FTS5 在 init 时做能力探针，不可用则降级 LIKE（防御）。

---

## 4. 接口设计

### 4.1 HTTP（`src/server/routes/noe.js`，全部自动套 owner-token）

```
GET  /api/noe/loop/status        → { state, enabled, tickCount, lastTickAt, nextRunAt, lastError }
POST /api/noe/loop/start|stop|pause|resume
GET  /api/noe/memory?q=&scope=&project=&limit=   → { items:[{id,scope,title,body,score,hit_count}] }
POST /api/noe/memory             → 写记忆（body 走 body-length cap；source_type 标注）
DELETE /api/noe/memory/:id       → 软删除（hidden=1，不物理删）
GET  /api/noe/focus?project=     → 当前焦点栈
POST /api/noe/focus              → push / refresh
POST /api/noe/focus/:id/pop      → pop（触发压缩摘要 + 沉淀）
GET  /api/noe/tools              → 工具清单 + 风险等级 + enabled
POST /api/noe/tools/:id/invoke   → 经权限门执行（默认禁用→403；ask→建审批→202）
GET  /api/noe/approvals?status=pending  → 复用 ApprovalStore.list
GET  /api/noe/health             → Brain UI 聚合：loop+memory计数+focus深+pending审批+健康
```

写接口统一：try/catch 包体、错误返 `{ok:false,error}`+HTTP code、`JSON.stringify(body).length>N` cap、路径入 `safeResolveFsPath`——**沿用现有后端硬规则**（CLAUDE.md）。

### 4.2 内部接口（函数签名）

```js
// src/loop/NoeLoop.js
class NoeLoop {
  constructor({ db, budgetStore, costTracker, memory, focus, audit, logger, clusterBusy, llmAdapter })
  start()            // 幂等：已运行直接返回；置 enabled，挂 setInterval(tick, tickMs)
  stop()             // clearInterval + abort 在途 tick；置 stopped
  pause(reason)      // budget/手动暂停；保留 enabled 但不 act
  resume()
  status()           // { state, enabled, tickCount, lastTickAt, nextRunAt, lastError }
  async tick()       // 一轮；this.running 重入锁；默认仅本地轮询
}

// src/memory/MemoryCore.js
write({ scope, projectId, kind, title, body, tags, sourceType, sourceId, importance }) → id
recall({ q, scope, projectId, limit }) → [{ id, score, ...row }]   // FTS5 MATCH→rank；降级 LIKE
get(id) / hide(id) / bumpHit(id)
ftsAvailable() → boolean

// src/memory/FocusStack.js
push({ projectId, title, detail }) → id        // 命中已存在→hit_count++（refresh）
peek(projectId) / list(projectId)
pop(id) → { compressedSummary, absorbedMemoryId }   // 压缩→沉淀 noe_memory
restore()                                       // 重启时从表恢复 active 栈

// src/capabilities/ToolRegistry.js
register(manifest) → { ok, toolId }            // ajv 校验；risk_level；enabled=0
async invoke(toolId, args, ctx) → { ok, result|blocked|approvalId }
  // 1) enabled? 否→{blocked:'disabled'}
  // 2) permissionGovernance.evaluatePermission({action,target,risk,...})
  // 3) deny→audit+block；ask→ApprovalStore.createApproval+202；allow→执行白名单动作
  // 4) shell 类动作过 DangerousPatternDetector；全程 ActivityLog.record
```

---

## 5. 状态机

### 5.1 NoeLoop 生命周期状态机

```
                 start()              tick()  本地轮询
   ┌─────────┐ ─────────▶ ┌──────┐ ─────────────▶ ┌─────────┐
   │ stopped │            │ idle │                 │ ticking │
   └─────────┘ ◀───────── └──────┘ ◀───────────── └────┬────┘
        ▲       stop()        ▲   tick 完成              │ act 条件满足
        │                     │                          ▼
        │   N 次连续错误       │  resume()           ┌─────────┐
        │   自动 stop+audit    ├──────────────────── │ acting  │ (经 budget.preflight)
        │                     │                      └────┬────┘
   ┌────┴────┐          ┌─────┴──────────┐                │ BudgetLimitExceeded
   │  error  │ ◀─────── │ paused_budget  │ ◀──────────────┘
   └─────────┘  N 错误   └────────────────┘
```

- **act 条件（全满足才烧额度）**：`enabled && config.actMode===true && !clusterBusy() && budget.preflight() 通过`。默认 `config.actMode=false` → 永远停在本地轮询，零付费调用（**NFR-COST-1**）。
- **重入锁**：`this.running` 布尔（仿 `AutopilotScheduler.js:40-41`），tick 未完不并发。
- **watchdog**：`AbortController` + 单 tick 超时（默认 30s），超时 abort 并记 `lastError`，不卡死。
- **错误熔断**：连续 N（默认 3）次 tick 抛错 → 自动 `stop()` + `ActivityLog.record({action:'noe.loop.autostop'})`，不让坏循环常驻。

### 5.2 工具执行审批状态机（复用 ApprovalStore）

```
invoke ─▶ enabled? ──no──▶ blocked(disabled, 403, audit)
            │yes
            ▼
   evaluatePermission
     ├─ allow ─▶ 执行白名单动作 ─▶ ActivityLog(success)
     ├─ ask   ─▶ createApproval(pending) ─▶ 202 ─▶ [人工 decide]
     │              approved ─▶ 执行 ─▶ audit ; rejected/expired ─▶ blocked+audit
     └─ deny  ─▶ blocked(denied, audit)   // 高危无 approval 必拦
```

---

## 6. 数据流（关键链路）

**A. NoeLoop 默认 tick（本地，零额度）**
`setInterval → tick() → [FocusStack.list 刷新 / MemoryCore 维护(过期/去重) / 健康采样] → events 表写 kind='noe_loop_tick'（思考流源）→ WS 广播 → Brain UI 思考流面板`

**B. NoeLoop act（仅显式开启）**
`tick → act 条件检查 → budget.preflight(scope=noe-loop) → 通过则 llmAdapter 调用 → cost.record → MemoryCore.write(evidence) ; preflight 抛 BudgetLimitExceeded → pause('budget') → 审批/治理告警`

**C. 工具执行**
`POST /api/noe/tools/:id/invoke → ToolRegistry.invoke → evaluatePermission → (ask→ApprovalStore→Brain UI 审批面板→人工 decide) → 执行 → ActivityLog → events → Brain UI`

**D. Memory 召回**
`GET /api/noe/memory?q= → MemoryCore.recall → noe_memory_fts MATCH(trigram) ORDER BY rank → join noe_memory(hidden=0,项目隔离) → bumpHit → 返回`

---

## 7. 缺口闭环（Q-1..Q-7 裁定）

| Q | 裁定 |
|---|---|
| Q-1 | 并入 `panel.db`（迁移 v2 新表 `noe_memory/_fts/noe_focus_stack`），复用 `getDb()`+迁移框架+`.bak`，**不**另起独立库；向量复用 `embeddings` 表。 |
| Q-2 | **server 内嵌单进程模块** `src/loop/NoeLoop.js`，仿 AutopilotScheduler 范式；状态机见 §5.1；预算接入点 = act 前 `budget.preflight(scope=noe-loop)`；停止 = `stop()`+graceful shutdown 挂钩。 |
| Q-3 | **先 FTS5 trigram**（已验证可用，零依赖）；embedding 延后 P1+ opt-in，复用 `embeddings` 表，单列成本/隐私评审。 |
| Q-4 | **新 tab + 新只读路由组** `/api/noe/*`（自动套 owner-token），前端 `public/src/web/brain-ui.js`；状态源见 §4.1；验收用 Playwright/截图证明 5 面板可见且不遮挡主流程。 |
| Q-5 | manifest（ajv 校验）→ `risk_level` 映射 `PermissionGovernance` 风险；执行经 `evaluatePermission→ApprovalStore→ActivityLog`；默认 `enabled=0`，未知工具不可执行；shell 类过 `DangerousPatternDetector`。 |
| Q-6 | **Voice（FR-10）/ Social（FR-11）P2 延后**：connector 默认 disabled；secret 从 `~/.noe-panel/secrets/<name>.json`(0600) 装载，**不进 git/文档**；对外写需 owner-token+权限+审计；回滚 = 置 disabled + 删 secret 文件。本阶段只定契约不写代码，核心闭环（FR-04..09）未过不抢跑。 |
| Q-7 | NoeLoop 独立预算 scope（`scope_id='noe-loop'`）与房间 session 分离；act 前查 `clusterBusy()`（读 `room_summary.status='running'`）为真则**让路**（停本地轮询）；**项目级单预算门**封顶 loop+room 总额；NoeLoop **绝不** spawn 子 LLM 或自动触发房间（红线）。 |

---

## 8. 失败处理策略

| 子系统 | 失败态 | 处理 |
|---|---|---|
| NoeLoop | tick 抛错 | catch+log+errorCount++，留 idle 不崩；连续 3 次→自动 stop+audit |
| NoeLoop | tick 超时 | AbortController 30s 中止，记 lastError，下轮继续 |
| NoeLoop | 预算超限 | `BudgetLimitExceeded`→`pause('budget')`+治理告警，不静默继续烧 |
| NoeLoop | 集群忙 | `clusterBusy()` 真→让路，本轮不 act |
| Memory | FTS5 不可用 | init 探针置 `ftsAvailable=false`→召回降级 LIKE，不阻断 |
| Memory | 迁移失败 | 迁移在事务内回滚 + 升级前已 `.bak`；失败不阻断启动（沿用框架语义） |
| Memory | 写失败 | `ActivityLog.recordSafe` 吞错不阻断业务 |
| Tool | 权限 deny | 阻断 + 审计；高危无 approval 必拦 |
| Tool | 审批超时 | `expires_at` 过期→blocked+审计 |
| Tool | 执行异常 | 捕获→审计→返回 `{ok:false}`，不崩进程 |
| 集群 | loop×room 抢预算 | 项目级 `preflight` 封顶，超限 defer（沿用 delegation 现有语义） |
| 进程 | SIGTERM/异常退出 | NoeLoop 注册进 `gracefulShutdown`（`server.js`）→ clearInterval+abort+落盘 |

---

## 9. 兼容性与回滚策略

**兼容（加法不改存量）**
- 数据：迁移 v2 只 `CREATE TABLE IF NOT EXISTS`，0 改现有 17 表；旧代码无视新表照常跑。
- 接口：只新增 `/api/noe/*`；现有 40+ 路由签名不变。
- UI：只加 1 个 tab；现有主流程零改动。
- 默认态：`NoeLoop enabled=false`、`actMode=false`、`noe_tools.enabled=0`、connector disabled → **装上即静默**，开启前对用户零可观察变化。
- 依赖：FTS5 trigram 用捆绑 SQLite（已验证），manifest 校验用既有 `ajv` → **零新增依赖**（满足 NFR-DEP-1）。

**回滚（按可逆性分级）**
1. 功能级（秒级）：`kv` 配置 `noe.loop.enabled / noe.tools.enabled` 置 false → 行为即停，数据保留。
2. 代码级：新增均为独立文件/独立迁移 → `git revert` 加法 commit；旧代码忽略 v2 新表，DB 仍可用。
3. 数据级：迁移前自动 `panel.db.bak`（框架已具备）；新表可手工 `DROP`，不影响现有表。
4. 运行时：**锁 Node 22.x**（CLAUDE.md / CI 22.x）。Node 26 下 better-sqlite3 ABI 不匹配（实测 127 vs 147），切版本需 `npm rebuild better-sqlite3`；runbook 记录此项，避免误判为代码 bug。

**P0 边界需求落点**：审计复核（FR-01，§0 锚定审计稿 SHA + 镜像 HEAD 只读）、secret 卫生（FR-02，§9 secret 外置 + §10 扫描门 + C5 校验）、端口与数据隔离（FR-03，§1 独立端口/数据根 + §10 `NOE_M1_ISOLATION_SMOKE.mjs`）。

**红线复述（继承阶段 1）**：只在 Noe 工作；不改原项目 `51735`；不搬 BaiLongma 密钥/整仓；工具执行默认 disabled；不 spawn 子 LLM；secret 不进 git/文档。

---

## 10. 主要风险与收敛

| 风险 | 收敛手段 | 验收口径 |
|---|---|---|
| 后台 loop 烧额度 | 默认 actMode=false；act 必过 `budget.preflight` | 单测 mock adapter 断言默认 0 付费调用；超限自动 pause |
| 污染原项目 51735 | in-process+独立端口/数据根 | `node NOE_M1_ISOLATION_SMOKE.mjs` 全绿 |
| 工具越权执行 | manifest→权限门→审批→审计，默认 disabled | 未知工具 403；高危无 approval 阻断并写审计 |
| secret 泄漏 | secret 外置 0600 文件 + 审计自动 REDACTED | secret 扫描门 PASS（沿用 `NOE_PHASE2_SECRET_GATE.mjs`） |
| loop×集群抢预算 | 独立 scope + clusterBusy 让路 + 项目级封顶 | 集成测试并发 loop+room 不超项目预算 |
| Memory 召回不可用 | FTS5 能力探针 + LIKE 降级 | 单测覆盖 FTS 命中与降级两路径 |
| Node 版本漂移 | 锁 22.x + rebuild runbook | 启动自检 better-sqlite3 可 require |

---

## 11. 工程闭环 11 阶段衔接

1. 用户想法：`NOE_PHASE1_目标契约_CANONICAL.md` 已固定。
2. 需求分析：`NOE_PHASE2_REQUIREMENTS_CANONICAL.md`（UR/FR/NFR/Q）。
3. **技术方案设计（本文件）**：架构§1 / 模块边界§2 / 数据模型§3 / 接口§4 / 状态机§5 / 数据流§6 / Q 闭环§7 / 失败处理§8 / 兼容回滚§9 / 风险§10——可直接指导落地。
4. 任务分配与排期：按 §2 模块 + §3 迁移拆 M0(隔离验收已就绪)→M1(MemoryCore+迁移v2)→M2(NoeLoop)→M3(FocusStack)→M4(Brain UI Lite)→M5(ToolRegistry)→P2(Voice/Social)，P0 未过不抢跑。
5. 代码开发：仅 Noe 目录，加法不改存量，复用既有 budget/permission/approval/audit。
6. 单元测试：NoeLoop(start/stop/status/tick/幂等/abort/budget-mock)、MemoryCore(写/召回/FTS+LIKE/隔离/软删)、FocusStack(push/refresh计数/pop压缩/重启恢复)、ToolRegistry(disabled/deny/ask/allow)。
7. 集成测试：51835↔51735 隔离、owner-token、recall、Brain UI、审批阻断、loop×room 预算封顶。
8. 功能验证：端到端任务→loop→memory→Brain UI→审批阻断/恢复，失败态有 UI/日志证据。
9. 文档编写：持续更新本 canonical / 验证报告 / 上下文交接。
10. 交付验收：每阶段给文件证据+命令输出+测试结果，UI 给截图/浏览器证据。
11. 复盘优化：范围漂移、安全面、额度、loop 干扰、UI 可理解性、多成员协同成本。

---

## 12. 本阶段验收命令

```bash
pwd
wc -l NOE_PHASE3_TECH_DESIGN_CANONICAL.md NOE_PHASE3_VERIFY.mjs
node NOE_PHASE3_VERIFY.mjs        # 校验：7 必备章节 + Q-1..Q-7 全闭环 + FR-00..11 全映射 + 锚文件真实存在 + 设计稿无明文 secret
git -C BaiLongma-audit rev-parse HEAD   # de78c6f...（镜像只读未改）
git -C BaiLongma-audit status --short   # 空
```

阶段 3 裁定：本文件交付架构/模块边界/数据流/接口/状态机/失败处理/兼容回滚，关闭 Q-1..Q-7，每条 FR 有设计落点与验收口径，主要风险均给收敛手段。建议进入阶段 4「任务分配与排期」。
