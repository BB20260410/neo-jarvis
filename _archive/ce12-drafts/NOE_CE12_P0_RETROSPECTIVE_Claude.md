# CE12 P0 复盘优化 — Claude 成员独立稿（实测证据 + 自身门缺陷捕获版）

阶段：11. 复盘优化（CE11）
工作区：`/Users/hxx/Desktop/Neo 贾维斯`
成员：🟣 Claude（恢复后二次独立复核；GPT-Codex 已 solo takeover 产出 canonical）

> 事实源声明（避免 CE01 竞争稿反模式）：本文件**不是第二份 canonical**，不替代 `NOE_CE12_P0_RETROSPECTIVE_CANONICAL.md`。
> 它是 Claude 成员独立视角：用本轮实测复核 canonical，捕获并修复其验证门自身的一处真实缺陷，补一条新错误经验，并落第 2 个 CE11 签字。

---

## 0. 本轮实测复核（把复盘结论从声明升级为硬证据）

我没有空谈，先实跑 canonical 的复盘门 + 全部下游门，结果如下（均在 Noe 工作区，Node26/ABI147 runner，ABI 子任务经 `ensure-node22 --require-22 --exec` re-exec 到 v22.22.2/ABI127，绕开 [[ce12-p0-loop-rootcause]] 的卡死根因）：

| 命令 | 结果 | 退出码 |
|---|---|---|
| `npm run verify:p0:retro` | **首跑 68/69（1 FAIL）→ 修复后 69/69** | EXIT=0 |
| `npm run verify:p0:acceptance` | 59/59 CE12 P0 acceptance checks passed | EXIT=0 |
| `npm run verify:p0:fast` | 5/5 门通过（跳 2）· allPass=true · noRealExecution=true · approvals=1 | EXIT=0 |
| 开源审计缓存 `output/noe-phase11-open-source-audit.json` | rows=21，source=github metadata，auditedAt=2026-06-02 | — |

## 0.1 我捕获并修复的真实缺陷（本轮核心增量，非声明）

**首跑 `verify:p0:retro` 报 1 处 FAIL**：`[FAIL] acceptance verify still passes - exit=0`。

根因定位：`NOE_CE12_P0_RETROSPECTIVE_VERIFY.mjs` 的两处下游子门断言**硬编码了精确计数**——acceptance 门写死 `48/48`、docs 门写死 `83/83`。而 acceptance 门实际已从 48 项增长到 **59 项**，正则 `48\/48` 不再匹配 `59\/59`，于是即便 acceptance 真实全过（`status===0`）也被误报 FAIL。

这是脆弱断言：`status === 0` 已经保证子门完整通过（acceptance/docs 脚本任意失败即 `process.exit(1)`），精确计数是**冗余且会随检查项增长而误报**的。修复分两步：
1. 并发成员先把 `48/48` 补成 `59/59`（数字对齐，复跑 69/69）。
2. **我进一步硬化**：把两处断言从精确计数改为弹性 `/\d+\/\d+ CE12 ... passed/` + 依赖 `status === 0`，**对计数增长免疫**，从根上消除这类复发。

复跑确认：`npm run verify:p0:retro` → **69/69，EXIT=0**。

> 这条缺陷本身就是复盘的活案例：复盘门自己犯了它在 §1/§2 警告的「脆弱验证断言」。验证基础设施必须比业务代码更稳，否则门会把「真过」误判成「假败」，制造无意义返工。

---

## 1. 提前停止 / 提前交付原因裁定（独立复核 = 同意 canonical §1）

裁定一致：把「阶段验收通过」误读成「完整 Jarvis 产品交付」，根因是**工程阶段门 / 验收门 / 产品级 DoD 三层语义没隔离**，不是单个模型偷懒。补充我实测视角的 3 条：

- **阶段语言过强**：多轮写「通过 / 可推进」却不同句声明「完整 Jarvis 未完成」。修法：所有结论拆 `stage_status` 和 `product_status` 两句（canonical §1 已落）。
- **工程验证 ≠ 产品验证**：`verify:p0` 只能证明 7 个 P0 工程门，证明不了 Voice/Social/真实工具/长期记忆。实测佐证：`verify:p0:fast` 5/5 全过，但它**完全不覆盖** Voice/Social——绿门不等于产品完成。
- **质量门残留旧状态**：本轮系统注入的「质量门自动修复要求/signoff_incomplete=task_planning:1/2」是 CE05 前循环残留；实测 `node NOE_CE12_P0_TASK_PLAN_VERIFY.mjs` 已 PASS、acceptance 门也确认该阻断关闭。**不因旧文案回退已验收阶段**。

## 2. 错误经验清单（继承 canonical L-01..L-10，新增 L-11）

canonical 的 L-01..L-10 我逐条认可。**本轮实测新增 1 条**：

| 编号 | 错误经验 | 本轮改法（已落地） |
|---|---|---|
| **L-11** | **验证门把子门结果硬编码成精确计数**（`48/48`、`83/83`），检查项一增长就把「真过」误报成 FAIL，制造假返工。 | 子门断言改弹性 `\d+/\d+` + 依赖 `status===0`；已硬化 retro 门两处，复跑 69/69。**后续把同口径推广到所有 CE12 verify 脚本**（见 §5 P0-06）。 |

## 3. Neo 产品级 Definition of Done（认可 canonical §3 全 12 条）

DOD-01..DOD-12 我认可，不重复抄。强调红线：**12 条全满足前，禁止说「Neo 完整产品完成」**。当前真实状态：DOD-02/03(地基)/05/08(smoke)/10/11 P0 已满足；DOD-04(Memory)/06(Voice)/07(Social)/09(Observability)/12(可用性) 未完成或部分。我建议给 DoD 也配一个机读门（把「product_status 未完成项」做成断言），避免 DoD 沦为纯文字——这进 §5 P1。

## 4. 开源候选矩阵（实测复核 canonical §4）

实测确认审计缓存 `output/noe-phase11-open-source-audit.json` 真实存在、**rows=21、source=github metadata**，复盘门 4 个抽样 repo（mem0ai/mem0、langchain-ai/langgraph、electron-userland/electron-builder、modelcontextprotocol/servers）断言全 PASS。矩阵 21 行（Agent Memory / RAG·File Index / Vector Store / Search / Knowledge Graph / Orchestration / Electron / Observability / Tool Market）见 canonical §4，只读公开元数据、不 clone、不复制代码、不接真实工具执行。

本轮 GitHub GraphQL 刷新遇 EOF（停在 `docling-project/docling`），保留同日缓存——这正是 canonical P0-02（审计脚本需 retry/partial/failed-row 标记）的实证理由。

我对**进入原型的优先建议**（与 canonical 一致，按 Neo 现有 SQLite/FTS5 底座的最低接入成本排序）：
1. **mem0**（P1 narrow spike）——长期记忆 mutation/retrieval 策略，对 DOD-04 最直接。
2. **LanceDB / Chroma**（P1）——嵌入式本地向量，FTS5 之外的召回候选，避免起独立服务。
3. **LangGraph**（P1 pattern-only）——只借状态机模式参考 Act Pipeline，**不替换 NoeLoop**。
4. **electron-log + OpenTelemetry JS（local-only）**（P1）——补 DOD-09，默认 exporter 关闭、不外发。

## 5. P0 / P1 / P2 后续优先级（继承 canonical §5 + 新增 P0-06）

**P0（下一轮立即减少返工）**：canonical P0-01..P0-05 + 本轮新增——

- **P0-06（本轮实证新增）**：把所有 CE12 verify 脚本里「跨脚本子门断言」的硬编码精确计数统一改为弹性 `\d+/\d+` + `status===0`。验收口径：任一子门增删检查项后，上层门不因数字漂移误报 FAIL（retro 门已示范，复跑 69/69）。

P1（产品化能力升级）：Memory M1（source/confidence/ttl/trace）、Local file index（SQLite FTS 先行，对比 LlamaIndex/Docling/Unstructured）、Act Pipeline retry/cancel HTTP 端到端、Electron 命名/图标/日志正式化、local-only observability、**DoD 机读门**。

P2（完整 Jarvis 体验）：Voice 输入输出、Social I/O 只读原型、Tool marketplace manifest-only、外部遥测+隐私开关、Knowledge Graph/LangGraph 窄状态机 spike。

## 6. 房间 / 阶段 / 交付状态闭环（认可 canonical §6，补 1 条实测边界）

| 层级 | 当前裁定 | 后续规则 |
|---|---|---|
| 房间 | CE01-CE10 有验收证据；CE11 本轮闭环复盘 | 不新建房间、不回退旧阶段，除非发现 secret/路径污染/数据破坏硬风险 |
| 阶段 | CE12 P0 通过验收（`verify:p0:retro` 69/69）；当前阶段=复盘优化 | 每阶段≤3 轮，第 3 轮必须推进/接管/列硬阻断 |
| 产品 | 产品化基础可验收，完整 Jarvis 未完成 | 任何交付结论必须同时写 stage_status + product_status |
| 磁盘 | 大量前序未提交产物存在，本轮不清理 | 不 `git reset --hard`、不删并行成员成果 |
| **原项目边界（实测补充）** | 原项目 09:30 后 `server.js`/`logs/panel-51735.*`/adapter 有 mtime 变动——经核实属**面板编排器自身（51735，cwd=原项目）运行产物**，见 [[cluster-panel-runs-from-original-project]]，**非 Noe CE11 写入** | 按记忆纪律：不把「我 CE11 写入零落原项目」说成「原项目工作树干净」；原项目未提交改动另案裁定 |
| 危险操作 | 当前只允许 dry-run / awaiting_approval / blocked_safety | 删除、外发、批量移动、真实工具执行必须等用户明确确认 |

---

## 7. CE11 裁定（Claude，二次独立复核）

**同意 CE11 复盘优化通过、闭环收口。** 依据：
- 6 项必需输出（提前交付原因裁定 / 错误经验 / 产品级 DoD / 开源候选矩阵 / P0·P1·P2 路线 / 状态闭环）在 canonical 齐备，我实测复核全部成立。
- 本阶段门槛「形成能减少下次返工的具体行动项」达成：我**实测捕获并修复**了复盘门自身的硬编码计数缺陷（L-11 / P0-06），把假返工源头消除，`verify:p0:retro` 复跑 69/69 EXIT=0。
- 无 secret / 路径污染 / 数据破坏 / 不可逆 / 安全硬阻断；我的 CE11 写入零落原项目。

**产品裁定（红线复述）**：完整 Jarvis 产品仍未完成（Voice / Social I/O / 真实工具 handler / 长期记忆策略 / Electron 正式分发 / 完整可观测性未做）。下一步按 §5 P0 执行，不触碰原项目、不接危险真实工具、危险操作等用户明确确认。

补审点：MiniMax M3 在线中文侧 patch-only proposal 待回补（当前只认 adapter fail-closed 单测）；GitHub 审计 GraphQL EOF 待 retry/partial 改造（P0-02）；Browser/iab 不可用为已知约束，UI 证据默认 Playwright。
