// @ts-check

const ACTIVE_STATUSES = new Set(['running', 'starting', 'in_progress', 'verifying']);

function status(value) {
  return String(value || '').trim().toLowerCase();
}

/**
 * Build a conservative, explicit snapshot for the desktop update drain gate.
 * A source collection error makes the whole snapshot unavailable rather than
 * silently treating that source as zero active work.
 *
 * @param {{
 *   rooms?: any[],
 *   sessions?: any[],
 *   agentRuns?: any[],
 *   agentRunsCount?: number,
 *   autopilotJobs?: any[],
 *   sourceErrors?: string[],
 *   observedAt?: string,
 * }} [input]
 */
export function buildUpdateDrainSnapshot(input = {}) {
  const rooms = Array.isArray(input.rooms) ? input.rooms : [];
  const sessions = Array.isArray(input.sessions) ? input.sessions : [];
  const agentRuns = Array.isArray(input.agentRuns) ? input.agentRuns : [];
  const autopilotJobs = Array.isArray(input.autopilotJobs) ? input.autopilotJobs : [];
  const sourceErrors = Array.isArray(input.sourceErrors)
    ? input.sourceErrors.map((item) => String(item || '').trim()).filter(Boolean)
    : [];

  const roomRuns = rooms.filter((room) => ACTIVE_STATUSES.has(status(room?.status))).length;
  const roomTasks = rooms.reduce(
    (count, room) => count + (Array.isArray(room?.taskList)
      ? room.taskList.filter((task) => ACTIVE_STATUSES.has(status(task?.status))).length
      : 0),
    0,
  );
  const busySessions = sessions.filter(
    (session) => session?.busy === true || ACTIVE_STATUSES.has(status(session?.runState)),
  ).length;
  // Prefer exact SQL count when provided — list({limit:500}) falsely caps at 500 forever.
  const activeAgentRuns = Number.isFinite(Number(input.agentRunsCount))
    ? Math.max(0, Math.floor(Number(input.agentRunsCount)))
    : agentRuns.filter((run) => ACTIVE_STATUSES.has(status(run?.status))).length;
  const activeAutopilotJobs = autopilotJobs.filter(
    (job) => ACTIVE_STATUSES.has(status(job?.status)),
  ).length;
  const counts = {
    roomRuns,
    roomTasks,
    busySessions,
    agentRuns: activeAgentRuns,
    autopilotJobs: activeAutopilotJobs,
  };
  const runningTaskCount = Object.values(counts).reduce((sum, count) => sum + count, 0);
  const available = sourceErrors.length === 0;
  return {
    schemaVersion: 1,
    observedAt: input.observedAt || new Date().toISOString(),
    available,
    runningTaskCount,
    drainComplete: available && runningTaskCount === 0,
    counts,
    sourceErrors,
  };
}

/**
 * Read every update-drain source without allowing an exception, missing
 * reader, or malformed result to become an implicit zero-active-work claim.
 *
 * @param {{
 *   rooms?: () => unknown,
 *   sessions?: () => unknown,
 *   agentRuns?: () => unknown,
 *   agentRunsCount?: () => unknown,
 *   autopilotJobs?: () => unknown,
 *   observedAt?: string,
 * }} [readers]
 */
export function buildUpdateDrainSnapshotFromReaders(readers = {}) {
  const sourceErrors = [];
  const collect = (name, reader) => {
    if (typeof reader !== 'function') {
      sourceErrors.push(`${name}:reader_missing`);
      return [];
    }
    try {
      const value = reader();
      if (Array.isArray(value)) return value;
      sourceErrors.push(`${name}:non_array_result`);
    } catch (error) {
      sourceErrors.push(`${name}:${error?.message || String(error)}`.slice(0, 240));
    }
    return [];
  };
  /** @type {number|undefined} */
  let agentRunsCount;
  if (typeof readers.agentRunsCount === 'function') {
    try {
      const n = readers.agentRunsCount();
      if (Number.isFinite(Number(n)) && Number(n) >= 0) agentRunsCount = Math.floor(Number(n));
      else sourceErrors.push('agent_runs_count:invalid_number');
    } catch (error) {
      sourceErrors.push(`agent_runs_count:${error?.message || String(error)}`.slice(0, 240));
    }
  }
  return buildUpdateDrainSnapshot({
    rooms: collect('rooms', readers.rooms),
    sessions: collect('sessions', readers.sessions),
    // When exact count is available, skip array list (avoids 500-cap + heavy list on large DB).
    agentRuns: agentRunsCount !== undefined
      ? []
      : collect('agent_runs', readers.agentRuns),
    agentRunsCount,
    autopilotJobs: collect('autopilot_jobs', readers.autopilotJobs),
    observedAt: readers.observedAt,
    sourceErrors,
  });
}

/**
 * Parse the public /health payload used by the packaged Electron updater.
 * Missing fields, contradictory counts, or a degraded source are rejected.
 *
 * @param {unknown} payload
 */
export function parseUpdateDrainHealthPayload(payload) {
  if (!payload || typeof payload !== 'object') return null;
  const root = /** @type {Record<string, any>} */ (payload);
  const drain = root.taskDrain;
  if (root.ok !== true || !drain || typeof drain !== 'object') return null;
  if (drain.available !== true || drain.drainComplete !== true) return null;
  if (!Number.isInteger(drain.runningTaskCount) || drain.runningTaskCount !== 0) return null;
  if (!drain.counts || typeof drain.counts !== 'object') return null;
  if (!Array.isArray(drain.sourceErrors) || drain.sourceErrors.length !== 0) return null;
  const counts = Object.values(drain.counts);
  if (
    counts.length === 0 ||
    counts.some((count) => !Number.isInteger(count) || Number(count) < 0) ||
    counts.reduce((sum, count) => sum + Number(count), 0) !== 0
  ) return null;
  return {
    available: true,
    drainComplete: true,
    runningTaskCount: 0,
    counts: { ...drain.counts },
    observedAt: String(drain.observedAt || ''),
  };
}
