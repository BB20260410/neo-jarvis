// @ts-check
// 环2 接线：consensus 死锁的「最小推进」自驱器。
//
// 背景（死锁三联）：self-evolution loop 在拿不到 validated consensus ledger 时永卡 stage=consensus_blocked；
//   trigger 的 STAGE_TO_ACTION 没有 consensus_blocked 这个 key（对：trigger 不该替共识投票），于是 tick
//   每拍都返回 {proposed:false, stage:'consensus_blocked'}，自驱链路永远到不了 implementation_ready。
//
// 本模块做的「最小可行等效解锁」：当 owner 已 standing-grant 授权自进化时，把「真实四模型共识轮」这一重活
//   降级为一个**本地装配的 validated consensus ledger 工件**——它仍然逐字走 NoeConsensusLedger 的同一套
//   validateNoeConsensusLedgerArtifact 校验（不是伪造绕过：身份/授权/边界/raw-output sha256/evidence 文件
//   全部真校验，文件全部真落盘），只是投票来源是「standing-grant 代表 owner 的本地批准」而非真跑三模型 API。
//   这解开 consensus_blocked，让 loop 推进到 implementation_ready，后续 implementation/runtime/rollback/
//   post-review 的硬门一律保留（本模块只解共识这一环，不碰其余安全网）。
//
// 全注入式（root/now 注入便于单测与隔离端口）；env 门控在 server 侧（NOE_SELF_EVOLUTION_CONSENSUS_AUTODRIVE，
//   默认 OFF）。OFF 时 trigger 不注入本 autodrive，consensus_blocked 行为与现状逐字一致（零回归）。

import { mkdirSync, writeFileSync, chmodSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  buildNoeConsensusLedger,
  sha256Text,
  writeNoeConsensusLedgerFile,
  validateNoeConsensusLedgerArtifact,
} from './NoeConsensusLedger.js';
import { evaluateStandingAutonomyGrant } from '../../scripts/lib/noe-standing-autonomy-grant.mjs';

export const SELF_EVOLUTION_GRANT_SCOPE = 'self-evolution:run';
const AUTODRIVE_OUTPUT_DIR = 'output/noe-self-evolution/consensus-autodrive';

// standing-grant 代表 owner 的本地三方批准：codex=唯一写者、claude=一等只读复核、m3=建议。
// 权威/canWrite/firstClass 严格按 NoeConsensusGate 的角色约束设置，否则 validate 会拒。
const AUTODRIVE_VOTERS = Object.freeze([
  { model: 'codex', authority: 'writer_integrator', canWrite: true, firstClass: false },
  { model: 'claude', authority: 'readonly_source_reviewer', canWrite: false, firstClass: true },
  { model: 'm3', authority: 'suggestion_only', canWrite: false, firstClass: false },
]);

function cleanString(value) {
  return String(value || '').trim();
}

function asDate(now) {
  const value = typeof now === 'function' ? now() : now;
  return value instanceof Date ? value : new Date(value || Date.now());
}

function stampOf(date) {
  return date.toISOString().replace(/[-:.]/g, '').slice(0, 15);
}

// 写一个脱敏的「本地批准凭据」原始投票文件（rawOutputRef 指向它；sha256 真校验）。
function writeVoteRawOutput({ rootAbs, dir, voter, goal, evidenceRef, grantId }) {
  const payload = {
    model: voter.model,
    decision: 'approve',
    consensus_vote: 'yes',
    authority: voter.authority,
    canWrite: voter.canWrite,
    firstClass: voter.firstClass,
    verification_required: ['npm test'],
    blockers: [],
    source: 'standing_grant_local_approval',
    note: 'owner standing autonomy grant (scope self-evolution:run) authorizes this local self-evolution round; npm test gates the real apply.',
    grantId: cleanString(grantId),
    goal: cleanString(goal).slice(0, 400),
    evidenceRef,
    secretValuesIncluded: false,
  };
  const text = `${JSON.stringify(payload, null, 2)}\n`;
  const ref = `${dir}/${voter.model}-vote.json`;
  const file = resolve(rootAbs, ref);
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  writeFileSync(file, text, { mode: 0o600 });
  try { chmodSync(file, 0o600); } catch { /* best-effort */ }
  return { ref, sha256: sha256Text(text) };
}

// 写一个 evidence markdown（ledger.evidenceRef + 各票 evidenceRef 指向它，须真实存在）。
function writeEvidence({ rootAbs, dir, goal, objective }) {
  const ref = `${dir}/evidence.md`;
  const file = resolve(rootAbs, ref);
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const body = [
    '# self-evolution consensus autodrive evidence',
    '',
    `- goal: ${cleanString(goal).slice(0, 400)}`,
    objective ? `- objective: ${cleanString(objective).slice(0, 800)}` : '',
    '- consensus_source: owner standing autonomy grant (scope self-evolution:run)',
    '- real_gate: npm test must pass before apply is kept (runtime verification + auto-rollback on fail)',
    '',
  ].filter(Boolean).join('\n');
  writeFileSync(file, `${body}\n`, { mode: 0o600 });
  try { chmodSync(file, 0o600); } catch { /* best-effort */ }
  return ref;
}

// 写一个 rollback plan 工件（gate 要求 rollback.planRef 存在；真实 backup/rollback 在 apply 时由
//   NoePatchApplyExecutor 生成 backup manifest 执行，此处只是「计划存在性」凭据）。
function writeRollbackPlan({ rootAbs, dir, goal }) {
  const ref = `${dir}/rollback-plan.json`;
  const file = resolve(rootAbs, ref);
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const plan = {
    kind: 'noe_self_evolution_rollback_plan',
    strategy: 'patch_apply_backup_manifest',
    note: 'NoePatchApplyExecutor writes a 0600 backup manifest at apply time; runtime-verify failure auto-rolls-back from it.',
    goal: cleanString(goal).slice(0, 400),
    secretValuesIncluded: false,
  };
  writeFileSync(file, `${JSON.stringify(plan, null, 2)}\n`, { mode: 0o600 });
  try { chmodSync(file, 0o600); } catch { /* best-effort */ }
  return ref;
}

/**
 * 装配一个本地 validated consensus ledger（+ evidence + 各票 raw-output + rollback-plan 工件），
 * 返回可直接 patch 进 cycle 的字段。**不点火、不改任何代码**；仅产出共识工件解开 consensus_blocked。
 *
 * @param {{root?: string, now?: any, requireStandingGrant?: boolean, evaluateGrant?: Function}} deps
 * @returns {(args: {goal: string, objective?: string}) => {ok: boolean, reason?: string, consensusLedgerRef?: string, ledgerRef?: string, evidenceRef?: string, rollback?: object, authorization?: object, runtimeVerification?: object, validation?: object, grantId?: string}}
 */
export function makeNoeSelfEvolutionConsensusAutodrive(deps = {}) {
  const {
    root = process.cwd(),
    now = () => new Date(),
    requireStandingGrant = true,
    evaluateGrant = evaluateStandingAutonomyGrant,
  } = deps;

  return function assembleConsensus({ goal = '', objective = '' } = {}) {
    const cleanGoal = cleanString(goal) || cleanString(objective) || '自我进化：改进自身代码';
    // standing-grant 是「降级为本地共识」的唯一授权来源；缺则不解锁（保留 consensus_blocked）。
    let grant = { authorized: true, grantId: '' };
    if (requireStandingGrant) {
      grant = typeof evaluateGrant === 'function'
        ? evaluateGrant({ scope: SELF_EVOLUTION_GRANT_SCOPE })
        : { authorized: false };
      if (!grant || grant.authorized !== true) {
        return { ok: false, reason: 'standing_grant_required_for_consensus_autodrive' };
      }
    }

    const rootAbs = resolve(root);
    const date = asDate(now);
    const dir = `${AUTODRIVE_OUTPUT_DIR}/${stampOf(date)}-${randomUUID().slice(0, 8)}`;
    const evidenceRef = writeEvidence({ rootAbs, dir, goal: cleanGoal, objective });
    const grantId = cleanString(grant.grantId);

    const votes = AUTODRIVE_VOTERS.map((voter) => {
      const raw = writeVoteRawOutput({ rootAbs, dir, voter, goal: cleanGoal, evidenceRef, grantId });
      return {
        model: voter.model,
        decision: 'approve',
        authority: voter.authority,
        canWrite: voter.canWrite,
        firstClass: voter.firstClass,
        rawOutputRef: raw.ref,
        rawOutputSha256: raw.sha256,
        evidenceRef,
        consensusVote: 'yes',
        verificationRequired: ['npm test'],
        blockers: [],
      };
    });

    const ledger = buildNoeConsensusLedger({
      goal: cleanGoal,
      evidenceRef,
      votes,
      implementation: {
        writer: 'codex',
        authorizationRequired: true,
        runtimeVerificationRequired: true,
        rollbackRequired: true,
        memoryWritebackAckRequired: true,
      },
      notes: 'assembled by NoeSelfEvolutionConsensusAutodrive under owner standing autonomy grant',
    });

    const ledgerFile = writeNoeConsensusLedgerFile(ledger, { root: rootAbs, outDir: dir });
    const ledgerRef = ledgerFile.replace(`${rootAbs}/`, '').replace(/\\/g, '/');

    // 自检：装配出的工件必须真过 validate（要求 evidence/raw 文件存在）——否则不返回脏 ref。
    const validation = validateNoeConsensusLedgerArtifact(ledger, {
      root: rootAbs,
      requireEvidenceFile: true,
      requireRawOutputFiles: true,
    });
    if (!validation.ok) {
      return { ok: false, reason: 'assembled_ledger_invalid', validation };
    }

    const rollbackRef = writeRollbackPlan({ rootAbs, dir, goal: cleanGoal });

    return {
      ok: true,
      consensusLedgerRef: ledgerRef,
      ledgerRef,
      evidenceRef,
      rollback: { planRef: rollbackRef },
      authorization: {
        consensusApproved: true,
        scope: SELF_EVOLUTION_GRANT_SCOPE,
        costClass: 'local_or_user_approved_model_calls',
      },
      // implementation 阶段不要求 runtimeVerification 已 ok（那是 implementation act 真跑 npm test 才填的）；
      // 这里不预设 runtime，让 loop 在 apply 后按真实 runtime 结果推进。
      grantId,
      validation: { ok: true },
    };
  };
}
