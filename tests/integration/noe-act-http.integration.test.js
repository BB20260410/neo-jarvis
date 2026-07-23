import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

describe('CE12 P0 Noe HTTP integration wrapper', () => {
  it('runs the server/API/storage/ActPipeline integration harness', () => {
    const result = spawnSync(process.execPath, ['scripts/ce12-p0-integration.mjs'], {
      cwd: process.cwd(),
      encoding: 'utf8',
      timeout: 120_000,
      maxBuffer: 16 * 1024 * 1024,
      // CE12 P0 封锁机制在 default 信任档下验证；生产默认 developer 已解枷锁，由 noe-act-pipeline-policy 单测覆盖。
      env: { ...process.env, NOE_TRUST_LEVEL: 'default' },
    });
    const output = `${result.stdout || ''}${result.stderr || ''}`;

    expect(result.status, output).toBe(0);
    expect(output).toContain('Result: 18/18 checks passed');
    expect(output).toContain('destructive act is refused by safety layer and never executes');
  });
});
