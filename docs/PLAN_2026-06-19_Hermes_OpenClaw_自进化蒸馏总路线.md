# Hermes/OpenClaw/Neo 自进化蒸馏总路线

> 状态：证据底座、P0/P1 dry-run、B/C/D/E、F1-F4 和最终 closeout 已完成到 `PASS_WITH_OPEN_BLOCKERS`；本文仍保留 open blocker 和后续 follow-up，不是无条件完成报告。
> 原则：先审计和建证据底座，再做候选能力吸收；先 dry-run，再进入 Neo 主线；任何自改代码都不能直接碰 live 51835。

## 0. 当前基线

| Repo | Path | Branch | HEAD | Dirty state | Version evidence |
|------|------|--------|------|-------------|------------------|
| Neo | `/Users/hxx/Desktop/Neo 贾维斯` | `noe-main` | `0063d9df1ebc` | `M AGENTS.md`; ahead of `origin/noe-main` by 299；本轮新增 `.planning/` 和本文档 | `package.json` version `2.1.0` |
| Hermes | `/Users/hxx/Documents/Claw系audit_2026-06-09/hermes-agent` | `main` | `25c590ccd0c8` | `?? .unity/` | `package.json` version `1.0.0`; `pyproject.toml` project version `0.16.0` |
| OpenClaw | `/Users/hxx/Documents/Claw系audit_2026-06-09/openclaw` | `main` | `81eaa88ce56d` | `?? .unity/` | `package.json` version `2026.6.8` |

License / provenance:
- Hermes 主仓：MIT License, `/Users/hxx/Documents/Claw系audit_2026-06-09/hermes-agent/LICENSE`.
- OpenClaw 主仓：MIT License, `/Users/hxx/Documents/Claw系audit_2026-06-09/openclaw/LICENSE`.
- OpenClaw third-party notice：`THIRD_PARTY_NOTICES.md` 记录 Pi / pi-mono adapted portions, MIT。

Runtime snapshot:
- 51835 readiness：`ok:true`, readiness `passed`, loop/memory/fileIndex all `passed`.
- 51835 latest live probe：PID `7832`, started `Sat Jun 20 01:09:13 2026`, command `/Users/hxx/.nvm/versions/node/v22.22.2/bin/node server.js`; `/health` and `/api/noe/readiness` both returned 200 at `2026-06-20T01:21:04+0800`.
- 51735 observe-only listener：历史快照 PID `71420`；本阶段不操作 51735。
- retrieval log：阶段 0 快照为 `noe_memory_retrieval_log` 572 rows；Phase 2 baseline 快照为 606 rows。live DB 会继续增长，后续以 `scripts/noe-baseline-audit.mjs` 最新报告为准。
- 证据索引：`docs/EVIDENCE_2026-06-19_Hermes_OpenClaw_自进化阶段0.md`.

保护约束：
- 不覆盖现有未提交改动。Neo 的 `AGENTS.md` 是既有脏文件，本轮不碰。
- 阶段 1 只读分析 Hermes/OpenClaw，不复制代码。
- 阶段 2 只建证据底座和只读 trace 设计，不重启或改写 live 51835。
- 自改代码前必须有 replay/private_holdout/eval/rollback 证据。

## 1. 多模型与子代理门禁

每个阶段或可提交切片完成后必须过门禁：
1. 主线程直接检查关键证据。
2. 至少一个只读子代理做反向审查。
3. 可用时运行 Neo 现有多模型/共识命令，并记录实际参与模型；不可用时记录具体失败原因。
4. 阻塞问题修完后才能进入下一阶段。
5. 每个阶段都必须做阶段匹配的实机测试：只读阶段用真实机器上的 live 只读探针、真实 DB 只读聚合和真实命令验证；执行阶段才进入受控真实操作验证。每阶段实机测试后再由多模型和子代理给出结论与建议；静态审计、单测、报告不能替代阶段实机验证。

当前已启动只读子代理：
- Neo 能力与落点审计：已完成；结论是源码能力较全，主要缺 runtime/env/log 证据。
- Hermes 能力差距表：首版已完成并进入 `pass_with_followups`；后续只做更细 source-line provenance，不授权实现。
- OpenClaw 对照与可蒸馏项审计：已完成；结论是吸收 proposal-first、阈值化写入、fail-closed 权限、sandbox 原则，不吸收叙事包装。

阶段 0 多模型门禁：
- Command: `npm run noe:consensus:round -- --round-id 20260619-phase0-route-gate --run-models --ack-cost ...`
- Ledger: `output/noe-multimodel/20260619-phase0-route-gate/ledger.json`.
- Result: `consensus_passed`; Codex / Claude / M3 三票 `approve_with_changes`; dynamic quorum `3 available / threshold 2 / approvals 3`.
- 结论：只允许进入 Phase 1 只读蒸馏；不授权实现、自改代码、live 51835 改动、memory-v2 写回、提交、push 或发布。

## 1.1 Neo 当前能力基线

| 领域 | Neo 当前源码/运行证据 | 当前缺口 |
|------|----------------------|----------|
| agent loop | `src/loop/NoeLoop.js`, `src/loop/ActPipeline.js`; 51835 readiness loop `passed` | executor 覆盖率和 actMode 当前启用状态需更细 trace |
| skills / tool 管理 | `src/skills/SkillStore.js`, `src/skills/NoeSkillScanner.js`, `src/capabilities/ToolRegistry.js`, `src/mcp/McpStore.js` | `NOE_SKILL_SCAN` 默认 OFF；旧 skill reload 扫描未补；MCP 健康需独立证据 |
| gateway / relay | `server.js`, owner-token API/WS 路径；51835/51735 listener snapshot | 多渠道入站仍不是本阶段重点，避免为未启用入口补大基建 |
| memory / recall | `src/memory/MemoryCore.js`, `src/memory/NoeMemoryRetriever.js`, `src/memory/NoeMemoryAuditLog.js`; retrieval log 阶段 0 快照 572 rows，Phase 2 baseline 快照 606 rows | 需要证明 selected 进入真实 chat context，不只证明检索发生 |
| provider / model routing | `src/model/NoeLocalModelPolicy.js`, `src/room/BrainRouter.js`, `src/room/NoeConsensusRunner.js`; model health: LM Studio/Ollama/MiniMax/Xiaomi ok | Gemini/OpenAI/Anthropic API unconfigured；多模型 gate 当前可用组合是 Codex CLI + Claude CLI + M3 |
| permissions / security / secret | `src/permissions/PermissionGovernance.js`, `src/runtime/NoeContextScrubber.js`, `src/security/SsrfGuard.js`, `src/secrets/NoeProviderSecrets.js` | 需要持续测试防 secret 序列化；高信任模式下 deny > allow/fail-closed 要有回归 |
| context compression / session resume | `src/context/NoeTrajectoryCompactor.js`, `src/server/services/session-persistence.js`, `src/server/routes/sessionsContinuum.js` | 模块存在不等于 live 接入，需 replay/resume fixture |
| diagnostics / eval / trace | `npm run doctor:noe:lint`, `verify:noe:model-health`, `verify:noe:memory-*`, `test:noe:consensus`; doctor lint ok with dirty warning | 需要统一 NeoEvalCase/Run/Score 和 30-50 replay/private_holdout |
| self-evolution | `src/room/NoeSelfEvolutionGate.js`, `src/room/NoeEvolutionCandidateGate.js`, `src/room/NoeEvolutionHoldoutRunner.js`, `src/room/NoeEvolutionArchive.js` | 不能进入真实自改；先做 dry-run artifact/schema/holdout/rollback |

## 2. Hermes -> Neo 能力差距表

> 来源：主线程抽样 + Hermes 快速复核子代理。结论仍是只读蒸馏，不授权实现。

| Hermes 能力 | 源码位置 | Neo 是否已有 | Neo 落点 | 是否值得吸收 | 风险 | 验证方式 |
|-------------|----------|--------------|----------|--------------|------|----------|
| agent loop: Codex app-server 单 turn、崩溃退 session、usage 入账 | `agent/codex_runtime.py:176`, `:239`, `:271` | 部分已有 | BrainRouter / Codex adapter / runtime trace | P1 | 与现有 Codex CLI/adapter 生命周期冲突 | session crash retire 单测；工具超时后下一轮重拉起 |
| Responses streaming 抗 SDK/backend drift | `agent/codex_runtime.py:327`, `:380`, `:573`, `:669` | 未见等价结构 | Codex adapter / provider streaming 层 | **P0** | 事件归一错误会吞 tool_call 或丢 usage | fake SSE 覆盖 output=null、tool_call、incomplete、error frame |
| skills/tool: tool_search unwrap 后按 scoped deferrable names 二次校验 | `agent/tool_executor.py:135`, `:281`, `:292` | 部分已有 | SkillStore / skillInjector / AgentSkillRegistry / MCP tool bridge | **P0** | MCP/tool_search 桥接绕过 restricted toolset | restricted session 测试：桥接工具不能调用未授权底层工具 |
| skills/tool: pre-tool middleware、plugin block、guardrail block、mutation 前 checkpoint | `agent/tool_executor.py:184`, `:316`, `:345`, `:375`, `:392` | 部分已有 | PermissionGovernance / ExecPolicyStore / SafeActExecutors | P1 | 顺序错误会先副作用后拦截 | 顺序测试：block 时不得执行、不得写 checkpoint/结果 |
| 并发 tool 执行、ContextVar/approval 传播、interrupt fanout、heartbeat | `agent/tool_executor.py:243`, `:462`, `:553`, `:572` | 部分已有 | room dispatcher / permissions / task execution | P1 | 并发工具串 session/approval，取消不彻底 | fake long-running tools，stop 后线程清理、无残留 interrupt |
| gateway/relay: HMAC upgrade token + delivery signature + rotation verify list | `gateway/relay/auth.py:1`, `:83`, `:142` | 未见等价 relay | future inbound connector gateway | P1 | raw body 重序列化导致验签假阴性；轮换设计不完整会断连 | 跨语言固定向量；timestamp replay-window；不输出 token |
| gateway/relay: connector 能力描述、outbound/follow_up 语义动作，gateway 不持平台 capability token | `gateway/relay/transport.py:1`, `:77` | 部分已有 | Telegram/inbound channel / future connector vault | P1 | 搬错 capability vault 边界会让 gateway 持平台凭据 | 合约测试：gateway action 不含真实 token，tenant mismatch 失败 |
| gateway/status: PID/runtime lock、状态文件、stale lock 清理、跨平台 pid_exists | `gateway/status.py:44`, `:323`, `:425`, `:508`, `:617` | 部分已有 | doctor / panel process health / restart supervisor | P1 | 错删 PID/lock 会误杀或误判运行态 | fixture lock + fake pid/cmdline；macOS lsof/doctor smoke |
| desktop/dashboard 状态与诊断 | `gateway/status.py:508`, `:553` | 已有较多 | NoePanelLogTail / doctor tests / ACUI status cards | P2 | 重复状态源会分裂真相 | 只吸收 runtime status schema，不复制 UI |
| memory/OpenViking: provider lifecycle、session switch、pre-compress、delegation hooks | `agent/memory_provider.py:42`, `:175`, `:219`, `:231`; `plugins/memory/openviking/plugin.yaml:1` | 部分已有且 Neo 更深 | MemoryCore / NoeMemoryProviderManager / NoeExternalMemoryProviders | P2 | 外部 provider 引入凭据/网络/一致性风险；OpenViking 依赖本地 server | disabled adapter + mock provider session/compress hook |
| memory/OpenViking: browse/search/read/remember/add_resource | `plugins/memory/openviking/README.md:39` | 部分已有 | MemoryCore / NoeMemoryMarkdownMirror / retrieval sample | P2 | 与 memory-v2/source_episode 重叠，可能污染 salience | 只蒸馏知识浏览 URI 形状，不直接写生产 MemoryCore |
| provider/model routing + cost/usage | `agent/codex_runtime.py:77`, `:126`, `:138` | 已有 | BrainRouter / BudgetPolicyStore | P2 | 重复计费口径导致预算误报 | 保留 Neo router，吸收 usage canonicalization 测试 |
| permissions/security/secret 防泄漏 | `agent/tool_executor.py:423`, `:697`, `:1353`; `gateway/relay/auth.py` | 已有较强 | ContextScrubber / PanelLogTail / PolicyFileGuard tests | **P0 只吸收校验点** | 直接照搬 verbose logging 会打印 tool args/result 敏感内容 | secret corpus：verbose/debug dump 不含 Bearer/API key/owner token |
| context compression/session resume | `agent/memory_provider.py:175`, `:219`; `agent/codex_runtime.py:107` | 部分已有 | FocusStack / sessions / memory episode/sublimation | P1 | session_id 切换时 provider 缓存未换，会写错会话 | resume/fork/compression 后写入落到新 session 的测试 |
| debug dump/diagnostics/update/deploy | `gateway/status.py:508`; `agent/tool_executor.py:697`, `:1353` | 已有诊断 | doctor / cluster diagnostics / self-evolution gates | P2 | debug dump 易泄漏；deploy/update 属发布红线 | dump redaction；deploy/update gated，不吸收发布逻辑 |

Hermes P0/P1/P2 排序：
- P0：Responses streaming 抗 drift；tool_search unwrap session-scope 二次校验；debug/diagnostic 防泄漏测试补强。
- P1：relay HMAC 合约；gateway runtime lock/status；session resume/compression provider hook；并发工具取消/heartbeat/ContextVar 传播。
- P2：OpenViking provider 形状；dashboard/status UI；provider routing/cost usage canonicalization；update/deploy 保持 Neo 现有 gated 边界。

## 3. OpenClaw 对照

只看设计，不复制代码：
- 可蒸馏：skill root 发现、frontmatter 规范、加载预算、路径 containment、symlink 约束。
- 可蒸馏：Skill Workshop 的 proposal-first 流程，包括 hash 绑定、stale 检测、quarantine、rollback metadata、approval gate。
- 可蒸馏：memory/dreaming 的 preview/apply 阈值纪律，durable write 必须带 evidence/citation/visibility guard。
- 可蒸馏：tool descriptor/planner，把 owner、executor、availability、visible/hidden diagnostics 分离。
- 可蒸馏：before-tool-call permission pipeline，deny wins，approval fail-closed，loop detection，plugin/MCP hook 边界。
- 可蒸馏：sandbox 原则 no network、read-only root、cap-drop、blocked host binds、skills 只读挂载。
- 不吸收：Dreaming/REM/self-improvement 叙事包装。
- 不吸收：ClawHub/插件市场/发布认证生态、OpenClaw UI 绑定的 MCP channel bridge、Docker/ACPX/Codex-specific sandbox 映射、第三方 bundled skills/plugins 整包导入。

OpenClaw per-topic source evidence:

| OpenClaw topic | Source evidence | 可蒸馏进 Neo | 不吸收 / 风险 | Neo 落点与验证 |
|----------------|-----------------|--------------|---------------|----------------|
| skills discovery / limits / symlink containment | `/Users/hxx/Documents/Claw系audit_2026-06-09/openclaw/src/config/types.skills.ts`; `src/skills/lifecycle/workspace-skill-write.ts` | skill root、frontmatter、加载预算、support file path 规范、symlink target allowlist 思路 | 不复制写入实现；symlink 写入容易变成路径逃逸或热加载绕过 | `src/skills/NoeSkillScanner.js`; `src/skills/SkillStore.js`; 用 candidate gate 验证不写 SkillStore、不热加载 |
| Skill Workshop proposal-first | `src/skills/workshop/service.ts`; `src/skills/workshop/policy.ts` | pending proposal、draft hash、stale 检测、quarantine、rollback metadata、approval gate | 不吸收 OpenClaw 的 workspace proposal 存储格式；Neo 先保持 candidate-only | `src/candidates/NoeMemorySkillCandidateGate.js`; `tests/unit/noe-memory-skill-candidate-gate.test.js` |
| self-improvement / memory dreaming | `src/memory-host-sdk/dreaming.ts`; `src/memory-host-sdk/events.ts`; `VISION.md` | preview/apply 阈值、event log、promotion evidence、durable write 前置证据 | 不吸收 Dreaming/REM 叙事；不让记忆自动写回生产 memory-v2 | `src/memory/NoeMemoryUtilityLite.js`; NeoEval memory cases；验证 selected/引用/纠错/过期指标 |
| tool descriptor / planner | `src/tools/planner.ts`; `src/tools/availability.ts`; `src/tools/descriptors.ts` | descriptor、availability、visible/hidden diagnostics、executor 合约分离 | 不把 unavailable tool 静默暴露给模型；避免 executor/name 合约漂移 | `src/capabilities/ToolRegistry.js`; `src/mcp/McpStore.js`; 用 F3 MCP/tool smoke 和 risky 分类验证 |
| MCP config / tool filter | `src/config/mcp-config.ts` | MCP server config normalization、tool include/exclude filter、配置变更后再校验 | 不默认启用 MCP/A2A；不把 raw env/secret 写入证据 | `src/mcp/McpClientManager.js`; `scripts/noe-codex-mcp-smoke.mjs`; 验证 sanitized env 与 no raw secret |
| before_tool_call / trusted tool policy | `src/agents/agent-tools.before-tool-call.ts`; `src/plugins/trusted-tool-policy.ts` | deny wins、approval fail-closed、loop detection、plugin/MCP hook 边界、diagnostic 私有通道 | hook 顺序错误会先执行后拦截；verbose diagnostics 可能泄漏 tool args/result | `src/permissions/PermissionGovernance.js`; `src/runtime/NoeFreedomExecutor.js`; 单测验证 block-before-execute 和 redaction |
| sandbox / runtime config | `src/config/zod-schema.agent-runtime.ts`; `Dockerfile`; `README.md` | blocked host/container network、absolute bind validation、read-only plugin mount、cap-drop/least privilege 方向 | 不直接迁移 Docker/ACPX/Codex-specific sandbox 映射；Neo 自改代码仍只能 dry-run | CandidatePatchArtifact gate；Phase 4/5 dry-run 验证 no live 51835、no patch apply |
| plugin market / packaged ecosystem | `VISION.md`; `README.md`; `THIRD_PARTY_NOTICES.md` | 采用 provenance、publisher/security-review、bundle vs code plugin 的治理思想 | 不吸收 ClawHub、插件市场、第三方 bundled skills/plugins 整包；避免 license/provenance 混淆 | 只记录 capability pattern 和 MIT provenance；不复制源码、不导入第三方包 |

## 4. AI 自主学习 / 进化结论框架

本路线只接受工程可验证行为：
- 输入：真实 episode、tool/action/retrieval/verification 日志。
- 学习对象：memory utility、skill candidate、prompt/template、diagnostic/report formatter、planner ranking。
- 禁止把“模型自称学会了”当证据。
- 成功判据必须由 dev/regression/private_holdout 分层评测证明。

## 5. 自改代码安全协议

CandidatePatchArtifact 必须包含：
- `id`
- `parentRef`
- `diffRef`
- `scope`
- `reason`
- `evalPlan`
- `holdoutRef`
- `rollbackPlan`
- `provenance`
- `signature`
- `cost`
- `safety`

允许区 v1：
- 诊断器。
- report formatter。
- 排序参数。
- prompt 模板。
- 候选 planner。
- 测试/评测工具。

禁止区 v1：
- `src/loop`
- `src/permissions`
- `src/security`
- `src/webhook`
- consensus 脚本
- `package.json` scripts
- evaluator / holdout
- `.env`
- 51835 runtime 相关路径

dry-run 条件：
- 不开 `NOE_SELF_EVOLUTION_EXECUTORS`
- 不开 `NOE_SELF_EVOLUTION_STANDING_GRANT`
- 不提交
- 不 push
- 不重启 51835
- 不写 memory-v2
- 只生成 patch artifact 和报告

dry-run 验证：
- sandbox 隔离。
- 无真实 secret。
- 不能访问 holdout。
- 不能改 evaluator / CI / security / permission。
- secret scan。
- SAST/SCA。
- rollback dry-run。
- reward-hacking 检查。

## 6. P0/P1/P2 落地顺序

### P0
1. baseline audit。
2. NeoEvalCase / NeoEvalRun / NeoEvalScore schema。
3. 30-50 个真实 replay case + private_holdout 结构。
4. 只读 runtime trace：`observe -> can_execute -> act -> verify -> learn`。
5. memory / skill candidate gate。
6. memory utility learning lite。

### P1
1. DGM/SICA 风格 archive。
2. AgentBreeder 风格多目标评分。
3. PR 型自修复：branch + patch + draft PR 描述 + 验证报告，不自动 merge。
4. GraphMemory / PlanValidator / CausalRiskGate。

### P2 / 暂缓
1. live self-upgrade。
2. 自动合入、自动发布、自动重启 51835。
3. 自动写 memory-v2。
4. HyperAgents / recursive self-modification。
5. OpenPipe ART / RL / DPO。
6. MCP/A2A 默认启用。
7. DGM 直连生产自改代码。

## 7. 下一步

截至 2026-06-19T20:57:31+0800，原“最推荐的下一步”三件已经完成并扩展到后续 dry-run 阶段：
1. baseline audit：增强版已完成，只读实机测试、多模型 gate、子代理复核均通过，报告见 `docs/BASELINE_2026-06-19_Neo_证据底座基线审计.md`。
2. NeoEvalCase / NeoEvalRun / NeoEvalScore schema：本地 validator、离线 scorer、单测、CLI 与 fixture 已完成，见 `docs/NEOEVAL_SCHEMA_2026-06-19.md`、`src/eval/NeoEvalSchema.js`、`src/eval/NeoEvalScorer.js`、`scripts/noe-eval-validate.mjs`、`scripts/noe-eval-score.mjs`。
3. 30-50 个真实 replay case + private_holdout 结构：已生成 40 个脱敏 dev replay case；`private_holdout` 仍只提交结构和拒读纪律，不提交真实内容。

后续已经完成的受控切片：
1. Phase 3：memory/skill candidate gate v1 与 memory utility learning lite，均完成阶段匹配实机验证、子代理复核和 Codex/Claude/M3 gate。
2. Phase 4：CandidatePatchArtifact schema 与自改代码 dry-run gate，完成 sandbox/secret/SAST/SCA/rollback/reward-hacking 验证；没有 apply、commit、push、memory-v2 写入或 `51835` 重启。
3. Phase 5：archive dry-run、scorecard dry-run、PR repair dry-run、PlanValidator dry-run，均限制在 schema/report 范围；GraphMemory 写入和 CausalRisk runtime gate 继续暂缓。
4. Phase 6：B/C/D/E 授权实机阶段、Round Quality Memory v3、Neo F1-F4 全功能实机测试和 final closeout 已完成，最终状态是 `PASS_WITH_OPEN_BLOCKERS`。

当前不能说“全部无问题”。后续 runtime blocker repair track 已关闭 2 个运行时 blocker：
1. `curiosity_harvest_missing`：`source:"surprise"` 目标不再受普通 backlog 上限挤掉；完成 scoped live backfill、`51835` 重启、runtime evidence 复验、Locke 子代理审核和 Codex/Claude/M3 gate。证据见 `output/noe-runtime-repair/20260619-curiosity-backlog-v1/evidence.json`、`output/noe-runtime-evidence/runtime-evidence-1781875371691.json`、`output/noe-multimodel/20260619-curiosity-backlog-repair-v1/ledger.json`。注意：surprise goal 仍是 `research_not_completed`，不能宣称完整 curiosity research 已完成。
2. `affect_health_below_target`：affect health 改为 dimension-ratio saturation；完成 controlled live scratch drill、`51835` 重启、runtime evidence 复验、Euler 子代理审核和 Codex/Claude/M3 gate。证据见 `output/noe-runtime-repair/20260619-affect-health-v1/scratch-evidence.json`、`output/noe-runtime-evidence/runtime-evidence-1781876102236.json`、`output/noe-multimodel/20260619-affect-health-repair-v1/ledger.json`。注意：D5 仍是 `partial`，`backdoor_detection_not_measured_here` 仍未覆盖，strict affect health 仍有 `affect_saturation_high`。

截至 2026-06-20T01:36:21+0800，最新 baseline audit `output/noe-baseline-audit/baseline-audit-1781890581760.json` 报告 `blockers:[]`、`liveReadinessOk:true`、`liveHealthOk:true`、`protectedActsRouteAuth:true`；最终授权矩阵 `scripts/noe-final-stage-matrix-verify.mjs --require-complete` 报告 B/C/D/E 全部完成且无 error/warning。

external/manual blocker 当前状态已经更新：
1. `xiaohongshu_publish_editor_not_ready`：已由 2026-06-20 小红书实机发布/删除闭环关闭。Review Brain 首次阻塞原因是 `rawOutputRef missing`，补充脱敏 DOM proof 后 verdict 为 `approve`；最终发布点击改为小红书 split button 的 submit region。证据见 `output/noe-live-evidence/xhs-001mp4-publish-delete-final-evidence-1781887936945.json`。
2. `social_dom_probe_did_not_fill_upload_or_publish`：小红书 `/Users/hxx/Desktop/001.mp4` 端到端路径已实机覆盖：note manager 看到标题 `Noe测试001`、时间 `2026-06-20 00:48`、noteId `6a3572e00000000011011d68`，随后删除确认并验证目标标题/marker/noteId 均不存在。证据同上。注意：这证明小红书链路，不等于所有社交平台通用发布链路都已覆盖。
3. `voice_ear_acceptance_requires_owner_ear_review`：仍 open。语音主观听感必须由 owner 真耳验收，不能由日志或模型自评替代。

注意：runtime/baseline evidence 的 `blockers:[]` 只代表本轮运行时审计 blocker 已关闭；它不等于全部外部平台、人工听感、语义召回质量或 public URL 可见性都已无问题。小红书本轮发布后返回的是 editor `published=true` URL，不是 public post URL，所以 Neo runtime ledger 仍保持 `publishVerified:false`；最终闭环依据是 creator note manager 出现目标笔记并成功删除的实机证据。

下一步按目标可分两条：
1. 若继续完成原蒸馏路线：优先把 Phase 1 Hermes/OpenClaw gap table 做 source-path 级别的深度复核和证据补强。
2. 若目标改为无条件 Neo 全功能健康：继续处理剩余 `voice_ear_acceptance_requires_owner_ear_review`，并为小红书 public URL 可见性、跨平台社交发布链路、语义召回质量补独立实机/评测证据；随后重新跑实机测试、子代理审核和 Codex/Claude/M3 gate。

仍然不得进入：
- live self-upgrade。
- 自动合入、自动发布、自动重启 `51835`。
- 自动写 memory-v2、SkillStore、GraphMemory。
- HyperAgents / recursive self-modification / OpenPipe ART / RL / DPO。
- DGM 直连生产自改代码。
