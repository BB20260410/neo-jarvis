// @ts-check
/**
 * Third-party plugin policy — fail closed without OS sandbox.
 *
 * Hard rules (surpass contract S7):
 * - No main-process dynamic import of untrusted packages
 * - No new Function / eval tool marketplace
 * - No regex-as-sandbox
 * - Independent Plugin Host + typed IPC + Permission Broker required
 * - Without OS sandbox → refuse load (fail closed)
 */
export const PLUGIN_HOST_POLICY_VERSION = 1;

/**
 * @param {object} request
 * @param {boolean} [request.osSandboxAvailable]
 * @param {boolean} [request.pluginHostIsolated]
 * @param {boolean} [request.typedIpc]
 * @param {boolean} [request.permissionBroker]
 * @param {boolean} [request.mainProcessDynamicImport]
 * @param {boolean} [request.usesNewFunction]
 * @param {boolean} [request.regexSandboxOnly]
 * @param {string} [request.trustLevel] 'trusted_builtin' | 'third_party'
 */
export function evaluatePluginLoad(request = {}) {
  const trust = String(request.trustLevel || 'third_party');
  const blockers = [];

  if (request.mainProcessDynamicImport === true && trust !== 'trusted_builtin') {
    blockers.push('main_process_dynamic_import_forbidden');
  }
  if (request.usesNewFunction === true) {
    blockers.push('new_function_eval_forbidden');
  }
  if (request.regexSandboxOnly === true) {
    blockers.push('regex_pseudo_sandbox_forbidden');
  }

  if (trust === 'third_party') {
    if (request.pluginHostIsolated !== true) blockers.push('plugin_host_not_isolated');
    if (request.typedIpc !== true) blockers.push('typed_ipc_required');
    if (request.permissionBroker !== true) blockers.push('permission_broker_required');
    if (request.osSandboxAvailable !== true) blockers.push('os_sandbox_required_fail_closed');
  }

  const allowed = blockers.length === 0;
  return {
    version: PLUGIN_HOST_POLICY_VERSION,
    allowed,
    blockers,
    defaultCapabilities: allowed
      ? { fs: false, env: false, net: false, process: false, keychain: false }
      : null,
    failClosed: !allowed,
    note: allowed
      ? 'load_permitted_under_host_broker_sandbox'
      : 'third_party_plugin_load_denied',
  };
}

/**
 * Detect unsafe patterns in plugin installer/config text (static audit).
 * @param {string} sourceText
 */
export function auditPluginSourceText(sourceText = '') {
  const text = String(sourceText || '');
  const findings = [];
  if (/\bnew\s+Function\b/.test(text)) {
    findings.push({ severity: 'error', id: 'new_function', message: 'new Function detected' });
  }
  if (/\beval\s*\(/.test(text)) {
    findings.push({ severity: 'error', id: 'eval', message: 'eval detected' });
  }
  if (/import\s*\(\s*[^'"`]/.test(text) && /plugin|marketplace|untrusted/i.test(text)) {
    findings.push({ severity: 'warn', id: 'dynamic_import', message: 'dynamic import near plugin paths' });
  }
  if (/sandbox/.test(text) && /RegExp|regex/.test(text) && !/seatbelt|sandbox-exec|bubblewrap|landlock/i.test(text)) {
    findings.push({ severity: 'warn', id: 'regex_sandbox', message: 'possible regex-only sandbox claim' });
  }
  return {
    ok: !findings.some((f) => f.severity === 'error'),
    findings,
  };
}
