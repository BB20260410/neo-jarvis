// @ts-check
import { existsSync, readFileSync, statSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import { redactSensitiveText } from '../NoeContextScrubber.js';

function clean(value, max = 1000) {
  return redactSensitiveText(String(value ?? '').trim()).slice(0, max);
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function eventType(event) {
  return clean(event?.type, 160);
}

function isRequired(item) {
  return item?.required !== false;
}

function safeResolve(root, ref) {
  const file = resolve(root, clean(ref, 1000));
  return (file === root || file.startsWith(root + sep)) ? file : null;
}

function fileExists(root, ref) {
  const file = safeResolve(root, ref);
  if (!file) return false;
  try { return existsSync(file) && statSync(file).isFile(); } catch { return false; }
}

function evidenceRefsFrom(state = {}, events = []) {
  const refs = new Set(asArray(state.evidenceRefs).map((ref) => clean(ref, 1000)).filter(Boolean));
  for (const event of events) {
    for (const key of ['evidenceRef', 'artifactRef', 'checkpointRef', 'reportRef']) {
      if (event?.[key]) refs.add(clean(event[key], 1000));
    }
    for (const ref of asArray(event?.evidenceRefs)) refs.add(clean(ref, 1000));
  }
  return [...refs];
}

function commandEvidence(events, commandId) {
  const id = clean(commandId, 160);
  return events.find((event) => (
    ['mission.command.completed', 'mission.action.completed'].includes(eventType(event))
    && clean(event.commandId || event.actionId, 160) === id
    && Number(event.exitCode ?? 0) === 0
  ));
}

function toTimeMs(value) {
  const n = Date.parse(String(value || ''));
  return Number.isFinite(n) ? n : null;
}

function elapsedMs(state = {}, events = []) {
  const start = toTimeMs(events.find((event) => event.type === 'mission.created')?.at) ?? toTimeMs(state.createdAt);
  const times = [
    toTimeMs(state.updatedAt),
    ...events.map((event) => toTimeMs(event.at)),
  ].filter((value) => value != null);
  const end = times.length ? Math.max(...times) : null;
  return start != null && end != null ? Math.max(0, end - start) : 0;
}

function hasOpenTruncation(events) {
  return events.some((event) => {
    const p = event?.payload || event;
    if (p?.truncated === true || p?.incomplete === true || p?.finishReason === 'length') {
      return !p?.resolvedAt && p?.resolved !== true;
    }
    return false;
  });
}

function readReport(root, ref) {
  const file = safeResolve(root, ref);
  if (!file || !existsSync(file)) return null;
  try { return readFileSync(file, 'utf8'); } catch { return null; }
}

export class NoeMissionCriteriaEngine {
  constructor({ root } = {}) {
    this.root = root ? resolve(root) : process.cwd();
  }

  evaluateCriterion(criterion = {}, context = {}) {
    const root = context.root || this.root;
    const state = context.state || {};
    const events = asArray(context.events);
    const evidenceRefs = context.evidenceRefs || evidenceRefsFrom(state, events);
    const type = clean(criterion.type || 'manual', 160);
    const id = clean(criterion.id || criterion.description || type, 160);

    if (type === 'manual') {
      return { id, ok: criterion.status === 'passed', reason: criterion.status === 'passed' ? 'manual_passed' : 'manual_not_passed' };
    }
    if (type === 'file_exists') {
      const ref = clean(criterion.path || criterion.ref, 1000);
      return { id, ok: fileExists(root, ref), reason: fileExists(root, ref) ? 'file_exists' : `file_missing:${ref}` };
    }
    if (type === 'evidence_ref_exists') {
      const ref = clean(criterion.ref || criterion.path, 1000);
      const ok = evidenceRefs.includes(ref) && fileExists(root, ref);
      return { id, ok, reason: ok ? 'evidence_ref_exists' : `evidence_ref_missing:${ref}` };
    }
    if (type === 'command_exit_zero') {
      const event = commandEvidence(events, criterion.commandId || criterion.id);
      return { id, ok: Boolean(event), reason: event ? 'command_exit_zero' : `command_evidence_missing:${criterion.commandId || criterion.id}` };
    }
    if (type === 'mission_elapsed_at_least_ms') {
      const minElapsedMs = Math.max(0, Number(criterion.minElapsedMs || criterion.ms || 0));
      const actual = elapsedMs(state, events);
      return {
        id,
        ok: actual >= minElapsedMs,
        reason: actual >= minElapsedMs ? 'mission_elapsed_reached' : `mission_elapsed_below:${actual}/${minElapsedMs}`,
      };
    }
    if (type === 'event_type_count_at_least') {
      const wanted = clean(criterion.eventType || criterion.kind, 160);
      const minCount = Math.max(1, Number(criterion.minCount || criterion.count || 1));
      const count = events.filter((event) => eventType(event) === wanted).length;
      return {
        id,
        ok: count >= minCount,
        reason: count >= minCount ? 'event_type_count_reached' : `event_type_count_below:${wanted}:${count}/${minCount}`,
      };
    }
    if (type === 'no_unresolved_blockers') {
      const blockers = asArray(state.blockers).filter((item) => item && item.resolved !== true);
      return { id, ok: blockers.length === 0, reason: blockers.length === 0 ? 'no_unresolved_blockers' : 'unresolved_blockers' };
    }
    if (type === 'no_truncated_results') {
      return { id, ok: !hasOpenTruncation(events), reason: hasOpenTruncation(events) ? 'truncated_result_open' : 'no_truncated_results' };
    }
    if (type === 'final_report_traces_evidence') {
      const ref = clean(criterion.reportRef || state.finalReportRef, 1000);
      const text = readReport(root, ref) || '';
      const requiredRefs = asArray(criterion.evidenceRefs).length ? asArray(criterion.evidenceRefs) : evidenceRefs;
      const missing = requiredRefs.map((item) => clean(item, 1000)).filter((item) => item && !text.includes(item));
      return { id, ok: Boolean(ref && text && missing.length === 0), reason: missing.length ? `report_missing_refs:${missing.join(',')}` : 'report_traces_evidence' };
    }
    return { id, ok: false, reason: `unsupported_criterion_type:${type}` };
  }

  evaluateEvidenceRequirement(requirement = {}, context = {}) {
    const root = context.root || this.root;
    const evidenceRefs = context.evidenceRefs || evidenceRefsFrom(context.state, context.events);
    const id = clean(requirement.id || requirement.ref || requirement.path, 160);
    const ref = clean(requirement.ref || requirement.path, 1000);
    if (!ref) return { id, ok: false, reason: 'evidence_ref_required' };
    const ok = evidenceRefs.includes(ref) && fileExists(root, ref);
    return { id, ok, reason: ok ? 'required_evidence_readable' : `required_evidence_missing:${ref}` };
  }

  evaluate({ mission = {}, state = {}, events = [], root = this.root } = {}) {
    const evidenceRefs = evidenceRefsFrom(state, events);
    const criterionResults = asArray(mission.completionCriteria)
      .filter(isRequired)
      .map((criterion) => this.evaluateCriterion(criterion, { mission, state, events, evidenceRefs, root }));
    const evidenceResults = asArray(mission.evidenceRequirements)
      .filter(isRequired)
      .map((requirement) => this.evaluateEvidenceRequirement(requirement, { mission, state, events, evidenceRefs, root }));
    const blockers = [
      ...criterionResults.filter((item) => !item.ok).map((item) => item.reason),
      ...evidenceResults.filter((item) => !item.ok).map((item) => item.reason),
    ];
    if (asArray(state.blockers).some((item) => item && item.resolved !== true)) blockers.push('unresolved_blocker_present');
    if (hasOpenTruncation(events)) blockers.push('truncated_or_incomplete_result_open');
    if (criterionResults.length === 0) blockers.push('required_completion_criteria_missing');
    if (evidenceResults.length === 0) blockers.push('required_evidence_missing');

    return {
      ok: blockers.length === 0,
      status: blockers.length === 0 ? 'succeeded' : (state.status || 'running'),
      blockers: [...new Set(blockers)],
      criterionResults,
      evidenceResults,
      evidenceRefs,
    };
  }
}

export { evidenceRefsFrom };
