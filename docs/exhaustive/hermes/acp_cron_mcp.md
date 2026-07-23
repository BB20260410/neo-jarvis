# Hermes acp_cron_mcp 全读
我已完成对 `hermes-agent` 核心组件的全面深度审计。以下是各模块职责、关键机制（精确到行号）及优化建议的详细报告。

### 1. 已审计清单 (Read List)
- `hermes_constants.py`: 全局常量与路径管理。
- `hermes_state.py`: 基于 SQLite 的状态持久化与搜索。
- `run_agent.py`: 智能体核心执行逻辑 (AIAgent)。
- `mcp_serve.py`: MCP (Model Context Protocol) 服务端实现。
- `acp_adapter/`: ACP (Agent Control Protocol) 适配器全集（entry, server, session, auth, approval, events, permissions, provenance, tools）。
- `acp_registry/`: ACP 注册元数据。
- `cron/`: 定时任务系统（scheduler, jobs）。

---

### 2. 核心模块职责与机制审计

#### **A. 状态持久化与管理 (`hermes_state.py`)**
*   **职责**：负责所有对话会话、消息、压缩链以及搜索索引的持久化存储。
*   **关键机制**：
    *   **WAL 模式与回退**：自动检测网络文件系统并从 WAL 切换到 DELETE 模式以保证稳定性 (L33-145)。
    *   **CJK 搜索优化**：针对中日韩文字，实现了基于 Trigram 的 FTS5 搜索以及 `LIKE` 模糊匹配的回退机制 (L230-264, L2768-3004)。
    *   **压缩链溯源**：通过 `resolve_resume_session_id` 递归向上寻找压缩前的祖先会话，解决“无消息压缩父节点”问题 (L2366-2423)。
    *   **并发控制**：在进行会话压缩时使用数据库级锁，防止竞态条件 (L665-748)。

#### **B. 智能体执行核心 (`run_agent.py`)**
*   **职责**：定义 `AIAgent` 类，驱动工具调用循环、处理多供应商 API、管理上下文。
*   **关键机制**：
    *   **动态凭据刷新**：支持 OpenAI, Anthropic, Azure Foundry (Entra ID) 等多种供应商的 Token 实时刷新与池化管理 (L3330-3498)。
    *   **中断与转向 (Steer)**：支持在生成过程中实时插入用户指令或强制中断 (L2290-2443)。
    *   **脱敏持久化**：在消息存入数据库前，自动对敏感信息（API Keys, Secrets）进行正则红线脱敏 (L2176-2200)。
    *   **流式诊断**：提供流式输出的诊断钩子，允许外部实时监控 Token 生成速率和延迟 (L2056-2155)。

#### **C. ACP 适配器层 (`acp_adapter/`)**
*   **职责**：将 Hermes 的能力通过 ACP 协议暴露给 Zed/Cursor 等编辑器，支持编辑审批和实时进度。
*   **关键机制**：
    *   **编辑审批拦截**：通过 `ContextVar` 绑定的 `EditApprovalRequester`，在工具执行前拦截 `write_file`/`patch` 操作，并将 Diff 推送给编辑器审批 (edit_approval.py L142-206)。
    *   **WSL 路径翻译**：自动处理 Windows 编辑器与 WSL 运行环境之间的路径映射 (`/mnt/c/...` vs `C:\...`) (session.py L28-80)。
    *   **原生任务面板集成**：将 Hermes 的 `todo` 工具结果实时转换为 ACP 的 `plan` 更新，从而驱动 Zed 的任务进度面板 (events.py L53-91)。

#### **D. 定时任务系统 (`cron/`)**
*   **职责**：允许 Hermes 在后台执行自动化任务（如内存清理、定期报告、监控）。
*   **关键机制**：
    *   **并行与串行分区执行**：根据任务是否会修改环境变量（如 `workdir` 或 `profile`），将任务分为“并行池”和“串行池”执行，防止环境污染 (scheduler.py L2120-2160)。
    *   **唤醒门控 (Wake-gate)**：支持在 LLM 运行前先执行一段脚本，根据脚本输出（如 `wakeAgent: false`）决定是否跳过后续昂贵的 AI 调用 (scheduler.py L1045-1065)。
    *   **多端交付路由**：支持将结果路由回来源平台、指定平台（Telegram/Discord）或广播至所有已连接频道 (scheduler.py L405-574)。

---

### 3. 优化与改进建议 (Insights)

1.  **MCP 轮询优化**：
    *   `mcp_serve.py` 的 `EventBridge` 目前每 200ms 轮询一次数据库。**改进建议**：改为基于文件系统监听（watchdog）监控 `state.db-wal` 或利用 SQLite 的 `update_hook` 实现事件驱动，降低空转 CPU 占用。
2.  **ACP 会话列表分页**：
    *   `acp_adapter/session.py` 的 `list_sessions` 同时读取内存和数据库中的前 1000 条会话。**改进建议**：随着用户历史增加，此处应实现真正的分页加载，避免在大规模历史数据下造成编辑器侧的 JSON 解析阻塞。
3.  **Cron 环境隔离风险**：
    *   `cron/scheduler.py` 通过快照/还原 `os.environ` 来处理多 profile 任务。**改进建议**：在多线程环境下，这可能导致瞬时的竞态冲突。应更彻底地使用 `contextvars` 或直接在 `subprocess.run` 中显式传递 `env` 字典，避免修改进程级环境变量。
4.  **状态库自动维护**：
    *   `hermes_state.py` 中的 `delete_empty_sessions` 目前需手动或特定逻辑触发。**改进建议**：可将其注册为一个内置的 Cron 任务，实现系统自动伸缩清理。
5.  **ACP Diff 构建效率**：
    *   `acp_adapter/tools.py` 在构建 Diff 时会读取全量文件。对于极大文件的微小改动，这可能导致内存压力。**改进建议**：引入更高效的差异计算库或流式读取。

### 4. 重点代码行参考总结
| 文件 | 机制 | 关键行 |
| :--- | :--- | :--- |
| `hermes_state.py` | CJK 搜索逻辑 | L2800-3004 |
| `run_agent.py` | 凭据自动刷新 | L3330-3498 |
| `acp_adapter/server.py` | ACP 协议映射 | L924-1004 |
| `cron/scheduler.py` | 串行/并行分区调度 | L2120-2160 |
| `mcp_serve.py` | 跨平台事件桥接 | L147-302 |

审计任务已完成。所有机制均已详细记录，系统架构表现出极高的鲁棒性和对边缘情况（如 WSL 路径、凭据失效、搜索冲突）的周密考虑。
