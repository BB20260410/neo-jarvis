# 阶段1 批次C + #4 + #5 复盘 context（喂三方：M3 / codex GPT5.5 / Claude）

## 目标：验证主体整改真有效 + 判定阶段1 是否根除 + 剩余必要性

上一轮三方一致判阶段1「否」（learningHook 生产 100% 死 + 供给端饿死 + 信息层源缺位）。已做三批整改（git 全 commit，全量 5105 测绿）：

## 批次C：救活 learningHook（src/cognition/NoeLearningHook.js）
上轮 Claude 真 sqlite probe 铁证旧版 noe_memory 行数=0。四致命 bug 全修：
- G1: kind:'lesson' 非 ALLOWED_KINDS→退 fact→source_evidence_required 拒；改 `kind:'insight'`+`evidenceRefs:['goal:'+id']` 过 gate
- G2: commit 返回 {ok,candidate,memory}，`memId=c.memory.id`+查 `c.ok`
- G3: recall「写完立刻查同 topic 必中」自证假阳→改 `memory.get(memId)` 精确命中；诚实区分 persisted(写入可取回)≠learned(行为改变)
- D1: recall 不传 projectId(默认 default) 而 lesson 写 noe→召回恒空；两处补 `projectId:'noe'`
- C6: 单测改真 sqlite 端到端(真 MemoryCore+WriteGate)断言 noe_memory 真有行；isRelearn 空耗预警(同 topic 已有 lesson=反复学没学会)

## #4：供给端净化（src/cognition/NoeStepExpectationBridge.js）
- SYSTEM_GATE_RE 裸子串 not_met/budget/dry_run→`classifyFailure(reason,terminal)→{system_gate,transient,real}` 结构化枚举：
  blocked=系统门；failed 路按精确 code/TRANSIENT_RE 分类；瞬时噪声(timeout/network/5xx)skip:transient
- 去重 key 用 klass 枚举(非 reason 前40字)→同步骤不同措辞落同桶→去重生效

## #5：worldModel 矛盾源（src/cognition/NoeWorldModelContradictionBridge.js，根除主线）
- research done→onContentObserved({content:rr.report,topic})→recall belief(带 projectId)→本地脑判事实矛盾(CONFLICT/NONE)→harvestSurprise(world_model_conflict)
- 无 belief=初次学不产；去重限速；接 NoeWorkspace research done(async fire-and-forget)
- isNonNoiseSurpriseOrigin/SURPRISE_ORIGIN_ENUM/surpriseOriginBreakdown 三处认 world_model_conflict 非噪声
- flag NOE_WORLDMODEL_CONFLICT 默认 OFF

## 还没做（待本轮判定必要性）
- owner 否定事实判断扩展（现状只有 NoeOwnerBehaviorPredictor 的 followup 取消→owner_prediction）
- #6: learned 行为级反事实判据 + lessonsWritten/persistedRate 接进 surprise-learning-audit(当前零度量)
- #7: recent/hourly 持久化 / action_failure claim 语义重写 / CAL-10 断言单测

## 请三方彻底审查（专找漏洞 + 判定根除）
1. **learningHook 真救活了吗**：批次C 后生产 gate 下真能写进(insight+evidenceRefs 够吗，evidenceRefs 只有 goal:id 一条够过门吗)？写进的 lesson 真会被 Neo 下次决策读到(NoeDeliberation/NoeActiveMemory recall 真召回 insight 类吗)？persisted≠learned 的诚实化够吗，还是仍有指标繁荣残留？
2. **worldModel 矛盾源真有效吗**：本地脑判 CONFLICT/NONE 靠谱吗(会不会大量误判矛盾刷 surprise / 或全判 NONE 永不产)？接 research done 够吗(browse 读到内容没接)？「无 belief=不产」会不会把「初次读到颠覆性信息」漏掉？conflictSurprise 固定 2.5 合理吗？去重/限速够吗？
3. **供给净化 #4 真堵了吗**：classifyFailure 的 transient/real 边界对吗(ENOENT/spawn 算 real 对吗)？blocked 全判 system_gate 会不会漏掉真该学的 blocked？枚举去重会不会过度合并漏真 surprise？
4. **owner 否定扩展必须吗**：worldModel 矛盾源 + 已有 owner predictor(followup) 够不够信息层源，还是必须再接「owner 否定 Neo 事实判断」(对话流 correction)才算根除？给明确判定。
5. **整个阶段1 现在算根除吗**：批次A/C/#4/#5 后，三个 flag(NOE_STEP_EXPECTATION_RESOLVE/NOE_LEARNING_HOOK/NOE_WORLDMODEL_CONFLICT)全开，DB 跑起来会怎样？source=surprise 会健康产出+真学到+可复核，还是还有死链/噪声/指标繁荣？给「是/部分/否」+ 还差什么才算根除。
6. **#6/#7 必要性**：learned 行为级判据 + 接审计(C10) 是根除必须还是优化？P2 加固呢？
7. **代码正确性 + 零回归 + 边界**。

每条给结论+file:line/推理+严重度+改法。专找漏洞别肯定。三个 flag 全默认 OFF。
