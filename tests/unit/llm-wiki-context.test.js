import { describe, it, expect, vi } from 'vitest';
import {
  detectLLMWikiIntent,
  createLLMWikiContextProvider,
} from '../../src/knowledge/LLMWikiContext.js';

describe('detectLLMWikiIntent', () => {
  it('returns null for empty, whitespace, null, or undefined input', () => {
    expect(detectLLMWikiIntent('')).toBeNull();
    expect(detectLLMWikiIntent('   ')).toBeNull();
    expect(detectLLMWikiIntent(null)).toBeNull();
    expect(detectLLMWikiIntent(undefined)).toBeNull();
  });

  it('forces intent when opts.localWiki is true regardless of text', () => {
    const result = detectLLMWikiIntent('hello world', { localWiki: true });
    expect(result).toEqual({ query: 'hello world', forced: true });
  });

  it('returns null for pure web intent without local/wiki mention', () => {
    expect(detectLLMWikiIntent('今天有什么新闻')).toBeNull();
    expect(detectLLMWikiIntent('搜一下实时数据')).toBeNull();
    expect(detectLLMWikiIntent('查一下最新的新闻')).toBeNull();
  });

  it('still detects intent when web query also mentions local/wiki keyword', () => {
    const result = detectLLMWikiIntent('本地知识库有没有今天的更新');
    expect(result).not.toBeNull();
  });

  it('returns null when no local hint and no wiki topic', () => {
    expect(detectLLMWikiIntent('hello world')).toBeNull();
    expect(detectLLMWikiIntent('说点什么吧')).toBeNull();
  });

  it('matches English wiki topics like karpathy / obsidian / dataview / templater', () => {
    expect(detectLLMWikiIntent('聊聊 karpathy 的看法')).not.toBeNull();
    expect(detectLLMWikiIntent('obsidian 怎么用')).not.toBeNull();
    expect(detectLLMWikiIntent('dataview 查询语法')).not.toBeNull();
    expect(detectLLMWikiIntent('templater 模板')).not.toBeNull();
  });

  it('matches Chinese wiki topics like 知识库 / 复刻', () => {
    expect(detectLLMWikiIntent('知识库里有什么')).not.toBeNull();
    expect(detectLLMWikiIntent('本地复刻方案')).not.toBeNull();
  });

  it('matches local hints like 我们 / 之前 / 方案', () => {
    expect(detectLLMWikiIntent('我们之前怎么做')).not.toBeNull();
    expect(detectLLMWikiIntent('之前的结论')).not.toBeNull();
    expect(detectLLMWikiIntent('方案取舍经验')).not.toBeNull();
  });

  it('cleans trailing question particles 吗 / 呢', () => {
    const r1 = detectLLMWikiIntent('karpathy 吗');
    expect(r1.query).toBe('karpathy');
    const r2 = detectLLMWikiIntent('karpathy 呢');
    expect(r2.query).toBe('karpathy');
  });

  it('cleans 结论是什么 suffix', () => {
    const result = detectLLMWikiIntent('karpathy 结论是什么');
    expect(result.query).toBe('karpathy');
  });

  it('truncates cleaned query to 160 chars', () => {
    const long = 'karpathy ' + 'x'.repeat(300);
    const result = detectLLMWikiIntent(long);
    expect(result.query.length).toBeLessThanOrEqual(160);
  });
});

describe('createLLMWikiContextProvider', () => {
  it('returns ok result with empty hits when search returns nothing', async () => {
    const wikiSearch = vi.fn().mockResolvedValue({ hits: [] });
    const provider = createLLMWikiContextProvider({ wikiSearch });
    const result = await provider.lookup('foo');
    expect(wikiSearch).toHaveBeenCalledWith({
      root: 'knowledge/llm-wiki',
      query: 'foo',
      topK: 4,
    });
    expect(result.ok).toBe(true);
    expect(result.count).toBe(0);
    expect(result.hits).toEqual([]);
    expect(result.citations).toEqual([]);
    expect(result.reply).toContain('foo');
    expect(result.reply).toContain('没有找到');
  });

  it('formats reply with hit titles and snippets', async () => {
    const wikiSearch = vi.fn().mockResolvedValue({
      hits: [
        { title: 'A', file: 'a.md', snippet: 'snippet A' },
        { title: 'B', file: 'b.md', snippet: 'snippet B' },
      ],
    });
    const provider = createLLMWikiContextProvider({ wikiSearch });
    const result = await provider.lookup('foo');
    expect(result.count).toBe(2);
    expect(result.citations).toEqual([
      { index: 1, title: 'A', file: 'a.md', snippet: 'snippet A' },
      { index: 2, title: 'B', file: 'b.md', snippet: 'snippet B' },
    ]);
    expect(result.reply).toContain('命中 2 条');
    expect(result.reply).toContain('[1] A (a.md)');
    expect(result.reply).toContain('[2] B (b.md)');
    expect(result.reply).toContain('snippet A');
    expect(result.reply).toContain('snippet B');
  });

  it('shows only top 3 hits in reply while keeping full count', async () => {
    const hits = Array.from({ length: 5 }, (_, i) => ({
      title: `T${i}`,
      file: `f${i}.md`,
      snippet: `s${i}`,
    }));
    const wikiSearch = vi.fn().mockResolvedValue({ hits });
    const provider = createLLMWikiContextProvider({ wikiSearch });
    const result = await provider.lookup('q');
    expect(result.count).toBe(5);
    expect(result.reply).toContain('命中 5 条');
    expect(result.reply).toContain('T0');
    expect(result.reply).toContain('T2');
    expect(result.reply).not.toContain('T3');
  });

  it('caps topK at 10 even when caller passes a higher value', async () => {
    const wikiSearch = vi.fn().mockResolvedValue({ hits: [] });
    const provider = createLLMWikiContextProvider({ wikiSearch });
    await provider.lookup('q', { topK: 100 });
    expect(wikiSearch).toHaveBeenCalledWith(
      expect.objectContaining({ topK: 10 }),
    );
  });

  it('defaults topK to 4 when not provided', async () => {
    const wikiSearch = vi.fn().mockResolvedValue({ hits: [] });
    const provider = createLLMWikiContextProvider({ wikiSearch });
    await provider.lookup('q');
    expect(wikiSearch).toHaveBeenCalledWith(
      expect.objectContaining({ topK: 4 }),
    );
  });

  it('treats non-array result.hits as empty', async () => {
    const wikiSearch = vi.fn().mockResolvedValue({ hits: null });
    const provider = createLLMWikiContextProvider({ wikiSearch });
    const result = await provider.lookup('q');
    expect(result.count).toBe(0);
    expect(result.hits).toEqual([]);
    expect(result.citations).toEqual([]);
    expect(result.reply).toContain('没有找到');
  });

  it('uses default root knowledge/llm-wiki', async () => {
    const wikiSearch = vi.fn().mockResolvedValue({ hits: [] });
    const provider = createLLMWikiContextProvider({ wikiSearch });
    await provider.lookup('q');
    expect(wikiSearch).toHaveBeenCalledWith(
      expect.objectContaining({ root: 'knowledge/llm-wiki' }),
    );
  });

  it('respects custom root', async () => {
    const wikiSearch = vi.fn().mockResolvedValue({ hits: [] });
    const provider = createLLMWikiContextProvider({
      wikiSearch,
      root: 'custom/path',
    });
    await provider.lookup('q');
    expect(wikiSearch).toHaveBeenCalledWith(
      expect.objectContaining({ root: 'custom/path' }),
    );
  });

  it('truncates snippet in reply to 420 chars', async () => {
    const long = 'x'.repeat(500);
    const wikiSearch = vi.fn().mockResolvedValue({
      hits: [{ title: 'T', file: 'f.md', snippet: long }],
    });
    const provider = createLLMWikiContextProvider({ wikiSearch });
    const result = await provider.lookup('q');
    expect(result.reply).toContain('x'.repeat(420));
    expect(result.reply).not.toContain('x'.repeat(421));
  });

  it('omits snippet line when hit has no snippet', async () => {
    const wikiSearch = vi.fn().mockResolvedValue({
      hits: [{ title: 'T', file: 'f.md' }],
    });
    const provider = createLLMWikiContextProvider({ wikiSearch });
    const result = await provider.lookup('q');
    expect(result.reply).toContain('T (f.md)');
    expect(result.reply.split('\n\n')).toHaveLength(2);
  });
});
