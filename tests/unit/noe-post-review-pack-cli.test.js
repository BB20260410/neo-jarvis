import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  buildPostReviewPackFromArgs,
  parsePostReviewPackArgs,
} from '../../scripts/noe-post-review-pack.mjs';

describe('Noe post-review pack CLI helpers', () => {
  it('parses review_work args with reviewer output refs', () => {
    const args = parsePostReviewPackArgs([
      '--goal', 'Review P0',
      '--ledger', 'output/noe-multimodel/r/ledger.json',
      '--action-evidence', 'output/actions/evidence.json',
      '--touched', 'src/x.js',
      '--runtime-report', 'output/runtime.json',
      '--rollback', 'output/rollback.md',
      '--test', 'npm run test:p0:unit',
      '--reviewer-output', 'claude=output/review/claude.txt',
      '--reviewer=claude,m3',
      '--optional-reviewer=xiaomi',
      '--round-id', 'review-r',
    ]);

    expect(args).toMatchObject({
      goal: 'Review P0',
      ledger: 'output/noe-multimodel/r/ledger.json',
      actionEvidence: 'output/actions/evidence.json',
      runtimeReport: 'output/runtime.json',
      rollback: 'output/rollback.md',
      roundId: 'review-r',
    });
    expect(args.touchedFiles).toEqual(['src/x.js']);
    expect(args.tests).toEqual(['npm run test:p0:unit']);
    expect(args.reviewers).toEqual(['claude', 'm3']);
    expect(args.optionalReviewers).toEqual(['xiaomi']);
    expect(args.reviewerOutputRefs.claude).toBe('output/review/claude.txt');
  });

  it('builds a pack from file-backed action evidence without leaking secrets', () => {
    const root = mkdtempSync(join(tmpdir(), 'noe-post-review-pack-cli-'));
    const cwd = process.cwd();
    try {
      // This helper resolves refs from the real repo root by design, so use a repo-local fixture ref
      // under output and clean it up after the test.
      const relDir = 'output/noe-post-review/unit-cli-fixture';
      const absDir = join(cwd, relDir);
      mkdirSync(absDir, { recursive: true });
      const actionEvidenceRef = `${relDir}/action-evidence.json`;
      writeFileSync(join(cwd, actionEvidenceRef), JSON.stringify({
        schemaVersion: 1,
        actionId: 'act-1',
        action: 'self_evolution.implementation',
        permission: { decision: 'allow', reason: 'ok' },
        refs: {
          runtimeReport: ['output/runtime.json'],
          rollback: ['output/rollback.md'],
        },
      }, null, 2));

      const pack = buildPostReviewPackFromArgs(parsePostReviewPackArgs([
        '--goal', 'Review P0 secret tp-unitsecret000000000000000000000000000000',
        '--ledger', 'output/noe-multimodel/r/ledger.json',
        '--action-evidence', actionEvidenceRef,
        '--touched', 'src/room/NoePostReviewPack.js',
        '--runtime-report', 'output/runtime.json',
        '--rollback', 'output/rollback.md',
        '--round-id', 'review-r',
      ]));

      expect(pack.goal).toContain('[redacted');
      expect(pack.postReviewPlan.reviewers.map((reviewer) => reviewer.model)).toEqual(['claude', 'm3', 'xiaomi']);
      expect(pack.postReviewPlan.reviewers.find((reviewer) => reviewer.model === 'claude').expectedRawOutputRef)
        .toBe('output/noe-post-review/review-r/claude-post-review.txt');
      expect(JSON.stringify(pack)).not.toContain('tp-unitsecret');
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(join(cwd, 'output/noe-post-review/unit-cli-fixture'), { recursive: true, force: true });
    }
  });
});
