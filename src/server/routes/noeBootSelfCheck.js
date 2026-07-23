// @ts-check
import { compactBootSelfCheck, runNoeBootSelfCheck } from '../../runtime/NoeBootSelfCheck.js';
import { requireOwnerToken } from '../auth/owner-token.js';

/**
 * @typedef {import('../../runtime/NoeBootSelfCheck.js').BootSelfCheckReport} BootSelfCheckReport
 */

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
  return json(res, 500, { ok: false, error: cleanError(error?.message || error || 'boot self-check failed') });
}

function publicPayload(report, mode) {
  const bootSelfCheck = compactBootSelfCheck(report);
  return {
    ok: true,
    mode,
    bootSelfCheck,
    reportPath: bootSelfCheck.reportPath,
    latestPath: bootSelfCheck.latestPath,
  };
}

export function registerNoeBootSelfCheckRoutes(app, {
  rootDir = process.cwd(),
  baseUrl = `http://127.0.0.1:${process.env.PORT || 51835}`,
  fetchImpl = globalThis.fetch,
  collectPanelRuntimePreflight = undefined,
  evaluatePanelRestartPreflight = undefined,
  collectCompanionToolPreflight = undefined,
  sendError = null,
} = {}) {
  const run = ({ repair = false, writeReport = true } = {}) => runNoeBootSelfCheck({
    rootDir,
    baseUrl,
    repair,
    writeReport,
    fetchImpl,
    ...(collectPanelRuntimePreflight ? { collectPanelRuntimePreflight } : {}),
    ...(evaluatePanelRestartPreflight ? { evaluatePanelRestartPreflight } : {}),
    ...(collectCompanionToolPreflight ? { collectCompanionToolPreflight } : {}),
  });

  app.get('/api/noe/boot-self-check/status', requireOwnerToken, async (_req, res) => {
    try {
      const report = await run({ repair: false, writeReport: false });
      return json(res, 200, publicPayload(report, 'status'));
    } catch (error) {
      return sendFailure(res, error, sendError);
    }
  });

  app.post('/api/noe/boot-self-check/run', requireOwnerToken, async (_req, res) => {
    try {
      const report = await run({ repair: false, writeReport: true });
      return json(res, 200, publicPayload(report, 'run'));
    } catch (error) {
      return sendFailure(res, error, sendError);
    }
  });

  app.post('/api/noe/boot-self-check/repair', requireOwnerToken, async (_req, res) => {
    try {
      const report = await run({ repair: true, writeReport: true });
      return json(res, 200, publicPayload(report, 'repair'));
    } catch (error) {
      return sendFailure(res, error, sendError);
    }
  });
}
