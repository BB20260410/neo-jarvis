# Neo 贾维斯 后续 P0-P10 路线图 v3(最终·三轮审定稿)— 2026-06-22

> 演进:v1(三路研究收敛)→ v2(主线自审升华:Neo 自主飞轮)→ **v3(二轮多模型+子代理审 + 飞轮实证诊断,务实定稿)**。
> owner 铁律:完全自主 + 自由优先(可见/可审计/可回滚 > 审批拦截/sandbox/prompt净化),开发者模式别设过多限制。

## 核心修正(三轮审打脸的乐观)
- **范式方向对,但时序错**:v2 主张"让 Neo 用 P5/P7/P10 接线练手自改"。三轮审一致否决——**Neo complete=0**(10 cycle 全卡 no_patch_plan/consensus/post_review),**飞轮空转**(selfEvolve 每分钟跑但 no_open_self_evolution_goal:goal 全 done×8/dropped×5,Neo 今天起意 abd57cde 被 drop→孤儿 cycle),且 P5/P7/P10 一半踩 PolicyFileGuard 禁区(server.js/tests 整树 Neo 改不了)。**范式是终点不是起点。**
- **complete 控制链有 P0 bug(Codex 实证)**:① post-review shape 不匹配(`makeNoeCompletionPostReview` 读 `r.reviews`,runner 返回 `r.postReview.reviews`)② memory_writeback→complete 闭环缺(autodrive 只到 retrospective)③ verify 失败→self_repair 不通(ActPipeline catch 只留 error message)。
- **.env 95 个 NOE_ 全 ON 无一 OFF**:认知底座未首验就 ON + 自改链全 ON = 流沙上自改。
- **结论**:不是"再点火",是**先把飞轮修到能转 + 控制链修通 + 守 Neo 真 complete 第一次**;Neo 自做留到练熟后,且只给 L0/L1。

## 自做 vs 主线做 边界(三轮审收敛矩阵)
| 任务 | 谁做 | 理由 |
|---|---|---|
| readonly/检索/分析 | **Neo 全自做** | 无 blast radius |
| 非保护路径小改(<100行+有测试) | **Neo 自做+主线审** | 单 commit 可 revert |
| P5/P7/P10 接线、补测试、拆巨石 | **主线**(Neo 现在碰不了) | 踩 tests/server.js 禁区+要写测试+complete=0 |
| REAL_APPLY/cycle/心跳/persona/prompt/ReflectiveTuner | **核心禁区·永不自改** | 元自改=自己定义自己=reward hacking |
| Electron/跨进程/UI/凭据/发布 | **主线** | 需外部凭据/构建/视觉 oracle |

## P0 — 修飞轮+控制链+守第一个真 complete(主线·最紧急)
- **P0.1 修 complete 控制链 3 bug**(Codex 实证):post-review shape(r.postReview.reviews)/ memory_writeback→complete 闭环 / verify 失败→self_repair_ready(不是 stuck/drop)。
- **P0.2 修飞轮空转**:① 喂 1 个高质量 open self_evolution goal(明确可定位技术对象+非禁区单文件+有测试,主线确定 codex 能出 patch)② 修孤儿 cycle(goal drop/done 时关联 cycle 也 close,堵 churn)。
- **P0.3 守第一个真 complete cycle**:突破 no_patch_plan(codex 不降级单飞 probe)→ apply → verify → post_review 真过 → memory_writeback → complete。
- **P0.4 反向 probe**(8 类):元自改拦截(改 REAL_APPLY/server.js 被 PolicyFileGuard 拦且不静默)、并发自改顺序、跨耦合 blast 被回归捕获、验证 oracle 独立(自验≠外部验)、rollback 字节级真恢复、no_patch diagRef、重启续跑、blockedPath 拒绝可见。
- **P0.5 核心禁区显式化 + emergency stop**:REAL_APPLY/cycle/心跳/persona/prompt/ReflectiveTuner 整模块禁区(ReflectiveTuner 加 watchdog hash);run-time kill switch(owner 一键停自主)。
- **P0.6 owner 实时可观测**:mind.html 显示 active objective/cycle stage/最近 diff/stuck reason(不是只 SLO);SLO schema v2(补 duration/correlation,现 successRate=null 不能给提速放行)。

## P1 — 接通已建未接(主线做,Neo 碰不了禁区)
- P1.1 P5 双时态:`builtinReadonlyTools` 暴露 `noe.kg.as_of` + `MemoryCore.recall/recallFused` 加 asOf 过滤(默认零回归)。
- P1.2 P10 TopicDiscovery 接 `NoeGoalSystem:376`(并入 dynamicConcepts,**保留 evidence/source/score 不被 curator 剥掉**)。
- P1.3 P7 ReflectiveTuner 挂 shadow tick(heartbeat.register,只 archive/recommend,修 adopted/semantic 命名,整模块禁区化)。
- P1.4 认知链路 E2E:证明 inner-state/persona 真进主聊天+语音 prompt(`NOE_CHAT_CONTEXT` 等开关首验),不靠 readiness 自证。

## P2 — 引导机制 + 候选池(主线策展,把自由落到机制)
- P2.1 引导≠拦截:owner 种子进 `suggestion` advisory frame(append-only,非 directive),Neo 自主打分采纳/拒绝并**记录拒绝理由**(mind.html 可见);延迟注入(进队列非实时打断);周期 re-grounding 对话(非 steer)。
- P2.2 多源候选池:owner-seeded / self-discovered / system-triggered;owner 不独占(防 approval-seeking AI)。
- P2.3 风险门:复用现成 `NoeEvolutionCandidateGate` + PolicyFileGuard,5 维分级(blast/可逆/外部依赖/语义验证/耦合);陈旧目标 retirement。

## P3 — 渐进信任 + Neo 练手 lane(飞轮可持续)
- P3.1 信任校准:首 5 次自改主线全审 diff → 次 20 次只审 auto-flagged → 后 100 次抽样;阶段跃迁条件显式化。
- P3.2 Neo 自做 L0/L1:从候选池绿档(非保护+有测试+小 diff)取,Neo 自驱,主线审 cycle artifact。
- P3.3 跨 cycle 学习:failure taxonomy(数据缺/路径错/权限拒/逻辑错/超时)+ postmortem 入 memory,下轮 recall。
- P3.4 自改预算限速:每日 N cycle 上限 + 失败冷却期(防 thrashing)。

## P4+ — 工具/体验/提速/工程(条件解锁,延后)
- P4.1 语义 oracle:eval/holdout/reward-gate(Codex 强调——owner 只审抽样+阈值,不每轮亲自语义裁决)。
- P4.2 工具 PoC(不达 2x 不采):Serena 激活拆巨石 / security-guidance 正则层(关 LLM) / Graphiti·Memori 降级 PoC(双时态已自建+embedding 已 keep_alive 根治)。
- P4.3 陪伴可视化(mind.html 完整 VAD/Focus/GWT)/ 周记(依赖 P5+认知链路)。
- P4.4 自演化提速:**必须 P0-P3 指标达标**(连续 N complete + MTTR/rollback/stuck 达标)才缩短 tick。
- P4.5 巨石拆分(Serena 辅助)/ Electron 签名(dist-signed 已建未跑)/ 跨进程·UI(等巨石+UI 稳)。

## 贯穿判据
修飞轮转 > 纸面规划;主线接通 > Neo 自做(练熟前);**核心禁区永不自改**;引导≠拦截(机制非原则);真空白 > 重复造轮子;**自由优先 = 可见/可审计/可回滚 + emergency stop 兜底(停得住才敢放开)**。
