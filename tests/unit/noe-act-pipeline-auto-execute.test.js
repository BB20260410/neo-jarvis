import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { close, initSqlite, listEvents } from '../../src/storage/SqliteStore.js';
import { ActStore } from '../../src/loop/ActStore.js';
import { ActPipeline } from '../../src/loop/ActPipeline.js';

let tmp;

beforeEach(() => {
  close();
  tmp = mkdtempSync(join(tmpdir(), 'noe-act-auto-'));
  initSqlite(join(tmp, 'panel.db'));
});

afterEach(() => {
  close();
  if (tmp) rmSync(tmp, { recursive: true, force: true });
  tmp = null;
});

describe('ActPipeline autoExecuteLowRisk', () => {
  it('executes registered low-risk actions when the server opts in', async () => {
    let called = 0;
    const pipeline = new ActPipeline({
      projectId: 'noe-test',
      store: new ActStore({ projectId: 'noe-test' }),
      budget: { preflight: () => ({ ok: true, warnings: [], blocked: [] }) },
      permission: { evaluatePermission: () => ({ decision: 'allow', reason: 'test allow' }) },
      audit: { recordSafe() {} },
      autoExecuteLowRisk: true,
      executors: {
        'browser.open': async ({ act }) => {
          called += 1;
          return { opened: act.payload.url };
        },
      },
      logger: null,
    });

    const result = await pipeline.propose({
      title: 'Open docs',
      action: 'browser.open',
      riskLevel: 'low',
      payload: { url: 'https://example.com/' },
    });

    expect(result.ok).toBe(true);
    expect(called).toBe(1);
    expect(result.act).toMatchObject({ status: 'completed' });
    expect(result.act.payload).toMatchObject({ dryRunOnly: false, executorResult: { opened: 'https://example.com/' } });
    expect(listEvents({ kind: 'noe_act_executed' })).toHaveLength(1);
    expect(listEvents({ kind: 'noe_act_dry_run' })).toHaveLength(0);
  });
});
