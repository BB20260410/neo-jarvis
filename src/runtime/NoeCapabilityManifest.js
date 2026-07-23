// @ts-check
/**
 * Single capability truth source for Neo product gates.
 * Status vocabulary (fail-closed product claims):
 *   verified | degraded | shadow | disabled | missing
 *
 * "Module exists" or "test passes" alone never yields verified —
 * verified requires bound runtime evidence with sourceDigest.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';

/** @typedef {'verified'|'degraded'|'shadow'|'disabled'|'missing'} CapabilityStatus */

export const CAPABILITY_STATUSES = /** @type {const} */ ([
  'verified',
  'degraded',
  'shadow',
  'disabled',
  'missing',
]);

export const CAPABILITY_MANIFEST_SCHEMA_VERSION = 1;

/**
 * Twelve product dimensions from the surpass contract.
 */
export const PRODUCT_DIMENSION_IDS = [
  'install_onboarding',
  'default_task_loop',
  'browser',
  'voice',
  'memory',
  'multi_agent',
  'evidence_truth',
  'recovery_stability',
  'permission_security',
  'resource_use',
  'packaging_update',
  'docs_extensibility',
];

/**
 * @param {string} status
 * @returns {status is CapabilityStatus}
 */
export function isCapabilityStatus(status) {
  return CAPABILITY_STATUSES.includes(/** @type {CapabilityStatus} */ (status));
}

/**
 * @param {CapabilityStatus} status
 * @returns {boolean}
 */
export function isProductClaimable(status) {
  return status === 'verified';
}

/**
 * Fail-closed: only verified with evidence digests may count as product complete.
 * @param {{ status: string, evidence?: unknown[], sourceDigest?: string|null }} entry
 */
export function assertNotStaticComplete(entry) {
  if (!entry || typeof entry !== 'object') return { ok: false, reason: 'missing_entry' };
  if (entry.status === 'verified') {
    const evidence = Array.isArray(entry.evidence) ? entry.evidence : [];
    if (evidence.length === 0) {
      return { ok: false, reason: 'verified_without_evidence' };
    }
    if (!entry.sourceDigest) {
      return { ok: false, reason: 'verified_without_sourceDigest' };
    }
  }
  return { ok: true, reason: null };
}

/**
 * Probe Neo repository for capability surfaces (structural only → shadow/missing/degraded).
 * Does NOT claim verified.
 * @param {object} [opts]
 * @param {string} [opts.rootDir]
 * @param {Record<string, boolean>} [opts.runtimeFlags]
 * @param {Array<{id:string,status:CapabilityStatus,evidence?:unknown[],sourceDigest?:string}>} [opts.evidenceOverrides]
 */
export function buildCapabilityManifest(opts = {}) {
  const root = opts.rootDir || process.cwd();
  const flags = opts.runtimeFlags || {};
  const overrides = new Map((opts.evidenceOverrides || []).map((e) => [e.id, e]));

  /**
   * @param {string} rel
   */
  const has = (rel) => existsSync(join(root, rel));

  /** @type {Array<{id:string, dimension:string, title:string, status:CapabilityStatus, sources:string[], notes:string, evidence:unknown[], sourceDigest:string|null}>} */
  const capabilities = [
    {
      id: 'cap.unified_task_store',
      dimension: 'default_task_loop',
      title: 'UnifiedTaskStore final-state owner',
      status: has('src/loop/ActStore.js') ? 'shadow' : 'missing',
      sources: ['src/loop/ActStore.js', 'src/agents/AgentRunStore.js'],
      notes: 'Task truth still split across Act/AgentRun/TaskFlow/Room; UnifiedTaskStore not productized',
      evidence: [],
      sourceDigest: null,
    },
    {
      id: 'cap.agent_runtime_orchestrator',
      dimension: 'default_task_loop',
      title: 'AgentRuntime thin orchestrator',
      status: has('src/autopilot/AutopilotStore.js') ? 'shadow' : 'missing',
      sources: ['src/autopilot/AutopilotStore.js'],
      notes: 'Autopilot exists; unified AgentRuntime orchestration layer not yet the default front door',
      evidence: [],
      sourceDigest: null,
    },
    {
      id: 'cap.isolation_db_policy',
      dimension: 'recovery_stability',
      title: 'Isolation DB policy for non-live ports',
      status: has('src/runtime/NoeIsolationDbPolicy.js') ? 'degraded' : 'missing',
      sources: ['src/runtime/NoeIsolationDbPolicy.js', 'tests/unit/noe-wave1-ops-hygiene.test.js'],
      notes: 'Unit-verified; live soak and supervisor alignment still open',
      evidence: [],
      sourceDigest: null,
    },
    {
      id: 'cap.dual_writer_guard',
      dimension: 'recovery_stability',
      title: 'Dual writer detection in Doctor',
      status: has('src/runtime/NoeDualWriterGuard.js') ? 'degraded' : 'missing',
      sources: ['src/runtime/NoeDualWriterGuard.js', 'src/runtime/NoeDoctor.js'],
      notes: 'Module + Doctor import present; continuous process registry soak pending',
      evidence: [],
      sourceDigest: null,
    },
    {
      id: 'cap.launchd_label',
      dimension: 'recovery_stability',
      title: 'Canonical launchd label resolution',
      status: has('src/runtime/NoeLaunchdLabel.js') ? 'degraded' : 'missing',
      sources: ['src/runtime/NoeLaunchdLabel.js', 'scripts/restart-panel.mjs'],
      notes: 'Label logic unit-tested; live may still run outside launchctl',
      evidence: [],
      sourceDigest: null,
    },
    {
      id: 'cap.backlog_expiry',
      dimension: 'evidence_truth',
      title: 'Approval/Act soft expiry with audit retain',
      status: has('src/approval/NoeBacklogExpiry.js') ? 'degraded' : 'missing',
      sources: ['src/approval/NoeBacklogExpiry.js'],
      notes: 'Unit-tested dryRun/apply; live backlog reconcile pending',
      evidence: [],
      sourceDigest: null,
    },
    {
      id: 'cap.browser_loop',
      dimension: 'browser',
      title: 'Browser research/action product loop',
      status: has('src') ? 'shadow' : 'missing',
      sources: [],
      notes: 'Browser capability surfaces may exist; product E2E VTCR not yet bound',
      evidence: [],
      sourceDigest: null,
    },
    {
      id: 'cap.voice_loop',
      dimension: 'voice',
      title: 'Chinese voice dispatch/approve loop',
      status: 'shadow',
      sources: [],
      notes: 'Not verified by standard voice task suite under current sourceDigest',
      evidence: [],
      sourceDigest: null,
    },
    {
      id: 'cap.memory_loop',
      dimension: 'memory',
      title: 'Memory recall/precision product loop',
      status: has('src/memory') ? 'shadow' : 'missing',
      sources: ['src/memory'],
      notes: 'Memory modules exist; standard set recall/precision gates pending',
      evidence: [],
      sourceDigest: null,
    },
    {
      id: 'cap.plugin_host_sandbox',
      dimension: 'permission_security',
      title: 'Third-party Plugin Host + OS sandbox',
      status: 'missing',
      sources: [],
      notes: 'Current installer/home-tree is not OS sandbox; fail-closed required',
      evidence: [],
      sourceDigest: null,
    },
    {
      id: 'cap.desktop_packaging',
      dimension: 'packaging_update',
      title: 'Signed/notarized desktop package + update/rollback',
      status: has('electron-main.js') ? 'shadow' : 'missing',
      sources: ['electron-main.js', 'package.json'],
      notes: 'Builder present; hardenedRuntime false and identity null at S0 snapshot',
      evidence: [],
      sourceDigest: null,
    },
    {
      id: 'cap.product_front_door',
      dimension: 'install_onboarding',
      title: 'Five-entry product front door + Doctor',
      status: has('src/runtime/NoeDoctor.js') ? 'shadow' : 'missing',
      sources: ['src/runtime/NoeDoctor.js'],
      notes: 'Doctor exists; five-entry IA and 10-minute first task not verified',
      evidence: [],
      sourceDigest: null,
    },
    {
      id: 'cap.fusion_planner',
      dimension: 'docs_extensibility',
      title: 'BaiLongma fusion planner + capability radar',
      status: has('src/runtime/NoeBaiLongmaFusionPlanner.js') ? 'degraded' : 'missing',
      sources: ['src/runtime/NoeBaiLongmaFusionPlanner.js'],
      notes: 'Read-only planner exists; product-dimension map upgraded in S1',
      evidence: [],
      sourceDigest: null,
    },
    {
      id: 'cap.source_digest',
      dimension: 'evidence_truth',
      title: 'sourceDigest evidence binding',
      status: has('src/runtime/NoeSourceDigest.js') ? 'degraded' : 'missing',
      sources: ['src/runtime/NoeSourceDigest.js'],
      notes: 'Implementation present; all gates must rebind on digest change',
      evidence: [],
      sourceDigest: null,
    },
    {
      id: 'cap.acceptance_gate_runner',
      dimension: 'evidence_truth',
      title: 'Machine-readable acceptance gate runner',
      status: has('src/runtime/NoeAcceptanceGateRunner.js') ? 'degraded' : 'missing',
      sources: ['src/runtime/NoeAcceptanceGateRunner.js'],
      notes: 'Fail-closed runner; absolute gates remain pending until bound evidence',
      evidence: [],
      sourceDigest: null,
    },
  ];

  // Apply evidence overrides (only path to verified)
  for (const cap of capabilities) {
    const o = overrides.get(cap.id);
    if (!o) continue;
    if (isCapabilityStatus(o.status)) cap.status = o.status;
    if (Array.isArray(o.evidence)) cap.evidence = o.evidence;
    if (o.sourceDigest) cap.sourceDigest = o.sourceDigest;
  }

  // Optional runtime flags can only demote, never promote to verified
  if (flags.disableAll === true) {
    for (const cap of capabilities) {
      if (cap.status !== 'missing') cap.status = 'disabled';
    }
  }

  const byStatus = /** @type {Record<string, number>} */ ({});
  for (const s of CAPABILITY_STATUSES) byStatus[s] = 0;
  for (const cap of capabilities) {
    byStatus[cap.status] = (byStatus[cap.status] || 0) + 1;
    const check = assertNotStaticComplete(cap);
    if (!check.ok && cap.status === 'verified') {
      cap.status = 'shadow';
      cap.notes = `${cap.notes}; demoted:${check.reason}`;
    }
  }

  return {
    schemaVersion: CAPABILITY_MANIFEST_SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    rootDir: root,
    dimensions: PRODUCT_DIMENSION_IDS,
    capabilities,
    summary: {
      total: capabilities.length,
      byStatus,
      verifiedCount: byStatus.verified || 0,
      productClaimable: (byStatus.verified || 0) > 0,
      rule: 'static_presence_is_never_verified',
    },
  };
}

/**
 * @param {ReturnType<typeof buildCapabilityManifest>} manifest
 * @returns {string}
 */
export function formatCapabilityManifestMarkdown(manifest) {
  const lines = [
    '# Neo Capability Manifest',
    '',
    `- Generated: ${manifest.generatedAt}`,
    `- Total: ${manifest.summary.total}`,
    `- By status: ${JSON.stringify(manifest.summary.byStatus)}`,
    `- Rule: ${manifest.summary.rule}`,
    '',
    '## Capabilities',
  ];
  for (const cap of manifest.capabilities) {
    lines.push(`- [${cap.status}] ${cap.id} (${cap.dimension}) — ${cap.title}`);
    lines.push(`  - notes: ${cap.notes}`);
  }
  lines.push('');
  return `${lines.join('\n')}\n`;
}
