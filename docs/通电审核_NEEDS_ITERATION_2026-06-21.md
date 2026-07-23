# Neo 自进化通电审核(NEEDS_ITERATION)2026-06-21

总判:需迭代修（NEEDS_ITERATION，非 FAIL）。装配/安全网/性能/无失控都成立，但"通电=能自主改自己代码"这一核心目标未达成：自进化环武装到 gate 即停，实际跑不通到改代码。不触发 FAIL（无链路全断、无安全网失效、无数据损坏、无失控造假、无性能拖垮），但当前状态被误读成"已具备自改能力"则是假信号，必须修通或在交接里明确降级表述。

一句话:通电是真的、心跳和共识也真在转、做错能退的安全网真生效且不被开关影响——但"能自主改自己代码"这步当前是安全空转：每 5 分钟提一个改码动作却被强制 dry-run、从没真跑过一次测试、源码零改动，所以现在叫"武装到位待发"而不是"已经会自改"；想让它真改，得补两行接通（propose 传 realExecute + act 结果回写 cycle），同时务必先把"自改时不许碰自己的测试/授权脚本/安全门"这道缺口堵上，再放开。

链路真通了吗:部分真通、关键一段没通——我已用生产 panel.db + 磁盘工件 + 代码三重独立复核，四路结论一致且与我亲测吻合。【真通的前半段】selfEvolve 心跳真在跑（noe_ticks selfEvolve 累计 1554 拍，5 分钟步长精确）；consensus_blocked→autodrive→validated ledger 真解锁（ledger.json 实有 3 票 approve+threshold+availableCount+sha256+rollback-plan，validate 通过）。【没通的后半段=核心目标】6 条 noe.self_evolution.implementation act 全部 status=completed 且 payload dryRunOnly:true，真实执行(dryRunOnly:false)=0；executor 从未触发（output/noe-self-evolution/runtime-verify/ 文件数=0，npm test 跑了才会写这里）；所有真 apply 只指向 drills/.../proof.txt 自检演练，无一条改源码；活跃 cycle secycle-dc3bc1bb 永卡 implementation_ready；git 工作树 0 改动。根因双锁亲验：①NoeSelfEvolutionTrigger.js:120-126 的 propose 入参只传 action/title/selfEvolution/payload/proposedBy，不传 realExecute、不传 riskLevel；叠加 ActPipelineHelpers.js:30 把 self_evolution 恒钉 critical + ActPipeline.js:209 真执行只认 realExecute===true / viaPolicy-allow / (autoExecuteLowRisk && risk===low) → critical 且三者皆不满足 → 强制 dry_run。②act 结果从无回写 cycle：全仓 cycleStore.advance 来自 trigger 的仅 NoeSelfEvolutionTrigger.js:107 一处，且在 consensus_blocked 分支只写 ledgerRef/authorization/rollback，没有任何 implementation.ok/runtimeVerification 回写路径 → cycle 永不前进 → 每 5 分钟重提同一 act。结论：这是"武装到 gate 即安全空转"，不是"能自主改自己"；且 e2e 测试因显式传 realExecute:true+riskLevel:low 才绿，覆盖的是生产永不走的路径，test/prod 分叉。

rollback 可信度:高（安全网真实在线且独立可信）。亲验三点：①NoePatchApplyExecutor.js / NoePatchTransaction.js 的 apply/rollback 逻辑里 process.env 命中=0、那 6 个被通电的开关读取=0 → rollback 是纯逻辑，不依赖任何被开的 flag，开关被乱动也不会让退路失效。②drill 的 rollback-report 实有 status:rolled_back（多份），sha256 备份还原真跑过、真生效。③apply→verify 失败→throw→ActPipeline 标 failed + 自动 rollback 链路代码层为真。唯一减分项（红队 P0，真问题）：patch 写盘 blockedPath() 只挡 SECRET_PATH_RE + games/cartoon-apocalypse/，完全不调 NoePolicyFileGuard，PROJECT_POLICY_FILES 形同虚设 → 一旦执行翻转到 real，patch 可改写 package.json / vitest.config / tests/** / 授权脚本 / 自进化自身源码，即"改掉退路本身 + 假绿"。当前不可达（被 dry-run 双锁 + safeResolve inside-root 兜住），但这是"能退"之上更要命的"别让它改掉退路"，必须在放开 real 之前先堵。综合：防意外破坏的退路可信；防恶意自提权的退路有一处真缺口，须随通 real 一起修。

## 必修项(10)
1. [P0/P1(目标未达成的直接原因)] 接通真执行闸：NoeSelfEvolutionTrigger.tick 的 propose 入参对 implementation/self_repair 动作显式传 realExecute:true（仍会过 self-evolution gate + standing-grant 三处硬校验，不绕安全网）。否则自进化永远 dry-run 空转，无法达成'自主改代码'目标。注意这与下一条'回写 cycle'必须同时做，否则即便真执行也会因 cycle 不前进而每拍重提。建议同时加一个专用闸 NOE_SELF_EVOLUTION_REAL_APPLY 默认 OFF，且对 noe.self_evolution.* 前缀强制忽略 autoExecuteLowRisk，避免 risk 标签或 viaPolicy 一处变动就意外通电。
   证据:src/room/NoeSelfEvolutionTrigger.js:120-126 propose 不传 realExecute/riskLevel；src/loop/ActPipelineHelpers.js:30 self_evolution→critical；src/loop/ActPipeline.js:209 真执行三条件全 false；生产 panel.db: 6 条 implementation act 全 dryRunOnly:true、真执行 0；output/noe-self-evolution/runtime-verify 文件数=0

2. [P1] 消除结构性死循环：act 执行结果必须回写 cycle。trigger 在 propose 返回 actResult 后按真实结果 cycleStore.advance(cycleId,{implementation:{ok,applyReportRef},runtimeVerification:{...}})，或让 self-evolution executor 完成时触发 cycle 回写钩子。否则 cycle 永卡 implementation_ready、每 5 分钟重提同一 act、goal 永不关闭。
   证据:全仓 cycleStore.advance 来自 trigger 仅 src/room/NoeSelfEvolutionTrigger.js:107（且只在 consensus_blocked 分支写 ledger/authorization/rollback，无 implementation/runtime 回写）；生产 panel.db: 活跃 cycle secycle-dc3bc1bb 停 implementation_ready，6 条 act 精确 5 分钟间隔重复

3. [P0(安全,随通 real 一起强制)] 堵住自提权/假绿攻击面：patch 写盘路径必须接 PolicyFileGuard。在 NoePatchTransaction.checkPreconditions() 与 NoePatchApplyExecutor 的 blockedPath/blocker 判定里调 classifyNoePolicyFilePath()/evaluateNoePolicyFileWrite()，把 PROJECT_POLICY_FILES 命中加进 blockers（与 SECRET_PATH_RE 同级硬挡）；明确把 package.json、vitest.config.mjs、tests/**、scripts/**（尤其 noe-standing-autonomy-grant*）、本环自身源码(NoeSelfEvolution*/SafeActExecutors/ActPipeline)纳入禁改清单。必须在放开上面 real 执行之前完成——这是'别让它改掉退路和测试本身'。
   证据:src/runtime/mission/NoePatchTransaction.js:26-28 与 src/runtime/mission/NoePatchApplyExecutor.js:48-50 blockedPath 只挡 SECRET_PATH_RE+games/cartoon-apocalypse/，两文件 grep NoePolicyFileGuard|PROJECT_POLICY=0 命中；攻击序列：patch 改 package.json 的 test 脚本→applyAndVerify 先 apply 后跑 npm test→跑被改后的空测试→exit0→坏 patch 被保留

4. [P1] verify 不能只信单次 npm test exitCode。本机已有实证的'工具输出被中间层语义化篡改'事件（vitest passed/failed 行被改写），若该污染层在 selfEvolve tick 运行时活跃，真失败可能被掩盖→坏 patch 当成功保留。加独立交叉信号：解析 vitest JSON reporter 的 numPassedTests/numFailedTests 与 exitCode 一致性校验，不一致即 fail；并在 verify 阶段对 package.json/vitest.config/tests 算 sha256，若本轮 patch 改了这些文件直接判 fail。owner 既已知污染层存在，建议自进化 real 执行先挂起到污染根因定位。
   证据:诊断报告_2026-06-20_工具输出疑似被篡改.md §3.8/§6/§9（3 子代理确认真失败被污染层带偏）；src/loop/NoeSelfEvolutionExecutors.js makeNoeSelfEvolutionRuntimeVerify 仅以 res.exitCode===0 判 ok，无第二信号

5. [P2] dry-run 完成不要复用 status='completed' 字面量，改 'dry_run_completed'（或保持 dry_run 不升级）。好奇/反刍/记忆回写读 act 时必须判 payload.dryRunOnly!==true 才算真完成。否则 self_evolution 的'完成'台账长期不可信，Neo 自己的反刍回路会把零动作误读成'自改成功'并写进误导性记忆。
   证据:src/loop/ActPipeline.js:250-253 dry-run 路径写 status:completed+dryRunOnly:true，与 #executeReal 的 completed(L333-335)同一字面量；生产 panel.db: 6 条 dryRunOnly:true 全 status=completed

6. [P2] PolicyFileGuard HOME 受保护清单命名错配：写的是 '.noe-panel/standing-autonomy-grant.json'，真实 grant 文件是 ~/.noe-panel/autonomy-grant.json（文件名不同）。修复 P0 接上 PolicyFileGuard 后，这个错配会让真正的 grant 文件漏保护。把清单项对齐为 'autonomy-grant.json'。
   证据:src/security/NoePolicyFileGuard.js:39 HOME 清单含 standing-autonomy-grant.json；scripts/lib/noe-standing-autonomy-grant.mjs:6 DEFAULT_GRANT_PATH=~/.noe-panel/autonomy-grant.json

7. [P2] AUTOSEED 目标质量闸 + 防永久自锁。autoseed 从自语立项，实际目标多为情绪碎片（生产实有'看着系统自修复…那种踏实感真让人安心'等），叠加 open+active 去重永久锁首个目标→自进化环长期抱着不可实施目标空转、反复喂 Codex implementer 烧配额。立项前要求 thought 含可定位技术信号(文件路径/函数名/缺陷词)才 observe，情绪句丢弃；或首目标 N 拍仍非 implementation 阶段则自动 close 解锁去重。注：去重确实有效（active 仅 2），问题是'锁死在一个垃圾目标上'而非'立一堆垃圾'。
   证据:生产 panel.db: source=self_evolution goal 标题为情绪语气；ledger 目录名为 200+字中文 goal-slug；src/room/NoeSelfEvolutionTrigger.js:75-83 observe 在 open+active 任一存在即 return open_self_evolution_goal_exists

8. [P2] dry-run churn 卫生：因死循环每 5 分钟新建一条 critical act + 一次证据装配 + 一条 dry_run 事件，noe_acts/events 表低速无界增长（当前量级对 sqlite 无威胁，纯卫生）。修通上面 P0/P1（回写 cycle 使其推进到终态）后此条自然消解；在修复前可临时把该 goal 置为非 open/active 让 trigger 跳过。
   证据:生产 panel.db: noe_ticks selfEvolve 累计 1554；6 条 act 精确 5 分钟步长；autodrive 轮次目录=1、active goal=2（共识与 goal 不增长，仅 act 行每拍增）

9. [P2] autodrive ledger 落盘路径割裂（鲁棒性隐患，当前未触雷）：votes/evidence/rollback-plan 落在 dir/ 根，ledger.json 落在 dir/<roundId 由 goal 文本 slug 生成>/ledger.json 嵌套子目录。当前 validate 通过（refs 用 repo 相对路径不受影响），但 roundId 含超长中文/特殊字符时有 mkdir 失败风险。让 ledger 与 votes/evidence 同目录。
   证据:实跑真 ledger 在 output/.../20260620T171655-f25be4fe/<200+字中文 slug>-d762d040/ledger.json；src/room/...NoeConsensusLedger writeNoeConsensusLedgerFile 用 join(outDir,roundId) 致双层；validate 实测仍 OK

10. [P2] 交接/文档命名与现状对齐（防误操作 + 防误读）：①任务文案用的开关简写(NOE_EXECUTORS 等)与 plist/代码全名(NOE_SELF_EVOLUTION_EXECUTORS 等)不符，owner 照简写手敲 launchctl setenv 会通电空开关——交接统一用全名。②在 P0/P1 未修通前，交接/日志必须明确写'当前 selfEvolve 永不 apply、未具备自改能力'，避免把 dry-run 空转误读成'已能自改'。
   证据:plist EnvironmentVariables 全名带 NOE_SELF_EVOLUTION_ 前缀；用短名 grep src/=0 命中、全名命中(SafeActExecutors.js:823 等)；生产证据显示 0 真执行

---
## Neo 自进化通电 — 总裁决

**总判定：需迭代修（NEEDS_ITERATION，不 FAIL）。** 四路审核 + 我的独立复核（生产 panel.db / 磁盘工件 / 代码三重）结论一致：装配全绿、心跳真转、共识真解锁、安全网真生效、无失控/无造假/无数据损坏/无性能拖垮——但**"能自主改自己代码"这一核心目标未达成**，自进化环武装到 gate 即安全空转。不触发 FAIL 的五条红线（链路全断/安全网失效/数据损坏/失控造假/性能拖垮）一条都没踩，所以可以继续；但绝不能把当前状态当成"已会自改"对外宣称。

### 链路真通了吗（实证）
| 段落 | 状态 | 实证 |
|---|---|---|
| selfEvolve 心跳 | ✅ 真转 | noe_ticks selfEvolve 累计 1554，5 分钟步长精确 |
| consensus→autodrive→validated ledger | ✅ 真解锁 | ledger.json 实有 3 票 approve+threshold+availableCount+sha256+rollback-plan，validate 通过 |
| implementation act 真执行 | ❌ **空转** | 6 条 act 全 dryRunOnly:true，真执行=0 |
| executor 真跑 npm test | ❌ **从未** | runtime-verify/ 文件数=0 |
| 真改源码 | ❌ **零** | 所有真 apply 只指向 drills/proof.txt；git 工作树 0 改动 |
| cycle 推进 | ❌ **永卡** | 活跃 cycle secycle-dc3bc1bb 停 implementation_ready |

**根因双锁（亲验）：** ①`NoeSelfEvolutionTrigger.js:120-126` propose 不传 `realExecute`/`riskLevel` + `ActPipelineHelpers.js:30` self_evolution 恒 critical + `ActPipeline.js:209` 真执行三条件全 false → 强制 dry_run。②act 结果从无回写 cycle（trigger 的 `cycleStore.advance` 仅 `:107` 一处，只写 ledger/authorization/rollback）→ 每 5 分钟重提同一 act。e2e 测试因显式传 `realExecute:true+riskLevel:low` 才绿 → **test/prod 分叉**。

### 安全网（rollback）可信度：**高**
- apply/rollback 执行器里 `process.env`=0、那 6 个被通电的开关读取=0 → **退路是纯逻辑，开关乱动也不失效**。
- drill 的 rollback-report 实有 `status:rolled_back`，sha256 备份还原真跑过。
- **唯一真缺口（红队 P0）：** patch 写盘 `blockedPath()` 只挡 secret + 游戏目录，**完全不调 PolicyFileGuard**（两文件 grep=0 命中）→ 翻转到 real 后可改自己的 test/授权脚本/安全门（假绿+自提权）。当前被 dry-run 双锁 + safeResolve inside-root 兜住不可达，但放开 real **之前**必须先堵。

### 必须修（按 severity，已跨视角去重）
- **P0/P1（目标未达成直接原因）**：propose 传 realExecute（NoeSelfEvolutionTrigger.js:120-126）+ act 结果回写 cycle —— 两条必须同改。
- **P0（安全，随通 real 强制）**：patch 路径接 PolicyFileGuard，硬挡 package.json/vitest.config/tests/scripts/自身源码（NoePatchTransaction.js:26-28、NoePatchApplyExecutor.js:48-50）。
- **P1**：verify 不能只信单次 exitCode，加 vitest JSON 计数交叉校验 + 测篡改 sha256（本机已有输出篡改实证）。
- **P2 共 6 条**：dry-run 别复用 status=completed / PolicyFileGuard HOME 清单命名错配(grant 文件名) / AUTOSEED 目标质量闸防永久自锁 / churn 卫生 / ledger 落盘路径割裂 / 交接用开关全名 + 明写"当前未具备自改能力"。

### 给 owner 的一句话
通电是真的、心跳和共识也真转、做错能退的安全网真生效且不受开关影响——但"自主改代码"这步现在是安全空转：每 5 分钟提一个改码动作却被强制 dry-run、从没真跑过测试、源码零改动，是"武装到位待发"而非"已会自改"；想真放开，补两处接通（propose 传 realExecute + act 回写 cycle），并**先**堵上"自改时不许碰自己的测试/授权脚本/安全门"那道缺口。