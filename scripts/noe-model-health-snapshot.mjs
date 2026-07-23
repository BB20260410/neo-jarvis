#!/usr/bin/env node
// @ts-check
// P2 read-only model health snapshot. It does not load/unload LM Studio models
// and does not perform chat/completion calls.
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { auditNoeProviderHealth } from '../src/secrets/NoeProviderHealth.js';
import { listLoadedLmStudioModels } from '../src/room/LmStudioLoader.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = process.env.NOE_MODEL_HEALTH_OUT_DIR
  ? resolve(process.env.NOE_MODEL_HEALTH_OUT_DIR)
  : join(ROOT, 'output', 'noe-model-health');
const NOW = Date.now();
const LM_BASE = (process.env.LM_STUDIO_BASE_URL || process.env.NOE_LMSTUDIO_URL || 'http://127.0.0.1:1234/v1').replace(/\/$/, '');
const OLLAMA_BASE = (process.env.NOE_OLLAMA_URL || process.env.OLLAMA_HOST || 'http://127.0.0.1:11434').replace(/\/$/, '');
const PROVIDERS = (process.env.NOE_MODEL_HEALTH_PROVIDERS || 'minimax,xiaomi,gemini,openai,anthropic')
  .split(',')
  .map((item) => item.trim())
  .filter(Boolean);

function rel(file) {
  return relative(ROOT, file).replace(/\\/g, '/');
}

function cleanError(error) {
  return String(error?.message || error || '').replace(/\b(sk-[A-Za-z0-9_-]{8,}|Bearer\s+[A-Za-z0-9._~+/=-]+)\b/g, '[redacted]').slice(0, 1000);
}

async function fetchJson(url, init = {}) {
  const startedAt = Date.now();
  try {
    const res = await fetch(url, init);
    const text = await res.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch {}
    return { ok: res.ok, status: res.status, elapsedMs: Date.now() - startedAt, json, error: res.ok ? '' : cleanError(text || `http_${res.status}`) };
  } catch (error) {
    return { ok: false, status: 0, elapsedMs: Date.now() - startedAt, json: null, error: cleanError(error) };
  }
}

async function lmStudioHealth() {
  const models = await fetchJson(`${LM_BASE}/models`);
  const listed = Array.isArray(models.json?.data) ? models.json.data.map((m) => String(m?.id || '')).filter(Boolean) : [];
  const loaded = await listLoadedLmStudioModels(LM_BASE).catch(() => null);
  return {
    ok: models.ok,
    baseUrl: LM_BASE,
    modelsEndpoint: `${LM_BASE}/models`,
    status: models.status,
    elapsedMs: models.elapsedMs,
    modelCount: listed.length,
    sampleModels: listed.slice(0, 12),
    loadedModels: Array.isArray(loaded) ? loaded : null,
    loadedCount: Array.isArray(loaded) ? loaded.length : null,
    loadedProbeChangedModels: false,
    error: models.error,
  };
}

async function ollamaHealth() {
  const out = await fetchJson(`${OLLAMA_BASE}/api/tags`);
  const models = Array.isArray(out.json?.models) ? out.json.models.map((m) => String(m?.name || '')).filter(Boolean) : [];
  return {
    ok: out.ok,
    baseUrl: OLLAMA_BASE,
    tagsEndpoint: `${OLLAMA_BASE}/api/tags`,
    status: out.status,
    elapsedMs: out.elapsedMs,
    modelCount: models.length,
    sampleModels: models.slice(0, 12),
    error: out.error,
  };
}

export function buildModelHealthReport({ lmstudio, ollama, providerHealth, now = NOW } = {}) {
  return {
    ok: true,
    generatedAt: new Date(now).toISOString(),
    policy: {
      readOnly: true,
      noChatCompletionCalls: true,
      lmStudioLoadUnloadChanged: false,
      secretValuesReturned: false,
    },
    local: {
      lmstudio,
      ollama,
    },
    onlineProviders: providerHealth,
    unavailable: {
      local: [
        ...(!lmstudio?.ok ? ['lmstudio'] : []),
        ...(!ollama?.ok ? ['ollama'] : []),
      ],
      providers: providerHealth?.unavailableProviders || [],
    },
  };
}

export function writeModelHealthReport(report, { outDir = OUT_DIR, now = NOW } = {}) {
  mkdirSync(outDir, { recursive: true, mode: 0o700 });
  const reportPath = join(outDir, `model-health-${now}.json`);
  const latestPath = join(outDir, 'latest.json');
  const body = `${JSON.stringify(report, null, 2)}\n`;
  writeFileSync(reportPath, body, { mode: 0o600 });
  writeFileSync(latestPath, body, { mode: 0o600 });
  return { reportPath: rel(reportPath), latestPath: rel(latestPath) };
}

export async function collectModelHealthReport() {
  const [lmstudio, ollama, providerHealth] = await Promise.all([
    lmStudioHealth(),
    ollamaHealth(),
    auditNoeProviderHealth({ providers: PROVIDERS }),
  ]);
  return buildModelHealthReport({ lmstudio, ollama, providerHealth });
}

export async function main() {
  const report = await collectModelHealthReport();
  const paths = writeModelHealthReport(report);
  console.log(JSON.stringify({ ...report, ...paths }, null, 2));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
