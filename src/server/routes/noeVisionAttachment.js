import { requireOwnerToken } from '../auth/owner-token.js';

const MAX_FRAME = 3_000_000;

export function registerNoeVisionAttachmentRoute(app, { visionSession, sendError } = {}) {
  app.post('/api/noe/vision/attachment', requireOwnerToken, async (req, res) => {
    try {
      const body = req.body || {};
      if (!visionSession?.describeAttachment) return res.status(501).json({ ok: false, error: 'vision attachment not configured' });
      if (!body.frame || typeof body.frame !== 'string') return res.status(400).json({ ok: false, error: 'missing frame' });
      if (body.frame.length > MAX_FRAME) return res.status(413).json({ ok: false, error: 'frame too large' });
      const result = await visionSession.describeAttachment(Buffer.from(body.frame, 'base64'), {
        format: body.format === 'png' ? 'png' : 'jpeg',
        name: String(body.name || '').slice(0, 200),
        type: String(body.type || '').slice(0, 120),
        prompt: typeof body.prompt === 'string' ? body.prompt.slice(0, 600) : undefined,
      });
      return res.json({ ok: true, ...result });
    } catch (e) {
      return typeof sendError === 'function' ? sendError(res, e) : res.status(500).json({ ok: false, error: e?.message || String(e) });
    }
  });
}
