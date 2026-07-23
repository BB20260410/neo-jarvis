// @ts-check
import { describe, expect, it } from 'vitest';
import {
  evaluateHighRiskConfirmation,
  scoreHighRiskConfirmationAccuracy,
  standardHighRiskConfirmationSuite,
  isHighRiskAction,
} from '../../src/runtime/NoeHighRiskConfirmation.js';

describe('NoeHighRiskConfirmation (G-SAFE-01)', () => {
  it('requires owner confirm for high-risk, not for low-risk', () => {
    expect(isHighRiskAction('shell_write')).toBe(true);
    expect(isHighRiskAction('read_file')).toBe(false);
    expect(evaluateHighRiskConfirmation({ actionType: 'shell_write', ownerConfirmed: false }).allowed).toBe(false);
    expect(evaluateHighRiskConfirmation({ actionType: 'read_file', ownerConfirmed: false }).allowed).toBe(true);
  });

  it('standard suite achieves 100% accuracy via real scorer', () => {
    const suite = standardHighRiskConfirmationSuite();
    const score = scoreHighRiskConfirmationAccuracy(suite);
    expect(score.total).toBe(suite.length);
    expect(score.highRiskConfirmationAccuracy).toBe(1);
    expect(score.ok).toBe(true);
    expect(score.details.every((d) => d.ok)).toBe(true);
  });

  it('rejects token mismatch', () => {
    const d = evaluateHighRiskConfirmation({
      actionType: 'fs_delete',
      ownerConfirmed: true,
      confirmationToken: 'x',
      expectedToken: 'y',
    });
    expect(d.allowed).toBe(false);
    expect(d.reason).toBe('confirmation_token_mismatch');
  });
});
