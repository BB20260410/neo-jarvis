// @ts-check
/**
 * Process registry for Neo-owned children.
 * Tracks spawns so Doctor / supervisor can detect orphans (PPID=1 / parent dead)
 * without mass-killing unrelated node processes.
 *
 * Fail-closed: only registered Neo-owned patterns are eligible for precise cleanup.
 */
import { createHash } from 'node:crypto';

export const PROCESS_REGISTRY_SCHEMA_VERSION = 1;

/** @typedef {{ pid: number, ppid?: number, cmd?: string, cwd?: string, startedAt?: string, kind?: string, owner?: string, registrationId?: string }} ProcessRecord */

/**
 * @param {string|number} pid
 * @param {string} [cmd]
 * @param {string} [kind]
 */
export function makeRegistrationId(pid, cmd = '', kind = '') {
  return createHash('sha256').update(`${pid}|${cmd}|${kind}`).digest('hex').slice(0, 16);
}

/**
 * Heuristic: does command look Neo-owned (panel/server/mcp under Neo)?
 * Conservative — false negatives OK; false positives dangerous.
 * @param {string} cmd
 * @param {string} [cwd]
 * @param {string[]} [neoRoots]
 */
export function isNeoOwnedCommand(cmd = '', cwd = '', neoRoots = []) {
  const c = String(cmd || '');
  const w = String(cwd || '');
  if (/cartoon-apocalypse|panel51735|xikelab\.panel51735/i.test(c) || /51735/.test(c)) {
    return false;
  }
  const roots = Array.isArray(neoRoots) ? neoRoots : [];
  if (roots.some((r) => r && (w.startsWith(r) || c.includes(r)))) {
    if (/node|electron|mcp|noe|server\.js|python/i.test(c)) return true;
  }
  // Explicit Neo markers
  if (/\bnoe\b|Neo 贾维斯|noe-panel|server\.js.*51835|com\.noe\.panel/i.test(c)) return true;
  if (/@modelcontextprotocol|mcp-server.*noe/i.test(c) && /noe|neo/i.test(c + w)) return true;
  return false;
}

/**
 * Known long-running companion services (voice etc.) that may reparent to PPID=1
 * without being "failure orphans". Still neo-owned; counted separately.
 * @param {string} cmd
 */
export function isNeoCompanionCommand(cmd = '') {
  const c = String(cmd || '');
  return /noe-whisper-server|noe-qwen-tts-server|noe-kokoro|cosyvoice|com\.noe\.(whisper|tts|cosyvoice)/i.test(c);
}

/**
 * In-memory registry (injectable for tests).
 */
export class NoeProcessRegistry {
  /**
   * @param {{ now?: () => Date, neoRoots?: string[] }} [opts]
   */
  constructor(opts = {}) {
    /** @type {Map<string, ProcessRecord>} */
    this._byPid = new Map();
    this._now = opts.now || (() => new Date());
    this._neoRoots = opts.neoRoots || [];
  }

  /**
   * @param {ProcessRecord} rec
   */
  register(rec) {
    const pid = Number(rec.pid);
    if (!Number.isFinite(pid) || pid <= 0) {
      return { ok: false, error: 'invalid_pid' };
    }
    const cmd = String(rec.cmd || '');
    const record = {
      pid,
      ppid: rec.ppid != null ? Number(rec.ppid) : undefined,
      cmd,
      cwd: rec.cwd || '',
      startedAt: rec.startedAt || this._now().toISOString(),
      kind: rec.kind || 'child',
      owner: rec.owner || 'neo',
      registrationId: rec.registrationId || makeRegistrationId(pid, cmd, rec.kind || 'child'),
    };
    this._byPid.set(String(pid), record);
    return { ok: true, record };
  }

  /**
   * @param {string|number} pid
   */
  unregister(pid) {
    return this._byPid.delete(String(pid));
  }

  /**
   * @returns {ProcessRecord[]}
   */
  list() {
    return [...this._byPid.values()].sort((a, b) => a.pid - b.pid);
  }

  /**
   * Compare registry + live process table → orphans / missing / foreign.
   * @param {Array<{pid:number|string, ppid?:number|string, cmd?:string, cwd?:string}>} liveProcesses
   */
  reconcile(liveProcesses = []) {
    const live = new Map(
      (Array.isArray(liveProcesses) ? liveProcesses : []).map((p) => [String(p.pid), p]),
    );
    /** @type {ProcessRecord[]} */
    const orphans = [];
    /** @type {ProcessRecord[]} */
    const missing = [];
    /** @type {ProcessRecord[]} */
    const healthy = [];

    for (const rec of this.list()) {
      const liveRec = live.get(String(rec.pid));
      if (!liveRec) {
        missing.push(rec);
        continue;
      }
      const ppid = Number(liveRec.ppid);
      // Orphan: parent reaped (ppid 1 on unix) while still running and neo-owned
      if (ppid === 1 && isNeoOwnedCommand(liveRec.cmd || rec.cmd, liveRec.cwd || rec.cwd, this._neoRoots)) {
        orphans.push({ ...rec, ppid: 1, cmd: liveRec.cmd || rec.cmd });
      } else {
        healthy.push({ ...rec, ppid });
      }
    }

    // Unregistered live neo-owned PPID=1 candidates (report only — not auto-kill)
    /** @type {Array<{pid:number, ppid:number, cmd:string, cwd?:string, companion?:boolean}>} */
    const untrackedNeoOrphans = [];
    /** @type {Array<{pid:number, ppid:number, cmd:string, cwd?:string}>} */
    const companions = [];
    for (const [pid, p] of live) {
      if (this._byPid.has(pid)) continue;
      if (Number(p.ppid) !== 1) continue;
      if (!isNeoOwnedCommand(p.cmd || '', p.cwd || '', this._neoRoots)) continue;
      const rec = {
        pid: Number(p.pid),
        ppid: 1,
        cmd: String(p.cmd || ''),
        cwd: p.cwd,
      };
      if (isNeoCompanionCommand(rec.cmd)) {
        companions.push(rec);
      } else {
        untrackedNeoOrphans.push(rec);
      }
    }

    // Split registered orphans into failure orphans vs companions
    const failureOrphans = orphans.filter((o) => !isNeoCompanionCommand(o.cmd || ''));
    const companionOrphans = orphans.filter((o) => isNeoCompanionCommand(o.cmd || ''));
    for (const c of companionOrphans) companions.push(c);

    return {
      schemaVersion: PROCESS_REGISTRY_SCHEMA_VERSION,
      registered: this.list().length,
      healthy: healthy.length,
      orphanCount: failureOrphans.length,
      missingCount: missing.length,
      untrackedNeoOrphanCount: untrackedNeoOrphans.length,
      companionCount: companions.length,
      orphans: failureOrphans,
      companions,
      missing,
      untrackedNeoOrphans,
      // G-PROC-01 product metric: failure orphans only (not expected voice companions)
      neoOwnedOrphanProcessCount: failureOrphans.length + untrackedNeoOrphans.length,
    };
  }

  /**
   * Plan precise cleanup — never kills untracked or non-neo.
   * @param {ReturnType<NoeProcessRegistry['reconcile']>} report
   * @param {{ allowUntracked?: boolean }} [opts]
   */
  planPreciseCleanup(report, opts = {}) {
    // Never auto-target companions (voice etc.) unless explicitly requested
    const targets = [...(report.orphans || [])];
    if (opts.allowUntracked === true) {
      for (const u of report.untrackedNeoOrphans || []) {
        targets.push({
          pid: u.pid,
          ppid: 1,
          cmd: u.cmd,
          kind: 'untracked_orphan',
          owner: 'neo',
          registrationId: makeRegistrationId(u.pid, u.cmd, 'untracked'),
        });
      }
    }
    if (opts.includeCompanions === true) {
      for (const c of report.companions || []) {
        targets.push({
          pid: c.pid,
          ppid: 1,
          cmd: c.cmd,
          kind: 'companion',
          owner: 'neo',
          registrationId: makeRegistrationId(c.pid, c.cmd, 'companion'),
        });
      }
    }
    return {
      action: 'precise_cleanup_plan',
      dryRunDefault: true,
      targets: targets.map((t) => ({
        pid: t.pid,
        registrationId: t.registrationId,
        kind: t.kind,
        cmd: String(t.cmd || '').slice(0, 200),
        signal: 'SIGTERM',
        escalateTo: 'SIGKILL',
      })),
      rejected: {
        massKillAllNodePpid1: false,
        reason: 'only_registered_or_explicit_neo_owned_orphans',
      },
    };
  }
}

/** @type {NoeProcessRegistry|null} */
let _singleton = null;

export function getProcessRegistry(opts = {}) {
  if (!_singleton) _singleton = new NoeProcessRegistry(opts);
  return _singleton;
}

export function resetProcessRegistryForTests() {
  _singleton = null;
}
