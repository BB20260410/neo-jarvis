// WebSearch — Noe 的「上网」基础设施：网络搜索 + 网页正文抓取（补能力⑤）。
// 设计移植自 Odysseus services/search（MIT, github.com/pewdiepie-archdaemon/odysseus）：
//   SearXNG 自托管元搜索(免 key)首选 + Brave(免费 2000次/月)降级；纯 Node fetch + 正则正文提取，零新依赖。
// 可插拔：不强制 Docker —— 用户填 NOE_SEARXNG_URL(自托管/公共实例) 或 NOE_BRAVE_KEY 任一即可。

import {
  describeNoeProviderSecretFailure,
  resolveNoeProviderSecret,
} from '../secrets/NoeProviderSecrets.js';
import { Agent } from 'undici';
// SSRF 防护统一走 SsrfGuard（删本文件原弱版 isPrivateHost，消除与 img-cache 强版的策略分裂 + 堵 DNS rebinding）。
import { safeFetchPublicUrl } from '../security/SsrfGuard.js';

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36';

// 网页/搜索 API 的「网络 IO 超时」(毫秒)——防单个死链永久挂起整轮研究。
// 注意：这是抓网页的 IO 超时，不是「模型推理超时」。LLM 调用一律不设超时（见 DeepResearcher）。
const NET_TIMEOUT_MS = Number(process.env.NOE_WEB_TIMEOUT_MS) || 15000;
// 抓网页正文的字节上限：防攻击者返回超大 body 撑爆内存（DeepResearcher 会并发抓多页）。流式累计超限即中止。
const MAX_WEB_BODY_BYTES = Number(process.env.NOE_WEB_MAX_BODY_BYTES) || 4 * 1024 * 1024;
let directDispatcher = null;

function timeoutSignal(ms) { try { return AbortSignal.timeout(ms); } catch { return undefined; } }
function sleep(ms) { return new Promise((resolveSleep) => setTimeout(resolveSleep, ms)); }
function hasProxyEnv(env = process.env) {
  return Boolean(env.HTTPS_PROXY || env.HTTP_PROXY || env.https_proxy || env.http_proxy || env.ALL_PROXY || env.all_proxy);
}
function networkFetchFailed(error) {
  const text = `${error?.message || ''} ${error?.cause?.message || ''} ${error?.cause?.code || ''}`;
  return /fetch failed|ECONN|ETIMEDOUT|ENOTFOUND|EHOSTUNREACH|UND_ERR|proxy/i.test(text);
}
function getDirectDispatcher() {
  if (!directDispatcher) directDispatcher = new Agent({ connect: { timeout: NET_TIMEOUT_MS } });
  return directDispatcher;
}

function decodeEntities(s) {
  const map = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'", '&apos;': "'", '&nbsp;': ' ' };
  return String(s).replace(/&(amp|lt|gt|quot|#39|apos|nbsp);/g, (m) => map[m] || m)
    .replace(/&#(\d+);/g, (_, d) => { try { return String.fromCodePoint(Number(d)); } catch { return ' '; } })
    .replace(/&#x([0-9a-f]+);/gi, (_, hx) => { try { return String.fromCodePoint(parseInt(hx, 16)); } catch { return ' '; } });
}

// 流式读 body + 字节上限：先看 content-length 早拒，再边读边累计，超限立即 cancel（防超大 body 内存 DoS）。
async function readTextWithLimit(resp, maxBytes) {
  const declared = Number(resp.headers?.get?.('content-length') || 0);
  if (declared && declared > maxBytes) throw new Error(`body too large (content-length ${declared} > ${maxBytes})`);
  const body = resp.body;
  if (!body || typeof body.getReader !== 'function') {
    const t = await resp.text(); // mock/无流式 body：退化到 text() 后校验字节数
    if (Buffer.byteLength(t, 'utf8') > maxBytes) throw new Error(`body too large (>${maxBytes})`);
    return t;
  }
  const reader = body.getReader();
  const chunks = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > maxBytes) { try { await reader.cancel(); } catch {} throw new Error(`body too large (>${maxBytes})`); }
      chunks.push(Buffer.from(value));
    }
  } finally { try { reader.releaseLock?.(); } catch {} }
  return Buffer.concat(chunks).toString('utf8');
}

// 极简正文提取：去 script/style/注释，优先 <main>/<article>，回退 <body>，剥标签，解实体，压空白。
export function extractMainText(html, maxChars = 4000) {
  let s = String(html || '');
  s = s.replace(/<!--[\s\S]*?-->/g, ' ');
  s = s.replace(/<(script|style|noscript|svg|head|template)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ');
  let main = '';
  const mMain = s.match(/<(?:main|article)\b[^>]*>([\s\S]*?)<\/(?:main|article)>/i);
  if (mMain) main = mMain[1];
  else { const mBody = s.match(/<body\b[^>]*>([\s\S]*?)<\/body>/i); main = mBody ? mBody[1] : s; }
  main = main.replace(/<(nav|footer|aside|header|form)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ');
  main = main.replace(/<[^>]+>/g, ' ');
  main = decodeEntities(main);
  main = main.replace(/[ \t\f\v]+/g, ' ').replace(/\s*\n\s*/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  return main.slice(0, maxChars);
}

export function createWebSearch({
  minimaxKey,
  searxngUrl = process.env.NOE_SEARXNG_URL || '',
  braveKey = process.env.NOE_BRAVE_KEY || '',
  fetchImpl = globalThis.fetch,
  secretResolver = resolveNoeProviderSecret,
  directFetchDispatcher = null,
  dnsResolve = null, // SSRF DNS 复查解析器(DI)：生产=真实 dns.lookup 做 rebinding 防护；测试注入 mock 实现无网络验证
  fetchCache = null, // 网页抓取缓存（NOE_FETCH_CACHE=1 才注入 createPrefetchStore 实例）：同 URL+maxChars 命中省重抓；null 则直通、零回归
  fetchCacheTtlMs = Number(process.env.NOE_FETCH_CACHE_TTL_MS) || 6 * 3600 * 1000, // 默认 6h（网页正文时效宽松）
} = {}) {
  const minimaxResolution = minimaxKey
    ? { ok: true, value: minimaxKey, source: 'caller', sourceRef: 'minimaxKey' }
    : (minimaxKey === ''
        ? { ok: false, value: '', source: 'explicit-empty', sourceRef: 'minimaxKey' }
        : secretResolver('minimax'));
  const resolvedMinimaxKey = minimaxResolution?.value || '';
  const fetchFn = fetchImpl;
  const stripTags = (s) => decodeEntities(String(s || '').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();

  // MiniMax 官方搜索 API（用户优先；用 Noe 已有 MINIMAX_API_KEY，国内直连可达，返回带来源+日期的实时结果）。
  async function minimaxSearch(query, count) {
    const url = 'https://api.minimaxi.com/v1/coding_plan/search';
    const requestOptions = () => ({
      method: 'POST',
      headers: { Authorization: `Bearer ${resolvedMinimaxKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ q: query }),
      signal: timeoutSignal(NET_TIMEOUT_MS),
    });
    let resp;
    if (hasProxyEnv()) {
      let proxySettled = false;
      const proxyAttempt = fetchFn(url, requestOptions()).then((value) => {
        proxySettled = true;
        return value;
      });
      const directAttempt = sleep(300).then(() => {
        if (proxySettled) return new Promise(() => {});
        return fetchFn(url, { ...requestOptions(), dispatcher: directFetchDispatcher || getDirectDispatcher() });
      });
      try {
        resp = await Promise.any([proxyAttempt, directAttempt]);
      } catch (error) {
        const errors = Array.isArray(error?.errors) ? error.errors : [error];
        if (!errors.some((item) => networkFetchFailed(item))) throw error;
        throw new Error(errors.map((item) => item?.message || String(item)).join('; direct_race:'));
      }
    } else {
      resp = await fetchFn(url, requestOptions());
    }
    if (!resp.ok) throw new Error(`minimax ${resp.status}`);
    const data = await resp.json();
    return (Array.isArray(data.organic) ? data.organic : []).slice(0, count)
      .map((r) => ({ title: stripTags(r.title), url: r.link || '', snippet: stripTags(r.snippet).slice(0, 300), source: 'minimax', date: r.date || '' }));
  }

  async function searxng(query, count) {
    const base = searxngUrl.replace(/\/+$/, '');
    const url = `${base}/search?q=${encodeURIComponent(query)}&format=json&safesearch=0&engines=bing,mojeek,duckduckgo,brave`;
    const resp = await fetchFn(url, { headers: { 'User-Agent': UA, Accept: 'application/json' }, signal: timeoutSignal(NET_TIMEOUT_MS) });
    if (!resp.ok) throw new Error(`searxng ${resp.status}`);
    const data = await resp.json();
    return (Array.isArray(data.results) ? data.results : []).slice(0, count)
      .map((r) => ({ title: r.title || '', url: r.url || '', snippet: r.content || '', source: 'searxng' }));
  }

  async function brave(query, count) {
    const url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=${count}`;
    const resp = await fetchFn(url, { headers: { 'User-Agent': UA, Accept: 'application/json', 'X-Subscription-Token': braveKey }, signal: timeoutSignal(NET_TIMEOUT_MS) });
    if (!resp.ok) throw new Error(`brave ${resp.status}`);
    const data = await resp.json();
    return (data?.web?.results || []).slice(0, count)
      .map((r) => ({ title: r.title || '', url: r.url || '', snippet: r.description || '', source: 'brave' }));
  }

  async function searchProvider(provider, query, { count = 8 } = {}) {
    const q = String(query || '').trim();
    if (!q) return [];
    if (provider === 'minimax') {
      if (!resolvedMinimaxKey) throw new Error(describeNoeProviderSecretFailure('minimax', minimaxResolution));
      return minimaxSearch(q, count);
    }
    if (provider === 'searxng') {
      if (!searxngUrl) throw new Error('SearXNG not configured');
      return searxng(q, count);
    }
    if (provider === 'brave') {
      if (!braveKey) throw new Error('Brave not configured');
      return brave(q, count);
    }
    throw new Error(`unknown search provider: ${provider}`);
  }

  // 搜索：provider 链(MiniMax→SearXNG→Brave)，全失败抛带配置指引的友好错误。
  async function search(query, { count = 8 } = {}) {
    const q = String(query || '').trim();
    if (!q) return [];
    const errors = [];
    // 优先级：MiniMax(用户优先,现有 key,实时带来源) → SearXNG(自托管免 key) → Brave(免费额度)
    if (resolvedMinimaxKey) { try { const r = await searchProvider('minimax', q, { count }); if (r.length) return r; } catch (e) { errors.push(`MiniMax:${e.message}`); } }
    if (searxngUrl) { try { const r = await searchProvider('searxng', q, { count }); if (r.length) return r; } catch (e) { errors.push(`SearXNG:${e.message}`); } }
    if (braveKey) { try { const r = await searchProvider('brave', q, { count }); if (r.length) return r; } catch (e) { errors.push(`Brave:${e.message}`); } }
    if (!resolvedMinimaxKey && !searxngUrl && !braveKey) throw new Error('未配置搜索源。MiniMax(Keychain/MINIMAX_API_KEY)/SearXNG(NOE_SEARXNG_URL)/Brave(NOE_BRAVE_KEY) 至少配一个。');
    throw new Error(`所有搜索源失败：${errors.join('；') || '无结果'}`);
  }

  // 抓网页正文(并发由调用方控制)；带 SSRF 防护 + IO 超时。
  async function fetchContent(url, { maxChars = 4000 } = {}) {
    // 网页抓取缓存（NOE_FETCH_CACHE）：同 URL+maxChars 命中直接返回，省重抓（治自主学习同 URL 跨次重抓）。
    //   key 带 maxChars 避免"缓存了小截断、请求方要更大"的不一致。null（OFF）则直通、零回归。
    const cacheKey = fetchCache ? `fetch:${maxChars}:${url}` : null;
    if (cacheKey) { const hit = fetchCache.get(cacheKey); if (hit) return hit; }
    // SSRF 防护：走 SsrfGuard.safeFetchPublicUrl 统一入口——逐跳 assertPublicUrl + pinned dispatcher +
    //   redirect:'manual'，闭合 DNS rebinding TOCTOU 与"重定向到内网"绕过（连接锁定在已校验的公网 IP）。
    let safe;
    try {
      safe = await safeFetchPublicUrl(url, {
        fetchImpl: fetchFn,
        dnsResolve: dnsResolve || undefined,
        headers: { 'User-Agent': UA, Accept: 'text/html,application/xhtml+xml' },
        timeoutMs: NET_TIMEOUT_MS,
      });
    } catch (e) { return { url, ok: false, text: '', error: `拒绝抓取私有地址(SSRF 防护): ${e?.message || e}` }; }
    try {
      const resp = safe.resp;
      if (!resp.ok) return { url, ok: false, text: '', error: `HTTP ${resp.status}` };
      const ct = resp.headers.get('content-type') || '';
      if (!/text\/html|text\/plain|xhtml/i.test(ct)) return { url, ok: false, text: '', error: `非网页类型 ${ct}` };
      const html = await readTextWithLimit(resp, MAX_WEB_BODY_BYTES);
      const result = { url, ok: true, text: extractMainText(html, maxChars) };
      // 只缓存成功且有正文的结果——失败/SSRF 拒/非网页类型/空正文都不缓存，避免一次瞬时失败被钉住整个 TTL（缓存毒化）。
      if (cacheKey && result.text) fetchCache.set(cacheKey, result, fetchCacheTtlMs);
      return result;
    } catch (e) { return { url, ok: false, text: '', error: e.message }; }
    finally { safe?.cleanup?.(); }
  }

  function status() {
    return {
      minimax: !!resolvedMinimaxKey,
      minimaxKeySource: resolvedMinimaxKey ? minimaxResolution.source : null,
      minimaxKeySourceRef: resolvedMinimaxKey ? minimaxResolution.sourceRef : null,
      searxng: !!searxngUrl,
      brave: !!braveKey,
      configured: !!(resolvedMinimaxKey || searxngUrl || braveKey),
    };
  }

  return { search, searchProvider, fetchContent, status };
}
