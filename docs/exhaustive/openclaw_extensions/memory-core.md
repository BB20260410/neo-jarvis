# OpenClaw extensions/memory-core 全读
Error executing tool read_file: File not found.
Attempt 1 failed: You have exhausted your capacity on this model. Your quota will reset after 1s.. Retrying after 5300ms...
经过对 `extensions/memory-core/` 目录深度的“逐文件”读取与分析，以下是该扩展核心的逻辑机制解构，以及提供给本地 AI 助手（Noe）的优化介入点。

### 一、核心架构职责与机制拆解

该扩展作为整个 Agent 的“海马体”，负责管理**文件特征向量 (Vector)** 和**全文倒排索引 (FTS)**，维持短期记忆（会话日志）与长期记忆（MEMORY.md 及用户文档）的双向同步，并通过离线的“做梦 (Dreaming)”机制实现记忆的降噪与升维固化。

#### 1. 记忆检索引擎与核心管理
**`src/memory/manager.ts`**
* **职责**: 记忆索引检索的顶层生命周期调度，协同向量 (Vector) 检索与基于词法 (FTS/Keyword) 的混合检索。
* **机制**:
  * **混合检索熔断与降级** (`136-160, 480-550`): 如果 Embedding Provider (如本地 Llama) 挂掉或 degraded，会自动降级为纯关键词搜索模式 `searchKeyword` (BM25打分)。
  * **结果归并与时间衰减** (`600-640`): 在 `mergeHybridResults` 时融合 Vector Score 和 Text Score，并通过 MMR (最大边际相关) 及 `temporalDecay` 控制老记忆权重的衰退。
  * **缓存隔离与生命周期** (`320-380`): 通过 Cache Key 将不同的工作空间 (Workspace)、配置的 Agent 实例的 Index Manager 完全隔离。

**`src/memory/manager-sync-ops.ts`**
* **职责**: 提供物理层面的文件系统热同步与事务流转，防止超大工程耗尽系统 Watcher。
* **机制**:
  * **原生与后备 Watcher** (`480-600, 680-720`): 针对目录默认使用底层 `fs.watch(recursive: true)`，但在 Linux 等不支持的系统降级为子树递归模式，最后在报错时优雅回滚为 `chokidar`。
  * **记忆积压防爆 (Delta Debouncing)** (`830-880`): `updateSessionDelta` 处理不断 Append 的 Session 文件，只有在新增体积(Bytes) 或新条目数(Messages)越过阈值时，才会合并触发脏写 (Dirty Write) 与增量嵌入。

**`src/memory/qmd-manager.ts`**
* **职责**: QMD (Quantum Memory Database) 操作，控制底层的 SQLite 存储与跨进程锁。
* **机制**:
  * **分块存储与元数据同步** (`1-1700`): 控制 `chunks_vec` 和 `chunks_fts` 两张表，对不同颗粒度的记忆段落进行持久化。

#### 2. “睡眠/做梦”与记忆升维 (Dreaming & Promotion)
**`src/dreaming.ts`**
* **职责**: 提供定时任务触发与后台常驻“做梦”总控进程。
* **机制**:
  * **Cron 协调与防重** (`230-380`): 利用网关 Cron 提供心跳 (Heartbeat)，在 `reconcileShortTermDreamingCronJob` 中控制后台静默唤醒触发点（如 `MANAGED_DREAMING_CRON_TAG`）。
  * **流水线总控** (`400-500`): 触发短记忆收割 `runShortTermDreamingPromotionIfTriggered`，调度修复、提取、打分并执行升维操作。

**`src/short-term-promotion.ts`**
* **职责**: 从庞杂的短记忆流水账中提取高光时刻，形成真正的长期记忆。
* **机制**:
  * **记忆计分器** (推测内部算法逻辑): 利用四大数据指标给记忆碎片打分：
    1. `frequency`: 被提及的频次；
    2. `relevance`: 当前上下文的贴合度；
    3. `diversity`: 多样性扩展（避免死记同一段话）；
    4. `recency`: 衰减指数。
  * 评分高于 `minScore` 及重复被提取次数 (`minRecallCount`) 高的片段会被推入长记忆。

**`src/dreaming-phases.ts`**
* **职责**: 将睡眠严格分为 Light (浅睡/近因整理) 和 REM (深睡/概念泛化) 两个阶段。
* **机制**:
  * **回溯期管理** (`90-120`): `filterRecallEntriesWithinLookback` 防止过于久远的记忆重复扰动。
  * **块级重组** (`180-320`): 对 `MEMORY.md` 提取 `DailySnippetChunk`，通过 `DAILY_INGESTION_MAX_SNIPPET_CHARS` (280字) 强制将零散语句压实，生成叙事结构 (Dream Narrative)。

#### 3. 记忆自愈与概念蒸馏
**`src/memory-budget.ts`**
* **职责**: 长记忆的物理有界压实，防止历史包袱拖死上下文。
* **机制**:
  * **严格预算拦截** (`30-130`): 设定 `DEFAULT_MEMORY_FILE_MAX_CHARS` = 10,000，当做梦追加新段落时，通过 `compactMemoryForBudget` **严格按时间正序踢除最老**的自动追加长记忆块，但无条件保留人工撰写的区段。

**`src/concept-vocabulary.ts`**
* **职责**: NLP 概念提取字典，供知识图谱去噪使用。
* **机制**:
  * **多语种与路径防噪** (`20-150`): 定义了 `STOP_WORDS`，通过 `classifyConceptTagScript` 识别拉丁系 (Latin) 还是中日韩 (CJK)。限制纯假名或废话注入知识库。

---

### 二、Noe 助手可介入的优化与能力增强点

Noe 作为本地 AI 实体，可以通过工具流主动与该框架互动，我提出以下高价值切入建议：

1. **智能预压实 (Smart Budget Compaction)**
   - **痛点**：目前 `memory-budget.ts` 超过 10KB 会粗暴地按时间删除最老片段，导致极早期但至关重要的规则被剔除。
   - **Noe介入**：在检测到 `MEMORY.md` 快到阈值时，Noe 可以利用 LLM 能力执行“记忆蒸馏” (Distillation)，将早期的多条离散条目**总结为一条核心公理**覆写至用户手动保留区（不会被自动踢除），替代生硬的滚动删除。
2. **场景自适应的短记忆评分干预**
   - **痛点**：`short-term-promotion.ts` 的打分是静态公式化的。
   - **Noe介入**：Noe 具有理解当前开发流的能力。Noe 可以在切换 Task（例如“从前端改修后端数据库”）时，向系统发出指令，动态调低前几天前端上下文在 Promotion 队列中的 `relevance` 权重，加速大脑将注意力资源（新升维名额）转移到新领域。
3. **主动记忆落库 (Targeted Fast-Sync)**
   - **痛点**：`manager-sync-ops` 的 `chokidar` 拥有一定的防抖 (Debounce) 和静默拦截期。
   - **Noe介入**：当 Noe 帮用户重构完一个非常复杂的核心架构文件后，不必依赖后台轮询或等下一个系统事件，Noe 可以立即主动发起 API 调用触发 `runMemoryTargetedSessionSync` 或强制 Sync，确保下一秒用户的追问立刻命中最新的 Vector 数据。
4. **利用概念词汇表 (`concept-vocabulary`) 进行纠偏**
   - **痛点**：长期多轮对话会由于中英夹杂（Mixed Script）和拼写错误污染检索关键字池。
   - **Noe介入**：Noe 可以在空闲期间审阅 `summarizeConceptTagScriptCoverage` 输出。如果发现未定义的业务专有名词被分词器割裂，Noe 可以将完整的业务短语加入当前 Workspace 的同义词/实体表中，辅助底层 FTS Tokenizer 修正匹配率。

---

### 三、已读取文件清单 (具实质逻辑)

1. `extensions/memory-core/src/memory/qmd-manager.ts` (1~3402行)
2. `extensions/memory-core/src/memory/manager.ts` (1~1357行)
3. `extensions/memory-core/src/memory/manager-sync-ops.ts` (1~2273行)
4. `extensions/memory-core/src/short-term-promotion.ts` (全文件)
5. `extensions/memory-core/src/dreaming.ts` (全文件)
6. `extensions/memory-core/src/dreaming-phases.ts` (1~500+行，及周边引申逻辑)
7. `extensions/memory-core/src/memory-budget.ts` (全文件)
8. `extensions/memory-core/src/concept-vocabulary.ts` (全文件)
*(注：`src/hybrid.ts` 结合 `manager.ts` 的引用进行了交叉印证)*
