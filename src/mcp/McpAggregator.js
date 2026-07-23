// @ts-check
//
// McpAggregator —— 跨 MCP server 统一工具视图（注入式纯逻辑，零依赖零端口）
//
// 借鉴 MetaMCP（metamcp-proxy.ts，MIT）的三个核心模式，用纯 JS 重写：
//   1. 命名空间前缀（借鉴 MetaMCP 的 `serverName__toolName`）—— 防多 server 同名工具相撞；
//   2. Promise.allSettled 跨 server listTools 聚合 + 故障隔离（借鉴 MetaMCP proxy 的
//      并发拉取 + 单 server 失败不拖垮整体）—— 一个 server 挂了，其余工具照样可见；
//   3. parseToolName 路由回下游（借鉴 MetaMCP 的 prefix→{server,tool} 反解）—— 调用时
//      从带前缀名解析出 server 与原始 tool，再分发到对应 client。
//
// 与 Neo 现状的关系（诚实标增量）：
//   - McpClientManager.js 是「每 server 独立 ensureConnected/listTools/callTool」模式，
//     无统一聚合视图、无命名空间防撞、无 allSettled 故障隔离 —— 本模块只补这三件缺口。
//   - 不重复 Neo 已有能力：审计（call-logger.js / logMcpCall）、权限拦截
//     （mcp.js requirePermission）、连接生命周期（McpClientManager）均不在本模块内复刻；
//     本模块只做「纯路由 + 聚合」，下游 client 由调用方注入（通常即 McpClientManager 的薄封装）。
//   - 设计目的：给 ToolRegistry / NoeToolRouter 一个统一 MCP 工具源（一个视图枚举所有
//     server 的工具，且名字保证不撞）。
//
// 行为变化全部 env 门控（宪法：新功能默认 OFF）：
//   NOE_MCP_AGGREGATOR === '1' 时聚合层生效；否则 listAllTools() 返空、callTool() 拒绝，
//   现状单 server 路径（McpClientManager 直调）保持唯一权威，零行为变化。
//   门控也可由 createMcpAggregator({ enabled }) 显式注入覆盖（便于测试 / 程序化控制）。

/** 命名空间分隔符（借鉴 MetaMCP 的双下划线，避开工具名常见的单下划线/连字符）。 */
export const NAMESPACE_SEPARATOR = '__';

/**
 * 读取 env 门控状态。注入式：调用方可传 env（默认 process.env），便于确定性测试。
 * @param {Record<string, string | undefined>} [env]
 * @returns {boolean}
 */
export function isAggregatorEnabled(env = process.env) {
  return env?.NOE_MCP_AGGREGATOR === '1';
}

/**
 * 给原始工具名加 server 命名空间前缀。
 * 借鉴 MetaMCP：`serverName__toolName`，保证跨 server 不撞名。
 * @param {string} server
 * @param {string} tool
 * @returns {string}
 */
export function prefixToolName(server, tool) {
  return `${server}${NAMESPACE_SEPARATOR}${tool}`;
}

/**
 * 从带前缀的工具名反解出 { server, tool }，用于路由回下游。
 * 借鉴 MetaMCP 的 prefix 反解；按【第一个】分隔符切分，因此原始 tool 名里若再含 `__`
 * 也能正确保留（server 名不允许含分隔符，见 createMcpAggregator 的 server 名校验）。
 * @param {string} prefixed
 * @returns {{ server: string, tool: string } | null} 解析失败返回 null（无前缀 / 空段）
 */
export function parseToolName(prefixed) {
  if (typeof prefixed !== 'string') return null;
  const idx = prefixed.indexOf(NAMESPACE_SEPARATOR);
  if (idx <= 0) return null; // 无分隔符，或分隔符在最前（server 为空）
  const server = prefixed.slice(0, idx);
  const tool = prefixed.slice(idx + NAMESPACE_SEPARATOR.length);
  if (!server || !tool) return null;
  return { server, tool };
}

/**
 * 创建一个 MCP 聚合器（注入式工厂，纯逻辑零端口）。
 *
 * @param {Object} deps
 * @param {() => (Record<string, any> | Map<string, any> | Promise<Record<string, any> | Map<string, any>>)} deps.getClients
 *   返回 { serverName -> client } 的注入函数（可同步 / 异步）。每个 client 需提供
 *   `listTools()`（返回 { tools:[...] } 或 [...]）与 `callTool({name, arguments})`。
 *   通常由 McpClientManager 的薄封装提供，本模块不关心连接生命周期。
 * @param {boolean} [deps.enabled] 显式覆盖 env 门控（不传则读 NOE_MCP_AGGREGATOR）。
 * @param {Record<string, string | undefined>} [deps.env] 注入 env（默认 process.env），用于读门控。
 * @param {(prefixed: string, args: object, ctx: {server: string, tool: string, client: any}) => any} [deps.onCallTool]
 *   可选调用钩子（借鉴 MetaMCP 的中间件理念的极简版）：若提供，callTool 走它而非默认
 *   `client.callTool`，便于上层插审计/超时/降级而不改本模块。默认直调下游 client。
 */
export function createMcpAggregator({ getClients, enabled, env = process.env, onCallTool } = {}) {
  if (typeof getClients !== 'function') {
    throw new Error('createMcpAggregator: getClients 必须是函数');
  }

  /** 门控判定：显式 enabled 优先，否则读 env。 */
  function gateOn() {
    return typeof enabled === 'boolean' ? enabled : isAggregatorEnabled(env);
  }

  /** 把注入返回的 clients 归一成 [name, client][]，过滤掉非法 server 名。 */
  function normalizeClients(raw) {
    /** @type {Array<[string, any]>} */
    let entries = [];
    if (raw instanceof Map) {
      entries = Array.from(raw.entries());
    } else if (raw && typeof raw === 'object') {
      entries = Object.entries(raw);
    }
    // server 名不得含命名空间分隔符（否则 parseToolName 反解会歧义），也不得为空。
    return entries.filter(([name, client]) =>
      typeof name === 'string' &&
      name.length > 0 &&
      !name.includes(NAMESPACE_SEPARATOR) &&
      client != null
    );
  }

  /** 从一次 listTools 返回里取出工具数组（兼容 {tools:[]} 与裸数组）。 */
  function extractTools(res) {
    if (Array.isArray(res)) return res;
    if (res && Array.isArray(res.tools)) return res.tools;
    return [];
  }

  /**
   * 聚合所有 server 的工具，返回带命名空间前缀的统一视图。
   * 借鉴 MetaMCP：Promise.allSettled 并发拉取 + 故障隔离（单 server 挂只记 error，
   * 不抛、不拖垮其余）。门控 OFF 时返空（现状单 server 路径保持唯一权威）。
   *
   * @returns {Promise<{
   *   enabled: boolean,
   *   tools: Array<{ name: string, server: string, originalName: string, [k: string]: any }>,
   *   errors: Array<{ server: string, error: string }>,
   *   servers: string[]
   * }>}
   */
  async function listAllTools() {
    if (!gateOn()) {
      return { enabled: false, tools: [], errors: [], servers: [] };
    }

    let raw;
    try {
      raw = await getClients();
    } catch (e) {
      // getClients 本身失败：整体降级为空 + 单条错误，不抛（fail-open，借鉴故障隔离精神）。
      return {
        enabled: true,
        tools: [],
        errors: [{ server: '*', error: String(e?.message || e) }],
        servers: [],
      };
    }

    const clients = normalizeClients(raw);
    const servers = clients.map(([name]) => name);

    const settled = await Promise.allSettled(
      clients.map(async ([name, client]) => {
        if (!client || typeof client.listTools !== 'function') {
          throw new Error(`client "${name}" 无 listTools`);
        }
        const res = await client.listTools();
        return { name, tools: extractTools(res) };
      })
    );

    /** @type {Array<{name:string, server:string, originalName:string}>} */
    const tools = [];
    /** @type {Array<{server:string, error:string}>} */
    const errors = [];

    settled.forEach((r, i) => {
      const serverName = clients[i][0];
      if (r.status === 'rejected') {
        errors.push({ server: serverName, error: String(r.reason?.message || r.reason) });
        return;
      }
      const { name, tools: list } = r.value;
      for (const t of list) {
        const originalName = t && typeof t.name === 'string' ? t.name : null;
        if (!originalName) continue; // 跳过无名工具（防御）
        tools.push({
          ...t,
          name: prefixToolName(name, originalName),
          server: name,
          originalName,
        });
      }
    });

    return { enabled: true, tools, errors, servers };
  }

  /**
   * 把带前缀的工具名调用路由回对应下游 server。
   * 借鉴 MetaMCP：parseToolName 反解 → 取对应 client → 调原始 tool。
   * 门控 OFF 时拒绝（现状路径走 McpClientManager 直调，不经本模块）。
   *
   * @param {string} prefixedName 形如 `serverName__toolName`
   * @param {object} [args] 工具参数
   * @returns {Promise<any>} 下游 callTool 的返回
   */
  async function callTool(prefixedName, args = {}) {
    if (!gateOn()) {
      throw new Error('McpAggregator 已禁用（NOE_MCP_AGGREGATOR!=1）');
    }
    const parsed = parseToolName(prefixedName);
    if (!parsed) {
      throw new Error(`非法的聚合工具名: ${String(prefixedName)}`);
    }
    const { server, tool } = parsed;

    let raw;
    try {
      raw = await getClients();
    } catch (e) {
      throw new Error(`getClients 失败: ${String(e?.message || e)}`);
    }
    const clients = normalizeClients(raw);
    const found = clients.find(([name]) => name === server);
    if (!found) {
      throw new Error(`未找到 MCP server: ${server}`);
    }
    const client = found[1];
    if (!client || typeof client.callTool !== 'function') {
      throw new Error(`client "${server}" 无 callTool`);
    }

    // 可注入钩子（中间件理念极简版）：上层可在此插审计/超时/降级。
    if (typeof onCallTool === 'function') {
      return onCallTool(prefixedName, args, { server, tool, client });
    }
    return client.callTool({ name: tool, arguments: args });
  }

  return {
    listAllTools,
    parseToolName, // 复用导出的纯函数，方便调用方反解
    callTool,
    isEnabled: gateOn,
  };
}

export default createMcpAggregator;
