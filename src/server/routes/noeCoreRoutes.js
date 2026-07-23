import { requireOwnerToken } from '../auth/owner-token.js';
import { registerNoeCommandRoutes } from './noeCommands.js';

function parseLimit(value, fallback = 20) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(1, Math.min(100, Math.trunc(n)));
}

function sendInvokeResult(res, result) {
  const status = Number(result?.status) || (result?.ok ? 200 : 500);
  return res.status(status).json(result);
}

export function registerNoeCoreRoutes(app, {
  loop,
  memory,
  focus,
  toolRegistry,
  approvalStore,
  actStore,
  actPipeline,
  sendError,
} = {}) {
  app.get('/api/noe/loop/status', requireOwnerToken, (_req, res) => {
    res.json({ ok: true, status: loop.status() });
  });

  for (const action of ['start', 'stop', 'pause', 'resume']) {
    app.post(`/api/noe/loop/${action}`, requireOwnerToken, (req, res) => {
      try {
        if (action === 'start') return res.json({ ok: true, status: loop.start(req.body || {}) });
        if (action === 'stop') return res.json({ ok: true, status: loop.stop({ reason: req.body?.reason || 'api' }) });
        if (action === 'pause') return res.json({ ok: true, status: loop.pause(req.body?.reason || 'api') });
        return res.json({ ok: true, status: loop.resume(req.body || {}) });
      } catch (e) {
        return sendError(res, e);
      }
    });
  }

  app.post('/api/noe/loop/tick', requireOwnerToken, async (req, res) => {
    try {
      const result = await loop.tick({ ...(req.body || {}), force: req.body?.force !== false });
      res.json(result);
    } catch (e) {
      sendError(res, e);
    }
  });

  app.get('/api/noe/memory', requireOwnerToken, (req, res) => {
    try {
      const items = memory.recall({
        q: req.query.q || req.query.query || '',
        projectId: req.query.project || req.query.projectId,
        scope: req.query.scope,
        limit: parseLimit(req.query.limit),
        includeExpired: req.query.includeExpired === 'true',
        // P4 修复：GUI 浏览记忆是「查看」非「被对话采纳使用」，不该刷 hit_count 污染热点/命中度量（子代理实测此路泄漏）。
        bumpHits: false,
      });
      res.json({ ok: true, count: items.length, items });
    } catch (e) {
      sendError(res, e);
    }
  });

  app.post('/api/noe/memory', requireOwnerToken, (req, res) => {
    try {
      const item = memory.write(req.body || {});
      res.status(201).json({ ok: true, item });
    } catch (e) {
      sendError(res, e);
    }
  });

  app.delete('/api/noe/memory/:id', requireOwnerToken, (req, res) => {
    try {
      const ok = memory.hide(req.params.id, {
        projectId: req.query.project || req.query.projectId,
        reason: req.query.reason || req.body?.reason || 'api_delete',
      });
      if (!ok) return res.status(404).json({ ok: false, error: 'memory not found' });
      return res.json({ ok: true });
    } catch (e) {
      return sendError(res, e);
    }
  });

  app.post('/api/noe/memory/:id/merge', requireOwnerToken, (req, res) => {
    try {
      if (!memory.merge) return res.status(501).json({ ok: false, error: 'memory merge not configured' });
      const item = memory.merge({
        targetId: req.params.id,
        sourceIds: req.body?.sourceIds || req.body?.source_ids || [],
        projectId: req.body?.projectId || req.body?.project_id,
        reason: req.body?.reason || 'api_merge',
      });
      return res.json({ ok: true, item });
    } catch (e) {
      return sendError(res, e);
    }
  });

  app.get('/api/noe/focus', requireOwnerToken, (req, res) => {
    try {
      const items = focus.list({
        projectId: req.query.project || req.query.projectId,
        state: req.query.state || 'active',
        limit: parseLimit(req.query.limit, 100),
      });
      res.json({ ok: true, count: items.length, items });
    } catch (e) {
      sendError(res, e);
    }
  });

  app.post('/api/noe/focus', requireOwnerToken, (req, res) => {
    try {
      const item = focus.push(req.body || {});
      res.status(201).json({ ok: true, item });
    } catch (e) {
      sendError(res, e);
    }
  });

  app.post('/api/noe/focus/:id/pop', requireOwnerToken, (req, res) => {
    try {
      const item = focus.pop(req.params.id, req.body || {});
      if (!item) return res.status(404).json({ ok: false, error: 'focus item not found' });
      return res.json({ ok: true, item });
    } catch (e) {
      return sendError(res, e);
    }
  });

  app.get('/api/noe/tools', requireOwnerToken, (req, res) => {
    try {
      const tools = toolRegistry.list({ enabled: req.query.enabled === 'true' ? true : req.query.enabled === 'false' ? false : undefined });
      res.json({ ok: true, count: tools.length, tools });
    } catch (e) {
      sendError(res, e);
    }
  });

  registerNoeCommandRoutes(app, { toolRegistry, sendError });

  app.post('/api/noe/tools', requireOwnerToken, (req, res) => {
    try {
      const tool = toolRegistry.register(req.body || {});
      res.status(201).json({ ok: true, tool });
    } catch (e) {
      sendError(res, e);
    }
  });

  app.post('/api/noe/tools/:id/enable', requireOwnerToken, (req, res) => {
    try {
      const tool = toolRegistry.setEnabled(req.params.id, req.body?.enabled !== false);
      if (!tool) return res.status(404).json({ ok: false, error: 'tool not found' });
      return res.json({ ok: true, tool });
    } catch (e) {
      return sendError(res, e);
    }
  });

  app.post('/api/noe/tools/:id/invoke', requireOwnerToken, async (req, res) => {
    try {
      const result = await toolRegistry.invoke(req.params.id, {
        ...(req.body || {}),
        approvalId: req.get('X-Panel-Approval-Id') || req.body?.approvalId,
      });
      sendInvokeResult(res, result);
    } catch (e) {
      sendError(res, e);
    }
  });

  app.get('/api/noe/approvals', requireOwnerToken, (req, res) => {
    try {
      const approvals = approvalStore?.listApprovals?.({
        status: req.query.status || 'pending',
        type: req.query.type || undefined,
        limit: parseLimit(req.query.limit, 50),
      }) || [];
      res.json({ ok: true, count: approvals.length, approvals });
    } catch (e) {
      sendError(res, e);
    }
  });

  app.get('/api/noe/acts', requireOwnerToken, (req, res) => {
    try {
      const projectId = req.query.project || req.query.projectId || 'noe';
      const items = actStore?.list?.({
        projectId,
        status: req.query.status || undefined,
        limit: parseLimit(req.query.limit, 20),
      }) || [];
      res.json({ ok: true, count: items.length, items, summary: actStore?.summary?.({ projectId }) || null });
    } catch (e) {
      sendError(res, e);
    }
  });

  app.post('/api/noe/acts/propose', requireOwnerToken, async (req, res) => {
    try {
      if (!actPipeline?.propose) return res.status(501).json({ ok: false, error: 'act pipeline not configured' });
      const result = await actPipeline.propose(req.body || {});
      res.status(result?.approvalRequired ? 202 : result?.ok === false ? 403 : 201).json(result);
    } catch (e) {
      sendError(res, e);
    }
  });

  /** Soft-expire stale pending acts (TTL). dryRun default true. Before /:id routes. */
  app.post('/api/noe/acts/expire-pending', requireOwnerToken, (req, res) => {
    try {
      if (!actStore?.expirePending) return res.status(501).json({ ok: false, error: 'act expire not configured' });
      const dryRun = req.body?.dryRun !== false;
      const result = actStore.expirePending({
        dryRun,
        projectId: req.body?.projectId || req.body?.project || 'noe',
        ttlMs: req.body?.ttlMs,
        limit: req.body?.limit,
        nowMs: req.body?.nowMs,
      });
      res.json({ ok: true, ...result });
    } catch (e) {
      sendError(res, e);
    }
  });

  app.post('/api/noe/acts/:id/cancel', requireOwnerToken, (req, res) => {
    try {
      const act = actStore?.cancel?.(req.params.id, { reason: req.body?.reason || 'api_cancel' });
      if (!act) return res.status(404).json({ ok: false, error: 'act not found' });
      res.json({ ok: true, act });
    } catch (e) {
      sendError(res, e);
    }
  });

  app.post('/api/noe/acts/:id/retry', requireOwnerToken, async (req, res) => {
    try {
      if (!actPipeline?.retry) return res.status(501).json({ ok: false, error: 'act pipeline not configured' });
      const result = await actPipeline.retry(req.params.id, req.body || {});
      if (Number(result?.status)) return res.status(Number(result.status)).json(result);
      const code = result?.approvalRequired ? 202 : result?.ok === false ? 403 : 200;
      res.status(code).json(result);
    } catch (e) {
      sendError(res, e);
    }
  });
}
