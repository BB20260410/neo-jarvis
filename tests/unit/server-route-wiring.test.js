import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('server route wiring', () => {
  it('passes roomAdapterPool into cross-verify start routes', () => {
    const source = readFileSync(join(process.cwd(), 'server.js'), 'utf8');
    const match = source.match(/registerRoomStartRoutes\(app,\s*\{([\s\S]*?)\n\}\);/);
    expect(match?.[1]).toContain('roomAdapterPool');
  });
});
