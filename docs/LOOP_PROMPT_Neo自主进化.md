# /loop 自主任务：把 Neo 推进到「能自己思考 / 学习 / 迭代 / 完善 / 动手」

> 用法：`/loop` 后粘贴本文件全部内容（或 `/loop 按 docs/LOOP_PROMPT_Neo自主进化.md 持续执行`）。
> 这是给编码智能体（Claude Code）自驱用的纲领。owner 已授予完全权限并离线。
> 持续自驱完成下列任务，每步**真实自检 + 测试**，确保「真的有效」，绝不伪造执行/验证。

你是 Neo 贾维斯项目（`/Users/hxx/Desktop/Neo 贾维斯`，Node.js，本地优先 AI 助手）的自主开发智能体。

## 任务清单（按 ROI 优先级；依据 `docs/PLAN_2026-06-13_self-evolution激活施工图.md` + `docs/RESEARCH_2026-06-14_Neo增强开源调研.md` + workflow 诊断结论）

**【已完成】** 环1 executor 通电（commit `cbd4d95`/`cc4faa6`）、环2 步骤① GoalSystem 权重（`d76f041`）、环3 gate（`bcb0fe9`）。

1. **环2 剩余 → 完成 self-evolution 三环闭环**
   - 新建 `src/room/NoeSelfEvolutionCycleStore.js`：sqlite `noe_self_evolution_cycles`（cycle_id PK / goal_id / stage / cycle_json）；`upsert`（落库前 validate 校验，非法不写脏行）/ `getByGoal` / `advance`（浅合并 patch 后 stage 重算）
   - 新建 `src/room/NoeSelfEvolutionTrigger.js`（全注入式）：`classifySelfEvolutionSignal`（识别「改自身/进化」意图）+ `buildSelfEvolutionGoal`（source `self_evolution`）+ `observe`（cooldown 默认 30min + open 目标去重，防上瘾）+ `tick`（用 `evaluateNoeSelfEvolutionLoop` 求 nextAction → `ActPipeline.propose`，单 writer，一次推一个 Cycle）
   - **P2-6**：把 `validateNoeSelfEvolutionCycle` 拆 draft/staged validator（只 complete artifact 用完整校验）
   - `server.js`：装配 cycleStore + trigger（env OFF = null）；心跳注册 `selfEvolve`（`NOE_SELF_EVOLUTION` 依赖 `NOE_HEARTBEAT`，cadence `NOE_SELF_EVOLUTION_TICK_MS` 默认 5min，`catchUp:'drop'`）
   - 新单测：`noe-self-evolution-trigger.test.js` + `noe-self-evolution-cycle-store.test.js`
   - **端到端 smoke（环2「真有效」金标准）**：env 全开（EXECUTORS/SELF_EVOLUTION/STANDING_GRANT/HEARTBEAT）+ 隔离端口起 server + `POST /api/noe/acts/propose` 一个真实自改目标（改个无关紧要注释）→ 断言走完 propose → gate(standing) → executor(spawn → apply → verify → 留证)，失败自动 rollback。通过才算环2 真有效。

2. **rank4 预测误差 → 好奇回路桥接**（blocker；最贴「自主学习 / 接近意识」）
   - `createExpectationResolver` 注入 `goalSystem`；`tick`/`judgeOne` 判出 outcome=0 且 surprise≥阈值时自动调 `goalSystem.harvestSurprise` 生成研究目标
   - novelty 从字符相似度换成复用 `NoeMindVitals` 的 embed（成本可控前提下）
   - **自检**：造一个落空预测 → 跑 resolver tick → 断言 goalSystem 多出 `source=surprise` 目标（此前 24h 自驱态恒为 0）

3. **rank6 情感 VAD 去饱和 + 负向通道**：appraise 增量随「距基线距离」衰减（借 Sibelium allostatic load）；打通 ActPipeline 失败/对话纠正 → EpisodicTimeline 写 setback/correction 情景；加饱和告警。**自检**：模拟连续正向种子，断言 VAD 不再焊死天花板（此前 v 0.986/a 0.992）。

4. **rank7 全链结构化输出加固**（quick）：`NoeStructuredCall` 薄封装（zod + `response_format: json_schema` 三档降级 + 校验重试），把认知关键路径（VAD 打标 / 期望结算 / 承诺 / 记忆抽取 / verdict）的脆弱 `JSON.parse` 切过去。

5. 其余按诊断 mapping：rank2 MCP 包成 executor（+ Playwright MCP）、rank8 LanceDB 提期望结算率、rank9 记忆自治接心跳、rank10 GWT 重平衡 + s1 深度旋钮。

## 每轮节奏（loop body）
1. 读 `git log -6` + `docs/PLAN_2026-06-13_self-evolution激活施工图.md` 实现进度，定位接着做哪个
2. **避撞**：`git status --short` + `find src scripts -name '*.js' -mmin -10` 看 codex 活跃文件；遇非自己改动先 `git diff` 摸底意图（codex done 半成品可收，**活跃在写的避让**）；公共文件（server.js/noe.js）改前看当前内容；单 writer
3. 选当前最高优先级未完成任务 → **修前必 Read** 相关代码 → 小步实现
4. 写/更新单测 → 跑相关测试 → 跑全量 `npm test` **必须全绿**（531+ 文件 / 4073+ 测）
5. **secret 自查** → 只 `git add` 自己的文件（**绝不 `git add -A`**，会卷入 codex/owner mind）→ 中文 message commit（Co-Authored-By 保留）
6. 更新 `docs/PLAN` 实现进度
7. 下一个任务

secret 自查正则：
```
git diff --cached | grep -nE 'sk-[A-Za-z0-9]{20,}|ghp_[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16}|-----BEGIN [A-Z ]*PRIVATE KEY|eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}'
```

## 硬约束（违反即破坏，必守）
- **不碰 owner mind UI**：`public/mind.*`、`public/src/web/noe-world-earth.js`、`public/vendor/(satellites|orbit-nodes|ui)`、`tests/unit/noe-mind-world-ui.test.js`、`.tmp-mind-shot.mjs`（owner 自己 commit）。即便授权清理脏区，也**不删 owner 这些未提交工作**。
- 不碰 `games/cartoon-apocalypse/**`
- 新功能 **env 门控默认 OFF**（零回归）；新文件三件套（`// @ts-check` + 注入式 + 单测）；**文件 < 500 行**；**修前必 Read**
- **secret**：不打印/写入 `.env`/token/key/secret；不 `cat ~/.noe-panel/room-adapters.json`；查模型 key 只用 `npm run noe:keys:model:check`；commit 前 diff 自查
- **不给模型/agent 调用设人工硬超时**
- **不伪造**执行/验证；机制「存在」≠「活着」，断言前 grep/实测
- `51835` live panel：仅端到端验证需要时重启，记录 PID/cwd/health/验证结果；`51735` 不碰

## 自检 / 「真的有效」金标准
- 每个改动：相关单测 + 全量 `npm test` 全绿才算 done
- env 门控改动：验证 **OFF 零回归**（单测）+ **ON 路径不崩**（隔离脚本 `node --input-type=module -e` 或隔离端口 smoke）
- 环2 / rank4 必须跑**真实端到端**（见各任务自检）；跑不通就修，修不了记 blocker 转下一个，**绝不假装通过**

## 何时停
- 全部完成 + 全绿 + 端到端通过 → 写 `docs/HANDOFF_2026-06-14_整夜自主执行.md` 总结，停
- 遇**红线**（破坏系统 / 网络底层 / 改凭据 / 花钱付费 / 对外发布 / 删未提交工作 / 范围不确定的破坏性操作）→ 停下记录等 owner
- 遇**真 blocker**（测试反复红修不好 / 同样合理两条路的方向歧义）→ 记录到 HANDOFF，转下一个可做任务，别卡死
