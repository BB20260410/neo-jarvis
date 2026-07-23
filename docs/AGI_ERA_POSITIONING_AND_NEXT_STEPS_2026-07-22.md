# Neo 贾维斯 · AGI 时代定位与下一步具体动作

> 生成：2026-07-22
> 真源：`/Users/hxx/Desktop/Neo 贾维斯`（`noe@2.1.0`）
> 方法：6 路只读子代理并行深读 + 主线程对照 `ARCHITECTURE.md` / `package.json` / `docs/GROK_PROJECT_UNDERSTANDING_2026-07-18.md` / `NOE_PRODUCT_NEXT_PLAN.md` / 2026-07 HANDOFF / 社区 Agent OS 对照
> 纪律：不改代码、不读 `.env` 明文、不触碰 51735 母项目、不宣称已完工 AGI

---

## 0. 结论先行（给 owner 的一页纸）

### 你该怎么定位桌面 Neo？

**Neo 不是「下一代 frontier 模型」，也不是「又一个聊天客户端」。**
在 AGI 时代，它应占的位置是：

> **单用户、本地优先的个人执行与自改操作系统内核（Personal Agent Runtime / Evidence OS）**
> —— 模型会换、会变强；**不变的是：本机数据主权、可验证行动、审批与回滚、跨模型编排、以及「改了什么 → 怎么验 → 失败怎么退」的证据飞轮。**

| 维度 | 答案 |
|------|------|
| **对标什么** | 不是 GPT/Claude 本体；是 OpenClaw/Hermes 一类 Agent OS **之上的「本机深度层」** |
| **赢在哪里** | 本地记忆主权 + 双生命线（前台对话 / 后台意识泵）+ Act 五门 + 补丁事务自进化 + 语音/感知入环 |
| **不赢在哪里** | 参数规模、公开生态、SaaS 分发、插件市场 |
| **当前阶段** | **质量收敛期**，不是「再堆认知模块期」 |
| **最大杠杆** | ①活着 ②修得对 ③聊得上 ④量得清 —— 尤其飞轮 **有效 complete 率** 与 记忆天天可用 |

### 下一步先做哪 1–3 件事（强制排序）

1. **飞轮有效产出率（质量门）** — 把自进化从「能跑」收到「可归因 complete」
2. **记忆/上下文天天用闭环** — embedding 健康 + WriteGate 全路径 + 真实召回证据
3. **能力盘点收敛** — shadow/假能力下架；公开能力表只列 live 路径

理由见 §6；与 6 月 `NOE_PRODUCT_NEXT_PLAN` 的冲突与取舍见 §5.3。

---

## 1. 当前产品全貌（多视角结构分析）

### 1.1 一句话产品定位

对照 `package.json`：

> **Noe — a local-first multi-AI personal operating system inspired by Jarvis, combining cluster collaboration with persistent memory, voice, tools, and autonomous task loops.**

中文合成（与 `ARCHITECTURE.md` / Grok 2026-07-18 理解一致）：

**Noe（中文名：Neo 贾维斯）= 本地优先的多 AI 个人操作系统**：本机 Node22 + Express/WS 面板（`127.0.0.1:51835`）编排本地三角色脑 + 云脑，能听、说、看、记、行动、多模型协作，并带**证据飞轮式自我完善**（补丁事务 + 验证 + 回滚 + 审计）。

### 1.2 明确不是什么

| 不是 | 为什么 |
|------|--------|
| 纯聊天壳 | 有后台 Heartbeat/GWT、Act 五门、记忆飞轮、自改闭环 |
| 公开 SaaS | 本机绑定、owner-token、默认不外发；商业分发已暂停 |
| 已完工 AGI / 现象意识 | 机制是**功能性自我完善**；内心流不可当体验证明 |
| Skills 市场 / 通用 OS 铺全场景 | marketplace/Tauri/真社交外发已明确暂停 |

### 1.3 真源与禁区（核验）

| 项 | 事实 |
|----|------|
| **唯一代码真源** | `/Users/hxx/Desktop/Neo 贾维斯`（`noe@2.1.0`） |
| **空壳勿用** | `Documents/Neo贾维斯` 等 |
| **母项目** | 端口 **51735** — 默认只观察，勿碰 |
| **live 面板** | 端口 **51835**（本次探活：`/health` → `ok`，uptime 可观） |
| **隔离实测** | 非 51835 端口（如 51998/51999）+ 强制独立 isolation DB |
| **数据根** | `~/.noe-panel/` · 语音 `~/.noe-voice/` |
| **launchd** | 规范 label = `com.noe.panel`（`NoeLaunchdLabel.js`） |

### 1.4 进程拓扑

```
[可选] electron-main.js
        │
ensure-node22.mjs → server.js  (组合根 / DI 中枢)
        │
        ├─ Express HTTP + static(public/)
        ├─ WS: /ws/global | /ws/room | /ws/term | /ws/session
        ├─ 子进程: Claude/Codex/Gemini CLI、MCP stdio
        ├─ 按需: OCR / InsightFace Python
        └─ 伴生(可选): whisper:8123 · kokoro:8124 · cosyvoice:8125
                       LM Studio:1234 · Ollama:11434
```

### 1.5 七层架构 + 五大枢纽

```
① 入口/前端     electron · server.js · public/
② 服务/路由     src/server/routes + services · auth
③ 认知/循环     cognition · loop · context · identity
④ 记忆/知识     memory · knowledge · embeddings · storage
⑤ 模型/感知     room · voice · vision · media · model
⑥ 进化/治理     autopilot · candidates · skills · safety · permissions
⑦ 运维/集成     metrics · mcp · channels · scripts/*
```

**五大枢纽仍成立**（改动半径最大）：

1. `storage/SqliteStore.js` — 事实底座
2. `runtime/NoeContextScrubber` — 脱敏单点
3. `model/NoeLocalModelPolicy.js` — 三角色脑口径
4. `server.js` — 组合根 / DI 中枢
5. `context/NoeTurnContextEngine` — 每轮上下文收口

### 1.6 两条生命线（核心勿混）

#### A. 前台对话（请求驱动）

| 面 | 机制 |
|----|------|
| **Session** | 侧栏长会话 / Claude CLI 流 |
| **Room** | 多 AI 协作：chat / debate / squad / arena / cross_verify |
| **Voice** | `VoiceSession`：STT → 上下文 → Brain → TTS |
| **入站** | Telegram 等常归一 `voiceSession.chatText` |

注：`NOE_CHAT_CONTEXT` 在 `NOE_AUTONOMY_PROFILE=free` 下现默认注入为 `'1'`（以 `server.js` 为准；旧文档写 OFF 已过时）。

#### B. 后台「意识泵」（自驱）

| 机制 | 角色 |
|------|------|
| **NoeHeartbeat** | **主认知泵**（串行 tick + SQLite 游标） |
| **NoeWorkspace.step** | GWT：候选 → 显著度 → 唯一焦点 → research/act/think |
| **InnerMonologue** | 反刍（真正跑模型的主路径之一） |
| **NoeLoop** | ~30s 副循环，**勿当主线** |
| **selfEvolve / expectation / maintenance** | 心跳注册 job |

**勿混**：前台是对话容器；后台是「不被观察也在」的注意力 + 反刍 + 自进化泵。真写本机走 `ActPipeline`，不走聊天回复通道。

### 1.7 主能力边界

| 能力 | 边界 |
|------|------|
| **记忆** | 工作(Focus/Turn) → 情景(Episodic) → 长期(MemoryCore FTS) → 向量；写应过 WriteGate；读经 Retriever RRF |
| **模型** | 本地 Main/Review/Fallback + 前台 BrainRouter 云链；可 xAI 槽位劫持本地 id |
| **工具** | Skills≈prompt；SafeAct/Freedom/MCP 经治理；最大执行面 Freedom 有硬 veto |
| **治理** | Act 五门 + Approval + 急停 + standing grant（只代审批不代 verify） |
| **自进化** | 信号→Goal→implement→dry-run→apply→verify→rollback→lesson；PolicyFileGuard 防元自改 |

### 1.8 诚实缺口（代码 vs 叙事）

1. Session ∥ Room 双轨，新人易混
2. free profile 通电 vs 模块头「默认 OFF」注释常冲突 → **以 server.js 注入为准**
3. `ownerTrust:full` 削弱「先问再做」叙事，靠审计 + 多层闸
4. WriteGate 非全路径强制；飞轮 writeback 等可直写
5. ReflectiveTuner / 百条蒸馏技能仍 shadow 或 `enabled:false`
6. 进程 tick 完成 ≠ 有 grounding 念头或外部 outcome（存在 ≠ 活着）
7. `src/core` 几乎空壳；部分文档日期落后于 7 月 HANDOFF

---

## 2. AGI 时代定位

### 2.1 时代背景（框架视角，非炒作）

2025–2026 开源 Agent OS 主战场已清晰分化（外部调研，有限）：

| 路线 | 代表 | 重心 |
|------|------|------|
| **通用个人 Agent / 网关** | OpenClaw 等 | 多消息渠道、hub-and-spoke、桌面自动化、生态 |
| **自治编码 / 云原生长跑** | Hermes Agent 等 | 编码编排、24/7 云部署、自生成技能 |
| **聊天壳** | 无数 WebUI | 单会话 + 插件列表，无本机执行闭环 |

**AGI 逼近时发生的结构变化：**

1. **模型commodity 化** — 你很难靠「接了哪个最强模型」形成壁垒；模型会月更。
2. **稀缺转移到执行层** — 谁能在**真实环境**里安全地做、验、退、记、对齐单用户。
3. **个人数据主权成为刚需** — 企业 SaaS 与个人本机 OS 分道。
4. **自改与长任务** — 没有证据闭环的「自治」只会 Goodhart 自欺。

### 2.2 Neo 应占的位：一句话 + 三层栈

```
┌─────────────────────────────────────────────┐
│  Frontier 模型层（可替换）                      │
│  xAI / Claude / Codex / MiniMax / 本地 35B…   │
├─────────────────────────────────────────────┤
│  ★ Neo = Personal Agent Runtime（你该守住的）  │
│  记忆 · 上下文 · 双生命线 · Act 治理 · 证据飞轮 │
│  语音/感知入环 · 多模型编排 · 急停/回滚         │
├─────────────────────────────────────────────┤
│  本机 OS / 硬件 / 密钥 / 文件 / 屏幕 / 麦克风    │
└─────────────────────────────────────────────┘
```

**定位口号（对内）：**

> **「模型会换，Neo 是你的本机执行与证据 OS。」**

**定位口号（对外/对自己叙事防漂）：**

> **本地优先的单用户 Jarvis Runtime —— 可验证地帮你做事，并在受控下完善自身，而不是宣称已有意识。**

### 2.3 硬核子系统（AGI 时代应保留）

| # | 子系统 | 为什么是硬核 |
|---|--------|--------------|
| 1 | **组合运行时** `server.js` + SQLite + routes | 真源与装配中枢 |
| 2 | **记忆 + TurnContext** | 单用户长期价值的根基 |
| 3 | **Act 五门 + 急停 + grant** | 可验证执行的最小安全物理 |
| 4 | **证据飞轮** patch→verify→rollback→lesson | 对 frontier 的「身体」；模型只是脑 |
| 5 | **双生命线** Heartbeat/GWT + 前台 Session/Room/Voice | 从「工具」变成「常驻伙伴」的结构差 |
| 6 | **本地多脑策略 + Room 适配** | 模型可替换、本地优先可降级 |
| 7 | **运维底盘** launchd / doctor / 隔离 DB / vitals | 「活着」是一切前提 |

### 2.4 应收敛 / 降权的堆叠

| 堆叠 | 为何降权 |
|------|----------|
| ReflectiveTuner ADOPT、shadow 调参 KPI | 存在≠活着；高风险碰飞轮节律 |
| 百条 `enabled:false` 蒸馏技能 | 假能力盘点 |
| Tool marketplace / 商业分发 / Tauri 重写 | 完备计划已暂停；ROI 负 |
| 真社交外发 / 全渠道运营 | 合规与运维黑洞；只读可，真发必审 |
| 觉醒叙事 KPI 化（always-on 深想当进化压力） | Goodhart + 本地算力硬约束 |
| 再堆新「意识」模块（无 outcome 门） | 已进入质量收敛期 |
| Session/Room 文档双真相 + 历史 Phase 干扰 | 应收敛事实源 |
| BaiLongma 全量 / 日历邮件全 OS 面 | 与单用户深度冲突 |

### 2.5 与 OpenClaw / Hermes 的差异表（有限外部调研）

| 维度 | OpenClaw 类 | Hermes 类 | **Neo（本仓库）** |
|------|-------------|-----------|-------------------|
| 最佳场景 | 通用生产力 / 多渠道 | 编码与长时自治 | **单用户本机深度 + 可证伪自改** |
| 架构 | Gateway hub | 模块/CLI 或云原生 | Express 面板 + 双生命线 + Act/Patch |
| 数据 | 工作区/会话 | 技能与轨迹 | **`~/.noe-panel` 本地主权** |
| 自进化 | 技能/提案 | 持续学习叙事 | **真 patch 事务 + verify + 急停** |
| 语音感知 | 部分有 | 偏弱 | **Voice/Vision 入环（体验层）** |
| 生态 | 强 | 增长极快 | **刻意不做 marketplace** |

**战略含义：** 不要去卷 stars 和插件数；要卷 **「owner 这台机器上，三天后还是否可信、是否记得、是否能安全自修」**。

---

## 3. AGI 时代框架原则（可检查，7 条）

每条绑定仓库机制或明确缺口。

### P1. 本地数据主权

- **含义**：记忆、审计、密钥引用、默认流量不离本机；云脑是可选执行器。
- **已有**：`~/.noe-panel` / `panel.db`；`NoeContextScrubber`；owner-token；面板 `127.0.0.1`。
- **缺口**：前台云优先路由会把上下文送出；xAI 槽位劫持本地 id 后「本地优先」语义变模糊 —— 需**可观测的出境清单**（哪条路径外发了什么）。

### P2. 模型可替换（脑可换，身体不换）

- **含义**：Main/Review/Fallback 与 Room adapter 池可 env 切换；业务不绑死一家 API。
- **已有**：`NoeLocalModelPolicy`、`BrainRouter`/`ForegroundChatRouting`、`room-adapters`、`NOE_USE_XAI_BRAIN`、`NOE_SELFEVO_LOCAL_FIRST`。
- **缺口**：双轨策略分裂；CLI 模型非热插拔；角色契约仍绑适配器实现。

### P3. 可验证执行与原子回滚

- **含义**：真写必须有 dry-run/apply/verify；失败 rollback + 抛错；禁止「假成功」。
- **已有**：`ActPipeline` 五门；`NoePatchApplyExecutor` / `NoePatchTransaction`；`verify:noe:patch-*`；急停 `EMERGENCY_STOP`。
- **缺口**：REAL_APPLY 等 flag 与生产状态需与文档一致；implement 质量上限导致 complete 稀缺。

### P4. 审批 / 治理门与防元自改

- **含义**：grant 只替代审批；不能改「验自己的尺子」；危险路径硬禁。
- **已有**：`PermissionGovernance`；`noe:autonomy:grant|check|revoke`；`NoePolicyFileGuard`（禁改安全栈/心跳/tests/scripts/grant）。
- **缺口**：`ownerTrust:full` 本机偏松；部分 holdout 仍偏字符匹配（RESEARCH 已点名）。

### P5. 证据闭环（存在 ≠ 活着）

- **含义**：每个「能力」必须有 live 证据或可重复 drill；仪表盘可被旁证推翻。
- **已有**：CycleStore、evolution_outcome、`output/noe-*` 证据海、大量 `verify:noe:*`。
- **缺口**：curiosity/KPI 若当进化压力会 Goodhart；需 holdout 旁证（Neo 改不到的尺子）。

### P6. 双生命线分离 + 单焦点注意力

- **含义**：前台对话与后台泵不混账；GWT 单焦点推进目标。
- **已有**：`NoeHeartbeat` + `NoeWorkspace.step`；Session/Room/Voice 前台。
- **缺口**：free 全开 job 膨胀致假活；goal 未达 deepThreshold 不推进；系统 repair 可饿死学习配额。

### P7. 可靠性优先于新意识模块

- **含义**：活着 / 隔离 DB / doctor / 可恢复 是原则级，不是运维附赠。
- **已有**：`com.noe.panel`；`restart-panel`；`NoeDoctor`；`NoeIsolationDbPolicy`；`NoeProcessVitals`。
- **缺口**：「修得对 / 量得清」——飞轮有效 complete 率、escalate 率、双写护栏常态化看板仍弱。

---

## 4. 框架形态建议（如何「做成符合 AGI 时代的模型框架」）

这里的「框架」**不是**再写一个 LLM training framework，而是 **Personal AGI Runtime 的契约层**：

```
┌─────────────── Owner Surface ───────────────┐
│  Voice / Chat / Cognitive UI / Telegram…    │
└───────────────────┬─────────────────────────┘
                    │ Turn / Intent
┌───────────────────▼─────────────────────────┐
│  Context Contract（TurnContext + Budget）    │
│  Memory Contract（WriteGate / Retriever）    │
└───────────────────┬─────────────────────────┘
                    │
        ┌───────────┴───────────┐
        ▼                       ▼
┌───────────────┐       ┌───────────────────┐
│ Foreground    │       │ Background Pump   │
│ Session/Room  │       │ Heartbeat→GWT→…   │
└───────┬───────┘       └─────────┬─────────┘
        │                         │
        └───────────┬─────────────┘
                    ▼
┌─────────────────────────────────────────────┐
│  Action Contract（ActPipeline 五门）           │
│  Evolution Contract（Patch Tx + Verify）     │
│  Policy Contract（Guard / Emergency / Grant）│
└─────────────────────────────────────────────┘
                    │
                    ▼
┌─────────────────────────────────────────────┐
│  Model Ports（LocalPolicy + Room Adapters）  │
│  Tool Ports（MCP / Freedom / SafeAct）       │
└─────────────────────────────────────────────┘
```

**做成「AGI 时代框架」的工程含义（收敛口径）：**

1. **对外暴露稳定 Port**（Model / Memory / Act / Evolution），而不是再堆 30 个 `NoeXxxEngine`。
2. **每个 Port 有 invariant**（写必经 Gate、真写必可 rollback、自主必可急停）。
3. **模型层只实现 Port**，不拥有治理权。
4. **能力表只列 live**；shadow 进附录或 `_archive`。
5. **算力现实**：多数时间低功耗待机 + surprise/owner 在场才升频（对齐 RESEARCH 0.7）。

---

## 5. 与既有路线文档的取舍

### 5.1 对齐

| 文档 | 对齐点 |
|------|--------|
| `docs/NOE_PRODUCT_COMPLETENESS_PLAN_2026-06-06.md` | 可用 > 数量；真验证；暂停 marketplace/Tauri/分发 |
| `docs/GROK_PROJECT_UNDERSTANDING_2026-07-18.md` | 双生命线、五枢纽、诚实缺口 |
| `docs/HANDOFF_2026-07-03_*` | 本地 implement、飞轮质量、lesson 回流 |
| `docs/RESEARCH_AGI…` 0.x 修正 | 存在≠活着；holdout；预测 owner；防 Goodhart |

### 5.2 过期 / 降权

| 文档 | 状态 |
|------|------|
| `NOE_PRODUCT_NEXT_PLAN.md`（2026-06-02） | **方向对**（不堆功能），条目多已过期（CE12/M3 suggest 等）；**不得当本周任务列表** |
| 觉醒七维无限接线 | **降权**；判据未动 = 不新开模块 |
| 「完整 Jarvis 体验」大铺 Voice/Social | Voice 主路径可稳，Social 真外发暂停 |

### 5.3 取舍声明（与 NEXT_PLAN 冲突时）

**取舍理由：** 7 月主线已证明「飞轮能真改代码」；当前瓶颈是 **有效 complete 与日常可信**，不是 6 月 P0 的 M3 suggest endpoint。

**故本报告覆盖 6 月 NEXT_PLAN 的推荐顺序：**
优先飞轮质量 + 记忆活性 + 能力收敛；**不**优先重新做 CE12 文档门 / M3 suggest / marketplace 相关。

---

## 6. 下一步具体动作（可执行，按优先级）

### 立即优先（1–3，本周）

| # | 做什么 | 为什么 | 路径/模块域 | 完成判据 |
|---|--------|--------|-------------|----------|
| **N1** | **飞轮有效产出率质量门** | 自治的北极星是「可归因 complete」，不是 tick 次数 | `src/loop/NoeSelfEvolution*` · `src/room/NoeSelfEvolutionTrigger.js` · `scripts/noe-evolution-review.mjs` · HANDOFF_2026-07-03 | `noe-evolution-review`：`complete` 占比升；同因 `self_repair` 连败 ≤2；尸体 cycle（implementation_ready 长期无 apply）下降；`evolution_outcome.reason` 可解释 |
| **N2** | **记忆天天用闭环** | 没有可靠记忆就没有「个人 OS」 | `NoeMemoryWriteGate` · `NoeMemoryRetriever` · `NoeTurnContextEngine` · embedding provider · doctor | doctor/健康：embed 非长期纯 hash 降级；**一次真实对话**能召回昨日事实（非仅 vitest 绿）；新写路径审计无绕过 Gate |
| **N3** | **能力盘点收敛** | 假能力腐蚀信任与路线 | ReflectiveTuner shadow 保持 · 蒸馏技能白名单或 `_archive` · 公开能力表 | 能力表只列 live；shadow 不计「已完成」；禁用技能不出现在 self-knowledge 为「已启用」 |

### 紧随其后（4–8，两周内）

| # | 做什么 | 为什么 | 路径/模块域 | 完成判据 |
|---|--------|--------|-------------|----------|
| N4 | **运维三件套常态化** | 活着是一切前提 | `scripts/noe-launchd.sh` · `restart-panel.mjs --check-only` · `doctor:noe` · `NoeIsolationDbPolicy` | label=`com.noe.panel`；`--check-only` alignment.ok；隔离口独立 DB；doctor 无 dual-writer error |
| N5 | **repair 第 2 拍 / escalate 空洞保持云端优先** | LOCAL_FIRST 下自修死循环 | `NoeSelfEvolutionCandidateOrder` / Executors | self_repair 固定 escalate 走 cloudFirst；有 escalation 事件与成功率统计 |
| N6 | **出境与模型路由可观测** | P1/P2 缺口 | `ForegroundChatRouting` · `room-adapters` · scrub | 面板或 doctor 可见：本轮是否出站、adapterId、本地/云占比 |
| N7 | **预测 owner 行为作学习主信号**（窄切片） | RESEARCH 0.5：比纯好奇密度更高、更抗 reward-hack | `NoeExpectationLedger` · OwnerBehavior 相关 | 至少 1 类 owner 行为可下注→自动结算→写入 lesson；非再堆新引擎 |
| N8 | **needsConsensus 回流修通**（若仍复现） | 飞轮盲重试 | `NoeSelfEvolutionTrigger` | verify 抛 needsConsensus 不再盲重试，回 consensus 重立项 |

### 明确不做（本阶段）

- 新意识子系统 / 宣称 AGI 完成
- Tool marketplace、公开分发、Tauri 重写
- 真社交外发、批量危险本机操作无审批
- 整仓重写 server.js「为了干净」
- 碰 51735 母项目、破坏 `~/.noe-panel` 生产数据

---

## 7. 推荐执行节奏（owner 可直接照做）

**第 0 天（今天，2 小时内）**

1. `npm run doctor:noe`（或 `node scripts/noe-doctor.mjs --json`）落一条基线
2. `node scripts/restart-panel.mjs --check-only` 确认 `com.noe.panel`
3. 跑/读 `scripts/noe-evolution-review.mjs`（若存在）看 complete / stuck 画像
4. 用认知页或语音**故意说一句昨日事实**，测召回（N2 探针）

**第 1 周**

- 只动 N1 + N2 的测量与最窄修复（fail-fast、Gate 缺口、embed 降级可见）
- 禁止新模块

**第 2 周**

- N3 能力表收敛 + N4 运维演练固化
- 若飞轮 complete 仍低 → N5/N8，不要先加模型

**持续北极星指标（建议写进 observation 面板）**

| 指标 | 好方向 |
|------|--------|
| 面板 uptime / doctor error=0 | 活着 |
| 飞轮 complete / (complete+stuck+rollback) | 修得对 |
| 真实对话召回命中（人工抽检） | 聊得上/记得住 |
| 云 vs 本地 token 与出境次数 | 主权与成本 |
| 同因连败 ≤2 | 不烧空转 |

---

## 8. 分析切面与子代理分工（≥4）

| # | 切面 | 子代理职责 | 主要结论 |
|---|------|------------|----------|
| 1 | **架构与双生命线** | 进程/七层/Session∥Heartbeat | 个人 OS 结构差明确；server.js 巨根是债务 |
| 2 | **认知循环 / GWT** | Heartbeat/Workspace/Goal/Affect | 主泵清晰；堆叠可降权；假活风险在 outcome |
| 3 | **记忆 + 模型路由** | MemoryCore/TurnContext/LocalPolicy/xAI | 主权与可换具备；Gate 绕过与双轨是伤 |
| 4 | **治理 / 自进化 / 工具** | Act 五门/Patch/Policy/MCP | AGI 执行层硬核在此；complete 质量是瓶颈 |
| 5 | **产品定位与债务** | NEXT_PLAN/HANDOFF/RESEARCH | 位子=本机可证伪伙伴；收敛 > 扩面 |
| 6 | **运维与「活着」** | launchd/doctor/隔离 DB | 可靠性已原则化；量得清仍弱 |

### 主要阅读源清单

- `package.json` · `ARCHITECTURE.md` · `AGENTS.md` · `CLAUDE.md`
- `docs/GROK_PROJECT_UNDERSTANDING_2026-07-18.md`
- `NOE_PRODUCT_NEXT_PLAN.md` · `docs/NOE_PRODUCT_COMPLETENESS_PLAN_2026-06-06.md`
- `docs/RESEARCH_AGI自我意识_全球扫描与Neo落地路线_2026-06-14.md`
- `docs/HANDOFF_2026-07-01_*` · `2026-07-02_*` · `2026-07-03_*`
- `server.js`（autonomy profile + 装配）
- `src/loop/NoeHeartbeat.js` · `src/cognition/NoeWorkspace.js` · `src/loop/InnerMonologue.js`
- `src/memory/*` · `src/context/NoeTurnContextEngine.js` · `src/model/NoeLocalModelPolicy.js`
- `src/loop/ActPipeline.js` · `src/security/NoePolicyFileGuard.js` · `src/runtime/mission/NoePatchApplyExecutor.js`
- `src/runtime/NoeLaunchdLabel.js` · `src/runtime/NoeDoctor.js` · `scripts/restart-panel.mjs`

### 外部调研说明

对照 OpenClaw / Hermes 等 2026 Agent OS 公开讨论作差异表（§2.5）。**外部调研有限**，不构成竞品百科；定位以本仓库机制为准。

---

## 9. 给 owner 的最终答案（可直接执行）

### 定位怎么说？

**「Neo 是我桌面上的个人 AGI Runtime：模型随便换，记忆、执行、治理、自改证据链在本机。」**

### 做成框架的意思？

**把现有七层收成四条契约 Port（Context/Memory、Foreground/Background、Act、Evolution），用七条原则做 invariant，禁止再堆没有 outcome 门的模块。**

### 下一步先做什么？

1. **N1 飞轮有效 complete 率**
2. **N2 记忆真实召回与 WriteGate**
3. **N3 假能力下架**

然后再做运维常态化与路由可观测。
**不要**开新意识项目、**不要**做 marketplace、**不要**碰 51735。

---

## 附录 A · 探活快照（2026-07-22）

- `GET http://127.0.0.1:51835/health` → `{"ok":true,"service":"noe-panel","port":51835,...}`
- 说明 live 面板当前在跑；不等于飞轮/记忆活性已验证。

## 附录 B · 版本

- 报告文件：`docs/AGI_ERA_POSITIONING_AND_NEXT_STEPS_2026-07-22.md`
- 依赖前作：`docs/GROK_PROJECT_UNDERSTANDING_2026-07-18.md`
- 分析类型：只读战略交付；**无代码变更**
