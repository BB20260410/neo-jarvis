// @ts-check
// Deterministic autonomous-learning topic catalog for NoeGoalSystem.

export const NOE_LEARNING_TOPICS = Object.freeze([
  {
    title: '让 Noe 主动上网学习并把结论转成目标',
    query: 'autonomous agent self directed web research memory goal execution checkpoint examples',
    url: 'https://github.com/topics/ai-agent',
    localPattern: 'NOE_AUTONOMOUS_LEARNING|runResearch|DeepResearcher|NoeGoalSystem|goal_step|research_done|NoeWorkspace',
    localPaths: ['server.js', 'src/cognition', 'src/research', 'src/server/routes', 'docs'],
  },
  {
    title: '让 Noe 自己操控电脑但保留证据和恢复能力',
    query: 'computer use agent browser action evidence recovery Playwright UI-TARS OpenHands',
    url: 'https://github.com/topics/computer-use',
    localPattern: 'VisualActionPlanner|ActPipeline|shell.exec|browser\\.(open|observe|click|type)|playwright|noe.freedom.browser|Activity',
    localPaths: ['src/vision', 'src/loop', 'src/runtime', 'public', 'tests/unit'],
  },
  {
    title: '让 Noe 的记忆会冲突处理和长期自我修正',
    query: 'agent memory conflict temporal knowledge graph Letta Mem0 Graphiti Zep sleep time compute',
    url: 'https://github.com/topics/agent-memory',
    localPattern: 'NoeMemoryConflictPolicy|FactExtractor|NoeKnowledgeGraph|NoeNightlyReflection|ExpectationLedger|Brier',
    localPaths: ['src/memory', 'src/cognition', 'docs', 'tests/unit'],
  },
  {
    title: '让 Noe 的行动链可 checkpoint、resume、失败后恢复',
    query: 'LangGraph durable execution checkpoint resume human in the loop agents Dapr workflow',
    url: 'https://github.com/topics/langgraph',
    localPattern: 'checkpoint|awaiting_approval|recovered|blocked|recordStepResult|act_started|act_done|NoeHeartbeat',
    localPaths: ['src/cognition', 'src/loop', 'src/runtime', 'docs', 'tests/unit'],
  },
  {
    title: '让 Noe 的主观思考更接地，避免 echo trap',
    query: 'LLM agent echo trap grounded inner monologue semantic diversity reflection salience generative agents',
    url: 'https://github.com/topics/llm-agent',
    localPattern: 'NoeMindVitals|grounded|Echo Trap|InnerMonologue|NoeMemoryEcho|fresh_insight|salience',
    localPaths: ['src/cognition', 'src/loop', 'src/memory', 'docs'],
  },
  {
    title: '让 Noe 主动做 capability_discovery，发现并接入新的工具能力',
    query: 'capability discovery AI agent tool registry MCP plugin marketplace self improving agents',
    url: 'https://github.com/topics/mcp-server',
    localPattern: 'capability_discovery|SkillStore|ToolMarketplace|ActionCatalog|NoeToolRouter|MCP|mcp|plugin|adapter|tool manifest|NoeFreedomAdapters',
    localPaths: ['src/skills', 'src/runtime', 'src/mcp', 'src/server/routes', 'scripts', 'docs', 'tests/unit'],
  },
]);

// 具体学习概念池：每个种子主题下的真实明星项目。让自主学习从「反复刷 6 个 github/topics 总览页」
//   升级为「学具体项目是怎么做的」——直接治 owner 2026-06-18 实证的「一直搜那几个网页」。
//   url 用 github 仓库搜索（一定有效、列出该概念的真实项目）；getNextTopic 的饱和冷却会在这些里轮转，
//   学过的进 cooldown、优先没碰过的。这是接通 NoeTopicCurator dynamicConcepts 管道的初始真实供给；
//   真正的「从浏览页面动态发现新项目」是下一步深化（库里现存 0 个抓到的链接，见交接 P6 最后一公里）。
export const NOE_LEARNING_CONCEPTS = Object.freeze([
  // ① 自主 agent 上网学习与任务分解
  { title: 'AutoGPT：自主任务分解与目标驱动循环怎么实现', query: 'AutoGPT autonomous task decomposition goal-driven loop', url: 'https://github.com/search?q=AutoGPT+autonomous+agent&type=repositories' },
  { title: 'LangGraph：有状态、可循环的 agent 编排图', query: 'LangGraph stateful cyclic agent orchestration graph', url: 'https://github.com/search?q=LangGraph+agent&type=repositories' },
  { title: 'CrewAI：多角色 agent 协作分工', query: 'CrewAI role-based multi-agent collaboration', url: 'https://github.com/search?q=CrewAI+multi+agent&type=repositories' },
  { title: 'AutoGen：多 agent 对话式协作框架', query: 'Microsoft AutoGen multi-agent conversation framework', url: 'https://github.com/search?q=AutoGen+agent&type=repositories' },
  // ② 操控电脑/浏览器且保留证据
  { title: 'OpenHands：自主软件开发 agent 怎么操控环境', query: 'OpenHands autonomous software development agent', url: 'https://github.com/search?q=OpenHands+agent&type=repositories' },
  { title: 'UI-TARS：端到端视觉 GUI 操控模型', query: 'UI-TARS end-to-end visual GUI grounding agent', url: 'https://github.com/search?q=UI-TARS&type=repositories' },
  { title: 'browser-use：让 LLM 自主操控浏览器', query: 'browser-use LLM browser automation agent', url: 'https://github.com/search?q=browser-use&type=repositories' },
  { title: 'Anthropic Computer Use：截图→坐标点击范式', query: 'Anthropic computer use screenshot coordinate action', url: 'https://github.com/search?q=computer+use+agent&type=repositories' },
  // ③ agent 记忆冲突与自我修正
  { title: 'Letta（MemGPT）：长期记忆与自我编辑怎么做', query: 'Letta MemGPT long-term self-editing memory agent', url: 'https://github.com/search?q=Letta+MemGPT&type=repositories' },
  { title: 'Mem0：通用 agent 记忆层架构', query: 'Mem0 universal agent memory layer', url: 'https://github.com/search?q=Mem0+memory&type=repositories' },
  { title: 'Zep/Graphiti：时序知识图谱记忆', query: 'Zep Graphiti temporal knowledge graph agent memory', url: 'https://github.com/search?q=Graphiti+temporal+knowledge+graph&type=repositories' },
  { title: 'Cognee：把对话沉淀成可查询记忆图', query: 'Cognee memory graph for AI agents', url: 'https://github.com/search?q=Cognee+memory&type=repositories' },
  // ④ 行动链 checkpoint/resume/失败恢复
  { title: 'LangGraph durable execution：中断后续跑', query: 'LangGraph durable execution checkpoint resume', url: 'https://github.com/search?q=LangGraph+durable+execution&type=repositories' },
  { title: 'Temporal：持久工作流怎么保证不丢状态', query: 'Temporal durable workflow execution fault tolerant', url: 'https://github.com/search?q=Temporal+workflow+durable&type=repositories' },
  { title: 'Dapr Agents：可靠的分布式 agent 运行时', query: 'Dapr Agents reliable distributed agent runtime', url: 'https://github.com/search?q=Dapr+Agents&type=repositories' },
  { title: 'Inngest：持久 step 函数与重试', query: 'Inngest durable step functions retry workflow', url: 'https://github.com/search?q=Inngest+durable+workflow&type=repositories' },
  // ⑤ 主观思考接地、避免 echo trap
  { title: 'Reflexion：用语言强化做自我反思', query: 'Reflexion language agents verbal reinforcement self-reflection', url: 'https://github.com/search?q=Reflexion+agent+self+reflection&type=repositories' },
  { title: 'Generative Agents：斯坦福小镇的记忆-反思-计划', query: 'Generative Agents Stanford memory reflection planning', url: 'https://github.com/search?q=generative+agents+simulation&type=repositories' },
  { title: 'Tree of Thoughts：多路径推理避免单链塌缩', query: 'Tree of Thoughts deliberate reasoning search', url: 'https://github.com/search?q=Tree+of+Thoughts&type=repositories' },
  { title: 'DSPy：声明式自优化 prompt 与推理', query: 'DSPy declarative self-improving language model programs', url: 'https://github.com/search?q=DSPy&type=repositories' },
  // ⑥ capability discovery 接入新工具
  { title: 'Model Context Protocol：官方 server 怎么暴露能力', query: 'Model Context Protocol MCP servers tool exposure', url: 'https://github.com/search?q=model+context+protocol+server&type=repositories' },
  { title: 'Composio：给 agent 接 100+ 工具', query: 'Composio agent tool integration platform', url: 'https://github.com/search?q=Composio+tools+agent&type=repositories' },
  { title: 'FastMCP：快速搭一个 MCP server', query: 'FastMCP build MCP server python', url: 'https://github.com/search?q=FastMCP&type=repositories' },
  { title: 'Awesome MCP Servers：MCP 生态全景', query: 'awesome MCP servers ecosystem catalog', url: 'https://github.com/search?q=awesome+mcp+servers&type=repositories' },
  // ③B（2026-06-23）扩池：每类再加 4 个真实明星项目，把主题多样性从 24→48，治"一直重复那几个"。
  // ① 自主 agent
  { title: 'MetaGPT：多 agent 软件公司协作', query: 'MetaGPT multi-agent software company collaboration', url: 'https://github.com/search?q=MetaGPT&type=repositories' },
  { title: 'BabyAGI：最小自主任务循环', query: 'BabyAGI autonomous task loop minimal', url: 'https://github.com/search?q=BabyAGI&type=repositories' },
  { title: 'SuperAGI：生产级自主 agent 框架', query: 'SuperAGI autonomous agent framework production', url: 'https://github.com/search?q=SuperAGI&type=repositories' },
  { title: 'gpt-engineer：从需求自主生成整个代码库', query: 'gpt-engineer autonomous codebase generation', url: 'https://github.com/search?q=gpt-engineer&type=repositories' },
  // ② 操控电脑/浏览器
  { title: 'Skyvern：用 LLM+视觉自动化浏览器工作流', query: 'Skyvern LLM vision browser workflow automation', url: 'https://github.com/search?q=Skyvern&type=repositories' },
  { title: 'WebVoyager：端到端视觉 web agent', query: 'WebVoyager end-to-end vision web agent', url: 'https://github.com/search?q=WebVoyager&type=repositories' },
  { title: 'self-operating-computer：多模态自主操控电脑', query: 'self-operating-computer multimodal autonomous', url: 'https://github.com/search?q=self-operating-computer&type=repositories' },
  { title: 'Agent-E：分层浏览器自动化 agent', query: 'Agent-E hierarchical browser automation', url: 'https://github.com/search?q=Agent-E+browser&type=repositories' },
  // ③ 记忆
  { title: 'A-MEM：agentic 记忆系统', query: 'A-MEM agentic memory system for LLM agents', url: 'https://github.com/search?q=A-MEM+agentic+memory&type=repositories' },
  { title: 'LangMem：LangChain 长期记忆管理', query: 'LangMem long-term memory management agents', url: 'https://github.com/search?q=LangMem&type=repositories' },
  { title: 'memary：自主 agent 的人类式长期记忆', query: 'memary human-like long-term memory autonomous agents', url: 'https://github.com/search?q=memary+memory&type=repositories' },
  { title: 'EmbedChain：把数据沉淀成可查询记忆', query: 'embedchain RAG memory data ingestion', url: 'https://github.com/search?q=embedchain&type=repositories' },
  // ④ 行动链 durable/恢复
  { title: 'Restate：durable 执行与状态恢复', query: 'Restate durable execution state recovery', url: 'https://github.com/search?q=Restate+durable+execution&type=repositories' },
  { title: 'Hatchet：分布式任务队列与重试', query: 'Hatchet distributed task queue retry orchestration', url: 'https://github.com/search?q=Hatchet+task+queue&type=repositories' },
  { title: 'Windmill：脚本转持久 workflow', query: 'Windmill scripts durable workflow engine', url: 'https://github.com/search?q=Windmill+workflow&type=repositories' },
  { title: 'Prefect：数据/任务 workflow 编排与恢复', query: 'Prefect workflow orchestration retry recovery', url: 'https://github.com/search?q=Prefect+workflow&type=repositories' },
  // ⑤ 思考接地/推理
  { title: 'ReAct：推理与行动交错范式', query: 'ReAct reasoning acting interleaved agents', url: 'https://github.com/search?q=ReAct+reasoning+acting+agent&type=repositories' },
  { title: 'Self-Refine：自我反馈迭代改进', query: 'Self-Refine iterative self-feedback improvement', url: 'https://github.com/search?q=Self-Refine+LLM&type=repositories' },
  { title: 'Graph of Thoughts：图结构推理', query: 'Graph of Thoughts reasoning graph LLM', url: 'https://github.com/search?q=Graph+of+Thoughts&type=repositories' },
  { title: 'LATS：语言 agent 树搜索', query: 'LATS language agent tree search reasoning', url: 'https://github.com/search?q=Language+Agent+Tree+Search&type=repositories' },
  // ⑥ capability/工具接入
  { title: 'Gorilla：教 LLM 调海量 API', query: 'Gorilla LLM API calls tool use', url: 'https://github.com/search?q=Gorilla+LLM+API&type=repositories' },
  { title: 'Open Interpreter：本地代码执行 agent', query: 'Open Interpreter local code execution agent', url: 'https://github.com/search?q=open-interpreter&type=repositories' },
  { title: 'Semantic Kernel：微软 agent 编排与插件', query: 'Microsoft Semantic Kernel agent orchestration plugins', url: 'https://github.com/search?q=semantic-kernel&type=repositories' },
  { title: 'Toolformer：模型自学何时调工具', query: 'Toolformer self-supervised tool use language model', url: 'https://github.com/search?q=Toolformer&type=repositories' },
]);

/** 汇集所有具体学习概念为 NoeTopicCurator.getNextTopic 的 dynamicConcepts 入参（{title,url,query}）。 */
export function collectLearningConcepts(concepts = NOE_LEARNING_CONCEPTS) {
  const list = Array.isArray(concepts) && concepts.length ? concepts : NOE_LEARNING_CONCEPTS;
  return list.map((c) => ({ title: c.title, url: c.url, query: c.query }));
}

export function learningTopicAtCursor(cursor, topics = NOE_LEARNING_TOPICS) {
  const list = Array.isArray(topics) && topics.length ? topics : NOE_LEARNING_TOPICS;
  return list[Math.abs(Math.floor(Number(cursor) || 0)) % list.length];
}

export function selectLearningTopicForText(text, topics = NOE_LEARNING_TOPICS) {
  const s = String(text || '');
  if (/能力|工具|插件|技能|接入|mcp|capability|tool|plugin|skill/i.test(s)) return topics[5] || learningTopicAtCursor(5, topics);
  if (/电脑|浏览器|上网|行动|执行|操控|GUI|macOS|computer|browser|action/i.test(s)) return topics[1] || learningTopicAtCursor(1, topics);
  if (/记忆|长期|冲突|修正|memory|conflict/i.test(s)) return topics[2] || learningTopicAtCursor(2, topics);
  if (/checkpoint|resume|恢复|失败|卡住|审计|证据/i.test(s)) return topics[3] || learningTopicAtCursor(3, topics);
  if (/意识|内心|思考|主观|echo|monologue|reflection/i.test(s)) return topics[4] || learningTopicAtCursor(4, topics);
  return topics[0] || learningTopicAtCursor(0, topics);
}
