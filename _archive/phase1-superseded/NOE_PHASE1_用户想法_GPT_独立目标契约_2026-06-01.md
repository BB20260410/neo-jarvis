# Noe / Neo 贾维斯用户想法阶段目标契约

生成时间：2026-06-01

工作区：`/Users/hxx/Desktop/Neo 贾维斯`

## 1. 单一项目目标

本项目目标是把 `Noe / Neo 贾维斯` 建成新的主产品底座，而不是继续在原 `Xike Lab` 稳定项目上开发，也不是把 `BaiLongma` 仓库全量拼接进 Noe。

融合方向是：以 Noe 现有工程为主，先只读审计 BaiLongma，再有选择地吸收其产品与架构思想，包括 TICK loop、Memory、Focus Stack、Brain UI、Voice、Social I/O、工具市场等模块化能力。

## 2. 当前阶段定位

当前只处于工程闭环第 1 阶段：用户想法。

本阶段不写业务代码，不接入 BaiLongma 执行能力，不改 Noe 运行逻辑，不改原项目目录。

本阶段的产物是统一目标、边界、约束、成功标准和风险假设，确保后续成员对同一个目标达成一致。

## 3. 硬边界

- 只在 `/Users/hxx/Desktop/Neo 贾维斯` 内工作。
- 不修改 `/Users/hxx/Desktop/00_项目/05_Claude可视化面板`。
- BaiLongma 审计对象使用工作区内 canonical path：`/Users/hxx/Desktop/Neo 贾维斯/BaiLongma-audit`。
- 不把 BaiLongma 全量复制进 Noe。
- 不在未完成架构审计前接入工具执行、自动化调用、外部账号、社交发布或语音执行能力。
- 不把 Noe 与原 Xike Lab 的端口、状态、数据、日志混用。

## 4. 已知输入

- Noe 工作区：`/Users/hxx/Desktop/Neo 贾维斯`
- 原项目参考边界：`/Users/hxx/Desktop/00_项目/05_Claude可视化面板`
- 交接文档：`HANDOFF_2026-06-01_Noe_融合可行性结论.md`
- 目标融合仓库：`https://github.com/xiaoyuanda666-ship-it/BaiLongma`
- 审计输出目标：`NOE_BAILONGMA_ARCH_AUDIT.md`
- Noe 目标端口：`51835`
- 原项目保留端口：`51735`

## 5. 本阶段成功标准

- 任意成员都能复述：Noe 是主产品底座，BaiLongma 是只读审计与思想来源。
- 任意成员都能复述：当前不能全量迁移、不能硬拼、不能改原项目。
- 后续第一件工程动作明确为：只读审计 BaiLongma，并把结论写入 Noe 工作区内的 `NOE_BAILONGMA_ARCH_AUDIT.md`。
- 后续阶段能按统一闭环推进，而不是直接跳到功能开发。

## 6. 风险假设

- BaiLongma 的依赖、许可证、数据库 schema、Electron 结构、工具市场能力可能与 Noe 不兼容，必须先审计。
- BaiLongma 可能包含执行工具或外部 I/O 能力，未审计前直接接入会扩大权限与安全风险。
- Noe 与原项目若端口或状态文件混用，会导致验证证据不可信。
- 多成员并行容易产生范围漂移，所以每一阶段都必须先确认产物路径和不可做事项。

## 7. 工程闭环落地方式

1. 用户想法：本文件收束目标、边界、成功标准、风险假设。
2. 需求分析与拆解：把 BaiLongma 可吸收能力拆成 TICK loop、Memory、Focus Stack、Brain UI、Voice、Social I/O、工具市场、数据层、Electron 层。
3. 技术方案设计：以 Noe 架构为主，按接口、数据流、运行时权限、UI 展示、迁移成本设计最小融合方案。
4. 任务分配与排期：先审计，再验证 Noe 端口隔离，再做 NoeLoop、Memory Core、Brain UI Lite，最后做语音、社交和 Jarvis 体验。
5. 代码开发：只在审计和方案确认后做最小闭环实现，不复制 BaiLongma 整仓。
6. 单元测试：优先覆盖 NoeLoop、Memory Core、状态流转、数据读写边界。
7. 集成测试：验证 Noe 在 `51835` 启动，且不影响原项目 `51735`。
8. 功能验证：用最小用户路径验证感知、记忆、循环、展示闭环是否成立。
9. 文档编写：沉淀审计报告、融合方案、阶段交接、验证证据。
10. 交付验收：按端口隔离、最小闭环可运行、无原项目污染、无未经审计能力接入来验收。
11. 复盘优化：复盘哪些 BaiLongma 思路值得吸收，哪些应延后或拒绝。

## 8. 下一阶段入口

下一阶段是需求分析与拆解，但第一件具体工程动作应保持为只读审计 BaiLongma。

审计重点：

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
- 数据库 schema

审计结论写入：`/Users/hxx/Desktop/Neo 贾维斯/NOE_BAILONGMA_ARCH_AUDIT.md`
