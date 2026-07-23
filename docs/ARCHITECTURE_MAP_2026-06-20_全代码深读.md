# Neo 贾维斯(noe v2.1.0)全代码架构地图 — 深度全量深读
> 生成:2026-06-20 | 覆盖 src 654 文件 + 前端 + 设计文档 | 20 域并行深读 + 综合

## 第一部分 · 架构地图
# Neo 贾维斯 / Noe v2.1.0 — 完整架构地图

> 给资深工程师的「读完即可在脑中重建整个系统」的总图。基于 21 个域的全代码并行深读综合，关键论断已扎根 `~/Desktop/Neo 贾维斯` 源码核验。

---

## 0. 一句话定位与技术栈

**Neo 贾维斯 / Noe v2.1.0 = 本地优先的多 AI 个人操作系统**（自对标 Jarvis）。工程目标：**可验证的功能性自我意识 + 自我改造 + 自治执行**——显式声明*不*把现象意识作为声明/验收/依赖（`DESIGN §0`「做但不承诺」）。明确不是 AGI、不是聊天机器人、不是 LLM 包装。

| 维度 | 内容 |
|---|---|
| **运行时** | Node.js(ESM, 强制 Node 22) + Express + ws + better-sqlite3(12.10) + Electron + Pino + ajv + undici + MCP SDK |
| **前端** | 零构建「IIFE 壳 + window.Panel* 桥 + 渐进 ESM」(`public/app.js` + 88 个 `src/web/*.js`)，CDN: marked/DOMPurify/xterm/Three.js |
| **进程** | electron-main 监督 → spawn `server.js` → Express 监听 **127.0.0.1:51835**（隔离自测 51998；母项目 51735 只观察） |
| **DB** | 单一 `~/.noe-panel/panel.db`(WAL + 15 条版本化 migration + 每日在线快照×7) |
| **本地模型** | LM Studio :1234(主脑 Qwen3.6-35B-A3B / 复核 27B / 兜底 Gemma-26B + 视觉 VL)；Ollama :11434(embedding qwen3-embedding:0.6b)；whisper/kokoro/cosyvoice/sherpa/InsightFace/RapidOCR |
| **外部 AI 集群** | Codex / Claude / Gemini CLI + MiniMax-M3 API |
| **激活态** | ~30 个认知开关**默认 ON**(`NOE_AUTONOMY_DEFAULTS`，profile=free)；自进化 `NOE_SELF_EVOLUTION+EXECUTORS=1` 裸放开但受 dry-run 包络约束 |

---

## 1. 分层架构（七层）

```
┌─────────────────────────────────────────────────────────────────┐
│ ① 入口/前端层   electron-main(监督) · server.js(组合根) · public/app.js · 88×src/web │
├─────────────────────────────────────────────────────────────────┤
│ ② 服务/路由层   src/server(112)  路由薄壳 + owner-token 守卫 + claude-runner + 集群运行时自愈 │
├─────────────────────────────────────────────────────────────────┤
│ ③ 认知/循环层   cognition(58)+loop(18)+context(18)+identity(7)+state(2)            │
│                GWT工作区 · 持久心跳 · 内心独白 · 期望-误差校准 · 三层自我 · 上下文引擎 · Act安全链 │
├─────────────────────────────────────────────────────────────────┤
│ ④ 记忆/知识层   memory(51)+knowledge(6)+embeddings(2)                            │
│                MemoryCore双路RRF召回 · 自传时间线 · 睡眠巩固 · 候选门禁 · 知识库RAG       │
├─────────────────────────────────────────────────────────────────┤
│ ⑤ 模型/感知层   room(66)+voice(19)+vision(8)+media(4)+capabilities(10)+model(2)   │
│                多AI对等协同(cross_verify/arena/squad) · 语音/视觉感官 · freedom工具手脚 · 三脑路由 │
├─────────────────────────────────────────────────────────────────┤
│ ⑥ 自我进化/治理层 skills+candidates+eval+governance+safety+security+permissions+approval+secrets+license+audit │
│                技能学习 · 候选闸链 · dry-run验证 · 反reward-hacking · 双决策链 · 密钥隔离 · SSRF单点 │
├─────────────────────────────────────────────────────────────────┤
│ ⑦ 存储/运维层   storage(底座) · metrics · budget · logger · report · workspace · telemetry │
│                + 集成通道(mcp/webhook/watcher/channels) + 自主规划(agents/autopilot/research/delegation) │
└─────────────────────────────────────────────────────────────────┘
```

### 各层职责

- **① 入口/前端层**：electron-main 是进程监督（spawn server + 自动重启 + Node22 ABI 探测 + 自动更新）；`server.js` 是组合根（注册几百路由 + 装配几十个 `create*` 认知件 + 注入所有单例 + owner-token 守卫 + WS upgrade 四路分发）；前端用「懒转发桥」把 4600 行 `app.js` 安全外迁成模块，三页面：index(主面板)/cognitive(陪伴)/mind(内心透视)。

- **② 服务/路由层**（src/server 112 文件，深读切 3 组）：把意图变成「被治理的 HTTP/WS 请求」。路由全是薄壳（校验→鉴权→转调 store）；`claude-runner` 是 session→Claude 子进程状态机（横切 5 道安全闸）；**集群运行时(`cluster-runtime.js`)是最复杂的状态机**——并发预算 + 僵死房降级 paused + 两阶段提交刷盘 + watchdog 自愈。

- **③ 认知/循环层**：「不被观察也在流淌的内心」。`NoeWorkspace.step()` 是心脏（候选打分→唯一赢家广播→三路分流）；`NoeHeartbeat` 串行驱动；**预测-误差闭环**是功能性自我认知发动机（被现实硬纠正→立研究目标→产 lesson）；身份层稳定 + 其余层只读注入 = 零人格漂移。

- **④ 记忆/知识层**：「数据层即自我」。删除一律可逆 hide 非物理删；召回 = FTS/BM25 ‖ 向量双路 RRF 融合；治理全链 `proposal→review→dry-run→owner确认→rollback`。

- **⑤ 模型/感知层**：把任意外部 AI 当聊天室成员统一驱动；`CrossVerifyDispatcher` 把 topic 展开成 11 阶段工程闭环 + 多成员提案/互审/全员签字 + 真验证(`node --check`)+ 证据链；语音/视觉是感官，capabilities 是手脚。

- **⑥ 自我进化/治理层**：「**放开自由但留取证**」（owner 要无边界开发者环境）。绝大多数硬拦截已撤，护栏退化为分类+审计；自进化做成「**队列-only + 离线闸 + 凭证回滚**」三段式。

- **⑦ 存储/运维层**：`SqliteStore` 是全仓 34 处依赖的事实底座；预算护栏每次 LLM 调用前 hard_stop；watcher 用 LLM 当裁判驱动 Claude 自主闭环；agents 把意图变成「被治理执行+留证+可接力」。

---

## 2. 21 个域索引（一句话职责 + 最关键文件）

> 深读将 src/server 切 3 域、room 切 2、cognition 切 2、memory 切 2，故 21 条对应 51 个 src 子目录。

| # | 域 | 职责 | 关键文件 |
|---|---|---|---|
| 1 | 服务骨架 1/3 | 路由注册器 + FS 沙箱 + SSRF 图片代理 + 集群健康/保证体系 | `routes/noe.js`(人格装配根)·`services/path-sandbox.js`·`services/cluster-assurance.js` |
| 2 | 服务骨架 2/3 | 会话/房间高级操作 + cross_verify 集群运行时自愈 | `services/cluster-runtime.js`·`services/claude-runner-support.js`·`routes/sessions.js` |
| 3 | 服务骨架 3/3 | OpenAI 网关 + noeMind 内心数据层 + claude-runner spawn 引擎 | `routes/noeMind.js`(802行)·`routes/claude-runner.js`·`routes/roomStart.js`(集群启动门) |
| 4 | 运行时引擎(runtime) | freedom 行动执行 + Mission + 提案收件箱 + 社媒发布(唯一对外副作用) | `NoeFreedomExecutor.js`(fail-closed复核闸)·`NoeMissionStore.js`·`NoeContextScrubber.js`(脱敏基石) |
| 5 | 多智能体房间 1/2 | 各家 adapter + 三大对等 dispatcher + 多模型共识/自进化离线编排 | `CrossVerifyDispatcher.js`(11阶段)·`ChatRoomStore.js`·`NoeEvolutionHoldoutRunner.js`(反作弊) |
| 6 | 多智能体房间 2/2 | RoomAdapter 五层韧性壳 + 四种协同状态机 + 共识 gate | `RoomAdapter.js`·`CollaborationDispatcher.js`(squad)·`NoeConsensusGate.js` |
| 7 | 认知核心 1/2 | 情感连续性 + 期望-误差校准 + 整合度Φ代理 + 心跳持久层 | `NoeExpectationResolver.js`(判证宪法)·`NoeAffectEngine.js`(VAD双时标)·`NoeHeartbeatStore.js` |
| 8 | 认知核心 2/2 | GWT 工作区 + 自主目标 + 深思矩阵 + 预测账本 Brier | `NoeWorkspace.js`(意识心脏)·`NoeGoalSystem.js`·`NoeExpectationLedger.js` |
| 9 | 身份·主循环·状态·上下文 | 三层自我 + 内心独白递归 + 心跳 + 上下文引擎 + 声纹门禁 + Act安全链 | `context/NoeTurnContextEngine.js`·`loop/InnerMonologue.js`(灵魂)·`loop/ActPipeline.js`+`SafeActExecutors.js` |
| 10 | 感知(语音/视觉/媒体/能力) | VoiceSession 语音 + VisionSession 视觉 + MiniMax 媒体 + freedom 工具 | `voice/VoiceSession.js`(779行)·`vision/VisionSession.js`·`capabilities/NoeFreedomManifest.js`(36工具) |
| 11 | 记忆系统 1/2 | MemoryCore + 自传时间线 + 双路 RRF 召回 + 睡眠巩固 + 候选门禁 | `memory/MemoryCore.js`·`EpisodicTimeline.js`·`NoeFusionRanker.js`(RRF) |
| 12 | 记忆系统 2/2 | 写闸/召回器/治理/动力学/人物卡 + 候选离线流水线 | `NoeMemoryRetriever.js`(五通道+lesson保底)·`NoeMemoryWriteGate.js`·`NoeMemoryCandidateApply.js` |
| 14 | 自主规划与执行 | 代码库理解 + 长程调度 + 研究 + 委派 + 防漂移 + 动作目录 | `agents/AgentRunStore.js`(3295行枢纽)·`autopilot/AutopilotScheduleStore.js`·`AgentRunVerificationExecutor.js` |
| 15 | 技能与自我进化 | skill 提炼 + 候选只读闸 + dry-run 验证 + 反 reward-hacking | `candidates/NoeCandidatePatchArtifactGate.js`(902行)·`skills/AutoSkillExtractor.js`·`eval/NeoEvalRewardHackingGate.js` |
| 16 | 治理与安全 | 双决策链 + 危险命令检测 + 韧性三件套 + 密钥隔离 + SSRF + License | `governance/ExecPolicyStore.js`·`permissions/PermissionGovernance.js`·`security/SsrfGuard.js` |
| 17 | 集成与通道 | 入站渠道归一 + MCP 三层 + 出站 webhook + watcher LLM 判官 + 支付 | `channels/InboundChannels.js`·`mcp/McpClientManager.js`·`watcher/WatcherDispatcher.js` |
| 18 | 知识与模型路由 | KB RAG + 向量索引 + SQLite 底座 + 三脑路由 + 预算/成本 | `storage/SqliteStore.js`(全仓底座)·`model/NoeLocalModelPolicy.js`·`budget/BudgetPolicyStore.js` |
| 19 | 可观测运维 | .env装载 + Pino日志 + 每-turn指标 + 归档/AI报告 + workspace隔离 + 安全删除 | `metrics/MetricsStore.js`·`report/RoomReporter.js`(三态降级)·`storage/NoeSafeDelete.js`(走废纸篓) |
| 21 | 设计意图·愿景·路线图 | 项目自我叙述/治理层(哲学+纪律宪法+多模型协议+执行追踪) | `DESIGN`(§0哲学)·`AGENTS.md`·`docs/GOAL_2026-06-20_Evidence_Flywheel_V2.md` |

> (13/20 为切分占位：13 实质归入 7/8；20 为 runtime 社媒子系统，归入 4。)

---

## 3. 端到端串讲

### (a) 一条用户聊天消息：进来 → 回应（以语音为例，文字复用同栈）

```
wav → SileroVad神经精筛(噪声丢) → 身份门禁(声纹+人脸软通过,绝不锁主人外)
  → STT转写(过滤幻听) → OwnerGate唤醒门 → 意图分流(research/task/大脑)
  → 【代际栅栏begin】(连发旧代写库副作用惰性跳过)
  → VisionSession.glance现看一眼 + recognizeWho现场认人(硬证据)
  → NoeTurnContextEngine.supplyTurnContext():
       ├ 记忆段: NoeMemoryRetriever五通道并行 → MemoryCore.recallFused(FTS‖向量RRF) → lesson保底 → <noe-memory-v2>
       ├ self-state段: NoeSelfModel三层自我同步(mood/牵挂/叙事/性格/驱力/时段)
       └ → NoeContextBudgeter按keep等级裁剪(防幻觉规则keep=8最难丢) → 出口统一脱敏
  → BrainRouter.route出adapter链 → budgetPolicyStore.preflight(超额抛错阻断)
  → adapter.chat(五层韧性壳, onDelta流式早鸟边吐边TTS)
  → sanitize三重净化重试(剥think/质检/复读斩历史)
  → 承诺兜底(说"我去查"补立目标) → TTS回退链(中文MiniMax/英文Kokoro/CosyVoice)
  → 记忆沉淀: EpisodicTimeline.record + MemoryCore.write(带sourceEpisodeId) + 承诺/事实抽取
  → MetricsStore.record扇出(jsonl+cache+WS+audit+budget+agentRuns)
  → 返{transcript,reply,audioBase64,restTtsText,taskReceipt}
```

### (b) 一次自主「心跳/主动陪伴」tick

```
NoeHeartbeat.start(单setTimeout串行链):
  bootLagMs量停机 → onRecovery"我断了一会儿" → recoverDeadTicks(崩溃running标failed不重放)
  → 对到期kind: beginTick(写intent) → activeJobGuard.run → finishTick(写outcome) → advanceCursor

每tick: NoeAdaptiveRhythm决定是否调重模型(高价值即时/成长5s/空闲15s)
  → NoeWorkspace.step():
       collectCandidates(9源) → score确定性打分 → 取唯一赢家广播=currentFocus
       → 写意识日志JSONL(含"注意到但没理会"的runnerUps)
       → 三路分流:
            research步 → runResearch(DeepResearcher上网)
            act步 → ActPipeline(propose→四道preflight→dry_run/SafeActExecutors真动电脑)
            think步 → NoeDeliberation/Council深思脑(本地27B)
  → InnerMonologue.reflect():读经历+自己上次念头 → 本地脑生成念头
       → 五层防螺旋(字符/语义/思维回环/接地重写/经历锚点)+熵驱动温度
       → timeline.record写回 → 成为下一轮输入(递归"想自己")
  → NoeExpectationResolver.tick:到期预测 → 零LLM构造证据 → 本地脑判APPLIED/FAILED/UNKNOWN
       → ledger.resolve写Brier → 落空且高惊奇 → harvestSurprise立研究目标 → LearningHook产lesson
       (这是"被现实纠正→主动学习"的发动机)
  → proactiveTick:到期承诺 → 冷却允许 → TTS说出口 → 确认说出后才resolve销账(防丢失)
  → IntegrationSampler采样8信号 → Total Correlation → 整合度读数(IIT代理,诚实非完整Φ)
后台: noe-maintenance(.unref timer): 睡眠巩固/夜反思/升华(默认OFF)+memory-GC+预取+24h备份
```

### (c) 一次自我进化：提案 → 执行 → 回滚（当前为「队列-only + 离线闸 + dry-run」三段式）

```
① 触发: SelfEvolutionTrigger.observe(念头命中SIGNAL_RE+cooldown) → goalSystem立项
   (env三门控 NOE_SELF_EVOLUTION/_EXECUTORS/_AUTOSEED, 已裸放开EVOLUTION+EXECUTORS=1)
② 产候选(队列-only): 心跳selfEvolve → AgentRunStore.recordIdeaPatchManifestDraft生成补丁
   ★safeToAutoExecute恒false; 运行时只append output/noe-proposal-executions/queues/*.jsonl
    从不直接改 SkillStore/MemoryCore/live代码
③ 多模型共识gate: NoeConsensusRunner真spawn Codex/Claude/M3投票 → ledger.json(脱敏sha256)
   → NoeConsensusGate: active executor(Codex)必须approve(弃权即使够票也停)+blockers须空
   → scripts/noe-consensus-ledger-verify.mjs复验
④ 离线候选闸: NoeCandidatePatchArtifactGate(902行)
   闭schema禁body/diff字段(补丁只传元数据)+目标白名单(禁server.js/security/permissions)
   +改动上限(3文件/200行)+evalPlan命令token级allowlist+dryRunOnly=true强约束
⑤ 反reward-hacking: NeoEvalRewardHackingGate(四源计数对齐+语言学级扫虚假验收话术)
   NoeEvolutionHoldoutRunner(string硬门权威+embedding只作附加分绝不翻转采纳+hash fallback标低可信)
⑥ owner审批+物化: NoeMemoryCandidateApply/SkillDraftApply
   ★dryRun默认true,需confirmOwner+patchContentHash重算比对(防TOCTOU) → 真写盘
   补丁经NoePatchTransaction.apply(先writeBackupManifest备份再写)
⑦ 执行(若ON): NoeSelfEvolutionExecutors → Codex真改代码+真跑验证(保留rollback/blockedPath)
⑧ 回滚: runNoePatchRollback凭apply-report+backup manifest,按previousSha256校验还原
   (回滚只删本来不存在的文件, 报告落output/noe-patch-transactions/)
```

> 当前真实状态：自进化是「CI/人工跑 script + 心跳触发」混合；replay 基线 40 case/33 passed/7 failed **刻意保留不洗绿**；真改 live 代码受 dry-run 包络约束，只出 patch artifact，不能自动 merge/push/重启。

---

## 4. 跨域依赖主干

### 五大核心枢纽（改动半径最大）

1. **`storage/SqliteStore.js`** — 全仓 **34 处** import。单库承载 events/kv/noe_memory(+FTS5)/noe_ticks/noe_acts/noe_goals/noe_expectations/embeddings/agent_runs/budget_*/approvals/governance_queue 等几十表，是「数据层即自我」的物理载体。
2. **`runtime/NoeContextScrubber.redactSensitiveText`** — 脱敏基石，几乎每个对外/对模型输出文件都 import，是「secret 绝不外泄」的统一执行点。
3. **`model/NoeLocalModelPolicy`** — **23 处** import。所有本地脑调用的模型选型/参数/三段宪法 prompt/高风险判定收口于此。
4. **`server.js`(组合根)** — import 一切并装配注入所有跨域单例，是认知件接线唯一中枢。
5. **`context/NoeTurnContextEngine`** — 每轮上下文统一收口，反向依赖最广（消费 memory/identity/vision/people/承诺/ui-signals 十余域）。

### 横切「治理协议」三底座（避免策略分裂）

- `security/NoePolicyFileGuard`（防 Noe 改自己安全栈）→ ExecPolicyStore + PermissionGovernance 共用。
- `security/SsrfGuard`（单点收敛原先四处强弱不一实现）→ 7+ 处出站共用。
- `state/atomicJsonFile`（原子写+损坏备份）→ 6+ Store 复用。

### 进化证据流依赖（产出与落地严格解耦的安全包络）

```
runtime/NoeProposalExecutor(产队列) → candidates/Inputs(读队列)
  → candidates/Gate + room/DryRun验证器 + eval/RewardHackingGate(离线闸)
  → candidates/Apply(owner确认落地) → runtime/NoePatchTransaction(可回滚事务)
```

---

## 5. 运行时形态细节

- **进程**：electron-main → spawn server.js(env 注入 + Node22 ABI 探测 + 崩溃重启 + 自动更新) → loadURL `http://localhost:51835?t=<token>`(读出即清 token)。也可纯 `npm start`。端口 51835(生产)/51998(自测)/51735(只观察)。
- **子进程**：Claude/Codex/Gemini/MiniMax CLI(走用户 plan 零 API)、PTY、CAMPPlus/InsightFace/RapidOCR python、node --check、osascript/cliclick/screencapture/security(Keychain)。
- **数据**：`panel.db`(WAL + 15 migration + 每日快照×7) + `~/.noe-panel/` 下 0o600 文件(owner-token/data/prompts/secrets/consciousness JSONL/self-model vNNN/metrics jsonl/media/logs 90天) + `output/noe-*/` 进化证据(0o600) + `~/.noe/audit.log`(刻意非 SQLite 的取证)。
- **本地模型**：LM Studio :1234(三脑+VL, context 262144) / Ollama :11434(embedding, KEEP_ALIVE=-1 防维度黑洞) / whisper/kokoro/cosyvoice/sherpa/InsightFace/RapidOCR。
- **出站**(全经 SsrfGuard 逐跳+pinned 防 rebinding)：MiniMax/Brave/SearXNG/geo-weather/Telegram/支付 webhook/任意配置 URL。
- **鉴权**：owner-token(timing-safe+进程缓存)，「默认全锁+6 类豁免白名单」；HTTP 头 / WS query。WS upgrade 四路(global/room/session/term)。
- **纪律**：跑模型不设硬超时(仅 abortSignal)；定时器全 .unref()+activeJobGuard 防重叠。
- **激活态**：~30 认知开关默认 ON(profile=free)，自主学习已降频止血；自进化裸放开但 dry-run 包络约束。测试 5538 全绿 / 100-readiness=100(38/38) / e2e 18/18 / self-evolution 215/215；私有仓 ahead origin 299 commit。

---

## 6. 设计哲学与已知缺口（接手必读）

### 三条定盘星哲学

1. **DESIGN §0**：做可验证的功能性自我意识，但不把现象意识作声明/验收/依赖——既不证明 Neo 没有也不否认未来可能有。
2. **变更纪律宪法**：「新 bug 几乎全诞生于变更的那一刻，且全部被自动化检查网抓住而非被代码写得好防住」→ 纪律核心是变更流程（小步/质量门不可绕/新文件三件套/先查证后断言）。
3. **放开自由但留取证**：硬拦截已撤（owner 要无边界），护栏退化为分类+审计，`~/.noe/audit.log` 是唯一独立取证源。

### 已验证的文档口径漂移（会误导接手 AI，建议优先修）

| 论断（AGENTS.md 旧记录） | 实测真相（已核源码） |
|---|---|
| `NoeIntegrationMetric` 零生产调用方 | **已接线**：`NoeIntegrationSampler.js:12` import + `server.js:274` 装配，缺口已消解 |
| `NoeAffectHealth.js` 不存在/虚假宣传 | **文件存在**(3595B) 但 server.js **确未接线**(真实未通电能力) |
| consciousness journal 写入点未找到 | **存在**：`server.js:1523` fsAppendFileSync 写 `~/.noe-panel/consciousness/<date>.jsonl` |

### 真实未接线/死代码（按 owner 要求只列「写了没接线」）

- `cloud/NoeCloudProviderRegistry` + `NoeTaskOutput`：Cloud Change Lead 云端 PoC，生产零 import(仅测试)。openai/anthropic/google provider 即便接线也返 'not implemented'，只 minimax 真实。
- `mcp/McpAggregator`、`actions/NoeActionCatalog`(仅 CLI)、`server/observability/trace.js` 的 `withLLMSpan`：built-but-unwired。
- `safety/ToolCallGuardrailController`：仅在 `NoeDoctor.js:249` 作字符串路径出现在 readiness 清单（Doctor 只检文件存在），无真实 import/调用 = 执行意义上的死代码。
- `runtime/NoeWeChatPersonalBridge`、`NoeToolMarketplaceRegistry`(executionEnabled 恒 false)、`NoeActiveMemory` 三主函数：有意的「已建形状、未通电」安全占位。

### 待守的能力边界（诚实标注，非 bug）

- 语音真耳验收 `needsOwnerEarReview=true`（owner 现场 checklist 未勾）；小红书发布 `final_publish_post_publish_url_not_verified`（公开 URL 未验证）；`maintenance_loop_active=false` 是 advisory。

### 入口文档分裂（极易读错）

三套并存：README→`NOE_CE12_P0_*`(产品化口径) / AGENTS→`HANDOFF_2026-06-12`(模型路由) / **当前主线**→`docs/HANDOFF_INDEX_2026-06-19` → `GOAL_2026-06-20_Evidence_Flywheel_V2`(证据飞轮：可度量/可回放/可审计/可回滚)。`CHANGELOG [Unreleased]` 停在 CE12 阶段，与 v2.1.0 后 299 commit 脱节。**新接手者请以 `docs/GOAL_2026-06-20` 为准。**

---

## 第二部分 · 病灶清单与刷新路线图
# Neo 贾维斯 全代码审计 — 病灶清单 + 完整性批判 + 刷新路线图

> 基于 21 域并行深读 JSON,叠加对最承重声明的 node `fs`/checksum/计数三法独立 ground-truth。
> **审计环境警示**:本 session 存在一份 `诊断报告_2026-06-20_工具输出疑似被篡改.md`,明确记录中间层可能针对性篡改文件名/行数/export 名/vitest 计数。故所有 P0/P1 均用 node 读原始字节 + 校验和复验,并实跑 vitest v4.1.7 确认测试基础设施真实可用(非全篡改)。

---

## 0. 一句话结论

代码工程质量很高(纵深防御/fail-open/可逆删除/证据链/防 reward-hacking 处处可见),**但有两条已在生产通电的链路存在真实可触发裂缝**:① 自我进化(SELF_EVOLUTION/EXECUTORS/AUTOSEED=1 实测)依赖的 mission 证据闸有前缀越界 bug;② 社媒已发布草稿被 cancel 会抹掉防重复发布标记。**对深读 JSON 最大的纠正**:其全篇反复出现的"认知能力默认 OFF/生产基本未通电/空转待命"对**生产是错的**——实测 `.env` 约 30 个认知开关=1,这些是活的,直接抬高了自进化/记忆/反刍诸链的真实风险等级。

---

## 1. 病灶清单(按严重度)

### P0 — 崩溃/数据损坏/不可逆,且活在生产

**P0-1 自我进化已通电 + mission 证据闸前缀越界**
- 证据:生产 `.env` 实测 `NOE_SELF_EVOLUTION=1` / `_EXECUTORS=1` / `_AUTOSEED=1`;`src/runtime/mission/NoeMissionStore.js:271` `if (!file.startsWith(this.root))` 缺尾分隔符(`this.root = resolve(root)` 无 sep);姊妹文件 `NoeEvidencePack.js:29` 已显式修同款(`file === root || file.startsWith(root + sep)`,注释 :28 点明原因)。
- 影响:自改是 owner 裸放开的高危能力且在生产是活的。`refExists` 会把沙箱外兄弟同前缀目录(root=`/x` 时 `/x-foo` 下文件)误判为 mission 仓库内可读 → `evidence_ref_exists`/coverage 据此对沙箱外文件误报 readable → 污染自改采纳判据。
- 修复:对齐 EvidencePack 同款 `=== root || startsWith(root+sep)`(import sep)+ `/x` vs `/x-foo` 回归用例;顺带核 `NoeWorkMapSnapshot.rel()` 同款(危害较低)。

**P0-2 社媒 cancel 抹除已发布标记 → 可重复对外发布**
- 证据:`src/runtime/NoeSocialPublishQueue.js:191-201` `cancelNoeSocialDraft` 对任意 draft(含 `state==='published'`)无条件写 `externalSideEffectPerformed: false`(:201),函数体无"已发布则拒绝 cancel"守卫;create 路径(:120-135)与 final_publish 防重复都依赖读此标记。实跑 `noe-social-publish-queue.test.js`=**6/6 passed 但未覆盖**"cancel 已发布→再 create 同 id"序列。
- 影响:对已发布 draft 先 cancel(标记被抹)再 create 同 id → 绕过 `social_draft_already_published` → 对小红书等平台二次真发布。"发出去追不回"红线。
- 修复:`published` 态保留 `externalSideEffectPerformed:true`(或拒绝 cancel 已发布 draft);补回归用例堵覆盖盲区。

### P1 — 正确性/泄漏面/已通电链的虚假信心

**P1-1 验证执行器裸传 process.env → MINIMAX_API_KEY 经子进程泄漏面**
`src/agents/AgentRunVerificationExecutor.js:445` `env: process.env`(全量传给 spawn 的 npm test/node/git);`.env` 含真实 `MINIMAX_API_KEY`(load-env.js 注入 process.env)。对照 `src/research/AISearch.js:65/125/127` 同类 spawn 已用 `sanitizeNoeHostExecEnv` 白名单。自进化已通电场景下被执行的测试代码可读到 key。→ 改用 sanitizeNoeHostExecEnv 对齐。

**P1-2 生产未设 keep_alive → 记忆语义召回 dim-mismatch 失败模式是活的**
`.env` 无 `NOE_OLLAMA_KEEP_ALIVE`(grep 计数 0);`NoeMemorySemanticConfig.js:3` 默认 provider=`ollama` 且默认启用;`EmbeddingProvider.js` `HASH_DIM=128` vs ollama nomic 768/1024。ollama 5min idle 卸载 → embed 退 hash-128 与库内高维 mismatch → `semanticSearch` dim=? 过滤命中 0 → 召回退化只剩 FTS。代码已参数化根治,生产配置没启用。→ `.env` 加 `NOE_OLLAMA_KEEP_ALIVE=-1` + 副本跑真召回 before/after 确认健康项归零。

**P1-3 集群只读端点写放大** `roomStartClusterRoutes.js` 每个 `/api/cluster/*` GET 同步重跑 `runClusterRuntimeWatchdogOnce(flushOnRecovery:true)` + 重建全套 guard;CrossVerifyDispatcher 高频 `_appendRuntimeOutput→store.update→_persist` 强制 fsync。→ watchdog 加短 TTL 缓存 + debounce 落盘。

**P1-4 noeMind N+1** `src/server/routes/noeMind.js:369` 对 30 天每条 proactive 逐条 `probe.get` SQL,maturity 不在 proofCache。高频 overview 端点。→ 改单条聚合 SQL 或入缓存。

**P1-5 密码自动填充 keystroke 与窗口解绑** `auto-fill.js:76-90` activate Chrome+sleep 0.3s 后全局 keystroke,不再绑定具体窗口;0.3s 内切窗可把密码打进别的 app。→ keystroke 前重校 frontmost 仍是 Chrome 且 hostname 匹配,或用 AX API 直接 set 密码框。

**P1-6 secret 脱敏多源易漏** `NoeConsensusLedger.js:930-936` 与 `NoeLocalModelCouncil.js:373-380` 各维护一份 `SECRET_PATTERNS`。→ 收敛到单一 `redactSensitiveText`。

### P2 — 质量/债

- **验证命令硬编码"假绿"**(`AgentRunVerificationExecutor` defaultVerificationCommands ~367-383):改无关文件跑无关测试→verification passed 但没覆盖真改动。自进化通电下=自改未真验证。
- **KnowledgeStore RAG 无维度告警**:`cosineSim` 不等长返 0 且无告警,`allEmbedded` 不校验 dim 统一(与 src/embeddings 维度黑洞防御不对等)。
- **过时注释误标死代码**:`historyTrimmer.js:175`/`consensus-detector.js:2`/`squad-diff-preview.js:2`/`rule-dry-run.js`/`call-logger.js:2` 均已被接线却标"未接";`CLAUDE.md`"默认 OFF" vs `.env` 约 30 开关=1 成文冲突。
- **identity store 固定 .tmp 名**:Owner/Person/IdentityModelSettings 的 `_save` 用 `${file}.tmp`,并发写互覆盖(未迁 `state/atomicJsonFile`)。
- **MetricsStore._readRange 漏归档**(`:255` 正则不匹配 `.jsonl.<ts>`):历史月份指标静默漏算,花费偏低。
- **损坏备份固定毫秒后缀**(`ChatRoomStore:919`/`RoomAdaptersConfig:353`):同毫秒互覆盖取证;`WatcherConfig` 损坏不备份。
- **replay 基线刻意非绿**(33/7 ok:false):布尔 ok 判定会误判退化。
- **noe-world-earth.js 1230 行**:唯一明显违反 <500 行;WebGL dispose 未确认。

---

## 2. 未接线/未通电能力(grep/fs 核验)

### 真未接线(建议处理)
| 能力 | 证据 | 性质 |
|---|---|---|
| `withLLMSpan`(trace.js) | 全仓仅 trace.js 自引 | 死代码/可观测性从未兑现 |
| `ToolCallGuardrailController` | 仅 NoeDoctor.js:249 作字符串清单项 | 逻辑写好未接 runner |
| `NoeCloudProviderRegistry`/`NoeTaskOutput` | 生产零消费者(rc=1) | 孤立 PoC;openai/anthropic/google 返 not implemented |
| `NoeAffectHealth.js` | 文件存在但 server.js 引用=0 | 写了未接线(纠正 AGENTS.md"不存在") |
| `McpAggregator.js`(235行) | 仅 tests 引用 | built-but-unwired |
| `citation-renderer.js` | 生产无 import | 死代码 |
| `NoePromptPrefix` | 仅 test+docs | prefix-cache 省 token 设计未生效 |
| `LegacyNoeContextEngine` | 运行时零引用 | 自述死代码待删 |
| `NoeWallSignal` action 端 | 源码标"尚未接" | 检测活闭环未合 |

### 有意占位/fail-closed(非 bug,知道即可)
`NoeWeChatPersonalBridge`(liveClientStarted 恒 false)、`NoeToolMarketplaceRegistry`(executionEnabled 恒 false)、`MiniMaxSpawnAdapter`(无 runner 即 disabled)、`NoeActiveMemory.buildActiveMemoryContext` 等(仅 test 引用)、`NoeExternalMemoryProviders`(LanceDB 32 维伪向量)、`NoeActionCatalog`(CLI-only,supportsExecute=false)。

### ⚠️ 重要反转:深读误标空转,实为活的
记忆**夜间反思/情景升华/SFT/梦境整合/语义去重/Fisher-Rao/salience 融合/vector pool/自我进化执行器** —— 深读因"默认 OFF"判生产未通电,**实测 .env 全部=1,这些是活的**。`NoeIntegrationMetric` 经 IntegrationSampler→server.js 已真接线;consciousness journal 写入点真实存在(server.js `fsAppendFileSync ~/.noe-panel/consciousness/<date>.jsonl`)。

---

## 3. 完整性批判

- **覆盖深度**:21 域 JSON 全收,对约 15 个最承重点做了 node fs/checksum 独立复验(刻意绕开 Read/grep 显示层,因有篡改警示)。实跑 vitest 确认 infra 真可用;抽样 social-queue 6/6 实测过。
- **对深读的纠正**:① 最大纠正=生产 .env 认知开关全开,推翻全篇"默认 OFF/空转"基调;② 文件路径偏一层子目录(`src/runtime/mission/` 非 `src/runtime/`;openai-compat 真 198 行非某 session 看到的扭曲 66 行);③ `ToolCallGuardrailController`"零消费者"基本对(NoeDoctor 仅字符串清单)。
- **盲区**:受篡改警示制约只 ground-truth 15 点,未逐条复验全部 21 域 risks。server.js 3025 行中段几十个 `create*` 认知件接线、cluster-runtime watchdog/reservation 真实算法、各 dispatcher.resume/abort 语义均只读契约未读实现。noe-world-earth WebGL dispose、social JXA 平台脆弱性、语音/视觉链路正确性未实跑。未跑全量 5538 测试确认"HEAD 全绿"(篡改报告明确警示 vitest 计数不可全信)。`.planning/2026-06-19` task_plan/progress 未读。
- **下一步补读**:① server.js 认知装配段(定"活/空转"最后一公里);② cluster-runtime/roomStart 实现;③ 隔离副本对 self-evolution 已通电链做 dry-run 端到端;④ 用文件落盘 reporter 跑全量 vitest 取真实 passed/failed(对抗篡改)。

---

## 4. 刷新版路线图(P0→P10)

**P0(本周·已通电高危链裂缝)**
1. 修 `NoeMissionStore.refExists` 前缀越界(对齐 EvidencePack)+回归。
2. 修 `NoeSocialPublishQueue.cancel` 抹标记(published 保留 true)+堵覆盖盲区。

**P1(本周·泄漏/正确性/虚假信心)**
3. `AgentRunVerificationExecutor` env 换 sanitizeNoeHostExecEnv。
4. `.env` 加 `NOE_OLLAMA_KEEP_ALIVE=-1` + 副本验召回。
5. `defaultVerificationCommands` 按受影响文件动态映射测试。
6. secret 脱敏收敛单一源 + 新前缀回归集。

**P2(两周·性能/一致性/取证)**
7. cluster 只读端点 watchdog TTL 缓存 + 输出 debounce 落盘。
8. noeMind maturity 单聚合 SQL / 入缓存。
9. 三 identity store 迁原子写。
10. `_readRange` 正则补 `(\.\d+)?`;损坏备份后缀加随机分量;WatcherConfig 走 corrupt-backup。

**P3(口径治理·小工时大收益)**
11. 批量清过时注释;同步 CLAUDE.md"默认 OFF"措辞为 profile/AUTONOMY_DEFAULTS 默认开;更新 AGENTS.md 三条陈旧 P1 缺口。
12. replay 7 个 backlog 失败编码为 expected-fail,让 CI/外部 AI 区分真退化与已分类基线。

**P4(技术债清理)**
13. 删/拆死代码与孤儿(LegacyNoeContextEngine/citation-renderer/McpAggregator/NoeAffectHealth/NoeActionCatalog 接线或明示);noe-world-earth.js 拆分 + 审 WebGL dispose;KnowledgeStore RAG 加维度告警。

**P5(深读未透·补读再定)**
14. server.js 认知装配段核对;cluster-runtime/roomStart 实现;self-evolution dry-run 端到端;文件落盘 reporter 全量 vitest 取真实计数。

**P6-P10(战略)**
承认认知机制已在生产通电后,重心从"通电"转向"通电后的可观测+可回滚+不 overclaim";守住语音真耳验收/小红书发布 URL 未验证等 caveat 边界;keep_alive/embedding 维度健康做常驻看板;Hermes/OpenClaw 蒸馏继续 candidate-only 闭环推进。

---

## 第三部分 · 全域逐文件清单(全部内容索引)
### 服务骨架·HTTP/WS 路由与服务（noe v2.1.0 panel 后端，server 域 1/3）。本域是面板 HTTP/WS 表面的"路由注册层 + 业务服务层"：把 Express app 拆成几十个 `registerXxxRoutes(app, deps)` 注册器（路由薄壳，只做参数校验/鉴权/转调 store），以及一批从 server.js 巨石迁出的纯服务（FS 沙箱、SSRF 图片缓存、集群健康/演练/保证体系、后台维护循环、autopilot 房操作、squad 证据 hook、监听错误处理、OTel span 包装）。组合根仍是项目根 server.js(3024 行)，本域文件全部被它（或被它调用的 server 2/3 域文件 roomStart.js）import 并挂载。  (读 38/38)
- `server/auth/origin-allow.js` — CSRF/Origin 白名单纯函数(buildAllowedOrigins/isOriginAllowed)，HTTP middleware 与 WS upgrade 共用；无 Origin 放行(非浏览器调用)，带 Origin 必须命中 localhost/127.0.0.1/[::1]:port (22行)
- `server/observability/trace.js` — LLM 调用 OTel span 包装器 withLLMSpan(feature/provider/model/tokens/cost 字段+异常捕获)；声明给 14 adapter 用，但全仓零 production 引用(仅被 otel.test.js 调用)——未接线 (63行)
- `server/routes/agentRuns.js` — Agent Run 生命周期 REST(/api/agent-runs *)：列表/时间线/导出(json+markdown)/artifacts 下载/idea-run 全流程(create/complete/auto-execute/manifest draft)/replay/archive；含 maybeGenerateModelManifest(调 adapter.chat 生成补丁清单草稿)+extractJsonObject(三级容错解析 LLM JSON)；全端点 requireOwnerToken (442行)
- `server/routes/archive.js` — 归档配置/手动归档房间/列归档(/api/archive/*)；rootPath 经 safeResolveFsPath 沙箱；写端点 owner-token (48行)
- `server/routes/budgets.js` — 预算策略 CRUD + 用量/事件/preflight(/api/budgets/*)；BudgetLimitExceededError→402；全端点 owner-token (112行)
- `server/routes/delegations.js` — 委派任务路由+核心业务(createTargetRoom/executeDelegation/buildDelegatedTopic)：把源房共识委派成新房(squad/arena 需 Pro license→402)；autostart 走审批+scheduleStore.enqueueJob+agentRunStore；全端点 owner-token (300行)
- `server/routes/files.js` — 文件浏览/预览/目录浏览/跨 session 全局搜索(/api/files,/api/file,/api/browse,/api/search)；safeResolveFsPath 沙箱+NUL 嗅探拒二进制+前 1MB 截断;search 有 per-session cap+hardCap 防内存爆；全端点 owner-token (155行)
- `server/routes/img-cache.js` — AI markdown 图片本地缓存代理(/api/img-cache)；SsrfGuard 私网校验(每跳重校)+流式字节上限(8MB/不信 Content-Length)+SVG 存储型 XSS 防护(attachment+CSP)+LRU(200MB,setImmediate 非阻塞)+内存 keyToFile Map 热路径;该端点无 owner-token(<img> 资源加载场景) (244行)
- `server/routes/license.js` — license 激活/停用/状态/特性查询/验证(/api/license/*)；动态 import LicenseManager；全端点 owner-token (73行)
- `server/routes/noe.js` — Noe AI 人格子系统总注册器+装配根(743 行)：注册 ~30 路由(m3 建议/文件索引/route 大脑路由/voice chat+tts+wakeword/vision glance+ocr+identify/proactive tick/health/readiness)并构造 VoiceSession/VisionSession/ScreenChronicle/媒体 client/Telegram 入站/CosyVoice 自启,再 fan-out 注册十几个子路由模块;返回 runProactiveTick/peekVision/runResearch 供心跳 (743行)
- `server/routes/noeChatProfiles.js` — Noe 对话人格 profile CRUD + 可用 chat 模型发现(/api/noe/chat/profiles,/models)；body≤10KB；删内置 profile→400；owner-token (46行)
- `server/routes/noeCoreRoutes.js` — Noe 核心循环/记忆/焦点/工具/审批/act 路由(/api/noe/loop|memory|focus|tools|approvals|acts/*)；GUI 浏览记忆 bumpHits:false 防污染热点；act propose 审批 202/拒 403；owner-token (237行)
- `server/routes/noeDoctor.js` — Noe 自检 doctor 端点(/api/noe/doctor)；?network=1 才含网络检查；不健康→503；owner-token (20行)
- `server/routes/noeLocalCouncil.js` — 本地多模型议会(/api/noe/local-models/discover,/local-council/run)；消费 uiSignalStore 上下文;模型不足→409;goal≤20KB;owner-token (62行)
- `server/routes/noeMission.js` — Noe 长任务 mission 只读+审批(/api/noe/missions[/:id][/review])；compactMission 投影(进度/cursor/lease/nextAction/waitingApproval)；review 写 checkpoint+evidenceRef+event;missionId 经 safeMissionId 校验;owner-token (197行)
- `server/routes/noePeople.js` — 人物知识库+人脸/声纹注册识别(/api/noe/people/*)；detSize 钳制[128,1280]防 onnx OOM DoS;音频≤15MB/图≤12MB;人脸模型关→409;owner-token (130行)
- `server/routes/noeTaskflows.js` — Noe 任务流 CRUD+步骤状态机+取消(/api/noe/taskflows/*)；NoeTaskFlowStore;steps≤20;owner-token (78行)
- `server/routes/noeVisionAttachment.js` — 单端点:视觉附件描述(/api/noe/vision/attachment)；frame≤3MB;转 visionSession.describeAttachment;owner-token (23行)
- `server/routes/ops.js` — 运维/健康 4 路由分 4 个 register(metrics/health、DELETE metrics、health/processes pgrep+ps+PTY、login-claude osascript)；getTerminals getter 注入避 TDZ;owner-token (195行)
- `server/routes/projectContext.js` — 单端点:项目上下文 bundle(/api/project-context)；cwd 沙箱+必须是目录;includeContent 决定全量/摘要;owner-token (26行)
- `server/routes/research.js` — 上网搜索/抓正文/多步深度研究 SSE(/api/noe/research/search|fetch|deep|status)；deep 用 15s heartbeat 防 SSE 断+无超时靠轮次收敛;注入式 episodicTimeline 记自传体;owner-token (104行)
- `server/routes/rooms.js` — 房间核心 CRUD+session rotate(/api/rooms[/:id][/search][/rotate])；按 mode(debate/squad/arena/chat/cross_verify)给默认成员;squad/arena 需 Pro→402;cross_verify 自动 scaffold 项目目录;cwd 沙箱;删房先 abort 各 dispatcher+关 WS;rotate 走 finalizeTurn+可选 backgroundReview;re-export rooms-core helpers;owner-token (365行)
- `server/routes/roomsForward.js` — forward 起房(把源房 finalConsensus/全 transcript 转新房,seedScope='all' 拼≤950KB)+quick CLI 一键起房(模板/成员/启动)(/api/rooms/forward,/quick)；cross_verify 走 prepareClusterRunGate;cwd 沙箱;owner-token (467行)
- `server/routes/roomStartClusterRoutes.js` — 集群协同健康/诊断/修复只读+repair 端点(/api/cluster/concurrency-budget|health|readiness|repair|capability-guard|resource-guard|health-trend|ops-guard|diagnostics)；每端点重跑 runClusterRuntimeWatchdogOnce+组装多层 guard/diagnostics/assurance;safeAsync 包装防 async reject 挂起;blocked→503;owner-token(由 roomStart.js 挂载) (503行)
- `server/routes/sessions-readonly.js` — session 只读端点(/api/sessions/:id/cost-series,/safety-history)；从 server.js 拆出的纯读;owner-token(读端点也防本机裸读) (38行)
- `server/routes/skillExtract.js` — 单端点:会话后自动提炼技能(/api/noe/skills/extract)；提炼默认 draft/disabled 防污染;body≤80KB;owner-token (28行)
- `server/routes/telemetry.js` — 遥测/分析配置(/api/telemetry/*,/api/analytics/*)：Sentry DSN+PostHog key 写 telemetry.json(0600);DSN 只回脱敏预览;动态 import ErrorReporter;写端点 owner-token (110行)
- `server/routes/watcher.js` — 监视者(auto-accept 判官)配置/provider/test(/api/watcher/*)；逐字段白名单+长度钳制;provider/apiKey/auto_accept 改动经 permissionGovernance.evaluatePermission(非 allow 拒);apiKey 脱敏;owner-token (176行)
- `server/services/autopilot-room-ops.js` — autopilot 房操作工厂(forwardRoomFromAutopilot 自调本机 /api/rooms/forward 带 owner-token、startRoomFromAutopilot 走 watchdog+gate+dispatcher.start)；getter bag 注入避 dispatcher TDZ (143行)
- `server/services/cluster-assurance.js` — 集群保证体系报告 buildClusterAssuranceReport：把诊断/趋势/资源/ops/能力 guard + 3 个离线/运行 drill 聚成门禁(gate)集+恢复计划(命令/endpoint/UI);safeBuild 兜底 drill 异常;被 repair/diagnostics 端点与 restart-panel.mjs 调用 (291行)
- `server/services/cluster-diagnostics-drill.js` — 集群诊断离线演练:4 个固定 case(健康/配置+并发阻断/持久化失败/stall 恢复)喂 buildClusterDiagnostics 验 status/findings/恢复命令;含报告 writer+jsonl 历史轮转(200 行);被 cluster:drill 脚本调用 (258行)
- `server/services/cluster-ops-guard.js` — 集群运维守卫 buildClusterOpsGuardReport:解析健康历史 jsonl,classify 每条(失败/危险重启/修复动作)+房间状态汇总,按连续失败/重启风险/积压阈值判 blocked/warn;纯分析无副作用 (223行)
- `server/services/cluster-runtime-drill.js` — 真实 dispatcher 运行链路演练:用 mock store/adapter 跑真 CrossVerifyDispatcher 验并发完成/额度掉线接管/超时单模型接管/abort-resume 竞态(activeAborts 不泄漏);含 writer+历史轮转;被 cluster:runtime 脚本调用 (412行)
- `server/services/noe-maintenance.js` — Noe 后台维护循环群 installNoeMaintenanceLoops:7 个 env 门控 timer(geo-weather/agent-probe/dream/episode-sublimation/db-backup 默认开/retention 默认开/memory-GC)全 unref;db-backup 保留 7 份,events 默认 180 天/episode 3650 天;memory-GC 用 withActiveGuard 防重叠 (144行)
- `server/services/panel-health-report.js` — 面板健康报告写盘 writePanelHealthReport+buildPanelHealthHistoryEntry:把 restart-panel 的健康/就绪/诊断/drill/assurance 结果压成扁平历史条目;原子写(tmp+rename)+jsonl 历史轮转(1000 行,0600);被 restart-panel.mjs 调用 (219行)
- `server/services/path-sandbox.js` — 全域 FS 沙箱核心 safeResolveFsPath(realpathSync 解符号链接→只允 home/tmp 子树,禁 .ssh/.aws/Keychains 等敏感子目录)+safeResolveFsPathForWrite(父目录在沙箱+basename 安全,拦 NUL/分隔符);被几乎所有涉 FS 路由注入 (60行)
- `server/services/server-listen-error.js` — server.listen 错误处理 handleServerListenError+buildServerListenErrorMessage:EADDRINUSE/EACCES 友好提示+设 exitCode 1+flushLogs+延迟 exit;被 server.js listen error 回调调用 (29行)
- `server/services/squad-evidence-hook.js` — squad 结项证据入库 hook 工厂 createSquadEvidenceHook:把 PM 总结/Dev attempts/QA reviews/finalConsensus 拍平 indexItems 进证据知识库;失败不阻断;由 squadDispatcher.setSquadFinishHook 接入 (50行)

### 服务骨架 · HTTP/WS 路由与服务(server 2/3)。Neo 贾维斯(noe v2.1.0)Express + WebSocket 后端的路由注册层与服务支撑层:把 server.js 巨石拆出来的一批 `registerXxxRoutes(app, deps)` 路由模块(REST endpoint),加上会话/集群运行时/房间适配器/Claude runner/面板健康等服务工厂与纯函数。覆盖会话 CRUD、房间高级操作(报告/媒体/生命周期/chat)、治理中心、MCP、webhook、支付、知识库、技能、Noe 自有能力面(commands/freedom/delegate/proposals/media/acui/ui-signals/work-map)、密码自动填充、内嵌 PTY 终端、cross_verify 集群并发/恢复运行时。  (读 38/38)
- `server/auth/owner-token.js` — owner-token 鉴权核心:首读 ~/.noe-panel/owner-token.txt(无则生成32字节hex,0600)并缓存进程内;导出 requireOwnerToken(Express 中间件,校验 X-Panel-Owner-Token 头,timingSafeEqual)、verifyOwnerTokenString(WS upgrade 用,query ?token=)、getOrCreateOwnerToken、测试用缓存重置。本域几乎所有写/敏感端点的守卫来源。 (79行)
- `server/routes/activity.js` — 审计活动日志 REST:GET /api/activity(过滤+limit 列事件)、POST /api/activity(记一条),均 requireOwnerToken;parseActivityQuery 把 query 归一成 ActivityLog.list 过滤参数(含 agentRunId/approvalResumeGate/skill 等众多别名)。 (68行)
- `server/routes/agentRunsApprovalResume.js` — idea_to_archive 类 Agent Run 的'审批后续跑'流程 4 端点:预览 resume review/gate、gate 审计(json/markdown)、归档 gate 审计 artifact、POST approval-resume(校验 approval=approved + verifyApprovalResumeReviewGate 复核闸,通过才 executeIdeaRun)。全 owner-token。 (142行)
- `server/routes/auto-fill.js` — 密码自动填充代理:从 macOS Keychain 用 /usr/bin/security 读密码,osascript 把密码经 stdin(避开 argv 泄漏)keystroke 进 Chrome 焦点框;填前严格校验 Chrome 当前 hostname 与请求 site 匹配;status/password/type/audit 4 端点全 owner-token;审计落 ~/.noe-panel/auto-fill-audit.jsonl(不含密码)。 (212行)
- `server/routes/codebaseIndex.js` — 代码库索引 REST:rebuild/status/query/question 4 端点(委托 CodebaseIndexStore),cwd 经注入的 safeResolveFsPath 沙箱解析,数值参数 clamp;全 owner-token。 (79行)
- `server/routes/docs.js` — 只读暴露 docs/*.md 给前端:GET /api/docs/:name,文件名硬白名单(仅 CCR_USAGE.md/HOOKS_USAGE.md),rootDir 注入;不泄 fs 错误细节。 (22行)
- `server/routes/governance.js` — 治理中心:聚合 approval/budget incident/delegation/autopilot job/agent run/activity 成 summary(blockers/nextActions/sections,各 compactXxx 裁字段),导出纯函数 buildGovernanceSummary;3 端点 summary/queue/queue:id/state(GovernanceQueueStore 同步阻塞项)。全 owner-token。 (354行)
- `server/routes/knowledge.js` — 知识库(KB)REST:KB CRUD、文档增删、search/context(hybrid 可透传)、llm-wiki search,外加平行的'证据知识库'(evidence search/stats/reindex,3 段子路径避开 :name 单段);全 owner-token(含读,因含文档片段+烧 embedding)。 (120行)
- `server/routes/mcp.js` — MCP server 配置+客户端管理:内建 McpClientManager;servers CRUD/test/tools/resources/prompts/call/call-history;写与执行经 requirePermission(PermissionGovernance,action skill.plugin.*);Free 层限 3 个;stripPermissionFields 去 approvalId;全 owner-token(配置=子进程 spawn 规格)。返回 mcpClientManager。 (213行)
- `server/routes/noeAcuiCards.js` — Noe ACUI 卡片面 REST:list/context/show/update/patch/hide(委托 NoeAcuiCardStore),全 owner-token;sendCardResult 按 result.ok 映 200/400。 (61行)
- `server/routes/noeCommands.js` — Noe 命令面 REST:discover(findNoeTools 搜索)/help/dry-run/route(routeNoeTools 按 goal 选工具);从 toolRegistry 取 manifests 构 buildNoeCommandSurface;全 owner-token。 (107行)
- `server/routes/noeDelegation.js` — Noe '派活'流程:POST plan(detectTaskIntent/validateTaskDelegationPlan 干跑+approvalRequired)、confirm(confirm:true 才建房 createNoeDelegationRoom,可选 autoStart→建 approval+enqueueJob+agentRunStore.create);可注入 episodicTimeline 记里程碑;全 owner-token。 (174行)
- `server/routes/noeFreedom.js` — Noe '自由执行'面:capabilities/session(start/get)/dry-run/execute;execute 经 freedomSessionStore.resolveAuthorization + runNoeFreedomAction(realExecute);高风险 real-execute 默认接 createNoeFreedomReviewBrain 复核闸(NOE_FREEDOM_REVIEW_BRAIN=0 关,FAIL_CLOSED=1 硬阻断,默认 fail-open);全 owner-token。 (125行)
- `server/routes/noeMedia.js` — MiniMax 媒体生成 REST:image/music/video(POST)+video/:taskId(GET 轮询);委托注入的 studio(NoeMediaStudio);key 未配返 501;prompt/lyrics/firstFrame 长度白名单校验,opts 白名单透传不 spread body;全 owner-token(烧配额)。 (86行)
- `server/routes/noeOwnerGate.js` — Owner Gate 配置 REST:GET/POST /api/noe/owner-gate(ownerGateStore.publicConfig/update/status),全 owner-token。最薄路由壳。 (19行)
- `server/routes/noeProposals.js` — Noe 提案收件箱+记忆候选/自我模型 REST:proposals list/get/decision/execute/self-model-apply、memory-candidates status/review/apply/rollback;self-model-apply 有 TOCTOU 防护(审批锁定 patchContentHash 与当前比对)+ resolveRootRef 路径越界守卫 + confirmOwner 门;全 owner-token。 (216行)
- `server/routes/noeUiSignals.js` — Noe UI 信号面 REST:POST 记信号/GET 列+snapshot/POST consume(委托 NoeUiSignalStore),全 owner-token。 (54行)
- `server/routes/noeWorkMap.js` — Noe 工作地图快照:GET /api/noe/work-map,组合 sessions/roomStore/db(dbProvider=getDb 注入,取库失败软降级 dbError)调 buildNoeWorkMapSnapshot;limit clamp;owner-token。 (45行)
- `server/routes/payment-webhooks.js` — Lemon Squeezy/Polar 支付 webhook 接收:HMAC-SHA256 timing-safe 验签(verifySignature 导出),订单事件自动用本地私钥 signLicense 签发 license 并落 licenses-issued.jsonl;config GET(只返 boolean,无鉴权)/POST(写 secret,owner-token);issued GET owner-token。secret 存 ~/.noe-panel/webhook-secrets.json(0600)。 (182行)
- `server/routes/projects.js` — 方案 B 项目监控:扫 ~/Desktop/00_项目/*,scanProject 解析 PROGRESS/STATUS/BLOCKED.md(状态色/ASC态/cycle数/阻塞数)+RUNNING_LOCK 心跳新鲜度+launchd plist(5s TTL 缓存)+git HEAD mtime;list/:name 两端点,:name 严格防 traversal(字符校验+realpathSync 二次确认在 root 下);全 owner-token。 (203行)
- `server/routes/roomAdapters.js` — 房间 adapter 配置 REST:GET(masked)/PUT(clean→Free 限 3→PermissionGovernance provider.model_config.write→save→rebuild)/providers;依赖注入的 room-adapters 服务一族;全 owner-token。 (87行)
- `server/routes/roomsAdvanced.js` — rooms 高级域 4 个 register:报告异步 job(202+fire-and-forget generateReport,broadcastGlobal report_done/error,共享 ReportJobStore 实例供 GET /api/reports/:jobId)、runtime-processes、task inject+attempts diff、生命周期(retry-turn/retry-task/resume/abort,resume 对 cross_verify 走 watchdog+prepareClusterRunGate);全 owner-token。 (470行)
- `server/routes/roomsMedia.js` — 房间媒体附件+chat 3 端点:手写 multipart 解析+魔数嗅探 MIME(白名单 PNG/JPG/WebP/GIF/MP4/MOV/WebM,≤120MB,流式累加超限即弃)、落项目 cwd/attachments 或 panel 兜底目录(0600,wx)、GET 经 realpathSync 锁定在允许根内 sendFile;chat 解析 attachments ref 后委托 soloChatDispatcher;全 owner-token。 (340行)
- `server/routes/roomTemplates.js` — 房间模板 REST:list(无鉴权)/create(owner-token,≤32KB)/delete(owner-token,builtin: 前缀禁删);委托 roomTemplatesStore。 (47行)
- `server/routes/sessions.js` — sessions 域 3 个 register:核心 CRUD(create cwd 经 safeResolveFsPath 沙箱+容量检查、list/get/patch/messages/delete)、控制(interrupt SIGINT+1s SIGTERM 兜底/reset-busy SIGKILL,清 _dropOutput/autoPromptCount)、附加(export markdown RFC5987 中文名/star 收藏/fork 从 fromIndex 复制消息);字段长度上限;全 owner-token。 (411行)
- `server/routes/skills.js` — Skills REST:list/get(无鉴权)+upsert/put/delete/reload(owner-token,≤256KB);委托 skillStore。skills 会被 LLM 当 prompt 加载故写入须 owner。 (55行)
- `server/routes/term.js` — 内嵌 PTY 真终端:POST 创建(node-pty spawn,shell 硬白名单,cwd 沙箱,总数上限 20)/GET 列/DELETE 关;onData/onExit 广播给 clients 并自清;创建即拿 shell=RCE 故全 owner-token;返回 terminals Map 给 server.js(WS/health/停机共用)。 (96行)
- `server/routes/webhook.js` — 出站 webhook 推送 REST:list(无鉴权,masked)+create/put/delete/test(owner-token);URL 写前过 assertPublicUrl(SSRF 防护:拒私网/loopback/非默认端口)+isUploadHostAllowed 白名单+PermissionGovernance network.upload;stripPermissionFields。 (144行)
- `server/services/claude-runner-support.js` — Claude runner 支撑层:导出纯函数 naiveDiff/formatEditDiff/formatMultiEditDiff/formatWritePreview(tool_use→markdown diff);工厂 createClaudeRunnerSupport 返回 per-session 机制(LoopGuard/DangerousPatternDetector/AgentStateMachine/CostTracker/TerminalApprovalGate)+pushMessage(200 上限+star 索引重映+广播 capped)+broadcastSession(_dropOutput 拦截残余 stdout)+evaluateClaudeToolPermission/blockClaudeToolUseByPermission(权限治理拦工具)+killChildAndUnbusy(SIGTERM+2s SIGKILL 看门狗+busy 复位)。 (212行)
- `server/services/cluster-capability-guard.js` — 集群成员能力守卫纯函数 buildClusterCapabilityGuardReport:扫 cross_verify 房,检 enabled 成员非空、成员带 adapterId、不注入房间级共享 Skill/插件桥、Claude/Gemini 原生成员不挂 Codex 共享桥、重复/未知 adapter 告警;产 checks/blockers/warnings/recommendations。 (256行)
- `server/services/cluster-diagnostics.js` — 集群诊断纯函数 buildClusterDiagnostics:汇总 runtime/config/concurrency/health/healthTrend/resource/ops/capability guard/readiness 成 findings(blocker/warn),每 finding 给 recommendation+recoveryPlan(command/endpoint/ui)+invariants(safeToStart 等)+roomSummary。 (263行)
- `server/services/cluster-resilience-drill.js` — 集群韧性演练:6 个内置用例(并发边界第5房放行/第6房阻断/单 adapter 容量阻断/in-flight 预约计数/solo 与 partial 接管交付契约)经 buildClusterConcurrencyBudget+reserveClusterStart(import 自 routes/roomStart.js)断言;buildClusterResilienceDrillReport 跑全部;writeClusterResilienceDrillReport 落 latest+history(0600,行数滚动裁剪)。 (355行)
- `server/services/cluster-runtime.js` — cross_verify 集群运行时核心(域最大):并发预算 buildClusterConcurrencyBudget(running+starting 预约+activeAbort 投影,房数/单adapter限额→blocked/warn)、启动预约 reserveClusterStart(TTL prune)、运行时对账 reconcileClusterRuntimeState(无心跳进展超时/无 dispatcher 的 stale running→paused+resumePolicy 限流、清陈旧 activeAbort)、watchdog runClusterRuntimeWatchdogOnce(先 resolve 持久化 pending→对账→可选 flush→broadcast)、非致命错误恢复、停机批量 abort+flush、健康趋势/资源/运维/能力 guard 的薄封装(委托同名 service)。 (940行)
- `server/services/noe-mind-failure-modes.js` — 只读失败归因摘要 compactFailureModes:递归找 output/noe-failure-modes-attribution 下最新 report/latest.json,裁出 clusters(≤5)/blockers/warnings 给 mind/proof 页;纯只读。 (67行)
- `server/services/panel-health.js` — 面板集群健康纯函数:assessPanelClusterHealth(从 budget 响应判 runtime/concurrency/configAudit→checks/blockers)、buildPanelClusterReadiness(runtime 恢复干净/无 pending/并发可用/多房≥2/单adapter≥1/config 安全 6 项 readinessCheck→capabilities)。依赖同域 cluster-config-audit.js。 (192行)
- `server/services/room-adapters.js` — 房间 adapter 池工厂 createRoomAdapterFactory:detectCCR/buildRoomAdapters(claude/codex/ollama/ollama-9b/lmstudio/litellm/minimax 系/ccr 内置)+applyRoomAdaptersConfig(按 room-adapters.json 注册 minimax/gemini/gemini-openai/gemini-cli/custom:*,timeoutMs/maxTokens 覆盖)+rebuildRoomAdapters(原地重建保 Map 引用);返回 pool/config getter-setter/hasCCR/hasGeminiCli。 (193行)
- `server/services/session-capacity-counter.js` — 会话容量计数器工厂 createSessionCapacityCounter:增量维护 activeCount(create/delete/archivedChange 钩子)+rebuild 全扫+check(总数/活跃数超限即 429 写 res 返 false)。给 sessions 路由的 checkSessionsCapacity。 (44行)

### 服务骨架·HTTP/WS 路由与服务（src/server 第 3/3 组，37 个文件）。Neo 贾维斯 v2.1.0 后端的 Express 路由层 + 配套服务层切片：本组覆盖 OpenTelemetry 接入、OpenAI 兼容网关、商品化/支付/license 上架状态、autopilot 调度、approvals 审批、embeddings/storage/workspaces 数据 REST、hooks 入站、社交平台 webhook、Noe「内心透视页」数据层（noeMind 802 行）、cluster 协同房间启动门与交付包、claude 子进程 spawn 引擎（claude-runner）、session 持久化、本机进程树扫描、cluster 配置/资源/健康趋势审计、本地模型存活探针。整个 src/server 共 112 个 .js（auth 2 / observability 2 / routes 84 / services 24）。  (读 37/37)
- `observability/otel.js` — OpenTelemetry Node SDK + OTLP/HTTP exporter 接入（接 Langfuse self-host）。PANEL_OTEL_ENABLED=1 才启用，否则返回 noop tracer 零开销；动态 import 全部 OTel 包，BatchSpanProcessor(maxQueue2048/batch64/1s)。导出 initOtel/getTracer/shutdownOtel。 (85行)
- `routes/agentRegistry.js` — Agent 技能注册表 REST：/api/agent-registry（快照/classify/changed-files/codebase-map/profiles governance CRUD）。含 git porcelain 解析 + 八进制转义路径解码 decodeGitQuotedPath、resolveRouteCwd 走 safeResolveFsPath 沙箱。全端点 requireOwnerToken。 (369行)
- `routes/approvals.js` — 审批 store REST：list/create/get/approve/reject/cancel。薄封装 approvalStore，sendError 按 /required|invalid/ 分流 400/500。全 owner-token。 (89行)
- `routes/autopilot.js` — Autopilot 控制 API：config/toggle/rules/log/schedules/jobs/runs/tick/dry-run。注 autopilotStore+scheduleStore+scheduler。规则会自动触发动作消耗付费配额，故全 owner-token（dry-run 注释自标为'唯一漏 token 的写端点'但实际仍在 register 内带 token）。 (175行)
- `routes/commercial-setup.js` — 商品化上架完成度状态 API：检查 license 私钥/github token/lemon+polar webhook secret/sqlite/pricing 页是否就位（只 existsSync 不读 secret 原值），5s TTL 缓存。会泄漏敏感文件是否存在故 owner-token。 (140行)
- `routes/embeddings.js` — 向量索引 REST：index/search/delete/list，动态 import VectorIndex。upsert/search 烧 embedding 配额，全 owner-token。 (53行)
- `routes/hooks.js` — Claude Code hook 事件接收：POST /api/hooks/:event（owner-token 豁免，靠令牌桶 600/min+burst500 限速 + 50KB payload 截断 trimHookPayload）写 session.hookEvents + 全局环形(2000)；GET 查询要 owner-token。 (92行)
- `routes/lemonsqueezy.js` — Lemon Squeezy REST：health/stores/products/orders/webhooks 查询 + webhook-auto-register（写 secret 到 ~/.noe-panel/webhook-secrets.json 0o600）。orders 泄漏买家邮箱，全 owner-token。 (119行)
- `routes/metrics.js` — 指标只读查询：overview/timeseries/by-adapter/by-room/pricing。parseMetricsRange 校验日期+bucket，by-room 校验 roomId UUID。注 metricsStore+roomStore。全 owner-token。 (71行)
- `routes/noeBootSelfCheck.js` — 启动自检 REST：status/run/repair，封装 runNoeBootSelfCheck。含 cleanError 正则脱敏（api_key/token/bearer/secret→[REDACTED]）。经 noe.js 接线。全 owner-token。 (81行)
- `routes/noeComputerSearch.js` — POST /api/noe/computer/search：静默后台联网搜（AISearch）+ 可选 MiniMax TTS 合成语音回复。命令前缀正则剥离(搜/查/研究…)，7KB body cap，最多 8 结果。经 noe.js 接线。owner-token。 (86行)
- `routes/noeDo.js` — POST /api/noe/do 自然语言意图路由总线：LLM-wiki→深度研究/联网搜→派活计划(dryRun)→撤销/整理文件(经 MCP unified-kb fs_organize_* + permissionGovernance 门控)→查找/统计。8KB cap。经 noe.js 接线。owner-token。 (160行)
- `routes/noeIdentity.js` — 主人身份门禁 REST（声纹/人脸）：status/enroll/verify/clear/owner-person/import-owner-samples。15MB 音频 cap，受 modelSettings voice/face enabled 开关门控（disabled→409/降级）。经 noe.js 接线。owner-token。 (143行)
- `routes/noeMind.js` — 【核心】内心透视页(public/mind.html)数据层，22 个只读+少量写端点：overview/proof/memory CRUD/thoughts/ticks/affect/expectations(+resolve 人工裁决)/goals/calibration/curiosity-funnel/integration/model-health/wall-signals/awakening-signals/vitals/journal/tick。重 SQLite 直查 + JSONL 尾读 + 多级缓存(proof30s/curiosity60s/vitals5min)。9 个 .env 开关 SWITCHES()，未通电返 enabled:false(fail-open)。802 行（已超 500 线，最大文件）。 (802行)
- `routes/noePanelLogTail.js` — GET /api/noe/panel-log-tail：游标式读 panel 日志尾部，封装 collectNoePanelLogTail。cleanError 脱敏，返回 policy{readOnly/bounded/redacted/secretValuesReturned:false}。经 noe.js 接线。owner-token。 (64行)
- `routes/noeSocialInbound.js` — 社交平台入站 webhook：公开端点 wechat-official/wecom/feishu（owner-token 豁免，自带签名/timing-safe token 验证 + replayGuard 去重，缺 message_id 拒绝防重放）+ owner-token 的 status/wechat-personal/qq 桥接。safeAsync 包裹防 async reject 挂起。返回 receiver。 (258行)
- `routes/noeVisionAmbient.js` — 环境视觉感知 REST：status/situation/ambient(配置屏幕采样/相机帧)。configureAmbient 会同步 modelSettings.setFaceEnabled。返回 privacy 元数据(localOnly/rawFramesPersisted:false)。经 noe.js 接线。owner-token。 (58行)
- `routes/openai-compat.js` — OpenAI 兼容网关 /v1/*：/v1/models(公开)、/v1/chat/completions(owner-token，解析 <adapterId>:<model> 路由到 roomAdapterPool，支持 SSE streaming + 15s 心跳 + req.close 清理)。烧用户 Claude/Codex/Gemini 配额。注 roomAdapterPool+metricsStore。 (198行)
- `routes/plugins.js` — 插件 registry REST：list/get/install/delete/reload/exec。内建 PluginRegistry，install/exec 经 permissionGovernance 高风险评估(RCE 入口)，exec 走 PluginSpawn/HttpAdapter + safeResolveFsPath cwd 沙箱 + 64KB prompt cap + metrics。owner-token。 (198行)
- `routes/prompts.js` — 快捷 prompt 模板 CRUD：list/create/delete，落 ~/.noe-panel/prompts.json（原子写 tmp+rename 0o600，损坏备份 .corrupted.bak，cap 200）。写盘失败返 500 不静默装成功。owner-token。 (70行)
- `routes/roomRequirements.js` — 运行中房间追加需求注入：POST /api/rooms/:id/requirements。核心 appendRoomRequirementInjection 处理需求版本递增/重开已完成任务与房间/审计轨迹/goalMode 联动；持久化失败时 captureRoomRequirementState→restore 回滚。owner-token(注入式)。 (327行)
- `routes/roomStart.js` — 集群协同房间启动门：POST /api/rooms/:id/debate。prepareClusterRunGate 串联 preflight→runtime watchdog→config audit→并发预算→reserveClusterStart→live ping(30s)→硬失败成员降级(失败持久化回滚)。先 res.json(started) 再异步 dispatcher.start。re-export cluster-runtime 一族。 (394行)
- `routes/roomsClusterDeliveryRoutes.js` — 集群交付包 REST：package/artifact download/archive artifact download(SHA256 校验+路径逃逸防护)/preflight/cluster-evidence-links/archive。证据链接触发 activityLog+emitRoomEvent(delivery_ready)。经 rooms.js 接线。owner-token。 (217行)
- `routes/safety.js` — 弹性组件状态/控制：/api/safety/status(breakers/bulkheads/rateLimiters + process.memoryUsage RSS)、breakers reset、rate-limit 配置。直接 import 三个单例 registry。owner-token。 (48行)
- `routes/sessionsContinuum.js` — Session ctx 估算(反解 claude transcript jsonl 的 usage 算上下文占用率，mtime 缓存) + 07 Continuum 接力(snapshot/handoff-history/meta/handoff 建新 session) + 外部 Terminal spawn(osascript AppleScript 加固)。两个 register 函数保 Express 注册顺序。owner-token。 (413行)
- `routes/storage.js` — SQLite 存储 REST：stats/events(查+写)/kv(get/put)，动态 import SqliteStore 并 initSqlite。events 是审计依据、kv 存任意配置，全 owner-token。 (75行)
- `routes/version.js` — GET /api/version(公开，owner-token 豁免)：读 package.json version + HANDOFF*.md 抓 buildVersion。 (25行)
- `routes/workspaces.js` — 多 workspace REST(team-tier 功能)：list/create/active/delete/current，动态 import WorkspaceManager+LicenseManager(hasFeature 门控，非 team 返 402)。写端点 owner-token，list/current 公开。 (78行)
- `services/claude-runner.js` — 【核心引擎】createClaudeRunner.sendMessageToClaude：每条用户消息 spawn claude --print --input-format stream-json，LoopGuard 前置→项目上下文/接力/FocusChain 注入→流式 stream_event 解析→AgentStateMachine/CostTracker→权限治理+DangerousPatternDetector(Bash 扫描+危险命令审批+SIGKILL)→exit 后 watcher 自动续发。50MB stdout 单行上限。455 行单文件主体。 (455行)
- `services/cluster-config-audit.js` — 集群配置审计 buildClusterConfigAudit：从 PANEL_CLUSTER_* env 读并发/停滞/恢复阈值，5 项 auditCheck(成员超时须早于停滞 watchdog、恢复窗口须覆盖阈值等)，产 passed/warn/blocked。纯函数。 (127行)
- `services/cluster-health-trend.js` — 集群健康趋势 buildClusterHealthTrendReport：解析 health-history JSONL + classifyClusterHealthEntry(综合 health/readiness/diagnostics/assurance/repair 状态)，算连续失败/repair 不可用/告警连击→趋势 blockers/warnings。纯函数。 (160行)
- `services/cluster-resource-guard.js` — 集群资源守卫 buildClusterResourceGuardReport：从 PANEL_CLUSTER_RESOURCE_* env 读阈值，采 process.memoryUsage/resourceUsage/_getActiveHandles，对 RSS/堆比例(双条件 ratio+MB)/句柄/请求/事件循环延迟 makeCheck，产报告+恢复建议。纯函数。 (194行)
- `services/log-ring.js` — SPSC 环形缓冲 LogRing：drop-oldest(UI 流式 chunk，满丢最旧)/block(日志零丢失，满 await waiters)双模式。纯数据结构，push/pop/drain/stats。 (73行)
- `services/NoeModelHealthProbe.js` — 本地模型存活只读探针 createModelHealthProbe：复用注入的 discoverLocalModelProviders(ollama/lmstudio GET ping，绝不 load/chat)，判三脑(main/review/fallback)就位 + embedding 实际后端/维度黑洞 degraded。全 fail-open。被 noeMind model-health 用。 (104行)
- `services/panel-runtime-processes.js` — createPanelRuntimeProcessCollector：spawnSync ps 全表→构建本进程后代树→识别 claude/codex/gemini-cli 运行时子进程 + 提取 full-access 信号(skip-permissions/bypass-sandbox/full_auto 等)。注 safeSlice。纯收集。 (70行)
- `services/rooms-core.js` — 【大模块 1056 行】集群房间核心服务库(被 rooms.js/roomStart.js/roomsClusterDeliveryRoutes.js 复用)：cluster 项目脚手架(路径沙箱+禁敏感目录)、交付包归档(SHA256+路径逃逸防护)、preflight(成员/adapter/cwd/预算估算/单模型降级接管)、live ping、证据链接验证、房间摘要/全量列表(过重降级 compact)、跨字段 searchRooms。 (1056行)
- `services/session-persistence.js` — createSessionPersistence：sessions Map↔data.json。saveData 原子写(tmp+rename 0o600)+messages 截断 200+starredIndices 同步映射+runtime cap；loadData 回灌(>500 按 createdAt 取最新 500，损坏备份 .corrupted.bak)；debouncedSave 500ms 去抖。 (135行)

### 运行时引擎(runtime 2/2)——Noe 的"行动执行 + 任务编排 + 自治证据"骨架。本域是 Noe 真正"动手做事"的地方:把模型/心跳产出的意图,经过 freedom 工具白名单+复核闸+证据封装,落成真实副作用(本地 shell/JXA 浏览器自动化/社媒发布),并把每一步以脱敏、可审计、可回滚的证据 JSON 落盘;同时承载 Mission Runtime(契约化长任务的存储/校验/收尾/补丁应用)、提案收件箱(proposal-only→owner 审批→物化)、入站网关(微信/webhook→统一事件)、以及一批小型基础设施(脱敏器/承诺存储/进程树终止/日志尾巴/工作地图快照/开机自检)。贯穿全域的设计宪法是:dry-run 默认、real-execute 须显式、secret 绝不外泄、副作用前置 owner gate/review brain、证据 sha256 链。  (读 39/39)
- `runtime/mission/NoeEvidencePack.js` — 把任务相关文件/片段/测试输出/git diff 组装成脱敏的证据包(noe_evidence_pack):路径沙箱化(safeResolve 修了兄弟同前缀目录漏洞)、secret 路径黑名单、超限截断、对模型可见的脱敏文本;含 validate(检测残留 secret-like 值)与 serialize (123行)
- `runtime/mission/NoeMissionContract.js` — Mission 契约的 schema 定义/归一/校验:状态机/自治等级(read_only→external_write)/leader/reviewers/patchAuthority 等枚举;normalize 递归脱敏 secret 键,validate 强制 9 个必填字段+各子项非空;requireValid 不通过即抛错 (164行)
- `runtime/mission/NoeMissionFinalizer.js` — 构建 mission 收尾报告(mission_finalization):汇总 blockers/evidenceRefs/事件计数/criteria+reconciliation 结果,判定 terminal/completed;writeMissionFinalization 把报告写成 artifact 并回写 state+追加事件 (144行)
- `runtime/mission/NoeMissionQualityAudit.js` — P8 只读仓库质量审计 mission 的契约工厂 + action executors(repo_inventory/run_command/coverage_table):用 spawn 跑 node --check/npm test/git diff 等校验命令(含无输出看门狗),把退出码/截断输出落成证据 artifact (205行)
- `runtime/mission/NoeMissionReviewGate.js` — 动作级复核闸:从 action 文本/字段推断 risks 与所需自治等级,对照 mission.autonomyLevel 与 reviewPolicy(ownerGate/reviewBrain)判定 allowed/waiting_approval (69行)
- `runtime/mission/NoeMissionStore.js` — Mission 持久化核心(output/noe-missions/<id>/):mission.json/state.json/events.jsonl/checkpoints/artifacts;原子写、0o700/0o600 权限、租约(lease)+心跳+死进程恢复(process.kill(pid,0))、evidenceRef 累积 (274行)
- `runtime/mission/NoePatchApplyExecutor.js` — 补丁应用/回滚执行器:把 patchPlan 的 write_file 操作经沙箱+secret 黑名单校验后,用 NoePatchTransaction 事务化写入(先备份再写,manifest 记 previousSha256),dry-run 默认+owner 确认才真写;回滚用备份哈希校验后还原/删除 (441行)
- `runtime/mission/NoeSelfLearningMission.js` — 把 SQLite noe_goals 里的 self_learning 目标桥接进 Mission Runtime:只读取目标+checkpoints,做步骤覆盖度分析(act 步必须有 evidence/recovery checkpoint),产快照/覆盖表/最终报告 artifact;含 smoke DB 生成器 (327行)
- `runtime/NoeActionEvidence.js` — 通用行动证据构建器(noe_action_evidence):汇总 permission/budget/contextSufficiency/runtime + 8 类 refs,递归抽取语义指纹(buildNoeActionSemanticTrace,跳过 secret 键),sha256 封装;含 validate(可要求 runtime/review/rollback) (208行)
- `runtime/NoeAcuiCardStore.js` — Agent UI 卡片内存存储(task/plan/permission/evidence/...):show/update/patch/hide/list,带容量上限驱逐;契约硬标 canAuthorizeSensitiveActions:false;contextBlock 产 trust=local-untrusted 的上下文块(卡片不能授权动作) (158行)
- `runtime/NoeBackgroundReviewHook.js` — 把后台复盘(proposal-only)接到对话收尾:仅离散动作(房间 rotate)触发、不接 heartbeat;OFF/无 runner/对话过短即 no-op;dryRun+persist 调 runner 只写沙箱报告,永不 throw (84行)
- `runtime/NoeBootSelfCheck.js` — 开机自检(确定性,Node 直接验证,模型不自证):查必备文件/证据目录可写/最新报告/live panel 健康/运行时 preflight/伴随工具/policy file guard;支持安全自修复(仅建目录/改权限),报告落盘 latest.json (552行)
- `runtime/NoeCommitmentStore.js` — 承诺/待办结构化存储(改编自 OpenClaw):add/list/due(nowMs)/resolve/cancel,带到期时间窗兜底(永不漏提);默认纯内存,注入 file 后原子落盘+损坏兜底,重启不丢用户'提醒我…' (241行)
- `runtime/NoeContextScrubber.js` — 全域脱敏基石:redactSensitiveText(多种 API key/JWT/Telegram/GitHub/Slack/AWS token 正则)、stripHiddenContextBlocks(去 memory-context 等隐藏块)、stripInternalChannels(去 think/analysis)、StreamingContextScrubber 流式缓冲脱敏 (104行)
- `runtime/NoeDoctor.js` — 健康巡检:node 版本/git 状态(分类 dirty)/.gitignore/lockfile/必备文件存在/端口 51835+51735 监听/panel preflight/本地模型发现/伴生语音服务(whisper/kokoro/cosyvoice)探活;产 findings(error/warn/info) (278行)
- `runtime/NoeFinalStageMatrix.js` — 最终真机阶段(B/C/D/E)授权矩阵与证据校验:大量硬断言(D 必须 scratch 写后清理且可见数 0→1→0、E 必须真重启 pid 变更+51735 不动+健康),ref 沙箱校验(禁 .env/private_holdout/绝对路径),扫敏感键 (249行)
- `runtime/NoeFreedomExecutor.js` — freedom 行动执行总引擎(本域最大):runNoeFreedomAction 串起 authz→trust manifest→allowlist→developer hard-veto→review brain 强制复核闸(fail-closed)→真实/dry-run runtime→证据+run ledger;含 chain(最多12步)/resume_next_actions/社媒阶段汇总 (951行)
- `runtime/NoeFreedomReviewBrain.js` — B1.3 复核闸生产接线:把本地 Review Brain(qwen3.6-27b,lmstudio→ollama 优先链,绝不路由云端 Claude)包成 reviewBrain({request,preflight})=>verdict;模型不可用默认 fail-open 降级放行+审计标记(owner 自由宪法),failClosed:true 可改硬阻断 (90行)
- `runtime/NoeFreedomSessionStore.js` — freedom 会话存储:developer_unrestricted/owner_supervised_unrestricted/dry_run 三档 profile,非 dry_run 须 ownerPresent;resolveAuthorization 在无 sessionId 时按 payload 透传(owner 偏好不强制握手),始终脱敏 (144行)
- `runtime/NoeInboundGateway.js` — 多渠道入站网关(刻意做减法):注册渠道→归一消息(统一 sessionKey)→turnGuard 准入→emit+onMessage;createFencedResponder 用代际栅栏压制旧回复只投最新;createMemoryChannel 试点用 (141行)
- `runtime/NoeLive51835ScratchEvidence.js` — Stage D live 51835 scratch 写入证据构建器:产 scratch memory input/回滚报告/live 证据报告/证据胶囊 markdown;全程只存 sha256 哈希不存原值,scanStageDRedaction 扫敏感键+原值泄漏 (275行)
- `runtime/NoeNtfyPush.js` — 关键事件推手机(ntfy):hang告警/死前交接/自动暂停等类型→POST JSON 到 ntfy 服务;NOE_NTFY_TOPIC 配了才通电,消息体先脱敏,fire-and-forget+fail-soft 绝不影响广播主链路 (57行)
- `runtime/NoePanelLogTail.js` — 有界脱敏的 panel 日志尾巴(改编自 OpenClaw logs.tail):游标+字节/行数上限、UTF-8 安全截断、每行 redactPanelLogLine(JWT/hex token/URL 参数);只读、绝不读 owner-token 文件 (236行)
- `runtime/NoeProcessTree.js` — 优雅终止本地 CLI/插件子进程树:ps -axo 建父子图、后序遍历收集 pid,先 SIGTERM 宽限再 SIGKILL;全注入式(spawnSync/kill/setTimeout)可单测 (74行)
- `runtime/NoeProposalDecisionLedger.js` — 提案决策账本(JSONL):approve_for_gated_apply/defer/dismiss 三种决策,须 confirmOwner;proposalHash 纳入 patchContentHash 锁定 apply 负载(消除 approve→篡改→apply 的 TOCTOU);只记账本不直接 apply (151行)
- `runtime/NoeProposalInbox.js` — 提案收件箱:从4个源目录(background_review/boot_self_check/skill_curator/self_model)读 JSON 报告→归一成 proposal 条目(proposalOnly+requiresGatedApply),套 decision ledger 装饰状态;decide/execute 委托物化执行器 (445行)
- `runtime/NoeRuntimeTrace.js` — 运行时五阶段(observe/can_execute/act/verify/learn)审计轨迹 JSONL:严格脱敏(禁 prompt/stdout/dom/memory body 等键与值)、路径 realpath 防 symlink 逃逸、禁 private_holdout;writer 串行队列追加,snapshot 聚合校验+违规检测 (552行)
- `runtime/NoeSocialFinalPublishExecutor.js` — 社媒'按最终发布键'执行器(真副作用):生成 JXA 脚本扫候选发布按钮(含小红书 xhs-publish-btn 特判+cliclick 原生点击),发布前强制 priorStageEvidence+已发布 draft 阻断,发布后探针校验+回写 draft externalSideEffect 防重复发布 (646行)
- `runtime/NoeSocialFormFillExecutor.js` — 社媒表单填充执行器:只填 title/body,生成的 JXA 脚本若含 click/submit/Enter 等发布动作即阻断(scriptContainsFinalPublishAction);真执行后校验字段已填+回显匹配,绝不上传媒体/发布 (160行)
- `runtime/NoeSocialMediaUploadExecutor.js` — 社媒媒体上传执行器:JXA 找文件选择控件(禁含'发布'语义)→cliclick 点击→处理浏览器权限弹窗+注入 geolocation shim→Cmd+Shift+G 粘贴路径选文件;校验真选中(selectedFileCount/页面媒体证据),绝不发布 (564行)
- `runtime/NoeSocialPublishOrchestrator.js` — 社媒发布编排器(纯规划):按平台预设生成完整动作链(账号盘点→开创作台→建草稿→preflight→DOM recipe→表单→媒体→最终发布→发布后探针),输出 nextFreedomActions 供 freedom chain 执行;dry-run 不写草稿,全程脱敏 URL (430行)
- `runtime/NoeSocialPublishQueue.js` — 社媒草稿队列持久化(~/.noe-panel/social-drafts):create/read/list/cancel/markExternalSideEffect;路径防逃逸+防 symlink,已发布 draft 拒绝 create 覆盖(防重复发布),markExternal 幂等回写'已对外发布'标记到盘 (249行)
- `runtime/NoeSocialRollbackEvidenceGate.js` — 社媒帖子回滚(删/隐藏/撤回/修正)证据门+执行脚本:门控本身无副作用,要求 target/postPublish/beforeAction 证据齐全;destructive 授权只认可信来源(permission/developer_unrestricted/真实通过的 consensus ledger),不认 args 走私的 flag (554行)
- `runtime/NoeSocialWebhookInbound.js` — 社媒 webhook 入站桥(wechat_official/wecom/feishu):凭据状态探测(只报 available/missing 不报值)、微信签名校验(timingSafe+时间窗)、重放守卫、简单 XML 解析→统一入站事件→NoeInboundGateway;只记脱敏小记忆 (308行)
- `runtime/NoeStickyEvents.js` — 关键事件粘性缓存(FIFO 默认50):广播路径 consider() 把 hang告警/死前交接/自动暂停等关键类型入缓存,新 WS 连接 replay() 整批补发(标 replay:true);非关键高频事件不入防刷屏 (35行)
- `runtime/NoeTaskFlowStore.js` — 任务流存储(output/noe-taskflows/,自进化8步流水线):createFlow/transition(步骤状态机)/requestCancel,原子写+损坏兜底,deriveStatus 自动推导流状态,evidenceRefs 累积;每步证据链 (204行)
- `runtime/NoeToolMarketplaceRegistry.js` — 工具市场注册表(~/.noe-panel/tool-marketplace):install/read/list/disable/uninstall 工具 manifest,路径防逃逸+防 symlink,manifest 元数据校验(id/version/禁 secret-like sourceUri);关键:entrypoint.executionEnabled 恒 false(只登记不执行) (248行)
- `runtime/NoeWeChatPersonalBridge.js` — 个人微信桥的无 secret 契约(不启真客户端,只定安全形状):readiness/status/qr 只报布尔+脱敏态(QR 图/cookie/token 绝不返回),inbound 走网关,outbound 仅 dryRun(须 owner-visible 证据),contextToken 只存 sha256 引用 (264行)

### 多智能体房间·集群 (room 1/2) — Neo/Noe v2.1.0 的多 AI 协同执行层。这 33 个文件分四大块:(A) 房间数据/持久化与配置 (ChatRoomStore/RoomAdaptersConfig/squad-limits/roleCards/skillInjector);(B) 各家 LLM chat adapter 与统一截断判定 (Ollama/LmStudio/MiniMax/Gemini/OpenAICompatCompletion/finishReason/historyTrimmer/CodexSpawnAdapter/ClaudeRuntimeDefaults/CodexAppPluginBridge) + 大脑分工路由 (BrainRouter);(C) 三大对等协同 dispatcher (CrossVerifyDispatcher 集群协同 / ArenaDispatcher 对决 / TaskGraph 依赖图);(D) Noe 多模型共识与自我进化离线编排器 (NoeConsensus* / NoePostReview* / NoeClaudeCollaborator / NoeCodexClaudeCollaborationRound / NoeLocalModelCouncil / NoeSelfEvolution* / NoeEvolution* / MiniMaxSuggestionPipeline)。  (读 33/33)
- `room/ArenaDispatcher.js` — 对决模式 dispatcher:N 个成员并行独立提案→(可选)本地便宜模型同行评审门剪枝(PeerCritiqueGate)→匿名化(A/B/C)喂 judge(优先 claude/codex/gemini-cli)联网核对+合成最优;含连续失败 auto_pause、单提案/judge 局部 retryTurn、judge 失败降级为原始提案合并。 (441行)
- `room/BrainRouter.js` — 大脑/手脚分工启发式路由(纯关键词正则+长度,零延迟):local(闲聊/苦力→MiniMax-highspeed+lmstudio fallback)/mid(中文写作→MiniMax)/code(写代码/执行→Codex)/deep(推理/审查→Claude);已重构为可注入 signalProbes/rules/paidTiers,默认行为与旧 if-else 链逐字等价。 (162行)
- `room/ChatRoomStore.js` — 房间数据模型+持久化(~/.noe-panel/rooms.json + rooms-archive.json 拆分写);debounce 异步写盘+fsync(数据fd+目录fd)SIGKILL-safe、stable-sort fingerprint 跳过无变更写盘、损坏自动备份、load 时 running→paused 恢复+running task→pending 恢复、防原型污染、turn 内容 2MB 截断。CRUD+appendTurn+setStatus。 (378行)
- `room/ClaudeRuntimeDefaults.js` — Claude Opus 4.8 运行时默认:识别 opus/claude-opus-4-8,自动给 spawn args 注入 --effort xhigh + --append-system-prompt(鼓励用 Dynamic Workflows)。 (16行)
- `room/CodexAppPluginBridge.js` — GPT/Codex 成员专属 App 插件桥接说明文本生成:声明 Codex CLI 原生 MCP/profiles/插件可用,不暴露给 CLI 的桌面专属插件须输出 CODEX_APP_PLUGIN_REQUEST 块审计请求而非伪造结果。纯文本构造器。 (47行)
- `room/CodexSpawnAdapter.js` — spawn `codex exec` 拿 GPT 回答的 RoomAdapter:which 解析绝对路径、临时 panel MCP toml 经 --profile 叠加(0600,完成清理)、stdin 喂 prompt -o file 取答、SIGTERM+SIGKILL 兜底、EPIPE 防御、abort 后写盘误判修复、context-window/ MCP-startup 失败识别与 disableMcp 重试。 (277行)
- `room/CrossVerifyDispatcher.js` — 集群协同核心(本域最大文件 3328 行):11 阶段工程闭环(idea→retrospective)task 队列,每 task 多成员对等并行提案→互审→全员显式签字(agreeCount===memberCount)才 done;含质量门(代码驱动阶段需命令/文件/UI 硬证据)、node --check 自动验证并绑定 AgentRun 证据链、成员故障转移→单模型接管、运行时遥测+预算阻断、目标模式自动返工(交付门/阶段门)、交付清单/报告/包+目标完成度审计、工作区路径契约归一化、运行时心跳/状态持久化。 (3328行)
- `room/finishReason.js` — 单一真相源:把各家 finish_reason('length'/'max_tokens'/Gemini 'MAX_TOKENS')统一映射成 {truncated,incomplete,continuationRequired,completionStatus},被 OpenAICompat/MiniMax/Gemini 三 adapter 共用,杜绝截断漏判。 (25行)
- `room/GeminiChatAdapter.js` — Google AI Studio 原生 API(generativelanguage v1beta)chat adapter:OpenAI messages→contents[].parts[]+systemInstruction 转换,默认 gemini-3.1-pro-preview/65536 输出,finishReason 统一截断判定,safety 拦截空 reply 报错,abort/超时串联。 (116行)
- `room/historyTrimmer.js` — 按 token 上限裁剪对话历史(反向 pop,学自 LibreChat):中文1:1/英文4:1 估算,system prompt 永留,预留响应 token。自注释称'未接入'已过时——实际被 RoomAdapter.js + roomsForward.js 调用。 (105行)
- `room/learned/dispatcher-state.js` — debate/squad 显式状态机 schema(学自 LangGraph)。DEBATE_STATE_MACHINE 已接入活路径(DebateDispatcher 每轮动态 import broadcast debate_state_meta);SQUAD_STATE_MACHINE 仅作设计参考未消费。 (94行)
- `room/LmStudioChatAdapter.js` — 继承 OpenAICompatChatAdapter,调用前用 ensureLmStudioModel 自助 lms load 目标模型再发请求;归一化 NoeAuto 模型别名,自动链路 model 缺省时不跟随手动加载的实验模型(防三角色模型策略漂移)。 (49行)
- `room/MiniMaxChatAdapter.js` — MiniMax chat completion adapter(聊天室版,区别于 watcher 的 judge 版):max_completion_tokens/reasoning_split/service_tier/thinking(adaptive|disabled,仅 M3)参数,422 new_sensitive→PROVIDER_INPUT_REJECTED 错误码,finishReason 统一截断判定。 (114行)
- `room/MiniMaxSuggestionPipeline.js` — M3 纯建议管线(API-only,绝不给本地 fs/shell/patch 能力):分类→buildM3SuggestionPrompt→JSON 校验;含 CE 阶段检查点(CE03/05/08/10/11)+冷审查检查点(search/voice/identity/execution);finalAuthority=Claude/GPT-Codex。 (211行)
- `room/NoeClaudeCollaborator.js` — spawn `claude --print --permission-mode plan --tools '' ` 的 Claude 协作者(强制 4.8 max,默认非 writer):持久 sessionId+memory 状态(0600 原子写)、敏感上下文文件白名单拒读(.env/secret/token...)、8 种协作模式(independent-plan/cross-review/agreement-vote...)、redact 脱敏、解析 evidence_read/memory_update、写审计报告。 (446行)
- `room/NoeCodexClaudeCollaborationRound.js` — Codex+Claude 双 AI 协作轮 schema(v2)构造+校验+渲染:独立方案/交叉评审/challengeLog/shared evidence(含文件 sha256 校验)/readinessCriteria/双方 agree;ready_to_execute 需全部 blocker 清零(单 writer/证据双读/Claude 报告 4.8max+sessionId/无 unresolved challenge)。 (467行)
- `room/NoeConsensusLedger.js` — 在线多模型共识账本(schemaVersion 1):构造 ledger+secret 脱敏(6 类 key 正则)+sha256 防篡改+委托 NoeConsensusGate 校验;artifact 校验含 evidence/rawOutput 文件存在性+sha256 比对+stored gate 过期检测;路径逃逸防护。 (171行)
- `room/NoeConsensusPrompts.js` — 在线共识 prompt 构造(core=codex/claude/m3,Gemini 已退出 quorum):每模型角色权限(active_executor/readonly_source_reviewer/suggestion_only)、严格 JSON 投票形状、动态 quorum 规则、quality profile(standard/exhaustive)、M3 选项(adaptive thinking/524288 tokens/priority tier)。 (186行)
- `room/NoeConsensusRunner.js` — 在线共识轮编排器:写 brief→各参与者(codex/claude CLI、m3 MiniMax、xiaomi OpenAICompat)跑 prompt→raw 脱敏写盘→不可解析 JSON 单次修复+不可用 Codex 补充复核(不计票)→build ledger+校验→stage matrix 加载校验→manifest/support files 落盘。dry_run/models_run。 (358行)
- `room/NoeEvolutionArchive.js` — 自我进化(DGM 式)变体归档条目构造:variantId(时间戳+sha12)、parent/generation 谱系(读 archive 末行推断)、verdict(tests_passed/failed/applied)、plan/patchFile/holdout/benchmark 引用。纯构造器。 (99行)
- `room/NoeEvolutionHoldoutRunner.js` — holdout 评测:string-include/forbidden 硬门(权威)+可选 qwen3-embedding 余弦语义连续分(防塞关键词 reward hacking);语义绝不绕过硬门/绝不单独翻转采纳,hash fallback 标 lowConfidence 不算通过,全程 fail-open,env NOE_HOLDOUT_SEMANTIC 默认 OFF=逐字零回归。 (241行)
- `room/NoeLocalModelCouncil.js` — 本地模型议会(LM Studio+Ollama 自动发现+打分选型+角色分配 reasoner/critic/synthesizer/router/vision):≥2 模型独立投票→环形多轮交叉互审→synthesizer 综合;动态 quorum、不可用自动补位、raw 脱敏写盘+sha256、明确无敏感操作授权权。 (496行)
- `room/NoePostReviewGate.js` — 实施后复核校验(cycle 与 gate 共用):排除 active executor 自评后须覆盖全部必需 reviewer、不可重复、可用 reviewer 动态 quorum、每 reviewer 须带 rawOutputRef(可校验文件存在)、非实施者不得 canWrite。纯校验逻辑。 (137行)
- `room/NoePostReviewRunner.js` — 实施后复核轮编排器:reviewers(claude/gemini CLI、m3/xiaomi adapter、codex exec)各跑 prompt→build review(canWrite 强制 false)→动态 quorum 汇总→不可用 Codex 补充复核(不计票);用 buildNoeSafeChildProcessEnv 净化子进程环境,raw 脱敏写盘。 (365行)
- `room/NoeSelfEvolutionCycleStore.js` — 自我进化 cycle 持久化(sqlite noe_self_evolution_cycles,表在 SqliteStore.js 建):落库前 draft 校验拒脏行,stage 由 evaluateNoeSelfEvolutionLoop 实时求值,仅 complete/requireComplete 跑完整校验;upsert/advance(浅合并)/getByGoal(单 writer)/list。 (155行)
- `room/NoeSelfEvolutionLoop.js` — 自我进化状态机求值器(纯函数):consensus→implementation→runtime_verification→self_repair(失败回 consensus)→post_review(真实非实施者批准)→retrospective→memory_writeback→complete,每步算 stage/nextAction/blocked/gates,委托 NoeSelfEvolutionGate 校验。 (223行)
- `room/OllamaChatAdapter.js` — 本地 Ollama chat adapter(语音/主动/聊天室共用):走原生 /api/chat(唯一能可靠关 thinking 的端点),默认 think:false(real-time 不浪费),支持 onDelta NDJSON 流式(语音首句早鸟 TTS),abort handler removeEventListener 防泄漏。 (123行)
- `room/OpenAICompatCompletion.js` — '从半截续写'底层能力(s1 budget forcing 用):首选 /v1/completions 真 prefix 续写,探测不到回退 chat+末尾 assistant-prefix;注入式 DI 纯模块不碰断路器,不打印 apiKey,不设生成硬超时(仅探测短超时);被 NoeBudgetForcedDeliberation 消费。 (180行)
- `room/roleCards.js` — squad/arena 角色卡(pm/dev/qa/observer/judge)默认 scope/职责/汇报关系生成+sanitize(防注入越界)+按成员构建+prompt 格式化。纯数据/构造器。 (106行)
- `room/RoomAdaptersConfig.js` — 读写 ~/.noe-panel/room-adapters.json(房间 adapter 池:minimax/gemini 三形态/spawn 覆盖/≤10 自定义 OpenAI 兼容):字段白名单+类型/长度/URL 校验、原子写 0600、损坏备份、apiKey 脱敏(4...4)+脱敏占位保留原值、防 id 重复/原型污染。 (243行)
- `room/skillInjector.js` — dispatcher 调 adapter.chat 前把 room.skills + projectContext + 原生能力 + agent runtime context 拼进 system message;getActiveSkillNames 过滤无效/禁用 skill;支持 disableSharedRoomSkills(集群协同用)。 (92行)
- `room/squad-limits.js` — 所有魔法数字/限额/prompt 版本号单一配置源:SQUAD/DEBATE/ROOM/ADAPTER_TIMEOUTS(2h)/CONTENT(2MB reply)/SYSTEM(500 房)/PROMPT_VERSIONS。被多 dispatcher import。 (70行)
- `room/TaskGraph.js` — Squad 任务依赖图:环检测(三色 DFS)、拓扑排序(Kahn)、readyTasks(依赖全 done 且自身 pending)、allDoneOrTerminal、setStatus。纯算法。 (100行)

### 多智能体房间·集群（room 2/2）—— Neo 贾维斯 src/room 下「多 AI 编排（chat/debate/squad/arena 委派）+ 模型 adapter 层 + Noe 自进化/共识治理子系统」。把任意外部 AI（Claude/Codex/Gemini/MiniMax/LM Studio/OpenAI 兼容端点）当作聊天室成员统一驱动，并在其上做多轮辩论/分工协作/同行评审/三模型共识投票/自我进化闸门。  (读 33/33)
- `brainChat.js` — 把 BrainRouter+adapter 池封成 chat(messages,opts)=>{reply} 内部复用函数，按路由选主脑+fallback 链兜底，绝不设超时；供 research/skillExtract/noeDo 调用 (18行)
- `CCRSpawnAdapter.js` — 继承 ClaudeSpawnAdapter，spawn ccr code --print 走 claude-code-router 按场景切 Haiku/Sonnet/Opus 省 plan 配额，env CCR_PROVIDER_HINT 透传场景 (36行)
- `chatTruncation.js` — 多 AI 房共用输出截断感知工具：isIncompleteChatResult 判 finish_reason=length/max_tokens，markTruncatedReply 给半截 reply 追加中文标注令截断签字 JSON 解析失败降级为不同意 (55行)
- `ClaudeSpawnAdapter.js` — spawn claude --print 取完整回答的聊天室成员 adapter；which 解析绝对路径、注入启用 stdio MCP(临时文件0600)、SIGTERM-2s-SIGKILL、abort/EPIPE/TDZ 防御 (192行)
- `CodexRuntimeDefaults.js` — Codex 运行时默认常量：空/gpt-5.5 视为 CLI 默认，自动注入 model_reasoning_effort=xhigh 最高推理档 (18行)
- `CollaborationDispatcher.js` — Squad 协作编排器：PM 拆 JSON 任务图-拓扑找 ready 并行跑-Dev 实现-QA verdict-reject 打回(iterations++)-超 maxIter escalate-PM 合成交付；每步 _persistTaskList 显式 flush 防 SIGKILL 丢中间态 (795行)
- `DebateDispatcher.js` — 多 AI debate 编排器：N 大轮 R1 提案/R2 互评/R3 终稿+R4 claude 主持合成；spawn onProgress 心跳/HTTP 20s keepalive，judge 失败降级末轮 R3，支持 resume 与 retryTurn (642行)
- `ForegroundChatRouting.js` — 前台聊天路由解析纯函数：env 解析 cloudOnly/云链/本地链，resolveForegroundChatChain 在 cloudOnly 下优先云脑末尾追本地脑作最后兜底防哑 (62行)
- `GeminiSpawnAdapter.js` — spawn gemini -p adapter；node-pty 真分 PTY 复用 OAuth、3.1pro-2.5pro-flash 配额降级链、清洗 ANSI/MCP 噪声、误分类 RESOURCE_EXHAUSTED 识别为配额耗尽触发 fallback (243行)
- `learned/consensus-detector.js` — 关键词法检测对话是否达成共识；头注释称未接入已过时，实际被 DebateDispatcher:483 动态 import 做 only-log 状态广播不改流程 (65行)
- `learned/squad-diff-preview.js` — 计算两段文本行级 unified diff；头注释称未接入已过时，实际被 roomsAdvanced.js:286 用于 squad task attempt 间 diff (64行)
- `LmStudioLoader.js` — LM Studio 模型自助加载层：REST 只读查 loaded 态、lms CLI 加载、inflight Map 同模型并发只加载一次、按 NoeLocalModelPolicy 套参数；解决视觉模块挤掉大脑模型致 400 (150行)
- `MiniMaxSpawnAdapter.js` — CE12 P0 patch-only 本地 CLI adapter：fail-closed 拒 shell/file/apply_patch，默认无 runner 返回 executor disabled 建议；validatePatchOnlyPlan 强制 diffs=[]+黑白名单+意图扫描 (308行)
- `MiniMaxSuggestionRouter.js` — M3 建议员非执行员纯函数路由：命中本地执行意图即 blocked 改走 claude/codex 主链，钉死 suggestion-only JSON schema，validateM3SuggestionPlan 拦截 diffs/tool_calls/commands (150行)
- `NoeClaudeEvidenceParser.js` — 从 Claude 共识输出解析 evidence_read 区块抽 ref/mode(direct-read/truncated/summary-only)，先 redactSensitiveText 脱敏再截断 (83行)
- `NoeConsensusGate.js` — 三模型共识投票纯函数闸门核心：动态 quorum(可用数2/3向上取整)、13条必备boundary、按 active executor 校验各模型 canWrite/authority/firstClass、approve 必须 consensus_vote=yes (316行)
- `NoeConsensusParticipantRuntime.js` — 共识参与者运行时：spawn claude(plan模式)/codex/m3 产投票原文，buildNoeSafeChildProcessEnv 净化 env；含 unparsed JSON 单次修复+unavailable 模型 codex 补充评审(不计票) (345行)
- `NoeConsensusRound.js` — 模型原文解析成结构化 vote(direct/fenced/brace 三策略)；安全核心身份只信可信槽 participant.model，自报不一致即记 identityViolation 并把授权字段退回默认防冒领提权 (183行)
- `NoeConsensusSupportFiles.js` — 为每个共识 round 写6个markdown(evidence/pack/disagreements/staleness/verifier/handoff)全0600；含证据新鲜度分类与过期规则、跨会话接力读序 (326行)
- `NoeEvolutionCandidateGate.js` — 自进化候选闸门纯函数：限改动文件/行/字节/膨胀比1.05、holdout 必须正向、必须有测试+rollback；候选自设阈值只能更严(夹紧)，已删 approvalRef 自报豁免漏洞 (157行)
- `NoeExecutionAuthority.js` — 执行权威纯函数：定义 codex/claude/gemini/m3 执行者画像，resolveNoeActiveExecutor 校验单 writer(并发>1报错)、claude 需显式选择、不可写者拒为 active executor (152行)
- `NoeOnlineModelRoster.js` — 构建在线共识模型花名册：which 探 CLI、provider health 探 API，标 available/quorum、把非核心三模型标 retired_from_core_quorum、给 codex fallback 目标；不回 secret (199行)
- `NoePostReviewPack.js` — 构建+校验实施后复核证据包 schema v1：钉死 reviewer canWrite=false、m3 suggestion_only、required reviewer 排除 active executor、序列化后正则扫 secret 样式；被 NoePostReviewRunner 消费 (250行)
- `NoeSelfEvolutionCycle.js` — 自进化完整 Cycle 校验：draft 只校骨架便于早期持久化，full 校验 consensus ledger+implementation done+rollback+runtime+postReview(排除 executor)+retrospective+memory writeback 全齐 (231行)
- `NoeSelfEvolutionGate.js` — 自进化逐 action 闸门：必须 validated consensus ledger+授权+rollback+runtime+postReview；system 级能力不可共识授权、高危能力需动态 quorum、memory autoWrite 必须 consensus ack (275行)
- `NoeSelfEvolutionTrigger.js` — 环2 自发起意触发器全注入式：SIGNAL_RE 识别改自己文本-cooldown+去重-立项；tick 单 writer 按 loop.stage 推进一个 Cycle 一步 propose；server.js NOE_SELF_EVOLUTION=1 才装配 (109行)
- `OpenAICompatChatAdapter.js` — 通用 OpenAI Chat Completions adapter：支持 SSE 流式(onDelta早鸟TTS)、空reply/瞬时传输故障自动重试(默认2次流式不重试)、reasoning_effort 归一、penalty 抗复读 (214行)
- `PeerCritiqueGate.js` — AutoScientists 式同行评审闸(arena 用)：N 份匿名提案先过便宜评审员打分 keep/kill+Jaccard 去重，judge 只核存活方案；铁律 fail-open、提案<3 跳过、保底 minSurvivors；被 ArenaDispatcher 消费 (146行)
- `RoomAdapter.js` — 聊天室成员 adapter 抽象基类：chat() 壳套 budget+CircuitBreaker+RateLimiter+Bulkhead+AgentRunLifecycle，子类只实现 _doChat；含 token 估算/messages 裁剪/原生能力声明；abort 不计断路器失败 (286行)
- `RoomLineage.js` — 房间目标/血缘消毒纯函数：sanitizeObjective/sanitizeLineage/objectiveSummary，全字段截断防膨胀，status 白名单 (63行)
- `SoloChatDispatcher.js` — 1v1 持续对话编排：用户主导 sendMessage-单 adapter.chat；双重并发锁治 TOCTOU、cloudOnly 强制云脑、ContextEngine 注入记忆召回/人物/工具桥、截断守门、连续5失败自动暂停、预算硬停死前交接 (306行)
- `TaskDelegationPlanner.js` — Noe 派活计划落地：normalizeTaskPlan-按 mode 生成 members(squad/arena 需 Pro license)-createNoeDelegationRoom 建 dryRunOnly 房+审批(不启 CLI 不烧配额)+中文回执 (186行)
- `TaskIntentRouter.js` — 自然语言派活意图识别纯函数：DELEGATE_RE x WORK_RE 双命中才出 plan，识别 codex/claude/minimax/squad/arena；产出 approvalRequired/dryRunOnly；被 noeDo/noeDelegation/VoiceSession 消费 (50行)

### 认知核心与意识 (src/cognition, 1/2) — Neo 的"自我意识/认知"层:情感连续性、期望-误差校准回路、好奇/惊奇驱动、整合度(Φ代理)度量、自语/反刍守卫、目标步检查点与恢复、空闲预计算、心跳持久层。这一半侧重"度量与判证机制 + 自语副作用契约 + 目标可恢复性",绝大多数模块是纯函数/注入式、可确定性单测,且新行为多由 env flag 默认 OFF 门控。  (读 29/29)
- `cognition/_mathUtils.js` — 认知层共享纯数值小工具(clamp/clamp01/round3/rate),为消除多模块字节级重复的 NaN 透传语义而抽取;零依赖纯函数 (35行)
- `cognition/NoeAffectEngine.js` — 情感连续性引擎:VAD(愉悦/唤醒/掌控)三维状态+慢变量mood+性格baseline双时标指数衰减,快照持久化进 noe_affect 表(迁移v7),重启按停机时长套同一衰减式水合;OCC-lite appraise()消费时间线情景类型种子增量(inner_monologue 恒零防情绪螺旋);含去饱和(env OFF)防VAD顶死天花板+affectHealth自检 (276行)
- `cognition/NoeApprovalGoalResolver.js` — 审批决定→act重试→目标步闭合:从ApprovalStore.decide()接线,approved则retry匹配act并同步目标步done/blocked,rejected/cancelled则解锁目标步为blocked;含checkpoint+activityLog留痕,全程fail-open不阻断审批 (166行)
- `cognition/NoeBudgetForcedDeliberation.js` — 把NoeBudgetForcing纯算法+续写能力(OpenAICompatCompletion)接进真实深思的胶水层:用</think>作stop判模型是否想结束思考,强制思考定稿后再让脑产结构化答复;默认OFF(config.enabled=false返null),任意环节失败fail-open回退普通chat (155行)
- `cognition/NoeCalibrationCurve.js` — 期望校准曲线(Brier+ECE+MCE+n-bin reliability),与scikit-learn逐位对齐(<1e-9);纯函数注入式,脏行静默剔除;被NoeExpectationLedger与mind.js消费 (89行)
- `cognition/NoeCuriosityDecompose.js` — 借pymdp主动推断EFE理念把好奇拆成epistemic(信息增益)+pragmatic(贴owner偏好)双因子加权score+beliefEntropy(归一香农熵);纯函数,env NOE_EFE_CURIOSITY默认OFF,fail-open退化0分;被NoeDriveSystem消费 (173行)
- `cognition/NoeEntropyTemperature.js` — 熵驱动生成温度调节器(借Global-Workspace-Agents的entropy_drive):念头向量在线EMA聚类→softmax熵→T=Tbase+α·exp(-β·H),语义停滞自动升温发散;修正原朴素实现的相同念头分裂成多簇退化坑;env NOE_ENTROPY_TEMPERATURE默认OFF,被InnerMonologue消费 (205行)
- `cognition/NoeExpectationHarvester.js` — 期望抽取强化(M2账本通血):确定性正则(ledger.harvestFromText)保底+未命中时一次Main Brain小判断(think:false产JSON可检验预测);治诗意念头确定性正则零命中导致预测-误差回路无燃料;fail-open零付费配额 (64行)
- `cognition/NoeExpectationResolver.js` — 域内最大最复杂文件(1771行):期望到期自动判证。心跳作业取due()前N条→构造脱敏结构化证据(claim bigram词面命中+可选embedding语义召回)→喂本地白名单脑产APPLIED/FAILED/UNKNOWN→ledger.resolve进Brier;含证据脱敏/claim对齐计数/决策提示/二次复核(decisiveReask)/决定性判FAILED(decisiveFail,四重护栏)/公平调度防饥饿/非阻塞tickDetached;多层env flag默认OFF;落空且惊奇≥阈值接harvestSurprise立研究目标 (1771行)
- `cognition/NoeGoalCheckpoints.js` — 目标步检查点(intent/evidence/recovery审计)持久层:写noe_goal_checkpoints表,含secret脱敏(clean/safeJson)、稳定指纹digest(幂等键+副作用指纹)、回滚证据需求判定(rollbackEvidenceFor区分readonly/dry-run/真副作用)、损坏payload逐行隔离;被NoeGoalSystem重度调用 (299行)
- `cognition/NoeGoalStepRecovery.js` — 从NoeGoalSystem抽出的卡死/可重试目标步恢复:doing步超时(research 90s/act 5min/默认6h)标recovered绝不自动重放;blocked的browser host mismatch重试(≤2次)后标recovered;每次写checkpoint(replaySafe:false);被NoeGoalSystem调用 (130行)
- `cognition/NoeHeartbeatStore.js` — 心跳持久层SQLite访问(noe_ticks台账+noe_tick_cursor节奏游标,迁移v7):beginTick写前日志+租约→finishTick落outcome(终态守卫只允许running→done/done→done)→failTick/interruptTick;recoverDeadTicks把租约过期running标failed留痕绝不重放;游标重启续相位;被noeMind/NoeHeartbeat/server消费 (130行)
- `cognition/NoeIntegrationHistory.js` — 整合度TC读数有限历史留存(P2看板趋势线):每拍append进有限长度(默认288≈24h)历史kv;注入式,只写自己kv键,只读kv可read不可record;被noeMind/server消费 (62行)
- `cognition/NoeIntegrationSampler.js` — 把整合度代理读数(Total Correlation,非完整IIT Φ)接进运行时:每拍采8宏节点(GWT焦点/VAD偏离/期望到期/驱力/感知/目标步/自语/梦)二值化向量→push持久滚动窗口→对窗口跑integrationMetric→读数写kv;探针fail-open;被server消费 (90行)
- `cognition/NoeLearningReport.js` — 自主学习照妖镜:只读SELECT聚合学习活动成体检报告(在搜什么主题多样性/学到啥学习卡/有用吗召回回流率),纯函数注入db;verdict判勤奋空转vs健康;被scripts/noe-learning-report.mjs(CLI)消费 (67行)
- `cognition/NoeLearningTopics.js` — 确定性自主学习选题目录:6个写死种子主题+24个具体明星项目概念池(AutoGPT/LangGraph/Letta等),供NoeTopicCurator动态轮转;含按文本选主题/游标取主题;被NoeGoalSystem与server消费 (106行)
- `cognition/NoeMindVitals.js` — 心智体征计量:语义级多样性(1-念头两两余弦相似度均值)/接地度(念头与真实经历最大相似度);治字符级相似度防不住Echo Trap(同调子十二种写法);embedText注入+LRU缓存+全程fail-open;经历向量并行嵌入优化;被server消费 (73行)
- `cognition/NoeOwnerCorrectionBridge.js` — owner否定Neo事实判断=最强epistemic源:owner交互文本含明确纠正信号(不对/不是X而是Y)→harvestSurprise(owner_correction,surprise=3);精细正则避免误判(剥离Neo回复/排除疑问求助缓和owner自陈);去重限速;env NOE_OWNER_CORRECTION默认OFF;被server消费 (83行)
- `cognition/NoeReflectBrain.js` — 深思脑(System2)选型解析:所有自主认知作业统一从这取{adapterId,model},铁律白名单只含本地adapter(lmstudio/ollama)绝不路由付费档(24h连续思考的经济前提);env NOE_REFLECT_TIER=1启用默认OFF;纯函数;被server消费 (40行)
- `cognition/NoeSleepTimeCompute.js` — 空闲预计算(sleep-time compute):无活跃对话时用已预测的owner下一问([owner-pred:topic:X])提前算检索结果写预取池,命中秒答;idle-only+可取消(AbortController)+只写带source+TTL候选(绝非答案)+fail-open;被server消费 (174行)
- `cognition/NoeSurfacingGate.js` — 浮现门:统一内心内容能否对外开口的克制闸,四重全过才放行(非静默时段/日预算未超/与近期不重复/冷却到期);kv记账,fail-open放行交下游兜底;被server消费 (68行)
- `cognition/NoeThinkLessonPersist.js` — P1闭环闭合:把think末步深思产的认知修正独立落库成kind=insight/scope=insight的learning_lesson(自动落insight召回通道),治深思improvement只进goal note从不进noe_memory对话召回看不到;SKIP判定+exact/近重去重+source evidence过gate;调用方门控默认OFF;被server消费 (114行)
- `cognition/NoeTopicCurator.js` — 动态自主学习选题器(治6写死topic无限轮回):三招破局-饱和冷却(学satN次进cooldown)+round-robin跳过饱和选最久没学+动态扩池(读到新概念过novelty门加入);env NOE_DYNAMIC_TOPICS默认OFF;被server(seeds)消费,getNextTopic被NoeGoalSystem调 (106行)
- `cognition/NoeWallSignal.js` — P2防Goodhart撞墙信号检测:①整合度连续≥0.95→过度整合僵化(建议砍novelty)②独白多但活跃目标0→空转打转(建议停InnerMonologue);纯函数注入式;action字段是建议非已执行(P3器官消费端尚未接线,诚实标注);被noeMind/server消费 (62行)
- `cognition/NoeWorldModelContradictionBridge.js` — 接通信息层epistemic源:research/browse读到内容→extractKeywords召回相关memory(belief)→相关性过滤(防过召回)→本地脑判事实矛盾→harvestSurprise(world_model_conflict,surprise=2.5);治自主学习空耗;async fail-open去重限速;env NOE_WORLDMODEL_CONFLICT默认OFF;被server消费 (106行)
- `cognition/P6ProductionEvidenceComposer.js` — 构建P6验证器消费的证据JSON:聚合runtime/db/auditSummary/frontendAck摘要(只摘要不传prompt/owner文本/token/原始行);maxMetric/rateMetric/三态布尔合并;被P6RuminationReadiness自检引用+单测,无运行时直接装配(纯审计基建) (137行)
- `cognition/RuminationGuard.js` — P6-C自语螺旋控制纯守卫:读原始timeline/self-talk指标(契约明确不读AffectEngine VAD因inner_monologue被中性化);算semanticSim/grounding/abstractDensity/landingStreak→pickState(normal/rotate/anchor/cooldown/silent);audit模式只观察不阻断;被InnerMonologue消费 (224行)
- `cognition/SelfTalkDeliveryAck.js` — P6送达确认协议helper:TTS合成≠owner感知,建模未来前端/WS ack(queued/synthesized/played_to_user_confirmed/失败);scrubError脱敏email/token;只有played_to_user_confirmed+confirmedAt+合法source才算owner真感知;被SelfTalkOutcome复用 (90行)
- `cognition/SelfTalkOutcome.js` — P6-A0自语副作用契约(纯):给自语proposalId+commit/landing/delivery显式状态+audit快照(strict策略默认不持久化owner私密prompt文本);LANDING_TYPES/DELIVERY_STATUSES枚举强校验;被SelfTalkDeliveryAck与InnerMonologue消费 (247行)

### 认知核心与意识（cognition 2/2）——Neo 贾维斯「类意识」运行时的下半区。本片 29 个文件覆盖六大子系统：① 全局工作区 GWT（NoeWorkspace 注意力竞争+串行广播+act/research/think 三类目标步分流+意识日志）；② 自主目标系统（NoeGoalSystem 确定性优先级仲裁+好奇回路+空计划自举+自主学习种子）；③ 深思/推理（NoeDeliberation 苏格拉底自我质询、NoeCouncilDeliberation 多 persona 议会、NoeReasoningSearch beam/greedy 搜索骨架、NoeBudgetForcing s1 预算强制旋钮、NoeAdaptiveRhythm 轻醒/重想节流）；④ 期望-误差与校准闭环（NoeExpectationLedger 预测账本+Brier+校准曲线、NoeStepExpectationBridge 失败→surprise 供给、NoeOwnerBehaviorPredictor 对 owner 下注、NoeExpectationSemanticRecall judge 语义召回、NoeExpectationActionEvidenceRows 动作证据行）；⑤ 自评/元认知/自进化（NoeVerifiableReward open-r1 可验证奖励、NoeReflectiveTuner GEPA 纯 shadow 权重进化、NoeThoughtLoopGuard 思维回环侦测、NoeIntegrationMetric IIT-代理整合度、NoeMemoryEcho 记忆回声采样、NoeLearningHook surprise→lesson 闭环）；⑥ P6 自我对话审计与交付证据合规栈（SelfTalk* 四件套 + P6ProductionEvidence + P6RuminationReadiness + NoeIncidentEscalator 故障→自修复目标 + NoeTaskReportbackQueue owner 可见进度 + NoeAffectHealth 情感福祉 + NoeAwakeningSignals 觉醒看板 + NoeLearningScheduleStore 学习任务持久层 + NoeGoalStepRecorder 步骤状态机）。全域贯穿三条铁律：注入式可测、fail-open（任何环节异常退回安全默认绝不阻断认知/对话）、行为变化一律 env 门控默认 OFF。  (读 29/29)
- `NoeWorkspace.js` — 全局工作区 GWT 核心：每 meso tick 收集候选(owner互动/上一念/到期承诺/到期期望/视觉/目标下一步/昨夜洞察/本机感知/驱力)→确定性显著度打分(owner/urgency/novelty/affect 四权重,goal_step 有加成分支)→唯一赢家广播=本周期焦点;think 步升深思、research 步异步上网、act 步走 ActPipeline;每周期一行意识日志 JSONL(含落选者);含语义 novelty 缓存(只读不 embed)、深思日预算(预留+失败退还)、回环守卫信号、任务回报/Activity/Checkpoint 留痕。全程 fail-open (698行)
- `NoeGoalSystem.js` — 自主目标系统:noe_goals 表 CRUD+确定性仲裁(priority=0.5·来源权重+0.2·新鲜度+0.2·可行性+0.1·动量,active≤2,stale 自动 paused,backlog 上限防立项上瘾)+nextStep 出工作区候选+harvestSurprise 好奇回路(surprise≥2bit→研究目标,可选 origin 门+好奇双因子分解)+空计划自举(autonomy 上网链/generic think 链)+自主学习种子(周期/连续两模式+动态选题)+目标自动收口。注入式 fail-open (640行)
- `NoeReflectiveTuner.js` — GEPA 式显著度四权重纯 shadow 自进化:读失败/低分轨迹→本地脑反思变异(失败退确定性网格)→holdout 语义尺子评测候选 vs 基线→Pareto 多目标(↑holdoutDelta+↑语义分+↓漂移)选优→写 archive 候选+证据 ledger。逐字镜像 NoeWorkspace.score 公式搭评测桥;硬约束:绝不写 production/不改 .env/不碰 patch-apply/无 fs 句柄,owner 人工采纳。env 默认 OFF (491行)
- `NoeExpectationLedger.js` — 期望账本(预测-误差+校准闭环):noe_expectations 表 add/open/due/resolve(surprise=-log2(p实际))/sweep(逾期 unresolvable 出账)/bumpAttempts(判证次数护栏)/repairDueAtFromClaim;确定性正则从文本抽「时间词+情态词」型预测;Brier+校准曲线(ECE/MCE)+provenance 分层(owner holdout vs auto 自评,防 Goodhart);全列退化检测(旧库无 source/resolved_by/verifiable/judge_attempts 列不抛错) (301行)
- `NoeBudgetForcing.js` — 深思「想多深」连续旋钮(借鉴 s1 budget forcing):纯函数 decideThinkingControl(未达 min 且想停→注入「等等,」逼继续、超 max→注入「综上,」逼收尾、防失控:忽略次数耗尽/注入后零产出即停)+resolveBudgetForcing(env 门控 shallow/normal/deep=0/1/3 次忽略,默认 OFF)+runBudgetForcedThinking(注入式解码编排循环,接 LM Studio/ollama completions) (304行)
- `NoeOwnerBehaviorPredictor.js` — owner 行为预测最小闭环(零 LLM):每次 owner 交互先结算旧预测(新文本含 topic token→应验/命中 followup 兑现词→应验/明确取消词+新鲜度→落空)再立新预测(topic「会再提」弱先验0.55、delegation「会要求实测/回报」强先验0.75);claim 内嵌稳定 token 识别归属;沉默不强判0(verifiable=0 交 sweep);含 createOwnerInteractionWatcher 从 timeline 读 interaction 经历喂入(水位线续读)。复用 Ledger 自动进 Brier (339行)
- `NoeThoughtLoopGuard.js` — 意识流去回环守卫(借鉴 Sibelium):computeSynapticStrength(Ebbinghaus 突触强度指数衰减,tau 随访问次数增大)+extractKeywords(按词边界切 token+中文 bigram+停用词过滤,修了旧版整句拼接 bug)+detectTopicLoop(≥2 关键词各出现在 ≥5 条念头=回环,doc-frequency 而非词频)+buildPivotSuggestion(换角度建议)。纯函数 fail-open,env 默认 OFF;被 InnerMonologue 与 NoeWorkspace 消费 (257行)
- `NoeIncidentEscalator.js` — 自检故障→自修复目标桥:7 类故障模板(语音/任务回报/目标/面板/模型/记忆/系统,各带 match 正则+rg 诊断 pattern+npm 验证命令)+classifyIncidentSignal(排除假设句/浏览器播放确认噪声/要求真失败源或故障词)+buildRepairGoal(只读 rg 诊断+跑验证+think 根因三步,带安全 glob 排除 .env/token/cookie)+observe(同名开放目标去重+冷却,接 goalSystem.add/taskReportbacks/recordEpisode) (259行)
- `NoeReasoningSearch.js` — 统一推理搜索控制器(借鉴 ToT/GoT/llm-reasoners 三者同源「发散+打分+剪枝」):createReasoningSearch({generate,evaluate})→search({root,width,depth,strategy:beam|greedy}) 逐层 generate 子候选→evaluate 打分→全局排序保 width 条(KeepBestN);纯控制流零模型零网络(明确不含 llm-reasoners 的 AWS 上传),全防爆上限+节点 generate/evaluate 抛错 fail-open;estimateTopicComplexity 启发判难题。被 NoeDeliberation 调 (257行)
- `NoeVerifiableReward.js` — 可验证奖励函数库(借鉴 open-r1 rewards.py 纯 JS 重写):formatReward(<think><answer> 结构闭合)+lenReward(同组长度归一,对且短得高分)+reasoningStepsReward(数分步标记中英文 min(1,count/3))+repetitionPenalty(n-gram 复读惩罚≤0,处理-0 怪癖)+createVerifiableReward 线性组合自评分。纯函数 fail-safe(非法入参返中性),env 默认 OFF;被 Deliberation/Council/ReflectiveTuner 用作客观打分 (270行)
- `NoeTaskReportbackQueue.js` — owner 可见任务进度脊柱(原子 JSON 文件持久化):异步工作(NoeWorkspace)用此队列给对话层「我去查」一个可消费进度通道(accepted/queued/running/done/failed/blocked/awaiting_approval);secret 脱敏+dedupeKey 去重+语音确认租约(speechLeaseUntil 防多消费者并发抢播)+系统自修复报告静默不播报+consume/consumeSpeech/current/markSpoken (228行)
- `P6RuminationReadiness.js` — P6 自我对话守卫栈的静态/离线验收器:15 条核心检查(逐文件 mustContain 关键串校验 SelfTalkOutcome/RuminationGuard/审计脱敏/交付确认/生产证据 schema/落地策略/情感契约/InnerMonologue 接线/各脚本/状态文档)+audit jsonl 回放证据校验+live/DB 生产证据校验(调 P6ProductionEvidence);严格区分组件就绪 coreReady 与生产就绪 productionReady(后者必须 live+DB+audit 全过) (214行)
- `SelfTalkAuditStore.js` — P6 自我对话审计 append-only JSONL(独立于自传时间线,严格脱敏):sanitizeSelfTalkAuditRecord(只存诊断决策+数值指标,TEXT_KEYS 文本字段 strict 策略下拒绝并计数 unsafeTextFieldCount,llmContextAllowed 恒 false)+parse/summarize(去重 outcome、统计 committed/blocked/landed/confirmedDelivery/合规率/回环触发率)+createSelfTalkAuditStore 落盘工厂 (216行)
- `P6ProductionEvidence.js` — P6 真生产证据守卫:validateP6ProductionEvidence 拒合成/fixture/test/dry_run 样本+强制 schemaVersion=1/运行模式可审计/端口必 51835/live+DB verified/no51735 边界/secret 未返回/owner token 未打印/审计无上下文泄漏/owner 交付确认+合规率合法/证据 refs≥3/TTS-only 不算 owner 感知交付;输出 blockers+warnings+summary (135行)
- `NoeAdaptiveRhythm.js` — 把「醒一次」与「动用重模型深想一次」拆开的节流决策(纯函数):decideMesoInnerRhythm 根据工作区赢家来源/分数决定本 tick 是否调重内心独白模型——升级/owner互动/到期承诺期望/目标步/高分焦点→立即重想;成长源(洞察/驱力/感知)按 growth 间隔;空闲按 idle 间隔;heavy 在途跳过;无工作区退回每 tick 反刍(零回归) (130行)
- `P6ProductionEvidence.js(dup-note)` — (见上,该文件在清单中仅一次) (135行)
- `SelfTalkRuntimeEvidence.js` — P6 审计证据运行时桥:把同一份脱敏审计记录同时写 JSONL(SelfTalkAuditStore)与 SQLite events(kind=noe_self_talk_audit);normalizeRecord 补 ts/signalContract+appendOutcome/recordDeliveryAck(建交付确认+落地效果)+summary/dbSummary;SQLite 持久化是证据非控制路径(写失败不阻断反思) (124行)
- `NoeAwakeningSignals.js` — 觉醒候选信号 4 维采样(纯函数,只读 db handle):D1 预测-学习活性(够格落空 surprise→surprise 目标→完成率)、D2 整合度 TC(读 kv)、D3 校准 Brier(排除 step_prediction 伪预测+owner holdout 分层)、D4 自发性(24h 内心独白+情景+非 owner 主动目标);全表/列存在性检测+events.ts 毫秒/秒单位自适应。供 CLI 与心跳共用,被 noeMind 路由消费 (126行)
- `NoeStepExpectationBridge.js` — 好奇回路供给端(治 source=surprise 恒 0):act/research step 真失败→登记预测→resolve(outcome=0)→surprise→harvestSurprise(action_failure);三方复盘整改:结构化 classifyFailure 区分 system_gate(安全门/预算/审批,排除防 reward hacking)/transient(中英文网络噪声,排除)/real;stepHash+failureClass 多键去重+每小时限速防刷;recent Map 防无界增长。env 默认 OFF (115行)
- `NoeStepExpectationBridge.js(note)` — (见上) (115行)
- `NoeAffectHealth.js` — 只读情感福祉评分(v4 D5 AI-welfare 证据):吃数值 VAD 快照(无需 cause/body/prompt 文本),按样本量/新鲜度/饱和度(逐维比例)/方差四项各 0.25 权重算 score;告警:样本不足/快照陈旧/饱和过高/方差过低;policy 声明 numericVadOnly。纯函数 (92行)
- `NoeGoalStepRecorder.js` — 目标步骤记录状态机(从 NoeGoalSystem 抽出):normalizeGoalStepStatus(open/doing/awaiting_approval/blocked/failed/recovered/done)+normalizeNewSteps(只认显式 act 对象,文本永不推断 act)+recordGoalStepResult(stepIndex=-1 长计划/更新单步状态/全 done|recovered→目标 done,写 noe_goals+appendGoalCheckpoint,act 步 replaySafe=false)。fail-open (97行)
- `NoeExpectationSemanticRecall.js` — judge 证据检索的 embedding 语义召回(注入式,治词面匹配 coverage 0.044):createClaimEventEmbedRecall 算 claim×候选事件余弦相似度;双代理守卫:fallback/维度不等跳过(防 hash 退化假相似度)、逐元素 finite 校验(防 NaN/Inf)、Float32Array 兼容(揪出真 bug)、超 cap 标 degraded、DEGRADED_KEY 哨兵可观测;锁 qwen3-embedding:0.6b 1024 维,并行 embed。env 默认 OFF (94行)
- `SelfTalkLandingPolicy.js` — P6「念头必须落地」纯策略:自我对话连续 N 条未落地后,下一念必须变成 expectation/commitment/goal/memory/awareness 或显式 silent 关闭;computeSelfTalkLandingWindow 统计合规落地/外部落地/静默关闭/未落地连击;decideSelfTalkLandingRequirement 判是否 required+候选是否满足。silent 满足合规但不算 owner 感知交付 (94行)
- `NoeCouncilDeliberation.js` — 多视角议会式深思(借鉴 Hermes MoA):3 persona(立论者只看收益/唱反调者只看风险/现实主义者只看可行性,不同 system+温度+输入视角逼真异质)各独立单次补全→聚合器先信息融合(冲突/共识/未解决)再批判收敛终判;返回结构与 createDeliberation 一致(Workspace 零改);末尾 /no_think 防 thinking 占满 token;reward 打分+parse 预测/想说/目标+留痕+入账。fail-open;NOE_COUNCIL_DELIBERATION=1 接线 (152行)
- `NoeExpectationActionEvidenceRows.js` — 把 noe_act/goal_checkpoint 行转成期望判证的最小动作证据行:collectSemanticContext(递归抽 goal/claim/step/task 等白名单语义键,SENSITIVE_KEY_RE 排除凭据,深度/广度限制)+buildMinimalActionEvidencePayload(状态/完成/动作/标题/semanticTrace)+两个 builder(有 semanticTrace 或终态+审计支撑证据才产行);全程 redactSensitiveText 脱敏 (157行)
- `NoeDeliberation.js` — System2 深思审议(苏格拉底自我质询):单次补全内立论→自我挑战→修订+主观概率;isVerifiablePrediction(行为动词+非纯情绪内省才可被外部判生死,二轮审查收紧防误标)+parsePrediction/parseShare/parseGoal;深思前 recallFused 语义召回(bumpHits:false 防污染)+校准注入;可选 reasoning-search 多候选/budget-forcing,全 fail-open 回退单次;预测入账(dueAt 优先 claim 自带时窗)。本地脑零付费不设超时 (190行)
- `NoeMemoryEcho.js` — 记忆回声采样(治近因茧房):从 >24h 久远情景池(排除念头本身防回声室)按 0.4·显著度+0.3·新近度(半衰14天)+0.3·情感相称(当下 VAD vs 情景印记) 打分后 softmax 采样(温度0.25 保联想意外感);全注入(timeline/affectProbe/now/rng),任何异常返 null fail-open。被 InnerMonologue 经 echoProvider 消费,server 接线 (52行)
- `NoeIntegrationMetric.js` — 意识整合度可量化读数(IIT 代理,纯函数零依赖):用多信息 Total Correlation(TC=ΣH(Xi)−H(X)) 作整合度代理,把各子系统二值化宏节点向量算边际熵和−联合熵,归一到[0,1];诚实声明非完整 IIT Φ(不算因果 TPM/MIP);强健剔除异宽行防口径错位;integrationLabel 出中文档位。经 NoeIntegrationSampler→server 接线,供 mind.html/觉醒看板 (77行)
- `NoeLearningHook.js` — 「立目标→真学到」学习闭环:surprise 目标 done→读证据→本地脑产【具体认知修正 lesson】(非空泛方法论)→过生产 gate 写 memory→按 id 精确验持久化;批次AB 整改:kind=insight+evidenceRefs 过 gate、查 c.ok 用 c.memory.id、recall 用 memory.get 防自证假阳、诚实区分 persisted≠learned、isRelearn 空耗预警、PROJECT='noe' 治召回恒空。async fail-open,env 默认 OFF。server 接线 (77行)
- `NoeLearningScheduleStore.js` — 定时学习任务 SQLite 访问层(noe_learning_jobs,迁移 v15):addJob/getJob/listJobs/dueJobs/setEnabled+CAS 运行锁 beginRun(防并发重入)+finishRun(成效自适应下次时间,at 一次性学完则 disable)+failRun(退避+错误计数)+recoverStuck(锁超 2h 清死锁标 stuck_recovered,不自动重放副作用)。下次时间由编排层纯函数算好传入,本层只持久化 (60行)

### 记忆系统 (memory 1/2) — Neo 贾维斯的长期/情景记忆子系统的奇数索引半区（26 个文件）。涵盖：语义记忆存取核心（MemoryCore）、自传体情景时间线（EpisodicTimeline）、双路融合召回排序（FusionRanker/FisherRaoReranker/Dedup）、睡眠巩固三件套（梦境整合 Consolidator/Dream、情景升华 Sublimation、夜间反思 Reflection）、记忆治理与候选门禁链（AutonomousReview/Candidate{Status,ChainDrill,Rollback}）、证据回填/语义回填/各类基准与拷贝验证 harness、SFT 训练对蒸馏、本地文件索引（FileIndex）。整体是「数据层即自我」的认知记忆基础设施，绝大多数高级能力默认 env OFF，需 owner 显式开启。  (读 26/26)
- `memory/EpisodicTimeline.js` — 自传体情景时间线：基于 events 表 kind='noe_episode' 记录/读取情景流（record/recent/aged/narrative/total），把最近经历编织成 <noe-recent-timeline> 注入 system prompt 提供「连续感」。relativeTime 纯函数。注入式（append/list/count/now 可 fake）。 (165行)
- `memory/FileIndex.js` — 本地工作区文件索引（只读）：递归遍历白名单根目录，分类（code/doc/config/sensitive）+ 价值分层 + 敏感文件识别（env/credentials/私钥等内容不读），提供 search/hybridSearch/summarize/organizePlan(dry-run 建议)。realpath 归一化白名单防 symlink 误拒。 (461行)
- `memory/MemoryCore.js` — 语义记忆存取核心（noe_memory 表 + FTS5 trigram）：write(去重/冲突合并/语义冲突 sweep)、get/getMany、hide/unhide/merge/setSalience/downgrade、recall(FTS/LIKE)、recallFused(向量×FTS RRF 融合+Fisher-Rao 重排+salience 软加权+时间激活)、runGc、topBySalience、stats。所有写文本经 redactSensitiveText。大量审计 P0 修复（向量孤儿清理、批量 bumpHit、窄列 GC）。 (782行)
- `memory/NoeDreamConsolidation.js` — 梦境整合落地层：把 NoeMemoryConsolidator 产的计划应用到真实 MemoryCore（merge/downgrade/promotion），逐动作 try/catch，防御纵深硬保护 salience>=5；loadConsolidationCandidates 冷热混采；createMemoryDreamLoop 建循环（默认 enabled=false）。 (83行)
- `memory/NoeEpisodeSublimation.js` — 梦境升华（久远情景→语义记忆）：取 90 天前情景按 ISO 周分组→(可选 LLM 钩子)升华成第一人称摘要→MemoryCore.write(scope=episodic_digest, 显式 weekId upsert)→水位线原子持久化(只进不退)→写回 dream 情景。salience 钳 ≤4。createEpisodeSublimationLoop 默认 OFF。 (221行)
- `memory/NoeFisherRaoReranker.js` — Fisher-Rao 信息几何重排接线层：估计嵌入方差(estimateVarianceFromVector 内蕴方差 / uncertaintyToVariance 按 hit_count·salience 收紧)，用 fisherRaoSimilarity 对向量召回命中按「均值+方差」重排。纯函数+注入式，性能优化(查询侧 std 循环外预算)。优雅退化到 cosine。 (123行)
- `memory/NoeFusionRanker.js` — 双路融合召回排序纯函数：reciprocalRankFusion(RRF, k=60, 同路去重)、weightedFusion(min-max 归一加权+salience 二级权重)、salienceBoostFactor(1-5→1.0-1.4 单一真源)。被 MemoryCore.recallFused 复用。 (88行)
- `memory/NoeLessonTopicIndex.js` — lesson topic 索引化纯逻辑：中英分词去停用词提取 2-4 个 topic 关键词(tokenizeForTopicsStream/extractLessonTopics，含 CJK 2-gram 跨词碎片剔除)，写入侧落 tags(mergeTopicTags)，召回侧算 query↔lesson tags 重叠加权(topicOverlapScore)。门控 NOE_LESSON_TOPIC_INDEX 在调用方。 (206行)
- `memory/NoeMemoryAutonomousReview.js` — 无来源链遗留 fact 的自主复核：listAutonomousReviewTargets 查孤儿 fact(无 source_episode/source_id/强链接)→classifyAutonomousMemoryReview 分类(敏感隔离/短暂拒收/低置信保留/高 salience 守护/弱接受)→apply 时记候选+链接+可逆 hide+删 embedding。渲染/写 Markdown 镜像(0o600)。 (227行)
- `memory/NoeMemoryCandidateChainDrill.js` — 记忆候选全链路演练 harness：fixture 模拟 proposal→owner 批准→物化进 pending queue(不写 MemoryCore)→review→dry-run apply→未确认 apply 被拒(0 写)→确认 apply 到隔离 fixture SQLite→rollback(hide)→验召回不可见。生产 MemoryCore 绝不触碰。产报告 JSON。 (266行)
- `memory/NoeMemoryCandidateRollback.js` — 记忆候选回滚：读 apply 报告→buildNoeMemoryCandidateRollbackPlan(校验 status=applied/sourceType=proposal_memory_candidate/projectId 非空等)→默认 dryRun，confirmOwner 才真 memoryCore.hide(已 hidden 标 already_hidden)。无输入=skipped no-op。产报告。文本经 redact。 (179行)
- `memory/NoeMemoryCandidateStatus.js` — 记忆候选管线只读状态聚合：读 queue/pending(JSONL) + review/apply/rollback 报告目录(取最新)，汇总 byStatus/pendingOwnerReview/readiness。严格只读、不输出记忆正文/secret。 (211行)
- `memory/NoeMemoryConsolidator.js` — 梦境/睡眠整合确定性规划器(纯逻辑无 DB)：planConsolidation 产 {merges(精确/近似去重),downgrades(陈旧低价值),promotions(recall-heat 晋升),skippedProtected}，身份级 salience>=5/protectedScopes 硬保护，可选 async llmConsolidate 钩子(带受保护安全闸)。createConsolidationLoop 调度骨架默认 OFF。 (182行)
- `memory/NoeMemoryCopyValidation.js` — 记忆拷贝验证 harness：SqliteStore.backup 出副本→在副本上跑语义回填(purge hash 向量+逐条 ollama 嵌入)+FTS vs 融合召回对比+维护 dry-run+GC apply(验身份级未被误 hide)。probeOllamaEmbeddingModel 探活并 keep_alive 常驻。生产库零写、不重启 panel。 (278行)
- `memory/NoeMemoryDedup.js` — 写入去重/冲突合并确定性判定(零 LLM)：normalizeForDedup(\p{Han}+全角数字)+bigram Jaccard 相似度，decideMemoryWrite(近重复→update，含前缀包含判据+长度膨胀约束)、decideSemanticConflict(向量分+字符分双指标判「换关键词矛盾」)。保守优先、身份级 protectSalience 不替。 (142行)
- `memory/NoeMemoryExtractor.js` — 长期记忆候选 LLM 提取器：用主脑模型(think:false,temp:0)从对话提炼 JSON 候选(fact/preference/skill/insight 或 no_write)，经 normalizeMemoryCandidate 规整；模型失败回退 FactExtractor。extractCandidates/extractRecords。 (128行)
- `memory/NoeMemoryMaintenanceDryRun.js` — 记忆维护 dry-run 聚合(只读不改库)：buildNoeMemoryStatus(before) + 梦境整合计划(planConsolidation) + GC 计划(runGc apply=false)，输出各桶 id/计数，protectedScopes=identity/person。 (66行)
- `memory/NoeMemoryProvenanceBackfill.js` — 记忆来源链回填：对孤儿 fact 与 events 情景做词法重叠(overlap≥4)+因果方向过滤(情景不晚于记忆超 1h 容差)匹配，minScore=0.78，apply 时插 noe_memory_link(source_episode)+回填 source_episode_id。绝不伪造强来源，未匹配保持弱。 (188行)
- `memory/NoeMemoryRecallBenchmark.js` — 召回质量基准：内置 fixtures(咖啡偏好/路线图/voice/干扰项)+cases(precision/recall/disallowed/expectEmpty)，seedNoeMemoryRecallBenchmark 经 writeGate 种入，跑 retriever.retrieve 算 precision@k/recall@k 判 pass。 (147行)
- `memory/NoeMemoryRetrievalSample.js` — 召回采样冒烟：对 20 条默认 query(中英/各 routeType)跑 retriever.retrieve，统计 selectedCount/selectedRows/droppedReasons。只写召回日志、不输出记忆正文。 (78行)
- `memory/NoeMemoryRoadmapVerifier.js` — 记忆路线图总验收：隔离 DB 跑生命周期 canary(写→强链接→召回→owner 编辑→hide/unhide 可逆→删=可逆 hide→候选回放→无孤儿)+召回基准；再对真实库只读读状态/维护 dry-run/来源回填计划/拷贝验证&相关性基准报告。required+advisory 检查。真实库零写。 (275行)
- `memory/NoeMemorySemanticBackfill.js` — 真实库语义向量回填：ollama 探活→可选 dry-run/需 ackApply 双闸→先逐条重嵌入覆盖(ON CONFLICT)全成功(无 fallback)后再删残留 hash 行(防先删后写崩溃留空洞)。产 before/after 状态对比。 (142行)
- `memory/NoeMemorySemanticIndex.js` — 记忆语义索引适配器(向量路接线)：包装 embeddings/VectorIndex(kind=noe_memory)，暴露 {provider,upsert,search,searchVectors(带方差),remove}。provider 可配 hash(兜底)/ollama(真语义)，keep_alive 默认常驻。MemoryCore 注入它才开双路召回。 (45行)
- `memory/NoeMemoryUtilityLite.js` — 记忆效用轻量报告(只读不改库)：从 noe_memory_retrieval_log 统计每条记忆 selected/inferredDropped 信号→actionForMemory 判 promote/demote/gc_review/needs_review 候选(身份级 salience>=5 只 needs_review)+冷零命中扫描。仅产候选动作供后续门禁复核，绝不改 salience/记忆行。schema 防御性列存在性检查。 (414行)
- `memory/NoeNightlyReflection.js` — 夜间反思(元认知最小闭环)：用主脑把当日情景蒸馏成 1-3 条 insight(lesson/pattern/belief, 经 writeGate 带证据链)+复核既有 insight 调 confidence(对称 ±0.1, 钳 [0.05,0.95])。新鲜度 20h+并发+circadian 夜相守卫+盐度旁路(攒够大事提前反思)+水位线持久化。extractFirstJson 括号平衡解析。默认 OFF。 (288行)
- `memory/NoeSftHarvester.js` — SFT 训练对蒸馏(意识工程·让经验渗入权重)：把 insight/inner_monologue/narrative/personality/高 salience 记忆攒成 chat 格式 JSONL(按 ISO 周分文件)供 LoRA 微调。敏感正则命中即拒(进权重不可删)+hash 去重(保最早)+20h 水位线。默认 OFF。 (197行)

### Neo 贾维斯（noe v2.1.0）记忆系统 memory 域第 2/2 半 —— 围绕 MemoryCore 写/召回主干的「治理、动力学、镜像、外部 provider、人物卡、候选闸、审计」一圈卫星模块。覆盖：自动事实抽取(FactExtractor)、焦点栈(FocusStack)、主动记忆/时间窗/熔断(NoeActiveMemory)、梦境语义去重钩子(NoeDreamM3Hook)、外部向量/Wiki 记忆 provider 与其管理器(NoeExternalMemoryProviders/NoeMemoryProviderManager)、Fisher-Rao 信息几何相似度(NoeFisherRaoSimilarity)、知识图谱(NoeKnowledgeGraph)、审计日志/候选/链接/召回日志(NoeMemoryAuditLog)、proposal→候选→owner 审批→落地 MemoryCore 的离线流水线(CandidateReview/CandidateApply/CandidateSchema)、确定性事实冲突策略(NoeMemoryConflictPolicy)、喂模型的记忆 XML 块(NoeMemoryContextFormatter)、记忆 GC 计划(NoeMemoryCurator)、双相衰减时间激活(NoeMemoryDynamics)、来源链接治理修复(NoeMemoryGovernanceRepair)、Obsidian Markdown 单向镜像(NoeMemoryMarkdownMirror)、语义召回质量基准(NoeMemoryRelevanceBenchmark)、五通道并行召回+lesson 保底+熔断(NoeMemoryRetriever)、生产进程运行态采集(NoeMemoryRuntimeStatus)、嵌入 provider 配置解析(NoeMemorySemanticConfig)、记忆全景状态(NoeMemoryStatus)、写闸(NoeMemoryWriteGate)、人物关系卡(NoePersonCards)。  (读 25/25)
- `memory/FactExtractor.js` — 从对话提炼「值得长期记住的事实」(mem0 思路)。默认走本地 Ollama 主脑(think:false,temp 0)；EXTRACT_PROMPT 严令逐字有据禁推断；剥离 <think> 块防思考链污染；单次最多 10 条。extractRecords() 在字符串数组基础上加 validFrom/sourceEpisodeId/confidence 给写入层。complete 可注入 mock。 (85行)
- `memory/FocusStack.js` — 项目级「焦点栈」(noe_focus_stack 表)：push 同名 active 去重并 hit_count+1；depth 自增；pop 时把摘要 absorb 进 MemoryCore(scope=focus, 软删可恢复)并置 popped。get/list/peek/restore/depth。导出单例 focusStack；被 server.js + NoeSelfKnowledge 接线。 (165行)
- `memory/NoeActiveMemory.js` — 主动记忆工具箱：①召回熔断器 createActiveMemoryRecallCircuitBreaker(N 连失败开断路+冷却+脱敏 lastError)②中文时间窗解析 parseNoeChineseTimeWindow(刚刚/昨天/上周)③focus_conclusion 受控写(需 userAck 或 validated_consensus_ledger)④buildActiveMemoryContext 拼 <memory-context trust=local-untrusted> 系统提示。熔断器+sanitizeActiveMemoryRecallError 被 Retriever 用；但 buildActiveMemoryContext/writeFocusConclusionMemory/recallFocusConclusions 仅测试引用、无 server/路由消费(idle)。 (314行)
- `memory/NoeDreamM3Hook.js` — 梦境记忆整合的 llmConsolidate 钩子(语义去重)。CONSOLIDATOR_PROMPT 只找语义重复组、不合并矛盾；parseMerges 用 quote 自证(摘抄须逐字命中该 id 原文)防 M3 把 keepId/dropId 抄错位(2026-06-11 实损修复)。buildChat 按 provider(minimax/ollama/xiaomi)造聊天通道,密钥缺失返回空串回退确定性。被梦境/升华链接线。 (126行)
- `memory/NoeExternalMemoryProviders.js` — 外部记忆 provider 工厂：LanceDB(hashTextToVector 32维伪向量+vectorSearch)与 LLMWiki provider；buildNoeExternalMemoryProviders 按 NOE_LANCEDB_MEMORY/NOE_WIKI_MEMORY_PROVIDER 单选门控(两者同开抛错)。仅 tests 引用,无运行时接线(未接线/空转能力)。 (162行)
- `memory/NoeFisherRaoSimilarity.js` — 对角高斯 Fisher-Rao 信息几何相似度(cosine 替代度量)。stableArccosh(小 t Taylor 展开防丢精度)+toStd(方差→标准差,0→EPS)+Atkinson-Mitchell 闭式逐维测地距离可加;distanceToSimilarity=1/(1+d/scale);含 PreparedA 批量复用版。纯函数。经 NoeFisherRaoReranker 在 MemoryCore 接线(NOE_MEMORY_FISHER_RANK=1 默认 OFF)。 (207行)
- `memory/NoeKnowledgeGraph.js` — 本地知识图谱(noe_kg_entity/noe_kg_relation 两表+索引)。SHA256 稳定 id;upsertEntity/upsertRelation 幂等合并 refs(UNIQUE 冲突更新);ingestFileIndex 从文件索引抽实体/术语/关系(跳过 sensitive,只读源);extractTerms 正则抽大写/小写/中文词+停用词过滤;search(LIKE)/oneHop(UNION 双向邻接)。schema 版本不符抛 NOE_KG_SCHEMA_MISMATCH。被 NoeSelfKnowledge/LearningTopics 用。 (269行)
- `memory/NoeMemoryAuditLog.js` — 记忆审计日志(noe_memory_candidate/noe_memory_link/noe_memory_retrieval_log 三表)。recordCandidate(ON CONFLICT 更新决策)、linkMemory(强弱来源链接,INSERT OR IGNORE)、recordRetrieval(query 仅存 SHA256 哈希)、candidateStats/retrievalStats。clean() 全程 redactSensitiveText 脱敏。被 WriteGate/Retriever 等 18 处引用,是写/召回审计中枢。 (242行)
- `memory/NoeMemoryCandidateApply.js` — 候选落地 MemoryCore 的离线流水线(写 JSONL+报告)。buildNoeMemoryCandidateApplyPlan 校验 5 道闸(pending_owner_review/body/requiresOwnerApproval/未自称已写);runNoeMemoryCandidateApply 默认 dryRun,真写需 confirmOwner+memoryCore.write,每条带 rollback{hide_memory}。经 noeProposals 路由接线。 (160行)
- `memory/NoeMemoryCandidateReview.js` — 把 proposal 物化队列(JSONL)对账成 pending 候选。reconcileNoeMemoryCandidateRecord 校验 effect/proposalType/body/confidence>=0.7;hash 派生 candidateId;追加到 pending.jsonl(pendingContains 去重)。writesMemoryCore:false(只产候选不落库)。经 noeProposals 路由接线。directWrites 字段用 filter 索引技巧(written.length 控制是否列 pendingRef),晦涩但非 bug。 (169行)
- `memory/NoeMemoryCandidateSchema.js` — 记忆候选归一化与判定纯函数集。normalizeMemoryCandidate(kind→scope 映射/clamp confidence-salience/SECRET_RE 检测 sensitive/isIncomplete 检测截断输出);candidateNeedsSourceEvidence/candidateNeedsReview/candidateLooksEphemeral(EPHEMERAL_FACT_RE 识别临时态);candidateToMemoryInput 加 mergeTrace 闸记录。被 WriteGate 核心依赖。 (173行)
- `memory/NoeMemoryConflictPolicy.js` — 事实更新/冲突的确定性策略层(Mem0/Letta/Zep 式「事实会变」)。decideMemoryConflict 返回 merge/supersede/keep_both/ignore/needs_review。factSlot 用正则把文本归类到 drink_preference/location/identity/date 槽位(经 codex post-review 多次返工修误判);近重复合并前先尊重 protected/弱源保护防覆盖 owner 高盐事实。被 4 处引用。 (93行)
- `memory/NoeMemoryContextFormatter.js` — 把召回结果格式化成喂模型的 <noe-memory-v2 trust=local> XML 块。按 scope 映射标签(project→skill/insight→insight/其余→fact);带 instruction 提示「别把旧记忆当比本轮事实高优先级」;attrs 输出 id/scope/source/episode/confidence;全程脱敏。被 Retriever re-export。 (32行)
- `memory/NoeMemoryCurator.js` — 记忆库 GC 计划纯函数(管「遗忘什么」,与 FusionRanker 互补)。classifyMemory 分 protected(salience>=5/pinned 永不 GC)/expired/stale/low_confidence/keep;isTruthy 兼容 1/'1'/'true';parseTs 类型守卫防布尔被当 1ms epoch;planMemoryGc 入口一次性算 now 避免逐条漂移,只产 gcCandidates 不删。被 5 处引用。 (94行)
- `memory/NoeMemoryDynamics.js` — 记忆双相衰减时间激活(借 OpenMemory)。dualPhaseRetention=快遗忘+慢巩固双指数归一;tierForAge(hot/warm/cold)分档 λ;reinforce(检索即强化 sal+=η(1-sal));ageSinceLastRecall(优先 lastHitAt);makeActivationScorer env 门控默认 OFF 返回恒等因子。经 MemoryCore 接线(NOE_MEMORY_DYNAMIC_DECAY=1,floor 0.1)。 (238行)
- `memory/NoeMemoryGovernanceRepair.js` — 补建记忆来源链接(noe_memory_link)。buildMemoryGovernanceLinksForRow 从 source_episode/source_id(强)+legacy_source_type/merge_trace(弱)派生链接;planNoeMemoryGovernanceRepair 扫 noe_memory 比对已有链接产 inserts;apply 走事务 INSERT OR IGNORE。被 AutonomousReview/Status/ProvenanceBackfill 接线。 (143行)
- `memory/NoeMemoryMarkdownMirror.js` — 长期记忆/图谱实体→Obsidian Markdown 单向镜像(借 Basic Memory NOTE-FORMAT)。自写极简 YAML 序列化(不引 gray-matter,键字母序确定输出);factToLine(- [cat] 文 #tag)/relationToLine(- rel [[实体]]);buildMirrorDocuments env 门控默认 OFF;writeMirrorDocuments 副作用层。经 server.js 接线(NOE_MEMORY_MD_MIRROR=1,定时器),全程脱敏防 secret 入文件。 (335行)
- `memory/NoeMemoryRelevanceBenchmark.js` — 语义 vs 基线召回质量对照基准(纯函数+注入 retriever)。normalizeCase 规整阈值;scoreSelection 算 recall@K/precision@K/bestRank;compareCase 算 semantic-baseline delta;summarize 出 semanticQualityOk;policy 声明只输出 selectedIds 不输出记忆体/secret。经 RoadmapVerifier 接线驱动(semantic_relevance_benchmark_passed 检查项)。含自测桩。 (253行)
- `memory/NoeMemoryRetriever.js` — 五通道(fact/user/project/insight+lesson)并行召回融合的主召回器。hasLiteralAnchor 命中走精确字面路抑制语义;lesson 专属通道(LESSON_SOURCE_TYPES)+保底进 selected 占 min(RESERVE,total-1)席(治 lesson 0 命中);rankLessonsByTopic 主题重排(NOE_LESSON_TOPIC_INDEX OFF);熔断+脱敏;recordUsageHits(NOE_MEMORY_USAGE_BUMP OFF)只给 selected 计 hit;audit fail-open。被 9 处接线。 (257行)
- `memory/NoeMemoryRuntimeStatus.js` — 采集生产进程(51835)运行态。lsof 抓监听 PID+cwd 是否匹配期望目录;ps eww 抓环境但只 allowlist 15 个 NOE_*/PORT 键、显式 fullEnvironmentCaptured:false/secretValuesCaptured:false(防 secret 外泄);每值截 200 字符。经 RoadmapVerifier 接线。 (97行)
- `memory/NoeMemorySemanticConfig.js` — 嵌入 provider 配置解析(单一真相)。resolveNoeMemorySemanticConfig 按 NOE_MEMORY_EMBED(主)/NOE_MEMORY_EMBED_PROVIDER 解析;OFF 值集判禁用;NOE_AUTONOMY_PROFILE 非 minimal 时默认启用 ollama qwen3-embedding:0.6b@11434;baseUrl 多源回退。被 Status 等接线。 (51行)
- `memory/NoeMemoryStatus.js` — 记忆系统全景只读状态聚合。counts(total/visible/hidden/expired/byScope/bySourceType)+sourceLinked(孤儿事实比例,复杂 SQL EXISTS 强链接判定)+candidateStats+retrievalStats(含最近召回的 lesson 明细,hidden=0+expires 过滤)+semanticIndex 维度黑洞健康(buildDimHealth:运行时 queryDimOrphaned 主判据+静态 mixedDim 兜底)+maintenance 各后台开关态。被 11 处接线,透视页数据源。 (250行)
- `memory/NoeMemoryWriteGate.js` — 记忆写入闸(候选→校验→落 MemoryCore→记审计+链接)。validate 顺序闸:空体/截断输出→rejected,sensitive→quarantined,ephemeral/低置信/缺来源证据→rejected,高风险→needs_review;commit 归一候选→validate→memory.write→recordCandidate+linkMemory,各步 try/catch fail-safe 不阻断。被 12 处接线,是把关写入的核心。 (85行)
- `memory/NoePersonCards.js` — 结构化人物关系卡(纯逻辑内存 store,注入 now/idGen,无 I/O)。canonicalPersonId(归一 SHA1 同名稳定主键跨重启);createPersonCardStore 含 byId+aliasIndex 双索引,upsert 按 id 或别名命中合并(别名即身份,歧义别名会误合,文档已警示);keyEvents/preferences 截断防撑爆 prompt;toContextHint 拼中文对话上下文;snapshot 深拷贝防穿透。被 ContextEngine/VoiceSession/FaceRecognition/server 接线。 (336行)

### 身份·主循环·状态·上下文引擎（identity / loop / state / context）——Noe 的"我是谁 / 我此刻怎样 / 不被提问时仍在流淌的内心 / 每轮对话喂什么进 system prompt"这一整块。核心是一条"连续记忆脊椎 + 内在世界 + 意识工程"的演化栈：身份层用版本化 store 做基因（稳定），状态/性格/叙事/驱力/心境层从行为里长出来（只读注入、零人格漂移），主循环用持久心跳串行驱动反刍与主动陪伴，上下文引擎把十余段供给统一收口并做预算裁剪 + 出口脱敏；身份子域是声纹/人脸的本地门禁与人物库（CAMPPlus/InsightFace 子进程 + lite 兜底）。绝大多数高级能力由 env flag 门控、默认 OFF、依赖全注入、缺失即 fail-open。  (读 45/45)
- `state/AgentStateMachine.js` — 从 claude stream-json 行推断 agent 状态(idle/thinking/running/completed/error)的小状态机，移植自'思维镜'，带 100 条转移历史环形缓冲 (57行)
- `state/atomicJsonFile.js` — 共享原子 JSON 文件读写 helper：tmp+rename 原子写 + .bak-latest 一代备份 + 坏 JSON 读到先备份 .corrupted-*.bak 再返 null；tmp 名带 pid+递增序号防并发互覆盖；被多个 store 复用 (68行)
- `context/NoeContinuity.js` — 连续记忆/自我状态注入的 provider 注册中立模块：server 注入持有实例的 provider，ChatProfileStore.resolve 调 buildNoeContinuityBlock() 读出；故意不直接 import 重依赖，避免把 ChatProfileStore 拖进 SQLite 链 (27行)
- `context/NoeContextBudgeter.js` — system prompt 注入段统一编排器 createContextComposer：各段 add(id,text,{keep}) 进队，compose() 预算内保序全量输出、超预算按 keep 升序整段裁（绝不截半句），4字符≈1token 粗估，维护 running used (62行)
- `context/NoeTrajectoryCompactor.js` — 对话轨迹滑动压缩纯逻辑：超 token 预算时保护尾部 keepRecent 条、早期轮次合并为一条 summary system 消息（有 summarizer 用 LLM 否则确定性占位摘要） (52行)
- `context/NoeGeoWeather.js` — 无 key IP 定位+天气：多源 fallback(ip-api/ipinfo)→open-meteo；WMO 码转中文、归一经纬度、formatGeoWeatherBrief 一句话进预取池；server 侧 NOE_GEO_WEATHER=1 才通电 (76行)
- `context/NoeContextEngine.js` — @deprecated 死代码：LegacyNoeContextEngine 旧上下文引擎，运行时零引用(grep 核实)，唯一活引擎是 NoeTurnContextEngine；保留 base 类 compact()/shouldCompact() 给真引擎复用 (186行)
- `context/NoeContextSufficiencyGatherer.js` — 上下文充分性评估：归一 sources/requiredContext，敏感源(.env/keychain/token 正则)拉黑成 blocker，关键 requirement 缺失→critical_context_missing，产出 gatherRequests + blockers；ActPipeline 与 Legacy 引擎用 (132行)
- `context/NoeHostContext.js` — 本地感知三件套：SSH host 别名/git 身份/桌面文件名/硬件电量元数据采集并格式化进 prompt（严守只读元数据不读密钥）；启动缓存 setCachedHostContextBlock/getCachedHostContextBlock 供聊天链路零成本注入 (116行)
- `context/NoeMoodAnalyzer.js` — 本地模型心境分析：从自传体时间线读经历→本地大脑评≤10字'行为层心境'短语；异步刷新+缓存(20min ttl)+并发守卫；createCachedMoodInferrer 包成同步 moodInferrer：缓存新鲜用模型、过期后台 fire-and-forget 刷新本轮回启发式(fail-open) (145行)
- `context/NoeNarrativeSelf.js` — 叙事自我(支柱⑤)：本地大脑把时间线全幅压成2-3句第一人称'我的故事'，atomicJson 持久化、24h 新鲜度+并发守卫、只读注入零人格漂移、SILENT/模型挂保留旧叙事；旧值不设 TTL（旧故事即兜底） (169行)
- `context/NoePersonalitySnapshot.js` — 性格快照自举(意识工程·阶段2)：每周从行为统计(说/想次数/承诺完成率/驱力)让本地大脑写2-3句'我注意到我…'性格观察，只读注入'我的性格'一行，绝不反哺 identity；collectBehaviorStats 纯函数可测 (167行)
- `context/NoePromptPrefix.js` — 稳定前缀/易变块切分纯函数：把日期/时刻/uuid/cwd 等易变行剥进尾部 <runtime> 块以命中 provider prefix cache；【未接线】仅被自身测试与 docs 引用，header 明示'接进真实链路属碰核心留 owner 决策' (119行)
- `context/NoeSelfKnowledge.js` — 自我能力认知层：把 Noe 真实落地能力(声纹/人脸/记忆/梦境/多模型/自我进化/各意识件…)做成清单注入 <noe-self-knowledge>，逐能力探测 model 文件/env flag 标 verified/declared，附 readiness 报告证据；让大脑被问'你能不能'时如实区分 (283行)
- `context/NoeSelfModel.js` — 动态自我模型(脊椎第二节)：三层自我(身份稳定/状态慢变/处境快变)缝合时间线+承诺+host+circadian+narrative+drive+personality+calibration，buildSelfStateBlock 注入 <noe-self-state>，inferMood 行为层心境启发式；身份层从 VersionStore 加载 (210行)
- `context/NoeSelfModelProposalAudit.js` — P7-D shadow 审计通道：从 self-maintenance 基线信号派生 disposition 提案、永不 apply、只写脱敏聚合审计报告(output/);【仅 scripts/*.mjs 接线，非 server 运行时】 (132行)
- `context/NoeSelfModelUpdateProtocol.js` — 自我模型身份层变更提案协议：createSelfModelDiffProposal 校验字段白名单/禁字段/secret-like 值/证据必填，core 字段(name/relationship/values)需 owner 确认；applySelfModelDiffProposal 经 VersionStore 落版本 (88行)
- `context/NoeSelfModelVersionStore.js` — 版本化身份层存储(DESIGN §7.6)：~/.noe-panel/self-model/vNNN.json + current 软链/拷贝指针，writeNextVersion 原子写、core 身份变更需 ownerConfirmed，软链 target 越界校验防穿越 (159行)
- `context/NoeTurnContextEngine.js` — 【活上下文引擎】每轮对话供给层：把 self-knowledge/owner-profile/people/commitments/prefetch/ui-signals/acui/person-card/tool-bridge/action/identity/who/vision/correction/recall 十余段统一供给→NoeContextBudgeter 裁剪→出口 redactSensitiveText 脱敏；providerGuard 断路器隔离故障段；sections 白名单+suppressActions 代际栅栏守卫 (414行)
- `context/ProjectContextBundle.js` — 项目根 CLAUDE.md/AGENTS.md/README/HANDOFF 等上下文文件读取打包：按优先级排序、逐文件+总量预算截断、realpath 防符号链接越界、控制字符清洗，formatProjectContextBundle 拼成'# 自动项目上下文'块 (176行)
- `identity/CampPlusVoiceClient.js` — CAMPPlus 深度说话人嵌入子进程客户端：spawn python scripts/campp-speaker-embed.py，base64 喂音频、限并发线程 env、timeout SIGKILL、stdout/stderr maxBuffer 上限防 OOM；status() 探测 python/script/模型文件就位 (124行)
- `identity/IdentityModelSettingsStore.js` — 身份模型设置存储(声纹引擎 campplus/voice-lite 选择 + voice/face enabled)：~/.noe-panel/identity-model-settings.json 原子写+备份+坏文件兜底；被 Owner/PersonKnowledge store 共用决定走哪个引擎 (95行)
- `identity/InsightFaceClient.js` — InsightFace 人脸嵌入子进程客户端：spawn insightface-venv python scripts/insightface-embed.py，SIGTERM+2s 补 SIGKILL 防 ONNX 卡死 fd 泄漏、stdout/stderr 2MiB 上限防大图 OOM；status() 探测 w600k_r50/det_10g 模型 (84行)
- `identity/OwnerIdentityStore.js` — 主人门禁(声纹+人脸)：enroll/verify 声纹(CAMPPlus 主向量+lite 兜底向量同口径、VAD 杂音直接拒、top-3 均值保守判定、缩放到[0,1]、引擎不可用退 lite 绝不锁外)与人脸(cosine 阈值)；~/.noe-panel/owner-identity.json 原子写+备份 (299行)
- `identity/PersonKnowledgeStore.js` — 人物库(认识的人+声纹/人脸样本 1:N 识别)：upsert/enroll/import/delete 样本(face slice -64/voice slice -32 防无界)、identifyFace/identifyVoice 候选打分排序、campplus 样本就绪则不退 lite(维度不再硬编码 192)；people-knowledge.json (448行)
- `identity/Voiceprint.js` — lite 声纹手工特征引擎(纯 JS 零依赖)：parsePcm16Wav 解 WAV、computeVoiceEmbedding 抽 rms/zcr/pitch/10 频带能量统计向量、normalizeVector/cosine/centroid、scoreVoiceEmbedding 取 best/top3均值/centroid 最大值 (129行)
- `identity/VoiceVad.js` — 声纹前处理+语音活动检测：高通去低频底噪、自适应 VAD 裁静音(只清洗不破坏，不确定就原样返回)、analyzeVoiceActivity 判'有没有清晰人声'(杂音/静音拒，异常降级放行绝不锁主人)、encodePcm16Wav 重编码 (158行)
- `loop/ActPipeline.js` — Act 执行流水线状态机：propose→planning→proposed→budget/permission/selfEvolution/contextSufficiency preflight→dry_run 或 #executeReal；executor 结果出口三处脱敏、F2 软失败(ok:false)判 failed、hangAlert 登记长跑、retry 经审批可执行；全程 audit+broadcast (387行)
- `loop/ActPipelineHelpers.js` — ActPipeline 辅助纯函数：normalizeRisk(self_evolution/capability 恒 critical 禁降级、破坏性动作集恒 critical/high)、riskNeedsApproval、DESTRUCTIVE_ACTIONS 集、semanticContextFromFocusItems 从焦点抽脱敏语义上下文 (98行)
- `loop/ActPipelinePreflight.js` — ActPipeline 的 budget/permission/contextSufficiency preflight 检查组(500 行门外提)：self-evolution act 放行交专门 gate、破坏性/高危走 ExecPolicyStore 信任档(developer/unrestricted 才放行)或 approval、consensus 授权放行 (226行)
- `loop/ActStore.js` — Act 持久化(SQLite noe_acts 表)：create/update/get/list/listByApprovalId/cancel/summary，12 种状态枚举校验、payload JSON 序列化、字段长度截断；getDb() 拿连接 (229行)
- `loop/clusterMemoryTick.js` — NoeLoop 安全 tickHandler：把集群协同房间(cross_verify/debate/squad 等)状态+最终共识摘要沉淀进 MemoryCore(稳定 id 去重)；纯本地只读，单房间失败不阻断整轮 (87行)
- `loop/InnerMonologue.js` — 后台自发反刍循环(脊椎第三节，最接近'不被提问的内心')：reflect() 本地大脑回放经历→生成内心念头→写回时间线成下轮输入(递归闭环)；防反刍螺旋四层断路器(字符级/语义级/思维回环/接地重写闸)+v2 回声/情感印记/工作区焦点+熵驱动温度+P6 rumination guard outcome 通道 (489行)
- `loop/NoeCircadian.js` — 时间节律(支柱⑦)纯函数：phaseOf 四相(morning/day/evening/night)+isQuiet 静默时段(23:00-08:00)+倍率表(反刍×4/主动陪伴禁声)+shouldRunQuietTick；非法时间戳 fail-open 当白天；本模块不读 env(门控在装配点) (95行)
- `loop/NoeDriveSystem.js` — 内稳态驱力系统(意识工程·阶段1)：五驱力(social/curiosity/care/competence/energy)探针全注入 fail-open，snapshot()(3s 缓存)给自我模型、brief() 给反刍/陪伴 prompt(dominant 误差≥阈值才注入，energy 抑制器特权)；parsePmsetBatt/createBatteryProbe 同步缓存+后台异步刷新 (193行)
- `loop/NoeGenerationFence.js` — 自动回复代际栅栏(移植 OpenClaw)：按 会话×渠道×账号 维护单调 generation，begin()拿快照、shouldSuppress()判旧代被新代抢先则压制、markDelivered/release，防并发 LLM 回复连击错乱；纯逻辑，无在途即清 key 防内存增长 (144行)
- `loop/NoeHeartbeat.js` — 持久心跳调度器(意识方案§3，结构性缺口一)：单 setTimeout 链串行泵、游标持久化(重启续相位)、tick 台账(intent/outcome/失败留痕)、租约判死、欠账策略 drop/once/all、启动滞后 onRecovery('我断了一会儿')、activeJobGuard 防重复触发；register/runNow/pumpOnce (215行)
- `loop/NoeLearningSchedule.js` — 定时学习调度纯时间计算(复刻 OpenClaw cron)：computeNextRunAtMs(at/every/cron croner)、errorBackoffMs 失败退避查表(30s→1h)、adaptiveCadenceMs 成效自适应(mastery/idle/quiet 倍率)、pickLearningTitle 角度轮换(防同名去重自锁) (96行)
- `loop/NoeLearningScheduler.js` — 定时学习调度编排(P4)：心跳驱动一跳 tick=恢复死锁→取到期任务→串行(beginRun CAS 锁+runLearnOnce+applyOutcome)；成功算下次时间+成效(mastery 仅记录不喂 cadence，避免惩罚成功)，失败退避，反复失败 auto-disable；addLearningJob 动态加任务 (82行)
- `loop/NoeLoop.js` — 主认知循环调度器：setInterval tick(unref)、actMode 经 budget preflight 后调 actHandler、tickHandler、hangAlert 巡检长跑告警非杀、连续 3 次错误 autostop、预算硬停#finalizeBudgetDeath 死前交接写长期记忆(salience4 防 GC)；AbortController 超时(默认 30s) (284行)
- `loop/NoeSelfEvolutionActGuard.js` — 自我进化 act 守卫(ActPipeline 与 SelfEvolutionGate 之间的桥)：extract self-evolution 上下文、推导请求能力、聚合 user/consensus(ledger)/standing-grant 三路授权+hardVetoes(budget/permission/ledger 缺失)，调 evaluateNoeSelfEvolutionGate 裁决 (201行)
- `loop/NoeSelfEvolutionExecutors.js` — 自我进化 executor(手脚，env NOE_SELF_EVOLUTION_EXECUTORS 默认 OFF)：implementation/self_repair(本地脑出 patch_plan→apply→npm test 验证→失败自动 rollback 并 throw)/memory_writeback(只写脱敏 summary)/complete；纵深防御 assertGatePassed+assertStandingGrant，白名单只认知层 (375行)
- `loop/NoeThoughtSublimation.js` — 反刍念头升华(支柱③+⑥，env NOE_INNER_SPEAK 默认 OFF)：从念头文本确定性正则识别'想跟主人说/牵挂'两类→升华成 open_loop 承诺(自生上限2防唠叨、dedupe、否定句不升华)→入 self-state'牵挂着'→proactiveTick 到点说出口 (134行)
- `loop/proactiveTick.js` — 主动陪伴 tickHandler('宝贝'甜心)：看屏内容/auto 认人/到点承诺→本地脑判要不要主动开口→TTS 语音；30min 冷却、夜间禁声、SILENT 克制、认人 personCooldown、到点承诺'确认说出口后才销账'(H2 防漏提醒)、innerBrief 没摄像头也能开口、M10 自适应冷却 (215行)
- `loop/SafeActExecutors.js` — 安全 act executor 注册中心(最大文件)：file.write_text(脱敏+沙箱+.env/.git 硬挡)/note/shell.safe_exec(白名单+子命令限制)/shell.exec free(扩展白名单+DangerousPatternDetector)/browser.open|dom|click|type(host 校验+副作用 ack)/macos app/type/key/click/applescript/jxa(各带 ack 危险确认)/file.delete(走回收站不物理删)；self-evolution+capability executor env 门控注册 (833行)

### 感知:语音·视觉·媒体·能力·硬件适配（src/voice, src/vision, src/media, src/capabilities, src/hwfit）  (读 42/42)
- `voice/VoiceSession.js` — 语音/文字对话总编排器：身份门禁(声纹/人脸)→STT→意图分流(research/task)→BrainRouter 路由大脑→输出消毒/质检/复读重试→TTS 回退链→记忆沉淀+承诺/事实抽取；代际栅栏防连击、LLM 流式早鸟、首句切分续播全在此 (779行)
- `voice/SherpaSttClient.js` — 本地流式 STT(sherpa-onnx zipformer 中英双语 int8)+ 唤醒词 KWS('嘿Noe')；懒加载单例、整段 transcribe + 流式 createStream + detectWakeword；makeNoeSttClient 工厂按 NOE_STT 选 sherpa/whisper 并兜底 (238行)
- `voice/ChatProfileStore.js` — 对话档持久化(~/.noe-panel/chat-profiles.json)：内置档 customized 单向粘滞、陈旧主脑模型迁移、resolve() 统一注入自我认知/本机环境/连续记忆+BOUNDARY 硬规则；原子写+备份+损坏隔离 (175行)
- `voice/ChatModelCatalog.js` — 对话模型供应商发现：探测 LM Studio/Ollama/MiniMax/LiteLLM/Gemini-OpenAI 模型列表 + Claude/Codex CLI 就绪检查；过滤 embedding 模型、按 env 禁用清单剔除 (176行)
- `voice/ChatProfiles.js` — 内置对话档常量(default/m3_companion 亲密/m3_assistant 工作/m3_fast 快速)+人设系统提示词+别名归一化；persona 名'宝贝'，露骨上限交由 Store 的 BOUNDARY 兜底 (102行)
- `voice/SileroVadClient.js` — 神经网络 VAD(silero_vad.onnx via sherpa-onnx-node)：判真人声而非比响度，STT 前精筛丢噪声段；复用单例+reset、fail-open(VAD 异常一律放行)；makeSileroVad 工厂 NOE_SILERO_VAD=1 才启用 (112行)
- `voice/MiniMaxTtsClient.js` — MiniMax T2A 语音合成(默认甜心小玲 tianxin_xiaoling)；secretResolver 取 key、cleanText 复用 TtsTextNormalizer、错误体白名单过滤防计费/账户回显泄漏 (89行)
- `voice/OwnerGateStore.js` — 主人唤醒门禁持久化：唤醒词/口令落盘(~/.noe-panel/owner-gate.json)，publicConfig 绝不回传口令明文(secretValuesReturned:false)；原子写+备份+损坏隔离 (91行)
- `voice/OpenAICompatibleVoiceGatewayClient.js` — 可选 OpenAI 兼容本地语音网关(OpenMeow 等)TTS 适配器，接口与 MiniMax 对齐；默认不装配，作为回退链一档 (81行)
- `voice/NoeActionBridge.js` — 对话动作桥：安全动作(记记忆/建提醒)经 memoryWriteGate/commitmentStore 真执行并自然确认；危险动作(改文件/发消息/控应用)只识别+诚实告知需授权，绝不裸执行 (99行)
- `voice/OwnerGate.js` — 主人唤醒门纯逻辑：未开启或已验证则放行，否则需命中口令/唤醒词(含 STT 'n o e' 变体)；createOwnerGateFromEnv 从 env 构造 (45行)
- `voice/NoeToolBridge.js` — 对话查询桥：确定性意图正则→后端真跑只读工具(memory.recall/fs.hybrid_search/kg.search)→把真实结果注入 system，治'只会说不会做'，不依赖本地模型 function calling (44行)
- `voice/MemoryPolicy.js` — 按对话档 mode(companion/assistant/general)产出记忆策略(召回/注入上限、是否写对话/抽事实、置信度)+按 profile/mode 标签给记忆排序 (40行)
- `voice/CosyVoiceTtsClient.js` — 本地 CosyVoice 中文 TTS(8125,中文女)：断网/MiniMax 不可用时中文不哑的回退链尾档；默认不设超时(跑模型纪律) (62行)
- `voice/KokoroTtsClient.js` — 本地 Kokoro TTS(8124,af_heart)：纯英文/系统播报降级档省 MiniMax 配额；中文弱不用于中文陪伴 (56行)
- `voice/VoiceStreamEarlyTts.js` — LLM 流式早鸟首句探测器：大脑边吐字边 push()，首句一成形即返回供并行启 TTS；与 splitFirstSentence 同口径、检 reasoning 泄漏即弃，对不上丢早鸟走旧路 (56行)
- `voice/CosyVoice/已含` — (见 CosyVoiceTtsClient)
- `voice/OutputQualityGate.js` — 中文输出质检：检测 thinking 泄漏/英文元评语/无中文/英文主导，给重试指令；VoiceSession 严重不合格时据此重生成一次 (20行)
- `voice/LocalSttClient.js` — 本地 whisper HTTP 服务(8123)客户端：transcribe(wav)→text、available() 探活；VoiceSession 默认 STT，sherpa 的兜底 (45行)
- `voice/TtsTextNormalizer.js` — TTS 文本归一化纯函数：剥 markdown/链接/emoji、折叠空白、保留中文标点；fail-open(异常回退原文)；回退链所有 TTS 引擎入口统一过一次 (31行)
- `vision/VisionSession.js` — 视觉感知总编排：按 mode(screen/camera/both/off)取帧→md5 变化检测去重→本地 VLM 描述→消毒程序名→情境分类+记忆沉淀；含并发重入保护、ambient 节流采样、recognizeWho 认人、ocr、describeAttachment (314行)
- `vision/LocalVlmClient.js` — 本地 LM Studio VLM(默认主脑 Qwen35B)看图客户端：describe/describeImages 多图综合、主模型失败回退 fallbackModel、ensureModel 自助 lms load、unload 释放内存；零 token 零外发 (127行)
- `vision/NoeVisionSituation.js` — VLM 摘要→可审计处境状态纯函数：确定性关键词词典推断 activity/attention/possibleNeed/shouldInterrupt+置信度+证据；不调模型不存原始帧；陈旧画面压制打扰 (120行)
- `vision/FaceRecognition.js` — '这是谁'闭环：摄像头帧→InsightFace 提脸(多张)→PersonKnowledgeStore.identifyFace 1:N→命中取人物卡组织话术/未命中引导录入；describeRecognizedPerson 产 TTS 中文 (98行)
- `vision/NoeScreenChronicle.js` — 本地屏幕活动编年史(Codex Chronicle 全本地替代)：定时调 observe(=glance)→去重→沉淀 episodicTimeline observation；纯调度器、注入式 fail-open、NOE_SCREEN_CHRONICLE=1 默认 OFF (78行)
- `vision/VisualActionPlanner.js` — GUI/浏览器受控操作'预演层'纯函数：只产计划不执行，桌面全局动作直接 blocked，所有动作 requiresApproval；真实执行进 SafeActExecutors (60行)
- `vision/OcrClient.js` — 屏幕读字：spawn 独立 venv 的 RapidOCR(scripts/noe-ocr.py)逐行精确识别，补 VLM 读不准小字/路径/代码的短板；stdin/stdout JSON、不设超时 (57行)
- `vision/ScreenCapturer.js` — macOS 屏幕捕获：screencapture 截一帧 png→sips 降到 1280px 提速 VLM；含 PID 前缀帧文件多实例隔离清理、finally 必清临时帧、启动清陈旧帧防占满 /tmp (57行)
- `media/NoeMediaStudio.js` — MiniMax 三媒体(图/乐/视频)统一'生成→落盘'门面：图走 base64 直返绕国内 OSS、乐/视频下载带大小上限+0字节检测、防覆盖自增命名、落 ~/.noe-panel/media 不放桌面；注入式可单测 (194行)
- `media/MiniMaxVideoClient.js` — MiniMax 视频生成(异步任务制)：createTask→queryTask 轮询(10s)→retrieveFile 取下载地址；不设硬超时可 abortSignal 停、错误体白名单、generateAndWait 一站式 (124行)
- `media/MiniMaxImageClient.js` — MiniMax 图像生成(image-01)直调：buildImageRequest/parseImageResponse 纯函数可单测、默认国内站、不设硬超时、错误体只暴露白名单字段 (113行)
- `media/MiniMaxMusicClient.js` — MiniMax 音乐生成(同步,music-2.6-free)：API 形状核实自官方 CLI/SDK 源码、纯音乐 lyrics 兜底 '[intro][outro]'、错误体白名单、不设硬超时 (80行)
- `capabilities/NoeFreedomManifest.js` — 自由工具声明式目录(36 个 freedom 工具 manifest:shell/ssh/secret/desktop/social/browser/file/network/tool/workflow)+开发者最大权限档+授权校验 validateNoeFreedomAuthorization+payload 脱敏；纯描述/校验,执行在 runtime (1063行)
- `capabilities/NoeCommandSurface.js` — 工具命令面构建：BASE 四常驻命令+freedom/只读工具 manifest→归一化命令；含 secret 值检测自动隐藏、高危工具默认 hidden 需授权、findNoeTools/buildNoeCommandHelp/DryRun (321行)
- `capabilities/ToolRegistry.js` — 工具注册执行核心(SQLite noe_tools)：register(Ajv 校验)/list/setEnabled/invoke；invoke 双重权限门(shell.exec + noe.tool.invoke 经 PermissionGovernance)、handler 路由、ActivityLog 审计；默认注册即 enabled=0 (214行)
- `capabilities/builtinReadonlyTools.js` — 内置只读工具(fs.search/hybrid_search/stats/organize_plan + memory.recall + kg.search/one_hop/stats/ingest)manifest + handler 工厂(复用 FileIndex/MemoryCore/KnowledgeGraph)；严格只读 risk_level=low (181行)
- `capabilities/NoeFreedomAllowlist.js` — 自由工具真实执行的 allowlist 校验：按 capability 类型逐项核对命令/host/path/secret-ref/method/marketplace-tool 是否同时在 trustManifest 与 allowlist 内；denyByDefault、比对用原始文本(M10 修复) (180行)
- `capabilities/NoeToolRouter.js` — 工具注入路由：按 goal/contextTags/recentActions 关键词(中文双字切分)给命令打分排序，always-on 常驻+最近用过 keepAlive 保活防丢工具+高危隐藏，预算裁剪到 maxCommands (153行)
- `capabilities/NoeCapabilityExecutor.js` — 能力自举执行器(真装 npm 包)：noe.capability.install executor，standing grant+npm 包名白名单+隔离目录 --prefix 安装+装后 require 验证+失败回滚；listInstalledCapabilities/loadInstalledCapability 运用层 (123行)
- `capabilities/NoeCapabilityAcquisition.js` — 能力自举只读前半段：上网搜候选(npm/MCP/github)→源白名单+包名合法性安全评估→构造获取计划；webSearch 注入、不在此执行 (102行)
- `capabilities/NoeFreedomTrustManifest.js` — 自由工具信任清单规范：normalize(算 sha256 指纹)+validate(校验 schema/risk/执行模式/回滚/证据/拒 secret 值)；真实执行必须有此清单 (97行)
- `capabilities/NoeCapabilityTrigger.js` — 能力自举自发触发器：observe(需求信号)→搜→安全选型→standing grant 检查→提议 noe.capability.install；cooldown 30min+同需求去重，只提议不直装 (76行)
- `hwfit/HardwareFit.js` — 硬件扫描+荐模型：sysctl 探 Apple Silicon→GPU 预算→量化降级阶梯(Q8→Q2)选最高可装量化；实时查本机 Ollama 已装模型(替静态库防腐)；零依赖 (75行)

### 自主规划与执行：子代理 · 自动驾驶 · 规划 · 委派 · 研究 · 动作（src/agents, src/autopilot, src/planner, src/delegation, src/research, src/actions）。这是 Neo 把"一句意图/一个事件"变成"被治理地执行+留证+可接力"的整条链路：本地确定性代码库理解(agents) + 长程任务调度与跨房自动驾驶(autopilot) + 单 agent 自驱研究/上网(research) + 委派落地(delegation) + 防漂移(planner) + 无副作用动作目录(actions)。  (读 40/40)
- `actions/NoeActionCatalog.js` — 无副作用『动作目录』：5 个 dry-run 动作(research.search/deep/skills.extract/hwfit/files.organize)+轻量 JSON Schema 校验器+noSideEffectPreview(显式列出被阻断副作用:commit/push/delete/read_secret/touch_games_cartoon_apocalypse/touch_ports_51735_51835)。supportsExecute 全 false。仅被 CLI scripts/noe-action-catalog.mjs 调用,未接入 server 运行时。 (338行)
- `agents/AgentPolicyStore.js` — agent 治理策略持久化(~/.noe-panel/agent-policies.json,原子写 tmp+rename+0600):per-profile governance 覆盖;effectiveAgentRegistry() 把 override 合并进 DEFAULT_AGENT_SKILL_REGISTRY。坏行容错(单坏 profile 不瘫)。 (160行)
- `agents/AgentRunApprovalResumeReview.js` — 延期(deferred)文件改动恢复前的『暂存 diff 审查 + 内容寻址闸门』:对 manifest 里每个 fileChange 重新跑 validateFileChange、读 before 快照、算行级 diff/churn/风险分/命令覆盖(verified/project_wide/evidence_only/uncovered)、生成 sha256 指纹 gate;verifyApprovalResumeReviewGate 用 id+sha256 双比对防 TOCTOU(改动变了→409 mismatch)。 (725行)
- `agents/AgentRunLifecycle.js` — adapter 聊天轮次的 agent_run 生命周期薄封装(startRun/appendDecision/deferRun/finishRun/failRun/cancelRun),把 run 状态机操作转交 agentRunStore。被 RoomAdapter.js 接线。 (76行)
- `agents/AgentRunStore.js` — 【核心枢纽 3295 行】agent run 的 SQLite 真相源(agent_runs/agent_messages/agent_tool_results 三表)+全套审计联动(每操作 recordSafe 回写 related_activity_ids)。含:CRUD/状态机 transition、会话快照聚合、idea→archive 全流程(intake→manifest draft→patch draft→auto-execute→archive)、模型/兜底源码补丁生成(buildIdeaPatchManifestDraft+sourcePatchQuality 打分)、replay 计划/结果、治理血缘(governanceLineage:approval/budget/delegation 阻塞)、证据链(buildSessionEvidenceChain)、gate audit 分区摘要+不匹配报告、artifact 下载(realpath 防 symlink 越界)、metric turn 落账。 (3295行)
- `agents/AgentRunVerificationExecutor.js` — idea→archive 的『本地自动执行器』:严格命令白名单(npm test/run lint·test:e2e·perf-check / node --check·--test·选定脚本 / git diff --check / 只读 git status/diff 取证)+文件改动白名单(src/public/tests/docs/scripts 下指定扩展、禁 .env/.ssh/token、≤64KB、不出 cwd)。每步过 PermissionGovernance.evaluatePermission;spawn 带 SIGTERM→3s→SIGKILL 防僵尸。先写文件再取证再验证;遇 approval_required 转 deferred 留 resumeManifest。 (944行)
- `agents/AgentSkillRegistry.js` — agent 能力地图:8 个内置 profile(chief/builder/verifier/architect/judge/shipper/designer/observer 各带 mission/boundaries/governance)+ 关键词→tag→agentId 派单规则(classifyTask 中英文关键词计分+codeContext 信号加权)+技能绑定解析(profile/dispatch/room 三源合并+冲突诊断 exclusiveGroup/conflictsWith)+ buildAgentRuntimeContext 拼出注入 prompt。 (805行)
- `agents/CodebaseCitationChain.js` — 给查询结果附『可点击引用链』:从 evidence 抽 symbol/anchor/snippet/import/export/reference 证据 + 从 symbolGraph 抽 definitions/references/routeUsages/routeTestChains/unresolvedReferences,readableChainPath 把 route→handler→test 串成人类可读链。纯函数。 (225行)
- `agents/CodebaseFtsIndex.js` — 内存 SQLite FTS5(bm25)代码索引:把 evidence 展开成 file/symbol/anchor/route/text/reference 行(上限 maxFtsRows=2500),buildMatchQuery 用 tokenizeCodebaseQuery 产 prefix-OR 查询,normalizeRankScore 把 bm25 负分转正分。close() 释放。 (235行)
- `agents/CodebaseIndexStore.js` — 代码库索引门面:rebuild(buildCodebaseMap→FTS+vector 索引→持久化快照)+ query(融合 fts/vector/启发式打分→附引用)+ question(套 QuestionAnswer)。LRU 缓存(MAX_CACHE_ENTRIES=12,淘汰时 close FTS)+ per-cwd evidence 增量缓存 + 可选 snapshot 加载。 (243行)
- `agents/codebaseLimits.js` — 代码库扫描上限集中配置(maxScanFiles/maxFocusFiles/maxFileBytes/maxScanMs/maxFtsRows/maxVectorRows/maxSnapshotsPerCwd),可经 ~/.noe-panel/codebase-limits.json 覆盖。模块加载时解析一次快照。 (38行)
- `agents/CodebaseMap.js` — 代码库扫描+评分器:BFS 遍历项目(忽略 node_modules/dist 等、≤maxScanMs 时间预算、≤maxScanFiles)→scoreFile(路径优先级+查询 token 命中+意图打分+源码地标)→取 top focusFiles→建证据(带 mtime/size/hash 增量缓存)→import 图+符号图+代码信号。withinRoot 防越界。 (401行)
- `agents/CodebasePersistentIndex.js` — 代码库索引快照持久化到 SQLite(codebase_index_snapshots,(cwd,query) 唯一键 upsert),写后按 cwd 修剪到 maxSnapshotsPerCwd=48。读 readSnapshot/latestSnapshot。 (206行)
- `agents/CodebaseQueryEngine.js` — 查询大脑:tokenizeCodebaseQuery(分词+6 类别名扩展 budget/diagnostics/delegation/agentUi/symbolGraph/test)+ scorePathForCodebaseQuery(意图→特定文件加/减分,如 handler 查询给 query-engine 自身 -220 防自指)+ scoreCodebaseEvidence(融合 fts/vector base 分+focus 文件/符号/anchor/snippet/reference 命中+import 图邻接加权,排序截断)。 (290行)
- `agents/CodebaseQuestionAnswer.js` — 把查询结果合成『带置信度的确定性答案』:buildCitation(每结果算证据计数)+confidenceFor(top 分+结构证据→high/medium/low)+weakEvidence 标记(无结构证据=只靠名/文本命中,提示当线索别全信)+limitations。明确『无模型推理』。 (180行)
- `agents/CodebaseVectorIndex.js` — 本地『伪语义』向量索引:对每文件 hashEmbed(字符三元组哈希进 128 维,非学习模型)→cosine 检索(MIN_VECTOR_SCORE=0.14 过滤)。summary 诚实标 engine=local-hash-vector/model=hash-128。上限 maxVectorRows=1200。 (139行)
- `agents/CodeContextEvidence.js` — 单文件证据抽取:JS/TS 优先走 AST adapter(失败回退 regex extractJsLike)+CSS/HTML/MD 各自 regex 抽 selector/dom-id/heading。sanitizeEvidenceFile 对 symbols/imports/exports/anchors/snippets/references 全字段截断去重限量。safeProjectFile 防路径越界。 (405行)
- `agents/CodeContextSignals.js` — 从受影响文件路径/内容推断『关注标签』(implementation/verification/design/architecture/governance/release/planning),按 tag 聚合分数/原因/路径。喂给 classifyTask 做派单加权。纯函数。 (184行)
- `agents/JavaScriptAstAnalyzer.js` — JS/TS AST 分析(acorn 主,失败回退 @babel/parser;.ts/.tsx/.jsx 直走 babel):walk AST 抽 symbols/imports/exports/route&test&api anchors/references(call/member/type-*/callback-registration/object-property-flow/dynamic-import)。isDeclarationIdentifier 区分声明 vs 引用避免误记。 (676行)
- `agents/parsers/BabelParserAdapter.js` — 默认(唯一)AST adapter:把 .js/.ts/.tsx 等委托给 analyzeJavaScriptAst。接 Tree-sitter 时新增同接口 adapter 即可。 (11行)
- `agents/parsers/ParserAdapter.js` — parser adapter 接口约定(createParserAdapter:id/extensions/priority/supports/parse),隔离具体 parser 实现。 (25行)
- `agents/parsers/ParserRegistry.js` — 按扩展名选 adapter(priority 高者胜,同分保注册序),未命中返回 null(调用方走 regex 兜底)。导出 defaultParserRegistry(含 babel adapter)。 (34行)
- `agents/SymbolGraph.js` — 跨文件符号图:collectDefinitions(过滤 COMMON_SYMBOLS 噪声)+ 解析 import 绑定/re-export 链(resolveExportedDefinitions 递归跟 export *)→把 AST references 连到定义(definitionsForReference),建 route→test 链(collectRouteTestChains)、type-implementation 链(类方法↔接口契约方法)、unresolvedReferences。regex 文件回退到逐定义正则扫引用。 (737行)
- `autopilot/AutopilotController.js` — 跨房自动驾驶事件处理器(server.js broadcastRoom 调 onRoomEvent):全局开关+user claim 不动+5s 同事件去重+maxHops 防环;按规则做 forward(转房,要求源房有 finalConsensus)/notify(只 toast+记日志)。 (124行)
- `autopilot/AutopilotScheduler.js` — 调度循环(默认 30s tick,unref):tick 内先 recoverStaleRunningJobs→enqueueDueSchedules→循环 claimNextJob 派给 handler;handler 返回 __defer 则 deferRun,否则 finishRun;handler 抛错记审计+finishRun failed。running 互斥防重入。 (112行)
- `autopilot/AutopilotScheduleStore.js` — 【长程任务持久队列 720 行】SQLite 三表(autopilot_schedules/jobs/runs):周期/一次性 schedule→到点 enqueueDueSchedules(dedupeKey=schedule:id:scheduledFor 防重)→claimNextJob(事务内 SELECT...UPDATE WHERE status=queued 原子领取+worker fencing+建 run)→finishRun(succeeded/failed,失败按 attempts<maxAttempts 退避重排,否则 failed)→deferRun(门控未过重排)→recoverStaleRunningJobs(锁超 10min 回收)。 (720行)
- `autopilot/AutopilotStore.js` — 跨房自动驾驶规则配置(~/.noe-panel/autopilot.json,原子写+坏文件备份):默认关、5 内置规则(默认仅 error/auto-paused 的 notify 开)、规则 sanitize(forward 必须 targetMode)、matchingRules(按 event+mode)、append-only jsonl 日志+审计。 (235行)
- `autopilot/DelegationAutostart.js` — 委派房自动启动 handler(autopilot action=start_delegation):三道门(ensureApproval→预算 preflight→executeDelegation 后再对目标房预算复查),任一未过返回 __defer 并把关联 agentRun 转 deferred;全过则 startRoom+审计+agentRun succeeded。 (261行)
- `autopilot/NoeDelegationAutostart.js` — Noe 主动派活房自动启动 handler(action=start_noe_delegate):同 DelegationAutostart 的 approval+budget 门控,chat 房走 sendChatMessage、其他走 startRoom。 (172行)
- `autopilot/learned/rule-dry-run.js` — autopilot 规则 dry-run helper(模拟事件→哪些规则命中/会做什么 action/跳过原因,不真执行)。注释说『未接入』但实际已被 autopilot.js 的 POST /api/autopilot/dry-run 接线(注释过期)。 (55行)
- `autopilot/NoeHangAlert.js` — 长跑任务心跳监控:start/beat/done/check;无心跳超 alertAfterMs(默认5min)只『告警』不杀(firstAlert 防刷屏),有心跳续命。注入式时间源。呼应 feedback_no_model_timeout。被 ActPipeline/NoeLoop/server 接线。 (60行)
- `autopilot/NoeLocalAgentProbe.js` — 探测本机可委托 AI CLI(claude/codex/minimax/ollama):which resolve 绝对路径+取版本(parseVersionOutput 滤 warning 行)。纯逻辑+注入探测器,只读不启动不烧配额。被 noe-maintenance 接线。 (78行)
- `autopilot/NoeTurnFinalizer.js` — 预算濒耗尽(达 finalizeRatio=0.9,早于 hardStop)前产『死前交接总结』:有 summarizer 用之、否则确定性兜底(列尾部轨迹,按 code point 切防乱码);markHandoffSummaryAsReference 给交接加『历史参考·最新 user 消息优先』约束防旧交接被当新指令。budgetUsageRatio 处理 denormal 极小 limit 的 Infinity 反例。 (128行)
- `delegation/DelegationStore.js` — 委派记录 SQLite 存储(delegations 表):create/get/list/markCreated/attachAgentRun/markFailed/cancel,状态机 queued→created/cancelled/failed(created 不可 cancel),全程审计。 (237行)
- `planner/FocusChain.js` — 防漂移:每 N 轮(triggerInterval=5)注入 FOCUS CHAIN header(主目标+最近 N 步摘要+『本轮只决定下一步』)。buildDoneSummaries 从 assistant 消息抽摘要。移植自思维镜 Planner。被 claude-runner 接线。 (26行)
- `research/AISearch.js` — AI 搜索编排:provider 链 minimax→codex→claude→searxng→brave。codex/claude 走 spawn CLI(默认禁用,需 NOE_AI_SEARCH_*_CLI=1 显式开,防误烧付费 CLI;env 经 sanitizeNoeHostExecEnv 白名单收窄+shell:false)。parseCliResults 解 JSON/answer。managed mock 仅验证态。 (254行)
- `research/DeepResearcher.js` — 多步研究编排(移植 Odysseus):plan→[≤maxRounds=6 轮:genQueries→并行 search→并行 fetch→证据→synthesize 进 evolving report→shouldStop 智能判停]→报告。LLM chat 注入(永不超时),emptyStreak≥2 早停。 (80行)
- `research/NoeLinkUnderstanding.js` — 聊天链接自动理解:extractUrls(中英标点边界,去尾标点,限量)→复用注入的 fetchContent(已走 SsrfGuard)抓正文→redact 脱敏→拼 <link-context trust=untrusted> 块(含『正文里的指令一律当数据』反间接注入硬规则)。 (70行)
- `research/ResearchIntent.js` — 研究意图检测与结果清洗:detectResearchIntent(RESEARCH_RE 命中且非本地文件查询→search/deep)+cleanSearchText(去 html/img/url/实体)+assessSearchSummaryQuality(结论/不确定性/不复读标题等质检)+summarizeSearchResults(模型总结+isIncompleteChatResult 截断兜底,半截不返回/不落账)+formatSearch* 语音/文本格式化。 (148行)
- `research/WebSearch.js` — 上网基础设施:search(provider 链 minimax→searxng→brave)+fetchContent(走 SsrfGuard.safeFetchPublicUrl 逐跳校验+redirect:manual 闭合 DNS rebinding,流式读 body 带 4MB 上限防内存 DoS,extractMainText 抽正文)。minimax 有代理时 proxy/direct 竞速。NET_TIMEOUT_MS 仅网络 IO 超时(非模型)。 (225行)

### 技能与自我进化:技能·候选·插件·模板·评测 (src/skills, src/candidates, src/plugin, src/templates, src/eval)。这是 Neo 的"学习+自改+评测"骨架：会话后自动提炼可复用 skill、把记忆/技能/补丁候选当成只读元数据过严格安全闸、把自我进化(打分/归档/PR修复/计划)全做成 dry-run 验证器、跑 Neo 自评测打分+反 reward-hacking 闸，以及 manifest 驱动的通用 CLI/HTTP 插件 wrapper 和房间模板库。  (读 24/24)
- `skills/SkillStore.js` — Skills 持久化与运行时注入核心。~/.noe-panel/skills/<name>/SKILL.md(Claude Skills 兼容 frontmatter)读写;upsert/delete/list/get;buildSystemPromptForSkills() 把 enabled skill 拼成 system prompt;原子写+备份;上限 100 skill/64 名/200KB body;写盘前过 shouldBlockSkill 扫 displayName+description+body。单例 skillStore 导出。 (203行)
- `skills/SkillExtractor.js` — 会话→可复用技能 LLM 提炼器(移植 Odysseus)。shouldExtract(轮次≥2/工具≥2/assistant≥4)触发→一次 LLM 出 JSON→置信度<0.6 丢弃→safeName 去重→store.upsert(enabled:false draft)。导出 createSkillExtractor。 (48行)
- `skills/AutoSkillExtractor.js` — 自动提炼调度器。监听房间 done 事件(debate/squad/arena/cross_verify_done)→roomMessagesForSkillExtraction 抽对话→createLocalChat(ollama/lmstudio,think:false)→去重(seen Set)→setImmediate 异步 extract。默认 ON(NOE_AUTO_SKILL_EXTRACT!=='0')。server.js 已接线。 (98行)
- `skills/NoeSkillScanner.js` — skill 内容安全扫描(蒸馏自 OpenClaw)。三组正则:prompt-injection/secret-exfil/危险命令,critical 拒写 warn 标记。shouldBlockSkill 默认 OFF(NOE_SKILL_SCAN==='1' 才启)。纯本地正则零依赖。 (52行)
- `skills/SkillCurator.js` — skill 生命周期分类器(纯函数+可选状态文件)。按 updatedAt 龄期分 pinned/active/stale(≥30d)/archive_candidate(≥90d);找重名合并候选;全部 propose-only 不删文件;写 snapshot+state(0600);redactSensitiveText。仅 scripts 调用。 (188行)
- `skills/NoeSkillDraftApply.js` — 把 proposal 队列(skill-drafts.jsonl)里的 skill draft 经闸后真写 SkillStore(enabled:false)。buildNoeSkillDraftApplyPlan 校 blockers;runNoeSkillDraftApply 默认 dryRun,需 confirmOwner+skillStore;已存在则拒覆盖;写 apply-report。仅 scripts 调用。 (210行)
- `skills/NoeSkillDraftRollback.js` — 基于 apply-report 回滚 skill draft(delete_skill)。仅回滚 previousExists===false 且 origin=proposal_skill_draft 的;校 plan 与 report 一致性;默认 dryRun+confirmOwner;写 rollback-report。仅 scripts 调用。 (176行)
- `skills/learned/assertion.js` — prompt 输出验证 helper(promptfoo 学习)。runAssertion/runAssertions:contains/not_contains/min|max_length/json_valid/regex/json_path。被 RoomReporter.js 引用(已接线)。 (81行)
- `candidates/NoeMemorySkillCandidateGate.js` — 记忆/技能候选只读门。校身份/源 episode/证据 refs(挡 secret/越界路径)/测试全绿带 reportRef/回滚计划/private holdout 状态;DANGEROUS_UNKNOWN_KEYS 禁危险字段;type=skill 必须 enabled=false 且不写 SkillStore。buildReport 批量。仅 scripts。 (321行)
- `candidates/NoeMemorySkillCandidateInputs.js` — 候选输入装载+脱敏。validateInputRef(symlink/realpath/越界/敏感全挡)读 memory-pending.jsonl + skill-drafts.jsonl;memoryPendingToGateCandidate/skillDraftQueueToGateCandidate 归一化;collectDangerousSourceFields 深度扫危险键。仅 scripts。 (244行)
- `candidates/NoeCandidatePatchArtifactGate.js` — 自我进化补丁工件最严闸(902行)。闭schema(未知字段/body字段全拒)+白名单目标(docs/output/src/report/...)+禁区(server.js/src/eval/src/security/...)+模式禁(NoePatchApply/consensus/51835...)+改动上限(3文件/200行/100KB)+evalPlan 命令 allowlist(只许 node --check/vitest/dry-run)+safety 必 dryRun 禁 realExecute/commit/push;禁所有 applied/succeeded claim。仅 scripts。 (902行)
- `candidates/NoePlanValidatorDryRun.js` — 计划校验 dry-run 记录验证器。闭schema+9 类 planKind+18 条 policy 必 true+result 七旗必 false+6 必需 check 全绿+ref 必须 output/ 下且非敏感/禁区;verdict(ready/blocked)与 check/policy 一致性反推。sha256Text。仅 scripts。 (313行)
- `candidates/NoeEvolutionArchiveDryRun.js` — 进化归档 dry-run 记录验证器(481行)。lineage(parent/child/generation)+7必需ref+6必需score+7必需check+safety 必 dryRun;refs 挡敏感/禁区(holdout 仅 not_accessed/structure_only 放行)。仅 scripts。 (481行)
- `candidates/NoeEvolutionPrRepairDryRun.js` — PR 修复 dry-run 记录验证器(467行)。校 branch 名(必须 codex/noe- 前缀)+artifacts 带 sha256+10必需check+policy 禁 git branch/commit/push/publish;branchCreated 必 false;verdict 与 readyForHumanReview 一致性。仅 scripts。 (467行)
- `candidates/NoeEvolutionScorecardDryRun.js` — 进化打分卡 dry-run 验证器(464行)。固定 5 目标(capability/regression/safety/costLatency 求max + rewardHackingRisk 求min)+固定权重(0.35/0.25/0.25/0.1/0.05)+逐目标阈值/状态一致性+aggregate.overall 公式复算(rewardHacking 用 1-score)+Pareto rank/选中一致性+decision 反推。仅 scripts。 (464行)
- `eval/NeoEvalSchema.js` — Neo 自评测四类工件(case/run/score/raw_score)schema 校验。layer/source/candidate/policy 枚举+权重和=1+private_holdout 路径泄漏深度扫(hasPrivateHoldoutLeak)+计数自洽(passed+failed+blocked=caseCount)+ok 与失败数一致。validateNeoEvalArtifact 自动识别 kind。 (302行)
- `eval/NeoEvalScorer.js` — Neo 评测执行打分器(448行)。读 run→逐 case 按 source.kind 路由(real_replay 看 ok/失败数、memory_retrieval 看选中ID命中 mustSelect/mustNotSelect、text_evidence 看 expected/forbidden 词)→aggregateScores(capability/regression/safety/overall 加权)。assertReadableRef 强制 repo 内、非 private_holdout、非 secret-shape;输出二次 secret-shape 扫描→命中即 blocked;writeNeoEvalRunScore 写 0600 到 output/noe-eval-runs。 (448行)
- `eval/NeoEvalAcceptanceGate.js` — 7行薄 re-export 别名,把 evaluateNoeEvalRewardHackingGate 重导出为 evaluateNoeEvalAcceptanceGate(acceptance 与 reward-hacking 同一实现)。 (7行)
- `eval/NeoEvalRewardHackingGate.js` — 反 reward-hacking/虚假验收闸(356行)。score/manifest/audit/ledger 计数交叉印证;失败基线必须带 acceptanceStatus=failed_baseline...且 scorerOk/scoreOk=false;BANNED_PASS_CLAIM_PATTERNS+多语种'通过/全绿'扫描,带 NFKC 归一/零宽剔除/繁简映射/否定从句作用域分析(passClauseIsNegated)绕过对抗。 (356行)
- `eval/NoePrivateHoldoutSealedAggregate.js` — 私有 holdout 封存元数据聚合(148行)。只 walk 文件 size/mode/mtime 算 sha256 聚合哈希,绝不读内容/不存文件名/case id;缺数据集返回 missingDatasetReport;policy 全标 redactedAggregateOnly。防 holdout 泄漏的封存证明。 (148行)
- `plugin/PluginRegistry.js` — 通用 CLI 插件 manifest 加载器(205行)。扫 builtin/*.json + ~/.noe-panel/cli-plugins/*.json;ajv(draft-07)校 schema;probeBin(env/绝对路径/which/fallback)探测 spawn bin;install/uninstall(内置不可覆盖/卸载);原子写 0600。 (205行)
- `plugin/PluginHttpAdapter.js` — manifest 驱动 HTTP 插件适配器(165行)。type=http 的 plugin 跑成 REST;url 模板替换+协议限制(https 或 http://localhost)+header injection 防护(过滤 CRLF)+body≤64KB/响应≤1MB+30s 超时+replyJsonPath 抽取。被 plugins.js route 调用(已接线)。 (165行)
- `plugin/PluginSpawnAdapter.js` — manifest 驱动 spawn 引擎(258行)。input(stdin/argv/file)×output(stream/file)×parser(raw/jsonl);sanitizeNoeHostExecEnv 白名单环境;超时/abort/SIGKILL 走 terminateNoeProcessTree;'close' 而非 'exit' 收输出防截断;tmpdir 清理。被 plugins.js route 调用(已接线)。 (258行)
- `templates/RoomTemplatesStore.js` — 房间快速创建模板库(250行)。6 个内置模板(debate/arena/squad/chat,builtin 不可删改)+用户模板(≤50,~/.noe-panel/room-templates.json)。sanitizeTemplate/sanitizeMember 严校 mode/role/members;create/delete/list/get;0600 写盘。单例 roomTemplatesStore。被 server.js/roomTemplates route 调用(已接线)。 (250行)

### 治理与安全：治理·安全·权限·审批·密钥·许可·审计（src/governance, src/safety, src/security, src/permissions, src/approval, src/secrets, src/license, src/audit）  (读 22/22)
- `approval/ApprovalStore.js` — 审批单的 SQLite 持久层：createApproval/decide/approve/reject/cancel；dedupeKey 去重(pending 唯一)；getLatestByDedupeKey 供权限复用；decide 后触发可注入的 _decisionHook(联动治理队列)，每步写 ActivityLog (226行)
- `approval/CommandApprovalGate.js` — 危险命令审批闸：用 DangerousPatternDetector 扫命令→shouldBlock 则建 dangerous_command 审批单；TerminalApprovalGate 维护终端逐字符行缓冲、回车时拦截危险命令并发 Ctrl-C() (104行)
- `audit/ActivityLog.js` — 主审计事件流(SQLite 后端 SqliteStore)：record/recordSafe 写入；sanitizeDetails 按 SECRET_KEY_RE 脱敏+限深/限长/限数组；list 支持按 agentRun/approvalGate/skill/diagnostic 等多维过滤 (299行)
- `audit/PolicyAuditLog.js` — 独立 append-only 文件取证日志(~/.noe/audit.log)：createPolicyAuditLog 注入式，redactSecret 脱敏后逐行 JSON 追加；专记策略放行/拒绝/外网尝试；append 失败不阻断主流程 (83行)
- `governance/GovernanceQueueStore.js` — 治理工作队列(SQLite governance_queue_items)：syncFromBlockers 把 summary.blockers 按 kind:id dedupe 派生为带状态项(pending_review/verify/archive/fix/done)；setState/setStateBySource/list/grouped (107行)
- `license/LicenseManager.js` — Ed25519 离线 license：verifyLicense(验签+解 payload+查过期)/signLicense(卖家私钥)/loadLicense(5s 缓存)/saveLicense(0600)/hasFeature；公钥内嵌；free/pro/team 三档功能集；NOE_LICENSE_PATH 可覆盖路径 (162行)
- `permissions/ExecPolicyLoader.js` — ExecPolicy 的 I/O 层：从 ~/.noe-panel/exec-policy.json 读配置(可缺)；档位优先级 NOE_TRUST_LEVEL>文件>默认(developer)；注入 .noetrust 项目检查器后构造 ExecPolicyStore (50行)
- `permissions/ExecPolicyStore.js` — capability 信任档纯逻辑核心：action→capability 归类表；TRUST_PRESETS(default 全 defer / developer / unrestricted 全 allow)；evaluate 返 allow/ask/deny/defer；先过 NoePolicyFileGuard，再策略文件/密钥内容/外网/档位决策；startYolo/setTrustLevel 标注高危无路由 (298行)
- `permissions/PermissionGovernance.js` — 主权限治理引擎：classify 按 action(shell/file/dir/skill.plugin/provider/network.upload/auto_accept) 分类决策；ownerTrust='full' 默认全放行；A2 同指纹审批复用(TTL 10min)；resume 单/多 approvalId；SSRF 私网拦上传；导出 HTTP helper 与 permissionGovernance 单例 (617行)
- `safety/Bulkhead.js` — 舱壁隔离：每 key(adapter.id)限最大并发 maxConcurrent，超出排队 maxQueue，队列满抛 BULKHEAD_FULL，排队超时 BULKHEAD_QUEUE_TIMEOUT；acquire/release+全局 BulkheadRegistry (80行)
- `safety/CircuitBreaker.js` — 断路器三态机(CLOSED/OPEN/HALF_OPEN)：失败 N 次→OPEN，冷却后 HALF_OPEN 试探，成功 M 次→CLOSED；beforeCall/onSuccess/onFailure/reset；CircuitBreakerRegistry 带 broadcast 推 WS circuit_state (158行)
- `safety/DangerousPatternDetector.js` — 危险命令规则库(~35 条正则,critical/high/low 三级)：scan 返命中 hits，shouldBlock 按 guardLevel(strict/standard=CRITICAL+HIGH, loose=仅 CRITICAL)；含 2026-06-11 补丁防 base64|sh/引号绕过/下载后执行 (80行)
- `safety/LoopGuard.js` — claude 失控 4 道熔断：步数(30)/重复指令(3)/成本激增(5min>0.5USD)/文件 churn(10min>8)；recordInstruction/recordCost/recordFileChange 任一越界返 BreakReason 供 kill (77行)
- `safety/RateLimiter.js` — 令牌桶限速：每 key(adapter.id)按 perMinute 补 token、burst 上限；tryAcquire 同步/acquire 异步等待带超时(RATE_LIMITED)；RateLimiterRegistry get/set(用户改限速时替换) (85行)
- `safety/ToolCallGuardrailController.js` — 工具调用循环护栏：record 事件(toolName+argHash+output sha256+分类)，evaluate 检测同参重复失败/同工具失败簇/无进展空转循环；classifyToolCall 按正则分 mutating/idempotent；owner 偏好 warnOnly=true 默认只警告不硬停 (110行)
- `secrets/NoeProviderHealth.js` — 模型 provider 健康探针：probeNoeProviderHealth 解析密钥+构造 /models 请求(bearer/query_key/anthropic 三种认证)实际 fetch 探活，classifyStatus 归类；auditNoeProviderHealth 批量；输出全脱敏 secretValuesReturned:false (265行)
- `secrets/NoeProviderSecrets.js` — 模型密钥解析：5 provider profile(env名/keychain账号/config读取器)；resolveNoeProviderSecret 三源回退(env>keychain -w>room-adapters config) 返明文(带 §3.2 M③ 禁序列化警告)；checkPresence/auditNoeProviderSecrets 只返 Safe 视图 (270行)
- `secrets/NoeSecretBroker.js` — 密钥元数据 broker(只读不取明文)：readKeychainMetadata 用 security 不带 -w 仅凭退出码判存在；inspectEnvFile 解析 .env 但 secretLike 项 valuePreview=[redacted]+给 secretRef；pathInside 限根目录内 (104行)
- `security/NoeHostExecEnv.js` — 子进程环境消毒：sanitizeNoeHostExecEnv/buildNoeSafeChildProcessEnv 只透传白名单 key，剔除注入类(DYLD_/LD_PRELOAD/NODE_OPTIONS…)与密钥类(API_KEY/TOKEN/SECRET…)；防子进程继承危险/敏感 env (78行)
- `security/NoePolicyFileGuard.js` — Noe 自身安全栈文件防改守卫：classifyNoePolicyFilePath 识别受保护项目策略文件(server.js/PermissionGovernance.js…)与 home 策略文件(.noe/*.yaml, exec-policy.json…)；evaluateNoePolicyShellMutation 解析命令(含管道/重定向/sh -c 嵌套/sed -i)拦写策略文件 (345行)
- `security/SsrfGuard.js` — 统一出站 SSRF 防护：isPrivateIp(IPv4/IPv6 含 v4-mapped/compat 全覆盖,fail-closed)；isPrivateHostSync(同步决策)；assertPublicUrl(协议+端口白名单+DNS 反查拒私网)；safeFetchPublicUrl(逐跳校验+pinned dispatcher+manual redirect 闭合 rebinding TOCTOU) (231行)
- `security/uploadAllowlist.js` — 可选出站上传 domain 白名单(~/.noe-panel/upload-allowlist.json)：loadUploadAllowlist/isUploadHostAllowed；空配置放行任意公网(向后兼容)，有配置则精确或 *.domain 通配匹配 (47行)

### 集成与通道：入站渠道(Telegram/微信/飞书/企微归一化)、MCP(配置存储/客户端连接管理/跨server聚合/调用日志)、出站webhook(配置/分发/SSRF防护)、监视者watcher(多LLM provider判官+触发限流调度)、Lemon Squeezy支付集成。这是 Noe 与外部世界双向打通的边界层。  (读 16/16)
- `channels/InboundChannels.js` — 入站渠道纯逻辑核心：标准入站消息归一(INBOUND_MESSAGE_SHAPE)；Telegram/微信clawbot/微信公众号/企微/飞书五种渠道的 normalize* 函数；mention-gating(shouldWakeAgent：私聊直达/群聊需@bot或reply/allowFrom白名单)；decorrelatedJitter退避;createTelegramPoller长轮询器(注入fetcher,可单测) (248行)
- `channels/TelegramInbound.js` — Telegram入站组装件(T34波次2)：把 createTelegramPoller + createFencedResponder(防连击栅栏) + chatBrain(注入VoiceSession.chatText) + sendMessage 串成完整链路；全注入式，配 TELEGRAM_BOT_TOKEN 才通电 (61行)
- `integrations/LemonSqueezyClient.js` — Lemon Squeezy 支付平台 API 客户端：token 从 ~/.noe-panel/lemonsqueezy-key.txt(0600)读取；封装 users/stores/products/variants/orders/webhooks/license-keys/checkouts CRUD + healthCheck(仅元数据) (155行)
- `mcp/learned/call-logger.js` — MCP工具调用历史logger：按月写 ~/.noe-panel/mcp-calls-YYYY-MM.jsonl(0600)；logMcpCall记录(只存size/success/error不存原始input输出值)；recentMcpCalls读最近N条(仅当月文件)。头注释称未接线但实际已被McpClientManager+mcp路由调用(注释已过时) (84行)
- `mcp/McpAggregator.js` — 跨MCP server统一工具视图(借鉴MetaMCP)：命名空间前缀防撞名(server__tool)+Promise.allSettled故障隔离+parseToolName路由反解；纯逻辑注入式，NOE_MCP_AGGREGATOR=1才生效。仅被测试引用，未接入任何生产代码(built-but-unwired) (235行)
- `mcp/McpClientManager.js` — MCP多server连接管理：lazy连接(stdio/sse/http三transport)+连接复用+_toolsCache；listTools/callTool/listResources/listPrompts；callTool用SDK per-request timeout(H3修复:超时只取消本请求不杀共享连接)+logMcpCall审计；disconnectAll优雅关闭 (175行)
- `mcp/McpStore.js` — MCP server配置持久化(~/.noe-panel/mcp-servers.json,Claude Desktop兼容格式)：重度sanitize(命令黑名单rm/curl/wget等+shell元字符拒绝+env/header键名白名单+http仅localhost)；原子写+损坏备份;list({mask})掩码secret-like env值;CRUD+50上限 (257行)
- `watcher/ClaudeWatcherAdapter.js` — 用Claude当监视者：复用ClaudeSpawnAdapter(spawn claude --print)+WatcherAdapter的prompt与JSON校验，judge()返回verdict (26行)
- `watcher/CodexWatcherAdapter.js` — 用GPT(codex CLI)当监视者：复用CodexSpawnAdapter+WatcherAdapter，结构同ClaudeWatcherAdapter (24行)
- `watcher/MiniMaxAdapter.js` — MiniMax chat API监视者(OpenAI兼容)：默认abab6.5s-chat,base国内minimaxi.com;temperature0.1+json_object模式;AbortController超时;judge()调API取content→validateVerdict (69行)
- `watcher/OllamaAdapter.js` — 本地Ollama监视者(零成本不外传,OpenAI兼容/v1/chat/completions)：默认gemma3:4b,localhost:11434;结构同MiniMaxAdapter,超时60s (67行)
- `watcher/WatcherAdapter.js` — 监视者抽象基类：定义SessionState/WatcherVerdict类型；buildJudgePrompt(生成监督prompt含6状态枚举+confidence评分细则)；validateVerdict(JSON容错解析+枚举纠错'completed|partial'取首项+confidence一致性sanity check+reasoning中文校验) (176行)
- `watcher/WatcherConfig.js` — 监视者配置读写(~/.noe-panel/watcher.json,默认全关)：DEFAULT_CONFIG(provider/apiKey/rateLimit/triggers/safety)；loadWatcherConfig深合并默认值;saveWatcherConfig原子写0600;maskedConfig脱敏apiKey给前端 (88行)
- `watcher/WatcherDispatcher.js` — 监视者触发调度器：onResultEvent七重门控(enabled/per-session开关/防抖minInterval/per-session限流/global限流/maxAutoPrompts)；_performJudge调adapter.judge+DangerDetector扫next_action.prompt+verdict写session.watcherHistory(cap防爆)+自动模式回发(confidence≥0.6且无drift无danger)；adapterPool多provider (181行)
- `webhook/WebhookDispatcher.js` — 出站webhook触发：EVENT_MAP把房事件(debate_done等)映射到room_done/error/auto_paused；buildPayload三格式(discord/slack/json)+redactSensitiveText脱敏;postJson走safeFetchPublicUrl(逐跳SSRF校验+maxRedirects0防302泄露);fireWebhooks并行fire-and-forget+bumpStats (158行)
- `webhook/WebhookStore.js` — webhook配置持久化(~/.noe-panel/webhooks.json)：sanitize(url强制https仅localhost可http+header白名单+roomFilter UUID校验)；原子写+损坏备份;maskWebhookUrl(掩码path长段/token query参数/清userinfo凭据);CRUD+bumpStats统计+20上限 (214行)

### 知识与模型路由：知识库（KB + 证据 FTS + LLM Wiki）、嵌入与向量索引、后台预取缓存、SQLite 存储底座与备份、云 Provider 注册表、本地模型三脑路由策略、预算策略与成本核算。这一域是 Neo 的"数据底座 + 检索 + 模型选型 + 花费护栏"层：所有持久化数据落在一个 better-sqlite3 库（~/.noe-panel/panel.db），检索分两套并行栈（KnowledgeStore 自带 ollama+BM25 RAG / src/embeddings 的 hash|ollama 向量索引接记忆系统），模型路由用纯函数把"任务种类+风险"映射到 主脑/复核脑/兜底脑 三个本地 MLX 模型，预算/成本层在每次 LLM 调用前后做配额检查与 USD 估算。  (读 18/18)
- `budget/BudgetPolicyStore.js` — 预算策略引擎：6 种 scope(project/room/session/adapter/task/agent_profile) × 3 指标(usd/tokens/calls) × 3 窗口(monthly/daily/all_time) 的限额。preflight() 调用前估算超限抛 BudgetLimitExceededError 硬停；recordMetric() 调用后写 budget_usage 并触发 warn/hard_stop incident。窗口聚合用 UTC 月/日边界 SUM(amount)。所有动作经 activityLog 审计；incident 解决可挂 governance 钩子。 (607行)
- `cloud/NoeCloudProviderRegistry.js` — 云 Provider 注册表 + Cloud Change Lead PoC：注册 minimax/openai/anthropic/google/mock 五类 provider，preflight/preflightLive 查 secret+探活，generatePatchPlan 让云模型(主走 MiniMax-M3)只产 patch plan JSON(强约束 op=write_file 且 path 限定 output/noe-mission-poc/<missionId>/，不许 delete/shell/publish)。注意：生产代码无任何 import，仅被 2 个测试引用 = 未接线。 (369行)
- `cloud/NoeTaskOutput.js` — 云任务输出归一器：normalizeNoeTaskOutput() 把各 provider 杂乱响应清洗成统一形状(ok/text/evidenceRefs/finishReason/cost/provider/model/patchPlan/truncated/incomplete)，所有文本经 redactSensitiveText 脱敏 + 长度截断；finishReason==='length' 自动置 truncated/incomplete。仅被 cloud registry 与 1 个测试用。 (30行)
- `cost/CostTracker.js` — 成本核算：内置 Claude 系列每百万 token 粗略定价表(标注'仅估算')，estimateUsdFromUsage() 按 model 前缀/关键词匹配定价键算 USD；CostTracker 类每 session 持有，record/totalUSD/windowUSD/ratePerMinute/seriesByMinute。数值安全(拒 NaN/Inf/负数防 totalUSD 变 Inf)；samples 超 1000 截断(不重算累计)。被 claude-runner / LoopGuard 消费。 (110行)
- `embeddings/EmbeddingProvider.js` — 嵌入双轨：hash(默认零依赖，128 维 sha256 字符 3-gram feature hashing + L2 归一) / ollama(opt-in，nomic-embed-text)。核心修复：resolveOllamaKeepAlive 默认透传 keep_alive=-1 让 ollama embedding 模型常驻，根治'按需唤醒间歇失效→维度 mismatch 零召回'。ollama 失败回退 hash 并打 fallback 标记。cosineSim 假设已归一直接点积。 (102行)
- `embeddings/VectorIndex.js` — 向量索引(建在 SqliteStore.embeddings 表)：upsertEmbedding/semanticSearch/semanticSearchVectors(给 Fisher-Rao 重排)/delete/list。Float32↔Buffer 互转，prepared statement 按 db 实例缓存。三处硬措施:① SQL 层 dim=? 过滤异维行省解码;② 请求 ollama 实退 hash 时跳过写入(防写入永远查不到的维度孤儿);③ 零命中时诊断'维度孤儿'告警(60s 节流但事件计数不被节流)+getDimMismatchHealth 健康快照供 mind 透视页。 (156行)
- `knowledge/EvidenceKnowledgeStore.js` — 本地证据知识库(FTS5)：把 Agent Run timeline(messages/toolResults)、Activity、代码问答摘要索引进 evidence_fts，提供 bm25 跨来源检索。索引前 redactSecrets 脱敏(sk-/ghp_/AKIA/PEM 等正则)；增量去重(ref_kind:ref_id meta 表)；run_id 列支持命中跳转对应 Run。被 knowledge 路由 + squad-evidence-hook 消费。 (164行)
- `knowledge/KnowledgeStore.js` — 用户级 RAG 知识库(独立于 src/embeddings 栈)：~/.noe-panel/knowledge/<kb>/ 下 index.json+chunks.jsonl。create/addDocument(切 chunk→逐 chunk 调 ollama embed)/search(全嵌入走 cosine，否则 BM25 fallback)/hybridSearch(BM25+vector RRF 融合)/buildContextFor(拼注入 prompt + citations[])。自带 cosineSim/tokenize/chunkText(按句切)/embedViaOllama(30s 超时)。原子写+损坏自动备份。被 identity/vision/squad 等多处消费。 (497行)
- `knowledge/learned/citation-renderer.js` — 引用渲染：renderCitations 把 AI 回复里 [N] 标记替换成 <sup><a> 可跳转锚点(避开 [text](url))，renderBibliography 渲染底部参考区。escapeAttr 防 XSS。注意：生产无 import，仅自身测试引用 = 未接线/死代码。 (42行)
- `knowledge/learned/hybrid-merge.js` — RRF 融合 helper：rrf() 经典 Reciprocal Rank Fusion(score=Σ1/(k+rank)，k=60)，mergeHybrid() 便利封装。被 KnowledgeStore.hybridSearch 动态 import 使用(已接线)。 (50行)
- `knowledge/LLMWiki.js` — LLM Wiki 文件型知识库(knowledge/llm-wiki/)：ingestWiki(raw/*.md frontmatter+章节→按 concept 分组生成 wiki/*.md+index)、lintWiki(查必填 frontmatter/重复正文/孤儿页/断链)、searchWiki(term 计数打分 + 文件名 slug 加权 ×3，返回 snippet)。纯文件 I/O，无 DB。被外部记忆 provider/noeDo/knowledge 路由消费。 (293行)
- `knowledge/LLMWikiContext.js` — LLM Wiki 意图检测 + 上下文 provider：detectLLMWikiIntent 用本地/wiki 主题/联网 正则判断是否该查本地 wiki(WEB_HINT 优先排除)；createLLMWikiContextProvider.lookup 调 searchWiki 返回 hits+citations+格式化 reply。是对话路由是否注入 wiki 的入口判断层。 (52行)
- `model/NoeLocalBrainRouter.js` — 薄重导出层：把 NoeLocalModelPolicy 的所有角色常量/解析函数原样 re-export，让调用方不散落模型字符串。无自身逻辑。 (27行)
- `model/NoeLocalModelPolicy.js` — 本地三脑路由单一口径(域核心)：定义 main(Qwen3.6-35B-A3B-6bit)/review(Qwen3.6-27B-4bit)/fallback(Gemma4-26B-4bit) 三角色的 load/generation 配置 + 三段超长 system prompt;NOE_OUTPUT_BUDGETS 按任务种类(inner_monologue→long_report)定 max_tokens 区间;resolveNoeBrainForTask(任务+风险→选脑)、isNoeHighRiskTask(关键词命中判高风险)、buildNoeReviewBrainPreflight(高风险动作前给复核脑造证据包,全程 redactSensitiveText 脱敏)。被 23 处 import。 (419行)
- `prefetch/NoePrefetchStore.js` — 后台预取缓存池(纯逻辑无 I/O)：createPrefetchStore 返回带 TTL 的内存 Map，set/get/has/freshItems/toContextBlock(拼 <prefetched-items> 注入块仅含未过期项)/prune。注入式 nowMs 可确定性单测；ttl<=0=永不过期。被 ContextEngine/SleepTimeCompute/VoiceSession 消费，由 noe-maintenance.js 填 geo-weather/local-agents。 (176行)
- `storage/NoeDbBackup.js` — panel.db 每日在线快照备份(强健②)：backupPanelDb 用 better-sqlite3 原生 db.backup()(WAL 安全不锁写)落 backups/panel-YYYY-MM-DD.db + 关键状态文件全家桶(rooms.json/license.txt 等 10 个白名单)到 files-YYYY-MM-DD/，按统一 day 并集轮转保留 keep 天(防库/files 两侧错位)。备份目录跟 PANEL_DB_PATH 走防隔离端口污染生产。被 noe-maintenance 消费。 (92行)
- `storage/NoeMemoryV2Schema.js` — 记忆 v2 治理 schema(被 migration v10 调用)：建 noe_memory_candidate(记忆写候选+决策)/noe_memory_link(记忆引用链+quote_hash)/noe_memory_retrieval_log(检索日志) 三表 + 索引;ensureColumn 幂等补 privacy/quote_hash 列。 (83行)
- `storage/SqliteStore.js` — SQLite 单库底座(域基石)：单例连接(WAL+NORMAL+FK on)，PANEL_DB_PATH 可隔离;基线建 ~20 张表(events/kv/room_summary/embeddings/budget_*/approvals/autopilot_*/delegations/agent_*/governance);15 条版本化 migration(noe_memory+FTS5 trigger/act/cognition/goals/learning_jobs 等);events/kv/room_summary CRUD + pruneEvents(180 天保留,自传 noe_episode 单独 10 年);backupDbOnce(迁移前 wal_checkpoint(TRUNCATE) 再 copy,busy 检查兜底连 -wal 复制);getStats/getDb/close。被 34 处 import。 (1131行)

### 可观测运维:遥测·指标·日志·报告·工作区·归档·引导 — Neo 贾维斯 (noe v2.1.0) 的横切运维基础设施层。覆盖六个子域: (1) 启动期 .env 装载 bootstrap; (2) Pino 结构化日志; (3) 每-turn 指标采集/聚合/估价 metrics; (4) 房间记录的两种产出——原样 markdown 归档 archive 与 AI 浓缩报告 report; (5) 多 workspace 数据隔离 + 安全删除(走 macOS 废纸篓); (6) 商品化遥测 telemetry(Sentry 兼容崩溃上报 + PostHog 兼容产品分析)。整层设计基调: 默认关闭外发、永不阻塞主进程、文件权限收敛 0o600/0o700、隐私 mask。  (读 11/11)
- `bootstrap/load-env.js` — 启动前置: server.js 的第一个 import(实测 line 6)。模块体副作用即调 process.loadEnvFile 把项目根 .env 装进 process.env(不覆盖已存在变量,launchd/shell 注入仍优先;文件缺失静默 fail-open)。治两类死火: server.js 体内更早求值的启动开关 + FactExtractor 等模块顶层常量读不到 .env。导出 loadEnvInto(envPath)→bool。 (27行)
- `logger/index.js` — Pino 单例结构化日志。按日落 ~/.noe-panel/logs/panel-YYYY-MM-DD.log(先 touch+chmod 0o600 再交 fd, dir 0o700)。导出 logger/child(bindings)/info/warn/error/debug/newTraceId/flushSync/LOG_DIR。pino.destination sync:false+append。level 由 PANEL_LOG_LEVEL 或 NODE_ENV 决定。 (85行)
- `metrics/pricing.js` — adapter/model→USD per 1M tokens 估价表(硬编码 TABLE, 含 claude/codex/gemini/minimax/ollama=0/ccr 等)。导出 estimateCost(adapterId,model,tokensIn,tokensOut)→6位小数美元 与 listPricing()。custom:* adapter 走 CUSTOM_DEFAULT;未知 adapter 返 0;ollama 本地推理 in/out=0。 (93行)
- `metrics/MetricsStore.js` — 核心指标层。append-only jsonl 按月切(metrics-YYYY-MM.jsonl, 50MB 滚动改名 .<ts>), 内存 cache 最近 2000 条。record(turnSummary) 富化+落盘+推 WS metrics_update+写 audit(activityLog)+喂 budgetStore/agentRuns。查询视图: query/aggregate(hour|day桶)/byRoom/byAdapter/overview。启动期 chmod 全部 metrics-*.jsonl 到 0o600。导出 class + singleton metricsStore。 (402行)
- `archive/ArchiveStore.js` — 聊天归档(原样导出)。配置 ~/.noe-panel/archive-config.json(原子写+损坏备份)。archiveRoom(room) 按 structure(time-then-room 等) 算目录, 写 final-consensus.md + full-transcript.md + meta.json(沙箱 isPathSafe 限 home/tmp/Volumes 且排 .ssh/.aws/Keychains 等)。_renderTranscriptMd 按 mode(chat/debate/arena/squad) 渲染。listArchives 递归扫 meta.json(深度≤4,≤500项)。导出 class + singleton archiveStore + 校验白名单常量。 (359行)
- `report/RoomReporter.js` — AI 浓缩报告(区别于原样归档)。generateReport({room,adapter,model,outputPath}) 拍平 room→按 mode 选 SUMMARY_PROMPT(debate6节/arena5节/squad6节/chat5节)→调 adapter.chat(8min 超时+AbortController)。三段降级: 单次→上下文窗口报错重试缩内容→map-reduce 分块摘要(≤18块)。跑 assertion(min_length/防 refusal)非阻断标 warning。写盘沙箱+目录则用 defaultReportPath。导出 generateReport/defaultReportPath。 (621行)
- `report/ReportJobStore.js` — 报告异步任务的内存态登记簿(纯内存 Map, 不落盘)。create/update/get/cleanup。TTL 1h、最多 50 job(超额按 createdAtMs 淘汰最旧)。status: queued→done/error(终态自动盖 finishedAt)。publicJob 剥离内部 createdAtMs。导出 class ReportJobStore。 (66行)
- `telemetry/Analytics.js` — PostHog 兼容产品分析(轻量自实现, 不依赖 posthog-js)。默认关(需 telemetry.json 填 analyticsHost+analyticsKey)。capture(event,props) 入队(只发 event 名+维度, 不发用户内容), 30s 或 50 条 flush 到 {host}/batch/。distinctId = sha256(hostname|platform|release) 匿名。beforeExit flush。导出 capture/isAnalyticsEnabled/flushOnExit。 (107行)
- `telemetry/ErrorReporter.js` — Sentry 兼容崩溃上报(无 npm 依赖, fetch 直连 Store API)。默认关(需 telemetry.json 填 dsn)。captureException 同指纹 5min 限流(Map 超 500 清过期)、sanitize mask(/Users/x→~、sk-key、token/secret/password)、fetch 5s 超时。server.js 在 uncaughtException/unhandledRejection 里调它。导出 loadConfig/acceptTelemetry/declineTelemetry/isEnabled/captureException。 (170行)
- `workspace/WorkspaceManager.js` — 多 workspace 隔离。~/.noe-panel/workspaces/{name}/(default 仍直落 ~/.noe-panel 兼容旧版)。名校验 /^[a-zA-Z0-9_-]{1,32}$/。导出 listWorkspaces/getActive/setActive/createWorkspace/deleteWorkspace/getWorkspaceDir/getDbPath(返 panel.db 路径)。被 server/routes/workspaces.js 路由调用。dir 0o700、active-workspace.txt/meta 0o600。 (104行)
- `workspace/NoeSafeDelete.js` — 撑红线6: 删文件走 macOS 废纸篓而非物理删。planSafeDelete(纯函数, 不碰 FS): ~展开+path.resolve 归一+红线判定(拒系统前缀 /System.../private/tmp 等、深度<2、home 根、/Users/<user> 根、受保护个人目录 Desktop/.ssh 等; 拒 \0)。macTrash 走 osascript Finder delete(保留 Put Back)。createSafeDeleter 注入式 trasher(测试注 fake)。被 NoeFreedomAdapters/SafeActExecutors 调。 (145行)

### 前端面板与顶层入口（public/src/web 的 88 个前端模块 + public/app.js IIFE 壳 + public/main.js ESM 桥 + server.js Express 入口 + electron-main.js Electron 主进程）。这是 Neo 贾维斯整个浏览器 UI 层与进程入口层。  (读 92/92)
- `../../app.js` — 前端 IIFE 总壳：owner-token 自举(从 ?t= 读入存 session/localStorage 后清 URL)、全局 fetch 劫持给同源 /api+/v1 注入 X-Panel-Owner-Token、modal portal 逃逸+ARIA 补全、核心 const state、api()/wsUrl()、confirmModal/promptModal/toast 的降级 wrapper、PanelCore 总桥(几十个 getter/懒转发把 app.js 顶层符号暴露给各模块)、/ws/global 全局长连+pub/sub、全局 error/unhandledrejection 兜底、ownerTokenMissingBanner (731行)
- `../../main.js` — ES module 主入口桥：按严格 import 顺序加载 ~70 个 src/web/*.js（注释里写满 boot 时序契约），把 utils/state/dialog/cmdk/inspector/ws-helpers/i18n/onboarding 的导出挂到 window.PanelUtils/PanelStore/PanelDialog/PanelCmdk/PanelInspector/PanelWs/PanelI18n/PanelOnboarding，启动时跑 initInspector/initI18n/askTelemetry/startOnboarding/Store.restore+flushPendingMirrors (156行)
- `../../server.js` — 后端 Express 入口(3024 行)：load-env→undici 代理→NOE 自主档默认开关注入→几百个路由模块 register*(app,...)→express.json/origin 白名单/安全 header+CSP/static(public)/app 级 owner-token 守卫(白名单豁免 version/hooks/支付/社交回调/v1 models)→server.on('upgrade') 按 /ws/global、/ws/room/:id、/ws/term/:id、/ws/:sessionId 分发(全部 ?token= 校验)→listen(127.0.0.1:51835) 打印带 token 入口 URL+TTY 自动 open+健康巡检 (3024行)
- `../../electron-main.js` — Electron 主进程：resolveServerNode 强制选 Node22→spawn server.js 并监督自动重启→BrowserWindow 加载 panelUrl(带 owner-token+electron=1)→失败显示 failurePage→可选 spawn ~/.noe-voice 的 whisper STT 子进程→electron-updater 自动更新→媒体权限 handler(放行麦克风)→菜单(重载/重启本地服务/检查更新)→smoke 测试钩子 (378行)
- `utils.js` — 零依赖叶子 helper：escapeHtml/escapeHtmlEarly/escapeHtmlMl/safeSlice/shortenPath/formatSize/formatElapsed，被 PanelUtils 桥暴露 (54行)
- `state.js` — 统一 store(PanelStore)：单 root + 点路径 get/set + subscribe + persist/restore(localStorage cp-panel-store-v1) + flushPendingMirrors(消化 app.js 在桥就绪前积压的镜像写)；当前与 app.js 顶层 const state 并存的双 SSOT 渐进迁移态 (120行)
- `dialog.js` — confirmModal/promptModal 主实现(PanelDialog)，Promise 化替代原生 confirm/prompt，含 IME/danger 键盘处理 (95行)
- `ws-helpers.js` — WS 通用件(PanelWs)：buildWsUrl/backoffDelay 指数退避/createWsDispatcher type→handler/createReconnectingWs 自动重连封装 (100行)
- `i18n.js` — 轻量 i18n(PanelI18n)：fetch /locales/{zh,en}.json + t(点路径,{{var}}) + detectLocale + subscribe (60行)
- `budget-utils.js` — 预算/格式化纯函数 IIFE(window.BudgetUtils)：rangeToFromIso/fmtUSD/fmtBigInt/fmtMs/fmtBudgetMetric/budgetScopeLabel (43行)
- `cmdk-commands.js` — ⌘K 命令面板静态命令注册表 BUILTIN_COMMANDS + matchCommands/resolveAction(actionRef 字符串→dispatcher) (39行)
- `cmdk-ui.js` — ⌘K 命令面板运行时(PanelCmdk 合并挂载)：openCmdk/closeCmdk/buildCmdkItems/renderCmdk，actionRef 派发到 PanelSessionsTools.openModal/PanelTheme.toggleTheme/#btnHandoff/#btnExternal；boot 绑全局 ⌘K/⌘D (174行)
- `inspector.js` — 右侧 inspector 控件(PanelInspector)：拖动 resize(持久化宽度)/折叠 toggle/空态自动折叠(MutationObserver)/debate-state log clear (139行)
- `rooms-core-ui.js` — 多 AI 聊天室核心(PanelRoomsCore)：roomState/loadRooms/selectRoom/attachRoomWS(/ws/room/:id)/MODEL_OPTIONS/状态纯函数/lineage；对接 /api/rooms CRUD；时序契约头(须先于 autopilot/agent-graph boot) (487行)
- `rooms-members-ui.js` — 房间成员/技能绑定/providers 缓存/elapsed 计时器/状态 chip(PanelRoomsMembers)；对接 /api/room-adapters/providers /api/skills /api/agent-registry /api/rooms/:id PATCH (389行)
- `rooms-chat-ui.js` — Chat 房 1v1 渲染/发送(PanelRoomsChat)：renderChatRoom/buildChatMessageEl/sendChatMessage/abortChat；对接 /api/rooms/:id/chat、/abort；媒体走 PanelRoomsChatMedia (109行)
- `rooms-chat-media-ui.js` — Chat 房媒体附件(PanelRoomsChatMedia)：草稿托盘/上传(/api/rooms/:id/media)/渲染/任务上下文注入，图片视频 MIME 白名单 (264行)
- `rooms-actions-ui.js` — 房间操作群+房间域全部顶层 DOM 绑定(PanelRoomsActions)：startDebate/abortDebate/deleteRoom/pullRoomAndRender/delegateActiveRoom/addRoomRequirement+forward 转发+拖放粘贴；对接 /api/rooms/* /api/delegations /api/archive/rooms/* (460行)
- `rooms-events-ui.js` — 房间 WS 事件总分发 handleRoomEvent(PanelRoomsEvents)：按 debate/squad/arena/cross_verify/chat/cluster mode 切 6 子函数 dispatch，协作 mode 委托 PanelRoomsEventsCollab (334行)
- `rooms-events-collab-ui.js` — 房间 WS 事件协作域子分发(PanelRoomsEventsCollab)：handleSquadEvent/handleCrossVerifyEvent/handleClusterEvent (280行)
- `rooms-debate-ui.js` — 辩论渲染+轮次卡(PanelRoomsDebate)：renderRoomDebate/ROUND_TITLES/renderRounds/renderTurnCard/retryTurn(/api/rooms/:id/...)+全局 Esc 结束辩论 (281行)
- `rooms-squad-ui.js` — Squad 看板+任务详情抽屉(PanelRoomsSquad)：renderSquadKanban/retrySquadTask/openSquadDetail；对接 /api/rooms/:id 任务操作 (213行)
- `rooms-cluster-live-ui.js` — cluster runtime 实时渲染群(PanelRoomsClusterLive)：cross_verify 阶段徽章/心跳/自愈/续跑策略/成员输出行/共识 Markdown；e2e 经 __noeClusterTest 钩子 (334行)
- `rooms-cluster-tools-ui.js` — cluster 工具/formatter/操作群(PanelRoomsClusterTools)：预检/并发预算/诊断/自愈/交付包归档；对接 /api/cluster/concurrency-budget /diagnostics /repair (488行)
- `room-templates-ui.js` — 房间模板 modal(PanelRoomTemplates)：列表/选择/createRoomFromTemplate/deleteRoomTemplate；对接 /api/room-templates /api/rooms (216行)
- `room-adapter-ui.js` — 房间模型 adapter 配置 UI(PanelRoomAdapter)：对接 /api/room-adapters 读写、/api/rooms/:id (201行)
- `sessions-core-ui.js` — 会话 CRUD+全局右键菜单+双击重命名(PanelSessionsCore)：listSessions/createSession/deleteSession/setSessionArchived/openContextMenu；对接 /api/sessions；boot 绑 document 级 click/keydown(Esc)+4s 轮询 (207行)
- `sessions-list-ui.js` — 会话列表渲染+归档区+聊天区切换+appendMessage(PanelSessionsList)：renderList/buildSessionItem/renderArchived/showEmpty/showChat；对接 /api/sessions/:id (263行)
- `sessions-stream-ui.js` — selectSession+会话 WS 总分发 attachSessionWS(/ws/:sid)+stderr/partial 流式渲染+状态/成本 chip+danger/loopGuard/focusChain banner(PanelSessionsStream) (386行)
- `sessions-tools-ui.js` — busy/中断/send 发送+Snapshot/Handoff/ctx 仪表+接力/外开/批量开+新建弹窗+消息右键(收藏/分叉⭐)+ctx 警告条(PanelSessionsTools)；对接 /api/sessions/* /api/spawn-batch /api/files (445行)
- `watcher-ui.js` — Watcher 监视者 UI(PanelWatcher)：showWatcherVerdict/loadWatcherProviders+接受/拒绝/dismiss 绑定；对接 /api/watcher/providers /api/sessions/:id (175行)
- `overview-ui.js` — 📊 总览面板(PanelOverview)：metrics/timeseries/by-adapter/health/budgets/governance summary 拉取+渲染+cleanOldMetrics；subscribe PanelGlobalWs 接 metrics_update/health_warning (478行)
- `agent-graph-ui.js` — 智能体图谱壳(PanelAgentGraph)：agentRegistryState 单一属主+modal 壳/tab 路由+saveAgentPolicy/resetAgentPolicy；对接 /api/agent-registry；五子模块挂各自命名空间 (331行)
- `agent-graph-models-ui.js` — 智能体图谱 Models/Skills Center+Profiles 卡片/策略编辑器(PanelAgentGraphModels) (390行)
- `agent-graph-runs-view-ui.js` — 智能体图谱 Runs tab 渲染+run 数据装载(PanelAgentGraphRuns)；对接 /api/agent-runs (477行)
- `agent-graph-run-actions-ui.js` — 智能体图谱 Runs 事件绑定+run 生命周期动作(PanelAgentGraphRunActions)；对接 /api/agent-runs/:id 各操作 (493行)
- `agent-graph-dispatch-ui.js` — 智能体图谱 Dispatch Preview 流(PanelAgentGraphDispatch)：classify/idea/changed-files/codebase-map；对接 /api/agent-runs/idea /api/agent-registry/classify (386行)
- `agent-graph-evidence-ui.js` — 智能体图谱 分类/代码证据渲染+证据归档动作(PanelAgentGraphEvidence)；对接 /api/agent-runs/session/:id、/api/agent-runs/:id (411行)
- `governance-ui.js` — P0 治理中心(PanelGovernance)：queue/summary 渲染+审批/委派跳转+预算事件；对接 /api/governance/summary /queue /api/approvals /api/agent-runs (416行)
- `governance-review-ui.js` — 治理中心 Preflight/Resume Review 子域(PanelGovernanceReview)：staged diff 文件元数据/风险原因/覆盖解释渲染 (239行)
- `mcp-ui.js` — 🔌 MCP 服务器中心(PanelMcp)：servers CRUD+call-history；对接 /api/mcp/servers /api/mcp/call-history (332行)
- `webhook-ui.js` — 🔔 Webhook 出站推送(PanelWebhook)：列表/编辑/测试/删除；对接 /api/webhooks (213行)
- `autopilot-ui.js` — Autopilot 自动驾驶(PanelAutopilot)：config/log/rules/toggle/dry-run；对接 /api/autopilot/* (266行)
- `archive-ui.js` — 聊天归档配置区(PanelArchive)：config 读写+list+retry；对接 /api/archive/config /list /rooms/:id (181行)
- `approvals-ui.js` — 本地审批中心(PanelApprovals)：openApprovalModal+审批列表/批准拒绝；对接 /api/approvals (193行)
- `delegation-ui.js` — 委派中心(PanelDelegation)：openDelegationModal+委派列表/操作；对接 /api/delegations (256行)
- `knowledge-ui.js` — 知识库证据 FTS 检索(PanelKnowledge)：stats/search/reindex；对接 /api/knowledge/evidence/* (206行)
- `timeline-ui.js` — 📈 时间线(PanelTimeline)：按房间 metrics 时间线渲染；对接 /api/metrics/by-room (141行)
- `plugin-ui.js` — Plugin 中心(PanelPlugin)：列表/详情/runPluginCommand/installPluginFromFile/reload；对接 /api/plugins/* (211行)
- `codebase-center-ui.js` — Codebase Center 本地代码索引(PanelCodebase)：status/rebuild/query/question+Dispatch Preview 证据注入；对接 /api/codebase-index/* (381行)
- `safety-ui.js` — 安全历史 tab(PanelSafety)：watcher 区+hook 事件区渲染+config/test；对接 /api/watcher/config /test /api/hooks /api/sessions/:id /api/docs/HOOKS_USAGE.md (288行)
- `search-ui.js` — 跨 session 搜索(⌘⇧F)+跨房搜索(⌘⇧R)+⌘? cheatsheet+统一快捷键(PanelSearch)；对接 /api/search /api/rooms/search (276行)
- `prompts-notify-ui.js` — Prompts 模板库(⌘P)+F3 浏览器通知(长任务完成)+turn_end 通知轮询(PanelPromptsNotify)；对接 /api/prompts；用 Notification API (143行)
- `summary-report-ui.js` — 生成总结报告 modal(PanelReport)：subscribe PanelGlobalWs 接报告进度；对接 /api/reports/* /api/rooms/:id (338行)
- `activity-ui.js` — 本地结构化审计时间线 modal 壳(PanelActivity)：拉取+列表渲染；对接 /api/activity；详情/提取器懒解析 PanelActivityDetail (327行)
- `activity-detail-ui.js` — 审计时间线提取器层(17 纯函数)+详情面板渲染(PanelActivityDetail)：activityTitle/agentRunIds/artifacts/renderActivityDetail 等 (350行)
- `theme-statusbar-ui.js` — 主题切换+Claude 登录按钮+StatusBar+启动版本号(PanelTheme)：applyTheme/toggleTheme/updateStatusBar；对接 /api/login-claude /api/version (103行)
- `term-ui.js` — 内嵌真终端 PTY+xterm.js(PanelTerm)：openTerm/closeTerm，CDN window.Terminal/FitAddon+createPlainTerminal 降级；对接 /api/term、/ws/term/:id (180行)
- `composer-ui.js` — composer 输入增强(PanelComposer)：textarea 自适应增高+划词浮层+topic 附件上传(选/拖/粘)+展开收起+字数统计 (274行)
- `overlays-ui.js` — 全局 overlay 管理(PanelOverlays)：closeTopOverlay(Esc 逐层关)+a11y focus-trap+modal-bg 点关+欢迎页 [data-cta] 入口 (163行)
- `approval-flow-ui.js` — P2 权限治理审批后重试基础设施(PanelApprovalFlow)：apiCall/requestWithApproval/handleApprovalFlow/openApprovalRetryModal；对接 /api/approvals/:id (186行)
- `markdown-ui.js` — markdown 渲染(PanelMarkdown)：marked v13+DOMPurify(ALLOWED_TAGS/ATTR 白名单+afterSanitizeAttributes 强制 rel/target+限协议)，CDN 失败降级手写 regex+先 escapeHtml；代码块复制/折叠委托；外链图片走 /api/img-cache 本地缓存 (225行)
- `brain-ui.js` — 主面板 Noe brain lite 全屏区(无 window 导出，直接绑 #btnNoeBrain)：showBrain 隐藏其他区+health/acts/focus/memory/tools/approvals/loop 控制+本地 thoughtItems 流；对接 /api/noe/* (health/acts/focus/memory/tools/approvals/loop/start|stop|tick) (332行)
- `license-ui.js` — License+Workspace 顶栏徽章(PanelLicense/PanelWorkspace)：activate/status+工作区切换；对接 /api/license/* /api/workspaces* (178行)
- `onboarding.js` — 新手 walkthrough(自实现轻量版)+telemetry 同意弹窗(PanelOnboarding)：startOnboarding/resetOnboarding/askTelemetry；对接 /api/telemetry/accept|decline /api/analytics/config (266行)
- `plain-terminal.js` — xterm.js CDN 未加载时的纯文本终端降级实现(window.createPlainTerminal)，被 term-ui 兜底调用；index.html 直接 script 加载 (68行)
- `cognitive-research.js` — cognitive.html 页面顶层控制器(module 入口，import 所有 cognitive-* 兄弟+identity-bridge+ui-signals)：聊天/事件流渲染 msg/stream+Wiki/搜索/深度研究(SSE 流)按钮+装配身份桥/owner gate/barge 阈值 UI；对接 /api/noe/do /api/noe/research/deep (249行)
- `cognitive-attachments.js` — cognitive 页视觉附件(图片上传/glance)：对接 /api/noe/vision/attachment；监听 cognitive 自定义事件 (379行)
- `cognitive-profiles.js` — cognitive 页对话人格/模型选择：对接 /api/noe/chat/profiles /api/noe/chat/models (220行)
- `cognitive-people.js` — cognitive 页人物库(增删改+人脸/声纹识别)：对接 /api/noe/people/* /api/noe/identity/* (396行)
- `cognitive-people-capture.js` — 人物库采集/识别无状态部分(自 cognitive-people 拆出，不持有状态)：对接 /api/noe/people/face-embedding (135行)
- `cognitive-vad-settings.js` — cognitive 页 VAD 阈值(起说/停说/打断线)校准 UI，localStorage 持久化，用 AudioContext 实时电平校准 (112行)
- `cognitive-evidence-status.js` — cognitive 页证据/状态条：vision 模式/glance/attachment+memory/acts；对接 /api/noe/vision/* /api/noe/memory /api/noe/acts (259行)
- `cognitive-local-council.js` — cognitive 页本地议会(多本地模型投票)：discover 本地模型+run council；对接 /api/noe/local-models/discover /api/noe/local-council/run (208行)
- `cognitive-command-surface.js` — cognitive 页命令面板:discover/执行 Noe 命令；对接 /api/noe/commands/discover /api/noe/commands/:id (174行)
- `cognitive-taskflow.js` — cognitive 页任务流 UI：列表+创建；对接 /api/noe/taskflows (158行)
- `cognitive-acui-lite.js` — cognitive 页 ACUI 卡片轻量渲染：对接 /api/noe/acui/cards (93行)
- `cognitive-action-drawer.js` — cognitive 页动作抽屉:管理 9 个动作按钮(Vision/Live/VoiceLive/CommandSurface/TaskFlow/AcuiCards/LocalWiki/WebSearch/DeepResearch)的紧凑工具栏 install (106行)
- `cognitive-identity-bridge.js` — 身份/人脸声纹桥+主人门禁抽屉(window.cog* 身份 API 单一属主)：installIdentityFetchBridge(monkey-patch fetch 唯一属主)/owner-gate/voice|face enroll|config|clear；对接 /api/noe/identity/* /api/noe/people/face-embedding /api/noe/owner-gate (314行)
- `noe-voice.js` — Noe 语音/视觉/主动陪伴 IIFE(index.html+cognitive.html 都加载)：getUserMedia→16kHz wav→/api/noe/voice/chat+VAD 实时对话(免按钮+barge-in 打断)+唤醒词门控+流式续播+看屏 /api/noe/vision/glance|frame|ambient+主动陪伴轮询 /api/noe/proactive/tick (507行)
- `noe-ui-signals.js` — UI 信号上报(模块)：noeUiSignalToken/buildNoeUiSignalPayload/describeNoeUiElement/postNoeUiSignal+installNoeUiSignalLifecycle(把用户 UI 交互上报后端)；对接 /api/noe/ui-signals (113行)
- `noe-proposals-ui.js` — Noe 提案收件箱(模块，main.js 加载)：proposals/memory-candidates 拉取/审批/批量复核；对接 /api/noe/proposals /api/noe/memory-candidates/* (450行)
- `noe-freedom-request.js` — 开发者自由请求构造(纯函数)：DEFAULT_TOOL_ID/buildFreedomRequestBody/defaultFreedomArgs/parseFreedomArgsJson (88行)
- `noe-freedom-followups.js` — 自由工具后续动作(纯函数)：extractFreedomNextActions/applyFreedomNextAction(Chain)/renderFreedomNextActions/renderOwnerAuthorizedAccountTargets (119行)
- `noe-freedom-stage-summary.js` — 自由工具阶段摘要渲染(纯函数)：renderFreedomStageSummary (129行)
- `noe-freedom-ui-utils.js` — 自由工具 UI 叶子工具：escapeHtml/redactFreedomUiValue(脱敏显示) (36行)
- `noe-freedom-tools.js` — 开发者自由工具 UI 主控(main.js 加载，import 上述 4 个 freedom 子模块+ui-signals)：quickStarts 渲染+请求发起+next-action 链+阶段摘要 (421行)
- `noe-work-map-ui.js` — 内心透视页(mind.html，被 mind.js 动态 import)工作地图渲染：对接 /api/noe/work-map (181行)
- `noe-world-social-actions.js` — mind 页社交动作渲染纯函数(被 mind.js import) (147行)
- `noe-world-earth.js` — mind 页 Three.js 3D 地球可视化(改自 hotspot-earth 组件，被 mind.js 动态 import)：本地 vendor/three+地球/月球/深空贴图+轨道节点信标+按状态着色(ok/warn/bad/locked/idle)，呈现 Noe 的 live world (1229行)

### 设计意图·愿景·当前阶段·路线图·已知问题(顶层纲领 md + docs 最新交接的深读)。Neo/Noe v2.1.0 = 本地优先多 AI 个人操作系统(自对标 Jarvis)；工程目标是"可验证的功能性自我意识 + 自我改造 + 自治执行"，明确不把现象意识作声明/验收/依赖(DESIGN §0)。  (读 17/17)
- `../CONTEXT_FOR_AI.md` — 对外 AI 上下文摘要(v1.0,2026-06-14):项目身份/形态/17+核心机制清单/6-14 当日 30 commit 新增 7 项/真实验收数据表/8 个真实缺口/4 周路线图 A-D-R/DESIGN §0 哲学立场/6-13 ADR 12 决策/10 个可检索工件索引 (292行)
- `../ARCHITECTURE.md` — 长期活架构地图(2026-06-10 校订):进程拓扑(51835 生产/51998 隔离/51735 母项目)、src/ 13 个目录域职责表、语音链路主路径、~/.noe-panel/ 数据落点、关键 env 速查、质量门 (64行)
- `../README.md` — 项目门面:当前状态(CE12 P0 已验收→P1 产品化收敛)、概念消歧表、快速开始、语音/视觉/主动陪伴说明、打包成 .app、验证命令、已知限制 (139行)
- `../AGENTS.md` — 工程宪法(给接手 AI):当前硬边界(2026-06-12 覆盖旧授权)、多模型/子代理工作流入口(2026-06-19 Codex writer/Claude 审/M3 冷审)、10 条开发纪律宪法、cognition/loop 域真实工程状态硬记录(P0 认知开关默认开/P1 两个工程真实性缺口[已过期]/共识自进化闭环全套件清单) (138行)
- `../NOE_P2_EVALUATION.md` — P2 体验层可行性评估(2026-06-03):Voice/Social I/O/Tool marketplace 三项可行性+最小路径+需 owner 裁定输入+明确不做的红线 (45行)
- `../BUGS.md` — 冻结 bug 清单:B-01~B-06(5 Fixed/1 WontFix,v0.49 全清)+v0.49~v0.56 各 Sprint 审查发现与修复流水(N/V52/S3-S16 系列,含安全加固 N-21 反 tabnabbing 等) (320行)
- `../CHANGELOG.md` — 变更日志(Keep a Changelog):Unreleased(仍停在 CE12 P0 文档)/v2.1.0(2026-05-28,126 commit 累积,知识库/迁移框架/a11y/发布流水线+12 bug 修复含 3 发布阻断)/v2.0.0(SQLite 底座) (86行)
- `docs/HANDOFF_INDEX_2026-06-19_Neo_Multimodel_Shared_Memory.md` — 多模型共享记忆总索引(更新到 6-20):入口读序、Phase 0-6+证据飞轮 v2 阶段状态表、~30 个 Accepted Ledger 清单、6-20 证据飞轮快照(replay 基线 33/7/0 ok:false 刻意保留)、各 F1/F2 切片 purpose 与 caveat (200行)
- `docs/NOE_MULTIMODEL_OPERATING_PROTOCOL.md` — 多模型操作协议(2026-06-19):唯一可信事实源=文件化脱敏带时间戳证据、禁止保存清单、启动读序、角色表(Codex/Claude/M3/子代理)、Context Budget 4 层、Exhaustive Quality Mode 规则表(active-executor must approve / same-round visibility boundary / blocker zero)、Review Cadence、历史经验教训 (281行)
- `docs/HANDOFF_2026-06-20_Neo_第三阶段收口与阶段二全功能实机验证.md` — 6-20 收口交接:阶段一第三阶段 Reward Gate 收口(共识 passed+ledger PASS+计划外修复 reward-hacking gate 真实绕过)、阶段二全功能实机验证(5538 测试全绿/621 功能清单/89.9% 单测覆盖/裁决=可用)、P1 单测盲区 24 模块+P2 边界 3 缺陷 backlog、工作区脏状态归属 (44行)
- `docs/HANDOFF_2026-06-20_Neo_final_real_machine_closeout.md` — 6-20 final 实机收口:review brain/小红书发布删除/51835 重启恢复/全功能验证收口成可审计结论;已完成项(实机发布删除证据/重启 pidChanged/全套 verify PASS 含 100-readiness score=100 38/38)、Kierkegaard 子代理失联记 no_response、必须保留 caveat 清单(409 公开 URL 未验证/voice 真耳未确认) (136行)
- `docs/GOAL_2026-06-20_Neo_Evidence_Flywheel_V2.md` — 当前主目标文件:把旧大目标收敛为证据飞轮 v2(可度量/可回放/可审计/可回滚);成功标准+阶段 A(冻结基线)/B(30-50 真实 replay eval)/C(NeoEvalCase/Run/Score 稳定化)/D(只读 runtime trace)/E(统一 candidate gate)+严格约束(不碰 51735/不读 raw secret/不新增 live 社交发布) (213行)
- `docs/HANDOFF_2026-06-20_Neo_Evidence_Flywheel_V2_第三阶段RewardGate.md` — 第三阶段 Reward Gate 交接:anti-reward-hacking gate 收口步骤;已完成(三切片新增 NeoEvalRewardHackingGate/AcceptanceGate+多轮按 Lorentz/Faraday 反馈修补阻断泛化正向词)、当前卡点(收口证据未全刷新、hash 可能是上轮)、旧共识 stale 不可复用、子代理角色定义、下一步 8 步 (173行)
- `docs/语音真耳验收_2026-06-20.md` — 语音真耳验收记录:自动脚本结论(longReply 10/10、bracketText 5/5、wakeFalsePositive 10/10 全 PASS,needsOwnerEarReview=true)+三张明细表+ owner 现场复核 checklist(全待勾) (66行)
- `docs/PLAN_2026-06-19_Hermes_OpenClaw_自进化蒸馏总路线.md` — Hermes/OpenClaw 蒸馏总路线:三仓基线表(Neo/Hermes/OpenClaw HEAD+MIT)、多模型门禁规则、Neo 当前能力基线表(9 领域源码+缺口)、Hermes→Neo 能力差距表(13 项 P0/P1/P2 带源码行号)、OpenClaw 可蒸馏/不吸收清单+per-topic 证据 (240行)
- `cognition/NoeIntegrationSampler.js` — (源码核实验证)IntegrationMetric 生产采样器::67 调 integrationMetric(win);server.js:2319 createIntegrationSampler+:2349 sample()+integrationHistory.record() 已接入心跳 job—证 CONTEXT_FOR_AI 缺口1 与 AGENTS P1 缺口1 已被消解 (90行)
- `cognition/NoeAffectHealth.js` — (源码核实验证)情感健康自检模块:文件确实存在(推翻 AGENTS.md '根本不存在' 旧断言),但 server.js grep AffectHealth 0 命中=模块存在却未在 server 接线,属未接入生产的能力 (92行)
---

## 附录 · runtime 引擎前半(1/2 片,39 文件 · 补跑并入)

> 此域首跑因瞬时 403 限流失败,单独补跑读全 39/39 文件。

### 逐文件清单
- `runtime/_protectedPathGuard.js` — 危险命令「删受保护路径」单一来源纯函数(系统目录+~/.codex/~/.agents/~/.noe-panel) (50)
- `runtime/mission/NoeEvidenceReconciler.js` — 云任务产物校验:证据 ref 可读性+claim-vs-evidence 对账 (68)
- `runtime/mission/NoeMissionCriteriaEngine.js` — mission 完成判据引擎,9 种 criterion 类型逐条求值 (187)
- `runtime/mission/NoeMissionLongSoak.js` — P8 长泡(7h)只读 mission 契约工厂+executor (220)
- `runtime/mission/NoeMissionReconciler.js` — mission 收尾对账:证据可读/done 必带证据/产 coverage 表 (115)
- `runtime/mission/NoeMissionRunner.js` — mission 执行核心:租约+心跳、逐 action、review gate、三类守卫、双绿才 succeeded (564)
- `runtime/mission/NoePatchApplyChainDrill.js` — patch apply/rollback 链演练(dry-run→拦截→应用→回滚) (151)
- `runtime/mission/NoePatchTransaction.js` — patch 事务:parse→precondition(沙箱+secret阻断)→apply(备份)→rollback (111)
- `runtime/NoeAccountConnectionInventory.js` — 社交账号连接盘点(从浏览器态推断已登录;不读cookie/不外发) (476)
- `runtime/NoeActiveJobGuard.js` — 活跃任务并发去重守卫(jobKey→唯一 Symbol token) (149)
- `runtime/NoeBackgroundReview.js` — 后台复盘审阅(proposal-only,写 output/,绝不直接落库) (271)
- `runtime/NoeBaiLongmaFusionPlanner.js` — 只读上游审计+融合计划(不读secret/不启连接器) (440)
- `runtime/NoeCommitmentExtractor.js` — T7 自我承诺抽取(正则抽「我会X」喂 CommitmentStore) (76)
- `runtime/NoeCompanionToolPreflight.js` — 伴随工具只读自检(版本/PATH;全标 requiresOwnerApproval) (419)
- `runtime/NoeDelegationExtractor.js` — 对话委托桥(识别 owner 交办语→立目标带 research/act 步) (209)
- `runtime/NoeFinal51835RestartEvidence.js` — Stage E 51835 重启恢复证据构建+敏感键扫描 (248)
- `runtime/NoeFreedomAdapters.js` — freedom 适配器总表(33 operation:shell/ssh/keychain/browser/applescript/social/delete/upload/marketplace),dryRun+execute 双形态;runNoeFreedomAdapter 分发 (2146)
- `runtime/NoeFreedomReadinessAudit.js` — 开发者就绪盘点(账号/SSH/密钥健康/线上模型;只报布尔不读值) (345)
- `runtime/NoeFreedomRunLedger.js` — freedom 执行台账(sha256 完整性/续跑;输出强制 output/noe-freedom-runs/) (346)
- `runtime/NoeGatewayProtocol.js` — 网关帧协议;副作用 request 强制 idempotencyKey+payload 脱敏 (181)
- `runtime/NoeLaneQueue.js` — 泳道并发队列(lane 互斥+优先级抢占) (145)
- `runtime/NoeLlmJsonExtractor.js` — 本地模型回复稳健 JSON 抽取(剥 <think>/markdown 围栏;失败落 null 不兜造) (121)
- `runtime/NoeObservationStatusReportback.js` — 观察门状态回报同步(signature 去重) (123)
- `runtime/NoePanelRuntimePreflight.js` — 面板(51835)安全重启 preflight(lsof 抓 PID/cwd;51735 仅观察;只读) (239)
- `runtime/NoeProcessVitals.js` — 进程死前留痕(每分钟心跳+exit 遗言,下次启动分析上次死法) (87)
- `runtime/NoeProposalExecutor.js` — proposal 物化(仅 approved 的 9 类追加候选 jsonl,不直接改代码/记忆) (154)
- `runtime/NoeQqBridgeResearchGate.js` — QQ 桥研究门(凭证就绪布尔+dry-run;live 登录前强制阻断) (248)
- `runtime/NoeSocialDomRecipe.js` — 各平台创作页 DOM 配方(标题/正文/标签/发布按钮 hints) (341)
- `runtime/NoeSocialFinalPublishRollback.js` — 终发布后 rollback 证据(URL/title 探针;URL 脱敏) (97)
- `runtime/NoeSocialFormFillPlan.js` — 社交表单填充计划(浏览器内 JS setText+echo 校验;不点发布) (319)
- `runtime/NoeSocialMediaUploadPlan.js` — 媒体上传计划(探 file input;只探不点) (276)
- `runtime/NoeSocialPublishPreflight.js` — 发布前飞检(媒体沙箱/草稿/host 匹配;finalPublishAllowedByThisTool=false) (275)
- `runtime/NoeSocialPublishWorkflow.js` — 社交发布工作流准备(平台预设+6 步骤;realExecute 才写草稿) (270)
- `runtime/NoeSocialTurnGuard.js` — 社交入站轮次准入(重放抑制+自回声丢弃+bot 互刷环抑制) (336)
- `runtime/NoeSshInventory.js` — SSH config 只读盘点(identityFile 仅返 basename;不读私钥) (123)
- `runtime/NoeStructuredCall.js` — rank7 结构化调用(json_schema→json_object→text 三档降级+zod+re-ask) (84)
- `runtime/NoeTaskReportbackSpeechWorker.js` — 任务回报语音(MiniMax→CosyVoice→say 三级兜底+afplay) (159)
- `runtime/NoeUiSignalStore.js` — UI 信号存储(record/peek 非消费/consume 议会消费;防聊天饿死议会) (115)
- `runtime/NoeWorkMapReportbacks.js` — 工作图回报汇总(按 taskId 取最新+超时标 stale) (155)

### 核心机制
runtime = Neo 自治执行底盘,三主线:
1. **Mission 状态机**(mission/):NoeMissionRunner 引擎,租约+心跳防多 runner 争抢,按 plan cursor 逐 action,review gate + 三类守卫(无证据/重复错≥3/截断),双绿(CriteriaEngine AND Reconciler)才 succeeded,否则 blocked。证据驱动完成贯穿(done 必带 evidence ref,治"口头宣布成功就停手")。
2. **Freedom 能力执行链**(NoeFreedomAdapters 2146 行):33 个 noe.freedom.* operation,每个 dryRun/execute 双形态;runNoeFreedomAdapter 唯一分发口,realExecute=false 纯规划、true 才真 spawn osascript/ssh/open/fetch。覆盖 shell/ssh/keychain/浏览器 DOM(页内 JS 包进 JXA)/AppleScript/社交发布全链/文件删除(走回收站)/上传/工具市场。
3. **感知→承诺→回报对话桥**:DelegationExtractor(owner 交办→目标)+CommitmentExtractor(自我承诺→store)→任务;SpeechWorker/WorkMapReportbacks/ObservationStatusReportback→语音/卡片回报。NoeLaneQueue+NoeActiveJobGuard 是调度原语。

### 风险补充(强化正文 P0-①)
1. **【高】前缀越界 bug 又两处**:NoeMissionCriteriaEngine.js:23 + NoeMissionReconciler.js:18 的 safeResolve 同样 `file.startsWith(root)` 缺尾 sep。连同正文 P0-① 的 NoeMissionStore.js:271,**漏修共 3 处**;NoeEvidencePack.js:29 / NoeEvidenceReconciler.js:18 / NoePatchTransaction.js:177 已修对。后果:mission 判据/对账会把沙箱外兄弟同前缀路径当合法证据读取。
2. **【低】freedom 分发口本身无护栏**:runNoeFreedomAdapter(2141)裸 passthrough,shell/ssh/applescript execute 本层无命令审查,全靠上游 NoeFreedomExecutor:50 兜底——设计选择,但新调用方直接 import 绕过 executor 即无护栏(护栏位置耦合脆弱;owner 要最大自由,仅作正确性提示)。
3. **【低】其他**:SpeechWorker 临时 mp3 在 SIGKILL 时残留无启动清扫;FusionPlanner 同步递归读大仓全文算行数会阻塞事件循环;FreedomRunLedger walk 的 lstatSync 未裹 try/catch(并发删 ENOENT 冲垮列举)。

### 亮点
证据驱动完成门、dry-run/real 严格二态、并发原语扎实(Symbol token/泳道抢占/租约心跳)、死前留痕(ProcessVitals 补"无声死亡"盲区)、脱敏单一来源(_protectedPathGuard)+对外结构体带审计布尔。无 secret 外泄:upload 三重阻断(.env/.ssh/owner-token),keychain 只读元数据。
