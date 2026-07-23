import { describe, expect, it } from 'vitest';
import { runMemoryRetentionVerification } from '../../scripts/noe-memory-retention-verify.mjs';

describe('noe-memory-retention-verify', () => {
  it('passes the isolated retention verification suite', async () => {
    const report = await runMemoryRetentionVerification({});
    expect(report.passed).toBe(true);
    expect(report.checks.map((c) => c.id)).toEqual(expect.arrayContaining([
      'restart_retention',
      'context_rotation_noise_recall',
      'source_linkage',
      'secret_quarantine',
      'incomplete_rejected',
      'assistant_mode_memory_policy',
      'semantic_provider_report',
      'orphan_fact_budget',
      'ui_forget_audit',
    ]));
  });
});
