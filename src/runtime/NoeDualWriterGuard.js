// @ts-check
/**
 * Detect dual-writer / multi-process access to the same panel DB.
 * Pure scoring over process snapshots so doctor can unit-test without live lsof.
 */

import path from 'node:path';

/**
 * @typedef {{ pid: string|number, cwd?: string|null, cmd?: string, openFiles?: string[] }} ProcessSnapshot
 */

/**
 * Normalize a path for comparison.
 * @param {string} p
 */
export function normalizeDbPath(p) {
  try {
    return path.resolve(String(p || ''));
  } catch {
    return String(p || '');
  }
}

/**
 * Count distinct PIDs that hold the target DB open (or cwd matches isolation risk).
 * @param {object} opts
 * @param {string} opts.dbPath
 * @param {ProcessSnapshot[]} [opts.processes]
 * @param {Array<{pid:string|number,port?:number}>} [opts.listeners] TCP listeners
 * @param {number} [opts.livePort]
 * @returns {{ severity: 'ok'|'warn'|'error', dualWriter: boolean, pids: string[], message: string, data: object }}
 */
export function assessDualWriterRisk({
  dbPath,
  processes = [],
  listeners = [],
  livePort = 51835,
} = {}) {
  const target = normalizeDbPath(dbPath);
  const holding = new Set();
  for (const proc of processes) {
    const pid = String(proc?.pid ?? '').trim();
    if (!pid) continue;
    const files = Array.isArray(proc.openFiles) ? proc.openFiles : [];
    const hit = files.some((f) => normalizeDbPath(f) === target);
    const cmd = String(proc.cmd || '');
    const looksNoe = /server\.js|noe|panel/i.test(cmd);
    if (hit || (looksNoe && files.some((f) => String(f).includes('panel') && String(f).endsWith('.db') && normalizeDbPath(f) === target))) {
      holding.add(pid);
    }
  }

  // Multi-listener on same port is not dual-DB; multi-listener across ports + same DB is.
  const listenerPids = new Set(
    (Array.isArray(listeners) ? listeners : [])
      .map((l) => String(l?.pid ?? '').trim())
      .filter(Boolean),
  );

  // If ≥2 processes hold the DB open → error
  const pids = [...holding];
  if (pids.length >= 2) {
    return {
      severity: 'error',
      dualWriter: true,
      pids,
      message: `dual_writer: ${pids.length} processes have panel DB open`,
      data: { dbPath: target, pids, listenerPids: [...listenerPids], livePort },
    };
  }

  // Isolation smell: live port listener + another noe process with same DB
  if (pids.length === 1 && listenerPids.size >= 2) {
    return {
      severity: 'warn',
      dualWriter: false,
      pids,
      message: 'multiple_listeners_with_db_holder: verify isolation ports use separate PANEL_DB_PATH',
      data: { dbPath: target, pids, listenerPids: [...listenerPids], livePort },
    };
  }

  return {
    severity: 'ok',
    dualWriter: false,
    pids,
    message: 'no_dual_writer_detected',
    data: { dbPath: target, pids, listenerPids: [...listenerPids], livePort },
  };
}

/**
 * Doctor finding wrapper.
 * @param {ReturnType<typeof assessDualWriterRisk>} assessment
 */
export function dualWriterToDoctorFinding(assessment) {
  const severity = assessment.severity === 'error' ? 'error'
    : assessment.severity === 'warn' ? 'warn'
      : 'info';
  return {
    checkId: 'db.dual_writer',
    severity,
    message: assessment.message,
    fixHint: assessment.dualWriter
      ? 'stop isolation servers sharing live PANEL_DB_PATH; use PORT!=51835 auto isolation DB under ~/.noe-panel/isolation/'
      : undefined,
    data: assessment.data,
  };
}
