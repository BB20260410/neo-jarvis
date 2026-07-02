import { readFileSync, existsSync } from 'node:fs';
import { dirname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  evaluateNoeSelfEvolutionGate,
  isNoeConsensusAuthorizationPassed,
  resolveNoeSelfEvolutionConsensus,
} from '../room/NoeSelfEvolutionGate.js';
import { evaluateStandingAutonomyGrant } from '../../scripts/lib/noe-standing-autonomy-grant.mjs';
import { decideGreenAutonomy } from '../security/NoeGreenAutonomyDecision.js';
import { extractNoePatchPlan } from '../runtime/mission/NoePatchApplyExecutor.js';
import { isNoePolicyFilePath } from '../security/NoePolicyFileGuard.js';
import { resolveReviewTier, resolveReviewTierConfig } from '../security/NoeReviewTier.js';
import { NoeSelfEvolutionCycleStore } from '../room/NoeSelfEvolutionCycleStore.js';

export const DEFAULT_NOE_SELF_EVOLUTION_ACT_GUARD_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

const ACTION_BY_ACT = Object.freeze({
  'noe.self_evolution.implementation': 'implementation',
  'noe.self_evolution.self_repair': 'self_repair',
  'noe.self_evolution.memory_writeback': 'memory_writeback',
  'noe.self_evolution.complete': 'complete',
});

function cleanString(value) {
  return String(value || '').trim();
}

function safeObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  try { return JSON.parse(JSON.stringify(value)); } catch { return {}; }
}

function hasKeys(value) {
  return Boolean(value && typeof value === 'object' && Object.keys(value).length);
}

function mergeContext(...parts) {
  const out = {};
  for (const part of parts) {
    const next = safeObject(part);
    if (hasKeys(next)) Object.assign(out, next);
  }
  return out;
}

function trustedRootFromArgs(args = {}) {
  return cleanString(args.root || args.selfEvolutionRoot || args.projectRoot) || DEFAULT_NOE_SELF_EVOLUTION_ACT_GUARD_ROOT;
}

function ledgerRefFromContext(context = {}) {
  return cleanString(
    context.ledgerRef ||
    context.consensusLedgerRef ||
    context.consensusLedgerFile ||
    context.consensus?.ledgerRef ||
    context.consensus?.ref ||
    context.consensus?.file
  );
}

function addCapabilityForAction(capabilities, action = '') {
  const text = cleanString(action).toLowerCase();
  if (!text) return;
  if (/file\.(delete|remove|unlink)/i.test(text)) capabilities.add('file_delete');
  if (/file\.(move\.bulk|batch_move|bulk_move)/i.test(text)) capabilities.add('file_bulk_move');
  if (/network\.upload|upload/i.test(text)) capabilities.add('network_upload');
  if (/network\.external_post|external[_-]?post|publish|deploy|release/i.test(text)) capabilities.add('external_publish');
  if (/secret|api[_-]?key|token|credential|keychain|env\./i.test(text)) capabilities.add('secret_access');
  if (/restart|reload_service/i.test(text)) capabilities.add('process_restart');
  if (/\bkill\b|process\.kill|terminate/i.test(text)) capabilities.add('process_kill');
  if (/system|kernel|hosts|dns|proxy|launchd|sudo/i.test(text)) capabilities.add('system_level');
}

function deriveRequestedCapabilities({ act = {}, input = {}, context = {} } = {}) {
  const capabilities = new Set();
  const explicit = [
    ...(Array.isArray(context.requestedCapabilities) ? context.requestedCapabilities : []),
    ...(Array.isArray(context.requested_capabilities) ? context.requested_capabilities : []),
    ...(Array.isArray(input.requestedCapabilities) ? input.requestedCapabilities : []),
    ...(Array.isArray(input.requested_capabilities) ? input.requested_capabilities : []),
  ];
  for (const capability of explicit) {
    const text = cleanString(capability);
    if (text) capabilities.add(text);
  }
  addCapabilityForAction(capabilities, act.action);
  addCapabilityForAction(capabilities, input.action);
  addCapabilityForAction(capabilities, context.action);
  addCapabilityForAction(capabilities, context.operation);
  return [...capabilities];
}

export function extractNoeSelfEvolutionActContext({ act = {}, input = {} } = {}) {
  const context = mergeContext(
    act.payload?.selfEvolution,
    act.payload?.self_evolution,
    input.payload?.selfEvolution,
    input.payload?.self_evolution,
    input.selfEvolution,
    input.self_evolution
  );
  const action = ACTION_BY_ACT[cleanString(act.action)] || ACTION_BY_ACT[cleanString(input.action)];
  if (!hasKeys(context) && !action) return null;
  return { ...context, action: context.action || action || 'implementation' };
}

export function hasNoeSelfEvolutionConsensusAuthorization(args = {}) {
  const { act = {}, input = {} } = args;
  const context = extractNoeSelfEvolutionActContext({ act, input });
  if (!context) return false;
  const ledgerRef = ledgerRefFromContext(context);
  if (!ledgerRef) return false;
  return isNoeConsensusAuthorizationPassed(resolveNoeSelfEvolutionConsensus({
    ...context,
    ledger: undefined,
    ledgerRef,
    root: trustedRootFromArgs(args),
  }));
}

// self-evolution standing 自授权:owner 通过 standing autonomy grant 授权 Neo 自改代码,
// standing grant 只替代 owner 的逐次 permission 审批(共识 ledger 等硬约束在 gate 层单独保留)。
// env 门控默认 OFF(NOE_SELF_EVOLUTION_STANDING_GRANT=1 才通电);scope 固定 self-evolution:run
// (= P1-3 scope 硬校验:grant 必须含此 scope 才授权);真实评估 grant 文件(非信 payload),
// 与 consensus 授权同源用 extractNoeSelfEvolutionActContext 判适用(防 regex 命中却不映射的绕过)。
export function hasNoeSelfEvolutionStandingAuthorization(args = {}) {
  if (process.env.NOE_SELF_EVOLUTION_STANDING_GRANT !== '1') return false;
  const { act = {}, input = {} } = args;
  const context = extractNoeSelfEvolutionActContext({ act, input });
  if (!context) return false;
  return evaluateStandingAutonomyGrant({ scope: 'self-evolution:run' })?.authorized === true;
}

// 触网/装包/凭据/env 内容样式（external 维事实扫描：patch operation 的 path/content 含此即视为触外部）。
const GREEN_EXTERNAL_CONTENT_RE = /\b(npm\s+install|pnpm\s+add|yarn\s+add|pip\s+install|curl|wget|fetch\s*\(|https?:\/\/|api[_-]?key|token|secret|credential|process\.env|\.env)\b/i;

// self-evolution 绿档自驱(P3.2):自改候选经 tierRisk 判 green tier(低风险)时替代 owner approval,Neo 自主
// 练手;共识 ledger/rollback/runtime/system_level/hardVetoes 等硬约束在 gate 层单独保留(与 standing 同档)。
// env 门控默认 OFF(NOE_SELF_EVOLUTION_GREEN_AUTONOMY=1 才通电)。本函数是唯一信任边界(buildGateInput 用算值覆盖自报)。
// 【安全命脉·codex 审加固】tier 输入全取【事实来源】非自报：
//   - changedFiles = patch-plan operations[].path（读文件，非 context.changedFiles 自报）
//   - touchesExternal = 扫 operation path/content 触网/装包/凭据样式（非仅自报 capability）
//   - hasOracle = runtime.reportRef 指向 root 内【真实存在】文件（非自报布尔抬 green）
//   - patchPlanRef/reportRef 必须解析在 root 内（拒绝绝对路径/.. 逃逸读 root 外任意 JSON）
//   - isProtectedPath 抛错由桥 fail-closed 当保护
//   任一不满足 / 首跑无 patchPlanRef / plan 不可读 → fail-closed 退回 owner。
// 算自改候选的绿档决策 + 风险 tier（事实来源）。返回 { greenTierApproved, tier, reason }。
//   - tier（green/yellow/red/unknown）= 纯风险判定，【不】受 NOE_SELF_EVOLUTION_GREEN_AUTONOMY flag 门控
//     → 供 P3.1 渐进审查独立复用（P3.1/P3.2 两 flag 解耦）。
//   - greenTierApproved（P3.2 授权）= flagOn && tier green → 受 GREEN_AUTONOMY flag 门控。
export function resolveGreenAutonomyDecision(args = {}) {
  const FAIL_CLOSED = { greenTierApproved: false, tier: 'unknown', reason: 'fail-closed' };
  const { act = {}, input = {} } = args;
  const context = extractNoeSelfEvolutionActContext({ act, input });
  if (!context) return FAIL_CLOSED;
  const root = trustedRootFromArgs(args);
  const rootPrefix = root.endsWith(sep) ? root : root + sep;
  const inRoot = (abs) => abs === root || abs.startsWith(rootPrefix);
  const patchPlanRef = cleanString(context.patchPlanRef || context.diffRef);
  if (!patchPlanRef) return FAIL_CLOSED; // 首跑/无事实证据 → fail-closed
  let changedFiles = [];
  let contentTouchesExternal = false;
  try {
    const abs = resolve(root, patchPlanRef);
    if (!inRoot(abs)) return FAIL_CLOSED; // patchPlanRef 逃逸 root → fail-closed
    const plan = extractNoePatchPlan(JSON.parse(readFileSync(abs, 'utf8')));
    const ops = Array.isArray(plan?.operations) ? plan.operations : [];
    changedFiles = ops.map((op) => cleanString(op?.path)).filter(Boolean);
    const blob = ops.map((op) => `${op?.path || ''} ${op?.content || ''} ${op?.from || ''} ${op?.to || ''}`).join('\n');
    contentTouchesExternal = GREEN_EXTERNAL_CONTENT_RE.test(blob); // external 事实扫描
  } catch { return FAIL_CLOSED; } // plan 不可读/路径非法 → fail-closed
  const rollback = safeObject(context.rollback);
  const hasRollback = !!(cleanString(rollback.planRef) || cleanString(rollback.snapshotRef));
  // hasOracle：runtime.ok + reportRef 指向 root 内【真实存在】文件（防自报 reportRef 抬 green）
  const runtime = safeObject(context.runtimeVerification);
  const reportRef = cleanString(runtime.reportRef);
  let hasOracle = false;
  if (runtime.ok === true && reportRef) {
    try { const oa = resolve(root, reportRef); hasOracle = inRoot(oa) && existsSync(oa); } catch { hasOracle = false; }
  }
  const capsExternal = deriveRequestedCapabilities({ act, input, context }).some((c) => /network|external|secret|system/.test(String(c)));
  const decision = decideGreenAutonomy(
    { changedFiles, hasRollback, hasOracle, touchesExternal: contentTouchesExternal || capsExternal },
    { isProtectedPath: (p) => isNoePolicyFilePath(p, { root, cwd: root }) }, // 抛错由桥 fail-closed 当保护
  );
  // flag 只门控授权（greenTierApproved），不门控 tier（风险判定供 P3.1 渐进审查独立用）。
  const flagOn = process.env.NOE_SELF_EVOLUTION_GREEN_AUTONOMY === '1';
  return { greenTierApproved: flagOn && decision.greenTierApproved === true, tier: decision.tier, reason: decision.reason };
}

// 薄 wrapper（保持 export 兼容 + P3.2 语义）：是否够格绿档自主（受 GREEN_AUTONOMY flag 门控）。
export function hasNoeSelfEvolutionGreenAutonomy(args = {}) {
  return resolveGreenAutonomyDecision(args).greenTierApproved === true;
}

function permissionApproval(permissionResult = {}) {
  return permissionResult.approval || permissionResult.permissionDecision?.approval || null;
}

function isPermissionApproved(permissionResult = {}) {
  return permissionApproval(permissionResult)?.status === 'approved';
}

export function buildNoeSelfEvolutionGateInput(args = {}) {
  const { act = {}, input = {}, permissionResult = {}, budgetResult = {} } = args;
  const context = extractNoeSelfEvolutionActContext({ act, input });
  if (!context) return null;
  const root = trustedRootFromArgs(args);

  const authorization = safeObject(context.authorization);
  const approvedByPermission = isPermissionApproved(permissionResult);
  const approvedByConsensus = hasNoeSelfEvolutionConsensusAuthorization({ act, input, root });
  const approvedByStanding = hasNoeSelfEvolutionStandingAuthorization({ act, input, root });
  const greenDecision = resolveGreenAutonomyDecision({ act, input, root });
  const approvedByGreen = greenDecision.greenTierApproved;
  const ledgerRef = ledgerRefFromContext(context);
  const approval = permissionApproval(permissionResult);
  const hardVetoes = Array.isArray(context.hardVetoes) ? context.hardVetoes.filter(Boolean) : [];
  const memory = safeObject(context.memoryWriteback);
  const consensusAuthRequested = authorization.consensusApproved === true || memory.consensusAck === true || memory.autoWrite === true;
  if (consensusAuthRequested && !ledgerRef) {
    hardVetoes.push('consensus_authorization_requires_ledger_ref');
  }
  if (context.ledger && typeof context.ledger === 'object' && !Array.isArray(context.ledger) && !ledgerRef) {
    hardVetoes.push('ledger_ref_required_for_execution_authorization');
  }
  if (authorization.userApproved === true && !approvedByPermission) {
    hardVetoes.push('payload_user_approval_ignored');
  }
  if (authorization.greenTierApproved === true && !approvedByGreen) {
    hardVetoes.push('payload_green_tier_approval_ignored'); // 自报 green 但事实不达标 → 否决（防 payload 操纵）
  }
  if (context.reviewTier !== undefined) {
    hardVetoes.push('payload_review_tier_ignored'); // P3.1：自报 reviewTier 一律否决，只认 ActGuard 算值（防自报放松审查）
  }
  if (budgetResult.ok === false) hardVetoes.push('budget_not_approved');
  if (permissionResult.blockedSafety || permissionResult.decision === 'deny') hardVetoes.push('permission_denied');
  if (permissionResult.requiresApproval || permissionResult.decision === 'ask') hardVetoes.push('permission_approval_pending');

  // P3.1 渐进审查档（flag NOE_SELF_EVOLUTION_REVIEW_TIER 默认 OFF=逐次全审）。completedCount 取 CycleStore 真
  //   count（事实，非自报，防 reward hacking 抬档）；riskTier 复用 green decision tier（非 green 全当高危不放松）；
  //   autoFlagged=有任何 hardVeto。flag OFF / 任一非 green → requirePostReview:true（零回归）。countCompleted 可 DI（测试）。
  const reviewCfg = resolveReviewTierConfig(process.env);
  let reviewTier = { tier: 'full', requirePostReview: true, reason: 'flag_off_or_default' };
  if (reviewCfg.enabled) {
    let completedCount = 0;
    try {
      completedCount = typeof args.countCompleted === 'function'
        ? Number(args.countCompleted()) || 0
        : new NoeSelfEvolutionCycleStore().countComplete({});
    } catch { completedCount = 0; }
    reviewTier = resolveReviewTier(
      { completedCount, riskTier: greenDecision.tier === 'green' ? 'green' : 'yellow', autoFlagged: hardVetoes.length > 0 },
      reviewCfg,
    );
  }

  return {
    ...context,
    ledger: undefined,
    ledgerRef: ledgerRef || context.ledgerRef,
    root,
    authorization: {
      ...authorization,
      userApproved: approvedByPermission,
      consensusApproved: approvedByConsensus,
      standingApproved: approvedByStanding,
      greenTierApproved: approvedByGreen,
      scope: approvedByStanding
        ? 'self-evolution:run'
        : cleanString(authorization.scope || context.scope || approval?.payload?.title || act.title),
      costClass: cleanString(
        authorization.costClass ||
        context.costClass ||
        input.costClass ||
        (Number(act.costEstimateUsd) > 0 ? 'budgeted_owner_approved' : 'local_or_user_approved_model_calls')
      ),
    },
    requestedCapabilities: deriveRequestedCapabilities({ act, input, context }),
    reviewTier, // P3.1 算值覆盖自报（...context 在前 → 自报 reviewTier 被冲掉），Gate 只读此
    hardVetoes,
  };
}

export function evaluateNoeSelfEvolutionActGuard(args = {}) {
  const gateInput = buildNoeSelfEvolutionGateInput(args);
  if (!gateInput) return { applies: false, ok: true, gate: null, gateInput: null };
  const gate = evaluateNoeSelfEvolutionGate(gateInput);
  return {
    applies: true,
    ok: gate.ok,
    gate,
    gateInput,
    error: gate.ok ? '' : `self_evolution_gate_blocked:${gate.errors.join(',')}`,
  };
}
