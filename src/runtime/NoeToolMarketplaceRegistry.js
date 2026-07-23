import { createHash, randomUUID } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join, relative, resolve, sep } from 'node:path';
import { redactNoeFreedomPayload } from '../capabilities/NoeFreedomManifest.js';
import { redactSensitiveText } from './NoeContextScrubber.js';

export const NOE_TOOL_MARKETPLACE_REGISTRY_SCHEMA_VERSION = 1;
export const DEFAULT_NOE_MARKETPLACE_DIR = join(homedir(), '.noe-panel', 'tool-marketplace');

function clean(value, max = 2000) {
  return redactSensitiveText(String(value ?? '').trim()).slice(0, max);
}

function safeJson(value) {
  if (!value || typeof value !== 'object') return {};
  try {
    return JSON.parse(redactSensitiveText(JSON.stringify(value)));
  } catch {
    return {};
  }
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
  return clean(value, 180).replace(/[^a-z0-9_.-]+/gi, '_').replace(/^_+|_+$/g, '') || `tool-${randomUUID().slice(0, 8)}`;
}

function pathInside(base, target) {
  const root = resolve(base);
  const next = resolve(target);
  return next === root || next.startsWith(root + sep);
}

function assertRegistryPath(dir = DEFAULT_NOE_MARKETPLACE_DIR, target) {
  const root = resolve(dir);
  const next = resolve(target);
  if (!pathInside(root, next)) throw new Error('tool_marketplace_path_escape');
  try {
    if (lstatSync(root).isSymbolicLink()) throw new Error('tool_marketplace_symlink_path_denied');
  } catch (error) {
    if (error?.message === 'tool_marketplace_symlink_path_denied') throw error;
    if (error?.code !== 'ENOENT') throw error;
  }
  const rel = relative(root, next);
  let cursor = root;
  for (const part of rel.split(sep).filter(Boolean)) {
    cursor = resolve(cursor, part);
    try {
      if (lstatSync(cursor).isSymbolicLink()) throw new Error('tool_marketplace_symlink_path_denied');
    } catch (error) {
      if (error?.message === 'tool_marketplace_symlink_path_denied') throw error;
      if (error?.code === 'ENOENT') return;
      throw error;
    }
  }
}

function toolFile(dir, id) {
  return resolve(dir, `${slug(id)}.json`);
}

function tombstoneFile(dir, id) {
  return resolve(dir, `${slug(id)}.disabled.json`);
}

function normalizeToolManifest(input = {}) {
  const manifest = safeJson(input.manifest || input.tool || input);
  const id = clean(manifest.id || input.id, 180);
  if (!id) return null;
  return {
    id,
    name: clean(manifest.name || manifest.title || id, 180),
    version: clean(manifest.version || '1.0.0', 80),
    description: clean(manifest.description || '', 1200),
    sourceUri: clean(manifest.sourceUri || manifest.source || '', 1000),
    entrypoint: clean(manifest.entrypoint || manifest.command || manifest.main || '', 1000),
    permissions: Array.isArray(manifest.permissions) ? manifest.permissions.map((item) => clean(item, 180)).filter(Boolean) : [],
    allowlist: Array.isArray(manifest.allowlist) ? manifest.allowlist.map((item) => clean(item, 240)).filter(Boolean) : [],
    manifest: redactNoeFreedomPayload(manifest),
  };
}

function validateToolManifestMetadata(manifest = {}) {
  const errors = [];
  if (!manifest.id) errors.push('tool_manifest_id_required');
  if (!/^[a-z0-9][a-z0-9_.-]{0,179}$/i.test(manifest.id || '')) errors.push('invalid_tool_manifest_id');
  if (!/^[a-z0-9][a-z0-9_.+-]{0,79}$/i.test(manifest.version || '')) errors.push('invalid_tool_manifest_version');
  if (/[\r\n\t\0]/.test(manifest.sourceUri || '')) errors.push('invalid_tool_manifest_source_uri');
  if (/(?:api[_-]?key|token|secret|password)=/i.test(manifest.sourceUri || '')) errors.push('secret_like_source_uri_denied');
  return errors;
}

function packageRecord({ manifest, state = 'enabled', source = 'owner-supervised', installedAt = new Date().toISOString(), disabledAt = '', reason = '' } = {}) {
  const record = {
    schemaVersion: NOE_TOOL_MARKETPLACE_REGISTRY_SCHEMA_VERSION,
    id: manifest.id,
    name: manifest.name,
    version: manifest.version,
    description: manifest.description,
    sourceUri: manifest.sourceUri,
    state,
    installedAt: clean(installedAt, 80),
    disabledAt: clean(disabledAt, 80),
    reason: clean(reason, 1000),
    trust: {
      source: clean(source, 120),
      permissions: manifest.permissions,
      allowlist: manifest.allowlist,
    },
    entrypoint: manifest.entrypoint ? {
      declared: true,
      value: manifest.entrypoint,
      executionEnabled: false,
    } : {
      declared: false,
      value: '',
      executionEnabled: false,
    },
    manifest: manifest.manifest,
  };
  return {
    ...record,
    sha256: sha256(stableJson(record)),
  };
}

export function installNoeMarketplaceTool({ manifest = {}, dir = DEFAULT_NOE_MARKETPLACE_DIR, source = 'owner-supervised' } = {}) {
  const normalized = normalizeToolManifest(manifest);
  if (!normalized) return { ok: false, error: 'tool_manifest_id_required' };
  const metadataErrors = validateToolManifestMetadata(normalized);
  if (metadataErrors.length) return { ok: false, error: 'invalid_tool_manifest_metadata', errors: metadataErrors };
  const file = toolFile(dir, normalized.id);
  assertRegistryPath(dir, file);
  mkdirSync(dir, { recursive: true });
  const record = packageRecord({ manifest: normalized, source });
  writeFileSync(file, `${JSON.stringify(record, null, 2)}\n`);
  return {
    ok: true,
    id: normalized.id,
    path: file,
    ref: basename(file),
    state: record.state,
    installed: true,
    executionEnabled: false,
    sha256: record.sha256,
    rollback: {
      action: 'uninstall',
      id: normalized.id,
      path: file,
    },
  };
}

export function readNoeMarketplaceTool({ id = '', dir = DEFAULT_NOE_MARKETPLACE_DIR, includeDisabled = true } = {}) {
  const file = toolFile(dir, id);
  const disabledFile = tombstoneFile(dir, id);
  const target = existsSync(file) ? file : includeDisabled && existsSync(disabledFile) ? disabledFile : '';
  if (!target) return { ok: false, error: 'tool_marketplace_record_not_found', id: clean(id, 180) };
  assertRegistryPath(dir, target);
  const record = JSON.parse(readFileSync(target, 'utf8'));
  return { ok: true, record, path: target, ref: basename(target) };
}

export function listNoeMarketplaceTools({ dir = DEFAULT_NOE_MARKETPLACE_DIR, includeDisabled = true } = {}) {
  if (!existsSync(dir)) return { ok: true, tools: [], dir };
  assertRegistryPath(dir, dir);
  const byId = new Map();
  for (const entry of readdirSync(dir)) {
    if (!entry.endsWith('.json')) continue;
    if (!includeDisabled && entry.endsWith('.disabled.json')) continue;
    const file = resolve(dir, entry);
    assertRegistryPath(dir, file);
    try {
      const record = JSON.parse(readFileSync(file, 'utf8'));
      const item = {
        id: clean(record.id, 180),
        name: clean(record.name || record.id, 180),
        version: clean(record.version || '', 80),
        state: clean(record.state || 'unknown', 40),
        executionEnabled: record.entrypoint?.executionEnabled === true,
        ref: entry,
        sha256: clean(record.sha256, 80),
      };
      // A disabled/uninstalled tombstone is retained as audit history, but a later active
      // registry record wins for UI/API listing. This keeps rollback evidence without
      // showing duplicate tools after reinstall.
      const previous = byId.get(item.id);
      if (!previous || previous.state !== 'enabled' || item.state === 'enabled') byId.set(item.id, item);
    } catch {}
  }
  const tools = [...byId.values()];
  tools.sort((a, b) => a.id.localeCompare(b.id));
  return { ok: true, tools, dir };
}

export function disableNoeMarketplaceTool({ id = '', dir = DEFAULT_NOE_MARKETPLACE_DIR, reason = 'owner_disabled' } = {}) {
  const current = readNoeMarketplaceTool({ id, dir, includeDisabled: false });
  if (!current.ok) return current;
  const record = {
    ...current.record,
    state: 'disabled',
    disabledAt: new Date().toISOString(),
    reason: clean(reason, 1000),
    entrypoint: {
      ...(current.record.entrypoint || {}),
      executionEnabled: false,
    },
  };
  delete record.sha256;
  const next = { ...record, sha256: sha256(stableJson(record)) };
  const disabled = tombstoneFile(dir, id);
  assertRegistryPath(dir, disabled);
  writeFileSync(disabled, `${JSON.stringify(next, null, 2)}\n`);
  renameSync(current.path, `${current.path}.removed`);
  return { ok: true, id: clean(id, 180), state: 'disabled', path: disabled, ref: basename(disabled), sha256: next.sha256 };
}

export function uninstallNoeMarketplaceTool({ id = '', dir = DEFAULT_NOE_MARKETPLACE_DIR, reason = 'owner_uninstalled' } = {}) {
  const current = readNoeMarketplaceTool({ id, dir, includeDisabled: true });
  if (!current.ok) return current;
  const record = {
    ...current.record,
    state: 'uninstalled',
    disabledAt: current.record.disabledAt || new Date().toISOString(),
    reason: clean(reason, 1000),
    entrypoint: {
      ...(current.record.entrypoint || {}),
      executionEnabled: false,
    },
  };
  delete record.sha256;
  const next = { ...record, sha256: sha256(stableJson(record)) };
  const file = tombstoneFile(dir, id);
  assertRegistryPath(dir, file);
  writeFileSync(file, `${JSON.stringify(next, null, 2)}\n`);
  if (current.path !== file && existsSync(current.path)) renameSync(current.path, `${current.path}.removed`);
  return { ok: true, id: clean(id, 180), state: 'uninstalled', path: file, ref: basename(file), sha256: next.sha256 };
}
