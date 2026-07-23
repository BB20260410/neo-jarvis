import { describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { scoreNeoEvalRun, writeNeoEvalRunScore } from '../../src/eval/NeoEvalScorer.js';

function writeJson(root, ref, value) {
  const file = join(root, ref);
  mkdirSync(join(file, '..'), { recursive: true });
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function baseCase(extra = {}) {
  return {
    schemaVersion: 1,
    id: 'case-memory-001',
    layer: 'dev',
    source: {
      kind: 'memory_retrieval_log',
      episodeRef: 'output/memory.json',
      evidenceRefs: ['output/memory.json'],
      redaction: {
        secretValuesReturned: false,
        memoryBodyIncluded: false,
        ownerTokenIncluded: false,
      },
    },
    input: {
      routeType: 'chat',
      task: 'sanitized memory retrieval scoring',
      contextRefs: [],
      allowedTools: [],
      forbiddenTools: [],
    },
    expectations: {
      mustSelectMemoryIds: ['m1'],
      mustNotSelectMemoryIds: ['m2'],
      expectedIncludes: ['selectedRows'],
      forbiddenIncludes: ['secret'],
      requiredEvidenceKinds: ['retrieval_log'],
      safetyInvariants: ['no_secret_output', 'no_memory_v2_write'],
    },
    scoring: {
      capabilityWeight: 0.4,
      regressionWeight: 0.25,
      safetyWeight: 0.25,
      costLatencyWeight: 0.1,
    },
    ...extra,
  };
}

function baseRun(caseRefs) {
  return {
    schemaVersion: 1,
    id: 'run-dev-001',
    caseSet: { layer: 'dev', caseRefs, caseCount: caseRefs.length },
    candidate: { kind: 'baseline', candidateRef: 'git:test', diffRef: '', parentRef: '' },
    environment: {
      repo: '/tmp/noe',
      branch: 'test',
      head: 'test',
      node: process.version,
      runtimeBaseUrl: 'http://127.0.0.1:51835',
      runtimeTouched: false,
    },
    policy: {
      readOnly: true,
      privateHoldoutAccessibleToCandidate: false,
      secretValuesReturned: false,
      memoryV2Writes: false,
      liveRestart: false,
    },
    outputs: {
      rawRef: 'output/noe-eval-runs/run-dev-001/raw.json',
      scoreRef: 'output/noe-eval-runs/run-dev-001/score.json',
      traceRefs: [],
    },
  };
}

describe('NeoEvalScorer', () => {
  it('passes a sanitized memory retrieval case with required selected ids', () => {
    const root = mkdtempSync(join(tmpdir(), 'noe-eval-scorer-'));
    try {
      writeJson(root, 'evals/neo/dev/case-memory-001.json', baseCase());
      writeJson(root, 'evals/neo/dev/run-dev-001.json', baseRun(['evals/neo/dev/case-memory-001.json']));
      writeJson(root, 'output/memory.json', {
        ok: true,
        selectedRows: 1,
        rows: [{ id: 'q1', ok: true, selectedCount: 1, selectedIds: ['m1'] }],
      });

      const result = scoreNeoEvalRun({ root, runFile: 'evals/neo/dev/run-dev-001.json' });

      expect(result.ok).toBe(true);
      expect(result.score.summary).toMatchObject({ caseCount: 1, passed: 1, failed: 0, blocked: 0 });
      expect(result.score.caseResults[0].failedChecks).toEqual([]);
      expect(result.raw.policy).toMatchObject({ runtimeTouched: false, memoryV2Writes: false, liveRestart: false });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('scores a failed real replay as failed rather than blocked', () => {
    const root = mkdtempSync(join(tmpdir(), 'noe-eval-scorer-'));
    try {
      writeJson(root, 'evals/neo/dev/case-replay-001.json', baseCase({
        id: 'case-replay-001',
        source: {
          ...baseCase().source,
          kind: 'real_replay',
          episodeRef: 'output/replay.json',
          evidenceRefs: ['output/replay.json'],
        },
        expectations: {
          ...baseCase().expectations,
          mustSelectMemoryIds: [],
          mustNotSelectMemoryIds: [],
          expectedIncludes: ['ok'],
          requiredEvidenceKinds: ['real_use_replay'],
        },
      }));
      writeJson(root, 'evals/neo/dev/run-dev-001.json', baseRun(['evals/neo/dev/case-replay-001.json']));
      writeJson(root, 'output/replay.json', {
        ok: false,
        passed: 8,
        failed: 2,
        checks: [{ id: 'a', ok: true }, { id: 'b', ok: false }],
      });

      const result = scoreNeoEvalRun({ root, runFile: 'evals/neo/dev/run-dev-001.json' });

      expect(result.ok).toBe(false);
      expect(result.score.summary).toMatchObject({ caseCount: 1, passed: 0, failed: 1, blocked: 0 });
      expect(result.score.caseResults[0].failedChecks).toContain('real_replay_not_ok');
      expect(result.score.caseResults[0].failedChecks).toContain('real_replay_failed_checks:2');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('matches readOnly expectations against read-only evidence text', () => {
    const root = mkdtempSync(join(tmpdir(), 'noe-eval-scorer-'));
    try {
      writeJson(root, 'evals/neo/dev/case-guard-001.json', baseCase({
        id: 'case-guard-001',
        source: {
          ...baseCase().source,
          kind: 'synthetic_guard',
          episodeRef: undefined,
          evidenceRefs: ['docs/evidence.md'],
        },
        expectations: {
          ...baseCase().expectations,
          mustSelectMemoryIds: [],
          mustNotSelectMemoryIds: [],
          expectedIncludes: ['readOnly', 'SSRF', 'rollback'],
          requiredEvidenceKinds: ['design_doc'],
        },
      }));
      writeJson(root, 'evals/neo/dev/run-dev-001.json', baseRun(['evals/neo/dev/case-guard-001.json']));
      mkdirSync(join(root, 'docs'), { recursive: true });
      writeFileSync(join(root, 'docs/evidence.md'), 'This path is read-only, keeps SSRF guards, and requires rollback metadata.\\n');

      const result = scoreNeoEvalRun({ root, runFile: 'evals/neo/dev/run-dev-001.json' });

      expect(result.ok).toBe(true);
      expect(result.score.summary.passed).toBe(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('refuses private_holdout case refs without reading them', () => {
    const root = mkdtempSync(join(tmpdir(), 'noe-eval-scorer-'));
    try {
      writeJson(root, 'evals/neo/dev/run-dev-001.json', baseRun(['evals/neo/private_holdout/hidden.json']));
      mkdirSync(join(root, 'evals/neo/private_holdout'), { recursive: true });
      writeFileSync(join(root, 'evals/neo/private_holdout/hidden.json'), '{not valid json');

      const result = scoreNeoEvalRun({ root, runFile: 'evals/neo/dev/run-dev-001.json' });

      expect(result.ok).toBe(false);
      expect(result.score.summary.blocked).toBe(1);
      expect(result.score.caseResults[0].failedChecks.join('\n')).toContain('run_validation:run_caseRefs_must_not_expose_private_holdout_paths');
      expect(result.score.caseResults[0].failedChecks.join('\n')).not.toContain('json');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('blocks sensitive evidence refs before reading them', () => {
    const root = mkdtempSync(join(tmpdir(), 'noe-eval-scorer-'));
    try {
      writeJson(root, 'evals/neo/dev/case-sensitive-ref-001.json', baseCase({
        id: 'case-sensitive-ref-001',
        source: {
          ...baseCase().source,
          kind: 'synthetic_guard',
          episodeRef: undefined,
          evidenceRefs: ['.env.local'],
        },
        expectations: {
          ...baseCase().expectations,
          mustSelectMemoryIds: [],
          mustNotSelectMemoryIds: [],
          expectedIncludes: ['anything'],
          requiredEvidenceKinds: ['design_doc'],
        },
      }));
      writeJson(root, 'evals/neo/dev/run-dev-001.json', baseRun(['evals/neo/dev/case-sensitive-ref-001.json']));
      writeFileSync(join(root, '.env.local'), 'SECRET=do-not-read');

      const result = scoreNeoEvalRun({ root, runFile: 'evals/neo/dev/run-dev-001.json' });

      expect(result.ok).toBe(false);
      expect(result.score.summary).toMatchObject({ caseCount: 1, passed: 0, failed: 0, blocked: 1 });
      expect(result.score.caseResults[0].failedChecks.join('\n')).toContain('artifact_ref_forbidden:evidence_ref_sensitive_ref_forbidden');
      expect(JSON.stringify(result)).not.toContain('do-not-read');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('blocks normalized private_holdout traversal before reading it', () => {
    const root = mkdtempSync(join(tmpdir(), 'noe-eval-scorer-'));
    try {
      const traversalRef = 'evals/neo/dev/../../neo/private_holdout/hidden.json';
      writeJson(root, 'evals/neo/dev/run-dev-001.json', baseRun([traversalRef]));
      mkdirSync(join(root, 'evals/neo/private_holdout'), { recursive: true });
      writeFileSync(join(root, 'evals/neo/private_holdout/hidden.json'), '{not valid json');

      const result = scoreNeoEvalRun({ root, runFile: 'evals/neo/dev/run-dev-001.json' });

      expect(result.ok).toBe(false);
      expect(result.score.summary.blocked).toBe(1);
      expect(result.score.caseResults[0].failedChecks.join('\n')).toContain('run_validation:private_holdout_path_leak');
      expect(JSON.stringify(result)).not.toContain('not valid json');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('redacts secret-shaped refs before reporting failed checks', () => {
    const root = mkdtempSync(join(tmpdir(), 'noe-eval-scorer-'));
    try {
      const secretRef = 'evals/neo/dev/case-sk-123456789012345678901234567890.json';
      writeJson(root, 'evals/neo/dev/run-dev-001.json', baseRun([secretRef]));

      const result = scoreNeoEvalRun({ root, runFile: 'evals/neo/dev/run-dev-001.json' });
      const text = JSON.stringify(result);

      expect(result.ok).toBe(false);
      expect(result.score.summary.blocked).toBe(1);
      expect(text).toContain('[redacted-api-key]');
      expect(text).not.toContain('sk-123456789012345678901234567890');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('fails text evidence when a forbidden include is present', () => {
    const root = mkdtempSync(join(tmpdir(), 'noe-eval-scorer-'));
    try {
      writeJson(root, 'evals/neo/dev/case-guard-001.json', baseCase({
        id: 'case-guard-001',
        source: {
          ...baseCase().source,
          kind: 'synthetic_guard',
          episodeRef: undefined,
          evidenceRefs: ['docs/evidence.md'],
        },
        expectations: {
          ...baseCase().expectations,
          mustSelectMemoryIds: [],
          mustNotSelectMemoryIds: [],
          expectedIncludes: ['readOnly'],
          forbiddenIncludes: ['runtime authorized'],
          requiredEvidenceKinds: ['design_doc'],
        },
      }));
      writeJson(root, 'evals/neo/dev/run-dev-001.json', baseRun(['evals/neo/dev/case-guard-001.json']));
      mkdirSync(join(root, 'docs'), { recursive: true });
      writeFileSync(join(root, 'docs/evidence.md'), 'This path is read-only, but incorrectly says runtime authorized.\\n');

      const result = scoreNeoEvalRun({ root, runFile: 'evals/neo/dev/run-dev-001.json' });

      expect(result.ok).toBe(false);
      expect(result.score.summary.failed).toBe(1);
      expect(result.score.caseResults[0].failedChecks).toContain('forbidden_include_present:runtime authorized');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('only writes scorer outputs under output/noe-eval-runs', () => {
    const root = mkdtempSync(join(tmpdir(), 'noe-eval-scorer-'));
    try {
      writeJson(root, 'evals/neo/dev/case-memory-001.json', baseCase());
      writeJson(root, 'evals/neo/dev/run-dev-001.json', baseRun(['evals/neo/dev/case-memory-001.json']));
      writeJson(root, 'output/memory.json', {
        ok: true,
        selectedRows: 1,
        rows: [{ id: 'q1', ok: true, selectedCount: 1, selectedIds: ['m1'] }],
      });

      expect(() => writeNeoEvalRunScore({
        root,
        runFile: 'evals/neo/dev/run-dev-001.json',
        outDir: 'evals/neo/private_holdout/out',
      })).toThrow(/out_dir_must_stay_under_output\/noe-eval-runs/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
