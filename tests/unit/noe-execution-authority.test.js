import { describe, expect, it } from 'vitest';
import {
  executorProfileFor,
  resolveNoeActiveExecutor,
  validateNoeImplementationExecutor,
} from '../../src/room/NoeExecutionAuthority.js';

describe('Noe execution authority', () => {
  it('keeps Codex as the default active executor', () => {
    const result = validateNoeImplementationExecutor({
      writer: 'codex',
      authorizationRequired: true,
    });

    expect(result.ok).toBe(true);
    expect(result.activeExecutor).toBe('codex');
    expect(result.selectionSource).toBe('default');
    expect(result.profile.canWriteFiles).toBe(true);
  });

  it('allows Claude as active executor only when explicitly selected', () => {
    const blocked = validateNoeImplementationExecutor({
      writer: 'claude',
      activeExecutor: 'claude',
    });
    const selected = validateNoeImplementationExecutor({
      writer: 'claude',
      activeExecutor: 'claude',
      executorSelection: { selectedBy: 'user', reason: 'codex_quota_unavailable' },
    });

    expect(blocked.ok).toBe(false);
    expect(blocked.errors).toContain('active_executor_requires_explicit_selection:claude');
    expect(selected.ok).toBe(true);
    expect(selected.activeExecutor).toBe('claude');
    expect(selected.selectionSource).toBe('user');
  });

  it('blocks advisory and suggestion-only models from becoming executors', () => {
    for (const requestedExecutor of ['gemini', 'm3']) {
      const result = resolveNoeActiveExecutor({
        requestedExecutor,
        selection: { selectedBy: 'user' },
      });

      expect(result.ok, requestedExecutor).toBe(false);
      expect(result.errors, requestedExecutor).toContain(`active_executor_not_writable:${requestedExecutor}`);
    }
    expect(executorProfileFor('m3').authority).toBe('suggestion_only');
  });

  it('requires the implementation writer to match the selected executor', () => {
    const result = validateNoeImplementationExecutor({
      writer: 'codex',
      activeExecutor: 'claude',
      executorSelection: { userSelected: true },
    });

    expect(result.ok).toBe(false);
    expect(result.errors).toContain('implementation_writer_must_match_active_executor:codex!=claude');
  });

  it('fails closed when the selected executor is unavailable', () => {
    const result = validateNoeImplementationExecutor({
      writer: 'claude',
      activeExecutor: 'claude',
      executorSelection: { selectedBy: 'user' },
      executorAvailability: { claude: { available: false } },
    });

    expect(result.ok).toBe(false);
    expect(result.errors).toContain('active_executor_unavailable:claude');
  });
});
