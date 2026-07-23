export const NOE_EVOLUTION_CANDIDATE_GATE_SCHEMA_VERSION = 1;

const CANDIDATE_TYPES = new Set(['skill', 'prompt', 'code', 'config', 'model_policy']);

function clean(value, max = 1000) {
  return String(value ?? '').trim().slice(0, max);
}

function num(value, fallback = null) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function hasText(value) {
  return clean(value).length > 0;
}

// (codex post-review 返工：已移除 candidate 自报 approvalRef 豁免膨胀硬规则的逻辑——任意 plausible
//  ref 即豁免是绕过，且 NoeSelfEvolutionGate 只消费 candidateGate.ok 不补 ref 校验。原 isPlausibleApprovalRef
//  随之删除；真要批准超限改动须走 owner/consensus 授权的上层 passed ledger 机制。)

function addMissing(errors, condition, id) {
  if (!condition) errors.push(id);
}

function safeObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function validateSize(errors, candidate, limits) {
  const size = safeObject(candidate.size);
  const changedFiles = num(size.changedFiles ?? candidate.changedFiles, 0);
  const addedLines = num(size.addedLines ?? candidate.addedLines, 0);
  const removedLines = num(size.removedLines ?? candidate.removedLines, 0);
  const totalBytes = num(size.totalBytes ?? candidate.totalBytes, 0);
  const changedLines = Math.max(0, addedLines) + Math.max(0, removedLines);
  addMissing(errors, changedFiles >= 0 && changedLines >= 0 && totalBytes >= 0, 'candidate_size_metrics_required');
  if (changedFiles > limits.maxChangedFiles) errors.push(`candidate_size_changed_files_exceeded:${changedFiles}/${limits.maxChangedFiles}`);
  if (changedLines > limits.maxChangedLines) errors.push(`candidate_size_changed_lines_exceeded:${changedLines}/${limits.maxChangedLines}`);
  if (totalBytes > limits.maxTotalBytes) errors.push(`candidate_size_total_bytes_exceeded:${totalBytes}/${limits.maxTotalBytes}`);
  return { changedFiles, changedLines, totalBytes };
}

function validateGrowth(errors, candidate, limits) {
  const growth = safeObject(candidate.growth);
  const currentTotalBytes = num(growth.currentTotalBytes);
  const projectedTotalBytes = num(growth.projectedTotalBytes);
  // 安全：候选自设的 maxGrowthRatio 只能更严，不能放宽硬上限 → Math.min 夹紧。
  const candidateRatio = num(growth.maxGrowthRatio, limits.maxGrowthRatio);
  const maxGrowthRatio = Math.min(candidateRatio, limits.maxGrowthRatio);
  if (currentTotalBytes === null || projectedTotalBytes === null || currentTotalBytes <= 0) {
    errors.push('candidate_growth_metrics_required');
    return { ok: false };
  }
  const ratio = projectedTotalBytes / currentTotalBytes;
  // 安全(codex post-review 返工)：growth ratio 硬上限不能被候选自报的 approvalRef 字符串豁免——
  // 任意"像路径"的 ref(甚至指向不存在的文件)都能绕过，且 NoeSelfEvolutionGate 只消费 candidateGate.ok
  // 不补 ref 存在性/passed 校验。真要批准超限改动须走 owner/consensus 授权的上层机制(passed ledger)，
  // 不是 candidate 自带字段。故超限直接报错，移除 approvalRef 自报豁免。
  if (ratio > maxGrowthRatio) {
    errors.push(`candidate_growth_ratio_exceeded:${Math.round(ratio * 1000) / 1000}/${maxGrowthRatio}`);
  }
  return { currentTotalBytes, projectedTotalBytes, ratio, maxGrowthRatio };
}

function validateStructure(errors, candidate) {
  const structure = safeObject(candidate.structure);
  addMissing(errors, structure.ok === true, 'candidate_structure_validation_required');
  if (structure.touchesDefaultConfig === true && candidate.writesDefaultConfig !== true) {
    errors.push('candidate_default_config_touch_must_be_explicit');
  }
  if (candidate.writesDefaultConfig === true && structure.ok !== true) {
    errors.push('candidate_default_config_write_requires_structure_ok');
  }
  return structure;
}

function validateTests(errors, candidate) {
  const tests = Array.isArray(candidate.tests) ? candidate.tests : [];
  addMissing(errors, tests.length > 0, 'candidate_tests_required');
  for (const test of tests) {
    const name = clean(test?.name || test?.script || 'unnamed', 160) || 'unnamed';
    if (test?.ok !== true) errors.push(`candidate_test_failed:${name}`);
    if (!hasText(test?.reportRef || test?.evidenceRef)) errors.push(`candidate_test_report_ref_required:${name}`);
  }
  return tests;
}

function validateHoldout(errors, candidate, limits) {
  const holdout = safeObject(candidate.holdout);
  const baselineScore = num(holdout.baselineScore);
  const candidateScore = num(holdout.candidateScore);
  // 安全：候选自设的 minDelta 只能更严，不能放宽硬下限 → Math.max 夹紧。
  const candidateMinDelta = num(holdout.minDelta, limits.minHoldoutDelta);
  const minDelta = Math.max(candidateMinDelta, limits.minHoldoutDelta);
  if (baselineScore === null || candidateScore === null) {
    errors.push('candidate_holdout_scores_required');
    return { ok: false };
  }
  const delta = candidateScore - baselineScore;
  if (delta < minDelta) errors.push(`candidate_holdout_improvement_required:${Math.round(delta * 10000) / 10000}/${minDelta}`);
  addMissing(errors, hasText(holdout.reportRef), 'candidate_holdout_report_ref_required');
  return { baselineScore, candidateScore, delta, minDelta };
}

export function evaluateNoeEvolutionCandidateGate(candidate = {}, {
  maxChangedFiles = 10,
  maxChangedLines = 500,
  maxTotalBytes = 250_000,
  maxGrowthRatio = 1.05,
  minHoldoutDelta = 0.001,
} = {}) {
  const limits = { maxChangedFiles, maxChangedLines, maxTotalBytes, maxGrowthRatio, minHoldoutDelta };
  const errors = [];
  const warnings = [];
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
    return { ok: false, errors: ['candidate_must_be_object'], warnings, gates: {} };
  }
  const type = clean(candidate.type, 80);
  addMissing(errors, hasText(candidate.id || candidate.candidateId), 'candidate_id_required');
  if (!CANDIDATE_TYPES.has(type)) errors.push(`candidate_type_unknown:${type || 'blank'}`);
  addMissing(errors, hasText(candidate.baselineRef), 'candidate_baseline_ref_required');
  addMissing(errors, hasText(candidate.candidateRef || candidate.diffRef), 'candidate_ref_required');

  const size = validateSize(errors, candidate, limits);
  const growth = validateGrowth(errors, candidate, limits);
  const structure = validateStructure(errors, candidate);
  const tests = validateTests(errors, candidate);
  const holdout = validateHoldout(errors, candidate, limits);
  addMissing(errors, hasText(candidate.rollbackRef || candidate.rollback?.planRef || candidate.rollback?.snapshotRef), 'candidate_rollback_ref_required');

  return {
    ok: errors.length === 0,
    schemaVersion: NOE_EVOLUTION_CANDIDATE_GATE_SCHEMA_VERSION,
    candidateId: clean(candidate.id || candidate.candidateId, 160),
    type,
    errors,
    warnings,
    gates: {
      identity: hasText(candidate.id || candidate.candidateId) && CANDIDATE_TYPES.has(type),
      baseline: hasText(candidate.baselineRef),
      candidateRef: hasText(candidate.candidateRef || candidate.diffRef),
      size: !errors.some((error) => error.startsWith('candidate_size_')),
      growth: !errors.some((error) => error.startsWith('candidate_growth_')),
      structure: structure.ok === true && !errors.some((error) => error.startsWith('candidate_default_config_')),
      tests: tests.length > 0 && !errors.some((error) => error.startsWith('candidate_test_')),
      holdout: holdout.delta >= holdout.minDelta && hasText(candidate.holdout?.reportRef),
      rollback: hasText(candidate.rollbackRef || candidate.rollback?.planRef || candidate.rollback?.snapshotRef),
      defaultConfigWrite: candidate.writesDefaultConfig === true ? errors.length === 0 : true,
    },
    metrics: {
      size,
      growth,
      holdout,
    },
  };
}
