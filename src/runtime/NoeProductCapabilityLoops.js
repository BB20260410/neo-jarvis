// @ts-check
/**
 * S5–S6 product capability loops — first task, memory, browser, voice.
 * Drives shipped stores/runtimes; does not invent parallel task owners.
 */
import { createHash } from 'node:crypto';
import { existsSync, writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  buildFrontDoorManifest,
  renderOrdinaryReceipt,
  ORDINARY_FRONT_DOOR_ENTRIES,
} from './NoeTaskReceiptView.js';
import { AgentRuntime } from './AgentRuntime.js';
import { runNoeDoctor } from './NoeDoctor.js';

export const PRODUCT_LOOPS_SCHEMA_VERSION = 1;

/**
 * @param {string} text
 */
export function sha256Hex(text) {
  return createHash('sha256').update(String(text)).digest('hex');
}

/**
 * First verified task loop (S5): front door → AgentRuntime → receipt.
 * @param {object} opts
 * @param {import('./UnifiedTaskStore.js').UnifiedTaskStore} opts.taskStore
 * @param {string} opts.reportDir
 * @param {string} [opts.goal]
 * @param {string} [opts.sourceDigest]
 * @param {NodeJS.ProcessEnv|Record<string,string|undefined>} [opts.env]
 */
export async function runFirstVerifiedTaskLoop(opts) {
  const store = opts.taskStore;
  if (!store) throw new Error('taskStore_required');
  const reportDir = opts.reportDir;
  mkdirSync(reportDir, { recursive: true });
  const manifest = buildFrontDoorManifest({ taskStore: store });
  if (!Array.isArray(manifest.ordinaryEntries) || manifest.ordinaryEntries.length !== 5) {
    throw new Error('front_door_entries_invalid');
  }
  const runtime = new AgentRuntime({
    taskStore: store,
    env: opts.env || { NOE_UNIFIED_TASK_WRITE: '1' },
    adapters: {
      agentRunStore: {
        createRun: async ({ taskId }) => ({ id: `agentrun_${taskId}`, taskId }),
      },
    },
  });
  const sourceDigest = opts.sourceDigest || `sha256:${sha256Hex(opts.goal || 'first-task')}`;
  const accepted = await runtime.acceptGoal({
    goal: opts.goal || 'First verified product task: write a short report',
    sourceDigest,
  });
  await runtime.recordObservation(accepted.taskId, {
    tool: 'inspect',
    ok: true,
    summary: 'inspected workspace',
  });
  // deny false complete
  const denied = await runtime.completeTask(accepted.taskId, {
    exitCode: 0,
    verified: false,
    hasValidArtifacts: true,
    hasEvidence: true,
    validatorsPass: true,
  });
  const reportPath = join(reportDir, `first-task-${accepted.taskId}.md`);
  const body = `# First verified task\n\ntaskId: ${accepted.taskId}\nstatus: completed\n`;
  writeFileSync(reportPath, body);
  const done = await runtime.completeTask(accepted.taskId, {
    exitCode: 0,
    verified: true,
    hasValidArtifacts: true,
    hasEvidence: true,
    validatorsPass: true,
    sourceDigestMatch: true,
    approvalsSettled: true,
    highRiskActsSettled: true,
    sourceDigest,
    artifacts: [{ path: reportPath, sha256: sha256Hex(body) }],
    summary: 'first task report written',
    receiptId: `receipt-first-${accepted.taskId}`,
  });
  const view = renderOrdinaryReceipt(accepted.taskId, { taskStore: store });
  return {
    schemaVersion: PRODUCT_LOOPS_SCHEMA_VERSION,
    loop: 'first_verified_task',
    frontDoorEntries: ORDINARY_FRONT_DOOR_ENTRIES.map((e) => e.id),
    taskId: accepted.taskId,
    falseCompleteDenied: denied.task?.status !== 'completed',
    completed: done.task?.status === 'completed',
    reportPath,
    reportExists: existsSync(reportPath),
    ordinaryCompleted: view.ordinary?.completed === true,
    sameTruth: view.sameTruth === true,
    firstTaskSlaMinutes: manifest.firstTaskSlaMinutes,
    ok:
      denied.task?.status !== 'completed'
      && done.task?.status === 'completed'
      && existsSync(reportPath)
      && view.ordinary?.completed === true
      && view.sameTruth === true,
  };
}

/**
 * Memory product loop (S6): write → recall → metrics (injectable memory API).
 * @param {object} opts
 * @param {{ remember?: Function, recall?: Function }} opts.memory
 * @param {Array<{id:string,query:string,expectIds:string[]}>} [opts.cases]
 */
export function runMemoryStandardLoop(opts = {}) {
  const memory = opts.memory;
  if (!memory?.remember || !memory?.recall) {
    return {
      loop: 'memory',
      ok: false,
      error: 'memory_api_missing',
      recall: null,
      precision: null,
      crossProjectSensitiveMisuse: null,
    };
  }
  const cases = Array.isArray(opts.cases) && opts.cases.length
    ? opts.cases
    : [
      { id: 'm1', query: 'owner timezone', expectIds: ['fact-tz'] },
      { id: 'm2', query: 'project neo panel port', expectIds: ['fact-port'] },
      { id: 'm3', query: 'sensitive api key other project', expectIds: [] },
    ];

  // Seed standard set (idempotent if memory ignores dups)
  memory.remember({ id: 'fact-tz', body: 'owner timezone is Asia/Shanghai', scope: 'user', projectId: 'neo' });
  memory.remember({ id: 'fact-port', body: 'neo panel live port is 51835', scope: 'project', projectId: 'neo' });
  memory.remember({
    id: 'secret-other',
    body: 'other-project api key sk-demo-should-not-leak',
    scope: 'project',
    projectId: 'other-project',
    sensitive: true,
  });

  let hits = 0;
  let retrievedRelevant = 0;
  let retrievedTotal = 0;
  let crossProjectSensitiveMisuse = 0;

  for (const c of cases) {
    const raw = memory.recall({ query: c.query, projectId: 'neo', limit: 5 }) || [];
    const items = Array.isArray(raw) ? raw : (raw.items || []);
    const ids = items.map((m) => m.id || m.memoryId).filter(Boolean);
    retrievedTotal += ids.length;
    const expect = new Set(c.expectIds || []);
    if (expect.size === 0) {
      // must not return sensitive other-project
      for (const m of items) {
        if (m.sensitive && m.projectId && m.projectId !== 'neo') crossProjectSensitiveMisuse += 1;
        if (String(m.body || '').includes('sk-demo')) crossProjectSensitiveMisuse += 1;
      }
    } else {
      const hit = ids.some((id) => expect.has(id));
      if (hit) hits += 1;
      retrievedRelevant += ids.filter((id) => expect.has(id)).length;
    }
  }

  const recallCases = cases.filter((c) => (c.expectIds || []).length > 0);
  const memoryRecall = recallCases.length ? hits / recallCases.length : null;
  const memoryPrecision = retrievedTotal ? retrievedRelevant / retrievedTotal : 1;

  return {
    schemaVersion: PRODUCT_LOOPS_SCHEMA_VERSION,
    loop: 'memory',
    caseCount: cases.length,
    memoryRecall,
    memoryPrecision,
    crossProjectSensitiveMisuse,
    ok:
      memoryRecall != null
      && memoryRecall >= 0.85
      && memoryPrecision >= 0.9
      && crossProjectSensitiveMisuse === 0,
  };
}

/**
 * Browser product loop (S6): policy + dry-run success path via injected executor.
 * @param {object} opts
 * @param {{ run?: Function, policyAllow?: Function }} opts.browser
 * @param {Array<object>} [opts.tasks]
 */
export async function runBrowserStandardLoop(opts = {}) {
  const browser = opts.browser;
  // Missing executor / playwright is external_blocked — never treat as silent PASS (no fake green).
  if (!browser?.run || browser.playwrightAvailable === false) {
    return {
      loop: 'browser',
      schemaVersion: PRODUCT_LOOPS_SCHEMA_VERSION,
      ok: false,
      status: 'external_blocked',
      error: browser?.playwrightAvailable === false ? 'playwright_unavailable' : 'browser_executor_missing',
      successRate: null,
      fakeGreen: false,
    };
  }
  const tasks = Array.isArray(opts.tasks) && opts.tasks.length
    ? opts.tasks
    : [
      { id: 'b1', url: 'https://example.com', action: 'fetch_title' },
      { id: 'b2', url: 'https://example.com/path', action: 'extract_text' },
      { id: 'b3', url: 'https://example.com', action: 'screenshot' },
    ];
  let okCount = 0;
  const results = [];
  for (const t of tasks) {
    if (browser.policyAllow && browser.policyAllow(t) === false) {
      results.push({ id: t.id, ok: false, reason: 'policy_denied', status: 'policy_denied' });
      continue;
    }
    try {
      const r = await browser.run(t);
      const ok = r && r.ok === true && (r.artifact || r.title || r.text);
      if (ok) okCount += 1;
      results.push({ id: t.id, ok: !!ok, detail: r?.summary || null });
    } catch (e) {
      const msg = String(e?.message || e);
      const blocked = /playwright|browser.*not.*install|ECONNREFUSED|ENOTFOUND/i.test(msg);
      results.push({
        id: t.id,
        ok: false,
        reason: msg,
        status: blocked ? 'external_blocked' : 'error',
      });
    }
  }
  const successRate = tasks.length ? okCount / tasks.length : null;
  const anyBlocked = results.some((r) => r.status === 'external_blocked');
  return {
    schemaVersion: PRODUCT_LOOPS_SCHEMA_VERSION,
    loop: 'browser',
    taskCount: tasks.length,
    okCount,
    successRate,
    results,
    status: anyBlocked && okCount === 0 ? 'external_blocked' : (successRate != null && successRate >= 0.9 ? 'ok' : 'degraded'),
    fakeGreen: false,
    ok: successRate != null && successRate >= 0.9,
  };
}

/**
 * Voice product loop (S6): Doctor companion readiness + optional STT roundtrip injector.
 * @param {object} opts
 * @param {string} [opts.root]
 * @param {{ stt?: Function }} [opts.voice]
 */
export async function runVoiceStandardLoop(opts = {}) {
  const root = opts.root || process.cwd();
  const doctor = await runNoeDoctor({ root, skipNetwork: false, env: opts.env || process.env });
  const voiceFinding = (doctor.findings || []).find((f) => f.checkId === 'voice.companions');
  const companionsUp = voiceFinding
    ? !/没起|down|fail/i.test(String(voiceFinding.message || '')) || voiceFinding.severity === 'info'
    : false;

  let sttOk = null;
  if (opts.voice?.stt) {
    try {
      const r = await opts.voice.stt({ audioPath: opts.fixtureAudio || null, textHint: '打开面板' });
      sttOk = !!(r && (r.text || r.transcript) && /面板|panel|打开/i.test(String(r.text || r.transcript)));
    } catch {
      sttOk = false;
    }
  }

  // Without STT injector, readiness-only loop: doctor voice finding present
  const ok = sttOk === null
    ? voiceFinding != null && voiceFinding.severity !== 'error'
    : sttOk === true;

  return {
    schemaVersion: PRODUCT_LOOPS_SCHEMA_VERSION,
    loop: 'voice',
    doctorVoiceSeverity: voiceFinding?.severity || null,
    doctorVoiceMessage: voiceFinding?.message || null,
    companionsUp,
    sttOk,
    ok,
  };
}

/**
 * Run S5+S6 product package with injectable deps.
 * @param {object} opts
 */
export async function runProductCapabilityPackage(opts = {}) {
  const first = opts.taskStore
    ? await runFirstVerifiedTaskLoop({
      taskStore: opts.taskStore,
      reportDir: opts.reportDir || join(process.cwd(), 'output', 'noe-product-loops'),
      goal: opts.firstGoal,
      sourceDigest: opts.sourceDigest,
      env: opts.env,
    })
    : { loop: 'first_verified_task', ok: false, error: 'taskStore_missing' };

  const memory = runMemoryStandardLoop({ memory: opts.memory, cases: opts.memoryCases });
  const browser = await runBrowserStandardLoop({ browser: opts.browser, tasks: opts.browserTasks });
  const voice = await runVoiceStandardLoop({
    root: opts.root,
    env: opts.env,
    voice: opts.voice,
    fixtureAudio: opts.fixtureAudio,
  });

  return {
    schemaVersion: PRODUCT_LOOPS_SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    loops: { first, memory, browser, voice },
    ok: !!(first.ok && memory.ok && browser.ok && voice.ok),
    notes: {
      memoryNeedsApi: !opts.memory,
      browserNeedsExecutor: !opts.browser,
      voiceDoctorOnly: !opts.voice?.stt,
    },
  };
}
