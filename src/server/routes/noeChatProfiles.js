import { requireOwnerToken } from '../auth/owner-token.js';
import { discoverChatModels } from '../../voice/ChatModelCatalog.js';

const MAX_BODY = 10_000;

export function registerNoeChatProfileRoutes(app, { chatProfileStore, getAdapter = null, sendError } = {}) {
  const registerPatch = typeof app.patch === 'function' ? app.patch.bind(app) : app.post.bind(app);
  app.get('/api/noe/chat/profiles', requireOwnerToken, (_req, res) => {
    try {
      return res.json({ ok: true, profiles: chatProfileStore.publicList(), defaultId: 'default' });
    } catch (e) { return sendError(res, e); }
  });

  app.get('/api/noe/chat/models', requireOwnerToken, async (_req, res) => {
    try {
      return res.json(await discoverChatModels({ getAdapter }));
    } catch (e) { return sendError(res, e); }
  });

  app.post('/api/noe/chat/profiles', requireOwnerToken, (req, res) => {
    try {
      if (JSON.stringify(req.body || {}).length > MAX_BODY) return res.status(413).json({ ok: false, error: 'profile body too large' });
      const profile = chatProfileStore.upsert(req.body || {});
      return res.status(201).json({ ok: true, profile, profiles: chatProfileStore.publicList() });
    } catch (e) { return sendError(res, e); }
  });

  registerPatch('/api/noe/chat/profiles/:id', requireOwnerToken, (req, res) => {
    try {
      if (JSON.stringify(req.body || {}).length > MAX_BODY) return res.status(413).json({ ok: false, error: 'profile body too large' });
      const profile = chatProfileStore.upsert({ ...(req.body || {}), id: req.params.id });
      return res.json({ ok: true, profile, profiles: chatProfileStore.publicList() });
    } catch (e) { return sendError(res, e); }
  });

  app.delete('/api/noe/chat/profiles/:id', requireOwnerToken, (req, res) => {
    try {
      const ok = chatProfileStore.delete(req.params.id);
      if (!ok) return res.status(404).json({ ok: false, error: 'profile not found' });
      return res.json({ ok: true, profiles: chatProfileStore.publicList() });
    } catch (e) {
      if (/built-in profile/i.test(e?.message || '')) return res.status(400).json({ ok: false, error: e.message });
      return sendError(res, e);
    }
  });
}
