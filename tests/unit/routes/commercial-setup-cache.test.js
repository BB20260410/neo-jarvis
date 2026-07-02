import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const SRC = readFileSync(new URL('../../../src/server/routes/commercial-setup.js', import.meta.url), 'utf8');

describe('commercial setup status cache', () => {
  it('uses a short TTL cache for commercial status GET endpoints', () => {
    expect(SRC).toContain('const COMMERCIAL_STATUS_TTL_MS = 5000');
    expect(SRC).toContain('function getCommercialStatusCached');
    expect(SRC).toContain('commercialStatusCache.value');
    expect(SRC).toContain('...getCommercialStatusCached()');
    expect(SRC).toContain('const s = getCommercialStatusCached();');
  });
});
