# Noe / Neo 贾维斯 — 阶段1「用户想法」交付物：目标 · 边界 · 成功标准 · 风险

> 工程闭环阶段：**1. 用户想法**
> 日期：2026-06-02
> 上游输入：`HANDOFF_2026-06-01_Noe_融合可行性结论.md`
> 本文件作用：把用户原始想法固化为一份「任何成员都能复述、不漂移」的目标契约。
> 下游衔接：阶段2「需求分析与拆解」直接引用本文件的范围边界与成功标准。

---

## 0. 实测事实锚点（防口径漂移，全部已验证）

| 事项 | 实测值 | 证据来源 |
|---|---|---|
| Noe 工作目录 | `/Users/hxx/Desktop/Neo 贾维斯` | 本轮 cwd |
| Noe 服务端口 | **51835** | `package.json:14 start:noe` / `server.js:322` |
| 原稳定项目目录 | `/Users/hxx/Desktop/00_项目/05_Claude可视化面板` | `ls -d` 实测存在 |
| 原项目端口 | **51735** | `05_Claude可视化面板/server.js:317` |
| 端口结论 | **51835 ≠ 51735，二者可同机共存而不抢端口** | 两份 grep 对比 |
| 审计镜像 | `/Users/hxx/Desktop/Neo 贾维斯/BaiLongma-audit`（完整 git clone，含 `.git`） | `ls -d` 实测存在 |
| 审计标的结构 | `src/{memory,context,capabilities,social,agents,...}` + `brain-ui.html` + `config.json` + `LICENSE` | `ls src/` 实测 |
| 当前分支 | `codex/paperclip-local-governance` | `git branch --show-current` |

> 路径契约遵守：Desktop 上虽存在 cwd 外旧镜像 `/Users/hxx/Desktop/BaiLongma-audit`，本项目一律使用工作区内 canonical 路径 `…/Neo 贾维斯/BaiLongma-audit`。

---

## 1. 一句话目标

> **把 Noe 打造成「本地优先的个人 AI 操作系统」：以 Noe 现有多模型工程执行底座为主干，吸收 BaiLongma 的持续意识循环、记忆、Brain UI、语音与工具生态「思路」，逐步逼近《钢铁侠》Jarvis 的常驻陪伴体验——而不是把两个项目硬拼或互相覆盖。**

## 2. 项目本质（产品定位）

- Noe = **多模型工程执行底座**（Electron 桌面壳 + 本地 Express/WS API + owner-token 安全 + Claude/GPT/Gemini 适配 + 集群协同 + 项目房间 + 任务执行/交付报告）。
- BaiLongma = **Jarvis 感体验来源**（TICK 持续运行、外部消息优先、空闲自主思考、SQLite 记忆、L1/L2 双层思考、焦点栈、Brain UI、语音、社交分发、工具市场）。
- 融合公式：`Noe(工程执行底座) + BaiLongma(持续意识/记忆/Brain UI 思路) = Noe 主产品`。
- **吸收的是思路与架构，不是代码搬运。** 任何 BaiLongma 代码进入 Noe 前必须先经只读审计 + 重写适配。

## 3. 范围边界

### 3.1 在范围内（IN）
1. 只读审计 BaiLongma（产出 `NOE_BAILONGMA_ARCH_AUDIT.md`），重点：`package.json`、`src/index.js`、`src/memory`、`src/context`、`src/ui/brain-ui`、`src/voice`、`src/social`、`src/capabilities/marketplace`、`electron`、`config.json`、`LICENSE`、数据库 schema。
2. 验证 Noe 自身能在 **51835** 启动，且不影响原项目 **51735**。
3. NoeLoop 最小闭环（TICK 思路的最小实现）。
4. Memory Core（记忆核心）。
5. Brain UI Lite（Brain UI 精简版）。
6. 在以上稳固后，再做语音、社交、Jarvis 体验增强。

### 3.2 不在范围内 / 明确推迟（OUT）
- 不在本阶段写任何融合功能代码（阶段1只产出目标契约）。
- 不把语音/社交/工具市场提前到 Memory Core 之前做。
- 不让 Noe 与 BaiLongma 两个服务长期并行常驻运行。
- 不把 Noe 改造成 BaiLongma，也不把 BaiLongma 改造成 Noe。

## 4. 不可做事项（红线，碰到先停）

| # | 红线 | 原因 |
|---|---|---|
| R1 | **不在原项目目录 `…/05_Claude可视化面板` 内开发/写入** | 原项目是稳定基线，必须零污染 |
| R2 | **不把 BaiLongma 全量复制进 Noe** | 会引入未审计代码与架构债 |
| R3 | **不审计就接入工具执行能力（`src/capabilities/marketplace` 等）** | 工具执行=高危面，需先评估安全 |
| R4 | 不在 cwd 外路径读写审计标的；统一用 canonical `…/Neo 贾维斯/BaiLongma-audit` | 跨成员可执行路径归一化 |
| R5 | 不自主 `git commit/push`、不自主重启 panel、不 `npm install` 新依赖（除非用户同意） | 沿用 Noe `CLAUDE.md` 既有硬规则 |
| R6 | 不动 secret/token/`.env`、不改系统级 plist/launchctl、不碰原项目端口 51735 | 安全与可逆性 |

## 5. 成功标准（可验收）

| 阶段里程碑 | 可验收判据（硬证据） |
|---|---|
| M0 本阶段（用户想法） | 本文件落地，且 Claude+GPT/Codex 能复述同一目标、无范围漂移 |
| M1 审计 | `NOE_BAILONGMA_ARCH_AUDIT.md` 覆盖 package.json/index/memory/context/brain-ui/voice/social/marketplace/electron/config/LICENSE/DB schema，结论含「可吸收 vs 不可直接接入」清单 |
| M2 共存 | `PORT=51835 npm run start:noe` 起得来；原项目 51735 不受影响（两端口可同时占用、互不抢占） |
| M3 NoeLoop | 最小 TICK 闭环可跑通一轮「感知→思考→产出」并留下可观测日志 |
| M4 Memory Core | 写入/检索记忆有 SQLite 落盘证据 + 单测通过 |
| M5 Brain UI Lite | 浏览器可见的最小 Brain UI，能渲染当前状态 |

## 6. 风险与假设

**假设**
- A1：BaiLongma `LICENSE` 允许吸收其思路/架构（具体条款待 M1 审计中核实，未核实前不搬运代码）。
- A2：Noe 现有 51835 底座可独立启动（端口已确认不冲突，启动验证留到 M2）。
- A3：审计镜像为只读副本，审计期间不修改其内容。

**风险**
- K1：BaiLongma 工具市场/能力执行面存在安全隐患 → 缓解：R3，审计先行、默认不接入。
- K2：架构硬拼导致 Noe 底座被污染 → 缓解：R2/R6，只吸收思路、增量重写。
- K3：两服务并行造成端口/资源/数据库冲突 → 缓解：3.2，不长期并行；M2 仅做共存性验证。
- K4：范围蔓延（语音/社交提前做）→ 缓解：严格按 IN 列表 1→6 串行推进。
- K5：跨成员路径不一致导致工具层拒绝 → 缓解：R4，统一 canonical 路径。

---

## 7. 与完整工程闭环的衔接（10 阶段如何落地）

| 阶段 | 在本项目如何落地 |
|---|---|
| 1 用户想法 | **本文件**：固化目标/边界/成功标准/风险（当前阶段，已交付） |
| 2 需求分析与拆解 | 基于本文件 IN 列表，把 M1–M5 拆成可执行 backlog（先做 M1 审计需求） |
| 3 技术方案设计 | 产出 `NOE_BAILONGMA_ARCH_AUDIT.md` + 融合方案：哪些思路吸收、以何种 Noe 既有模式重写 |
| 4 任务分配与排期 | 按 1→6 路线串行排期，集群成员分工（审计/底座/Memory/UI） |
| 5 代码开发 | M3 NoeLoop → M4 Memory Core → M5 Brain UI Lite，遵循 Noe `CLAUDE.md` 工程约束（文件<500行等） |
| 6 单元测试 | Memory Core 等核心模块 vitest 单测 |
| 7 集成测试 | NoeLoop+Memory+UI 串联，复用 `.s18-*.mjs` smoke 思路 |
| 8 功能验证 | 51835 启动、TICK 跑通、记忆落盘、Brain UI 可见的端到端验证 |
| 9 文档编写 | 更新 `HANDOFF.md` / `README.md` 融合进展 |
| 10 交付验收 | 对照本文件 §5 成功标准逐条核验 |
| 11 复盘优化 | 回看红线是否守住、范围是否漂移，迭代下一轮 |

---

## 8. 一句话复述模板（供其他成员对齐，验证「无漂移」）

> 「Noe 做主底座，只读审计 BaiLongma 后**吸收思路而非搬代码**，按『审计→51835 共存→NoeLoop→Memory Core→Brain UI Lite→语音/社交』串行推进；红线是不碰原项目目录、不全量复制、不审计就接工具、不动 secret/端口/系统调度。」
