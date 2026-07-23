# OpenClaw src/plugin-sdk 逐文件全读
    at Gaxios._request (file:///opt/homebrew/Cellar/gemini-cli/0.44.1/libexec/lib/node_modules/@google/gemini-cli/bundle/chunk-GPVT36PL.js:20965:66)
  config: {
    method: 'POST',
    params: { alt: 'sse' },
    headers: {
      'Content-Type': 'application/json',
      'User-Agent': 'GeminiCLI-tui/0.44.1/gemini-3.1-pro-preview (darwin; arm64; terminal) google-api-nodejs-client/9.15.1',
    },
    responseType: 'stream',
    signal: AbortSignal { aborted: false },
    retry: false,
    paramsSerializer: [Function: paramsSerializer],
    validateStatus: [Function: validateStatus],
      _maxListeners: undefined,
      options: [Object],
      requests: [Object: null prototype] {},
      freeSockets: [Object: null prototype] {},
      maxFreeSockets: 256,
      scheduling: 'lifo',
      maxTotalSockets: Infinity,
      totalSocketCount: 1,
      agentKeepAliveTimeoutBuffer: 1000,
      proxyHeaders: {},
      connectOpts: [Object],
    },
  },
  response: undefined,
      at ClientRequest.<anonymous> (file:///opt/homebrew/Cellar/gemini-cli/0.44.1/libexec/lib/node_modules/@google/gemini-cli/bundle/chunk-GPVT36PL.js:19887:18)
    type: 'system',
  },
}
我已完成对 `src/plugin-sdk/` 目录下核心逻辑文件的深度扫描。以下是逐文件的职责、机制分析及 Noe 优化建议。

### 一、 核心运行时与插件入口

#### 1. `core.ts`
*   **职责**：OpenClaw SDK 的核心枢纽，负责聚合类型定义、导出适配器构建器、管理会话路由和频道插件定义。
*   **机制**：
    *   **会话路由构建**：`buildThreadAwareOutboundSessionRoute` (**Line 384**) 负责根据 `threadId` 和 `precedence` 策略恢复或创建会话上下文。
    *   **频道插件 DSL**：`defineChannelPluginEntry` (**Line 509**) 为频道插件提供统一的注册接口，支持多种发现模式。
    *   **组合式插件构建**：`createChatChannelPlugin` (**Line 715**) 允许通过组合安全、配对和出站适配器来快速构建功能完备的插件。
*   **Noe 优化点**：
    *   **权限链路分析**：Noe 可以分析插件定义的 `security` 策略是否覆盖了必要的账号作用域，防止越权。
    *   **会话粘性调试**：辅助验证 `threadId` 恢复逻辑在跨平台场景下的正确性。

#### 2. `plugin-entry.ts`
*   **职责**：非频道类插件（如 Provider, Tool）的标准化入口契约。
*   **机制**：
    *   **延迟加载 Schema**：使用 `createCachedLazyValueGetter` (**Line 223**) 延迟加载配置 Schema，优化大型插件集的发现速度。
    *   **插件定义 DSL**：`definePluginEntry` (**Line 207**) 规范了插件的 Manifest 结构。
*   **Noe 优化点**：
    *   **Schema 自动纠错**：根据插件注册的工具逻辑，辅助纠正 `configSchema` 中的类型定义错误。

#### 3. `agent-harness-runtime.ts`
*   **职责**：为代理测试框架（Agent Harness）提供轻量级运行时，处理工具执行反馈和结果分类。
*   **机制**：
    *   **结果自动分类**：`classifyAgentHarnessTerminalOutcome` (**Line 408**) 将运行结果分类为 `planning-only` 或 `empty`，直接驱动模型 Fallback 逻辑。
    *   **工具进度脱敏**：`formatToolProgressOutput` (**Line 378**) 自动过滤工具输出中的敏感信息。
*   **Noe 优化点**：
    *   **模型 Fallback 模拟**：Noe 可以模拟不同的运行结果，验证 Fallback 策略在多模型环境下的稳健性。

#### 4. `agent-harness-task-runtime.ts`
*   **职责**：管理代理任务的持久化与跨会话通知，确保子代理任务的逻辑隔离。
*   **机制**：
    *   **作用域任务控制**：`createAgentHarnessTaskRuntime` (**Line 95**) 限制插件只能操作所属会话内的任务记录。
    *   **任务完成通报**：`deliverAgentHarnessTaskCompletion` (**Line 144**) 自动构建反馈 Prompt，引导主会话处理任务结果。
*   **Noe 优化点**：
    *   **任务树可视化**：Noe 可以追踪 `childSessionId` 链路，帮助开发者可视化复杂的子代理协作任务树。

---

### 二、 Provider 与模型交互

#### 5. `provider-entry.ts`
*   **职责**：简化单 Provider 插件的注册，涵盖认证向导、模型目录和环境变元。
*   **机制**：
    *   **API Key 自动化**：`createProviderApiKeyAuthMethod` (**Line 207**) 封装了通用的 Key 认证与 Onboarding 向导逻辑。
    *   **统一目录投影**：将不同厂商的模型列表通过 `projectProviderCatalogResultToUnifiedTextRows` (**Line 173**) 转换为统一格式。
*   **Noe 优化点**：
    *   **引导向导生成器**：Noe 可以协助开发者配置 `wizard` 选项，确保新模型上架时的 UI 体验符合 OpenClaw 规范。

#### 6. `provider-stream-shared.ts`
*   **职责**：处理模型厂商的流式协议差异，提供 Thinking 模式补丁和 Payload 预处理。
*   **机制**：
    *   **纯文本工具兼容**：`createPlainTextToolCallCompatWrapper` (**Line 185**) 能够自动将模型在普通文本中回复的工具指令“结构化”。
    *   **Thinking 逻辑兼容**：包含了 Anthropic (**Line 257**) 和 Google (**Line 479**) 思考模式的各种特殊 Payload 补丁。
*   **Noe 优化点**：
    *   **流解析效率审计**：检测正则匹配工具调用时是否存在潜在的性能阻塞风险。

#### 7. `provider-tools.ts`
*   **职责**：跨 Provider 的 JSON Schema 兼容性管理，执行 Schema 规范化与诊断。
*   **机制**：
    *   **Schema 强制转换**：提供了针对 Gemini (**Line 92**)、OpenAI Strict (**Line 123**) 和 DeepSeek (**Line 483**) 的 Schema 重写器。
    *   **不兼容性报告**：`findUnsupportedSchemaKeywords` (**Line 20**) 快速定位无法在特定模型下运行的 Schema 路径。
*   **Noe 优化点**：
    *   **一键跨模型迁移**：当开发者定义的 Tool 无法在特定模型上运行时，Noe 可以利用此文件中的 Normalizer 自动生成修复后的定义。

#### 8. `provider-onboard.ts`
*   **职责**：管理配置合并与 Provider 预设，确保新 Provider 上架不破坏用户现有配置。
*   **机制**：
    *   **配置合并策略**：`applyProviderConfigWithMergedModels` (**Line 156**) 实现了“用户设置优先”的合并逻辑。
    *   **默认模型基准**：强制维护 `OPENCODE_ZEN_DEFAULT_MODEL` (**Line 47**) 作为系统核心。
*   **Noe 优化点**：
    *   **配置冲突仲裁**：在合并多个 Provider 配置发现模型 ID 冲突时，辅助用户进行权重决策。

---

### 三、 Channel 与消息逻辑

#### 9. `channel-ingress.ts`
*   **职责**：消息入站准入控制，处理白名单匹配、命令授权和准入决策。
*   **机制**：
    *   **多阶段决策图**：`decideChannelIngress` (**Line 13**) 通过 Sender、Activation、Command 三阶段决定消息去向。
    *   **准入副作用映射**：`mapChannelIngressDecisionToTurnAdmission` (**Line 183**) 决定是被抛弃、观察还是转发给代理。
*   **Noe 优化点**：
    *   **权限拦截诊断**：Noe 可以解析 `IngressReasonCode`，向开发者清晰解释为什么某条测试消息未被触发。

#### 10. `channel-outbound.ts`
*   **职责**：管理消息出站发送、媒体传输和打字草稿流进度。
*   **机制**：
    *   **持久化发送队列**：封装了 `sendDurableMessageBatch` (**Line 158**)，确保高延迟下的交付质量。
    *   **草稿流合成**：`createFinalizableDraftStreamControls` (**Line 43**) 支持类似“思考动画”的实时状态预览。
*   **Noe 优化点**：
    *   **发送超时预警**：根据不同 Channel 的限流策略，Noe 可以预估大规模消息分块发送的耗时。

#### 11. `channel-route.ts`
*   **职责**：定义跨平台路由键，处理会话绑定与全局去重。
*   **机制**：
    *   **去重键生成**：`channelRouteDedupeKey` (**Line 233**) 生成跨进程唯一的 JSON 序列化标识。
    *   **会话共享判定**：`channelRoutesShareConversation` (**Line 274**) 允许父子线程共享同一个逻辑上下文。
*   **Noe 优化点**：
    *   **路由解析漏洞检测**：检测 `to` 和 `threadId` 的归一化逻辑是否可能导致路由碰撞。

#### 12. `reply-payload.ts`
*   **职责**：回复载荷的规范化，处理媒体顺序发送和长文本自动分块。
*   **机制**：
    *   **思考文本检测**：`isReasoningReplyPayload` (**Line 93**) 自动识别并隔离模型的思考内容。
    *   **回复 Fanout**：`createReplyToFanout` (**Line 333**) 确保多块回复能正确挂载到同一个原始消息下。
*   **Noe 优化点**：
    *   **富文本降级策略**：辅助生成不支持富文本平台的 Link-based 媒体附件降级方案。

---

### 四、 安全、记忆与去重

#### 13. `ssrf-policy.ts`
*   **职责**：网络请求安全策略，防护 SSRF 攻击，管理内网访问权限。
*   **机制**：
    *   **DNS 钉选校验**：`assertHttpUrlTargetsPrivateNetwork` (**Line 183**) 在 DNS 级别强制执行私有 IP 检查。
    *   **配置自动化修复**：提供 `createLegacyPrivateNetworkDoctorContract` (**Line 104**) 用于安全配置迁移。
*   **Noe 优化点**：
    *   **请求安全审计**：Noe 可以扫描插件中的 `fetch` 调用，标记未经过安全 Policy 过滤的可疑外部请求。

#### 14. `allowlist-config-edit.ts`
*   **职责**：辅助构建安全的白名单配置变更操作。
*   **机制**：
    *   **原子化数组更新**：`applyAccountScopedAllowlistConfigEdit` (**Line 189**) 实现配置项的幂等增删，自动维护层级路径。
*   **Noe 优化点**：
    *   **配置修改风险预览**：在用户执行白名单操作前，Noe 可以展示具体受影响的 `config.yaml` 路径及覆盖范围。

#### 15. `security-runtime.ts`
*   **职责**：安全运行时综合入口，提供文件沙箱隔离和敏感数据脱敏。
*   **机制**：
    *   **文件系统根隔离**：`openFileWithinRoot` (**Line 50**) 强制执行沙箱路径限制，拒绝越界链接。
*   **Noe 优化点**：
    *   **敏感信息泄露扫描**：辅助分析日志记录逻辑，提醒开发者使用 `redactSensitiveText`。

#### 16. `memory-core-bundled-runtime.ts`
*   **职责**：内置记忆系统的核心外观，涵盖 Embedding 管理和长期记忆晋升（Dreaming）。
*   **机制**：
    *   **记忆晋升策略**：通过 `PromotionCandidate` (**Line 72**) 的召回率、分数等指标决定短期记忆是否持久化。
    *   **REM 事实落地**：将记忆碎片转化为 `renderedMarkdown` (**Line 50**) 格式的知识事实。
*   **Noe 优化点**：
    *   **Agent 遗忘分析**：Noe 可以基于召回统计建议开发者清理或固化特定的记忆片段。

#### 17. `persistent-dedupe.ts`
*   **职责**：提供带 TTL 的跨进程去重保护，支持 Claim/Commit/Release 锁机制。
*   **机制**：
    *   **Claimable 保护**：`createClaimableDedupe` (**Line 413**) 实现了分布式的“防重发”逻辑，支持正在进行中的异步任务锁定。
*   **Noe 优化点**：
    *   **去重热点分析**：Noe 可以监测哪些操作被频繁去重，辅助排查重复触发的逻辑漏洞。

---

### 已读逻辑文件清单
1.  `src/plugin-sdk/core.ts`
2.  `src/plugin-sdk/plugin-entry.ts`
3.  `src/plugin-sdk/agent-harness-runtime.ts`
4.  `src/plugin-sdk/agent-harness-task-runtime.ts`
5.  `src/plugin-sdk/provider-entry.ts`
6.  `src/plugin-sdk/provider-stream-shared.ts`
7.  `src/plugin-sdk/provider-tools.ts`
8.  `src/plugin-sdk/provider-onboard.ts`
9.  `src/plugin-sdk/channel-ingress.ts`
10. `src/plugin-sdk/channel-outbound.ts`
11. `src/plugin-sdk/channel-route.ts`
12. `src/plugin-sdk/reply-payload.ts`
13. `src/plugin-sdk/ssrf-policy.ts`
14. `src/plugin-sdk/allowlist-config-edit.ts`
15. `src/plugin-sdk/security-runtime.ts`
16. `src/plugin-sdk/memory-core-bundled-runtime.ts`
17. `src/plugin-sdk/persistent-dedupe.ts`
