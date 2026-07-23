import { createHash } from 'node:crypto';

const SENSITIVE_KEY_PATTERN = /(secret|token|api[_-]?key|private[_-]?holdout|password)/i;
const SENSITIVE_KEY_ALLOWED_PATTERN = /(redacted|hash|ref|sourceType|configured|allowed|policy|scope|status)/i;

function cleanString(value) {
  return String(value || '').trim();
}

function isPlainObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value);
}

function sha256(value) {
  return createHash('sha256').update(String(value || ''), 'utf8').digest('hex');
}

function listenerCount(snapshot) {
  return Array.isArray(snapshot?.listeners) ? snapshot.listeners.length : 0;
}

function loadedCount(snapshot) {
  return Array.isArray(snapshot?.loadedModels) ? snapshot.loadedModels.length : null;
}

function bool(value) {
  return value === true;
}

export function buildStageEFinalRestartReport({
  observedAt = new Date().toISOString(),
  drill = {},
  drillReportRef = '',
  preflight = {},
  preflightRef = '',
  evidencePackRef = 'output/noe-final-real-machine-stages/20260619/stage-E-evidence-pack.md',
} = {}) {
  const checks = drill.checks || {};
  const requiredChecks = {
    pidChanged: bool(checks.pidChanged),
    oldPidAbsent: bool(checks.oldPidAbsent),
    newPidCwdIsRoot: bool(checks.newPidCwdIsRoot),
    port51735Untouched: bool(checks.port51735Untouched),
    lmStudioLoadedModelsUnchanged: bool(checks.lmStudioLoadedModelsUnchanged),
    healthOk: bool(checks.healthOk),
    readinessPassed: bool(checks.readinessPassed),
    freedomLiveOk: bool(checks.freedomLiveOk),
  };
  const preflightDecision = preflight?.preflight?.decision || preflight?.decision || {};
  const preflightReport = preflight?.preflight?.report || preflight?.report || {};
  const preflightPolicy = preflightDecision.policy || preflightReport.policy || {};
  const preflightOk = preflight.ok === true
    && preflightDecision.safeToRestart === true
    && Array.isArray(preflightDecision.blockers)
    && preflightDecision.blockers.length === 0;
  const allChecksOk = Object.values(requiredChecks).every(Boolean);

  return {
    schemaVersion: 1,
    stage: 'E',
    ok: drill.ok === true && drill.applied === true && drill.realRestartAttempted === true && preflightOk && allChecksOk,
    redacted: true,
    observedAt,
    mode: 'final_51835_restart_recovery',
    finalRestartRecovery: true,
    drillReportRef: cleanString(drillReportRef),
    preflightRef: cleanString(preflightRef),
    qualityMode: {
      profile: 'exhaustive',
      sharedEvidenceCapsuleRef: evidencePackRef,
      modelReviewRequiredBeforeFinalCloseout: true,
      subagentReviewRequiredBeforeFinalCloseout: true,
      finalStageMatrixRequired: true,
    },
    preflight: {
      ok: preflightOk,
      safeToRestart: preflightDecision.safeToRestart === true,
      safeToStart: preflightDecision.safeToStart === true,
      blockerCount: Array.isArray(preflightDecision.blockers) ? preflightDecision.blockers.length : null,
      warningCount: Array.isArray(preflightDecision.warnings) ? preflightDecision.warnings.length : null,
      ownedPanel: preflightReport.panel?.owned === true,
      panelListenerCount: listenerCount(preflightReport.panel),
      observeOnly51735ListenerCount: Number.isFinite(Number(preflightDecision.observeOnlyListenerCount))
        ? Number(preflightDecision.observeOnlyListenerCount)
        : listenerCount(preflightReport.observeOnly),
      credentialValuesReturned: preflightPolicy.secretValuesReturned === true,
      readsCredentialValue: preflightPolicy.readsOwnerToken === true,
      touchesObserveOnlyPort: preflightPolicy.touchesObserveOnlyPort === true,
      actionsPerformed: preflightPolicy.actionsPerformed === true,
    },
    restart: {
      applied: drill.applied === true,
      realRestartAttempted: drill.realRestartAttempted === true,
      methodRef: 'real_51835_sigterm_direct_node22_restart',
      beforeListenerCount: listenerCount(drill.before?.port51835),
      afterListenerCount: listenerCount(drill.after?.port51835),
      pidChanged: requiredChecks.pidChanged,
      oldPidAbsent: requiredChecks.oldPidAbsent,
      newPidCwdIsRoot: requiredChecks.newPidCwdIsRoot,
      startedPidHash: sha256(drill.restart?.startedPid || ''),
      nodeBinHash: sha256(drill.restart?.nodeBin || ''),
    },
    ports: {
      host: cleanString(drill.host) || '127.0.0.1',
      port51835: Number.isFinite(Number(drill.port)) ? Number(drill.port) : 51835,
      port51735Untouched: requiredChecks.port51735Untouched,
      port51735BeforeCount: listenerCount(drill.before?.port51735),
      port51735AfterCount: listenerCount(drill.after?.port51735),
    },
    health: {
      ok: requiredChecks.healthOk,
      httpStatus: Number.isFinite(Number(drill.health?.status)) ? Number(drill.health.status) : null,
      status: cleanString(drill.health?.json?.health?.status || drill.health?.json?.ok),
    },
    readiness: {
      passed: requiredChecks.readinessPassed,
      httpStatus: Number.isFinite(Number(drill.readiness?.status)) ? Number(drill.readiness.status) : null,
      status: cleanString(drill.readiness?.json?.readiness?.status || drill.readiness?.json?.health?.status),
    },
    lmStudio: {
      loadedModelsUnchanged: requiredChecks.lmStudioLoadedModelsUnchanged,
      beforeLoadedCount: loadedCount(drill.before?.lmStudio),
      afterLoadedCount: loadedCount(drill.after?.lmStudio),
    },
    freedomLive: {
      ok: requiredChecks.freedomLiveOk,
      status: Number.isFinite(Number(drill.freedomLive?.status)) ? Number(drill.freedomLive.status) : null,
      stdoutSha256: cleanString(drill.freedomLive?.stdoutSha256),
    },
    policy: {
      redactedLiveEvidenceOnly: true,
      finalRestartOnly: true,
      no51735Touch: true,
      rawSecretReadAllowed: false,
      rawPrivateHoldoutReadAllowed: false,
      credentialValuePrinted: false,
      credentialValueStored: false,
      memoryV2Writes: false,
      scratchWriteOnly: false,
    },
    reviewerCapsule: {
      purpose: 'Stage E final 51835 restart recovery proof',
      currentLiveProof: 'fresh_in_this_run',
      claimClasses: [
        'owned_51835_preflight_safe',
        'real_restart_attempted',
        'listener_pid_changed',
        'old_listener_absent',
        'new_listener_cwd_is_repo',
        '51735_observe_only_untouched',
        'health_after_restart_ok',
        'readiness_after_restart_passed',
        'freedom_live_smoke_passed',
      ],
      staleWhen: [
        'live_51835_restarts_again',
        'panel process changes',
        'stage-E evidence changes without a new quorum',
      ],
      nextReviewFocus: [
        'Stage Matrix --require-complete must pass after E',
        'No raw credential or raw private_holdout content in final outputs',
        'Do not claim unrelated app features passed unless separately tested',
      ],
    },
  };
}

export function scanStageERedaction(value, {
  disallowedStrings = [],
  path = '',
} = {}) {
  const findings = [];
  if (Array.isArray(value)) {
    value.forEach((item, index) => findings.push(...scanStageERedaction(item, { disallowedStrings, path: `${path}[${index}]` })));
    return findings;
  }
  if (isPlainObject(value)) {
    for (const [key, child] of Object.entries(value)) {
      const nextPath = path ? `${path}.${key}` : key;
      if (SENSITIVE_KEY_PATTERN.test(key) && !SENSITIVE_KEY_ALLOWED_PATTERN.test(key)) {
        findings.push(`sensitive_key:${nextPath}`);
      }
      findings.push(...scanStageERedaction(child, { disallowedStrings, path: nextPath }));
    }
    return findings;
  }
  if (typeof value === 'string') {
    for (const raw of disallowedStrings.map(cleanString).filter(Boolean)) {
      if (value.includes(raw)) findings.push(`raw_value_present:${path || '<root>'}`);
    }
  }
  return findings;
}

export function buildStageEEvidencePack({
  report = {},
  evidenceRef = 'output/noe-final-real-machine-stages/20260619/stage-E-final-51835-restart-recovery.json',
  stageMatrixRef = 'output/noe-multimodel/20260619-final-real-machine-authorization/authorization.json',
  redactionFindings = [],
  commandRefs = [],
} = {}) {
  const lines = [
    '# Stage E Final 51835 Restart Recovery Evidence Pack',
    '',
    `Observed at: ${cleanString(report.observedAt) || 'unknown'}`,
    '',
    '## Verdict',
    '',
    `- ok: ${report.ok === true}`,
    `- mode: ${cleanString(report.mode)}`,
    `- finalRestartRecovery: ${report.finalRestartRecovery === true}`,
    `- evidenceRef: ${evidenceRef}`,
    `- drillReportRef: ${cleanString(report.drillReportRef) || 'n/a'}`,
    `- stageMatrixRef: ${stageMatrixRef}`,
    '',
    '## Shared Reviewer Capsule',
    '',
    '- qualityProfile: exhaustive',
    '- final stage: true',
    '- required final closeout: Stage Matrix --require-complete must pass after this evidence is written',
    '- forbidden: raw credential output, raw private_holdout content, touching 51735, memory-v2/SkillStore/GraphMemory writes',
    '',
    '## Restart Checks',
    '',
    `- preflightSafeToRestart: ${report.preflight?.safeToRestart === true}`,
    `- applied: ${report.restart?.applied === true}`,
    `- realRestartAttempted: ${report.restart?.realRestartAttempted === true}`,
    `- pidChanged: ${report.restart?.pidChanged === true}`,
    `- oldPidAbsent: ${report.restart?.oldPidAbsent === true}`,
    `- newPidCwdIsRoot: ${report.restart?.newPidCwdIsRoot === true}`,
    `- port51735Untouched: ${report.ports?.port51735Untouched === true}`,
    `- healthOk: ${report.health?.ok === true}`,
    `- readinessPassed: ${report.readiness?.passed === true}`,
    `- freedomLiveOk: ${report.freedomLive?.ok === true}`,
    '',
    '## Redaction Check',
    '',
    `- findings: ${redactionFindings.length}`,
    ...(redactionFindings.length ? redactionFindings.map((item) => `- ${item}`) : ['- no redaction findings']),
    '',
    '## Commands',
    '',
    ...(commandRefs.length ? commandRefs.map((item) => `- ${item}`) : ['- command list recorded in progress log']),
    '',
  ];
  return `${lines.join('\n')}\n`;
}
