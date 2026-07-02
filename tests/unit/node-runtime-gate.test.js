import { describe, expect, it } from 'vitest';
import { selectNodeRuntime } from '../../scripts/ensure-node22.mjs';

describe('Node runtime gate', () => {
  it('accepts current Node >=22 when exact Node22 is not required', () => {
    const result = selectNodeRuntime({
      current: { ok: true, bin: '/opt/homebrew/bin/node', version: 'v26.0.0', major: 26, modules: '147', execPath: '/opt/homebrew/bin/node' },
      candidates: [],
      minimumMajor: 22,
    });

    expect(result).toMatchObject({ ok: true, mode: 'current_minimum_ok' });
  });

  it('selects pinned Node22 for exact validation when current runtime is newer', () => {
    const result = selectNodeRuntime({
      current: { ok: true, bin: '/opt/homebrew/bin/node', version: 'v26.0.0', major: 26, modules: '147', execPath: '/opt/homebrew/bin/node' },
      candidates: [
        { ok: true, bin: '~/.nvm/versions/node/v22.22.2/bin/node', version: 'v22.22.2', major: 22, modules: '127', execPath: '~/.nvm/versions/node/v22.22.2/bin/node' },
      ],
      requiredMajor: 22,
    });

    expect(result).toMatchObject({
      ok: true,
      mode: 'candidate_exact',
      selected: { major: 22, modules: '127' },
    });
  });

  it('fails closed when exact Node22 validation has no usable Node22 candidate', () => {
    const result = selectNodeRuntime({
      current: { ok: true, bin: '/opt/homebrew/bin/node', version: 'v26.0.0', major: 26, modules: '147', execPath: '/opt/homebrew/bin/node' },
      candidates: [{ ok: false, bin: '/missing/node', error: 'ENOENT' }],
      requiredMajor: 22,
    });

    expect(result.ok).toBe(false);
    expect(result.error).toContain('requires Node 22.x');
  });
});
