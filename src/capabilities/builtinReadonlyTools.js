// Noe ToolRegistry 的内置只读工具：让 ToolRegistry 从「有壳无肉（invoke 恒返 501）」
// 升级为真能执行的工具系统的第一步（NEXT_PLAN P1）。
//
// 严格只读边界：复用已有的 FileIndex / MemoryCore，只做文件检索 + 记忆检索，
// 绝不 shell / 写 / 删 / 移动 / 外发。manifest 不含 command 字段（避免触发 shell 权限分支），
// risk_level=low → PermissionGovernance 默认放行（classify 兜底：low/medium → allow）。

export const BUILTIN_READONLY_TOOLS = [
  {
    id: 'noe.fs.search',
    name: '只读文件检索',
    description: '在已索引的本地文件中按关键词检索片段，只读，不修改任何文件',
    version: '1.0.0',
    category: 'readonly',
    risk_level: 'low',
    operation: 'noe.fs.search',
  },
  {
    id: 'noe.memory.recall',
    name: '记忆检索',
    description: '检索 Noe 长期记忆（noe_memory）中的条目，只读',
    version: '1.0.0',
    category: 'readonly',
    risk_level: 'low',
    operation: 'noe.memory.recall',
  },
  {
    id: 'noe.fs.stats',
    name: '文件索引画像',
    description: '返回已索引文件的类型分布、价值分层和敏感文件数量，只读',
    version: '1.0.0',
    category: 'readonly',
    risk_level: 'low',
    operation: 'noe.fs.stats',
  },
  {
    id: 'noe.fs.organize_plan',
    name: '文件整理建议',
    description: '生成重复文件、大文件、低价值文件的整理建议，只读，不移动或删除文件',
    version: '1.0.0',
    category: 'readonly',
    risk_level: 'low',
    operation: 'noe.fs.organize_plan',
  },
  {
    id: 'noe.fs.hybrid_search',
    name: '混合文件检索',
    description: '按文件名、路径、正文和价值层级做混合检索，只读',
    version: '1.0.0',
    category: 'readonly',
    risk_level: 'low',
    operation: 'noe.fs.hybrid_search',
  },
  {
    id: 'noe.kg.ingest_file_index',
    name: '文件索引入图谱',
    description: '把当前只读文件索引转为项目/文件/术语关系图，不读取额外文件、不修改用户文件',
    version: '1.0.0',
    category: 'readonly',
    risk_level: 'low',
    operation: 'noe.kg.ingest_file_index',
  },
  {
    id: 'noe.kg.search',
    name: '知识图谱实体检索',
    description: '检索 Noe 本地图谱里的项目、文件、类型和术语实体，只读',
    version: '1.0.0',
    category: 'readonly',
    risk_level: 'low',
    operation: 'noe.kg.search',
  },
  {
    id: 'noe.kg.one_hop',
    name: '知识图谱一跳邻居',
    description: '查看实体的一跳关系，帮助理解文件、术语和项目之间的关联，只读',
    version: '1.0.0',
    category: 'readonly',
    risk_level: 'low',
    operation: 'noe.kg.one_hop',
  },
  {
    id: 'noe.kg.stats',
    name: '知识图谱统计',
    description: '返回 Noe 本地图谱实体、关系和类型分布，只读',
    version: '1.0.0',
    category: 'readonly',
    risk_level: 'low',
    operation: 'noe.kg.stats',
  },
];

function readQuery(args = {}) {
  return String(args.q ?? args.query ?? '').slice(0, 512);
}

/**
 * 构造内置只读工具的 handler 映射。只有依赖可用时才挂对应 handler。
 * @param {object} deps
 * @param {object} [deps.fileIndex] 需有 search()
 * @param {object} [deps.memory]    需有 recall()
 * @returns {Record<string, Function>} 可直接传给 ToolRegistry 的 handlers
 */
export function createReadonlyToolHandlers({ fileIndex, memory, knowledgeGraph } = {}) {
  const handlers = {};
  if (fileIndex && typeof fileIndex.search === 'function') {
    handlers['noe.fs.search'] = async ({ args = {} }) => {
      const q = readQuery(args);
      const results = fileIndex.search({ q, projectId: args.projectId, limit: args.limit });
      return { query: q, count: Array.isArray(results) ? results.length : 0, results };
    };
  }
  if (memory && typeof memory.recall === 'function') {
    handlers['noe.memory.recall'] = async ({ args = {} }) => {
      const q = readQuery(args);
      // bumpHits:false —— 只读检索不应改写记忆的命中统计
      const items = memory.recall({ q, projectId: args.projectId, limit: args.limit, bumpHits: false });
      return { query: q, count: Array.isArray(items) ? items.length : 0, items };
    };
  }
  if (fileIndex && typeof fileIndex.summarize === 'function') {
    handlers['noe.fs.stats'] = async ({ args = {} }) => fileIndex.summarize({ projectId: args.projectId });
  }
  if (fileIndex && typeof fileIndex.organizePlan === 'function') {
    handlers['noe.fs.organize_plan'] = async ({ args = {} }) => fileIndex.organizePlan({
      projectId: args.projectId,
      duplicateLimit: args.duplicateLimit,
      largeFileLimit: args.largeFileLimit,
    });
  }
  if (fileIndex && typeof fileIndex.hybridSearch === 'function') {
    handlers['noe.fs.hybrid_search'] = async ({ args = {} }) => {
      const q = readQuery(args);
      const results = fileIndex.hybridSearch({ q, projectId: args.projectId, limit: args.limit });
      return { query: q, count: Array.isArray(results) ? results.length : 0, results };
    };
  }
  if (knowledgeGraph && typeof knowledgeGraph.ingestFileIndex === 'function' && fileIndex) {
    handlers['noe.kg.ingest_file_index'] = async ({ args = {} }) => knowledgeGraph.ingestFileIndex({
      fileIndex,
      projectId: args.projectId || 'noe',
      limit: args.limit,
    });
  }
  if (knowledgeGraph && typeof knowledgeGraph.search === 'function') {
    handlers['noe.kg.search'] = async ({ args = {} }) => knowledgeGraph.search({
      q: readQuery(args),
      projectId: args.projectId || 'noe',
      limit: args.limit,
    });
  }
  if (knowledgeGraph && typeof knowledgeGraph.oneHop === 'function') {
    handlers['noe.kg.one_hop'] = async ({ args = {} }) => knowledgeGraph.oneHop({
      id: args.id,
      name: args.name,
      projectId: args.projectId || 'noe',
      limit: args.limit,
    });
  }
  if (knowledgeGraph && typeof knowledgeGraph.stats === 'function') {
    handlers['noe.kg.stats'] = async ({ args = {} }) => knowledgeGraph.stats({ projectId: args.projectId || 'noe' });
  }
  return handlers;
}

/**
 * 把内置只读工具注册进 registry 并启用。只注册「有对应 handler」的工具，
 * 避免注册了却 invoke 返 501。
 * @returns {{registered: string[]}}
 */
export function registerBuiltinReadonlyTools(registry, { handlers } = {}) {
  if (!registry || typeof registry.register !== 'function') return { registered: [] };
  const available = handlers || {};
  const registered = [];
  for (const manifest of BUILTIN_READONLY_TOOLS) {
    if (!(manifest.id in available)) continue;
    registry.register(manifest);
    if (typeof registry.setEnabled === 'function') registry.setEnabled(manifest.id, true);
    registered.push(manifest.id);
  }
  return { registered };
}
