import { describe, it, expect } from 'vitest';
import { memoryPolicyForProfile, rankProfileMemories } from '../../src/voice/MemoryPolicy.js';

describe('memoryPolicyForProfile', () => {
  it('uses default id and general mode when called with no profile', () => {
    const policy = memoryPolicyForProfile();
    expect(policy.id).toBe('default');
    expect(policy.mode).toBe('general');
    expect(policy.recallLimit).toBe(3);
    expect(policy.injectLimit).toBe(2);
    expect(policy.writeDialogue).toBe(true);
    expect(policy.dialogueConfidence).toBe(0.75);
    expect(policy.extractFacts).toBe(true);
    expect(policy.factConfidence).toBe(0.65);
  });

  it('accepts a valid id and mode and lowercases the id', () => {
    const policy = memoryPolicyForProfile({ id: 'Alice_01', mode: 'companion' });
    expect(policy.id).toBe('alice_01');
    expect(policy.mode).toBe('companion');
  });

  it('falls back to default id for invalid ids', () => {
    expect(memoryPolicyForProfile({ id: '123bad' }).id).toBe('default');
    expect(memoryPolicyForProfile({ id: 'with space' }).id).toBe('default');
    expect(memoryPolicyForProfile({ id: '' }).id).toBe('default');
    expect(memoryPolicyForProfile({ id: undefined }).id).toBe('default');
  });

  it('falls back to general mode for invalid modes', () => {
    expect(memoryPolicyForProfile({ mode: 'unknown' }).mode).toBe('general');
    expect(memoryPolicyForProfile({ mode: '' }).mode).toBe('general');
    expect(memoryPolicyForProfile({ mode: undefined }).mode).toBe('general');
  });

  it('applies companion mode overrides', () => {
    const policy = memoryPolicyForProfile({ mode: 'companion' });
    expect(policy.recallLimit).toBe(6);
    expect(policy.injectLimit).toBe(4);
    expect(policy.dialogueConfidence).toBe(0.9);
    expect(policy.factConfidence).toBe(0.75);
  });

  it('applies assistant mode overrides and disables writes/extracts', () => {
    const policy = memoryPolicyForProfile({ mode: 'assistant' });
    expect(policy.recallLimit).toBe(2);
    expect(policy.injectLimit).toBe(2);
    expect(policy.writeDialogue).toBe(false);
    expect(policy.extractFacts).toBe(false);
  });

  it('embeds profile and mode in tags and factTags', () => {
    const policy = memoryPolicyForProfile({ id: 'npc1', mode: 'companion' });
    expect(policy.tags).toEqual(
      expect.arrayContaining(['voice', 'dialogue', 'profile:npc1', 'mode:companion'])
    );
    expect(policy.factTags).toEqual(
      expect.arrayContaining(['fact', 'voice', 'profile:npc1', 'mode:companion'])
    );
  });
});

describe('rankProfileMemories', () => {
  it('returns an empty array when no items are given', () => {
    expect(rankProfileMemories([])).toEqual([]);
  });

  it('uses the default policy when none is supplied', () => {
    const profileItem = { id: 'p', tags: ['profile:default'] };
    const ranked = rankProfileMemories([profileItem]);
    expect(ranked).toEqual([profileItem]);
  });

  it('places profile-tagged items above mode-tagged items', () => {
    const policy = memoryPolicyForProfile({ id: 'p1', mode: 'general' });
    const modeItem = { id: 'mode', tags: ['mode:general'] };
    const profileItem = { id: 'profile', tags: ['profile:p1'] };
    const ranked = rankProfileMemories([modeItem, profileItem], policy);
    expect(ranked).toEqual([profileItem, modeItem]);
  });

  it('sums profile and mode tag scores for ranking', () => {
    const policy = memoryPolicyForProfile({ id: 'p1', mode: 'companion' });
    const both = { id: 'both', tags: ['profile:p1', 'mode:companion'] };
    const profileOnly = { id: 'profileOnly', tags: ['profile:p1'] };
    const modeOnly = { id: 'modeOnly', tags: ['mode:companion'] };
    const none = { id: 'none', tags: [] };
    const ranked = rankProfileMemories([none, modeOnly, profileOnly, both], policy);
    expect(ranked).toEqual([both, profileOnly, modeOnly, none]);
  });

  it('keeps original order for items with tied scores', () => {
    const policy = memoryPolicyForProfile({ id: 'p1', mode: 'general' });
    const a = { id: 'a', tags: ['profile:p1'] };
    const b = { id: 'b', tags: ['profile:p1'] };
    const ranked = rankProfileMemories([a, b], policy);
    expect(ranked).toEqual([a, b]);
  });

  it('treats items without a tags array as having no matching tags', () => {
    const policy = memoryPolicyForProfile({ id: 'p1', mode: 'general' });
    const noTags = { id: 'noTags' };
    const profile = { id: 'profile', tags: ['profile:p1'] };
    const ranked = rankProfileMemories([noTags, profile], policy);
    expect(ranked).toEqual([profile, noTags]);
  });

  it('ignores non-array tag values', () => {
    const policy = memoryPolicyForProfile({ id: 'p1', mode: 'general' });
    const badTags = { id: 'bad', tags: 'profile:p1' };
    const profile = { id: 'profile', tags: ['profile:p1'] };
    const ranked = rankProfileMemories([badTags, profile], policy);
    expect(ranked).toEqual([profile, badTags]);
  });
});
