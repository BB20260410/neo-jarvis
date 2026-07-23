# 交接 · 三角色 Qwen 主脑路由与 Noe100 后续计划 2026-06-12

> 2026-06-12 12:01 CST 覆盖更新：本文件中的“单主脑 Gemma / Qwen 只手动实验”口径已被三角色本地模型路由取代。当前策略为 Main Brain `qwen/qwen3.6-35b-a3b`（load key `qwen/qwen3.6-35b-a3b@6bit`）、Review Brain `qwen/qwen3.6-27b`（load key `qwen/qwen3.6-27b@4bit`）、Fallback Brain `gemma-4-26b-a4b-it-qat-mlx`。执行记录见 `docs/EXECUTION_RECORD_2026-06-12_三角色本地模型路由.md`。

> 给下个窗口：这是短主线入口。先确认真实仓库和工作树，再按 P0/P1/P2/P3 执行。长研究不要塞进本文件，按引用阅读。

## 最新执行更新（2026-06-12 11:11 Asia/Shanghai）

- 2026-06-12 12:52 CST 追加：`npm run verify:noe:full-current -- --include-managed` 首轮失败在 `phase5_live/noe_do_search_intent_returns_results`，报告 `output/noe-full-current/full-current-1781239469615.json`；定位为 `server.js` 全局 `EnvHttpProxyAgent` 下 MiniMax search `fetch failed`，而 Node22 直连可成功。
- 已修复 `src/research/WebSearch.js`：有代理环境时 MiniMax search 300ms 后并发直连 dispatcher 竞速，避免挂起的代理路径拖死 15s live 验收；新增单测 `tests/unit/research-websearch.test.js` 覆盖代理 dispatcher 网络失败后直连恢复。
- 已触碰并重启 `51835` 两次做 live 修复加载：最终报告 `output/noe-runtime-restart-recovery-drill/20260612T045132Z/report.json`，当前新 PID `51890`，cwd `/Users/hxx/Desktop/Neo 贾维斯`，`/health`、`/api/noe/readiness`、`verify:noe:freedom-live` 均通过；`51735` PID `4773`/cwd `/Users/hxx/Desktop/00_项目/05_Claude可视化面板` 未变；LM Studio loadedModels 前后一致。
- `npm run verify:noe:phase5` 已恢复 PASS，报告 `output/noe-phase5-runtime/phase5-runtime-1781239898463.json`。`npm run verify:noe:full-current -- --include-managed` 已全绿，报告 `output/noe-full-current/full-current-1781239907801.json`，13/13 steps passed。
- P2 工具接入已补 `TOOL_ADOPTION_RECORD`：`docs/TOOL_ADOPTION_RECORD_2026-06-12_Noe_Ecosystem.md`。Serena MCP、Playwright MCP safe proxy、LanceDB PoC、精选 Skills、Sherpa 现有栈、Stagehand local LM Studio PoC、Inspect AI eval 样例、GitHub readonly MCP 均登记 smoke/evidence/rollback；Batch C 仍仅 isolated plan。
- 2026-06-12 12:58 CST 追加：`scripts/noe-100-readiness.mjs` 已补齐 `output/noe-100-readiness/latest.json`，并新增隔离单测 `tests/unit/noe-100-readiness.test.js`。当时报告 `output/noe-100-readiness/noe-100-readiness-1781240310398.json` 与 `output/noe-100-readiness/latest.json` 文件内容一致；判定未变，仍 `score=97`、36/37、唯一 blocker `not_enough_soak_evidence`（activeDays `3/7`）。后续最新见 13:56 CST 追加。
- 2026-06-12 13:01 CST 追加：`npm run test:p0:unit` 首轮暴露三角色路由回归，Review Brain preflight 的 `loadModel` 错误输出为 API id `qwen/qwen3.6-27b`；已修正 `src/model/NoeLocalModelPolicy.js`，Main/Review 首选 load key 分别为 `qwen/qwen3.6-35b-a3b@6bit`、`qwen/qwen3.6-27b@4bit`，API/chat id 仍保持无后缀。定向测试和完整 P0 已复跑通过。
- 2026-06-12 13:05 CST 追加：P2 model health 只读快照已补 `output/noe-model-health/latest.json` 稳定入口，并新增 `tests/unit/noe-model-health-snapshot.test.js` 纳入 `npm run test:p0:unit`。最新真实报告 `output/noe-model-health/model-health-1781240757827.json` 与 `output/noe-model-health/latest.json` 一致；LM Studio loadedModels 为 `qwen/qwen3.6-35b-a3b`，`lmStudioLoadUnloadChanged=false`，`secretValuesReturned=false`。
- 2026-06-12 13:10 CST 追加：P1 Action Evidence Spine 已补 `output/noe-action-evidence-spine/latest.json` 稳定入口，并新增 `tests/unit/noe-action-evidence-spine-report.test.js` 纳入 `npm run test:p0:unit`。当时报告 `output/noe-action-evidence-spine/action-evidence-spine-1781241000518.json` 与 `output/noe-action-evidence-spine/latest.json` 一致；目标 `f8e057fa-09cb-4e17-9872-17b07f2cd203`，7/7 action evidence 有效，`durableWorkflowReady=true`，blockers `[]`。后续 live self_learning 已推进，最新见 13:56 CST 追加。
- 2026-06-12 13:15 CST 追加：P1 thought-memory eval 已补 `output/noe-thought-memory-eval/latest.json` 稳定入口，并新增 `tests/unit/noe-thought-memory-eval-report.test.js` 纳入 `npm run test:p0:unit`。最新真实报告 `output/noe-thought-memory-eval/thought-memory-eval-1781241356477.json` 与 `output/noe-thought-memory-eval/latest.json` 一致；sampleCount `818`，avgScore `0.74`，passRate `1`，memory live queries `3/3`，conflict fixtures `3/3`，blockers `[]`。
- 2026-06-12 13:35 CST 追加：Stagehand PoC 已从 blocked 推进到 done，仍为 disabled-by-default/isolated PoC。`node scripts/noe-stagehand-poc.mjs` 使用当前 LM Studio `qwen/qwen3.6-35b-a3b`，observe 找到 Approve button，deterministic act 点击成功，extract 返回 `{"summary":"Stagehand observe act extract local smoke"}`；报告 `output/noe-ecosystem-install-2026-06-12/stagehand-poc.json`。兼容性细节：LM Studio/Qwen JSON schema 响应可能写入 `message.reasoning_content`，脚本只在 PoC client 内做 fallback，不接主链。
- 2026-06-12 13:39 CST 追加：P3 growth readiness 已补 `output/noe-growth-readiness/latest.json` 稳定入口，并增强 `tests/unit/noe-growth-readiness.test.js` 校验 latest 与 report 一致。最新真实报告 `output/noe-growth-readiness/20260612T053921Z/report.json` 与 `latest.json` 一致；sleep/reflection、dream consolidation、disabled skill candidate、automatic curriculum、self-evolution regression gate 均通过，`autonomyRegressionGate.summary.passed=198`，live DB 未变。
- 2026-06-12 13:47 CST 追加：P1 goal checkpoint workflow backfill 和 thought grounding repair 已补稳定 `latest.json` 入口，并新增隔离单测 `tests/unit/noe-goal-checkpoint-workflow-backfill-report.test.js`、`tests/unit/noe-thought-grounding-repair-report.test.js` 纳入 `npm run test:p0:unit`。真实 preview 报告 `output/noe-goal-checkpoint-workflow/goal-checkpoint-workflow-backfill-1781243227339.json` 与 `output/noe-goal-checkpoint-workflow/latest.json` 一致，扫描 checkpoint `1036`、updates `0`；`output/noe-thought-grounding-repair/thought-grounding-repair-1781243227385.json` 与 `output/noe-thought-grounding-repair/latest.json` 一致，扫描低接地待修复 `0`、repaired `0`。本次只读 preview 未新增 live DB 写入。
- 2026-06-12 13:59 CST 追加：最新最低验证已复跑：`npm run test:p0:unit` PASS，105 files / 740 tests；`npm run verify:noe:self-evolution` PASS，198/198；`npm run verify:handoff` PASS，27/27；`git diff --check -- ':!games/cartoon-apocalypse/**'` PASS。
- 2026-06-12 13:53 CST 追加：`scripts/noe-expectation-calibration-snapshot.mjs` 已增强 live 到期桶字段，避免把 `dueOpen` 误读成“已到期”。最新 `npm run verify:noe:expectation-calibration` 报告 `output/noe-expectation-calibration/2026-06-12/report.json` 与 `latest.json`：live total `26`、open `22`、openWithDueAt/dueOpen `22`、dueNowOpen/overdueOpen `0`、futureOpenWithDueAt `22`、dueWithin24h `2`、resolvedScored `4/20`、nextOpenDueAt `1781324968708`、hoursUntilNextOpenDue `22.61`、resolverActionableNow `false`。结论：当前不是 resolver 堵塞，而是没有到期待判证项，不能硬结算。
- 2026-06-12 13:56 CST 追加：Action Evidence Spine 已对齐最新 live self_learning，并修正 recovered 语义：`done` 的 act 步骤必须有成功 actionEvidence；`recovered` 的 act 步骤必须有 `step_recovered` checkpoint，不能伪装成成功动作。最新报告 `output/noe-action-evidence-spine/action-evidence-spine-1781243786322.json` 与 `latest.json`：目标 `ad49f1c9-f741-424b-a7de-b2ad2dfe4689`（`自主学习：让 Noe 的主观思考更接地，避免 echo trap`），9 step / 7 action step，actionStepsWithValidEvidence `6`、actionStepsRecovered `1`、actionStepsSatisfied `7`、blockers `[]`、rawEvidenceBlockers 保留 step 4 的三次 failed observe 尝试。
- 2026-06-12 14:10 CST 追加：文档一致性修正：本文件标题和 P0/P2 执行口径已从历史“单主脑 Gemma”改为当前三角色路由；benchmark 只保留为 manual / explicit experiment，不再要求恢复历史 Gemma 常驻，也不得把任何 benchmark 结果写回自动默认。当前自动默认以 `src/model/NoeLocalModelPolicy.js` 为准：Q35-6 主脑、Q27-4 复核、G26-4 兜底。同步修正/标注历史交接与设计材料：`docs/TASK_HANDOFF_2026-06-11_下窗口执行入口.md`、`docs/HANDOFF_2026-06-11_晚_下窗口接手.md`、`docs/HANDOFF_2026-06-11_总交接_下窗口从这里开始.md`、`docs/SYSTEM_PROMPTS_单主脑Gemma_2026-06-11.md`、`docs/DESIGN_2026-06-11_AI自我意识实现方案.md`、`docs/基准_M5Max_模型实测_2026-06-11.md`。验证：`npm run verify:handoff` PASS 27/27，`npm run test:p0:unit` PASS 105 files / 740 tests，`git diff --check -- ':!games/cartoon-apocalypse/**'` PASS。
- 2026-06-12 14:23 CST 追加：根入口规则已收敛到当前硬边界和三角色模型路由。`AGENTS.md`、`CLAUDE.md` 不再写“硬边界作废 / 可读取密钥 / 自动 commit / 可触碰 51735”作为当前规则；明确不读 `.env`/token/cookie/OAuth/`room-adapters.json` secret 原值，不触碰 `51735`，`51835` 只在必要 live 验证/恢复时记录证据后处理，不 commit/push/reset/clean，模型策略指向 Q35-6 Main、Q27-4 Review、G26-4 Fallback。`AGENTS.md` 接手必读已把 2026-06-12 handoff、三角色模型执行记录、P0/P1/Noe100 执行记录和 Noe100 matrix 放到前五。`scripts/noe-handoff-consistency.mjs` 已把这些变成自动门禁，并新增当前 handoff、三角色模型执行记录、Noe100 matrix 检查；`npm run verify:handoff` 现在 PASS 40/40，`node --check scripts/noe-handoff-consistency.mjs` PASS，`npm run test:p0:unit` PASS 105 files / 740 tests，`git diff --check -- ':!games/cartoon-apocalypse/**'` PASS。
- 2026-06-12 14:36 CST 追加：verifier owner-token 边界已收敛。`scripts/noe-full-current-verify.mjs` 默认不跑 live `phase5` 或 cognitive owner-token 路径；只有显式 `--include-live` / `--include-cognitive-live` 并同时 `--ack-read-owner-token` 才进入 live token 验证。`scripts/noe-phase5-runtime-verify.mjs`、`scripts/noe-cognitive-verify.mjs`、`scripts/noe-cognitive-runtime-verify.mjs`、`scripts/noe-real-use-replay.mjs` live 默认只写 policy-blocked report，不读取 owner-token、不访问 live panel、不输出 secret。policy 证据：`output/noe-phase5-runtime/phase5-runtime-1781246058361.json`、`output/noe-real-use-replay/real-use-replay-1781246058388.json`、`output/noe-cognitive-verify/cognitive-verify-1781246058622.json`、`output/noe-cognitive-runtime/cognitive-runtime-1781246058633.json`，均 `tokenPolicy.policyBlocked=true`、`secretValueReturned=false`。安全 full-current 已过：`npm run verify:noe:full-current -- --include-managed` PASS，报告 `output/noe-full-current/full-current-1781246085004.json`，11/11，`includeLive=false`、`includeCognitiveLive=false`。最低验证复跑：`npm run verify:handoff` PASS 45/45；`npm run test:p0:unit` PASS 105 files / 740 tests；`npm run verify:noe:self-evolution` PASS 198/198；`git diff --check -- ':!games/cartoon-apocalypse/**'` PASS。
- 2026-06-12 14:36-14:40 CST 状态校正：本轮 verifier 修复未重启/接管 `51835`；当前只读 `lsof -nP -iTCP:51835 -sTCP:LISTEN` 无监听进程。`51735` 仍只观察，PID `4773`。另一个 `scripts/noe-qwen36-8bit-benchmark.mjs`（父 PID `53196`）正在推进 8bit benchmark，并通过子进程 `scripts/noe-main-brain-candidate-benchmark.mjs --loaded-only --ack-manual-benchmark ...` 改变 LM Studio loaded model；最终只读快照显示 `lms ps` 为 `bench-qwen36-27b-8bit` / `qwen/qwen3.6-27b@8bit` `GENERATING`，子进程 PID `73499`、参数 `--model bench-qwen36-27b-8bit --seed 43`。该 LM Studio loaded-model 漂移不是本轮 verifier 修复发出的 load/unload；未 kill、未 unload，后续以最新 `lms ps` 为准。
- 2026-06-12 14:49 CST 追加：剩余 live verifier token gate 已补齐。`scripts/noe-freedom-live-smoke.mjs`、`scripts/noe-capture-external-evidence.mjs`、`scripts/noe-voice-ear-acceptance.mjs`、`scripts/noe-social-dom-live-probe.mjs` 默认也不读 owner-token；无 `--ack-read-owner-token` 时只写 policy-blocked report，`secretValueReturned=false` / `ownerTokenPrinted=false`。`scripts/noe-handoff-consistency.mjs` 已纳入这些断言，`npm run verify:handoff` PASS 49/49。当前 `51835` 已在线但本轮没有重启/接管：PID `89417`，cwd `/Users/hxx/Desktop/Neo 贾维斯`，命令 `/Users/hxx/.nvm/versions/node/v22.22.2/bin/node server.js`；public `/health` 200，public `/api/noe/readiness` 200/passed。`lms ps` 回到 `qwen/qwen3.6-35b-a3b` / `qwen/qwen3.6-35b-a3b@6bit` IDLE，context `262144`，parallel `1`；8bit benchmark 进程已不在进程表。
- 2026-06-12 14:49 CST 最新只读日报：`npm run verify:noe:model-health` PASS，报告 `output/noe-model-health/model-health-1781246930282.json`，loadedModels `["qwen/qwen3.6-35b-a3b"]`，Ollama reachable，MiniMax/Xiaomi reachable，Gemini/OpenAI/Anthropic unconfigured；`npm run verify:noe:soak-snapshot` PASS，报告 `output/noe-soak-daily/2026-06-12/report.json`，Noe100 刷新到 `output/noe-100-readiness/noe-100-readiness-1781246930421.json`；`npm run verify:noe:expectation-calibration` PASS，live resolved `4/20`、dueNowOpen `0`、hoursUntilNextOpenDue `21.68`；`npm run verify:noe:100-readiness` 诚实返回 `score=97`、`passed=false`、唯一 blocker `not_enough_soak_evidence`，最新报告 `output/noe-100-readiness/noe-100-readiness-1781246930332.json`。最新最低验证：`npm run verify:noe:full-current -- --include-managed` PASS 11/11，报告 `output/noe-full-current/full-current-1781246962402.json`；`npm run test:p0:unit` PASS 105 files / 740 tests；`npm run verify:noe:self-evolution` PASS 198/198；`npm run verify:handoff` PASS 49/49；`git diff --check -- ':!games/cartoon-apocalypse/**'` PASS。
- 2026-06-12 14:58 CST 追加：非 verifier 的剩余 owner-token 读取入口也已收敛。`scripts/restart-panel.mjs` 默认 policy-blocked，不带 `--ack-read-owner-token` / `NOE_ACK_READ_OWNER_TOKEN=1` 时不读 token、不重启、不调用 protected API；`node scripts/restart-panel.mjs --check-only` 预期 exit 2，报告 `tokenPolicy.policyBlocked=true`、`secretValueReturned=false`。`scripts/perf-check.mjs` 默认不读 token，公开资源 200、protected API 401；owner 本轮明确授权后 `node scripts/perf-check.mjs --ack-read-owner-token` protected API 均 200，输出无 secret 原值。Raw e2e：`tests/e2e/noe-brain-ui-p0.e2e.mjs`、`tests/e2e/noe-freedom-stage-summary.e2e.mjs`、`tests/e2e/panel-ui-walkthrough.mjs` 默认只接受 `OWNER_TOKEN` 注入；直接读 live token 必须显式 `--ack-read-owner-token`，裸跑保留端口 `51735/51835` 必须 `NOE_E2E_ALLOW_RESERVED_PORT=1`。`scripts/noe-handoff-consistency.mjs` 新增门禁，`node --check` 对相关脚本已通过。剩余读取点说明：`scripts/e2e-with-server.mjs` / `ce12-*` 读取隔离 HOME 的测试 token；`scripts/打开面板.command` 是用户显式打开面板 launcher，本轮未运行、未输出 token。
- 2026-06-12 15:03 CST 追加：本轮最终验证已过。`npm run verify:handoff` PASS 52/52；`npm run test:p0:unit` PASS 105 files / 740 tests；`npm run verify:noe:self-evolution` PASS 198/198；`git diff --check -- ':!games/cartoon-apocalypse/**'` PASS。隔离 e2e：`node scripts/e2e-with-server.mjs` 随机端口 `64460` PASS 18/18 且端口清理；`npm run test:e2e:freedom-stage` 随机端口 `64522` PASS 21/21 且端口清理。三个 raw e2e 默认直连 `51835` 均拒绝并 exit 1，证明不会误打 live；`panel-ui-walkthrough` 不能通过 `e2e-with-server` 包装是既有 wrapper 目标格式限制（只接受 `tests/e2e/<name>.e2e.mjs`），本轮没有强行改 wrapper。
- 2026-06-12 15:06 CST 追加：live `51835` 恢复。只读端口检查发现 `51835` 一度无监听；owner 明确授权后执行 `PANEL_RESTART_FORCE_DIRECT=1 node scripts/restart-panel.mjs --repair --ack-read-owner-token`，direct repair 启动 PID `61331`，cwd `/Users/hxx/Desktop/Neo 贾维斯`，cluster health/readiness passed，warnings `[]`。public `/health` 200，public `/api/noe/readiness` 200/passed，counts memoryVisible `512`、focusDepth `4`、total `9`、enabled `9`、pendingApprovals `50`、pendingActs `0`。`npm run verify:noe:freedom-live -- --ack-read-owner-token` PASS 5/5；`npm run verify:noe:full-current -- --include-managed` PASS 11/11，报告 `output/noe-full-current/full-current-1781247955718.json`；`npm run verify:noe:model-health` PASS，报告 `output/noe-model-health/model-health-1781247955880.json`，loadedModels `["qwen/qwen3.6-35b-a3b"]`，`lmStudioLoadUnloadChanged=false`；`npm run verify:noe:100-readiness` 仍 `score=97`、`passed=false`，唯一 blocker `not_enough_soak_evidence`，报告 `output/noe-100-readiness/noe-100-readiness-1781247983851.json`。`51735` 只读观察 PID `4773`，未触碰。
- 2026-06-12 06:09 UTC / 14:09 CST 后续刷新：只读 P2 日报证据已复跑。`npm run verify:noe:model-health` PASS，报告 `output/noe-model-health/model-health-1781244538774.json`，LM Studio loadedModels 只有 `qwen/qwen3.6-35b-a3b`，`lmStudioLoadUnloadChanged=false`、`secretValuesReturned=false`；MiniMax/Xiaomi reachable，Ollama `fetch failed`，Gemini/OpenAI/Anthropic `secret_unconfigured`。`npm run verify:noe:soak-snapshot` PASS，报告 `output/noe-soak-daily/2026-06-12/report.json`，Noe100 刷新到 `output/noe-100-readiness/noe-100-readiness-1781244549302.json`，仍 `score=97`、`passed=false`、activeDays `3/7`、blocker `not_enough_soak_evidence`。`npm run verify:noe:expectation-calibration` PASS，报告 `output/noe-expectation-calibration/2026-06-12/report.json`，live resolved `4/20`、dueNowOpen `0`、hoursUntilNextOpenDue `22.34`。本次只读刷新未触碰 `51735`/`51835`，未改变 LM Studio loaded models。
- 已刷新长期证明日报：`npm run verify:noe:100-readiness` 最新报告 `output/noe-100-readiness/noe-100-readiness-1781244549302.json`，`latest.json` 同步写入，仍 `score=97`、36/37、唯一 blocker `not_enough_soak_evidence`；`npm run verify:noe:soak-snapshot` 最新报告 `output/noe-soak-daily/2026-06-12/report.json`，activeDays `3/7`；`npm run verify:noe:expectation-calibration` 最新报告 `output/noe-expectation-calibration/2026-06-12/report.json`，live resolved `4/20`，且当前 dueNowOpen `0`。
- P0 五项已闭环，当前证据见 `docs/EXECUTION_RECORD_2026-06-12_P0_P1_Gemma_NoE100.md`。
- `51835` 历史已 direct restart 到真实仓库。P0 早前核验 PID `8570`；P2 runtime restart recovery drill 曾到 PID `55627`；mind proof 上线后 runtime restart recovery drill 核验 PID `52411`；生态工具验证后曾只读观察为 PID `36587`。2026-06-12 14:49 CST 最新只读观察：PID `89417`，cwd `/Users/hxx/Desktop/Neo 贾维斯`，public health/readiness 通过；受保护 freedom-live 需要 `--ack-read-owner-token` 才可运行。
- `51735` 只观察未重启，PID `4773`，cwd `/Users/hxx/Desktop/00_项目/05_Claude可视化面板`。
- P1 已新增并验证：Noe100 readiness、Action Evidence Spine、goal/action checkpoint workflow、thought-memory eval、mind panel `100% proof` 区块。
- P2 已新增并执行受控真实副作用 + rollback 样本：`npm run verify:noe:side-effect-drill -- --apply`，报告 `output/noe-controlled-side-effect-drill/20260612T010417Z/report.json`，证明本地文件写入、hash verified、删除回滚、artifact absent、actionEvidence validation ok；这不是社交平台/公网发布样本。
- P2 已新增并执行 model health 只读快照：`npm run verify:noe:model-health`，最新报告 `output/noe-model-health/model-health-1781244538774.json`，同步入口 `output/noe-model-health/latest.json`。LM Studio `/v1/models` loadedModels 为 `qwen/qwen3.6-35b-a3b`，未输出 secret 原值，未 load/unload。MiniMax/Xiaomi configured 且 reachable/authOk；Gemini/OpenAI/Anthropic secret_unconfigured；Ollama 当前 `fetch failed`。
- P2 已新增并执行受控 expectation settlement drill：`npm run verify:noe:expectation-settlement-drill`，报告 `output/noe-expectation-settlement-drill/20260612T012857Z/report.json`，隔离 SQLite `sampleCount=20/resolvedCount=20/unresolvedCount=0`，Brier `0.117`，`liveDbMutated=false`。单测已改用临时输出目录。
- P2 继续补齐 live expectation 长期校准日报：新增 `scripts/noe-expectation-calibration-snapshot.mjs` 和 `npm run verify:noe:expectation-calibration`。已执行并写入 `output/noe-expectation-calibration/2026-06-12/report.json`、`output/noe-expectation-calibration/latest.json`；脚本只读扫描 live `noe_expectations`，不写 DB、不调用模型、不读 owner token、不输出 claim 正文、不改变 LM Studio。当前 live total `26`、open `22`、openWithDueAt/dueOpen `22`、dueNowOpen/overdueOpen `0`、futureOpenWithDueAt `22`、dueWithin24h `2`、dueWithin7d `22`、resolvedScored `4/20`、Brier `0.038125`、nextOpenDueAt `1781324968708`、hoursUntilNextOpenDue `22.61`、resolverActionableNow `false`；controlledMechanismReady `true`，但 liveCalibrationReady `false`，blocker `live_expectation_resolved_below_20`。
- P2 已新增并执行受控 `model_unloaded` 恢复 drill：`npm run verify:noe:model-unload-recovery-drill`，报告 `output/noe-model-unload-recovery-drill/20260612T012857Z/report.json`，fake provider 触发 `model_unloaded`，backup participant 接管并 quorum ok，LM Studio loaded models 前后一致；没有真实 `lms unload/load`。Noe100 只接受真实 LM Studio 快照来源，跳过单测 fake snapshot。
- P2 已新增并执行真实 `51835` runtime restart recovery drill：`npm run verify:noe:runtime-restart-drill -- --apply`，最新历史报告 `output/noe-runtime-restart-recovery-drill/20260612T021744Z/report.json`。旧 PID `55627` SIGTERM 后退出，新 PID `52411` direct Node22 restart，cwd 为真实仓库；`51735` PID/cwd 前后一致，LM Studio loadedModels 前后一致，均为 `benchv4-gemma-4-26b-a4b-qat-4bit` 与 `gemma-4-26b-a4b-it-qat-mlx`。注意：这是历史 restart drill 证据，不代表 14:36 CST 当前 `51835` 仍在线。
- P2 已新增并执行隔离 act failure / approval wait recovery drill：`npm run verify:noe:act-recovery-drill`，报告 `output/noe-act-recovery-drill/20260612T015219Z/report.json`。failed act 首次 `failed`，重启模拟后 retry 到 `completed`，只产生 1 条执行证据；approval wait 跨重启保持同一 approval，批准前 executorCalls `0`，批准后只执行 1 次；live DB 未变。
- P3 已新增并执行 growth readiness proof：`npm run verify:noe:growth-readiness`，最新报告 `output/noe-growth-readiness/20260612T053921Z/report.json`，稳定入口 `output/noe-growth-readiness/latest.json`。sleep/reflection、dream consolidation、disabled skill candidate、automatic curriculum、self-evolution regression gate 均通过；live DB 未变，不替代 7 天 soak。
- P2 继续补齐 7 天 soak 的“日报证据”入口：新增 `scripts/noe-soak-daily-snapshot.mjs` 和 `npm run verify:noe:soak-snapshot`。已执行并写入 `output/noe-soak-daily/2026-06-12/report.json`、`output/noe-soak-daily/latest.json`；脚本刷新 Noe100、采样 live `/health`/`/api/noe/readiness`，但 `readOnly=true`、`noDbWrites=true`、`noModelCalls=true`、`lmStudioLoadUnloadChanged=false`、`doesNotBypassSoak=true`。当前 soak 仍为 `pending`，activeDays `3/7`，daysRemaining `4`，blocker `not_enough_soak_evidence`。
- P3 继续补齐人格 SFT/LoRA 数据积累证明：新增 `scripts/noe-personality-dataset-readiness.mjs` 和 `npm run verify:noe:personality-dataset`。已执行并写入 `output/noe-personality-dataset-readiness/personality-dataset-readiness-1781232973321.json`、`output/noe-personality-dataset-readiness/latest.json`；脚本只读扫描 SFT JSONL、SQLite 记忆/事件计数、owner/person 身份样本计数、人格/叙事快照和 LoRA 工具链，`noTrainingStarted=true`、`noModelCalls=true`、`noDatasetTextOutput=true`、`lmStudioLoadUnloadChanged=false`。当前 SFT 有效训练对 `100/500`，invalid `0`，sensitive `0`，smokeDatasetReady `true`，formalDatasetReady `false`，blockers 为 `not_enough_sft_pairs_for_formal_training`、`owner_training_plan_required`；旧 gate report `gate-report-2026-06-10.json` 仍 FAIL `2/12`，所以不得训练/采用。
- benchmark 脚本新增 `--loaded-only` 手动模式：仍要求 `--ack-manual-benchmark`，但只调用当前已 loaded 模型，不执行 `lms unload/load`、SDK `llm.load()`、SDK `model.unload()` 或恢复加载。历史已执行 Gemma loaded-only smoke benchmark，报告 `output/main-brain-candidate-benchmark-20260612/20260612T030810Z/results.json`：21 tasks，quality `72/82` (`87.8%`)，score `89.6`，speed `87.7 tok/s`，JSON `21/21`，errors `0`；loaded 前后均为 `gemma-4-26b-a4b-it-qat-mlx`，未改变 LM Studio loaded models。该报告只说明当时已加载 Gemma 的 no-load smoke，不代表当前默认；当前默认是 Q35-6 主脑。
- Action Evidence Spine 已复跑并对齐最新 self_learning：`npm run verify:noe:action-evidence-spine` 报告 `output/noe-action-evidence-spine/action-evidence-spine-1781243786322.json`，目标 `ad49f1c9-f741-424b-a7de-b2ad2dfe4689`，标题 `自主学习：让 Noe 的主观思考更接地，避免 echo trap`，9 step，7 个 act step 中 6 个成功 action evidence、1 个 recovered step 有恢复 checkpoint，`actionStepsSatisfied=7`，blockers `[]`。
- mind panel proof 已落地：`GET /api/noe/mind/proof` 返回 score/blockers/last tick/last thought/last action/last recovery；live 验证 200，score `97`。当前最新 Noe100 reportPath 为 `output/noe-100-readiness/noe-100-readiness-1781243686431.json`，并有 `output/noe-100-readiness/latest.json`。`/mind.html` 浏览器验证 proof 区块可见，console errors `[]`，390px 视口无横向溢出。
- `NoeSelfKnowledge` verified/declared 已落地：能力对象有 `status: verified|declared` 和 evidenceRefs；prompt 行前缀 `[verified]`/`[declared]`，verified 只来自 Noe100/growth smoke/eval/live 证据，未烟测的 voiceprint/face/voice 等能力保持 declared。`buildNoeSelfKnowledgeBlock()` 长度 `3958`，不含 `output/noe-` 路径。
- `verify:noe:100-readiness` 最新报告见 `output/noe-100-readiness/latest.json`：`score=94`、`passed=false`、`readyFor100=false`，35/37 checks passed，真实 blockers 是 `not_enough_soak_evidence`（activeDays `3` / requiredDays `7`）和 `expectation_settlements_below_20`（natural live resolved `4/20`；controlled drill `20/20` 只证明机制）。
- 最新完成 self_learning 目标以 Action Evidence Spine 最新稳定入口为准：`ad49f1c9-f741-424b-a7de-b2ad2dfe4689`（`自主学习：让 Noe 的主观思考更接地，避免 echo trap`），9 step / 7 action step，6 个成功 action evidence + 1 个 recovered step，`actionStepsSatisfied=7`。
- 本次 P2/P3/mind proof/self-knowledge/soak/personality dataset/expectation calibration/loaded-only benchmark/verifier token gate 变更后定向验证已通过：expectation/model/runtime/act recovery/growth/mind proof/self-knowledge/soak/personality 相关单测已通过，`verify:noe:model-health` PASS，`verify:noe:expectation-calibration` PASS 但 live 未 ready，`verify:noe:100-readiness` PASS 但非 100，`verify:noe:soak-snapshot` PASS，`verify:noe:action-evidence-spine` PASS，loaded-only benchmark PASS 且 loaded 前后一致，`GET /api/noe/mind/proof` 历史 PASS。最新最低验证已复跑：`npm run verify:noe:full-current -- --include-managed` PASS 11/11，`npm run test:p0:unit` PASS 105 files / 740 tests，`npm run verify:noe:self-evolution` PASS 198/198，`npm run verify:handoff` PASS 49/49，`git diff --check -- ':!games/cartoon-apocalypse/**'` PASS。`verify:noe:freedom-live` 当前默认 policy-blocked；要跑受保护 dry-run 必须显式 `--ack-read-owner-token`。

## 0. 当前结论

- 真实仓库：`/Users/hxx/Desktop/Neo 贾维斯`。
- 最新模型架构代码已由 `145e642 本地模型: 收敛单主脑 Gemma` 之后的工作区改动覆盖；当前执行记录见 `docs/EXECUTION_RECORD_2026-06-12_三角色本地模型路由.md`。
- Main Brain / 默认对话 / 自动思考 / 内心反刍 / 深思审议 / 期望判证 / 视觉默认：`qwen/qwen3.6-35b-a3b`，load key `qwen/qwen3.6-35b-a3b@6bit`。
- Review Brain：`qwen/qwen3.6-27b`，load key `qwen/qwen3.6-27b@4bit`，只按需用于高风险行动、长期记忆冲突、身份/偏好写入、自我进化落代码等复核。
- Fallback Brain：`gemma-4-26b-a4b-it-qat-mlx`，仅低风险 degraded fallback；不要让它承担高风险最终决策。
- 截至最新执行更新：本轮 verifier/live 复核没有重启/接管 `51835`；当前只读观察 `51835` PID `89417`，cwd `/Users/hxx/Desktop/Neo 贾维斯`，public `/health` 和 `/api/noe/readiness` 通过。`51735` 未重启，仍为 PID `4773`。本轮没有执行 `lms load/unload`；当前 `lms ps` 为 Q35-6 6bit IDLE。

## 1. 接手后 60 秒先确认

```bash
cd "/Users/hxx/Desktop/Neo 贾维斯"
pwd
git rev-parse --show-toplevel
git status --short --untracked-files=all
git log -5 --oneline
```

当前已知工作树以 `git status --short --untracked-files=all` 为准。已知包含：

- 多个 server/src/public/tests 变更来自本轮质量修复和前序阶段二。
- 新增/修改 P0/P1 证据文件：`docs/EXECUTION_RECORD_2026-06-12_P0_P1_Gemma_NoE100.md`、本文件、`docs/NOE_100_ACCEPTANCE_MATRIX.md`。
- 新增/修改 P1/P2/P3 脚本：`scripts/noe-100-readiness.mjs`、`scripts/noe-action-evidence-spine.mjs`、`scripts/noe-goal-checkpoint-workflow-backfill.mjs`、`scripts/noe-thought-grounding-repair.mjs`、`scripts/noe-thought-memory-eval.mjs`、`scripts/noe-controlled-side-effect-drill.mjs`、`scripts/noe-model-health-snapshot.mjs`、`scripts/noe-runtime-restart-recovery-drill.mjs`、`scripts/noe-act-recovery-drill.mjs`、`scripts/noe-growth-readiness.mjs`、`scripts/noe-soak-daily-snapshot.mjs`、`scripts/noe-personality-dataset-readiness.mjs`、`scripts/noe-expectation-calibration-snapshot.mjs`。
- 新增/修改 P1 report writer 单测：`tests/unit/noe-goal-checkpoint-workflow-backfill-report.test.js`、`tests/unit/noe-thought-grounding-repair-report.test.js`，保证 checkpoint workflow / thought grounding repair 都写 timestamp report 与 `latest.json`。
- mind proof / self-knowledge 新增/修改：`src/server/routes/noeMind.js`、`public/mind.html`、`public/mind.css`、`public/mind.js`、`tests/unit/routes/noe-mind-routes.test.js`、`src/context/NoeSelfKnowledge.js`、`tests/unit/noe-chat-profile-selfknowledge.test.js`。
- benchmark 脚本已裁决为 manual benchmark / explicit experiment；新增 `--loaded-only` no-load 模式可在不改变 LM Studio loaded models 的情况下跑当前主脑 smoke benchmark；不要把 Qwen benchmark 结果写回自动默认。

## 2. 必读顺序

1. `AGENTS.md`
2. `CLAUDE.md`
3. `docs/TASK_HANDOFF_2026-06-11_下窗口执行入口.md`
4. `docs/HANDOFF_2026-06-11_晚_下窗口接手.md`
5. `docs/HANDOFF_2026-06-12_单主脑Gemma收敛后续计划.md`
6. `docs/阶段研究_主观意识100可证明路线图_2026-06-11.md` 的 0、1、3、6、7、8、10 节

长材料使用方式：

- `阶段研究_主观意识100可证明路线图_2026-06-11.md` 是 Noe100 长期路线，不是当前 P0 任务清单。
- `docs/SYSTEM_PROMPTS_单主脑Gemma_2026-06-11.md` 是历史口径；当前系统提示词以 `src/model/NoeLocalModelPolicy.js` 和 `docs/EXECUTION_RECORD_2026-06-12_三角色本地模型路由.md` 为准。
- `docs/基准_M5Max_模型实测_2026-06-11.*` 是历史 benchmark 证据；当前最终 benchmark 结论为 Q35-6 主脑、Q27-4 复核、G26-4 兜底。

## 3. 已落地与已验证

已落地要点：

- `src/model/NoeLocalModelPolicy.js` 统一三角色：Q35-6 主脑、Q27-4 复核、G26-4 兜底，并定义分层 `max_tokens` 预算。
- `src/room/LmStudioLoader.js` 区分 API model id 与 LM Studio load key：Q35-6 用 `qwen/qwen3.6-35b-a3b@6bit` 加载并暴露 `qwen/qwen3.6-35b-a3b`。
- `src/room/OpenAICompatChatAdapter.js` 遇到 `finish_reason=length` 标记 `truncated/incomplete/continuationRequired`。
- `src/vision/LocalVlmClient.js` 视觉默认走 Q35-6；Gemma 只作为 degraded fallback 或显式实验入口。
- `InnerMonologue`、`NoeDeliberation`、`NoeExpectationResolver`、`NoeNightlyReflection`、`NoeMoodAnalyzer`、`NoeNarrativeSelf`、`NoePersonalitySnapshot` 等自动认知路径接入 Q35-6 主脑和分层预算，截断结果不写入长期状态。

已通过验证：

```bash
npm test -- tests/unit/noe-reflect-brain.test.js tests/unit/lmstudio-chat-adapter.test.js tests/unit/local-vlm-client.test.js tests/unit/noe-nightly-reflection.test.js tests/unit/noe-expectation-resolver.test.js tests/unit/noe-inner-monologue.test.js tests/unit/noe-local-model-council.test.js tests/unit/lmstudio-loader.test.js
# 8 files / 90 tests passed

npm run test:p0:unit
# 最新 105 files / 740 tests passed

npm run verify:handoff
# 45/45 passed

git diff --check -- ':!games/cartoon-apocalypse/**'
# passed
```

后续若改模型/自动认知，必须重跑相关定向测试、`test:p0:unit`、`verify:handoff`、`git diff --check`。

## 4. 当前风险

1. **Noe100 不是已完成**：统一证明门已落地并可重复运行，但最新 `score=94`、`passed=false`，不得说 Noe 已 100%。
2. **时间 blocker 仍真实存在**：activeDays=3 未满足 7 天 soak；不要为了过门篡改 SQLite。
3. **受控本地副作用不等于社交发布**：`verify:noe:side-effect-drill` 只证明本地真实副作用 + rollback 证据链，不证明公网/社交平台发布与删除。
4. **受控 fake provider 不等于真实 LM Studio unload/load**：`verify:noe:model-unload-recovery-drill` 证明 `model_unloaded` 错误分类、backup participant、quorum 恢复和 loaded state 未变，不证明真实 `lms unload/load`。
5. **live expectation natural resolved 仍是 4/20**：受控隔离 drill 证明结算机制；Noe100 readiness 不再把 controlled drill 算作长期 live 校准。
6. **工作树仍是 dirty**：未 stage、未 commit、未 push、未 reset；下个窗口继续时必须先 `git status`，不要回滚无关改动。
7. **live 数据会继续变化或暂时不可用**：`51835` 可能不在监听；新的 tick/goal/event/model-health 也可能让报告计数或 loaded snapshot 漂移。以最新 `lsof`、API 和重跑报告为准，不能假定旧 PID 仍有效。

## 5. 优先级总计划

### P0：现实运行态和三角色模型不漂移

1. 处理 `scripts/noe-main-brain-candidate-benchmark.mjs`：
   ```bash
   sed -n '1,220p' scripts/noe-main-brain-candidate-benchmark.mjs
   rg -n "qwen|Qwen|Gemma|load|unload|restore|NOE_MAIN_BRAIN|LMSTUDIO|lms|loaded" scripts/noe-main-brain-candidate-benchmark.mjs
   ```
   临时/危险就删除；保留则必须改成 manual benchmark / explicit experiment；不得默认卸载/加载当前 LM Studio 模型，不得把 benchmark 结果写回自动默认。当前自动默认只由 `src/model/NoeLocalModelPolicy.js` 决定：Q35-6 主脑、Q27-4 复核、G26-4 兜底。
2. 恢复并验证 live `51835`，确认 cwd 是真实仓库，`/health`、`/api/noe/readiness`、`verify:noe:freedom-live` 通过，`51735` 未触碰。
3. 验证 `self_learning` 自主链路：`research / macos.app.activate / browser.open_url / browser.state_probe / browser.observe_page / visual.action.plan / shell.exec / noe.note.write / think`。
4. 复验知识库 / 联网学习端到端：本地 Wiki、联网 search/research、项目 `rg` evidence 分开记录。
5. 检查环境自动模型变量：`NOE_REFLECT_MODEL`、`NOE_INNER_MODEL`、`NOE_VLM_MODEL`、`NOE_VLM_FALLBACK_MODEL`、`NOE_REFLECTION_MODEL`、`NOE_FACT_MODEL`、`NOE_LMSTUDIO_MODEL`。

P0 质量门：

- benchmark 脚本处理后必须给出裁决：删除 / 保留为 manual benchmark / 改名隔离；并用 `rg -n "NOE_MAIN_BRAIN_MODEL|NOE_REVIEW_BRAIN_MODEL|NOE_FALLBACK_BRAIN_MODEL|DEFAULT_REFLECT_MODEL|NOE_REFLECT_MODEL|LMSTUDIO"` 证明自动默认仍收敛到三角色路由，而不是散落在 benchmark 脚本里。
- live `51835` 完成后必须记录 PID、进程 cwd、启动方式、`/health`、`/api/noe/readiness`、`verify:noe:freedom-live` 结果；若失败，记录失败 API、状态码、日志片段和下一步。
- `self_learning` 完成后必须记录目标 ID、每个 step 的状态、关键 evidenceRefs；不能只写“链路看起来可用”。
- 知识库 / 联网学习完成后必须至少证明三类 evidence：本地 wiki 命中、联网 search/research 命中、项目代码 `rg` 命中；三类不能混写成一个结论。
- 模型变量检查完成后只报告“来源、是否设置、是否覆盖三角色默认、是否已修正”，不要把 secret 原值写入 handoff、日志或 git。
- P0 全部通过前不要开始大规模 P1/P2；如果某个 P0 卡住，按 §9 规则排查三轮并留下 blocker，然后继续下一个独立 P0。

### P1：Noe100 统一证明门

1. 新增 `docs/NOE_100_ACCEPTANCE_MATRIX.md`：七维目标、指标、数据源、验证命令、阈值、失败下一步。
2. 新增 `scripts/noe-100-readiness.mjs` 和 `npm run verify:noe:100-readiness`。
3. 最低汇总：survival / thinking / acting / reflection / stability / observability / recoverability 七维 score、blockers、evidenceRefs。
4. 没有 7-14 天 soak 数据时必须明确失败为 `not_enough_soak_evidence`，不能给假 100。

P1 质量门：

- `NOE_100_ACCEPTANCE_MATRIX.md` 不能只写愿景；每个维度必须有指标、数据源、验证命令、通过阈值、失败下一步。
- `verify:noe:100-readiness` 必须可重复运行，输出 JSON summary，包含 score、passed、failed、blockers、evidenceRefs。
- 当前不能证明 100% 时，脚本必须失败或给出非 100 分，不能用口号补齐缺失证据。
- Action Evidence Spine 必须落到真实数据结构或日志，不接受只写文档。
- 思考接地和记忆评测至少要有 fixture 或测试样例，避免只新增空壳指标。

每轮交付格式：

```text
完成项：
改动文件：
验证命令与结果：
live/模型/端口是否触碰：
剩余 blocker：
下一步：
```

下个窗口连续工作时，宁可少做几个项，也要每个项有证据闭环。

### P1：可恢复行动和证据主干

1. goal/action step 增加 checkpoint、idempotency key、side-effect fingerprint、rollback evidence。
2. research/act/deep deliberation 异步分支写 started/settled/error/evidence，避免 fire-and-forget。
3. research、browser/macOS act、shell 诊断、social/upload/delete、memory writeback 统一写 Activity/ledger。
4. mind panel `100% proof` 区块已完成：score、blockers、last tick、last thought、last action、last recovery。

### P1：思考接地与记忆评测

1. thought groundedness、echo trap、重复率、真实事件引用率进入 readiness。
2. expectation settlement、Brier、oldest due、unknown ratio 进入 readiness。
3. memory conflict fixtures 覆盖偏好变化、错误纠正、历史事实、项目事实、短期承诺。
4. `NoeSelfKnowledge` 已只把通过 smoke/eval/live 证据的能力标记为 `verified`，未验证显示 `declared`。

### P2/P3：长期证明和成长层

- P2：model health daily、provider unavailable 诚实记录、7 天 soak、live expectation calibration、act failure/approval wait 演练。真实 `51835` kill/restart drill 已完成；`model_unloaded` no-state-change fake provider drill 已完成；act failure / approval wait 隔离恢复演练已完成；7 天 soak 日报快照入口 `npm run verify:noe:soak-snapshot` 已完成，当前只记录 day 1/activeDays 3，不绕过时间 blocker；live expectation calibration 快照入口 `npm run verify:noe:expectation-calibration` 已完成，当前 live resolved 4/20，不把 controlled drill 冒充长期校准；真实 `lms unload/load` 只有 owner 明确允许改变 loaded models 时再做。
- P2：工具/MCP 接入只选能补证明链的本地、只读、可审计工具；每个工具必须有 `TOOL_ADOPTION_RECORD`。
- P3：sleep-time pipeline、skill library、automatic curriculum、self-evolution autonomy regression gate 已有隔离 growth readiness proof；LoRA/SFT 人格数据 readiness 已有只读证明入口 `npm run verify:noe:personality-dataset`，当前 100/500 对、smoke ready、formal training blocked，仍需长期数据与 owner 明确训练计划，不能用本地 fixture 冒充。

## 6. live `51835` 恢复验收命令

```bash
cd "/Users/hxx/Desktop/Neo 贾维斯"
git status --short --untracked-files=all
lsof -nP -iTCP:51835 -sTCP:LISTEN || true
launchctl print gui/$(id -u)/com.noe.panel | head -120
```

若 `51835` 未监听，按真实 launchd 配置恢复：

```bash
launchctl kickstart -k gui/$(id -u)/com.noe.panel
```

若 label 不存在或 kickstart 失败，先查配置，不要盲目开第二个服务：

```bash
rg -n "com.noe.panel|51835|NOE_AUTONOMY_PROFILE|NOE_AUTONOMOUS_LEARNING|NOE_GOAL_ACT" . ~/Library/LaunchAgents ~/.config 2>/dev/null
```

启动后验收：

```bash
curl -fsS http://127.0.0.1:51835/health
curl -fsS http://127.0.0.1:51835/api/noe/readiness
npm run verify:noe:freedom-live
```

验收报告必须写：PID、cwd、health/readiness、是否重启、是否触碰 `51735`、owner-token API 是否通过、自主学习目标 ID 和步骤状态。

## 7. M5 Max / 质量优化执行原则

原提示词“M5 Max 硬件最大化利用 + 全维度质量优化 + 每项性能数据”方向正确但太宽。执行时按轮次推进：

- 每轮选择 1-3 个最高 ROI、能完成并验证的 P0/P1 小切口；完成验证和收尾后继续下一轮。
- 硬件优化聚焦 Neo 真实瓶颈：Q35-6 主脑调用、Q27-4 复核按需加载、Gemma fallback degraded 路径、LM Studio loaded model 漂移、Node 同步阻塞、SQLite/JSON 写入、Activity/ledger 膨胀、浏览器/macOS act 失败恢复、launchd/live `51835` 稳定性。
- 所有提升必须有命令、测试、benchmark、日志或 live evidence；不可测的写“未测量”，不得编造百分比。

最低验证：

```bash
npm run test:p0:unit
npm run verify:handoff
git diff --check -- ':!games/cartoon-apocalypse/**'
```

涉及模型/自动认知/live 时再补定向单测和 `npm run verify:noe:freedom-live`。

## 8. 不要做

- 不要重新发明“双脑”方案。
- 不要说 Noe 当前已经 100%。
- 不要再重复搜 100 个项目；路线图已有 130+ 项和工具雷达，下一步是转成验收门。
- 不要重写到 LangGraph/Letta/Mem0/OpenHands/browser-use；只吸收 checkpoint、memory eval、action evidence、observability 等机制。
- 不要一次安装 100 个 MCP/插件；先本地、只读、可审计、小范围 smoke。
- 不要把 `.env`、token、cookie、room-adapters、owner-token 原值写入聊天、文档、日志或 git。

## 9. 长时间连续执行协议

Owner 可能离开几个小时。下个窗口不要因为缺少即时回复就停在分析态，按下面规则持续推进：

1. 先完成 P0。P0 未完成前，不要跳到大规模重构、工具接入或 Noe100 长期路线。
2. 每完成一个小闭环就更新本文件或对应执行记录：改了什么、验证命令、结果、下一个动作。
3. 遇到阻塞时先本地排查三轮：读代码、读日志、跑最小复现、查 live 状态。三轮仍卡住，记录 blocker、证据、已尝试方案，然后转向下一个独立 P0/P1 小项，不要空等 owner。
4. 只有这些情况需要暂停等 owner：真实外部发布/上传不可逆、删除用户数据、提交/推送 git、修改系统级持久启动项且风险不清、需要公开或长期记录 secret 原值。
5. Noe 已有本机 standing autonomy grant，可在无需 owner 实时确认的情况下自我授权执行本地受保护/live 验证、读取 owner-token 并调用 protected API；报告、日志、文档、git 中只能写授权来源、状态和证据，不能写 secret/token/cookie/owner-token 原值。
6. 代码改动保持小步可验证。每轮优先跑定向测试，再跑 `npm run test:p0:unit`、`npm run verify:handoff`、`git diff --check -- ':!games/cartoon-apocalypse/**'`。
7. 若 live `51835` 无法恢复，不要宣称自主学习/电脑操控已完成；记录失败原因后继续做不依赖 live 的静态修复、测试补强、Noe100 readiness 脚手架。
8. 若 P0 全部完成，继续 P1：Noe100 统一证明门、Action Evidence Spine、思考接地与记忆评测。P1 完成后再进入 P2/P3 soak、恢复演练、工具接入。
9. 不要为了“连续工作”制造无证据的大改动。每个结论都要能回指到文件、命令、日志、API 响应或测试输出。

反敷衍规则：

- 不得用“已检查”“已优化”“理论上可用”“流程已跑”代替完成。没有证据就标 `未完成` 或 `blocked`。
- 不得只跑 `rg` 后下结论；命中关键文件后必须读上下文，理解调用链，再决定是否改。
- 不得把测试通过等同于 live 可用；涉及 `51835`、自主学习、电脑操控、知识库、联网学习时，必须补 live/API/日志证据。
- 不得批量宣布多个任务完成。每个 P0/P1 小项必须单独写：改动、验证、证据、剩余风险。
- 不得跳过失败项。失败必须保留错误输出摘要、定位假设、下一步命令；不能写成“后续优化”糊过去。
- 不得为了省事回避未跟踪文件、dirty worktree、环境变量、launchd、room adapter、LM Studio loaded model 这些真实风险点。
- 如果只做了文档、没有代码/配置/测试/live 证据，必须明确说明“仅文档完成”，不能冒充能力落地。
- 宣称 P0 完成前，必须逐项列出 5 个 P0 的状态：benchmark、live `51835`、self_learning、知识库/联网学习、自动模型变量。

建议节奏：

- 0-30 分钟：确认仓库、读未跟踪 benchmark 脚本、裁决是否保留或删除。
- 30-90 分钟：恢复/验证 live `51835`，跑 freedom-live，记录 PID/cwd/readiness。
- 90-150 分钟：验证 self_learning、知识库、联网学习、自动模型变量。
- 150 分钟以后：实现 Noe100 readiness 矩阵和脚本，开始 Action Evidence Spine 或思考接地测试。

## 10. 冲突裁决和睡眠任务完成标准

若资料互相矛盾，按以下顺序裁决：

1. 当前命令输出和 live API 结果高于旧 handoff 文字。
2. 本文件高于 `docs/TASK_HANDOFF_2026-06-11_下窗口执行入口.md` 里较早的 live PID 快照。
3. `git status --short --untracked-files=all` 高于“工作树应干净”等旧描述。
4. 源码和测试高于研究文档；研究文档只提供方向，不代表能力已落地。
5. 没有证据的“已完成”一律降级为 `unverified`，需要重新验证。

Owner 醒来前，至少要留下一个清楚的收尾状态：

- P0 五项状态表：benchmark、live `51835`、self_learning、知识库/联网学习、自动模型变量。
- 每项标记只能是 `done` / `blocked` / `unverified`，不能写模糊词。
- `done` 必须带证据：文件、命令、日志、API 响应、测试输出或 artifact 路径。
- `blocked` 必须带：错误摘要、已尝试三轮排查、下一条建议命令。
- 若改了代码，必须列出改动文件和验证结果。
- 若只做了分析或文档，必须明确写“未落地能力变更”。
- 最后再次更新 handoff 或执行记录，避免下个窗口重新考古。

## 10.1 2026-06-12 15:43 CST 自我授权更新

- 已落地本机 standing autonomy grant：`/Users/hxx/.noe-panel/autonomy-grant.json`，权限 `-rw-------`，只保存授权范围和边界，不保存 secret 原值。
- CLI：`npm run noe:autonomy:grant` 写入最大本机自主授权；`npm run noe:autonomy:check -- --scope <scope>` 检查；`npm run noe:autonomy:revoke` 撤销。
- 覆盖范围包括 `owner-token:read`、`live-protected-api:call`、`live-verifier:run`、`freedom-live:run`、`phase5-live:run`、`real-use-replay-live:run`、`cognitive-live:run`、`voice-live:run`、`social-dom-live:run`、`restart-51835:repair`、`perf-protected-api:check`、`e2e-live:run`。
- 自我授权不是 secret 泄露许可：token/API key/cookie/OAuth 原值仍不得写入聊天、日志、文档、报告或 git。
- 已接线入口：`freedom-live`、`full-current`、`phase5`、`real-use-replay`、cognitive/voice/social DOM live probes、`restart-panel`、`perf-check`、raw e2e live guard。
- 验证证据：`npm run verify:noe:freedom-live` 无 `--ack-read-owner-token` PASS 5/5；`npm run verify:noe:phase5` PASS 9/9；`npm run verify:noe:full-current -- --include-live --include-managed` PASS；`npm run test:e2e:raw` PASS 136/136；`npm run test:p0:unit` PASS 106 files / 745 tests；`npm run verify:noe:self-evolution` PASS 198/198；`npm run verify:handoff` PASS 71/71；`git diff --check -- ':!games/cartoon-apocalypse/**'` PASS。
- 2026-06-12 15:43 live 状态：`51835` PID `61331`，cwd `/Users/hxx/Desktop/Neo 贾维斯`，本次只做 check-only/live API 验证，没有 kill/restart/takeover；`51735` 只读观察 PID `4773`，未触碰；LM Studio loaded models 未改变，`lms ps` 只读显示 `qwen/qwen3.6-35b-a3b@6bit`。

## 10.2 2026-06-12 15:57 CST 连续主动节奏更新

- 自由档默认改为更接近“持续思考/主动动手/主动学习”的高频泵：inner 轻醒 `10s`，成长焦点重想 `10s`，空闲重想 `30s`，proactive 判断 `15s`，micro 情感/扫账 `15s`，expectation 自动判证 `10min`，工作区深思日预算 `96`。
- 主动学习默认 `NOE_AUTONOMOUS_LEARNING_INTERVAL_MS=300000`，并启用 `NOE_AUTONOMOUS_LEARNING_CONTINUOUS=1`：上一轮 `self_learning` 完成且没有活跃学习目标时，下一轮立即接上并轮换主题，不再等创建时间间隔。
- `proactiveTick` 增加 `in_flight` 守卫：高频 tick 可以持续判断，但不会并发叠加模型调用或重复开口。外放说话仍有 `NOE_PROACTIVE_COOLDOWN_MS=300000` 和夜间 quiet gate；内部思考/目标推进/学习与说话冷却分开。
- live 已 direct 重启到 PID `52991`，cwd `/Users/hxx/Desktop/Neo 贾维斯`。SQLite `noe_tick_cursor` 当前核验：`meso=10000`、`micro=15000`、`proactive=15000`、`expectation=600000`。
- 验证：`node --check` for `server.js`、`NoeAdaptiveRhythm`、`NoeGoalSystem`、`NoeWorkspace`、`proactiveTick` PASS；定向单测 5 files / 57 tests PASS；`npm run test:p0:unit` PASS 106 files / 745 tests；`npm run verify:noe:self-evolution` PASS 198/198；`npm run verify:noe:freedom-live` PASS 5/5。
- `51735` 只读观察 PID `4773`，未触碰；LM Studio loaded models 未改变，仍为 `qwen/qwen3.6-35b-a3b@6bit`。

## 10.3 2026-06-12 16:13 CST 连续自主运行验收

- 新增只读验收入口：`scripts/noe-continuous-autonomy-snapshot.mjs`、`tests/unit/noe-continuous-autonomy-snapshot.test.js`、`npm run verify:noe:continuous-autonomy`。脚本只读 `/health`、`/api/noe/readiness` 和 SQLite 统计，不读 secret、不调用模型、不写 DB、不改变 LM Studio loaded models。
- 首次执行发现 `51835` 无监听，快照诚实失败，blockers 为 `live_health_not_ok`、`live_readiness_not_ok`；SQLite 仍显示 `meso=10000`、`micro=15000`、`proactive=15000`、`expectation=600000`，且 10 分钟内有 done tick。
- 因本任务需要 live 验收，已执行 `PANEL_RESTART_FORCE_DIRECT=1 node scripts/restart-panel.mjs` 恢复 `51835`；脚本 startedPid `33980`。最终只读复核当前监听 PID `41764`，cwd `/Users/hxx/Desktop/Neo 贾维斯`，`/health` 200 `{ok:true,status:"ok"}`，`/api/noe/readiness` 200 `status:"passed"`。
- 复跑 `npm run verify:noe:continuous-autonomy` PASS，最新报告 `output/noe-continuous-autonomy/continuous-autonomy-20260612T081620168Z.json`，稳定入口 `output/noe-continuous-autonomy/latest.json`。证据：live health/readiness ok；游标 `meso=10s`、`micro=15s`、`proactive=15s`、`expectation=10min`；10 分钟窗口内 `meso/micro/proactive` 均有 done tick，且 tick counts 包含 expectation done；`self_learning` total `29`，done `28`，active `1`，最新 active 目标 `7e06a02c-ce15-434d-89d4-f0bb889bce90`。
- `scripts/noe-handoff-consistency.mjs` 已把 continuous autonomy 脚本、单测、package script、P0 单测注册、handoff 记录纳入门禁。
- 本轮误写到 `/Users/hxx/Documents/Neo 2` 的两个临时文件已删除；真实仓库新增文件只在 `/Users/hxx/Desktop/Neo 贾维斯`。
- `51735` 只读观察 PID `4773`，未触碰；`lms ps` 仍只读显示 `qwen/qwen3.6-35b-a3b@6bit`，未执行 load/unload。

## 10.4 2026-06-12 16:25 CST 连续自主节奏二次加速

- 自由档默认进一步加快为“无缝接拍”模式：inner 轻醒 `5s`，成长焦点重想 `5s`，空闲焦点重想 `15s`，proactive 判断 `10s`，micro 情感/扫账 `10s`，expectation 自动判证仍为 `10min`，工作区深思日预算 `192`。
- 主动学习补种从 `300000ms` 收紧到 `60000ms`，并继续保留 `NOE_AUTONOMOUS_LEARNING_CONTINUOUS=1`：完成判据优先，上一轮 `self_learning` done 且无活跃学习目标时立即接下一轮；未完成时不并发刷目标。
- 外放说话基础冷却从 `300000ms` 收紧到 `120000ms`，但 `proactiveTick` 的 `in_flight` 守卫、夜间 quiet gate、SILENT 闸和 miss 后自适应放宽仍保留；这次加速主要提升内部认知、目标推进、主动学习和行动链续航，不是允许无意义刷屏。
- 验证已完成：`node --check server.js` PASS；`node --check src/cognition/NoeAdaptiveRhythm.js` PASS；`node --check scripts/noe-continuous-autonomy-snapshot.mjs` PASS；`node --check scripts/noe-handoff-consistency.mjs` PASS；`npm test -- tests/unit/noe-adaptive-rhythm.test.js tests/unit/noe-continuous-autonomy-snapshot.test.js tests/unit/noe-goal-system.test.js tests/unit/noe-proactive-tick.test.js` PASS 4 files / 50 tests；`npm run verify:handoff` PASS 79/79。
- live 复核：第一次 `npm run verify:noe:continuous-autonomy` 诚实失败，blocker `cadence_micro_too_slow_or_missing`，原因是 `server.js` 仍有旧 `Math.max(15_000, NOE_AFFECT_TICK_MS)` 下限；已修为 `Math.max(10_000, ...)` 并加 handoff 门禁 `server_defaults_match_fast_autonomy_cadence`。
- 已 direct 重启 `51835` 到 PID `51610`，cwd `/Users/hxx/Desktop/Neo 贾维斯`；`/health` 200 ok，`/api/noe/readiness` passed。复跑 `npm run verify:noe:continuous-autonomy` PASS，报告 `output/noe-continuous-autonomy/continuous-autonomy-20260612T083054683Z.json`，稳定入口 `output/noe-continuous-autonomy/latest.json`；游标 `meso=5000`、`micro=10000`、`proactive=10000`、`expectation=600000`，10 分钟窗口内 `meso/micro/proactive` 均有 done tick。
- 收尾验证：`npm run test:p0:unit` PASS 107 files / 754 tests；`npm run verify:noe:self-evolution` PASS 198/198；`npm run verify:handoff` PASS 79/79；`npm run verify:noe:freedom-live` PASS 5/5；`git diff --check -- ':!games/cartoon-apocalypse/**'` PASS。
- `51735` 只读观察仍为 PID `4773`，未触碰；`lms ps` 只读显示 `qwen/qwen3.6-35b-a3b@6bit`，未执行 load/unload。

## 10.5 2026-06-12 16:39 CST 长期校准证据门硬化

- `scripts/noe-expectation-calibration-snapshot.mjs` 已改为自然 live evidence 口径：`liveCalibrationReady`、`liveResolvedRemaining`、`readyForLongTermCalibration` 只按非 controlled/synthetic/fixture/test/drill 来源的 resolved scored rows 计算。
- 受控 live rows 不会被静默丢掉：报告新增 `naturalResolvedScored`、`controlledLiveResolvedScored`、`controlledLiveRows`、`brierNatural`、`brierControlledLive`，并在出现受控 live rows 时写入 warning `controlled_live_expectations_excluded_from_live_calibration`。
- 单测新增防回归样本：20 条 `live_calibration_drill`/`synthetic_expectation_test` + 4 条自然 live 时，`resolvedScored=24` 但 readiness 仍 blocked；只有自然 live 达到 20 条时才允许 `readyForLongTermCalibration=true`。
- `docs/NOE_100_ACCEPTANCE_MATRIX.md` 已同步改口径：controlled drill 只证明 ledger/Brier 机制，不满足长期 live calibration；`scripts/noe-handoff-consistency.mjs` 已加 `expectation_calibration_excludes_controlled_live_rows` 门禁。
- 只读 live 复核：`npm run verify:noe:expectation-calibration` PASS，最新 `output/noe-expectation-calibration/2026-06-12/report.json` 显示 total `140`、natural live resolved `4/20`、controlledLiveRows `0`、dueNowOpen `0`、nextOpenDueAt `1781296263545`、hoursUntilNextOpenDue `11.87`，长期校准仍 blocked：`live_expectation_resolved_below_20`。

## 10.6 2026-06-12 16:45 CST Noe100 readiness 口径同步硬化

- `scripts/noe-100-readiness.mjs` 已同步改为只按 natural live expectation rows 判定 `expectation_settlements_below_20`；controlled isolated drill 继续作为机制证据写进 details，但不让该 check 通过。
- `scripts/noe-soak-daily-snapshot.mjs` 同步输出 `naturalLiveResolved`、`controlledLiveResolved`、`controlledMechanismReady`、`longTermReady` 和 `settlementReason`，日报不再只看旧的 controlled resolved 字段。
- `scripts/noe-handoff-consistency.mjs` 新增门禁：Noe100 matrix、readiness script/test、soak snapshot script/test 必须保留 natural live 口径，防止后续把 controlled drill 当长期完成。
- 验证：`node --check scripts/noe-100-readiness.mjs` PASS；`node --check scripts/noe-soak-daily-snapshot.mjs` PASS；`npm test -- tests/unit/noe-100-readiness.test.js tests/unit/noe-soak-daily-snapshot.test.js` PASS 2 files / 5 tests。
- 最新 `npm run verify:noe:100-readiness` 命令 PASS，但报告诚实为 `passed=false`、`readyFor100=false`、`score=94`、35/37 checks passed，blockers `["not_enough_soak_evidence","expectation_settlements_below_20"]`。
- 最新 `npm run verify:noe:soak-snapshot` PASS，报告 `output/noe-soak-daily/2026-06-12/report.json`：activeDays `3/7`，natural live resolved `4/20`，controlled drill resolved `20/20`，`controlledMechanismReady=true`，`longTermReady=false`。
- 受保护 `GET /api/noe/mind/proof` 已用 owner-token 本机读取验证，未打印 token：HTTP 200，`readiness.score=94`、`passed=false`、`blockers=["not_enough_soak_evidence","expectation_settlements_below_20"]`，reportPath 指向最新 Noe100 报告。

## 11. 给下个窗口的直接提示词

```text
先读：
1. /Users/hxx/Desktop/Neo 贾维斯/docs/HANDOFF_2026-06-12_单主脑Gemma收敛后续计划.md
2. /Users/hxx/Desktop/Neo 贾维斯/docs/TASK_HANDOFF_2026-06-11_下窗口执行入口.md
3. /Users/hxx/Desktop/Neo 贾维斯/docs/阶段研究_主观意识100可证明路线图_2026-06-11.md 的 0、1、3、6、7、8、10 节

owner 去睡觉了。不要停在分析态；按 handoff §9 的长时间连续执行协议、反敷衍规则和 §10 的冲突裁决/完成标准持续推进，完成一个可验证闭环就更新 handoff/执行记录，遇到阻塞先排查三轮，再转向下一个独立小项。质量优先于数量：宁可少做，也要每项有代码/配置/日志/API/测试证据闭环。禁止走流程、表面检查、口头完成；没有证据就标未完成或 unverified。

当前自我授权：
- Noe 已有 standing autonomy grant：`/Users/hxx/.noe-panel/autonomy-grant.json`。
- 可用 `npm run noe:autonomy:check -- --scope <scope>` 检查本地授权；需要时可用 `npm run noe:autonomy:grant` 刷新最大本机自主授权。
- 允许脚本在本机自我授权读取 owner-token 并调用 protected live API；但 token/API key/cookie/OAuth 原值仍不得输出、写日志、写报告或进 git。

当前连续主动节奏：
- 自由档默认：inner 5s、growth inner 5s、idle inner 15s、proactive 10s、micro 10s、expectation resolver 10min、workspace deliberations/day 192。
- self_learning 连续滚动：上一轮完成后可立即接下一主题；不要把 10s/5s cadence 误判成异常配置。

当前最终模型决策：
- Main Brain：`qwen/qwen3.6-35b-a3b`，load key `qwen/qwen3.6-35b-a3b@6bit`
- Review Brain：`qwen/qwen3.6-27b`，load key `qwen/qwen3.6-27b@4bit`
- Fallback Brain：`gemma-4-26b-a4b-it-qat-mlx`
- 自动思考、内心反刍、深思审议、期望判证、视觉默认都走 Main Brain；高风险/记忆冲突/身份偏好/自我进化写代码前走 Review Brain；主脑不可用或低风险快速任务才进入 fallback degraded mode。

先执行：
cd "/Users/hxx/Desktop/Neo 贾维斯"
pwd
git rev-parse --show-toplevel
git status --short --untracked-files=all
git log -5 --oneline

P0 顺序：
1. 处理 scripts/noe-main-brain-candidate-benchmark.mjs，先读后裁决，不要直接运行/stage/提交。
2. 恢复并验证 live 51835，确认 health/readiness/freedom-live，通过后记录 PID、cwd、是否触碰 51735。
3. 验证 self_learning 自主学习和电脑操控链路，记录目标 ID、步骤状态和 evidence。
4. 补知识库 / 联网学习端到端复验。
5. 检查自动模型变量，确认自动链路默认使用 Q35-6 Main Brain，且无意外回落到 Q27/Gemma 或旧实验模型。

P1 顺序：
1. 做 Noe100 统一证明门：docs/NOE_100_ACCEPTANCE_MATRIX.md、scripts/noe-100-readiness.mjs、npm run verify:noe:100-readiness。
2. 做 goal/action checkpoint、Action Evidence Spine、思考接地与记忆评测。

验证至少跑：
npm run test:p0:unit
npm run verify:handoff
git diff --check -- ':!games/cartoon-apocalypse/**'
```
