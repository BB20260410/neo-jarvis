#!/usr/bin/env node
// @ts-check
import { spawn } from 'node:child_process';
import { copyFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = resolve(ROOT, 'output/noe-tool-ecosystem');
const LATEST_JSON = resolve(OUT_DIR, 'latest.json');
const MAX_TAIL = 4000;
const CODEX_MCP_SMOKE_TIMEOUT_MS = 120_000;

export const DEFAULT_STEPS = [
  {
    id: 'dependency_versions',
    title: 'Node ecosystem dependencies',
    command: 'npm',
    args: ['ls', '@playwright/mcp', '@browserbasehq/stagehand', '@lancedb/lancedb', '@modelcontextprotocol/server-github', '@modelcontextprotocol/sdk', '@upstash/context7-mcp', 'chrome-devtools-mcp', 'playwright'],
    required: true,
  },
  {
    id: 'model_key_readiness',
    title: 'Model key readiness',
    command: process.execPath,
    args: ['scripts/noe-model-keychain-check.mjs'],
    required: false,
    acceptableNonZero: true,
  },
  {
    id: 'obsidian_mcp_readiness',
    title: 'Obsidian Local REST MCP readiness',
    command: process.execPath,
    args: ['scripts/obsidian-mcp-readiness.mjs'],
    required: false,
    acceptableNonZero: true,
  },
  {
    id: 'obsidian_mcp_plan',
    title: 'Obsidian MCP plan artifact',
    command: process.execPath,
    args: ['scripts/obsidian-mcp-plan.mjs'],
    required: false,
    acceptableNonZero: true,
  },
  {
    id: 'ecosystem_mcp_register',
    title: 'Register safe MCP servers',
    command: process.execPath,
    args: ['scripts/noe-ecosystem-mcp-register.mjs'],
    required: true,
  },
  {
    id: 'ecosystem_mcp_smoke',
    title: 'Smoke safe MCP servers',
    command: process.execPath,
    args: ['scripts/noe-ecosystem-mcp-smoke.mjs'],
    required: true,
  },
  {
    id: 'p0_tool_mcp_register',
    title: 'Register P0 tool MCP servers',
    command: process.execPath,
    args: ['scripts/noe-p0-tool-mcp-register.mjs'],
    required: true,
  },
  {
    id: 'p0_tool_smoke',
    title: 'Smoke P0 tools',
    command: process.execPath,
    args: ['scripts/noe-p0-tool-smoke.mjs'],
    required: true,
  },
  {
    id: 'codex_mcp_smoke',
    title: 'Smoke Codex-visible MCP servers',
    command: process.execPath,
    args: ['scripts/noe-codex-mcp-smoke.mjs'],
    required: true,
    timeoutMs: CODEX_MCP_SMOKE_TIMEOUT_MS,
  },
  {
    id: 'lancedb_memory_poc',
    title: 'LanceDB external memory PoC',
    command: process.execPath,
    args: ['scripts/noe-lancedb-memory-poc.mjs'],
    required: true,
  },
  {
    id: 'selected_skills_smoke',
    title: 'Selected engineering skills smoke',
    command: process.execPath,
    args: ['scripts/noe-skillstore-addys-smoke.mjs'],
    required: true,
  },
  {
    id: 'sherpa_capability_check',
    title: 'Local Sherpa voice primitives check',
    command: process.execPath,
    args: ['scripts/noe-sherpa-capability-check.mjs'],
    required: true,
  },
  {
    id: 'stagehand_local_poc',
    title: 'Stagehand local LM Studio PoC',
    command: process.execPath,
    args: ['scripts/noe-stagehand-poc.mjs'],
    required: false,
    acceptableNonZero: true,
  },
  {
    id: 'inspect_ai_eval_sample',
    title: 'Inspect AI eval sample',
    command: process.execPath,
    args: ['scripts/noe-inspect-ai-eval-sample.mjs'],
    required: true,
  },
];

export function redactText(value) {
  return String(value || '')
    .replace(/([?&](?:[^=\s&]*(?:key|token|secret|auth|password)[^=\s&]*)=)[^&\s]+/gi, '$1[redacted]')
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{12,}/gi, 'Bearer [redacted]')
    .replace(/\b(?:sk-ant|sk|tp-c|AIza)[A-Za-z0-9._-]{10,}\b/g, '[redacted-secret]')
    .replace(/\b((?:OPENAI|ANTHROPIC|CLAUDE|CODEX|GEMINI|GOOGLE|MINIMAX|XIAOMI|MIMO|OBSIDIAN)?_?(?:API_)?(?:KEY|TOKEN|SECRET))\s*[:=]\s*["']?[^"',\s}]+/gi, '$1=[redacted]');
}

export function tail(value, max = MAX_TAIL) {
  const text = redactText(value);
  return text.length > max ? text.slice(-max) : text;
}

export function parseJsonFromOutput(output) {
  const text = String(output || '').trim();
  if (!text) return null;
  const firstBrace = text.indexOf('{');
  const lastBrace = text.lastIndexOf('}');
  if (firstBrace < 0 || lastBrace <= firstBrace) return null;
  try {
    return JSON.parse(text.slice(firstBrace, lastBrace + 1));
  } catch {
    return null;
  }
}

export function normalizeStepResult(step, result) {
  const parsedJson = parseJsonFromOutput(result.stdout) || parseJsonFromOutput(result.stderr);
  const exitOk = result.status === 0;
  const jsonOk = typeof parsedJson?.ok === 'boolean' ? parsedJson.ok : null;
  const passed = exitOk && jsonOk !== false;
  const status = passed ? 'passed' : (step.required ? 'failed' : 'blocked');
  return {
    id: step.id,
    title: step.title,
    required: step.required !== false,
    status,
    exitStatus: result.status,
    signal: result.signal || null,
    timedOut: result.timedOut === true,
    timeoutMs: Number(result.timeoutMs) || 0,
    command: [step.command, ...(step.args || [])].join(' '),
    jsonOk,
    ok: passed,
    stdoutTail: tail(result.stdout),
    stderrTail: tail(result.stderr),
    parsedSummary: summarizeParsedJson(parsedJson),
  };
}

export function buildToolEcosystemReport({ generatedAt = new Date().toISOString(), repoRoot = ROOT, steps = [] } = {}) {
  const failedRequired = steps.filter((step) => step.required && step.status !== 'passed').map((step) => step.id);
  const blockedOptional = steps.filter((step) => !step.required && step.status !== 'passed').map((step) => step.id);
  return {
    ok: failedRequired.length === 0,
    generatedAt,
    repoRoot,
    boundaries: {
      secretsPrinted: false,
      touched51735: false,
      touched51835: false,
      restarted51835: false,
      touchedCartoonApocalypse: false,
      committed: false,
    },
    summary: {
      total: steps.length,
      passed: steps.filter((step) => step.status === 'passed').length,
      failedRequired,
      blockedOptional,
    },
    nextActions: buildNextActions({ failedRequired, blockedOptional }),
    steps,
  };
}

function summarizeParsedJson(value) {
  if (!value || typeof value !== 'object') return null;
  const summary = {};
  for (const key of ['ok', 'mode', 'note', 'error', 'provider', 'selectedModel', 'framework']) {
    if (key in value) summary[key] = value[key];
  }
  if (value.providers && typeof value.providers === 'object') {
    summary.providers = Object.fromEntries(Object.entries(value.providers).map(([name, item]) => [
      name,
      {
        ok: Boolean(item?.ok),
        source: typeof item?.source === 'string' ? item.source : null,
      },
    ]));
  }
  if (Array.isArray(value.report)) {
    summary.report = value.report.map((item) => ({ id: item?.id, ok: item?.ok })).filter((item) => item.id);
  }
  if (value.featureFlags && typeof value.featureFlags === 'object') {
    summary.featureFlags = value.featureFlags;
  }
  return summary;
}

function buildNextActions({ failedRequired, blockedOptional }) {
  const actions = [];
  if (failedRequired.includes('ecosystem_mcp_register') || failedRequired.includes('ecosystem_mcp_smoke')) {
    actions.push('Fix safe MCP registration/smoke before giving Neo browser/GitHub/Serena tool confidence.');
  }
  if (failedRequired.includes('lancedb_memory_poc')) {
    actions.push('Keep NOE_LANCEDB_MEMORY disabled and repair the output-only LanceDB PoC before promoting external memory.');
  }
  if (failedRequired.includes('p0_tool_mcp_register') || failedRequired.includes('p0_tool_smoke')) {
    actions.push('Keep Chrome DevTools MCP, Context7, and Semgrep in trial mode until the P0 tool smoke is green.');
  }
  if (failedRequired.includes('codex_mcp_smoke')) {
    actions.push('Run codex mcp list/get and repair the Codex-visible MCP registration before relying on these tools inside Codex.');
  }
  if (blockedOptional.includes('stagehand_local_poc')) {
    actions.push('Start LM Studio OpenAI-compatible server with the configured Qwen model, then rerun Stagehand PoC.');
  }
  if (blockedOptional.includes('obsidian_mcp_readiness')) {
    actions.push('Open Obsidian and verify Local REST API MCP readiness; keep secret values out of logs.');
  }
  if (blockedOptional.includes('model_key_readiness')) {
    actions.push('Configure only the missing model keys you actually want Neo to use; current report records readiness without printing values.');
  }
  return actions;
}

export async function runStep(step, { cwd = ROOT } = {}) {
  return new Promise((resolveStep) => {
    const timeoutMs = Number(step.timeoutMs) > 0 ? Number(step.timeoutMs) : 0;
    const child = spawn(step.command, step.args || [], {
      cwd,
      env: process.env,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    let timeout = null;
    let forceKillTimeout = null;
    const finish = (result, { clearForceKill = true } = {}) => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      if (clearForceKill && forceKillTimeout) clearTimeout(forceKillTimeout);
      resolveStep(result);
    };
    if (timeoutMs > 0) {
      timeout = setTimeout(() => {
        stderr += `\n[noe-tool-ecosystem] step timeout after ${timeoutMs}ms`;
        try { child.kill('SIGTERM'); } catch { /* ignore */ }
        forceKillTimeout = setTimeout(() => {
          try { child.kill('SIGKILL'); } catch { /* ignore */ }
        }, 5000);
        finish({ status: 124, signal: 'SIGTERM', stdout, stderr, timedOut: true, timeoutMs }, { clearForceKill: false });
      }, timeoutMs);
    }
    child.stdout?.on('data', (chunk) => { stdout += chunk.toString(); });
    child.stderr?.on('data', (chunk) => { stderr += chunk.toString(); });
    child.on('error', (error) => {
      finish({ status: 127, signal: null, stdout, stderr: `${stderr}\n${error.message}`, timedOut: false, timeoutMs });
    });
    child.on('close', (status, signal) => {
      if (forceKillTimeout) clearTimeout(forceKillTimeout);
      finish({ status, signal, stdout, stderr, timedOut: false, timeoutMs });
    });
  });
}

export async function runToolEcosystemVerify({ steps = DEFAULT_STEPS, outDir = OUT_DIR, cwd = ROOT } = {}) {
  mkdirSync(outDir, { recursive: true });
  const normalized = [];
  for (const step of steps) {
    process.stderr.write(`[noe-tool-ecosystem] ${step.id}...\n`);
    const result = await runStep(step, { cwd });
    const normalizedStep = normalizeStepResult(step, result);
    normalized.push(normalizedStep);
    process.stderr.write(`[noe-tool-ecosystem] ${step.id}: ${normalizedStep.status}\n`);
  }
  const report = buildToolEcosystemReport({ steps: normalized, repoRoot: cwd });
  const timestampPath = resolve(outDir, `tool-ecosystem-${Date.now()}.json`);
  const latestPath = resolve(outDir, 'latest.json');
  writeFileSync(timestampPath, JSON.stringify(report, null, 2));
  copyFileSync(timestampPath, latestPath);
  return { report, timestampPath, latestPath };
}

async function main() {
  const { report, timestampPath, latestPath } = await runToolEcosystemVerify();
  console.log(JSON.stringify({
    ok: report.ok,
    summary: report.summary,
    nextActions: report.nextActions,
    reportPath: timestampPath,
    latestPath,
  }, null, 2));
  process.exit(report.ok ? 0 : 1);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    const report = {
      ok: false,
      generatedAt: new Date().toISOString(),
      error: redactText(error?.stack || error?.message || error),
      boundaries: {
        secretsPrinted: false,
        touched51735: false,
        touched51835: false,
        restarted51835: false,
        touchedCartoonApocalypse: false,
        committed: false,
      },
    };
    mkdirSync(OUT_DIR, { recursive: true });
    writeFileSync(LATEST_JSON, JSON.stringify(report, null, 2));
    console.error(JSON.stringify(report, null, 2));
    process.exit(1);
  });
}
