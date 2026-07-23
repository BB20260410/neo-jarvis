# 交接:飞轮 stuck 漏点诊断(2026-07-03)

> 本轮只做了诊断+定位,**未改代码**。下个会话据此 TDD 修复。
> (本轮多次触发输出退化循环,故转为交接;诊断本身可靠,有真实数据支撑。)

## 趋势(复盘心跳攒出的第二个数据点)
- 真进步率 16.5% → 16.8%(微升,几乎没动)
- 回滚率 68.3%(黑洞)
- 题库 50% 持平,easy 0%
- 教训累计 +292

真进步率上不去,直接原因是回滚/卡死太多,把进步吃掉了。

## 瓶颈定位(467 个 self_evolution cycle 终态分布)
数据来源:`~/.noe-panel/panel.db` 表 `noe_self_evolution_cycles`,字段 `cycle_json`(JSON),终态在 `.stage`。

- complete 63%(292)
- **self_repair_ready 15%(70)** ← 漏点 A
- **implementation_ready 15%(69)** ← 漏点 B
- post_review_required 4%(20) / value_gate_blocked 3%(13) / consensus_blocked 1%(3)

**30%(139 个)消耗了算力却卡在半路零产出**,是回滚率高的直接机械原因。不是"改坏了",是"卡住了/没被推进"。

## 已确认的机制(读代码验证)
`src/room/NoeSelfEvolutionTrigger.js`:
- L26 `STAGE_TO_ACTION`:`self_repair_ready → noe.self_evolution.self_repair`
- L495-518:implementation verify 失败(executor throw `needsSelfRepair`)→ `cycleStore.advance` 回写 implementation done + runtimeVerification.ok=false → loop 重算到 `self_repair_ready`。**这条路由是对的**,且历史 bug(self_repair gate 缺 producer 恒 false)已在 L508-516 修过。
- L499-501:self_repair **自身失败** throw 的是 `needsConsensus`(非 needsSelfRepair)→ 不再进 self_repair 分支 → `advancedByResult=false` → `noteStuck` → 达阈值 drop。**所以 self_repair 失败是干净 drop,不会卡。**

`src/loop/ActPipeline.js:294`:executor 抛错时白名单透传 `e.selfEvolution` 结构化字段(needsSelfRepair 等),已实现。

## 关键收窄(下个会话从这里开始)
既然"路由到 self_repair_ready 正确"且"self_repair 失败=干净 drop",那**卡在 self_repair_ready 的 70 个 = self_repair 动作被立项(propose)后没被重新驱动执行**。
- 待查:trigger 的 `observe()` 是只对**新 seed** 立项,还是也会对**已在 self_repair_ready 的在途 goal** 重新 propose 并驱动其 self_repair act?
- 假设(匹配长期记忆"self_evolution 供给链单点"):在途 goal 到了 self_repair_ready 后,没有驱动器在下一拍把它的 self_repair act 拿去执行 → 永卡。
- 同理漏点 B(implementation_ready 69 个):implement 完没推进到 verify,可能同一个"在途 goal 不被重新驱动"根因。

## 建议修法(TDD,分量动作)
1. 先复现:构造一个 goal 走到 `self_repair_ready`,断言下一拍**没有**自动 propose/执行其 self_repair act(RED)。
2. 定位驱动器:找 selfEvolve 心跳/observe 里"挑 goal"的逻辑,确认它是否跳过在途 stuck goal。
3. 修:让驱动器把 `self_repair_ready`/`implementation_ready` 的在途 goal 也纳入驱动(推进到对应 action),或加一个"stuck cycle 复活"心跳。
4. flag 默认 OFF + 隔离端口(`PORT=51999 npm run start:noe`)端到端验:卡住的 cycle 被推进到 complete 或干净 drop,不再零产出停滞。
5. 全量 `npm test` + `npm run perf-check` 绿。棘轮按需 bump。

## 验证有没有修好
修完隔几天重跑 `node scripts/noe-evolution-review.mjs`:看 self_repair_ready + implementation_ready 的占比是否下降、真进步率是否上抬。降=有效;不动=换假设。
