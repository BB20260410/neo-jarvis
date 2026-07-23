# HANDOFF 2026-06-22 — P0 自改 complete 控制链打通 + Neo 真改自己代码第一次

> 接手先读本文件 + `docs/ROADMAP_NEXT_2026-06-22.md`（v3 路线图）。本轮把 self-evolution 的 complete 控制链从「complete=0 从未完成」修到「实现步真改代码成功、安全门正确把关」，并实机点火喂第一个真目标。

## 一句话状态
**Neo 真改了自己代码第一次（实现步成功：写+apply+verify 通过），但完整 cycle 卡在 post_review——因 cloud reviewer 是 Claude Code CLI（agentic 返回 prose 非 JSON 裁决）。安全门正确拒绝盖章（绝不假 complete）。最后一块=post_review 改用本地 clean-JSON reviewer。**

## 已完成（全部已提交 + 全量测试绿）
- **P0.1 complete 控制链六道断点全修**（commit `447d85a`，三轮多模型+子代理审收敛+收口，每 finding 主线 live 亲验；全量 **6207 测绿**）：
  1. post-review reviews 读错层级（`r.reviews` → `r.postReview.reviews`）
  2. memory_writeback/complete 永 dry-run → 四动作 realApply=ON 全真执行 + executor 补 summaryRef artifact
  3. verify 失败结构化错误被 ActPipeline 吞 → 白名单保留 `e.selfEvolution` → trigger 据 needsSelfRepair 路由 self_repair
  4. post-review pack 缺 actionEvidence+reviewRoundRef → validateNoePostReviewPack 跑模型前就 pack_invalid
  5. self_repair gate 要 repairReturnsToConsensus 但无 producer → self_repair_blocked 不可达 → 路由时补设
  6. completion autodrive 读顶层 cycle.patchPlanRef 但 trigger 写 nested cycle.implementation.* → pack 证据空
  + 防假绿（memoryWrite 返 null 抛错 / summaryRef 落盘失败回退 / autodrive post_review 改用与 complete gate 同一份 validateNoePostReview）+ ActPipeline selfEvolution 白名单透传 + 保留 patchPlanRef。
- **P0.3a implementer 验证**：codex 调用 `wss://chatgpt.com` Connection refused(error 61)；**lmstudio 降级真出可用 patch**（qwen3.6-35b, `reasoning_effort='none'`+json_schema → 1.0s 直出 clean JSON；非 none 会全进 reasoning_content→空）。无需改代码。
- **P0.2 owner-seed goal API**（commit `8635532`）：`POST /api/noe/mind/goals` 支持 `source` 白名单（owner/self_evolution）。
- **实机点火**：plist 补 `NOE_SELF_EVOLUTION_COMPLETION_AUTODRIVE=1`（原缺，点火时只在 env 没写 plist）+ `PATH` 含 `~/.npm-global/bin`（reviewer CLI claude/codex 原 spawn ENOENT）；bootout/bootstrap 重启载 P0.1 码（当前 PID 见 `lsof -i:51835`）。
- **Neo 真改代码第一次**：喂 goal `02dd1364`（新建 src/util/NoeEvolutionMilestone.js）→ consensus(autodrive)→implementation(lmstudio 出 patch)→**apply 创建文件+verify(npm test)通过**。文件已落盘（**untracked，是 Neo 的改动，未 commit**）：
  ```js
  // @ts-check
  export function noeFirstEvolutionMilestone() { return "Noe-completed-first-self-evolution-cycle"; }
  ```

## 唯一剩余阻塞（下一步主线）
**post_review 的 cloud reviewer 不可用**：
- claude reviewer = **Claude Code CLI**（`claude --print --permission-mode plan`），返回 **plan 态 prose**（"我先说结论框架…需核对真实文件…"），**不是 runner 要的 JSON 裁决** → `extractNoeConsensusVoteJson` 解析不出 decision → unavailable → quorum 不过 → autodrive 不 approve → cycle 卡 post_review_required（安全门正确拒绝，**非假 complete**）。
- PATH 修复后 claude 能 spawn 且真跑了（PID 子进程实测），但 CLI agentic 本质不产一次性纯 JSON。m3（minimax API，key 在）本轮未出文件，待查。
- **正解（安全关键，审慎落地）**：self-evolution post_review 改用**本地 clean-JSON reviewer**（复用 implementer 已验证的 LmStudioChatAdapter + noeStructuredCall + `reasoning_effort='none'` + json_schema 机制；review-tier `qwen/qwen3.6-27b` 与 implementer 的 35b 不同→保留独立性 + gemma 兜底凑 quorum）。落点：`src/room/NoePostReviewRunner.js` 的 `runBuiltInReviewer` 加本地 reviewer 路径，或 `NoeCompletionPostReview` 注入本地 reviewer 集；需测试 + 四闸门审。
- 备选：换 self-evolution 必需 reviewer 为 m3+xiaomi（API clean JSON，key 在）——但需先验 m3/xiaomi 实际可达可用。

## 剩余 P0（v3 路线图）
- P0.4 反向 probe 8 类（元自改拦截/并发/rollback 真恢复/no_patch diagRef/重启续跑/blockedPath 拒绝可见）
- P0.5 核心禁区显式化（REAL_APPLY/cycle/心跳/persona/ReflectiveTuner 永不自改）+ emergency stop kill switch
- P0.6 owner 实时可观测（mind.html active objective/stage/diff/stuck）+ SLO schema v2（successRate=null 不能给提速放行）

## 低危/延后（已记不阻断）
- self-evolution goal 标题会进本地 0o600 memory/artifact（路径名级非 secret，HANDOFF 提醒别写敏感路径）
- self_repair 失败 throw needsConsensus 当前走 stuck-drop（非"回 consensus 重规划"全闭环）——P3 robustness
- memory_writeback 写成功但 advance 失败的重复写窗口（低危）
- implementer skip-path verify 失败丢 priorApplyReportRef（窄边界）

## 实机环境关键
- 启动：launchd `com.noe.panel`，plist `~/Library/LaunchAgents/com.noe.panel.plist`（已备份 `.bak.*`）；重启用 `launchctl bootout/bootstrap`（kickstart 不读 plist 改动）。
- 重启后必验：`lsof -i:51835` 新 PID + `tail /tmp/noe-panel.launchd.log` 自改状态行（consensus/complete autodrive/real-apply 全 ON）+ err log 无错。
- 自改全 flag ON（plist）：SELF_EVOLUTION/EXECUTORS/REAL_APPLY/COMPLETION_AUTODRIVE/CONSENSUS_AUTODRIVE/AUTOSEED/STANDING_GRANT/HEARTBEAT。
