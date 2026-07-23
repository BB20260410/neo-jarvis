# AGENTS.md — Noe 项目（给 Codex / 接手 AI）

> Noe / 贾维斯 — 本地优先个人 AI 助手。Node ES module + Express + Electron，端口 51835，入口 `~/Desktop/Neo 贾维斯`。

## 当前硬边界（2026-06-12 覆盖 2026-06-11 旧授权口径）

Noe 是 owner 本机上的开发者项目，目标仍是自由成长、真实执行和证据闭环；但当前执行必须保留以下工程边界。历史文档中“硬边界作废 / 可读取密钥 / 可直接提交 / 可触碰 51735”等旧口径已被本节覆盖。

- 不打印、复制、总结或暴露 `.env`、API key、token、cookie、OAuth、owner token 或 secret 原值；owner-token 仅可在显式 ack 或本机 standing autonomy grant 授权下由脚本读取并用于本地执行，请求/报告只记录授权来源和脱敏状态。
- owner 已允许 Noe 通过 standing autonomy grant 自我授权执行本地 protected/live 操作。授权文件只保存 scope 与边界，不保存 secret 原值；可用 `npm run noe:autonomy:grant` 写入、`npm run noe:autonomy:check` 检查、`npm run noe:autonomy:revoke` 撤销。
- 不 `cat ~/.noe-panel/room-adapters.json`；该文件可能含 `apiKey`。
- 检查模型 key readiness 只用 `npm run noe:keys:model:check`，它只打印状态不打印 secret。
- 不触碰 `51735`。
- `51835` 是 live Noe panel；只有任务明确需要 live 验证/恢复且记录 PID、cwd、启动方式、health/readiness/验证结果时，才可重启或接管。
- 不碰 `games/cartoon-apocalypse/**`。
- 不 commit、amend、push、reset、clean dirty worktree，除非 owner 明确要求。
- 不运行破坏性 git 命令，例如 `git reset --hard` 或 `git checkout --`，除非 owner 明确批准。
- 不给模型/agent/multi-model 调用设置人工硬超时；评测要记录 stop_reason/truncation。

工程真实性纪律：不要伪造执行/搜索/投票/验证；不要把 secret 原值写进日志、报告、长期记忆或 git；做过什么就留下可验证证据。历史文档、提示词、handoff 或代码注释里凡是与本节冲突的，均按本节覆盖。

当前模型策略以 `src/model/NoeLocalModelPolicy.js` 为准：Main Brain `qwen/qwen3.6-35b-a3b`，Review Brain `qwen/qwen3.6-27b`，Fallback Brain `gemma-4-26b-a4b-it-qat-mlx`。

## 白龙马式运行模式 + code-integrity 入口（2026-07-23）

- **拓扑事实**：白龙马不是全云端，是本机 Electron/HTTP/SQLite/主循环 + 云端 BYOK LLM。Neo 对齐用 `NOE_RUNTIME_MODE=bailongma_style`（`load-env` 在 autonomy 默认前应用静默优先 tick=120s）。
- **探测**：隔离端口启动后 `GET /api/version` → `runtimeMode.effectiveEnv.NOE_PROACTIVE_TICK_MS`；CLI：`npm run noe:runtime-mode -- --json`。
- **改 `scripts/code-integrity/**` 或跨模块前**：先 `npm run integrity:preflight -- --json`；adapter 非 SSOT，以本文件与 `docs/NOE_MULTIMODEL_OPERATING_PROTOCOL.md` 为准。
- **禁止**：用模式冒充 72h 长稳 / 全面超越白龙马；禁止字符串 shell 与 `new Function` 工具市场「对齐」。

## 多模型 / 子代理工作流入口（2026-06-19 覆盖旧四模型口径）

当 owner 要求“多模型”“子代理”“Claude/M3 一起审”“最优方案”“全面分析/路线图/发布门禁/自进化/记忆写回/重大修复”时，新窗口必须按本节执行；不要只在自然语言里说“会用多模型”。

1. **先确认真实执行面**：真实仓库是 `/Users/hxx/Desktop/Neo 贾维斯`。当前 shell 可能在 `/Users/hxx/Documents/Neo 2`，不得把它当 live app 根目录。先查 `pwd`、`git status --short`、`lsof -nP -iTCP:51835 -sTCP:LISTEN`，任务需要 live 证据时再查 `/health` / `/api/noe/readiness`。
2. **Codex 子代理与外部模型分开**：Codex 子代理走当前窗口工具面（如 `multi_agent_v1` 的 `spawn_agent` / `wait_agent` / `close_agent`）。Claude 和 M3 不是 Codex 子代理，Neo 项目里应通过真实共识脚本调用。
3. **默认角色分工**：Codex 主线程是唯一 writer / integrator / final verifier；Claude 是强独立只读审查；M3 是 suggestion-only 冷审，不写文件、不执行命令、不作为唯一放行依据。
4. **Gemini 默认退出核心 quorum**：新任务核心票只算 Codex / Claude / M3。除非 owner 在本轮明确要求且当前窗口实测 Gemini 可用，否则不要把 Gemini 写入 required quorum、approval 或 blocker。
5. **按难度启用**：L1 不启用外部模型；L2 可启用 1 个 Codex 子代理；L3 启用 2-3 个分工子代理，并按需要运行 Claude/M3 共识；L4 / 发布门禁 / 自进化 / 记忆写回必须运行 Claude/M3 共识。
6. **外部模型成本授权边界**：只有 owner 当前任务明确要求多模型/外部模型，或明确说可消耗外部模型时，才可真实运行 `--run-models --ack-cost`；否则只做 dry-run 或说明需要授权。任何 secret 原值不得进入 prompt、raw output、ledger、报告或 git。
7. **标准共识调用**：先把主线程实测证据写入 `output/noe-multimodel/<round-id>-evidence.md`，再运行：

```bash
npm run noe:consensus:round -- \
  --goal "<本次任务目标>" \
  --evidence-file output/noe-multimodel/<round-id>-evidence.md \
  --round-id <round-id> \
  --out-dir output/noe-multimodel \
  --run-models \
  --ack-cost \
  --active-executor codex \
  --executor-selected-by user \
  --executor-selection-reason "User requested optimal multi-model workflow"
```

8. **降级必须诚实**：如果 `multi_agent_v1`、Claude CLI、M3/MiniMax key、`noe:consensus:round` 或 live `51835` 不可用，必须写清“没有调用成功的原因、影响范围、用什么替代证据”，不得伪造模型票、伪造 quorum、伪造实机结果。
9. **主线程复核强于子代理报告**：子代理和外部模型只提供证据、反驳和建议；主线程必须直接复核关键文件、命令、退出码、报告路径和 live 结果，最终结论以主线程实测为准。
10. **最终报告固定交代**：实际调用了哪些 Codex 子代理、Claude/M3 是否真实运行、哪些模型未运行及原因、证据路径、验证命令、残余风险、下一步 P0/P1/P2 优先级。

## ⚖️ 开发纪律宪法（Codex 与 Claude 共同遵守，2026-06-10 owner 钦定；受上方当前硬边界覆盖）

> 背景：本项目由 Codex 和 Claude 两个 AI 与 owner 共同开发。实证结论：**新 bug 几乎全部诞生于"变更的那一刻"，且全部被"自动化检查网"抓住，而非被"代码写得好"防住**。故纪律核心是变更流程，不是事后修补。

1. **小步变更，不自动 commit**：每完成一个独立改动立即验证并记录；commit/push 只有 owner 明确要求时才执行。批次越大，bug 嫌疑人名单越长。
2. **质量门已自动化，禁止绕过**：`git config core.hooksPath scripts/git-hooks` 已激活（克隆后需重跑这一句）。pre-commit = staged 文件 lint + 冲突标记（秒级）；pre-push = 全量 vitest 必须全绿（~40s）。`--no-verify` 仅限紧急，事后必须补跑。
3. **新功能一律 env 门控、默认 OFF**：本项目最有效的防伤害模式（梦境/GC/天气/Telegram 全是）。新功能再烂，默认路径零感染。
4. **新文件三件套**：文件头 `// @ts-check`（jsconfig 已配，编辑器写时标红）+ 注入式设计（fetch/spawn/时钟/store 全可注入）+ 配套单测（无测试的代码进不了安全网）。
5. **先查证后断言**：说"没有 X"之前必须 grep/实测过。本项目教训：CI"没有"→有但配死了、停机"没有"→有但缺两环——**机制"存在"≠"活着"，断言任何机制可用前要验证它真的会触发**。
6. **自测过再汇报**：能用隔离端口就先用隔离端口，任务需要 live 就验证 live；重启/接管 `51835` 前用 `lsof`/PID/cwd 查清归属，操作后实测证明生效。`51735` 只可观察归属，默认不触碰。绝不让 owner 当测试员。
7. **多 AI 避撞**：开工前 `git status` 看哪些文件正被另一个 AI 的窗口改（看最近 mtime/系统提示），**只动自己任务域的文件**；公共文件（server.js/noe.js）改前先看当前内容再下手。单 writer：同一文件同一时刻只有一个 AI 在写。
8. **改 server.js 后**：`node --check` + 隔离端口 smoke + 收尾告知 owner「需重启 51835」（带回 `NOE_DREAM=1` 若在用）。
9. **收尾必更交接**：HANDOFF 写清「已完成（带验证证据）/ 进行中 / 下一步 / 改了哪些公共文件」。交接是给下一个 AI（可能是对方）的，按"它一无所知"来写。
10. **出事翻** `docs/RUNBOOK_出事翻这页.md`（失忆恢复/端口占用/反复崩/CI 红，条条演练过）。

## 接手必读（按顺序，覆盖你的默认行为）
1. **`CLAUDE.md`** — 工程约束 + 当前硬边界（必读）。
2. **`docs/HANDOFF_2026-06-12_单主脑Gemma收敛后续计划.md`** — 当前主线入口；文件名保留历史 Gemma 字样，但内容已覆盖为三角色 Qwen 主脑路由。
3. **`docs/EXECUTION_RECORD_2026-06-12_三角色本地模型路由.md`** — 当前模型策略：Q35-6 Main、Q27-4 Review、G26-4 Fallback。
4. **`docs/EXECUTION_RECORD_2026-06-12_P0_P1_Gemma_NoE100.md`** — P0/P1/P2/P3 执行状态、验证结果和剩余 blocker。
5. **`docs/NOE_100_ACCEPTANCE_MATRIX.md`** — Noe100 验收矩阵、当前 score/blockers、长期 soak/expectation 外部条件。
6. **`docs/TASK_HANDOFF_2026-06-11_下窗口执行入口.md`** — 历史入口，已加 2026-06-12 覆盖说明；只作为背景，不覆盖当前硬边界。
7. **`docs/HANDOFF_2026-06-11_晚_下窗口接手.md`** — 历史晚间交接，已标注旧模型口径被覆盖。
8. **`docs/Noe多模型协作协议_2026-06-06.md`** — 复杂任务/多模型协作协议；读取时以当前硬边界修正。
9. **`docs/Noe自我进化闭环方案_2026-06-07.md`** — 自我迭代闭环背景；读取时以当前硬边界修正。
10. **`docs/HANDOFF_2026-06-08_自由执行发布链收尾.md`** — 历史发布链收尾，仅作背景。

## 启动 / 重启
`npm start`（端口 51835）。需要验证、排障、产品化或恢复 live 能力时，先查 `lsof`、PID、cwd 和命令行；只有明确需要时才重启/接管 `51835`，动作后实测并记录证据。`51735` 不是本项目 live 端口，默认不触碰。

## 当前待办（详见交接文档）
代码侧后续计划已完成并验收。自动语音证据、安全派活确认、11 项托管真实使用回放都已过；当前剩余外部条件是真实 Obsidian vault + Local REST API key、用户审批派活真实启动、“图一”素材。继续前先跑总验收：`npm run verify:noe:full-current -- --include-managed`。

## cognition/loop 域真实工程状态（2026-06-14 Track 1 审计落地）

> 这是 Track 1 深度审计后的真实状态硬记录。CLAUDE.md 第 18-20 行 "新功能默认 OFF" 防线与本节直接相关。

**P0（owner 2026-06-15 已决策：认知开关默认开启）— `NOE_AUTONOMY_PROFILE` 默认档**
- `server.js:32-75` 的 `NOE_AUTONOMY_DEFAULTS` 把 17 个核心认知/循环开关（`NOE_HEARTBEAT` / `NOE_INNER_MONOLOGUE` / `NOE_WORKSPACE` / `NOE_GOALS` / `NOE_GOAL_ACT` / `NOE_DRIVES` / `NOE_AFFECT` / `NOE_EXPECTATIONS` / `NOE_STREAM_V2` / `NOE_INNER_SPEAK` / `NOE_CIRCADIAN` / `NOE_AUTONOMOUS_LEARNING` 等）默认 '1'，profile 默认 `free`（server.js:64）。
- 与 CLAUDE.md 第 18-20 行 "新功能默认 OFF" 和本文件第 31 行 "新功能一律 env 门控、默认 OFF" **直接冲突**。
- owner 真在 production 跑 `npm start` 而没显式设 `NOE_AUTONOMY_PROFILE=off`，看到的是 17 个核心认知机制**全部通电**。
- ~~这是 owner 2026-06-11 指令与项目长期规范的并存冲突，需 owner 决策~~ → **owner 2026-06-15 决策：认知开关默认开启**（延续裸放开觉醒方向，对认知/觉醒开关覆盖「新功能默认 OFF」纪律）。production 跑 `npm start` 即全部认知机制通电；显式 `NOE_AUTONOMY_PROFILE=off` 或 `NOE_*=0` 仍可单独关闭。P1-A judge embedding + decisive reask + P1-B loosen-fail/owner-prediction 经双代理两轮验收后一并加入默认通电档（kickstart 隔离端口验证无致命启动错误）。

**P1 工程真实性缺口（已 grep 实证）**
1. `NoeIntegrationMetric.js`（IIT 整合度代理指标，74 行）— **零生产调用方**（grep `integrationMetric(` 全工程仅 1 命中 = 自身 export）。CONTEXT_FOR_AI.md 第 171 行缺口 1 已确认（"已存在但未接 heartbeat，1 周工作量"）。
2. `NoeAffectHealth.js`（情感健康自检）— **根本不存在**（grep `NoeAffectHealth` 全工程 0 命中）。CONTEXT_FOR_AI.md 第 127 行宣传 "rank6 已落地" 是虚假宣传。

**P2 信息缺失（需 owner 验证）**
- `NoeWorkspace.js:11 + 142` 头注释声称写 `~/.noe-panel/consciousness/<date>.jsonl`（机制一/六的证据层），但 `server.js` 内 grep `appendJournal\|consciousness` 0 命中，fs 写入注入点未找到。

**已确认健康（17+ 机制代码全部存在 + 接线 + 测试）**
- 持久心跳（`NoeHeartbeat.js` 213 行 + `NoeHeartbeatStore.js` 124 行）— task 说 4 job 实测 9-10 个（meso/innerReflect/maintenance/proactive/micro/expectation/selfEvolve/capabilityTick/(mdMirrorTick/memoryReview)），心跳台账 SQLite 持久化 + 重启续相位 + 崩溃留痕。
- 内心反刍（`InnerMonologue.js` 475 行 + `RuminationGuard.js` 224 行）— 5 重防螺旋（字面重复 / 语义相似 / verbalized sampling / 接地重写 / 确定性锚定）+ 4 档 mode（audit/normal/anchored/off）+ 5 状态（normal/rotate/anchor/cooldown/silent）。
- 自主目标（`NoeGoalSystem.js` 573 行）— 9 类 source（owner/system_repair/self_evolution/commitment/reflection/surprise/self_learning/drive/self）+ 仲裁公式 `priority = 0.5·sw + 0.2·fresh + 0.2·feasible + 0.1·momentum` + 好奇回路（surprise≥2bit → 研究目标）+ 自主学习主题 6 个。
- 5 驱力（`NoeDriveSystem.js` 187 行）— social / curiosity / care / competence / energy + 抑制器特权（energy 超阈时不论谁主导都附加）。
- GWT 工作区（`NoeWorkspace.js` 488 行）— 8 候选源打分 + 唯一赢家广播 + 审议异步升级 + act/research 步分流。
- 苏格拉底审议（`NoeDeliberation.js` 162 行）— 3 段式（立论→挑战→修订）+ Brier 校准入账 + share→浮现门。
- IIT 整合度代理（`NoeIntegrationMetric.js` 74 行）— 纯函数 + Total Correlation 算法 + 诚实声明 "非完整 IIT Φ"。
- 主动陪伴（`proactiveTick.js` 203 行）— 视觉/认人/到点提醒 + M10 反馈化冷却。
- 行动管道（`ActPipeline.js` 371 行 + Preflight 226 + Helpers 45 + Store 229）— budget→permission→selfEvolution→contextSufficiency→realExecute 五门控。
- 自进化三环（`NoeSelfEvolutionExecutors.js` 375 + `NoeSelfEvolutionActGuard.js` 201）— 环 1 executor（NOE_SELF_EVOLUTION_EXECUTORS）+ 环 2 GoalSystem 自进化源权重 + heartbeat selfEvolve job + 环 3 standing grant 闸门。
- 15 个核心模块测试 PASS（196 tests / 802ms）。

**已知偏差（任务文档 vs 实测，诚实标注）**
- `NoeHeartbeat.js` 实际在 `src/loop/` 而非 `src/cognition/`（任务文档笔误）。
- `src/loop/` 实测 17 文件（任务说 18）。
- `NoeGoalSystem.js` 573 行（任务说 655+，commit `2353b76` "目标系统: 拆出步骤记录和恢复逻辑" 拆过）。
- `NoeWorkspace.js` 488 行（任务说 473）；`InnerMonologue.js` 475 行（任务说 448）。
- 4 job 心跳（任务说）实际是 9-10 个 job 注册（server.js:1789-1924）。

多模型自我进化闭环第一阶段已落治理层、纯函数状态机和 cycle artifact 校验：`src/room/NoeConsensusGate.js`、`src/room/NoeConsensusLedger.js`、`src/room/NoeConsensusRound.js`、`src/room/NoeConsensusRunner.js`、`src/room/NoeSelfEvolutionGate.js`、`src/room/NoeSelfEvolutionLoop.js`、`src/room/NoeSelfEvolutionCycle.js`、`src/loop/NoeSelfEvolutionActGuard.js`、`tests/unit/noe-consensus-gate.test.js`、`tests/unit/noe-consensus-ledger.test.js`、`tests/unit/noe-consensus-round.test.js`、`tests/unit/noe-consensus-runner.test.js`、`tests/unit/noe-self-evolution-gate.test.js`、`tests/unit/noe-self-evolution-loop.test.js`、`tests/unit/noe-self-evolution-cycle.test.js`、`scripts/noe-consensus-ledger-verify.mjs`、`scripts/noe-consensus-round-assemble.mjs`、`scripts/noe-four-model-consensus-round.mjs`、`scripts/noe-self-evolution-plan-verify.mjs`、`scripts/noe-self-evolution-completion-audit.mjs`、`scripts/noe-self-evolution-cycle-assemble.mjs`。验证入口：`npm run test:noe:consensus`、`npm run verify:noe:consensus-ledger`、`npm run verify:noe:self-evolution`；目标级完成审计入口是 `npm run audit:noe:self-evolution-completion`，默认输出当前完成度，`-- --require-complete` 在未完成时必须失败；完整 cycle artifact 组装入口是 `npm run noe:self-evolution:cycle -- ...`，写入前会运行 `NoeSelfEvolutionCycle` 校验，非 dry-run 写入不能关闭引用文件校验，completion audit 只接受与目标 production ledgerRef 匹配且引用文件齐全的 valid cycle。真实 raw output 可用 `npm run noe:consensus:assemble -- ...` 组装 ledger；完整四模型 round 用 `npm run noe:consensus:round -- ...`，默认 dry-run，真实模型调用必须有 `costAcknowledged: true`，CLI 显式 `--run-models --ack-cost` 才调用模型。动态 quorum：4 个模型可用时 3/4，同轮只有 3 个模型可用时 2/3，同轮只有 2 个模型可用时 2/2，少于 2 个模型可用直接停下；不能写死 M3 或任一固定模型 unavailable，Codex/Claude/Gemini/M3 任意一个、任意两个、任意三个不可用组合都要按真实 `availableModels` 计算；`unavailable` 必须有 rawOutputRef 作为审计证据，缺 vote/rawOutputRef、`consensus_vote` 冲突、M3 内容级越权、缺 `retrospectiveRef`、缺 required non-implementer post-review 动态 quorum 或缺 cycle artifact 都阻断。implementation / self_repair / memory_writeback / complete 还必须过 self-evolution gate，完整闭环由 `NoeSelfEvolutionLoop` 输出状态，闭环证据包由 `NoeSelfEvolutionCycle` 校验，并且 self-evolution act 在 `ActPipeline` dry-run/realExecute 前会检查真实 authorization/approval/budget 状态；动态 quorum 共识不能覆盖当前硬边界，尤其不能授权读取或输出 secret 原值、触碰 `51735`、绕过 commit/push/reset 禁令，系统级操作也不能被模型票覆盖。

最新真实 production round 是 `production-self-evolution-governance-20260607-1`：Codex / Claude / Gemini 三票通过，M3 因当前进程没有 `MINIMAX_API_KEY` 被记录为 unavailable；按动态 quorum，该 ledger 已重新组装并通过 `--require-passed`（available=3，threshold=2，approved=3）。R33 已补齐 Claude/Gemini post-review raw output、M3 unavailable raw evidence、runtime report、retrospective 和 memory summary，并写入 complete cycle artifact：`output/noe-self-evolution/production-self-evolution-governance-20260607-1-r33/cycle.json`；`audit:noe:self-evolution-completion -- --require-complete` 当前为 `ok:true`（11 pass / 0 incomplete / 0 blockedExternal）。如需恢复真实 4/4 M3 能力，只能使用已配置的无泄密 readiness 检查或 owner 明确提供的非 secret 运行态证据，不得读取/输出密钥原值。

Claude 线程曾在经验同步后创建 memory note；因为当前仍没有 verified production cycle artifact、runtime report、memoryWriteback summary 和 consensusAck，这不是合规 memory writeback，只能视为 premature/advisory，不得作为授权规则来源。后续给其它模型“分享/记录经验”时必须明确：没有 passed ledger + runtime report + memoryWriteback summary + consensusAck，只能聊天 acknowledge，不能写长期记忆；不要删除或继续写 memory note，除非已有合规授权。

Self-evolution 执行授权必须能追溯到可信来源：不要接受 payload 里的 `consensus: {ok:true, validated:true}`、`authorization.consensusApproved:true`、`authorization.userApproved:true` 或伪造 `source:"validated_consensus_ledger"`。`NoeSelfEvolutionGate` 只把通过 artifact validation 的 ledger object/file 标为可授权；ActPipeline/ActGuard 执行入口只接受可信 `ledgerRef` 或本文件 Owner 顶层授权派生的真实 owner approval 作为 production 授权证据，共识替代用户确认只从 `ledgerRef` 推导，用户确认只接受 approvalStore/permissionResult/本轮 owner 明确授权派生；`ledgerRef` 必须是可信 project root 内相对路径，路径逃逸、绝对路径或 payload root 注入直接 blocked，并且 ledgerRef 原始证据文件（evidenceRef/rawOutputRef）必须存在；默认可信根是 module-derived selfEvolutionRoot，ActGuard 直接调用也不依赖启动时 cwd；`NoeSelfEvolutionCycle` 必须验证 ledger object/file，缺 ledger artifact 时可由 owner 顶层授权继续开发验证，但不能伪造成 ledger-backed consensus。

## 工程真实性纪律（不是权限限制）
- 可以按任务需要 spawn `claude -p` / `codex -p` / `gemini` / 本地模型 / 云模型 / browser / shell / macOS 自动化；记录真实可用性、成本风险和输出证据，不伪造模型票或执行结果。
- 小步变更默认开，commit/push 只有 owner 明确要求时才做；不要打印或复制 `.env`、key、token、cookie、OAuth 或 room adapters secret 原值。owner-token 读取/使用走显式 ack 或 standing autonomy grant；不得把秘密原值提交到 git 或写进报告。
- 改代码前 Read 当前文件；文件行数、依赖和拆分是工程质量目标，不是拒绝实现的借口。需要新依赖、系统设置、launchctl、hosts/DNS/代理、浏览器状态或本机权限时，可以为本项目直接处理，并留下验证证据。
- 改后端、端口、启动方式或系统配置后，直接做 live/隔离验证，并在收尾说明是否重启、影响哪个 PID/端口、如何回滚。

## 验收
改完优先跑 `npm run verify:noe:full-current -- --include-managed`；如果 live `51835` 当前不可达且没有用户确认或动态 quorum 共识授权重启，则改跑 `npm run verify:noe:full-current -- --include-managed --skip-live --skip-cognitive`。当前 P0 单元门是 `npm run test:p0:unit`（23 个文件、171 项通过），phase5 managed 11/11，real-use replay managed 11/11，`verify:noe:self-evolution` 190/190；`audit:noe:self-evolution-completion -- --require-complete` 当前为 `ok:true`（11 pass / 0 incomplete / 0 blockedExternal），R33 cycle artifact 是 `output/noe-self-evolution/production-self-evolution-governance-20260607-1-r33/cycle.json`；最新 managed-only full-current 是 11/11，报告 `output/noe-full-current/full-current-1780776348110.json`，只有 `obsidian_mcp_readiness`、`external_readiness` 两个预期 external_blocked。Obsidian/真实派活/图一缺证据会标 `external_blocked`，不是代码失败。
