# OpenClaw extensions/acpx 全读
针对 `extensions/acpx/` 的深度审计报告如下。该扩展是 OpenClaw 的 **Active Context Processing (ACP) 运行环境适配器**，核心职责是管理本地 AI 代理（如 Codex, Claude ACP）的生命周期、进程隔离、安全脱敏及会话持久化。

### 核心职责与机制分析

#### 1. 运行环境适配与代理机制 (Runtime & Proxy)
*   **职责**：封装上游 `acpx` 运行时，使其符合 OpenClaw SDK 的 `AcpRuntime` 契约，并实现延迟加载。
*   **核心文件**：
    *   `register.runtime.ts`: 实现懒加载模式。插件启动时仅注册一个轻量级代理，直到第一个会话需求出现时才导入并启动重量级的 `src/service.js`。
    *   `src/runtime-proxy.ts`: 定义了 `LazyAcpRuntimeProxy`，拦截所有 API 调用并在首次调用时触发运行时初始化 (L15-L51)。
    *   `src/runtime-turn.ts`: 适配器层，将仅支持事件流的旧版运行时适配为支持 `startTurn` 契约的新版逻辑 (L125-L141)。

#### 2. 进程租约与身份绑定 (Process Lease)
*   **职责**：为每一个启动的代理进程分配唯一租约 (Lease)，将宿主进程与 OpenClaw 的网关实例、会话 ID 强绑定。
*   **核心机制**：
    *   `src/process-lease.ts`: 
        *   **数据结构**：`AcpxProcessLease` 存储了 `leaseId`、`gatewayInstanceId`、`rootPid` 及命令哈希 (L26-L37)。
        *   **注入方式**：通过 `withAcpxLeaseEnvironment` 将租约 ID 注入到进程的环境变量或 CLI 参数中 (L176-L191)。
    *   `src/runtime.ts`: 在 `runWithLaunchLease` 中，启动进程前先持久化租约状态，确保进程即使在初始化失败时也能被追踪 (L463-L493)。

#### 3. 进程清理与孤儿收割 (Process Reaper)
*   **职责**：通过严格的身份校验（路径、包名、租约 ID），安全地终止 OpenClaw 拥有的进程树，防止僵尸进程。
*   **核心机制**：
    *   `src/process-reaper.ts`:
        *   **所有权验证**：`isOpenClawOwnedAcpxProcessCommand` 通过检查进程命令是否包含特定包路径（如 `@zed-industries/codex-acp`）或生成的封装脚本路径来确定所有权 (L146-L168)。
        *   **树状清理**：`collectProcessTree` 递归查找所有子进程 (L183-L208)，并使用 `SIGTERM` 后跟 `SIGKILL` 的分级终止策略 (L223-L253)。
        *   **孤儿收割**：`reapStaleOpenClawOwnedAcpxOrphans` 在启动时扫描 PPID 为 1 的孤儿进程并进行清理 (L341-L368)。

#### 4. 隔离封装与安全脱敏 (Auth Bridge & Isolation)
*   **职责**：为 Codex/Claude 创建隔离的运行目录和配置文件，并在诊断日志中脱敏敏感信息。
*   **核心机制**：
    *   `src/codex-auth-bridge.ts`: 
        *   **脚本生成**：动态生成 `.mjs` 封装脚本，为每个代理进程设置独立的 `CODEX_HOME` (L505-L536)。
        *   **诊断脱敏**：`DIAGNOSTIC_REDACTION_RULES` 使用大量正则表达式在 stderr 流中实时拦截并替换 API Key、Bearer Token、JWT 等敏感字符串 (L107-L190)。
    *   `src/codex-trust-config.ts`: 
        *   **信任提取**：解析原生的 `config.toml`，提取已授权的项目路径，并为当前会话生成仅包含受信任路径的隔离配置 (L190-L215)。

#### 5. 模型作用域与参数优化 (Model Scoping)
*   **职责**：针对 Codex 等特定代理，将 OpenClaw 的模型设置映射为代理进程的 CLI 配置参数。
*   **核心机制**：
    *   `src/runtime.ts`: 
        *   **参数注入**：`appendCodexAcpConfigOverrides` 将 `reasoning_effort` (low/medium/high) 转换为 Codex 识别的 `-c model_reasoning_effort=...` 参数 (L413-L422)。
        *   **思考模型映射**：维护了 `CODEX_ACP_THINKING_ALIASES` 映射表，支持 `minimal` 到 `xhigh` 的各种语义缩放 (L259-L272)。

---

### 对本地助手 Noe 的优化/改进建议

1.  **记忆持久化与重连 (Resilient Reconnection)**：
    *   **当前点**：目前的租约系统主要用于清理。
    *   **优化**：Noe 可以利用 `AcpxProcessLeaseStore` 在网关异常重启后，识别并重新附加（Attach）到仍在运行的旧代理进程，从而实现“零感知”会话恢复。

2.  **细粒度沙箱权限管理**：
    *   **当前点**：`src/codex-trust-config.ts` 目前根据 `trust_level` 静态过滤。
    *   **优化**：可以引入动态权限申请机制。当代理试图访问未授权路径时，ACPX 拦截并触发 Noe 的交互式权限请求。

3.  **智能诊断增强**：
    *   **当前点**：`src/runtime.ts` 在检测到 "Internal error" 时会读取 stderr 的末尾进行诊断 (L527-L543)。
    *   **优化**：Noe 可以利用 `codex-acp-wrapper.stderr.log` 进行自我修复。如果发现是因为权限不足导致崩溃，Noe 可以自动调整配置并尝试重启。

4.  **动态脱敏规则学习**：
    *   **当前点**：脱敏规则是硬编码的。
    *   **优化**：Noe 可以根据当前配置的 Provider 环境变量，动态生成针对性的脱敏规则，确保即使是自定义的敏感字段也不会泄露到日志中。

---

### 已读文件清单

1.  `extensions/acpx/doctor-contract-api.ts` (状态迁移)
2.  `extensions/acpx/index.ts` (插件入口)
3.  `extensions/acpx/register.runtime.ts` (延迟注册逻辑)
4.  `extensions/acpx/runtime-api.ts` (SDK 导出)
5.  `extensions/acpx/setup-api.ts` (自动启用探测)
6.  `extensions/acpx/src/runtime.ts` (核心适配器实现)
7.  `extensions/acpx/src/service.ts` (服务生命周期管理)
8.  `extensions/acpx/src/process-lease.ts` (租约存储与注入)
9.  `extensions/acpx/src/process-reaper.ts` (进程扫描与清理)
10. `extensions/acpx/src/state.ts` (状态常量与规范化)
11. `extensions/acpx/src/runtime-proxy.ts` (懒加载代理)
12. `extensions/acpx/src/codex-auth-bridge.ts` (封装脚本生成与脱敏)
13. `extensions/acpx/src/codex-trust-config.ts` (TOML 解析与配置隔离)
14. `extensions/acpx/src/command-line.ts` (CLI 辅助工具)
15. `extensions/acpx/src/config.ts` (配置解析逻辑)
16. `extensions/acpx/src/runtime-turn.ts` (Turn 契约适配)
17. `extensions/acpx/src/runtime-internals/mcp-command-line.mjs` (内部命令行处理)
18. `extensions/acpx/src/runtime-internals/mcp-proxy.mjs` (内部代理逻辑)
