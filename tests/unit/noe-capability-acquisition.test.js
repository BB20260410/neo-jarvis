import { describe, it, expect } from 'vitest';
import { createNoeCapabilityAcquisition } from '../../src/capabilities/NoeCapabilityAcquisition.js';

// ③ 能力自举搜索+评估层（只读、安全）。验 Neo 能搜到候选 + 安全选型 + 拒不可信源。

function mockWebSearch(hits) {
  return { search: async () => hits };
}

describe('NoeCapabilityAcquisition — 搜索能力候选', () => {
  it('从搜索结果提取 npm 包 + github MCP 候选，过滤无关链接', async () => {
    const ca = createNoeCapabilityAcquisition({
      webSearch: mockWebSearch([
        { title: 'cool-tool', link: 'https://www.npmjs.com/package/cool-tool', snippet: 'a handy tool' },
        { title: 'mcp server X', link: 'https://github.com/org/mcp-x', snippet: 'MCP server for X' },
        { title: '某博客', link: 'https://example.com/blog', snippet: '无关内容' },
      ]),
    });
    const r = await ca.searchCapability({ need: 'pdf 解析', kind: 'any' });
    expect(r.ok).toBe(true);
    const npm = r.candidates.find((c) => c.type === 'npm');
    const mcp = r.candidates.find((c) => c.type === 'mcp_or_repo');
    expect(npm?.name).toBe('cool-tool');
    expect(mcp?.name).toBe('org/mcp-x');
    expect(r.candidates.find((c) => c.url?.includes('example.com'))).toBeUndefined();
  });

  it('缺 need → error', async () => {
    const ca = createNoeCapabilityAcquisition({ webSearch: mockWebSearch([]) });
    expect((await ca.searchCapability({ need: '' })).error).toBe('need_required');
  });

  it('无 webSearch → web_search_unavailable（不硬崩）', async () => {
    const ca = createNoeCapabilityAcquisition({});
    expect((await ca.searchCapability({ need: 'x' })).error).toBe('web_search_unavailable');
  });
});

describe('NoeCapabilityAcquisition — 安全评估（源白名单 + 包名合法性）', () => {
  const ca = createNoeCapabilityAcquisition({});

  it('合法 npm 包（npmjs 源 + 合法名）→ safe', () => {
    expect(ca.assessCandidate({ type: 'npm', name: '@mozilla/readability', source: 'npmjs.com' }).safe).toBe(true);
  });

  it('非法包名 → invalid_npm_name', () => {
    expect(ca.assessCandidate({ type: 'npm', name: '../etc/passwd', source: 'npmjs.com' }).reasons).toContain('invalid_npm_name');
  });

  it('不可信源 → untrusted_source', () => {
    expect(ca.assessCandidate({ type: 'npm', name: 'x', source: 'evil.com' }).reasons).toContain('untrusted_source');
  });

  it('不支持类型 → unsupported_type', () => {
    expect(ca.assessCandidate({ type: 'binary', name: 'x' }).reasons.some((r) => r.startsWith('unsupported_type'))).toBe(true);
  });
});

describe('NoeCapabilityAcquisition — 获取计划', () => {
  const ca = createNoeCapabilityAcquisition({});

  it('合法候选 → plan（installAction + 需授权 + 需沙箱验证）', () => {
    const p = ca.planAcquisition({ type: 'npm', name: 'turndown', source: 'npmjs.com', installSpec: 'turndown' });
    expect(p.ok).toBe(true);
    expect(p.capability.installAction).toBe('npm_install');
    expect(p.requiresOwnerOrStandingGrant).toBe(true);
    expect(p.sandboxVerifyRequired).toBe(true);
  });

  it('不安全候选 → 不出 plan（errors）', () => {
    const p = ca.planAcquisition({ type: 'npm', name: 'x', source: 'evil.com' });
    expect(p.ok).toBe(false);
    expect(p.errors).toContain('untrusted_source');
  });
});
