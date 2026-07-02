import { describe, expect, it } from 'vitest';
import { buildNoeOnlineModelRoster } from '../../src/room/NoeOnlineModelRoster.js';

function commandResolver(available = []) {
  return (command) => available.includes(command)
    ? { ok: true, command, path: `/usr/local/bin/${command}`, status: 'available' }
    : { ok: false, command, path: '', status: 'command_not_found' };
}

function providerHealth(providers = []) {
  return {
    ok: true,
    providers,
  };
}

describe('NoeOnlineModelRoster', () => {
  it('builds a core three-model online roster from CLI availability and provider health', () => {
    const roster = buildNoeOnlineModelRoster({
      commandResolver: commandResolver(['codex', 'claude', 'gemini']),
      providerHealth: providerHealth([
        { provider: 'minimax', ok: true, model: 'MiniMax-M3', endpoint: 'https://api.minimax.chat/v1/models', modelCount: 8, selectedModelListed: true },
        { provider: 'xiaomi', ok: true, model: 'mimo-v2.5-pro', endpoint: 'https://token-plan-cn.xiaomimimo.com/v1/models', modelCount: 9, selectedModelListed: true },
      ]),
      env: {},
    });

    expect(roster).toMatchObject({
      ok: true,
      status: 'ready',
      consensusModels: ['codex', 'claude', 'm3'],
      availableModels: ['codex', 'claude', 'm3'],
      availableCount: 3,
      threshold: 2,
      secretValuesReturned: false,
    });
    expect(roster.models.find((item) => item.id === 'codex')).toMatchObject({
      transport: 'cli',
      authority: 'writer_integrator',
      canWrite: true,
      model: 'gpt-5.5',
    });
    expect(roster.models.find((item) => item.id === 'm3')).toMatchObject({
      transport: 'api',
      provider: 'minimax',
      authority: 'suggestion_only',
      model: 'MiniMax-M3',
    });
    expect(roster.models.find((item) => item.id === 'gemini')).toMatchObject({
      countedInConsensus: false,
      status: 'retired_from_core_quorum',
    });
    expect(roster.models.find((item) => item.id === 'xiaomi')).toMatchObject({
      countedInConsensus: false,
      status: 'retired_from_core_quorum',
    });
  });

  it('marks unavailable models and keeps Codex fallback targets non-counting', () => {
    const roster = buildNoeOnlineModelRoster({
      commandResolver: commandResolver(['codex', 'claude']),
      providerHealth: providerHealth([
        { provider: 'minimax', ok: false, configured: true, status: 'rate_limited_or_quota', model: 'MiniMax-M3' },
        { provider: 'xiaomi', ok: true, model: 'mimo-v2.5-pro' },
      ]),
      env: {},
    });

    expect(roster).toMatchObject({
      ok: true,
      availableModels: ['codex', 'claude'],
      availableCount: 2,
      threshold: 2,
    });
    expect(roster.unavailableModels.map((item) => item.id)).toEqual(['m3']);
    expect(roster.codexFallbackPolicy).toEqual({
      enabled: true,
      countedInConsensus: false,
      targets: ['m3'],
    });
  });

  it('blocks roster quorum when fewer than two online models are available', () => {
    const roster = buildNoeOnlineModelRoster({
      commandResolver: commandResolver(['codex']),
      providerHealth: providerHealth([]),
      env: {},
    });

    expect(roster).toMatchObject({
      ok: false,
      status: 'blocked',
      availableModels: ['codex'],
      availableCount: 1,
      threshold: 0,
      blockers: ['online_model_roster_requires_at_least_two_available_models'],
    });
  });

  it('does not expose secret-like environment values', () => {
    const roster = buildNoeOnlineModelRoster({
      commandResolver: commandResolver(['codex']),
      providerHealth: providerHealth([]),
      env: {
        CODEX_BIN: 'codex',
        MINIMAX_MODEL: 'MiniMax-M3',
        MINIMAX_API_KEY: 'sk-unitsecret-roster-000000000000000000',
      },
    });

    expect(JSON.stringify(roster)).not.toContain('unitsecret');
  });
});
