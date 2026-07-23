# Noe / Neo 贾维斯 x BaiLongma 融合：阶段 1 用户想法契约

日期：2026-06-01  
产出成员：GPT / xike-builder  
阶段：1. 用户想法  
工作目录：`/Users/hxx/Desktop/Neo 贾维斯`

## 1. 一句话目标

把 Noe / Neo 贾维斯做成新的本地优先个人 AI 操作系统底座：保留 Noe 现有 Electron、本地 API、owner-token、多模型、集群协同、项目房间和交付验证能力；只吸收 BaiLongma 的 TICK loop、Memory、Focus Stack、Brain UI、Voice、Social I/O 和工具市场思路，形成 Jarvis 感体验。融合方式是模块化消化吸收，不是把 BaiLongma 整包复制进 Noe。

## 2. 本阶段目标

本阶段只把用户原始想法固化为所有成员都能复述的目标、范围、边界、成功标准和风险假设。  
本阶段不写产品功能代码，不接入工具执行能力，不修改原稳定项目。

## 3. 已核对事实

- Noe 工作目录是 `/Users/hxx/Desktop/Neo 贾维斯`。
- 原稳定项目目录 `/Users/hxx/Desktop/00_项目/05_Claude可视化面板` 存在，但本轮只读确认，不进入开发。
- BaiLongma 只读审计副本 `/Users/hxx/Desktop/BaiLongma-audit` 已存在；本阶段只作为后续审计输入。
- Noe 包为 `noe@2.1.0`。
- BaiLongma 包为 `bailongma@2.1.179`，`main=electron/main.cjs`，`type=module`。
- 当前端口旁证：`127.0.0.1:51735` 有原项目 node 进程监听，`51835` 未监听；后续 Noe 启动验证必须使用 51835 且不影响 51735。
- BaiLongma `src` 下可见 `memory`、`context`、`ui/brain-ui`、`voice`、`social`、`capabilities/marketplace` 等待审计模块。

## 4. 范围内

1. 只读审计 BaiLongma，输出 `/Users/hxx/Desktop/Neo 贾维斯/NOE_BAILONGMA_ARCH_AUDIT.md`。
2. 验证 Noe 可在 `51835` 启动，并与原项目 `51735` 隔离。
3. 设计并实现 NoeLoop 最小闭环，吸收 TICK loop 思路。
4. 设计并实现 Memory Core，吸收 BaiLongma 记忆和焦点栈思路。
5. 做 Brain UI Lite，让循环、记忆、任务、模型状态可视化。
6. 在上述稳定后，再做语音、社交 I/O 和 Jarvis 体验层。

## 5. 范围外和红线

- 不在原项目 `/Users/hxx/Desktop/00_项目/05_Claude可视化面板` 改文件。
- 不把 BaiLongma 全量复制进 Noe。
- 不把 Noe 改造成 BaiLongma，也不让两个服务长期并行常驻。
- 不在只读审计完成前接入 BaiLongma `capabilities/marketplace` 或任何工具执行能力。
- 不占用或干扰原项目端口 `51735`。
- 不在本阶段做 `npm install`、重启 panel、提交 git、推送远端或启动长期后台任务。
- 如果后续采用 BaiLongma 代码，必须保留 MIT 许可声明。

## 6. 成功标准

### 本阶段成功标准

- 有一份落盘目标契约，覆盖目标、范围、不可做事项、成功标准和风险假设。
- 任一成员可复述同一目标：Noe 做主产品底座，吸收 BaiLongma 能力思路，不硬拼两个项目。
- 任一后续任务都能用一句判定做范围检查：这一步是否加强 Noe 底座，或吸收 BaiLongma 的单个能力点？是则继续，否则视为范围漂移。
- 本阶段有真实命令证据和文件回读证据。

### 后续里程碑成功标准

- M0 审计：`NOE_BAILONGMA_ARCH_AUDIT.md` 写明架构、依赖、LICENSE、数据库 schema、可移植点和风险。
- M1 启动隔离：Noe 在 `51835` 可访问，原项目 `51735` 不受影响。
- M2 NoeLoop：最小可开关心跳闭环可运行，默认不烧 token、不抢用户任务。
- M3 Memory Core：记忆可写、可查、可删除，重启不丢，数据边界清晰。
- M4 Brain UI Lite：面板能看见循环状态、记忆召回、任务和模型状态。
- M5 体验层：语音和社交默认关闭，按需启用，全部走 Noe 安全和审计体系。

## 7. 风险假设

- 假设 BaiLongma 模块可拆解；若审计发现强耦合，则先吸收设计思想，不直接移植代码。
- 假设 Noe 现有安全、预算、任务、房间和审计体系是主边界；NoeLoop 和工具市场必须服从这些边界。
- 假设持续意识循环有成本风险；默认关闭，必须有频率、空闲阈值、预算和日志上限。
- 假设记忆系统存在数据模型冲突；先建桥接层，不混写 Noe 既有数据。
- 假设工具市场是最高风险模块；审计和安全设计前不接入。
- 假设目录边界比融合速度更重要；所有产物写入 Noe，原项目只允许只读核对。

## 8. 11 阶段工程闭环落地

1. 用户想法：本文件锁定目标、边界、成功标准、风险假设。
2. 需求分析与拆解：把范围内 6 项拆成审计、启动隔离、NoeLoop、Memory Core、Brain UI Lite、体验层 backlog。
3. 技术方案设计：以只读审计结论决定哪些能力只借鉴、哪些可重写、哪些可局部移植。
4. 任务分配与排期：按 M0 到 M5 串行推进，工具市场和社交排在审计与安全设计之后。
5. 代码开发：只在 Noe 目录按现有项目风格开发，小步提交候选变更，不碰原项目。
6. 单元测试：新增 loop、memory、route、安全边界的最小单测。
7. 集成测试：验证 51835 服务、owner-token、房间任务、记忆读写和 UI 路由组合。
8. 功能验证：用可复现命令、curl、UI 截图或日志证明每个里程碑可用。
9. 文档编写：持续更新审计文档、阶段 handoff 和使用说明。
10. 交付验收：按本文件成功标准和后续里程碑逐条验收。
11. 复盘优化：评估 Jarvis 体验、资源消耗、安全事件和用户操作摩擦，再决定下一轮吸收顺序。

## 9. 下一阶段输入

下一阶段应进入需求分析与拆解，但第一项实际工程动作必须是只读审计 BaiLongma，并把结论写入 `/Users/hxx/Desktop/Neo 贾维斯/NOE_BAILONGMA_ARCH_AUDIT.md`。审计前不得接入 BaiLongma 的工具执行能力。
