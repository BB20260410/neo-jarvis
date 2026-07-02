import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const SRC = readFileSync(new URL('../../public/src/web/cognitive-attachments.js', import.meta.url), 'utf8');

describe('cognitive attachments visual size gate', () => {
  it('checks image and video byte limits before browser decode', () => {
    expect(SRC).toContain('const IMAGE_MAX_BYTES =');
    expect(SRC).toContain('const VIDEO_MAX_BYTES =');
    expect(SRC).toContain('function visualSizeLimit(file)');
    expect(SRC).toContain('if (visualLimit && item.size > visualLimit)');
    expect(SRC.indexOf('if (visualLimit && item.size > visualLimit)')).toBeLessThan(SRC.indexOf('Object.assign(item, await imagePayload(file))'));
    expect(SRC.indexOf('if (visualLimit && item.size > visualLimit)')).toBeLessThan(SRC.indexOf('Object.assign(item, await videoPayload(file))'));
  });
});
