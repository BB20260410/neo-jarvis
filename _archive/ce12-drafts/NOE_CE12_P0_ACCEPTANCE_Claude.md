# CE12 P0 交付验收裁定 — Claude 成员独立稿（实测证据版）

- 阶段：10. 交付验收
- 工作区：`/Users/hxx/Desktop/Neo 贾维斯`
- 验收时间：2026-06-02（runner Node v26.0.0 / ABI147；ABI 子任务经 `ensure-node22 --require-22 --exec` re-exec 到 v22.22.2 / ABI127）
- 一键复现命令：`npm run verify:p0`
- 本轮实测：**7/7 门通过，ALL PASS ✅，EXIT=0**
- 全量证据 JSON：`output/ce12-p0/p0-verify-all-1780387639746.json`（allPass=true，generatedAt 2026-06-02T08:07:19Z）
- **CE10 二次独立复跑确认（2026-06-02 16:07）**：我在交付验收阶段重新跑 `npm run verify:p0`，干净退出码 `CLEAN_VERIFY_P0_EXIT=0`，7/7 门逐门 exit=0（requirements/node22/p0_unit/act/integration/electron/brain_ui），全部产物为本轮新生成（见 §1 刷新后路径）。验收结论不依赖历史证据，已用本轮硬证据复现。

> 事实源声明（避免 CE01 竞争稿反模式）：本文件不是第二份 canonical。需求口径以 `NOE_CE12_P0_REQUIREMENTS_CANONICAL.md`（60/60）为准，证据索引以 `NOE_CE12_P0_EVIDENCE_INDEX.md` 为准。本文件只把验收阶段的「逐项对照 + 通过/未通过 + 剩余风险 + 回滚方式」收敛成一页可裁定结论。
>
> 口径守住：**stage_done ≠ product_done**。本次交付的是「Noe 从可演示原型 → 可继续验收的产品化基础（7 个 P0）」，**不是完整 Jarvis 产品**。Voice / Social I/O / 完整 Jarvis 全体验仍是非目标（NG-1），不在本次验收范围。

---

## 1. 验收表（每个显式需求 → 当前证据 → 判定）

### 1.1 用户需求 UR-CE12-*（P0）

| ID | 需求 | 当前证据 | 判定 |
|---|---|---|---|
| UR-CE12-1 | 推进到「可继续验收的产品化基础」 | 7 个 P0 全部有命令/文件/exit code 证据；本文件明确区分阶段≠产品 | ✅ 通过 |
| UR-CE12-2 | P0 返工优先，不扩大范围 | 需求/方案/排期只排 7 个 P0；Voice/Social/Jarvis 标为 NG-1 非目标 | ✅ 通过 |
| UR-CE12-3 | 所有结论有当前文件/命令/UI/日志证据 | `verify:p0` 7/7、JSON 落盘、e2e 截图、electron 日志、集成报告路径齐全 | ✅ 通过 |
| UR-CE12-4 | Noe 与原项目隔离（51835 不影响 51735） | CE08 funcverify 实测：51835 起停、51735(PID69164) 全程存活；本轮验收期间 51735 仍存活、Noe 产品交付物全部在 Noe | ✅ 通过（见 §3 边界说明） |
| UR-CE12-5 | MiniMax M3 降权为 patch-only 审计/规划 | `MiniMaxSpawnAdapter.js` fail-closed；单测覆盖 `diffs=[]` 才保存、shell/write→blocked_safety | ✅ 通过（在线 patch-only 通道见 §2 补审点） |

### 1.2 功能需求 FR-P0-*（P0，7 项）

| ID | 需求 | 当前证据（`verify:p0` 门 + 独立抽检） | 判定 |
|---|---|---|---|
| FR-P0-1 | Node22 fail-fast / re-exec gate | 门 `mode=candidate_exact selected=v22.22.2 ABI127`，exit=0；`.nvmrc=22.22.2`、`engines.node>=22`；verify/e2e/package/smoke 入口均经 gate | ✅ 通过 |
| FR-P0-2 | 修掉/废弃旧坏 e2e | 旧 `noe-brain-ui.e2e.mjs` 已 `// Deprecated...replaced` 转发；入口 `e2e-with-server.mjs:149` 只 spawn 新 `noe-brain-ui-p0.e2e.mjs`；不再当 pass 证据 | ✅ 通过 |
| FR-P0-3 | Brain UI 执行可视化增强 | e2e 17/17，7 个 DOM 锚点全可见 + Act 数据流；截图 `output/playwright/noe-brain-ui-p0-1780387661072.png`（PNG 1440×930 / 174055 字节，本轮 16:07 生成，`file` 确认真实位图） | ✅ 通过 |
| FR-P0-4 | NoeLoop 最小 Act Pipeline | 运行时证据 `allPass=true noRealExecution=true approvals=1`；三终态 `completed / awaiting_approval / blocked_safety`；单测覆盖 retry/cancel | ✅ 通过 |
| FR-P0-5 | Electron smoke（不签名/公证） | smoke PASS，事件链 `app_ready→menu_registered→server_ready→window_loaded→quit`，exit=0；产物 `out-noe/`、日志 `output/electron-smoke/` | ✅ 通过 |
| FR-P0-6 | 交付状态闭环 | source of truth=EVIDENCE_INDEX；`verify:p0` 单命令 + 单一退出码 + 机器可读 JSON；本文件即阶段状态声明 | ✅ 通过 |
| FR-P0-7 | MiniMaxSpawnAdapter patch-only 原型 | 单测全绿；`diffs=[]` 才保存、shell/write/delete/move/apply_patch→`blocked_safety`，不依赖 Mavis permission | ✅ 通过（离线 guard），⚠ 在线真实 patch 通道待补（§2） |

### 1.3 非功能需求 NFR-P0-*（P0，7 项）

| ID | 需求 | 当前证据 | 判定 |
|---|---|---|---|
| NFR-P0-1 | 路径安全：只在 Noe 工作区读写 | 22 个 CE12 交付物 git status 全部位于 Noe；verify 脚本 `cwd is Noe workspace` PASS | ✅ 通过 |
| NFR-P0-2 | 危险操作默认审批 | Act 三态：删除/外发→blocked_safety、高危→awaiting_approval；`noRealExecution=true` | ✅ 通过 |
| NFR-P0-3 | 成本安全：默认不烧额度 | Act 全程 `dryRunOnly:true`，集成测试 `$0.0000`；默认不调真实 LLM | ✅ 通过 |
| NFR-P0-4 | 证据卫生：坏证据不复用 | 旧 e2e 标 deprecated/replaced；文档不再引为 pass | ✅ 通过 |
| NFR-P0-5 | 本地优先可观测性 | 全部产物落 `output/`、`out-noe/`、`logs/`；无外部遥测上传 | ✅ 通过 |
| NFR-P0-6 | MiniMax 权限不依赖 Mavis permission | adapter 自身强制 patch-only，单测验证即使无 Mavis 也 fail-closed | ✅ 通过 |
| NFR-P0-7 | 协同降级不阻塞 | 本阶段单/双模型接管均可推进；M3 离线作补审点不阻断 | ✅ 通过 |

### 1.4 非目标 NG-*（确认未越界）

| ID | 非目标 | 确认 |
|---|---|---|
| NG-1 | 不做 Voice/Social/完整 Jarvis | ✅ 未新增真实外发能力 |
| NG-2 | 不批量移动/删除/不可逆 | ✅ `noRealExecution=true`，零 destructive 真实执行 |
| NG-3 | 不修改原项目目录 | ✅ Noe 产品交付物零写入原项目（边界说明见 §3） |
| NG-4 | 不整仓搬 BaiLongma | ✅ `BaiLongma-audit/` 只读，新代码为最小重建 |
| NG-5 | 不把 M3 当同级执行成员 | ✅ adapter patch-only，`diffs=[]` guard |

---

## 2. 未通过 / 补审点（不阻断交付，列为 P1/P2 后续）

本次 **7/7 门全过、无未通过(FAIL)项**。以下为已知补审点（前序阶段一致记录，非本阶段新增阻断）：

1. **FR-P0-7 在线真实 patch-only 通道**：离线 fail-closed guard + 单测已全绿；但 MiniMax/Mavis 真实 session 仅得 `diffs=[]` 而**未产出过 assistant patch proposal**，端到端「真实出 patch → 验证 diffs=[] → 交 Claude 执行」尚未跑通一次。建议后续补一次能真正产出 patch plan 的只读会话。**风险等级：低**（adapter 已 fail-closed，无安全敞口）。
2. **iab 浏览器不可用**：UI 交互级验证降级为项目内 Playwright e2e（截图证据充分）。建议后续修复 `iab` 路径以获得更丰富交互验证。**风险等级：低**。
3. **MiniMax M3 中文侧审计**：本集群多轮 M3 在 propose 阶段掉线，硬风险审计意见待其在线回补。**风险等级：低**（已由 Claude+GPT 双签覆盖）。

---

## 3. 剩余风险（交付验收必须如实记录）

### R1 — Node 双运行时 ABI 切换（已收敛，需读者知晓）
runner 在 Node26/ABI147，所有 better-sqlite3 相关子任务经 `ensure-node22 --require-22 --exec` re-exec 到 Node22/ABI127。这是 [[ce12-p0-loop-rootcause]] 记录的卡死根因的工程化绕过。**风险：低**——`verify:p0` 已封装，读者无需手动切换。

### R2 — 原项目目录存在大量未提交改动（⚠ 重要，已查清归属，非 Noe 产品工作所致）
交付验收期我独立核验发现：原项目 `/Users/hxx/Desktop/00_项目/05_Claude可视化面板` 当前 git 工作树有**大体量未提交源码改动**：
```
server.js          +987 / -119 行（新增 roomStart.js / roomRequirements.js 集群路由、ClaudeRuntimeDefaults、node-pty 切换等）
public/index.html  61 行
```
**归属判定（实测）**：51735 面板进程（PID 69164）的 cwd = 原项目目录，即**本集群编排器本身**就从原项目运行；上述改动是**面板编排基础设施自身的开发**（修复集群 loop 卡死的那批 room dispatch 代码），由面板自己的工作流产生，**不是 Noe CE12 P0 产品工作**——Noe 侧 22 个 CE12 交付物经 git status 核验全部位于 Noe 目录。
**结论**：Noe 产品工作满足 NG-3 / NFR-P0-1（零写入原项目源码）；但**绝对意义上原项目工作树并非"干净"**，前序轮次"原项目零触碰"只在各自窄时间窗成立。**风险：中**——这些改动未提交，是否 commit / 回滚由用户裁定，与 Noe 产品验收正交。**建议**：用户单独决定原项目面板改动的去留；本集群不应继续在原项目源码上做产品开发。

### R3 — 交付物未 git commit（按规则正确）
22 个 CE12 交付物在 Noe 全部为 `??` 未跟踪。按用户规则「不 git commit/push 除非明说」，这是**正确状态**，非缺陷。**风险：低**。

---

## 4. 回滚方式（每个 P0 独立可回滚，旧行为零回归）

CE12 全部为**加法不改内核**，逐项可回滚：

| 交付项 | 回滚方式 |
|---|---|
| FR-P0-1 Node gate | 删 `scripts/ensure-node22.mjs` + 还原 package.json 受影响 script；`npm start` 本就只 warn 不夺 Node26 |
| FR-P0-2 e2e | 删 `tests/e2e/noe-brain-ui-p0.e2e.mjs`，旧 stub 转发即失效（无副作用） |
| FR-P0-3 Brain UI | 还原 `public/index.html` / `brain-ui.js` / `style.css` 的 7 锚点新增块 |
| FR-P0-4 Act Pipeline | 删 `src/loop/ActPipeline.js` + `ActStore.js`；NoeLoop 内核未改，去掉 actHandler 注入即回原 tick |
| FR-P0-5 Electron smoke | 删 `scripts/electron-smoke.mjs` + `out-noe/`（纯产物） |
| FR-P0-6 证据闭环 | 删 `scripts/ce12-p0-verify-all.mjs` 及 CE12 文档（不影响运行时） |
| FR-P0-7 MiniMax adapter | 删 `src/room/MiniMaxSpawnAdapter.js`；未在主链路接入，删除即无影响 |

整体回滚：因全部为 Noe 工作区未跟踪/新增文件，`git clean` 前务必人工确认（用户红线：不自动删未提交工作）。**推荐**：逐文件 `rm` 上述新增项 + `git checkout` 还原被改的 `public/*`，5 分钟内可逆。

---

## 5. 工程闭环衔接

①用户想法→②需求→③技术方案→④排期→⑤代码→⑥单测(1061/1061)→⑦集成(18/18)→⑧功能验证(14/14)→⑨文档→**⑩交付验收(本轮：7/7 门 + 验收表 + 风险 + 回滚)**→⑪复盘（消化 §2 三个补审点 + §3 R2 原项目改动去留）。

**CE10 裁定（Claude）：交付验收通过，可推进 ⑪复盘优化。**
依据：7 个 P0 + 7 NFR + 5 UR + 5 NG 每条均有当前实测证据支撑、`verify:p0` 单命令 7/7 全绿 exit=0、证据落盘可复现；无 secret/数据破坏/不可逆/安全硬阻断。唯一需用户知晓的中风险项是 §3 R2（原项目面板自身的未提交改动，与 Noe 产品验收正交，归属已查清非 Noe 产品工作所致）。
