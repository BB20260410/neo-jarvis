# Noe × BaiLongma 融合 · 阶段 1「用户想法」交付物

> 工程闭环阶段：**1. 用户想法**
> 目标：把用户原始想法转成明确项目目标、边界、约束、不可做事项。
> 完成门槛：任何成员都能复述同一个目标，且没有明显范围漂移。
> 日期：2026-06-01 ｜ 产出人：🟣 Claude（xike-builder）

---

## 唯一权威源 & 一键校验（防"报告≠实际")

- **机器可读权威源**：`NOE_GOAL_CONTRACT.json`（本文件是它的人类可读视图，实质一致）。任何成员/下游自动化以该 JSON 为准复述目标。
- **校验命令**：`node scripts/verify-goal-contract.mjs` —— 把契约里每条事实拿到真实磁盘只读复核（不启动服务、不碰原项目）。
- **本轮实测**：`10 PASS / 0 FAIL`（退出码 0）。端口运行态旁证：51835 空闲、51735 被原项目占用，隔离成立。
- **文档收敛**：`NOE_USER_IDEA_ALIGNMENT.md` 方向一致，但其"本阶段没有 clone BaiLongma"一句已被实况推翻（`/Users/hxx/Desktop/BaiLongma-audit` 已存在），冲突以契约/本文件为准。

---

## 0. 一句话目标（所有成员复述基准）

> **把 Noe 做成"本地优先的个人 AI 操作系统"——保留 Noe 现有工程底座（Electron 壳 / 本地 API / owner-token / 多模型 / 集群协同），逐步吸收 BaiLongma 的「持续意识循环 + 记忆 + Brain UI + 语音 + 社交 + 工具生态」思路，融合出一个更接近 Jarvis 的产品；融合靠"消化吸收"，不靠"整包复制"。**

任何成员判断一个决定对不对，只需回答：**这一步是在加强 Noe 底座 + 吸收 BaiLongma 的某个能力点吗？** 是 → 在范围内；否 → 范围漂移。

---

## 1. 目标说明（What & Why）

### 1.1 背景事实（已实测核对，非转述）

| 项 | 事实 | 核对方式 |
|---|---|---|
| Noe 目录 | `/Users/hxx/Desktop/Neo 贾维斯` | `pwd` |
| Noe 包名/版本 | `noe` / `2.1.0` | `package.json` |
| Noe 端口 | **51835**（127.0.0.1，`node server.js`） | `server.js:255/4632/4642` |
| 原稳定项目 | `/Users/hxx/Desktop/00_项目/05_Claude可视化面板`（独立存在，端口 51735） | `ls` 确认存在 |
| BaiLongma 审计副本 | `/Users/hxx/Desktop/BaiLongma-audit`（**已 clone**） | `ls` 确认存在 |
| BaiLongma 许可 | **MIT**（Copyright 2026 xiaoyuanda666-ship-it） | `head LICENSE` |
| BaiLongma 形态 | `bailongma` / `2.1.179` / `type:module` / `electron/main.cjs` | `package.json` |
| BaiLongma 模块 | `src/` 下确有 `memory context social capabilities llm providers embedding agents` 等 | `ls src` |

> 结论支撑：交接文档《HANDOFF_2026-06-01_Noe_融合可行性结论.md》的核心判断（可行、互补、不要硬拼）与磁盘实况一致。

### 1.2 产品定位

- **Noe = 工程执行底座**（强在：Electron 桌面壳、本地 API、owner-token 安全、Claude/GPT/Gemini 多模型适配、集群协同、项目房间、任务执行、交付报告、lint/unit/e2e/package 验证体系）。
- **BaiLongma = Jarvis 感体验来源**（强在：TICK 持续运行、外部消息优先、空闲自主思考、SQLite 记忆、L1/L2 双层思考、焦点栈 Focus Stack、Brain UI、语音、社交分发、工具市场）。
- **融合公式**：`Noe(底座) + BaiLongma(意识/记忆/UI 思路) = 本地优先个人 AI OS`。

### 1.3 融合方式（关键原则）

**消化吸收，不整包复制。** BaiLongma 是 MIT，法律上允许复制代码，但产品上禁止整包塞进 Noe——只把单个能力点抽象成 Noe 风格的模块（ES module 后端 + `src/server/routes/*` 路由约定 + 前端 toast/modal 规范），逐 sprint 接入。

---

## 2. 范围边界（Scope）

### 2.1 范围内（In Scope，本融合要做的）

1. **只读审计 BaiLongma** → 产出 `NOE_BAILONGMA_ARCH_AUDIT.md`（架构/数据/许可/可移植点）。
2. **验证 Noe 自身可独立启动**：51835 起服务，且**不影响原项目 51735**。
3. **NoeLoop 最小闭环**：吸收 TICK loop 思路，做一个最小的"持续意识"心跳。
4. **Memory Core**：吸收 SQLite 记忆 + 双层思考思路，做 Noe 的记忆核心。
5. **Brain UI Lite**：吸收 Brain UI，做一个轻量可视化。
6. **后续体验层**：语音、社交 I/O、Jarvis 化交互（排在记忆/UI 之后）。

### 2.2 范围外（Out of Scope，本阶段明确不碰）

- 不在「用户想法」阶段写任何功能代码（本阶段只产出目标/边界文档）。
- 不做 BaiLongma 的全量移植；不做 Noe → BaiLongma 的反向改造。
- 不让 Noe 和 BaiLongma 两个服务长期并行常驻。
- 不接入"工具执行能力（capabilities/marketplace）"——**直到审计完成并评估安全**。
- 不动原稳定项目目录（`05_Claude可视化面板`）的任何文件。

### 2.3 不可做事项（红线，碰到先停下问用户）

| # | 红线 | 理由 |
|---|---|---|
| R1 | 在原项目目录 `05_Claude可视化面板` 开发/改文件 | 用户明令"只在 Noe 工作" |
| R2 | 未审计就接入 BaiLongma 工具执行 / marketplace | 工具执行=可对本机做副作用，安全未评估 |
| R3 | 把 BaiLongma 整包复制进 Noe | 产品会被拖成"两个项目硬拼" |
| R4 | 占用/冲突原项目端口 51735 | 会影响用户在用的稳定服务 |
| R5 | 自主重启 panel / git commit / git push / npm install 新依赖 | Noe CLAUDE.md 工程硬规则 |
| R6 | 引入 BaiLongma 代码却删除其 MIT 版权声明 | 许可合规（MIT 要求保留 copyright） |
| R7 | launchctl/cron/systemd 系统级调度、spawn 子 LLM 烧配额 | 全局 CLAUDE.md 红线 |

---

## 3. 成功标准（可验证的完成定义）

### 3.1 本阶段（用户想法）成功标准

- ✅ 存在一份目标文档（本文件），含：目标说明 / 范围边界 / 成功标准 / 风险假设。
- ✅ 一句话目标可被任意成员一字不差复述，且能据此判定"是否范围漂移"。
- ✅ 红线清单覆盖"原项目隔离 + 端口隔离 + 许可合规 + 工具执行需先审计"四大风险。

### 3.2 整体融合的里程碑成功标准（供后续阶段对齐）

| 里程碑 | 可验证标准 |
|---|---|
| M0 审计 | `NOE_BAILONGMA_ARCH_AUDIT.md` 落盘，列出可移植点 + 许可结论 + 数据 schema |
| M1 独立启动 | `PORT=51835 node server.js` 起得来；`curl 127.0.0.1:51835` 通；原项目 51735 不受影响 |
| M2 NoeLoop | 有一个可开关的最小心跳循环，能在空闲时产出一条"自主思考"记录，且不刷爆日志/CPU |
| M3 Memory Core | 记忆可写入可检索（SQLite 或现有存储），重启后不丢 |
| M4 Brain UI Lite | 面板内能看到记忆/循环状态的轻量可视化 |
| M5 体验层 | 语音/社交按需启用，默认关闭，不破坏既有安全护栏 |

每个里程碑遵循 Noe 既有 6 阶段协作模式（实施→反思→审核→修复→自检→更新 manifest）。

---

## 4. 风险假设（Risks & Assumptions）

### 4.1 假设（成立则方案有效）

- A1：BaiLongma 为 MIT，可合法吸收代码（已核实 LICENSE = MIT）。
- A2：Noe 端口 51835 与原项目 51735 不冲突（已核实绑定不同端口）。
- A3：BaiLongma 的 TICK/Memory/Brain UI 是可拆解的独立能力（`src/` 模块化已初步印证，待审计确认耦合度）。
- A4：融合按 sprint 渐进，不要求一次到位。

### 4.2 风险与缓解

| 风险 | 影响 | 缓解 |
|---|---|---|
| BaiLongma 模块互相强耦合，难单点抽取 | 审计后发现"吸收"成本高 | 先审计耦合度，按"可移植性"排序，先吸收最独立的（如 Memory schema） |
| 持续意识循环 = 持续烧 token / CPU | 成本与性能 | NoeLoop 默认关闭、可开关、设空闲阈值；本地小动作优先，禁止默认 spawn 付费子 LLM |
| 工具执行/marketplace 引入本机副作用 | 安全 | 红线 R2：审计+安全评估前不接入 |
| BaiLongma 用 SQLite，Noe 现有存储可能是 JSONL/其它 | 数据层不一致 | 审计 schema 后决定：复用 Noe 现有存储 or 新增隔离的记忆库，不混写 |
| 文档/报告与磁盘不符（幻觉） | 协同失真 | 每阶段交付物用 `cat`/`wc -l` 实读验证（本任务即遵守） |
| 范围漂移成"重写 BaiLongma" | 工期失控 | 一句话目标做锚，任何 PR 先过 §0 自检 |

---

## 5. 与工程闭环各阶段的衔接

本阶段是闭环第 1 环，向后逐环交棒：

1. **用户想法（本阶段）** ← 现在：锁定目标/边界/成功标准/风险。**产出本文件。**
2. **需求分析与拆解**：把 §2.1 的 6 件事拆成 backlog（审计 → 启动验证 → NoeLoop → Memory → Brain UI → 体验），定优先级与依赖。
3. **技术方案设计**：先做"只读审计"（产出 `NOE_BAILONGMA_ARCH_AUDIT.md`），据审计结论设计每个能力点如何以 Noe 风格落地（route module + 前端规范 + 存储选型）。
4. **任务分配与排期**：按集群成员能力分派（审计/设计/实现/验证），M0→M5 串行，sprint 推进。
5. **代码开发**：遵守 Noe 硬规则（改前必 Read、文件<500 行、不自主重启/commit/装依赖、不动原项目）。
6. **单元测试**：复用既有 vitest，新能力补单测，不新增依赖。
7. **集成测试**：跑 `.s18-*.mjs` smoke（基线 68/68）+ 启动隔离验证。
8. **功能验证**：M1–M5 各自的可验证标准逐条勾。
9. **文档编写**：审计文档 + 各 sprint 的 HANDOFF 更新。
10. **交付验收**：对照 §3 成功标准验收。
11. **复盘优化**：评估 Jarvis 体验真实度与成本，决定下一轮吸收顺序。

**交棒给「需求分析」阶段的输入**：本文件 §1 目标 + §2 边界 + §3 成功标准 + §4 风险，可直接转成需求 backlog 的约束条款。

---

## 6. 本阶段未做（防越界声明）

- 未写任何功能代码（符合"用户想法"阶段定位）。
- 未执行 BaiLongma 深度审计（属阶段 3，仅做了影响"约束/风险"的最小只读核对：LICENSE + 顶层结构 + 端口）。
- 未启动任何服务、未改原项目、未 commit。
