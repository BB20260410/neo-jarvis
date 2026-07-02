import { describe, expect, it } from 'vitest';
import {
  NOE_FALLBACK_BRAIN,
  NOE_MAIN_BRAIN,
  NOE_OUTPUT_BUDGETS,
  NOE_REVIEW_BRAIN,
  buildNoeReviewBrainPreflight,
  normalizeNoeAutoModel,
  resolveNoeBrainForTask,
  resolveNoeModelLoadPlan,
  resolveNoeOutputBudget,
} from '../../src/model/NoeLocalModelPolicy.js';

describe('NoeLocalModelPolicy 三角色路由', () => {
  it('默认 main brain 是 Q35-6，review 是 Q27-4，fallback 是 G26-4', () => {
    expect(NOE_MAIN_BRAIN).toMatchObject({
      role: 'main',
      apiModel: 'qwen/qwen3.6-35b-a3b',
      loadKeys: ['qwen/qwen3.6-35b-a3b@6bit', 'qwen/qwen3.6-35b-a3b'],
      loadConfig: { contextLength: 262144, maxParallelPredictions: 1 },
    });
    expect(NOE_REVIEW_BRAIN).toMatchObject({
      role: 'review',
      apiModel: 'qwen/qwen3.6-27b',
      loadKeys: ['qwen/qwen3.6-27b@4bit', 'qwen/qwen3.6-27b'],
      loadConfig: { contextLength: 262144, maxParallelPredictions: 1, ttlSeconds: 600 },
    });
    expect(NOE_FALLBACK_BRAIN).toMatchObject({
      role: 'fallback',
      apiModel: 'gemma-4-26b-a4b-it-qat-mlx',
      loadKeys: ['gemma-4-26b-a4b-it-qat-mlx', 'google/gemma-4-26b-a4b-qat'],
    });
  });

  it('contextLength 是输入窗口，max_tokens 按任务分层输出预算', () => {
    expect(NOE_MAIN_BRAIN.loadConfig.contextLength).toBe(262144);
    expect(NOE_MAIN_BRAIN.generation.max_tokens).toBe(8192);
    expect(NOE_MAIN_BRAIN.generation.reasoning_effort).toBe('none');
    expect(NOE_REVIEW_BRAIN.generation.reasoning_effort).toBe('none');
    expect(NOE_MAIN_BRAIN.systemPrompt).toContain('本地自主开发者执行体');
    expect(NOE_MAIN_BRAIN.systemPrompt).toContain('不能把截断结果当完整结论');
    expect(NOE_OUTPUT_BUDGETS.autonomous_step.default).toBe(12288);
    expect(NOE_OUTPUT_BUDGETS.deep_deliberation.default).toBe(12288);
    expect(NOE_OUTPUT_BUDGETS.long_report.max).toBe(24576);
    expect(resolveNoeOutputBudget('inner_monologue').max_tokens).toBe(256);
    expect(resolveNoeOutputBudget('review_json', { role: 'review', requestedMaxTokens: 9000 })).toMatchObject({
      max_tokens: 4096,
      response_format: 'json_schema_when_possible',
    });
    expect(resolveNoeOutputBudget('long_evidence_review', { role: 'review', requestedMaxTokens: 12000 })).toMatchObject({
      max_tokens: 12000,
      response_format: 'json_schema_when_possible',
    });
    expect(resolveNoeOutputBudget('deep_deliberation', { role: 'fallback', requestedMaxTokens: 16000 }).max_tokens).toBe(4096);
  });

  it('高风险任务触发 review，低风险任务不触发；main unavailable 的低风险可 fallback', () => {
    expect(resolveNoeBrainForTask({ kind: 'normal_chat' })).toMatchObject({ role: 'main', requiresReview: false });
    expect(resolveNoeBrainForTask({ kind: 'delete', risk: 'critical' })).toMatchObject({ role: 'review', requiresReview: true });
    expect(resolveNoeBrainForTask({ kind: 'quick_answer', mainUnavailable: true })).toMatchObject({ role: 'fallback', degradedMode: true });
    expect(resolveNoeBrainForTask({ kind: 'delete', mainUnavailable: true })).toMatchObject({ role: 'review' });
  });

  it('load plan 区分 API model id 和 6bit/4bit load key', () => {
    expect(resolveNoeModelLoadPlan('qwen/qwen3.6-35b-a3b')).toMatchObject({
      role: 'main',
      model: 'qwen/qwen3.6-35b-a3b',
      loadModel: 'qwen/qwen3.6-35b-a3b@6bit',
      parallel: 1,
    });
    expect(resolveNoeModelLoadPlan('qwen/qwen3.6-27b')).toMatchObject({
      role: 'review',
      loadModel: 'qwen/qwen3.6-27b@4bit',
      ttlSeconds: 600,
    });
  });

  it('旧 Q35 mlx/8bit 别名在 Noe 自动链路中归一到当前 Q35-6 主脑', () => {
    expect(normalizeNoeAutoModel('qwen3.6-35b-a3b-mlx')).toBe('qwen/qwen3.6-35b-a3b');
    expect(normalizeNoeAutoModel('qwen3.6-35b-a3b-mlx@8bit')).toBe('qwen/qwen3.6-35b-a3b');
    expect(resolveNoeModelLoadPlan('qwen3.6-35b-a3b-mlx@8bit')).toMatchObject({
      role: 'main',
      model: 'qwen/qwen3.6-35b-a3b',
      loadModel: 'qwen/qwen3.6-35b-a3b@6bit',
      parallel: 1,
    });
  });

  it('高风险 preflight 生成 Review Brain JSON 复核请求，低风险 dry-run 不强制', () => {
    const high = buildNoeReviewBrainPreflight({
      actionId: 'noe.freedom.social.final_publish.execute',
      tool: { id: 'noe.freedom.social.final_publish.execute', operation: 'noe.freedom.social.final_publish.execute', riskLevel: 'critical', tags: ['publish'] },
      args: { draftId: 'd1', secret: 'should-only-report-key-name', snapshot: { ref: 'snap' }, portBoundary: 'panel=127.0.0.1:51835' },
      authorization: { mode: 'developer_unrestricted', ownerPresent: true, rollbackPlan: 'delete or correct published post' },
      realExecute: true,
      evidenceRefs: { priorStageEvidence: 'ledger.json', rawOutputRef: 'raw.json', secretLeakRisk: 'redacted' },
    });
    expect(high.required).toBe(true);
    expect(high.brain).toMatchObject({ role: 'review', model: 'qwen/qwen3.6-27b', loadModel: 'qwen/qwen3.6-27b@4bit' });
    expect(high.request).toMatchObject({ responseFormat: 'json_schema_when_possible', max_tokens: 4096 });
    expect(high.request.user.argsKeys).toContain('secret');
    expect(high.request.user.ownerAuthorization).toMatchObject({
      mode: 'developer_unrestricted',
      ownerPresent: true,
      rollbackPlanPresent: true,
      developerUnrestrictedOwnerOverride: true,
      specificCapabilityGrantPresent: false,
    });
    expect(high.request.user.ownerAuthorization.allowlistAccepted).toBeUndefined();
    expect(high.request.user.evidenceCoverage).toMatchObject({
      priorStageEvidence: true,
      rawOutputRef: true,
      snapshot: true,
      rollbackPlan: true,
      ownerAuthorization: true,
      portBoundary: true,
      secretLeakRisk: true,
    });
    expect(high.request.user.evidenceSummary).toMatchObject({
      priorStageEvidence: 'ledger.json',
      rawOutputRef: 'raw.json',
      rollbackPlan: 'delete or correct published post',
      portBoundary: 'panel=127.0.0.1:51835',
    });
    expect(JSON.stringify(high.request.user.evidenceSummary)).not.toContain('should-only-report-key-name');

    const large = buildNoeReviewBrainPreflight({
      actionId: 'noe.freedom.social.media_upload.execute',
      tool: { id: 'noe.freedom.social.media_upload.execute', operation: 'noe.freedom.social.media_upload.execute', riskLevel: 'critical', tags: ['upload'] },
      args: {
        priorStageEvidence: {
          kind: 'social_dom_live_probe_preflight',
          completedStages: ['root_reachable', 'dry_run_orchestrate_generated_probe_step'],
          browserSnapshot: { host: 'creator.xiaohongshu.com', urlSha256: 'u'.repeat(64), titleSha256: 't'.repeat(64) },
          largePad: 'x'.repeat(15_000),
          repeatedEvidence: Array.from({ length: 120 }, (_, index) => ({ index, ok: true, role: `role-${index}`, secretValuesReturned: false })),
        },
        snapshot: {
          kind: 'browser_dom_page_readiness_contract',
          largePad: 'y'.repeat(15_000),
          repeatedEvidence: Array.from({ length: 120 }, (_, index) => ({ index, hostMatched: true, noFinalPublishActionTouched: true })),
        },
      },
      authorization: { mode: 'developer_unrestricted', ownerPresent: true, rollbackPlan: 'close the draft tab without publishing' },
      realExecute: true,
      evidenceRefs: { rawOutputRef: 'freedom_run_ledger:unit', ownerAuthorization: 'specific_capability_grant=minimal_xiaohongshu_publish_delete_live_test', secretLeakRisk: 'redacted' },
    });
    expect(JSON.stringify(large.request.user.evidenceSummary)).not.toContain('[object Object]');
    expect(large.request.user.ownerAuthorization.specificCapabilityGrantPresent).toBe(true);
    expect(large.request.user.evidenceSummary.priorStageEvidence).toMatchObject({
      truncated: true,
      jsonSha256: expect.any(String),
      jsonPreview: expect.stringContaining('social_dom_live_probe_preflight'),
    });
    expect(large.request.user.evidenceSummary.snapshot).toMatchObject({
      truncated: true,
      jsonSha256: expect.any(String),
      jsonPreview: expect.stringContaining('browser_dom_page_readiness_contract'),
    });

    const low = buildNoeReviewBrainPreflight({
      actionId: 'noe.freedom.browser.state_probe',
      tool: { id: 'noe.freedom.browser.state_probe', operation: 'noe.freedom.browser.state_probe', riskLevel: 'low', tags: ['browser'] },
      realExecute: false,
    });
    expect(low.required).toBe(false);
  });
});
