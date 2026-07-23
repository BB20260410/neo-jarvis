# CE12 P0 单元测试闭环 - GPT 独立稿

生成时间：2026-06-02 14:58:39 CST
工作区：`/Users/hxx/Desktop/Neo 贾维斯`
阶段：6. 单元测试
事实源：承接 `NOE_CE12_P0_REQUIREMENTS_CANONICAL.md`、CE03 技术方案与 CE05 代码实现；本文件不替代需求事实源。当前只能表述为「CE12 P0 产品化基础进入可继续验收状态」，不是完整 Jarvis 产品完成。

## 1. 本阶段裁定

- Claude 当前不可用，本轮由 GPT-Codex 单模型接管单元测试阶段；MiniMax M3 中文侧审计仍是后续补审点，不构成本阶段普通阻断。
- 本阶段不新增 Voice/Social/完整 Jarvis 体验，不改原项目目录。
- 本阶段补齐两类单测空洞：Act Pipeline 失败分支与 retry 回归、Noe act API 状态码映射。

## 2. 单测清单

### FR-P0-1 Node22 fail-fast / re-exec gate
- `tests/unit/node22-gate.test.js`
- `tests/unit/node-runtime-gate.test.js`
- 覆盖：当前 Node22 命中、Node26 选择 pinned Node22、低于 22 fail-fast、候选不可用 fail-closed、`.nvmrc`/`NOE_NODE_BIN` 候选路径。

### FR-P0-4 Act Pipeline
- `tests/unit/noe-act-pipeline.test.js`
- `tests/unit/noe-act-pipeline-safety.test.js`
- `tests/unit/noe-act-pipeline-failure-branches.test.js`
- 覆盖：低风险 dry-run 完成、高风险进入审批、破坏性操作 `blocked_safety`、预算超限失败、NoeLoop `asHandler()` 注入点、终态 cancel 不覆盖、新增 permission deny/ask、预算恢复 retry、completed act 不允许 retry。

### FR-P0-7 MiniMaxSpawnAdapter patch-only
- `tests/unit/minimax-spawn-adapter.test.js`
- 覆盖：`diffs=[]` 才保存 proposal，非空 diff 阻断，shell/write/delete/move/apply_patch 阻断，负面安全措辞不误伤，非 JSON 输出 fail-closed。

### Noe P0 API 边界
- `tests/unit/routes/noe-routes.test.js`
- `tests/unit/routes/noe-act-routes-status.test.js`
- 覆盖：Noe API owner-token 中间件、health/memory/focus/tools/acts 路由注册、错误状态码、approval header 转发、新增 act propose 的 `201/202/403/501` 映射和 cancel missing `404`。

## 3. 本轮新增 / 修改文件

- 新增：`tests/unit/noe-act-pipeline-failure-branches.test.js`
- 新增：`tests/unit/routes/noe-act-routes-status.test.js`
- 修改：`package.json` 新增 `test:p0:unit`
- 修改：`scripts/ce12-p0-verify-all.mjs` 将两组新增单测纳入 P0 单测门
- 修改：`NOE_CE12_P0_EVIDENCE_INDEX.md` 登记 CE06 单元测试切片
- 新增：`NOE_CE12_P0_UNIT_TESTS_GPT.md`

## 4. 执行命令与结果摘要

```bash
node scripts/ensure-node22.mjs --require-22 --exec node_modules/vitest/vitest.mjs run tests/unit/noe-act-pipeline-failure-branches.test.js tests/unit/routes/noe-act-routes-status.test.js
```

结果：`Test Files 2 passed (2)`；`Tests 7 passed (7)`；exit code 0。

```bash
npm run test:p0:unit
```

结果：`Test Files 8 passed (8)`；`Tests 40 passed (40)`；exit code 0。

```bash
npm run verify:p0:fast
```

结果：4/4 轻量门通过，跳过 Electron smoke 与 Brain UI e2e；P0 单元测试门显示 `40/40 tests passed`，证据文件为 `output/ce12-p0/p0-verify-all-1780383494553.json`，exit code 0。

## 5. 与工程闭环 11 阶段的衔接

1. 用户想法：继续遵守 Noe 工作区边界，阶段完成不等于完整 Jarvis 产品完成。
2. 需求分析与拆解：单测覆盖 CE12 P0 中 Node gate、Act Pipeline、MiniMax patch-only、Noe API 边界。
3. 技术方案设计：验证 CE03 设计中的状态机、审批/阻断、fail-closed、路由状态码。
4. 任务分配与排期：完成 T1/T3/T6 的单测补强，并为 T7 证据闭环补命令入口。
5. 代码开发：本轮不扩大功能面，只为已落盘核心逻辑补失败分支与回归单测。
6. 单元测试：本文件即 CE06 交付物；`npm run test:p0:unit` 是可重复自动化验证入口。
7. 集成测试：Electron/e2e 未在本阶段重跑，仍由 CE07 使用 `npm run verify:p0` 或专项 e2e/smoke 承接。
8. 功能验证：CE08 应继续验证 Brain UI 可见状态、Act 数据流和 Electron 行为。
9. 文档编写：CE09 应引用本文件和证据索引中的单测命令，而不是只写口头完成。
10. 交付验收：CE10 可把 `npm run test:p0:unit` 与 `npm run verify:p0` 作为验收命令组合。
11. 复盘优化：CE11 需追踪 MiniMax M3 补审、Browser 插件不可用、fast run 跳过重型门这三个残余风险。

## 6. 裁定

CE06 单元测试阶段通过：核心逻辑、边界条件、失败分支和回归点均有可重复自动化验证。没有发现 secret 泄露、路径污染、原项目污染、数据破坏或不可逆操作风险。
