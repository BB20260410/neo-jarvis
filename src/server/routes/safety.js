// Resilience（CircuitBreaker / Bulkhead / RateLimiter）状态与控制 —— 从 server.js 抽出（D2）。
// 单例 breakers/bulkheads/rateLimiters 直接 import；send500 脱敏 helper 由 server.js 注入。

import { requireOwnerToken } from '../auth/owner-token.js';
import { breakers } from '../../safety/CircuitBreaker.js';
import { bulkheads } from '../../safety/Bulkhead.js';
import { rateLimiters } from '../../safety/RateLimiter.js';

export function registerSafetyRoutes(app, { send500 }) {
  app.get('/api/safety/status', requireOwnerToken, (req, res) => {
    try {
      // 加 process.memoryUsage() 内存监控（前端可拉来画 RSS 趋势）
      const mu = process.memoryUsage();
      res.json({
        ok: true,
        breakers: breakers.all(),
        bulkheads: bulkheads.all(),
        rateLimiters: rateLimiters.all(),
        memory: {
          rss_mb: Math.round(mu.rss / 1024 / 1024),
          heapUsed_mb: Math.round(mu.heapUsed / 1024 / 1024),
          heapTotal_mb: Math.round(mu.heapTotal / 1024 / 1024),
          external_mb: Math.round(mu.external / 1024 / 1024),
          uptime_s: Math.round(process.uptime()),
        },
      });
    } catch (e) { send500(res, e); }
  });

  app.post('/api/safety/breakers/:key/reset', requireOwnerToken, (req, res) => {
    try {
      const ok = breakers.reset(req.params.key);
      if (!ok) return res.status(404).json({ ok: false, error: 'breaker not found' });
      res.json({ ok: true });
    } catch (e) { send500(res, e); }
  });

  // 配置某 adapter 的 rate limit
  app.put('/api/safety/rate-limit/:key', requireOwnerToken, (req, res) => {
    try {
      const { perMinute, burst } = req.body || {};
      const pm = Math.max(1, Math.min(10000, Number(perMinute) || 60));
      const b = Math.max(1, Math.min(1000, Number(burst) || 10));
      rateLimiters.set(req.params.key, { perMinute: pm, burst: b });
      const limiter = rateLimiters.get(req.params.key);
      res.json({ ok: true, snapshot: limiter ? limiter.snapshot() : null });
    } catch (e) { res.status(400).json({ ok: false, error: e.message }); }
  });
}
