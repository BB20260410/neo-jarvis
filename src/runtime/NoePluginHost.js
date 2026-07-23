// @ts-check
/**
 * Independent Plugin Host — fail-closed without OS sandbox.
 * Never dynamically imports untrusted code into the main process.
 */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { platform } from 'node:os';
import {
  evaluatePluginLoad,
  auditPluginSourceText,
  PLUGIN_HOST_POLICY_VERSION,
} from './NoePluginHostPolicy.js';

export const PLUGIN_HOST_SCHEMA_VERSION = 1;

/**
 * Probe whether an OS-level sandbox binary is available.
 * macOS: sandbox-exec; Linux: bubblewrap optional later.
 * @param {{ platform?: string, which?: (bin:string)=>string|null, run?: Function }} [deps]
 */
export function detectOsSandbox(deps = {}) {
  const plat = deps.platform || platform();
  const which = deps.which || ((bin) => {
    const r = spawnSync('which', [bin], { encoding: 'utf8' });
    return r.status === 0 ? String(r.stdout || '').trim() : null;
  });
  const run = deps.run || ((cmd, args) => spawnSync(cmd, args, { encoding: 'utf8' }));

  if (plat === 'darwin') {
    const bin = which('sandbox-exec');
    if (!bin) {
      return { available: false, engine: null, reason: 'sandbox-exec_missing' };
    }
    const probe = run(bin, ['-n', 'no-network', '/bin/echo', 'noe-sandbox-ok']);
    const ok = probe.status === 0 && String(probe.stdout || '').includes('noe-sandbox-ok');
    return {
      available: ok,
      engine: 'sandbox-exec',
      path: bin,
      reason: ok ? 'sandbox-exec_probe_ok' : 'sandbox-exec_probe_failed',
    };
  }
  if (plat === 'linux') {
    const bin = which('bwrap');
    return {
      available: !!bin,
      engine: bin ? 'bubblewrap' : null,
      path: bin,
      reason: bin ? 'bwrap_present' : 'bwrap_missing',
    };
  }
  return { available: false, engine: null, reason: `unsupported_platform_${plat}` };
}

/**
 * Permission broker: default deny all dangerous caps.
 * @param {object} [request]
 * @param {string[]} [request.requested]
 * @param {string[]} [request.granted]
 */
export function permissionBrokerDecide(request = {}) {
  const requested = Array.isArray(request.requested) ? request.requested : [];
  const granted = Array.isArray(request.granted) ? request.granted : [];
  const dangerous = new Set(['fs', 'env', 'net', 'process', 'keychain', 'shell']);
  const allowed = [];
  const denied = [];
  for (const cap of requested) {
    if (dangerous.has(cap) && !granted.includes(cap)) denied.push(cap);
    else if (granted.includes(cap)) allowed.push(cap);
    else denied.push(cap);
  }
  return {
    allowed,
    denied,
    defaultDeny: true,
    ok: denied.length === 0 || allowed.length > 0 && requested.every((c) => allowed.includes(c) || denied.includes(c)),
  };
}

/**
 * Typed IPC message envelope (host ↔ plugin).
 * @param {object} msg
 */
export function encodePluginIpcMessage(msg = {}) {
  const type = String(msg.type || 'unknown');
  const payload = msg.payload == null ? {} : msg.payload;
  if (typeof payload === 'function') {
    throw new Error('ipc_payload_must_be_jsonable');
  }
  let encoded;
  try {
    encoded = JSON.stringify(payload, (_k, v) => {
      if (typeof v === 'function') {
        throw new Error('ipc_payload_must_be_jsonable');
      }
      return v;
    });
  } catch (e) {
    throw new Error('ipc_payload_must_be_jsonable');
  }
  return {
    v: 1,
    type,
    id: String(msg.id || `ipc_${Date.now()}`),
    payload: JSON.parse(encoded),
  };
}

/**
 * Attempt to load a third-party plugin — fail closed by default.
 * @param {object} plugin
 * @param {object} [opts]
 */
export function loadThirdPartyPlugin(plugin = {}, opts = {}) {
  const sandbox = opts.osSandbox || detectOsSandbox(opts.sandboxDeps || {});
  const broker = permissionBrokerDecide({
    requested: plugin.requestedCapabilities || ['net'],
    granted: plugin.grantedCapabilities || [],
  });

  // Static audit of source if provided
  if (plugin.sourceText) {
    const audit = auditPluginSourceText(plugin.sourceText);
    if (!audit.ok) {
      return {
        loaded: false,
        failClosed: true,
        reason: 'static_audit_failed',
        audit,
        decision: null,
      };
    }
  }

  // Hard forbid main-process import path
  if (opts.mainProcessImport === true || plugin.mainProcessImport === true) {
    return {
      loaded: false,
      failClosed: true,
      reason: 'main_process_import_forbidden',
      decision: evaluatePluginLoad({
        trustLevel: 'third_party',
        mainProcessDynamicImport: true,
        osSandboxAvailable: sandbox.available,
        pluginHostIsolated: true,
        typedIpc: true,
        permissionBroker: true,
      }),
    };
  }

  const decision = evaluatePluginLoad({
    trustLevel: plugin.trustLevel || 'third_party',
    osSandboxAvailable: sandbox.available === true,
    pluginHostIsolated: opts.pluginHostIsolated !== false,
    typedIpc: opts.typedIpc !== false,
    permissionBroker: opts.permissionBroker !== false,
    mainProcessDynamicImport: false,
    usesNewFunction: plugin.usesNewFunction === true,
    regexSandboxOnly: plugin.regexSandboxOnly === true,
  });

  if (!decision.allowed) {
    return {
      loaded: false,
      failClosed: true,
      reason: 'policy_denied',
      decision,
      sandbox,
      broker,
    };
  }

  // Even when allowed, do not execute untrusted code here — only return a host plan.
  return {
    loaded: true,
    failClosed: false,
    reason: 'host_plan_ready',
    decision,
    sandbox,
    broker,
    hostPlan: {
      mode: 'child_process_os_sandbox',
      engine: sandbox.engine,
      ipc: 'typed_json_v1',
      entry: plugin.entry || null,
      capabilities: decision.defaultCapabilities,
    },
  };
}

/**
 * Refuse to require() untrusted plugin path in main process.
 * @param {string} modulePath
 */
export function refuseMainProcessPluginRequire(modulePath) {
  return {
    ok: false,
    refused: true,
    modulePath: String(modulePath || ''),
    reason: 'third_party_plugins_must_use_plugin_host',
    policyVersion: PLUGIN_HOST_POLICY_VERSION,
  };
}
