// @ts-check

import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';

export const NOE_EVOLUTION_ARCHIVE_SCHEMA_VERSION = 1;

const VARIANT_VERDICTS = new Set(['tests_passed', 'tests_failed', 'applied']);

function clean(value, max = 500) {
  return String(value ?? '').trim().slice(0, max);
}

function safeId(value, fallback = '') {
  return clean(value, 160).replace(/[^A-Za-z0-9_.:-]+/g, '-').replace(/^-+|-+$/g, '') || fallback;
}

function sha12(value) {
  return createHash('sha1').update(String(value || '')).digest('hex').slice(0, 12);
}

export function createNoeEvolutionVariantId({ ts = Date.now(), proposal = '', plan = {}, patchFile = '' } = {}) {
  const file = plan?.file || '';
  return `dgm-${new Date(Number(ts) || Date.now()).toISOString().replace(/[:.]/g, '-')}-${sha12(`${proposal}\n${file}\n${patchFile}`)}`;
}

export function readLatestNoeEvolutionVariant({ archivePath = '' } = {}) {
  if (!archivePath || !existsSync(archivePath)) return null;
  const lines = readFileSync(archivePath, 'utf8').split(/\r?\n/).reverse();
  for (const line of lines) {
    if (!line.trim()) continue;
    let item;
    try { item = JSON.parse(line); } catch { continue; }
    const childId = safeId(item.childId || item.variantId || item.lineage?.childId || '');
    if (childId) {
      return {
        variantId: childId,
        parentId: safeId(item.parentId || item.lineage?.parentId || ''),
        generation: Math.max(0, Number(item.generation ?? item.lineage?.generation) || 0),
      };
    }
  }
  return null;
}

export function buildNoeEvolutionArchiveEntry({
  ts = Date.now(),
  archivePath = '',
  proposal = '',
  verdict = '',
  why = '',
  plan = null,
  patchFile = '',
  applied = undefined,
  parentId = '',
  variantId = '',
  holdoutRef = '',
  benchmarkRef = '',
  extra = {},
} = {}) {
  const safeVerdict = safeId(verdict, 'unknown');
  const isVariant = VARIANT_VERDICTS.has(safeVerdict);
  const latest = parentId ? null : readLatestNoeEvolutionVariant({ archivePath });
  const childId = isVariant
    ? safeId(variantId, createNoeEvolutionVariantId({ ts, proposal, plan: plan || {}, patchFile }))
    : '';
  const sameAsLatest = Boolean(childId && latest?.variantId === childId);
  const resolvedParentId = isVariant ? safeId(parentId, sameAsLatest ? latest?.parentId || '' : latest?.variantId || '') : '';
  const generation = isVariant ? (sameAsLatest ? Math.max(1, Number(latest?.generation) || 1) : Math.max(0, Number(latest?.generation) || 0) + 1) : undefined;
  const entry = {
    schemaVersion: NOE_EVOLUTION_ARCHIVE_SCHEMA_VERSION,
    kind: 'noe_evolution_archive_entry',
    ts: Number(ts) || Date.now(),
    proposal: clean(proposal, 2000),
    verdict: safeVerdict,
    ...extra,
  };
  if (why) entry.why = clean(why, 1000);
  if (plan && typeof plan === 'object') {
    entry.plan = {
      file: clean(plan.file, 240),
      why: clean(plan.why, 1000),
      startLine: Number.isInteger(Number(plan.startLine)) ? Number(plan.startLine) : undefined,
      endLine: Number.isInteger(Number(plan.endLine)) ? Number(plan.endLine) : undefined,
    };
  }
  if (patchFile) entry.patchFile = clean(patchFile, 1000);
  if (applied !== undefined) entry.applied = Boolean(applied);
  if (isVariant) {
    entry.variantId = childId;
    entry.parentId = resolvedParentId;
    entry.childId = childId;
    entry.generation = generation;
    entry.lineage = { parentId: resolvedParentId, childId, generation };
  }
  if (holdoutRef) entry.holdout = { reportRef: clean(holdoutRef, 1000) };
  if (benchmarkRef) entry.benchmark = { reportRef: clean(benchmarkRef, 1000) };
  return entry;
}
