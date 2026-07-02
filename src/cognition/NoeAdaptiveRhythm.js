// @ts-check
// NoeAdaptiveRhythm — 把“醒一次”和“动用重模型深想一次”拆开。
//
// meso 心跳可以很密（例如 5 秒）来维持持续存在感；但本地大脑生成一次内心独白是重代谢。
// 有主人互动、到期牵挂、目标步骤等高价值焦点时立即重想；只有上一念头/系统状态等低信号时，
// 保持轻醒扫描，只按空闲间隔偶尔重想，避免把时间线灌满重复自语。

export const DEFAULT_IDLE_INNER_INTERVAL_MS = 15_000;
export const DEFAULT_GROWTH_INNER_INTERVAL_MS = 5_000;

const DEFAULT_FORCE_HEAVY_SOURCES = Object.freeze([
  'owner_interaction',
  'commitment_due',
  'expectation_due',
  'goal_step',
]);

const DEFAULT_GROWTH_SOURCES = Object.freeze([
  'fresh_insight',
  'drive',
  'percept',
]);

function positiveMs(value, fallback, minMs = 0) {
  const n = Number(value);
  const base = Number.isFinite(n) && n > 0 ? n : fallback;
  return Math.max(minMs, base);
}

export function normalizeAdaptiveIntervalMs(value, fallback, minMs = 5_000) {
  return positiveMs(value, fallback, minMs);
}

function elapsedSince(now, lastHeavyAt) {
  const nowMs = Number.isFinite(Number(now)) ? Number(now) : Date.now();
  const last = Number.isFinite(Number(lastHeavyAt)) && Number(lastHeavyAt) > 0 ? Number(lastHeavyAt) : 0;
  return { nowMs, elapsedMs: last > 0 ? Math.max(0, nowMs - last) : Infinity };
}

function intervalDecision(prefix, everyMs, elapsedMs, source, score) {
  if (elapsedMs >= everyMs) {
    return { runHeavy: true, reason: `${prefix}_interval`, source, score, elapsedMs };
  }
  return {
    runHeavy: false,
    reason: `${prefix}_cooldown`,
    source,
    score,
    elapsedMs,
    nextInMs: Math.max(0, everyMs - elapsedMs),
  };
}

/**
 * Decide whether this meso tick should call the heavy inner-monologue model.
 *
 * @param {object} args
 * @param {{winner?: {source?: string, score?: number}|null, escalated?: boolean}|null|undefined} args.workspaceResult
 * @param {number} [args.now]
 * @param {number} [args.lastHeavyAt]
 * @param {boolean} [args.heavyInFlight]
 * @param {number} [args.idleHeavyEveryMs]
 * @param {number} [args.growthHeavyEveryMs]
 * @param {string[]} [args.forceHeavySources]
 * @param {string[]} [args.growthSources]
 * @param {number} [args.salientScore]
 * @returns {{runHeavy: boolean, reason: string, source?: string|null, score?: number|null, elapsedMs?: number, nextInMs?: number}}
 */
export function decideMesoInnerRhythm({
  workspaceResult,
  now = Date.now(),
  lastHeavyAt = 0,
  heavyInFlight = false,
  idleHeavyEveryMs = DEFAULT_IDLE_INNER_INTERVAL_MS,
  growthHeavyEveryMs = DEFAULT_GROWTH_INNER_INTERVAL_MS,
  forceHeavySources = DEFAULT_FORCE_HEAVY_SOURCES,
  growthSources = DEFAULT_GROWTH_SOURCES,
  salientScore = 0.68,
} = {}) {
  const { elapsedMs } = elapsedSince(now, lastHeavyAt);
  if (heavyInFlight) return { runHeavy: false, reason: 'heavy_in_flight', elapsedMs };

  // 没有工作区时保持旧行为：每个 inner tick 都反刍，避免隐式改变未启用 P3 的部署。
  if (!workspaceResult) return { runHeavy: true, reason: 'ungated_no_workspace', elapsedMs };

  const winner = workspaceResult.winner || null;
  const source = winner?.source ? String(winner.source) : null;
  const score = Number.isFinite(Number(winner?.score)) ? Number(winner.score) : null;

  if (workspaceResult.escalated) {
    return { runHeavy: true, reason: 'workspace_escalated', source, score, elapsedMs };
  }
  if (!winner) {
    return intervalDecision(
      'idle_no_focus',
      positiveMs(idleHeavyEveryMs, DEFAULT_IDLE_INNER_INTERVAL_MS),
      elapsedMs,
      null,
      null,
    );
  }

  const forceSet = new Set(forceHeavySources || DEFAULT_FORCE_HEAVY_SOURCES);
  if (source && forceSet.has(source)) {
    return { runHeavy: true, reason: 'force_focus', source, score, elapsedMs };
  }

  if (score != null && score >= salientScore) {
    return { runHeavy: true, reason: 'salient_focus', source, score, elapsedMs };
  }

  const growthSet = new Set(growthSources || DEFAULT_GROWTH_SOURCES);
  if (source && growthSet.has(source)) {
    return intervalDecision(
      'growth_focus',
      positiveMs(growthHeavyEveryMs, DEFAULT_GROWTH_INNER_INTERVAL_MS),
      elapsedMs,
      source,
      score,
    );
  }

  return intervalDecision(
    'idle_focus',
    positiveMs(idleHeavyEveryMs, DEFAULT_IDLE_INNER_INTERVAL_MS),
    elapsedMs,
    source,
    score,
  );
}
