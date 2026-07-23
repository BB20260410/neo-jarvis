# Noe / Neo 贾维斯 — 阶段 2「需求分析与拆解」交付物（Claude / xike-builder · 本轮独立稿）

> **本文件定位**：CE02 需求分析与拆解阶段的四项交付物（需求清单 / 验收标准 / 依赖关系 / 缺口问题）。
> **事实源继承**：目标/边界/红线唯一以 `NOE_PHASE1_目标契约_CANONICAL.md`（冻结哈希 `b9c4f84c…`）为准；BaiLongma 事实以只读镜像 `BaiLongma-audit/`（提交 `de78c6f`）+ 阶段 2 待复核草稿 `NOE_BAILONGMA_ARCH_AUDIT.md` 为参考。
> **防覆盖战（继承 R7/T3 教训）**：本稿为成员域独立稿，**不覆盖** `NOE_BAILONGMA_ARCH_AUDIT.md`、`NOE_PHASE1_目标契约_CANONICAL.md`、他人成员稿。集群达成一致后，建议收敛为单一 `NOE_PHASE2_REQUIREMENTS_CANONICAL.md`，收敛前各成员稿互不 write_file 覆盖。
> 生成时间：2026-06-01（CST） · 阶段：2. 需求分析与拆解 · 工作区：`/Users/hxx/Desktop/Neo 贾维斯`

---

## 0. 只读复核结论（先复核审计稿，再拆需求 — 质量门硬要求）

进入需求拆解前，按 CE01 共识与质量门要求，先对 `NOE_BAILONGMA_ARCH_AUDIT.md` 草稿做**逐项实证复核**（不覆盖、只读），把「草稿描述」升级为「镜像实证」，避免把推断当事实写进 Noe 需求。本轮实测证据：

| 复核项 | 审计稿声称 | 镜像实证（本轮命令） | 结论 |
|---|---|---|---|
| `merged_into` 字段 | §2.12 memories 表含 `merged_into` | `BaiLongma-audit/src/db.js:53` `ALTER TABLE memories ADD COLUMN merged_into TEXT`；db.js:199 幂等兜底 | ✅ 一致 |
| `memories_fts` trigram | §2.12 FTS5 + trigram 中文搜索 | `db.js:142-145` `CREATE VIRTUAL TABLE memories_fts USING fts5(... tokenize='trigram')` | ✅ 一致 |
| `focus_absorbed` | §2.12 conversations 焦点吸收标记 | `db.js:115` `ALTER TABLE conversations ADD COLUMN focus_absorbed INTEGER NOT NULL DEFAULT 0` | ✅ 一致 |
| `embedding BLOB` | §2.12 向量语义召回 | `db.js:134` `embedding BLOB`；db.js:185 幂等迁移 | ✅ 一致 |
| Focus Stack 持久化 | §2.4 重启从 db 恢复焦点栈 | `src/index.js:190` `focusStack: loadFocusStack()`；`saveFocusStack()` 多处 | ✅ 一致 |
| TICK loop 入口 | §2.4 `startConsciousnessLoop`/`onTick` | `src/index.js` 含 `onTick` finally / `compressPoppedFrame` import | ✅ 一致 |
| 13+ 模块实存 | §2.5–§2.11 memory/context/brain-ui/voice/social/marketplace | `find src` 命中 memory(17)/context(1)/brain-ui(16)/voice(3)/social(9)/marketplace(1) | ✅ 一致 |
| 明文密钥 | §7 `config.json:9` 明文 `doubaoKey` | 第 2 轮复核确认：审计稿当前为 `<REDACTED>`；上一轮曾被指出存在未脱敏值，已按 secret 卫生问题处理，不在阶段 2 报告中复述原值；镜像只读原值仅作为审计事实，不搬入 Noe | ✅ 当前已脱敏（红线已登记） |

**Noe 自身基线实证**（决定需求是否需新依赖 / 桥接落点）：
- `noe@2.1.0`，`type:module`；`better-sqlite3`✅ 已是依赖、`ws`✅ 已是依赖 → **Memory Core 不需新增 DB/WS 依赖**（去掉一条「不 npm install」阻断）。
- 已有子系统：`src/{storage,embeddings,context,state,room,governance,safety,security,permissions,budget,cost,...}` → Memory Core 桥接层、NoeLoop 预算闸门、工具权限门**均有现成落点**。
- 数据目录 `.noe-panel`（`server.js` 5 处引用）= Noe 自有存储根，Memory Core 落盘目标。

> 复核裁定：审计稿 §2/§3 关于 schema 与模块的描述**经镜像逐项核对属实**，可作为需求拆解的输入。剩余 T2（审计稿卫生 advisory）属阶段 2「逐章复核」收尾，不阻塞本需求拆解。本稿**未修改**审计稿（SHA 实测 `1e55a743…`，与 T3 基线 `1fa04463…` 不同 = 期间被他人并发覆盖，符合 T3 预判；本稿只读取、不参与覆盖）。

---

## 1. 需求清单

### 1.1 用户需求（UR · 源自 canonical §1/§2，每条可回溯）

| ID | 用户需求 | 来源 |
|---|---|---|
| UR-1 | Noe 成为**唯一长期演进的主产品底座**（本地优先多模型 AI 工程执行助手），不退回维护原 Xike Lab、不被改造成 BaiLongma | canonical §1/§2 |
| UR-2 | 在**只读审计 BaiLongma 之后**，分阶段、模块化吸收其 TICK loop / Memory / Focus Stack / Brain UI / Voice / Social / 工具市场思路 | canonical §1/§3.1 |
| UR-3 | 全程**不污染原项目**（`05_Claude可视化面板`，端口 51735），不占其端口、不并行常驻第二服务 | canonical §3 |
| UR-4 | **不硬拼、不全量复制、不搬任何密钥**；吸收只搬架构/思路/可移植代码 | canonical §3 红线 |
| UR-5 | 围绕 Noe 自己的端口 51835 / 数据目录 / owner-token 安全模型 / 集群协同体系开发 | canonical §2 |
| UR-6 | 让用户**看得见 AI 在想什么**（Jarvis 体验），且后台 loop 不抢用户任务、不烧模型额度 | canonical §3.1 A2 / M4 |

### 1.2 功能需求（FR · 6 条需求线 ↔ 里程碑 M0–M5）

> 每条 FR 拆为可独立验收的子项；优先级 P0（MVP 必须）/ P1（核心增强）/ P2（延后）见 §4。

**FR-AUDIT｜需求线 1 = 审计逐章复核（↔ M0）· P0**
- FR-AUDIT-1：逐章核对 `NOE_BAILONGMA_ARCH_AUDIT.md` 声称的模块/依赖/schema 与镜像 `de78c6f` 真实文件一致，标注行号证据。
- FR-AUDIT-2：完成 T2 审计稿卫生 advisory 收口（修复或标注 accepted）。
- FR-AUDIT-3：锁定 BaiLongma「吸收/延后/拒绝」三分类（canonical §3.1）为阶段 2 最终决策，不再是初判。

**FR-ISO｜需求线 2 = 端口 + 数据目录隔离启动验证（↔ M1）· P0**
- FR-ISO-1：Noe `npm start` 真实起在 51835 并 LISTEN（PID 自校验）。
- FR-ISO-2：启动期间原项目 51735（PID 13768）进程/端口/cwd 三采样不变。
- FR-ISO-3：Noe 数据落 `~/.noe-panel`，与原项目数据目录物理隔离、无交叉写。
- FR-ISO-4：owner-token 守卫对未授权请求返 401。

**FR-LOOP｜需求线 3 = NoeLoop 最小闭环（↔ M2）· P1**
- FR-LOOP-1：自研最小 TICK 闭环，可启/停/查状态（不搬 BaiLongma `startConsciousnessLoop` 代码）。
- FR-LOOP-2：默认**空跑/受控模式**，不接真实付费 LLM；接 LLM 须过 `src/budget` 预算闸门。
- FR-LOOP-3：loop 不抢占用户在执行的任务、不打断集群协同（与现有 room/agents 协调）。
- FR-LOOP-4：tick 间隔、最大 tick 数、预算上限可配置，超限自动停。

**FR-MEM｜需求线 4 = Memory Core（↔ M3）· P1**
- FR-MEM-1：记忆**写入**（recognizer 思路）—交互中提取记忆落 Noe 自有存储，复用 `better-sqlite3`。
- FR-MEM-2：记忆**召回**—FTS5(trigram 中文) + 可选 embedding 双路，注入上下文（injector 思路）。
- FR-MEM-3：Focus Stack 桥接—注意力焦点栈持久化 + 旧焦点压缩成结论沉淀（focus-compress 思路）。
- FR-MEM-4：**桥接层而非整库迁移**—落到 Noe 自己的分层数据模型，与现有 `src/embeddings`/`src/state`/Evidence/AgentRun/ActivityLog 不冲突。
- FR-MEM-5：记忆软删除/可见性（visibility/hidden_at）与合并链路（merged_into）语义保留。

**FR-UI｜需求线 5 = Brain UI Lite（↔ M4）· P2→P1**
- FR-UI-1：轻量「思维流」可视化（thought-stream 思路），展示 NoeLoop tick / 记忆召回，**只读不可执行**。
- FR-UI-2：复用 Noe 现有前端约定（toast/Modal、IIFE+ES module 渐进迁移），不整页移植 d3 Brain UI。
- FR-UI-3：不破坏现有路由/状态/视觉（不回归现有面板）。

**FR-EXP｜需求线 6 = Voice / Social / 工具市场 / Jarvis 体验（↔ M5+）· P2 延后**
- FR-EXP-1（Voice）：本机 ASR/TTS，延后；移植前评估 Python/whisper 运行时与隐私。
- FR-EXP-2（Social I/O）：微信/Discord/webhook 对外发布，延后 + **独立安全评审**（触发用户红线「对外发布」）。
- FR-EXP-3（工具市场）：marketplace 工具加载执行，延后 + **强制先审计**，未审计前一律不接 exec/fetch/file-write。
- FR-EXP-4（密钥）：BaiLongma `config.json` 任何明文密钥 = **拒绝进 Noe**；Noe 凭据走自有安全存储。

### 1.3 非功能需求（NFR · 横切，全期适用）

| ID | 非功能需求 | 口径来源 |
|---|---|---|
| NFR-SEC-1 | 本地优先：仅 `127.0.0.1` 监听，不对外暴露 | canonical §3 / CLAUDE.md |
| NFR-SEC-2 | 复用既有安全护栏：Origin 白名单 / `safeResolveFsPath` 路径沙箱 / body length cap / owner-token | CLAUDE.md 安全护栏 |
| NFR-SEC-3 | **secret 红线**：不搬任何 BaiLongma 密钥；commit/push 前 `git diff` 自查防 secret 入库；`BaiLongma-audit/` 已在 `.gitignore` | canonical §3 / 审计稿 §7 |
| NFR-COST-1 | 不烧用户额度：后台 loop 默认不接付费 API；接 LLM 必过预算闸门 | canonical §5 A2 |
| NFR-ISO-1 | 不修改/不占用原项目目录与 51735 端口；不并行常驻第二服务 | canonical §3 |
| NFR-REV-1 | 可逆性：禁止无关 `git checkout/restore/clean`；改 server.js 后告知「需重启」不自主重启 | canonical §5 R5 / CLAUDE.md |
| NFR-DEP-1 | 不新增依赖除非诊断明列且用户同意（Memory Core 已确认无需新增 DB/WS 依赖） | CLAUDE.md |
| NFR-PERF-1 | embedding / FTS5 资源消耗可控，不显著拖慢现有面板启动/响应 | canonical §6 / 审计稿 §6 |
| NFR-TEST-1 | 每模块有窄单测 + 集群回归 smoke 不回归（既有 68/68） | CLAUDE.md 测试 |
| NFR-RT-1 | Node 22+ 运行；PTY/打包异常回退 Node 22/24 复测 | CLAUDE.md |

---

## 2. 验收标准（每条需求一条可验证口径 + 复现命令 — 完成门槛）

> 门槛=「每条需求都有可验证验收口径」。下表给出**命令级/证据级**验收，避免「报告≠实际」。

| 需求 | 验收口径（PASS 条件） | 复现命令 / 证据 |
|---|---|---|
| FR-AUDIT-1 | 审计稿每个被引模块都有「镜像行号/`git cat-file` 命中」标注，复核记录回写审计稿对应小节 | `git -C BaiLongma-audit cat-file -e de78c6f:src/memory/recognizer.js`；本稿 §0 表已含 8 项实证 |
| FR-AUDIT-2 | `NOE_PHASE1_VERIFY.mjs` C8 `待修=` 清空，或 `NOE_PHASE2_ENTRY_TODO.md` T2 标注 accepted | `node NOE_PHASE1_VERIFY.mjs` |
| FR-AUDIT-3 | §3.1 三分类表每行带阶段 2 复核裁定（吸收/延后/拒绝 + 依据），无「初判」残留 | `grep -nE '吸收\|延后\|拒绝' NOE_BAILONGMA_ARCH_AUDIT.md` |
| FR-ISO-1/2/3/4 | M1 三证据：51835 LISTEN(PID 自校验) + 51735 PID13768 起测前/中/后不变 + `~/.noe-panel` 隔离 + owner-token 401 | `node NOE_M1_ISOLATION_SMOKE.mjs`（现 8/8）+ `lsof -nP -iTCP:51835,51735 -sTCP:LISTEN` |
| FR-LOOP-1 | NoeLoop 有 start/stop/status 接口或 CLI，启停幂等、状态可查 | 窄单测：start→status=running→stop→status=stopped |
| FR-LOOP-2 | 默认模式下抓不到真实付费 API 调用；接 LLM 路径必经 `src/budget` 校验 | 单测 mock LLM + 断言预算闸门被调用；grep loop 代码无直连付费 client |
| FR-LOOP-3 | loop 运行期间用户任务队列 / room 协同状态不被抢占（计数/锁断言） | 集成测：loop on 时跑一次用户任务，断言无中断 |
| FR-LOOP-4 | tick 间隔/最大 tick/预算上限可配；超限自动停（status=stopped, reason=budget/limit） | 单测：设 max_tick=2 → 跑满自动停 |
| FR-MEM-1 | 写入记忆后 DB 行数 +1，字段（content/timestamp/source_ref）正确 | 窄单测：insert → `SELECT count(*)` 断言 |
| FR-MEM-2 | 给定关键词召回命中（中文走 trigram，≥3 字符 FTS5 / 2 字符 LIKE fallback） | 窄单测：写「咖啡店」记忆 → 搜「咖啡」命中 |
| FR-MEM-3 | Focus Stack push/pop 持久化，pop 旧帧生成结论沉淀长期记忆 | 窄单测：push 2 帧 → 重启 load 恢复 → pop 生成 conclusion |
| FR-MEM-4 | Memory 表/接口与现有 `src/embeddings`/`src/state` 无命名/schema 冲突，现有单测全绿 | `npm test` 不回归 + schema diff 审查 |
| FR-MEM-5 | 软删除记忆默认不召回（visibility 过滤）；merged_into 链路可追踪 | 单测：hide → 召回不含；merge → keep 端可溯源 |
| FR-UI-1/2/3 | Brain UI Lite 页面可见、展示 tick/召回、纯只读；现有面板 smoke 不回归 | `node .s18-7-panel-smoke.mjs` + 手动/Playwright 截图 |
| FR-EXP-* | 每项延后能力进场前有独立安全评审记录；未审计工具执行能力一律 401/拒绝 | 评审文档存在 + 权限门单测 |
| NFR-SEC-1/2/3 | 仅 127.0.0.1；既有护栏单测绿；`git diff` 无 secret；`BaiLongma-audit/` 在 `.gitignore` | `node .s18-2-routes-smoke.mjs` + `git check-ignore BaiLongma-audit` |
| NFR-COST-1 | 默认配置下无真实付费 API 出网调用 | 默认跑 loop 抓不到付费 endpoint 请求 |
| NFR-ISO-1 | 原项目目录 0 改动、51735 0 占用 | `git -C "/Users/hxx/Desktop/00_项目/05_Claude可视化面板" status` 不变（只读检查） |
| NFR-TEST-1 | 集群回归 smoke 68/68 不回归 | `node .s18-2-routes-smoke.mjs && node .s18-7-panel-smoke.mjs && node .s18-2a-webhook-test.mjs` |

---

## 3. 依赖关系（DAG · 决定排期串行顺序）

```
UR-1..6（目标）
   │
   ▼
FR-AUDIT (M0) ──┐  审计复核是一切吸收的前置（红线：审计完成前不接工具执行）
                │
                ▼
FR-ISO (M1) ────┤  端口/数据目录隔离 = 任何 Noe 侧启动型验证的前置（R8 门槛）
                │
        ┌───────┴────────┐
        ▼                ▼
   FR-LOOP (M2)     FR-MEM (M3)   ← M2、M3 都依赖 M1 起得来；二者可并行设计，
        │                │          但 M3 召回要喂给 M2 上下文 → M3 接口需 M2 之前/同期定
        └───────┬────────┘
                ▼
          FR-UI (M4)  ← 依赖 M2(有 tick 可视) + M3(有记忆可视)，否则无内容可展
                │
                ▼
        FR-EXP (M5+)  ← 依赖 M0 审计裁定(三分类) + 各自独立安全评审；Voice/Social/工具市场互相独立
```

**关键依赖与约束**：
- D-1：`FR-EXP-3`(工具市场) / 任何 exec 能力 **严格依赖** `FR-AUDIT` 完成（canonical 红线：审计完成前不接工具执行能力）。
- D-2：`FR-LOOP-2` 依赖现有 `src/budget` 预算闸门可用（已存在子系统，需确认接口）。
- D-3：`FR-MEM-4` 依赖现有 `src/embeddings`/`src/state`/storage 数据模型摸清（技术方案设计阶段先出 schema diff）。
- D-4：`FR-UI-1` 依赖 M2/M3 至少各出最小可视数据源。
- D-5：横切 NFR（安全/成本/隔离）**贯穿每个 FR 的验收**，不单独排期但每里程碑必检。
- D-6：`FR-EXP-2`(Social 对外发布) 触发用户红线，必须用户显式审批 + 独立安全评审，**不随里程碑自动推进**。

---

## 4. 优先级

| 优先级 | 需求 | 理由 |
|---|---|---|
| **P0（MVP 地基，必须先做）** | FR-AUDIT(M0)、FR-ISO(M1)、全部 NFR | 审计复核 + 隔离启动是后续一切的前置；安全/隔离是红线 |
| **P1（核心闭环）** | FR-LOOP(M2)、FR-MEM(M3) | NoeLoop+Memory 是「本地优先 AI 助手 + 看得见在想什么」的最小价值核 |
| **P1→可视化** | FR-UI(M4) | 有 loop/memory 后才有内容可视；Jarvis 体验关键但依赖前两者 |
| **P2（延后 + 独立评审）** | FR-EXP(M5+：Voice/Social/工具市场) | 高权限/对外/隐私风险，非 MVP，逐个独立验收 |

---

## 5. 缺口问题（待「技术方案设计」阶段裁定 — 不在本阶段决策）

| ID | 缺口问题 | 影响需求 | 建议处理阶段 |
|---|---|---|---|
| Q-1 | Memory Core 落地形态：**新建独立 SQLite 库** vs **并入 Noe 现有存储**？现有 `src/storage`/`src/state`/`src/embeddings` 的 schema 与接口需先摸清 | FR-MEM-4 | 阶段 3 技术方案（先出 schema diff） |
| Q-2 | NoeLoop 是 server.js 内嵌进程 vs 独立可启停子模块？如何保证「不并行常驻第二服务」(NFR-ISO-1) 同时能后台 tick？ | FR-LOOP-1/3 | 阶段 3 技术方案 |
| Q-3 | 预算闸门 `src/budget` 现有接口能否直接挂 NoeLoop 的 LLM 调用？需读其 API | FR-LOOP-2 | 阶段 3（读 `src/budget`） |
| Q-4 | embedding 召回是否本期启用？启用则 embedding 由谁产生（本地模型 vs 付费 API，后者触发 NFR-COST-1） | FR-MEM-2 | 阶段 3（默认先只上 FTS5，embedding 延后） |
| Q-5 | Brain UI Lite 挂在现有面板的哪个 tab/路由？复用 IIFE 还是新 ES module？ | FR-UI-2 | 阶段 3 + 阶段 5 开发 |
| Q-6 | 「集群协同体系」与 NoeLoop 后台 tick 是否会互相触发 / 抢 LLM？两者协调协议未定 | FR-LOOP-3 | 阶段 3 技术方案 |
| Q-7 | T2（审计稿卫生 advisory）是修复还是 accepted？需用户/集群拍板 | FR-AUDIT-2 | 阶段 2 收尾 |
| Q-8 | Voice 的 whisper Python 运行时是否允许进 Noe（带 Python 依赖）？ | FR-EXP-1 | 阶段 5+ 独立评审 |

---

## 6. 与工程闭环 11 阶段衔接（本阶段定位 + 上下游）

- **承上（阶段 1 用户想法）**：继承 canonical §1–§5 的目标/边界/红线/风险，逐条转译为 UR/FR/NFR，无范围漂移（§1.1 每条 UR 标了来源）。
- **本阶段（阶段 2 需求分析与拆解）**：先只读复核审计稿（§0 八项实证），再拆出 6 条需求线 + NFR + 验收口径 + DAG + 优先级 + 缺口（§1–§5）。完成门槛「每条需求都有可验证验收口径」由 §2 命令级表兑现。
- **启下（阶段 3 技术方案设计）**：§5 八个缺口问题 = 阶段 3 的输入；阶段 3 须基于已复核审计设计 Noe 自己的 loop/memory/UI/工具权限/数据桥接，**不照搬**。
- **后续（4 排期 → 5 开发 → 6/7 测试 → 8 验证 → 9 文档 → 10 验收 → 11 复盘）**：按 M0→M5 串行，每里程碑用 §2 对应验收口径独立交付；Gemini 故障走 canonical §5 R6 降级。

---

## 修订记录
- 2026-06-01 · Claude/xike-builder · 创建阶段 2 需求拆解独立稿：先只读复核审计稿（§0 八项镜像实证，未覆盖审计稿），再拆 UR×6 / FR 六线 / NFR×10 / 验收口径表 / 依赖 DAG / 优先级 / 缺口×8。事实源继承 canonical，建议集群收敛为单一 `NOE_PHASE2_REQUIREMENTS_CANONICAL.md`。本轮未启动服务、未改产品代码/UI/schema、未碰原项目目录、未删改他人文件、未覆盖审计稿。
