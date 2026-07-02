#!/usr/bin/env node
// @ts-check
// Live expectation calibration snapshot. Read-only: audits the real
// noe_expectations ledger and keeps controlled drill evidence separate from
// long-term live calibration.
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { buildClaimLinkNeedles, buildEvidenceClaimAlignment, buildEvidenceSummary, scoreCandidateClaimLink, selectClaimLinkedEvidenceMatches, summarizePayloadSignals } from '../src/cognition/NoeExpectationResolver.js';
import { buildGoalCheckpointExpectationEvidenceRow, buildNoeActExpectationEvidenceRow } from '../src/cognition/NoeExpectationActionEvidenceRows.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const HOME = homedir();
const NOW = Date.now();
const OUT_DIR = join(ROOT, 'output', 'noe-expectation-calibration');
const DB_PATH = process.env.PANEL_DB_PATH || join(HOME, '.noe-panel', 'panel.db');
const TZ = process.env.NOE_EXPECTATION_CALIBRATION_TZ || 'Asia/Shanghai';
const REQUIRED_LIVE_RESOLVED = Number(process.env.NOE_EXPECTATION_LIVE_REQUIRED_RESOLVED || 20);
const RECENT_TICK_LIMIT = Number(process.env.NOE_EXPECTATION_RECENT_TICK_LIMIT || 20);
const CONTROLLED_LIVE_SOURCE_RE = /(?:controlled|synthetic|fixture|test|drill|calibration[_-]?sample|calibration[_-]?drill|settlement[_-]?drill)/i;
const SEMANTIC_TRACE_LOW_COVERAGE_FLOOR = 0.25;
const SEMANTIC_TRACE_FULLY_LINKED_FLOOR = 0.2;

function rel(file) {
  const abs = resolve(file);
  return abs.startsWith(ROOT) ? relative(ROOT, abs).replace(/\\/g, '/') : abs;
}

function readJson(file) {
  try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return null; }
}

function walk(dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, ent.name);
    if (ent.isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

function latestJsonFile(dir, pred = () => true) {
  const files = walk(dir)
    .filter(pred)
    .map((file) => {
      try { return { file, mtimeMs: statSync(file).mtimeMs }; } catch { return null; }
    })
    .filter(Boolean)
    .sort((a, b) => b.mtimeMs - a.mtimeMs);
  for (const item of files) {
    const json = readJson(item.file);
    if (json) return { file: item.file, json };
  }
  return { file: '', json: null };
}

function parseJsonObject(value) {
  try {
    const parsed = JSON.parse(String(value || '{}'));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function safeReason(value) {
  const raw = String(value || 'unknown').slice(0, 80);
  const safe = raw.replace(/[^A-Za-z0-9_.:-]+/g, '_').replace(/^_+|_+$/g, '');
  return safe || 'unknown';
}

function safeParser(value) {
  const raw = String(value || '').slice(0, 40);
  const safe = raw.replace(/[^A-Za-z0-9_.:-]+/g, '_').replace(/^_+|_+$/g, '');
  return safe || '';
}

function payloadText(payload) {
  if (typeof payload === 'string') return payload;
  try { return JSON.stringify(payload || {}); } catch { return String(payload || ''); }
}

function sanitizeEvidenceStats(value) {
  if (!value || typeof value !== 'object') return null;
  const chars = Math.max(0, Math.min(1800, Math.round(Number(value.chars) || 0)));
  const lines = Math.max(0, Math.min(100, Math.round(Number(value.lines) || 0)));
  return { chars, lines };
}

function sanitizeReplyStats(value) {
  if (!value || typeof value !== 'object') return null;
  const chars = Math.max(0, Math.min(4096, Math.round(Number(value.chars) || 0)));
  const lines = Math.max(0, Math.min(100, Math.round(Number(value.lines) || 0)));
  return { chars, lines };
}

function safeEvidenceTag(value, max = 96) {
  const raw = String(value || '')
    .replace(/(MINIMAX_API_KEY|OBSIDIAN_API_KEY|OPENAI_API_KEY|XIAOMI_API_KEY|ANTHROPIC_API_KEY|GEMINI_API_KEY)\s*[:=]\s*["']?[^"'\s]+/gi, '$1=[redacted]')
    .replace(/(Authorization:\s*Bearer\s+)(?!\[redacted\])[A-Za-z0-9._~+/=-]{8,}/gi, '$1[redacted]')
    .replace(/sk-[A-Za-z0-9_-]{20,}/g, '[redacted-openai-key]')
    .slice(0, max);
  const safe = raw.replace(/[^A-Za-z0-9_.:=\-[\] ]+/g, '_').replace(/^_+|_+$/g, '');
  return safe || '';
}

function sanitizeSummaryCountEntries(items, keyName) {
  if (!Array.isArray(items)) return [];
  return items
    .map((item) => {
      const value = safeEvidenceTag(item?.[keyName], 96);
      const count = Math.max(0, Math.min(999, Math.round(Number(item?.count) || 0)));
      return value && count > 0 ? { [keyName]: value, count } : null;
    })
    .filter(Boolean)
    .sort((a, b) => b.count - a.count || String(a[keyName]).localeCompare(String(b[keyName])))
    .slice(0, 8);
}

function evidenceSummaryHasAction(kinds = []) {
  return kinds.some((item) => /act|action|execut|checkpoint|goal/i.test(String(item.kind || '')));
}

function evidenceSummaryHasObservation(kinds = []) {
  return kinds.some((item) => /episode|thought|reflection|observation|self_talk|memory/i.test(String(item.kind || '')));
}

function evidenceSummaryHasResultSignal(signals = []) {
  return signals.some((item) => /^(status|outcome|result|reason|error|ok|completed|failed|episodeType|streamType|guard\.action|guard\.state|grounding\.score_bucket)=/i.test(String(item.signal || '')));
}

function sanitizeEvidenceSummary(value) {
  if (!value || typeof value !== 'object') return null;
  const scanned = Math.max(0, Math.min(10_000, Math.round(Number(value.scanned) || 0)));
  const matched = Math.max(0, Math.min(100, Math.round(Number(value.matched) || 0)));
  const kinds = sanitizeSummaryCountEntries(value.kinds, 'kind');
  const signals = sanitizeSummaryCountEntries(value.signals, 'signal');

  return {
    scanned,
    matched,
    kinds,
    signals,
    hasActionEvent: value.hasActionEvent === true || evidenceSummaryHasAction(kinds),
    hasObservationEvent: value.hasObservationEvent === true || evidenceSummaryHasObservation(kinds),
    hasResultSignal: value.hasResultSignal === true || evidenceSummaryHasResultSignal(signals),
  };
}

function sanitizeCandidateLinkStats(value) {
  if (!value || typeof value !== 'object') return null;
  return {
    method: safeEvidenceTag(value.method || 'claim_bigram_overlap_v2_semantic_fields', 64) || 'claim_bigram_overlap_v2_semantic_fields',
    claimGrams: Math.max(0, Math.min(1_000, Math.round(Number(value.claimGrams) || 0))),
    scoredCandidates: Math.max(0, Math.min(10_000, Math.round(Number(value.scoredCandidates) || 0))),
    linkedCandidates: Math.max(0, Math.min(10_000, Math.round(Number(value.linkedCandidates) || 0))),
    weakCandidates: Math.max(0, Math.min(10_000, Math.round(Number(value.weakCandidates) || 0))),
    unlinkedCandidates: Math.max(0, Math.min(10_000, Math.round(Number(value.unlinkedCandidates) || 0))),
    maxHits: Math.max(0, Math.min(1_000, Math.round(Number(value.maxHits) || 0))),
    maxCoverage: Math.max(0, Math.min(1, Math.round((Number(value.maxCoverage) || 0) * 1000) / 1000)),
    semanticLinkedCandidates: Math.max(0, Math.min(10_000, Math.round(Number(value.semanticLinkedCandidates) || 0))),
    semanticWeakCandidates: Math.max(0, Math.min(10_000, Math.round(Number(value.semanticWeakCandidates) || 0))),
    semanticUnlinkedCandidates: Math.max(0, Math.min(10_000, Math.round(Number(value.semanticUnlinkedCandidates) || 0))),
    semanticMaxHits: Math.max(0, Math.min(1_000, Math.round(Number(value.semanticMaxHits) || 0))),
    semanticMaxCoverage: Math.max(0, Math.min(1, Math.round((Number(value.semanticMaxCoverage) || 0) * 1000) / 1000)),
    semanticTraceLinkedCandidates: Math.max(0, Math.min(10_000, Math.round(Number(value.semanticTraceLinkedCandidates) || 0))),
    semanticTraceWeakCandidates: Math.max(0, Math.min(10_000, Math.round(Number(value.semanticTraceWeakCandidates) || 0))),
    semanticTraceUnlinkedCandidates: Math.max(0, Math.min(10_000, Math.round(Number(value.semanticTraceUnlinkedCandidates) || 0))),
    semanticTraceMaxHits: Math.max(0, Math.min(1_000, Math.round(Number(value.semanticTraceMaxHits) || 0))),
    semanticTraceMaxCoverage: Math.max(0, Math.min(1, Math.round((Number(value.semanticTraceMaxCoverage) || 0) * 1000) / 1000)),
  };
}

function sanitizeEvidenceCandidateSummary(value) {
  if (!value || typeof value !== 'object') return null;
  const nearest = value.nearestDeltaMs && typeof value.nearestDeltaMs === 'object' ? value.nearestDeltaMs : {};
  const kinds = sanitizeSummaryCountEntries(value.kinds, 'kind');
  const signals = sanitizeSummaryCountEntries(value.signals, 'signal');
  const kindCandidateCount = kinds.reduce((sum, item) => sum + Math.max(0, Number(item.count) || 0), 0);
  const candidates = Math.max(Math.round(Number(value.candidates) || 0), kindCandidateCount);
  const linkStats = sanitizeCandidateLinkStats(value.linkStats);
  return {
    scanned: Math.max(0, Math.min(10_000, Math.round(Number(value.scanned) || 0))),
    candidates: Math.max(0, Math.min(10_000, candidates)),
    windowMs: Math.max(0, Math.min(86_400_000, Math.round(Number(value.windowMs) || 0))),
    kinds,
    signals,
    ...(linkStats ? { linkStats } : {}),
    nearestDeltaMs: {
      min: Number.isFinite(Number(nearest.min)) ? Math.max(0, Math.round(Number(nearest.min))) : null,
      max: Number.isFinite(Number(nearest.max)) ? Math.max(0, Math.round(Number(nearest.max))) : null,
      avg: Number.isFinite(Number(nearest.avg)) ? Math.max(0, Math.round(Number(nearest.avg))) : null,
    },
  };
}

function sanitizeEvidenceClaimAlignment(value) {
  if (!value || typeof value !== 'object') return null;
  return {
    method: safeEvidenceTag(value.method || 'claim_bigram_overlap_v2_semantic_fields', 64) || 'claim_bigram_overlap_v2_semantic_fields',
    claimGrams: Math.max(0, Math.min(1_000, Math.round(Number(value.claimGrams) || 0))),
    matchedEvents: Math.max(0, Math.min(10_000, Math.round(Number(value.matchedEvents) || 0))),
    actionEvents: Math.max(0, Math.min(10_000, Math.round(Number(value.actionEvents) || 0))),
    observationEvents: Math.max(0, Math.min(10_000, Math.round(Number(value.observationEvents) || 0))),
    resultEvents: Math.max(0, Math.min(10_000, Math.round(Number(value.resultEvents) || 0))),
    resultActionEvents: Math.max(0, Math.min(10_000, Math.round(Number(value.resultActionEvents) || 0))),
    linkedActionEvents: Math.max(0, Math.min(10_000, Math.round(Number(value.linkedActionEvents) || 0))),
    weakActionEvents: Math.max(0, Math.min(10_000, Math.round(Number(value.weakActionEvents) || 0))),
    unlinkedActionEvents: Math.max(0, Math.min(10_000, Math.round(Number(value.unlinkedActionEvents) || 0))),
    maxHits: Math.max(0, Math.min(1_000, Math.round(Number(value.maxHits) || 0))),
    maxCoverage: Math.max(0, Math.min(1, Math.round((Number(value.maxCoverage) || 0) * 1000) / 1000)),
    actionMaxHits: Math.max(0, Math.min(1_000, Math.round(Number(value.actionMaxHits) || 0))),
    actionMaxCoverage: Math.max(0, Math.min(1, Math.round((Number(value.actionMaxCoverage) || 0) * 1000) / 1000)),
    semanticActionEvents: Math.max(0, Math.min(10_000, Math.round(Number(value.semanticActionEvents) || 0))),
    semanticResultActionEvents: Math.max(0, Math.min(10_000, Math.round(Number(value.semanticResultActionEvents) || 0))),
    semanticLinkedActionEvents: Math.max(0, Math.min(10_000, Math.round(Number(value.semanticLinkedActionEvents) || 0))),
    semanticWeakActionEvents: Math.max(0, Math.min(10_000, Math.round(Number(value.semanticWeakActionEvents) || 0))),
    semanticUnlinkedActionEvents: Math.max(0, Math.min(10_000, Math.round(Number(value.semanticUnlinkedActionEvents) || 0))),
    semanticActionMaxHits: Math.max(0, Math.min(1_000, Math.round(Number(value.semanticActionMaxHits) || 0))),
    semanticActionMaxCoverage: Math.max(0, Math.min(1, Math.round((Number(value.semanticActionMaxCoverage) || 0) * 1000) / 1000)),
    semanticTraceEvents: Math.max(0, Math.min(10_000, Math.round(Number(value.semanticTraceEvents) || 0))),
    semanticTraceActionEvents: Math.max(0, Math.min(10_000, Math.round(Number(value.semanticTraceActionEvents) || 0))),
    semanticTraceResultActionEvents: Math.max(0, Math.min(10_000, Math.round(Number(value.semanticTraceResultActionEvents) || 0))),
    semanticTraceLinkedActionEvents: Math.max(0, Math.min(10_000, Math.round(Number(value.semanticTraceLinkedActionEvents) || 0))),
    semanticTraceWeakActionEvents: Math.max(0, Math.min(10_000, Math.round(Number(value.semanticTraceWeakActionEvents) || 0))),
    semanticTraceUnlinkedActionEvents: Math.max(0, Math.min(10_000, Math.round(Number(value.semanticTraceUnlinkedActionEvents) || 0))),
    semanticTraceMaxHits: Math.max(0, Math.min(1_000, Math.round(Number(value.semanticTraceMaxHits) || 0))),
    semanticTraceMaxCoverage: Math.max(0, Math.min(1, Math.round((Number(value.semanticTraceMaxCoverage) || 0) * 1000) / 1000)),
  };
}

function evidenceClaimAlignmentNeedsRefresh(value) {
  if (!value || typeof value !== 'object') return true;
  if (!String(value.method || '').includes('semantic_fields')) return true;
  return !Object.prototype.hasOwnProperty.call(value, 'semanticActionMaxHits')
    || !Object.prototype.hasOwnProperty.call(value, 'semanticActionMaxCoverage')
    || !Object.prototype.hasOwnProperty.call(value, 'semanticTraceActionEvents')
    || !Object.prototype.hasOwnProperty.call(value, 'semanticTraceMaxCoverage');
}

function summarizeEvidenceStats(items = []) {
  const stats = items.filter(Boolean);
  if (!stats.length) {
    return {
      withStats: 0,
      zeroEvidence: 0,
      chars: { min: null, max: null, avg: null },
      lines: { min: null, max: null, avg: null },
    };
  }
  const chars = stats.map((s) => s.chars);
  const lines = stats.map((s) => s.lines);
  const avg = (values) => Math.round((values.reduce((sum, v) => sum + v, 0) / values.length) * 100) / 100;
  return {
    withStats: stats.length,
    zeroEvidence: stats.filter((s) => s.chars === 0 || s.lines === 0).length,
    chars: { min: Math.min(...chars), max: Math.max(...chars), avg: avg(chars) },
    lines: { min: Math.min(...lines), max: Math.max(...lines), avg: avg(lines) },
  };
}

function sanitizeDecisionProfile(value) {
  const profile = value && typeof value === 'object' ? value : {};
  const out = {};
  const countKeys = [
    'matched',
    'actionKinds',
    'observationKinds',
    'actionResultSignals',
    'observationSignals',
    'successSignals',
    'failureSignals',
    'runningSignals',
    'linkedCandidates',
    'weakCandidates',
    'claimGrams',
    'actionEvents',
    'resultActionEvents',
    'linkedActionEvents',
    'semanticActionEvents',
    'semanticResultActionEvents',
    'semanticLinkedActionEvents',
    'semanticTraceActionEvents',
    'semanticTraceResultActionEvents',
    'semanticTraceLinkedActionEvents',
  ];
  const coverageKeys = [
    'actionMaxCoverage',
    'semanticActionMaxCoverage',
    'semanticTraceMaxCoverage',
  ];
  for (const key of countKeys) {
    out[key] = Math.max(0, Math.min(10_000, Math.round(Number(profile[key]) || 0)));
  }
  for (const key of coverageKeys) {
    out[key] = Math.max(0, Math.min(1, Math.round((Number(profile[key]) || 0) * 1000) / 1000));
  }
  return out;
}

function sanitizeEvidenceDecisionHint(value) {
  if (!value || typeof value !== 'object') return null;
  const label = safeEvidenceTag(value.label || 'unknown_hint', 80) || 'unknown_hint';
  const confidence = safeEvidenceTag(value.confidence || 'none', 24) || 'none';
  const suggestedVerdict = safeEvidenceTag(value.suggestedVerdict || 'UNKNOWN', 16) || 'UNKNOWN';
  const caution = safeEvidenceTag(value.caution || 'strict_evidence_only', 96) || 'strict_evidence_only';
  return {
    label,
    confidence,
    suggestedVerdict: ['APPLIED', 'FAILED', 'UNKNOWN'].includes(suggestedVerdict) ? suggestedVerdict : 'UNKNOWN',
    caution,
    profile: sanitizeDecisionProfile(value.profile),
  };
}

function decisionProfileHasSignal(profile = {}) {
  return [
    'matched',
    'actionKinds',
    'observationKinds',
    'actionResultSignals',
    'observationSignals',
    'successSignals',
    'failureSignals',
    'runningSignals',
    'claimGrams',
    'actionEvents',
    'resultActionEvents',
    'semanticLinkedActionEvents',
    'semanticTraceLinkedActionEvents',
  ].some((key) => Number(profile?.[key] || 0) > 0);
}

function reconstructDecisionHintProfile({ evidenceSummary, evidenceClaimAlignment }) {
  const summary = sanitizeEvidenceSummary(evidenceSummary);
  if (!summary) return null;
  const kinds = Array.isArray(summary.kinds) ? summary.kinds : [];
  const signals = Array.isArray(summary.signals) ? summary.signals : [];
  const alignment = sanitizeEvidenceClaimAlignment(evidenceClaimAlignment);
  return sanitizeDecisionProfile({
    matched: Math.max(0, Math.round(Number(summary.matched) || 0)),
    actionKinds: countSummaryMatches(kinds, 'kind', /act|action|execut|checkpoint|goal/i),
    observationKinds: countSummaryMatches(kinds, 'kind', /episode|thought|reflection|observation|self_talk|memory/i),
    actionResultSignals: countSummaryMatches(signals, 'signal', /^(status|outcome|result|ok|completed|failed|error)=/i),
    observationSignals: countSummaryMatches(signals, 'signal', /^(episodeType|streamType|guard\.action|guard\.state|grounding\.score_bucket)=/i),
    successSignals: countSummaryMatches(signals, 'signal', /^(?:status|outcome|result)=(?:succeeded|success|completed|done|passed|applied)$|^(?:ok|completed)=true$/i),
    failureSignals: countSummaryMatches(signals, 'signal', /^(?:status|outcome|result)=(?:failed|failure|error|blocked|rejected|timeout)$|^(?:failed|error)=true$|^ok=false$/i),
    runningSignals: countSummaryMatches(signals, 'signal', /^(?:status|outcome|result)=(?:running|started|pending|in_progress|queued)$/i),
    ...(alignment ? {
      claimGrams: alignment.claimGrams,
      actionEvents: alignment.actionEvents,
      resultActionEvents: alignment.resultActionEvents,
      linkedActionEvents: alignment.linkedActionEvents,
      actionMaxCoverage: alignment.actionMaxCoverage,
      semanticActionEvents: alignment.semanticActionEvents,
      semanticResultActionEvents: alignment.semanticResultActionEvents,
      semanticLinkedActionEvents: alignment.semanticLinkedActionEvents,
      semanticActionMaxCoverage: alignment.semanticActionMaxCoverage,
      semanticTraceActionEvents: alignment.semanticTraceActionEvents,
      semanticTraceResultActionEvents: alignment.semanticTraceResultActionEvents,
      semanticTraceLinkedActionEvents: alignment.semanticTraceLinkedActionEvents,
      semanticTraceMaxCoverage: alignment.semanticTraceMaxCoverage,
    } : {}),
  });
}

function enrichCompactEvidenceDecisionHint({ hint, evidenceSummary, evidenceClaimAlignment }) {
  if (!hint) return null;
  if (decisionProfileHasSignal(hint.profile)) return { ...hint, profileSource: 'persisted' };
  const profile = reconstructDecisionHintProfile({ evidenceSummary, evidenceClaimAlignment });
  if (!decisionProfileHasSignal(profile)) return { ...hint, profileSource: 'compact_missing_profile' };
  return {
    ...hint,
    confidence: hint.confidence === 'none'
      ? (profile.successSignals > 0 || profile.failureSignals > 0 ? 'high' : 'medium')
      : hint.confidence,
    profile,
    profileSource: 'reconstructed_from_safe_metadata',
  };
}

function summarizeEvidenceCandidateSummaries(items = []) {
  const summaries = items.filter(Boolean);
  const kindCounts = new Map();
  const signalCounts = new Map();
  const linkStatsItems = [];
  for (const summary of summaries) {
    for (const item of summary.kinds || []) {
      const key = safeEvidenceTag(item.kind, 96);
      if (key) kindCounts.set(key, (kindCounts.get(key) || 0) + Number(item.count || 0));
    }
    for (const item of summary.signals || []) {
      const key = safeEvidenceTag(item.signal, 96);
      if (key) signalCounts.set(key, (signalCounts.get(key) || 0) + Number(item.count || 0));
    }
    if (summary.linkStats) linkStatsItems.push(summary.linkStats);
  }
  const out = {
    withCandidateSummary: summaries.length,
    totalCandidates: summaries.reduce((sum, item) => sum + Math.max(0, Number(item.candidates) || 0), 0),
    kindCounts: compactCountMap(kindCounts, 'kind'),
    signalCounts: compactCountMap(signalCounts, 'signal'),
  };
  if (linkStatsItems.length) {
    out.linkStats = {
      withLinkStats: linkStatsItems.length,
      linkedCandidates: linkStatsItems.reduce((sum, item) => sum + Math.max(0, Number(item.linkedCandidates) || 0), 0),
      weakCandidates: linkStatsItems.reduce((sum, item) => sum + Math.max(0, Number(item.weakCandidates) || 0), 0),
      unlinkedCandidates: linkStatsItems.reduce((sum, item) => sum + Math.max(0, Number(item.unlinkedCandidates) || 0), 0),
      maxHits: linkStatsItems.reduce((max, item) => Math.max(max, Number(item.maxHits) || 0), 0),
      maxCoverage: Math.round(linkStatsItems.reduce((max, item) => Math.max(max, Number(item.maxCoverage) || 0), 0) * 1000) / 1000,
    };
  }
  return out;
}

function summarizeEvidenceClaimAlignments(items = []) {
  const alignments = items.filter(Boolean);
  if (!alignments.length) {
    return {
      withAlignment: 0,
      actionEvents: 0,
      resultActionEvents: 0,
      linkedActionEvents: 0,
      weakActionEvents: 0,
      unlinkedActionEvents: 0,
      maxCoverage: null,
      actionMaxCoverage: null,
      semanticActionEvents: 0,
      semanticResultActionEvents: 0,
      semanticLinkedActionEvents: 0,
      semanticWeakActionEvents: 0,
      semanticUnlinkedActionEvents: 0,
      semanticActionMaxCoverage: null,
      semanticTraceEvents: 0,
      semanticTraceActionEvents: 0,
      semanticTraceResultActionEvents: 0,
      semanticTraceLinkedActionEvents: 0,
      semanticTraceWeakActionEvents: 0,
      semanticTraceUnlinkedActionEvents: 0,
      semanticTraceMaxCoverage: null,
    };
  }
  return {
    withAlignment: alignments.length,
    matchedEvents: alignments.reduce((sum, item) => sum + Math.max(0, Number(item.matchedEvents) || 0), 0),
    actionEvents: alignments.reduce((sum, item) => sum + Math.max(0, Number(item.actionEvents) || 0), 0),
    observationEvents: alignments.reduce((sum, item) => sum + Math.max(0, Number(item.observationEvents) || 0), 0),
    resultEvents: alignments.reduce((sum, item) => sum + Math.max(0, Number(item.resultEvents) || 0), 0),
    resultActionEvents: alignments.reduce((sum, item) => sum + Math.max(0, Number(item.resultActionEvents) || 0), 0),
    linkedActionEvents: alignments.reduce((sum, item) => sum + Math.max(0, Number(item.linkedActionEvents) || 0), 0),
    weakActionEvents: alignments.reduce((sum, item) => sum + Math.max(0, Number(item.weakActionEvents) || 0), 0),
    unlinkedActionEvents: alignments.reduce((sum, item) => sum + Math.max(0, Number(item.unlinkedActionEvents) || 0), 0),
    maxHits: alignments.reduce((max, item) => Math.max(max, Number(item.maxHits) || 0), 0),
    maxCoverage: Math.round(alignments.reduce((max, item) => Math.max(max, Number(item.maxCoverage) || 0), 0) * 1000) / 1000,
    actionMaxHits: alignments.reduce((max, item) => Math.max(max, Number(item.actionMaxHits) || 0), 0),
    actionMaxCoverage: Math.round(alignments.reduce((max, item) => Math.max(max, Number(item.actionMaxCoverage) || 0), 0) * 1000) / 1000,
    semanticActionEvents: alignments.reduce((sum, item) => sum + Math.max(0, Number(item.semanticActionEvents) || 0), 0),
    semanticResultActionEvents: alignments.reduce((sum, item) => sum + Math.max(0, Number(item.semanticResultActionEvents) || 0), 0),
    semanticLinkedActionEvents: alignments.reduce((sum, item) => sum + Math.max(0, Number(item.semanticLinkedActionEvents) || 0), 0),
    semanticWeakActionEvents: alignments.reduce((sum, item) => sum + Math.max(0, Number(item.semanticWeakActionEvents) || 0), 0),
    semanticUnlinkedActionEvents: alignments.reduce((sum, item) => sum + Math.max(0, Number(item.semanticUnlinkedActionEvents) || 0), 0),
    semanticActionMaxHits: alignments.reduce((max, item) => Math.max(max, Number(item.semanticActionMaxHits) || 0), 0),
    semanticActionMaxCoverage: Math.round(alignments.reduce((max, item) => Math.max(max, Number(item.semanticActionMaxCoverage) || 0), 0) * 1000) / 1000,
    semanticTraceEvents: alignments.reduce((sum, item) => sum + Math.max(0, Number(item.semanticTraceEvents) || 0), 0),
    semanticTraceActionEvents: alignments.reduce((sum, item) => sum + Math.max(0, Number(item.semanticTraceActionEvents) || 0), 0),
    semanticTraceResultActionEvents: alignments.reduce((sum, item) => sum + Math.max(0, Number(item.semanticTraceResultActionEvents) || 0), 0),
    semanticTraceLinkedActionEvents: alignments.reduce((sum, item) => sum + Math.max(0, Number(item.semanticTraceLinkedActionEvents) || 0), 0),
    semanticTraceWeakActionEvents: alignments.reduce((sum, item) => sum + Math.max(0, Number(item.semanticTraceWeakActionEvents) || 0), 0),
    semanticTraceUnlinkedActionEvents: alignments.reduce((sum, item) => sum + Math.max(0, Number(item.semanticTraceUnlinkedActionEvents) || 0), 0),
    semanticTraceMaxHits: alignments.reduce((max, item) => Math.max(max, Number(item.semanticTraceMaxHits) || 0), 0),
    semanticTraceMaxCoverage: Math.round(alignments.reduce((max, item) => Math.max(max, Number(item.semanticTraceMaxCoverage) || 0), 0) * 1000) / 1000,
  };
}

function summarizeEvidenceDecisionHints(items = []) {
  const hints = items.filter(Boolean);
  const labelCounts = new Map();
  const confidenceCounts = new Map();
  const verdictCounts = new Map();
  for (const hint of hints) {
    incrementMap(labelCounts, hint.label);
    incrementMap(confidenceCounts, hint.confidence);
    incrementMap(verdictCounts, hint.suggestedVerdict);
  }
  return {
    withHint: hints.length,
    labelCounts: compactCountMap(labelCounts, 'label'),
    confidenceCounts: compactCountMap(confidenceCounts, 'confidence'),
    suggestedVerdictCounts: compactCountMap(verdictCounts, 'suggestedVerdict'),
  };
}

function summarizeEvidenceSummaries(items = []) {
  const summaries = items.filter(Boolean);
  const emptyRange = { min: null, max: null, avg: null };
  if (!summaries.length) {
    return {
      withSummary: 0,
      hasActionEvent: 0,
      hasObservationEvent: 0,
      hasResultSignal: 0,
      scanned: emptyRange,
      matched: emptyRange,
      kindCounts: [],
      signalCounts: [],
    };
  }
  const kindCounts = new Map();
  const signalCounts = new Map();
  const scanned = summaries.map((item) => item.scanned);
  const matched = summaries.map((item) => item.matched);
  const avg = (values) => Math.round((values.reduce((sum, v) => sum + v, 0) / values.length) * 100) / 100;
  for (const summary of summaries) {
    for (const item of summary.kinds || []) {
      const key = safeEvidenceTag(item.kind, 96);
      if (key) kindCounts.set(key, (kindCounts.get(key) || 0) + Number(item.count || 0));
    }
    for (const item of summary.signals || []) {
      const key = safeEvidenceTag(item.signal, 96);
      if (key) signalCounts.set(key, (signalCounts.get(key) || 0) + Number(item.count || 0));
    }
  }
  return {
    withSummary: summaries.length,
    hasActionEvent: summaries.filter((item) => item.hasActionEvent).length,
    hasObservationEvent: summaries.filter((item) => item.hasObservationEvent).length,
    hasResultSignal: summaries.filter((item) => item.hasResultSignal).length,
    scanned: { min: Math.min(...scanned), max: Math.max(...scanned), avg: avg(scanned) },
    matched: { min: Math.min(...matched), max: Math.max(...matched), avg: avg(matched) },
    kindCounts: compactCountMap(kindCounts, 'kind'),
    signalCounts: compactCountMap(signalCounts, 'signal'),
  };
}

function countSummaryMatches(items = [], keyName, pattern) {
  return items.reduce((sum, item) => {
    const value = String(item?.[keyName] || '');
    if (!pattern.test(value)) return sum;
    return sum + Math.max(0, Math.round(Number(item?.count) || 0));
  }, 0);
}

function classifyEvidenceDecisionReadiness(evidenceSummary) {
  if (!evidenceSummary) return null;
  const kinds = Array.isArray(evidenceSummary.kinds) ? evidenceSummary.kinds : [];
  const signals = Array.isArray(evidenceSummary.signals) ? evidenceSummary.signals : [];
  const profile = {
    matched: Math.max(0, Math.round(Number(evidenceSummary.matched) || 0)),
    actionKinds: countSummaryMatches(kinds, 'kind', /act|action|execut|checkpoint|goal/i),
    observationKinds: countSummaryMatches(kinds, 'kind', /episode|thought|reflection|observation|self_talk|memory/i),
    actionResultSignals: countSummaryMatches(signals, 'signal', /^(status|outcome|result|ok|completed|failed|error)=/i),
    observationSignals: countSummaryMatches(signals, 'signal', /^(episodeType|streamType|guard\.action|guard\.state|grounding\.score_bucket)=/i),
    successSignals: countSummaryMatches(signals, 'signal', /^(?:status|outcome|result)=(?:succeeded|success|completed|done|passed|applied)$|^(?:ok|completed)=true$/i),
    failureSignals: countSummaryMatches(signals, 'signal', /^(?:status|outcome|result)=(?:failed|failure|error|blocked|rejected|timeout)$|^(?:failed|error)=true$|^ok=false$/i),
    runningSignals: countSummaryMatches(signals, 'signal', /^(?:status|outcome|result)=(?:running|started|pending|in_progress|queued)$/i),
  };
  const result = (label, confidence, nextStep) => ({ label, confidence, profile, nextStep });
  if (profile.matched <= 0) {
    return result('no_matched_evidence', 'none', 'improve event matching before changing judge behavior');
  }
  if (profile.matched === 1 && !profile.actionResultSignals && !profile.observationSignals) {
    return result('thin_matched_evidence', 'low', 'collect more post-creation evidence before adjudicating');
  }
  if (!evidenceSummary.hasResultSignal) {
    return result('no_result_signal', 'none', 'record safe status/outcome/result signals before adjudicating');
  }
  if (profile.successSignals > 0 && profile.failureSignals > 0) {
    return result('mixed_action_result_signal', 'medium', 'separate contradictory action results before changing settlement logic');
  }
  if (profile.successSignals > 0) {
    return result('action_success_signal', profile.matched >= 2 ? 'high' : 'medium', 'review judge prompt because safe success evidence exists');
  }
  if (profile.failureSignals > 0) {
    return result('action_failure_signal', profile.matched >= 2 ? 'high' : 'medium', 'review judge prompt because safe failure evidence exists');
  }
  if (profile.runningSignals > 0 && profile.actionResultSignals > 0) {
    return result('action_running_only', 'low', 'wait for completion evidence instead of forcing a settlement');
  }
  if (profile.actionResultSignals > 0) {
    return result('ambiguous_action_result_signal', 'medium', 'refine safe result metadata so the judge sees a decisive outcome');
  }
  if (profile.observationSignals > 0 && !evidenceSummary.hasActionEvent) {
    return result('observation_only_result_signal', 'low', 'collect an action or external-result signal before adjusting judge conservatism');
  }
  if (profile.observationSignals > 0) {
    return result('action_observation_result_signal', 'medium', 'separate action outcome from observation metadata before adjudicating');
  }
  return result('ambiguous_result_signal', 'low', 'inspect safe signal enums before changing settlement logic');
}

function summarizeEvidenceDecisions(items = []) {
  const decisions = items.filter(Boolean);
  const labelCounts = new Map();
  const confidenceCounts = new Map();
  for (const decision of decisions) {
    incrementMap(labelCounts, decision.label);
    incrementMap(confidenceCounts, decision.confidence);
  }
  return {
    withDecision: decisions.length,
    labelCounts: compactCountMap(labelCounts, 'label'),
    confidenceCounts: compactCountMap(confidenceCounts, 'confidence'),
  };
}

function summarizeReplyStats(items = []) {
  const stats = items.filter(Boolean);
  if (!stats.length) {
    return {
      withStats: 0,
      zeroReply: 0,
      chars: { min: null, max: null, avg: null },
      lines: { min: null, max: null, avg: null },
    };
  }
  const chars = stats.map((s) => s.chars);
  const lines = stats.map((s) => s.lines);
  const avg = (values) => Math.round((values.reduce((sum, v) => sum + v, 0) / values.length) * 100) / 100;
  return {
    withStats: stats.length,
    zeroReply: stats.filter((s) => s.chars === 0 || s.lines === 0).length,
    chars: { min: Math.min(...chars), max: Math.max(...chars), avg: avg(chars) },
    lines: { min: Math.min(...lines), max: Math.max(...lines), avg: avg(lines) },
  };
}

function classifyJudgeContractGap({ safeReasonValue, evidenceDecision, evidenceDecisionHint, verdictReasonCode, hintAgreement }) {
  if (safeReasonValue !== 'llm_unknown') return '';
  const decisionLabel = safeReason(evidenceDecision?.label || '');
  const hintLabel = safeReason(evidenceDecisionHint?.label || '');
  const suggestedVerdict = safeReason(evidenceDecisionHint?.suggestedVerdict || '');
  const code = safeReason(verdictReasonCode || '');
  const agreement = safeReason(hintAgreement || '');
  const decisiveLabel = decisionLabel === 'action_success_signal'
    || decisionLabel === 'action_failure_signal'
    || hintLabel === 'action_success_signal'
    || hintLabel === 'action_failure_signal'
    || suggestedVerdict === 'APPLIED'
    || suggestedVerdict === 'FAILED';
  if (!decisiveLabel) return '';
  if (code.startsWith('claim_mismatch')) return 'judge_reports_claim_mismatch';
  if (code === 'conflicting_signals') return 'judge_reports_conflicting_signals';
  if (code === 'insufficient_direct_evidence') return 'judge_requires_claim_evidence_link';
  if (agreement === 'override') return 'judge_overrode_decisive_hint';
  return '';
}

function hasActionSuccessDecision(evidenceDecision, evidenceDecisionHint) {
  const decisionLabel = safeReason(evidenceDecision?.label || '');
  const hintLabel = safeReason(evidenceDecisionHint?.label || '');
  const suggestedVerdict = safeReason(evidenceDecisionHint?.suggestedVerdict || '');
  return decisionLabel === 'action_success_signal'
    || hintLabel === 'action_success_signal'
    || suggestedVerdict === 'APPLIED';
}

function refineJudgeContractGap(gap, evidenceDecision, evidenceDecisionHint, evidenceClaimAlignment) {
  if (gap !== 'judge_reports_claim_mismatch') return gap;
  const alignment = sanitizeEvidenceClaimAlignment(evidenceClaimAlignment);
  if (!alignment) return gap;
  if (hasActionSuccessDecision(evidenceDecision, evidenceDecisionHint)
    && alignment.semanticTraceResultActionEvents > 0) {
    return 'judge_reports_claim_mismatch_with_trace_success';
  }
  return gap;
}

function refineClaimAlignmentGap(gap, evidenceClaimAlignment) {
  if (gap !== 'judge_requires_claim_evidence_link') return gap;
  const alignment = sanitizeEvidenceClaimAlignment(evidenceClaimAlignment);
  if (!alignment) return gap;
  if (alignment.actionEvents <= 0) return 'claim_action_alignment_missing_action';
  if (alignment.resultActionEvents <= 0) return 'claim_action_alignment_missing_result_action';
  if (alignment.semanticActionEvents <= 0) return 'claim_action_semantic_alignment_missing';
  if (alignment.semanticResultActionEvents <= 0) return 'claim_action_semantic_alignment_missing_result_action';
  if (alignment.semanticTraceActionEvents > 0
    && alignment.semanticTraceResultActionEvents > 0
    && alignment.semanticTraceMaxCoverage < SEMANTIC_TRACE_LOW_COVERAGE_FLOOR) {
    const fullyLinkedTraceResultRoute = alignment.semanticTraceLinkedActionEvents >= alignment.semanticTraceResultActionEvents
      && alignment.semanticTraceLinkedActionEvents > 0;
    if (alignment.semanticTraceLinkedActionEvents > 0
      && alignment.semanticTraceUnlinkedActionEvents > alignment.semanticTraceLinkedActionEvents) {
      return 'claim_action_semantic_trace_mixed_linkage';
    }
    if (fullyLinkedTraceResultRoute
      && alignment.semanticTraceMaxCoverage >= SEMANTIC_TRACE_FULLY_LINKED_FLOOR) {
      return gap;
    }
    return 'claim_action_semantic_trace_coverage_low';
  }
  if (alignment.semanticActionMaxCoverage < 0.25) return 'claim_action_semantic_alignment_weak';
  if (alignment.actionMaxCoverage < 0.25) return 'claim_action_alignment_weak';
  return gap;
}

function classifyEvidenceGaps({ outcome, reason, verdictReasonCode, hintAgreement, evidenceStats, evidenceSummary, evidenceDecision, evidenceDecisionHint, evidenceCandidateSummary, evidenceClaimAlignment }) {
  const safe = safeReason(reason);
  if (outcome === 1 || outcome === 0) return [];
  const gaps = [];
  if (safe === 'no_brain' || safe === 'brain_error' || safe === 'brain_incomplete') gaps.push(`judge_${safe}`);
  if (safe === 'llm_unparsed') gaps.push('judge_unparsed');
  if (safe === 'no_evidence' || evidenceStats?.chars === 0 || evidenceStats?.lines === 0) gaps.push('no_evidence');
  if (!evidenceSummary) {
    gaps.push('missing_evidence_summary');
  } else {
    if (evidenceSummary.matched === 0) gaps.push('no_matched_evidence');
    else if (evidenceSummary.matched === 1) gaps.push('thin_matched_evidence');
    if (!evidenceSummary.hasActionEvent && !evidenceSummary.hasObservationEvent) gaps.push('no_action_event');
    if (!evidenceSummary.hasResultSignal) gaps.push('no_result_signal');
    if (safe === 'llm_unknown' && evidenceSummary.matched > 0 && evidenceSummary.hasResultSignal) {
      const label = evidenceDecision?.label || '';
      if (label === 'action_running_only') gaps.push('action_in_progress_unknown');
      else if (label === 'observation_only_result_signal') {
        if (evidenceCandidateSummary?.candidates > 0) {
          const linked = Math.max(0, Number(evidenceCandidateSummary?.linkStats?.linkedCandidates) || 0);
          gaps.push(linked > 0 ? 'candidate_result_linked_unknown' : 'candidate_result_unlinked_unknown');
        } else {
          gaps.push('observation_only_unknown');
        }
      }
      else if (label === 'ambiguous_action_result_signal' || label === 'action_observation_result_signal') gaps.push('ambiguous_action_result_unknown');
      else if (label === 'action_success_signal' || label === 'action_failure_signal' || label === 'mixed_action_result_signal') {
        const contractGap = classifyJudgeContractGap({
          safeReasonValue: safe,
          evidenceDecision,
          evidenceDecisionHint,
          verdictReasonCode,
          hintAgreement,
        });
        const refinedContractGap = refineJudgeContractGap(
          contractGap,
          evidenceDecision,
          evidenceDecisionHint,
          evidenceClaimAlignment,
        );
        gaps.push(refineClaimAlignmentGap(refinedContractGap || 'judge_unknown_despite_decisive_result', evidenceClaimAlignment));
      } else if (evidenceSummary.hasActionEvent || evidenceSummary.hasObservationEvent) {
        gaps.push('judge_unknown_despite_action_result');
      }
    }
  }
  return [...new Set(gaps.length ? gaps : [`reason_${safe}`])].slice(0, 8);
}

function sanitizeEvidenceRefresh(value) {
  if (!value || typeof value !== 'object') return null;
  const source = safeReason(value.source || 'unknown_refresh');
  return {
    source,
    changed: value.changed === true,
  };
}

function incrementMap(map, key) {
  const safeKey = safeReason(key);
  map.set(safeKey, (map.get(safeKey) || 0) + 1);
}

function compactCountMap(map, keyName) {
  return [...map.entries()]
    .map(([key, count]) => ({ [keyName]: key, count }))
    .sort((a, b) => b.count - a.count || String(a[keyName]).localeCompare(String(b[keyName])))
    .slice(0, 12);
}

function countDecisiveEvidenceDecisions(items = []) {
  return items.filter((item) => {
    const label = safeReason(item?.label || '');
    return label === 'action_success_signal' || label === 'action_failure_signal';
  }).length;
}

function countDecisiveEvidenceHints(items = []) {
  return items.filter((item) => {
    const label = safeReason(item?.label || '');
    const suggestedVerdict = safeReason(item?.suggestedVerdict || '');
    return label === 'action_success_signal'
      || label === 'action_failure_signal'
      || suggestedVerdict === 'APPLIED'
      || suggestedVerdict === 'FAILED';
  }).length;
}

function shouldWaitForPostHintJudgement(context = {}) {
  return Math.max(0, Math.round(Number(context.decisiveEvidenceDecisionCount) || 0)) > 0
    && Math.max(0, Math.round(Number(context.decisiveEvidenceHintCount) || 0)) <= 0;
}

function countMatchingCompactEntries(entries = [], keyName, predicate) {
  if (!Array.isArray(entries)) return 0;
  return entries.reduce((sum, item) => {
    const count = Math.max(0, Math.round(Number(item?.count) || 0));
    return predicate(String(item?.[keyName] || '')) ? sum + count : sum;
  }, 0);
}

function actionForEvidenceGap(gap, context = {}) {
  if (gap === 'missing_evidence_summary') {
    return {
      action: 'wait_for_post_summary_judgement',
      priority: 1,
      nextStep: 'wait for a natural expectation tick produced after evidenceSummary deployment; do not hand-edit DB or count UNKNOWN',
    };
  }
  if (gap === 'no_evidence' || gap === 'no_matched_evidence' || gap === 'thin_matched_evidence') {
    return {
      action: 'improve_evidence_retrieval',
      priority: 2,
      nextStep: 'expand or retune event matching so due expectations receive relevant post-creation evidence',
    };
  }
  if (gap === 'no_action_event') {
    return {
      action: 'record_action_event_evidence',
      priority: 3,
      nextStep: 'ensure relevant acts/checkpoints emit safe action events that expectation evidence can match',
    };
  }
  if (gap === 'no_result_signal') {
    return {
      action: 'record_result_signal_evidence',
      priority: 3,
      nextStep: 'ensure matched events include safe status/result/completed/failed signals',
    };
  }
  if (gap === 'action_in_progress_unknown') {
    return {
      action: 'wait_for_action_completion',
      priority: 1,
      nextStep: 'wait for completion/failure evidence; do not settle from running-only signals',
    };
  }
  if (gap === 'observation_only_unknown') {
    return {
      action: 'collect_decisive_result_evidence',
      priority: 3,
      nextStep: 'add or wait for action/external-result evidence before adjusting judge conservatism',
    };
  }
  if (gap === 'candidate_result_unlinked_unknown') {
    return {
      action: 'link_candidate_result_evidence',
      priority: 3,
      nextStep: 'inspect whether nearby action/status candidates are semantically linked before using them for settlement',
    };
  }
  if (gap === 'candidate_result_linked_unknown') {
    return {
      action: 'promote_linked_candidate_evidence',
      priority: 3,
      nextStep: 'promote semantically linked candidate metadata into direct evidence only after a safe audit; do not auto-settle UNKNOWN',
    };
  }
  if (gap === 'judge_requires_claim_evidence_link') {
    if (shouldWaitForPostHintJudgement(context)) {
      return {
        action: 'wait_for_post_hint_judgement',
        priority: 1,
        nextStep: 'wait for a natural expectation tick produced after evidenceDecisionHint deployment; historical UNKNOWN rows without hints should not trigger claim/action rewrites',
      };
    }
    return {
      action: 'audit_claim_action_alignment',
      priority: 3,
      nextStep: 'audit safe claim/action alignment before loosening the judge or counting the direct action hint as settlement',
    };
  }
  if (gap === 'claim_action_alignment_weak') {
    return {
      action: 'improve_claim_action_linking',
      priority: 3,
      nextStep: 'improve claim/action linking or evidence extraction because direct action evidence has weak claim overlap',
    };
  }
  if (gap === 'claim_action_alignment_missing_action') {
    return {
      action: 'record_direct_action_for_claim',
      priority: 3,
      nextStep: 'record direct action evidence that semantically matches the expectation before judging settlement',
    };
  }
  if (gap === 'claim_action_alignment_missing_result_action') {
    return {
      action: 'record_result_action_for_claim',
      priority: 3,
      nextStep: 'record terminal action status for the matched claim evidence before settlement',
    };
  }
  if (gap === 'claim_action_semantic_alignment_missing') {
    return {
      action: 'record_semantic_action_evidence_for_claim',
      priority: 3,
      nextStep: 'record semantic action evidence that matches the expectation claim instead of relying on payload-wide overlap',
    };
  }
  if (gap === 'claim_action_semantic_alignment_missing_result_action') {
    return {
      action: 'record_semantic_result_action_for_claim',
      priority: 3,
      nextStep: 'record terminal action status on the semantic action evidence before settlement',
    };
  }
  if (gap === 'claim_action_semantic_alignment_weak') {
    return {
      action: 'improve_semantic_claim_action_linking',
      priority: 3,
      nextStep: 'improve semantic claim/action linking because payload-wide action evidence is not enough for settlement',
    };
  }
  if (gap === 'claim_action_semantic_trace_mixed_linkage') {
    return {
      action: 'separate_semantic_trace_claim_routes',
      priority: 3,
      nextStep: 'split unrelated semanticTrace action events from claim-linked evidence before promoting direct evidence',
    };
  }
  if (gap === 'claim_action_semantic_trace_coverage_low') {
    return {
      action: 'enrich_semantic_trace_claim_terms',
      priority: 3,
      nextStep: 'include safe expectation and goal terms in completed action semanticTrace so linked results reach the claim threshold',
    };
  }
  if (gap === 'judge_reports_claim_mismatch') {
    return {
      action: 'repair_claim_evidence_matching',
      priority: 3,
      nextStep: 'inspect safe matching metadata because the judge reported claim mismatch despite decisive action metadata',
    };
  }
  if (gap === 'judge_reports_claim_mismatch_with_trace_success') {
    return {
      action: 'repair_trace_claim_evidence_matching',
      priority: 3,
      nextStep: 'inspect safe semanticTrace matching metadata because the judge reported claim mismatch despite successful trace evidence',
    };
  }
  if (gap === 'judge_reports_conflicting_signals') {
    return {
      action: 'separate_conflicting_result_signals',
      priority: 3,
      nextStep: 'separate success and failure signals before attempting settlement or judge relaxation',
    };
  }
  if (gap === 'judge_overrode_decisive_hint') {
    return {
      action: 'repair_judge_contract',
      priority: 4,
      nextStep: 'inspect JSON verdict reason codes and prompt contract for decisive hints that are repeatedly overridden',
    };
  }
  if (gap === 'ambiguous_action_result_unknown') {
    return {
      action: 'refine_evidence_decision_summary',
      priority: 3,
      nextStep: 'separate action outcome signals from observation metadata in the safe evidence summary',
    };
  }
  if (gap === 'judge_unknown_despite_decisive_result' || gap === 'judge_unknown_despite_action_result') {
    return {
      action: 'review_judge_conservatism',
      priority: 4,
      nextStep: 'inspect prompt and safe metadata shape only after safe decisive result signals are present',
    };
  }
  if (gap.startsWith('judge_')) {
    return {
      action: 'repair_judge_runtime',
      priority: 2,
      nextStep: 'repair local judge availability or verdict parsing before expecting natural settlements',
    };
  }
  return {
    action: 'inspect_unclassified_gap',
    priority: 9,
    nextStep: 'inspect safe gap enum and add a targeted classifier before changing settlement logic',
  };
}

function recommendEvidenceGapActions(gapCounts = [], context = {}) {
  const byAction = new Map();
  for (const item of gapCounts) {
    const gap = safeReason(item?.gap);
    const count = Math.max(0, Math.min(999, Math.round(Number(item?.count) || 0)));
    if (!gap || count <= 0) continue;
    const base = actionForEvidenceGap(gap, context);
    const entry = byAction.get(base.action) || { ...base, gapCount: 0, gaps: [] };
    entry.gapCount += count;
    if (!entry.gaps.includes(gap)) entry.gaps.push(gap);
    entry.priority = Math.min(entry.priority, base.priority);
    byAction.set(base.action, entry);
  }
  return [...byAction.values()]
    .sort((a, b) => a.priority - b.priority || b.gapCount - a.gapCount || a.action.localeCompare(b.action))
    .slice(0, 8);
}

function countGapEntries(entries = []) {
  const counts = new Map();
  for (const entry of entries) {
    const gaps = Array.isArray(entry?.gaps) ? entry.gaps : [];
    for (const gap of gaps) incrementMap(counts, gap);
  }
  return compactCountMap(counts, 'gap');
}

function chooseActionFocus({ globalGapCounts = [], latestTickWithJudgement = null, recommendationContext = {} } = {}) {
  const latestGapCounts = latestTickWithJudgement?.evidenceGapCounts || [];
  const latestHasEvidenceSummary = Array.isArray(latestTickWithJudgement?.evidenceSummaries)
    && latestTickWithJudgement.evidenceSummaries.length > 0;
  const latestActionableGapCounts = latestGapCounts.filter((item) => item.gap !== 'missing_evidence_summary');
  if (latestHasEvidenceSummary && latestActionableGapCounts.length) {
    return {
      basis: 'latest_tick_actionable_gaps',
      tickId: latestTickWithJudgement.id ?? null,
      evidenceSummaryCount: latestTickWithJudgement.evidenceSummaries.length,
      gapCounts: latestActionableGapCounts,
      recommendedActions: recommendEvidenceGapActions(latestActionableGapCounts, recommendationContext),
    };
  }
  if (latestGapCounts.length) {
    return {
      basis: 'latest_tick_gaps',
      tickId: latestTickWithJudgement?.id ?? null,
      evidenceSummaryCount: Array.isArray(latestTickWithJudgement?.evidenceSummaries) ? latestTickWithJudgement.evidenceSummaries.length : 0,
      gapCounts: latestGapCounts,
      recommendedActions: recommendEvidenceGapActions(latestGapCounts, recommendationContext),
    };
  }
  return {
    basis: 'global_recent_gap_counts',
    tickId: null,
    evidenceSummaryCount: 0,
    gapCounts: globalGapCounts,
    recommendedActions: recommendEvidenceGapActions(globalGapCounts, recommendationContext),
  };
}

function buildPostHintJudgementGate({ live = {}, recentAutoJudgements = {}, now = NOW } = {}) {
  const hints = recentAutoJudgements?.evidenceDecisionHint || {};
  const decisions = recentAutoJudgements?.evidenceDecision || {};
  const nextOpenDueAt = Number(live?.nextOpenDueAt);
  const dueNowOpen = Math.max(0, Math.round(Number(live?.dueNowOpen) || 0));
  const decisiveDecisionCount = countMatchingCompactEntries(
    decisions.labelCounts,
    'label',
    (label) => label === 'action_success_signal' || label === 'action_failure_signal',
  );
  const decisiveHintCount = countMatchingCompactEntries(
    hints.labelCounts,
    'label',
    (label) => label === 'action_success_signal' || label === 'action_failure_signal',
  ) + countMatchingCompactEntries(
    hints.suggestedVerdictCounts,
    'suggestedVerdict',
    (verdict) => verdict === 'APPLIED' || verdict === 'FAILED',
  );
  const waitingForPostHint = decisiveDecisionCount > 0 && decisiveHintCount <= 0;
  const nextOpenDueAtIso = Number.isFinite(nextOpenDueAt) && nextOpenDueAt > 0
    ? new Date(nextOpenDueAt).toISOString()
    : null;
  const secondsUntilNextOpenDue = Number.isFinite(nextOpenDueAt) && nextOpenDueAt > Number(now)
    ? Math.max(0, Math.round((nextOpenDueAt - Number(now)) / 1000))
    : 0;
  return {
    status: waitingForPostHint
      ? (dueNowOpen > 0 ? 'post_hint_due_now' : 'waiting_for_post_hint_natural_judgement')
      : (decisiveHintCount > 0 ? 'post_hint_sample_available' : 'no_decisive_evidence_sample'),
    decisiveEvidenceDecisionCount: decisiveDecisionCount,
    decisiveEvidenceHintCount: decisiveHintCount,
    dueNowOpen,
    nextOpenDueAt: Number.isFinite(nextOpenDueAt) && nextOpenDueAt > 0 ? nextOpenDueAt : null,
    nextOpenDueAtIso,
    secondsUntilNextOpenDue,
    source: 'recent_expectation_ticks_safe_metadata',
    nextStep: waitingForPostHint
      ? 'wait for the next natural expectation tick after evidenceDecisionHint deployment before changing judge or claim/action logic'
      : 'inspect post-hint judgement output before changing settlement behavior',
  };
}

export function formatCalibrationDay(now = NOW, timeZone = TZ) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date(now));
  const m = Object.fromEntries(parts.map((p) => [p.type, p.value]));
  return `${m.year}-${m.month}-${m.day}`;
}

function brier(rows) {
  const scored = rows.filter((r) => r.resolved_at != null && (r.outcome === 0 || r.outcome === 1));
  if (!scored.length) return { n: 0, brier: null, confidentN: 0, confidentHit: null };
  const avg = scored.reduce((sum, r) => sum + (Number(r.p) - Number(r.outcome)) ** 2, 0) / scored.length;
  const confident = scored.filter((r) => Math.max(Number(r.p), 1 - Number(r.p)) >= 0.8);
  const hits = confident.filter((r) => (Number(r.p) >= 0.5) === (Number(r.outcome) === 1)).length;
  return {
    n: scored.length,
    brier: Math.round(avg * 1_000_000) / 1_000_000,
    confidentN: confident.length,
    confidentHit: confident.length ? Math.round((hits / confident.length) * 1000) / 1000 : null,
  };
}

export function isControlledLiveExpectation(row) {
  return CONTROLLED_LIVE_SOURCE_RE.test(String(row?.source || ''));
}

export function summarizeExpectationRows(rows = [], { now = NOW, requiredLiveResolved = REQUIRED_LIVE_RESOLVED } = {}) {
  const total = rows.length;
  const open = rows.filter((r) => r.resolved_at == null);
  const controlledLiveRows = rows.filter(isControlledLiveExpectation);
  const naturalRows = rows.filter((r) => !isControlledLiveExpectation(r));
  const resolvedScored = rows.filter((r) => r.resolved_at != null && (r.outcome === 0 || r.outcome === 1));
  const naturalResolvedScored = naturalRows.filter((r) => r.resolved_at != null && (r.outcome === 0 || r.outcome === 1));
  const controlledLiveResolvedScored = controlledLiveRows.filter((r) => r.resolved_at != null && (r.outcome === 0 || r.outcome === 1));
  const resolvedUnknown = rows.filter((r) => r.resolved_at != null && r.outcome == null);
  const openWithDueAt = open.filter((r) => r.due_at != null);
  const dueNowOpen = openWithDueAt.filter((r) => Number(r.due_at) <= now);
  const futureOpenWithDueAt = openWithDueAt.filter((r) => Number(r.due_at) > now);
  const dueWithin24h = futureOpenWithDueAt.filter((r) => Number(r.due_at) <= now + 86_400_000);
  const dueWithin7d = futureOpenWithDueAt.filter((r) => Number(r.due_at) <= now + 7 * 86_400_000);
  const noDueOpen = open.filter((r) => r.due_at == null);
  const scoredBrier = brier(rows);
  const naturalBrier = brier(naturalRows);
  const controlledLiveBrier = brier(controlledLiveRows);
  const openDueTimes = openWithDueAt.map((r) => Number(r.due_at)).filter(Number.isFinite);
  const nextOpenDueAt = futureOpenWithDueAt.length
    ? Math.min(...futureOpenWithDueAt.map((r) => Number(r.due_at)).filter(Number.isFinite))
    : null;
  const bySource = Object.values(rows.reduce((acc, row) => {
    const key = String(row.source || 'unknown').slice(0, 80) || 'unknown';
    const controlledLive = isControlledLiveExpectation(row);
    acc[key] ||= { source: key, total: 0, resolvedScored: 0, naturalResolvedScored: 0, controlledLiveResolvedScored: 0, open: 0, controlledLive };
    acc[key].total += 1;
    acc[key].controlledLive ||= controlledLive;
    if (row.resolved_at == null) acc[key].open += 1;
    if (row.resolved_at != null && (row.outcome === 0 || row.outcome === 1)) {
      acc[key].resolvedScored += 1;
      if (controlledLive) acc[key].controlledLiveResolvedScored += 1;
      else acc[key].naturalResolvedScored += 1;
    }
    return acc;
  }, {})).sort((a, b) => b.total - a.total).slice(0, 20);
  return {
    total,
    open: open.length,
    // Compatibility: historical reports used dueOpen for "open rows that have a due_at",
    // not "due now"; keep it, but expose explicit names below to avoid unsafe settlement assumptions.
    dueOpen: openWithDueAt.length,
    openWithDueAt: openWithDueAt.length,
    dueNowOpen: dueNowOpen.length,
    overdueOpen: dueNowOpen.length,
    futureOpenWithDueAt: futureOpenWithDueAt.length,
    dueWithin24h: dueWithin24h.length,
    dueWithin7d: dueWithin7d.length,
    noDueOpen: noDueOpen.length,
    resolvedScored: resolvedScored.length,
    naturalRows: naturalRows.length,
    controlledLiveRows: controlledLiveRows.length,
    naturalResolvedScored: naturalResolvedScored.length,
    controlledLiveResolvedScored: controlledLiveResolvedScored.length,
    resolvedUnknown: resolvedUnknown.length,
    liveResolvedRequired: requiredLiveResolved,
    // Long-term readiness is based on natural live evidence only. Controlled,
    // synthetic, fixture, and drill rows prove mechanisms but must not satisfy
    // Noe100 soak/calibration gates.
    liveResolvedRemaining: Math.max(0, requiredLiveResolved - naturalResolvedScored.length),
    naturalLiveResolvedRemaining: Math.max(0, requiredLiveResolved - naturalResolvedScored.length),
    liveCalibrationReady: naturalResolvedScored.length >= requiredLiveResolved,
    naturalLiveCalibrationReady: naturalResolvedScored.length >= requiredLiveResolved,
    resolverActionableNow: dueNowOpen.length > 0,
    nextOpenDueAt,
    hoursUntilNextOpenDue: nextOpenDueAt == null ? null : Math.max(0, Math.round(((nextOpenDueAt - now) / 3_600_000) * 100) / 100),
    oldestOpenDueAt: openDueTimes.length ? Math.min(...openDueTimes) : null,
    newestOpenDueAt: openDueTimes.length ? Math.max(...openDueTimes) : null,
    brier: scoredBrier,
    brierNatural: naturalBrier,
    brierControlledLive: controlledLiveBrier,
    bySource,
  };
}

export function summarizeRecentExpectationTickJudgements(ticks = [], { evidenceSummaryRefresh = null } = {}) {
  const orderedTicks = [...ticks].sort((a, b) => {
    const finishedDiff = Number(b?.finished_at || 0) - Number(a?.finished_at || 0);
    return finishedDiff || Number(b?.id || 0) - Number(a?.id || 0);
  });
  const reasonCounts = new Map();
  const verdictParserCounts = new Map();
  const verdictReasonCodeCounts = new Map();
  const hintAgreementCounts = new Map();
  const evidenceGapCounts = new Map();
  const judgementIdCounts = new Map();
  const outcomeCounts = { applied: 0, failed: 0, unknown: 0 };
  let ticksWithPreviousResult = 0;
  let ticksWithJudgements = 0;
  let judged = 0;
  let resolvedFromResults = 0;
  let latestTickWithJudgement = null;
  const allEvidenceStats = [];
  const allEvidenceSummaries = [];
  const allEvidenceDecisions = [];
  const allEvidenceDecisionHints = [];
  const allEvidenceCandidateSummaries = [];
  const allEvidenceClaimAlignments = [];
  const allReplyStats = [];
  const evidenceRefreshCounts = { attempted: 0, refreshed: 0, changed: 0 };

  for (const tick of orderedTicks) {
    const payload = parseJsonObject(tick?.outcome);
    const candidates = [
      payload.previousResult && typeof payload.previousResult === 'object' ? payload.previousResult : null,
      payload && typeof payload === 'object' ? payload : null,
    ].filter(Boolean);
    let tickJudgements = [];
    let tickChecked = 0;
    let tickResolved = 0;
    let sawPrevious = false;
    for (const result of candidates) {
      if (result === payload.previousResult) sawPrevious = true;
      if (!Array.isArray(result?.judged)) continue;
      tickChecked = Math.max(tickChecked, Number(result.checked) || 0);
      tickResolved = Math.max(tickResolved, Number(result.resolved) || 0);
      tickJudgements = tickJudgements.concat(result.judged);
    }
    if (sawPrevious) ticksWithPreviousResult += 1;
    if (!tickJudgements.length) continue;
    ticksWithJudgements += 1;
    resolvedFromResults += tickResolved;
    const judgedIds = [];
    const reasons = [];
    const verdictParsers = [];
    const verdictReasonCodes = [];
    const hintAgreements = [];
    const tickEvidenceStats = [];
    const tickEvidenceSummaries = [];
    const tickEvidenceDecisions = [];
    const tickEvidenceDecisionHints = [];
    const tickEvidenceCandidateSummaries = [];
    const tickEvidenceClaimAlignments = [];
    const tickEvidenceGaps = [];
    const tickReplyStats = [];
    for (const item of tickJudgements) {
      judged += 1;
      const reason = safeReason(item?.reason);
      reasonCounts.set(reason, (reasonCounts.get(reason) || 0) + 1);
      reasons.push(reason);
      const parser = safeParser(item?.verdictParser);
      if (parser) {
        verdictParserCounts.set(parser, (verdictParserCounts.get(parser) || 0) + 1);
        verdictParsers.push(parser);
      }
      const verdictReasonCode = safeReason(item?.verdictReasonCode || '');
      if (item?.verdictReasonCode) {
        verdictReasonCodeCounts.set(verdictReasonCode, (verdictReasonCodeCounts.get(verdictReasonCode) || 0) + 1);
        verdictReasonCodes.push(verdictReasonCode);
      }
      const hintAgreement = safeReason(item?.hintAgreement || '');
      if (item?.hintAgreement) {
        hintAgreementCounts.set(hintAgreement, (hintAgreementCounts.get(hintAgreement) || 0) + 1);
        hintAgreements.push(hintAgreement);
      }
      if (item?.outcome === 1) outcomeCounts.applied += 1;
      else if (item?.outcome === 0) outcomeCounts.failed += 1;
      else outcomeCounts.unknown += 1;
      const id = Number(item?.id);
      const stat = sanitizeEvidenceStats(item?.evidenceStats);
      if (stat) {
        allEvidenceStats.push(stat);
        tickEvidenceStats.push(Number.isFinite(id) ? { id, ...stat } : stat);
      }
      let evidenceSummary = sanitizeEvidenceSummary(item?.evidenceSummary);
      let evidenceClaimAlignment = sanitizeEvidenceClaimAlignment(item?.evidenceClaimAlignment);
      let evidenceRefresh = null;
      const shouldRefreshEvidenceSummary = Number.isFinite(id)
        && evidenceSummaryRefresh
        && evidenceSummary
        && evidenceSummary.matched > 0
        && !evidenceSummary.hasResultSignal;
      const shouldRefreshClaimAlignment = Number.isFinite(id)
        && evidenceSummaryRefresh
        && evidenceSummary
        && evidenceSummary.matched > 0
        && evidenceClaimAlignmentNeedsRefresh(item?.evidenceClaimAlignment);
      if (shouldRefreshEvidenceSummary || shouldRefreshClaimAlignment) {
        evidenceRefreshCounts.attempted += 1;
        try {
          const refreshed = evidenceSummaryRefresh({ id, evidenceSummary, item });
          if (refreshed?.evidenceSummary) {
            const nextSummary = sanitizeEvidenceSummary(refreshed.evidenceSummary);
            if (nextSummary) {
              evidenceSummary = nextSummary;
            }
          }
          if (refreshed?.evidenceClaimAlignment) {
            const nextAlignment = sanitizeEvidenceClaimAlignment(refreshed.evidenceClaimAlignment);
            if (nextAlignment) evidenceClaimAlignment = nextAlignment;
          }
          if (refreshed?.evidenceSummary || refreshed?.evidenceClaimAlignment) {
            evidenceRefresh = sanitizeEvidenceRefresh(refreshed) || { source: 'unknown_refresh', changed: false };
            evidenceRefreshCounts.refreshed += 1;
            if (evidenceRefresh.changed) evidenceRefreshCounts.changed += 1;
          }
        } catch {}
      }
      if (evidenceSummary) {
        allEvidenceSummaries.push(evidenceSummary);
        tickEvidenceSummaries.push(Number.isFinite(id) ? { id, ...evidenceSummary } : evidenceSummary);
      }
      const evidenceDecision = classifyEvidenceDecisionReadiness(evidenceSummary);
      if (evidenceDecision) {
        allEvidenceDecisions.push(evidenceDecision);
        tickEvidenceDecisions.push(Number.isFinite(id) ? { id, ...evidenceDecision } : evidenceDecision);
      }
      const evidenceDecisionHint = enrichCompactEvidenceDecisionHint({
        hint: sanitizeEvidenceDecisionHint(item?.evidenceDecisionHint),
        evidenceSummary,
        evidenceClaimAlignment,
      });
      if (evidenceDecisionHint) {
        allEvidenceDecisionHints.push(evidenceDecisionHint);
        tickEvidenceDecisionHints.push(Number.isFinite(id) ? { id, ...evidenceDecisionHint } : evidenceDecisionHint);
      }
      const evidenceCandidateSummary = sanitizeEvidenceCandidateSummary(item?.evidenceCandidateSummary);
      if (evidenceCandidateSummary) {
        allEvidenceCandidateSummaries.push(evidenceCandidateSummary);
        tickEvidenceCandidateSummaries.push(Number.isFinite(id) ? { id, ...evidenceCandidateSummary } : evidenceCandidateSummary);
      }
      if (evidenceClaimAlignment) {
        allEvidenceClaimAlignments.push(evidenceClaimAlignment);
        tickEvidenceClaimAlignments.push(Number.isFinite(id) ? { id, ...evidenceClaimAlignment } : evidenceClaimAlignment);
      }
      const replyStat = sanitizeReplyStats(item?.replyStats);
      if (replyStat) {
        allReplyStats.push(replyStat);
        tickReplyStats.push(Number.isFinite(id) ? { id, ...replyStat } : replyStat);
      }
      const evidenceGaps = classifyEvidenceGaps({
        outcome: item?.outcome,
        reason,
        verdictReasonCode: item?.verdictReasonCode,
        hintAgreement: item?.hintAgreement,
        evidenceStats: stat,
        evidenceSummary,
        evidenceDecision,
        evidenceDecisionHint,
        evidenceCandidateSummary,
        evidenceClaimAlignment,
      });
      if (evidenceGaps.length) {
        for (const gap of evidenceGaps) incrementMap(evidenceGapCounts, gap);
        tickEvidenceGaps.push(Number.isFinite(id) ? { id, gaps: evidenceGaps } : { gaps: evidenceGaps });
      }
      if (Number.isFinite(id)) {
        judgedIds.push(id);
        const entry = judgementIdCounts.get(id) || {
          id,
          total: 0,
          unresolved: 0,
          resolved: 0,
          reasons: new Map(),
          verdictParsers: new Map(),
          verdictReasonCodes: new Map(),
          hintAgreements: new Map(),
          evidenceGaps: new Map(),
          latestEvidenceStats: null,
          latestEvidenceSummary: null,
          latestEvidenceDecision: null,
          latestEvidenceDecisionHint: null,
          latestEvidenceCandidateSummary: null,
          latestEvidenceClaimAlignment: null,
          latestEvidenceGaps: [],
          latestReplyStats: null,
          latestEvidenceRefresh: null,
        };
        const isLatestForId = entry.total === 0;
        entry.total += 1;
        if (item?.outcome === 1 || item?.outcome === 0) entry.resolved += 1;
        else entry.unresolved += 1;
        incrementMap(entry.reasons, reason);
        if (parser) incrementMap(entry.verdictParsers, parser);
        if (item?.verdictReasonCode) incrementMap(entry.verdictReasonCodes, verdictReasonCode);
        if (item?.hintAgreement) incrementMap(entry.hintAgreements, hintAgreement);
        for (const gap of evidenceGaps) incrementMap(entry.evidenceGaps, gap);
        if (isLatestForId) {
          entry.latestEvidenceStats = stat;
          entry.latestEvidenceSummary = evidenceSummary;
          entry.latestEvidenceDecision = evidenceDecision;
          entry.latestEvidenceDecisionHint = evidenceDecisionHint;
          entry.latestEvidenceCandidateSummary = evidenceCandidateSummary;
          entry.latestEvidenceClaimAlignment = evidenceClaimAlignment;
          entry.latestEvidenceGaps = evidenceGaps;
          entry.latestReplyStats = replyStat;
          entry.latestEvidenceRefresh = evidenceRefresh;
        }
        judgementIdCounts.set(id, entry);
      }
    }
    if (!latestTickWithJudgement) {
      const tickEvidenceGapCounts = countGapEntries(tickEvidenceGaps);
      latestTickWithJudgement = {
        id: tick?.id ?? null,
        finishedAt: tick?.finished_at ?? null,
        checked: tickChecked,
        resolved: tickResolved,
        judgedIds: judgedIds.slice(0, 12),
        reasons: [...new Set(reasons)].slice(0, 12),
        verdictParsers: [...new Set(verdictParsers)].slice(0, 12),
        verdictReasonCodes: [...new Set(verdictReasonCodes)].slice(0, 12),
        hintAgreements: [...new Set(hintAgreements)].slice(0, 12),
        evidenceStats: tickEvidenceStats.slice(0, 12),
        evidenceSummaries: tickEvidenceSummaries.slice(0, 12),
        evidenceDecisions: tickEvidenceDecisions.slice(0, 12),
        evidenceDecisionCounts: summarizeEvidenceDecisions(tickEvidenceDecisions).labelCounts,
        evidenceDecisionHints: tickEvidenceDecisionHints.slice(0, 12),
        evidenceDecisionHintCounts: summarizeEvidenceDecisionHints(tickEvidenceDecisionHints).labelCounts,
        evidenceCandidateSummaries: tickEvidenceCandidateSummaries.slice(0, 12),
        evidenceClaimAlignments: tickEvidenceClaimAlignments.slice(0, 12),
        evidenceClaimAlignment: summarizeEvidenceClaimAlignments(tickEvidenceClaimAlignments),
        evidenceGaps: tickEvidenceGaps.slice(0, 12),
        evidenceGapCounts: tickEvidenceGapCounts,
        recommendedActions: recommendEvidenceGapActions(tickEvidenceGapCounts),
        replyStats: tickReplyStats.slice(0, 12),
      };
    }
  }

  const evidenceGapCountsSummary = compactCountMap(evidenceGapCounts, 'gap');
  const recommendationContext = {
    decisiveEvidenceDecisionCount: countDecisiveEvidenceDecisions(allEvidenceDecisions),
    decisiveEvidenceHintCount: countDecisiveEvidenceHints(allEvidenceDecisionHints),
  };
  const actionFocus = chooseActionFocus({ globalGapCounts: evidenceGapCountsSummary, latestTickWithJudgement, recommendationContext });

  return {
    ticksScanned: ticks.length,
    ticksWithPreviousResult,
    ticksWithJudgements,
    judged,
    resolvedFromResults,
    outcomeCounts,
    reasonCounts: [...reasonCounts.entries()]
      .map(([reason, count]) => ({ reason, count }))
      .sort((a, b) => b.count - a.count || a.reason.localeCompare(b.reason))
      .slice(0, 20),
    verdictParserCounts: [...verdictParserCounts.entries()]
      .map(([parser, count]) => ({ parser, count }))
      .sort((a, b) => b.count - a.count || a.parser.localeCompare(b.parser))
      .slice(0, 20),
    verdictReasonCodeCounts: compactCountMap(verdictReasonCodeCounts, 'reasonCode'),
    hintAgreementCounts: compactCountMap(hintAgreementCounts, 'hintAgreement'),
    evidenceGapCounts: evidenceGapCountsSummary,
    recommendedActions: recommendEvidenceGapActions(evidenceGapCountsSummary, recommendationContext),
    actionFocus,
    judgementIdCounts: [...judgementIdCounts.values()]
      .map((entry) => ({
        id: entry.id,
        total: entry.total,
        unresolved: entry.unresolved,
        resolved: entry.resolved,
        reasons: compactCountMap(entry.reasons, 'reason'),
        verdictParsers: compactCountMap(entry.verdictParsers, 'parser'),
        ...(entry.verdictReasonCodes.size ? { verdictReasonCodes: compactCountMap(entry.verdictReasonCodes, 'reasonCode') } : {}),
        ...(entry.hintAgreements.size ? { hintAgreements: compactCountMap(entry.hintAgreements, 'hintAgreement') } : {}),
        evidenceGaps: compactCountMap(entry.evidenceGaps, 'gap'),
        ...(entry.latestEvidenceStats ? { latestEvidenceStats: entry.latestEvidenceStats } : {}),
        ...(entry.latestEvidenceSummary ? { latestEvidenceSummary: entry.latestEvidenceSummary } : {}),
        ...(entry.latestEvidenceDecision ? { latestEvidenceDecision: entry.latestEvidenceDecision } : {}),
        ...(entry.latestEvidenceDecisionHint ? { latestEvidenceDecisionHint: entry.latestEvidenceDecisionHint } : {}),
        ...(entry.latestEvidenceCandidateSummary ? { latestEvidenceCandidateSummary: entry.latestEvidenceCandidateSummary } : {}),
        ...(entry.latestEvidenceClaimAlignment ? { latestEvidenceClaimAlignment: entry.latestEvidenceClaimAlignment } : {}),
        ...(entry.latestEvidenceGaps?.length ? { latestEvidenceGaps: entry.latestEvidenceGaps } : {}),
        ...(entry.latestReplyStats ? { latestReplyStats: entry.latestReplyStats } : {}),
        ...(entry.latestEvidenceRefresh ? { latestEvidenceRefresh: entry.latestEvidenceRefresh } : {}),
      }))
      .sort((a, b) => b.unresolved - a.unresolved || b.total - a.total || a.id - b.id)
      .slice(0, 20),
    repeatedUnresolvedIds: [...judgementIdCounts.values()]
      .filter((entry) => entry.unresolved >= 2 && entry.resolved === 0)
      .map((entry) => ({
        id: entry.id,
        unresolved: entry.unresolved,
        reasons: compactCountMap(entry.reasons, 'reason'),
        verdictParsers: compactCountMap(entry.verdictParsers, 'parser'),
        ...(entry.verdictReasonCodes.size ? { verdictReasonCodes: compactCountMap(entry.verdictReasonCodes, 'reasonCode') } : {}),
        ...(entry.hintAgreements.size ? { hintAgreements: compactCountMap(entry.hintAgreements, 'hintAgreement') } : {}),
        evidenceGaps: compactCountMap(entry.evidenceGaps, 'gap'),
        ...(entry.latestEvidenceStats ? { latestEvidenceStats: entry.latestEvidenceStats } : {}),
        ...(entry.latestEvidenceSummary ? { latestEvidenceSummary: entry.latestEvidenceSummary } : {}),
        ...(entry.latestEvidenceDecision ? { latestEvidenceDecision: entry.latestEvidenceDecision } : {}),
        ...(entry.latestEvidenceDecisionHint ? { latestEvidenceDecisionHint: entry.latestEvidenceDecisionHint } : {}),
        ...(entry.latestEvidenceCandidateSummary ? { latestEvidenceCandidateSummary: entry.latestEvidenceCandidateSummary } : {}),
        ...(entry.latestEvidenceClaimAlignment ? { latestEvidenceClaimAlignment: entry.latestEvidenceClaimAlignment } : {}),
        ...(entry.latestEvidenceGaps?.length ? { latestEvidenceGaps: entry.latestEvidenceGaps } : {}),
        ...(entry.latestReplyStats ? { latestReplyStats: entry.latestReplyStats } : {}),
        ...(entry.latestEvidenceRefresh ? { latestEvidenceRefresh: entry.latestEvidenceRefresh } : {}),
      }))
      .sort((a, b) => b.unresolved - a.unresolved || a.id - b.id)
      .slice(0, 20),
    evidenceStats: summarizeEvidenceStats(allEvidenceStats),
    evidenceSummary: summarizeEvidenceSummaries(allEvidenceSummaries),
    evidenceDecision: summarizeEvidenceDecisions(allEvidenceDecisions),
    evidenceDecisionHint: summarizeEvidenceDecisionHints(allEvidenceDecisionHints),
    evidenceCandidateSummary: summarizeEvidenceCandidateSummaries(allEvidenceCandidateSummaries),
    evidenceClaimAlignment: summarizeEvidenceClaimAlignments(allEvidenceClaimAlignments),
    replyStats: summarizeReplyStats(allReplyStats),
    evidenceRefresh: evidenceRefreshCounts,
    latestTickWithJudgement,
  };
}

function latestControlledDrill() {
  const hit = latestJsonFile(join(ROOT, 'output', 'noe-expectation-settlement-drill'), (f) => /\/report\.json$/.test(f));
  const j = hit.json;
  const ok = Boolean(
    j?.ok === true
    && j?.liveDbMutated === false
    && Number(j?.sampleCount || 0) >= 20
    && Number(j?.resolvedCount || 0) >= 20
    && Number(j?.unresolvedCount || 0) === 0
    && Number.isFinite(Number(j?.brier?.brier))
  );
  return {
    exists: Boolean(j),
    ok,
    reportPath: hit.file ? rel(hit.file) : '',
    sampleCount: Number(j?.sampleCount || 0),
    resolvedCount: Number(j?.resolvedCount || 0),
    unresolvedCount: Number(j?.unresolvedCount || 0),
    liveDbMutated: j?.liveDbMutated === true,
    brier: j?.brier || null,
  };
}

async function readExpectationRows(dbPath = DB_PATH) {
  if (!existsSync(dbPath)) return { exists: false, rows: [], error: 'db_missing' };
  const { default: Database } = await import('better-sqlite3');
  const db = new Database(dbPath, { readonly: true });
  try {
    const rows = db.prepare('SELECT id, claim, created_at, source, p, due_at, resolved_at, outcome, surprise FROM noe_expectations ORDER BY id ASC').all();
    return { exists: true, rows, error: '' };
  } catch (e) {
    return { exists: true, rows: [], error: e?.message || String(e) };
  } finally {
    try { db.close(); } catch {}
  }
}

async function createReadOnlyEvidenceSummaryRefresh({ dbPath = DB_PATH, rows = [] } = {}) {
  if (!existsSync(dbPath)) return null;
  const { default: Database } = await import('better-sqlite3');
  const db = new Database(dbPath, { readonly: true });
  const byId = new Map(rows
    .filter((row) => Number.isFinite(Number(row?.id)) && row?.claim && row?.created_at != null)
    .map((row) => [Number(row.id), row]));
  let stmt = null;
  let actsStmt = null;
  let checkpointsStmt = null;
  try {
    stmt = db.prepare('SELECT id, ts, kind, payload FROM events WHERE ts >= ? ORDER BY ts ASC LIMIT ?');
    try {
      actsStmt = db.prepare('SELECT id, title, action, status, evidence_event_id, log_ref, payload, updated_at FROM noe_acts WHERE updated_at >= ? ORDER BY updated_at ASC LIMIT ?');
    } catch { actsStmt = null; }
    try {
      checkpointsStmt = db.prepare("SELECT id, ts, phase, status, kind, action, evidence_ref, payload FROM noe_goal_checkpoints WHERE kind = 'act' AND ts >= ? ORDER BY ts ASC LIMIT ?");
    } catch { checkpointsStmt = null; }
  } catch {
    try { db.close(); } catch {}
    return null;
  }
  const parsePayload = (raw) => {
    try {
      const parsed = JSON.parse(String(raw || '{}'));
      return parsed && typeof parsed === 'object' ? parsed : {};
    } catch { return {}; }
  };
  const readActionEvidenceRows = (since) => {
    const rows = [];
    try {
      for (const row of actsStmt?.all(since, 100) || []) {
        const evidenceRow = buildNoeActExpectationEvidenceRow({
          ...row,
          payload: parsePayload(row.payload),
        }, { sinceTs: since });
        if (evidenceRow) rows.push(evidenceRow);
      }
    } catch {}
    try {
      for (const row of checkpointsStmt?.all(since, 100) || []) {
        const evidenceRow = buildGoalCheckpointExpectationEvidenceRow({
          ...row,
          payload: parsePayload(row.payload),
        }, { sinceTs: since });
        if (evidenceRow) rows.push(evidenceRow);
      }
    } catch {}
    return rows;
  };
  const refresh = ({ id, evidenceSummary, item }) => {
    const exp = byId.get(Number(id));
    if (!exp) return null;
    const grams = [...buildClaimLinkNeedles(exp.claim)];
    if (!grams.length) return null;
    const claimGrams = grams.filter((gram) => !String(gram || '').startsWith('safe:')).length;
    const minHits = claimGrams >= 6 ? 2 : 1;
    const since = Number(exp.created_at) || 0;
    const rows = [
      ...stmt.all(since, 200).map((row) => ({ ...row, payload: parsePayload(row.payload) })),
      ...readActionEvidenceRows(since),
    ].sort((a, b) => Number(a.ts || 0) - Number(b.ts || 0));
    const matched = [];
    for (const ev of rows) {
      const text = payloadText(ev.payload);
      const link = scoreCandidateClaimLink(ev.payload, grams, minHits);
      const hits = Math.max(
        Number(link.hits || 0),
        Number(link.semanticHits || 0),
        Number(link.semanticTraceHits || 0),
      );
      if (hits < minHits) continue;
      matched.push({ ev, text, hits, link });
    }
    if (!matched.length) return null;
    const rankedMatched = selectClaimLinkedEvidenceMatches(matched, 8);
    const kindCounts = new Map();
    const signalCounts = new Map();
    for (const item of rankedMatched) {
      const kind = String(item.ev?.kind || 'event').slice(0, 60);
      kindCounts.set(kind, (kindCounts.get(kind) || 0) + 1);
      for (const signal of summarizePayloadSignals(item.ev?.payload)) {
        signalCounts.set(signal, (signalCounts.get(signal) || 0) + 1);
      }
    }
    const refreshed = buildEvidenceSummary({ rows, matched: rankedMatched, kindCounts, signalCounts });
    const evidenceClaimAlignment = buildEvidenceClaimAlignment({ matched: rankedMatched, grams, minHits });
    const before = JSON.stringify(evidenceSummary || null);
    const after = JSON.stringify(refreshed || null);
    const beforeAlignment = JSON.stringify(sanitizeEvidenceClaimAlignment(item?.evidenceClaimAlignment) || null);
    const afterAlignment = JSON.stringify(evidenceClaimAlignment || null);
    return {
      source: 'read_only_live_events',
      changed: before !== after || beforeAlignment !== afterAlignment,
      evidenceSummary: refreshed,
      evidenceClaimAlignment,
    };
  };
  return {
    refresh,
    close() { try { db.close(); } catch {} },
  };
}

async function readRecentExpectationTicks(dbPath = DB_PATH, limit = RECENT_TICK_LIMIT) {
  if (!existsSync(dbPath)) return { exists: false, ticks: [], error: 'db_missing' };
  const { default: Database } = await import('better-sqlite3');
  const db = new Database(dbPath, { readonly: true });
  try {
    const n = Math.max(1, Math.min(200, Number(limit) || RECENT_TICK_LIMIT));
    const ticks = db.prepare(
      "SELECT id, finished_at, outcome FROM noe_ticks WHERE kind='expectation' ORDER BY id DESC LIMIT ?",
    ).all(n);
    return { exists: true, ticks, error: '' };
  } catch (e) {
    return { exists: true, ticks: [], error: e?.message || String(e) };
  } finally {
    try { db.close(); } catch {}
  }
}

export function buildExpectationCalibrationSnapshot({
  now = NOW,
  day = formatCalibrationDay(now),
  dbPath = DB_PATH,
  dbExists = true,
  dbError = '',
  rows = [],
  recentExpectationTicks = [],
  recentExpectationTicksError = '',
  controlledDrill = latestControlledDrill(),
  requiredLiveResolved = REQUIRED_LIVE_RESOLVED,
  evidenceSummaryRefresh = null,
} = {}) {
  const live = summarizeExpectationRows(rows, { now, requiredLiveResolved });
  const recentAutoJudgements = summarizeRecentExpectationTickJudgements(recentExpectationTicks, { evidenceSummaryRefresh });
  const postHintJudgementGate = buildPostHintJudgementGate({ live, recentAutoJudgements, now });
  const blockers = [];
  if (!dbExists) blockers.push('expectation_db_missing');
  if (dbError) blockers.push('expectation_db_read_error');
  if (!live.liveCalibrationReady) blockers.push('live_expectation_resolved_below_20');
  if (live.overdueOpen > 0) blockers.push('live_expectation_overdue_open');
  const warnings = [];
  if (controlledDrill.ok && !live.liveCalibrationReady) warnings.push('controlled_drill_ready_but_live_calibration_not_ready');
  if (!controlledDrill.ok) warnings.push('controlled_expectation_drill_missing_or_failed');
  if (live.controlledLiveRows > 0) warnings.push('controlled_live_expectations_excluded_from_live_calibration');
  if (recentExpectationTicksError) warnings.push('recent_expectation_tick_read_error');
  return {
    ok: true,
    generatedAt: new Date(now).toISOString(),
    day,
    policy: {
      readOnly: true,
      noDbWrites: true,
      noModelCalls: true,
      noOwnerToken: true,
      noClaimTextOutput: true,
      lmStudioLoadUnloadChanged: false,
    },
    status: {
      liveCalibrationReady: live.liveCalibrationReady,
      naturalLiveCalibrationReady: live.naturalLiveCalibrationReady,
      controlledMechanismReady: controlledDrill.ok === true,
      readyForLongTermCalibration: live.liveCalibrationReady && live.brierNatural.n >= requiredLiveResolved,
      blockers,
      warnings,
    },
    live,
    recentAutoJudgements,
    postHintJudgementGate,
    controlledDrill,
    source: {
      dbPath,
      dbExists,
      dbError,
      recentExpectationTicksError,
      note: 'Live claims are intentionally not exported; counts and calibration metrics only.',
    },
    evidenceRefs: [
      { file: dbPath, note: 'live noe_expectations counts and Brier; read-only' },
      controlledDrill.reportPath ? { file: controlledDrill.reportPath, note: 'controlled isolated settlement drill; separate from live calibration' } : null,
    ].filter(Boolean),
  };
}

export function writeExpectationCalibrationSnapshot(snapshot, { outDir = OUT_DIR } = {}) {
  const dayDir = join(outDir, snapshot.day);
  mkdirSync(dayDir, { recursive: true, mode: 0o700 });
  const reportPath = join(dayDir, 'report.json');
  const latestPath = join(outDir, 'latest.json');
  const body = `${JSON.stringify(snapshot, null, 2)}\n`;
  writeFileSync(reportPath, body, { mode: 0o600 });
  writeFileSync(latestPath, body, { mode: 0o600 });
  return { reportPath: rel(reportPath), latestPath: rel(latestPath) };
}

export async function main() {
  const db = await readExpectationRows();
  const recentTicks = await readRecentExpectationTicks();
  const refresh = await createReadOnlyEvidenceSummaryRefresh({ rows: db.rows });
  try {
    const snapshot = buildExpectationCalibrationSnapshot({
      dbExists: db.exists,
      dbError: db.error,
      rows: db.rows,
      recentExpectationTicks: recentTicks.ticks,
      recentExpectationTicksError: recentTicks.error,
      evidenceSummaryRefresh: refresh?.refresh || null,
    });
    const paths = writeExpectationCalibrationSnapshot(snapshot);
    console.log(JSON.stringify({ ...snapshot, ...paths }, null, 2));
  } finally {
    refresh?.close?.();
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  main().catch((e) => {
    console.error(e?.stack || e?.message || String(e));
    process.exit(1);
  });
}
