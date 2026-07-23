# HANDOFF 2026-06-18 — P1 最小学习环点火：深思 lesson 落库闭合

> 接续 `HANDOFF_2026-06-18_Neo重置_反思与新P0-P5.md`（战略重置：只闭环、不建新机制）。本窗交付新 P0-P5 的 **P1 核心**：把「学→召回→用上」闭环在 think 主路真正闭合，并经三方多模型互评 + 点火生产。

## 0. 一句话状态
- git：noe-main 本窗改动**未提交**（owner 惯例不 push）。改动 = 新增 `src/cognition/NoeThinkLessonPersist.js` + 单测 + `server.js`(装配/bumpHits/可观测) + `src/cognition/NoeLearningReport.js`(照妖镜纳入 learning_lesson)。
- 全量 **666 文件 5219 测全绿**。生产 51835 = **PID 87798**（已 kickstart 点火加载 flag=1 + 最新代码）。
- ⭐ 验收：`npm run noe:learning:report` 看 `learning_lesson` 卡是否开始产出 + 命中（需真实学习流量，数小时级才出现）。

## 1. ⭐ P1 真正的断点（三方互评 + 子代理深挖坐实）
HANDOFF 重置文档原以为断点是「runLearnOnce 漏 steps 立空壳 goal」。子代理深挖**修正**了：空壳 goal 会被 `nextStep→bootstrapEmptyGoalPlan` 自举补 steps，非永久死壳。

**真断点 = 断点2**：think 末步深思（`NOE_THINK_DELIBERATE`）产出的认知修正 `improvement` **只写进 goal step note、从不进 noe_memory**（终点 `NoeWorkspace.js:437 recordStepResult(note)`，无 writeGate.commit）。对话召回器按 scope 查库永远看不到 → 闭环断在「产 lesson→写记忆」。`surprise_lesson` 全库 0 张（它对 self_learning 是死的，闸 `goal.source==='surprise'`）；`skill_distill`(710张) 是 goal done 时蒸馏的旁路、泛化压缩、20% 命中。

## 2. 修复（断点2）
**新文件 `src/cognition/NoeThinkLessonPersist.js`**（DI/@ts-check/可单测）：把非 SKIP 的深思认知修正落库成 `learning_lesson`（kind=insight/scope=insight → 进 insight 召回通道），去重仿 distillSkill（exact-body + 0.9 近重），evidence 给 episode+ref 过 gate。
- `server.js:1591` noeDeliberateThink 产出后调 `persist`（flag 门控）+ 记录失败 reason（可观测）。
- `server.js:1580` 深思前喂证据召回纳入 `learning_lesson`。
- `NoeLearningReport.js:9` 照妖镜 `LEARNING_CARD_TYPES` 加 `learning_lesson`。

## 3. ⭐ 三方多模型互评（owner 指定方法，真有实效）
方法：`aiteam.mjs --vendor m3`(M3 禁thinking当reviewer) + `codex exec`(GPT5.5，prompt 走 stdin) + Claude 子代理(code-reviewer)，统一 5 问审查。
- **M3**：大胆找问题，但最高危 S1「writeGate 装配 null→功能没生效」是**误判**（891<1560 已就绪）；S3/B5 也误判。
- **Claude 子代理**：逐行核验 gate 源码，**证伪 M3 三个误判** + 确认装配/gate/闭环正确 + 界定正确验收边界=「可召回+hit真增长」(非「改行为」，后者属 P5)。
- **codex**：独抓 1 个真 bug——`timeline.record(type:'insight')` 退化成 interaction（白名单无 insight）。
- **收敛**：1 SERIOUS + 3 MINOR，全部修复 + 补测试：
  - SERIOUS：深思前召回 `bumpHits:true`(server.js:1575-76)→回声垄断 → 改 **`bumpHits:false`**（与主对话召回器一致；真使用 hit 由对话主链 USAGE_BUMP 计）。
  - MINOR：persist 失败 reason 静默 → server.js 记录；裸 SKIP 走 too_short → SKIP 判定提前+容忍 markdown 包裹；timeline type insight→**milestone**。

## 4. 验证证据链
- 单测 `tests/unit/noe-think-lesson-persist.test.js` **14 测**（mock 全分支 + 真 SqliteStore 端到端：learning_lesson 真过 gate 落库 + MemoryCore 真按主题召回 + 去重生效）。
- 受影响子集 + 全量 **5219 测全绿**；lint 0 error。
- 隔离端口（PANEL_DB_PATH=/tmp 隔离库 + PORT=51999）实跑：装配致命错误 **0**，无 createThinkLessonPersist 错误。
- 点火：`.env NOE_THINK_LESSON_PERSIST=1`(已备份) + `launchctl kickstart -k gui/$UID/com.noe.panel` → 新生产 87798 健康、母项目 51735 未受影响。

## 5. env 开关 + 红线
- 本窗点火：`NOE_THINK_LESSON_PERSIST=1`(.env:132)。依赖前置 `NOE_THINK_DELIBERATE=1`(已开)。
- ⚠️ **教训（本窗失误）**：误用 `pkill -f "node server.js"`（范围不确定）误杀了生产 51835 + 母项目 51735，均被 launchd/自愈拉起无损失，但违反红线。**清进程必精准 PID + 先 lsof 验端口归属；node server.js 同名进程含生产+母项目，绝不范围模糊 pkill。**

## 6. 验收口径 + 下一步
- **P1 验收（可机械）**：照妖镜出现 `learning_lesson` 卡 + hit_count>0（需真实学习流量产出，owner 数小时-数天观察）。「改行为」靠人工确认（HANDOFF 原话）+ 属 P5。
- **已知限制（三方共识，非阻断）**：防套话灌水根因未解（与 skill_distill 同弱点，靠 flag+人工 archive 兜底）；闭环强依赖「深思脑真被调用」+「Ollama embedding 在线」(OLLAMA_KEEP_ALIVE=-1 已设)。
- **下一步**：P1 跑出数据后看照妖镜成效；可推进 P2(学习对话可见)/P3(学 owner)/P4(召回地基)。每个 P 完成续做三方互评。
