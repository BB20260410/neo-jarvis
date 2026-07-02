import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { requireOwnerToken } from '../../../src/server/auth/owner-token.js';
import { registerNoeMissionRoutes } from '../../../src/server/routes/noeMission.js';
import { NoeMissionStore } from '../../../src/runtime/mission/NoeMissionStore.js';

function makeApp() {
  const routes = [];
  const app = {};
  for (const method of ['get', 'post']) app[method] = (path, ...handlers) => routes.push({ method, path, handlers });
  return { app, routes };
}

function makeRes() {
  return {
    statusCode: 200,
    payload: undefined,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.payload = body; return this; },
  };
}

async function call(routes, method, path, req = {}) {
  const route = routes.find((item) => item.method === method && item.path === path);
  expect(route).toBeTruthy();
  const res = makeRes();
  await route.handlers[route.handlers.length - 1]({ body: {}, query: {}, params: {}, ...req }, res);
  return res;
}

function missionContract(missionId = 'route-mission') {
  const proofRef = `output/noe-missions/${missionId}/artifacts/proof.json`;
  const reportRef = `output/noe-missions/${missionId}/artifacts/final-report.json`;
  return {
    missionId,
    objective: 'show mission runtime status in the panel',
    scope: ['output/noe-missions/**'],
    forbidden: ['.env', '51735'],
    completionCriteria: [
      { id: 'proof-readable', type: 'evidence_ref_exists', ref: proofRef },
      { id: 'report-traces', type: 'final_report_traces_evidence', reportRef, evidenceRefs: [proofRef] },
    ],
    evidenceRequirements: [{ id: 'proof', ref: proofRef, required: true }],
    rollbackPlan: ['delete the temp mission output directory'],
    autonomyLevel: 'read_only',
    reviewPolicy: { ownerGate: ['external_write'] },
    expectedArtifacts: [{ id: 'final', type: 'final_report', ref: reportRef }],
    plan: [{ id: 'write-proof', type: 'write_artifact', name: 'proof.json', content: { ok: true } }],
  };
}

async function withStore(fn) {
  const root = mkdtempSync(join(tmpdir(), 'noe-mission-route-'));
  try {
    const store = new NoeMissionStore({ root });
    return await fn({ root, store });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

describe('Noe mission routes', () => {
  it('registers owner-token protected mission endpoints', () => {
    const { app, routes } = makeApp();
    registerNoeMissionRoutes(app, {});

    expect(routes.map((route) => `${route.method} ${route.path}`).sort()).toEqual([
      'get /api/noe/missions',
      'get /api/noe/missions/:missionId',
      'post /api/noe/missions/:missionId/review',
    ]);
    expect(routes.every((route) => route.handlers[0] === requireOwnerToken)).toBe(true);
  });

  it('lists and details mission runtime status without exposing raw event bulk by default', () => withStore(async ({ store }) => {
    store.createMission(missionContract('route-list'));
    store.writeArtifact('route-list', 'proof.json', { ok: true });
    const { app, routes } = makeApp();
    registerNoeMissionRoutes(app, { store });

    const list = await call(routes, 'get', '/api/noe/missions');
    expect(list.payload.ok).toBe(true);
    expect(list.payload.missions[0]).toMatchObject({
      missionId: 'route-list',
      status: 'running',
      currentCursor: 0,
      totalActions: 1,
      evidenceCount: expect.any(Number),
    });

    const detail = await call(routes, 'get', '/api/noe/missions/:missionId', { params: { missionId: 'route-list' } });
    expect(detail.payload.ok).toBe(true);
    expect(detail.payload.contract.objective).toContain('mission runtime status');
    expect(detail.payload.refs.events).toBe('output/noe-missions/route-list/events.jsonl');
    expect(detail.payload.events.length).toBeGreaterThan(0);
  }));

  it('records owner approval decisions into state, checkpoint, and events', () => withStore(async ({ store }) => {
    store.createMission(missionContract('route-approve'));
    store.updateState('route-approve', (state) => ({
      ...state,
      status: 'waiting_approval',
      phase: 'waiting_approval',
      current_slice: 1,
      waitingApproval: {
        actionId: 'publish-proof',
        reasons: ['owner_gate_required:external_write'],
        risks: ['external_write'],
        missionAutonomyLevel: 'read_only',
        requiredAutonomyLevel: 'external_write',
        at: '2026-06-13T00:00:00.000Z',
      },
    }));
    const { app, routes } = makeApp();
    registerNoeMissionRoutes(app, { store, now: () => Date.parse('2026-06-13T00:01:00.000Z') });

    const approved = await call(routes, 'post', '/api/noe/missions/:missionId/review', {
      params: { missionId: 'route-approve' },
      body: { decision: 'approved', note: 'owner confirmed' },
    });
    const state = store.readState('route-approve');
    const events = store.readEvents('route-approve', { limit: 100 });

    expect(approved.payload).toMatchObject({ ok: true, decision: 'approved' });
    expect(state.status).toBe('running');
    expect(state.waitingApproval).toBe(null);
    expect(state.reviewApprovals['publish-proof']).toMatchObject({ decision: 'approved', decidedBy: 'owner' });
    expect(state.evidenceRefs.some((ref) => ref.includes('/checkpoints/'))).toBe(true);
    expect(events.some((event) => event.type === 'mission.approval.decided' && event.decision === 'approved')).toBe(true);
  }));

  it('blocks rejected approvals and refuses unsafe mission ids', () => withStore(async ({ store }) => {
    store.createMission(missionContract('route-reject'));
    store.updateState('route-reject', (state) => ({
      ...state,
      status: 'waiting_approval',
      phase: 'waiting_approval',
      waitingApproval: { actionId: 'a', reasons: ['owner_gate_required:external_write'], risks: ['external_write'] },
    }));
    const { app, routes } = makeApp();
    registerNoeMissionRoutes(app, { store });

    const rejected = await call(routes, 'post', '/api/noe/missions/:missionId/review', {
      params: { missionId: 'route-reject' },
      body: { decision: 'rejected' },
    });
    expect(rejected.payload.mission.status).toBe('blocked');
    expect(store.readState('route-reject').blockers[0].reason).toContain('approval_rejected:a');

    const bad = await call(routes, 'get', '/api/noe/missions/:missionId', { params: { missionId: '../route-reject' } });
    expect(bad.statusCode).toBe(400);
  }));
});
