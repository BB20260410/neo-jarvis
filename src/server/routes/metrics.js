// Metrics 查询路由 —— 从 server.js 抽出（D2）。
// overview / timeseries / by-adapter / by-room / pricing 五个只读查询。
// 注：/api/metrics/health 仍留在 server.js（依赖共享的 fileSizeMB 且与 runHealthSweep 耦合）。
// parseMetricsRange 移入本模块；metricsStore / roomStore / send500 由 server.js 注入。

import { requireOwnerToken } from '../auth/owner-token.js';
import { listPricing } from '../../metrics/pricing.js';

function parseMetricsRange(req) {
  const { from, to, bucket } = req.query || {};
  const result = {};
  if (typeof from === 'string' && from.length > 0 && from.length < 64) {
    const d = new Date(from);
    if (!isNaN(d)) result.from = d.toISOString();
  }
  if (typeof to === 'string' && to.length > 0 && to.length < 64) {
    const d = new Date(to);
    if (!isNaN(d)) result.to = d.toISOString();
  }
  if (bucket === 'hour' || bucket === 'day') result.bucket = bucket;
  return result;
}

export function registerMetricsRoutes(app, { metricsStore, roomStore, send500 }) {
  app.get('/api/metrics/overview', requireOwnerToken, (req, res) => {
    try {
      const ov = metricsStore.overview({ roomStore });
      res.json({ ok: true, ...ov });
    } catch (e) {
      send500(res, e);
    }
  });

  app.get('/api/metrics/timeseries', requireOwnerToken, (req, res) => {
    try {
      const { from, to, bucket = 'hour' } = parseMetricsRange(req);
      res.json({ ok: true, ...metricsStore.aggregate({ from, to, bucket }) });
    } catch (e) {
      send500(res, e);
    }
  });

  app.get('/api/metrics/by-adapter', requireOwnerToken, (req, res) => {
    try {
      const { from, to } = parseMetricsRange(req);
      res.json({ ok: true, ...metricsStore.byAdapter({ from, to }) });
    } catch (e) {
      send500(res, e);
    }
  });

  // trace 时间线 — 拿某房的所有 turn
  app.get('/api/metrics/by-room', requireOwnerToken, (req, res) => {
    try {
      const roomId = String(req.query.roomId || '');
      if (!/^[0-9a-f-]{36}$/.test(roomId)) return res.status(400).json({ ok: false, error: 'roomId 格式错' });
      const { from, to } = parseMetricsRange(req);
      res.json({ ok: true, ...metricsStore.byRoom({ roomId, from, to }) });
    } catch (e) {
      send500(res, e);
    }
  });

  app.get('/api/metrics/pricing', requireOwnerToken, (req, res) => {
    try {
      res.json({ ok: true, pricing: listPricing(), note: '估算可能与实际账单 ±20% 偏差' });
    } catch (e) {
      send500(res, e);
    }
  });
}
