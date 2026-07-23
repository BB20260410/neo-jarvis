#!/usr/bin/env node
// @ts-check
import { spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { McpStore } from '../src/mcp/McpStore.js';
import { McpClientManager } from '../src/mcp/McpClientManager.js';
import { buildMcpSmokeEnv, summarizeMcpToolSafety } from './lib/noe-mcp-smoke-safety.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = resolve(ROOT, 'output/noe-p0-tool-install-2026-06-14');
const OUT_JSON = resolve(OUT_DIR, 'p0-tool-smoke.json');
const SEMGREP_BIN = resolve(OUT_DIR, '.venv-semgrep/bin/semgrep');
mkdirSync(OUT_DIR, { recursive: true });

function summarizeTools(tools) {
  return tools.map((tool) => tool.name).sort();
}

function firstTool(toolNames, candidates) {
  return candidates.find((candidate) => toolNames.includes(candidate)) || null;
}

function toolErrored(result) {
  const text = String(result?.content?.[0]?.text || '');
  return Boolean(result?.error || result?.isError || /^### Error/m.test(text));
}

async function withLocalPage(fn) {
  const server = createServer((req, res) => {
    if (req.url === '/data.json') {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ ok: true, source: 'noe-p0-tool-smoke' }));
      return;
    }
    res.setHeader('content-type', 'text/html; charset=utf-8');
    res.end(`<!doctype html><html><head><title>Noe P0 Tool Smoke</title></head><body>
      <main>
        <h1>Noe P0 Tool Smoke</h1>
        <button data-testid="ping" onclick="console.log('noe-p0-tool-smoke-clicked')">Ping</button>
        <script>fetch('/data.json').then(() => console.log('noe-p0-tool-smoke-ready'));</script>
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

async function smokeChromeDevtools(manager) {
  const tools = await manager.listTools('chrome-devtools-local-safe');
  const toolNames = summarizeTools(tools);
  const navigate = firstTool(toolNames, ['new_page', 'navigate_page']);
  const snapshot = firstTool(toolNames, ['take_snapshot', 'capture_snapshot']);
  const consoleTool = firstTool(toolNames, ['list_console_messages', 'get_console_messages']);
  const networkTool = firstTool(toolNames, ['list_network_requests', 'get_network_requests']);
  const screenshot = firstTool(toolNames, ['take_screenshot', 'screenshot']);
  const calls = {};
  await withLocalPage(async (url) => {
    if (navigate) calls.navigate = await manager.callTool('chrome-devtools-local-safe', navigate, { url });
    if (snapshot) calls.snapshot = await manager.callTool('chrome-devtools-local-safe', snapshot, {});
    if (consoleTool) calls.console = await manager.callTool('chrome-devtools-local-safe', consoleTool, {});
    if (networkTool) calls.network = await manager.callTool('chrome-devtools-local-safe', networkTool, {});
    if (screenshot) calls.screenshot = await manager.callTool('chrome-devtools-local-safe', screenshot, {
      filePath: resolve(OUT_DIR, 'chrome-devtools-smoke.png'),
    });
  });
  return {
    id: 'chrome_devtools_mcp',
    ok: Boolean(navigate && (snapshot || screenshot) && (consoleTool || networkTool)
      && Object.values(calls).every((call) => !toolErrored(call))),
    toolCount: tools.length,
    tools: toolNames,
    toolSafety: summarizeMcpToolSafety(toolNames),
    selectedTools: { navigate, snapshot, consoleTool, networkTool, screenshot },
  };
}

async function smokeContext7(manager) {
  const tools = await manager.listTools('context7-docs');
  const toolNames = summarizeTools(tools);
  const resolveTool = firstTool(toolNames, ['resolve-library-id']);
  const docsTool = firstTool(toolNames, ['query-docs', 'get-library-docs']);
  const calls = {};
  if (resolveTool) {
    calls.resolve = await manager.callTool('context7-docs', resolveTool, {
      query: 'Express routing documentation',
      libraryName: 'express',
    });
  }
  return {
    id: 'context7_docs_mcp',
    ok: Boolean(resolveTool && docsTool && !toolErrored(calls.resolve)),
    toolCount: tools.length,
    tools: toolNames,
    toolSafety: summarizeMcpToolSafety(toolNames),
    selectedTools: { resolveTool, docsTool },
    resolvePreview: String(calls.resolve?.content?.[0]?.text || '').slice(0, 500),
  };
}

async function smokeSemgrepMcp(manager) {
  const tools = await manager.listTools('semgrep-local-security');
  const toolNames = summarizeTools(tools);
  return {
    id: 'semgrep_mcp',
    ok: tools.length > 0 && toolNames.some((name) => /scan|semgrep|security/i.test(name)),
    toolCount: tools.length,
    tools: toolNames,
    toolSafety: summarizeMcpToolSafety(toolNames),
  };
}

export function semgrepCliSmoke() {
  const dir = resolve(OUT_DIR, 'semgrep-smoke');
  mkdirSync(dir, { recursive: true });
  const sample = resolve(dir, 'sample.js');
  const rules = resolve(dir, 'rules.yml');
  writeFileSync(sample, 'function run(x) { return eval(x); }\n');
  writeFileSync(rules, [
    'rules:',
    '  - id: noe-smoke-avoid-eval',
    '    languages: [javascript]',
    '    severity: ERROR',
    '    message: Avoid eval in Noe smoke sample.',
    '    pattern: eval($X)',
    '',
  ].join('\n'));
  const res = spawnSync(SEMGREP_BIN, ['scan', '--config', rules, sample, '--json', '--metrics=off'], {
    cwd: ROOT,
    encoding: 'utf8',
    env: buildMcpSmokeEnv({ SEMGREP_SEND_METRICS: 'off', SEMGREP_ENABLE_VERSION_CHECK: '0' }),
  });
  let parsed = null;
  try { parsed = JSON.parse(res.stdout || '{}'); } catch {}
  return {
    id: 'semgrep_cli',
    ok: [0, 1].includes(res.status) && Array.isArray(parsed?.results) && parsed.results.length === 1,
    status: res.status,
    version: spawnSync(SEMGREP_BIN, ['--version'], { encoding: 'utf8' }).stdout.trim(),
    resultCount: parsed?.results?.length || 0,
    stdoutTail: String(res.stdout || '').slice(-1000),
    stderrTail: String(res.stderr || '').slice(-1000),
    traceBannerObserved: /datadoghq\.com\/apm\/trace|Tracing initialized/i.test(`${res.stdout || ''}\n${res.stderr || ''}`),
  };
}

async function main() {
  const store = new McpStore();
  const manager = new McpClientManager({ store, baseEnv: buildMcpSmokeEnv() });
  const checks = [];
  try {
    for (const fn of [smokeChromeDevtools, smokeContext7, smokeSemgrepMcp]) {
      try {
        checks.push(await fn(manager));
      } catch (error) {
        checks.push({ id: fn.name, ok: false, error: error?.message || String(error) });
      }
    }
    checks.push(semgrepCliSmoke());
  } finally {
    await manager.disconnectAll().catch(() => {});
  }
  const report = { ok: checks.every((check) => check.ok), generatedAt: new Date().toISOString(), report: checks };
  writeFileSync(OUT_JSON, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  process.exit(report.ok ? 0 : 1);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((error) => {
    const report = { ok: false, generatedAt: new Date().toISOString(), error: error?.message || String(error) };
    writeFileSync(OUT_JSON, JSON.stringify(report, null, 2));
    console.error(JSON.stringify(report, null, 2));
    process.exit(1);
  });
}
