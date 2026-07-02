import { describe, expect, it } from 'vitest';
import {
  extractFreedomStageSummary,
  renderFreedomStageSummary,
} from '../../public/src/web/noe-freedom-stage-summary.js';

function sampleStageResult() {
  return {
    runtime: {
      socialPublishStageSummary: {
        ok: false,
        stageCount: 3,
        publishStepPresent: true,
        publishAttempted: false,
        externalSideEffectPlanned: true,
        externalSideEffectPerformed: false,
        domProbeSummary: {
          ok: false,
          foundRoles: ['read_title', 'media_upload'],
          missingRoles: ['title', 'content'],
        },
        rollbackEvidence: {
          evidenceStatus: 'pending_probe',
          verifiedByNoe: false,
          missingEvidence: ['post_publish_url'],
        },
        stages: [
          { stage: 'form_fill_execute', stepId: 'fill_form', ok: true, blockers: [], childLedgerRef: 'output/noe-freedom-runs/fill/ledger.json' },
          { stage: 'media_upload_execute', stepId: 'upload_media', ok: true, blockers: [], childLedgerRef: 'output/noe-freedom-runs/upload/ledger.json' },
          { stage: 'final_publish_execute', stepId: 'final_publish', ok: false, blockers: ['final_publish_prior_stage_evidence_required'], childLedgerRef: 'output/noe-freedom-runs/final?token=secret-value' },
        ],
      },
    },
  };
}

describe('Noe freedom social stage summary UI', () => {
  it('extracts social publish stages without exposing secret-like refs', () => {
    const summary = extractFreedomStageSummary(sampleStageResult());

    expect(summary).toMatchObject({
      ok: false,
      stageCount: 3,
      publishStepPresent: true,
      externalSideEffectPlanned: true,
      externalSideEffectPerformed: false,
    });
    expect(summary.stages).toHaveLength(3);
    expect(summary.stages[2]).toMatchObject({
      label: '最终发布',
      blockers: ['final_publish_prior_stage_evidence_required'],
    });
    expect(summary.stages[2].childLedgerRef).toContain('token=[redacted]');
  });

  it('renders blockers, rollback evidence, and DOM readiness', () => {
    const html = renderFreedomStageSummary(sampleStageResult());

    expect(html).toContain('社交发布链');
    expect(html).toContain('填表执行');
    expect(html).toContain('媒体上传');
    expect(html).toContain('最终发布');
    expect(html).toContain('final_publish_prior_stage_evidence_required');
    expect(html).toContain('DOM readiness');
    expect(html).toContain('media_upload');
    expect(html).toContain('Rollback evidence');
    expect(html).toContain('pending_probe');
    expect(html).not.toContain('secret-value');
  });

  it('highlights the blocked stage with status badges, warnings, and the rollback gate label', () => {
    const html = renderFreedomStageSummary({
      runtime: {
        socialPublishStageSummary: {
          ok: false,
          stageCount: 2,
          blockedAtStepId: 'final_publish',
          stages: [
            { stage: 'rollback_evidence_gate', stepId: 'rollback_gate', ok: true, blockers: [], warnings: ['draft_already_has_external_side_effect'] },
            { stage: 'final_publish_execute', stepId: 'final_publish', ok: false, blockers: ['final_publish_click_not_confirmed'] },
          ],
        },
      },
    });
    expect(html).toContain('回滚证据门控');
    expect(html).toContain('✓');
    expect(html).toContain('✗');
    expect(html).toContain('← 卡在这里');
    expect(html).toContain('⚠1');
    expect(html).toContain('noe-brain-row--blocked-here');
  });

  it('renders DOM readiness from the chain-level domRecipeProbe field name', () => {
    const html = renderFreedomStageSummary({
      runtime: {
        socialPublishStageSummary: {
          ok: true,
          stageCount: 1,
          domRecipeProbe: { ok: true, foundRoles: ['media_upload'], missingRoles: [] },
          stages: [{ stage: 'dom_recipe_probe', stepId: 'probe', ok: true, blockers: [] }],
        },
      },
    });
    expect(html).toContain('DOM readiness');
    expect(html).toContain('media_upload');
  });

  it('extracts blockedAt and surfaces the redacted rollback platform/target', () => {
    const stageSummary = {
      ok: false,
      blockedAtStepId: 'final_publish',
      rollbackEvidence: {
        evidenceStatus: 'verified',
        verifiedByNoe: true,
        missingEvidence: [],
        platform: 'douyin',
        postUrlRef: 'https://www.douyin.com/video/1?token=secret-value',
      },
      stages: [],
    };
    const summary = extractFreedomStageSummary({ runtime: { socialPublishStageSummary: stageSummary } });
    expect(summary.blockedAt).toBe('final_publish');
    const html = renderFreedomStageSummary({ runtime: { socialPublishStageSummary: stageSummary } });
    expect(html).toContain('douyin');
    expect(html).toContain('target:');
    expect(html).not.toContain('secret-value');
  });
});
