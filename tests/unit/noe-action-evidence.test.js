import { describe, expect, it } from 'vitest';
import {
  buildNoeActionSemanticTrace,
  buildNoeActionEvidence,
  validateNoeActionEvidence,
} from '../../src/runtime/NoeActionEvidence.js';
import { buildClaimLinkNeedles, scoreCandidateClaimLink } from '../../src/cognition/NoeExpectationResolver.js';

describe('NoeActionEvidence', () => {
  it('builds redacted dry-run evidence with a stable hash', () => {
    const evidence = buildNoeActionEvidence({
      act: { id: 'act-1', action: 'noe.focus.review', title: '复盘', riskLevel: 'low' },
      permissionResult: { decision: 'allow', reason: 'ok' },
      contextSufficiency: { sufficient: true, blockers: [] },
      logRef: 'sqlite:events/1',
      refs: { plan: ['output/plan.md'] },
      notes: 'Authorization: Bearer fixture1',
    });

    expect(evidence.sha256).toHaveLength(64);
    expect(evidence.refs.plan).toEqual(['output/plan.md']);
    expect(JSON.stringify(evidence)).not.toContain('fixture1');
    expect(validateNoeActionEvidence(evidence).ok).toBe(true);
  });

  it('adds redacted semantic trace for future expectation alignment', () => {
    const trace = buildNoeActionSemanticTrace({
      act: { id: 'act-sem', action: 'noe.goal.execute', title: 'Settle delivery expectation' },
      input: {
        title: 'Settle delivery expectation',
        claim: 'owner expects delivery evidence to be visible',
        payload: {
          goalTitle: 'produce visible delivery evidence',
          goal: 'produce owner perceived delivery evidence',
          expectation: 'owner expects confirmed delivery sample',
          stepText: 'write readiness audit with delivery evidence',
          checkpoint: 'write readiness audit',
          token: 'fixture-token',
        },
      },
      executorResult: {
        ok: true,
        stdoutSummary: 'confirmed delivery evidence written',
        authorization: 'fixture-authorization',
      },
    });

    const text = JSON.stringify(trace);
    expect(trace.fingerprint).toMatch(/^[a-f0-9]{24}$/);
    expect(trace.goal.join(' ')).toContain('produce visible delivery evidence');
    expect(trace.expectation.join(' ')).toContain('owner expects delivery evidence to be visible');
    expect(trace.checkpoint.join(' ')).toContain('write readiness audit with delivery evidence');
    expect(trace.summary.join(' ')).toContain('owner expects confirmed delivery sample');
    expect(trace.summary.join(' ')).toContain('write readiness audit');
    expect(text).not.toContain('fixture-token');
    expect(text).not.toContain('fixture-authorization');
  });

  it('keeps saved act payload semantics when retry input is thin', () => {
    const claim = 'owner expects visible delivery evidence from the readiness checkpoint';
    const trace = buildNoeActionSemanticTrace({
      act: {
        id: 'act-retry-sem',
        action: 'noe.goal.execute',
        title: 'Retry approved delivery checkpoint',
        payload: {
          goalTitle: 'owner visible delivery evidence',
          expectedClaim: claim,
          checkpoint: 'readiness checkpoint writes delivery evidence',
          stepText: 'write readiness checkpoint with delivery evidence',
          token: 'fixture-token',
        },
      },
      input: { realExecute: true },
      executorResult: {
        ok: true,
        completed: true,
        result: 'completed',
        stdoutSummary: 'readiness checkpoint wrote visible delivery evidence',
      },
    });
    const payload = { ok: true, completed: true, status: 'completed', actionEvidence: { semanticTrace: trace } };
    const link = scoreCandidateClaimLink(payload, [...buildClaimLinkNeedles(claim)], 2);
    const text = JSON.stringify(trace);

    expect(trace.goal).toContain('owner visible delivery evidence');
    expect(trace.expectation).toContain(claim);
    expect(trace.checkpoint).toContain('readiness checkpoint writes delivery evidence');
    expect(link.semanticTraceLabel).toBe('linked');
    expect(link.semanticTraceCoverage).toBeGreaterThanOrEqual(0.25);
    expect(text).not.toContain('fixture-token');
  });

  it('fails validation when required runtime review or rollback evidence is missing', () => {
    const evidence = buildNoeActionEvidence({
      act: { id: 'act-2', action: 'file.write_text', title: '写文件', riskLevel: 'high' },
      permissionResult: { decision: 'allow', reason: 'approved' },
      contextSufficiency: { sufficient: true, blockers: [] },
      dryRunOnly: false,
    });
    const validation = validateNoeActionEvidence(evidence, {
      requireRuntime: true,
      requireReview: true,
      requireRollback: true,
    });

    expect(validation.ok).toBe(false);
    expect(validation.errors).toContain('runtime_evidence_required');
    expect(validation.errors).toContain('post_review_raw_output_required');
    expect(validation.errors).toContain('rollback_ref_required');
  });

  it('flags unmet context sufficiency', () => {
    const evidence = buildNoeActionEvidence({
      act: { id: 'act-3', action: 'noe.run', title: '执行', riskLevel: 'medium' },
      permissionResult: { decision: 'allow', reason: 'ok' },
      contextSufficiency: { sufficient: false, blockers: ['critical_context_missing'] },
    });

    expect(validateNoeActionEvidence(evidence).errors).toContain('context_sufficiency_not_met');
  });
});
