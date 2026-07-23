import { describe, expect, it } from 'vitest';
import { collectUrlLikeValues, isAllowedLocalUrl, nonLocalUrls } from '../../scripts/lib/noe-local-url-safety.mjs';

describe('Noe P0 tool URL safety', () => {
  it('allows only localhost http URLs for browser MCP tool args', () => {
    expect(isAllowedLocalUrl('http://127.0.0.1:51835/')).toBe(true);
    expect(isAllowedLocalUrl('http://localhost:3000/')).toBe(true);
    expect(isAllowedLocalUrl('https://example.com/')).toBe(false);
    expect(isAllowedLocalUrl('//example.com/private')).toBe(false);
    expect(isAllowedLocalUrl('file:///tmp/demo.html')).toBe(false);
  });

  it('collects nested URL-like values and returns external blockers', () => {
    const input = {
      url: 'http://127.0.0.1:1/',
      nested: [{ href: 'https://example.com/private' }],
      text: 'not a url',
    };
    expect(collectUrlLikeValues(input)).toEqual([
      'http://127.0.0.1:1/',
      'https://example.com/private',
    ]);
    expect(nonLocalUrls(input)).toEqual([
      'https://example.com/private',
    ]);
  });
});
