// research.js — Noe 上网搜索 + 多步研究路由（registerResearchRoutes）。
// 移植自 Odysseus 搜索/研究设计(MIT, github.com/pewdiepie-archdaemon/odysseus)，用 Noe 技术栈 JS 重实现，
// 复用 BrainRouter 选大脑(默认压本地省 token)。详见 docs/Odysseus可移植模块评估报告_2026-06-05.md。
import { requireOwnerToken } from '../auth/owner-token.js';
import { createAISearch } from '../../research/AISearch.js';
import { createDeepResearcher } from '../../research/DeepResearcher.js';
import { createBrainChat } from '../../room/brainChat.js';

const MAX_BODY = 8000;
const DEEP_PROGRESS_HEARTBEAT_MS = 15_000;
const tooBig = (body) => JSON.stringify(body || {}).length > MAX_BODY;

export function registerResearchRoutes(app, {
  getAdapter = null,
  brainRouter = null,
  webSearch = createAISearch(),
  researcher = null,
  episodicTimeline = null,   // 内在世界（记录覆盖扩展）：注入才把深研究完成记进自传体时间线（门控在装配点）
} = {}) {
  const chat = createBrainChat({ getAdapter, brainRouter, taskId: 'noe-research' });
  const deepResearcher = researcher || createDeepResearcher({ webSearch, chat });

  // 单次搜索
  app.post('/api/noe/research/search', requireOwnerToken, async (req, res) => {
    try {
      if (tooBig(req.body)) return res.status(413).json({ ok: false, error: 'body too large' });
      const q = String((req.body || {}).query || '').trim();
      if (!q) return res.status(400).json({ ok: false, error: 'query required' });
      const out = await webSearch.searchWithMeta(q, { count: Math.min(Number(req.body.count) || 8, 20) });
      return res.json(out);
    } catch (e) { return res.status(500).json({ ok: false, error: e.message, status: webSearch.status() }); }
  });

  // 抓网页正文
  app.post('/api/noe/research/fetch', requireOwnerToken, async (req, res) => {
    try {
      if (tooBig(req.body)) return res.status(413).json({ ok: false, error: 'body too large' });
      const url = String((req.body || {}).url || '').trim();
      if (!/^https?:\/\//i.test(url)) return res.status(400).json({ ok: false, error: 'valid http(s) url required' });
      const r = await webSearch.fetchContent(url, { maxChars: Math.min(Number(req.body.maxChars) || 5000, 20000) });
      return res.json({ ok: r.ok, ...r });
    } catch (e) { return res.status(500).json({ ok: false, error: e.message }); }
  });

  // 多步深度研究(SSE 进度流)。无时间超时，靠轮次上限收敛。
  app.post('/api/noe/research/deep', requireOwnerToken, async (req, res) => {
    let heartbeat = null;
    let closed = false;
    const stopHeartbeat = () => {
      if (!heartbeat) return;
      clearInterval(heartbeat);
      heartbeat = null;
    };
    try {
      if (tooBig(req.body)) return res.status(413).json({ ok: false, error: 'body too large' });
      const q = String((req.body || {}).question || (req.body || {}).query || '').trim();
      if (!q) return res.status(400).json({ ok: false, error: 'question required' });
      const maxRounds = Math.min(Number(req.body.maxRounds) || 6, 10);
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      res.on?.('close', () => {
        closed = true;
        stopHeartbeat();
      });
      const send = (ev, data) => {
        if (closed) return;
        try { res.write(`event: ${ev}\ndata: ${JSON.stringify(data)}\n\n`); } catch { closed = true; }
      };
      send('start', { question: q, maxRounds });
      let latestProgress = { phase: 'plan', round: 0 };
      heartbeat = setInterval(() => send('progress', { ...latestProgress, stillWorking: true }), DEEP_PROGRESS_HEARTBEAT_MS);
      heartbeat.unref?.();
      const out = await deepResearcher.research(q, {
        maxRounds,
        onProgress: (p) => {
          latestProgress = { ...latestProgress, ...p };
          send('progress', p);
        },
      });
      stopHeartbeat();
      send('result', out);
      send('done', { rounds: out.rounds });
      // 内在世界（记录覆盖扩展）：深研究完成记进自传体时间线（observation——是"我做过的事"非对话；
      // 单次搜索不记，避免噪声）。注入式（未注入则跳过，零影响）；写失败不阻断研究返回。
      try {
        episodicTimeline?.record({
          type: 'observation',
          summary: `我深入研究了"${q.slice(0, 40)}"（${out.rounds} 轮）`,
          salience: 4,
        });
      } catch { /* 记录失败不阻断研究返回 */ }
      res.end();
    } catch (e) {
      stopHeartbeat();
      try { res.write(`event: error\ndata: ${JSON.stringify({ error: e.message })}\n\n`); res.end(); } catch { try { res.status(500).json({ ok: false, error: e.message }); } catch { /* noop */ } }
    }
  });

  // 搜索源配置状态（前端用来提示用户去配 key/url）
  app.get('/api/noe/research/status', requireOwnerToken, (_req, res) => res.json({ ok: true, ...webSearch.status() }));

  return { webSearch, researcher: deepResearcher };
}
