import { spawnSync } from 'node:child_process';
import { CLAUDE_OPUS_48_MODEL } from './ClaudeRuntimeDefaults.js';
import { CODEX_GPT_55_MODEL } from './CodexRuntimeDefaults.js';
import { redactSensitiveText } from '../runtime/NoeContextScrubber.js';

export const NOE_ONLINE_MODEL_ROSTER_SCHEMA_VERSION = 1;
export const NOE_ONLINE_CONSENSUS_MODELS = Object.freeze(['codex', 'claude', 'm3']);

const DEFAULT_GEMINI_PRO_MODEL = 'gemini-3.1-pro-preview';
const DEFAULT_MINIMAX_MODEL = 'MiniMax-M3';
const DEFAULT_XIAOMI_MODEL = 'mimo-v2.5-pro';

function clean(value, max = 4000) {
  return redactSensitiveText(String(value ?? '').trim()).slice(0, max);
}

function commandExists(command = '', { spawnSyncImpl = spawnSync, env = process.env } = {}) {
  const cmd = clean(command, 200);
  if (!cmd) return { ok: false, command: '', status: 'command_missing' };
  const result = spawnSyncImpl('which', [cmd], {
    encoding: 'utf8',
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const path = clean(result.stdout, 1000).split(/\r?\n/)[0] || '';
  return {
    ok: result.status === 0 && Boolean(path),
    command: cmd,
    path,
    status: result.status === 0 && path ? 'available' : 'command_not_found',
  };
}

function providerById(providerHealth = {}, providerId = '') {
  return (Array.isArray(providerHealth.providers) ? providerHealth.providers : [])
    .find((item) => item.provider === providerId) || null;
}

function cliModel({
  id,
  role,
  authority,
  command,
  model,
  canWrite = false,
  commandResolver,
  env,
} = {}) {
  const commandStatus = commandResolver
    ? commandResolver(command)
    : commandExists(command, { env });
  const available = commandStatus.ok === true;
  return {
    id,
    role,
    authority,
    canWrite,
    transport: 'cli',
    command,
    commandPath: clean(commandStatus.path || '', 1000),
    model: clean(model, 240),
    available,
    status: available ? 'available' : 'unavailable',
    reason: available ? '' : clean(commandStatus.status || 'command_not_found', 240),
    countedInConsensus: true,
    secretValuesReturned: false,
  };
}

function apiModel({
  id,
  role,
  authority,
  providerId,
  model,
  providerHealth,
} = {}) {
  const health = providerById(providerHealth, providerId);
  const available = health?.ok === true;
  return {
    id,
    role,
    authority,
    canWrite: false,
    transport: 'api',
    provider: providerId,
    model: clean(health?.model || model, 240),
    available,
    status: available ? 'available' : 'unavailable',
    reason: available ? '' : clean(health?.status || 'provider_health_missing', 240),
    endpoint: clean(health?.endpoint || '', 1000),
    modelCount: Number(health?.modelCount) || 0,
    selectedModelListed: health?.selectedModelListed,
    countedInConsensus: true,
    secretValuesReturned: false,
  };
}

function modelProfiles({ env = process.env, providerHealth = {}, commandResolver } = {}) {
  return [
    cliModel({
      id: 'codex',
      role: 'writer_integrator',
      authority: 'writer_integrator',
      command: env.CODEX_BIN || 'codex',
      model: env.NOE_CONSENSUS_CODEX_MODEL || CODEX_GPT_55_MODEL,
      canWrite: true,
      commandResolver,
      env,
    }),
    cliModel({
      id: 'claude',
      role: 'readonly_source_reviewer',
      authority: 'readonly_source_reviewer',
      command: env.CLAUDE_BIN || 'claude',
      model: env.NOE_CONSENSUS_CLAUDE_MODEL || CLAUDE_OPUS_48_MODEL,
      commandResolver,
      env,
    }),
    cliModel({
      id: 'gemini',
      role: 'advisory',
      authority: 'advisory',
      command: env.GEMINI_BIN || 'gemini',
      model: env.NOE_CONSENSUS_GEMINI_MODEL || DEFAULT_GEMINI_PRO_MODEL,
      commandResolver,
      env,
    }),
    apiModel({
      id: 'm3',
      role: 'suggestion_only',
      authority: 'suggestion_only',
      providerId: 'minimax',
      model: env.MINIMAX_MODEL || DEFAULT_MINIMAX_MODEL,
      providerHealth,
    }),
    apiModel({
      id: 'xiaomi',
      role: 'advisory',
      authority: 'advisory',
      providerId: 'xiaomi',
      model: env.XIAOMI_MODEL || DEFAULT_XIAOMI_MODEL,
      providerHealth,
    }),
  ];
}

function quorumFor(count) {
  if (count === 3) return { ok: true, threshold: 2, reason: '' };
  if (count === 2) return { ok: true, threshold: 2, reason: '' };
  return { ok: false, threshold: 0, reason: 'online_model_roster_requires_at_least_two_available_models' };
}

export function buildNoeOnlineModelRoster({
  providerHealth = {},
  env = process.env,
  commandResolver = null,
} = {}) {
  const models = modelProfiles({ providerHealth, env, commandResolver });
  const consensusModelSet = new Set(NOE_ONLINE_CONSENSUS_MODELS);
  const consensusModels = models.map((item) => ({
    ...item,
    countedInConsensus: consensusModelSet.has(item.id),
    status: consensusModelSet.has(item.id) ? item.status : 'retired_from_core_quorum',
    reason: consensusModelSet.has(item.id) ? item.reason : 'retired_from_core_quorum',
  }));
  const countedModels = consensusModels.filter((item) => item.countedInConsensus);
  const availableModels = countedModels.filter((item) => item.available).map((item) => item.id);
  const unavailableModels = countedModels.filter((item) => !item.available).map((item) => ({
    id: item.id,
    reason: item.reason,
    transport: item.transport,
    provider: item.provider || '',
    command: item.command || '',
  }));
  const quorum = quorumFor(availableModels.length);
  const codexFallbackTargets = countedModels
    .filter((item) => item.id !== 'codex' && !item.available)
    .map((item) => item.id);
  return {
    schemaVersion: NOE_ONLINE_MODEL_ROSTER_SCHEMA_VERSION,
    ok: quorum.ok,
    status: quorum.ok ? 'ready' : 'blocked',
    mode: 'online_consensus_roster',
    models: consensusModels,
    consensusModels: [...NOE_ONLINE_CONSENSUS_MODELS],
    availableModels,
    unavailableModels,
    availableCount: availableModels.length,
    threshold: quorum.threshold,
    blockers: quorum.ok ? [] : [quorum.reason],
    codexFallbackPolicy: {
      enabled: true,
      countedInConsensus: false,
      targets: codexFallbackTargets,
    },
    secretValuesReturned: false,
  };
}
