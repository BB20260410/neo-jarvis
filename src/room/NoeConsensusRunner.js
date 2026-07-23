import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { buildNoeConsensusLedgerFromRawOutputs } from './NoeConsensusRound.js';
import {
  redactNoeConsensusText,
  resolveNoeConsensusRef,
  sha256Text,
  validateNoeConsensusLedgerArtifact,
  writeNoeConsensusLedgerFile,
} from './NoeConsensusLedger.js';
import {
  supportFileRefs,
  writeRoundSupportFiles,
} from './NoeConsensusSupportFiles.js';
import {
  NOE_CONSENSUS_M3_THINKING,
  NOE_CONSENSUS_MODELS,
  buildNoeConsensusBrief,
  buildNoeConsensusM3Options,
  buildNoeConsensusPrompt,
  boundariesForActiveExecutor,
  normalizeQualityProfile,
  qualityInstructionLines,
} from './NoeConsensusPrompts.js';
import {
  maybeRepairUnparsedParticipantJson,
  maybeRunCodexFallbackForUnavailable,
  runBuiltInParticipant,
  unavailableRaw,
} from './NoeConsensusParticipantRuntime.js';
import {
  assertNoeFinalStageSafeRef,
  validateNoeFinalStageAuthorizationMatrix,
  validateNoeFinalStageEvidence,
} from '../runtime/NoeFinalStageMatrix.js';
import {
  describeNoeProviderSecretFailure,
  resolveNoeProviderSecret,
} from '../secrets/NoeProviderSecrets.js';
import { normalizeExecutionActorId } from './NoeExecutionAuthority.js';

const MODELS = NOE_CONSENSUS_MODELS;

export { buildNoeCodexOutFile } from './NoeConsensusParticipantRuntime.js';
export {
  NOE_CONSENSUS_M3_MAX_COMPLETION_TOKENS,
  NOE_CONSENSUS_M3_SERVICE_TIER,
  buildNoeConsensusM3Options,
  buildNoeConsensusPrompt,
} from './NoeConsensusPrompts.js';

function cleanString(value) {
  return String(value || '').trim();
}

function safeSegment(value) {
  return cleanString(value).replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80) || 'round';
}

function nowRoundId() {
  return new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
}

function loadStageMatrixArtifact({ root, stageMatrixRef, requireComplete = false }) {
  const ref = cleanString(stageMatrixRef);
  if (!ref) return null;
  const safeMatrixRef = assertNoeFinalStageSafeRef(ref, {
    kind: 'stage_matrix',
    allowedPrefixes: ['output/noe-multimodel', 'output/noe-final-real-machine-stages'],
  });
  const file = resolveNoeConsensusRef(root, safeMatrixRef);
  const matrix = JSON.parse(readFileSync(file, 'utf8'));
  const authResult = validateNoeFinalStageAuthorizationMatrix(matrix);
  const stageEvidence = {};
  if (authResult.ok) {
    for (const id of ['B', 'C', 'D', 'E']) {
      const evidenceRef = cleanString(matrix.stageEvidenceRefs?.[id]);
      if (!evidenceRef) continue;
      const safeEvidenceRef = assertNoeFinalStageSafeRef(evidenceRef, {
        kind: `stage_evidence_ref:${id}`,
        allowedPrefixes: [matrix.stageEvidenceDir || 'output/noe-final-real-machine-stages'],
      });
      const evidenceFile = resolveNoeConsensusRef(root, safeEvidenceRef);
      if (existsSync(evidenceFile)) {
        stageEvidence[id] = JSON.parse(readFileSync(evidenceFile, 'utf8'));
      }
    }
  }
  const result = validateNoeFinalStageEvidence({ matrix, stageEvidence, requireComplete });
  return {
    type: 'final_stage_matrix',
    matrixRef: safeMatrixRef,
    requireComplete,
    ok: result.ok,
    completed: result.completed,
    requiredStages: result.requiredStages,
    errors: result.errors,
    warnings: result.warnings,
    countedInConsensus: false,
  };
}

function secretStatusForParticipant(model, secretResolver = resolveNoeProviderSecret) {
  const provider = model === 'm3' ? 'minimax' : model === 'xiaomi' ? 'xiaomi' : '';
  if (!provider) return null;
  const secret = secretResolver(provider);
  const source = redactNoeConsensusText(secret?.source || 'unconfigured');
  const sourceRef = secret?.ok ? redactNoeConsensusText(secret.sourceRef || '') || null : null;
  return {
    provider,
    configured: secret?.ok === true,
    source,
    sourceRef,
    message: secret?.ok
      ? redactNoeConsensusText(`${provider} key resolved from ${source}`)
      : describeNoeProviderSecretFailure(provider, secret),
  };
}

function m3ManifestOptions(qualityProfile) {
  const options = buildNoeConsensusM3Options({
    model: process.env.MINIMAX_MODEL || 'MiniMax-M3',
    qualityProfile,
  });
  return {
    model: options.model,
    thinking: { ...NOE_CONSENSUS_M3_THINKING },
    maxCompletionTokens: options.maxCompletionTokens,
    reasoningSplit: true,
    serviceTier: options.serviceTier,
    noAbort: true,
  };
}

export async function runNoeConsensusRound(input = {}, opts = {}) {
  const root = opts.root || process.cwd();
  if (input.runModels && input.costAcknowledged !== true) {
    throw new Error('model_cost_ack_required');
  }
  const roundId = input.roundId || `${nowRoundId()}-${safeSegment(input.goal)}`;
  const outDir = input.outDir || 'output/noe-multimodel';
  const roundRelDir = join(outDir, roundId);
  const roundDir = resolve(root, roundRelDir);
  mkdirSync(roundDir, { recursive: true });

  const goal = cleanString(input.goal);
  const evidenceText = redactNoeConsensusText(cleanString(input.evidenceText));
  const evidenceSha256 = sha256Text(evidenceText);
  const createdAt = new Date().toISOString();
  const activeExecutor = normalizeExecutionActorId(input.activeExecutor || input.implementation?.activeExecutor || input.implementation?.writer) || 'codex';
  const qualityProfile = normalizeQualityProfile(input.qualityProfile || input.implementation?.qualityProfile);
  const stageMatrixRef = input.stageMatrixRef || input.stageMatrix || input.implementation?.stageMatrixRef;
  if (cleanString(stageMatrixRef) && qualityProfile !== 'exhaustive') {
    throw new Error('stage_matrix_requires_exhaustive_quality_profile');
  }
  const stageMatrixArtifact = loadStageMatrixArtifact({
    root,
    stageMatrixRef,
    requireComplete: input.stageMatrixRequireComplete === true || input.requireStageComplete === true || input.implementation?.stageMatrixCompleteRequired === true,
  });
  const evidenceRef = join(roundRelDir, 'brief.md');
  const supportRefs = supportFileRefs(roundRelDir);
  writeFileSync(join(roundDir, 'brief.md'), `${buildNoeConsensusBrief({ goal, evidenceText, activeExecutor, qualityProfile })}\n`, { mode: 0o600 });

  const participants = MODELS.map((model) => ({
    model,
    rawOutputRef: join(roundRelDir, `${model}.txt`),
    rawOutputFile: join(roundDir, `${model}.txt`),
    prompt: buildNoeConsensusPrompt({ model, goal, evidenceRef, evidenceText, activeExecutor, qualityProfile }),
  }));
  const secretStatuses = Object.fromEntries(participants
    .map((item) => [item.model, secretStatusForParticipant(item.model, opts.secretResolver)])
    .filter(([, status]) => status));

  const manifest = {
    ok: true,
    status: input.runModels ? 'models_run' : 'dry_run',
    roundId,
    evidenceRef,
    evidenceTextRef: supportRefs.evidence,
    evidenceSha256,
    supportFiles: supportRefs,
    qualityProfile,
    qualityInstructions: qualityInstructionLines(qualityProfile),
    stageMatrix: stageMatrixArtifact || undefined,
    codexFallbackPolicy: {
      enabled: input.codexFallbackOnUnavailable !== false,
      countedInConsensus: false,
      reason: 'model_unavailable_or_no_quota',
    },
    jsonRepairPolicy: {
      enabled: input.jsonRepairOnUnparsed !== false,
      maxAttemptsPerParticipant: 1,
      countedInConsensus: 'same_model_only_when_parseable_and_identity_clean',
      noArtificialTimeout: true,
    },
    activeExecutor,
    participants: participants.map((item) => ({
      model: item.model,
      rawOutputRef: item.rawOutputRef,
      promptChars: item.prompt.length,
      runner: opts.runners?.[item.model]
        ? 'injected_runner'
        : (item.model === 'm3' ? 'MiniMaxChatAdapter' : item.model === 'xiaomi' ? 'OpenAICompatChatAdapter' : `${item.model} CLI`),
      modelOptions: item.model === 'm3' && !opts.runners?.m3 ? m3ManifestOptions(qualityProfile) : undefined,
      secretStatus: secretStatuses[item.model] || undefined,
    })),
  };

  writeRoundSupportFiles({
    roundDir,
    goal,
    evidenceRef,
    supportRefs,
    evidenceText,
    evidenceSha256,
    createdAt,
    qualityProfile,
    activeExecutor,
    manifest,
    stageMatrixArtifact,
  });
  writeFileSync(join(roundDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
  if (!input.runModels) return { ...manifest, roundDir, ledger: null };

  const supportArtifact = {
    type: 'round_support_files',
    countedInConsensus: false,
    files: supportRefs,
    evidenceSha256,
  };
  const roundArtifacts = [supportArtifact, ...(stageMatrixArtifact ? [stageMatrixArtifact] : [])];
  const fallbackArtifacts = [];
  for (const participant of participants) {
    const runner = opts.runners?.[participant.model];
    let raw;
    try {
      raw = runner
        ? await runner({ ...participant, goal, evidenceText, evidenceRef, root, qualityProfile })
        : await runBuiltInParticipant({ ...participant, root, activeExecutor, qualityProfile, secretResolver: opts.secretResolver });
    } catch (error) {
      raw = unavailableRaw(participant.model, error, activeExecutor);
    }
    let redactedRaw = redactNoeConsensusText(raw);
    const repair = await maybeRepairUnparsedParticipantJson({
      participant: { ...participant, evidenceRef },
      raw: redactedRaw,
      root,
      runners: opts.runners,
      secretResolver: opts.secretResolver,
      activeExecutor,
      qualityProfile,
      enabled: input.jsonRepairOnUnparsed !== false,
    });
    if (repair.artifact) roundArtifacts.push(repair.artifact);
    redactedRaw = repair.raw;
    writeFileSync(participant.rawOutputFile, `${redactedRaw}\n`, { mode: 0o600 });
    let fallback = null;
    try {
      fallback = await maybeRunCodexFallbackForUnavailable({
        participant,
        raw: redactedRaw,
        goal,
        evidenceText,
        evidenceRef,
        root,
        runners: opts.runners,
        secretResolver: opts.secretResolver,
        activeExecutor,
        qualityProfile,
        enabled: input.codexFallbackOnUnavailable !== false,
      });
    } catch {
      fallback = null;
    }
    if (fallback) {
      fallbackArtifacts.push(fallback);
      roundArtifacts.push(fallback);
    }
  }
  if (fallbackArtifacts.length || roundArtifacts.length) {
    manifest.fallbacks = fallbackArtifacts;
    manifest.artifacts = roundArtifacts;
    writeFileSync(join(roundDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
  }

  const { ledger, parseErrors } = buildNoeConsensusLedgerFromRawOutputs({
    roundId,
    goal,
    evidenceRef,
    requiredModels: MODELS,
    participants,
    boundaries: boundariesForActiveExecutor(activeExecutor, input.boundaries),
    implementation: {
      writer: activeExecutor,
      activeExecutor,
      stageMatrixRequired: Boolean(stageMatrixArtifact),
      stageMatrixRef: stageMatrixArtifact?.matrixRef || undefined,
      stageMatrixCompleteRequired: stageMatrixArtifact?.requireComplete === true || undefined,
      executorSelection: input.implementation?.executorSelection || input.executorSelection || (
        activeExecutor === 'codex' ? { selectedBy: 'default' } : { selectedBy: 'user', reason: 'active_executor_override' }
      ),
      authorizationRequired: true,
      runtimeVerificationRequired: true,
      rollbackRequired: true,
      memoryWritebackAckRequired: true,
    },
    artifacts: roundArtifacts,
  });
  if (parseErrors.length) ledger.notes = `parseErrors=${parseErrors.join(',')}`;
  const ledgerFile = writeNoeConsensusLedgerFile(ledger, { root, outDir });
  const validation = validateNoeConsensusLedgerArtifact(ledger, {
    root,
    requireEvidenceFile: true,
    requireRawOutputFiles: true,
  });
  const ledgerRef = relative(root, ledgerFile);
  manifest.consensusStatus = validation.ok ? 'consensus_passed' : 'consensus_blocked';
  manifest.ledgerRef = ledgerRef;
  manifest.gateValidated = validation.ok;
  manifest.gate = {
    ok: validation.ok,
    errors: validation.errors,
    warnings: validation.warnings,
    consensus: validation.consensus,
  };
  manifest.parseErrors = parseErrors;
  manifest.supportFilesWritten = true;
  writeRoundSupportFiles({
    roundDir,
    goal,
    evidenceRef,
    supportRefs,
    evidenceText,
    evidenceSha256,
    createdAt,
    qualityProfile,
    activeExecutor,
    manifest,
    ledgerRef,
    validation,
    votes: ledger.votes,
    parseErrors,
    artifacts: roundArtifacts,
    stageMatrixArtifact,
  });
  writeFileSync(join(roundDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
  return {
    ok: validation.ok,
    status: validation.ok ? 'consensus_passed' : 'consensus_blocked',
    roundId,
    evidenceRef,
    roundDir,
    ledger: ledgerRef,
    parseErrors,
    validation,
  };
}
