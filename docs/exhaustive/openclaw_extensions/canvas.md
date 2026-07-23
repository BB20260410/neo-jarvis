# OpenClaw extensions/canvas 全读
Attempt 1 failed: You have exhausted your capacity on this model. Your quota will reset after 0s.. Retrying after 5443ms...
Attempt 1 failed: You have exhausted your capacity on this model. Your quota will reset after 1s.. Retrying after 5418ms...
我已完成对 `extensions/canvas` 扩展的逐文件深度审计。该扩展是 OpenClaw 中负责控制配对节点（iOS/Android/Desktop）画布显示、渲染 A2UI 内容以及托管本地多媒体资源的实验性核心组件。

### 1. 职责概述
- **节点画布控制**：通过 `node.invoke` 向终端节点发送 `present` (显示)、`hide` (隐藏)、`navigate` (导航)、`eval` (执行 JS) 等指令。
- **A2UI 内容渲染**：支持推送 JSONL 格式的代理这份报告对 `extensions/canvas/` 扩展进行了深度的全文件审计。

### **1. 扩展职责概览**
`extensions/canvas` 是 OpenClaw 的实验性功能，旨在为“配对节点”（如移动端 App 或其他运行 OpenClaw 的终端）提供**画布控制**和 **A2UI (App-to-UI) 渲染表面**。它允许 AI 助手（如 Noe）或 CLI 用户在远端设备的屏幕上呈现内容、捕获快照、执行脚本或推送动态 UI 组件。

---

### **2. 核心算法与机制详细分析**

#### **A. 画布控制桥接 (Canvas Control Bridge)**
*   **职责**：将代理（Agent）的抽象指令转换为对配对节点的 `node.invoke` 调用。
*   **机制**：
    *   **指令集**：支持 `present`（呈现）、`hide`（隐藏）、`navigate`（跳转 URL）、`eval`（执行 JS）、`snapshot`（捕获快照）及 A2UI 相关指令。(`index.ts:13-22`)
    *   **懒加载工具**：为了性能，`canvas` 工具在首次调用时才会动态导入 `src/tool.js` 实现。(`index.ts:24-49`)
    *   **节点路由**：通过 `api.registerNodeInvokePolicy` 定义了指令的执行权限和受限平台（如 iOS 的前台限制）。(`index.ts:117-122`)

#### **B. 文档物化系统 (Document Materialization)**
*   **文件**: `src/documents.ts`
*   **职责**：将 HTML、PDF、媒体文件等资产转化为宿主服务器可直接服务的“画布文档”。
*   **机制**：
    *   **资产隔离**：每个文档生成唯一的 `cv_` 开头的 ID，并在状态目录下的 `canvas/documents/` 中创建独立文件夹。(`documents.ts:113-143`)
    *   **PDF 包装器**：对于 PDF，会自动生成一个包含 `<object>` 标签的 HTML 包装页面以实现全屏预览。(`documents.ts:46-49`)
    *   **资产映射**：`resolveCanvasHttpPathToLocalPath` 算法实现了从 HTTP URL 路径到物理磁盘路径的**安全逆向解析**，严格限制在 `documents` 根目录下，防止目录遍历攻击。(`documents.ts:167-206`)
    *   **Manifest 生成**：每个文档都附带一个 `manifest.json`，记录元数据、创建时间和资产清单。(`documents.ts:310-316`)

#### **C. A2UI (App-to-UI) 渲染引擎**
*   **文件**: `src/a2ui-jsonl.ts`, `src/host/a2ui.ts`
*   **职责**：基于 JSONL（每行一个 JSON 对象）协议向远端推送 UI 更新流。
*   **机制**：
    *   **方言验证**：验证 JSONL 是否符合 `v0.8` 或 `v0.9` 方言，目前 OpenClaw 主要支持 `v0.8`（使用 `surfaceUpdate` 等键）。(`a2ui-jsonl.ts:38-89`)
    *   **动态文本注入**：`buildA2UITextJsonl` 函数可快速构建出一个包含 Column 和 Text 组件的 UI 树。(`a2ui-jsonl.ts:13-35`)

#### **D. 宿主服务器与热重载 (Host Server & Live Reload)**
*   **文件**: `src/host/server.ts`, `src/host/a2ui-shared.ts`
*   **职责**：在本地 Node.js 环境中启动 HTTP 和 WebSocket 服务器，服务静态资源并支持实时刷新。
*   **机制**：
    *   **热重载注入**：`injectCanvasLiveReload` 函数会在返回的 HTML 中通过正则寻找 `</body>` 并插入一段 JS 代码。(`a2ui-shared.ts:19-71`)
    *   **桥接助手 (Bridge Helper)**：注入的代码通过 `window.webkit.messageHandlers` (iOS) 或 Java 接口 (Android) 自动建立与宿主 App 的通信通道，使得 UI 上的按钮点击可以回传 `userAction` 给 Noe。(`a2ui-shared.ts:25-56`)
    *   **Chokidar 监听**：使用 Chokidar 监听 `canvas` 目录，一旦文件变化即通过 WebSocket 广播 `reload` 信号。(`server.ts:360-386`)

#### **E. 能力令牌与安全 (Capability Tokens)**
*   **文件**: `src/capability.ts`
*   **职责**：为托管的资源生成有时间限制且不可预测的访问凭证。
*   **机制**：
    *   **令牌铸造**：基于 `mintCanvasCapabilityToken` 生成不透明字符串。(`capability.ts:21-23`)
    *   **URL 作用域化**：所有 Canvas 资源 URL 都可以通过 `oc_cap` 参数进行身份验证，确保非授权用户无法访问本地托管的敏感文件。

---

### **3. Noe (本地 AI 助手) 的优化/改进/完善点**

基于以上代码逻辑，Noe 可以通过以下方式显著增强能力：

*   **可视化长期记忆 (Memory Visualization)**：
    *   **优化点**：Noe 可以利用 `createCanvasDocument` 将复杂的任务链、思维导图或长期记忆摘要生成为一个本地 HTML 页面。
    *   **应用**：当用户询问“我上周都做了什么”时，Noe 不仅可以文字回答，还可以通过 `canvas.present` 在手机或副屏上直接展示一个精美的可视化时间轴（使用 A2UI 或物化 HTML）。

*   **主动交互增强 (UI-driven Interaction)**：
    *   **优化点**：利用 `a2ui_push` 动态生成带有操作按钮的卡片，而不仅依赖文字对话。
    *   **完善点**：通过 `injectCanvasLiveReload` 中的 `sendUserAction` 机制，Noe 可以处理用户在 Canvas 上点击的动作。这可以解决“确认删除”等需要明确按钮反馈的场景，提高交互的鲁棒性。

*   **视觉环境感知 (Spatial Awareness)**：
    *   **优化点**：通过 `snapshot` 动作，Noe 可以定期获取远端节点（如移动设备）的屏幕截图。
    *   **能力提升**：Noe 可以利用多模态模型分析快照内容，实现诸如“告诉我我现在的屏幕上在显示哪个 App”或“帮我看看这个报错信息是什么意思”的功能。

*   **实时反馈循环 (Real-time Feedback)**：
    *   **改进点**：利用宿主服务器的 `liveReload` 机制，Noe 可以一边生成代码一边在 Canvas 上实时预览效果。对于调试网页脚本或 UI 布局，这提供了一个即时反馈的“沙盒”环境。

---

### **4. 已读文件清单**

1.  `extensions/canvas/index.ts` (入口)
2.  `extensions/canvas/runtime-api.ts` (API 导出)
3.  `extensions/canvas/setup-api.ts` (配置迁移注册)
4.  `extensions/canvas/cli-metadata.ts` (CLI 元数据)
5.  `extensions/canvas/src/a2ui-jsonl.ts` (A2UI 逻辑)
6.  `extensions/canvas/src/capability.ts` (安全令牌)
7.  `extensions/canvas/src/cli-helpers.ts` (快照路径处理)
8.  `extensions/canvas/src/cli.ts` (CLI 命令实现)
9.  `extensions/canvas/src/config-migration.ts` (旧版配置兼容)
10. `extensions/canvas/src/config.ts` (配置 Schema 与校验)
11. `extensions/canvas/src/documents.ts` (文档物化核心算法)
12. `extensions/canvas/src/host-url.ts` (URL 解析)
13. `extensions/canvas/src/http-route.ts` (HTTP 路由适配)
14. `extensions/canvas/src/tool-schema.ts` (Agent 工具定义)
15. `extensions/canvas/src/tool.ts` (Agent 工具执行实现)
16. `extensions/canvas/src/host/a2ui-shared.ts` (共享路径与注入脚本)
17. `extensions/canvas/src/host/a2ui.ts` (A2UI 资源服务实现)
18. `extensions/canvas/src/host/file-resolver.ts` (安全文件解析算法)
19. `extensions/canvas/src/host/server.ts` (Node 宿主服务器底层)
