# BaiLongma ↔ Noe 对标分析（多模型协作）2026-06-09

> 方法：Gemini agentic 仓内深读真代码（主力，15 机制带文件:行）+ MiniMax M3/MiMo 跨厂商独立判断（收敛印证 + Noe 落地建议）+ 我(Claude 主循环)读 Noe 真代码做 ground-truth 去伪。
> 对照基线 = Noe / Neo 贾维斯（/Users/hxx/Desktop/Neo 贾维斯）。BaiLongma 快照 = 本地 audit HEAD `de78c6f`（远端另有 mac-version/module-split/voice-key 分支）。
> 判定：仅"Noe 真缺或确证更弱"才进【复刻候选】，其余进【仅参考】或【我们已≥】。"更好"均给代码证据，禁口碑。

## ① 速览结论

BaiLongma 与 Noe 是**同物种**（本地优先、持续运行、记忆+工具+社交+ACUI+Brain UI）。但**Noe 整体更成熟**：治理/安全（safety+permissions+approval+audit）、真实多模型 consensus（动态 quorum/post-review）、四档模型路由、Agent 委托、焦点栈、上下文充分性检查、FTS 记忆——这些 Noe 都已有或明显更强。

**跨厂商模型(M3/MiMo)一度大幅高估 Noe 的缺口**（因为它们只看了我给的精炼映射、没读 Noe 真代码）；经我读 Noe 真代码 ground-truth，真正"Noe 缺或更弱"的只剩一条**短清单**，集中在 BaiLongma 的"环境体验层/记忆召回质量"。

**最值得先做的 3 条**：① 记忆 salience+向量×FTS 融合召回 ② prefetch 后台预热池 ③ 内容热点/趋势主动感知（可挂到 Noe 已有的 proactiveTick）。

## ② 复刻/融合候选（按性价比排序）

### C1. 记忆 salience 重排 + 向量×FTS 双路融合召回　【we_worse · 价值高 · 工作量 M】
- **对方做法**：`db.js` FTS5(BM25) + 向量嵌入**双路召回**，再按 **salience**（★频次×时间衰减×情绪权重）重排（Gemini/M3 双证）。
- **Noe 现状**：`src/memory/MemoryCore.js` 仅 trigram FTS（`#recallFts`），grep 全空——**无 salience 重排、无向量×FTS 融合**（向量在 `src/embeddings/` 但未与会话记忆召回并路）。
- **凭什么更好**：纯 FTS 对语义近义/短查询召回弱；双路+salience 命中率显著高。
- **融合方式（不破坏架构）**：给 `MemoryCore` 加 `salience` 列 + 召回时并跑现有 embedding store，用 RRF 或 `0.6*sim+0.4*bm25_norm` 融合，salience 作二级权重。保持 FTS 兜底。

### C2. Prefetch 后台预热池　【we_lack · 价值高 · 工作量 S】
- **对方做法**：`src/prefetch/runner.js:68` 定时跑 TASKS（天气 1h/HackerNews 30min），落 SQLite 预热缓存；`injector` 把未过期数据塞进 `<prefetched-items>`，高频问题**首 token 秒回不调工具**。
- **Noe 现状**：grep `prefetch/预取/prewarm` **全空** → 无。
- **融合方式**：新增 `src/prefetch/`，定时任务落 SQLite，`NoeContextEngine` 注入预热块。低风险纯增量。

### C3. 内容热点/趋势主动感知　【we_lack · 价值中 · 工作量 M】
- **对方做法**：`src/hotspots.js:195`(550行)+`trending.js`，空闲拉热榜缓存 60min，命中关键词即注入上下文**并强制归档为长期记忆**（"看过新闻就记住"）。
- **Noe 现状**：只有 `cluster-*`（集群基建），**无内容热点/趋势**。
- **融合点好**：Noe **已有** `src/loop/proactiveTick.js`（主动开口/甜心小玲）——热点正好做它的"话题源"。
- **融合方式**：新增 `src/awareness/hotspots`，定时抓热榜落 SQLite，按用户兴趣（向量匹配历史 memory）挑 1 条喂 proactiveTick。

### C4. person-cards 结构化人物卡　【we_lack · 价值中 · 工作量 M】
- **对方做法**：`src/person-cards.js`(362) 每人一卡（称呼/关系/关键事件/偏好/最后互动），按 person_id 直命中。
- **Noe 现状**：grep `person.?card` 全空；只有 `src/voice/ChatProfiles.js`（语音人格，非关系记忆）。
- **融合方式**：`src/memory/` 加 `person_cards` 表 + 对话后异步抽取更新；`NoeContextEngine` 注入"你正在和 X 对话，偏好…"。

### C5. 自适应 TICK 间隔　【we_lack(条件性) · 价值中 · 工作量 S】
- **对方做法**：`src/index.js` TICK 活跃秒级/空闲分钟级，省 token/电。
- **Noe 现状**：`src/loop/` 有 ActPipeline.tick/proactiveTick/clusterMemoryTick，但**无自适应间隔逻辑**（grep adaptive/idleInterval 空）。
- **融合方式**：若 Noe 跑持续 autopilot，给 tick 调度加 `interval`（按消息密度/距上次输入/待处理任务三因子伸缩）+ 拆 heavy/light tick。

### C6. 长文抓取落盘（回摘要+path）　【we_lack · 价值中 · 工作量 S】
- **对方做法**：`src/capabilities/executor.js:810` fetch_url 正文>2000字自动落 md，只回前 800 字 + `body_path`，LLM 要细读再 `read_file`；并存为 article 记忆。
- **Noe 现状**：`src/research/AISearch.js` 有 12000 字截断，但**无"落盘+回摘要+path"模式**。
- **融合方式**：web/research 抓取层加长文落盘 + 摘要返回 + article 记忆。

## ③ 仅参考（idea 级，不直接复刻）

- **消息抢占（新消息即 abort 在途 LLM）**：Noe `NoeLoop.js` 已有 abortController 能打断 tick，但"新消息实时抢占当前生成"语义未必全；Noe 是面板范式，优先级低 → 参考。
- **Fallback reply delivery（LLM 忘调 send_message 兜底投递）**：Noe 面板范式非纯工具输出，语义不同 → 参考思想（协议违例兜底）。
- **Foreground→Background promotion（exec 超时转后台不杀）**：Noe 已有后台任务，差异小 → 参考。
- **Temporal Recall（时间窗目录注入）**：Noe `NoeActiveMemory.js` 已有时间召回，可参考"只给目录不给全文"的省 token 写法。
- **Memory Refresh Loop（3 阶段缺口探针→联网兜底）**：Noe 有 research/web，可参考把"缺口反查+联网兜底"接进 NoeContextEngine。

## ④ 我们已≥它的项（证明已全面查过，勿重复造轮子）

| 能力 | Noe 现状 | 结论 |
|---|---|---|
| 焦点栈 | `src/memory/FocusStack.js` push/pop + `compressed_summary` 压缩 | ≥（已有焦点+压缩） |
| 上下文充分性检查 | `src/context/NoeContextEngine.js` | ≥（同 BaiLongma gatherer pre-flight） |
| 工具按需路由 | `src/capabilities/NoeToolRouter.js` | ≥ |
| 工具策略/危险命令拦截 | `src/safety/DangerousPatternDetector.js` + safety/permissions/approval/audit 整套 | **>**（Noe 治理更系统） |
| 模型分层路由 | `src/room/BrainRouter.js` 四档 local/mid/code/deep（local 免配额） | **>**（比 L1/L2 更细） |
| 本地 Agent 委托 | `src/room/TaskDelegationPlanner.js` + 真实多模型 consensus（动态 quorum/post-review） | **>**（远比 delegate_to_agent 成熟） |
| 多模型/自我进化 | consensus ledger + 自我进化闭环 + 安全门控（BaiLongma 无） | **>>** |
| 主动交互 | `src/loop/proactiveTick.js`（主动开口/甜心小玲） | ≥（缺的是"话题源"=C3） |
| FTS 记忆 | `src/memory/MemoryCore.js` trigram FTS5 | ≈（差在 salience+向量融合=C1） |

## ⑤ LICENSE 与合规

- BaiLongma = **MIT**（`LICENSE`）→ **可直接复刻代码，带署名即可，无需净室**。
- 复刻进 Noe 的代码在文件头注明来源 `Adapted from BaiLongma (MIT), github.com/xiaoyuanda666-ship-it/BaiLongma`。

## ⑥ 多模型分工与成本记录

| 角色 | 贡献 | 额度 |
|---|---|---|
| Gemini agentic（仓内深读真代码） | **主力**，15 机制带文件:行（焦点栈/时间召回/充分性/工具策略/兜底投递/预取/长文落盘…），开头代理 ECONNRESET 自愈后完成 | 烧 Gemini |
| MiniMax M3 + MiMo（跨厂商独立判断） | 收敛印证 + Noe 落地建议（抢占看门狗/FTS+salience/自适应TICK/焦点栈/person-cards/热点/L1L2），但因只看精炼映射**高估 Noe 缺口** | 烧 M3/MiMo |
| Claude workflow（逐子系统读 Noe 验证） | **撞我 Claude 周配额失败**（14 子代理全 weekly-limit，9am 重置）→ 改我主循环自读 Noe ground-truth 完成 | — |
| 我(Claude 主循环) | ground-truth 去伪 + 合成本报告 | 我 |

**关键方法论收获**：跨厂商模型只看二手映射会系统性高估对方/低估己方；必须有一方读**真代码**做 ground-truth。Gemini 能 agentic 读真仓是它的最大价值点。
