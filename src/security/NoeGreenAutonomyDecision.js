// @ts-check
// NoeGreenAutonomyDecision — P3.2 绿档自驱决策（self-evolution 信任校准）。
//
// 痛点：现状自改任何动作都需 owner/consensus/standing 授权。P3.2 让「低风险（green tier）」自改
//   可省 owner approval、Neo 自主练手——但绝不豁免任何硬约束（consensus ledger / rollback / runtime /
//   system_level / hardVetoes 全保留，由 Gate 独立判）。
//
// 【安全命脉】changedFiles 必须来自【事实来源】（patch-plan 文件的 operations[].path），绝不能来自候选
//   自报字段——否则候选可自报小文件列表伪装 green，而 executor 实改任意文件，绕过 owner。本桥是【纯逻辑】：
//   只吃调用方（ActGuard，唯一信任边界）从事实 plan 提取并传入的 changedFiles，桥本身不读自报、不碰 payload。
//   首跑 implementation patch 未产 → 调用方传空 changedFiles → 本桥 fail-closed 返回 false（退回 owner）。

import { tierRisk, isGreenTier } from './NoeRiskTiering.js';

/**
 * 判定一个自改候选是否够「绿档自主」（green tier → 省 owner approval）。
 * @param {object} input
 * @param {string[]} [input.changedFiles] 改动文件（【必须是事实来源】patch-plan operations[].path，由 ActGuard 提供）
 * @param {boolean} [input.hasRollback] cycle 是否有 rollback 锚（reversible 维；缺=yellow=不自主）
 * @param {boolean} [input.hasOracle] 是否有独立 runtime 验证 oracle（semantic 维；缺=yellow=不自主）
 * @param {boolean} [input.touchesExternal] 是否触外部依赖（external 维；触=red=不自主；【算出非自报】）
 * @param {object} [deps]
 * @param {(p:string)=>boolean} [deps.isProtectedPath] 保护路径判定（注入 isNoePolicyFilePath 包一层）
 * @returns {{ greenTierApproved:boolean, tier:string, reason:string }}
 */
export function decideGreenAutonomy({ changedFiles = [], hasRollback = false, hasOracle = false, touchesExternal = false } = {}, { isProtectedPath = () => false } = {}) {
  const files = Array.isArray(changedFiles) ? changedFiles.filter(Boolean).map(String) : [];
  // fail-closed：无事实改动文件（首跑 patch 未产 / plan 不可读）→ 不自主，退回 owner/consensus。
  if (files.length === 0) {
    return { greenTierApproved: false, tier: 'unknown', reason: 'no_changed_files（首跑或无事实证据，fail-closed 退回 owner）' };
  }
  // fail-closed（codex 审）：保护路径判定器抛错 → 当【保护】(red)，绝不当非保护，防 fail-open 给出 green。
  const safeIsProtected = (p) => { try { return isProtectedPath(p); } catch { return true; } };
  const result = tierRisk(
    {
      changedFiles: files,
      rollbackRef: hasRollback ? 'present' : null, // reversible 维：有 rollback 锚才 green
      hasOracle: hasOracle === true,               // semantic 维：有独立 oracle 才 green
      touchesExternal: touchesExternal === true,   // external 维：触外部=red
    },
    { isProtectedPath: safeIsProtected },
  );
  return {
    greenTierApproved: isGreenTier(result),
    tier: result.tier,
    reason: Array.isArray(result.reasons) ? result.reasons.join('; ') : '',
  };
}
