# CE12 P0 任务分配与排期 — Claude 成员独立稿（计划↔落地交叉校验版）

阶段：4. 任务分配与排期（CE04）
工作区：`/Users/hxx/Desktop/Neo 贾维斯`
事实源声明（避免 CE01 竞争稿反模式）：本文件**不是**第二份 canonical，不替代 `NOE_CE12_P0_REQUIREMENTS_CANONICAL.md`（需求 60/60）与 CE03 技术方案；GPT 的 `NOE_CE12_P0_TASK_PLAN_GPT.md` 作为本阶段参考排期稿，本稿是 Claude 成员独立视角 + 排期硬门补强。
产品状态口径：当前只能表述为「Brain UI Lite 原型与复盘闭环已完成，完整 Jarvis 产品未完成」；本阶段只排 P0，不排 Voice / Social / 完整 Jarvis 体验。

## 0. 与 GPT 排期稿的收敛
- 我**未覆盖** GPT 排期稿；T0–T7 队列、CP0–CP4 检查点、阻塞点、故障转移规则与 GPT 稿同口径，无范围漂移。
- 本稿三处补强（GPT 稿未含）：
  1. **计划 ↔ 落地交叉校验门** `NOE_CE12_P0_TASK_PLAN_VERIFY.mjs`——把「任务粒度可执行」从声明升级为可复现 PASS/FAIL（其他阶段都有 VERIFY，唯独排期阶段缺）。
  2. **显式依赖 DAG**（§3），把串并行边界写死，供 CE05 调度。
  3. **每个任务的故障转移降级矩阵**（§6），落实 Claude / MiniMax M3 掉线时的接管口径。

## 1. 实测锚点（排期前提，本轮 Noe 工作区实跑）
```
node -v                                  → v26.0.0   （非 .nvmrc 的 22.22.2 → T1 必须先做）
node NOE_CE12_P0_REQUIREMENTS_VERIFY.mjs → 60/60 PASS, EXIT=0
git rev-parse --show-toplevel            → /Users/hxx/Desktop/Neo 贾维斯
```
关键现状（决定排期顺序）：
- 旧 e2e `tests/e2e/noe-brain-ui.e2e.mjs` 现为 6 行 deprecated stub，转发到 `tests/e2e/noe-brain-ui-p0.e2e.mjs`（坏证据已治理 → T2 收口）。
- `package.json` 已有 `verify:node22 / verify:p0 / smoke:electron / package:node22 / test:p0:*`，证明 T1 gate 已成为统一入口包装层。
- `/api/noe/acts`、`/acts/propose`、`/acts/:id/cancel`、`/acts/:id/retry` 路由已存在（`src/server/routes/noe.js:178+`）→ T3/T4 数据面已通。

## 2. 执行队列（T0–T7）
| 顺序 | 任务 | P0 | 主交付文件 | 主责 / 复核 | 验证门 |
|---|---|---|---|---|---|
| T0 | CE04 排期落账 + 校验门 | FR-P0-6 | `NOE_CE12_P0_TASK_PLAN_Claude.md`、`NOE_CE12_P0_TASK_PLAN_VERIFY.mjs` | Claude 主 / GPT 复核 | 本文件 `wc -l`；`node NOE_CE12_P0_TASK_PLAN_VERIFY.mjs` 全绿 EXIT=0 |
| T1 | Node22 fail-fast / re-exec gate | FR-P0-1 | `scripts/ensure-node22.mjs`、`tests/unit/node22-gate.test.js` | GPT 主 / Claude 复核 | `node scripts/ensure-node22.mjs --require-22 --json`；<22 fail-fast，输出版本/ABI/.nvmrc/exit code |
| T2 | 旧 Brain UI e2e 修复/废弃 | FR-P0-2 | `tests/e2e/noe-brain-ui-p0.e2e.mjs`、旧 stub 转发、`scripts/e2e-with-server.mjs` | GPT 主 / Claude 复核 | `rg noe-brain-ui.e2e` 全部已处理；旧脚本不再作为通过证据 |
| T3 | 最小 Act Pipeline 数据面 | FR-P0-4 | `src/loop/ActPipeline.js`、`/api/noe/acts*`（`src/server/routes/noe.js`） | GPT 主 / Claude 复核 / M3 审硬风险 | 危险操作终态只能 `dry_run`/`awaiting_approval`/`blocked_safety`/`cancelled`，绝不真实外发/删除/批量移动 |
| T4 | Brain UI 执行可视化增强 | FR-P0-3 | `public/index.html`、`public/src/web/brain-ui.js`、`public/style.css` | GPT 主 / Claude 做 UI+证据复核 | 7 锚点 `#noeActQueue/#noeCurrentAct/#noeApprovalStatus/#noeToolPermissionStatus/#noeFailureReason/#noeBudgetStatus/#noeEvidenceLogLink` 可见 + 截图 |
| T5 | Electron smoke | FR-P0-5 | `scripts/electron-smoke.mjs`、`out-noe/` | GPT 主 / Claude 复核 | `npm run smoke:electron`；启动/退出/菜单注册/日志，exit code 0，不签名不公证 |
| T6 | MiniMaxSpawnAdapter patch-only | FR-P0-7 | `src/room/MiniMaxSpawnAdapter.js`、`tests/unit/minimax-spawn-adapter.test.js` | GPT 主 / M3 审中文侧 | 仅 session new/messages/diff；`diffs=[]` 才存建议；shell/write/delete/move/apply_patch → `blocked_safety`；fail-closed 不依赖 Mavis permission |
| T7 | 交付证据索引 + 状态闭环 | FR-P0-6 | `NOE_CE12_P0_EVIDENCE_INDEX.md` | GPT 主 / Claude 复核 | 每项 P0 有文件/命令/exit code/日志/截图；明确「阶段完成 ≠ 产品完成」 |

## 3. 依赖 DAG（串并行边界）
```
T0 ──► T1 ──┬─► T3 ──► T4 ─┐
            └─► T2          ├─► T5 ──► T7
                            ├─► T6 ────┘
```
- T1 是所有验证证据的前置（Node22 gate 不通，后续证据不可信）。
- T2 与 T3 可并行（互不依赖）；T4 依赖 T3（UI 渲染 act 数据面）。
- T5、T6 依赖 T3/T4 完成主体后并行；T7 收口，依赖 T1–T6 全部产出证据。

## 4. 排期检查点（CP0–CP4）
| 检查点 | 包含 | 完成条件 | 可推进 |
|---|---|---|---|
| CP0 | T0 | 排期稿 + VERIFY 全绿；需求 60/60；Node/e2e/UI 现状有命令证据 | CE05 |
| CP1 | T1+T2 | Node22 gate 生效；旧 e2e 不再作 known_bad pass | Act/UI 代码 |
| CP2 | T3+T4 | Act dry-run 与 Brain UI 执行可视化联通；DOM 锚点+截图存在 | Electron/MiniMax |
| CP3 | T5+T6 | Electron smoke 有日志/打包目录；MiniMax patch-only safety 单测通过 | 证据闭环 |
| CP4 | T7 | Evidence Index 汇总全部 P0 证据 | CE06–CE10 |

## 5. 角色 / 模型分工
- **GPT-Codex**：T1–T7 代码主责（原生可执行）。
- **Claude**：T0 主责（排期 + 校验门）；T1–T7 复核，T4 兼做 UI/证据复核（可执行）。
- **MiniMax M3**：审计辅助，仅审中文侧 + 硬风险；不直接写文件 / 跑 shell；只有 secret 泄露、路径/权限错误、原项目污染、数据破坏、不可逆操作、安全风险、明确事实错误可阻断；普通建议进 P2/P3。

## 6. 故障转移降级矩阵
| 场景 | 接管 | 风险 / 补审点 |
|---|---|---|
| Claude 掉线 | GPT-Codex + M3 一致即推进 | Claude 侧 UI/证据复核延后回补 |
| M3 掉线 | Claude + GPT-Codex 继续 | M3 中文侧审计记补审点，adapter 自带 patch-only guard 不依赖 Mavis |
| 仅剩 1 模型 | solo takeover，不停 | Evidence Index 写明降级原因/风险/补审点 |

## 7. 阻塞点
硬阻断：写入原项目 `/Users/hxx/Desktop/00_项目/05_Claude可视化面板`；secret 泄露 / 路径越权 / 数据破坏 / 不可逆删除移动 / 真实外发 / 安全风险 / 明确事实错误；Node22 gate 找不到可用 Node22 且关键验证无法 fail-fast；旧 e2e 继续被当通过证据。
不阻断但记录：M3 掉线或 CLI 找不到；Electron 菜单无法真实点击（降级为菜单已注册 + 启动/退出/日志）；命名/P2/P3 想法。

## 8. 验证命令清单（CE05 后每批最窄验证）
```bash
node scripts/ensure-node22.mjs --require-22 --json
node NOE_CE12_P0_REQUIREMENTS_VERIFY.mjs
node NOE_CE12_P0_TASK_PLAN_VERIFY.mjs
npm run test:p0:unit
npm run test:e2e          # 旧 e2e 已转发到 p0 版本
npm run smoke:electron
node scripts/ce12-p0-verify-all.mjs   # 或 --skip-e2e --skip-electron 快验
cat NOE_CE12_P0_EVIDENCE_INDEX.md
```

## 9. 11 阶段衔接
1 用户想法→Noe 主产品、完整 Jarvis 未完成、只做 P0；2 需求→canonical 60/60；3 技术方案→CE03 模块/状态机/回滚；**4 任务分配（本稿）→T0–T7 队列+DAG+CP+校验门**；5 代码→按 DAG 执行；6 单测→Node gate/ActPipeline/审批预算/MiniMax safety；7 集成→51835 启停、51735 零影响、acts API、Electron smoke；8 功能验证→Playwright 截图+DOM 断言；9 文档→Evidence Index/runbook，不写产品完成；10 验收→逐 P0 核命令/exit code/截图/日志；11 复盘→Node/坏证据/权限预算/Electron/M3 降级补审。

## 10. CE04 裁定（Claude）
同意推进 CE05。任务粒度已细到逐项可执行可验收，且本轮交叉校验确认 **T1–T7 每个任务都对应磁盘上真实存在的交付文件**（见 VERIFY 输出），证明排期粒度正确。未发现 secret / 路径污染 / 原项目写入 / 数据破坏 / 不可逆 / 安全硬阻断。第一批代码从 T1/T2 起，不跳 Voice/Social/完整 Jarvis。
