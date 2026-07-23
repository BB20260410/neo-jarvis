// @ts-check
// P0.5 emergency stop HTTP 控制：owner 一键激活/解除自主停机 + 查状态。
//   激活 = 写停机信号文件（NoeEmergencyStop.readEmergencyStop 读它，心跳泵据此跳过自主作业）。
//   注意：env NOE_EMERGENCY_STOP=1 是更高优先级的强停（plist 级），API 解除只删文件、不能覆盖 env——
//   故响应一律回 readEmergencyStop 的真实状态（诚实：env 仍 set 时 off 后仍 stopped）。
import { existsSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { requireOwnerToken } from '../auth/owner-token.js';
import { readEmergencyStop, EMERGENCY_STOP_FILE } from '../../security/NoeEmergencyStop.js';

/**
 * @param {import('express').Express} app
 * @param {{ stopFile?: string, now?: () => Date, sendError?: Function }} [deps]
 */
export function registerNoeEmergencyStopRoutes(app, { stopFile = EMERGENCY_STOP_FILE, now = () => new Date(), sendError } = {}) {
  const fail = (res, e) => (typeof sendError === 'function' ? sendError(res, e) : res.status(500).json({ ok: false, error: String((e && e.message) || e) }));

  app.get('/api/noe/emergency-stop', requireOwnerToken, (req, res) => {
    try { res.json({ ok: true, ...readEmergencyStop({ stopFile }) }); } catch (e) { return fail(res, e); }
  });

  app.post('/api/noe/emergency-stop', requireOwnerToken, (req, res) => {
    try {
      const body = req.body || {};
      if (body.on === true) {
        const reason = String(body.reason || `owner 一键急停 ${now().toISOString()}`).slice(0, 200);
        try { mkdirSync(dirname(stopFile), { recursive: true, mode: 0o700 }); } catch { /* 目录已存在 */ }
        writeFileSync(stopFile, reason, { mode: 0o600 });
      } else {
        try { if (existsSync(stopFile)) rmSync(stopFile); } catch { /* 已不存在 */ }
      }
      // 回真实状态（env 强停时 off 后仍 stopped——不骗 owner）。
      res.json({ ok: true, ...readEmergencyStop({ stopFile }) });
    } catch (e) { return fail(res, e); }
  });
}
