// @ts-check
import { describe, it, expect } from 'vitest';
import { truncateMessagesByTokens } from '../../src/room/chatTruncation.js';

describe('truncateMessagesByTokens — boundary input protection', () => {
  describe('messages parameter', () => {
    it('returns [] for null messages', () => {
      expect(truncateMessagesByTokens(null, 100)).toEqual([]);
    });

    it('returns [] for undefined messages', () => {
      expect(truncateMessagesByTokens(undefined, 100)).toEqual([]);
    });

    it('returns [] for an empty array', () => {
      expect(truncateMessagesByTokens([], 100)).toEqual([]);
    });

    it('returns [] for non-array messages (string / number / object / boolean)', () => {
      expect(truncateMessagesByTokens('oops', 100)).toEqual([]);
      expect(truncateMessagesByTokens(42, 100)).toEqual([]);
      expect(truncateMessagesByTokens({ role: 'user', content: 'x' }, 100)).toEqual([]);
      expect(truncateMessagesByTokens(true, 100)).toEqual([]);
    });
  });

  describe('maxTokens (no explicit token budget)', () => {
    const messages = [{ role: 'user', content: 'Hello world' }];

    it('returns [] when maxTokens is undefined', () => {
      expect(truncateMessagesByTokens(messages, undefined)).toEqual([]);
    });

    it('returns [] when maxTokens is null', () => {
      expect(truncateMessagesByTokens(messages, null)).toEqual([]);
    });

    it('returns [] when maxTokens is NaN', () => {
      expect(truncateMessagesByTokens(messages, NaN)).toEqual([]);
    });

    it('returns [] when maxTokens is ±Infinity', () => {
      expect(truncateMessagesByTokens(messages, Infinity)).toEqual([]);
      expect(truncateMessagesByTokens(messages, -Infinity)).toEqual([]);
    });

    it('returns [] when maxTokens is zero or negative', () => {
      expect(truncateMessagesByTokens(messages, 0)).toEqual([]);
      expect(truncateMessagesByTokens(messages, -1)).toEqual([]);
    });
  });

  describe('per-message safety', () => {
    it('skips non-object entries (null / undefined / primitives)', () => {
      const messages = [
        null,
        undefined,
        'string',
        42,
        true,
        { role: 'user', content: 'kept' },
      ];
      expect(truncateMessagesByTokens(messages, 1000)).toEqual([
        { role: 'user', content: 'kept' },
      ]);
    });

    it('skips messages with null / undefined / empty content', () => {
      const messages = [
        { role: 'user', content: null },
        { role: 'user', content: undefined },
        { role: 'user', content: '' },
        { role: 'user', content: 'valid' },
      ];
      expect(truncateMessagesByTokens(messages, 1000)).toEqual([
        { role: 'user', content: 'valid' },
      ]);
    });

    it('skips a single message whose token count exceeds maxTokens (default counter)', () => {
      // default counter: ceil('a'.repeat(1000).length / 2) = 500 tokens, > 100
      expect(truncateMessagesByTokens(
        [{ role: 'user', content: 'a'.repeat(1000) }],
        100,
      )).toEqual([]);
    });

    it('skips messages when custom tokenCounter throws', () => {
      const messages = [{ role: 'user', content: 'Hello' }];
      const counter = () => { throw new Error('boom'); };
      expect(truncateMessagesByTokens(messages, 100, counter)).toEqual([]);
    });

    it('skips messages when custom tokenCounter returns NaN / Infinity', () => {
      const messages = [{ role: 'user', content: 'Hello' }];
      expect(truncateMessagesByTokens(messages, 100, () => NaN)).toEqual([]);
      expect(truncateMessagesByTokens(messages, 100, () => Infinity)).toEqual([]);
    });

    it('skips messages when custom tokenCounter returns 0 or negative', () => {
      const messages = [{ role: 'user', content: 'Hello' }];
      expect(truncateMessagesByTokens(messages, 100, () => 0)).toEqual([]);
      expect(truncateMessagesByTokens(messages, 100, () => -1)).toEqual([]);
    });
  });

  describe('happy path (protection does not over-trigger)', () => {
    it('keeps valid messages from newest to oldest within budget', () => {
      const messages = [
        { role: 'user', content: 'A' },     // 1 token
        { role: 'user', content: 'BB' },    // 1 token
        { role: 'user', content: 'CCC' },   // 2 tokens
        { role: 'user', content: 'DDDD' },  // 2 tokens
      ];
      // maxTokens=4; from newest: DDDD(2)→2 left, CCC(2)→0 left, BB(1)>0 break
      expect(truncateMessagesByTokens(messages, 4)).toEqual([
        { role: 'user', content: 'CCC' },
        { role: 'user', content: 'DDDD' },
      ]);
    });
  });
});
