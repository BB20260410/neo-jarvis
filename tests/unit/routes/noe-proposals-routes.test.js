import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { requireOwnerToken } from '../../../src/server/auth/owner-token.js';
import { registerNoeProposalRoutes } from '../../../src/server/routes/noeProposals.js';

function makeApp() {
  const routes = [];
  const app = {};
  for (const method of ['get', 'post']) app[method] = (path, ...handlers) => routes.push({ method, path, handlers });
  return { app, routes };
}

function makeReq({ query = {}, params = {}, headers = {}, body = {} } = {}) {
  return {
    query,
    params,
    body,
    get(name) {
      const lower = String(name || '').toLowerCase();
      for (const [key, value] of Object.entries(headers)) {
        if (key.toLowerCase() === lower) return value;
      }
      return undefined;
    },
  };
}

function makeRes() {
  return {
    statusCode: 200,
    payload: undefined,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.payload = body; return this; },
  };
}

function writeJson(file, data) {
  mkdirSync(join(file, '..'), { recursive: true });
  writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`);
}

function writeSelfModelProposalReport(root, patch = { disposition: 'owner-private-disposition' }) {
  writeJson(join(root, 'output/noe-self-model-proposals/self-model.json'), {
    schemaVersion: 1,
    decision: 'proposal_generated',
    generatedAtIso: '2026-06-13T02:00:00.000Z',
    proposal: {
      schemaVersion: 1,
      proposalId: 'self-model-route-proposal',
      createdAt: '2026-06-13T02:00:00.000Z',
      source: 'unit',
      status: 'proposed',
      blockers: [],
      reason: 'route proposal',
      evidenceRefs: ['output/noe-self-maintenance-end2end/latest.json'],
      patch,
      requiresOwnerConfirmation: false,
    },
  });
}

describe('Noe proposal routes', () => {
  it('registers read-only proposal inbox endpoints behind owner-token middleware', async () => {
    const root = mkdtempSync(join(tmpdir(), 'noe-proposal-routes-'));
    try {
      writeJson(join(root, 'output/noe-background-review/review.json'), {
        finishedAt: '2026-06-13T01:00:00.000Z',
        proposals: [
          { id: 'skill-proposal', kind: 'skill', tool: 'skill_draft', createdAt: '2026-06-13T01:00:00.000Z', item: { name: 'new-skill', description: 'draft only' } },
        ],
      });
      mkdirSync(join(root, 'output/noe-memory-candidates'), { recursive: true });
      writeFileSync(join(root, 'output/noe-memory-candidates/pending.jsonl'), `${JSON.stringify({
        candidateId: 'candidate-route-a',
        status: 'pending_owner_review',
        body: 'secret candidate body should not be returned',
        evidenceRefs: ['output/noe-proposal-executions/queues/memory-candidates.jsonl'],
        requiresOwnerApproval: true,
        writesMemoryCore: false,
      })}\n`);
      const { app, routes } = makeApp();
      registerNoeProposalRoutes(app, {
        root,
        sendError: (res, e) => res.status(500).json({ ok: false, error: e.message }),
      });

      expect(routes.map((route) => `${route.method} ${route.path}`)).toEqual([
        'get /api/noe/proposals',
        'get /api/noe/proposals/:id',
        'post /api/noe/proposals/:id/decision',
        'post /api/noe/proposals/:id/execute',
        'post /api/noe/proposals/:id/self-model-apply',
        'get /api/noe/memory-candidates/status',
        'post /api/noe/memory-candidates/review',
        'post /api/noe/memory-candidates/apply',
        'post /api/noe/memory-candidates/rollback',
      ]);
      expect(routes.every((route) => route.handlers[0] === requireOwnerToken)).toBe(true);

      const list = routes.find((route) => route.path === '/api/noe/proposals');
      const listRes = makeRes();
      await list.handlers[1](makeReq({ query: { limit: '10' } }), listRes);
      expect(listRes.payload).toMatchObject({ ok: true, counts: { total: 1, returned: 1 } });
      expect(listRes.payload.proposals[0]).toMatchObject({
        source: 'background_review',
        type: 'skill_draft',
        proposalOnly: true,
        applySupported: false,
      });

      const detail = routes.find((route) => route.path === '/api/noe/proposals/:id');
      const detailRes = makeRes();
      await detail.handlers[1](makeReq({ params: { id: listRes.payload.proposals[0].id } }), detailRes);
      expect(detailRes.payload).toMatchObject({ ok: true, proposal: { title: 'new-skill' } });

      const decision = routes.find((route) => route.path === '/api/noe/proposals/:id/decision');
      const noConfirmRes = makeRes();
      await decision.handlers[1](makeReq({
        params: { id: listRes.payload.proposals[0].id },
        body: { decision: 'approve_for_gated_apply' },
      }), noConfirmRes);
      expect(noConfirmRes.statusCode).toBe(400);
      expect(noConfirmRes.payload).toMatchObject({ ok: false, error: 'owner_confirmation_required' });

      const decisionRes = makeRes();
      await decision.handlers[1](makeReq({
        params: { id: listRes.payload.proposals[0].id },
        body: {
          decision: 'approve_for_gated_apply',
          confirmOwner: true,
          reason: 'contains sk-unitsecret000000000000000000000000000000',
        },
      }), decisionRes);
      expect(decisionRes.payload).toMatchObject({
        ok: true,
        proposal: { status: 'approved_for_gated_apply', ownerDecision: { status: 'approved_for_gated_apply' } },
      });
      expect(JSON.stringify(decisionRes.payload)).not.toContain('unitsecret');

      const execute = routes.find((route) => route.path === '/api/noe/proposals/:id/execute');
      const dryRunRes = makeRes();
      await execute.handlers[1](makeReq({
        params: { id: listRes.payload.proposals[0].id },
        body: { dryRun: true },
      }), dryRunRes);
      expect(dryRunRes.payload).toMatchObject({
        ok: true,
        dryRun: true,
        execution: { status: 'dry_run', effect: 'pending_queue_only' },
      });

      const materializedRes = makeRes();
      await execute.handlers[1](makeReq({
        params: { id: listRes.payload.proposals[0].id },
        body: { dryRun: false, confirmOwner: true },
      }), materializedRes);
      expect(materializedRes.payload).toMatchObject({
        ok: true,
        dryRun: false,
        execution: { status: 'materialized', appliesProposalDirectly: false },
      });

      const statusRoute = routes.find((route) => route.path === '/api/noe/memory-candidates/status');
      const statusRes = makeRes();
      await statusRoute.handlers[1](makeReq({ query: { limit: '5' } }), statusRes);
      expect(statusRes.payload).toMatchObject({
        ok: true,
        pending: { records: 1, pendingOwnerReview: 1 },
        policy: { readOnly: true, noMemoryBodyOutput: true },
      });
      expect(JSON.stringify(statusRes.payload)).not.toContain('secret candidate body');

      const review = routes.find((route) => route.path === '/api/noe/memory-candidates/review');
      const reviewNoConfirm = makeRes();
      await review.handlers[1](makeReq({ body: { dryRun: false } }), reviewNoConfirm);
      expect(reviewNoConfirm.statusCode).toBe(400);
      expect(reviewNoConfirm.payload).toMatchObject({ ok: false, error: 'owner_confirmation_required' });

      const reviewDryRun = makeRes();
      await review.handlers[1](makeReq({ body: { dryRun: true } }), reviewDryRun);
      expect(reviewDryRun.payload).toMatchObject({
        ok: true,
        status: 'skipped',
        writesMemoryCore: false,
      });

      const apply = routes.find((route) => route.path === '/api/noe/memory-candidates/apply');
      const applyDryRun = makeRes();
      await apply.handlers[1](makeReq({ body: { dryRun: true } }), applyDryRun);
      expect(applyDryRun.payload).toMatchObject({
        ok: true,
        status: 'dry_run_ready',
        dryRun: true,
        directWrites: [],
      });

      const rollback = routes.find((route) => route.path === '/api/noe/memory-candidates/rollback');
      const rollbackDryRun = makeRes();
      await rollback.handlers[1](makeReq({ body: { dryRun: true, applyReportRef: '' } }), rollbackDryRun);
      expect(rollbackDryRun.payload).toMatchObject({
        ok: true,
        status: 'skipped',
        dryRun: true,
        writesProductionMemoryCore: false,
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('returns 404 for unknown proposal ids', async () => {
    const root = mkdtempSync(join(tmpdir(), 'noe-proposal-routes-'));
    try {
      const { app, routes } = makeApp();
      registerNoeProposalRoutes(app, { root });
      const detail = routes.find((route) => route.path === '/api/noe/proposals/:id');
      const res = makeRes();
      await detail.handlers[1](makeReq({ params: { id: 'missing' } }), res);
      expect(res.statusCode).toBe(404);
      expect(res.payload).toMatchObject({ ok: false, error: 'proposal_not_found' });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('applies self-model proposals only after owner confirmation and approval', async () => {
    const root = mkdtempSync(join(tmpdir(), 'noe-proposal-routes-self-model-'));
    try {
      writeSelfModelProposalReport(root);
      const { app, routes } = makeApp();
      registerNoeProposalRoutes(app, {
        root,
        selfModelDir: join(root, 'self-model'),
        sendError: (res, e) => res.status(500).json({ ok: false, error: e.message }),
      });

      const list = routes.find((route) => route.path === '/api/noe/proposals');
      const listRes = makeRes();
      await list.handlers[1](makeReq({ query: { source: 'self_model', limit: '10' } }), listRes);
      const id = listRes.payload.proposals[0].id;
      expect(listRes.payload.proposals[0]).toMatchObject({
        source: 'self_model',
        type: 'self_model_diff',
        status: 'proposed',
      });
      expect(JSON.stringify(listRes.payload)).not.toContain('owner-private-disposition');

      const apply = routes.find((route) => route.path === '/api/noe/proposals/:id/self-model-apply');
      const noConfirm = makeRes();
      await apply.handlers[1](makeReq({ params: { id }, body: { dryRun: true } }), noConfirm);
      expect(noConfirm.statusCode).toBe(400);
      expect(noConfirm.payload).toMatchObject({ ok: false, error: 'owner_confirmation_required' });

      const dryRun = makeRes();
      await apply.handlers[1](makeReq({ params: { id }, body: { dryRun: true, confirmOwner: true } }), dryRun);
      expect(dryRun.payload).toMatchObject({
        ok: true,
        dryRun: true,
        selfModelApply: { ok: true, dryRun: true, versionId: 'v001', identityFields: ['disposition', 'name', 'relationship'] },
        policy: { ownerConfirmed: true, noMacroTickApply: true, identityValuesReturned: false },
      });
      expect(JSON.stringify(dryRun.payload)).not.toContain('owner-private-disposition');

      const unapprovedReal = makeRes();
      await apply.handlers[1](makeReq({ params: { id }, body: { dryRun: false, confirmOwner: true } }), unapprovedReal);
      expect(unapprovedReal.statusCode).toBe(409);
      expect(unapprovedReal.payload).toMatchObject({ ok: false, error: 'proposal_not_approved_for_self_model_apply' });

      const decision = routes.find((route) => route.path === '/api/noe/proposals/:id/decision');
      const approved = makeRes();
      await decision.handlers[1](makeReq({
        params: { id },
        body: { decision: 'approve_for_gated_apply', confirmOwner: true, reason: 'route approval' },
      }), approved);
      expect(approved.payload).toMatchObject({ ok: true, proposal: { status: 'approved_for_gated_apply' } });

      const applied = makeRes();
      await apply.handlers[1](makeReq({ params: { id }, body: { dryRun: false, confirmOwner: true } }), applied);
      expect(applied.payload).toMatchObject({
        ok: true,
        dryRun: false,
        selfModelApply: { ok: true, applied: true, versionId: 'v001', previousVersionId: null },
      });
      const versionRaw = readFileSync(join(root, 'self-model', 'v001.json'), 'utf8');
      expect(versionRaw).toContain('owner-private-disposition');
      expect(JSON.stringify(applied.payload)).not.toContain('owner-private-disposition');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('blocks self-model apply when latest.json patch was tampered after approval (TOCTOU)', async () => {
    const root = mkdtempSync(join(tmpdir(), 'noe-proposal-routes-toctou-'));
    try {
      writeSelfModelProposalReport(root, { disposition: 'owner-approved-disposition' });
      const { app, routes } = makeApp();
      registerNoeProposalRoutes(app, {
        root,
        selfModelDir: join(root, 'self-model'),
        sendError: (res, e) => res.status(500).json({ ok: false, error: e.message }),
      });

      const list = routes.find((route) => route.path === '/api/noe/proposals');
      const listRes = makeRes();
      await list.handlers[1](makeReq({ query: { source: 'self_model', limit: '10' } }), listRes);
      const id = listRes.payload.proposals[0].id;

      // owner 审批当前 patch。
      const decision = routes.find((route) => route.path === '/api/noe/proposals/:id/decision');
      const approved = makeRes();
      await decision.handlers[1](makeReq({
        params: { id },
        body: { decision: 'approve_for_gated_apply', confirmOwner: true, reason: 'route approval' },
      }), approved);
      expect(approved.payload).toMatchObject({ ok: true, proposal: { status: 'approved_for_gated_apply' } });

      // 审批后篡改 latest.json 的 patch 值（同 proposalId/同字段，仅值被替换）。
      writeSelfModelProposalReport(root, { disposition: 'MALICIOUS-injected-disposition' });

      const apply = routes.find((route) => route.path === '/api/noe/proposals/:id/self-model-apply');
      const tamperedReal = makeRes();
      await apply.handlers[1](makeReq({ params: { id }, body: { dryRun: false, confirmOwner: true } }), tamperedReal);
      expect(tamperedReal.statusCode).toBe(409);
      expect(tamperedReal.payload).toMatchObject({ ok: false, error: 'proposal_patch_changed_since_approval' });

      // 篡改值绝不能落地。
      expect(existsSync(join(root, 'self-model', 'v001.json'))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
