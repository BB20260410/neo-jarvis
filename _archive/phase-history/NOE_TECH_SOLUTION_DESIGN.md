# Noe / Neo 贾维斯 — 阶段 3「技术方案设计」

**设计日期:** 2026年6月2日
**工作区:** `/Users/hxx/Desktop/Neo 贾维斯`
**阶段:** 3. 技术方案设计
**依据:** `NOE_PHASE2_REQUIREMENTS_CANONICAL.md` 及 `NOE_BAILONGMA_ARCH_AUDIT.md`。

## 1. 总体架构

Noe 将吸收 BaiLongma 的核心“意识循环”模式，构建一个模块化、可扩展的智能体底座。由于 BaiLongma 是 Electron 应用，我们将剥离其 Electron 相关的依赖，专注于其核心后端逻辑和数据层。

*   **核心层 (Noe Kernel):** 包含 NoeLoop (TICK 循环)、Memory Core (记忆存储、检索、整合、刷新) 和 Focus Stack (专注栈管理)。这是 Noe 的大脑和感知中心。
*   **适配层 (Adapters):** 负责与外部系统交互，如 LLM 适配器、工具执行器、社交连接器、语音接口。
*   **服务层 (Service Layer):** 提供 HTTP API 接口，供前端 UI 或其他客户端调用。
*   **数据层 (Data Layer):** 基于 SQLite，为 Memory Core 提供持久化存储。
*   **UI 层 (Brain UI Lite):** 一个轻量级前端，通过 HTTP API 与服务层通信，展示 Noe 的内部状态。

```mermaid
graph TD
    User -->|消息| NoeLoop
    NoeLoop -->|LLM 调用| LLM Adapter
    NoeLoop -->|工具调用| Tool Executor
    NoeLoop -->|记忆操作| Memory Core
    Memory Core --> Data Layer
    Focus Stack --> Memory Core
    NoeLoop -->|事件/状态| Service Layer
    Service Layer --> Brain UI Lite
    Service Layer --> Social Connectors
    Social Connectors -->|外部社交平台| User
    Voice Interface --> NoeLoop
    Tool Executor -->|外部工具/服务|
    Context Gatherer --> NoeLoop
```

## 2. 模块边界与数据流

*   **NoeLoop (FR-04):**
    *   **职责:** 协调整个智能体的主循环，调度 LLM 调用、工具执行和记忆处理。
    *   **实现:** 吸收 BaiLongma `src/index.js` 中的 `onTick`, `runTurn`, `scheduleNextTick` 核心逻辑，并去除所有 Electron 相关代码。
    *   **Q-2 (内嵌模块):** 作为 Noe 主进程的内嵌模块。通过 `watchdog` 机制确保 `runTurn` 不会阻塞主循环，避免使用独立的 worker 进程增加通信开销。
    *   **数据流:** 接收来自消息队列（如 Kafka/RabbitMQ 或内置简单队列）的用户消息，驱动 Memory Core 进行记忆检索，并协调 LLM Adapter 进行决策和 Tool Executor 进行外部操作。

*   **Memory Core (FR-05):**
    *   **职责:** 管理 Noe 的长期和短期记忆，包括用户、项目、任务、焦点和证据。
    *   **实现:** 吸收 BaiLongma `src/memory` 下的核心模块 (如 `recognizer.js`, `injector.js`, `consolidation-loop.js`, `refresh-loop.js`)。
    *   **Q-1 (独立 Store):** 建立独立的 Noe 记忆存储。基于 BaiLongma 的 `src/db.js` 进行改造，设计一个全新的 SQLite schema，以避免与 Noe 现有 `src/storage/SqliteStore.js` 的任何潜在冲突。新的 store 命名为 `noe-memory.sqlite`，并放置于 Noe 专有数据目录 `~/.noe-panel/`。
    *   **Q-3 (FTS5 与 Embedding):** 优先落地 FTS5 trigram 搜索 (BaiLongma 已实现)。Embedding 若涉及付费或本地模型，将作为后续优化项，单独评估成本和隐私风险。

*   **Focus Stack (FR-06):**
    *   **职责:** 维护 Noe 的即时关注点，提供 `push`, `pop`, `refresh`, `compress` 等操作。
    *   **实现:** 吸收 BaiLongma `src/memory/focus.js` 和 `src/memory/focus-compress.js` 的逻辑。
    *   **数据流:** 与 Memory Core 紧密集成，支持焦点持久化和从记忆中恢复。

*   **数据持久层 (FR-05, Q-1):**
    *   **实现:** 基于 `better-sqlite3` 库，独立开发 Noe 的 `db.js`，包含适配 Noe Memory Core 的 schema 定义。
    *   **Schema 设计:** 参照 BaiLongma 的 `memories`, `configurations`, `focus_stack` 表结构，但针对 Noe 进行优化和命名空间区分。确保新 schema 能够支持 Noe 的用户、项目和任务隔离。
    *   **隔离:** Noe 的所有数据将存储在 `/Users/hxx/Desktop/Neo 贾维斯/.noe-panel/noe-memory.sqlite` 中，与现有项目完全物理隔离。

*   **HTTP API (FR-03, NFR-SEC-1):**
    *   **职责:** 提供 Noe 核心功能（消息发送、状态查询、任务控制、UI 数据接口）的 RESTful API。
    *   **实现:** 吸收 BaiLongma `src/api.js` 的基本框架，但绑定到 `127.0.0.1:51835`。
    *   **安全:** 强化认证机制，默认使用 `owner-token`，并支持配置 `Origin` 白名单和严格的输入验证 (body limit, path sandbox)。所有未授权请求返回 401。
    *   **隔离验证:** `NOE_M1_ISOLATION_SMOKE.mjs` 将被增强，以验证 Noe 能在 51835 启动且不影响原项目 51735。

*   **Brain UI Lite (FR-07):**
    *   **职责:** 提供 Noe 状态的可视化界面。
    *   **实现:** 剥离 BaiLongma `src/ui/brain-ui` 中的 Electron UI 依赖。考虑使用 Noe 现有的前端技术栈 (如 Vue/React) 重新实现一个轻量级面板。只展示核心状态 (loop 状态、焦点、记忆召回、工具审批、系统健康)。
    *   **Q-4 (路由挂载):** 挂载到 Noe 的 HTTP API 路由下，例如 `/brain-ui`，通过浏览器访问。

*   **工具市场与执行权限 (FR-08, Q-5):**
    *   **职责:** 管理 Noe 可用的工具，并实施权限治理。
    *   **实现:** 吸收 BaiLongma `src/capabilities/marketplace` 的工具注册和 `parameters_schema` 定义。
    *   **权限治理:** 实现一个显式的工具审批流程。所有工具执行必须经过权限检查。工具 `manifest schema` 应包含风险等级、所需权限、可执行动作列表。Noe 的权限系统将基于此 schema 决定是否允许执行以及如何审批。
    *   **Q-5 (映射权限):** 设计一个权限策略引擎，根据工具的 `manifest schema` 和当前上下文，动态评估执行权限。

*   **Voice (FR-10) 和 Social I/O (FR-11):**
    *   **优先级:** P2 (核心闭环稳定后)。
    *   **实现:** 吸收 BaiLongma `src/voice` 和 `src/social` 的核心逻辑。
    *   **Q-6 (凭据装载):** 密钥和凭据将通过 Noe 的加密配置存储或环境变量安全装载。默认禁用 Voice/Social 功能。
    *   **Q-7 (协同预算):** NoeLoop 独立管理 Noe 自身的预算。集群协同（如有）将作为外部 Agent 通过 Social I/O 或 API 与 Noe 交互，遵循 Noe 设定的预算限制和审批策略，避免互相触发或抢预算。

## 3. 状态机设计 (NoeLoop)

NoeLoop 的状态将清晰地反映其运行周期和当前活动，以下为关键状态及其转换：

*   **`Idle` (空闲):** 无用户消息或待执行任务。等待下一个调度心跳或新消息。
    *   转换: `Idle` -> `Processing` (收到消息或心跳触发)
*   **`Processing` (处理中):** 正在执行 `runTurn` 逻辑 (LLM 调用、工具执行、记忆处理等)。
    *   转换: `Processing` -> `Idle` ( `runTurn` 完成)
    *   转换: `Processing` -> `Aborted` (高优先级消息中断)
    *   转换: `Processing` -> `Error` ( `runTurn` 内部出现未捕获异常)
*   **`RateLimited` (限速):** LLM 调用因配额耗尽被暂时停止。
    *   转换: `RateLimited` -> `Processing` (配额恢复，下一个调度心跳触发)
*   **`Aborted` (中断):** `runTurn` 因更高优先级事件 (如新用户消息) 而提前终止。
    *   转换: `Aborted` -> `Processing` (中断后立即触发新一轮 `runTurn`)
*   **`Error` (错误):** `runTurn` 执行过程中出现不可恢复的错误。
    *   转换: `Error` -> `Idle` (自动恢复或管理员干预后重置)
*   **`TaskActive` (任务活跃):** Noe 正在执行一个显式任务。调度心跳间隔可能动态调整。
    *   转换: `TaskActive` -> `Idle` (任务完成或清除)
*   **`Awakening` (觉醒期):** Noe 启动后的初始探索阶段，执行预设的自我检查和探索任务。
    *   转换: `Awakening` -> `Idle` (觉醒期任务完成)

## 4. 失败处理策略

*   **LLM 调用失败:**
    *   **重试:** 复用 BaiLongma 的 LLM 重试机制，配置最大重试次数和指数退避策略。
    *   **优雅降级:** 如果重试失败，向用户返回一个友好的错误消息，并将失败信息记录到记忆中，以便后续分析。
*   **工具执行失败:**
    *   **异常捕获:** 所有工具执行必须有健壮的异常捕获。
    *   **错误反馈:** 将工具执行的详细错误信息（包括堆栈跟踪和错误码）反馈给 NoeLoop 和 LLM，LLM 将根据上下文决定是重试、更换工具、或寻求用户帮助。
    *   **审计日志:** 详细记录失败的工具调用，包括输入、输出和错误信息。
*   **数据库操作失败:**
    *   **事务:** 关键的写入操作使用 SQLite 事务，确保数据一致性。
    *   **错误隔离:** 数据库错误应隔离在数据层，不影响 NoeLoop 的核心运行。
    *   **数据恢复/备份:** 定期备份 `noe-memory.sqlite`，并设计简单的恢复流程。
*   **NoeLoop 阻塞/卡死:**
    *   **`watchdog`:** 吸收 BaiLongma 的 `RUN_TURN_WATCHDOG_MS` 机制。如果 `runTurn` 超过预设时间未返回，强制中断当前执行，并清空 `processing` 标志，确保主循环能继续处理后续消息。
    *   **全局异常捕获:** 在 `onTick` 的 `try-catch-finally` 块中捕获所有未处理的异常，确保 `scheduleNextTick` 总是被调用，防止主循环永久停摆。
*   **密钥泄露防范 (NFR-SEC-2):**
    *   所有敏感信息（如 API keys, tokens）不得硬编码或明文存储在代码库中。
    *   通过环境变量、安全的配置文件（加密）或 Noe 专属的密钥管理服务加载。
    *   集成 `NOE_PHASE2_SECRET_GATE.mjs` 作为 CI/CD 流程的一部分，在代码提交前自动扫描和阻止敏感信息泄露。

## 5. 兼容性与回滚策略

*   **兼容性:** Noe 将作为一个全新的、独立的应用程序实例运行。它不与原有项目共享代码库、端口或数据目录。在数据层面，可以考虑提供从 BaiLongma 数据库（如果需要）迁移或导入记忆的工具，以实现软兼容。
*   **回滚策略:**
    *   **版本控制:** 严格遵循 Git 版本控制，每次功能迭代都进行有意义的提交。
    *   **隔离部署:** Noe 部署在独立的环境中（独立端口 `51835`，独立数据目录 `~/.noe-panel`），与原项目 `51735` 互不干扰。回滚时，只需停止或移除 Noe 服务，不会影响原项目的运行。
    *   **阶段式开发:** 按照 P0 -> P1 -> P2 的优先级进行开发，确保每个阶段都是可验证和可回滚的最小增量。
    *   **自动化测试:** 完善的单元测试、集成测试和冒烟测试是快速回滚的保障。

## 6. 工程闭环 11 阶段落地

*   **用户想法 (1) 和需求分析与拆解 (2):** 之前的阶段已完成，并以 `NOE_PHASE2_REQUIREMENTS_CANONICAL.md` 作为本方案的输入。
*   **技术方案设计 (3):** 本文档即为本阶段的交付物，旨在指导后续的开发工作。它对 Q-1 到 Q-7 的缺口问题给出了具体的设计决策。
*   **任务分配与排期 (4):** 基于本技术方案，将功能需求拆分为可执行的任务，并按照 P0 -> P1 -> P2 的优先级进行排期。例如，P0 阶段将聚焦于 NoeLoop、Memory Core 和数据层的最小闭环。
*   **代码开发 (5):** 严格在 Noe 目录下进行，只吸收 BaiLongma 的必要逻辑，不进行全量复制。
*   **单元测试 (6) & 集成测试 (7):** 为新吸收或改造的模块编写充分的单元测试。关键模块（如 NoeLoop、Memory Core）和接口（如 HTTP API）将有集成测试，特别是对端口隔离和数据隔离的验证 (`NOE_M1_ISOLATION_SMOKE.mjs`)。
*   **功能验证 (8):** 采用端到端测试用例，验证 Jarvis 体验，例如用户发出指令后，NoeLoop 能正确执行、记忆被更新、Brain UI Lite 能显示正确状态。
*   **文档编写 (9):** 本技术方案将作为核心文档，并随着开发进展持续更新，确保项目知识的可交接性。
*   **交付验收 (10):** 每个阶段的成果都将通过明确的测试报告、文件证据、命令输出（例如 `wc -l`, `shasum -a 256`）进行验收。涉及 UI 的部分将提供截图或浏览器操作证据。
*   **复盘优化 (11):** 定期回顾项目进展，评估方案的有效性，并根据实际情况进行调整和优化。
