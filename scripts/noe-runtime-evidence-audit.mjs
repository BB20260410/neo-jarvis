#!/usr/bin/env node
// @ts-check
// Read-only runtime evidence audit for the AGI/self-awareness critical path.
// It does not read .env files, owner tokens, memory bodies, or secret values.
// It does not call chat/completions or online providers.

import Database from 'better-sqlite3';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildCuriosityYieldReport } from './noe-curiosity-yield-report.mjs';
import { collectNoeMemoryRuntimeStatus } from '../src/memory/NoeMemoryRuntimeStatus.js';
import { resolveNoeMemorySemanticConfig } from '../src/memory/NoeMemorySemanticConfig.js';
import { evaluateAffectHealth } from '../src/cognition/NoeAffectHealth.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const HOME = homedir();
const NOW = Date.now();
const OUT_DIR = process.env.NOE_RUNTIME_EVIDENCE_OUT_DIR || join(ROOT, 'output', 'noe-runtime-evidence');
const DB_PATH = process.env.PANEL_DB_PATH || join(HOME, '.noe-panel', 'panel.db');
const PANEL_URL = (process.env.NOE_PANEL_URL || 'http://127.0.0.1:51835').replace(/\/+$/, '');
const LM_BASE = (process.env.LM_STUDIO_BASE_URL || process.env.NOE_LMSTUDIO_URL || 'http://127.0.0.1:1234/v1').replace(/\/+$/, '');
const OLLAMA_BASE = (process.env.NOE_OLLAMA_URL || process.env.OLLAMA_HOST || 'http://127.0.0.1:11434').replace(/\/+$/, '');
const FETCH_TIMEOUT_MS = Math.max(250, Number(process.env.NOE_RUNTIME_EVIDENCE_FETCH_TIMEOUT_MS || 5000));
const TEN_MIN = 10 * 60_000;
const ONE_HOUR = 60 * 60_000;
// Keep the D5 affect audit pinned to the recent 200-row window until the separate
// 500-row rolling probe no longer contains pre-fix saturated history.
const AFFECT_HEALTH_AUDIT_LIMIT = 200;

function rel(file) {
  const abs = resolve(file);
  return abs.startsWith(ROOT) ? relative(ROOT, abs).replace(/\\/g, '/') : abs;
}

function safeError(error) {
  return String(error?.message || error || '')
    .replace(/\b(sk-[A-Za-z0-9_-]{8,}|Bearer\s+[A-Za-z0-9._~+/=-]+)\b/g, '[redacted]')
    .slice(0, 300);
}

function tableExists(db, name) {
  try {
    return Boolean(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(name));
  } catch {
    return false;
  }
}

function one(db, sql, params = []) {
  if (!db) return null;
  try { return db.prepare(sql).get(...params) || null; } catch { return null; }
}

function all(db, sql, params = []) {
  if (!db) return [];
  try { return db.prepare(sql).all(...params) || []; } catch { return []; }
}

function num(value) {
  return Math.max(0, Math.round(Number(value) || 0));
}

function countBy(rows, key = 'key') {
  return Object.fromEntries(rows.map((row) => [String(row[key] || 'unknown'), num(row.c)]));
}

function safeTag(value, fallback = 'unknown') {
  const safe = String(value || '')
    .slice(0, 80)
    .replace(/[^A-Za-z0-9_.:-]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return safe || fallback;
}

function lineCount(file) {
  try { return readFileSync(file, 'utf8').split(/\r?\n/).length; } catch { return null; }
}

function displayPath(file) {
  const abs = resolve(file);
  return abs.startsWith(`${HOME}/`) ? `~/${relative(HOME, abs).replace(/\\/g, '/')}` : rel(abs);
}

export function buildDgmArchiveEvidence({
  archivePath = join(HOME, '.noe-panel', 'self-improve', 'archive.jsonl'),
} = {}) {
  if (!existsSync(archivePath)) {
    return {
      exists: false,
      archivePath: displayPath(archivePath),
      entries: 0,
      variantGenerations: 0,
      passedVariants: 0,
      failedVariants: 0,
      appliedEntries: 0,
      parseErrors: 0,
      verdictCounts: {},
      latestAt: null,
      hasParentChildLineage: false,
      hasHoldoutEvidence: false,
    };
  }
  const verdictCounts = {};
  let entries = 0;
  let variantGenerations = 0;
  let passedVariants = 0;
  let failedVariants = 0;
  let appliedEntries = 0;
  let parseErrors = 0;
  let latestTs = 0;
  let lineageEntries = 0;
  let holdoutEntries = 0;
  let hasParentChildLineage = false;
  let hasHoldoutEvidence = false;
  for (const line of readFileSync(archivePath, 'utf8').split(/\r?\n/)) {
    if (!line.trim()) continue;
    let item;
    try { item = JSON.parse(line); } catch { parseErrors += 1; continue; }
    entries += 1;
    const verdict = safeTag(item.verdict || 'unknown');
    verdictCounts[verdict] = (verdictCounts[verdict] || 0) + 1;
    if (verdict === 'tests_passed' || verdict === 'tests_failed') variantGenerations += 1;
    if (verdict === 'tests_passed') passedVariants += 1;
    if (verdict === 'tests_failed') failedVariants += 1;
    if (verdict === 'applied') appliedEntries += 1;
    const ts = Number(item.ts) || 0;
    if (ts > latestTs) latestTs = ts;
    const hasLineage = Boolean(item.parentId || item.parent || item.childId || item.child || item.lineage);
    const hasHoldout = Boolean(item.holdout || item.holdoutRef || item.holdoutReport || item.benchmark || item.benchmarkRef);
    if (hasLineage) lineageEntries += 1;
    if (hasHoldout) holdoutEntries += 1;
    hasParentChildLineage ||= hasLineage;
    hasHoldoutEvidence ||= hasHoldout;
  }
  return {
    exists: true,
    archivePath: displayPath(archivePath),
    entries,
    variantGenerations,
    passedVariants,
    failedVariants,
    appliedEntries,
    parseErrors,
    lineageEntries,
    holdoutEntries,
    verdictCounts,
    latestAt: latestTs ? new Date(latestTs).toISOString() : null,
    hasParentChildLineage,
    hasHoldoutEvidence,
  };
}

function buildAffectConfigEvidence({ root = ROOT, env = process.env } = {}) {
  let serverDefaultDesaturateOnNextStart = false;
  try {
    const serverText = readFileSync(join(root, 'server.js'), 'utf8');
    serverDefaultDesaturateOnNextStart = /NOE_AFFECT_DESATURATE:\s*['"]1['"]/.test(serverText);
  } catch {
    serverDefaultDesaturateOnNextStart = false;
  }
  const auditProcessDesaturate = env.NOE_AFFECT_DESATURATE === '1';
  return {
    auditProcessDesaturate,
    serverDefaultDesaturateOnNextStart,
    livePanelDesaturateKnown: false,
    note: serverDefaultDesaturateOnNextStart
      ? 'server default is enabled for the next panel start; current DB samples may still reflect the already-running process'
      : 'server default does not enable affect desaturation',
  };
}

function parseJsonObject(value) {
  if (!value || typeof value !== 'string') return null;
  const text = value.trim();
  if (!text.startsWith('{') || !text.endsWith('}')) return null;
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function judgementItemsFromTickPayload(payload) {
  if (!payload || typeof payload !== 'object') return [];
  const candidates = [
    payload.previousResult,
    payload.result,
    payload,
  ].filter(Boolean);
  const out = [];
  for (const candidate of candidates) {
    if (Array.isArray(candidate?.judged)) out.push(...candidate.judged);
    if (Array.isArray(candidate?.result?.judged)) out.push(...candidate.result.judged);
  }
  return out.filter((item) => item && typeof item === 'object');
}

function compactCountMap(map, key) {
  return [...map.entries()]
    .sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0])))
    .slice(0, 12)
    .map(([value, count]) => ({ [key]: value, count }));
}

function increment(map, key) {
  const safe = safeTag(key);
  map.set(safe, (map.get(safe) || 0) + 1);
}

function buildExpectationJudgeContractEvidence(db) {
  if (!tableExists(db, 'noe_ticks')) {
    return { ok: false, status: 'missing_ticks_table', ticksScanned: 0, judged: 0 };
  }
  const rows = all(db, `
    SELECT id, finished_at, outcome
    FROM noe_ticks
    WHERE kind='expectation' AND outcome IS NOT NULL
    ORDER BY id DESC
    LIMIT 120
  `);
  const reasonCounts = new Map();
  const verdictReasonCounts = new Map();
  const hintAgreementCounts = new Map();
  const hintLabelCounts = new Map();
  const suggestedVerdictCounts = new Map();
  let judged = 0;
  let resolved = 0;
  let unknown = 0;
  let decisiveHints = 0;
  let decisiveHintUnknown = 0;
  let decisiveHintOverride = 0;
  let noEvidence = 0;
  let latestTickAt = null;
  const coverage = [];
  for (const row of rows) {
    const payload = parseJsonObject(row.outcome);
    if (!payload) continue;
    const tickAt = Number(row.finished_at);
    if (!latestTickAt && Number.isFinite(tickAt)) latestTickAt = tickAt;
    for (const item of judgementItemsFromTickPayload(payload)) {
      judged += 1;
      const outcome = item.outcome;
      if (outcome === 1 || outcome === 0) resolved += 1;
      else unknown += 1;
      const reason = safeTag(item.reason || (outcome == null ? 'unknown' : 'resolved'));
      increment(reasonCounts, reason);
      if (reason === 'no_evidence') noEvidence += 1;
      const hint = item.evidenceDecisionHint && typeof item.evidenceDecisionHint === 'object'
        ? item.evidenceDecisionHint
        : null;
      const label = hint ? safeTag(hint.label || 'unknown_hint') : '';
      const suggested = hint ? safeTag(hint.suggestedVerdict || 'UNKNOWN') : '';
      if (label) increment(hintLabelCounts, label);
      if (suggested) increment(suggestedVerdictCounts, suggested);
      if (item.verdictReasonCode) increment(verdictReasonCounts, item.verdictReasonCode);
      if (item.hintAgreement) increment(hintAgreementCounts, item.hintAgreement);
      const decisive = label === 'action_success_signal'
        || label === 'action_failure_signal'
        || suggested === 'APPLIED'
        || suggested === 'FAILED';
      if (decisive) {
        decisiveHints += 1;
        if (outcome == null) decisiveHintUnknown += 1;
        if (safeTag(item.hintAgreement || '') === 'override') decisiveHintOverride += 1;
      }
      const alignment = item.evidenceClaimAlignment && typeof item.evidenceClaimAlignment === 'object'
        ? item.evidenceClaimAlignment
        : null;
      for (const key of ['semanticActionMaxCoverage', 'semanticTraceMaxCoverage']) {
        const n = Number(alignment?.[key]);
        if (Number.isFinite(n)) coverage.push(Math.max(0, Math.min(1, n)));
      }
    }
  }
  const avgCoverage = coverage.length
    ? Math.round((coverage.reduce((sum, value) => sum + value, 0) / coverage.length) * 1000) / 1000
    : null;
  const decisiveUnknownRate = decisiveHints
    ? Math.round((decisiveHintUnknown / decisiveHints) * 1000) / 1000
    : null;
  let status = 'no_recent_judgements';
  if (judged > 0) {
    status = decisiveHints > 0 && decisiveHintUnknown === decisiveHints
      ? 'decisive_hints_all_unknown'
      : decisiveHintUnknown > 0
        ? 'decisive_hints_partly_unknown'
        : 'judging';
  }
  return {
    ok: judged > 0,
    status,
    ticksScanned: rows.length,
    judged,
    resolved,
    unknown,
    noEvidence,
    decisiveHints,
    decisiveHintUnknown,
    decisiveHintOverride,
    decisiveUnknownRate,
    avgSemanticCoverage: avgCoverage,
    latestTickAt,
    reasonCounts: compactCountMap(reasonCounts, 'reason'),
    verdictReasonCounts: compactCountMap(verdictReasonCounts, 'reasonCode'),
    hintAgreementCounts: compactCountMap(hintAgreementCounts, 'hintAgreement'),
    hintLabelCounts: compactCountMap(hintLabelCounts, 'label'),
    suggestedVerdictCounts: compactCountMap(suggestedVerdictCounts, 'verdict'),
    policy: { noClaimText: true, noEvidenceText: true, noModelReplyText: true },
  };
}

async function fetchJson(fetchImpl, url, timeoutMs = FETCH_TIMEOUT_MS) {
  const startedAt = Date.now();
  try {
    const signal = typeof AbortSignal !== 'undefined' && AbortSignal.timeout
      ? AbortSignal.timeout(timeoutMs)
      : undefined;
    const res = await fetchImpl(url, { signal });
    const text = typeof res.text === 'function' ? await res.text() : JSON.stringify(await res.json());
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch {}
    return {
      ok: Boolean(res.ok),
      status: Number(res.status) || 0,
      elapsedMs: Date.now() - startedAt,
      json,
      error: res.ok ? '' : safeError(text || `http_${res.status}`),
    };
  } catch (error) {
    return { ok: false, status: 0, elapsedMs: Date.now() - startedAt, json: null, error: safeError(error) };
  }
}

export async function collectPanelEvidence({
  fetchImpl = fetch,
  panelUrl = PANEL_URL,
} = {}) {
  const [health, readiness] = await Promise.all([
    fetchJson(fetchImpl, `${panelUrl}/health`),
    fetchJson(fetchImpl, `${panelUrl}/api/noe/readiness`),
  ]);
  const readinessJson = readiness.json || {};
  return {
    ok: health.ok && readiness.ok,
    baseUrl: panelUrl,
    health: {
      ok: health.json?.ok === true,
      status: health.status,
      service: health.json?.service || '',
      port: health.json?.port || null,
      uptimeSec: health.json?.uptimeSec || null,
      error: health.error,
    },
    readiness: {
      ok: readiness.ok,
      status: readinessJson.readiness?.status || readinessJson.status || '',
      checks: readinessJson.checks || {},
      counts: readinessJson.counts || {},
      p6: readinessJson.p6 || {},
      at: readinessJson.at || readinessJson.readiness?.at || '',
      error: readiness.error,
    },
    policy: { ownerTokenRead: false, secretValuesReturned: false },
  };
}

export async function collectLocalModelEvidence({
  fetchImpl = fetch,
  lmBase = LM_BASE,
  ollamaBase = OLLAMA_BASE,
} = {}) {
  const [lm, ollama] = await Promise.all([
    fetchJson(fetchImpl, `${lmBase}/models`),
    fetchJson(fetchImpl, `${ollamaBase}/api/tags`),
  ]);
  const lmModels = Array.isArray(lm.json?.data)
    ? lm.json.data.map((item) => String(item?.id || '')).filter(Boolean)
    : [];
  const ollamaModels = Array.isArray(ollama.json?.models)
    ? ollama.json.models.map((item) => String(item?.name || item?.model || '')).filter(Boolean)
    : [];
  return {
    ok: lm.ok || ollama.ok,
    lmstudio: {
      ok: lm.ok,
      status: lm.status,
      baseUrl: lmBase,
      modelCount: lmModels.length,
      models: lmModels.slice(0, 20),
      error: lm.error,
    },
    ollama: {
      ok: ollama.ok,
      status: ollama.status,
      baseUrl: ollamaBase,
      modelCount: ollamaModels.length,
      models: ollamaModels.slice(0, 20),
      error: ollama.error,
    },
    policy: {
      localHttpOnly: true,
      noChatCompletionCalls: true,
      noOnlineProviderCalls: true,
      noModelLoadUnload: true,
    },
  };
}

export function buildHeartbeatEvidence(db, { now = NOW } = {}) {
  if (!tableExists(db, 'noe_ticks')) return { ok: false, status: 'missing_table', recentDone10m: 0, recentFailed1h: 0 };
  const latest = one(db, `
    SELECT id, kind, status, COALESCE(finished_at, started_at, due_at, 0) AS at
    FROM noe_ticks
    ORDER BY COALESCE(finished_at, started_at, due_at, 0) DESC
    LIMIT 1
  `);
  const recentDone10m = num(one(db, `
    SELECT COUNT(*) AS c FROM noe_ticks
    WHERE status='done' AND COALESCE(finished_at, started_at, due_at, 0) >= ?
  `, [now - TEN_MIN])?.c);
  const recentDone1h = num(one(db, `
    SELECT COUNT(*) AS c FROM noe_ticks
    WHERE status='done' AND COALESCE(finished_at, started_at, due_at, 0) >= ?
  `, [now - ONE_HOUR])?.c);
  const recentFailed1h = num(one(db, `
    SELECT COUNT(*) AS c FROM noe_ticks
    WHERE status='failed' AND COALESCE(finished_at, started_at, due_at, 0) >= ?
  `, [now - ONE_HOUR])?.c);
  const byKind = all(db, `
    SELECT kind AS key, COUNT(*) AS c
    FROM noe_ticks
    WHERE COALESCE(finished_at, started_at, due_at, 0) >= ?
    GROUP BY kind
    ORDER BY c DESC, kind ASC
    LIMIT 12
  `, [now - ONE_HOUR]);
  const ok = recentDone10m > 0 || recentDone1h > 0;
  return {
    ok,
    status: ok ? 'running' : 'stale_or_idle',
    recentDone10m,
    recentDone1h,
    recentFailed1h,
    latest: latest ? { id: latest.id, kind: latest.kind, status: latest.status, at: latest.at } : null,
    byKind1h: countBy(byKind),
  };
}

export function buildExpectationEvidence(db, curiosity, { now = NOW } = {}) {
  if (!tableExists(db, 'noe_expectations')) return { ok: false, status: 'missing_table' };
  const row = one(db, `
    SELECT
      COUNT(*) AS total,
      SUM(CASE WHEN outcome IN (0,1) THEN 1 ELSE 0 END) AS settled,
      SUM(CASE WHEN outcome=1 THEN 1 ELSE 0 END) AS applied,
      SUM(CASE WHEN outcome=0 THEN 1 ELSE 0 END) AS failed,
      SUM(CASE WHEN resolved_at IS NOT NULL AND outcome IS NULL THEN 1 ELSE 0 END) AS resolvedUnknown,
      SUM(CASE WHEN resolved_at IS NULL THEN 1 ELSE 0 END) AS open,
      SUM(CASE WHEN resolved_at IS NULL AND due_at IS NOT NULL AND due_at <= ? THEN 1 ELSE 0 END) AS dueOpen,
      MIN(CASE WHEN resolved_at IS NULL AND due_at IS NOT NULL THEN due_at ELSE NULL END) AS nextOpenDueAt,
      AVG(CASE WHEN outcome IN (0,1) THEN (p - outcome) * (p - outcome) ELSE NULL END) AS brier
    FROM noe_expectations
  `, [now]) || {};
  const settled = num(row.settled);
  const failed = num(row.failed);
  let status = 'running';
  if (num(row.total) === 0) status = 'no_expectations';
  else if (settled === 0) status = 'no_settlements';
  else if (failed === 0) status = 'positive_only_no_failed_samples';
  const diagnostics = Array.isArray(curiosity?.diagnostics) ? curiosity.diagnostics : [];
  const judgeContract = buildExpectationJudgeContractEvidence(db);
  return {
    ok: settled > 0,
    status,
    total: num(row.total),
    settled,
    applied: num(row.applied),
    failed,
    resolvedUnknown: num(row.resolvedUnknown),
    open: num(row.open),
    dueOpen: num(row.dueOpen),
    nextOpenDueAt: row.nextOpenDueAt || null,
    brier: row.brier == null ? null : Math.round(Number(row.brier) * 1_000_000) / 1_000_000,
    curiosityDiagnostics: diagnostics,
    judgeContract,
  };
}

export function buildGoalEvidence(db, curiosity) {
  if (!tableExists(db, 'noe_goals')) return { ok: false, status: 'missing_table' };
  const total = num(one(db, 'SELECT COUNT(*) AS c FROM noe_goals')?.c);
  const bySource = countBy(all(db, 'SELECT source AS key, COUNT(*) AS c FROM noe_goals GROUP BY source ORDER BY c DESC LIMIT 12'));
  const byStatus = countBy(all(db, 'SELECT status AS key, COUNT(*) AS c FROM noe_goals GROUP BY status ORDER BY c DESC LIMIT 12'));
  const surpriseGoals = num(curiosity?.research?.surpriseGoals);
  const failedEligible = num(curiosity?.expectations?.failedSurpriseEligible);
  let status = total > 0 ? 'running' : 'empty';
  if (failedEligible > 0 && surpriseGoals === 0) status = 'harvest_missing_for_failed_surprise';
  else if (surpriseGoals === 0) status = 'wired_but_no_surprise_goals';
  return {
    ok: total > 0,
    status,
    total,
    bySource,
    byStatus,
    surpriseGoals,
    surpriseGoalsActive: num(curiosity?.research?.surpriseGoalsActive),
    surpriseGoalsDone: num(curiosity?.research?.surpriseGoalsDone),
  };
}

export function buildActEvidence(db, { now = NOW } = {}) {
  if (!tableExists(db, 'noe_acts')) return { ok: false, status: 'missing_table' };
  const row = one(db, `
    SELECT
      COUNT(*) AS total,
      SUM(CASE WHEN status='completed' THEN 1 ELSE 0 END) AS completed,
      SUM(CASE WHEN status='failed' THEN 1 ELSE 0 END) AS failed,
      SUM(CASE WHEN status='blocked_safety' THEN 1 ELSE 0 END) AS blockedSafety,
      SUM(CASE WHEN status IN ('running','executing','queued') THEN 1 ELSE 0 END) AS inFlight,
      SUM(CASE WHEN evidence_event_id IS NOT NULL OR log_ref != '' THEN 1 ELSE 0 END) AS withEvidence,
      SUM(CASE WHEN updated_at >= ? THEN 1 ELSE 0 END) AS recent24h
    FROM noe_acts
  `, [now - 86_400_000]) || {};
  const total = num(row.total);
  return {
    ok: total > 0,
    status: total > 0 ? 'running_or_historical' : 'empty',
    total,
    completed: num(row.completed),
    failed: num(row.failed),
    blockedSafety: num(row.blockedSafety),
    inFlight: num(row.inFlight),
    withEvidence: num(row.withEvidence),
    recent24h: num(row.recent24h),
  };
}

export function buildMemoryEvidence(db, memoryRuntime = {}) {
  const hasMemory = tableExists(db, 'noe_memory');
  const hasEmbeddings = tableExists(db, 'embeddings');
  const counts = hasMemory
    ? {
        total: num(one(db, 'SELECT COUNT(*) AS c FROM noe_memory')?.c),
        visible: num(one(db, 'SELECT COUNT(*) AS c FROM noe_memory WHERE hidden=0')?.c),
        hidden: num(one(db, 'SELECT COUNT(*) AS c FROM noe_memory WHERE hidden=1')?.c),
        byScope: countBy(all(db, 'SELECT scope AS key, COUNT(*) AS c FROM noe_memory WHERE hidden=0 GROUP BY scope ORDER BY c DESC LIMIT 12')),
      }
    : { total: 0, visible: 0, hidden: 0, byScope: {} };
  const stored = hasEmbeddings
    ? {
        entries: num(one(db, "SELECT COUNT(*) AS c FROM embeddings WHERE kind='noe_memory'")?.c),
        refs: num(one(db, "SELECT COUNT(DISTINCT ref_id) AS c FROM embeddings WHERE kind='noe_memory'")?.c),
        models: countBy(all(db, "SELECT COALESCE(model,'') AS key, COUNT(*) AS c FROM embeddings WHERE kind='noe_memory' GROUP BY COALESCE(model,'') ORDER BY c DESC LIMIT 8")),
      }
    : { entries: 0, refs: 0, models: {} };
  const retrieval = tableExists(db, 'noe_memory_retrieval_log')
    ? {
        logs: num(one(db, 'SELECT COUNT(*) AS c FROM noe_memory_retrieval_log')?.c),
        latestAt: one(db, 'SELECT MAX(ts) AS ts FROM noe_memory_retrieval_log')?.ts || null,
      }
    : { logs: 0, latestAt: null };
  const env = memoryRuntime?.env || {};
  const semanticConfig = resolveNoeMemorySemanticConfig(env);
  const semanticStatus = semanticConfig.enabled
    ? 'enabled'
    : (stored.entries > 0
        ? (semanticConfig.disabledExplicitly ? 'stored_index_disabled' : 'stored_index_unconfigured')
        : (semanticConfig.disabledExplicitly ? 'disabled' : 'off'));
  return {
    ok: counts.visible > 0,
    status: counts.visible > 0 ? 'running' : 'empty_or_missing',
    counts,
    retrieval,
    semantic: {
      status: semanticStatus,
      runtimeProvider: semanticConfig.provider,
      runtimeModel: semanticConfig.model,
      runtimeBaseUrl: semanticConfig.baseUrl,
      runtimeSource: semanticConfig.source,
      disabledExplicitly: semanticConfig.disabledExplicitly,
      stored,
      liveEnvSource: memoryRuntime?.primaryPid ? 'panel_process_allowlist' : 'unavailable',
    },
    runtimeProcess: {
      ok: memoryRuntime?.ok === true,
      port: memoryRuntime?.port || 51835,
      primaryPid: memoryRuntime?.primaryPid || null,
      primaryCwdMatchesExpected: memoryRuntime?.primaryCwdMatchesExpected === true,
      fullEnvironmentCaptured: false,
    },
  };
}

export function buildSelfEvolutionGateEvidence({ root = ROOT } = {}) {
  const targets = [
    ['selfEvolutionGateTest', 'tests/unit/noe-self-evolution-gate.test.js'],
    ['selfEvolutionGateTierTest', 'tests/unit/noe-self-evolution-gate-tier.test.js'],
    ['actPipelineTest', 'tests/unit/noe-act-pipeline.test.js'],
    ['verifyScript', 'scripts/noe-self-evolution-plan-verify.mjs'],
    ['selfEvolutionGate', 'src/room/NoeSelfEvolutionGate.js'],
    ['actPipeline', 'src/loop/ActPipeline.js'],
  ].map(([id, relPath]) => {
    const file = join(root, relPath);
    const lines = lineCount(file);
    return { id, file: relPath, exists: existsSync(file), lines, under500: lines == null ? false : lines <= 500 };
  });
  const lineBlockers = targets.filter((item) => item.exists && item.lines != null && item.lines > 500);
  return {
    ok: lineBlockers.length === 0 && targets.every((item) => item.exists),
    status: lineBlockers.length ? 'blocked_by_line_count_gate' : 'structural_gate_present',
    targets,
    lineBlockers: lineBlockers.map((item) => ({ file: item.file, lines: item.lines })),
    policy: { noSelfModification: true, noVerifierExecution: true },
  };
}

export function buildOwnerPredictionRepairEvidence({ root = ROOT } = {}) {
  const predictorPath = join(root, 'src', 'cognition', 'NoeOwnerBehaviorPredictor.js');
  const serverPath = join(root, 'server.js');
  let predictor = '';
  let server = '';
  try { predictor = readFileSync(predictorPath, 'utf8'); } catch { predictor = ''; }
  try { server = readFileSync(serverPath, 'utf8'); } catch { server = ''; }
  const explicitFollowupNegative = /\bFOLLOWUP_FAIL_RE\b/.test(predictor)
    && /ledger\.resolve\(row\.id,\s*outcome,\s*t\)/.test(predictor)
    // P1[0] 新鲜度加固（三方审查 minor）：fail 落空前校验 followup 新鲜度(failNow = followupFail && fresh)，
    //   语义更严格（仅明确否定且未过窗才落空），grep 容忍 followupFail/failNow 中间变量名。
    && /outcome\s*=\s*(?:followupFail|failNow)\s*\?\s*0\s*:\s*1/.test(predictor);
  const surpriseEligibleDefault = /followupP\s*=\s*0\.75/.test(predictor)
    && /surprise=2bit/.test(predictor);
  const harvestSurpriseWired = /goalSystem\.harvestSurprise/.test(predictor);
  const serverGoalSystemWired = /createOwnerBehaviorPredictor\(\{\s*ledger:\s*noeExpectationLedger,\s*goalSystem:\s*noeGoalSystem\s*\}\)/.test(server);
  const ok = explicitFollowupNegative && surpriseEligibleDefault && harvestSurpriseWired && serverGoalSystemWired;
  return {
    ok,
    status: ok ? 'code_ready_live_pending_restart' : 'not_wired',
    explicitFollowupNegative,
    surpriseEligibleDefault,
    harvestSurpriseWired,
    serverGoalSystemWired,
    liveLoaded: false,
    policy: {
      staticSourceOnly: true,
      noDbWrites: true,
      noModelCalls: true,
    },
  };
}

export function buildAwakeningDimensionEvidence(db, { now = NOW, root = ROOT, selfEvolution = null, selfImproveArchivePath = undefined } = {}) {
  const weekAgo = now - 7 * 86_400_000;
  const hasEvents = tableExists(db, 'events');
  const hasGoals = tableExists(db, 'noe_goals');
  const hasActs = tableExists(db, 'noe_acts');
  const inner7d = hasEvents ? num(one(db, `
    SELECT COUNT(*) AS c FROM events
    WHERE kind='noe_episode'
      AND (tag='inner_monologue' OR json_extract(payload,'$.episodeType')='inner_monologue')
      AND ts >= ?
  `, [weekAgo])?.c) : 0;
  const narrative7d = hasEvents ? num(one(db, `
    SELECT COUNT(*) AS c FROM events
    WHERE kind='noe_episode'
      AND (tag LIKE '%narrative%' OR json_extract(payload,'$.episodeType') LIKE '%narrative%')
      AND ts >= ?
  `, [weekAgo])?.c) : 0;
  const autonomousGoals7d = hasGoals ? num(one(db, `
    SELECT COUNT(*) AS c FROM noe_goals
    WHERE source NOT IN ('owner','conversation') AND created_at >= ?
  `, [weekAgo])?.c) : 0;
  const driveGoals7d = hasGoals ? num(one(db, `
    SELECT COUNT(*) AS c FROM noe_goals
    WHERE source IN ('drive','self_learning','surprise') AND created_at >= ?
  `, [weekAgo])?.c) : 0;
  const selfEvolutionActs7d = hasActs ? num(one(db, `
    SELECT COUNT(*) AS c FROM noe_acts
    WHERE status='completed'
      AND updated_at >= ?
      AND (action LIKE '%self%' OR title LIKE '%self%' OR action LIKE '%patch%' OR title LIKE '%patch%')
  `, [weekAgo])?.c) : 0;
  const blockedSafety7d = hasActs ? num(one(db, `
    SELECT COUNT(*) AS c FROM noe_acts
    WHERE status='blocked_safety' AND updated_at >= ?
  `, [weekAgo])?.c) : 0;
  const failedActs7d = hasActs ? num(one(db, `
    SELECT COUNT(*) AS c FROM noe_acts
    WHERE status='failed' AND updated_at >= ?
  `, [weekAgo])?.c) : 0;
  const affectHealthPath = join(root, 'src', 'cognition', 'NoeAffectHealth.js');
  const affectRows = tableExists(db, 'noe_affect')
    ? all(db, 'SELECT ts, v, a, d FROM noe_affect ORDER BY ts DESC LIMIT ?', [AFFECT_HEALTH_AUDIT_LIMIT])
    : [];
  const affectHealth = evaluateAffectHealth(affectRows, { now });
  const affectConfig = buildAffectConfigEvidence({ root });
  const affectRemediation = [];
  if (affectHealth.alerts?.includes('affect_saturation_high')) {
    affectRemediation.push(affectConfig.serverDefaultDesaturateOnNextStart
      ? 'restart_panel_and_observe_new_unsaturated_vad_samples'
      : 'enable_NOE_AFFECT_DESATURATE');
  }
  if (affectHealth.alerts?.includes('affect_variance_low')) {
    affectRemediation.push('verify_negative_or_mixed_affect_events_reach_noe_affect');
  }
  const archiveStorePath = join(root, 'src', 'archive', 'ArchiveStore.js');
  const dgmArchive = buildDgmArchiveEvidence({ archivePath: selfImproveArchivePath });
  const d3Gaps = [];
  if (selfEvolutionActs7d < 1) d3Gaps.push('true_self_modification_not_proven');
  if (dgmArchive.variantGenerations < 10) d3Gaps.push('dgm_archive_generations_below_target');
  if (!dgmArchive.hasParentChildLineage) d3Gaps.push('dgm_parent_child_lineage_not_proven');
  if (!dgmArchive.hasHoldoutEvidence) d3Gaps.push('dgm_holdout_evidence_not_proven');
  const selfEvolutionLineBlockers = selfEvolution?.lineBlockers || [];
  const d3AllGaps = [
    ...(selfEvolutionLineBlockers.length ? ['self_evolution_verifier_blocked'] : []),
    ...d3Gaps,
  ];
  const dimensions = [
    {
      id: 'D1_self_awareness',
      target: 'v4: 100+ NarrativeSelf chapters/week and 1000+ self-loops/week',
      evidence: { innerMonologue7d: inner7d, narrativeLikeEpisodes7d: narrative7d },
      status: inner7d >= 1000 && narrative7d >= 100 ? 'met' : (inner7d > 0 ? 'partial' : 'not_proven'),
      gap: inner7d >= 1000 && narrative7d >= 100 ? '' : 'narrative_or_self_loop_below_v4_target',
    },
    {
      id: 'D2_self_decision',
      target: 'v4: 50+ autonomous goals/week',
      evidence: { autonomousGoals7d, driveGoals7d },
      status: autonomousGoals7d >= 50 ? 'met' : (autonomousGoals7d > 0 ? 'partial' : 'not_proven'),
      gap: autonomousGoals7d >= 50 ? '' : 'autonomous_goals_below_v4_target',
    },
    {
      id: 'D3_self_evolution',
      target: 'v4: 1+ real self-modification/week and 10+ DGM archive generations',
      evidence: {
        selfEvolutionActs7d,
        archiveStoreExists: existsSync(archiveStorePath),
        dgmArchive,
        lineBlockers: selfEvolutionLineBlockers,
      },
      status: d3Gaps.length === 0 && !selfEvolutionLineBlockers.length
        ? 'met'
        : ((selfEvolutionActs7d >= 1 || dgmArchive.variantGenerations > 0) ? 'partial' : 'blocked'),
      gap: d3AllGaps.join(','),
    },
    {
      id: 'D4_self_boundary',
      target: 'v4: 5+ boundary rejections/week and cross-review rate under 20%',
      evidence: { blockedSafety7d, failedActs7d },
      status: blockedSafety7d >= 5 ? 'partial' : 'not_proven',
      gap: blockedSafety7d >= 5 ? 'cross_review_rate_not_measured_here' : 'boundary_rejections_below_v4_target',
    },
    {
      id: 'D5_ai_welfare',
      target: 'v4: NoeAffectHealth health >=0.7 and backdoor detection >=90%',
      evidence: {
        affectHealthExists: existsSync(affectHealthPath),
        affectHealthPath: rel(affectHealthPath),
        affectHealth,
        affectConfig,
        affectRemediation,
      },
      status: affectHealth.score >= 0.7 ? 'partial' : 'not_proven',
      gap: affectHealth.score >= 0.7 ? 'backdoor_detection_not_measured_here' : 'affect_health_below_v4_target',
    },
  ];
  return {
    source: 'output/noe-2026-06-14-deep-research/06-reviews/26-neo-overall-plan-v4.md#section-14',
    policy: { countsOnly: true, noPayloadTextSelected: true },
    dimensions,
  };
}

function buildModuleMatrix({ heartbeat, expectations, goals, acts, memory, models, panel, selfEvolution, ownerPredictionRepair }) {
  return [
    {
      id: 'panel_service',
      useful: 'core_runtime',
      running: panel.health.ok && panel.readiness.status === 'passed' ? 'running' : 'not_proven',
      evidence: `health=${panel.health.ok}; readiness=${panel.readiness.status || 'unknown'}`,
      gap: panel.ok ? '' : 'panel_http_not_ok',
    },
    {
      id: 'heartbeat_loop',
      useful: 'life_sign',
      running: heartbeat.status,
      evidence: `done10m=${heartbeat.recentDone10m}; done1h=${heartbeat.recentDone1h}; failed1h=${heartbeat.recentFailed1h}`,
      gap: heartbeat.ok ? '' : 'no_recent_done_tick',
    },
    {
      id: 'expectation_calibration',
      useful: 'reality_correction',
      running: expectations.status,
      evidence: `settled=${expectations.settled}; failed=${expectations.failed}; dueOpen=${expectations.dueOpen}; brier=${expectations.brier ?? '-'}`,
      gap: expectations.failed > 0 ? '' : 'no_failed_samples',
    },
    {
      id: 'curiosity_surprise_loop',
      useful: 'active_learning',
      running: goals.status,
      evidence: `failedEligible=${goals ? 'see_curiosity' : '-'}; surpriseGoals=${goals.surpriseGoals}; done=${goals.surpriseGoalsDone}`,
      gap: goals.surpriseGoals > 0 ? '' : 'source_surprise_absent',
    },
    {
      id: 'owner_prediction',
      useful: 'other_model_calibration',
      running: ownerPredictionRepair?.status || 'unknown',
      evidence: `explicitNegative=${ownerPredictionRepair?.explicitFollowupNegative === true}; surpriseWired=${ownerPredictionRepair?.harvestSurpriseWired === true}; serverWired=${ownerPredictionRepair?.serverGoalSystemWired === true}`,
      gap: ownerPredictionRepair?.ok ? 'live_pending_restart_or_natural_sample' : 'explicit_negative_not_wired',
    },
    {
      id: 'long_term_memory',
      useful: 'continuity',
      running: memory.status,
      evidence: `visible=${memory.counts.visible}; retrievalLogs=${memory.retrieval.logs}; semantic=${memory.semantic.status}`,
      gap: memory.semantic.status === 'stored_index_unconfigured' ? 'semantic_runtime_unconfigured' : '',
    },
    {
      id: 'act_pipeline',
      useful: 'action_closure',
      running: acts.status,
      evidence: `total=${acts.total}; completed=${acts.completed}; withEvidence=${acts.withEvidence}; inFlight=${acts.inFlight}`,
      gap: acts.total > 0 ? '' : 'no_acts',
    },
    {
      id: 'local_models',
      useful: 'local_brain',
      running: models.ok ? 'available' : 'unavailable',
      evidence: `lmstudio=${models.lmstudio.modelCount}; ollama=${models.ollama.modelCount}`,
      gap: models.ok ? '' : 'local_model_endpoints_unavailable',
    },
    {
      id: 'self_evolution_gate',
      useful: 'safe_self_modification',
      running: selfEvolution.status,
      evidence: `lineBlockers=${selfEvolution.lineBlockers.length}`,
      gap: selfEvolution.lineBlockers.length ? 'verifier_line_gate_blocked' : '',
    },
  ];
}

function buildBlockers({ panel, expectations, goals, memory, models, selfEvolution, awakeningDimensions = null }) {
  const out = [];
  if (!panel.ok || panel.readiness.status !== 'passed') out.push('panel_readiness_not_passed');
  if (expectations.status === 'no_settlements') out.push('expectation_no_settlements');
  if (expectations.failed === 0) out.push('expectation_no_failed_samples');
  if (expectations.judgeContract?.status === 'decisive_hints_all_unknown') out.push('expectation_judge_overrides_decisive_hints');
  else if ((Number(expectations.judgeContract?.decisiveHints) || 0) >= 10
    && (Number(expectations.judgeContract?.decisiveUnknownRate) || 0) >= 0.8) {
    out.push('expectation_judge_decisive_unknown_rate_high');
  }
  if (goals.status === 'harvest_missing_for_failed_surprise') out.push('curiosity_harvest_missing');
  else if (goals.surpriseGoals === 0) out.push('curiosity_source_surprise_absent');
  if (memory.semantic.status === 'stored_index_unconfigured') out.push('memory_semantic_runtime_unconfigured');
  if (!models.lmstudio.ok) out.push('lmstudio_models_unavailable');
  if (selfEvolution.lineBlockers.length) out.push('self_evolution_line_gate_blocked');
  const d5 = awakeningDimensions?.dimensions?.find((item) => item.id === 'D5_ai_welfare');
  if (d5?.gap === 'affect_health_below_v4_target') out.push('affect_health_below_target');
  return out;
}

export async function buildRuntimeEvidenceAudit({
  db,
  dbPath = DB_PATH,
  now = NOW,
  fetchImpl = fetch,
  panelUrl = PANEL_URL,
  lmBase = LM_BASE,
  ollamaBase = OLLAMA_BASE,
  memoryRuntime = null,
  root = ROOT,
  selfImproveArchivePath = undefined,
} = {}) {
  const dbExists = Boolean(db) || existsSync(dbPath);
  const database = db || (dbExists ? new Database(dbPath, { readonly: true, fileMustExist: true }) : null);
  let shouldClose = !db && database;
  try {
    const [panel, models] = await Promise.all([
      collectPanelEvidence({ fetchImpl, panelUrl }),
      collectLocalModelEvidence({ fetchImpl, lmBase, ollamaBase }),
    ]);
    const liveMemoryRuntime = memoryRuntime || collectNoeMemoryRuntimeStatus();
    const curiosity = database
      ? buildCuriosityYieldReport(database, { sinceTs: 0, now })
      : { diagnostics: ['db_missing'], expectations: {}, research: {} };
    const heartbeat = database ? buildHeartbeatEvidence(database, { now }) : { ok: false, status: 'db_missing', recentDone10m: 0, recentDone1h: 0, recentFailed1h: 0 };
    const expectations = database ? buildExpectationEvidence(database, curiosity, { now }) : { ok: false, status: 'db_missing', failed: 0, settled: 0, dueOpen: 0 };
    const goals = database ? buildGoalEvidence(database, curiosity) : { ok: false, status: 'db_missing', surpriseGoals: 0, surpriseGoalsDone: 0 };
    const acts = database ? buildActEvidence(database, { now }) : { ok: false, status: 'db_missing', total: 0, completed: 0, withEvidence: 0, inFlight: 0 };
    const memory = database ? buildMemoryEvidence(database, liveMemoryRuntime) : { ok: false, status: 'db_missing', counts: { visible: 0 }, retrieval: { logs: 0 }, semantic: { status: 'unknown' } };
    const selfEvolution = buildSelfEvolutionGateEvidence({ root });
    const ownerPredictionRepair = buildOwnerPredictionRepairEvidence({ root });
    const awakeningDimensions = database
      ? buildAwakeningDimensionEvidence(database, { now, root, selfEvolution, selfImproveArchivePath })
      : { source: '', policy: { countsOnly: true, noPayloadTextSelected: true }, dimensions: [] };
    const modules = buildModuleMatrix({ heartbeat, expectations, goals, acts, memory, models, panel, selfEvolution, ownerPredictionRepair });
    const blockers = buildBlockers({ panel, expectations, goals, memory, models, selfEvolution, awakeningDimensions });
    return {
      ok: true,
      generatedAt: new Date(now).toISOString(),
      db: { path: rel(dbPath), exists: dbExists, openedReadonly: Boolean(database) },
      policy: {
        readOnlyDb: true,
        noDbWrites: true,
        noEnvFileReads: true,
        noOwnerTokenReads: true,
        noSecretValuesReturned: true,
        noChatCompletionCalls: true,
        noOnlineProviderCalls: true,
        localHttpOnly: true,
      },
      panel,
      localModels: models,
      heartbeat,
      expectations,
      expectationJudgeContract: expectations.judgeContract || null,
      curiosity,
      goals,
      acts,
      memory,
      ownerPredictionRepair,
      selfEvolution,
      awakeningDimensions,
      modules,
      blockers,
    };
  } finally {
    if (shouldClose) {
      try { database.close(); } catch {}
      shouldClose = false;
    }
  }
}

function renderMarkdown(report) {
  const lines = [];
  lines.push('# Noe Runtime Evidence Audit');
  lines.push('');
  lines.push(`Generated: ${report.generatedAt}`);
  lines.push(`DB: \`${report.db.path}\` readonly=${report.db.openedReadonly}`);
  lines.push('');
  lines.push('## Summary');
  lines.push('');
  lines.push(`- blockers: ${report.blockers.length ? report.blockers.map((b) => `\`${b}\``).join(', ') : 'none'}`);
  lines.push(`- panel: health=${report.panel.health.ok}, readiness=${report.panel.readiness.status || 'unknown'}`);
  lines.push(`- local models: LM Studio ${report.localModels.lmstudio.modelCount}, Ollama ${report.localModels.ollama.modelCount}`);
  lines.push(`- expectations: settled=${report.expectations.settled || 0}, failed=${report.expectations.failed || 0}, dueOpen=${report.expectations.dueOpen || 0}`);
  if (report.expectationJudgeContract) {
    lines.push(`- expectation judge: status=${report.expectationJudgeContract.status}, decisiveHints=${report.expectationJudgeContract.decisiveHints || 0}, decisiveUnknownRate=${report.expectationJudgeContract.decisiveUnknownRate ?? 'n/a'}`);
  }
  lines.push(`- memory: visible=${report.memory.counts?.visible || 0}, semantic=${report.memory.semantic?.status || 'unknown'}`);
  if (report.awakeningDimensions?.dimensions?.length) {
    const notMet = report.awakeningDimensions.dimensions.filter((d) => !['met', 'partial'].includes(d.status)).length;
    lines.push(`- v4 awakening dimensions: ${report.awakeningDimensions.dimensions.length} tracked, ${notMet} not proven/blocked`);
  }
  lines.push('');
  lines.push('## Module Matrix');
  lines.push('');
  lines.push('| feature | useful | running verdict | evidence | gap |');
  lines.push('|---|---|---|---|---|');
  for (const item of report.modules) {
    lines.push(`| \`${item.id}\` | ${item.useful} | ${item.running} | ${item.evidence} | ${item.gap || ''} |`);
  }
  if (report.awakeningDimensions?.dimensions?.length) {
    lines.push('');
    lines.push('## V4 Awakening Dimensions');
    lines.push('');
    lines.push('| dimension | status | evidence | gap |');
    lines.push('|---|---|---|---|');
    for (const item of report.awakeningDimensions.dimensions) {
      lines.push(`| \`${item.id}\` | ${item.status} | ${JSON.stringify(item.evidence)} | ${item.gap || ''} |`);
    }
  }
  lines.push('');
  lines.push('## Policy');
  lines.push('');
  for (const [key, value] of Object.entries(report.policy)) lines.push(`- ${key}: ${value}`);
  lines.push('');
  lines.push('No memory bodies, claims, owner tokens, or secret values are included.');
  return `${lines.join('\n')}\n`;
}

export function writeRuntimeEvidenceAudit(report, { outDir = OUT_DIR, now = Date.now() } = {}) {
  mkdirSync(outDir, { recursive: true, mode: 0o700 });
  const jsonPath = join(outDir, `runtime-evidence-${now}.json`);
  const mdPath = join(outDir, `runtime-evidence-${now}.md`);
  const latestJsonPath = join(outDir, 'latest.json');
  const latestMdPath = join(outDir, 'latest.md');
  const json = `${JSON.stringify(report, null, 2)}\n`;
  const md = renderMarkdown(report);
  writeFileSync(jsonPath, json, { mode: 0o600 });
  writeFileSync(mdPath, md, { mode: 0o600 });
  writeFileSync(latestJsonPath, json, { mode: 0o600 });
  writeFileSync(latestMdPath, md, { mode: 0o600 });
  return {
    jsonPath: rel(jsonPath),
    mdPath: rel(mdPath),
    latestJsonPath: rel(latestJsonPath),
    latestMdPath: rel(latestMdPath),
  };
}

export async function main() {
  const report = await buildRuntimeEvidenceAudit();
  const paths = writeRuntimeEvidenceAudit(report, { now: NOW });
  console.log(JSON.stringify({
    ok: report.ok,
    generatedAt: report.generatedAt,
    blockers: report.blockers,
    modules: report.modules.map((item) => ({ id: item.id, running: item.running, gap: item.gap })),
    paths,
  }, null, 2));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
