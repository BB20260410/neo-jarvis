import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('Noe social inbound owner-token guard', () => {
  it('allows only provider callback endpoints through the global api guard', () => {
    const server = readFileSync(new URL('../../server.js', import.meta.url), 'utf8');
    expect(server).toContain('/api/noe/social-inbound/{wechat-official,wecom,feishu}');
    expect(server).toContain('/^\\/api\\/noe\\/social-inbound\\/(wechat-official|wecom|feishu)$/');
    expect(server).not.toContain('social-inbound/status) return true');
  });
});
