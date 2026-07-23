# self-evolution 激活施工图(owner 决策:全激活 + 自授权)

> 来源:workflow `noe-self-evolution-blueprint`(3 agent 深读核心)。owner 2026-06-13 拍板「全激活 + standing grant 自授权」「memory-learning 全自动」。
> 现状:self-evolution 状态机/校验器/单测全齐,但**三环都没通电**——executor 没注册、loop 没触发器、standing grant 进不了授权门。本文档是把它通电的精确施工图。

## env 门控分层(3 个,全部默认 OFF;跑通端到端再由 owner 改默认开)

| 门控 | 控制 | 默认 |
|---|---|---|
| `NOE_SELF_EVOLUTION_EXECUTORS` | 环1:注册四个 self_evolution executor | OFF(不设=与现状逐字一致零回归) |
| `NOE_SELF_EVOLUTION` | 环2:loop 自驱 trigger + cycleStore + selfEvolve 心跳 | OFF |
| `NOE_SELF_EVOLUTION_STANDING_GRANT` | 环3:ActGuard 求值 standing grant 并可注入 standingApproved | OFF |

## 实现前统一决策(跨环一致点,我拍板)

1. **授权 scope = `self-evolution:run`(专属,不复用 `freedom-live:run`)**。环1 executor 的 `evaluateGrant` 与环3 gate 都用它。理由:自改代码=独立高危能力域,专属 scope 让 owner 能用 `noe:autonomy:revoke` 单独撤销自改授权而不影响 live API。`MAX_AUTONOMY_SCOPES` 只加这一项(环1/环3 谁先加谁加,另一环跳过)。
2. **实现顺序**:① scope 入册 → ② 环3 gate 接入(让 standing grant 能授权)→ ③ 环1 executor(手脚)→ ④ 环2 loop(自驱)。每环 env OFF 先验证零回归,再单测,最后端到端。
3. **现有 grant 文件不自动获得新 scope**:owner 须重跑 `npm run noe:autonomy:grant` 才拿到 `self-evolution:run`(=重新明示授权,有意为之)。

## 环1:executor 接入(手脚——让自改 act 真能执行)

**现状**:四个 `noe.self_evolution.*`(implementation/self_repair/memory_writeback/complete)过了 gate 也报 `executor_not_registered`(ActPipeline `#executeReal` L249 取 `executors.get(action)` 缺则 L259 报错);真正改代码的 `NoePatchApplyExecutor`(`src/runtime/mission/NoePatchApplyExecutor.js`,写文件+备份0o600+diff+sha256 rollback+dryRun 默认 true+SECRET_PATH_RE/games 硬挡)存在但生产链零引用。

**改动**:
- 新文件 `src/loop/NoeSelfEvolutionExecutors.js`(`// @ts-check` + 全注入式):`registerNoeSelfEvolutionExecutors(executors, deps)` 注册四 key。每 executor 先 `assertGatePassed`(`act.payload.selfEvolutionGate.ok===true` 否则 throw `gate_not_passed_in_executor`,纵深防御)。
  - `implementation`:`evaluateGrant({scope:'self-evolution:run'})` 非 authorized→throw `self_evolution_apply_requires_standing_grant`;`patchPlanRef` 空→`spawnImplementer({objective,root,gate})` 产 plan;`runNoePatchApply(dryRun:true)` 预检→`(dryRun:false,confirmOwner:true)`→`runtimeVerify` ok≠true 则自动 `runNoePatchRollback(confirmOwner:true)` 返 `needsSelfRepair:true`;全过返 `applied:true` + 各 ref,`secretValuesReturned:false`。
  - `self_repair`:`rollbackFirst` 先还原→`spawnImplementer` 新 plan→apply→verify;仍挂再 rollback 返 `needsConsensus:true`。
  - `memory_writeback`:summaryRef 经 `redactSensitiveText` 脱敏后 `memoryWrite({body,scope:'fact',sourceType:'self_evolution'})`,**绝不写 diff/secret**。
  - `complete`:汇总 ref + `appendEvent kind:'noe_self_evolution_completed'`。
  - 导出 `makeNoeSelfEvolutionImplementer({adapterPool,brainRouter})`(spawn codex/claude 出 `noe_patch_plan`,用现有 `NoeLlmJsonExtractor`+`extractNoePatchPlan` 校验,写 `output/noe-self-evolution/<ts>/patch-plan.json`)+ `makeNoeSelfEvolutionRuntimeVerify({cwd})`(`spawn npm test` argv+`sanitizeNoeHostExecEnv`,**不设硬超时**,exitCode===0)。
- `src/loop/SafeActExecutors.js`:`createSafeActExecutors` 签名加 `selfEvolution=null`;return 前 `selfEvolution && process.env.NOE_SELF_EVOLUTION_EXECUTORS==='1'` 才 `registerNoeSelfEvolutionExecutors`(唯一注册入口,OFF 时 Map 无四 key=零回归)。
- `server.js` L880 `createSafeActExecutors`:OFF 时 `selfEvolution=null`,ON 时注入 `{root, evaluateGrant, spawnImplementer(roomAdapterPool/noeBrainRouter), runtimeVerify, memoryWrite(noeMemoryCore.write)}`。
- live 触发点:现成 `POST /api/noe/acts/propose`(noeCoreRoutes.js L204,`requireOwnerToken`),body `action=noe.self_evolution.implementation, realExecute=true, payload.selfEvolution{objective,ledgerRef,authorization,rollback}`。

## 环3:standing grant 接入授权门(自授权自改代码)

**现状**:`NoeSelfEvolutionGate.js:145` `authorized = userApproved || consensusAuthorized`,standing grant 无通路。

**改动**:
- `scripts/lib/noe-standing-autonomy-grant.mjs` `MAX_AUTONOMY_SCOPES` 加 `'self-evolution:run'`。
- `src/loop/NoeSelfEvolutionActGuard.js`:import `evaluateStandingAutonomyGrant`(`../../scripts/lib/noe-standing-autonomy-grant.mjs`);新函数 `hasNoeSelfEvolutionStandingAuthorization({act,input,root})`(仅 self_evolution act 适用,非则 false;校验 grant scope `self-evolution:run`);`buildNoeSelfEvolutionGateInput` 加 `approvedByStanding` → authorization 对象加 `standingApproved`。
- `NoeSelfEvolutionGate.js`:L145 加 `const standingAuthorized = authorization.standingApproved === true; const authorized = userApproved || consensusAuthorized || standingAuthorized;`;gates 对象加 `standingAuthorization`(审计可见来源,纯增字段向后兼容)。

## 环2:loop 自驱(让 Neo 自己启动一轮进化)

**现状**:`evaluateNoeSelfEvolutionLoop` 运行时从不被调(只在 cycle 校验内跑),无人实例化 Cycle。

**改动**:
- `src/cognition/NoeGoalSystem.js`:`SOURCE_WEIGHT` 加 `self_evolution: 0.9`(仅次于 owner);`BACKLOG_EXEMPT_SOURCES` 加 `self_evolution`(不受 maxBacklog 挤掉,仍受 active≤2 + staleDays paused)。
- 新文件 `src/room/NoeSelfEvolutionCycleStore.js`:sqlite `noe_self_evolution_cycles`(cycle_id PK/goal_id/stage/cycle_json),`upsert`(落库前 `validateNoeSelfEvolution` 校验,非法不写脏行)/`getByGoal`/`advance`(浅合并 patch 后 stage 重算)。
- 新文件 `src/room/NoeSelfEvolutionTrigger.js`(全注入式):`classifySelfEvolutionSignal`(识别"改自身/进化"意图)+ `buildSelfEvolutionGoal`(source `self_evolution`)+ `observe`(cooldown 默认 30min + open 目标去重,防上瘾)+ `tick`(用 `evaluateNoeSelfEvolutionLoop` 求 nextAction 落成 act 经 `ActPipeline.propose`,单 writer 一次推一个 Cycle)。
- `server.js`:装配 cycleStore + trigger(env OFF=null);心跳注册 `selfEvolve`(cadence `NOE_SELF_EVOLUTION_TICK_MS` 默认 5min,`catchUp:'drop'`)。

## 全部保留的安全约束(只加授权通路 + 接线,不拆安全网)

- rollback 必需(Gate L162 `rollback_plan_required`)、runtimeVerification 必需(L165)、consensus 账本校验(L141)、**system_level 不可授权**(L154;`self-evolution:run` scope 无法授予 system 级)、hardVetoes(L196 `ok===false` 短路 `blocked_safety`)。
- 秘密硬挡 `SECRET_PATH_RE` + `games/cartoon-apocalypse`、高危需显式 `realExecute:true`(`autoExecuteLowRisk` 不覆盖)、dryRun 默认 true、`confirmOwner!==true` 报 `owner_confirmation_required`——全不改。
- executor 额外:备份 0o600 + sha256 + 测试挂自动 rollback;`result.secretValuesReturned:false`。
- 三 env 门控默认 OFF;`NOE_STANDING_AUTONOMY_GRANT=0` 可总闸掘断自授权。

## 测试 + 端到端

- 新单测:`noe-self-evolution-executors.test.js`(四 executor 全 stub:applied/grant 缺失 throw/verify 失败自动 rollback/self_repair 序/memory_writeback 脱敏/complete 留证/gate.ok≠true throw)、`noe-self-evolution-trigger.test.js`、`noe-self-evolution-cycle-store.test.js`。
- 回归:`npm test` 必须 ≥524 文件/3937 测全绿(env OFF 时零变化)。
- 端到端:env 全开,`POST /api/noe/acts/propose` 一个真实自改目标(如改个无关紧要的注释),断言走完 propose→gate(standing 授权)→executor(spawn→apply→verify→留证),失败自动 rollback。owner 本地 live 点火验证一轮 Cycle 后再把默认改 ON。

## 风险

- self_evolution 目标抢注意力/上瘾:trigger cooldown 30min + open 去重 + 单 writer + GoalSystem active≤2 缓解。
- spawn LLM 出的 patch plan 质量:dryRun 预检 + runtimeVerify(npm test)+ 挂了自动 rollback 三重兜底。
- 授权放宽:仅加 standing grant 一条通路,所有硬约束保留;owner 须重跑 `noe:autonomy:grant` 拿新 scope(重新明示)。

## 审查结论(2026-06-14,先审再实现 · 多模型交叉)

裁决:**改后 GO**——方案方向正确、不重新设计,但**不能按上文原样开工**,必须先纳入下列修正。
- gate 环(最敏感授权链)Opus 亲自把关:**GO**。授权链准确、standing 接入用真实评估覆盖 payload(`buildNoeSelfEvolutionGateInput` L155-166 重构 authorization)不引入伪造漏洞、所有硬约束在。
- codex 异构审(读真实代码 + `verify:noe:self-evolution` 198/198):**改后 GO**,挖出 6 个施工图遗漏。
- **owner 定:保留 consensus ledger 共识门**——self_evolution 自驱时 Neo 自己跑共识产 ledger + standing grant 自授权,全程无需 owner;gate 只加 standing 通路,**不拆 L141 ledger 强制**。端到端跑通后再议是否放开到跳过共识。

### 实现前必须纳入的修正(codex 审出,按严重度)
- **P0-1 自改 action 强制高危 + 排除 auto-execute**:`noe.self_evolution.*` 在 `normalizeRisk`(`src/loop/ActPipelineHelpers.js`)默认判 low,而 server 默认开 `autoExecuteLowRisk`→executor 注册后会**无门自动执行**(绕过"必须 realExecute:true")。必须强制 critical/high + 从 `autoExecuteRegisteredLowRisk` 排除 + 单测断言"无 realExecute:true 绝不 apply"。
- **P0-2 standing grant 接 permission preflight**:preflight(`src/loop/ActPipelinePreflight.js`)在 gate 前执行、只认 consensus,高危化后 standing 授权会到不了 gate。preflight 与 gate 须用同一 `hasNoeSelfEvolutionStandingAuthorization` 结果。
- **P1-3 scope 硬校验**:guard/gate/executor 三处统一要求 `scope === 'self-evolution:run'`(现 gate 只查非空、guard L159 默认填 act.title)+ 错误码 + 单测。
- **P1-4 server.js 注入顺序**:`noeBrainRouter`(L910)/`roomAdapterPool` 在 `createSafeActExecutors`(L880)之后才建→用 lazy getter/factory,勿在 880 直接引用。
- **P1-5 verify 失败状态语义**:ActPipeline `#executeReal` 对非 throw result 一律标 `completed`(L313)→ executor rollback 后须 throw 或返回 pipeline 可识别的 failed,或 trigger 可靠读 `needsSelfRepair` 推进 self_repair,不能让账本显示"完成"。
- **P2-6 CycleStore 半成品校验**:`validateNoeSelfEvolutionCycle` 要求全阶段齐→拆 draft/staged validator,只 complete artifact 用完整校验。

### 补充风险缓解
- `NOE_SELF_EVOLUTION=1` 依赖 `NOE_HEARTBEAT=1` 才有心跳 job(写明依赖或给独立 timer)。
- `NoePatchTransaction.safeResolve()` 用 `startsWith(root)`,全激活前改 `relative()` 边界防路径前缀逃逸。

### 实现顺序(审查后更新)
scope 入册 + 硬校验 → P0-1 高危化 → 环3 gate(含 P0-2 preflight 对齐)→ 环1 executor(含 P1-5 状态语义)→ 环2 loop(含 P2-6 validator)。每步 env OFF 零回归 + 单测,最后端到端。

## 实现进度(2026-06-14 · commit 562c405 固化全绿基线)

基线:全量 `npm test` 527 文件 / 3996 测全绿(562c405)。**codex 已重构 `NoeSelfEvolutionGate`(加 `NoePostReviewGate`)/`Cycle`/`Loop`——三环实现要基于 codex 改后版,动手前先 Read 这几个文件确认现状(行号可能已变)。**

**已完成(562c405)**:
- ✅ scope 入册 `self-evolution:run`(`noe-standing-autonomy-grant.mjs` MAX_AUTONOMY_SCOPES)
- ✅ P0-1 `normalizeRisk` 强制 `self_evolution` 为 critical(`ActPipelineHelpers.js`)
- ✅ P0-2 preflight 放行 self_evolution act 交给 gate(`ActPipelinePreflight.js`;codex 改进为 `extractNoeSelfEvolutionActContext` 同源判定,防 regex 命中但 ActGuard 不映射的双重绕过)
- self-evolution 线测试 79 全绿

**待做(新会话从这里接,按序)**:
- ✅ **环3 gate standing 接入已完成(bcb0fe9)**:env `NOE_SELF_EVOLUTION_STANDING_GRANT` 默认 OFF;ActGuard `hasNoeSelfEvolutionStandingAuthorization` 真实评估 grant + scope=self-evolution:run;buildInput `standingApproved`(spread 后覆盖防 payload 伪造);Gate `authorized` OR `standingAuthorized` + `gates.standingAuthorization`;所有硬约束保留;4 单测绿;全量 3999 绿。executor 侧 scope 硬校验(P1-3 第三处)在环1 `evaluateGrant({scope:'self-evolution:run'})` 落实。
- ✅ **环1 executor 完成(cbd4d95 + cc4faa6)**:`NoeSelfEvolutionExecutors.js`(四 executor + makeNoeSelfEvolutionImplementer + makeNoeSelfEvolutionRuntimeVerify，复用 `NoePatchApplyExecutor`)+ `SafeActExecutors` 签名加 `selfEvolution` + env `NOE_SELF_EVOLUTION_EXECUTORS` 唯一注册入口 + server.js lazy 注入(P1-4 闭包绕时序)+ 20 单测。P1-5 verify 失败自动 rollback 并 throw 已落实；P1-3 standing scope 三处硬校验(guard/gate/executor `evaluateGrant({scope:'self-evolution:run'})`)全在。
- ✅ **环2 loop 完成(d76f041 + 19d2dc0 + 1b90fc3 + 9e7262a)**:GoalSystem `SOURCE_WEIGHT.self_evolution=0.9` + BACKLOG_EXEMPT；`NoeSelfEvolutionCycleStore`(migration v11 建 `noe_self_evolution_cycles` + upsert / getByGoal(rowid tiebreak) / advance)+ P2-6 `validateNoeSelfEvolutionCycleDraft`(只 complete artifact 用完整校验)；`NoeSelfEvolutionTrigger`(observe cooldown 30min + open 去重防上瘾 / tick 单 writer→loop 求 stage→propose)+ server.js 装配 + `selfEvolve` 心跳(NOE_SELF_EVOLUTION 依赖 NOE_HEARTBEAT)；trigger 14 + cycleStore 25 + 集成 3 单测。
- ✅ **三环闭环完成(2026-06-14)**:全量 534 文件 / 4104 测全绿；env 默认 OFF 零回归。
- 三 env 门控仍 OFF。**端到端真自改留 owner live 点火**:① 四开关全开(NOE_SELF_EVOLUTION_EXECUTORS / NOE_SELF_EVOLUTION / NOE_SELF_EVOLUTION_STANDING_GRANT / NOE_HEARTBEAT)② `npm run noe:autonomy:grant` 写 scope `self-evolution:run` ③ 隔离端口 POST `/api/noe/acts/propose` 一个真实自改目标(如改个无关注释)，断言 propose→gate(standing)→executor(spawn→apply→verify→留证)，失败自动 rollback。验证一轮 Cycle 后再把默认改 ON。

**遗留隐患(2 个,顺手收)**:
- rollback-gate 测试依赖未跟踪文件 `output/noe-multimodel/production-self-evolution-governance-20260607-1/ledger.json`(本机存在但未 git 跟踪,干净检出会红)→ 改测试用 mkdtemp 自造 validate-pass ledger(不引产物依赖)。
- `src/memory/NoeMemoryCandidateChainDrill.js:201` 残留 `projectId:'neo'`(codex 修了 CandidateApply 但漏这处)→ 改 `'noe'`。
