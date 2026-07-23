# CE12 P0 需求拆解 — Claude 成员独立稿（实测证据版）

生成时间：2026-06-02
工作区：`/Users/hxx/Desktop/Neo 贾维斯`
阶段：2. 需求分析与拆解（CE02，第 1/3 轮）
成员：🟣 Claude（集群对等成员，非 boss/worker）

> **事实源声明（避免 CE01 竞争稿反模式）：** 本文件**不是**第二份 canonical，**不替代** `NOE_CE12_P0_REQUIREMENTS_CANONICAL.md`。
> 唯一需求事实源仍是 `NOE_CE12_P0_REQUIREMENTS_CANONICAL.md`。本文件是 Claude 的独立拆解视角 + 对每条需求的**当前可复现实测证据**，用于把 canonical 里几个「待确认」缺口问题从问句升级为**已确认事实**，并给出 CE02 裁定。

## 0. 与 canonical 的收敛确认

- 实跑 `node NOE_CE12_P0_REQUIREMENTS_VERIFY.mjs` → **60/60 PASS, EXIT=0**（见 §2 证据 E0）。
- canonical 已含 7 个 P0（FR-P0-1..7）、5 条非目标（NG-1..5）、7 条 NFR、证据要求、角色分工、CE03 输入。
- 我独立推导的 P0 范围与 canonical **完全一致**，无新增竞争目标、无范围漂移。结论：收敛通过。
- 并发观察：CE02 期间 canonical 与 verify 由并发成员（GPT-Codex）实时补全（11:03–11:04 两文件 mtime 相邻刷新）。我未覆盖该实时编辑，仅做只读复核 + 证据补强。

## 1. 独立 P0 需求清单（与 canonical 同口径，按可验证验收重述）

| ID | 需求 | 我的可验证验收口径（落到具体命令/文件/字段） |
|---|---|---|
| FR-P0-1 | Node22 fail-fast 与启动/依赖兼容 | 新增统一 gate（如 `scripts/ensure-node22.mjs`），被 `npm start` / verify / e2e / package 入口调用；Node 主版本 ≠22 时非 0 退出并打印安装指引。证据＝`node -v` + `process.versions.modules` + 各入口 exit code。 |
| FR-P0-2 | 处理坏 e2e `tests/e2e/noe-brain-ui.e2e.mjs` | 修复后由受管 server 跑通出截图，**或**降级为 deprecated/replaced stub；并改掉 `scripts/e2e-with-server.mjs:135` 的活引用（见 E2，这是真活引用不是死代码）。验收文档不得再把旧脚本当 pass。 |
| FR-P0-3 | Brain UI 执行可视化增强 | `public/index.html` + `public/src/web/brain-ui.js` 新增稳定 DOM ID：act queue、当前 act、审批状态、工具权限状态、失败原因、成本/预算、可复现日志入口。证据＝Playwright/Browser 截图 + DOM 文本断言覆盖全部 7 字段。 |
| FR-P0-4 | NoeLoop → 最小 Act Pipeline | 在 `src/loop/NoeLoop.js`（现仅 tick+可选 actHandler，见 E4）或新 `src/loop/ActPipeline.js` 落 plan→propose→approval gate→dry-run→evidence→retry/cancel 状态机；危险动作默认 approval_required / blocked_safety，**不做真实外发/删除/批量移动**。证据＝状态机单测 + 审批默认阻断单测。 |
| FR-P0-5 | Electron smoke | 用现有 `electron-builder@^26.8.1`（E5）+ `scripts/package-electron.mjs` + `electron-main.js` 做启动/退出/菜单/日志/打包目录 smoke；**不签名/不公证**。证据＝命令 + exit code + 日志路径 + `--dir` 打包目录。 |
| FR-P0-6 | 交付状态闭环 | 明确 source of truth＝canonical；每个 P0 给命令清单、exit code、日志/截图/产物索引；交付措辞只能写「产品化基础可继续验收」，禁写「完整 Jarvis 已完成」。 |
| FR-P0-7 | MiniMaxSpawnAdapter patch-only 原型 | 新 `src/room/MiniMaxSpawnAdapter.js`（区别于已存在的 chat 适配器 `MiniMaxChatAdapter.js`，见 E7）：封装 `minimax session new/messages/diff`，强制读取 `diffs=[]` 才放行 patch text 给 Claude/GPT-Codex；M3 若要求 shell/write/delete/move/apply_patch → 返回 `blocked_safety` 仅存建议文本。adapter 自带 guard，**不依赖 Mavis permission 作唯一边界**。证据＝命令 + sessionId + messages 摘要 + `diffs=[]` + blocked_safety 样例。 |

非目标（继承 NG-1..5，不重复展开）：Voice/Social/完整 Jarvis 全体验、批量移动/删除、改原项目、整仓搬 BaiLongma、把 M3 当同级本地执行成员。

## 2. 实测现状证据快照（CE02 round-1，命令 + 真实输出）

> 所有命令在 `/Users/hxx/Desktop/Neo 贾维斯` 下实跑。这是把 canonical「验收口径」锚到当前真实代码的硬证据。

**E0 — 需求合约 verify（canonical 自洽）**
```
$ node NOE_CE12_P0_REQUIREMENTS_VERIFY.mjs
Result: 60/60 checks passed   # EXIT=0
```

**E1 — Node/运行时现状（FR-P0-1 缺口属实）**
```
$ node -v            -> v26.0.0      # 当前交互 shell 默认是 Node 26，非 22
$ cat .nvmrc         -> 22.22.2      # 已有 pin
$ package.json engines.node -> ">=22"
# 但：grep ensure-node22 / node-version-gate / requireNode22 → 仅 e2e-with-server.mjs 局部处理
# 结论：无统一 fail-fast gate 覆盖 npm start / verify / package（FR-P0-1 待实现）
```

**E2 — 坏 e2e 是「活引用」不是死代码（Q-P0-2 升级为已确认）**
```
$ grep -n "noe-brain-ui.e2e.mjs" scripts/e2e-with-server.mjs
135:    const e2e = spawnSync(node22, ['tests/e2e/noe-brain-ui.e2e.mjs'], {
# npm run test:e2e → scripts/e2e-with-server.mjs → 第135行直接 spawn 坏脚本
# 故 FR-P0-2 必须同时改 package 入口链，不能只动测试文件本身
```

**E4 — NoeLoop 当前是 tick+可选 actHandler 骨架（FR-P0-4 缺口属实）**
```
$ grep -nE "actMode|actHandler|tickHandler|status" src/loop/NoeLoop.js   (243 行)
# 有 actMode/actHandler/tickHandler 与 status()；无 plan/propose/approval/dry-run/retry/cancel 状态机
# Act Pipeline 需在此之上新建，不是从零
```

**E4b — 审批地基已存在（降低 FR-P0-4 实现风险）**
```
$ grep -nE "approval|loop/tick" src/server/routes/noe.js
49:  app.post('/api/noe/loop/tick' ...)
163: app.get('/api/noe/approvals' ...)   # 已有 approvalStore + /api/noe/approvals
```

**E3 — Brain UI 现有/缺失字段（FR-P0-3 缺口属实）**
```
$ grep -n "noeBrainArea|btnNoeLoopTick|noeThoughtStream|noeToolsList|noeApprovalsList" public/index.html
# 已有：思维流、工具列表、审批列表、Tick 按钮
# 缺：act queue / 当前act / 工具权限状态 / 失败原因 / 成本预算 / 可复现日志入口（grep actQueue/budget/cost 全空）
```

**E5 — Electron smoke 物料齐备（FR-P0-5 可落地）**
```
$ electron-builder -> ^26.8.1 ; electron -> ^37.10.3
$ ls electron-main.js scripts/package-electron.mjs   # 均存在
```

**E7 — MiniMax 现状：chat 已接、spawn 未建、CLI 真实（FR-P0-7 落点确认）**
```
$ ls src/room/*Adapter*.js
  ClaudeSpawnAdapter.js  CodexSpawnAdapter.js  GeminiSpawnAdapter.js  MiniMaxChatAdapter.js  ...
  # 有 MiniMaxChatAdapter（M3=chat），无 MiniMaxSpawnAdapter；可仿 Codex/ClaudeSpawnAdapter 范式
$ ls -la /Users/hxx/.mavis/bin/minimax
  ... -> /Applications/MiniMax Code.app/Contents/Resources/resources/daemon/cli.js   # CLI 真实存在
```

## 3. 缺口问题：用实测把 canonical 的 Q 升级

| ID | canonical 原状态 | Claude 实测结论 |
|---|---|---|
| Q-P0-1 | shell 实际 Node 可能非 22 | **已确认**：当前 `node -v=v26.0.0`，`.nvmrc=22.22.2` 已 pin，但无统一 gate → CE03 必须给 `ensure-node22` 并接到 start/verify/package。 |
| Q-P0-2 | 旧 e2e 是否被 scripts 间接引用 | **已确认引用**：`scripts/e2e-with-server.mjs:135` 活 spawn；FR-P0-2 范围须含入口链改造，非仅改测试文件。 |
| Q-P0-3 | Act Pipeline 与 `NoeLoop.status()` 兼容边界 | **部分关闭**：NoeLoop 已有 status()/actMode/actHandler 与 `/api/noe/approvals` 审批地基；CE03 只需定义新状态字段与现有 status() 的并集映射。 |
| Q-P0-4 | Electron 无签名稳定启动方式 | **物料确认**：electron-builder/electron/package-electron.mjs 齐备；启动稳定性仍需 CE05 实测（保持为阻断 Electron 验收阶段，不阻断 CE02）。 |
| Q-P0-5 | Mavis permission deny 不稳定 | **维持硬约束**：adapter 必须自建 patch-only guard，`diffs=[]`+blocked_safety 双证据；不得把 Mavis permission 当唯一边界（与 NFR-P0-6 一致）。 |

## 4. CE03 技术方案输入（Claude 补充，叠加 canonical §9）

1. `ensure-node22` gate 建议放 `scripts/ensure-node22.mjs`，在 `package.json` 的 `start` / `verify:*` / `package` 前置 `node scripts/ensure-node22.mjs &&`；主版本判定用 `process.versions.node.split('.')[0]`。
2. FR-P0-2 优先「修复」而非「废弃」——脚本本身选择器/逻辑可用（用 playwright core 而非 @playwright/test），主要坏点是历史依赖与 Node 路径；修复后 `e2e-with-server.mjs:135` 引用即可复用，证据链最省。若 CE03 评估修复成本高再降级 stub。
3. FR-P0-4 复用 `approvalStore` + `/api/noe/approvals`，新状态机只增不改既有 tick 契约，避免破坏 `NoeLoop.status()` 现有消费者。
4. FR-P0-7 patch-only adapter 仿 `CodexSpawnAdapter.js` 结构，但**禁用任何 exec/write 分支**，只暴露 `planPatch()` 返回 `{ sessionId, messages, diffs, blocked_safety }`。

## 5. CE02 裁定（Claude）

- **同意推进到 CE03（技术方案设计）。**
- 依据：canonical verify 60/60 全绿；7 个 P0 均有可验证验收口径并已被我实测锚到真实代码；无 secret 泄露 / 路径错误 / 原项目污染 / 数据破坏 / 不可逆操作 / 安全风险 / 事实错误等硬阻断。
- 我未对原项目 `/Users/hxx/Desktop/00_项目/05_Claude可视化面板` 做任何读写；本文件与所有命令均落在 Noe 工作区（满足 NFR-P0-1 / NG-3）。
- 后续补审点：Electron 无签名启动稳定性（CE05 实测）、坏 e2e 修复 vs 废弃的成本裁定（CE03）。
