# 阶段1 批次A+B(learningHook) 复盘 context（喂三方：M3 / codex GPT5.5 / Claude）

## 目标：判定阶段1 现在算不算彻底根除，还缺什么

第一轮三方复盘判定阶段1(A) 治标（reward hacking 未堵死 + 学习闭环没通 + 接错源）。已做两批整改：

## 批次A（堵 reward hacking + 校准污染，git 已 commit）
改 `src/cognition/NoeStepExpectationBridge.js`：
- **RH-1**：onStepFailed 加 failureReason 参数，正则 `/blocked_safety|executor_not_registered|context_sufficiency|self_evolution_gate|budget|awaiting_approval|not_met|dry_run/i` 命中则 `return {skipped:'system_gate'}`——排除系统自拦，只认真执行失败。NoeWorkspace 三接入点(act blocked/act error/research failed)传 failureReason(ar.error/e.message/err)。
- **RH-2**：bridge 维护 `recent` Map(stepFingerprint::failureClass→ts) 6h 去重 + `hourly` 数组每小时 maxPerHour=6 限速。
- **CAL-10**：NoeExpectationLedger brier()/calibration() SQL 加 `AND source != 'step_prediction'`（伪预测不污染 Brier）。

## 批次B-learningHook（接通立目标→真学到，git 已 commit）
新建 `src/cognition/NoeLearningHook.js`：surprise 目标 done →
① 读证据(goal.why + memory.recall(topic)) ② 本地脑产【具体认知修正 lesson】(prompt 要求含具体对象/条件/事实，禁同质方法论，无则 SKIP) ③ writeGate.commit(kind:'lesson', sourceType:'surprise_lesson') ④ 验证 recall(memory.recall(topic) 命中 lesson 片段 → learned=true，recall bumpHits 让 hit_count 从 0 变正)。写不进/召回不出=learned:false。
server onGoalDone 包装：surprise 目标额外跑 learningHook(NOE_LEARNING_HOOK 默认 OFF)。

## 还没做：信息层 epistemic 源
第一轮三方说真正该学的源在信息层(owner 否定预测 / 读到与 worldModel 矛盾)，没接。本轮要判定它是不是根除必须。

## 请三方彻底审查（专找漏洞 + 判定根除）
1. **RH-1 真堵死了吗**：SYSTEM_GATE 正则够全吗(有没有漏的系统拦原因)？会不会误杀真失败(failureReason 含 not_met 等子串的真失败)？Neo 还有别的刷 surprise 路径吗？
2. **RH-2 去重/限速有效吗**：stepFingerprint(前80字)会不会把不同失败误判同一个(漏 surprise)或不同措辞仍绕过？maxPerHour=6 合理吗？跨进程重启 recent/hourly 内存态丢失会怎样？
3. **learningHook 真接通学习了吗**：产的 lesson 会不会还是同质方法论(prompt 约束够吗)？recall 验证(片段匹配)可靠吗(会不会假阳/假阴)？写进 memory 的 lesson 下次真能改 Neo 行为，还是只是又一张没人读的卡？「learned=true」是真学到的证据，还是新的指标繁荣？
4. **信息层源必要性**：只靠「执行失败(批次A 净化后)+learningHook」够不够根除自主学习空耗？还是必须接 owner 否定/worldModel 矛盾才算根除？给明确判定。
5. **整个阶段1 现在算根除吗**：批次A+learningHook 后，DB 跑起来会怎样？source=surprise 会健康产出+真学到，还是还有空耗/刷分/指标繁荣残留？给「是/部分/否」+ 还需补什么。
6. **代码正确性 + 零回归 + 边界**。

每条给结论+file:line/推理+严重度+改法。专找漏洞别肯定。flag 全默认 OFF。
