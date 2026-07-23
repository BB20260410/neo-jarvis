# Noe / Neo 贾维斯 CE12 P0 产品化返工需求拆解 CANONICAL

生成时间：2026-06-02
工作区：`/Users/hxx/Desktop/Neo 贾维斯`
阶段：2. 需求分析与拆解
Source of truth：本文件是 CE12 P0 产品化返工的唯一需求事实源。CE01-CE11 只能作为历史证据；当前只可表述为「Brain UI Lite 原型和复盘闭环已完成，完整 Jarvis 产品未完成」。

## 0. 最新裁定

- CE12 是旧项目 Noe / Neo 贾维斯的产品化返工，不是新建项目，不是形式复盘。
- 新增 P0 指示优先级高于旧路线；旧路线中的 Voice、Social I/O、完整 Jarvis 体验降为非目标或 P2 后续。
- 本轮只做 P0：Node22 fail-fast、旧 Brain UI e2e 处理、Brain UI 执行可视化、NoeLoop 最小 Act Pipeline、Electron smoke、交付状态闭环、MiniMaxSpawnAdapter patch-only 原型。
- 所有工作只在 `/Users/hxx/Desktop/Neo 贾维斯`；不得修改原项目 `/Users/hxx/Desktop/00_项目/05_Claude可视化面板`。
- BaiLongma 只作为审计与设计参考；不得全量复制进 Noe，不得未经审计接入真实工具执行。
- MiniMax M3 当前是中文侧审计辅助。MiniMax Code headless CLI 只能作为候选 patch-only 执行器；不得直接开放 shell/write/delete/move/apply_patch。

## 1. 明确非目标

| ID | 非目标 | 验收口径 |
|---|---|---|
| NG-1 | 不做 Voice、Social I/O、完整 Jarvis 全体验。 | CE12 文档、技术方案、排期中均标为 excluded 或 P2；代码阶段不得新增真实外发能力。 |
| NG-2 | 不批量移动、删除用户文件，不做不可逆操作。 | 单测或审计日志证明高危动作默认 approval_required 或 blocked_safety；交付报告列出未执行 destructive 命令。 |
| NG-3 | 不修改原项目目录。 | 所有新增/修改文件路径必须位于 Noe；验证报告不得出现对原项目的写入 diff。 |
| NG-4 | 不把 BaiLongma 整仓或未审计工具市场直接搬入 Noe。 | `BaiLongma-audit/` 只读；Noe 新代码必须是按需求重建的最小实现，不能整目录复制。 |
| NG-5 | 不把 MiniMax M3 当成同级本地执行成员。 | CE12 只允许 M3 输出审计意见或 patch plan；adapter 验收必须证明 `diffs=[]` 且不会执行 shell/write。 |

## 2. 用户需求

| ID | 优先级 | 需求 | 可验证验收口径 |
|---|---|---|---|
| UR-CE12-1 | P0 | 把 Noe 从可演示原型推进到可继续验收的产品化基础。 | 交付状态必须区分「阶段完成」和「产品完成」；不得宣称完整 Jarvis 已交付。 |
| UR-CE12-2 | P0 | P0 返工优先，不扩大范围。 | 需求、方案、任务排期只排 7 个 P0；Voice/Social/完整 Jarvis 全体验列入非目标或 P2。 |
| UR-CE12-3 | P0 | 所有结论必须有当前文件/命令/UI/日志证据。 | 每个 P0 交付项必须记录文件路径、命令、exit code、日志/截图/产物路径；坏证据只能标 known_bad/deprecated。 |
| UR-CE12-4 | P0 | Noe 与原项目隔离。 | 51835 启动验证不得影响 51735；所有写入文件位于 Noe 工作区。 |
| UR-CE12-5 | P0 | MiniMax M3 纳入协同，但先降权为 patch-only 审计/规划。 | MiniMaxSpawnAdapter 原型只读取 session messages 与 session diff；`diffs=[]` 才可把输出交给 Claude/GPT-Codex 执行。 |

## 3. 功能需求

| ID | 优先级 | 需求 | 可验证验收口径 | 依赖 |
|---|---|---|---|---|
| FR-P0-1 | P0 | Node22 fail-fast 与启动/依赖兼容风险处理。 | 核心 verify、smoke、e2e、package 入口在 Node 非 22 时 fail-fast 或显式调用 Node22；证据含 `node -v`、`process.versions.modules`、命令、exit code。 | 无 |
| FR-P0-2 | P0 | 修掉或废弃 `tests/e2e/noe-brain-ui.e2e.mjs`，不得继续引用已知坏证据。 | 二选一：修复后用受管 server 跑通并产出截图；或改为 deprecated/replace stub，所有验收文档不再把旧脚本当 pass 证据。 | FR-P0-1 |
| FR-P0-3 | P0 | Brain UI 执行可视化增强。 | UI 必须展示 act queue、当前 act、审批状态、工具权限状态、失败原因、成本/预算、可复现日志入口；Browser/Playwright 截图或 DOM 断言覆盖这些字段。 | FR-P0-1、FR-P0-4 |
| FR-P0-4 | P0 | NoeLoop 从 Lite tick 推进到最小 Act Pipeline。 | 覆盖 plan、propose、approval gate、dry-run execute、evidence、retry/cancel 状态；危险操作默认审批，不做真实外发/删除/批量移动。 | FR-P0-1 |
| FR-P0-5 | P0 | Electron smoke。 | 使用现有 `electron-builder` 做 Noe app 启动、退出、菜单、日志、打包目录 smoke；不做签名/公证；证据含命令、exit code、日志路径、打包目录。 | FR-P0-1 |
| FR-P0-6 | P0 | 交付状态闭环。 | 明确 source of truth 文件、运行命令、exit code、日志/截图/文件证据；阶段通过不得等同产品完成。 | FR-P0-1 至 FR-P0-5 |
| FR-P0-7 | P0 | MiniMaxSpawnAdapter patch-only 原型。 | 调用 `minimax session new` 创建 session，读取 `minimax session messages`，读取 `minimax session diff` 并验证 `diffs=[]`；若 M3 输出要求 shell/write/delete/move/apply_patch，adapter 必须返回 `blocked_safety`，只保存建议文本不执行。 | FR-P0-1、FR-P0-6 |

## 4. 非功能需求

| ID | 优先级 | 需求 | 可验证验收口径 |
|---|---|---|---|
| NFR-P0-1 | P0 | 路径安全：只在 Noe 工作区读写。 | 验证脚本检查 `process.cwd()`；交付报告列出写入文件均位于 Noe。 |
| NFR-P0-2 | P0 | 安全默认值：危险操作默认审批。 | 单测证明删除、外发、批量移动、高危 shell 无 approval 时不会执行，返回 approval_required、dry_run_blocked 或 blocked_safety。 |
| NFR-P0-3 | P0 | 成本安全：默认不烧模型额度。 | 单测/集成测试 mock budget preflight，证明默认 dry-run 不调用真实 LLM/API；预算超限展示到 UI。 |
| NFR-P0-4 | P0 | 证据卫生：坏证据不得复用。 | 全文检索 CE12 文档，不得把旧 e2e 写为 pass；旧证据只能标 known_bad、deprecated 或 replaced。 |
| NFR-P0-5 | P0 | 本地优先可观测性。 | 日志、trace、截图、打包产物均落在本地 `output/`、`logs/`、`out-noe/` 或明确路径；默认不上传外部遥测。 |
| NFR-P0-6 | P0 | MiniMax 权限边界不依赖 Mavis permission。 | adapter 自身强制 patch-only；即使 Mavis `permissionMode` 异常，也不得执行 M3 请求的 shell/write/delete/move。 |
| NFR-P0-7 | P0 | 协同降级不阻塞。 | Claude 不可用时 GPT-Codex + MiniMax M3 可推进；MiniMax M3 不可用或只能文本输出时记录补审点，不停止项目。 |

## 5. 证据要求

| P0 项 | 必须产出的证据 | 不合格证据 |
|---|---|---|
| FR-P0-1 | `.nvmrc`、`package.json engines.node`、Node22 gate 命令、exit code、Node ABI/modules。 | 只写「我认为 Node22 可用」。 |
| FR-P0-2 | `rg "noe-brain-ui.e2e"` 处理记录、修复/废弃后的脚本路径、运行命令、截图或替代证据。 | 继续引用 CE10/CE11 中已知坏 e2e 为通过证据。 |
| FR-P0-3 | UI 文件路径、DOM 锚点、Browser/Playwright 截图路径、字段断言输出。 | 只有文字描述「UI 已增强」。 |
| FR-P0-4 | `src/loop/NoeLoop.js` 或新模块路径、状态机单测、危险动作审批阻断测试、dry-run evidence 日志。 | 直接执行真实删除/外发/批量移动作为演示。 |
| FR-P0-5 | `npm run package` 或等价命令、`electron-builder --dir` 产物目录、Electron 启动/退出/menu/log smoke、exit code。 | 只说明 electron-builder 在依赖里。 |
| FR-P0-6 | canonical source of truth、命令清单、exit code、日志/截图/产物索引、阶段状态声明。 | 用三模型文本同意替代当前证据。 |
| FR-P0-7 | minimax 命令、sessionId、messages 摘要、`diffs=[]` 或 patch text、blocked_safety 样例、风险说明。 | 让 M3 直接写文件、跑 shell 或把 Mavis permission 当唯一安全边界。 |

## 6. 角色分工

| 角色 | 本阶段定位 | 可推进条件 |
|---|---|---|
| Claude | 代码/方案主审之一；可执行本地验证。 | Claude + GPT-Codex 一致且无硬风险即可推进。 |
| GPT-Codex | 本地文件、命令、验证、落地执行者之一。 | 与 Claude 一致即可推进；Claude 不可用时可与 MiniMax M3 或 solo takeover 推进并记录风险。 |
| MiniMax M3 | 中文侧审计辅助、产品判断、patch plan。 | 只有 secret 泄露、路径/权限错误、原项目污染、数据破坏、不可逆操作、安全风险、明确事实错误可阻断。 |
| MiniMax Code CLI | 候选 patch-only 原型执行器。 | 只允许创建/读取 session 与 diff；不得开放直接 shell/write。 |

## 7. 优先级和依赖

1. 先做 FR-P0-1：Node22 fail-fast 是所有后续命令证据的前置。
2. 再做 FR-P0-2：旧 e2e 不清理，UI 证据链不能可信。
3. 并行推进 FR-P0-3 与 FR-P0-4：Brain UI 必须可见地解释 Act Pipeline。
4. 完成 FR-P0-5：Electron smoke 只验证启动/退出/菜单/日志/打包目录，不进入签名/公证。
5. 同步完成 FR-P0-6：每个阶段都维护 source of truth 和证据索引。
6. 最后接入 FR-P0-7：MiniMaxSpawnAdapter 必须先 patch-only 稳定，再考虑后续受限 shell；本轮不得升级为同级开发成员。

## 8. 缺口问题

| ID | 缺口 | 是否阻断 CE02 | 关闭口径 |
|---|---|---|---|
| Q-P0-1 | 当前交互 shell 的实际 Node 版本可能不是 22。 | 不阻断需求阶段；阻断代码验证阶段。 | 技术方案固定 Node22 路径或 fail-fast/runbook，实测 `node -v` 与 ABI。 |
| Q-P0-2 | 旧 e2e 目前是否被 package scripts 或文档间接引用。 | 不阻断需求阶段；阻断 UI 验收阶段。 | `rg "noe-brain-ui.e2e"` 结果逐项处理，替换旧坏证据。 |
| Q-P0-3 | Act Pipeline 状态字段与现有 `NoeLoop.status()` 的兼容边界未定。 | 不阻断需求阶段。 | CE03 给状态机字段、API 响应、UI DOM 锚点和迁移策略。 |
| Q-P0-4 | Electron smoke 在无签名环境下的稳定启动方式未实测。 | 不阻断需求阶段；阻断 Electron 验收阶段。 | CE03 指定 `electron-builder --dir`、启动/退出/menu/log smoke 命令。 |
| Q-P0-5 | MiniMax CLI permission add 的 deny 规则显示/生效不稳定。 | 不阻断需求阶段；阻断直接执行权限升级。 | Adapter 自建 patch-only guard；`diffs=[]` 与 blocked_safety 单测/集成证据。 |

## 9. CE03 技术方案输入

- Node22：设计 `scripts/ensure-node22` 或等价 gate，覆盖 `npm start`、verify、e2e、package。
- 旧 e2e：裁定修复 `tests/e2e/noe-brain-ui.e2e.mjs` 或替换为 `deprecated` stub，并更新 `package.json` / 文档引用。
- Brain UI：在 `public/src/web/brain-ui.js` 与对应 HTML/CSS 中定义 act queue、approval、permission、failure、budget、log link 的稳定 DOM ID。
- Act Pipeline：在 `src/loop/NoeLoop.js` 或新 `src/loop/ActPipeline.js` 中定义 plan/propose/approval/dry-run/evidence/retry/cancel 状态机。
- Electron smoke：基于 `scripts/package-electron.mjs` 和 `electron-main.js` 设计启动、退出、菜单、日志、打包目录 smoke。
- MiniMaxSpawnAdapter：设计 `src/room/MiniMaxSpawnAdapter.js` 或等价模块，封装 `minimax session new/messages/diff`，强制 patch-only 和 blocked_safety。
- 证据闭环：定义 CE12 证据索引文件、命令清单、exit code、截图/日志/产物路径。

## 10. 工程闭环 11 阶段落地

1. 用户想法：继承 CE01，Noe 是主产品；完整 Jarvis 未完成。
2. 需求分析与拆解：本文件完成 P0 需求、非目标、验收条件、证据要求、角色分工、依赖、缺口。
3. 技术方案设计：下一阶段必须把 7 个 P0 映射到模块、状态机、命令、测试和回滚策略。
4. 任务分配与排期：只排 P0；Voice/Social/完整 Jarvis 全体验不进入本轮排期。
5. 代码开发：优先落 Node22 gate、旧 e2e 处理、Act Pipeline dry-run、Brain UI 可视化、Electron smoke、MiniMax patch-only。
6. 单元测试：覆盖 Node22 gate、Act Pipeline、审批默认阻断、预算默认安全、MiniMax blocked_safety。
7. 集成测试：覆盖 51835 启停、51735 零影响、owner-token、UI 数据源、日志路径、MiniMax `diffs=[]`。
8. 功能验证：用浏览器截图/DOM 证明 act queue、审批、权限、失败原因、成本/预算和日志入口可见。
9. 文档编写：更新 CE12 source of truth、运行命令、证据索引、交接文件。
10. 交付验收：所有 P0 项都有当前命令、exit code、日志/截图/文件证据；只允许说「产品化基础可继续验收」。
11. 复盘优化：记录 Node/runtime、坏证据、UI 证据链、Electron smoke、MiniMax 权限、协同降级的改进项。

## 11. 本阶段验收命令

```bash
pwd
node -v
node -p "process.versions.modules"
node NOE_CE12_P0_REQUIREMENTS_VERIFY.mjs
rg -n "FR-P0-7|MiniMaxSpawnAdapter|patch-only|blocked_safety|diffs=\\[\\]|Voice/Social|完整 Jarvis 产品未完成" NOE_CE12_P0_REQUIREMENTS_CANONICAL.md
wc -l NOE_CE12_P0_REQUIREMENTS_CANONICAL.md NOE_CE12_P0_REQUIREMENTS_VERIFY.mjs
```

阶段 2 裁定：CE12 P0 需求拆解可推进到 CE03「技术方案设计」。当前没有可复验证硬阻断；普通优化建议进入后续清单，不能阻塞阶段切换。
