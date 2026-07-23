# Noe / Neo 贾维斯 阶段 1：用户想法目标契约（GPT 版）

生成时间：2026-06-01
执行成员：GPT / xike-builder
当前阶段：1. 用户想法
工作区：`/Users/hxx/Desktop/Neo 贾维斯`
依据文档：`HANDOFF_2026-06-01_Noe_融合可行性结论.md`
目标融合仓库：`https://github.com/xiaoyuanda666-ship-it/BaiLongma`

## 1. 一句话目标

将 `Noe / Neo 贾维斯` 打造成本地优先的 Electron AI 助手主产品底座，保留其在多模型协同、任务执行、安全守卫和交付体系上的优势。在完成对 BaiLongma 项目的只读审计后，分阶段吸收其 TICK loop、Memory、Focus Stack、Brain UI、Voice、Social I/O 和工具市场等核心理念和可移植模块。

## 2. 用户想法转译

用户明确指出，本项目并非原 `Xike Lab` 稳定项目的延续，也不是将 `BaiLongma` 项目整体复制到 `Noe` 中。其核心诉求是：

-   `Noe` 将作为唯一的主产品底座和长期演进方向。
-   `BaiLongma` 应被视为架构灵感的来源和可模块化吸收的组件库。
-   整合策略应为“审计后模块化吸收”，而非简单合并或硬性拼接。
-   首要任务是只读审计 `BaiLongma`，而非直接进行功能开发。
-   未来的开发工作必须严格围绕 `Noe` 自身的端口、数据存储、安全模型及集群协同框架展开。

## 3. 硬边界与不可做事项

### 3.1 硬边界

-   **工作区限制**：所有读写操作必须严格限制在 `/Users/hxx/Desktop/Neo 贾维斯` 目录内。
-   **原项目隔离**：`/Users/hxx/Desktop/00_项目/05_Claude可视化面板` 仅作参考，严禁进行任何修改。
-   **BaiLongma 审计路径**：`BaiLongma-audit` 目录必须位于 `/Users/hxx/Desktop/Neo 贾维斯/BaiLongma-audit`，且仅进行只读审计。
-   **模块化吸收**：禁止将 `BaiLongma` 项目全量或未经审计的代码直接复制到 `Noe` 源码中。
-   **安全前置**：在未完成对 `BaiLongma` 的安全、License、依赖、数据库和工具权限的全面审计前，严禁接入其任何工具执行能力。
-   **单体运行**：禁止让 `BaiLongma` 作为独立的长期服务与 `Noe` 并行运行。
-   **阶段性约束**：在“用户想法”阶段，严禁启动 `Noe` 服务、修改代码、修改 UI 或修改数据库 schema。

### 3.2 明确不可做事项

-   **禁止“BaiLongma 全量移植”**：不得将 `BaiLongma` 的所有功能不加选择地复制到 `Noe`。
-   **禁止“把 Noe 改造成 BaiLongma”**：`Noe` 必须保持其核心特性和设计理念。
-   **禁止跳过审计**：不得跳过 `BaiLongma` 只读审计阶段直接进行 `NoeLoop` 等后续功能开发。
-   **禁止多线并行**：在当前阶段，不得同时推进 `NoeLoop`、`Memory`、`Brain UI`、`Voice`、`Social` 和工具市场等多个模块的开发。
-   **禁止未审计工具**：不得为未经安全审计的模块开放 `exec`、`fetch`、文件写入等高风险工具执行权限。
-   **禁止端口冲突**：不得占用或破坏原项目 `51735` 端口，确保 `Noe` 独立运行环境。
-   **禁止任务混淆**：不得将现有集群协同任务与后台空闲（idle）循环混淆。

## 4. 本阶段成功标准

在“用户想法”阶段结束时，所有成员均能对以下目标达成一致并清晰复述：

-   **项目名称**：`Noe / Neo 贾维斯`。
-   **主工作目录**：`/Users/hxx/Desktop/Neo 贾维斯`。
-   **原项目处理**：`/Users/hxx/Desktop/00_项目/05_Claude可视化面板` 不得被修改。
-   **融合对象**：`BaiLongma`。
-   **融合策略**：`Noe` 为主体，模块化吸收 `BaiLongma` 的理念和组件。
-   **下一阶段核心任务**：只读审计 `BaiLongma`，并产出 `NOE_BAILONGMA_ARCH_AUDIT.md`。
-   **未来技术路线**：审计 -> 51835 启动隔离验证 -> NoeLoop 最小闭环 -> Memory Core -> Brain UI Lite -> Voice/Social/Jarvis 体验。

## 5. 风险假设

-   **技术栈兼容性**：`BaiLongma` 与 `Noe` 的技术栈（Node.js, Electron, 前端框架等）可能存在不兼容或版本冲突，需在审计阶段识别。
-   **License 与依赖**：`BaiLongma` 的开源许可证、外部依赖可能与 `Noe` 的商业或安全要求冲突，或引入新的安全漏洞。
-   **数据库 Schema 冲突**：`BaiLongma` 的数据模型（如 Memory）可能与 `Noe` 现有 `EvidenceKnowledge`、`AgentRun`、`ActivityLog` 等存在潜在冲突。
-   **TICK Loop 干扰**：直接引入 `BaiLongma` 的 TICK loop 机制可能与 `Noe` 现有任务调度、集群协同机制冲突，导致资源抢占或模型额度不当消耗。
-   **UI 整合复杂性**：`BaiLongma` 的 `Brain UI` 可能与 `Noe` 现有 UI 框架、路由、状态管理和视觉设计存在显著差异，直接整合风险高。
-   **安全面扩展**：过早引入语音、社交和工具市场等功能将大幅扩大项目的安全攻击面和测试工作量。
-   **未提交改动**：当前 `Noe` 工作区可能存在大量未提交的改动，需谨慎处理，避免对未来开发造成干扰。

## 6. 工程闭环落地方式

本任务将严格遵循如下工程闭环链路，当前处于第一阶段：

1.  **用户想法**（当前阶段）：通过本文档清晰定义项目目标、范围、硬边界、不可做事项、成功标准和风险假设，确保全员对项目愿景达成共识。
2.  **需求分析与拆解**：基于本阶段确立的 `BaiLongma` 审计清单、`Noe` 端口隔离、`NoeLoop`、`Memory Core`、`Brain UI Lite` 及后续模块，详细分析和拆解需求。
3.  **技术方案设计**：在完成 `BaiLongma` 审计（产出 `NOE_BAILONGMA_ARCH_AUDIT.md`）后，设计 `Noe` 自身的 `Loop`、`Memory`、UI 整合、工具权限管理和数据桥接方案，而非盲目照搬。
4.  **任务分配与排期**：按照“审计 -> 隔离验证 -> 最小闭环 -> 记忆 -> UI -> 语音/社交”的串行路径进行任务分配和排期，确保每个阶段目标明确、可验证。
5.  **代码开发**：在当前阶段不进行代码开发。后续开发只在 `Noe` 目录下进行，优先复用 `Noe` 现有模块和安全守卫。
6.  **单元测试**：针对 `NoeLoop`、`Memory Core`、权限门禁、路由和数据存储等关键模块编写窄范围单元测试。
7.  **集成测试**：验证 `Noe` 端口 `51835`、数据目录 `~/.noe-panel`、`owner-token`、安全审批和集群协同等核心功能不受集成影响。
8.  **功能验证**：通过浏览器或 Electron UI 验证 `Brain UI Lite`、任务流、记忆召回、暂停/继续以及错误可见性等用户可见功能。
9.  **文档编写**：持续更新 `NOE_BAILongma_ARCH_AUDIT.md`、阶段交接文档、验证报告以及后续阶段的提示文档。
10. **交付验收**：每个阶段需提供文件证据、命令输出、端口/进程证据、测试结果和剩余风险，以供验收。
11. **复盘优化**：记录并分析范围漂移、安全风险、模型额度消耗、后台 `Loop` 干扰以及 UI 可理解性等问题，持续优化。

## 7. 下一阶段衔接

下一阶段的核心任务是**只读审计 BaiLongma**。建议执行以下命令以开始审计过程，并将审计结果记录到 `NOE_BAILONGMA_ARCH_AUDIT.md` 文件中。

```bash
cd "/Users/hxx/Desktop/Neo 贾维斯"
# 再次确认 BaiLongma-audit 目录是否存在
test -d "BaiLongma-audit" && printf 'BaiLongma-audit 目录存在
' || printf 'BaiLongma-audit 目录不存在，请先克隆！
'

# 列出需要审计的关键文件和目录
find "BaiLongma-audit" -maxdepth 3 -type f -regex ".*\.\(js\|json\|md\|txt\|html\)" -print | 
grep -E '(package\.json|src/index\.js|src/memory|src/context|src/ui/brain-ui|src/voice|src/social|src/capabilities/marketplace|electron|config\.json|LICENSE|schema)' | sort
```
