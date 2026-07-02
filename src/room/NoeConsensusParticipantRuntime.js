import { spawnWithTimeout } from './NoeSpawnWithTimeout.js';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { MiniMaxChatAdapter } from './MiniMaxChatAdapter.js';
import { CLAUDE_OPUS_48_MODEL, applyClaudeOpus48RuntimeDefaults } from './ClaudeRuntimeDefaults.js';
import { CODEX_GPT_55_MODEL, applyCodexGpt55RuntimeDefaults } from './CodexRuntimeDefaults.js';
import { buildNoeConsensusVoteFromRaw } from './NoeConsensusRound.js';
import { redactNoeConsensusText, sha256Text } from './NoeConsensusLedger.js';
import {
  buildNoeConsensusM3Options,
  normalizeQualityProfile,
  participantAuthority,
  qualityInstructionLines,
} from './NoeConsensusPrompts.js';
import {
  describeNoeProviderSecretFailure,
  resolveNoeProviderSecret,
} from '../secrets/NoeProviderSecrets.js';
import { buildNoeSafeChildProcessEnv } from '../security/NoeHostExecEnv.js';
import { normalizeExecutionActorId } from './NoeExecutionAuthority.js';

function unavailableRaw(model, error, activeExecutor = 'codex') {
  const executor = normalizeExecutionActorId(activeExecutor) || 'codex';
  const authority = participantAuthority(model, executor);
  return JSON.stringify({
    model,
    decision: 'unavailable',
    confidence: 0,
    authority,
    canWrite: model === executor,
    firstClass: model === 'claude' ? true : undefined,
    blockers: [`model_unavailable:${redactNoeConsensusText(error?.message || error || 'unknown')}`],
    recommended_first_slice: [],
    verification_required: [],
    consensus_vote: 'abstain',
  }, null, 2);
}

function runSpawn({ command, args = [], stdin = '', cwd, env }) {
  // 复用 spawnWithTimeout：codex 没额度/认证卡死永不 close 时超时 SIGTERM+SIGKILL 快速失败（治飞轮停摆真凶——原裸
  //   spawn 无超时致 Promise 永不 resolve、selfEvolve tick 卡 running 几小时、整飞轮停摆）。timeoutMs 从 env
  //   NOE_SELFEVO_SPAWN_TIMEOUT_MS，默认 0=不超时（零回归、正常推理不误杀）；owner 设 >0（如 300000=5min）才超时杀卡死。
  return spawnWithTimeout({
    command,
    args,
    stdin,
    cwd,
    env: buildNoeSafeChildProcessEnv(process.env, {
      extraEnv: { LANG: 'zh_CN.UTF-8', LC_ALL: 'zh_CN.UTF-8', ...(env || {}) },
    }),
    timeoutMs: Number(process.env.NOE_SELFEVO_SPAWN_TIMEOUT_MS) || 0,
  });
}

export function buildNoeCodexOutFile(rawOutputFile) {
  const file = String(rawOutputFile || '').trim();
  return file ? `${file}.codex-out.txt` : '';
}

export async function runBuiltInParticipant({
  model,
  prompt,
  rawOutputFile,
  root,
  activeExecutor = 'codex',
  secretResolver = resolveNoeProviderSecret,
  qualityProfile = 'exhaustive',
}) {
  if (model === 'claude') {
    const claudeModel = process.env.NOE_CONSENSUS_CLAUDE_MODEL || CLAUDE_OPUS_48_MODEL;
    const args = ['--print', '--permission-mode', 'plan', '--tools', '', '--no-session-persistence', '--output-format', 'text', '--model', claudeModel];
    applyClaudeOpus48RuntimeDefaults(args, claudeModel);
    if (!args.includes('--effort')) args.push('--effort', 'max');
    const result = await runSpawn({
      command: process.env.CLAUDE_BIN || 'claude',
      args,
      stdin: prompt,
      cwd: root,
    });
    if (!result.ok) return unavailableRaw(model, result.error || result.stderr || `exit_${result.code}`, activeExecutor);
    return result.stdout.trim();
  }

  if (model === 'codex') {
    const outFile = buildNoeCodexOutFile(rawOutputFile);
    if (!outFile) return unavailableRaw(model, 'raw_output_file_required', activeExecutor);
    const codexModel = process.env.NOE_CONSENSUS_CODEX_MODEL || CODEX_GPT_55_MODEL;
    const args = ['exec', '--skip-git-repo-check', '-C', root, '-o', outFile, '-m', codexModel];
    applyCodexGpt55RuntimeDefaults(args, codexModel);
    args.push('-');
    const result = await runSpawn({
      command: process.env.CODEX_BIN || 'codex',
      args,
      stdin: prompt,
      cwd: root,
    });
    if (existsSync(outFile)) return readFileSync(outFile, 'utf8');
    if (!result.ok) return unavailableRaw(model, result.error || result.stderr || `exit_${result.code}`, activeExecutor);
    return result.stdout.trim();
  }

  if (model === 'm3') {
    const secret = secretResolver('minimax');
    const apiKey = secret?.value || '';
    if (!apiKey) return unavailableRaw(model, describeNoeProviderSecretFailure('minimax', secret), activeExecutor);
    const m3Options = buildNoeConsensusM3Options({
      model: process.env.MINIMAX_MODEL || 'MiniMax-M3',
      qualityProfile,
    });
    const adapter = new MiniMaxChatAdapter({
      apiKey,
      baseUrl: process.env.MINIMAX_BASE_URL,
      model: m3Options.model,
      reasoningSplit: m3Options.reasoningSplit,
      thinking: m3Options.thinking,
      maxCompletionTokens: m3Options.maxCompletionTokens,
      serviceTier: m3Options.serviceTier,
    });
    const response = await adapter._doChat([{ role: 'user', content: prompt }], m3Options);
    return response?.reply || String(response || '');
  }

  return unavailableRaw(model, `unknown_model:${model}`, activeExecutor);
}

function buildCodexFallbackPrompt({
  fallbackFor,
  goal,
  evidenceRef,
  evidenceText,
  unavailableRawOutputRef,
  unavailableRawOutput,
  activeExecutor = 'codex',
  qualityProfile = 'exhaustive',
}) {
  const executor = normalizeExecutionActorId(activeExecutor) || 'codex';
  const canWrite = executor === 'codex';
  const authority = canWrite ? 'writer_integrator_supplemental' : 'advisory_supplemental';
  const normalizedQualityProfile = normalizeQualityProfile(qualityProfile);
  return [
    'You are Codex providing an automatic supplemental fallback review for a Noe consensus participant that is unavailable or out of quota.',
    'Return only JSON. Do not edit files. Do not run commands. Do not expose secret values.',
    'This is supplemental Codex evidence only. It must not be counted as the unavailable model vote.',
    `Active executor for this round: ${executor}.`,
    `Fallback authority: ${authority}.`,
    '',
    'Quality Profile:',
    ...qualityInstructionLines(normalizedQualityProfile),
    '',
    'Required JSON shape:',
    '{',
    '  "model": "codex",',
    `  "fallback_for": "${fallbackFor}",`,
    '  "counted_in_consensus": false,',
    '  "decision": "approve|approve_with_changes|reject|abstain",',
    '  "confidence": 0.0,',
    `  "authority": "${authority}",`,
    `  "canWrite": ${canWrite},`,
    '  "blockers": [],',
    '  "recommended_first_slice": [],',
    '  "verification_required": [],',
    '  "consensus_vote": "yes|no|abstain"',
    '}',
    '',
    '# Original unavailable model',
    fallbackFor,
    '',
    '# Goal',
    goal,
    '',
    '# Evidence ref',
    evidenceRef,
    '',
    '# Evidence',
    evidenceText,
    '',
    '# Unavailable raw output ref',
    unavailableRawOutputRef,
    '',
    '# Unavailable raw output excerpt',
    redactNoeConsensusText(String(unavailableRawOutput || '')).slice(0, 4000),
  ].join('\n');
}

function buildJsonRepairPrompt({ model, originalPrompt, invalidRawOutputRef, invalidRawOutput }) {
  return [
    'Your previous Noe consensus response did not contain a parseable JSON vote.',
    'Return exactly one JSON object now. No Markdown, prose, tool calls, file reads, commands, or follow-up questions.',
    'Use only the evidence already included in the original prompt below.',
    'If the evidence is insufficient, return decision "abstain" or "unavailable" with consensus_vote "abstain".',
    '',
    '# Required correction target',
    `model: ${model}`,
    `invalidRawOutputRef: ${invalidRawOutputRef}`,
    '',
    '# Invalid previous output excerpt',
    redactNoeConsensusText(String(invalidRawOutput || '')).slice(0, 4000),
    '',
    '# Original prompt to answer',
    originalPrompt,
  ].join('\n');
}

export async function maybeRepairUnparsedParticipantJson({
  participant,
  raw,
  root,
  runners,
  secretResolver,
  activeExecutor = 'codex',
  qualityProfile = 'exhaustive',
  enabled = true,
}) {
  if (!enabled) return { raw, artifact: null };
  const vote = buildNoeConsensusVoteFromRaw({
    model: participant.model,
    rawOutput: raw,
    rawOutputRef: participant.rawOutputRef,
    evidenceRef: participant.evidenceRef,
  });
  if (vote.parseStatus === 'parsed') return { raw, artifact: null };

  const dirRel = participant.rawOutputRef.replace(/[^/]+$/, '');
  const dirFull = participant.rawOutputFile.replace(/[^/]+$/, '');
  const initialRawOutputRef = join(dirRel, `${participant.model}.unparsed-attempt-1.txt`);
  const initialRawOutputFile = join(dirFull, `${participant.model}.unparsed-attempt-1.txt`);
  const repairRawOutputRef = join(dirRel, `${participant.model}.json-repair-attempt-1.txt`);
  const repairRawOutputFile = join(dirFull, `${participant.model}.json-repair-attempt-1.txt`);
  const storedInitialRaw = `${raw}\n`;
  writeFileSync(initialRawOutputFile, storedInitialRaw, { mode: 0o600 });

  const repairPrompt = buildJsonRepairPrompt({
    model: participant.model,
    originalPrompt: participant.prompt,
    invalidRawOutputRef: participant.rawOutputRef,
    invalidRawOutput: raw,
  });
  const repairParticipant = {
    ...participant,
    rawOutputRef: repairRawOutputRef,
    rawOutputFile: repairRawOutputFile,
    prompt: repairPrompt,
  };
  let repairRaw;
  try {
    const runner = runners?.[participant.model];
    repairRaw = runner
      ? await runner({ ...repairParticipant, root, qualityProfile, jsonRepair: true, invalidRawOutputRef: participant.rawOutputRef })
      : await runBuiltInParticipant({ ...repairParticipant, root, activeExecutor, qualityProfile, secretResolver });
  } catch (error) {
    repairRaw = unavailableRaw(participant.model, error, activeExecutor);
  }

  const redactedRepairRaw = redactNoeConsensusText(repairRaw);
  const storedRepairRaw = `${redactedRepairRaw}\n`;
  writeFileSync(repairRawOutputFile, storedRepairRaw, { mode: 0o600 });
  const repairVote = buildNoeConsensusVoteFromRaw({
    model: participant.model,
    rawOutput: redactedRepairRaw,
    rawOutputRef: repairRawOutputRef,
    evidenceRef: participant.evidenceRef,
  });
  const repaired = repairVote.parseStatus === 'parsed' && repairVote.identityViolations.length === 0;
  return {
    raw: repaired ? redactedRepairRaw : raw,
    artifact: {
      type: 'participant_json_repair',
      model: participant.model,
      countedInConsensus: repaired,
      reason: 'unparsed_initial_output',
      initialRawOutputRef,
      initialRawOutputSha256: sha256Text(storedInitialRaw),
      repairRawOutputRef,
      repairRawOutputSha256: sha256Text(storedRepairRaw),
      repaired,
      parseStrategy: repairVote.parseStrategy,
    },
  };
}

export async function maybeRunCodexFallbackForUnavailable({
  participant,
  raw,
  goal,
  evidenceText,
  evidenceRef,
  root,
  runners,
  secretResolver,
  activeExecutor = 'codex',
  qualityProfile = 'exhaustive',
  enabled = true,
}) {
  if (!enabled || participant.model === 'codex') return null;
  const vote = buildNoeConsensusVoteFromRaw({
    model: participant.model,
    rawOutput: raw,
    rawOutputRef: participant.rawOutputRef,
    evidenceRef,
  });
  if (vote.decision !== 'unavailable') return null;

  const dirRel = participant.rawOutputRef.replace(/[^/]+$/, '');
  const dirFull = participant.rawOutputFile.replace(/[^/]+$/, '');
  const fallbackRawOutputRef = join(dirRel, `codex-fallback-for-${participant.model}.txt`);
  const fallbackRawOutputFile = join(dirFull, `codex-fallback-for-${participant.model}.txt`);
  const prompt = buildCodexFallbackPrompt({
    fallbackFor: participant.model,
    goal,
    evidenceText,
    evidenceRef,
    unavailableRawOutputRef: participant.rawOutputRef,
    unavailableRawOutput: raw,
    activeExecutor,
    qualityProfile,
  });
  const fallbackParticipant = {
    model: 'codex',
    rawOutputRef: fallbackRawOutputRef,
    rawOutputFile: fallbackRawOutputFile,
    prompt,
  };
  const runner = runners?.codex;
  const fallbackRaw = runner
    ? await runner({ ...fallbackParticipant, goal, evidenceText, evidenceRef, root, qualityProfile, fallbackFor: participant.model, countedInConsensus: false })
    : await runBuiltInParticipant({ ...fallbackParticipant, root, activeExecutor, qualityProfile, secretResolver });
  const redacted = redactNoeConsensusText(fallbackRaw);
  const storedRaw = `${redacted}\n`;
  writeFileSync(fallbackRawOutputFile, storedRaw, { mode: 0o600 });
  return {
    type: 'codex_fallback_review',
    model: 'codex',
    fallbackFor: participant.model,
    countedInConsensus: false,
    rawOutputRef: fallbackRawOutputRef,
    rawOutputSha256: sha256Text(storedRaw),
    reason: 'participant_unavailable_or_no_quota',
  };
}

export { unavailableRaw };
