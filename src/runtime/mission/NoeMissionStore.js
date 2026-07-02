// @ts-check
import { appendFileSync, chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { atomicWriteFile, atomicWriteJson, readJsonWithCorruptBackup } from '../../state/atomicJsonFile.js';
import { requireValidMissionContract, safeMissionId } from './NoeMissionContract.js';
import { redactSensitiveText } from '../NoeContextScrubber.js';

export const DEFAULT_NOE_MISSION_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
export const DEFAULT_NOE_MISSION_BASE_DIR = 'output/noe-missions';

function nowIso(nowMs = Date.now()) {
  return new Date(Number(nowMs)).toISOString();
}

function clean(value, max = 2000) {
  return redactSensitiveText(String(value ?? '').trim()).slice(0, max);
}

function rel(root, file) {
  return relative(root, file).replace(/\\/g, '/');
}

function safePayload(value, depth = 0) {
  if (depth > 5) return '[truncated]';
  if (typeof value === 'string') return clean(value, 2000);
  if (typeof value === 'number' || typeof value === 'boolean' || value == null) return value;
  if (Array.isArray(value)) return value.slice(0, 80).map((item) => safePayload(item, depth + 1));
  if (typeof value !== 'object') return clean(value, 500);
  const out = {};
  for (const [key, item] of Object.entries(value).slice(0, 80)) {
    const k = clean(key, 160);
    out[k] = /secret|token|key|password|authorization|cookie/i.test(k) ? '[redacted]' : safePayload(item, depth + 1);
  }
  return out;
}

function pidFromRunnerId(runnerId) {
  const match = /^mission-runner-(\d+)$/.exec(String(runnerId || ''));
  return match ? Number(match[1]) : null;
}

function runnerProcessAlive(lease = {}) {
  const pid = pidFromRunnerId(lease.runnerId);
  if (!pid) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

export class NoeMissionStore {
  constructor({ root = DEFAULT_NOE_MISSION_ROOT, baseDir = DEFAULT_NOE_MISSION_BASE_DIR } = {}) {
    this.root = resolve(root);
    this.baseDir = resolve(this.root, baseDir);
  }

  missionDir(missionId) {
    return resolve(this.baseDir, safeMissionId(missionId));
  }

  missionFile(missionId) {
    return join(this.missionDir(missionId), 'mission.json');
  }

  stateFile(missionId) {
    return join(this.missionDir(missionId), 'state.json');
  }

  eventsFile(missionId) {
    return join(this.missionDir(missionId), 'events.jsonl');
  }

  checkpointsDir(missionId) {
    return join(this.missionDir(missionId), 'checkpoints');
  }

  artifactsDir(missionId) {
    return join(this.missionDir(missionId), 'artifacts');
  }

  ensureMissionDirs(missionId) {
    for (const dir of [this.missionDir(missionId), this.checkpointsDir(missionId), this.artifactsDir(missionId)]) {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
    }
  }

  createMission(input = {}, deps = {}) {
    const contract = requireValidMissionContract(input, deps);
    this.ensureMissionDirs(contract.missionId);
    const at = nowIso(deps.nowMs);
    const state = {
      schemaVersion: 1,
      missionId: contract.missionId,
      status: 'running',
      phase: 'running',
      current_cursor: 0,
      current_slice: 0,
      last_heartbeat: null,
      blockers: [],
      recovery_attempts: 0,
      evidenceRefs: [],
      lease: null,
      noEvidenceSlices: 0,
      repeatedError: null,
      repeatedErrorCount: 0,
      finalReportRef: null,
      createdAt: at,
      updatedAt: at,
    };
    atomicWriteFile(this.missionFile(contract.missionId), `${JSON.stringify(contract, null, 2)}\n`);
    atomicWriteFile(this.stateFile(contract.missionId), `${JSON.stringify(state, null, 2)}\n`);
    this.appendEvent(contract.missionId, { type: 'mission.created', status: 'running' }, deps);
    return { mission: contract, state, refs: this.refs(contract.missionId) };
  }

  refs(missionId) {
    return {
      mission: rel(this.root, this.missionFile(missionId)),
      state: rel(this.root, this.stateFile(missionId)),
      events: rel(this.root, this.eventsFile(missionId)),
      checkpoints: rel(this.root, this.checkpointsDir(missionId)),
      artifacts: rel(this.root, this.artifactsDir(missionId)),
    };
  }

  readMission(missionId) {
    return readJsonWithCorruptBackup(this.missionFile(missionId), { label: 'noe-mission' });
  }

  readState(missionId) {
    return readJsonWithCorruptBackup(this.stateFile(missionId), { label: 'noe-mission-state' });
  }

  writeState(missionId, state, deps = {}) {
    const next = { ...state, updatedAt: nowIso(deps.nowMs) };
    atomicWriteFile(this.stateFile(missionId), `${JSON.stringify(next, null, 2)}\n`);
    return next;
  }

  updateState(missionId, updater, deps = {}) {
    const current = this.readState(missionId);
    if (!current) throw new Error(`mission state not found: ${missionId}`);
    const patch = typeof updater === 'function' ? updater({ ...current }) : updater;
    const next = patch && patch.missionId ? patch : { ...current, ...patch };
    return this.writeState(missionId, next, deps);
  }

  appendEvent(missionId, event = {}, deps = {}) {
    this.ensureMissionDirs(missionId);
    const record = {
      at: nowIso(deps.nowMs),
      missionId: safeMissionId(missionId),
      type: clean(event.type || 'mission.event', 160),
      ...safePayload(event),
    };
    appendFileSync(this.eventsFile(missionId), `${JSON.stringify(record)}\n`, { mode: 0o600 });
    try { chmodSync(this.eventsFile(missionId), 0o600); } catch {}
    return record;
  }

  readEvents(missionId, { limit = 500 } = {}) {
    const file = this.eventsFile(missionId);
    if (!existsSync(file)) return [];
    const max = Math.max(1, Math.min(5000, Number(limit) || 500));
    return readFileSync(file, 'utf8')
      .split('\n')
      .filter(Boolean)
      .slice(-max)
      .map((line) => {
        try { return JSON.parse(line); } catch { return null; }
      })
      .filter(Boolean);
  }

  addEvidenceRef(missionId, ref, deps = {}) {
    const cleanRef = clean(ref, 1000);
    if (!cleanRef) return this.readState(missionId);
    const state = this.updateState(missionId, (current) => ({
      ...current,
      evidenceRefs: [...new Set([...(current.evidenceRefs || []), cleanRef])],
    }), deps);
    this.appendEvent(missionId, { type: 'mission.evidence_ref.added', evidenceRef: cleanRef }, deps);
    return state;
  }

  writeCheckpoint(missionId, checkpoint = {}, deps = {}) {
    this.ensureMissionDirs(missionId);
    const state = this.readState(missionId) || {};
    const slice = Number(checkpoint.slice ?? state.current_slice ?? 0);
    const file = join(this.checkpointsDir(missionId), `${String(slice).padStart(6, '0')}.json`);
    const payload = { at: nowIso(deps.nowMs), missionId: safeMissionId(missionId), ...safePayload(checkpoint) };
    atomicWriteJson(file, payload);
    const ref = rel(this.root, file);
    this.appendEvent(missionId, { type: 'mission.checkpoint.written', checkpointRef: ref, slice }, deps);
    return { file, ref, checkpoint: payload };
  }

  writeArtifact(missionId, name, content, deps = {}) {
    this.ensureMissionDirs(missionId);
    const safeName = safeMissionId(name || `artifact-${Date.now()}`);
    const file = join(this.artifactsDir(missionId), safeName);
    const text = typeof content === 'string' ? clean(content, 200_000) : `${JSON.stringify(safePayload(content), null, 2)}\n`;
    atomicWriteFile(file, text);
    const ref = rel(this.root, file);
    this.addEvidenceRef(missionId, ref, deps);
    this.appendEvent(missionId, { type: 'mission.artifact.written', artifactRef: ref }, deps);
    return { file, ref };
  }

  acquireLease(missionId, { runnerId = `runner-${process.pid}`, ttlMs = 30 * 60 * 1000, nowMs = Date.now() } = {}) {
    const state = this.readState(missionId);
    if (!state) throw new Error(`mission state not found: ${missionId}`);
    const active = state.lease && Number(state.lease.expiresAtMs || 0) > nowMs;
    const ownerDead = active && state.lease.runnerId !== runnerId && !runnerProcessAlive(state.lease);
    if (active && state.lease.runnerId !== runnerId && !ownerDead) return { ok: false, reason: 'lease_active', state };
    let next = state;
    if ((state.lease && Number(state.lease.expiresAtMs || 0) <= nowMs) || ownerDead) {
      next = {
        ...state,
        status: 'recovering',
        phase: 'recovering',
        recovery_attempts: Number(state.recovery_attempts || 0) + 1,
      };
      this.appendEvent(missionId, {
        type: 'mission.lease.stale_recovered',
        reason: ownerDead ? 'runner_process_dead' : 'lease_expired',
        previousLease: state.lease,
      }, { nowMs });
    }
    next.lease = { runnerId: clean(runnerId, 160), acquiredAt: nowIso(nowMs), acquiredAtMs: nowMs, expiresAtMs: nowMs + ttlMs };
    next.last_heartbeat = nowIso(nowMs);
    next = this.writeState(missionId, next, { nowMs });
    this.appendEvent(missionId, { type: 'mission.lease.acquired', runnerId }, { nowMs });
    return { ok: true, state: next };
  }

  heartbeat(missionId, { runnerId, ttlMs = 30 * 60 * 1000, nowMs = Date.now() } = {}) {
    const state = this.readState(missionId);
    if (!state?.lease || state.lease.runnerId !== runnerId) return { ok: false, reason: 'lease_not_held', state };
    state.lease.expiresAtMs = nowMs + ttlMs;
    state.last_heartbeat = nowIso(nowMs);
    const next = this.writeState(missionId, state, { nowMs });
    this.appendEvent(missionId, { type: 'mission.heartbeat', runnerId }, { nowMs });
    return { ok: true, state: next };
  }

  releaseLease(missionId, { runnerId, force = false, nowMs = Date.now() } = {}) {
    const state = this.readState(missionId);
    if (!state?.lease) return { ok: true, state };
    if (!force && state.lease.runnerId !== runnerId) return { ok: false, reason: 'lease_not_held', state };
    const next = this.writeState(missionId, { ...state, lease: null }, { nowMs });
    this.appendEvent(missionId, { type: 'mission.lease.released', runnerId, force }, { nowMs });
    return { ok: true, state: next };
  }

  listMissions({ limit = 20 } = {}) {
    if (!existsSync(this.baseDir)) return [];
    return readdirSync(this.baseDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => this.readState(entry.name))
      .filter(Boolean)
      .sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')))
      .slice(0, Math.max(1, Math.min(100, Number(limit) || 20)));
  }

  refExists(ref) {
    const file = resolve(this.root, clean(ref, 1000));
    if (file !== this.root && !file.startsWith(`${this.root}${sep}`)) return false;
    try { return existsSync(file) && statSync(file).isFile(); } catch { return false; }
  }
}
