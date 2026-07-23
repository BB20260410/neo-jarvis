# BaiLongma capabilities 全读
已完成对 `src/capabilities/` 核心及 `src/api.js` 的**逐行完整读取**。以下是针对 Noe (本地 AI 助手) 的深度审计分析报告：

### 📁 已读清单与完成度
1.  **`src/capabilities/executor.js`**: 3419 行（全读，分段：1-2000, 2001-3419）
2.  **`src/capabilities/schemas.js`**: 1205 行（全读）
3.  **`src/capabilities/marketplace/index.js`**: 约 138 行（全读）
4.  **`src/api.js`**: 1387 行（全读）

---

### 1. `src/capabilities/schemas.js`
*   **职责**：工具元数据定义中心。为 LLM 提供所有可用工具的参数说明（JSON Schema）、描述及识别器高亮规则。
*   **核心机制**：
    *   **内置工具定义** (L4-L1188)：通过 `TOOL_SCHEMAS` 定义了包括 `send_message`, `web_search`, `read_file`, `ui_show` 等在内的 50+ 个工具。
    *   **动态 Schema 合并** (L1191-L1205)：`getToolSchemas` 函数负责将内置工具与从工具市场安装的自定义工具 schema 合并，并剔除识别器专用字段发给模型。
*   **Noe 优化建议**：
    *   **冗余清理**：`express` (L6) 属于向后兼容的旧工具，建议彻底移除以精简 LLM 的 Context 消耗。
    *   **参数强校验**：部分描述（如 `web_search` 的 limit, L141）可增加更严苛的提示，防止模型生成超出边界的参数。

### 2. `src/capabilities/executor.js`
*   **职责**：工具执行中枢（The Brain's Muscles）。负责文件 IO、网络搜索、Shell 命令执行、UI 控制、记忆操作、媒体播放等所有实际动作的底层调度与安全审计。
*   **核心机制**：
    *   **跨平台 Shell 兼容** (L33-L52)：针对 Windows 做了 UTF-8 编码同步处理（chcp 65001 + PowerShell 编码设置），确保中文输出不乱码。
    *   **安全审计与过滤** (L162-L260)：`TOOL_RISK` 等级划分及 `isDangerousShellCommand` 规则，拦截 `git reset --hard`, `rd /s` 等危险指令。
    *   **分级执行路由** (L270-L382)：`executeTool` 对接 `executeToolUnchecked` 及其下的 50+ 个子执行器。
    *   **网络搜索与内容抓取** (L830-L1150)：封装了 Serper, SearXNG, Bing, Jina 等多引擎 fallback 机制，并支持长文自动落盘 (`saveLongArticle`, L752)。
    *   **任务与 UI 管理** (L2900-L3300)：实现 `set_task` 状态追踪、ACUI 组件 (`ui_show`) 属性校验 (`validateProps`) 及挂载控制。
*   **Noe 优化建议**：
    *   **Bing 搜索鲁棒性** (L930)：目前基于 HTML 正则匹配，页面结构微调极易导致 `web_search` 失败，应引入更稳定的 HTML Parser 或多特征匹配。
    *   **浏览器资源复用** (L1160)：`getSharedBrowser` 使用了单例模式，但缺乏崩溃后的自动重启尝试机制，建议增加重试指数退避。
    *   **长文摘要集成**：目前长文只保存路径 (`body_path`)，Noe 可以增加一个“自动摘要”机制，在保存长文时预生成核心摘要，减少模型下一轮的 `read_file` 次数。

### 3. `src/capabilities/marketplace/index.js`
*   **职责**：动态工具引擎。允许 Noe 在运行时通过 Javascript “自我进化”，安装和卸载临时工具。
*   **核心机制**：
    *   **隔离编译** (L47-L58)：使用 `new Function` 构造异步函数体，注入 `args` 和 `helpers`。
    *   **受控权限提供** (L20-L43)：`buildHelpers` 提供受限的 `fetch` 和 `exec`（支持 Windows 编码补丁）。
    *   **持久化管理** (L129-L151)：`loadInstalledTools` 在系统启动时自动从沙盒 `installed_tools` 目录加载 JSON 定义。
*   **Noe 优化建议**：
    *   **安全沙箱升级**：目前的 `new Function` 容易被 `process` 对象泄露攻击，建议切换为 Node 的 `vm` 模块实现真正隔离。
    *   **异步化阻塞改进** (L23)：`helpers.exec` 目前使用 `execSync`，若自定义工具执行耗时命令会挂死主进程，应改为异步 `Promise` 包装。

### 4. `src/api.js`
*   **职责**：系统对外的 HTTP/WS 网关。管理对话流、前端 UI 状态同步、配置修改及 SSE 广播。
*   **核心机制**：
    *   **双路 WebSocket** (L1256, L1294)：`acuiWss` 负责 UI 双向交互（如卡片动作 `card.action`），`cloudWss` 处理音频 PCM 流。
    *   **实时事件流 (SSE)** (L341)：通过 `/events` 接口实现模型思考过程和状态的主动推送。
    *   **配置热更新** (L580-L860)：实现了包括 LLM 模型切换、TTS、Embedding 及安全沙箱在内的 10+ 个设置项的即时修改。
*   **Noe 优化建议**：
    *   **API 结构解耦** (L180-L1387)：`startAPI` 内部逻辑过重，建议将路由分发逻辑（如 `/settings`, `/admin`, `/media`）拆分为独立的 Controller 文件。
    *   **防御性编程**：局域网访问鉴权 (`isLanRequest`, L85) 仅靠 IP 判断，可增加一层更强的 HMAC 或 Session 校验，防止内网 CSRF 攻击。
