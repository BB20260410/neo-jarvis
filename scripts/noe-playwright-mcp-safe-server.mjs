#!/usr/bin/env node
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = resolve(ROOT, 'output/noe-ecosystem-install-2026-06-12');
const BLOCKED_TOOLS = new Set(['browser_run_code_unsafe']);
const SAFE_BROWSER = process.env.NOE_PLAYWRIGHT_MCP_BROWSER || 'chrome';

const upstream = new Client(
  { name: 'noe-playwright-safe-proxy', version: '1.0.0' },
  { capabilities: { tools: {} } },
);

const upstreamTransport = new StdioClientTransport({
  command: process.execPath,
  args: [
    resolve(ROOT, 'node_modules/@playwright/mcp/cli.js'),
    '--headless',
    '--isolated',
    '--browser', SAFE_BROWSER,
    '--output-dir', resolve(OUT_DIR, 'playwright-mcp-output'),
    '--snapshot-mode', 'full',
    '--codegen', 'none',
    '--block-service-workers',
    '--allowed-hosts', '127.0.0.1,localhost',
  ],
  env: process.env,
});

await upstream.connect(upstreamTransport);

const server = new Server(
  { name: 'noe-playwright-mcp-safe', version: '1.0.0' },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => {
  const res = await upstream.listTools();
  return { tools: (res.tools || []).filter((tool) => !BLOCKED_TOOLS.has(tool.name)) };
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const name = request.params?.name;
  if (BLOCKED_TOOLS.has(name)) throw new Error(`blocked_tool:${name}`);
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
