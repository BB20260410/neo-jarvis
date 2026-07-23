# HANDOFF 2026-06-24 — Neo 可靠性改造：自我进化价值闸 + done outcome 门

> 下窗口/owner 从这里读起。本轮主线给 Neo 装上"把真实价值接进完成判据"的核心两闸 + P1 学习燃料。长期路线全文见 `docs/PLAN_2026-06-24_Neo成为可靠伙伴_诊断与长期路线.md`。
>
> **进度更新（2026-06-24，6 修复全完成 + 六 flag 全 kickstart 生效）**：
> P0 价值闸①引用性 + ②gap阻断 · P0.5 outcome门 · P1（attend 保底配额 + system_repair 冷却）· research 主题多样化（源①冷启动自适应）。
> 生产**六 flag 全生效**（PID 72702 健康）：`NOE_SELFEVO_VALUE_GATE`/`NOE_LEARNING_OUTCOME_GATE`/`NOE_ATTEND_LEARNING_QUOTA`/`NOE_POSTREVIEW_GAP_BLOCK`/`NOE_TOPIC_COLD_START_BOOST`=1，`NOE_SYSTEM_REPAIR_COOLDOWN_MS`=3600000。
> 6 commit（`e730d5c`→`5551b56`，本地未 push）；全量 775/6571 绿；research 链一夜从死到活（KG 0→29、research_report 0→3）。
> **剩余**（建议先观察 1-2 天验证再做）：P0 判据③价值断言、④自造共识降权（**④碰核心禁区，需 owner 拍板**）、P2 降噪。**观察指标见 PLAN §4/§7**。

## 一、缘起
owner 诉求：把 Neo 改造成像 Claude 一样**可靠、能真自我迭代**的伙伴。诊断方法=主线亲核 6 核心文件 + sqlite 实测 + codex 独立审 + 9-agent workflow（4 维深挖 + 对抗 + 综合）。

## 二、核心诊断（一句话）
**Neo 不是"装样子"，是"诚实地完成了被错误定义的成功"**——`done` 永远奖励"流程跑完"，从不奖励"真做成"。
铁证（sqlite 实测）：零引用 116 字节孤儿 `src/util/NoeEvolutionMilestone.js` 走完 self-evolution complete 被记成"首个进化里程碑"；空研究步照样 `done`；surprise 全期仅 4、research_report/KG 沉淀=0。
对抗修正（诚实记录）：research/KG=0 主因是写库功能昨晚才通电的时间假象；surprise 干涸大部分是健康低基率（盲修有 reward-hacking 风险，**不做**）。唯一无人反驳的真病=完成判据无价值闸。且生产 `REAL_APPLY=1+EXECUTORS=1` 已通电，唯一拦着自改的是纯过程闸——**这是安全前提，不只是质量问题**。

## 三、本轮落地（synth rankedFixes 前两名 = 最高杠杆）
- **P0 真实价值闸**：新建 `src/room/NoeSelfEvolutionValueGate.js`（只读·DI·判据①引用性）+ 接 `src/room/NoeSelfEvolutionLoop.js` complete 前第七闸。改动源文件须至少一个被全仓引用，否则 `orphan_no_reference` 不计有效 complete。flag `NOE_SELFEVO_VALUE_GATE` 默认 OFF。
- **P0.5 done outcome 门**：`src/cognition/NoeWorkspace.js` 研究步空产出标 `blocked` 不再刷假 done。flag `NOE_LEARNING_OUTCOME_GATE` 默认 OFF。

## 四、验证证据
- 单测：value-gate 7/7 + loop 13/13 + P0.5 outcome 3/3 + workspace-goals 23/23。
- **真实性反向 probe（生产真实现真 grep，非测试 stub）**：真孤儿 `NoeEvolutionMilestone.js` → `orphan_no_reference` 被挡；真文件 `NoeSelfEvolutionGate.js` → 放行；flag OFF → skipped 零回归。
- 全量 **771 文件 / 6556 测全绿**（基线 6543 + 13 新测）。eslint 0 error。

## 五、下一步
- **owner kickstart**（两 flag 默认 OFF，需在场点火；改 plist 后必 `bootout`+`bootstrap`）：
  `NOE_SELFEVO_VALUE_GATE=1` + `NOE_LEARNING_OUTCOME_GATE=1`。点火后观察：孤儿 cycle 是否被 `value_gate_blocked`、self_learning 空研究是否不再刷 done。
- **后续阶段**（PLAN §4，可交下窗口或 Neo 自驱 /loop）：P0 判据②（evidence_gap 阻断，改 `NoePostReviewGate`）③（价值断言）④（自造共识降权）；P1（research 链通电验证 + system_repair 队列收敛）；P2（刷量降噪）。**E（surprise）明确不做**。

## 六、孤儿文件处置
`src/util/NoeEvolutionMilestone.js`（116 字节、零引用、Neo "首个里程碑"产物，untracked）仍在。它正是价值闸要挡的"假进化"产物。建议 owner `rm` 删除，或留作反面教材；本轮未擅自删（不动别进程产物）。

## 七、边界
两闸均 flag 默认 OFF + 只读叠加，**不碰核心禁区**（REAL_APPLY/授权链/心跳/persona/主 prompt/ReflectiveTuner），零回归。`docs/skill-cards/`、`docs/HANDOFF_2026-06-23` 的小改是别窗工作，本轮未触碰。本地 commit 未 push（owner 惯例）。
