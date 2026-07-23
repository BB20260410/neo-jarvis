import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  buildNoeConsensusM3Options,
  buildNoeConsensusPrompt,
  boundariesForActiveExecutor,
  CORE_ROUND_MODELS,
  NOE_CONSENSUS_M3_MAX_COMPLETION_TOKENS,
  NOE_CONSENSUS_M3_SERVICE_TIER,
  NOE_CONSENSUS_M3_THINKING,
  NOE_CONSENSUS_MODELS,
  normalizeQualityProfile,
  participantAuthority,
  qualityInstructionLines,
} from '../../src/room/NoeConsensusPrompts.js';

describe('NoeConsensusPrompts constants', () => {
  it('exposes the frozen core consensus model list', () => {
    expect(NOE_CONSENSUS_MODELS).toEqual(['codex', 'claude', 'm3']);
    expect(Object.isFrozen(NOE_CONSENSUS_MODELS)).toBe(true);
  });

  it('exposes the human-readable core participant label', () => {
    expect(CORE_ROUND_MODELS).toBe('Codex, Claude, M3');
  });

  it('exposes a frozen adaptive thinking config for M3', () => {
    expect(NOE_CONSENSUS_M3_THINKING).toEqual({ type: 'adaptive' });
    expect(Object.isFrozen(NOE_CONSENSUS_M3_THINKING)).toBe(true);
  });

  it('exposes the M3 max completion token and service tier defaults', () => {
    expect(NOE_CONSENSUS_M3_MAX_COMPLETION_TOKENS).toBe(524288);
    expect(NOE_CONSENSUS_M3_SERVICE_TIER).toBe('priority');
  });
});

describe('participantAuthority', () => {
  it('marks the model that matches the active executor as active_executor', () => {
    expect(participantAuthority('codex', 'codex')).toBe('active_executor');
    expect(participantAuthority('claude', 'claude')).toBe('active_executor');
  });

  it('always marks m3 as suggestion_only', () => {
    expect(participantAuthority('m3', 'codex')).toBe('suggestion_only');
    expect(participantAuthority('m3', 'claude')).toBe('suggestion_only');
  });

  it('marks claude as readonly_source_reviewer when not the active executor', () => {
    expect(participantAuthority('claude', 'codex')).toBe('readonly_source_reviewer');
  });

  it('falls back to advisory for non-core or unknown models', () => {
    expect(participantAuthority('gemini', 'codex')).toBe('advisory');
    expect(participantAuthority('', 'codex')).toBe('advisory');
  });

  it('defaults the active executor to codex when not provided', () => {
    expect(participantAuthority('codex')).toBe('active_executor');
    expect(participantAuthority('m3')).toBe('suggestion_only');
    expect(participantAuthority('claude')).toBe('readonly_source_reviewer');
  });
});

describe('normalizeQualityProfile', () => {
  it('returns known profiles unchanged', () => {
    expect(normalizeQualityProfile('standard')).toBe('standard');
    expect(normalizeQualityProfile('exhaustive')).toBe('exhaustive');
  });

  it('trims whitespace and lowercases input', () => {
    expect(normalizeQualityProfile('  STANDARD  ')).toBe('standard');
    expect(normalizeQualityProfile('Exhaustive')).toBe('exhaustive');
  });

  it('falls back to exhaustive for unknown, empty, or nullish values', () => {
    expect(normalizeQualityProfile('unknown-profile')).toBe('exhaustive');
    expect(normalizeQualityProfile('')).toBe('exhaustive');
    expect(normalizeQualityProfile(null)).toBe('exhaustive');
    expect(normalizeQualityProfile(undefined)).toBe('exhaustive');
    expect(normalizeQualityProfile(42)).toBe('exhaustive');
  });
});

describe('qualityInstructionLines', () => {
  it('returns the short standard profile header', () => {
    const lines = qualityInstructionLines('standard');
    expect(lines[0]).toBe('Quality profile: standard.');
    expect(lines.length).toBe(2);
  });

  it('returns the exhaustive profile header by default', () => {
    const lines = qualityInstructionLines();
    expect(lines[0]).toBe('Quality profile: exhaustive.');
    expect(lines.length).toBeGreaterThan(5);
  });

  it('returns the exhaustive profile header for the exhaustive profile', () => {
    const lines = qualityInstructionLines('exhaustive');
    expect(lines[0]).toBe('Quality profile: exhaustive.');
    expect(lines.length).toBeGreaterThan(5);
  });

  it('normalizes unknown profiles back to exhaustive', () => {
    const lines = qualityInstructionLines('not-a-profile');
    expect(lines[0]).toBe('Quality profile: exhaustive.');
  });
});

describe('buildNoeConsensusM3Options', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    delete process.env.NOE_CONSENSUS_M3_MAX_COMPLETION_TOKENS;
    delete process.env.NOE_CONSENSUS_M3_SERVICE_TIER;
    delete process.env.MINIMAX_MODEL;
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('returns the exhaustive defaults when no overrides are set', () => {
    const opts = buildNoeConsensusM3Options();
    expect(opts.model).toBe('MiniMax-M3');
    expect(opts.noAbort).toBe(true);
    expect(opts.reasoningSplit).toBe(true);
    expect(opts.thinking).toEqual({ type: 'adaptive' });
    expect(opts.maxCompletionTokens).toBe(NOE_CONSENSUS_M3_MAX_COMPLETION_TOKENS);
    expect(opts.serviceTier).toBe(NOE_CONSENSUS_M3_SERVICE_TIER);
  });

  it('uses the smaller max token and omits service tier for the standard profile', () => {
    const opts = buildNoeConsensusM3Options({ qualityProfile: 'standard' });
    expect(opts.maxCompletionTokens).toBe(131072);
    expect(opts.serviceTier).toBeUndefined();
  });

  it('honors a positive numeric override via NOE_CONSENSUS_M3_MAX_COMPLETION_TOKENS', () => {
    process.env.NOE_CONSENSUS_M3_MAX_COMPLETION_TOKENS = '12345';
    const opts = buildNoeConsensusM3Options();
    expect(opts.maxCompletionTokens).toBe(12345);
  });

  it('ignores non-positive or non-numeric overrides and falls back to the default', () => {
    process.env.NOE_CONSENSUS_M3_MAX_COMPLETION_TOKENS = '0';
    expect(buildNoeConsensusM3Options().maxCompletionTokens).toBe(NOE_CONSENSUS_M3_MAX_COMPLETION_TOKENS);
    process.env.NOE_CONSENSUS_M3_MAX_COMPLETION_TOKENS = 'not-a-number';
    expect(buildNoeConsensusM3Options().maxCompletionTokens).toBe(NOE_CONSENSUS_M3_MAX_COMPLETION_TOKENS);
  });

  it('uses an explicit service tier from the environment when provided', () => {
    process.env.NOE_CONSENSUS_M3_SERVICE_TIER = 'flex';
    const opts = buildNoeConsensusM3Options();
    expect(opts.serviceTier).toBe('flex');
  });

  it('uses an explicit model argument when provided', () => {
    const opts = buildNoeConsensusM3Options({ model: 'custom-m3-model' });
    expect(opts.model).toBe('custom-m3-model');
  });
});

describe('boundariesForActiveExecutor', () => {
  it('returns the provided non-empty boundaries as-is', () => {
    const provided = ['custom-1', 'custom-2'];
    expect(boundariesForActiveExecutor('codex', provided)).toBe(provided);
    expect(boundariesForActiveExecutor('claude', provided)).toBe(provided);
  });

  it('returns undefined when activeExecutor is codex and no boundaries are given', () => {
    expect(boundariesForActiveExecutor('codex')).toBeUndefined();
    expect(boundariesForActiveExecutor('codex', null)).toBeUndefined();
    expect(boundariesForActiveExecutor('codex', [])).toBeUndefined();
  });

  it('returns a filtered boundary list when activeExecutor is not codex', () => {
    const result = boundariesForActiveExecutor('claude');
    expect(Array.isArray(result)).toBe(true);
    expect(result).toContain('active_executor_single_writer');
    expect(result).not.toContain('codex_only_writer');
  });
});

describe('buildNoeConsensusPrompt', () => {
  const baseOpts = {
    model: 'codex',
    goal: 'verify runtime health',
    evidenceRef: 'health-2025-01-01',
    evidenceText: 'all live checks passed',
    activeExecutor: 'codex',
    qualityProfile: 'exhaustive',
  };

  it('includes the goal, evidence, and core prompt markers', () => {
    const prompt = buildNoeConsensusPrompt(baseOpts);
    expect(prompt).toContain('Noe online multi-model self-evolution consensus gate');
    expect(prompt).toContain('Return one JSON object only');
    expect(prompt).toContain('model: codex');
    expect(prompt).toContain('authority: active_executor');
    expect(prompt).toContain('canWrite: true');
    expect(prompt).toContain('evidenceRef: health-2025-01-01');
    expect(prompt).toContain('# Goal');
    expect(prompt).toContain('verify runtime health');
    expect(prompt).toContain('# Evidence');
    expect(prompt).toContain('all live checks passed');
  });

  it('marks claude as first-class and as a non-active reviewer', () => {
    const prompt = buildNoeConsensusPrompt({ ...baseOpts, model: 'claude', activeExecutor: 'codex' });
    expect(prompt).toContain('"firstClass": true,');
    expect(prompt).toContain('authority: readonly_source_reviewer');
    expect(prompt).toContain('canWrite: false');
  });

  it('includes m3-specific scope restrictions', () => {
    const prompt = buildNoeConsensusPrompt({ ...baseOpts, model: 'm3', activeExecutor: 'codex' });
    expect(prompt).toContain('M3 finding scope is limited to actionable_risk');
    expect(prompt).toContain('authority: suggestion_only');
    expect(prompt).toContain('canWrite: false');
  });

  it('uses the non-core advisory scope lines for non-core models', () => {
    const prompt = buildNoeConsensusPrompt({ ...baseOpts, model: 'gemini', activeExecutor: 'codex' });
    expect(prompt).toContain('explicit non-core advisory profile');
    expect(prompt).not.toContain('M3 finding scope is limited to actionable_risk');
  });

  it('does not include the firstClass marker for non-claude core models', () => {
    const prompt = buildNoeConsensusPrompt({ ...baseOpts, model: 'codex' });
    expect(prompt).not.toContain('"firstClass": true,');
  });

  it('normalizes the model name to lowercase', () => {
    const prompt = buildNoeConsensusPrompt({ ...baseOpts, model: 'CLAUDE', activeExecutor: 'codex' });
    expect(prompt).toContain('model: claude');
  });

  it('uses standard profile instructions when the profile is standard', () => {
    const prompt = buildNoeConsensusPrompt({ ...baseOpts, qualityProfile: 'standard' });
    expect(prompt).toContain('Quality profile: standard.');
    expect(prompt).not.toContain('Quality profile: exhaustive.');
  });

  it('includes the required JSON shape and consensus rules', () => {
    const prompt = buildNoeConsensusPrompt(baseOpts);
    expect(prompt).toContain('"decision": "approve|approve_with_changes|reject|abstain|unavailable"');
    expect(prompt).toContain('"consensus_vote": "yes|no|abstain"');
    expect(prompt).toContain('Dynamic quorum policy');
    expect(prompt).toContain('Active executor for this round: codex');
  });
});
