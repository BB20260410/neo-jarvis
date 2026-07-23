// @ts-check
import { describe, expect, it } from 'vitest';
import {
  buildFileChangeDiffPreview,
  isRealDiffPreview,
} from '../../src/runtime/NoeFileChangeDiffPreview.js';

describe('NoeFileChangeDiffPreview', () => {
  it('builds real hunks for fixture before/after', () => {
    const preview = buildFileChangeDiffPreview({
      path: 'src/demo.js',
      before: 'const a = 1;\nconst b = 2;\n',
      after: 'const a = 1;\nconst b = 3;\nconst c = 4;\n',
    });
    expect(preview.path).toBe('src/demo.js');
    expect(preview.hasChanges).toBe(true);
    expect(preview.added + preview.removed).toBeGreaterThan(0);
    expect(preview.unified).toMatch(/[-+]/);
    expect(preview.hunks.length).toBeGreaterThan(0);
    expect(isRealDiffPreview(preview)).toBe(true);
    expect(preview.emptyStub).toBe(false);
  });

  it('handles empty identical content', () => {
    const preview = buildFileChangeDiffPreview({
      path: 'x.txt',
      before: 'same',
      after: 'same',
    });
    expect(preview.hasChanges).toBe(false);
    expect(preview.path).toBe('x.txt');
    expect(isRealDiffPreview(preview)).toBe(true);
  });
});
