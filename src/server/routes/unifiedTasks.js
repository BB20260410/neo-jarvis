// @ts-check
/**
 * UnifiedTask HTTP surface (env-gated).
 * Mount only when NOE_UNIFIED_TASK_WRITE=1 or NOE_UNIFIED_TASK_READ=1.
 * Final state only via UnifiedTaskStore.
 */
import { Router } from 'express';
import path from 'node:path';
import os from 'node:os';
import {
  getUnifiedTaskStore,
  readUnifiedTaskMigrationFlags,
} from '../../runtime/UnifiedTaskStore.js';
import { reopenUnifiedTaskSqliteStore } from '../../runtime/UnifiedTaskSqlite.js';
import { createAgentRuntime } from '../../runtime/AgentRuntime.js';
import { renderOrdinaryReceipt, buildFrontDoorManifest } from '../../runtime/NoeTaskReceiptView.js';
import { fromThrown, toPublicError } from '../../runtime/NoeErrorEnvelope.js';

/**
 * Resolve task store: optional Sqlite when NOE_UNIFIED_TASK_SQLITE_PATH set
 * (or isolation auto path). Never silently opens live panel.db.
 * @param {NodeJS.ProcessEnv|Record<string,string|undefined>} env
 * @param {import('../../runtime/UnifiedTaskStore.js').UnifiedTaskStore} [override]
 */
export function resolveUnifiedTaskStore(env = process.env, override = null) {
  if (override) return override;
  const sqlitePath = String(env.NOE_UNIFIED_TASK_SQLITE_PATH || '').trim();
  if (sqlitePath) {
    // Refuse if path equals live panel.db
    const live = path.join(os.homedir(), '.noe-panel', 'panel.db');
    if (path.resolve(sqlitePath) === path.resolve(live)) {
      throw new Error('unified_task_sqlite_must_not_be_live_panel_db');
    }
    return reopenUnifiedTaskSqliteStore(sqlitePath, { env });
  }
  return getUnifiedTaskStore({ env });
}

/**
 * @param {object} [opts]
 * @param {import('../../runtime/UnifiedTaskStore.js').UnifiedTaskStore} [opts.taskStore]
 * @param {import('../../runtime/AgentRuntime.js').AgentRuntime} [opts.runtime]
 * @param {NodeJS.ProcessEnv|Record<string,string|undefined>} [opts.env]
 */
export function createUnifiedTasksRouter(opts = {}) {
  const env = opts.env || process.env;
  const flags = readUnifiedTaskMigrationFlags(env);
  const store = resolveUnifiedTaskStore(env, opts.taskStore || null);
  const runtime = opts.runtime || createAgentRuntime({ taskStore: store, env });
  const router = Router();

  router.get('/api/noe/front-door', (_req, res) => {
    res.json({ ok: true, flags, manifest: buildFrontDoorManifest({ taskStore: store }) });
  });

  router.get('/api/noe/unified-tasks', (req, res) => {
    if (!flags.unifiedTaskRead && !flags.unifiedTaskWrite) {
      return res.status(404).json({ ok: false, error: 'unified_task_routes_disabled' });
    }
    const limit = Number(req.query.limit || 50);
    res.json({ ok: true, flags, tasks: store.list({ status: req.query.status, limit }) });
  });

  router.get('/api/noe/unified-tasks/:id', (req, res) => {
    if (!flags.unifiedTaskRead && !flags.unifiedTaskWrite) {
      return res.status(404).json({ ok: false, error: 'unified_task_routes_disabled' });
    }
    const task = store.get(req.params.id);
    if (!task) return res.status(404).json({ ok: false, error: 'not_found' });
    res.json({ ok: true, task, receipt: renderOrdinaryReceipt(task.id, { taskStore: store }) });
  });

  router.post('/api/noe/unified-tasks', async (req, res) => {
    if (!flags.unifiedTaskWrite) {
      return res.status(403).json({
        ok: false,
        error: 'unified_task_write_disabled',
        errorEnvelope: toPublicError(
          fromThrown(new Error('unified_task_write_disabled'), {
            code: 'unified_task_write_disabled',
            category: 'auth',
          }),
        ),
      });
    }
    try {
      const body = req.body || {};
      const accepted = await runtime.acceptGoal({
        goal: body.goal || body.title || '',
        sourceDigest: body.sourceDigest,
        runtimeConfigDigest: body.runtimeConfigDigest,
      });
      res.status(201).json({ ok: true, ...accepted });
    } catch (e) {
      const envelope = toPublicError(
        fromThrown(e, { code: 'unified_task_accept_failed', category: 'validation' }),
      );
      res.status(400).json({ ok: false, error: envelope.message, errorEnvelope: envelope });
    }
  });

  router.post('/api/noe/unified-tasks/:id/complete', async (req, res) => {
    if (!flags.unifiedTaskWrite) {
      return res.status(403).json({
        ok: false,
        error: 'unified_task_write_disabled',
        errorEnvelope: toPublicError(
          fromThrown(new Error('unified_task_write_disabled'), {
            code: 'unified_task_write_disabled',
            category: 'auth',
          }),
        ),
      });
    }
    try {
      const result = await runtime.completeTask(req.params.id, req.body || {});
      res.json({ ok: true, ...result });
    } catch (e) {
      const envelope = toPublicError(
        fromThrown(e, { code: 'unified_task_complete_failed', category: 'validation' }),
      );
      res.status(400).json({ ok: false, error: envelope.message, errorEnvelope: envelope });
    }
  });

  return router;
}

/**
 * Mount on main Express app (server.js). Safe when flags off (routes 403/404).
 * @param {import('express').Express} app
 * @param {object} [opts]
 */
export function registerUnifiedTasksRoutes(app, opts = {}) {
  const router = createUnifiedTasksRouter(opts);
  app.use(router);
}

export default createUnifiedTasksRouter;
