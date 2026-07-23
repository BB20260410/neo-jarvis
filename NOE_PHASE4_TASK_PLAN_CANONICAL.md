# Noe / Neo 贾维斯 — 阶段 4「任务分配与排期」CANONICAL

生成时间：2026-06-02
工作区：`/Users/hxx/Desktop/Neo 贾维斯`
阶段：4. 任务分配与排期
继承：`NOE_PHASE1_目标契约_CANONICAL.md`（目标/边界/红线）、`NOE_PHASE2_REQUIREMENTS_CANONICAL.md`（UR/FR/NFR/Q）、`NOE_PHASE3_TECH_DESIGN_CANONICAL.md`（架构/模块/数据/接口/状态机/失败处理/回滚，**唯一落地基线**）
结论：本文件把阶段 3 技术方案拆成 **可逐项执行与验收的任务队列**，给出执行顺序、依赖 DAG、角色/模型分工、阻塞点、逐任务验收口径与检查点门；P0 未过不抢 P1，P1 未过不碰 P2。可推进阶段 5「代码开发」。

---

## 0. 排期前一手核验（本轮实测，非文档声明）

| 核验项 | 实测结果 | 影响排期处 |
|---|---|---|
| 工作区 | `pwd` = `/Users/hxx/Desktop/Neo 贾维斯` | 所有任务读写边界 |
| BaiLongma 镜像 | HEAD `de78c6f761bd98a0fe406f0e78da80199ddf8d45`，`status --short` 空（只读未改） | FR-01 审计基线不漂 |
| 新模块目录 | `src/loop`、`src/memory`、`src/capabilities` **尚未创建** | M1/M2/M5 为净新增，符合「加法不改存量」 |
| 隔离 smoke | `NOE_M1_ISOLATION_SMOKE.mjs` 已存在（真启停证明 51835↔51735 零影响） | M0 验收门已就绪，无需新写 |
| **运行版 Node（硬阻塞）** | 当前 shell `node -v`=**v26.0.0（ABI modules=147）**；设计要求锁 **Node 22.x（better-sqlite3 预编译 ABI 127）** | **BLK-1**：M0 必须在 Node 22.x 下复跑，否则 `node server.js` 起不来（ABI 127 vs 147），后续全部任务被堵 |

**排期第一原则（继承设计 §0）**：加法不改存量 + 默认关。每个里程碑产出 = 新表/新模块/新路由/新 tab；NoeLoop 与工具执行默认 `enabled=false`，未显式开启前对现有面板零可观察影响。**任何任务越过 P0 闸门去抢 P1/P2 = 直接判不通过。**

---

## 1. 排期总览（里程碑 + 波次 + 检查点门）

里程碑沿用设计 §11.4 命名（M0 隔离 → M1 Memory → M2 NoeLoop → M3 Focus → M4 Brain UI → M5 ToolRegistry → P2 Voice/Social），按「波次」并行、检查点门串行卡关：

```
波次0  ── M0 隔离基线（P0 闸门）─────────────────────────────► CP-A
                       │（CP-A 通过才放行）
        ┌──────────────┼───────────────────────────┐
波次1   │  M1 Memory   ‖  M2 NoeLoop  ‖  M-R noe 路由骨架   │（均 P0/P1 底座，可并行）
        └──────────────┴───────────────────────────┘──────► CP-B（P0 闭环门）
                       │（CP-B 通过才放行 P1）
        ┌──────────────┼───────────────────────────┐
波次2   │  M3 Focus(依赖 M1)  ‖  M5 ToolRegistry  ‖  M4 Brain UI(依赖 M-R) │
        └──────────────┴───────────────────────────┘──────► CP-C（P1 闭环门）
                       │（CP-C 通过才放行）
波次3   ── M-INT 集成测试 + 功能验证 E2E ──────────────────► CP-C 复核
                       │（仅 CP-C 通过 + 单独评审）
波次4   ── P2 Voice/Social（本阶段只定契约，不写代码）──────► CP-D（P2 准入门）

横切（贯穿全程）：X-1 secret 门 · X-2 零新增依赖 · X-3 性能基线
```

| 里程碑 | FR | 优先级 | 波次 | 产出落点（设计锚） | 出口检查点 |
|---|---|---|---|---|---|
| M0 隔离基线 | FR-03 | P0 | 0 | `NOE_M1_ISOLATION_SMOKE.mjs`（已存在） | CP-A |
| M1 Memory Core | FR-05 | P0 | 1 | 迁移 v2 + `src/memory/MemoryCore.js` | CP-B |
| M2 NoeLoop | FR-04 | P0 | 1 | `src/loop/NoeLoop.js` | CP-B |
| M-R noe 路由 | FR-07/09 前置 | P1 | 1 | `src/server/routes/noe.js` | CP-B/CP-C |
| M3 Focus Stack | FR-06 | P1 | 2 | `src/memory/FocusStack.js` | CP-C |
| M4 Brain UI Lite | FR-07/09、UR-6 | P1 | 2 | `public/src/web/brain-ui.js` + 新 tab | CP-C |
| M5 ToolRegistry | FR-08 | P1 | 2 | `src/capabilities/ToolRegistry.js` | CP-C |
| M-INT 集成/功能 | FR-09、NFR-PERF-1 | P1 | 3 | 集成 smoke + E2E（阶段 7/8 接力） | CP-C 复核 |
| P2 Voice/Social | FR-10 / FR-11 | P2 | 4 | 仅契约文档（不写代码） | CP-D |

---

## 2. 任务清单（WBS — 每行可独立执行与验收）

> 列含义：**ID** · **任务** · **主办(实现)** · **复核(验证)** · **依赖** · **验收口径（可复跑命令/证据）**
> 主办/复核为「角色建议」，落地由房间执行（见 §4）。所有任务读写边界 = Noe 工作区。

### M0 — 隔离基线（P0，闸门已就绪）

| ID | 任务 | 主办 | 复核 | 依赖 | 验收口径 |
|---|---|---|---|---|---|
| T-0.1 | 在 **Node 22.x** 下复跑隔离 smoke（解 BLK-1 ABI） | 🟣 Claude | 🔷 Gemini | — | `nvm use 22 && node NOE_M1_ISOLATION_SMOKE.mjs` 退出码 0；51735 PID 前中后不变 |
| T-0.2 | 锁运行版 Node 22.x（`.nvmrc`/`engines` 核对 + rebuild runbook） | 🟢 GPT | 🟣 Claude | T-0.1 | `cat .nvmrc`=22；`node -e "require('better-sqlite3')"` 无 ABI 报错；runbook 记 `npm rebuild better-sqlite3` |

### M1 — Memory Core 数据底座（P0）

| ID | 任务 | 主办 | 复核 | 依赖 | 验收口径 |
|---|---|---|---|---|---|
| T-1.1 | 迁移 v2：`noe_memory` 主表 + 2 索引（`SCHEMA_MIGRATIONS` version=2，事务内、升级前 `.bak`） | 🟢 GPT | 🟣 Claude | CP-A | 迁移单测：v1→v2 升级成功、`.bak` 生成、现有 17 表零改动（schema diff） |
| T-1.2 | 迁移 v2：`noe_memory_fts`(trigram) + insert/update/delete 触发器 + FTS 能力探针 | 🟢 GPT | 🟣 Claude | T-1.1 | 单测：FTS 表建成；探针 `ftsAvailable()` 真；触发器随主表写同步 |
| T-1.3 | `MemoryCore.write/get/hide/bumpHit`（项目隔离 + 软删除 hidden=1，不物理删） | 🟢 GPT | 🔷 Gemini | T-1.1 | 单测：写读回、项目隔离不串、软删后召回不返、bumpHit 自增 |
| T-1.4 | `MemoryCore.recall`（FTS5 MATCH→rank；不可用降级 LIKE） | 🟢 GPT | 🟣 Claude | T-1.2,T-1.3 | 单测覆盖 **FTS 命中** 与 **LIKE 降级** 两路径；项目隔离生效 |
| T-1.5 | M1 单测套件汇总（写/召回/双路径/隔离/软删） | 🔷 Gemini | 🟢 GPT | T-1.1..1.4 | `npm test` M1 子集全绿；覆盖 FR-05 全部验收口径 |

### M2 — NoeLoop 最小闭环（P0，与 M1 可并行）

| ID | 任务 | 主办 | 复核 | 依赖 | 验收口径 |
|---|---|---|---|---|---|
| T-2.1 | NoeLoop 生命周期状态机骨架（start/stop/pause/resume/status，幂等，`this.running` 重入锁） | 🟣 Claude | 🟢 GPT | CP-A | 单测：重复 start 幂等、状态流转 stopped↔idle↔ticking 正确 |
| T-2.2 | `tick()` 默认本地轮询（focus 刷新/记忆维护/健康）→ `events` 写 `kind=noe_loop_tick` → WS 广播 | 🟣 Claude | 🟢 GPT | T-2.1 | 单测：tickCount 自增；事件落 `events` 表；**默认不触 MemoryCore.write 也不调 LLM** |
| T-2.3 | watchdog（AbortController 30s 超时）+ 连续 3 次错误熔断自动 stop+audit | 🟣 Claude | 🔷 Gemini | T-2.1 | 单测：单 tick 超时被 abort；连续 3 错→自动 stop + `ActivityLog` 记 `noe.loop.autostop` |
| T-2.4 | act 路径骨架：act 条件 + `budget.preflight(scope='noe-loop')` + `clusterBusy()` 让路（默认 `actMode=false`） | 🟣 Claude | 🟢 GPT | T-2.1 | 单测 mock adapter：**默认 actMode=false → 0 付费调用**；预算超限→`pause('budget')`；clusterBusy 真→不 act |
| T-2.5 | graceful shutdown 挂钩（`server.js` gracefulShutdown 注册 clearInterval+abort） | 🟣 Claude | 🟢 GPT | T-2.1 | SIGTERM 后 interval 清除、在途 tick abort；不残留定时器 |
| T-2.6 | M2 单测套件汇总（start/stop/status/tick/幂等/abort/budget-mock） | 🔷 Gemini | 🟣 Claude | T-2.1..2.5 | `npm test` M2 子集全绿；覆盖 FR-04 + NFR-COST-1 |

### M-R — noe 路由组（P1 前置，与 M1/M2 并行骨架）

| ID | 任务 | 主办 | 复核 | 依赖 | 验收口径 |
|---|---|---|---|---|---|
| T-R.1 | `src/server/routes/noe.js`：`registerNoeRoutes(app,deps)` + loop/memory/focus/tools/approvals/health 端点（自动套 owner-token、body cap、错误 `{ok:false}`） | 🟢 GPT | 🟣 Claude | T-1.4,T-2.1 | 烟雾：各端点路由注册；未授权 **401**；超长 body 被 cap |
| T-R.2 | 路由烟雾测试（未授权 401 / loop status / memory recall / health 聚合） | 🔷 Gemini | 🟢 GPT | T-R.1 | smoke 脚本退出码 0；health 返回 loop+memory计数+focus深+pending审批+健康 |

### M3 — Focus Stack（P1）

| ID | 任务 | 主办 | 复核 | 依赖 | 验收口径 |
|---|---|---|---|---|---|
| T-3.1 | `FocusStack.push/peek/list`（命中已存在→`hit_count++` refresh；表随 M1 迁移已落地） | 🟢 GPT | 🟣 Claude | CP-B | 单测：push 入栈、重复命中计数自增、list 按 depth 排序 |
| T-3.2 | `pop(id)` → 压缩摘要 + 沉淀 `noe_memory`（写 `absorbed_memory_id`） | 🟣 Claude | 🟢 GPT | T-3.1,T-1.3 | 单测：pop 生成 `compressed_summary`，沉淀记忆 id 可在 MemoryCore 查到 |
| T-3.3 | `restore()` 重启从表恢复 active 栈 | 🟢 GPT | 🔷 Gemini | T-3.1 | 单测：模拟重启后 active 栈恢复；**旧焦点不污染新项目**（项目隔离） |
| T-3.4 | M3 单测套件汇总（push/refresh/pop压缩/重启恢复/不污染） | 🔷 Gemini | 🟢 GPT | T-3.1..3.3 | `npm test` M3 子集全绿；覆盖 FR-06 |

### M5 — ToolRegistry（P1，与 M3/M4 并行）

| ID | 任务 | 主办 | 复核 | 依赖 | 验收口径 |
|---|---|---|---|---|---|
| T-5.1 | manifest ajv schema + `register(manifest)`（`risk_level` 映射；`enabled=0` 默认禁用；表随 M1 迁移） | 🟣 Claude | 🟢 GPT | CP-B | 单测：合法 manifest 入库 enabled=0；非法 manifest 被 ajv 拒 |
| T-5.2 | `invoke` 编排：disabled→403 / `evaluatePermission`(deny→block，ask→`ApprovalStore` 202，allow→白名单执行) / shell 过 `DangerousPatternDetector` / 全程 `ActivityLog` | 🟣 Claude | 🔷 Gemini | T-5.1 | 单测：未知/禁用→403；高危无 approval→阻断+审计；ask→建审批；allow→仅白名单动作 |
| T-5.3 | M5 单测套件汇总（disabled/deny/ask/allow + 审计字段） | 🔷 Gemini | 🟣 Claude | T-5.1,T-5.2 | `npm test` M5 子集全绿；覆盖 FR-08 + UR-4 工具默认 disabled |

### M4 — Brain UI Lite（P1，依赖 M-R）

| ID | 任务 | 主办 | 复核 | 依赖 | 验收口径 |
|---|---|---|---|---|---|
| T-4.1 | `index.html` 新 tab + `public/src/web/brain-ui.js`（5 面板：Loop·Focus·思考流·记忆召回·工具审批·健康） | 🟢 GPT | 🟣 Claude | CP-B,T-R.1 | 浏览器加载新 tab 不报错；5 面板 DOM 存在 |
| T-4.2 | 订阅 WS 思考流 + 轮询 `/api/noe/health` 聚合渲染 | 🟢 GPT | 🟣 Claude | T-4.1,T-R.2 | 思考流实时更新；health 数字与后端一致 |
| T-4.3 | Playwright/浏览器验证 5 面板可见 + 截图证明**不遮挡现有主流程** | 🔷 Gemini | 🟢 GPT | T-4.1,T-4.2 | Playwright 断言 5 面板可见；截图入交付；主流程 tab 仍可用 |

### M-INT — 集成与功能验证衔接（P1，阶段 7/8 接力，本阶段排期占位）

| ID | 任务 | 主办 | 复核 | 依赖 | 验收口径 |
|---|---|---|---|---|---|
| T-I.1 | 集成 smoke：51835↔51735 隔离 + owner-token + recall + Brain UI + 审批阻断 + loop×room 预算封顶 | 🟢 GPT | 🟣 Claude | CP-C | 集成脚本退出码 0；并发 loop+room 不超项目预算封顶 |
| T-I.2 | 功能验证 E2E：任务→loop→memory→Brain UI→审批阻断/恢复（失败态有 UI/日志证据） | 🟣 Claude | 🔷 Gemini | T-I.1 | E2E 用例全过；阻断与恢复均有 UI 或日志证据 |

### P2 — Voice/Social（延后，本阶段**只定契约不写代码**）

| ID | 任务 | 主办 | 复核 | 依赖 | 验收口径 |
|---|---|---|---|---|---|
| T-P2.1 | (gated, **FR-10**) Voice 连接器契约：默认 disabled；secret 从 `~/.noe-panel/secrets/<name>.json`(0600) 装载，不进 git/文档 | 🟢 GPT | 🟣 Claude | CP-D | 契约文档落地；**不产出可执行 Voice 代码**；secret 门 PASS |
| T-P2.2 | (gated, **FR-11**) Social I/O 连接器契约：未配置凭据 disabled；对外写需 owner-token+权限分级+审计 | 🟢 GPT | 🟣 Claude | CP-D | 契约文档落地；默认不对外发送；**不产出可执行 Social 代码** |

### 横切任务（P0 NFR，贯穿全程，每里程碑收口复跑）

| ID | 任务 | 主办 | 复核 | 依赖 | 验收口径 |
|---|---|---|---|---|---|
| X-1 | 每里程碑复跑 secret 卫生门 | 🔷 Gemini | 🟢 GPT | 全程 | `node NOE_PHASE2_SECRET_GATE.mjs` 退出码 0；diff 无真实凭据（NFR-SEC-2） |
| X-2 | 零新增依赖核对（每 PR `package.json` diff 空，除非诊断明列+用户同意） | 🟢 GPT | 🟣 Claude | 全程 | `git diff package.json package-lock.json` 仅当显式批准才非空（NFR-DEP-1） |
| X-3 | 性能基线（启动时间/关键接口响应/loop 空跑开销） | 🔷 Gemini | 🟢 GPT | M-INT | 阶段 7 记录基线，loop 空跑对面板启动无显著拖慢（NFR-PERF-1） |

**任务计数**：M0×2 + M1×5 + M2×6 + M-R×2 + M3×4 + M5×3 + M4×3 + M-INT×2 + P2×2 + 横切×3 = **32 个可独立验收任务**。

---

## 3. 执行顺序与依赖 DAG

```text
                                  ┌─ X-1 secret 门 ─┐
                                  ├─ X-2 零依赖     ├─（横切，每里程碑收口复跑）
                                  └─ X-3 性能基线 ──┘

T-0.1 ─► T-0.2 ─► [CP-A] ─┬─► M1: T-1.1 ─► T-1.2 ─► T-1.4 ─► T-1.5
                          │        └─► T-1.3 ─►┘
                          ├─► M2: T-2.1 ─┬─► T-2.2
                          │              ├─► T-2.3
                          │              ├─► T-2.4 ─► T-2.6
                          │              └─► T-2.5
                          └─► M-R: T-R.1 ─► T-R.2
                                   │
                          [CP-B  P0 闭环门：M1+M2 全绿 + 默认零付费 + secret 门 PASS]
                                   │
        ┌──────────────────────────┼──────────────────────────┐
        ▼                          ▼                           ▼
  M3: T-3.1─►T-3.2          M5: T-5.1─►T-5.2─►T-5.3      M4: T-4.1─►T-4.2─►T-4.3
        └─►T-3.3─►T-3.4                                        （依赖 M-R 路由）
        └──────────────────────────┼──────────────────────────┘
                          [CP-C  P1 闭环门：M3+M4+M5+路由+集成全绿 + Brain UI 截图]
                                   │
                          M-INT: T-I.1 ─► T-I.2
                                   │
                          [CP-C 复核] ──（+ 单独评审）──► [CP-D  P2 准入]
                                   │
                          P2: T-P2.1 ‖ T-P2.2（仅契约）
```

**依赖裁定（解决需求 §5 DAG 与 FR 表的张力）**：需求 FR 表写「FR-05 依赖 FR-04」，但 §5 DAG 把 FR-04/FR-05 列为 FR-03 的并列子节点。本排期裁定：**Memory Core 的存储底座（schema/CRUD/FTS）不依赖 NoeLoop，二者在 CP-A 后并行**；二者唯一耦合点是「NoeLoop act 写 evidence 进 MemoryCore」，该集成属 P0 但置于 M1+M2 各自单测通过之后（CP-B 前的最后一步），不互锁开工。这样既尊重 FR 依赖语义，又最大化波次 1 并行度。

---

## 4. 角色 / 模型分工

分工原则（继承房间规则）：Claude 可用时 **Claude + GPT/Codex 一致通过即可推进**；Gemini 在 Claude 可用时是**审计辅助**（只在可复验的安全/secret/路径/数据/原项目污染/不可逆风险上阻断，普通建议不拖阶段）。Claude 掉线/限流/不可用后，由 **GPT/Codex + Gemini 一致通过**推进。

| 成员 | 角色定位 | 主办（实现）领域 | 复核领域 | 理由 |
|---|---|---|---|---|
| 🟣 Claude | 核心后端 lead | M2 NoeLoop 状态机、M5 ToolRegistry 权限编排、迁移框架挂钩、Focus pop 沉淀、E2E | M1 迁移正确性、路由 owner-token、回滚安全 | 擅长追 `server.js`/既有 budget/permission/approval/audit 内部链路与状态机 |
| 🟢 GPT | 数据/接口/脚本 lead | M1 Memory CRUD+FTS+recall、M-R 路由、M4 Brain UI、迁移 SQL、验证脚本、Voice/Social 契约 | NoeLoop 单测、Focus、ToolRegistry manifest、依赖 diff | 适合规格清晰、可并行的数据层与接口面 |
| 🔷 Gemini | 审计/验证 assist | 各里程碑单测套件汇总、隔离 smoke 复跑、secret 扫描、截图/Playwright 证据复核 | 项目隔离、软删、熔断、不污染原项目 | Claude 可用期定位为审计辅助，承接可机器复跑的验证面 |

**交叉评审硬规则**：每个 T-任务的「主办 ≠ 复核」，复核成员必须用主办给出的验收命令**实跑复现**（report ≠ 实际即不通过，沿用阶段 2/3 反幻觉口径）。

---

## 5. 阻塞点（BLK）与风险闸门

| ID | 阻塞点 | 触发后果 | 收敛/解除条件 | 负责 |
|---|---|---|---|---|
| BLK-1 | 运行版 Node=26（ABI 147）≠ 设计锁定 22.x（ABI 127），`node server.js` 起不来 | M0 起全部任务被堵 | T-0.1/T-0.2：切 Node 22.x 或 `npm rebuild better-sqlite3`；`.nvmrc`=22 落盘 | 🟣 Claude |
| BLK-2 | 迁移 v2 误改现有 17 表 / 破坏 v1 数据 | 现有面板数据风险（不可逆边界） | 迁移前自动 `.bak`（框架已具备）；schema diff 证明 0 改存量；失败事务回滚 | 🟢 GPT |
| BLK-3 | NoeLoop 默认态烧额度（误调 LLM） | 触红线 NFR-COST-1 | T-2.4 mock adapter 断言默认 0 付费调用；`actMode=false` 为出厂默认 | 🟣 Claude |
| BLK-4 | 工具执行越权 / 高危无审批被放行 | 触红线 UR-4 / FR-08 | T-5.2 未知→403、高危无 approval→阻断+审计；默认 `enabled=0` | 🟣 Claude |
| BLK-5 | 任意 .md/diff 混入真实 secret | 触红线 NFR-SEC-2 | X-1 每里程碑 `NOE_PHASE2_SECRET_GATE.mjs` 退出码 0 | 🔷 Gemini |
| BLK-6 | 触碰原项目 `51735` / 在原项目目录开发 | 触红线 NFR-ISO-1 | M0 smoke 证明 51735 PID 不变；所有任务 cwd=Noe | 🔷 Gemini |
| BLK-7 | P0 未过抢跑 P1/P2（范围漂移） | 违反优先级契约 | CP 门强制串行：CP-B 不过不进 P1；CP-C+评审不过不碰 P2 | 全员 |

**风险闸门 = 检查点门（§6）**：阻塞点全部映射到某个 CP，CP 不绿则该波次不放行。

---

## 6. 验证门：逐任务验收 + 检查点门（CP）

### 6.1 逐任务验收
每个 T-任务的「验收口径」列即其验收门（§2），形式 = 可复跑命令或可核验证据（单测子集、smoke 退出码、schema diff、截图）。复核成员实跑复现方算通过。

### 6.2 检查点门（串行卡关，每门给可机读判定）

| 门 | 位置 | 通过条件（全满足） | 验收命令 |
|---|---|---|---|
| **CP-A** | M0 出口 | ① Node 22.x 锁定；② 隔离 smoke 退出码 0；③ 51735 PID 前中后不变 | `node NOE_M1_ISOLATION_SMOKE.mjs`（Node22）+ `cat .nvmrc` |
| **CP-B** | 波次1 出口（P0 闭环门） | ① M1+M2 单测全绿；② mock 证明默认 0 付费调用；③ 迁移 0 改现有 17 表 + `.bak` 生成；④ secret 门 PASS；⑤ 路由未授权 401 | `npm test`(M1+M2 子集) + `node NOE_PHASE2_SECRET_GATE.mjs` + schema diff |
| **CP-C** | 波次2/3 出口（P1 闭环门） | ① M3+M4+M5 单测全绿；② Brain UI 5 面板截图证明不遮挡主流程；③ 集成 smoke（隔离+owner-token+recall+审批阻断+预算封顶）退出码 0；④ 未知工具 403、高危无 approval 阻断+审计 | `npm test`(全) + 集成 smoke + Playwright 截图 |
| **CP-D** | P2 准入门 | ① CP-C 已通过；② 单独评审记录在案；③ P2 仅契约文档、零可执行 Voice/Social 代码；④ secret 门 PASS | 评审记录 + `node NOE_PHASE2_SECRET_GATE.mjs` + 无新 Voice/Social 源文件 |

**门的强制性**：CP-A→CP-B→CP-C→CP-D 严格串行；任一门未绿，其下游波次任务**不得开工**。本阶段交付的是排期与门定义，门的实跑发生在阶段 5–8。

---

## 7. 排期与检查点时间线（相对工作单位，非绝对日历）

> 用「工作单位 WU」表达相对工作量，不锁绝对日历（本地单机、按需推进）。同波次任务可并行。

| 波次 | 里程碑/任务 | 相对工作量(WU) | 出口检查点 | 并行性 |
|---|---|---|---|---|
| 0 | M0（T-0.1,T-0.2） | 1 | CP-A | 串行（前置） |
| 1 | M1（T-1.1..1.5）‖ M2（T-2.1..2.6）‖ M-R（T-R.1,T-R.2） | 4（并行墙钟≈最长链 M2） | CP-B | 三轨并行 |
| 2 | M3（T-3.1..3.4）‖ M5（T-5.1..5.3）‖ M4（T-4.1..4.3） | 4（并行墙钟≈最长链 M4） | CP-C | 三轨并行 |
| 3 | M-INT（T-I.1,T-I.2） | 2 | CP-C 复核 | 串行 |
| 4 | P2（T-P2.1,T-P2.2，仅契约） | 1 | CP-D | 可并行 |
| 横切 | X-1/X-2/X-3 | 随波次收口 | 映射各 CP | 嵌入每波次 |

**检查点节奏**：每波次结束 = 一次检查点门 + 一次 secret 门复跑 + 一次 `git status --short` 可审计快照。任一门红 → 停在本波次修复，不跨门推进。

---

## 8. 工程闭环 11 阶段衔接

1. 用户想法 / 2. 需求分析 / 3. 技术方案：已由 `NOE_PHASE1/2/3 CANONICAL` 固定，本阶段全部任务以阶段 3 设计为**唯一落地基线**。
3. **任务分配与排期（本文件）**：§2 任务清单 + §3 DAG + §4 分工 + §5 阻塞点 + §6 验证门 + §7 时间线——粒度细到可逐项执行与验收。
5. 代码开发：按波次 0→4 推进，仅 Noe 目录，加法不改存量，复用既有 budget/permission/approval/audit；P0 未过不抢 P1。
6. 单元测试：T-x.5/x.6 各里程碑单测套件即对应 FR 验收（CP-B/CP-C 卡关）。
7. 集成测试：T-I.1（隔离+owner-token+recall+审批+预算封顶）。
8. 功能验证：T-I.2 E2E（任务→loop→memory→Brain UI→审批阻断/恢复）。
9. 文档编写：每波次更新本 canonical 进度 + 验证报告 + 上下文交接（NFR-DOC-1）。
10. 交付验收：每任务给命令输出/单测结果/截图证据；CP 门留档。
11. 复盘优化：范围漂移、安全面、额度、loop 干扰、UI 可理解性、多成员协同成本。

---

## 9. 本阶段验收命令

```bash
pwd                                          # /Users/hxx/Desktop/Neo 贾维斯
wc -l NOE_PHASE4_TASK_PLAN_CANONICAL.md NOE_PHASE4_VERIFY.mjs
node NOE_PHASE4_VERIFY.mjs                    # 校验：8 必备章节 + 32 任务有验收口径 + P0/P1 FR 全映射 + 三成员分工 + CP-A..D + 阻塞点 + 锚文件真实 + 无 secret + 关键决策机读
node NOE_PHASE2_SECRET_GATE.mjs               # secret 卫生门退出码 0（横切 X-1）
git -C BaiLongma-audit rev-parse HEAD         # de78c6f...（镜像只读未改）
git -C BaiLongma-audit status --short         # 空
```

阶段 4 裁定：本文件交付**任务列表（32 项）、执行顺序（DAG + 4 波次）、角色/模型分工、阻塞点、逐任务验收口径与 4 道检查点门**；每条任务粒度足够小、可独立执行与验收；P0→P1→P2 串行闸门防范围漂移。建议进入阶段 5「代码开发」。
