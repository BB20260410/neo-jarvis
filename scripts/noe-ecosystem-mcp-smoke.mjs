#!/usr/bin/env node
import { createServer } from 'node:http';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { McpStore } from '../src/mcp/McpStore.js';
import { McpClientManager } from '../src/mcp/McpClientManager.js';
import { buildMcpSmokeEnv, summarizeMcpToolSafety } from './lib/noe-mcp-smoke-safety.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = resolve(ROOT, 'output/noe-ecosystem-install-2026-06-12');
const OUT_JSON = resolve(OUT_DIR, 'mcp-smoke.json');
mkdirSync(OUT_DIR, { recursive: true });

function summarizeTools(tools) {
  return tools.map((tool) => tool.name).sort();
}

function toolCallFailed(result) {
  const text = String(result?.content?.[0]?.text || '');
  return Boolean(result?.error || result?.isError || /^### Error/m.test(text));
}

async function withLocalPage(fn) {
  const server = createServer((req, res) => {
    res.setHeader('content-type', 'text/html; charset=utf-8');
    res.end(`<!doctype html><html><head><title>Noe MCP Smoke</title></head><body>
      <main>
        <h1>Noe MCP Smoke</h1>
        <button data-testid="ping" onclick="document.querySelector('#state').textContent='clicked'">Ping</button>
        <output id="state">idle</output>
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

async function main() {
  const store = new McpStore();
  const manager = new McpClientManager({ store, baseEnv: buildMcpSmokeEnv() });
  const checks = [];
  try {
    const serenaTools = await manager.listTools('serena-noe-repo');
    const serenaToolNames = summarizeTools(serenaTools);
    const overviewTool = serenaToolNames.includes('get_symbols_overview');
    const refsTool = serenaToolNames.includes('find_referencing_symbols');
    const serena = {
      ok: false,
      toolCount: serenaTools.length,
      tools: serenaToolNames.slice(0, 30),
      toolSafety: summarizeMcpToolSafety(serenaToolNames),
      overview: null,
      references: null,
    };
    if (overviewTool) {
      try {
        serena.overview = await manager.callTool('serena-noe-repo', 'get_symbols_overview', { relative_path: 'src/skills/SkillStore.js' });
      } catch (error) {
        serena.overview = { error: error.message };
      }
    }
    if (refsTool) {
      try {
        serena.references = await manager.callTool('serena-noe-repo', 'find_referencing_symbols', {
          name_path: 'SkillStore',
          relative_path: 'src/skills/SkillStore.js',
        });
      } catch (error) {
        serena.references = { error: error.message };
      }
    }
    serena.ok = Boolean(overviewTool && refsTool && !serena.overview?.error && !serena.references?.error);
    checks.push({ id: 'serena_mcp', ...serena });
  } catch (error) {
    checks.push({ id: 'serena_mcp', ok: false, error: error.message });
  } finally {
    await manager.disconnect('serena-noe-repo').catch(() => {});
  }

  try {
    const githubTools = await manager.listTools('github-readonly');
    const githubToolNames = summarizeTools(githubTools);
    const search = await manager.callTool('github-readonly', 'search_repositories_readonly', {
      query: 'modelcontextprotocol servers',
      per_page: 2,
    });
    checks.push({
      id: 'github_readonly_mcp',
      ok: githubToolNames.every((name) => name.endsWith('_readonly')) && !githubToolNames.some((name) => /create|update|delete|push|merge|fork/i.test(name)),
      toolCount: githubTools.length,
      tools: githubToolNames,
      toolSafety: summarizeMcpToolSafety(githubToolNames),
      smokeResultTextPrefix: String(search.content?.[0]?.text || '').slice(0, 300),
    });
  } catch (error) {
    checks.push({ id: 'github_readonly_mcp', ok: false, error: error.message });
  } finally {
    await manager.disconnect('github-readonly').catch(() => {});
  }

  try {
    await withLocalPage(async (url) => {
      const tools = await manager.listTools('playwright-local-safe');
      const toolNames = summarizeTools(tools);
      const navigateName = toolNames.find((name) => /navigate|browser_navigate/.test(name));
      const snapshotName = toolNames.find((name) => /snapshot/.test(name));
      const clickName = toolNames.find((name) => /click/.test(name));
      const screenshotName = toolNames.find((name) => /screenshot/.test(name));
      const unsafeTools = toolNames.filter((name) => /unsafe|run_code/i.test(name));
      const calls = {};
      if (navigateName) calls.navigate = await manager.callTool('playwright-local-safe', navigateName, { url });
      if (snapshotName) calls.snapshot = await manager.callTool('playwright-local-safe', snapshotName, {});
      if (clickName) calls.click = await manager.callTool('playwright-local-safe', clickName, { element: 'Ping button', target: 'e4' });
      if (screenshotName) calls.screenshot = await manager.callTool('playwright-local-safe', screenshotName, {
        filename: resolve(OUT_DIR, 'playwright-mcp-output/noe-playwright-mcp-smoke.png'),
      });
      checks.push({
        id: 'playwright_mcp',
        ok: Boolean(navigateName && snapshotName && clickName && screenshotName && unsafeTools.length === 0
          && !toolCallFailed(calls.navigate) && !toolCallFailed(calls.snapshot) && !toolCallFailed(calls.click) && !toolCallFailed(calls.screenshot)),
        toolCount: tools.length,
        tools: toolNames,
        unsafeTools,
        toolSafety: summarizeMcpToolSafety(toolNames),
        localUrl: url,
        callSummaries: Object.fromEntries(Object.entries(calls).map(([k, v]) => [k, v?.error || String(v?.content?.[0]?.text || '').slice(0, 300)])),
      });
    });
  } catch (error) {
    checks.push({ id: 'playwright_mcp', ok: false, error: error.message });
  } finally {
    await manager.disconnect('playwright-local-safe').catch(() => {});
  }

  const report = { ok: checks.every((check) => check.ok), generatedAt: new Date().toISOString(), report: checks };
  writeFileSync(OUT_JSON, JSON.stringify(report, null, 2));
  await manager.disconnectAll();
  console.log(JSON.stringify(report, null, 2));
  process.exit(report.ok ? 0 : 1);
}

main().catch((error) => {
  const report = { ok: false, generatedAt: new Date().toISOString(), error: error.message };
  writeFileSync(OUT_JSON, JSON.stringify(report, null, 2));
  console.error(JSON.stringify(report, null, 2));
  process.exitCode = 1;
});
