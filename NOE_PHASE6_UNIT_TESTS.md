# Noe / Neo 贾维斯 阶段 6 单元测试

日期：2026-06-02
范围：只在 `/Users/hxx/Desktop/Neo 贾维斯` 内补阶段 6 单测；未修改产品实现代码，未触碰原项目目录，未复制 BaiLongma 代码。

## 单测清单

| 测试文件 | 新增/覆盖重点 | 对应风险 |
| --- | --- | --- |
| `tests/unit/noe-memory-focus.test.js` | Memory 空 body 失败分支、project scoped hide、upsert 后从 hidden 恢复可见、recall limit clamp、tag 归一化、Focus 空 title 失败分支、pop `absorb:false` 不写 Memory、重复 pop 返回 `null` | Memory/Focus 边界条件、跨项目误隐藏、Focus 吸收误写 |
| `tests/unit/noe-loop-toolregistry.test.js` | NoeLoop `clusterBusy` 时跳过 act 且不消耗 budget、连续 3 次 tick 错误自动 stop 并写审计、ToolRegistry invalid manifest、未知 tool 404、无 handler 501 | loop 烧预算、后台错误失控、工具市场未注册执行 |
| `tests/unit/routes/noe-routes.test.js` | Noe route 400/404 错误码映射、invoke header approval id 优先、invoke status 透传、owner-token 回归保持 | API 失败分支、审批链路丢失、路由鉴权回退 |
| `tests/unit/schema-migrations.test.js` | 既有迁移幂等、旧库备份、latest schema 版本 | DB schema 回归 |
| `tests/unit/server-route-wiring.test.js` | 既有 server route wiring 回归 | Noe 路由挂载周边回归 |

## 执行命令

```bash
/Users/hxx/.nvm/versions/node/v22.22.2/bin/node node_modules/vitest/vitest.mjs run tests/unit/schema-migrations.test.js tests/unit/server-route-wiring.test.js tests/unit/routes/noe-routes.test.js tests/unit/noe-memory-focus.test.js tests/unit/noe-loop-toolregistry.test.js
```

实测结果：

```text
Test Files  5 passed (5)
Tests       22 passed (22)
```

阶段 6 机读验证门：

```bash
/Users/hxx/.nvm/versions/node/v22.22.2/bin/node NOE_PHASE6_VERIFY.mjs
```

实测结果：

```text
Result: 12/12 checks passed
```

回归复核上一阶段代码开发门：

```bash
/Users/hxx/.nvm/versions/node/v22.22.2/bin/node NOE_PHASE5_VERIFY.mjs
```

实测结果：

```text
Result: 29/29 checks passed
```

覆盖内容：

- 检查新增测试锚点真实落盘。
- 复跑 `NOE_PHASE2_SECRET_GATE.mjs`，确保阶段交付物无真实密钥。
- 复跑 Noe 单测子集，并要求 `5 passed` / `22 passed`。

## 结果摘要

- 本阶段从阶段 5 的 `5 files / 14 tests` 扩展到 `5 files / 22 tests`。
- 新增 8 个核心单测用例，覆盖核心逻辑、边界条件、失败分支和回归点。
- 本阶段未修改 `src/`、`server.js` 或 `public/` 产品实现代码；只补测试与阶段 6 验证/记录文件。

## 工程闭环衔接

1. 用户想法：继续以 Noe 为主产品底座，不硬拼 BaiLongma。
2. 需求分析与拆解：继承阶段 2 canonical 的 Memory、Focus、NoeLoop、ToolRegistry 和 route 验收口径。
3. 技术方案设计：继承阶段 3 in-process、加法不改存量、工具默认禁用、owner-token 保护。
4. 任务分配与排期：继承阶段 4 M1/M2/M-R/M5 的测试验收项。
5. 代码开发：复核阶段 5 已落地实现，不在本阶段扩大产品代码面。
6. 单元测试：本文件和 `NOE_PHASE6_VERIFY.mjs` 是阶段 6 交付入口。
7. 集成测试：下一阶段可继续复跑 `NOE_M1_ISOLATION_SMOKE.mjs`、API 级集成和 51835/51735 隔离。
8. 功能验证：下一阶段再用 Playwright/Browser 验证 Brain UI Lite 交互，不在单测阶段抢跑。
9. 文档编写：阶段 6 清单已落盘，供后续文档整合。
10. 交付验收：可用 `NOE_PHASE6_VERIFY.mjs` 作为单测阶段可重复验收门。
11. 复盘优化：后续若新增 Voice/Social 或真实工具执行能力，必须先补对应单测再进入集成验证。
