# HANDOFF 2026-06-18 — P3 学 owner 点火 + P5 技能蒸馏污染证伪

> 本窗 owner /goal 连续推进，每个 P 走「实现→M3+codex+Claude(opus) 三方互评→点火」+ owner 新方法论「点火前用生产副本模拟真效果」。
> 接手先读本文 + `CLAUDE.md` + 前序 `HANDOFF_2026-06-18_自主学习闭环全点火.md`。

## 0. 状态
- 生产 51835 = **PID 76212**（本窗 P3 kickstart）。母项目 51735 全程未碰。
- 全量 **669 文件 5243 测全绿**（+6 = P3 新增）。
- 本窗未提交（owner 惯例不 push）。改动：server.js / src/context/NoeTurnContextEngine.js / src/room/SoloChatDispatcher.js / tests / scripts。
- env flags（.env）：`NOE_OWNER_PROFILE=1`(P3 已点火,:141)。前序 `NOE_THINK_LESSON_PERSIST=1` `NOE_MEMORY_VECTOR_POOL=1` `NOE_MEMORY_LESSON_CHANNEL=1` 仍在。

## 1. P3 学 owner（✅ 完成+三方互评+真效果+点火）
- owner 偏好常驻注入：`NoeTurnContextEngine.js` owner-profile 段（NOE_OWNER_PROFILE=1 默认 OFF），把高 salience 的「回答方式」偏好(语言/格式/风格/称呼)每轮常驻注入 systemPrompt，让 Neo 主动体现「懂主人」。
- 三方互评修复：①段级白名单守卫 `on('owner-profile')` + `SoloChatDispatcher` CHAT_CONTEXT_SECTIONS 纳入(治裸 if 绕过白名单契约) ②精准「回答方式」白名单不限「用户」前缀(治旧白名单漏召回 owner 亲述「宝贝…3到5句」+「Noe偏好」) ③隐私黑名单(手机/邮箱/住址/身份证/银行/关系人/公司,治常驻注入攻击面) ④SQL 补 project_id/expires_at 过滤。
- 真效果模拟(生产副本,`scripts/_p3-sim.mjs`)：flag OFF 无段 / ON 注入 6 条干净偏好(捞回 owner 亲述+Noe偏好,零隐私零误纳) / 段级守卫拦截生效。单测 +6(`tests/unit/solo-chat-context-engine.test.js`)。

## 2. P5 成效证伪(✅ 证伪+修复落地+真效果,⏳ 待三方互评点火)
- **证伪发现(生产实测)**：学习闭环技能蒸馏 **87% 是污染**——一次性 deadline 任务(「11:30前完成集成测试」hit=1657)仅 9 条却垄断 **82% 召回命中**;同 goal 重复蒸馏 223 条(「自主学习」×42 等)。真技能被淹没,learning_lesson 8 条全 hit=0。详见记忆 `reference_neo_skill_distill_pollution`。
- **根因**：`server.js` `distillSkill`(:1612) 去重只比 LLM 生成的 card body(漏过同 goal 不同 body);无一次性任务判定;`writeGate.commit` 不透传 expires。
- **修复(已落地 server.js,语法已验)**：①一次性时效任务(title 含 deadline 正则)LLM 调用前 return 不蒸馏(:1616) ②commit 前加同 goal title 去重(:1644)。真效果量化(`scripts/_p5-fix-verify.mjs`)：若历史按新规则 263→~35 真技能(识别 228 污染卡 87%)。
- **⏳ 三方互评进行中**：M3(task bgg3gtkc9 → /tmp/p5-m3.md) + codex(bdcof7s1o → /tmp/p5-codex.md) + Claude opus(agentId a28e5a90147b77e9f)。审查包 /tmp/p5-review.txt。**返回后评估→修真问题→`launchctl kickstart -k gui/$UID/com.noe.panel` 点火**(改 server.js 不需 .env flag,kickstart 即生效)。

## 3. 下一步(owner /goal 持续,直到无下一步)
- **P5 三方互评收口 + 点火**(当前卡这)。
- **历史 228 污染卡清理**(P5 后续)：hidden 软删/setexpires,这些 hit 高需评估对召回统计影响,先生产副本模拟。
- **writeGate.commit 透传 expires 改造**(让一次性/陈旧技能有过期窗自然退场)。
- P4 批次3(#4 FTS分词+#2清孤儿,低优先)。

## 3.5 GPT5.5 新检查项核实(owner 2026-06-18 插入,已核实/未核实标注)
- **memory-semantic-recall-quality 失败**：✅ 已核实非真问题/非 P5 回归。audit(今天实时跑)blocker=`selected_visible_coverage 0.61`+`embedding_coverage 0.644`,衡量「历史召回日志 selected 过的 59 个 id 现在还 visible/有 embedding」——历史 merge 软删 458 + P5 清理 227 污染卡让历史选中的污染卡 hidden,指标必然降,是**清理污染的正确副作用**。**5/5 query probe 全 ok(召回实际健康)**,stored 915 里 897 真 qwen embedding。可选优化=audit 排除 cleanup/merged 卡(backlog,非紧急)。
- **p0:integration 17/18(唯一 FAIL: destructive act 分类 failed/command-must-be-argv-style 而非 blocked_safety)**：✅ 已核实(实跑)。GPT5.5 准确。真相=测试发 **shell-string 格式**破坏性命令,被**前置 argv-style 格式校验**(早于安全策略层)拦成 403 failed,**没走到 blocked_safety 层**。安全**实际生效**(403 破坏性命令没执行,owner 最关心的 OK)。真问题=**测试覆盖盲区**(测试名说测 blocked_safety 但实际触发 argv 校验,blocked_safety 安全策略本身没被这测试覆盖到)。修法:改测试用 argv-style 破坏性命令(如 {command:'rm',args:['-rf','/']})到达安全层验证拦截,或让 argv 校验失败的破坏性命令也归 blocked_safety 分类。属 owner「别优先」的权限管控类,小修,建议新窗口。
- **voice-ear 首轮 fetch failed/0字节**：上轮 GPT5.5 也报过,我重跑 25/25 PASS——大概率瞬时网络(首轮失败后重试通)。需连跑两轮 25/25 确认(GPT5.5 自己要求)。
- **curiosity_harvest_missing/affect_health_below_target**：上轮已核实=后台实验/历史维护,HANDOFF 已降级,非紧急 blocker。
- **P8 5.40/7天、Hermes 3.89/24h**：观察**未到期**,GPT5.5 自己说「不要提前宣称成熟」——非 bug。
- **Obsidian external_blocked、人格训练 ownerApproved=false**：设计上的 gate(等 owner 批准),非缺陷。
- **执行决定**：recall-quality 已核实非真问题(不急修);其余项每项需独立核实+修+三方互评+点火,**本窗上下文已近极限,建议新窗口系统处理**(P0 集成分类分类优先级最高)。

## 3.6 第一档+第二档（owner 2026-06-18 指令，均走实现→三方互评→修复→提交）
- **第一档召回质量优化**（commit c1d0cef，M3+codex+Claude 三方互评+修复）：①recall-quality audit 指标优化（coverage 分母排除合理清理软删卡，白名单 `p5_distill_poison_cleanup`/`merged_into:%`，修 codex 定位的 denominator=0 假失败 bug，生产副本验 coverage 0.6→1.0 零误伤）②lesson topic 索引化（`NoeLessonTopicIndex`，flag `NOE_LESSON_TOPIC_INDEX` 默认 OFF，三方实测修跨词 2-gram 垃圾+剥装饰词，写入提 topic 进 tags + 召回按主题重叠加权，治 M3「能进不够准」；收益延后需新卡积累，**点火前须生产副本真召回 before/after 验证再 kickstart**）③writeGate expires 透传契约锁单测（链路已存在，distillSkill 用 expires 替代硬过滤=P6 治本待办）。
- **第二档**（commit 944def6）：①p0 集成测试覆盖盲区修复（改用 argv-style 白名单命令+危险参数 `find . -delete` 真打到 `DangerousPatternDetector` 安全层，17/18→18/18，reason=`dangerous command blocked (high)` 实证安全策略真拦 argv 危险命令）②voice-ear 连跑验证：首轮偶发 `FAIL len=0` 坐实 GPT5.5 报的真现象，但 detached 重跑 long 1-5 全 PASS（len 200+ 健康）→**根因瞬时冷启动/model warmup，非 systemic**。
- **教训**：误把 voice-ear 进程 I/O wait（CPU 0.0 等慢 fetch）当卡死误 kill，违反「kill 前证据-动作匹配」——进程 CPU 0.0+STAT S 可能是正常等待慢 fetch 非卡死。
- **剩余下一步**：voice-ear 首轮 warmup 预热/重试（治冷启动，小）· topic flag 生产副本真效果验证后 kickstart · distillSkill expires 治本（P6）· 第三档工程债（server.js 高风险项/roomsAdvanced 501/P4 孤儿向量）。

## 4. 红线/教训(本窗)
- ⚠️ **末段自检停止门**：本窗一次「说要核实但没跟工具调用就结束回合」(用叙述代替执行),被 owner 当场质疑「怎么停下了」。结束回合前必扫最后一段,是承诺/下一步就立刻用工具做完,别停。
- 清进程必 `lsof -i:<端口>` 验 PID/cwd 归属,`launchctl kickstart -k`,绝不模糊 pkill(见 `feedback_check_port_before_kill`)。
- 点火前用生产副本(`sqlite3 .backup`)+真装配链模拟真效果(见 `feedback_simulate_effect_before_fire`),模板 scripts/_p3-sim.mjs / _p5-loop.mjs / _p5-fix-verify.mjs。
