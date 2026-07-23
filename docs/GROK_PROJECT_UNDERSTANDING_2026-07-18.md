# Neo 贾维斯 / Noe — 项目全貌认知（Grok 多代理深读合成）

> 生成：2026-07-18
> 真源：`/Users/hxx/Desktop/Neo 贾维斯`
> 方法：6 路只读子代理并行深读 + 主线程对照 `ARCHITECTURE.md` / `AGENTS.md` / `CLAUDE.md` / 架构地图 / 最新 HANDOFF
> 不读 `.env` / secret 原值

---

## 0. 一句话

**Noe（中文名：Neo 贾维斯）= 本地优先的多 AI 个人操作系统**：本机 Node22 + Express/WS 面板（`127.0.0.1:51835`）编排本地三角色脑 + Claude/Codex/Gemini/MiniMax 等，能听、说、看、记、行动、多模型协作，并带**证据飞轮式自我进化**（补丁事务 + 验证 + 回滚 + 审计）。

明确不是：纯聊天壳、公开 SaaS、已完工 AGI。产品目标是「可验证的功能性自我完善 + 真实执行」，不是宣称现象意识。

---

## 1. 仓库与禁区

| 项 | 事实 |
|---|---|
| **唯一 live 真源** | `/Users/hxx/Desktop/Neo 贾维斯` |
| **假/空壳** | `Documents/Neo贾维斯`（几乎空）、`Documents/Neo 贾维斯__错误空壳_勿用_*` |
| **母项目** | 端口 **51735** — 默认只观察，不触碰 |
| **live 面板** | 端口 **51835** |
| **隔离实测** | `PORT=51999 npm start`（不要用 `start:noe`，脚本内写死 51835） |
| **数据根** | `~/.noe-panel/`（`panel.db`、token、rooms、MCP…） |
| **语音模型根** | `~/.noe-voice/` |
| **Remote** | `origin` → `noe.git`；另有 `neoai` / `xikelab-archive` |

---

## 2. 技术栈与进程拓扑

```
[可选] electron-main.js  监督 spawn
           │
npm start → ensure-node22.mjs → server.js  (组合根, ~3800 行)
           │
           ├─ Express HTTP + static(public/)
           ├─ WS: /ws/global | /ws/room | /ws/term | /ws/session
           ├─ 子进程: Claude/Codex/Gemini CLI、MCP stdio
           ├─ 按需: OCR/InsightFace Python
           └─ 伴生(可选): whisper:8123 · kokoro:8124 · cosyvoice:8125 · qwen-tts:8126
                      LM Studio:1234 · Ollama:11434
```

- **运行时**：Node ESM、`engines >=22`、锁 `.nvmrc=22.22.2`
- **DB**：`better-sqlite3` 单库 `panel.db`（WAL + migrations + 日快照）
- **前端**：零构建；`app.js` IIFE 壳 + `main.js` ESM 桥 + `public/src/web/*` 分域
- **启动禁止**直接 `node server.js`（绕过 Node22 守卫会炸 native ABI）

---

## 3. 七层架构（脑中重建用）

```
① 入口/前端     electron · server.js · public/
② 服务/路由     src/server/routes(~82) + services · auth
③ 认知/循环     cognition(~77) · loop(~32) · context · identity
④ 记忆/知识     memory(~59) · knowledge · embeddings · storage
⑤ 模型/感知     room(~82) · voice · vision · media · model · capabilities
⑥ 进化/治理     autopilot · candidates · skills · safety · security · permissions · eval
⑦ 运维/集成     metrics · budget · mcp · channels · webhook · watcher · scripts/*
```

### 五大枢纽（改动半径最大）

1. `storage/SqliteStore.js` — 事实底座
2. `runtime/NoeContextScrubber` — 脱敏单点
3. `model/NoeLocalModelPolicy.js` — 三角色脑口径
4. `server.js` — 组合根 / DI 中枢
5. `context/NoeTurnContextEngine` — 每轮上下文收口

---

## 4. 两条生命线（不要混）

### A. 前台对话

| 面 | 机制 |
|---|---|
| **Session** | 侧栏长会话 / Claude CLI 流（`sessions` Map） |
| **Room** | 多 AI 协作容器：chat / debate / squad / arena / cross_verify |
| **Voice** | `VoiceSession`：STT → 上下文 → Brain → TTS |
| **Telegram 等** | 入站归一后常走 `voiceSession.chatText` |

文字 1v1 默认**不**强吃 GWT；要 `NOE_CHAT_CONTEXT=1` 才注入记忆/inner-state。语音路径默认接 `NoeTurnContextEngine`。

### B. 后台「意识泵」

| 机制 | 角色 |
|---|---|
| **NoeHeartbeat** | **主认知泵**（串行 tick + 持久游标） |
| **NoeWorkspace.step** | GWT：候选 → 显著度 → 唯一焦点 → research/act/think |
| **InnerMonologue** | 反刍（真正跑模型） |
| **NoeLoop** | 较旧的 30s 级副循环，别当主线 |
| **noe-maintenance** | 梦境/GC 等独立 timer（`NOE_DREAM` 默认 OFF） |

`NOE_AUTONOMY_PROFILE` 默认 **free**：未显式设置的认知开关会注入为 `'1'`（与「新功能默认 OFF」纪律并存——分量/自改/梦境仍多门控）。

---

## 5. 本地三角色脑

`src/model/NoeLocalModelPolicy.js`：

| 角色 | 模型 | 用途 |
|---|---|---|
| **Main** | `qwen/qwen3.6-35b-a3b` | 默认对话/反刍/规划/自主步 |
| **Review** | `qwen/qwen3.6-27b` | 高风险 / 自改 / 删除 / 发布 / 记忆冲突 |
| **Fallback** | `gemma-4-26b-a4b-it-qat-mlx` | Main 不可用 + 低风险 degraded |

高风险 kind / 关键词 → `requiresReview` → Review preflight JSON（approve|block|revise）。
自主运行**不**用人工总步数硬停；单次 `max_tokens` 仍要设，且识别 `finish_reason=length`。

房间前台路由另有 `BrainRouter` / `ForegroundChatRouting`（云优先链 minimax→codex→claude… + 本地兜底）。

---

## 6. 记忆与上下文

```
工作上下文(TurnContext + Focus)
  → 情景 EpisodicTimeline (events/noe_episode)
  → 长期 MemoryCore (noe_memory + FTS5)
  → 向量 embeddings (kind=noe_memory, 默认 Ollama qwen3-embedding:0.6b)
  → 可选 KG / KnowledgeStore / Evidence / Wiki
```

- **写**：优先 `NoeMemoryWriteGate` → `MemoryCore.write`（去重/冲突/软删 hide）
- **读**：`NoeMemoryRetriever` 四通道（+ lesson）→ FTS ‖ 向量 RRF → `<noe-memory-v2>` 注入
- **活引擎**：`NoeTurnContextEngine`（旧 `NoeContextEngine` 已废）
- **风险**：hash 128 维 vs ollama 768+ 孤儿向量；部分写路径可绕过 Gate

---

## 7. Agent / 工具 / 权限

多层叠合，**不是**单一 Agent 框架：

| 层 | 是什么 |
|---|---|
| Agent profile | `AgentSkillRegistry` 画像（xike-chief/builder/…） |
| Agent Run | `AgentRunStore` 账本（queued→running→succeeded…） |
| RoomAdapter | 真实 CLI/API 执行端 |
| ActPipeline | 本机行动五门：budget→permission→selfEvo→context→realExecute |
| Skills | 主要是 **prompt 注入**（`SkillStore` + `skillInjector`） |
| Tools | ToolRegistry / Freedom / SafeAct / MCP / Plugin |
| CrossVerify | **11 阶段**工程闭环 + 全员 agree |

权限：`PermissionGovernance`（allow|ask|deny）；默认 `ownerTrust:full` 偏开发者本机。
MCP 可信 server 可免审批；配置命令黑名单。
Freedom 最大执行面，硬 veto：删系统根 / 吐 secret 明文等。

---

## 8. 自我进化飞轮

```
信号 → Goal(self_evolution) → 心跳 selfEvolve
  → Trigger → ActPipeline + ActGuard
  → Executors: dry-run → apply(backup) → runtimeVerify
  → fail → 原子 rollback + throw
  → post_review → retrospective → memory_writeback
  → complete (Value/Substance/Logic 门)
```

- **standing grant**：`npm run noe:autonomy:grant|check|revoke` → `~/.noe-panel/autonomy-grant.json`
  只替代 owner approval，**不**替代 ledger / rollback / verify
- **急停**：`~/.noe-panel/EMERGENCY_STOP` 或 `NOE_EMERGENCY_STOP=1`
- **PolicyFileGuard**：禁元自改（安全栈、心跳、Gate、grant 脚本…）
- **默认**：自进化 executors / 真 apply 受多 flag；候选补丁闸极窄白名单
- **2026-07 状态**：本地真产 patch、飞轮 stuck 根因已修、xAI 槽位可选（`NOE_USE_XAI_BRAIN`）

Autopilot 目录 = **房间规则调度**，≠ 代码自改飞轮。

---

## 9. 前端与通道

- 主面板 `index.html`；认知 `cognitive.html`；心智 `mind.html`
- 鉴权：`?t=owner-token` + `X-Panel-Owner-Token`
- 语音 UI：前端 RMS VAD 段式 POST（非真双向 WebRTC）
- 入站：Telegram / 微信企微飞书归一；出站 Webhook
- Electron：可打包 `.app`，日常 live 仍是浏览器 + `npm start`

---

## 10. 质量门与验证

- pre-commit：staged lint；pre-push：全量 vitest
- 常用：`npm test` · `npm run test:e2e` · `verify:noe:full-current` · `noe:keys:model:check`
- 证据海：`output/noe-*`（self-evolution / patch-transactions / multimodel / 100-readiness…）
- 纪律：不伪造执行；secret 不入日志/git；机制「存在≠活着」需实测

---

## 11. 接手读序（压缩版）

1. `CLAUDE.md` + `AGENTS.md`（硬边界）
2. `ARCHITECTURE.md` + `docs/ARCHITECTURE_MAP_2026-06-20_全代码深读.md`
3. 最新 HANDOFF：`docs/HANDOFF_2026-07-03_*.md`（飞轮 / 真进化 / P0-P10）
4. 代码：`server.js` 装配 → `NoeHeartbeat` → `NoeWorkspace` → `NoeTurnContextEngine` → `ActPipeline` → `NoeLocalModelPolicy`
5. 自改链：`NoeSelfEvolution*` + `NoePatchApplyExecutor`

---

## 12. 诚实缺口（代码 vs 叙事）

1. Session 与 Room 双轨，新人易混
2. free profile 通电 vs 模块头「默认 OFF」注释常冲突 → **以 server.js 注入为准**
3. `ownerTrust:full` 削弱「先问再做」叙事，靠审计 + 多层闸
4. 自改 implement 质量上限 + 共识回流路由曾不全
5. ReflectiveTuner / 部分蒸馏技能仍 shadow 或 disabled
6. 文档 README 部分日期口径落后于 7 月 HANDOFF
7. `src/core` 几乎空壳，不是运行时核心

---

## 13. 子代理覆盖

| 域 | 结论摘要 |
|---|---|
| 入口/server | ensure-node22→server.js 组合根；routes 薄壳+DI |
| 认知/loop | Heartbeat+GWT+Affect+Expectation 主意识；NoeLoop 副线 |
| 记忆 | MemoryCore FTS+向量；WriteGate；TurnContext 注入 |
| Agent/工具 | 多层 Agent 语义；五门 Act；MCP/Skill 注入；Patch 闸 |
| 房间/语音/前端 | Session∥Room；VoiceSession；app.js+main.js；Electron 壳 |
| 自进化/安全 | 证据飞轮；standing grant；急停；eval+output 海量 |

更细的路径级地图见 `docs/ARCHITECTURE_MAP_2026-06-20_全代码深读.md` 与各 HANDOFF。
