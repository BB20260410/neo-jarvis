# Neo 审计修复与进化计划 (2026-06-14)

> **For agentic workers:** 用 `superpowers:executing-plans` 或 `subagent-driven-development` 逐任务实施。步骤用 checkbox（`- [ ]`）追踪。本计划由 Claude×Codex 双轨互印证审计（Phase 1）产出，每项标注来源 [双印证]/[Claude独有]/[codex独有]。

**Goal:** 把 Phase 1 互印证确认的缺陷按优先级修复，并规划 Neo 中长期进化（协作基础设施、记忆系统、自进化闭环加固）。

**Architecture:** 4 批次——批次0/1 是 P8 门内可做的 bug 修复（正确性/防外泄/对外发布安全）；批次2 是基础设施进化（codex-collab MCP、测试加固、巨石拆分）；批次3 是受 P8 门约束的路线图推进（6/20 后）。已按 owner [自由最大权限] 宪法过滤掉权限管控类"修复"。

**Tech Stack:** Node ES module + Express + SQLite(better-sqlite3) + vitest。变更纪律=小步 + env 门控 + 先测后改 + 不自动 commit + 单 writer + 对方 post-review。

**审计依据:** Claude workflow(8域/63确认) + codex-A(域1-4/5) + codex-B(域5-8/9)。

---

## 约束与明确不做项（边界先行）

**P8 观察门**：6/20 前禁 P9-A0/D0/G0 + R line。bug 修复属"修复现有缺陷"非"路线图推进"，**批次 0/1 门内可做**；批次 3 能力推进受门约束。每批次执行前跑 `npm run verify:noe:p8-observation-gate` 确认未误入禁区。

**按 owner [自由最大权限] 宪法明确不做**（权限管控/危险命令阻断/protectedPaths，非数据/正确性/防外泄）：
- ❌ path-sandbox 收紧 home 黑名单 [codex high] —— 127.0.0.1+owner token 读给自己不外泄，属 protectedPaths 硬护栏
- ❌ NoeFreedomExecutor 绕过 DangerousPatternDetector [Claude high] —— owner 要的本机执行自由
- ❌ noeFreedom auto-promote developer_unrestricted [Claude med] —— owner 要的自由
- ❌ McpStore sanitizeArgs 过滤 shell 元字符 [Claude low] —— 经 mcp-builder 标准裁定：stdio 走结构化 command/args 非 shell 字符串(McpClientManager→StdioClientTransport)，无 shell-string 注入；残余是"用户显式配 `bash -lc ...` 作 server command"的信任边界问题，非 args 过滤能解 → 改为补"stdio 不走 shell"回归测试(批次2.2)
- （注：`commandDeletesProtectedPath` 原列此处，经 codex review 重新归类——代码已具备 $HOME/~ 展开保护，移至批次1"补回归验证"，非"不做"）

---

## 批次 0：高优先 bug（正确性 / 防外泄 / 对外发布安全 —— P8 门内立即做）

> 执行顺序建议：0.1 → 0.2（对外发布，碰红线5最危险）→ 0.3 → 0.4 → 0.5。每项单 writer 改 + 对方 post-review + 先写复现测试。

### Task 0.1 修记忆 projectId='neo' 孤儿 [Claude独有 high]
**Files:** Modify `src/memory/NoeMemoryCandidateApply.js:69`；Test `tests/unit/noe-memory-candidate-apply.test.js`
- [ ] Step1 写失败测试：owner 审批 candidate apply（非 dryRun）后，用生产默认 `projectId:'noe'` 能 `recall` 到该记忆
- [ ] Step2 改 `:69` 硬编码 `projectId:'neo'` → `candidate.projectId ?? 'noe'`（与 NoeTurnContextEngine/NoeMemoryRetriever/SoloChatDispatcher 全用 'noe' 对齐）
- [ ] Step3 `npm test -- tests/unit/noe-memory-candidate-apply.test.js` 绿
- [ ] Step4 检查存量：是否已有 'neo' 分区孤儿记忆需迁移（只读统计，迁移需 owner 确认）
- [ ] Step5 [codex review 补]：同查 `NoeMemoryCandidateRollback` 侧是否也有 projectId:'neo' 假设，补回归测试

### Task 0.2 对外发布链加固（碰红线5，最危险）
**Files:** `src/runtime/NoeSocialPublishQueue.js`、`NoeSocialPublishWorkflow.js`、`NoeSocialMediaUploadExecutor.js`、`NoeSocialFinalPublishExecutor.js:119`、`NoeSocialRollbackEvidenceGate.js:206`
- [ ] Step1 `externalSideEffectPerformed` 标志写回磁盘持久化 [Claude high]——防重复对外发布
- [ ] Step2 `workflow.prepare` 不得覆盖 state≠draft 的已发布草稿 [Claude high]
- [ ] Step3 媒体上传成功判定要求真实文件数>0，禁"已在上传页"误判成功 [Claude high]
- [ ] Step4 final publish 的 evidence 必须由 chain 注入真实 stage summary，禁 args 自带 + requireDraft:false 绕过 [codex high]
- [ ] Step5 rollback evidence gate 必须验证 consensusLedgerRef 文件存在+passed+可信 cycle，禁任意非空 ref 过门 [codex high]
- [ ] Step6 每项配失败测试（覆盖"已发布真分支"等测试盲区 [Claude]）
- [ ] Step7 全程 dry-run 验证，绝不触发真实对外发布

### Task 0.3 self-model apply 审批绑定 [双印证 high]
**Files:** `src/runtime/NoeProposalDecisionLedger.js:29`、`NoeProposalInbox.js:206`、`src/server/routes/noeProposals.js:113`
- [ ] Step1 失败测试：同 id/source/type/title 但不同 patch 值的两份 proposal 应得不同 hash（当前同 hash `69c2...`）
- [ ] Step2 decision hash 纳入 patch 值/patchFields 内容（不只元数据）；apply 时校验 latest.json 的 patch 与审批时一致（消除 TOCTOU）
- [ ] Step3 测试绿

### Task 0.4 防外泄：secret broker 不经 stdout [codex独有 med，防外泄]
**Files:** `src/secrets/NoeSecretBroker.js:59`、`src/runtime/NoeFreedomAdapters.js:279`
- [ ] Step1 失败测试：`readKeychainMetadata` 的 spawn args 不含 `-w`（不读 secret 明文到 stdout）
- [ ] Step2 metadata 查询改用不带 `-w` 的 `security find-generic-password`（只取元数据），杜绝 secret 经 stdout/进程内存
- [ ] Step3 测试绿 + 确认 `secretValuesReturned:false` 名实相符

### Task 0.5 VoiceSession 记忆污染（P8-safe 防污染 bugfix，不启动 R line）[research 分支双印证]
**Files:** `src/voice/VoiceSession.js:362`、`src/research/ResearchIntent.js:108`、`VoiceSession.js`(superseded)
- [ ] Step1 research 分支补 `finish_reason=length` incomplete guard，半截总结不写 history/记忆 [双印证]
- [ ] Step2 被代际栅栏 superseded 的旧回复不写 history/长期记忆 [Claude high]
- [ ] Step3 动作桥（记住/提醒）在 turn superseded 时不执行真实写库副作用 [Claude med]
- [ ] Step4 失败测试覆盖以上（复用 Phase 0 的 incomplete 测试模式）

### Task 0.6 自进化 Gate postReview/inline ledger 收口 [codex review 升批次0，high]
**Files:** `src/room/NoeSelfEvolutionGate.js:172`、`:82`；Test `tests/unit/noe-self-evolution-gate.test.js`
> codex review 指出：complete 阶段只凭 `ok:true+approvals≥1` 过关，与 NoeSelfEvolutionCycle 的动态 quorum/raw evidence 不一致 = 授权绕过，从批次1升批次0。
- [ ] Step1 失败测试：postReview `{ok:true,approvals:1}` 但无真实非实施者 reviewer/rawRef/动态 quorum 时，complete 应被阻断
- [ ] Step2 Gate/Loop 的 postReview 校验对齐 Cycle 层（排除 active executor + 必需 reviewer + 动态 quorum + rawOutputRef）
- [ ] Step3 inline ledger(:82) 要求 evidence/raw 文件存在，不能仅凭 consensusApproved=true 当 validated_consensus_ledger
- [ ] Step4 `npm run verify:noe:self-evolution` 绿

---

## 批次 1：中优先 bug（正确性 / 资源 / 自进化闭环 —— P8 门内可做）

> 列出 file:line + 修法要点 + 验证入口；执行时用 writing-plans 展开完整 task。

- **consensus/自进化授权链**（双方独立盯上，高置信薄弱区）：
  - `NoeConsensusRound.js:84` 投票身份用 `parsedModel||normalizedModel`，模型自报内容可冒充身份 [Claude high]→ 校验 parsed.model 与可信槽 participant.model 一致
  - `NoeEvolutionCandidateGate.js:83` holdout.minDelta / growth.maxGrowthRatio / growth.approvalRef 候选自设绕过 [Claude high/med]→ 用 Math.max/clamp 护栏，approvalRef 验真
  - （`NoeSelfEvolutionGate.js:172` postReview 弱校验 + `:82` inline ledger 已升至**批次 0 Task 0.6**，见上）
  - 验证：`npm run verify:noe:self-evolution`、`npm run test:noe:consensus`
- **ActPipeline dry-run/apply 边界** [双印证 med]：`ActPipelinePreflight.js:110` permission 评估 dry_run 但 `ActPipeline.js:194` 因 realExecute:true 走 #executeReal → permission 与执行模式必须一致；`:127` context sufficiency 用 payload 自带 result 不调 evaluator [codex med]→ 强制真实 evaluator。验证 `npm run test:p0:unit`(noe-act-pipeline*)
- **observation 门** [Claude]：`noe-observation-status.mjs` report.ok 漏判 hermes.available(high)；`noe-p8-observation-gate.mjs` 只信 readable 自声明不验 ref 文件存在[codex] + mtime 重置窗口[Claude] → 验 ref 文件 + 用稳定锚点。验证 `npm run verify:noe:p8-observation-gate`
- **freedom Review Brain 不阻断** [codex high]：`NoeFreedomExecutor.js:786` 生成 verdictRequiredBeforeFinalDecision 但只赋值不调 review brain/不等 verdict → 高风险 action 必须真实等待 approve/block（这是"声称的复核没生效"=正确性，非加新护栏）
- **commandDeletesProtectedPath 回归验证** [codex review 重新归类]：代码已在 executor+adapter 两处展开 $HOME/~ 覆盖 ~/.noe-panel（已具备保护，非"不做"）→ 仅补回归测试确认覆盖，不新增护栏
- **资源/泄漏**：img-cache OOM 无界 arrayBuffer [Claude high]→ 流式+Content-Length 上限；`SqliteStore` 迁移备份 WAL 不复制 [双印证 med]→ 用 SQLite backup API 或 checkpoint+复制 WAL/SHM；openai 流式客户端断开不中止上游子进程 [Claude low]；NoeProviderHealth fetch 无 timeout [Claude low，注意 owner 规则不给模型调用设超时，仅 health probe 可设]
- **入站 replay 空 key** [双印证 med]：`noeSocialInbound.js:221` 缺 message_id 时空 key 不防护 → 空 key 视为不可去重、拒绝或降级处理
- **memory 整理类** [Claude]：NoeEpisodeSublimation 重复沉淀(med)、valid_from 重置(low)、NoeNightlyReflection 重复 insight(low)、provenance abs(time)误配[Claude low]+跨project饥饿[codex med] → 加去重/水位线健壮性/因果方向过滤/project 优先查询

---

## 批次 2：基础设施进化（提升开发与协作质量）

### 进化项 2.1 codex-collab MCP server（用 mcp-builder 搭，解决裸 spawn 脆弱）
**动机**：本轮实证——并发 spawn `codex exec` 会撞 codex app-server 单会话限制致失败（codex-B 第一次死）。裸 spawn + 写 /tmp prompt 也繁琐。
**蓝图**（按 mcp-builder 标准）：
- Node + `@modelcontextprotocol/sdk`，**stdio** transport（本地单用户），server 名 `codex-collab-mcp-server`
- 工具（snake_case + 服务前缀 + annotations）：
  - `codex_independent_analysis`(readOnlyHint:true)：输入 {task, repoDir, contextFiles[], mode}，内部串行调度 codex exec read-only，返回结构化分析
  - `codex_review_diff`(readOnlyHint:true)：输入 {repoDir, base|commit|uncommitted}，封装 codex review
- **跨进程 lock file**[codex review]（带 PID/cwd/stale 检查，不只进程内锁——根治多个 Codex/Claude 窗口同时 spawn 的全局冲突，这正是今天 codex-B 第一次死的根因）+ 输入校验(repoDir sanitize) + 错误回 result.isError + stderr 日志(不污染 stdout)
- prompt 走 stdin 不写 secret 到 /tmp；输出进 per-run artifact 目录；工具**默认 read-only**；stderr/stdout 脱敏
- 注册到 Claude Code mcpServers；装后下次会话我可直接 MCP 调 codex，免 spawn CLI
- **默认 disabled/read-only first，不计入 Neo 能力进化证据**[codex review]（它是开发协作基础设施，非 Neo 产品能力，避免与 P8 观察门的能力证据混淆）
- 收益：协作从"裸 spawn 脆弱"升级为"受管、可重试、结构化"

### 进化项 2.2 测试盲区补全 [Claude/codex 多处标注]
- social "已发布真分支"幂等、img-cache SVG-XSS+大响应 DoS、p8 gate 缺 evidence 文件、provenance noisy-project 饥饿等盲区补测

### 进化项 2.3 巨石文件拆分（既有债，统一规划非单独归咎）
- `noe-world-earth.js` 1244 行、`NoeBootSelfCheck.js` 552 行、`NoeWorkMapSnapshot.js` 536 行等 28 个 500+ 文件，按 CLAUDE.md <500 约定分批拆

---

## 批次 3：路线图推进（受 P8 门约束，6/20 门通过后）

- 记忆 v2 生产闭环：启用语义 provider / 维护 loop dry-run→受控 apply / 历史 orphan 来源回填——**需 owner 显式 override P8 gate**（DESIGN_2026-06-13 明列的 advisory blocker）
- 自进化 P9-A0/D0/G0 + research R line——门通过后
- 这些**禁止在 6/20 前启动**

---

## Self-Review（writing-plans 要求）

- **spec 覆盖**：Phase 1 的 high/med 均有对应 task；low/既有债归批次1末或批次2
- **宪法过滤**：权限管控类 4 项已列入"不做"并说明理由
- **P8 合规**：批次0/1 标注门内可做（修复非推进），批次3 标注门约束
- **执行纪律**：每 task 先测后改、单 writer、对方 post-review、不自动 commit

## Execution Handoff

计划已存 `docs/superpowers/plans/2026-06-14-noe-audit-and-evolution.md`。建议执行方式：
1. **Subagent-Driven（推荐）**：每 task 派 fresh subagent + Claude×Codex 两段 review（即本轮验证有效的协作闭环）
2. **Inline**：本会话 executing-plans 批量执行 + checkpoint

owner 定方向：是否现在开批次 0（高优先 bug 修复）？还是先评审本计划。
