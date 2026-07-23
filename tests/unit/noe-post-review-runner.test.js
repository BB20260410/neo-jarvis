import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { buildNoeActionEvidence } from '../../src/runtime/NoeActionEvidence.js';
import { buildNoePostReviewPack } from '../../src/room/NoePostReviewPack.js';
import {
  DEFAULT_NOE_POST_REVIEW_RUNNER_ROOT,
  buildNoePostReviewFromRaw,
  evaluateNoePostReviewResults,
  runNoePostReviewRound,
} from '../../src/room/NoePostReviewRunner.js';

const postReviewRunnerSource = readFileSync(join(process.cwd(), 'src/room/NoePostReviewRunner.js'), 'utf8');

function makeRoot() {
  return mkdtempSync(join(tmpdir(), 'noe-post-review-runner-'));
}

function actionEvidence() {
  return buildNoeActionEvidence({
    act: { id: 'act-post-review', action: 'self_evolution.implementation', riskLevel: 'high' },
    permissionResult: { decision: 'allow', reason: 'validated consensus ledger' },
    contextSufficiency: { sufficient: true, blockers: [] },
    dryRunOnly: false,
    executorResult: { ok: true, reportRef: 'output/runtime/pass.json' },
    refs: {
      runtimeReport: 'output/runtime/pass.json',
      rollback: 'output/rollback.md',
      changedFiles: ['src/room/NoePostReviewRunner.js'],
    },
  });
}

function pack(overrides = {}) {
  return buildNoePostReviewPack({
    goal: 'Review a completed Noe implementation slice',
    consensusLedgerRef: 'output/noe-multimodel/review-ledger/ledger.json',
    actionEvidence: actionEvidence(),
    implementation: {
      writer: 'codex',
      done: true,
      touchedFiles: ['src/room/NoePostReviewRunner.js'],
    },
    runtimeVerification: { ok: true, reportRef: 'output/runtime/pass.json' },
    rollback: { planRef: 'output/rollback.md' },
    tests: ['npm run test:p0:unit'],
    reviewRoundRef: 'output/noe-post-review/unit-round',
    // P3 摘 xiaomi 后默认 optional 为空；本测试族显式加回 xiaomi 以继续覆盖「optional reviewer 机制」本身。
    optionalReviewers: ['xiaomi'],
    ...overrides,
  });
}

function raw(model, decision = 'approve') {
  const authority = model === 'm3' ? 'suggestion_only' : model === 'claude' ? 'readonly_source_reviewer' : 'advisory';
  return JSON.stringify({
    model,
    decision,
    confidence: 0.86,
    authority,
    canWrite: false,
    blockers: [],
    verification_required: ['npm run test:p0:unit'],
    evidence_gaps: [],
    consensus_vote: decision === 'reject' ? 'no' : 'yes',
  }, null, 2);
}

function unavailable(model) {
  const authority = model === 'm3' ? 'suggestion_only' : model === 'claude' ? 'readonly_source_reviewer' : 'advisory';
  return JSON.stringify({
    model,
    decision: 'unavailable',
    confidence: 0,
    authority,
    canWrite: false,
    blockers: ['quota_exhausted'],
    verification_required: [],
    evidence_gaps: [],
    consensus_vote: 'abstain',
  }, null, 2);
}

describe('NoePostReviewRunner', () => {
  it('derives the default runner root from the module location rather than caller cwd', () => {
    // 跨环境断言：与本测试文件位置推导的仓库根相等（CI checkout 目录叫 noe，不能写死本机目录名"Neo 贾维斯"）
    const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
    expect(resolve(DEFAULT_NOE_POST_REVIEW_RUNNER_ROOT)).toBe(repoRoot);
  });

  it('sanitizes built-in reviewer CLI spawn environment instead of inheriting full process env', () => {
    expect(postReviewRunnerSource).toContain("import { buildNoeSafeChildProcessEnv } from '../security/NoeHostExecEnv.js'");
    expect(postReviewRunnerSource).toContain('env: buildNoeSafeChildProcessEnv(process.env');
    expect(postReviewRunnerSource).not.toContain('env: { ...process.env');
  });

  it('dry-runs by writing a manifest without reviewer raw outputs', async () => {
    const root = makeRoot();
    const result = await runNoePostReviewRound({
      pack: pack(),
      roundId: 'dry-run',
      runModels: false,
    }, { root });

    expect(result.status).toBe('dry_run');
    expect(existsSync(join(root, 'output/noe-post-review/dry-run/manifest.json'))).toBe(true);
    expect(existsSync(join(root, 'output/noe-post-review/dry-run/claude-post-review.txt'))).toBe(false);
  });

  it('runs injected reviewers and produces a passing dynamic post-review quorum', async () => {
    const root = makeRoot();
    const result = await runNoePostReviewRound({
      pack: pack(),
      roundId: 'passing-review',
      runModels: true,
      costAcknowledged: true,
    }, {
      root,
      runners: {
        claude: async () => raw('claude', 'approve_with_changes'),
        m3: async () => raw('m3', 'approve'),
        xiaomi: async () => raw('xiaomi', 'approve'),
      },
    });

    expect(result.ok).toBe(true);
    expect(result.postReview.dynamicQuorum).toMatchObject({
      availableCount: 2,
      threshold: 2,
      approvedCount: 2,
      unavailable: [],
    });
    const postReview = JSON.parse(readFileSync(join(root, 'output/noe-post-review/passing-review/post-review.json'), 'utf8'));
    expect(postReview.reviews.map((review) => review.model)).toEqual(['claude', 'm3', 'xiaomi']);
    expect(postReview.dynamicQuorum.approvals).toEqual(['claude', 'm3']);
  });

  it('records Codex fallback evidence for unavailable required reviewers without counting it as a reviewer vote', async () => {
    const root = makeRoot();
    const codexCalls = [];
    const result = await runNoePostReviewRound({
      pack: pack(),
      roundId: 'fallback-m3',
      runModels: true,
      costAcknowledged: true,
    }, {
      root,
      runners: {
        claude: async () => raw('claude'),
        m3: async () => unavailable('m3'),
        xiaomi: async () => raw('xiaomi'),
        codex: async (args) => {
          codexCalls.push(args);
          return JSON.stringify({
            model: 'codex',
            fallback_for: args.fallbackFor,
            counted_in_post_review_quorum: false,
            decision: 'approve',
            confidence: 0.7,
            authority: 'writer_integrator_supplemental',
            canWrite: true,
            blockers: [],
            verification_required: [],
            evidence_gaps: [],
            consensus_vote: 'yes',
          });
        },
      },
    });

    expect(result.ok).toBe(false);
    expect(result.status).toBe('post_review_blocked');
    expect(result.postReview.dynamicQuorum).toMatchObject({
      availableCount: 1,
      threshold: 2,
      approvedCount: 1,
      unavailable: ['m3'],
    });
    expect(result.postReview.dynamicQuorum.errors).toContain('post_review_insufficient_available_models:1');
    expect(codexCalls).toHaveLength(1);
    expect(codexCalls[0]).toMatchObject({ fallbackFor: 'm3', countedInPostReviewQuorum: false });
    const postReview = JSON.parse(readFileSync(join(root, 'output/noe-post-review/fallback-m3/post-review.json'), 'utf8'));
    expect(postReview.artifacts).toEqual([
      expect.objectContaining({
        type: 'codex_post_review_fallback',
        model: 'codex',
        fallbackFor: 'm3',
        countedInPostReviewQuorum: false,
        rawOutputRef: 'output/noe-post-review/fallback-m3/codex-fallback-for-m3.txt',
      }),
    ]);
    expect(postReview.reviews.filter((review) => review.model === 'codex')).toHaveLength(0);
  });

  it('does not let Codex fallback make a one-reviewer quorum pass', async () => {
    const root = makeRoot();
    const result = await runNoePostReviewRound({
      pack: pack(),
      roundId: 'fallback-insufficient',
      runModels: true,
      costAcknowledged: true,
    }, {
      root,
      runners: {
        claude: async () => raw('claude'),
        m3: async () => unavailable('m3'),
        xiaomi: async () => unavailable('xiaomi'),
        codex: async (args) => raw('codex', args.fallbackFor ? 'approve' : 'abstain'),
      },
    });

    expect(result.ok).toBe(false);
    expect(result.status).toBe('post_review_blocked');
    expect(result.postReview.dynamicQuorum.errors).toContain('post_review_insufficient_available_models:1');
    expect(result.postReview.dynamicQuorum.errors).toContain('post_review_dynamic_quorum_required:1/2');
    expect(result.postReview.artifacts.filter((artifact) => artifact.type === 'codex_post_review_fallback')).toHaveLength(2);
  });

  it('redacts secret-like values from raw outputs and parsed review fields', async () => {
    const root = makeRoot();
    const result = await runNoePostReviewRound({
      pack: pack(),
      roundId: 'redacted-review',
      runModels: true,
      costAcknowledged: true,
    }, {
      root,
      runners: {
        claude: async () => `${raw('claude')}\nsecret tp-unitsecret000000000000000000000000000000`,
        m3: async () => JSON.stringify({
          model: 'm3',
          decision: 'approve',
          confidence: 0.8,
          authority: 'suggestion_only',
          canWrite: false,
          blockers: ['saw sk-unitsecret000000000000000000000000'],
          verification_required: [],
          evidence_gaps: [],
          consensus_vote: 'yes',
        }),
        xiaomi: async () => raw('xiaomi'),
      },
    });

    expect(result.ok).toBe(true);
    const rawFile = readFileSync(join(root, 'output/noe-post-review/redacted-review/claude-post-review.txt'), 'utf8');
    const postReview = readFileSync(join(root, 'output/noe-post-review/redacted-review/post-review.json'), 'utf8');
    expect(rawFile).not.toContain('tp-unitsecret');
    expect(postReview).not.toContain('sk-unitsecret');
    expect(postReview).not.toContain('tp-unitsecret');
  });

  it('evaluates duplicate required reviewers and missing raw refs as blockers', () => {
    const summary = evaluateNoePostReviewResults([
      buildNoePostReviewFromRaw({ reviewer: 'claude', rawOutput: raw('claude'), rawOutputRef: '' }),
      buildNoePostReviewFromRaw({ reviewer: 'claude', rawOutput: raw('claude'), rawOutputRef: 'output/r/claude-2.txt' }),
      buildNoePostReviewFromRaw({ reviewer: 'm3', rawOutput: raw('m3'), rawOutputRef: 'output/r/m3.txt' }),
    ], pack());

    expect(summary.ok).toBe(false);
    expect(summary.errors).toContain('post_review_duplicate_required_reviewer:claude');
    expect(summary.errors).toContain('post_review_missing_raw_output_ref:claude');
  });
});
