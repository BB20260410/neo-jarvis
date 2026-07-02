#!/usr/bin/env node
// @ts-check
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { nonLocalUrls } from './lib/noe-local-url-safety.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = resolve(ROOT, 'output/noe-p0-tool-install-2026-06-14');
const CHROME_DEVTOOLS_BIN = resolve(ROOT, 'node_modules/chrome-devtools-mcp/build/src/bin/chrome-devtools-mcp.js');
const BLOCKED_TOOLS = new Set(['click_at', 'drag_at', 'fill_at']);

const upstream = new Client(
  { name: 'noe-chrome-devtools-safe-proxy', version: '1.0.0' },
  { capabilities: { tools: {} } },
);

const upstreamTransport = new StdioClientTransport({
  command: process.execPath,
  args: [
    CHROME_DEVTOOLS_BIN,
    '--headless',
    '--isolated',
    '--channel', process.env.NOE_CHROME_DEVTOOLS_CHANNEL || 'stable',
    '--viewport', process.env.NOE_CHROME_DEVTOOLS_VIEWPORT || '1280x720',
    '--no-usage-statistics',
    '--no-performance-crux',
    '--redact-network-headers',
    '--logFile', resolve(OUT_DIR, 'chrome-devtools-mcp.log'),
  ],
  env: {
    ...process.env,
    CHROME_DEVTOOLS_MCP_NO_USAGE_STATISTICS: '1',
    CI: '1',
  },
});

await upstream.connect(upstreamTransport);

const server = new Server(
  { name: 'noe-chrome-devtools-mcp-safe', version: '1.0.0' },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => {
  const res = await upstream.listTools();
  return { tools: (res.tools || []).filter((tool) => !BLOCKED_TOOLS.has(tool.name)) };
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const name = String(request.params?.name || '');
  if (BLOCKED_TOOLS.has(name)) throw new Error(`blocked_tool:${name}`);
  const blocked = nonLocalUrls(request.params?.arguments || {});
  if (blocked.length > 0) throw new Error(`blocked_non_local_url:${blocked[0]}`);
  return upstream.callTool({ name, arguments: request.params?.arguments || {} });
});

async function shutdown() {
  try { await upstream.close(); } catch {}
  try { await upstreamTransport.close(); } catch {}
}

process.on('exit', () => {
  try { upstreamTransport.close(); } catch {}
});
process.on('SIGINT', async () => { await shutdown(); process.exit(130); });
process.on('SIGTERM', async () => { await shutdown(); process.exit(143); });

const transport = new StdioServerTransport();
transport.onclose = () => {
  shutdown().finally(() => process.exit(0));
};

await server.connect(transport);
