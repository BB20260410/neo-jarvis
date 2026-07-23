# SUPERSEDED - 请改读 `NOE_CE12_P0_DOCS_CANONICAL.md`

本文件是 2026-06-02 早期 Phase9 文档，保留为历史记录。CE12 P0 后续代码、测试和功能验证已经更新了事实：NoeLoop 已接入最小 Act Pipeline，旧 Brain UI e2e 已 deprecated 转发，当前文档事实源是 `NOE_CE12_P0_DOCS_CANONICAL.md`，操作手册是 `NOE_CE12_P0_OPERATIONS_MANUAL.md`，交接文件是 `NOE_CE12_P0_HANDOFF.md`。不要把本文件中 CE12 前的限制描述当成当前状态。

# Noe / Neo 贾维斯 — 阶段 9 文档 CANONICAL（使用 / 维护 / 已知限制 / 交接）

> 单一权威文档。下一位执行者**只读本文件即可接手 Noe 子系统**，无需重新猜测上下文。
> 配套机读门：`NOE_PHASE9_DOCS_VERIFY.mjs`（校验本文档与磁盘一致、API 无幻觉、无明文密钥）。
> 收敛规则（建议#1，2026-06-02 实测）：本文件 + `NOE_PHASE9_DOCS_VERIFY.mjs` 为阶段 9 的**自包含权威**——其锚点全是稳定产品源码/测试脚本（`src/**`、`public/**`、各阶段 VERIFY），不依赖任何并行成员文档存活。并行成员维护面向产品的 `README.md` / `CHANGELOG.md`（增量并入、勿整体覆盖）；如其 `NOE_PHASE9_VERIFY.mjs` 在场则共存互不覆盖，但本门**不依赖**它（实测该文件在本会话期间曾被并行成员删除；当前本门为 9/9 PASS）。
> 范围红线：只在 Noe 目录 `/Users/hxx/Desktop/Neo 贾维斯` 工作；不改原项目 `/Users/hxx/Desktop/00_项目/05_Claude可视化面板`；不全量复制 BaiLongma；工具执行能力默认禁用、未审计不接入。
> 监督纠偏（2026-06-01T17:57:48，已落账到 `NOE_STAGE9_SUPERVISOR_CORRECTION.md`）：阶段 9 最多讨论 3 轮；当前按第 2/3 轮处理；Claude 掉线、没额度、限流或 CLI 不可用后，由 GPT/Codex + Gemini 有效成员共识推进；不要沿用旧的“不允许因轮数/输出上限停止”文案，也不要因旧 CE05 返工文字回退当前文档阶段。

---

## 0. 项目定位与边界（先读这段）

- **Noe / Neo 贾维斯** = 在既有「本地多 AI 会话可视化面板」（Express + WebSocket + Web GUI，端口 51835，仅 127.0.0.1）底座上，**加法式**吸收 BaiLongma 的 TICK loop / Memory / Focus Stack / Brain UI 思路而成的主产品。
- **不是** 原 Xike Lab 稳定项目；原项目跑在 **51735**，本子系统跑 **51835**，端口、数据库、进程三层隔离，互不影响（隔离证据见 §5.3）。
- **BaiLongma** 只做过**只读审计**（镜像 `BaiLongma-audit/`，HEAD `de78c6f`，已 `.gitignore`，永不 commit 进 Noe）；审计结论见 `NOE_BAILONGMA_ARCH_AUDIT.md`。
- 本阶段（CE05 代码开发起）已落地的范围 = **M1 Memory Core / M2 NoeLoop / M-R Noe 路由 / M4 Brain UI Lite / M5 ToolRegistry 安全门**。Voice / Social I/O / 工具真实执行 = **P2，未实现**（见 §6 已知限制）。

### 0.1 本阶段协同推进规则

- 阶段 9「文档编写」最多讨论 3 轮；当前按第 2/3 轮处理，第 3 轮必须给出可裁定结论。
- 不要沿用旧的“不允许因轮数/输出上限停止”文案；也不要因旧 CE05「代码开发」返工文字回退当前阶段。
- Claude 可用时，Claude + GPT/Codex 一致通过即可推进；Claude 掉线、没额度、限流或 CLI 不可用后，由 GPT/Codex + Gemini 有效成员共识推进。
- Gemini 在 Claude 可用时只因可复验证的安全风险、secret 泄露、路径或权限错误、数据破坏、原项目污染、不可逆操作风险阻断。
- 当前文档体系已收敛为本文件 + `NOE_PHASE9_DOCS_VERIFY.mjs`；不恢复已删除的冗余阶段 9 文档，避免双源漂移。纠偏详情见 `NOE_STAGE9_SUPERVISOR_CORRECTION.md`。

---

## 1. 使用说明（README）

### 1.1 启动

```bash
cd "/Users/hxx/Desktop/Neo 贾维斯"
# 必须用 Node 22.x（见 §5.1 原因）
/Users/hxx/.nvm/versions/node/v22.22.2/bin/node server.js
# 或 nvm use 22 后：npm start
```

- 监听 `127.0.0.1:51835`（仅本机）。
- 首次启动自动在 `~/.noe-panel/` 生成 `panel.db`（数据库）与 `owner-token.txt`（鉴权 token，权限 `0o600`）。
- 浏览器打开：`http://127.0.0.1:51835/?t=<owner-token>`，token 取自 `~/.noe-panel/owner-token.txt`。

### 1.2 Brain UI Lite 主路径（用户视角）

1. 打开面板（带 `?t=` token）→ 标题为 **Noe**。
2. 点顶栏 **◉ Brain** 按钮（`#btnNoeBrain`）→ 展开 Noe Brain 面板（`#noeBrainArea`，默认隐藏）。
3. 面板内可见：
   - **Health** = `ok`（`#noeHealthStatus`）。
   - **Loop** 状态：默认 `stopped` / `enabled=false`（不自动跑、不烧额度）。
   - **Memory**：写记忆 → 关键词召回命中（`#noeMemoryList`）。
   - **Focus Stack**：推入焦点深度 +1；Pop（默认 `absorb=true`）深度回退并把焦点吸收为 `scope=focus` 记忆。
   - **Thought Stream**：点 Tick 后出现 `noe_loop_tick` 事件（`acted=false`，零额度）。
   - **Tools**：默认 `0/0`（无已启用工具，绝不裸执行）。
4. 鉴权：所有 `/api/noe/*` 调用都需带 `X-Panel-Owner-Token: <owner-token>`（前端自动从 sessionStorage 注入）；无 token → `401 owner token required`。

### 1.3 鉴权 token 速查

- 文件：`~/.noe-panel/owner-token.txt`（32 字节随机 hex，`0o600`）。
- HTTP 头：`X-Panel-Owner-Token`；页面首开可用 `?t=<token>` 查询参数。
- 校验入口：`src/server/auth/owner-token.js` 的 `requireOwnerToken`（timing-safe 比对）。

---

## 2. 系统架构与接线（维护者视角）

- **范式**：全 in-process，挂在既有 `server.js` 单进程内；**加法不改存量**——0 改原有 17 张表、0 改原有路由域。
- **分层**：前端新 tab（Brain UI Lite）→ `/api/noe/*` 路由 → 领域层（`src/loop` / `src/memory` / `src/capabilities`）→ 存储层（`panel.db`）。
- **接线位置**：`server.js:1623-1650` 装配并 `registerNoeRoutes`：

| 组件 | 文件 | 在 server.js 的注入 |
|---|---|---|
| MemoryCore | `src/memory/MemoryCore.js` | `new MemoryCore()` |
| FocusStack | `src/memory/FocusStack.js` | `new FocusStack({ memory })` |
| ToolRegistry | `src/capabilities/ToolRegistry.js` | `new ToolRegistry({ permission, audit })`（**未传 handlers** → 见 §6） |
| NoeLoop | `src/loop/NoeLoop.js` | `new NoeLoop({ memory, focus, budget, audit, broadcast, clusterBusy })`（**未传 tickHandler/actHandler** → 零额度） |
| Noe 路由 | `src/server/routes/noe.js` | `registerNoeRoutes(app, { loop, memory, focus, toolRegistry, approvalStore })` |
| Brain UI Lite | `public/index.html` / `public/main.js` / `public/src/web/brain-ui.js` | 顶栏 `#btnNoeBrain` → `#noeBrainArea` |

- **实时**：NoeLoop tick 经 `broadcast` 推 `noe_event` / `noe_loop_tick` 到 `/ws/global`（WebSocket）。
- **集群让路**：`clusterBusy()` 读 `roomStore` 房间状态，有房间在跑时 NoeLoop 跳过 act（`skippedAct='cluster_busy'`）。
- **优雅停止**：进程退出/致命错误时 `noeLoop.stop()`（`server.js:4850 / 4896`）。

---

## 3. 数据模型（schema migration v2）

迁移定义在 `src/storage/SqliteStore.js`（`SCHEMA_MIGRATIONS` 的 `version: 2`，事务 + 自动 `.bak` 备份）。新增 4 个对象，0 改存量表：

| 表 / 虚表 | 用途 | 关键列 |
|---|---|---|
| `noe_memory` | 长期记忆 | `id, project_id, scope, title, body, source_type, source_id, tags, hidden, hit_count, last_hit_at, created_at, updated_at` |
| `noe_memory_fts` | 关键词召回（FTS5，`tokenize='trigram'`，不支持 trigram 时降级为默认分词；触发器同步） | 影子表 `content='noe_memory'` |
| `noe_focus_stack` | 焦点栈 | `id, project_id, title, summary, state, depth, hit_count, absorbed_memory_id, compressed_summary, popped_at` |
| `noe_tools` | 工具 manifest 注册表（默认 `enabled=0`） | `id, name, description, version, category, risk_level, enabled, manifest` |

- 记忆召回：有 query 且 FTS5 可用 → `bm25` 排序；否则降级 `LIKE`（`MemoryCore.#recallFts` / `#recallLike`）。
- 向量/embedding 召回：**暂未接入**（复用既有 `embeddings` 表的设计保留，recall 尚未走向量；见 §6）。

---

## 4. API 参考（`/api/noe/*`，全部需 owner-token）

> 与 `src/server/routes/noe.js` 逐条对齐；`NOE_PHASE9_DOCS_VERIFY.mjs`（C2）会做「文档端点集合 == 路由文件端点集合」的双向防幻觉校验（漏写/幻觉都 FAIL；实测 real=18==doc=18）。

| 方法 | 路径 | 作用 | 关键返回 |
|---|---|---|---|
| GET | /api/noe/loop/status | 读 loop 状态 | `{ ok, status }` |
| POST | /api/noe/loop/start | 启动 loop（可带 `actMode`） | `{ ok, status }` |
| POST | /api/noe/loop/stop | 停止 loop | `{ ok, status }` |
| POST | /api/noe/loop/pause | 暂停 loop | `{ ok, status }` |
| POST | /api/noe/loop/resume | 恢复 loop | `{ ok, status }` |
| POST | /api/noe/loop/tick | 手动触发一次 tick（默认 `force:true`，`acted=false` 零额度） | `{ ok, eventId, event, status }` |
| GET | /api/noe/memory | 召回记忆（`q/project/scope/limit`） | `{ ok, count, items }` |
| POST | /api/noe/memory | 写记忆（`body` 必填） | `201 { ok, item }` |
| DELETE | /api/noe/memory/:id | 软隐藏记忆（`hidden=1`） | `{ ok }` / `404` |
| GET | /api/noe/focus | 列焦点栈（`project/state/limit`） | `{ ok, count, items }` |
| POST | /api/noe/focus | 推入焦点（`title` 必填） | `201 { ok, item }` |
| POST | /api/noe/focus/:id/pop | 弹出焦点（`absorb` 默认 true → 写 scope=focus 记忆） | `{ ok, item }` / `404` |
| GET | /api/noe/tools | 列工具（`enabled` 过滤） | `{ ok, count, tools }` |
| POST | /api/noe/tools | 注册工具 manifest（默认 `enabled=0`） | `201 { ok, tool }` |
| POST | /api/noe/tools/:id/enable | 启用/停用工具 | `{ ok, tool }` / `404` |
| POST | /api/noe/tools/:id/invoke | 调用工具（经权限/审批链；无 handler → `501`） | `200/202/403/404/501` |
| GET | /api/noe/approvals | 列待审批（`status/type/limit`） | `{ ok, count, approvals }` |
| GET | /api/noe/health | 聚合健康（loop/memory/focus/tools/approvals） | `{ ok, loop, memory, focus, tools, approvals, health }` |

错误码约定（`src/server/routes/noe.js` 的 `sendError`）：消息含 `required/invalid/must be/missing` → `400`，其余 → `500`。

工具调用安全链（`ToolRegistry.invoke`）：未找到 `404` → 未启用 `403`（审计 `noe.tool.blocked`）→ 权限 `deny` 则 `403` / `ask` 则 `202 approval_required` → 无 handler `501`。**即使工具被启用且权限放行，没注册 handler 也绝不裸执行命令**。

---

## 5. 维护说明

### 5.1 Node 版本（硬约束 BLK-1）

- **必须 Node 22.x**。`better-sqlite3` 是原生模块，Node 26（ABI 147）与预编译 ABI（127）不匹配，`node server.js` 会因 `NODE_MODULE_VERSION` 报错起不来。
- 本机已验证可用解释器：`/Users/hxx/.nvm/versions/node/v22.22.2/bin/node`。
- 详细排障：`NOE_NODE_VERSION_RUNBOOK.md`。

### 5.2 验证门（可复跑，阶段 9 维护者交接核心）

| 命令（前缀 `N22=/Users/hxx/.nvm/versions/node/v22.22.2/bin/node`） | 验什么 |
|---|---|
| `$N22 NOE_PHASE2_SECRET_GATE.mjs` | 全部 `.md` 交付物无真实密钥（退出码 0） |
| `$N22 node_modules/vitest/vitest.mjs run tests/unit/routes/noe-routes.test.js tests/unit/noe-memory-focus.test.js tests/unit/noe-loop-toolregistry.test.js` | Noe 核心单测 |
| `$N22 NOE_PHASE6_VERIFY.mjs` | 单元测试阶段门 |
| `$N22 NOE_M1_ISOLATION_SMOKE.mjs` | 51835 真启停 + 51735 零影响 |
| `$N22 NOE_PHASE7_INTEGRATION_SMOKE.mjs` | HTTP→SQLite→Memory/Focus/Loop/Tool + WS 端到端 |
| `$N22 NOE_PHASE8_FUNCTIONAL_VERIFY.mjs` | 真浏览器跑 Brain UI 用户主路径 + 截图 |
| `$N22 NOE_PHASE9_DOCS_VERIFY.mjs` | 本文档与磁盘一致 / API 无幻觉 / 无明文密钥 |

> secret 门 WARN 人工复核结论（建议#2，2026-06-02 实测）：当前 4 处裸 UUID **全部良性，非真实凭据**——`58995ce1…`／`b23745a4…` 为集群房间 ID（公开标识），`5809ccc9…`（出现 2 次）为**公开** LemonSqueezy checkout URL 内的 UUID；真实 LS API token 存于 `~/.noe-panel/lemonsqueezy-key.txt`（0o600），从不写入任何 `.md`。故 WARN 不阻断、无需脱敏。
> 监督纠偏验证：`NOE_PHASE9_DOCS_VERIFY.mjs` 还会检查 `NOE_STAGE9_SUPERVISOR_CORRECTION.md`、README 和两个交接入口是否包含“最多讨论 3 轮”“GPT/Codex + Gemini”“不要因旧 CE05 返工文字回退”等锚点。

### 5.3 端口与数据隔离（务必保持）

- Noe = `51835`；原项目 = `51735`；测试用独立端口（如 51836）+ 临时 `PANEL_DB_PATH`/`HOME`，**生产 `~/.noe-panel/panel.db` 与 51735 全程零扰动**。
- 改 schema：只在 `SqliteStore.js` 的 `SCHEMA_MIGRATIONS` 追加新 `version`，框架自动事务 + `.bak`，禁止手改存量表。

### 5.4 安全地新增一个工具（manifest-only 范式）

1. `POST /api/noe/tools` 注册 manifest（`id`/`name` 必填，`risk_level ∈ {low,medium,high,critical}`）；落库后默认 `enabled=0`。
2. `POST /api/noe/tools/:id/enable` 显式启用。
3. 在 server.js 给 `ToolRegistry` 注入对应 `handlers[toolId]`（当前未注入，见 §6）——**接入真实执行前必须先审计**（红线）。
4. 调用必过 `PermissionGovernance` + `ApprovalStore` + `ActivityLog`（危险模式检测 + 审批 + 审计留痕）。

---

## 6. 已知限制（交接者必读，避免误判为缺陷）

1. **NoeLoop 默认零额度**：server.js 接线未传 `tickHandler`/`actHandler`，tick 只记录 `noe_loop_tick` 事件、不调用任何 LLM；`acted=false`。这是「默认不烧 token」的安全设计，不是 bug。要真做事须显式实现 handler 并经预算门。
2. **工具不会真执行**：`ToolRegistry` 接线未传 `handlers`，即便工具被启用且权限放行，`invoke` 也返回 `501 tool handler not registered`。真实工具执行属 P2，**未审计不接入**。
3. **Voice / Social I/O / 工具市场** = **P2，未实现**。Brain UI Lite 不含语音/社交 tab。
4. **记忆向量召回未接入**：当前只有 FTS5（trigram）/ LIKE 关键词召回；embedding/语义召回保留设计未落地。
5. **FTS5 trigram 依赖 SQLite 构建**：不支持 trigram 时自动降级默认分词；recall 异常时再降级 LIKE。
6. **Node 26 不可用**：见 §5.1，必须 Node 22.x。
7. **迁移回滚**：仅有自动 `.bak` 备份 + git revert，无在线降级脚本。
8. **既有 `tests/e2e/noe-brain-ui.e2e.mjs` 跑不起来**：依赖未安装的 `@playwright/test` 且选择器用了不存在的连字符 ID；功能验证以 `NOE_PHASE8_FUNCTIONAL_VERIFY.mjs`（playwright core）为准，旧 e2e 建议后续修复或标废弃。

---

## 7. 变更说明（Noe 子系统 Changelog）

- **M1 Memory Core**：`MemoryCore`（write/get/hide/recall/stats，FTS5+LIKE 双路召回、软隐藏、项目隔离、hit 计数）；`FocusStack`（push/pop/list/peek/depth，pop 默认吸收为记忆）。
- **M2 NoeLoop**：状态机（stopped/idle/ticking/paused/paused_budget/error）+ 重入锁 + 超时 watchdog + 连续 3 次错误自动熔断 + 预算门让路 + clusterBusy 让路 + 默认 disabled 零额度。
- **M-R Noe 路由**：18 个 `/api/noe/*` 端点，每条首层 `requireOwnerToken`。
- **M4 Brain UI Lite**：顶栏 ◉ Brain → 只读面板（Health/Loop/Memory/Focus/Thought Stream/Tools），WS 实时刷新。
- **M5 ToolRegistry 安全门**：manifest 校验（Ajv）+ 默认禁用 + 权限/审批/审计链 + 危险模式检测 + 无 handler 绝不裸执行。
- **schema v2**：新增 `noe_memory` / `noe_memory_fts` / `noe_focus_stack` / `noe_tools`，0 改存量。

> 详细每阶段记录：`NOE_PHASE5_CODE_DEVELOPMENT.md`、`NOE_PHASE6_UNIT_TESTS.md`、`NOE_PHASE7_INTEGRATION_TESTS.md`、`NOE_PHASE8_FUNCTIONAL_VERIFICATION.md`。

---

## 8. 交接信息 / 下一步（下一位执行者直接照做）

### 8.1 接手三步

1. 切 Node 22.x（`nvm use 22` 或用 §5.1 的解释器路径）。
2. 先读 `NOE_STAGE9_SUPERVISOR_CORRECTION.md`，确认当前阶段不因旧 CE05 返工文字回退。
3. 跑 §5.2 验证门确认现状全绿（先 `NOE_M1_ISOLATION_SMOKE.mjs` 确认隔离，再单测，再 `NOE_PHASE9_DOCS_VERIFY.mjs`）。
   - **阶段 9 验收前置门（建议#3）** = `NOE_PHASE9_DOCS_VERIFY.mjs`（文档↔磁盘一致 9/9）**＋** `NOE_PHASE8_FUNCTIONAL_VERIFY.mjs`（用户主路径浏览器实跑）；两者都 EXIT=0 才进阶段 10「交付验收」。
4. 读本文件 §2/§3/§4 拿到架构、schema、API 全貌。

### 8.2 后续路线（按优先级串行，P0/P1 未稳不抢 P2）

- 接 NoeLoop 的真实 `tickHandler`/`actHandler`（经预算门）。
- 接记忆向量召回（embedding）。
- 给 ToolRegistry 注入受审计的 `handlers`（先审计后接入）。
- 再做 Voice / Social / Jarvis 体验（P2）。

### 8.3 不要做（红线）

- 不在原项目目录 `/Users/hxx/Desktop/00_项目/05_Claude可视化面板` 内开发。
- 不全量复制 BaiLongma 进 Noe；镜像保持只读。
- 不在未审计时接入工具真实执行能力。
- 不动 51735；不改存量 17 张表；不在交付物里写明文密钥。

---

## 9. 工程闭环 11 阶段衔接

1. 用户想法 → 2. 需求分析与拆解 → 3. 技术方案设计 → 4. 任务分配与排期 → 5. 代码开发 → 6. 单元测试 → 7. 集成测试 → 8. 功能验证 → **9. 文档编写（本阶段：沉淀使用/维护/已知限制/交接，机读门 `NOE_PHASE9_DOCS_VERIFY.mjs`）** → 10. 交付验收（以各阶段 VERIFY 退出码为门）→ 11. 复盘优化（P2 准入、向量召回、工具 handler）。

承上：本文档引用阶段 5–8 的真实落地（模块 / 单测 / 集成 / 功能截图）。
启下：阶段 10 可直接以 §5.2 验证门作为验收清单；阶段 11 复盘聚焦 §6 已知限制与 §8.2 路线。
