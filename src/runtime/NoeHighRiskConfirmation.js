// @ts-check
/**
 * High-risk action confirmation accuracy (G-SAFE-01).
 * Pure policy: dangerous acts require explicit owner approval before execute.
 */
export const HIGH_RISK_CONFIRMATION_VERSION = 1;

const DEFAULT_HIGH_RISK = Object.freeze([
  'shell_write',
  'fs_delete',
  'fs_write_system',
  'net_exfil',
  'credential_read',
  'plugin_install_third_party',
  'git_push',
  'payment',
]);

/**
 * @param {string} actionType
 * @param {readonly string[]} [highRiskTypes]
 */
export function isHighRiskAction(actionType, highRiskTypes = DEFAULT_HIGH_RISK) {
  return highRiskTypes.includes(String(actionType || ''));
}

/**
 * Decide whether an act may execute given confirmation state.
 * @param {object} act
 * @param {string} act.actionType
 * @param {boolean} [act.ownerConfirmed]
 * @param {boolean} [act.dryRun]
 * @param {string} [act.confirmationToken]
 * @param {string} [act.expectedToken]
 */
export function evaluateHighRiskConfirmation(act = { actionType: '' }) {
  const high = isHighRiskAction(act.actionType);
  if (!high) {
    return {
      allowed: true,
      highRisk: false,
      reason: 'not_high_risk',
      version: HIGH_RISK_CONFIRMATION_VERSION,
    };
  }
  if (act.dryRun === true) {
    return {
      allowed: true,
      highRisk: true,
      reason: 'dry_run_allowed_without_confirm',
      version: HIGH_RISK_CONFIRMATION_VERSION,
    };
  }
  if (act.ownerConfirmed !== true) {
    return {
      allowed: false,
      highRisk: true,
      reason: 'owner_confirmation_required',
      version: HIGH_RISK_CONFIRMATION_VERSION,
    };
  }
  if (act.expectedToken && act.confirmationToken !== act.expectedToken) {
    return {
      allowed: false,
      highRisk: true,
      reason: 'confirmation_token_mismatch',
      version: HIGH_RISK_CONFIRMATION_VERSION,
    };
  }
  return {
    allowed: true,
    highRisk: true,
    reason: 'owner_confirmed',
    version: HIGH_RISK_CONFIRMATION_VERSION,
  };
}

/**
 * Score confirmation accuracy over a suite of cases.
 * accuracy = correct decisions / total
 * A correct decision matches whether execute should have been allowed.
 * @param {Array<{act: object, expectedAllow: boolean}>} cases
 */
export function scoreHighRiskConfirmationAccuracy(cases = []) {
  let correct = 0;
  const details = [];
  for (const c of cases) {
    const d = evaluateHighRiskConfirmation(c.act || {});
    const ok = d.allowed === !!c.expectedAllow;
    if (ok) correct += 1;
    details.push({
      actionType: c.act?.actionType,
      expectedAllow: c.expectedAllow,
      actualAllow: d.allowed,
      reason: d.reason,
      ok,
    });
  }
  const total = cases.length;
  return {
    highRiskConfirmationAccuracy: total ? correct / total : null,
    correct,
    total,
    details,
    ok: total > 0 && correct === total,
  };
}

/**
 * Built-in standard suite for G-SAFE-01.
 */
export function standardHighRiskConfirmationSuite() {
  return [
    { act: { actionType: 'read_file', ownerConfirmed: false }, expectedAllow: true },
    { act: { actionType: 'shell_write', ownerConfirmed: false }, expectedAllow: false },
    { act: { actionType: 'shell_write', ownerConfirmed: true, confirmationToken: 'a', expectedToken: 'a' }, expectedAllow: true },
    { act: { actionType: 'shell_write', ownerConfirmed: true, confirmationToken: 'a', expectedToken: 'b' }, expectedAllow: false },
    { act: { actionType: 'fs_delete', dryRun: true, ownerConfirmed: false }, expectedAllow: true },
    { act: { actionType: 'git_push', ownerConfirmed: false }, expectedAllow: false },
    { act: { actionType: 'git_push', ownerConfirmed: true }, expectedAllow: true },
    { act: { actionType: 'plugin_install_third_party', ownerConfirmed: false }, expectedAllow: false },
    { act: { actionType: 'payment', ownerConfirmed: true }, expectedAllow: true },
    { act: { actionType: 'credential_read', ownerConfirmed: false }, expectedAllow: false },
  ];
}
