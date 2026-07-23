// @ts-check
import { describe, it, expect } from 'vitest';
import { extractUrls, createLinkUnderstanding } from '../../src/research/NoeLinkUnderstanding.js';

describe('extractUrls', () => {
  it('提取 http(s) URL', () => {
    expect(extractUrls('看 https://example.com/a 和 http://b.org/x')).toEqual(['https://example.com/a', 'http://b.org/x']);
  });
  it('去重（大小写不敏感）', () => {
    expect(extractUrls('https://a.com https://A.com')).toEqual(['https://a.com']);
  });
  it('去尾部中英文标点 + 中文引号不吃进 URL', () => {
    expect(extractUrls('见 https://example.com/page。')).toEqual(['https://example.com/page']);
    expect(extractUrls('(https://example.com/x)')).toEqual(['https://example.com/x']);
    expect(extractUrls('https://example.com/y，继续')).toEqual(['https://example.com/y']);
    expect(extractUrls('“https://example.com/z”')).toEqual(['https://example.com/z']); // 中文引号不吃进 hostname(codex 复核)
  });
  it('限数量', () => {
    expect(extractUrls('https://a.com https://b.com https://c.com https://d.com', { max: 2 })).toHaveLength(2);
  });
  it('无 URL 返回空', () => {
    expect(extractUrls('没有链接的文本')).toEqual([]);
    expect(extractUrls('')).toEqual([]);
  });
});

describe('createLinkUnderstanding', () => {
  it('需要注入 fetchContent', () => {
    expect(() => createLinkUnderstanding({})).toThrow(/fetchContent/);
  });
  it('检测 URL → 抓取 → 生成 <link-context> 摘要块', async () => {
    const fetchContent = async (url) => ({ ok: true, text: `正文 of ${url}` });
    const lu = createLinkUnderstanding({ fetchContent });
    const r = await lu.understand('看这个 https://example.com/article 很好');
    expect(r.urls).toEqual(['https://example.com/article']);
    expect(r.results[0].ok).toBe(true);
    expect(r.contextBlock).toContain('<link-context');
    expect(r.contextBlock).toContain('不可信'); // 间接注入防护：标 untrusted(codex 复核)
    expect(r.contextBlock).toContain('绝不执行');
    expect(r.contextBlock).toContain('https://example.com/article');
    expect(r.contextBlock).toContain('正文 of');
  });
  it('无 URL → 零成本跳过（空 contextBlock）', async () => {
    const fetchContent = async () => ({ ok: true, text: 'x' });
    const lu = createLinkUnderstanding({ fetchContent });
    const r = await lu.understand('没有链接');
    expect(r.contextBlock).toBe('');
    expect(r.urls).toEqual([]);
  });
  it('抓取失败（如 SSRF 拦截）→ 记录但不注入', async () => {
    const fetchContent = async () => ({ ok: false, error: 'SSRF 拦截' });
    const lu = createLinkUnderstanding({ fetchContent });
    const r = await lu.understand('https://internal.evil/');
    expect(r.results[0].ok).toBe(false);
    expect(r.contextBlock).toBe(''); // 无成功抓取 → 不注入
  });
  it('fetchContent 抛错 → 捕获不崩', async () => {
    const fetchContent = async () => { throw new Error('boom'); };
    const lu = createLinkUnderstanding({ fetchContent });
    const r = await lu.understand('https://x.com/');
    expect(r.results[0].ok).toBe(false);
    expect(r.results[0].error).toMatch(/boom/);
  });
  it('限抓取数量 maxLinks（防刷屏滥用）', async () => {
    let calls = 0;
    const fetchContent = async () => { calls += 1; return { ok: true, text: 'x' }; };
    const lu = createLinkUnderstanding({ fetchContent, maxLinks: 2 });
    await lu.understand('https://a.com https://b.com https://c.com');
    expect(calls).toBe(2);
  });
  it('注入前对抓回正文脱敏（防页面里的密钥样式文本进上下文）', async () => {
    const fetchContent = async () => ({ ok: true, text: 'PAGE_SECRET_TOKEN' });
    const redact = (t) => t.replace('PAGE_SECRET_TOKEN', '[redacted]');
    const lu = createLinkUnderstanding({ fetchContent, redact });
    const r = await lu.understand('https://x.com/');
    expect(r.contextBlock).toContain('[redacted]');
    expect(r.contextBlock).not.toContain('PAGE_SECRET_TOKEN');
  });
});
