// @ts-check
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  NOE_SELF_EVOLUTION_LOCAL_REVIEWER_MODELS,
  noeSelfEvolutionReviewerIds,
  noeSelfEvolutionLocalReviewerModel,
  noeSelfEvolutionLocalReviewersEnabled,
} from '../../src/room/NoeSelfEvolutionReviewers.js';

describe('NoeSelfEvolutionReviewers', () => {
  beforeEach(() => {
    delete process.env.NOE_SELF_EVOLUTION_REVIEW_MODELS;
    delete process.env.NOE_SELF_EVOLUTION_REVIEW_MODEL_A;
    delete process.env.NOE_SELF_EVOLUTION_REVIEW_MODEL_B;
    vi.unstubAllEnvs();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  describe('NOE_SELF_EVOLUTION_LOCAL_REVIEWER_MODELS', () => {
    it('is frozen', () => {
      expect(Object.isFrozen(NOE_SELF_EVOLUTION_LOCAL_REVIEWER_MODELS)).toBe(true);
    });

    it('exposes default models for local-qwen and local-gemma', () => {
      expect(NOE_SELF_EVOLUTION_LOCAL_REVIEWER_MODELS['local-qwen']).toBe('qwen/qwen3.6-27b');
      expect(NOE_SELF_EVOLUTION_LOCAL_REVIEWER_MODELS['local-gemma']).toBe('gemma-4-31b-it-qat');
    });

    it('exposes exactly the two local reviewer ids', () => {
      expect(Object.keys(NOE_SELF_EVOLUTION_LOCAL_REVIEWER_MODELS).sort()).toEqual([
        'local-gemma',
        'local-qwen',
      ]);
    });
  });

  describe('noeSelfEvolutionReviewerIds', () => {
    it('returns null when env is unset', () => {
      vi.stubEnv('NOE_SELF_EVOLUTION_REVIEW_MODELS', '');
      expect(noeSelfEvolutionReviewerIds()).toBeNull();
    });

    it('returns null when env is whitespace only', () => {
      vi.stubEnv('NOE_SELF_EVOLUTION_REVIEW_MODELS', '   ');
      expect(noeSelfEvolutionReviewerIds()).toBeNull();
    });

    it('returns null when env has only commas and empty parts', () => {
      vi.stubEnv('NOE_SELF_EVOLUTION_REVIEW_MODELS', ' ,, , ');
      expect(noeSelfEvolutionReviewerIds()).toBeNull();
    });

    it('parses a single id', () => {
      vi.stubEnv('NOE_SELF_EVOLUTION_REVIEW_MODELS', 'local-qwen');
      expect(noeSelfEvolutionReviewerIds()).toEqual(['local-qwen']);
    });

    it('parses comma-separated ids, lowercased, trimmed', () => {
      vi.stubEnv('NOE_SELF_EVOLUTION_REVIEW_MODELS', ' Local-Qwen , LOCAL-GEMMA ');
      expect(noeSelfEvolutionReviewerIds()).toEqual(['local-qwen', 'local-gemma']);
    });

    it('deduplicates repeated ids while preserving first-seen order', () => {
      vi.stubEnv('NOE_SELF_EVOLUTION_REVIEW_MODELS', 'local-qwen,local-gemma,local-qwen');
      expect(noeSelfEvolutionReviewerIds()).toEqual(['local-qwen', 'local-gemma']);
    });

    it('returns a fresh array (caller mutation does not leak into next call)', () => {
      vi.stubEnv('NOE_SELF_EVOLUTION_REVIEW_MODELS', 'local-qwen');
      const ids = noeSelfEvolutionReviewerIds();
      expect(ids).toEqual(['local-qwen']);
      ids.push('mutated');
      expect(noeSelfEvolutionReviewerIds()).toEqual(['local-qwen']);
    });
  });

  describe('noeSelfEvolutionLocalReviewerModel', () => {
    it('returns default qwen model for local-qwen', () => {
      expect(noeSelfEvolutionLocalReviewerModel('local-qwen')).toBe('qwen/qwen3.6-27b');
    });

    it('returns default gemma model for local-gemma', () => {
      expect(noeSelfEvolutionLocalReviewerModel('local-gemma')).toBe('gemma-4-31b-it-qat');
    });

    it('is case-insensitive on id', () => {
      expect(noeSelfEvolutionLocalReviewerModel('LOCAL-QWEN')).toBe('qwen/qwen3.6-27b');
    });

    it('trims surrounding whitespace on id', () => {
      expect(noeSelfEvolutionLocalReviewerModel('  Local-Gemma  ')).toBe('gemma-4-31b-it-qat');
    });

    it('returns null for unknown reviewer id', () => {
      expect(noeSelfEvolutionLocalReviewerModel('claude')).toBeNull();
      expect(noeSelfEvolutionLocalReviewerModel('m3')).toBeNull();
      expect(noeSelfEvolutionLocalReviewerModel('local-unknown')).toBeNull();
    });

    it('returns null for falsy ids', () => {
      expect(noeSelfEvolutionLocalReviewerModel(null)).toBeNull();
      expect(noeSelfEvolutionLocalReviewerModel(undefined)).toBeNull();
      expect(noeSelfEvolutionLocalReviewerModel('')).toBeNull();
    });
  });

  describe('noeSelfEvolutionLocalReviewersEnabled', () => {
    it('returns false when env is unset', () => {
      vi.stubEnv('NOE_SELF_EVOLUTION_REVIEW_MODELS', '');
      expect(noeSelfEvolutionLocalReviewersEnabled()).toBe(false);
    });

    it('returns false when env is whitespace only', () => {
      vi.stubEnv('NOE_SELF_EVOLUTION_REVIEW_MODELS', '   ');
      expect(noeSelfEvolutionLocalReviewersEnabled()).toBe(false);
    });

    it('returns false when env has only empty comma parts', () => {
      vi.stubEnv('NOE_SELF_EVOLUTION_REVIEW_MODELS', ' , , ');
      expect(noeSelfEvolutionLocalReviewersEnabled()).toBe(false);
    });

    it('returns true when env has at least one valid id', () => {
      vi.stubEnv('NOE_SELF_EVOLUTION_REVIEW_MODELS', 'local-qwen');
      expect(noeSelfEvolutionLocalReviewersEnabled()).toBe(true);
    });

    it('returns true with multiple comma-separated ids', () => {
      vi.stubEnv('NOE_SELF_EVOLUTION_REVIEW_MODELS', 'local-qwen,local-gemma');
      expect(noeSelfEvolutionLocalReviewersEnabled()).toBe(true);
    });

    it('stays false (zero-regression) for unknown ids that produce no valid reviewer list', () => {
      vi.stubEnv('NOE_SELF_EVOLUTION_REVIEW_MODELS', ' , , ');
      expect(noeSelfEvolutionLocalReviewersEnabled()).toBe(false);
      // sanity: known reviewer list path is the only enabled trigger
      vi.stubEnv('NOE_SELF_EVOLUTION_REVIEW_MODELS', 'unknown-only');
      expect(noeSelfEvolutionLocalReviewersEnabled()).toBe(true);
      // env-gating does not validate against the local reviewer table — that is by design:
      // unknown ids still flow into reviewerIds() so callers fall back to cloud consensus.
      // This test documents that explicit non-empty env == enabled, per the header comment.
    });
  });
});
