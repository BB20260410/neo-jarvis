import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildNoeActionEvidence } from '../../src/runtime/NoeActionEvidence.js';
import { buildNoePostReviewPack } from '../../src/room/NoePostReviewPack.js';
import {
  parsePostReviewRunArgs,
  runPostReviewRunCli,
} from '../../scripts/noe-post-review-run.mjs';

function fixturePack() {
  const evidence = buildNoeActionEvidence({
    act: { id: 'act-post-review-cli', action: 'self_evolution.implementation' },
    permissionResult: { decision: 'allow', reason: 'validated consensus ledger' },
    contextSufficiency: { sufficient: true, blockers: [] },
    executorResult: { ok: true, reportRef: 'output/runtime/pass.json' },
    refs: {
      runtimeReport: 'output/runtime/pass.json',
      rollback: 'output/rollback.md',
      changedFiles: ['src/room/NoePostReviewRunner.js'],
    },
  });
  return buildNoePostReviewPack({
    goal: 'Run post-review CLI',
    consensusLedgerRef: 'output/noe-multimodel/review-ledger/ledger.json',
    actionEvidence: evidence,
    implementation: { writer: 'codex', done: true, touchedFiles: ['src/room/NoePostReviewRunner.js'] },
    runtimeVerification: { ok: true, reportRef: 'output/runtime/pass.json' },
    rollback: { planRef: 'output/rollback.md' },
    reviewRoundRef: 'output/noe-post-review/run-cli',
  });
}

function raw(model) {
  const authority = model === 'm3' ? 'suggestion_only' : model === 'claude' ? 'readonly_source_reviewer' : 'advisory';
  return JSON.stringify({
    model,
    decision: 'approve',
    confidence: 0.82,
    authority,
    canWrite: false,
    blockers: [],
    verification_required: [],
    evidence_gaps: [],
    consensus_vote: 'yes',
  });
}

describe('Noe post-review run CLI helpers', () => {
  it('parses dry-run, model, and fallback flags', () => {
    const args = parsePostReviewRunArgs([
      '--pack', 'output/noe-post-review/r/pack.json',
      '--round-id', 'r1',
      '--out-dir', 'output/custom-review',
      '--run-models',
      '--ack-cost',
      '--no-codex-fallback',
    ]);

    expect(args).toMatchObject({
      pack: 'output/noe-post-review/r/pack.json',
      roundId: 'r1',
      outDir: 'output/custom-review',
      runModels: true,
      costAcknowledged: true,
      codexFallbackOnUnavailable: false,
    });
  });

  it('runs a dry-run from a repo-local pack file without invoking model runners', async () => {
    const cwd = process.cwd();
    const relDir = 'output/noe-post-review/run-cli-dry-fixture';
    const absDir = join(cwd, relDir);
    mkdirSync(absDir, { recursive: true });
    try {
      writeFileSync(join(absDir, 'pack.json'), `${JSON.stringify(fixturePack(), null, 2)}\n`);
      const result = await runPostReviewRunCli([
        '--pack', `${relDir}/pack.json`,
        '--round-id', 'run-cli-dry',
      ], {
        runners: {
          claude: async () => { throw new Error('should_not_run'); },
        },
      });

      expect(result.ok).toBe(true);
      expect(result.status).toBe('dry_run');
      expect(result.manifestRef).toBe('output/noe-post-review/run-cli-dry/manifest.json');
      expect(result.postReviewRef).toBe(null);
    } finally {
      rmSync(absDir, { recursive: true, force: true });
      rmSync(join(cwd, 'output/noe-post-review/run-cli-dry'), { recursive: true, force: true });
    }
  });

  it('runs injected reviewers through the command helper and writes post-review evidence', async () => {
    const cwd = process.cwd();
    const root = mkdtempSync(join(tmpdir(), 'noe-post-review-run-cli-'));
    const relDir = 'output/noe-post-review/run-cli-real-fixture';
    const absDir = join(cwd, relDir);
    mkdirSync(absDir, { recursive: true });
    try {
      writeFileSync(join(absDir, 'pack.json'), `${JSON.stringify(fixturePack(), null, 2)}\n`);
      const result = await runPostReviewRunCli([
        '--pack', `${relDir}/pack.json`,
        '--round-id', 'run-cli-real',
        '--run-models',
        '--ack-cost',
      ], {
        root,
        runners: {
          claude: async () => raw('claude'),
          m3: async () => raw('m3'),
          xiaomi: async () => raw('xiaomi'),
        },
      });

      expect(result.ok).toBe(true);
      expect(result.status).toBe('post_review_passed');
      expect(result.postReviewRef).toBe('output/noe-post-review/run-cli-real/post-review.json');
      expect(result.postReview.dynamicQuorum).toMatchObject({ availableCount: 2, threshold: 2, approvedCount: 2 });
    } finally {
      rmSync(absDir, { recursive: true, force: true });
      rmSync(root, { recursive: true, force: true });
    }
  });
});
