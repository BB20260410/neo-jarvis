# S24 app.js 外迁 — named-5 硬骨头 全部完成

> 2026-06-04 更新。app.js **12825 → 8488 行（本会话 -4337 / -34%）**。
> named-5：**✅4 个可迁区全落地 · ⛔1 个 chat-1v1 不外迁**。三轮代码审查 + 修复后 GO 可交付。**未 push。**

## 提交链（noe-main，未 push）
`8db1004`(审查修复) ← `7802750`(agent-graph) ← `aaba01e`(governance) ← `fb49fc9`(overview) ← `c5a4db1`(audit-timeline) ← `db06b52`(蓝图) ← `b87ec1e`(F1+F2) ← `83544cc`(room-adapter，被并发会话 commit -a 并入)
> 注：审查修复后又补了两处 `?.`（6967右侧/7271 renderAgentRegistryModal），随收尾提交。

## 本会话已完成（均运行时隔离实测通过）

| 批次 | 内容 | app.js | 验证 |
|---|---|---|---|
| room-adapter | Room Adapter 配置 modal → `room-adapter-ui.js` | -181 | 6/6 + e2e 17/17 |
| **F1 keystone** | `/ws/global` onmessage 改 pub/sub，暴露 `window.PanelGlobalWs.subscribe` | +12 | 5/5 |
| F2 | 生成总结报告 → `summary-report-ui.js`（subscribe 报告 WS handler） | -321 | 9/9 |
| **audit-timeline** ⭐ | 审计时间线 → `activity-ui.js`(620行) | -590 | 9/9 |
| **overview** ⭐ | 总览面板 → `overview-ui.js`(446行)，**修审批跳转bug** | -408 | 10/10 |
| **governance** ⭐ | 治理中心 → `governance-ui.js`(602行) | -575 | 11/11 |
| **agent-graph** ⭐ | 智能体图谱(2292行) → `agent-graph-ui.js`(2324行)，**分两步+修TDZ bug** | -2291 | 8/8 |
| 审查修复 | codebase区agentRegistryState守卫 + 8处可选链 | — | 综合回归9/9 |

已外迁模块共 9 个（含早批 webhook/archive/mcp/autopilot/budget 等）。

## 自检抓到并修复的真 bug
1. **overview 审批跳转静默失效**：`governanceTarget` 用 `window.PanelCore.openApprovalModal?.()` 但桥没加 → 补 `openApprovalModal/openDelegationModal` 入桥。
2. **agent-graph MODEL_OPTIONS TDZ**：桥直引 `MODEL_OPTIONS`(const 定义在桥后@2994) → 桥对象求值时 ReferenceError 崩整个 app.js。`node --check` 没抓到，**运行时实测抓到**。改 getter 延迟求值。
3. **codebase 区 agentRegistryState 无防护**：getter 可能返 undefined，15+ 处裸访问 → 加局部 `ag` 变量 + 守卫。

## 沉淀的通法（后续外迁照用）
- **区内共享工具留 app.js + 加桥**：被多处区外用的纯工具（activityTime/safeClassToken/governanceCenterBytes/stagedDiffReviewText/governanceShortHash）留 app.js 原位、加桥，只搬 modal 本体。避免大量区外改写。
- **桥直引只用于 function 声明**（会 hoist）；`const/let` 定义在桥后的**必须用 getter**，否则 TDZ 崩。
- **跨模块依赖防 boot 时序**：下游模块对"定义在别模块"的符号要**运行时取** `window.PanelCore.xxx?.()`，不要 boot 解构（agent-graph 第一步专门把 activity/governance 改成运行时取）。
- **大区分两步降风险**：①下游解耦（加桥 getter + 下游改运行时取）②主体外迁（桥后端从直引切 getter，对下游透明）。
- **node --check 只验语法，必须运行时实测**：隔离 HOME 起 server + playwright（`addInitScript` 设 `panel:onboarding:v1=1`+`panel:telemetry:asked=1` 跳首屏弹窗）→ `window.PanelXxx.open()` 开 modal + 验 0 console error + 验各模块回归。

## ⛔ chat-1v1：不外迁（结论）
1684 行是 Room 系统核心调度层，`handleRoomEvent` 是全局 WS 事件总线（app.js onmessage + 测试桥直调）。**整块严禁外迁**；仅未来可把 chat 专属渲染段单抽 `chat-room-ui.js`，总线+集群+绑定留 app.js。

## 后续可选（非 named-5，仍在 app.js 的 med 区）
codebase / knowledge / delegation / plugin-center / exp-6pack / squad-kanban / room-template / timeline。
- codebase 已部分解耦（agentRegistryState 经桥 + agentPreviewCwd/sanitizeCodebaseQuestionAnswer/parseAgentPreviewFiles 经 window.PanelAgentGraph）。
- 完整 16 区依赖分析见 workflow 产出（task wce6l43y3）。

## ⚠️ 并发注意（持续）
工作树与另一 `claude --dangerously-skip-permissions` 会话**共享**，它 `commit -a` 会扫走暂存改动。续作前 `git log --oneline -3` + `git status` 确认；**只 `git add <自己文件>` 别 `-A`**；别碰 `src/memory/*` 等他人未提交工作。本会话所有提交已用路径限定 commit 保护。
