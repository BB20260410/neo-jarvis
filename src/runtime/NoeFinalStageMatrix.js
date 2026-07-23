const REQUIRED_STAGE_IDS = Object.freeze(['B', 'C', 'D', 'E']);
const SENSITIVE_KEY_PATTERN = /(secret|token|api[_-]?key|private[_-]?holdout|password)/i;
const FORBIDDEN_REF_PATTERN = /(^|[/\\])(\.env[^/\\]*|room-adapters\.json|private_holdout|owner[-_]?token)([/\\]|$)|\.\.|^~|^file:|^[a-z][a-z0-9+.-]*:/i;

function cleanString(value) {
  return String(value || '').trim();
}

function isPlainObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value);
}

function stageIndex(order, id) {
  return Array.isArray(order) ? order.indexOf(id) : -1;
}

function numberValue(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function stepMap(steps) {
  const out = new Map();
  for (const step of Array.isArray(steps) ? steps : []) {
    if (isPlainObject(step) && cleanString(step.name)) out.set(cleanString(step.name), step);
  }
  return out;
}

function scanSensitiveKeys(value, path = '') {
  const findings = [];
  if (Array.isArray(value)) {
    value.forEach((item, index) => findings.push(...scanSensitiveKeys(item, `${path}[${index}]`)));
    return findings;
  }
  if (!isPlainObject(value)) return findings;
  for (const [key, child] of Object.entries(value)) {
    const nextPath = path ? `${path}.${key}` : key;
    if (SENSITIVE_KEY_PATTERN.test(key) && !/(redacted|hash|ref|sourceType|configured|allowed|policy|scope|status)/i.test(key)) {
      findings.push(`sensitive_key:${nextPath}`);
    }
    findings.push(...scanSensitiveKeys(child, nextPath));
  }
  return findings;
}

function refLooksForbidden(ref) {
  const text = cleanString(ref);
  return !text || text.startsWith('/') || FORBIDDEN_REF_PATTERN.test(text);
}

function normalizeRef(ref) {
  return cleanString(ref).replace(/\\/g, '/').replace(/\/+/g, '/');
}

export function validateNoeFinalStageRef(ref, { kind = 'stage_evidence', allowedPrefixes = [] } = {}) {
  const normalized = normalizeRef(ref);
  const errors = [];
  if (refLooksForbidden(normalized)) errors.push(`${kind}_ref_forbidden`);
  const prefixes = allowedPrefixes.map((item) => normalizeRef(item)).filter(Boolean);
  if (prefixes.length && !prefixes.some((prefix) => normalized === prefix.replace(/\/$/, '') || normalized.startsWith(prefix.endsWith('/') ? prefix : `${prefix}/`))) {
    errors.push(`${kind}_ref_outside_allowed_prefix`);
  }
  return { ok: errors.length === 0, ref: normalized, errors };
}

export function assertNoeFinalStageSafeRef(ref, opts = {}) {
  const result = validateNoeFinalStageRef(ref, opts);
  if (!result.ok) throw new Error(result.errors.join(','));
  return result.ref;
}

export function validateNoeFinalStageAuthorizationMatrix(matrix = {}) {
  const errors = [];
  const warnings = [];

  if (!isPlainObject(matrix)) {
    return { ok: false, errors: ['matrix_must_be_object'], warnings };
  }
  if (matrix.schemaVersion !== 1) errors.push(`unsupported_schema_version:${matrix.schemaVersion ?? 'missing'}`);
  if (!cleanString(matrix.roundId)) errors.push('round_id_required');

  const authorization = isPlainObject(matrix.authorization) ? matrix.authorization : {};
  for (const id of REQUIRED_STAGE_IDS) {
    const stage = authorization[id];
    if (!isPlainObject(stage)) {
      errors.push(`stage_authorization_required:${id}`);
      continue;
    }
    if (stage.authorized !== true) errors.push(`stage_not_authorized:${id}`);
    if (stage.redactionRequired !== true) errors.push(`stage_redaction_required:${id}`);
    if (stage.rawSecretReadAllowed === true) errors.push(`raw_secret_read_must_remain_forbidden:${id}`);
    if (stage.rawPrivateHoldoutReadAllowed === true) errors.push(`raw_private_holdout_read_must_remain_forbidden:${id}`);
    if (id === 'D' && stage.rollbackRequired !== true) errors.push('stage_rollback_required:D');
    if (id === 'E' && stage.finalStage !== true) errors.push('stage_e_must_be_final');
    if (!cleanString(stage.scope)) warnings.push(`stage_scope_missing:${id}`);
  }

  const order = Array.isArray(matrix.order) ? matrix.order : [];
  for (const id of REQUIRED_STAGE_IDS) {
    if (!order.includes(id)) errors.push(`stage_order_missing:${id}`);
  }
  if (stageIndex(order, 'E') !== order.length - 1) errors.push('stage_e_must_be_last');
  if (stageIndex(order, 'D') >= 0 && stageIndex(order, 'E') >= 0 && stageIndex(order, 'D') > stageIndex(order, 'E')) {
    errors.push('stage_d_must_precede_e');
  }

  const stageEvidenceDir = normalizeRef(matrix.stageEvidenceDir);
  if (!stageEvidenceDir) {
    errors.push('stage_evidence_dir_required');
  } else {
    const dirResult = validateNoeFinalStageRef(stageEvidenceDir, {
      kind: 'stage_evidence_dir',
      allowedPrefixes: ['output/noe-final-real-machine-stages'],
    });
    errors.push(...dirResult.errors);
  }
  if (!Array.isArray(matrix.redactionRules) || matrix.redactionRules.length === 0) errors.push('redaction_rules_required');
  if (!Array.isArray(matrix.forbidden) || matrix.forbidden.length === 0) errors.push('forbidden_rules_required');
  const refs = isPlainObject(matrix.stageEvidenceRefs) ? matrix.stageEvidenceRefs : {};
  for (const id of REQUIRED_STAGE_IDS) {
    const ref = cleanString(refs[id]);
    if (!ref) {
      warnings.push(`stage_evidence_ref_missing:${id}`);
    } else {
      const refResult = validateNoeFinalStageRef(ref, {
        kind: `stage_evidence_ref:${id}`,
        allowedPrefixes: [stageEvidenceDir || 'output/noe-final-real-machine-stages'],
      });
      errors.push(...refResult.errors);
    }
  }

  errors.push(...scanSensitiveKeys(matrix));

  return {
    ok: errors.length === 0,
    requiredStages: [...REQUIRED_STAGE_IDS],
    errors,
    warnings,
  };
}

export function validateNoeFinalStageEvidence({ matrix = {}, stageEvidence = {}, requireComplete = false } = {}) {
  const matrixResult = validateNoeFinalStageAuthorizationMatrix(matrix);
  const errors = [...matrixResult.errors];
  const warnings = [...matrixResult.warnings];
  const completed = [];

  for (const id of REQUIRED_STAGE_IDS) {
    const evidence = stageEvidence[id];
    if (!evidence) {
      if (requireComplete) errors.push(`stage_evidence_missing:${id}`);
      continue;
    }
    if (!isPlainObject(evidence)) {
      errors.push(`stage_evidence_must_be_object:${id}`);
      continue;
    }
    const errorsBeforeStage = errors.length;
    if (evidence.stage !== id) errors.push(`stage_evidence_id_mismatch:${id}`);
    if (evidence.ok !== true) errors.push(`stage_evidence_not_ok:${id}`);
    if (evidence.redacted !== true) errors.push(`stage_evidence_not_redacted:${id}`);
    if (!cleanString(evidence.observedAt)) errors.push(`stage_observed_at_required:${id}`);
    if (id === 'D') {
      if (!cleanString(evidence.rollbackRef)) {
        errors.push('stage_d_rollback_ref_required');
      } else {
        const rollbackRefResult = validateNoeFinalStageRef(evidence.rollbackRef, {
          kind: 'stage_d_rollback_ref',
          allowedPrefixes: [matrix.stageEvidenceDir || 'output/noe-final-real-machine-stages'],
        });
        errors.push(...rollbackRefResult.errors);
      }
      if (evidence.mode !== 'live_51835_scratch_write_cleanup') errors.push('stage_d_mode_required');
      if (evidence.qualityMode?.profile !== 'exhaustive') errors.push('stage_d_exhaustive_quality_required');
      if (evidence.qualityMode?.modelReviewRequiredBeforeNextStage !== true) errors.push('stage_d_model_review_required');
      if (evidence.qualityMode?.subagentReviewRequiredBeforeNextStage !== true) errors.push('stage_d_subagent_review_required');
      if (evidence.scratch?.projectId !== 'stage-d-scratch') errors.push('stage_d_scratch_project_required');
      if (evidence.scratch?.scope !== 'scratch') errors.push('stage_d_scratch_scope_required');
      if (evidence.scratch?.rawBodyStored !== false) errors.push('stage_d_raw_body_must_not_be_stored');
      if (evidence.scratch?.rawResponseStored !== false) errors.push('stage_d_raw_response_must_not_be_stored');
      if (evidence.policy?.scratchWriteOnly !== true) errors.push('stage_d_scratch_only_policy_required');
      if (evidence.policy?.cleanupRequired !== true) errors.push('stage_d_cleanup_policy_required');
      if (evidence.policy?.live51835Touched !== true) errors.push('stage_d_live_touch_required');
      if (evidence.cleanup?.attempted !== true) errors.push('stage_d_cleanup_attempt_required');
      if (evidence.cleanup?.ok !== true) errors.push('stage_d_cleanup_ok_required');
      if (evidence.cleanup?.visibleAfterCleanup !== false) errors.push('stage_d_cleanup_visibility_must_be_false');
      if (numberValue(evidence.counts?.beforeVisible) !== 0) errors.push('stage_d_before_visible_must_be_zero');
      if (numberValue(evidence.counts?.afterWriteVisible) !== 1) errors.push('stage_d_after_write_visible_must_be_one');
      if (numberValue(evidence.counts?.afterCleanupVisible) !== 0) errors.push('stage_d_after_cleanup_visible_must_be_zero');
      const steps = stepMap(evidence.steps);
      for (const requiredStep of ['before_query', 'scratch_write', 'after_write_query', 'cleanup_delete', 'after_cleanup_query']) {
        const step = steps.get(requiredStep);
        if (!step) {
          errors.push(`stage_d_step_missing:${requiredStep}`);
        } else if (step.ok !== true) {
          errors.push(`stage_d_step_not_ok:${requiredStep}`);
        }
      }
      if (numberValue(steps.get('scratch_write')?.httpStatus) !== 201) errors.push('stage_d_scratch_write_status_required');
      if (numberValue(steps.get('cleanup_delete')?.httpStatus) !== 200) errors.push('stage_d_cleanup_status_required');
    }
    if (id === 'E') {
      if (evidence.finalRestartRecovery !== true) errors.push('stage_e_restart_recovery_required');
      if (evidence.mode !== 'final_51835_restart_recovery') errors.push('stage_e_mode_required');
      if (evidence.qualityMode?.profile !== 'exhaustive') errors.push('stage_e_exhaustive_quality_required');
      if (evidence.qualityMode?.modelReviewRequiredBeforeFinalCloseout !== true) errors.push('stage_e_model_review_required');
      if (evidence.qualityMode?.subagentReviewRequiredBeforeFinalCloseout !== true) errors.push('stage_e_subagent_review_required');
      if (!cleanString(evidence.drillReportRef)) {
        errors.push('stage_e_drill_report_ref_required');
      } else {
        const drillRefResult = validateNoeFinalStageRef(evidence.drillReportRef, {
          kind: 'stage_e_drill_report_ref',
          allowedPrefixes: [matrix.stageEvidenceDir || 'output/noe-final-real-machine-stages'],
        });
        errors.push(...drillRefResult.errors);
      }
      if (evidence.preflight?.safeToRestart !== true) errors.push('stage_e_preflight_safe_required');
      if (evidence.preflight?.ok !== true) errors.push('stage_e_preflight_ok_required');
      if (evidence.preflight?.credentialValuesReturned === true) errors.push('stage_e_preflight_credential_values_must_not_return');
      if (evidence.preflight?.touchesObserveOnlyPort === true) errors.push('stage_e_preflight_must_not_touch_51735');
      if (evidence.restart?.applied !== true) errors.push('stage_e_restart_apply_required');
      if (evidence.restart?.realRestartAttempted !== true) errors.push('stage_e_real_restart_required');
      if (evidence.restart?.pidChanged !== true) errors.push('stage_e_pid_changed_required');
      if (evidence.restart?.oldPidAbsent !== true) errors.push('stage_e_old_pid_absent_required');
      if (evidence.restart?.newPidCwdIsRoot !== true) errors.push('stage_e_new_pid_cwd_required');
      if (numberValue(evidence.ports?.port51835) !== 51835) errors.push('stage_e_port_51835_required');
      if (evidence.ports?.port51735Untouched !== true) errors.push('stage_e_51735_untouched_required');
      if (evidence.health?.ok !== true) errors.push('stage_e_health_ok_required');
      if (evidence.readiness?.passed !== true) errors.push('stage_e_readiness_required');
      if (evidence.lmStudio?.loadedModelsUnchanged !== true) errors.push('stage_e_lmstudio_unchanged_required');
      if (evidence.freedomLive?.ok !== true) errors.push('stage_e_freedom_live_required');
      if (evidence.policy?.finalRestartOnly !== true) errors.push('stage_e_final_restart_policy_required');
      if (evidence.policy?.no51735Touch !== true) errors.push('stage_e_no_51735_touch_policy_required');
      if (evidence.policy?.memoryV2Writes !== false) errors.push('stage_e_memory_v2_must_not_write');
    }
    errors.push(...scanSensitiveKeys(evidence).map((finding) => `${finding}:stage:${id}`));
    if (evidence.ok === true && errors.length === errorsBeforeStage) completed.push(id);
  }

  return {
    ok: errors.length === 0,
    completed,
    requiredStages: [...REQUIRED_STAGE_IDS],
    errors,
    warnings,
  };
}
