// @ts-check
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { redactSensitiveText } from '../NoeContextScrubber.js';

function clean(value, max = 4000) {
  return redactSensitiveText(String(value ?? '').trim()).slice(0, max);
}

function artifactRef(missionId, name) {
  return `output/noe-missions/${missionId}/artifacts/${name}`;
}

function commandArtifactName(actionId) {
  return `${clean(actionId, 120).replace(/[^a-z0-9_.-]+/gi, '-')}.json`;
}

export function createQualityAuditMissionContract({ missionId = `p8-quality-audit-${Date.now()}` } = {}) {
  const inventoryRef = artifactRef(missionId, 'repo-inventory.json');
  const nodeCheckRef = artifactRef(missionId, 'cmd-node-check.json');
  const unitRef = artifactRef(missionId, 'cmd-mission-unit.json');
  const missionSmokeRef = artifactRef(missionId, 'cmd-mission-smoke.json');
  const selfEvolutionRef = artifactRef(missionId, 'cmd-self-evolution.json');
  const handoffRef = artifactRef(missionId, 'cmd-handoff.json');
  const diffCheckRef = artifactRef(missionId, 'cmd-diff-check.json');
  const observationRef = artifactRef(missionId, 'self-observation.json');
  const coverageRef = artifactRef(missionId, 'coverage-table.json');
  const reportRef = artifactRef(missionId, 'final-report.json');
  const requiredRefs = [
    inventoryRef,
    nodeCheckRef,
    unitRef,
    missionSmokeRef,
    selfEvolutionRef,
    handoffRef,
    diffCheckRef,
    observationRef,
    coverageRef,
  ];
  return {
    missionId,
    objective: 'Run a read-only repository quality audit with evidence closure and a coverage table.',
    scope: ['read repository files', 'run local verification commands', 'write output/noe-missions/**'],
    forbidden: ['.env', 'secret values', '51735', 'games/cartoon-apocalypse/**', 'live write', 'external write', 'git reset', 'git clean'],
    autonomyLevel: 'read_only',
    rollbackPlan: ['Remove output/noe-missions/<missionId> if the generated local evidence is no longer needed.'],
    reviewPolicy: {
      ownerGate: ['external_write', 'live_write', 'delete', 'publish', 'secret_access'],
      reviewBrain: ['code_write', 'self_evolution_apply', 'identity_memory_write'],
    },
    expectedArtifacts: [
      { id: 'coverage_table', type: 'coverage_table', ref: coverageRef },
      { id: 'final_report', type: 'final_report', ref: reportRef },
    ],
    evidenceRequirements: requiredRefs.map((ref, index) => ({ id: `required-${index + 1}`, ref, required: true })),
    completionCriteria: [
      ...requiredRefs.map((ref, index) => ({ id: `evidence-${index + 1}`, type: 'evidence_ref_exists', ref })),
      { id: 'node-check-exit-zero', type: 'command_exit_zero', commandId: 'cmd-node-check' },
      { id: 'mission-unit-exit-zero', type: 'command_exit_zero', commandId: 'cmd-mission-unit' },
      { id: 'mission-smoke-exit-zero', type: 'command_exit_zero', commandId: 'cmd-mission-smoke' },
      { id: 'self-evolution-exit-zero', type: 'command_exit_zero', commandId: 'cmd-self-evolution' },
      { id: 'handoff-exit-zero', type: 'command_exit_zero', commandId: 'cmd-handoff' },
      { id: 'diff-check-exit-zero', type: 'command_exit_zero', commandId: 'cmd-diff-check' },
      { id: 'final-report-traces-required-refs', type: 'final_report_traces_evidence', reportRef, evidenceRefs: requiredRefs },
      { id: 'no-open-blockers', type: 'no_unresolved_blockers' },
      { id: 'no-truncation', type: 'no_truncated_results' },
    ],
    plan: [
      { id: 'repo-inventory', type: 'repo_inventory', name: 'repo-inventory.json' },
      { id: 'cmd-node-check', type: 'run_command', name: 'cmd-node-check.json', command: ['node', '--check', 'src/runtime/mission/NoeMissionRunner.js'] },
      { id: 'cmd-mission-unit', type: 'run_command', name: 'cmd-mission-unit.json', command: ['npm', 'test', '--', 'tests/unit/noe-mission-runtime.test.js'] },
      { id: 'cmd-mission-smoke', type: 'run_command', name: 'cmd-mission-smoke.json', command: ['npm', 'run', 'verify:noe:mission-runtime'] },
      { id: 'cmd-self-evolution', type: 'run_command', name: 'cmd-self-evolution.json', command: ['npm', 'run', 'verify:noe:self-evolution'] },
      { id: 'cmd-handoff', type: 'run_command', name: 'cmd-handoff.json', command: ['npm', 'run', 'verify:handoff'] },
      { id: 'cmd-diff-check', type: 'run_command', name: 'cmd-diff-check.json', command: ['git', 'diff', '--check', '--', ':!games/cartoon-apocalypse/**'] },
      { id: 'observe-thinking', type: 'self_observation', name: 'self-observation.json' },
      { id: 'coverage-table', type: 'coverage_table', name: 'coverage-table.json' },
      { id: 'final-report', type: 'final_report', name: 'final-report.json', evidenceRefs: requiredRefs },
    ],
  };
}

function clampOutput(value, max = 80_000) {
  const text = clean(value, max);
  return text.length >= max ? `${text}\n[truncated-output]` : text;
}

function runCommand(command, { cwd, onNoOutput, noOutputWatchdogMs = 0 } = {}) {
  return new Promise((resolvePromise) => {
    const [bin, ...args] = Array.isArray(command) ? command : [];
    const startedAt = Date.now();
    let stdout = '';
    let stderr = '';
    let lastOutputAt = startedAt;
    let watchdogTriggered = false;
    const child = spawn(bin, args, { cwd, shell: false, env: process.env });
    const timer = noOutputWatchdogMs > 0 ? setInterval(() => {
      if (!watchdogTriggered && Date.now() - lastOutputAt >= noOutputWatchdogMs) {
        watchdogTriggered = true;
        onNoOutput?.({ pid: child.pid, command, idleMs: Date.now() - lastOutputAt });
      }
    }, Math.max(250, Math.min(5000, noOutputWatchdogMs))) : null;

    child.stdout.on('data', (chunk) => { lastOutputAt = Date.now(); stdout += chunk.toString('utf8'); });
    child.stderr.on('data', (chunk) => { lastOutputAt = Date.now(); stderr += chunk.toString('utf8'); });
    child.on('error', (error) => {
      if (timer) clearInterval(timer);
      resolvePromise({ exitCode: 127, signal: null, stdout, stderr: `${stderr}\n${error.message}`, durationMs: Date.now() - startedAt, watchdogTriggered });
    });
    child.on('close', (code, signal) => {
      if (timer) clearInterval(timer);
      resolvePromise({ exitCode: Number(code), signal, stdout, stderr, durationMs: Date.now() - startedAt, watchdogTriggered });
    });
  });
}

export function createQualityAuditActionExecutors({ root, store } = {}) {
  const cwd = resolve(root || process.cwd());
  return {
    repo_inventory: async ({ mission, action, runner }) => {
      const tracked = await runCommand(['git', 'ls-files'], { cwd });
      const status = await runCommand(['git', 'status', '--short', '--untracked-files=all'], { cwd });
      const files = tracked.stdout.split('\n').filter(Boolean);
      const payload = {
        ok: tracked.exitCode === 0 && status.exitCode === 0,
        trackedFileCount: files.length,
        runtimeMissionFiles: files.filter((file) => file.startsWith('src/runtime/mission/')).length,
        testFiles: files.filter((file) => file.startsWith('tests/')).length,
        dirtyLineCount: status.stdout.split('\n').filter(Boolean).length,
        statusPreview: status.stdout.split('\n').filter(Boolean).slice(0, 80),
      };
      const artifact = runner.store.writeArtifact(mission.missionId, action.name || 'repo-inventory.json', payload);
      if (!payload.ok) return { ok: false, unverified: true, artifactRef: artifact.ref, evidenceRefs: [artifact.ref] };
      return { ok: true, artifactRef: artifact.ref, evidenceRefs: [artifact.ref], exitCode: 0 };
    },
    run_command: async ({ mission, action, runner }) => {
      const command = Array.isArray(action.command) ? action.command.map((part) => clean(part, 500)) : [];
      if (!command.length) throw new Error(`mission command missing: ${action.id}`);
      const noOutputEvents = [];
      const result = await runCommand(command, {
        cwd,
        noOutputWatchdogMs: Number(action.noOutputWatchdogMs || 0),
        onNoOutput: (event) => {
          noOutputEvents.push(event);
          runner.store.appendEvent(mission.missionId, { type: 'mission.command.no_output_watchdog', actionId: action.id, ...event });
        },
      });
      const payload = {
        ok: result.exitCode === 0,
        command,
        exitCode: result.exitCode,
        signal: result.signal,
        durationMs: result.durationMs,
        stdout: clampOutput(result.stdout),
        stderr: clampOutput(result.stderr),
        noOutputWatchdog: result.watchdogTriggered,
        noOutputEvents,
      };
      const artifact = runner.store.writeArtifact(mission.missionId, action.name || commandArtifactName(action.id), payload);
      runner.store.appendEvent(mission.missionId, {
        type: result.exitCode === 0 ? 'mission.command.completed' : 'mission.command.failed',
        commandId: action.id,
        exitCode: result.exitCode,
        evidenceRefs: [artifact.ref],
        durationMs: result.durationMs,
      });
      return {
        ok: result.exitCode === 0,
        artifactRef: artifact.ref,
        evidenceRefs: [artifact.ref],
        commandId: action.id,
        exitCode: result.exitCode,
        unverified: result.exitCode !== 0,
        noOutputWatchdog: result.watchdogTriggered,
      };
    },
    coverage_table: async ({ mission, action, runner }) => {
      const state = runner.store.readState(mission.missionId);
      const events = runner.store.readEvents(mission.missionId, { limit: 5000 });
      const evidenceRefs = state.evidenceRefs || [];
      const targetRef = artifactRef(mission.missionId, action.name || 'coverage-table.json');
      const required = (mission.evidenceRequirements || []).map((item) => ({
        id: item.id,
        ref: item.ref || item.path,
        linked: (item.ref || item.path) === targetRef || evidenceRefs.includes(item.ref || item.path),
        readable: (item.ref || item.path) === targetRef || (store || runner.store).refExists(item.ref || item.path),
      }));
      const commands = (mission.plan || [])
        .filter((item) => item.type === 'run_command')
        .map((item) => {
          const event = events.find((e) => e.commandId === item.id && /mission\.command\./.test(e.type));
          return { id: item.id, command: item.command, exitCode: event?.exitCode ?? null, evidenceRefs: event?.evidenceRefs || [] };
        });
      const payload = {
        ok: required.every((item) => item.linked && item.readable) && commands.every((item) => item.exitCode === 0),
        requiredEvidence: required,
        commands,
        sliceCount: state.current_slice,
        checkpointCount: events.filter((event) => event.type === 'mission.checkpoint.written').length,
      };
      const artifact = runner.store.writeArtifact(mission.missionId, action.name || 'coverage-table.json', payload);
      return { ok: payload.ok, artifactRef: artifact.ref, evidenceRefs: [artifact.ref], exitCode: payload.ok ? 0 : 1, unverified: !payload.ok };
    },
  };
}
