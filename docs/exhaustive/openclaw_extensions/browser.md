# OpenClaw extensions/browser 全读
我已完成对 `extensions/browser/` 目录下核心逻辑文件的深入审计。该扩展是 OpenClaw 的核心能力之一，通过 Playwright、CDP (Chrome DevTools Protocol) 和 MCP (Model Context Protocol) 提供了极强的浏览器自动化与感知能力。

以下是详细分析报告：

### 1. 核心职责分层
该扩展分为四个主要层次：
1.  **插件集成层** (`index.ts`, `plugin-registration.ts`): 负责 OpenClaw 插件系统的对接、延迟加载 (Lazy Loading)、节点路由（Sandbox/Host/Node）以及安全审计钩子。
2.  **工具逻辑层** (`src/browser-tool.ts`, `src/browser-tool.actions.ts`): 将 AI 模型的高层指令（如 `action=snapshot`）转换为具体的业务操作，并处理多节点代理（Proxy）逻辑。
3.  **驱动执行层** (`src/browser/pw-session.ts`, `src/browser/pw-tools-core.interactions.ts`): 核心驱动引擎。管理 Playwright 会话、CDP 链接、SSRF 安全过滤、导航守卫及原子化交互（点击、输入、拖拽等）。
4.  **协议适配层** (`src/browser/chrome-mcp.ts`, `src/browser/cdp.ts`): 适配不同运行模式。`chrome-mcp` 用于连接用户已登录的浏览器；`cdp` 提供底层协议支持（如截图、获取原始 AX 树）。

---

### 2. 核心机制与实现细节

#### A. 稳定引用机制 (Stable Refs)
*   **文件**: `src/browser/pw-role-snapshot.ts` (L12-L211), `src/browser/pw-session.ts` (L380-L425)
*   **机制**: 
    *   **引用生成**: 自动为网页中的交互元素分配 `e1`, `e2` (基于 AI Snapshot) 或 `ax1` (基于 Aria Snapshot) 标识。
    *   **持久化映射**: 在 `pw-session.ts` 中使用 `roleRefsByTarget` (L101) 缓存这些引用。即使 Playwright 对象在不同请求间重建，只要 `targetId` (CDP 页面标识) 相同，AI 仍能通过旧引用执行后续操作。
    *   **消歧义处理**: 如果页面存在多个同名同角色的元素，自动增加 `[nth=1]` 后缀。

#### B. 导航守卫与 SSRF 过滤
*   **文件**: `src/browser/navigation-guard.ts`, `src/browser/pw-session.ts` (L684-L733), `src/browser/pw-tools-core.interactions.ts` (L238-L342)
*   **机制**:
    *   **双重校验**: 在导航发起前 (`gotoPageWithNavigationGuard`) 和完成后 (`assertPageNavigationCompletedSafely`) 均进行策略校验。
    *   **延迟导航捕获**: 针对“点击后延迟跳转”的场景，在交互完成后设置一个 250ms 的观察窗口 (`INTERACTION_NAVIGATION_GRACE_MS`)，监听 `framenavigated` 事件，防止点击操作绕过 SSRF 检查。
    *   **隔离策略**: 发现非法 URL 时，会立刻对该 Page 标记隔离 (`quarantineBlockedTarget`) 甚至关闭标签页。

#### C. MCP 已登录会话桥接
*   **文件**: `src/browser/chrome-mcp.ts`
*   **机制**: 
    *   **进程隔离**: 针对 `profile="user"`，启动一个独立的 `chrome-devtools-mcp` 进程 (L361)，通过 Stdio 进行 MCP 通信。
    *   **动态租约**: 使用 `ChromeMcpSessionLease` (L48) 管理会话生命周期，支持 ephemeral (临时) 和持久化连接。
    *   **容错重连**: 在 L851 的 `callTool` 中实现了针对 `stale_selected_page` 错误的自动重连机制。

#### D. 交互原子化与中止处理
*   **文件**: `src/browser/pw-tools-core.interactions.ts` (L343-L411)
*   **机制**:
    *   **Race Timeout**: 为了防止 JS `evaluate` 永远卡住 Playwright 的命令队列，注入了基于 `Promise.race` 的浏览器侧超时检测 (L743)。
    *   **Abort Signal**: 所有的交互操作均关联了 `AbortSignal`，当 AI 发现页面弹出 Modal 对话框时，会主动中止当前阻塞的交互并返回对话框状态。

---

### 3. 本地 AI 助手 Noe 的优化/改进点

基于上述审计，Noe 可以通过以下技术细节优化其记忆与能力：

1.  **跨 Turn 的“视觉记忆”持久化**:
    *   **现状**: `browser` 扩展已提供 `roleRefsByTarget`。
    *   **Noe 改进**: Noe 可以在本地 Memory 中记录 `targetId` 与关键元素 `ref` 的关联。例如：“在目标标签页 A 中，提交按钮是 e15”。当下次任务涉及同一页面时，Noe 无需重新 snapshot，直接复用 `ref` 进行交互，节省 Token。

2.  **异步导航的感知能力**:
    *   **现状**: `browser` 有 250ms 的导航捕获窗口。
    *   **Noe 改进**: Noe 可以根据 `screenshot` 操作返回的 `browserState` 中是否包含 `blockedByDialog` 或 URL 的变化，自动判断是否需要执行 `action=dialog` 或是等待页面稳定。它可以“预测”某些点击会触发重定向。

3.  **模型引导的 Snapshot 压缩**:
    *   **现状**: `src/browser/pw-role-snapshot.ts` 支持 `interactive` 和 `compact` 过滤。
    *   **Noe 改进**: Noe 可以根据当前任务的复杂程度动态调整 `snapshot` 参数。如果是简单的“查找链接”，使用 `interactive=true` 极大减少 context。如果是复杂的“填写表单”，则使用 `compact=true` 保持结构。

4.  **智能重连策略**:
    *   **现状**: `chrome-mcp.ts` 在特定错误时重连。
    *   **Noe 改进**: Noe 可以识别出 `404: tab not found` 等错误是由浏览器进程重启引起的，主动触发 `action=tabs` 来重新对齐其“内存中的标签页列表”，而不是报错退出。

5.  **DOM 标记优化**:
    *   **现状**: `markBackendDomRefsOnPage` (在 `pw-session.page-cdp.ts` 中) 会在 DOM 上添加临时属性。
    *   **Noe 改进**: Noe 可以利用这些属性通过 `evaluate` 执行更复杂的自定义指令（如：计算某元素的绝对坐标以配合 `clickCoords`），绕过 Playwright 某些情况下的定位局限。

---

### 4. 已读文件清单

*   `extensions/browser/index.ts`
*   `extensions/browser/plugin-registration.ts`
*   `extensions/browser/src/browser-tool.ts`
*   `extensions/browser/src/browser-tool.actions.ts`
*   `extensions/browser/src/browser-runtime.ts`
*   `extensions/browser/src/browser/client.ts`
*   `extensions/browser/src/browser/pw-session.ts`
*   `extensions/browser/src/browser/pw-tools-core.interactions.ts`
*   `extensions/browser/src/browser/pw-tools-core.snapshot.ts`
*   `extensions/browser/src/browser/chrome-mcp.ts`
*   `extensions/browser/src/browser/pw-role-snapshot.ts`
*   `extensions/browser/src/browser/cdp.ts`
