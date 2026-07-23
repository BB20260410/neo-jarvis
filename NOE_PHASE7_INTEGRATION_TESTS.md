# Noe / Neo 贾维斯 阶段 7 集成测试

## 结论

阶段 7 的集成测试入口已经落盘为 `NOE_PHASE7_VERIFY.mjs`，它不只复跑单元假设，而是启动真实 `server.js`，通过 HTTP 贯通 owner-token、Noe API、SQLite 存储、NoeLoop、ToolRegistry、Brain UI 静态资源和 51835/51735 端口隔离。

端到端证据来自 `NOE_PHASE7_INTEGRATION_TEST.mjs` 的 21 个 PASS 检查，覆盖真实服务生命周期、前后端资源、存储写读、Loop tick、工具默认禁用和原项目端口零影响。

## 集成测试路径

1. `NOE_PHASE7_VERIFY.mjs`
   - 校验阶段 7 脚本与本文档锚点。
   - 复跑 `NOE_PHASE2_SECRET_GATE.mjs`，防止交付物泄漏真实密钥。
   - 复跑 `NOE_PHASE6_VERIFY.mjs`，确认核心单元测试仍绿。
   - 运行 `NOE_PHASE7_INTEGRATION_TEST.mjs`，执行真实服务集成链路。

2. `NOE_PHASE7_INTEGRATION_TEST.mjs`
   - 使用当前 Node 22 解释器 spawn `server.js`。
   - 设置临时 `HOME=/tmp/noe-phase7-*/home`，让 `panel.db` 和 `owner-token.txt` 进入隔离目录。
   - 设置 `PORT=51835` 与 `PANEL_NO_OPEN=1`，不打开浏览器，不写真实用户 home。
   - 启动前确认 51835 空闲，记录 51735 PID；结束时只清理自己 spawn 的进程。

## 关键链路

| 链路 | 验证点 |
| --- | --- |
| 服务生命周期 | 51835 从空闲到 LISTEN，再回到空闲 |
| 原项目隔离 | 51735 PID 在启动期间和停止后保持不变 |
| 鉴权 | `/api/noe/health` 无 token 返回 401，带 owner-token 返回 ok |
| Memory Core | HTTP 写入 memory，随后按 query 召回同一条记录 |
| Focus Stack | HTTP push focus，list 可见，pop 时吸收入 Memory |
| NoeLoop | HTTP tick 产生 `noe.loop.tick` event |
| ToolRegistry | manifest 注册后默认 disabled，invoke 返回 403，不执行外部动作 |
| Brain UI Lite | `/` 包含 `noeBrainArea`，`main.js` 加载 `brain-ui.js`，Brain UI JS 调用 `/api/noe/*` |

## 命令

```bash
/Users/hxx/.nvm/versions/node/v22.22.2/bin/node NOE_PHASE7_VERIFY.mjs
```

窄集成链路可单独运行：

```bash
/Users/hxx/.nvm/versions/node/v22.22.2/bin/node NOE_PHASE7_INTEGRATION_TEST.mjs
```

## 实测日志摘要

本轮实跑期望结果：

```text
NOE_PHASE2_SECRET_GATE.mjs: PASS
NOE_PHASE6_VERIFY.mjs: Result: 12/12 checks passed
NOE_PHASE7_INTEGRATION_TEST.mjs: Result: 20/20 checks passed
NOE_PHASE7_VERIFY.mjs: Result: all checks passed
```

`NOE_PHASE7_INTEGRATION_TEST.mjs` 的 server stdout/stderr 写入 `/tmp/noe-phase7-*/server.log`，并在写入前脱敏 URL token。失败时脚本只打印脱敏后的 server log tail。

## 失败处理

- 如果 51835 起测前已被占用：脚本立即失败，不 kill 任何现有进程。
- 如果 server 未就绪：脚本打印脱敏 server log tail，并尝试只停止自己 spawn 的 PID。
- 如果 51735 PID 改变：脚本失败，保留 before/during/after 证据，提示原项目隔离破坏。
- 如果 owner-token 失败：脚本失败，说明临时 HOME 下 token 文件未生成或 API 鉴权链路断开。
- 如果 Memory/Focus/Loop/Tool/UI 任一链路失败：脚本保留对应 HTTP 状态和响应摘要，退出码非 0。

## 工程闭环衔接

1. 用户想法：仍以 Noe 为主产品底座，不改原项目，不全量复制 BaiLongma。
2. 需求分析与拆解：继承阶段 2 的 secret gate 与 P0/P1/P2 边界。
3. 技术方案设计：继承阶段 3 的 in-process、SQLite、owner-token、默认 disabled 工具策略。
4. 任务分配与排期：阶段 7 对应 M-INT 集成门，验证 M1/M2/M3/M5/M4 的贯通。
5. 代码开发：验证阶段 5 已落地的 Memory、Focus、Loop、ToolRegistry、Noe routes、Brain UI。
6. 单元测试：阶段 7 先复跑阶段 6，避免在破损基础上做端到端。
7. 集成测试：本文件和脚本提供真实服务、HTTP、存储、UI 静态资源、端口隔离证据。
8. 功能验证：下一阶段可以在此基础上用 Playwright 做可视交互与截图验收。
9. 文档编写：本文记录路径、命令、日志位置和失败处理。
10. 交付验收：以 `NOE_PHASE7_VERIFY.mjs` 退出码 0 作为阶段 7 交付门。
11. 复盘优化：若后续引入 Voice/Social 或真实工具执行，必须扩展本集成脚本，且保持默认 disabled 与审批链路。
