#!/usr/bin/env node
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateNoeConsensusLedger } from '../src/room/NoeConsensusGate.js';
import { buildNoeConsensusLedger } from '../src/room/NoeConsensusLedger.js';
import { validateNoeSelfEvolutionCycle } from '../src/room/NoeSelfEvolutionCycle.js';
import { evaluateNoeSelfEvolutionLoop } from '../src/room/NoeSelfEvolutionLoop.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const files = {
  agents: join(ROOT, 'AGENTS.md'),
  protocol: join(ROOT, 'docs', 'Noe多模型协作协议_2026-06-06.md'),
  plan: join(ROOT, 'docs', 'Noe自我进化闭环方案_2026-06-07.md'),
  retro: join(ROOT, 'docs', 'Noe四模型协作复盘与改进计划_2026-06-07.md'),
  gate: join(ROOT, 'src', 'room', 'NoeConsensusGate.js'),
  executionAuthority: join(ROOT, 'src', 'room', 'NoeExecutionAuthority.js'),
  ledger: join(ROOT, 'src', 'room', 'NoeConsensusLedger.js'),
  round: join(ROOT, 'src', 'room', 'NoeConsensusRound.js'),
  runner: join(ROOT, 'src', 'room', 'NoeConsensusRunner.js'),
  prompts: join(ROOT, 'src', 'room', 'NoeConsensusPrompts.js'),
  supportFiles: join(ROOT, 'src', 'room', 'NoeConsensusSupportFiles.js'),
  participantRuntime: join(ROOT, 'src', 'room', 'NoeConsensusParticipantRuntime.js'),
  evolutionGate: join(ROOT, 'src', 'room', 'NoeSelfEvolutionGate.js'),
  evolutionLoop: join(ROOT, 'src', 'room', 'NoeSelfEvolutionLoop.js'),
  evolutionCycle: join(ROOT, 'src', 'room', 'NoeSelfEvolutionCycle.js'),
  postReviewGate: join(ROOT, 'src', 'room', 'NoePostReviewGate.js'),
  crossVerifyDispatcher: join(ROOT, 'src', 'room', 'CrossVerifyDispatcher.js'),
  aiSearch: join(ROOT, 'src', 'research', 'AISearch.js'),
  actGuard: join(ROOT, 'src', 'loop', 'NoeSelfEvolutionActGuard.js'),
  actPipeline: join(ROOT, 'src', 'loop', 'ActPipeline.js'),
  phase5Verify: join(ROOT, 'scripts', 'noe-phase5-runtime-verify.mjs'),
  realUseReplay: join(ROOT, 'scripts', 'noe-real-use-replay.mjs'),
  gateTest: join(ROOT, 'tests', 'unit', 'noe-consensus-gate.test.js'),
  activeExecutorGateTest: join(ROOT, 'tests', 'unit', 'noe-consensus-active-executor-gate.test.js'),
  ledgerTest: join(ROOT, 'tests', 'unit', 'noe-consensus-ledger.test.js'),
  roundTest: join(ROOT, 'tests', 'unit', 'noe-consensus-round.test.js'),
  runnerTest: join(ROOT, 'tests', 'unit', 'noe-consensus-runner.test.js'),
  runnerSupportTest: join(ROOT, 'tests', 'unit', 'noe-consensus-runner-support.test.js'),
  evolutionGateTest: join(ROOT, 'tests', 'unit', 'noe-self-evolution-gate.test.js'),
  evolutionGatePostReviewTest: join(ROOT, 'tests', 'unit', 'noe-self-evolution-gate-post-review.test.js'),
  evolutionGateTierTest: join(ROOT, 'tests', 'unit', 'noe-self-evolution-gate-tier.test.js'),
  evolutionLoopTest: join(ROOT, 'tests', 'unit', 'noe-self-evolution-loop.test.js'),
  evolutionCycleTest: join(ROOT, 'tests', 'unit', 'noe-self-evolution-cycle.test.js'),
  actPipelineTest: join(ROOT, 'tests', 'unit', 'noe-act-pipeline.test.js'),
  actGuardTest: join(ROOT, 'tests', 'unit', 'noe-self-evolution-act-guard.test.js'),
  ledgerVerify: join(ROOT, 'scripts', 'noe-consensus-ledger-verify.mjs'),
  completionAudit: join(ROOT, 'scripts', 'noe-self-evolution-completion-audit.mjs'),
  cycleAssemble: join(ROOT, 'scripts', 'noe-self-evolution-cycle-assemble.mjs'),
  roundAssemble: join(ROOT, 'scripts', 'noe-consensus-round-assemble.mjs'),
  consensusRound: join(ROOT, 'scripts', 'noe-four-model-consensus-round.mjs'),
  packageJson: join(ROOT, 'package.json'),
};

function read(file) {
  return readFileSync(file, 'utf8');
}

function add(checks, id, ok, details = {}) {
  checks.push({ id, ok: Boolean(ok), details });
}

function has(text, needle) {
  return text.includes(needle);
}

function lineCount(text) {
  return text.split(/\r?\n/).length;
}

function sampleLedger() {
  const evidenceRef = 'docs/Noe自我进化闭环方案_2026-06-07.md';
  return buildNoeConsensusLedger({
    roundId: 'verifier-sample',
    goal: 'Noe self evolution loop with core three-model consensus',
    evidenceRef,
    votes: [
      {
        model: 'codex',
        decision: 'approve_with_changes',
        authority: 'writer_integrator',
        canWrite: true,
        consensusVote: 'yes',
        recommendedFirstSlice: ['run the guarded self-evolution sample through dry-run verification'],
        verificationRequired: ['verify the sample ledger with current consensus gate rules'],
        rawOutputRef: 'output/noe-multimodel/codex-synthesis-2026-06-07.txt',
        evidenceRef,
      },
      {
        model: 'claude',
        decision: 'approve_with_changes',
        authority: 'readonly_source_reviewer',
        canWrite: false,
        firstClass: true,
        consensusVote: 'yes',
        recommendedFirstSlice: ['review the guarded self-evolution sample before any apply path'],
        verificationRequired: ['verify Claude remains readonly and first-class in the sample ledger'],
        rawOutputRef: 'output/noe-multimodel/claude-review-2026-06-07.txt',
        evidenceRef,
      },
      {
        model: 'm3',
        decision: 'approve_with_changes',
        authority: 'suggestion_only',
        canWrite: false,
        consensusVote: 'yes',
        recommendedFirstSlice: ['keep M3 suggestions advisory-only for the sample ledger'],
        verificationRequired: ['verify M3 remains suggestion-only and cannot write'],
        rawOutputRef: 'output/noe-multimodel/m3-suggestion-2026-06-07.json',
        evidenceRef,
      },
    ],
    implementation: {
        writer: 'codex',
        authorizationRequired: true,
        runtimeVerificationRequired: true,
        rollbackRequired: true,
        memoryWritebackAckRequired: true,
      },
  }, { createdAt: '2026-06-07T00:00:00.000Z' });
}

function main() {
  const checks = [];
  for (const [id, file] of Object.entries(files)) add(checks, `exists_${id}`, existsSync(file), { file });
  if (checks.some((check) => !check.ok)) return finish(checks);

  const agents = read(files.agents);
  const protocol = read(files.protocol);
  const plan = read(files.plan);
  const retro = read(files.retro);
  const gate = read(files.gate);
  const executionAuthority = read(files.executionAuthority);
  const ledger = read(files.ledger);
  const round = read(files.round);
  const runner = read(files.runner);
  const prompts = read(files.prompts);
  const supportFiles = read(files.supportFiles);
  const participantRuntime = read(files.participantRuntime);
  const consensusRoundScript = read(files.consensusRound);
  const evolutionGate = read(files.evolutionGate);
  const evolutionLoop = read(files.evolutionLoop);
  const evolutionCycle = read(files.evolutionCycle);
  const postReviewGate = read(files.postReviewGate);
  const crossVerifyDispatcher = read(files.crossVerifyDispatcher);
  const aiSearch = read(files.aiSearch);
  const actGuard = read(files.actGuard);
  const actPipeline = read(files.actPipeline);
  const phase5Verify = read(files.phase5Verify);
  const realUseReplay = read(files.realUseReplay);
  const gateTest = read(files.gateTest);
  const activeExecutorGateTest = read(files.activeExecutorGateTest);
  const ledgerTest = read(files.ledgerTest);
  const roundTest = read(files.roundTest);
  const runnerTest = read(files.runnerTest);
  const runnerSupportTest = read(files.runnerSupportTest);
  const evolutionGateTest = read(files.evolutionGateTest);
  const evolutionLoopTest = read(files.evolutionLoopTest);
  const evolutionCycleTest = read(files.evolutionCycleTest);
  const actPipelineTest = read(files.actPipelineTest);
  const actGuardTest = read(files.actGuardTest);
  const ledgerVerify = read(files.ledgerVerify);
  const completionAudit = read(files.completionAudit);
  const cycleAssemble = read(files.cycleAssemble);
  const pkg = JSON.parse(read(files.packageJson));
  const joined = [agents, protocol, plan, retro].join('\n');

  add(checks, 'gate_under_500_lines', lineCount(gate) <= 500, { lines: lineCount(gate) });
  add(checks, 'execution_authority_under_500_lines', lineCount(executionAuthority) <= 500, { lines: lineCount(executionAuthority) });
  add(checks, 'ledger_under_500_lines', lineCount(ledger) <= 500, { lines: lineCount(ledger) });
  add(checks, 'round_under_500_lines', lineCount(round) <= 500, { lines: lineCount(round) });
  add(checks, 'runner_under_500_lines', lineCount(runner) <= 500, { lines: lineCount(runner) });
  add(checks, 'prompts_under_500_lines', lineCount(prompts) <= 500, { lines: lineCount(prompts) });
  add(checks, 'support_files_under_500_lines', lineCount(supportFiles) <= 500, { lines: lineCount(supportFiles) });
  add(checks, 'participant_runtime_under_500_lines', lineCount(participantRuntime) <= 500, { lines: lineCount(participantRuntime) });
  add(checks, 'completion_audit_under_500_lines', lineCount(completionAudit) <= 500, { lines: lineCount(completionAudit) });
  add(checks, 'cycle_assemble_under_500_lines', lineCount(cycleAssemble) <= 500, { lines: lineCount(cycleAssemble) });
  add(checks, 'retro_under_500_lines', lineCount(retro) <= 500, { lines: lineCount(retro) });
  add(checks, 'evolution_gate_under_500_lines', lineCount(evolutionGate) <= 500, { lines: lineCount(evolutionGate) });
  add(checks, 'evolution_loop_under_500_lines', lineCount(evolutionLoop) <= 500, { lines: lineCount(evolutionLoop) });
  add(checks, 'evolution_cycle_under_500_lines', lineCount(evolutionCycle) <= 500, { lines: lineCount(evolutionCycle) });
  add(checks, 'act_guard_under_500_lines', lineCount(actGuard) <= 500, { lines: lineCount(actGuard) });
  add(checks, 'act_pipeline_under_500_lines', lineCount(actPipeline) <= 500, { lines: lineCount(actPipeline) });
  add(checks, 'gate_test_under_500_lines', lineCount(gateTest) <= 500, { lines: lineCount(gateTest) });
  add(checks, 'active_executor_gate_test_under_500_lines', lineCount(activeExecutorGateTest) <= 500, { lines: lineCount(activeExecutorGateTest) });
  add(checks, 'ledger_test_under_500_lines', lineCount(ledgerTest) <= 500, { lines: lineCount(ledgerTest) });
  add(checks, 'round_test_under_500_lines', lineCount(roundTest) <= 500, { lines: lineCount(roundTest) });
  add(checks, 'runner_test_under_500_lines', lineCount(runnerTest) <= 500, { lines: lineCount(runnerTest) });
  add(checks, 'runner_support_test_under_500_lines', lineCount(runnerSupportTest) <= 500, { lines: lineCount(runnerSupportTest) });
  add(checks, 'evolution_gate_test_under_500_lines', lineCount(evolutionGateTest) <= 500, { lines: lineCount(evolutionGateTest) });
  add(checks, 'evolution_gate_post_review_test_under_500_lines', lineCount(read(files.evolutionGatePostReviewTest)) <= 500, { lines: lineCount(read(files.evolutionGatePostReviewTest)) });
  add(checks, 'evolution_gate_tier_test_under_500_lines', lineCount(read(files.evolutionGateTierTest)) <= 500, { lines: lineCount(read(files.evolutionGateTierTest)) });
  add(checks, 'evolution_gate_tier_test_covers_green_and_review_tier', has(read(files.evolutionGateTierTest), 'green-tier autonomy') && has(read(files.evolutionGateTierTest), 'reviewTier'));
  add(checks, 'evolution_loop_test_under_500_lines', lineCount(evolutionLoopTest) <= 500, { lines: lineCount(evolutionLoopTest) });
  add(checks, 'evolution_cycle_test_under_500_lines', lineCount(evolutionCycleTest) <= 500, { lines: lineCount(evolutionCycleTest) });
  add(checks, 'act_pipeline_test_under_500_lines', lineCount(actPipelineTest) <= 500, { lines: lineCount(actPipelineTest) });
  add(checks, 'act_guard_test_under_500_lines', lineCount(actGuardTest) <= 500, { lines: lineCount(actGuardTest) });
  add(checks, 'package_has_verify_script', typeof pkg.scripts?.['verify:noe:self-evolution'] === 'string');
  add(checks, 'package_has_consensus_ledger_verify_script', typeof pkg.scripts?.['verify:noe:consensus-ledger'] === 'string');
  add(checks, 'package_has_completion_audit_script', typeof pkg.scripts?.['audit:noe:self-evolution-completion'] === 'string');
  add(checks, 'package_has_cycle_assemble_script', typeof pkg.scripts?.['noe:self-evolution:cycle'] === 'string');
  add(checks, 'package_has_four_model_round_script', typeof pkg.scripts?.['noe:consensus:round'] === 'string');
  add(checks, 'package_has_consensus_assemble_script', typeof pkg.scripts?.['noe:consensus:assemble'] === 'string');
  add(checks, 'package_has_consensus_test_script', typeof pkg.scripts?.['test:noe:consensus'] === 'string');
  add(checks, 'consensus_round_script_requires_ack_cost', has(consensusRoundScript, '--ack-cost'));
  add(checks, 'consensus_runner_requires_cost_ack', has(runner, 'model_cost_ack_required'));
  add(checks, 'ledger_verify_supports_require_passed', has(ledgerVerify, '--require-passed') && has(ledgerVerify, 'requirePassed'));
  add(checks, 'ledger_verify_marks_blocked_artifacts', has(ledgerVerify, 'BLOCKED') && has(ledgerVerify, 'artifactOk'));
  add(checks, 'completion_audit_supports_require_complete', has(completionAudit, '--require-complete') && has(completionAudit, 'production_ledger_passed_requirements'));
  add(checks, 'completion_audit_checks_dynamic_quorum_and_cycle', has(completionAudit, 'dynamic_quorum_policy_enforced') && has(completionAudit, 'complete_cycle_artifact_exists') && has(completionAudit, 'memory_writeback_authorized'));
  add(checks, 'completion_audit_validates_matching_cycle', has(completionAudit, 'matchingCompleteCycle') && has(completionAudit, 'validateNoeSelfEvolutionCycle') && has(completionAudit, 'cycleLedgerRef(cycle) !== ledgerRef'));
  add(checks, 'completion_audit_separates_structural_and_external_blockers', has(completionAudit, 'isExternalLedgerError') && has(completionAudit, 'errors.every(isExternalLedgerError)'));
  add(checks, 'completion_audit_memory_writeback_can_pass_from_valid_cycle', has(completionAudit, 'memoryWritebackAuthorized') && has(completionAudit, 'memory.consensusAck === true'));
  add(checks, 'completion_audit_hides_missing_for_passed_items', has(completionAudit, "missing: status === 'pass' ? [] : missing"));
  add(checks, 'cycle_assemble_validates_before_write', has(cycleAssemble, 'validateNoeSelfEvolutionCycle') && has(cycleAssemble, '--post-review') && has(cycleAssemble, '--memory-summary') && has(cycleAssemble, 'writeCycle'));
  add(checks, 'cycle_assemble_blocks_unverified_write', has(cycleAssemble, 'no_require_files_only_supported_for_dry_run'));
  add(checks, 'consensus_gate_uses_dynamic_quorum', has(gate, 'quorumThresholdForAvailableModels') && has(gate, 'insufficient_available_models') && has(gate, 'availableCount'));
  add(checks, 'execution_authority_validates_active_executor', has(executionAuthority, 'resolveNoeActiveExecutor') && has(executionAuthority, 'active_executor_requires_explicit_selection') && has(executionAuthority, 'implementation_writer_must_match_active_executor'));
  add(checks, 'consensus_gate_test_covers_all_unavailable_combinations', has(gateTest, 'every single-model unavailable combination') && has(gateTest, 'every two-model unavailable combination'));
  add(checks, 'active_executor_gate_test_covers_claude_executor', has(activeExecutorGateTest, 'allows Claude to be the selected active executor') && has(activeExecutorGateTest, 'active_executor_requires_explicit_selection:claude'));
  add(checks, 'act_guard_invokes_self_evolution_gate', has(actGuard, 'evaluateNoeSelfEvolutionGate'));
  add(checks, 'act_guard_overrides_payload_root', has(actGuard, 'trustedRootFromArgs') && has(actGuard, 'root: trustedRootFromArgs'));
  add(checks, 'act_guard_derives_consensus_approval', has(actGuard, 'consensusApproved: approvedByConsensus'));
  add(checks, 'act_guard_requires_ledger_ref_for_consensus_auth', has(actGuard, 'consensus_authorization_requires_ledger_ref') && has(actGuard, 'if (!ledgerRef) return false'));
  add(checks, 'act_guard_derives_user_approval', has(actGuard, 'userApproved: approvedByPermission'));
  add(checks, 'act_guard_ignores_payload_user_approval', has(actGuard, 'payload_user_approval_ignored'));
  add(checks, 'act_guard_uses_module_derived_root', has(actGuard, 'DEFAULT_NOE_SELF_EVOLUTION_ACT_GUARD_ROOT') && has(actGuard, 'fileURLToPath(import.meta.url)') && !has(actGuard, '|| process.cwd()'));
  add(checks, 'act_guard_requires_ledger_ref_for_execution', has(actGuard, 'ledger_ref_required_for_execution_authorization') && has(actGuard, 'ledger: undefined'));
  add(checks, 'self_evolution_gate_requires_ledger_verified_consensus', has(evolutionGate, 'ledgerVerified') && has(evolutionGate, 'unverified_consensus_summary'));
  add(checks, 'self_evolution_gate_uses_ledger_artifact_validation', has(evolutionGate, 'validateNoeConsensusLedgerArtifact'));
  add(checks, 'self_evolution_gate_supports_ledger_file_ref', has(evolutionGate, 'ledgerRefFromInput') && has(evolutionGate, 'readNoeConsensusLedgerFile') && has(evolutionGate, 'resolveNoeConsensusRef'));
  add(checks, 'self_evolution_gate_requires_ledger_ref_files', has(evolutionGate, 'requireEvidenceFile: true') && has(evolutionGate, 'requireRawOutputFiles: true'));
  add(checks, 'self_evolution_gate_inline_ledger_requires_files_unless_dry_run', has(evolutionGate, 'inlineLedgerRequiresFiles') && has(evolutionGate, "input.dryRun !== true"));
  add(checks, 'self_evolution_gate_complete_aligns_post_review_with_cycle', has(evolutionGate, 'validateNoePostReview') && has(evolutionGate, 'resolveGateActiveExecutor') && !has(evolutionGate, 'non_implementer_review_required'));
  add(checks, 'post_review_gate_enforces_dynamic_quorum_and_required_reviewers', has(postReviewGate, 'requiredReviewerModels') && has(postReviewGate, 'quorumThresholdForAvailableModels') && has(postReviewGate, '_dynamic_quorum_required') && has(postReviewGate, '_missing_required_reviewer') && has(postReviewGate, '_non_implementer_must_not_write'));
  add(checks, 'evolution_cycle_uses_shared_post_review_gate', has(evolutionCycle, 'validateNoePostReview') && has(evolutionCycle, "prefix: 'cycle_post_review'"));
  add(checks, 'evolution_loop_aligns_post_review_approvals', has(evolutionLoop, 'loopPostReviewApprovals') && has(evolutionLoop, 'nonImplementerApprovals'));
  add(checks, 'post_review_gate_under_500_lines', lineCount(postReviewGate) <= 500, { lines: lineCount(postReviewGate) });
  add(checks, 'evolution_loop_invokes_self_evolution_gate', has(evolutionLoop, 'evaluateNoeSelfEvolutionGate'));
  add(checks, 'evolution_cycle_invokes_self_evolution_loop', has(evolutionCycle, 'evaluateNoeSelfEvolutionLoop'));
  add(checks, 'evolution_cycle_requires_ledger_artifact', has(evolutionCycle, 'consensus_ledger_artifact_required'));
  add(checks, 'evolution_cycle_requires_post_review_dynamic_quorum', has(evolutionCycle, 'validateNoePostReview') && has(evolutionCycle, "prefix: 'cycle_post_review'") && has(postReviewGate, '_dynamic_quorum_required') && has(postReviewGate, '_missing_required_reviewer') && has(postReviewGate, 'quorumThresholdForAvailableModels'));
  add(checks, 'evolution_cycle_test_covers_all_post_review_unavailable_combinations', has(evolutionCycleTest, 'every single unavailable required post-review model') && has(evolutionCycleTest, 'every two-model unavailable post-review combination') && has(evolutionCycleTest, 'requires both available post-review models to approve'));
  add(checks, 'cluster_member_call_default_no_hard_timeout', has(crossVerifyDispatcher, 'return 0;') && !has(crossVerifyDispatcher, 'DEFAULT_CLUSTER_MEMBER_CALL_TIMEOUT_MS = 600_000'));
  add(checks, 'ai_search_cli_default_no_hard_timeout', has(aiSearch, '? 0') && !has(aiSearch, 'DEFAULT_CLI_TIMEOUT_MS'));
  add(checks, 'phase5_managed_uses_explicit_search_fixture', has(phase5Verify, "NOE_AI_SEARCH_MOCK: '1'") && has(phase5Verify, 'managed_search_fixture_is_explicit'));
  add(checks, 'real_use_managed_uses_explicit_search_fixture', has(realUseReplay, "NOE_AI_SEARCH_MOCK: '1'") && has(realUseReplay, 'managed_search_fixture_is_explicit'));
  add(checks, 'evolution_loop_test_covers_repair', has(evolutionLoopTest, 'self_repair_ready'));
  add(checks, 'evolution_loop_test_covers_retrospective', has(evolutionLoopTest, 'retrospective_required'));
  add(checks, 'evolution_loop_test_covers_memory_ready', has(evolutionLoopTest, 'memory_writeback_ready'));
  add(checks, 'evolution_cycle_test_covers_unvalidated_consensus', has(evolutionCycleTest, 'missing ledger file') && has(evolutionCycleTest, 'forged gate'));
  add(checks, 'evolution_cycle_test_covers_non_implementer_post_review', has(evolutionCycleTest, 'non-implementer post-review') && has(evolutionCycleTest, 'dynamic quorum across required non-implementer post-review models'));
  add(checks, 'act_pipeline_invokes_act_guard', has(actPipeline, 'selfEvolutionGate'));
  add(checks, 'act_pipeline_uses_trusted_self_evolution_root', has(actPipeline, 'selfEvolutionRoot') && has(actPipeline, 'root: this.selfEvolutionRoot'));
  add(checks, 'act_pipeline_uses_module_derived_self_evolution_root', has(actPipeline, 'DEFAULT_NOE_SELF_EVOLUTION_ROOT') && has(actPipeline, 'fileURLToPath(import.meta.url)'));
  add(checks, 'act_pipeline_test_covers_self_evolution_guard', has(actPipelineTest, 'self_evolution_gate_blocked'));
  add(checks, 'act_pipeline_test_blocks_forged_consensus_summary', has(actPipelineTest, 'forge a validated consensus summary'));
  add(checks, 'act_pipeline_test_covers_ledger_file_ref', has(actPipelineTest, 'artifact-valid ledger file ref'));
  add(checks, 'act_pipeline_test_blocks_missing_ledger_ref_files', has(actPipelineTest, 'raw model outputs are missing'));
  add(checks, 'act_pipeline_test_blocks_payload_root_injection', has(actPipelineTest, 'payload root injection'));
  add(checks, 'act_pipeline_test_blocks_payload_ledger_object_auth', has(actPipelineTest, 'payload ledger object'));
  add(checks, 'act_pipeline_test_blocks_payload_user_approval', has(actPipelineTest, 'payload userApproved'));
  add(checks, 'act_pipeline_test_covers_module_derived_root', has(actPipelineTest, 'module-derived self-evolution root'));
  add(checks, 'act_guard_test_covers_module_root', has(actGuardTest, 'module-derived root'));
  add(checks, 'act_guard_test_blocks_payload_ledger_object', has(actGuardTest, 'payload ledger object replace the ledgerRef'));
  add(checks, 'act_guard_test_requires_ledger_ref_with_approval', has(actGuardTest, 'requires ledgerRef even when real approval is present'));
  add(checks, 'gate_test_blocks_malformed_ledger_object', has(evolutionGateTest, 'artifact validation before authorization'));
  add(checks, 'gate_test_covers_ledger_file_ref_and_escape', has(evolutionGateTest, 'artifact-valid ledger file ref') && has(evolutionGateTest, 'escape the repo root'));
  add(checks, 'gate_test_blocks_missing_ledger_ref_files', has(evolutionGateTest, 'referenced evidence files are missing'));
  add(checks, 'evolution_cycle_test_blocks_gate_only_consensus', has(evolutionCycleTest, 'not only an ok-shaped gate'));

  const requiredText = [
    ['claude_first_class_doc', 'Claude 必须是一等参与者'],
    ['dynamic_quorum_doc', '动态 quorum'],
    ['consensus_ledger_doc', 'consensus ledger'],
    ['consensus_ledger_module_doc', 'NoeConsensusLedger'],
    ['consensus_round_module_doc', 'NoeConsensusRound'],
    ['consensus_runner_module_doc', 'NoeConsensusRunner'],
    ['self_evolution_gate_module_doc', 'NoeSelfEvolutionGate'],
    ['self_evolution_loop_module_doc', 'NoeSelfEvolutionLoop'],
    ['self_evolution_cycle_module_doc', 'NoeSelfEvolutionCycle'],
    ['self_evolution_act_guard_doc', 'NoeSelfEvolutionActGuard'],
    ['act_pipeline_doc', 'ActPipeline'],
    ['permission_governance_doc', 'PermissionGovernance'],
    ['consensus_round_cli_doc', 'noe:consensus:round'],
    ['ack_cost_doc', '--ack-cost'],
    ['cost_acknowledged_doc', 'costAcknowledged'],
    ['consensus_assemble_doc', 'noe:consensus:assemble'],
    ['raw_outputs_doc', 'rawOutputRef'],
    ['dynamic_quorum_fallback_doc', '2/3'],
    ['all_unavailable_combinations_doc', '任意 1 个 unavailable'],
    ['consensus_vote_doc', 'consensus_vote'],
    ['m3_content_overreach_doc', 'M3 内容级越权'],
    ['active_executor_doc', 'active executor'],
    ['active_executor_claude_selection_doc', 'Claude 可以作为唯一 writer'],
    ['active_executor_module_doc', 'NoeExecutionAuthority'],
    ['m3_suggestion_only_doc', 'M3 suggestion-only'],
    ['gemini_advisory_doc', 'Gemini advisory'],
    ['no_model_timeout_doc', '不要给模型设置人为硬超时'],
    ['cluster_no_hard_timeout_doc', 'cluster member call'],
    ['managed_search_fixture_doc', 'NOE_AI_SEARCH_MOCK'],
    ['no_51735_doc', '51735'],
    ['51835_user_or_consensus_gated_doc', '51835'],
    ['runtime_verification_doc', 'runtime verification'],
    ['rollback_doc', 'rollback'],
    ['memory_writeback_doc', 'memory writeback'],
    ['user_cost_gate_doc', '成本'],
    ['consensus_authorized_sensitive_actions_doc', 'consensus_authorized_sensitive_actions'],
    ['consensus_authorized_secret_access_doc', 'consensus_authorized_secret_access'],
    ['system_level_not_consensus_authorizable_doc', 'system_level_not_consensus_authorizable'],
    ['consensus_replaces_manual_confirmation_doc', '动态 quorum 共识可替代用户亲自确认'],
    ['abstain_unavailable_doc', 'abstain/unavailable'],
    ['health_check_doc', 'health check'],
    ['self_repair_doc', '自我修复'],
    ['memory_writeback_gate_doc', 'memory writeback 确认'],
    ['collaboration_retro_doc', '四模型协作复盘'],
    ['collaboration_retro_thread_doc', '019e9d92-62a1-7ee1-8375-055f98d86cce'],
    ['collaboration_retro_sensitive_capabilities_doc', 'sensitive capability'],
    ['collaboration_retro_not_perfect_doc', '没有达到“已经完美”'],
    ['validated_consensus_gate_doc', 'validated consensus ledger gate'],
    ['retrospective_required_doc', 'retrospectiveRef'],
    ['cycle_evidence_doc', 'cycle artifact'],
    ['post_review_raw_output_doc', 'post-review rawOutputRef'],
    ['production_blocked_round_doc', 'production-self-evolution-governance-20260607-1'],
    ['production_dynamic_quorum_passed_doc', 'available=3'],
    ['require_passed_authorization_doc', '--require-passed'],
    ['completion_audit_doc', 'audit:noe:self-evolution-completion'],
    ['require_complete_doc', '--require-complete'],
    ['insufficient_models_stop_doc', '少于 2 个模型可用'],
    ['experience_share_not_memory_writeback_doc', '分享经验给 Claude 线程不等于 memory writeback'],
    ['premature_memory_note_doc', 'premature/advisory'],
    ['passed_ledger_memory_writeback_doc', 'passed production ledger'],
    ['ledger_backed_consensus_doc', 'ledger-backed consensus'],
    ['unverified_consensus_summary_doc', 'unverified_consensus_summary'],
    ['artifact_valid_ledger_doc', 'artifact-valid'],
    ['ledger_artifact_validator_doc', 'validateNoeConsensusLedgerArtifact'],
    ['ledger_file_ref_doc', 'ledgerRef'],
    ['ledger_ref_path_escape_doc', '路径逃逸'],
    ['ledger_ref_requires_raw_outputs_doc', 'ledgerRef 原始证据文件'],
    ['payload_root_injection_doc', 'payload root 注入'],
    ['payload_consensus_approval_doc', 'payload consensusApproved'],
    ['module_derived_root_doc', 'module-derived selfEvolutionRoot'],
    ['payload_user_approval_doc', 'payload userApproved'],
  ];
  for (const [id, needle] of requiredText) add(checks, id, has(joined, needle));

  const ledgerResult = validateNoeConsensusLedger(sampleLedger());
  add(checks, 'sample_ledger_passes_gate', ledgerResult.ok, ledgerResult);

  const loopResult = evaluateNoeSelfEvolutionLoop({
    goal: 'Noe self evolution loop verifier sample',
    // 样例只验证 loop 阶段路由（不落盘证据），走 dry-run 跳过文件存在性。
    dryRun: true,
    ledger: sampleLedger(),
    authorization: {
      userApproved: false,
      consensusApproved: true,
      scope: 'verifier sample',
      costClass: 'local_or_user_approved_model_calls',
    },
    rollback: { planRef: 'output/noe-multimodel/verifier/rollback.md' },
    implementation: { done: true },
    runtimeVerification: { ok: true, reportRef: 'output/noe-full-current/pass.json' },
    // 与 cycle 层对齐：complete 需真实非实施者复核（排除 codex 执行者）+ 动态 quorum + rawOutputRef。
    postReview: {
      ok: true,
      reviews: [
        { model: 'claude', decision: 'approve', authority: 'readonly_source_reviewer', canWrite: false, rawOutputRef: 'output/noe-multimodel/verifier/claude-post-review.txt' },
        { model: 'm3', decision: 'approve', authority: 'suggestion_only', canWrite: false, rawOutputRef: 'output/noe-multimodel/verifier/m3-post-review.txt' },
      ],
    },
    retrospectiveRef: 'docs/Noe四模型协作复盘与改进计划_2026-06-07.md',
    memoryWriteback: {
      done: true,
      consensusAck: true,
      summaryRef: 'docs/HANDOFF_2026-06-06_codex交接.md',
    },
  });
  add(checks, 'sample_self_evolution_loop_completes', loopResult.ok && loopResult.stage === 'complete', loopResult);

  const cycleResult = validateNoeSelfEvolutionCycle({
    schemaVersion: 1,
    cycleId: 'verifier-cycle',
    createdAt: '2026-06-07T00:00:00.000Z',
    goal: 'Noe self evolution cycle verifier sample',
    ledger: sampleLedger(),
    authorization: {
      consensusApproved: true,
      scope: 'verifier cycle',
      costClass: 'local_or_user_approved_model_calls',
    },
    rollback: { planRef: 'output/noe-multimodel/verifier/rollback.md' },
    implementation: {
      done: true,
      writer: 'codex',
      diffRef: 'output/noe-multimodel/verifier/diff.patch',
      touchedFiles: ['src/room/NoeSelfEvolutionCycle.js'],
    },
    runtimeVerification: { ok: true, reportRef: 'output/noe-full-current/pass.json' },
    postReview: {
      ok: true,
      reviews: [
        {
          model: 'claude',
          decision: 'approve',
          authority: 'readonly_source_reviewer',
          canWrite: false,
          rawOutputRef: 'output/noe-multimodel/verifier/claude-post-review.txt',
        },
        {
          model: 'm3',
          decision: 'approve',
          authority: 'suggestion_only',
          canWrite: false,
          rawOutputRef: 'output/noe-multimodel/verifier/m3-post-review.txt',
        },
      ],
    },
    retrospectiveRef: 'docs/Noe四模型协作复盘与改进计划_2026-06-07.md',
    memoryWriteback: {
      done: true,
      consensusAck: true,
      summaryRef: 'docs/HANDOFF_2026-06-06_codex交接.md',
    },
  });
  add(checks, 'sample_self_evolution_cycle_completes', cycleResult.ok && cycleResult.loop?.stage === 'complete', cycleResult);

  finish(checks);
}

function finish(checks) {
  const failed = checks.filter((check) => !check.ok);
  for (const check of checks) console.log(`${check.ok ? 'PASS' : 'FAIL'} ${check.id}`);
  if (failed.length) {
    console.error(JSON.stringify({ ok: false, failed }, null, 2));
    process.exit(1);
  }
  console.log(JSON.stringify({ ok: true, passed: checks.length, failed: 0 }, null, 2));
}

main();
