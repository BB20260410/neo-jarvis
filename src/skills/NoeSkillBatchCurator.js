// @ts-check
/**
 * Small-batch enable → measure → prune for distilled skills.
 * Never bulk-enables all drafts; dry-run by default.
 */

import { redactSensitiveText } from '../runtime/NoeContextScrubber.js';

export const SKILL_BATCH_SCHEMA_VERSION = 1;

function clean(v, max = 200) {
  return redactSensitiveText(String(v || '').trim()).slice(0, max);
}

/**
 * Select a small batch of disabled skills to enable for trial.
 * @param {Array<object>} skills skill store list
 * @param {object} [opts]
 * @param {number} [opts.batchSize] default 3
 * @param {number} [opts.nowMs]
 * @param {(s:object)=>boolean} [opts.isDistilled] filter distilled-only
 */
export function planSkillBatchEnable(skills = [], {
  batchSize = 3,
  nowMs = Date.now(),
  isDistilled = (s) => {
    const src = String(s?.source || s?.extra?.source || s?.extra?.origin || '');
    const name = String(s?.name || '');
    return /distill|auto|extract|learned|goal_distill/i.test(src)
      || /distill|learned|auto-skill/i.test(name)
      || s?.extra?.distilled === true
      || s?.distilled === true
      // Disabled skills with empty source still eligible if caller marks all-disabled batch
      || (s?.enabled === false && s?.extra?.curator === 'distill');
  },
} = {}) {
  const size = Math.max(1, Math.min(20, Number(batchSize) || 3));
  const candidates = (Array.isArray(skills) ? skills : [])
    .filter((s) => s && s.enabled === false)
    .filter((s) => isDistilled(s))
    .map((s) => ({
      name: clean(s.name, 120),
      updatedAt: s.updatedAt || s.updated_at || null,
      score: Number(s.score || s.extra?.score || 0) || 0,
      hitCount: Number(s.hitCount || s.extra?.hitCount || 0) || 0,
    }))
    .filter((s) => s.name)
    // Prefer newer + slight score; never require score to avoid starving empty metrics
    .sort((a, b) => {
      const tb = Date.parse(b.updatedAt || 0) || 0;
      const ta = Date.parse(a.updatedAt || 0) || 0;
      if (tb !== ta) return tb - ta;
      return (b.score || 0) - (a.score || 0);
    });

  return {
    schemaVersion: SKILL_BATCH_SCHEMA_VERSION,
    kind: 'skill_batch_enable_plan',
    nowMs,
    batchSize: size,
    selected: candidates.slice(0, size),
    skipped: Math.max(0, candidates.length - size),
    totalDisabledDistilled: candidates.length,
  };
}

/**
 * Measure trial skills: prune those with zero help signals after trial window.
 * @param {Array<object>} skills
 * @param {object} [opts]
 * @param {number} [opts.minHits] hits required to keep (default 1)
 * @param {number} [opts.trialMs] age since enabledAt / trialStartedAt
 * @param {number} [opts.nowMs]
 */
export function planSkillBatchPrune(skills = [], {
  minHits = 1,
  trialMs = 7 * 24 * 3600_000,
  nowMs = Date.now(),
} = {}) {
  const min = Math.max(0, Number(minHits) || 1);
  const window = Math.max(60_000, Number(trialMs) || 7 * 24 * 3600_000);
  const prune = [];
  const keep = [];
  for (const s of Array.isArray(skills) ? skills : []) {
    if (!s || s.enabled !== true) continue;
    const trial = s.extra?.trialBatch === true || s.trialBatch === true;
    if (!trial) continue;
    const started = Date.parse(s.extra?.trialStartedAt || s.trialStartedAt || s.updatedAt || 0) || 0;
    const age = started ? nowMs - started : window + 1;
    const hits = Number(s.hitCount || s.extra?.hitCount || s.extra?.helpCount || 0) || 0;
    const name = clean(s.name, 120);
    if (!name) continue;
    if (age >= window && hits < min) {
      prune.push({ name, hits, ageMs: age, reason: 'trial_no_help' });
    } else {
      keep.push({ name, hits, ageMs: age, reason: hits >= min ? 'helping' : 'still_in_trial' });
    }
  }
  return {
    schemaVersion: SKILL_BATCH_SCHEMA_VERSION,
    kind: 'skill_batch_prune_plan',
    nowMs,
    minHits: min,
    trialMs: window,
    prune,
    keep,
  };
}

/**
 * Apply enable/prune plans against a skill store-like API.
 * @param {object} plan
 * @param {{ setEnabled?: (name:string, enabled:boolean, meta?:object)=>any, dryRun?: boolean, nowMs?: number }} deps
 */
export function applySkillBatchPlan(plan, {
  setEnabled = null,
  dryRun = true,
  nowMs = Date.now(),
} = {}) {
  const actions = [];
  if (plan?.kind === 'skill_batch_enable_plan') {
    for (const item of plan.selected || []) {
      if (dryRun) {
        actions.push({ name: item.name, action: 'would_enable' });
        continue;
      }
      try {
        setEnabled?.(item.name, true, {
          trialBatch: true,
          trialStartedAt: new Date(nowMs).toISOString(),
        });
        actions.push({ name: item.name, action: 'enabled' });
      } catch (e) {
        actions.push({ name: item.name, action: 'error', error: e?.message || String(e) });
      }
    }
  } else if (plan?.kind === 'skill_batch_prune_plan') {
    for (const item of plan.prune || []) {
      if (dryRun) {
        actions.push({ name: item.name, action: 'would_disable', reason: item.reason });
        continue;
      }
      try {
        setEnabled?.(item.name, false, { trialBatch: false, prunedReason: item.reason });
        actions.push({ name: item.name, action: 'disabled', reason: item.reason });
      } catch (e) {
        actions.push({ name: item.name, action: 'error', error: e?.message || String(e) });
      }
    }
  }
  return { dryRun: !!dryRun, actions };
}
