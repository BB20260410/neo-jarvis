import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export const GRANT_SCHEMA_VERSION = 'noe-standing-autonomy-grant-v1';
export const DEFAULT_GRANT_PATH = join(homedir(), '.noe-panel', 'autonomy-grant.json');

export const MAX_AUTONOMY_SCOPES = Object.freeze([
  'owner-token:read',
  'live-protected-api:call',
  'live-verifier:run',
  'freedom-live:run',
  'phase5-live:run',
  'real-use-replay-live:run',
  'cognitive-live:run',
  'voice-live:run',
  'social-dom-live:run',
  'restart-51835:repair',
  'perf-protected-api:check',
  'e2e-live:run',
  'self-evolution:run',
]);

export function createMaxAutonomyGrant({ now = Date.now(), ttlMs = null, reason = 'owner requested maximum local Noe autonomy' } = {}) {
  const issuedAt = new Date(now).toISOString();
  return {
    schemaVersion: GRANT_SCHEMA_VERSION,
    enabled: true,
    grantId: `owner-max-autonomy-${new Date(now).toISOString().replace(/[-:.]/g, '').slice(0, 15)}Z`,
    issuedAt,
    issuedBy: 'owner',
    expiresAt: Number.isFinite(ttlMs) && ttlMs > 0 ? new Date(now + ttlMs).toISOString() : null,
    scopes: [...MAX_AUTONOMY_SCOPES],
    boundaries: {
      neverPrintSecretValues: true,
      neverWriteSecretValuesToReports: true,
      neverCommitSecretValues: true,
      requireEvidenceForExternalSideEffects: true,
      requireRollbackForDestructiveExternalActions: true,
      truthfulExecutionOnly: true,
    },
    reason,
    secretValuesIncluded: false,
  };
}

export function grantPathFromEnv(env = process.env) {
  return env.NOE_STANDING_AUTONOMY_GRANT_PATH || DEFAULT_GRANT_PATH;
}

function readGrantJson({ grantPath = DEFAULT_GRANT_PATH } = {}) {
  if (!existsSync(grantPath)) return { ok: false, source: 'grant_missing', reason: `standing autonomy grant not found at ${grantPath}` };
  try {
    return { ok: true, source: grantPath, grant: JSON.parse(readFileSync(grantPath, 'utf8')) };
  } catch (e) {
    return { ok: false, source: grantPath, reason: `standing autonomy grant unreadable: ${e?.message || e}` };
  }
}

function hasScope(grant, scope) {
  const scopes = Array.isArray(grant?.scopes) ? grant.scopes.map(String) : [];
  return scopes.includes('*') || scopes.includes(scope);
}

export function evaluateStandingAutonomyGrant({
  scope = 'owner-token:read',
  now = Date.now(),
  env = process.env,
  grantPath = grantPathFromEnv(env),
} = {}) {
  if (env.NOE_STANDING_AUTONOMY_GRANT === '0') {
    return { authorized: false, source: 'standing_grant_disabled_by_env', reason: 'NOE_STANDING_AUTONOMY_GRANT=0', grantId: '' };
  }
  const loaded = readGrantJson({ grantPath });
  if (!loaded.ok) return { authorized: false, source: loaded.source, reason: loaded.reason, grantId: '' };
  const grant = loaded.grant || {};
  if (grant.schemaVersion !== GRANT_SCHEMA_VERSION) {
    return { authorized: false, source: loaded.source, reason: 'standing autonomy grant schema mismatch', grantId: String(grant.grantId || '') };
  }
  if (grant.enabled !== true) {
    return { authorized: false, source: loaded.source, reason: 'standing autonomy grant disabled', grantId: String(grant.grantId || '') };
  }
  if (grant.expiresAt && Date.parse(grant.expiresAt) <= now) {
    return { authorized: false, source: loaded.source, reason: 'standing autonomy grant expired', grantId: String(grant.grantId || '') };
  }
  if (!hasScope(grant, scope)) {
    return { authorized: false, source: loaded.source, reason: `standing autonomy grant missing scope ${scope}`, grantId: String(grant.grantId || '') };
  }
  return {
    authorized: true,
    source: 'standing_autonomy_grant',
    grantPath: loaded.source,
    grantId: String(grant.grantId || ''),
    scope,
    reason: 'owner standing autonomy grant allows this local action',
    secretValueReturned: false,
  };
}

export function resolveOwnerTokenAuthorization({
  explicitAck = false,
  scope = 'owner-token:read',
  now = Date.now(),
  env = process.env,
  grantPath = grantPathFromEnv(env),
} = {}) {
  if (explicitAck || env.NOE_ACK_READ_OWNER_TOKEN === '1') {
    return {
      authorized: true,
      mode: 'explicit_ack',
      source: explicitAck ? '--ack-read-owner-token' : 'NOE_ACK_READ_OWNER_TOKEN',
      scope,
      reason: 'explicit owner-token read acknowledgement',
      secretValueReturned: false,
    };
  }
  const grant = evaluateStandingAutonomyGrant({ scope, now, env, grantPath });
  if (grant.authorized) return { ...grant, mode: 'standing_grant' };
  return {
    authorized: false,
    mode: 'policy_blocked',
    source: grant.source,
    scope,
    reason: `${grant.reason}; provide --ack-read-owner-token, NOE_ACK_READ_OWNER_TOKEN=1, or a valid standing autonomy grant`,
    grantId: grant.grantId || '',
    secretValueReturned: false,
  };
}

export function writeStandingAutonomyGrant({ grant = createMaxAutonomyGrant(), grantPath = DEFAULT_GRANT_PATH } = {}) {
  mkdirSync(dirname(grantPath), { recursive: true });
  writeFileSync(grantPath, JSON.stringify(grant, null, 2) + '\n', { mode: 0o600 });
  try { chmodSync(grantPath, 0o600); } catch {}
  return { grantPath, grant };
}

export function summarizeGrantForReport(grant = {}) {
  return {
    schemaVersion: grant.schemaVersion || '',
    enabled: grant.enabled === true,
    grantId: grant.grantId || '',
    issuedAt: grant.issuedAt || '',
    issuedBy: grant.issuedBy || '',
    expiresAt: grant.expiresAt || null,
    scopes: Array.isArray(grant.scopes) ? grant.scopes : [],
    boundaries: grant.boundaries || {},
    secretValuesIncluded: grant.secretValuesIncluded === true,
  };
}
