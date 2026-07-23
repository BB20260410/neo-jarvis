#!/usr/bin/env node
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { NoeMissionStore } from '../src/runtime/mission/NoeMissionStore.js';
import { NoeMissionRunner } from '../src/runtime/mission/NoeMissionRunner.js';
import { NoeMissionCriteriaEngine } from '../src/runtime/mission/NoeMissionCriteriaEngine.js';
import { NoeMissionReconciler } from '../src/runtime/mission/NoeMissionReconciler.js';
import { createQualityAuditActionExecutors, createQualityAuditMissionContract } from '../src/runtime/mission/NoeMissionQualityAudit.js';
import { createLongSoakActionExecutors, createLongSoakMissionContract } from '../src/runtime/mission/NoeMissionLongSoak.js';
import {
  DEFAULT_SELF_LEARNING_DB_PATH,
  createSelfLearningMissionActionExecutors,
  createSelfLearningMissionContract,
  readSelfLearningGoalEvidence,
  writeSelfLearningMissionSmokeDb,
} from '../src/runtime/mission/NoeSelfLearningMission.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function parseArgs(argv) {
  const out = { command: argv[0] || 'help' };
  for (let i = 1; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => argv[++i] || '';
    if (arg === '--mission-id') out.missionId = next();
    else if (arg.startsWith('--mission-id=')) out.missionId = arg.slice(13);
    else if (arg === '--objective') out.objective = next();
    else if (arg.startsWith('--objective=')) out.objective = arg.slice(12);
    else if (arg === '--contract') out.contract = next();
    else if (arg.startsWith('--contract=')) out.contract = arg.slice(11);
    else if (arg === '--max-actions') out.maxActions = Number(next());
    else if (arg.startsWith('--max-actions=')) out.maxActions = Number(arg.slice(14));
    else if (arg === '--max-slices') out.maxSlices = Number(next());
    else if (arg.startsWith('--max-slices=')) out.maxSlices = Number(arg.slice(13));
    else if (arg === '--slice-delay-ms') out.sliceDelayMs = Number(next());
    else if (arg.startsWith('--slice-delay-ms=')) out.sliceDelayMs = Number(arg.slice(17));
    else if (arg === '--summary-every-slices') out.summaryEverySlices = Number(next());
    else if (arg.startsWith('--summary-every-slices=')) out.summaryEverySlices = Number(arg.slice(23));
    else if (arg === '--summary-every-ms') out.summaryEveryMs = Number(next());
    else if (arg.startsWith('--summary-every-ms=')) out.summaryEveryMs = Number(arg.slice(19));
    else if (arg === '--duration-ms') out.durationMs = Number(next());
    else if (arg.startsWith('--duration-ms=')) out.durationMs = Number(arg.slice(14));
    else if (arg === '--checkpoint-every-ms') out.checkpointEveryMs = Number(next());
    else if (arg.startsWith('--checkpoint-every-ms=')) out.checkpointEveryMs = Number(arg.slice(22));
    else if (arg === '--goal-id') out.goalId = next();
    else if (arg.startsWith('--goal-id=')) out.goalId = arg.slice(10);
    else if (arg === '--db-path') out.dbPath = next();
    else if (arg.startsWith('--db-path=')) out.dbPath = arg.slice(10);
    else if (arg === '--run-until-terminal') out.runUntilTerminal = true;
    else if (arg === '--resume') out.resume = true;
  }
  return out;
}

function usage() {
  return {
    ok: false,
    usage: [
      'node scripts/noe-mission-runtime.mjs create --mission-id id --objective "...".',
      'node scripts/noe-mission-runtime.mjs create --contract mission-contract.json',
      'node scripts/noe-mission-runtime.mjs run-slice --mission-id id --max-actions 1',
      'node scripts/noe-mission-runtime.mjs run --mission-id id',
      'node scripts/noe-mission-runtime.mjs status --mission-id id',
      'node scripts/noe-mission-runtime.mjs reconcile --mission-id id',
      'node scripts/noe-mission-runtime.mjs smoke',
      'node scripts/noe-mission-runtime.mjs quality-audit --mission-id id',
      'node scripts/noe-mission-runtime.mjs long-soak --mission-id id --duration-ms 25200000 --checkpoint-every-ms 900000 --summary-every-ms 3600000',
      'node scripts/noe-mission-runtime.mjs self-learning --mission-id id [--goal-id goal] [--resume]',
      'node scripts/noe-mission-runtime.mjs self-learning-smoke',
    ],
  };
}

function readContract(file) {
  const abs = resolve(ROOT, file);
  if (!abs.startsWith(ROOT) || !existsSync(abs)) throw new Error(`contract not found: ${file}`);
  return JSON.parse(readFileSync(abs, 'utf8'));
}

function defaultContract(args) {
  const missionId = args.missionId || `mission-${Date.now()}`;
  const proofRef = `output/noe-missions/${missionId}/artifacts/proof.json`;
  const observationRef = `output/noe-missions/${missionId}/artifacts/self-observation.json`;
  const reportRef = `output/noe-missions/${missionId}/artifacts/final-report.json`;
  return {
    missionId,
    objective: args.objective || 'Run a local Noe mission with evidence-gated completion.',
    scope: ['output/noe-missions/**'],
    forbidden: ['.env', 'secrets', '51735', 'games/cartoon-apocalypse/**'],
    completionCriteria: [
      { id: 'proof-readable', type: 'evidence_ref_exists', ref: proofRef },
      { id: 'self-observation-readable', type: 'evidence_ref_exists', ref: observationRef },
      { id: 'final-report-traces-proof', type: 'final_report_traces_evidence', evidenceRefs: [proofRef, observationRef] },
      { id: 'no-open-blockers', type: 'no_unresolved_blockers' },
      { id: 'no-truncation', type: 'no_truncated_results' },
    ],
    evidenceRequirements: [
      { id: 'proof', ref: proofRef, required: true },
      { id: 'self-observation', ref: observationRef, required: true },
    ],
    rollbackPlan: ['Delete the generated output/noe-missions/<missionId> directory if this local smoke must be rolled back.'],
    autonomyLevel: 'local_write',
    reviewPolicy: { ownerGate: ['external_write', 'live_write', 'delete', 'publish'], reviewBrain: ['high_risk_write'] },
    expectedArtifacts: [{ id: 'final_report', type: 'final_report', ref: reportRef }],
    plan: [
      { id: 'write-proof', type: 'write_artifact', name: 'proof.json', content: { ok: true, kind: 'p8-smoke-proof' } },
      { id: 'observe-thinking', type: 'self_observation', name: 'self-observation.json' },
      { id: 'write-final-report', type: 'final_report', name: 'final-report.json', evidenceRefs: [proofRef, observationRef] },
    ],
  };
}

function loadRuntime() {
  const store = new NoeMissionStore({ root: ROOT });
  return {
    store,
    runner: new NoeMissionRunner({ root: ROOT, store }),
    criteria: new NoeMissionCriteriaEngine({ root: ROOT }),
    reconciler: new NoeMissionReconciler({ root: ROOT }),
  };
}

function runOptions(args) {
  return {
    maxActions: args.maxActions || 1,
    maxSlices: args.maxSlices,
    sliceDelayMs: args.sliceDelayMs,
    summaryEverySlices: args.summaryEverySlices,
    summaryEveryMs: args.summaryEveryMs,
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const { store, runner, criteria, reconciler } = loadRuntime();
  let result;
  if (args.command === 'create') {
    const contract = args.contract ? readContract(args.contract) : defaultContract(args);
    result = { ok: true, ...store.createMission(contract) };
  } else if (args.command === 'run-slice') {
    if (!args.missionId) throw new Error('run-slice requires --mission-id');
    result = await runner.runSlice(args.missionId, { maxActions: args.maxActions || 1 });
  } else if (args.command === 'run') {
    if (!args.missionId) throw new Error('run requires --mission-id');
    result = await runner.runUntilTerminal(args.missionId, runOptions(args));
  } else if (args.command === 'status') {
    if (!args.missionId) throw new Error('status requires --mission-id');
    result = { ok: true, mission: store.readMission(args.missionId), state: store.readState(args.missionId), refs: store.refs(args.missionId) };
  } else if (args.command === 'reconcile') {
    if (!args.missionId) throw new Error('reconcile requires --mission-id');
    const mission = store.readMission(args.missionId);
    const state = store.readState(args.missionId);
    const events = store.readEvents(args.missionId, { limit: 5000 });
    result = {
      ok: true,
      criteria: criteria.evaluate({ mission, state, events, root: ROOT }),
      reconciliation: reconciler.reconcile({ mission, state, events, root: ROOT }),
      state,
    };
  } else if (args.command === 'smoke') {
    const missionId = `p8-smoke-${Date.now()}`;
    store.createMission(defaultContract({ missionId, objective: 'P8 Mission Runtime smoke' }));
    const run = await runner.runUntilTerminal(missionId, { maxActions: 1, maxSlices: 10 });
    result = { ok: run.status === 'succeeded' && run.slices.length >= 3, missionId, run, state: store.readState(missionId), refs: store.refs(missionId) };
    if (!result.ok) process.exitCode = 1;
  } else if (args.command === 'quality-audit') {
    const missionId = args.missionId || `p8-quality-audit-${Date.now()}`;
    const contract = createQualityAuditMissionContract({ missionId });
    store.createMission(contract);
    const auditRunner = new NoeMissionRunner({
      root: ROOT,
      store,
      actionExecutors: createQualityAuditActionExecutors({ root: ROOT, store }),
    });
    const run = await auditRunner.runUntilTerminal(missionId, {
      maxActions: args.maxActions || 1,
      maxSlices: args.maxSlices,
      sliceDelayMs: args.sliceDelayMs,
      summaryEverySlices: args.summaryEverySlices || 3,
      summaryEveryMs: args.summaryEveryMs,
    });
    result = { ok: run.status === 'succeeded', missionId, run, state: store.readState(missionId), refs: store.refs(missionId) };
    if (!result.ok) process.exitCode = 1;
  } else if (args.command === 'long-soak') {
    const missionId = args.missionId || `p8-long-soak-${Date.now()}`;
    const exists = Boolean(store.readState(missionId));
    if (!exists) {
      const contract = createLongSoakMissionContract({
        missionId,
        durationMs: args.durationMs,
        checkpointEveryMs: args.checkpointEveryMs,
        summaryEveryMs: args.summaryEveryMs,
      });
      store.createMission(contract);
    } else if (!args.resume) {
      throw new Error(`mission already exists: ${missionId}; pass --resume to continue it`);
    }
    const soakRunner = new NoeMissionRunner({
      root: ROOT,
      store,
      actionExecutors: createLongSoakActionExecutors({ root: ROOT, store }),
    });
    const mission = store.readMission(missionId);
    const summaryEveryMs = args.summaryEveryMs || mission?.metadata?.summaryEveryMs;
    const run = await soakRunner.runUntilTerminal(missionId, {
      maxActions: args.maxActions || 1,
      maxSlices: args.maxSlices,
      sliceDelayMs: args.sliceDelayMs,
      summaryEverySlices: args.summaryEverySlices,
      summaryEveryMs,
    });
    result = { ok: run.status === 'succeeded', missionId, resumed: exists, run, state: store.readState(missionId), refs: store.refs(missionId) };
    if (!result.ok) process.exitCode = 1;
  } else if (args.command === 'self-learning') {
    const missionId = args.missionId || `p7-self-learning-${Date.now()}`;
    const exists = Boolean(store.readState(missionId));
    const dbPath = args.dbPath || DEFAULT_SELF_LEARNING_DB_PATH;
    if (!exists) {
      let goalId = args.goalId || '';
      if (!goalId) {
        const evidence = readSelfLearningGoalEvidence({ dbPath });
        if (!evidence.ok || !evidence.goal?.id) throw new Error(evidence.error || 'active_self_learning_goal_not_found');
        goalId = evidence.goal.id;
      }
      store.createMission(createSelfLearningMissionContract({ missionId, goalId }));
    } else if (!args.resume) {
      throw new Error(`mission already exists: ${missionId}; pass --resume to continue it`);
    }
    const bridgeRunner = new NoeMissionRunner({
      root: ROOT,
      store,
      actionExecutors: createSelfLearningMissionActionExecutors({ dbPath }),
    });
    let run;
    if (args.runUntilTerminal) {
      if (!Number.isFinite(args.maxSlices)) {
        throw new Error('self-learning --run-until-terminal requires --max-slices so an unfinished live goal cannot loop indefinitely');
      }
      run = await bridgeRunner.runUntilTerminal(missionId, runOptions(args));
    } else {
      run = await bridgeRunner.runSlice(missionId, { maxActions: args.maxActions || 1 });
    }
    const state = store.readState(missionId);
    const mission = store.readMission(missionId);
    result = { ok: state?.status !== 'blocked', missionId, goalId: mission?.metadata?.goalId || null, resumed: exists, run, state, refs: store.refs(missionId) };
    if (!result.ok) process.exitCode = 1;
  } else if (args.command === 'self-learning-smoke') {
    const missionId = args.missionId || `p7-self-learning-smoke-${Date.now()}`;
    const dbPath = args.dbPath || join(ROOT, 'output', 'noe-self-learning-mission-smoke', `${missionId}.db`);
    const fixture = writeSelfLearningMissionSmokeDb(dbPath);
    store.createMission(createSelfLearningMissionContract({ missionId, goalId: fixture.goalId }));
    const bridgeRunner = new NoeMissionRunner({
      root: ROOT,
      store,
      actionExecutors: createSelfLearningMissionActionExecutors({ dbPath }),
    });
    const run = await bridgeRunner.runUntilTerminal(missionId, { maxActions: args.maxActions || 1, maxSlices: args.maxSlices || 10 });
    result = { ok: run.status === 'succeeded', missionId, fixture: { dbPath, goalId: fixture.goalId }, run, state: store.readState(missionId), refs: store.refs(missionId) };
    if (!result.ok) process.exitCode = 1;
  } else {
    result = usage();
    process.exitCode = 1;
  }
  console.log(JSON.stringify(result, null, 2));
}

main().catch((error) => {
  console.log(JSON.stringify({ ok: false, error: error.message }, null, 2));
  process.exitCode = 1;
});
