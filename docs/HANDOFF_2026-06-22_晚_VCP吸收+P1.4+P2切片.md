# HANDOFF 2026-06-22 晚 — VCP 吸收 + ROADMAP P1.4 + P2 切片（本会话全自主交付）

> 接手先读本文件 + AGENTS.md。本会话从 VCP 研究开始，做到 ROADMAP P2 切片 A 核心。

## 本会话交付（13 commit，全量 6381 绿）
| commit | 内容 |
|---|---|
| 967f16c | VCP 研究报告(6 维度子代理) |
| 0a3b855 | H1 WS 心跳保活+死连接周期清扫(容灾) |
| 8ad3605 | H2 DB 启动自检+坏库自动回滚(容灾) |
| f822288 | H3 本地模型文本工具协议核心(解析+执行+回读编排) |
| 9c92407 | 多模型+子代理总审加固(Codex 找 6 真问题全修:H2 0字节失忆/sidecar、H3 脱敏/ledger、H1 clamp/去重) |
| a2b22bb | #72 Node/Python/Rust/SQLite/USearch 研究(SQLite 唯一真金) |
| 1759247 | SQLite-1 连接 PRAGMA(busy_timeout 等)+24h optimize |
| cff7a5f | P1.4 认知链路 E2E(证明 inner-state/persona 真进 prompt) |
| 7a2e9a3 | P2 切片B NoeRiskTiering 5维风险分级门 |
| 19b0d26 | P2 切片A 核心 NoeCandidatePool advisory frame |

## owner 关键决策（本会话拍板）
owner 选 advisory：owner 种子从 directive(立即执行)→候选池(Neo 自主打分采纳/拒绝记理由，可 override)。owner 权重最高(1.0)几乎总采纳(≈directive 体验)，低权重源 Neo 才拒。切片 A 核心已按此实现。

## 下一窗口接力（按优先级）
### 1. P2 切片 A 接入（分量动作·改 owner seed 核心路由）
- 接入点 src/server/routes/noeMind.js:743（owner seed POST /api/noe/mind/goals）：flag NOE_CANDIDATE_POOL=1 时改走 NoeCandidatePool.submit() 而非直接 goalSystem.add()；OFF 时逐字走现状 directive(零回归)。
- 需新建 noe_goal_candidates 表(SqliteStore 迁移)+ store 适配(insert/update/get/list)接进 createCandidatePool({store, promote: c=>goalSystem.add(...)})。
- 接 NoeRiskTiering：候选打分时叠加风险 tier，绿档可 Neo 自主练手(P3.2)。
- 加 PolicyFileGuard：NoeCandidatePool.js/NoeRiskTiering.js 加进 PROJECT_POLICY_FILES(防 Neo 自改自己的候选打分器/风险门)。
- owner kickstart：flag 默认 OFF；owner 设 .env NOE_CANDIDATE_POOL=1 才把 owner seed 真切 advisory(信任模型变更，方向已授权，生产点火留 owner 在场)。
- mind.html 加候选池视图(pending/accepted/rejected + reject_reason)。

### 2. P3 信任校准（依赖 1）
P3.1 首 5 次自改主线全审→次 20 次审 auto-flagged→后 100 次抽样；P3.2 Neo 自做 L0/L1 从候选池绿档取(NoeRiskTiering.isGreenTier)；P3.3 failure taxonomy 入 memory；P3.4 自改预算限速。

### 3. SQLite-2/3/4（#72 研究推荐，task #73）
- SQLite-2(high,改状态需 owner kickstart)：noe_ticks/noe_acts/agent_runs 保留期+VACUUM(panel.db 1.3GB→几百MB)，照 pruneEvents 加 <7 天下限护栏+flag 默认 OFF。落点 noe-maintenance.js。
- SQLite-3(med)：agent_runs JSON 生成列+索引，先 EXPLAIN QUERY PLAN。落点 AgentRunStore.js:2365。
- SQLite-4(low)：perf_hooks 事件循环健康诊断脚本。

### 4. H3 接入聊天链路（owner 在场实测）
orchestrateTextToolTurn 接 SoloChatDispatcher/VoiceSession 回复后处理，flag NOE_TEXT_TOOL_PROTOCOL 默认 OFF，本地模型 e2e 实测需 owner 在场。

## 关键文件
- 候选池 src/cognition/NoeCandidatePool.js(submit/decide/ownerOverride/list)
- 风险分级 src/security/NoeRiskTiering.js(tierRisk/isGreenTier)
- 文本工具协议 src/voice/NoeTextToolProtocol.js + NoeTextToolExecutor.js(orchestrateTextToolTurn)
- 容灾 src/server/services/ws-heartbeat.js、src/storage/NoeDbSelfCheck.js
- 研究报告 docs/研究_VCPToolBox对Neo可吸收点_2026-06-22.md、docs/研究_5项目对Neo可吸收价值_2026-06-22.md、docs/研究_P2引导机制现状与切片_2026-06-22.md

## 新增 .env flag（全默认 OFF 等 owner kickstart）
NOE_DB_AUTORECOVER(H2)、NOE_TEXT_TOOL_PROTOCOL(H3)、NOE_WS_HEARTBEAT_MS(H1，不设=30s always-on)、NOE_CANDIDATE_POOL(P2 切片A)、NOE_RISK_TIERING(P2 切片B)。SQLite-1 PRAGMA 是修配置已默认生效。

## 验收基线
全量 npm test = 6381 绿(755 files)。本会话新增测试：ws-heartbeat(15)+db-selfcheck(20)+text-tool-protocol(17)+text-tool-executor(18)+sqlite-pragma(1)+cognitive-chain-e2e(4)+risk-tiering(13)+candidate-pool(9)。

## ROADMAP 校准（重要）
ROADMAP_NEXT_2026-06-22.md 写于 P0 完成前，"complete=0 飞轮空转"已过时——实测 panel.db complete=1(secycle-fcd18547，Neo 首个真自改闭环)。P2/P3 现在是"P0 可持续化"下一环。

## 教训
本会话工具调用多次漏 antml: 前缀致 malformed，均逐一重发修正(13 commit 真实落地)，但浪费大量往返——前导散文后的工具调用尤其高发。
