import { requireOwnerToken } from '../auth/owner-token.js';
import { NoeTaskFlowStore } from '../../runtime/NoeTaskFlowStore.js';

function clean(value, max = 2000) {
  return String(value || '').trim().slice(0, max);
}

function parseLimit(value, fallback = 20) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(1, Math.min(100, Math.trunc(n)));
}

function cleanSteps(value) {
  if (!Array.isArray(value)) return [];
  return value.map((step) => clean(step, 120)).filter(Boolean).slice(0, 20);
}

export function registerNoeTaskflowRoutes(app, {
  sendError,
  store = new NoeTaskFlowStore(),
} = {}) {
  app.get('/api/noe/taskflows', requireOwnerToken, (req, res) => {
    try {
      return res.json({ ok: true, flows: store.list({ limit: parseLimit(req.query.limit) }) });
    } catch (e) {
      return sendError(res, e);
    }
  });

  app.post('/api/noe/taskflows', requireOwnerToken, (req, res) => {
    try {
      const body = req.body || {};
      const flow = store.createFlow({
        flowId: body.flowId || body.flow_id,
        kind: body.kind || 'task',
        goal: body.goal || '',
        steps: cleanSteps(body.steps),
        metadata: body.metadata && typeof body.metadata === 'object' && !Array.isArray(body.metadata) ? body.metadata : {},
      });
      return res.status(201).json({ ok: true, flow, summary: store.summarize(flow) });
    } catch (e) {
      return sendError(res, e);
    }
  });

  app.get('/api/noe/taskflows/:id', requireOwnerToken, (req, res) => {
    try {
      const flow = store.load(req.params.id);
      if (!flow) return res.status(404).json({ ok: false, error: 'taskflow not found' });
      return res.json({ ok: true, flow, summary: store.summarize(flow), validation: store.validate(flow) });
    } catch (e) {
      return sendError(res, e);
    }
  });

  app.post('/api/noe/taskflows/:id/steps/:stepId', requireOwnerToken, (req, res) => {
    try {
      const body = req.body || {};
      const flow = store.transition(req.params.id, req.params.stepId, body.status, {
        evidenceRefs: Array.isArray(body.evidenceRefs) ? body.evidenceRefs : [],
        notes: body.notes || '',
      });
      return res.json({ ok: true, flow, summary: store.summarize(flow), validation: store.validate(flow) });
    } catch (e) {
      return sendError(res, e);
    }
  });

  app.post('/api/noe/taskflows/:id/cancel', requireOwnerToken, (req, res) => {
    try {
      const flow = store.requestCancel(req.params.id, req.body?.reason || 'ui_cancel_requested');
      return res.json({ ok: true, flow, summary: store.summarize(flow), validation: store.validate(flow) });
    } catch (e) {
      return sendError(res, e);
    }
  });
}
