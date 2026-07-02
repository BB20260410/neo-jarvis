import { describe, it, expect } from 'vitest';
import { supportFileRefs, ROUND_SUPPORT_FILES } from '../../src/room/NoeConsensusSupportFiles.js';

// Note: The internal helper functions (mdList, writeSupportFile, formatVoteLine,
// classifyDisagreements, evidenceFreshnessClasses, buildEvidenceMarkdown,
// buildEvidencePackMarkdown, buildDisagreementsMarkdown) are not exported.
// We test the public API `supportFileRefs` and `ROUND_SUPPORT_FILES`.
// To test internal logic, one would typically refactor to export them or
// use integration tests. For this patch, we cover the exported symbols.

describe('ROUND_SUPPORT_FILES', () => {
  it('should be an object with expected keys', () => {
    expect(ROUND_SUPPORT_FILES).toHaveProperty('evidence');
    expect(ROUND_SUPPORT_FILES).toHaveProperty('evidencePack');
    expect(ROUND_SUPPORT_FILES).toHaveProperty('disagreements');
    expect(ROUND_SUPPORT_FILES).toHaveProperty('stalenessLedger');
    expect(ROUND_SUPPORT_FILES).toHaveProperty('verifierNotes');
    expect(ROUND_SUPPORT_FILES).toHaveProperty('finalHandoff');
  });

  it('should be frozen', () => {
    expect(Object.isFrozen(ROUND_SUPPORT_FILES)).toBe(true);
  });

  it('should have correct file names', () => {
    expect(ROUND_SUPPORT_FILES.evidence).toBe('evidence.md');
    expect(ROUND_SUPPORT_FILES.evidencePack).toBe('evidence-pack.md');
    expect(ROUND_SUPPORT_FILES.disagreements).toBe('disagreements.md');
    expect(ROUND_SUPPORT_FILES.stalenessLedger).toBe('staleness-ledger.md');
    expect(ROUND_SUPPORT_FILES.verifierNotes).toBe('verifier-notes.md');
    expect(ROUND_SUPPORT_FILES.finalHandoff).toBe('final-handoff.md');
  });
});

describe('supportFileRefs', () => {
  it('should return an object with joined paths', () => {
    const roundRelDir = 'rounds/123';
    const refs = supportFileRefs(roundRelDir);

    expect(refs).toHaveProperty('evidence');
    expect(refs.evidence).toBe('rounds/123/evidence.md');
    expect(refs.evidencePack).toBe('rounds/123/evidence-pack.md');
    expect(refs.disagreements).toBe('rounds/123/disagreements.md');
    expect(refs.stalenessLedger).toBe('rounds/123/staleness-ledger.md');
    expect(refs.verifierNotes).toBe('rounds/123/verifier-notes.md');
    expect(refs.finalHandoff).toBe('rounds/123/final-handoff.md');
  });

  it('should handle relative paths with subdirectories', () => {
    const roundRelDir = 'a/b/c';
    const refs = supportFileRefs(roundRelDir);
    expect(refs.evidence).toBe('a/b/c/evidence.md');
  });

  it('should handle empty string path', () => {
    const roundRelDir = '';
    const refs = supportFileRefs(roundRelDir);
    // join('', 'file.md') results in 'file.md' on most systems, but let's be safe
    // The implementation uses node:path join
    expect(refs.evidence).toBe('evidence.md');
  });
});
