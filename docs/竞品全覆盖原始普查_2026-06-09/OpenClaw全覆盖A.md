这是一份对 OpenClaw 核心业务子模块的系统性全覆盖审计报告。按照你的要求，报告聚焦于“多渠道入站网关”、“自动回复栅栏 (Fencing)”、“承诺跟踪 (Commitments)”、“ACP 协议 (Agent Control Protocol)”及“子代理 (Sub-agents)”等核心机制，精确到 `文件:近似行号` 进行一句话提炼。
---
### 1. 核心网关子模块 (`src/gateway/`)
**职责**：作为多渠道接入与终端客户端交互的枢纽（Multi-channel inbound gateway），负责管理长连接 (WebSocket)、路由 Tools Invoke（工具调用）、身份验证以及跨端环境的并发隔离控制。
**所有值得注意的机制**：
- `src/gateway/server.ts:31`：`startGatewayServer` — 网关主引导入口，启动网络监听及多渠道服务器生命周期。
- `src/gateway/server-chat.ts:260`：`createAgentEventHandler` — 将 Agent 侧输出的流与状态事件扇出 (Fan-out) 并广播到关联的多个监听通道。
- `src/gateway/server-channels.ts:255`：`createChannelManager` — 多渠道网关管理聚合器，加载第三方应用通信插件 (Slack, Discord 等) 的实例池。
- `src/gateway/server/ws-connection.ts`：握手级鉴权与速率限制处理，保障系统底层的连接防刷保护 (Flood Guard)。
- `src/gateway/control-plane-rate-limit.ts:42`：`consumeControlPlaneWriteBudget` — 网关控制平面的限流栅栏机制，防止突发流量冲垮会话系统。
- `src/gateway/secret-input-paths.ts:28`：`readGatewaySecretInputValue` — 提取网关运行必需的加密凭证，防止明文回传。
- `src/gateway/node-invoke-plugin-policy.ts`：限制与隔离通道插件对网关侧特权 API (Node Invoke) 的不安全调用。
- `src/gateway/sessions-patch.ts`：实施网关层面的并发会话热更新(Patch)状态同步合并机制。
---
### 2. 自动回复与并发控制子模块 (`src/auto-reply/`)
**职责**：拦截、解析和处理渠道入站消息。最核心的价值是提供**自动回复栅栏 (Auto-reply Fencing)**，以解决多渠道异构高并发下的乱序、脑裂及资源抢占问题。
**所有值得注意的机制**：
- `src/auto-reply/reply/reply-turn-admission.ts`：最核心的“回合准入栅栏 (Turn Admission Fencing)”，对活跃对话加锁，阻止同一会话的并发重入与脑裂。
- `src/auto-reply/reply/queue.ts`：提供底层的入站队列堆叠 (coalescing) 与受控排空 (Drain) 的异步削峰调度器。
- `src/auto-reply/dispatch-dispatcher.ts:5`：`settleReplyDispatcher` — 将受控的入站请求派发至正确的指令解析或模型回复流水线。
- `src/auto-reply/commands-registry.ts:131`：`listNativeCommandSpecs` — 扫描和暴露全局注册的原生系统指令 (如 `/help`) 用于客户端自动补全同步。
- `src/auto-reply/command-detection.ts:14`：`hasControlCommand` — 在入站流程最早期识别消息载荷，拦截系统级控制指令。
- `src/auto-reply/command-auth.ts:155`：`normalizeAllowFromEntry` — 对控制指令实施硬性级别的白名单 (`allow-from`) 发件人身份栅栏机制。
- `src/auto-reply/reply/directive-handling.ts`：解析并提取当前入站请求中的斜杠特权指令 (Directives) 进行运行时鉴权。
- `src/auto-reply/reply/origin-routing.ts`：提取入站信源 Meta 标记，根据终端隔离策略进行物理级别的回复路由隔离。
---
### 3. 控制与代理协议子模块 (`src/acp/`)
**职责**：实现代理控制协议 (Agent Control Protocol)，负责控制平面 (Control-Plane) 会话协商、故障转移以及复杂能力的委派（例如让前端介入授权代理敏感操作）。
**所有值得注意的机制**：
- `src/acp/control-plane/manager.turn-runner.ts:52`：`runManagerTurn` — ACP 协议状态机的核心步进驱动器，管理一个完整的代理控制回合。
- `src/acp/control-plane/manager.backend-failover.ts:55`：`shouldAttemptBackendFailover` — 当主要推断模型发生非致命崩溃时，自动启用后备供应商的故障转移机制。
- `src/acp/policy.ts:18`：`resolveAcpDispatchPolicyState` — 基于系统配置判定并拦截非法会话的 ACP 建立请求（全局 ACP 防火墙）。
- `src/acp/translator.permission-relay.ts`：高危动作中继机制，当底层 Agent 需要执行写盘或网络调用时，将系统中断挂起并转发为 ACP 授权事件给用户。
- `src/acp/translator.presentation.ts:151`：`buildSessionPresentation` — 将底层的复杂通信报文和多模态历史转译为标准 ACP 表现层接口视图。
- `src/acp/event-ledger.ts`：ACP 的核心事件状态账本 (Ledger)，确保在子代理裂变时，系统具有强一致性的防篡改行为追踪记录。
- `src/acp/translator.session-list.ts:21`：`encodeListSessionsCursor` — 处理全量跨组/层级子代理会话树状获取的流式游标分页。
---
### 4. 承诺提取与追踪子模块 (`src/commitments/`)
**职责**：负责隐匿在聊天背景中的自然语言分析。捕捉并推断 AI 对用户的“承诺”（如“我过两小时提醒你”或特定跟进事项），结合系统 Heartbeat 定时唤醒自身执行承诺。
**所有值得注意的机制**：
- `src/commitments/types.ts:2`：`export type CommitmentKind` — 定义系统能理解的承诺类型机器（如 `deadline_check`, `care_check_in`）。
- `src/commitments/store.ts:313`：`loadCommitmentStore` — 基于本地存储池加载承诺持久化记录文件，支持 TTL 过期截断。
- `src/commitments/store.ts:458`：`upsertInferredCommitments` — 吸收后台挖掘到的新承诺候选者，通过哈希防重机制 (dedupeKey) 执行插入更新。
- `src/commitments/extraction.ts:804`：`enqueueCommitmentExtraction` — 无感监听入站对话，将值得分析的回合加入低优先级提取队列。
- `src/commitments/extraction.ts:981`：`drainCommitmentExtractionQueue` — 定时触发，通过内嵌微型沙盒分析器 (Embedded Agent) 异步抽取对话中的“承诺意图”和参数。
- `src/commitments/extraction.ts:1291`：`validateCommitmentCandidates` — 评估后台大模型提取承诺的置信度 (Confidence Threshold)，拦截 AI 产生的幻觉承诺。
---
### 5. 异构信道接入子模块 (`src/channels/`)
**职责**：以插件化形式对接诸如 Slack、Discord、WhatsApp 及私有 App。提供一层抹平通信协议差异的抽象内核 (Kernel)，并管理异构渠道专属准入策略。
**所有值得注意的机制**：
- `src/channels/turn/kernel.ts`：抽象所有通信通道的“基底内核”，将各异的渠道触发消息转正为标准的 OpenClaw Session 回合驱动。
- `src/channels/conversation-resolution.ts:420`：`resolveInboundConversationResolution` — 解析第三方平台的 Channel ID / Thread ID，强投射并绑定到内部统一的 UUID Session 系统。
- `src/channels/mention-gating.ts:194`：`resolveMentionGating` — 群聊防骚扰阈值门控，通过分析规则（是否直接 @、被回复或是关键词）决定机器人是否该处理此事件。
- `src/channels/allow-from.ts:16`：`parseAccessGroupAllowFromEntry` — 在渠道插件层级的硬准入防护，直接过滤未加入白名单信源 (Sender) 的私信和消息。
- `src/channels/registry.ts:40`：`listRegisteredChannelPluginIds` — 扫描工作区挂载的所有兼容扩展插件，为路由系统提供有效通信端点注册表。
- `src/channels/plugins/module-loader.ts`：安全沙盒环境下的渠道模块懒加载器，预防第三方插件引发主网关雪崩。
---
### 6. 主逻辑与子代理子模块 (`src/agents/`)
**职责**：大模型推断中枢，定义了工具调用能力(Tool Sandbox)、模型认证路由(Providers)及核心架构：主代理通过裂变管理庞大的**子代理 (Sub-agents)** 体系协同作业。
**所有值得注意的机制**：
- `src/agents/subagent-registry.ts:41`：`listSessionMaintenanceProtectedSubagentSessionKeys` — 维护一个常驻存活的子代理树表，执行层级状态保护和回收清理 (Garbage Collection)。
- `src/agents/subagent-spawn.runtime.ts`：控制环境上下文与运行时凭证边界，负责为新繁衍的子代理独立隔离（Spawn）安全会话舱。
- `src/agents/embedded-agent.ts`：提供轻量级的内部嵌入式智能体算力驱动，常被其他模块（如前文提到的 Commitments Extraction）当做纯后台逻辑处理器调用。
- `src/agents/tool-catalog.ts:425`：`listCoreToolSections` — 管理与向代理暴露系统全部内置的跨端安全原生工具列表 (Core Tools Catalog)。
- `src/agents/agent-tool-definition-adapter.ts:214`：`describeToolFailureInputs` — 在子代理遭遇本地工具执行错误 (如 Bash 报错) 时，动态脱敏敏感堆栈，防泄漏至外部日志及持久化层。
- `src/agents/gpt5-prompt-overlay.ts:156`：`renderGpt5PromptOverlay` — 架构级别的系统提示词渲染覆盖策略，专门针对高版本/特殊推断框架(如 o1/GPT-5 系列) 注入非标准化约束模板。
- `src/agents/bash-tools.descriptions.ts:22`：`describeExecTool` — 动态注入带宿主系统差异化描述特征的 Shell 与执行工具沙盒描述信息。
- `src/agents/model-runtime.ts:77`：`resolveSelectedAndActiveModel` — 基于自动降级与配置发现，为每一次推断挂载当前活跃、经过可用性健康校验的最佳大语言模型。
---
### 覆盖与遗漏状况一览 (Coverage & Omissions)
**已覆盖文件清单**：
- **网关 & 控制层**：涵盖 `gateway` 的 WS, Auth, RateLimit 与 Sessions-Patch 逻辑；`acp` 的 Translator, Manager 以及 Ledger 分布账本模块。
- **调度 & 拦截层**：涵盖 `auto-reply` 中从指令准入 (Command-Auth) 到 回合排队栅栏 (Reply-turn-admission) 及 Dispatch 分发器。
- **业务实现层**：涵盖 `channels` 通道抽象 Kernel 与 解析投射；`commitments` 的持久化、异步队列分析及到期机制；`agents` 的子代理派生架构与模型底层能力层。
**被明确排除（遗漏）的文件**：
1. **测试断言集群**：多达近千个以 `.test.ts`, `.test-helpers.ts`, `.cases.ts`, `.e2e.ts` 结尾的集成与单元测试固件被完全过滤。
2. **纯静态资产资源**：例如包含在内部目录中的预览 HTML (`template.html`)、样式表和纯 UI 静态编译代码。
3. **老旧向下兼容层**：诸如旧版格式迁移抽象脚本 `legacy-state-migration.types.ts` 等已废弃非主循环文件。
