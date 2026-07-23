# OpenClaw extensions/active-memory 全读
Attempt 1 failed: You have exhausted your capacity on this model. Your quota will reset after 0s.. Retrying after 5644ms...
Attempt 1 failed: You have exhausted your capacity on this model. Your quota will reset after 0s.. Retrying after 5660ms...
Attempt 1 failed: You have exhausted your capacity on this model. Your quota will reset after 0s.. Retrying after 5071ms...
Attempt 1 failed: You have exhausted your capacity on this model. Your quota will reset after 0s.. Retrying after 5963ms...
Attempt 2 failed: You have exhausted your capacity on this model. Your quota will reset after 0s.. Retrying after 11482ms...
Attempt 1 failed: You have exhausted your capacity on this model. Your quota will reset after 2s.. Retrying after 5264ms...
分析已完成。以下是对 `extensions/active-memory/` 扩展的职责、机制、核心逻辑及优化点的详细报告。

### 已读文件清单
1.  `extensions/active-memory/openclaw.plugin.json`：插件配置与元数据定义。
2.  `extensions/active-memory/doctor-contract-api.ts`：状态迁移与维护逻辑。
3.  `extensions/active-memory/index.ts`：核心运行时实现（约 3100 行）。

---

### 1. 核心职责
Active Memory 的主要职责是在对话生成的 **Prompt 构建阶段之前**，通过运行一个受限的、阻塞式的**记忆子代理（Sub-agent）**，主动召回并总结与当前对话相关的历史记忆，并将其注入到提示词上下文中。

---

### 2. 实现机制与关键点

#### A. 运行时生命周期钩子
*   **机制**：监听 `before_prompt_build` 钩子。
*   **位置**：`index.ts:2966`
*   **职责**：在正式构建 Prompt 前触发，检查会话是否启用记忆，提取最近轮次，构建查询，执行召回逻辑。

#### B. 熔断器 (Circuit Breaker)
*   **机制**：当针对特定代理/模型的召回连续超时（默认 3 次）时，开启熔断，在冷却期（默认 60s）内跳过召回。
*   **位置**：`index.ts:200` (`isCircuitBreakerOpen`), `index.ts:2627` (执行检查)。
*   **职责**：防止下游模型响应慢导致整个系统卡顿。

#### C. 记忆子代理 (Embedded Sub-agent)
*   **机制**：使用 `runEmbeddedAgent` 在后台启动一个独立的 AI 实例，专门负责执行 `memory_search` 等工具。
*   **位置**：`index.ts:2460` (`runRecallSubagent`)。
*   **职责**：将召回任务与主对话隔离，确保召回逻辑（如工具调用、中间思考）不干扰主 Session。

#### D. 结果缓存
*   **机制**：基于 `Map` 实现的简单 TTL 缓存（默认 15s）。
*   **位置**：`index.ts:192` (`activeRecallCache`), `index.ts:2588` (缓存检查)。
*   **职责**：避免短时间内对相同查询进行重复召回，提升响应速度。

#### E. 状态迁移 (Doctor Contract)
*   **机制**：通过 OpenClaw Doctor 机制将旧版的 `session-toggles.json` 迁移到现代的插件 Keyed Store。
*   **位置**：`doctor-contract-api.ts:80`。

---

### 3. 核心算法与数据结构

#### A. 搜索查询构建 (Search Query Construction)
*   **算法**：`buildSearchQuery`。
*   **位置**：`index.ts:2222`。
*   **细节**：
    *   清洗 XML 块、JSON 围栏、不可信外部内容。
    *   长度限制在 480 字符。
    *   如果当前消息太短（少于 12 字符），会自动回溯上一轮用户消息以补充上下文意图（`index.ts:2236`）。

#### B. 召回提示词模板 (Recall Prompt Templating)
*   **算法**：`buildRecallPrompt`。
*   **位置**：`index.ts:1028`。
*   **细节**：根据配置的 `promptStyle`（如 `balanced`, `precision-heavy` 等）生成不同的系统指令，控制子代理在召回时的“进取度”或“严谨度”。

#### C. 超时与部分回复处理
*   **机制**：`buildTimeoutRecallResult`。
*   **位置**：`index.ts:2692`。
*   **细节**：即使子代理超时，也会尝试从临时会话文件中读取已生成的片段作为“部分召回”结果，最大化利用计算资源。

---

### 4. Noe (AI助手) 的优化与完善建议

基于代码逻辑，Noe 可以从以下几个维度提升记忆能力：

1.  **动态超时策略**：
    *   目前 `timeoutMs` 是静态配置。Noe 可以根据历史对话的密集程度或当前查询的复杂度，动态向 `active-memory` 申请更长或更短的阻塞时间。

2.  **情境感知提示风格 (Contextual Prompt Style)**：
    *   `promptStyle` 目前多为手动配置。Noe 可以分析用户是否在询问“偏好”或“习惯”，从而动态将风格切换为 `preference-only` 或 `recall-heavy`。

3.  **记忆召回反馈循环**：
    *   代码中通过 `isActiveMemoryXmlBlocks` 清洗记忆标记。Noe 可以识别主回复中是否采纳了记忆片段，并生成“记忆有效性”反馈给子代理，用于调整后续的检索权重。

4.  **跨 Session 记忆聚类**：
    *   当前的 `maybeResolveActiveRecall` 是基于单次查询的。Noe 可以利用插件暴露的 `toolsAllow` 扩展，执行更高阶的“多 Session 摘要”召回，而不仅仅是搜索原始片段。

5.  **熔断自愈提醒**：
    *   当 Circuit Breaker 开启时，Noe 可以感知到此状态并在 Debug 信息中提示，甚至主动建议用户检查模型服务的稳定性。

6.  **思考深度 (Thinking Level) 动态调优**：
    *   子代理的 `thinking` 级别可以根据设备性能和当前任务的“纠缠度”动态调整，以平衡总结质量与端到端时延。

### 总结
`active-memory` 是一个设计严密的“阻塞式预加载”系统，它通过熔断、缓存和受限子代理，在不破坏主对话流的前提下，实现了强有力的上下文增强。Noe 可以通过“参数微调”和“反馈注入”显著优化这一过程。
