import { describe, expect, it } from 'vitest';
import {
  CLAUDE_OPUS_48_MODEL,
  applyClaudeOpus48RuntimeDefaults,
  isClaudeOpus48Model,
} from '../../src/room/ClaudeRuntimeDefaults.js';

describe('ClaudeRuntimeDefaults', () => {
  it('recognizes Opus 4.8 exact model and opus alias', () => {
    expect(isClaudeOpus48Model(CLAUDE_OPUS_48_MODEL)).toBe(true);
    expect(isClaudeOpus48Model('opus')).toBe(true);
    expect(isClaudeOpus48Model('claude-opus-4-7')).toBe(false);
    expect(isClaudeOpus48Model('claude-sonnet-4-6')).toBe(false);
  });

  it('adds xhigh effort and workflow prompt only for Opus 4.8', () => {
    const opus48Args = applyClaudeOpus48RuntimeDefaults(['--print', '--model', CLAUDE_OPUS_48_MODEL], CLAUDE_OPUS_48_MODEL);
    expect(opus48Args).toContain('--effort');
    expect(opus48Args).toContain('xhigh');
    expect(opus48Args).toContain('--append-system-prompt');
    expect(opus48Args.some((arg) => String(arg).includes('Dynamic Workflows'))).toBe(true);

    const sonnetArgs = applyClaudeOpus48RuntimeDefaults(['--print', '--model', 'claude-sonnet-4-6'], 'claude-sonnet-4-6');
    expect(sonnetArgs).not.toContain('--effort');
    expect(sonnetArgs).not.toContain('--append-system-prompt');
  });

  it('does not duplicate explicit runtime options', () => {
    const args = ['--print', '--effort', 'max', '--append-system-prompt', 'custom'];
    applyClaudeOpus48RuntimeDefaults(args, CLAUDE_OPUS_48_MODEL);
    expect(args.filter((arg) => arg === '--effort')).toHaveLength(1);
    expect(args.filter((arg) => arg === '--append-system-prompt')).toHaveLength(1);
    expect(args).toContain('max');
    expect(args).toContain('custom');
  });
});
