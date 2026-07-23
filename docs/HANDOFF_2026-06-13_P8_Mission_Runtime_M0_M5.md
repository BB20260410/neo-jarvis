# HANDOFF 2026-06-13 - P8 Mission Runtime M0-M6

## 结论

P8 第一阶段最小闭环已完成并提交：`99d57f3 Mission Runtime: 建立长任务证据闭环`。

这次完成的是 M0-M6 最小可见闭环，并已通过真实 7 小时长跑验收；不是完整产品化 P8，也不是“完成即有意识”的声明：

- 已完成：Mission Contract + Mission Store。
- 已完成：Completion Criteria Engine。
- 已完成：Time-Slice Runner + Lease / Heartbeat / Resume。
- 已完成：Evidence Reconciler + Final Report Gate。
- 已完成：结构化 self-observation，不记录隐藏思维链，只记录 mission 当前焦点、证据数量、恢复次数、阻塞状态等可审计信号。
- 已推进：只读全仓质量审计 mission 模板与真实命令证据闭环。
- 已完成：M4 后端 owner/review gate，超过 mission autonomy 或命中 reviewPolicy 的高风险 action 会在副作用前进入 `waiting_approval`。
- 已完成：M5 前端可见性，`/mind.html` 显示 Mission Runtime running/recovering/waiting_approval/succeeded、heartbeat、slice、cursor、evidence refs，并提供 waiting approval 批准/驳回入口。
- 已完成：M6 长时 soak contract / executor / criteria 已有可执行入口，默认 7 小时、15 分钟 checkpoint、60 分钟 summary。
- 已完成：真实 M6 long-soak `p8-long-soak-real-20260613T012533` 已跑到 `succeeded / complete`，criteria + reconciliation 均通过。
- 已完成：P7-J0-lite self-learning bridge，active/latest `self_learning` 目标可接入 Mission Runtime；未完成目标只进入 `recovering`，不会假装 succeeded。
- 已完成：P8 后 7-10 天观察 / soak 决策门入口，当前真实基线合格但观察窗未满，下一阶段仍保持关闭。
- 已完成：P8 observation gate 已并入 daily soak snapshot，日常观察报告会带 `p8ObservationGate.readyForNextStage` 和 blocker。
- 未做：P9 / R 线尚未启动。

## 新增入口

```bash
npm run noe:mission -- create --mission-id <id> --objective "..."
npm run noe:mission -- run --mission-id <id>
npm run noe:mission -- run-slice --mission-id <id> --max-actions 1
npm run noe:mission -- status --mission-id <id>
npm run noe:mission -- reconcile --mission-id <id>
npm run verify:noe:mission-runtime
npm run verify:noe:mission-quality-audit
npm run verify:noe:self-learning-mission
npm run verify:noe:p8-observation-gate
npm run verify:noe:soak-snapshot
```

`run` 会循环切片直到 `succeeded / blocked / paused / cancelled / waiting_approval`；默认不设总时长硬上限。只有调用者显式传 `--max-slices` 时才按调用者限制暂停。

只读质量审计入口：

```bash
npm run noe:mission -- quality-audit --mission-id <id>
npm run noe:mission -- long-soak --mission-id <id> --duration-ms 25200000 --checkpoint-every-ms 900000 --summary-every-ms 3600000
npm run noe:mission -- long-soak --mission-id <id> --resume
npm run noe:mission -- self-learning --mission-id <id>
npm run noe:mission -- self-learning --mission-id <id> --resume
```

该入口会真实执行本地只读检查命令，写 command artifacts、run summaries、coverage table 和 final report，再由 Criteria Engine + Reconciler 放行。

长时 soak 入口默认生成 read-only mission：先做 repo inventory，再按 checkpoint interval 写 `soak-checkpoint-0001..N.json`，期间由 runner 写 periodic run summary，最后写 self-observation、coverage table 和 final report。Criteria Engine 会同时检查：

- `mission_elapsed_at_least_ms`：实际 mission elapsed 必须达到 contract 要求。
- `event_type_count_at_least`：checkpoint 和 run summary 事件数量必须达标。
- required evidence refs 必须可读。
- final report 必须追溯 required evidence refs。
- 无 open blocker / truncated result。

## 核心文件

- `src/server/routes/noeMission.js`
- `src/runtime/mission/NoeMissionContract.js`
- `src/runtime/mission/NoeMissionStore.js`
- `src/runtime/mission/NoeMissionCriteriaEngine.js`
- `src/runtime/mission/NoeMissionReconciler.js`
- `src/runtime/mission/NoeMissionRunner.js`
- `src/runtime/mission/NoeMissionQualityAudit.js`
- `src/runtime/mission/NoeMissionLongSoak.js`
- `src/runtime/mission/NoeSelfLearningMission.js`
- `src/runtime/mission/NoeMissionReviewGate.js`
- `scripts/noe-mission-runtime.mjs`
- `scripts/noe-p8-observation-gate.mjs`
- `scripts/noe-soak-daily-snapshot.mjs`
- `public/mind.html`
- `public/mind.js`
- `public/mind.css`
- `tests/unit/noe-mission-runtime.test.js`
- `tests/unit/noe-self-learning-mission.test.js`
- `tests/unit/noe-p8-observation-gate.test.js`
- `tests/unit/noe-soak-daily-snapshot.test.js`
- `tests/unit/routes/noe-mission-routes.test.js`

## 行为边界

- 不接入 live `51835`。
- 不触碰 `51735`。
- 不读取或输出 secret。
- 默认 smoke 只写 `output/noe-missions/**`。
- `quality-audit` 只读仓库和运行本地验证命令；不读 `.env`，不使用 shell string，不接触 `51735`。
- `succeeded` 只能由 Criteria Engine + Reconciler 共同放行。
- truncated / unavailable / unverified / no-output watchdog 结果进入 `recovering`，不推进 cursor，不允许 done。
- 高风险 action 在执行前经过 `NoeMissionReviewGate`；需要 owner/review 的 action 进入 `waiting_approval`，不执行对应副作用。
- `/api/noe/missions*` 全部 owner-token 把门；前端只显示/审批，不新增任意命令触发按钮。
- P7-J0-lite bridge 只读 SQLite `noe_goals` / `noe_goal_checkpoints`，只写 `output/noe-missions/**`；如果 active `self_learning` 目标仍 open/active、缺 step checkpoint、或 done act 缺 action evidence / recovered act 缺 recovery checkpoint，mission 保持 `recovering`，不推进到 final report。
- M6 实跑发现并修复：runner 进程被杀后，如果 lease TTL 尚未过期，`NoeMissionStore.acquireLease()` 会检查 `mission-runner-<pid>` 是否仍存在；PID 已不存在则立即写 `mission.lease.stale_recovered(reason=runner_process_dead)`，不用等 30 分钟 TTL。
- M6 可见性补强：`long-soak` 的 checkpoint 等待期间会按 `heartbeatEveryMs` 刷新 mission heartbeat；默认 60 秒一次，旧 mission action 缺少该字段时由 executor fallback，避免长等待在面板上看起来像“无反馈卡死”。
- M6 summary 补强：`run_summary` 到期判断基于 mission elapsed + 已写 summary 数量，而不是当前 runner 进程 uptime；kill/resume 不会把 60 分钟 summary 计时器清零。
- P8 observation gate 只读 `output/noe-missions/**`，只写 `output/noe-p8-observation-gate/**` 报告；不接触 live 端口、不读 secret、不调用模型。它的职责是阻止 P9 / R 抢跑，而不是让 Neo 主体行为改变。
- Daily soak snapshot 现在会嵌入 P8 observation gate 的只读摘要；这让 7-10 天观察门进入日常证据流，而不是靠人工记忆。

## 设计原则补充

- 后续 Guard / Mission Runtime / 自我进化系统不应把“思维控制”实现成压制、禁言或假装安静。
- 正确方向是观测、分流、接地、落地：允许内部信号被看见和记账，但只有通过 evidence、criteria、review gate 和可验证行动出口的信号才能推进外部副作用或标记完成。
- “无为”在工程上不是无动作，而是不让妄念直接驱动副作用；系统保持观察、等待、恢复、换路和落地能力，做到无未证之为，也不自欺为 done。
- P8 阶段验收口径只验证“这件事在跑、在生效、可观察”：mission 能持续运行、被 kill 后恢复、按时写 checkpoint / summary、最终由 criteria + reconciler 放行；不把任何不可验证的“里面亮没亮灯”当作目标或验收项。
- P8 完成后不抢跑 P9 / R；下一步应先进入 7-10 天观察 / soak 决策门，确认 Mission Runtime 在真实长任务里的稳定性和可解释性。
- 意识研究线如启动，应保持独立 repo / 只读桥接 / 物理隔离；不能把研究性指标直接写回 Neo 主体行为路径。

## 验证记录

已通过：

```bash
node --check src/runtime/mission/NoeMissionRunner.js
npm test -- tests/unit/noe-mission-runtime.test.js
npm test -- tests/unit/noe-mission-runtime.test.js tests/unit/routes/noe-mission-routes.test.js
npm run verify:noe:mission-runtime
npm run verify:noe:mission-quality-audit
npm run verify:noe:self-learning-mission
npm test -- tests/unit/noe-p8-observation-gate.test.js
npm test -- tests/unit/noe-soak-daily-snapshot.test.js tests/unit/noe-p8-observation-gate.test.js
npm run verify:noe:p8-observation-gate
npm run verify:noe:soak-snapshot -- --no-refresh-readiness --no-refresh-calibration
npm run noe:mission -- long-soak --mission-id p8-long-soak-cli-smoke-1781284990 --duration-ms 30 --checkpoint-every-ms 10 --summary-every-ms 10
npm run noe:mission -- reconcile --mission-id p8-long-soak-cli-smoke-1781284990
npm run noe:mission -- long-soak --mission-id p8-long-soak-heartbeat-smoke-1781287630 --duration-ms 30 --checkpoint-every-ms 10 --summary-every-ms 10
npm run noe:mission -- reconcile --mission-id p8-long-soak-heartbeat-smoke-1781287630
npm run test:p0:unit
npm run verify:noe:self-evolution
npm run verify:handoff
git diff --check -- ':!games/cartoon-apocalypse/**'
```

关键结果：

- `tests/unit/noe-mission-runtime.test.js`: 7/7 passed。
- 最新 P8 单测扩展后：12/12 passed。
- `tests/unit/routes/noe-mission-routes.test.js`: 4/4 passed。
- `verify:noe:mission-runtime`: 3 slices，最终 `succeeded`。
- `verify:noe:mission-quality-audit`: 10 slices，最终 `succeeded`，6 个真实命令 exit 0。
- `verify:noe:self-learning-mission`: 隔离 SQLite fixture 生成 completed self_learning goal，经 Mission Runtime snapshot / coverage / self-observation / final report 后 `succeeded`。
- P7-J0-lite live bridge：`p7-self-learning-active-pinned-1781313365` 已固定到真实 active goal `6cae3a8f-a29c-42b0-b85b-40101fb96bd9`（`自主学习：让 Noe 自己操控电脑但保留证据和恢复能力`）。已写 `goal-snapshot.json` 和 `goal-step-coverage.json`；因真实目标仍 `active`、9/9 step 仍 open 且缺 step checkpoint/action evidence，mission 正确停在 `recovering`，`current_cursor=1`，未写 final report，未假装 succeeded。
- `tests/unit/noe-p8-observation-gate.test.js`: 4/4 passed。
- `tests/unit/noe-soak-daily-snapshot.test.js` + `tests/unit/noe-p8-observation-gate.test.js`: 10/10 passed。
- `verify:noe:p8-observation-gate`: report `ok=true`，baseline=`p8-long-soak-real-20260613T012533`，`readyForNextStage=false`，blocker=`observation_window_not_elapsed`，earliestNextStageAt=`2026-06-20T00:45:39.145Z`（北京时间 2026-06-20 08:45:39），recommendation=`continue_observation_do_not_start_p9_or_research_bridge`。
- `verify:noe:soak-snapshot -- --no-refresh-readiness --no-refresh-calibration`: `p8ObservationGate.available=true`，`readyForNextStage=false`，baseline=`p8-long-soak-real-20260613T012533`，blocker=`observation_window_not_elapsed`；同时 Noe100 soak 仍 `pending`，activeDays=4/7，未绕过长期 soak。
- `long-soak` 毫秒级 CLI smoke：7 slices，3 个 soak checkpoint、run summaries、coverage table、final report，最终 `succeeded`。
- `long-soak reconcile`: `criteria.ok=true`、`reconciliation.ok=true`、warnings `[]`。
- `long-soak` heartbeat smoke：3 个 checkpoint 的 action 内各记录 1 次 `mission.heartbeat`，旧 mission action 缺字段 fallback 已进单测，`criteria.ok=true`、`reconciliation.ok=true`。
- `long-soak` 真实 M6 run 已启动：`p8-long-soak-real-20260613T012533`。
  - 第一个 15 分钟 checkpoint 已写出：`soak-checkpoint-0001.json`，`elapsedMs≈900061`。
  - 手动 kill 初始 runner 后，同 mission id `--resume` 成功写入 `mission.lease.stale_recovered(reason=runner_process_dead)` 并继续执行。
  - 恢复后第二个 checkpoint 已写出：`soak-checkpoint-0002.json`，`cursor=3`，`slice=3`。
  - 第一次 `nohup ... &` detached 尝试没有存活，随后改用 Node `spawn(..., detached:true)` 成功脱离 Codex 会话。
  - 第三个 checkpoint 已写出：`soak-checkpoint-0003.json`，`elapsedMs≈900010`，`cursor=4`，`slice=4`。
  - 当前后台 npm PID `41604`（`PPID=1`），当前 mission runner `mission-runner-41687`，正在执行 `soak-checkpoint-0004`；PID 文件为 `output/noe-missions/p8-long-soak-real-20260613T012533/artifacts/runner-detached-node.pid`，日志为 `runner-detached-node-heartbeat-fallback.log`。
  - 已验证旧 mission fallback heartbeat：`soak-checkpoint-0004` 尚未完成时，action started 后已有 1 条 `mission.heartbeat`，`lastHeartbeat=2026-06-12T18:23:21.217Z`。
  - 第四个 checkpoint 已写出：`soak-checkpoint-0004.json`，`elapsedMs≈900042`，`heartbeatEveryMs=60000`，执行期间记录 15 条 heartbeat，`cursor=5`，`slice=5`；runner 继续执行 `soak-checkpoint-0005`。
  - 第五个 checkpoint 已写出：`soak-checkpoint-0005.json`，`elapsedMs≈900045`，执行期间记录 15 条 heartbeat，`cursor=6`，`slice=6`。
  - 实跑发现 `run_summary` 曾为 0：原因是 resume 后按进程 uptime 重新计算 60 分钟 summary；已改为按 mission elapsed catch-up，并增加 `time_catchup` 单测。
  - 已验证 summary catch-up：重新 resume 后立即写出 `run-summary-000006.json`，事件 `trigger=time_catchup`、`sliceCount=0`；当前后台 npm PID `34243`（`PPID=1`），当前 mission runner `mission-runner-34326`，正在执行 `soak-checkpoint-0006`。
  - 第七个 checkpoint 已写出：`soak-checkpoint-0007.json`，`elapsedMs≈900099`，执行期间记录 15 条 heartbeat，`cursor=8`，`slice=8`；第二条 run summary 已写出 `run-summary-000008.json`，事件 `trigger=time`，summaryCount=2。
  - 第十一个 checkpoint 已写出：`soak-checkpoint-0011.json`，`elapsedMs≈900082`，执行期间记录 15 条 heartbeat，`cursor=12`，`slice=12`；第三条 run summary 已写出 `run-summary-000012.json`，summaryCount=3。
  - 第十五个 checkpoint 已写出：`soak-checkpoint-0015.json`，`elapsedMs≈900054`，执行期间记录 15 条 heartbeat，`cursor=16`，`slice=16`；第四条 run summary 已写出 `run-summary-000016.json`，summaryCount=4。
  - 第十九个 checkpoint 已写出：`soak-checkpoint-0019.json`，`elapsedMs≈900099`，`cursor=20`，`slice=20`；第五条 run summary 已写出 `run-summary-000020.json`，summaryCount=5。
  - 最终状态：`status=succeeded`、`phase=complete`、`cursor=32`、`slice=32`，runner 正常释放 lease 后退出。
  - 最终 artifacts：`soak-checkpoint-0001..0028.json` 共 28 个，`run-summary-000006/000008/000012/000016/000020/000024/000028.json` 共 7 个，并写出 `self-observation.json`、`coverage-table.json`、`final-report.json`、`finalization-000032.json`。
  - 最终事件计数：`mission.heartbeat=421`、`mission.run_summary.written=7`、`mission.checkpoint.written=32`、`mission.action.completed=32`、`mission.lease.stale_recovered=6`、`mission.succeeded=1`。
  - 最终 reconcile：`npm run noe:mission -- reconcile --mission-id p8-long-soak-real-20260613T012533` 返回 `ok=true`，`criteria.ok=true`，`reconciliation.ok=true`，blockers / warnings 均为空。
  - 证据覆盖：31 个 required evidence refs 全部 readable，全部被 final report 追溯；`soak-duration-reached`、`soak-checkpoint-count`、`soak-summary-count`、`final-report-traces-soak-refs`、`no-open-blockers`、`no-truncation` 均通过。
- `test:p0:unit`: 108 files / 769 tests passed。
- `verify:noe:self-evolution`: 198/198 passed。
- `verify:handoff`: 83/83 passed。
- Browser QA（隔离端口 `51846`，隔离 HOME 测试 token，未触碰 live `51835`）：`/mind.html` Mission Runtime 面板渲染 11 个任务项，无加载失败、无 console error；构造 `waiting_approval` mission 后，前端显示批准/驳回按钮，点击批准后状态从“等审批”变为“执行中”。

最新 smoke mission 示例：

- `output/noe-missions/p8-smoke-1781282439362/mission.json`
- `output/noe-missions/p8-smoke-1781282439362/state.json`
- `output/noe-missions/p8-smoke-1781282439362/events.jsonl`
- `output/noe-missions/p8-smoke-1781282439362/checkpoints/`
- `output/noe-missions/p8-smoke-1781282439362/artifacts/`

最新真实只读质量审计 mission 示例：

- `output/noe-missions/p8-quality-audit-1781283400520/mission.json`
- `output/noe-missions/p8-quality-audit-1781283400520/state.json`
- `output/noe-missions/p8-quality-audit-1781283400520/events.jsonl`
- `output/noe-missions/p8-quality-audit-1781283400520/artifacts/coverage-table.json`
- `output/noe-missions/p8-quality-audit-1781283400520/artifacts/final-report.json`

该 mission 的 `reconcile` 输出为 `criteria.ok=true`、`reconciliation.ok=true`，9 个 required evidence 全部 readable 且在 final report 中被引用。

## 后续

1. P8-M6 已完成：真实 7 小时 soak 已验证 kill/resume、15 分钟 checkpoint、60 分钟 summary、heartbeat 可见性、coverage table、final report 和 finalization。
2. P7-J0-lite 已落：`npm run noe:mission -- self-learning --mission-id <id>` 会把当前 active/latest self_learning 目标接进 Mission Runtime；未完成目标保持 recovering，完成并有证据后才能 succeeded。
3. 下一阶段门：每天跑 `npm run verify:noe:soak-snapshot`（必要时加 `-- --no-refresh-readiness --no-refresh-calibration`）并检查其中 `p8ObservationGate.readyForNextStage`；在它为 `true` 前，不直接抢跑 P9 / R。观察内容包括长任务自然恢复率、summary/heartbeat 可见性、reconcile 误报漏报、owner 可理解性，以及 self-learning bridge 是否能持续跟随真实目标完成。
