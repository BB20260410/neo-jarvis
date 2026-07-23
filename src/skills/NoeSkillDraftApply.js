// @ts-check

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { redactSensitiveText } from '../runtime/NoeContextScrubber.js';

export const NOE_SKILL_DRAFT_APPLY_SCHEMA_VERSION = 1;
export const NOE_SKILL_DRAFT_QUEUE = 'output/noe-proposal-executions/queues/skill-drafts.jsonl';
export const NOE_SKILL_DRAFT_APPLY_REPORT_DIR = 'output/noe-skill-drafts/apply-reports';

function clean(value, max = 1000) {
  return redactSensitiveText(String(value ?? '').trim()).slice(0, max);
}

function rel(root, file) {
  const ref = relative(root, file).replaceAll('\\', '/');
  if (ref && !ref.startsWith('..') && ref !== '..' && !ref.startsWith('/')) return ref;
  return file;
}

function hash(value) {
  return createHash('sha1').update(JSON.stringify(value)).digest('hex').slice(0, 16);
}

function reportFileName() {
  return `skill-draft-apply-${Date.now()}-${randomUUID().slice(0, 8)}.json`;
}

function readJsonl(file) {
  if (!existsSync(file)) return { records: [], errors: [] };
  const records = [];
  const errors = [];
  readFileSync(file, 'utf8').split(/\r?\n/).forEach((line, index) => {
    if (!line.trim()) return;
    try {
      records.push(JSON.parse(line));
    } catch {
      errors.push({ line: index + 1, error: 'json_parse_failed' });
    }
  });
  return { records, errors };
}

function skillName(value, fallbackSeed) {
  const source = clean(value, 120).toLowerCase();
  const slug = source.replace(/[^a-z0-9_.-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 56);
  if (/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,63}$/.test(slug)) return slug;
  return `skill-draft-${hash(fallbackSeed).slice(0, 12)}`;
}

function rawItem(record = {}) {
  const raw = record.proposal?.raw;
  if (raw?.item && typeof raw.item === 'object') return raw.item;
  if (raw && typeof raw === 'object') return raw;
  return {};
}

function bodyFromItem(item = {}, record = {}) {
  if (item.body) return clean(item.body, 50_000);
  if (item.instructions) return clean(item.instructions, 50_000);
  if (Array.isArray(item.steps)) return item.steps.map((step, index) => `${index + 1}. ${clean(step, 1000)}`).join('\n');
  const summary = clean(item.summary || record.proposal?.summary || '', 4000);
  const description = clean(item.description || summary || '', 4000);
  return [`# ${clean(item.displayName || item.name || record.proposal?.title || 'Draft Skill', 200)}`, '', description].join('\n').trim();
}

export function buildNoeSkillDraftApplyPlan(record = {}, {
  queueRef = NOE_SKILL_DRAFT_QUEUE,
} = {}) {
  const item = rawItem(record);
  const name = skillName(item.name || record.proposal?.title, {
    executionKey: record.executionKey,
    proposalId: record.proposal?.proposalId,
    item,
  });
  const displayName = clean(item.displayName || item.title || item.name || record.proposal?.title || name, 240);
  const description = clean(item.description || record.proposal?.summary || '', 1000);
  const body = bodyFromItem(item, record);
  const blockers = [];
  if (record.effect !== 'pending_queue_only') blockers.push('unexpected_queue_effect');
  if (record.proposal?.proposalType !== 'skill_draft') blockers.push('not_skill_draft');
  if (!name) blockers.push('skill_name_required');
  if (!description) blockers.push('skill_description_required');
  if (!body) blockers.push('skill_body_required');
  const applyId = `skill-apply-${hash({
    executionKey: record.executionKey,
    proposalId: record.proposal?.proposalId,
    name,
    body,
  })}`;
  return {
    ok: blockers.length === 0,
    blockers,
    plan: {
      schemaVersion: NOE_SKILL_DRAFT_APPLY_SCHEMA_VERSION,
      applyId,
      status: blockers.length ? 'blocked' : 'ready_for_apply',
      executionKey: clean(record.executionKey, 200),
      proposalId: clean(record.proposal?.proposalId, 200),
      sourceReportRef: clean(record.proposal?.sourceReportRef, 500),
      queueRef: clean(queueRef, 500),
      skillWrite: {
        name,
        displayName,
        description,
        body,
        enabled: false,
        extra: {
          origin: 'proposal_skill_draft',
          proposalId: clean(record.proposal?.proposalId, 200),
          executionKey: clean(record.executionKey, 200),
        },
      },
      evidenceRefs: [
        clean(queueRef, 500),
        clean(record.proposal?.sourceReportRef, 500),
      ].filter(Boolean),
      rollbackPlan: [
        'If applied and the skill did not previously exist, delete the disabled skill by skillName using the apply report.',
        'If the skill already existed, block instead of overwriting.',
      ],
      writesSkillStore: true,
      requiresOwnerConfirmation: true,
    },
  };
}

export function runNoeSkillDraftApply({
  root = process.cwd(),
  queueRef = NOE_SKILL_DRAFT_QUEUE,
  reportDir = NOE_SKILL_DRAFT_APPLY_REPORT_DIR,
  skillStore = null,
  dryRun = true,
  confirmOwner = false,
  now = new Date(),
} = {}) {
  const rootAbs = resolve(root);
  const queuePath = resolve(rootAbs, queueRef);
  const generatedAt = now instanceof Date ? now.toISOString() : new Date(now).toISOString();
  const reportPath = resolve(rootAbs, reportDir, reportFileName());
  const { records, errors } = readJsonl(queuePath);
  const planned = records.map((record) => buildNoeSkillDraftApplyPlan(record, { queueRef }));
  const ready = planned.filter((item) => item.ok);
  const blocked = planned.filter((item) => !item.ok);
  const applyErrors = [];
  const applied = [];
  if (!dryRun && confirmOwner !== true) {
    applyErrors.push({ error: 'owner_confirmation_required' });
  } else if (!dryRun && !skillStore?.upsert) {
    applyErrors.push({ error: 'skill_store_required' });
  } else if (!dryRun) {
    for (const item of ready) {
      const skillNameValue = item.plan.skillWrite.name;
      try {
        const before = skillStore.get?.(skillNameValue) || null;
        if (before) {
          applyErrors.push({ applyId: item.plan.applyId, skillName: skillNameValue, error: 'skill_already_exists' });
          continue;
        }
        const saved = skillStore.upsert(item.plan.skillWrite);
        applied.push({
          applyId: item.plan.applyId,
          proposalId: item.plan.proposalId,
          skillName: skillNameValue,
          enabled: saved?.enabled === true,
          previousExists: false,
          origin: 'proposal_skill_draft',
          rollback: {
            action: 'delete_skill',
            skillName: skillNameValue,
            reason: `rollback:${item.plan.applyId}`,
          },
        });
      } catch (error) {
        applyErrors.push({ applyId: item.plan.applyId, skillName: skillNameValue, error: clean(error?.message || error, 500) });
      }
    }
  }
  const status = !records.length
    ? 'skipped'
    : (errors.length || blocked.length || applyErrors.length ? 'blocked' : (dryRun ? 'dry_run_ready' : 'applied'));
  const report = {
    ok: errors.length === 0 && blocked.length === 0 && applyErrors.length === 0,
    schemaVersion: NOE_SKILL_DRAFT_APPLY_SCHEMA_VERSION,
    generatedAt,
    status,
    reason: !records.length ? 'no_materialized_skill_drafts' : '',
    dryRun,
    queueRef,
    reportRef: rel(rootAbs, reportPath),
    counts: {
      records: records.length,
      ready: ready.length,
      blocked: blocked.length,
      applied: applied.length,
      errors: errors.length + applyErrors.length,
    },
    errors: [...errors, ...applyErrors],
    blocked: blocked.map((item) => ({ applyId: item.plan.applyId, proposalId: item.plan.proposalId, blockers: item.blockers })),
    plans: ready.map((item) => item.plan),
    applied,
    directWrites: dryRun ? [] : [rel(rootAbs, reportPath), ...(applied.length ? ['SkillStore'] : [])],
    writesSkillStore: !dryRun && applied.length > 0,
    rollbackEvidenceRequired: !dryRun,
  };
  mkdirSync(dirname(reportPath), { recursive: true });
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  return report;
}
