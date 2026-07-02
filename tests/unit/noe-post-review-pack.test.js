import { describe, expect, it } from 'vitest';
import { buildNoeActionEvidence } from '../../src/runtime/NoeActionEvidence.js';
import {
  buildNoePostReviewPack,
  buildNoePostReviewPrompt,
  validateNoePostReviewPack,
} from '../../src/room/NoePostReviewPack.js';

function actionEvidence() {
  return buildNoeActionEvidence({
    act: { id: 'act-review-1', action: 'self_evolution.implementation', title: 'P0 implementation', riskLevel: 'high' },
    permissionResult: { decision: 'allow', reason: 'validated consensus ledger' },
    contextSufficiency: { sufficient: true, blockers: [] },
    dryRunOnly: false,
    executorResult: { ok: true, reportRef: 'output/runtime/pass.json' },
    refs: {
      runtimeReport: 'output/runtime/pass.json',
      rollback: 'output/rollback.md',
      changedFiles: ['src/room/NoePostReviewPack.js'],
    },
  });
}

function completePack(overrides = {}) {
  return buildNoePostReviewPack({
    goal: 'Review a Noe implementation slice',
    consensusLedgerRef: 'output/noe-multimodel/review-a/ledger.json',
    actionEvidence: actionEvidence(),
    implementation: {
      writer: 'codex',
      done: true,
      diffRef: 'output/review-a/diff.patch',
      touchedFiles: ['src/room/NoePostReviewPack.js'],
    },
    runtimeVerification: {
      ok: true,
      reportRef: 'output/runtime/pass.json',
    },
    rollback: {
      planRef: 'output/rollback.md',
    },
    tests: ['npm run test:p0:unit'],
    reviewRoundRef: 'output/noe-multimodel/review-a',
    ...overrides,
  });
}

describe('NoePostReviewPack', () => {
  it('builds a complete redacted review_work evidence pack for non-writer reviewers', () => {
    const pack = completePack({
      notes: 'do not leak tp-unitsecret000000000000000000000000000000',
    });

    expect(pack.sha256).toHaveLength(64);
    expect(pack.postReviewPlan.requiredReviewers).toEqual(['claude', 'm3']);
    expect(pack.postReviewPlan.reviewers).toEqual(expect.arrayContaining([
      expect.objectContaining({ model: 'claude', authority: 'readonly_source_reviewer', canWrite: false, expectedRawOutputRef: 'output/noe-multimodel/review-a/claude-post-review.txt' }),
      expect.objectContaining({ model: 'm3', authority: 'suggestion_only', canWrite: false, expectedRawOutputRef: 'output/noe-multimodel/review-a/m3-post-review.txt' }),
      expect.objectContaining({ model: 'xiaomi', authority: 'advisory', canWrite: false, required: false }),
    ]));
    expect(JSON.stringify(pack)).not.toContain('tp-unitsecret');
    expect(validateNoePostReviewPack(pack, { requireReviewerOutputRefs: true }).ok).toBe(true);
  });

  it('builds a Claude executor pack that asks Codex/M3 to review', () => {
    const pack = completePack({
      implementation: {
        writer: 'claude',
        activeExecutor: 'claude',
        executorSelection: { selectedBy: 'user', reason: 'codex_quota_unavailable' },
        done: true,
        diffRef: 'output/review-a/diff.patch',
        touchedFiles: ['src/room/NoePostReviewPack.js'],
      },
    });

    expect(pack.authorityBoundary.writer).toBe('claude');
    expect(pack.postReviewPlan.requiredReviewers).toEqual(['codex', 'm3']);
    expect(pack.postReviewPlan.reviewers).toEqual(expect.arrayContaining([
      expect.objectContaining({ model: 'codex', canWrite: false, required: true }),
      expect.objectContaining({ model: 'm3', canWrite: false, required: true }),
    ]));
    expect(pack.postReviewPlan.requiredReviewers).not.toContain('claude');
    expect(validateNoePostReviewPack(pack, { requireReviewerOutputRefs: true }).ok).toBe(true);
  });

  it('blocks packs without runtime verification evidence', () => {
    const pack = completePack({
      runtimeVerification: { ok: false, reportRef: '' },
      actionEvidence: buildNoeActionEvidence({
        act: { id: 'act-review-2', action: 'self_evolution.implementation' },
        permissionResult: { decision: 'allow', reason: 'ok' },
      }),
    });
    const validation = validateNoePostReviewPack(pack);

    expect(validation.ok).toBe(false);
    expect(validation.errors).toContain('post_review_runtime_verification_required');
    expect(validation.errors).toContain('post_review_runtime_report_ref_required');
    expect(validation.errors).toContain('post_review_action_evidence:runtime_evidence_required');
  });

  it('requires changed files or implementation evidence for review_work', () => {
    const pack = completePack({
      implementation: {
        writer: 'codex',
        done: true,
        touchedFiles: [],
        diffRef: '',
        evidenceRef: '',
        changedFilesRef: '',
      },
      changedFiles: [],
    });
    const validation = validateNoePostReviewPack(pack);

    expect(validation.ok).toBe(false);
    expect(validation.errors).toContain('post_review_changed_files_required');
  });

  it('rejects non-executable implementation writers and writable M3 reviewers', () => {
    const pack = completePack({
      implementation: {
        writer: 'm3',
        done: true,
        touchedFiles: ['src/x.js'],
      },
      requiredReviewers: ['claude', 'm3'],
    });
    pack.postReviewPlan.reviewers = pack.postReviewPlan.reviewers.map((reviewer) => (
      reviewer.model === 'm3'
        ? { ...reviewer, canWrite: true, authority: 'advisory' }
        : reviewer
    ));
    const validation = validateNoePostReviewPack(pack);

    expect(validation.ok).toBe(false);
    expect(validation.errors).toContain('post_review_active_executor_not_writable:m3');
    expect(validation.errors).toContain('post_review_reviewer_must_not_write:m3');
    expect(validation.errors).toContain('post_review_m3_must_be_suggestion_only');
  });

  it('requires expected raw output refs when the caller asks for reviewer artifact planning', () => {
    const pack = buildNoePostReviewPack({
      goal: 'Review without round ref',
      consensusLedgerRef: 'output/noe-multimodel/review-b/ledger.json',
      actionEvidence: actionEvidence(),
      implementation: { writer: 'codex', done: true, touchedFiles: ['src/x.js'] },
      runtimeVerification: { ok: true, reportRef: 'output/runtime/pass.json' },
      rollback: { planRef: 'output/rollback.md' },
    });
    const validation = validateNoePostReviewPack(pack, { requireReviewerOutputRefs: true });

    expect(validation.ok).toBe(false);
    expect(validation.errors).toContain('post_review_expected_raw_output_ref_required:claude');
    expect(validation.errors).toContain('post_review_expected_raw_output_ref_required:m3');
  });

  it('builds readonly reviewer prompts without leaking secrets or write authority', () => {
    const pack = completePack({ notes: 'Authorization: Bearer sk-unitsecret000000000000000000000000' });
    const prompt = buildNoePostReviewPrompt({ pack, reviewer: 'm3' });

    expect(prompt).toContain('model: m3');
    expect(prompt).toContain('authority: suggestion_only');
    expect(prompt).toContain('canWrite: false');
    expect(prompt).not.toContain('sk-unitsecret');
  });
});
