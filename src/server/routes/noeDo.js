import { requireOwnerToken } from '../auth/owner-token.js';
import { createAISearch } from '../../research/AISearch.js';
import { createDeepResearcher } from '../../research/DeepResearcher.js';
import { createBrainChat } from '../../room/brainChat.js';
import { detectResearchIntent, formatDeepResearchReply, formatSearchReply } from '../../research/ResearchIntent.js';
import { detectTaskIntent, formatTaskIntentReply } from '../../room/TaskIntentRouter.js';
import { createLLMWikiContextProvider, detectLLMWikiIntent } from '../../knowledge/LLMWikiContext.js';

const MAX_BODY = 8000;
const tooBig = (body) => JSON.stringify(body || {}).length > MAX_BODY;

export function registerNoeDoRoute(app, {
  getMcpClient = null,
  permissionGovernance = null,
  webSearch = createAISearch(),
  researcher = null,
  llmWiki = createLLMWikiContextProvider(),
  brainRouter = null,
  getAdapter = null,
  sendError,
} = {}) {
  const organizeBatches = [];
  const chat = createBrainChat({ getAdapter, brainRouter, taskId: 'noe-do-research' });
  const deepResearcher = researcher || createDeepResearcher({ webSearch, chat });

  app.post('/api/noe/do', requireOwnerToken, async (req, res) => {
    try {
      if (tooBig(req.body)) return res.status(413).json({ ok: false, error: 'body too large' });
      const body = req.body || {};
      const text = String(body.text || '').trim();
      if (!text) return res.status(400).json({ ok: false, error: 'text required' });

      const wikiIntent = detectLLMWikiIntent(text, { localWiki: body.localWiki === true });
      if (wikiIntent) {
        const out = await llmWiki.lookup(wikiIntent.query, { topK: body.topK });
        return res.json({
          ok: true,
          matched: true,
          intent: 'llm_wiki',
          mode: 'local',
          kind: '本地知识库',
          forced: wikiIntent.forced,
          ...out,
        });
      }

      const researchIntent = detectResearchIntent(text);
      if (researchIntent && body.confirm !== true) {
        if (researchIntent.mode === 'deep' || body.deep === true) {
          const out = await deepResearcher.research(researchIntent.query, {
            maxRounds: Math.min(Number(body.maxRounds) || 2, 4),
            perQuery: Math.min(Number(body.perQuery) || 4, 8),
            fetchTop: Math.min(Number(body.fetchTop) || 4, 8),
          });
          return res.json({
            ok: true,
            matched: true,
            intent: 'research',
            mode: 'deep',
            kind: '深度研究',
            query: researchIntent.query,
            report: out.report,
            rounds: out.rounds,
            sources: out.sources,
            reply: formatDeepResearchReply(out),
          });
        }
        const out = typeof webSearch.searchWithMeta === 'function'
          ? await webSearch.searchWithMeta(researchIntent.query, { count: Math.min(Number(body.count) || 6, 12) })
          : { results: await webSearch.search(researchIntent.query, { count: Math.min(Number(body.count) || 6, 12) }) };
        const results = out.results || [];
        return res.json({
          ok: true,
          matched: true,
          intent: 'research',
          mode: 'search',
          kind: '联网搜索',
          query: researchIntent.query,
          source: out.source || results[0]?.source || null,
          viaModel: out.viaModel || results[0]?.viaModel || null,
          count: results.length,
          results,
          reply: formatSearchReply(researchIntent.query, results),
        });
      }

      const taskIntent = detectTaskIntent(text);
      if (taskIntent) {
        return res.json({
          ok: true,
          matched: true,
          intent: 'delegate_task',
          kind: '派活计划',
          approvalRequired: true,
          dryRunOnly: true,
          confirmEndpoint: '/api/noe/delegate/confirm',
          plan: taskIntent,
          reply: formatTaskIntentReply(taskIntent),
        });
      }

      const mcp = typeof getMcpClient === 'function' ? getMcpClient() : null;
      if (!mcp || typeof mcp.callTool !== 'function') return res.status(501).json({ ok: false, error: 'MCP client 未就绪（知识库未连？）' });
      const callText = (r) => r?.content?.[0]?.text || (typeof r === 'string' ? r : JSON.stringify(r));
      const govCall = async (toolName, toolArgs) => {
        if (permissionGovernance && typeof permissionGovernance.evaluatePermission === 'function') {
          const d = permissionGovernance.evaluatePermission({ action: 'skill.plugin.execute', target: { section: 'mcp', serverName: 'unified-kb', operation: 'call', toolName } });
          if (d && d.decision !== 'allow') throw new Error(`权限未放行: ${toolName}（${d.reason || d.decision}）`);
        }
        return mcp.callTool('unified-kb', toolName, toolArgs);
      };
      const syncOrganizeIndex = async ({ batchId = '', reason = '' } = {}) => {
        try {
          const raw = callText(await govCall('fs_organize_sync', { batch_id: batchId, reason }));
          return { attempted: true, ok: true, result: raw.slice(0, 300) };
        } catch (e) {
          return { attempted: true, ok: false, error: e?.message || String(e) };
        }
      };

      if (/撤销|还原|恢复|后悔|撤回|移回|放回|undo/i.test(text)) {
        const bid = String(body.batchId || organizeBatches[organizeBatches.length - 1] || '');
        if (!bid) return res.json({ ok: true, matched: true, kind: '撤销', undone: false, reason: '没有可撤销的最近整理批次（或显式传 batchId）' });
        const undoRes = callText(await govCall('fs_organize_undo', { batch_id: bid })).slice(0, 400);
        if (!body.batchId) { const i = organizeBatches.lastIndexOf(bid); if (i >= 0) organizeBatches.splice(i, 1); }
        const sync = await syncOrganizeIndex({ batchId: bid, reason: 'undo' });
        return res.json({ ok: true, matched: true, kind: '撤销', undone: true, batchId: bid, result: undoRes, sync });
      }

      if (/整理|归类|归到|归一起|归档|清理|整顿|挪到|移到|分类|归位/.test(text)
          && /文件|文档|桌面|截图|图片|照片|视频|下载|目录|文件夹|资料|素材|安装包|压缩包|\.(txt|pdf|docx?|xlsx?|pptx?|png|jpe?g|gif|mp4|mov|zip|dmg|app)\b/i.test(text)) {
        const planRaw = callText(await govCall('fs_organize_nl', { instruction: text }));
        let plan = null; try { plan = JSON.parse(planRaw); } catch { /* 非 JSON 原样返回 */ }
        const ops = (plan && plan.plan && Array.isArray(plan.plan.operations)) ? plan.plan.operations : [];
        if (body.confirm !== true) {
          return res.json({ ok: true, matched: true, kind: '整理·计划(dry-run)', tool: 'fs_organize_nl', needConfirm: ops.length > 0, opsCount: ops.length, plan: planRaw.slice(0, 1500), hint: ops.length ? `识别到 ${ops.length} 个文件移动。确认执行：再发一次带 confirm:true（移动可 undo，删除进废纸篓）` : '没生成具体操作，请说清目标（如"归到桌面的XX文件夹"）' });
        }
        if (!ops.length) return res.json({ ok: true, matched: true, executed: false, reason: '无可执行操作（先说清目标文件夹再确认）' });
        const execRaw = callText(await govCall('fs_organize_execute', { moves: ops, confirm: true }));
        let bid = null; try { bid = JSON.parse(execRaw)?.move?.batchId || null; } catch { /* 解析失败不影响执行结果 */ }
        if (bid) { organizeBatches.push(bid); if (organizeBatches.length > 10) organizeBatches.shift(); }
        const sync = await syncOrganizeIndex({ batchId: bid || '', reason: 'execute' });
        return res.json({ ok: true, matched: true, kind: '整理·已执行', executed: true, moved: ops.length, batchId: bid, undoHint: '后悔了说"撤销"即可还原', result: execRaw.slice(0, 800), sync });
      }

      if (/在哪|哪里|找.{0,8}文件|定位|搜.{0,8}文件|有没有.{0,8}文件|文件.{0,4}在/.test(text)) {
        const m = text.match(/找\s*(.+?)(的文件|文件|在哪|$)/) || text.match(/定位\s*(.+)/) || text.match(/(.+?)\s*在哪/);
        const q = (m && m[1] ? m[1] : text).replace(/[找定位的文件在哪里呢吗？?]/g, '').trim().slice(0, 50);
        return res.json({ ok: true, matched: true, kind: '查找文件', tool: 'fs_locate', result: callText(await govCall('fs_locate', { query: q || text.slice(0, 30), limit: 10 })) });
      }

      if (/多少.{0,4}文件|占用|画像|统计|多大|空间|磁盘|多乱/.test(text)) {
        return res.json({ ok: true, matched: true, kind: '全盘画像', tool: 'fs_stats', result: callText(await govCall('fs_stats', {})) });
      }
      return res.json({ ok: true, matched: false, hint: '没识别成文件/搜索操作。可说："查最新XX / 研究一下XX / 找XX文件在哪 / 把桌面截图归一起"' });
    } catch (e) {
      return typeof sendError === 'function' ? sendError(res, e) : res.status(500).json({ ok: false, error: e?.message || String(e) });
    }
  });
}
