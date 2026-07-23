# M3 补全分析 openclaw_agents

# OpenClaw 子代理/工具目录代码分析 → Noe 优化点

下面逐文件拆解职责/关键机制/对 Noe 的具体改进建议。Noe 已有四档模型路由、consensus+quorum、self-evolution、Freedom 发布链、MemoryCore、FocusStack、知识图谱、人物卡、治理/审批/审计，所以建议聚焦在「把 OpenClaw 的工程模式映射到 Noe 已有能力上」。

---

## FILE 1: `openclaw/src/agents/acp-spawn.ts` (55 KB)

### 职责
子代理（ACP runtime）生成、绑定、子代理/父代理的流桥接、深度/数量限制、运行超时、上下文继承、目标路由、错误码归一化。是「父 agent 派生子 agent」整条链路的入口。

### 关键机制
- **两类 spawn 模式**：`run`（一次性任务）/ `session`（持续会话）；sandbox 模式 `inherit`/`require`；stream target `parent`。
- **多层参数继承**：`SpawnAcpContext` 把 `agentChannel / agentAccountId / agentTo / agentThreadId / agentGroupId / agentGroupSpace / agentMemberRoleIds / sandboxed / inheritedToolAllowlist / inheritedToolDenylist` 全部传给子代理，保证子代理"无感"继承父代理的发布通道、安全边界、工具白/黑名单。
- **强约束限制**：`DEFAULT_SUBAGENT_MAX_CHILDREN_PER_AGENT`、`DEFAULT_SUBAGENT_MAX_SPAWN_DEPTH`、`ACP_RUNTIME_TIMEOUT_MAX_SECONDS = 24*60*60`（24h 硬上限），并把 `runTimeoutSeconds` 上限钳制到 24h。
- **能力继承 + 拒绝补丁**：`inheritedToolAllowPatch` / `inheritedToolDenyPatch` 专门处理子代理不能继承父代理某些工具的情况（如父代理有 `web_search` 但 ACP 不支持），返回结构化错误 `formatAcpInheritedToolAllowError`。
- **目标策略**：`resolveSubagentTargetPolicy` 决定子代理应投递到哪个 channel/thread/parent。
- **运行注册表**：`countActiveRunsForSession` / `getSubagentRunByChildSessionKey` 在 `subagent-registry` 中跟踪每个 session 的活跃 run（用于限流/取消/审计）。
- **错误码白名单**：`ACP_SPAWN_ERROR_CODES` 标准化所有失败原因，方便上层审批/审计管线用 enum 判断。
- **parent stream relay**：`acp-spawn-parent-stream.ts`（下一个文件）把子代理输出节流回放到父 session 频道。
- **附件 → 网关**：`toGatewayImageAttachments` 统一把视觉附件转成 base64+media_type。
- **会话恢复**：`resumeSessionId` 支持把子代理拉回上一个 session。

### Noe 可优化/改进/完善的点

| # | 痛点 | 具体落地 |
|---|------|---------|
| 1 | Noe 已有 consensus+quorum，但**子任务派发**（如"先检索再投票再发布"）目前是串行的，没有"派一个子 focus 去查 KB，另一个子 focus 去发 Freedom"这种并行 | 引入 `SpawnNoeSubagentParams { task, focusId, consensusGroupId?, modelTier?, sandbox?, publishTo?, inheritedAuditPolicy? }`；`publishTo` 直接对接 Freedom 发布链；`inheritedAuditPolicy` 让子 focus 复用父 focus 的审批级别。 |
| 2 | Noe 自我进化闭环没有"深度限制"和"派发数量限制"，容易**自递归爆栈** | 直接采用 `MAX_SUBAGENT_DEPTH=3` / `MAX_CHILDREN_PER_AGENT=8` 硬限制，并在 self-evolution 的 planner 里加 `if (depth>=MAX) return plan.executeInline()`。 |
| 3 | 工具白/黑名单继承是 governance/审批的核心，但 Noe 当前是**全局统一**的 | 引入"父 focus 的工具集 + 继承标志位"概念：`FocusStack.push({ tools: parent.tools.filter(inheritable), inheritedFrom: parent.id })`；子 focus 死亡时 `mergeAuditToParent`。 |
| 4 | Noe 的视觉/语音输入现在没有"附件网关"层，每个 router 各做一次转换 | 抽 `toGatewayImageAttachments` 到 `noe/core/gateway-attachments.ts`，统一返回 `{type:'image'\|'audio', source:{type:'base64'\|'url', media_type, data}}`，所有 router 共享。 |
| 5 | 没有"运行注册表"，self-evolution 多次跑同一个 plan 时**不知道哪些正在跑** | 抄 `subagent-registry.ts` 的 `Map<sessionKey, Set<runId>>`，给 Noe 加 `evolutionRunRegistry`，支持取消、统计、审计追溯。 |
| 6 | 错误码散落在 throw 里，审计日志只能 grep 字符串 | 抄 `ACP_SPAWN_ERROR_CODES` 在 `noe/errors.ts` 定义 `NoeErrorCode` union，self-evolution 失败时输出 `code + context` 到审计。 |
| 7 | 子代理超时没有绝对硬上限（24h），长期挂起的 evolution step 会**持续消耗**模型配额 | 抄 `runTimeoutSeconds` + 钳制到 24h；进一步给 Noe 加"超时阶梯"：默认 5min、evolution 任务 1h、长期监控 24h。 |
| 8 | `resumeSessionId` 没有 → 用户中断对话后**所有子 focus 状态丢失** | 给 Noe 的每个 focus 加 `resumeToken`，存到 MemoryCore 的 `focus_resume` 表（已有 FTS），下次进同一 focus 自动续接。 |
| 9 | 父→子 stream relay 还没建，consensus 投票时**用户看不到子模型在想什么** | 复用 OpenClaw 的"流回父 channel"思路，把每个共识成员的 stream 节流到 FocusStack 当前层。 |
| 10 | `memberRoleIds` 这种 group 信任等级没用到，Freedom 发布链容易被刷 | 抄 `agentMemberRoleIds` 到 `noe/freedom/publish-policy.ts`，高/中/低信任等级对应不同 quorum 阈值和审批跳过。 |

---

## FILE 2: `openclaw/src/agents/acp-spawn-parent-stream.ts` (24 KB)

### 职责
把子 ACP session 的流式输出（思考、状态、token）节流回放给父 session 的用户频道。

### 关键机制
- **节流参数**：`STREAM_FLUSH_MS=2500`、`NO_OUTPUT_NOTICE_MS=60000`、`NO_OUTPUT_POLL_MS=15000`、`MAX_RELAY_LIFETIME_MS=6h`、`STREAM_BUFFER_MAX_CHARS=4000`、`STREAM_SNIPPET_MAX_CHARS=220`。
- **配置继承+合并**：`mergeStreamingConfig` 深度合并 base/override，支持 `string`/`boolean`/`object` 三种 streaming 配置形态；`mergeStreamingEntry` 再叠上 account 级。
- **频道默认值**：`applyParentPreviewStreamModeDefault` 给 Discord 单独默认 `progress` 模式（其他 channel 用配置）。
- **状态投影过滤**：`shouldRelayAcpStatusProgress` 用 `isAcpTagVisible(projectionSettings, tag)` 决定某个标签（如 `tool_call` / `thinking`）是否展示给用户。
- **心跳唤起**：`requestHeartbeat` + `scopedHeartbeatWakeOptionsForPolicy` 让长时无输出的 relay 不会被会话超时杀掉。
- **流日志落盘**：`resolveAcpStreamLogPathFromSessionFile` 把 stream 写到 `sessionFileDir/$sessionId.stream.log`，便于回放/审计。
- **进度上报**：`recordTaskRunProgressByRunId` 写到 detached task runtime。
- **系统事件**：`enqueueSystemEvent` 把"子代理启动/结束"通知喂给 system event bus。

### Noe 可优化/改进/完善的点

| # | 痛点 | 具体落地 |
|---|------|---------|
| 1 | consensus 投票时**子模型输出是黑箱**，用户只看到最终结果 | 抄"流回父 channel"，但路由到 FocusStack 当前层，标签 `thinking` 默认折叠、`tool_call` 默认可见。给 Noe 加 `STREAM_FLUSH_MS=1500`（OpenClaw 2500ms 偏慢，Noe 视觉模型可能需要更快）。 |
| 2 | self-evolution 后台跑时，**用户感知不到** | 用 `enqueueSystemEvent` 把"step 3/10 完成：KB 检索"等进度推到通知总线，Electron 主进程的 system tray 展示。 |
| 3 | 长时间 relay 没有**硬上限**，Evolution 死循环会把进程拖到 OOM | 抄 `MAX_RELAY_LIFETIME_MS=6h`；再给 Noe 加"软上限"：连续 30min 无有意义输出（按 `progressTag` 计）就自动降级。 |
| 4 | streaming 配置**没有 account/channel 维度** | 抄 `mergeStreamingConfig` 实现 `noe/streaming/config-merge.ts`，支持 ① 全局默认 ② 渠道（Freedom / Discord / Electron tray）覆盖 ③ 用户级覆盖 三层。 |
| 5 | 流没有落盘，**事后审计和回放缺失** | 抄 `resolveAcpStreamLogPathFromSessionFile`，写到 `MemoryCore/sessions/$id/stream.log`，审计事件直接引用路径。 |
| 6 | 没看到"**子代理心跳**"，self-evolution 中途挂掉无法察觉 | 抄 `requestHeartbeat` + `scopedHeartbeatWakeOptionsForPolicy`；Noe 应该让"长时间无输出"也能触发一次"还活着吗"的 ping，挂了立即 fallback。 |
| 7 | `STREAM_BUFFER_MAX_CHARS=4000` + `SNIPPET_MAX_CHARS=220` 是合理上限 | 直接复用为 Noe 的"思考片段"展示长度，避免长 thinking 把 UI 撑爆。 |
| 8 | 配置合并时**对 boolean/string/object 形态不统一**，容易出错 | 抄 `asStreamingConfigRecord` 的统一归一化，Noe 的 model router 配置也踩过这个坑。 |
| 9 | Discord 有 preview stream 默认值 | Noe 也该有"Electron 主窗口默认 / 外部 channel 默认"分流，避免全平台一种体验。 |

---

## FILE 3: `openclaw/src/agents/agent-bundle-lsp-runtime.ts` (16 KB)

### 职责
会话级内嵌 LSP 运行时（让 agent 跑代码编辑/补全/定义跳转/引用/诊断），把 LSP 能力**实例化成 AnyAgentTool** 给 agent 直接调用。

### 关键机制
- **LSP JSON-RPC 帧解析**：`parseLspMessages` 解析 `Content-Length: N\r\n\r\n{json}` 格式，处理半包/粘包。
- **会话对象**：`LspSession { serverName, process, requestId, pendingRequests, buffer, initialized, capabilities, disposed }`，每会话独占 LSP 子进程。
- **能力探测**：`initializeSession` 后 `capabilities` 记录 server 支持的 `hoverProvider/completionProvider/...`，决定要 materialize 哪些工具。
- **请求超时**：`sendRequest` 默认 10s 超时，`unref()` 防止阻塞进程退出。
- **资源回收**：`activeBundleLspSessions: Set<LspSession>` 全局注册表 + `dispose()` 句柄，支持 `killProcessTree` 优雅关闭（先 SIGTERM grace 500ms / 1000ms，再 SIGKILL）。
- **主机环境消毒**：`sanitizeHostExecEnv({ baseEnv, overrides })` — **关键安全点**，防止子进程继承 `LD_PRELOAD` / `PATH` 注入。
- **Windows spawn shim**：`resolveWindowsSpawnProgram` + `materializeWindowsSpawnProgram` 处理 Windows 下需要 `cmd.exe` / `powershell` 包装的情况。
- **stdio MCP 配置复用**：直接复用 `mcp-stdio.ts` 的 `resolveStdioMcpServerLaunchConfig`，**LSP/MCP 走同一条 stdio 子进程通道**。

### Noe 可优化/改进/完善的点

| # | 痛点 | 具体落地 |
|---|------|---------|
| 1 | Noe 自我进化闭环**没有"代码自检"**环节，生成的脚本直接跑 | 直接抄 `BundleLspToolRuntime` 给 Noe 加 `CodeSelfCheckTool`：跑 gopls/pyright/tsserver，对 self-evolution 改的代码做 LSP 诊断再合并。 |
| 2 | 没有任何"**外部子进程消毒**"层，Electron 主进程直接 `child_process.spawn` 风险很大 | 立即抄 `sanitizeHostExecEnv` 抽到 `noe/infra/host-env-security.ts`，**所有** `child_process.spawn` 走它（治理/安全必需）。 |
| 3 | `killProcessTree` 优雅关闭没现成实现 | 抄 `process/kill-tree.ts`（1s grace → SIGKILL），在 Electron 主进程被 quit 时调一次，**清空所有子 LSP/MCP/Evaluation 进程**。 |
| 4 | stdio JSON-RPC 帧解析**手写**很易错 | 抽 `noe/jsonrpc/stdio-frame.ts` 复用，Freedom 的 mcp-bridge、Noe 的 LLM tool bridge 都能用。 |
| 5 | LSP/MCP stdio 共用 channel 思路 | Noe 已有 vision（图片）和 voice（音频）能力，**新增 tool 时**统一走 stdio 子进程（而非 in-process require），隔离性更好。 |
| 6 | `setPluginToolMeta` 注册工具元数据 | Noe 现在工具是写死的，抄过来做 `noe/plugins/tools.ts` 注册表，未来引入第三方 tool 不用改主进程。 |
| 7 | 10s LSP 请求超时是合理默认 | Noe 的 web_search / KB_query 也用 10s 默认 + `unref()`，避免长请求阻塞进程退出。 |
| 8 | `activeBundleLspSessions: Set` 全局注册表 | Noe 加 `noe/infra/active-children.ts`，Electron `app.on('before-quit')` 时统一 dispose。 |

---

## FILE 4: `openclaw/src/agents/agent-auth-credentials.ts` (4 KB)

### 职责
把 AuthProfile 形态（`api_key` / `token` / `oauth` / `secretRef`）统一规整成 agent runtime 用的 `AgentCredential`（只有 `api_key` / `oauth` 两种）。

### 关键机制
- **形态归一**：`token` 类型（如 OpenAI 风格）直接折叠为 `api_key`；`api_key` 直接转发；`oauth` 校验 `access+refresh+expires>0` 三件套。
- **过期检查**：token/oauth 都在转换时检查 `Date.now()>=expires`，过期返回 `null`（**沉默丢弃**，调用方再走 fallback）。
- **Secret ref placeholder**：`AGENT_SECRET_REF_CONFIGURED_MARKER = "openclaw-secret-ref-configured"`，**绝不解析 secret 值** — 安全关键。
- **provider id 归一**：`normalizeProviderId`，去重（`if credentials[provider] continue`），保证一个 provider 一份凭证。
- **凭据相等比较**：`agentCredentialsEqual` 不用 `JSON.stringify`，按字段比，避免误报。

### Noe 可优化/改进/完善的点

| # | 痛点 | 具体落地 |
|---|------|---------|
| 1 | Noe 四档模型路由每档可能有**不同 API key**（OpenAI / Anthropic / 本地 Ollama / 自建 vLLM），但目前是裸 key 散落 | 抄 `AgentCredentialMap` 在 `noe/model/auth.ts` 集中管理，**四档每档一个 entry**，缺哪档 fallback 时 log 出 provider 名而不漏 key。 |
| 2 | 没有 token **过期主动刷新**机制 | 抄 `oauth` 的 `expires` 字段，给 API key 也加 `expires`，过期前 1h 弹通知 / 自动 rotate。 |
| 3 | **Secret ref 不泄值**模式值得抄 | Noe 的"用户隐私数据"（人物卡敏感字段、Freedom 账号 token）也用 `placeholder` 模式：从 env/Keychain 取值前**不**让日志打印原始值。 |
| 4 | 凭据相等比较**别用对象 spread** | Noe 现在比较 model 切换前后凭据用 `===`，对 oauth `access` 已 rotate 情况会误报 "changed"，抄 `agentCredentialsEqual` 改成按字段比。 |
| 5 | `provider id 归一` 防止重复 | Noe 模型路由里 `gpt-4o` / `openai/gpt-4o` / `gpt-4o-2024-08-06` 当三个用会浪费 quota，用 `normalizeProviderId` 收敛。 |
| 6 | `api_key` / `oauth` 双形态 | Noe 的"Freedom 社交链"如果接 OAuth（小红书/B站/微博），直接复用 `AgentOAuthCredential` 形态，自动带 refresh。 |

---

## FILE 5: `openclaw/src/agents/agent-auth-discovery.ts` (3 KB)

### 职责
多源凭证发现：AuthProfile store → env → 插件 synthetic auth 三层回退。

### 关键机制
- **三档读取模式**：`readOnly=true` / `skipExternalAuthProfiles=true` / 默认，三种组合。
- **回退顺序**：`ensureAuthProfileStore`（写）→ `loadAuthProfileStoreForRuntime`（读+plugin）→ `loadAuthProfileStoreForSecretsRuntime`（读+secret）→ `addEnvBackedAgentCredentials`（env 兜底）→ `resolveProviderSyntheticAuthWithPlugin`（plugin 兜底）。
- **不污染**：`syntheticAuth` 只在**前序都没找到**时填入，已存在的不覆盖。
- **externalCli discovery** 可选注入。

### Noe 可优化/改进/完善的点

| # | 痛点 | 具体落地 |
|---|------|---------|
| 1 | Noe 多模型凭证**只读 AuthProfile 一次**，没有 env 兜底 | 抄 `addEnvBackedAgentCredentials` 集成 env，CI / Docker 部署时不用写配置文件。 |
| 2 | 没有 **synthetic auth 插件兜底** | Noe 可以注册"本地 Ollama 缺 key 时自动 `no-key` 透传"等 plugin，零配置起步。 |
| 3 | `readOnly=true` 不弹 keychain 弹窗 | Noe 的"审计模式"打开时强制 `readOnly`，避免审计期间被偷偷改写。 |
| 4 | `skipExternalAuthProfiles` 沙箱化执行 | Noe 的 "Freedom 沙箱发布" 走这条路径，发布用临时 token，**不污染长期 AuthProfile**。 |
| 5 | **回退顺序**是清晰的优先级链 | Noe 抄过来做"模型路由回退链"：primary tier → secondary tier → env → plugin → 失败。 |
| 6 | `syntheticAuthProviderRefs` 可注入 | Noe 可以让用户装一个"自定义模型供应商"npm 包即插即用。 |

---

## FILE 6: `openclaw/src/agents/acp-runtime-overlay.ts` (2 KB)

### 职责
当 session-key 标记为 ACP 时，**覆盖** agent runtime metadata（id + source），并支持自定义 backend id。

### 关键机制
- **`AgentRuntimeMetadata { id, source: "implicit"|"model"|"provider"|"session-key" }`**：source 表达"这个 id 是从哪儿推出来的"。
- **session-key 优先级最高**：即使 model/provider 推出来 id=A，只要 session-key 是 ACP 形态、acpRuntime=true，就强制覆盖为 `id=acpBackend ?? "acpx"`。
- **解循环依赖**：单独 file 定义 `AgentRuntimeMetadata` 类型，`agent-runtime-metadata.ts` re-export，避免 acp → metadata → acp 的循环 import。
- **fallback `"acpx"`**：未配置 backend 时统一打标，便于下游识别。

### Noe 可优化/改进/完善的点

| # | 痛点 | 具体落地 |
|---|------|---------|
| 1 | Noe 路由层**不知道**"当前这个 session 是什么来源"（user/Freedom/scheduler/evolution） | 抄 `AgentRuntimeMetadata`，在 FocusStack 每一帧打 `source: "user"\|"freedom"\|"evolution"\|"consensus"`，governance 策略可基于 source 区分权限。 |
| 2 | session-key 高优先级覆盖 | Noe 的"用户临时把模型降级到本地 Ollama"，session-key 仍要保留为"用户指定"标记，避免下一轮自动升级。 |
| 3 | 自定义 backend id | Noe 可注册"Freedom-发布专用模型"作为独立 id，**不**走通用四档路由。 |
| 4 | 解循环依赖的 file 拆分技巧 | Noe 当前 `model/router.ts` ↔ `model/quorum.ts` 有循环 import 风险，照这个模式拆 `model/runtime-metadata.ts`。 |
| 5 | source 字段便于**审计追溯** | Noe 审计日志加 `metadata.source`，能回答"是谁/什么事件触发了这次 model 调用"。 |

---

## FILE 7: `openclaw/src/agents/agent-auth-discovery-core.ts` (2 KB)

### 职责
env/config 兜底发现凭证，与 `agent-auth-discovery.ts` 解耦。

### 关键机制
- **`addEnvBackedAgentCredentials(credentials, { config, workspaceDir, env })`**：**非破坏**地把 env 找到的 provider 加到现有 map，**不覆盖**已有。
- **三层 lookup map**：`aliasMap`（provider 别名）、`envCandidateMap`（env var 候选）、`authEvidenceMap`（证据，证明该 provider 真的在 env 里）。
- **`listProviderEnvAuthLookupKeys`** 列出所有可能拿到 env key 的 provider。
- **workspace 维度**：env 可结合 `workspaceDir` 读 `.env.local`。

### Noe 可优化/改进/完善的点

| # | 痛点 | 具体落地 |
|---|------|---------|
| 1 | **非破坏追加**模式 | Noe 的"模型池"维护（用户手动配置的 + 自动发现的）就缺这个，明确"用户配置优先"，避免被 env 偷换。 |
| 2 | `authEvidenceMap` 区分"我**有理由相信**这个 provider 在 env 里" vs "我只是试一下" | Noe 的 KB 数据源（本地/S3/Notion）发现也用同样思路：避免每次都打 S3 探活。 |
| 3 | `workspaceDir` 读 `.env.local` | Noe 每个 project 可以有自己 `.noe.env`，按项目切模型路由和凭据。 |
| 4 | `aliasMap` 提供商别名 | `openai` / `gpt-*` / `azure-openai` 当一家处理，Noe 路由配置少写一半。 |
| 5 | 与主 discovery 解耦 | Noe 应该把"env 兜底"和"AuthProfile 主路径"分开两 file，单元测试好写。 |

---

## FILE 8: `openclaw/src/agents/accepted-session-spawn.ts` (1.5 KB)

### 职责
从松散 tool payload 中归一化"子 session spawn 被接受"的结果。

### 关键机制
- **松散归一**：`asOptionalRecord` 容忍 `string | object | null | undefined`，避免上游格式变更炸下游。
- **状态字段判定**：`details.status === "accepted"` 才算成功，其他 status 全部 `null`。
- **必须双字段**：`runId + childSessionKey` 都非空才返回 `AcceptedSessionSpawn`，单字段不返回。
- **批量检查**：`hasAcceptedSessionSpawn` 用 `.some()` 配合归一化函数，O(n) 一次扫。

### Noe 可优化/改进/完善的点

| # | 痛点 | 具体落地 |
|---|------|---------|
| 1 | Noe 工具结果**直接 `JSON.parse` 然后访问字段**，缺字段就崩 | 抄 `normalizeAcceptedSessionSpawnResult` 模式：所有 tool 出口过一遍 `asOptionalRecord` + 字段存在性检查 + 状态判定。 |
| 2 | `status === "accepted"` 这种**显式状态字段** | Noe 的"审批结果"tool 也用 `status: "approved"\|"rejected"\|"pending"`，统一语义。 |
| 3 | `runId + childSessionKey` 双键必现 | Noe 的"self-evolution step"完成回调用 `runId + stepId` 双键校验，防止回调错位。 |
| 4 | `hasAcceptedSessionSpawn` 批量 helper | Noe 的 FocusStack 在做"批量派发 focus"时，**是否全部 accepted** 用同样 `.some()` 思路收集。 |
| 5 | 归一化函数集中在 `noe/normalize/` 目录 | 建 `noe/normalize/record-coerce.ts`、`noe/normalize/string-coerce.ts`（OpenClaw 已经是 `@openclaw/normalization-core`），把零散 `if (x && typeof x === 'object')` 收敛。 |

---

## 跨文件总结：Noe 优先落地的 5 件事

1. **建 `noe/subagent/runtime.ts`**（融合文件 1+2）：consensus+quorum 投票时把每个成员的 stream 节流回父 channel；引入 `MAX_DEPTH=3 / MAX_CHILDREN=8`、24h runTimeout 硬上限、错误码 enum。
2. **`sanitizeHostExecEnv` + `killProcessTree` 即刻抽到 `noe/infra/`**（文件 3）：Electron 主进程所有 `child_process.spawn` 必经。
3. **`AgentCredentialMap` + `addEnvBackedAgentCredentials`**（文件 4+5+7）：四档模型路由 + Freedom OAuth + 沙箱发布的统一凭证抽象。
4. **`AgentRuntimeMetadata { id, source }`**（文件 6）渗透到 FocusStack 每一帧：审计 / 治理 / 路由都基于 source 决策。
5. **`noe/normalize/` 工具层**（文件 8）：所有 tool 出口过归一化函数，避免上游 schema 变更炸下游。

每条都对应 Noe 现存能力（consensus、self-evolution、Freedom、MemoryCore、FocusStack、治理审批），落地后能让"本地优先"这条主线更稳、更可审计、更可扩展。