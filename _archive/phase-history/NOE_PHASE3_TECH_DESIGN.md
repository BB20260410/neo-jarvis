# Noe / Neo 贾维斯 — 阶段 3 技术方案设计

生成时间：2026-06-02  
工作区：`/Users/hxx/Desktop/Neo 贾维斯`  
阶段：3. 技术方案设计  
目标：让 Noe 作为主产品底座，按可逆、可测试、默认安全的方式吸收 BaiLongma 的 TICK loop、Memory、Focus Stack、Brain UI、Voice、Social I/O 与工具市场思路。  

## 0. 前置修正与继承基线

- 本阶段发现 `NOE_BAILONGMA_ARCH_AUDIT.md` 曾回退出真实 `doubaoKey` 字面量，已重新脱敏为 `<REDACTED>`。
- 当前审计稿基线：`wc -l = 130`，SHA-256 = `3cb9e198b1c90b2dc8abfab20ce98e8d019d32ba89fbbe39e3370e0055dc3a41`。
- BaiLongma 镜像仍只读：`BaiLongma-audit` HEAD = `de78c6f761bd98a0fe406f0e78da80199ddf8d45`，`git status --short` 无输出。
- 阶段 2 需求基线继续有效：UR=6、FR=12、NFR=9，且 `node NOE_PHASE2_SECRET_GATE.mjs` 与 `node NOE_PHASE2_VERIFY.mjs` 均应 PASS。
- 本方案只设计 Noe 内部落地路径；不修改原项目 `/Users/hxx/Desktop/00_项目/05_Claude可视化面板`，不把 BaiLongma 全量复制进 Noe，不接入未审计工具执行能力。

## 1. 总体架构

Noe 保持现有 Express + WebSocket + SQLite + 本地静态 UI 架构。BaiLongma 只作为思想来源和审计参照，不作为运行时依赖。新增能力分四层：

```text
public/index.html + public/app.js
  -> Brain UI Lite panels
  -> /api/noe-loop, /api/noe-memory, /api/noe-focus, /api/noe-tools

server.js
  -> registerNoeLoopRoutes()
  -> registerNoeMemoryRoutes()
  -> registerNoeFocusRoutes()
  -> registerNoeToolRoutes()

src/noe-loop/
  -> NoeLoopController.js
  -> NoeLoopStore.js
  -> NoeContextAssembler.js
  -> NoeTickRunner.js

src/memory-core/
  -> MemoryCoreStore.js
  -> MemoryRetriever.js
  -> MemoryIngestor.js

src/focus/
  -> FocusStackStore.js
  -> FocusCompressor.js

existing foundations
  -> src/storage/SqliteStore.js
  -> src/audit/ActivityLog.js
  -> src/approval/ApprovalStore.js
  -> src/budget/BudgetPolicyStore.js
  -> src/permissions/PermissionGovernance.js
  -> src/safety/*
```

M0/M1 阶段不新增依赖。SQLite 继续由 `better-sqlite3` 承载；测试使用 `PANEL_DB_PATH` 指向临时库。所有读写 API 默认走 `requireOwnerToken`。

## 2. 模块边界

| 模块 | 负责 | 不负责 | BaiLongma 吸收方式 |
|---|---|---|---|
| NoeLoop | 可启停 TICK loop、tick 队列、状态机、watchdog、预算前置检查、事件落库 | 直接调用真实 LLM、执行 shell、发外部消息 | 吸收 `onTick`、`watchdog`、`startConsciousnessLoop` 思路，不搬 `src/index.js` |
| Memory Core | Noe 自有 memory item、FTS 检索、项目隔离、软删除、证据引用 | 迁移 BaiLongma 全量 `memories` 表或明文配置 | 吸收 memories + FTS + embedding BLOB 概念，落 Noe schema |
| Focus Stack | 当前任务焦点 push/refresh/pop/compress，焦点摘要回填 memory | 替代所有 room/task 状态 | 吸收 `focus_stack` 和 `compressPoppedFrame` 思路 |
| Brain UI Lite | 展示 loop、focus、memory、approval、health 状态 | 整页复制 BaiLongma Brain UI | 只借鉴 thought stream 和 panel 组织方式 |
| Tool Market Gate | manifest 预览、风险评级、审批与审计 | 默认执行未知工具代码 | 吸收 marketplace 思路，执行权交给 Noe 现有 permission/approval |
| Voice | 本机 ASR/TTS 配置、默认关闭、独立 smoke | P0/P1 阶段抢跑 | P2 后只吸收接口形态，不复制 `doubaoKey` 配置 |
| Social I/O | 外部 connector 注册、默认 disabled、对外写审批 | 默认自动发消息 | P2 后吸收 dispatch/targets 思路，先只读或 dry-run |

## 3. 数据模型

新增 schema 进入 `src/storage/SqliteStore.js` 的 `SCHEMA_MIGRATIONS`，而不是新建第二个数据库。迁移前沿用现有备份机制：既有数据时生成 `.bak`。

### 3.1 NoeLoop 表

```sql
CREATE TABLE IF NOT EXISTS noe_loop_runs (
  id TEXT PRIMARY KEY,
  status TEXT NOT NULL,
  mode TEXT NOT NULL DEFAULT 'idle',
  interval_ms INTEGER NOT NULL DEFAULT 15000,
  project_id TEXT,
  room_id TEXT,
  session_id TEXT,
  task_id TEXT,
  tick_count INTEGER NOT NULL DEFAULT 0,
  last_tick_at INTEGER,
  last_error TEXT,
  started_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  stopped_at INTEGER
);

CREATE TABLE IF NOT EXISTS noe_loop_ticks (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  status TEXT NOT NULL,
  reason TEXT NOT NULL,
  input TEXT NOT NULL DEFAULT '{}',
  result TEXT NOT NULL DEFAULT '{}',
  error TEXT,
  started_at INTEGER NOT NULL,
  finished_at INTEGER,
  duration_ms INTEGER
);
```

### 3.2 Memory Core 表

```sql
CREATE TABLE IF NOT EXISTS noe_memory_items (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  scope_type TEXT NOT NULL,
  scope_id TEXT,
  kind TEXT NOT NULL,
  title TEXT,
  content TEXT NOT NULL,
  source_ref_kind TEXT,
  source_ref_id TEXT,
  confidence REAL NOT NULL DEFAULT 0.7,
  visibility INTEGER NOT NULL DEFAULT 1,
  tags_json TEXT NOT NULL DEFAULT '[]',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  last_seen_at INTEGER,
  deleted_at INTEGER
);

CREATE VIRTUAL TABLE IF NOT EXISTS noe_memory_fts USING fts5(
  title,
  content,
  tags,
  tokenize='trigram'
);
```

若当前 SQLite 构建不支持 trigram tokenizer，迁移降级到默认 FTS5，并在 `MemoryRetriever` 对少于 3 字符或 FTS 报错查询使用 `LIKE` fallback。

### 3.3 Focus Stack 表

```sql
CREATE TABLE IF NOT EXISTS noe_focus_frames (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  room_id TEXT,
  session_id TEXT,
  task_id TEXT,
  parent_id TEXT,
  state TEXT NOT NULL DEFAULT 'active',
  title TEXT NOT NULL,
  summary TEXT,
  depth INTEGER NOT NULL DEFAULT 0,
  priority INTEGER NOT NULL DEFAULT 0,
  hit_count INTEGER NOT NULL DEFAULT 1,
  started_at INTEGER NOT NULL,
  refreshed_at INTEGER NOT NULL,
  ended_at INTEGER,
  absorbed_at INTEGER
);

CREATE TABLE IF NOT EXISTS noe_focus_events (
  id TEXT PRIMARY KEY,
  frame_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  payload TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL
);
```

## 4. 数据流

1. 用户或系统事件进入 Noe：room message、agent run 结果、手动 tick、schedule tick。
2. `NoeLoopController` 检查状态、预算、loop guard、并发锁；不能运行则写 `activity` 与 `noe_loop_ticks` 失败态。
3. `NoeContextAssembler` 收集当前项目、room/session/task、活跃 focus、Memory Core 检索结果、pending approvals、budget incidents、health 摘要。
4. M0/M1 的 `NoeTickRunner` 只执行本地动作：状态轮询、memory ingest、focus refresh、Brain UI event；不触发真实 LLM、shell、network upload 或 social write。
5. 结果写入 `noe_loop_ticks`、`events(kind='noe.loop')`、`activity`，必要时写入 `noe_memory_items` 与 `noe_focus_events`。
6. 前端通过 `/api/noe-loop/status` 轮询或 WebSocket 事件刷新 Brain UI Lite。

## 5. API 接口

全部写接口必须 `requireOwnerToken`；读接口包含 memory/focus 内容，也默认 owner-token。

| Method | Path | 用途 | 默认行为 |
|---|---|---|---|
| GET | `/api/noe-loop/status` | loop 当前状态、最近 tick、错误、预算阻断 | 只读 |
| POST | `/api/noe-loop/start` | 启动 loop，body: `{ mode, intervalMs, projectId, roomId, taskId }` | 幂等；已运行返回当前 run |
| POST | `/api/noe-loop/stop` | 停止 loop，body: `{ reason }` | abort 当前 tick，归档 stopped |
| POST | `/api/noe-loop/tick` | 手动 tick，body: `{ reason, input }` | 单次运行；默认 dry-run |
| POST | `/api/noe-loop/pause` | 暂停 loop | 不清 run 数据 |
| POST | `/api/noe-loop/resume` | 恢复 loop | 先过预算与权限 |
| GET | `/api/noe-loop/events` | 最近 loop 事件 | limit <= 200 |
| GET | `/api/noe-memory/search` | memory 检索 | projectId 必填或从 active workspace 推断 |
| POST | `/api/noe-memory/items` | 写 memory | 需要 sourceRef 与 kind |
| PATCH | `/api/noe-memory/items/:id` | 更新 visibility/tags/content | 写 activity |
| DELETE | `/api/noe-memory/items/:id` | 软删除 | 设置 deleted_at |
| GET | `/api/noe-focus/stack` | 当前 focus stack | 只读 |
| POST | `/api/noe-focus/push` | 入栈 | 去重命中则 refresh |
| POST | `/api/noe-focus/:id/refresh` | 刷新焦点 | 增 hit_count |
| POST | `/api/noe-focus/:id/pop` | 出栈并可压缩回填 memory | 默认本地摘要，LLM 摘要另需预算 |
| GET | `/api/noe-tools/marketplace` | 工具 manifest 预览和风险状态 | 不执行 |
| POST | `/api/noe-tools/marketplace/:id/enable` | 启用工具 | 必须 approval + permission |

## 6. 状态机

### 6.1 NoeLoop 状态

```text
disabled
  -> idle
idle
  -> starting -> waiting
waiting
  -> ticking
ticking
  -> waiting
  -> blocked_budget
  -> blocked_approval
  -> error
  -> stopping
blocked_budget
  -> waiting      (budget incident resolved)
  -> stopped
blocked_approval
  -> waiting      (approval approved)
  -> stopped      (approval rejected/cancelled)
error
  -> waiting      (retry allowed)
  -> stopped      (max retries exceeded)
stopping
  -> stopped
paused
  -> waiting
```

规则：
- 同一时刻只允许一个 active tick；重复 start/tick 返回当前锁状态。
- `stop` 必须触发 AbortController，并在 watchdog 超时后标记 tick `failed`。
- 默认 `mode='idle'` 只观测本地状态；`mode='assist'` 以后才允许模型参与。

### 6.2 Tick 子状态

```text
queued -> preparing_context -> running_local_actions -> writing_results -> succeeded
queued -> preparing_context -> blocked_budget
queued -> preparing_context -> blocked_approval
running_local_actions -> failed -> retry_scheduled | failed_terminal
```

### 6.3 Focus 状态

```text
active -> stale -> compressed -> archived
active -> compressed -> archived
active -> archived
```

`compressed` 表示摘要已回填 Memory Core；`archived` 表示不再参与当前上下文召回。

## 7. 失败处理策略

- Secret 失败：任何阶段文档或配置样例命中真实 BaiLongma key，立即停止推进，先脱敏并复跑 `NOE_PHASE2_SECRET_GATE.mjs`。
- 端口冲突：`51835` 被占用时不 kill 未识别 PID；运行 `NOE_M1_ISOLATION_SMOKE.mjs` 定位后再处理。
- SQLite 迁移失败：不进入 loop；保留 `.bak`；记录 `activity(action='noe.schema_migration_failed')`；回滚到上一个代码版本即可继续使用旧表。
- FTS/trigram 不可用：Memory Core 降级默认 FTS5 或 LIKE，不阻断 loop。
- Tick watchdog：默认 30s；超时 abort 当前 tick，状态进 `error`，连续失败 3 次进 `stopped`。
- 预算阻断：调用 `BudgetPolicyStore`；超限进 `blocked_budget`，UI 显示 incident，不自动重试。
- 审批阻断：工具、外部写、模型付费调用一律走 `PermissionGovernance` 与 `ApprovalStore`；未批则进 `blocked_approval`。
- UI 获取失败：Brain UI Lite 显示 last known state 和错误，不影响后端 stop/pause API。
- 外部连接失败：Voice/Social 默认 disabled；P2 阶段 connector fail 不影响 NoeLoop 和 Memory Core。

## 8. 关键设计决策

1. NoeLoop 先内嵌 server 进程，不做独立 worker。理由：M0/M1 只跑本地轻动作，便于复用 owner-token、activity、budget、approval 和测试夹具。若后续 tick 需要长任务，再用 worker_threads 或子进程隔离。
2. Memory Core 并入 `SqliteStore`，不另建数据库。理由：Noe 已有 schema migration、备份、`PANEL_DB_PATH` 测试隔离和 `~/.noe-panel` 权限策略。
3. P0 不接真实 LLM。理由：先证明 loop/state/memory/focus 闭环，不让后台循环消耗额度或触发不可控工具。
4. Brain UI Lite 增量挂现有 `public/index.html` 和 `public/app.js`，不复制 BaiLongma UI。理由：保留 Noe 现有面板信息密度、owner-token 和 modal 风格。
5. 工具市场只做 manifest + risk + approval gate。理由：BaiLongma marketplace 允许动态代码执行，Noe 必须先把执行权交给现有 permission/approval/audit。
6. Voice/Social 延后到 P2。理由：它们引入凭据、外部 I/O、音频进程和用户隐私，不能抢在 NoeLoop/Memory/Brain UI 之前。

## 9. 兼容性与回滚

- 端口兼容：Noe 默认 `51835` 不改；原项目 `51735` 不触碰；验证用 `NOE_M1_ISOLATION_SMOKE.mjs`。
- 数据兼容：新增表只追加，不改现有 `events`、`agent_runs`、`approvals`、`embeddings` 行为；旧 UI 和旧 API 不依赖新表。
- 配置兼容：不新增必须环境变量；测试可继续用 `PANEL_DB_PATH`。
- 依赖兼容：M0/M1 不新增 npm 包；FTS 使用现有 SQLite。
- 回滚代码：删除新增 route 注册与 `src/noe-loop`、`src/memory-core`、`src/focus` 即可禁用新能力。
- 回滚数据：新表以 `noe_` 前缀隔离；需要时可执行只删 `noe_%` 表的迁移脚本，不能动旧表。
- UI 回滚：Brain UI Lite 用独立 panel/modal 容器，移除入口即可恢复旧界面。

## 10. 工程闭环 11 阶段落地

1. 用户想法：继承 `NOE_PHASE1_目标契约_CANONICAL.md`，Noe 是唯一主产品。
2. 需求分析与拆解：继承 `NOE_PHASE2_REQUIREMENTS_CANONICAL.md` 的 UR/FR/NFR 与 P0/P1/P2 顺序。
3. 技术方案设计：本文件给出模块、schema、接口、状态机、失败处理、兼容和回滚。
4. 任务分配与排期：按 M1 隔离验证 -> NoeLoop -> Memory Core -> Focus -> Brain UI Lite -> Tool Gate -> Voice/Social 排期。
5. 代码开发：先写 store/controller/routes 的窄实现，再接 UI；每步只改 Noe 目录。
6. 单元测试：新增 `tests/unit/noe-loop*`、`memory-core*`、`focus-stack*`、routes 测试；mock 掉 LLM/tool。
7. 集成测试：跑 `NOE_M1_ISOLATION_SMOKE.mjs`、API smoke、SQLite migration smoke、owner-token 401/200。
8. 功能验证：用一个本地任务证明 tick -> memory -> focus -> Brain UI -> approval blocked/resume 可观察。
9. 文档编写：更新阶段实现文档、验证报告、`上下文交接.md` 或 handoff。
10. 交付验收：提交命令输出、测试结果、UI 截图或浏览器证据；secret gate 必须 PASS。
11. 复盘优化：复盘后台 loop 干扰、预算消耗、权限阻断、memory 噪声、UI 可理解性和多成员协同成本。

## 11. 主要风险与收敛

| 风险 | 收敛方式 |
|---|---|
| 后台 loop 误烧模型额度 | P0 禁止真实 LLM；P1 后所有模型调用先过 budget + explicit mode |
| 动态工具执行造成 RCE | marketplace 先只读 manifest；执行必须 permission + approval + audit |
| Memory 噪声污染上下文 | visibility、confidence、project_id、focus frame 隔离；支持 soft delete |
| FTS/trigram 运行时不兼容 | 自动降级默认 FTS/LIKE，单测覆盖 fallback |
| UI 过度改造影响现有面板 | Brain UI Lite 独立 panel，Playwright 截图验证不遮挡主流程 |
| 与原项目端口/数据冲突 | 继续使用 51835 与 `~/.noe-panel`；用 M1 smoke 验证 51735 PID 不变 |
| 旧阶段文档再次泄密 | `NOE_PHASE2_SECRET_GATE.mjs` 作为阶段 3/4/9/10 的硬门 |

## 12. 阶段 3 裁定

同意推进到阶段 4「任务分配与排期」。推进条件是：阶段 4 必须把 P0 拆成可独立验证的小任务，先做 M1 端口隔离实测，再做 NoeLoop 最小闭环和 Memory Core；Voice/Social 不得抢跑。
