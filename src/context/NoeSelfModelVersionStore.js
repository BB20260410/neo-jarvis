// @ts-check
// Versioned identity layer for NoeSelfModel. It implements DESIGN §7.6 storage:
// ~/.noe-panel/self-model/vNNN.json plus current symlink/copy pointer.

import { existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, readdirSync, renameSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

export const SELF_MODEL_SCHEMA_VERSION = 1;
export const DEFAULT_SELF_MODEL_DIR = join(homedir(), '.noe-panel', 'self-model');
const CORE_IDENTITY_FIELDS = new Set(['name', 'relationship', 'values']);

function versionNumber(versionId) {
  const match = String(versionId || '').match(/^v(\d{3,})$/);
  return match ? Number(match[1]) : 0;
}

function versionFileName(versionId) {
  return `${String(versionId || '').replace(/\.json$/, '')}.json`;
}

function nextVersionIdFrom(ids) {
  const max = ids.reduce((acc, id) => Math.max(acc, versionNumber(id)), 0);
  return `v${String(max + 1).padStart(3, '0')}`;
}

function safeJsonFile(file) {
  try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return null; }
}

function cleanString(value, max = 500) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, max);
}

export function normalizeSelfModelIdentity(input = {}) {
  const out = {};
  if (typeof input.name === 'string' && input.name.trim()) out.name = cleanString(input.name, 80);
  if (typeof input.relationship === 'string' && input.relationship.trim()) out.relationship = cleanString(input.relationship, 500);
  if (typeof input.disposition === 'string' && input.disposition.trim()) out.disposition = cleanString(input.disposition, 300);
  if (Array.isArray(input.values)) out.values = input.values.map((v) => cleanString(v, 120)).filter(Boolean).slice(0, 12);
  return out;
}

export function validateSelfModelVersionPayload(payload) {
  const identity = normalizeSelfModelIdentity(payload?.identity || {});
  const blockers = [];
  if (payload?.schemaVersion !== SELF_MODEL_SCHEMA_VERSION) blockers.push('unsupported_schema_version');
  if (!/^v\d{3,}$/.test(String(payload?.versionId || ''))) blockers.push('invalid_version_id');
  if (!Object.keys(identity).length) blockers.push('identity_empty');
  return { ok: blockers.length === 0, blockers, identity };
}

function coreIdentityChanged(previous = {}, next = {}) {
  for (const key of CORE_IDENTITY_FIELDS) {
    const a = JSON.stringify(previous[key] ?? null);
    const b = JSON.stringify(next[key] ?? null);
    if (a !== b) return true;
  }
  return false;
}

export class NoeSelfModelVersionStore {
  constructor({ rootDir = DEFAULT_SELF_MODEL_DIR, now = Date.now } = {}) {
    this.rootDir = resolve(rootDir);
    this.now = now;
  }

  versionPath(versionId) {
    return join(this.rootDir, versionFileName(versionId));
  }

  currentPointerPath() {
    return join(this.rootDir, 'current');
  }

  listVersions() {
    if (!existsSync(this.rootDir)) return [];
    try {
      return readdirSync(this.rootDir)
        .map((name) => name.match(/^(v\d{3,})\.json$/)?.[1])
        .filter(Boolean)
        .sort((a, b) => versionNumber(a) - versionNumber(b));
    } catch { return []; }
  }

  resolveCurrentFile() {
    const current = this.currentPointerPath();
    if (!existsSync(current)) return null;
    try {
      if (lstatSync(current).isSymbolicLink()) {
        const target = readlinkSync(current);
        const file = resolve(this.rootDir, target);
        const rel = relative(this.rootDir, file);
        if (rel.startsWith('..') || isAbsolute(rel)) return null;
        return file;
      }
      return current;
    } catch { return null; }
  }

  readVersionFile(file) {
    const payload = safeJsonFile(file);
    const validation = validateSelfModelVersionPayload(payload);
    if (!validation.ok) return null;
    return { ...payload, identity: validation.identity, file };
  }

  current() {
    const file = this.resolveCurrentFile();
    return file ? this.readVersionFile(file) : null;
  }

  nextVersionId() {
    return nextVersionIdFrom(this.listVersions());
  }

  writeNextVersion({ identity = {}, reason = '', evidenceRefs = [], proposalId = randomUUID(), ownerConfirmed = false } = {}) {
    const previous = this.current();
    const cleanIdentity = normalizeSelfModelIdentity({ ...(previous?.identity || {}), ...identity });
    if (!Object.keys(cleanIdentity).length) return { ok: false, reason: 'identity_empty' };
    if (previous && coreIdentityChanged(previous.identity, cleanIdentity) && ownerConfirmed !== true) {
      return { ok: false, reason: 'owner_confirmation_required_for_identity_core', previousVersionId: previous.versionId };
    }
    const versionId = this.nextVersionId();
    const payload = {
      schemaVersion: SELF_MODEL_SCHEMA_VERSION,
      versionId,
      previousVersionId: previous?.versionId || null,
      createdAt: this.now(),
      proposalId: proposalId || randomUUID(),
      ownerConfirmed: ownerConfirmed === true,
      reason: cleanString(reason, 500),
      evidenceRefs: Array.isArray(evidenceRefs) ? evidenceRefs.map((x) => cleanString(x, 300)).filter(Boolean).slice(0, 20) : [],
      identity: cleanIdentity,
    };
    mkdirSync(this.rootDir, { recursive: true, mode: 0o700 });
    const file = this.versionPath(versionId);
    const tmp = join(dirname(file), `.${basename(file)}.${process.pid}.tmp`);
    writeFileSync(tmp, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 });
    renameSync(tmp, file);
    this.pointCurrentAt(versionId);
    return { ok: true, version: payload, file };
  }

  pointCurrentAt(versionId) {
    const current = this.currentPointerPath();
    try { if (existsSync(current)) unlinkSync(current); } catch {}
    try {
      symlinkSync(versionFileName(versionId), current);
    } catch {
      writeFileSync(current, readFileSync(this.versionPath(versionId)), { mode: 0o600 });
    }
  }
}

export function createNoeSelfModelVersionStore(opts = {}) {
  return new NoeSelfModelVersionStore(opts);
}
