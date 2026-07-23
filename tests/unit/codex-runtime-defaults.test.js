import { describe, expect, it } from 'vitest';
import {
  CODEX_GPT_55_MODEL,
  applyCodexGpt55RuntimeDefaults,
  isCodexGpt55Default,
} from '../../src/room/CodexRuntimeDefaults.js';

describe('CodexRuntimeDefaults', () => {
  it('treats gpt-5.5 and the panel Codex default as highest-reasoning targets', () => {
    expect(isCodexGpt55Default(CODEX_GPT_55_MODEL)).toBe(true);
    expect(isCodexGpt55Default('')).toBe(true);
    expect(isCodexGpt55Default(null)).toBe(true);
    expect(isCodexGpt55Default('gpt-5')).toBe(false);
    expect(isCodexGpt55Default('gpt-5-mini')).toBe(false);
  });

  it('adds xhigh reasoning config for gpt-5.5', () => {
    const args = applyCodexGpt55RuntimeDefaults(['exec', '-m', CODEX_GPT_55_MODEL], CODEX_GPT_55_MODEL);
    expect(args).toContain('-c');
    expect(args).toContain('model_reasoning_effort="xhigh"');
  });

  it('does not duplicate an explicit reasoning override', () => {
    const args = ['exec', '-c', 'model_reasoning_effort="high"'];
    applyCodexGpt55RuntimeDefaults(args, CODEX_GPT_55_MODEL);
    expect(args.filter((arg) => String(arg).startsWith('model_reasoning_effort='))).toHaveLength(1);
    expect(args).toContain('model_reasoning_effort="high"');
  });
});
