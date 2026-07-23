// @ts-check
/**
 * Minimal product daily settings routes (model base URL + model id + voice).
 */
import { requireOwnerToken } from '../auth/owner-token.js';
import {
  NoeProductDailySettingsStore,
  defaultProductDailySettingsStore,
  productSettingsDtoHasNoSecrets,
} from '../../runtime/NoeProductDailySettings.js';
import { buildEvolutionDashboard } from '../../runtime/NoeEvolutionDashboard.js';
import { buildPendingConfirmsFromStores } from '../../runtime/NoePendingConfirmCard.js';
import { buildFileChangeDiffPreview } from '../../runtime/NoeFileChangeDiffPreview.js';
import {
  buildMemoryExportPackage,
  memoryExportPassesSecretScan,
} from '../../runtime/NoeMemoryExportPackage.js';

/**
 * @param {import('express').Application} app
 * @param {object} [deps]
 */
export function registerNoeProductSettingsRoutes(app, deps = {}) {
  const settingsStore = deps.productDailySettingsStore || defaultProductDailySettingsStore;
  const sendError = deps.sendError || ((res, e) => {
    const msg = e?.message || String(e);
    if (/required|invalid|must be/i.test(msg)) return res.status(400).json({ ok: false, error: msg });
    return res.status(500).json({ ok: false, error: msg });
  });
  const approvalStore = deps.approvalStore || null;
  const actStore = deps.actStore || null;
  const memory = deps.memory || null;

  app.get('/api/noe/product-settings', requireOwnerToken, (_req, res) => {
    try {
      const settings = settingsStore.status();
      if (!productSettingsDtoHasNoSecrets(settings)) {
        return res.status(500).json({ ok: false, error: 'settings_dto_secret_leak' });
      }
      return res.json({ ok: true, settings });
    } catch (e) {
      return sendError(res, e);
    }
  });

  app.post('/api/noe/product-settings', requireOwnerToken, (req, res) => {
    try {
      const body = req.body || {};
      // Never accept raw apiKey into this minimal form store.
      const patch = {
        modelBaseUrl: body.modelBaseUrl ?? body.baseUrl,
        modelId: body.modelId ?? body.model,
        voiceEnabled: body.voiceEnabled ?? body.voice?.enabled,
      };
      const settings = settingsStore.update(patch);
      if (!productSettingsDtoHasNoSecrets(settings)) {
        return res.status(500).json({ ok: false, error: 'settings_dto_secret_leak' });
      }
      return res.json({ ok: true, settings });
    } catch (e) {
      return sendError(res, e);
    }
  });

  /** Pending confirm queue summary for Home chips + cards.
   * ActStore has no status "pending" (throws); use awaiting_approval via helper. */
  app.get('/api/noe/pending-confirms', requireOwnerToken, (req, res) => {
    try {
      const projectId = req.query.project || req.query.projectId || 'noe';
      const payload = buildPendingConfirmsFromStores({
        actStore,
        approvalStore,
        projectId,
        limit: 50,
      });
      return res.json(payload);
    } catch (e) {
      return sendError(res, e);
    }
  });

  /** Pure diff preview (no write). */
  app.post('/api/noe/diff-preview', requireOwnerToken, (req, res) => {
    try {
      const body = req.body || {};
      const preview = buildFileChangeDiffPreview({
        path: body.path || body.filePath,
        before: body.before ?? body.oldContent,
        after: body.after ?? body.newContent,
      });
      return res.json({ ok: true, preview });
    } catch (e) {
      return sendError(res, e);
    }
  });

  /** Evolution dry-run dashboard (read-only, no secrets). */
  app.get('/api/noe/evolution-dashboard', requireOwnerToken, (_req, res) => {
    try {
      const dash = buildEvolutionDashboard({ env: process.env });
      return res.json({ ok: true, dashboard: dash });
    } catch (e) {
      return sendError(res, e);
    }
  });

  /** Memory export package (JSON + optional markdown field) with secret scrub. */
  app.get('/api/noe/memory-export-package', requireOwnerToken, (req, res) => {
    try {
      if (!memory?.recall) {
        return res.json({
          ok: true,
          enabled: false,
          package: buildMemoryExportPackage([]),
        });
      }
      const includeHidden = req.query.includeHidden === '1';
      const limit = Math.min(500, Math.max(1, Number(req.query.limit) || 100));
      const projectId = req.query.project || req.query.projectId || undefined;
      const items = memory.recall({
        q: '',
        projectId,
        limit,
        includeHidden,
        bumpHits: false,
      }) || [];
      const pkg = buildMemoryExportPackage(items, { format: 'both' });
      if (pkg.json && !memoryExportPassesSecretScan(pkg.json)) {
        return res.status(500).json({ ok: false, error: 'export_secret_scan_failed' });
      }
      if (pkg.markdown && !memoryExportPassesSecretScan(pkg.markdown)) {
        return res.status(500).json({ ok: false, error: 'export_secret_scan_failed' });
      }
      return res.json({ ok: true, enabled: true, package: pkg });
    } catch (e) {
      return sendError(res, e);
    }
  });
}

export { NoeProductDailySettingsStore };
