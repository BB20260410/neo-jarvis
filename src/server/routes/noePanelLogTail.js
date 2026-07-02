// @ts-check
import {
  collectNoePanelLogTail,
  compactPanelLogTail,
  defaultNoePanelLogPath,
} from '../../runtime/NoePanelLogTail.js';
import { requireOwnerToken } from '../auth/owner-token.js';

function cleanError(value, max = 200) {
  return String(value ?? '')
    .replace(/((?:api[_-]?key|authorization|bearer|cookie|credential|password|private[_-]?key|refresh[_-]?token|secret|session[_-]?token|token)\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;}]+)/gi, '$1[REDACTED]')
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [REDACTED]')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

function json(res, code, body) {
  const target = code === 200 ? res : res.status(code);
  return target.json(body);
}

function sendFailure(res, error, sendError = null) {
  if (typeof sendError === 'function') return sendError(res, error);
  return json(res, 500, { ok: false, error: cleanError(error?.message || error || 'panel log tail failed') });
}

function safeInt(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.floor(n) : fallback;
}

export function registerNoePanelLogTailRoutes(app, {
  collectPanelLogTail = collectNoePanelLogTail,
  defaultLogPath = defaultNoePanelLogPath,
  sendError = null,
} = {}) {
  app.get('/api/noe/panel-log-tail', requireOwnerToken, async (req, res) => {
    try {
      const query = req?.query || {};
      const port = safeInt(query.port ?? process.env.PORT, 51835);
      const report = await collectPanelLogTail({
        file: defaultLogPath({ port, env: process.env }),
        cursor: query.cursor,
        limit: query.limit,
        maxBytes: query.maxBytes ?? query.max_bytes,
      });
      const panelLogTail = compactPanelLogTail(report);
      return json(res, report.ok === true ? 200 : 500, {
        ok: report.ok === true,
        panelLogTail,
        policy: {
          readOnly: true,
          bounded: true,
          redacted: true,
          secretValuesReturned: false,
          actionsPerformed: false,
        },
      });
    } catch (error) {
      return sendFailure(res, error, sendError);
    }
  });
}
