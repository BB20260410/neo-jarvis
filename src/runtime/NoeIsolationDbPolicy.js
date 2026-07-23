// @ts-check
/**
 * Isolation DB policy: non-live PORT must not silently share live panel.db.
 * Auto-assigns PANEL_DB_PATH under ~/.noe-panel/isolation/ when missing.
 */

import path from 'node:path';
import os from 'node:os';

export const NOE_LIVE_PANEL_PORT = 51835;

/**
 * @param {string|number|undefined} port
 * @param {number} [livePort]
 */
export function isLivePanelPort(port, livePort = NOE_LIVE_PANEL_PORT) {
  const n = Number(port);
  if (!Number.isFinite(n)) return true; // missing → treat as live default path
  return Math.trunc(n) === Math.trunc(Number(livePort) || NOE_LIVE_PANEL_PORT);
}

/**
 * @param {string} candidate
 * @param {string} liveDbPath
 */
export function isSameDbPath(candidate, liveDbPath) {
  const a = path.resolve(String(candidate || ''));
  const b = path.resolve(String(liveDbPath || ''));
  return a === b;
}

/**
 * Resolve isolation DB path for a given port.
 * @param {object} [opts]
 * @param {string|number} [opts.port]
 * @param {NodeJS.ProcessEnv|Record<string,string|undefined>} [opts.env]
 * @param {string} [opts.liveDbPath]
 * @param {string} [opts.isolationDir]
 * @param {boolean} [opts.failClosed] when true and env points at live DB on isolation port → throw
 * @returns {{ isolation: boolean, path: string|null, source: 'live-default'|'env'|'auto'|'live-port', liveDbPath: string, rewritten: boolean, reason: string }}
 */
export function resolveIsolationDbPath({
  port = process.env.PORT,
  env = process.env,
  liveDbPath = path.join(os.homedir(), '.noe-panel', 'panel.db'),
  isolationDir = path.join(os.homedir(), '.noe-panel', 'isolation'),
  failClosed = true,
} = {}) {
  const live = path.resolve(String(liveDbPath));
  if (isLivePanelPort(port)) {
    const fromEnv = String(env?.PANEL_DB_PATH || '').trim();
    return {
      isolation: false,
      path: fromEnv || live,
      source: fromEnv ? 'env' : 'live-port',
      liveDbPath: live,
      rewritten: false,
      reason: 'live_port_uses_default_or_explicit_db',
    };
  }

  const portNum = Math.trunc(Number(port));
  const fromEnv = String(env?.PANEL_DB_PATH || '').trim();
  if (fromEnv) {
    if (isSameDbPath(fromEnv, live)) {
      if (failClosed && env?.NOE_ALLOW_ISOLATION_LIVE_DB !== '1') {
        // Auto-rewrite rather than share live DB (safer default for isolation).
        const autoPath = path.join(isolationDir, `panel-isolation-${portNum}.db`);
        return {
          isolation: true,
          path: autoPath,
          source: 'auto',
          liveDbPath: live,
          rewritten: true,
          reason: 'isolation_port_blocked_live_db_path_auto_rewritten',
        };
      }
      return {
        isolation: true,
        path: fromEnv,
        source: 'env',
        liveDbPath: live,
        rewritten: false,
        reason: 'isolation_port_explicitly_allowed_live_db',
      };
    }
    return {
      isolation: true,
      path: path.resolve(fromEnv),
      source: 'env',
      liveDbPath: live,
      rewritten: false,
      reason: 'isolation_port_explicit_non_live_db',
    };
  }

  const autoPath = path.join(isolationDir, `panel-isolation-${portNum}.db`);
  return {
    isolation: true,
    path: autoPath,
    source: 'auto',
    liveDbPath: live,
    rewritten: true,
    reason: 'isolation_port_auto_db_path',
  };
}

/**
 * Apply isolation DB policy onto process.env (mutates env).
 * Call before any SqliteStore init on isolation ports.
 * @returns {ReturnType<typeof resolveIsolationDbPath>}
 */
export function applyIsolationDbPolicyToEnv(opts = {}) {
  const env = opts.env || process.env;
  const resolved = resolveIsolationDbPath({ ...opts, env });
  if (resolved.isolation && resolved.path) {
    env.PANEL_DB_PATH = resolved.path;
  }
  return resolved;
}
