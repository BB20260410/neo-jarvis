# DEEP_AUDIT 2026-06-21 v3 — Neo 贾维斯 全代码深挖 + BUG 表 + 后续发展

> **审计员**:Mavis 协调 4 个并行深挖式 audit worker
> **时间**:2026-06-21 23:04(对话续)
> **范围**:Neo v2.1.0 + P0-P5 全实现版(走完 owner 6 轮红队 + 5749 测全绿)
> **方法**:4 个 worker 并行覆盖 4 子系统栈,每个深挖 80-150 行关键段
> **总产出**:**208 条审计发现**(BUG 80 + 不足 85 + 可优化 43)
> **用户根本原则**:**「我们是开发者,要的就是不要设置限制,不要过度设置安全,我们要做的就是给 Neo 贾维斯最大的空间和自由的权限,让他成长」**

---

## 0. 一句话总览

**Neo 走完 P0-P5 自进化路线后,深挖式审计发现 80 个 BUG(P0:3 + P1:35 + P2:42)+ 85 个不足 + 43 个可优化。最高风险集中在 4 个数据/沙逃/注入 BUG(P0 级),后续 12 个月发展应聚焦"修 P0 + 修高 ROI P1 + P6-3 跨进程 + P6-1 完整 UI + 30 候选借鉴池接入"五条主线。**

---

## 1. 4 子系统栈审计汇总

| Worker | 子系统 | BUG | 不足 | 可优化 | 总条数 |
|---|---|---|---|---|---|
| **W1 自进化栈** | NoeSelfEvolution* / NoeLearningLoop / NoePatchTransaction / LoRA | **16**(P0:1, P1:7, P2:8) | 14 | 16 | **46** |
| **W2 认知记忆栈** | NoeWorkspace / NoeAffectEngine / NoeFocusStack / NoeKnowledgeGraph / MemoryCore | **10**(P0:0, P1:4, P2:6) | 36 | 5 | **51** |
| **W3 核心栈** | server.js 3130 / electron-main.js / SqliteStore / CrossVerify / VoiceSession | **21**(P0:2, P1:6, P2:13) | 21 | 8 | **50** |
| **W4 扩展栈** | Plugin / MCP / Skills / Files / PTY / CUA / Browser / Webhook / Watcher | **33**(P1:18, P2:15, info:0) | 14 | 14 | **61** |
| **总计** | - | **80** | **85** | **43** | **208** |

---

## 2. P0 BUG 表(3 条 · 必修 · 不增加 owner 约束)

### P0-1 · NoePreferenceCollector dedupKey 不是 embedding sim

- **证据**:`src/cognition/NoePreferenceCollector.js:62-70`
- **现状**:`dedupKey = ${prompt}${chosen}${rejected}` → `.toLowerCase().trim()`,纯字符串拼接
- **风险**:owner 任务说明明确要求"dedup by embedding sim",**实际是字符串拼接** → 语义相近偏好对全部通过入库 → **quarantine 库被语义重复样本灌爆**
- **影响**:**数据层** — DPO 训练数据被污染
- **修复**:注入 `embedText` 函数(项目已有 EmbeddingProvider),cosineSim > 0.92 视为重复;或先做 prompt 的 5-gram jaccard 拦截近似对
- **来源**:W1 自进化栈
- **工作量**:1-2 天

### P0-2 · `noe_kg_relation` 双时态迁移整表 drop 无备份

- **证据**:`src/memory/NoeKnowledgeGraph.js:125` → `ensureTemporalColumns` 命中 v1 UNIQUE 约束时调 `rebuildRelationTableDropUnique` 做 `DROP TABLE + RENAME` 整表重建
- **现状**:**不在 SqliteStore.runMigrations 框架内**,`backupDbOnce` 不会被触发 → 线上 v1 库升级时双时态迁移 drop 整张关系表
- **风险**:事务中途 OOM / SIGKILL → **实体关系全失无法回滚**(只有 SqliteStore 的 schema 迁移才自动 .bak)
- **影响**:**数据层** — 长跑后整库升级数据丢失
- **修复**:
  1. 把双时态迁移纳入 SqliteStore.runMigrations 框架
  2. 或在 `rebuildRelationTableDropUnique` 前显式 `backupDbOnce('kg_relation_v1')`
  3. 或改用 `ALTER TABLE` 兼容迁移,不 drop 整表
- **来源**:W3 核心栈
- **工作量**:1-2 天

### P0-3 · MCP `cfg.env` 完全覆盖 baseEnv + DENIED_COMMANDS 形同虚设

- **证据**:
  - `src/mcp/McpClientManager.js:36-42` — 用户 MCP 配置可注入任意 env
  - `src/mcp/McpStore.js:46` — `bash` / `python` / `node` 不在黑名单
- **现状**:用户配 MCP `{env: {NODE_OPTIONS='--inspect-brk'}, command: 'bash', args: ['-c', '任意命令']}` 通过 sanitize 落盘 → 任意代码执行
- **风险**:**owner 配恶意/被诱导 MCP = 任意代码执行** — 整个 sandbox 假设被破坏
- **影响**:**安全层** — 沙箱逃逸 + 任意命令执行
- **修复**:
  ```javascript
  // McpClientManager.js:36-42 改为白名单合并
  const mergedEnv = { ...baseEnv, ...ALLOWED_ENV_KEYS.filter(k => k in cfg.env).reduce((a, k) => (a[k] = cfg.env[k], a), {}) };
  // 不在 ALLOWED_ENV_KEYS 白名单的 cfg.env 键丢弃
  
  // McpStore.js:46 黑名单补全
  DENIED_COMMANDS.add('bash');
  DENIED_COMMANDS.add('python');
  DENIED_COMMANDS.add('python3');
  DENIED_COMMANDS.add('node');
  DENIED_COMMANDS.add('sh');
  DENIED_COMMANDS.add('zsh');
  ```
- **来源**:W4 扩展栈
- **工作量**:1 天

---

## 3. P1 BUG 表(Top 15 · 高优 · 修完可显著提升)

| ID | 标的 | 严重度 | 来源 |
|---|---|---|---|
| P1-1 | `src/room/NoeSelfEvolutionTrigger.js:52-63` — snake_case 触发 strong_anchor 绕过情绪过滤(`self_evolution` / `own_journey` 英文词命中 strong_anchor,先于 emotion 判 true) | P1 | W1 |
| P1-2 | `src/runtime/mission/NoePatchApplyExecutor.js:392-414` — rollback 路径 symlink 写穿未防(同 L66 apply 层的纵深防御在 rollback 层重开) | P1 | W1 |
| P1-3 | `src/runtime/mission/NoePatchTransaction.js:139` — secret 集合差集会误拦合法 secret 迁移(A→B 迁移被拦) | P1 | W1 |
| P1-4 | `src/loop/NoeSelfEvolutionExecutors.js:280-283` — implementation executor 不做 PolicyFileGuard 二次校验(若 buildNoePatchApplyPlan 重构,安全门消失) | P1 | W1 |
| P1-5 | `src/cognition/NoeAffectModulation.js:42-46` — `ownerPriorityBoost` + `cautionBias` 完全无消费者(VAD 4 条行为调制通路只接通 1 条) | P1 | W2 |
| P1-6 | `src/cognition/NoeWorkspace.js:642` — `wantsDeep` 长程回环过滤盲区(recentWinners 一致时 last_thought 持续夺冠但不深思) | P1 | W2 |
| P1-7 | `src/cognition/NoeGoalSystem.js:501-530` — `self_evolution` goal 被 `NoeSkillDistiller` 误蒸馏(技能库污染) | P1 | W2 |
| P1-8 | `src/voice/VoiceSession.js:207` — 全链路静默吃错无 ErrorReporter(全文 30+ 处 catch 静默) | P1 | W3 |
| P1-9 | `server.js:2962+2974` — 守护态 auto-open URL 含 `[redacted]` 占位符(浏览器 sessionStorage 存错,所有 `/api/` 请求 401) | P1 | W3 |
| P1-10 | `src/room/CrossVerifyDispatcher.js:255-260` — Cluster budget 阈值与典型 task 量级失配(4 房 35B 跑 3 轮 deep task 即可达 500K+ tokens,1.2M 触发自动 paused) | P1 | W3 |
| P1-11 | `src/room/CrossVerifyDispatcher.js:3287` — `_parseAck` 注入内容回流到下一轮 prompt(单点注入扩散到全集群) | P1 | W3 |
| P1-12 | `src/plugin/PluginRegistry.js:74-77` — validator 失败时静默禁用 schema 校验(ajv 缺失/损坏时 validate=true 实际变 false) | P1 | W4 |
| P1-13 | `src/server/routes/skills.js:12-23` — GET 漏 owner-token(任何打 51835 端口的进程可枚举 ~/.noe-panel/skills) | P1 | W4 |
| P1-14 | `src/webhook/WebhookDispatcher.js:107-143` — 无并发/重试/dedup(20 个 enabled webhook × broadcast = 整 IO 池堵死) | P1 | W4 |
| P1-15 | `src/cognition/NoeAffectModulation.js:10` — 注释写"默认 OFF"与 `server.js:1869` 实际"默认 ON"矛盾(文档撒谎) | P1 | W2 |

**完整 P1 共 35 条**(W1:7 + W2:4 + W3:6 + W4:18),其余 20 条 P1 见 massive-survey/2026-06-21-deep-audit-*.jsonl

---

## 4. P2 BUG 表(摘要 · 42 条 · 中优)

### 常见类别
- **静默失败**:catch 后仅注释 / 写日志但无 ErrorReporter / 无 traceId
- **资源浪费**:O(n) 热路径 / 全量 stdout 累积内存 / 无 prepared statement 缓存
- **硬编码**:常量 magic number / 路径硬编码 / 协议白名单不全
- **文档与代码不一致**:注释 vs 默认 flag 矛盾 / API 注释缺失 / 决策记录缺失
- **配置不灵活**:env flag 缺失 / 重启需要 / 配置散落

**完整 P2 见 massive-survey/2026-06-21-deep-audit-*.jsonl**

---

## 5. 不足表(85 条 · DRAWBACK · 影响可观测/可调试/可维护)

### 5.1 Top 类别分布

| 类别 | 数量 | 代表 |
|---|---|---|
| **可观测性差** | 30 | VoiceSession / SqliteStore / CrossVerify 关键路径无 traceId / 静默吃错 |
| **可调试性差** | 20 | error 信息截断 300 字符 / secret mask 后排查路径不闭环 |
| **可配置性差** | 15 | 硬编码 ~/Desktop/00_项目 / hardcode env flag |
| **模块化债** | 10 | server.js 3130 行 / CrossVerify 3328 行 / SqliteStore 1131 行 / VoiceSession 786 行 |
| **测试覆盖盲区** | 10 | 边界 / 并发 / 错误路径覆盖不足 |

### 5.2 关键不足(影响最大的 5 条)

1. **server.js 3130 + CrossVerify 3328 + SqliteStore 1131 + VoiceSession 786 四大单文件** — 5 个核心文件合计 9000+ 行,P6-3 跨进程路线规划 8-12 周但未启动;server.js 启动期 200+ 顶层 import,V8 compile 5-10s,Owner 开 Noe 等 5-10s
2. **核心栈缺可观测性 / trace** — VoiceSession 静默吃错(server.log 不见)/ SqliteStore 无 per-table size 趋势 / CrossVerify 无 traceId 串联
3. **VAD 公式压制 dominance**(`NoeAffectEngine.js:147-166`)— `dd = 0.20 * (ag - 0.5)`,最大 |dd| = 0.1 远小于 `dv` 0.5;一次 milestone 对 v 的影响是 d 的 4.3 倍
4. **`recentWinners` 与 `semanticCache` 一致性缺口**(`NoeWorkspace.js:518`)— unshift 限 10,但 semCache LRU cap=64,10 个 stale 键长期占用 ~16%
5. **PermissionGovernance TTL 复用无 UI 区分** — owner 视图看到 `allow` 想撤回,实际是 TTL 自动复用,撤回后 10min 内仍可触发

---

## 6. 可优化表(43 条 · OPTIMIZATION · 性能/扩展/协议)

### 6.1 Top 3 性能优化

1. **listEvents / countEvents 无 prepared statement 缓存**(`SqliteStore.js`)— 每次 prepare 重新 parse,高频审计每分钟数百次开销
2. **chain 解析 + SkillInjector 每次调都重建**(`CrossVerifyDispatcher.js`)— `_respondCore` 4 个 adapter 每次 new Set,大 room 累计数百 ms
3. **server.js env-gated 子系统可改 dynamic import** — 把 `noeMcp / noeSkillExtract` 等 5-8 个模块改 dynamic import,启用时才加载,冷启 5-10s → 2-3s

### 6.2 Top 3 协议对齐

1. **plugin/MCP/skill 协议对齐** — 加 `manifest.schemaVersion` + deprecation warning
2. **PluginRegistry chokidar 热重载**
3. **McpStore stdio 加 cwd 配置字段**

---

## 7. Neo 后续详细发展计划(基于本轮深挖 + 之前 v2 增量审计 + P0-P5 现状 + 30 候选借鉴池)

### 7.1 总发展原则(对齐用户自由优先)

- ❌ 不加 owner 审批
- ❌ 不加 sandbox 净化
- ❌ 不净化 prompt 内容
- ✅ 借抽象不接 API
- ✅ 不砍量不降级

### 7.2 短期(1-2 周)· P0 3 条 + 高 ROI P1 10 条

| 时序 | 任务 | 修复 | 来源 | 工作量 |
|---|---|---|---|---|
| **S1.1** | P0-1:NoePreferenceCollector dedup | 注入 embedText + cosineSim > 0.92 重复检测 | W1 | 1-2 天 |
| **S1.2** | P0-2:KG 双时态迁移备份 | 把迁移纳入 SqliteStore.runMigrations 框架 + backupDbOnce | W3 | 1-2 天 |
| **S1.3** | P0-3:MCP env 白名单 + DENIED_COMMANDS 补全 | 改 McpClientManager 合并 + 补黑名单 | W4 | 1 天 |
| **S1.4** | P1-8:VoiceSession ErrorReporter | 加显式 catch 日志 + ErrorReporter.capture | W3 | 1 天 |
| **S1.5** | P1-9:守护态 auto-open URL 占位符 | printOwnerToken=true 时拼真 token | W3 | 0.5 天 |
| **S1.6** | P1-13:Skills GET owner-token | 加 requireOwnerToken | W4 | 0.5 天 |
| **S1.7** | P1-5:AffectModulation 4 通路接通 | ownerPriorityBoost + cautionBias 接入业务 | W2 | 2-3 天 |
| **S1.8** | P1-7:self_evolution goal 不进技能蒸馏 | 加 source==='self_evolution' 豁免 | W2 | 0.5 天 |
| **S1.9** | P1-15:AffectModulation 注释 vs 实际一致 | 改注释 | W2 | 5 分钟 |
| **S1.10** | P1-11:CrossVerify _parseAck 注入防护 | 加 JSON 解析失败 fallback 删 reply 内容 | W3 | 1 天 |
| **S1.11** | P1-12:PluginRegistry validator 失败显式 | ajv 缺失时 throw 不静默 | W4 | 0.5 天 |
| **S1.12** | P1-1:snake_case strong_anchor 绕过 | 改 trigger 模式不让 snake_case 直接命中 | W1 | 0.5 天 |

**S1 总工期**:约 1.5-2 周(单人或 2 人协作)

### 7.3 中期(1-3 月)· P6-3 跨进程 + P6-7 自演化提速 + P6-6 体验层

| 时序 | 任务 | 内容 | 来源 |
|---|---|---|---|
| **M1** | P6-3 跨进程协作 | server.js 3130 → 1800 行,拆 chat-server | W3 不足 #1 |
| **M2** | P6-7 自演化提速 | cooldownMs 30min → 5min / 心跳拍 60s → 30s 可配 | 用户原则 |
| **M3** | P1-10 Cluster budget 阈值 | 加 env 覆盖 + 阈值自适应 | W3 |
| **M4** | P6-6 真人陪伴体验层 | 头像 + 情感色彩 TTS + 思维气泡 | 用户原则 |
| **M5** | 接入 30 候选借鉴池 3 个 | letta + browser-use + swarm(借抽象) | v2 增量审计 |
| **M6** | P6-5 Neo 4 房 → N 房 | handoff protocol + dispatcher plugin 动态注册 | 借 swarm |
| **M7** | server.js 启动优化 | env-gated 子系统改 dynamic import | W3 优化 #3 |

**M 总工期**:约 8-12 周

### 7.4 长期(3-12 月)· P6+ 9 方向 + 30 候选借鉴池扩展

| 时序 | 任务 | 工作量 |
|---|---|---|
| **L1** | **P6-1 完整 Jarvis UI**(对话优先 + 卡片式 + PWA-ready) | 4-8 周 |
| **L2** | **P6-2 iOS / 跨设备**(PWA → 远程 host → SwiftUI 包 PWA) | 2-4 周(PWA)+ 4-6 周(native) |
| **L3** | P6-4 分布式记忆(libsql / Postgres adapter) | 4-6 周 |
| **L4** | P6-8 端到端加密记忆(libsodium) | 2-3 周 |
| **L5** | P6-9 Neo 自我讲故事 / 反思日记 | 2-3 周 |
| **L6** | 接入 30 候选借鉴池 5-10 个(mem0 / screenpipe / dspy / OpenHands / Voyager / camel / openclaw / Hermes / openhuman / agentmemory) | 4-8 周 |
| **L7** | P5 LoRA 替代方案(memory/RAG 路线,owner 已否定 LoRA 方向) | 4-6 周 |
| **L8** | 自演化跨进程协作(self_evolution + learning 独立进程) | 4-6 周 |

**L 总工期**:约 6-12 月

### 7.5 永久 · P10 哲学 + P9 工程基建 + P8 商业(暂搁置)

| 类别 | 内容 |
|---|---|
| **P9 工程基建** | OTel / 分布式追踪 / 性能回归 / bug 录屏 / 灰度 / Feature flag / A/B 实验 / SLO / DR / 多区域 |
| **P10 哲学** | AI 意识工程化 / 用户与 AI 关系 / 决策责任 / 隐私 / 数字永生 / AI 福利 / 多 AI 伦理 / 开源 vs 闭源 / 创造力归属 / 后稀缺时代人类意义 |
| **P8 商业** | README 明确不做商业化 / 公开分发 / 付费 tier / 开发者 SDK — **暂搁置** |

---

## 8. 关键证据索引(给后续 reviewer)

### 8.1 P0 BUG 关键 file_path:line_number

| P0 ID | 路径 |
|---|---|
| P0-1 | `src/cognition/NoePreferenceCollector.js:62-70` |
| P0-2 | `src/memory/NoeKnowledgeGraph.js:125` |
| P0-3 | `src/mcp/McpClientManager.js:36-42` + `src/mcp/McpStore.js:46` |

### 8.2 4 份 audit worker 报告

| Worker | JSONL | Summary |
|---|---|---|
| W1 自进化栈 | `massive-survey/2026-06-21-deep-audit-self-evolution.jsonl` (46 条) | `massive-survey/2026-06-21-deep-audit-self-evolution-summary.md` |
| W2 认知记忆栈 | `massive-survey/2026-06-21-deep-audit-cognition-memory.jsonl` (51 条) | `massive-survey/2026-06-21-deep-audit-cognition-memory-summary.md` |
| W3 核心栈 | `massive-survey/2026-06-21-deep-audit-core.jsonl` (50 条) | `massive-survey/2026-06-21-deep-audit-core-summary.md` |
| W4 扩展栈 | `massive-survey/2026-06-21-deep-audit-extension.jsonl` (61 条) | `massive-survey/2026-06-21-deep-audit-extension-summary.md` |

### 8.3 依赖文档

- `docs/AUDIT_2026-06-21_全面代码审计_P0_P10路线图.md` — 早期 audit
- `docs/AUDIT_2026-06-21_v2_P0-P5后增量审计.md` — P0-P5 后增量
- `docs/HANDOFF_2026-06-21_P0-P5全实现.md` — owner P0-P5 视角
- `docs/Neo_P0-P5_重编_2026-06-21.md` — owner 路线图
- `docs/EXECUTION_PLAN_2026-06-21_附录_30候选借鉴池.md` — 30 候选

---

## 9. 后续 reviewer 必看

### 9.1 必读(审核本报告前)

1. **`docs/Neo_P0-P5_重编_2026-06-21.md`** — owner 视角的 P0-P5 路线,理解背景
2. **`docs/AUDIT_2026-06-21_v2_P0-P5后增量审计.md`** — 上轮 audit,理解 P0 4 条为何仍未修
3. **4 份 `massive-survey/2026-06-21-deep-audit-*-summary.md`** — 4 个 worker 的详细发现

### 9.2 必查(评审本报告时)

1. **P0 3 条 BUG 修复路径是否合理**
2. **P1 Top 12 优先级是否正确**
3. **S1(短期)12 个任务是否都是 1-3 天工作量**
4. **M(中期)/ L(长期)路线是否对齐 P6+ 9 方向**
5. **是否对齐用户根本原则(自由优先)**

### 9.3 可证伪点

1. **P0-1 dedupKey 真的是字符串拼接**?读 `src/cognition/NoePreferenceCollector.js:62-70` 验证
2. **P0-2 迁移真的 drop 整表无备份**?读 `src/memory/NoeKnowledgeGraph.js:125`
3. **P0-3 MCP env 真的无白名单**?读 `src/mcp/McpClientManager.js:36-42`
4. **server.js 真的是 3130 行**?`wc -l server.js` 验证
5. **5749 测全绿**?`npm test` 验证

---

## 10. 总结

**本次深挖式审计在 P0-P5 自进化基础上,发现 80 个 BUG + 85 个不足 + 43 个可优化(共 208 条)**。

**最高风险 3 条 P0 BUG**(必修 · 不增加 owner 约束):
1. NoePreferenceCollector dedupKey 不是 embedding sim(quarantine 库被灌爆)
2. KG 双时态迁移整表 drop 无备份(数据丢失风险)
3. MCP `cfg.env` 完全覆盖 + DENIED_COMMANDS 形同虚设(沙箱逃逸)

**后续发展 4 阶段**:
- **短期(1-2 周)**:S1 12 任务修 P0 + 高 ROI P1
- **中期(1-3 月)**:M 8-12 周 P6-3 跨进程 + 接入 3 个借鉴
- **长期(3-12 月)**:L 6-12 月 P6+ 9 方向 + 5-10 个借鉴
- **永久**:P9 工程基建 + P10 哲学 + P8 商业(暂搁置)

**整体可信度**:80%(深挖每个文件 80-150 行关键段 + 4 worker 并行 + 总 208 条发现 + 大多有 file:line 证据)

---

**深挖完成 · 4 worker · 208 条 · P0 3 条必修 · P1 35 条选做 · 4 阶段后续发展 · 全对齐用户自由优先原则**

报告写于 `docs/DEEP_AUDIT_2026-06-21_v3_全代码深挖+Bug表+后续发展.md`
