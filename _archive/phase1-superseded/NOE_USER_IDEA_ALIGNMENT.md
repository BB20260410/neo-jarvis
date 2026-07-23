# Noe / BaiLongma 融合项目：用户想法阶段对齐

生成时间：2026-06-01  
工作目录：`/Users/hxx/Desktop/Neo 贾维斯`  
原稳定项目目录：`/Users/hxx/Desktop/00_项目/05_Claude可视化面板`  
目标融合仓库：`https://github.com/xiaoyuanda666-ship-it/BaiLongma`  
当前闭环阶段：用户想法

## 0. 本次事实核对

本次只做用户想法阶段对齐，未进入代码开发、BaiLongma 审计或启动验证。

已核对事实：

- 当前执行目录是 `/Users/hxx/Desktop/Neo 贾维斯`。
- 交接文件 `HANDOFF_2026-06-01_Noe_融合可行性结论.md` 存在于 Noe 目录。
- Noe 当前 `package.json` 的 `name` 是 `noe`，`productName` 是 `Noe`。
- 当前仓库已有大量既有改动和未跟踪文件，本阶段不清理、不回滚、不覆盖无关改动。
- 本阶段没有 clone `BaiLongma`，因为 clone 和只读架构审计属于下一闭环阶段。

## 1. 项目目标

本项目接手的是 `Noe / Neo 贾维斯`，不是原来的 Xike Lab 稳定项目。

目标是在不破坏 Noe 现有工程底座的前提下，评估并逐步吸收 BaiLongma 中适合 Jarvis 体验的能力，最终把 Noe 演进为一个本地优先、多模型协同、带持续意识循环和记忆能力的个人 AI 操作系统雏形。

融合原则：

- `Noe` 作为主产品底座。
- `BaiLongma` 作为架构和模块思路来源。
- 不做两个项目的硬拼接。
- 不把 BaiLongma 全量复制进 Noe。
- 不在原稳定项目目录开发 Noe。

## 2. 当前阶段范围

本阶段只负责把用户原始想法转成所有成员可复述的项目目标、边界、约束和成功标准。

本阶段要做：

- 明确 Noe 是唯一工作目录。
- 明确原稳定项目只作为历史参照，不允许修改。
- 明确 BaiLongma 必须先只读审计。
- 明确后续融合路线的先后顺序。
- 明确不能做的事项和主要风险假设。

本阶段不做：

- 不修改 Noe 代码。
- 不启动 Noe 服务。
- 不接入 BaiLongma 模块。
- 不执行 BaiLongma 工具能力。
- 不修改 `/Users/hxx/Desktop/00_项目/05_Claude可视化面板`。
- 不把 BaiLongma 代码复制进 Noe。

## 3. 推荐融合方向

Noe 保留为主底座：

- Electron 本地桌面壳。
- 本地 API 服务。
- owner-token 和安全守卫。
- 多模型适配。
- 集群协同。
- 项目房间。
- 任务执行和交付报告。
- 已有 lint、unit、e2e、package 验证体系。

BaiLongma 只吸收适合的能力思路：

- TICK loop。
- Memory。
- Focus Stack。
- Brain UI。
- Voice。
- Social I/O。
- 工具市场。

推荐实现路线：

1. 只读审计 BaiLongma。
2. 验证 Noe 自身能在 `51835` 启动，并且不影响原项目 `51735`。
3. 做 `NoeLoop` 最小闭环。
4. 做 `Memory Core`。
5. 做 `Brain UI Lite`。
6. 再做 Voice、Social I/O 和更完整的 Jarvis 体验。

## 4. 成功标准

用户想法阶段完成标准：

- 任一成员都能复述：Noe 是主产品，BaiLongma 是审计对象和能力来源。
- 任一成员都知道：只允许在 `/Users/hxx/Desktop/Neo 贾维斯` 内产出 Noe 相关文件。
- 任一成员都知道：原稳定项目目录不可修改。
- 任一成员都知道：第一件工程动作是只读审计 BaiLongma，而不是写融合代码。
- 任一成员都知道：不能全量复制 BaiLongma，也不能绕过安全审计接入工具执行能力。

下一阶段入口标准：

- 可以开始做 BaiLongma 只读架构审计。
- 审计结果必须落到 `/Users/hxx/Desktop/Neo 贾维斯/NOE_BAILONGMA_ARCH_AUDIT.md`。
- 审计重点必须覆盖 `package.json`、`src/index.js`、`src/memory`、`src/context`、`src/ui/brain-ui`、`src/voice`、`src/social`、`src/capabilities/marketplace`、`electron`、`config.json`、`LICENSE` 和数据库 schema。

## 5. 风险和假设

主要风险：

- 主循环冲突：Noe 的用户任务/房间协同可能和 BaiLongma 的持续 TICK loop 抢占资源。
- 记忆冲突：Noe 已有 EvidenceKnowledge、AgentRun、ActivityLog、Knowledge Center，不能直接并入 BaiLongma 数据库。
- 工具权限风险：BaiLongma 工具市场和工具执行能力必须进入 Noe 的审批、审计和权限分级体系。
- 服务冲突：Noe 应保持唯一 Electron 主壳，不能让 BaiLongma 长期作为并行服务混跑。
- UI 融合成本：Brain UI 应先做 Lite 版，不应一次性重构现有 UI。
- 语音和社交复杂度：Voice 和 Social I/O 有价值，但不应进入第一轮闭环核心。
- License 风险：未审计 LICENSE 和依赖前，不能复制或复用 BaiLongma 代码。

当前假设：

- Noe 的主端口是 `51835`。
- 原稳定项目端口是 `51735`。
- BaiLongma 可被 clone 到 `/Users/hxx/Desktop/BaiLongma-audit` 作为只读审计目录。
- 后续如果采用 BaiLongma 的具体代码，需要单独做 license、依赖和安全边界判断。

## 6. 工程闭环落地方式

1. 用户想法：本文件固定目标、边界、不可做事项、成功标准和风险假设。
2. 需求分析与拆解：基于 BaiLongma 只读审计，把可吸收能力拆成 loop、memory、focus、brain-ui、voice、social、marketplace 七类需求。
3. 技术方案设计：以 Noe 现有架构为主，设计 `NoeLoop`、`Memory Core`、`Brain UI Lite` 的最小可运行接口，不直接搬 BaiLongma 主循环。
4. 任务分配与排期：按风险从低到高推进，先审计和启动验证，再做最小闭环，最后做语音、社交、工具市场。
5. 代码开发：只在 Noe 目录内开发；每次开发前读取相关源文件；不新增依赖，除非审计报告明确说明并得到用户同意。
6. 单元测试：对新增 loop、memory、focus 核心逻辑写窄范围测试，优先复用现有 vitest 或项目已有脚本。
7. 集成测试：验证 `51835` Noe 服务、房间任务、owner-token、安全守卫和新增 loop/memory 不互相破坏。
8. 功能验证：用最小用户场景验证 Jarvis 体验，例如一次任务输入、一次空闲 tick、一次记忆写入、一次 Brain UI 展示。
9. 文档编写：每阶段在 Noe 目录写审计、方案、验证和交接文档，关键结论回写 handoff。
10. 交付验收：以可运行 Noe、可复现命令、测试输出、风险清单和未做事项作为验收材料。
11. 复盘优化：每轮完成后记录哪些 BaiLongma 思路可吸收、哪些必须放弃、哪些需要安全降级。

## 7. 下一步

下一步进入“需求分析与拆解 / 只读审计”。

只读审计命令边界：

```bash
cd /Users/hxx/Desktop
git clone https://github.com/xiaoyuanda666-ship-it/BaiLongma.git BaiLongma-audit
```

如果 `/Users/hxx/Desktop/BaiLongma-audit` 已存在，则不重复覆盖，先确认当前目录来源和状态。

审计产物：

```text
/Users/hxx/Desktop/Neo 贾维斯/NOE_BAILONGMA_ARCH_AUDIT.md
```
