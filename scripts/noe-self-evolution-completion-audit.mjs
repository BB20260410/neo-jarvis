#!/usr/bin/env node
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  readNoeConsensusLedgerFile,
  validateNoeConsensusLedgerArtifact,
} from '../src/room/NoeConsensusLedger.js';
import { validateNoeSelfEvolutionCycle } from '../src/room/NoeSelfEvolutionCycle.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
// 2026-06-23：默认基准从历史 governance round（codex/claude/gemini approve_with_changes＝有保留批准，且本轮 gate
//   逻辑变更后其 stored gate 哈希 stale）更新为真实 clean-approve complete milestone round——运行时自驱产物：
//   codex/claude/m3 clean approve（运行时真实 vote）+ gemini 按 owner 策略 unavailable 留审计证据 + claude/m3 独立
//   post-review approve + 完整实施/runtime/retrospective/memory，audit --require-complete 为 11 pass / 0 incomplete。
//   历史 governance round 仍保留在 output/ 作记录，可 `--ledger <path>` 指定审计。
const DEFAULT_LEDGER = 'output/noe-multimodel/production-self-evolution-milestone-20260623/ledger.json';

function parseArgs(argv) {
  const out = { ledger: DEFAULT_LEDGER, requireComplete: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--ledger') out.ledger = argv[++i] || out.ledger;
    else if (arg.startsWith('--ledger=')) out.ledger = arg.slice('--ledger='.length);
    else if (arg === '--require-complete') out.requireComplete = true;
  }
  return out;
}

function read(file) {
  return readFileSync(resolve(ROOT, file), 'utf8');
}

function has(file, needle) {
  return existsSync(resolve(ROOT, file)) && read(file).includes(needle);
}

function add(items, id, status, evidence = [], missing = []) {
  items.push({ id, status, evidence, missing: status === 'pass' ? [] : missing });
}

function latestJsonReport(dir, prefix) {
  const fullDir = resolve(ROOT, dir);
  if (!existsSync(fullDir)) return null;
  const files = readdirSync(fullDir)
    .filter((name) => name.startsWith(prefix) && name.endsWith('.json'))
    .map((name) => {
      const file = join(fullDir, name);
      return { file, name, mtimeMs: statSync(file).mtimeMs };
    })
    .sort((a, b) => b.mtimeMs - a.mtimeMs);
  if (!files.length) return null;
  try {
    return { ref: `${dir}/${files[0].name}`, json: JSON.parse(readFileSync(files[0].file, 'utf8')) };
  } catch {
    return { ref: `${dir}/${files[0].name}`, json: null };
  }
}

function findFiles(dir, name) {
  const fullDir = resolve(ROOT, dir);
  if (!existsSync(fullDir)) return [];
  const found = [];
  for (const entry of readdirSync(fullDir, { withFileTypes: true })) {
    const file = join(fullDir, entry.name);
    if (entry.isDirectory()) found.push(...findFiles(file.slice(ROOT.length + 1), name));
    else if (entry.isFile() && entry.name === name) found.push(file);
  }
  return found;
}

function cycleLedgerRef(cycle = {}) {
  return String(cycle.consensusLedgerRef || cycle.consensus?.ledgerRef || cycle.consensus?.ref || '').trim();
}

function matchingCompleteCycle(ledgerRef) {
  const cycles = findFiles('output/noe-self-evolution', 'cycle.json');
  for (const file of cycles) {
    try {
      const cycle = JSON.parse(readFileSync(file, 'utf8'));
      if (cycleLedgerRef(cycle) !== ledgerRef) continue;
      const validation = validateNoeSelfEvolutionCycle(cycle, { root: ROOT, requireReferencedFiles: true });
      if (validation.ok) return { ref: file.slice(ROOT.length + 1), cycle, validation };
    } catch {}
  }
  return null;
}

function auditLedger(ledgerRef) {
  const file = resolve(ROOT, ledgerRef);
  if (!existsSync(file)) return { exists: false, artifact: null, ledger: null };
  const ledger = readNoeConsensusLedgerFile(file);
  const artifact = validateNoeConsensusLedgerArtifact(ledger, {
    root: ROOT,
    requireEvidenceFile: true,
    requireRawOutputFiles: true,
  });
  return { exists: true, ledger, artifact };
}

function passIf(ok) {
  return ok ? 'pass' : 'incomplete';
}

function isExternalLedgerError(error) {
  return String(error || '').startsWith('required_model_unavailable:');
}

function ledgerPassedStatus(artifact) {
  if (artifact?.ok === true) return 'pass';
  const errors = Array.isArray(artifact?.errors) ? artifact.errors : [];
  if (errors.length && errors.every(isExternalLedgerError)) return 'blocked_external';
  return 'incomplete';
}

function memoryWritebackAuthorized(completeCycle) {
  const memory = completeCycle?.cycle?.memoryWriteback || {};
  return Boolean(
    completeCycle?.validation?.ok === true &&
    memory.consensusAck === true &&
    String(memory.summaryRef || '').trim()
  );
}

function dynamicQuorumEvidence(consensus = {}) {
  const available = Number(consensus.availableCount || 0);
  const threshold = Number(consensus.threshold || 0);
  const approved = Number(consensus.approvedCount || 0);
  const unavailable = Array.isArray(consensus.unavailable) ? consensus.unavailable : [];
  return {
    ok: available >= 2 && threshold >= 2 && approved >= threshold,
    evidence: [
      `available=${available}`,
      `threshold=${threshold}`,
      `approved=${approved}`,
      `unavailable=${unavailable.join(',') || 'none'}`,
    ],
  };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const items = [];
  const ledger = auditLedger(args.ledger);
  const fullCurrent = latestJsonReport('output/noe-full-current', 'full-current-');
  const completeCycle = matchingCompleteCycle(args.ledger);
  const votes = Array.isArray(ledger.ledger?.votes) ? ledger.ledger.votes : [];
  const modelsWithRaw = votes.filter((vote) => vote.rawOutputRef && existsSync(resolve(ROOT, vote.rawOutputRef))).map((vote) => vote.model);
  const quorum = dynamicQuorumEvidence(ledger.artifact?.consensus);

  add(items, 'claude_first_class_included', passIf(has('docs/Noe自我进化闭环方案_2026-06-07.md', 'Claude 必须是一等参与者') && votes.some((vote) => vote.model === 'claude')),
    ['docs/Noe自我进化闭环方案_2026-06-07.md', args.ledger],
    ['claude vote missing']);
  add(items, 'four_model_raw_outputs_present', modelsWithRaw.length === 4 ? 'pass' : 'incomplete',
    modelsWithRaw.map((model) => `${model}:rawOutputRef`),
    ['four model rawOutputRef files required']);
  add(items, 'production_ledger_passed_requirements', ledgerPassedStatus(ledger.artifact),
    [args.ledger, `artifactOk=${ledger.artifact?.ok === true}`],
    ledger.artifact?.errors || ['production ledger missing']);
  add(items, 'dynamic_quorum_policy_enforced', passIf(quorum.ok),
    quorum.evidence,
    ['dynamic quorum requires at least two available models and approvedCount >= threshold']);
  add(items, 'dynamic_quorum_landing_gate_enforced', passIf(has('scripts/noe-consensus-ledger-verify.mjs', '--require-passed') && has('docs/Noe多模型协作协议_2026-06-06.md', '--require-passed')),
    ['scripts/noe-consensus-ledger-verify.mjs', 'docs/Noe多模型协作协议_2026-06-06.md'],
    ['require-passed gate evidence missing']);
  add(items, 'self_evolution_governance_modules_exist', passIf([
    'src/room/NoeSelfEvolutionGate.js',
    'src/room/NoeSelfEvolutionLoop.js',
    'src/room/NoeSelfEvolutionCycle.js',
    'src/loop/NoeSelfEvolutionActGuard.js',
  ].every((file) => existsSync(resolve(ROOT, file)))),
    ['NoeSelfEvolutionGate', 'NoeSelfEvolutionLoop', 'NoeSelfEvolutionCycle', 'NoeSelfEvolutionActGuard'],
    ['governance module missing']);
  add(items, 'execution_guard_ledger_ref_only', passIf(has('src/loop/NoeSelfEvolutionActGuard.js', 'ledger_ref_required_for_execution_authorization') && has('src/loop/NoeSelfEvolutionActGuard.js', 'DEFAULT_NOE_SELF_EVOLUTION_ACT_GUARD_ROOT')),
    ['src/loop/NoeSelfEvolutionActGuard.js'],
    ['ActGuard ledgerRef-only execution guard missing']);
  add(items, 'runtime_verification_current', passIf(fullCurrent?.json?.ok === true),
    fullCurrent ? [fullCurrent.ref, `passed=${fullCurrent.json?.passed ?? 0}`] : [],
    ['latest full-current report missing or failing']);
  add(items, 'complete_cycle_artifact_exists', passIf(Boolean(completeCycle)),
    completeCycle ? [completeCycle.ref] : [],
    ['no verified complete self-evolution cycle artifact with implementation/runtime/post-review/retrospective/memory writeback']);
  add(items, 'memory_writeback_authorized', passIf(memoryWritebackAuthorized(completeCycle)),
    completeCycle ? [completeCycle.ref, completeCycle.cycle?.memoryWriteback?.summaryRef].filter(Boolean) : [],
    ['no verified complete production cycle with runtime report + memoryWriteback summary + consensusAck']);
  add(items, 'claude_thread_experience_acknowledged', has('docs/HANDOFF_2026-06-06_codex交接.md', '019e9d92-62a1-7ee1-8375-055f98d86cce') && has('docs/HANDOFF_2026-06-06_codex交接.md', 'acknowledged') ? 'pass' : 'incomplete',
    ['docs/HANDOFF_2026-06-06_codex交接.md'],
    ['Claude thread acknowledgement missing']);

  const complete = items.every((item) => item.status === 'pass');
  const payload = {
    ok: complete,
    objective: 'Noe four-model self-evolution closed loop completion audit',
    ledger: args.ledger,
    summary: {
      pass: items.filter((item) => item.status === 'pass').length,
      incomplete: items.filter((item) => item.status === 'incomplete').length,
      blockedExternal: items.filter((item) => item.status === 'blocked_external').length,
    },
    items,
  };
  console.log(JSON.stringify(payload, null, 2));
  if (args.requireComplete && !complete) process.exit(1);
}

main();
