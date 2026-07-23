#!/usr/bin/env node
// @ts-check
/**
 * C01 canary — drives SHIPPED AgentRuntime + UnifiedTaskSqlite end-to-end:
 *   - accept goal → observation → false complete denied → real complete
 *   - report file on disk with sha256 artifact
 *   - same Task ID across accept / receipt / reopen
 *   - 10 rounds, zero false completions
 *   - sqlite restart recovery
 *
 * Usage:
 *   node scripts/noe-c01-unified-task-canary.mjs --out /path/to/report.json --rounds 10
 */
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');

function parseArgs(argv) {
  /** @type {Record<string, string|number|boolean>} */
  const out = { rounds: 10 };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--out') out.out = argv[++i];
    else if (a === '--rounds') out.rounds = Number(argv[++i] || 10);
    else if (a === '--work-dir') out.workDir = argv[++i];
    else if (a === '--keep') out.keep = true;
  }
  return out;
}

function sha256Hex(buf) {
  return createHash('sha256').update(buf).digest('hex');
}

const args = parseArgs(process.argv);
const rounds = Math.max(1, Math.min(50, Number(args.rounds) || 10));
const workDir = String(args.workDir || join(tmpdir(), `noe-c01-${Date.now()}`));
const reportDir = join(workDir, 'reports');
const sqlitePath = join(workDir, 'unified-tasks.db');
mkdirSync(reportDir, { recursive: true });

const { reopenUnifiedTaskSqliteStore } = await import(
  pathToFileURL(join(root, 'src/runtime/UnifiedTaskSqlite.js')).href
);
const { AgentRuntime } = await import(
  pathToFileURL(join(root, 'src/runtime/AgentRuntime.js')).href
);
const { producerMayWriteTaskFinalState } = await import(
  pathToFileURL(join(root, 'src/runtime/UnifiedTaskStore.js')).href
);

const env = {
  NOE_UNIFIED_TASK_WRITE: '1',
  NOE_UNIFIED_TASK_READ: '1',
  NOE_AGENT_RUNTIME_SHADOW: '1',
  NOE_UNIFIED_TASK_SQLITE_PATH: sqlitePath,
};

const sourceDigest = `sha256:${sha256Hex(`c01-canary-${workDir}`)}`;
const store = reopenUnifiedTaskSqliteStore(sqlitePath, { env });
const runtime = new AgentRuntime({
  taskStore: store,
  env,
  adapters: {
    agentRunStore: {
      createRun: async ({ taskId, goal }) => ({
        id: `agentrun_${taskId}`,
        taskId,
        goal,
      }),
    },
    // Tool side effects go through adapters — runtime itself has none
    toolRegistry: {
      invoke: async ({ name, input }) => ({ ok: true, name, input, observation: 'fixture_read_ok' }),
    },
  },
});

const side = runtime.listBuiltinSideEffectExecutors();
if (side.shell || side.filesystem || side.browser || side.secondScheduler) {
  console.error('arch_fail: AgentRuntime must not implement side effects');
  process.exit(2);
}
if (producerMayWriteTaskFinalState() !== false) {
  console.error('arch_fail: producers must not write task final state');
  process.exit(2);
}

/** @type {Array<object>} */
const results = [];
let falseCompleteCount = 0;

for (let i = 0; i < rounds; i++) {
  const accepted = await runtime.acceptGoal({
    goal: `C01 canary #${i}: analyze fixture project and write report`,
    sourceDigest,
  });
  const taskId = accepted.taskId;
  const agentRunId = accepted.agentRunId;

  await runtime.recordObservation(taskId, {
    tool: 'read_file',
    ok: true,
    summary: 'read package.json from fixture',
  });

  // False complete: model claim without verification
  const bad = await runtime.completeTask(taskId, {
    exitCode: 0,
    verified: false,
    hasValidArtifacts: true,
    hasEvidence: true,
    validatorsPass: true,
    summary: 'model claims done without evidence',
  });
  if (bad.task?.status === 'completed' || bad.receipt?.displayCompleted === true) {
    falseCompleteCount += 1;
  }

  // Real report on disk
  const reportPath = join(reportDir, `c01-report-${i}.md`);
  const reportBody = [
    `# C01 Canary Report #${i}`,
    '',
    `- taskId: ${taskId}`,
    `- agentRunId: ${agentRunId}`,
    `- sourceDigest: ${sourceDigest}`,
    `- goal: analyze fixture and write report`,
    '',
    '## Result',
    'Fixture analysis complete. Tests green. No secrets.',
    '',
  ].join('\n');
  writeFileSync(reportPath, reportBody);
  const artifactSha = sha256Hex(reportBody);
  if (!existsSync(reportPath)) {
    console.error('report_missing', reportPath);
    process.exit(2);
  }
  // Re-read to prove path is real
  const onDiskSha = sha256Hex(readFileSync(reportPath));
  if (onDiskSha !== artifactSha) {
    console.error('artifact_hash_mismatch');
    process.exit(2);
  }

  const good = await runtime.completeTask(taskId, {
    exitCode: 0,
    verified: true,
    hasValidArtifacts: true,
    hasEvidence: true,
    validatorsPass: true,
    sourceDigestMatch: true,
    approvalsSettled: true,
    highRiskActsSettled: true,
    sourceDigest,
    artifacts: [{ path: reportPath, sha256: artifactSha }],
    summary: `report written to ${reportPath}`,
    receiptId: `receipt-c01-${i}`,
  });

  const receipt = store.buildReceipt(taskId);
  const sameTaskId =
    taskId === good.task?.id
    && taskId === receipt?.taskId
    && agentRunId === `agentrun_${taskId}`;

  if (good.task?.status !== 'completed' || receipt?.displayCompleted !== true) {
    falseCompleteCount += 1; // treat incomplete real complete as failure of canary contract
  }

  results.push({
    i,
    taskId,
    agentRunId,
    sameTaskId,
    falseAttemptStatus: bad.task?.status,
    falseDisplayCompleted: bad.receipt?.displayCompleted === true,
    finalStatus: good.task?.status,
    displayCompleted: receipt?.displayCompleted === true,
    reportPath,
    artifactSha256: artifactSha,
    reportExists: existsSync(reportPath),
  });
}

// Restart recovery: close conceptual process by reopening sqlite
const store2 = reopenUnifiedTaskSqliteStore(sqlitePath, { env });
const recovery = results.map((r) => {
  const t = store2.get(r.taskId);
  return {
    taskId: r.taskId,
    recovered: !!t,
    status: t?.status || null,
    sameId: t?.id === r.taskId,
    completed: t?.status === 'completed',
    artifactPath: t?.artifacts?.[0]?.path || null,
    artifactStillOnDisk: t?.artifacts?.[0]?.path ? existsSync(t.artifacts[0].path) : false,
  };
});
const recoveryOk = recovery.every((r) => r.recovered && r.sameId && r.completed && r.artifactStillOnDisk);

const summary = {
  schemaVersion: 1,
  canary: 'C01',
  rounds,
  falseCompleteCount,
  zeroFalseCompletion: falseCompleteCount === 0 && results.every((r) => r.finalStatus === 'completed' && !r.falseDisplayCompleted),
  allSameTaskId: results.every((r) => r.sameTaskId),
  allReportsOnDisk: results.every((r) => r.reportExists),
  restartRecoveryOk: recoveryOk,
  architecture: {
    producerMayWriteTaskFinalState: producerMayWriteTaskFinalState(),
    agentRuntimeSideEffects: side,
  },
  workDir,
  sqlitePath,
  sourceDigest,
  results,
  recovery,
  ok: false,
};
summary.ok =
  summary.zeroFalseCompletion
  && summary.allSameTaskId
  && summary.allReportsOnDisk
  && summary.restartRecoveryOk
  && summary.architecture.producerMayWriteTaskFinalState === false
  && summary.architecture.agentRuntimeSideEffects.shell === false;

const outPath = args.out ? resolve(String(args.out)) : join(workDir, 'c01-canary-summary.json');
mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, `${JSON.stringify(summary, null, 2)}\n`);
console.log(JSON.stringify({
  ok: summary.ok,
  outPath,
  rounds: summary.rounds,
  zeroFalseCompletion: summary.zeroFalseCompletion,
  allSameTaskId: summary.allSameTaskId,
  allReportsOnDisk: summary.allReportsOnDisk,
  restartRecoveryOk: summary.restartRecoveryOk,
  falseCompleteCount: summary.falseCompleteCount,
}, null, 2));

if (!args.keep && !summary.ok) {
  // keep workdir on failure for debug
}
process.exit(summary.ok ? 0 : 2);
