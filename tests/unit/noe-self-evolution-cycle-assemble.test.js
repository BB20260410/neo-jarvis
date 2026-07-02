import { describe, expect, it } from 'vitest';
import { postReviewFrom } from '../../scripts/noe-self-evolution-cycle-assemble.mjs';

describe('Noe self-evolution cycle assembler', () => {
  it('parses post-review decisions without converting unavailable into approval', () => {
    expect(postReviewFrom('m3:unavailable=output/noe-multimodel/r/m3.txt')).toMatchObject({
      model: 'm3',
      decision: 'unavailable',
      authority: 'suggestion_only',
      canWrite: false,
      rawOutputRef: 'output/noe-multimodel/r/m3.txt',
    });
  });

  it('keeps the historical model=rawOutputRef form as an approve review', () => {
    expect(postReviewFrom('gemini=output/noe-multimodel/r/gemini.txt')).toMatchObject({
      model: 'gemini',
      decision: 'approve',
      authority: 'advisory',
      canWrite: false,
      rawOutputRef: 'output/noe-multimodel/r/gemini.txt',
    });
  });
});
