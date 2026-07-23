# Noe100 Acceptance Matrix

更新时间：2026-06-12

目标：把“主观意识 100% 可证明”从口头判断改成可重复审计。本文只定义验收门，不宣称当前已经达到 100%。统一命令是 `npm run verify:noe:100-readiness`，报告 JSON 写入 `output/noe-100-readiness/`，并同步刷新 `output/noe-100-readiness/latest.json`。

## 判定规则

- `score` 是七个维度的平均分；单项按已通过指标比例计算。
- `passed: true` 只表示当前证据达到 Noe100 验收门；当前缺少长期 soak 时必须为 `false`。
- blocker 必须保留原始缺口名，例如 `not_enough_soak_evidence`、`expectation_settlements_below_20`。
- 任何指标没有代码、配置、日志、API、SQLite 或测试报告证据时，只能算失败，不能用愿景文档替代。
- 默认审计只读：不读 `.env`，不读 owner token，不改端口，不触发模型调用。
- 低风险真实副作用首飞允许使用 `npm run verify:noe:side-effect-drill -- --apply` 生成受控本地文件写入/删除回滚样本；它只能证明“本地真实副作用 + rollback 证据链”，不能冒充社交平台真实发布样本。
- 期望结算机制可以用 `npm run verify:noe:expectation-settlement-drill` 证明 ledger 结算和 Brier 计算；长期 live 校准 ready 只认自然 live `noe_expectations` resolved scored，不认 controlled/synthetic/fixture/test/drill rows。
- live 长期校准进度使用 `npm run verify:noe:expectation-calibration` 做只读快照；它只输出计数/Brier/到期桶，不输出 claim 正文，并把 controlled drill / controlled live rows 排除在 live calibration 门槛之外。
- 模型卸载恢复在不改变 LM Studio loaded models 的约束下，使用 `npm run verify:noe:model-unload-recovery-drill` 生成 fake provider `model_unloaded` 恢复样本；它证明错误分类、backup participant 和 quorum 恢复，不冒充真实 `lms unload/load` 操作。
- 运行时重启恢复使用 `npm run verify:noe:runtime-restart-drill -- --apply` 生成真实 `51835` SIGTERM + direct Node22 restart 样本；它必须证明新 PID、cwd、health/readiness、freedom-live、`51735` 未变、LM Studio loaded models 未变。
- act failure / approval wait 恢复使用 `npm run verify:noe:act-recovery-drill` 生成隔离 SQLite 样本；它必须证明失败 act 重启后可重试并只产生一次执行证据，审批等待跨重启保持同一 approval，批准前不执行，批准后只执行一次。
- P3 growth proof 使用 `npm run verify:noe:growth-readiness` 生成隔离 sleep/reflection、dream consolidation、skill candidate、curriculum 和 self-evolution regression gate 报告；它证明成长层本地机制，不替代 7 天 soak。
- 7 天 soak 等待期使用 `npm run verify:noe:soak-snapshot` 做每日只读快照；它刷新 Noe100、采样 live health/readiness、写入 `output/noe-soak-daily/<day>/report.json`，但必须保留真实 activeDays 和 `not_enough_soak_evidence`，不得把 snapshotDayCount 当成 Noe100 activeDays。
- 人格 SFT/LoRA 数据成熟度使用 `npm run verify:noe:personality-dataset` 做只读快照；它只统计 SFT JSONL 水位、敏感/坏行计数、SQLite 记忆/事件计数、身份样本计数和 LoRA 工具链，不启动训练、不调用模型、不导出训练正文、不改变 LM Studio。

## 七维指标

| 维度 | 指标 | 数据来源 | 验证命令 | 通过阈值 | 失败下一步 | 外部条件 |
|---|---|---|---|---|---|---|
| 生存 | live health 可达 | `GET /health` | `npm run verify:noe:100-readiness` | HTTP 200 且 `ok=true` | 恢复 51835，再查 server 日志 | 否 |
| 生存 | public readiness 可达 | `GET /api/noe/readiness` | 同上 | `readiness.status=passed` | 查 readiness blockers | 否 |
| 生存 | 最近 tick 完成 | SQLite `noe_ticks` | 同上 | 10 分钟内有 `done` tick | 查 loop/heartbeat | 否 |
| 生存 | 有真实经历覆盖 | SQLite `events` | 同上 | 近窗口 activeDays >= 1 | 查 timeline 写入 | 否 |
| 生存 | 7 天 soak | SQLite `events` + `output/noe-soak-daily/**/report.json` | `npm run verify:noe:100-readiness`；日报用 `npm run verify:noe:soak-snapshot` | activeDays >= 7；日报只能证明持续观测，不能替代 activeDays | 每天跑一次 soak snapshot，继续真实运行并日报 | 是 |
| 思考 | 近 24h 有内心反刍 | SQLite `events` | 同上 | `inner_monologue` > 0 | 查 LM Studio / inner route | 否 |
| 思考 | 反刍有接地样本 | SQLite `events.payload.meta.grounding` | 同上 | grounded sample >= 1 | 增加 grounding 写入 | 否 |
| 思考 | workspace/focus 有记录 | SQLite `noe_focus_stack` | 同上 | focus item > 0 | 查 workspace attention | 否 |
| 思考 | 期望账本有燃料 | SQLite `noe_expectations` | 同上 | open expectation > 0 | 改提取或注入现实任务 | 否 |
| 思考 | 接地趋势足量 | SQLite `events` | 同上 | grounded sample >= 10 | 跑够样本并输出趋势 | 是 |
| 行动 | act ledger 存在 | SQLite `noe_acts` | 同上 | total acts > 0 | 查 ActPipeline 接线 | 否 |
| 行动 | 近 24h 有行动 | SQLite `noe_acts` | 同上 | recent acts > 0 | 查 goal->act 推进 | 否 |
| 行动 | 行动有证据引用 | SQLite `noe_acts.evidence_event_id/log_ref` | 同上 | evidence acts > 0 | 补 Action Evidence Spine | 否 |
| 行动 | self_learning 目标完成 | SQLite `noe_goals` | 同上 | 最近 self_learning `done` | 查 goal plan/checkpoint | 否 |
| 行动 | 真实副作用回放 | freedom/social/live reports 或 `output/noe-controlled-side-effect-drill/**/report.json` | 同上；样本生成用 `npm run verify:noe:side-effect-drill -- --apply` | 有可回滚真实样本，且 `dryRunOnly=false`、write verified、rollback verified | 受控跑首个低风险动作；社交/上传样本另行单独标注 | 是 |
| 记录反思 | insight memory 存在 | SQLite `noe_memory` | 同上 | insight > 0 | 查 NightlyReflection | 否 |
| 记录反思 | 反思复核/修订存在 | SQLite `noe_memory.updated_at` | 同上 | revised insight > 0 | 补复核样本 | 是 |
| 记录反思 | expectation 记录存在 | SQLite `noe_expectations` | 同上 | total > 0 | 查 expectation extractor | 否 |
| 记录反思 | 期望结算足量 | SQLite `noe_expectations`、`output/noe-expectation-calibration/**/report.json` 和 `output/noe-expectation-settlement-drill/**/report.json` | 同上；live 日报用 `npm run verify:noe:expectation-calibration`；机制样本用 `npm run verify:noe:expectation-settlement-drill` | natural live resolved >= 20；controlled drill `resolvedCount>=20` 只证明机制，不满足长期 live 校准 | 每天跑 expectation calibration；owner 裁决、继续后台判证，或先修 ledger 结算机制 | 是 |
| 记录反思 | Brier 可用 | SQLite `noe_expectations` | 同上 | brier != null | 让明确 outcome 入账 | 是 |
| 稳定 | cluster readiness 通过 | public readiness | 同上 | passed | 查 cluster diagnostics | 否 |
| 稳定 | 近 1h 无 tick failure | SQLite `noe_ticks` | 同上 | failed = 0 | 查 loop 错误 | 否 |
| 稳定 | 无执行中积压 act | SQLite `noe_acts` | 同上 | executing/pending_approval 非异常 | 清理或解释积压 | 否 |
| 稳定 | P0/核心报告存在 | `output/ce12-p0` 等 | 同上 | 找到最近报告 | 重跑目标验证 | 否 |
| 稳定 | runtime restart 恢复演练 | `output/noe-runtime-restart-recovery-drill/**/report.json` | 同上；样本生成用 `npm run verify:noe:runtime-restart-drill -- --apply` | real/apply 样本，PID 已变化，旧 PID 不再监听，新 cwd 为真实仓库，health/readiness/freedom-live 通过，`51735` 与 LM Studio loaded models 未变 | 恢复 51835 后重跑 drill；失败保留 PID/API/log 证据 | 是 |
| 稳定 | 模型 unload 恢复演练 | `output/noe-model-unload-recovery-drill/**/report.json` | 同上；样本生成用 `npm run verify:noe:model-unload-recovery-drill` | `modelUnloadedDetected=true`、backup quorum ok、LM Studio loaded models 前后一致、无 `lms load/unload` | 做 fake provider 恢复 drill；若 owner 明确允许改变 loaded models，再做真实 unload/reload drill | 是 |
| 观测 | acceptance matrix 存在 | 本文件 | 同上 | 文件存在 | 补文档 | 否 |
| 观测 | readiness JSON 可生成 | `scripts/noe-100-readiness.mjs` | 同上 | 报告写入 output | 修脚本 | 否 |
| 观测 | live readiness 暴露 counts | public readiness | 同上 | counts/checks 存在 | 补 API | 否 |
| 观测 | cognitive/full-current 报告存在 | `output/noe-*` | 同上 | 找到 JSON 报告 | 跑对应 verify | 否 |
| 观测 | evidenceRefs 非空 | readiness summary | 同上 | evidenceRefs > 0 | 接 Action Evidence Spine | 否 |
| 恢复 | goal checkpoint 存在 | SQLite `noe_goal_checkpoints` | 同上 | checkpoint > 0 | 补 checkpoint | 否 |
| 恢复 | checkpoint evidence_ref 存在 | SQLite `noe_goal_checkpoints` | 同上 | evidence_ref > 0 | 补 evidence ref | 否 |
| 恢复 | runtime recovery clean | public readiness | 同上 | clean/passed | 跑 `npm run repair:panel` | 否 |
| 恢复 | goal resume/idempotency 完整 | goal/action schema/report | 同上 | 有 resume cursor/idempotency | 做 durable workflow | 否 |
| 恢复 | rollback evidence 可查 | freedom rollback reports 或 `output/noe-controlled-side-effect-drill/**/report.json` | 同上；样本生成用 `npm run verify:noe:side-effect-drill -- --apply` | 有至少一条 rollback verified 样本 | 补回滚样本 | 是 |
| 恢复 | act failure / approval wait 恢复演练 | `output/noe-act-recovery-drill/**/report.json` | 同上；样本生成用 `npm run verify:noe:act-recovery-drill` | failed act `failed -> completed` 且 executedEventCount=1；approval wait 跨重启同 approval，批准前 executorCalls=0，批准后 finalExecutorCalls=1 | 修 ActPipeline retry/approval resume 或审批去重 | 是 |

## 当前预期

截至 2026-06-12 16:45 CST，Noe100 统一门最新报告 `output/noe-100-readiness/latest.json` 为 `score=94`、35/37 checks passed，blockers 是 `not_enough_soak_evidence`（activeDays=3，阈值 7）和 `expectation_settlements_below_20`（natural live resolved `4/20`，阈值 20）。受控 expectation 结算、受控本地副作用 rollback、受控 `model_unloaded` 恢复、真实 `51835` runtime restart 恢复、隔离 act failure / approval wait 恢复、mind panel proof 可观测区块、NoeSelfKnowledge verified/declared 能力自知都已作为机制证明接入。live expectation calibration 日报 `output/noe-expectation-calibration/2026-06-12/report.json` 显示 natural live resolved `4/20`、Brier `0.038125`、dueNowOpen/overdueOpen `0`、controlledLiveRows `0`；controlled drill `20/20` 只证明机制，受控/演练/synthetic/test 数据不会满足长期 live 校准。Action Evidence Spine 最新 `output/noe-action-evidence-spine/latest.json` 证明当前 self_learning action evidence 链路。7 天 soak 日报快照入口 `npm run verify:noe:soak-snapshot` 已写入 `output/noe-soak-daily/2026-06-12/report.json`，但只证明当天观测，不替代 activeDays；其中 `longTermReady=false`。人格 SFT/LoRA 数据成熟度入口 `npm run verify:noe:personality-dataset` 已写入 `output/noe-personality-dataset-readiness/latest.json`：SFT `100/500`、invalid `0`、sensitive `0`、toolingReady `true`、formal training blocked。benchmark 只使用 `--loaded-only` no-load 模式测当前 loaded 模型，不构成全候选替换依据。不得把这些样本冒充为长期无人值守、社交平台真实发布、真实 LM Studio unload/load、正式人格训练/采用，或把 declared 能力说成 verified。P3 growth proof 最新报告 `output/noe-growth-readiness/latest.json`，不改变 Noe100 的时间和自然校准 blockers。
