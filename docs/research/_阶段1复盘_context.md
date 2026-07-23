# 阶段1「修活好奇回路供给端」复盘 context（喂三方：M3 / codex GPT5.5 / Claude）

## 背景：要彻底根除的问题
Neo 自主学习空耗。多模型研究 DB 实证最深根因（R5/R5b）：
- noe_goals source='surprise' 好奇目标 = **0 条**（从未产生过）；noe_expectations outcome=0 落空 = **0 条**；
  resolver 整个生命周期只判过 **2 条**（343 预测淤积未判证）。
- 即「被现实打脸→惊奇→主动学习」引擎从没接通，真根因是判证供给端**永远没有 outcome=0 喂进来**。

## 阶段1 已做的修复（要复盘的对象，git 已 commit）
新建 `src/cognition/NoeStepExpectationBridge.js`：
- `onStepFailed({stepText, kind, terminal})`：act/research step 真失败（terminal=failed/blocked）时 →
  `expectationLedger.add({claim:"完成步骤：X", p:0.8, source:'step_prediction'})` → 立即 `resolve(id, 0)`（outcome=0）
  → surprise=-log2(0.2)=2.32bit → `goalSystem.harvestSurprise({claim, surprise, origin:'action_failure'})`。
- 接 `NoeWorkspace.js` 三个失败点：act blocked（安全门拦/不放行）、act error（runAct 抛错）、research failed。
- server.js 装配注入（`createStepExpectationBridge({expectationLedger, goalSystem})`）。
- flag `NOE_STEP_EXPECTATION_RESOLVE` 默认 OFF（OFF 时 onStepFailed 直接 return null，零行为）。

### 已设的防 reward hacking
① origin 固定 'action_failure'（硬来源，isNonNoiseSurpriseOrigin 认非噪声）；② 只认 act/research 真实终态失败
（ActPipeline 安全门/执行错/研究失败，非 think 主观、非 Neo 自评 outcome）；③ harvestSurprise 自带标题去重
（同 claim 不重复立好奇目标）；④ flag 默认 OFF。

### 端到端验证（隔离 sqlite + 真 ledger + 真 goalSystem）已通过
act 失败 → outcome=0（原恒 0 → 现 1）→ source=surprise 好奇目标（原恒 0 → 现 1，"搞明白为什么没料到：完成步骤…"）；
反向 probe：think 不触发 / act done 成功不触发 / flag OFF 零行为。8 单测 + 全量 5081 测全绿。

### 暂未做（研究方案的阶段1-B，待复盘判断是否必要）
resolver 减压（NoeExpectationResolver maxPerTick 3→8 + NOE_EXPECT_LOOSEN_FAIL=1 + 缩 RESOLVE_MS），用于消化
343 条淤积的 open 预测。bridge 走的是「step 失败直接产 outcome=0」旁路，绕开了 resolver 的 UNKNOWN 偏置瓶颈。

## 请三方彻底审查（目标：根除，不是打补丁）
1. **reward hacking 是否真堵死**：Neo 会不会学会「故意立会失败的 act/research step」来刷 surprise→刷好奇目标？
   action_failure 来自真实失败，但 Neo 立 act 的动机若被 surprise 奖励污染会怎样？现有 4 道防护够吗？还缺什么？
2. **是否真接通了「学习」闭环**：bridge 立的 source=surprise 好奇目标，它的 steps 是什么？会不会又陷入
   6 主题空耗 / 同质蒸馏（阶段2/3 的病）？「惊奇→立目标→真学到东西」这条线是否完整，还是只接通了前半截？
3. **设计遗漏 / 更深根因**：除了 step 失败，还有哪些「被现实打脸」的源没接（owner 否定预测？读到与世界模型
   矛盾的页面？）？只接 step 失败够不够「修活好奇回路」，还是治标？
4. **阶段1-B 必要性**：343 淤积 open 预测要不要管？不管会怎样？bridge 旁路够不够？
5. **代码正确性 + 边界**：dueAt=now() 立即到期 resolve 对吗？add 去重（textSimilarity）会不会把不同失败误判重复？
   surprise 计算、3 个接入点覆盖是否完整（有没有漏的失败路径）？fail-open？
6. **彻底性自检**：这一刀下去，source=surprise 从 0 变正了，但「Neo 真的会因此学得更好/不再空耗」吗？
   还是只是制造了新的指标繁荣？给出「这阶段算不算彻底根除」的判定 + 还需补什么才算根除。

每条给：结论 + 证据（file:line / DB / 推理）+ 严重度 + 具体改法。不要泛泛肯定，专找漏洞和未根除处。
