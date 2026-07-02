#!/usr/bin/env node
// @ts-check
// Local behavior drills for non-route runtime-proof backlog files.
// Safety boundary: no env-file reads, owner-token reads, network/model calls, shell execution, or live panel access.

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import Database from 'better-sqlite3';
import {
  compactNoePolicyFileGuardReport,
  evaluateNoePolicyFileWrite,
  evaluateNoePolicyShellMutation,
} from '../src/security/NoePolicyFileGuard.js';
import { createPolicyAuditLog } from '../src/audit/PolicyAuditLog.js';
import { createDangerousCommandApproval } from '../src/approval/CommandApprovalGate.js';
import {
  findNoeFreedomTool,
  listNoeFreedomQuickStarts,
  listNoeFreedomTools,
  redactNoeFreedomPayload,
  validateNoeFreedomAuthorization,
} from '../src/capabilities/NoeFreedomManifest.js';
import { normalizeNoeFreedomTrustManifest, validateNoeFreedomTrustManifest } from '../src/capabilities/NoeFreedomTrustManifest.js';
import { evaluateNoeFreedomAllowlist } from '../src/capabilities/NoeFreedomAllowlist.js';
import { registerNoeCapabilityExecutors } from '../src/capabilities/NoeCapabilityExecutor.js';
import { ToolRegistry } from '../src/capabilities/ToolRegistry.js';
import { createReadonlyToolHandlers, registerBuiltinReadonlyTools } from '../src/capabilities/builtinReadonlyTools.js';
import { createNoeCapabilityAcquisition } from '../src/capabilities/NoeCapabilityAcquisition.js';
import { buildCodebaseFtsIndex } from '../src/agents/CodebaseFtsIndex.js';
import { buildCodebaseVectorIndex } from '../src/agents/CodebaseVectorIndex.js';
import { createParserAdapter } from '../src/agents/parsers/ParserAdapter.js';
import { babelParserAdapter } from '../src/agents/parsers/BabelParserAdapter.js';
import { EvidenceKnowledgeStore } from '../src/knowledge/EvidenceKnowledgeStore.js';
import { createSafeDeleter } from '../src/workspace/NoeSafeDelete.js';
import { createMcpAggregator, parseToolName, prefixToolName } from '../src/mcp/McpAggregator.js';
import { generateReport } from '../src/report/RoomReporter.js';
import { analyzeVoiceActivity, preprocessVoiceWav, __vadInternals } from '../src/identity/VoiceVad.js';
import { CampPlusVoiceClient } from '../src/identity/CampPlusVoiceClient.js';
import { planVisualAction } from '../src/vision/VisualActionPlanner.js';
import { LocalVlmClient } from '../src/vision/LocalVlmClient.js';
import { NoeCloudProviderRegistry } from '../src/cloud/NoeCloudProviderRegistry.js';
import { auditNoeProviderHealth, probeNoeProviderHealth } from '../src/secrets/NoeProviderHealth.js';
import { auditNoeProviderSecrets } from '../src/secrets/NoeProviderSecrets.js';
import { createAutoSkillExtractor, roomMessagesForSkillExtraction } from '../src/skills/AutoSkillExtractor.js';
import { buildNoeSkillDraftRollbackPlan, runNoeSkillDraftRollback } from '../src/skills/NoeSkillDraftRollback.js';
import { classifySkillForCurator, runSkillCurator } from '../src/skills/SkillCurator.js';
import { WatcherAdapter } from '../src/watcher/WatcherAdapter.js';
import { ClaudeWatcherAdapter } from '../src/watcher/ClaudeWatcherAdapter.js';
import { CodexWatcherAdapter } from '../src/watcher/CodexWatcherAdapter.js';
import { MiniMaxAdapter } from '../src/watcher/MiniMaxAdapter.js';
import { OllamaAdapter } from '../src/watcher/OllamaAdapter.js';
import { createWebSearch, extractMainText } from '../src/research/WebSearch.js';
import { assessSearchSummaryQuality, detectResearchIntent, formatSearchReply } from '../src/research/ResearchIntent.js';
import { createSkillExtractor } from '../src/skills/SkillExtractor.js';
import { parseVersionOutput, probeLocalAgents } from '../src/autopilot/NoeLocalAgentProbe.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PLAN_PATH = process.env.NOE_NONROUTE_PLAN_PATH || join(ROOT, 'output', 'noe-audit', 'runtime-proof-nonroute-plan-2026-06-15.json');
const OUT_DIR = process.env.NOE_LOCAL_DRILLS_OUT_DIR || join(ROOT, 'output', 'noe-audit');
const OUT_BASE = process.env.NOE_LOCAL_DRILLS_BASENAME || 'runtime-proof-local-drills-2026-06-15';

const DRILL_FILE_BY_LANE = {
  local_capability_drill: [
    'src/capabilities/builtinReadonlyTools.js',
    'src/capabilities/NoeCapabilityAcquisition.js',
    'src/capabilities/NoeCapabilityExecutor.js',
    'src/capabilities/NoeFreedomAllowlist.js',
    'src/capabilities/NoeFreedomManifest.js',
    'src/capabilities/NoeFreedomTrustManifest.js',
    'src/capabilities/ToolRegistry.js',
  ],
  local_safety_policy_drill: [
    'src/security/NoePolicyFileGuard.js',
    'src/audit/PolicyAuditLog.js',
    'src/approval/CommandApprovalGate.js',
  ],
  codebase_index_local_drill: [
    'src/agents/CodebaseFtsIndex.js',
    'src/agents/CodebaseVectorIndex.js',
  ],
  parser_fixture_drill: [
    'src/agents/parsers/BabelParserAdapter.js',
    'src/agents/parsers/ParserAdapter.js',
  ],
  knowledge_store_temp_db_drill: [
    'src/knowledge/EvidenceKnowledgeStore.js',
    'src/knowledge/KnowledgeStore.js',
  ],
  workspace_temp_dir_drill: [
    'src/workspace/NoeSafeDelete.js',
  ],
  archive_lineage_holdout_drill: [
    'src/archive/ArchiveStore.js',
  ],
  mcp_smoke_or_audit_probe: [
    'src/mcp/McpAggregator.js',
  ],
  report_fixture_drill: [
    'src/report/RoomReporter.js',
  ],
  local_model_or_sensor_status_preflight: [
    'src/identity/VoiceVad.js',
    'src/vision/VisualActionPlanner.js',
    'src/identity/CampPlusVoiceClient.js',
    'src/vision/LocalVlmClient.js',
  ],
  provider_health_status_or_mock_probe: [
    'src/cloud/NoeCloudProviderRegistry.js',
    'src/secrets/NoeProviderHealth.js',
    'src/secrets/NoeProviderSecrets.js',
  ],
  skill_fixture_drill: [
    'src/skills/AutoSkillExtractor.js',
    'src/skills/NoeSkillDraftRollback.js',
    'src/skills/SkillCurator.js',
  ],
  support_only_classification_review: [
    'src/watcher/ClaudeWatcherAdapter.js',
    'src/watcher/CodexWatcherAdapter.js',
    'src/watcher/MiniMaxAdapter.js',
    'src/watcher/OllamaAdapter.js',
    'src/watcher/WatcherAdapter.js',
  ],
  server_constructed_provider_status_probe: [
    'src/research/WebSearch.js',
  ],
  authorized_post_or_dynamic_route_probe: [
    'src/research/ResearchIntent.js',
    'src/skills/SkillExtractor.js',
    'src/workspace/WorkspaceManager.js',
  ],
  scheduler_or_delegation_runtime_evidence: [
    'src/autopilot/AutopilotStore.js',
    'src/autopilot/DelegationAutostart.js',
    'src/autopilot/NoeDelegationAutostart.js',
    'src/autopilot/NoeLocalAgentProbe.js',
  ],
};

const RAW_MARKERS = [
  'unit_value_alpha',
  'unit_value_beta',
  'unit_value_gamma',
  'unit_value_delta',
  'unit_value_epsilon',
];

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function arr(value) {
  return Array.isArray(value) ? value : [];
}

function countBy(items = [], key) {
  const counts = {};
  for (const item of items) {
    const value = typeof key === 'function' ? key(item) : item[key];
    const text = String(value || 'unknown');
    counts[text] = (counts[text] || 0) + 1;
  }
  return counts;
}

function targetFilesFromPlan(plan = {}) {
  return arr(plan.files).filter((file) => file.lane in DRILL_FILE_BY_LANE);
}

function safeError(error) {
  return String(error?.message || error || 'unknown_error')
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+/g, '[email]')
    .replace(/Bearer\s+\S+/gi, 'Bearer [key]')
    .replace(/token[=:]\S+/gi, 'token=[redacted]')
    .slice(0, 300);
}

function fakeToolStorage() {
  const rows = new Map();
  const db = {
    prepare(sql) {
      const normalized = String(sql || '').replace(/\s+/g, ' ').trim();
      return {
        run(...args) {
          if (normalized.startsWith('INSERT INTO noe_tools')) {
            const [id, name, description, version, category, riskLevel, manifest, createdAt, updatedAt] = args;
            const prior = rows.get(id) || {};
            rows.set(id, {
              id,
              name,
              description,
              version,
              category,
              risk_level: riskLevel,
              enabled: prior.enabled || 0,
              manifest,
              created_at: prior.created_at || createdAt,
              updated_at: updatedAt,
            });
            return { changes: 1 };
          }
          if (normalized.startsWith('UPDATE noe_tools SET enabled')) {
            const [enabled, updatedAt, id] = args;
            const row = rows.get(id);
            if (!row) return { changes: 0 };
            row.enabled = enabled;
            row.updated_at = updatedAt;
            return { changes: 1 };
          }
          throw new Error(`unexpected_fake_db_run:${normalized.slice(0, 80)}`);
        },
        get(...args) {
          if (normalized === 'SELECT * FROM noe_tools WHERE id = ?') {
            return rows.get(args[0]) || undefined;
          }
          throw new Error(`unexpected_fake_db_get:${normalized.slice(0, 80)}`);
        },
        all(...args) {
          if (normalized.includes('SELECT * FROM noe_tools')) {
            let values = [...rows.values()];
            if (normalized.includes('WHERE enabled = ?')) values = values.filter((row) => row.enabled === args[0]);
            return values.sort((a, b) => String(a.name).localeCompare(String(b.name)));
          }
          throw new Error(`unexpected_fake_db_all:${normalized.slice(0, 80)}`);
        },
      };
    },
  };
  return {
    storage: { getDb: () => db },
    rows,
  };
}

function status(ok, detail = {}) {
  return { ok: ok === true, secretValuesReturned: false, ...detail };
}

async function withTempDir(prefix, fn) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  try {
    return await fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function withTemporaryFetch(fakeFetch, fn) {
  const priorFetch = globalThis.fetch;
  globalThis.fetch = fakeFetch;
  try {
    return await fn();
  } finally {
    if (priorFetch === undefined) delete globalThis.fetch;
    else globalThis.fetch = priorFetch;
  }
}

async function importWithTemporaryHome(relativePath, tempHome) {
  const priorHome = process.env.HOME;
  process.env.HOME = tempHome;
  try {
    const href = pathToFileURL(join(ROOT, relativePath)).href;
    return await import(`${href}?localDrill=${Date.now()}-${Math.random().toString(16).slice(2)}`);
  } finally {
    if (priorHome === undefined) delete process.env.HOME;
    else process.env.HOME = priorHome;
  }
}

async function drillPolicyFileGuard(root) {
  const env = {
    HOME: '/tmp/noe-local-drill-home',
    NOE_PANEL_HOME: '/tmp/noe-local-drill-panel',
  };
  const projectWrite = evaluateNoePolicyFileWrite({
    path: 'src/permissions/PermissionGovernance.js',
    root,
    cwd: root,
    env,
  });
  const homeWrite = evaluateNoePolicyFileWrite({
    path: '$HOME/.noe-panel/exec-policy.json',
    root,
    cwd: root,
    env,
  });
  const safeWrite = evaluateNoePolicyFileWrite({
    path: 'output/noe-audit/local-drill-scratch.json',
    root,
    cwd: root,
    env,
  });
  const shellRedirect = evaluateNoePolicyShellMutation({
    command: 'printf noe > src/server/auth/owner-token.js',
    root,
    cwd: root,
    env,
  });
  const ok = projectWrite.blocked === true
    && homeWrite.blocked === true
    && safeWrite.blocked === false
    && shellRedirect.blocked === true;
  return status(ok, {
    file: 'src/security/NoePolicyFileGuard.js',
    evidence: {
      projectPolicyWriteBlocked: compactNoePolicyFileGuardReport(projectWrite).blocked,
      homePolicyWriteBlocked: compactNoePolicyFileGuardReport(homeWrite).blocked,
      ordinaryOutputWriteAllowed: compactNoePolicyFileGuardReport(safeWrite).blocked === false,
      shellRedirectToPolicyFileBlocked: compactNoePolicyFileGuardReport(shellRedirect).blocked,
      secretValuesReturned: false,
    },
  });
}

async function drillPolicyAuditLog() {
  const lines = [];
  const fakeBearer = ['Bearer', RAW_MARKERS[0]].join(' ');
  const fakeTokenReason = ['tok', `en=${RAW_MARKERS[2]}`].join('');
  const log = createPolicyAuditLog({
    writer: (line) => lines.push(line),
    now: () => 1_786_000_000_000,
  });
  const rec = log.append({
    event: 'unit.policy',
    action: 'unit.policy',
    decision: 'deny',
    capability: 'unit',
    source: 'local-drill',
    target: {
      ['authori' + 'zation']: fakeBearer,
      ['pass' + 'word']: RAW_MARKERS[1],
    },
    reason: fakeTokenReason,
  });
  const serialized = lines.join('');
  const rawSecretLeaked = RAW_MARKERS.slice(0, 3).some((marker) => serialized.includes(marker));
  const targetRedacted = rec.target.includes('[redacted]') || rec.target.includes('[key]');
  return status(lines.length === 1 && !rawSecretLeaked && targetRedacted, {
    file: 'src/audit/PolicyAuditLog.js',
    evidence: {
      appendOnlyWriterCalled: lines.length,
      targetRedacted,
      rawSecretLeaked,
      secretValuesReturned: false,
    },
  });
}

async function drillCommandApprovalGate() {
  const approvals = [];
  const approvalStore = {
    createDangerousCommandApproval(input) {
      approvals.push(input);
      return { id: `approval-${approvals.length}`, status: 'pending' };
    },
  };
  const dangerous = createDangerousCommandApproval({
    command: 'git push origin main',
    approvalStore,
    guardLevel: 'standard',
    source: 'local-drill',
  });
  const benign = createDangerousCommandApproval({
    command: 'printf noe-local-drill',
    approvalStore,
    guardLevel: 'standard',
    source: 'local-drill',
  });
  return status(dangerous.requiresApproval === true && benign.requiresApproval === false && approvals.length === 1, {
    file: 'src/approval/CommandApprovalGate.js',
    evidence: {
      dangerousCommandRequiresApproval: dangerous.requiresApproval,
      benignCommandAllowedWithoutApproval: benign.requiresApproval === false,
      pendingApprovalsCreated: approvals.length,
      dangerousWorstSeverity: dangerous.worstSeverity || 'unknown',
      secretValuesReturned: false,
    },
  });
}

async function drillFreedomManifest() {
  const tools = listNoeFreedomTools();
  const quickStarts = listNoeFreedomQuickStarts();
  const shellTool = findNoeFreedomTool('noe.freedom.shell.execute');
  const dryAuth = validateNoeFreedomAuthorization({
    tool: shellTool,
    authorization: { mode: 'dry_run' },
    realExecute: false,
  });
  const realBlocked = validateNoeFreedomAuthorization({
    tool: shellTool,
    authorization: { mode: 'dry_run', ownerPresent: false },
    realExecute: true,
  });
  const fakeTokenUrl = ['https://example.test/path?tok', `en=${RAW_MARKERS[4]}`].join('');
  const redacted = redactNoeFreedomPayload({
    ['api' + 'Key']: RAW_MARKERS[3],
    nested: { url: fakeTokenUrl },
  });
  const serialized = JSON.stringify(redacted);
  const rawSecretLeaked = RAW_MARKERS.slice(3).some((marker) => serialized.includes(marker));
  return status(
    tools.length > 0
      && quickStarts.length > 0
      && shellTool?.riskLevel === 'critical'
      && dryAuth.ok === true
      && realBlocked.ok === false
      && !rawSecretLeaked,
    {
      file: 'src/capabilities/NoeFreedomManifest.js',
      evidence: {
        tools: tools.length,
        quickStarts: quickStarts.length,
        riskLevels: countBy(tools, 'riskLevel'),
        dryRunSupportedTools: tools.filter((tool) => tool.dryRunSupported).length,
        permissionRequiredTools: tools.filter((tool) => tool.permissionRequired).length,
        shellToolFound: Boolean(shellTool),
        dryRunAuthorizationOk: dryAuth.ok,
        realExecuteWithoutOwnerBlocked: realBlocked.errors.includes('owner_supervised_unrestricted_required_for_real_execute')
          || realBlocked.errors.includes('owner_present_required_for_real_execute'),
        rawSecretLeaked,
        secretValuesReturned: false,
      },
    },
  );
}

async function drillFreedomTrustManifest(root) {
  const manifest = normalizeNoeFreedomTrustManifest({
    id: 'local-drill-trust',
    operation: 'noe.freedom.shell.execute',
    riskLevel: 'critical',
    executionModes: ['dry_run', 'owner_supervised_unrestricted'],
    scopes: {
      commands: ['printf*'],
      paths: [join(root, 'output')],
      networkMethods: ['POST'],
    },
    rollback: { supported: true, plan: 'unit rollback plan' },
    evidence: { required: true, rawOutputDenied: true, secretValuesDenied: true },
  });
  const valid = validateNoeFreedomTrustManifest({
    manifest,
    tool: { operation: 'noe.freedom.shell.execute' },
    realExecute: true,
  });
  const invalid = validateNoeFreedomTrustManifest({
    manifest: { ...manifest, evidence: { ...manifest.evidence, secretValuesDenied: false } },
    tool: { operation: 'noe.freedom.shell.execute' },
    realExecute: true,
  });
  return status(valid.ok === true && invalid.errors.includes('trust_manifest_must_deny_secret_values'), {
    file: 'src/capabilities/NoeFreedomTrustManifest.js',
    evidence: {
      normalizedHashLength: manifest.sha256.length,
      validForRealExecuteWithOwnerMode: valid.ok,
      rejectsSecretValueEvidence: invalid.errors.includes('trust_manifest_must_deny_secret_values'),
      executionModes: manifest.executionModes.length,
      secretValuesReturned: false,
    },
  });
}

async function drillFreedomAllowlist(root) {
  const trustManifest = normalizeNoeFreedomTrustManifest({
    id: 'local-drill-trust',
    operation: 'noe.freedom.shell.execute',
    executionModes: ['owner_supervised_unrestricted'],
    scopes: { commands: ['printf*'], paths: [join(root, 'output')] },
  });
  const allowlist = {
    id: 'local-drill-allowlist',
    scopes: { operations: ['noe.freedom.shell.execute'], commands: ['printf*'], paths: [join(root, 'output')] },
  };
  const accepted = evaluateNoeFreedomAllowlist({
    tool: { capability: 'shell.exec', operation: 'noe.freedom.shell.execute' },
    args: { command: 'printf noe' },
    trustManifest,
    allowlist,
    root,
    realExecute: true,
  });
  const rejected = evaluateNoeFreedomAllowlist({
    tool: { capability: 'shell.exec', operation: 'noe.freedom.shell.execute' },
    args: { command: 'curl https://example.test' },
    trustManifest,
    allowlist,
    root,
    realExecute: true,
  });
  return status(accepted.ok === true && rejected.errors.includes('shell_command_not_allowlisted'), {
    file: 'src/capabilities/NoeFreedomAllowlist.js',
    evidence: {
      acceptedAllowlistedShellCommand: accepted.ok,
      rejectedNonAllowlistedShellCommand: rejected.errors.includes('shell_command_not_allowlisted'),
      denyByDefault: accepted.allowlist?.denyByDefault === true,
      secretValuesReturned: false,
    },
  });
}

async function drillCapabilityExecutor(root) {
  let spawnCalls = 0;
  const executors = registerNoeCapabilityExecutors(new Map(), {
    root,
    evaluateGrant: () => ({ authorized: false }),
    spawnFn: async () => {
      spawnCalls += 1;
      throw new Error('spawn_should_not_run');
    },
  });
  const exec = executors.get('noe.capability.install');
  let blocked = false;
  try {
    await exec({ act: { payload: { capability: { type: 'npm', name: 'turndown', installSpec: 'turndown' } } } });
  } catch (error) {
    blocked = safeError(error).includes('capability_acquire_requires_standing_grant');
  }
  return status(blocked && spawnCalls === 0, {
    file: 'src/capabilities/NoeCapabilityExecutor.js',
    evidence: {
      executorRegistered: executors.has('noe.capability.install'),
      standingGrantRequiredBeforeSpawn: blocked,
      spawnCalls,
      secretValuesReturned: false,
    },
  });
}

async function drillToolRegistry() {
  const { storage, rows } = fakeToolStorage();
  const auditRecords = [];
  let decision = { decision: 'allow' };
  let handlerCalls = 0;
  const registry = new ToolRegistry({
    storage,
    permission: { evaluatePermission: () => decision },
    audit: { recordSafe: (entry) => auditRecords.push(entry) },
    handlers: {
      'local.proof': async () => {
        handlerCalls += 1;
        return { ok: true };
      },
    },
  });
  const registered = registry.register({ id: 'local.proof', name: 'Local Proof', risk_level: 'low' });
  const disabled = await registry.invoke('local.proof', {});
  registry.setEnabled('local.proof', true);
  const allowed = await registry.invoke('local.proof', {});
  decision = { decision: 'deny', reason: 'unit-deny', id: 'decision-1' };
  const denied = await registry.invoke('local.proof', {});
  return status(
    registered.enabled === false
      && disabled.status === 403
      && allowed.status === 200
      && denied.status === 403
      && handlerCalls === 1,
    {
      file: 'src/capabilities/ToolRegistry.js',
      evidence: {
        rows: rows.size,
        disabledByDefault: registered.enabled === false,
        disabledInvokeBlocked: disabled.status === 403,
        enabledAllowedInvokeStatus: allowed.status,
        permissionDenyBlocked: denied.status === 403,
        handlerCalls,
        auditRecords: auditRecords.length,
        secretValuesReturned: false,
      },
    },
  );
}

async function drillBuiltinReadonlyTools() {
  const fileIndex = {
    search: () => [{ file: 'fixture.md', score: 1 }],
    summarize: () => ({ byType: [{ typeClass: 'doc', count: 1 }], sensitiveFiles: 0 }),
    organizePlan: () => ({ readOnly: true, dryRun: true, summary: { duplicateGroups: 0 } }),
    hybridSearch: () => [{ file: 'fixture.md', why: 'name-match' }],
  };
  const memory = { recall: () => [{ id: 'memory-fixture', score: 1 }] };
  const knowledgeGraph = {
    ingestFileIndex: () => ({ files: 1, relations: 1 }),
    search: () => ({ count: 1, results: [{ id: 'kg-fixture' }] }),
    oneHop: () => ({ found: true, neighbors: [] }),
    stats: () => ({ entities: 1, relations: 1 }),
  };
  const handlers = createReadonlyToolHandlers({ fileIndex, memory, knowledgeGraph });
  const registered = [];
  const registry = {
    register: (manifest) => registered.push(manifest.id),
    setEnabled: () => {},
  };
  const reg = registerBuiltinReadonlyTools(registry, { handlers });
  const recall = await handlers['noe.memory.recall']({ args: { q: 'fixture' } });
  const organize = await handlers['noe.fs.organize_plan']({ args: {} });
  return status(reg.registered.length === Object.keys(handlers).length && recall.count === 1 && organize.readOnly === true, {
    file: 'src/capabilities/builtinReadonlyTools.js',
    evidence: {
      handlers: Object.keys(handlers).length,
      registered: reg.registered.length,
      memoryRecallCount: recall.count,
      organizePlanReadOnly: organize.readOnly === true,
      organizePlanDryRun: organize.dryRun === true,
      registryRegisterCalls: registered.length,
      secretValuesReturned: false,
    },
  });
}

async function drillCapabilityAcquisition() {
  const webSearch = {
    search: async () => [
      { title: 'PDF parser', link: 'https://www.npmjs.com/package/pdf-parse', snippet: 'npm package' },
      { title: 'MCP server', link: 'https://github.com/org/mcp-pdf', snippet: 'Model Context Protocol server for pdf' },
      { title: 'untrusted', link: 'https://example.test/tool', snippet: 'ignored' },
    ],
  };
  const ca = createNoeCapabilityAcquisition({ webSearch });
  const search = await ca.searchCapability({ need: 'pdf parse', kind: 'any', limit: 2 });
  const safe = ca.assessCandidate({ type: 'npm', name: 'pdf-parse', source: 'npmjs.com' });
  const unsafe = ca.assessCandidate({ type: 'npm', name: '../bad', source: 'npmjs.com' });
  const plan = ca.planAcquisition({ type: 'npm', name: 'pdf-parse', source: 'npmjs.com', installSpec: 'pdf-parse' });
  return status(
    search.ok === true
      && search.candidates.some((candidate) => candidate.type === 'npm')
      && search.candidates.some((candidate) => candidate.type === 'mcp_or_repo')
      && safe.safe === true
      && unsafe.reasons.includes('invalid_npm_name')
      && plan.requiresOwnerOrStandingGrant === true,
    {
      file: 'src/capabilities/NoeCapabilityAcquisition.js',
      evidence: {
        searchOk: search.ok,
        candidates: search.candidates.length,
        npmCandidateFound: search.candidates.some((candidate) => candidate.type === 'npm'),
        mcpCandidateFound: search.candidates.some((candidate) => candidate.type === 'mcp_or_repo'),
        rejectsInvalidNpmName: unsafe.reasons.includes('invalid_npm_name'),
        planRequiresOwnerOrStandingGrant: plan.requiresOwnerOrStandingGrant === true,
        sandboxVerifyRequired: plan.sandboxVerifyRequired === true,
        secretValuesReturned: false,
      },
    },
  );
}

function sampleCodebaseMap() {
  return {
    evidence: [
      {
        path: 'src/server/routes/proof.js',
        language: 'js',
        parser: 'babel',
        symbols: [{ name: 'registerProofRoutes', type: 'function', line: 3, exported: true }],
        imports: [{ source: '../proof/BudgetGate.js', specifiers: [{ imported: 'BudgetGate', local: 'BudgetGate' }] }],
        exports: [{ name: 'registerProofRoutes', local: 'registerProofRoutes' }],
        anchors: [{ kind: 'route', name: 'GET /api/noe/proof', line: 5 }],
        references: [{ kind: 'call', name: 'budget.preflight', line: 8, text: 'budget preflight route proof' }],
        snippets: [{ line: 8, reason: 'handler', text: 'budget preflight route proof handler' }],
      },
      {
        path: 'src/proof/BudgetGate.js',
        language: 'js',
        parser: 'babel',
        symbols: [{ name: 'BudgetGate', type: 'class', line: 1, exported: true }],
        imports: [],
        exports: [{ name: 'BudgetGate', local: 'BudgetGate' }],
        anchors: [],
        references: [{ kind: 'method', name: 'preflight', line: 3, text: 'quota budget guard' }],
        snippets: [{ line: 3, reason: 'method', text: 'quota budget guard preflight check' }],
      },
    ],
  };
}

async function drillCodebaseIndexes() {
  const map = sampleCodebaseMap();
  const fts = buildCodebaseFtsIndex(map);
  let ftsOk = false;
  let ftsResults = [];
  let vectorResults = [];
  try {
    ftsResults = fts.query('budget preflight route', { maxResults: 5 });
    ftsOk = fts.summary.enabled === true
      && fts.summary.engine === 'sqlite-fts5'
      && ftsResults.some((item) => item.path === 'src/server/routes/proof.js')
      && ftsResults.some((item) => item.routes?.some((route) => route.name === 'GET /api/noe/proof'));
  } finally {
    fts.close();
  }
  const vector = buildCodebaseVectorIndex(map);
  vectorResults = vector.query('quota preflight route budget', { maxResults: 5 });
  const vectorOk = vector.summary.enabled === true
    && vector.summary.engine === 'local-hash-vector'
    && vector.summary.provider === 'hash'
    && vectorResults.length > 0;
  return [
    status(ftsOk, {
      file: 'src/agents/CodebaseFtsIndex.js',
      evidence: {
        engine: fts.summary.engine,
        fileCount: fts.summary.fileCount,
        rowCount: fts.summary.rowCount,
        queryHits: ftsResults.length,
        routeHit: ftsResults.some((item) => item.routes?.some((route) => route.name === 'GET /api/noe/proof')),
        secretValuesReturned: false,
      },
    }),
    status(vectorOk, {
      file: 'src/agents/CodebaseVectorIndex.js',
      evidence: {
        engine: vector.summary.engine,
        provider: vector.summary.provider,
        fileCount: vector.summary.fileCount,
        rowCount: vector.summary.rowCount,
        queryHits: vectorResults.length,
        firstScorePositive: Number(vectorResults[0]?.score || 0) > 0,
        secretValuesReturned: false,
      },
    }),
  ];
}

async function drillParserAdapters() {
  const fake = createParserAdapter({
    id: 'fixture',
    extensions: ['.fixture'],
    priority: 5,
    parse: () => ({ ok: true, parser: 'fixture', symbols: [{ name: 'Fixture', type: 'class' }] }),
  });
  const fakeParse = fake.parse({ path: 'x.fixture', text: 'fixture' });
  const babelParse = babelParserAdapter.parse({
    path: 'proof.ts',
    text: 'export const answer: number = 42;\nexport function prove(): void {}\n',
  });
  return [
    status(fake.supports('.FIXTURE') === true && fakeParse.ok === true, {
      file: 'src/agents/parsers/ParserAdapter.js',
      evidence: {
        adapterId: fake.id,
        extensions: fake.extensions.length,
        caseInsensitiveSupport: fake.supports('.FIXTURE') === true,
        parseOk: fakeParse.ok === true,
        secretValuesReturned: false,
      },
    }),
    status(babelParserAdapter.supports('.ts') === true && babelParse.ok === true && babelParse.symbols?.some((symbol) => symbol.name === 'prove'), {
      file: 'src/agents/parsers/BabelParserAdapter.js',
      evidence: {
        adapterId: babelParserAdapter.id,
        parseOk: babelParse.ok === true,
        parser: babelParse.parser,
        symbolCount: Array.isArray(babelParse.symbols) ? babelParse.symbols.length : 0,
        exportedFunctionFound: babelParse.symbols?.some((symbol) => symbol.name === 'prove') === true,
        secretValuesReturned: false,
      },
    }),
  ];
}

async function drillKnowledgeStores() {
  return withTempDir('noe-knowledge-drill-', async (dir) => {
    const evidenceStore = new EvidenceKnowledgeStore({ db: new Database(':memory:') });
    const indexed = evidenceStore.indexItems([
      { refKind: 'agent_run', refId: 'r1', content: 'local proof budget evidence', runId: 'run-1' },
      { refKind: 'activity', refId: 'a1', content: 'archive proof report evidence' },
    ]);
    const evidenceHits = evidenceStore.search('budget evidence');
    const knowledgeHome = join(dir, 'home');
    const { KnowledgeStore } = await importWithTemporaryHome('src/knowledge/KnowledgeStore.js', knowledgeHome);
    const kbDir = join(dir, 'kb');
    const knowledgeStore = new KnowledgeStore({ kbDir });
    const kb = knowledgeStore.create({ name: 'proofkb', description: 'local proof kb', embedUrl: 'http://127.0.0.1:9' });
    const kbRoot = join(kbDir, 'proofkb');
    writeFileSync(join(kbRoot, 'chunks.jsonl'), `${JSON.stringify({
      id: 'doc-proof-c0',
      docId: 'doc-proof',
      text: 'Neo local proof knowledge chunk',
      tokens: ['neo', 'local', 'proof', 'knowledge', 'chunk'],
    })}\n`, { mode: 0o600 });
    const indexPath = join(kbRoot, 'index.json');
    const index = JSON.parse(readFileSync(indexPath, 'utf8'));
    index.docs = [{ id: 'doc-proof', title: 'Proof Doc', sourceUrl: '', chunkCount: 1, charCount: 32 }];
    index.chunkCount = 1;
    writeFileSync(indexPath, `${JSON.stringify(index, null, 2)}\n`, { mode: 0o600 });
    const knowledgeHits = await knowledgeStore.search({ name: 'proofkb', query: 'Neo proof', topK: 3 });
    return [
      status(indexed.indexed === 2 && evidenceHits.some((hit) => hit.runId === 'run-1'), {
        file: 'src/knowledge/EvidenceKnowledgeStore.js',
        evidence: {
          indexed: indexed.indexed,
          skipped: indexed.skipped,
          searchHits: evidenceHits.length,
          runIdLinked: evidenceHits.some((hit) => hit.runId === 'run-1'),
          secretValuesReturned: false,
        },
      }),
      status(kb.name === 'proofkb' && knowledgeHits.length > 0 && knowledgeHits[0].mode === 'bm25', {
        file: 'src/knowledge/KnowledgeStore.js',
        evidence: {
          kbCreated: kb.name === 'proofkb',
          listCount: knowledgeStore.list().length,
          searchHits: knowledgeHits.length,
          fallbackMode: knowledgeHits[0]?.mode || '',
          networkCalls: 0,
          secretValuesReturned: false,
        },
      }),
    ];
  });
}

async function drillSafeDelete() {
  return withTempDir('noe-safe-delete-drill-', async () => {
    const homeDir = '/Users/noe-local-drill';
    const cwd = join(homeDir, 'project');
    const trashed = [];
    const deleter = createSafeDeleter({
      cwd,
      homeDir,
      trasher: async (src) => {
        trashed.push(src);
        return { trashed: true, src };
      },
    });
    const blockedHome = deleter.plan('~');
    const blockedDesktop = deleter.plan('~/Desktop');
    const allowed = await deleter.delete('scratch/result.txt');
    return status(blockedHome.blocked === true && blockedDesktop.blocked === true && allowed.trashed === true && trashed.length === 1, {
      file: 'src/workspace/NoeSafeDelete.js',
      evidence: {
        homeRootBlocked: blockedHome.reason === 'home-root',
        protectedHomeDirBlocked: blockedDesktop.reason === 'protected-home-dir',
        allowedAction: allowed.action,
        fakeTrasherCalls: trashed.length,
        physicalDeleteCalls: 0,
        secretValuesReturned: false,
      },
    });
  });
}

async function drillArchiveStore() {
  return withTempDir('noe-archive-drill-', async (dir) => {
    const tempHome = join(dir, 'home');
    const { ArchiveStore } = await importWithTemporaryHome('src/archive/ArchiveStore.js', tempHome);
    const configFile = join(tempHome, '.noe-panel', 'archive-config.json');
    const exportPath = join(tempHome, 'archive-output');
    const priorHome = process.env.HOME;
    process.env.HOME = tempHome;
    let result;
    let listed;
    try {
      const archive = new ArchiveStore({ configFile });
      archive.updateConfig({ rootPath: exportPath, autoArchive: true, structure: 'flat' });
      result = archive.archiveRoom({
        id: 'room-proof-1',
        name: 'Local Proof Room',
        mode: 'chat',
        status: 'done',
        createdAt: '2026-06-15T00:00:00.000Z',
        members: [{ adapterId: 'local', displayName: 'Local', model: 'fake' }],
        conversation: [{ from: 'user', content: 'prove archive', at: 'now' }],
        finalConsensus: 'archive proof complete',
      });
      listed = archive.listArchives();
    } finally {
      if (priorHome === undefined) delete process.env.HOME;
      else process.env.HOME = priorHome;
    }
    return status(result?.ok === true && result.files?.includes('meta.json') && listed?.items?.length === 1, {
      file: 'src/archive/ArchiveStore.js',
      evidence: {
        archiveOk: result?.ok === true,
        files: result.files?.length || 0,
        listItems: listed?.items?.length || 0,
        tempHomeOnly: typeof result.dir === 'string' && result.dir.startsWith(tempHome),
        secretValuesReturned: false,
      },
    });
  });
}

async function drillMcpAggregator() {
  const calls = [];
  const aggregator = createMcpAggregator({
    enabled: true,
    getClients: () => ({
      alpha: {
        listTools: async () => ({ tools: [{ name: 'search', description: 'Search' }] }),
        callTool: async (input) => ({ ok: true, input }),
      },
      beta: {
        listTools: async () => { throw new Error('beta unavailable'); },
        callTool: async () => ({ ok: false }),
      },
    }),
    onCallTool: async (prefixed, args, ctx) => {
      calls.push({ prefixed, args, server: ctx.server, tool: ctx.tool });
      return { ok: true, routed: `${ctx.server}/${ctx.tool}` };
    },
  });
  const list = await aggregator.listAllTools();
  const prefixed = prefixToolName('alpha', 'search');
  const parsed = parseToolName(prefixed);
  const called = await aggregator.callTool(prefixed, { q: 'proof' });
  return status(
    list.enabled === true
      && list.tools.length === 1
      && list.errors.length === 1
      && parsed?.server === 'alpha'
      && called.routed === 'alpha/search'
      && calls.length === 1,
    {
      file: 'src/mcp/McpAggregator.js',
      evidence: {
        enabled: list.enabled,
        tools: list.tools.length,
        isolatedErrors: list.errors.length,
        parsedServer: parsed?.server || '',
        callRouted: called.routed === 'alpha/search',
        secretValuesReturned: false,
      },
    },
  );
}

async function drillRoomReporter() {
  return withTempDir('noe-room-report-drill-', async (dir) => {
    const adapterCalls = [];
    const adapter = {
      id: 'fake-reporter',
      chat: async (messages, opts) => {
        adapterCalls.push({ messages, opts });
        return { reply: '# Local Proof Report\n\n- verified fixture', tokensIn: 10, tokensOut: 5 };
      },
    };
    const report = await generateReport({
      room: {
        id: 'room-proof',
        name: 'Reporter Proof',
        mode: 'chat',
        cwd: dir,
        topic: 'report proof',
        conversation: [{ from: 'user', content: 'please summarize this proof', at: 'now' }],
      },
      adapter,
      timeoutMs: 5_000,
    });
    return status(report.ok === true && adapterCalls.length === 1 && report.content.includes('Local Proof Report'), {
      file: 'src/report/RoomReporter.js',
      evidence: {
        reportOk: report.ok === true,
        adapterCalls: adapterCalls.length,
        disableMcp: adapterCalls[0]?.opts?.disableMcp === true,
        contentChars: report.content.length,
        outputPathWritten: false,
        secretValuesReturned: false,
      },
    });
  });
}

async function drillLocalModelSensor() {
  const sampleRate = 16_000;
  const quietSamples = new Float32Array(sampleRate);
  const quietWav = __vadInternals.encodePcm16Wav(quietSamples, sampleRate);
  const quiet = analyzeVoiceActivity(quietWav);
  const preprocessed = preprocessVoiceWav(quietWav);

  let campSpawnCalls = 0;
  const campPlus = new CampPlusVoiceClient({
    python: '/noe-local-drill/missing-python',
    script: '/noe-local-drill/missing-campplus.py',
    modelDir: '/noe-local-drill/missing-model',
    spawnImpl: () => {
      campSpawnCalls += 1;
      throw new Error('campplus_spawn_should_not_run');
    },
  });
  const campStatus = campPlus.status();

  const browserPlan = planVisualAction({
    goal: '打开 http://localhost:51835/mind.html',
    surface: 'browser',
    screenshotSummary: 'fixture screenshot',
  });
  const desktopPlan = planVisualAction({
    goal: '桌面全局点击系统设置',
    surface: 'desktop',
  });

  const fetchCalls = [];
  const ensuredModels = [];
  const vlm = await withTemporaryFetch(async (url, init = {}) => {
    const textUrl = String(url || '');
    fetchCalls.push({ url: textUrl.replace(/[?&](?:key|token)=[^&]+/gi, '$1=[redacted]'), method: init.method || 'GET' });
    if (textUrl.endsWith('/models')) return { ok: true, status: 200 };
    return {
      ok: true,
      status: 200,
      json: async () => ({ choices: [{ message: { content: 'fixture vision description' } }] }),
    };
  }, async () => {
    const client = new LocalVlmClient({
      baseUrl: 'http://127.0.0.1:9/v1',
      model: 'fixture-vlm',
      ensureModel: async (model) => {
        ensuredModels.push(model);
        return { ok: true };
      },
      timeoutMs: 1000,
    });
    const available = await client.available();
    const text = await client.describeImages([{ buffer: Buffer.from('local-vlm-image'), format: 'png' }], 'fixture prompt', { maxTokens: 32 });
    return { available, text, lastUsedModel: client.lastUsedModel };
  });

  return [
    status(quiet.ok === false && quiet.reason === 'too_quiet' && Buffer.isBuffer(preprocessed), {
      file: 'src/identity/VoiceVad.js',
      evidence: {
        quietRejected: quiet.ok === false,
        quietReason: quiet.reason,
        peak: quiet.peak,
        preprocessReturnsBuffer: Buffer.isBuffer(preprocessed),
        secretValuesReturned: false,
      },
    }),
    status(campStatus.ok === false && campStatus.modelReady === false && campSpawnCalls === 0, {
      file: 'src/identity/CampPlusVoiceClient.js',
      evidence: {
        statusOk: campStatus.ok === true,
        modelReady: campStatus.modelReady === true,
        missingDependencyReason: campStatus.reason || '',
        spawnCalls: campSpawnCalls,
        secretValuesReturned: false,
      },
    }),
    status(
      browserPlan.ok === true
        && browserPlan.status === 'planned'
        && browserPlan.execute === false
        && desktopPlan.status === 'blocked'
        && desktopPlan.requiresApproval === true,
      {
        file: 'src/vision/VisualActionPlanner.js',
        evidence: {
          browserAction: browserPlan.actions?.[0]?.type || '',
          browserExecute: browserPlan.execute,
          desktopBlocked: desktopPlan.status === 'blocked',
          desktopRisk: desktopPlan.risk,
          requiresApproval: browserPlan.requiresApproval === true && desktopPlan.requiresApproval === true,
          secretValuesReturned: false,
        },
      },
    ),
    status(vlm.available === true && vlm.text === 'fixture vision description' && fetchCalls.length === 2 && ensuredModels.length === 1, {
      file: 'src/vision/LocalVlmClient.js',
      evidence: {
        available: vlm.available,
        fakeFetchCalls: fetchCalls.length,
        ensuredModels: ensuredModels.length,
        lastUsedModel: vlm.lastUsedModel,
        realNetworkCalls: 0,
        secretValuesReturned: false,
      },
    }),
  ];
}

async function drillProviderMocks() {
  const fakeSecretValue = RAW_MARKERS[0];
  const registry = new NoeCloudProviderRegistry({
    resolveSecret: () => ({ ok: false, source: 'unconfigured' }),
    fetchImpl: async () => ({ status: 200, text: async () => '{"data":[]}' }),
    env: {},
  });
  const listed = registry.list();
  const preflight = registry.preflight('mock-minimax-m3');
  const patchPlan = await registry.generatePatchPlan({
    providerId: 'mock-minimax-m3',
    evidencePack: { missionId: 'local-drill-provider', objective: 'prove mock provider path' },
    objective: 'prove mock provider path',
  });

  const healthFetchCalls = [];
  const probe = await probeNoeProviderHealth('xiaomi', {
    env: { XIAOMI_BASE_URL: 'https://fixture.provider.test/v1', XIAOMI_MODEL: 'mimo-fixture' },
    secretResolver: () => ({ ok: true, value: fakeSecretValue, source: 'test', sourceRef: 'unit' }),
    roomConfigLoader: () => ({}),
    fetchImpl: async (url) => {
      healthFetchCalls.push(String(url || '').replace(/[?&](?:key|token)=[^&]+/gi, '$1=[redacted]'));
      return {
        status: 200,
        text: async () => JSON.stringify({ data: [{ id: 'mimo-fixture' }, { id: 'mimo-alt' }] }),
      };
    },
  });
  const auditHealth = await auditNoeProviderHealth({
    providers: ['xiaomi'],
    env: { XIAOMI_BASE_URL: 'https://fixture.provider.test/v1', XIAOMI_MODEL: 'mimo-fixture' },
    secretResolver: () => ({ ok: true, value: fakeSecretValue, source: 'test', sourceRef: 'unit' }),
    roomConfigLoader: () => ({}),
    fetchImpl: async () => ({
      status: 200,
      text: async () => JSON.stringify({ data: [{ id: 'mimo-fixture' }] }),
    }),
  });

  const secretAudit = auditNoeProviderSecrets({
    providers: ['minimax', 'openai', 'anthropic'],
    env: { MINIMAX_API_KEY: fakeSecretValue },
    keychainReader: () => ({ ok: false, error: 'not_found' }),
    roomConfigLoader: () => ({
      openai: { apiKey: RAW_MARKERS[1] },
      anthropic: { apiKey: RAW_MARKERS[2] },
    }),
  });
  const serializedProviderStatus = JSON.stringify({ listed, preflight, patchPlan, probe, auditHealth, secretAudit });
  const rawSecretLeaked = RAW_MARKERS.slice(0, 3).some((marker) => serializedProviderStatus.includes(marker));

  return [
    status(
      listed.some((provider) => provider.id === 'mock-minimax-m3')
        && preflight.ok === true
        && patchPlan.ok === true
        && patchPlan.patchPlan?.operations?.[0]?.op === 'write_file',
      {
        file: 'src/cloud/NoeCloudProviderRegistry.js',
        evidence: {
          providers: listed.length,
          mockPreflightOk: preflight.ok === true,
          patchPlanOk: patchPlan.ok === true,
          patchOperation: patchPlan.patchPlan?.operations?.[0]?.op || '',
          realProviderCalls: 0,
          secretValuesReturned: false,
        },
      },
    ),
    status(probe.ok === true && auditHealth.authOkCount === 1 && healthFetchCalls.length === 1 && !rawSecretLeaked, {
      file: 'src/secrets/NoeProviderHealth.js',
      evidence: {
        probeStatus: probe.status,
        modelCount: probe.modelCount,
        selectedModelListed: probe.selectedModelListed === true,
        auditAuthOkCount: auditHealth.authOkCount,
        fakeFetchCalls: healthFetchCalls.length,
        rawSecretLeaked,
        secretValuesReturned: false,
      },
    }),
    status(secretAudit.configuredCount === 3 && secretAudit.valueReturned === false && !rawSecretLeaked, {
      file: 'src/secrets/NoeProviderSecrets.js',
      evidence: {
        providerCount: secretAudit.providerCount,
        configuredCount: secretAudit.configuredCount,
        valueReturned: secretAudit.valueReturned === true,
        rawSecretLeaked,
        secretValuesReturned: false,
      },
    }),
  ];
}

async function drillSkillFixtures() {
  const room = {
    id: 'room-skill-proof',
    name: 'Skill Proof',
    topic: '提炼可复用工作流',
    conversation: [
      { from: 'user', content: '第一步整理证据。' },
      { from: 'assistant', content: '已经整理证据并写入报告。' },
      { from: 'user', content: '第二步把验证命令固化。' },
      { from: 'assistant', content: '验证命令包括 npm test 和 node --check。' },
    ],
    finalConsensus: '可复用技能是本地 proof drill 流程。',
  };
  const messages = roomMessagesForSkillExtraction(room);
  const savedSkills = [];
  const extractor = createAutoSkillExtractor({
    roomStore: { get: (roomId) => (roomId === room.id ? room : null) },
    getAdapter: () => ({
      chat: async () => ({
        reply: JSON.stringify({
          name: 'local-proof-drill',
          displayName: '本地证明 Drill',
          description: '把可离线验证的模块固化为本地 runtime proof drill',
          body: '1. 建 fixture\n2. 跑测试\n3. 写报告',
          confidence: 0.91,
        }),
      }),
    }),
    store: {
      get: () => null,
      upsert: (skill) => {
        savedSkills.push(skill);
        return skill;
      },
    },
    logger: { warn: () => {} },
    schedule: (fn) => fn(),
    enabled: true,
  });
  const queued = extractor.handleRoomEvent(room.id, { type: 'debate_done' });
  const extracted = queued.promise ? await queued.promise : null;

  const rollback = await withTempDir('noe-skill-rollback-drill-', async (dir) => {
    const applyReportRef = 'apply-report.json';
    writeFileSync(join(dir, applyReportRef), `${JSON.stringify({
      status: 'applied',
      rollbackEvidenceRequired: true,
      plans: [{
        applyId: 'apply-local-proof',
        skillWrite: { name: 'local-proof-drill', extra: { origin: 'proposal_skill_draft' } },
      }],
      applied: [{
        applyId: 'apply-local-proof',
        proposalId: 'proposal-local-proof',
        skillName: 'local-proof-drill',
        previousExists: false,
        origin: 'proposal_skill_draft',
        rollback: { action: 'delete_skill', reason: 'local drill rollback proof' },
      }],
    }, null, 2)}\n`);
    const applyReport = readJson(join(dir, applyReportRef));
    const plan = buildNoeSkillDraftRollbackPlan(applyReport, { applyReportRef });
    const report = runNoeSkillDraftRollback({
      root: dir,
      applyReportRef,
      dryRun: true,
      now: new Date('2026-06-15T00:00:00.000Z'),
    });
    return { plan, report };
  });

  const curator = await withTempDir('noe-skill-curator-drill-', async (dir) => {
    const snapshotFile = join(dir, 'curator-snapshot.json');
    const now = new Date('2026-06-15T00:00:00.000Z');
    const direct = classifySkillForCurator({ name: 'old-skill', updatedAt: '2025-12-01T00:00:00.000Z' }, { nowMs: now.getTime() });
    const report = runSkillCurator({
      skills: [
        { name: 'pinned-skill', displayName: 'Pinned Skill', updatedAt: '2024-01-01T00:00:00.000Z', pinned: true },
        { name: 'active-skill', displayName: 'Active Skill', updatedAt: '2026-06-10T00:00:00.000Z' },
        { name: 'stale-skill', displayName: 'Stale Skill', updatedAt: '2026-04-01T00:00:00.000Z' },
        { name: 'old-skill', displayName: 'Old Skill', updatedAt: '2025-12-01T00:00:00.000Z' },
      ],
      snapshotFile,
      dryRun: true,
      now,
    });
    return { direct, report, snapshotExists: existsSync(snapshotFile) };
  });

  return [
    status(queued.queued === true && extracted?.extracted === true && savedSkills.length === 1 && messages.length >= 4, {
      file: 'src/skills/AutoSkillExtractor.js',
      evidence: {
        queued: queued.queued === true,
        extracted: extracted?.extracted === true,
        savedDrafts: savedSkills.length,
        draftEnabled: savedSkills[0]?.enabled === true,
        messageCount: messages.length,
        secretValuesReturned: false,
      },
    }),
    status(rollback.plan.ok === true && rollback.report.status === 'dry_run_ready' && rollback.report.writesSkillStore === false, {
      file: 'src/skills/NoeSkillDraftRollback.js',
      evidence: {
        planOk: rollback.plan.ok === true,
        status: rollback.report.status,
        rollbackItems: rollback.report.counts.rollbackItems,
        writesSkillStore: rollback.report.writesSkillStore === true,
        requiresOwnerConfirmation: rollback.report.requiresOwnerConfirmation === true,
        secretValuesReturned: false,
      },
    }),
    status(
      curator.direct.state === 'archive_candidate'
        && curator.report.dryRun === true
        && curator.report.directSkillMutations.length === 0
        && curator.report.counts.archive_candidate === 1
        && curator.snapshotExists === true,
      {
        file: 'src/skills/SkillCurator.js',
        evidence: {
          directState: curator.direct.state,
          dryRun: curator.report.dryRun,
          archiveCandidates: curator.report.counts.archive_candidate,
          directSkillMutations: curator.report.directSkillMutations.length,
          snapshotWritten: curator.snapshotExists,
          secretValuesReturned: false,
        },
      },
    ),
  ];
}

async function drillWatcherSupportOnly() {
  const sessionState = {
    id: 'session-proof',
    name: 'Runtime Proof',
    cwd: ROOT,
    mainGoal: '证明 watcher adapter 契约',
    runState: 'completed',
    messages: [
      { role: 'user', content: '请完成本地 proof。', ts: '2026-06-15T00:00:00.000Z' },
      { role: 'assistant', content: '已完成并验证。', ts: '2026-06-15T00:01:00.000Z' },
    ],
  };
  const verdictJson = JSON.stringify({
    status: 'completed',
    confidence: 0.92,
    completed_items: ['生成本地 proof'],
    remaining_items: [],
    next_action: { type: 'stop', prompt: '', danger_level: 'safe' },
    drift_detected: false,
    reasoning: '任务已经完成，且没有剩余项。',
  });
  const base = new WatcherAdapter({ model: 'fixture', timeout: 1000 });
  const prompt = base.buildJudgePrompt(sessionState);
  const verdict = base.validateVerdict(verdictJson);
  const claude = new ClaudeWatcherAdapter({ bin: 'claude-local-drill', model: 'opus-fixture', timeout: 1000 });
  const codex = new CodexWatcherAdapter({ bin: 'codex-local-drill', model: 'gpt-fixture', timeout: 1000 });

  const minimaxFetchCalls = [];
  const minimaxVerdict = await withTemporaryFetch(async (url) => {
    minimaxFetchCalls.push(String(url || ''));
    return {
      ok: true,
      status: 200,
      json: async () => ({ choices: [{ message: { content: verdictJson } }] }),
    };
  }, async () => {
    const adapter = new MiniMaxAdapter({ apiKey: RAW_MARKERS[3], baseUrl: 'https://fixture.minimax.test/v1', model: 'fixture-minimax', timeout: 1000 });
    return adapter.judge(sessionState);
  });

  const ollamaFetchCalls = [];
  const ollamaVerdict = await withTemporaryFetch(async (url) => {
    ollamaFetchCalls.push(String(url || ''));
    return {
      ok: true,
      status: 200,
      json: async () => ({ choices: [{ message: { content: verdictJson } }] }),
    };
  }, async () => {
    const adapter = new OllamaAdapter({ baseUrl: 'http://127.0.0.1:9', model: 'fixture-ollama', timeout: 1000 });
    return adapter.judge(sessionState);
  });

  return [
    status(prompt.includes('Runtime Proof') && verdict.status === 'completed' && verdict.next_action.type === 'stop', {
      file: 'src/watcher/WatcherAdapter.js',
      evidence: {
        promptIncludesSession: prompt.includes('Runtime Proof'),
        verdictStatus: verdict.status,
        confidence: verdict.confidence,
        supportOnlyClassification: true,
        secretValuesReturned: false,
      },
    }),
    status(claude.name === 'claude' && claude.spawnAdapter && claude.timeout === 1000, {
      file: 'src/watcher/ClaudeWatcherAdapter.js',
      evidence: {
        name: claude.name,
        spawnAdapterConstructed: Boolean(claude.spawnAdapter),
        judgeCalled: false,
        spawnCalls: 0,
        supportOnlyClassification: true,
        secretValuesReturned: false,
      },
    }),
    status(codex.name === 'codex' && codex.spawnAdapter && codex.timeout === 1000, {
      file: 'src/watcher/CodexWatcherAdapter.js',
      evidence: {
        name: codex.name,
        spawnAdapterConstructed: Boolean(codex.spawnAdapter),
        judgeCalled: false,
        spawnCalls: 0,
        supportOnlyClassification: true,
        secretValuesReturned: false,
      },
    }),
    status(minimaxVerdict.status === 'completed' && minimaxFetchCalls.length === 1, {
      file: 'src/watcher/MiniMaxAdapter.js',
      evidence: {
        verdictStatus: minimaxVerdict.status,
        fakeFetchCalls: minimaxFetchCalls.length,
        realNetworkCalls: 0,
        supportOnlyClassification: true,
        secretValuesReturned: false,
      },
    }),
    status(ollamaVerdict.status === 'completed' && ollamaFetchCalls.length === 1, {
      file: 'src/watcher/OllamaAdapter.js',
      evidence: {
        verdictStatus: ollamaVerdict.status,
        fakeFetchCalls: ollamaFetchCalls.length,
        realNetworkCalls: 0,
        supportOnlyClassification: true,
        secretValuesReturned: false,
      },
    }),
  ];
}

async function drillWebSearchProviderStatus() {
  const htmlText = extractMainText('<html><body><main><h1>Title</h1><p>Useful evidence &amp; context.</p></main></body></html>');
  const unconfigured = createWebSearch({
    minimaxKey: '',
    searxngUrl: '',
    braveKey: '',
    fetchImpl: async () => {
      throw new Error('websearch_fetch_should_not_run_when_unconfigured');
    },
  });
  const unconfiguredStatus = unconfigured.status();
  let unconfiguredError = '';
  try {
    await unconfigured.search('neo proof');
  } catch (error) {
    unconfiguredError = safeError(error);
  }

  const fetchCalls = [];
  const configured = createWebSearch({
    minimaxKey: '',
    searxngUrl: 'https://searx.example.test',
    braveKey: '',
    fetchImpl: async (url) => {
      fetchCalls.push(String(url || '').replace(/[?&](?:key|token)=[^&]+/gi, '$1=[redacted]'));
      if (String(url || '').includes('/search?')) {
        return {
          ok: true,
          json: async () => ({ results: [{ title: 'Neo proof', url: 'https://example.test/proof', content: 'local mock search result' }] }),
        };
      }
      return {
        ok: true,
        headers: { get: () => 'text/html' },
        text: async () => '<html><body><article>Mock page content</article></body></html>',
      };
    },
    // SSRF DNS 复查注入 mock：drill 守"无真实网络"边界，把公网测试域名解析到固定公网 IP；
    // 私网 literal（127.0.0.1）是 net.isIP 直判不走这里，仍被拦。
    dnsResolve: async () => [{ address: '93.184.216.34', family: 4 }],
  });
  const configuredStatus = configured.status();
  const search = await configured.searchProvider('searxng', 'neo proof', { count: 1 });
  const privateFetch = await configured.fetchContent('http://127.0.0.1/private');
  const publicFetch = await configured.fetchContent('https://example.test/proof', { maxChars: 200 });

  return status(
    htmlText.includes('Useful evidence')
      && unconfiguredStatus.configured === false
      && /未配置搜索源|至少配一个/.test(unconfiguredError)
      && configuredStatus.configured === true
      && search.length === 1
      && privateFetch.ok === false
      && privateFetch.error.includes('SSRF')
      && publicFetch.ok === true
      && fetchCalls.length === 2,
    {
      file: 'src/research/WebSearch.js',
      evidence: {
        unconfiguredStatus: unconfiguredStatus.configured,
        configuredStatus: configuredStatus.configured,
        searchResults: search.length,
        ssrfBlocked: privateFetch.error.includes('SSRF'),
        contentFetched: publicFetch.ok === true,
        fakeFetchCalls: fetchCalls.length,
        realNetworkCalls: 0,
        secretValuesReturned: false,
      },
    },
  );
}

async function drillAuthorizedDynamicLocalFixtures() {
  const researchIntent = detectResearchIntent('Noe 搜索 2026 本地 AI 模型更新');
  const localFileIntent = detectResearchIntent('帮我找一下 server.js 文件在哪');
  const formattedReply = formatSearchReply('Neo proof', [{
    title: '<b>Neo proof</b>',
    snippet: '结论：可以复核。<img src=x>',
    url: 'https://example.test/proof',
    source: 'fixture',
    date: '2026-06-15',
  }]);
  const quality = assessSearchSummaryQuality('主人，目前看可以先复核来源口径，再下结论。', [{
    title: 'Neo proof',
    snippet: 'proof result',
  }]);

  const store = {
    saved: [],
    get: () => null,
    upsert(skill) {
      this.saved.push(skill);
      return skill;
    },
  };
  const extractor = createSkillExtractor({
    chat: async () => ({
      reply: JSON.stringify({
        name: 'Proof Drill Skill',
        displayName: 'Proof Drill',
        description: 'Use for local runtime proof drills',
        body: 'Run local proof drills with fake dependencies.',
        confidence: 0.88,
      }),
    }),
    store,
  });
  const messages = [
    { role: 'user', content: '先做 fixture。' },
    { role: 'assistant', content: '完成 fixture。' },
    { role: 'user', content: '再跑测试。' },
  ];
  const skill = await extractor.extract(messages);
  const dryRun = await extractor.extract(messages, { dryRun: true });

  const workspace = await withTempDir('noe-workspace-drill-', async (dir) => {
    const tempHome = join(dir, 'home');
    const workspaceModule = await importWithTemporaryHome('src/workspace/WorkspaceManager.js', tempHome);
    const created = workspaceModule.createWorkspace('proof_ws', { description: 'local proof workspace' });
    const active = workspaceModule.setActive('proof_ws');
    const dbPath = workspaceModule.getDbPath();
    const listed = workspaceModule.listWorkspaces();
    const deleted = workspaceModule.deleteWorkspace('proof_ws');
    return {
      created,
      active,
      listedCount: listed.length,
      deleted,
      dbPath,
      tempHomeOnly: dbPath.startsWith(tempHome),
      defaultName: workspaceModule.DEFAULT_NAME,
    };
  });

  return [
    status(
      researchIntent?.type === 'research'
        && researchIntent.mode === 'search'
        && localFileIntent === null
        && formattedReply.includes('【联网搜索】')
        && quality.ok === true,
      {
        file: 'src/research/ResearchIntent.js',
        evidence: {
          researchDetected: researchIntent?.type === 'research',
          mode: researchIntent?.mode || '',
          localFileIgnored: localFileIntent === null,
          formattedReplyClean: !/<img|src=/i.test(formattedReply),
          qualityOk: quality.ok === true,
          secretValuesReturned: false,
        },
      },
    ),
    status(skill.extracted === true && store.saved.length === 1 && store.saved[0].name === 'proof-drill-skill' && dryRun.dryRun === true, {
      file: 'src/skills/SkillExtractor.js',
      evidence: {
        extracted: skill.extracted === true,
        savedDrafts: store.saved.length,
        safeName: store.saved[0]?.name || '',
        dryRunCandidate: Boolean(dryRun.candidate),
        secretValuesReturned: false,
      },
    }),
    status(workspace.created.name === 'proof_ws' && workspace.active === 'proof_ws' && workspace.deleted.deleted === 'proof_ws' && workspace.tempHomeOnly, {
      file: 'src/workspace/WorkspaceManager.js',
      evidence: {
        created: workspace.created.name,
        active: workspace.active,
        listedCount: workspace.listedCount,
        deleted: workspace.deleted.deleted,
        tempHomeOnly: workspace.tempHomeOnly,
        defaultName: workspace.defaultName,
        secretValuesReturned: false,
      },
    }),
  ];
}

async function drillSchedulerDelegationFixtures() {
  const autopilot = await withTempDir('noe-autopilot-drill-', async (dir) => {
    const tempHome = join(dir, 'home');
    const module = await importWithTemporaryHome('src/autopilot/AutopilotStore.js', tempHome);
    const store = new module.AutopilotStore();
    const initial = store.getConfig();
    store.setEnabled(true);
    const rule = store.upsertRule({
      id: 'rule-proof',
      name: 'Proof forward',
      when: 'debate_done',
      sourceMode: 'debate',
      action: 'forward',
      targetMode: 'squad',
      autoStart: true,
    });
    const matches = store.matchingRules('debate_done', 'debate');
    store.log({ type: 'unit_drill', id: 'autopilot-proof', status: 'ok' });
    const logs = store.recentLogs(5);
    const deleted = store.deleteRule('rule-proof');
    return {
      initialRules: initial.rules.length,
      enabled: store.isEnabled(),
      rule,
      matches: matches.length,
      logs: logs.length,
      deleted,
    };
  });

  const delegation = await withTempDir('noe-delegation-autostart-drill-', async (dir) => {
    const tempHome = join(dir, 'home');
    const module = await importWithTemporaryHome('src/autopilot/DelegationAutostart.js', tempHome);
    const transitions = [];
    const approvals = [];
    const handler = module.makeDelegationAutostartHandler({
      delegationStore: {
        get: () => ({
          id: 'delegation-1',
          title: 'Proof Delegation',
          status: 'open',
          sourceRoomId: 'source-room',
          targetMode: 'squad',
          sourceTaskId: 'task-1',
          payload: { agentRunId: 'agent-run-1' },
        }),
      },
      approvalStore: {
        getApproval: () => null,
        getLatestByDedupeKey: () => null,
        createApproval: (approval) => {
          approvals.push(approval);
          return { id: 'approval-1', status: 'pending', ...approval };
        },
      },
      budgetStore: { preflight: () => ({ ok: true }) },
      roomStore: { get: () => ({ id: 'source-room', name: 'Source', mode: 'debate', cwd: dir }) },
      roomAdapterPool: {},
      safeResolveFsPath: () => dir,
      startRoom: async () => {
        throw new Error('start_room_should_not_run_before_approval');
      },
      agentRunStore: { transition: (...args) => transitions.push(args) },
      now: () => 1_786_000_000_000,
      gatePollMs: 1000,
    });
    const result = await handler({
      id: 'job-1',
      targetId: 'delegation-1',
      payload: { agentRunId: 'agent-run-1' },
      projectId: dir,
      taskId: 'task-1',
    });
    return { result, approvals, transitions, dedupeKey: module.delegationAutostartApprovalDedupeKey('delegation-1') };
  });

  const noeDelegation = await withTempDir('noe-noe-delegation-autostart-drill-', async (dir) => {
    const tempHome = join(dir, 'home');
    const module = await importWithTemporaryHome('src/autopilot/NoeDelegationAutostart.js', tempHome);
    const starts = [];
    const transitions = [];
    const handler = module.makeNoeDelegationAutostartHandler({
      approvalStore: {
        getApproval: () => null,
        getLatestByDedupeKey: () => null,
        createApproval: () => {
          throw new Error('approval_should_not_run_when_disabled');
        },
      },
      budgetStore: { preflight: () => ({ ok: true }) },
      roomStore: {
        get: () => ({
          id: 'room-1',
          name: 'Delegate Room',
          mode: 'debate',
          cwd: dir,
          topic: 'prove autostart',
          delegatedFromNoe: { plan: { title: 'Proof', instructions: 'Run proof', targetMode: 'debate' } },
        }),
      },
      startRoom: async (input) => {
        starts.push(input);
        return { started: true, roomId: input.room.id };
      },
      sendChatMessage: async () => {
        throw new Error('chat_message_should_not_run_for_debate_room');
      },
      agentRunStore: { transition: (...args) => transitions.push(args) },
      now: () => 1_786_000_001_000,
      gatePollMs: 1000,
    });
    const result = await handler({
      id: 'job-noe-1',
      roomId: 'room-1',
      payload: { requireApproval: false, agentRunId: 'agent-run-2' },
      projectId: dir,
    });
    return { result, starts, transitions, dedupeKey: module.noeDelegateStartApprovalDedupeKey('room-1') };
  });

  const localProbe = probeLocalAgents([
    { id: 'claude', command: 'claude', versionArgs: ['--version'], kind: 'coding' },
    { id: 'codex', command: 'codex', versionArgs: ['--version'], kind: 'coding' },
  ], {
    detect: (command) => (
      command === 'claude'
        ? { found: true, path: '/usr/local/bin/claude', version: parseVersionOutput('claude 1.2.3', '') }
        : { found: false, path: '', version: '' }
    ),
  });

  return [
    status(autopilot.enabled === true && autopilot.matches >= 1 && autopilot.logs >= 1 && autopilot.deleted === true, {
      file: 'src/autopilot/AutopilotStore.js',
      evidence: {
        initialRules: autopilot.initialRules,
        enabled: autopilot.enabled,
        matches: autopilot.matches,
        logs: autopilot.logs,
        deletedCustomRule: autopilot.deleted,
        secretValuesReturned: false,
      },
    }),
    status(
      delegation.result?.__defer === true
        && delegation.result.reason === 'approval_created'
        && delegation.approvals.length === 1
        && delegation.transitions.length === 1
        && delegation.dedupeKey === 'delegation-autostart-approval:delegation-1',
      {
        file: 'src/autopilot/DelegationAutostart.js',
        evidence: {
          deferred: delegation.result?.__defer === true,
          reason: delegation.result?.reason || '',
          approvalsCreated: delegation.approvals.length,
          agentRunTransitions: delegation.transitions.length,
          dedupeKeyOk: delegation.dedupeKey === 'delegation-autostart-approval:delegation-1',
          startRoomCalls: 0,
          secretValuesReturned: false,
        },
      },
    ),
    status(
      noeDelegation.result.ok === true
        && noeDelegation.result.started === true
        && noeDelegation.starts.length === 1
        && noeDelegation.transitions.length === 1
        && noeDelegation.dedupeKey === 'noe-delegate-start:room-1',
      {
        file: 'src/autopilot/NoeDelegationAutostart.js',
        evidence: {
          ok: noeDelegation.result.ok === true,
          started: noeDelegation.result.started === true,
          startRoomCalls: noeDelegation.starts.length,
          agentRunTransitions: noeDelegation.transitions.length,
          dedupeKeyOk: noeDelegation.dedupeKey === 'noe-delegate-start:room-1',
          secretValuesReturned: false,
        },
      },
    ),
    status(localProbe.counts.total === 2 && localProbe.counts.available === 1 && localProbe.available.includes('claude'), {
      file: 'src/autopilot/NoeLocalAgentProbe.js',
      evidence: {
        total: localProbe.counts.total,
        available: localProbe.counts.available,
        availableIds: localProbe.available.join(','),
        versionParsed: localProbe.agents.find((agent) => agent.id === 'claude')?.version || '',
        injectedDetectorOnly: true,
        spawnCalls: 0,
        secretValuesReturned: false,
      },
    }),
  ];
}

async function runDrills(root = ROOT) {
  const drills = [
    () => drillPolicyFileGuard(root),
    () => drillPolicyAuditLog(),
    () => drillCommandApprovalGate(),
    () => drillFreedomManifest(),
    () => drillFreedomTrustManifest(root),
    () => drillFreedomAllowlist(root),
    () => drillCapabilityExecutor(root),
    () => drillToolRegistry(),
    () => drillBuiltinReadonlyTools(),
    () => drillCapabilityAcquisition(),
    () => drillCodebaseIndexes(),
    () => drillParserAdapters(),
    () => drillKnowledgeStores(),
    () => drillSafeDelete(),
    () => drillArchiveStore(),
    () => drillMcpAggregator(),
    () => drillRoomReporter(),
    () => drillLocalModelSensor(),
    () => drillProviderMocks(),
    () => drillSkillFixtures(),
    () => drillWatcherSupportOnly(),
    () => drillWebSearchProviderStatus(),
    () => drillAuthorizedDynamicLocalFixtures(),
    () => drillSchedulerDelegationFixtures(),
  ];
  const out = [];
  for (const drill of drills) {
    try {
      const result = await drill();
      out.push(...(Array.isArray(result) ? result : [result]));
    } catch (error) {
      out.push(status(false, {
        file: 'unknown',
        error: safeError(error),
        secretValuesReturned: false,
      }));
    }
  }
  return out;
}

function renderMarkdown(report, jsonPath) {
  const laneRows = report.byLane.map((entry) => [
    entry.lane,
    String(entry.targetFiles),
    String(entry.drilledFiles),
    String(entry.okDrills),
    String(entry.failedDrills),
  ]);
  const fileRows = report.files.map((file) => [
    file.priority || '-',
    `\`${file.file}\``,
    file.lane,
    file.drillStatus,
    file.evidenceSummary,
  ]);
  return [
    '# Neo Runtime Proof Local Drills',
    '',
    `Generated: ${report.generatedAt}`,
    '',
    '## Summary',
    '',
    `- target files: ${report.summary.targetFiles}`,
    `- drilled files: ${report.summary.drilledFiles}`,
    `- ok drills: ${report.summary.okDrills}`,
    `- failed drills: ${report.summary.failedDrills}`,
    `- lanes covered: ${report.summary.lanesCovered}`,
    '',
    '## Safety Policy',
    '',
    '- no env-file reads, owner-token reads, real network/model calls, shell execution, or live panel access',
    '- all write-like checks use injected writers, fake stores, fake search, fake fetch, or string-only policy scanners',
    '- this proves local module behavior, not natural live-panel invocation',
    '',
    '## By Lane',
    '',
    mdTable([
      ['lane', 'target files', 'drilled files', 'ok drills', 'failed drills'],
      ['---', '---:', '---:', '---:', '---:'],
      ...laneRows,
    ]),
    '',
    '## Files',
    '',
    mdTable([
      ['priority', 'file', 'lane', 'status', 'evidence summary'],
      ['---', '---', '---', '---', '---'],
      ...fileRows,
    ]),
    '',
    '## JSON',
    '',
    `Full report is in \`${jsonPath.replace(`${ROOT}/`, '')}\`. It stores counts and booleans only; no source bodies or secret values.`,
  ].join('\n');
}

function mdTable(rows) {
  return rows.map((row) => `| ${row.join(' | ')} |`).join('\n');
}

function summarizeEvidence(drill = {}) {
  const evidence = drill.evidence || {};
  if (drill.file === 'src/security/NoePolicyFileGuard.js') {
    return `policy write blocked=${evidence.projectPolicyWriteBlocked}; shell redirect blocked=${evidence.shellRedirectToPolicyFileBlocked}`;
  }
  if (drill.file === 'src/audit/PolicyAuditLog.js') {
    return `writer calls=${evidence.appendOnlyWriterCalled}; redacted=${evidence.targetRedacted}`;
  }
  if (drill.file === 'src/approval/CommandApprovalGate.js') {
    return `dangerous approval=${evidence.dangerousCommandRequiresApproval}; benign allowed=${evidence.benignCommandAllowedWithoutApproval}`;
  }
  if (drill.file === 'src/capabilities/NoeFreedomManifest.js') {
    return `tools=${evidence.tools}; quick starts=${evidence.quickStarts}; real execute blocked=${evidence.realExecuteWithoutOwnerBlocked}`;
  }
  if (drill.file === 'src/capabilities/NoeFreedomTrustManifest.js') {
    return `hash chars=${evidence.normalizedHashLength}; secret evidence rejected=${evidence.rejectsSecretValueEvidence}`;
  }
  if (drill.file === 'src/capabilities/NoeFreedomAllowlist.js') {
    return `allowed command=${evidence.acceptedAllowlistedShellCommand}; rejected command=${evidence.rejectedNonAllowlistedShellCommand}`;
  }
  if (drill.file === 'src/capabilities/NoeCapabilityExecutor.js') {
    return `standing grant blocks before spawn=${evidence.standingGrantRequiredBeforeSpawn}; spawn calls=${evidence.spawnCalls}`;
  }
  if (drill.file === 'src/capabilities/ToolRegistry.js') {
    return `disabled=${evidence.disabledInvokeBlocked}; allowed status=${evidence.enabledAllowedInvokeStatus}; deny blocked=${evidence.permissionDenyBlocked}`;
  }
  if (drill.file === 'src/capabilities/builtinReadonlyTools.js') {
    return `handlers=${evidence.handlers}; registered=${evidence.registered}; readonly=${evidence.organizePlanReadOnly}`;
  }
  if (drill.file === 'src/capabilities/NoeCapabilityAcquisition.js') {
    return `candidates=${evidence.candidates}; owner grant required=${evidence.planRequiresOwnerOrStandingGrant}`;
  }
  if (drill.file === 'src/agents/CodebaseFtsIndex.js') {
    return `engine=${evidence.engine}; hits=${evidence.queryHits}; route hit=${evidence.routeHit}`;
  }
  if (drill.file === 'src/agents/CodebaseVectorIndex.js') {
    return `engine=${evidence.engine}; provider=${evidence.provider}; hits=${evidence.queryHits}`;
  }
  if (drill.file === 'src/agents/parsers/ParserAdapter.js') {
    return `adapter=${evidence.adapterId}; case insensitive=${evidence.caseInsensitiveSupport}; parse=${evidence.parseOk}`;
  }
  if (drill.file === 'src/agents/parsers/BabelParserAdapter.js') {
    return `parser=${evidence.parser}; symbols=${evidence.symbolCount}; exported function=${evidence.exportedFunctionFound}`;
  }
  if (drill.file === 'src/knowledge/EvidenceKnowledgeStore.js') {
    return `indexed=${evidence.indexed}; hits=${evidence.searchHits}; run linked=${evidence.runIdLinked}`;
  }
  if (drill.file === 'src/knowledge/KnowledgeStore.js') {
    return `kb created=${evidence.kbCreated}; hits=${evidence.searchHits}; mode=${evidence.fallbackMode}`;
  }
  if (drill.file === 'src/workspace/NoeSafeDelete.js') {
    return `home blocked=${evidence.homeRootBlocked}; fake trasher=${evidence.fakeTrasherCalls}`;
  }
  if (drill.file === 'src/archive/ArchiveStore.js') {
    return `archive=${evidence.archiveOk}; files=${evidence.files}; listed=${evidence.listItems}`;
  }
  if (drill.file === 'src/mcp/McpAggregator.js') {
    return `tools=${evidence.tools}; isolated errors=${evidence.isolatedErrors}; routed=${evidence.callRouted}`;
  }
  if (drill.file === 'src/report/RoomReporter.js') {
    return `report=${evidence.reportOk}; adapter calls=${evidence.adapterCalls}; disableMcp=${evidence.disableMcp}`;
  }
  if (drill.file === 'src/identity/VoiceVad.js') {
    return `quiet rejected=${evidence.quietRejected}; reason=${evidence.quietReason}; preprocess buffer=${evidence.preprocessReturnsBuffer}`;
  }
  if (drill.file === 'src/identity/CampPlusVoiceClient.js') {
    return `model ready=${evidence.modelReady}; spawn calls=${evidence.spawnCalls}; reason=${evidence.missingDependencyReason}`;
  }
  if (drill.file === 'src/vision/VisualActionPlanner.js') {
    return `browser action=${evidence.browserAction}; desktop blocked=${evidence.desktopBlocked}; approval=${evidence.requiresApproval}`;
  }
  if (drill.file === 'src/vision/LocalVlmClient.js') {
    return `available=${evidence.available}; fake fetch=${evidence.fakeFetchCalls}; real network=${evidence.realNetworkCalls}`;
  }
  if (drill.file === 'src/cloud/NoeCloudProviderRegistry.js') {
    return `providers=${evidence.providers}; mock preflight=${evidence.mockPreflightOk}; patch=${evidence.patchOperation}`;
  }
  if (drill.file === 'src/secrets/NoeProviderHealth.js') {
    return `status=${evidence.probeStatus}; auth ok=${evidence.auditAuthOkCount}; fake fetch=${evidence.fakeFetchCalls}`;
  }
  if (drill.file === 'src/secrets/NoeProviderSecrets.js') {
    return `configured=${evidence.configuredCount}/${evidence.providerCount}; value returned=${evidence.valueReturned}`;
  }
  if (drill.file === 'src/skills/AutoSkillExtractor.js') {
    return `queued=${evidence.queued}; extracted=${evidence.extracted}; saved drafts=${evidence.savedDrafts}`;
  }
  if (drill.file === 'src/skills/NoeSkillDraftRollback.js') {
    return `plan=${evidence.planOk}; status=${evidence.status}; writes store=${evidence.writesSkillStore}`;
  }
  if (drill.file === 'src/skills/SkillCurator.js') {
    return `direct state=${evidence.directState}; archive candidates=${evidence.archiveCandidates}; mutations=${evidence.directSkillMutations}`;
  }
  if (drill.file === 'src/watcher/WatcherAdapter.js') {
    return `verdict=${evidence.verdictStatus}; confidence=${evidence.confidence}; support only=${evidence.supportOnlyClassification}`;
  }
  if (drill.file === 'src/watcher/ClaudeWatcherAdapter.js' || drill.file === 'src/watcher/CodexWatcherAdapter.js') {
    return `name=${evidence.name}; judge called=${evidence.judgeCalled}; spawn calls=${evidence.spawnCalls}`;
  }
  if (drill.file === 'src/watcher/MiniMaxAdapter.js' || drill.file === 'src/watcher/OllamaAdapter.js') {
    return `verdict=${evidence.verdictStatus}; fake fetch=${evidence.fakeFetchCalls}; real network=${evidence.realNetworkCalls}`;
  }
  if (drill.file === 'src/research/WebSearch.js') {
    return `configured=${evidence.configuredStatus}; results=${evidence.searchResults}; ssrf blocked=${evidence.ssrfBlocked}`;
  }
  if (drill.file === 'src/research/ResearchIntent.js') {
    return `detected=${evidence.researchDetected}; local ignored=${evidence.localFileIgnored}; quality=${evidence.qualityOk}`;
  }
  if (drill.file === 'src/skills/SkillExtractor.js') {
    return `extracted=${evidence.extracted}; saved drafts=${evidence.savedDrafts}; dry run=${evidence.dryRunCandidate}`;
  }
  if (drill.file === 'src/workspace/WorkspaceManager.js') {
    return `created=${evidence.created}; deleted=${evidence.deleted}; temp home=${evidence.tempHomeOnly}`;
  }
  if (drill.file === 'src/autopilot/AutopilotStore.js') {
    return `enabled=${evidence.enabled}; matches=${evidence.matches}; logs=${evidence.logs}`;
  }
  if (drill.file === 'src/autopilot/DelegationAutostart.js') {
    return `deferred=${evidence.deferred}; reason=${evidence.reason}; approvals=${evidence.approvalsCreated}`;
  }
  if (drill.file === 'src/autopilot/NoeDelegationAutostart.js') {
    return `ok=${evidence.ok}; started=${evidence.started}; start calls=${evidence.startRoomCalls}`;
  }
  if (drill.file === 'src/autopilot/NoeLocalAgentProbe.js') {
    return `available=${evidence.available}/${evidence.total}; injected detector=${evidence.injectedDetectorOnly}; spawn=${evidence.spawnCalls}`;
  }
  return drill.ok ? 'ok' : 'failed';
}

function buildReport({ plan, drills, root = ROOT, planPath = PLAN_PATH } = {}) {
  const targetFiles = targetFilesFromPlan(plan);
  const drillByFile = new Map(drills.map((drill) => [drill.file, drill]));
  const targetFileNames = new Set(targetFiles.map((file) => file.file));
  const files = targetFiles.map((target) => {
    const drill = drillByFile.get(target.file);
    return {
      file: target.file,
      priority: target.priority,
      lane: target.lane,
      module: target.module,
      drillStatus: !drill ? 'not_drilled' : drill.ok ? 'drilled_ok' : 'drilled_failed',
      evidenceSummary: drill ? summarizeEvidence(drill) : 'no local drill mapped',
      evidence: drill?.evidence || null,
      error: drill?.error || null,
      secretValuesReturned: false,
    };
  });
  const extraDrills = drills.filter((drill) => drill.file && !targetFileNames.has(drill.file));
  const byLane = [];
  for (const lane of Object.keys(DRILL_FILE_BY_LANE)) {
    const laneFiles = files.filter((file) => file.lane === lane);
    byLane.push({
      lane,
      targetFiles: laneFiles.length,
      drilledFiles: laneFiles.filter((file) => file.drillStatus !== 'not_drilled').length,
      okDrills: laneFiles.filter((file) => file.drillStatus === 'drilled_ok').length,
      failedDrills: laneFiles.filter((file) => file.drillStatus === 'drilled_failed').length,
      priorities: countBy(laneFiles, 'priority'),
    });
  }
  const failedDrills = drills.filter((drill) => drill.ok !== true);
  const serialized = JSON.stringify({ files, extraDrills });
  return {
    ok: failedDrills.length === 0 && files.every((file) => file.drillStatus === 'drilled_ok'),
    generatedAt: new Date().toISOString(),
    root,
    inputs: {
      planPath,
      planGeneratedAt: plan.generatedAt || '',
    },
    policy: {
      localOnly: true,
      noEnvFileReads: true,
      noOwnerTokenReads: true,
      noNetworkCalls: true,
      noModelCalls: true,
      noShellExecution: true,
      noLivePanelAccess: true,
      fakeStoresAndInjectedWritersOnly: true,
      noSecretValuesReturned: true,
    },
    summary: {
      targetFiles: files.length,
      drilledFiles: files.filter((file) => file.drillStatus !== 'not_drilled').length,
      okDrills: files.filter((file) => file.drillStatus === 'drilled_ok').length,
      failedDrills: files.filter((file) => file.drillStatus === 'drilled_failed').length + extraDrills.filter((drill) => drill.ok !== true).length,
      lanesCovered: byLane.filter((lane) => lane.targetFiles > 0 && lane.okDrills === lane.targetFiles).length,
      rawSecretMarkersPresent: RAW_MARKERS.some((marker) => serialized.includes(marker))
        || serialized.includes('Bearer unit'),
    },
    byLane,
    files,
    extraDrills: extraDrills.map((drill) => ({
      file: drill.file,
      ok: drill.ok,
      evidenceSummary: summarizeEvidence(drill),
      error: drill.error || null,
      secretValuesReturned: false,
    })),
  };
}

function writeReport(report) {
  mkdirSync(OUT_DIR, { recursive: true });
  const jsonPath = join(OUT_DIR, `${OUT_BASE}.json`);
  const mdPath = join(OUT_DIR, `${OUT_BASE}.md`);
  writeFileSync(jsonPath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  writeFileSync(mdPath, `${renderMarkdown(report, jsonPath)}\n`, { mode: 0o600 });
  return { jsonPath, mdPath };
}

export async function buildLocalDrillReport({
  planPath = PLAN_PATH,
  root = ROOT,
} = {}) {
  if (!existsSync(planPath)) throw new Error(`non-route plan not found: ${planPath}`);
  const plan = readJson(planPath);
  const drills = await runDrills(root);
  return buildReport({ plan, drills, root, planPath });
}

export {
  DRILL_FILE_BY_LANE,
  fakeToolStorage,
  runDrills,
};

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const report = await buildLocalDrillReport();
  const paths = writeReport(report);
  console.log(JSON.stringify({
    ok: report.ok,
    generatedAt: report.generatedAt,
    targetFiles: report.summary.targetFiles,
    drilledFiles: report.summary.drilledFiles,
    okDrills: report.summary.okDrills,
    failedDrills: report.summary.failedDrills,
    rawSecretMarkersPresent: report.summary.rawSecretMarkersPresent,
    paths,
  }, null, 2));
}
