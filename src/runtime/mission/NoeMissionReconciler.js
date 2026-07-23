// @ts-check
import { existsSync, readFileSync, statSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import { redactSensitiveText } from '../NoeContextScrubber.js';
import { evidenceRefsFrom } from './NoeMissionCriteriaEngine.js';

function clean(value, max = 1000) {
  return redactSensitiveText(String(value ?? '').trim()).slice(0, max);
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function safeResolve(root, ref) {
  const file = resolve(root, clean(ref, 1000));
  return (file === root || file.startsWith(root + sep)) ? file : null;
}

function readable(root, ref) {
  const file = safeResolve(root, ref);
  if (!file) return false;
  try { return existsSync(file) && statSync(file).isFile(); } catch { return false; }
}

function readText(root, ref) {
  const file = safeResolve(root, ref);
  if (!file || !existsSync(file)) return '';
  try { return readFileSync(file, 'utf8'); } catch { return ''; }
}

function expectedFinalReport(mission = {}, state = {}) {
  if (state.finalReportRef) return clean(state.finalReportRef, 1000);
  const artifact = asArray(mission.expectedArtifacts).find((item) => {
    const text = `${item.type || ''} ${item.kind || ''} ${item.id || ''} ${item.description || ''}`.toLowerCase();
    return text.includes('final_report') || text.includes('final report') || text.includes('最终报告');
  });
  return clean(artifact?.ref || artifact?.path, 1000);
}

function eventIsDone(event = {}) {
  return ['mission.action.completed', 'mission.command.completed'].includes(clean(event.type, 160));
}

function eventIsFailed(event = {}) {
  return ['mission.action.failed', 'mission.command.failed'].includes(clean(event.type, 160));
}

export class NoeMissionReconciler {
  constructor({ root } = {}) {
    this.root = root ? resolve(root) : process.cwd();
  }

  reconcile({ mission = {}, state = {}, events = [], root = this.root } = {}) {
    const blockers = [];
    const warnings = [];
    const evidenceRefs = evidenceRefsFrom(state, events);
    const readableRefs = evidenceRefs.filter((ref) => readable(root, ref));
    const missingRefs = evidenceRefs.filter((ref) => !readable(root, ref));

    for (const ref of missingRefs) blockers.push(`evidence_not_readable:${ref}`);

    for (const event of events.filter(eventIsDone)) {
      const refs = [...asArray(event.evidenceRefs), event.evidenceRef, event.artifactRef].filter(Boolean);
      if (refs.length === 0) blockers.push(`done_without_evidence:${clean(event.actionId || event.commandId || event.type, 160)}`);
    }

    const failed = events.filter(eventIsFailed);
    if (failed.length > 0) blockers.push(`failed_events_present:${failed.length}`);

    const requiredRefs = asArray(mission.evidenceRequirements)
      .filter((item) => item.required !== false)
      .map((item) => clean(item.ref || item.path, 1000))
      .filter(Boolean);
    for (const ref of requiredRefs) {
      if (!evidenceRefs.includes(ref)) blockers.push(`required_evidence_ref_not_linked:${ref}`);
      if (!readable(root, ref)) blockers.push(`required_evidence_ref_not_readable:${ref}`);
    }

    const reportRef = expectedFinalReport(mission, state);
    if (reportRef) {
      const reportText = readText(root, reportRef);
      if (!reportText) blockers.push(`final_report_not_readable:${reportRef}`);
      for (const ref of requiredRefs) {
        if (reportText && !reportText.includes(ref)) blockers.push(`final_report_missing_evidence_ref:${ref}`);
      }
      if (reportText && /skipped|failed|error/i.test(reportText) && !/known|reported|blocker|failure/i.test(reportText)) {
        warnings.push('final_report_mentions_failure_without_explanation');
      }
    } else {
      blockers.push('final_report_expected_artifact_missing_ref');
    }

    if (asArray(state.blockers).length > 0) blockers.push('state_blockers_present');
    if (readableRefs.length === 0) blockers.push('no_readable_evidence');

    return {
      ok: blockers.length === 0,
      blockers: [...new Set(blockers)],
      warnings: [...new Set(warnings)],
      evidenceRefs,
      readableRefs,
      coverage: {
        requiredEvidence: requiredRefs.map((ref) => ({
          ref,
          linked: evidenceRefs.includes(ref),
          readable: readable(root, ref),
          inFinalReport: reportRef ? readText(root, reportRef).includes(ref) : false,
        })),
        doneEvents: events.filter(eventIsDone).length,
        failedEvents: failed.length,
      },
    };
  }
}
