# Task Plan: Hermes/OpenClaw/Neo 自进化蒸馏总路线

## Goal
全面了解本地 Neo、Hermes、OpenClaw 的真实代码与运行证据，先建立审计和 eval/trace 证据底座，再按多模型与子代理审核门禁依次吸收低风险能力。

## Current Phase
Phase 6: 最终实机授权阶段、Round Quality Memory v3 first slice、Neo 全功能实机测试 F1/F2/F3/F4 与最终 closeout 均已完成阶段匹配实机验证、子代理复核和 Codex/Claude/M3 多模型门禁。独立 runtime blocker repair track 已关闭 `curiosity_harvest_missing` 和 `affect_health_below_target`，最新 runtime evidence `output/noe-runtime-evidence/runtime-evidence-1781903936796.json` 报告 `blockers:[]`。后续小红书 `/Users/hxx/Desktop/001.mp4` 实机发布/删除闭环已关闭 `xiaohongshu_publish_editor_not_ready` 和 `social_dom_probe_did_not_fill_upload_or_publish`。语音自动化验收已在 owner-gate disabled 与临时 owner-gate enabled 两条路径通过 10/5/10 实机验证，owner-gate 已恢复，v3 子代理和 Codex/Claude/M3 gate 通过。最终状态仍是 `PASS_WITH_OPEN_BLOCKERS`，不是无条件 PASS；若目标升级为“Neo 全功能无问题”，还剩 `voice_ear_acceptance_requires_owner_ear_review` 这个人工听感验收 blocker。

## Phases

### Phase 0: 统一基线
- [x] 确认真实仓库路径
- [x] 记录分支、HEAD、dirty files、版本号
- [x] 确认不得覆盖现有未提交改动
- [x] 新建本任务规划文件
- **Status:** complete

### Phase 1: Hermes / OpenClaw 只读蒸馏
- [x] 完整分析 Hermes：agent loop、skills/tool、gateway/relay、desktop/dashboard、memory/OpenViking、model routing、permissions/security、context resume、diagnostics/update/deploy
- [x] 输出 Hermes -> Neo 能力差距表
- [x] OpenClaw 只读对照：skills/self-improvement/tool/MCP/memory/permission
- [x] 区分可蒸馏能力与包装层
- [x] 子代理/多模型审核本阶段结论
- **Status:** pass_with_followups; 必要主题已覆盖，未授权实现。OpenClaw source-path 表已补入 `docs/PLAN_2026-06-19_Hermes_OpenClaw_自进化蒸馏总路线.md` 和 `docs/EVIDENCE_2026-06-19_Hermes_OpenClaw_自进化阶段0.md`；后续可继续做更细 line-level provenance，但不阻塞进入已完成的 P0/P1 dry-run 底座。

### Phase 2: Neo 证据底座
- [x] baseline audit：memory recall、selected/dropped、tool-call success、verify fail、51835 runtime action、权限触发、prompt injection/SSRF/tool poisoning 风险点
- [x] 设计 NeoEvalCase / NeoEvalRun / NeoEvalScore
- [x] 建 dev / regression / private_holdout 数据分层
- [x] 为 NeoEval schema 加本地 validator 和最小 smoke fixture
- [x] 收集 30-50 个真实 replay case
- [x] 加只读 runtime trace 设计：observe -> can_execute -> act -> verify -> learn
- [x] 实现 append-only runtime trace writer、只读 snapshot CLI、golden fixture 和单测
- [x] 子代理/多模型审核本阶段结论
- **Status:** complete with follow-ups

### Phase 3: P0 最小闭环
- [x] 首批 P0 仅落 eval schema、runtime trace、memory/skill candidate gate v1
- [x] memory/skill candidate gate v1：候选必须保持 candidate-only，不直接写长期记忆、不写 SkillStore、不热加载 skill
- [x] 每个 candidate 必须记录来源 episode、evidence ref、测试结果、rollback plan、private holdout 结果
- [x] 建 memory utility learning lite：命中、被引用、被纠正、导致错误、过期、salience/utility score
- [x] 子代理/多模型审核后再进入下一切片
- **Status:** complete with follow-ups

### Phase 4: 自改代码安全闭环
- [x] 冻结 CandidatePatchArtifact schema
- [x] 输出非核心模块白名单 v1
- [x] 明确禁止区：src/loop、src/permissions、src/security、src/webhook、consensus、package scripts、evaluator/holdout、.env、51835 runtime 相关路径
- [x] 自改代码 dry-run：不开执行器、不提交、不 push、不重启 51835、不写 memory-v2
- [x] 验证 sandbox、secret scan、SAST/SCA、rollback dry-run、reward-hacking 检查
- [x] 子代理审核：Pascal final closeout `pass`，无 P0/P1 阻塞
- [x] 多模型 closeout gate：Codex/Claude/M3 3/3 approvals，ledger valid
- **Status:** complete for dry-run gate; next slice may start only within dry-run/schema/archive/report scope

### Phase 5: P1 扩展
- [x] DGM/SICA 风格 archive dry-run：父节点、diff、prompt、eval 输入、命令输出、成本、分数、失败原因、rollback ref 的 metadata-only schema/report
- [x] AgentBreeder 风格多目标评分 dry-run：能力、回归、安全、成本/延迟、reward-hacking 风险
- [x] PR 型自修复只生成 branch、patch、draft PR 描述、验证报告
- [x] eval/trace 稳定后再考虑 GraphMemory / PlanValidator / CausalRiskGate
- [x] GraphMemory / PlanValidator / CausalRiskGate 边界决策：只允许 PlanValidator dry-run/schema/report；GraphMemory 写入和 CausalRisk runtime gate 继续暂缓
- [x] PlanValidator dry-run：metadata-only plan refs/hashes/source report checks/policy/result flags；不执行 plan、不 apply patch、不碰 live 51835、不写 memory-v2/GraphMemory、不装 CausalRisk runtime gate
- **Status:** complete for dry-run/schema/report scope; archive、scorecard、PR repair、boundary decision、PlanValidator dry-run sub-slices each completed local real-machine verification, subagent review, and Codex/Claude/M3 consensus gate.

### Phase 6: 暂缓 / P2 边界
- [x] 明确不做 live self-upgrade、自动合入、自动发布、自动重启 51835、自动写 memory-v2
- [x] 明确不做 HyperAgents / recursive self-modification / OpenPipe ART / RL / DPO / MCP-A2A 默认启用 / DGM 直连生产自改代码
- [x] 输出最终实机测试矩阵和授权边界
- [x] 强化共享 evidence/ledger/handoff 记忆协议：模型读序、角色分工、anti-stale、disagreement、非 JSON 输出处理、模板和 handoff index
- [x] Round Quality Memory v3 first slice：正式 round 自动生成 `evidence.md`、`evidence-pack.md`、`disagreements.md`、`staleness-ledger.md`、`verifier-notes.md`、`final-handoff.md`，并增加 evidence/prompt redaction、assemble safe refs、raw-output redaction、active-executor unavailable gate、redaction policy visibility
- [x] Stage B：presence-only secret/keychain evidence，未读取 raw secret，子代理与 Codex/Claude/M3 v2 gate 通过
- [x] Stage C：sealed holdout metadata-only aggregate，未读取 raw hidden content，子代理与 Codex/Claude/M3 v4 gate 通过
- [x] Stage D：live 51835 scratch write with cleanup/rollback evidence，子代理与 Codex/Claude/M3 v1 gate 通过
- [x] Stage E：final 51835 restart recovery test，子代理与 Codex/Claude/M3 final B/C/D/E gate 通过
- [x] Neo 全功能实机测试 F1：core runtime/readiness/runtime-evidence/100-readiness/full-current 实机验证；Rawls/Dalton 子代理审核；v3 ledger 通过。注意：F1 v3 不是 Codex/Claude/M3 三票全票，M3 available 但 abstain，不能写成 M3 批准。
- [x] Neo 全功能实机测试 F2：read-only memory/cognition baseline、memory benchmarks、cognitive UI/command verify、growth-readiness 修复与复验；Rawls/Dalton 子代理审核；Codex/Claude/M3 v1 gate 通过；保留 blockers，不宣称 full memory/autonomy health
- [x] Neo 全功能实机测试 F3：tools/MCP/external readiness 实机验证；子代理审核；Codex/Claude/M3 v1 gate 通过
- [x] Neo 全功能实机测试 F4：UI/e2e/social/voice/media guarded paths 实机验证；子代理审核；Codex/Claude/M3 v1 gate 通过；保留 social/voice blockers
- [x] Neo 全功能最终 closeout：聚合 F1-F4、B/C/D/E、post-E stable-window checks、runtime evidence refresh、子代理 closeout 与 Codex/Claude/M3 final gate
- [x] Runtime blocker repair track：`curiosity_harvest_missing`、`affect_health_below_target` 已修复、实机复验、子代理审核并通过 Codex/Claude/M3 gate；最新 runtime evidence 为 `blockers:[]`
- [x] External/manual blocker track：小红书 `xiaohongshu_publish_editor_not_ready` 与 `social_dom_probe_did_not_fill_upload_or_publish` 已由 001.mp4 实机发布/删除闭环关闭。
- [x] Voice automated evidence track：owner-gate disabled 与临时 owner-gate enabled 两条 10/5/10 自动验收均通过；35 个音频文件技术校验通过；owner-gate 恢复摘要与测试前一致；post-restore runtime evidence `blockers:[]`；v3 子代理与 Codex/Claude/M3 gate 通过。
- [ ] External/manual blocker track：`voice_ear_acceptance_requires_owner_ear_review`
- **Status:** complete as `PASS_WITH_OPEN_BLOCKERS` for final-stage matrix, Round Quality Memory first slice, F1-F4/full-function closeout evidence, the two runtime blocker repairs, the Xiaohongshu publish/delete repair, and the voice automated evidence track. Not complete as unconditional full Neo health until owner human-ear review closes.

F0 naming note: the original F0 matrix named F1-F7, but current independent artifact packages are F1, F2, F3, F4, plus final closeout. Do not claim separate F5/F6/F7 artifact packages were completed unless new files and ledgers are created for those names.

## Current Open Blockers
Important distinction: latest refreshed runtime evidence reports `blockers:[]`, which closes the two runtime audit blockers below as runtime blockers only. It does not close owner subjective voice acceptance and must not be used as proof of unconditional Neo health.

| Blocker | Meaning | Required next proof |
|---------|---------|---------------------|
| `voice_ear_acceptance_requires_owner_ear_review` | programmatic voice checks passed in owner-gate disabled and enabled paths; human ear approval pending | owner ear review artifact closing `needsOwnerEarReview:true` |

## Closed External/Manual Blockers
| Blocker | Closure proof | Caveat |
|---------|---------------|--------|
| `xiaohongshu_publish_editor_not_ready` | `output/noe-live-evidence/xhs-001mp4-publish-delete-final-evidence-1781887936945.json`: editor reached publish flow; Review Brain blocker `rawOutputRef missing` fixed with sanitized DOM proof; final click uses Xiaohongshu split-button submit region. | The platform returned editor `published=true`, not a public post URL, so closure uses creator note-manager evidence. |
| `social_dom_probe_did_not_fill_upload_or_publish` | Same evidence: `/Users/hxx/Desktop/001.mp4` was filled/uploaded/published as `Noe测试001`, note manager showed time `2026-06-20 00:48` and noteId `6a3572e00000000011011d68`, then delete confirmation was clicked and title/marker/noteId were absent after delete. | Proves Xiaohongshu path only; does not prove every social platform or public URL visibility. |

## Closed Runtime Blockers
| Blocker | Closure proof | Caveat |
|---------|---------------|--------|
| `curiosity_harvest_missing` | `source:"surprise"` goals are backlog-exempt; scoped live backfill created one active surprise goal; refreshed runtime evidence removed the blocker; Locke and Codex/Claude/M3 approved with caveats. | Surprise goal still reports `research_not_completed`; this proves harvest/goal entry, not completed curiosity research. |
| `affect_health_below_target` | affect health now uses dimension-ratio saturation; live scratch drill produced mixed affect rows; refreshed runtime evidence removed the blocker; Euler and Codex/Claude/M3 approved with caveats. | D5 remains `partial` with `backdoor_detection_not_measured_here`; strict affect health still has `affect_saturation_high`. |

## Gate
每完成一个阶段或切片，必须先完成：
- 主线程直接检查关键证据，不把子代理结论当作唯一证据。
- 至少一个只读子代理审核结论。
- 可用时运行 Neo 现有多模型/共识命令；不可用时记录具体不可用原因。
- 修复阻塞问题后才能进入下一切片。
- 每个阶段都必须做阶段匹配的实机测试：只读阶段用真实机器上的 live 只读探针、真实 DB 只读聚合和真实命令验证；执行阶段才进入受控真实操作验证。每阶段实机测试后再由多模型和子代理给出结论与建议；静态审计、单测、报告不能替代阶段实机验证。

## Decisions Made
| Decision | Rationale |
|----------|-----------|
| 使用 `.planning/2026-06-19-hermes-openclaw-self-evolution/` | 避免污染仓库根目录，也便于后续窗口恢复。 |
| 阶段 1 保持只读蒸馏 | 用户目标要求先建证据底座，不直接复制 Hermes/OpenClaw 代码。 |
| 自改代码前必须先完成 baseline audit、eval schema、真实 replay/private_holdout | 没有独立评测和回滚证据时，自改代码无法证明收益且容易 reward hacking。 |
| `private_holdout` 只提交结构，不提交真实内容 | 防止候选 patch 或评测实现提前看到隐藏集，降低 reward hacking 风险。 |

## Errors Encountered
| Error | Attempt | Resolution |
|-------|---------|------------|
| `/Users/hxx/Documents/Neo 2/docs/HANDOFF_2026-06-19_代码蒸馏OpenClaw_SSRF链接理解Skill扫描.md` 不存在 | 1 | 定位到真实文件在 `/Users/hxx/Desktop/Neo 贾维斯/docs/` 并读取。 |
| Phase 4 初版 CandidatePatchArtifact gate 被 Pascal 判定 P0 不通过 | 1 | 已修命令 allowlist、scope 聚合、closed schema、validator checks、symlink realpath、白名单/禁区、refs 和测试缺口；Pascal closeout 已 pass。 |
| Semgrep 内置 SAST 扫描因本机 metrics 配置失败 | 1 | 记录为工具阻塞；用本地 SAST-lite `rg` 扫描覆盖本阶段 gate/CLI 的 child_process、spawn/exec、patch executor/self-evolution import/call 和 51835 操作风险。 |
| `npm audit --omit=dev --audit-level=high` 初次发现 high=1 | 1 | 最小更新传递依赖 `hono` 4.12.21 -> 4.12.26 后 high=0；仍有 moderate=13，记录为后续风险。 |
| Pascal closeout 后又发现 P1/P2 follow-up | 1 | 已修 holdout 三处状态、Vitest target 收窄、real output realpath 限定、cost 非负、未知 CLI 参数失败；Pascal final closeout `pass`。 |
| 规划文件落后于最终实机 closeout | 1 | 已用 F3/F4/final ledger verifier 和最终 evidence 同步 Phase 6 状态；最终仍保留 `PASS_WITH_OPEN_BLOCKERS`，不改写成无条件 PASS。 |
| 子代理发现 F0/F1 表述易误导 | 1 | 已补充：F1 v3 不能写成 M3 批准；原 F0 的 F5/F6/F7 没有同名独立 artifact，当前只声明 F1-F4 + final closeout 聚合完成。 |
