# CE12 P0 文档事实源 - Noe / Neo 贾维斯

更新时间：2026-06-02
工作区：`/Users/hxx/Desktop/Neo 贾维斯`
当前阶段：CE12 P0 已验收，进入 P1 产品化收敛
事实源：本文件是 CE12 P0 产品化返工后的文档入口；旧 `NOE_PHASE9_DOCS_CANONICAL.md` 仅保留为历史阶段文档。

## 0. 当前裁定

- Noe + BaiLongma 融合路线仍成立：Noe 做主产品底座，吸收 BaiLongma 的 TICK loop、Memory、Focus Stack、Brain UI、Voice、Social I/O 和工具市场思路。
- CE12 P0 已完成产品化基础验收：Node22 gate、旧 e2e 替换、Brain UI 执行可视化、最小 Act Pipeline、Electron smoke、证据闭环都已有代码和命令证据。
- 完整 Jarvis 产品未完成。Voice、Social I/O、完整 Jarvis 体验、真实工具外发/删除/批量移动不在本轮 P0。
- 当前文档阶段完成门槛：下一位执行者先读本文件、操作手册、交接文件和证据索引即可继续，不需要重新猜测上下文。

## 1. 硬边界

- 只在 `/Users/hxx/Desktop/Neo 贾维斯` 工作。
- 不在 `/Users/hxx/Desktop/00_项目/05_Claude可视化面板` 开发。
- 不把 `BaiLongma-audit/` 全量复制进 Noe。
- 不接入未经审计的真实工具执行能力。
- 危险操作默认进入审批或 `blocked_safety`，不能真实外发、删除或批量移动。
- MiniMax M3 suggestion-only：M3 只接收精选上下文并给建议/patch plan，不获得本地 shell、read、write、apply_patch、delete、move 权限；只有 secret 泄露、路径/权限错误、原项目污染、数据破坏、不可逆操作、安全风险或明确事实错误才阻断。

## 2. Source Of Truth 读序

1. `NOE_CE12_P0_DOCS_CANONICAL.md` - 当前文档事实源。
2. `NOE_CE12_P0_OPERATIONS_MANUAL.md` - 日常启动、验证、排障。
3. `NOE_CE12_P0_HANDOFF.md` - 下一窗口交接和 copy-paste prompt。
4. `NOE_CE12_P0_EVIDENCE_INDEX.md` - 文件路径、命令、exit code、日志/截图证据。
5. `NOE_CE12_P0_RETROSPECTIVE_CANONICAL.md` - 复盘事实源。
6. `NOE_M3_SUGGESTION_ONLY.md` - M3 suggestion-only 边界。
7. `NOE_PRODUCT_NEXT_PLAN.md` - 后续路线。
8. `NOE_CE12_P0_REQUIREMENTS_CANONICAL.md` - CE12 P0 需求事实源。
9. `NOE_CE12_P0_TECH_DESIGN_GPT.md` 与 `NOE_CE12_P0_技术方案_设计_Claude.md` - 技术设计参考。
10. `package.json` - 当前 npm 入口。

## 3. 快速启动

```bash
cd "/Users/hxx/Desktop/Neo 贾维斯"
npm install
npm run verify:node22
npm run start:noe
```

- Noe 默认端口：`http://127.0.0.1:51835`
- 原项目端口：`http://127.0.0.1:51735`
- owner token：`~/.noe-panel/owner-token.txt`
- 浏览器入口：`http://127.0.0.1:51835/?t=<owner-token>`

如果 51835 已被占用，先确认是不是 Noe 自己的进程。不要杀 51735 的原项目进程。

## 4. 用户主路径

1. 打开 `http://127.0.0.1:51835/?t=<owner-token>`。
2. 点击顶栏 Brain 按钮 `#btnNoeBrain`。
3. 确认 Brain UI 面板 `#noeBrainArea` 展开。
4. 写入 Memory，再按关键词召回。
5. 推入 Focus，再 pop 并吸收为记忆。
6. 点击 Act Tick 或调用 `/api/noe/acts/propose`。
7. 确认 Brain UI 显示：
   - `#noeActQueue`
   - `#noeCurrentAct`
   - `#noeApprovalStatus`
   - `#noeToolPermissionStatus`
   - `#noeFailureReason`
   - `#noeBudgetStatus`
   - `#noeEvidenceLogLink`
8. 低风险 act 应是 dry-run completed；高风险 act 应进入 awaiting approval；危险 act 应是 `blocked_safety`。

## 5. 维护命令

```bash
npm run verify:p0:docs
npm run verify:p0:fast
npm run verify:p0
npm run test:p0:unit
npm run test:p0:integration
npm run test:p0:funcverify
npm run test:file-index
npm run test:memory-m1
npm run m3:suggest
npm run test:e2e:p0
npm run smoke:electron
```

- `verify:p0:docs`：只检查 CE12 文档入口和关键锚点。
- `verify:p0:fast`：跳过 Electron 和浏览器 e2e，仍跑需求、Node22、P0 单测、Act evidence、集成门。
- `verify:p0`：7 个 P0 门全量聚合。
- `test:p0:funcverify`：真实 51835 主路径验证，要求原项目 51735 预先运行；用于证明 Noe 不影响原项目。

## 6. API 端点

全部 `/api/noe/*` 端点都需要 `X-Panel-Owner-Token`。

机器可读端点清单：

```text
GET /api/noe/loop/status
POST /api/noe/loop/start
POST /api/noe/loop/stop
POST /api/noe/loop/pause
POST /api/noe/loop/resume
POST /api/noe/loop/tick
GET /api/noe/memory
POST /api/noe/memory
DELETE /api/noe/memory/:id
POST /api/noe/memory/:id/merge
GET /api/noe/focus
POST /api/noe/focus
POST /api/noe/focus/:id/pop
GET /api/noe/tools
POST /api/noe/tools
POST /api/noe/tools/:id/enable
POST /api/noe/tools/:id/invoke
GET /api/noe/approvals
GET /api/noe/acts
POST /api/noe/acts/propose
POST /api/noe/acts/:id/cancel
POST /api/noe/acts/:id/retry
POST /api/noe/m3/suggest
GET /api/noe/files/index
POST /api/noe/files/index
GET /api/noe/files/search
GET /api/noe/health
```

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/noe/loop/status` | 读取 NoeLoop 状态 |
| POST | `/api/noe/loop/start` | 启动 loop |
| POST | `/api/noe/loop/stop` | 停止 loop |
| POST | `/api/noe/loop/pause` | 暂停 loop |
| POST | `/api/noe/loop/resume` | 恢复 loop |
| POST | `/api/noe/loop/tick` | 手动 tick |
| GET | `/api/noe/memory` | 召回记忆 |
| POST | `/api/noe/memory` | 写入记忆 |
| DELETE | `/api/noe/memory/:id` | 软隐藏记忆 |
| POST | `/api/noe/memory/:id/merge` | Memory M1 合并记忆，记录 merge trace 并软隐藏来源 |
| GET | `/api/noe/focus` | 列焦点栈 |
| POST | `/api/noe/focus` | 推入焦点 |
| POST | `/api/noe/focus/:id/pop` | 弹出焦点，可吸收为记忆 |
| GET | `/api/noe/tools` | 列工具 manifest |
| POST | `/api/noe/tools` | 注册工具 manifest |
| POST | `/api/noe/tools/:id/enable` | 启用或停用工具 |
| POST | `/api/noe/tools/:id/invoke` | 调用工具，经权限和审批 |
| GET | `/api/noe/approvals` | 列待审批 |
| GET | `/api/noe/acts` | 列 act queue |
| POST | `/api/noe/acts/propose` | 提出 act，默认 dry-run/safety gated |
| POST | `/api/noe/acts/:id/cancel` | 取消 act |
| POST | `/api/noe/acts/:id/retry` | 重试 failed/cancelled/blocked_safety act |
| POST | `/api/noe/m3/suggest` | 内部 M3 suggestion-only 建议接口，不授予本地工具权限 |
| GET | `/api/noe/files/index` | 读取只读文件索引状态 |
| POST | `/api/noe/files/index` | 建立本地只读文件索引，默认限制在工作区内 |
| GET | `/api/noe/files/search` | 搜索已建立的只读文件索引 |
| GET | `/api/noe/health` | 聚合 health、memory、focus、tools、approvals、acts |

## 7. 代码地图

| 能力 | 文件 |
|---|---|
| Node22 gate | `scripts/ensure-node22.mjs` |
| P0 聚合验证 | `scripts/ce12-p0-verify-all.mjs` |
| CE08 主路径验证 | `scripts/ce12-p0-ce08-funcverify.mjs` |
| Memory M1 Core | `src/memory/MemoryCore.js` |
| 只读文件索引 | `src/memory/FileIndex.js` |
| Focus Stack | `src/memory/FocusStack.js` |
| NoeLoop | `src/loop/NoeLoop.js` |
| Act Pipeline | `src/loop/ActPipeline.js` |
| Act Store | `src/loop/ActStore.js` |
| Tool Registry | `src/capabilities/ToolRegistry.js` |
| Noe API | `src/server/routes/noe.js` |
| Brain UI | `public/index.html`、`public/src/web/brain-ui.js`、`public/style.css` |
| M3 suggestion-only | `src/room/MiniMaxSuggestionRouter.js`、`src/room/MiniMaxSuggestionPipeline.js`、`scripts/m3-suggest.mjs` |
| MiniMax 本地执行器守卫 | `src/room/MiniMaxSpawnAdapter.js` |
| Electron smoke | `scripts/electron-smoke.mjs`、`electron-main.js` |

## 8. 已知限制

- 完整 Jarvis 产品未完成；CE12 P0 只证明产品化基础可继续验收。
- Voice、Social I/O、完整 Jarvis 体验仍是后续路线。
- M3 当前是 suggestion-only；Mavis/OpenCode 本地执行器永久禁用。未来若需要真实执行权限，必须另起非 M3 执行器安全设计，不能通过环境变量临时打开。
- Browser in-app 插件在本轮运行时不可用，前端 UI 证据降级为项目 Playwright e2e。
- `verify:p0:fast` 会跳过 Electron 和浏览器 e2e；验收不能只看 fast。
- `scripts/ce12-p0-verify-all.mjs` 会分离 `p0-verify-all-full-latest.json`、`p0-verify-all-fast-latest.json` 和 `p0-verify-all-partial-latest.json`；旧 `p0-verify-all-latest.json` 只由 full 覆盖。
- Electron 只做 smoke，不做签名、公证或正式 DMG。
- Node26 可以作为外层 runner，但 ABI 相关任务必须经 `ensure-node22 --require-22 --exec` 切到 Node `22.22.2`。
- 裸 `vitest run` 在 Node26 下可能因 native module ABI 报错；认可入口是 `npm test` 或 `npm run test:p0:unit`。

## 9. 变更摘要

- 新增 Node22 fail-fast/re-exec gate，解决 native module ABI 证据不一致。
- 旧 `tests/e2e/noe-brain-ui.e2e.mjs` 改为 deprecated 转发，不再作为 known-bad 证据。
- Brain UI 增加 act queue、当前 act、审批、工具权限、失败原因、预算、日志入口。
- NoeLoop 接入最小 Act Pipeline，低风险 dry-run、高风险审批、危险操作 `blocked_safety`。
- 新增 Electron smoke，覆盖 app ready、menu registered、server ready、window loaded、quit。
- 新增 P0 聚合验证、集成测试、功能验证和证据索引。
- 新增 MiniMaxSpawnAdapter patch-only 守卫，非空 diff 或危险动作 fail-closed。
- 新增 M3 suggestion-only pipeline 和内部 endpoint：M3 可做建议、缺口扫描、patch plan，但不直接执行。
- 新增 Memory M1 元数据：confidence、TTL/expiry、merge trace、hide reason。
- 新增本地只读文件索引：默认只索引工作区内文本文件，不写入、删除或移动用户文件。

## 10. 工程闭环衔接

1. 用户想法：Noe 是新产品底座，不是原 Xike Lab。
2. 需求分析与拆解：7 个 CE12 P0 已收敛到 `NOE_CE12_P0_REQUIREMENTS_CANONICAL.md`。
3. 技术方案设计：模块、状态机、接口、回滚策略已落地到 CE03 文档。
4. 任务分配与排期：T0-T7 P0 队列已落地。
5. 代码开发：P0 源码和聚合器已落盘。
6. 单元测试：P0 单测入口 `npm run test:p0:unit`。
7. 集成测试：真实 server/API/storage 链路入口 `npm run test:p0:integration`。
8. 功能验证：真实 51835 用户主路径入口 `npm run test:p0:funcverify`。
9. 文档编写：本文件、操作手册、交接文件、README、CHANGELOG、证据索引。
10. 交付验收：优先跑 `npm run verify:p0:docs` 和 `npm run verify:p0`，再人工核对证据路径。
11. 复盘优化：处理 MiniMax 补审、Browser/iab、签名公证、Voice/Social/Jarvis 完整体验。

## 11. 下一步

- P1 当前优先级：README/handoff/evidence/acceptance/retrospective 入口收敛；M3 suggestion endpoint；full/fast evidence latest 分离；Memory M1；本地文件只读索引。
- P1/P2 路线：Memory 语义召回、Brain UI 完整任务链、受审计工具 handler、Voice、Social I/O、Jarvis 体验。
