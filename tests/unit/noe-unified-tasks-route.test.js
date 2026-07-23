// @ts-check
import { describe, expect, it, beforeEach } from 'vitest';
import express from 'express';
import { createUnifiedTasksRouter } from '../../src/server/routes/unifiedTasks.js';
import {
  UnifiedTaskStore,
  resetUnifiedTaskStoreForTests,
} from '../../src/runtime/UnifiedTaskStore.js';

async function withServer(env, fn) {
  resetUnifiedTaskStoreForTests();
  const store = new UnifiedTaskStore({ env });
  const app = express();
  app.use(express.json());
  app.use(createUnifiedTasksRouter({ env, taskStore: store }));
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const { port } = server.address();
  try {
    await fn({ port, store, base: `http://127.0.0.1:${port}` });
  } finally {
    await new Promise((r) => server.close(() => r(null)));
  }
}

describe('unifiedTasks routes (env-gated)', () => {
  beforeEach(() => {
    resetUnifiedTaskStoreForTests();
  });

  it('disables write when flag off', async () => {
    await withServer({ NOE_UNIFIED_TASK_WRITE: '0', NOE_UNIFIED_TASK_READ: '0' }, async ({ base }) => {
      const r = await fetch(`${base}/api/noe/unified-tasks`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ goal: 'x' }),
      });
      expect(r.status).toBe(403);
      const j = await r.json();
      expect(j.errorEnvelope?.kind).toBe('neo.error.envelope.v1');
      expect(j.errorEnvelope?.code).toBe('unified_task_write_disabled');
      expect(j.errorEnvelope).not.toHaveProperty('cause');
    });
  });

  it('front-door always readable', async () => {
    await withServer({}, async ({ base }) => {
      const r = await fetch(`${base}/api/noe/front-door`);
      const j = await r.json();
      expect(j.ok).toBe(true);
      expect(j.manifest.ordinaryEntries).toHaveLength(5);
    });
  });

  it('write path creates task and refuses false complete', async () => {
    await withServer({ NOE_UNIFIED_TASK_WRITE: '1', NOE_UNIFIED_TASK_READ: '1' }, async ({ base }) => {
      const created = await fetch(`${base}/api/noe/unified-tasks`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ goal: 'route canary', sourceDigest: 'sha256:r' }),
      });
      expect(created.status).toBe(201);
      const c = await created.json();
      expect(c.taskId).toBeTruthy();

      const bad = await fetch(`${base}/api/noe/unified-tasks/${c.taskId}/complete`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          exitCode: 0,
          verified: false,
          hasValidArtifacts: true,
          hasEvidence: true,
          validatorsPass: true,
        }),
      });
      const bj = await bad.json();
      expect(bj.task.status).not.toBe('completed');
      // completeTask returns { task, receipt } where receipt is buildReceipt (displayCompleted)
      // or route may wrap — assert task not completed is enough for false-complete denial
      expect(bj.receipt?.displayCompleted === true || bj.receipt?.ordinary?.completed === true).toBe(false);

      const good = await fetch(`${base}/api/noe/unified-tasks/${c.taskId}/complete`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          exitCode: 0,
          verified: true,
          hasValidArtifacts: true,
          hasEvidence: true,
          validatorsPass: true,
          sourceDigestMatch: true,
          approvalsSettled: true,
          highRiskActsSettled: true,
          sourceDigest: 'sha256:r',
          artifacts: [{ path: 'a.md', sha256: '1' }],
          summary: 'ok',
        }),
      });
      const gj = await good.json();
      expect(gj.task.status).toBe('completed');
    });
  });
});
