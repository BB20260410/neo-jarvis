# HANDOFF 2026-06-23 — P2 接入 + P3 信任校准全完 + SQLite-2 + H3（本会话全自主交付）

> 接手先读本文件 + AGENTS.md。本会话从 P2 切片A 接入做到 H3 文本工具协议接入聊天链路 + 总验收。

## 本会话交付（8 commit，全量 6471 绿，763 files）
| commit | 内容 | flag（默认 OFF） |
|---|---|---|
| 155f149 | P2 切片A 候选池接入 owner-seed（advisory frame） | NOE_CANDIDATE_POOL（已 kickstart ON） |
| 51a4ed0 | P3.4 自改预算/限速（防 thrashing） | NOE_SELF_EVOLUTION_MAX_CYCLES_PER_DAY / NOE_SELF_EVOLUTION_FAILURE_COOLDOWN_MS |
| 8c7e088 | P3.3 失败入 memory（复用 NoeFailureLessons，弃平行轮子） | NOE_SELF_EVOLUTION_FAILURE_MEMORY |
| e1d6e0f | P3.2 绿档自驱（green tier 自改省 owner approval） | NOE_SELF_EVOLUTION_GREEN_AUTONOMY（+ standing grant + real_apply 三重兜底） |
| 6d4f63f | P3.1 渐进审查梯度（自改越多审越松，高危始终全审） | NOE_SELF_EVOLUTION_REVIEW_TIER |
| c1ef3ca | SQLite-2 审计保留期 + VACUUM（panel.db 1.3G 瘦身） | NOE_DB_AUDIT_RETENTION / NOE_DB_VACUUM |
| f97b5f0 | H3 文本工具协议接入聊天链路 | NOE_TEXT_TOOL_PROTOCOL |
| c1fdc5e | H3 续答连贯性 minor 修复（总验收发现） | （同上） |

## 四闸门纪律（每个 P 级都过）
①代码审（Claude 子代理 + codex GPT5.5 三方独立、输入隔离、未互抄）②全量 vitest ③真跑改动路径（真 SQLite 端到端 / 真链路）④反向 probe（空值/边界/重复/reward hacking 操纵）。主线程逐行复核关键证据。
- 三方交叉发现并修的真问题：P2 孤儿候选(Claude+codex 双发现)、P3.3 重复造轮子(Claude 独发现→改复用)、P3.2 reward hacking 面 3 项(codex 独发现:事实来源/root 逃逸/fail-open)、P3.1 fail-open 黑名单(Claude 独发现→白名单)、SQLite-2 误删活跃 run + 旧库 CASCADE(codex)、H3 续答截断静默吞(Claude major)。

## 总验收闸门（整体回归）
- 全量 6471 绿、verify:handoff 83/0（无 secret 泄漏）、perf-check 🏁。
- Claude 子代理整体回归审：**整体可交付，无 critical/major、无必修项**。2 minor：#2 H3 续答丢 assistant 消息已修(c1fdc5e)；#1 P3.1 count 全表扫经主线程 EXPLAIN 复核**推翻**(走 COVERING INDEX，子代理漏看已有索引)。
- reward hacking 事实来源闭环全部坐实：completedCount←CycleStore 真 count、changedFiles←patch-plan operations[].path、hasOracle←reportRef existsSync、reviewTier/greenTierApproved 自报否决+hardVeto。
- 6 信任校准模块全入 PolicyFileGuard 禁区（防 Neo 自改自己的信任逻辑=reward hacking 防线）：NoeCandidatePool/NoeRiskTiering/NoeGoalCandidateStore/NoeSelfEvolutionBudget/NoeGreenAutonomyDecision/NoeReviewTier。

## owner kickstart 步骤（全留 owner 在场，信任模型变更/真跑能力）
1. **P2 候选池**：`NOE_CANDIDATE_POOL=1` 已写 .env:158 + 已 kickstart（owner-seed 已切 advisory）。
2. **P3.4 预算**：`.env` 设 `NOE_SELF_EVOLUTION_MAX_CYCLES_PER_DAY=N`（如 20）和/或 `NOE_SELF_EVOLUTION_FAILURE_COOLDOWN_MS=N`（如 1800000=30min）。
3. **P3.3 失败 memory**：`NOE_SELF_EVOLUTION_FAILURE_MEMORY=1`（独立 flag，不依赖预算）。
4. **P3.2 绿档自驱**（信任模型变更，最敏感）：需三重 env 同开才真生效——`NOE_SELF_EVOLUTION_GREEN_AUTONOMY=1` + `NOE_SELF_EVOLUTION_STANDING_GRANT=1`（executor assertStandingGrant）+ `NOE_SELF_EVOLUTION_REAL_APPLY=1`（真改代码）。建议先只开前两个观察 dry-run。
5. **P3.1 渐进审查**：`NOE_SELF_EVOLUTION_REVIEW_TIER=1`（阈值 NOE_REVIEW_TIER_FULL_N/FLAGGED_N/SAMPLE_EVERY 可调，默认 5/25/5）。
6. **SQLite-2 瘦身**：`NOE_DB_AUDIT_RETENTION=1`（保留期 NOE_TICKS_RETENTION_DAYS/AGENT_RUNS_RETENTION_DAYS 默认 14/30）；要瘦当前库设激进档（如 TICKS=7）+ `NOE_DB_VACUUM=1`。**真效果模拟**(生产副本)：当前 panel.db 1.3G 数据集中最近 14 天，30/90 天 0 删、7/14 天瘦 129MB(9%)——真价值是长期防无界增长。**VACUUM 跑完关 flag**(进程内一次性，重启才再跑)。
7. **H3 文本工具协议**：`NOE_TEXT_TOOL_PROTOCOL=1`，本地模型 live e2e 需 owner 在场测（含 <<<NOE_TOOL>>> 标记→只读工具→续答）。

## SQLite-3/4 诚实 skip（非遗漏）
SQLite-3 生成列：主线程 EXPLAIN+实测 json_extract(approvalResumeGateId) 全表扫仅 99ms 且是治理冷查询，加生成列+索引的写放大不值得（取舍表「可维护性>性能」）。SQLite-4 perf_hooks 诊断 low 优先级 nicety。两者测量后定夺 skip。

## 关键文件
- 候选池 src/cognition/NoeCandidatePool.js + src/storage/NoeGoalCandidateStore.js（表 noe_goal_candidates，migration v16）
- 风险分级 src/security/NoeRiskTiering.js + 绿档决策 src/security/NoeGreenAutonomyDecision.js
- 预算 src/room/NoeSelfEvolutionBudget.js + 审查档 src/security/NoeReviewTier.js
- 自改门 src/loop/NoeSelfEvolutionActGuard.js（resolveGreenAutonomyDecision + reviewTier 注入）+ src/room/NoeSelfEvolutionGate.js（green 第4授权 + post_review 放松）
- 失败入 memory：复用 src/cognition/NoeFailureLessons.js（server.js recordSelfEvolutionFailure）
- SQLite-2：src/storage/SqliteStore.js pruneAuditTables + src/server/services/noe-maintenance.js
- H3：src/room/SoloChatDispatcher.js（接 orchestrateTextToolTurn）+ src/voice/NoeTextToolExecutor.js/NoeTextToolProtocol.js（已建）

## 验收基线
全量 npm test = 6471 绿（763 files）。本会话新增测试：candidate-store(13)+candidate-routes(11)+budget(13)+failure-taxonomy→改 failure-memory(3)+green-autonomy(9)+green act-guard(7)+review-tier(11)+gate green/review(6)+act-guard reviewTier(5)+prune-audit(7)+solo-chat-text-tool(6) 等。

## 教训
- 工具调用反复掉 antml: 前缀致 malformed（中文散文后接缝处滑落）→ 已沉淀记忆 feedback_antml_prefix_toolcall.md，铁律=工具调用前零散文/批量并行。
- 多模型也会错：总验收 minor#1 子代理漏看已有索引报"全表扫"，主线程 EXPLAIN 复核推翻——主线程亲自验关键证据是防幻觉底线。
- codex CLI 本环境两次卡死(SQLite-2 复审 / H3 审 exit 144)，降级用 Claude 子代理 + 主线程复核补足（降级诚实）。
