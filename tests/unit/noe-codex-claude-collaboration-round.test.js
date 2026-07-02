import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  buildCodexClaudeProtocolChecklist,
  createCodexClaudeCollaborationRound,
  validateCodexClaudeCollaborationRound,
  writeCodexClaudeCollaborationRound,
} from '../../src/room/NoeCodexClaudeCollaborationRound.js';

function makeRoot() {
  return mkdtempSync(join(tmpdir(), 'noe-codex-claude-round-'));
}

const codexPlan = 'Codex 独立方案：先建协议 artifact，再接 CLI，最后用单测和 dry-run 验证，默认 Codex 写入。';
const claudePlan = 'Claude 独立方案：先保留 Claude session 和显式记忆，再进行互审，最后用同意门阻断过早执行。';
const codexReview = 'Codex 对 Claude 方案的审查：采纳持久记忆和同意门，但补充单写者约束、成本确认和敏感文件拒绝。';
const claudeReview = 'Claude 对 Codex 方案的审查：采纳 artifact 和 CLI，但要求补充双方 agree、综合方案和分工执行记录。';
const synthesis = '综合方案：双方案先独立产生，再互审，说服后生成合并计划；双方 agree 后按单写者规则执行并留证。';
const sharedEvidence = [
  {
    ref: 'src/room/NoeCodexClaudeCollaborationRound.js',
    kind: 'file',
    hash: 'unit-sha',
    requiredFor: ['codex', 'claude'],
    readBy: { codex: true, claude: true },
    notes: '双方直接读取同一协议实现，而不是只看摘要。',
  },
];
const challengeLog = [
  {
    claim: 'Claude 认为协议缺少同意门。',
    by: 'claude',
    reviewedBy: 'codex',
    decision: 'refuted',
    evidenceRef: 'src/room/NoeCodexClaudeCollaborationRound.js',
    note: '代码已有 agree 校验；本轮补强的是证据和争议门。',
  },
];
const readinessCriteria = {
  risksAddressed: true,
  verificationPlan: true,
  rollbackPlan: true,
  singleWriter: true,
  noSecretLeak: true,
  costNotApplicable: true,
};
const agentReports = {
  claude: {
    reportRef: 'output/noe-claude-collaborator/unit.md',
    sessionId: 'sess-persistent-1',
    generatedAt: '2026-06-13T08:00:00.000Z',
    requiredMode: 'Claude 4.8 Max',
    requestedModel: 'claude-opus-4-8',
    requestedEffort: 'max',
    evidenceRead: [
      { ref: 'src/room/NoeCodexClaudeCollaborationRound.js', mode: 'direct-read' },
    ],
  },
};
const codexAgreementRationale = '综合方案已将共享证据、争议纠错、执行门槛、回滚和单写者约束全部落到 artifact 校验中，具备可执行性。';
const claudeAgreementRationale = 'Claude 的审查证据、挑战记录和同意理由都有 report 溯源，且 unresolved 事实会阻断执行，符合协作要求。';

describe('NoeCodexClaudeCollaborationRound', () => {
  it('blocks execution until both plans, reviews, synthesis, agreements, and labor split exist', () => {
    const round = createCodexClaudeCollaborationRound({
      task: '让 Codex 和 Claude 协作开发 Neo',
      codexPlan,
      claudePlan,
      status: 'ready_to_execute',
      codexAgreement: 'agree',
      claudeAgreement: 'agree',
    });

    const validation = validateCodexClaudeCollaborationRound(round);

    expect(validation.ok).toBe(false);
    expect(validation.readyToExecute).toBe(false);
    expect(validation.blockers).toContain('missing_codex_review_of_claude');
    expect(validation.blockers).toContain('missing_claude_review_of_codex');
    expect(validation.blockers).toContain('missing_synthesis');
    expect(validation.blockers).toContain('missing_division_of_labor');
  });

  it('marks a mutually agreed single-writer round ready to execute', () => {
    const round = createCodexClaudeCollaborationRound({
      task: '让 Codex 和 Claude 协作开发 Neo',
      sharedEvidence,
      codexPlan,
      claudePlan,
      codexReviewOfClaude: codexReview,
      claudeReviewOfCodex: claudeReview,
      challengeLog,
      agentReports,
      synthesis,
      status: 'ready_to_execute',
      activeExecutor: 'codex',
      codexAgreement: 'agree',
      claudeAgreement: 'agree',
      codexAgreementRationale,
      claudeAgreementRationale,
      codexWork: ['实现协议模块', '运行测试并汇总'],
      claudeWork: ['审查综合方案', '输出下一轮风险清单'],
      readinessCriteria,
    });

    const validation = validateCodexClaudeCollaborationRound(round);

    expect(validation.ok).toBe(true);
    expect(validation.readyToExecute).toBe(true);
    expect(validation.sharedEvidenceReadByBoth).toBe(true);
    expect(validation.unresolvedChallenges).toBe(0);
    expect(round.boundaries.codexRole).toBe('writer_integrator');
    expect(round.boundaries.claudeRole).toBe('development_partner_reviewer');
  });

  it('blocks ready execution when shared evidence was not read by both agents', () => {
    const round = createCodexClaudeCollaborationRound({
      task: '让 Codex 和 Claude 协作开发 Neo',
      sharedEvidence: [{ ...sharedEvidence[0], readBy: { codex: true, claude: false } }],
      codexPlan,
      claudePlan,
      codexReviewOfClaude: codexReview,
      claudeReviewOfCodex: claudeReview,
      synthesis,
      agentReports,
      status: 'ready_to_execute',
      codexAgreement: 'agree',
      claudeAgreement: 'agree',
      codexAgreementRationale,
      claudeAgreementRationale,
      codexWork: ['写代码'],
      claudeWork: ['复核'],
      readinessCriteria,
    });

    const validation = validateCodexClaudeCollaborationRound(round);

    expect(validation.readyToExecute).toBe(false);
    expect(validation.nextAction).toBe('blocked');
    expect(validation.blockers).toContain('shared_evidence_not_read:claude:src/room/NoeCodexClaudeCollaborationRound.js');
  });

  it('blocks ready execution when factual disputes remain unresolved', () => {
    const round = createCodexClaudeCollaborationRound({
      task: '让 Codex 和 Claude 协作开发 Neo',
      sharedEvidence,
      codexPlan,
      claudePlan,
      codexReviewOfClaude: codexReview,
      claudeReviewOfCodex: claudeReview,
      challengeLog: [{ ...challengeLog[0], decision: 'unresolved' }],
      agentReports,
      synthesis,
      status: 'ready_to_execute',
      codexAgreement: 'agree',
      claudeAgreement: 'agree',
      codexAgreementRationale,
      claudeAgreementRationale,
      codexWork: ['写代码'],
      claudeWork: ['复核'],
      readinessCriteria,
    });

    const validation = validateCodexClaudeCollaborationRound(round);

    expect(validation.readyToExecute).toBe(false);
    expect(validation.unresolvedChallenges).toBe(1);
    expect(validation.blockers[0]).toContain('unresolved_challenge');
  });

  it('blocks challenge self-review so one agent cannot sign its own disputed claim', () => {
    const round = createCodexClaudeCollaborationRound({
      task: '让 Codex 和 Claude 协作开发 Neo',
      sharedEvidence,
      codexPlan,
      claudePlan,
      codexReviewOfClaude: codexReview,
      claudeReviewOfCodex: claudeReview,
      challengeLog: [{ ...challengeLog[0], reviewedBy: 'claude', decision: 'confirmed' }],
      agentReports,
      synthesis,
      status: 'ready_to_execute',
      codexAgreement: 'agree',
      claudeAgreement: 'agree',
      codexAgreementRationale,
      claudeAgreementRationale,
      codexWork: ['写代码'],
      claudeWork: ['复核'],
      readinessCriteria,
    });

    const validation = validateCodexClaudeCollaborationRound(round);

    expect(validation.readyToExecute).toBe(false);
    expect(validation.blockers[0]).toContain('challenge_self_review');
  });

  it('blocks ready execution when Claude report trace is missing', () => {
    const round = createCodexClaudeCollaborationRound({
      task: '让 Codex 和 Claude 协作开发 Neo',
      sharedEvidence,
      codexPlan,
      claudePlan,
      codexReviewOfClaude: codexReview,
      claudeReviewOfCodex: claudeReview,
      challengeLog,
      synthesis,
      status: 'ready_to_execute',
      codexAgreement: 'agree',
      claudeAgreement: 'agree',
      codexAgreementRationale,
      claudeAgreementRationale,
      codexWork: ['写代码'],
      claudeWork: ['复核'],
      readinessCriteria,
    });

    const validation = validateCodexClaudeCollaborationRound(round);

    expect(validation.readyToExecute).toBe(false);
    expect(validation.blockers).toContain('missing_claude_report_ref');
    expect(validation.blockers).toContain('claude_report_missing_evidence_read:src/room/NoeCodexClaudeCollaborationRound.js');
  });

  it('blocks ready execution when Claude report is not 4.8 Max', () => {
    const round = createCodexClaudeCollaborationRound({
      task: '让 Codex 和 Claude 协作开发 Neo',
      sharedEvidence,
      codexPlan,
      claudePlan,
      codexReviewOfClaude: codexReview,
      claudeReviewOfCodex: claudeReview,
      challengeLog,
      agentReports: {
        claude: {
          ...agentReports.claude,
          requiredMode: 'Claude Sonnet',
          requestedModel: 'sonnet',
          requestedEffort: 'high',
        },
      },
      synthesis,
      status: 'ready_to_execute',
      codexAgreement: 'agree',
      claudeAgreement: 'agree',
      codexAgreementRationale,
      claudeAgreementRationale,
      codexWork: ['写代码'],
      claudeWork: ['复核'],
      readinessCriteria,
    });

    const validation = validateCodexClaudeCollaborationRound(round);

    expect(validation.readyToExecute).toBe(false);
    expect(validation.blockers).toContain('claude_report_not_4_8_max_mode');
    expect(validation.blockers).toContain('claude_report_not_4_8_model');
    expect(validation.blockers).toContain('claude_report_not_max_effort');
  });

  it('writes redacted round artifacts that can be validated again', () => {
    const root = makeRoot();
    const round = createCodexClaudeCollaborationRound({
      roundId: 'unit-round',
      task: '协作协议',
      sharedEvidence,
      codexPlan: `${codexPlan}\nOPENAI_API_KEY=sk-unit-test-secret-should-redact`,
      claudePlan,
      codexReviewOfClaude: codexReview,
      claudeReviewOfCodex: claudeReview,
      challengeLog,
      agentReports,
      synthesis,
      status: 'ready_to_execute',
      codexAgreement: 'agree',
      claudeAgreement: 'agree',
      codexAgreementRationale,
      claudeAgreementRationale,
      codexWork: ['写代码'],
      claudeWork: ['复核'],
      readinessCriteria,
    });

    const result = writeCodexClaudeCollaborationRound({ rootDir: root, round });
    const payload = JSON.parse(readFileSync(join(root, result.roundRef), 'utf8'));
    const markdown = readFileSync(join(root, result.markdownRef), 'utf8');

    expect(result.readyToExecute).toBe(true);
    expect(payload.validation.readyToExecute).toBe(true);
    expect(JSON.stringify(payload)).not.toContain('sk-unit-test-secret');
    expect(markdown).toContain('Codex + Claude Collaboration Round');
    expect(markdown).toContain('Shared Evidence');
    expect(markdown).toContain('Challenge Log');
    expect(markdown).toContain('Agent Reports');
  });

  it('documents the protocol checklist with independent plan and mutual review phases', () => {
    const checklist = buildCodexClaudeProtocolChecklist({ task: 'Neo task' });

    expect(checklist).toContain('shared evidence pack');
    expect(checklist).toContain('Claude writes an independent plan');
    expect(checklist).toContain('Execution starts only when both decisions are agree');
  });
});
