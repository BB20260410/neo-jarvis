#!/usr/bin/env node
// @ts-check
// Controlled model-unloaded recovery drill. This does not load or unload real
// LM Studio models; it uses fake provider responses to verify recovery logic.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { NOE_MAIN_BRAIN_MODEL } from '../src/model/NoeLocalModelPolicy.js';
import { listLoadedLmStudioModels } from '../src/room/LmStudioLoader.js';
import { assertLocalCouncilLedgerSafe, runLocalModelCouncil } from '../src/room/NoeLocalModelCouncil.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = process.env.NOE_MODEL_UNLOAD_DRILL_OUT_DIR
  ? resolve(process.env.NOE_MODEL_UNLOAD_DRILL_OUT_DIR)
  : join(ROOT, 'output', 'noe-model-unload-recovery-drill');
const NOW = Date.now();
const RUN_ID = new Date(NOW).toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
const ROUND_ID = `model-unloaded-recovery-${RUN_ID}`;

function rel(file) {
  return relative(ROOT, file).replace(/\\/g, '/');
}

function sha256(value) {
  return createHash('sha256').update(String(value || ''), 'utf8').digest('hex');
}

function sameStringArray(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b)) return null;
  const left = [...a].sort();
  const right = [...b].sort();
  return left.length === right.length && left.every((value, i) => value === right[i]);
}

async function loadedSnapshot(label) {
  const fake = process.env.NOE_MODEL_UNLOAD_DRILL_FAKE_LOADED_MODELS;
  if (fake) {
    try {
      const parsed = JSON.parse(fake);
      return {
        label,
        ok: Array.isArray(parsed),
        source: 'env:NOE_MODEL_UNLOAD_DRILL_FAKE_LOADED_MODELS',
        loadedModels: Array.isArray(parsed) ? parsed.map(String) : null,
      };
    } catch (e) {
      return { label, ok: false, source: 'env:NOE_MODEL_UNLOAD_DRILL_FAKE_LOADED_MODELS', error: e?.message || String(e), loadedModels: null };
    }
  }
  const baseUrl = (process.env.LM_STUDIO_BASE_URL || process.env.NOE_LMSTUDIO_URL || 'http://127.0.0.1:1234/v1').replace(/\/+$/, '');
  try {
    const loadedModels = await listLoadedLmStudioModels(baseUrl, { timeoutMs: 3000 });
    return { label, ok: Array.isArray(loadedModels), source: 'lmstudio:/api/v0/models', baseUrl, loadedModels };
  } catch (e) {
    return { label, ok: false, source: 'lmstudio:/api/v0/models', baseUrl, error: e?.message || String(e), loadedModels: null };
  }
}

function jsonResponse(body, ok = true, status = ok ? 200 : 500) {
  return { ok, status, text: async () => JSON.stringify(body) };
}

function parseBody(opts = {}) {
  try { return JSON.parse(opts.body || '{}'); } catch { return {}; }
}

function answerFor(model, prompt = '') {
  if (/成员摘要/.test(prompt)) return `受控模型卸载恢复演练完成：${model} 完成综合，主脑卸载错误已由 backup quorum 接管。`;
  if (/交叉审阅者/.test(prompt)) {
    return JSON.stringify({
      decision: 'approve',
      risks: [],
      evidence_gaps: [],
      accepted_points: ['backup quorum recovered after model_unloaded'],
      confidence: 0.82,
    });
  }
  return JSON.stringify({
    decision: 'approve',
    answer: `${model} backup participant accepted controlled model_unloaded recovery`,
    risks: [],
    evidence_gaps: [],
    actions: ['record model_unloaded issue', 'use backup participant', 'preserve LM Studio loaded state'],
    confidence: 0.86,
  });
}

async function fakeProviderFetch(url, opts = {}) {
  const body = parseBody(opts);
  const model = String(body.model || '');
  const prompt = JSON.stringify(body.messages || []);
  if (String(url).endsWith('/chat/completions')) {
    if (model === NOE_MAIN_BRAIN_MODEL) return jsonResponse({ error: 'Model unloaded.' }, false, 400);
    return jsonResponse({ choices: [{ message: { content: answerFor(model, prompt) } }], usage: { prompt_tokens: 11, completion_tokens: 17 } });
  }
  if (String(url).endsWith('/api/chat')) {
    return jsonResponse({ message: { content: answerFor(model, prompt) }, prompt_eval_count: 7, eval_count: 13 });
  }
  return jsonResponse({ error: 'unexpected fake drill URL' }, false, 404);
}

mkdirSync(OUT_DIR, { recursive: true, mode: 0o700 });
const runDir = join(OUT_DIR, RUN_ID);
mkdirSync(runDir, { recursive: true, mode: 0o700 });

const before = await loadedSnapshot('before');
const discovery = {
  providers: [
    { id: 'lmstudio', available: true, status: 'fake drill provider', modelCount: 2, models: [] },
    { id: 'ollama', available: true, status: 'fake drill provider', modelCount: 2, models: [] },
  ],
  models: [
    { provider: 'lmstudio', id: NOE_MAIN_BRAIN_MODEL, baseUrl: 'http://fake-lmstudio.local/v1', paramB: 35 },
    { provider: 'ollama', id: 'gemma3:4b', baseUrl: 'http://fake-ollama.local', paramB: 4 },
    { provider: 'lmstudio', id: 'benchv3-gemma-4-31b-qat', baseUrl: 'http://fake-lmstudio.local/v1', paramB: 31 },
    { provider: 'ollama', id: 'backup-gemma:9b', baseUrl: 'http://fake-ollama.local', paramB: 9 },
  ],
};

const out = await runLocalModelCouncil({
  goal: '受控模型卸载恢复演练：主脑返回 model_unloaded 后必须用 backup participant 恢复 quorum',
  roundId: ROUND_ID,
  maxParticipants: 2,
  reviewRounds: 1,
}, { root: runDir, fetchImpl: fakeProviderFetch, discovery });

const ledgerPath = join(runDir, out.ledgerPath || '');
const ledger = existsSync(ledgerPath) ? JSON.parse(readFileSync(ledgerPath, 'utf8')) : null;
const ledgerSafe = assertLocalCouncilLedgerSafe(ledger || {});
const after = await loadedSnapshot('after');
const lmStudioStateEqual = sameStringArray(before.loadedModels, after.loadedModels);
const modelUnloadedParticipant = (ledger?.participants || []).find((p) => p?.health?.issue === 'model_unloaded');
const backupParticipants = ledger?.selection?.backupForUnavailable || [];
const unavailableRawRef = modelUnloadedParticipant?.rawOutputRef
  ? join(runDir, modelUnloadedParticipant.rawOutputRef)
  : '';
const unavailableRaw = unavailableRawRef && existsSync(unavailableRawRef) ? readFileSync(unavailableRawRef, 'utf8') : '';

const report = {
  schemaVersion: 1,
  ok: Boolean(
    out.ok
    && ledgerSafe.ok
    && modelUnloadedParticipant
    && backupParticipants.length >= 1
    && ledger?.quorum?.ok === true
    && Number(ledger?.quorum?.availableCount || 0) >= 2
    && lmStudioStateEqual !== false
  ),
  generatedAt: new Date(NOW).toISOString(),
  scenario: 'controlled_model_unloaded_error_recovery',
  realProviderCalls: false,
  fakeProviderCalls: true,
  lmStudioStateReadOnly: true,
  lmStudioLoadUnloadCommandsIssued: false,
  lmStudioLoadUnloadChanged: lmStudioStateEqual === true ? false : null,
  lmStudioSnapshotAvailable: before.ok === true && after.ok === true,
  lmStudioStateEqual,
  loadedModelsBefore: before.loadedModels,
  loadedModelsAfter: after.loadedModels,
  loadedSnapshots: { before, after },
  mainBrainModel: NOE_MAIN_BRAIN_MODEL,
  modelUnloadedDetected: Boolean(modelUnloadedParticipant),
  modelUnloadedModelKey: modelUnloadedParticipant?.modelKey || null,
  modelUnloadedIssue: modelUnloadedParticipant?.health?.issue || null,
  modelUnloadedRawSha256: unavailableRaw ? sha256(unavailableRaw) : null,
  backupParticipantUsed: backupParticipants.length >= 1,
  backupForUnavailable: backupParticipants,
  quorum: ledger?.quorum || null,
  participantHealth: ledger?.modelHealth || [],
  ledgerSafe,
  ledgerPath: rel(ledgerPath),
  roundDir: rel(join(runDir, out.roundDir || '')),
  source: {
    policy: 'fake provider model_unloaded drill; no real chat calls; no lms load/unload; LM Studio state checked read-only before/after',
  },
};

const reportPath = join(runDir, 'report.json');
writeFileSync(reportPath, JSON.stringify(report, null, 2), { mode: 0o600 });
console.log(JSON.stringify({ ...report, reportPath: rel(reportPath) }, null, 2));
if (!report.ok) process.exitCode = 1;
