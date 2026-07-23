# 阶段1 根除验证 context（喂三方第三轮：M3 / codex GPT5.5 / Claude）

## 目标：验证「现在算不算彻底根除」，找残留致命/严重

前两轮三方复盘判阶段1「否→部分根除」。第二轮所有 P0/P1 发现已全部整改（git commit，全量 5118 测绿）：

## 第二轮整改全清单（要验证是否真解决）
1. **learningHook 救活**（批次C，三方真 sqlite probe 确认写入线活）：kind:'insight'+evidenceRefs 过 gate、
   memId=c.memory.id+查 c.ok、recall 用 memory.get(memId) 精确(非自证)、recall 补 projectId、persisted≠learned 诚实化、真 sqlite 端到端测试。
2. **F2 act 失败被吞**（高危）：NoeWorkspace 按 ar.act.status 区分——status==='failed'→terminal:'failed'(executor 真失败)，否则 blocked。
3. **WM-FATAL-1 worldModel recall 死链**（最关键）：整条自然语言 topic 做 FTS trigram 子串匹配召回恒 0 →
   改 extractKeywords 抽关键词(中文≥2字块+ascii)分别召回，belief 含任一即命中。真 sqlite 测试证明整条召回0+关键词命中。
4. **F3 browse 接入**：act browse 读到的 pageSummary 也喂 worldModel(原只接 research)。
5. **F6 owner correction 源**：NoeOwnerCorrectionBridge 检测 owner 纠正(不对/其实是，排疑问)→harvestSurprise(owner_correction,surprise=3)，搭 ownerInteractionWatcher。
6. **budget 泄漏假 surprise**：classifyFailure 加 budget 自由文本宽匹配(budget blocked 带空格精确码匹配不上)。
7. **worldModel CONFLICT 正则误报**：逐行行首锚定 ^CONFLICT(NO CONFLICT 不匹配)。
8. **F1 端到端实证**：真 ledger+goalSystem+bridge+MemoryCore+learningHook 串联，act 失败/worldModel 矛盾/owner 纠正三源→surprise goal→noe_memory 真出 surprise_lesson 行(闭环活)。
9. **#6 接审计**：buildCuriosityYieldReport 加 learning 段(lessonsWritten+lessonsRead 即 hit_count>0 行为级被读信号+readRate)+盲卡诊断。
10. **CAL-10 断言** + **F8 recent Map LRU cap**(三 bridge size≥1000 删最旧)。

## 三 flag 全默认 OFF（NOE_STEP_EXPECTATION_RESOLVE/NOE_LEARNING_HOOK/NOE_WORLDMODEL_CONFLICT/NOE_OWNER_CORRECTION）

## 请三方彻底审查（验证根除 + 专找残留）
1. **WM-FATAL-1 真解决了吗**：extractKeywords 关键词召回真能命中 belief 吗(中文分词够吗/英文术语)？会不会关键词太宽召回无关 belief→喂本地脑刷假矛盾(F5 担心的现在会不会成真)？
2. **F2 真解决了吗**：NoeWorkspace 按 ar.act.status 区分对吗？还有别的 act 真失败路径漏判 blocked 吗？
3. **F1 端到端实证够吗**：用 mock adapter 的端到端测试能代表生产闭环活吗？生产真开 flag 跑会怎样？
4. **owner correction 误判**：CORRECTION_RE(不对/错了/其实是)会不会把非纠正的对话(如"其实我想问…")误判 surprise？
5. **整个阶段1 现在算根除吗**：第二轮所有整改后，三 flag 全开 DB 跑起来——供给三源(act失败净化后/worldModel关键词召回/owner纠正)健康产出+learningHook 真写进+#6 可复核，还是还有死链/噪声/指标繁荣残留？给「是/部分/否」+ 残留清单。
6. **还有第二轮没发现的致命/严重吗**：连续两轮复盘后，这轮专找前两轮遗漏的深层问题。
7. **代码正确性 + 零回归**。

每条给结论+file:line/推理+严重度(致命/严重/一般)+改法。专找残留别肯定。这是第三轮，重点是「整改是否真解决 + 还有没有漏的」。
