import { createHash } from 'node:crypto';
import { redactSensitiveText } from '../runtime/NoeContextScrubber.js';

export const NOE_FREEDOM_TRUST_MANIFEST_SCHEMA_VERSION = 1;

const RISK_LEVELS = new Set(['low', 'medium', 'high', 'critical']);
const EXECUTION_MODES = new Set(['dry_run', 'owner_supervised_unrestricted']);

function clean(value, max = 2000) {
  return redactSensitiveText(String(value ?? '').trim()).slice(0, max);
}

function list(value = []) {
  const input = Array.isArray(value) ? value : String(value || '').split(/[\n,]+/);
  return [...new Set(input.map((item) => clean(item, 500)).filter(Boolean))];
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (!value || typeof value !== 'object') return JSON.stringify(value);
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
}

function hash(value) {
  return createHash('sha256').update(stableJson(value), 'utf8').digest('hex');
}

export function normalizeNoeFreedomTrustManifest(input = {}) {
  const operation = clean(input.operation || input.toolId || input.id, 180);
  const manifest = {
    schemaVersion: Number(input.schemaVersion) || NOE_FREEDOM_TRUST_MANIFEST_SCHEMA_VERSION,
    id: clean(input.id || `${operation || 'freedom'}-trust`, 180),
    operation,
    owner: clean(input.owner || input.publisher || 'owner', 180),
    version: clean(input.version || '1.0.0', 80),
    riskLevel: clean(input.riskLevel || input.risk_level || 'critical', 40).toLowerCase(),
    executionModes: list(input.executionModes || input.execution_modes || ['dry_run']),
    scopes: {
      commands: list(input.scopes?.commands || input.commands || input.allowedCommands),
      hosts: list(input.scopes?.hosts || input.hosts || input.allowedHosts),
      paths: list(input.scopes?.paths || input.paths || input.allowedPaths),
      secrets: list(input.scopes?.secrets || input.secrets || input.allowedSecrets),
      marketplaceTools: list(input.scopes?.marketplaceTools || input.marketplaceTools || input.allowedMarketplaceTools),
      networkMethods: list(input.scopes?.networkMethods || input.networkMethods || input.allowedMethods || ['POST']),
    },
    rollback: {
      supported: input.rollback?.supported === true || Boolean(clean(input.rollbackPlan || input.rollback?.plan, 1200)),
      plan: clean(input.rollbackPlan || input.rollback?.plan || '', 1200),
      irreversible: input.rollback?.irreversible === true || input.irreversible === true,
    },
    evidence: {
      required: input.evidence?.required !== false,
      rawOutputDenied: input.evidence?.rawOutputDenied !== false,
      secretValuesDenied: input.evidence?.secretValuesDenied !== false,
    },
    source: clean(input.source || 'owner-provided', 120),
  };
  return {
    ...manifest,
    sha256: hash(manifest),
  };
}

export function validateNoeFreedomTrustManifest({
  manifest = null,
  tool = null,
  realExecute = false,
} = {}) {
  const normalized = manifest ? normalizeNoeFreedomTrustManifest(manifest) : null;
  const errors = [];
  if (!normalized) {
    if (realExecute) errors.push('trust_manifest_required_for_real_execute');
    return { ok: errors.length === 0, errors, manifest: null };
  }
  if (normalized.schemaVersion !== NOE_FREEDOM_TRUST_MANIFEST_SCHEMA_VERSION) errors.push('unsupported_trust_manifest_schema_version');
  if (!normalized.id) errors.push('trust_manifest_id_required');
  if (!normalized.operation) errors.push('trust_manifest_operation_required');
  if (tool?.operation && normalized.operation !== tool.operation) errors.push('trust_manifest_operation_mismatch');
  if (!RISK_LEVELS.has(normalized.riskLevel)) errors.push('invalid_trust_manifest_risk_level');
  if (!normalized.executionModes.length) errors.push('trust_manifest_execution_modes_required');
  for (const mode of normalized.executionModes) {
    if (!EXECUTION_MODES.has(mode)) errors.push(`invalid_execution_mode:${mode}`);
  }
  if (realExecute && !normalized.executionModes.includes('owner_supervised_unrestricted')) {
    errors.push('trust_manifest_real_execute_mode_required');
  }
  if (realExecute && normalized.rollback.irreversible && !normalized.rollback.plan) {
    errors.push('irreversible_action_requires_compensating_plan');
  }
  if (realExecute && normalized.evidence.required !== true) errors.push('trust_manifest_evidence_required');
  if (normalized.evidence.secretValuesDenied !== true) errors.push('trust_manifest_must_deny_secret_values');
  return {
    ok: errors.length === 0,
    errors,
    manifest: normalized,
  };
}
