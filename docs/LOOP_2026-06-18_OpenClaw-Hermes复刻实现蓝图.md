# LOOP 2026-06-18 — OpenClaw/Hermes 复刻实现蓝图

> owner /loop 今晚任务：读本机 OpenClaw/Hermes 源码 → 复刻**定时自动化学习** + **梦境自我对话** 成真有效功能；每任务多模型验证(codex GPT5.5 高推理+M3+Claude4.8)；**默认打火模式**(改完验证即点火生产+重启)。
> 本机源码：`/Users/hxx/Documents/Claw系audit_2026-06-09/{openclaw,hermes-agent}/`

## 0. 当前状态
- 召回度量诚实诊断被 codex+M3 高推理**纠正**：我夸大了"召回在工作"。真相=① 对话召回近 5 天断证(retrieval_log 55 条全是 6-13 合成探针,真实 chat/mission 召回审计=0) ② project/insight 语义召回近乎全废(探针 project 1/55、insight 0/55,坍缩到 fact 单通道) ③ 热点垄断(top8 占 92% hit) ④ 向量盲区实际只 7 条(hidden=0),非 207。
- **召回防垄断已修 `231a7c2`**：recallLike `MIN(hit_count,50)` 封顶 + 深思 recallFused `bumpHits:false` 止血。全量 5167 绿。
- 度量诚实 `affd173` 已提交(flag OFF)。

## 1. 打火状态（默认打火模式）
| flag | 状态 | 备注 |
|---|---|---|
| `NOE_MEMORY_USAGE_BUMP` | **可点火**（recallLike 已修，前置解除） | 点火让真注入对话的 selected 计 hit |
| `NOE_EXPECT_DECISIVE_FAIL` | 可点火（象征） | 步骤5,owner_pred verifiable=0 故不触发 |
| `NOE_MEMORY_SEMANTIC_BACKFILL_AUTO` | 待实现 | backfill 接心跳(7 条+根治离线写入无向量) |
| `NOE_DREAM_MODEL` | **=none 需改** | 梦境没插 LLM(见 P1) |

## 2. 实现蓝图（按优先级，每个=新文件<500行+DI+单测+flag默认OFF+隔离端口验证+多模型复盘+点火）

### P1 梦境插 LLM（af9215ca 核心发现：连大脑都没插电）— owner 要"梦境完善思考"
- 现状：`NOE_DREAM_MODEL=none` → `NoeDreamConsolidation` 只做确定性 DB 去重/降级/晋升，根本没用 LLM 做梦。`NoeDreamM3Hook.js` 有 LLM 语义去重但仍非"思考整合"。梦境/夜反思/InnerMonologue **各跑各的互不喂养**。
- 做：让梦境**消费 self-talk + 当日 episode → 用本地脑产连贯思考洞见**(不只 DB 清理)，写成下次能用的种子(现仅 noeFreshInsight 缓存1条)。
- 文件：`src/memory/NoeDreamConsolidation.js` + `NoeDreamM3Hook.js`；装配 `src/server/services/noe-maintenance.js:27-55`(每30min dreamLoop)。flag：`NOE_DREAM_MODEL` 设本地脑。

### P2 接三根神经（af9215ca：骨架全有，三根神经没接）
- (a) **自语→自进化**：`NoeSelfEvolutionTrigger.observe()` 全仓 0 调用 → selfEvolve 心跳每 5min 空转。把 InnerMonologue/深思产的"我该改进 X"信号接进 observe()。文件：`src/loop/InnerMonologue.js` / `NoeWorkspace.js` → `src/room/NoeSelfEvolutionTrigger.js`。
- (b) **复盘→定时+真写记忆**：`NoeBackgroundReviewRunner`(`src/runtime/NoeBackgroundReview.js`)只挂 per-turn hook,**没注册心跳 job**;proposal 永不 apply(`no_pending_candidate`)。接心跳 tick + 打通 proposal→memory-candidate→真 apply MemoryCore。

### P3 NoeCouncilDeliberation 多视角议会深思（a65a99e8）— owner 要"自我对话"
- Neo 缺口：深思/夜反思/梦境**全单轮单视角**。Hermes 真正可迁移点=MoA"多独立视角发散→批判聚合收敛"(arXiv:2406.04692)。
- 做：新建 `src/cognition/NoeCouncilDeliberation.js`(~300行)。3 persona(proponent/skeptic/pragmatist)各独立采样(温度 0.5/0.7/0.9 制造异质性,单轮守"本地模型多轮不可靠"纪律)+批判聚合(照 MoA AGGREGATOR"批判别复述")。**复用现成积木**:`NoeReasoningSearch`(beam 发散→收敛)+`NoeVerifiableReward`(打分选优)+`NoeReflectBrain`(本地脑)。**返回契约与 NoeDeliberation 完全一致**(Workspace `NoeWorkspace.js:622-669` 零改动)。直接 import `NoeDeliberation` 的 parsePrediction/parseShare/parseGoal。
- 装配 `server.js:1533` 开关分流(OFF 走老路零回归)。flag：`NOE_COUNCIL_DELIBERATION`+`NOE_COUNCIL_DEPTH`+`NOE_COUNCIL_PERSONAS`。聚合输出预测→进 NoeExpectationLedger→Brier 客观度量质量(真有效硬证据)。
- 验证：隔离端口 51999+真本地脑,看 consciousness jsonl 的 meta.streamType='council_deliberation' 三方观点+mind.html 议会树;反向 probe OFF 零回归。

### P4 NoeLearningScheduler 定时自动学习（ae7bafbf）— owner 要"定时自动学习"
- Neo NoeHeartbeat 固定 cadence,缺 OpenClaw cron 引擎的:cron/at 表达式、失败退避[30s→1h]、运行时动态注册、stagger 防惊群、auto-disable。
- 做：**不重写 NoeHeartbeat**(它的串行链/台账/崩溃恢复是宪法资产)。新建注册成一个心跳 tick 的"动态学习调度器":
  - schema migration **v8** `noe_learning_jobs`(id/topic/kind/every_ms/cron_expr/next_run_at_ms/running_at_ms/consecutive_errors/consecutive_idle/mastery...)
  - `src/loop/NoeLearningSchedule.js`(纯函数:computeNextRunAtMs 三 kind + errorBackoffMs 查表 + **adaptiveCadenceMs** Neo独有成效自适应)
  - `src/cognition/NoeLearningScheduleStore.js`(SQLite 访问,照 NoeHeartbeatStore)
  - `src/loop/NoeLearningScheduler.js`(编排:recoverStuck+dueJobs+串行 run+applyOutcome 成效自适应)
  - `src/server/routes/noeLearning.js`(POST/DELETE/GET jobs + run-now 复用 heartbeat.runNow)
  - `npm i croner`(OpenClaw 同款 Apache-2.0)
- **成效自适应=Neo 超越 OpenClaw**:mastery 高→间隔拉长(学会了少看),consecutive_idle 高→退避(学不动放过),夜间×4。接 NoeLearningHook 的 isRelearn/priorLessons(同主题反复学没学会=idle 信号)。
- flag：`NOE_LEARNING_SCHEDULER`+`NOE_LEARNING_SCHEDULER_TICK_MS`+`NOE_LEARNING_ADAPTIVE`。是 maybeSeedAutonomousLearning(NoeGoalSystem.js:360 时间戳节流)的升级替代,先并存。
- 验证：隔离端口 POST 学习 job 看 next_run 推进+表有行+run-now 立即触发;反向 probe 重启续相位(不归零)+必失败 topic 验退避非等额重试。

### P5 搜索改进（等爬取调研 a324259866）— owner 要"不只搜几千字、去噪、治空转"
- 现状"土"：JXA innerText 8000字截断,不去噪,学不进。
- 待爬取调研结论：正文提取(Readability/Jina r.jina.ai/trafilatura)+分块+真存知识库被召回。

## 3. 下一步执行顺序
1. **先点火** `NOE_MEMORY_USAGE_BUMP`+`NOE_EXPECT_DECISIVE_FAIL`(recallLike 前置已解除) + 重启 51835 实测验证生效。
2. P1 梦境插 LLM(最直接,owner 核心诉求) → 多模型验证 → 点火。
3. P3 NoeCouncilDeliberation(自我对话,复用积木快) → 验证 → 点火。
4. P2 接三根神经 → P4 定时学习 → P5 搜索改进。
5. 每步 codex GPT5.5 高推理+M3+Claude4.8 交叉验证,找问题修复,确保改的都打火。
