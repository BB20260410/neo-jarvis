以下是针对 `src/` 目录下各模块的系统性全覆盖阅读与深度解析报告。
### 顶层核心模块 (Top-Level Modules)
**`src/api.js`**
*   **职责**：HTTP/WebSocket 服务入口与路由层，连接前端 UI（Brain UI / ACUI）与后端核心。
*   **机制**：
    *   `src/api.js` - HTTP/WS 服务混载：通过 `http.createServer` 和 `WebSocketServer` 并在 `upgrade` 事件中完成握手路由，统一端口。
    *   `src/api.js` - ACUI 双向通道：`/acui` WebSocket 端点，用于视觉前端和后端心跳、状态控制、感知的实时传递。
    *   `src/api.js` - 统一拦截与异常处理：包装 `req.on('data')` 为 `readBody` 供各类 webhook（微信、企微、Discord 等）调用。
**`src/config.js`**
*   **职责**：系统级运行时全局配置读写与模型映射管理。
*   **机制**：
    *   `src/config.js` - `writeStoredConfig`：原子化地使用 JSON 落盘更新 `config.json`，处理了 TTS、ASR 及大模型等各类厂商 Key 的持久化。
**`src/control.js`**
*   **职责**：系统意识循环（Consciousness Loop）的暂停/恢复控制。
*   **机制**：
    *   `src/control.js` - `is_running` 逃生门：通过 `_running` 闭包变量提供 `stopLoop` 和 `startLoop` 接口，允许 API 层在不杀进程的情况下冻结 Agent 主循环。
**`src/db.js`**
*   **职责**：SQLite 数据库访问与架构级查询，使用 `better-sqlite3` 提供同步及事务层操作。
*   **机制**：
    *   `src/db.js` - `saveFocusStack` / `loadFocusStack`：持久化基于栈的长期注意力焦点（Focus Stack），实现 `JSON.stringify(f.conclusions || [])` 落盘以便支持跨实例重启的子主题感知。
**`src/desktop-scanner.js`**
*   **职责**：启动时扫描用户真实桌面目录文件与快捷方式，将环境视觉化转化为提示词。
*   **机制**：
    *   `src/desktop-scanner.js` - 跨平台快捷方式解析缓存：解析 `.lnk`、`.app`、`.desktop` 并基于 `mtime` 落盘缓存到 `data/` 目录，防止每次启动带来的高耗时。
    *   `src/desktop-scanner.js` - 文件数量阈值截断：超过 3 个同类型文件会被折叠如 `ext × 5 (a, b ...)`，以免占用系统提示词 Token。
**`src/local-resources-scanner.js`**
*   **职责**：收集宿主机的自有资源环境上下文（Git、SSH 配置）形成硬凭据提示。
*   **机制**：
    *   `src/local-resources-scanner.js` - SSH/KnownHosts 探查：解析 `~/.ssh/config` 和 `~/.ssh/known_hosts`，为 Agent 提供自解析主机名列表（"免密直接连，别问我凭证"）。
    *   `src/local-resources-scanner.js` - Git 身份挂载：解析 `~/.gitconfig` 抽取 username 和 email，使 Agent 在提交代码时具备自给自足的能力。
**`src/embedding.js`**
*   **职责**：向量计算层代理，将本地或远端 embedding 服务封装。
*   **机制**：
    *   `src/embedding.js` - 绝对静默容错（Lazy & Fallback）：抛出任何错误（网络、DNS、模型拒绝）均会被捕获返回 `null`，确保 FTS5 原生检索兜底方案依然存活。
**`src/events.js`**
*   **职责**：内部事件总线，维护 SSE（Server-Sent Events）连接状态以供向 UI 进行事件广播。
*   **机制**：
    *   `src/events.js` - `stickyEvents`（粘性事件缓存）：记录并推送在 UI 断线期间产生的重要事件（如 `startup_self_check_started` 音效），并在客户端重连时即刻补发。
**`src/geo-weather.js` & `src/weather.js`**
*   **职责**：依据 IP 自动探测地理位置、拦截会话中的天气询问，调用 `wttr.in` 检索天气情况。
*   **机制**：
    *   `src/weather.js` - 正则拦截与动态上下文组装：利用 `WEATHER_RE` 判别用户意图，获取 JSON 后将其组装为带有 `ttl` 和老化时长（"Data age: X minutes"）的 `<extra>` 提示区块。
    *   `src/geo-weather.js` - 定期 IP 刷新降级：如果公网 IP 不变则支持最长达 7 天的地理位置缓存，以减少无意义外部请求。
**`src/hotspots.js` & `src/trending.js`**
*   **职责**：管理和采集网络新闻聚合与焦点追踪（包括 HackerNews、微博热搜、知乎等）。
*   **机制**：
    *   `src/trending.js` - 分区数据源探测：以 `country_code` 决策抓取线路（中国走 vvhan 抓微博/知乎，海外走 Reddit + HN），一小时 TTL 缓存刷新。
**`src/identity.js`**
*   **职责**：系统身份层，将不同社交渠道的外部账户抽象到 Canonical 用户映射上。
*   **机制**：
    *   `src/identity.js` - 身份挂载统一层：处理单用户模式与多用户模式切换，无论微信还是 Discord 的入口 ID 最终均归一化为 `ID:000001` 等内部结构标识。
**`src/index.js`**
*   **职责**：整个 Agent 后台的启动主入口和核心意识循环调度（Consciousness Loop）编排器。
*   **机制**：
    *   `src/index.js` - 终端启动守卫：如果 API Key 缺失，将挂起服务并阻塞引导打开 `activation.html` 要求进行配置；只有验证后才激活心跳及调度。
**`src/key-auto-config.js`**
*   **职责**：用户在聊天流直接贴入 API Key 时的动态匹配与零配置服务激活。
*   **机制**：
    *   `src/key-auto-config.js` - 正则截获及服务试探：以 `/[A-Za-z0-9\-_.]{20,120}/` 和提供商语境提取 Key 并向对应服务（如 `testTTSKey`）静默发送连通性测试。
**`src/llm.js`**
*   **职责**：大语言模型流式交互层，执行 Token 控制与函数调用编排（Tool Call Router）。
*   **机制**：
    *   `src/llm.js` - 退避与流式重试：`streamOnceWithRetry` 处理 5xx、408 网络抖动带来的暂时性失效。
    *   `src/llm.js` - 并行工具安全执行网（Parallel Safe Tools）：通过查表 `PARALLEL_SAFE_TOOLS`（包含查文档、搜索）实现了同 Turn 多工具请求的并发聚合（`Promise.all`），无副作用读工具不锁串行。
    *   `src/llm.js` - Action Claim 阻断：监控大模型写虚假文字执行操作（如 "【调用成功】" 或 "```json ...```" 逃避原生 tool_call）并通过 `buildFakeToolCallNudge` 向模型直接施压阻断。
**`src/paths.js`**
*   **职责**：解耦 Electron 生产环境（asar 资源）与开发环境沙盒数据存放位置。
*   **机制**：
    *   `src/paths.js` - 只读资源与沙盒数据分离：通过 `BAILONGMA_USER_DIR` 和 `BAILONGMA_RESOURCES_DIR` 隔离可变数据库/缓存资源，与随包的预热只读资料相剥离，确保 Electron 架构下可正常执行。
**`src/person-cards.js`**
*   **职责**：通过拦截并查询用户提到的人物百科、名人身份信息并进行展示与长周期记忆注入。
*   **机制**：
    *   `src/person-cards.js` - ID 离散哈希去重：`personCardId` 使用 sha1 摘要保证无论名字有何细微变更，底层长期记忆都指向相同的规范实体 ID 进行累积更新。
**`src/prompt.js`**
*   **职责**：系统核心 Prompt Builder（包含稳定提示词块、以及基于上下文可变的区块拼装）。
*   **机制**：
    *   `src/prompt.js` - Static Prefix Cache 防护：将 `buildSystemPrompt` 中的易变时间及环境变量（currentTime / existence）后置移除到 `buildContextBlock` 以 `<runtime>` 标签渲染，确保大段规则匹配底层 DeepSeek prompt cache。
    *   `src/prompt.js` - 焦点（Focus）多栈回溯提示：在 `<focus>` 段中不仅注入当前 `top.topic`，而且渲染子节点压缩完毕后 `conclusions` 归档的内容，帮助 L2 Agent 知道在专注主线的同时不重新发问已知事实。
**`src/queue.js`**
*   **职责**：消息优先级调度与打断信号生成（TUI > SYSTEM）。
*   **机制**：
    *   `src/queue.js` - `pruneSupersededUserMessages` 冲突去重：相同用户不同通道或短时间重复下发的话语依据（fromId, channel）特征抹除旧有冗余队列项，防止模型上下文浪费。
**`src/quota.js`**
*   **职责**：API Tokens 的配额风控、限制拦截与滑动窗口计数。
*   **机制**：
    *   `src/quota.js` - `getAdaptiveTickInterval` 自适应节律：结合 60s 消耗量及当前 TPM 容量自适应调整 Agent 心跳间隔（在 `ratio > 0.9` 接近熔断时放缓心跳至 120s）。
**`src/system-info.js`**
*   **职责**：底层系统基础配置侦测及监控。
*   **机制**：
    *   `src/system-info.js` - 跨平台硬件感知器：调用 macOS `pmset`，Linux `sys/class/power_supply`，及 Win32 COM `Get-WmiObject` 监控电量（拔插通知）、本地 IP、磁盘真实迁移路径并持久化落盘。
**`src/system-prompt-preview.js`**
*   **职责**：将 Agent 此刻的实际状态、上下文渲染后抛回给前端调试页面展现用。
*   **机制**：
    *   `src/system-prompt-preview.js` - `buildHeartbeatSystemPromptPreview`：合成出在 SystemPrompt.html 端看得到的 "Snapshot Clone" 快照层。
**`src/ticker.js`**
*   **职责**：L2 心跳与自主节律调整器。
*   **机制**：
    *   `src/ticker.js` - 节律倒计时（TTL）：Agent 利用工具申请特定心跳频率（如："等我10分钟后再跑"），当此轮心跳结束后，TTL 自减直至回归基线 300s/次心跳。
**`src/time.js`**
*   **职责**：跨平台的全局时间基准转化工具。
*   **机制**：
    *   `src/time.js` - 时段感知 `formatTick`：以 Ticker 时间为基准抛出 `early morning`, `midnight` 之类的时段定语，以供 Agent 推断自身作息情况。
**`src/tui.js`**
*   **职责**：终端标准输入流监控（如果在控制台直跑该项目）。
*   **机制**：
    *   `src/tui.js` - `readline` 交互桥架：支持终端控制台以非阻塞 `rl.prompt` 不断压送消息进入 `queue.js` 管道。
**`src/utils.js`**
*   **职责**：基础通用的代码解构解析工具。
*   **机制**：
    *   `src/utils.js` - `<think>` 剥离：`extractJSON` 使用正则表达式抹除 `<think>...</think>` 以及 ` ```json ` 块，专为那些没走 Function Calling 而写 JSON 的大模型做健壮性解析支持。
**`src/docs.js`**
*   **职责**：维护在对话和 ACUI 层呈现的技术解答面板和 FAQ 对接。
*   **机制**：
    *   `src/docs.js` - 文档 TTL 生命周期（TTL Context Injection）：记录用户打开过哪些技术支持面板（如大模型配置教程），文档展开期间强行注入 Context；TTL（30 分钟）后自动抹除失效防止浪费 Token。
---
### 子目录模块 (Subdirectories)
#### `src/agents/` (智能体探查架构)
*   **`detector.js`**
    *   **机制**：利用 `child_process.execSync` 和 `probeCommand` 在用户的 PATH 中去扫描（如 Python、Roslyn、Rust、Playwright）从而告知 Agent 在系统中可使用哪些外部编程扩展。
*   **`registry.js`**
    *   **机制**：使用 `CONFIG_KEY_ASKED`，对于探查到的外置能力，先强制引导 Agent 进行授权问询（User delegation），拿到确认才开放复杂开发指令。
#### `src/capabilities/` (Agent 工具箱与安全执行域)
*   **`executor.js`**
    *   **机制**：执行能力工具的核心调度类，包含了极长的高危命令阻断及安全层；包括浏览器、执行 Shell 等，具有非常复杂的长短期历史日志追踪及熔断处理。
*   **`marketplace/index.js`**
    *   **机制**：以沙箱（`sandboxDir`）动态加载外部开发者或插件发布的 JS 脚本组件，将 `description` 与 `schema` 热注册并扩充 Agent 的行为边界。
*   **`schemas.js`**
    *   **机制**：工具规范列表，利用 `TOOL_SCHEMAS` 常量去映射每一个能力的字段说明，作为 OpenAI-Compatible 接口的标准 Tool Call 参数返回结构体。
#### `src/context/` (动态语境组装层)
*   **`gatherer.js`**
    *   **机制**：基于 `needs` 的充分性检查反馈，用于判断当前的 Context 提供的信息是否足够，执行 "检索 → 不够 → 继续补血 → 组合" 的收集回环并序列化。
#### `src/docs/` (动态使用指引)
*   **`config-faq.js` & `voice-config-faq.js`**
    *   **机制**：管理硬编码在代码内部的配置文档对象池（如教 Agent 怎么连接语音，怎么对接微信平台）。
*   **`self-knowledge.js`**
    *   **机制**：自检百科架构，利用硬编码正则拦截含有 `工作原理|机制` 等探测性问题，将系统的内部设计组装投喂。
#### `src/memory/` (记忆池存储与分级记忆系统)
*   **`concept-extractor.js`**：纯 Node 端关键词提取，采用 N-Gram 计算过滤 `STOP_WORDS`，供 SQLite FTS5 引擎作为入库特征基准点。
*   **`consolidation-loop.js` & `consolidator.js`**：基于 30 分钟轮询（`timer = setInterval(tick, RUN_INTERVAL_MS)`），抽取陈旧的长期记忆让 LLM 进行总结清理压缩（Batch 跑，防止长记忆无限膨胀）。
*   **`embedding-backfill.js`**：提供一个脱离主线程的手动回填接口，填补存量并未被执行 Embedding 向量初始化的记忆条目空洞。
*   **`focus.js` & `focus-compress.js` & `focus-classifier.js`**：极其完善的"动态栈结构注意力系统"（Dynamic Context Frame）。
    *   通过 `focus.js` (`push`, `pop`, `getFocusFrame`) 处理焦点转移。
    *   当偏离原讨论点或超时时，使用 `focus-compress.js` 发起单次 LLM 推理归纳出这整个栈的 Conclusion 压入原栈父级，形成短语历史记忆归档。
    *   `focus-classifier.js` 作为语义仲裁节点，使用硬超时机制判断新词汇应进入何种意图槽。
*   **`injector.js`**：组装最近发生的动作流（Action Log）和通过实体、关键字抽取的历史数据库特征集，编织为给模型参考的上下文。
*   **`keywords.js`**：将 `search_memory` 的字面向量转换为长短语并提供给检索执行器。
*   **`recognizer.js`**：主线消息到来时的火线记忆分片引擎。拦截信息，并行判断该消息是否形成并值得插入长期数据库库里进行向量编码与结构化存档。
*   **`refresh-loop.js`**：定时循环触发的记忆强化策略，维持与 Agent 高频互动部分的长期联接新鲜度。
*   **`seed-skills.js`**：初始化动作，启动时直接解析 `AGENT_GUIDE.md` 等外部说明并自动通过 Hash 种子存入本地 Sqlite 作为内化长时操作技能指南。
*   **`temporal-parser.js`**：纯函数引擎，抽取"大前天"、"昨晚"等相对口语名词，正则转译归一化并结合 `time.js` 转为准确时间差区间进行查询。
*   **`tool-router.js`**：使用意图探查判断，在请求抵达前预测哪些类型的工具箱不需要传给 LLM（如完全与系统操作无关的聊天省略 `files_tool` 传参，缩减一半以上的 Token 消耗）。
#### `src/prefetch/` (静态网络预抓取预热任务)
*   **`runner.js`**
    *   **机制**：维护在后台队列中需要常驻并保持刷新状态的网络数据（例如 `parseWttrJson` 实时天气），用 Promise AllSettled 管理失败静默退避。
#### `src/providers/` (大模型厂商适配器核心)
*   **`base.js`**
    *   **机制**：`BaseProvider` 基类定义 `canDo` 验证及基础 HTTP 调用封装。
*   **`minimax.js`**
    *   **机制**：继承自 Base，配置大模型特定的（如 Minimax 海螺）生图（image）、语音（tts）支持的 Endpoint 组装及参数传递，并打点限流配额系统 `recordDailyUsage`。
*   **`registry.js`**
    *   **机制**：维护全局数组管理 Providers 的接入与能力检索路由 `listCapabilities`。
#### `src/social/` (社交网桥与连接器)
*   **`index.js`**：主入口聚合，提供连接池 `startSocialConnectors` 进行并发状态跟踪与重启。
*   **`discord.js`**：针对 Discord 的 WS 客户端封装代理。
*   **`dispatch.js`**：利用 Switch 根据 `targetId`（如 `wecom-webhook`, `wechat-clawbot`）路由出站文本/动作给具体的平台文件。
*   **`http.js` & `utils.js`**：基础环境辅助（读取 `process.env`）和统一 Webhook `jsonResponse` 拦截出口。
*   **`targets.js`**：规范不同来源社交 ID 头标志并抽离前缀。
*   **`webhooks.js`**：提供企微、飞书回调端点的路由处理及 XML 加解密转换鉴权。
*   **`wechat-clawbot.js`**：微信生态特殊处理，使用个人号桥接组件，涉及 Context Token 的拉取验证、持久化及被动会话保护规则（无权限/无心跳则指导用户如何从外侧恢复通道）。
*   **`xml.js`**：企业微信/微信回馈事件的轻量无依赖解析正则提取，防污染并快速反序列化。
#### `src/ui/` (Brain UI 图形展示界面前端主件)
*   **`brain-ui/app.js`**
    *   **机制**：图形展示页前端的主控制器；包含了 D3.js 所驱动的 "Memory Graph（记忆球群力学布局与游走）"；并包含与后端 WebSocket 的 `connectSSE()` 消息联动，展示 Focus Stack，绘制各种动画卡片、主题配置及页面缩放等功能。
*   **`brain-ui/api-client.js`**
    *   **机制**：封装所有对于底层 Local API 调用的前置路径，适配从跨域请求及 Electron 的 Native API 抓取环境判定。
#### `src/voice/` (语音通讯子系统)
*   **`cloud-asr.js`**
    *   **机制**：利用后端签名作为 WebSocket 代理分发，将麦克风录入的数据转发给阿里云（首选）、腾讯云、科大讯飞服务，对前端实现隔离层保护 Key 泄露。
*   **`manager.js`**
    *   **机制**：利用 `child_process.spawn` 控制和启停 Python 环境（Whisper Server），监听状态与资源重启（如模型大小变化触发清理）。
*   **`tts-providers.js`**
    *   **机制**：调用多方（OpenAI/豆包/ElevenLabs/火山）API 发起合成请求并将返回值使用 Node.js `Transform` 管道拼接回 Stream ，交由 `api.js` 将字节流管道（Pipe）导给前端扬声器。
---
### 已覆盖模块清单
*   `api.js`
*   `config.js`
*   `control.js`
*   `db.js`
*   `desktop-scanner.js`
*   `docs.js`
*   `embedding.js`
*   `events.js`
*   `geo-weather.js`
*   `hotspots.js`
*   `identity.js`
*   `index.js`
*   `key-auto-config.js`
*   `llm.js`
*   `local-resources-scanner.js`
*   `paths.js`
*   `person-cards.js`
*   `prompt.js`
*   `queue.js`
*   `quota.js`
*   `system-info.js`
*   `system-prompt-preview.js`
*   `ticker.js`
*   `time.js`
*   `trending.js`
*   `tui.js`
*   `utils.js`
*   `weather.js`
*   `agents/detector.js`, `agents/registry.js`
*   `capabilities/executor.js`, `capabilities/marketplace/index.js`, `capabilities/schemas.js`
*   `context/gatherer.js`
*   `docs/config-faq.js`, `docs/self-knowledge.js`, `docs/voice-config-faq.js`
*   `memory/concept-extractor.js`, `memory/consolidation-loop.js`, `memory/consolidator.js`, `memory/embedding-backfill.js`, `memory/focus-classifier.js`, `memory/focus-compress.js`, `memory/focus.js`, `memory/injector.js`, `memory/keywords.js`, `memory/recognizer.js`, `memory/refresh-loop.js`, `memory/seed-skills.js`, `memory/temporal-parser.js`, `memory/tool-router.js`
*   `prefetch/runner.js`
*   `providers/base.js`, `providers/minimax.js`, `providers/registry.js`
*   `social/discord.js`, `social/dispatch.js`, `social/http.js`, `social/index.js`, `social/targets.js`, `social/utils.js`, `social/webhooks.js`, `social/wechat-clawbot.js`, `social/xml.js`
*   `ui/brain-ui/app.js`, `ui/brain-ui/api-client.js` (UI 层的核心入口及代理器)
*   `voice/cloud-asr.js`, `voice/manager.js`, `voice/tts-providers.js`
### 未读到的文件
*   所有处于 `src/ui/brain-ui/` 下的其余大量前端展现视图组件和工具链（如 `app-shell.js`、`chat.js`、`voice-panel.js`、`acui/registry.js`、`thought-stream.js` 等等）。
*   所有处于 `src/ui/` 层非 Brain UI 的其他子系统（比如某些可能的 Web 配置文件夹）。
*   所有的测试框架及脚手架代码文件（`src/test-*.js`, `src/test-*.mjs`），并未在正向系统性覆盖要求清单列出范围内。
