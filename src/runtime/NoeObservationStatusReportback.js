// @ts-check
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { redactSensitiveText } from './NoeContextScrubber.js';

const DEFAULT_REPORT_REF = 'output/noe-observation-status/latest.json';
const DEFAULT_STATE_KEY = 'noe.observationStatus.reportback';
const SECRET_TEXT_RE = /((?:api[_-]?key|authorization|bearer|cookie|credential|owner[_-]?token|password|private[_-]?key|refresh[_-]?token|secret|session[_-]?token|token)\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;}]+)/gi;

function clean(value, max = 500) {
  return redactSensitiveText(String(value ?? ''))
    .replace(SECRET_TEXT_RE, '$1[redacted]')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

function readJson(file) {
  try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return null; }
}

function normalizeBlockers(value) {
  return Array.isArray(value)
    ? value.map((item) => clean(item, 140)).filter(Boolean).slice(0, 12)
    : [];
}

function buildSignature({ status, nextAction, nextCheckAt, blockers, ready, p8DayIndex = null }) {
  return [
    ready ? 'ready' : 'pending',
    clean(status, 120),
    clean(nextAction, 180),
    clean(nextCheckAt, 120),
    p8DayIndex == null ? '' : `p8day:${p8DayIndex}`,
    ...blockers.slice(0, 8),
  ].join('|');
}

export function buildNoeObservationStatusReportback(report, {
  ref = DEFAULT_REPORT_REF,
} = {}) {
  const decision = report?.decision || {};
  const blockers = normalizeBlockers(decision.blockers);
  const ready = decision.readyForNextStageReview === true;
  const status = clean(decision.status || (ready ? 'ready_for_next_stage_review' : 'blocked'), 120);
  const nextAction = clean(decision.nextAction || '', 180);
  const nextCheckAt = clean(decision.nextCheckAt || '', 120);
  const p8Daily = report?.p8DailyObservation || {};
  const p8DayIndex = p8Daily.available === true && p8Daily.observationDayIndex != null
    ? Number(p8Daily.observationDayIndex)
    : null;
  const p8MinDays = p8Daily.minObservationDays == null ? null : Number(p8Daily.minObservationDays);
  const p8DaysRemaining = p8Daily.daysRemaining == null ? null : Number(p8Daily.daysRemaining);
  const p8Summary = p8Daily.available === true
    ? `P8观察：第${Number.isFinite(p8DayIndex) ? p8DayIndex : '?'}天/${Number.isFinite(p8MinDays) ? p8MinDays : '?'}天，剩余${Number.isFinite(p8DaysRemaining) ? p8DaysRemaining.toFixed(2) : '?'}天${p8Daily.doNotStartNextStage === true ? '，禁止启动P9/R。' : '。'}`
    : '';
  const summaryParts = [
    ready ? '长期观察门已满足，可以进入下一阶段审查。' : `长期观察门仍在等待：${status}。`,
    p8Summary,
    nextAction ? `下一步：${nextAction}。` : '',
    nextCheckAt ? `下次检查：${nextCheckAt}。` : '',
    blockers.length ? `当前阻塞：${blockers.slice(0, 3).join('、')}。` : '',
  ].filter(Boolean);
  const signature = buildSignature({ status, nextAction, nextCheckAt, blockers, ready, p8DayIndex });

  return {
    signature,
    state: {
      signature,
      status,
      readyForNextStageReview: ready,
      blockerCount: blockers.length,
      nextAction,
      nextCheckAt,
      p8DailyObservation: p8Daily.available === true ? {
        observationDayIndex: p8DayIndex,
        minObservationDays: p8MinDays,
        daysRemaining: p8DaysRemaining,
        doNotStartNextStage: p8Daily.doNotStartNextStage === true,
      } : null,
    },
    item: {
      taskId: 'noe-observation-status',
      title: ready ? '观察门：已满足' : '观察门：仍在等待',
      status: ready ? 'done' : 'blocked',
      kind: 'observation_status',
      source: 'observation_status',
      summary: summaryParts.join(' '),
      evidenceRefs: [ref],
      speak: true,
      dedupeKey: `noe-observation-status:${signature}`,
    },
  };
}

export function syncNoeObservationStatusReportback({
  rootDir = process.cwd(),
  report = null,
  reportRef = DEFAULT_REPORT_REF,
  reportPath = '',
  taskReportbacks = null,
  state = null,
  now = Date.now,
} = {}) {
  const loadedReport = report || readJson(reportPath ? resolve(reportPath) : join(rootDir, reportRef));
  if (!loadedReport) return { ok: false, changed: false, reason: 'observation_status_missing' };
  if (!taskReportbacks || typeof taskReportbacks.add !== 'function') {
    return { ok: false, changed: false, reason: 'task_reportbacks_unavailable' };
  }

  const built = buildNoeObservationStatusReportback(loadedReport, { ref: reportRef });
  let previous = null;
  try { previous = state?.get?.(DEFAULT_STATE_KEY); } catch {}
  const previousSignature = typeof previous === 'string' ? previous : previous?.signature;
  if (previousSignature === built.signature) {
    return { ok: true, changed: false, signature: built.signature, state: built.state };
  }

  const item = taskReportbacks.add(built.item);
  const nextState = { ...built.state, updatedAt: now(), itemId: item?.id || null };
  try { state?.set?.(DEFAULT_STATE_KEY, nextState); } catch {}
  return { ok: true, changed: true, signature: built.signature, item, state: nextState };
}
