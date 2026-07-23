# CE12 P0 任务分配与排期 - GPT 独立稿

生成时间：2026-06-02  
工作区：`/Users/hxx/Desktop/Neo 贾维斯`  
阶段：4. 任务分配与排期  
事实源：承接 `NOE_CE12_P0_REQUIREMENTS_CANONICAL.md` 和 CE03 技术方案；本文件不替代需求事实源。当前只能表述为「Brain UI Lite 原型和复盘闭环已完成，完整 Jarvis 产品未完成」。

## 0. 本阶段实测锚点

本轮已在 Noe 工作区实测，作为排期前提：

```bash
pwd
/Users/hxx/Desktop/Neo 贾维斯

node -v
v26.0.0

node -p "process.versions.modules"
147

cat .nvmrc
22.22.2

node NOE_CE12_P0_REQUIREMENTS_VERIFY.mjs
Result: 60/60 checks passed
```

当前旧 e2e 入口仍活着，必须在第一批代码里处理：

```bash
rg -n "noe-brain-ui\\.e2e|test:e2e" scripts tests package.json NOE_CE12_P0_REQUIREMENTS_CANONICAL.md NOE_CE12_P0_TECH_DESIGN_GPT.md
package.json:36:    "test:e2e": "node scripts/e2e-with-server.mjs",
package.json:37:    "test:e2e:managed": "node scripts/e2e-with-server.mjs",
scripts/e2e-with-server.mjs:135:    const e2e = spawnSync(node22, ['tests/e2e/noe-brain-ui.e2e.mjs'], {
```

当前 Brain UI 已有基础 DOM，但还缺 CE12 P0 的执行可视化 DOM：

```bash
rg -n "noeBrainArea|noeLoopMetrics|noeThoughtStream|noeToolsList|noeApprovalsList|noeActQueue|noeCurrentAct|noeApprovalStatus|noeToolPermissionStatus|noeFailureReason|noeBudgetStatus|noeEvidenceLogLink" public/index.html public/src/web/brain-ui.js public/style.css
public/src/web/brain-ui.js:64:  const root = $('#noeBrainArea');
public/src/web/brain-ui.js:93:  const root = $('#noeThoughtStream');
public/src/web/brain-ui.js:154:    renderMetrics($('#noeLoopMetrics'), [
public/src/web/brain-ui.js:198:  renderList($('#noeToolsList'), data.tools || [], '暂无工具 manifest；默认不会执行任何工具。', (tool) => `
public/src/web/brain-ui.js:208:  renderList($('#noeApprovalsList'), data.approvals || [], '没有待处理审批。', (approval) => `
public/index.html:139:    <div class="noe-brain-area" id="noeBrainArea" style="display:none;">
public/index.html:156:          <div class="noe-brain-metrics" id="noeLoopMetrics"></div>
public/index.html:173:          <div class="noe-brain-list noe-thought-stream" id="noeThoughtStream"></div>
public/index.html:187:          <div class="noe-brain-list" id="noeToolsList"></div>
public/index.html:192:          <div class="noe-brain-list" id="noeApprovalsList"></div>
```

Electron 与 MiniMax 相关锚点也已实测存在：`package.json` 依赖 `electron-builder`，打包输出目录为 `out-noe`，`electron-main.js` 注册 `BrowserWindow` 和 `Menu`；现有 `src/room/MiniMaxChatAdapter.js` 只覆盖 chat，尚无 `MiniMaxSpawnAdapter`。

## 1. 裁定和取舍

- CE12 只排 P0：Node22 gate、旧 e2e 处理、Brain UI 执行可视化、最小 Act Pipeline、Electron smoke、交付证据闭环、MiniMaxSpawnAdapter patch-only。
- Voice、Social I/O、完整 Jarvis 全体验不进入本轮排期。
- BaiLongma 只作为已审计参考，不复制整仓，不接未审计工具执行能力。
- MiniMax M3 是中文侧审计辅助；只有 secret 泄露、路径/权限错误、原项目污染、数据破坏、不可逆操作、安全风险或明确事实错误可阻断。
- 当前 shell 是 Node v26，不是 `.nvmrc` 的 22.22.2，因此 CE05 第一任务必须先做 Node22 gate，后续验证不得绕过。

## 2. 执行队列

| 顺序 | 任务 | P0 映射 | 主要交付文件 | 主责 | 验证门 |
|---|---|---|---|---|---|
| T0 | CE04 排期落账和证据基线 | FR-P0-6 | `NOE_CE12_P0_TASK_PLAN_GPT.md` | GPT-Codex | 本文件 `wc -l` / `cat`；需求 verify 60/60 |
| T1 | Node22 fail-fast / re-exec gate | FR-P0-1 | `scripts/ensure-node22.mjs`、`tests/unit/node22-gate.test.js`、`NOE_NODE_VERSION_RUNBOOK.md`、必要的 `package.json` script wrapper | GPT-Codex 主做，Claude 复核 | 非 Node22 命令 fail-fast 或显式 re-exec；输出当前版本、ABI、`.nvmrc`、exit code |
| T2 | 旧 Brain UI e2e 修复或废弃 | FR-P0-2 | `tests/e2e/noe-brain-ui-p0.e2e.mjs`、`scripts/e2e-with-server.mjs`、旧脚本 deprecated/forward 说明、`output/playwright/` 截图 | GPT-Codex 主做，Claude 复核 | `rg "noe-brain-ui.e2e"` 全部处理；`npm run test:e2e` 不再引用 known_bad 证据 |
| T3 | 最小 Act Pipeline 数据面 | FR-P0-4 | `src/loop/ActPipeline.js`、`src/loop/ActStore.js` 或 SQLite migration、`tests/unit/noe-act-pipeline.test.js` | GPT-Codex 主做，Claude 复核，M3 只审硬风险 | 覆盖 plan/propose/approval/dry-run/evidence/retry/cancel；危险操作无审批只到 `approval_required` 或 `blocked_safety` |
| T4 | Brain UI 执行可视化增强 | FR-P0-3 | `public/index.html`、`public/src/web/brain-ui.js`、`public/style.css`、P0 e2e DOM 断言 | GPT-Codex 主做，Claude 做 UI/证据复核 | `#noeActQueue`、`#noeCurrentAct`、`#noeApprovalStatus`、`#noeToolPermissionStatus`、`#noeFailureReason`、`#noeBudgetStatus`、`#noeEvidenceLogLink` 可见并截图 |
| T5 | Electron smoke | FR-P0-5 | `scripts/electron-smoke.mjs`、`output/electron-smoke/` 日志、`out-noe/` 打包目录证据 | GPT-Codex 主做，Claude 复核 | `npm run package -- --mac --dir` 或等价命令；app 启动、退出、菜单注册、日志存在，exit code 0 |
| T6 | MiniMaxSpawnAdapter patch-only 原型 | FR-P0-7 | `src/room/MiniMaxSpawnAdapter.js`、`tests/unit/minimax-spawn-adapter.test.js`、M3 补审记录 | GPT-Codex 主做，MiniMax M3 可审中文侧风险 | 只允许 session new/messages/diff；`diffs=[]` 才保存建议；shell/write/delete/move/apply_patch 返回 `blocked_safety` |
| T7 | 交付证据索引和状态闭环 | FR-P0-6 | `NOE_CE12_P0_EVIDENCE_INDEX.md`、必要的交接更新 | GPT-Codex 主做，Claude 复核 | 每项 P0 都有文件路径、命令、exit code、日志/截图/产物；明确阶段完成不等于产品完成 |

## 3. 小步拆分

T1 拆分：
- T1.1 写 `ensure-node22`，探测顺序为 `NOE_NODE_BIN`、`.nvmrc` 对应 nvm 路径、`PATH`。
- T1.2 给 verify/e2e/package/smoke 接入 gate；普通 `npm start` 如保留 Node26 warn，必须在 runbook 明确。
- T1.3 单测覆盖 Node22 命中、低于 22 fail-fast、找不到 Node22 fail-closed。

T2 拆分：
- T2.1 先跑全文 `rg "noe-brain-ui.e2e"`，逐项标记 replace/deprecated。
- T2.2 新建 P0 e2e，断言 CE12 UI DOM 和截图路径。
- T2.3 更新 `scripts/e2e-with-server.mjs`，不再把旧脚本当通过证据。

T3/T4 拆分：
- T3.1 ActStore 先用内存实现，SQLite migration 作为同批或紧随任务，但必须可持久化 evidence ref。
- T3.2 ActPipeline 只做 dry-run，不做真实外发、删除、批量移动。
- T4.1 UI 先接 `/api/noe/health` 的 act summary，再扩展 act queue API。
- T4.2 Browser/Playwright 截图必须写入 `output/playwright/`，不得用文字替代。

T5/T6/T7 拆分：
- T5.1 Electron smoke 只验启动/退出/菜单注册/日志/目录，不做签名、公证。
- T6.1 MiniMax CLI 路径优先 `PATH`，其次 `/Users/hxx/.mavis/bin/minimax` 和 `/Applications/MiniMax Code.app/.../cli.js`；找不到即 fail-closed 并记录补审点。
- T7.1 Evidence Index 随每批代码同步更新，不等到最后补写。

## 4. 排期和检查点

| 检查点 | 顺序 | 完成条件 | 可推进到 |
|---|---|---|---|
| CP0 | T0 | CE04 文档落盘，需求 verify 60/60，旧 e2e/UI/Node 现状有命令证据 | CE05 代码开发 |
| CP1 | T1 + T2 | Node22 gate 生效；旧 e2e 不再作为 known_bad pass 证据 | Act/UI 代码 |
| CP2 | T3 + T4 | Act Pipeline dry-run 与 Brain UI 执行可视化联通；截图和 DOM 断言存在 | Electron/MiniMax |
| CP3 | T5 + T6 | Electron smoke 有日志/打包目录；MiniMax adapter patch-only safety 单测通过 | 证据闭环 |
| CP4 | T7 | `NOE_CE12_P0_EVIDENCE_INDEX.md` 汇总所有 P0 当前证据 | CE06-CE10 验证与验收 |

默认节奏：每个检查点最多 3 轮讨论；没有可复验证硬风险时直接推进。Claude 不可用时，GPT-Codex + MiniMax M3 可推进；MiniMax M3 不可用时，Claude + GPT-Codex 继续并记录补审点；只剩 GPT-Codex 时允许 solo takeover，但必须在 Evidence Index 写明降级原因、风险和补审点。

## 5. 阻塞点

真正硬阻断：
- 写入或修改 `/Users/hxx/Desktop/00_项目/05_Claude可视化面板`。
- 发现 secret 泄露、路径越权、数据破坏、不可逆删除/移动、真实外发执行、安全风险或明确事实错误。
- Node22 gate 无法找到可用 Node22，且关键验证无法 fail-fast 或 re-exec。
- 旧 e2e 继续被写成通过证据。

不阻断但必须记录：
- MiniMax M3 掉线或 CLI 找不到。
- Electron 菜单无法真实点击；P0 可降级为菜单已注册加启动/退出/日志 smoke。
- 普通 UI 建议、命名偏好、P2/P3 功能想法。

## 6. 验证命令清单

CE05 之后每批最窄验证按以下命令收敛：

```bash
pwd
node -v
node -p "process.versions.modules"
node NOE_CE12_P0_REQUIREMENTS_VERIFY.mjs
rg -n "noe-brain-ui\\.e2e|known_bad|deprecated|replaced" scripts tests docs *.md
npm run test -- tests/unit/node22-gate.test.js tests/unit/noe-act-pipeline.test.js tests/unit/minimax-spawn-adapter.test.js
npm run test:e2e
node scripts/electron-smoke.mjs
cat NOE_CE12_P0_EVIDENCE_INDEX.md
```

UI 硬证据门槛：Browser/Playwright 必须产出包含 act queue、当前 act、审批、工具权限、失败原因、成本/预算、可复现日志入口的截图或 DOM 断言；截图路径必须写进 Evidence Index。

## 7. 11 阶段衔接

1. 用户想法：继承 Noe 主产品、完整 Jarvis 未完成、只做 CE12 P0。
2. 需求分析：以 `NOE_CE12_P0_REQUIREMENTS_CANONICAL.md` 为需求事实源。
3. 技术方案：以 CE03 技术方案中的模块、状态机、失败处理、回滚策略指导落地。
4. 任务分配与排期：本文件完成队列、角色、顺序、阻塞点、验证门。
5. 代码开发：按 T1 到 T7 顺序执行，不越级做 Voice/Social/完整体验。
6. 单元测试：覆盖 Node gate、ActPipeline、审批/预算阻断、MiniMax safety。
7. 集成测试：覆盖 51835 启停、51735 零影响、Noe API、UI 数据源、Electron smoke。
8. 功能验证：用 Browser/Playwright 截图和 DOM 断言验证执行可视化。
9. 文档编写：维护 Evidence Index、runbook、交接文件，不写产品完成。
10. 交付验收：逐 P0 核对命令、exit code、截图、日志、产物路径。
11. 复盘优化：记录 Node/runtime、坏证据治理、权限预算、Electron、M3 降级补审点。

## 8. CE04 裁定

CE04 可推进 CE05。当前任务粒度已经细到可逐项执行和验收；没有发现 secret、路径污染、原项目写入、数据破坏、不可逆操作或安全硬风险。第一批代码只能从 T1/T2 开始，不能跳到 Voice/Social/完整 Jarvis 体验。
