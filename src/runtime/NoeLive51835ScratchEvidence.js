import { createHash } from 'node:crypto';

const SENSITIVE_KEY_PATTERN = /(secret|token|api[_-]?key|private[_-]?holdout|password)/i;
const SENSITIVE_KEY_ALLOWED_PATTERN = /(redacted|hash|ref|sourceType|configured|allowed|policy|scope|status)/i;

function cleanString(value) {
  return String(value || '').trim();
}

function isPlainObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value);
}

export function sha256RedactedValue(value) {
  return createHash('sha256').update(String(value || ''), 'utf8').digest('hex');
}

export function buildStageDScratchMemoryInput({
  scratchId,
  marker,
  sourceRef,
  now = new Date(),
  projectId = 'stage-d-scratch',
} = {}) {
  const id = cleanString(scratchId);
  const text = cleanString(marker);
  if (!id) throw new Error('scratchId required');
  if (!text) throw new Error('marker required');
  return {
    id,
    projectId,
    scope: 'scratch',
    title: 'Stage D live 51835 scratch',
    body: `Stage D live scratch marker ${text}`,
    sourceType: 'stage_d_scratch',
    sourceId: cleanString(sourceRef) || 'output/noe-final-real-machine-stages/20260619/stage-D-live-51835-scratch-write.json',
    tags: ['stage-d', 'scratch', 'live-51835'],
    confidence: 0.1,
    ttlMs: 600000,
    salience: 1,
    validFrom: now.getTime(),
  };
}

function summarizeStep(step = {}) {
  return {
    name: cleanString(step.name),
    ok: step.ok === true,
    status: step.ok === true ? 'passed' : 'failed',
    httpStatus: Number.isFinite(Number(step.httpStatus)) ? Number(step.httpStatus) : null,
    expected: cleanString(step.expected),
  };
}

export function buildStageDRollbackReport({
  observedAt = new Date().toISOString(),
  scratchId = '',
  marker = '',
  httpStatus = null,
  cleanupOk = false,
  visibleAfterCleanup = null,
} = {}) {
  return {
    schemaVersion: 1,
    stage: 'D',
    ok: cleanupOk === true && visibleAfterCleanup === false,
    redacted: true,
    observedAt,
    mode: 'live_51835_scratch_cleanup_rollback',
    rollbackForHash: sha256RedactedValue(scratchId),
    markerHash: sha256RedactedValue(marker),
    actionRef: 'DELETE /api/noe/memory/:id',
    httpStatus: Number.isFinite(Number(httpStatus)) ? Number(httpStatus) : null,
    cleanupConfirmed: cleanupOk === true,
    visibleAfterCleanup: visibleAfterCleanup === true,
    rawBodyStored: false,
    responseBodyStored: false,
    authCredentialValueStored: false,
  };
}

export function buildStageDLiveScratchReport({
  observedAt = new Date().toISOString(),
  baseUrlRef = 'http://127.0.0.1:51835',
  rollbackRef = 'output/noe-final-real-machine-stages/20260619/stage-D-rollback.json',
  auth = {},
  scratch = {},
  steps = [],
  counts = {},
  cleanup = {},
  reviewerCapsuleRef = 'output/noe-final-real-machine-stages/20260619/stage-D-evidence-pack.md',
} = {}) {
  const scratchId = cleanString(scratch.id);
  const marker = cleanString(scratch.marker);
  const summarizedSteps = steps.map(summarizeStep);
  const allStepsOk = summarizedSteps.length > 0 && summarizedSteps.every((step) => step.ok);
  const visibleAfterCleanup = cleanup.visibleAfterCleanup === true;
  const cleanupOk = cleanup.ok === true && visibleAfterCleanup === false;

  return {
    schemaVersion: 1,
    stage: 'D',
    ok: allStepsOk && cleanupOk,
    redacted: true,
    observedAt,
    mode: 'live_51835_scratch_write_cleanup',
    baseUrlRef,
    rollbackRef,
    qualityMode: {
      profile: 'exhaustive',
      sharedEvidenceCapsuleRef: reviewerCapsuleRef,
      modelReviewRequiredBeforeNextStage: true,
      subagentReviewRequiredBeforeNextStage: true,
      finalStageMatrixRequired: true,
    },
    auth: {
      mode: cleanString(auth.mode) || 'unknown',
      scope: cleanString(auth.scope) || 'live-protected-api:call',
      authorized: auth.authorized === true,
      grantRefStatus: cleanString(auth.grantRefStatus) || 'not_recorded',
      credentialValuePrinted: false,
      credentialValueStored: false,
      credentialHeaderStored: false,
    },
    scratch: {
      idHash: sha256RedactedValue(scratchId),
      markerHash: sha256RedactedValue(marker),
      projectId: cleanString(scratch.projectId) || 'stage-d-scratch',
      scope: 'scratch',
      sourceType: 'stage_d_scratch',
      ttlMs: Number.isFinite(Number(scratch.ttlMs)) ? Number(scratch.ttlMs) : 600000,
      salience: Number.isFinite(Number(scratch.salience)) ? Number(scratch.salience) : 1,
      rawBodyStored: false,
      rawResponseStored: false,
    },
    steps: summarizedSteps,
    counts: {
      beforeVisible: Number.isFinite(Number(counts.beforeVisible)) ? Number(counts.beforeVisible) : null,
      afterWriteVisible: Number.isFinite(Number(counts.afterWriteVisible)) ? Number(counts.afterWriteVisible) : null,
      afterCleanupVisible: Number.isFinite(Number(counts.afterCleanupVisible)) ? Number(counts.afterCleanupVisible) : null,
    },
    cleanup: {
      attempted: cleanup.attempted === true,
      ok: cleanupOk,
      httpStatus: Number.isFinite(Number(cleanup.httpStatus)) ? Number(cleanup.httpStatus) : null,
      visibleAfterCleanup,
      rollbackActionRef: 'DELETE /api/noe/memory/:id',
    },
    reviewerCapsule: {
      purpose: 'Stage D live proof with scratch write and cleanup rollback evidence',
      currentLiveProof: 'fresh_in_this_run',
      allowedSideEffect: 'scratch_memory_write_then_cleanup',
      claimClasses: [
        'live_51835_reachable',
        'protected_memory_api_accepts_owner_authorized_call',
        'scratch_write_visible_after_post',
        'scratch_write_hidden_after_cleanup',
        'redacted_evidence_only',
      ],
      staleWhen: [
        'live_51835_restarts',
        'memory API changes',
        'stage-D evidence changes without a new quorum',
        '15 minutes pass for live claims',
      ],
      nextReviewFocus: [
        'rollbackRef exists and cleanup is confirmed',
        'no raw credential, memory body, or response body in reports',
        'Stage Matrix completed includes D but not E before final restart',
      ],
    },
    policy: {
      redactedLiveEvidenceOnly: true,
      rawSecretReadAllowed: false,
      rawPrivateHoldoutReadAllowed: false,
      credentialValuePrinted: false,
      credentialValueStored: false,
      live51835Touched: true,
      memoryV2Writes: false,
      scratchWriteOnly: true,
      cleanupRequired: true,
    },
  };
}

export function scanStageDRedaction(value, {
  disallowedStrings = [],
  path = '',
} = {}) {
  const findings = [];
  if (Array.isArray(value)) {
    value.forEach((item, index) => {
      findings.push(...scanStageDRedaction(item, { disallowedStrings, path: `${path}[${index}]` }));
    });
    return findings;
  }
  if (isPlainObject(value)) {
    for (const [key, child] of Object.entries(value)) {
      const nextPath = path ? `${path}.${key}` : key;
      if (SENSITIVE_KEY_PATTERN.test(key) && !SENSITIVE_KEY_ALLOWED_PATTERN.test(key)) {
        findings.push(`sensitive_key:${nextPath}`);
      }
      findings.push(...scanStageDRedaction(child, { disallowedStrings, path: nextPath }));
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

export function buildStageDEvidencePack({
  report = {},
  rollbackReport = {},
  evidenceRef = 'output/noe-final-real-machine-stages/20260619/stage-D-live-51835-scratch-write.json',
  rollbackRef = 'output/noe-final-real-machine-stages/20260619/stage-D-rollback.json',
  stageMatrixRef = 'output/noe-multimodel/20260619-final-real-machine-authorization/authorization.json',
  commandRefs = [],
  redactionFindings = [],
} = {}) {
  const lines = [
    '# Stage D Live 51835 Scratch Evidence Pack',
    '',
    `Observed at: ${cleanString(report.observedAt) || 'unknown'}`,
    '',
    '## Verdict',
    '',
    `- ok: ${report.ok === true}`,
    `- mode: ${cleanString(report.mode)}`,
    `- evidenceRef: ${evidenceRef}`,
    `- rollbackRef: ${rollbackRef}`,
    `- stageMatrixRef: ${stageMatrixRef}`,
    '',
    '## Shared Reviewer Capsule',
    '',
    '- qualityProfile: exhaustive',
    '- live claim freshness: fresh in this run; stale after live 51835 restart or 15 minutes for live claims',
    '- allowed side effect: scratch memory write followed by cleanup',
    '- forbidden: raw credential output, raw private_holdout content, non-scratch live write, restart before Stage E',
    '- required before next stage: subagent review, multi-model gate, Stage Matrix shows D completed and E still pending',
    '',
    '## Live Steps',
    '',
    ...(Array.isArray(report.steps) && report.steps.length
      ? report.steps.map((step) => `- ${step.name}: ok=${step.ok} httpStatus=${step.httpStatus ?? 'n/a'} expected=${step.expected || 'n/a'}`)
      : ['- no steps recorded']),
    '',
    '## Counts',
    '',
    `- beforeVisible: ${report.counts?.beforeVisible ?? 'n/a'}`,
    `- afterWriteVisible: ${report.counts?.afterWriteVisible ?? 'n/a'}`,
    `- afterCleanupVisible: ${report.counts?.afterCleanupVisible ?? 'n/a'}`,
    '',
    '## Cleanup',
    '',
    `- attempted: ${report.cleanup?.attempted === true}`,
    `- ok: ${report.cleanup?.ok === true}`,
    `- visibleAfterCleanup: ${report.cleanup?.visibleAfterCleanup === true}`,
    `- rollbackReportOk: ${rollbackReport.ok === true}`,
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
