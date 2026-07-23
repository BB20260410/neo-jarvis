# Noe 任务交接（2026-06-06）

## 先读顺序

1. `AGENTS.md`
2. `CLAUDE.md`
3. `docs/Noe多模型协作协议_2026-06-06.md`
4. `docs/Noe自我进化闭环方案_2026-06-07.md`
5. `docs/Noe四模型协作复盘与改进计划_2026-06-07.md`
6. 本文档
7. `docs/HANDOFF_2026-06-05_codex交接.md`

## 真实项目根

当前会话环境可能显示 `/Users/hxx/Documents/Neo 贾维斯`，但 Noe 实际代码和最近改动在：

```text
/Users/hxx/Desktop/Neo 贾维斯
```

每次接手先执行：

```bash
pwd
git rev-parse --show-toplevel
git status --short
```

不要把 `/Users/hxx/Documents/Neo 贾维斯` 当成真实代码根。

## 当前硬边界

- 不 commit / push，除非用户明确要求。
- 不把 `.env` 密钥写进 git 或日志。
- 文件仍需 `<500` 行；当前 `src/server/routes/noe.js` 和 `public/cognitive.html` 都是 499 行，新增逻辑优先拆模块。
- 后端改动后只有用户明确确认才重启/杀掉/抢占 live `51835`，不要碰 `51735`。
- 工作区很脏，必须按本轮任务只碰相关文件，不回滚他人/历史改动。
- 多模型协作按 `docs/Noe多模型协作协议_2026-06-06.md`：默认不 spawn；用户明确授权时可启用，但 Codex 仍是单 writer 和最终验证者。
- 用户明确要求：不要给模型设置任何硬超时。模型请求默认不设置 timeout；只有用户显式传入的覆盖值可尊重。该偏好已写入 Codex 本地记忆更新文件。

## 2026-06-07 最新追加：四模型自我进化闭环第一阶段

用户明确要求把 Claude 纳入 Codex + Gemini + MiniMax M3 的多模型协作，并要求模型不可用时采用动态 quorum：4 可用取 3/4，3 可用取 2/3，2 可用取 2/2，1 可用停下。当前结论：

- Claude / Gemini / M3 / Codex 四方均同意 `approve_with_changes`：先落治理闸门，不批准无监督自动写代码。
- 新增 `docs/Noe自我进化闭环方案_2026-06-07.md`，记录上轮协作不足、Claude 融入点、dynamic quorum consensus ledger、runtime verification、rollback、自我修复再闸门、memory writeback 共识确认。
- 新增 `docs/Noe四模型协作复盘与改进计划_2026-06-07.md`，记录本轮四模型协作不完美处、用户纠正点、敏感 capability 授权修正、Claude 线程经验回传和后续 P1/P2/P3 计划；该文件也是每轮 complete 必须引用的 `retrospectiveRef` 样例。
- 新增 `src/room/NoeConsensusGate.js`，用确定性规则校验四模型票、动态 quorum、Claude 一等参与、M3 suggestion-only、Gemini advisory、单 writer、`consensus_vote` 冲突、M3 内容级越权、不要给模型设置人为硬超时、`51735` 禁碰、live `51835` 用户门控。注：后续已从“Codex 固定单 writer”升级为“Codex 默认 active executor，Claude 可被显式选择为本轮唯一 active executor”。
- 新增 `src/room/NoeConsensusLedger.js`，负责 ledger 构造、落盘、notes 脱敏、`rawOutputRef`/hash/evidence 文件校验。
- 新增 `src/room/NoeConsensusRound.js`，从 Claude/Gemini/M3/Codex raw output 提取 JSON vote 并组装 ledger。
- 新增 `src/room/NoeConsensusRunner.js`，生成 evidence brief、四模型 prompt、raw output 文件和 ledger；默认 dry-run，真实模型调用必须有 `costAcknowledged: true`，CLI 显式 `--run-models --ack-cost` 才调用 Codex CLI / Claude CLI / Gemini CLI / MiniMax M3 API，且不设置模型 timeout。
- 新增 `src/room/NoeSelfEvolutionGate.js`，在 implementation / self_repair / memory_writeback / complete 前检查 consensus、用户或共识授权、rollback、runtime verification、敏感 capability、非实现者复审、`retrospectiveRef` 和 memory writeback 确认。
- 新增 `src/room/NoeSelfEvolutionLoop.js`，把 implementation、runtime verification、self_repair、post_review、retrospective_required、memory_writeback 和 complete 编成纯函数状态机；它只判断下一步和阻断原因，不自动写文件、不重启、不调用模型。
- 新增 `src/room/NoeSelfEvolutionCycle.js`，验证一整轮 cycle artifact：validated consensus ledger、Codex implementation evidence、runtime report、Claude/Gemini/M3 非实现模型 post-review 动态 quorum rawOutputRef、retrospectiveRef、memory writeback summary 全部齐备后才算 complete。
- 新增 `src/loop/NoeSelfEvolutionActGuard.js` 并接入 `src/loop/ActPipeline.js`，self-evolution act 会在 dry-run/realExecute 前用真实 permission/approval/budget 状态重跑 `NoeSelfEvolutionGate`；动态 quorum 共识可替代用户亲自确认，并可授权删除、上传、外部发布、密钥访问/使用、重启/杀进程和长期记忆自动写入；系统级 capability fail closed。
- 新增 `tests/unit/noe-consensus-gate.test.js`、`tests/unit/noe-consensus-ledger.test.js`、`tests/unit/noe-consensus-round.test.js`、`tests/unit/noe-consensus-runner.test.js`、`tests/unit/noe-self-evolution-gate.test.js`、`tests/unit/noe-self-evolution-loop.test.js`、`tests/unit/noe-self-evolution-cycle.test.js`、`scripts/noe-consensus-ledger-verify.mjs`、`scripts/noe-consensus-round-assemble.mjs`、`scripts/noe-four-model-consensus-round.mjs`、`scripts/noe-self-evolution-plan-verify.mjs`。
- 新增 npm 入口：`npm run test:noe:consensus`、`npm run verify:noe:consensus-ledger`、`npm run verify:noe:self-evolution`、`npm run noe:consensus:assemble -- ...`、`npm run noe:consensus:round -- ...`。
- `test:noe:consensus` 已纳入 P0 单元门；新增 loop test 后需要以本窗口最新验证输出为准。
- 已尝试真实 production consensus round：`output/noe-multimodel/production-self-evolution-governance-20260607-1/ledger.json`。Codex/Claude/Gemini 三票 `approve_with_changes`，M3 为 `unavailable`（当前进程环境没有 `MINIMAX_API_KEY`）；按动态 quorum 重新组装后，该 ledger 通过 `--require-passed`：available=3，threshold=2，approved=3。R33 已进一步补齐 post-review/runtime/retrospective/memory summary 并写入 complete cycle artifact：`output/noe-self-evolution/production-self-evolution-governance-20260607-1-r33/cycle.json`。
- Claude 线程早期同步经验后创建过一条 memory note；它在当时缺 production cycle/consensusAck，所以仍只能视为 premature/advisory 历史证据，不作为授权规则来源。R33 合规 memory summary 是 `output/noe-self-evolution/post-review-r33/memory-summary.md`，由 complete cycle artifact 引用。
- 新增 R15 代码层收紧：self-evolution 授权必须是 ledger-backed consensus。普通 payload 里的 `consensus:{ok:true, validated:true}` 或伪造 `source:"validated_consensus_ledger"` 不再授权；`NoeSelfEvolutionCycle` 缺 ledger object/file 会 blocked。
- 新增 R16 代码层收紧：ledger object 也必须通过 `validateNoeConsensusLedgerArtifact()`；缺 schema/stored gate/hash 校验的临时拼装对象不能授权。
- 新增 R17 代码层收紧：执行前 gate / ActPipeline 支持 ledger file ref 授权；`ledgerRef` 必须是 repo 内相对路径，路径逃逸会 blocked。
- 新增 R18 代码层收紧：ledger file ref 授权默认要求 ledgerRef 原始证据文件（evidenceRef/rawOutputRef）存在，缺文件会 blocked 并暴露具体 consensus error。
- 新增 R19 代码层收紧：ActPipeline 使用可信 `selfEvolutionRoot` 调用 ActGuard，payload root 注入不能改变 ledgerRef 根目录。
- 新增 R20 代码层收紧：ActGuard 只从可信 ledgerRef 派生 `consensusApproved`；payload consensusApproved 或 payload ledger object 不能替代用户确认。
- 新增 R21 代码层收紧：ActPipeline 默认可信根改为 module-derived selfEvolutionRoot，不依赖启动时 cwd。
- 新增 R22 代码层收紧：ActGuard 只从 approvalStore/permissionResult 派生 `userApproved`；payload userApproved 会 blocked。
- 新增 R23 收口修正：功能测试通过后，`verify:noe:self-evolution` 仍因 `tests/unit/noe-act-pipeline.test.js` 超 500 行失败；已压缩到 487 行并复跑通过。
- 新增 R24 代码层收紧：ActGuard 直接调用默认根也改为 module-derived root；执行入口即使有真实 approval，也必须用 `ledgerRef` 作为 production 授权证据，payload ledger object 不能替代。
- Claude 线程 `019e9d92-62a1-7ee1-8375-055f98d86cce` 已收到 R24 增量经验，返回 `acknowledged` / `consensus_vote:"yes"`；确认 R24 消掉 direct ActGuard/root 与 payload ledger object 执行入口风险。该同步不是 memory writeback。
- 新增 R25 目标级完成审计：`scripts/noe-self-evolution-completion-audit.mjs` / `npm run audit:noe:self-evolution-completion`。默认输出当前 completion evidence，`-- --require-complete` 在未完成时失败；R33 后当前为 `ok:true`，11 pass / 0 incomplete / 0 blockedExternal。
- Claude 线程已收到 R25 增量经验，返回 `acknowledged` / `consensus_vote:"yes"`；确认 completion audit 有助于防止把治理骨架或 blocked ledger 误报为完整闭环完成，并强调 strict mode 不能为了 CI 绿色而放宽。该同步不是 memory writeback。
- 新增 R26 cycle artifact 组装入口：`scripts/noe-self-evolution-cycle-assemble.mjs` / `npm run noe:self-evolution:cycle -- ...`。该入口要求 ledger、implementation evidence、rollback、runtime report、Claude/Gemini/M3 非实现模型 post-review 动态 quorum rawOutputRef、retrospective、memory summary 等引用，写入前运行 `NoeSelfEvolutionCycle` 校验；completion audit 只接受与目标 production ledgerRef 匹配且引用文件齐全的 valid cycle。
- Claude 线程已收到 R26 增量经验，返回 `acknowledged:true` / `consensus_vote:"yes_with_changes"`；确认 R26 足以作为当前治理和防误报门禁，但不能授权 full self-evolution completion。
- 新增 R27 审查硬化：completion audit 只在 ledger 错误全部是 `required_model_unavailable:*` 时归类 external blocked，结构错误仍是 incomplete；`memory_writeback_authorized` 不再硬编码 incomplete，未来 valid production cycle 可使它通过；cycle assembler 非 dry-run 写入时禁止 `--no-require-files`。
- Claude 线程已收到 R27 增量经验，返回 `acknowledged:true` / `consensus_vote:"yes"`；确认 R27 关掉 blockedExternal 掩盖结构错误、memory writeback 永远无法标绿、非 dry-run 缺证据写入 cycle 三个审查缺口，但仍不能授权 full self-evolution completion。
- 新增 R28 审计输出清理：completion audit 的 `pass` 项不再带 `missing` 文案，避免“通过但还缺”的误读；`verify:noe:self-evolution` 已增加检查。
- Claude 线程已收到 R28 增量经验，返回 `acknowledged:true` / `consensus_vote:"yes"`；确认 R28 降低 audit ambiguity，但仍不能授权 full self-evolution completion。

本阶段不调用额外模型、不重启 live `51835`、不碰 `51735`、不 commit / push。后续如要接真实自动执行，必须先有 passed production consensus ledger 的 `rawOutputRef`，再过 self-evolution gate；实现后必须做 runtime verification 和非实现模型复审，memory writeback 必须有动态 quorum 共识确认。

## 2026-06-06 最新追加（当前窗口）

下面 4 项是上一版“建议下一步”的代码侧收尾，已经完成并验收：

1. 搜索总结质量门
   - `src/research/ResearchIntent.js` 新增 `assessSearchSummaryQuality()`。
   - `summarizeSearchResults()` 只有在模型总结通过质量门时才使用，否则降级到规则兜底。
   - 质量门覆盖：空/过短/过长、URL/HTML/img/src/href、标题列表式复读、无结论、无不确定性、重复搜索标题。
2. M3 冷审查 checkpoint
   - `src/room/MiniMaxSuggestionPipeline.js` 新增 search/voice/identity/execution 四类冷审查输入。
   - `scripts/m3-suggest.mjs` 支持 `--checkpoint=search|voice|identity|execution`。
   - M3 仍是 suggestion-only：不读本地、不运行命令、不写 diff，最终裁定仍归 Claude/GPT-Codex。
3. 模型硬超时策略
   - 核心 chat/spawn adapters 默认 `timeout=0`，表示无硬超时。
   - 运行保护只在显式正数 timeout 覆盖时启用。
   - `CrossVerifyDispatcher` cluster 成员调用默认也改为 `0`，不再用 600000ms 人为切断四模型讨论；只有显式 override/env 才启用。
   - `AISearch` 的 Codex/Claude CLI 搜索默认不再传 90 秒硬超时；只有显式 `NOE_AI_SEARCH_*_TIMEOUT_MS` 才启用。
   - 新增 `tests/unit/room-model-timeout-policy.test.js`，并纳入 `test:p0:unit`。
4. 真实使用回放
   - 新增 `scripts/noe-real-use-replay.mjs`。
   - 新增 npm 入口：`npm run verify:noe:real-use-replay -- --managed`。
   - `scripts/noe-full-current-verify.mjs --include-managed` 已纳入 `real_use_replay_managed`。
   - 托管模式只起随机非保留端口，不碰 `51735/51835`；可创建隔离 HOME 内的临时 memory/person/act/idle delegate room。
   - 托管模式显式启用 `NOE_AI_SEARCH_MOCK=1`，用确定性搜索夹具验证搜索路径，不依赖真实外部搜索配置；生产路径默认关闭。

真实使用回放 11 项（托管模式）：

1. owner-token / health 鉴权。
2. managed 搜索夹具显式开启，`mockSearch:true`。
3. `/api/noe/do` 搜索返回结果。
4. `/api/noe/voice/chat` 文字搜索返回适合语音的清洁回复，不读 URL/HTML/img/src/href。
5. `/api/noe/do` 本地 LLM Wiki 返回 Karpathy 相关上下文。
6. memory 写入、召回、删除。
7. people 创建、录入 3 个人脸样本、识别、删除。
8. ActPipeline 低风险 completed、高风险 awaiting_approval、危险动作 blocked_safety，且无 `executed_real`。
9. delegate confirm 只创建 idle room，不启动/排队 agent。
10. M3 冷审查 suggestion-only 契约，用本地 mock runner，不调用 MiniMax API。
11. 认知页和动态 people 模块入口存在。

## 本轮已完成

### 1. 删除临时“演示搜索”

用户要求：删掉演示搜索，后续搜索后台静默。

已完成：

- 删除临时可见浏览器搜索模块：
  - `src/research/VisibleComputerSearch.js`
  - `public/src/web/cognitive-computer-search.js`
- `src/server/routes/noe.js`
  - 不再 import/create/inject `VisibleComputerSearch`。
  - `VoiceSession` 不再接收 `visibleSearch`。
  - `/api/noe/voice/chat` 不再传 `visibleComputerSearch / returnToNoe / closeAfterMs`。
- `src/server/routes/noeComputerSearch.js`
  - 保留兼容接口 `/api/noe/computer/search`。
  - 固定静默：`mode:"silent"`、`kind:"后台搜索"`、`visible:null`。
  - 即使请求传 `visible:true` 也不会打开浏览器。
- `src/voice/VoiceSession.js`
  - 语音搜索只走后台 `webSearch`。
  - 不再 fallback 到可见浏览器结果。
- `public/src/web/cognitive-research.js`
  - 移除演示搜索脚本 import。
- `public/cognitive.html`
  - 移除实时语音里“可见搜索演示完成/失败”的 UI 提示。
  - 脚本版本号改为 `silent-search-20260606a`。
- 测试更新：
  - `tests/unit/routes/noe-computer-search-routes.test.js`
  - `tests/unit/noe-voice-session.test.js`

### 2. 搜索总结/语音垃圾清理已收尾

前一轮已经完成：

- 搜索结果先清洗再总结。
- TTS 不读 `<img`、`src=`、URL、HTML。
- 语音搜索不再复读网页标题列表，能给结论和不确定性。
- `summarizeSearchResults` 已接入 `researchChat`。

### 3. 多模型协作最终协议已落地

用户给出最终版协作交接，覆盖前两条泛化版本。

已完成：

- 新增 `docs/Noe多模型协作协议_2026-06-06.md`。
- `AGENTS.md` 接手顺序加入该协议。
- `CLAUDE.md` 把“不 spawn 子 LLM”从绝对硬限制改成默认安全策略；用户明确授权 Noe 多模型协作时按新协议执行。

## 已验证

### 代码/单测

```bash
node --check src/server/routes/noe.js
node --check src/server/routes/noeComputerSearch.js
node --check src/voice/VoiceSession.js
node --check public/src/web/cognitive-research.js
```

通过。

专项测试：

```bash
node scripts/ensure-node22.mjs --require-22 --exec node_modules/vitest/vitest.mjs run \
  tests/unit/routes/noe-computer-search-routes.test.js \
  tests/unit/noe-voice-session.test.js \
  tests/unit/research-intent.test.js \
  tests/unit/routes/noe-do-routes.test.js
```

结果：`46/46` 通过。

P0：

```bash
npm run test:p0:unit
```

上一版结果：`67/67` 通过；当前最新结果见下方“最新总验收”。

### 最新总验收（2026-06-06 当前窗口）

```bash
node --check scripts/noe-real-use-replay.mjs
node --check scripts/noe-full-current-verify.mjs
npm run verify:noe:real-use-replay -- --managed
npm run test:p0:unit
npm run verify:noe:full-current -- --include-managed
```

结果：

- `scripts/noe-real-use-replay.mjs`：语法通过，458 行。
- `scripts/noe-full-current-verify.mjs`：语法通过，111 行。
- `npm run verify:noe:real-use-replay -- --managed`：11/11 通过。
  - 报告：`output/noe-real-use-replay/real-use-replay-1780771793646.json`
- `npm run test:p0:unit`：历史记录为 14 个文件、71 项通过；2026-06-07 纳入 consensus gate/ledger/round/runner/self-evolution/loop/cycle/复盘 verifier、ledger-backed consensus、artifact-valid ledger、ledger file ref 路径逃逸阻断、ledgerRef 原始证据文件校验、payload root 注入阻断、payload consensusApproved/userApproved 阻断、ActGuard execution-only ledgerRef、module-derived selfEvolutionRoot、cluster 默认无硬超时、dynamic quorum、所有 unavailable 组合矩阵和 duplicate post-review reviewer 阻断测试后，当前为 23 个文件、171 项通过。
- `npm run verify:noe:full-current -- --include-managed`：当前 live `51835` 不可达，`phase5_live` fetch failed；未重启 live 服务。
  - 失败现场报告：`output/noe-full-current/full-current-1780766513528.json`
- `npm run verify:noe:full-current -- --include-managed --skip-live --skip-cognitive`：11/11 通过。
  - managed-only 报告：`output/noe-full-current/full-current-1780776348110.json`
  - 预期外部阻塞仍是：`obsidian_mcp_readiness`、`external_readiness`。
- 当前状态复跑专项测试：
  - 搜索/语音/静默搜索：3 个文件、37 项通过。
  - M3 suggestion-only：5 个文件、38 项通过。
  - 模型无硬超时策略：3 个文件、14 项通过。
  - 四模型 consensus gate/ledger/round/runner/self-evolution gate/loop/cycle：7 个文件、70 项通过。
  - `npm run verify:noe:consensus-ledger`：assemble-smoke PASS；production round PASS（dynamic quorum：available=3，threshold=2，approved=3），整体 ok=true。
  - `node scripts/noe-consensus-ledger-verify.mjs --ledger output/noe-multimodel/production-self-evolution-governance-20260607-1/ledger.json --require-passed`：通过；这只证明 production ledger passed，完整闭环证据见 R33 cycle artifact。
  - `npm run verify:noe:self-evolution`：190/190 通过。
  - `npm run audit:noe:self-evolution-completion -- --require-complete`：`ok:true`，11 pass / 0 incomplete / 0 blockedExternal；complete cycle artifact 是 `output/noe-self-evolution/production-self-evolution-governance-20260607-1-r33/cycle.json`。
  - `npm run noe:self-evolution:cycle -- ... production-self-evolution-governance-20260607-1-r33 ...`：非 dry-run 写入 production cycle 并通过校验。

### 真实接口

`POST /api/noe/computer/search`，即使 body 传 `visible:true`：

- `ok:true`
- `mode:"silent"`
- `kind:"后台搜索"`
- `visible:null`
- 不返回可见浏览器动作字段。

`POST /api/noe/voice/chat` 搜索文本：

- `ok:true`
- `intent:"research"`
- `mode:"search"`
- 无 `visible` 字段。
- `voice:true` 时返回 `audioBase64`，`audioFormat:"mp3"`，`ttsError:null`。

### 浏览器认知页

浏览器验证目标：

```text
http://127.0.0.1:51835/cognitive.html?t=...&final=silent-search-final
```

结果：

- 页面标题：`Noe · 认知界面`。
- 无 `#btnComputerSearch`。
- 页面无“演示搜索 / 搜索演示 / 可见浏览器 / 可见搜索演示”文案。
- 普通 `🔍 搜索` 按钮仍可后台搜索并展示结果。
- 控制台无 error/warn。

## 当前服务状态

当前窗口没有重启 live `51835`，也没有触碰 `51735`。当前 live `51835` fetch failed，导致带 live 的 full-current 在 `phase5_live` 停下；managed phase5 11/11、managed real-use replay 11/11、managed-only full-current 11/11 均通过。托管回放使用随机非保留端口，结束后清理隔离 HOME。

如后续改到后端运行时代码，需要用户确认或动态 quorum 共识授权后再重启 live `51835`；不要把 owner-token 明文写进交接或日志。

## 当前风险 / 注意

- 工作区大量 dirty / untracked，不能粗暴回滚。
- `AGENTS.md` 目前是 untracked，但已经是 Noe 接手入口；不要误删。
- `src/server/routes/noe.js`、`public/cognitive.html` 已达 499 行，后续不要继续加行，优先拆模块。
- `/api/noe/computer/search` 现在是兼容静默接口，不是演示接口；不要重新接可见浏览器。
- `docs/HANDOFF_2026-06-05_codex交接.md` 仍有旧红线文本，后续以 `docs/Noe多模型协作协议_2026-06-06.md` 的授权边界为准。
- 如果做语音/搜索相关改动，必须验证 TTS 文本不含 `<img`、`src=`、`http://`、`https://`。
- 当前真实 production round 已按动态 quorum 通过；若要恢复真实 4/4 production round，需要用户或合规动态 quorum 共识明确授权 secret 使用方式，并以环境变量/调用方 secret store 注入 `MINIMAX_API_KEY` 后重跑同一 round。不要读取或输出 `.env`。
- Claude 线程产生的 memory note 是本轮新暴露的流程缺口，不是授权规则来源。跨线程“分享经验/记录经验”必须显式限制为聊天 acknowledge；长期记忆写入要等 passed production ledger 和 memoryWriteback consensusAck。
- R29 动态 quorum 已同步给 Claude 线程 `019e9d92-62a1-7ee1-8375-055f98d86cce`；返回 `acknowledged:true` / `consensus_vote:"yes_with_changes"`。Claude 要求继续守住：missing vote 不能当 unavailable、unavailable 必须有 rawOutputRef/错误证据、系统级 capability 不能被模型票覆盖。
- R30/R31：不要写死 M3 unavailable。Codex/Claude/Gemini/M3 任意一个、任意两个、任意三个不可用组合都要按真实 `availableModels` 计算；cycle post-review 也按 Claude/Gemini/M3 required reviewer 动态 quorum。cycle assembler 支持 `--post-review model:decision=rawOutputRef`，模型没额度时用 `m3:unavailable=...` 等显式证据。
- R32 已按用户纠正补齐组合矩阵口径：4 可用取 3/4，任意 1 个 unavailable 取 2/3，任意 2 个 unavailable 取 2/2，任意 3 个 unavailable 停下；不能只考虑 M3 没额度。Claude 线程返回 `acknowledged:true` / `consensus_vote:"yes_with_changes"`，确认覆盖成立，并要求 production artifact 继续记录 `availableModels`、`unavailableModels`、`threshold`、`approvedCount`。
- R33 自检收紧：`NoeSelfEvolutionCycle` 现在会阻断重复 required post-review reviewer，避免同一模型先 reject 后 approve 的重复条目覆盖前票；已纳入 consensus/P0 单测。
- R34 complete cycle：已生成 `output/noe-self-evolution/post-review-r33/brief.md`、Claude post-review raw output、Gemini post-review raw output、M3 unavailable raw evidence、rollback plan、memory summary，并写入 `output/noe-self-evolution/production-self-evolution-governance-20260607-1-r33/cycle.json`。Claude 第二次复审返回 `approve_with_changes` / `cycle_authorization:"yes"`，Gemini 返回 `approve` / `cycle_authorization:"yes"`，M3 仍为 unavailable。`audit:noe:self-evolution-completion -- --require-complete` 已通过。
- 不要用 consensus summary 作为执行授权。后续 ActPipeline/self-evolution 输入必须携带可验证 ledger object 或 ledger file；summary 只能做展示或审计摘要。
- ledger object 必须是 artifact-valid，不是任意 ledger-shaped object；production 授权仍优先使用 ledger file + `--require-passed`。
- ActPipeline payload 可以携带 `ledgerRef` / `consensusLedgerRef` 指向 production ledger file；不要只传 `ledger.gate`、consensus summary 或 payload ledger object；ledgerRef 原始证据文件必须存在，payload root 注入、payload consensusApproved 和 payload userApproved 不能改变可信授权结果；即使真实 approval 已通过，执行入口也不能用 payload ledger object 作为 production 授权证据；默认可信根不依赖启动 cwd，ActGuard 直接调用也不依赖 cwd。

## 下一步状态

代码侧后续计划已完成并验收。当前不要再把“搜索质量门 / M3 checkpoint / 模型无硬超时 / 11 项托管真实使用回放”当待办。

剩余事项是外部条件或需要用户现场决策：

0. 真实 production quorum：当前 Codex/Claude/Gemini 三票通过，M3 unavailable，按动态 quorum 已 passed；R33 complete cycle artifact 已通过 completion audit。若要恢复真实 4/4 M3 能力，再安全注入 `MINIMAX_API_KEY` 后重跑。
0.1. memory writeback 纠偏：Claude 线程已有 premature/advisory memory note，不删除；R33 合规 memory summary 已由 cycle artifact 引用。后续若写外部长期记忆，继续要求 passed ledger + runtime report + memoryWriteback summary + consensusAck。
0.2. ledger-backed consensus：后续真实 self-evolution cycle 必须附 ledger object/file，不能只传 `consensus.gate`。
0.3. artifact-valid ledger：后续真实执行前优先走 ledger file + `--require-passed`；如果传 ledger object，也必须保留 schema/stored gate/hash，不能临时拼装。
0.4. ledger file execution path：后续 self-evolution act 可传 `ledgerRef`，但必须是可信 project root 内相对路径；路径逃逸/绝对路径/payload root 注入 blocked；ledgerRef 原始证据文件必须存在；payload consensusApproved / payload userApproved / payload ledger object 不能替代真实授权；即使真实 approval 已通过，执行入口也必须走 ledgerRef；默认可信根不依赖启动 cwd，ActGuard 直接调用也不依赖 cwd。
0.5. completion audit：每次准备宣称“自我进化闭环完成”前必须跑 `npm run audit:noe:self-evolution-completion -- --require-complete`。当前已通过，11 pass / 0 incomplete；证据是 R33 cycle artifact。
0.6. cycle artifact assembly：R33 已用 passed production ledger、runtime report、Claude/Gemini/M3 非实现模型 post-review 动态 quorum、retrospective 和 memory summary 组装 `cycle.json`；不要用 assemble-smoke sample 替代 production cycle。
0.7. cycle assembler 的 `--post-review` 支持 `model=rawOutputRef` 和 `model:decision=rawOutputRef`；M3 不可用时使用 `m3:unavailable=...`，不要伪装成 approve。
0.8. 可用性组合矩阵：不要只测/只写 M3 unavailable；Codex、Claude、Gemini、M3 任意 1/2/3 个 unavailable 都必须按真实 `availableModels` 走同一动态 quorum。少于 2 个可用模型必须停下。
1. 真实 Obsidian vault + Local REST API key + MCP 注册：当前仍是 `obsidian_mcp_readiness` 外部阻塞。
2. 真实 delegate-start：需要用户明确审批预算/目标后才能启动，不在验证脚本里自动启动。
3. “图一”素材：缺真实文件，无法补证据。
4. 如果继续人物/声纹稳定性，先用当前 UI/接口做现场样本验证，再决定阈值和模型配置。

## 给下个窗口的复制提示

```text
你是接手 Noe 项目的 Codex。先确认真实项目根：
pwd
git rev-parse --show-toplevel
git status --short

真实代码根应是 /Users/hxx/Desktop/Neo 贾维斯，不要被 /Users/hxx/Documents/Neo 贾维斯 误导。

按顺序读取：
1. AGENTS.md
2. CLAUDE.md
3. docs/Noe多模型协作协议_2026-06-06.md
4. docs/Noe自我进化闭环方案_2026-06-07.md
5. docs/Noe四模型协作复盘与改进计划_2026-06-07.md
6. docs/HANDOFF_2026-06-06_codex交接.md
7. docs/HANDOFF_2026-06-05_codex交接.md

当前最新状态：
- 临时“演示搜索/可见浏览器搜索”已删除。
- 后续搜索必须后台静默。
- /api/noe/computer/search 保留为兼容静默接口，固定 mode:"silent"、visible:null。
- 语音搜索只走 webSearch，不再返回 visible/returnToNoe/closeAfterMs。
- 搜索总结/TTS 已修过：不能读 <img、src=、URL、HTML，要给结论和不确定性。
- 新的 Noe 多模型协作协议已落地；用户明确授权时可启用多模型协作，但 Codex 仍是单 writer 和最终验证者。
- 搜索质量门、M3 冷审查 checkpoint、模型默认无硬超时、11 项托管真实使用回放都已完成。

硬边界：
- 不 commit/push。
- 不泄露 .env 密钥。
- 不给模型设置默认硬超时；显式用户覆盖除外。
- 文件 <500 行，src/server/routes/noe.js 和 public/cognitive.html 已是 499 行，后续优先拆模块。
- 后端改动只有用户明确确认或动态 quorum 共识授权后才重启/杀掉/抢占 live 51835，不碰 51735。
- 工作区很脏，不要回滚非本轮改动。

最近验证：
- node --check 通过。
- 专项 self-evolution / ActPipeline / ActGuard vitest 53/53 通过。
- npm run test:p0:unit 171/171 通过。
- npm run test:noe:consensus 85/85 通过。
- npm run verify:noe:consensus-ledger：assemble-smoke PASS；production-self-evolution-governance-20260607-1 PASS（dynamic quorum：available=3，threshold=2，approved=3）。
- node scripts/noe-consensus-ledger-verify.mjs --ledger output/noe-multimodel/production-self-evolution-governance-20260607-1/ledger.json --require-passed：通过；这只证明 production ledger 通过，不证明完整 cycle 完成。
- npm run verify:noe:self-evolution 190/190 通过。
- npm run audit:noe:self-evolution-completion：ok:true，11 pass / 0 incomplete / 0 blockedExternal。
- npm run audit:noe:self-evolution-completion -- --require-complete：ok:true，complete cycle artifact 已验证。
- npm run verify:handoff 23/23 通过。
- npm run verify:noe:real-use-replay -- --managed：11/11 通过。
- npm run verify:noe:full-current -- --include-managed：live 51835 当前不可达，phase5_live fetch failed；未重启 live。
- npm run verify:noe:full-current -- --include-managed --skip-live --skip-cognitive：11/11 通过；最新报告 `output/noe-full-current/full-current-1780776348110.json`；预期 external_blocked 是 obsidian_mcp_readiness、external_readiness。
- git diff --check -- ':!games/cartoon-apocalypse/**' 通过；games/cartoon-apocalypse 无状态输出。
- 真实接口和认知页浏览器验证通过：无演示按钮、无演示文案、普通搜索仍后台可用、语音搜索返回 mp3 audioBase64。

下一步建议优先处理：
1. 可选补真实 M3 API 环境：由用户或合规动态 quorum 共识授权 secret 使用，以环境变量/调用方 secret store 注入 `MINIMAX_API_KEY`，重跑 production consensus round 恢复 4/4 能力。
2. 补真实 Obsidian vault / Local REST API / MCP readiness。
3. 用户明确审批后，再做真实 delegate-start。
4. 提供“图一”素材后再补视觉/素材证据。
5. 现场继续验证声纹/人脸阈值和模型开关。
```
