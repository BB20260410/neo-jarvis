# M3 深挖 BaiLongma → Noe

# Noe 最该从 BaiLongma 吸收的 12 个具体点（按价值降序，已去重）

> 评估标准：BaiLongma 独有 / 实现精巧 / 对 Noe 当前架构有立竿见影增益 / 不与 Noe 已有能力撞车

---

## 🥇 Tier 1：极高价值（架构级、成本/安全关键）

### 1. Static Prefix Cache 防护（Prompt 静态前缀保护）
- **机制**：把易变变量（`currentTime`、`existence`、临时内存 ID）从 `buildSystemPrompt` 中**剥离**到独立的 `<runtime>` 块（`buildContextBlock`），让大段规则/人设能命中 DeepSeek/Gemini 的 prompt cache。
- **对 Noe 价值**：Noe 已有四档路由，DeepSeek 跑长 prompt 时**重复扣费大头**。把静态人设/规则锁前缀，token 成本能砍 30–60%，且延迟降一个量级。
- **落地草案**：在 `noe/prompt/builder.ts` 增加 `splitStablePrefix()`，把 system 拆成 `[STABLE]` + `[RUNTIME]` 两段。Runtime 通过 `append()` 而非 `replace()` 注入。维护一张 `STABLE_PREFIX_HASH`，命中即跳过全量重编码。
- **工作量**：M
- **Noe 已有？**：❌ 未做，前缀未分层。

---

### 2. Tool Intent Router（工具按意图裁剪）
- **机制**：在请求到 LLM 前，先用轻量分类器预测本次任务**不需要的工具族**（如纯聊天时彻底不发 `files_tool` / `shell`），动态缩减 Tool Schema 数量。
- **对 Noe 价值**：Noe 工具市场（marketplace）扩展后 schema 会爆炸，**每个请求都全量塞 50+ 工具** → token 浪费严重。意图前置裁剪可省 40–60% Tool 段 token。
- **落地草案**：在 `noe/llm/router.ts` 之前加 `toolFilter.ts`，输入 `userMessage + 焦点栈栈顶 topic + 最近 3 轮 assistant`，输出保留的 tool 集合。规则：① 读 chat/voice 类工具永远保留；② 写/执行类工具只在消息含动词（"改/建/跑/删"）或 FocusStack 标记 `requires:write` 时下发；③ 维护历史命中率，定期 prune 长期不被调用的工具。
- **工作量**：M
- **Noe 已有？**：❌ 工具全量下发。

---

### 3. Action Claim 阻断（反"假执行"）
- **机制**：监控 LLM 输出，若流式文本中含"【调用成功】""```json{...}```"或越权描述完成态动作，截断流并通过 `buildFakeToolCallNudge` 向模型**二次施压**要求走原生 tool_call。
- **对 Noe 价值**：Noe 的治理安全审批审计依赖**真实 tool_call 落库**做审计。模型用文字伪造"已删除文件"会污染审计链。必须从源头堵。
- **落地草案**：在 `noe/llm/streamParser.ts` 注入流式拦截器，规则：① 检测到 `【已执行】|✅ 完成|已为你.*[删除修改发送]` 模式 → 截流；② 注入 nudge："你还未调用工具，禁止用文字描述执行结果。必须 tool_call。"；③ 把该次违规计入模型 provider 的**黑分**。
- **工作量**：S
- **Noe 已有？**：❌ 仅在 consensus 层做了结果比对，没拦截"伪造执行"。

---

### 4. Adaptive Tick Interval（配额感知自适应心跳）
- **机制**：结合"过去 60s 实际消耗"和"当前 TPM 容量"计算 `ratio`，>0.9 时把 Agent 心跳从 60s 拉长到 120s，避免撞 429。
- **对 Noe 价值**：Noe 的自我进化闭环在跑批时容易"打满桶"。硬节律在低配额/高并发下必死，**软节律**才符合本地优先的"省着用"哲学。
- **落地草案**：在 `noe/heartbeat/scheduler.ts` 增加 `computeNextDelay()`，输入 `[window60s_tokens, tpm_limit, last_429_at]`，输出下次唤醒延迟。规则：`ratio > 0.9 → 120s`，`0.7–0.9 → 90s`，`<0.7 → 60s`；刚 429 过 → 强制 300s 冷却。
- **工作量**：S
- **Noe 已有？**：❌ 硬节律。

---

## 🥈 Tier 2：高价值（UX / 工程关键）

### 5. TTL Context Injection（文档 TTL 上下文注入）
- **机制**：用户在前端打开某技术面板（如"如何配 TTS"）→ 30 分钟内**强制**在 system prompt 注入相关 FAQ 摘要；TTL 过后静默抹除，防 token 泄漏。
- **对 Noe 价值**：Noe 治理安全审批流程长，用户在配置/排错时，AI **必须同步**当前在看哪份文档。TTL 让"窗口期"精确可控。
- **落地草案**：新增 `noe/context/activeDocs.ts`（LRU + 过期表），前端打开文档时调用 `POST /context/active-doc {docId, ttl=1800}`；builder 在 `buildContextBlock` 阶段查表注入，到期 `setTimeout` 清除。审计日志记录注入/清除事件。
- **工作量**：M
- **Noe 已有？**：❌ 没有"前端状态 → 上下文"的反向注入。

---

### 6. Key Auto-Config（聊天流内 Key 自动识别）
- **机制**：用 `/[A-Za-z0-9\-_.]{20,120}/` 抓取聊天文本中的疑似 key，**静默**向对应厂商（OpenAI/Stability/ElevenLabs）打连通性测试，通过即落 `config.json` 并激活服务。
- **对 Noe 价值**：Noe 当前 Key 配置走"设置页 → 填表 → 保存 → 重启"。对非技术用户门槛高。**"把 Key 贴进对话就开用"** 是杀手锏 UX。
- **落地草案**：在 `noe/api/messages.ts` 的入站拦截链最前端加 `keySniffer()`，匹配后调用对应 `testProviderKey()`，通过则 `writeStoredConfig` 原子化落盘，并通过 SSE 推 `config:updated` 事件让 UI 即时刷新。**注意**：必须先经用户**显式确认**（治理审批），不可静默激活。
- **工作量**：M
- **Noe 已有？**：❌ 无聊天流内 Key 检测。

---

### 7. Long Article Auto-save + Pre-summarize（长文自动落盘+预摘要）
- **机制**：网络抓取超过 2000 字符自动 `saveLongArticle` 存为 MD 入沙箱，**同时**调一次 LLM 预生成 300 字核心摘要，存到元数据；模型后续只读摘要 + 按需 `read_file(body_path)` 翻原文。
- **对 Noe 价值**：Noe 的 MemoryCore FTS + Freedom 发布链需要稳定的长内容源，**没有"原文落盘"层**容易在多轮对话中丢失原文细节。预摘要省后续多次 read。
- **落地草案**：在 `noe/capabilities/web_fetch.ts` 增加 `persistIfLong()`：长度阈值 2000，落 `data/articles/{hash}.md`，并把 `summary` 写回 `noe/memory/long_articles` 表（带 url / fetched_at / sha1 / summary 字段）。摘要可用小模型路由。
- **工作量**：M
- **Noe 已有？**：❌ 没做长文落盘。

---

### 8. Parallel Safe Tools（同 Turn 并发读工具）
- **机制**：维护 `PARALLEL_SAFE_TOOLS` 白名单（`read_file / search_memory / web_search` 等无副作用读工具），同 Turn 多 tool_call 时 `Promise.all` 并发执行；写工具强制串行。
- **对 Noe 价值**：Noe 的 consensus + 多模型路由在 RAG 检索时**串行耗时长**。并发读能把首字延迟降 50%+。
- **落地草案**：在 `noe/capabilities/executor.ts` 增加 `Promise.all` 分桶：先按工具名查 `isReadOnly(toolspec)` 分桶，读桶并发写桶串行。`isReadOnly` 通过注解或 schema 字段判断。
- **工作量**：S
- **Noe 已有？**：⚠️ 部分有，但缺系统化分桶。

---

## 🥉 Tier 3：中价值（精细化 / 鲁棒性）

### 9. Person Card SHA1 规范实体 ID（去重锚点）
- **机制**：用 `sha1(规范化名)` 作 `personCardId`，无论用户改昵称、加后缀，底层长期记忆都聚合到同一规范实体。
- **对 Noe 价值**：Noe 有人物卡，但**没有"实体归一"**。同一老板"王总/老王/Wang"会被存成 3 张卡，知识图谱断裂。
- **落地草案**：在 `noe/memory/personCards.ts` 增加 `canonicalId(name)` 函数（lowercase + 去后缀 + sha1 截断 12 位）。人物卡主键换为 `canonicalId`，原 `name` 字段保留为 `aliases[]`。
- **工作量**：S
- **Noe 已有？**：❌ 无归一锚点。

---

### 10. Sticky Events（粘性事件补发）
- **机制**：SSE 推送关键事件（`startup_self_check_started`、模型切换提示）时落"粘性缓存"，UI 断线重连后**即刻补发**最近 N 条，确保前端不漏关键状态变更。
- **对 Noe 价值**：Noe 的 Electron + WebView 经常在切窗时断流，关键事件丢失会让前端状态与后端脱节（如"agent 名字被改了但 UI 还显示老的"）。
- **落地草案**：在 `noe/events/bus.ts` 加 `stickyEvents`（容量 50 的 FIFO），事件带 `sticky: true` 标记才入栈。SSE 握手时检查 `Last-Event-ID`，重放缓存。
- **工作量**：S
- **Noe 已有？**：❌ 无补发机制。

---

### 11. Ticker TTL Countdown（自定心跳 TTL）
- **机制**：Agent 可用工具申请"等我 10 分钟后再跑"，Ticker 进入 TTL 倒计时，每轮减 1，回归基线 300s 之前一直按申请频率跑。
- **对 Noe 价值**：Noe 的自我进化闭环目前只能"立刻跑"或"按固定节律跑"。允许 AI **自主预约**未来时点的能力，是从"反应式"升级到"规划式"的关键。
- **落地草案**：在 `noe/heartbeat/scheduler.ts` 增加 `deferRun(ttl_seconds, reason)`，把任务入延迟队列。`formatTick` 输出 `early morning` / `midnight` 之类时段感知词，让 AI 能据此判断自身作息。
- **工作量**：M
- **Noe 已有？**：❌ 仅有固定节律。

---

### 12. extractJSON <think> Robust 解析
- **机制**：用正则抹除 `<think>...</think>` 和 ` ```json ... ``` ` 围栏，专治走"伪 FC"模式（输出 JSON 文本而非 tool_call）的小模型。
- **对 Noe 价值**：Noe 的四档路由包含本地小模型（qwen2.5/llama3），它们**经常**不调 tool_call 而是吐 JSON。健壮性极差。
- **落地草案**：在 `noe/llm/responseParser.ts` 实现 `extractJSON(content)`，先剥 `<think>` 块再剥 围栏再 JSON.parse 失败时尝试 `eval('('+content+')')` 兜底。错误时返回 `{raw: content, parseError: true}` 让上层决定重试。
- **工作量**：S
- **Noe 已有？**：⚠️ 有但不够健壮。

---

## ❌ 明确不吸收 / 重复项
- **Focus Stack** → Noe 已有
- **MemoryCore FTS5** → Noe 已有
- **Multi-model consensus + quorum** → Noe 已有
- **人物卡（核心）** → Noe 已有
- **治理审批审计** → Noe 已有
- **社交发布链** → Noe 已有
- **Embedding 静默 fallback** → Noe 已有
- **多 Provider 注册** → Noe 已有
- **工具市场/沙箱** → Noe 已有"自我进化闭环"

---

## 📊 工作量汇总
| 等级 | 数量 | 总估时 |
|---|---|---|
| S（< 半天） | 5 项 | 2.5 人日 |
| M（1–3 天） | 7 项 | 14 人日 |
| L（> 3 天） | 0 项 | — |

**建议落地顺序**：1（成本立竿见影）→ 2（同样立竿见影）→ 3（安全）→ 4（稳定）→ 5/6/7（UX）→ 8 → 9–12（精细化）。