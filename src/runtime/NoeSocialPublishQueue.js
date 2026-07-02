import { createHash, randomUUID } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join, relative, resolve, sep } from 'node:path';
import { redactSensitiveText } from './NoeContextScrubber.js';

export const NOE_SOCIAL_PUBLISH_QUEUE_SCHEMA_VERSION = 1;
export const DEFAULT_NOE_SOCIAL_DRAFT_DIR = join(homedir(), '.noe-panel', 'social-drafts');

function clean(value, max = 4000) {
  return redactSensitiveText(String(value ?? '').trim()).slice(0, max);
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (!value || typeof value !== 'object') return JSON.stringify(value);
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
}

function sha256(value = '') {
  return createHash('sha256').update(String(value), 'utf8').digest('hex');
}

function slug(value = '') {
  return clean(value, 180).replace(/[^a-z0-9_.-]+/gi, '-').replace(/^-+|-+$/g, '') || `draft-${randomUUID().slice(0, 8)}`;
}

function pathInside(base, target) {
  const root = resolve(base);
  const next = resolve(target);
  return next === root || next.startsWith(root + sep);
}

function assertQueuePath(dir = DEFAULT_NOE_SOCIAL_DRAFT_DIR, target = dir) {
  const root = resolve(dir);
  const next = resolve(target);
  if (!pathInside(root, next)) throw new Error('social_draft_path_escape');
  try {
    if (lstatSync(root).isSymbolicLink()) throw new Error('social_draft_symlink_path_denied');
  } catch (error) {
    if (error?.message === 'social_draft_symlink_path_denied') throw error;
    if (error?.code !== 'ENOENT') throw error;
  }
  const rel = relative(root, next);
  let cursor = root;
  for (const part of rel.split(sep).filter(Boolean)) {
    cursor = resolve(cursor, part);
    try {
      if (lstatSync(cursor).isSymbolicLink()) throw new Error('social_draft_symlink_path_denied');
    } catch (error) {
      if (error?.message === 'social_draft_symlink_path_denied') throw error;
      if (error?.code === 'ENOENT') return;
      throw error;
    }
  }
}

function draftFile(dir, id) {
  return resolve(dir, `${slug(id)}.json`);
}

function normalizeDraft(input = {}) {
  const platform = clean(input.platform || input.target || 'webhook', 80);
  const content = clean(input.content || input.text || input.message, 20_000);
  const id = slug(input.id || `${platform}-${Date.now()}-${randomUUID().slice(0, 6)}`);
  const rollbackPlan = clean(input.rollbackPlan || input.rollback || 'delete, edit, or publish correction from the target platform console', 2000);
  const scheduledFor = clean(input.scheduledFor || input.scheduled_at || '', 100);
  const warnings = [];
  if (!content) warnings.push('social_draft_content_required');
  if (!platform) warnings.push('social_draft_platform_required');
  return {
    id,
    platform,
    content,
    scheduledFor,
    rollbackPlan,
    metadata: input.metadata && typeof input.metadata === 'object'
      ? JSON.parse(redactSensitiveText(JSON.stringify(input.metadata)))
      : {},
    warnings,
  };
}

function recordFromDraft(draft, { state = 'draft', createdAt = new Date().toISOString(), reason = '' } = {}) {
  const record = {
    schemaVersion: NOE_SOCIAL_PUBLISH_QUEUE_SCHEMA_VERSION,
    id: draft.id,
    platform: draft.platform,
    state,
    createdAt: clean(createdAt, 100),
    updatedAt: new Date().toISOString(),
    scheduledFor: draft.scheduledFor,
    content: draft.content,
    metadata: draft.metadata,
    rollback: {
      requiredBeforePublish: true,
      plan: draft.rollbackPlan,
    },
    publish: {
      externalSideEffectPerformed: false,
      publishedAt: '',
      publishRef: '',
    },
    reason: clean(reason, 1000),
    warnings: draft.warnings,
  };
  return {
    ...record,
    sha256: sha256(stableJson(record)),
  };
}

export function createNoeSocialDraft({ dir = DEFAULT_NOE_SOCIAL_DRAFT_DIR, draft = {} } = {}) {
  const normalized = normalizeDraft(draft);
  if (normalized.warnings.includes('social_draft_content_required')) {
    return { ok: false, error: 'social_draft_content_required', warnings: normalized.warnings };
  }
  const file = draftFile(dir, normalized.id);
  assertQueuePath(dir, file);
  // Task 0.2 Step2: never clobber a draft that has already left the `draft` state (e.g. published
  // or cancelled). Re-creating onto an already-published record would silently reset its
  // externalSideEffectPerformed flag and invite a duplicate external publish.
  if (existsSync(file)) {
    let existing = null;
    try { existing = JSON.parse(readFileSync(file, 'utf8')); } catch { existing = null; }
    if (existing && typeof existing === 'object') {
      const externalDone = existing.publish?.externalSideEffectPerformed === true;
      const state = clean(existing.state, 40);
      if (externalDone || (state && state !== 'draft')) {
        return {
          ok: false,
          error: 'social_draft_already_published',
          id: normalized.id,
          state: state || 'published',
          externalSideEffectPerformed: externalDone,
          path: file,
          ref: basename(file),
        };
      }
    }
  }
  mkdirSync(dir, { recursive: true });
  const record = recordFromDraft(normalized);
  writeFileSync(file, `${JSON.stringify(record, null, 2)}\n`);
  return {
    ok: true,
    id: record.id,
    path: file,
    ref: basename(file),
    state: record.state,
    platform: record.platform,
    externalSideEffectPerformed: false,
    sha256: record.sha256,
    rollback: record.rollback,
  };
}

export function readNoeSocialDraft({ dir = DEFAULT_NOE_SOCIAL_DRAFT_DIR, id = '' } = {}) {
  const file = draftFile(dir, id);
  if (!existsSync(file)) return { ok: false, error: 'social_draft_not_found', id: clean(id, 180) };
  assertQueuePath(dir, file);
  const record = JSON.parse(readFileSync(file, 'utf8'));
  return { ok: true, record, path: file, ref: basename(file) };
}

export function listNoeSocialDrafts({ dir = DEFAULT_NOE_SOCIAL_DRAFT_DIR } = {}) {
  if (!existsSync(dir)) return { ok: true, drafts: [], dir };
  assertQueuePath(dir, dir);
  const drafts = [];
  for (const entry of readdirSync(dir)) {
    if (!entry.endsWith('.json')) continue;
    const file = resolve(dir, entry);
    assertQueuePath(dir, file);
    try {
      const record = JSON.parse(readFileSync(file, 'utf8'));
      drafts.push({
        id: clean(record.id, 180),
        platform: clean(record.platform, 80),
        state: clean(record.state, 40),
        scheduledFor: clean(record.scheduledFor, 100),
        externalSideEffectPerformed: record.publish?.externalSideEffectPerformed === true,
        ref: entry,
        sha256: clean(record.sha256, 80),
      });
    } catch {}
  }
  drafts.sort((a, b) => a.id.localeCompare(b.id));
  return { ok: true, drafts, dir };
}

export function cancelNoeSocialDraft({ dir = DEFAULT_NOE_SOCIAL_DRAFT_DIR, id = '', reason = 'owner_cancelled' } = {}) {
  const current = readNoeSocialDraft({ dir, id });
  if (!current.ok) return current;
  const record = {
    ...current.record,
    state: 'cancelled',
    updatedAt: new Date().toISOString(),
    reason: clean(reason, 1000),
    publish: {
      ...(current.record.publish || {}),
      externalSideEffectPerformed: false,
    },
  };
  delete record.sha256;
  const next = { ...record, sha256: sha256(stableJson(record)) };
  writeFileSync(current.path, `${JSON.stringify(next, null, 2)}\n`);
  return { ok: true, id: clean(id, 180), state: 'cancelled', path: current.path, ref: basename(current.path), sha256: next.sha256 };
}

// Task 0.2 Step1: persist the "an external publish actually happened" flag back to disk so a
// subsequent run can read it and refuse to publish the same draft twice. Idempotent: once a draft
// is marked published it never reverts to externalSideEffectPerformed=false.
export function markNoeSocialDraftExternalSideEffect({
  dir = DEFAULT_NOE_SOCIAL_DRAFT_DIR,
  id = '',
  publishRef = '',
  publishedAt = new Date().toISOString(),
  reason = 'external_publish_confirmed',
} = {}) {
  const current = readNoeSocialDraft({ dir, id });
  if (!current.ok) return current;
  const priorPublish = current.record.publish || {};
  const record = {
    ...current.record,
    state: 'published',
    updatedAt: new Date().toISOString(),
    reason: clean(reason, 1000),
    publish: {
      ...priorPublish,
      externalSideEffectPerformed: true,
      publishedAt: clean(priorPublish.publishedAt || publishedAt, 100),
      publishRef: clean(priorPublish.publishRef || publishRef, 2000),
    },
  };
  delete record.sha256;
  const next = { ...record, sha256: sha256(stableJson(record)) };
  writeFileSync(current.path, `${JSON.stringify(next, null, 2)}\n`);
  return {
    ok: true,
    id: clean(id, 180),
    state: 'published',
    externalSideEffectPerformed: true,
    publishedAt: next.publish.publishedAt,
    publishRef: next.publish.publishRef,
    path: current.path,
    ref: basename(current.path),
    sha256: next.sha256,
  };
}
