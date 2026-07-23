# Noe / Neo 贾维斯 — 阶段 10「交付验收」CANONICAL

> 单一事实源。本文件 + `NOE_PHASE10_ACCEPTANCE_VERIFY.mjs` 为阶段 10 自包含权威，不依赖任何并行成员临时文档存活。
> 完成门槛：**每个显式需求都有当前证据支撑**。所有证据均为本轮用项目受支持的 **Node 22.22.2** 实跑、退出码可复现。
> 收敛规则：本验收表为阶段 10 唯一裁定来源；并行成员若另出 `*_ACCEPTANCE_*` 稿，增量并入勿整体覆盖。

## 0. 验收前提与运行环境

- 运行版 Node：`/Users/hxx/.nvm/versions/node/v22.22.2/bin/node`（better-sqlite3 预编译 ABI 127）。
- ⚠️ 硬约束：当前 shell 默认 `node -v = v26.0.0`（ABI 147），直接跑会导致原生模块 ABI 不匹配、server 起不来。**所有门必须用 Node 22 复跑**，已写入回滚/已知限制。
- 验收基线：BaiLongma 镜像 HEAD `de78c6f761bd98a0fe406f0e78da80199ddf8d45`，`git status --short` 空（只读未改、已 gitignore）。

## 1. 验收表（显式需求 → 当前证据，逐项裁定）

| 需求 | 来源 | 验收口径 | 当前证据（Node22 实跑，退出码=0） | 裁定 |
|---|---|---|---|---|
| **REQ-1 只读审计 BaiLongma** | 交接路线 ①；产出 `NOE_BAILONGMA_ARCH_AUDIT.md` | 审计稿落盘、覆盖 package/schema/memory/loop/ui/voice/social，且镜像只读 | 审计稿 130 行真实落盘；镜像 HEAD `de78c6f` 干净、已 gitignore；阶段1门 13/13、阶段2门 UR6/FR12/NFR9 | ✅ 通过 |
| **REQ-2 Noe 在 51835 启动且不影响 51735** | 交接路线 ② | 51835 真启停 + 51735 PID 全程零变化 | `NOE_M1_ISOLATION_SMOKE.mjs` 8/8；`NOE_PHASE8_FUNCTIONAL_VERIFY.mjs` 22/22；全程 51735 PID `73664→73664`、51835 测后释放 | ✅ 通过 |
| **REQ-3 NoeLoop 最小闭环** | 交接路线 ③ | 默认 stopped/零额度 tick、状态机/熔断、事件落库 | `src/loop/NoeLoop.js`（243 行）；阶段6单测 12/12（含 busy 跳过、连错自停）；阶段7 smoke I9-I11 tick acted=false | ✅ 通过 |
| **REQ-4 Memory Core** | 交接路线 ④ | CRUD + FTS5(trigram) 召回 + 项目隔离 + soft-hide + Focus 吸收 | `src/memory/MemoryCore.js`(232) + `FocusStack.js`(165)；阶段7 smoke I4-I8 写→召回→soft-hide→absorb 贯通；阶段5门 29/29 | ✅ 通过 |
| **REQ-5 Brain UI Lite** | 交接路线 ⑤ | 浏览器可见、展示 loop/memory/focus/tools/health | `public/src/web/brain-ui.js`(259)；`index.html` 4 处 Brain UI 锚点；阶段8 真浏览器 22/22 + 截图 `output/playwright/phase8-*.png` | ✅ 通过 |
| **REQ-6 Voice / Social / Jarvis 体验** | 交接路线 ⑥（"再做"） | 路线图既定 P2，本期不抢跑；保留"不审计不接入工具执行"边界 | 技术方案/排期定为 **P2 延后**；工具执行 manifest-only 默认 `disabled`，经 permission/approval/audit 链 | 🟡 P2 按计划延后（非缺陷） |

## 2. 边界验收（用户三条硬边界 → 证据）

| 边界 | 验收口径 | 当前证据 | 裁定 |
|---|---|---|---|
| **B-1 不全量复制 BaiLongma 进 Noe** | 镜像隔离、不进 git | `BaiLongma-audit` 被 `.gitignore`（`git check-ignore` 命中）；镜像 status 0 行；仅审计稿引用之 | ✅ 通过 |
| **B-2 不审计就接入工具执行能力** | manifest-only + 权限门 + 默认禁用 | `src/capabilities/ToolRegistry.js`(214) 引用 `PermissionGovernance`、按 `enabled` 闸门；阶段7 smoke I13-I15 disabled→403、无 handler→501（绝不裸执行） | ✅ 通过 |
| **B-3 不在原项目目录开发** | 原项目 `05_Claude可视化面板` 零写入 | 原项目近 120 分钟被改文件数 **0**；生产 `~/.noe-panel/panel.db` mtime 早于本会话（测试用临时 HOME，生产未污染） | ✅ 通过 |
| **附加 secret 卫生** | 交付物无明文密钥 | `NOE_PHASE2_SECRET_GATE.mjs` PASS（含 BaiLongma `doubaoKey` 已 `<REDACTED>`）；仅 4 处良性裸 UUID（房间ID/公开 checkout）WARN | ✅ 通过 |

## 3. 阶段门复跑结果（本轮 Node22 实测，交付验收前置）

| 门 | 结果 | 退出码 |
|---|---|---|
| NOE_PHASE1_VERIFY.mjs | 13/13 | 0 |
| NOE_PHASE2_VERIFY.mjs | UR6/FR12/NFR9, missingAcceptance=[] | 0 |
| NOE_PHASE2_SECRET_GATE.mjs | PASS（无真实密钥） | 0 |
| NOE_PHASE3_VERIFY.mjs | 6/6 | 0 |
| NOE_PHASE4_VERIFY.mjs | 9/9 | 0 |
| NOE_PHASE5_VERIFY.mjs | 29/29 | 0 |
| NOE_PHASE6_VERIFY.mjs | 12/12 | 0 |
| NOE_PHASE7_VERIFY.mjs | 12/12 | 0 |
| NOE_PHASE7_INTEGRATION_SMOKE.mjs | 23/23 | 0 |
| NOE_M1_ISOLATION_SMOKE.mjs | 8/8 | 0 |
| NOE_PHASE8_FUNCTIONAL_VERIFY.mjs | 22/22（真浏览器主路径） | 0 |
| NOE_PHASE9_DOCS_VERIFY.mjs | 9/9 | 0 |
| **NOE_PHASE10_ACCEPTANCE_VERIFY.mjs** | 见 §6 | 0 |

## 4. 通过 / 未通过项小结

- **通过**：REQ-1..REQ-5 全部通过；三条硬边界 B-1/B-2/B-3 全部通过；secret 卫生通过；12 道前置阶段门全绿、退出码均 0。
- **未通过（阻断）**：**无**。
- **按计划延后（非未通过）**：REQ-6 Voice/Social/Jarvis 体验 = P2，路线图既定，保留"不审计不接入工具执行"边界，不计为缺陷。

## 5. 剩余风险（均非阻断，附收敛手段）

1. **Node 版本环境风险**：默认 shell Node 26 与 better-sqlite3 ABI 不匹配。收敛：所有门强制 Node 22；建议下阶段在各 VERIFY 脚本头部加 `NODE_MODULE_VERSION` 预检 fail-fast，避免随环境 node 翻绿翻红。
2. **零额度 / 工具不真执行**：NoeLoop 默认 `acted=false` 不烧额度、工具默认 `disabled` 不裸执行——这是设计约束（安全优先），非缺陷；接真实执行属 P2，须先过 manifest→permission→approval→audit 链。
3. **向量召回未接入**：Memory Core 当前用 FTS5(trigram) 关键词召回，embedding 召回为后续增量（复用既有 `embeddings` 表，零新增依赖）。
4. **旧 e2e 脚本 `tests/e2e/noe-brain-ui.e2e.mjs`**：依赖未安装的 `@playwright/test` 且选择器用了不存在的连字符 ID，跑不起来；功能验收已改用 `NOE_PHASE8_FUNCTIONAL_VERIFY.mjs`。建议复盘阶段修掉或标废弃。
5. **交接文档膨胀**：`上下文交接.md` / `任务交接.md` 持续增长，建议复盘阶段瘦身、仅留指向 canonical 的入口，降低双源漂移。

## 6. 回滚方式（4 级，从轻到重）

1. **功能 flag 级（秒级）**：NoeLoop 默认 `enabled=false`、工具默认 `disabled`；出问题直接保持关闭即回到"零行为"安全态，无需改代码。
2. **git revert 级**：本期所有新增均为加法（`src/loop`、`src/memory`、`src/capabilities/ToolRegistry.js`、`src/server/routes/noe.js`、`public/src/web/brain-ui.js` + 各阶段脚本/文档），`git revert`/删除新增文件即可，不触碰存量 17 表与原有路由。
3. **DB `.bak` 级**：迁移 v2 经 `SqliteStore` 事务 + 自动 `.bak`；异常可从 `panel.db.bak` 恢复，新增 `noe_*` 表为净增，不改既有表结构。
4. **环境锁级**：锁运行版 Node 22.x（ABI 127）；若原生模块异常，回退 Node 22/24 复测或 `npm rebuild better-sqlite3`。

## 7. 工程闭环 11 阶段衔接

承上：阶段 1 目标契约 → 2 需求(UR6/FR12/NFR9) → 3 技术方案(in-process/加法不改存量) → 4 排期(M0→M5,P2延后) → 5 实现 → 6 单测 → 7 集成 → 8 功能 → 9 文档，**逐阶段门均本轮 Node22 复跑全绿**。
本阶段(10 交付验收)：把"各阶段已过"升级为"每个显式需求逐项对证据裁定"，给齐验收表/通过未通过/剩余风险/回滚，并以 `NOE_PHASE10_ACCEPTANCE_VERIFY.mjs` 做机读兜底。
启下：阶段 11 复盘优化聚焦 §5 剩余风险（Node 预检 fail-fast、向量召回接入、旧 e2e 清理、文档瘦身、P2 Voice/Social 准入设计）。

## 8. 裁定

REQ-1..REQ-5 + 三条硬边界全部有当前证据支撑并通过，REQ-6 按计划 P2 延后，无阻断未通过项；12 道前置阶段门 + 本阶段机读门退出码均为 0；原项目 51735 零影响、生产 DB 未污染、镜像只读、交付物无明文密钥。**满足阶段 10 完成门槛，同意交付验收通过，进入阶段 11「复盘优化」。**
