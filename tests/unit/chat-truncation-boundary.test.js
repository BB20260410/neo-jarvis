// @ts-check
import { describe, it, expect } from 'vitest';
import { truncateMessagesByTokens } from '../../src/room/chatTruncation.js';

// 锁定 truncateMessagesByTokens 对三类边界输入的安全处理：
//   1) 空数组 / null / undefined / 非数组 → 直接返回 []
//   2) content 为 null / undefined / 非字符串 / 空字符串 → 跳过该消息
//   3) 单条消息文本超过总预算（maxTokens）→ 跳过，不送入下游解析链路
// 这些边界守卫已经在 src/room/chatTruncation.js 里实现，本测试只负责钉死契约，
// 防止后续重构破坏"半截消息蒙混过签"的防护。

describe('truncateMessagesByTokens boundary safety', () => {
  describe('empty / nullish / non-array messages', () => {
    it('returns [] when messages is null', () => {
      expect(truncateMessagesByTokens(null, 100)).toEqual([]);
    });

    it('returns [] when messages is undefined', () => {
      expect(truncateMessagesByTokens(undefined, 100)).toEqual([]);
    });

    it('returns [] when messages is an empty array', () => {
      expect(truncateMessagesByTokens([], 100)).toEqual([]);
    });

    it('returns [] when messages is a non-array primitive', () => {
      expect(truncateMessagesByTokens('not-an-array', 100)).toEqual([]);
      expect(truncateMessagesByTokens(42, 100)).toEqual([]);
      expect(truncateMessagesByTokens(true, 100)).toEqual([]);
    });

    it('returns [] when messages is a plain object (not an array)', () => {
      expect(truncateMessagesByTokens({ role: 'user', content: 'hi' }, 100)).toEqual([]);
    });
  });

  describe('null / undefined / non-string content', () => {
    it('skips messages whose content is null', () => {
      const messages = [
        { role: 'user', content: null },
        { role: 'user', content: 'hello' },
      ];
      expect(truncateMessagesByTokens(messages, 100)).toEqual([
        { role: 'user', content: 'hello' },
      ]);
    });

    it('skips messages whose content is undefined', () => {
      const messages = [
        { role: 'user', content: undefined },
        { role: 'user', content: 'world' },
      ];
      expect(truncateMessagesByTokens(messages, 100)).toEqual([
        { role: 'user', content: 'world' },
      ]);
    });

    it('skips messages whose content is empty string', () => {
      const messages = [
        { role: 'user', content: '' },
        { role: 'user', content: 'kept' },
      ];
      expect(truncateMessagesByTokens(messages, 100)).toEqual([
        { role: 'user', content: 'kept' },
      ]);
    });

    it('skips messages whose content is not a string (number / boolean / object / array)', () => {
      const messages = [
        { role: 'user', content: 42 },
        { role: 'user', content: true },
        { role: 'user', content: false },
        { role: 'user', content: { nested: 'value' } },
        { role: 'user', content: [1, 2, 3] },
        { role: 'user', content: 'valid' },
      ];
      expect(truncateMessagesByTokens(messages, 100)).toEqual([
        { role: 'user', content: 'valid' },
      ]);
    });

    it('skips messages that are not objects (null / primitives in the array)', () => {
      const messages = [
        null,
        undefined,
        'string-msg',
        42,
        true,
        { role: 'user', content: 'kept' },
      ];
      expect(truncateMessagesByTokens(messages, 100)).toEqual([
        { role: 'user', content: 'kept' },
      ]);
    });
  });

  describe('single message whose token count exceeds total budget', () => {
    it('skips oversize message and keeps fitting neighbors (early-return path)', () => {
      // default tokenCounter = ceil(length / 2): 200 chars → 100 tokens, > maxTokens=50
      const longText = 'x'.repeat(200);
      const messages = [
        { role: 'user', content: longText },
        { role: 'assistant', content: 'short reply' },
      ];
      expect(truncateMessagesByTokens(messages, 50)).toEqual([
        { role: 'assistant', content: 'short reply' },
      ]);
    });

    it('returns [] when the only message exceeds the budget', () => {
      const longText = 'a'.repeat(400); // 200 tokens
      expect(
        truncateMessagesByTokens([{ role: 'user', content: longText }], 100),
      ).toEqual([]);
    });

    it('drops oversize message in the middle, preserves fitting tail (fallback path)', () => {
      const oversize = 'b'.repeat(400); // 200 tokens, exceeds maxTokens=80
      const messages = [
        { role: 'user', content: 'old' },
        { role: 'assistant', content: oversize },
        { role: 'user', content: 'recent' },
      ];
      const result = truncateMessagesByTokens(messages, 80);
      expect(result.find((m) => m.content === oversize)).toBeUndefined();
      expect(result[result.length - 1]).toEqual({ role: 'user', content: 'recent' });
    });

    it('skips oversize message even when reserveForResponse shrinks the budget further', () => {
      const oversize = 'c'.repeat(120); // 60 tokens, > budget(20)=20, but < maxTokens=100
      const messages = [
        { role: 'user', content: oversize },
        { role: 'assistant', content: 'ok' },
      ];
      const result = truncateMessagesByTokens(messages, 100, undefined, 80);
      // oversize 不应出现在结果里（fallback 会因为 tokens>remaining 而 break）
      expect(result.find((m) => m.content === oversize)).toBeUndefined();
    });
  });

  describe('tokenCounter failure resilience', () => {
    it('skips messages when custom tokenCounter throws', () => {
      const messages = [
        { role: 'user', content: 'bad' },
        { role: 'user', content: 'good' },
      ];
      const counter = (text) => {
        if (text === 'bad') throw new Error('boom');
        return 1;
      };
      expect(truncateMessagesByTokens(messages, 100, counter)).toEqual([
        { role: 'user', content: 'good' },
      ]);
    });

    it('skips messages when custom tokenCounter returns non-finite', () => {
      const messages = [
        { role: 'user', content: 'nan-text' },
        { role: 'user', content: 'finite' },
      ];
      const counter = (text) => (text === 'nan-text' ? NaN : 1);
      expect(truncateMessagesByTokens(messages, 100, counter)).toEqual([
        { role: 'user', content: 'finite' },
      ]);
    });

    it('skips messages when custom tokenCounter returns zero or negative', () => {
      const messages = [
        { role: 'user', content: 'zero' },
        { role: 'user', content: 'positive' },
      ];
      const counter = (text) => (text === 'zero' ? 0 : 5);
      expect(truncateMessagesByTokens(messages, 100, counter)).toEqual([
        { role: 'user', content: 'positive' },
      ]);
    });
  });

  describe('invalid maxTokens / reserveForResponse', () => {
    it('returns [] when maxTokens is NaN', () => {
      expect(truncateMessagesByTokens([{ role: 'user', content: 'hi' }], NaN)).toEqual([]);
    });

    it('returns [] when maxTokens is Infinity', () => {
      expect(truncateMessagesByTokens([{ role: 'user', content: 'hi' }], Infinity)).toEqual([]);
    });

    it('returns [] when maxTokens is zero or negative', () => {
      expect(truncateMessagesByTokens([{ role: 'user', content: 'hi' }], 0)).toEqual([]);
      expect(truncateMessagesByTokens([{ role: 'user', content: 'hi' }], -10)).toEqual([]);
    });

    it('returns [] when reserveForResponse drains the entire budget', () => {
      const messages = [{ role: 'user', content: 'hi' }];
      expect(truncateMessagesByTokens(messages, 50, undefined, 100)).toEqual([]);
    });
  });
});
