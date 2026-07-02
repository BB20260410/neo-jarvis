// @ts-check
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { redactSensitiveText } from './NoeContextScrubber.js';
import { summarizeReportbacks } from './NoeWorkMapReportbacks.js';

export const DEFAULT_NOE_WORK_MAP_DATA_DIR = join(homedir(), '.noe-panel');
export const DEFAULT_NOE_WORK_MAP_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const DEFAULT_NOE_WORK_MAP_OUT_DIR = 'output/noe-work-map';

const ACTIVE_STATUSES = new Set(['active', 'open', 'accepted', 'queued', 'running', 'recovering', 'waiting_approval', 'awaiting_approval']);
const BLOCKED_STATUSES = new Set(['blocked', 'failed', 'error']);
const DONE_STATUSES = new Set(['done', 'succeeded', 'completed', 'cancelled', 'canceled', 'dropped']);

function clean(value, max = 400) {
  return redactSensitiveText(String(value ?? ''))
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}
function readJson(file, fallback = null) {
  try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return fallback; }
}
function rel(root, file) {
  const abs = resolve(file);
  return abs.startsWith(resolve(root)) ? relative(resolve(root), abs).replace(/\\/g, '/') : abs;
}
function mapValues(value) {
  if (!value) return [];
  if (value instanceof Map) return [...value.values()];
  if (Array.isArray(value)) return value;
  if (typeof value.values === 'function') {
    try { return [...value.values()]; } catch {}
  }
  return [];
}
function countBy(rows = [], keyFn = (x) => x?.status || 'unknown') {
  const out = {};
  for (const row of rows || []) {
    const key = clean(keyFn(row) || 'unknown', 80) || 'unknown';
    out[key] = (out[key] || 0) + 1;
  }
  return out;
}

function toneFor(status = '') {
  const s = clean(status, 80);
  if (ACTIVE_STATUSES.has(s)) return 'active';
  if (BLOCKED_STATUSES.has(s)) return 'blocked';
  if (DONE_STATUSES.has(s)) return 'done';
  return 'idle';
}

function timeMs(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim()) {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
    const numeric = Number(value);
    if (Number.isFinite(numeric)) return numeric;
  }
  return 0;
}

function makeItem(input = {}) {
  const status = clean(input.status || 'unknown', 80);
  return {
    id: clean(input.id, 180),
    kind: clean(input.kind, 60),
    title: clean(input.title || input.id || 'untitled', 180),
    status,
    tone: input.tone || toneFor(status),
    source: clean(input.source || '', 80),
    detail: clean(input.detail || '', 260),
    priority: Number(input.priority || 0),
    updatedAt: input.updatedAt || null,
    evidenceCount: Number(input.evidenceCount || 0),
    parentId: clean(input.parentId || '', 180) || null,
    ref: clean(input.ref || '', 260) || null,
  };
}

function activeCountByStatus(counts = {}) {
  return Object.entries(counts).reduce((sum, [status, count]) => (
    ACTIVE_STATUSES.has(status) ? sum + Number(count || 0) : sum
  ), 0);
}

function safeAll(source, sql) {
  if (!source) return [];
  try {
    if (typeof source.all === 'function') return source.all(sql) || [];
    if (typeof source.prepare === 'function') return source.prepare(sql).all();
  } catch {}
  return [];
}

function summarizeSessions({ sessions = null, dataDir = DEFAULT_NOE_WORK_MAP_DATA_DIR } = {}) {
  const rows = sessions ? mapValues(sessions) : readJson(join(dataDir, 'data.json'), []);
  const list = Array.isArray(rows) ? rows : [];
  const items = list
    .filter((s) => !s?.archived && (s?.busy || s?.runState === 'running' || s?.mainGoal))
    .slice(0, 20)
    .map((s) => makeItem({
      id: s.id,
      kind: 'session',
      title: s.mainGoal || s.name,
      status: s.busy ? 'running' : (s.runState || 'idle'),
      source: 'session',
      detail: `${clean(s.name, 80)} · messages ${Array.isArray(s.messages) ? s.messages.length : Number(s.msgCount || 0)}`,
      updatedAt: s.updatedAt || s.createdAt || null,
    }));
  return {
    total: list.length,
    active: list.filter((s) => !s?.archived).length,
    archived: list.filter((s) => s?.archived).length,
    busy: list.filter((s) => s?.busy).length,
    runStateCounts: countBy(list, (s) => s?.runState || (s?.busy ? 'running' : 'idle')),
    items,
  };
}

function summarizeRooms({ roomStore = null, dataDir = DEFAULT_NOE_WORK_MAP_DATA_DIR } = {}) {
  let active = [];
  let archived = [];
  if (roomStore?.list) {
    try { active = roomStore.list() || []; } catch {}
    try { archived = roomStore.listArchived?.() || []; } catch {}
  } else {
    active = readJson(join(dataDir, 'rooms.json'), { rooms: [] })?.rooms || [];
    archived = readJson(join(dataDir, 'rooms-archive.json'), { rooms: [] })?.rooms || [];
  }
  const items = active.slice(0, 40).map((r) => makeItem({
    id: r.id,
    kind: 'room',
    title: r.objective?.title || r.name || r.topic,
    status: r.status || 'idle',
    source: r.mode || 'room',
    detail: `${clean(r.name, 80)} · tasks ${Array.isArray(r.taskList) ? r.taskList.length : 0} · turns ${(Array.isArray(r.conversation) ? r.conversation.length : 0) + (Array.isArray(r.rounds) ? r.rounds.length : 0)}`,
    updatedAt: r.updatedAt || r.lastActivityAt || r.createdAt || null,
    parentId: r.parentRoomId || r.lineage?.parentRoomId || null,
  }));
  return {
    activeCount: active.length,
    archivedCount: archived.length,
    modeCounts: countBy(active, (r) => r?.mode || 'debate'),
    statusCounts: countBy(active, (r) => r?.status || 'idle'),
    items,
  };
}

function scanMissions({ rootDir = DEFAULT_NOE_WORK_MAP_ROOT, limit = 120 } = {}) {
  const missionRoot = join(rootDir, 'output', 'noe-missions');
  const rows = [];
  if (existsSync(missionRoot)) {
    for (const ent of readdirSync(missionRoot, { withFileTypes: true })) {
      if (!ent.isDirectory()) continue;
      const dir = join(missionRoot, ent.name);
      const state = readJson(join(dir, 'state.json'), null);
      const mission = readJson(join(dir, 'mission.json'), null);
      if (!state && !mission) continue;
      const rawStatus = clean(state?.status || mission?.status || 'unknown', 80);
      const finalReportRef = rel(rootDir, join(dir, 'artifacts', 'final-report.json'));
      const finalReport = readJson(join(dir, 'artifacts', 'final-report.json'), null);
      const status = ACTIVE_STATUSES.has(rawStatus) && finalReport?.ok === true
        ? 'succeeded'
        : ACTIVE_STATUSES.has(rawStatus) && finalReport?.ok === false
          ? 'blocked'
          : rawStatus;
      let mtimeMs = 0;
      try { mtimeMs = statSync(join(dir, 'state.json')).mtimeMs; } catch {}
      rows.push({
        id: ent.name,
        status,
        rawStatus,
        statusDerivedFrom: status !== rawStatus ? finalReportRef : '',
        objective: mission?.objective || '',
        updatedAt: state?.updatedAt || (mtimeMs ? new Date(mtimeMs).toISOString() : null),
        evidenceCount: Array.isArray(state?.evidenceRefs) ? state.evidenceRefs.length : 0,
        currentSlice: Number(state?.current_slice || 0),
        recoveryAttempts: Number(state?.recovery_attempts || 0),
        ref: rel(rootDir, dir),
      });
    }
  }
  rows.sort((a, b) => timeMs(b.updatedAt) - timeMs(a.updatedAt));
  const items = rows.slice(0, limit).map((m) => makeItem({
    id: m.id,
    kind: 'mission',
    title: m.objective || m.id,
    status: m.status,
    source: 'mission_runtime',
    detail: m.statusDerivedFrom
      ? `slice ${m.currentSlice} · recovery ${m.recoveryAttempts} · state ${m.rawStatus} -> final report`
      : `slice ${m.currentSlice} · recovery ${m.recoveryAttempts}`,
    updatedAt: m.updatedAt,
    evidenceCount: m.evidenceCount,
    ref: m.statusDerivedFrom || m.ref,
  }));
  const statusCounts = countBy(rows, (m) => m.status || 'unknown');
  return {
    total: rows.length,
    active: activeCountByStatus(statusCounts),
    statusCounts,
    items,
  };
}

function summarizeGoals(dbSource) {
  const rows = safeAll(dbSource, "SELECT id, source, status, priority, title, created_at, updated_at FROM noe_goals ORDER BY updated_at DESC LIMIT 160");
  const checkpointRows = safeAll(dbSource, 'SELECT goal_id, COUNT(*) AS count FROM noe_goal_checkpoints GROUP BY goal_id');
  const checkpointCounts = new Map(checkpointRows.map((row) => [String(row.goal_id || ''), Number(row.count || 0)]));
  const activeRows = rows.filter((row) => ACTIVE_STATUSES.has(clean(row.status, 80)));
  const items = rows
    .filter((row) => ACTIVE_STATUSES.has(clean(row.status, 80)))
    .slice(0, 60)
    .map((row) => makeItem({
      id: row.id,
      kind: 'goal',
      title: row.title,
      status: row.status || 'open',
      source: row.source || 'goal',
      detail: checkpointCounts.get(String(row.id || '')) ? `checkpoints ${checkpointCounts.get(String(row.id || ''))}` : 'no checkpoints yet',
      priority: Number(row.priority || 0),
      updatedAt: Number(row.updated_at || 0) ? new Date(Number(row.updated_at)).toISOString() : null,
      evidenceCount: checkpointCounts.get(String(row.id || '')) || 0,
    }));
  const withoutCheckpoints = activeRows.filter((row) => !checkpointCounts.get(String(row.id || ''))).length;
  return {
    total: rows.length,
    active: activeRows.length,
    statusCounts: countBy(rows, (row) => row.status || 'unknown'),
    sourceStatusCounts: rows.reduce((acc, row) => {
      const key = `${clean(row.source || 'unknown', 80)}:${clean(row.status || 'unknown', 80)}`;
      acc[key] = (acc[key] || 0) + 1;
      return acc;
    }, {}),
    hygiene: {
      checkpointBacked: activeRows.length - withoutCheckpoints,
      withoutCheckpoints,
      reflectionOpenWithoutCheckpoints: activeRows.filter((row) => row.source === 'reflection' && row.status === 'open' && !checkpointCounts.get(String(row.id || ''))).length,
    },
    items,
  };
}

function summarizeDelegations(dbSource) {
  const rows = safeAll(dbSource, "SELECT id, status, target_mode, title, source_room_id, target_room_id, error, updated_at FROM delegations ORDER BY updated_at DESC LIMIT 80");
  const items = rows
    .filter((row) => ACTIVE_STATUSES.has(clean(row.status, 80)))
    .map((row) => makeItem({
      id: row.id,
      kind: 'delegation',
      title: row.title,
      status: row.status || 'queued',
      source: row.target_mode || 'delegation',
      detail: row.error || '',
      parentId: row.source_room_id || null,
      updatedAt: Number(row.updated_at || 0) ? new Date(Number(row.updated_at)).toISOString() : null,
      ref: row.target_room_id || null,
    }));
  return { total: rows.length, statusCounts: countBy(rows, (row) => row.status || 'unknown'), items };
}

function summarizeAutopilot(dbSource) {
  const rows = safeAll(dbSource, "SELECT id, status, action, target_type, target_id, room_id, session_id, task_id, attempts, max_attempts, last_error, updated_at FROM autopilot_jobs ORDER BY updated_at DESC LIMIT 80");
  const items = rows
    .filter((row) => ACTIVE_STATUSES.has(clean(row.status, 80)))
    .map((row) => makeItem({
      id: row.id,
      kind: 'autopilot',
      title: row.action || row.task_id || row.target_id,
      status: row.status || 'queued',
      source: row.target_type || 'autopilot',
      detail: row.last_error || `attempts ${Number(row.attempts || 0)}/${Number(row.max_attempts || 0)}`,
      parentId: row.room_id || row.session_id || null,
      updatedAt: Number(row.updated_at || 0) ? new Date(Number(row.updated_at)).toISOString() : null,
    }));
  return { total: rows.length, statusCounts: countBy(rows, (row) => row.status || 'unknown'), items };
}

function summarizeObservationStatus({ rootDir = DEFAULT_NOE_WORK_MAP_ROOT } = {}) {
  const ref = 'output/noe-observation-status/latest.json';
  const followupRef = 'output/noe-long-task-followup/latest.json';
  const report = readJson(join(rootDir, ref), null);
  const followup = readJson(join(rootDir, followupRef), null);
  const followupSummary = followup ? {
    available: true,
    status: clean(followup.status || '', 80),
    action: clean(followup.action || '', 140),
    nextCommand: clean(followup.nextCommand || '', 140),
    nextCheckAt: clean(followup.nextCheckAt || followup.observation?.nextCheckAt || '', 120),
    nextCheckAtLocal: clean(followup.nextCheckAtLocal || followup.observation?.nextCheckAtLocal || '', 120),
    nextCheckDue: followup.nextCheckDue === true || followup.observation?.nextCheckDue === true,
    currentDueWindow: followup.currentDueWindow === true || followup.observation?.currentDueWindow === true,
    minutesUntilNextCheck: followup.minutesUntilNextCheck ?? followup.observation?.minutesUntilNextCheck ?? null,
    completionGate: followup.completionGate ? {
      canMarkComplete: followup.completionGate.canMarkComplete === true,
      readyForNextStageReview: followup.completionGate.readyForNextStageReview === true,
      remaining: {
        naturalExpectation: Number(followup.completionGate.remaining?.naturalExpectation || 0),
        soakDays: Number(followup.completionGate.remaining?.soakDays || 0),
        hermesHours: Number(followup.completionGate.remaining?.hermesHours || 0),
      },
    } : null,
    resumeProtocol: followup.resumeProtocol ? {
      safeToResumeFromNextWindow: followup.resumeProtocol.safeToResumeFromNextWindow === true,
      canRunNow: followup.resumeProtocol.canRunNow === true,
      waitingForNaturalJudgement: followup.resumeProtocol.waitingForNaturalJudgement === true,
      requiresManualInspection: followup.resumeProtocol.requiresManualInspection === true,
      waitUntilLocal: clean(followup.resumeProtocol.waitUntilLocal || '', 120),
      nextCommand: clean(followup.resumeProtocol.nextCommand || followup.nextCommand || '', 140),
      completionAllowed: followup.resumeProtocol.completionAllowed === true,
    } : null,
    scheduler: followup.scheduler ? {
      available: followup.scheduler.available === true,
      state: clean(followup.scheduler.state || '', 80),
      runs: Number(followup.scheduler.runs || 0),
      lastExitCode: followup.scheduler.lastExitCode ?? null,
      runIntervalSeconds: followup.scheduler.runIntervalSeconds ?? null,
      logs: followup.scheduler.logs ? {
        stdout: followup.scheduler.logs.stdout ? {
          exists: followup.scheduler.logs.stdout.exists === true,
          bytes: Number(followup.scheduler.logs.stdout.bytes || 0),
          mtimeAt: clean(followup.scheduler.logs.stdout.mtimeAt || '', 80),
        } : null,
        stderr: followup.scheduler.logs.stderr ? {
          exists: followup.scheduler.logs.stderr.exists === true,
          bytes: Number(followup.scheduler.logs.stderr.bytes || 0),
          mtimeAt: clean(followup.scheduler.logs.stderr.mtimeAt || '', 80),
        } : null,
      } : null,
    } : null,
    schedulerExpectation: followup.schedulerExpectation ? {
      basis: clean(followup.schedulerExpectation.basis || '', 80),
      lastEvidenceAtLocal: clean(followup.schedulerExpectation.lastEvidenceAtLocal || '', 120),
      expectedNextRunAtLocal: clean(followup.schedulerExpectation.expectedNextRunAtLocal || '', 120),
      staleIfNoRunAfterLocal: clean(followup.schedulerExpectation.staleIfNoRunAfterLocal || '', 120),
    } : null,
    ref: followupRef,
    handoffRef: clean(followup.refs?.followupMarkdown || 'output/noe-long-task-followup/latest.md', 260),
    runLogRef: clean(followup.refs?.runLog || 'output/noe-long-task-followup/runs.jsonl', 260),
  } : {
    available: false,
    status: 'missing',
    action: 'run npm run verify:noe:long-task-followup',
    nextCommand: 'npm run verify:noe:long-task-followup',
    nextCheckAt: '',
    nextCheckAtLocal: '',
    nextCheckDue: false,
    minutesUntilNextCheck: null,
    completionGate: null,
    resumeProtocol: null,
    schedulerExpectation: null,
    ref: followupRef,
    handoffRef: 'output/noe-long-task-followup/latest.md',
    runLogRef: 'output/noe-long-task-followup/runs.jsonl',
  };
  if (!report) {
    return {
      available: false,
      status: 'unavailable',
      blockers: ['observation_status_missing'],
      nextAction: 'run npm run verify:noe:observation-status',
      followup: followupSummary,
      items: [makeItem({
        id: 'noe-observation-status',
        kind: 'observation',
        title: '长期观察状态未生成',
        status: 'blocked',
        source: 'observation_status',
        detail: 'run npm run verify:noe:observation-status',
        ref,
      })],
    };
  }
  const decision = report.decision || {};
  const blockers = Array.isArray(decision.blockers) ? decision.blockers.map((item) => clean(item, 120)).filter(Boolean) : [];
  const ready = decision.readyForNextStageReview === true;
  const expectation = report.expectationCalibration || {};
  const soak = report.soakSnapshot?.soak || {};
  const hermes = report.hermesBackgroundAudit || {};
  const p8Daily = report.p8DailyObservation || null;
  const p8DailySummary = p8Daily && typeof p8Daily === 'object' ? {
    available: p8Daily.available === true,
    status: clean(p8Daily.status || '', 120),
    baselineId: clean(p8Daily.baselineId || '', 180),
    observationDayIndex: p8Daily.observationDayIndex == null ? null : Number(p8Daily.observationDayIndex),
    minObservationDays: p8Daily.minObservationDays == null ? null : Number(p8Daily.minObservationDays),
    maxObservationDays: p8Daily.maxObservationDays == null ? null : Number(p8Daily.maxObservationDays),
    observationDays: p8Daily.observationDays == null ? null : Number(p8Daily.observationDays),
    daysRemaining: p8Daily.daysRemaining == null ? null : Number(p8Daily.daysRemaining),
    progressPct: p8Daily.progressPct == null ? null : Number(p8Daily.progressPct),
    earliestNextStageAt: clean(p8Daily.earliestNextStageAt || '', 120),
    doNotStartNextStage: p8Daily.doNotStartNextStage === true,
    allowedWork: Array.isArray(p8Daily.allowedWork) ? p8Daily.allowedWork.map((item) => clean(item, 140)).filter(Boolean).slice(0, 8) : [],
    forbiddenWork: Array.isArray(p8Daily.forbiddenWork) ? p8Daily.forbiddenWork.map((item) => clean(item, 80)).filter(Boolean).slice(0, 8) : [],
    evidenceRefs: Array.isArray(p8Daily.evidenceRefs) ? p8Daily.evidenceRefs.map((item) => clean(item, 260)).filter(Boolean).slice(0, 6) : [],
  } : null;
  const title = ready ? '长期观察门已满足' : '长期观察门仍在等待';
  const p8Detail = p8DailySummary?.available
    ? `p8 day ${p8DailySummary.observationDayIndex || 0}/${p8DailySummary.minObservationDays || 7} · remaining ${p8DailySummary.daysRemaining ?? 0}d`
    : '';
  const detail = [
    `expectation ${Number(expectation.naturalLiveResolved || 0)}/${Number(expectation.required || 20)}`,
    `soak ${Number(soak.activeDays || 0)}/${Number(soak.requiredDays || 7)}d`,
    `hermes ${Number(hermes.observedHours || 0).toFixed(2)}/${Number(hermes.windowHours || 24)}h`,
    p8Detail,
    decision.nextAction ? `next ${clean(decision.nextAction, 90)}` : '',
    followupSummary.available ? `follow-up ${followupSummary.status}` : '',
  ].filter(Boolean).join(' · ');
  return {
    available: true,
    status: clean(decision.status || (ready ? 'ready_for_next_stage_review' : 'blocked'), 120),
    readyForNextStageReview: ready,
    nextCheckAt: decision.nextCheckAt || '',
    nextAction: clean(decision.nextAction || '', 160),
    blockerCount: blockers.length,
    blockers: blockers.slice(0, 12),
    expectation: {
      naturalLiveResolved: Number(expectation.naturalLiveResolved || 0),
      required: Number(expectation.required || 20),
    },
    soak: {
      activeDays: Number(soak.activeDays || 0),
      requiredDays: Number(soak.requiredDays || 7),
    },
    hermes: {
      observedHours: Number(hermes.observedHours || 0),
      windowHours: Number(hermes.windowHours || 24),
      categories: Object.keys(hermes.categories || {}).slice(0, 20),
    },
    p8DailyObservation: p8DailySummary,
    followup: followupSummary,
    items: [makeItem({
      id: 'noe-observation-status',
      kind: 'observation',
      title,
      status: ready ? 'completed' : 'blocked',
      source: 'observation_status',
      detail,
      updatedAt: report.generatedAt || null,
      evidenceCount: blockers.length,
      ref,
    })],
  };
}

function sortItems(items = []) {
  const toneWeight = { active: 0, blocked: 1, idle: 2, done: 3 };
  return [...items].sort((a, b) => (
    (toneWeight[a.tone] ?? 9) - (toneWeight[b.tone] ?? 9)
    || Number(b.priority || 0) - Number(a.priority || 0)
    || timeMs(b.updatedAt) - timeMs(a.updatedAt)
  ));
}

export function buildNoeWorkMapSnapshot({
  rootDir = DEFAULT_NOE_WORK_MAP_ROOT,
  dataDir = DEFAULT_NOE_WORK_MAP_DATA_DIR,
  sessions = null,
  roomStore = null,
  db = null,
  dbReader = null,
  dbError = '',
  itemLimit = 80,
  now = Date.now,
} = {}) {
  const nowMs = Number(now());
  const dbSource = db || dbReader || null;
  const sessionSummary = summarizeSessions({ sessions, dataDir });
  const roomSummary = summarizeRooms({ roomStore, dataDir });
  const reportbacks = summarizeReportbacks({ dataDir, nowMs });
  const missions = scanMissions({ rootDir, limit: Math.max(20, Number(itemLimit) || 80) });
  const goals = summarizeGoals(dbSource);
  const delegations = summarizeDelegations(dbSource);
  const autopilot = summarizeAutopilot(dbSource);
  const observationStatus = summarizeObservationStatus({ rootDir });
  const items = sortItems([
    ...sessionSummary.items,
    ...roomSummary.items,
    ...goals.items,
    ...missions.items,
    ...reportbacks.items,
    ...delegations.items,
    ...autopilot.items,
    ...observationStatus.items,
  ]).slice(0, Math.max(1, Math.min(200, Number(itemLimit) || 80)));
  return {
    schemaVersion: 1,
    ok: true,
    generatedAt: new Date(nowMs).toISOString(),
    policy: {
      readOnly: true,
      noSecretsRead: true,
      noMessageBodiesIncluded: true,
      skippedFiles: ['.env', 'owner-token.txt', 'room-adapters.json'],
    },
    sources: {
      rootDir: clean(rootDir, 1000),
      dataDir: clean(dataDir, 1000),
      sqlite: { available: Boolean(dbSource), error: dbSource ? '' : clean(dbError, 300) },
    },
    counts: {
      sessions: sessionSummary,
      rooms: roomSummary,
      goals,
      missions,
      reportbacks,
      delegations,
      autopilot,
      observationStatus,
      activeWorkItems: items.filter((item) => item.tone === 'active').length,
      blockedWorkItems: items.filter((item) => item.tone === 'blocked').length,
    },
    workItems: items,
  };
}

export function writeNoeWorkMapSnapshot(snapshot, {
  rootDir = DEFAULT_NOE_WORK_MAP_ROOT,
  outDir = DEFAULT_NOE_WORK_MAP_OUT_DIR,
} = {}) {
  const absOut = resolve(rootDir, outDir);
  const stamp = String(snapshot.generatedAt || new Date().toISOString()).replace(/[:.]/g, '-');
  const dir = join(absOut, stamp);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const payload = `${JSON.stringify(snapshot, null, 2)}\n`;
  const report = join(dir, 'snapshot.json');
  const latest = join(absOut, 'latest.json');
  writeFileSync(report, payload, { mode: 0o600 });
  writeFileSync(latest, payload, { mode: 0o600 });
  return { reportPath: rel(rootDir, report), latestPath: rel(rootDir, latest) };
}
