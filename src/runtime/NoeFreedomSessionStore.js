import { randomUUID } from 'node:crypto';
import {
  NOE_FREEDOM_AUTH_MODES,
  NOE_FREEDOM_DEVELOPER_MODE_PROFILE,
  redactNoeFreedomPayload,
} from '../capabilities/NoeFreedomManifest.js';
import { redactSensitiveText } from './NoeContextScrubber.js';

export const NOE_FREEDOM_SESSION_SCHEMA_VERSION = 1;

function clean(value, max = 2000) {
  return redactSensitiveText(String(value ?? '').trim()).slice(0, max);
}

function nowIso(now = () => new Date()) {
  // 强健:注入式 now 若返回非 Date 且非有限值(或本身抛错/Invalid Date),不让 new Date(value) 抛 RangeError
  // 崩 session 创建——降级当前时间。合法 Date / 数值毫秒注入逐字等价。
  let value;
  try { value = now(); } catch { value = new Date(); }
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? value.toISOString() : new Date().toISOString();
  const d = new Date(value);
  return Number.isFinite(d.getTime()) ? d.toISOString() : new Date().toISOString();
}

function sessionMode(input = '') {
  const mode = clean(input || 'developer_unrestricted', 80);
  return NOE_FREEDOM_AUTH_MODES.has(mode) ? mode : '';
}

function sessionProfileFor(mode = '') {
  if (mode === 'developer_unrestricted') return NOE_FREEDOM_DEVELOPER_MODE_PROFILE;
  if (mode === 'owner_supervised_unrestricted') {
    return {
      id: 'owner_supervised_unrestricted',
      label: '主人监督最大权限',
      mode: 'owner_supervised_unrestricted',
      skipsTrustManifestAndAllowlist: false,
      ownerPresenceRequired: true,
      stillRedactsSecretValues: true,
      hardVetoes: NOE_FREEDOM_DEVELOPER_MODE_PROFILE.hardVetoes,
    };
  }
  return {
    id: 'dry_run',
    label: '只演练',
    mode: 'dry_run',
    skipsTrustManifestAndAllowlist: false,
    ownerPresenceRequired: false,
    stillRedactsSecretValues: true,
    hardVetoes: NOE_FREEDOM_DEVELOPER_MODE_PROFILE.hardVetoes,
  };
}

function publicSession(session = null) {
  if (!session) return null;
  return JSON.parse(JSON.stringify(session));
}

export function createNoeFreedomSession({
  mode = 'developer_unrestricted',
  ownerPresent = false,
  reason = '',
  source = 'owner-request',
  idGenerator = randomUUID,
  now = () => new Date(),
} = {}) {
  const selectedMode = sessionMode(mode);
  const errors = [];
  if (!selectedMode) errors.push('invalid_freedom_session_mode');
  if (selectedMode !== 'dry_run' && ownerPresent !== true) {
    errors.push('owner_present_required_for_freedom_session');
  }
  if (errors.length) {
    return { ok: false, errors };
  }
  const profile = sessionProfileFor(selectedMode);
  return {
    ok: true,
    session: {
      schemaVersion: NOE_FREEDOM_SESSION_SCHEMA_VERSION,
      sessionId: `freedom-session-${clean(idGenerator(), 120)}`,
      mode: selectedMode,
      ownerPresent: ownerPresent === true,
      createdAt: nowIso(now),
      source: clean(source, 120),
      reason: clean(reason, 1000),
      profile,
      hardVetoes: Array.isArray(profile.hardVetoes) ? profile.hardVetoes : [],
      secretValuesReturned: false,
    },
  };
}

export function createNoeFreedomSessionStore({
  idGenerator = randomUUID,
  now = () => new Date(),
} = {}) {
  const sessions = new Map();
  return {
    start(input = {}) {
      const out = createNoeFreedomSession({
        ...input,
        idGenerator,
        now,
      });
      if (out.ok) sessions.set(out.session.sessionId, out.session);
      return out;
    },
    get(sessionId = '') {
      const id = clean(sessionId, 180);
      const session = sessions.get(id);
      if (!session) return { ok: false, errors: ['freedom_session_not_found'], sessionId: id };
      return { ok: true, session: publicSession(session) };
    },
    resolveAuthorization({ authorization = {} } = {}) {
      const sessionId = clean(
        authorization.sessionId
        || authorization.session_id
        || authorization.freedomSessionId
        || authorization.freedom_session_id,
        180,
      );
      // owner 偏好（2026-06-11）：开发者要 freedom 最大权限，无 session 时按 payload 透传（不强制握手）。
      if (!sessionId) return { ok: true, authorization: redactNoeFreedomPayload(authorization) };
      const found = this.get(sessionId);
      if (!found.ok) return { ok: false, errors: found.errors, sessionId };
      return {
        ok: true,
        session: found.session,
        authorization: redactNoeFreedomPayload({
          ...authorization,
          sessionId,
          mode: found.session.mode,
          ownerPresent: found.session.ownerPresent,
          sessionSource: found.session.source,
          reason: authorization.reason || found.session.reason,
        }),
      };
    },
    list() {
      return [...sessions.values()].map(publicSession);
    },
  };
}
