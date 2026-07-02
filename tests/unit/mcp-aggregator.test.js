// @ts-check
import { describe, it, expect, vi } from 'vitest';
import {
  createMcpAggregator,
  parseToolName,
  prefixToolName,
  isAggregatorEnabled,
  NAMESPACE_SEPARATOR,
} from '../../src/mcp/McpAggregator.js';

// 构造一个 mock client：listTools 返回固定工具，callTool 记录入参回显。
// 不触网/不真模型/不定时——全部确定性内存对象。
function mockClient(toolNames, opts = {}) {
  return {
    listTools: vi.fn(async () => {
      if (opts.listFails) throw new Error(opts.listFails === true ? 'boom' : String(opts.listFails));
      return opts.bareArray
        ? toolNames.map((n) => ({ name: n }))
        : { tools: toolNames.map((n) => ({ name: n, description: `${n} desc` })) };
    }),
    callTool: vi.fn(async ({ name, arguments: args }) => ({ called: name, args })),
  };
}

describe('McpAggregator 纯函数 —— 命名空间前缀/反解', () => {
  it('prefixToolName 用双下划线拼 server__tool', () => {
    expect(prefixToolName('fs', 'read')).toBe('fs__read');
    expect(NAMESPACE_SEPARATOR).toBe('__');
  });

  it('parseToolName 反解 server 与 tool', () => {
    expect(parseToolName('fs__read')).toEqual({ server: 'fs', tool: 'read' });
  });

  it('parseToolName 按第一个分隔符切，保留 tool 名内部的 __', () => {
    // 借鉴 MetaMCP：server 名禁含分隔符，故下游 tool 名里的 __ 必须原样保留
    expect(parseToolName('fs__read__raw')).toEqual({ server: 'fs', tool: 'read__raw' });
  });

  it('parseToolName 对非法输入返回 null', () => {
    expect(parseToolName('noseparator')).toBeNull();
    expect(parseToolName('__leading')).toBeNull(); // server 段空
    expect(parseToolName('trailing__')).toBeNull(); // tool 段空
    expect(parseToolName('')).toBeNull();
    // @ts-expect-error 故意传非字符串测防御
    expect(parseToolName(null)).toBeNull();
    // @ts-expect-error
    expect(parseToolName(42)).toBeNull();
  });

  it('round-trip：prefix 后再 parse 还原', () => {
    const p = prefixToolName('weather', 'forecast');
    expect(parseToolName(p)).toEqual({ server: 'weather', tool: 'forecast' });
  });
});

describe('McpAggregator env 门控（默认 OFF）', () => {
  it('isAggregatorEnabled 只在 NOE_MCP_AGGREGATOR===1 时为真', () => {
    expect(isAggregatorEnabled({ NOE_MCP_AGGREGATOR: '1' })).toBe(true);
    expect(isAggregatorEnabled({ NOE_MCP_AGGREGATOR: '0' })).toBe(false);
    expect(isAggregatorEnabled({})).toBe(false);
    expect(isAggregatorEnabled({ NOE_MCP_AGGREGATOR: 'true' })).toBe(false); // 严格 '1'
  });

  it('门控 OFF（注入 enabled:false）时 listAllTools 返空、不调下游', () => {
    const client = mockClient(['read']);
    const agg = createMcpAggregator({
      getClients: () => ({ fs: client }),
      enabled: false,
    });
    return agg.listAllTools().then((res) => {
      expect(res).toEqual({ enabled: false, tools: [], errors: [], servers: [] });
      expect(client.listTools).not.toHaveBeenCalled();
    });
  });

  it('门控 OFF 时 callTool 直接拒绝（保持现状单 server 路径权威）', async () => {
    const client = mockClient(['read']);
    const agg = createMcpAggregator({
      getClients: () => ({ fs: client }),
      enabled: false,
    });
    await expect(agg.callTool('fs__read', {})).rejects.toThrow(/已禁用|NOE_MCP_AGGREGATOR/);
    expect(client.callTool).not.toHaveBeenCalled();
  });

  it('门控读注入 env（不依赖真实 process.env）', async () => {
    const client = mockClient(['read']);
    const agg = createMcpAggregator({
      getClients: () => ({ fs: client }),
      env: { NOE_MCP_AGGREGATOR: '1' },
    });
    const res = await agg.listAllTools();
    expect(res.enabled).toBe(true);
    expect(res.tools).toHaveLength(1);
  });
});

describe('McpAggregator 聚合视图（命名空间防撞）', () => {
  function enabledAgg(getClients, extra = {}) {
    return createMcpAggregator({ getClients, enabled: true, ...extra });
  }

  it('跨多 server 聚合，工具名带前缀且不撞', async () => {
    // 两个 server 都有 read：靠前缀区分
    const agg = enabledAgg(() => ({
      fs: mockClient(['read', 'write']),
      http: mockClient(['read', 'fetch']),
    }));
    const { tools, servers, errors } = await agg.listAllTools();
    expect(errors).toEqual([]);
    expect(servers.sort()).toEqual(['fs', 'http']);
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual(['fs__read', 'fs__write', 'http__fetch', 'http__read']);
    // 同名 read 不再相撞
    expect(names.filter((n) => n.endsWith('__read'))).toEqual(['fs__read', 'http__read']);
  });

  it('每个聚合工具保留 server / originalName / 原字段', async () => {
    const agg = enabledAgg(() => ({ fs: mockClient(['read']) }));
    const { tools } = await agg.listAllTools();
    expect(tools[0]).toMatchObject({
      name: 'fs__read',
      server: 'fs',
      originalName: 'read',
      description: 'read desc', // 原字段透传
    });
  });

  it('兼容 listTools 返回裸数组形态', async () => {
    const agg = enabledAgg(() => ({ fs: mockClient(['a', 'b'], { bareArray: true }) }));
    const { tools } = await agg.listAllTools();
    expect(tools.map((t) => t.name).sort()).toEqual(['fs__a', 'fs__b']);
  });

  it('支持 getClients 返回 Map', async () => {
    const m = new Map([['fs', mockClient(['read'])]]);
    const agg = enabledAgg(() => m);
    const { tools } = await agg.listAllTools();
    expect(tools[0].name).toBe('fs__read');
  });

  it('支持 getClients 异步', async () => {
    const agg = enabledAgg(async () => ({ fs: mockClient(['read']) }));
    const { tools } = await agg.listAllTools();
    expect(tools[0].name).toBe('fs__read');
  });

  it('跳过 server 名含分隔符 / 空名 / null client（防反解歧义）', async () => {
    const agg = enabledAgg(() => ({
      'bad__name': mockClient(['x']), // 名含分隔符 → 过滤
      '': mockClient(['y']),          // 空名 → 过滤
      nullc: null,                    // null client → 过滤
      good: mockClient(['z']),
    }));
    const { tools, servers } = await agg.listAllTools();
    expect(servers).toEqual(['good']);
    expect(tools.map((t) => t.name)).toEqual(['good__z']);
  });

  it('跳过无 name 的工具条目（防御）', async () => {
    const weird = {
      listTools: async () => ({ tools: [{ name: 'ok' }, { description: '无名' }, { name: '' }] }),
      callTool: async () => ({}),
    };
    const agg = enabledAgg(() => ({ s: weird }));
    const { tools } = await agg.listAllTools();
    expect(tools.map((t) => t.name)).toEqual(['s__ok']);
  });
});

describe('McpAggregator 故障隔离（借鉴 Promise.allSettled）', () => {
  it('单 server listTools 挂，不拖垮其余，挂的记进 errors', async () => {
    const agg = createMcpAggregator({
      enabled: true,
      getClients: () => ({
        good: mockClient(['read']),
        broken: mockClient([], { listFails: 'server down' }),
      }),
    });
    const { tools, errors, servers } = await agg.listAllTools();
    expect(servers.sort()).toEqual(['broken', 'good']);
    expect(tools.map((t) => t.name)).toEqual(['good__read']); // good 照常可见
    expect(errors).toEqual([{ server: 'broken', error: 'server down' }]);
  });

  it('client 缺 listTools 方法 → 记 error 不抛', async () => {
    const agg = createMcpAggregator({
      enabled: true,
      getClients: () => ({
        good: mockClient(['read']),
        legacy: { callTool: async () => ({}) }, // 没有 listTools
      }),
    });
    const { tools, errors } = await agg.listAllTools();
    expect(tools.map((t) => t.name)).toEqual(['good__read']);
    expect(errors).toEqual([{ server: 'legacy', error: 'client "legacy" 无 listTools' }]);
  });

  it('getClients 整体抛错 → fail-open 返空 + 单条 * 错误，不抛', async () => {
    const agg = createMcpAggregator({
      enabled: true,
      getClients: () => { throw new Error('store offline'); },
    });
    const res = await agg.listAllTools();
    expect(res).toEqual({
      enabled: true,
      tools: [],
      errors: [{ server: '*', error: 'store offline' }],
      servers: [],
    });
  });
});

describe('McpAggregator callTool 路由回下游', () => {
  function enabledAgg(getClients, extra = {}) {
    return createMcpAggregator({ getClients, enabled: true, ...extra });
  }

  it('按前缀路由到对应 client，并以原始 tool 名调用', async () => {
    const fs = mockClient(['read']);
    const http = mockClient(['fetch']);
    const agg = enabledAgg(() => ({ fs, http }));
    const out = await agg.callTool('http__fetch', { url: 'x' });
    expect(out).toEqual({ called: 'fetch', args: { url: 'x' } });
    expect(http.callTool).toHaveBeenCalledWith({ name: 'fetch', arguments: { url: 'x' } });
    expect(fs.callTool).not.toHaveBeenCalled(); // 没串到别的 server
  });

  it('tool 名内含 __ 时仍正确路由（取第一个分隔符）', async () => {
    const fs = mockClient(['read__raw']);
    const agg = enabledAgg(() => ({ fs }));
    await agg.callTool('fs__read__raw', { p: 1 });
    expect(fs.callTool).toHaveBeenCalledWith({ name: 'read__raw', arguments: { p: 1 } });
  });

  it('非法前缀名抛错', async () => {
    const agg = enabledAgg(() => ({ fs: mockClient(['read']) }));
    await expect(agg.callTool('nopfx', {})).rejects.toThrow(/非法的聚合工具名/);
  });

  it('未知 server 抛错', async () => {
    const agg = enabledAgg(() => ({ fs: mockClient(['read']) }));
    await expect(agg.callTool('ghost__do', {})).rejects.toThrow(/未找到 MCP server: ghost/);
  });

  it('client 缺 callTool 抛错', async () => {
    const agg = enabledAgg(() => ({ legacy: { listTools: async () => ({ tools: [] }) } }));
    await expect(agg.callTool('legacy__x', {})).rejects.toThrow(/无 callTool/);
  });

  it('onCallTool 注入钩子接管调用（中间件理念极简版）', async () => {
    const fs = mockClient(['read']);
    const hook = vi.fn(async (prefixed, args, ctx) => ({ via: 'hook', prefixed, server: ctx.server, tool: ctx.tool, args }));
    const agg = enabledAgg(() => ({ fs }), { onCallTool: hook });
    const out = await agg.callTool('fs__read', { a: 1 });
    expect(out).toEqual({ via: 'hook', prefixed: 'fs__read', server: 'fs', tool: 'read', args: { a: 1 } });
    expect(hook).toHaveBeenCalledOnce();
    expect(fs.callTool).not.toHaveBeenCalled(); // 钩子接管后不再直调下游
  });

  it('callTool 默认 args 为空对象', async () => {
    const fs = mockClient(['ping']);
    const agg = enabledAgg(() => ({ fs }));
    await agg.callTool('fs__ping');
    expect(fs.callTool).toHaveBeenCalledWith({ name: 'ping', arguments: {} });
  });
});

describe('McpAggregator 构造与 isEnabled', () => {
  it('getClients 非函数直接抛', () => {
    // @ts-expect-error 故意传错
    expect(() => createMcpAggregator({ getClients: 123 })).toThrow(/getClients 必须是函数/);
    expect(() => createMcpAggregator({})).toThrow(/getClients 必须是函数/);
  });

  it('isEnabled 反映门控状态', () => {
    const on = createMcpAggregator({ getClients: () => ({}), enabled: true });
    const off = createMcpAggregator({ getClients: () => ({}), enabled: false });
    expect(on.isEnabled()).toBe(true);
    expect(off.isEnabled()).toBe(false);
  });

  it('暴露 parseToolName 复用纯函数', () => {
    const agg = createMcpAggregator({ getClients: () => ({}), enabled: true });
    expect(agg.parseToolName('a__b')).toEqual({ server: 'a', tool: 'b' });
  });
});
