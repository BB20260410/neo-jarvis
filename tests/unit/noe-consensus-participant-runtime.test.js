import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  buildNoeCodexOutFile,
  runBuiltInParticipant,
} from '../../src/room/NoeConsensusParticipantRuntime.js';

describe('buildNoeCodexOutFile', () => {
  it('returns empty string for empty input', () => {
    expect(buildNoeCodexOutFile('')).toBe('');
  });

  it('returns empty string for whitespace-only input', () => {
    expect(buildNoeCodexOutFile('   ')).toBe('');
  });

  it('returns empty string for null', () => {
    expect(buildNoeCodexOutFile(null)).toBe('');
  });

  it('returns empty string for undefined', () => {
    expect(buildNoeCodexOutFile(undefined)).toBe('');
  });

  it('appends .codex-out.txt to a plain filename', () => {
    expect(buildNoeCodexOutFile('out.txt')).toBe('out.txt.codex-out.txt');
  });

  it('appends .codex-out.txt to an absolute path', () => {
    expect(buildNoeCodexOutFile('/tmp/noe/run-123')).toBe(
      '/tmp/noe/run-123.codex-out.txt'
    );
  });

  it('trims surrounding whitespace before appending', () => {
    expect(buildNoeCodexOutFile('  out.txt\t')).toBe('out.txt.codex-out.txt');
  });

  it('always appends the suffix even if it is already present', () => {
    // Documents current (non-deduplicating) behavior so future refactors
    // surface any change in contract.
    expect(buildNoeCodexOutFile('out.codex-out.txt')).toBe(
      'out.codex-out.txt.codex-out.txt'
    );
  });
});

describe('runBuiltInParticipant', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('returns an unavailable JSON envelope for an unknown model', async () => {
    const result = await runBuiltInParticipant({
      model: 'gpt-99-unknown',
      prompt: 'noop',
      root: '/tmp',
      activeExecutor: 'codex',
    });

    const parsed = JSON.parse(result);
    expect(parsed.model).toBe('gpt-99-unknown');
    expect(parsed.decision).toBe('unavailable');
    expect(parsed.confidence).toBe(0);
    expect(parsed.consensus_vote).toBe('abstain');
    expect(parsed.canWrite).toBe(false);
    expect(Array.isArray(parsed.blockers)).toBe(true);
    expect(parsed.blockers[0]).toMatch(
      /^model_unavailable:unknown_model:gpt-99-unknown$/
    );
  });

  it('returns an unavailable JSON envelope for codex without rawOutputFile', async () => {
    vi.stubEnv('CODEX_BIN', 'codex');
    const result = await runBuiltInParticipant({
      model: 'codex',
      prompt: 'noop',
      rawOutputFile: '',
      root: '/tmp',
    });

    const parsed = JSON.parse(result);
    expect(parsed.model).toBe('codex');
    expect(parsed.decision).toBe('unavailable');
    expect(parsed.canWrite).toBe(true);
    expect(parsed.blockers[0]).toMatch(
      /^model_unavailable:raw_output_file_required$/
    );
  });

  it('returns an unavailable JSON envelope for codex with whitespace-only rawOutputFile', async () => {
    vi.stubEnv('CODEX_BIN', 'codex');
    const result = await runBuiltInParticipant({
      model: 'codex',
      prompt: 'noop',
      rawOutputFile: '   ',
      root: '/tmp',
    });

    const parsed = JSON.parse(result);
    expect(parsed.decision).toBe('unavailable');
    expect(parsed.blockers[0]).toMatch(/raw_output_file_required/);
  });

  it('returns an unavailable JSON envelope for m3 when secretResolver yields no value', async () => {
    const result = await runBuiltInParticipant({
      model: 'm3',
      prompt: 'noop',
      root: '/tmp',
      activeExecutor: 'codex',
      secretResolver: () => null,
    });

    const parsed = JSON.parse(result);
    expect(parsed.model).toBe('m3');
    expect(parsed.decision).toBe('unavailable');
    expect(parsed.canWrite).toBe(false);
    expect(Array.isArray(parsed.blockers)).toBe(true);
    expect(parsed.blockers[0]).toMatch(/^model_unavailable:/);
  });

  it('returns an unavailable JSON envelope for m3 when secretResolver returns an empty value', async () => {
    const result = await runBuiltInParticipant({
      model: 'm3',
      prompt: 'noop',
      root: '/tmp',
      activeExecutor: 'codex',
      secretResolver: () => ({ source: 'env', value: '' }),
    });

    const parsed = JSON.parse(result);
    expect(parsed.model).toBe('m3');
    expect(parsed.decision).toBe('unavailable');
  });
});
