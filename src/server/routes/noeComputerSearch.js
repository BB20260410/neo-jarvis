import { requireOwnerToken } from '../auth/owner-token.js';
import { createAISearch } from '../../research/AISearch.js';
import { formatSearchReply, summarizeSearchResults } from '../../research/ResearchIntent.js';
import { MiniMaxTtsClient } from '../../voice/MiniMaxTtsClient.js';

const MAX_BODY = 7000;
const MAX_RESULTS = 8;
const COMMAND_PREFIX_RE = /^(请|麻烦|帮我|让\s*noe|让\s*neo|让\s*贾维斯|noe|neo|诺伊|诺依|宝贝|贾维斯|用电脑|电脑|可见|演示|打开浏览器|上网|联网)?\s*(搜一下|搜索一下|搜索|搜|查一下|查查|查|找一下|找|研究一下|研究)?\s*/i;

function tooBig(body) {
  return JSON.stringify(body || {}).length > MAX_BODY;
}

function cleanQuery(body = {}) {
  const raw = String(body.query || body.text || '').trim();
  return raw.replace(COMMAND_PREFIX_RE, '').replace(/[。？！!?，,\s]+$/g, '').trim().slice(0, 240) || raw.slice(0, 240);
}

function searchResults(out) {
  return Array.isArray(out?.results) ? out.results.filter(Boolean) : [];
}

async function synthesize(ttsClient, text, opts = {}) {
  if (!ttsClient || opts.voice !== true) return { audioBase64: null, audioFormat: null, ttsError: null };
  try {
    const { audioBuffer, format } = await ttsClient.synthesize(text, opts.tts || {});
    return { audioBase64: audioBuffer.toString('base64'), audioFormat: format, ttsError: null };
  } catch (e) {
    return { audioBase64: null, audioFormat: null, ttsError: e?.message || String(e) };
  }
}

export function registerNoeComputerSearchRoutes(app, {
  webSearch = createAISearch(),
  ttsClient = new MiniMaxTtsClient(),
  summarizeSearch = null,
  sendError,
} = {}) {
  app.post('/api/noe/computer/search', requireOwnerToken, async (req, res) => {
    try {
      if (tooBig(req.body)) return res.status(413).json({ ok: false, error: 'body too large' });
      const body = req.body || {};
      const query = cleanQuery(body);
      if (!query) return res.status(400).json({ ok: false, error: 'query required' });

      const count = Math.max(1, Math.min(MAX_RESULTS, Number(body.count) || 6));
      let meta = null;
      let searchErr = null;
      try {
        meta = typeof webSearch.searchWithMeta === 'function'
          ? await webSearch.searchWithMeta(query, { count })
          : { results: await webSearch.search(query, { count }) };
      } catch (e) {
        searchErr = e?.message || String(e);
      }

      const structured = searchResults(meta);
      const results = structured.slice(0, count);
      const reply = formatSearchReply(query, results, { maxResults: Math.min(5, count) });
      const spokenReply = await summarizeSearchResults(summarizeSearch, query, results, { maxResults: Math.min(5, count) });
      const audio = await synthesize(ttsClient, spokenReply, { voice: body.voice === true, tts: body.tts });

      return res.json({
        ok: true,
        matched: true,
        intent: 'computer_search',
        mode: 'silent',
        kind: '后台搜索',
        query,
        returnToNoe: false,
        closeAfterMs: 0,
        source: meta?.source || results[0]?.source || null,
        viaModel: meta?.viaModel || null,
        count: results.length,
        visible: null,
        results,
        reply,
        spokenReply,
        searchError: searchErr,
        ...audio,
      });
    } catch (e) {
      return typeof sendError === 'function' ? sendError(res, e) : res.status(500).json({ ok: false, error: e?.message || String(e) });
    }
  });
}
