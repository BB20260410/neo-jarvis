# Neo 自主学习改造方案（M3 + Claude 多模型研究综合）

## 分阶段设计

### 阶段 0 · 即时止血(零认知改造,纯 .env + 配置,5 分钟可回滚)
目标:先让生产停止烧配额打转,不引入任何新机制,为后续治本争取时间。三个动作均走 .env,不碰代码:(1) NOE_AUTONOMOUS_LEARNING_CONTINUOUS=0 — 关掉『done 立即接下一轮』的无冷却链,让 self_learning 回到 INTERVAL 节流(治 R2,DB 显示这是 131 目标暴涨的直接阀门);(2) NOE_AUTONOMOUS_LEARNING_INTERVAL_MS=900000 — 60s→15min,把空转频率压 15 倍(治 R1 烧配额的量);(3) 在 server.js 的 distillSkill 加一道 commit 前『近 50 张 skill_distill 卡 textSimilarity>0.9 则 skip』的最小拦截(复用已被 ExpectationLedger 用的 NoeMemoryDedup.textSimilarity,治 R6 堆积的增量,不动选题逻辑)。验收:重启隔离端口 PORT=51999 跑 30 分钟,DB 对比 self_learning 新增目标数应≤2(原 30min 约新增 30),skill_distill 新卡 distinct/total 比应回升。反向 probe:把 INTERVAL 临时设回 60s 确认目标流确实加快(证明阀门真接在链上,非安慰剂)。
文件: .env(改 3 个值,全是已存在的 key);server.js distillSkill 段(:1531-1561,加一个 dedupSkillBeforeCommit 守卫,约 15 行,复用 NoeMemoryDedup)
验收: 隔离端口 30min:self_learning 新增目标≤2(原~30);skill_distill 新卡相似度>0.9 的被 skip 计数>0;反向 probe INTERVAL=60s 目标流加快。全部不需新认知模块,失败可立即把 .env 三值改回。

### 阶段 1 · 修活预测-判证-供给闭环(接通好奇回路的入口,治 R5/R5b — 这是最根本的一步)
核心洞察(DB 实证倒逼):好奇回路死的真根因不是 harvestSurprise 门槛,是判证供给端永远没有 outcome=0。最小改造分两半:(A)【补可程序化判落空的供给】act/research 步的真实终态(done/failed/blocked)本身就是对『这步会成功』这条隐式预测的判证 — 新建一条轻量旁路:goal step 落 failed/blocked 时,对该步骤当时若登记过 expectation 直接 resolve(outcome=0),让 outcome=0 真能产生(不依赖 LLM 判证器看懂证据)。这绕开 R5b 的 UNKNOWN 偏置瓶颈。(B)【给 resolver 减压】NOE_EXPECT_LOOSEN_FAIL=1 + 提高 maxPerTick(3→8)+ 缩 RESOLVE_MS(让 243 条过期 open 加速消化)。防 reward hacking(红队点 R1):outcome=0 只采纳『真实世界终态失败/owner 否定』(surpriseOriginBreakdown 已分桶 owner_/action_failure 为非噪声),绝不让 Neo 自评 outcome 主导 — 即 surprise 来源必须是 action_failure/owner_prediction/owner_manual 三类硬来源之一,自评类一律不喂 harvestSurprise。
文件: 新增 src/cognition/NoeStepExpectationBridge.js(<150行,纯函数+DI,把 step 终态映射成 expectation resolve,门控 NOE_STEP_EXPECTATION_RESOLVE 默认 OFF);改 NoeExpectationResolver.js(maxPerTick/loosenFail 经注入,不改判证规则);改 harvestSurprise 入口加 origin 白名单硬门(NoeGoalSystem.js:556)
验收: 隔离端口跑含已知会失败的 act 步(故意指向不存在的 app):DB 中 noe_expectations 出现 outcome=0 条目(原恒 0);若该 surprise≥阈值且 origin∈白名单,noe_goals 出现 source='surprise' 条目(原恒 0)。反向 probe(防刷分):喂一条 self-evaluated 的假落空(origin 非白名单),验证 harvestSurprise 拒绝立目标。再 probe:resolver 一跳判证数从≤3 升到≤8。

### 阶段 2 · 修记忆回流(让真知识存在且可被召回,治 R6/R7/R8 — 没有这步,后面的度量全是度量空气)
三个改造让『真知识进得去、出得来、不重复』:(A)【蒸馏输入换成真页面正文】distillSkill 的 prompt 从喂 `goal.title+step+note80字` 改成喂 observe_page 的 read_body 摘要(NoeWorkspace summarizeActOutput 已摘到1200字,把它透到蒸馏);prompt 加约束『必须含至少一个具体库名/API/配置键,否则输出 SKIP』(治 R7 同质方法论)。防幻构(红队点):蒸馏后对具体名称做 noe_memory FTS5 二次存在性校验,查无则降 confidence 不入库。(B)【research 报告独立入记忆】DeepResearcher 报告写一条 scope=knowledge 记忆带 sourceUrl,放宽 NoeWorkspace.js:493 的400字截断或存指针(治 R8 无持久载体)。(C)【写门加语义去重】NoeMemoryWriteGate.commit 对 skill 类:新卡与近期同类卡 textSimilarity>0.85 则 merge(更新 evidence_refs)而非新增,0.5-0.85 写『增量卡』标注补充了什么,<0.5 全新(治 R6 堆积,实现 ADD/MERGE/PRUNE 语义)。去重保守:仅近期窗口+高阈值+merge 不 delete,保 provenance(防红队点 R5 吞真知识)。一次性 GC 现存 346 死卡按红线7先 dry-run 看命中范围再清。
文件: 改 server.js distillSkill(:1531-1561,换 prompt 输入源+加具体性约束+FTS5 校验);新增 src/memory/NoeSkillDedup.js(<200行,语义去重分流,DI 注入 semanticIndex,门控 NOE_SKILL_DEDUP 默认 OFF);改 DeepResearcher.js(报告独立写记忆,门控 NOE_RESEARCH_TO_MEMORY 默认 OFF);改 NoeMemoryWriteGate.commit(挂 dedup 拦截层)
验收: 隔离端口跑一轮完整 self_learning:新 skill_distill 卡 body 含具体库名/API(grep 验,原全是方法论套话);故意让 Neo 连读两次同页 → 第二次 commit 被 dedup merge 而非新增(DB skill_distill 计数不增,merge_trace 字段有值);后续深思 recall 该 topic 能命中至少 1 张新卡(hit_count 从 0 变正 — 这是 R6 闭环活了的硬证据)。反向 probe:喂措辞各异但本质同质的两段(防 R6 措辞欺骗)→ 用『概念覆盖增量=新实体数』交叉验证,实体数=0 则判同质 merge,不只信 embedding 距离。

### 阶段 3 · 动态选题替换 cursor%6(嫁接 reflection 多样性,治 R1 根)
删 maybeSeedAutonomousLearning 的 learningTopicAtCursor(cursor%6),改为从三个活信号动态取下一个学什么:① surprise 好奇目标(阶段1修活后)的 claim 抽关键词;② owner 近期对话/兴趣(已有 timeline);③ 上一轮 research 报告读到的新概念(novelty 检测:与已学 topic 库语义距离>阈值才算新领域)。NoeLearningTopics.js 的 6 条降级为冷启动种子/兜底,非唯一来源。复用 reflection 路径已证的 LLM 多样化生成能力(40/40)+ selectLearningTopicForText 已有的文本→topic 路由骨架。防发散烧配额(红队点 R2):动态生成的新 topic 必须先过『确定性语义距离硬门』(与已学库距离>阈值)+ 乘 pragmatic 相关性(curiosityDecompose 已算 epistemic×pragmatic,只追与 Neo 短板/owner 兴趣相关的新颖),LLM 只在过硬门后参与;新 topic 受 maxBacklog=8 + 每心跳最多新增 1 个 + topic 池上限(如 20,满则退休饱和最久的)三重约束防 topic 爆炸。
文件: 新建 src/cognition/NoeTopicCurator.js(<300行,DI 注入 semanticIndex/curiosityDecompose,getNextTopic 按『novelty 硬门通过 → pragmatic 加权 → 速率限制』出题,门控 NOE_DYNAMIC_TOPICS 默认 OFF);改 NoeGoalSystem.js:356-357(cursor 逻辑改调 curator,OFF 时逐字回退 cursor%6 保零回归);新建 topic 库小表记『学过什么+饱和度+访问计数』供 novelty/退火判定
验收: 隔离端口跑 2 小时:noe_goals self_learning 的 distinct title 数 / 总数比从 6/131≈4.6% 升到≥60%(逼近 reflection 的 100%);新 topic 至少 1 个来自 surprise claim、1 个来自 research 新概念(meta 标 origin)。反向 probe(防发散):构造一批与 owner 无关的高 novelty 假概念 → 验证 pragmatic 门把它们压到不立项;构造 topic 池打满 20 → 验证速率限制生效不爆炸。

### 阶段 4 · 收敛/进步度量 + 守卫升级(防空耗的度量层与执行层,治 R4/R9)
两条并行:(A)【收敛+进步度量,统一用认知科学的 learning-progress 标量】给每个 topic 算『饱和分』:连续 N 轮蒸馏卡与该 topic 已有卡语义相似度>0.85 → 判学够 → 进冷却退轮转。进步信号统一为『蒸馏质心移动量的变化率』(认知角度 flow 通道 = AI learning-progress 同构):移动量降但>0=正在收敛地学(留)、≈0=饱和(退冷却)、持续高不收敛=噪声(退)。诚实化 KPI(防 Goodhart,红队点 R3):真有用的客观信号用 hit_count『被召回率』而非『蒸馏条数』;冷启动期所有新卡 hit=0 会误判,故用『首次召回窗口』而非即时 hit,且饱和=冷却(可解冻)非永久删除(隔 T 天或出现新相关 surprise 复活)。(B)【延迟 JOL 检验,反 reward-hacking 金标准】蒸馏后立一条 expectation『N 天后我仍能凭记忆复述主题 T 要点』,到期不喂原页面、让 Neo 凭 noe_memory recall 复述 → 能被 recallFused 命中(行为,二值,不可伪造)+ 与原卡 embedding 相似 + 含原页面没有的具体事实 = 真学到,只剩套话/召回不出 = 没学到,surprise 标记回流好奇。(C)【守卫从只观测升可干预】thought_loop 连续 K 拍同主题固着 → 对该 goal_step 候选施 novelty 惩罚(降 salience)让注意力让位,配合 browser tab 每轮 done 关旧 tab。
文件: 新建 src/cognition/NoeLearningProgress.js(<250行,维护每 topic 质心 EMA+二阶差分算 LP,门控 NOE_LEARNING_LP 默认 OFF);延迟 JOL 复用现成 NoeExpectationLedger+NoeCalibrationCurve+MemoryCore.recallFused(零新机制,门控 NOE_LEARNING_JOL 默认 OFF);改 NoeWorkspace.js:473-481 守卫接 score 惩罚(门控 NOE_THOUGHT_LOOP_INTERVENE 默认 OFF);SafeActExecutors 加 close_tab(门控 NOE_AUTO_CLOSE_TAB 默认 OFF)
验收: (A)隔离端口让一个 topic 学到饱和(连喂同质):该 topic saturation_score 达阈后退出轮转,DB 不再为它立新目标。(B)延迟 JOL:立一条复述预测,N 天后(测试可调 due 到分钟级)Neo 凭记忆复述能被 recallFused 命中则 outcome=1、召回不出则 outcome=0 并触发 surprise。反向 probe:让 Neo 复述时只输出方法论套话 → 用 repetitionPenalty/具体事实检查判 outcome=0(防 JOL 自评刷分)。(C)thought_loop 固着时验证该候选 salience 真被降、注意力切走;tab done 后 lsof 确认旧 tab 关闭。

## 核心机制

- 【动态选题机制】三源驱动替代 cursor%6:① surprise 好奇 claim(阶段1修活)② owner 兴趣 timeline ③ research 新概念(语义距离>阈值)。防 reward hacking:新 topic 必过『确定性语义距离硬门』(不让 LLM 自说自话造主题)+乘 pragmatic 相关性(curiosityDecompose 已算,只追与 Neo 短板/owner 相关的新颖,压制纯随机新页)。防 Goodhart/爆炸:每心跳最多新增 1 topic + 池上限 20(满退最饱和)+ maxBacklog=8 三重速率约束。OFF 时逐字回退 cursor%6 零回归。

- 【收敛判定机制】认知科学纠偏=不用『读了几遍』也不用纯 embedding 新颖度(会被换皮绕过),用『检索强度饱和』:topic 掌握 = 该 topic 记忆 hit_count 达阈 ∧ 最近延迟 JOL 通过 ∧ 再读不产新 surprise(三者合取)。掌握→冷却(非永久删,隔 T 天或新 surprise 复活,对应 Go-Explore 状态不遗忘)。防 Goodhart:饱和阈值 0.85 走 A/B;饱和=冷却可逆,避免太紧学不深/太松永不收敛。

- 【进步度量机制】统一标量=蒸馏质心移动量的『变化率』(认知 flow 通道 = AI learning-progress 数学同构,天然过滤 noisy-TV:噪声 LP≈0 不会被选):移动量降但>0=正在学(flow,留)、≈0=已会(boredom,退)、持续高不收敛=噪声(anxiety,退)。诚实 KPI 防 Goodhart:真有用信号用 hit_count『被召回率』而非『蒸馏条数』(当前 346 卡 hit=0 正说明蒸馏条数是假信号);冷启动用『首次召回窗口』而非即时 hit 避免新卡误判。四信号交叉(novelty/概念增量/Brier校准/落地率)单一达标不算学到。

- 【防空耗机制·多层】(1)阶段0止血:关 continuous 链+降频15×+最小去重,先停烧;(2)记忆回流闭环(R6 治理)让 hit_count 从 0 变正 = 学到的卡真被复用,空转无处藏;(3)延迟 JOL 金标准:用『能否被 recallFused 检索命中』(行为,二值,不可伪造)判真学到,而非即时自评(治『开了浏览器=学到了』伪信号);防 JOL 自评刷分:复述用独立语义通道+repetitionPenalty 抓套话+要求含原页面没有的具体事实,绝不让被评文本自评;(4)守卫从只观测升可干预:thought_loop 98% 固着时降该候选 salience 强制注意力让位+每轮关 tab。

- 【全局工程纪律(对接 Neo 现有架构+红队防线)】每个机制独立 .env flag 默认 OFF(NOE_STEP_EXPECTATION_RESOLVE/SKILL_DEDUP/RESEARCH_TO_MEMORY/DYNAMIC_TOPICS/LEARNING_LP/LEARNING_JOL/THOUGHT_LOOP_INTERVENE/AUTO_CLOSE_TAB),便于二分定位回归,不一把全开;隔离端口 PORT=51999 端到端验+留 owner kickstart;OFF 时与现状逐字等价(参照 harvestSurprise/curiosityDecompose 已有零回归写法);碰 src/cognition+self-evolution 属分量动作;346 死卡 GC 按红线7先 dry-run 看命中范围。embedding 是所有度量的命脉,但 MEMORY.md 记载 Ollama 按需唤醒致 qwen3-embedding 间歇失效退回 hash128 维 mismatch→语义召回零命中:落地前必须确认 OLLAMA_KEEP_ALIVE=-1 生效,且 embedding 不可用时给明确保守降级(宁标 unknown 不学,绝不假装算出 0 而误判全饱和停学)。

## 风险防线

- [reward hacking·outcome=0] 若把 act 步失败当预测落空,Neo 可能学会故意做易失败 act 刷 surprise→刷好奇目标。防线:harvestSurprise 入口加 origin 硬白名单,surprise 只采纳 action_failure/owner_prediction/owner_manual 三类真实世界硬来源,自评类一律不喂;surpriseOriginBreakdown 已分桶 owner_/action_failure 非噪声可直接复用。

- [Goodhart·novelty 措辞欺骗] LLM 极易生成措辞各异本质同质的蒸馏骗过 embedding 新颖度(noisy-TV 的 LLM 变体)。防线:novelty 必用独立语义通道判+用『概念覆盖增量(新实体数)』和『Brier 校准改善』这种不易伪造的硬信号交叉验证,绝不让被评文本自评;落地第一风险点,先跑反向 probe(喂同质文本看 gate 是否真挡住)。

- [Goodhart·hit_count 滞后] 用被召回率当真有用 KPI 有冷启动鸡生蛋:新卡 hit=0 会误判没价值。防线:用『首次召回窗口』而非即时 hit;且倒 U 的 masteryEstimate 冷启动给『探索性初始掌握度』让新主题先学一轮再校准(与 ClosedLoopHit 鸡生蛋同源,前几轮强制注入)。

- [发散烧配额] 纯 novelty/count 驱动会漂向新但无关的角落(novelty search 已知代价)。防线:探索值必乘 pragmatic 相关性(curiosityDecompose 的 epistemic×pragmatic,对齐 Neo 短板/owner);设每日 self_learning 目标数/research 调用数封顶防烧辅助模型配额。

- [过早冻结] LP 退火太猛把暂遇平台期但还能学的主题误冻。防线:饱和=冷却非永久删,设解冻周期(隔 T 天或出现新相关 surprise 复活该主题),对应 Go-Explore 状态不遗忘。

- [去重吞真知识] merge 阈值过低把『记忆冲突处理 v2』当 v1 重复 skip。防线:去重保守(仅近期窗口+高阈值 0.85)+merge 而非 delete 保 provenance;346 死卡 GC 按红线7先 dry-run 看命中范围再清。

- [间隔复习收敛到精通昨天] 认知科学间隔重复假设知识不变,但 web 社区经验会过期(新框架/版本)。防线:复习除内生检索,更长间隔做一次外部 re-check 看主题有无新 surprise,有则把主题从 individual 打回 maintained 重学。

- [embedding 降级静默失真] 所有度量依赖 embedding,Ollama 按需唤醒间歇失效退 hash128 维 mismatch→语义召回零命中,可能误判全部已饱和→停学,或 fail-open 退化成永远算不出新颖度。防线:落地前确认 OLLAMA_KEEP_ALIVE=-1;embedding 不可用时明确保守降级(标 unknown 不学,绝不假装算出 0)。

- [一次全开无法归因] 8 个机制相互耦合(mastery 喂倒U、JOL 喂 mastery、LP 喂选题),同时上线判定链极长无法定位哪条起效/引入新问题。防线:严格分阶段、各自 .env 默认 OFF、每阶段独立可证伪;先上阶段0止血+阶段1修好奇供给(治根因)验证有效再叠后续。

- [resolver 判证率低未深挖被坐实] 红队担心『resolver 为何只判 2 条』可能有 bug。已实测排除:不是 bug,是 maxPerTick=3+UNKNOWN 强偏置+证据缺『终态 action-result』导致留账淤积(R5b)。故阶段1必须先补『可程序化判落空的供给』(step 终态旁路),只放宽 resolver 而不补供给则接了 harvestSurprise 仍喂不进料。

## 推荐
先止血再治本,严格按 DB 实证倒逼的 ship 顺序,绝不跳级。【立即止血(阶段0,纯 .env+15 行守卫,5 分钟可回滚)】NOE_AUTONOMOUS_LEARNING_CONTINUOUS=0 + INTERVAL_MS=900000(60s→15min)+ distillSkill commit 前最小去重 —— 这三招不碰任何认知机制,立刻把『131 目标/6 主题/346 死卡』的烧配额打转量级压下来,为治本争取时间。【治本第一刀必须是阶段1(修活好奇回路供给端)】这是 DB 实证的最深根因:source=surprise 恒为 0、outcome=0 恒为 0、resolver 整个生命周期只判过 2 条 —— 好奇这个『本该供给新领域探索信号的器官』完全沉默,比 cursor%6 更根本。补『act/research step 终态→expectation 判落空』的旁路让 outcome=0 真能产生,好奇回路才有米下锅;否则后面动态选题的三源里有一源(surprise claim)永远是空的。【第二刀阶段2(修记忆回流)不可后置】因为阶段3/4 的所有 novelty/LP/JOL 度量都预设『有真知识、会被召回』,而 DB 证明现在是模板进、死卡出、零召回 —— 在 346 张 hit_count=0 的死卡上算新颖度是度量空气。必须先让蒸馏吃真页面正文+写门去重+research 独立入记忆,把 hit_count 从 0 顶到正(这是闭环活了的唯一硬证据),度量才有意义。【阶段3/4 是优化非止血】动态选题(嫁接 reflection 已证的 40/40 多样性)和收敛/进步度量(认知科学的倒U好奇+延迟JOL金标准)在前两阶段验证有效后再叠,每个独立 flag 默认 OFF 分阶段 kickstart。【一条铁律压所有】落地前先确认 OLLAMA_KEEP_ALIVE=-1(embedding 是全部度量命脉,它一挂所有判据静默失真);所有改动隔离端口 PORT=51999 端到端验+至少一个反向 probe(喂同质文本看 gate 挡不挡、喂自评假落空看 harvestSurprise 拒不拒)+留 owner kickstart,绝不标『应该好了』。最后:我拒绝把 ANTHROPIC_API_KEY/GitHub token 写进任何源码 —— 本项目自带 NOE_PHASE2_SECRET_GATE.mjs 密钥门、CLAUDE.md 红线#3 明令『发现 secret 立即停下』、且整套 Neo 已用 .env(在 .gitignore 内)管所有 NOE_* 开关,提交密钥会直接触发项目自己的护栏并使账号面临盗刷,正确做法是 .env + GitHub Actions encrypted secrets(本仓已有 .github/),若曾误提交密钥应即刻轮换并 filter-repo 清史。
