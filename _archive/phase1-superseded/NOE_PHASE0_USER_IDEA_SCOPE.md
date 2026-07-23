# NOE Phase 0 用户想法目标契约

日期：2026-06-01

工作区：`/Users/hxx/Desktop/Neo 贾维斯`

当前阶段：`用户想法`

来源交接：`HANDOFF_2026-06-01_Noe_融合可行性结论.md`

## 一句话目标

Noe / Neo 贾维斯要作为新的主产品底座，吸收 BaiLongma 的持续循环、记忆、焦点栈、Brain UI、语音、社交输入输出和工具市场思路，逐步形成一个本地优先、可审计、可控的个人 AI 操作系统；本阶段只把目标、边界、不可做事项和成功标准固定下来，不进入功能开发。

## 项目身份

- 新项目：`Noe / Neo 贾维斯`
- 可执行工作区：`/Users/hxx/Desktop/Neo 贾维斯`
- 原稳定项目：`/Users/hxx/Desktop/00_项目/05_Claude可视化面板`
- 目标融合仓库：`https://github.com/xiaoyuanda666-ship-it/BaiLongma`
- BaiLongma 审计镜像路径：`/Users/hxx/Desktop/Neo 贾维斯/BaiLongma-audit`

## 主判断

Noe + BaiLongma 融合可行，但融合方式不是项目硬拼，也不是全量复制 BaiLongma。正确路线是以 Noe 为唯一主产品和唯一桌面入口，先审计 BaiLongma，再按模块和思想逐步吸收。

## 范围内

- 固定 Noe 的项目目标、边界、成功标准和风险假设。
- 将 BaiLongma 定位为可审计的模块来源和产品体验参考。
- 将后续第一步明确为只读审计 BaiLongma。
- 保留 Noe 现有工程底座：Electron、本地服务、owner-token、安全守卫、多模型适配、集群协同、项目房间、任务交付和测试体系。
- 后续按顺序推进：BaiLongma 审计、Noe 端口隔离验证、NoeLoop、Memory Core、Brain UI Lite、语音与社交体验。

## 范围外

- 本阶段不写业务代码。
- 本阶段不接入 BaiLongma 工具执行能力。
- 本阶段不复制 BaiLongma 全量源码到 Noe 主源码结构。
- 本阶段不修改原稳定项目目录。
- 本阶段不启动长期后台任务、语音、社交、工具市场或完整 Jarvis 体验。

## 硬边界

- 只在 `/Users/hxx/Desktop/Neo 贾维斯` 内工作。
- 不把 `/Users/hxx/Desktop/00_项目/05_Claude可视化面板` 作为开发目标。
- 不让 BaiLongma 作为长期并行服务与 Noe 同跑。
- 不绕过 Noe 现有 owner-token、安全审批、审计日志和预算控制。
- 不在未完成 LICENSE、依赖、工具权限、数据库和启动链路审计前复用 BaiLongma 代码。

## 成功标准

- 任一成员都能复述：Noe 是主产品，BaiLongma 是被审计和模块化吸收的参考来源。
- 任一成员都能复述：第一件事是只读审计 BaiLongma，而不是写融合代码。
- 任一成员都能复述：Noe 使用 `51835`，原稳定项目保留 `51735`，二者不能互相污染。
- 任一成员都能复述：后续实现顺序是审计、启动隔离、NoeLoop、Memory Core、Brain UI Lite、语音和社交。
- 任一成员都能复述：禁止全量复制、禁止未审计接入工具执行、禁止改原项目目录。

## 风险假设

- BaiLongma 的 LICENSE、依赖、数据库 schema、Electron 启动链路和工具市场权限可能不适合直接复用。
- BaiLongma 的持续 TICK loop 可能与 Noe 的房间任务、集群协同、预算和用户优先级冲突。
- BaiLongma 的 Memory / Focus Stack 可能与 Noe 现有 EvidenceKnowledge、AgentRun、ActivityLog、Knowledge Center 发生数据边界冲突。
- Brain UI 的价值较高，但直接移植可能造成前端路由、状态协议和服务边界混乱。
- 语音、社交和工具市场属于高复杂度功能，过早进入会拖慢 MVP 并扩大安全面。

## 工程闭环落地

1. 用户想法：本文件固定项目目标、范围边界、不可做事项、成功标准和风险假设。
2. 需求分析与拆解：基于本文件拆出 BaiLongma 只读审计清单、Noe 启动隔离清单、NoeLoop MVP 清单、Memory Core 清单、Brain UI Lite 清单。
3. 技术方案设计：以 Noe 为主架构，设计 NoeLoop、Memory Core、Brain UI Lite 与现有 owner-token、房间任务、预算、审计日志的接入点。
4. 任务分配与排期：按“审计先行、最小闭环优先、安全能力后置”的原则排期，语音、社交、工具市场不得排到审计和 MVP 前面。
5. 代码开发：只在审计和方案通过后开发，先做最小 NoeLoop，再做 Memory Core，再做 Brain UI Lite。
6. 单元测试：为 tick 调度、任务优先级、预算保护、记忆写入/召回、权限拒绝路径补最小单测。
7. 集成测试：验证 Noe `51835` 与原稳定项目 `51735` 可并存，验证 NoeLoop 不打断用户任务和集群任务。
8. 功能验证：用实际任务证明 Noe 能空闲思考、接收用户输入、记录记忆、展示 Brain UI 状态，并能暂停/恢复。
9. 文档编写：持续维护 `NOE_BAILONGMA_ARCH_AUDIT.md`、阶段交接、验证报告和下一阶段入口。
10. 交付验收：以可运行 Noe、可读审计、可复现验证命令、明确风险清单和用户可确认的界面行为作为验收依据。
11. 复盘优化：复盘模块吸收是否过重、安全边界是否清晰、预算是否可控、用户是否能理解 Noe 当前状态。

## 下一阶段入口

下一阶段应进入“需求分析与拆解 / 只读审计 BaiLongma”。审计对象限制在工作区内镜像 `BaiLongma-audit`，输出写入 `NOE_BAILONGMA_ARCH_AUDIT.md`，不得在审计前接入 BaiLongma 的工具执行能力。
