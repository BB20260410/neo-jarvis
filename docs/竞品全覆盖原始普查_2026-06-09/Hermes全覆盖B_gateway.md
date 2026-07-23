以下是对 `gateway/`、`hermes_cli/`、`acp_adapter/`、`acp_registry/` 和 `cron/` 目录的系统性全覆盖分析报告。已重点关注消息网关（Telegram/Discord）、CLI 子命令、ACP 适配与注册、定时任务、Dashboard Auth 以及 Proxy。
---
### 1. `gateway/` (消息网关模块)
**职责**：负责接收各大消息平台（Telegram、微信、Slack、Feishu等）的消息输入，维持会话（Session）与鉴权上下文，分发给大模型 Agent，处理 Agent 的流式返回并投递到指定目标频道。
**重点机制映射 (文件:行)**：
*   **网关主干运行逻辑**：
    *   `run.py` (L1866): `GatewayRunner` —— 网关总调度引擎。
    *   `run.py` (L15333): `start_gateway` —— 网关全生命周期的启动核心协程。
    *   `stream_consumer.py` (L79): `GatewayStreamConsumer` —— 将 Agent 输出转为平台适配的文本或流切片。
    *   `delivery.py` (L175): `DeliveryRouter` —— 决定回传消息应投递到原路还是备用频道。
    *   `session.py` (L684): `SessionStore` / `SessionContext` (L160) —— 管理长期会话（存储并组织对话历史）。
*   **平台：Telegram**：
    *   `platforms/telegram.py` (L334): `TelegramAdapter(BasePlatformAdapter)` —— 核心 Telegram API 适配器，处理 Long Polling 与发送。
    *   `platforms/telegram.py` (L281): `_wrap_markdown_tables` —— 解决 Telegram MarkdownV2 表格兼容性问题的机制。
*   **平台：Discord**：
    *   *注：当前 `gateway/platforms` 下并没有独立的 `discord.py`，但系统级深度集成了 Discord 特殊逻辑：*
    *   `channel_directory.py` (L112): `_build_discord(adapter)` —— 从底层 adapter（可能通过插件等加载）枚举所有 Discord 频道和 Guilds（L328）。
    *   `session.py` (L206): `_discord_tools_loaded()` —— 判断会话是否拥有 `discord` 工具链，以在 Discord 下注入成员 ID 供系统调用 `@mentions` 机制（L328）。
### 2. `hermes_cli/` (命令行与控制面模块)
**职责**：提供用户管理、配置模型、本地服务启停（Proxy、Dashboard等）、诊断环境的主入口界面。
**重点机制映射 (文件:行)**：
*   **CLI 主干与子命令 (subcommands)**：
    *   `main.py` / `_parser.py` (L84): `build_top_level_parser()` —— 初始化主干命令解析器。
    *   `subcommands/*.py`: 将子命令按文件解耦（如 `acp.py`, `auth.py`, `dashboard.py`, `mcp.py`, `gateway.py`）。
    *   `skills_hub.py` (L1538): `skills_command()` —— 工具/技能下载安装交互逻辑。
*   **Dashboard Auth (dashboard_auth/)**：
    *   `dashboard_auth/routes.py` (L1+): `FastAPI` 路由 —— 处理 Web UI 的登入、校验。
    *   `dashboard_auth/middleware.py` (L1+): 拦截无权限（缺少有效 Token/Cookie）请求的 FastAPI 请求中间件。
    *   `dashboard_auth/cookies.py` (L1+): 安全 Token 签名与 Cookie 注入读取机制。
    *   `dashboard_auth/ws_tickets.py` (L1+): 处理 Web 端 Dashboard 进行 WebSocket 连接时使用的一次性短期鉴权票据生成机制。
*   **Proxy (proxy/)**：
    *   `proxy/server.py` (L84): `create_app()` / `run_server()` (L243) —— 拦截并代理流量的本地 Web 服务。
    *   `proxy/adapters/xai.py` (L31): `XAIGrokAdapter` —— 本地连通 XAI 大模型等特定服务的代理鉴权转换机制。
    *   `proxy/cli.py` (L30): `cmd_proxy_start()` —— 从 CLI 拉起代理服务的命令入口。
### 3. `acp_adapter/` & `acp_registry/` (ACP 协议适配模块)
**职责**：实现与 Cursor/VS Code 等编辑器生态中 ACP/MCP（Anthropic/Agent Context Protocol）协议的接轨，允许编辑器通过标准 StdIO 控制 Agent 并读写上下文。
**重点机制映射 (文件:行)**：
*   **ACP Adapter 机制**：
    *   `server.py` (L446): `HermesACPAgent(acp.Agent)` —— 封装核心事件循环，将 Hermes 转为标准的 ACP 响应服务器。
    *   `entry.py` (L212): `main()` —— Adapter 作为独立进程启动并在 `stdio` 监听 ACP 帧。
    *   `edit_approval.py` (L148 & L234): `should_auto_approve_edit` / `make_acp_edit_approval_requester` —— 对 Agent 试图写文件/修改文件的指令，生成编辑审查机制，弹窗等待用户拦截或批准。
    *   `events.py` (L209): `make_step_cb` —— 封装将任务进展转化为 ACP 协议进度回调帧。
    *   `tools.py` (L1017 & L1249): `build_tool_start` / `build_tool_complete` —— 大量用于规范化返回值（如 browser, search, read_file 等）将其扁平化以适应协议。
*   **ACP Registry 机制**：
    *   `acp_registry/agent.json` (L1-16): JSON 清单定义。向系统声明 `"id": "hermes-agent"` 及其 uvx 启动包裹指令（`hermes-acp`）。
    *   `acp_registry/icon.svg`: Hermes 的矢量标志，供 IDE 面板显示。
### 4. `cron/` (定时任务模块)
**职责**：周期性地唤起指定的 Agent 任务（如定时巡检、周期推送早报）。
**重点机制映射 (文件:行)**：
*   **任务调度与执行**：
    *   `scheduler.py` (L2016): `tick()` —— 主轮询锁循环，从数据库读取到期任务。
    *   `scheduler.py` (L1351): `_run_job_impl()` —— 将触发的定期指令（Prompt）下发给 Hermes Agent 实例执行。
    *   `scheduler.py` (L724): `_deliver_result()` —— 任务执行完毕后，自动调用网关底层将结果推送回平台（例如 Telegram 指定的群组或频道）。
*   **存储与状态流转**：
    *   `jobs.py` (L209): `parse_schedule()` —— 解析 `crontab` 时间表达式。
    *   `jobs.py` (L550): `create_job()` —— 用户新建一个长驻型定时任务记录。
    *   `jobs.py` (L1012): `get_due_jobs()` —— 提取当前时间已逾期/待触发的任务清单。
    *   `jobs.py` (L983): `advance_next_run()` —— 触发后递进下一个 cron 执行时间锚点。
---
### 全覆盖清单与遗漏评估
*   **已完全覆盖 (通过文件及 AST 全面索引)**：
    *   **ACP (Adapter + Registry)**: 结构小且内聚，全部核心逻辑（授权、工具、通信）已映射。
    *   **Cron**: 所有基于 SQLite 和轮询执行调度的机制（`jobs.py` + `scheduler.py`）映射完毕。
    *   **Dashboard Auth & Proxy**: 对 `hermes_cli/` 目录下的这俩特定文件夹的入口及核心类全覆盖解析。
*   **可能遗漏/注意事项**：
    *   **Discord 的具体 API 调用缺失**：在 `gateway/platforms/` 内未寻找到独立的 `discord.py`。虽然其上下文处理被深度写入到了 `session.py` 与 `run.py`，判断：底层具体的 Discord API 可能抽离在了 `plugins` 文件夹下或者系统设计中 Discord 由独立子进程代理。
    *   **其他平台/机制的极细节函数**：`hermes_cli` 与 `gateway` 体积庞大（如 `main.py` 有 460KB+，`run.py` 有 750KB+）。本次采用类、顶层异步/同步方法特征进行了 AST/正则解析和架构抓取。极微小的工具函数（如时间转换等）虽被读取，但未列举在报告中以免混淆重点。核心（职责→机制）无一遗漏。
