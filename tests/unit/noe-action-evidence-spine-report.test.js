import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { summarizeActionStepCoverage, writeActionEvidenceSpineReport } from '../../scripts/noe-action-evidence-spine.mjs';

describe('noe-action-evidence-spine report writer', () => {
  it('writes timestamped and latest reports with identical evidence summary', () => {
    const outDir = mkdtempSync(join(tmpdir(), 'noe-action-spine-'));
    try {
      const summary = {
        ok: true,
        passed: true,
        durableWorkflowReady: true,
        generatedAt: '2026-06-12T05:30:00.000Z',
        goal: {
          id: 'goal-1',
          title: '自主学习：fixture',
          source: 'self_learning',
          status: 'done',
          stepCount: 2,
          actionStepCount: 1,
        },
        coverage: {
          checkpointCount: 2,
          actionEvidenceCheckpoints: 1,
          actionStepsWithValidEvidence: 1,
          blockers: [],
          durableWorkflowGaps: [],
        },
        spine: [],
        source: {
          dbPath: '/tmp/panel.db',
          policy: 'read-only; no .env; no owner token; no model calls',
        },
      };
      const paths = writeActionEvidenceSpineReport(summary, {
        outDir,
        now: Date.parse('2026-06-12T05:30:00Z'),
      });

      expect(paths.reportPath).toMatch(/action-evidence-spine-1781242200000\.json$/);
      expect(paths.latestPath).toMatch(/latest\.json$/);
      const timestamped = JSON.parse(readFileSync(join(outDir, 'action-evidence-spine-1781242200000.json'), 'utf8'));
      const latest = JSON.parse(readFileSync(join(outDir, 'latest.json'), 'utf8'));
      expect(latest).toEqual(timestamped);
      expect(latest.goal.source).toBe('self_learning');
      expect(JSON.stringify(latest)).not.toMatch(/sk-|token=|cookie=/i);
    } finally {
      rmSync(outDir, { recursive: true, force: true });
    }
  });

  it('treats recovered action steps as satisfied only when recovery checkpoint exists', () => {
    const plan = [
      { kind: 'act', status: 'done', action: 'browser.state_probe' },
      { kind: 'act', status: 'recovered', action: 'browser.observe_page' },
    ];
    const checkpoints = [
      { step_index: 1, phase: 'step_recovered', status: 'recovered' },
    ];
    const spine = [
      { stepIndex: 0, blockers: [] },
      { stepIndex: 1, blockers: ['action_evidence_missing'] },
    ];

    const coverage = summarizeActionStepCoverage({ plan, checkpoints, spine });

    expect(coverage.actionStepCount).toBe(2);
    expect(coverage.actionStepsWithValidEvidence).toBe(1);
    expect(coverage.actionStepsRecovered).toBe(1);
    expect(coverage.actionStepsSatisfied).toBe(2);
    expect(coverage.blockers).toEqual([]);

    const withoutRecovery = summarizeActionStepCoverage({ plan, checkpoints: [], spine });
    expect(withoutRecovery.blockers).toEqual(['recovery_checkpoint_missing:1']);
  });
});
