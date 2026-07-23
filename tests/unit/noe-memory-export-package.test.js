// @ts-check
import { describe, expect, it } from 'vitest';
import {
  buildMemoryExportPackage,
  memoryExportPassesSecretScan,
  scrubSecretsFromText,
} from '../../src/runtime/NoeMemoryExportPackage.js';

describe('NoeMemoryExportPackage', () => {
  it('exports non-empty package for fixture entries', () => {
    const pkg = buildMemoryExportPackage([
      { id: 'm1', title: '时区', body: 'Asia/Shanghai', tags: ['profile'] },
      { id: 'm2', title: '端口', body: '51835', tags: ['neo'] },
      { id: 'hidden', title: 'no', body: 'x', hidden: true },
    ]);
    expect(pkg.count).toBe(2);
    expect(pkg.items.map((i) => i.id)).toEqual(['m1', 'm2']);
    expect(pkg.json).toContain('Asia/Shanghai');
    expect(pkg.markdown).toContain('时区');
    expect(pkg.json).toContain('51835');
  });

  it('scrubs secrets and passes secret scan', () => {
    const pkg = buildMemoryExportPackage([
      {
        id: 'bad',
        title: 'leak',
        body: 'key=sk-abcdefghijklmnopqrstuvwxyz012345 and OPENAI_API_KEY=sk-xyzabc1234567890abcd',
      },
    ]);
    expect(pkg.json).not.toMatch(/sk-abcdefghijklmnopqrstuvwxyz012345/);
    expect(memoryExportPassesSecretScan(pkg.json)).toBe(true);
    expect(memoryExportPassesSecretScan(pkg.markdown)).toBe(true);
    expect(scrubSecretsFromText('Bearer abcdefghijklmnopqr')).toContain('[REDACTED]');
  });
});
