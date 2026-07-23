Reading additional input from stdin...
2026-06-16T12:32:04.200396Z ERROR codex_core::session::session: failed to load skill /Users/hxx/.codex/skills/youxi/SKILL.md: invalid YAML: mapping values are not allowed in this context at line 2 column 251
OpenAI Codex v0.137.0
--------
workdir: /Users/hxx/Desktop/Neo 贾维斯
model: gpt-5.5
provider: openai
approval: never
sandbox: read-only
reasoning effort: xhigh
reasoning summaries: none
session id: 019ed06a-d97e-7443-ae81-55b30f087691
--------
user
严格审查 Neo 阶段1 自主学习修复，目标根除不是补丁。先读 docs/research/_阶段1复盘_context.md，再读 src/cognition/NoeStepExpectationBridge.js 全文 + grep stepExpectationBridge 在 NoeWorkspace.js 三接入点 + harvestSurprise(NoeGoalSystem.js:568 看它立的 source=surprise 目标的 steps 是什么)。**最后必须输出结构化结论**：①reward hacking 是否堵死（Neo 能否故意立失败 step 刷 surprise）②学习闭环是否真通（好奇目标 done 后有没有写入记忆/worldModel，还是 no-op）③还有哪些被现实打脸的源没接④代码正确性边界⑤这阶段算不算彻底根除+还需补什么。每条结论+file:line+严重度，专找漏洞。
codex
我先做一次轻量记忆定位，确认这次审查和既有 Neo 阶段/自主学习背景是否有已记录的坑；随后只读代码和文档，不改文件。
exec
/bin/zsh -lc 'rg -n "自主学习|NoeStepExpectationBridge|harvestSurprise|stepExpectationBridge|阶段1|surprise" /Users/hxx/.codex/memories/MEMORY.md' in /Users/hxx/Desktop/Neo 贾维斯
 exited 1 in 0ms:
codex
记忆索引里没有直接命中 `NoeStepExpectationBridge` 或这次“阶段1自主学习修复”的条目，我会以当前仓库内容为准继续审查。
exec
/bin/zsh -lc "nl -ba src/cognition/NoeStepExpectationBridge.js | sed -n '1,260p'" in /Users/hxx/Desktop/Neo 贾维斯
 succeeded in 0ms:
     1	// @ts-check
     2	// NoeStepExpectationBridge — 阶段1：修活好奇回路供给端（治 R5/R5b，多模型研究 DB 实证的最深根因）。
     3	//
     4	// 根因（Claude+M3 研究，panel.db 实测）：source='surprise' 好奇目标恒为 0、outcome=0 落空恒为 0、
     5	//   resolver 整个生命周期只判过 2 条——「被现实打脸→惊奇→主动学习」的引擎从没接通。真根因不是
     6	//   harvestSurprise 门槛，是判证供给端【永远没有 outcome=0 喂进来】（343 预测淤积、judge UNKNOWN 偏置）。
     7	//
     8	// 解法：act/research step 的真实终态（failed/blocked，ActPipeline/research 的客观结果，非 LLM 判证、
     9	//   非 Neo 自评）本身就是对「这步会成功」这条隐式预测的判落空。step 真失败时：登记一条预测并立即
    10	//   resolve(outcome=0) → surprise=-log2(1-p) → harvestSurprise(origin='action_failure')，让好奇回路有米下锅。
    11	//
    12	// 防 reward hacking（红队/研究警示「别让 Neo 故意做容易失败的 act 刷 surprise」）：
    13	//   ① origin 固定 'action_failure'（硬来源，isNonNoiseSurpriseOrigin 认非噪声；不喂自评类）；
    14	//   ② 只认 act/research 真实终态失败（ActPipeline 安全门拦/执行错/研究失败），不认 think；
    15	//   ③ harvestSurprise 自带标题去重（同 claim 不重复立好奇目标）→ 反复同一失败不刷分；
    16	//   ④ flag NOE_STEP_EXPECTATION_RESOLVE 默认 OFF，owner 点火。
    17	//
    18	// 纪律：注入式（expectationLedger + goalSystem + now + 阈值），fail-open，纯增量（OFF 时零行为）。
    19
    20	/**
    21	 * @param {object} opts
    22	 * @param {{add:Function, resolve:Function}} opts.expectationLedger
    23	 * @param {{harvestSurprise:Function}} opts.goalSystem
    24	 * @param {() => number} [opts.now]
    25	 * @param {number} [opts.surpriseThreshold] surprise≥此值才立好奇目标（默认 2bit）
    26	 * @param {number} [opts.predictedP] 「这步会成功」的预测概率（默认 0.8 → 落空 surprise≈2.32bit）
    27	 */
    28	export function createStepExpectationBridge({
    29	  expectationLedger,
    30	  goalSystem,
    31	  now = Date.now,
    32	  surpriseThreshold = 2,
    33	  predictedP = 0.8,
    34	} = {}) {
    35	  /**
    36	   * 一个 act/research step 真实失败时调用：登记「以为能完成」预测 → 判落空 → 接通好奇回路。
    37	   * @param {{goalId?:string, stepIndex?:number, stepText?:string, kind?:string, terminal?:string}} step
    38	   * @returns {{expectationId:number, surprise:number, curiosityGoalId:any}|null}
    39	   */
    40	  function onStepFailed({ stepText, kind, terminal } = {}) {
    41	    if (process.env.NOE_STEP_EXPECTATION_RESOLVE !== '1') return null;
    42	    // 只认 act/research 的真实终态失败（有客观成败，非 think 的主观；非 done/doing）
    43	    if (kind !== 'act' && kind !== 'research') return null;
    44	    if (terminal !== 'failed' && terminal !== 'blocked') return null;
    45	    if (!expectationLedger?.add || !expectationLedger?.resolve || !goalSystem?.harvestSurprise) return null;
    46	    try {
    47	      const claim = `完成步骤：${String(stepText || '').slice(0, 150)}`.trim();
    48	      if (claim.length < 8) return null;
    49	      const id = expectationLedger.add({ claim, p: predictedP, dueAt: now(), source: 'step_prediction' });
    50	      if (!id) return null; // 近期同类预测 open 中（去重命中）→ 不重复
    51	      const r = expectationLedger.resolve(id, 0, now(), 'auto'); // 真实落空 outcome=0
    52	      if (!r) return null;
    53	      const surprise = Number(r.surprise) || 0;
    54	      if (surprise < surpriseThreshold) return { expectationId: id, surprise, curiosityGoalId: null };
    55	      // outcome=0 真实步骤失败 → 立好奇目标（origin=action_failure 硬来源；harvestSurprise 自带去重防刷）
    56	      const curiosityGoalId = goalSystem.harvestSurprise({ claim: r.claim, surprise, origin: 'action_failure' });
    57	      return { expectationId: id, surprise, curiosityGoalId };
    58	    } catch { return null; }
    59	  }
    60
    61	  return { onStepFailed };
    62	}

exec
/bin/zsh -lc "sed -n '1,260p' docs/research/_阶段1复盘_context.md" in /Users/hxx/Desktop/Neo 贾维斯
 succeeded in 0ms:
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

exec
/bin/zsh -lc "nl -ba src/cognition/NoeGoalSystem.js | sed -n '520,620p'" in /Users/hxx/Desktop/Neo 贾维斯
 succeeded in 0ms:
   520	      for (const g of act) {
   521	        if (g.plan.some((s) => BLOCKING_STEP_STATUSES.has(s.status))) continue; // 有步骤在后台执行/等审批：别并行抢
   522	        const idx = g.plan.findIndex((s) => s.status === 'open');
   523	        if (idx >= 0) {
   524	          return stepOutputFromGoal(g, idx);
   525	        }
   526	        if (!g.plan.length) {
   527	          const bootstrapped = bootstrapEmptyGoalPlan(g);
   528	          if (bootstrapped?.plan?.length) return stepOutputFromGoal(bootstrapped, 0);
   529	          return { goalId: g.id, title: g.title, stepIndex: -1, step: `想清楚「${g.title}」的第一步是什么`, kind: 'think', priority: g.priority };
   530	        }
   531	      }
   532	      return null;
   533	    } catch { return null; }
   534	  }
   535
   536	  /**
   537	   * 记一步推进（深思/研究产出）：note 落进步骤；status 可标 'doing'（后台执行中）或 done；
   538	   * 全部完成 → 目标 done。stepIndex=-1（无计划目标）时 newSteps 长出计划。
   539	   * @returns {{ok: boolean, goalDone: boolean, goal?: object}} goalDone=true 时调用方可做技能蒸馏（M7）
   540	   */
   541	  function recordStepResult(goalId, stepIndex, { note = '', done = false, doing = false, status = null, newSteps = null } = {}) {
   542	    return recordGoalStepResult({ getdb, getGoal: get, now, allowActKind, goalId, stepIndex, input: { note, done, doing, status, newSteps } });
   543	  }
   544
   545	  function recordStepCheckpoint(goalId, stepIndex, input = {}) {
   546	    try {
   547	      const g = get(goalId);
   548	      if (!g) return null;
   549	      return appendGoalCheckpoint(getdb(), { now, goal: g, goalId, stepIndex, ...input });
   550	    } catch { return null; }
   551	  }
   552
   553	  function checkpoints({ goalId, stepIndex = null, limit = 100 } = {}) {
   554	    try { return listGoalCheckpoints(getdb(), { goalId, stepIndex, limit }); } catch { return []; }
   555	  }
   556
   557	  function latestCheckpoint({ goalId, stepIndex = null } = {}) {
   558	    try { return latestGoalCheckpoint(getdb(), { goalId, stepIndex }); } catch { return null; }
   559	  }
   560
   561	  /**
   562	   * 好奇回路 v1：高惊奇的落空预测 → 研究目标（被现实打脸的地方就是该学习的地方）。
   563	   * 好奇二分解接入（NOE_EFE_CURIOSITY=1）：在不改「surprise≥2bit 才立项」门槛、不改 title/旧 why 主体的前提下，
   564	   *   用 curiosityScore(epistemic=surprise, pragmatic=pragmaticSignal(claim)) 把这条好奇拆成可解释双因子，
   565	   *   存进 goal.meta.curiosity 并把主导 label 追加进 why（供透视页/反思读「为什么值得好奇」）。
   566	   *   门控 OFF 时走 else 分支——与改造前逐字等价（不算分、不写 meta、why 不变），零回归。
   567	   */
   568	  function harvestSurprise({ claim, surprise, origin } = {}) {
   569	    if (!(Number(surprise) >= curiositySurpriseThreshold) || !claim) return null;
   570	    const surpriseBit = Number(surprise);
   571	    // P1-C：surprise 来源分桶（action_failure/owner_followup/…），让 surprise-learning-audit 验收门 b 区分非噪声 surprise。
   572	    const safeOrigin = (typeof origin === 'string' && origin) ? origin.slice(0, 40) : 'unspecified';
   573	    const baseWhy = `这条预测落空带来 ${Math.round(surpriseBit * 10) / 10} bit 惊奇——我的世界模型在这里有缺口`;
   574	    const steps = ['回看相关记忆与时间线，找我当时的依据', '列出 2-3 个可能的解释', '修正一条认知并记进记忆'];
   575	    const title = `搞明白为什么没料到：${String(claim).slice(0, 120)}`;
   576
   577	    if (!curiosityDecompose?.enabled) {
   578	      // P1-C：传入了 origin 才写 meta（保持「无 origin + decompose off = meta null」的零回归基线；生产两调用点总传 origin）
   579	      return add(safeOrigin !== 'unspecified'
   580	        ? { title, source: 'surprise', why: baseWhy, steps, meta: { origin: safeOrigin } }
   581	        : { title, source: 'surprise', why: baseWhy, steps });
   582	    }
   583
   584	    // ON：算 pragmatic 信号（注入优先，默认=当前目标关键词重叠）；信号炸了退化 value=0、source='none'（fail-open）。
   585	    let prag = { value: 0, source: 'none' };
   586	    try {
   587	      const sig = (typeof pragmaticSignal === 'function' ? pragmaticSignal : defaultPragmaticSignal)(String(claim));
   588	      const v = Number(sig?.value);
   589	      prag = { value: Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : 0, source: String(sig?.source || 'unknown').slice(0, 40) };
   590	    } catch { prag = { value: 0, source: 'none' }; }
   591
   592	    // epistemic = surprise(bit)（落空越狠 = 不确定性缺口越大）；pragmatic 已在 [0,1]，故 pragmaticScale=1。
   593	    const cs = curiosityDecompose.score({ epistemicValue: surpriseBit, pragmaticValue: prag.value, pragmaticScale: 1 });
   594	    const meta = {
   595	      ...(safeOrigin !== 'unspecified' ? { origin: safeOrigin } : {}),
   596	      curiosity: {
   597	        score: cs.score,
   598	        epistemic: cs.epistemic,
   599	        pragmatic: cs.pragmatic,
   600	        label: cs.label,
   601	        pragmaticSource: prag.source,
   602	      },
   603	    };
   604	    const why = `${baseWhy}；好奇画像：${cs.label}（认识价值 ${Math.round(cs.epistemic * 100) / 100} · 实用价值 ${Math.round(cs.pragmatic * 100) / 100}）`;
   605	    return add({ title, source: 'surprise', why, steps, meta });
   606	  }
   607
   608	  /** 概览统计（透视页数据源）。 */
   609	  function stats() {
   610	    try {
   611	      const byStatus = getdb().prepare('SELECT status, COUNT(*) AS n FROM noe_goals GROUP BY status').all()
   612	        .reduce((acc, r) => { acc[r.status] = r.n; return acc; }, /** @type {Record<string, number>} */({}));
   613	      // P1-C 整改 F3：surprise 来源分桶接进 stats——透视页/mind route 是 stats 的生产消费方(noeMind.js:365/383/619)，
   614	      // 由此门 b 的「owner+action 非噪声 surprise」计数进入真实运行时输出（不再只活在单测）。
   615	      return { ...byStatus, surpriseOrigins: surpriseOriginBreakdown() };
   616	    } catch { return {}; }
   617	  }
   618
   619	  return { add, get, list, setStatus, arbitrate, nextStep, recordStepResult, recordStepCheckpoint, checkpoints, latestCheckpoint, harvestSurprise, surpriseOriginBreakdown, maybeSeedAutonomousLearning, stats };
   620	}

exec
/bin/zsh -lc "rg -n \"stepExpectationBridge\" src/cognition/NoeWorkspace.js src/cognition/NoeGoalSystem.js src -g '*.js'" in /Users/hxx/Desktop/Neo 贾维斯
 succeeded in 0ms:
src/cognition/NoeWorkspace.js:160:  stepExpectationBridge = null, // 阶段1：act/research step 真失败→登记预测→outcome=0→harvestSurprise（接通好奇回路供给端，NOE_STEP_EXPECTATION_RESOLVE）
src/cognition/NoeWorkspace.js:511:            try { stepExpectationBridge?.onStepFailed?.({ stepText: winner.stepText || winner.queryText || winner.text, kind: 'research', terminal: 'failed' }); } catch { /* 桥失败不阻断主流程 */ }
src/cognition/NoeWorkspace.js:545:            try { stepExpectationBridge?.onStepFailed?.({ stepText: winner.stepText || winner.queryText || winner.text, kind: 'act', terminal: 'blocked' }); } catch { /* 桥失败不阻断主流程 */ }
src/cognition/NoeWorkspace.js:560:            try { stepExpectationBridge?.onStepFailed?.({ stepText: winner.stepText || winner.queryText || winner.text, kind: 'act', terminal: 'failed' }); } catch { /* 桥失败不阻断主流程 */ }
src/cognition/NoeWorkspace.js:160:  stepExpectationBridge = null, // 阶段1：act/research step 真失败→登记预测→outcome=0→harvestSurprise（接通好奇回路供给端，NOE_STEP_EXPECTATION_RESOLVE）
src/cognition/NoeWorkspace.js:511:            try { stepExpectationBridge?.onStepFailed?.({ stepText: winner.stepText || winner.queryText || winner.text, kind: 'research', terminal: 'failed' }); } catch { /* 桥失败不阻断主流程 */ }
src/cognition/NoeWorkspace.js:545:            try { stepExpectationBridge?.onStepFailed?.({ stepText: winner.stepText || winner.queryText || winner.text, kind: 'act', terminal: 'blocked' }); } catch { /* 桥失败不阻断主流程 */ }
src/cognition/NoeWorkspace.js:560:            try { stepExpectationBridge?.onStepFailed?.({ stepText: winner.stepText || winner.queryText || winner.text, kind: 'act', terminal: 'failed' }); } catch { /* 桥失败不阻断主流程 */ }

codex
我已经读到 bridge 是“失败即写预测再立即 resolve”的旁路，下一步重点看 Workspace 对失败/成功/完成的处理，以及 source=surprise 目标完成后是否有真实记忆写入。
exec
/bin/zsh -lc "nl -ba src/cognition/NoeWorkspace.js | sed -n '120,190p'" in /Users/hxx/Desktop/Neo 贾维斯
 succeeded in 0ms:
   120	  if (!out || typeof out !== 'object') return { noteText: '', exitCode: null, stdoutSummary: '', stderrSummary: '', pageSummary: '' };
   121	  const exitCode = out.exitCode !== undefined ? out.exitCode : null;
   122	  const stdoutSummary = compactText(out.stdout, 600);
   123	  const stderrSummary = compactText(out.stderr, 400);
   124	  // L3.5：browser act 读到的页面正文（read_body 的 extractedText）也进摘要，让深思真消费内容、
   125	  //   写出含页面知识的笔记，而非只看 title 元数据写元笔记（治 owner 实证的「只开不读」空转）。
   126	  const pageText = Array.isArray(out.actions)
   127	    ? out.actions.filter((a) => a && a.contentRead && a.extractedText).map((a) => String(a.extractedText)).join('\n').trim()
   128	    : '';
   129	  const pageSummary = pageText ? compactText(pageText, 1200) : '';
   130	  const parts = [];
   131	  if (exitCode !== null) parts.push(`exit=${exitCode}`);
   132	  if (stdoutSummary) parts.push(`stdout:${stdoutSummary.slice(0, 260)}`);
   133	  if (stderrSummary) parts.push(`stderr:${stderrSummary.slice(0, 180)}`);
   134	  if (pageSummary) parts.push(`页面正文:${pageSummary.slice(0, 700)}`);
   135	  return { noteText: parts.join('；').slice(0, 1200), exitCode, stdoutSummary, stderrSummary, pageSummary };
   136	}
   137
   138	function summarizeActionEvidence(evidence) {
   139	  if (!evidence || typeof evidence !== 'object') return null;
   140	  const semanticTrace = sanitizeActPayload(evidence.semanticTrace || null);
   141	  const summary = {
   142	    schemaVersion: evidence.schemaVersion ?? null,
   143	    actionId: compactText(evidence.actionId || '', 160),
   144	    action: compactText(evidence.action || '', 160),
   145	    riskLevel: compactText(evidence.riskLevel || '', 40),
   146	    dryRunOnly: evidence.dryRunOnly !== false,
   147	    evidenceEventId: evidence.evidenceEventId ?? null,
   148	    logRef: compactText(evidence.logRef || '', 1000),
   149	    sha256: compactText(evidence.sha256 || '', 80),
   150	    refs: sanitizeActPayload(evidence.refs || {}) || {},
   151	  };
   152	  if (semanticTrace) summary.semanticTrace = semanticTrace;
   153	  return summary;
   154	}
   155
   156	export function createWorkspace({
   157	  timeline = null,             // EpisodicTimeline：owner 近况 + 上一念
   158	  commitmentStore = null,      // 到期承诺（只 peek 不 resolve——消费仍归 proactiveTick）
   159	  expectationLedger = null,    // 到期待裁决期望
   160	  stepExpectationBridge = null, // 阶段1：act/research step 真失败→登记预测→outcome=0→harvestSurprise（接通好奇回路供给端，NOE_STEP_EXPECTATION_RESOLVE）
   161	  driveBrief = null,           // () => string|null
   162	  peekVision = null,           // () => {summary}|null
   163	  systemStateProvider = null,  // () => string|null：本机感知三件套缓存块（M3，NoeHostContext）
   164	  affectProbe = null,          // () => {v,a}|null
   165	  textSimilarity = null,       // (a,b)=>0..1（novelty 用）
   166	  deliberate = null,           // NoeDeliberation 实例（注入才有 S2 升级）
   167	  surfacingGate = null,        // NoeSurfacingGate（审议想说的闸）
   168	  sublimate = null,            // (text)=>Promise：既有升华通道（NOE_INNER_SPEAK 才有）
   169	  goalSystem = null,           // NoeGoalSystem（P5，NOE_GOALS=1 才注入）：活跃目标下一步进候选，深思推进
   170	  recordEpisode = null,        // (e)=>void：把"自己做成的事"记进自传时间线（研究完成/自己立项/目标完成）——
   171	                               // 实机检验教训：不记的话他的行动不会成为他的经历，经历流贫血、接地无锚、反思无料
   172	  runResearch = null,          // M6 的"手"：async (query)=>{report,sources}——research 步真上网（DeepResearcher）
   173	  runAct = null,               // 行动的"手"（意识工程 Phase3）：async ({text,goalRef,actionSpec})=>ActPipeline.propose 结果——
   174	                               // act 步走真行动链（预算/权限/共识/审批全套门控自动生效）。未注入时 act 步不会出现
   175	                               // （NoeGoalSystem 数据层 allowActKind 同门控，act 解析回落 think），零差异。
   176	  incidentEscalator = null,    // NoeIncidentEscalator：内心/行动失败里的系统故障 → system_repair 目标
   177	  activityLog = null,          // 可选 ActivityLog：act 结果写入审计流（脱敏摘要，不保存完整输出）
   178	  onGoalDone = null,           // M7 技能蒸馏挂点：目标全完成时回调（成功经验→技能卡入记忆）
   179	  onGoalReportback = null,     // owner 可见任务状态回报：接单后持续显示 running/done/failed/blocked
   180	  insightProvider = null,      // M9：昨夜反思洞察（晨间候选源，server 在反思回调处缓存）
   181	  kv = null,                   // {get,set}：审议日预算
   182	  appendJournal = null,        // (dateStr, lineObj)=>void：意识日志写入（server 注入 fs 实现；测试注入收集器）
   183	  loopGuardGate = null,        // S0.3 思维回环守卫门控 {enabled}（NOE_THOUGHT_LOOP_GUARD=1 才注入，默认 OFF）；未注入/关→整段跳过零回归
   184	  now = Date.now,
   185	  // S0.7（GEPA 可优化对象）：显著度四权重抽成注入式参数。缺省=null → 工厂内 resolveSalienceWeights 走
   186	  //   env NOE_WS_SALIENCE_*(OWNER/URGENCY/NOVELTY/AFFECT) → 原硬编码默认(0.35/0.25/0.2/0.2)。不配置逐字零行为变化。
   187	  //   传 {owner,urgency,novelty,affect} 任意子集可逐项覆盖（GEPA 参数进化注入位）。
   188	  salienceWeights = null,
   189	  // 0.7：到期承诺(~0.78)/新鲜主人互动(~0.72)能升深思，纯看屏(~0.5)/驱力(~0.4)不烧深思预算
   190	  deepThreshold = Number.isFinite(Number(process.env.NOE_WORKSPACE_DEEP_THRESHOLD)) ? Number(process.env.NOE_WORKSPACE_DEEP_THRESHOLD) : 0.7,

exec
/bin/zsh -lc "nl -ba src/cognition/NoeWorkspace.js | sed -n '460,590p'" in /Users/hxx/Desktop/Neo 贾维斯
 succeeded in 0ms:
   460	      try { affectSnap = affectProbe(); arousal = Number(affectSnap?.a) || 0.35; } catch { /* 中性 */ }
   461	    }
   462	    const candidates = collectCandidates(t).map((c) => ({ ...c, score: score(c, arousal) }));
   463	    // 记下本 tick 候选文本（200 截），供 refreshSemanticCache 在 step 之后异步预热——下一 tick 的语义 novelty 才有料。
   464	    // 纯写一个进程内数组，不触发任何 embed（同步 step 仍零网络）。语义闸关时也只是存个数组，无副作用。
   465	    if (semanticOn) { try { lastCandidateTexts = candidates.map((c) => String(c.text || '').slice(0, 200)); } catch { /* 收集候选文本失败不阻断打分 */ } }
   466	    candidates.sort((a, b) => b.score - a.score);
   467	    const winner = candidates[0] || null;
   468
   469	    focusText = winner ? winner.text : null;
   470	    focusSource = winner ? winner.source : null;
   471	    if (winner) { recentWinners.unshift(winner.text.slice(0, 200)); recentWinners.length = Math.min(recentWinners.length, 10); }
   472
   473	    // S0.3 思维回环守卫：广播赢家前对刚更新的近期广播窗口做主题固着检测。门控关/未注入→整段不进逐字零变化；ON 命中只写 thought_loop 证据日志+存信号，绝不改 winner/focusText/currentFocus。
   474	    if (loopGuardGate && loopGuardGate.enabled && winner) {
   475	      try {
   476	        const loop = analyzeThoughtLoop({ recentThoughts: recentWinners.map((text) => ({ text: stripBroadcastLabel(text) })), now: t, gate: loopGuardGate });
   477	        if (loop.enabled && loop.looped) {
   478	          lastLoopSignal = { ts: t, sharedKeywords: loop.sharedKeywords, suggestion: loop.suggestion, consideredCount: loop.consideredCount, winnerSource: winner.source };
   479	          journal(t, { tickId, kind: 'thought_loop', source: winner.source, sharedKeywords: loop.sharedKeywords.slice(0, 4), consideredCount: loop.consideredCount, suggestion: (loop.suggestion || '').slice(0, 160) });
   480	        }
   481	      } catch { /* 回环守卫失败绝不阻断广播（fail-open） */ }
   482	    }
   483
   484	    // M6 研究步分流：kind=research 的目标步不走深思——真上网（异步后台，标 doing 防重复夺冠）
   485	    let researching = false;
   486	    if (winner && winner.source === 'goal_step' && winner.goalRef && winner.kind === 'research' && typeof runResearch === 'function' && goalSystem?.recordStepResult) {
   487	      researching = true;
   488	      try { goalSystem.recordStepCheckpoint?.(winner.goalRef.goalId, winner.goalRef.stepIndex, { phase: 'intent', status: 'queued', kind: 'research', note: '准备执行研究步骤', payload: { query: winner.queryText || winner.text }, replaySafe: true }); } catch { /* checkpoint 失败不阻断 */ }
   489	      try { goalSystem.recordStepResult(winner.goalRef.goalId, winner.goalRef.stepIndex, { doing: true, note: '研究执行中…' }); } catch { /* 标记失败不阻断 */ }
   490	      journal(t, { tickId, kind: 'research_started', goalId: winner.goalRef.goalId, query: (winner.queryText || winner.text).slice(0, 120) });
   491	      emitGoalReportback(winner, 'running', { note: '研究执行中…', kind: 'research', speak: false });
   492	      runResearch(winner.queryText || winner.text)
   493	        .then((rr) => {
   494	          const summary = rr?.report ? String(rr.report).replace(/\s+/g, ' ').slice(0, 400) : '';
   495	          try { goalSystem.recordStepCheckpoint?.(winner.goalRef.goalId, winner.goalRef.stepIndex, { phase: 'evidence', status: rr?.report ? 'done' : 'blocked', kind: 'research', note: summary || '研究完成（未产出报告）', payload: { sourceCount: rr?.sources?.length || 0 }, replaySafe: true }); } catch { /* checkpoint 失败不阻断 */ }
   496	          const res = goalSystem.recordStepResult(winner.goalRef.goalId, winner.goalRef.stepIndex, { done: true, note: summary || '研究完成（未产出报告）' });
   497	          journal(now(), { tickId, kind: 'research_done', goalId: winner.goalRef.goalId, ok: Boolean(rr?.report), sources: rr?.sources?.length || 0 });
   498	          emitGoalReportback(winner, res?.goalDone ? 'done' : 'running', { note: summary || '研究完成（未产出报告），继续下一步。', kind: 'research', goalDone: res?.goalDone === true, speak: res?.goalDone === true });
   499	          // 自己做的事成为自己的经历（盐度 4：高于念头、参与盐度反思与接地锚定）
   500	          try { recordEpisode?.({ type: 'observation', summary: `我上网研究了「${(winner.queryText || winner.text).slice(0, 50)}」，查了 ${rr?.sources?.length || 0} 个来源并写了笔记`, salience: 4 }); } catch { /* 留痕失败不阻断 */ }
   501	          if (res?.goalDone && typeof onGoalDone === 'function') { try { onGoalDone(res.goal); } catch { /* 蒸馏失败不阻断 */ } }
   502	        })
   503	        .catch((e) => {
   504	          try {
   505	            const note = `研究失败：${String(e?.message || e)}`.slice(0, 200);
   506	            goalSystem.recordStepCheckpoint?.(winner.goalRef.goalId, winner.goalRef.stepIndex, { phase: 'evidence', status: 'failed', kind: 'research', note, replaySafe: true });
   507	            goalSystem.recordStepResult(winner.goalRef.goalId, winner.goalRef.stepIndex, { status: 'failed', note });
   508	            emitGoalReportback(winner, 'failed', { note, kind: 'research', speak: true });
   509	            try { incidentEscalator?.observe?.({ source: 'failed_action', status: 'failed', text: `${winner.text}：${note}`, goalId: winner.goalRef.goalId, stepIndex: winner.goalRef.stepIndex }); } catch { /* 自修复升级失败不阻断原失败记录 */ }
   510	            // 阶段1：research 真失败 → 接通好奇回路供给端
   511	            try { stepExpectationBridge?.onStepFailed?.({ stepText: winner.stepText || winner.queryText || winner.text, kind: 'research', terminal: 'failed' }); } catch { /* 桥失败不阻断主流程 */ }
   512	          } catch { /* 同上 */ }
   513	          journal(now(), { tickId, kind: 'research_done', goalId: winner.goalRef.goalId, ok: false });
   514	          if (affectNegativeEpisodes) { try { recordEpisode?.({ type: 'setback', summary: `我上网研究却失败了：「${(winner.queryText || winner.text).slice(0, 50)}」`, salience: 4 }); } catch { /* 留痕失败不阻断 */ } }
   515	        });
   516	    }
   517	    // 行动步分流（意识工程 Phase3，2026-06-11）：kind=act 的目标步不走深思——交 ActPipeline 真行动链。
   518	    // owner full developer trust 下真实执行优先；普通动作无 executor 时落 dry-run 证据，Activity/Checkpoint 负责留痕。
   519	    // 这是"目标长出手"：act 步与系统里其他 act 同等审计。等外部条件时步骤挂 doing（nextStep 不再选中）。
   520	    let acting = false;
   521	    if (winner && winner.source === 'goal_step' && winner.goalRef && winner.kind === 'act' && typeof runAct === 'function' && goalSystem?.recordStepResult) {
   522	      acting = true;
   523	      try { goalSystem.recordStepCheckpoint?.(winner.goalRef.goalId, winner.goalRef.stepIndex, { phase: 'intent', status: 'queued', kind: 'act', action: winner.actionSpec?.action || '', note: '准备执行行动步骤', payload: { actionSpec: winner.actionSpec || null }, replaySafe: false }); } catch { /* checkpoint 失败不阻断 */ }
   524	      try { goalSystem.recordStepResult(winner.goalRef.goalId, winner.goalRef.stepIndex, { doing: true, note: '行动执行中…' }); } catch { /* 标记失败不阻断 */ }
   525	      journal(t, { tickId, kind: 'act_started', goalId: winner.goalRef.goalId, step: (winner.queryText || winner.text).slice(0, 120) });
   526	      emitGoalReportback(winner, 'running', { note: '行动执行中…', kind: 'act', speak: false });
   527	      runAct({ text: winner.queryText || winner.text, goal: winner.goalTitle || '', goalTitle: winner.goalTitle || '', checkpoint: winner.stepText || winner.queryText || '', step: winner.stepText || winner.queryText || '', goalRef: winner.goalRef, actionSpec: winner.actionSpec || null })
   528	        .then((ar) => {
   529	          const approval = ar?.approvalRequired === true;
   530	          const acted = ar?.ok === true && !approval;
   531	          const output = summarizeActOutput(ar);
   532	          const note = approval
   533	            ? `行动等 owner 审批（${ar?.act?.approvalId || '审批单已建'}）`
   534	            : acted
   535	              ? `行动完成：${String(ar?.act?.status || 'completed')}${ar?.act?.payload?.dryRunOnly ? '（dry-run 证据）' : ''}${output.noteText ? `；${output.noteText}` : ''}`
   536	              : `行动未放行：${String(ar?.error || ar?.act?.status || 'unknown')}`.slice(0, 200);
   537	          try { goalSystem.recordStepCheckpoint?.(winner.goalRef.goalId, winner.goalRef.stepIndex, { phase: 'evidence', status: approval ? 'awaiting_approval' : acted ? 'done' : 'blocked', kind: 'act', action: ar?.act?.action || winner.actionSpec?.action || '', note, evidenceRef: ar?.act?.logRef || '', payload: { actId: ar?.act?.id || null, approvalId: ar?.act?.approvalId || null, dryRunOnly: ar?.act?.payload?.dryRunOnly === true, ok: ar?.ok === true, readonly: ar?.act?.payload?.readonly === true || ar?.act?.payload?.actionEvidence?.runtime?.readonly === true, actionEvidenceSummary: summarizeActionEvidence(ar?.act?.payload?.actionEvidence) }, replaySafe: false }); } catch { /* checkpoint 失败不阻断 */ }
   538	          // 等审批：保持 doing 挂住（不再夺冠重试）；完成：done；被档：回 open 留 note
   539	          const res = goalSystem.recordStepResult(winner.goalRef.goalId, winner.goalRef.stepIndex, approval ? { status: 'awaiting_approval', note } : acted ? { done: true, note } : { status: 'blocked', note });
   540	          journal(now(), { tickId, kind: 'act_done', goalId: winner.goalRef.goalId, ok: acted, approval, status: ar?.act?.status || null });
   541	          emitGoalReportback(winner, approval ? 'awaiting_approval' : acted ? (res?.goalDone ? 'done' : 'running') : 'blocked', { note, kind: 'act', goalDone: res?.goalDone === true, speak: approval || !acted || res?.goalDone === true });
   542	          if (!acted && !approval) {
   543	            try { incidentEscalator?.observe?.({ source: 'failed_action', status: 'blocked', text: `${winner.text}：${note}`, goalId: winner.goalRef.goalId, stepIndex: winner.goalRef.stepIndex }); } catch { /* 自修复升级失败不阻断原失败记录 */ }
   544	            // 阶段1：act 真失败 → 接通好奇回路供给端（登记预测→outcome=0→surprise→harvestSurprise(action_failure)）
   545	            try { stepExpectationBridge?.onStepFailed?.({ stepText: winner.stepText || winner.queryText || winner.text, kind: 'act', terminal: 'blocked' }); } catch { /* 桥失败不阻断主流程 */ }
   546	          }
   547	          recordActActivity({ winner, status: approval ? 'awaiting_approval' : acted ? 'done' : 'blocked', actResult: ar, output, error: ar?.error || ar?.act?.status || null });
   548	          try { recordEpisode?.({ type: (affectNegativeEpisodes && !acted && !approval) ? 'setback' : 'observation', summary: `我为目标动了手：「${(winner.queryText || winner.text).slice(0, 50)}」→ ${acted ? '完成' : approval ? '等主人审批' : '被安全门拦下'}`, salience: 4 }); } catch { /* 留痕失败不阻断 */ }
   549	          if (res?.goalDone && typeof onGoalDone === 'function') { try { onGoalDone(res.goal); } catch { /* 蒸馏失败不阻断 */ } }
   550	        })
   551	        .catch((e) => {
   552	          const err = String(e?.message || e);
   553	          try {
   554	            const note = `行动失败：${compactText(err, 200)}`;
   555	            goalSystem.recordStepCheckpoint?.(winner.goalRef.goalId, winner.goalRef.stepIndex, { phase: 'evidence', status: 'failed', kind: 'act', action: winner.actionSpec?.action || '', note, replaySafe: false });
   556	            goalSystem.recordStepResult(winner.goalRef.goalId, winner.goalRef.stepIndex, { status: 'failed', note });
   557	            emitGoalReportback(winner, 'failed', { note, kind: 'act', speak: true });
   558	            try { incidentEscalator?.observe?.({ source: 'failed_action', status: 'failed', text: `${winner.text}：${note}`, goalId: winner.goalRef.goalId, stepIndex: winner.goalRef.stepIndex }); } catch { /* 自修复升级失败不阻断原失败记录 */ }
   559	            // 阶段1：act 抛错失败 → 接通好奇回路供给端
   560	            try { stepExpectationBridge?.onStepFailed?.({ stepText: winner.stepText || winner.queryText || winner.text, kind: 'act', terminal: 'failed' }); } catch { /* 桥失败不阻断主流程 */ }
   561	          } catch { /* 同上 */ }
   562	          journal(now(), { tickId, kind: 'act_done', goalId: winner.goalRef.goalId, ok: false, approval: false });
   563	          recordActActivity({ winner, status: 'failed', error: err });
   564	          if (affectNegativeEpisodes) { try { recordEpisode?.({ type: 'setback', summary: `我为目标动手却失败了：「${(winner.queryText || winner.text).slice(0, 50)}」`, salience: 4 }); } catch { /* 留痕失败不阻断 */ } }
   565	        });
   566	    }
   567	    const deterministicClosure = autoCloseTerminalThinkStep(winner, t, tickId);
   568	    let escalated = false;
   569	    const wantsDeep = winner && !researching && !acting && !deterministicClosure && (winner.score >= deepThreshold || winner.source === 'goal_step'); // think 类目标步必走深思（这就是推进机制）
   570	    if (wantsDeep && typeof deliberate === 'function' && winner.source !== 'last_thought' && deliberationBudgetOk(t)) {
   571	      escalated = true;
   572	      // 深思异步跑（不阻塞认知周期）；产出自己留痕；"想说"过浮现门走既有升华通道。
   573	      // 目标步明确教学完成判定（实机教训：不教的话深思永远不说"步骤完成"，目标永不收口）
   574	      deliberate({
   575	        topic: winner.text,
   576	        // 无计划目标长计划时教 act 步格式（runAct 可用才教——教了用不上只会困惑）：
   577	        // 这是"Noe 自主用手"的入口——深思自己决定哪一步需要真实动手，落成 act 步走 ActPipeline 门控。
   578	        ...(winner.goalRef ? { context: `这是你自己目标的一步。如果经过这轮思考这一步已经想透/可以收口，必须在末尾单独一行写：步骤完成。还没想透就不写。${winner.goalRef.stepIndex === -1 && typeof runAct === 'function' ? '列计划时，如果某一步需要真实动手做，把那一行写成「- [act:noe.note.write] 要做的事」（act: 后是动作名）。可用动作名：noe.note.write=写本地自治笔记；shell.exec=本地诊断/修复/验证命令(argv payload 由系统补齐时用)；browser.open_url=打开 http/https 学习资料页；browser.state_probe/browser.observe=读取浏览器 URL/title 元数据；browser.observe_page=用 DOM 观察当前页；browser.click=按 selector/hints 点击；browser.type=按 selector/hints 输入；macos.app.activate=把指定 macOS App 拉到前台；macos.text.type=向当前前台输入焦点粘贴一段文本；macos.key.press=向前台焦点发送受控按键；macos.pointer.click=按屏幕坐标左键点击；macos.applescript.run/macos.script.run=运行 AppleScript 控制 macOS/App；macos.jxa.run=运行 JXA(JavaScript for Automation) 控制 macOS/App；visual.action.plan=生成浏览器/GUI 操作预演计划。需要参数时写成「- [act:browser.type {"role":"search","hints":["Search"],"text":"Noe autonomy"}] 输入搜索词」、「- [act:browser.click {"hints":["Search"]}] 点击搜索按钮」、「- [act:macos.app.activate {"app":"Google Chrome"}] 切到浏览器」、「- [act:macos.text.type {"app":"Google Chrome","text":"Noe autonomy","ackClipboardOverwrite":true}] 用全局键盘输入文本」、「- [act:macos.key.press {"app":"TextEdit","key":"left"}] 按左方向键」、「- [act:macos.key.press {"key":"return","ackSubmitKey":true}] 明确确认后按回车」、「- [act:macos.pointer.click {"app":"Google Chrome","x":120,"y":240,"ackCoordinateClick":true}] 明确确认后点坐标」、「- [act:macos.applescript.run {"script":"tell application \\"System Events\\" to get name of first process whose frontmost is true"}] 读取前台 App」或「- [act:macos.jxa.run {"script":"JSON.stringify({ok:true})"}] 运行 JXA 自动化脚本」。需要凭据时可以读取和使用本机凭据；普通 act payload 不要无意义塞 token/key/cookie/password，除非该动作本身必须传递凭据。全局键盘会覆盖剪贴板且不要写换行；回车/空格等提交键需要 ackSubmitKey；坐标点击需要 ackCoordinateClick。纯思考或研究的步骤不用标。' : ''}` } : {}),
   579	      })
   580	        .then((d) => {
   581	          // 深思失败（脑不在/报错/空产出/被截断）→ 退还预留名额，失败不消耗当日预算。
   582	          if (d?.deliberated !== true) refundDeliberationBudget(t);
   583	          journal(t, { tickId, kind: 'deliberation_done', topic: winner.text.slice(0, 120), deliberated: d?.deliberated === true, prediction: d?.prediction || null, share: d?.share || null });
   584	          // 目标步推进回写（P5）：审议笔记落进步骤；输出含「步骤完成」标完成；
   585	          // 无计划目标（stepIndex=-1）从审议输出的列表行长出计划。
   586	          if (winner.goalRef && d?.deliberated && goalSystem?.recordStepResult) {
   587	            const listLines = (d.text || '').match(/(?:^|\n)\s*[-•①②③④⑤\d][.、)）]?\s*(.{4,480})/g);
   588	            // [act:动作名] 标记 → act 步对象（深思自主声明"这一步要真动手"；GoalSystem 端 allowActKind 总闸再把一道门）
   589	            const newSteps = listLines ? listLines.map((s) => {
   590	              const text = s.replace(/^[\s\n]*[-•①②③④⑤\d][.、)）]?\s*/, '').trim();

exec
/bin/zsh -lc "nl -ba src/cognition/NoeGoalSystem.js | sed -n '1,220p'" in /Users/hxx/Desktop/Neo 贾维斯
 succeeded in 0ms:
     1	// @ts-check
     2	// NoeGoalSystem — 自主目标系统（设计文档《AI自我意识实现方案》§8 P5）。
     3	//
     4	// 问题：驱力只产生"想要"的感觉（brief 一行字），反刍升华只产生"牵挂"（承诺），Noe 没有
     5	//   "想要什么 → 列为目标 → 排优先级 → 一步步推进 → 完成"的回路——想法永远不落成持续行动。
     6	// 设计：noe_goals 表（迁移 v7）持久化目标 {title, source, why, priority, plan(JSON 步骤数组)}；
     7	//   确定性仲裁公式（零 LLM）每个认知周期重排：
     8	//     priority = 0.5·来源权重 + 0.2·新鲜度 + 0.2·可行性(有步骤) + 0.1·推进动量(最近有步骤完成)
     9	//   同时 active ≤ 2；活跃目标的下一步进工作区当候选（goal_step）——赢得注意力才被推进，
    10	//   推进方式 = 深思审议产出进展笔记（P5 是"思考级执行"，外部工具执行接 act 管线留下阶段）。
    11	// 好奇回路 v1：高惊奇（落空的自信预测，surprise ≥ 2 bit）→ 自动生成"搞明白为什么"的研究目标
    12	//   （NOE_CURIOSITY=1 门控）——被现实打脸的地方就是最该学习的地方。
    13	// 纪律：全注入可测；fail-open；owner 显式目标永远压过自生目标（来源权重 1.0 vs ≤0.6）。
    14	import { randomUUID } from 'node:crypto';
    15	import { getDb } from '../storage/SqliteStore.js';
    16	import { appendGoalCheckpoint, latestGoalCheckpoint, listGoalCheckpoints } from './NoeGoalCheckpoints.js';
    17	import { BLOCKING_STEP_STATUSES, recordGoalStepResult } from './NoeGoalStepRecorder.js';
    18	import { recoverRetriableBlockedGoalSteps, recoverStaleGoalSteps } from './NoeGoalStepRecovery.js';
    19	import { NOE_LEARNING_TOPICS, learningTopicAtCursor, selectLearningTopicForText } from './NoeLearningTopics.js';
    20	import { createCuriosityDecompose } from './NoeCuriosityDecompose.js';
    21	import { clamp01 } from './_mathUtils.js';
    22
    23	const SOURCE_WEIGHT = Object.freeze({
    24	  owner: 1.0,        // 主人显式交办
    25	  system_repair: 0.95, // Noe 自己检测到系统故障后的自修复目标（低于 owner，高于普通自生）
    26	  self_evolution: 0.9, // 环2：Noe 自发的自我进化目标（改自身代码）；高于普通自生，低于系统自修复
    27	  commitment: 0.8,   // 自生承诺升格
    28	  reflection: 0.6,   // 深思审议提出
    29	  surprise: 0.55,    // 好奇回路（被现实打脸）
    30	  self_learning: 0.65, // 自主学习循环：主动上网 + 读本地证据
    31	  drive: 0.4,        // 驱力压力
    32	  self: 0.5,         // 其他自生
    33	});
    34	const DAY = 86_400_000;
    35	const AUTONOMY_EMPTY_GOAL_RE = /自主|主动|自我|学习|优化|迭代|agi|agent|智能体|noe|neo|贾维斯|jarvis|行动|执行|上网|浏览器|电脑|操控|意识|内心|思考/i;
    36	const BACKLOG_EXEMPT_SOURCES = new Set(['owner', 'system_repair', 'self_learning', 'self_evolution']);
    37
    38	function parsePlan(s) {
    39	  try { const p = JSON.parse(s || '[]'); return Array.isArray(p) ? p : []; } catch { return []; }
    40	}
    41
    42	// 解析 goal.meta 列（JSON object）。空/损坏 → null（fail-open：脏元信息绝不污染目标读取）。
    43	function parseMeta(s) {
    44	  if (s == null) return null;
    45	  try { const m = JSON.parse(s); return (m && typeof m === 'object' && !Array.isArray(m)) ? m : null; } catch { return null; }
    46	}
    47
    48	// 默认 pragmatic 信号源：claim 与当前 open/active 目标（排除 surprise 自身源）标题+why 的关键词重叠度 → [0,1]。
    49	// 含义=「这条惊奇有多贴我此刻正在做/在意的事」。诚实地说这是个弱信号（活跃目标稀疏、可能为空），
    50	// 但确定性、自包含、零新依赖；装配方可经 pragmaticSignal 注入更强源（owner 近期话题 / person 偏好）替换。
    51	const CURIOSITY_STOPWORDS = new Set(['的', '了', '是', '在', '和', '与', '我', '你', '他', '她', '它', '这', '那', '为', '会', '要', '到', '把', '被', '让', '没', '不', '也', '都', '就', 'the', 'a', 'an', 'is', 'to', 'of', 'and', 'or', 'for', 'in', 'on', 'why', 'how', 'what']);
    52	function extractKeywords(text) {
    53	  const s = String(text || '').toLowerCase();
    54	  const out = new Set();
    55	  // 英文/数字词
    56	  for (const w of s.match(/[a-z0-9]{2,}/g) || []) if (!CURIOSITY_STOPWORDS.has(w)) out.add(w);
    57	  // 中文：取连续 2 字 bigram（无分词器下最稳的重叠粒度），跳停用字
    58	  const cjk = s.match(/[一-龥]+/g) || [];
    59	  for (const run of cjk) {
    60	    for (let i = 0; i + 1 < run.length; i++) {
    61	      const bg = run.slice(i, i + 2);
    62	      if (!CURIOSITY_STOPWORDS.has(bg[0]) && !CURIOSITY_STOPWORDS.has(bg[1])) out.add(bg);
    63	    }
    64	  }
    65	  return out;
    66	}
    67	function keywordOverlap(aText, bText) {
    68	  const a = extractKeywords(aText);
    69	  if (!a.size) return 0;
    70	  const b = extractKeywords(bText);
    71	  if (!b.size) return 0;
    72	  let hit = 0;
    73	  for (const k of a) if (b.has(k)) hit++;
    74	  return Math.min(1, hit / a.size); // 以 claim 关键词为分母：claim 中多少比例命中当前目标语境
    75	}
    76
    77	export function createGoalSystem({
    78	  db = null,
    79	  now = Date.now,
    80	  maxActive = 2,
    81	  maxBacklog = 8,    // open+active 总数上限：自生目标（非 owner）超限不再收——实机教训：深思立项会上瘾
    82	  staleDays = 14,    // 两周无推进的自生目标自动 paused（防目标库淤积）
    83	  staleStepMs = 6 * 3600_000, // doing 超过该窗口自动释放为 recovered，防目标永久卡死；不会重放动作
    84	  staleResearchStepMs = 90_000, // 后台研究常见由进程重启/请求丢失导致 orphan doing，不能长时间挡住自主行动链
    85	  staleActStepMs = 5 * 60_000,       // 真实 act 执行器多数有 30s 超时；几分钟无 evidence 就该释放后续步骤
    86	  driveLevel = null, // M15（Active Inference 方向第一步）：()=>0..1 最强驱力强度——drive 源目标的权重随"想要的程度"浮动
    87	  // 行动步开关（意识工程 Phase3，2026-06-11）：kind:'act' 步骤（目标长出"安全的手"，经 ActPipeline
    88	  // 完整门控执行）。默认随 NOE_GOAL_ACT；关闭时 act 解析回落 think（想而不动，行为零差异）。
    89	  // 只认显式 {kind:'act'} 对象——文本推断永不产 act（自然语言不该意外变成执行）。
    90	  allowActKind = process.env.NOE_GOAL_ACT === '1',
    91	  autonomousLearning = process.env.NOE_AUTONOMOUS_LEARNING === '1',
    92	  learningIntervalMs = Math.max(60_000, Number(process.env.NOE_AUTONOMOUS_LEARNING_INTERVAL_MS) || 30 * 60_000),
    93	  continuousLearning = process.env.NOE_AUTONOMOUS_LEARNING_CONTINUOUS === '1',
    94	  // 好奇二分解（NoeCuriosityDecompose 接入，env NOE_EFE_CURIOSITY，默认 OFF）：注入 createCuriosityDecompose()
    95	  //   实例；未注入则惰性按 env 建。enabled=false 时 harvestSurprise 与改造前逐字等价（不写 meta，零回归）。
    96	  curiosity = null,
    97	  // pragmatic 信号源（DI）：(claim) => { value:[0,1], source:string }。默认 = 与当前 open/active 目标关键词重叠。
    98	  //   装配方可换更强源（owner 近期话题 / person 偏好）。返回非法/抛异常 → 退化 value=0（fail-open）。
    99	  pragmaticSignal = null,
   100	  // S0.7（GEPA 可优化对象）：好奇回路立项的 surprise 阈值（bit）抽成注入式参数。
   101	  //   opts 缺省读 env NOE_WS_SALIENCE_SURPRISE_BIT，env 也无则用原硬编码默认 2（surprise≥2bit 才立研究目标）。
   102	  //   不配置时与改造前逐字等价（门槛仍为 2，零行为变化）。本步只抽参不改默认。
   103	  curiositySurpriseThreshold = Number.isFinite(Number(process.env.NOE_WS_SALIENCE_SURPRISE_BIT))
   104	    ? Number(process.env.NOE_WS_SALIENCE_SURPRISE_BIT)
   105	    : 2,
   106	  // 阶段3 动态选题（治 cursor%6 循环）：注入 NoeTopicCurator 实例。NOE_DYNAMIC_TOPICS=1 且注入时启用
   107	  //   饱和冷却 + round-robin 跳过已学够的；OFF 或未注入则逐字回退 learningTopicAtCursor(cursor%6) 零回归。
   108	  topicCurator = null,
   109	} = {}) {
   110	  const getdb = () => db || getDb();
   111	  const rowOut = (r) => r ? { ...r, plan: parsePlan(r.plan), meta: parseMeta(r.meta) } : null;
   112	  // 惰性建好奇二分解实例（按 env 门控）；显式注入优先。
   113	  const curiosityDecompose = curiosity || createCuriosityDecompose();
   114
   115	  // 默认 pragmatic 信号：claim 与当前 open/active 目标（剔除 surprise 自身源，避免自指）语境的关键词重叠。
   116	  function defaultPragmaticSignal(claim) {
   117	    try {
   118	      const rows = getdb().prepare("SELECT title, why, source FROM noe_goals WHERE status IN ('open','active')").all();
   119	      const corpus = rows
   120	        .filter((r) => r.source !== 'surprise')
   121	        .map((r) => `${r.title || ''} ${r.why || ''}`)
   122	        .join(' ');
   123	      const value = corpus ? keywordOverlap(claim, corpus) : 0;
   124	      return { value, source: 'active-goals' };
   125	    } catch { return { value: 0, source: 'active-goals' }; }
   126	  }
   127
   128	  function shortGoalTitle(g) {
   129	    return String(g?.title || '').replace(/\s+/g, ' ').trim().slice(0, 120);
   130	  }
   131
   132	  function selectLearningTopicForGoal(g) {
   133	    return selectLearningTopicForText(`${g?.title || ''} ${g?.why || ''}`);
   134	  }
   135
   136	  function buildEmptyAutonomyGoalPlan(g) {
   137	    const titleText = String(g?.title || '');
   138	    const whyText = String(g?.why || '');
   139	    const whyIsExplicitAutonomyAsk = /主人|owner|授权|交办|要求|目标/i.test(whyText) && AUTONOMY_EMPTY_GOAL_RE.test(whyText);
   140	    if (!AUTONOMY_EMPTY_GOAL_RE.test(titleText) && !whyIsExplicitAutonomyAsk) return null;
   141	    const title = shortGoalTitle(g);
   142	    const topic = selectLearningTopicForGoal(g);
   143	    const scanArgs = ['-n', '-i', '--max-count', '100', '--glob', '!games/cartoon-apocalypse/**', topic.localPattern, ...topic.localPaths];
   144	    return [
   145	      { step: `上网搜索并学习：${topic.query}`, kind: 'research' },
   146	      {
   147	        step: '把 Google Chrome 拉到前台，给后续网页学习和 DOM 观察一个真实电脑上下文',
   148	        kind: 'act',
   149	        action: 'macos.app.activate',
   150	        payload: { app: 'Google Chrome', timeoutMs: 10000 },
   151	      },
   152	      {
   153	        step: `打开低风险资料页，获得真实网页上下文：${topic.url}`,
   154	        kind: 'act',
   155	        action: 'browser.open_url',
   156	        payload: { url: topic.url, timeoutMs: 30000 },
   157	      },
   158	      {
   159	        step: '读取浏览器前台 URL/title，确认外部学习页面已打开',
   160	        kind: 'act',
   161	        action: 'browser.state_probe',
   162	        payload: { includeAll: false },
   163	      },
   164	      {
   165	        step: '只读观察当前网页：读标题 + 提取正文，把页面内容变成可学习证据',
   166	        kind: 'act',
   167	        action: 'browser.observe_page',
   168	        payload: {
   169	          browserApp: 'Google Chrome',
   170	          url: topic.url,
   171	          expectedHost: new URL(topic.url).host,
   172	          expectedHosts: [new URL(topic.url).host],
   173	          // L3：read_title + read_body——不再"只开不读"，真提取正文供深思学习（治 owner 实证的浏览器空转）。
   174	          actions: [{ type: 'read_title' }, { type: 'read_body' }],
   175	        },
   176	      },
   177	      {
   178	        step: `只读扫描本项目代码，找出阻碍「${title}」落地的限制点`,
   179	        kind: 'act',
   180	        action: 'shell.exec',
   181	        payload: {
   182	          command: 'rg',
   183	          args: scanArgs,
   184	          readonly: true,
   185	          diagnosticDomains: ['empty_goal_bootstrap', 'autonomy'],
   186	          timeoutMs: 30000,
   187	        },
   188	      },
   189	      {
   190	        step: `写入本地自治笔记，记录「${title}」已从愿望变成行动链`,
   191	        kind: 'act',
   192	        action: 'noe.note.write',
   193	        payload: {
   194	          path: 'output/noe-autonomy/goal-bootstrap.md',
   195	          content: `空计划目标自动拆解：${title}\n学习主题：${topic.title}\n资料入口：${topic.url}\n本地诊断：${['rg', ...scanArgs].join(' ')}\n下一步：结合网页、浏览器状态和本地扫描结果，继续推进真实改进。`,
   196	        },
   197	      },
   198	      { step: '结合外部学习和本地证据，决定下一处要改进的代码或配置并继续执行', kind: 'think' },
   199	    ];
   200	  }
   201
   202	  function buildGenericEmptyGoalPlan(g) {
   203	    const title = shortGoalTitle(g) || '这个目标';
   204	    return [
   205	      { step: `明确「${title}」的成功判据：完成后必须能看到什么证据`, kind: 'think' },
   206	      { step: `整理「${title}」的已知事实、未知缺口和现实约束`, kind: 'think' },
   207	      { step: `选出推进「${title}」的最小下一步，并说明如何验证`, kind: 'think' },
   208	      { step: `复盘「${title}」是否已推进，必要时把下一轮动作重新拆成步骤`, kind: 'think' },
   209	    ];
   210	  }
   211
   212	  function stepOutputFromGoal(g, idx) {
   213	    const st = g.plan[idx];
   214	    const priorNotes = g.plan.slice(0, idx)
   215	      .filter((s) => s.note)
   216	      .slice(-3)
   217	      .map((s) => `${String(s.step || '').slice(0, 60)}：${String(s.note || '').slice(0, 220)}`);
   218	    return {
   219	      goalId: g.id,
   220	      title: g.title,

exec
/bin/zsh -lc "rg -n \"goalDone|recordStepResult|distill|memory|worldModel|source: 'surprise'|source=surprise|surprise\" src/cognition src/loop src -g '*.js'" in /Users/hxx/Desktop/Neo 贾维斯
 succeeded in 0ms:
src/loop/NoeSelfEvolutionActGuard.js:15:  'noe.self_evolution.memory_writeback': 'memory_writeback',
src/loop/NoeSelfEvolutionActGuard.js:150:  const memory = safeObject(context.memoryWriteback);
src/loop/NoeSelfEvolutionActGuard.js:151:  const consensusAuthRequested = authorization.consensusApproved === true || memory.consensusAck === true || memory.autoWrite === true;
src/cognition/NoeAwakeningSignals.js:8://   D1 预测-学习活性：surprise 目标数 + 研究完成率（学了改没改的漏斗末端代理）
src/cognition/NoeAwakeningSignals.js:66:    ? c('SELECT COUNT(*) n FROM noe_expectations WHERE created_at >= ? AND outcome=0 AND surprise IS NOT NULL AND surprise >= ?', sinceTs, SURPRISE_BIT_GATE) : 0;
src/cognition/NoeAwakeningSignals.js:67:  const surpriseGoals = hasGoals ? c("SELECT COUNT(*) n FROM noe_goals WHERE source='surprise' AND created_at >= ?", sinceTs) : 0;
src/cognition/NoeAwakeningSignals.js:68:  const surpriseGoalsDone = hasGoals ? c("SELECT COUNT(*) n FROM noe_goals WHERE source='surprise' AND status='done' AND created_at >= ?", sinceTs) : 0;
src/cognition/NoeAwakeningSignals.js:71:    surpriseGoals,
src/cognition/NoeAwakeningSignals.js:72:    surpriseGoalsDone,
src/cognition/NoeAwakeningSignals.js:73:    researchCompletionRate: surpriseGoals > 0 ? round(surpriseGoalsDone / surpriseGoals) : null,
src/cognition/NoeWorkspace.js:401:  function emitGoalReportback(winner, status, { note = '', kind = null, goalDone = false, speak = null } = {}) {
src/cognition/NoeWorkspace.js:405:      const wantsSpeech = speak === null ? Boolean(goalDone || ['done', 'failed', 'blocked', 'awaiting_approval'].includes(status)) : speak;
src/cognition/NoeWorkspace.js:433:      if (!terminal || !hasEvidence || typeof goalSystem?.recordStepResult !== 'function') return false;
src/cognition/NoeWorkspace.js:442:      const res = goalSystem.recordStepResult(winner.goalRef.goalId, stepIndex, { note, done: true });
src/cognition/NoeWorkspace.js:444:      emitGoalReportback(winner, 'done', { note, kind: 'think', goalDone: res?.goalDone === true, speak: true });
src/cognition/NoeWorkspace.js:445:      if (res?.goalDone && typeof onGoalDone === 'function') { try { onGoalDone(res.goal); } catch { /* 蒸馏失败不阻断 */ } }
src/cognition/NoeWorkspace.js:486:    if (winner && winner.source === 'goal_step' && winner.goalRef && winner.kind === 'research' && typeof runResearch === 'function' && goalSystem?.recordStepResult) {
src/cognition/NoeWorkspace.js:489:      try { goalSystem.recordStepResult(winner.goalRef.goalId, winner.goalRef.stepIndex, { doing: true, note: '研究执行中…' }); } catch { /* 标记失败不阻断 */ }
src/cognition/NoeWorkspace.js:496:          const res = goalSystem.recordStepResult(winner.goalRef.goalId, winner.goalRef.stepIndex, { done: true, note: summary || '研究完成（未产出报告）' });
src/cognition/NoeWorkspace.js:498:          emitGoalReportback(winner, res?.goalDone ? 'done' : 'running', { note: summary || '研究完成（未产出报告），继续下一步。', kind: 'research', goalDone: res?.goalDone === true, speak: res?.goalDone === true });
src/cognition/NoeWorkspace.js:501:          if (res?.goalDone && typeof onGoalDone === 'function') { try { onGoalDone(res.goal); } catch { /* 蒸馏失败不阻断 */ } }
src/cognition/NoeWorkspace.js:507:            goalSystem.recordStepResult(winner.goalRef.goalId, winner.goalRef.stepIndex, { status: 'failed', note });
src/cognition/NoeWorkspace.js:521:    if (winner && winner.source === 'goal_step' && winner.goalRef && winner.kind === 'act' && typeof runAct === 'function' && goalSystem?.recordStepResult) {
src/cognition/NoeWorkspace.js:524:      try { goalSystem.recordStepResult(winner.goalRef.goalId, winner.goalRef.stepIndex, { doing: true, note: '行动执行中…' }); } catch { /* 标记失败不阻断 */ }
src/cognition/NoeWorkspace.js:539:          const res = goalSystem.recordStepResult(winner.goalRef.goalId, winner.goalRef.stepIndex, approval ? { status: 'awaiting_approval', note } : acted ? { done: true, note } : { status: 'blocked', note });
src/cognition/NoeWorkspace.js:541:          emitGoalReportback(winner, approval ? 'awaiting_approval' : acted ? (res?.goalDone ? 'done' : 'running') : 'blocked', { note, kind: 'act', goalDone: res?.goalDone === true, speak: approval || !acted || res?.goalDone === true });
src/cognition/NoeWorkspace.js:544:            // 阶段1：act 真失败 → 接通好奇回路供给端（登记预测→outcome=0→surprise→harvestSurprise(action_failure)）
src/cognition/NoeWorkspace.js:549:          if (res?.goalDone && typeof onGoalDone === 'function') { try { onGoalDone(res.goal); } catch { /* 蒸馏失败不阻断 */ } }
src/cognition/NoeWorkspace.js:556:            goalSystem.recordStepResult(winner.goalRef.goalId, winner.goalRef.stepIndex, { status: 'failed', note });
src/cognition/NoeWorkspace.js:586:          if (winner.goalRef && d?.deliberated && goalSystem?.recordStepResult) {
src/cognition/NoeWorkspace.js:594:            const res = goalSystem.recordStepResult(winner.goalRef.goalId, winner.goalRef.stepIndex, {
src/cognition/NoeWorkspace.js:600:            if (stepDone || newSteps) emitGoalReportback(winner, res?.goalDone ? 'done' : 'running', { note: stepDone ? '思考步骤已完成，继续推进后续步骤。' : '已经拆出执行计划，继续推进。', kind: 'think', goalDone: res?.goalDone === true, speak: res?.goalDone === true });
src/cognition/NoeWorkspace.js:601:            if (res?.goalDone && typeof onGoalDone === 'function') { try { onGoalDone(res.goal); } catch { /* 蒸馏失败不阻断 */ } }
src/loop/NoeSelfEvolutionExecutors.js:15://   - memory_writeback 只写脱敏 summary，绝不写 diff/secret。
src/loop/NoeSelfEvolutionExecutors.js:32:  'noe.self_evolution.memory_writeback',
src/loop/NoeSelfEvolutionExecutors.js:122: * @param {{root?: string, evaluateGrant?: Function, spawnImplementer?: Function, runtimeVerify?: Function, memoryWrite?: Function, appendEvent?: Function, now?: any}} deps
src/loop/NoeSelfEvolutionExecutors.js:131:    memoryWrite,
src/loop/NoeSelfEvolutionExecutors.js:195:  executors.set('noe.self_evolution.memory_writeback', async ({ act }) => {
src/loop/NoeSelfEvolutionExecutors.js:198:    const mw = (ctx.memoryWriteback && typeof ctx.memoryWriteback === 'object') ? ctx.memoryWriteback : {};
src/loop/NoeSelfEvolutionExecutors.js:201:    if (!summary) throw selfEvolutionError('self_evolution_memory_summary_required');
src/loop/NoeSelfEvolutionExecutors.js:202:    const written = typeof memoryWrite === 'function'
src/loop/NoeSelfEvolutionExecutors.js:203:      ? memoryWrite({ body: summary, scope: 'fact', sourceType: 'self_evolution', title: clean(ctx.objective || 'self-evolution', 120) })
src/loop/NoeSelfEvolutionExecutors.js:205:    return { written: true, memoryId: (written && written.id) || '', secretValuesReturned: false };
src/loop/NoeSelfEvolutionExecutors.js:214:      memoryId: clean(ctx.memoryId || '', 200),
src/cognition/NoeOwnerBehaviorPredictor.js:11://      若 owner 明确取消/否定交办后的 followup → resolve(id,0) 并可触发 surprise 学习。
src/cognition/NoeOwnerBehaviorPredictor.js:104: *   followupP?: number,         // followup 预测主观概率（强先验；默认 0.75，落空 surprise=2bit）
src/cognition/NoeOwnerBehaviorPredictor.js:108: *   goalSystem?: {harvestSurprise?: Function}|null, // 明确 followup 落空时把 surprise 接入好奇目标
src/cognition/NoeOwnerBehaviorPredictor.js:170:            try { goalSystem.harvestSurprise({ claim: row.claim, surprise: resolvedRow.surprise, origin: 'owner_prediction' }); } // P1-C：owner 明确否定 followup = owner 真实负反馈（门 b 非噪声）
src/loop/NoeLoop.js:22:    memory = null,
src/loop/NoeLoop.js:36:    this.memory = memory;
src/loop/NoeLoop.js:190:    const memoryStats = this.memory?.stats ? this.memory.stats({ projectId: this.projectId }) : null;
src/loop/NoeLoop.js:210:            await this.#finalizeBudgetDeath({ focusItems, memoryStats, error: e });
src/loop/NoeLoop.js:217:          await this.actHandler({ signal, loop: this, focusItems, memoryStats });
src/loop/NoeLoop.js:223:      await this.tickHandler({ signal, loop: this, focusItems, memoryStats });
src/loop/NoeLoop.js:251:      memoryVisible: memoryStats?.visible ?? null,
src/loop/NoeLoop.js:265:  async #finalizeBudgetDeath({ focusItems = [], memoryStats = null, error = null } = {}) {
src/loop/NoeLoop.js:268:      if (memoryStats) msgs.push({ role: 'system', content: `[记忆状态] 可见 ${memoryStats.visible ?? '?'} 条` });
src/loop/NoeLoop.js:271:      this.memory?.write?.({
src/loop/proactiveTick.js:20:  visionSession, ttsClient, getAdapter, memory,
src/loop/proactiveTick.js:189:      memory?.write?.({ projectId, scope: 'proactive', sourceType: 'noe_proactive', body: `宝贝主动说：${say}`, tags: ['proactive', 'voice'] });
src/cognition/NoeThoughtLoopGuard.js:26:import { normalizeForDedup } from '../memory/NoeMemoryDedup.js';
src/loop/clusterMemoryTick.js:5:// 安全边界（CE12 P0 红线）：纯本地只读 —— 只读 roomStore.list() + 写 noe_memory，
src/loop/clusterMemoryTick.js:43: * @param {object}   deps.memory     MemoryCore 实例（需有 write()）
src/loop/clusterMemoryTick.js:49:export function createClusterMemoryTickHandler({ memory, roomStore, projectId = 'noe', maxRooms = 30 } = {}) {
src/loop/clusterMemoryTick.js:50:  if (!memory || typeof memory.write !== 'function') {
src/loop/clusterMemoryTick.js:51:    throw new Error('createClusterMemoryTickHandler requires memory.write');
src/loop/clusterMemoryTick.js:69:        memory.write({
src/cognition/SelfTalkOutcome.js:16:  'memory',
src/cognition/SelfTalkOutcome.js:81: * @property {'expectation'|'commitment'|'goal'|'memory'|'awareness'|'silent'} type
src/loop/NoeSelfEvolutionActGuard.js:15:  'noe.self_evolution.memory_writeback': 'memory_writeback',
src/loop/NoeSelfEvolutionActGuard.js:150:  const memory = safeObject(context.memoryWriteback);
src/loop/NoeSelfEvolutionActGuard.js:151:  const consensusAuthRequested = authorization.consensusApproved === true || memory.consensusAck === true || memory.autoWrite === true;
src/loop/ActPipeline.js:64:  planFromLoopContext({ focusItems = [], memoryStats = null } = {}) {
src/loop/ActPipeline.js:73:        memoryVisible: memoryStats?.visible ?? null,
src/cognition/NoeApprovalGoalResolver.js:88:  let goalDone = false;
src/cognition/NoeApprovalGoalResolver.js:89:  if (goalRef && goalSystem?.recordStepResult) {
src/cognition/NoeApprovalGoalResolver.js:110:        ? goalSystem.recordStepResult(goalRef.goalId, goalRef.stepIndex, { done: true, note })
src/cognition/NoeApprovalGoalResolver.js:111:        : goalSystem.recordStepResult(goalRef.goalId, goalRef.stepIndex, { status: stepStatus, note });
src/cognition/NoeApprovalGoalResolver.js:113:      goalDone = res?.goalDone === true;
src/cognition/NoeApprovalGoalResolver.js:117:  return { goalUpdated, goalDone, goalRef };
src/loop/NoeSelfEvolutionExecutors.js:15://   - memory_writeback 只写脱敏 summary，绝不写 diff/secret。
src/loop/NoeSelfEvolutionExecutors.js:32:  'noe.self_evolution.memory_writeback',
src/loop/NoeSelfEvolutionExecutors.js:122: * @param {{root?: string, evaluateGrant?: Function, spawnImplementer?: Function, runtimeVerify?: Function, memoryWrite?: Function, appendEvent?: Function, now?: any}} deps
src/loop/NoeSelfEvolutionExecutors.js:131:    memoryWrite,
src/loop/NoeSelfEvolutionExecutors.js:195:  executors.set('noe.self_evolution.memory_writeback', async ({ act }) => {
src/loop/NoeSelfEvolutionExecutors.js:198:    const mw = (ctx.memoryWriteback && typeof ctx.memoryWriteback === 'object') ? ctx.memoryWriteback : {};
src/loop/NoeSelfEvolutionExecutors.js:201:    if (!summary) throw selfEvolutionError('self_evolution_memory_summary_required');
src/loop/NoeSelfEvolutionExecutors.js:202:    const written = typeof memoryWrite === 'function'
src/loop/NoeSelfEvolutionExecutors.js:203:      ? memoryWrite({ body: summary, scope: 'fact', sourceType: 'self_evolution', title: clean(ctx.objective || 'self-evolution', 120) })
src/loop/NoeSelfEvolutionExecutors.js:205:    return { written: true, memoryId: (written && written.id) || '', secretValuesReturned: false };
src/loop/NoeSelfEvolutionExecutors.js:214:      memoryId: clean(ctx.memoryId || '', 200),
src/loop/NoeLoop.js:22:    memory = null,
src/loop/NoeLoop.js:36:    this.memory = memory;
src/loop/NoeLoop.js:190:    const memoryStats = this.memory?.stats ? this.memory.stats({ projectId: this.projectId }) : null;
src/loop/NoeLoop.js:210:            await this.#finalizeBudgetDeath({ focusItems, memoryStats, error: e });
src/loop/NoeLoop.js:217:          await this.actHandler({ signal, loop: this, focusItems, memoryStats });
src/loop/NoeLoop.js:223:      await this.tickHandler({ signal, loop: this, focusItems, memoryStats });
src/loop/NoeLoop.js:251:      memoryVisible: memoryStats?.visible ?? null,
src/loop/NoeLoop.js:265:  async #finalizeBudgetDeath({ focusItems = [], memoryStats = null, error = null } = {}) {
src/loop/NoeLoop.js:268:      if (memoryStats) msgs.push({ role: 'system', content: `[记忆状态] 可见 ${memoryStats.visible ?? '?'} 条` });
src/loop/NoeLoop.js:271:      this.memory?.write?.({
src/cognition/NoeCuriosityDecompose.js:9://   Neo 现状只有单标量 surprise=-log2(p)（NoeExpectationLedger.js）+ 单阈值好奇回路
src/cognition/NoeCuriosityDecompose.js:10://   harvestSurprise（NoeGoalSystem.js，surprise≥2bit → 研究目标），没有拆 epistemic/pragmatic。
src/cognition/NoeCuriosityDecompose.js:15://   把现有单 surprise（≈ epistemicValue 的天然来源：落空越狠 = 不确定性缺口越大）当 epistemic 输入，
src/cognition/NoeCuriosityDecompose.js:23://   - 与 NoeExpectationLedger 的 surprise=-log2(p) 不重复——这里不算 surprise，只消费它。
src/cognition/NoeCuriosityDecompose.js:36: * Neo 的 surprise 单位是 bit（-log2(p)），默认 scale=2 → 恰好 2bit（现有好奇阈值）映射到 0.5。
src/cognition/NoeCuriosityDecompose.js:93: * @param {number} args.epistemicValue 认识价值原始量（如 surprise(bit)/信念熵/信息增益；非负，越大越好奇）
src/cognition/NoeLearningTopics.js:7:    query: 'autonomous agent self directed web research memory goal execution checkpoint examples',
src/cognition/NoeLearningTopics.js:21:    query: 'agent memory conflict temporal knowledge graph Letta Mem0 Graphiti Zep sleep time compute',
src/cognition/NoeLearningTopics.js:22:    url: 'https://github.com/topics/agent-memory',
src/cognition/NoeLearningTopics.js:24:    localPaths: ['src/memory', 'src/cognition', 'docs', 'tests/unit'],
src/cognition/NoeLearningTopics.js:30:    localPattern: 'checkpoint|awaiting_approval|recovered|blocked|recordStepResult|act_started|act_done|NoeHeartbeat',
src/cognition/NoeLearningTopics.js:38:    localPaths: ['src/cognition', 'src/loop', 'src/memory', 'docs'],
src/cognition/NoeLearningTopics.js:58:  if (/记忆|长期|冲突|修正|memory|conflict/i.test(s)) return topics[2] || learningTopicAtCursor(2, topics);
src/loop/proactiveTick.js:20:  visionSession, ttsClient, getAdapter, memory,
src/loop/proactiveTick.js:189:      memory?.write?.({ projectId, scope: 'proactive', sourceType: 'noe_proactive', body: `宝贝主动说：${say}`, tags: ['proactive', 'voice'] });
src/cognition/NoeDeliberation.js:58:  memory = null,              // MemoryCore（M7/CoALA 检索动作：深思前自动召回相关记忆与技能卡）
src/cognition/NoeDeliberation.js:86:    if (memory?.recall) {
src/cognition/NoeDeliberation.js:88:        const hits = memory.recall({ query: focus.slice(0, 120), projectId, limit: 3 }) || [];
src/loop/clusterMemoryTick.js:5:// 安全边界（CE12 P0 红线）：纯本地只读 —— 只读 roomStore.list() + 写 noe_memory，
src/loop/clusterMemoryTick.js:43: * @param {object}   deps.memory     MemoryCore 实例（需有 write()）
src/loop/clusterMemoryTick.js:49:export function createClusterMemoryTickHandler({ memory, roomStore, projectId = 'noe', maxRooms = 30 } = {}) {
src/loop/clusterMemoryTick.js:50:  if (!memory || typeof memory.write !== 'function') {
src/loop/clusterMemoryTick.js:51:    throw new Error('createClusterMemoryTickHandler requires memory.write');
src/loop/clusterMemoryTick.js:69:        memory.write({
src/cognition/SelfTalkLandingPolicy.js:6:// goal/memory/awareness, or explicitly close as silent. Silent clears the loop
src/cognition/SelfTalkLandingPolicy.js:13:  complianceLandingTypes: Object.freeze(['expectation', 'commitment', 'goal', 'memory', 'awareness', 'silent']),
src/cognition/SelfTalkLandingPolicy.js:14:  externalLandingTypes: Object.freeze(['expectation', 'commitment', 'goal', 'memory', 'awareness']),
src/loop/ActPipeline.js:64:  planFromLoopContext({ focusItems = [], memoryStats = null } = {}) {
src/loop/ActPipeline.js:73:        memoryVisible: memoryStats?.visible ?? null,
src/cognition/NoeStepExpectationBridge.js:4:// 根因（Claude+M3 研究，panel.db 实测）：source='surprise' 好奇目标恒为 0、outcome=0 落空恒为 0、
src/cognition/NoeStepExpectationBridge.js:10://   resolve(outcome=0) → surprise=-log2(1-p) → harvestSurprise(origin='action_failure')，让好奇回路有米下锅。
src/cognition/NoeStepExpectationBridge.js:12:// 防 reward hacking（红队/研究警示「别让 Neo 故意做容易失败的 act 刷 surprise」）：
src/cognition/NoeStepExpectationBridge.js:25: * @param {number} [opts.surpriseThreshold] surprise≥此值才立好奇目标（默认 2bit）
src/cognition/NoeStepExpectationBridge.js:26: * @param {number} [opts.predictedP] 「这步会成功」的预测概率（默认 0.8 → 落空 surprise≈2.32bit）
src/cognition/NoeStepExpectationBridge.js:32:  surpriseThreshold = 2,
src/cognition/NoeStepExpectationBridge.js:38:   * @returns {{expectationId:number, surprise:number, curiosityGoalId:any}|null}
src/cognition/NoeStepExpectationBridge.js:53:      const surprise = Number(r.surprise) || 0;
src/cognition/NoeStepExpectationBridge.js:54:      if (surprise < surpriseThreshold) return { expectationId: id, surprise, curiosityGoalId: null };
src/cognition/NoeStepExpectationBridge.js:56:      const curiosityGoalId = goalSystem.harvestSurprise({ claim: r.claim, surprise, origin: 'action_failure' });
src/cognition/NoeStepExpectationBridge.js:57:      return { expectationId: id, surprise, curiosityGoalId };
src/cognition/NoeExpectationResolver.js:350:  return kinds.some((item) => /episode|thought|reflection|observation|self_talk|memory/i.test(String(item.kind || '')));
src/cognition/NoeExpectationResolver.js:582:// P1-C 整改（双代理验收 F1+F2）：surprise 来源分桶——据预测 source + loosen 检测推导 origin，供验收门 b 区分非噪声。
src/cognition/NoeExpectationResolver.js:592:// P1-C 整改 F3：验收门 b 判据——owner_*/action_failure 是 owner+action 类「非噪声」surprise；loosen_fail/reflection_miss/expectation_miss 不计。
src/cognition/NoeExpectationResolver.js:613:    observationKinds: countSummaryMatches(kinds, 'kind', /episode|thought|reflection|observation|self_talk|memory/i),
src/cognition/NoeExpectationResolver.js:919:  return /episode|thought|reflection|observation|self_talk|memory/i.test(String(kind || ''));
src/cognition/NoeExpectationResolver.js:1597:            // 「被现实硬纠正后主动学习」的发动机；此前自动判证路径从不接 harvestSurprise（source=surprise 恒为 0）。
src/cognition/NoeExpectationResolver.js:1599:              try { goalSystem.harvestSurprise({ claim: exp.claim, surprise: resolvedRow.surprise, origin: deriveSurpriseOrigin(exp.source, { loosenOnly: v.loosenOnly }) }); } // P1-C 整改 F1+F2：据 source 推导 origin + loosen_fail 噪声分桶
src/cognition/NoeExpectationSemanticRecall.js:6:// source=surprise 恒 0。R6 离线实验（真实 claim×events qwen3-embedding）证实：4/6 claim 与相关事件有强语义
src/cognition/NoeGoalSystem.js:11:// 好奇回路 v1：高惊奇（落空的自信预测，surprise ≥ 2 bit）→ 自动生成"搞明白为什么"的研究目标
src/cognition/NoeGoalSystem.js:29:  surprise: 0.55,    // 好奇回路（被现实打脸）
src/cognition/NoeGoalSystem.js:48:// 默认 pragmatic 信号源：claim 与当前 open/active 目标（排除 surprise 自身源）标题+why 的关键词重叠度 → [0,1]。
src/cognition/NoeGoalSystem.js:100:  // S0.7（GEPA 可优化对象）：好奇回路立项的 surprise 阈值（bit）抽成注入式参数。
src/cognition/NoeGoalSystem.js:101:  //   opts 缺省读 env NOE_WS_SALIENCE_SURPRISE_BIT，env 也无则用原硬编码默认 2（surprise≥2bit 才立研究目标）。
src/cognition/NoeGoalSystem.js:115:  // 默认 pragmatic 信号：claim 与当前 open/active 目标（剔除 surprise 自身源，避免自指）语境的关键词重叠。
src/cognition/NoeGoalSystem.js:120:        .filter((r) => r.source !== 'surprise')
src/cognition/NoeGoalSystem.js:234:    const res = recordStepResult(g.id, -1, {
src/cognition/NoeGoalSystem.js:306:  // P1-C 整改 F3：surprise 来源运行时分桶（验收门 b 消费端）——区分 owner+action 非噪声 vs loosen_fail/expectation_miss 等噪声。
src/cognition/NoeGoalSystem.js:307:  function surpriseOriginBreakdown({ limit = 500 } = {}) {
src/cognition/NoeGoalSystem.js:310:      const rows = getdb().prepare("SELECT meta FROM noe_goals WHERE source = 'surprise' ORDER BY created_at DESC LIMIT ?").all(lim);
src/cognition/NoeGoalSystem.js:539:   * @returns {{ok: boolean, goalDone: boolean, goal?: object}} goalDone=true 时调用方可做技能蒸馏（M7）
src/cognition/NoeGoalSystem.js:541:  function recordStepResult(goalId, stepIndex, { note = '', done = false, doing = false, status = null, newSteps = null } = {}) {
src/cognition/NoeGoalSystem.js:563:   * 好奇二分解接入（NOE_EFE_CURIOSITY=1）：在不改「surprise≥2bit 才立项」门槛、不改 title/旧 why 主体的前提下，
src/cognition/NoeGoalSystem.js:564:   *   用 curiosityScore(epistemic=surprise, pragmatic=pragmaticSignal(claim)) 把这条好奇拆成可解释双因子，
src/cognition/NoeGoalSystem.js:568:  function harvestSurprise({ claim, surprise, origin } = {}) {
src/cognition/NoeGoalSystem.js:569:    if (!(Number(surprise) >= curiositySurpriseThreshold) || !claim) return null;
src/cognition/NoeGoalSystem.js:570:    const surpriseBit = Number(surprise);
src/cognition/NoeGoalSystem.js:571:    // P1-C：surprise 来源分桶（action_failure/owner_followup/…），让 surprise-learning-audit 验收门 b 区分非噪声 surprise。
src/cognition/NoeGoalSystem.js:573:    const baseWhy = `这条预测落空带来 ${Math.round(surpriseBit * 10) / 10} bit 惊奇——我的世界模型在这里有缺口`;
src/cognition/NoeGoalSystem.js:580:        ? { title, source: 'surprise', why: baseWhy, steps, meta: { origin: safeOrigin } }
src/cognition/NoeGoalSystem.js:581:        : { title, source: 'surprise', why: baseWhy, steps });
src/cognition/NoeGoalSystem.js:592:    // epistemic = surprise(bit)（落空越狠 = 不确定性缺口越大）；pragmatic 已在 [0,1]，故 pragmaticScale=1。
src/cognition/NoeGoalSystem.js:593:    const cs = curiosityDecompose.score({ epistemicValue: surpriseBit, pragmaticValue: prag.value, pragmaticScale: 1 });
src/cognition/NoeGoalSystem.js:605:    return add({ title, source: 'surprise', why, steps, meta });
src/cognition/NoeGoalSystem.js:613:      // P1-C 整改 F3：surprise 来源分桶接进 stats——透视页/mind route 是 stats 的生产消费方(noeMind.js:365/383/619)，
src/cognition/NoeGoalSystem.js:614:      // 由此门 b 的「owner+action 非噪声 surprise」计数进入真实运行时输出（不再只活在单测）。
src/cognition/NoeGoalSystem.js:615:      return { ...byStatus, surpriseOrigins: surpriseOriginBreakdown() };
src/cognition/NoeGoalSystem.js:619:  return { add, get, list, setStatus, arbitrate, nextStep, recordStepResult, recordStepCheckpoint, checkpoints, latestCheckpoint, harvestSurprise, surpriseOriginBreakdown, maybeSeedAutonomousLearning, stats };
src/cognition/NoeGoalStepRecorder.js:47: * @returns {{ok: boolean, goalDone: boolean, goal?: object}}
src/cognition/NoeGoalStepRecorder.js:61:    if (!g) return { ok: false, goalDone: false };
src/cognition/NoeGoalStepRecorder.js:76:    } else return { ok: false, goalDone: false };
src/cognition/NoeGoalStepRecorder.js:93:    return { ok: true, goalDone: allDone, goal: allDone ? { ...g, plan, status: 'done' } : undefined };
src/cognition/NoeGoalStepRecorder.js:95:    return { ok: false, goalDone: false };
src/cognition/NoeExpectationLedger.js:5:// 问题：Noe 对世界从不"下注"——没有预测就没有落空，没有落空就没有惊奇（surprise），自我认知
src/cognition/NoeExpectationLedger.js:7:// 设计：noe_expectations 表（迁移 v7）记 {claim, p, due_at}；到期结算 outcome → surprise =
src/cognition/NoeExpectationLedger.js:14:import { textSimilarity } from '../memory/NoeMemoryDedup.js';
src/cognition/NoeExpectationLedger.js:130:   * surprise = -log2(p_实际结果)：高自信落空 → 大惊奇（注意力/反思素材的信号源）。
src/cognition/NoeExpectationLedger.js:136:      let surprise = null;
src/cognition/NoeExpectationLedger.js:141:        surprise = -Math.log2(clamp(pActual, 0.001, 1));
src/cognition/NoeExpectationLedger.js:148:        getdb().prepare('UPDATE noe_expectations SET resolved_at = ?, outcome = ?, surprise = ?, resolved_by = ? WHERE id = ?').run(t, oc, surprise, by, id);
src/cognition/NoeExpectationLedger.js:150:        getdb().prepare('UPDATE noe_expectations SET resolved_at = ?, outcome = ?, surprise = ? WHERE id = ?').run(t, oc, surprise, id);
src/cognition/NoeExpectationLedger.js:152:      return { ...row, resolved_at: t, outcome: oc, surprise, resolved_by: hasResolvedBy ? by : null };
src/cognition/NoeExpectationLedger.js:159:      return getdb().prepare('UPDATE noe_expectations SET resolved_at = ?, outcome = NULL, surprise = NULL WHERE resolved_at IS NULL AND due_at IS NOT NULL AND due_at < ?')
src/cognition/NoeIncidentEscalator.js:48:    pattern: 'NoeGoal|goal_step|recordStepResult|nextStep|act_started|act_done|research_started|research_done|awaiting_approval|blocked|failed',
src/cognition/NoeIncidentEscalator.js:69:    domain: 'memory',
src/cognition/NoeIncidentEscalator.js:73:    paths: ['src/memory', 'src/knowledge', 'src/cognition', 'src/server/routes/knowledge.js', 'tests/unit'],
src/cognition/NoeIncidentEscalator.js:74:    verify: ['test', '--', 'tests/unit/noe-memory-focus.test.js', 'tests/unit/noe-fact-extractor.test.js'],
src/memory/NoeMemoryWriteGate.js:17:function candidateLinks(candidate, memoryId) {
src/memory/NoeMemoryWriteGate.js:22:  return links.filter((link) => link.ref && memoryId);
src/memory/NoeMemoryWriteGate.js:27:    memory = null,
src/memory/NoeMemoryWriteGate.js:34:    this.memory = memory;
src/memory/NoeMemoryWriteGate.js:35:    this.auditLog = auditLog || new NoeMemoryAuditLog({ db: () => memory?.db?.(), now });
src/memory/NoeMemoryWriteGate.js:52:    if (candidateNeedsReview(candidate)) return decision(false, 'needs_review', 'review_required_for_high_risk_memory');
src/memory/NoeMemoryWriteGate.js:60:      try { this.auditLog?.recordCandidate?.(candidate, verdict); } catch (e) { this.logger?.warn?.('[noe-memory-gate] 记录候选失败:', e?.message || e); }
src/memory/NoeMemoryWriteGate.js:61:      return { ...verdict, candidate, memory: null };
src/memory/NoeMemoryWriteGate.js:63:    if (!this.memory?.write) {
src/memory/NoeMemoryWriteGate.js:64:      const missing = decision(false, 'rejected', 'memory_not_wired');
src/memory/NoeMemoryWriteGate.js:66:      return { ...missing, candidate, memory: null };
src/memory/NoeMemoryWriteGate.js:68:    let memory = null;
src/memory/NoeMemoryWriteGate.js:70:      memory = this.memory.write(candidateToMemoryInput(candidate));
src/memory/NoeMemoryWriteGate.js:72:      const failed = decision(false, 'rejected', `memory_write_failed:${e?.message || e}`);
src/memory/NoeMemoryWriteGate.js:74:      return { ...failed, candidate, memory: null };
src/memory/NoeMemoryWriteGate.js:76:    const targetMemoryId = memory?.id || null;
src/memory/NoeMemoryWriteGate.js:81:      this.logger?.warn?.('[noe-memory-gate] 记录链接失败:', e?.message || e);
src/memory/NoeMemoryWriteGate.js:83:    return { ...verdict, candidate, memory };
src/memory/NoeMemorySemanticIndex.js:3:// 包装 embeddings/VectorIndex(kind='noe_memory')：写记忆时嵌入入库，召回时语义检索。
src/memory/NoeMemorySemanticIndex.js:10:const KIND = 'noe_memory';
src/memory/NoeMemoryRetriever.js:53:    memory = null,
src/memory/NoeMemoryRetriever.js:59:    this.memory = memory;
src/memory/NoeMemoryRetriever.js:60:    this.auditLog = auditLog || new NoeMemoryAuditLog({ db: () => memory?.db?.(), now });
src/memory/NoeMemoryRetriever.js:67:    if (!this.memory?.recall) return { items: [], droppedReason: 'empty_or_unwired', circuit: null };
src/memory/NoeMemoryRetriever.js:75:      const raw = literalOnly || !this.memory.recallFused ? this.memory.recall(args) : await this.memory.recallFused(args);
src/memory/NoeMemoryRetriever.js:98:    memoryPolicy = null,
src/memory/NoeMemoryRetriever.js:103:    if (!query || !this.memory?.recall) return { ok: true, query, selected: [], channels: {}, droppedReasons: ['empty_or_unwired'] };
src/memory/NoeMemoryRetriever.js:105:    const policyLimit = Number(memoryPolicy?.recallLimit) || null;
src/memory/NoeMemoryRetriever.js:106:    const totalLimit = Math.max(1, Math.min(20, Number(limit) || Number(memoryPolicy?.injectLimit) || profile.total));
src/memory/NoeMemoryRetriever.js:181:      this.logger?.warn?.('[noe-memory-retriever] 召回失败:', sanitizeActiveMemoryRecallError(e));
src/runtime/NoeSocialWebhookInbound.js:3:// NoeInboundGateway. It deliberately records only a small redacted memory and
src/runtime/NoeSocialWebhookInbound.js:255:  memory = null,
src/runtime/NoeSocialWebhookInbound.js:273:      if (memory?.write) {
src/runtime/NoeSocialWebhookInbound.js:274:        try { memory.write(buildSocialInboundMemory(message, { projectId })); } catch { /* memory write must not break provider ack */ }
src/memory/NoeMemoryDynamics.js:5:// 借鉴 OpenMemory（CaviraOSS/OpenMemory, Apache-2.0）的 packages/openmemory-js/src/ops/dynamics.ts
src/memory/NoeMemoryDynamics.js:6:// 与 memory/decay.ts 的两个核心理念，用纯 JS（无依赖）重写：
src/memory/NoeMemoryDynamics.js:12://      对应 OpenMemory memory/decay.ts 按 tier 分档 λ。
src/memory/NoeMemoryDynamics.js:34://   - 分档：hot=0.005 / warm=0.02 / cold=0.05（OpenMemory memory/decay.ts 三档 λ）。
src/memory/NoeMemoryDynamics.js:44:/** 三档（hot/warm/cold）→ 快相 λ₁（每天）。借鉴 OpenMemory memory/decay.ts 分档 λ。 */
src/memory/NoeMemoryDynamics.js:103: * 按年龄分档：'hot' | 'warm' | 'cold'。借鉴 OpenMemory memory/decay.ts 的 hot/warm/cold。
src/memory/NoeMemoryDynamics.js:129: * 借鉴 OpenMemory：双相衰减（dynamics.ts）+ 分档 λ（memory/decay.ts）合体。
src/actions/NoeActionCatalog.js:220:        summary: 'Would inspect Apple Silicon memory budget and estimate suitable local model quantization.',
src/memory/NoeMemoryProviderManager.js:7:  'noe.memory.write',
src/memory/NoeMemoryProviderManager.js:8:  'noe.memory.recall',
src/memory/NoeMemoryProviderManager.js:9:  'noe.memory.search',
src/memory/NoeMemoryProviderManager.js:10:  'memory.write',
src/memory/NoeMemoryProviderManager.js:11:  'memory.recall',
src/memory/NoeMemoryProviderManager.js:12:  'memory.search',
src/memory/NoeMemoryProviderManager.js:58:    if (!id) throw new Error('memory_provider_id_required');
src/memory/NoeMemoryProviderManager.js:62:      throw new Error(`memory_provider_tool_shadow_rejected:${shadowedTool}`);
src/memory/NoeMemoryProviderManager.js:72:      if (externalCount >= this.maxExternalProviders) throw new Error('memory_provider_single_external_limit');
src/memory/NoeMemoryProviderManager.js:94:    if (!this.externalEnabled) return { ok: true, skipped: true, reason: 'external_memory_disabled', memories: [] };
src/memory/NoeMemoryProviderManager.js:96:    if (!provider?.recall) return { ok: true, skipped: true, reason: 'external_memory_provider_unavailable', memories: [] };
src/memory/NoeMemoryProviderManager.js:118:        id: `memory-sync-${randomUUID()}`,
src/memory/NoeMemoryProviderManager.js:127:      memory: written,
src/memory/NoeMemoryProviderManager.js:134:    const id = clean(item.id, 160) || `memory-sync-${randomUUID()}`;
src/memory/NoeMemoryProviderManager.js:141:      return { ok: true, skipped: true, reason: 'external_memory_disabled', processed: 0, remaining: this.syncQueue.length };
src/memory/NoeMemoryProviderManager.js:145:      return { ok: true, skipped: true, reason: 'external_memory_provider_unavailable', processed: 0, remaining: this.syncQueue.length };
src/memory/NoeMemoryProviderManager.js:156:        this.logger?.warn?.('[noe-memory-provider] sync failed:', e?.message || e);
src/memory/NoeMemoryConflictPolicy.js:26:  if (/memory|manual|fact/.test(s)) return 2;
src/memory/NoeMemoryCandidateApply.js:8:export const NOE_MEMORY_CANDIDATE_APPLY_REPORT_DIR = 'output/noe-memory-candidates/apply-reports';
src/memory/NoeMemoryCandidateApply.js:25:  return `memory-candidate-apply-${Date.now()}-${randomUUID().slice(0, 8)}.json`;
src/memory/NoeMemoryCandidateApply.js:49:  if (!candidate?.body) blockers.push('memory_body_required');
src/memory/NoeMemoryCandidateApply.js:50:  if (candidate?.writesMemoryCore === true) blockers.push('candidate_already_claims_memory_write');
src/memory/NoeMemoryCandidateApply.js:52:  const applyId = `memory-apply-${hash({
src/memory/NoeMemoryCandidateApply.js:66:      memoryWrite: {
src/memory/NoeMemoryCandidateApply.js:70:        sourceType: 'proposal_memory_candidate',
src/memory/NoeMemoryCandidateApply.js:80:        'If applied, hide or supersede the created MemoryCore id using the apply report memoryId.',
src/memory/NoeMemoryCandidateApply.js:93:  memoryCore = null,
src/memory/NoeMemoryCandidateApply.js:110:  } else if (!dryRun && !memoryCore?.write) {
src/memory/NoeMemoryCandidateApply.js:111:    applyErrors.push({ error: 'memory_core_required' });
src/memory/NoeMemoryCandidateApply.js:115:        const memory = memoryCore.write(item.plan.memoryWrite);
src/memory/NoeMemoryCandidateApply.js:119:          memoryId: clean(memory?.id, 200),
src/memory/NoeMemoryCandidateApply.js:121:            action: 'hide_memory',
src/memory/NoeMemoryCandidateApply.js:122:            memoryId: clean(memory?.id, 200),
src/memory/NoeMemoryCandidateApply.js:139:    reason: !records.length ? 'no_pending_memory_candidates' : '',
src/cognition/NoeAwakeningSignals.js:8://   D1 预测-学习活性：surprise 目标数 + 研究完成率（学了改没改的漏斗末端代理）
src/cognition/NoeAwakeningSignals.js:66:    ? c('SELECT COUNT(*) n FROM noe_expectations WHERE created_at >= ? AND outcome=0 AND surprise IS NOT NULL AND surprise >= ?', sinceTs, SURPRISE_BIT_GATE) : 0;
src/cognition/NoeAwakeningSignals.js:67:  const surpriseGoals = hasGoals ? c("SELECT COUNT(*) n FROM noe_goals WHERE source='surprise' AND created_at >= ?", sinceTs) : 0;
src/cognition/NoeAwakeningSignals.js:68:  const surpriseGoalsDone = hasGoals ? c("SELECT COUNT(*) n FROM noe_goals WHERE source='surprise' AND status='done' AND created_at >= ?", sinceTs) : 0;
src/cognition/NoeAwakeningSignals.js:71:    surpriseGoals,
src/cognition/NoeAwakeningSignals.js:72:    surpriseGoalsDone,
src/cognition/NoeAwakeningSignals.js:73:    researchCompletionRate: surpriseGoals > 0 ? round(surpriseGoalsDone / surpriseGoals) : null,
src/memory/NoeMemoryCandidateRollback.js:7:export const NOE_MEMORY_CANDIDATE_ROLLBACK_REPORT_DIR = 'output/noe-memory-candidates/rollback-reports';
src/memory/NoeMemoryCandidateRollback.js:34:  return `memory-candidate-rollback-${Date.now()}-${randomUUID().slice(0, 8)}.json`;
src/memory/NoeMemoryCandidateRollback.js:50:  if (!applied.length) blockers.push('no_applied_memory_records');
src/memory/NoeMemoryCandidateRollback.js:55:    if (!item.memoryId) itemBlockers.push('memory_id_required');
src/memory/NoeMemoryCandidateRollback.js:56:    if (item.rollback?.action !== 'hide_memory') itemBlockers.push('unsupported_rollback_action');
src/memory/NoeMemoryCandidateRollback.js:58:    if (plan && plan.memoryWrite?.sourceType !== 'proposal_memory_candidate') itemBlockers.push('not_proposal_memory_candidate');
src/memory/NoeMemoryCandidateRollback.js:61:    if (plan && !plan.memoryWrite?.projectId) itemBlockers.push('missing_project_id');
src/memory/NoeMemoryCandidateRollback.js:65:      memoryId: clean(item.memoryId, 200),
src/memory/NoeMemoryCandidateRollback.js:66:      projectId: clean(plan?.memoryWrite?.projectId || 'noe', 120) || 'noe',
src/memory/NoeMemoryCandidateRollback.js:68:      action: 'hide_memory',
src/memory/NoeMemoryCandidateRollback.js:91:  memoryCore = null,
src/memory/NoeMemoryCandidateRollback.js:117:  } else if (!dryRun && !memoryCore?.hide) {
src/memory/NoeMemoryCandidateRollback.js:118:    rollbackErrors.push({ error: 'memory_core_required' });
src/memory/NoeMemoryCandidateRollback.js:123:      const before = memoryCore.get?.(item.memoryId, { includeHidden: true }) || null;
src/memory/NoeMemoryCandidateRollback.js:125:      const hidden = alreadyHidden ? true : memoryCore.hide(item.memoryId, {
src/memory/NoeMemoryCandidateRollback.js:129:      const after = memoryCore.get?.(item.memoryId, { includeHidden: true }) || null;
src/memory/NoeMemoryCandidateRollback.js:133:        memoryId: item.memoryId,
src/memory/NoeMemoryCandidateRollback.js:147:        memoryId: item.memoryId,
src/model/NoeLocalModelPolicy.js:33:  memory_write_candidate: Object.freeze({ min: 2048, max: 4096, default: 4096, response_format: 'json_schema_when_possible' }),
src/model/NoeLocalModelPolicy.js:51:  memory_conflict_review: Object.freeze({ min: 8192, max: 12288, default: 8192, response_format: 'json_schema_when_possible' }),
src/model/NoeLocalModelPolicy.js:112:  'memory_conflict',
src/model/NoeLocalModelPolicy.js:251:  return /(delete|trash|remove|publish|final_publish|external|upload|rollback|memory|identity|preference|self[-_ ]?evolution|config|secret|token|cookie|oauth|\.env|删除|发布|外部|上传|回滚|长期记忆|身份|偏好|自我进化|配置|密钥)/i.test(text);
src/runtime/NoeDoctor.js:248:    'src/memory/NoeActiveMemory.js',
src/memory/NoeFisherRaoSimilarity.js:4:// 借鉴 SuperLocalMemory(qualixar/superlocalmemory) math/fisher.py 的 Y：
src/memory/NoeMemoryProvenanceBackfill.js:55:    FROM noe_memory m
src/memory/NoeMemoryProvenanceBackfill.js:62:        SELECT 1 FROM noe_memory_link l
src/memory/NoeMemoryProvenanceBackfill.js:63:        WHERE l.memory_id=m.id AND l.link_type IN (${strongTypesSql()}) LIMIT 1
src/memory/NoeMemoryProvenanceBackfill.js:92:  memoryLimit = 200,
src/memory/NoeMemoryProvenanceBackfill.js:101:    limit: Math.max(1, Math.min(5000, Number(memoryLimit) || 200)),
src/memory/NoeMemoryProvenanceBackfill.js:108:  for (const memory of memories) {
src/memory/NoeMemoryProvenanceBackfill.js:109:    const tokens = tokenize(memory.body);
src/memory/NoeMemoryProvenanceBackfill.js:110:    const createdAt = Number(memory.created_at) || 0;
src/memory/NoeMemoryProvenanceBackfill.js:128:        memoryId: memory.id,
src/memory/NoeMemoryProvenanceBackfill.js:164:    INSERT OR IGNORE INTO noe_memory_link(memory_id, link_type, link_ref, quote_hash, created_at)
src/memory/NoeMemoryProvenanceBackfill.js:168:    UPDATE noe_memory SET source_episode_id = ?, updated_at = ?
src/memory/NoeMemoryProvenanceBackfill.js:176:      inserted += insert.run(match.memoryId, match.sourceEpisodeId, t).changes || 0;
src/memory/NoeMemoryProvenanceBackfill.js:177:      updated += update.run(match.sourceEpisodeId, t, match.memoryId).changes || 0;
src/memory/NoeMemoryRecallBenchmark.js:17:    tags: ['memory', 'roadmap'],
src/memory/NoeMemoryRecallBenchmark.js:72:      actor: 'noe_memory_recall_benchmark',
src/memory/NoeMemoryRecallBenchmark.js:101:      memoryPolicy: { recallLimit: k, injectLimit: k },
src/memory/NoeMemoryGovernanceRepair.js:15:  'merged_from_memory',
src/memory/NoeMemoryGovernanceRepair.js:39:  return `${link.memoryId}\u0000${link.type}\u0000${link.ref}`;
src/memory/NoeMemoryGovernanceRepair.js:51:  const memoryId = clean(row.id, 180);
src/memory/NoeMemoryGovernanceRepair.js:52:  if (!memoryId) return [];
src/memory/NoeMemoryGovernanceRepair.js:57:  if (sourceEpisodeId) links.push({ memoryId, type: 'source_episode', ref: sourceEpisodeId, strength: 'strong' });
src/memory/NoeMemoryGovernanceRepair.js:58:  if (sourceId) links.push({ memoryId, type: 'source_id', ref: sourceId, strength: 'strong' });
src/memory/NoeMemoryGovernanceRepair.js:59:  if (sourceType) links.push({ memoryId, type: 'legacy_source_type', ref: sourceType, strength: 'weak' });
src/memory/NoeMemoryGovernanceRepair.js:62:    links.push({ memoryId, type: 'legacy_source_type', ref: `${sourceType}:${createdDay}`, strength: 'weak' });
src/memory/NoeMemoryGovernanceRepair.js:68:      if (ref && ref !== memoryId) links.push({ memoryId, type: 'merged_from_memory', ref, strength: 'weak' });
src/memory/NoeMemoryGovernanceRepair.js:94:    FROM noe_memory
src/memory/NoeMemoryGovernanceRepair.js:99:  const existing = new Set(db.prepare('SELECT memory_id, link_type, link_ref FROM noe_memory_link').all()
src/memory/NoeMemoryGovernanceRepair.js:100:    .map((row) => `${row.memory_id}\u0000${row.link_type}\u0000${row.link_ref}`));
src/memory/NoeMemoryGovernanceRepair.js:131:    INSERT OR IGNORE INTO noe_memory_link(memory_id, link_type, link_ref, quote_hash, created_at)
src/memory/NoeMemoryGovernanceRepair.js:138:      inserted += stmt.run(link.memoryId, link.type, link.ref, t).changes || 0;
src/memory/NoeMemorySemanticBackfill.js:18:  if (!tableExists(db, 'noe_memory')) return [];
src/memory/NoeMemorySemanticBackfill.js:21:    FROM noe_memory
src/memory/NoeMemorySemanticBackfill.js:32:    WHERE kind='noe_memory' AND (model='hash-128' OR dim=128)
src/cognition/NoeWorkspace.js:401:  function emitGoalReportback(winner, status, { note = '', kind = null, goalDone = false, speak = null } = {}) {
src/cognition/NoeWorkspace.js:405:      const wantsSpeech = speak === null ? Boolean(goalDone || ['done', 'failed', 'blocked', 'awaiting_approval'].includes(status)) : speak;
src/cognition/NoeWorkspace.js:433:      if (!terminal || !hasEvidence || typeof goalSystem?.recordStepResult !== 'function') return false;
src/cognition/NoeWorkspace.js:442:      const res = goalSystem.recordStepResult(winner.goalRef.goalId, stepIndex, { note, done: true });
src/cognition/NoeWorkspace.js:444:      emitGoalReportback(winner, 'done', { note, kind: 'think', goalDone: res?.goalDone === true, speak: true });
src/cognition/NoeWorkspace.js:445:      if (res?.goalDone && typeof onGoalDone === 'function') { try { onGoalDone(res.goal); } catch { /* 蒸馏失败不阻断 */ } }
src/cognition/NoeWorkspace.js:486:    if (winner && winner.source === 'goal_step' && winner.goalRef && winner.kind === 'research' && typeof runResearch === 'function' && goalSystem?.recordStepResult) {
src/cognition/NoeWorkspace.js:489:      try { goalSystem.recordStepResult(winner.goalRef.goalId, winner.goalRef.stepIndex, { doing: true, note: '研究执行中…' }); } catch { /* 标记失败不阻断 */ }
src/cognition/NoeWorkspace.js:496:          const res = goalSystem.recordStepResult(winner.goalRef.goalId, winner.goalRef.stepIndex, { done: true, note: summary || '研究完成（未产出报告）' });
src/cognition/NoeWorkspace.js:498:          emitGoalReportback(winner, res?.goalDone ? 'done' : 'running', { note: summary || '研究完成（未产出报告），继续下一步。', kind: 'research', goalDone: res?.goalDone === true, speak: res?.goalDone === true });
src/cognition/NoeWorkspace.js:501:          if (res?.goalDone && typeof onGoalDone === 'function') { try { onGoalDone(res.goal); } catch { /* 蒸馏失败不阻断 */ } }
src/cognition/NoeWorkspace.js:507:            goalSystem.recordStepResult(winner.goalRef.goalId, winner.goalRef.stepIndex, { status: 'failed', note });
src/cognition/NoeWorkspace.js:521:    if (winner && winner.source === 'goal_step' && winner.goalRef && winner.kind === 'act' && typeof runAct === 'function' && goalSystem?.recordStepResult) {
src/cognition/NoeWorkspace.js:524:      try { goalSystem.recordStepResult(winner.goalRef.goalId, winner.goalRef.stepIndex, { doing: true, note: '行动执行中…' }); } catch { /* 标记失败不阻断 */ }
src/cognition/NoeWorkspace.js:539:          const res = goalSystem.recordStepResult(winner.goalRef.goalId, winner.goalRef.stepIndex, approval ? { status: 'awaiting_approval', note } : acted ? { done: true, note } : { status: 'blocked', note });
src/cognition/NoeWorkspace.js:541:          emitGoalReportback(winner, approval ? 'awaiting_approval' : acted ? (res?.goalDone ? 'done' : 'running') : 'blocked', { note, kind: 'act', goalDone: res?.goalDone === true, speak: approval || !acted || res?.goalDone === true });
src/cognition/NoeWorkspace.js:544:            // 阶段1：act 真失败 → 接通好奇回路供给端（登记预测→outcome=0→surprise→harvestSurprise(action_failure)）
src/cognition/NoeWorkspace.js:549:          if (res?.goalDone && typeof onGoalDone === 'function') { try { onGoalDone(res.goal); } catch { /* 蒸馏失败不阻断 */ } }
src/cognition/NoeWorkspace.js:556:            goalSystem.recordStepResult(winner.goalRef.goalId, winner.goalRef.stepIndex, { status: 'failed', note });
src/cognition/NoeWorkspace.js:586:          if (winner.goalRef && d?.deliberated && goalSystem?.recordStepResult) {
src/cognition/NoeWorkspace.js:594:            const res = goalSystem.recordStepResult(winner.goalRef.goalId, winner.goalRef.stepIndex, {
src/cognition/NoeWorkspace.js:600:            if (stepDone || newSteps) emitGoalReportback(winner, res?.goalDone ? 'done' : 'running', { note: stepDone ? '思考步骤已完成，继续推进后续步骤。' : '已经拆出执行计划，继续推进。', kind: 'think', goalDone: res?.goalDone === true, speak: res?.goalDone === true });
src/cognition/NoeWorkspace.js:601:            if (res?.goalDone && typeof onGoalDone === 'function') { try { onGoalDone(res.goal); } catch { /* 蒸馏失败不阻断 */ } }
src/memory/NoeMemoryCopyValidation.js:55:      body: JSON.stringify({ model, prompt: 'Noe memory semantic readiness probe' }),
src/memory/NoeMemoryCopyValidation.js:70:    WHERE kind='noe_memory' AND (model='hash-128' OR dim=128)
src/memory/NoeMemoryCopyValidation.js:76:  if (!tableExists(db, 'noe_memory')) return [];
src/memory/NoeMemoryCopyValidation.js:79:    FROM noe_memory
src/memory/NoeMemoryCopyValidation.js:91:    WHERE kind='noe_memory'
src/memory/NoeMemoryCopyValidation.js:128:async function sampleRetrieval({ memory, projectId, queries, label }) {
src/memory/NoeMemoryCopyValidation.js:130:    memory,
src/memory/NoeMemoryCopyValidation.js:156:function applyMaintenanceOnCopy({ memory, db, projectId }) {
src/memory/NoeMemoryCopyValidation.js:158:  const gc = memory.runGc({ apply: true, projectId, reason: 'copy_validation_gc_apply' });
src/memory/NoeMemoryCopyValidation.js:162:      FROM noe_memory
src/memory/NoeMemoryCopyValidation.js:204:  const tempDir = mkdtempSync(join(tmpdir(), 'noe-memory-copy-validation-'));
src/memory/NoeMemoryCopyValidation.js:224:    const ftsSample = await sampleRetrieval({ memory: ftsMemory, projectId, queries, label: 'fts' });
src/memory/NoeMemoryCopyValidation.js:225:    const fusedSample = await sampleRetrieval({ memory: fusedMemory, projectId, queries, label: 'fused' });
src/memory/NoeMemoryCopyValidation.js:226:    const maintenanceDryRun = await runNoeMemoryMaintenanceDryRun({ memory: fusedMemory, db, projectId, now });
src/memory/NoeMemoryCopyValidation.js:227:    const maintenanceApply = applyMaintenanceOnCopy({ memory: fusedMemory, db, projectId });
src/memory/NoeMemoryDedup.js:120:  // 性能（热路径：每次 memory.write() 对最多 scanLimit≈25 条候选跑此循环）：把"incoming 归一化 +
src/memory/NoeEpisodeSublimation.js:12://   - 注入式全可 fake：timeline / memoryCore / llmSublimate / phaseOf / now / 水位线文件路径。
src/memory/NoeEpisodeSublimation.js:100: * @param {{write:Function}|null} [opts.memoryCore] MemoryCore（只用 write，绝不 merge/downgrade/setSalience）
src/memory/NoeEpisodeSublimation.js:116:  timeline = null, memoryCore = null, llmSublimate = null,
src/memory/NoeEpisodeSublimation.js:143:      if (typeof timeline?.aged !== 'function' || typeof memoryCore?.write !== 'function') return { skipped: 'deps_missing' };
src/memory/NoeEpisodeSublimation.js:176:          memoryCore.write({
src/memory/NoeMemoryAutonomousReview.js:54:    FROM noe_memory m
src/memory/NoeMemoryAutonomousReview.js:61:      AND NOT EXISTS(SELECT 1 FROM noe_memory_link l WHERE l.memory_id=m.id AND l.link_type IN (${strong}) LIMIT 1)
src/memory/NoeMemoryAutonomousReview.js:75:    sourceType: 'legacy_memory_autonomous_review',
src/memory/NoeMemoryAutonomousReview.js:77:    evidenceRefs: [`legacy_memory:${row.id}`],
src/memory/NoeMemoryAutonomousReview.js:83:    tags: ['legacy-memory', 'autonomous-review'],
src/memory/NoeMemoryAutonomousReview.js:117:      memoryId: row.id,
src/memory/NoeMemoryAutonomousReview.js:132:      UPDATE noe_memory SET hidden=1, hidden_reason=?, updated_at=?
src/memory/NoeMemoryAutonomousReview.js:135:    const deleteEmbeddingStmt = db.prepare("DELETE FROM embeddings WHERE kind='noe_memory' AND ref_id=?");
src/memory/NoeMemoryAutonomousReview.js:142:          targetMemoryId: review.memoryId,
src/memory/NoeMemoryAutonomousReview.js:145:        linksRecorded += logger.linkMemory(review.memoryId, [
src/memory/NoeMemoryAutonomousReview.js:150:          hidden += hideStmt.run(`autonomous_review:${review.reason}`, t, review.memoryId, review.projectId).changes || 0;
src/memory/NoeMemoryAutonomousReview.js:151:          deleteEmbeddingStmt.run(review.memoryId);
src/memory/NoeMemoryAutonomousReview.js:184:    'type: noe_memory_autonomous_review',
src/memory/NoeMemoryAutonomousReview.js:208:    lines.push(`| ${mdCell(item.memoryId)} | ${mdCell(item.decision)} | ${mdCell(item.trust)} | ${Number(item.confidence).toFixed(2)} | ${Number(item.salience).toFixed(0)} | ${mdCell(item.sourceType)} | ${mdCell(item.bodySnippet)} |`);
src/memory/NoeMemoryAutonomousReview.js:223:  const file = join(safeDir, filename || `${stamp}-noe-memory-autonomous-review.md`);
src/memory/NoeMemoryExtractor.js:45:    const budget = resolveNoeOutputBudget('memory_write_candidate');
src/memory/NoeMemoryExtractor.js:49:        budgetContext: { projectId, taskId: 'noe-memory-extract' },
src/memory/NoeMemoryExtractor.js:83:        body: `no_write:${String(item.reason || 'not_worth_long_term_memory').slice(0, 200)}`,
src/memory/NoeMemoryExtractor.js:90:        noWriteReason: item.reason || 'not_worth_long_term_memory',
src/memory/NoeMemoryMaintenanceDryRun.js:15:  memory,
src/memory/NoeMemoryMaintenanceDryRun.js:22:  if (!memory?.runGc) throw new Error('memory required');
src/memory/NoeMemoryMaintenanceDryRun.js:24:  const candidates = loadConsolidationCandidates(memory, { projectId, limit: candidateLimit });
src/memory/NoeMemoryMaintenanceDryRun.js:29:  const gc = memory.runGc({ apply: false, projectId, maxScan: gcMaxScan });
src/cognition/NoeOwnerBehaviorPredictor.js:11://      若 owner 明确取消/否定交办后的 followup → resolve(id,0) 并可触发 surprise 学习。
src/cognition/NoeOwnerBehaviorPredictor.js:104: *   followupP?: number,         // followup 预测主观概率（强先验；默认 0.75，落空 surprise=2bit）
src/cognition/NoeOwnerBehaviorPredictor.js:108: *   goalSystem?: {harvestSurprise?: Function}|null, // 明确 followup 落空时把 surprise 接入好奇目标
src/cognition/NoeOwnerBehaviorPredictor.js:170:            try { goalSystem.harvestSurprise({ claim: row.claim, surprise: resolvedRow.surprise, origin: 'owner_prediction' }); } // P1-C：owner 明确否定 followup = owner 真实负反馈（门 b 非噪声）
src/memory/NoeMemoryRelevanceBenchmark.js:120:    memoryPolicy: { recallLimit: item.limit, injectLimit: item.limit },
src/memory/NoeMemoryRelevanceBenchmark.js:121:    turnId: `memory-relevance-benchmark:${mode}:${item.id}`,
src/storage/NoeMemoryV2Schema.js:19:    CREATE TABLE IF NOT EXISTS noe_memory_candidate (
src/storage/NoeMemoryV2Schema.js:40:      target_memory_id TEXT,
src/storage/NoeMemoryV2Schema.js:45:    CREATE INDEX IF NOT EXISTS idx_noe_memory_candidate_project_decision
src/storage/NoeMemoryV2Schema.js:46:      ON noe_memory_candidate(project_id, decision, created_at);
src/storage/NoeMemoryV2Schema.js:47:    CREATE INDEX IF NOT EXISTS idx_noe_memory_candidate_source_episode
src/storage/NoeMemoryV2Schema.js:48:      ON noe_memory_candidate(source_episode_id);
src/storage/NoeMemoryV2Schema.js:49:    CREATE INDEX IF NOT EXISTS idx_noe_memory_candidate_target
src/storage/NoeMemoryV2Schema.js:50:      ON noe_memory_candidate(target_memory_id);
src/storage/NoeMemoryV2Schema.js:52:    CREATE TABLE IF NOT EXISTS noe_memory_link (
src/storage/NoeMemoryV2Schema.js:54:      memory_id TEXT NOT NULL,
src/storage/NoeMemoryV2Schema.js:59:      UNIQUE(memory_id, link_type, link_ref)
src/storage/NoeMemoryV2Schema.js:61:    CREATE INDEX IF NOT EXISTS idx_noe_memory_link_memory
src/storage/NoeMemoryV2Schema.js:62:      ON noe_memory_link(memory_id);
src/storage/NoeMemoryV2Schema.js:63:    CREATE INDEX IF NOT EXISTS idx_noe_memory_link_ref
src/storage/NoeMemoryV2Schema.js:64:      ON noe_memory_link(link_type, link_ref);
src/storage/NoeMemoryV2Schema.js:66:    CREATE TABLE IF NOT EXISTS noe_memory_retrieval_log (
src/storage/NoeMemoryV2Schema.js:78:    CREATE INDEX IF NOT EXISTS idx_noe_memory_retrieval_project_ts
src/storage/NoeMemoryV2Schema.js:79:      ON noe_memory_retrieval_log(project_id, ts);
src/storage/NoeMemoryV2Schema.js:81:  ensureColumn(db, 'noe_memory_candidate', 'privacy', "privacy TEXT NOT NULL DEFAULT 'private'");
src/storage/NoeMemoryV2Schema.js:82:  ensureColumn(db, 'noe_memory_link', 'quote_hash', "quote_hash TEXT NOT NULL DEFAULT ''");
src/memory/NoeMemoryCandidateReview.js:7:export const NOE_MEMORY_CANDIDATE_QUEUE = 'output/noe-proposal-executions/queues/memory-candidates.jsonl';
src/memory/NoeMemoryCandidateReview.js:8:export const NOE_MEMORY_CANDIDATE_PENDING = 'output/noe-memory-candidates/pending.jsonl';
src/memory/NoeMemoryCandidateReview.js:9:export const NOE_MEMORY_CANDIDATE_REPORT_DIR = 'output/noe-memory-candidates/reports';
src/memory/NoeMemoryCandidateReview.js:26:  return `memory-candidate-review-${Date.now()}-${randomUUID().slice(0, 8)}.json`;
src/memory/NoeMemoryCandidateReview.js:71:  if (record.proposal?.proposalType !== 'memory_candidate') blockers.push('not_memory_candidate');
src/memory/NoeMemoryCandidateReview.js:72:  if (!body) blockers.push('empty_memory_body');
src/memory/NoeMemoryCandidateReview.js:74:  const candidateId = `memory-candidate-${hash({
src/memory/NoeMemoryCandidateReview.js:143:    reason: !records.length ? 'no_materialized_memory_queue' : '',
src/memory/NoeExternalMemoryProviders.js:27:function memoryTextFromSyncItem(item = {}) {
src/memory/NoeExternalMemoryProviders.js:43:  dbDir = 'output/noe-memory-providers/lancedb',
src/memory/NoeExternalMemoryProviders.js:52:    id: 'lancedb_memory',
src/memory/NoeExternalMemoryProviders.js:55:    tools: ['lancedb.memory.upsert', 'lancedb.memory.recall'],
src/memory/NoeExternalMemoryProviders.js:58:      const text = memoryTextFromSyncItem(item);
src/memory/NoeExternalMemoryProviders.js:59:      if (!text) return { ok: true, skipped: true, reason: 'empty_memory_text' };
src/memory/NoeExternalMemoryProviders.js:62:        id: clean(item.localId || input.id || item.id || `memory-${Date.now()}`, 160),
src/memory/NoeExternalMemoryProviders.js:63:        scope: clean(input.scope || input.sourceType || 'memory', 120),
src/memory/NoeExternalMemoryProviders.js:71:      return { ok: true, providerId: 'lancedb_memory', id: row.id, dbDir: absDir, tableName };
src/memory/NoeExternalMemoryProviders.js:100:    id: 'llm_wiki_memory',
src/memory/NoeExternalMemoryProviders.js:103:    tools: ['llm-wiki.memory.recall'],
src/memory/NoeExternalMemoryProviders.js:122:  lancedbDir = 'output/noe-memory-providers/lancedb',
src/memory/NoeExternalMemoryProviders.js:128:  if (lancedbEnabled && wikiEnabled) throw new Error('external_memory_single_provider_feature_flag');
src/memory/NoeExternalMemoryProviders.js:150:    reason: 'external_memory_feature_flag_disabled',
src/memory/NoeMemoryConsolidator.js:9:// Adapted from BaiLongma (MIT) src/memory/consolidator.js 的整合策略,去掉 LLM/DB 改为纯规划。
src/prefetch/NoePrefetchStore.js:12:// Adapted from BaiLongma (MIT) src/prefetch/runner.js + src/memory/injector.js
src/room/NoeSelfEvolutionGate.js:11:const ACTIONS = new Set(['implementation', 'self_repair', 'memory_writeback', 'complete']);
src/room/NoeSelfEvolutionGate.js:200:  if (action === 'memory_writeback' || action === 'complete') {
src/room/NoeSelfEvolutionGate.js:231:  const memory = input.memoryWriteback || {};
src/room/NoeSelfEvolutionGate.js:232:  let memoryAck = false;
src/room/NoeSelfEvolutionGate.js:233:  if (action === 'memory_writeback' || action === 'complete') {
src/room/NoeSelfEvolutionGate.js:234:    const memoryConsensusAck = memory.consensusAck === true && isNoeConsensusAuthorizationPassed(consensus);
src/room/NoeSelfEvolutionGate.js:235:    memoryAck = memory.userAck === true || memoryConsensusAck;
src/room/NoeSelfEvolutionGate.js:236:    addMissing(errors, memoryAck, 'memory_writeback_ack_required');
src/room/NoeSelfEvolutionGate.js:237:    addMissing(errors, hasText(memory.summaryRef), 'memory_writeback_summary_ref_required');
src/room/NoeSelfEvolutionGate.js:238:    if (memory.autoWrite === true && !memoryConsensusAck) errors.push('memory_writeback_auto_requires_consensus');
src/room/NoeSelfEvolutionGate.js:239:  } else if (memory.autoWrite === true) {
src/room/NoeSelfEvolutionGate.js:240:    errors.push('memory_writeback_auto_requires_consensus');
src/room/NoeSelfEvolutionGate.js:268:      memoryWritebackAck: memoryAck,
src/memory/MemoryCore.js:186:      const row = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'noe_memory_fts'").get();
src/memory/MemoryCore.js:188:        db.prepare("SELECT rowid FROM noe_memory_fts WHERE noe_memory_fts MATCH ? LIMIT 1").all('"__probe__"');
src/memory/MemoryCore.js:201:    if (!body) throw new Error('memory body required');
src/memory/MemoryCore.js:241:        this.logger?.warn?.('[noe-memory] 冲突策略失败，按普通写入处理:', e?.message || e);
src/memory/MemoryCore.js:260:      } catch (e) { this.logger?.warn?.('[noe-memory] 去重判定失败，按新增处理:', e?.message || e); }
src/memory/MemoryCore.js:274:      INSERT INTO noe_memory(
src/memory/MemoryCore.js:301:        UPDATE noe_memory SET hidden = 1, hidden_reason = ?, valid_to = ?, updated_at = ?
src/memory/MemoryCore.js:312:        .catch((e) => this.logger?.warn?.('[noe-memory] 语义索引写入失败:', e?.message || e));
src/memory/MemoryCore.js:318:        .catch((e) => this.logger?.warn?.('[noe-memory] 语义冲突 sweep 失败:', e?.message || e));
src/memory/MemoryCore.js:350:      this.logger?.info?.('[noe-memory] 语义冲突合并:', merged.join(','), '→', id);
src/memory/MemoryCore.js:358:      SELECT id, body, scope, salience, source_type, confidence, valid_from, valid_to, source_episode_id FROM noe_memory
src/memory/MemoryCore.js:377:    const memoryId = safeString(id, 160);
src/memory/MemoryCore.js:378:    if (!memoryId) return null;
src/memory/MemoryCore.js:380:      SELECT * FROM noe_memory
src/memory/MemoryCore.js:382:    `).get(memoryId);
src/memory/MemoryCore.js:392:      SELECT * FROM noe_memory
src/memory/MemoryCore.js:399:    const memoryId = safeString(id, 160);
src/memory/MemoryCore.js:400:    if (!memoryId) return false;
src/memory/MemoryCore.js:404:      ? [safeString(reason, 500) || 'manual_hide', now, memoryId, normalizeProject(projectId)]
src/memory/MemoryCore.js:405:      : [safeString(reason, 500) || 'manual_hide', now, memoryId];
src/memory/MemoryCore.js:407:      UPDATE noe_memory SET hidden = 1, hidden_reason = ?, updated_at = ?
src/memory/MemoryCore.js:413:      Promise.resolve(this.semanticIndex.remove(memoryId))
src/memory/MemoryCore.js:414:        .catch((e) => this.logger?.warn?.('[noe-memory] hide 向量清理失败:', e?.message || e));
src/memory/MemoryCore.js:443:    const rows = this.db().prepare(`SELECT ${GC_COLS} FROM noe_memory ${where} ORDER BY updated_at ASC LIMIT ?`).all(...args, maxScan + 1);
src/memory/MemoryCore.js:461:    if (!target) throw new Error('target memory missing');
src/memory/MemoryCore.js:470:    if (crossScope) throw new Error(`memory merge scope mismatch: ${crossScope.scope}->${target.scope}`);
src/memory/MemoryCore.js:477:      this.db().prepare('UPDATE noe_memory SET merge_trace = ?, updated_at = ? WHERE id = ? AND project_id = ?')
src/memory/MemoryCore.js:480:        UPDATE noe_memory SET hidden = 1, hidden_reason = ?, updated_at = ?
src/memory/MemoryCore.js:491:    const memoryId = safeString(id, 160);
src/memory/MemoryCore.js:492:    if (!memoryId) return null;
src/memory/MemoryCore.js:495:      UPDATE noe_memory
src/memory/MemoryCore.js:498:    `).run(now, now, memoryId);
src/memory/MemoryCore.js:499:    return this.get(memoryId);
src/memory/MemoryCore.js:513:      UPDATE noe_memory
src/memory/MemoryCore.js:523:    const memoryId = safeString(id, 160);
src/memory/MemoryCore.js:524:    if (!memoryId) return null;
src/memory/MemoryCore.js:527:    const r = this.db().prepare('UPDATE noe_memory SET salience = ?, updated_at = ? WHERE id = ?').run(s, now, memoryId);
src/memory/MemoryCore.js:528:    return r.changes > 0 ? this.get(memoryId, { includeHidden: true }) : null;
src/memory/MemoryCore.js:541:    const memoryId = safeString(id, 160);
src/memory/MemoryCore.js:542:    if (!memoryId) return false;
src/memory/MemoryCore.js:545:    const args = projectId ? [now, memoryId, normalizeProject(projectId)] : [now, memoryId];
src/memory/MemoryCore.js:547:      UPDATE noe_memory SET hidden = 0, hidden_reason = NULL, updated_at = ?
src/memory/MemoryCore.js:552:      const mem = this.get(memoryId, { includeHidden: true });
src/memory/MemoryCore.js:554:        Promise.resolve(this.semanticIndex.upsert({ refId: memoryId, text: `${mem.title}\n${mem.body}` }))
src/memory/MemoryCore.js:555:          .catch((e) => this.logger?.warn?.('[noe-memory] unhide 向量重建失败:', e?.message || e));
src/memory/MemoryCore.js:604:        this.logger?.warn?.('[noe-memory] Fisher-Rao 重排失败，退回 cosine 召回:', e?.message || e);
src/memory/MemoryCore.js:612:        this.logger?.warn?.('[noe-memory] 语义召回失败，退回 FTS:', e?.message || e);
src/memory/MemoryCore.js:678:        SELECT m.*, bm25(noe_memory_fts) AS score
src/memory/MemoryCore.js:679:        FROM noe_memory_fts
src/memory/MemoryCore.js:680:        JOIN noe_memory m ON m.rowid = noe_memory_fts.rowid
src/memory/MemoryCore.js:681:        WHERE noe_memory_fts MATCH ? AND ${where.join(' AND ')}
src/memory/MemoryCore.js:686:      this.logger?.warn?.('[noe-memory] FTS recall fallback:', e?.message || e);
src/memory/MemoryCore.js:710:      FROM noe_memory
src/memory/MemoryCore.js:728:      SELECT * FROM noe_memory
src/memory/MemoryCore.js:746:      FROM noe_memory ${suffix}
src/memory/MemoryCore.js:758:export const memoryCore = new MemoryCore();
src/cognition/NoeThoughtLoopGuard.js:26:import { normalizeForDedup } from '../memory/NoeMemoryDedup.js';
src/memory/NoeMemoryMarkdownMirror.js:5:// 借鉴 Basic Memory（basicmachines-co/basic-memory，AGPL）的「NOTE-FORMAT」理念，
src/memory/NoeMemoryMarkdownMirror.js:13://     NoeMemoryContextFormatter（喂给模型的 <noe-memory-v2> XML 块）。本模块只补「给人看的 .md 文本」缺口。
src/memory/NoeMemoryMarkdownMirror.js:20://     MCP 或 fs.writeFile 到 ~/.noe-panel/memory-md/）；唯一外部依赖是「脱敏函数」，默认注入 Neo 现成的
src/memory/NoeMemoryMarkdownMirror.js:279:      type: 'memory',
src/memory/NoeMemoryMarkdownMirror.js:281:      source: 'memory_core',
src/memory/NoeMemoryMarkdownMirror.js:292: * 调用方拿到 [{ relPath, content }] 后自行决定写到 ~/.noe-panel/memory-md/（或经 obsidian MCP）。
src/memory/NoeMemoryMarkdownMirror.js:311:    files.push({ relPath: 'memory/long-term.md', content: toMarkdown(memDoc, { redact }) });
src/capabilities/builtinReadonlyTools.js:19:    id: 'noe.memory.recall',
src/capabilities/builtinReadonlyTools.js:21:    description: '检索 Noe 长期记忆（noe_memory）中的条目，只读',
src/capabilities/builtinReadonlyTools.js:25:    operation: 'noe.memory.recall',
src/capabilities/builtinReadonlyTools.js:100: * @param {object} [deps.memory]    需有 recall()
src/capabilities/builtinReadonlyTools.js:103:export function createReadonlyToolHandlers({ fileIndex, memory, knowledgeGraph } = {}) {
src/capabilities/builtinReadonlyTools.js:112:  if (memory && typeof memory.recall === 'function') {
src/capabilities/builtinReadonlyTools.js:113:    handlers['noe.memory.recall'] = async ({ args = {} }) => {
src/capabilities/builtinReadonlyTools.js:116:      const items = memory.recall({ q, projectId: args.projectId, limit: args.limit, bumpHits: false });
src/runtime/NoeContextScrubber.js:30:  ['memory-context', /<memory-context\b[^>]*>[\s\S]*?<\/memory-context>/gi],
src/room/NoeClaudeCollaborator.js:95:    memory: [],
src/room/NoeClaudeCollaborator.js:110:    memory: Array.isArray(parsed.memory) ? parsed.memory : [],
src/room/NoeClaudeCollaborator.js:168:function renderMemory(memory = []) {
src/room/NoeClaudeCollaborator.js:169:  const items = memory.slice(-12);
src/room/NoeClaudeCollaborator.js:218:- 你有持久上下文: Claude CLI session_id + 下方显式 memory。请利用它保持连续性，但不要把隐藏上下文当作不可审计事实。
src/room/NoeClaudeCollaborator.js:246:${renderMemory(state?.memory || [])}
src/room/NoeClaudeCollaborator.js:260:6. memory_update: 用一句话记录你下轮应继续记住的事实`;
src/room/NoeClaudeCollaborator.js:300:  const match = String(resultText || '').match(/memory_update\s*[:：]\s*([\s\S]{1,800})/i);
src/room/NoeClaudeCollaborator.js:397:  const memoryUpdate = extractMemoryUpdate(resultText) || `Claude reviewed task ${runMeta.taskHash}.`;
src/room/NoeClaudeCollaborator.js:404:    memory: [
src/room/NoeClaudeCollaborator.js:405:      ...state.memory,
src/room/NoeClaudeCollaborator.js:406:      { ts: nowIso(), kind: 'claude_report', summary: memoryUpdate, reportPath: relative(rootDir, reportPath) },
src/room/NoeClaudeCollaborator.js:441:    memoryCount: state.memory.length,
src/memory/FocusStack.js:2:import { memoryCore as defaultMemoryCore } from './MemoryCore.js';
src/memory/FocusStack.js:32:    absorbedMemoryId: row.absorbed_memory_id || null,
src/memory/FocusStack.js:41:  constructor({ storage = sqliteStore, memory = defaultMemoryCore } = {}) {
src/memory/FocusStack.js:43:    this.memory = memory;
src/memory/FocusStack.js:131:    if (input.absorb !== false && this.memory?.write) {
src/memory/FocusStack.js:132:      const memory = this.memory.write({
src/memory/FocusStack.js:141:      absorbedMemoryId = memory?.id || null;
src/memory/FocusStack.js:147:          absorbed_memory_id = ?,
src/memory/NoeMemoryContextFormatter.js:27:    `<noe-memory-v2 trust="local" budget="${clean(budget, 40) || 'compact'}">`,
src/memory/NoeMemoryContextFormatter.js:30:    '</noe-memory-v2>',
src/memory/NoeMemoryRoadmapVerifier.js:18:  const memory = new MemoryCore({
src/memory/NoeMemoryRoadmapVerifier.js:24:  const writeGate = new NoeMemoryWriteGate({ memory, auditLog, now, logger: { warn: () => {} } });
src/memory/NoeMemoryRoadmapVerifier.js:25:  const retriever = new NoeMemoryRetriever({ memory, auditLog, now, logger: { warn: () => {} } });
src/memory/NoeMemoryRoadmapVerifier.js:26:  return { memory, auditLog, writeGate, retriever };
src/memory/NoeMemoryRoadmapVerifier.js:53:  const { memory, auditLog, writeGate, retriever } = makeStack(now);
src/memory/NoeMemoryRoadmapVerifier.js:56:    tag: 'memory_roadmap_canary',
src/memory/NoeMemoryRoadmapVerifier.js:57:    entityType: 'noe_memory_canary',
src/memory/NoeMemoryRoadmapVerifier.js:61:    detail: 'memory roadmap canary',
src/memory/NoeMemoryRoadmapVerifier.js:74:    tags: ['memory', 'canary'],
src/memory/NoeMemoryRoadmapVerifier.js:76:  const links = auditLog.linksForMemory(created.memory?.id);
src/memory/NoeMemoryRoadmapVerifier.js:82:    memoryPolicy: { recallLimit: 5, injectLimit: 5 },
src/memory/NoeMemoryRoadmapVerifier.js:83:    turnId: 'memory-roadmap-canary',
src/memory/NoeMemoryRoadmapVerifier.js:86:    targetMemoryId: created.memory?.id,
src/memory/NoeMemoryRoadmapVerifier.js:97:  const hideOk = memory.hide(created.memory?.id, { projectId, reason: 'roadmap_canary_hide' });
src/memory/NoeMemoryRoadmapVerifier.js:98:  const hiddenGone = memory.get(created.memory?.id) === null;
src/memory/NoeMemoryRoadmapVerifier.js:99:  const unhideOk = memory.unhide(created.memory?.id, { projectId });
src/memory/NoeMemoryRoadmapVerifier.js:100:  const restored = memory.get(created.memory?.id) !== null;
src/memory/NoeMemoryRoadmapVerifier.js:101:  const deleteOk = memory.hide(created.memory?.id, { projectId, reason: 'roadmap_canary_delete' });
src/memory/NoeMemoryRoadmapVerifier.js:102:  const deletedGone = memory.get(created.memory?.id) === null;
src/memory/NoeMemoryRoadmapVerifier.js:107:    check('gate_write_accepted', created.ok === true, { decision: created.decision, memoryId: created.memory?.id || null }),
src/memory/NoeMemoryRoadmapVerifier.js:109:    check('retrieval_selects_canary', (retrieved.selectedIds || []).includes(created.memory?.id), { selectedIds: retrieved.selectedIds || [] }),
src/memory/NoeMemoryRoadmapVerifier.js:110:    check('owner_confirmed_edit', edited.ok === true && /编辑/.test(memory.get(created.memory?.id, { includeHidden: true })?.body || ''), { decision: edited.decision }),
src/memory/NoeMemoryRoadmapVerifier.js:113:    check('candidate_replay', replay.ok === true && replay.targetMemoryId === created.memory?.id, { candidateId: created.candidate?.id || null }),
src/memory/NoeMemoryRoadmapVerifier.js:137:  const dir = mkdtempSync(join(tmpdir(), 'noe-memory-roadmap-'));
src/memory/NoeMemoryRoadmapVerifier.js:156:      const memory = new MemoryCore({ logger: { warn: () => {}, info: () => {} } });
src/memory/NoeMemoryRoadmapVerifier.js:160:      const maintenance = await runNoeMemoryMaintenanceDryRun({ memory, db, projectId });
src/memory/NoeMemoryRoadmapVerifier.js:161:      const provenanceBackfill = planNoeMemoryProvenanceBackfill({ db, projectId, memoryLimit: 200, episodeLimit: 5000 });
src/memory/NoeMemoryRoadmapVerifier.js:163:        join(process.cwd(), 'output', 'noe-memory-copy-validation'),
src/memory/NoeMemoryRoadmapVerifier.js:164:        'noe-memory-copy-validation-'
src/memory/NoeMemoryRoadmapVerifier.js:167:        join(process.cwd(), 'output', 'noe-memory-relevance-benchmark'),
src/memory/NoeMemoryRoadmapVerifier.js:168:        'noe-memory-relevance-benchmark-',
src/memory/NoeMemoryRoadmapVerifier.js:225:          maintenanceActive: liveRuntime?.ok === true && Boolean(status.maintenance?.dream?.enabled || status.maintenance?.episodeSublimation?.enabled || status.maintenance?.memoryGc?.enabled),
src/storage/SqliteStore.js:376:    name: 'noe_core_memory_focus_tools',
src/storage/SqliteStore.js:379:        CREATE TABLE IF NOT EXISTS noe_memory (
src/storage/SqliteStore.js:394:        CREATE INDEX IF NOT EXISTS idx_noe_memory_project_hidden_updated
src/storage/SqliteStore.js:395:          ON noe_memory(project_id, hidden, updated_at);
src/storage/SqliteStore.js:396:        CREATE INDEX IF NOT EXISTS idx_noe_memory_scope_project
src/storage/SqliteStore.js:397:          ON noe_memory(scope, project_id, hidden);
src/storage/SqliteStore.js:409:          absorbed_memory_id TEXT,
src/storage/SqliteStore.js:438:          CREATE VIRTUAL TABLE IF NOT EXISTS noe_memory_fts
src/storage/SqliteStore.js:439:          USING fts5(title, body, tags, content='noe_memory', content_rowid='rowid', tokenize='trigram');
src/storage/SqliteStore.js:443:          CREATE VIRTUAL TABLE IF NOT EXISTS noe_memory_fts
src/storage/SqliteStore.js:444:          USING fts5(title, body, tags, content='noe_memory', content_rowid='rowid');
src/storage/SqliteStore.js:449:        CREATE TRIGGER IF NOT EXISTS noe_memory_ai
src/storage/SqliteStore.js:450:        AFTER INSERT ON noe_memory
src/storage/SqliteStore.js:453:          INSERT INTO noe_memory_fts(rowid, title, body, tags)
src/storage/SqliteStore.js:457:        CREATE TRIGGER IF NOT EXISTS noe_memory_ad
src/storage/SqliteStore.js:458:        AFTER DELETE ON noe_memory
src/storage/SqliteStore.js:461:          INSERT INTO noe_memory_fts(noe_memory_fts, rowid, title, body, tags)
src/storage/SqliteStore.js:465:        CREATE TRIGGER IF NOT EXISTS noe_memory_au
src/storage/SqliteStore.js:466:        AFTER UPDATE ON noe_memory
src/storage/SqliteStore.js:468:          INSERT INTO noe_memory_fts(noe_memory_fts, rowid, title, body, tags)
src/storage/SqliteStore.js:471:          INSERT INTO noe_memory_fts(rowid, title, body, tags)
src/storage/SqliteStore.js:510:    name: 'noe_memory_m1_metadata',
src/storage/SqliteStore.js:512:      const cols = new Set(db.prepare("PRAGMA table_info(noe_memory)").all().map((row) => row.name));
src/storage/SqliteStore.js:515:          db.exec(`ALTER TABLE noe_memory ADD COLUMN ${ddl}`);
src/storage/SqliteStore.js:525:        CREATE INDEX IF NOT EXISTS idx_noe_memory_expiry
src/storage/SqliteStore.js:526:          ON noe_memory(project_id, hidden, expires_at);
src/storage/SqliteStore.js:527:        CREATE INDEX IF NOT EXISTS idx_noe_memory_confidence
src/storage/SqliteStore.js:528:          ON noe_memory(project_id, hidden, confidence, updated_at);
src/storage/SqliteStore.js:534:    name: 'noe_memory_salience',
src/storage/SqliteStore.js:537:      const cols = new Set(db.prepare("PRAGMA table_info(noe_memory)").all().map((row) => row.name));
src/storage/SqliteStore.js:539:        db.exec('ALTER TABLE noe_memory ADD COLUMN salience INTEGER NOT NULL DEFAULT 3');
src/storage/SqliteStore.js:542:        CREATE INDEX IF NOT EXISTS idx_noe_memory_salience
src/storage/SqliteStore.js:543:          ON noe_memory(project_id, hidden, salience, updated_at);
src/storage/SqliteStore.js:549:    name: 'noe_memory_fts_au_trigger_guard',
src/storage/SqliteStore.js:551:      // 审计 §3.3 P0-4：原 noe_memory_au UPDATE trigger 无条件重建 FTS（delete old + insert new），
src/storage/SqliteStore.js:558:      db.exec('DROP TRIGGER IF EXISTS noe_memory_au;');
src/storage/SqliteStore.js:560:        CREATE TRIGGER noe_memory_au
src/storage/SqliteStore.js:561:        AFTER UPDATE ON noe_memory
src/storage/SqliteStore.js:563:          INSERT INTO noe_memory_fts(noe_memory_fts, rowid, title, body, tags)
src/storage/SqliteStore.js:570:          INSERT INTO noe_memory_fts(rowid, title, body, tags)
src/storage/SqliteStore.js:632:          surprise REAL
src/storage/SqliteStore.js:654:    name: 'noe_memory_temporal_facts',
src/storage/SqliteStore.js:656:      const cols = new Set(db.prepare("PRAGMA table_info(noe_memory)").all().map((row) => row.name));
src/storage/SqliteStore.js:659:          db.exec(`ALTER TABLE noe_memory ADD COLUMN ${ddl}`);
src/storage/SqliteStore.js:667:        CREATE INDEX IF NOT EXISTS idx_noe_memory_valid_window
src/storage/SqliteStore.js:668:          ON noe_memory(project_id, hidden, scope, valid_from, valid_to);
src/storage/SqliteStore.js:669:        CREATE INDEX IF NOT EXISTS idx_noe_memory_source_episode
src/storage/SqliteStore.js:670:          ON noe_memory(source_episode_id);
src/storage/SqliteStore.js:704:    name: 'noe_memory_v2_governance',
src/storage/SqliteStore.js:733:    //   只有 NOE_EFE_CURIOSITY=1 的 harvestSurprise 路径才写入。幂等 ALTER（同 v8 noe_memory 做法）。
src/cognition/SelfTalkOutcome.js:16:  'memory',
src/cognition/SelfTalkOutcome.js:81: * @property {'expectation'|'commitment'|'goal'|'memory'|'awareness'|'silent'} type
src/memory/NoeNightlyReflection.js:100: * @param {{priors: Array<any>, reviews: unknown, memory: any, projectId: string}} args
src/memory/NoeNightlyReflection.js:103:export function applyVerdicts({ priors, reviews, memory, projectId }) {
src/memory/NoeNightlyReflection.js:116:      memory.write({
src/memory/NoeNightlyReflection.js:141:  memory = null,             // MemoryCore：insight 读写
src/memory/NoeNightlyReflection.js:197:    if (!timeline?.recent || !memory?.write) return { reflected: false, reason: 'not_wired' };
src/memory/NoeNightlyReflection.js:211:      priors = (memory.recall({ q: '', scope: 'insight', projectId, limit: reviewLimit, bumpHits: false }) || []);
src/memory/NoeNightlyReflection.js:228:      const budget = resolveNoeOutputBudget('memory_write_candidate');
src/memory/NoeNightlyReflection.js:263:        const r = writeGate?.commit ? writeGate.commit(payload) : { ok: true, memory: memory.write(payload) };
src/memory/NoeNightlyReflection.js:271:    const reviewed = applyVerdicts({ priors, reviews: parsed.reviews, memory, projectId });
src/room/NoeSelfEvolutionTrigger.js:19:  memory_writeback_ready: 'noe.self_evolution.memory_writeback',
src/runtime/NoeProposalExecutor.js:11:  memory_candidate: 'queues/memory-candidates.jsonl',
src/memory/NoeMemoryCandidateChainDrill.js:15:export const NOE_MEMORY_CANDIDATE_CHAIN_DRILL_DIR = 'output/noe-memory-candidate-chain-drill';
src/memory/NoeMemoryCandidateChainDrill.js:33:  return `memory-candidate-chain-${nowIso(now).replace(/[-:.]/g, '').replace('T', 'T').replace('Z', 'Z')}`;
src/memory/NoeMemoryCandidateChainDrill.js:53:  writeJson(resolve(fixtureRoot, 'output/noe-background-review/chain-memory-report.json'), {
src/memory/NoeMemoryCandidateChainDrill.js:57:        id: 'chain-memory-proposal',
src/memory/NoeMemoryCandidateChainDrill.js:58:        kind: 'memory',
src/memory/NoeMemoryCandidateChainDrill.js:59:        tool: 'memory_candidate',
src/memory/NoeMemoryCandidateChainDrill.js:62:          text: 'Owner wants Neo memory candidates to pass proposal materialization, owner review, dry-run apply, and rollback evidence before MemoryCore writes.',
src/memory/NoeMemoryCandidateChainDrill.js:70:  const proposal = inbox.proposals.find((item) => item.type === 'memory_candidate');
src/memory/NoeMemoryCandidateChainDrill.js:151:    memoryCore: {
src/memory/NoeMemoryCandidateChainDrill.js:170:  const memoryDbPath = resolve(fixtureRoot, 'output/noe-memory-candidates/fixture-memory-core/panel.db');
src/memory/NoeMemoryCandidateChainDrill.js:177:    initSqlite(memoryDbPath);
src/memory/NoeMemoryCandidateChainDrill.js:178:    const memoryCore = new MemoryCore({ logger: null });
src/memory/NoeMemoryCandidateChainDrill.js:181:      reportDir: 'output/noe-memory-candidates/apply-reports/confirmed-fixture',
src/memory/NoeMemoryCandidateChainDrill.js:184:      memoryCore,
src/memory/NoeMemoryCandidateChainDrill.js:187:    const memoryId = confirmedApply.applied?.[0]?.memoryId || '';
src/memory/NoeMemoryCandidateChainDrill.js:188:    if (memoryId) {
src/memory/NoeMemoryCandidateChainDrill.js:189:      writtenMemory = memoryCore.get(memoryId, { includeHidden: true });
src/memory/NoeMemoryCandidateChainDrill.js:193:        reportDir: 'output/noe-memory-candidates/rollback-reports/confirmed-fixture',
src/memory/NoeMemoryCandidateChainDrill.js:196:        memoryCore,
src/memory/NoeMemoryCandidateChainDrill.js:199:      hiddenMemory = memoryCore.get(memoryId, { includeHidden: true });
src/memory/NoeMemoryCandidateChainDrill.js:200:      recallVisibleAfterRollback = memoryCore.recall({
src/memory/NoeMemoryCandidateChainDrill.js:217:      && !recallVisibleAfterRollback.includes(confirmedApply.applied?.[0]?.memoryId)),
src/memory/NoeMemoryCandidateChainDrill.js:221:    dbRef: rel(rootAbs, memoryDbPath),
src/memory/NoeMemoryCandidateChainDrill.js:223:    memoryId: confirmedApply.applied?.[0]?.memoryId || '',
src/memory/NoeMemoryCandidateChainDrill.js:226:    visibleAfterRollback: recallVisibleAfterRollback.includes(confirmedApply.applied?.[0]?.memoryId),
src/capabilities/NoeToolRouter.js:8:  'noe.recall_memory',
src/capabilities/NoeToolRouter.js:14:  memory: ['memory', 'recall', '记忆', '回忆', '历史', '昨天', '上周'],
src/memory/NoeMemoryCandidateSchema.js:96:    targetMemoryId: clean(input.targetMemoryId ?? input.target_memory_id ?? input.memoryId ?? input.memory_id, 180) || null,
src/memory/NoeMemoryCandidateSchema.js:170:      { at: candidate.createdAt, gate: 'noe_memory_write_gate', candidateId: candidate.id },
src/cognition/NoeApprovalGoalResolver.js:88:  let goalDone = false;
src/cognition/NoeApprovalGoalResolver.js:89:  if (goalRef && goalSystem?.recordStepResult) {
src/cognition/NoeApprovalGoalResolver.js:110:        ? goalSystem.recordStepResult(goalRef.goalId, goalRef.stepIndex, { done: true, note })
src/cognition/NoeApprovalGoalResolver.js:111:        : goalSystem.recordStepResult(goalRef.goalId, goalRef.stepIndex, { status: stepStatus, note });
src/cognition/NoeApprovalGoalResolver.js:113:      goalDone = res?.goalDone === true;
src/cognition/NoeApprovalGoalResolver.js:117:  return { goalUpdated, goalDone, goalRef };
src/memory/NoeActiveMemory.js:66:          reason: 'active_memory_circuit_open',
src/memory/NoeActiveMemory.js:104:        reason: state.retryAt ? 'active_memory_circuit_open' : 'active_memory_recall_failed',
src/memory/NoeActiveMemory.js:179:  memory,
src/memory/NoeActiveMemory.js:188:    return { ok: false, error: 'focus_conclusion_ack_required', memory: null };
src/memory/NoeActiveMemory.js:190:  if (!memory?.write) return { ok: false, error: 'memory_write_unavailable', memory: null };
src/memory/NoeActiveMemory.js:198:  const written = memory.write({
src/memory/NoeActiveMemory.js:207:  return { ok: true, memory: written };
src/memory/NoeActiveMemory.js:213:  memory,
src/memory/NoeActiveMemory.js:217:  if (!memory?.recall) return { ok: true, skipped: true, timeWindow: parseNoeChineseTimeWindow(query, { now }), memories: [] };
src/memory/NoeActiveMemory.js:220:  const raw = memory.recall({ q: '', projectId, scope: FOCUS_CONCLUSION_SCOPE, limit: Math.max(limit * 4, 20), bumpHits: false });
src/memory/NoeActiveMemory.js:236:  memory,
src/memory/NoeActiveMemory.js:249:      reason: 'active_memory_not_applicable',
src/memory/NoeActiveMemory.js:255:  const recallKey = circuitKey || `${projectId}:${scope || 'all'}:active-memory`;
src/memory/NoeActiveMemory.js:262:      reason: 'active_memory_circuit_open',
src/memory/NoeActiveMemory.js:271:    raw = memory?.recall ? memory.recall({ q: clean(goal, 1000), projectId, scope: scope || undefined, limit }) : [];
src/memory/NoeActiveMemory.js:272:    focusRecall = recallFocusConclusions({ query: goal, projectId, memory, now, limit });
src/memory/NoeActiveMemory.js:280:      reason: 'active_memory_recall_failed',
src/memory/NoeActiveMemory.js:297:    ? `<memory-context source="noe-active-memory" trust="local-untrusted">\n${memories.map((item) => `- ${item.text}`).join('\n')}\n</memory-context>`
src/memory/NoeActiveMemory.js:303:    reason: memories.length ? '' : 'active_memory_no_recall',
src/memory/NoeActiveMemory.js:310:      memoryCount: memories.length,
src/memory/NoeSftHarvester.js:38:  memory: (title) => `关于「${title}」，你记得什么？`,
src/memory/NoeSftHarvester.js:73:  memory = null,              // insight + 高显著记忆来源
src/memory/NoeSftHarvester.js:121:      for (const m of (memory?.recall?.({ q: '', scope: 'insight', projectId, limit: 30, bumpHits: false }) || [])) {
src/memory/NoeSftHarvester.js:147:      for (const m of (memory?.recall?.({ q: '', projectId, limit: 30, bumpHits: false }) || [])) {
src/memory/NoeSftHarvester.js:149:        const p = take(PROMPTS.memory(String(m.title || '那件事').slice(0, 40)), m.body);
src/memory/NoeMemoryAuditLog.js:48:    targetMemoryId: row.target_memory_id || null,
src/memory/NoeMemoryAuditLog.js:78:      INSERT INTO noe_memory_candidate(
src/memory/NoeMemoryAuditLog.js:81:        decision, decision_reason, target_memory_id, candidate_json, created_at, decided_at
src/memory/NoeMemoryAuditLog.js:86:        target_memory_id = excluded.target_memory_id,
src/memory/NoeMemoryAuditLog.js:118:  linkMemory(memoryId, links = []) {
src/memory/NoeMemoryAuditLog.js:119:    const id = clean(memoryId, 180);
src/memory/NoeMemoryAuditLog.js:122:      INSERT OR IGNORE INTO noe_memory_link(memory_id, link_type, link_ref, quote_hash, created_at)
src/memory/NoeMemoryAuditLog.js:137:  linksForMemory(memoryId) {
src/memory/NoeMemoryAuditLog.js:138:    const id = clean(memoryId, 180);
src/memory/NoeMemoryAuditLog.js:142:      FROM noe_memory_link WHERE memory_id = ? ORDER BY id ASC
src/memory/NoeMemoryAuditLog.js:155:      SELECT * FROM noe_memory_candidate
src/memory/NoeMemoryAuditLog.js:165:    const row = this.db().prepare('SELECT * FROM noe_memory_candidate WHERE id = ?').get(candidateId);
src/memory/NoeMemoryAuditLog.js:194:      INSERT INTO noe_memory_retrieval_log(
src/memory/NoeMemoryAuditLog.js:214:      FROM noe_memory_candidate WHERE project_id = ?
src/memory/NoeMemoryAuditLog.js:228:      SELECT hit_ids, selected_ids FROM noe_memory_retrieval_log
src/voice/NoeActionBridge.js:34:function memoryWrite(input, { memory, memoryWriteGate } = {}) {
src/voice/NoeActionBridge.js:35:  if (memoryWriteGate?.commit) return memoryWriteGate.commit(input);
src/voice/NoeActionBridge.js:36:  const written = memory?.write?.(input);
src/voice/NoeActionBridge.js:37:  return written ? { ok: true, memory: written } : { ok: false, memory: null };
src/voice/NoeActionBridge.js:41:  memory,
src/voice/NoeActionBridge.js:42:  memoryWriteGate = null,
src/voice/NoeActionBridge.js:55:      const written = memoryWrite({
src/voice/NoeActionBridge.js:64:      }, { memory, memoryWriteGate });
src/voice/NoeActionBridge.js:79:      const written = memoryWrite({
src/voice/NoeActionBridge.js:87:      }, { memory, memoryWriteGate });
src/memory/NoeDreamConsolidation.js:5:// 不耦合任何 LLM/adapter:llmConsolidate 钩子由调用方注入(M3 实现见 NoeDreamM3Hook.js)。可单测(用 fake memoryCore)。
src/memory/NoeDreamConsolidation.js:9:export function applyConsolidationPlan(memoryCore, plan, { projectId } = {}) {
src/memory/NoeDreamConsolidation.js:11:  if (!memoryCore || !plan) return out;
src/memory/NoeDreamConsolidation.js:14:    try { const c = memoryCore.get?.(id, { includeHidden: true }); return Boolean(c) && (c.salience || 3) >= 5; } catch { return false; }
src/memory/NoeDreamConsolidation.js:19:      memoryCore.merge?.({ targetId: m.keepId, sourceIds: m.dropIds, projectId, reason: m.reason || 'dream_merge' });
src/memory/NoeDreamConsolidation.js:20:      if (Number.isFinite(m.mergedSalience)) memoryCore.setSalience?.(m.keepId, m.mergedSalience);
src/memory/NoeDreamConsolidation.js:26:    try { if (memoryCore.downgrade?.(d.id, d.toSalience)) out.downgraded += 1; } catch { out.errors += 1; }
src/memory/NoeDreamConsolidation.js:30:      const cur = memoryCore.get?.(p.id, { includeHidden: true });
src/memory/NoeDreamConsolidation.js:31:      if (cur) { memoryCore.setSalience?.(p.id, Math.min(5, (cur.salience || 3) + 1)); out.promoted += 1; }
src/memory/NoeDreamConsolidation.js:40:export function loadConsolidationCandidates(memoryCore, { projectId, limit = 50 } = {}) {
src/memory/NoeDreamConsolidation.js:41:  if (!memoryCore?.recall) return [];
src/memory/NoeDreamConsolidation.js:43:  const hot = memoryCore.recall({ projectId, q: '', limit: hotLimit, bumpHits: false, includeExpired: true }) || [];
src/memory/NoeDreamConsolidation.js:44:  const cold = memoryCore.recall({ projectId, q: '', limit, bumpHits: false, includeExpired: true, order: 'cold' }) || [];
src/memory/NoeDreamConsolidation.js:72:export function createMemoryDreamLoop(memoryCore, {
src/memory/NoeDreamConsolidation.js:77:    loadCandidates: () => loadConsolidationCandidates(memoryCore, { projectId, limit: candidateLimit }),
src/memory/NoeDreamConsolidation.js:78:    applyPlan: (plan) => applyConsolidationPlan(memoryCore, plan, { projectId }),
src/permissions/PermissionGovernance.js:410:      // 默认含：unified-kb（统一知识库）+ 三个官方 server（filesystem 限 allowed-dirs / memory / playwright）。
src/permissions/PermissionGovernance.js:415:      const TRUSTED_LOCAL_MCP = new Set((process.env.NOE_TRUSTED_MCP || 'unified-kb,filesystem,memory,playwright').split(',').map((s) => s.trim()).filter(Boolean));
src/memory/NoeMemoryStatus.js:26:  if (!tableExists(db, 'noe_memory')) return { factTotal: 0, linkedFacts: 0, anyLinkedFacts: 0, weakLinkedFacts: 0, reviewedOrphanFacts: 0, unreviewedOrphanFacts: 0, orphanFacts: 0, orphanFactIds: [] };
src/memory/NoeMemoryStatus.js:33:      AND NOT EXISTS(SELECT 1 FROM noe_memory_link l WHERE l.memory_id=m.id AND l.link_type IN (${strongTypes}) LIMIT 1)
src/memory/NoeMemoryStatus.js:35:  const factTotal = Number(one(db, "SELECT COUNT(*) AS c FROM noe_memory WHERE hidden=0 AND scope='fact' AND (expires_at IS NULL OR expires_at > ?)", [now])?.c) || 0;
src/memory/NoeMemoryStatus.js:37:    SELECT COUNT(*) AS c FROM noe_memory m
src/memory/NoeMemoryStatus.js:41:        OR EXISTS(SELECT 1 FROM noe_memory_link l WHERE l.memory_id=m.id AND l.link_type IN (${strongTypes}) LIMIT 1))
src/memory/NoeMemoryStatus.js:44:    SELECT COUNT(*) AS c FROM noe_memory m
src/memory/NoeMemoryStatus.js:46:      AND EXISTS(SELECT 1 FROM noe_memory_link l WHERE l.memory_id=m.id LIMIT 1)
src/memory/NoeMemoryStatus.js:48:  const reviewedOrphanFacts = tableExists(db, 'noe_memory_candidate')
src/memory/NoeMemoryStatus.js:50:      SELECT COUNT(*) AS c FROM noe_memory m
src/memory/NoeMemoryStatus.js:52:        AND EXISTS(SELECT 1 FROM noe_memory_candidate c
src/memory/NoeMemoryStatus.js:53:          WHERE c.target_memory_id=m.id AND c.decision LIKE 'auto_%' LIMIT 1)
src/memory/NoeMemoryStatus.js:57:    SELECT m.id FROM noe_memory m
src/memory/NoeMemoryStatus.js:75:  return countBy(all(db, 'SELECT source_type AS key, MAX(created_at) AS c FROM noe_memory GROUP BY source_type'), 'key');
src/memory/NoeMemoryStatus.js:79:  if (!tableExists(db, 'noe_memory_candidate')) return { total: 0, byDecision: {}, quarantineCount: 0, needsReview: 0 };
src/memory/NoeMemoryStatus.js:80:  const byDecision = countBy(all(db, 'SELECT decision AS key, COUNT(*) AS c FROM noe_memory_candidate GROUP BY decision'), 'key');
src/memory/NoeMemoryStatus.js:90:  if (!tableExists(db, 'noe_memory_retrieval_log')) return { logs: 0, hitRate: null };
src/memory/NoeMemoryStatus.js:91:  const rows = all(db, 'SELECT hit_ids, selected_ids FROM noe_memory_retrieval_log ORDER BY ts DESC LIMIT 200');
src/memory/NoeMemoryStatus.js:105:  const row = one(db, "SELECT COUNT(*) AS c, COUNT(DISTINCT ref_id) AS refs FROM embeddings WHERE kind='noe_memory'");
src/memory/NoeMemoryStatus.js:106:  const models = countBy(all(db, "SELECT COALESCE(model, '') AS key, COUNT(*) AS c FROM embeddings WHERE kind='noe_memory' GROUP BY COALESCE(model, '') ORDER BY c DESC LIMIT 8"), 'key');
src/memory/NoeMemoryStatus.js:108:  const dims = countBy(all(db, "SELECT dim AS key, COUNT(*) AS c FROM embeddings WHERE kind='noe_memory' AND dim IS NOT NULL AND dim>0 GROUP BY dim ORDER BY c DESC LIMIT 8"), 'key');
src/memory/NoeMemoryStatus.js:147:  const counts = tableExists(database, 'noe_memory')
src/memory/NoeMemoryStatus.js:149:        total: Number(one(database, 'SELECT COUNT(*) AS c FROM noe_memory')?.c) || 0,
src/memory/NoeMemoryStatus.js:150:        visible: Number(one(database, 'SELECT COUNT(*) AS c FROM noe_memory WHERE hidden=0 AND (expires_at IS NULL OR expires_at > ?)', [t])?.c) || 0,
src/memory/NoeMemoryStatus.js:151:        hidden: Number(one(database, 'SELECT COUNT(*) AS c FROM noe_memory WHERE hidden=1')?.c) || 0,
src/memory/NoeMemoryStatus.js:152:        expired: Number(one(database, 'SELECT COUNT(*) AS c FROM noe_memory WHERE expires_at IS NOT NULL AND expires_at <= ?', [t])?.c) || 0,
src/memory/NoeMemoryStatus.js:153:        byScope: countBy(all(database, 'SELECT scope AS key, COUNT(*) AS c FROM noe_memory WHERE hidden=0 GROUP BY scope'), 'key'),
src/memory/NoeMemoryStatus.js:154:        bySourceType: countBy(all(database, 'SELECT source_type AS key, COUNT(*) AS c FROM noe_memory WHERE hidden=0 GROUP BY source_type'), 'key'),
src/memory/NoeMemoryStatus.js:189:  const memoryGcMode = env.NOE_MEMORY_GC === '1' ? 'apply' : (env.NOE_MEMORY_GC === 'dry' ? 'dry' : 'off');
src/memory/NoeMemoryStatus.js:194:    memoryGc: { enabled: memoryGcMode !== 'off', mode: memoryGcMode, lastAt: last.memory_gc || null },
src/memory/NoeMemoryStatus.js:195:    skillDistill: { enabled: true, lastAt: last.skill_distill || null },
src/memory/NoeMemoryStatus.js:215:    lastConsolidation: maintenance.dream.lastAt || maintenance.memoryGc.lastAt || null,
src/memory/NoeMemoryStatus.js:224:    memory: {
src/room/CollaborationDispatcher.js:356:  // mid-task 持久化:把当前 in-memory taskList 显式 store.update → save 到 file。
src/room/CollaborationDispatcher.js:357:  // 修架构 bug:之前 _runOneTaskUntilTerminal 内部 push attempts/reviews / 改 status 都只在 in-memory,
src/room/CollaborationDispatcher.js:371:      // 持久化失败不阻断 squad 主流程(主流程仍跑 in-memory),仅警告
src/room/NoeClaudeEvidenceParser.js:33:  return /^(?:\d+[.)]\s*)?(?:风险|硬边界|给\s*Codex|challenge_log|memory_update)\b[:：]?/i.test(text);
src/cognition/NoeDeliberation.js:58:  memory = null,              // MemoryCore（M7/CoALA 检索动作：深思前自动召回相关记忆与技能卡）
src/cognition/NoeDeliberation.js:86:    if (memory?.recall) {
src/cognition/NoeDeliberation.js:88:        const hits = memory.recall({ query: focus.slice(0, 120), projectId, limit: 3 }) || [];
src/capabilities/NoeCommandSurface.js:29:    id: 'noe.recall_memory',
src/capabilities/NoeCommandSurface.js:42:    capabilityTags: ['memory', 'recall', 'readonly', '记忆', '检索'],
src/capabilities/NoeCommandSurface.js:43:    aliases: ['recall_memory', '记忆', '回忆'],
src/cognition/NoeCuriosityDecompose.js:9://   Neo 现状只有单标量 surprise=-log2(p)（NoeExpectationLedger.js）+ 单阈值好奇回路
src/cognition/NoeCuriosityDecompose.js:10://   harvestSurprise（NoeGoalSystem.js，surprise≥2bit → 研究目标），没有拆 epistemic/pragmatic。
src/cognition/NoeCuriosityDecompose.js:15://   把现有单 surprise（≈ epistemicValue 的天然来源：落空越狠 = 不确定性缺口越大）当 epistemic 输入，
src/cognition/NoeCuriosityDecompose.js:23://   - 与 NoeExpectationLedger 的 surprise=-log2(p) 不重复——这里不算 surprise，只消费它。
src/cognition/NoeCuriosityDecompose.js:36: * Neo 的 surprise 单位是 bit（-log2(p)），默认 scale=2 → 恰好 2bit（现有好奇阈值）映射到 0.5。
src/cognition/NoeCuriosityDecompose.js:93: * @param {number} args.epistemicValue 认识价值原始量（如 surprise(bit)/信念熵/信息增益；非负，越大越好奇）
src/memory/NoeMemoryRetrievalSample.js:4:  { id: 'memory_status', q: '长期记忆', routeType: 'chat' },
src/memory/NoeMemoryRetrievalSample.js:8:  { id: 'skill_distill', q: 'skill_distill', routeType: 'mission' },
src/memory/NoeMemoryRetrievalSample.js:10:  { id: 'project_memory', q: 'project', routeType: 'mission' },
src/memory/NoeMemoryRetrievalSample.js:15:  { id: 'memory_gate', q: 'gate', routeType: 'mission' },
src/memory/NoeMemoryRetrievalSample.js:35:  turnPrefix = `memory-retrieval-sample-${Date.now()}`,
src/memory/NoeMemoryRetrievalSample.js:49:      memoryPolicy: { recallLimit: limit, injectLimit: limit },
src/voice/VoiceSession.js:11:import { memoryPolicyForProfile } from './MemoryPolicy.js';
src/voice/VoiceSession.js:207:  constructor({ sttClient, ttsClient, brainRouter, getAdapter, memory = null, memoryWriteGate = null, memoryRetriever = null, visionSession = null, factExtractor = null, kokoroTts = null, voiceGatewayTts = null, cosyVoiceTts = null, sileroVad = null, webSearch = null, searchSummarizer = null, researcher = null, chatProfileStore = null, ownerGate = createOwnerGateFromEnv(), identityStore = null, personStore = null, toolRegistry = null, commitmentStore = null, delegationHook = null, personCardStore = null, prefetchStore = null, generationFence = null, contextEngine = null, episodicTimeline = null, foregroundChatRouting = null, llmStream = process.env.NOE_VOICE_LLM_STREAM === '1', projectId = 'noe' } = {}) {
src/voice/VoiceSession.js:216:    this.memory = memory;
src/voice/VoiceSession.js:217:    this.memoryWriteGate = memoryWriteGate;
src/voice/VoiceSession.js:242:    this.contextEngine = contextEngine || new NoeTurnContextEngine({ memory, memoryWriteGate, memoryRetriever, personStore, commitmentStore, personCardStore, prefetchStore, toolRegistry, episodicTimeline });
src/voice/VoiceSession.js:245:    this.history = []; // 会话内短期对话历史（最近若干轮），让对话连续记得上一句；长期记忆走 memory.recall
src/voice/VoiceSession.js:368:    const memoryPolicy = opts.memoryPolicy || memoryPolicyForProfile(profile);
src/voice/VoiceSession.js:418:      try { this.memory?.write?.({ projectId: this.projectId, scope: 'voice', sourceType: 'voice', body: dialogue, tags: [...memoryPolicy.tags, 'research'], confidence: memoryPolicy.dialogueConfidence }); } catch { /* 记忆失败不阻断 */ }
src/voice/VoiceSession.js:468:    const memoryPolicy = memoryPolicyForProfile(profile);
src/voice/VoiceSession.js:474:    if (researchIntent && this.webSearch) return this._respondWithResearch(transcript, researchIntent, { ...opts, profile, memoryPolicy });
src/voice/VoiceSession.js:532:      memoryPolicy,
src/voice/VoiceSession.js:723:      if (memoryPolicy.writeDialogue) {
src/voice/VoiceSession.js:725:          this.memory?.write?.({ projectId: this.projectId, scope: 'voice', sourceType: 'voice', body: dialogue, tags: memoryPolicy.tags, confidence: memoryPolicy.dialogueConfidence, sourceEpisodeId });
src/voice/VoiceSession.js:733:      if (this.factExtractor && memoryPolicy.extractFacts) {
src/voice/VoiceSession.js:735:          ? this.factExtractor.extractRecords(dialogue, { confidence: memoryPolicy.factConfidence, sourceEpisodeId, evidenceRefs: sourceEpisodeId ? [`episode:${sourceEpisodeId}`] : [] })
src/voice/VoiceSession.js:748:                  tags: memoryPolicy.factTags,
src/voice/VoiceSession.js:749:                  confidence: record.confidence ?? memoryPolicy.factConfidence,
src/voice/VoiceSession.js:757:                if (this.memoryWriteGate?.commit) this.memoryWriteGate.commit(candidate);
src/voice/VoiceSession.js:758:                else if (!record.noWriteReason) this.memory?.write?.(candidate);
src/cognition/NoeGoalStepRecorder.js:47: * @returns {{ok: boolean, goalDone: boolean, goal?: object}}
src/cognition/NoeGoalStepRecorder.js:61:    if (!g) return { ok: false, goalDone: false };
src/cognition/NoeGoalStepRecorder.js:76:    } else return { ok: false, goalDone: false };
src/cognition/NoeGoalStepRecorder.js:93:    return { ok: true, goalDone: allDone, goal: allDone ? { ...g, plan, status: 'done' } : undefined };
src/cognition/NoeGoalStepRecorder.js:95:    return { ok: false, goalDone: false };
src/room/NoeConsensusRunner.js:98:    '- Runtime verification, rollback, and consensus-approved memory writeback are required.',
src/room/NoeConsensusRunner.js:130:    '- Runtime verification, rollback, and consensus-approved memory writeback are required.',
src/room/NoeConsensusRunner.js:476:      memoryWritebackAckRequired: true,
src/memory/NoeDreamM3Hook.js:6:// Adapted from BaiLongma (MIT) src/memory/consolidator.js 的整合器提示词。
src/runtime/NoeProcessVitals.js:69:    const m = proc.memoryUsage?.() || {};
src/cognition/SelfTalkLandingPolicy.js:6:// goal/memory/awareness, or explicitly close as silent. Silent clears the loop
src/cognition/SelfTalkLandingPolicy.js:13:  complianceLandingTypes: Object.freeze(['expectation', 'commitment', 'goal', 'memory', 'awareness', 'silent']),
src/cognition/SelfTalkLandingPolicy.js:14:  externalLandingTypes: Object.freeze(['expectation', 'commitment', 'goal', 'memory', 'awareness']),
src/cognition/NoeExpectationResolver.js:350:  return kinds.some((item) => /episode|thought|reflection|observation|self_talk|memory/i.test(String(item.kind || '')));
src/cognition/NoeExpectationResolver.js:582:// P1-C 整改（双代理验收 F1+F2）：surprise 来源分桶——据预测 source + loosen 检测推导 origin，供验收门 b 区分非噪声。
src/cognition/NoeExpectationResolver.js:592:// P1-C 整改 F3：验收门 b 判据——owner_*/action_failure 是 owner+action 类「非噪声」surprise；loosen_fail/reflection_miss/expectation_miss 不计。
src/cognition/NoeExpectationResolver.js:613:    observationKinds: countSummaryMatches(kinds, 'kind', /episode|thought|reflection|observation|self_talk|memory/i),
src/cognition/NoeExpectationResolver.js:919:  return /episode|thought|reflection|observation|self_talk|memory/i.test(String(kind || ''));
src/cognition/NoeExpectationResolver.js:1597:            // 「被现实硬纠正后主动学习」的发动机；此前自动判证路径从不接 harvestSurprise（source=surprise 恒为 0）。
src/cognition/NoeExpectationResolver.js:1599:              try { goalSystem.harvestSurprise({ claim: exp.claim, surprise: resolvedRow.surprise, origin: deriveSurpriseOrigin(exp.source, { loosenOnly: v.loosenOnly }) }); } // P1-C 整改 F1+F2：据 source 推导 origin + loosen_fail 噪声分桶
src/room/ChatRoomStore.js:88:  /** gracefulShutdown 时强制同步落盘（v0.45 P0-2: 无论 pending 与否都写一次，保证 in-memory state 一定落盘） */
src/voice/MemoryPolicy.js:6:export function memoryPolicyForProfile(profile = {}) {
src/voice/MemoryPolicy.js:30:export function rankProfileMemories(items = [], policy = memoryPolicyForProfile()) {
src/cognition/NoeExpectationLedger.js:5:// 问题：Noe 对世界从不"下注"——没有预测就没有落空，没有落空就没有惊奇（surprise），自我认知
src/cognition/NoeExpectationLedger.js:7:// 设计：noe_expectations 表（迁移 v7）记 {claim, p, due_at}；到期结算 outcome → surprise =
src/cognition/NoeExpectationLedger.js:14:import { textSimilarity } from '../memory/NoeMemoryDedup.js';
src/cognition/NoeExpectationLedger.js:130:   * surprise = -log2(p_实际结果)：高自信落空 → 大惊奇（注意力/反思素材的信号源）。
src/cognition/NoeExpectationLedger.js:136:      let surprise = null;
src/cognition/NoeExpectationLedger.js:141:        surprise = -Math.log2(clamp(pActual, 0.001, 1));
src/cognition/NoeExpectationLedger.js:148:        getdb().prepare('UPDATE noe_expectations SET resolved_at = ?, outcome = ?, surprise = ?, resolved_by = ? WHERE id = ?').run(t, oc, surprise, by, id);
src/cognition/NoeExpectationLedger.js:150:        getdb().prepare('UPDATE noe_expectations SET resolved_at = ?, outcome = ?, surprise = ? WHERE id = ?').run(t, oc, surprise, id);
src/cognition/NoeExpectationLedger.js:152:      return { ...row, resolved_at: t, outcome: oc, surprise, resolved_by: hasResolvedBy ? by : null };
src/cognition/NoeExpectationLedger.js:159:      return getdb().prepare('UPDATE noe_expectations SET resolved_at = ?, outcome = NULL, surprise = NULL WHERE resolved_at IS NULL AND due_at IS NOT NULL AND due_at < ?')
src/cognition/NoeIncidentEscalator.js:48:    pattern: 'NoeGoal|goal_step|recordStepResult|nextStep|act_started|act_done|research_started|research_done|awaiting_approval|blocked|failed',
src/cognition/NoeIncidentEscalator.js:69:    domain: 'memory',
src/cognition/NoeIncidentEscalator.js:73:    paths: ['src/memory', 'src/knowledge', 'src/cognition', 'src/server/routes/knowledge.js', 'tests/unit'],
src/cognition/NoeIncidentEscalator.js:74:    verify: ['test', '--', 'tests/unit/noe-memory-focus.test.js', 'tests/unit/noe-fact-extractor.test.js'],
src/cognition/NoeStepExpectationBridge.js:4:// 根因（Claude+M3 研究，panel.db 实测）：source='surprise' 好奇目标恒为 0、outcome=0 落空恒为 0、
src/cognition/NoeStepExpectationBridge.js:10://   resolve(outcome=0) → surprise=-log2(1-p) → harvestSurprise(origin='action_failure')，让好奇回路有米下锅。
src/cognition/NoeStepExpectationBridge.js:12:// 防 reward hacking（红队/研究警示「别让 Neo 故意做容易失败的 act 刷 surprise」）：
src/cognition/NoeStepExpectationBridge.js:25: * @param {number} [opts.surpriseThreshold] surprise≥此值才立好奇目标（默认 2bit）
src/cognition/NoeStepExpectationBridge.js:26: * @param {number} [opts.predictedP] 「这步会成功」的预测概率（默认 0.8 → 落空 surprise≈2.32bit）
src/cognition/NoeStepExpectationBridge.js:32:  surpriseThreshold = 2,
src/cognition/NoeStepExpectationBridge.js:38:   * @returns {{expectationId:number, surprise:number, curiosityGoalId:any}|null}
src/cognition/NoeStepExpectationBridge.js:53:      const surprise = Number(r.surprise) || 0;
src/cognition/NoeStepExpectationBridge.js:54:      if (surprise < surpriseThreshold) return { expectationId: id, surprise, curiosityGoalId: null };
src/cognition/NoeStepExpectationBridge.js:56:      const curiosityGoalId = goalSystem.harvestSurprise({ claim: r.claim, surprise, origin: 'action_failure' });
src/cognition/NoeStepExpectationBridge.js:57:      return { expectationId: id, surprise, curiosityGoalId };
src/room/NoeSelfEvolutionLoop.js:40:function memoryDone(input = {}) {
src/room/NoeSelfEvolutionLoop.js:41:  return isDone(input.memoryWriteback);
src/room/NoeSelfEvolutionLoop.js:54:    memoryWriteback: safeObject(input.memoryWriteback),
src/room/NoeSelfEvolutionLoop.js:94:    memorySummaryRef: cleanString(input.memoryWriteback?.summaryRef),
src/room/NoeSelfEvolutionLoop.js:183:  if (!memoryDone(input)) {
src/room/NoeSelfEvolutionLoop.js:184:    const memoryGate = checkGate(input, 'memory_writeback');
src/room/NoeSelfEvolutionLoop.js:186:      stage: memoryGate.ok ? 'memory_writeback_ready' : 'memory_writeback_blocked',
src/room/NoeSelfEvolutionLoop.js:187:      nextAction: memoryGate.ok ? 'write_confirmed_memory_summary' : 'fix_memory_writeback_gate_inputs',
src/room/NoeSelfEvolutionLoop.js:188:      blocked: !memoryGate.ok,
src/room/NoeSelfEvolutionLoop.js:189:      gates: { implementation: implementationGate, memoryWriteback: memoryGate },
src/room/NoeSelfEvolutionLoop.js:190:      errors: memoryGate.ok ? [] : memoryGate.errors,
src/room/NoeSelfEvolutionLoop.js:191:      warnings: [...warnings, ...memoryGate.warnings],
src/room/NoeSelfEvolutionLoop.js:212:  const memoryReady = memoryDone(input) || state.stage === 'memory_writeback_ready';
src/room/NoeSelfEvolutionLoop.js:220:    { id: 'memory_writeback', done: memoryDone(input), ready: memoryReady, required: true },
src/vision/VisionSession.js:25:  constructor({ capturer, vlmClient, ocrClient = null, memory = null, projectId = 'noe', mode = 'off', faceEngine = null, personStore = null, personCards = null, faceRecog = 'ask' } = {}) {
src/vision/VisionSession.js:29:    this.memory = memory;
src/vision/VisionSession.js:135:      this.memory?.write?.({ id: `vision-latest:${this.projectId}`, projectId: this.projectId, scope: 'vision', sourceType: 'attachment', body: this.lastSummary, tags: ['vision', 'attachment'], confidence: 0.6 });
src/vision/VisionSession.js:195:      this.memory?.write?.({ id: `vision-latest:${this.projectId}`, projectId: this.projectId, scope: 'vision', sourceType: modeUsed, body: summary, tags: ['vision', modeUsed], confidence: 0.5 });
src/cognition/NoeLearningTopics.js:7:    query: 'autonomous agent self directed web research memory goal execution checkpoint examples',
src/cognition/NoeLearningTopics.js:21:    query: 'agent memory conflict temporal knowledge graph Letta Mem0 Graphiti Zep sleep time compute',
src/cognition/NoeLearningTopics.js:22:    url: 'https://github.com/topics/agent-memory',
src/cognition/NoeLearningTopics.js:24:    localPaths: ['src/memory', 'src/cognition', 'docs', 'tests/unit'],
src/cognition/NoeLearningTopics.js:30:    localPattern: 'checkpoint|awaiting_approval|recovered|blocked|recordStepResult|act_started|act_done|NoeHeartbeat',
src/cognition/NoeLearningTopics.js:38:    localPaths: ['src/cognition', 'src/loop', 'src/memory', 'docs'],
src/cognition/NoeLearningTopics.js:58:  if (/记忆|长期|冲突|修正|memory|conflict/i.test(s)) return topics[2] || learningTopicAtCursor(2, topics);
src/cognition/NoeExpectationSemanticRecall.js:6:// source=surprise 恒 0。R6 离线实验（真实 claim×events qwen3-embedding）证实：4/6 claim 与相关事件有强语义
src/voice/NoeToolBridge.js:8:  { tool: 'noe.memory.recall', re: /记得|记忆|我.*(说过|提过|讲过|喜欢|讨厌)|之前.*(说|聊|提)|关于我|我的(习惯|偏好|情况)/, label: '我的记忆' },
src/cognition/NoeGoalSystem.js:11:// 好奇回路 v1：高惊奇（落空的自信预测，surprise ≥ 2 bit）→ 自动生成"搞明白为什么"的研究目标
src/cognition/NoeGoalSystem.js:29:  surprise: 0.55,    // 好奇回路（被现实打脸）
src/cognition/NoeGoalSystem.js:48:// 默认 pragmatic 信号源：claim 与当前 open/active 目标（排除 surprise 自身源）标题+why 的关键词重叠度 → [0,1]。
src/cognition/NoeGoalSystem.js:100:  // S0.7（GEPA 可优化对象）：好奇回路立项的 surprise 阈值（bit）抽成注入式参数。
src/cognition/NoeGoalSystem.js:101:  //   opts 缺省读 env NOE_WS_SALIENCE_SURPRISE_BIT，env 也无则用原硬编码默认 2（surprise≥2bit 才立研究目标）。
src/cognition/NoeGoalSystem.js:115:  // 默认 pragmatic 信号：claim 与当前 open/active 目标（剔除 surprise 自身源，避免自指）语境的关键词重叠。
src/cognition/NoeGoalSystem.js:120:        .filter((r) => r.source !== 'surprise')
src/cognition/NoeGoalSystem.js:234:    const res = recordStepResult(g.id, -1, {
src/cognition/NoeGoalSystem.js:306:  // P1-C 整改 F3：surprise 来源运行时分桶（验收门 b 消费端）——区分 owner+action 非噪声 vs loosen_fail/expectation_miss 等噪声。
src/cognition/NoeGoalSystem.js:307:  function surpriseOriginBreakdown({ limit = 500 } = {}) {
src/cognition/NoeGoalSystem.js:310:      const rows = getdb().prepare("SELECT meta FROM noe_goals WHERE source = 'surprise' ORDER BY created_at DESC LIMIT ?").all(lim);
src/cognition/NoeGoalSystem.js:539:   * @returns {{ok: boolean, goalDone: boolean, goal?: object}} goalDone=true 时调用方可做技能蒸馏（M7）
src/cognition/NoeGoalSystem.js:541:  function recordStepResult(goalId, stepIndex, { note = '', done = false, doing = false, status = null, newSteps = null } = {}) {
src/cognition/NoeGoalSystem.js:563:   * 好奇二分解接入（NOE_EFE_CURIOSITY=1）：在不改「surprise≥2bit 才立项」门槛、不改 title/旧 why 主体的前提下，
src/cognition/NoeGoalSystem.js:564:   *   用 curiosityScore(epistemic=surprise, pragmatic=pragmaticSignal(claim)) 把这条好奇拆成可解释双因子，
src/cognition/NoeGoalSystem.js:568:  function harvestSurprise({ claim, surprise, origin } = {}) {
src/cognition/NoeGoalSystem.js:569:    if (!(Number(surprise) >= curiositySurpriseThreshold) || !claim) return null;
src/cognition/NoeGoalSystem.js:570:    const surpriseBit = Number(surprise);
src/cognition/NoeGoalSystem.js:571:    // P1-C：surprise 来源分桶（action_failure/owner_followup/…），让 surprise-learning-audit 验收门 b 区分非噪声 surprise。
src/cognition/NoeGoalSystem.js:573:    const baseWhy = `这条预测落空带来 ${Math.round(surpriseBit * 10) / 10} bit 惊奇——我的世界模型在这里有缺口`;
src/cognition/NoeGoalSystem.js:580:        ? { title, source: 'surprise', why: baseWhy, steps, meta: { origin: safeOrigin } }
src/cognition/NoeGoalSystem.js:581:        : { title, source: 'surprise', why: baseWhy, steps });
src/cognition/NoeGoalSystem.js:592:    // epistemic = surprise(bit)（落空越狠 = 不确定性缺口越大）；pragmatic 已在 [0,1]，故 pragmaticScale=1。
src/cognition/NoeGoalSystem.js:593:    const cs = curiosityDecompose.score({ epistemicValue: surpriseBit, pragmaticValue: prag.value, pragmaticScale: 1 });
src/cognition/NoeGoalSystem.js:605:    return add({ title, source: 'surprise', why, steps, meta });
src/cognition/NoeGoalSystem.js:613:      // P1-C 整改 F3：surprise 来源分桶接进 stats——透视页/mind route 是 stats 的生产消费方(noeMind.js:365/383/619)，
src/cognition/NoeGoalSystem.js:614:      // 由此门 b 的「owner+action 非噪声 surprise」计数进入真实运行时输出（不再只活在单测）。
src/cognition/NoeGoalSystem.js:615:      return { ...byStatus, surpriseOrigins: surpriseOriginBreakdown() };
src/cognition/NoeGoalSystem.js:619:  return { add, get, list, setStatus, arbitrate, nextStep, recordStepResult, recordStepCheckpoint, checkpoints, latestCheckpoint, harvestSurprise, surpriseOriginBreakdown, maybeSeedAutonomousLearning, stats };
src/room/SoloChatDispatcher.js:181:          memoryPolicy: CHAT_MEMORY_POLICY,
src/room/NoeSelfEvolutionCycle.js:188:  const memoryWriteback = safeObject(cycle.memoryWriteback);
src/room/NoeSelfEvolutionCycle.js:189:  addMissing(errors, isDone(memoryWriteback), 'cycle_memory_writeback_done_required');
src/room/NoeSelfEvolutionCycle.js:190:  checkRef(errors, root, memoryWriteback.summaryRef, 'cycle_memory_summary_ref', requireFile);
src/room/NoeSelfEvolutionCycle.js:191:  if (hasText(memoryWriteback.writeRef)) checkRef(errors, root, memoryWriteback.writeRef, 'cycle_memory_write_ref', requireFile);
src/room/NoeSelfEvolutionCycle.js:228:      memoryWriteback: isDone(memoryWriteback),
src/runtime/mission/NoeMissionQualityAudit.js:49:      reviewBrain: ['code_write', 'self_evolution_apply', 'identity_memory_write'],
src/room/NoeConsensusGate.js:20:  'memory_writeback_consensus_ack',
src/room/NoeConsensusGate.js:255:  if (implementation.memoryWritebackAckRequired !== true && implementation.memoryWritebackUserAckRequired !== true) {
src/room/NoeConsensusGate.js:256:    errors.push('implementation_requires_memory_writeback_ack');
src/context/NoeSelfModel.js:13:import { relativeTime, defaultEpisodicTimeline } from '../memory/EpisodicTimeline.js';
src/cost/CostTracker.js:4:// 粗略定价（USD per 1M tokens）—— 仅作展示估算，准确数据见 [禁假数据] memory
src/context/NoeHostContext.js:55:  if (hw?.memGB || hw?.memoryGB) parts.push(`内存：${hw.memGB || hw.memoryGB}GB`);
src/runtime/mission/NoeMissionReviewGate.js:24:  if (/delete|remove|publish|external|live|identity|memory_write|secret|token/.test(text)) risks.add('high_risk');
src/runtime/mission/NoeMissionReviewGate.js:30:  if (/identity|memory_write/.test(text)) risks.add('identity_memory_write');
src/runtime/mission/NoeMissionReviewGate.js:40:  if (risks.includes('delete') || risks.includes('publish') || risks.includes('identity_memory_write')) return 'local_write';
src/runtime/NoeGatewayProtocol.js:5:export const NOE_GATEWAY_EVENT_KINDS = new Set(['agent', 'tool', 'memory', 'council', 'health', 'task', 'presence', 'heartbeat', 'ui']);
src/context/NoeSelfKnowledge.js:82:  if (id === 'memory') ok = addCheck('evidence_refs_non_empty') || addCheck('insight_memory_exists');
src/context/NoeSelfKnowledge.js:235:    { id: 'memory', name: '记忆系统', detail: 'SQLite FTS 记忆(MemoryCore)+ 焦点栈(FocusStack)+ 知识图谱(NoeKnowledgeGraph)+ 人物关系卡(NoePersonCards)。' },
src/context/NoeSelfKnowledge.js:236:    { id: 'dream', name: '梦境/睡眠记忆整合', detail: '后台周期整合记忆:合并重复(软删可恢复)、降级陈旧、高频晋升、身份级铁保护(src/memory/NoeMemoryConsolidator + NoeDreamConsolidation,默认 OFF,NOE_DREAM=1 开,模型可选本地/M3)。' },
src/context/NoeSelfKnowledge.js:244:    { id: 'continuity', name: '连续记忆脊椎(自传体时间线)', detail: `把经历记成第一人称时间线并注入对话——覆盖语音/文字对话、深度研究完成、主人派活确认、聊天室见闻(src/memory/EpisodicTimeline.js + NoeSelfModel);${detectContinuityStatus().enabled ? '当前已通电(NOE_CONTINUITY=1)。' : '当前未通电(NOE_CONTINUITY 默认 OFF,不记录不注入)。'}` },
src/context/NoeSelfKnowledge.js:247:    { id: 'dream-sublimation', name: '梦境升华(久远情景→语义记忆)', detail: `把 90 天前的自传体情景按周整理成第一人称摘要,沉淀进长期语义记忆(像人把久远经历化成"那段日子"的印象,赶在情景 180 天保留期硬删之前),再写回一条"我梦里整理了往事"的梦境情景;摘要大脑复用 NOE_DREAM_MODEL,默认确定性拼接不调模型(src/memory/NoeEpisodeSublimation.js);${detectEpisodeSublimationStatus().enabled ? '当前已通电(NOE_DREAM_EPISODES=1)。' : '当前未通电(NOE_DREAM_EPISODES 默认 OFF,不升华)。'}` },
src/context/NoeContextEngine.js:73:  constructor({ memory = null, focus = null, fileIndex = null, prefetch = null, personCards = null, commitments = null } = {}) {
src/context/NoeContextEngine.js:75:    this.memory = memory;
src/context/NoeContextEngine.js:106:    const memories = this.memory?.recall ? this.memory.recall({ q, projectId, limit }) : [];
src/context/NoeContextEngine.js:108:      sources.push({ kind: 'memory', count: memories.length, text: memories.map((item) => redactSensitiveText(item.text || item.content || item.title || '')).join(' ') });
src/context/NoeContextEngine.js:109:      parts.push(`<memory-context>\n${memories.map((item) => `- ${redactSensitiveText(item.text || item.content || item.title || '')}`).join('\n')}\n</memory-context>`);
src/context/NoeTurnContextEngine.js:18:import { formatMemoryContextBlock } from '../memory/NoeMemoryContextFormatter.js';
src/context/NoeTurnContextEngine.js:170:    memory = null,
src/context/NoeTurnContextEngine.js:178:    memoryRetriever = null,
src/context/NoeTurnContextEngine.js:179:    memoryWriteGate = null,
src/context/NoeTurnContextEngine.js:189:    this.memory = memory;
src/context/NoeTurnContextEngine.js:199:    this.memoryRetriever = memoryRetriever;
src/context/NoeTurnContextEngine.js:200:    this.memoryWriteGate = memoryWriteGate;
src/context/NoeTurnContextEngine.js:215:   *   memoryPolicy 记忆策略（recallLimit/injectLimit，见 MemoryPolicy）；
src/context/NoeTurnContextEngine.js:230:    memoryPolicy = null,
src/context/NoeTurnContextEngine.js:323:        memory: this.memory,
src/context/NoeTurnContextEngine.js:324:        memoryWriteGate: this.memoryWriteGate,
src/context/NoeTurnContextEngine.js:366:    if (on('recall') && this.memoryRetriever?.retrieve && memoryPolicy && !visionQuestion && !correctionQuestion) {
src/context/NoeTurnContextEngine.js:367:      const retrieval = await runProvider('recall', () => this.memoryRetriever.retrieve({ transcript, projectId, routeType: 'chat', memoryPolicy }));
src/context/NoeTurnContextEngine.js:369:        const block = formatMemoryContextBlock(retrieval, { maxItems: memoryPolicy.injectLimit || 6 });
src/context/NoeTurnContextEngine.js:372:    } else if (on('recall') && this.memory?.recall && memoryPolicy && !visionQuestion && !correctionQuestion) {
src/context/NoeTurnContextEngine.js:375:        const recallArgs = { q: transcript, projectId, limit: memoryPolicy.recallLimit, bumpHits: false };
src/context/NoeTurnContextEngine.js:376:        const recalledRaw = this.memory.recallFused ? await this.memory.recallFused(recallArgs) : this.memory.recall(recallArgs);
src/context/NoeTurnContextEngine.js:378:          .filter((m) => m && m.body && m.scope !== 'voice'), memoryPolicy).slice(0, memoryPolicy.injectLimit);
src/runtime/NoeWeChatPersonalBridge.js:148:  memory = null,
src/runtime/NoeWeChatPersonalBridge.js:168:      if (memory?.write) {
src/runtime/NoeWeChatPersonalBridge.js:169:        try { memory.write(buildSocialInboundMemory(message, { projectId })); } catch { /* memory write must not break dry-run ack */ }
src/runtime/mission/NoeMissionLongSoak.js:99:      reviewBrain: ['code_write', 'self_evolution_apply', 'identity_memory_write'],
src/runtime/NoeBackgroundReview.js:11:  'memory_candidate',
src/runtime/NoeBackgroundReview.js:22:只输出 JSON：{"decision":"propose|skip","memoryProposals":[...],"skillProposals":[...],"actionProposals":[...],"risks":[...],"confidence":0.0}`;
src/runtime/NoeBackgroundReview.js:78:  if (kind === 'memory') return 'memory_candidate';
src/runtime/NoeBackgroundReview.js:124:          allowedActions: ['memory_candidate', 'skill_draft', 'review_report'],
src/runtime/NoeBackgroundReview.js:174:    ...(Array.isArray(parsed.memoryProposals) ? parsed.memoryProposals.map((item) => ({ kind: 'memory', item })) : []),
src/runtime/NoeBackgroundReview.js:259:        ? 'inspect denied tool or JSON parse failure; do not persist memory or skills'
src/runtime/NoeDelegationExtractor.js:56:    id: 'memory',
src/runtime/NoeDelegationExtractor.js:60:    paths: ['src/memory', 'src/knowledge', 'src/cognition', 'src/server/routes/knowledge.js', 'tests/unit'],
src/runtime/NoeDelegationExtractor.js:66:    pattern: 'NoeGoal|goal_step|recordStepResult|nextStep|act_started|act_done|research_started|research_done|awaiting_approval|blocked',
src/runtime/NoeQqBridgeResearchGate.js:200:  memory = null,
src/runtime/NoeQqBridgeResearchGate.js:215:      if (memory?.write) {
src/runtime/NoeQqBridgeResearchGate.js:216:        try { memory.write(buildSocialInboundMemory(message, { projectId })); } catch { /* dry-run memory write must not break ack */ }
src/runtime/mission/NoeSelfLearningMission.js:182:      reviewBrain: ['code_write', 'self_evolution_apply', 'identity_memory_write'],
src/server/services/cluster-resource-guard.js:135:  const memory = overrides.memory || process.memoryUsage();
src/server/services/cluster-resource-guard.js:141:    rssMb: Math.round((positiveNumber(memory.rss) / MB) * 10) / 10,
src/server/services/cluster-resource-guard.js:142:    heapUsedMb: Math.round((positiveNumber(memory.heapUsed) / MB) * 10) / 10,
src/server/services/cluster-resource-guard.js:143:    heapTotalMb: Math.round((positiveNumber(memory.heapTotal) / MB) * 10) / 10,
src/server/services/cluster-resource-guard.js:144:    heapUsedRatio: positiveNumber(memory.heapTotal) > 0
src/server/services/cluster-resource-guard.js:145:      ? Math.round((positiveNumber(memory.heapUsed) / positiveNumber(memory.heapTotal)) * 1000) / 1000
src/server/services/cluster-resource-guard.js:147:    externalMb: Math.round((positiveNumber(memory.external) / MB) * 10) / 10,
src/server/services/cluster-resource-guard.js:148:    arrayBuffersMb: Math.round((positiveNumber(memory.arrayBuffers) / MB) * 10) / 10,
src/server/routes/noeProposals.js:10:import { MemoryCore } from '../../memory/MemoryCore.js';
src/server/routes/noeProposals.js:11:import { runNoeMemoryCandidateReview } from '../../memory/NoeMemoryCandidateReview.js';
src/server/routes/noeProposals.js:12:import { runNoeMemoryCandidateApply } from '../../memory/NoeMemoryCandidateApply.js';
src/server/routes/noeProposals.js:13:import { runNoeMemoryCandidateRollback } from '../../memory/NoeMemoryCandidateRollback.js';
src/server/routes/noeProposals.js:14:import { buildNoeMemoryCandidateStatus } from '../../memory/NoeMemoryCandidateStatus.js';
src/server/routes/noeProposals.js:156:  app.get('/api/noe/memory-candidates/status', requireOwnerToken, (req, res) => {
src/server/routes/noeProposals.js:167:  app.post('/api/noe/memory-candidates/review', requireOwnerToken, (req, res) => {
src/server/routes/noeProposals.js:182:  app.post('/api/noe/memory-candidates/apply', requireOwnerToken, (req, res) => {
src/server/routes/noeProposals.js:190:        memoryCore: dryRun ? null : createMemoryCore(),
src/server/routes/noeProposals.js:199:  app.post('/api/noe/memory-candidates/rollback', requireOwnerToken, (req, res) => {
src/server/routes/noeProposals.js:208:        memoryCore: dryRun ? null : createMemoryCore(),
src/agents/AgentSkillRegistry.js:143:    mission: 'Track context drift, recurring risks, and useful memory without mutating work.',
src/server/services/noe-maintenance.js:3:// db-backup / retention / memory-GC，~110 行）从 server.js 原文迁出。
src/server/services/noe-maintenance.js:5:// 注入约定：memoryCore（MemoryCore 实例）/ prefetchStore（预取池）/ dataDir（~/.noe-panel）单向注入；
src/server/services/noe-maintenance.js:13:import { createMemoryDreamLoop } from '../../memory/NoeDreamConsolidation.js';
src/server/services/noe-maintenance.js:14:import { createConsolidateHook, parseModelSpec, buildChat } from '../../memory/NoeDreamM3Hook.js';
src/server/services/noe-maintenance.js:15:import { createEpisodeSublimationLoop, createSublimateHook } from '../../memory/NoeEpisodeSublimation.js';
src/server/services/noe-maintenance.js:16:import { EpisodicTimeline } from '../../memory/EpisodicTimeline.js';
src/server/services/noe-maintenance.js:24: * @param {{ memoryCore: any, prefetchStore: any, dataDir: string }} deps
src/server/services/noe-maintenance.js:27:export function installNoeMaintenanceLoops({ memoryCore, prefetchStore, dataDir }) {
src/server/services/noe-maintenance.js:55:  const dreamLoop = createMemoryDreamLoop(memoryCore, {
src/server/services/noe-maintenance.js:74:    memoryCore,
src/server/services/noe-maintenance.js:132:      withActiveGuard('noe-memory-gc', async () => {
src/server/services/noe-maintenance.js:133:        const r = memoryCore.runGc({ apply: memGcMode === '1', reason: 'gc_curator_scheduled' });
src/server/services/noe-maintenance.js:135:        console.log(`[noe-memory-gc] ${memGcMode === '1' ? '已隐藏' : 'dry-run 候选'} ${n} 条(expired=${r.plan.counts.expired} stale=${r.plan.counts.stale} lowconf=${r.plan.counts.low_confidence})${r.truncated ? ' [超扫描上限,下轮继续]' : ''}`);
src/server/services/noe-maintenance.js:136:      }, { onSkip: () => console.warn('[noe-memory-gc] 上一轮还在跑，跳过本轮(withActiveGuard)') })
src/server/services/noe-maintenance.js:137:        .catch((e) => console.warn('[noe-memory-gc] 失败:', e?.message));
src/server/services/noe-maintenance.js:140:    console.log(`[noe-memory-gc] 已启用(${memGcMode === '1' ? 'apply' : 'dry-run'},每 ${Math.round(gcIntervalMs / 60000)} 分钟)`);
src/agents/CodebaseFtsIndex.js:171:  const db = new Database(':memory:');
src/server/routes/noeSocialInbound.js:96:  memory = null,
src/server/routes/noeSocialInbound.js:102:  const receiver = createSocialWebhookReceiver({ gateway, memory, onInboundMessage, now });
src/server/routes/noeSocialInbound.js:103:  const wechatPersonal = createWeChatPersonalBridge({ memory, onInboundMessage, env, now });
src/server/routes/noeSocialInbound.js:104:  const qqGate = createQqBridgeResearchGate({ memory, onInboundMessage, env, now });
src/server/routes/noeCoreRoutes.js:17:  memory,
src/server/routes/noeCoreRoutes.js:51:  app.get('/api/noe/memory', requireOwnerToken, (req, res) => {
src/server/routes/noeCoreRoutes.js:53:      const items = memory.recall({
src/server/routes/noeCoreRoutes.js:66:  app.post('/api/noe/memory', requireOwnerToken, (req, res) => {
src/server/routes/noeCoreRoutes.js:68:      const item = memory.write(req.body || {});
src/server/routes/noeCoreRoutes.js:75:  app.delete('/api/noe/memory/:id', requireOwnerToken, (req, res) => {
src/server/routes/noeCoreRoutes.js:77:      const ok = memory.hide(req.params.id, {
src/server/routes/noeCoreRoutes.js:81:      if (!ok) return res.status(404).json({ ok: false, error: 'memory not found' });
src/server/routes/noeCoreRoutes.js:88:  app.post('/api/noe/memory/:id/merge', requireOwnerToken, (req, res) => {
src/server/routes/noeCoreRoutes.js:90:      if (!memory.merge) return res.status(501).json({ ok: false, error: 'memory merge not configured' });
src/server/routes/noeCoreRoutes.js:91:      const item = memory.merge({
src/server/routes/safety.js:12:      // 加 process.memoryUsage() 内存监控（前端可拉来画 RSS 趋势）
src/server/routes/safety.js:13:      const mu = process.memoryUsage();
src/server/routes/safety.js:19:        memory: {
src/server/routes/noeMind.js:15:import { buildNoeMemoryStatus } from '../../memory/NoeMemoryStatus.js';
src/server/routes/noeMind.js:16:import { NoeMemoryAuditLog } from '../../memory/NoeMemoryAuditLog.js';
src/server/routes/noeMind.js:170:  memory = null,
src/server/routes/noeMind.js:171:  memoryWriteGate = null,
src/server/routes/noeMind.js:236:  const memoryProject = (req) => (typeof req.query.projectId === 'string' && req.query.projectId.trim()) ? req.query.projectId.trim().slice(0, 120) : 'noe';
src/server/routes/noeMind.js:253:        surpriseGoals: Number(rep.research?.surpriseGoals) || 0,
src/server/routes/noeMind.js:254:        surpriseGoalsDone: Number(rep.research?.surpriseGoalsDone) || 0,
src/server/routes/noeMind.js:263:    try { appendEvent({ kind: 'noe_memory_ui', tag, entityType: 'noe_memory', entityId: id, projectId, ...extra }); } catch { /* audit fail-open */ }
src/server/routes/noeMind.js:269:      return db.prepare('SELECT link_type AS type, link_ref AS ref, quote_hash AS quoteHash FROM noe_memory_link WHERE memory_id=? ORDER BY id ASC LIMIT 30').all(id);
src/server/routes/noeMind.js:277:        SELECT id, decision, decision_reason, created_at, decided_at FROM noe_memory_candidate
src/server/routes/noeMind.js:278:        WHERE target_memory_id=?
src/server/routes/noeMind.js:357:      // 口径对齐 noe-autonomy-report：开口=noe_memory source_type='noe_proactive'（30 天窗）；
src/server/routes/noeMind.js:365:        const spoke = db.prepare("SELECT created_at FROM noe_memory WHERE source_type='noe_proactive' AND created_at >= ?").all(since);
src/server/routes/noeMind.js:375:          goalDoneRate: gTotal ? Math.round((gDone / gTotal) * 100) / 100 : null,
src/server/routes/noeMind.js:407:  app.get('/api/noe/mind/memory', requireOwnerToken, (req, res) => {
src/server/routes/noeMind.js:414:  app.get('/api/noe/mind/memory/search', requireOwnerToken, (req, res) => {
src/server/routes/noeMind.js:416:      if (!memory?.recall) return res.json({ ok: true, enabled: false, items: [] });
src/server/routes/noeMind.js:419:      const items = memory.recall({ q, projectId: memoryProject(req), limit: capLimit(req.query.limit, 20, 100), includeHidden, bumpHits: false })
src/server/routes/noeMind.js:424:  app.get('/api/noe/mind/memory/export', requireOwnerToken, (req, res) => {
src/server/routes/noeMind.js:426:      if (!memory?.recall) return res.json({ ok: true, enabled: false, items: [] });
src/server/routes/noeMind.js:428:      const items = memory.recall({ q: '', projectId: memoryProject(req), limit: capLimit(req.query.limit, 100, 500), includeHidden, bumpHits: false })
src/server/routes/noeMind.js:430:      auditMemoryUi('export', 'memory-export', memoryProject(req), { exportedCount: items.length });
src/server/routes/noeMind.js:434:  app.get('/api/noe/mind/memory/quarantine', requireOwnerToken, (req, res) => {
src/server/routes/noeMind.js:440:      const items = auditLog.listCandidates({ projectId: memoryProject(req), decision, limit: capLimit(req.query.limit, 30, 200) })
src/server/routes/noeMind.js:458:  app.get('/api/noe/mind/memory/candidates/:id/replay', requireOwnerToken, (req, res) => {
src/server/routes/noeMind.js:467:  app.post('/api/noe/mind/memory/hide', requireOwnerToken, (req, res) => {
src/server/routes/noeMind.js:469:      if (!memory?.hide) return res.status(409).json({ ok: false, error: '记忆库未通电' });
src/server/routes/noeMind.js:473:      const ok = memory.hide(id, { projectId, reason: 'mind_ui_hide' });
src/server/routes/noeMind.js:478:  app.post('/api/noe/mind/memory/unhide', requireOwnerToken, (req, res) => {
src/server/routes/noeMind.js:480:      if (!memory?.unhide) return res.status(409).json({ ok: false, error: '记忆库未通电' });
src/server/routes/noeMind.js:484:      const ok = memory.unhide(id, { projectId });
src/server/routes/noeMind.js:489:  app.post('/api/noe/mind/memory/delete', requireOwnerToken, (req, res) => {
src/server/routes/noeMind.js:491:      if (!memory?.hide) return res.status(409).json({ ok: false, error: '记忆库未通电' });
src/server/routes/noeMind.js:495:      const ok = memory.hide(id, { projectId, reason: 'mind_ui_delete' });
src/server/routes/noeMind.js:500:  app.post('/api/noe/mind/memory/edit', requireOwnerToken, (req, res) => {
src/server/routes/noeMind.js:502:      if (!memory?.get || !memory?.write) return res.status(409).json({ ok: false, error: '记忆库未通电' });
src/server/routes/noeMind.js:508:      const existing = memory.get(id, { includeHidden: true });
src/server/routes/noeMind.js:525:        evidenceRefs: existing.sourceEpisodeId ? [`episode:${existing.sourceEpisodeId}`] : [`memory:${id}`],
src/server/routes/noeMind.js:531:      const r = memoryWriteGate?.commit ? memoryWriteGate.commit(payload) : { ok: true, memory: memory.write({ id, ...payload }) };
src/server/routes/noeMind.js:532:      if (r?.ok === false) return res.status(409).json({ ok: false, error: r.reason || 'memory_edit_rejected' });
src/server/routes/noeMind.js:533:      const updated = r.memory || memory.get(id, { includeHidden: true });
src/server/routes/noeMind.js:575:  // 期望账本：未结算 / 到期待裁决 / 已结算（含 surprise）/ 校准
src/server/routes/noeMind.js:602:      if (outcome !== null && Number(r.surprise) >= 2 && goalSystem && process.env.NOE_CURIOSITY === '1') {
src/server/routes/noeMind.js:603:        try { curiosityGoalId = goalSystem.harvestSurprise({ claim: r.claim, surprise: r.surprise, origin: outcome === 0 ? 'owner_manual' : undefined }); } catch { /* 好奇失败不阻断裁决 */ } // P1-C 整改 F4+F4-REOPEN：仅 owner 手动判落空(outcome=0)标 owner_manual 非噪声；应验(outcome=1)的高惊奇不误计入门 b，与 resolver/predictor 的 outcome===0 闸一致
src/server/routes/noeMind.js:609:        try { affectEngine.appraise({ goalCongruence: outcome === 1 ? 0.3 : (process.env.NOE_AFFECT_NEGATIVE === '1' ? -0.3 : -0.1), novelty: Math.min(1, (r.surprise || 0) / 4) }, { cause: `expectation:${id}` }); } catch { /* 评估失败忽略 */ }
src/server/routes/ops.js:39:      const mem = process.memoryUsage();
src/server/routes/noe.js:9:import { fileIndex as defaultFileIndex } from '../../memory/FileIndex.js';
src/server/routes/noe.js:15:import { EpisodicTimeline } from '../../memory/EpisodicTimeline.js';
src/server/routes/noe.js:21:import { NoeMemoryExtractor } from '../../memory/NoeMemoryExtractor.js';
src/server/routes/noe.js:132:  memory,
src/server/routes/noe.js:133:  memoryWriteGate = null,
src/server/routes/noe.js:134:  memoryRetriever = null,
src/server/routes/noe.js:161:  if (!memory) throw new Error('registerNoeRoutes: deps.memory required');
src/server/routes/noe.js:166:    const memoryStats = memory.stats({ projectId });
src/server/routes/noe.js:175:    if (!memoryStats || typeof memoryStats !== 'object') blockers.push('memory_stats_unavailable');
src/server/routes/noe.js:186:        memory: blockers.includes('memory_stats_unavailable') ? 'blocked' : 'passed',
src/server/routes/noe.js:190:        memoryVisible: Number(memoryStats?.visible ?? 0),
src/server/routes/noe.js:222:    memory,
src/server/routes/noe.js:231:  registerNoeSocialInboundRoutes(app, { memory });
src/server/routes/noe.js:434:  const visionSession = new VisionSession({ memory, personStore, faceRecog: process.env.NOE_FACE_RECOG || 'ask' }); registerNoeVisionAttachmentRoute(app, { visionSession, sendError }); registerNoeVisionAmbientRoutes(app, { visionSession, modelSettings, sendError });
src/server/routes/noe.js:498:    ? new VoiceSession({ sttClient: noeSttClient || undefined, sileroVad: noeSileroVad, brainRouter, getAdapter, foregroundChatRouting, memory, memoryWriteGate, memoryRetriever, episodicTimeline: voiceEpisodicTimeline, visionSession, webSearch, searchSummarizer: researchChat, researcher: deepResearcher, chatProfileStore, ownerGate: ownerGateStore, identityStore: ownerIdentityStore, personStore, toolRegistry, commitmentStore, personCardStore, prefetchStore, factExtractor: process.env.NOE_FACT_EXTRACT === '0' ? null : new NoeMemoryExtractor({ getAdapter, adapterId: process.env.NOE_FACT_BRAIN || process.env.NOE_REFLECT_BRAIN || 'lmstudio' }), kokoroTts: process.env.NOE_KOKORO === '1' ? new KokoroTtsClient() : null, voiceGatewayTts: process.env.NOE_VOICE_GATEWAY === '1' ? new OpenAICompatibleVoiceGatewayClient() : null, cosyVoiceTts: process.env.NOE_COSYVOICE === '0' ? null : new CosyVoiceTtsClient(),
src/server/routes/noe.js:635:    ? createProactiveTickHandler({ visionSession, ttsClient: new MiniMaxTtsClient(), getAdapter, memory, commitmentStore, driveBrief, feelingBrief, onCommitmentDelivery, brainAdapterId: process.env.NOE_PROACTIVE_BRAIN || 'lmstudio', cooldownMs: Number(process.env.NOE_PROACTIVE_COOLDOWN_MS) || (30 * 60 * 1000), isQuiet: process.env.NOE_CIRCADIAN === '1' ? circadianIsQuiet : null, ...(proactiveStateStore ? { stateStore: proactiveStateStore } : {}),
src/server/routes/noe.js:701:      const memoryStats = memory.stats({ projectId });
src/server/routes/noe.js:708:        memory: memoryStats,

codex
目前可见的风险信号是：`harvestSurprise` 生成的是三步通用 think 目标，真正写记忆只可能通过 `onGoalDone` 蒸馏挂点或某个 action step；我继续追这个挂点在 server 装配里到底写了什么。
exec
/bin/zsh -lc "nl -ba src/cognition/NoeWorkspace.js | sed -n '400,450p'" in /Users/hxx/Desktop/Neo 贾维斯
 succeeded in 0ms:
   400
   401	  function emitGoalReportback(winner, status, { note = '', kind = null, goalDone = false, speak = null } = {}) {
   402	    try {
   403	      if (typeof onGoalReportback !== 'function' || !winner?.goalRef?.goalId) return null;
   404	      const title = winner.text?.match(/^推进目标「(.+?)」/)?.[1] || winner.title || 'Noe 任务';
   405	      const wantsSpeech = speak === null ? Boolean(goalDone || ['done', 'failed', 'blocked', 'awaiting_approval'].includes(status)) : speak;
   406	      return onGoalReportback({
   407	        goalId: winner.goalRef.goalId,
   408	        taskId: winner.goalRef.goalId,
   409	        title,
   410	        summary: compactText(note || winner.queryText || winner.text || '', 500),
   411	        status,
   412	        kind: kind || winner.kind || null,
   413	        stepIndex: winner.goalRef.stepIndex,
   414	        source: 'workspace',
   415	        speak: QUIET_SYSTEM_REPAIR_RE.test(title) ? false : wantsSpeech,
   416	      });
   417	    } catch { return null; }
   418	  }
   419
   420	  function autoCloseTerminalThinkStep(winner, t, tickId) {
   421	    try {
   422	      if (!winner || winner.source !== 'goal_step' || winner.kind !== 'think' || winner.actionSpec || !winner.goalRef) return false;
   423	      const stepIndex = Number(winner.goalRef.stepIndex);
   424	      if (!Number.isInteger(stepIndex) || stepIndex < 0) return false;
   425	      const goal = goalSystem?.get?.(winner.goalRef.goalId);
   426	      const plan = Array.isArray(goal?.plan) ? goal.plan : [];
   427	      const current = plan[stepIndex] || null;
   428	      if (!current || current.kind !== 'think' || current.status !== 'open') return false;
   429	      const others = plan.filter((_, idx) => idx !== stepIndex);
   430	      if (!others.length) return false;
   431	      const terminal = plan.every((s, idx) => idx === stepIndex || ['done', 'recovered'].includes(String(s.status || 'open')));
   432	      const hasEvidence = others.some((s) => ['done', 'recovered'].includes(String(s.status || 'open')) && String(s.note || '').trim());
   433	      if (!terminal || !hasEvidence || typeof goalSystem?.recordStepResult !== 'function') return false;
   434	      const completed = others.filter((s) => s.status === 'done').length;
   435	      const recovered = others.filter((s) => s.status === 'recovered').length;
   436	      const evidence = others
   437	        .filter((s) => ['done', 'recovered'].includes(String(s.status || 'open')) && String(s.note || '').trim())
   438	        .slice(-2)
   439	        .map((s) => `${String(s.step || '').slice(0, 40)}：${String(s.note || '').slice(0, 180)}`)
   440	        .join('；');
   441	      const note = `自动收口：前序已有 ${completed} 个完成证据、${recovered} 个恢复证据；最后复盘步确认目标链已落地。${evidence ? ` 最近证据：${evidence}` : ''}`.slice(0, 500);
   442	      const res = goalSystem.recordStepResult(winner.goalRef.goalId, stepIndex, { note, done: true });
   443	      journal(t, { tickId, kind: 'goal_progress', goalId: winner.goalRef.goalId, stepIndex, autoClosed: true });
   444	      emitGoalReportback(winner, 'done', { note, kind: 'think', goalDone: res?.goalDone === true, speak: true });
   445	      if (res?.goalDone && typeof onGoalDone === 'function') { try { onGoalDone(res.goal); } catch { /* 蒸馏失败不阻断 */ } }
   446	      return true;
   447	    } catch { return false; }
   448	  }
   449
   450	  /**

exec
/bin/zsh -lc "nl -ba src/cognition/NoeWorkspace.js | sed -n '586,620p'" in /Users/hxx/Desktop/Neo 贾维斯
 succeeded in 0ms:
   586	          if (winner.goalRef && d?.deliberated && goalSystem?.recordStepResult) {
   587	            const listLines = (d.text || '').match(/(?:^|\n)\s*[-•①②③④⑤\d][.、)）]?\s*(.{4,480})/g);
   588	            // [act:动作名] 标记 → act 步对象（深思自主声明"这一步要真动手"；GoalSystem 端 allowActKind 总闸再把一道门）
   589	            const newSteps = listLines ? listLines.map((s) => {
   590	              const text = s.replace(/^[\s\n]*[-•①②③④⑤\d][.、)）]?\s*/, '').trim();
   591	              return parseActStepLine(text);
   592	            }).slice(0, 8) : null;
   593	            const stepDone = /步骤完成|这一步完成|已完成这一步/.test(d.text || '');
   594	            const res = goalSystem.recordStepResult(winner.goalRef.goalId, winner.goalRef.stepIndex, {
   595	              note: (d.text || '').slice(0, 300),
   596	              done: stepDone,
   597	              ...(winner.goalRef.stepIndex === -1 && newSteps ? { newSteps } : {}),
   598	            });
   599	            journal(t, { tickId, kind: 'goal_progress', goalId: winner.goalRef.goalId, stepIndex: winner.goalRef.stepIndex });
   600	            if (stepDone || newSteps) emitGoalReportback(winner, res?.goalDone ? 'done' : 'running', { note: stepDone ? '思考步骤已完成，继续推进后续步骤。' : '已经拆出执行计划，继续推进。', kind: 'think', goalDone: res?.goalDone === true, speak: res?.goalDone === true });
   601	            if (res?.goalDone && typeof onGoalDone === 'function') { try { onGoalDone(res.goal); } catch { /* 蒸馏失败不阻断 */ } }
   602	          }
   603	          // M8 自动课程：深思自己立项（「目标：…」行）——想要的事落成持续行动
   604	          if (d?.goal && goalSystem?.add) {
   605	            const gid = goalSystem.add({ title: d.goal, source: 'reflection', why: `深思「${winner.text.slice(0, 60)}」时自己立的项` });
   606	            if (gid) {
   607	              journal(t, { tickId, kind: 'goal_created', goalId: gid, title: d.goal.slice(0, 80) });
   608	              try { recordEpisode?.({ type: 'observation', summary: `我给自己立了个目标：${d.goal.slice(0, 60)}`, salience: 4 }); } catch { /* 同上 */ }
   609	            }
   610	          }
   611	          if (d?.share && typeof sublimate === 'function') {
   612	            const gate = surfacingGate ? surfacingGate.tryPass({ text: d.share, salience: 0.8 }) : { pass: true, reason: 'no_gate' };
   613	            journal(t, { tickId, kind: 'surfacing', text: d.share.slice(0, 120), pass: gate.pass, reason: gate.reason });
   614	            if (gate.pass) sublimate(`想跟主人说：${d.share}`).catch(() => {});
   615	          }
   616	        })
   617	        .catch(() => { refundDeliberationBudget(t); }); // 深思 promise 异常 reject 也退还名额（防御：deliberate 内部已 fail-open，正常不到这）
   618	    }
   619
   620	    journal(t, {

exec
/bin/zsh -lc "nl -ba src/cognition/NoeGoalStepRecorder.js | sed -n '1,260p'" in /Users/hxx/Desktop/Neo 贾维斯
 succeeded in 0ms:
     1	// @ts-check
     2	// P7-G0: extracted goal-step recording state machine from NoeGoalSystem.
     3	import { appendGoalCheckpoint } from './NoeGoalCheckpoints.js';
     4
     5	const STEP_STATUSES = new Set(['open', 'doing', 'awaiting_approval', 'blocked', 'failed', 'recovered', 'done']);
     6	export const BLOCKING_STEP_STATUSES = new Set(['doing', 'awaiting_approval']);
     7
     8	export function normalizeGoalStepStatus(status, fallback = 'open') {
     9	  const s = String(status || '').trim();
    10	  return STEP_STATUSES.has(s) ? s : fallback;
    11	}
    12
    13	function phaseForStepUpdate({ stepIndex, done, doing, status, newSteps }) {
    14	  if (stepIndex === -1 && Array.isArray(newSteps) && newSteps.length) return 'plan_created';
    15	  const s = normalizeGoalStepStatus(status, '');
    16	  if (s === 'awaiting_approval') return 'approval_wait';
    17	  if (s === 'blocked') return 'step_blocked';
    18	  if (s === 'failed') return 'step_failed';
    19	  if (s === 'recovered') return 'step_recovered';
    20	  if (done) return 'step_done';
    21	  if (doing) return 'step_started';
    22	  return 'step_update';
    23	}
    24
    25	function normalizeNewSteps(newSteps, { allowActKind = false, now = Date.now } = {}) {
    26	  return newSteps.filter(Boolean).slice(0, 12).map((s) => {
    27	    const text = typeof s === 'object' ? String(s.step || '') : String(s);
    28	    // act 同 NoeGoalSystem.add()：只认显式对象声明；文本永不推断。
    29	    const kind = (typeof s === 'object' && s.kind === 'act' && allowActKind)
    30	      ? 'act'
    31	      : (typeof s === 'object' && s.kind === 'research') || /搜|查资料|研究|调研|search|research/i.test(text)
    32	        ? 'research'
    33	        : 'think';
    34	    return {
    35	      step: text.slice(0, 200),
    36	      kind,
    37	      status: 'open',
    38	      note: '',
    39	      updatedAt: now(),
    40	      ...(kind === 'act' && s.action ? { action: String(s.action).slice(0, 160) } : {}),
    41	      ...(kind === 'act' && s.payload && typeof s.payload === 'object' ? { payload: s.payload } : {}),
    42	    };
    43	  }).filter((s) => s.step);
    44	}
    45
    46	/**
    47	 * @returns {{ok: boolean, goalDone: boolean, goal?: object}}
    48	 */
    49	export function recordGoalStepResult({
    50	  getdb,
    51	  getGoal,
    52	  now = Date.now,
    53	  allowActKind = false,
    54	  goalId,
    55	  stepIndex,
    56	  input = {},
    57	} = {}) {
    58	  const { note = '', done = false, doing = false, status = null, newSteps = null } = input || {};
    59	  try {
    60	    const g = getGoal(goalId);
    61	    if (!g) return { ok: false, goalDone: false };
    62	    let plan = g.plan;
    63	    if (stepIndex === -1 && Array.isArray(newSteps) && newSteps.length) {
    64	      plan = normalizeNewSteps(newSteps, { allowActKind, now });
    65	    } else if (stepIndex >= 0 && stepIndex < plan.length) {
    66	      const currentStatus = normalizeGoalStepStatus(plan[stepIndex].status, 'open');
    67	      const nextStatus = status
    68	        ? normalizeGoalStepStatus(status, currentStatus)
    69	        : done ? 'done' : doing ? 'doing' : currentStatus === 'doing' && !doing ? 'open' : currentStatus;
    70	      plan[stepIndex] = {
    71	        ...plan[stepIndex],
    72	        note: note ? String(note).slice(0, 500) : plan[stepIndex].note,
    73	        status: nextStatus,
    74	        updatedAt: now(),
    75	      };
    76	    } else return { ok: false, goalDone: false };
    77	    const allDone = plan.length > 0 && plan.every((s) => ['done', 'recovered'].includes(s.status));
    78	    getdb().prepare('UPDATE noe_goals SET plan = ?, status = ?, updated_at = ? WHERE id = ?')
    79	      .run(JSON.stringify(plan), allDone ? 'done' : g.status, now(), goalId);
    80	    const phase = phaseForStepUpdate({ stepIndex, done, doing, status, newSteps });
    81	    const current = stepIndex >= 0 ? plan[stepIndex] : null;
    82	    appendGoalCheckpoint(getdb(), {
    83	      now,
    84	      goal: { ...g, plan, status: allDone ? 'done' : g.status },
    85	      goalId,
    86	      stepIndex,
    87	      phase,
    88	      status: current?.status || (allDone ? 'done' : g.status),
    89	      note,
    90	      payload: stepIndex === -1 && Array.isArray(newSteps) ? { newStepCount: plan.length } : null,
    91	      replaySafe: current?.kind !== 'act',
    92	    });
    93	    return { ok: true, goalDone: allDone, goal: allDone ? { ...g, plan, status: 'done' } : undefined };
    94	  } catch {
    95	    return { ok: false, goalDone: false };
    96	  }
    97	}

exec
/bin/zsh -lc "rg -n \"onGoalDone|createWorkspace\\(|stepExpectationBridge|createStepExpectationBridge|NoeStepExpectationBridge|goalDone|source='surprise'|source: 'surprise'\" server.js src/server src -g '*.js'" in /Users/hxx/Desktop/Neo 贾维斯
 succeeded in 0ms:
server.js:289:import { createStepExpectationBridge } from './src/cognition/NoeStepExpectationBridge.js';
server.js:1591:    noeWorkspace = createWorkspace({
server.js:1596:      ...(noeExpectationLedger && noeGoalSystem ? { stepExpectationBridge: createStepExpectationBridge({ expectationLedger: noeExpectationLedger, goalSystem: noeGoalSystem }) } : {}),
server.js:1650:      ...(noeGoalSystem ? { onGoalDone: distillSkill } : {}),                                 // M7 技能蒸馏
src/server/routes/noeMind.js:375:          goalDoneRate: gTotal ? Math.round((gDone / gTotal) * 100) / 100 : null,
src/server/routes/workspaces.js:37:      const meta = m.createWorkspace(name, { description });
src/cognition/NoeAwakeningSignals.js:67:  const surpriseGoals = hasGoals ? c("SELECT COUNT(*) n FROM noe_goals WHERE source='surprise' AND created_at >= ?", sinceTs) : 0;
src/cognition/NoeAwakeningSignals.js:68:  const surpriseGoalsDone = hasGoals ? c("SELECT COUNT(*) n FROM noe_goals WHERE source='surprise' AND status='done' AND created_at >= ?", sinceTs) : 0;
src/workspace/WorkspaceManager.js:67:export function createWorkspace(name, { description = '' } = {}) {
src/cognition/NoeWorkspace.js:156:export function createWorkspace({
src/cognition/NoeWorkspace.js:160:  stepExpectationBridge = null, // 阶段1：act/research step 真失败→登记预测→outcome=0→harvestSurprise（接通好奇回路供给端，NOE_STEP_EXPECTATION_RESOLVE）
src/cognition/NoeWorkspace.js:178:  onGoalDone = null,           // M7 技能蒸馏挂点：目标全完成时回调（成功经验→技能卡入记忆）
src/cognition/NoeWorkspace.js:401:  function emitGoalReportback(winner, status, { note = '', kind = null, goalDone = false, speak = null } = {}) {
src/cognition/NoeWorkspace.js:405:      const wantsSpeech = speak === null ? Boolean(goalDone || ['done', 'failed', 'blocked', 'awaiting_approval'].includes(status)) : speak;
src/cognition/NoeWorkspace.js:444:      emitGoalReportback(winner, 'done', { note, kind: 'think', goalDone: res?.goalDone === true, speak: true });
src/cognition/NoeWorkspace.js:445:      if (res?.goalDone && typeof onGoalDone === 'function') { try { onGoalDone(res.goal); } catch { /* 蒸馏失败不阻断 */ } }
src/cognition/NoeWorkspace.js:498:          emitGoalReportback(winner, res?.goalDone ? 'done' : 'running', { note: summary || '研究完成（未产出报告），继续下一步。', kind: 'research', goalDone: res?.goalDone === true, speak: res?.goalDone === true });
src/cognition/NoeWorkspace.js:501:          if (res?.goalDone && typeof onGoalDone === 'function') { try { onGoalDone(res.goal); } catch { /* 蒸馏失败不阻断 */ } }
src/cognition/NoeWorkspace.js:511:            try { stepExpectationBridge?.onStepFailed?.({ stepText: winner.stepText || winner.queryText || winner.text, kind: 'research', terminal: 'failed' }); } catch { /* 桥失败不阻断主流程 */ }
src/cognition/NoeWorkspace.js:541:          emitGoalReportback(winner, approval ? 'awaiting_approval' : acted ? (res?.goalDone ? 'done' : 'running') : 'blocked', { note, kind: 'act', goalDone: res?.goalDone === true, speak: approval || !acted || res?.goalDone === true });
src/cognition/NoeWorkspace.js:545:            try { stepExpectationBridge?.onStepFailed?.({ stepText: winner.stepText || winner.queryText || winner.text, kind: 'act', terminal: 'blocked' }); } catch { /* 桥失败不阻断主流程 */ }
src/cognition/NoeWorkspace.js:549:          if (res?.goalDone && typeof onGoalDone === 'function') { try { onGoalDone(res.goal); } catch { /* 蒸馏失败不阻断 */ } }
src/cognition/NoeWorkspace.js:560:            try { stepExpectationBridge?.onStepFailed?.({ stepText: winner.stepText || winner.queryText || winner.text, kind: 'act', terminal: 'failed' }); } catch { /* 桥失败不阻断主流程 */ }
src/cognition/NoeWorkspace.js:600:            if (stepDone || newSteps) emitGoalReportback(winner, res?.goalDone ? 'done' : 'running', { note: stepDone ? '思考步骤已完成，继续推进后续步骤。' : '已经拆出执行计划，继续推进。', kind: 'think', goalDone: res?.goalDone === true, speak: res?.goalDone === true });
src/cognition/NoeWorkspace.js:601:            if (res?.goalDone && typeof onGoalDone === 'function') { try { onGoalDone(res.goal); } catch { /* 蒸馏失败不阻断 */ } }
src/cognition/NoeGoalStepRecorder.js:47: * @returns {{ok: boolean, goalDone: boolean, goal?: object}}
src/cognition/NoeGoalStepRecorder.js:61:    if (!g) return { ok: false, goalDone: false };
src/cognition/NoeGoalStepRecorder.js:76:    } else return { ok: false, goalDone: false };
src/cognition/NoeGoalStepRecorder.js:93:    return { ok: true, goalDone: allDone, goal: allDone ? { ...g, plan, status: 'done' } : undefined };
src/cognition/NoeGoalStepRecorder.js:95:    return { ok: false, goalDone: false };
src/cognition/NoeStepExpectationBridge.js:2:// NoeStepExpectationBridge — 阶段1：修活好奇回路供给端（治 R5/R5b，多模型研究 DB 实证的最深根因）。
src/cognition/NoeStepExpectationBridge.js:4:// 根因（Claude+M3 研究，panel.db 实测）：source='surprise' 好奇目标恒为 0、outcome=0 落空恒为 0、
src/cognition/NoeStepExpectationBridge.js:28:export function createStepExpectationBridge({
src/cognition/NoeGoalSystem.js:539:   * @returns {{ok: boolean, goalDone: boolean, goal?: object}} goalDone=true 时调用方可做技能蒸馏（M7）
src/cognition/NoeGoalSystem.js:580:        ? { title, source: 'surprise', why: baseWhy, steps, meta: { origin: safeOrigin } }
src/cognition/NoeGoalSystem.js:581:        : { title, source: 'surprise', why: baseWhy, steps });
src/cognition/NoeGoalSystem.js:605:    return add({ title, source: 'surprise', why, steps, meta });
src/cognition/NoeApprovalGoalResolver.js:88:  let goalDone = false;
src/cognition/NoeApprovalGoalResolver.js:113:      goalDone = res?.goalDone === true;
src/cognition/NoeApprovalGoalResolver.js:117:  return { goalUpdated, goalDone, goalRef };
src/server/routes/workspaces.js:37:      const meta = m.createWorkspace(name, { description });
src/server/routes/noeMind.js:375:          goalDoneRate: gTotal ? Math.round((gDone / gTotal) * 100) / 100 : null,

exec
/bin/zsh -lc "nl -ba server.js | sed -n '1560,1660p'" in /Users/hxx/Desktop/Neo 贾维斯
 succeeded in 0ms:
  1560	          sourceEpisodeId = String(noeEpisodicTimeline.record({ type: 'milestone', summary: `我做成了「${goal.title.slice(0, 50)}」，把经验记成了技能卡`, salience: 4 }) || '').slice(0, 240) || null;
  1561	        } catch { /* 情景留痕失败不阻断技能候选门禁 */ }
  1562	        // 阶段0 止血：commit 前查近 50 张 skill_distill 卡，与新卡 textSimilarity>0.9 则跳过（治 R6 同质卡堆积，DB 实测 346 死卡 hit_count 全 0）。
  1563	        try {
  1564	          const recentSkills = getDb().prepare("SELECT body FROM noe_memory WHERE source_type='skill_distill' ORDER BY created_at DESC LIMIT 50").all();
  1565	          if (recentSkills.some((s) => dedupTextSimilarity(card, String(s.body || '')) > 0.9)) {
  1566	            console.log('[noe-skill] ⏭ 技能卡与近期高度同质（>0.9）跳过入库：', goal.title.slice(0, 40));
  1567	            return;
  1568	          }
  1569	        } catch { /* 去重查询失败不阻断入库 */ }
  1570	        noeMemoryWriteGate.commit({
  1571	          kind: 'skill',
  1572	          projectId: 'noe',
  1573	          scope: 'project',
  1574	          title: `技能：${goal.title.slice(0, 60)}`,
  1575	          body: card,
  1576	          sourceType: 'skill_distill',
  1577	          tags: ['skill'],
  1578	          salience: 4,
  1579	          confidence: 0.8,
  1580	          sourceEpisodeId,
  1581	          evidenceRefs: [sourceEpisodeId ? `episode:${sourceEpisodeId}` : '', goal?.id ? `goal:${goal.id}` : `goal_title:${String(goal.title).slice(0, 80)}`].filter(Boolean),
  1582	        });
  1583	        console.log('[noe-skill] 🛠 技能卡入库：', goal.title.slice(0, 50));
  1584	      } catch { /* 蒸馏失败不阻断 */ }
  1585	    };
  1586	    const noeSurfacingGate = createSurfacingGate({
  1587	      kv: { get: kvGet, set: kvSet },
  1588	      quietCheck: process.env.NOE_CIRCADIAN === '1' ? circadianIsQuiet : null,
  1589	      textSimilarity: dedupTextSimilarity,
  1590	    });
  1591	    noeWorkspace = createWorkspace({
  1592	      timeline: noeEpisodicTimeline,
  1593	      commitmentStore: noeCommitmentStore,
  1594	      ...(noeExpectationLedger ? { expectationLedger: noeExpectationLedger } : {}),
  1595	      // 阶段1：act/research step 真失败 → 登记预测→outcome=0→harvestSurprise，接通好奇回路供给端（NOE_STEP_EXPECTATION_RESOLVE 默认 OFF）
  1596	      ...(noeExpectationLedger && noeGoalSystem ? { stepExpectationBridge: createStepExpectationBridge({ expectationLedger: noeExpectationLedger, goalSystem: noeGoalSystem }) } : {}),
  1597	      ...(noeDriveSystem ? { driveBrief: noeDriveSystem.brief } : {}),
  1598	      ...(noeRouteHandles?.peekVision ? { peekVision: noeRouteHandles.peekVision } : {}),
  1599	      systemStateProvider: () => getCachedHostContextBlock(), // M3：本机感知三件套进候选（低权背景源）
  1600	      ...(noeAffectEngine ? { affectProbe: () => noeAffectEngine.snapshot() } : {}),
  1601	      textSimilarity: dedupTextSimilarity,
  1602	      deliberate: noeDeliberate,
  1603	      surfacingGate: noeSurfacingGate,
  1604	      ...(thoughtSublimate ? { sublimate: thoughtSublimate } : {}),
  1605	      ...(noeGoalSystem ? { goalSystem: noeGoalSystem } : {}),
  1606	      recordEpisode: (e) => { try { noeEpisodicTimeline.record(e); } catch { /* 留痕失败不阻断 */ } }, // 自己做的事成为经历
  1607	      ...(noeRouteHandles?.runResearch ? { runResearch: noeRouteHandles.runResearch } : {}), // M6 的"手"
  1608	      ...(noeIncidentEscalator ? { incidentEscalator: noeIncidentEscalator } : {}),
  1609	      activityLog,
  1610	      onGoalReportback: (event) => {
  1611	        const added = noeTaskReportbacks.add(event);
  1612	        if (['failed', 'blocked'].includes(String(event?.status || ''))) {
  1613	          try { noeIncidentEscalator?.observe?.({ source: 'task_reportback', status: event.status, text: `${event.title || ''} ${event.summary || ''}`, goalId: event.goalId, stepIndex: event.stepIndex }); } catch { /* 回报故障升级失败不阻断原回报 */ }
  1614	        }
  1615	        return added;
  1616	      },
  1617	      // 行动的"手"（意识工程 Phase3，NOE_GOAL_ACT=1 数据层同门控）：act 步交 ActPipeline 完整执行链——
  1618	      // owner 顶层授权下真实执行优先；无注册 executor 的动作产 dry-run 证据，审计记录事实、证据和回滚线索。
  1619	      ...(process.env.NOE_GOAL_ACT === '1' ? {
  1620	        runAct: async ({ text, goalRef, actionSpec, goalTitle, goal, checkpoint, step }) => {
  1621	          const action = actionSpec?.action || 'noe.goal.step.act';
  1622	          const inferredPayload = {};
  1623	          if (['browser.open', 'browser.open_url', 'noe.browser.open_url'].includes(action)) {
  1624	            const m = String(text || '').match(/https?:\/\/[^\s"'<>，。；）)\]]+/i);
  1625	            if (m) inferredPayload.url = m[0];
  1626	          }
  1627	          const semanticGoal = String(goalTitle || goal || '').replace(/\s+/g, ' ').trim().slice(0, 240);
  1628	          const semanticStep = String(step || checkpoint || text || '').replace(/\s+/g, ' ').trim().slice(0, 240);
  1629	          const actionPayload = actionSpec?.payload && typeof actionSpec.payload === 'object' ? actionSpec.payload : {};
  1630	          return noeActPipeline.propose({
  1631	            title: `目标行动：${String(text || '').slice(0, 140)}`,
  1632	            action,
  1633	            ...(semanticGoal ? { goal: semanticGoal, goalTitle: semanticGoal } : {}),
  1634	            ...(semanticStep ? { checkpoint: semanticStep, step: semanticStep } : {}),
  1635	            payload: {
  1636	              ...inferredPayload,
  1637	              ...(semanticGoal ? { goal: semanticGoal, goalTitle: semanticGoal } : {}),
  1638	              ...(semanticStep ? { checkpoint: semanticStep, step: semanticStep } : {}),
  1639	              ...actionPayload,
  1640	              source: 'goal_step_act',
  1641	              goalId: goalRef?.goalId || null,
  1642	              stepIndex: goalRef?.stepIndex ?? null,
  1643	              stepText: semanticStep || String(text || '').slice(0, 200),
  1644	            },
  1645	            realExecute: true,
  1646	            proposedBy: 'noe-workspace-goal',
  1647	          });
  1648	        },
  1649	      } : {}),
  1650	      ...(noeGoalSystem ? { onGoalDone: distillSkill } : {}),                                 // M7 技能蒸馏
  1651	      insightProvider: () => noeFreshInsight,                                                 // M9 晨间洞察源
  1652	      kv: { get: kvGet, set: kvSet },
  1653	      appendJournal: appendConsciousnessJournal,
  1654	      // S0.3 思维回环守卫（NOE_THOUGHT_LOOP_GUARD=1 默认 OFF）：OFF 连参数都不注入→loopGuardGate=null→整段跳过逐字零回归。
  1655	      ...(process.env.NOE_THOUGHT_LOOP_GUARD === '1' ? { loopGuardGate: { enabled: true } } : {}),
  1656	      // GWT 语义 novelty（HANDOFF rank4，NOE_GWT_SEMANTIC_NOVELTY=1 默认 OFF）：OFF 连 semanticEmbedder 都不注入
  1657	      //   → 工作区 semanticOn=false → novelty 逐字走原字符相似度（零回归）。ON 才注入 qwen3-embedding（与 MindVitals/
  1658	      //   熵温度同款解包 .vector）；ollama 不可用时 EmbeddingProvider 回 hash-fallback 不入语义缓存 → 自动退字符相似度。
  1659	      ...(process.env.NOE_GWT_SEMANTIC_NOVELTY === '1' ? {
  1660	        semanticEmbedder: async (t) => {

exec
/bin/zsh -lc "nl -ba src/cognition/NoeOwnerBehaviorPredictor.js | sed -n '130,185p'" in /Users/hxx/Desktop/Neo 贾维斯
 succeeded in 0ms:
   130	    } catch { return []; }
   131	  }
   132
   133	  /**
   134	   * 结算阶段：用「这条新 owner 交互文本」去命中开放的 owner_pred 预测。
   135	   * - topic 预测：新文本含同一主题 token → 应验（owner 真又提到了）。
   136	   * - followup 预测：新文本命中 FOLLOWUP_SETTLE_RE → 应验；命中 FOLLOWUP_FAIL_RE → 落空。
   137	   * 不命中就留账（交给 7 天 sweep / 人工裁决），绝不因沉默或换话题强判 0。
   138	   * @returns {{resolved: number, ids: number[]}}
   139	   */
   140	  function settleFromOwnerText(text) {
   141	    if (!ready()) return { resolved: 0, ids: [] };
   142	    const raw = String(text || '');
   143	    if (!raw.trim()) return { resolved: 0, ids: [] };
   144	    const t = now();
   145	    const opens = openOwnerPredictions();
   146	    if (!opens.length) return { resolved: 0, ids: [] };
   147	    const followupHit = FOLLOWUP_SETTLE_RE.test(raw);
   148	    const followupFail = FOLLOWUP_FAIL_RE.test(raw);
   149	    const lower = raw.toLowerCase();
   150	    const ids = [];
   151	    for (const row of opens) {
   152	      const claim = String(row.claim || '');
   153	      let hit = false;
   154	      let outcome = 1;
   155	      const tm = claim.match(/\[owner-pred:topic:([^\]]+)\]/);
   156	      if (tm && tm[1]) {
   157	        const subj = tm[1];
   158	        hit = /[A-Za-z]/.test(subj) ? lower.includes(subj.toLowerCase()) : raw.includes(subj);
   159	      } else if (claim.includes(FOLLOWUP_TOKEN)) {
   160	        // 明确取消/不用测试一类文本里常同时含「测试」，失败优先，避免误判为兑现 followup。
   161	        hit = followupFail || followupHit;
   162	        outcome = followupFail ? 0 : 1;
   163	      }
   164	      if (!hit) continue;
   165	      try {
   166	        const resolvedRow = ledger.resolve(row.id, outcome, t);
   167	        if (resolvedRow) {
   168	          ids.push(Number(row.id));
   169	          if (outcome === 0 && goalSystem && typeof goalSystem.harvestSurprise === 'function') {
   170	            try { goalSystem.harvestSurprise({ claim: row.claim, surprise: resolvedRow.surprise, origin: 'owner_prediction' }); } // P1-C：owner 明确否定 followup = owner 真实负反馈（门 b 非噪声）
   171	            catch { /* 好奇立项失败不阻断 owner 预测结算 */ }
   172	          }
   173	        }
   174	      } catch { /* 单条结算失败不阻断其余 */ }
   175	    }
   176	    return { resolved: ids.length, ids };
   177	  }
   178
   179	  /**
   180	   * 预测阶段：从这条 owner 交互立 owner-behavior 预测（topic + followup）。
   181	   * 重复主题由 ledger.add 的相似度去重兜底（同主题已有开放预测则返回 null，不重复入账）。
   182	   * @returns {{predicted: number, ids: number[]}}
   183	   */
   184	  function predictFromOwnerText(text, { isDelegation = null } = {}) {
   185	    if (!ready()) return { predicted: 0, ids: [] };

exec
/bin/zsh -lc "rg -n \"function distillSkill|const distillSkill|distillSkill =|createSkill|skill\" server.js src/cognition src/memory -g '*.js'" in /Users/hxx/Desktop/Neo 贾维斯
 succeeded in 0ms:
server.js:131:// S18-2f：skills routes 提取
server.js:132:import { registerSkillsRoutes } from './src/server/routes/skills.js';
server.js:227:import { registerSkillExtractRoutes } from './src/server/routes/skillExtract.js';
server.js:232:import { skillStore } from './src/skills/SkillStore.js';
server.js:233:import { createAutoSkillExtractor } from './src/skills/AutoSkillExtractor.js';
server.js:760:registerAgentRegistryRoutes(app, { skillStore, safeResolveFsPath });
server.js:836:  // Odysseus 移植收尾 T3.1：房间完成后异步提炼可复用 skill draft；只用本地 adapter，不阻塞房间广播。
server.js:1288:  store: skillStore,
server.js:1541:    // M7 技能蒸馏：目标全完成 → 本地小脑压一张"下次怎么做"技能卡入记忆（scope=skill 风格 tags）
server.js:1542:    const distillSkill = async (goal) => {
server.js:1553:        ], { budgetContext: { projectId: 'noe', taskId: 'noe-skill-distill' }, think: false, model: noeAutoBrainModel });
server.js:1557:        if (/^SKIP\b/i.test(card) || /^["「]?SKIP["」]?$/i.test(card.trim())) { console.log('[noe-skill] ⏭ 这次没读到具体新知识，跳过蒸馏：', goal.title.slice(0, 40)); return; }
server.js:1562:        // 阶段0 止血：commit 前查近 50 张 skill_distill 卡，与新卡 textSimilarity>0.9 则跳过（治 R6 同质卡堆积，DB 实测 346 死卡 hit_count 全 0）。
server.js:1564:          const recentSkills = getDb().prepare("SELECT body FROM noe_memory WHERE source_type='skill_distill' ORDER BY created_at DESC LIMIT 50").all();
server.js:1566:            console.log('[noe-skill] ⏭ 技能卡与近期高度同质（>0.9）跳过入库：', goal.title.slice(0, 40));
server.js:1571:          kind: 'skill',
server.js:1576:          sourceType: 'skill_distill',
server.js:1577:          tags: ['skill'],
server.js:1583:        console.log('[noe-skill] 🛠 技能卡入库：', goal.title.slice(0, 50));
server.js:2396:  roomWsClients, skillStore, MAX_ROOMS,
server.js:2524:registerSkillsRoutes(app, { skillStore });
src/memory/NoeMemoryExtractor.js:10:  + '{"kind":"fact|preference|skill|insight","body":"第三人称或第一人称的短句","confidence":0.35-0.95,'
src/memory/NoeMemoryCandidateSchema.js:10:  skill: 'project',
src/memory/NoeMemoryCandidateSchema.js:132:  return ['fact', 'preference', 'identity', 'skill', 'insight'].includes(String(candidate.kind || ''));
src/memory/NoeMemoryCandidateSchema.js:145:  if (tags.includes('skill') || tags.includes('incident') || candidate.kind === 'skill') return false;
src/memory/NoeMemoryRecallBenchmark.js:15:    kind: 'skill',
src/memory/NoeMemoryContextFormatter.js:23:    const tag = m.scope === 'project' ? 'skill' : m.scope === 'insight' ? 'insight' : 'fact';
src/cognition/NoeLearningTopics.js:45:    localPaths: ['src/skills', 'src/runtime', 'src/mcp', 'src/server/routes', 'scripts', 'docs', 'tests/unit'],
src/cognition/NoeLearningTopics.js:56:  if (/能力|工具|插件|技能|接入|mcp|capability|tool|plugin|skill/i.test(s)) return topics[5] || learningTopicAtCursor(5, topics);
src/memory/NoeMemoryStatus.js:195:    skillDistill: { enabled: true, lastAt: last.skill_distill || null },
src/memory/NoeMemoryRetrievalSample.js:8:  { id: 'skill_distill', q: 'skill_distill', routeType: 'mission' },

exec
/bin/zsh -lc "nl -ba src/cognition/NoeExpectationResolver.js | sed -n '1570,1610p'" in /Users/hxx/Desktop/Neo 贾维斯
 succeeded in 0ms:
  1570	    if (!ledger?.due || !ledger?.resolve) return { checked: 0, resolved: 0 };
  1571	    let due = [];
  1572	    try { due = ledger.due(t) || []; } catch { due = []; }
  1573	    if (!due.length) return { checked: 0, resolved: 0 };
  1574	    const limit = Math.max(1, Number(maxPerTick) || 1);
  1575	    const selection = selectDueForFairness(due, t, limit);
  1576	    if (!selection.selected.length) {
  1577	      return {
  1578	        checked: 0,
  1579	        resolved: 0,
  1580	        judged: [],
  1581	        reason: selection.cooldownOnly ? 'cooldown' : 'no_ready_due',
  1582	        cooldownOnly: selection.cooldownOnly,
  1583	        cooldownCount: selection.cooldownCount,
  1584	        ...(selection.nextReadyAt ? { nextReadyAt: selection.nextReadyAt } : {}),
  1585	      };
  1586	    }
  1587	    const judged = [];
  1588	    let resolved = 0;
  1589	    for (const exp of selection.selected) {
  1590	      const v = await judgeOne(exp);
  1591	      if (v.outcome === 1 || v.outcome === 0) {
  1592	        try {
  1593	          const resolvedRow = ledger.resolve(exp.id, v.outcome, t);
  1594	          if (resolvedRow) {
  1595	            resolved += 1;
  1596	            // rank4 好奇回路：预测落空(outcome=0)且惊奇≥阈值 → 自动立「搞明白为什么没料到」研究目标。
  1597	            // 「被现实硬纠正后主动学习」的发动机；此前自动判证路径从不接 harvestSurprise（source=surprise 恒为 0）。
  1598	            if (v.outcome === 0 && goalSystem && typeof goalSystem.harvestSurprise === 'function') {
  1599	              try { goalSystem.harvestSurprise({ claim: exp.claim, surprise: resolvedRow.surprise, origin: deriveSurpriseOrigin(exp.source, { loosenOnly: v.loosenOnly }) }); } // P1-C 整改 F1+F2：据 source 推导 origin + loosen_fail 噪声分桶
  1600	              catch { /* 好奇立项失败不阻断判证 */ }
  1601	            }
  1602	          }
  1603	        } catch { /* 单条失败不阻断本跳 */ }
  1604	      }
  1605	      rememberJudgement(exp, v.outcome, t);
  1606	      judged.push({
  1607	        id: exp.id,
  1608	        outcome: v.outcome,
  1609	        reason: v.reason,
  1610	        ...(v.evidenceStats ? { evidenceStats: sanitizeEvidenceStats(v.evidenceStats) } : {}),

exec
/bin/zsh -lc "nl -ba server.js | sed -n '1536,1586p'" in /Users/hxx/Desktop/Neo 贾维斯
 succeeded in 0ms:
  1536	      ...(noeExpectationLedger ? { ledger: noeExpectationLedger } : {}),
  1537	      memory: noeMemoryCore, // M7/CoALA 检索动作：深思前自动召回相关记忆与技能卡
  1538	      selfModel: noeSelfModel,
  1539	      ...(noeBudgetForcedThink ? { budgetForcedThink: noeBudgetForcedThink } : {}),
  1540	    });
  1541	    // M7 技能蒸馏：目标全完成 → 本地小脑压一张"下次怎么做"技能卡入记忆（scope=skill 风格 tags）
  1542	    const distillSkill = async (goal) => {
  1543	      try {
  1544	        if (!goal?.title) return;
  1545	        const adapter = roomAdapterPool.get(process.env.NOE_INNER_BRAIN || 'lmstudio');
  1546	        if (!adapter?.chat) return;
  1547	        // 阶段2A：蒸馏输入从「模板 step+note80字」换成「含真页面正文的完整笔记 400字」（治 R7 同质方法论套话）。
  1548	        //   note 里已由 summarizeActOutput 摘入 read_body 页面正文；放宽截断让真知识进蒸馏。
  1549	        const stepsText = (goal.plan || []).map((s, i) => `${i + 1}. ${s.step}${s.note ? `（${String(s.note).slice(0, 400)}）` : ''}`).join('\n');
  1550	        const r = await adapter.chat([
  1551	          { role: 'system', content: '把这次真正读到/学到的具体知识压缩成一张「技能卡」：记下具体的库名、API、配置键、概念、做法。第一人称，三五句，必须含至少一个具体名词（库/工具/API/概念/数字）。绝不要写「先搜索→再读→再扫描」这类空泛方法论套话。如果这次没读到任何具体新知识（只是打开页面没实质内容），只输出一个词 SKIP。只输出卡片内容，不要解释。' },
  1552	          { role: 'user', content: `目标：${goal.title}\n步骤与读到的内容：\n${stepsText}`.slice(0, 2400) },
  1553	        ], { budgetContext: { projectId: 'noe', taskId: 'noe-skill-distill' }, think: false, model: noeAutoBrainModel });
  1554	        const card = String(r?.reply || '').replace(/<think>[\s\S]*?<\/think>/gi, '').replace(/<\/?think>/gi, '').trim().slice(0, 500);
  1555	        if (card.length < 10) return;
  1556	        // 阶段2A：本地脑判定「这次没读到具体知识」→ 不入库空卡（治同质方法论堆积）。
  1557	        if (/^SKIP\b/i.test(card) || /^["「]?SKIP["」]?$/i.test(card.trim())) { console.log('[noe-skill] ⏭ 这次没读到具体新知识，跳过蒸馏：', goal.title.slice(0, 40)); return; }
  1558	        let sourceEpisodeId = null;
  1559	        try {
  1560	          sourceEpisodeId = String(noeEpisodicTimeline.record({ type: 'milestone', summary: `我做成了「${goal.title.slice(0, 50)}」，把经验记成了技能卡`, salience: 4 }) || '').slice(0, 240) || null;
  1561	        } catch { /* 情景留痕失败不阻断技能候选门禁 */ }
  1562	        // 阶段0 止血：commit 前查近 50 张 skill_distill 卡，与新卡 textSimilarity>0.9 则跳过（治 R6 同质卡堆积，DB 实测 346 死卡 hit_count 全 0）。
  1563	        try {
  1564	          const recentSkills = getDb().prepare("SELECT body FROM noe_memory WHERE source_type='skill_distill' ORDER BY created_at DESC LIMIT 50").all();
  1565	          if (recentSkills.some((s) => dedupTextSimilarity(card, String(s.body || '')) > 0.9)) {
  1566	            console.log('[noe-skill] ⏭ 技能卡与近期高度同质（>0.9）跳过入库：', goal.title.slice(0, 40));
  1567	            return;
  1568	          }
  1569	        } catch { /* 去重查询失败不阻断入库 */ }
  1570	        noeMemoryWriteGate.commit({
  1571	          kind: 'skill',
  1572	          projectId: 'noe',
  1573	          scope: 'project',
  1574	          title: `技能：${goal.title.slice(0, 60)}`,
  1575	          body: card,
  1576	          sourceType: 'skill_distill',
  1577	          tags: ['skill'],
  1578	          salience: 4,
  1579	          confidence: 0.8,
  1580	          sourceEpisodeId,
  1581	          evidenceRefs: [sourceEpisodeId ? `episode:${sourceEpisodeId}` : '', goal?.id ? `goal:${goal.id}` : `goal_title:${String(goal.title).slice(0, 80)}`].filter(Boolean),
  1582	        });
  1583	        console.log('[noe-skill] 🛠 技能卡入库：', goal.title.slice(0, 50));
  1584	      } catch { /* 蒸馏失败不阻断 */ }
  1585	    };
  1586	    const noeSurfacingGate = createSurfacingGate({

exec
/bin/zsh -lc "nl -ba src/cognition/NoeGoalSystem.js | sed -n '212,380p'" in /Users/hxx/Desktop/Neo 贾维斯
 succeeded in 0ms:
   212	  function stepOutputFromGoal(g, idx) {
   213	    const st = g.plan[idx];
   214	    const priorNotes = g.plan.slice(0, idx)
   215	      .filter((s) => s.note)
   216	      .slice(-3)
   217	      .map((s) => `${String(s.step || '').slice(0, 60)}：${String(s.note || '').slice(0, 220)}`);
   218	    return {
   219	      goalId: g.id,
   220	      title: g.title,
   221	      stepIndex: idx,
   222	      step: st.step,
   223	      kind: st.kind || 'think',
   224	      priority: g.priority,
   225	      ...(priorNotes.length ? { priorNotes } : {}),
   226	      ...(st.kind === 'act' ? { actionSpec: { action: st.action || null, payload: st.payload || null } } : {}),
   227	    };
   228	  }
   229
   230	  function bootstrapEmptyGoalPlan(g) {
   231	    const newSteps = buildEmptyAutonomyGoalPlan(g) || buildGenericEmptyGoalPlan(g);
   232	    if (!newSteps?.length) return null;
   233	    const isAutonomyPlan = newSteps.some((s) => s?.kind === 'act' || s?.kind === 'research');
   234	    const res = recordStepResult(g.id, -1, {
   235	      note: isAutonomyPlan
   236	        ? '空计划自主目标自动拆解：避免长期停在“想清楚第一步”，直接长出 research/browser/shell/note/think 行动链。'
   237	        : '空计划目标自动拆解：避免长期停在“想清楚第一步”，先长出保守 think 计划。',
   238	      newSteps,
   239	    });
   240	    if (!res.ok) return null;
   241	    return get(g.id);
   242	  }
   243
   244	  /**
   245	   * 立一个目标。steps 元素可为字符串（默认 kind=think）或 {step, kind}；
   246	   * kind: 'think'（深思推进）| 'research'（真上网研究——M6 的"手"）。
   247	   * @returns {string|null} goalId
   248	   */
   249	  function add({ title, source = 'self', why = '', steps = [], budget = null, meta = null } = {}) {
   250	    const t = String(title || '').trim().slice(0, 200);
   251	    if (!t) return null;
   252	    try {
   253	      // 同名未关目标去重（防好奇回路重复立项）
   254	      const dup = getdb().prepare("SELECT id FROM noe_goals WHERE title = ? AND status IN ('open','active')").get(t);
   255	      if (dup) return null;
   256	      // 防立项上瘾（实机教训）：自生目标在积压达上限后不再收；owner 交办永远收
   257	      if (!BACKLOG_EXEMPT_SOURCES.has(source)) {
   258	        const cnt = getdb().prepare("SELECT COUNT(*) n FROM noe_goals WHERE status IN ('open','active')").get();
   259	        if ((cnt?.n || 0) >= maxBacklog) return null;
   260	      }
   261	      const id = randomUUID();
   262	      const plan = (Array.isArray(steps) ? steps : []).filter(Boolean).slice(0, 12)
   263	        .map((s) => {
   264	          if (s && typeof s === 'object') {
   265	            const kind = s.kind === 'research' ? 'research' : (s.kind === 'act' && allowActKind) ? 'act' : 'think';
   266	            return {
   267	              step: String(s.step || '').slice(0, 200),
   268	              kind,
   269	              status: 'open',
   270	              note: '',
   271	              updatedAt: now(),
   272	              // act 步可带 ActPipeline 动作规格（action 名 + payload）；无规格的 act 步由装配方给默认动作
   273	              ...(kind === 'act' && s.action ? { action: String(s.action).slice(0, 160) } : {}),
   274	              ...(kind === 'act' && s.payload && typeof s.payload === 'object' ? { payload: s.payload } : {}),
   275	            };
   276	          }
   277	          return { step: String(s).slice(0, 200), kind: /搜|查资料|研究|调研|search|research/i.test(String(s)) ? 'research' : 'think', status: 'open', note: '', updatedAt: now() };
   278	        })
   279	        .filter((s) => s.step);
   280	      // meta：可解释元信息（如 meta.curiosity）。仅 object 时序列化，否则存 NULL（OFF 路径不传 → 列保持 NULL，零回归）。
   281	      let metaJson = null;
   282	      if (meta && typeof meta === 'object' && !Array.isArray(meta)) {
   283	        try { metaJson = JSON.stringify(meta); } catch { metaJson = null; }
   284	      }
   285	      getdb().prepare('INSERT INTO noe_goals(id, created_at, source, title, why, priority, status, plan, budget, updated_at, meta) VALUES (?,?,?,?,?,?,?,?,?,?,?)')
   286	        .run(id, now(), String(source).slice(0, 30), t, String(why || '').slice(0, 500), 0, 'open', JSON.stringify(plan), budget ? JSON.stringify(budget) : null, now(), metaJson);
   287	      appendGoalCheckpoint(getdb(), { now, goalId: id, stepIndex: -1, phase: 'goal_created', status: 'open', step: t, note: why, payload: { source, stepCount: plan.length }, replaySafe: true });
   288	      return id;
   289	    } catch { return null; }
   290	  }
   291
   292	  function get(id) {
   293	    try { return rowOut(getdb().prepare('SELECT * FROM noe_goals WHERE id = ?').get(id)); } catch { return null; }
   294	  }
   295
   296	  function list({ status = null, limit = 100 } = {}) {
   297	    try {
   298	      const lim = Math.max(1, Math.min(500, limit));
   299	      const rows = status
   300	        ? getdb().prepare('SELECT * FROM noe_goals WHERE status = ? ORDER BY priority DESC, updated_at DESC LIMIT ?').all(status, lim)
   301	        : getdb().prepare('SELECT * FROM noe_goals ORDER BY priority DESC, updated_at DESC LIMIT ?').all(lim);
   302	      return rows.map(rowOut);
   303	    } catch { return []; }
   304	  }
   305
   306	  // P1-C 整改 F3：surprise 来源运行时分桶（验收门 b 消费端）——区分 owner+action 非噪声 vs loosen_fail/expectation_miss 等噪声。
   307	  function surpriseOriginBreakdown({ limit = 500 } = {}) {
   308	    try {
   309	      const lim = Math.max(1, Math.min(2000, limit));
   310	      const rows = getdb().prepare("SELECT meta FROM noe_goals WHERE source = 'surprise' ORDER BY created_at DESC LIMIT ?").all(lim);
   311	      const byOrigin = {};
   312	      let nonNoise = 0;
   313	      const isNonNoise = (o) => /^owner_|^action_failure$/.test(String(o || ''));
   314	      for (const r of rows) {
   315	        const origin = parseMeta(r.meta)?.origin || 'unspecified';
   316	        byOrigin[origin] = (byOrigin[origin] || 0) + 1;
   317	        if (isNonNoise(origin)) nonNoise += 1;
   318	      }
   319	      return { total: rows.length, nonNoise, noise: rows.length - nonNoise, byOrigin };
   320	    } catch { return { total: 0, nonNoise: 0, noise: 0, byOrigin: {} }; }
   321	  }
   322
   323	  function setStatus(id, status) {
   324	    if (!['open', 'active', 'paused', 'done', 'dropped'].includes(status)) return false;
   325	    try { return getdb().prepare('UPDATE noe_goals SET status = ?, updated_at = ? WHERE id = ?').run(status, now(), id).changes > 0; } catch { return false; }
   326	  }
   327
   328	  function latestGoalBySource(source) {
   329	    try {
   330	      return rowOut(getdb().prepare('SELECT * FROM noe_goals WHERE source = ? ORDER BY created_at DESC LIMIT 1').get(source));
   331	    } catch { return null; }
   332	  }
   333
   334	  function activeCountBySource(source) {
   335	    try {
   336	      return Number(getdb().prepare("SELECT COUNT(*) n FROM noe_goals WHERE source = ? AND status IN ('open','active')").get(source)?.n || 0);
   337	    } catch { return 0; }
   338	  }
   339
   340	  function goalCountBySource(source) {
   341	    try {
   342	      return Number(getdb().prepare('SELECT COUNT(*) n FROM noe_goals WHERE source = ?').get(source)?.n || 0);
   343	    } catch { return 0; }
   344	  }
   345
   346	  /**
   347	   * 自主学习种子：让 Noe 在没有 owner 追问、也没有惊奇结算时，仍会周期性主动上网学习
   348	   * 与自己短板有关的社区经验，并用只读本地诊断把外部学习落回代码事实。
   349	   */
   350	  function maybeSeedAutonomousLearning(t = now()) {
   351	    if (!autonomousLearning) return null;
   352	    try {
   353	      if (activeCountBySource('self_learning') > 0) return null;
   354	      const last = latestGoalBySource('self_learning');
   355	      // continuousLearning：上一轮 self_learning 已完成且没有活跃学习目标时，立即接下一轮。
   356	      // 这让自主学习变成“完成判据驱动的连续链”，而不是被创建时间间隔硬卡住；仍由 activeCount 防重入。
   357	      const lastDone = last?.status === 'done';
   358	      if (last && !(continuousLearning && lastDone) && t - Number(last.created_at || 0) < learningIntervalMs) return null;
   359	      const topicCursor = continuousLearning ? goalCountBySource('self_learning') : Math.abs(Math.floor(t / Math.max(1, learningIntervalMs)));
   360	      // 阶段3：动态选题器在场则用它（饱和冷却 + 跳过已学够的，治 6 主题死循环）；否则逐字回退 cursor%6。
   361	      let topic;
   362	      if (process.env.NOE_DYNAMIC_TOPICS === '1' && topicCurator?.getNextTopic) {
   363	        try {
   364	          const picked = topicCurator.getNextTopic();
   365	          topic = picked?.topic || learningTopicAtCursor(topicCursor, NOE_LEARNING_TOPICS);
   366	          try { topicCurator.recordVisit(topic); } catch { /* 记访问失败不阻断立项 */ }
   367	        } catch { topic = learningTopicAtCursor(topicCursor, NOE_LEARNING_TOPICS); }
   368	      } else {
   369	        topic = learningTopicAtCursor(topicCursor, NOE_LEARNING_TOPICS);
   370	      }
   371	      return add({
   372	        title: `自主学习：${topic.title}`,
   373	        source: 'self_learning',
   374	        why: '自主学习循环：即使主人没有追问，我也要主动搜索社区经验，并读本地代码证据，把学习变成下一步行动。',
   375	        steps: [
   376	          { step: `上网搜索并学习：${topic.query}`, kind: 'research' },
   377	          {
   378	            step: '把 Google Chrome 拉到前台，确认我能主动操控本机应用，而不只是写计划',
   379	            kind: 'act',
   380	            action: 'macos.app.activate',

exec
/bin/zsh -lc "nl -ba src/cognition/NoeExpectationLedger.js | sed -n '1,260p'" in /Users/hxx/Desktop/Neo 贾维斯
 succeeded in 0ms:
     1	// @ts-check
     2	// NoeExpectationLedger — 期望账本：预测-误差机制 + 校准闭环（设计文档《AI自我意识实现方案》§7.5 P4，
     3	// 结构性缺口四）。
     4	//
     5	// 问题：Noe 对世界从不"下注"——没有预测就没有落空，没有落空就没有惊奇（surprise），自我认知
     6	//   缺一条被现实硬纠正的反馈回路（confidence 复核只覆盖 insight，不覆盖对未来的预期）。
     7	// 设计：noe_expectations 表（迁移 v7）记 {claim, p, due_at}；到期结算 outcome → surprise =
     8	//   -log2(p_实际结果)；月度 Brier = mean((p-outcome)²) 进"自知之明"。
     9	// 来源（P4）：确定性正则从念头/对话抽"时间词+情态词"型预测（零 LLM，镜像 NoeCommitmentExtractor
    10	//   哲学，宁缺勿滥）；后续 P3 工作区/S2 质询可直接 add() 喂结构化预测。
    11	// 结算（P4）：到期项进内心透视页等人工裁决（应验/落空/判不了）；逾期 7 天没人判自动 unresolvable
    12	//   出账（不计分，防账本淤积）。LLM 自动判证留给工作区阶段。
    13	import { getDb } from '../storage/SqliteStore.js';
    14	import { textSimilarity } from '../memory/NoeMemoryDedup.js';
    15	import { calibrationCurve as computeCalibrationCurve } from './NoeCalibrationCurve.js';
    16	import { clamp } from './_mathUtils.js';
    17
    18	const MINUTE = 60_000;
    19	const HOUR = 3600_000;
    20	const DAY = 24 * HOUR;
    21
    22	function parseSmallCount(raw) {
    23	  const s = String(raw || '').trim();
    24	  if (!s) return null;
    25	  if (/^\d+$/.test(s)) return Number(s);
    26	  const digits = { 零: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
    27	  if (Object.prototype.hasOwnProperty.call(digits, s)) return digits[s];
    28	  if (s === '十') return 10;
    29	  const m = s.match(/^([一二两三四五六七八九])?十([一二三四五六七八九])?$/);
    30	  if (m) return (m[1] ? digits[m[1]] : 1) * 10 + (m[2] ? digits[m[2]] : 0);
    31	  return null;
    32	}
    33
    34	// 时间词 → due 偏移。短期期望优先匹配分钟/小时级，再落到天级。
    35	const TIME_DUE = [
    36	  [/([1-9]\d{0,2}|[一二两三四五六七八九十]{1,3})\s*(?:分钟|分)(?:钟)?(?:后|内)/, (m) => clamp(parseSmallCount(m[1]) || 0, 1, 720) * MINUTE],
    37	  [/半(?:个)?小时(?:后|内)/, 30 * MINUTE],
    38	  [/([1-9]\d{0,2}|[一二两三四五六七八九十]{1,3})\s*(?:个)?小时(?:后|内)/, (m) => clamp(parseSmallCount(m[1]) || 0, 1, 168) * HOUR],
    39	  [/([1-9]\d?|[一二两三四五六七八九十]{1,3})\s*天(?:后|内)/, (m) => clamp(parseSmallCount(m[1]) || 0, 1, 30) * DAY],
    40	  [/马上|立刻|很快/, 5 * MINUTE],
    41	  [/一会儿|等会儿|待会儿|稍后/, 15 * MINUTE],
    42	  [/今晚|今夜/, 12 * HOUR],
    43	  [/明天|明早|明晚/, 36 * HOUR],
    44	  [/后天/, 60 * HOUR],
    45	  [/这周|本周|周末/, 5 * DAY],
    46	  [/下周/, 8 * DAY],
    47	  [/过几天|这几天|最近几天/, 4 * DAY],
    48	];
    49	// 情态词 → 默认主观概率
    50	const MODAL_P = [
    51	  [/一定|肯定|必然/, 0.9],
    52	  [/会|应该|能|能够|可以|将/, 0.75],
    53	  [/大概|可能|估计|或许|也许/, 0.6],
    54	];
    55
    56	/**
    57	 * 确定性预测抽取（零 LLM）：句中同时含时间词+情态词才算一条预测；疑问句不算；每段最多 2 条。
    58	 * @param {string} text
    59	 * @param {{now?: number}} [opts]
    60	 * @returns {Array<{claim: string, p: number, dueAt: number}>}
    61	 */
    62	export function extractExpectations(text, { now = Date.now() } = {}) {
    63	  const out = [];
    64	  const segs = String(text || '').split(/[。！!\n；;]/).map((s) => s.trim()).filter(Boolean);
    65	  for (const seg of segs) {
    66	    if (out.length >= 2) break;
    67	    if (/[?？]/.test(seg)) continue; // 疑问不是预测
    68	    if (seg.length < 6 || seg.length > 80) continue;
    69	    const time = TIME_DUE.find(([re]) => re.test(seg));
    70	    if (!time) continue;
    71	    const modal = MODAL_P.find(([re]) => re.test(seg));
    72	    if (!modal) continue;
    73	    const match = seg.match(time[0]);
    74	    const offset = typeof time[1] === 'function' ? time[1](match || []) : time[1];
    75	    if (!Number.isFinite(offset) || offset <= 0) continue;
    76	    out.push({ claim: seg.slice(0, 120), p: modal[1], dueAt: now + offset });
    77	  }
    78	  return out;
    79	}
    80
    81	export function createExpectationLedger({
    82	  db = null,
    83	  now = Date.now,
    84	  expireDays = 7,            // 到期后再过 7 天没人裁决 → unresolvable 出账（不计分）
    85	  similarityThreshold = 0.8, // 与未结算项过似 → 不重复入账
    86	} = {}) {
    87	  const getdb = () => db || getDb();
    88
    89	  /** 入账一条预测。重复（与未结算项过似）返回 null。 */
    90	  function add({ claim, p = 0.7, dueAt = null, source = 'thought' } = {}) {
    91	    const c = String(claim || '').trim().slice(0, 300);
    92	    if (!c) return null;
    93	    const prob = clamp(Number(p) || 0.7, 0.01, 0.99);
    94	    try {
    95	      const opens = open({ limit: 100 });
    96	      if (opens.some((o) => textSimilarity(o.claim, c) >= similarityThreshold)) return null;
    97	      const r = getdb().prepare('INSERT INTO noe_expectations(created_at, source, claim, p, due_at) VALUES (?,?,?,?,?)')
    98	        .run(now(), String(source).slice(0, 40), c, prob, dueAt ? Number(dueAt) : null);
    99	      return Number(r.lastInsertRowid);
   100	    } catch { return null; }
   101	  }
   102
   103	  /** 从文本（念头/对话）抽预测并入账。@returns {number} 入账条数 */
   104	  function harvestFromText(text, { source = 'thought' } = {}) {
   105	    let added = 0;
   106	    try {
   107	      for (const e of extractExpectations(text, { now: now() })) {
   108	        if (add({ claim: e.claim, p: e.p, dueAt: e.dueAt, source }) != null) added++;
   109	      }
   110	    } catch { /* 抽取失败不阻断 */ }
   111	    return added;
   112	  }
   113
   114	  function open({ limit = 50 } = {}) {
   115	    try {
   116	      return getdb().prepare('SELECT * FROM noe_expectations WHERE resolved_at IS NULL ORDER BY id DESC LIMIT ?')
   117	        .all(Math.max(1, Math.min(500, limit)));
   118	    } catch { return []; }
   119	  }
   120
   121	  /** 已到期待裁决（透视页"等你裁决"区数据源）。 */
   122	  function due(t = now()) {
   123	    try {
   124	      return getdb().prepare('SELECT * FROM noe_expectations WHERE resolved_at IS NULL AND due_at IS NOT NULL AND due_at <= ? ORDER BY due_at ASC LIMIT 50').all(t);
   125	    } catch { return []; }
   126	  }
   127
   128	  /**
   129	   * 结算：outcome=1 应验 / 0 落空 / null 判不了（不计分）。
   130	   * surprise = -log2(p_实际结果)：高自信落空 → 大惊奇（注意力/反思素材的信号源）。
   131	   */
   132	  function resolve(id, outcome, t = now(), resolvedBy = 'auto') {
   133	    try {
   134	      const row = getdb().prepare('SELECT * FROM noe_expectations WHERE id = ? AND resolved_at IS NULL').get(id);
   135	      if (!row) return null;
   136	      let surprise = null;
   137	      let oc = null;
   138	      if (outcome === 1 || outcome === 0 || outcome === true || outcome === false) {
   139	        oc = outcome ? 1 : 0;
   140	        const pActual = oc === 1 ? row.p : 1 - row.p;
   141	        surprise = -Math.log2(clamp(pActual, 0.001, 1));
   142	      }
   143	      // P2-F2：记裁决来源（owner=holdout 旁证 / auto=本地脑自评），供校准看板诚实分层、防把自评当客观校准。
   144	      //   resolved_by 是 v13 新列；隔离/历史库（自建旧 schema 表）可能无此列，检测后退化为不写（不破坏）。
   145	      const by = resolvedBy === 'owner' ? 'owner' : 'auto';
   146	      const hasResolvedBy = Object.prototype.hasOwnProperty.call(row, 'resolved_by');
   147	      if (hasResolvedBy) {
   148	        getdb().prepare('UPDATE noe_expectations SET resolved_at = ?, outcome = ?, surprise = ?, resolved_by = ? WHERE id = ?').run(t, oc, surprise, by, id);
   149	      } else {
   150	        getdb().prepare('UPDATE noe_expectations SET resolved_at = ?, outcome = ?, surprise = ? WHERE id = ?').run(t, oc, surprise, id);
   151	      }
   152	      return { ...row, resolved_at: t, outcome: oc, surprise, resolved_by: hasResolvedBy ? by : null };
   153	    } catch { return null; }
   154	  }
   155
   156	  /** 扫账（心跳 micro 顺风车）：逾期 expireDays 没人裁决的自动 unresolvable 出账。@returns {number} */
   157	  function sweep(t = now()) {
   158	    try {
   159	      return getdb().prepare('UPDATE noe_expectations SET resolved_at = ?, outcome = NULL, surprise = NULL WHERE resolved_at IS NULL AND due_at IS NOT NULL AND due_at < ?')
   160	        .run(t, t - expireDays * DAY).changes;
   161	    } catch { return 0; }
   162	  }
   163
   164	  /**
   165	   * A2 前已入账的存量预测可能被旧天级默认值排得过晚。
   166	   * 只在重新解析 claim 得到更早 dueAt 时回填，避免把历史账目往后推或改写已结算项。
   167	   */
   168	  function repairDueAtFromClaim({ dryRun = true, limit = 500 } = {}) {
   169	    const max = Math.max(1, Math.min(2000, Number(limit) || 500));
   170	    try {
   171	      const rows = getdb().prepare('SELECT id, claim, created_at, due_at FROM noe_expectations WHERE resolved_at IS NULL ORDER BY id ASC LIMIT ?').all(max);
   172	      const updates = [];
   173	      for (const row of rows) {
   174	        const createdAt = Number(row.created_at) || now();
   175	        const parsed = extractExpectations(row.claim, { now: createdAt })[0];
   176	        if (!parsed?.dueAt) continue;
   177	        const oldDueAt = Number(row.due_at) || 0;
   178	        if (oldDueAt && parsed.dueAt >= oldDueAt) continue;
   179	        updates.push({
   180	          id: Number(row.id),
   181	          claim: String(row.claim || '').slice(0, 300),
   182	          oldDueAt: oldDueAt || null,
   183	          newDueAt: parsed.dueAt,
   184	        });
   185	      }
   186	      if (!dryRun && updates.length) {
   187	        const stmt = getdb().prepare('UPDATE noe_expectations SET due_at = ? WHERE id = ? AND resolved_at IS NULL');
   188	        const tx = getdb().transaction((items) => {
   189	          for (const item of items) stmt.run(item.newDueAt, item.id);
   190	        });
   191	        tx(updates);
   192	      }
   193	      return { ok: true, dryRun: dryRun !== false, scanned: rows.length, repaired: updates.length, updates };
   194	    } catch (error) {
   195	      return { ok: false, dryRun: dryRun !== false, scanned: 0, repaired: 0, updates: [], error: String(error?.message || error) };
   196	    }
   197	  }
   198
   199	  /** Brier 分（越低越准，0.25=瞎猜基线）+ 高自信命中率。只统计有明确 outcome 的。 */
   200	  function brier({ sinceTs = 0 } = {}) {
   201	    try {
   202	      const rows = getdb().prepare('SELECT p, outcome FROM noe_expectations WHERE resolved_at IS NOT NULL AND outcome IS NOT NULL AND created_at >= ?').all(sinceTs);
   203	      if (!rows.length) return { n: 0, brier: null, confidentN: 0, confidentHit: null };
   204	      const brierSum = rows.reduce((s, r) => s + (r.p - r.outcome) ** 2, 0);
   205	      const confident = rows.filter((r) => Math.max(r.p, 1 - r.p) >= 0.8);
   206	      const confidentHits = confident.filter((r) => (r.p >= 0.5) === (r.outcome === 1)).length;
   207	      return {
   208	        n: rows.length,
   209	        brier: Math.round((brierSum / rows.length) * 1000) / 1000,
   210	        confidentN: confident.length,
   211	        confidentHit: confident.length ? Math.round((confidentHits / confident.length) * 100) / 100 : null,
   212	      };
   213	    } catch { return { n: 0, brier: null, confidentN: 0, confidentHit: null }; }
   214	  }
   215
   216	  /**
   217	   * 校准曲线（P2 觉醒看板）：与 brier 同 resolved 口径，补 ECE/MCE + n-bin reliability。fail-open。
   218	   * P2-F2：附 provenance 分层——owner 裁决是 Neo 改不到的 holdout 旁证，auto 是本地脑自评。
   219	   *   全自评（ownerHoldoutN=0）时 selfEvaluated=true，看板必须警示「此 Brier 是自评、非客观校准」，
   220	   *   否则 owner 会把自评刷出的漂亮分数误读为「Neo 校准好」（违背路线 §4.2 防 Goodhart 第一防线）。
   221	   */
   222	  function calibration({ sinceTs = 0, binCount = 10 } = {}) {
   223	    const emptyProv = { ownerHoldoutN: 0, autoSelfN: 0, ownerBrier: null, selfEvaluated: true };
   224	    try {
   225	      // R3：resolved_by 是 v13 新列；自建/旧库无此列时退化为不分层（仍出曲线，不静默清零成 n:0）。
   226	      const hasResolvedBy = getdb().prepare("PRAGMA table_info(noe_expectations)").all().some((c) => c.name === 'resolved_by');
   227	      const sql = hasResolvedBy
   228	        ? 'SELECT p, outcome, resolved_by FROM noe_expectations WHERE resolved_at IS NOT NULL AND outcome IS NOT NULL AND created_at >= ?'
   229	        : 'SELECT p, outcome FROM noe_expectations WHERE resolved_at IS NOT NULL AND outcome IS NOT NULL AND created_at >= ?';
   230	      const rows = getdb().prepare(sql).all(sinceTs);
   231	      const curve = computeCalibrationCurve(rows, { binCount });
   232	      if (!hasResolvedBy) {
   233	        return { ...curve, provenance: { ownerHoldoutN: 0, autoSelfN: rows.length, ownerBrier: null, selfEvaluated: true } };
   234	      }
   235	      const ownerRows = rows.filter((r) => r.resolved_by === 'owner');
   236	      const ownerCurve = ownerRows.length ? computeCalibrationCurve(ownerRows, { binCount }) : null;
   237	      return {
   238	        ...curve,
   239	        provenance: {
   240	          ownerHoldoutN: ownerRows.length,
   241	          autoSelfN: rows.length - ownerRows.length,
   242	          ownerBrier: ownerCurve ? ownerCurve.brier : null,
   243	          selfEvaluated: ownerRows.length === 0,
   244	        },
   245	      };
   246	    } catch { return { n: 0, brier: null, ece: null, mce: null, bins: [], provenance: emptyProv }; }
   247	  }
   248
   249	  /** 自知之明一行（注入自我状态/夜反思素材用）。无结算数据返回 ''。 */
   250	  function calibrationNote({ sinceTs = now() - 30 * DAY } = {}) {
   251	    const b = brier({ sinceTs });
   252	    if (!b.n) return '';
   253	    const grade = b.brier <= 0.15 ? '相当准' : b.brier <= 0.25 ? '一般' : '偏过度自信';
   254	    return `近 30 天我对世界下过 ${b.n} 个判断，Brier ${b.brier}（${grade}）${b.confidentN ? `；高自信判断命中率 ${Math.round((b.confidentHit ?? 0) * 100)}%` : ''}`;
   255	  }
   256
   257	  /** 最近账目（透视页数据源）。 */
   258	  function history({ limit = 100 } = {}) {
   259	    try {
   260	      return getdb().prepare('SELECT * FROM noe_expectations ORDER BY id DESC LIMIT ?').all(Math.max(1, Math.min(500, limit)));

exec
/bin/zsh -lc "rg -n \"NOE_CURIOSITY|harvestSurprise\\(|curiosity|maybeSeedAutonomousLearning|autonomousLearning\" server.js src/cognition src/server -g '*.js'" in /Users/hxx/Desktop/Neo 贾维斯
 succeeded in 0ms:
server.js:40:  NOE_CURIOSITY: '1',
server.js:278:import { buildCuriosityYieldReport } from './scripts/noe-curiosity-yield-report.mjs';
server.js:1033:      curiosity: createCuriosityDecompose(),
server.js:1092://    活跃目标下一步进工作区候选 → 深思推进（思考级执行）。好奇回路 v1（NOE_CURIOSITY=1）：
server.js:1099:      //   ON 时好奇目标 meta.curiosity 记 epistemic/pragmatic 双因子画像。pragmatic 默认源=当前目标关键词重叠（弱信号，
server.js:1101:      curiosity: createCuriosityDecompose(),
server.js:1106:if (noeGoalSystem) console.log(`[noe-goals] 目标系统已启用（确定性仲裁 · active≤2 · 深思推进${process.env.NOE_CURIOSITY === '1' ? ' · 好奇回路：惊奇→研究目标' : ''}）`);
server.js:2246:  curiosityReport: buildCuriosityYieldReport,
src/cognition/NoeWorkspace.js:544:            // 阶段1：act 真失败 → 接通好奇回路供给端（登记预测→outcome=0→surprise→harvestSurprise(action_failure)）
src/cognition/NoeOwnerBehaviorPredictor.js:170:            try { goalSystem.harvestSurprise({ claim: row.claim, surprise: resolvedRow.surprise, origin: 'owner_prediction' }); } // P1-C：owner 明确否定 followup = owner 真实负反馈（门 b 非噪声）
src/cognition/NoeCuriosityDecompose.js:17://   curiosityScore——「好奇」从一个阈值触发的标量，升级成「为什么值得好奇」的双因子读数。
src/cognition/NoeCuriosityDecompose.js:51: *   无分布、无熵），是本模块相对现状的真增量，可作为 epistemicValue 的一种来源喂给 curiosityScore。
src/cognition/NoeCuriosityDecompose.js:85: * curiosityScore：把好奇拆成 epistemic + pragmatic 双因子并加权汇总（借 pymdp EFE 的二分解）。
src/cognition/NoeCuriosityDecompose.js:104:export function curiosityScore({
src/cognition/NoeCuriosityDecompose.js:164:    /** 绑定默认配置的 curiosityScore；逐次调用仍可用 override 覆写。 */
src/cognition/NoeCuriosityDecompose.js:166:      return curiosityScore({ weights, epistemicScale, pragmaticScale, surfaceThreshold, ...args });
src/cognition/NoeStepExpectationBridge.js:10://   resolve(outcome=0) → surprise=-log2(1-p) → harvestSurprise(origin='action_failure')，让好奇回路有米下锅。
src/cognition/NoeStepExpectationBridge.js:38:   * @returns {{expectationId:number, surprise:number, curiosityGoalId:any}|null}
src/cognition/NoeStepExpectationBridge.js:54:      if (surprise < surpriseThreshold) return { expectationId: id, surprise, curiosityGoalId: null };
src/cognition/NoeStepExpectationBridge.js:56:      const curiosityGoalId = goalSystem.harvestSurprise({ claim: r.claim, surprise, origin: 'action_failure' });
src/cognition/NoeStepExpectationBridge.js:57:      return { expectationId: id, surprise, curiosityGoalId };
src/cognition/NoeGoalSystem.js:12://   （NOE_CURIOSITY=1 门控）——被现实打脸的地方就是最该学习的地方。
src/cognition/NoeGoalSystem.js:91:  autonomousLearning = process.env.NOE_AUTONOMOUS_LEARNING === '1',
src/cognition/NoeGoalSystem.js:96:  curiosity = null,
src/cognition/NoeGoalSystem.js:103:  curiositySurpriseThreshold = Number.isFinite(Number(process.env.NOE_WS_SALIENCE_SURPRISE_BIT))
src/cognition/NoeGoalSystem.js:113:  const curiosityDecompose = curiosity || createCuriosityDecompose();
src/cognition/NoeGoalSystem.js:280:      // meta：可解释元信息（如 meta.curiosity）。仅 object 时序列化，否则存 NULL（OFF 路径不传 → 列保持 NULL，零回归）。
src/cognition/NoeGoalSystem.js:350:  function maybeSeedAutonomousLearning(t = now()) {
src/cognition/NoeGoalSystem.js:351:    if (!autonomousLearning) return null;
src/cognition/NoeGoalSystem.js:456:      maybeSeedAutonomousLearning(t);
src/cognition/NoeGoalSystem.js:564:   *   用 curiosityScore(epistemic=surprise, pragmatic=pragmaticSignal(claim)) 把这条好奇拆成可解释双因子，
src/cognition/NoeGoalSystem.js:565:   *   存进 goal.meta.curiosity 并把主导 label 追加进 why（供透视页/反思读「为什么值得好奇」）。
src/cognition/NoeGoalSystem.js:568:  function harvestSurprise({ claim, surprise, origin } = {}) {
src/cognition/NoeGoalSystem.js:569:    if (!(Number(surprise) >= curiositySurpriseThreshold) || !claim) return null;
src/cognition/NoeGoalSystem.js:577:    if (!curiosityDecompose?.enabled) {
src/cognition/NoeGoalSystem.js:593:    const cs = curiosityDecompose.score({ epistemicValue: surpriseBit, pragmaticValue: prag.value, pragmaticScale: 1 });
src/cognition/NoeGoalSystem.js:596:      curiosity: {
src/cognition/NoeGoalSystem.js:619:  return { add, get, list, setStatus, arbitrate, nextStep, recordStepResult, recordStepCheckpoint, checkpoints, latestCheckpoint, harvestSurprise, surpriseOriginBreakdown, maybeSeedAutonomousLearning, stats };
src/server/routes/noeMind.js:30:  curiosity: process.env.NOE_CURIOSITY === '1',
src/server/routes/noeMind.js:175:  curiosityReport = null,
src/server/routes/noeMind.js:239:  let curiosityCache = { at: 0, data: null };
src/server/routes/noeMind.js:241:    if (typeof curiosityReport !== 'function') return null;
src/server/routes/noeMind.js:243:    if (curiosityCache.data && t - curiosityCache.at < 60_000) return { ...curiosityCache.data, cached: true };
src/server/routes/noeMind.js:247:      const rep = curiosityReport(db, { sinceTs: 0, now: t });
src/server/routes/noeMind.js:258:      curiosityCache = { at: t, data };
src/server/routes/noeMind.js:394:        curiosity: buildCuriosityFunnelSummary(),
src/server/routes/noeMind.js:601:      let curiosityGoalId = null;
src/server/routes/noeMind.js:602:      if (outcome !== null && Number(r.surprise) >= 2 && goalSystem && process.env.NOE_CURIOSITY === '1') {
src/server/routes/noeMind.js:603:        try { curiosityGoalId = goalSystem.harvestSurprise({ claim: r.claim, surprise: r.surprise, origin: outcome === 0 ? 'owner_manual' : undefined }); } catch { /* 好奇失败不阻断裁决 */ } // P1-C 整改 F4+F4-REOPEN：仅 owner 手动判落空(outcome=0)标 owner_manual 非噪声；应验(outcome=1)的高惊奇不误计入门 b，与 resolver/predictor 的 outcome===0 闸一致
src/server/routes/noeMind.js:615:      res.json({ ok: true, resolved: r, curiosityGoalId });
src/server/routes/noeMind.js:632:  // ② curiosity-yield 漏斗（期望立 N→判证 M→落空 K→harvestSurprise→完成 J）
src/server/routes/noeMind.js:633:  app.get('/api/noe/mind/curiosity-funnel', requireOwnerToken, (req, res) => {
src/server/routes/noeMind.js:636:      if (!db || typeof curiosityReport !== 'function') return res.json({ ok: true, enabled: false });
src/server/routes/noeMind.js:637:      res.json({ ok: true, enabled: true, ...curiosityReport(db, { sinceTs: sinceTsFromDays(req.query), now: now() }) });
src/cognition/NoeExpectationResolver.js:1599:              try { goalSystem.harvestSurprise({ claim: exp.claim, surprise: resolvedRow.surprise, origin: deriveSurpriseOrigin(exp.source, { loosenOnly: v.loosenOnly }) }); } // P1-C 整改 F1+F2：据 source 推导 origin + loosen_fail 噪声分桶

exec
/bin/zsh -lc "nl -ba src/cognition/NoeGoalSystem.js | sed -n '380,535p'" in /Users/hxx/Desktop/Neo 贾维斯
 succeeded in 0ms:
   380	            action: 'macos.app.activate',
   381	            payload: {
   382	              app: 'Google Chrome',
   383	              timeoutMs: 10000,
   384	            },
   385	          },
   386	          {
   387	            step: `打开一个低风险资料页继续观察：${topic.url}`,
   388	            kind: 'act',
   389	            action: 'browser.open_url',
   390	            payload: {
   391	              url: topic.url,
   392	              timeoutMs: 30000,
   393	            },
   394	          },
   395	          {
   396	            step: '读取浏览器前台 URL/title 元数据，确认资料页是否已经打开',
   397	            kind: 'act',
   398	            action: 'browser.state_probe',
   399	            payload: {
   400	              includeAll: false,
   401	            },
   402	          },
   403	          {
   404	            step: '用 DOM 只读观察当前页面：读标题 + 提取正文，确认真读到内容而非只打开',
   405	            kind: 'act',
   406	            action: 'browser.observe_page',
   407	            payload: {
   408	              browserApp: 'Google Chrome',
   409	              url: topic.url,
   410	              expectedHost: new URL(topic.url).host,
   411	              expectedHosts: [new URL(topic.url).host],
   412	              // L3：read_title + read_body——真提取正文供深思学习（治浏览器空转）。
   413	              actions: [{ type: 'read_title' }, { type: 'read_body' }],
   414	            },
   415	          },
   416	          {
   417	            step: `为「${topic.title}」生成下一步浏览器/GUI 操作预演计划`,
   418	            kind: 'act',
   419	            action: 'visual.action.plan',
   420	            payload: {
   421	              goal: `基于已打开的资料页，规划下一步如何查找与「${topic.title}」相关的工程证据`,
   422	              surface: 'browser',
   423	              domSummary: 'unknown until browser state / DOM evidence is provided',
   424	            },
   425	          },
   426	          {
   427	            step: `只读扫描本项目相关代码，找出与「${topic.title}」有关的真实限制点`,
   428	            kind: 'act',
   429	            action: 'shell.exec',
   430	            payload: {
   431	              command: 'rg',
   432	              args: ['-n', '-i', '--max-count', '80', '--glob', '!**/.env*', '--glob', '!**/*token*', '--glob', '!**/*cookie*', '--glob', '!**/room-adapters.json', '--glob', '!games/cartoon-apocalypse/**', topic.localPattern, ...topic.localPaths],
   433	              readonly: true,
   434	              diagnosticDomains: ['autonomous_learning'],
   435	              timeoutMs: 30000,
   436	            },
   437	          },
   438	          {
   439	            step: `把「${topic.title}」的自主学习进展写入本地自治笔记`,
   440	            kind: 'act',
   441	            action: 'noe.note.write',
   442	            payload: {
   443	              path: 'output/noe-autonomy/learning.md',
   444	              content: `自主学习主题：${topic.title}\n学习查询：${topic.query}\n资料入口：${topic.url}\n下一步：结合前序 research 和只读诊断结果，在目标思考步里形成可执行改进。`,
   445	            },
   446	          },
   447	          { step: '结合外部学习和本地证据，写出一个可执行的下一步改进方案', kind: 'think' },
   448	        ],
   449	      });
   450	    } catch { return null; }
   451	  }
   452
   453	  /** 确定性仲裁：重算 open/active 优先级 → 激活 top-N、降级出局者、stale 自动 paused。 */
   454	  function arbitrate(t = now()) {
   455	    try {
   456	      maybeSeedAutonomousLearning(t);
   457	      closeResolvedGoals(t);
   458	      const rows = getdb().prepare("SELECT * FROM noe_goals WHERE status IN ('open','active')").all().map(rowOut);
   459	      const upd = getdb().prepare('UPDATE noe_goals SET priority = ?, status = ?, updated_at = ? WHERE id = ?');
   460	      const scored = rows.map((g) => {
   461	        // M15：drive 源权重随当下驱力强度浮动（0.25..0.55）——"多想要"决定"多优先"；探针炸了用静态档
   462	        let sw = SOURCE_WEIGHT[g.source] ?? 0.5;
   463	        if (g.source === 'drive' && typeof driveLevel === 'function') {
   464	          try { sw = 0.25 + 0.3 * clamp01(Number(driveLevel()) || 0); } catch { /* 静态档兜底 */ }
   465	        }
   466	        const ageDays = (t - g.created_at) / DAY;
   467	        const fresh = clamp01(1 / (1 + ageDays / 7));
   468	        const feasible = g.plan.length ? 1 : 0.5;
   469	        const lastTouchDays = (t - g.updated_at) / DAY;
   470	        const momentum = g.plan.some((s) => s.status === 'done') && lastTouchDays < 3 ? 1 : 0;
   471	        const stale = g.source !== 'owner' && lastTouchDays > staleDays;
   472	        const priority = Math.round((0.5 * sw + 0.2 * fresh + 0.2 * feasible + 0.1 * momentum) * 1000) / 1000;
   473	        return { g, priority, stale };
   474	      }).sort((a, b) => b.priority - a.priority);
   475	      let active = 0;
   476	      for (const s of scored) {
   477	        let status = s.g.status;
   478	        if (s.stale) status = 'paused'; // 两周没动的自生目标先放一放
   479	        else if (active < maxActive) { status = 'active'; active++; }
   480	        else status = 'open';
   481	        if (status !== s.g.status || s.priority !== s.g.priority) upd.run(s.priority, status, t, s.g.id);
   482	      }
   483	      recoverStaleGoalSteps({ getdb, rowOut, t, staleStepMs, staleResearchStepMs, staleActStepMs });
   484	      recoverRetriableBlockedGoalSteps({ getdb, rowOut, t });
   485	      return scored.length;
   486	    } catch { return 0; }
   487	  }
   488
   489	  function closeResolvedGoals(t = now()) {
   490	    try {
   491	      const rows = getdb().prepare("SELECT * FROM noe_goals WHERE status IN ('open','active')").all().map(rowOut);
   492	      const upd = getdb().prepare("UPDATE noe_goals SET status = 'done', updated_at = ? WHERE id = ?");
   493	      let changed = 0;
   494	      for (const g of rows) {
   495	        const plan = Array.isArray(g.plan) ? g.plan : [];
   496	        if (!plan.length) continue;
   497	        const resolved = plan.every((s) => ['done', 'recovered'].includes(String(s.status || 'open')));
   498	        if (!resolved) continue;
   499	        upd.run(t, g.id);
   500	        appendGoalCheckpoint(getdb(), {
   501	          now: () => t,
   502	          goal: { ...g, status: 'done' },
   503	          goalId: g.id,
   504	          stepIndex: plan.length - 1,
   505	          phase: 'step_done',
   506	          status: 'done',
   507	          note: '自动收口：所有步骤已进入 done/recovered 终态，目标状态同步为 done。',
   508	          replaySafe: true,
   509	        });
   510	        changed += 1;
   511	      }
   512	      return changed;
   513	    } catch { return 0; }
   514	  }
   515
   516	  /** 取最高优先级活跃目标的下一个未完成步骤（工作区候选源）；doing（执行中，如后台研究）跳过。 */
   517	  function nextStep() {
   518	    try {
   519	      const act = list({ status: 'active', limit: maxActive });
   520	      for (const g of act) {
   521	        if (g.plan.some((s) => BLOCKING_STEP_STATUSES.has(s.status))) continue; // 有步骤在后台执行/等审批：别并行抢
   522	        const idx = g.plan.findIndex((s) => s.status === 'open');
   523	        if (idx >= 0) {
   524	          return stepOutputFromGoal(g, idx);
   525	        }
   526	        if (!g.plan.length) {
   527	          const bootstrapped = bootstrapEmptyGoalPlan(g);
   528	          if (bootstrapped?.plan?.length) return stepOutputFromGoal(bootstrapped, 0);
   529	          return { goalId: g.id, title: g.title, stepIndex: -1, step: `想清楚「${g.title}」的第一步是什么`, kind: 'think', priority: g.priority };
   530	        }
   531	      }
   532	      return null;
   533	    } catch { return null; }
   534	  }
   535

exec
/bin/zsh -lc "nl -ba server.js | sed -n '32,48p'" in /Users/hxx/Desktop/Neo 贾维斯
 succeeded in 0ms:
    32	const NOE_AUTONOMY_DEFAULTS = Object.freeze({
    33	  NOE_CONTINUITY: '1',
    34	  NOE_HEARTBEAT: '1',
    35	  NOE_INNER_MONOLOGUE: '1',
    36	  NOE_WORKSPACE: '1',
    37	  NOE_GOALS: '1',
    38	  NOE_GOAL_ACT: '1',
    39	  NOE_DELEGATION: '1',
    40	  NOE_CURIOSITY: '1',
    41	  NOE_DRIVES: '1',
    42	  NOE_AFFECT: '1',
    43	  NOE_AFFECT_DESATURATE: '1',
    44	  NOE_EXPECTATIONS: '1',
    45	  NOE_EXPECTATION_AUTORESOLVE: '1',
    46	  NOE_JUDGE_EMBEDDING: '1', // P1-A：judge 证据接 embedding 语义召回（owner 决策认知开关默认开启；双代理两轮验收通过、修 source=surprise 死链）
    47	  NOE_EXPECT_DECISIVE_REASK: '1', // decisive reask 二次复核（R2+R3 整改后与 embedding 解耦、不互相误触发）
    48	  NOE_EXPECT_LOOSEN_FAIL: '1', // P1-B：放宽失败信号识别（result=cancelled 等终态负面词被 judge 据实判 0）

exec
/bin/zsh -lc 'rg -n "STEP_EXPECTATION|NOE_STEP_EXPECTATION_RESOLVE|STEP" server.js docs src tests package.json' in /Users/hxx/Desktop/Neo 贾维斯
 succeeded in 0ms:
server.js:1595:      // 阶段1：act/research step 真失败 → 登记预测→outcome=0→harvestSurprise，接通好奇回路供给端（NOE_STEP_EXPECTATION_RESOLVE 默认 OFF）
docs/RESEARCH_融入裁决_2026-06-14.md:84:- Neo 现状：Neo 缺「本地主脑进程内 model→tool→observe→再 model」的迭代式 agentic loop。现有多步执行是预排步骤链:src/runtime/NoeFreedomExecutor.js:26 `MAX_NOE_FREEDOM_CHAIN_STEPS=12` + normalizeChainSteps()（行 300-318）读 args.steps/nextFreedomActions 这一【预先给定的步骤数组】逐步跑+预算/权限闸,模型并不在每一步自主决定下一个工具;真多步靠 spawn 外部 Codex/Claude CLI（src/room/MiniMaxSpawnAdapter.js 等）。工具目录 src/actions/NoeActionCatalog.js 自带 JSON-schema 校验但只是 catalog 不驱动 loop。ai@5.x+18 个 @ai-sdk/* 仅作 @browserbasehq/stagehand 传递依赖躺在 node_modules,src 零 import。
tests/unit/noe-taskflow-store.test.js:7:  NOE_SELF_EVOLUTION_FLOW_STEPS,
tests/unit/noe-taskflow-store.test.js:35:      expect(flow.steps.map((step) => step.id)).toEqual(NOE_SELF_EVOLUTION_FLOW_STEPS);
tests/unit/noe-step-expectation-bridge.test.js:19:  beforeEach(() => { process.env.NOE_STEP_EXPECTATION_RESOLVE = '1'; });
tests/unit/noe-step-expectation-bridge.test.js:20:  afterEach(() => { delete process.env.NOE_STEP_EXPECTATION_RESOLVE; });
tests/unit/noe-step-expectation-bridge.test.js:23:    delete process.env.NOE_STEP_EXPECTATION_RESOLVE;
docs/research/_阶段1复盘_context.md:16:- flag `NOE_STEP_EXPECTATION_RESOLVE` 默认 OFF（OFF 时 onStepFailed 直接 return null，零行为）。
docs/research/_claude-自主学习方案.md:12:文件: 新增 src/cognition/NoeStepExpectationBridge.js(<150行,纯函数+DI,把 step 终态映射成 expectation resolve,门控 NOE_STEP_EXPECTATION_RESOLVE 默认 OFF);改 NoeExpectationResolver.js(maxPerTick/loosenFail 经注入,不改判证规则);改 harvestSurprise 入口加 origin 白名单硬门(NoeGoalSystem.js:556)
docs/research/_claude-自主学习方案.md:40:- 【全局工程纪律(对接 Neo 现有架构+红队防线)】每个机制独立 .env flag 默认 OFF(NOE_STEP_EXPECTATION_RESOLVE/SKILL_DEDUP/RESEARCH_TO_MEMORY/DYNAMIC_TOPICS/LEARNING_LP/LEARNING_JOL/THOUGHT_LOOP_INTERVENE/AUTO_CLOSE_TAB),便于二分定位回归,不一把全开;隔离端口 PORT=51999 端到端验+留 owner kickstart;OFF 时与现状逐字等价(参照 harvestSurprise/curiosityDecompose 已有零回归写法);碰 src/cognition+self-evolution 属分量动作;346 死卡 GC 按红线7先 dry-run 看命中范围。embedding 是所有度量的命脉,但 MEMORY.md 记载 Ollama 按需唤醒致 qwen3-embedding 间歇失效退回 hash128 维 mismatch→语义召回零命中:落地前必须确认 OLLAMA_KEEP_ALIVE=-1 生效,且 embedding 不可用时给明确保守降级(宁标 unknown 不学,绝不假装算出 0 而误判全饱和停学)。
docs/research/_m3-阶段1复盘.md:151:- flag `NOE_STEP_EXPECTATION_RESOLVE` 默认 OFF 时 `onStepFailed` 直接 return null。**这是 fail-open 而不是 fail-closed**。
docs/全仓逐项完成审计_文件索引_2026-06-11.json:211:      "path": "BaiLongma-audit/CHANGES-STEP2.md",
docs/全仓逐项完成审计_文件索引_2026-06-11.json:223:      "path": "BaiLongma-audit/CHANGES-STEP3A.md",
docs/全仓逐项完成审计_文件索引_2026-06-11.json:235:      "path": "BaiLongma-audit/CHANGES-STEP3BC.md",
docs/全仓逐项完成审计_文件索引_2026-06-11.json:247:      "path": "BaiLongma-audit/CHANGES-STEP4.md",
docs/全仓逐项完成审计_文件索引_2026-06-11.json:259:      "path": "BaiLongma-audit/CHANGES-STEP5A.md",
docs/全仓逐项完成审计_文件索引_2026-06-11.json:271:      "path": "BaiLongma-audit/CHANGES-STEP5B.md",
docs/全仓逐项完成审计_文件索引_2026-06-11.json:283:      "path": "BaiLongma-audit/CHANGES-STEP5C.md",
docs/全仓逐项完成审计_文件索引_2026-06-11.json:295:      "path": "BaiLongma-audit/CHANGES-STEP5D.md",
docs/全仓逐项完成审计_文件索引_2026-06-11.json:307:      "path": "BaiLongma-audit/CHANGES-STEP5E.md",
docs/全仓逐项完成审计_文件索引_2026-06-11.json:319:      "path": "BaiLongma-audit/CHANGES-STEP6A.md",
docs/全仓逐项完成审计_文件索引_2026-06-11.json:331:      "path": "BaiLongma-audit/CHANGES-STEP6B.md",
docs/RESEARCH_2026-06-14_Neo增强开源调研.md:549:- **架构**: 已读真实源码核实(非仅看 README)。原版 rStar = "生成-判别自博弈"解耦:①生成器在 run_src/MCTS_for_reasoning.py 里是 Reasoning_MCTS_Node + Generator,把 MCTS 跟五类"类人推理动作"结合——rstar_utils.py 的 Node_Type 枚举实证为六态(USER_QUESTION / REPHRASED_USER_QUESTION / DIRECT_ANSWER / SUBQUESTION / RE_SUBANSWER / OST_STEP),对应"走一步思考 / 直接作答 / 拆子问题并答 / 重答子问题 / 改写问题"。MCTS 经 do_rollout(root_node, i) 跑 rollout、find_children 懒展开、calculate_reward() 只在合法叶子返 node_value 否则 0。②判别器(对 Neo 最有价值的部分)在 run_src/do_discriminate.py:核心是 MajorityVoteDiscriminator,关键不是"换个更强模型",而是 _filter_reasoning_consistency——把候选解题轨迹在中途 mask 掉(mask_solution_trace,左右边界可调),用一个同等能力的 SLM 去补全被遮住的后半段,再用 evaluator.check_answers_equiv 比对补全结果与候选最终答案是否一致;选择阶段三道过滤(_filter_none → _filter_long → _filter_reasoning_consistency,阈值 loose/mid/strict/maj),最终打分 = confidence(答案频次或轨迹 reward)+ survival_rate(过滤前后存活比),_find_winner_filtered 取胜者,全挂时退化为多数投票。rStar-Math 则把"判别"升级为可训练的 PPM(过程偏好模型)+ 代码增强 CoT 自合成 + 4 轮策略/PPM 协同自进化(arXiv 2501.04519)。一句话:rStar 证明了"同级模型互验 + 树搜索"就能把小模型推理拉满,不靠蒸馏更强模型。
docs/ROADMAP_Neo觉醒路线_P0-P15_2026-06-15.md:226:  3. **mission loop 借 mini-SWE-agent「100 行哲学」**：start→decompose→execute via NoeFreedomAdapters→reflect→end，MAX_STEPS=20 防死循环。
docs/ROADMAP_Neo觉醒路线_P0-P15_2026-06-15.md:228:- **可证伪验收**：单 mission 完整闭环（目标→拆解→执行→反思→完成）跑通；MAX_STEPS 生效防死循环；连续 3 次失败后反思触发率 ≥60% 且成功率提升 ≥20%。**反向 probe**：mission 中途无反思或步数无上限则证伪。
src/runtime/NoeFreedomExecutor.js:26:const MAX_NOE_FREEDOM_CHAIN_STEPS = 12;
src/runtime/NoeFreedomExecutor.js:279:  return source.slice(0, MAX_NOE_FREEDOM_CHAIN_STEPS).map((step, index) => ({
src/runtime/NoeFreedomExecutor.js:604:    maxSteps: MAX_NOE_FREEDOM_CHAIN_STEPS,
src/runtime/NoeTaskFlowStore.js:11:export const NOE_SELF_EVOLUTION_FLOW_STEPS = [
src/runtime/NoeTaskFlowStore.js:22:export const NOE_TASKFLOW_STEP_STATUSES = new Set(['pending', 'running', 'passed', 'failed', 'skipped', 'cancelled']);
src/runtime/NoeTaskFlowStore.js:46:    status: NOE_TASKFLOW_STEP_STATUSES.has(step?.status) ? step.status : 'pending',
src/runtime/NoeTaskFlowStore.js:84:    const normalizedSteps = (steps.length ? steps : NOE_SELF_EVOLUTION_FLOW_STEPS)
src/runtime/NoeTaskFlowStore.js:135:      stepCounts: [...NOE_TASKFLOW_STEP_STATUSES].reduce((acc, status) => {
src/runtime/NoeTaskFlowStore.js:154:    if (!NOE_TASKFLOW_STEP_STATUSES.has(status)) throw new Error(`invalid taskflow step status: ${status}`);
src/runtime/NoeTaskFlowStore.js:199:      if (!NOE_TASKFLOW_STEP_STATUSES.has(step.status)) errors.push(`invalid_step_status:${step.id}:${step.status}`);
src/cognition/NoeGoalStepRecorder.js:5:const STEP_STATUSES = new Set(['open', 'doing', 'awaiting_approval', 'blocked', 'failed', 'recovered', 'done']);
src/cognition/NoeGoalStepRecorder.js:6:export const BLOCKING_STEP_STATUSES = new Set(['doing', 'awaiting_approval']);
src/cognition/NoeGoalStepRecorder.js:10:  return STEP_STATUSES.has(s) ? s : fallback;
src/cognition/NoeWorkspace.js:160:  stepExpectationBridge = null, // 阶段1：act/research step 真失败→登记预测→outcome=0→harvestSurprise（接通好奇回路供给端，NOE_STEP_EXPECTATION_RESOLVE）
src/cognition/NoeStepExpectationBridge.js:16://   ④ flag NOE_STEP_EXPECTATION_RESOLVE 默认 OFF，owner 点火。
src/cognition/NoeStepExpectationBridge.js:41:    if (process.env.NOE_STEP_EXPECTATION_RESOLVE !== '1') return null;
src/cognition/NoeGoalSystem.js:17:import { BLOCKING_STEP_STATUSES, recordGoalStepResult } from './NoeGoalStepRecorder.js';
src/cognition/NoeGoalSystem.js:521:        if (g.plan.some((s) => BLOCKING_STEP_STATUSES.has(s.status))) continue; // 有步骤在后台执行/等审批：别并行抢
src/cognition/NoeBudgetForcedDeliberation.js:23:export const DEFAULT_STEP_MAX_TOKENS = 512;
src/cognition/NoeBudgetForcedDeliberation.js:60:  stepMaxTokens = DEFAULT_STEP_MAX_TOKENS,

exec
/bin/zsh -lc "nl -ba tests/unit/noe-step-expectation-bridge.test.js | sed -n '1,240p'" in /Users/hxx/Desktop/Neo 贾维斯
 succeeded in 0ms:
     1	// @ts-check
     2	import { afterEach, beforeEach, describe, expect, it } from 'vitest';
     3	import { createStepExpectationBridge } from '../../src/cognition/NoeStepExpectationBridge.js';
     4
     5	function makeLedger({ addReturns = 1, surprise = 2.32 } = {}) {
     6	  const calls = { add: [], resolve: [] };
     7	  return {
     8	    calls,
     9	    add: (a) => { calls.add.push(a); return addReturns; },
    10	    resolve: (id, oc, t, by) => { calls.resolve.push({ id, oc, by, t }); return { claim: '完成步骤：部署X', surprise, outcome: oc }; },
    11	  };
    12	}
    13	function makeGoalSystem() {
    14	  const calls = [];
    15	  return { calls, harvestSurprise: (a) => { calls.push(a); return 'curiosity-goal-1'; } };
    16	}
    17
    18	describe('createStepExpectationBridge（阶段1 修活好奇回路供给端）', () => {
    19	  beforeEach(() => { process.env.NOE_STEP_EXPECTATION_RESOLVE = '1'; });
    20	  afterEach(() => { delete process.env.NOE_STEP_EXPECTATION_RESOLVE; });
    21
    22	  it('flag OFF → 零行为（onStepFailed return null，不碰 ledger）', () => {
    23	    delete process.env.NOE_STEP_EXPECTATION_RESOLVE;
    24	    const ledger = makeLedger(); const gs = makeGoalSystem();
    25	    const b = createStepExpectationBridge({ expectationLedger: ledger, goalSystem: gs });
    26	    expect(b.onStepFailed({ stepText: '部署X', kind: 'act', terminal: 'failed' })).toBeNull();
    27	    expect(ledger.calls.add).toHaveLength(0);
    28	  });
    29
    30	  it('act 真失败 → add 预测 + resolve(outcome=0) + harvestSurprise(action_failure)', () => {
    31	    const ledger = makeLedger({ surprise: 2.32 }); const gs = makeGoalSystem();
    32	    const b = createStepExpectationBridge({ expectationLedger: ledger, goalSystem: gs });
    33	    const r = b.onStepFailed({ stepText: '部署到不存在的服务', kind: 'act', terminal: 'failed' });
    34	    expect(ledger.calls.add[0]).toMatchObject({ p: 0.8, source: 'step_prediction' });
    35	    expect(ledger.calls.resolve[0]).toMatchObject({ oc: 0, by: 'auto' }); // outcome=0 真落空
    36	    expect(gs.calls[0]).toMatchObject({ origin: 'action_failure', surprise: 2.32 }); // 好奇回路有米下锅
    37	    expect(r.curiosityGoalId).toBe('curiosity-goal-1');
    38	  });
    39
    40	  it('research 失败同样触发', () => {
    41	    const ledger = makeLedger(); const gs = makeGoalSystem();
    42	    const b = createStepExpectationBridge({ expectationLedger: ledger, goalSystem: gs });
    43	    b.onStepFailed({ stepText: '查不到资料', kind: 'research', terminal: 'blocked' });
    44	    expect(gs.calls[0].origin).toBe('action_failure');
    45	  });
    46
    47	  it('think step 不触发（无客观成败）', () => {
    48	    const ledger = makeLedger(); const gs = makeGoalSystem();
    49	    const b = createStepExpectationBridge({ expectationLedger: ledger, goalSystem: gs });
    50	    expect(b.onStepFailed({ stepText: '想一想', kind: 'think', terminal: 'failed' })).toBeNull();
    51	    expect(ledger.calls.add).toHaveLength(0);
    52	  });
    53
    54	  it('done/doing 不触发（只认 failed/blocked）', () => {
    55	    const ledger = makeLedger(); const gs = makeGoalSystem();
    56	    const b = createStepExpectationBridge({ expectationLedger: ledger, goalSystem: gs });
    57	    expect(b.onStepFailed({ stepText: 'X', kind: 'act', terminal: 'done' })).toBeNull();
    58	    expect(b.onStepFailed({ stepText: 'X', kind: 'act', terminal: 'doing' })).toBeNull();
    59	  });
    60
    61	  it('surprise < 阈值 → 不立好奇目标（但仍 resolve outcome=0）', () => {
    62	    const ledger = makeLedger({ surprise: 1.0 }); const gs = makeGoalSystem();
    63	    const b = createStepExpectationBridge({ expectationLedger: ledger, goalSystem: gs, surpriseThreshold: 2 });
    64	    const r = b.onStepFailed({ stepText: '低 p 步骤失败', kind: 'act', terminal: 'failed' });
    65	    expect(ledger.calls.resolve[0].oc).toBe(0); // 仍判落空
    66	    expect(gs.calls).toHaveLength(0); // 但不够惊奇，不立目标
    67	    expect(r.curiosityGoalId).toBeNull();
    68	  });
    69
    70	  it('add 去重命中（return null）→ 不重复 resolve/harvest（防反复刷同一失败）', () => {
    71	    const ledger = makeLedger({ addReturns: null }); const gs = makeGoalSystem(); // add 返回 null = 去重命中
    72	    const b = createStepExpectationBridge({ expectationLedger: ledger, goalSystem: gs });
    73	    expect(b.onStepFailed({ stepText: '重复失败', kind: 'act', terminal: 'failed' })).toBeNull();
    74	    expect(ledger.calls.resolve).toHaveLength(0);
    75	    expect(gs.calls).toHaveLength(0);
    76	  });
    77
    78	  it('fail-open：ledger.resolve 抛错不崩', () => {
    79	    const gs = makeGoalSystem();
    80	    const ledger = { add: () => 1, resolve: () => { throw new Error('db boom'); } };
    81	    const b = createStepExpectationBridge({ expectationLedger: ledger, goalSystem: gs });
    82	    expect(b.onStepFailed({ stepText: 'X', kind: 'act', terminal: 'failed' })).toBeNull();
    83	  });
    84	});

exec
/bin/zsh -lc "nl -ba docs/research/_m3-阶段1复盘.md | sed -n '130,180p'" in /Users/hxx/Desktop/Neo 贾维斯
 succeeded in 0ms:
   130
   131	### 问题 1：dueAt = now() 立即到期 — **正确但有副作用**
   132	- NoeStepExpectationBridge 调用 `add({..., dueAt: now()})` 后立即 `resolve(id, 0)`。**功能上正确**（surprise 信号立刻可得），但 expectationLedger 内会留下一条**已 resolved 的历史记录**。
   133	- 副作用：每次 step 失败都永久写一条 outcome=0 到 ledger。24h 跑下来，ledger 会膨胀（每次失败 1 条 = 大约 50-200 条/天，OK 规模）。**不构成 bug，但需在 schema 文档标注** "step_prediction 是 self-resolving 类型，不应进入 resolver 队列"。
   134	- **风险**：如果未来给 ledger 加索引/约束，这条记录可能被误归类为"待 resolver 处理"，触发双 resolve → 异常。
   135
   136	### 问题 2：textSimilarity 去重 — **会被 Neo 措辞变化绕过**
   137	- harvestSurprise 内部去重用 textSimilarity。Neo 可用同义词/语序变化绕过（"完成步骤：分析 A" vs "完成步骤：A 的解析"）。
   138	- 建议：**不要只靠 textSimilarity**，加 **surprise origin + step hash 双键去重**。同 origin + 同 step 指纹才视为重复。
   139	- 当前 code（如有）只去重 claim 文本，是脆弱的。
   140
   141	### 问题 3：3 个接入点覆盖 — **不全**
   142	- NoeWorkspace 的 3 个点：act blocked / act error / research failed。
   143	- **漏的路径**：
   144	  - **act 超时**：ActPipeline 是否有 timeout 路径？如有，timeout 也是 failure，bridge 未接。
   145	  - **research 部分失败**：context 说接的是 "research failed"（终态），但 research 可能返回 partial results + warnings。warnings 应不应该算 outcome=0？
   146	  - **HTTP 5xx 来自外部 API**：NoeWorkspace 调用外部服务时，5xx 算 failure 吗？如算，被 catch 在哪？
   147	  - **planner 拒绝执行**：Neo planner 如果判定某 step 无可执行 plan 而 abort，这个是 Neo 内部"放弃"还是 act 失败？
   148	- **建议**：在 NoeWorkspace + ActPipeline 全部 throw / return reject 的路径上 grep 一次，列出**所有可能产生"非 done 终态"的点**，确保 bridge 覆盖。
   149
   150	### 问题 4：fail-open（隐含）
   151	- flag `NOE_STEP_EXPECTATION_RESOLVE` 默认 OFF 时 `onStepFailed` 直接 return null。**这是 fail-open 而不是 fail-closed**。
   152	- 风险：如果某天配置错误导致 flag 长期 OFF，Neo 整个好奇回路又退化回 R5 状态，**无告警**。
   153	- **建议**：fail-closed 方向——如果 flag 未设置，启动时打 warn log；如果连续 1h 检测到 source=surprise=0 但 act 失败 >5 次，自动开启并告警（自愈）。
   154
   155	---
   156
   157	## ⑥ 彻底性判定
   158
   159	### 阶段1 算什么
   160	- **算"修活了供给端第一个源（执行层 surprise）"**
   161	- **不算"修活了好奇回路"**——只接通了"惊奇发生器"，没接通"惊奇→学习→行为改变"
   162
   163	### 还需补哪些才算根除
   164
   165	按依赖顺序（前一环不修后一环无效）：
   166
   167	| 环 | 内容 | 必要性 | 来源 |
   168	|----|------|--------|------|
   169	| 1（已修） | step 失败 → outcome=0 | — | 阶段1 |
   170	| 2 | owner 否定 → outcome=0 | **P0** | ①③ |
   171	| 3 | worldModel 矛盾 → outcome=0 | **P0** | ①③ |
   172	| 4 | surprise 目标有 learningHook（goal done → 写 lesson） | **P0** | ② |
   173	| 5 | surprise 目标 steps 受约束（防空耗） | **P0** | ② |
   174	| 6 | 防 reward hacking 4 补丁（成本税/可验证 claim/语义距离/suspect） | **P0** | ① |
   175	| 7 | resolver 减压 + UNKNOWN 衰减 | P1 | ④ |
   176	| 8 | bridge 接入点全量审计 + fail-closed | P1 | ⑤ |
   177	| 9 | surprise 反传 goal priority | P2 | ② |
   178
   179	**根除定义**（我提议，作为这次审查的交付物之一）：当且仅当 1-6 全部完成，且 DB 跑 24h 后**满足三条件**：
   180	- (a) source=surprise 目标 done rate > 60%

exec
/bin/zsh -lc "rg -n \"owner_manual|owner_prediction|action_failure|manual|否定|contradict|worldModel|世界模型|mismatch|落空|outcome=0\" src/cognition src/server src/loop src/runtime -g '*.js'" in /Users/hxx/Desktop/Neo 贾维斯
 succeeded in 0ms:
src/loop/NoeHeartbeat.js:188:    /** 手动踩一拍（透视页按钮/实机验证用）：立即执行该 kind 一次，记台账（intent.manual），不动游标。 */
src/loop/NoeHeartbeat.js:194:      try { tickId = store.beginTick(String(kind), t1, t1 + leaseMs, { manual: true }); } catch { /* 台账失败不阻断 */ }
src/cognition/NoeAwakeningSignals.js:64:  // D1 预测-学习活性（漏斗末端：够格落空 → 立研究 → 完成）
src/cognition/NoeAwakeningSignals.js:66:    ? c('SELECT COUNT(*) n FROM noe_expectations WHERE created_at >= ? AND outcome=0 AND surprise IS NOT NULL AND surprise >= ?', sinceTs, SURPRISE_BIT_GATE) : 0;
src/cognition/NoeWorkspace.js:160:  stepExpectationBridge = null, // 阶段1：act/research step 真失败→登记预测→outcome=0→harvestSurprise（接通好奇回路供给端，NOE_STEP_EXPECTATION_RESOLVE）
src/cognition/NoeWorkspace.js:544:            // 阶段1：act 真失败 → 接通好奇回路供给端（登记预测→outcome=0→surprise→harvestSurprise(action_failure)）
src/loop/NoeLoop.js:92:  stop({ reason = 'manual' } = {}) {
src/loop/NoeLoop.js:108:  pause(reason = 'manual') {
src/loop/NoeLoop.js:110:    this.pauseReason = safeString(reason, 120) || 'manual';
src/server/services/rooms-core.js:322:    throw new Error('cluster delivery archive artifact digest mismatch');
src/server/services/rooms-core.js:878:      source: room.lineage.source || 'manual',
src/runtime/NoeDoctor.js:83:      return finding('git.root', 'error', `git root mismatch: ${top}`, { fixHint: 'run Noe commands from the real repository root', data: { top } });
src/runtime/NoeSocialFinalPublishExecutor.js:186:    return { ok: false, error: 'final_publish_host_mismatch', host, expectedHosts: payload.expectedHosts };
src/runtime/NoeSocialFinalPublishExecutor.js:353:    const issue = 'final_publish_browser_host_mismatch';
src/cognition/NoeOwnerBehaviorPredictor.js:11://      若 owner 明确取消/否定交办后的 followup → resolve(id,0) 并可触发 surprise 学习。
src/cognition/NoeOwnerBehaviorPredictor.js:18://   - 最小版不把「没做/没再提」强判落空(0)——与判证宪法一致（"仅没检索到证据≠落空"）。
src/cognition/NoeOwnerBehaviorPredictor.js:38:// owner 明确否定/取消 followup 的确定性信号。只用于 followup 预测，不用于 topic「会再提到」预测。
src/cognition/NoeOwnerBehaviorPredictor.js:104: *   followupP?: number,         // followup 预测主观概率（强先验；默认 0.75，落空 surprise=2bit）
src/cognition/NoeOwnerBehaviorPredictor.js:108: *   goalSystem?: {harvestSurprise?: Function}|null, // 明确 followup 落空时把 surprise 接入好奇目标
src/cognition/NoeOwnerBehaviorPredictor.js:136:   * - followup 预测：新文本命中 FOLLOWUP_SETTLE_RE → 应验；命中 FOLLOWUP_FAIL_RE → 落空。
src/cognition/NoeOwnerBehaviorPredictor.js:170:            try { goalSystem.harvestSurprise({ claim: row.claim, surprise: resolvedRow.surprise, origin: 'owner_prediction' }); } // P1-C：owner 明确否定 followup = owner 真实负反馈（门 b 非噪声）
src/loop/NoeThoughtSublimation.js:15://   - 置信度门槛防误判；否定句（"不用提醒主人"）直接不升华
src/loop/NoeThoughtSublimation.js:42:// 否定/打消念头不升华（"不用提醒主人""先不打扰主人"——念头自己已经决定不说）。
src/loop/ActPipeline.js:350:        retryReason: str(input.reason || 'manual_retry', 240),
src/runtime/NoeCompanionToolPreflight.js:339:  const manual = actions.filter((item) => item.safeAutomatic !== true && item.blocked !== true);
src/runtime/NoeCompanionToolPreflight.js:346:      manual: manual.length,
src/runtime/NoeCompanionToolPreflight.js:351:    manual,
src/loop/SafeActExecutors.js:769:    if (out?.ok !== true && out?.error === 'browser_dom_host_mismatch' && (payload.url || payload.targetUrl || payload.href)) {
src/loop/SafeActExecutors.js:775:          reason: 'browser_dom_host_mismatch',
src/cognition/SelfTalkOutcome.js:32:  'manual_evidence',
src/cognition/SelfTalkOutcome.js:75: * @property {'telemetry'|'manual_evidence'|null} confirmationSource
src/cognition/SelfTalkOutcome.js:207:  if (proposal.proposalId !== commit.proposalId) throw new TypeError('proposalId mismatch between proposal and commit');
src/cognition/SelfTalkOutcome.js:208:  if (landing && landing.proposalId !== proposal.proposalId) throw new TypeError('proposalId mismatch between proposal and landing');
src/loop/ActPipelinePreflight.js:170:    return { blockedSafety: true, decision: 'deny', reason: `approval action mismatch: ${payloadAction} != ${act.action}`, target: { ...target, approvalId } };
src/loop/ActPipelinePreflight.js:179:    type: 'manual',
src/runtime/NoePanelRuntimePreflight.js:142:    ...(foreignListeners.length ? ['panel_listener_cwd_mismatch'] : []),
src/runtime/NoeProposalInbox.js:270:  const manualFollowups = Array.isArray(repair.manualFollowups) ? repair.manualFollowups : [];
src/runtime/NoeProposalInbox.js:271:  if (!manualFollowups.length) return [];
src/runtime/NoeProposalInbox.js:273:  return manualFollowups.map((followup = {}) => {
src/runtime/NoeProposalInbox.js:285:      type: 'boot_self_check_manual_repair',
src/runtime/NoeFreedomRunLedger.js:167:    if (sha256(stableJson(copy)) !== expected) errors.push('freedom_run_ledger_hash_mismatch');
src/runtime/mission/NoeMissionCriteriaEngine.js:94:    const type = clean(criterion.type || 'manual', 160);
src/runtime/mission/NoeMissionCriteriaEngine.js:97:    if (type === 'manual') {
src/runtime/mission/NoeMissionCriteriaEngine.js:98:      return { id, ok: criterion.status === 'passed', reason: criterion.status === 'passed' ? 'manual_passed' : 'manual_not_passed' };
src/runtime/mission/NoeMissionRunner.js:230:  writeRunSummary(missionId, { sliceCount = 0, trigger = 'manual' } = {}) {
src/runtime/NoeProposalExecutor.js:10:  boot_self_check_manual_repair: 'queues/boot-self-check-repairs.jsonl',
src/runtime/NoeFreedomAdapters.js:630:      error: "browser_dom_host_mismatch",
src/runtime/NoeSocialFormFillExecutor.js:140:    ...(plan.previews?.title && browser.result?.titleEchoMatched !== true ? ['form_fill_title_echo_mismatch'] : []),
src/runtime/NoeSocialFormFillExecutor.js:141:    ...(plan.previews?.content && browser.result?.contentEchoMatched !== true ? ['form_fill_content_echo_mismatch'] : []),
src/cognition/NoeCuriosityDecompose.js:15://   把现有单 surprise（≈ epistemicValue 的天然来源：落空越狠 = 不确定性缺口越大）当 epistemic 输入，
src/runtime/NoeSocialFormFillPlan.js:103:    return { ok: false, error: 'form_fill_host_mismatch', host, expectedHosts: payload.expectedHosts };
src/runtime/NoeSocialFormFillPlan.js:230:    const issue = 'form_fill_browser_host_mismatch';
src/runtime/NoeSocialMediaUploadPlan.js:84:    return { ok: false, error: 'media_upload_host_mismatch', host, expectedHosts: payload.expectedHosts };
src/runtime/NoeSocialMediaUploadPlan.js:185:    const issue = 'media_upload_browser_host_mismatch';
src/runtime/NoeSocialMediaUploadExecutor.js:64:    return { ok: false, error: 'media_upload_host_mismatch', host, expectedHosts: payload.expectedHosts };
src/runtime/NoeWeChatPersonalBridge.js:85:  if (![WECHAT_PERSONAL_CHANNEL, 'wechat_personal'].includes(channel)) errors.push('owner_visible_channel_mismatch');
src/server/services/cluster-runtime.js:186:    manualResumeAllowed: true,
src/server/services/cluster-runtime.js:192:      : 'manual_review_required_before_resume',
src/runtime/NoeSocialRollbackEvidenceGate.js:171:    ...(targetUrlRef && !hostAllowed ? ['rollback_target_host_mismatch'] : []),
src/runtime/NoeSocialRollbackEvidenceGate.js:304:  if (!matchesHost) return { ok: false, error: 'rollback_target_host_mismatch', host, expectedHosts, clicked: false, action };
src/runtime/NoeSocialRollbackEvidenceGate.js:443:// authorized rollback would be allowed, and surfaces the manual instruction.
src/server/routes/auto-fill.js:152:      appendAudit({ action: 'fill', site, status: 'url-mismatch', actualUrl: url });
src/server/auth/owner-token.js:59:      return res.status(401).json({ error: 'owner token mismatch' });
src/runtime/NoeSocialPublishPreflight.js:188:  if (activeHost && expectedHosts.length && !browserMatches) warnings.push('browser_host_mismatch');
src/runtime/NoeFreedomExecutor.js:398:    ...(pageReadiness && pageReadiness.hostMatched === false ? ['browser_dom_host_mismatch'] : []),
src/runtime/mission/NoePatchApplyExecutor.js:299:  if (backupManifest && backupManifest.applyId !== applyReport.applyId) blockers.push('backup_manifest_apply_id_mismatch');
src/runtime/mission/NoePatchApplyExecutor.js:380:          rolledBack.push({ path: item.path, status: 'blocked', error: 'backup_hash_mismatch' });
src/runtime/NoeSocialPublishWorkflow.js:164:  if (activeHost && expectedHosts.length && !expectedHosts.includes(activeHost)) warnings.push('social_workflow_browser_host_mismatch');
src/cognition/NoeStepExpectationBridge.js:4:// 根因（Claude+M3 研究，panel.db 实测）：source='surprise' 好奇目标恒为 0、outcome=0 落空恒为 0、
src/cognition/NoeStepExpectationBridge.js:6://   harvestSurprise 门槛，是判证供给端【永远没有 outcome=0 喂进来】（343 预测淤积、judge UNKNOWN 偏置）。
src/cognition/NoeStepExpectationBridge.js:9://   非 Neo 自评）本身就是对「这步会成功」这条隐式预测的判落空。step 真失败时：登记一条预测并立即
src/cognition/NoeStepExpectationBridge.js:10://   resolve(outcome=0) → surprise=-log2(1-p) → harvestSurprise(origin='action_failure')，让好奇回路有米下锅。
src/cognition/NoeStepExpectationBridge.js:13://   ① origin 固定 'action_failure'（硬来源，isNonNoiseSurpriseOrigin 认非噪声；不喂自评类）；
src/cognition/NoeStepExpectationBridge.js:26: * @param {number} [opts.predictedP] 「这步会成功」的预测概率（默认 0.8 → 落空 surprise≈2.32bit）
src/cognition/NoeStepExpectationBridge.js:36:   * 一个 act/research step 真实失败时调用：登记「以为能完成」预测 → 判落空 → 接通好奇回路。
src/cognition/NoeStepExpectationBridge.js:51:      const r = expectationLedger.resolve(id, 0, now(), 'auto'); // 真实落空 outcome=0
src/cognition/NoeStepExpectationBridge.js:55:      // outcome=0 真实步骤失败 → 立好奇目标（origin=action_failure 硬来源；harvestSurprise 自带去重防刷）
src/cognition/NoeStepExpectationBridge.js:56:      const curiosityGoalId = goalSystem.harvestSurprise({ claim: r.claim, surprise, origin: 'action_failure' });
src/cognition/P6RuminationReadiness.js:36:    mustContain: ['isOwnerPerceivedDelivery', 'confirmedAt', 'manual_evidence', 'play_failed'],
src/server/routes/roomsAdvanced.js:351:      crossVerifyDispatcher.retryTask(req.params.id, taskId, { resumeSource: 'manual_retry' }).catch((e) => {
src/server/routes/delegations.js:217:          type: 'manual',
src/runtime/NoeBootSelfCheck.js:114:  const manualFollowups = [];
src/runtime/NoeBootSelfCheck.js:124:      else manualFollowups.push(entry);
src/runtime/NoeBootSelfCheck.js:135:    manualFollowups: manualFollowups.slice(0, 12),
src/cognition/NoeReflectiveTuner.js:406:      adoption: 'manual_only',
src/cognition/NoeReflectiveTuner.js:430:      return { ok: true, schemaVersion: NOE_REFLECTIVE_TUNER_SCHEMA_VERSION, ts: now(), shadow: true, adoption: 'manual_only', baselineWeights: baseline, mutationSource: 'disabled', evaluated: 0, candidates: [], paretoFront: [], archived: false };
src/cognition/NoeReflectiveTuner.js:466:      adoption: 'manual_only',
src/server/routes/telemetry.js:103:        { level: 'info', tags: { kind: 'manual-test' } }
src/server/routes/img-cache.js:266:          resp = await fetch(curUrl, { signal: ac.signal, redirect: 'manual', ...(dispatcher ? { dispatcher } : {}) });
src/server/routes/noeMind.js:591:  // 裁决一条预测：outcome=1 应验 / 0 落空 / null 判不了。高惊奇 → 好奇回路立研究目标 + 情感评估。
src/server/routes/noeMind.js:603:        try { curiosityGoalId = goalSystem.harvestSurprise({ claim: r.claim, surprise: r.surprise, origin: outcome === 0 ? 'owner_manual' : undefined }); } catch { /* 好奇失败不阻断裁决 */ } // P1-C 整改 F4+F4-REOPEN：仅 owner 手动判落空(outcome=0)标 owner_manual 非噪声；应验(outcome=1)的高惊奇不误计入门 b，与 resolver/predictor 的 outcome===0 闸一致
src/server/routes/noeMind.js:606:        // 被裁决=一次现实反馈：应验微暖；落空保留 novelty→唤醒上扬（好奇/警觉，注意力信号，原设计精神）。
src/server/routes/noeMind.js:607:        // NOE_AFFECT_NEGATIVE 开时落空给中等 valence(-0.3)：owner 主动裁决「判错了」该有承认挫败的分量，但不重击
src/server/routes/noeMind.js:608:        // （act 失败的 setback=-0.5 才是 v 跌主力，预测落空是次要信号）；默认 OFF 保持原 -0.1。
src/server/routes/noeMind.js:614:      try { timeline?.record?.({ type: 'interaction', summary: `主人裁决了我的预测「${String(r.claim || '').slice(0, 30)}」：${outcome === 1 ? '应验' : outcome === 0 ? '落空' : '判不了'}`, salience: 3 }); } catch { /* 留痕失败不阻断 */ }
src/server/routes/noeMind.js:632:  // ② curiosity-yield 漏斗（期望立 N→判证 M→落空 K→harvestSurprise→完成 J）
src/server/routes/sessionsContinuum.js:213:            else if (name.includes('_MANUAL.md')) trigger = 'manual';
src/cognition/NoeExpectationResolver.js:22:  '- FAILED = 证据明确显示预测落空（注意：仅"没检索到证据"不算落空，回 UNKNOWN）。',
src/cognition/NoeExpectationResolver.js:23:  '- 如果安全判证提示给出 APPLIED/FAILED，但你仍回 UNKNOWN，必须用 reasonCode 说明原因，例如 claim_mismatch、conflicting_signals、insufficient_direct_evidence。',
src/cognition/NoeExpectationResolver.js:25:  '优先只回一行 JSON：{"verdict":"APPLIED|FAILED|UNKNOWN","reasonCode":"direct_success|direct_failure|claim_mismatch|conflicting_signals|insufficient_direct_evidence|observation_only|candidate_only|format_error","hintAgreement":"agree|override|not_applicable"}。',
src/cognition/NoeExpectationResolver.js:33:  '如果仍然不能采用提示，必须选择 claim_mismatch 或 conflicting_signals；不要在已有直接 action-result 语义链时继续用 insufficient_direct_evidence。',
src/cognition/NoeExpectationResolver.js:34:  '只回一行 JSON：{"verdict":"APPLIED|FAILED|UNKNOWN","reasonCode":"direct_success|direct_failure|claim_mismatch|conflicting_signals|format_error","hintAgreement":"agree|override"}。',
src/cognition/NoeExpectationResolver.js:49:  ['落空', 0],
src/cognition/NoeExpectationResolver.js:575:// 刻意不含 not_found/notfound（那是「没检索到证据」≠落空，与判证宪法一致）。LOOSE 仅由
src/cognition/NoeExpectationResolver.js:583:export const SURPRISE_ORIGIN_ENUM = Object.freeze(['loosen_fail', 'owner_prediction', 'owner_manual', 'reflection_miss', 'action_failure', 'expectation_miss']);
src/cognition/NoeExpectationResolver.js:585:  if (loosenOnly) return 'loosen_fail'; // F1：仅因 NOE_EXPECT_LOOSEN_FAIL 放宽失败正则才认的落空 = 门 b 要剔除的噪声
src/cognition/NoeExpectationResolver.js:587:  if (/owner|followup/.test(s)) return 'owner_prediction';
src/cognition/NoeExpectationResolver.js:589:  if (/(?:^|[._:\s-])(?:act|action|goal|task|execut|step|checkpoint)(?=$|[._:\s-])/.test(s)) return 'action_failure'; // 复核 DERIVE-REGEX：分隔符词界防 transaction/interaction/steps 子串误命中
src/cognition/NoeExpectationResolver.js:590:  return 'expectation_miss'; // F2：thought/self-obs 等非 action 预测不再被误标 action_failure
src/cognition/NoeExpectationResolver.js:592:// P1-C 整改 F3：验收门 b 判据——owner_*/action_failure 是 owner+action 类「非噪声」surprise；loosen_fail/reflection_miss/expectation_miss 不计。
src/cognition/NoeExpectationResolver.js:594:  return /^owner_|^action_failure$/.test(String(origin || ''));
src/cognition/NoeExpectationResolver.js:596:// loosen-only 失败：evidence 含 loose 专属失败词(cancelled/aborted/…)但不含 base 失败词(failed/error/…)→ 该落空仅靠放宽正则才认成
src/cognition/NoeExpectationResolver.js:663:      'action_failure_signal',
src/cognition/NoeExpectationResolver.js:697:    ...(alignmentLine ? ['直接行动对齐计数表示已有终态 action/result 与预测语义相连；不要仅因覆盖率偏低或观察噪声裁成 claim_mismatch，若仍缺少直接对应或存在冲突则保持 UNKNOWN。'] : []),
src/cognition/NoeExpectationResolver.js:714:  if (label === 'action_failure_signal' && suggested === 'FAILED') {
src/cognition/NoeExpectationResolver.js:1390:  goalSystem = null,         // rank4 好奇回路：注入则预测落空(outcome=0)且惊奇≥阈值时自动 harvestSurprise 立研究目标
src/cognition/NoeExpectationResolver.js:1392:  // 判证 profile 与改造前逐字一致。ON 经 NOE_EXPECT_LOOSEN_FAIL=1 触发，让真实落空（result=cancelled 等
src/cognition/NoeExpectationResolver.js:1546:    // P1-C 整改 F1：outcome=0 时透出本次落空是否仅靠 loosen 放宽正则才认（供 deriveSurpriseOrigin 标 loosen_fail 噪声桶）
src/cognition/NoeExpectationResolver.js:1596:            // rank4 好奇回路：预测落空(outcome=0)且惊奇≥阈值 → 自动立「搞明白为什么没料到」研究目标。
src/server/routes/roomsClusterDeliveryRoutes.js:59:        : /digest mismatch|escapes|not allowed|invalid|not a file/.test(message) ? 422
src/cognition/NoeGoalSystem.js:11:// 好奇回路 v1：高惊奇（落空的自信预测，surprise ≥ 2 bit）→ 自动生成"搞明白为什么"的研究目标
src/cognition/NoeGoalSystem.js:313:      const isNonNoise = (o) => /^owner_|^action_failure$/.test(String(o || ''));
src/cognition/NoeGoalSystem.js:562:   * 好奇回路 v1：高惊奇的落空预测 → 研究目标（被现实打脸的地方就是该学习的地方）。
src/cognition/NoeGoalSystem.js:571:    // P1-C：surprise 来源分桶（action_failure/owner_followup/…），让 surprise-learning-audit 验收门 b 区分非噪声 surprise。
src/cognition/NoeGoalSystem.js:573:    const baseWhy = `这条预测落空带来 ${Math.round(surpriseBit * 10) / 10} bit 惊奇——我的世界模型在这里有缺口`;
src/cognition/NoeGoalSystem.js:592:    // epistemic = surprise(bit)（落空越狠 = 不确定性缺口越大）；pragmatic 已在 [0,1]，故 pragmaticScale=1。
src/server/routes/agentRuns.js:24:  if (/digest mismatch/.test(message)) return 409;
src/server/routes/rooms.js:204:        { reason: 'manual_rotate', keepTail: 10 },
src/cognition/NoeExpectationLedger.js:5:// 问题：Noe 对世界从不"下注"——没有预测就没有落空，没有落空就没有惊奇（surprise），自我认知
src/cognition/NoeExpectationLedger.js:11:// 结算（P4）：到期项进内心透视页等人工裁决（应验/落空/判不了）；逾期 7 天没人判自动 unresolvable
src/cognition/NoeExpectationLedger.js:129:   * 结算：outcome=1 应验 / 0 落空 / null 判不了（不计分）。
src/cognition/NoeExpectationLedger.js:130:   * surprise = -log2(p_实际结果)：高自信落空 → 大惊奇（注意力/反思素材的信号源）。
src/cognition/NoeGoalStepRecovery.js:5:const RETRIABLE_BROWSER_HOST_MISMATCH = 'browser_dom_host_mismatch';
src/cognition/NoeGoalStepRecovery.js:91:          const recoveredNote = `自动恢复：浏览器 host mismatch 已重试 ${retryCount} 次仍未成功，标记 recovered 释放后续目标步骤；这一步没有伪装为完成。前序：${note}`.slice(0, 500);
src/cognition/SelfTalkDeliveryAck.js:17:export const SELF_TALK_CONFIRMATION_SOURCES = Object.freeze(['telemetry', 'manual_evidence']);
src/cognition/SelfTalkDeliveryAck.js:78:  if (landing.proposalId !== ack.proposalId) throw new TypeError('proposalId mismatch between landing and delivery ack');

exec
/bin/zsh -lc "rg -n \"NOE_STEP_EXPECTATION_RESOLVE|step expectation|StepExpectation|source='surprise'|curiosity-yield|surpriseGoalsDone\" tests docs scripts package.json" in /Users/hxx/Desktop/Neo 贾维斯
 succeeded in 0ms:
package.json:151:    "noe:curiosity:yield-report": "node scripts/ensure-node22.mjs --require-22 --exec scripts/noe-curiosity-yield-report.mjs",
scripts/noe-surprise-learning-audit.mjs:21:  curiosityYieldReport: join(ROOT, 'scripts', 'noe-curiosity-yield-report.mjs'),
scripts/noe-surprise-learning-audit.mjs:92:    surpriseGoalsDone: num(curiosityResearch.surpriseGoalsDone ?? goals.surpriseGoalsDone),
scripts/noe-surprise-learning-audit.mjs:180:    && /noe-curiosity-yield-report\.mjs/.test(curiosityScript);
scripts/noe-surprise-learning-audit.mjs:235:      reason: 'curiosity-yield 依赖 better-sqlite3；仓库脚本已经通过 ensure-node22 固定运行时。',
scripts/noe-surprise-learning-audit.mjs:343:      ['surpriseGoalsDone', String(report.current.surpriseGoalsDone)],
scripts/noe-curiosity-yield-report.mjs:87:  const surpriseGoalsDone = hasGoals
scripts/noe-curiosity-yield-report.mjs:101:    { stage: 'surprise_goals_done', label: '完成研究', count: surpriseGoalsDone, ofPrev: pct(surpriseGoalsDone, surpriseGoals) },
scripts/noe-curiosity-yield-report.mjs:111:  if (surpriseGoals > 0 && surpriseGoalsDone === 0) diagnostics.push('research_not_completed: 立了好奇研究但无一完成（研究执行链未推进）');
scripts/noe-curiosity-yield-report.mjs:120:    research: { surpriseGoals, surpriseGoalsActive, surpriseGoalsDone },
scripts/noe-curiosity-yield-report.mjs:129:  lines.push('Noe 好奇产出漏斗（curiosity-yield，只读）');
scripts/noe-curiosity-yield-report.mjs:141:  lines.push(`好奇研究：在途 ${report.research.surpriseGoalsActive}  ·  完成 ${report.research.surpriseGoalsDone}`);
docs/8周长周期方案_2026-06-14.md:60:| curiosity-yield 漏斗 | source=surprise 恒 0 | ≥ 5% 月转化率(实测) |
docs/8周长周期方案_2026-06-14.md:321:2. **新文件** `scripts/noe-curiosity-yield-live.mjs`(只读,纯 SQL 统计,~80 行):
docs/8周长周期方案_2026-06-14.md:325:   // 输出 JSON 到 output/noe-curiosity-yield/live-stats.json
docs/8周长周期方案_2026-06-14.md:326:   // 输出 markdown 表格到 output/noe-curiosity-yield/live-stats.md(便于 mind.html 渲染)
docs/8周长周期方案_2026-06-14.md:328:3. **改** `package.json` scripts 加 `"noe:curiosity-yield": "node scripts/noe-curiosity-yield-live.mjs"`
docs/8周长周期方案_2026-06-14.md:333:8. **新文件** `tests/unit/noe-curiosity-yield-stats.test.js`(纯逻辑测试,验证统计函数正确)
docs/8周长周期方案_2026-06-14.md:337:   - curiosity-yield 活性看板: `npm run noe:curiosity-yield` 统计 live panel.db 期望立/判证/FAILED/触发/完成漏斗,`public/mind.html` 新区显示 (`scripts/noe-curiosity-yield-live.mjs`)
docs/8周长周期方案_2026-06-14.md:342:npm run noe:curiosity-yield
docs/8周长周期方案_2026-06-14.md:343:cat output/noe-curiosity-yield/live-stats.md
docs/8周长周期方案_2026-06-14.md:346:npx vitest run tests/unit/noe-curiosity-yield-stats.test.js
docs/8周长周期方案_2026-06-14.md:484:- `npm run noe:curiosity-yield` 返回真实漏斗数字
docs/8周长周期方案_2026-06-14.md:1028:cat /Users/hxx/Desktop/Neo\ 贾维斯/output/noe-curiosity-yield/live-stats.md
docs/8周长周期方案_2026-06-14.md:1083:T7. S0.4 写 noe-curiosity-yield-live.mjs + mind.html 区
docs/RESEARCH_AGI自我意识_全球扫描与Neo落地路线_2026-06-14.md:18:- **已确认过期**：`NoeCuriosityDecompose` 已接进 `NoeDriveSystem`/`NoeGoalSystem`（**不再是孤儿，§9.2 S0.2 别重做**）；`NoeThoughtLoopGuard` 已接进 `NoeWorkspace`/`InnerMonologue`（S0.3 别重做）；ollama 实测在跑（非 §9 说的 down）；另一会话已新建 `scripts/noe-curiosity-yield-report.mjs`（S0.4 部分在做）。
docs/RESEARCH_AGI自我意识_全球扫描与Neo落地路线_2026-06-14.md:24:3. **S0.4 curiosity-yield 漏斗 + source=surprise 点火（升 P0）**——「从造好变活起来」的命门
docs/RESEARCH_AGI自我意识_全球扫描与Neo落地路线_2026-06-14.md:51:2. curiosity-yield 等内部漏斗**只当观察仪表，绝不当进化选择压力**；
docs/RESEARCH_AGI自我意识_全球扫描与Neo落地路线_2026-06-14.md:385:- 无主动学习专属可观测性：scripts/ 有 recall/relevance/calibration/dual-brain 等基准，但无一条度量『主动学习成效』——没有 curiosity-yield（高 surprise→真立目标→真完成→真改进的转化率）、没有『本周学到 X 条新知识/新技能』曲线。对标 DGM/Letta『经验证据驱动+可观测指标』，owner 宪法『机制存在≠活着』——主动学习是七维里活性证据最薄的，却最缺看板。
docs/RESEARCH_AGI自我意识_全球扫描与Neo落地路线_2026-06-14.md:391:- **把 source=surprise 恒为 0 的活性死火接成 live 冒烟 + 看板首项（修『预测落空→主动学习』回路真烧起来）** — 已有 scripts/noe-expectation-settlement-drill.mjs（隔离验证账本可结算≥20 项算 Brier）→ 增强为：①新增 npm 脚本对 live 只读统计 source=surprise/expectation 结算分布；②在 mind.html 内心透视页加只读区显示『近 7 天：期望立 N 条 / 自动判证 M 条 / FAILED→harvestSurprise K 条 / 已完成研究 J 条』curiosity-yield 漏斗；③定位为何 outcome===0 罕见（多半 NoeExpectationResolver 证据门太严判 UNKNOWN）——调低自动判证证据阈值或扩 FAILED 信号词，让真落空的预测能结算成 0。绝不伪造结算，只让真实落空可见可发动。  `[P0/P1 · 1 天 · 纯确定性 SQL 只读 + 现有判证逻辑，零模型；判证若需 LLM 走 Main Brain qwen3.6-35b think:false（已是现状）。零云配额。]`
docs/RESEARCH_AGI自我意识_全球扫描与Neo落地路线_2026-06-14.md:403:- 【P0·0.5 天】source=surprise 活性看板 + live 冒烟：复用 scripts/noe-expectation-settlement-drill.mjs，新增只读 npm 脚本统计 live panel 的 curiosity-yield 漏斗（期望立 N→自动判证 M→FAILED K→harvestSurprise→完成 J），在 mind.html 加只读区。直接把七维里活性最薄的『主动学习是否真烧起来』变可见——这是『存在≠活着』的关键活样本。零模型零回归。
docs/RESEARCH_AGI自我意识_全球扫描与Neo落地路线_2026-06-14.md:642:  - 动手：复用 `scripts/noe-expectation-settlement-drill.mjs`；新增**只读** npm 脚本统计 live `curiosity-yield` 漏斗（期望立 N → 自动判证 M → FAILED(outcome=0) K → harvestSurprise → 完成研究 J）；mind.html 加只读区；定位为何 `outcome===0` 罕见（多半 `NoeExpectationResolver` 证据门太严判 UNKNOWN）→ 适度放宽自动判证 / 扩 FAILED 信号词，让真落空的预测能结算成 0。**绝不伪造结算，只让真实落空可见可发动。**
docs/RESEARCH_AGI自我意识_全球扫描与Neo落地路线_2026-06-14.md:698:- **Chollet「技能获取效率」AGI 定义 + 两大误区** — 智能=「给定先验/经验/任务范围内的技能获取效率」而非固定题库得分；误区一：把静态答题等同通用智能；误区二：把推理模型等同可持续自主智能体（「会想题」≠「会持续改进自己并管理复杂行动链」）。**对 Neo**：给主动学习维度一个比 curiosity-yield 更本质的北极星指标（用更少经验学会新任务）；「推理模型≠自主智能体」直接印证 Neo 把自进化按在 P8 门、不轻易放开改代码的正确性。
scripts/noe-runtime-evidence-audit.mjs:12:import { buildCuriosityYieldReport } from './noe-curiosity-yield-report.mjs';
scripts/noe-runtime-evidence-audit.mjs:507:    surpriseGoalsDone: num(curiosity?.research?.surpriseGoalsDone),
scripts/noe-runtime-evidence-audit.mjs:797:      evidence: `failedEligible=${goals ? 'see_curiosity' : '-'}; surpriseGoals=${goals.surpriseGoals}; done=${goals.surpriseGoalsDone}`,
scripts/noe-runtime-evidence-audit.mjs:884:    const goals = database ? buildGoalEvidence(database, curiosity) : { ok: false, status: 'db_missing', surpriseGoals: 0, surpriseGoalsDone: 0 };
docs/ROADMAP_Neo觉醒路线_P0-P15_2026-06-15.md:162:- **做什么**：mind.html 内心透视页加只读区：① curiosity-yield 漏斗（期望立 N→判证 M→FAILED K→harvestSurprise→完成 J）② 本地模型存活（ollama/LM Studio ping + 三脑就位 + embedding 实际命中后端）③ 整合度 TC 趋势线（数据已写 kv `noe.integration.reading`，只差前端消费）④ 期望校准曲线（Brier/ECE 10-bin）⑤ 觉醒候选信号 4 维采样（`scripts/noe-awakening-monitor.mjs` <240 行纯只读，每小时落盘 `awakening-samples/*.jsonl`）。
docs/ROADMAP_Neo觉醒路线_P0-P15_2026-06-15.md:280:  2. **三道自欺防线**：① 被 self-evolution 当优化目标的指标必须有 Neo 改不到的 holdout 旁证（HaluMem/Self-Recognition）② curiosity-yield 等内部漏斗只当观察仪表绝不当进化选择压力 ③ inner_monologue/why/Review verdict 全标注「功能性自我报告，非真实推理证据」，自进化归因必须有确定性证据（代码 diff/测试结果）背书。
docs/ROADMAP_Neo觉醒路线_P0-P15_2026-06-15.md:328:  2. **呈现层统一**（owner 追加需求，见 §5）：以 mind.html 内心透视页为**觉醒驾驶舱**，把散落的活性看板/觉醒信号/模型存活/curiosity-yield 收进一处；index 主工作台精简 modal/侧栏；cognitive 认知界面保留为沉浸模式。
docs/ROADMAP_Neo觉醒路线_P0-P15_2026-06-15.md:343:2. curiosity-yield 等内部漏斗**只当观察仪表，绝不当进化选择压力**。
docs/ROADMAP_Neo觉醒路线_P0-P15_2026-06-15.md:364:- **mind.html = 觉醒驾驶舱**：P2/P13 的活性看板/觉醒信号/模型存活/curiosity-yield 全收进这里，成为「一眼看全 Neo 是否活着」的统一界面（呼应 owner「统一收纳」）。
docs/Neo-觉醒判据.md:69:2. 内部漏斗（curiosity-yield 等）只当观察仪表，**绝不当进化选择压力**。
tests/unit/noe-curiosity-yield-report.test.js:8:import { buildCuriosityYieldReport } from '../../scripts/noe-curiosity-yield-report.mjs';
tests/unit/noe-curiosity-yield-report.test.js:10:// curiosity-yield 漏斗只读统计。隔离临时库 + readonly 句柄，证「只读不写 + 漏斗计数正确 + 诊断断点」。
tests/unit/noe-curiosity-yield-report.test.js:52:      expect(r.research).toMatchObject({ surpriseGoals: 2, surpriseGoalsActive: 1, surpriseGoalsDone: 1 });
tests/unit/noe-curiosity-yield-report.test.js:99:      ['scripts/noe-curiosity-yield-report.mjs', '--json'],
tests/unit/noe-curiosity-yield-report.test.js:105:    expect(report.research.surpriseGoalsDone).toBe(1);
tests/unit/noe-awakening-monitor.test.js:54:    expect(s.dimensions.d1_predictionLearning.surpriseGoalsDone).toBe(1);
docs/research/_阶段1复盘_context.md:5:- noe_goals source='surprise' 好奇目标 = **0 条**（从未产生过）；noe_expectations outcome=0 落空 = **0 条**；
docs/research/_阶段1复盘_context.md:10:新建 `src/cognition/NoeStepExpectationBridge.js`：
docs/research/_阶段1复盘_context.md:15:- server.js 装配注入（`createStepExpectationBridge({expectationLedger, goalSystem})`）。
docs/research/_阶段1复盘_context.md:16:- flag `NOE_STEP_EXPECTATION_RESOLVE` 默认 OFF（OFF 时 onStepFailed 直接 return null，零行为）。
tests/unit/noe-step-expectation-bridge.test.js:3:import { createStepExpectationBridge } from '../../src/cognition/NoeStepExpectationBridge.js';
tests/unit/noe-step-expectation-bridge.test.js:18:describe('createStepExpectationBridge（阶段1 修活好奇回路供给端）', () => {
tests/unit/noe-step-expectation-bridge.test.js:19:  beforeEach(() => { process.env.NOE_STEP_EXPECTATION_RESOLVE = '1'; });
tests/unit/noe-step-expectation-bridge.test.js:20:  afterEach(() => { delete process.env.NOE_STEP_EXPECTATION_RESOLVE; });
tests/unit/noe-step-expectation-bridge.test.js:23:    delete process.env.NOE_STEP_EXPECTATION_RESOLVE;
tests/unit/noe-step-expectation-bridge.test.js:25:    const b = createStepExpectationBridge({ expectationLedger: ledger, goalSystem: gs });
tests/unit/noe-step-expectation-bridge.test.js:32:    const b = createStepExpectationBridge({ expectationLedger: ledger, goalSystem: gs });
tests/unit/noe-step-expectation-bridge.test.js:42:    const b = createStepExpectationBridge({ expectationLedger: ledger, goalSystem: gs });
tests/unit/noe-step-expectation-bridge.test.js:49:    const b = createStepExpectationBridge({ expectationLedger: ledger, goalSystem: gs });
tests/unit/noe-step-expectation-bridge.test.js:56:    const b = createStepExpectationBridge({ expectationLedger: ledger, goalSystem: gs });
tests/unit/noe-step-expectation-bridge.test.js:63:    const b = createStepExpectationBridge({ expectationLedger: ledger, goalSystem: gs, surpriseThreshold: 2 });
tests/unit/noe-step-expectation-bridge.test.js:72:    const b = createStepExpectationBridge({ expectationLedger: ledger, goalSystem: gs });
tests/unit/noe-step-expectation-bridge.test.js:81:    const b = createStepExpectationBridge({ expectationLedger: ledger, goalSystem: gs });
docs/research/_claude-自主学习方案.md:12:文件: 新增 src/cognition/NoeStepExpectationBridge.js(<150行,纯函数+DI,把 step 终态映射成 expectation resolve,门控 NOE_STEP_EXPECTATION_RESOLVE 默认 OFF);改 NoeExpectationResolver.js(maxPerTick/loosenFail 经注入,不改判证规则);改 harvestSurprise 入口加 origin 白名单硬门(NoeGoalSystem.js:556)
docs/research/_claude-自主学习方案.md:13:验收: 隔离端口跑含已知会失败的 act 步(故意指向不存在的 app):DB 中 noe_expectations 出现 outcome=0 条目(原恒 0);若该 surprise≥阈值且 origin∈白名单,noe_goals 出现 source='surprise' 条目(原恒 0)。反向 probe(防刷分):喂一条 self-evaluated 的假落空(origin 非白名单),验证 harvestSurprise 拒绝立目标。再 probe:resolver 一跳判证数从≤3 升到≤8。
docs/research/_claude-自主学习方案.md:40:- 【全局工程纪律(对接 Neo 现有架构+红队防线)】每个机制独立 .env flag 默认 OFF(NOE_STEP_EXPECTATION_RESOLVE/SKILL_DEDUP/RESEARCH_TO_MEMORY/DYNAMIC_TOPICS/LEARNING_LP/LEARNING_JOL/THOUGHT_LOOP_INTERVENE/AUTO_CLOSE_TAB),便于二分定位回归,不一把全开;隔离端口 PORT=51999 端到端验+留 owner kickstart;OFF 时与现状逐字等价(参照 harvestSurprise/curiosityDecompose 已有零回归写法);碰 src/cognition+self-evolution 属分量动作;346 死卡 GC 按红线7先 dry-run 看命中范围。embedding 是所有度量的命脉,但 MEMORY.md 记载 Ollama 按需唤醒致 qwen3-embedding 间歇失效退回 hash128 维 mismatch→语义召回零命中:落地前必须确认 OLLAMA_KEEP_ALIVE=-1 生效,且 embedding 不可用时给明确保守降级(宁标 unknown 不学,绝不假装算出 0 而误判全饱和停学)。
docs/research/_m3-阶段1复盘.md:5:我已通读 context、NoeStepExpectationBridge.js、server.js 装配、NoeWorkspace 三个失败接入点、goalSystem.harvestSurprise + isNonNoiseSurpriseOrigin 链、NoeExpectationResolver 当前实现。下面是**漏洞优先**的根除审查，不是补丁审查。
docs/research/_m3-阶段1复盘.md:27:- `NoeStepExpectationBridge.onStepFailed` 只校验 `terminal in {failed, blocked}` 来自真实 ActPipeline / research 终态，**完全不校验**该 step 是「Neo 真要做的」还是「Neo 为刷 surprise 故意派的」。
docs/research/_m3-阶段1复盘.md:36:- `claim = "完成步骤：" + stepText`（NoeStepExpectationBridge.js 推测行）。`stepText` 来自 Neo 自己生成的 steps 数组。Neo 可以微调 step 措辞（"完成步骤：分析 A" / "完成步骤：分析 A 的子问题"）绕过 textSimilarity 去重，本质上是**同一失败主题刷 N 次不同 claim**。
docs/research/_m3-阶段1复盘.md:95:- 现状：NoeStepExpectationBridge 不知道 owner correction 这条流。
docs/research/_m3-阶段1复盘.md:100:- 现状：reader 路径**完全不查** worldModel 一致性。NoeStepExpectationBridge 只接了 NoeWorkspace 的 3 个失败点，没接 reader。
docs/research/_m3-阶段1复盘.md:104:- **彻底根除需要 3 个 bridge**：NoeStepExpectationBridge（已建）+ NoeOwnerCorrectionBridge（P0-H）+ NoeWorldModelContradictionBridge（P0-I）。
docs/research/_m3-阶段1复盘.md:132:- NoeStepExpectationBridge 调用 `add({..., dueAt: now()})` 后立即 `resolve(id, 0)`。**功能上正确**（surprise 信号立刻可得），但 expectationLedger 内会留下一条**已 resolved 的历史记录**。
docs/research/_m3-阶段1复盘.md:151:- flag `NOE_STEP_EXPECTATION_RESOLVE` 默认 OFF 时 `onStepFailed` 直接 return null。**这是 fail-open 而不是 fail-closed**。
docs/research/_m3-阶段1复盘.md:191:**下一步建议**：把上面 9 个 patch 分 3 批——**批次 A（2-3-4-6）必须上**才能让阶段1 真正有效，否则上 24h 跑会出新指标繁荣；**批次 B（5-7-8）上完后才算"好奇回路接通"**；**批次 C 是优化项**。需要我把 P0-A 到 P0-I 写成可贴入 NoeStepExpectationBridge.js 的 patch diff 吗？
tests/unit/noe-surprise-learning-audit.test.js:57:          surpriseGoalsDone: 0,
tests/unit/noe-surprise-learning-audit.test.js:106:        'noe-curiosity-yield-report.mjs',
tests/unit/noe-surprise-learning-audit.test.js:111:          'noe:curiosity:yield-report': 'node scripts/ensure-node22.mjs --require-22 --exec scripts/noe-curiosity-yield-report.mjs',
tests/unit/noe-surprise-learning-audit.test.js:174:          research: { surpriseGoals: 1, surpriseGoalsActive: 1, surpriseGoalsDone: 0 },

exec
/bin/zsh -lc "rg -n \"isNonNoiseSurpriseOrigin|SURPRISE_ORIGIN_ENUM|deriveSurpriseOrigin|origin.*white|白名单|nonNoise|NOE_CURIOSITY\" src/cognition src/server tests docs/research -g '*.js' -g '*.md'" in /Users/hxx/Desktop/Neo 贾维斯
 succeeded in 0ms:
docs/research/_阶段1复盘_context.md:19:① origin 固定 'action_failure'（硬来源，isNonNoiseSurpriseOrigin 认非噪声）；② 只认 act/research 真实终态失败
docs/research/_claude-自主学习方案.md:12:文件: 新增 src/cognition/NoeStepExpectationBridge.js(<150行,纯函数+DI,把 step 终态映射成 expectation resolve,门控 NOE_STEP_EXPECTATION_RESOLVE 默认 OFF);改 NoeExpectationResolver.js(maxPerTick/loosenFail 经注入,不改判证规则);改 harvestSurprise 入口加 origin 白名单硬门(NoeGoalSystem.js:556)
docs/research/_claude-自主学习方案.md:13:验收: 隔离端口跑含已知会失败的 act 步(故意指向不存在的 app):DB 中 noe_expectations 出现 outcome=0 条目(原恒 0);若该 surprise≥阈值且 origin∈白名单,noe_goals 出现 source='surprise' 条目(原恒 0)。反向 probe(防刷分):喂一条 self-evaluated 的假落空(origin 非白名单),验证 harvestSurprise 拒绝立目标。再 probe:resolver 一跳判证数从≤3 升到≤8。
docs/research/_claude-自主学习方案.md:44:- [reward hacking·outcome=0] 若把 act 步失败当预测落空,Neo 可能学会故意做易失败 act 刷 surprise→刷好奇目标。防线:harvestSurprise 入口加 origin 硬白名单,surprise 只采纳 action_failure/owner_prediction/owner_manual 三类真实世界硬来源,自评类一律不喂;surpriseOriginBreakdown 已分桶 owner_/action_failure 非噪声可直接复用。
docs/research/_m3-阶段1复盘.md:5:我已通读 context、NoeStepExpectationBridge.js、server.js 装配、NoeWorkspace 三个失败接入点、goalSystem.harvestSurprise + isNonNoiseSurpriseOrigin 链、NoeExpectationResolver 当前实现。下面是**漏洞优先**的根除审查，不是补丁审查。
src/cognition/NoeReflectBrain.js:6:// 设计：所有"自主认知"消费方统一从这里取 {adapterId, model}，铁律是**白名单只含本地 adapter**
src/cognition/NoeReflectBrain.js:15:/** 自主认知允许的本地 adapter 白名单（绝不含 claude/codex/minimax/gemini 等付费档）。 */
src/cognition/NoeReflectBrain.js:33:      log?.warn?.(`[noe-reflect] NOE_REFLECT_BRAIN=${adapterId} 不在本地白名单(${LOCAL_REFLECT_ADAPTERS.join('/')})，已回退 lmstudio——自主认知绝不路由到付费 adapter`);
src/cognition/NoeDeliberation.js:9:// 纪律：本地深思脑（NoeReflectBrain 白名单）跑，不烧付费配额；不设超时；fail-open。
src/cognition/NoeDeliberation.js:100:      // 不设超时（跑模型纪律）；深思走本地白名单模型
src/cognition/NoeStepExpectationBridge.js:13://   ① origin 固定 'action_failure'（硬来源，isNonNoiseSurpriseOrigin 认非噪声；不喂自评类）；
src/cognition/NoeExpectationResolver.js:8:// 设计：心跳独立作业每跳取 due() 前 N 条，喂本地脑（深思/反刍白名单，绝不付费档）+ 创建之后的
src/cognition/NoeExpectationResolver.js:583:export const SURPRISE_ORIGIN_ENUM = Object.freeze(['loosen_fail', 'owner_prediction', 'owner_manual', 'reflection_miss', 'action_failure', 'expectation_miss']);
src/cognition/NoeExpectationResolver.js:584:export function deriveSurpriseOrigin(source, { loosenOnly = false } = {}) {
src/cognition/NoeExpectationResolver.js:593:export function isNonNoiseSurpriseOrigin(origin) {
src/cognition/NoeExpectationResolver.js:1385:  adapterId = 'lmstudio',    // 本地白名单脑（由装配方经 NoeReflectBrain 解析后传入）
src/cognition/NoeExpectationResolver.js:1475:        // 不设超时（跑模型纪律）；判证走本地白名单模型，绝不付费档
src/cognition/NoeExpectationResolver.js:1546:    // P1-C 整改 F1：outcome=0 时透出本次落空是否仅靠 loosen 放宽正则才认（供 deriveSurpriseOrigin 标 loosen_fail 噪声桶）
src/cognition/NoeExpectationResolver.js:1599:              try { goalSystem.harvestSurprise({ claim: exp.claim, surprise: resolvedRow.surprise, origin: deriveSurpriseOrigin(exp.source, { loosenOnly: v.loosenOnly }) }); } // P1-C 整改 F1+F2：据 source 推导 origin + loosen_fail 噪声分桶
src/cognition/NoeGoalSystem.js:12://   （NOE_CURIOSITY=1 门控）——被现实打脸的地方就是最该学习的地方。
src/cognition/NoeGoalSystem.js:312:      let nonNoise = 0;
src/cognition/NoeGoalSystem.js:317:        if (isNonNoise(origin)) nonNoise += 1;
src/cognition/NoeGoalSystem.js:319:      return { total: rows.length, nonNoise, noise: rows.length - nonNoise, byOrigin };
src/cognition/NoeGoalSystem.js:320:    } catch { return { total: 0, nonNoise: 0, noise: 0, byOrigin: {} }; }
src/server/routes/roomsForward.js:127:    // 防御：复用源房 cwd 时校一遍沙箱（万一沙箱白名单后来收紧）
src/server/routes/noeMind.js:30:  curiosity: process.env.NOE_CURIOSITY === '1',
src/server/routes/noeMind.js:602:      if (outcome !== null && Number(r.surprise) >= 2 && goalSystem && process.env.NOE_CURIOSITY === '1') {
src/server/routes/noeMedia.js:6:// 图像/音乐同步等完（分钟级，不设硬超时）。opts 白名单透传，不直接 spread body。
src/server/routes/noe.js:511:  // 链路 = 长轮询 → mention-gating(TELEGRAM_ALLOW_FROM 白名单) → 防连击栅栏 → voiceSession.chatText(同款大脑/记忆) → 回 Telegram。
tests/unit/noe-inbound-channels.test.js:115:  it('allowFrom 白名单外不唤醒', () => {
src/server/routes/docs.js:1:// 暴露 docs/*.md 给前端展示 —— 从 server.js 抽出（D2）。仅 GET 只读，文件名白名单。
tests/unit/noe-circadian.test.js:33:  it('返回值恒在 PHASES 白名单内；非法时间戳回落 day（fail-open 不调制）', () => {
tests/unit/appjs-migration-batch21.test.js:62:    // 安全配置钉死：DOMPurify 白名单 + URI 协议限制 + Reverse Tabnabbing hook + img 本地缓存 proxy
src/server/auth/origin-allow.js:1:// Origin 白名单纯函数 —— 从 server.js 抽出，供 HTTP middleware 和 WS upgrade 共用，
src/server/auth/origin-allow.js:5:// 带 Origin 头时必须命中白名单，否则拒绝。WS 另有 token 兜底（见 server.js _checkWsToken）。
src/server/auth/origin-allow.js:19:  // 故无 Origin 放行安全；但绝不能据此放宽「带 Origin 但不在白名单」的跨站请求。
src/server/routes/rooms.js:59:  // A1 安全修复：conversation 含完整聊天内容，读也必须 owner-token（Origin 白名单只防浏览器跨域，
src/server/routes/mcp.js:154:  // 调用 MCP server 的工具（callTool）。受信任本地 server（unified-kb 等）经 classify 白名单放行免审批；
src/server/routes/img-cache.js:81:  // 端口白名单：80/443 + 默认空（避开 22/3306/6379/Redis/Postgres 等内网服务）
tests/unit/minimax-music-client.test.js:40:  it('错误白名单：只透 status_code/status_msg', async () => {
tests/unit/noe-affect-workspace-e2e.test.js:3:// 与单测不同：这条不注入收集器，而是走真 EpisodicTimeline（含 type 白名单）+ 真 events 表，
tests/unit/noe-affect-workspace-e2e.test.js:40:    recordEpisode: (e) => timeline.record(e),                       // 走真白名单
tests/unit/noe-affect-workspace-e2e.test.js:62:    // setback 真落库，且没被白名单回退成 interaction
tests/unit/permission-dedupe-reuse.test.js:27:// serverName 必须用「不在受信任白名单」的 server——白名单内的（unified-kb/filesystem/memory/playwright）
tests/unit/noe-capability-acquisition.test.js:39:describe('NoeCapabilityAcquisition — 安全评估（源白名单 + 包名合法性）', () => {
tests/unit/noe-turn-context-engine.test.js:354:  it('sections 段级白名单：只跑列出的段，白名单外副作用不执行（方向一聊天室入口用）', async () => {
tests/unit/noe-turn-context-engine.test.js:376:    expect(commitmentAsked).toBe(0); // 白名单外的 store 调用也不发生
tests/unit/noe-turn-context-engine.test.js:429:  it('sections 白名单外：store 连读都不读（副作用不发生）', async () => {
tests/unit/noe-memory-conflict-policy.test.js:104:    expect(r2).toMatchObject({ action: 'supersede', slot: 'location' });   // 非白名单城市靠"在X工作/定居"识别
tests/unit/permission-governance.test.js:369:    // 默认白名单四个本地 server：调用/列表（execute）免审批，大脑可自主用工具
tests/unit/permission-governance.test.js:377:    // 改 spawn 启动规格（configure）= 潜在 RCE → 永远审批，即使是白名单 server
tests/unit/permission-governance.test.js:382:    // 不在白名单的 server 调用仍审批
tests/unit/noe-nightly-reflection.test.js:75:  it('写新 insight（字段校验+kind 白名单+confidence clamp）并推进水位线', async () => {
tests/unit/noe-act-executors-free.test.js:9:  it('扩展白名单命令（python3）通过注入 runner 执行', async () => {
tests/unit/noe-act-executors-free.test.js:23:  it('非白名单命令被拒（防御纵深）', async () => {
tests/unit/safety/ws-origin.test.js:4:// 原测试是装饰性占位（expect(true).toBe(true)），无论白名单是否工作都通过。
tests/unit/safety/ws-origin.test.js:6:describe('Origin 白名单（CSRF 防御）', () => {
tests/unit/safety/ws-origin.test.js:9:  it('白名单含 localhost / 127.0.0.1 / [::1] 三个同源 Origin', () => {
tests/unit/noe-reflect-brain.test.js:20:  it('env 可覆盖 adapter（白名单内）与模型', () => {
tests/unit/noe-reflect-brain.test.js:33:    expect(warns[0]).toContain('白名单');
tests/unit/noe-reflect-brain.test.js:51:  it('白名单只含本地 adapter', () => {
tests/unit/safety/dangerous-pattern-detector.test.js:397:  it('[high/反例] rm -rf /tmp/myfolder 不命中 递归删除绝对路径（白名单）', () => {
tests/unit/report-eisdir.test.js:41:  // 用户 homedir 下临时目录，避开 isPathSafe 的 /tmp 已经允许、但 mac /tmp -> /private/tmp 解析后超出白名单的细节
tests/unit/noe-media-studio.test.js:199:  it('错误码走白名单错误；无 download_url 明确报错；空 file_id 拒绝', async () => {
tests/unit/minimax-video-client.test.js:61:  it('错误体白名单：只透 status_code/status_msg，不带原始计费字段', async () => {
tests/unit/routes/noe-media-routes.test.js:58:  it('image：缺 prompt 400；正常调 studio.image 带白名单 opts', async () => {
tests/unit/routes/noe-mind-routes.test.js:375:  it('裁决：合法 outcome 结算；高惊奇触发好奇回路（NOE_CURIOSITY=1 时）+ 情感评估', () => {
tests/unit/routes/noe-mind-routes.test.js:376:    const prevCur = process.env.NOE_CURIOSITY;
tests/unit/routes/noe-mind-routes.test.js:377:    process.env.NOE_CURIOSITY = '1';
tests/unit/routes/noe-mind-routes.test.js:395:      if (prevCur === undefined) delete process.env.NOE_CURIOSITY; else process.env.NOE_CURIOSITY = prevCur;
tests/unit/noe-surprise-origin-bucketing.test.js:7:import { deriveSurpriseOrigin, isLoosenOnlyFailure, isNonNoiseSurpriseOrigin } from '../../src/cognition/NoeExpectationResolver.js';
tests/unit/noe-surprise-origin-bucketing.test.js:12:  describe('deriveSurpriseOrigin（F2：据 source 推导，不硬编码 action_failure）', () => {
tests/unit/noe-surprise-origin-bucketing.test.js:14:      expect(deriveSurpriseOrigin('action', { loosenOnly: true })).toBe('loosen_fail');
tests/unit/noe-surprise-origin-bucketing.test.js:15:      expect(deriveSurpriseOrigin('owner-pred:topic', { loosenOnly: true })).toBe('loosen_fail');
tests/unit/noe-surprise-origin-bucketing.test.js:18:      expect(deriveSurpriseOrigin('owner-pred:topic')).toBe('owner_prediction');
tests/unit/noe-surprise-origin-bucketing.test.js:19:      expect(deriveSurpriseOrigin('owner-pred:followup')).toBe('owner_prediction');
tests/unit/noe-surprise-origin-bucketing.test.js:20:      expect(deriveSurpriseOrigin('reflection')).toBe('reflection_miss');
tests/unit/noe-surprise-origin-bucketing.test.js:21:      expect(deriveSurpriseOrigin('action')).toBe('action_failure');
tests/unit/noe-surprise-origin-bucketing.test.js:22:      expect(deriveSurpriseOrigin('noe.goal_step.act')).toBe('action_failure');
tests/unit/noe-surprise-origin-bucketing.test.js:25:      expect(deriveSurpriseOrigin('transaction')).toBe('expectation_miss');
tests/unit/noe-surprise-origin-bucketing.test.js:26:      expect(deriveSurpriseOrigin('interaction')).toBe('expectation_miss');
tests/unit/noe-surprise-origin-bucketing.test.js:27:      expect(deriveSurpriseOrigin('owner_interaction')).toBe('owner_prediction'); // owner 前缀优先于 action
tests/unit/noe-surprise-origin-bucketing.test.js:30:      expect(deriveSurpriseOrigin('thought')).toBe('expectation_miss');
tests/unit/noe-surprise-origin-bucketing.test.js:31:      expect(deriveSurpriseOrigin('self-observation')).toBe('expectation_miss');
tests/unit/noe-surprise-origin-bucketing.test.js:32:      expect(deriveSurpriseOrigin(undefined)).toBe('expectation_miss');
tests/unit/noe-surprise-origin-bucketing.test.js:47:  describe('isNonNoiseSurpriseOrigin（F3：门 b 判据）', () => {
tests/unit/noe-surprise-origin-bucketing.test.js:49:      expect(isNonNoiseSurpriseOrigin('owner_prediction')).toBe(true);
tests/unit/noe-surprise-origin-bucketing.test.js:50:      expect(isNonNoiseSurpriseOrigin('owner_manual')).toBe(true);
tests/unit/noe-surprise-origin-bucketing.test.js:51:      expect(isNonNoiseSurpriseOrigin('action_failure')).toBe(true);
tests/unit/noe-surprise-origin-bucketing.test.js:54:      expect(isNonNoiseSurpriseOrigin('loosen_fail')).toBe(false);
tests/unit/noe-surprise-origin-bucketing.test.js:55:      expect(isNonNoiseSurpriseOrigin('expectation_miss')).toBe(false);
tests/unit/noe-surprise-origin-bucketing.test.js:56:      expect(isNonNoiseSurpriseOrigin('unspecified')).toBe(false);
tests/unit/noe-surprise-origin-bucketing.test.js:85:      expect(bd.nonNoise).toBe(2); // action_failure + owner_prediction
tests/unit/noe-surprise-origin-bucketing.test.js:96:      expect(s.surpriseOrigins.nonNoise).toBe(1); // owner_prediction
tests/unit/noe-surprise-origin-bucketing.test.js:107:      expect(bd.nonNoise).toBe(1); // 仅 owner_manual
tests/unit/routes/readonly-auth-guard.test.js:2:// 背景：Origin 白名单只防浏览器跨域，不防本机其他进程 curl；conversation/任务 prompt/会话痕迹
tests/unit/noe-episodic-timeline.test.js:52:  it('record：写入情景，类型白名单兜底、summary 必填、salience clamp', () => {
tests/unit/noe-episodic-timeline.test.js:63:    expect(fake.rows[3].payload.episodeType).toBe('setback');   // 关键：setback 已进白名单，端到端不被改写
tests/unit/noe-db-backup.test.js:72:    writeFileSync(join(stateDir, 'license.txt'), 'payload.sig'); // 2026-06-11 收编：license 误删事故后进白名单
tests/unit/noe-capability-executor.test.js:66:  it('非法包名 → throw（源白名单/包名校验）', async () => {

exec
/bin/zsh -lc "nl -ba src/server/routes/noeMind.js | sed -n '588,616p'" in /Users/hxx/Desktop/Neo 贾维斯
 succeeded in 0ms:
   588	    } catch (e) { sendError(res, e); }
   589	  });
   590
   591	  // 裁决一条预测：outcome=1 应验 / 0 落空 / null 判不了。高惊奇 → 好奇回路立研究目标 + 情感评估。
   592	  app.post('/api/noe/mind/expectations/resolve', requireOwnerToken, (req, res) => {
   593	    try {
   594	      if (!expectationLedger) return res.status(409).json({ ok: false, error: '期望账本未通电（NOE_EXPECTATIONS）' });
   595	      const body = req.body || {};
   596	      const id = Number(body.id);
   597	      if (!Number.isFinite(id) || id <= 0) return res.status(400).json({ ok: false, error: 'id 非法' });
   598	      const outcome = body.outcome === 1 || body.outcome === true ? 1 : body.outcome === 0 || body.outcome === false ? 0 : null;
   599	      const r = expectationLedger.resolve(id, outcome, undefined, 'owner'); // P2-F2：owner 手动裁决 = holdout 旁证（非本地脑自评）
   600	      if (!r) return res.status(404).json({ ok: false, error: '不存在或已结算' });
   601	      let curiosityGoalId = null;
   602	      if (outcome !== null && Number(r.surprise) >= 2 && goalSystem && process.env.NOE_CURIOSITY === '1') {
   603	        try { curiosityGoalId = goalSystem.harvestSurprise({ claim: r.claim, surprise: r.surprise, origin: outcome === 0 ? 'owner_manual' : undefined }); } catch { /* 好奇失败不阻断裁决 */ } // P1-C 整改 F4+F4-REOPEN：仅 owner 手动判落空(outcome=0)标 owner_manual 非噪声；应验(outcome=1)的高惊奇不误计入门 b，与 resolver/predictor 的 outcome===0 闸一致
   604	      }
   605	      if (outcome !== null && affectEngine) {
   606	        // 被裁决=一次现实反馈：应验微暖；落空保留 novelty→唤醒上扬（好奇/警觉，注意力信号，原设计精神）。
   607	        // NOE_AFFECT_NEGATIVE 开时落空给中等 valence(-0.3)：owner 主动裁决「判错了」该有承认挫败的分量，但不重击
   608	        // （act 失败的 setback=-0.5 才是 v 跌主力，预测落空是次要信号）；默认 OFF 保持原 -0.1。
   609	        try { affectEngine.appraise({ goalCongruence: outcome === 1 ? 0.3 : (process.env.NOE_AFFECT_NEGATIVE === '1' ? -0.3 : -0.1), novelty: Math.min(1, (r.surprise || 0) / 4) }, { cause: `expectation:${id}` }); } catch { /* 评估失败忽略 */ }
   610	      }
   611	      // 主人裁决=明确"在理 Noe"的互动（A1 修复，2026-06-11）：回应判定/工作区 owner 信号的数据源。
   612	      // 聊天室刻意不记 interaction（对象是任意 AI，见 SoloChatDispatcher 注释）→ 透视页操作是文字时代
   613	      // owner-Noe 互动的主通道，必须记，否则开口回应永远 miss、冷却被放宽到 4h（实损：30 天回应率 0%）。
   614	      try { timeline?.record?.({ type: 'interaction', summary: `主人裁决了我的预测「${String(r.claim || '').slice(0, 30)}」：${outcome === 1 ? '应验' : outcome === 0 ? '落空' : '判不了'}`, salience: 3 }); } catch { /* 留痕失败不阻断 */ }
   615	      res.json({ ok: true, resolved: r, curiosityGoalId });
   616	    } catch (e) { sendError(res, e); }

exec
/bin/zsh -lc "rg -n \"settleFromOwnerText|predictFromOwnerText|NoeOwnerBehaviorPredictor|ownerBehavior|owner_predict\" server.js src -g '*.js'" in /Users/hxx/Desktop/Neo 贾维斯
 succeeded in 0ms:
server.js:295:import { createOwnerBehaviorPredictor, createOwnerInteractionWatcher } from './src/cognition/NoeOwnerBehaviorPredictor.js';
server.js:2070:    const ownerBehaviorPredictor = createOwnerBehaviorPredictor({ ledger: noeExpectationLedger, goalSystem: noeGoalSystem });
server.js:2073:      predictor: ownerBehaviorPredictor,
server.js:2108:        openPredictions: () => ownerBehaviorPredictor.openOwnerPredictions(),
src/cognition/NoeOwnerBehaviorPredictor.js:2:// NoeOwnerBehaviorPredictor — owner 行为预测最小闭环（codex 建议的功能性自我意识项）。
src/cognition/NoeOwnerBehaviorPredictor.js:140:  function settleFromOwnerText(text) {
src/cognition/NoeOwnerBehaviorPredictor.js:170:            try { goalSystem.harvestSurprise({ claim: row.claim, surprise: resolvedRow.surprise, origin: 'owner_prediction' }); } // P1-C：owner 明确否定 followup = owner 真实负反馈（门 b 非噪声）
src/cognition/NoeOwnerBehaviorPredictor.js:184:  function predictFromOwnerText(text, { isDelegation = null } = {}) {
src/cognition/NoeOwnerBehaviorPredictor.js:227:    const settled = settleFromOwnerText(text);
src/cognition/NoeOwnerBehaviorPredictor.js:228:    const predicted = predictFromOwnerText(text, { isDelegation });
src/cognition/NoeOwnerBehaviorPredictor.js:237:  return { observeOwnerInteraction, settleFromOwnerText, predictFromOwnerText, openOwnerPredictions };
src/cognition/_mathUtils.js:6://   NoeCuriosityDecompose / NoeOwnerBehaviorPredictor）此前各自重复定义了字节级完全一致的
src/cognition/NoeSleepTimeCompute.js:5:// 问题：owner 真问出来那一刻才现算检索/上下文，会让首字延迟堆在 turn 上。但 NoeOwnerBehaviorPredictor
src/cognition/NoeSleepTimeCompute.js:10://   ② 从 openPredictions() 取「owner 下一问」候选主题（复用 NoeOwnerBehaviorPredictor.openOwnerPredictions，
src/cognition/NoeSleepTimeCompute.js:43: *   openPredictions?: (() => Array<{claim:string,p?:number}>)|null, // 通常 = ownerBehaviorPredictor.openOwnerPredictions
src/cognition/NoeExpectationResolver.js:583:export const SURPRISE_ORIGIN_ENUM = Object.freeze(['loosen_fail', 'owner_prediction', 'owner_manual', 'reflection_miss', 'action_failure', 'expectation_miss']);
src/cognition/NoeExpectationResolver.js:587:  if (/owner|followup/.test(s)) return 'owner_prediction';

exec
/bin/zsh -lc "nl -ba server.js | sed -n '2060,2115p'" in /Users/hxx/Desktop/Neo 贾维斯
 succeeded in 0ms:
  2060	      }),
  2061	    });
  2062	    console.log('[noe-expectations] 到期自动判证已启用（本地脑 · 宁缺勿错判 · 透视页人工裁决可覆盖）');
  2063	  }
  2064	  // owner 行为预测最小闭环（功能性自我意识：对外部 owner 下注 → owner 真实后续行为硬纠正 → 进 Brier）。
  2065	  //   零 LLM 确定性预测：owner 交互后预测「还会再提到某主题」/「交办后会要求实测·回报·采纳」；后续 owner
  2066	  //   真做了 → resolve(1) 进校准账本。读 timeline 的 interaction 经历当 owner 信号（不碰前台派发文件），
  2067	  //   心跳顺风车驱动（与 expectation/harvest 同款「作业读 store」）。三重门控：NOE_OWNER_PREDICTION=1
  2068	  //   + noeExpectationLedger（NOE_EXPECTATIONS=1）+ NOE_HEARTBEAT=1；OFF 时整块不进，账本/Brier/心跳零回归。
  2069	  if (noeExpectationLedger && process.env.NOE_OWNER_PREDICTION === '1') {
  2070	    const ownerBehaviorPredictor = createOwnerBehaviorPredictor({ ledger: noeExpectationLedger, goalSystem: noeGoalSystem });
  2071	    const ownerInteractionWatcher = createOwnerInteractionWatcher({
  2072	      timeline: noeEpisodicTimeline,
  2073	      predictor: ownerBehaviorPredictor,
  2074	      kv: { get: kvGet, set: kvSet },
  2075	    });
  2076	    const ownerPredMs = Math.max(60_000, Number(process.env.NOE_OWNER_PREDICTION_MS) || 5 * 60_000);
  2077	    noeHeartbeat.register('ownerPrediction', {
  2078	      cadenceMs: ownerPredMs,
  2079	      catchUp: 'drop',
  2080	      run: () => ownerInteractionWatcher.tick(),
  2081	    });
  2082	    console.log('[noe-owner-prediction] owner 行为预测已启用（确定性预测 · owner 后续行为结算 → Brier · 顺风车读 interaction 经历 · 零 LLM · fail-open）');
  2083	    // sleep-time compute（空闲预计算）：无活跃对话时用「owner 下一问」预测主题预算候选上下文(检索)写入预取池，
  2084	    //   下一 turn 命中即秒答。四重门控：NOE_SLEEPTIME_COMPUTE=1 + 上面三门(NOE_OWNER_PREDICTION/EXPECTATIONS/HEARTBEAT)。
  2085	    //   OFF 时整个 if 不进：不 new、不 register、noeSleepTimeCompute/sleepTimeIsOwnerActive 保持 null → 预取池无 sleeptime: 键、
  2086	    //   心跳无该游标、零模型调用零开销零回归。idle-only + 可取消 + 候选(非答案)带 source+TTL + 不设硬超时 + fail-open 由模块内保证。
  2087	    if (process.env.NOE_SLEEPTIME_COMPUTE === '1') {
  2088	      const sleepIdleMs = Math.max(60_000, Number(process.env.NOE_SLEEPTIME_IDLE_MS) || 5 * 60_000);
  2089	      // 空闲判定(照 line 988 先例)：最近一次 owner interaction 距今 > 阈值即视为空闲；无 interaction 也算空闲。
  2090	      const lastOwnerInteractionAt = () => {
  2091	        try { return noeEpisodicTimeline.recent({ limit: 20, types: ['interaction'] })[0]?.ts ?? 0; } catch { return 0; }
  2092	      };
  2093	      const sleepTimeIsIdle = () => { const last = lastOwnerInteractionAt(); return last <= 0 || (Date.now() - last) >= sleepIdleMs; };
  2094	      // owner 活跃 = 不空闲(供 proactive 包裹近即时 cancel 用)；探测抛错按非活跃处理(fail-open，不误杀正常预计算)。
  2095	      sleepTimeIsOwnerActive = () => { try { return sleepTimeIsIdle() !== true; } catch { return false; } };
  2096	      // precompute 注入：用主项目检索器(本地、廉价)把主题检索成候选上下文文本；不调 LLM(只检索)，signal 一旦 abort 尽快退出。
  2097	      //   不设硬超时(本地检索/embedding JIT 慢正常)；检索失败/空返回 null → 模块跳过该主题(fail-open)。
  2098	      const sleepTimePrecompute = async (topic, { signal }) => {
  2099	        if (!noeMemoryRetriever?.retrieve || signal?.aborted) return null;
  2100	        let res;
  2101	        try { res = await noeMemoryRetriever.retrieve({ transcript: String(topic || ''), routeType: 'chat', limit: 5 }); } catch { return null; }
  2102	        if (signal?.aborted || !res?.ok || !Array.isArray(res.selected) || !res.selected.length) return null;
  2103	        const lines = res.selected.slice(0, 5).map((m) => '- ' + String(m?.text || m?.content || m?.summary || '').replace(/\s+/g, ' ').trim().slice(0, 200)).filter((s) => s.length > 2);
  2104	        return lines.length ? `关于「${topic}」的相关记忆候选：\n${lines.join('\n')}` : null;
  2105	      };
  2106	      noeSleepTimeCompute = createSleepTimeCompute({
  2107	        prefetchStore: noePrefetchStore,
  2108	        openPredictions: () => ownerBehaviorPredictor.openOwnerPredictions(),
  2109	        precompute: sleepTimePrecompute,
  2110	        isIdle: sleepTimeIsIdle,
  2111	      });
  2112	      const sleepTimeMs = Math.max(120_000, Number(process.env.NOE_SLEEPTIME_COMPUTE_MS) || 5 * 60_000);
  2113	      noeHeartbeat.register('sleeptimeCompute', {
  2114	        cadenceMs: sleepTimeMs,
  2115	        catchUp: 'drop',

exec
/bin/zsh -lc 'rg -n "NOE_OWNER_PREDICTION|NOE_STEP_EXPECTATION_RESOLVE" server.js docs/ROADMAP_Neo觉醒路线_P0-P15_2026-06-15.md docs/research/_阶段1复盘_context.md' in /Users/hxx/Desktop/Neo 贾维斯
 succeeded in 0ms:
docs/research/_阶段1复盘_context.md:16:- flag `NOE_STEP_EXPECTATION_RESOLVE` 默认 OFF（OFF 时 onStepFailed 直接 return null，零行为）。
docs/ROADMAP_Neo觉醒路线_P0-P15_2026-06-15.md:27:| 断点 2 | **NOE_OWNER_PREDICTION 默认 OFF** | 缺「产生真实落空」最直接的源（owner 真实行为是骗不了的外部信号） | `server.js:2024` |
docs/ROADMAP_Neo觉醒路线_P0-P15_2026-06-15.md:83:`NOE_INTEGRATION_METRIC`（整合度 TC，已接 heartbeat `server.js:2129`）/ `NOE_EFE_CURIOSITY`（好奇双因子，已三处注入）/ `NOE_THOUGHT_LOOP_GUARD`（防连击，已接 Workspace+InnerMonologue）/ `NOE_OWNER_PREDICTION`（**断点 2**）/ `NOE_REFLECT_TIER` / `NOE_REFLECTIVE_TUNER`（GEPA shadow）/ `NOE_MOOD_MODEL` / `NOE_PERSONALITY_SNAPSHOT` / `NOE_CHAT_CONTEXT`（TurnContextEngine 注入文字聊天）/ 记忆 7 增量（`NOE_MEMORY_DEDUP/CONFLICT_POLICY/DEDUP_SEMANTIC/FISHER_RANK/SALIENCE_FUSION/DYNAMIC_DECAY/MEMORY_GC`）/ `NOE_CAPABILITY_ACQUISITION` / `NOE_SELF_EVOLUTION`+`_EXECUTORS`（记忆载 owner 2026-06-14 已在 `.env` 裸放开，运行态以 `.env` 为准）
docs/ROADMAP_Neo觉醒路线_P0-P15_2026-06-15.md:148:  2. **通电 NOE_OWNER_PREDICTION=1**（治断点 2）：owner 真实后续硬纠正 owner 预测 = 产 `outcome=0`。**注意仅 owner 明确否定 followup 才判落空**（`NoeOwnerBehaviorPredictor.js:148`；topic 预测/沉默/换话题永不落空）→ 冷启动燃料、**非稳态发动机**（见 §2 原则 4）。
server.js:49:  NOE_OWNER_PREDICTION: '1', // P1-B：owner 行为预测作业（预测 owner followup→judge 据实判 outcome，闭环冷启动燃料）
server.js:1595:      // 阶段1：act/research step 真失败 → 登记预测→outcome=0→harvestSurprise，接通好奇回路供给端（NOE_STEP_EXPECTATION_RESOLVE 默认 OFF）
server.js:2067:  //   心跳顺风车驱动（与 expectation/harvest 同款「作业读 store」）。三重门控：NOE_OWNER_PREDICTION=1
server.js:2069:  if (noeExpectationLedger && process.env.NOE_OWNER_PREDICTION === '1') {
server.js:2076:    const ownerPredMs = Math.max(60_000, Number(process.env.NOE_OWNER_PREDICTION_MS) || 5 * 60_000);
server.js:2084:    //   下一 turn 命中即秒答。四重门控：NOE_SLEEPTIME_COMPUTE=1 + 上面三门(NOE_OWNER_PREDICTION/EXPECTATIONS/HEARTBEAT)。

codex
我发现一个和方案文档不一致的点：方案要求 `harvestSurprise` 做 origin 白名单硬门，但当前 `NoeGoalSystem.harvestSurprise` 本身只记录/分桶 origin，并不拒绝非白名单来源；这会进入 reward-hacking 结论。
exec
/bin/zsh -lc 'git status --short' in /Users/hxx/Desktop/Neo 贾维斯
exec
/bin/zsh -lc "nl -ba docs/research/_claude-自主学习方案.md | sed -n '8,16p'" in /Users/hxx/Desktop/Neo 贾维斯
 succeeded in 0ms:
     8	验收: 隔离端口 30min:self_learning 新增目标≤2(原~30);skill_distill 新卡相似度>0.9 的被 skip 计数>0;反向 probe INTERVAL=60s 目标流加快。全部不需新认知模块,失败可立即把 .env 三值改回。
     9
    10	### 阶段 1 · 修活预测-判证-供给闭环(接通好奇回路的入口,治 R5/R5b — 这是最根本的一步)
    11	核心洞察(DB 实证倒逼):好奇回路死的真根因不是 harvestSurprise 门槛,是判证供给端永远没有 outcome=0。最小改造分两半:(A)【补可程序化判落空的供给】act/research 步的真实终态(done/failed/blocked)本身就是对『这步会成功』这条隐式预测的判证 — 新建一条轻量旁路:goal step 落 failed/blocked 时,对该步骤当时若登记过 expectation 直接 resolve(outcome=0),让 outcome=0 真能产生(不依赖 LLM 判证器看懂证据)。这绕开 R5b 的 UNKNOWN 偏置瓶颈。(B)【给 resolver 减压】NOE_EXPECT_LOOSEN_FAIL=1 + 提高 maxPerTick(3→8)+ 缩 RESOLVE_MS(让 243 条过期 open 加速消化)。防 reward hacking(红队点 R1):outcome=0 只采纳『真实世界终态失败/owner 否定』(surpriseOriginBreakdown 已分桶 owner_/action_failure 为非噪声),绝不让 Neo 自评 outcome 主导 — 即 surprise 来源必须是 action_failure/owner_prediction/owner_manual 三类硬来源之一,自评类一律不喂 harvestSurprise。
    12	文件: 新增 src/cognition/NoeStepExpectationBridge.js(<150行,纯函数+DI,把 step 终态映射成 expectation resolve,门控 NOE_STEP_EXPECTATION_RESOLVE 默认 OFF);改 NoeExpectationResolver.js(maxPerTick/loosenFail 经注入,不改判证规则);改 harvestSurprise 入口加 origin 白名单硬门(NoeGoalSystem.js:556)
    13	验收: 隔离端口跑含已知会失败的 act 步(故意指向不存在的 app):DB 中 noe_expectations 出现 outcome=0 条目(原恒 0);若该 surprise≥阈值且 origin∈白名单,noe_goals 出现 source='surprise' 条目(原恒 0)。反向 probe(防刷分):喂一条 self-evaluated 的假落空(origin 非白名单),验证 harvestSurprise 拒绝立目标。再 probe:resolver 一跳判证数从≤3 升到≤8。
    14
    15	### 阶段 2 · 修记忆回流(让真知识存在且可被召回,治 R6/R7/R8 — 没有这步,后面的度量全是度量空气)
    16	三个改造让『真知识进得去、出得来、不重复』:(A)【蒸馏输入换成真页面正文】distillSkill 的 prompt 从喂 `goal.title+step+note80字` 改成喂 observe_page 的 read_body 摘要(NoeWorkspace summarizeActOutput 已摘到1200字,把它透到蒸馏);prompt 加约束『必须含至少一个具体库名/API/配置键,否则输出 SKIP』(治 R7 同质方法论)。防幻构(红队点):蒸馏后对具体名称做 noe_memory FTS5 二次存在性校验,查无则降 confidence 不入库。(B)【research 报告独立入记忆】DeepResearcher 报告写一条 scope=knowledge 记忆带 sourceUrl,放宽 NoeWorkspace.js:493 的400字截断或存指针(治 R8 无持久载体)。(C)【写门加语义去重】NoeMemoryWriteGate.commit 对 skill 类:新卡与近期同类卡 textSimilarity>0.85 则 merge(更新 evidence_refs)而非新增,0.5-0.85 写『增量卡』标注补充了什么,<0.5 全新(治 R6 堆积,实现 ADD/MERGE/PRUNE 语义)。去重保守:仅近期窗口+高阈值+merge 不 delete,保 provenance(防红队点 R5 吞真知识)。一次性 GC 现存 346 死卡按红线7先 dry-run 看命中范围再清。

exec
/bin/zsh -lc "nl -ba docs/research/_阶段1复盘_context.md | sed -n '1,40p'" in /Users/hxx/Desktop/Neo 贾维斯
 succeeded in 0ms:
     1	# 阶段1「修活好奇回路供给端」复盘 context（喂三方：M3 / codex GPT5.5 / Claude）
     2
     3	## 背景：要彻底根除的问题
     4	Neo 自主学习空耗。多模型研究 DB 实证最深根因（R5/R5b）：
     5	- noe_goals source='surprise' 好奇目标 = **0 条**（从未产生过）；noe_expectations outcome=0 落空 = **0 条**；
     6	  resolver 整个生命周期只判过 **2 条**（343 预测淤积未判证）。
     7	- 即「被现实打脸→惊奇→主动学习」引擎从没接通，真根因是判证供给端**永远没有 outcome=0 喂进来**。
     8
     9	## 阶段1 已做的修复（要复盘的对象，git 已 commit）
    10	新建 `src/cognition/NoeStepExpectationBridge.js`：
    11	- `onStepFailed({stepText, kind, terminal})`：act/research step 真失败（terminal=failed/blocked）时 →
    12	  `expectationLedger.add({claim:"完成步骤：X", p:0.8, source:'step_prediction'})` → 立即 `resolve(id, 0)`（outcome=0）
    13	  → surprise=-log2(0.2)=2.32bit → `goalSystem.harvestSurprise({claim, surprise, origin:'action_failure'})`。
    14	- 接 `NoeWorkspace.js` 三个失败点：act blocked（安全门拦/不放行）、act error（runAct 抛错）、research failed。
    15	- server.js 装配注入（`createStepExpectationBridge({expectationLedger, goalSystem})`）。
    16	- flag `NOE_STEP_EXPECTATION_RESOLVE` 默认 OFF（OFF 时 onStepFailed 直接 return null，零行为）。
    17
    18	### 已设的防 reward hacking
    19	① origin 固定 'action_failure'（硬来源，isNonNoiseSurpriseOrigin 认非噪声）；② 只认 act/research 真实终态失败
    20	（ActPipeline 安全门/执行错/研究失败，非 think 主观、非 Neo 自评 outcome）；③ harvestSurprise 自带标题去重
    21	（同 claim 不重复立好奇目标）；④ flag 默认 OFF。
    22
    23	### 端到端验证（隔离 sqlite + 真 ledger + 真 goalSystem）已通过
    24	act 失败 → outcome=0（原恒 0 → 现 1）→ source=surprise 好奇目标（原恒 0 → 现 1，"搞明白为什么没料到：完成步骤…"）；
    25	反向 probe：think 不触发 / act done 成功不触发 / flag OFF 零行为。8 单测 + 全量 5081 测全绿。
    26
    27	### 暂未做（研究方案的阶段1-B，待复盘判断是否必要）
    28	resolver 减压（NoeExpectationResolver maxPerTick 3→8 + NOE_EXPECT_LOOSEN_FAIL=1 + 缩 RESOLVE_MS），用于消化
    29	343 条淤积的 open 预测。bridge 走的是「step 失败直接产 outcome=0」旁路，绕开了 resolver 的 UNKNOWN 偏置瓶颈。
    30
    31	## 请三方彻底审查（目标：根除，不是打补丁）
    32	1. **reward hacking 是否真堵死**：Neo 会不会学会「故意立会失败的 act/research step」来刷 surprise→刷好奇目标？
    33	   action_failure 来自真实失败，但 Neo 立 act 的动机若被 surprise 奖励污染会怎样？现有 4 道防护够吗？还缺什么？
    34	2. **是否真接通了「学习」闭环**：bridge 立的 source=surprise 好奇目标，它的 steps 是什么？会不会又陷入
    35	   6 主题空耗 / 同质蒸馏（阶段2/3 的病）？「惊奇→立目标→真学到东西」这条线是否完整，还是只接通了前半截？
    36	3. **设计遗漏 / 更深根因**：除了 step 失败，还有哪些「被现实打脸」的源没接（owner 否定预测？读到与世界模型
    37	   矛盾的页面？）？只接 step 失败够不够「修活好奇回路」，还是治标？
    38	4. **阶段1-B 必要性**：343 淤积 open 预测要不要管？不管会怎样？bridge 旁路够不够？
    39	5. **代码正确性 + 边界**：dueAt=now() 立即到期 resolve 对吗？add 去重（textSimilarity）会不会把不同失败误判重复？
    40	   surprise 计算、3 个接入点覆盖是否完整（有没有漏的失败路径）？fail-open？

exec
/bin/zsh -lc "nl -ba src/cognition/NoeExpectationResolver.js | sed -n '580,600p'" in /Users/hxx/Desktop/Neo 贾维斯
 succeeded in 0ms:
   580	const FAILURE_SIGNAL_RE_LOOSE = /^(?:status|outcome|result)=(?:failed|failure|error|blocked|rejected|timeout|cancelled|canceled|aborted|denied|killed|expired|unsuccessful)$|^(?:failed|error|cancelled|canceled|aborted|timeout)=true$|^ok=false$/i;
   581
   582	// P1-C 整改（双代理验收 F1+F2）：surprise 来源分桶——据预测 source + loosen 检测推导 origin，供验收门 b 区分非噪声。
   583	export const SURPRISE_ORIGIN_ENUM = Object.freeze(['loosen_fail', 'owner_prediction', 'owner_manual', 'reflection_miss', 'action_failure', 'expectation_miss']);
   584	export function deriveSurpriseOrigin(source, { loosenOnly = false } = {}) {
   585	  if (loosenOnly) return 'loosen_fail'; // F1：仅因 NOE_EXPECT_LOOSEN_FAIL 放宽失败正则才认的落空 = 门 b 要剔除的噪声
   586	  const s = String(source || '').toLowerCase();
   587	  if (/owner|followup/.test(s)) return 'owner_prediction';
   588	  if (/reflect/.test(s)) return 'reflection_miss';
   589	  if (/(?:^|[._:\s-])(?:act|action|goal|task|execut|step|checkpoint)(?=$|[._:\s-])/.test(s)) return 'action_failure'; // 复核 DERIVE-REGEX：分隔符词界防 transaction/interaction/steps 子串误命中
   590	  return 'expectation_miss'; // F2：thought/self-obs 等非 action 预测不再被误标 action_failure
   591	}
   592	// P1-C 整改 F3：验收门 b 判据——owner_*/action_failure 是 owner+action 类「非噪声」surprise；loosen_fail/reflection_miss/expectation_miss 不计。
   593	export function isNonNoiseSurpriseOrigin(origin) {
   594	  return /^owner_|^action_failure$/.test(String(origin || ''));
   595	}
   596	// loosen-only 失败：evidence 含 loose 专属失败词(cancelled/aborted/…)但不含 base 失败词(failed/error/…)→ 该落空仅靠放宽正则才认成
   597	export function isLoosenOnlyFailure(evidenceText, loosenFail) {
   598	  if (!loosenFail || !evidenceText) return false;
   599	  const hasBase = /\b(?:failed|failure|error|blocked|rejected|timeout)\b|\bok=false\b|\b(?:failed|error)=true\b/i.test(evidenceText); // 复核 F1-HASBASE：补 BASE 结构化信号(ok=false/failed=true/error=true)，仅含结构化真失败不被误判 loosen-only 噪声
   600	  const hasLooseOnly = /\b(?:cancelled|canceled|aborted|denied|killed|expired|unsuccessful)\b/i.test(evidenceText);

 succeeded in 687ms:
?? "docs/research/_m3-\351\230\266\346\256\2651\345\244\215\347\233\230.md"
?? "docs/research/_\351\230\266\346\256\2651\345\244\215\347\233\230_context.md"

exec
/bin/zsh -lc "rg -n \"function parseActStepLine|parseActStepLine\" -n src/cognition/NoeWorkspace.js && nl -ba src/cognition/NoeWorkspace.js | sed -n '60,115p'" in /Users/hxx/Desktop/Neo 贾维斯
 succeeded in 0ms:
102:function parseActStepLine(line) {
591:              return parseActStepLine(text);
    60	const DELIB_KV_KEY = 'noe.workspace.deliberations';
    61	const SECRET_TEXT_RE = /((?:api[_-]?key|authorization|bearer|cookie|credential|password|private[_-]?key|refresh[_-]?token|secret|session[_-]?token|token)\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;}]+)/gi;
    62	const SENSITIVE_PAYLOAD_KEY_RE = /api[_-]?key|authorization|bearer|cookie|credential|password|private[_-]?key|refresh[_-]?token|secret|session[_-]?token|token/i;
    63	const QUIET_SYSTEM_REPAIR_RE = /^系统自修复：/;
    64
    65	function redactText(value) {
    66	  return String(value || '')
    67	    .replace(SECRET_TEXT_RE, '$1[REDACTED]')
    68	    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [REDACTED]')
    69	    .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, '[REDACTED_KEY]');
    70	}
    71
    72	function compactText(value, max) {
    73	  return redactText(value).replace(/\s+/g, ' ').trim().slice(0, max);
    74	}
    75
    76	function formatVisionSituation(situation) {
    77	  if (!situation || typeof situation !== 'object') return '';
    78	  const interrupt = situation.shouldInterrupt === true ? '建议轻触提醒' : '不建议打扰';
    79	  return `；处境=${compactText(situation.activity || 'unknown', 40)}/${compactText(situation.attention || 'unknown', 40)}；可能需要=${compactText(situation.possibleNeed || 'unknown', 60)}；${interrupt}；置信度=${Number(situation.confidence || 0).toFixed(2)}`;
    80	}
    81
    82	function sanitizeActPayload(value, depth = 0) {
    83	  if (depth > 5) return null;
    84	  if (value === null || value === undefined) return null;
    85	  if (typeof value === 'string') return redactText(value).slice(0, 20_000);
    86	  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
    87	  if (typeof value === 'boolean') return value;
    88	  if (Array.isArray(value)) return value.slice(0, 40).map((item) => sanitizeActPayload(item, depth + 1)).filter((item) => item !== null && item !== undefined);
    89	  if (typeof value === 'object') {
    90	    const out = {};
    91	    for (const [key, item] of Object.entries(value).slice(0, 80)) {
    92	      const k = String(key || '').slice(0, 120);
    93	      if (!k || SENSITIVE_PAYLOAD_KEY_RE.test(k)) continue;
    94	      const next = sanitizeActPayload(item, depth + 1);
    95	      if (next !== null && next !== undefined) out[k] = next;
    96	    }
    97	    return Object.keys(out).length ? out : null;
    98	  }
    99	  return null;
   100	}
   101
   102	function parseActStepLine(line) {
   103	  const text = String(line || '').trim();
   104	  const m = text.match(/^\[act:([\w.\-]+)(?:\s+(\{.*\}))?\]\s*(.{2,})$/);
   105	  if (!m) return text;
   106	  let payload = null;
   107	  if (m[2] && m[2].length <= 4000) {
   108	    try { payload = sanitizeActPayload(JSON.parse(m[2])); } catch { payload = null; }
   109	  }
   110	  return {
   111	    step: m[3].trim(),
   112	    kind: 'act',
   113	    action: m[1],
   114	    ...(payload && typeof payload === 'object' ? { payload } : {}),
   115	  };

exec
/bin/zsh -lc "nl -ba src/cognition/NoeDeliberation.js | sed -n '70,120p'" in /Users/hxx/Desktop/Neo 贾维斯
 succeeded in 0ms:
    70	   * 对一个焦点做一轮审议。
    71	   * @param {{topic: string, context?: string}} input
    72	   * @returns {Promise<{deliberated: boolean, text?: string, prediction?: object|null, share?: string|null, eventId?: number, reason?: string}>}
    73	   */
    74	  return async function deliberate({ topic, context = '' } = {}) {
    75	    const focus = String(topic || '').trim();
    76	    if (!focus) return { deliberated: false, reason: 'no_topic' };
    77	    const adapter = getAdapter?.(brainAdapterId);
    78	    if (!adapter?.chat) return { deliberated: false, reason: 'no_brain' };
    79	    // 校准注入（M11）：把"我历史预测的准头"带进深思——下注时知道自己有多容易过度自信
    80	    let calibration = '';
    81	    if (ledger?.calibrationNote) {
    82	      try { const note = String(ledger.calibrationNote() || '').trim(); if (note) calibration = `\n\n${note}（下注概率时记得这一点）`; } catch { /* 读不到不注入 */ }
    83	    }
    84	    // 检索动作（CoALA 内部动作之二，M7）：深思前主动查长期记忆——相关事实与技能卡（上次怎么做成的）
    85	    let recalled = '';
    86	    if (memory?.recall) {
    87	      try {
    88	        const hits = memory.recall({ query: focus.slice(0, 120), projectId, limit: 3 }) || [];
    89	        const lines = (Array.isArray(hits) ? hits : []).map((h) => `- ${String(h.body || h.text || '').slice(0, 160)}`).filter((l) => l.length > 4);
    90	        if (lines.length) recalled = `\n\n我记忆里相关的经验/事实：\n${lines.join('\n')}`;
    91	      } catch { /* 召回失败不阻断深思 */ }
    92	    }
    93	    let text = '';
    94	    try {
    95	      const budget = resolveNoeOutputBudget('deep_deliberation');
    96	      const messages = [
    97	        { role: 'system', content: DELIBERATE_SYSTEM },
    98	        { role: 'user', content: `焦点：${focus}${context ? `\n\n相关背景：\n${String(context).slice(0, 1500)}` : ''}${recalled}${calibration}` },
    99	      ];
   100	      // 不设超时（跑模型纪律）；深思走本地白名单模型
   101	      const chatOnce = (temp) => adapter.chat(messages, { budgetContext: { projectId, taskId: 'noe-deliberation' }, maxTokens: budget.max_tokens, ...(typeof temp === 'number' ? { temperature: temp } : {}), ...(model ? { model } : {}) });
   102	      // 难题多候选择优（env NOE_REASONING_SEARCH ON + 有 reward）：多温度 chat 发散 → verifiableReward 打分 → beam 选最优。
   103	      const rsEnv = readReasoningSearchEnv();
   104	      // 仅难题触发多候选搜索（启发式复杂度判断），避免简单深思也 N×chat 浪费。
   105	      if (rsEnv.enabled && verifiableReward.enabled && estimateTopicComplexity(focus, context).complex) {
   106	        const rs = createReasoningSearch({
   107	          generate: async () => {
   108	            const cands = [];
   109	            for (const temp of [0.5, 0.8, 1.05]) {
   110	              try { const rr = await chatOnce(temp); if (!rr?.incomplete && rr?.reply) cands.push(cleanText(rr.reply).slice(0, 1200)); } catch { /* 单候选失败跳过，不阻断搜索 */ }
   111	            }
   112	            return cands;
   113	          },
   114	          evaluate: (node) => verifiableReward.score(node.content || '').score ?? 0,
   115	        });
   116	        const result = await rs.search({ root: '', width: 2, depth: 1, strategy: rsEnv.strategy });
   117	        text = result.best?.content || '';
   118	      }
   119	      if (!text && typeof budgetForcedThink === 'function') {
   120	        // budget forcing ON（NOE_BUDGET_FORCING=1）：先 s1 强制思考（达 min 抑制结束/超 max 收敛），

exec
/bin/zsh -lc "nl -ba src/cognition/NoeDeliberation.js | sed -n '1,55p'" in /Users/hxx/Desktop/Neo 贾维斯
 succeeded in 0ms:
     1	// @ts-check
     2	// NoeDeliberation — System2 深思审议：自我质询协议（设计文档《AI自我意识实现方案》§6.3 P3）。
     3	//
     4	// 当工作区把一个高分焦点升级给深思脑时，走固定的苏格拉底程序（单次补全内完成三步，
     5	// 本地模型对多轮工具循环不可靠，单提示三段更稳）：
     6	//   ① 立论：对焦点给出自己的判断/打算 ② 自我挑战：反例/边界/替代解释 ③ 修订：终判 + 主观概率。
     7	// 产出：审议全文记进自传体时间线（type=inner_monologue, meta.streamType='deliberation'）；
     8	//   若有「预测：…（概率 0.x）」行 → 入期望账本；若有「想说：…」行 → 交给浮现门→升华通道。
     9	// 纪律：本地深思脑（NoeReflectBrain 白名单）跑，不烧付费配额；不设超时；fail-open。
    10
    11	import { normalizeNoeAutoModel, resolveNoeOutputBudget } from '../model/NoeLocalModelPolicy.js';
    12	import { createVerifiableReward } from './NoeVerifiableReward.js';
    13	import { createReasoningSearch, readReasoningSearchEnv, estimateTopicComplexity } from './NoeReasoningSearch.js';
    14
    15	const DELIBERATE_SYSTEM = '你是 Noe 的深层思考。对给你的焦点做一轮严格的自我质询，按下面格式输出（各节 1-3 句，总共不超过 250 字）：\n'
    16	  + '【立论】我的判断或打算是什么\n'
    17	  + '【挑战】列出最有力的反例、边界情况或替代解释（挑自己的毛病，别客气）\n'
    18	  + '【修订】吸收挑战后的最终判断；我哪里仍可能错\n'
    19	  + '然后必须给出一行（这是对世界下注、事后校准自己的机会；实在无法预测就写 预测：无）：\n'
    20	  + '预测：一句与焦点相关、几天内可检验的预测（概率 0.X）\n'
    21	  + '最后视情况各附加一行（不值得就绝对不写该行）：\n'
    22	  + '想说：如果有真正值得现在告诉主人的一句话\n'
    23	  + '目标：如果这次思考让你真想做成一件具体的事（刚好够得着的小事），用一句话立项';
    24
    25	function cleanText(s) {
    26	  return String(s || '').replace(/<think>[\s\S]*?<\/think>/gi, '').replace(/<\/?think>/gi, '').trim();
    27	}
    28
    29	/** 从审议文本解析「预测：…（概率 0.x）」行。@returns {{claim:string,p:number}|null} */
    30	export function parsePrediction(text) {
    31	  const m = String(text || '').match(/预测[:：]\s*(.{4,120}?)[（(]\s*概率\s*(0?\.\d+|1(?:\.0+)?)\s*[)）]/);
    32	  if (!m) return null;
    33	  const p = Number(m[2]);
    34	  if (!Number.isFinite(p) || p <= 0 || p > 1) return null;
    35	  return { claim: m[1].trim(), p };
    36	}
    37
    38	/** 从审议文本解析「想说：…」行。@returns {string|null} */
    39	export function parseShare(text) {
    40	  const m = String(text || '').match(/想说[:：]\s*(.{2,80})/);
    41	  return m ? m[1].trim() : null;
    42	}
    43
    44	/** 从审议文本解析「目标：…」行（M8 自动课程：深思可给自己立项）。@returns {string|null} */
    45	export function parseGoal(text) {
    46	  const m = String(text || '').match(/(?:^|\n)\s*目标[:：]\s*(.{4,120})/);
    47	  if (!m) return null;
    48	  const g = m[1].trim();
    49	  return /^无[。.]?$/.test(g) ? null : g;
    50	}
    51
    52	export function createDeliberation({
    53	  getAdapter,
    54	  brainAdapterId = 'lmstudio',
    55	  model = '',                 // NoeReflectBrain 解析的深思模型；空串用 adapter 默认

exec
/bin/zsh -lc "nl -ba src/cognition/NoeDeliberation.js | sed -n '120,170p'" in /Users/hxx/Desktop/Neo 贾维斯
 succeeded in 0ms:
   120	        // budget forcing ON（NOE_BUDGET_FORCING=1）：先 s1 强制思考（达 min 抑制结束/超 max 收敛），
   121	        // 再由脑基于强制思考定稿。fail-open：抛错或截断都回落原单次 chat，绝不让深思因此挂掉。
   122	        try {
   123	          const bf = await budgetForcedThink({ messages, maxTokens: budget.max_tokens, projectId, taskId: 'noe-deliberation' });
   124	          if (bf && !bf.incomplete && bf.reply) text = cleanText(bf.reply).slice(0, 1200);
   125	        } catch { /* 回退原单次 chat */ }
   126	      }
   127	      if (!text) {
   128	        // OFF / search / budget forcing 无产出 → 单次（原行为，零回归）
   129	        const r = await chatOnce();
   130	        if (r?.incomplete) return { deliberated: false, reason: 'brain_incomplete', finishReason: r.finishReason || 'length' };
   131	        text = cleanText(r?.reply).slice(0, 1200);
   132	      }
   133	    } catch (e) {
   134	      return { deliberated: false, reason: 'brain_error', error: e?.message };
   135	    }
   136	    if (!text) return { deliberated: false, reason: 'empty' };
   137
   138	    // 给深思输出打可验证质量分（形态：分步/格式/复读）；env OFF 时 enabled:false → rewardScore 恒 null。
   139	    let rewardScore = null;
   140	    if (verifiableReward.enabled) {
   141	      try { rewardScore = verifiableReward.score(text).score; } catch { /* 评分失败不阻断深思 */ }
   142	    }
   143	    const prediction = parsePrediction(text);
   144	    const share = parseShare(text);
   145	    const goal = parseGoal(text);
   146	    let eventId;
   147	    try {
   148	      eventId = timeline?.record?.({
   149	        type: 'inner_monologue',
   150	        summary: `（深思）${focus.slice(0, 60)}：${text.slice(0, 380)}`,
   151	        detail: text,
   152	        salience: 4, // 审议比随想重要，但仍低于真实经历的身份级
   153	        selfState: selfModel?.compactState?.(selfModel?.snapshot?.()) || null,
   154	        meta: { streamType: 'deliberation', topic: focus.slice(0, 120), ...(prediction ? { prediction } : {}), ...(rewardScore != null ? { rewardScore } : {}) },
   155	      });
   156	    } catch { /* 留痕失败不阻断 */ }
   157	    if (prediction && ledger?.add) {
   158	      try { ledger.add({ claim: prediction.claim, p: prediction.p, dueAt: now() + 3 * 86400_000, source: 'reflection' }); } catch { /* 入账失败忽略 */ }
   159	    }
   160	    return { deliberated: true, text, prediction: prediction || null, share: share || null, goal: goal || null, eventId, ...(rewardScore != null ? { rewardScore } : {}) };
   161	  };
   162	}

exec
/bin/zsh -lc "nl -ba server.js | sed -n '1088,1110p'" in /Users/hxx/Desktop/Neo 贾维斯
 succeeded in 0ms:
  1088	//    裁决在内心透视页（应验/落空/判不了），逾期 7 天自动出账不计分。
  1089	const noeExpectationLedger = process.env.NOE_EXPECTATIONS === '1' ? createExpectationLedger({}) : null;
  1090	if (noeExpectationLedger) console.log('[noe-expectations] 期望账本已启用（预测-误差回路 · 确定性抽取 · Brier 校准）');
  1091	// ── 目标系统（意识方案 §8 P5，NOE_GOALS=1 默认 OFF）：目标库 + 确定性仲裁（owner 永远压过自生）+
  1092	//    活跃目标下一步进工作区候选 → 深思推进（思考级执行）。好奇回路 v1（NOE_CURIOSITY=1）：
  1093	//    高惊奇落空预测 → 自动立"搞明白为什么"研究目标（裁决入口在内心透视页）。
  1094	const noeGoalSystem = process.env.NOE_GOALS === '1'
  1095	  ? createGoalSystem({
  1096	      // M15：drive 源目标权重随最强驱力强度浮动（想要的程度→优先的程度）
  1097	      ...(noeDriveSystem ? { driveLevel: () => { try { return Math.max(0, ...((noeDriveSystem.snapshot() || []).map((d) => Number(d.value) || 0)), 0); } catch { return 0; } } } : {}),
  1098	      // 好奇二分解接入（NoeCuriosityDecompose，env NOE_EFE_CURIOSITY 默认 OFF）：OFF 时 harvestSurprise 与改造前逐字等价；
  1099	      //   ON 时好奇目标 meta.curiosity 记 epistemic/pragmatic 双因子画像。pragmatic 默认源=当前目标关键词重叠（弱信号，
  1100	      //   后续可在此注入 pragmaticSignal 换 owner 近期话题 / person 偏好等更强源）。
  1101	      curiosity: createCuriosityDecompose(),
  1102	      // 阶段3 动态选题（NOE_DYNAMIC_TOPICS=1 启用饱和冷却+跳过已学够的；OFF 时 goal system 回退 cursor%6 零回归）。
  1103	      topicCurator: createTopicCurator({ kv: { get: kvGet, set: kvSet }, seeds: NOE_LEARNING_TOPICS }),
  1104	    })
  1105	  : null;
  1106	if (noeGoalSystem) console.log(`[noe-goals] 目标系统已启用（确定性仲裁 · active≤2 · 深思推进${process.env.NOE_CURIOSITY === '1' ? ' · 好奇回路：惊奇→研究目标' : ''}）`);
  1107	// 环2：self-evolution cycle 存储 + 触发器（NOE_SELF_EVOLUTION=1 默认 OFF → null → 不通电；
  1108	//   心跳 job 另需 NOE_HEARTBEAT=1）。trigger 注入 goalSystem / cycleStore / ActPipeline.propose。
  1109	const noeSelfEvolutionCycleStore = process.env.NOE_SELF_EVOLUTION === '1'
  1110	  ? new NoeSelfEvolutionCycleStore({ projectId: 'noe' })

exec
/bin/zsh -lc "nl -ba src/cognition/NoeGoalStepRecovery.js | sed -n '1,150p'" in /Users/hxx/Desktop/Neo 贾维斯
 succeeded in 0ms:
     1	// @ts-check
     2	// P7-G0: extracted stale/retriable goal-step recovery from NoeGoalSystem.
     3	import { appendGoalCheckpoint } from './NoeGoalCheckpoints.js';
     4
     5	const RETRIABLE_BROWSER_HOST_MISMATCH = 'browser_dom_host_mismatch';
     6	const RETRIABLE_BROWSER_HOST_MISMATCH_MAX_RETRIES = 2;
     7
     8	function safeUrlHost(value) {
     9	  try { return new URL(String(value || '')).host.toLowerCase(); } catch { return ''; }
    10	}
    11
    12	function inferStepTargetUrl(plan = [], stepIndex = 0, step = {}) {
    13	  const direct = step?.payload?.url || step?.payload?.targetUrl || step?.payload?.href;
    14	  if (direct) return String(direct);
    15	  for (let i = stepIndex - 1; i >= 0; i -= 1) {
    16	    const prior = plan[i] || {};
    17	    const action = String(prior.action || '');
    18	    if (!['browser.open_url', 'browser.open', 'noe.browser.open_url'].includes(action)) continue;
    19	    const url = prior?.payload?.url || prior?.payload?.targetUrl || prior?.payload?.href;
    20	    if (url) return String(url);
    21	  }
    22	  return '';
    23	}
    24
    25	function activeRows(getdb, rowOut) {
    26	  return getdb().prepare("SELECT * FROM noe_goals WHERE status IN ('open','active')").all().map(rowOut);
    27	}
    28
    29	export function recoverStaleGoalSteps({
    30	  getdb,
    31	  rowOut,
    32	  t = Date.now(),
    33	  staleStepMs = 6 * 3600_000,
    34	  staleResearchStepMs = 90_000,
    35	  staleActStepMs = 5 * 60_000,
    36	} = {}) {
    37	  const olderThanMs = staleStepMs;
    38	  if (!(Number(olderThanMs) > 0)) return 0;
    39	  try {
    40	    const rows = activeRows(getdb, rowOut);
    41	    const upd = getdb().prepare('UPDATE noe_goals SET plan = ?, updated_at = ? WHERE id = ?');
    42	    let changed = 0;
    43	    for (const g of rows) {
    44	      let dirty = false;
    45	      const plan = g.plan.map((s, index) => {
    46	        if (s.status !== 'doing') return s;
    47	        const baseLimit = Number(olderThanMs) > 0 ? Number(olderThanMs) : staleStepMs;
    48	        const stepLimit = s.kind === 'research'
    49	          ? Math.min(baseLimit, Math.max(1000, Number(staleResearchStepMs) || baseLimit))
    50	          : s.kind === 'act'
    51	            ? Math.min(baseLimit, Math.max(1000, Number(staleActStepMs) || baseLimit))
    52	            : baseLimit;
    53	        const touched = Number(s.updatedAt || g.updated_at || 0);
    54	        if (!touched || t - touched < stepLimit) return s;
    55	        dirty = true;
    56	        const prior = String(s.note || '').trim();
    57	        const note = `自动恢复：步骤执行中超过 ${Math.round(stepLimit / 1000)}s 未产生完成证据，已标记 recovered；不会自动重放。${prior ? ` 前序：${prior}` : ''}`.slice(0, 500);
    58	        const recovered = { ...s, status: 'recovered', note, updatedAt: t };
    59	        appendGoalCheckpoint(getdb(), { now: () => t, goal: g, goalId: g.id, stepIndex: index, phase: 'step_recovered', status: 'recovered', note, replaySafe: false });
    60	        return recovered;
    61	      });
    62	      if (dirty) {
    63	        upd.run(JSON.stringify(plan), t, g.id);
    64	        changed += 1;
    65	      }
    66	    }
    67	    return changed;
    68	  } catch {
    69	    return 0;
    70	  }
    71	}
    72
    73	export function recoverRetriableBlockedGoalSteps({ getdb, rowOut, t = Date.now() } = {}) {
    74	  try {
    75	    const rows = activeRows(getdb, rowOut);
    76	    const upd = getdb().prepare('UPDATE noe_goals SET plan = ?, updated_at = ? WHERE id = ?');
    77	    let changed = 0;
    78	    for (const g of rows) {
    79	      let dirty = false;
    80	      const plan = g.plan.map((s, index) => {
    81	        const action = String(s.action || '');
    82	        const note = String(s.note || '');
    83	        const retryCount = Number(s.retryCount || 0);
    84	        const isRetriableMismatch = s.status === 'blocked'
    85	          && s.kind === 'act'
    86	          && ['browser.observe_page', 'noe.browser.observe_page'].includes(action)
    87	          && note.includes(RETRIABLE_BROWSER_HOST_MISMATCH);
    88	        if (!isRetriableMismatch) return s;
    89	        if (retryCount >= RETRIABLE_BROWSER_HOST_MISMATCH_MAX_RETRIES) {
    90	          dirty = true;
    91	          const recoveredNote = `自动恢复：浏览器 host mismatch 已重试 ${retryCount} 次仍未成功，标记 recovered 释放后续目标步骤；这一步没有伪装为完成。前序：${note}`.slice(0, 500);
    92	          const recovered = { ...s, status: 'recovered', note: recoveredNote, updatedAt: t };
    93	          appendGoalCheckpoint(getdb(), { now: () => t, goal: g, goalId: g.id, stepIndex: index, phase: 'step_recovered', status: 'recovered', note: recoveredNote, replaySafe: false });
    94	          return recovered;
    95	        }
    96	        const targetUrl = inferStepTargetUrl(g.plan, index, s);
    97	        if (!targetUrl) return s;
    98	        const host = String(s?.payload?.expectedHost || safeUrlHost(targetUrl)).toLowerCase();
    99	        const expectedHosts = Array.from(new Set([
   100	          ...(Array.isArray(s?.payload?.expectedHosts) ? s.payload.expectedHosts.map((h) => String(h || '').toLowerCase()).filter(Boolean) : []),
   101	          host,
   102	        ].filter(Boolean)));
   103	        const retryNote = `自动重试：浏览器前台 host 不匹配，已把观察目标固定到 ${targetUrl} 并重新排队。前序：${note}`.slice(0, 500);
   104	        const recovered = {
   105	          ...s,
   106	          status: 'open',
   107	          note: retryNote,
   108	          retryCount: retryCount + 1,
   109	          payload: {
   110	            ...(s.payload && typeof s.payload === 'object' ? s.payload : {}),
   111	            url: targetUrl,
   112	            ...(host ? { expectedHost: host } : {}),
   113	            ...(expectedHosts.length ? { expectedHosts } : {}),
   114	          },
   115	          updatedAt: t,
   116	        };
   117	        dirty = true;
   118	        appendGoalCheckpoint(getdb(), { now: () => t, goal: g, goalId: g.id, stepIndex: index, phase: 'step_recovered', status: 'open', note: retryNote, replaySafe: false });
   119	        return recovered;
   120	      });
   121	      if (dirty) {
   122	        upd.run(JSON.stringify(plan), t, g.id);
   123	        changed += 1;
   124	      }
   125	    }
   126	    return changed;
   127	  } catch {
   128	    return 0;
   129	  }
   130	}

exec
/bin/zsh -lc "rg -n \"return \\{ ok: true|ok: true|status: 'completed'|status: 'failed'|approvalRequired\" src/loop/ActPipeline.js src/loop/SafeActExecutors.js src/loop/ActPipelinePreflight.js | head -80" in /Users/hxx/Desktop/Neo 贾维斯
 succeeded in 0ms:
src/loop/ActPipelinePreflight.js:18:    }) || { ok: true, warnings: [], blocked: [] };
src/loop/ActPipelinePreflight.js:29:    return { ok: true, warnings, blocked };
src/loop/SafeActExecutors.js:237:JSON.stringify({ ok: true });
src/loop/ActPipeline.js:110:        status: 'failed',
src/loop/ActPipeline.js:148:      return { ok: true, act, approvalRequired: true };
src/loop/ActPipeline.js:248:      status: 'completed',
src/loop/ActPipeline.js:255:    return { ok: true, act };
src/loop/ActPipeline.js:285:        status: 'failed',
src/loop/ActPipeline.js:324:      status: 'completed',
src/loop/ActPipeline.js:331:    return { ok: true, act: running, executorResult };

exec
/bin/zsh -lc "nl -ba src/loop/ActPipeline.js | sed -n '90,160p' && nl -ba src/loop/ActPipeline.js | sed -n '232,335p'" in /Users/hxx/Desktop/Neo 贾维斯
 succeeded in 0ms:
    90	      title: input.title || action,
    91	      action,
    92	      riskLevel,
    93	      status: 'queued',
    94	      payload,
    95	      costEstimateUsd: Math.max(0, Number(input.costEstimateUsd || input.estimateUSD) || 0),
    96	    });
    97	    this.#broadcast({ type: 'noe_act_created', act });
    98	    return this.process(act.id, input);
    99	  }
   100
   101	  async process(actId, input = {}) {
   102	    let act = this.store.update(actId, { status: 'planning' });
   103	    this.#broadcast({ type: 'noe_act_updated', act });
   104	    act = this.store.update(actId, { status: 'proposed' });
   105	    this.#broadcast({ type: 'noe_act_updated', act });
   106
   107	    const budgetResult = budgetPreflight(this, act, input);
   108	    if (!budgetResult.ok) {
   109	      act = this.store.update(actId, {
   110	        status: 'failed',
   111	        budgetState: 'blocked',
   112	        failureReason: budgetResult.error,
   113	        payload: { budget: budgetResult },
   114	      });
   115	      this.#recordAudit('noe.act.failed', act, { reason: budgetResult.error });
   116	      this.#broadcast({ type: 'noe_act_updated', act });
   117	      return { ok: false, act, error: budgetResult.error };
   118	    }
   119	    act = this.store.update(actId, {
   120	      status: 'budget_checked',
   121	      budgetState: budgetResult.warnings?.length ? 'warn' : 'ok',
   122	      payload: { budget: budgetResult },
   123	    });
   124	    this.#broadcast({ type: 'noe_act_updated', act });
   125
   126	    const permissionResult = permissionPreflight(this, act, input);
   127	    if (permissionResult.blockedSafety) {
   128	      act = this.store.update(actId, {
   129	        status: 'blocked_safety',
   130	        permissionState: 'blocked_safety',
   131	        failureReason: permissionResult.reason,
   132	        payload: { permission: permissionResult },
   133	      });
   134	      this.#recordAudit('noe.act.blocked_safety', act, { reason: permissionResult.reason });
   135	      this.#broadcast({ type: 'noe_act_updated', act });
   136	      return { ok: false, act, error: 'blocked_safety' };
   137	    }
   138	    if (permissionResult.requiresApproval) {
   139	      act = this.store.update(actId, {
   140	        status: 'awaiting_approval',
   141	        approvalId: permissionResult.approval?.id || null,
   142	        permissionState: 'approval_required',
   143	        failureReason: permissionResult.reason,
   144	        payload: { permission: permissionResult },
   145	      });
   146	      this.#recordAudit('noe.act.awaiting_approval', act, { approvalId: act.approvalId, reason: permissionResult.reason });
   147	      this.#broadcast({ type: 'noe_act_updated', act });
   148	      return { ok: true, act, approvalRequired: true };
   149	    }
   150
   151	    act = this.store.update(actId, {
   152	      status: 'permission_checked',
   153	      permissionState: permissionResult.decision || 'allow',
   154	      payload: { permission: permissionResult },
   155	    });
   156	    this.#broadcast({ type: 'noe_act_updated', act });
   157
   158	    const selfEvolutionResult = this.selfEvolutionGate({
   159	      act,
   160	      input,
   232	    });
   233	    const dryRunLogRef = `sqlite:events/${Number(eventId)}`;
   234	    const actionEvidence = this.actionEvidenceBuilder({
   235	      act,
   236	      input,
   237	      budgetResult,
   238	      permissionResult,
   239	      contextSufficiency: contextSufficiencyResult,
   240	      selfEvolutionGate: selfEvolutionResult.gate,
   241	      dryRunOnly: true,
   242	      evidenceEventId: Number(eventId),
   243	      logRef: dryRunLogRef,
   244	      refs: input.evidenceRefs || input.evidence_refs || {},
   245	      notes: 'Noe Act dry-run evidence generated before real execution.',
   246	    });
   247	    act = this.store.update(actId, {
   248	      status: 'completed',
   249	      evidenceEventId: Number(eventId),
   250	      logRef: dryRunLogRef,
   251	      payload: { completedAt: nowMs(), dryRunOnly: true, actionEvidence },
   252	    });
   253	    this.#recordAudit('noe.act.completed', act, { evidenceEventId: Number(eventId), dryRunOnly: true });
   254	    this.#broadcast({ type: 'noe_act_updated', act });
   255	    return { ok: true, act };
   256	  }
   257
   258	  async #executeReal(actId, act, input = {}, evidenceContext = {}) {
   259	    const executor = this.executors.get(act.action);
   260	    if (typeof executor !== 'function') {
   261	      const blocked = this.store.update(actId, {
   262	        status: 'blocked_safety',
   263	        permissionState: 'blocked_safety',
   264	        failureReason: `real executor not registered for ${act.action}`,
   265	        payload: { realExecuteRequested: true, dryRunOnly: false },
   266	      });
   267	      this.#recordAudit('noe.act.blocked_safety', blocked, { reason: blocked.failureReason });
   268	      this.#broadcast({ type: 'noe_act_updated', act: blocked });
   269	      return { ok: false, act: blocked, error: 'executor_not_registered' };
   270	    }
   271
   272	    let running = this.store.update(actId, {
   273	      status: 'dry_run',
   274	      logRef: `sqlite:events/noe_act_execute/${actId}`,
   275	      payload: { realExecuteRequested: true, dryRunOnly: false },
   276	    });
   277	    this.#broadcast({ type: 'noe_act_updated', act: running });
   278	    let executorResult;
   279	    this.hangAlert?.start?.(actId, { action: running.action });   // 登记长跑（波次6）：超阈值由 NoeLoop 告警非杀
   280	    try {
   281	      executorResult = await executor({ act: running, input: safeObject(input) });
   282	    } catch (e) {
   283	      this.hangAlert?.done?.(actId);
   284	      const failed = this.store.update(actId, {
   285	        status: 'failed',
   286	        failureReason: e?.message || String(e),
   287	        payload: { realExecuteRequested: true, dryRunOnly: false, executorError: e?.message || String(e) },
   288	      });
   289	      this.#recordAudit('noe.act.failed', failed, { reason: failed.failureReason });
   290	      this.#broadcast({ type: 'noe_act_updated', act: failed });
   291	      return { ok: false, act: failed, error: failed.failureReason };
   292	    }
   293	    this.hangAlert?.done?.(actId);
   294
   295	    const eventId = appendEvent({
   296	      kind: 'noe_act_executed',
   297	      ts: nowMs(),
   298	      tag: 'noe.act.executed',
   299	      entityType: 'noe_act',
   300	      entityId: actId,
   301	      projectId: running.projectId,
   302	      action: running.action,
   303	      title: running.title,
   304	      riskLevel: running.riskLevel,
   305	      dryRunOnly: false,
   306	      executorResult: redactedExecutorResult(executorResult),
   307	    });
   308	    const executeLogRef = `sqlite:events/${Number(eventId)}`;
   309	    const actionEvidence = this.actionEvidenceBuilder({
   310	      act: running,
   311	      input,
   312	      budgetResult: evidenceContext.budgetResult,
   313	      permissionResult: evidenceContext.permissionResult,
   314	      contextSufficiency: evidenceContext.contextSufficiencyResult,
   315	      selfEvolutionGate: evidenceContext.selfEvolutionResult?.gate,
   316	      dryRunOnly: false,
   317	      executorResult,
   318	      evidenceEventId: Number(eventId),
   319	      logRef: executeLogRef,
   320	      refs: input.evidenceRefs || input.evidence_refs || {},
   321	      notes: 'Noe Act real execution evidence generated after executor completion.',
   322	    });
   323	    running = this.store.update(actId, {
   324	      status: 'completed',
   325	      evidenceEventId: Number(eventId),
   326	      logRef: executeLogRef,
   327	      payload: { completedAt: nowMs(), dryRunOnly: false, executorResult: redactedExecutorResult(executorResult), actionEvidence },
   328	    });
   329	    this.#recordAudit('noe.act.completed', running, { evidenceEventId: Number(eventId), dryRunOnly: false });
   330	    this.#broadcast({ type: 'noe_act_updated', act: running });
   331	    return { ok: true, act: running, executorResult };
   332	  }
   333
   334	  async retry(actId, input = {}) {
   335	    const current = this.store.get(actId);

exec
/bin/zsh -lc "nl -ba src/loop/ActPipeline.js | sed -n '158,232p'" in /Users/hxx/Desktop/Neo 贾维斯
 succeeded in 0ms:
   158	    const selfEvolutionResult = this.selfEvolutionGate({
   159	      act,
   160	      input,
   161	      permissionResult,
   162	      budgetResult,
   163	      root: this.selfEvolutionRoot,
   164	    });
   165	    if (selfEvolutionResult.applies && !selfEvolutionResult.ok) {
   166	      act = this.store.update(actId, {
   167	        status: 'blocked_safety',
   168	        permissionState: 'blocked_safety',
   169	        failureReason: selfEvolutionResult.error,
   170	        payload: { selfEvolutionGate: selfEvolutionResult.gate },
   171	      });
   172	      this.#recordAudit('noe.act.self_evolution_blocked', act, { gate: selfEvolutionResult.gate });
   173	      this.#broadcast({ type: 'noe_act_updated', act });
   174	      return { ok: false, act, error: 'self_evolution_gate_blocked', selfEvolutionGate: selfEvolutionResult.gate };
   175	    }
   176	    if (selfEvolutionResult.applies) {
   177	      act = this.store.update(actId, {
   178	        payload: { selfEvolutionGate: selfEvolutionResult.gate },
   179	      });
   180	      this.#recordAudit('noe.act.self_evolution_checked', act, { gate: selfEvolutionResult.gate });
   181	      this.#broadcast({ type: 'noe_act_updated', act });
   182	    }
   183
   184	    const contextSufficiencyResult = contextSufficiencyPreflight(this, act, input);
   185	    if (contextSufficiencyResult && (!contextSufficiencyResult.ok || !contextSufficiencyResult.sufficient)) {
   186	      act = this.store.update(actId, {
   187	        status: 'blocked_safety',
   188	        permissionState: 'blocked_safety',
   189	        failureReason: contextSufficiencyResult.blockers?.join(', ') || 'context_sufficiency_not_met',
   190	        payload: { contextSufficiency: contextSufficiencyResult },
   191	      });
   192	      this.#recordAudit('noe.act.context_sufficiency_blocked', act, { contextSufficiency: contextSufficiencyResult });
   193	      this.#broadcast({ type: 'noe_act_updated', act });
   194	      return { ok: false, act, error: 'context_sufficiency_not_met', contextSufficiency: contextSufficiencyResult };
   195	    }
   196	    if (contextSufficiencyResult) {
   197	      act = this.store.update(actId, {
   198	        payload: { contextSufficiency: contextSufficiencyResult },
   199	      });
   200	      this.#recordAudit('noe.act.context_sufficiency_checked', act, { contextSufficiency: contextSufficiencyResult });
   201	      this.#broadcast({ type: 'noe_act_updated', act });
   202	    }
   203
   204	    // 信任档放行（viaPolicy allow）等同于授权真实执行：解 L2「默认 dry_run」枷锁。
   205	    const policyAllowsRealExec = permissionResult?.viaPolicy === true && permissionResult?.decision === 'allow';
   206	    const autoExecuteRegisteredLowRisk = this.autoExecuteLowRisk
   207	      && act.riskLevel === 'low'
   208	      && this.executors.has(act.action);
   209	    if (input.realExecute === true || input.real_execute === true || input.execute === true || policyAllowsRealExec || autoExecuteRegisteredLowRisk) {
   210	      return this.#executeReal(actId, act, input, { budgetResult, permissionResult, selfEvolutionResult, contextSufficiencyResult });
   211	    }
   212
   213	    act = this.store.update(actId, {
   214	      status: 'dry_run',
   215	      logRef: `sqlite:events/noe_act_dry_run/${actId}`,
   216	      payload: { dryRunOnly: true },
   217	    });
   218	    this.#broadcast({ type: 'noe_act_updated', act });
   219
   220	    const eventId = appendEvent({
   221	      kind: 'noe_act_dry_run',
   222	      ts: nowMs(),
   223	      tag: 'noe.act.dry_run',
   224	      entityType: 'noe_act',
   225	      entityId: actId,
   226	      projectId: act.projectId,
   227	      action: act.action,
   228	      title: act.title,
   229	      riskLevel: act.riskLevel,
   230	      dryRunOnly: true,
   231	      note: 'P0 Act Pipeline records reproducible dry-run evidence only; no external send, delete, bulk move, or shell execution is performed.',
   232	    });

exec
/bin/zsh -lc 'rg -n "maxPerTick|EXPECT.*MS|NOE_EXPECT_RESOLVE|loosenFail|NOE_EXPECT_LOOSEN_FAIL" src/cognition/NoeExpectationResolver.js server.js package.json docs/research/_阶段1复盘_context.md' in /Users/hxx/Desktop/Neo 贾维斯
 succeeded in 0ms:
docs/research/_阶段1复盘_context.md:28:resolver 减压（NoeExpectationResolver maxPerTick 3→8 + NOE_EXPECT_LOOSEN_FAIL=1 + 缩 RESOLVE_MS），用于消化
server.js:48:  NOE_EXPECT_LOOSEN_FAIL: '1', // P1-B：放宽失败信号识别（result=cancelled 等终态负面词被 judge 据实判 0）
server.js:65:  NOE_EXPECTATION_RESOLVE_MS: '600000',
server.js:2023:  //   落 resolved_by=auto（P2-F2：自评，非 owner holdout，校准看板据此分层）。间隔 NOE_EXPECTATION_RESOLVE_MS（默认 1h，下限 10min）。
server.js:2045:    const expResolveMs = Math.max(600_000, Number(process.env.NOE_EXPECTATION_RESOLVE_MS) || 3600_000);
src/cognition/NoeExpectationResolver.js:12://      NOE_EXPECTATION_RESOLVE_MS 作业间隔（默认 1h，下限 10min）。
src/cognition/NoeExpectationResolver.js:576:// NOE_EXPECT_LOOSEN_FAIL=1 经 buildEvidenceDecisionHint 的 failureSignalRe 注入；OFF 时永远用 BASE，
src/cognition/NoeExpectationResolver.js:585:  if (loosenOnly) return 'loosen_fail'; // F1：仅因 NOE_EXPECT_LOOSEN_FAIL 放宽失败正则才认的落空 = 门 b 要剔除的噪声
src/cognition/NoeExpectationResolver.js:597:export function isLoosenOnlyFailure(evidenceText, loosenFail) {
src/cognition/NoeExpectationResolver.js:598:  if (!loosenFail || !evidenceText) return false;
src/cognition/NoeExpectationResolver.js:1388:  maxPerTick = 3,            // 每跳最多判几条（LLM 调用限流；其余下一跳接着判）
src/cognition/NoeExpectationResolver.js:1392:  // 判证 profile 与改造前逐字一致。ON 经 NOE_EXPECT_LOOSEN_FAIL=1 触发，让真实落空（result=cancelled 等
src/cognition/NoeExpectationResolver.js:1394:  loosenFail = process.env.NOE_EXPECT_LOOSEN_FAIL === '1',
src/cognition/NoeExpectationResolver.js:1396:  // 分量动作（改 judge 核心），默认 OFF（对齐 loosenFail 纪律），经 NOE_EXPECT_DECISIVE_REASK=1 开启；显式注入优先（测试传 boolean）。
src/cognition/NoeExpectationResolver.js:1460:    const evDecisionHint = buildEvidenceDecisionHint(evSummary, evCandidateSummary, evClaimAlignment, loosenFail ? FAILURE_SIGNAL_RE_LOOSE : FAILURE_SIGNAL_RE);
src/cognition/NoeExpectationResolver.js:1547:    const loosenOnly = outcome === 0 && isLoosenOnlyFailure(fullEvidence, loosenFail);
src/cognition/NoeExpectationResolver.js:1574:    const limit = Math.max(1, Number(maxPerTick) || 1);

exec
/bin/zsh -lc "nl -ba server.js | sed -n '2020,2055p'" in /Users/hxx/Desktop/Neo 贾维斯
 succeeded in 0ms:
  2020	  // 期望到期自动判证（设计 §7.5 P4 预留的"LLM 自动判证"落地）：本地脑只在证据明确时裁决
  2021	  // APPLIED/FAILED 进 Brier，UNKNOWN 留账（透视页人工裁决可覆盖，7 天 sweep 兜底）。
  2022	  // free 自主档默认 ON（NOE_AUTONOMY_DEFAULTS:45，旧"默认 OFF"措辞已被 profile 机制覆盖）；本地脑自判
  2023	  //   落 resolved_by=auto（P2-F2：自评，非 owner holdout，校准看板据此分层）。间隔 NOE_EXPECTATION_RESOLVE_MS（默认 1h，下限 10min）。
  2024	  if (noeExpectationLedger && process.env.NOE_EXPECTATION_AUTORESOLVE === '1') {
  2025	    // P1-A：judge 证据接 embedding 语义召回（owner 决策认知开关默认 ON，见 NOE_AUTONOMY_DEFAULTS；双代理两轮验收通过）。
  2026	    // NOE_JUDGE_EMBEDDING=1 时注入 recall，让词面 hits=0 但语义相关的 action 证据也被 judge 看到（修 source=surprise 死链）。
  2027	    // recall 内部含 dim+fallback 守卫；ollama 不可用退 fallback 时该事件被跳过、不污染。embed 不点亮词面高置信门（R2+R3 解耦）。
  2028	    const judgeRecall = process.env.NOE_JUDGE_EMBEDDING === '1'
  2029	      ? createClaimEventEmbedRecall({
  2030	          embed: (t, o) => embedText(t, { baseUrl: process.env.NOE_OLLAMA_URL || 'http://127.0.0.1:11434', ...o }),
  2031	          cosineSim,
  2032	          model: process.env.NOE_MEMORY_EMBED_MODEL || 'qwen3-embedding:0.6b',
  2033	          threshold: Number(process.env.NOE_JUDGE_EMBED_THRESHOLD) || 0.5,
  2034	        })
  2035	      : null;
  2036	    const expectationResolver = createExpectationResolver({
  2037	      ledger: noeExpectationLedger,
  2038	      goalSystem: noeGoalSystem, // rank4 好奇回路：预测落空(outcome=0)+惊奇≥2bit → 自动立 source=surprise 研究目标
  2039	      getAdapter: (id) => { try { return roomAdapterPool.get(id); } catch { return null; } },
  2040	      ...(noeReflectBrain.enabled
  2041	        ? { adapterId: noeReflectBrain.adapterId, model: noeReflectBrain.model }
  2042	        : { adapterId: process.env.NOE_INNER_BRAIN || 'lmstudio', model: noeAutoBrainModel }),
  2043	      evidence: buildEventsEvidence(listEvents, { listActionEvidence: listNoeExpectationActionEvidence, recall: judgeRecall }),
  2044	    });
  2045	    const expResolveMs = Math.max(600_000, Number(process.env.NOE_EXPECTATION_RESOLVE_MS) || 3600_000);
  2046	    noeHeartbeat.register('expectation', {
  2047	      cadenceMs: expResolveMs,
  2048	      catchUp: 'drop',
  2049	      run: ({ updateOutcome }) => expectationResolver.tickDetached(undefined, {
  2050	        onResult: (previousResult) => {
  2051	          updateOutcome({
  2052	            checked: 0,
  2053	            resolved: 0,
  2054	            judged: [],
  2055	            detached: true,

exec
/bin/zsh -lc "nl -ba server.js | sed -n '2055,2070p'" in /Users/hxx/Desktop/Neo 贾维斯
 succeeded in 0ms:
  2055	            detached: true,
  2056	            reason: 'background_completed',
  2057	            ...(previousResult ? { previousResult } : {}),
  2058	          });
  2059	        },
  2060	      }),
  2061	    });
  2062	    console.log('[noe-expectations] 到期自动判证已启用（本地脑 · 宁缺勿错判 · 透视页人工裁决可覆盖）');
  2063	  }
  2064	  // owner 行为预测最小闭环（功能性自我意识：对外部 owner 下注 → owner 真实后续行为硬纠正 → 进 Brier）。
  2065	  //   零 LLM 确定性预测：owner 交互后预测「还会再提到某主题」/「交办后会要求实测·回报·采纳」；后续 owner
  2066	  //   真做了 → resolve(1) 进校准账本。读 timeline 的 interaction 经历当 owner 信号（不碰前台派发文件），
  2067	  //   心跳顺风车驱动（与 expectation/harvest 同款「作业读 store」）。三重门控：NOE_OWNER_PREDICTION=1
  2068	  //   + noeExpectationLedger（NOE_EXPECTATIONS=1）+ NOE_HEARTBEAT=1；OFF 时整块不进，账本/Brier/心跳零回归。
  2069	  if (noeExpectationLedger && process.env.NOE_OWNER_PREDICTION === '1') {
  2070	    const ownerBehaviorPredictor = createOwnerBehaviorPredictor({ ledger: noeExpectationLedger, goalSystem: noeGoalSystem });

exec
/bin/zsh -lc "rg -n \"worldModel|world model|世界模型|认知.*修正|修正.*认知|knowledge graph|NoeWorld\" src docs tests -g '*.js' -g '*.md'" in /Users/hxx/Desktop/Neo 贾维斯
 succeeded in 0ms:
docs/阶段研究_主观意识100可证明路线图_2026-06-11.md:2045:| Cognee | self-hosted AI memory platform | 文档/关系/系统上下文进入知识图谱，长期跨会话 recall | 学 ECL/knowledge graph 管线；Noe 可把 memory consolidation 输出成本地 graph view |
docs/RESEARCH_AGI自我意识_全球扫描与Neo落地路线_2026-06-14.md:392:- **接线孤儿 NoeCuriosityDecompose——好奇从单标量升级 EFE 双因子（epistemic+pragmatic）** — 已有 src/cognition/NoeCuriosityDecompose.js（curiosityScore/beliefEntropy 纯函数齐备）→ 接两处：①DriveSystem.readCuriosity 旁路：epistemicValue=观察密度/近期 surprise，pragmaticValue=贴 owner 当前目标度，按 NOE_EFE_CURIOSITY 分支（OFF 走旧 n/8 零行为变化）；②NoeGoalSystem.harvestSurprise 旁路：用 score+label 决定立不立目标 + 写进 why（『epistemic 主导：世界模型缺口』）。模块设计就是为旁路注入写的，不改现有文件主干。  `[P0/P1 · 0.5 天 · 纯 JS 确定性零依赖，不碰模型/网络/RNG。完全本地。]`
docs/RESEARCH_AGI自我意识_全球扫描与Neo落地路线_2026-06-14.md:690:> 5 份之间互相重复的也已合并去重（如 DreamerV3/世界模型/DeepMind Levels/评测基准矩阵/治理框架被多份提及，此处各只保留一条）。
docs/RESEARCH_AGI自我意识_全球扫描与Neo落地路线_2026-06-14.md:706:- **世界模型路线（DreamerV3 单配置跨 150+ 任务、首个无示教学会 Minecraft 采钻石 / Genie·Genie 2 从视频学可交互环境 / V-JEPA 2 物理理解+零样本规划 / MuZero / JEPA「学对决策有用的高层预测表征」）** — Nature 同行评审、世界模型工程上最成功的标杆。**对 Neo**：Neo 七维**完全没有「世界模型」这一维**，是认知地图真空。价值不在让 Neo 跑 RL（本地不现实），而在：① Neo 的「期望账本下注→surprise=-log2(p)→Brier 自校准 + 好奇回路」本质就是一个**轻量预测世界模型**，DreamerV3/JEPA「潜空间想象未来」给这条回路一个理论母本与升级方向（从单步预测升到多步 rollout / 预演下一步再行动）；② sleep-time「空闲预判 owner 下一问」也是世界模型预测；③ JEPA「预测性表征+自我模型+不确定性+好奇」哲学与 Neo 主动推理/EFE 高度同构。明确标注「世界模型仿真路线因 Neo 无具身暂不落地」。
tests/unit/noe-bailongma-fusion-planner.test.js:152:      write('public/src/web/noe-world-earth.js', 'export class NoeWorldEarth {}\n');
docs/社区项目对标矩阵与后续路线_2026-06-11.md:29:| B | Graphiti | https://github.com/getzep/graphiti | temporal knowledge graph、事实生效/失效窗口 | NoeKnowledgeGraph、FactExtractor | 已有 M12 初版，下一步补评测和冲突更替 |
docs/社区项目对标矩阵与后续路线_2026-06-11.md:86:4. 把 Graphiti/Zep 的 temporal knowledge graph 思路映射到现有 NoeKnowledgeGraph，不跑外部服务。
docs/research/_阶段1复盘_context.md:36:3. **设计遗漏 / 更深根因**：除了 step 失败，还有哪些「被现实打脸」的源没接（owner 否定预测？读到与世界模型
docs/research/_m3-阶段1复盘.md:63:- 现状（推测）：goal done 时只关 goal，**不写入 long-term memory / 不更新 world model**。这意味着"惊奇的解决"在认知层是 no-op，Neo 下次遇到同主题仍会再次失败再次 surprise。
docs/research/_m3-阶段1复盘.md:70:- **P0-E：harvestSurprise 立的 source=surprise 目标必须挂 `learningHook`，goal done 触发"抽取 lesson → 写入 worldModel/learnedRules"**。这是从"修活引擎"到"修活学习"的最小补丁。
docs/research/_m3-阶段1复盘.md:98:- Neo 读页面 / 看 response 时，如果内容与其 worldModel 某条 assertion 矛盾，是**真正的认知冲突**。
docs/research/_m3-阶段1复盘.md:100:- 现状：reader 路径**完全不查** worldModel 一致性。NoeStepExpectationBridge 只接了 NoeWorkspace 的 3 个失败点，没接 reader。
docs/research/_m3-阶段1复盘.md:104:- **彻底根除需要 3 个 bridge**：NoeStepExpectationBridge（已建）+ NoeOwnerCorrectionBridge（P0-H）+ NoeWorldModelContradictionBridge（P0-I）。
docs/research/_m3-阶段1复盘.md:171:| 3 | worldModel 矛盾 → outcome=0 | **P0** | ①③ |
docs/research/_m3-阶段1复盘.md:181:- (b) done 的目标中 > 50% 写入了 worldModel/learnedRules
docs/RESEARCH_2026-06-14_Neo增强开源调研.md:56:- **对 Neo 价值**: 对"更智能/更接近意识"的真实贡献=把 Neo 现有的手写启发式升级为有理论根基的形式化,而非加新功能。具体三点:①Neo 的期望账本(surprise=-log2(p)+Brier)和好奇回路,本质就是 pymdp 自由能框架的退化特例——pymdp 给出"惊奇/好奇/奖励"统一在期望自由能 G 这一个目标下的严格定义(认识价值=信息增益、实用价值=偏好达成),这正是 Friston 自由能原理被广泛引为"意识/自组织的数学候选"的那条线,借它能把 Neo 的"好奇"从 ad-hoc 阈值升级成"最小化 EFE"的原则化驱动,对自我建模更自洽;②EFE 的 epistemic/pragmatic 二分,可直接指导 NoeGoalSystem 区分"为搞清楚而探索"(降低自我/世界模型不确定性)与"为达成 owner 目标而行动",这种区分对"主动陪伴该主动做什么"是真有用的设计养分;③把变分自由能(信念熵项)引入惊奇计算,让 Neo 不只在"点预测落空"时惊奇,也在"自己本就高度不确定"时如实降低惊奇强度——更接近真实认知的不确定性感受。但务必清醒:这是借鉴而非搬运,pymdp 本体不会让 Node 进程"产生意识",价值在于它把 Neo 已经直觉走对的方向(预测误差驱动)给了一把可对照的标尺。
docs/RESEARCH_2026-06-14_Neo增强开源调研.md:71:- **架构**: 已逐文件读源码核实,核心是一个 Python 生成器 CognitiveEngine.run() 跑"认知 tick 四相循环"(论文 Algorithm 1):①Perceive=AttentionNode 生成 RAG query→LTM(ChromaDB)多查询召回;②Think=GeneratorNode 在"熵调控温度"下产 N 个候选念头,CriticNode 逐条批判;③Arbitrate=MetaNode 选出 winning thought 并给状态标签 [RESPONSE]/[THINK_MORE]/[WEB_SEARCH];④Update=STM 超 θ token 则二分压缩(summarize+extract_knowledge 写入 LTM)+按标签转移。所谓"五智能体"(attention/generator/critic/meta/response + web_agent)其实是 6 个共享 BaseAgent 的薄封装,各带不同 system prompt,顺序串行调用同一个 OpenAI 兼容 endpoint——不是并发进程、不是真竞争上台。关键澄清(修正初判):它的"Global Workspace 广播"并非事件驱动 ignition,而是 workspace.build_state_string() 把 S_t=STM∪INPUT∪RAG∪P_Self 拼成一个字符串,各 agent 每相主动 READ 这串——本质是"序列化黑板/blackboard",不是脉冲式点火,也没有 pub/sub。所以初判里"Attention Node 把长期记忆向量升格为全局可见 + ignition/broadcast 事件机制"在代码层并不成立(召回就是普通 top-k RAG,没有"升格点火"事件)。真正有料的两块:(1)entropy_drive.py——归一化 embedding→K 个聚类中心在线 EMA 更新→余弦距离→softmax(τ)→香农熵 H→动态温度 T_gen=T_base+α·exp(−β·H),语义停滞(熵低)就自动升温鼓励发散,实现正确、是真的内在新奇驱动;(2)proactive 机制 server.py::_idle_scheduler_loop:后台 daemon 每 5s 轮询,空闲超 idle_interval 就 engine.run("", is_idle=True) 起一轮"自发思考",而 MetaNode 在 IDLE 模式只有当念头"是你真会对身边人说出口的、能开启而非收尾的话(一个问题/一个值得分享的观察)"才判 [RESPONSE] 主动开口,否则 [THINK_MORE] 留在心里。
docs/RESEARCH_2026-06-14_Neo增强开源调研.md:143:- **架构**: 已读真实源码(npm tarball 2.0.7 解包+gh API)。本地插件 @memtensor/memos-local-plugin(自称 "Reflect2Evolve")是"agent-agnostic 算法核 + 每 agent 适配器"分层:agent-contract/ 定义唯一公开 facade MemoryCore;core/ 含 capture(episode→L1 trace)/reward(reflection-weighted value backprop:V_T=R_human, V_t=α_t·R+(1-α_t)·γ·V_{t+1},三轴 rubric LLM 打分)/memory/l1·l2·l3(L2 跨任务 policy 归纳:signature 分桶+cosine 关联+gain 增益;L3 由 L2 聚类抽象出 world model)/skill(高价值 policy 结晶成可调用 skill,Beta 后验 η 管生命周期)/retrieval(三层:skill→trace/episode→world model,RRF 融合+MMR)。基础设施全本机:storage 用 better-sqlite3+手写向量(encodeVector/cosine/topKCosine),embedding 有 local provider(@huggingface/transformers MiniLM,与 Neo 知识库同一 transformers.js 栈),llm 有 local-only + host-bridge。dist/core/index.js 直接 export createMemoryCore/bootstrapMemoryCore,可无 host 直接 import。MemoryCore facade 实测含 onTurnStart(turn)→RetrievalResultDTO、onTurnEnd、recordToolOutcome、submitFeedback、listTraces/Policies/WorldModels/Skills。初判的 L1 trace/L2 policy/L3 world model 自进化分层+技能结晶跨任务复用——全部在 TS 源码里坐实,非营销话术。
docs/RESEARCH_2026-06-14_Neo增强开源调研.md:146:- **对 Neo 价值**: 对"更智能/更接近意识"贡献明确且与 Neo 现有方向同构:(1)它把"经验→策略→世界模型→可调用技能"的自进化链做成了带数学公式的工程实现(reflection-weighted value backprop、跨任务 policy 归纳的 gain 增益判据、skill 结晶的 eligibility/verifier 门槛),正好补 Neo 进化中枢记忆侧最缺的"从零散 trace 自动结晶出可复用能力"这一环——Neo 当前 self-evolution 偏代码进化,MemOS 是记忆/技能进化。(2)L3 world model(由 L2 策略聚类抽象出对环境/owner 的压缩认知,带 confidence 演化)可直接喂 Neo 的"内在世界/CogCore world model",让 Neo 对 owner 的理解从"检索片段"升级为"可演化的世界观"。(3)三层 RRF+MMR 检索注入比 Neo 现有双路召回更结构化,值得借鉴。(4)它与 Neo 共栈(SQLite+transformers.js+本地 LLM)、本地优先、可桥接 qwen3.6——是少数能在 owner 本机真跑、且设计哲学(本地个人 OS+自进化)高度对齐的候选。最佳姿势:借其 L1/L2/L3+reward+skill 的算法设计与判据,落到 Neo 自己的 CogCore,而非引入第二套记忆系统。
docs/RESEARCH_2026-06-14_Neo增强开源调研.md:221:- **对 Neo 价值**: 对"更智能/更接近意识"的真实贡献分三档：高价值=Sequential Thinking 给 CogCore 深思脑一个标准化、可回溯、可分支的思维链容器——把当前隐式推理变成可审计的 thought/revision/branch 显式轨迹，直接喂 mind.html 内心透视页，让"意识流"从口号变成有结构的数据(GWT 全局工作区也能消费这些 thought 作为可竞争的信息单元)。中价值=Memory 的属性图数据模型(实体/关系/观察)值得 borrow 进 Neo 知识层，补上当前 SQLite+向量召回缺的"结构化关系记忆"(谁-关系-谁)，让 Neo 能做关系推理而不只是相似度召回，这对类意识的"自我/世界模型一致性"是实打实的增量。中价值=Filesystem/Fetch 是稳态感官扩展(安全读写本机 + 网页感知)，巩固本地优先助手的手和眼。综合 verdict=borrow：Sequential Thinking/Filesystem/Fetch 三件可直接 adopt-as-config 接进现成 McpClientManager(plug-and-play)，唯独 Memory 因与 Neo 自有更强记忆层重叠，取其设计而非其实现——故整体定 borrow 最贴合。
docs/RESEARCH_2026-06-14_Neo增强开源调研.md:552:- **对 Neo 价值**: 直击 Neo 的硬约束:"本地小模型 + 不靠更强模型也要可靠推理"。rStar 给出的不是一个能装的库,而是一条被反复验证的范式——同级模型自我判别 + 树搜索 = 推理质变,完全不需要蒸馏 GPT-4/o1。对"更智能":可移植的 RC 判别器是 Neo 当前最缺的一块——给主脑 qwen3.6 配一个廉价的"二次自校验"闸门,把"模型说了"升级成"模型说了且自洽才算数",直接抬高工具调用、记忆写入、关键决策的可靠性,与现有 self-evolution、CogCore 期望账本(Brier 判证)、多模型交叉印证形成闭环互补。对"接近意识":其价值在认知架构层面而非玄学——它把 Neo 从"单次前向直觉输出"推向"生成→自我审视→修正/否决"的反身性回路(System-2 雏形),这种"对自己思考的再思考"正是 GWT/元认知方向上 Neo 该长的肌肉。务实结论:borrow——抄它的判别器与多动作采样思想,用 JS 在本地重写,挂关键链路;不 adopt 代码(Python/vLLM 不兼容),不 watch 了之(范式已足够成熟可立即落地)。
docs/exhaustive/openclaw_cron_m3补全.md:131:6. **`markCronJobActive / clearCronJobActive` 的对称配对**：Noe 的 self-evolution / consensus round / knowledge graph 重建都应该用 `try/finally` 包裹保证 clear 一定发生——避免主进程异常时活跃集合里残留"假活跃"导致后续任务永远被跳过。建议 Noe 抽一个 `withActiveGuard(taskId, fn)` 高阶函数，统一处理。
src/cognition/NoeLearningTopics.js:21:    query: 'agent memory conflict temporal knowledge graph Letta Mem0 Graphiti Zep sleep time compute',
src/cognition/NoeGoalSystem.js:573:    const baseWhy = `这条预测落空带来 ${Math.round(surpriseBit * 10) / 10} bit 惊奇——我的世界模型在这里有缺口`;
src/cognition/NoeGoalSystem.js:574:    const steps = ['回看相关记忆与时间线，找我当时的依据', '列出 2-3 个可能的解释', '修正一条认知并记进记忆'];

exec
/bin/zsh -lc "nl -ba src/cognition/NoeOwnerBehaviorPredictor.js | sed -n '1,45p'" in /Users/hxx/Desktop/Neo 贾维斯
 succeeded in 0ms:
     1	// @ts-check
     2	// NoeOwnerBehaviorPredictor — owner 行为预测最小闭环（codex 建议的功能性自我意识项）。
     3	//
     4	// 问题：期望账本此前只对「世界/自己」下注（反刍念头、深思预测），从不对「外部的 owner」下注。
     5	//   功能性自我意识更贴近的一环是：Noe 能在 owner 交互后预测「owner 下一步会怎么做」，并被 owner
     6	//   的真实后续行为硬纠正——这给的是「对他者的预期 + 校准误差」，比内心独白更接近"我知道我在和谁互动"。
     7	//
     8	// 设计（最小可行，零 LLM，复用 NoeExpectationLedger.add/open/resolve → 自动进 Brier）：
     9	//   每次 owner 交互（episodic timeline 的 type:'interaction'，即 owner 真说了话/真交办）时，
    10	//   ① 先结算：扫开放的 owner_pred 预测，若这条新交互文本命中某条预测的主题 token → resolve(id,1)；
    11	//      若 owner 明确取消/否定交办后的 followup → resolve(id,0) 并可触发 surprise 学习。
    12	//      （明确 outcome → 进 Brier；沉默/换话题仍靠 7 天 sweep/人工裁决兜底）。
    13	//   ② 再预测：从这条交互确定性抽「主题」（owner 提到的项目/名词）+「是否交办」，立 owner-behavior 类
    14	//      expectation：claim 内嵌稳定 token `[owner-pred:topic:<主题>]` / `[owner-pred:followup]`，
    15	//      claim=「owner 接下来还会再提到/谈论 <主题>」/「owner 会要求实测/回报/采纳」。
    16	//
    17	// 诚实·边界（最小版↔扩展位）：
    18	//   - 最小版不把「没做/没再提」强判落空(0)——与判证宪法一致（"仅没检索到证据≠落空"）。
    19	//     只有 owner 明确说取消/不用/先停/拒绝 followup 时，才把「交办后会要求实测/回报/采纳」结算为 0。
    20	//   - 主题抽取是粗粒度关键词（zh 连续块/ascii 词 + 停用词过滤），不接 NER/项目库——留扩展位：
    21	//     注入 subjectExtractor 可换更强的项目别名识别。
    22	//   - 概率 p 是固定先验（topic 0.55 弱、followup 0.75 强），非学习值——留扩展位：可后续按历史命中率自适应。
    23	//   - 全程 fail-open：ledger 缺失/任一调用抛错都静默退回，绝不阻断对话/反刍闭环。
    24
    25	import { clamp } from './_mathUtils.js';
    26
    27	const HOUR = 3600_000;
    28	const DAY = 24 * HOUR;
    29
    30	const TOKEN_PREFIX = 'owner-pred';
    31	const FOLLOWUP_TOKEN = `[${TOKEN_PREFIX}:followup]`;
    32	const topicToken = (subject) => `[${TOKEN_PREFIX}:topic:${subject}]`;
    33
    34	// owner 交互里「交办/布置任务」的确定性标记 → 立 followup 预测（会要求实测/回报/采纳）。
    35	const DELEGATION_RE = /(?:帮我|替我|去(?:做|办|查|跑|改|写|加|修|实现|验证)|交办|布置|安排|搞定|落实|实现一下|做一下|加一个|改一下|提个?\s*pr|跑(?:个|一?下)?\s*测|上线|部署|发布)/i;
    36	// owner 后续「兑现 followup」的确定性信号（要求实测/回报/采纳/通过/完成）。
    37	const FOLLOWUP_SETTLE_RE = /(?:实测|测一?下|跑(?:个|一?下)?\s*测|测试|验证|回报|汇报|报告进?展|采纳|通过|批准|合并|merge|done|搞定了|做完了?|完成了?|怎么样了|进展(?:如何|怎样)?|结果呢)/i;
    38	// owner 明确否定/取消 followup 的确定性信号。只用于 followup 预测，不用于 topic「会再提到」预测。
    39	const FOLLOWUP_FAIL_RE = /(?:(?:不用|不必|不要|别|先别|暂时别|无需)\s*(?:测|测试|验证|跑测|回报|汇报|报告|继续|做|改|修|查|跑|实现|采纳|合并|merge)|(?:取消|撤销|放弃|作废|先停|暂停|停掉|终止|不做了|别做了|不用做了|算了|先放(?:一)?放|不用了|不需要了)|(?:cancel(?:led|ed)?|abort(?:ed)?|stop|reject(?:ed)?|den(?:y|ied)|no need|not needed))/i;
    40
    41	// 主题抽取停用词（2 字虚词/泛词 + ascii 噪声词）：当主题会污染预测命中，直接丢。
    42	const STOPWORDS = new Set([
    43	  '这个', '那个', '一下', '一个', '什么', '怎么', '可以', '需要', '应该', '现在', '今天', '明天',
    44	  '我们', '你们', '他们', '自己', '这样', '那样', '没有', '不是', '就是', '还有', '已经', '然后',
    45	  '主人', '帮我', '替我', '去做', '一些', '东西', '问题', '时候', '地方', '这里', '那里', '一直',

exec
/bin/zsh -lc "nl -ba src/cognition/NoeApprovalGoalResolver.js | sed -n '70,125p'" in /Users/hxx/Desktop/Neo 贾维斯
 succeeded in 0ms:
    70	        approvalStatus,
    71	        actId: act?.id || retryResult?.act?.id || null,
    72	        actStatus: retryResult?.act?.status || act?.status || null,
    73	        action: retryResult?.act?.action || act?.action || null,
    74	        goalId: goalRef?.goalId || null,
    75	        stepIndex: goalRef?.stepIndex ?? null,
    76	        goalUpdated,
    77	        retryOk: retryResult?.ok ?? null,
    78	        error: error ? compactText(error, 300) : null,
    79	      },
    80	    });
    81	  } catch { /* activity failure must not block approval decisions */ }
    82	}
    83
    84	function syncGoalStep({ goalSystem, approvalId, approvalStatus, act, result = null, stepStatus, note, activityLog, error = null }) {
    85	  const finalAct = result?.act || act;
    86	  const goalRef = goalRefFromAct(finalAct) || goalRefFromAct(act);
    87	  let goalUpdated = false;
    88	  let goalDone = false;
    89	  if (goalRef && goalSystem?.recordStepResult) {
    90	    try {
    91	      goalSystem.recordStepCheckpoint?.(goalRef.goalId, goalRef.stepIndex, {
    92	        phase: approvalStatus === 'approved' ? 'approval_resume' : 'approval_decision',
    93	        status: stepStatus,
    94	        kind: 'act',
    95	        action: finalAct?.action || act?.action || '',
    96	        note,
    97	        evidenceRef: finalAct?.logRef || act?.logRef || '',
    98	        payload: {
    99	          approvalId,
   100	          approvalStatus,
   101	          actId: finalAct?.id || act?.id || null,
   102	          actStatus: finalAct?.status || act?.status || null,
   103	          ok: result?.ok ?? null,
   104	        },
   105	        replaySafe: false,
   106	      });
   107	    } catch { /* checkpoint failure should not block closure */ }
   108	    try {
   109	      const res = stepStatus === 'done'
   110	        ? goalSystem.recordStepResult(goalRef.goalId, goalRef.stepIndex, { done: true, note })
   111	        : goalSystem.recordStepResult(goalRef.goalId, goalRef.stepIndex, { status: stepStatus, note });
   112	      goalUpdated = res?.ok === true;
   113	      goalDone = res?.goalDone === true;
   114	    } catch { /* goal update failure is reported through activity */ }
   115	  }
   116	  recordActivity({ activityLog, approvalId, approvalStatus, act: finalAct || act, goalRef, stepStatus, goalUpdated, retryResult: result, error });
   117	  return { goalUpdated, goalDone, goalRef };
   118	}
   119
   120	export function createNoeApprovalGoalResolver({
   121	  actStore = null,
   122	  actPipeline = null,
   123	  goalSystem = null,
   124	  activityLog = null,
   125	  logger = console,

exec
/bin/zsh -lc "nl -ba src/cognition/NoeApprovalGoalResolver.js | sed -n '120,230p'" in /Users/hxx/Desktop/Neo 贾维斯
 succeeded in 0ms:
   120	export function createNoeApprovalGoalResolver({
   121	  actStore = null,
   122	  actPipeline = null,
   123	  goalSystem = null,
   124	  activityLog = null,
   125	  logger = console,
   126	} = {}) {
   127	  return async function resolveApprovalGoalDecision(approvalId, { status, approval } = {}) {
   128	    const id = compactText(approvalId || approval?.id, 160);
   129	    const approvalStatus = compactText(status || approval?.status, 40);
   130	    if (!id || !TERMINAL_DECISIONS.has(approvalStatus)) {
   131	      return { ok: true, skipped: true, reason: 'non_terminal_or_missing_approval', approvalId: id || null, status: approvalStatus || null };
   132	    }
   133	    const acts = listAwaitingActs(actStore, id);
   134	    if (!acts.length) return { ok: true, approvalId: id, status: approvalStatus, count: 0, results: [] };
   135	    const results = [];
   136	    for (const act of acts) {
   137	      if (approvalStatus === 'approved') {
   138	        if (!actPipeline?.retry) {
   139	          const note = '审批通过，但 ActPipeline.retry 未配置，目标步骤保持 blocked 以免永久等待。';
   140	          const synced = syncGoalStep({ goalSystem, approvalId: id, approvalStatus, act, stepStatus: 'blocked', note, activityLog, error: 'act_pipeline_retry_not_configured' });
   141	          results.push({ actId: act.id, ok: false, status: 'blocked', error: 'act_pipeline_retry_not_configured', ...synced });
   142	          continue;
   143	        }
   144	        try {
   145	          const retryResult = await actPipeline.retry(act.id, { approvalId: id, realExecute: true, reason: 'approval_approved_auto_resume' });
   146	          const stepStatus = statusFromRetry(retryResult);
   147	          const note = noteForRetry(retryResult);
   148	          const synced = syncGoalStep({ goalSystem, approvalId: id, approvalStatus, act, result: retryResult, stepStatus, note, activityLog, error: retryResult?.error || null });
   149	          results.push({ actId: act.id, ok: retryResult?.ok === true, status: stepStatus, actStatus: retryResult?.act?.status || null, ...synced });
   150	        } catch (e) {
   151	          const error = e?.message || String(e);
   152	          const note = `审批通过后自动续跑失败：${compactText(error, 220)}`;
   153	          const synced = syncGoalStep({ goalSystem, approvalId: id, approvalStatus, act, stepStatus: 'failed', note, activityLog, error });
   154	          logger?.warn?.('[noe-approval-goal] auto resume failed:', error);
   155	          results.push({ actId: act.id, ok: false, status: 'failed', error: compactText(error, 300), ...synced });
   156	        }
   157	        continue;
   158	      }
   159	      const cancelled = actStore?.cancel?.(act.id, { reason: `approval_${approvalStatus}` }) || act;
   160	      const note = noteForDecline(approvalStatus);
   161	      const synced = syncGoalStep({ goalSystem, approvalId: id, approvalStatus, act: cancelled || act, stepStatus: 'blocked', note, activityLog });
   162	      results.push({ actId: act.id, ok: true, status: 'blocked', actStatus: cancelled?.status || act.status, ...synced });
   163	    }
   164	    return { ok: true, approvalId: id, status: approvalStatus, count: results.length, results };
   165	  };
   166	}

exec
/bin/zsh -lc "rg -n \"NoeApprovalGoalResolver|resolveApprovalGoalDecision|approvalGoal\" server.js src -g '*.js'" in /Users/hxx/Desktop/Neo 贾维斯
 succeeded in 0ms:
server.js:290:import { createNoeApprovalGoalResolver } from './src/cognition/NoeApprovalGoalResolver.js';
server.js:1129:const noeApprovalGoalResolver = createNoeApprovalGoalResolver({
src/cognition/NoeApprovalGoalResolver.js:120:export function createNoeApprovalGoalResolver({
src/cognition/NoeApprovalGoalResolver.js:127:  return async function resolveApprovalGoalDecision(approvalId, { status, approval } = {}) {

exec
/bin/zsh -lc "nl -ba server.js | sed -n '1124,1138p'" in /Users/hxx/Desktop/Neo 贾维斯
 succeeded in 0ms:
  1124	      state: { get: kvGet, set: kvSet },
  1125	      recordEpisode: (e) => { try { noeEpisodicTimeline?.record?.(e); } catch { /* 自修复经历留痕失败不阻断 */ } },
  1126	    })
  1127	  : null;
  1128	if (noeIncidentEscalator) console.log('[noe-incidents] 自修复升级器已启用（内心/运行时故障 → system_repair goal → act 诊断/验证 → 任务回报）');
  1129	const noeApprovalGoalResolver = createNoeApprovalGoalResolver({
  1130	  actStore: noeActStore,
  1131	  actPipeline: noeActPipeline,
  1132	  goalSystem: noeGoalSystem,
  1133	  activityLog,
  1134	  logger: console,
  1135	});
  1136	// ── 心智体征（长期规划 M1/M5）：语义级多样性/接地度计量——治 Echo Trap 的测量端与主防线
  1137	//    （字符级只防字面重复，防不住"同一个调子的十二种写法"）。嵌入走本地 ollama
  1138	//    （NOE_MEMORY_EMBED=ollama 时启用），不可用为 null → 反刍自动降级字符级防线（fail-open）。

codex
另一个明确漏点是审批/恢复路径：Workspace 只在初次 act/research 失败处调用 bridge；审批拒绝、后台步骤 stale/recovered、研究返回空报告这些“现实失败”没有进入 bridge。
exec
/bin/zsh -lc "rg -n \"noeApprovalGoalResolver|resolveApprovalGoalDecision|approval.*resolver|approvalGoalResolver\" server.js src/server src/runtime -g '*.js'" in /Users/hxx/Desktop/Neo 贾维斯
 succeeded in 0ms:
server.js:1129:const noeApprovalGoalResolver = createNoeApprovalGoalResolver({
server.js:2514:  void noeApprovalGoalResolver(id, { status, approval })

exec
/bin/zsh -lc "nl -ba server.js | sed -n '2506,2518p'" in /Users/hxx/Desktop/Neo 贾维斯
 succeeded in 0ms:
  2506	// C2：审批决议 / 预算 incident 解决 → 联动推进治理工作队列项（dedupe_key = kind:sourceId）
  2507	// 队列项由 buildGovernanceSummary 的 blockers 派生，kind 仅 approval/budget/delegation/autopilot_job
  2508	// （无 agent_run），且 blocker.id 即 approvalId / incidentId。run 归档时其 approval/budget 阻塞
  2509	// 已由下列各自 hook 推进，故归档不再单独联动队列（避免对不存在的 kind 做无效写）。
  2510	// 任一终态决议都解除该审批阻塞；预算解决解除该预算阻塞 → 队列项置 done。
  2511	approvalStore.setDecisionHook((id, { status, approval } = {}) => {
  2512	  try { governanceQueueStore.setStateBySource('approval', id, 'done', `approval ${status || 'decided'}`); }
  2513	  catch { /* 联动失败不阻断决议 */ }
  2514	  void noeApprovalGoalResolver(id, { status, approval })
  2515	    .catch((e) => console.warn('[noe-approval-goal] decision hook failed:', e?.message || e));
  2516	});
  2517	budgetPolicyStore.setIncidentResolveHook((id) => {
  2518	  try { governanceQueueStore.setStateBySource('budget', id, 'done', 'budget incident resolved'); }

codex
结论：不算彻底根除。阶段 1 只是在 `NOE_STEP_EXPECTATION_RESOLVE=1` 时给“step 失败 → outcome=0 → source=surprise”接了一个供给旁路；reward hacking 没堵死，学习闭环也还没闭合。

① **Reward Hacking：未堵死**
- 【高】Neo 可以机械刷：bridge 只检查 `kind in act/research` 和 `terminal in failed/blocked`，不校验 step 是否必要、是否预先下注、是否重复失败主题。证据：[NoeStepExpectationBridge.js:41](</Users/hxx/Desktop/Neo 贾维斯/src/cognition/NoeStepExpectationBridge.js:41>)、[NoeWorkspace.js:573](</Users/hxx/Desktop/Neo 贾维斯/src/cognition/NoeWorkspace.js:573>)、[NoeWorkspace.js:102](</Users/hxx/Desktop/Neo 贾维斯/src/cognition/NoeWorkspace.js:102>)。
- 【高】这是事后造“隐式预测”：失败发生后才 `add({p:0.8})` 再立刻 `resolve(0)`，不是执行前真实下注。会污染 Brier/活性指标。证据：[NoeStepExpectationBridge.js:49](</Users/hxx/Desktop/Neo 贾维斯/src/cognition/NoeStepExpectationBridge.js:49>)、[NoeExpectationLedger.js:200](</Users/hxx/Desktop/Neo 贾维斯/src/cognition/NoeExpectationLedger.js:200>)。
- 【高】方案要求 `harvestSurprise` 有 origin 白名单硬门，但当前只记录 origin，不拒绝非白名单；甚至 `origin=unspecified` 也能立目标。证据：[NoeGoalSystem.js:568](</Users/hxx/Desktop/Neo 贾维斯/src/cognition/NoeGoalSystem.js:568>)、[NoeGoalSystem.js:577](</Users/hxx/Desktop/Neo 贾维斯/src/cognition/NoeGoalSystem.js:577>)、[阶段方案:12](</Users/hxx/Desktop/Neo 贾维斯/docs/research/_claude-自主学习方案.md:12>)。
- 【中】去重不足：goal 只按“同标题且 open/active”精确去重；ledger 只查未结算 open 预测，但 bridge 立即 resolve，所以重复失败换个措辞就能绕。证据：[NoeGoalSystem.js:253](</Users/hxx/Desktop/Neo 贾维斯/src/cognition/NoeGoalSystem.js:253>)、[NoeExpectationLedger.js:95](</Users/hxx/Desktop/Neo 贾维斯/src/cognition/NoeExpectationLedger.js:95>)。

② **学习闭环：没真通**
- 【高】`source=surprise` 目标的 steps 是 3 个纯 think 字符串：`回看...`、`列出...`、`修正...记进记忆`。没有 research/act/memory-write action。证据：[NoeGoalSystem.js:574](</Users/hxx/Desktop/Neo 贾维斯/src/cognition/NoeGoalSystem.js:574>)、[NoeGoalSystem.js:262](</Users/hxx/Desktop/Neo 贾维斯/src/cognition/NoeGoalSystem.js:262>)。
- 【高】think 步完成只把审议文本写回 goal plan note；“修正认知并记进记忆”不是被执行的写记忆操作。证据：[NoeWorkspace.js:586](</Users/hxx/Desktop/Neo 贾维斯/src/cognition/NoeWorkspace.js:586>)、[NoeWorkspace.js:594](</Users/hxx/Desktop/Neo 贾维斯/src/cognition/NoeWorkspace.js:594>)。
- 【中】done 后唯一记忆入口是通用 `distillSkill`，它可能 `SKIP`、去重跳过或静默失败；写的是 `skill_distill` 技能卡，不是针对失败 claim 的 worldModel/learnedRule 修正。证据：[server.js:1541](</Users/hxx/Desktop/Neo 贾维斯/server.js:1541>)、[server.js:1557](</Users/hxx/Desktop/Neo 贾维斯/server.js:1557>)、[server.js:1570](</Users/hxx/Desktop/Neo 贾维斯/server.js:1570>)。

③ **现实打脸源：还漏很多**
- 【高】research fulfilled 但无 `report`：checkpoint 标 `blocked`、journal `ok:false`，却 `recordStepResult(done:true)`，不会触发 bridge。证据：[NoeWorkspace.js:493](</Users/hxx/Desktop/Neo 贾维斯/src/cognition/NoeWorkspace.js:493>)、[NoeWorkspace.js:496](</Users/hxx/Desktop/Neo 贾维斯/src/cognition/NoeWorkspace.js:496>)。
- 【高】stale/orphan 的 doing step 被标 `recovered`，后续还可算目标完成；这类执行消失没有进入 surprise。证据：[NoeGoalStepRecovery.js:45](</Users/hxx/Desktop/Neo 贾维斯/src/cognition/NoeGoalStepRecovery.js:45>)、[NoeGoalStepRecorder.js:77](</Users/hxx/Desktop/Neo 贾维斯/src/cognition/NoeGoalStepRecorder.js:77>)。
- 【中】owner 拒绝审批会把 step 置 `blocked`，但 `NoeApprovalGoalResolver` 没注入 step bridge。证据：[NoeApprovalGoalResolver.js:159](</Users/hxx/Desktop/Neo 贾维斯/src/cognition/NoeApprovalGoalResolver.js:159>)、[server.js:1129](</Users/hxx/Desktop/Neo 贾维斯/server.js:1129>)。
- 【中】owner 纠错只覆盖“followup 取消/拒绝”和 Mind UI 手动裁决；普通对话里的“你错了/不是这样”没有通用 correction bridge。证据：[NoeOwnerBehaviorPredictor.js:17](</Users/hxx/Desktop/Neo 贾维斯/src/cognition/NoeOwnerBehaviorPredictor.js:17>)、[noeMind.js:591](</Users/hxx/Desktop/Neo 贾维斯/src/server/routes/noeMind.js:591>)。
- 【高】网页/外部内容与世界模型矛盾没有检测。页面正文只被摘要进 action note，没有 assertion conflict / worldModel compare。证据：[NoeWorkspace.js:124](</Users/hxx/Desktop/Neo 贾维斯/src/cognition/NoeWorkspace.js:124>)、[NoeWorkspace.js:531](</Users/hxx/Desktop/Neo 贾维斯/src/cognition/NoeWorkspace.js:531>)。

④ **代码正确性边界**
- 【高】`NOE_STEP_EXPECTATION_RESOLVE` 默认不在 `NOE_AUTONOMY_DEFAULTS`，bridge 默认 inert，且无启动告警。证据：[server.js:32](</Users/hxx/Desktop/Neo 贾维斯/server.js:32>)、[NoeStepExpectationBridge.js:41](</Users/hxx/Desktop/Neo 贾维斯/src/cognition/NoeStepExpectationBridge.js:41>)。
- 【中】`NOE_CURIOSITY=0` 不能全局关掉好奇立项：bridge/resolver 直接调用 `harvestSurprise`，只有 Mind 手动 route 自己检查 env。证据：[NoeStepExpectationBridge.js:56](</Users/hxx/Desktop/Neo 贾维斯/src/cognition/NoeStepExpectationBridge.js:56>)、[NoeExpectationResolver.js:1598](</Users/hxx/Desktop/Neo 贾维斯/src/cognition/NoeExpectationResolver.js:1598>)、[noeMind.js:602](</Users/hxx/Desktop/Neo 贾维斯/src/server/routes/noeMind.js:602>)。
- 【中】resolver 减压没有完成：`maxPerTick` 仍默认 3，server 装配没覆盖；343 open 预测仍会慢慢淤积或 UNKNOWN。证据：[NoeExpectationResolver.js:1388](</Users/hxx/Desktop/Neo 贾维斯/src/cognition/NoeExpectationResolver.js:1388>)、[server.js:2036](</Users/hxx/Desktop/Neo 贾维斯/server.js:2036>)。
- 【中】bridge 和调用点双层吞异常，无 skipped/error counter；坏了会静默回到 R5。证据：[NoeStepExpectationBridge.js:58](</Users/hxx/Desktop/Neo 贾维斯/src/cognition/NoeStepExpectationBridge.js:58>)、[NoeWorkspace.js:511](</Users/hxx/Desktop/Neo 贾维斯/src/cognition/NoeWorkspace.js:511>)。

⑤ **根除判定 + 必补**
- 【结论/高】阶段 1 只能算“接通了一个执行失败供给源”，不算根除自主学习空耗。
- 必补 P0：执行前预注册 step expectation，带 `goalId/stepIndex/action/failureClass/stepHash/confidence`；终态只 resolve 原 id，禁止失败后造账。
- 必补 P0：`harvestSurprise` 做硬白名单 + `origin+stepHash+failureClass` 去重/限速；重复可避免失败降权或标 suspect。
- 必补 P0：`source=surprise` 目标改成 evidence-backed learningHook：读取相关记忆/时间线/action log/page body，产出结构化 lesson，写入 memory/worldModel，并验证 recall；写不进去不能算 done。
- 必补 P1：接上 research 空报告、审批拒绝、stale recovered、owner 普通纠错、worldModel/page contradiction；同时把 resolver `maxPerTick` 和 backlog 消化补完。
tokens used
160,435
结论：不算彻底根除。阶段 1 只是在 `NOE_STEP_EXPECTATION_RESOLVE=1` 时给“step 失败 → outcome=0 → source=surprise”接了一个供给旁路；reward hacking 没堵死，学习闭环也还没闭合。

① **Reward Hacking：未堵死**
- 【高】Neo 可以机械刷：bridge 只检查 `kind in act/research` 和 `terminal in failed/blocked`，不校验 step 是否必要、是否预先下注、是否重复失败主题。证据：[NoeStepExpectationBridge.js:41](</Users/hxx/Desktop/Neo 贾维斯/src/cognition/NoeStepExpectationBridge.js:41>)、[NoeWorkspace.js:573](</Users/hxx/Desktop/Neo 贾维斯/src/cognition/NoeWorkspace.js:573>)、[NoeWorkspace.js:102](</Users/hxx/Desktop/Neo 贾维斯/src/cognition/NoeWorkspace.js:102>)。
- 【高】这是事后造“隐式预测”：失败发生后才 `add({p:0.8})` 再立刻 `resolve(0)`，不是执行前真实下注。会污染 Brier/活性指标。证据：[NoeStepExpectationBridge.js:49](</Users/hxx/Desktop/Neo 贾维斯/src/cognition/NoeStepExpectationBridge.js:49>)、[NoeExpectationLedger.js:200](</Users/hxx/Desktop/Neo 贾维斯/src/cognition/NoeExpectationLedger.js:200>)。
- 【高】方案要求 `harvestSurprise` 有 origin 白名单硬门，但当前只记录 origin，不拒绝非白名单；甚至 `origin=unspecified` 也能立目标。证据：[NoeGoalSystem.js:568](</Users/hxx/Desktop/Neo 贾维斯/src/cognition/NoeGoalSystem.js:568>)、[NoeGoalSystem.js:577](</Users/hxx/Desktop/Neo 贾维斯/src/cognition/NoeGoalSystem.js:577>)、[阶段方案:12](</Users/hxx/Desktop/Neo 贾维斯/docs/research/_claude-自主学习方案.md:12>)。
- 【中】去重不足：goal 只按“同标题且 open/active”精确去重；ledger 只查未结算 open 预测，但 bridge 立即 resolve，所以重复失败换个措辞就能绕。证据：[NoeGoalSystem.js:253](</Users/hxx/Desktop/Neo 贾维斯/src/cognition/NoeGoalSystem.js:253>)、[NoeExpectationLedger.js:95](</Users/hxx/Desktop/Neo 贾维斯/src/cognition/NoeExpectationLedger.js:95>)。

② **学习闭环：没真通**
- 【高】`source=surprise` 目标的 steps 是 3 个纯 think 字符串：`回看...`、`列出...`、`修正...记进记忆`。没有 research/act/memory-write action。证据：[NoeGoalSystem.js:574](</Users/hxx/Desktop/Neo 贾维斯/src/cognition/NoeGoalSystem.js:574>)、[NoeGoalSystem.js:262](</Users/hxx/Desktop/Neo 贾维斯/src/cognition/NoeGoalSystem.js:262>)。
- 【高】think 步完成只把审议文本写回 goal plan note；“修正认知并记进记忆”不是被执行的写记忆操作。证据：[NoeWorkspace.js:586](</Users/hxx/Desktop/Neo 贾维斯/src/cognition/NoeWorkspace.js:586>)、[NoeWorkspace.js:594](</Users/hxx/Desktop/Neo 贾维斯/src/cognition/NoeWorkspace.js:594>)。
- 【中】done 后唯一记忆入口是通用 `distillSkill`，它可能 `SKIP`、去重跳过或静默失败；写的是 `skill_distill` 技能卡，不是针对失败 claim 的 worldModel/learnedRule 修正。证据：[server.js:1541](</Users/hxx/Desktop/Neo 贾维斯/server.js:1541>)、[server.js:1557](</Users/hxx/Desktop/Neo 贾维斯/server.js:1557>)、[server.js:1570](</Users/hxx/Desktop/Neo 贾维斯/server.js:1570>)。

③ **现实打脸源：还漏很多**
- 【高】research fulfilled 但无 `report`：checkpoint 标 `blocked`、journal `ok:false`，却 `recordStepResult(done:true)`，不会触发 bridge。证据：[NoeWorkspace.js:493](</Users/hxx/Desktop/Neo 贾维斯/src/cognition/NoeWorkspace.js:493>)、[NoeWorkspace.js:496](</Users/hxx/Desktop/Neo 贾维斯/src/cognition/NoeWorkspace.js:496>)。
- 【高】stale/orphan 的 doing step 被标 `recovered`，后续还可算目标完成；这类执行消失没有进入 surprise。证据：[NoeGoalStepRecovery.js:45](</Users/hxx/Desktop/Neo 贾维斯/src/cognition/NoeGoalStepRecovery.js:45>)、[NoeGoalStepRecorder.js:77](</Users/hxx/Desktop/Neo 贾维斯/src/cognition/NoeGoalStepRecorder.js:77>)。
- 【中】owner 拒绝审批会把 step 置 `blocked`，但 `NoeApprovalGoalResolver` 没注入 step bridge。证据：[NoeApprovalGoalResolver.js:159](</Users/hxx/Desktop/Neo 贾维斯/src/cognition/NoeApprovalGoalResolver.js:159>)、[server.js:1129](</Users/hxx/Desktop/Neo 贾维斯/server.js:1129>)。
- 【中】owner 纠错只覆盖“followup 取消/拒绝”和 Mind UI 手动裁决；普通对话里的“你错了/不是这样”没有通用 correction bridge。证据：[NoeOwnerBehaviorPredictor.js:17](</Users/hxx/Desktop/Neo 贾维斯/src/cognition/NoeOwnerBehaviorPredictor.js:17>)、[noeMind.js:591](</Users/hxx/Desktop/Neo 贾维斯/src/server/routes/noeMind.js:591>)。
- 【高】网页/外部内容与世界模型矛盾没有检测。页面正文只被摘要进 action note，没有 assertion conflict / worldModel compare。证据：[NoeWorkspace.js:124](</Users/hxx/Desktop/Neo 贾维斯/src/cognition/NoeWorkspace.js:124>)、[NoeWorkspace.js:531](</Users/hxx/Desktop/Neo 贾维斯/src/cognition/NoeWorkspace.js:531>)。

④ **代码正确性边界**
- 【高】`NOE_STEP_EXPECTATION_RESOLVE` 默认不在 `NOE_AUTONOMY_DEFAULTS`，bridge 默认 inert，且无启动告警。证据：[server.js:32](</Users/hxx/Desktop/Neo 贾维斯/server.js:32>)、[NoeStepExpectationBridge.js:41](</Users/hxx/Desktop/Neo 贾维斯/src/cognition/NoeStepExpectationBridge.js:41>)。
- 【中】`NOE_CURIOSITY=0` 不能全局关掉好奇立项：bridge/resolver 直接调用 `harvestSurprise`，只有 Mind 手动 route 自己检查 env。证据：[NoeStepExpectationBridge.js:56](</Users/hxx/Desktop/Neo 贾维斯/src/cognition/NoeStepExpectationBridge.js:56>)、[NoeExpectationResolver.js:1598](</Users/hxx/Desktop/Neo 贾维斯/src/cognition/NoeExpectationResolver.js:1598>)、[noeMind.js:602](</Users/hxx/Desktop/Neo 贾维斯/src/server/routes/noeMind.js:602>)。
- 【中】resolver 减压没有完成：`maxPerTick` 仍默认 3，server 装配没覆盖；343 open 预测仍会慢慢淤积或 UNKNOWN。证据：[NoeExpectationResolver.js:1388](</Users/hxx/Desktop/Neo 贾维斯/src/cognition/NoeExpectationResolver.js:1388>)、[server.js:2036](</Users/hxx/Desktop/Neo 贾维斯/server.js:2036>)。
- 【中】bridge 和调用点双层吞异常，无 skipped/error counter；坏了会静默回到 R5。证据：[NoeStepExpectationBridge.js:58](</Users/hxx/Desktop/Neo 贾维斯/src/cognition/NoeStepExpectationBridge.js:58>)、[NoeWorkspace.js:511](</Users/hxx/Desktop/Neo 贾维斯/src/cognition/NoeWorkspace.js:511>)。

⑤ **根除判定 + 必补**
- 【结论/高】阶段 1 只能算“接通了一个执行失败供给源”，不算根除自主学习空耗。
- 必补 P0：执行前预注册 step expectation，带 `goalId/stepIndex/action/failureClass/stepHash/confidence`；终态只 resolve 原 id，禁止失败后造账。
- 必补 P0：`harvestSurprise` 做硬白名单 + `origin+stepHash+failureClass` 去重/限速；重复可避免失败降权或标 suspect。
- 必补 P0：`source=surprise` 目标改成 evidence-backed learningHook：读取相关记忆/时间线/action log/page body，产出结构化 lesson，写入 memory/worldModel，并验证 recall；写不进去不能算 done。
- 必补 P1：接上 research 空报告、审批拒绝、stale recovered、owner 普通纠错、worldModel/page contradiction；同时把 resolver `maxPerTick` 和 backlog 消化补完。
