# CE12 P0 操作手册 · 维护说明 · 已知限制 · 交接信息 — Claude 成员独立稿

> 阶段：CE12 ⑨ 文档编写（工程闭环第 9 阶段）
> 工作区：`/Users/hxx/Desktop/Neo 贾维斯`（仅在此目录工作，原项目 `/Users/hxx/Desktop/00_项目/05_Claude可视化面板` 零触碰）
> 成稿：Claude 成员，2026-06-02
> 实跑基线：`npm run verify:p0:fast` → **5/5 门通过（跳过 2），EXIT=0**，证据 `output/ce12-p0/p0-verify-all-1780385311193.json`（runner v26.0.0/ABI147，ABI 子任务 re-exec 到 v22.22.2/ABI127）

## 0. 事实源声明（避免 CE01 竞争稿反模式）

本文件**不是新的 canonical，不替代**任何既有事实源。它只是把已分散在多份文档里的「怎么跑 / 怎么维护 / 有哪些坑 / 下一个人接什么」收敛成一页可直接照着做的操作手册。

| 角色 | 文件 | 说明 |
|---|---|---|
| 需求事实源 | `NOE_CE12_P0_REQUIREMENTS_CANONICAL.md` | 7 个 P0 + 非目标 + 验收口径（verify 60/60） |
| 证据事实源 | `NOE_CE12_P0_EVIDENCE_INDEX.md` | 每个 P0 的「文件+命令+退出码+证据位置」闭环 |
| Node 运行时说明 | `NOE_NODE_VERSION_RUNBOOK.md` / `NODE_RUNTIME_NOTE.md` | Node22/26 双运行时与 ABI 切换 |
| 本文件（操作/维护/限制/交接） | `NOE_CE12_P0_DOCS_OPERATIONS_Claude.md` | 面向下一位执行者的上手与维护手册 |

**口径红线（继承 CE05–CE08）：** 当前状态是「CE12 P0 产品化基础可继续验收」，**不是**完整 Jarvis 产品完成。Voice / Social / 完整 Jarvis 全体验**不在** CE12 范围内。`stage_done ≠ product_done`。

---

## 1. 使用说明（5 分钟上手）

### 1.1 一键验收（推荐入口）

```bash
cd "/Users/hxx/Desktop/Neo 贾维斯"
npm run verify:p0          # 跑全部 7 个 P0 门（含 e2e + electron），单一退出码 0=全过
npm run verify:p0:fast     # 跳过浏览器 e2e / electron，仍保留 Node22 gate + 单测 + Act 运行时 + API 集成
```

- runner 可在本机当前 Node v26 下直接跑：聚合器 `scripts/ce12-p0-verify-all.mjs` 自身不 `require` better-sqlite3，所有需要原生扩展的 ABI 子任务都经 `ensure-node22 --require-22 --exec` re-exec 到 pinned Node22，绕开 [[ce12-p0-loop-rootcause]] 记录的 ABI 崩溃。
- 机器可读汇总固定写到 `output/ce12-p0/p0-verify-all-latest.json`，每门含 `status / exitCode / marker`。

### 1.2 单项命令对照表（均经 Node22 gate，可在 Node26 shell 直接调）

| 你想做什么 | 命令 | 期望结果 |
|---|---|---|
| 确认 Node22 可用 | `npm run verify:node22` | EXIT=0，`selected=v22.22.2 ABI127` |
| 跑 P0 单元测试 | `npm run test:p0:unit` | 8 files / 40 tests passed |
| 跑全量单测 | `npm test` | 全绿（经 gate re-exec，裸 vitest 在 Node26 会因 ABI 崩溃，属预期） |
| 跑 P0 集成测试 | `npm run test:p0:integration` | 18/18 checks passed |
| 跑 Brain UI e2e | `npm run test:e2e:p0` | 17/17 checks passed + 截图 `output/playwright/` |
| 跑 Act 数据流证据 | `npm run verify:p0:fast` 内含 | 三终态 + `noRealExecution=true` |
| Electron 启停 smoke | `npm run smoke:electron` | PASS，日志 `output/electron-smoke/` |
| 打包（不签名公证） | `npm run package:node22` | 产物 `out-noe/mac-arm64/Noe.app` |
| 真实端口用户主路径走查 | `npm run test:p0:funcverify` | 14/14（**前置**：原项目 51735 需在跑） |

### 1.3 正常启动（开发态）

```bash
npm start            # 起 server，端口 51835，仅 127.0.0.1（详见 CLAUDE.md / README.md）
npm run electron     # 包成桌面 app 跑
```

> 注：`npm start` 在 Node26 下只 warn 不夺走用户在用的 Node，原因见 §3.1。验收类命令则强制走 Node22 gate。

---

## 2. 维护说明（改哪个文件 / 怎么扩展）

### 2.1 CE12 P0 七个交付物的代码落点

| P0 | 模块/文件 | 行数 | 维护要点 |
|---|---|---|---|
| FR-P0-1 Node22 gate | `scripts/ensure-node22.mjs` | 260 | CLI 探测顺序 `NOE_NODE_BIN → .nvmrc 对应路径 → PATH`；改 nvm 布局后先验 `verify:node22` |
| FR-P0-2 旧 e2e 处理 | `scripts/e2e-with-server.mjs`、`tests/e2e/noe-brain-ui-p0.e2e.mjs`、`tests/e2e/noe-brain-ui.e2e.mjs`(deprecated 转发) | — | 旧脚本已转发到 P0 版，**不要**再把 known_bad 当通过证据 |
| FR-P0-3 Brain UI 可视化 | `public/index.html`、`public/src/web/brain-ui.js`、`public/style.css` | — | 7 个稳定 DOM 锚点见 §2.2，e2e 依赖它们，**改名先改 e2e** |
| FR-P0-4 Act Pipeline | `src/loop/ActPipeline.js`(322) + `src/loop/ActStore.js`(205) + `src/server/routes/noe.js` | — | 状态机见 §2.3；危险操作分级是安全不变量，**改前先读 §2.3** |
| FR-P0-5 Electron smoke | `scripts/electron-smoke.mjs` | 166 | 复用 `package-electron.mjs --mac --dir` → `out-noe/`；不签名不公证 |
| FR-P0-6 交付证据闭环 | `scripts/ce12-p0-verify-all.mjs`(230)、`NOE_CE12_P0_EVIDENCE_INDEX.md` | — | 新增 P0 门在聚合器里加一项，并刷新证据索引 |
| FR-P0-7 MiniMax patch-only | `src/room/MiniMaxSpawnAdapter.js` | 346 | fail-closed：任何 shell/write/delete/move/apply_patch 或 diff 非空即 `blocked_safety` |

聚合/集成/功能验证脚本：`scripts/ce12-p0-verify-all.mjs`(230)、`scripts/ce12-p0-integration.mjs`(377)、`scripts/ce12-p0-ce08-funcverify.mjs`(279)。

### 2.2 Brain UI 7 个稳定 DOM 锚点（契约，勿随意改名）

实测均在 `public/index.html`：
`#noeActQueue` / `#noeCurrentAct` / `#noeApprovalStatus` / `#noeToolPermissionStatus` / `#noeFailureReason` / `#noeBudgetStatus` / `#noeEvidenceLogLink`

### 2.3 Act Pipeline 状态机与安全不变量（来自 `src/loop/ActPipeline.js` 实读）

正常路径：
```
queued → planning → proposed → budget_checked → permission_checked → dry_run → completed
```

风险分级（`normalizeRisk`，第 31–33 行）：
- `DESTRUCTIVE_ACTIONS` 命中 → `critical`
- action 名含 `delete|remove|upload|external|shell|exec|write|move` → `high`
- 其余按声明 `low/medium/high/critical`

终态裁决（第 136–191 行）：
- `critical` / `input.destructive===true` → `blocked_safety`（**绝不真实删除/外发/批量移动**）
- `high`（敏感）→ `awaiting_approval`（默认审批，复用既有 `ApprovalStore`）
- 预算不足 → `failed`
- 仅安全只读 → `dry_run` → `completed`，且**全程 `dryRunOnly:true`**

**安全不变量（单测+运行时双重坐实）：** 所有完成路径 `noRealExecution=true`；`blocked_safety` / `awaiting_approval` / `failed` 三类路径 `noe_act_dry_run` 证据数为 0。retry 仅允许从 `failed / cancelled / blocked_safety` 发起（第 199–200 行），否则 409。

### 2.4 改了 server.js 之后

不自主重启 panel（CLAUDE.md 红线）。改 `server.js` 后**告知用户「需要重启」**，不要自己 launchctl/kill 常驻进程。

---

## 3. 已知限制（下一个人必须知道，否则会踩坑）

### 3.1 Node 双运行时 / ABI 切换（最重要）

- 本机当前 shell 是 **Node v26.0.0 / ABI147**；`.nvmrc` pin 的是 **v22.22.2 / ABI127**。
- `better-sqlite3` 等原生扩展按 ABI 编译。**裸跑 `vitest run` 或直接 `require('better-sqlite3')` 在 Node26 下会崩**——这是预期，不是 bug（根因见 [[ce12-p0-loop-rootcause]]）。
- 正确姿势：一律走 `npm run test:*` / `npm run verify:p0*`，它们经 `ensure-node22 --require-22 --exec` re-exec 到 Node22。
- `npm start` 对 Node26 只 warn 不 fail，避免夺走用户在用的 Node；验收/打包类命令才强制 Node22。

### 3.2 浏览器自动化降级

- in-app browser（`iab`）当前不可用（`Browser is not available: iab`）。UI 交互级验证一律降级为项目内 **Playwright e2e**（带截图落盘）。这是已知约束，不必每轮重新解释。

### 3.3 MiniMax M3 patch-only 通道补审点

- `MiniMaxSpawnAdapter` 的 fail-closed 守卫与单测已落盘并全绿；但截至 CE08，**真实在线产出 assistant patch proposal 的一次完整会话尚未跑通**（曾出现 `diffs=[]` 但无 proposal）。这是补审缺口，不阻断 P0，需后续补一次能真正产出 patch plan 的只读会话。

### 3.4 `test:p0:funcverify` 的前置条件

- 该命令的 U1 断言「原项目 51735 基线存活」。**若原项目未在跑，U1 会按设计失败**。这是边界守护，不是产品 bug。

### 3.5 范围限制

- Voice / Social I/O / 完整 Jarvis 体验、签名公证、批量移动/删除用户文件、改原项目目录——**均不在 CE12 P0 内**。

---

## 4. 交接信息（下一位执行者直接续）

### 4.1 当前进度（CE12 工程闭环）

| 阶段 | 状态 | 关键产出 |
|---|---|---|
| ①用户想法 → ④排期 | done | 需求/技术/排期 canonical + 成员独立稿 |
| ⑤代码开发 | done | 7 个 P0 代码落盘 + 一键聚合器 |
| ⑥单元测试 | done | 全量 1061 全绿；P0 单测 40/40 |
| ⑦集成测试 | done | `test:p0:integration` 18/18 |
| ⑧功能验证 | done | 真实端口 51835 主路径 14/14 |
| **⑨文档编写** | **本轮** | 本操作手册（使用/维护/限制/交接四合一） |
| ⑩交付验收 | 待做 | 用 `npm run verify:p0` 7/7 + 本手册做验收 |
| ⑪复盘优化 | 待做 | 消化补审点（§3.3 / §3.2） |

### 4.2 下一位执行者第一步该做什么

1. `cd "/Users/hxx/Desktop/Neo 贾维斯" && npm run verify:p0`，确认 7/7、EXIT=0（这是验收基线）。
2. 读 `NOE_CE12_P0_EVIDENCE_INDEX.md` 拿每个 P0 的证据位置。
3. 进入 CE10 交付验收：把 full run 的退出码、截图、electron log 路径定格为验收证据（建议把 fast 与 full 报告拆成 `latest-fast.json` / `latest-full.json`，避免互相覆盖）。
4. CE11 复盘消化 §3.3（MiniMax 在线 patch-only）与 §3.2（iab 浏览器）两个补审点。

### 4.3 不可触碰的边界（继承全链）

- 只在 Noe 工作区改动；原项目 `/Users/hxx/Desktop/00_项目/05_Claude可视化面板` 零读写。
- 危险操作默认审批/拦截，不做真实外发/删除/批量移动。
- 不签名不公证；不自主重启 panel；不 npm install 新依赖（除非诊断明列且用户同意）。

---

## 5. 工程闭环衔接

⑧功能验证（真实端口主路径）→ **⑨文档（本轮：把分散文档收敛成一页可照做的操作/维护/限制/交接）** → ⑩交付验收（`npm run verify:p0` 7/7 + 本手册即可让下一位无需重新猜上下文）→ ⑪复盘（消化 §3 补审点）。本阶段完成门槛达成：**下一位执行者照本文件 §1 跑命令、照 §4 接力，无需重新猜测上下文。**
