# Neo Multi-Model Operating Protocol

更新时间：2026-06-19

## 目标

让 Codex、Claude、M3 和子代理在处理 Neo 任务时读同一套事实、引用同一套证据、走同一套复验规则。token 成本不是主要约束时，优先提升准确性、可追溯性和实机可靠性。

## 事实源

唯一可信事实源是文件化、脱敏、带时间戳、可失效的证据：

- `.planning/2026-06-19-hermes-openclaw-self-evolution/task_plan.md`
- `.planning/2026-06-19-hermes-openclaw-self-evolution/progress.md`
- `docs/HANDOFF_*`
- `docs/DESIGN_*`
- `docs/DECISION_*`
- `docs/BASELINE_*`
- `output/noe-multimodel/<round-id>/brief.md`
- `output/noe-multimodel/<round-id>/evidence.md`
- `output/noe-multimodel/<round-id>/evidence-pack.md`
- `output/noe-multimodel/<round-id>/ledger.json`
- `output/noe-multimodel/<round-id>/codex.txt`
- `output/noe-multimodel/<round-id>/claude.txt`
- `output/noe-multimodel/<round-id>/m3.txt`
- `output/noe-multimodel/<round-id>/final-handoff.md`
- `output/noe-multimodel/<round-id>/disagreements.md`
- `output/noe-multimodel/<round-id>/staleness-ledger.md`
- `output/noe-multimodel/<round-id>/verifier-notes.md`

模型私有记忆、聊天印象、旧 live 结论、未复验摘要只能作为线索，不能作为 gate evidence。

## 禁止保存

任何共享记忆、模型 prompt、raw output、ledger、handoff、docs、planning 文件都不能保存：

- raw secret、密码、API key、owner token；
- `.env*`、`.npmrc`、`.netrc`、`room-adapters.json`、keychain 值；
- `evals/neo/private_holdout` 内容；
- raw memory body；
- 未脱敏 live 日志、browser DOM、stdout/stderr 中的敏感正文；
- provider-private 不可审计长期记忆；
- 未经验证的“当前 live 正常”断言。

## 启动读序

每个模型或子代理开始 Neo 任务前，按顺序读取：

1. 当前用户任务和授权边界。
2. `AGENTS.md`、`CLAUDE.md`。
3. `.planning/2026-06-19-hermes-openclaw-self-evolution/task_plan.md`。
4. `.planning/2026-06-19-hermes-openclaw-self-evolution/progress.md`。
5. 当前 round 的 `brief.md` 和 `evidence.md`。
6. 相关 `docs/HANDOFF_*`、`docs/DESIGN_*`、`docs/DECISION_*`、`docs/BASELINE_*`。
7. 关键源码、测试和脚本。
8. 当前实机命令输出。

如果没有当前实机输出，必须标记为 `unverified-current`，不能写成“当前成立”。

## 角色

| 参与者 | 角色 | 可写 | 主要职责 |
| --- | --- | ---: | --- |
| Codex | writer / integrator / final verifier | 是 | 修改文件、跑测试、整合结论、最终复验 |
| Claude | readonly adversarial reviewer | 否 | 找 P0/P1、测试缺口、边界漂移、证据不足 |
| M3 | suggestion-only cold reviewer | 否 | 挑战假设、补产品/风险角度、重排优先级 |
| 子代理 | scoped evidence collector/reviewer | 视任务而定，默认否 | 窄范围审计、负向探针、证据摘要 |

默认只允许一个 writer。除非用户明确切换 executor，否则 Codex 是唯一 writer。

## Context Budget

不节省 token 时，仍要分层供给上下文：

| 层级 | 内容 | 用途 |
| --- | --- | --- |
| Core pack | 当前任务、授权边界、task_plan、progress、当前 evidence、关键 docs | 所有模型必读 |
| Evidence pack | 相关 ledger、验证命令、输出摘要、源码/测试路径 | 评审和 gate |
| Deep pack | 关键源码、测试、设计原文、历史失败记录 | Claude/M3 深审 |
| Live pack | 刚刚实测的 runtime/readiness/model-health 输出 | 仅当本轮真实探针已跑 |

长上下文不等于无差别塞全仓库。每条结论必须能回指路径、命令或 ledger。

## Exhaustive Quality Mode

默认正式 round 使用 `qualityProfile=exhaustive`。token 成本不是主要约束时，不是简单重复问模型，而是增加结构化审查深度：

| 规则 | 目的 | 落地位置 |
| --- | --- | --- |
| 证据优先 | 每个 major claim 必须指向路径、命令输出、ledger，或标 `evidence_gap` | `brief.md`、per-model raw output、`ledger.json` |
| P0/P1/P2 | 阻塞、风险、后续优化分级，避免把建议和 blocker 混在一起 | `blockers`、`recommended_first_slice`、`verifier-notes.md` |
| Policy != enforcement | 明确检查“文档写了”是否真的有 evaluator/test/runtime 证据 | 子代理审查、Claude review、Codex final verifier |
| Fresh live pack | live `51835`、sealed holdout、owner-token、restart 只能用本阶段新证据 | `staleness-ledger.md`、最终实机矩阵 |
| Role-specific blind spots | Claude 找 P0/P1 和边界漂移；M3 找 actionable_risk / evidence_gap / product_language_issue；子代理做窄范围证据采集 | `src/room/NoeConsensusRunner.js` prompt |
| Minimum falsifier | 每个 approve/reject 都写最小可证伪验证，减少重复审查 | `verification_required`、`verifier-notes.md` |
| Same-model JSON repair | 模型输出无法解析时，对同一模型重问一次；只有修复后的同模型 JSON 可计票 | `manifest.json`、`participant_json_repair` artifact |
| Fallback non-quorum | 模型不可用时 Codex fallback 只做补充证据，不冒充该模型投票 | `manifest.json`、`ledger.json` |
| Blocker zero | counted approval 的 `blockers` 必须为空；修复建议放 `recommended_first_slice` 和 `verification_required` | `src/room/NoeConsensusGate.js` |
| Active-executor approval | 被选中的 writer / active executor 必须明确 `approve` 或 `approve_with_changes`；`abstain` / `reject` / `unavailable` 即使动态 quorum 够票也不能继续 | `src/room/NoeConsensusGate.js` |
| M3 max thinking profile | `exhaustive` round 的内置 M3 使用 `thinking:{type:"adaptive"}`、`reasoningSplit:true`、`maxCompletionTokens:524288`、`serviceTier:"priority"`、`noAbort:true`；`adaptive` 是 MiniMax-M3 thinking-on 模式 | `src/room/NoeConsensusRunner.js`、`src/room/MiniMaxChatAdapter.js`、`manifest.json` |
| Same-round visibility boundary | 模型不能在生成前看到同轮其它模型的最终投票；不要要求模型证明“本轮 Codex 已 approve”这类自指事实，交给 `ledger.json` + verifier 复验 | `verifier-notes.md`、`scripts/noe-consensus-ledger-verify.mjs` |

`standard` 只允许在用户明确要低成本或轻量讨论时使用；B/C/D/E、live/runtime、secret/holdout/restart、patch/apply、自进化相关 round 必须使用 `exhaustive`。

## Review Cadence

2026-06-20 起，正式执行节奏改为：

- P0/P1 必审：一旦出现 P0/P1，立刻停止推进，先做本地复现/修复，再开 Codex/Claude/M3 多模型 gate。必要时追加窄范围子代理。
- P2 批量审：P2 不再每个小点单独开一轮；先批量合并，本地验证和证据更新完成后，集中做一次多模型 gate。
- 只读复审优先用 Claude/M3 等非 writer 模型；Codex 子代理只在需要本地并行代码检查、其他模型不可用、或模型结论冲突时补位。
- 已经启动的模型 round 不主动中断；下一轮按上述节奏执行。
- P2 修复后如果只改变说明文案或证据索引，优先本地 hash/redaction/schema 验证；累计成批后再统一多模型复核。

### Historical Lessons

本轮多模型和子代理运行暴露的高价值经验：

- 只写 policy 不够；早期 gate 出现过 `noLiveAction/noRuntimeRestart/noMemoryV2Write` 写在报告里但 evaluator 未实际拦截的 P0。
- evidence ref 过宽会导致 secret/private_holdout/.env/owner-token 路径被间接读入；后续所有 gate 都要验证 input/output/ref 边界。
- Claude 曾有非 JSON / unavailable 输出；必须记录 `parseStatus`，并保持 fallback `countedInConsensus=false`。
- Claude 本轮还出现过完全自然语言输出；正式 runner 现在先做一次同模型 JSON 重问，仍失败才进入 unavailable/fallback。
- 旧 live `51835` 证据很容易被误当当前事实；live 结论必须带 `observedAt` 和失效规则。
- M3 适合冷启动挑战和风险重排，不应承担 writer/执行/最终签字。
- 子代理最有效的任务是窄范围挑刺和负向探针，不是重复主线程的全量阅读。
- `consensus_passed` 过去可能被误读为“无问题”；新 gate 要求 yes vote 无 blocker、approval 有验证项，避免带 blocker 的 approve 直接推进。
- 2026-06-19 F1 v2 暴露了 active executor abstain 的质量洞：Claude+M3 quorum 够票但 Codex active executor abstain。现已固化为 gate blocker：`active_executor_must_approve:<id>`。
- 2026-06-19 F1 v3 暴露了同轮可见性边界：M3 无法在生成时看到 Codex 同轮 vote。此类事实由 ledger verifier 验证，不再要求模型自证同轮状态。
- 2026-06-19 F2 暴露了“拆文件不等于控复杂度”：`NoeConsensusRunner.js` 拆成 prompts/supportFiles/participantRuntime 后，行数 gate 必须覆盖新模块和新测试，否则只是把复杂度挪走。现已把拆分模块纳入 self-evolution verifier。
- 2026-06-19 F2 暴露了 fallback quality 继承缺口：仅把 `qualityProfile` 传给 injected runner 不够，内置 Codex fallback prompt 也必须嵌入 exhaustive 指令；Codex 非 active executor 时 fallback 还必须是 `advisory_supplemental` / `canWrite:false`。
- 2026-06-19 F2 确认阶段 evidence package 要 summary-only：正式 gate 只引用 `F2-memory-cognition-results.json` / `F2-memory-cognition-evidence.md` 的摘要和 refs，不能把底层 raw report、UI snippet、memory IDs、owner-token 相关报告全文塞进模型 prompt。

## Round Quality Memory (Round Artifacts Only)

自 2026-06-19 起，正式 round 不再依赖主线程手工补齐共享记忆文件。`src/room/NoeConsensusRunner.js` 默认生成并在 `manifest.json` / `ledger.json` 里登记：

- `evidence.md`：脱敏后的 evidence 原文、hash、goal、qualityProfile；
- `evidence-pack.md`：本轮 goal、status、support files、vote summary、artifact summary、gate summary；
- `disagreements.md`：parse/unavailable/reject/abstain/blocker/gate error 的机器辅助清单；无分歧时写 `status: none`；
- `staleness-ledger.md`：按 live/runtime、model/provider、secret、sealed holdout、side-effect 分类标出失效规则；
- `verifier-notes.md`：ledger 复验命令、直接证据文件和 gate error；
- `final-handoff.md`：下一窗口或外部模型恢复读序、当前 status、边界提醒。

新增默认：

- evidence-text 在写入 `brief.md`、support files 和模型 prompt 前统一走脱敏；
- `ledger.artifacts[]` 增加 `round_support_files`，但 `countedInConsensus=false`；
- 这些文件不是额外投票，也不能替代实机验证；它们只让后续模型和子代理读取同一套、可失效、可复验的事实。
- 这不是 memory-v2、SkillStore 或 GraphMemory 写入；它只写当前 round 的可审计 artifacts。

当前 redaction policy 摘要：

- provider env assignment：`MINIMAX_API_KEY` / `OBSIDIAN_API_KEY` / `OPENAI_API_KEY` / `XIAOMI_API_KEY`；
- authorization bearer header；
- panel owner token header / field；
- OpenAI-style `sk-` key；
- Xiaomi-style `tp-` key；
- owner-token query parameter。

后续所有 Neo 全功能实机测试阶段都必须使用这套 round quality memory：每个阶段的 evidence pack 先写入，再由子代理和 Codex/Claude/M3 gate 审核。旧 round 若缺这些文件，只能作为历史背景；新 claim 需要新 round。

## B/C/D/E Stage Matrix

最终实机测试使用机器可验证授权矩阵：

- `output/noe-multimodel/20260619-final-real-machine-authorization/authorization.json`
- `scripts/noe-final-stage-matrix-verify.mjs`
- `src/runtime/NoeFinalStageMatrix.js`

矩阵规则：

| Stage | 允许 | 禁止 | 完成证据 |
| --- | --- | --- | --- |
| B | 最小范围使用 secret 的配置机制 | raw secret read / raw token output | redacted stage-B JSON |
| C | sealed private_holdout aggregate | raw private_holdout case content | redacted stage-C JSON |
| D | live `51835` scratch write | 非 scratch 写入、无 rollback 写入 | redacted stage-D JSON + rollbackRef |
| E | 最后一次 restart recovery | A-D 未清 P0 时执行 | redacted stage-E JSON + `finalRestartRecovery:true` |

最终 closeout 必须用 `--require-complete` 验证矩阵；缺任一 stage 证据，不能声称“全部实机测试完成”。

## Subagent Pattern

不惜 token 时，子代理默认按以下模式使用：

| 阶段 | 子代理职责 | 输出要求 |
| --- | --- | --- |
| 设计/协议 | 找概念漏洞、成功标准是否可检查、边界是否漂移 | P0/P1/P2、缺失证据、建议命令 |
| 代码改动 | 只读审查 touched files、测试覆盖、path/ref/secret/live 边界 | 文件行号、可复现探针、是否阻塞 |
| 实机测试 | 审查 evidence 是否足以支持当前 live 结论 | stale 标记、遗漏路线、rollback 风险 |
| 最终汇总 | 检查 claims 是否都有 evidenceRef 或 `needs_verification` | final claims coverage、残余风险 |

不要让多个子代理做同一件事。并行只用于互补职责：一个看 runtime/live，一个看 security/path/ref，一个看 evidence/ledger。

## Anti-Stale Rules

| 证据类型 | 默认有效期 | 过期后规则 |
| --- | ---: | --- |
| live `51835` readiness / health | 15 分钟 | 重新只读探针，否则标 `stale-live` |
| model health / provider availability | 30 分钟 | 重新 health snapshot，否则标 `stale-provider` |
| CLI smoke / focused unit | 当前工作树变更前 | touched 文件变更后重跑 |
| SCA high/critical | 24 小时或 lockfile 变更前 | lockfile 变更后重跑 |
| docs/design decision | 7 天或被新 decision supersede 前 | 标 `review-needed` |
| handoff/progress | 下一阶段开始前 | 新阶段必须刷新 |
| multi-model ledger | 绑定 evidence hash | evidence 改动后不能复用旧 quorum |

旧证据可以作为历史背景，但不能证明当前 live/runtime 状态。

## Failure Classes

本协议重点防四类 Neo 任务失败：

| 失败类型 | 典型表现 | 必要防线 | 证据位置 |
| --- | --- | --- | --- |
| stale memory | 把旧 handoff 或旧 live proof 当当前事实 | staleness-ledger、重新实机探针 | `output/noe-multimodel/*/ledger.json`、`.planning/*/progress.md` |
| hallucinated live state | 静态代码存在就声称 live 已运行 | live pack 必须有刚跑的命令输出 | `output/noe-baseline-audit/latest.json`、`output/noe-runtime-evidence/latest.json` |
| role overlap | 多模型同时当 writer 或替不可用模型投票 | 单 writer、fallback 不计入被替代模型 | `src/room/NoeConsensusRunner.js`、`ledger.json` |
| unparsed model vote | 模型输出自然语言而不是 JSON，导致无法计票 | 同模型 JSON repair 一次；成功才计同模型票，失败则 ledger 标 `unavailable` 且 Codex fallback 不计 quorum | `output/noe-multimodel/*/*.unparsed-attempt-1.txt`、`*.json-repair-attempt-1.txt`、`ledger.json` |

## Success Criteria

共享记忆增强是否有效，用以下阈值复查：

| 指标 | 通过阈值 |
| --- | --- |
| Final claims coverage | 100% final claims have `evidenceRef` or `needs_verification`. |
| Live/runtime freshness | 100% live/runtime/provider claims have `observedAt` plus `expiresWhen`, or are marked `stale` / `unverified-current`. |
| Round handoff | Every formal round has `final-handoff.md`, or final report explains why it is absent. |
| Disagreement tracking | Every formal round has `disagreements.md`; if no disagreement exists, status is `none`. |
| Direct evidence read | Gate closeout includes `verifier-notes.md` with at least one direct file/command evidence entry per major claim class. |
| Ledger freshness | A ledger may be reused only when its `evidenceRef` and evidence content are unchanged; changed evidence requires a new round or explicit re-review. |
| Unparsed model output | 100% unparsed model outputs either have a same-model repaired JSON artifact or remain `countedInConsensus=false` and appear only as unavailable/fallback evidence. |
| Secret/body scan | High-signal secret/body scan over new shared-memory files returns 0 matches. |
| Side-effect boundary | Final evidence states `No live 51835`, `No memory write`, `No patch apply`, and `No git/gh/publish`, unless a separate explicit authorization ledger exists. |

## Disagreement Resolution

1. 把分歧写入 `disagreements.md`。
2. 拆成 `claim -> evidenceRef -> verification command`。
3. 事实分歧由 Codex 跑最小实机命令裁决。
4. 判断分歧写入 decision record，说明取舍和风险。
5. 无法复验的结论降级为 `hypothesis`，不能进入 gate verdict。

投票不能替代证据。三个模型都同意一个陈旧证据时，仍然不算当前事实。

## Round Required Files

每个正式多模型 round 必须包含。新 runner 会自动生成；历史 round 若缺失，最终汇报必须说明并用新 round 补证：

- `brief.md`
- `evidence.md`
- `evidence-pack.md`
- `manifest.json`
- `codex.txt`
- `claude.txt`
- `m3.txt`
- `ledger.json`
- `disagreements.md`
- `staleness-ledger.md`
- `verifier-notes.md`
- `final-handoff.md`

缺少任一文件时，最终汇报要明确说明为什么缺失。

## Promotion Rules

- discussion -> protocol：必须有多模型建议和主线程整合。
- protocol -> implementation：必须有本机验证、子代理复核、多模型 gate。
- implementation -> live behavior：必须另开授权，不能由协议文档自动解锁。
- any memory writeback：必须有脱敏摘要、通过的 ledger、明确 consensus ack。

## Still Not Authorized

本协议不授权：

- live self-upgrade；
- 自动 merge / commit / push / PR / publish；
- 自动重启 live `51835`；
- 自动写 memory-v2 / SkillStore / GraphMemory；
- 安装 CausalRisk runtime gate；
- 读取 secret/private_holdout；
- 付费 API 或外部发布。
