#!/usr/bin/env node
// @ts-check
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildMcpSmokeEnv, summarizeMcpToolSafety } from './lib/noe-mcp-smoke-safety.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = resolve(ROOT, 'output/noe-codex-mcp-smoke');
const LATEST_JSON = resolve(OUT_DIR, 'latest.json');
const CODEX_BIN = process.env.CODEX_BIN || 'codex';

const TARGETS = [
  'noe-chrome-devtools-local-safe',
  'noe-context7-docs',
  'noe-semgrep-local-security',
];

function redact(value) {
  return String(value || '')
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{12,}/gi, 'Bearer [redacted]')
    .replace(/\b(?:sk-ant|sk|tp-c|AIza)[A-Za-z0-9._-]{10,}\b/g, '[redacted-secret]')
    .replace(/\b((?:OPENAI|ANTHROPIC|CLAUDE|CODEX|GEMINI|GOOGLE|MINIMAX|XIAOMI|MIMO|OBSIDIAN)?_?(?:API_)?(?:KEY|TOKEN|SECRET))\s*[:=]\s*["']?[^"',\s}]+/gi, '$1=[redacted]');
}

function toolNames(tools) {
  return tools.map((tool) => tool.name).sort();
}

function firstTool(names, candidates) {
  return candidates.find((candidate) => names.includes(candidate)) || null;
}

function toolErrored(result) {
  const text = String(result?.content?.[0]?.text || '');
  return Boolean(result?.error || result?.isError || /^### Error/m.test(text) || /^MCP error/m.test(text));
}

function readCodexMcpConfig(name) {
  const res = spawnSync(CODEX_BIN, ['mcp', 'get', name, '--json'], {
    cwd: ROOT,
    encoding: 'utf8',
    env: process.env,
  });
  if (res.status !== 0) {
    throw new Error(`codex_mcp_get_failed:${name}:${redact(res.stderr || res.stdout)}`);
  }
  const cfg = JSON.parse(res.stdout);
  if (cfg.enabled !== true) throw new Error(`codex_mcp_disabled:${name}`);
  if (cfg.transport?.type !== 'stdio') throw new Error(`codex_mcp_non_stdio:${name}`);
  if (!cfg.transport.command) throw new Error(`codex_mcp_command_missing:${name}`);
  return cfg;
}

async function withClient(cfg, fn) {
  const transport = new StdioClientTransport({
    command: cfg.transport.command,
    args: cfg.transport.args || [],
    env: buildMcpSmokeEnv(cfg.transport.env || {}),
    cwd: cfg.transport.cwd || undefined,
  });
  const client = new Client(
    { name: 'noe-codex-mcp-smoke', version: '1.0.0' },
    { capabilities: { tools: {} } },
  );
  try {
    await client.connect(transport);
    return await fn(client);
  } finally {
    try { await client.close(); } catch {}
    try { await transport.close(); } catch {}
  }
}

async function withLocalPage(fn) {
  const server = createServer((req, res) => {
    if (req.url === '/data.json') {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ ok: true, source: 'noe-codex-mcp-smoke' }));
      return;
    }
    res.setHeader('content-type', 'text/html; charset=utf-8');
    res.end(`<!doctype html><html><head><title>Noe Codex MCP Smoke</title></head><body>
      <main>
        <h1>Noe Codex MCP Smoke</h1>
        <button data-testid="ping" onclick="console.log('noe-codex-mcp-smoke-clicked')">Ping</button>
        <script>fetch('/data.json').then(() => console.log('noe-codex-mcp-smoke-ready'));</script>
      </main>
    </body></html>`);
  });
  await new Promise((resolveReady) => server.listen(0, '127.0.0.1', resolveReady));
  const { port } = server.address();
  try {
    return await fn(`http://127.0.0.1:${port}/`);
  } finally {
    await new Promise((resolveClose) => server.close(resolveClose));
  }
}

async function smokeChrome(cfg) {
  return withClient(cfg, async (client) => {
    const tools = (await client.listTools()).tools || [];
    const names = toolNames(tools);
    const navigate = firstTool(names, ['new_page', 'navigate_page']);
    const snapshot = firstTool(names, ['take_snapshot', 'capture_snapshot']);
    const consoleTool = firstTool(names, ['list_console_messages', 'get_console_messages']);
    const calls = {};
    await withLocalPage(async (url) => {
      if (navigate) calls.navigate = await client.callTool({ name: navigate, arguments: { url } });
      if (snapshot) calls.snapshot = await client.callTool({ name: snapshot, arguments: {} });
      if (consoleTool) calls.console = await client.callTool({ name: consoleTool, arguments: {} });
    });
    return {
      id: cfg.name,
      ok: Boolean(navigate && snapshot && consoleTool && Object.values(calls).every((call) => !toolErrored(call))),
      toolCount: tools.length,
      selectedTools: { navigate, snapshot, consoleTool },
      toolSafety: summarizeMcpToolSafety(names),
      tools: names,
    };
  });
}

async function smokeContext7(cfg) {
  return withClient(cfg, async (client) => {
    const tools = (await client.listTools()).tools || [];
    const names = toolNames(tools);
    const resolveTool = firstTool(names, ['resolve-library-id']);
    const docsTool = firstTool(names, ['query-docs', 'get-library-docs']);
    const resolveCall = resolveTool
      ? await client.callTool({
        name: resolveTool,
        arguments: { query: 'Express routing documentation', libraryName: 'express' },
      })
      : null;
    return {
      id: cfg.name,
      ok: Boolean(resolveTool && docsTool && !toolErrored(resolveCall)),
      toolCount: tools.length,
      selectedTools: { resolveTool, docsTool },
      toolSafety: summarizeMcpToolSafety(names),
      tools: names,
      resolvePreview: redact(resolveCall?.content?.[0]?.text || '').slice(0, 300),
    };
  });
}

async function smokeSemgrep(cfg) {
  return withClient(cfg, async (client) => {
    const tools = (await client.listTools()).tools || [];
    const names = toolNames(tools);
    const languagesTool = firstTool(names, ['get_supported_languages']);
    const languagesCall = languagesTool
      ? await client.callTool({ name: languagesTool, arguments: {} })
      : null;
    return {
      id: cfg.name,
      ok: Boolean(languagesTool && !toolErrored(languagesCall)),
      toolCount: tools.length,
      selectedTools: { languagesTool },
      toolSafety: summarizeMcpToolSafety(names),
      tools: names,
    };
  });
}

async function smokeOne(name) {
  try {
    const cfg = readCodexMcpConfig(name);
    if (name === 'noe-chrome-devtools-local-safe') return smokeChrome(cfg);
    if (name === 'noe-context7-docs') return smokeContext7(cfg);
    if (name === 'noe-semgrep-local-security') return smokeSemgrep(cfg);
    return { id: name, ok: false, error: 'unknown_target' };
  } catch (error) {
    return { id: name, ok: false, error: redact(error?.message || error) };
  }
}

async function main() {
  mkdirSync(OUT_DIR, { recursive: true });
  const report = {
    ok: false,
    generatedAt: new Date().toISOString(),
    repoRoot: ROOT,
    configSource: 'codex mcp get --json',
    targets: TARGETS,
    boundaries: {
      secretsPrinted: false,
      touched51735: false,
      touched51835: false,
      restarted51835: false,
    },
    report: [],
  };
  report.report = await Promise.all(TARGETS.map((name) => smokeOne(name)));
  report.ok = report.report.every((item) => item.ok);
  const timestampPath = resolve(OUT_DIR, `codex-mcp-smoke-${Date.now()}.json`);
  writeFileSync(timestampPath, JSON.stringify(report, null, 2));
  writeFileSync(LATEST_JSON, JSON.stringify(report, null, 2));
  console.log(JSON.stringify({
    ok: report.ok,
    targets: report.report.map((item) => ({ id: item.id, ok: item.ok, toolCount: item.toolCount || 0 })),
    reportPath: timestampPath,
    latestPath: LATEST_JSON,
  }, null, 2));
  process.exitCode = report.ok ? 0 : 1;
}

main().catch((error) => {
  mkdirSync(OUT_DIR, { recursive: true });
  const report = { ok: false, generatedAt: new Date().toISOString(), error: redact(error?.stack || error?.message || error) };
  writeFileSync(LATEST_JSON, JSON.stringify(report, null, 2));
  console.error(JSON.stringify(report, null, 2));
  process.exit(1);
});
