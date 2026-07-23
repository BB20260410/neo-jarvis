# Noe / Neo 贾维斯 CE12 P0 任务分配与排期 CANONICAL

生成时间：2026-06-02  
工作区：`/Users/hxx/Desktop/Neo 贾维斯`  
阶段：4. 任务分配与排期  
Source of truth：本文件是 CE12 P0「任务分配与排期」阶段的事实源；需求事实源仍是 `NOE_CE12_P0_REQUIREMENTS_CANONICAL.md`。  
状态边界：Brain UI Lite 原型和复盘闭环已完成；完整 Jarvis 产品未完成，本阶段不得表述为产品完成。

## 0. 单模型接管裁定

本轮自动返工原因是 `signoff_incomplete=task_planning:1/2`。Claude 在 propose 阶段不可用，MiniMax M3 运行时不可用，因此由 GPT-Codex solo takeover 补齐 CE04 阶段事实源、验证门和落地证据。

接管范围：
- GPT-Codex 负责本阶段任务队列、顺序、负责人、排期、阻塞点、验证门和磁盘证据。
- Claude 恢复后只做复核，不阻塞当前推进。
- MiniMax M3 恢复后只做中文侧硬风险补审；只有 secret 泄露、路径或权限错误、原项目污染、数据破坏、不可逆操作、安全风险、明确事实错误可以阻断。

本轮边界：
- 只在 `/Users/hxx/Desktop/Neo 贾维斯` 工作。
- 不修改 `/Users/hxx/Desktop/00_项目/05_Claude可视化面板`。
- 不做 Voice、Social I/O、完整 Jarvis 全体验。
- 不把 BaiLongma 全量复制进 Noe。
- 不接未审计真实工具执行能力。

## 1. 当前实测基线

本阶段排期前已核对：

```bash
pwd
/Users/hxx/Desktop/Neo 贾维斯

git rev-parse --show-toplevel
/Users/hxx/Desktop/Neo 贾维斯

node -v
v26.0.0

node NOE_CE12_P0_REQUIREMENTS_VERIFY.mjs
Result: 60/60 checks passed
```

已知风险基线：
- 当前交互 shell 是 Node v26.0.0，不是 `.nvmrc` 的 22.22.2；CE05 第一硬门仍是 Node22 gate 或明确 re-exec。
- 旧 `tests/e2e/noe-brain-ui.e2e.mjs` 仍存在；CE12 不能再把旧坏证据当成通过证据。
- 工作区已有大量历史修改和新增文件；本阶段不清理、不回滚不相关脏文件。

## 2. 执行队列

| 顺序 | 任务 | P0 映射 | 交付文件或区域 | 主责 | 复核或补审 | 验证门 |
|---|---|---|---|---|---|---|
| T0 | CE04 排期事实源和门禁修复 | FR-P0-6 | `NOE_CE12_P0_TASK_PLAN_CANONICAL.md`、`NOE_CE12_P0_TASK_PLAN_VERIFY.mjs` | GPT-Codex | Claude 恢复后复核；M3 补审硬风险 | `node NOE_CE12_P0_TASK_PLAN_VERIFY.mjs` exit 0 |
| T1 | Node22 fail-fast 与 re-exec gate | FR-P0-1 | `scripts/ensure-node22.mjs`、`.nvmrc`、`package.json` scripts、Node runbook、相关单测 | GPT-Codex | Claude 复核 | 非 22 入口 fail-fast 或 re-exec；证据含版本、ABI、exit code |
| T2 | 旧 Brain UI e2e 修复或废弃 | FR-P0-2 | `scripts/e2e-with-server.mjs`、`tests/e2e/noe-brain-ui-p0.e2e.mjs`、旧脚本 deprecated 或转发说明 | GPT-Codex | Claude 复核 | `npm run test:e2e` 不引用 known_bad 证据；截图或 DOM 断言落盘 |
| T3 | 最小 Act Pipeline | FR-P0-4 | `src/loop/ActPipeline.js`、`src/loop/ActStore.js`、`src/server/routes/noe.js`、单测 | GPT-Codex | Claude 复核，M3 只审硬风险 | plan、propose、approval、dry-run、evidence、retry、cancel 均有测试 |
| T4 | Brain UI 执行可视化增强 | FR-P0-3 | `public/index.html`、`public/src/web/brain-ui.js`、`public/style.css`、P0 e2e | GPT-Codex | Claude UI 复核 | act queue、当前 act、审批、权限、失败原因、成本预算、日志入口可见 |
| T5 | Electron smoke | FR-P0-5 | `scripts/electron-smoke.mjs`、`scripts/package-electron.mjs`、`electron-main.js`、`out-noe/`、`output/electron-smoke/` | GPT-Codex | Claude 复核 | app 启动、退出、菜单注册、日志、打包目录证据齐全；不做签名或公证 |
| T6 | MiniMaxSpawnAdapter patch-only | FR-P0-7 | `src/room/MiniMaxSpawnAdapter.js`、相关单测、M3 补审记录 | GPT-Codex | MiniMax M3 恢复后补审 | 只允许 session new/messages/diff；shell/write/delete/move/apply_patch 均 `blocked_safety` |
| T7 | 证据索引和交付状态闭环 | FR-P0-6 | `NOE_CE12_P0_EVIDENCE_INDEX.md`、交接文档、验收文档 | GPT-Codex | Claude 复核 | 每个 P0 都有路径、命令、exit code、日志、截图或产物；阶段完成不等于产品完成 |

## 3. 执行顺序

第一批必须先做：
1. T0：关闭本轮 `task_planning` signoff 缺口。
2. T1：Node22 gate，因为后续命令证据必须统一运行时。
3. T2：旧 e2e 证据治理，因为 UI 验收不能继续引用坏证据。

第二批可以并行：
1. T3：Act Pipeline 数据面。
2. T4：Brain UI 执行可视化。

第三批收口：
1. T5：Electron smoke。
2. T6：MiniMaxSpawnAdapter patch-only。
3. T7：Evidence Index 和交付状态闭环。

禁止跳跃：
- T1 未通过前，不把任何后续测试作为最终验收证据。
- T2 未通过前，不把旧 `noe-brain-ui.e2e.mjs` 当作通过证据。
- T3 未通过前，T4 只能做静态 DOM，不得宣称执行闭环完成。
- T7 未完成前，不能进入 CE10 交付验收裁定。

## 4. 小任务拆分

T1 Node22：
- T1.1 检查 `.nvmrc`、`NOE_NODE_BIN`、`PATH`，找不到 Node22 时 fail-closed。
- T1.2 将 verify、unit、e2e、integration、electron smoke 的入口纳入 gate 或 re-exec。
- T1.3 单测覆盖 Node22 命中、低版本 fail-fast、Node26 风险提示、找不到 Node22 fail-closed。

T2 e2e：
- T2.1 全文检索 `noe-brain-ui.e2e`，逐项标记 replaced、deprecated 或 active。
- T2.2 确认 `scripts/e2e-with-server.mjs` 运行 P0 e2e，而不是 known_bad 证据。
- T2.3 产出 `output/playwright/` 截图或 DOM 断言日志。

T3 Act Pipeline：
- T3.1 ActStore 持久化 act queue、状态、失败原因、证据引用。
- T3.2 ActPipeline 实现 plan、propose、approval gate、dry-run execute、record evidence、retry、cancel。
- T3.3 删除、外发、批量移动、高危 shell 默认 approval_required 或 blocked_safety，不真实执行。

T4 Brain UI：
- T4.1 增加稳定 DOM：`#noeActQueue`、`#noeCurrentAct`、`#noeApprovalStatus`、`#noeToolPermissionStatus`、`#noeFailureReason`、`#noeBudgetStatus`、`#noeEvidenceLogLink`。
- T4.2 接 `/api/noe/health` 或 `/api/noe/acts` 数据，空状态也要展示可解释信息。
- T4.3 Playwright 断言 DOM 可见，并写截图路径。

T5 Electron：
- T5.1 使用现有 `electron-builder --dir` 或 `npm run package` 生成 `out-noe/`。
- T5.2 smoke 只验启动、退出、菜单注册、日志，不做签名、公证、发布。
- T5.3 finally 清理子进程和端口，日志写到 `output/electron-smoke/`。

T6 MiniMax：
- T6.1 CLI 路径解析优先 `PATH`，其次 `/Users/hxx/.mavis/bin/minimax` 和 `/Applications/MiniMax Code.app/.../cli.js`。
- T6.2 CLI 找不到时 fail-closed，并在 Evidence Index 记录补审点。
- T6.3 对任何 shell/write/delete/move/apply_patch 或非空 diff 诉求返回 `blocked_safety`。

T7 证据：
- T7.1 每完成一个 P0，同步更新 `NOE_CE12_P0_EVIDENCE_INDEX.md`。
- T7.2 每条证据必须包含文件路径、命令、exit code、日志、截图或产物路径。
- T7.3 明确写入「产品化基础可继续验收」，不得写「完整 Jarvis 产品完成」。

## 5. 排期和检查点

| 检查点 | 包含任务 | 完成门槛 | 失败降级 |
|---|---|---|---|
| CP0 | T0 | CE04 canonical 与 verify 落盘，verify exit 0 | 由 GPT-Codex solo takeover 直接修复 |
| CP1 | T1 + T2 | Node22 gate 和 e2e 证据治理通过 | Node22 找不到则 fail-closed，记录安装或路径补审；旧 e2e 改 deprecated stub |
| CP2 | T3 + T4 | Act Pipeline 和 Brain UI 可视化联通，单测与截图存在 | UI 可先展示 dry-run 空态，但不能宣称执行完成 |
| CP3 | T5 + T6 | Electron smoke 与 MiniMax patch-only safety 通过 | Electron 菜单点击降级为菜单已注册；M3 CLI 找不到则记录补审点 |
| CP4 | T7 | Evidence Index 覆盖所有 P0，CE06 至 CE10 可逐项验收 | 证据缺项不得进入交付验收 |

讨论上限：
- 每个检查点最多 3 轮讨论。
- 没有可复验证硬阻断时，直接推进到下一阶段。
- 只剩 GPT-Codex 可用时允许 solo takeover，但必须记录原因、风险和补审点。

## 6. 阻塞点

真正硬阻断：
- 需要写入或修改 `/Users/hxx/Desktop/00_项目/05_Claude可视化面板`。
- 发现 secret 泄露、路径或权限错误、原项目污染、数据破坏、不可逆操作、安全风险、明确事实错误。
- Node22 gate 无法 fail-fast，也无法 re-exec 到可用 Node22。
- 旧 e2e 继续被写为通过证据。
- 危险操作真实执行外发、删除、批量移动或高危 shell。

非阻断但必须记录：
- Claude 掉线。
- MiniMax M3 或 MiniMax CLI 不可用。
- Electron 菜单无法自动点击。
- 命名、视觉细节、P2/P3 功能建议。

## 7. 角色分工

当前实际分工：
- GPT-Codex：本轮唯一可用执行成员，负责 CE04 文件、验证、后续代码和证据。
- Claude：当前不可用；恢复后负责代码审查、UI 证据复核、交付表述复核。
- MiniMax M3：当前不可用；恢复后负责中文侧硬风险补审，不拥有普通否决权。

后续推进规则：
- Claude + GPT-Codex 一致即可推进。
- Claude 不可用时，GPT-Codex + MiniMax M3 一致即可推进。
- MiniMax M3 不可用时，Claude + GPT-Codex 继续并记录补审点。
- 只剩 GPT-Codex 时，允许 solo takeover，但所有代码、测试、验收必须给出硬证据。

## 8. 验证门

CE04 本阶段验证：

```bash
node NOE_CE12_P0_REQUIREMENTS_VERIFY.mjs
node NOE_CE12_P0_TASK_PLAN_VERIFY.mjs
wc -l NOE_CE12_P0_TASK_PLAN_CANONICAL.md NOE_CE12_P0_TASK_PLAN_VERIFY.mjs
```

CE05 及以后窄验证：

```bash
npm run verify:node22
npm run test:p0:unit
npm run test:p0:integration
npm run test:e2e
npm run smoke:electron
npm run verify:p0:fast
cat NOE_CE12_P0_EVIDENCE_INDEX.md
```

UI 证据门：
- Brain UI 截图或 DOM 断言必须覆盖 act queue、当前 act、审批、工具权限、失败原因、成本预算、日志入口。
- 证据必须写入本地路径，不能只在聊天中描述。

## 9. 与工程闭环 11 阶段衔接

1. 用户想法：继承 Noe 主产品底座，完整 Jarvis 未完成。
2. 需求分析与拆解：以 `NOE_CE12_P0_REQUIREMENTS_CANONICAL.md` 为唯一需求事实源。
3. 技术方案设计：以 CE03 的 Node gate、Act Pipeline、Brain UI、Electron、MiniMax patch-only 设计为落地依据。
4. 任务分配与排期：本文件给出任务队列、顺序、角色、排期、阻塞点和验证门。
5. 代码开发：从 T1/T2 开始，逐项实现，不扩大到 Voice/Social/完整体验。
6. 单元测试：覆盖 Node gate、ActPipeline、审批、预算、MiniMax safety。
7. 集成测试：覆盖 51835 启停、51735 零影响、Noe API、UI 数据源、Electron smoke。
8. 功能验证：用 Browser/Playwright 截图和 DOM 断言证明 P0 执行可视化。
9. 文档编写：维护 Evidence Index、runbook、交接文档，避免产品完成误述。
10. 交付验收：逐 P0 核对命令、exit code、日志、截图、产物。
11. 复盘优化：记录 Node/runtime、旧坏证据、权限预算、Electron、M3 降级补审点。

## 10. CE04 裁定

CE04 可推进 CE05。任务粒度已细到可逐项执行和验收；当前没有可复验证的 secret、路径污染、原项目写入、数据破坏、不可逆操作或安全硬阻断。下一阶段必须从 T1 Node22 gate 与 T2 旧 e2e 证据治理开始。
