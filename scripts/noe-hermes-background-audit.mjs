#!/usr/bin/env node
// @ts-check
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = join(ROOT, 'output', 'noe-hermes-background-audit');

function clean(value, max = 1000) {
  return String(value ?? '').trim().slice(0, max);
}

function rel(file, root = ROOT) {
  return relative(root, file).replace(/\\/g, '/');
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

function timestampFrom(file, json = {}) {
  const raw = json.generatedAt || json.finishedAt || json.createdAt || json.startedAt || json.at || '';
  const parsed = Date.parse(raw);
  if (Number.isFinite(parsed)) return parsed;
  try { return statSync(file).mtimeMs; } catch { return 0; }
}

function jsonRecords(root, dir, predicate, category, summarize) {
  return walk(join(root, dir))
    .filter((file) => file.endsWith('.json') && predicate(file))
    .map((file) => {
      const json = readJson(file);
      if (!json) return null;
      return {
        category,
        ref: rel(file, root),
        at: timestampFrom(file, json),
        ok: json.ok !== false,
        summary: summarize(json),
      };
    })
    .filter(Boolean);
}

export function collectHermesBackgroundEvidence({ root = ROOT } = {}) {
  const records = [];
  records.push(...jsonRecords(
    root,
    'output/noe-missions',
    (file) => /\/artifacts\/finalization-[^/]+\.json$/.test(file),
    'mission_finalization',
    (json) => ({ status: clean(json.status || json.finalStatus || '', 80), explanation: clean(json.completionExplanation || json.explanation || '', 240) }),
  ));
  records.push(...jsonRecords(
    root,
    'output/noe-background-review',
    () => true,
    'background_review',
    (json) => ({ proposalCount: Array.isArray(json.proposals) ? json.proposals.length : 0, riskCount: Array.isArray(json.risks) ? json.risks.length : 0 }),
  ));
  records.push(...jsonRecords(
    root,
    'output/noe-skill-curator/reports',
    () => true,
    'skill_curator',
    (json) => ({
      pruned: Array.isArray(json.pruned) ? json.pruned.length : 0,
      consolidated: Array.isArray(json.consolidated) ? json.consolidated.length : 0,
      stateTransitions: Array.isArray(json.stateTransitions) ? json.stateTransitions.length : 0,
    }),
  ));
  records.push(...jsonRecords(
    root,
    'output/noe-ecosystem-install-2026-06-12',
    (file) => file.endsWith('lancedb-memory-poc.json'),
    'memory_provider',
    (json) => ({
      defaultExternalEnabled: json.defaultOff?.status?.externalEnabled === true,
      lancedbProcessed: Number(json.lancedb?.drain?.processed || 0),
      wikiRecallCount: Array.isArray(json.wiki?.recall) ? json.wiki.recall.length : 0,
    }),
  ));
  records.push(...jsonRecords(
    root,
    'output/noe-evolution-holdout',
    () => true,
    'candidate_holdout',
    (json) => ({ caseCount: Number(json.caseCount || 0), delta: Number(json.delta || 0), errorCount: Array.isArray(json.errors) ? json.errors.length : 0 }),
  ));
  records.push(...jsonRecords(
    root,
    'output/noe-patch-transactions/drills',
    (file) => /\/drill-report\.json$/.test(file),
    'patch_apply_chain',
    (json) => ({
      status: clean(json.status || '', 80),
      dryRunReady: json.gates?.dryRunReady === true,
      unconfirmedBlocked: json.gates?.unconfirmedBlocked === true,
      confirmedApplyWroteTarget: json.gates?.confirmedApplyWroteTarget === true,
      confirmedRollbackRemovedTarget: json.gates?.confirmedRollbackRemovedTarget === true,
      secretValuesReturned: json.gates?.secretValuesReturned === true,
      targetExistsAfterRollback: json.safety?.targetExistsAfterRollback === true,
    }),
  ));
  return records.sort((a, b) => a.at - b.at);
}

export function buildHermesBackgroundAudit({
  now = Date.now(),
  windowHours = 24,
  records = [],
} = {}) {
  const windowMs = Math.max(1, Number(windowHours) || 24) * 60 * 60 * 1000;
  const cutoff = now - windowMs;
  const inWindow = records.filter((record) => Number(record.at || 0) >= cutoff && Number(record.at || 0) <= now);
  const firstAt = inWindow.length ? Math.min(...inWindow.map((record) => record.at)) : null;
  const lastAt = inWindow.length ? Math.max(...inWindow.map((record) => record.at)) : null;
  const observedHours = firstAt !== null && lastAt !== null ? (lastAt - firstAt) / 3_600_000 : 0;
  const categories = {};
  for (const record of inWindow) {
    const entry = categories[record.category] || { count: 0, okCount: 0, failedCount: 0, refs: [] };
    entry.count += 1;
    if (record.ok) entry.okCount += 1;
    else entry.failedCount += 1;
    if (entry.refs.length < 8) entry.refs.push(record.ref);
    categories[record.category] = entry;
  }
  const requiredCategories = ['mission_finalization', 'background_review', 'skill_curator', 'memory_provider', 'candidate_holdout', 'patch_apply_chain'];
  const missingCategories = requiredCategories.filter((category) => !categories[category]?.count);
  const durationReady = observedHours >= Number(windowHours) * 0.95;
  const blockers = [
    ...(!durationReady ? [`insufficient_observation_window:${Math.round(observedHours * 100) / 100}/${windowHours}`] : []),
    ...missingCategories.map((category) => `missing_category:${category}`),
  ];
  return {
    ok: true,
    generatedAt: new Date(now).toISOString(),
    windowHours: Number(windowHours),
    status: blockers.length ? 'blocked' : 'passed',
    blockers,
    observed: {
      recordCount: inWindow.length,
      firstAt: firstAt ? new Date(firstAt).toISOString() : '',
      lastAt: lastAt ? new Date(lastAt).toISOString() : '',
      observedHours,
    },
    categories,
    note: blockers.length
      ? 'Audit snapshot generated; this does not prove a full 24h background run yet.'
      : 'All required categories have evidence across the requested observation window.',
  };
}

export function writeHermesBackgroundAudit(report, { root = ROOT, outDir = OUT_DIR } = {}) {
  mkdirSync(outDir, { recursive: true });
  const reportPath = join(outDir, `audit-${Date.now()}.json`);
  const latestPath = join(outDir, 'latest.json');
  writeFileSync(reportPath, JSON.stringify(report, null, 2));
  writeFileSync(latestPath, JSON.stringify(report, null, 2));
  return { reportPath: rel(reportPath, root), latestPath: rel(latestPath, root) };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const records = collectHermesBackgroundEvidence({ root: ROOT });
  const report = buildHermesBackgroundAudit({ records, windowHours: Number(process.env.NOE_HERMES_AUDIT_WINDOW_HOURS || 24) });
  const paths = writeHermesBackgroundAudit(report);
  console.log(JSON.stringify({ ...report, paths }, null, 2));
}
