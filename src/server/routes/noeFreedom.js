import { requireOwnerToken } from '../auth/owner-token.js';
import {
  buildNoeFreedomCatalog,
  runNoeFreedomAction,
} from '../../runtime/NoeFreedomExecutor.js';
import { createNoeFreedomSessionStore } from '../../runtime/NoeFreedomSessionStore.js';
import { createNoeFreedomReviewBrain } from '../../runtime/NoeFreedomReviewBrain.js';

function parseBool(value) {
  return value === true || value === 'true' || value === '1';
}

export function registerNoeFreedomRoutes(app, {
  sendError,
  root,
  freedomSessionStore = createNoeFreedomSessionStore(),
  getAdapter = null,
  reviewBrain = null,
} = {}) {
  // B1.3：高风险 real-execute 强制复核闸的生产接线。owner 明确「接线」→ 默认 ON；
  // NOE_FREEDOM_REVIEW_BRAIN=0 可关（退回 review_brain_not_wired 现状）。模型不可用默认 fail-open
  // 降级放行（owner 自由宪法，最坏情况=接线前现状）；NOE_FREEDOM_REVIEW_FAIL_CLOSED=1 改硬阻断。
  const reviewBrainEnabled = process.env.NOE_FREEDOM_REVIEW_BRAIN !== '0';
  const resolvedReviewBrain = reviewBrain
    || (reviewBrainEnabled && typeof getAdapter === 'function'
      ? createNoeFreedomReviewBrain({
        getAdapter,
        failClosed: process.env.NOE_FREEDOM_REVIEW_FAIL_CLOSED === '1',
      })
      : null);
  const freedomDeps = resolvedReviewBrain ? { reviewBrain: resolvedReviewBrain } : {};
  app.get('/api/noe/freedom/capabilities', requireOwnerToken, (_req, res) => {
    try {
      return res.json(buildNoeFreedomCatalog());
    } catch (e) {
      return sendError(res, e);
    }
  });

  app.post('/api/noe/freedom/session/start', requireOwnerToken, (req, res) => {
    try {
      const body = req.body || {};
      const authorization = body.authorization || {};
      const result = freedomSessionStore.start({
        mode: body.mode || authorization.mode || 'developer_unrestricted',
        ownerPresent: parseBool(body.ownerPresent ?? body.owner_present ?? authorization.ownerPresent),
        reason: body.reason || authorization.reason || '',
        source: 'api',
      });
      return res.status(result.ok ? 200 : 409).json(result);
    } catch (e) {
      return sendError(res, e);
    }
  });

  app.get('/api/noe/freedom/session/:sessionId', requireOwnerToken, (req, res) => {
    try {
      const result = freedomSessionStore.get(req.params?.sessionId || req.query?.sessionId || req.query?.session_id);
      return res.status(result.ok ? 200 : 404).json(result);
    } catch (e) {
      return sendError(res, e);
    }
  });

  app.post('/api/noe/freedom/dry-run', requireOwnerToken, async (req, res) => {
    try {
      const body = req.body || {};
      const result = await runNoeFreedomAction({
        actionId: body.actionId || body.action || body.toolId || body.tool_id,
        args: body.args || body.input || {},
        authorization: { ...(body.authorization || {}), mode: body.authorization?.mode || 'dry_run' },
        trustManifest: body.trustManifest || body.trust_manifest || body.manifest,
        allowlist: body.allowlist,
        realExecute: false,
        persistLedger: parseBool(body.persistLedger || body.persist_ledger),
        runLedgerOutDir: body.runLedgerOutDir || body.run_ledger_out_dir,
        runId: body.runId || body.run_id,
        root,
        evidenceRefs: body.evidenceRefs || body.evidence_refs || {},
      });
      return res.status(result.ok ? 200 : 409).json(result);
    } catch (e) {
      return sendError(res, e);
    }
  });

  app.post('/api/noe/freedom/execute', requireOwnerToken, async (req, res) => {
    try {
      const body = req.body || {};
      const realExecute = parseBool(body.realExecute || body.real_execute || body.execute);
      const rawAuthorization = body.authorization || {};
      const ownerPresentInput = body.ownerPresent ?? body.owner_present ?? rawAuthorization.ownerPresent ?? rawAuthorization.owner_present;
      const routeAuthorization = {
        ...rawAuthorization,
        mode: body.mode || rawAuthorization.mode || (realExecute ? 'developer_unrestricted' : 'dry_run'),
        ownerPresent: ownerPresentInput === undefined ? realExecute : parseBool(ownerPresentInput),
      };
      const sessionAuthorization = freedomSessionStore.resolveAuthorization({ authorization: routeAuthorization });
      if (!sessionAuthorization.ok) {
        return res.status(409).json({
          ok: false,
          blockers: sessionAuthorization.errors || ['freedom_session_authorization_failed'],
          authorization: { sessionId: sessionAuthorization.sessionId || '' },
        });
      }
      const result = await runNoeFreedomAction({
        actionId: body.actionId || body.action || body.toolId || body.tool_id,
        args: body.args || body.input || {},
        authorization: sessionAuthorization.authorization,
        trustManifest: body.trustManifest || body.trust_manifest || body.manifest,
        allowlist: body.allowlist,
        realExecute,
        persistLedger: parseBool(body.persistLedger || body.persist_ledger),
        runLedgerOutDir: body.runLedgerOutDir || body.run_ledger_out_dir,
        runId: body.runId || body.run_id,
        root,
        evidenceRefs: body.evidenceRefs || body.evidence_refs || {},
        deps: freedomDeps,
      });
      return res.status(result.ok ? 200 : 409).json(result);
    } catch (e) {
      return sendError(res, e);
    }
  });
}
