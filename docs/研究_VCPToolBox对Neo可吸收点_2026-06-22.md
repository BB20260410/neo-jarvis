# 研究：VCPToolBox 对 Neo 贾维斯的可吸收点（2026-06-22）

> owner 请求：深入研究 https://github.com/lioensky/VCPToolBox，分析对 Neo 构建有无帮助、可吸收的代码/方向。
> 方法：6 子代理 workflow（w282jsac8，真读 VCP 源码 + grep Neo 源码对比，59 万 token / 103 工具调用）+ 主线亲验关键断言。

## 一句话结论
VCP 对 Neo **有帮助，但是「方向/字段/协议借鉴」而非「代码移植」**——Neo 在记忆引擎、自主生活、上下文工程、容灾备份多数维度**已强于 VCP**；VCP 真正补 Neo 缺口的有限几处，价值集中在 **4 个高优先项**。**许可红线**：VCP 是 CC BY-NC-SA 4.0（非商业 + 署名 + 相同方式共享），**禁止拷贝其源码**进 Neo（会传染 ShareAlike + 锁死非商业），所有吸收一律「按思路独立重写」。

## 主线已核实的关键证据（非子代理转述）
| 断言 | grep 范围 | 结果 |
|---|---|---|
| WS 无心跳/死连接清扫 | `isAlive\|.ping(\|on('pong'\|.terminate()` in server.js+src/server | **0 命中（真缺）** |
| DB 无启动自检/坏库回滚 | `integrity_check\|quick_check\|restoreFromBackup` in src/storage+server.js | **0 命中（真缺）** |
| command 无 example 字段 | `example\|invocationExample` in NoeCommandSurface.js | **0 命中（真缺）** |
| 工具协议（VCP.md 主线亲读）| `<<<[TOOL_REQUEST]>>> tool_name:「始」x「末」` 纯文本标记 + 参数键名模糊容错 | 已核实格式与容错 |

## 可吸收矩阵（按优先级，全部 type=direction 除非标注）

### 🔴 高优先（4 项，建议纳入 P 级队列）
| # | 维度 | 吸收点 | type | Neo 落点 | 许可 |
|---|---|---|---|---|---|
| H1 | 架构容灾 | **WS 心跳保活 + 死连接周期清扫**：setInterval(~30s) 遍历所有 WS 集合，isAlive=false 则 terminate()，否则置 false + ping()；on('pong') 复位。半开连接(Wi-Fi 切/合盖/Electron 休眠)不触发 close，死 socket 永久滞留 + broadcast 持续写死连接 = fd/内存缓慢泄漏 | **code** | `src/server/services/ws-heartbeat.js`(新建 DI) + server.js 注册 | 纯 ws 标准 pattern，无风险 |
| H2 | 架构容灾 | **DB 启动自检 + 坏库自动回滚**：getDb() 跑 `PRAGMA quick_check`，非 ok 则隔离损坏库 + 从 `NoeDbBackup.listBackups()` 最新一份恢复 + broadcast health_warning。Neo 已有最难的在线 WAL 备份，独缺「开机发现坏→自动恢复」闭环。panel.db 是 Neo 全部家当，WAL 半写损坏目前会让 Neo 直接失忆且不自知 | direction | `SqliteStore.getDb` + `NoeDbBackup.restoreLatest()`(新建) | 业界通用，无风险 |
| H3 | 工具协议 | **本地模型纯文本工具调用协议**（function-calling 平行兜底）：定义 `<<<[NOE_TOOL]>>> tool:X args:{...} <<<[END]>>>` 标记，大脑文本回复后正则抠出 → ToolRegistry.invoke/McpAggregator → 结果回注续写。参数键名模糊匹配。治「思考能跑但动手靠 noeDo.js 中文正则硬路由、gemma function-calling 弱、35+ FREEDOM 工具大脑选不了」核心痛点 | direction | `src/voice/NoeTextToolProtocol.js`(新建) 接 SoloChatDispatcher/VoiceSession 回复后处理；flag `NOE_TEXT_TOOL_PROTOCOL` 默认 OFF | 解析器自研 |
| H4 | 模型路由 | **前台聊天接入任务级选模**：前台 1v1 现在只走固定额度链取第一个可用(说「写个脚本」会优先丢给 MiniMax 而非 Codex)；Neo 的 BrainRouter 已有完整意图分档(code→Codex/deep→Claude/mid→MiniMax)但**只服务后台**。把 BrainRouter.route() 当链头、resolveForegroundChatChain 当 fallback 尾 | direction | `SoloChatDispatcher.js` L133-147 + 复用 `BrainRouter` | 复用现成，无风险 |

### 🟡 中优先（择机/前瞻）
| # | 维度 | 吸收点 | Neo 落点 |
|---|---|---|---|
| M1 | 记忆 | **标签共现图 + 二跳扩散激活作为召回第三路**(与 FTS/向量并跑喂 RRF)：对 noe_memory.tags(已是 JSON 数组)建共现加权图，LIF 式 injectedCurrent=energy×coocWeight×DECAY，MAX_HOPS≤2 扩散。补「联想全靠显式 KG 边/向量 cosine、无学习型标签突触」缺口。**必配** 最小采样门(命中标签<阈值该路弃权)+三层退回(L0/L1/L2)保基线不劣化 | `src/memory/NoeTagCooccurrenceGraph.js`(新建+noe_tag_cooc 表) 接 MemoryCore.recallFused；flag 默认 OFF |
| M2 | 工具 | **command 加 example/invocationExample 字段**：现 description+inputSchema 弱模型仍不知怎么组织调用。VCP 每工具一段字面调用范例「教」模型。成本极低，提升 H3 及任何 function-calling 命中率 | NoeCommandSurface/builtinReadonlyTools/FreedomManifest 各加 example + NoeToolRouter 注入 |
| M3 | 工具 | **工具结果统一格式化层**(AI 易读 Markdown 替代 JSON.stringify().slice 截断)，截断可能切坏 JSON 误导大脑 | `src/capabilities/NoeToolResultFormatter.js`(新建) |
| M4 | 上下文 | **EpisodicTimeline 每条加来源注解**(source: voice/solo-chat/proactive/dream + channelRef)：现 record() 无来源维度，语音与文字经历在时间线无法区分「这事在哪说的」。成本极低，补「连续记忆脊椎」 | `EpisodicTimeline.record/narrative` |
| M5 | 自主 | **概率掷骰自主唤醒闸**：cadence 之外叠 Math.random()<probability + 时间窗 + 冷却，让自主一天有非确定性节奏(有时醒来动手、有时路过)。Neo 现 cadence 到点必跑，VCP 三闸是它本维度唯一比 Neo 多的真机制 | `NoeCircadian.shouldRunProbabilisticTick` 纯函数；env 默认 probability=1(零回归) |
| M6 | 自主 | **未来自我留言/定时自触发**：AI 给自己排未来认知任务(「明早检查那 PR 合了没」)，dueAt+action 自任务队列，心跳扫到期注入 selfEvolve/reflect。区别于 commitmentStore(面向提醒 owner)。注：VCP 自己也没真做出(招牌卖点是 README 宣传) | `src/cognition/NoeFutureSelfNote.js`(新建) + 心跳 futureSelfTick kind |
| M7 | 上下文 | **话题折叠 + 按引用自动展开**：离题早期轮次摘要、被后文引用又复原。Neo 的 TrajectoryCompactor 只做时间滑窗压缩、不因引用复原 | `NoeTrajectoryCompactor` 增话题相关性档 |
| M8 | 模型 | **embedding 余弦兜底 BrainRouter 正则**：正则优先 + 语义兜底(非替换)，正则漏判同义/换说法时用 description 向量 cosine | `BrainRouter` DEFAULT_SIGNAL_PROBES 加 semanticProbe |
| M9 | 记忆 | **KG.oneHop 接进召回融合**：KG 已建好(实体/关系/bitemporal)却没进 MemoryCore/NoeMemoryRetriever 召回路径——「机制存在≠活着」典型。注：需先确认 KG 数据密度(目前只 has_type 真有写入) | `NoeMemoryRetriever.retrieve` 增 KG 邻居一路；先生产副本 dry-run 验真效果 |

### 🟢 低优先 / 长期方向
- 长任务异步回调(taskId→后台跑完推回大脑续写；Neo 已有 ws+事件总线，用进程内事件而非 VCP 的对外 HTTP 回调，别开攻击面)
- 静态环境占位符注册表(`{{占位符}}`+cron 刷新；Neo ContextEngine 已做类似)
- 工具描述折叠(工具数大时按相关性筛 top-k 注入；Neo 现工具数小痛感弱)
- 元思考库(可复用推理路径/思维结构单独存；收益存疑)
- 日记当反思种子(Neo 已有 ThoughtSublimation/MemoryEcho 重叠度高)
- 残差/Gram-Schmidt 召回去同质化(Neo top-K 偏小痛感弱)
- 冷热知识双通道(Neo scope+双相衰减 tier 已覆盖)
- 未来 WS-RPC 超时保护 promise(Neo 现 WS 全单向 push，无跨进程 RPC 场景；**且红线：超时只可用于 WS 控制 RPC，绝不套模型调用链**)

## 明确不吸收（过度工程 / 名实不符 / 证据不足）
1. **分布式/星型 hub/跨服务器文件访问**(VCPDistributedServer/register_tools)——Neo 是单机 127.0.0.1 个人 OS，引入多节点 = 凭空背认证/网络分区/一致性容灾债，违背「本地私有」定位。
2. **Rust rust-vexus-lite O(1) 查表**——Neo 是 better-sqlite3 单机、记忆规模远未到十万级标签瓶颈；且该句仅 README 口号无源码佐证。
3. **WorkerPool/worker_threads 池**——Neo 重活走子代理/外部模型进程，无 in-process CPU 密集需求；且 VCP 实现自身有坑(死 worker 不重启、崩溃 promise 不 reject)。
4. **ModelRedirect 公开名↔内部名映射 + 协议桥接**——VCP 要这层因它是「夹在第三方前端与 LLM API 间的中间件」需对外伪装；Neo 自有前端 + adapter 层已各自封装协议差异，再加是过度工程。
5. **浪潮算法高级变体**(虫洞/朗飞结/SVD per-tag/残差金字塔)——理论漂亮但调参面大、易引入召回不稳定，与「基线只许涨」冲突，只取最稳的共现扩散+采样门+三层退回。

## 证据边界（诚实声明，子代理 + 主线核实）
- VCP 记忆引擎真实算法**仅来自** `TagMemo_Wave_Algorithm_Deep_Dive.md`——`TagMemoEngine.js` raw 返回 **404 未抓到**；「冷热双通道/L1-L4/Rust O(1)/数据库自修复/原子级差分同步」均**仅 README 口号级、无源码佐证**。
- 工具协议：`Plugin.js` 抓到(pluginType/manifest 字段)，但 `toolCallParser` 解析正则**未抓到**，标记语法来自官方文档——Neo 落地需自研解析器，不假设与 VCP 一致。
- 自主生活：实抓发现**宣传与实现有落差**——README 招牌「留信给未来自己/心流挂起/元思考系统」未在源码找到对应模块；`EPAModule.js` 经核实是嵌入投影分析的**纯向量数学**(K-Means+PCA+SVD)，与自主性无关。
- 容灾：`WebSocketServer.js`/`WorkerPool.js` 抓到，但「数据库自修复/原子级差分同步」仅 README 文字。

## 主线落地决策
- **立即做（本会话，四闸门交付，作为 P 级健壮性补强）**：H1（WS 心跳，纯标准 pattern 无许可风险 + 主线核实真缺 + 非分量动作）→ H2（DB 自检回滚，复用现成 listBackups，改状态 flag 默认 OFF）。两项与自改禁区无关、可独立 commit、风险最低，最适合无监督自主完成。
- **纳入 P 级队列待排**：H3（文本工具协议）、H4（前台语义选模）、M2（example 字段，成本极低可随 H3 做）、M4（来源注解，成本极低）。
- **ROADMAP 主线 P1.4（认知链路 E2E）**：仍 pending，认知链路首验可能需 owner 在场看效果，与 VCP 容灾项并行不冲突。

## 来源
workflow w282jsac8 完整结果：`/private/tmp/.../tasks/w282jsac8.output`；VCP 仓库 github.com/lioensky/VCPToolBox（CC BY-NC-SA 4.0）。
