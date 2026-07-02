import { existsSync, readFileSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import { atomicWriteFile } from '../state/atomicJsonFile.js';
import { redactSensitiveText } from '../runtime/NoeContextScrubber.js';

export const SKILL_CURATOR_SCHEMA_VERSION = 1;

function clean(value, max = 1000) {
  return redactSensitiveText(String(value || '').trim()).slice(0, max);
}

function ageDays(updatedAt, nowMs) {
  const ts = Date.parse(updatedAt || 0);
  if (!Number.isFinite(ts)) return Infinity;
  return Math.max(0, Math.floor((nowMs - ts) / 86_400_000));
}

function isPinned(skill = {}) {
  return skill.pinned === true || skill.extra?.pinned === 'true' || skill.extra?.curator === 'pinned';
}

export function classifySkillForCurator(skill = {}, {
  nowMs = Date.now(),
  staleDays = 30,
  archiveDays = 90,
} = {}) {
  const days = ageDays(skill.updatedAt, nowMs);
  if (isPinned(skill)) return { state: 'pinned', daysInactive: days, action: 'keep' };
  if (days >= archiveDays) return { state: 'archive_candidate', daysInactive: days, action: 'propose_archive' };
  if (days >= staleDays) return { state: 'stale', daysInactive: days, action: 'propose_review' };
  return { state: 'active', daysInactive: days, action: 'keep' };
}

function loadState(stateFile) {
  if (!stateFile || !existsSync(stateFile)) return {};
  try { return JSON.parse(readFileSync(stateFile, 'utf8')); } catch { return {}; }
}

function saveState(stateFile, state) {
  atomicWriteFile(stateFile, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
}

function toRef(file) {
  if (!file) return null;
  const abs = resolve(file);
  const rel = relative(process.cwd(), abs);
  if (rel && !rel.startsWith('..') && rel !== '..' && !rel.startsWith('/')) return rel.replaceAll('\\', '/');
  return abs;
}

function snapshotSkill(skill = {}) {
  return {
    name: clean(skill.name, 120),
    displayName: clean(skill.displayName || skill.name, 240),
    description: clean(skill.description, 500),
    updatedAt: skill.updatedAt || null,
    pinned: isPinned(skill),
  };
}

function writeSnapshot(snapshotFile, report, skills) {
  if (!snapshotFile) return null;
  const file = resolve(snapshotFile);
  const snapshot = {
    schemaVersion: SKILL_CURATOR_SCHEMA_VERSION,
    kind: 'noe_skill_curator_snapshot',
    createdAt: report.createdAt,
    dryRun: report.dryRun,
    recoverable: true,
    directSkillMutations: [],
    skills: skills.map(snapshotSkill).filter((skill) => skill.name),
  };
  atomicWriteFile(file, `${JSON.stringify(snapshot, null, 2)}\n`, { mode: 0o600 });
  return toRef(file);
}

function findConsolidationCandidates(items) {
  const groups = new Map();
  for (const item of items) {
    const key = clean(item.displayName || item.name, 240).toLowerCase().replace(/[^a-z0-9\u4e00-\u9fa5]+/g, ' ').trim();
    if (!key) continue;
    const group = groups.get(key) || [];
    group.push(item.name);
    groups.set(key, group);
  }
  return Array.from(groups.entries())
    .filter(([, names]) => names.length > 1)
    .map(([key, names]) => ({
      key,
      skills: names,
      action: 'propose_consolidation',
      destructive: false,
    }));
}

function buildStateTransitions(items) {
  return items
    .filter((item) => item.previousState && item.previousState !== item.state)
    .map((item) => ({
      name: item.name,
      from: item.previousState,
      to: item.state,
      action: item.action,
      destructive: false,
    }));
}

function buildRecoveryInstructions({ stateFile, snapshotRef, dryRun }) {
  const out = [
    'No skill files are deleted or archived by this curator report.',
    'Treat archive_candidate and consolidation entries as proposals until an explicit gated apply path exists.',
  ];
  if (snapshotRef) out.push(`Recover candidate review context from ${snapshotRef}.`);
  if (stateFile && dryRun === false) {
    out.push(`If curator state is wrong, restore ${toRef(stateFile)} from its .bak-latest backup or rerun dry-run with the snapshot.`);
  }
  return out;
}

export function runSkillCurator({
  skills = [],
  stateFile = '',
  snapshotFile = '',
  dryRun = true,
  now = new Date(),
  staleDays = 30,
  archiveDays = 90,
} = {}) {
  const nowMs = now instanceof Date ? now.getTime() : Date.parse(now);
  const previous = stateFile ? loadState(resolve(stateFile)) : {};
  const report = {
    schemaVersion: SKILL_CURATOR_SCHEMA_VERSION,
    createdAt: new Date(nowMs).toISOString(),
    dryRun: dryRun !== false,
    recoverable: true,
    directSkillMutations: [],
    counts: { pinned: 0, active: 0, stale: 0, archive_candidate: 0 },
    items: [],
    consolidated: [],
    pruned: [],
    stateTransitions: [],
    snapshotRef: null,
    recoveryInstructions: [],
  };
  for (const skill of skills) {
    const name = clean(skill.name, 120);
    if (!name) continue;
    const classification = classifySkillForCurator(skill, { nowMs, staleDays, archiveDays });
    report.counts[classification.state] = (report.counts[classification.state] || 0) + 1;
    report.items.push({
      name,
      displayName: clean(skill.displayName || name, 240),
      description: clean(skill.description, 500),
      updatedAt: skill.updatedAt || null,
      previousState: previous.items?.[name]?.state || null,
      ...classification,
      destructive: false,
      recoverable: true,
    });
  }
  report.consolidated = findConsolidationCandidates(report.items);
  report.pruned = report.items
    .filter((item) => item.state === 'archive_candidate')
    .map((item) => ({
      name: item.name,
      action: 'propose_archive',
      destructive: false,
      recoverable: true,
      reason: `inactive_for_${item.daysInactive}_days`,
    }));
  report.stateTransitions = buildStateTransitions(report.items);
  report.snapshotRef = writeSnapshot(snapshotFile, report, skills);
  report.recoveryInstructions = buildRecoveryInstructions({
    stateFile: stateFile ? resolve(stateFile) : '',
    snapshotRef: report.snapshotRef,
    dryRun: report.dryRun,
  });
  if (stateFile && dryRun === false) {
    const state = {
      schemaVersion: SKILL_CURATOR_SCHEMA_VERSION,
      updatedAt: report.createdAt,
      items: Object.fromEntries(report.items.map((item) => [item.name, { state: item.state, action: item.action, updatedAt: item.updatedAt }])),
    };
    saveState(resolve(stateFile), state);
    report.stateFile = toRef(stateFile);
  }
  return report;
}
