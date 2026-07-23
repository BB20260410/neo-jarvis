import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { buildSurpriseLearningAudit, renderMarkdown } from '../../scripts/noe-surprise-learning-audit.mjs';

describe('noe-surprise-learning-audit', () => {
  let dir;

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = null;
  });

  function write(name, value) {
    const path = join(dir, name);
    writeFileSync(path, value);
    return path;
  }

  function writeJson(name, value) {
    return write(name, `${JSON.stringify(value, null, 2)}\n`);
  }

  function fixturePaths(latestOverrides = {}) {
    dir = mkdtempSync(join(tmpdir(), 'noe-surprise-learning-audit-'));
    const latest = {
      generatedAt: '2026-06-15T00:00:00.000Z',
      blockers: ['curiosity_source_surprise_absent'],
      expectations: {
        status: 'positive_only_no_failed_samples',
        total: 298,
        settled: 16,
        applied: 16,
        failed: 0,
        claim: 'PRIVATE_CLAIM_TEXT_SHOULD_NOT_APPEAR',
      },
      expectationJudgeContract: {
        decisiveHints: 91,
        decisiveHintUnknown: 87,
        decisiveUnknownRate: 0.956,
        avgSemanticCoverage: 0.033,
        modelReply: 'PRIVATE_MODEL_REPLY_SHOULD_NOT_APPEAR',
      },
      curiosity: {
        expectations: {
          created: 298,
          open: 282,
          settled: 16,
          applied: 16,
          failed: 0,
          failedSurpriseEligible: 0,
        },
        research: {
          surpriseGoals: 0,
          surpriseGoalsActive: 0,
          surpriseGoalsDone: 0,
        },
      },
      goals: { status: 'wired_but_no_surprise_goals', surpriseGoals: 0 },
      ownerPredictionRepair: { status: 'code_ready_live_pending_restart', liveLoaded: false },
      ...latestOverrides,
    };
    writeJson('latest.json', latest);
    writeJson('runtime-evidence-1.json', latest);
    writeJson('runtime-evidence-2.json', latest);
    return {
      runtimeEvidenceLatest: join(dir, 'latest.json'),
      runtimeEvidenceDir: dir,
      expectationResolver: write(
        'NoeExpectationResolver.js',
        [
          'const DECISIVE_REASK_SYSTEM = [];',
          'const loosenFail = process.env.NOE_EXPECT_LOOSEN_FAIL === "1";',
          'const decisiveReask = process.env.NOE_EXPECT_DECISIVE_REASK !== "0";',
          'export function createExpectationResolver({ goalSystem = null } = {}) {',
          '  if (v.outcome === 0 && goalSystem && typeof goalSystem.harvestSurprise === "function") goalSystem.harvestSurprise({ claim: exp.claim, surprise: resolvedRow.surprise });',
          '}',
        ].join('\n'),
      ),
      ownerBehaviorPredictor: write(
        'NoeOwnerBehaviorPredictor.js',
        [
          'const FOLLOWUP_FAIL_RE = /cancel|不用/;',
          'const outcome = followupFail ? 0 : 1;',
          'if (outcome === 0 && goalSystem && typeof goalSystem.harvestSurprise === "function") goalSystem.harvestSurprise({ claim: row.claim, surprise: resolvedRow.surprise });',
        ].join('\n'),
      ),
      goalSystem: write(
        'NoeGoalSystem.js',
        [
          'const curiositySurpriseThreshold = 2;',
          'function harvestSurprise({ claim, surprise } = {}) {',
          '  return add({ title: claim, source: "surprise", why: String(surprise), steps: [] });',
          '}',
        ].join('\n'),
      ),
      server: write(
        'server.js',
        [
          'createExpectationResolver({ ledger: noeExpectationLedger, goalSystem: noeGoalSystem });',
          'createOwnerBehaviorPredictor({ ledger: noeExpectationLedger, goalSystem: noeGoalSystem });',
        ].join('\n'),
      ),
      curiosityYieldReport: write(
        'noe-curiosity-yield-report.mjs',
        'export function buildCuriosityYieldReport() { return db.prepare("SELECT COUNT(*) n FROM noe_goals").get(); } // readonly',
      ),
      packageJson: writeJson('package.json', {
        scripts: {
          'noe:curiosity:yield-report': 'node scripts/ensure-node22.mjs --require-22 --exec scripts/noe-curiosity-yield-report.mjs',
        },
      }),
    };
  }

  it('does not mark surprise learning live when source=surprise is still zero', () => {
    const report = buildSurpriseLearningAudit({
      root: dir || process.cwd(),
      paths: fixturePaths(),
      now: new Date('2026-06-15T00:00:00.000Z'),
    });

    expect(report.status).toBe('code_ready_live_blocked_no_failed_samples');
    expect(report.surpriseLearningLive).toBe(false);
    expect(report.staticWiring).toMatchObject({
      allRequiredCodeWired: true,
      resolverHarvestSurprise: true,
      ownerPredictionNegative: true,
      packageScriptUsesNode22: true,
    });
    expect(report.current).toMatchObject({
      expectationsFailed: 0,
      failedSurpriseEligible: 0,
      surpriseGoals: 0,
      decisiveUnknownRate: 0.956,
    });
    expect(report.trend).toMatchObject({
      snapshots: 2,
      allFailedZero: true,
      allSurpriseGoalsZero: true,
      highUnknownSnapshots: 2,
    });
    expect(report.diagnostics).toEqual(expect.arrayContaining([
      'expectation_failure_not_observed',
      'source_surprise_absent',
      'owner_prediction_repair_live_pending_restart',
    ]));
  });

  it('renders counts and wiring without claim or model reply text', () => {
    const report = buildSurpriseLearningAudit({
      root: dir || process.cwd(),
      paths: fixturePaths(),
      now: new Date('2026-06-15T00:00:00.000Z'),
    });
    const md = renderMarkdown(report, join(dir, 'audit.json'));

    expect(md).toContain('code_ready_live_blocked_no_failed_samples');
    expect(md).toContain('expectationsFailed');
    expect(md).toContain('resolverHarvestSurprise');
    expect(md).not.toContain('PRIVATE_CLAIM_TEXT_SHOULD_NOT_APPEAR');
    expect(md).not.toContain('PRIVATE_MODEL_REPLY_SHOULD_NOT_APPEAR');
    expect(md).not.toContain('Bearer ');
  });

  it('only marks live when failed surprise and source=surprise both have flow', () => {
    const report = buildSurpriseLearningAudit({
      root: dir || process.cwd(),
      paths: fixturePaths({
        expectations: { status: 'has_failed_samples', total: 12, settled: 6, applied: 4, failed: 2 },
        curiosity: {
          expectations: { created: 12, open: 6, settled: 6, applied: 4, failed: 2, failedSurpriseEligible: 1 },
          research: { surpriseGoals: 1, surpriseGoalsActive: 1, surpriseGoalsDone: 0 },
        },
        goals: { status: 'has_surprise_goals', surpriseGoals: 1 },
        ownerPredictionRepair: { status: 'live_loaded', liveLoaded: true },
      }),
      now: new Date('2026-06-15T00:00:00.000Z'),
    });

    expect(report.status).toBe('live_working_with_surprise_goals');
    expect(report.surpriseLearningLive).toBe(true);
    expect(report.current).toMatchObject({
      expectationsFailed: 2,
      failedSurpriseEligible: 1,
      surpriseGoals: 1,
    });
  });
});
