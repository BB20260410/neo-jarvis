import { describe, it, expect } from 'vitest';
import { diff, diffAttempts } from '../../src/room/learned/squad-diff-preview.js';

describe('diff (squad-diff-preview)', () => {
  it('returns zero added/removed for identical input', () => {
    const result = diff('a\nb\nc', 'a\nb\nc');
    expect(result.added).toBe(0);
    expect(result.removed).toBe(0);
  });

  it('treats null/undefined before as empty string', () => {
    const result = diff(null, 'a\nb');
    expect(result.added).toBe(2);
    expect(result.removed).toBe(1);
    expect(result.unified).toContain('+a');
    expect(result.unified).toContain('+b');
  });

  it('treats null/undefined after as empty string', () => {
    const result = diff('a\nb', null);
    expect(result.removed).toBe(2);
    expect(result.added).toBe(1);
    expect(result.unified).toContain('-a');
    expect(result.unified).toContain('-b');
  });

  it('handles both null/undefined without throwing', () => {
    const result = diff(undefined, undefined);
    expect(result.added).toBe(0);
    expect(result.removed).toBe(0);
    expect(typeof result.unified).toBe('string');
  });

  it('detects pure addition at the end', () => {
    const result = diff('a\nb', 'a\nb\nc');
    expect(result.added).toBe(1);
    expect(result.removed).toBe(0);
    expect(result.unified).toContain('+c');
  });

  it('detects pure removal at the end', () => {
    const result = diff('a\nb\nc', 'a\nb');
    expect(result.removed).toBe(1);
    expect(result.added).toBe(0);
    expect(result.unified).toContain('-c');
  });

  it('detects a change in the middle and keeps surrounding context', () => {
    const result = diff('a\nb\nc', 'a\nX\nc');
    expect(result.added).toBe(1);
    expect(result.removed).toBe(1);
    expect(result.unified).toContain(' a');
    expect(result.unified).toContain('-b');
    expect(result.unified).toContain('+X');
    expect(result.unified).toContain(' c');
  });

  it('returns unified as a string and added/removed as numbers', () => {
    const result = diff('a', 'b');
    expect(typeof result.unified).toBe('string');
    expect(typeof result.added).toBe('number');
    expect(typeof result.removed).toBe('number');
    expect(result.unified).toBe('-a\n+b');
  });
});

describe('diffAttempts (squad-diff-preview)', () => {
  it('diffs content from two attempts that have .content fields', () => {
    const prev = { content: 'a\nb' };
    const cur = { content: 'a\nX' };
    const result = diffAttempts(prev, cur);
    expect(result.added).toBe(1);
    expect(result.removed).toBe(1);
    expect(result.unified).toContain('-b');
    expect(result.unified).toContain('+X');
  });

  it('handles a null prev attempt without throwing', () => {
    const result = diffAttempts(null, { content: 'hello' });
    expect(typeof result.added).toBe('number');
    expect(typeof result.removed).toBe('number');
    expect(result.unified).toContain('+hello');
  });

  it('handles an undefined cur attempt without throwing', () => {
    const result = diffAttempts({ content: 'hello' }, undefined);
    expect(typeof result.added).toBe('number');
    expect(typeof result.removed).toBe('number');
    expect(result.unified).toContain('-hello');
  });

  it('treats attempts missing .content as empty', () => {
    const result = diffAttempts({}, {});
    expect(result.added).toBe(0);
    expect(result.removed).toBe(0);
  });
});
