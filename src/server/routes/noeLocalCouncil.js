import { requireOwnerToken } from '../auth/owner-token.js';
import {
  cleanLocalCouncilReviewRounds,
  DEFAULT_LOCAL_COUNCIL_ROOT,
  discoverLocalModelProviders,
  runLocalModelCouncil,
} from '../../room/NoeLocalModelCouncil.js';
import { defaultNoeUiSignalStore } from '../../runtime/NoeUiSignalStore.js';

function cleanLimit(value, fallback = 4) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(2, Math.min(8, Math.trunc(n)));
}

export function registerNoeLocalCouncilRoutes(app, {
  sendError,
  discover = discoverLocalModelProviders,
  runCouncil = runLocalModelCouncil,
  uiSignalStore = defaultNoeUiSignalStore,
  root = DEFAULT_LOCAL_COUNCIL_ROOT,
  env = process.env,
} = {}) {
  app.get('/api/noe/local-models/discover', requireOwnerToken, async (_req, res) => {
    try {
      const result = await discover({ env });
      return res.json(result);
    } catch (e) {
      return sendError(res, e);
    }
  });

  app.post('/api/noe/local-council/run', requireOwnerToken, async (req, res) => {
    try {
      const body = req.body || {};
      const goal = String(body.goal || body.text || body.query || '').trim();
      if (!goal) return res.status(400).json({ ok: false, error: 'goal required' });
      if (goal.length > 20_000) return res.status(413).json({ ok: false, error: 'goal too large' });
      const uiContext = uiSignalStore?.consume ? uiSignalStore.consume({ limit: body.uiSignalLimit || body.ui_signal_limit || 20 }) : null;
      const evidenceText = [
        body.evidenceText || body.evidence || '',
        uiContext?.contextBlock || '',
      ].filter(Boolean).join('\n\n');
      const result = await runCouncil({
        goal,
        evidenceText,
        requiresVision: body.requiresVision === true,
        images: Array.isArray(body.images) ? body.images.slice(0, 4) : [],
        roundId: body.roundId,
        maxParticipants: cleanLimit(body.maxParticipants),
        reviewRounds: cleanLocalCouncilReviewRounds(body.reviewRounds ?? body.rounds ?? body.discussionRounds, 1),
        maxTokens: Number(body.maxTokens) > 0 ? Number(body.maxTokens) : undefined,
        reviewMaxTokens: Number(body.reviewMaxTokens) > 0 ? Number(body.reviewMaxTokens) : undefined,
        synthesisMaxTokens: Number(body.synthesisMaxTokens) > 0 ? Number(body.synthesisMaxTokens) : undefined,
      }, { root, env });
      const status = result.ok ? 200 : (result.blockers?.some((b) => /requires_two_models|insufficient_available_models/.test(b)) ? 409 : 200);
      return res.status(status).json({ ...result, uiSignalsConsumed: uiContext?.count || 0 });
    } catch (e) {
      return sendError(res, e);
    }
  });
}
