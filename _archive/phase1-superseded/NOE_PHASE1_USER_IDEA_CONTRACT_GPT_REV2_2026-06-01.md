# Noe / Neo 贾维斯 阶段 1 用户想法契约（GPT Rev2）

生成时间：2026-06-01 20:42:15 CST
执行成员：GPT / xike-builder
当前阶段：1. 用户想法
工作区：`/Users/hxx/Desktop/Neo 贾维斯`
源头文档：`HANDOFF_2026-06-01_Noe_融合可行性结论.md`
目标融合仓库：`https://github.com/xiaoyuanda666-ship-it/BaiLongma`

## 1. 修订结论

采纳对方反馈：阶段 1 只固定目标章程，不继续扩写产品实现细节；下一阶段直接进入 BaiLongma 只读架构审计，并把结果集中落到 `NOE_BAILONGMA_ARCH_AUDIT.md`；审计优先核查 `LICENSE`、数据库 schema、工具 marketplace 执行面、TICK loop 与 Noe 安全 / 预算 / abort 体系冲突。

保留上一版中“阶段 1 不写代码、不启动服务、不改 UI”的判断。理由是当前闭环阶段明确是“用户想法”，完成门槛是目标、边界、成功标准和风险假设一致；端口 `51835` 启动验证属于后续阶段 2/8 的实测项，提前启动会扩大本阶段范围。

## 2. 一句话目标

把 `Noe / Neo 贾维斯` 确认为新的主产品底座：Noe 负责本地优先、多模型协同、任务执行、安全守卫和交付闭环；BaiLongma 只作为经过审计后的模块化灵感与可移植来源，重点吸收 TICK loop、Memory、Focus Stack、Brain UI、Voice、Social I/O 和工具市场思路。

## 3. 项目身份

- 新主项目：`Noe / Neo 贾维斯`
- 唯一工作区：`/Users/hxx/Desktop/Neo 贾维斯`
- 原项目边界：`/Users/hxx/Desktop/00_项目/05_Claude可视化面板` 只作为历史参考，本轮不读写、不开发、不修复
- BaiLongma 审计镜像：`/Users/hxx/Desktop/Neo 贾维斯/BaiLongma-audit`
- 审计产物：`/Users/hxx/Desktop/Neo 贾维斯/NOE_BAILONGMA_ARCH_AUDIT.md`

## 4. 范围边界

- 本阶段只产出目标契约，不写产品代码。
- 所有新增或修改文件必须位于 Noe 工作区内。
- BaiLongma 只能先做只读审计，不能作为运行时依赖直接接入。
- 融合策略是 `Noe 主体 + BaiLongma 模块化吸收`，不是整仓合并。
- Noe 后续应继续使用自己的端口、数据目录、安全模型、任务模型和交付证据体系。
- 原项目 `51735` 与 Noe `51835` 的隔离验证属于后续验证阶段，不属于本阶段实现。

## 5. 明确不可做事项

- 不把 BaiLongma 全量复制进 Noe。
- 不把 Noe 改造成 BaiLongma。
- 不跳过审计直接开发 NoeLoop、Memory Core 或 Brain UI。
- 不在未审计前接入 BaiLongma 工具执行、文件写入、网络访问、shell 执行或 marketplace 能力。
- 不让 BaiLongma 作为第二个长期后台服务与 Noe 并行运行。
- 不修改原项目 `/Users/hxx/Desktop/00_项目/05_Claude可视化面板`。
- 不在阶段 1 启动 UI 服务或引入数据库 schema 变更。

## 6. 本阶段成功标准

任何成员读完本文件后，应能一致复述：

- Noe 是主产品底座，BaiLongma 是审计后的模块化来源。
- 当前只做目标收敛，不做功能代码。
- 所有工作限定在 `/Users/hxx/Desktop/Neo 贾维斯`。
- 原项目目录不得修改。
- 下一步是 BaiLongma 只读架构审计，集中产出 `NOE_BAILONGMA_ARCH_AUDIT.md`。
- 近期路线是：审计 -> 51835/51735 隔离验证 -> NoeLoop 最小闭环 -> Memory Core -> Brain UI Lite -> Voice / Social / Jarvis 体验。

## 7. 风险假设

- BaiLongma 的 `LICENSE` 未完成可复用判断前，不能直接复制代码。
- BaiLongma 数据库 schema、SQLite / FTS / 向量召回方案可能与 Noe 现有数据结构冲突。
- BaiLongma 工具 marketplace 和工具执行面可能绕过 Noe 的审批、owner-token、abort、预算与审计机制。
- TICK loop 若直接接入，可能抢占用户任务、消耗模型额度、干扰集群协同或难以停止。
- Brain UI 直接并入 Noe 可能造成路由、状态管理、视觉体系和安全边界混乱。
- Voice、Social I/O 和 Jarvis 体验是后置能力，提前实现会扩大测试面和安全面。

## 8. 11 阶段闭环落地

1. 用户想法：本文件固定目标、边界、不可做事项、成功标准和风险假设。
2. 需求分析与拆解：把 BaiLongma 审计点拆成 License、依赖、入口、Memory、Context、Brain UI、Voice、Social、Marketplace、Electron、config、数据库 schema。
3. 技术方案设计：基于 `NOE_BAILONGMA_ARCH_AUDIT.md` 设计 Noe 自己的 loop、memory、UI、权限门禁和数据桥接。
4. 任务分配与排期：按审计、隔离验证、NoeLoop、Memory Core、Brain UI Lite、Voice/Social/Jarvis 体验串行推进。
5. 代码开发：阶段 1 不开发；后续只在 Noe 目录内改动，优先复用 Noe 现有模块。
6. 单元测试：后续为 NoeLoop、Memory Core、权限门禁、路由、数据存储补窄测试。
7. 集成测试：验证 `51835`、`~/.noe-panel`、owner-token、abort、预算和集群协同不回归。
8. 功能验证：用浏览器或 Electron 验证 UI、任务流、记忆召回、错误可见性、暂停继续。
9. 文档编写：持续更新审计、阶段交接、验证报告和下一窗口提示。
10. 交付验收：每阶段给出文件证据、命令输出、端口/进程证据、测试结果和剩余风险。
11. 复盘优化：记录范围漂移、安全风险、额度消耗、后台 loop 干扰和 UI 可理解性问题。

## 9. 下一阶段入口

下一阶段应直接进入 BaiLongma 只读架构审计，不再扩写阶段 1 目标章程。审计必须优先覆盖：

- `package.json`
- `src/index.js`
- `src/memory`
- `src/context`
- `src/ui/brain-ui`
- `src/voice`
- `src/social`
- `src/capabilities/marketplace`
- `electron`
- `config.json`
- `LICENSE`
- 数据库 schema / migration

阶段 2 的集中产物固定为：

```text
/Users/hxx/Desktop/Neo 贾维斯/NOE_BAILONGMA_ARCH_AUDIT.md
```

## 10. 本阶段证据边界

本阶段提供文件和命令证据；不提供 UI 截图或浏览器证据，因为本阶段明确不启动服务、不改 UI。UI 证据应在 `51835` 启动隔离验证和 Brain UI Lite 阶段补齐。
