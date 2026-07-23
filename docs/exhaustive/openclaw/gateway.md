# OpenClaw src/gateway (MiMo补全)

# OpenClaw `src/gateway/` 逐文件分析

## 1. `assistant-identity.ts` — 助手身份解析器

### 职责
合并三个来源（UI配置、agent配置、workspace文件）解析出最终显示用的助手身份（name/avatar/emoji），用于 Control UI 展示。

### 关键机制

| 机制 | 说明 |
|------|------|
| **三层优先级覆盖** | 默认agent: UI > agent > file；非默认agent: agent > file > UI。通过 `isDefaultAgent` 分支控制优先级 |
| **三重校验链** | `coerceIdentityValue` 截断 → `normalizeAvatarValue` 格式校验 → `normalizeEmojiValue` emoji校验 |
| **硬编码常量** | name≤50字符, avatar≤2MB, emoji≤16字符且必须含非ASCII |
| **默认兜底** | `DEFAULT_ASSISTANT_IDENTITY` = `{agentId:"main", name:"Assistant", avatar:"A"}` |

### Noe 可优化的点

**1. 多模型身份融合（consensus机制）**
当前是简单的优先级覆盖——第一个有效值胜出。Noe 的多模型 consensus 可以做得更智能：
- 当 UI/agent/file 三个来源有冲突时，用 consensus 机制投票选最优 name，而不是硬性优先级
- 比如三个来源各自提供 name，可以按"语义相似度聚类"取众数

**2. 自我进化型身份记忆**
- 当前身份解析是无状态的——每次都从头解析。Noe 可以用 **记忆FTS** 记录"用户最终看到的/确认的身份"，下次优先命中
- 加一个 `identity-resolution-history` 焦点栈条目：用户在 UI 上修改过哪次解析结果，作为反馈信号

**3. 缺少国际化和多语言支持**
- `MAX_ASSISTANT_NAME=50` 对中文名太短（50字节 vs 50字符的歧义）
- Noe 应该支持多语言名：`name.zh` / `name.en`，根据用户语言环境选择

**4. avatar 校验不够防御性**
```typescript
// 当前逻辑：非URL、非路径、无空格、≤4字符 → 当作 emoji avatar
if (!/\s/.test(trimmed) && trimmed.length <= 4) {
  return trimmed; // 可能接受 "null"、"undefined" 等字符串
}
```
Noe 应加白名单校验或至少排除明显非意图值。

**5. 四档路由适配**
Noe 的四档路由（本地/边缘/云端/混合）中，identity 解析应在本地档完成——不值得为一个 name 发一次云端请求。当前代码本身是纯内存的，但 `loadAgentIdentity(workspaceDir)` 是文件IO，在边缘档可以缓存。

---

## 2. `agent-list.ts` — Agent列表投影

### 职责
合并配置文件中声明的 agent 和磁盘上已存在的 agent 目录，生成一份轻量级 agent 列表供 UI 展示。

### 关键机制

| 机制 | 说明 |
|------|------|
| **磁盘扫描** | `readdirSync("state/agents/")` 扫描已有 agent 目录 |
| **配置合并** | 配置 `agents.list` + 磁盘目录 → Set 去重 |
| **allowedIds 过滤** | 如果有显式配置的 agents，只展示显式+默认的，过滤掉磁盘上的孤儿 |
| **默认agent置顶** | `sorted.includes(defaultId) ? [defaultId, ...others]` |

### Noe 可优化的点

**1. 性能——同步文件IO**
```typescript
fs.readdirSync(agentsDir, { withFileTypes: true }) // 阻塞主线程
```
这是 Gateway 热路径（UI 请求时调用）。Noe 应改为：
- **本地优先**：内存缓存 + fs.watch 监听变更，只在目录变动时重扫
- 焦点栈记录"最近活跃的 agent"，列表按活跃度排序而非纯字母序

**2. 缺少 agent 元数据丰富化**
当前 `GatewayAgentListRow` 只有 `{id, name?}`。Noe 的 UI 需要更多：
```typescript
type GatewayAgentListRow = {
  id: string;
  name?: string;
  status: 'idle' | 'busy' | 'error';      // 来自 active-sessions-tracker
  lastActiveAt?: number;                     // 来自记忆FTS
  model?: string;                            // 当前使用的模型
  capabilities?: string[];                   // 四档路由需要知道 agent 能力
};
```

**3. `mainKey` 逻辑混乱**
```typescript
if (mainKey && !agentIds.includes(mainKey) && (!allowedIds || allowedIds.has(mainKey))) {
  agentIds = [...agentIds, mainKey];
}
```
这段把 `mainKey`（session概念）混入了 agent 列表。Noe 应该清晰分离 session 和 agent 的概念，避免 mainKey 和 agentId 重名时的歧义。

**4. 没有分页/增量加载**
磁盘上可能有大量 agent 目录（用户自建的、插件创建的）。Noe 应支持分页 + 增量同步。

**5. `listExistingAgentIdsFromDisk` 的 normalizeAgentId 空值未过滤**
```typescript
.map((entry) => normalizeAgentId(entry.name))
.filter(Boolean); // ✓ 有 filter，但 normalizeAgentId 对非法字符返回什么？依赖外部行为
```

---

## 3. `agent-prompt.ts` — Agent Prompt构建器

### 职责
将有序的对话条目（conversation entries）组装成发送给 agent 的 prompt 文本：最后一条 user/tool 消息作为"当前消息"，前面的作为历史上下文。

### 关键机制

| 机制 | 说明 |
|------|------|
| **当前消息定位** | 从后往前找最后一条 `role === "user" \| "tool"` 作为 current |
| **过滤内部错误** | `internalStreamError === true` 且 body 为 fallback 文本的 assistant 消息被丢弃 |
| **safeBody 防御** | 处理 content array `[{type:"text",text:"hello"}]` → 序列化为纯文本 |
| **历史格式化** | `sender: body` 格式 + `buildHistoryContextFromEntries` 拼接 |

### Noe 可优化的点

**1. 最重要的改进：缺少 token 预算管理**
当前直接拼接所有历史消息，没有截断。当对话很长时，prompt 会超出模型上下文窗口。
```typescript
// Noe 应加入:
const tokenBudget = modelContextWindow - reservedForResponse - systemPromptTokens;
const trimmedHistory = fitHistoryToBudget(historyEntries, tokenBudget, {
  strategy: 'recent-priority',  // 四档路由：本地小模型用更激进的截断
  preserveToolChains: true,      // 保持 tool call 链完整性
});
```

**2. focus stack 驱动的历史选择**
Noe 的焦点栈可以决定"哪些历史消息最相关"，而不仅是时间序最近的：
- 用户当前在讨论"数据库迁移"→ 焦点栈标记相关历史 → prompt 优先包含相关历史
- 这比简单的时间窗口截断质量高很多

**3. 多模型 consensus 适配**
当 Noe 同时向多个模型发请求时，prompt 应该有变体：
- 本地小模型：精简版 prompt（只含最近 N 轮 + 关键摘要）
- 云端大模型：完整版 prompt（全量历史 + 细粒度上下文）
- 当前 `buildAgentMessageFromConversationEntries` 是单输出，应支持输出 prompt 变体

**4. `safeBody` 处理不完整**
```typescript
function safeBody(body: unknown): string {
  return typeof body === "string" ? body : (extractTextFromChatContent(body) ?? "");
}
```
- 没有处理嵌套的 multimodal content（图片、文件引用）
- 对于 Noe 的多模态支持，应保留结构化 content 而非强转纯文本

**5. 缺少结构化 prompt 模板**
当前是简单的 `sender: body` 字符串拼接。Noe 应该用结构化消息格式（OpenAI/Anthropic 格式），让下游 adapter 决定如何序列化。

---

## 4. `active-sessions-shutdown-tracker.ts` — 会话关闭追踪器

### 职责
在 Gateway 关闭/重启时，追踪哪些会话处于"已开始未结束"状态，确保能触发 `session_end` 钩子，避免幽灵会话。

### 关键机制

| 机制 | 说明 |
|------|------|
| **模块级 Map** | `trackedSessions = Map<sessionId, entry>` |
| **note/forget 对称** | `session_start` 时 note，`session_end` 时 forget |
| **shutdown drain** | `listActiveSessionsForShutdown()` 返回快照副本，允许并发迭代/删除 |
| **防 double-fire** | 正常生命周期已经 forget 的 session 不会出现在 drain 列表中 |

### Noe 可优化的点

**1. 最大风险：模块级可变全局状态**
```typescript
const trackedSessions = new Map<string, ActiveSessionForShutdown>();
```
这是进程级单例。在测试、多 gateway 实例、或 Noe 的四档路由中不同档并发运行时会互相污染。
- **Noe 应改为**：注入式 tracker，通过 DI 容器管理生命周期
- 或至少用 `WeakRef` / scope 隔离不同 gateway 实例的 tracker

**2. 没有持久化**
进程 crash（非 graceful shutdown）时，`trackedSessions` 丢失 → 幽灵会话仍然产生。
```typescript
// Noe 的本地优先策略应改为:
// note 时写 WAL (write-ahead log)
// shutdown drain 后清理 WAL
// 启动时恢复 WAL 中未完成的 sessions
```

**3. 没有超时/死锁检测**
如果一个 session 被 note 后永远没有 forget（bug 导致的泄漏），它会永远留在 Map 中。
```typescript
// Noe 应加 TTL:
export function noteActiveSessionForShutdown(entry: ActiveSessionForShutdown): void {
  trackedSessions.set(entry.sessionId, {
    ...entry,
    _notedAt: Date.now(),
  });
}

// 定期清理超时 session（比如 > 1 小时）
export function gcExpiredTrackedSessions(maxAgeMs: number): void { ... }
```

**4. 缺少指标/可观测性**
Noe 的治理层需要知道：当前有多少活跃 session？哪些 agent 的 session 最多？shutdown drain 耗时多少？
```typescript
export function getSessionTrackerStats(): {
  activeCount: number;
  byAgent: Record<string, number>;
  oldestSessionAge: number;
} { ... }
```

---

## 5. `agent-command.test-helpers.ts` — 测试辅助

### 职责
为异步 Gateway 测试提供工具：等待 mock 的 `agentCommand` 被调用、读取最新调用参数。

### 关键机制

| 机制 | 说明 |
|------|------|
| **轮询等待** | 5ms 间隔轮询，最多 2000ms 超时 |
| **runId 匹配** | 按 `runId` 查找特定的 mock 调用 |
| **vitest mock 集成** | 依赖 `vi.mocked()` 和模块级 `agentCommand` mock |

### Noe 可优化的点

**1. 轮询 → 事件驱动**
```typescript
// 当前：每 5ms 轮询 mock.calls（2000ms / 5ms = 400次无效检查）
for (let elapsed = 0; elapsed <= 2_000; elapsed += 5) { ... await sleep(5); }

// Noe 应改为：
// 在 mock 层注入事件发射器，等待特定事件而非轮询
const call = await waitForEvent('agentCommand:called', { runId, timeout: 2000 });
```

**2. 缺少断言信息**
超时时只抛 `expected agentCommand to be called for ${runId}`，没有告诉你实际收到了哪些 runId。
```typescript
throw new Error(
  `expected agentCommand for ${runId}, but received: ${
    agentCommandCalls().map(c => c[0].runId).join(', ')
  }`
);
```

**3. 硬编码超时**
2000ms 对 CI 可能太短（慢机器上 flaky），对本地开发太长。应可配置。

---

## 6. `agent-event-assistant-text.ts` — 流式事件文本提取

### 职责
从 agent stream event 中提取助手可见的文本增量（delta），统一不同 provider 的事件格式。

### 关键机制

| 机制 | 说明 |
|------|------|
| **双格式兼容** | 优先取 `delta`（增量），回退到 `text`（全量），兜底空字符串 |
| **纯类型判断** | `typeof delta === "string" ? delta : ...` |

### Noe 可优化的点

**1. 信息丢失**
直接返回 `delta` 或 `text`，但忽略了事件中的其他关键信息：
```typescript
// 当前：只返回文本
export function resolveAssistantStreamDeltaText(evt: AgentEventPayload): string { ... }

// Noe 应该返回更丰富的结构：
export type StreamDelta = {
  text: string;
  reasoning?: string;      // 思考链文本（Claude/DeepSeek 会提供）
  toolCalls?: ToolCall[];   // 工具调用增量
  metadata?: {
    model: string;          // 多模型 consensus 时需要知道是哪个模型
    latencyMs: number;
    tokenCount?: number;
  };
};
```

**2. 多模型 consensus 场景**
Noe 同时向多个模型发请求时，每个模型的 stream event 会交叉到达。当前函数无来源标识，无法区分是哪个模型的 delta。
```typescript
// 应改为：
export function resolveAssistantStreamDeltaText(
  evt: AgentEventPayload,
  sourceModelId?: string,
): StreamDelta { ... }
```

**3. 安全性**
没有对 `delta`/`text` 做任何 sanitization。如果模型输出包含恶意内容（prompt injection payload），当前直接透传。Noe 的治理层应在此处加过滤。

**4. 这个函数太小了**
6行有效代码，单独一个文件有些过度。可以合并到 `agent-prompt.ts` 或一个统一的 `stream-utils.ts`。

---

## 总结：跨文件的系统性改进

| 维度 | 当前状态 | Noe 改进方向 |
|------|----------|-------------|
| **多模型支持** | 单模型假设贯穿所有文件 | identity/prompt/event 都需要 sourceModel 标识 |
| **状态管理** | 模块级全局 Map（tracker）+ 同步文件IO（agent-list） | DI 注入 + 内存缓存 + WAL 持久化 |
| **记忆系统** | 无 | FTS 索引 agent 活跃度、身份解析历史、prompt 相关性 |
| **焦点栈** | 无 | 驱动历史消息选择、agent 列表排序、身份优先级 |
| **治理** | 无审计/指标 | 每个文件都应暴露 observability hooks |
| **四档路由** | 不涉及 | identity/prompt 在本地档完成；agent-list 需支持远程 agent 发现 |
| **错误处理** | 基础的 fallback | 需要结构化错误 + 重试策略 + 降级路径 |