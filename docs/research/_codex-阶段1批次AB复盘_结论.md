    62	  it('无候选 → no_candidate', async () => {
    63	    const { trigger } = make({ acq: { candidates: [] } });
    64	    expect(await trigger.observe({ need: 'x' })).toMatchObject({ ok: false, reason: 'no_candidate' });
    65	  });

codex
我没有冒充 M3/Claude 投票；下面是我按当前代码做的只读复盘。结论：**阶段 1 现在不算彻底根除，判定为「否」**。批次 A 是局部止血，批次 B 的 learningHook 在真实生产写门下大概率不成立；即使写入成功，也还没有证明会改变下一次行为。

**主要漏洞**

1. **P0：learningHook 真实写入大概率被 `NoeMemoryWriteGate` 拒绝。**
   证据：[NoeLearningHook.js:46](</Users/hxx/Desktop/Neo 贾维斯/src/cognition/NoeLearningHook.js:46>)-50 用 `kind:'lesson'` 且不传 `sourceEpisodeId/evidenceRefs`；但 `lesson` 不在允许 kind 里，[NoeMemoryCandidateSchema.js:6](</Users/hxx/Desktop/Neo 贾维斯/src/memory/NoeMemoryCandidateSchema.js:6>)-16 会退成 `fact`，[NoeMemoryCandidateSchema.js:130](</Users/hxx/Desktop/Neo 贾维斯/src/memory/NoeMemoryCandidateSchema.js:130>)-132 要求自动 fact/skill/insight 带证据，[NoeMemoryWriteGate.js:49](</Users/hxx/Desktop/Neo 贾维斯/src/memory/NoeMemoryWriteGate.js:49>)-50 会 `source_evidence_required`。生产 gate 在 [server.js:884](</Users/hxx/Desktop/Neo 贾维斯/server.js:884>)。
   改法：要么把 `lesson` 加入 schema 并定义证据规则，要么用 `kind:'insight'`/`project`，传 `evidenceRefs:['goal:<id>', checkpoint refs]`；必须检查 `commit().ok` 和 `commit().memory.id`。

2. **P0：hook 的失败不会阻止 surprise 目标被标 done，是新的指标繁荣。**
   证据：目标完成状态先在 [NoeGoalStepRecorder.js:77](</Users/hxx/Desktop/Neo 贾维斯/src/cognition/NoeGoalStepRecorder.js:77>)-93 写成 done；[server.js:1660](</Users/hxx/Desktop/Neo 贾维斯/server.js:1660>)-1663 只在 done 后异步跑 hook，返回值被丢弃。`learned:false` 不会 reopen / block / 标记目标未学到。
   改法：surprise 目标最后一步“修正并记忆”必须由 hook 成功来完成；失败时目标保持 `blocked`/`learning_failed`，并写 checkpoint/audit。

3. **P0：`commit()` 返回值解析错，id 验证路径基本失效。**
   证据：[NoeLearningHook.js:51](</Users/hxx/Desktop/Neo 贾维斯/src/cognition/NoeLearningHook.js:51>) 只读 `c.id ?? c.memoryId`，但真实 `NoeMemoryWriteGate.commit()` 返回 `{ ok, candidate, memory }`，见 [NoeMemoryWriteGate.js:76](</Users/hxx/Desktop/Neo 贾维斯/src/memory/NoeMemoryWriteGate.js:76>)-83。
   改法：`if (!c?.ok || !c.memory?.id) return {learned:false, reason:c.reason}`；后续按 `c.memory.id` 精确验证。

4. **P1：recall 验证是片段自证，假阳/假阴都存在。**
   证据：[NoeLearningHook.js:56](</Users/hxx/Desktop/Neo 贾维斯/src/cognition/NoeLearningHook.js:56>)-58 用 `lesson.slice(0,25)` 做 `includes`；`MemoryCore.recall()` 会按 topic 查并 bump hit，见 [MemoryCore.js:561](</Users/hxx/Desktop/Neo 贾维斯/src/memory/MemoryCore.js:561>)-581。旧记忆含同片段会假阳，lesson 不含 topic 会假阴。
   改法：验证 `memory.get(id)` 或 recall 结果的 `id/sourceType/createdAt`，并确认 `hit_count` 对目标 id 增长。

5. **P1：hook 没读真正学习证据，只读 `goal.why + 旧 memory`。**
   证据：[NoeLearningHook.js:33](</Users/hxx/Desktop/Neo 贾维斯/src/cognition/NoeLearningHook.js:33>)-35 没读取 `goal.plan[].note`、checkpoint、action evidence、网页正文；而 surprise 目标默认 steps 在 [NoeGoalSystem.js:573](</Users/hxx/Desktop/Neo 贾维斯/src/cognition/NoeGoalSystem.js:573>)-575。
   改法：输入必须包含 plan notes、goal checkpoints、action evidence refs、research report/page body；lesson 要带 evidenceRef。

6. **P1：research 没产出报告也会被标完成，给 hook 喂空证据。**
   证据：[NoeWorkspace.js:495](</Users/hxx/Desktop/Neo 贾维斯/src/cognition/NoeWorkspace.js:495>)-497 checkpoint 可标 `blocked`，但 `recordStepResult(...{done:true})` 仍执行。
   改法：`rr.report` 为空时该 step 不应 done；应 blocked/failed，并触发可审计的无证据学习失败。

7. **P1：RH-1 正则既漏拦系统门，也会误杀真失败。**
   证据：正则在 [NoeStepExpectationBridge.js:24](</Users/hxx/Desktop/Neo 贾维斯/src/cognition/NoeStepExpectationBridge.js:24>)；预算拦截可返回非英文或自定义错误，[ActPipelinePreflight.js:21](</Users/hxx/Desktop/Neo 贾维斯/src/loop/ActPipelinePreflight.js:21>)-24；approval mismatch 在 [ActPipelinePreflight.js:158](</Users/hxx/Desktop/Neo 贾维斯/src/loop/ActPipelinePreflight.js:158>)-170。`not_met` 这种子串也可能误杀真实 executor 断言失败。
   改法：不要用 message regex，当 ActPipeline 输出结构化 `failurePhase/failureKind/executorStarted/realExecuteAttempted`；只允许 executor 已启动后的真实错误进入 surprise。

8. **P1：RH-2 去重/限速是进程内态，重启后失效。**
   证据：`recent/hourly` 都是内存变量，[NoeStepExpectationBridge.js:50](</Users/hxx/Desktop/Neo 贾维斯/src/cognition/NoeStepExpectationBridge.js:50>)-51；ledger 去重只看 open 未结算项，[NoeExpectationLedger.js:95](</Users/hxx/Desktop/Neo 贾维斯/src/cognition/NoeExpectationLedger.js:95>)-97，而 step_prediction 立即 resolved。
   改法：DB 持久化 `(normalizedAction, failureKind, window)`；同时查最近 resolved step_prediction 和 recent surprise goals。

9. **P1：还有 surprise 入口绕过 StepExpectationBridge。**
   证据：自动判证在 [NoeExpectationResolver.js:1596](</Users/hxx/Desktop/Neo 贾维斯/src/cognition/NoeExpectationResolver.js:1596>)-1600 直接 `harvestSurprise`；owner 预测在 [NoeOwnerBehaviorPredictor.js:169](</Users/hxx/Desktop/Neo 贾维斯/src/cognition/NoeOwnerBehaviorPredictor.js:169>)-170 直接 `harvestSurprise`。这些不走 RH-1/RH-2。
   改法：把去重、origin allowlist、noise throttle 放进 `GoalSystem.harvestSurprise()` 或统一 surprise intake，不放在单个桥里。

10. **P1：信息层源仍是根除必需项。**
   当前只有 owner followup/expectation miss 的局部路径；没有通用“owner 否定某事实预测”与“读到内容和 worldModel 矛盾”的结构化源。只靠执行失败会学到工具/权限/网络噪声，学不到世界模型修正。
   改法：新增 epistemic intake：`owner_correction`、`source_contradiction`、`world_model_conflict`，带证据 refs、置信度、去重和 lesson gate。

11. **P2：测试没覆盖真实生产栈。**
   证据：learningHook 单测用假 `writeGate.commit`，[noe-learning-hook.test.js:5](</Users/hxx/Desktop/Neo 贾维斯/tests/unit/noe-learning-hook.test.js:5>)-8，不会暴露真实 gate 拒绝、返回结构、证据要求。
   改法：加 real `MemoryCore + NoeMemoryWriteGate + sqlite` 集成测试，覆盖 rejected/accepted/recall-by-id/goal-not-done-until-learned。

**六问直答**

1. RH-1：**部分**。挡了几类显式系统门，但 regex 不是可靠边界。
2. RH-2：**部分**。单进程短窗有效，重启和措辞变化仍可绕过。
3. learningHook：**否**。真实写门不通，`learned=true` 也只是召回证明，不是行为改变证明。
4. 信息层源：**必须补**。执行失败净化后仍不等于世界模型学习。
5. 阶段 1：**否**。默认 flags 下 A/B 多数不运行；打开后 B 仍大概率写不进或写了没人用。
6. 零回归/边界：默认 OFF 降低回归面，但也意味着没有生产根除证据；未见 secret 暴露风险。本轮只读审查，未改代码、未跑测试。
tokens used
243,400
我没有冒充 M3/Claude 投票；下面是我按当前代码做的只读复盘。结论：**阶段 1 现在不算彻底根除，判定为「否」**。批次 A 是局部止血，批次 B 的 learningHook 在真实生产写门下大概率不成立；即使写入成功，也还没有证明会改变下一次行为。

**主要漏洞**

1. **P0：learningHook 真实写入大概率被 `NoeMemoryWriteGate` 拒绝。**
   证据：[NoeLearningHook.js:46](</Users/hxx/Desktop/Neo 贾维斯/src/cognition/NoeLearningHook.js:46>)-50 用 `kind:'lesson'` 且不传 `sourceEpisodeId/evidenceRefs`；但 `lesson` 不在允许 kind 里，[NoeMemoryCandidateSchema.js:6](</Users/hxx/Desktop/Neo 贾维斯/src/memory/NoeMemoryCandidateSchema.js:6>)-16 会退成 `fact`，[NoeMemoryCandidateSchema.js:130](</Users/hxx/Desktop/Neo 贾维斯/src/memory/NoeMemoryCandidateSchema.js:130>)-132 要求自动 fact/skill/insight 带证据，[NoeMemoryWriteGate.js:49](</Users/hxx/Desktop/Neo 贾维斯/src/memory/NoeMemoryWriteGate.js:49>)-50 会 `source_evidence_required`。生产 gate 在 [server.js:884](</Users/hxx/Desktop/Neo 贾维斯/server.js:884>)。
   改法：要么把 `lesson` 加入 schema 并定义证据规则，要么用 `kind:'insight'`/`project`，传 `evidenceRefs:['goal:<id>', checkpoint refs]`；必须检查 `commit().ok` 和 `commit().memory.id`。

2. **P0：hook 的失败不会阻止 surprise 目标被标 done，是新的指标繁荣。**
   证据：目标完成状态先在 [NoeGoalStepRecorder.js:77](</Users/hxx/Desktop/Neo 贾维斯/src/cognition/NoeGoalStepRecorder.js:77>)-93 写成 done；[server.js:1660](</Users/hxx/Desktop/Neo 贾维斯/server.js:1660>)-1663 只在 done 后异步跑 hook，返回值被丢弃。`learned:false` 不会 reopen / block / 标记目标未学到。
   改法：surprise 目标最后一步“修正并记忆”必须由 hook 成功来完成；失败时目标保持 `blocked`/`learning_failed`，并写 checkpoint/audit。

3. **P0：`commit()` 返回值解析错，id 验证路径基本失效。**
   证据：[NoeLearningHook.js:51](</Users/hxx/Desktop/Neo 贾维斯/src/cognition/NoeLearningHook.js:51>) 只读 `c.id ?? c.memoryId`，但真实 `NoeMemoryWriteGate.commit()` 返回 `{ ok, candidate, memory }`，见 [NoeMemoryWriteGate.js:76](</Users/hxx/Desktop/Neo 贾维斯/src/memory/NoeMemoryWriteGate.js:76>)-83。
   改法：`if (!c?.ok || !c.memory?.id) return {learned:false, reason:c.reason}`；后续按 `c.memory.id` 精确验证。

4. **P1：recall 验证是片段自证，假阳/假阴都存在。**
   证据：[NoeLearningHook.js:56](</Users/hxx/Desktop/Neo 贾维斯/src/cognition/NoeLearningHook.js:56>)-58 用 `lesson.slice(0,25)` 做 `includes`；`MemoryCore.recall()` 会按 topic 查并 bump hit，见 [MemoryCore.js:561](</Users/hxx/Desktop/Neo 贾维斯/src/memory/MemoryCore.js:561>)-581。旧记忆含同片段会假阳，lesson 不含 topic 会假阴。
   改法：验证 `memory.get(id)` 或 recall 结果的 `id/sourceType/createdAt`，并确认 `hit_count` 对目标 id 增长。

5. **P1：hook 没读真正学习证据，只读 `goal.why + 旧 memory`。**
   证据：[NoeLearningHook.js:33](</Users/hxx/Desktop/Neo 贾维斯/src/cognition/NoeLearningHook.js:33>)-35 没读取 `goal.plan[].note`、checkpoint、action evidence、网页正文；而 surprise 目标默认 steps 在 [NoeGoalSystem.js:573](</Users/hxx/Desktop/Neo 贾维斯/src/cognition/NoeGoalSystem.js:573>)-575。
   改法：输入必须包含 plan notes、goal checkpoints、action evidence refs、research report/page body；lesson 要带 evidenceRef。

6. **P1：research 没产出报告也会被标完成，给 hook 喂空证据。**
   证据：[NoeWorkspace.js:495](</Users/hxx/Desktop/Neo 贾维斯/src/cognition/NoeWorkspace.js:495>)-497 checkpoint 可标 `blocked`，但 `recordStepResult(...{done:true})` 仍执行。
   改法：`rr.report` 为空时该 step 不应 done；应 blocked/failed，并触发可审计的无证据学习失败。

7. **P1：RH-1 正则既漏拦系统门，也会误杀真失败。**
   证据：正则在 [NoeStepExpectationBridge.js:24](</Users/hxx/Desktop/Neo 贾维斯/src/cognition/NoeStepExpectationBridge.js:24>)；预算拦截可返回非英文或自定义错误，[ActPipelinePreflight.js:21](</Users/hxx/Desktop/Neo 贾维斯/src/loop/ActPipelinePreflight.js:21>)-24；approval mismatch 在 [ActPipelinePreflight.js:158](</Users/hxx/Desktop/Neo 贾维斯/src/loop/ActPipelinePreflight.js:158>)-170。`not_met` 这种子串也可能误杀真实 executor 断言失败。
   改法：不要用 message regex，当 ActPipeline 输出结构化 `failurePhase/failureKind/executorStarted/realExecuteAttempted`；只允许 executor 已启动后的真实错误进入 surprise。

8. **P1：RH-2 去重/限速是进程内态，重启后失效。**
   证据：`recent/hourly` 都是内存变量，[NoeStepExpectationBridge.js:50](</Users/hxx/Desktop/Neo 贾维斯/src/cognition/NoeStepExpectationBridge.js:50>)-51；ledger 去重只看 open 未结算项，[NoeExpectationLedger.js:95](</Users/hxx/Desktop/Neo 贾维斯/src/cognition/NoeExpectationLedger.js:95>)-97，而 step_prediction 立即 resolved。
   改法：DB 持久化 `(normalizedAction, failureKind, window)`；同时查最近 resolved step_prediction 和 recent surprise goals。

9. **P1：还有 surprise 入口绕过 StepExpectationBridge。**
   证据：自动判证在 [NoeExpectationResolver.js:1596](</Users/hxx/Desktop/Neo 贾维斯/src/cognition/NoeExpectationResolver.js:1596>)-1600 直接 `harvestSurprise`；owner 预测在 [NoeOwnerBehaviorPredictor.js:169](</Users/hxx/Desktop/Neo 贾维斯/src/cognition/NoeOwnerBehaviorPredictor.js:169>)-170 直接 `harvestSurprise`。这些不走 RH-1/RH-2。
   改法：把去重、origin allowlist、noise throttle 放进 `GoalSystem.harvestSurprise()` 或统一 surprise intake，不放在单个桥里。

10. **P1：信息层源仍是根除必需项。**
   当前只有 owner followup/expectation miss 的局部路径；没有通用“owner 否定某事实预测”与“读到内容和 worldModel 矛盾”的结构化源。只靠执行失败会学到工具/权限/网络噪声，学不到世界模型修正。
   改法：新增 epistemic intake：`owner_correction`、`source_contradiction`、`world_model_conflict`，带证据 refs、置信度、去重和 lesson gate。

11. **P2：测试没覆盖真实生产栈。**
   证据：learningHook 单测用假 `writeGate.commit`，[noe-learning-hook.test.js:5](</Users/hxx/Desktop/Neo 贾维斯/tests/unit/noe-learning-hook.test.js:5>)-8，不会暴露真实 gate 拒绝、返回结构、证据要求。
   改法：加 real `MemoryCore + NoeMemoryWriteGate + sqlite` 集成测试，覆盖 rejected/accepted/recall-by-id/goal-not-done-until-learned。

**六问直答**

1. RH-1：**部分**。挡了几类显式系统门，但 regex 不是可靠边界。
2. RH-2：**部分**。单进程短窗有效，重启和措辞变化仍可绕过。
3. learningHook：**否**。真实写门不通，`learned=true` 也只是召回证明，不是行为改变证明。
4. 信息层源：**必须补**。执行失败净化后仍不等于世界模型学习。
5. 阶段 1：**否**。默认 flags 下 A/B 多数不运行；打开后 B 仍大概率写不进或写了没人用。
6. 零回归/边界：默认 OFF 降低回归面，但也意味着没有生产根除证据；未见 secret 暴露风险。本轮只读审查，未改代码、未跑测试。
