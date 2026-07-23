# Noe / Neo 贾维斯 - 阶段 5 代码开发落地记录

生成时间：2026-06-02
工作区：`/Users/hxx/Desktop/Neo 贾维斯`
阶段：5. 代码开发
基线：`NOE_PHASE3_TECH_DESIGN_CANONICAL.md` + `NOE_PHASE4_TASK_PLAN_CANONICAL.md`

## 本轮接手范围

- Claude 已不可用，本轮由 GPT/Codex 接手 Claude 的 M5 安全复核职责；Gemini 可继续复核，但不再等待 Claude。
- 只在 Noe 工作区读写；未进入也未修改原项目 `/Users/hxx/Desktop/00_项目/05_Claude可视化面板`。
- BaiLongma 镜像继续只读；未复制 BaiLongma 全量代码，未接入未审计工具执行能力。

## 已落地代码面

| 模块 | 路径 | 落地内容 |
|---|---|---|
| DB v2 迁移 | `src/storage/SqliteStore.js` | 新增 `noe_memory`、`noe_memory_fts`、`noe_focus_stack`、`noe_tools`，沿用既有事务迁移与 `.bak` 机制 |
| Memory Core | `src/memory/MemoryCore.js` | `write/get/hide/bumpHit/recall/stats`，支持 FTS5 trigram 与 LIKE 降级 |
| Focus Stack | `src/memory/FocusStack.js` | `push/peek/list/restore/pop/depth`，pop 后沉淀到 Memory Core |
| NoeLoop | `src/loop/NoeLoop.js` | `start/stop/pause/resume/tick/status`，默认 `actMode=false`，tick 写 `noe_loop_tick` 事件 |
| ToolRegistry | `src/capabilities/ToolRegistry.js` | manifest 注册默认 disabled，权限门、审批门、审计链路；本轮补齐 shell command 危险命令审批前置 |
| API 路由 | `src/server/routes/noe.js` | `/api/noe/*` loop、memory、focus、tools、approvals、health 路由，全部套 owner-token |
| 服务挂载 | `server.js` | 实例化 Noe Memory/Focus/ToolRegistry/Loop 并注册 Noe 路由，shutdown 时停止 loop |
| Brain UI Lite | `public/index.html`、`public/main.js`、`public/src/web/brain-ui.js` | 新增 Noe Brain tab，显示 Loop、Focus、Thought Stream、Memory、Tools、Health 六块面板 |
| 单元测试 | `tests/unit/noe-memory-focus.test.js`、`tests/unit/noe-loop-toolregistry.test.js`、`tests/unit/routes/noe-routes.test.js` | 覆盖 Memory/Focus/Loop/ToolRegistry/noe routes；本轮新增危险 shell command 不进 handler 的断言 |
| 阶段 5 验收门 | `NOE_PHASE5_VERIFY.mjs` | 机读检查代码锚点、secret 门、阶段 4 门、Noe 单测子集 |

## 本轮实际修复

- 第 2 轮按 Gemini 反对意见补强 M1/M2/M-R 证据：
  - 明确由 GPT/Codex 接手 Claude 原主办职责，不再等待 Claude；本阶段代码开发闭环以 GPT 实现 + Gemini 可复核为准。
  - 复核并确认 M1 Memory Core、M2 NoeLoop、M-R noe 路由已真实落地到 `src/memory/MemoryCore.js`、`src/memory/FocusStack.js`、`src/loop/NoeLoop.js`、`src/server/routes/noe.js`、`server.js`。
  - 补强 `tests/unit/routes/noe-routes.test.js`：新增所有 Noe API route 第一层 handler 都是 `requireOwnerToken` 的断言，并实跑无 token 的 `/api/noe/health` middleware 返回 401，避免路由闭环只测业务 handler。
  - 升级 `NOE_PHASE5_VERIFY.mjs`：把 M1 的 FTS/LIKE/soft hide/focus absorb、M2 的零付费 tick/budget pause、M-R 的 owner-token 401 保护都列入机读锚点。
- `src/capabilities/ToolRegistry.js`
  - 在 handler 执行前提取 `input.command`、`input.args.command` 或 manifest `command`。
  - 若存在命令文本，先调用 `PermissionGovernance.evaluatePermission({ action: 'shell.exec' })`，复用 `DangerousPatternDetector` 的 22 条危险命令规则。
  - `deny` 返回 403；`ask` 返回 202 并记录 `shellGuard: true` 审计细节；只有通过 shell guard 后才进入 `noe.tool.invoke` 权限链和 handler。
- `tests/unit/noe-loop-toolregistry.test.js`
  - 新增用例：enabled 的低风险 shell tool 收到 `rm -rf /` 时必须进入 approval，`risk=critical`，handler 调用次数为 0。
- `NOE_PHASE5_VERIFY.mjs`
  - 固化阶段 5 可复跑验收口径，避免“报告通过但磁盘不一致”。

## 本轮实测命令

```bash
/Users/hxx/.nvm/versions/node/v22.22.2/bin/node -v
# v22.22.2

/Users/hxx/.nvm/versions/node/v22.22.2/bin/node -p "process.versions.modules"
# 127

/Users/hxx/.nvm/versions/node/v22.22.2/bin/node NOE_PHASE2_SECRET_GATE.mjs
# PASS - 所有 .md 交付物无真实密钥，BaiLongma-audit/config.json 被 gitignore 隔离

/Users/hxx/.nvm/versions/node/v22.22.2/bin/node NOE_PHASE4_VERIFY.mjs
# 9/9 PASS

/Users/hxx/.nvm/versions/node/v22.22.2/bin/node node_modules/vitest/vitest.mjs run tests/unit/schema-migrations.test.js tests/unit/server-route-wiring.test.js tests/unit/routes/noe-routes.test.js tests/unit/noe-memory-focus.test.js tests/unit/noe-loop-toolregistry.test.js
# 5 files passed, 14 tests passed

/Users/hxx/.nvm/versions/node/v22.22.2/bin/node NOE_M1_ISOLATION_SMOKE.mjs
# 8/8 PASS - 51835 真启停，51735 PID 前中后不变

/Users/hxx/.nvm/versions/node/v22.22.2/bin/node NOE_PHASE5_VERIFY.mjs
# Result: 29/29 checks passed（第 2 轮补强 owner-token 路由证据后）
```

## UI 证据

- Browser 插件路径已尝试，但当前运行时返回 `Browser is not available: iab`，因此按前端调试技能 fallback 到项目自带 Playwright。
- 本地服务使用 Node 22.22.2 启动在 `http://127.0.0.1:51835/`。
- Playwright 验证结果：
  - 页面标题：Noe
  - Brain UI 面板数：6
  - Health：ok
  - 可见弹窗数：0
  - Memory 写入并召回 `CE05 Playwright memory evidence`
  - Focus Push 显示 `CE05 UI focus evidence`
  - 手动 Tick 后 Thought Stream 出现 `manual_tick`
  - 截图：`/tmp/noe-brain-ui-ce05-clean.png`
  - 第 2 轮补强截图：`/tmp/noe-brain-ui-ce05-round2.png`，确认 6 面板可见、Health=`ok`、Memory/Focus/Tick 交互均有页面状态证据。

## 工程闭环衔接

1. 用户想法：仍以 Noe 为主产品底座，吸收 BaiLongma 思路，不硬拼项目。
2. 需求分析：继承阶段 2 canonical 的 UR/FR/NFR 与 secret 门。
3. 技术方案：继承阶段 3 canonical 的 in-process、加法不改存量、默认关闭策略。
4. 任务分配：继承阶段 4 canonical 的 M0-M5-P2 队列与 CP-A/CP-B/CP-C/CP-D。
5. 代码开发：本文件记录已落地代码面；本轮补齐 ToolRegistry shell guard 与阶段 5 验收门。
6. 单元测试：Noe 相关 5 个测试文件、14 个用例通过。
7. 集成测试：隔离 smoke 证明 51835 与 51735 零影响；阶段 7 可继续扩展 owner-token + budget cap 集成脚本。
8. 功能验证：Playwright 已覆盖 Brain UI 的写 Memory、推 Focus、手动 Tick 和健康展示。
9. 文档编写：本文件作为阶段 5 代码开发记录，后续文档阶段可整理为用户手册和 API 说明。
10. 交付验收：阶段 5 验收入口为 `NOE_PHASE5_VERIFY.mjs` + UI 截图 + smoke 输出。
11. 复盘优化：下一阶段重点关注完整集成测试、截图归档策略、P2 Voice/Social 契约延后防抢跑。
