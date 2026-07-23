# 阶段 4: 任务分配与排期

## 🎯 阶段目标
将《技术方案设计》(NOE_PHASE3_TECH_DESIGN_CANONICAL.md) 转化为可执行的任务队列，明确任务粒度、执行顺序、角色分工、阻塞点和验证门槛，为下一阶段「代码开发」提供清晰指引。

## 📝 任务列表

### 模块 M1: 环境与端口隔离验证 (验证现有基础架构)
- **任务 ID:** M4.1.1
- **描述:** 运行 `NOE_M1_ISOLATION_SMOKE.mjs` 脚本，确保 Noe 可以在 51835 端口独立启动，且不干扰现有项目在 51735 端口的运行。这是后续所有开发的基础。
- **负责人/模型分工:** 自动化代理 / 开发工程师
- **前置依赖:** 无 (此为初始化验证)
- **验证门槛:** `NOE_M1_ISOLATION_SMOKE.mjs` 脚本执行成功并输出 `PASS`。
- **交付物:** `NOE_M1_ISOLATION_SMOKE.mjs` 运行日志及结果。

### 模块 M2: NoeLoop 核心逻辑 (最小闭环)
- **任务 ID:** M4.2.1
- **描述:** 根据技术方案 (NOE_PHASE3_TECH_DESIGN_CANONICAL.md)，在 `src/loop` 目录下实现 NoeLoop 的状态机骨架 (stopped, idle, ticking, acting, paused_budget, error 状态)，包含重入锁和看门狗机制。
- **负责人/模型分工:** 开发工程师
- **前置依赖:** M4.1.1
- **验证门槛:** 新增 `src/loop/tests/unit/NoeLoop.test.mjs` 单元测试，覆盖所有状态转换的正确性。
- **交付物:** `src/loop/NoeLoop.mjs`, `src/loop/tests/unit/NoeLoop.test.mjs`

- **任务 ID:** M4.2.2
- **描述:** 实现 NoeLoop 在 `idle` 状态下接收 `tick` 信号，并在零预算限制下执行默认的、无副作用的 `tick` 逻辑（例如内部计时、日志记录），不进入 `acting` 状态。
- **负责人/模型分工:** 开发工程师
- **前置依赖:** M4.2.1
- **验证门槛:** `NoeLoop.test.mjs` 扩展测试用例，验证零额度 `tick` 行为符合预期。
- **交付物:** 更新 `src/loop/NoeLoop.mjs`

### 模块 M3: Memory Core (初步 FTS5 召回)
- **任务 ID:** M4.3.1
- **描述:** 根据技术方案，设计 `noe_memory` 和 `noe_memory_fts` 数据表结构，并创建对应的 SQL 迁移脚本 (`src/storage/migrations/v2/create_noe_memory_tables.sql`)。确保与现有 `src/embeddings` 表的复用策略一致。
- **负责人/模型分工:** 开发工程师 / 模型审查 (schema 审查)
- **前置依赖:** M4.2.2
- **验证门槛:** SQL 迁移脚本通过语法检查，并经过模型审查确认符合设计。
- **交付物:** `src/storage/migrations/v2/create_noe_memory_tables.sql`

- **任务 ID:** M4.3.2
- **描述:** 在 `src/memory` 目录下实现 Memory Core 模块，提供基于 FTS5 的记忆存储 (`storeMemory`) 和召回 (`recallMemory`) 接口，并集成到 `SqliteStore.js`。
- **负责人/模型分工:** 开发工程师
- **前置依赖:** M4.3.1
- **验证门槛:** 新增 `src/memory/tests/unit/MemoryCore.test.mjs` 单元测试，验证 Memory Core 的存储和召回功能。
- **交付物:** `src/memory/MemoryCore.mjs`, `src/memory/tests/unit/MemoryCore.test.mjs`

- **任务 ID:** M4.3.3
- **描述:** 将 Memory Core 模块集成到 NoeLoop 中，使得 NoeLoop 在其 `tick` 周期内能够调用 Memory Core 接口进行记忆的读写操作。
- **负责人/模型分工:** 开发工程师
- **前置依赖:** M4.2.2, M4.3.2
- **验证门槛:** 编写集成测试 (`src/integrations/tests/NoeLoopMemory.test.mjs`)，验证 NoeLoop 与 Memory Core 的端到端交互。
- **交付物:** 更新 `src/loop/NoeLoop.mjs`, `src/integrations/tests/NoeLoopMemory.test.mjs`

### 模块 M4: Brain UI Lite (基础状态展示)
- **任务 ID:** M4.4.1
- **描述:** 根据技术方案，设计 Brain UI Lite 所需的 HTTP API 端点 (例如获取 NoeLoop 状态、Memory 统计、Focus Stack 内容等)。
- **负责人/模型分工:** 开发工程师 / 模型审查 (API 设计审查)
- **前置依赖:** M4.3.3
- **验证门槛:** 撰写 API 文档 (`docs/api/noe_brain_ui_lite.md`)，并经过模型审查。
- **交付物:** `docs/api/noe_brain_ui_lite.md`

- **任务 ID:** M4.4.2
- **描述:** 在 `server.js` 中添加 `/api/noe/*` 路由，处理 Brain UI Lite 的 HTTP 请求，将请求转发给 NoeLoop 和 Memory Core 模块进行处理。
- **负责人/模型分工:** 开发工程师
- **前置依赖:** M4.4.1
- **验证门槛:** 路由集成测试，确保 API 端点可访问且能正确返回数据。
- **交付物:** 更新 `server.js`

- **任务 ID:** M4.4.3
- **描述:** 创建一个轻量级前端页面 (`public/noe-brain-ui.html`)，并将其作为 Noe 现有 UI 的新 tab 挂载。该页面应能通过 HTTP API 显示 NoeLoop 的当前状态和 Memory Core 的关键统计信息。
- **负责人/模型分工:** 开发工程师
- **前置依赖:** M4.4.2
- **验证门槛:** 浏览器手动测试，验证 UI 界面能正常显示数据，并提供 UI 截图作为证据。
- **交付物:** `public/noe-brain-ui.html`, 相关的 JS/CSS 文件, UI 截图。

### 模块 M5: 文档、测试与阶段验收
- **任务 ID:** M4.5.1
- **描述:** 更新项目的 `CHANGELOG.md` 和 `README.md`，记录本次开发的新功能、配置说明和使用指引。
- **负责人/模型分工:** 开发工程师
- **前置依赖:** M4.4.3
- **验证门槛:** 文档内容审查，确保准确性和完整性。
- **交付物:** 更新 `CHANGELOG.md`, `README.md`

- **任务 ID:** M4.5.2
- **描述:** 编写并运行针对 NoeLoop, Memory Core, Brain UI Lite 的集成测试和端到端测试，确保新功能的稳定性和正确性。
- **负责人/模型分工:** 自动化代理 / 开发工程师
- **前置依赖:** M4.4.3
- **验证门槛:** 所有新增和更新的测试用例均通过。
- **交付物:** 新增/更新的测试文件，测试报告。

- **任务 ID:** M4.5.3
- **描述:** 创建 `NOE_PHASE4_VERIFY.mjs` 脚本，用于自动化验证本阶段所有任务的交付物和验证门槛。运行该脚本进行模型审查。
- **负责人/模型分工:** 模型审查
- **前置依赖:** M4.5.2
- **验证门槛:** `NOE_PHASE4_VERIFY.mjs` 脚本执行成功并输出 `PASS`。
- **交付物:** `NOE_PHASE4_VERIFY.mjs`

## 🕒 执行顺序与检查点

1.  **里程碑 1: 环境就绪**
    *   完成任务: M4.1.1
    *   检查点: `NOE_M1_ISOLATION_SMOKE.mjs` PASS。

2.  **里程碑 2: NoeLoop 最小闭环**
    *   完成任务: M4.2.1, M4.2.2
    *   检查点: NoeLoop 单元测试通过，零额度 `tick` 行为正确。

3.  **里程碑 3: Memory Core 初步集成**
    *   完成任务: M4.3.1, M4.3.2, M4.3.3
    *   检查点: Memory Core 单元测试通过，NoeLoop 与 Memory Core 集成测试通过。

4.  **里程碑 4: Brain UI Lite 基础展示**
    *   完成任务: M4.4.1, M4.4.2, M4.4.3
    *   检查点: Brain UI Lite API 路由可用，前端页面能正确显示 Noe 状态。

5.  **里程碑 5: 阶段 4 交付验收**
    *   完成任务: M4.5.1, M4.5.2, M4.5.3
    *   检查点: 所有文档更新，所有测试通过，`NOE_PHASE4_VERIFY.mjs` PASS。

## 🔗 工程闭环阶段衔接

本阶段「任务分配与排期」承接自「技术方案设计」(阶段 3)，将抽象的技术方案具化为可操作的任务列表和清晰的执行路径。它为下一阶段「代码开发」(阶段 5) 提供了详细的工作蓝图，确保开发工作能够高效、有序地进行。阶段 4 的交付物 (本任务调度文档) 也是后续「交付验收」(阶段 10) 的重要参考依据。
