#!/usr/bin/env node
// @ts-check
// Targeted local drills for weak server/service candidates.
// Each module runs in an isolated Node subprocess with HOME pointing at a temp dir.
// It does not read project .env, owner tokens, real ~/.noe-panel data, DBs, network, or models.

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = process.env.NOE_WEAK_SERVER_TARGETED_DRILLS_OUT_DIR || join(ROOT, 'output', 'noe-audit');
const OUT_BASE = process.env.NOE_WEAK_SERVER_TARGETED_DRILLS_BASENAME || 'weak-server-targeted-local-drills-2026-06-15';

const DEFAULT_PATHS = {
  weakRuntimeRemainingLaneAudit: join(ROOT, 'output', 'noe-audit', 'weak-runtime-remaining-lane-audit-2026-06-15.json'),
};

function arr(value) {
  return Array.isArray(value) ? value : [];
}

function readJson(path) {
  if (!path || !existsSync(path)) return {};
  return JSON.parse(readFileSync(path, 'utf8'));
}

function rel(path) {
  return String(path || '').replace(`${ROOT}/`, '');
}

function clean(value = '', max = 240) {
  return String(value ?? '')
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+/g, '[email]')
    .replace(/Bearer\s+\S+/gi, 'Bearer [key]')
    .replace(/token[=:]\S+/gi, 'token=[redacted]')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

function inc(counts, key, amount = 1) {
  counts[key] = (counts[key] || 0) + amount;
}

function okFile(file, lane, evidence = {}, remainingNeed = '') {
  return {
    file,
    lane,
    drillStatus: 'drilled_ok',
    evidence,
    remainingNeed,
  };
}

function failedFile(file, lane, reason = '', evidence = {}, remainingNeed = '') {
  return {
    file,
    lane,
    drillStatus: 'failed',
    evidence: {
      ...evidence,
      reason: clean(reason, 400),
    },
    remainingNeed,
  };
}

function targetFilesFromLaneAudit(laneAudit = {}) {
  return arr(laneAudit.files).filter((file) => [
    'server_boot_imported_natural_runtime_needed',
    'server_service_chain_managed_smoke_needed',
  ].includes(file.lane));
}

function childEnv(tempHome, tempRoot) {
  return {
    PATH: process.env.PATH || '/usr/bin:/bin',
    HOME: tempHome,
    TMPDIR: tempRoot,
    NOE_DRILL_TEMP: tempRoot,
    NODE_ENV: 'test',
    NOE_WEAK_SERVER_DRILL: '1',
  };
}

function runIsolatedDrill({ file, lane, tempRoot, code }) {
  const home = mkdtempSync(join(tempRoot, 'home-'));
  const runDir = mkdtempSync(join(tempRoot, 'run-'));
  const result = spawnSync(process.execPath, ['--input-type=module', '--eval', code], {
    cwd: ROOT,
    env: childEnv(home, runDir),
    encoding: 'utf8',
    maxBuffer: 1024 * 1024,
    timeout: 15_000,
  });
  if (result.error) {
    return failedFile(file, lane, result.error.message, { isolatedHome: true, tempOnly: true }, 'rerun or inspect module import side effects');
  }
  if (result.status !== 0) {
    return failedFile(file, lane, result.stderr || result.stdout || `exit ${result.status}`, {
      isolatedHome: true,
      tempOnly: true,
      exitStatus: result.status,
    }, 'rerun or inspect module import side effects');
  }
  try {
    const evidence = JSON.parse(String(result.stdout || '').trim() || '{}');
    return okFile(file, lane, {
      isolatedHome: true,
      tempOnly: true,
      ...evidence,
    }, 'component contract drilled locally; natural live-panel invocation still needs runtime cadence or managed server evidence');
  } catch (error) {
    return failedFile(file, lane, `invalid drill json: ${error?.message || error}`, {
      isolatedHome: true,
      tempOnly: true,
      stdout: clean(result.stdout, 400),
    }, 'fix drill output before relying on this proof');
  }
}

function drillCodeFor(file) {
  const snippets = {
    'src/metrics/MetricsStore.js': `
      import { join } from 'node:path';
      import { MetricsStore } from './src/metrics/MetricsStore.js';
      const auditEvents = [];
      const budgetMetrics = [];
      const agentMetrics = [];
      const store = new MetricsStore({
        dir: join(process.env.NOE_DRILL_TEMP, 'metrics'),
        logger: null,
        audit: { recordSafe: (event) => auditEvents.push(event.action) },
        budgetStore: { recordMetric: (metric) => { budgetMetrics.push(metric.adapter); return { incidents: [] }; } },
        agentRuns: { recordMetricTurn: (metric) => agentMetrics.push(metric.turn) },
      });
      const broadcasts = [];
      store.attachBroadcast((payload) => broadcasts.push(payload.type));
      const metric = store.record({
        roomId: 'room-1',
        roomMode: 'chat',
        adapter: 'local',
        model: 'unit-model',
        latencyMs: 12,
        tokensIn: 10,
        tokensOut: 20,
        success: true,
        turn: 'assistant',
      });
      const rows = store.query({ roomId: 'room-1' });
      const aggregate = store.aggregate({ bucket: 'day' });
      const byAdapter = store.byAdapter({});
      console.log(JSON.stringify({
        recorded: metric?.adapter === 'local',
        queryRows: rows.length,
        aggregateBuckets: aggregate.series.length,
        byAdapterCount: byAdapter.length,
        auditEvents: auditEvents.length,
        budgetMetrics: budgetMetrics.length,
        agentMetrics: agentMetrics.length,
        broadcasts: broadcasts.length,
      }));
    `,
    'src/mcp/McpStore.js': `
      import { join } from 'node:path';
      import { McpStore } from './src/mcp/McpStore.js';
      const fakeSecretValue = ['unit', 'test', 'redacted', 'value'].join('-');
      const store = new McpStore({ file: join(process.env.NOE_DRILL_TEMP, 'mcp-servers.json') });
      const created = store.create({
        name: 'unitfs',
        type: 'stdio',
        command: 'node',
        args: ['server.js'],
        env: { API_KEY: fakeSecretValue, SAFE_FLAG: '1' },
      });
      const masked = store.list({ mask: true })[0];
      const updated = store.update('unitfs', { enabled: false });
      const denied = (() => { try { store.create({ name: 'bad', type: 'stdio', command: 'rm' }); return false; } catch { return true; } })();
      console.log(JSON.stringify({
        created: created.name === 'unitfs',
        maskedSecret: masked.env.API_KEY !== fakeSecretValue,
        safeFlagVisible: masked.env.SAFE_FLAG === '1',
        updatedDisabled: updated.enabled === false,
        deniedDangerousCommand: denied,
        count: store.list({ mask: true }).length,
      }));
    `,
    'src/templates/RoomTemplatesStore.js': `
      import { RoomTemplatesStore } from './src/templates/RoomTemplatesStore.js';
      const store = new RoomTemplatesStore();
      const before = store.list().length;
      const created = store.create({
        name: 'Unit Template',
        mode: 'chat',
        description: 'unit',
        preset: { members: [{ adapterId: 'codex', displayName: 'Codex' }], topicPlaceholder: 'topic' },
      });
      const fetched = store.get(created.id);
      const deleted = store.delete(created.id);
      console.log(JSON.stringify({
        builtinTemplates: before,
        createdUserTemplate: created.id.startsWith('user:'),
        fetched: fetched?.id === created.id,
        deleted,
        countAfterDelete: store.list().length,
      }));
    `,
    'src/webhook/WebhookStore.js': `
      import { join } from 'node:path';
      import { WebhookStore, maskWebhookUrl } from './src/webhook/WebhookStore.js';
      const fakeSecretValue = ['unit', 'test', 'redacted', 'value'].join('-');
      const store = new WebhookStore({ file: join(process.env.NOE_DRILL_TEMP, 'webhooks.json') });
      const created = store.create({
        name: 'Local Webhook',
        url: 'http://127.0.0.1:9999/hooks/unit-long-path-token?token=' + fakeSecretValue,
        format: 'json',
        events: ['room_done'],
        headers: { 'X-Unit': '1', Host: 'blocked' },
      });
      const masked = store.list({ mask: true })[0];
      store.bumpStats(created.id, false, 'unit error');
      const stats = store.get(created.id).stats;
      console.log(JSON.stringify({
        created: created.id.startsWith('wh-'),
        maskedUrl: masked.url !== created.url && !masked.url.includes(fakeSecretValue),
        headerSanitized: created.headers.Host === undefined,
        statsUpdated: stats.errorCount === 1,
        maskHelper: !maskWebhookUrl(created.url).includes(fakeSecretValue),
      }));
    `,
    'src/watcher/WatcherDispatcher.js': `
      import { WatcherDispatcher } from './src/watcher/WatcherDispatcher.js';
      const broadcasts = [];
      const persisted = [];
      const adapter = {
        name: 'unit-adapter',
        judge: async () => ({
          drift_detected: false,
          confidence: 0.9,
          reasoning: 'ok',
          next_action: { type: 'continue', prompt: 'continue safely' },
          completed_items: [],
          remaining_items: [],
        }),
      };
      const dispatcher = new WatcherDispatcher({
        adapter,
        config: {
          enabled: true,
          autoMode: true,
          triggers: { minIntervalSec: 0 },
          rateLimit: { perSessionPerHour: 5, globalPerHour: 5 },
          safety: { dangerScanNextAction: true, blockOnDrift: true, maxAutoPromptsPerSession: 2 },
        },
        broadcastFn: (_session, msg) => broadcasts.push(msg.type),
        dangerDetector: { scan: () => [], shouldBlock: () => false },
        persistSession: (session) => persisted.push(session.id),
      });
      const session = { id: 's1', name: 'Session', watcherEnabled: true, mode: 'chat', messages: [], runState: 'idle' };
      const result = await dispatcher.onResultEvent(session, { is_error: false });
      console.log(JSON.stringify({
        autoExecute: result?.autoExecute === true,
        prompt: result?.prompt === 'continue safely',
        verdictBroadcast: broadcasts.includes('watcher_verdict'),
        judgingBroadcast: broadcasts.includes('watcher_judging'),
        persisted: persisted.length === 1,
        history: session.watcherHistory?.length || 0,
      }));
    `,
    'src/prefetch/NoePrefetchStore.js': `
      import { createPrefetchStore } from './src/prefetch/NoePrefetchStore.js';
      const store = createPrefetchStore({ defaultTtlMs: 1000 });
      store.set('weather', { temp: 22 }, undefined, 0);
      store.set('old', 'stale', 100, 0);
      const block = store.toContextBlock(500);
      const removed = store.prune(500);
      console.log(JSON.stringify({
        hitFresh: store.get('weather', 500)?.temp === 22,
        stalePruned: removed === 1,
        blockWrapped: block.includes('<prefetched-items>') && block.includes('[weather]'),
        size: store.size(),
      }));
    `,
    'src/webhook/WebhookDispatcher.js': `
      import { buildPayload } from './src/webhook/WebhookDispatcher.js';
      const discord = buildPayload('discord', {
        roomName: 'Unit Room',
        mode: 'chat',
        eventCategory: 'room_done',
        eventType: 'chat_done',
        summary: 'completed',
        panelUrl: 'http://localhost:51835',
      });
      const json = buildPayload('json', {
        roomName: 'Unit Room',
        mode: 'chat',
        eventCategory: 'room_error',
        eventType: 'chat_error',
        error: 'failed',
      });
      console.log(JSON.stringify({
        discordEmbed: Array.isArray(discord.embeds) && discord.embeds.length === 1,
        jsonEvent: json.event === 'room_error',
        bodyCapped: String(discord.embeds[0].description || '').length <= 1500,
      }));
    `,
    'src/autopilot/AutopilotController.js': `
      import { AutopilotController } from './src/autopilot/AutopilotController.js';
      import { autopilotStore } from './src/autopilot/AutopilotStore.js';
      autopilotStore.setEnabled(true);
      autopilotStore.upsertRule({
        id: 'rule-unit-notify',
        name: 'Unit notify',
        enabled: true,
        when: 'debate_done',
        sourceMode: 'debate',
        action: 'notify',
      });
      const broadcasts = [];
      const room = { id: 'room-1', name: 'Room', mode: 'debate', autopilotHops: 0 };
      const controller = new AutopilotController({
        roomStore: { get: () => room },
        forwardRoom: async () => ({ newRoomId: 'unused' }),
        broadcastGlobal: (msg) => broadcasts.push(msg.type),
      });
      controller.onRoomEvent('room-1', { type: 'debate_done' });
      await new Promise((resolve) => setTimeout(resolve, 20));
      console.log(JSON.stringify({
        notifyBroadcast: broadcasts.includes('autopilot_notify'),
        dedupTracked: controller.recentEvents.size === 1,
        enabled: autopilotStore.isEnabled(),
      }));
    `,
    'src/autopilot/AutopilotScheduler.js': `
      import { AutopilotScheduler } from './src/autopilot/AutopilotScheduler.js';
      let claimed = false;
      const store = {
        recoverStaleRunningJobs: () => [],
        enqueueDueSchedules: () => [{ id: 'job-1' }],
        claimNextJob: () => {
          if (claimed) return null;
          claimed = true;
          return { job: { id: 'job-1', action: 'notify' }, run: { id: 'run-1' } };
        },
        finishRun: (runId, result) => ({ job: { id: 'job-1', status: result.status }, run: { id: runId, status: result.status, result: result.result } }),
      };
      const scheduler = new AutopilotScheduler({
        store,
        handlers: { notify: async () => ({ delivered: true }) },
        logger: null,
        isEnabled: () => false,
      });
      const skipped = await scheduler.tick({ now: 1000 });
      const forced = await scheduler.tick({ now: 1000, force: true });
      console.log(JSON.stringify({
        disabledSkipped: skipped.skipped === 'disabled',
        enqueued: forced.enqueued.length === 1,
        executed: forced.executed[0]?.job?.status === 'succeeded',
        handlerResult: forced.executed[0]?.run?.result?.delivered === true,
      }));
    `,
    'src/watcher/WatcherConfig.js': `
      import { loadWatcherConfig, saveWatcherConfig, maskedConfig } from './src/watcher/WatcherConfig.js';
      const fakeSecretValue = ['unit', 'test', 'redacted', 'value'].join('-');
      const first = loadWatcherConfig();
      const saved = saveWatcherConfig({
        ...first,
        enabled: true,
        apiKey: fakeSecretValue,
        _firstTime: true,
        rateLimit: { perSessionPerHour: 2, globalPerHour: 3 },
      });
      const loaded = loadWatcherConfig();
      const masked = maskedConfig(loaded);
      console.log(JSON.stringify({
        firstTime: first._firstTime === true,
        saved: saved.ok === true,
        loadedEnabled: loaded.enabled === true,
        tempFieldDropped: loaded._firstTime === undefined,
        maskedKey: masked.apiKey !== fakeSecretValue && masked.apiKey.includes('...'),
        mergedDefaults: loaded.triggers?.minIntervalSec === 60,
      }));
    `,
    'src/capabilities/NoeCapabilityTrigger.js': `
      import { classifyCapabilityNeed, createNoeCapabilityTrigger } from './src/capabilities/NoeCapabilityTrigger.js';
      const proposals = [];
      const trigger = createNoeCapabilityTrigger({
        capabilityAcquisition: {
          searchCapability: async () => ({ ok: true, candidates: [{ type: 'npm', name: 'turndown', source: 'npmjs.com' }] }),
          assessCandidate: () => ({ safe: true }),
          planAcquisition: (candidate) => ({ ok: true, capability: { name: candidate.name, type: candidate.type } }),
        },
        evaluateGrant: () => ({ authorized: true }),
        propose: async (proposal) => { proposals.push(proposal); return { ok: true }; },
        now: () => 10_000,
        cooldownMs: 0,
      });
      const signal = classifyCapabilityNeed('need a tool for markdown');
      const result = await trigger.observe({ need: 'markdown conversion' });
      const dup = await trigger.observe({ need: 'markdown conversion' });
      console.log(JSON.stringify({
        signalDetected: signal.isNeed === true,
        proposed: result.proposed === true,
        action: proposals[0]?.action,
        dedup: dup.reason === 'already_proposed',
      }));
    `,
    'src/autopilot/NoeHangAlert.js': `
      import { createHangAlertMonitor } from './src/autopilot/NoeHangAlert.js';
      let clock = 1000;
      const monitor = createHangAlertMonitor({ now: () => clock, alertAfterMs: 1000 });
      monitor.start('job-1', { kind: 'unit' });
      clock += 1100;
      const stale = monitor.check();
      monitor.beat('job-1');
      clock += 500;
      const afterBeat = monitor.check();
      console.log(JSON.stringify({
        staleDetected: stale.length === 1,
        firstAlert: stale[0]?.firstAlert === true,
        notKilled: monitor.size() === 1,
        beatCleared: afterBeat.length === 0,
      }));
    `,
    'src/cost/CostTracker.js': `
      import { CostTracker, estimateUsdFromUsage } from './src/cost/CostTracker.js';
      const tracker = new CostTracker();
      tracker.record(0.1, 100, 'unit-model');
      tracker.record(NaN);
      const estimate = estimateUsdFromUsage({ input_tokens: 1000, output_tokens: 2000 }, 'claude-sonnet-4-6');
      const snap = tracker.snapshot();
      console.log(JSON.stringify({
        sampleCount: snap.sampleCount,
        totalPositive: snap.totalUSD > 0,
        nanIgnored: snap.sampleCount === 1,
        estimatePositive: estimate > 0,
        ratePresent: Number.isFinite(snap.ratePerMinute),
      }));
    `,
    'src/state/AgentStateMachine.js': `
      import { AgentStateMachine, STATES } from './src/state/AgentStateMachine.js';
      const sm = new AgentStateMachine();
      const t1 = sm.ingest({ type: 'system', subtype: 'init' });
      const t2 = sm.ingest({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'x', name: 'bash', input: {} }] } });
      const t3 = sm.ingest({ type: 'result', is_error: false });
      sm.reset();
      console.log(JSON.stringify({
        statesCount: STATES.length,
        transitions: [t1?.to, t2?.to, t3?.to].join('>'),
        resetIdle: sm.current === 'idle',
        historyCount: sm.transitions.length,
      }));
    `,
    'src/planner/FocusChain.js': `
      import { focusChainHeader, buildDoneSummaries } from './src/planner/FocusChain.js';
      const summaries = buildDoneSummaries([
        { role: 'assistant', content: 'finished one' },
        { role: 'user', content: 'skip' },
        { role: 'assistant', content: 'finished two' },
      ]);
      const header = focusChainHeader({ mainGoal: 'stay focused', doneSummaries: summaries, userMsgCount: 5, triggerInterval: 5 });
      console.log(JSON.stringify({
        summaries: summaries.length,
        headerEmitted: header.length > 0,
        goalIncluded: header.includes('stay focused'),
        nonTriggerEmpty: focusChainHeader({ mainGoal: 'x', doneSummaries: [], userMsgCount: 4, triggerInterval: 5 }) === '',
      }));
    `,
  };
  return snippets[file] || '';
}

export function buildNoeWeakServerTargetedLocalDrills({
  paths = DEFAULT_PATHS,
  now = new Date(),
  keepTemp = false,
} = {}) {
  const resolvedPaths = { ...DEFAULT_PATHS, ...paths };
  const laneAudit = readJson(resolvedPaths.weakRuntimeRemainingLaneAudit);
  const targets = targetFilesFromLaneAudit(laneAudit);
  const tempRoot = mkdtempSync(join(tmpdir(), 'noe-weak-server-drills-'));
  const files = [];
  try {
    for (const target of targets) {
      const code = drillCodeFor(target.file);
      if (!code) {
        files.push(failedFile(target.file, target.lane, 'no drill snippet for target', {}, 'add a safe local drill or downgrade to manual review'));
        continue;
      }
      files.push(runIsolatedDrill({
        file: target.file,
        lane: target.lane,
        tempRoot,
        code,
      }));
    }
  } finally {
    if (!keepTemp) rmSync(tempRoot, { recursive: true, force: true });
  }

  const statusCounts = {};
  const laneCounts = {};
  for (const file of files) {
    inc(statusCounts, file.drillStatus);
    inc(laneCounts, file.lane);
  }
  const drilledOk = files.filter((file) => file.drillStatus === 'drilled_ok');
  const failed = files.filter((file) => file.drillStatus === 'failed');
  const serverBootTargets = targets.filter((file) => file.lane === 'server_boot_imported_natural_runtime_needed');
  const serviceChainTargets = targets.filter((file) => file.lane === 'server_service_chain_managed_smoke_needed');

  return {
    ok: true,
    generatedAt: (now instanceof Date ? now : new Date(now)).toISOString(),
    root: laneAudit.root || ROOT,
    inputs: {
      weakRuntimeRemainingLaneAudit: rel(resolvedPaths.weakRuntimeRemainingLaneAudit),
      weakRuntimeRemainingLaneAuditGeneratedAt: laneAudit.generatedAt || '',
    },
    policy: {
      isolatedNodeSubprocessPerModule: true,
      tempHomeOnly: true,
      localTempOnly: true,
      readOnlyRealProjectState: true,
      noEnvFileReads: true,
      noProjectEnvImport: true,
      noOwnerTokenReads: true,
      noRealNoePanelReads: true,
      noProtectedApiAuth: true,
      noDbReads: true,
      noNetworkCalls: true,
      noModelCalls: true,
      noLivePanelMutation: true,
      noSecretValuesReturned: true,
    },
    status: {
      drill: failed.length ? 'server_targeted_local_drills_failed' : 'server_targeted_local_drills_complete',
      completionClaim: 'not_complete',
      explanation: 'Server/service local drills prove component contracts in isolated temp HOME subprocesses. They do not prove natural live-panel invocation.',
    },
    summary: {
      targetFiles: targets.length,
      drilledOk: drilledOk.length,
      failed: failed.length,
      serverBootTargetFiles: serverBootTargets.length,
      serverBootDrilledOk: drilledOk.filter((file) => file.lane === 'server_boot_imported_natural_runtime_needed').length,
      serviceChainTargetFiles: serviceChainTargets.length,
      serviceChainDrilledOk: drilledOk.filter((file) => file.lane === 'server_service_chain_managed_smoke_needed').length,
      naturalRuntimeStillNeeded: targets.length,
      statusCounts,
      laneCounts,
    },
    files,
  };
}

function mdTable(rows) {
  return rows.map((row) => `| ${row.join(' | ')} |`).join('\n');
}

export function renderMarkdown(report, jsonPath = '') {
  const rows = report.files.map((file) => [
    `\`${file.file}\``,
    file.lane,
    file.drillStatus,
    Object.entries(file.evidence || {}).slice(0, 8).map(([key, value]) => `${key}:${clean(value, 80)}`).join('<br>') || '-',
    clean(file.remainingNeed || '-', 180),
  ]);
  return [
    '# Noe Weak Server Targeted Local Drills',
    '',
    `Generated: ${report.generatedAt}`,
    '',
    '## Verdict',
    '',
    `- drill: \`${report.status.drill}\``,
    `- completion claim: \`${report.status.completionClaim}\``,
    `- explanation: ${report.status.explanation}`,
    '',
    '## Summary',
    '',
    `- target files: ${report.summary.targetFiles}`,
    `- drilled ok: ${report.summary.drilledOk}; failed: ${report.summary.failed}`,
    `- server boot drilled ok: ${report.summary.serverBootDrilledOk}/${report.summary.serverBootTargetFiles}`,
    `- service-chain drilled ok: ${report.summary.serviceChainDrilledOk}/${report.summary.serviceChainTargetFiles}`,
    `- natural runtime still needed: ${report.summary.naturalRuntimeStillNeeded}`,
    '',
    '## Files',
    '',
    mdTable([
      ['file', 'lane', 'status', 'evidence', 'remaining need'],
      ['---', '---', '---', '---', '---'],
      ...rows,
    ]),
    '',
    '## Interpretation',
    '',
    '- `drilled_ok` proves a local component contract in an isolated temp-HOME subprocess.',
    '- It does not prove the running 51835 panel naturally invoked the component.',
    '- Temp HOME is used specifically for modules whose top-level default stores otherwise read or write `~/.noe-panel`.',
    '',
    '## JSON',
    '',
    jsonPath ? `Full report: \`${jsonPath.replace(`${ROOT}/`, '')}\`.` : 'No JSON path supplied.',
  ].join('\n');
}

export function writeNoeWeakServerTargetedLocalDrills(report) {
  mkdirSync(OUT_DIR, { recursive: true });
  const jsonPath = join(OUT_DIR, `${OUT_BASE}.json`);
  const mdPath = join(OUT_DIR, `${OUT_BASE}.md`);
  writeFileSync(jsonPath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  writeFileSync(mdPath, `${renderMarkdown(report, jsonPath)}\n`, { mode: 0o600 });
  return { jsonPath, mdPath };
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const report = buildNoeWeakServerTargetedLocalDrills();
  const paths = writeNoeWeakServerTargetedLocalDrills(report);
  console.log(JSON.stringify({
    ok: report.ok,
    drill: report.status.drill,
    targetFiles: report.summary.targetFiles,
    drilledOk: report.summary.drilledOk,
    failed: report.summary.failed,
    serverBootDrilledOk: report.summary.serverBootDrilledOk,
    serviceChainDrilledOk: report.summary.serviceChainDrilledOk,
    naturalRuntimeStillNeeded: report.summary.naturalRuntimeStillNeeded,
    paths,
  }, null, 2));
}
