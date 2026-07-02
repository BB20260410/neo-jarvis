import { existsSync, readFileSync } from 'node:fs';
import {
  resolveNoeConsensusRef,
  validateNoeConsensusLedgerArtifact,
} from './NoeConsensusLedger.js';
import {
  evaluateNoeSelfEvolutionLoop,
} from './NoeSelfEvolutionLoop.js';
import {
  validateNoeImplementationExecutor,
} from './NoeExecutionAuthority.js';
import {
  nonImplementerApprovals,
  validateNoePostReview,
} from './NoePostReviewGate.js';
import { noeSelfEvolutionReviewerIds } from './NoeSelfEvolutionReviewers.js';

export const NOE_SELF_EVOLUTION_CYCLE_SCHEMA_VERSION = 1;

function cleanString(value) {
  return String(value || '').trim();
}

function hasText(value) {
  return cleanString(value).length > 0;
}

function safeObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return value;
}

function isDone(value) {
  if (value === true) return true;
  if (!value || typeof value !== 'object') return false;
  return value.ok === true || value.done === true || value.applied === true || value.status === 'done' || value.status === 'complete';
}

function addMissing(errors, condition, id) {
  if (!condition) errors.push(id);
}

function refValue(input = {}, ...keys) {
  for (const key of keys) {
    const value = cleanString(input[key]);
    if (value) return value;
  }
  return '';
}

function checkRef(errors, root, ref, id, requireFile) {
  const text = cleanString(ref);
  if (!text) {
    errors.push(`${id}_required`);
    return;
  }
  try {
    const full = resolveNoeConsensusRef(root, text);
    if (requireFile && !existsSync(full)) errors.push(`missing_${id}:${text}`);
  } catch (e) {
    errors.push(`${id}_invalid:${e.message}`);
  }
}

function validateLedgerFromRef(ref, opts = {}) {
  const root = opts.root || process.cwd();
  const warnings = [];   // errors 各分支用字面数组直接返回，无需累积器（2026-06-10 清 lint 删冗余声明）
  try {
    const full = resolveNoeConsensusRef(root, ref);
    if (!existsSync(full)) return { ok: false, errors: [`missing_consensus_ledger_file:${ref}`], warnings, gate: null };
    const ledger = JSON.parse(readFileSync(full, 'utf8'));
    return validateLedgerObject(ledger, opts);
  } catch (e) {
    return { ok: false, errors: [`consensus_ledger_ref_invalid:${e.message}`], warnings, gate: null };
  }
}

function validateLedgerObject(ledger, opts = {}) {
  const validation = validateNoeConsensusLedgerArtifact(ledger, {
    root: opts.root || process.cwd(),
    requireEvidenceFile: opts.requireReferencedFiles === true,
    requireRawOutputFiles: opts.requireReferencedFiles === true,
  });
  return {
    ok: validation.ok,
    errors: validation.errors,
    warnings: validation.warnings,
    ledger,
    gate: {
      ok: validation.ok,
      validated: validation.ok,
      source: 'validated_consensus_ledger',
      ledgerVerified: validation.ok,
      consensus: validation.consensus,
    },
  };
}

function resolveCycleConsensus(cycle = {}, opts = {}) {
  const consensus = safeObject(cycle.consensus);
  const ledger = cycle.ledger || cycle.consensusLedger;
  const ledgerRef = cleanString(cycle.consensusLedgerRef || consensus.ledgerRef || consensus.ref);
  if (ledger && typeof ledger === 'object' && !Array.isArray(ledger)) {
    const validation = validateLedgerObject(ledger, opts);
    return { ...validation, ledgerRef };
  }
  if (ledgerRef) {
    const validation = validateLedgerFromRef(ledgerRef, opts);
    return { ...validation, ledgerRef };
  }
  return {
    ok: false,
    errors: ['consensus_ledger_artifact_required'],
    warnings: [],
    gate: null,
    ledgerRef,
  };
}


// P2-6：草案/中间态校验——只校验骨架（object / schemaVersion / cycleId / createdAt / goal），
// 不要求 implementation/runtime/postReview 等阶段产物齐全。CycleStore 落库（upsert）用它，
// 让早期 cycle 能持久化推进；只有 stage==='complete' 的 artifact 才跑下方 validateNoeSelfEvolutionCycle 完整校验。
export function validateNoeSelfEvolutionCycleDraft(cycle = {}) {
  const errors = [];
  if (!cycle || typeof cycle !== 'object' || Array.isArray(cycle)) {
    return { ok: false, errors: ['cycle_must_be_object'] };
  }
  addMissing(errors, cycle.schemaVersion === NOE_SELF_EVOLUTION_CYCLE_SCHEMA_VERSION, `unsupported_cycle_schema_version:${cycle.schemaVersion ?? 'missing'}`);
  addMissing(errors, hasText(cycle.cycleId), 'cycle_id_required');
  addMissing(errors, hasText(cycle.createdAt), 'cycle_created_at_required');
  addMissing(errors, hasText(cycle.goal), 'cycle_goal_required');
  return { ok: errors.length === 0, errors };
}

export function validateNoeSelfEvolutionCycle(cycle = {}, opts = {}) {
  const root = opts.root || process.cwd();
  const requireFile = opts.requireReferencedFiles === true;
  const errors = [];
  const warnings = [];
  if (!cycle || typeof cycle !== 'object' || Array.isArray(cycle)) {
    return { ok: false, errors: ['cycle_must_be_object'], warnings, loop: null };
  }

  addMissing(errors, cycle.schemaVersion === NOE_SELF_EVOLUTION_CYCLE_SCHEMA_VERSION, `unsupported_cycle_schema_version:${cycle.schemaVersion ?? 'missing'}`);
  addMissing(errors, hasText(cycle.cycleId), 'cycle_id_required');
  addMissing(errors, hasText(cycle.createdAt), 'cycle_created_at_required');
  addMissing(errors, hasText(cycle.goal), 'cycle_goal_required');

  const consensus = resolveCycleConsensus(cycle, opts);
  errors.push(...consensus.errors.map((error) => `cycle_consensus:${error}`));
  warnings.push(...consensus.warnings);
  addMissing(errors, hasText(consensus.ledgerRef) || Boolean(cycle.ledger || cycle.consensusLedger), 'cycle_consensus_ledger_ref_required');
  addMissing(errors, consensus.gate?.ok === true && consensus.gate?.validated === true, 'cycle_consensus_validated_ledger_required');
  if (hasText(consensus.ledgerRef)) checkRef(errors, root, consensus.ledgerRef, 'cycle_consensus_ledger_ref', requireFile);

  const implementation = safeObject(cycle.implementation);
  addMissing(errors, isDone(implementation), 'cycle_implementation_done_required');
  const executorValidation = validateNoeImplementationExecutor(implementation);
  errors.push(...executorValidation.errors.map((error) => `cycle_${error}`));
  const activeExecutor = executorValidation.activeExecutor || 'codex';
  const hasImplementationEvidence = hasText(implementation.diffRef) ||
    hasText(implementation.evidenceRef) ||
    (Array.isArray(implementation.touchedFiles) && implementation.touchedFiles.length > 0);
  addMissing(errors, hasImplementationEvidence, 'cycle_implementation_evidence_required');
  if (hasText(implementation.diffRef)) checkRef(errors, root, implementation.diffRef, 'cycle_implementation_diff_ref', requireFile);
  if (hasText(implementation.evidenceRef)) checkRef(errors, root, implementation.evidenceRef, 'cycle_implementation_evidence_ref', requireFile);

  const rollback = safeObject(cycle.rollback);
  const rollbackRef = refValue(rollback, 'planRef', 'snapshotRef');
  checkRef(errors, root, rollbackRef, 'cycle_rollback_ref', requireFile);

  const runtimeVerification = safeObject(cycle.runtimeVerification);
  addMissing(errors, runtimeVerification.ok === true, 'cycle_runtime_verification_required');
  checkRef(errors, root, runtimeVerification.reportRef, 'cycle_runtime_report_ref', requireFile);

  const postReview = safeObject(cycle.postReview);
  validateNoePostReview(errors, {
    root,
    postReview,
    requireFile,
    activeExecutor,
    // P0.2b：cycle complete 完整校验的 post-review 口径与 self-evolution reviewer 集一致（本地 reviewer 启用时认本地，
    //   否则回退 cloud requiredReviewerModels，零回归）。否则 complete 会要求本机不可达的 cloud claude/m3。
    requiredReviewers: noeSelfEvolutionReviewerIds() || undefined,
    prefix: 'cycle_post_review',
  });

  const retrospectiveRef = cleanString(cycle.retrospectiveRef || cycle.retrospective?.ref || cycle.retrospective?.reportRef);
  checkRef(errors, root, retrospectiveRef, 'cycle_retrospective_ref', requireFile);

  const memoryWriteback = safeObject(cycle.memoryWriteback);
  addMissing(errors, isDone(memoryWriteback), 'cycle_memory_writeback_done_required');
  checkRef(errors, root, memoryWriteback.summaryRef, 'cycle_memory_summary_ref', requireFile);
  if (hasText(memoryWriteback.writeRef)) checkRef(errors, root, memoryWriteback.writeRef, 'cycle_memory_write_ref', requireFile);

  const loop = evaluateNoeSelfEvolutionLoop({
    ...cycle,
    consensus: undefined,
    ledger: consensus.ledger,
    root,
    // 把 cycle 的「是否要求引用文件存在」一并下传给 gate 的内联 ledger / 复核校验，
    // 保持 cycle ↔ loop ↔ gate 三层的文件存在性口径一致（cycle 已先行校验，这里是同口径的二次防线）。
    requireConsensusLedgerFiles: requireFile,
    dryRun: !requireFile,
    authorization: {
      ...(cycle.authorization || {}),
      consensusApproved: cycle.authorization?.consensusApproved !== false,
    },
    postReview: {
      ...postReview,
      approvals: Math.max(Number(postReview.approvals || 0), nonImplementerApprovals(postReview, activeExecutor).length),
    },
  });
  if (!loop.ok) {
    errors.push(`cycle_loop_not_complete:${loop.stage}`);
    errors.push(...loop.errors.map((error) => `cycle_loop:${error}`));
  }

  return {
    ok: errors.length === 0,
    errors,
    warnings,
    loop,
    gates: {
      consensus: consensus.gate?.ok === true,
      validatedConsensus: consensus.gate?.validated === true,
      implementation: isDone(implementation),
      runtimeVerification: runtimeVerification.ok === true,
      postReview: postReview.ok === true,
      retrospective: hasText(retrospectiveRef),
      memoryWriteback: isDone(memoryWriteback),
    },
  };
}
