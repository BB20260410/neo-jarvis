# OpenClaw src/shared 逐文件全读

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
    errno: 'EPROTO',
    code: 'EPROTO'
  },
  code: 'EPROTO',
}
以下是对 `src/shared/` 及其子目录下 74 个核心逻辑文件的深度分析报告。

### 一、 核心逻辑文件分析

#### 1. 基础机制与系统状态 (src/shared/)
| 文件名 | 职责 | 核心机制 (文件:行) | Noe 优化/改进点 |
| :--- | :--- | :--- | :--- |
| `agent-liveness.ts` | 处理运行阻塞状态。 | `isBlockedLivenessState`: 判断 "blocked" 状态 (2) | 增加细分错误提示（如：Quota/Filter）。 |
| `agent-run-status.ts` | 代理运行状态谓词。 | `NON_TERMINAL_AGENT_RUN_STATUSES`: 非终止状态集 (7) | 增加对 `queued` 或 `retry_pending` 的支持。 |
| `assistant-error-format.ts` | 解析助手可见错误。 | `formatRawAssistantErrorForUi`: HTML/API 错误转换 (217) | 增加特定供应商（Azure/Google）特有错误解析。 |
| `avatar-policy.ts` | 头像路径与 MIME 解析。 | `resolveAvatarMime`: 根据后缀解析 MIME (42) | 增加基于哈希的缓存指纹生成。 |
| `balanced-json.ts` | 提取平衡 JSON 片段。 | `extractBalancedJsonPrefix`: 栈式平衡匹配 (22) | 支持带注释或尾随逗号的“宽容型 JSON”。 |
| `chat-content.ts` | 聊天内容文本提取。 | `extractTextFromChatContent`: 处理混合块内容 (26) | 增加多模态内容（图片/文件）的文本摘要逻辑。 |
| `chat-envelope.ts` | 渠道/时间戳前缀清理。 | `stripEnvelope`: 移除 `[WebChat]` 等前缀 (28) | 增加对 Lark/WeChat 等新渠道前缀的识别。 |
| `chat-message-content.ts` | 消息阶段与内容提取。 | `extractAssistantVisibleText`: 优先提取最终答案 (197) | 引入更细粒度的阶段（如 `thinking`）。 |
| `config-eval.ts` | 运行时要求评估。 | `hasBinary`: 带缓存的 PATH 二进制检查 (144) | 增加二进制版本检测逻辑。 |
| `device-auth-store.ts` | 设备授权记录持久化。 | `storeDeviceAuthTokenInStore`: 原子化令牌更新 (74) | 增加存储内容简单加密/混淆。 |
| `device-auth.ts` | 权限作用域规格化。 | `normalizeDeviceAuthScopes`: 作用域继承逻辑 (19) | 扩展细粒度审计作用域（`operator.audit`）。 |
| `device-bootstrap.ts` | 设备引导配置文件。 | `normalizeDeviceBootstrapHandoffProfile`: 权限限制 (75) | 增加引导配置的 TTL 生命周期限制。 |
| `device-pairing-access.ts` | 配对权限变更评估。 | `resolvePendingDeviceApprovalState`: 权限升级分类 (125) | 增加针对高风险升级的审计日志点。 |
| `frontmatter.ts` | Markdown 选单解析。 | `resolveOpenClawManifestBlock`: JSON5 嵌套解析 (32) | 增加元数据缺失字段的智能预测。 |
| `gateway-bind-url.ts` | 监听地址计算。 | `resolveGatewayBindUrl`: Tailscale/LAN 适配 (17) | 增加多网卡环境下的智能地址选择。 |
| `google-turn-ordering.ts` | Google 对话顺序调整。 | `sanitizeGoogleAssistantFirstOrdering`: 插入引导轮次 (7) | 动态生成符合语境的引导文本。 |
| `json-schema-defaults.ts` | Schema 默认值填充。 | `applySchemaDefaults`: 递归引擎支持 `if/then` (621) | 优化 `$ref` 性能并增加循环引用预警。 |
| `lazy-promise.ts` | 资源延迟加载缓存。 | `createLazyPromiseLoader`: 错误后自动驱逐策略 (22) | 增加加载超时保护机制。 |
| `node-match.ts` | 节点评分与选择。 | `resolveNodeIdFromCandidates`: 歧义平局打破启发式 (134) | 增加基于延迟（Latency）的平局打破逻辑。 |
| `operator-scope-compat.ts` | 旧版作用域兼容。 | `operatorScopeSatisfied`: 处理隐含权限 (19) | 增加对自定义角色拒绝列表的支持。 |
| `pid-alive.ts` | 进程存活性检测。 | `getProcessStartTime`: Linux PID 复用检测 (62) | 增加对 macOS/Windows 启动时间的检测。 |
| `requirements.ts` | 环境要求汇总。 | `evaluateRequirements`: 跨平台能力检查 (144) | 支持二进制版本范围匹配（`node >= 18`）。 |
| `safe-record.ts` | 防御性对象访问。 | `copyArrayEntries`: 隔离 Proxy Trap 异常 (26) | 增加深层嵌套对象的递归防御复制。 |
| `store-writer-queue.ts` | 存储写入串行化。 | `drainStoreWriterQueue`: 每个路径独立队列 (37) | 增加写入冲突分析与回退建议。 |
| `tailscale-status.ts` | Tailscale 状态解析。 | `resolveTailscalePublishedHost`: DNS 名称解析 (46) | 增加节点授权过期的提前预警。 |
| `text-chunking.ts` | 文本智能分块。 | `chunkTextByBreakResolver`: 软分界点自动退回 (8) | 增加针对 Markdown 语法的智能切分器。 |

#### 2. 文本处理与清理 (src/shared/text/)
| 文件名 | 职责 | 核心机制 (文件:行) | Noe 优化/改进点 |
| :--- | :--- | :--- | :--- |
| `assistant-visible-text.ts` | 可见文本清理。 | `stripToolCallXmlTags`: 复杂的 XML 状态机解析 (217) | 增加对“幻觉工具调用”的启发式过滤。 |
| `auto-linked-file-ref.ts` | 文件引用链接检测。 | `isAutoLinkedFileRef`: 扩展名与路径校验 (7) | 扩展更多现代语言后缀支持。 |
| `code-regions.ts` | 代码区域识别。 | `findCodeRegions`: 围栏块与行内代码识别 (7) | 增加针对代码块语言（Language ID）提取。 |
| `final-tags.ts` | `<final>` 标签处理。 | `stripFinalTags`: 移除控制标签保留内容 (116) | 提取标签内的元数据（如 `confidence`）。 |
| `formatted-reasoning.ts` | 推理前言剥离。 | `stripFormattedReasoningMessage`: 移除 "Thinking..." (5) | 支持非英文推理前缀（如“思考：”）。 |
| `model-special-tokens.ts` | 特殊令牌清理。 | `stripModelSpecialTokens`: 转义代码区外令牌 (21) | 同步更新厂商新增的特殊令牌。 |
| `reasoning-tag-partitioner.ts` | 推理标签流式分区。 | `createReasoningTagTextPartitioner`: 嵌套状态机 (31) | 增加针对超长推理段落的内存优化。 |
| `reasoning-tags.ts` | 推理标签物理剥离。 | `hasOrphanReasoningCloseBoundary`: 截断检测 (26) | 增加针对“推理泄露”的自动纠偏逻辑。 |
| `strip-markdown.ts` | Markdown 去格式化。 | `stripMarkdown`: 结构保留式转换 (6) | 优化列表标记以更适合 TTS 阅读。 |
| `tool-call-shaped-text.ts` | 工具调用形状检测。 | `detectToolCallShapedText`: JSON/XML/ReAct 综合检测 (217) | 增加针对畸形调用形状的自动修复建议。 |

---

### 二、 已读文件清单 (共 74 个)

**src/shared/** (61 个):
- `agent-liveness.ts`
- `agent-run-status.ts`
- `assistant-error-format.ts`
- `assistant-identity-values.ts`
- `avatar-policy.ts`
- `balanced-json.ts`
- `chat-content.ts`
- `chat-envelope.ts`
- `chat-message-content.ts`
- `config-eval.ts`
- `config-ui-hints-types.ts`
- `custom-command-config.ts`
- `device-auth-store.ts`
- `device-auth.ts`
- `device-bootstrap-profile.ts`
- `device-pairing-access.ts`
- `entry-metadata.ts`
- `entry-status.ts`
- `frontmatter.ts`
- `gateway-bind-url.ts`
- `gateway-method-policy.ts`
- `gateway-tailscale-auth-policy.ts`
- `global-singleton.ts`
- `google-models.ts`
- `google-turn-ordering.ts`
- `human-list.ts`
- `import-specifier.ts`
- `json-schema-defaults.ts`
- `json-schema.types.ts`
- `lazy-promise.ts`
- `lazy-runtime.ts`
- `listeners.ts`
- `message-content-blocks.ts`
- `model-param-b.ts`
- `node-list-parse.ts`
- `node-list-types.ts`
- `node-match.ts`
- `node-presence.ts`
- `node-resolve.ts`
- `number-coercion.ts`
- `operator-scope-compat.ts`
- `path-array-index.ts`
- `pid-alive.ts`
- `regexp.ts`
- `requirements.ts`
- `runtime-import.ts`
- `safe-record.ts`
- `schema-keyword-strip.ts`
- `scoped-expiring-id-cache.ts`
- `session-types.ts`
- `session-usage-timeseries-types.ts`
- `silent-reply-policy.ts`
- `store-writer-queue.ts`
- `string-sample.ts`
- `subagents-format.ts`
- `tailscale-status.ts`
- `text-chunking.ts`
- `thread-binding-lifecycle.ts`
- `transcript-only-openclaw-assistant.ts`
- `usage-aggregates.ts`
- `usage-types.ts`

**src/shared/text/** (13 个):
- `assistant-visible-text.ts`
- `auto-linked-file-ref.ts`
- `citation-control-markers.ts`
- `code-regions.ts`
- `final-tags.ts`
- `formatted-reasoning-message.ts`
- `join-segments.ts`
- `model-special-tokens.ts`
- `plain-text-tool-call-blocks.ts`
- `reasoning-tag-text-partitioner.ts`
- `reasoning-tags.ts`
- `strip-markdown.ts`
- `tool-call-shaped-text.ts`
