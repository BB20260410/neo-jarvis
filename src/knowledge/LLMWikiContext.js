import { searchWiki } from './LLMWiki.js';

const LOCAL_HINT = /本地|知识库|wiki|之前|我们|方案|决策|结论|复刻|取舍|经验|建议/i;
const WIKI_TOPIC = /karpathy|obsidian|llm[-\s]?wiki|smart connections|templater|dataview|haiku|copilot|mcp|知识库|复刻/i;
const WEB_HINT = /上网|联网|最新|实时|新闻|今天|现在|搜一下|查一下|搜索/i;

function cleanQuery(text) {
  return String(text || '')
    .replace(/^(查|查询|搜索|问一下|帮我|帮我查|本地|知识库|本地知识库|wiki|LLM Wiki)\s*/i, '')
    .replace(/(里|中)?(有没有|怎么说|怎么看|结论是什么|要不要|为什么|吗|呢|？|\?)$/i, '')
    .trim()
    .slice(0, 160);
}

export function detectLLMWikiIntent(text, opts = {}) {
  const raw = String(text || '').trim();
  if (!raw) return null;
  if (opts.localWiki === true) return { query: cleanQuery(raw) || raw, forced: true };
  if (WEB_HINT.test(raw) && !/本地|知识库|wiki/i.test(raw)) return null;
  if (!LOCAL_HINT.test(raw) && !WIKI_TOPIC.test(raw)) return null;
  if (!WIKI_TOPIC.test(raw) && !/之前|我们|方案|决策|结论|建议/i.test(raw)) return null;
  return { query: cleanQuery(raw) || raw, forced: false };
}

function formatReply(query, hits) {
  if (!hits.length) {
    return `我查了本地 LLM Wiki，暂时没有找到「${query}」的记录。可以改用联网搜索，或把资料放进 knowledge/llm-wiki/raw/ 后运行 wiki:ingest。`;
  }
  const lines = [`我先查了本地 LLM Wiki，命中 ${hits.length} 条：`];
  hits.slice(0, 3).forEach((hit, idx) => {
    lines.push(`[${idx + 1}] ${hit.title} (${hit.file})`);
    if (hit.snippet) lines.push(hit.snippet.slice(0, 420));
  });
  return lines.join('\n\n');
}

export function createLLMWikiContextProvider({ wikiSearch = searchWiki, root = 'knowledge/llm-wiki' } = {}) {
  async function lookup(query, opts = {}) {
    const topK = Math.min(Number(opts.topK) || 4, 10);
    const result = await wikiSearch({ root, query, topK });
    const hits = Array.isArray(result?.hits) ? result.hits : [];
    return {
      ok: true,
      query,
      count: hits.length,
      hits,
      citations: hits.map((hit, idx) => ({ index: idx + 1, title: hit.title, file: hit.file, snippet: hit.snippet })),
      reply: formatReply(query, hits),
    };
  }
  return { lookup };
}
