// Odysseus 移植模块自测：WebSearch（搜索/抓页/SSRF/正文提取）+ DeepResearcher（多步研究循环/轮次收敛）。
// 全部用 mock fetch/chat，不依赖真实网络。
import { describe, it, expect } from 'vitest';
import { createWebSearch, extractMainText } from '../../src/research/WebSearch.js';
import { createDeepResearcher } from '../../src/research/DeepResearcher.js';

describe('WebSearch.extractMainText', () => {
  it('提取 <main> 正文、剥标签、去 script/nav', () => {
    const html = '<html><head><style>x{}</style></head><body><nav>导航栏</nav><main><h1>标题</h1><p>正文内容 hello</p><script>bad()</script></main></body></html>';
    const t = extractMainText(html, 1000);
    expect(t).toContain('正文内容 hello');
    expect(t).toContain('标题');
    expect(t).not.toContain('bad()');
    expect(t).not.toContain('导航栏');
    expect(t).not.toMatch(/<[^>]+>/);
  });
  it('无 main/article 时回退到 <body>', () => {
    expect(extractMainText('<body><p>裸 body 文字</p></body>')).toContain('裸 body 文字');
  });
  it('解码 HTML 实体', () => {
    const t = extractMainText('<main>a &amp; b &lt;c&gt; &#65;&#x42;</main>');
    expect(t).toContain('a & b <c> AB');
  });
});

describe('WebSearch.search provider 链', () => {
  it('MiniMax 最优先(有 key 时) + 剥 HTML', async () => {
    const mockFetch = async (url, opt) => {
      expect(String(url)).toContain('coding_plan/search');
      expect(opt.method).toBe('POST');
      return { ok: true, json: async () => ({ organic: [{ title: '<b>标题</b>', link: 'https://m.com', snippet: '<p>摘要内容</p>', date: '2026-06-05' }] }) };
    };
    const ws = createWebSearch({ minimaxKey: 'k', fetchImpl: mockFetch });
    const r = await ws.search('q');
    expect(r[0]).toMatchObject({ source: 'minimax', url: 'https://m.com', title: '标题', snippet: '摘要内容', date: '2026-06-05' });
  });
  it('MiniMax 搜索无 env 时通过持久 secret resolver 获取 key', async () => {
    const mockFetch = async (url, opt) => {
      expect(String(url)).toContain('coding_plan/search');
      expect(opt.headers.Authorization).toBe('Bearer keychain-minimax-key');
      return { ok: true, json: async () => ({ organic: [{ title: 'K', link: 'https://m.example', snippet: 'from keychain' }] }) };
    };
    const ws = createWebSearch({
      fetchImpl: mockFetch,
      secretResolver: (provider) => ({ ok: provider === 'minimax', value: 'keychain-minimax-key', source: 'keychain', sourceRef: 'MINIMAX_API_KEY' }),
    });

    const r = await ws.search('q');

    expect(r[0]).toMatchObject({ source: 'minimax', title: 'K' });
    expect(ws.status()).toMatchObject({ minimax: true, minimaxKeySource: 'keychain', minimaxKeySourceRef: 'MINIMAX_API_KEY' });
    expect(JSON.stringify(ws.status())).not.toContain('keychain-minimax-key');
  });
  it('MiniMax 代理 dispatcher 网络失败时直连重试一次', async () => {
    const oldProxy = process.env.HTTPS_PROXY;
    process.env.HTTPS_PROXY = 'http://127.0.0.1:7897';
    const calls = [];
    const mockFetch = async (url, opt) => {
      calls.push({ url: String(url), direct: Boolean(opt.dispatcher), auth: opt.headers.Authorization });
      if (!opt.dispatcher) throw new Error('fetch failed');
      return { ok: true, json: async () => ({ organic: [{ title: 'Direct', link: 'https://m.example', snippet: 'ok' }] }) };
    };
    try {
      const ws = createWebSearch({ minimaxKey: 'k', fetchImpl: mockFetch, directFetchDispatcher: { dispatch() {} } });
      const r = await ws.search('q');
      expect(r[0]).toMatchObject({ source: 'minimax', title: 'Direct' });
      expect(calls).toHaveLength(2);
      expect(calls.map((c) => c.direct)).toEqual([false, true]);
      expect(calls.every((c) => c.auth === 'Bearer k')).toBe(true);
    } finally {
      if (oldProxy === undefined) delete process.env.HTTPS_PROXY;
      else process.env.HTTPS_PROXY = oldProxy;
    }
  });
  it('MiniMax 失败时降级到 SearXNG', async () => {
    const calls = [];
    const mockFetch = async (url) => {
      calls.push(String(url).includes('coding_plan') ? 'minimax' : 'searxng');
      if (String(url).includes('coding_plan')) return { ok: false, status: 500 };
      return { ok: true, json: async () => ({ results: [{ title: 'S', url: 'https://s.com', content: 'x' }] }) };
    };
    const ws = createWebSearch({ minimaxKey: 'k', searxngUrl: 'http://sx', fetchImpl: mockFetch });
    const r = await ws.search('q');
    expect(r[0].source).toBe('searxng');
    expect(calls).toEqual(['minimax', 'searxng']);
  });
  it('支持按单个 provider 调用，供 AISearch 插入 CLI 兜底顺序', async () => {
    const mockFetch = async (url) => {
      expect(String(url)).toContain('/search?q=');
      return { ok: true, json: async () => ({ results: [{ title: 'Only SearXNG', url: 'https://s.com', content: 'x' }] }) };
    };
    const ws = createWebSearch({ minimaxKey: 'k', searxngUrl: 'http://sx', fetchImpl: mockFetch });
    const r = await ws.searchProvider('searxng', 'q');
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ source: 'searxng', title: 'Only SearXNG' });
  });
  it('SearXNG 正确解析 results', async () => {
    const mockFetch = async (url) => {
      expect(url).toContain('/search?q=');
      expect(url).toContain('format=json');
      return { ok: true, json: async () => ({ results: [{ title: 'T1', url: 'https://a.com', content: 'snip1' }, { title: 'T2', url: 'https://b.com', content: 'snip2' }] }) };
    };
    const ws = createWebSearch({ minimaxKey: '', searxngUrl: 'http://searx.local', fetchImpl: mockFetch });
    const r = await ws.search('测试', { count: 5 });
    expect(r).toHaveLength(2);
    expect(r[0]).toMatchObject({ title: 'T1', url: 'https://a.com', snippet: 'snip1', source: 'searxng' });
  });
  it('SearXNG 失败时降级到 Brave', async () => {
    let calls = 0;
    const mockFetch = async (url) => {
      calls++;
      if (String(url).includes('searx')) return { ok: false, status: 500 };
      return { ok: true, json: async () => ({ web: { results: [{ title: 'BT', url: 'https://brave.r', description: 'bd' }] } }) };
    };
    const ws = createWebSearch({ minimaxKey: '', searxngUrl: 'http://searx.local', braveKey: 'k', fetchImpl: mockFetch });
    const r = await ws.search('q');
    expect(r[0]).toMatchObject({ source: 'brave', title: 'BT' });
    expect(calls).toBe(2);
  });
  it('未配置任何源 → 抛友好错误(带配置指引)', async () => {
    const ws = createWebSearch({ minimaxKey: '', searxngUrl: '', braveKey: '', fetchImpl: async () => ({ ok: true, json: async () => ({}) }) });
    await expect(ws.search('q')).rejects.toThrow(/未配置搜索源/);
  });
});

describe('WebSearch.fetchContent SSRF 防护', () => {
  it('拒绝私有/loopback 地址', async () => {
    const ws = createWebSearch({ fetchImpl: async () => { throw new Error('不该被调用'); } });
    for (const u of ['http://127.0.0.1/x', 'http://localhost/x', 'http://192.168.1.1/x', 'http://10.0.0.1/x', 'http://169.254.1.1/x', 'http://172.16.0.1/x']) {
      const r = await ws.fetchContent(u);
      expect(r.ok).toBe(false);
      expect(r.error).toMatch(/SSRF|私有/);
    }
  });
  it('抓取公网网页并提取正文', async () => {
    const mockFetch = async () => ({ ok: true, headers: { get: () => 'text/html; charset=utf-8' }, text: async () => '<main><p>公网正文 abc</p></main>' });
    const ws = createWebSearch({ fetchImpl: mockFetch });
    const r = await ws.fetchContent('https://example.com/a');
    expect(r.ok).toBe(true);
    expect(r.text).toContain('公网正文 abc');
  });
});

describe('DeepResearcher 多步研究', () => {
  it('跑通一轮：查询→搜索→抓页→综合→智能判停', async () => {
    const webSearch = {
      search: async () => [{ title: 'R', url: 'https://r.com', snippet: 's', source: 'm' }],
      fetchContent: async (u) => ({ url: u, ok: true, text: '页面正文' }),
    };
    let synthCalled = false;
    const chat = async (messages) => {
      const sys = messages[0].content;
      if (sys.includes('生成 2-3 个')) return { reply: '["查询A"]' };
      if (sys.includes('综合')) { synthCalled = true; return { reply: '# 报告\n整合内容 [1]' }; }
      // Reflexion 自评：无缺口 + 高覆盖 → 第一轮后即判停（取代旧的 {"enough":true}）。
      if (sys.includes('研究审稿人')) return { reply: '{"gaps":[],"unsupportedClaims":[],"contradictions":[],"coverageScore":0.9}' };
      return { reply: '' };
    };
    const out = await createDeepResearcher({ webSearch, chat }).research('测试问题', { maxRounds: 6 });
    expect(out.report).toContain('整合内容');
    expect(out.rounds).toBe(1);
    expect(out.sources).toEqual([{ title: 'R', url: 'https://r.com' }]);
    expect(synthCalled).toBe(true);
  });
  it('靠 maxRounds 收敛(不靠时间超时)，judge 永不满足也会停', async () => {
    let qn = 0;
    const webSearch = { search: async () => [{ title: 'x', url: 'https://x.com/' + (++qn), snippet: 's' }], fetchContent: async (u) => ({ url: u, ok: true, text: 't' }) };
    const chat = async (messages) => {
      const sys = messages[0].content;
      if (sys.includes('生成 2-3 个')) return { reply: JSON.stringify(['q' + qn]) };
      if (sys.includes('综合')) return { reply: 'report' };
      if (sys.includes('判断研究报告')) return { reply: '{"enough": false}' };
      return { reply: '' };
    };
    const out = await createDeepResearcher({ webSearch, chat }).research('q', { maxRounds: 3 });
    expect(out.rounds).toBe(3);
  });
  it('搜索连续空结果自动停(emptyStreak)', async () => {
    const webSearch = { search: async () => [], fetchContent: async () => ({ ok: false }) };
    let qn = 0;
    const chat = async (messages) => {
      if (messages[0].content.includes('生成 2-3 个')) return { reply: JSON.stringify(['q' + (++qn)]) };
      return { reply: '{"enough": false}' };
    };
    const out = await createDeepResearcher({ webSearch, chat }).research('q', { maxRounds: 8 });
    expect(out.rounds).toBeLessThanOrEqual(2);
  });
});
