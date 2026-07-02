import { validateNoeConsensusLedger } from './NoeConsensusGate.js';
import {
  readNoeConsensusLedgerFile,
  resolveNoeConsensusRef,
  validateNoeConsensusLedgerArtifact,
} from './NoeConsensusLedger.js';
import { evaluateNoeEvolutionCandidateGate } from './NoeEvolutionCandidateGate.js';
import { validateNoeImplementationExecutor } from './NoeExecutionAuthority.js';
import { validateNoePostReview } from './NoePostReviewGate.js';
import { noeSelfEvolutionReviewerIds } from './NoeSelfEvolutionReviewers.js';

const ACTIONS = new Set(['implementation', 'self_repair', 'memory_writeback', 'complete']);
const CONSENSUS_AUTHORIZED_CAPABILITIES = new Set([
  'file_delete',
  'file_bulk_move',
  'network_upload',
  'external_publish',
  'external_post',
  'secret_access',
  'secret_use',
  'process_restart',
  'process_kill',
]);

function cleanString(value) {
  return String(value || '').trim();
}

function hasText(value) {
  return cleanString(value).length > 0;
}

function addMissing(errors, condition, id) {
  if (!condition) errors.push(id);
}

function numberOr(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function normalizeCapability(value) {
  return cleanString(value).toLowerCase().replace(/[-.\s/]+/g, '_');
}

function isSystemLevelCapability(value) {
  const cap = normalizeCapability(value);
  return cap === 'system' ||
    cap === 'system_level' ||
    cap.startsWith('system_') ||
    cap.startsWith('os_') ||
    cap.startsWith('kernel_') ||
    cap.startsWith('host_');
}

function ledgerRefFromInput(input = {}) {
  return cleanString(
    input.ledgerRef ||
    input.consensusLedgerRef ||
    input.consensusLedgerFile ||
    input.consensus?.ledgerRef ||
    input.consensus?.ref ||
    input.consensus?.file
  );
}

function validationSource(validation, extra = {}) {
  return {
    ...validation,
    source: 'validated_consensus_ledger',
    ledgerVerified: validation.ok === true,
    ...extra,
  };
}

export function isNoeConsensusAuthorizationPassed(consensus = {}) {
  const inner = consensus?.consensus || consensus;
  const threshold = numberOr(inner?.threshold ?? consensus?.threshold, 3);
  const approvedCount = numberOr(inner?.approvedCount ?? inner?.approved_count ?? consensus?.approvedCount ?? consensus?.approved_count, 0);
  const availableCount = numberOr(inner?.availableCount ?? inner?.available_count ?? consensus?.availableCount ?? consensus?.available_count, 4);
  const validated = consensus?.source === 'validated_consensus_ledger' && consensus?.ledgerVerified === true;
  return validated && consensus?.ok === true && availableCount >= 2 && threshold >= 2 && approvedCount >= threshold;
}

// 内联 ledger 对象默认必须让 evidence/raw 原始文件真实存在，才能当 validated_consensus_ledger。
// 仅显式 dry-run（input.dryRun === true）或显式 input.requireConsensusLedgerFiles === false
// 时才跳过文件存在性校验（与 cycle-assemble 的 no_require_files_only_supported_for_dry_run 同口径）。
function inlineLedgerRequiresFiles(input = {}) {
  if (input.requireConsensusLedgerFiles === true) return true;
  if (input.requireConsensusLedgerFiles === false) return false;
  return input.dryRun !== true;
}

export function resolveNoeSelfEvolutionConsensus(input = {}) {
  if (input.ledger && typeof input.ledger === 'object' && !Array.isArray(input.ledger)) {
    const requireFiles = inlineLedgerRequiresFiles(input);
    const validation = validateNoeConsensusLedgerArtifact(input.ledger, {
      root: input.root || process.cwd(),
      requireEvidenceFile: requireFiles,
      requireRawOutputFiles: requireFiles,
    });
    return validationSource(validation, { ledgerObject: true, referencedFilesRequired: requireFiles });
  }
  const ledgerRef = ledgerRefFromInput(input);
  if (ledgerRef) {
    try {
      const root = input.root || process.cwd();
      const file = resolveNoeConsensusRef(root, ledgerRef);
      const validation = validateNoeConsensusLedgerArtifact(readNoeConsensusLedgerFile(file), {
        root,
        requireEvidenceFile: true,
        requireRawOutputFiles: true,
      });
      return validationSource(validation, { ledgerRef, referencedFilesRequired: true });
    } catch (e) {
      return {
        ok: false,
        errors: [`consensus_ledger_ref_invalid:${e.message}`],
        warnings: [],
        consensus: null,
        source: 'validated_consensus_ledger',
        ledgerVerified: false,
        ledgerRef,
      };
    }
  }
  if (input.consensus && typeof input.consensus === 'object' && !Array.isArray(input.consensus)) {
    return {
      ...input.consensus,
      source: 'unverified_consensus_summary',
      ledgerVerified: false,
    };
  }
  return validateNoeConsensusLedger({});
}

// 复核环节的 rawOutputRef 文件是否要求真实存在：与内联 ledger 同口径（非 dry-run 即要求）。
function postReviewRequiresFiles(input = {}) {
  if (input.requireConsensusLedgerFiles === true) return true;
  if (input.requireConsensusLedgerFiles === false) return false;
  return input.dryRun !== true;
}

// 解析当前 active executor（被排除出非实施者复核名单）：
// 优先用内联 ledger 的 implementation，其次 input.implementation/activeExecutor，默认 codex。
function resolveGateActiveExecutor(input = {}) {
  const implementation =
    (input.ledger && typeof input.ledger === 'object' && !Array.isArray(input.ledger) && input.ledger.implementation) ||
    input.implementation ||
    {};
  const source = {
    ...implementation,
    activeExecutor: implementation.activeExecutor || implementation.executor || implementation.writer || input.activeExecutor,
  };
  return validateNoeImplementationExecutor(source).activeExecutor || 'codex';
}

export function evaluateNoeSelfEvolutionGate(input = {}) {
  const action = cleanString(input.action || 'implementation');
  const errors = [];
  const warnings = [];
  if (!ACTIONS.has(action)) errors.push(`unknown_action:${action || 'blank'}`);

  const consensus = resolveNoeSelfEvolutionConsensus(input);
  if (consensus?.ok !== true) {
    for (const error of Array.isArray(consensus?.errors) ? consensus.errors : []) {
      errors.push(`consensus:${error}`);
    }
  }
  for (const warning of Array.isArray(consensus?.warnings) ? consensus.warnings : []) {
    warnings.push(`consensus:${warning}`);
  }
  addMissing(errors, consensus?.ok === true, 'consensus_gate_not_passed');
  addMissing(errors, consensus?.ok === true && consensus?.source === 'validated_consensus_ledger' && consensus?.ledgerVerified === true, 'validated_consensus_ledger_required');

  const authorization = input.authorization || {};
  const consensusAuthorized = authorization.consensusApproved === true && isNoeConsensusAuthorizationPassed(consensus);
  // standing 自授权(owner standing grant,env 门控,scope self-evolution:run):只替代 owner approval,
  // 不替代下方任何硬约束(validated consensus ledger / rollback / runtime / system_level / hardVetoes 全保留)。
  const standingAuthorized = authorization.standingApproved === true;
  // green 自主(P3.2)：tierRisk 判 green tier 时替代 owner approval，与 standing 同档——只省 approval，
  // 下方所有硬约束(validated consensus ledger L174 / rollback / runtime / system_level / hardVetoes)全保留。
  // greenTierApproved 由 ActGuard 从【事实】patch plan 算出(非 payload 自报)，ActGuard 是唯一信任边界。
  const greenTierAuthorized = authorization.greenTierApproved === true;
  const authorized = authorization.userApproved === true || consensusAuthorized || standingAuthorized || greenTierAuthorized;
  addMissing(errors, authorized, 'user_or_consensus_authorization_required');
  addMissing(errors, hasText(authorization.scope), 'authorization_scope_required');
  addMissing(errors, hasText(authorization.costClass), 'authorization_cost_class_required');

  const requestedCapabilities = Array.isArray(input.requestedCapabilities)
    ? [...new Set(input.requestedCapabilities.map(normalizeCapability).filter(Boolean))]
    : [];
  for (const capability of requestedCapabilities) {
    if (isSystemLevelCapability(capability)) {
      errors.push(`system_level_operation_not_consensus_authorizable:${capability}`);
    } else if (CONSENSUS_AUTHORIZED_CAPABILITIES.has(capability) && !consensusAuthorized) {
      errors.push(`high_risk_capability_requires_dynamic_quorum_consensus:${capability}`);
    }
  }

  const rollback = input.rollback || {};
  addMissing(errors, hasText(rollback.planRef) || hasText(rollback.snapshotRef), 'rollback_plan_required');

  const runtime = input.runtimeVerification || {};
  if (action === 'memory_writeback' || action === 'complete') {
    addMissing(errors, runtime.ok === true, 'runtime_verification_required');
    addMissing(errors, hasText(runtime.reportRef), 'runtime_report_ref_required');
  } else if (runtime.ok === false) {
    warnings.push('runtime_verification_failed');
  }

  const postReview = input.postReview || {};
  let postReviewOk = postReview.ok === true;
  if (action === 'complete') {
    // 与 cycle 层对齐：complete 不能只凭 {ok:true, approvals>=1} 放行。
    // 必须有真实的非实施者 reviewer（排除 active executor）、动态 quorum、rawOutputRef。
    const activeExecutor = resolveGateActiveExecutor(input);
    const postReviewErrors = [];
    validateNoePostReview(postReviewErrors, {
      root: input.root || process.cwd(),
      postReview,
      requireFile: postReviewRequiresFiles(input),
      activeExecutor,
      // P0.2b：self-evolution 启用本地 reviewer 时，complete gate 的 post-review 复核口径同步用本地 reviewer 集
      //   （否则要求 cloud claude/m3，在本机不可达 → cycle 永不 complete）。env 未设 → undefined → 回退 cloud（零回归）。
      requiredReviewers: noeSelfEvolutionReviewerIds() || undefined,
      prefix: 'post_review',
    });
    // P3.1 渐进审查放松：仅当 reviewTier 算出可省（requirePostReview 严格 === false，由 ActGuard 按 green 后段事实算）
    //   时，post_review 失败降为 warning（不进 errors）；否则（缺省/flag OFF/高危/flagged/首 N 次）原样硬 error，零回归。
    //   只放松 post_review 这一道——consensus ledger(上方 L173-174)/runtime/rollback/retrospective(下方)/system_level/hardVetoes 全保留。
    if (input.reviewTier?.requirePostReview === false && postReviewErrors.length) {
      warnings.push(`post_review_relaxed_by_tier:${input.reviewTier.tier || 'sample'}`);
    } else {
      errors.push(...postReviewErrors);
    }
    postReviewOk = postReviewErrors.length === 0;
    addMissing(errors, hasText(input.retrospectiveRef || input.retrospective?.ref || input.retrospective?.reportRef), 'retrospective_ref_required');
  }

  if (action === 'self_repair') {
    addMissing(errors, hasText(input.failedVerificationRef), 'failed_verification_ref_required');
    addMissing(errors, input.repairReturnsToConsensus === true, 'self_repair_must_return_to_consensus');
  }

  const memory = input.memoryWriteback || {};
  let memoryAck = false;
  if (action === 'memory_writeback' || action === 'complete') {
    const memoryConsensusAck = memory.consensusAck === true && isNoeConsensusAuthorizationPassed(consensus);
    memoryAck = memory.userAck === true || memoryConsensusAck;
    addMissing(errors, memoryAck, 'memory_writeback_ack_required');
    addMissing(errors, hasText(memory.summaryRef), 'memory_writeback_summary_ref_required');
    if (memory.autoWrite === true && !memoryConsensusAck) errors.push('memory_writeback_auto_requires_consensus');
  } else if (memory.autoWrite === true) {
    errors.push('memory_writeback_auto_requires_consensus');
  }

  const hardVetoes = Array.isArray(input.hardVetoes) ? input.hardVetoes.filter(Boolean) : [];
  for (const veto of hardVetoes) errors.push(`hard_veto:${veto}`);

  const candidateGate = input.candidate
    ? evaluateNoeEvolutionCandidateGate(input.candidate, input.candidateGate || {})
    : null;
  if (candidateGate && candidateGate.ok !== true) {
    errors.push(...candidateGate.errors.map((error) => `candidate:${error}`));
  }

  return {
    ok: errors.length === 0,
    action,
    errors,
    warnings,
    gates: {
      consensus: consensus?.ok === true,
      userAuthorization: authorization.userApproved === true,
      consensusAuthorization: consensusAuthorized,
      standingAuthorization: standingAuthorized,
      greenTierAuthorization: greenTierAuthorized,
      authorization: authorized,
      rollback: hasText(rollback.planRef) || hasText(rollback.snapshotRef),
      runtimeVerification: runtime.ok === true,
      postReview: postReviewOk,
      retrospective: hasText(input.retrospectiveRef || input.retrospective?.ref || input.retrospective?.reportRef),
      memoryWritebackAck: memoryAck,
      hardVetoes: hardVetoes.length,
      requestedCapabilities,
      candidate: candidateGate ? candidateGate.ok === true : null,
    },
    ...(candidateGate ? { candidateGate } : {}),
  };
}
