import { describe, it, expect } from 'vitest';
import { runAssertion, runAssertions } from '../../src/skills/learned/assertion.js';

describe('runAssertion', () => {
  describe('no assertion', () => {
    it('returns pass=true when assertion is null', () => {
      expect(runAssertion('hello', null)).toEqual({ pass: true, reason: 'no assertion' });
    });
    it('returns pass=true when assertion has no type', () => {
      expect(runAssertion('hello', {})).toEqual({ pass: true, reason: 'no assertion' });
    });
  });

  describe('contains', () => {
    it('passes when text includes value', () => {
      expect(runAssertion('hello world', { type: 'contains', value: 'world' }))
        .toEqual({ pass: true, reason: 'ok' });
    });
    it('fails when text does not include value', () => {
      const r = runAssertion('hello', { type: 'contains', value: 'world' });
      expect(r.pass).toBe(false);
      expect(r.reason).toContain('缺');
      expect(r.reason).toContain('world');
    });
  });

  describe('not_contains', () => {
    it('passes when text does not include value', () => {
      expect(runAssertion('hello', { type: 'not_contains', value: 'world' }))
        .toEqual({ pass: true, reason: 'ok' });
    });
    it('fails when text includes value', () => {
      const r = runAssertion('hello world', { type: 'not_contains', value: 'world' });
      expect(r.pass).toBe(false);
      expect(r.reason).toContain('含禁词');
      expect(r.reason).toContain('world');
    });
  });

  describe('min_length', () => {
    it('passes when length >= value', () => {
      expect(runAssertion('hello', { type: 'min_length', value: 3 }).pass).toBe(true);
    });
    it('passes at exact length boundary', () => {
      expect(runAssertion('hello', { type: 'min_length', value: 5 }).pass).toBe(true);
    });
    it('fails when length < value', () => {
      const r = runAssertion('hi', { type: 'min_length', value: 100 });
      expect(r.pass).toBe(false);
      expect(r.reason).toContain('len=2');
      expect(r.reason).toContain('< 100');
    });
  });

  describe('max_length', () => {
    it('passes when length <= value', () => {
      expect(runAssertion('hi', { type: 'max_length', value: 100 }).pass).toBe(true);
    });
    it('passes at exact length boundary', () => {
      expect(runAssertion('hello', { type: 'max_length', value: 5 }).pass).toBe(true);
    });
    it('fails when length > value', () => {
      const r = runAssertion('hello world', { type: 'max_length', value: 5 });
      expect(r.pass).toBe(false);
      expect(r.reason).toContain('len=11');
      expect(r.reason).toContain('> 5');
    });
  });

  describe('json_valid', () => {
    it('passes for a valid JSON object', () => {
      expect(runAssertion('{"a":1}', { type: 'json_valid' }))
        .toEqual({ pass: true, reason: 'json ok' });
    });
    it('passes for a valid JSON array', () => {
      expect(runAssertion('[1,2,3]', { type: 'json_valid' }))
        .toEqual({ pass: true, reason: 'json ok' });
    });
    it('fails for malformed JSON', () => {
      const r = runAssertion('not json', { type: 'json_valid' });
      expect(r.pass).toBe(false);
      expect(r.reason).toContain('json parse');
    });
  });

  describe('regex', () => {
    it('passes when pattern matches', () => {
      expect(runAssertion('Hello', { type: 'regex', value: '^[A-Z]' }))
        .toEqual({ pass: true, reason: 'regex match' });
    });
    it('fails when pattern does not match', () => {
      expect(runAssertion('hello', { type: 'regex', value: '^[A-Z]' }))
        .toEqual({ pass: false, reason: 'regex no match' });
    });
    it('respects provided flags', () => {
      const r = runAssertion('HELLO', { type: 'regex', value: '^[a-z]', flags: 'i' });
      expect(r.pass).toBe(true);
    });
    it('returns invalid regex for malformed pattern', () => {
      const r = runAssertion('hello', { type: 'regex', value: '[invalid(' });
      expect(r.pass).toBe(false);
      expect(r.reason).toBe('invalid regex');
    });
  });

  describe('json_path', () => {
    it('passes when path equals expect', () => {
      const r = runAssertion('{"data":{"x":1}}', { type: 'json_path', path: 'data.x', expect: 1 });
      expect(r.pass).toBe(true);
      expect(r.reason).toBe('json path match');
    });
    it('handles deeply nested paths', () => {
      const r = runAssertion('{"a":{"b":{"c":"v"}}}', { type: 'json_path', path: 'a.b.c', expect: 'v' });
      expect(r.pass).toBe(true);
    });
    it('fails when path value differs', () => {
      const r = runAssertion('{"x":2}', { type: 'json_path', path: 'x', expect: 1 });
      expect(r.pass).toBe(false);
      expect(r.reason).toContain('x');
      expect(r.reason).toContain('2');
    });
    it('fails when intermediate path is missing', () => {
      const r = runAssertion('{"a":1}', { type: 'json_path', path: 'b.c', expect: 1 });
      expect(r.pass).toBe(false);
    });
    it('fails when output is not valid JSON', () => {
      const r = runAssertion('not json', { type: 'json_path', path: 'x', expect: 1 });
      expect(r.pass).toBe(false);
      expect(r.reason).toContain('json path err');
    });
  });

  describe('unknown type', () => {
    it('fails with unknown assertion type message', () => {
      const r = runAssertion('hello', { type: 'totally_made_up' });
      expect(r.pass).toBe(false);
      expect(r.reason).toContain('unknown assertion type');
      expect(r.reason).toContain('totally_made_up');
    });
  });

  describe('output coercion', () => {
    it('treats null output as empty string', () => {
      const r = runAssertion(null, { type: 'contains', value: 'x' });
      expect(r.pass).toBe(false);
    });
    it('treats undefined output as empty string', () => {
      const r = runAssertion(undefined, { type: 'min_length', value: 1 });
      expect(r.pass).toBe(false);
    });
    it('coerces numeric output to string', () => {
      const r = runAssertion(12345, { type: 'contains', value: '234' });
      expect(r.pass).toBe(true);
    });
  });
});

describe('runAssertions', () => {
  it('returns allPass=true for an empty assertion list', () => {
    const r = runAssertions('hello', []);
    expect(r.allPass).toBe(true);
    expect(r.failed).toEqual([]);
    expect(r.results).toEqual([]);
  });

  it('defaults missing assertions arg to empty array', () => {
    const r = runAssertions('hello');
    expect(r.allPass).toBe(true);
    expect(r.results).toEqual([]);
  });

  it('returns allPass=true when every assertion passes', () => {
    const r = runAssertions('hello world', [
      { type: 'contains', value: 'hello' },
      { type: 'min_length', value: 3 },
      { type: 'not_contains', value: 'banana' },
    ]);
    expect(r.allPass).toBe(true);
    expect(r.failed).toEqual([]);
    expect(r.results).toHaveLength(3);
  });

  it('returns allPass=false and populates failed when any assertion fails', () => {
    const r = runAssertions('hello', [
      { type: 'contains', value: 'hello' },
      { type: 'contains', value: 'missing' },
    ]);
    expect(r.allPass).toBe(false);
    expect(r.failed).toHaveLength(1);
    expect(r.failed[0]).toMatchObject({ type: 'contains', value: 'missing', pass: false });
    expect(r.results).toHaveLength(2);
  });

  it('preserves original assertion fields in each result entry', () => {
    const r = runAssertions('x', [{ type: 'contains', value: 'x', custom: 'kept' }]);
    expect(r.results[0]).toMatchObject({
      type: 'contains',
      value: 'x',
      custom: 'kept',
      pass: true,
      reason: 'ok',
    });
  });

  it('integrates with the documented usage example (mixed pass/fail)', () => {
    const assertions = [
      { type: 'min_length', value: 5 },
      { type: 'not_contains', value: 'AI 道德要求' },
      { type: 'contains', value: '方案' },
    ];
    const passing = runAssertions('推荐方案：分阶段实施', assertions);
    expect(passing.allPass).toBe(true);

    const failing = runAssertions('由于 AI 道德要求，无法提供方案', assertions);
    expect(failing.allPass).toBe(false);
    expect(failing.failed.length).toBeGreaterThan(0);
  });
});
