# Noe / Neo 贾维斯 阶段 8 功能验证

阶段：8. 功能验证

目标：站在用户场景验证 Noe Brain 主路径是否能真实完成目标，而不是只依赖单元测试或接口 smoke。

范围边界：
- 只在 `/Users/hxx/Desktop/Neo 贾维斯` 工作。
- 不修改 `/Users/hxx/Desktop/00_项目/05_Claude可视化面板`。
- 不复制 BaiLongma 全量代码。
- 不接入真实工具执行能力，工具只验证 manifest-only 且默认 disabled。
- Voice / Social 仍属于 P2 后续阶段，本阶段不抢跑。

## 功能验证步骤

用户主路径：
1. 使用 Node 22 启动 Noe 到 `http://127.0.0.1:51835`。
2. 使用隔离 `HOME` 生成临时 owner token 和临时 SQLite 数据，不污染真实 `~/.noe-panel`。
3. 访问带 `?t=<owner-token>` 的 Noe 页面，确认页面会捕获 token。
4. 从侧栏点击 `Brain`，打开 Noe Brain 面板。
5. 验证 Health 为 `ok`，Loop / Memory / Focus 三个核心面板可见。
6. 通过 UI 写入一条 Memory，再用搜索框召回同一条 Memory。
7. 通过 UI Push 一个 Focus Stack 项，确认列表显示。
8. 通过 UI 点击 Tick，确认 Thought Stream 出现 `manual_tick`。
9. 通过 API 注册一个工具 manifest，刷新 UI 后确认工具列表可见且默认 `disabled`。
10. 截取桌面和移动视口截图。
11. 清理测试 server，确认 `51835` 归还，`51735` 原项目端口前后不变。

Browser 路径说明：
- 已按 Browser 插件规则尝试连接 in-app Browser。
- 当前运行时返回 `Browser is not available: iab`。
- 本阶段按前端验证规则 fallback 到项目依赖的 Playwright，并在脚本输出中记录 fallback 原因。

## 输入输出

输入：
- URL：`http://127.0.0.1:51835/?t=<owner-token>`
- Memory 文本：`phase8 user memory <runId> recall-signal`
- Memory 搜索词：`recall-signal`
- Focus 标题：`phase8 focus <runId>`
- Tool manifest：`Phase8 Disabled Tool`

期望输出：
- 页面标题为 `Noe`。
- Noe Brain 面板可见。
- Health 显示 `ok`。
- Memory 写入后可见，搜索后仍可召回。
- Focus Stack 显示新增 focus。
- Thought Stream 出现 `manual_tick`。
- Tool 列表显示 `Phase8 Disabled Tool` 且状态为 `disabled`。
- 浏览器无相关 console error / warning。
- `51735` 原项目端口不受影响。

## 截图 / 日志 / 接口结果

阶段 8 可复跑入口：

```bash
/Users/hxx/.nvm/versions/node/v22.22.2/bin/node NOE_PHASE8_VERIFY.mjs
```

窄功能 walkthrough：

```bash
/Users/hxx/.nvm/versions/node/v22.22.2/bin/node NOE_PHASE8_FUNCTIONAL_WALKTHROUGH.mjs
```

输出产物位置：
- 截图：`output/playwright/phase8-*-desktop.png`
- 移动截图：`output/playwright/phase8-*-mobile.png`
- server 日志：`output/playwright/phase8-*-server.log`
- 结果摘要：`output/playwright/phase8-*-result.txt`

本轮实跑结果：
- 命令：`/Users/hxx/.nvm/versions/node/v22.22.2/bin/node NOE_PHASE8_VERIFY.mjs`
- 总验证门：`Result: 12/12 checks passed`
- 功能 walkthrough：`Result: 26/26 checks passed`
- runId：`phase8-1780336146452`
- 桌面截图：`output/playwright/phase8-1780336146452-desktop.png`
- 移动截图：`output/playwright/phase8-1780336146452-mobile.png`
- server 日志：`output/playwright/phase8-1780336146452-server.log`
- 结果摘要：`output/playwright/phase8-1780336146452-result.txt`
- 端口隔离：`51835` 测试结束后空闲；`51735` 前后均为 PID `73664`。

本阶段交付文件：
- `NOE_PHASE8_FUNCTIONAL_WALKTHROUGH.mjs`
- `NOE_PHASE8_VERIFY.mjs`
- `NOE_PHASE8_FUNCTIONAL_VERIFICATION.md`

## 工程闭环衔接

1. 用户想法：继续以 Noe 为主产品底座，不回退到 Xike Lab 原项目。
2. 需求分析与拆解：继承 `NOE_PHASE2_REQUIREMENTS_CANONICAL.md` 的 P0/P1 功能边界。
3. 技术方案设计：继承 `NOE_PHASE3_TECH_DESIGN_CANONICAL.md` 的 in-process、加法不改存量方案。
4. 任务分配与排期：继承 `NOE_PHASE4_TASK_PLAN_CANONICAL.md`，本阶段聚焦 CP-C 后的用户主路径。
5. 代码开发：验证阶段 5 已落地的 Memory / Focus / Loop / ToolRegistry / Brain UI。
6. 单元测试：阶段 8 验证门先跑 secret gate，单元覆盖由阶段 6 保持。
7. 集成测试：阶段 8 复用阶段 7 已验证的真 server / HTTP / SQLite / owner-token 链路。
8. 功能验证：本文件和 `NOE_PHASE8_VERIFY.mjs` 给出用户主路径复现证据。
9. 文档编写：下一阶段可把本验证步骤合入交付文档和 handoff。
10. 交付验收：下一阶段以 `NOE_PHASE8_VERIFY.mjs` 作为功能验收前置门。
11. 复盘优化：后续复盘重点看 Browser 插件不可用 fallback、移动视口体验、Voice/Social P2 准入。
