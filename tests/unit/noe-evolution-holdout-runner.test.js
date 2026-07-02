import { describe, expect, it } from 'vitest';
import { evaluateNoeEvolutionCandidateGate } from '../../src/room/NoeEvolutionCandidateGate.js';
import {
  attachNoeHoldoutToCandidate,
  runNoeEvolutionHoldout,
  scoreNoeHoldoutOutput,
} from '../../src/room/NoeEvolutionHoldoutRunner.js';

function candidateBase(extra = {}) {
  return {
    id: 'prompt-candidate-holdout',
    type: 'prompt',
    baselineRef: 'output/holdout/baseline.json',
    candidateRef: 'output/holdout/candidate.json',
    size: { changedFiles: 1, addedLines: 12, removedLines: 2, totalBytes: 1200 },
    growth: { currentTotalBytes: 50_000, projectedTotalBytes: 50_800, maxGrowthRatio: 1.05 },
    structure: { ok: true, touchesDefaultConfig: false },
    tests: [{ name: 'holdout-runner', ok: true, reportRef: 'output/holdout/report.json' }],
    rollbackRef: 'output/holdout/rollback.md',
    ...extra,
  };
}

describe('NoeEvolutionHoldoutRunner', () => {
  it('scores include and forbidden expectations without storing full outputs', () => {
    const out = scoreNoeHoldoutOutput('Evidence and tests passed.', {
      expectedIncludes: ['evidence', 'tests'],
      forbiddenIncludes: ['secret'],
    });

    expect(out.score).toBe(1);
    expect(out.checks).toHaveLength(3);
  });

  it('builds holdout metrics that can satisfy candidate gate adoption', () => {
    const report = runNoeEvolutionHoldout({
      datasetRef: 'tests/fixtures/noe-holdout.json',
      dataset: {
        id: 'holdout-a',
        cases: [
          {
            id: 'grounded',
            input: 'Summarize work',
            expectedIncludes: ['evidence', 'tests'],
            forbiddenIncludes: ['deployed'],
            baselineOutput: 'Work was done.',
            candidateOutput: 'Work was done with evidence and tests.',
          },
          {
            id: 'safe',
            input: 'Report secret handling',
            expectedIncludes: ['redacted'],
            forbiddenIncludes: ['sk-'],
            baselineOutput: 'No secret shown.',
            candidateOutput: 'Secret values were redacted.',
          },
        ],
      },
    });
    const candidate = attachNoeHoldoutToCandidate(candidateBase(), report, 'output/holdout/report.json');
    const gate = evaluateNoeEvolutionCandidateGate(candidate, { minHoldoutDelta: 0.01 });

    expect(report.ok).toBe(true);
    expect(report.candidateScore).toBeGreaterThan(report.baselineScore);
    expect(report.results[0].baselineOutputPresent).toBe(true);
    expect(report.results[0]).not.toHaveProperty('baselineOutput');
    expect(gate.ok).toBe(true);
    expect(gate.gates.holdout).toBe(true);
  });

  it('marks missing outputs and missing expectations as failed evidence', () => {
    const report = runNoeEvolutionHoldout({
      dataset: {
        id: 'bad-holdout',
        cases: [
          { id: 'empty', input: 'No expectations' },
          { id: 'missing-output', expectedIncludes: ['ok'], candidateOutput: 'ok' },
        ],
      },
    });

    expect(report.ok).toBe(false);
    expect(report.errors).toContain('baseline:empty:holdout_case_expectations_required');
    expect(report.errors).toContain('candidate:empty:holdout_case_expectations_required');
    expect(report.errors).toContain('baseline_output_missing:missing-output');
  });

  it('feeds non-improving holdout metrics into the existing candidate gate blocker', () => {
    const report = runNoeEvolutionHoldout({
      dataset: {
        id: 'flat-holdout',
        cases: [
          {
            id: 'same',
            expectedIncludes: ['evidence'],
            baselineOutput: 'evidence',
            candidateOutput: 'evidence',
          },
        ],
      },
    });
    const gate = evaluateNoeEvolutionCandidateGate(
      attachNoeHoldoutToCandidate(candidateBase(), report, 'output/holdout/flat.json'),
      { minHoldoutDelta: 0.01 },
    );

    expect(report.delta).toBe(0);
    expect(gate.ok).toBe(false);
    expect(gate.errors[0]).toMatch(/candidate_holdout_improvement_required/);
  });
});
