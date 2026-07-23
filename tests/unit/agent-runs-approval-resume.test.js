import { describe, it, expect, beforeEach, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  latest: vi.fn(),
  buildReview: vi.fn(),
  buildAudit: vi.fn(),
  verifyGate: vi.fn(),
}));

vi.mock('../../src/server/auth/owner-token.js', () => ({
  requireOwnerToken: (_req, _res, next) => next(),
}));

vi.mock('../../src/agents/AgentRunApprovalResumeReview.js', () => ({
  latestApprovalResumeManifest: mocks.latest,
  buildApprovalResumeReview: mocks.buildReview,
  buildApprovalResumeGateAudit: mocks.buildAudit,
  verifyApprovalResumeReviewGate: mocks.verifyGate,
}));

import { registerAgentRunApprovalResumeRoutes } from '../../src/server/routes/agentRunsApprovalResume.js';

function createMockApp() {
  const routes = [];
  const app = {
    get: (path, ...handlers) => {
      routes.push({ method: 'get', path, handlers });
    },
    post: (path, ...handlers) => {
      routes.push({ method: 'post', path, handlers });
    },
  };
  return { app, routes };
}

function findRoute(routes, method, path) {
  const route = routes.find((r) => r.method === method && r.path === path);
  if (!route) throw new Error(`Route not found: ${method} ${path}`);
  return route;
}

function createMockRes() {
  const res = {
    statusCode: 200,
    body: undefined,
    headers: {},
    status: vi.fn(function (code) {
      this.statusCode = code;
      return this;
    }),
    json: vi.fn(function (data) {
      this.body = data;
      return this;
    }),
    send: vi.fn(function (data) {
      this.body = data;
      return this;
    }),
    setHeader: vi.fn(function (k, v) {
      this.headers[k] = v;
      return this;
    }),
  };
  return res;
}

async function invoke(routes, method, path, { params = {}, query = {}, body = {} } = {}) {
  const route = findRoute(routes, method, path);
  const handler = route.handlers[route.handlers.length - 1];
  const req = { params, query, body };
  const res = createMockRes();
  await handler(req, res);
  return { req, res };
}

describe('registerAgentRunApprovalResumeRoutes', () => {
  let routes;
  let stores;

  beforeEach(() => {
    vi.resetAllMocks();
    const setup = createMockApp();
    routes = setup.routes;
    stores = {
      agentRunStore: {
        getTimeline: vi.fn(),
        getApprovalResumeGateAuditReport: vi.fn(),
        recordApprovalResumeGateAuditReportArtifact: vi.fn(),
        recordApprovalResumeGateAudit: vi.fn(),
      },
      approvalStore: {
        getApproval: vi.fn(),
      },
      ideaVerificationExecutor: {
        executeIdeaRun: vi.fn(),
      },
    };
    registerAgentRunApprovalResumeRoutes(setup.app, stores);
  });

  it('registers all four routes', () => {
    expect(routes).toHaveLength(4);
    const signatures = routes.map((r) => `${r.method} ${r.path}`);
    expect(signatures).toEqual([
      'get /api/agent-runs/:id/approval-resume-preview',
      'get /api/agent-runs/:id/approval-resume-gate-audit',
      'post /api/agent-runs/:id/approval-resume-gate-audit/archive',
      'post /api/agent-runs/:id/approval-resume',
    ]);
  });

  describe('GET /api/agent-runs/:id/approval-resume-preview', () => {
    it('returns 404 when the timeline is missing', async () => {
      stores.agentRunStore.getTimeline.mockReturnValue(null);
      const { res } = await invoke(routes, 'get', '/api/agent-runs/:id/approval-resume-preview', {
        params: { id: 'run-1' },
      });
      expect(res.status).toHaveBeenCalledWith(404);
      expect(res.json).toHaveBeenCalledWith({ ok: false, error: 'agent run not found' });
    });

    it('returns 400 when the run is not an idea_to_archive draft', async () => {
      stores.agentRunStore.getTimeline.mockReturnValue({ run: { sourceType: 'other' } });
      const { res } = await invoke(routes, 'get', '/api/agent-runs/:id/approval-resume-preview', {
        params: { id: 'run-1' },
      });
      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith({ ok: false, error: 'agent run is not an idea_to_archive draft' });
    });

    it('returns 400 when the resume manifest is missing', async () => {
      stores.agentRunStore.getTimeline.mockReturnValue({
        run: { sourceType: 'idea_to_archive', approvalId: 'app-1' },
      });
      mocks.latest.mockReturnValue(null);
      const { res } = await invoke(routes, 'get', '/api/agent-runs/:id/approval-resume-preview', {
        params: { id: 'run-1' },
      });
      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith({ ok: false, error: 'approval resume manifest not found' });
    });

    it('returns 200 with the resume review payload on success', async () => {
      stores.agentRunStore.getTimeline.mockReturnValue({
        run: { sourceType: 'idea_to_archive', approvalId: 'app-1' },
      });
      mocks.latest.mockReturnValue({ id: 'manifest-1' });
      mocks.buildReview.mockReturnValue({ approvalId: 'app-1', gate: { id: 'g1' } });
      mocks.buildAudit.mockReturnValue({ status: 'previewed' });

      const { res } = await invoke(routes, 'get', '/api/agent-runs/:id/approval-resume-preview', {
        params: { id: 'run-1' },
      });

      expect(res.json).toHaveBeenCalledWith({
        ok: true,
        approvalId: 'app-1',
        resumeReview: { approvalId: 'app-1', gate: { id: 'g1' } },
        resumeReviewGate: { id: 'g1' },
        resumeReviewGateAudit: { status: 'previewed' },
      });
      expect(mocks.buildReview).toHaveBeenCalledWith(
        { id: 'manifest-1' },
        expect.objectContaining({ runId: 'run-1', cwd: process.cwd() }),
      );
      expect(mocks.buildAudit).toHaveBeenCalledWith(
        { approvalId: 'app-1', gate: { id: 'g1' } },
        { status: 'previewed', recordedBy: 'owner' },
      );
    });

    it('returns 404 when a thrown error matches "not found"', async () => {
      stores.agentRunStore.getTimeline.mockReturnValue({
        run: { sourceType: 'idea_to_archive', approvalId: 'app-1' },
      });
      mocks.latest.mockImplementation(() => {
        throw new Error('resume manifest not found');
      });
      const { res } = await invoke(routes, 'get', '/api/agent-runs/:id/approval-resume-preview', {
        params: { id: 'run-1' },
      });
      expect(res.status).toHaveBeenCalledWith(404);
    });
  });

  describe('GET /api/agent-runs/:id/approval-resume-gate-audit', () => {
    it('returns 404 when the report is missing', async () => {
      stores.agentRunStore.getApprovalResumeGateAuditReport.mockReturnValue(null);
      const { res } = await invoke(routes, 'get', '/api/agent-runs/:id/approval-resume-gate-audit', {
        params: { id: 'run-1' },
      });
      expect(res.status).toHaveBeenCalledWith(404);
      expect(res.json).toHaveBeenCalledWith({ ok: false, error: 'approval resume gate audit not found' });
    });

    it('returns the JSON report by default', async () => {
      const report = { entries: [] };
      stores.agentRunStore.getApprovalResumeGateAuditReport.mockReturnValue(report);
      const { res } = await invoke(routes, 'get', '/api/agent-runs/:id/approval-resume-gate-audit', {
        params: { id: 'run-1' },
      });
      expect(stores.agentRunStore.getApprovalResumeGateAuditReport).toHaveBeenCalledWith(
        'run-1',
        { format: 'json' },
      );
      expect(res.json).toHaveBeenCalledWith({ ok: true, report });
    });

    it('returns markdown when format=markdown', async () => {
      stores.agentRunStore.getApprovalResumeGateAuditReport.mockReturnValue('# report');
      const { res } = await invoke(routes, 'get', '/api/agent-runs/:id/approval-resume-gate-audit', {
        params: { id: 'run-1' },
        query: { format: 'markdown' },
      });
      expect(res.setHeader).toHaveBeenCalledWith('Content-Type', 'text/markdown; charset=utf-8');
      expect(res.send).toHaveBeenCalledWith('# report');
    });

    it('returns markdown when format=md', async () => {
      stores.agentRunStore.getApprovalResumeGateAuditReport.mockReturnValue('# report');
      const { res } = await invoke(routes, 'get', '/api/agent-runs/:id/approval-resume-gate-audit', {
        params: { id: 'run-1' },
        query: { format: 'md' },
      });
      expect(res.send).toHaveBeenCalledWith('# report');
    });

    it('returns 500 when the store throws', async () => {
      stores.agentRunStore.getApprovalResumeGateAuditReport.mockImplementation(() => {
        throw new Error('boom');
      });
      const { res } = await invoke(routes, 'get', '/api/agent-runs/:id/approval-resume-gate-audit', {
        params: { id: 'run-1' },
      });
      expect(res.status).toHaveBeenCalledWith(500);
      expect(res.json).toHaveBeenCalledWith({ ok: false, error: 'boom' });
    });
  });

  describe('POST /api/agent-runs/:id/approval-resume-gate-audit/archive', () => {
    it('returns 501 when the store does not support artifact recording', async () => {
      delete stores.agentRunStore.recordApprovalResumeGateAuditReportArtifact;
      const { res } = await invoke(routes, 'post', '/api/agent-runs/:id/approval-resume-gate-audit/archive', {
        params: { id: 'run-1' },
        body: {},
      });
      expect(res.status).toHaveBeenCalledWith(501);
      expect(res.json).toHaveBeenCalledWith({ ok: false, error: 'gate audit report archive not supported' });
    });

    it('returns 201 with the archive result on success', async () => {
      stores.agentRunStore.recordApprovalResumeGateAuditReportArtifact.mockReturnValue({
        path: '/tmp/report.md',
        size: 42,
      });
      const { res } = await invoke(routes, 'post', '/api/agent-runs/:id/approval-resume-gate-audit/archive', {
        params: { id: 'run-1' },
        body: { format: 'markdown', requestedBy: 'alice' },
      });
      expect(stores.agentRunStore.recordApprovalResumeGateAuditReportArtifact).toHaveBeenCalledWith(
        'run-1',
        expect.objectContaining({
          format: 'markdown',
          requestedBy: 'alice',
          actorType: 'user',
        }),
      );
      expect(res.status).toHaveBeenCalledWith(201);
      expect(res.json).toHaveBeenCalledWith({
        ok: true,
        path: '/tmp/report.md',
        size: 42,
      });
    });

    it('returns 404 when the store throws a "not found" error', async () => {
      stores.agentRunStore.recordApprovalResumeGateAuditReportArtifact.mockImplementation(() => {
        throw new Error('report not found');
      });
      const { res } = await invoke(routes, 'post', '/api/agent-runs/:id/approval-resume-gate-audit/archive', {
        params: { id: 'run-1' },
        body: {},
      });
      expect(res.status).toHaveBeenCalledWith(404);
    });

    it('returns 400 for non-"not found" errors', async () => {
      stores.agentRunStore.recordApprovalResumeGateAuditReportArtifact.mockImplementation(() => {
        throw new Error('bad format');
      });
      const { res } = await invoke(routes, 'post', '/api/agent-runs/:id/approval-resume-gate-audit/archive', {
        params: { id: 'run-1' },
        body: {},
      });
      expect(res.status).toHaveBeenCalledWith(400);
    });
  });

  describe('POST /api/agent-runs/:id/approval-resume', () => {
    it('returns 404 when the timeline is missing', async () => {
      stores.agentRunStore.getTimeline.mockReturnValue(null);
      const { res } = await invoke(routes, 'post', '/api/agent-runs/:id/approval-resume', {
        params: { id: 'run-1' },
        body: {},
      });
      expect(res.status).toHaveBeenCalledWith(404);
    });

    it('returns 400 when the run is not an idea_to_archive draft', async () => {
      stores.agentRunStore.getTimeline.mockReturnValue({ run: { sourceType: 'other' } });
      const { res } = await invoke(routes, 'post', '/api/agent-runs/:id/approval-resume', {
        params: { id: 'run-1' },
        body: {},
      });
      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith({ ok: false, error: 'agent run is not an idea_to_archive draft' });
    });

    it('returns 400 when approvalId is missing', async () => {
      stores.agentRunStore.getTimeline.mockReturnValue({ run: { sourceType: 'idea_to_archive' } });
      const { res } = await invoke(routes, 'post', '/api/agent-runs/:id/approval-resume', {
        params: { id: 'run-1' },
        body: {},
      });
      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith({ ok: false, error: 'approvalId required' });
    });

    it('returns 404 when the approval cannot be found', async () => {
      stores.agentRunStore.getTimeline.mockReturnValue({ run: { sourceType: 'idea_to_archive' } });
      stores.approvalStore.getApproval.mockReturnValue(null);
      const { res } = await invoke(routes, 'post', '/api/agent-runs/:id/approval-resume', {
        params: { id: 'run-1' },
        body: { approvalId: 'app-1' },
      });
      expect(res.status).toHaveBeenCalledWith(404);
      expect(res.json).toHaveBeenCalledWith({ ok: false, error: 'approval not found' });
    });

    it('returns 409 when the approval is not approved', async () => {
      stores.agentRunStore.getTimeline.mockReturnValue({ run: { sourceType: 'idea_to_archive' } });
      const approval = { status: 'pending' };
      stores.approvalStore.getApproval.mockReturnValue(approval);
      const { res } = await invoke(routes, 'post', '/api/agent-runs/:id/approval-resume', {
        params: { id: 'run-1' },
        body: { approvalId: 'app-1' },
      });
      expect(res.status).toHaveBeenCalledWith(409);
      expect(res.json).toHaveBeenCalledWith({ ok: false, error: 'approval is not approved', approval });
    });

    it('returns 400 when the resume manifest is missing', async () => {
      stores.agentRunStore.getTimeline.mockReturnValue({ run: { sourceType: 'idea_to_archive' } });
      stores.approvalStore.getApproval.mockReturnValue({ status: 'approved' });
      mocks.latest.mockReturnValue(null);
      const { res } = await invoke(routes, 'post', '/api/agent-runs/:id/approval-resume', {
        params: { id: 'run-1' },
        body: { approvalId: 'app-1' },
      });
      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith({ ok: false, error: 'approval resume manifest not found' });
    });

    it('returns the gate status when verification fails', async () => {
      stores.agentRunStore.getTimeline.mockReturnValue({ run: { sourceType: 'idea_to_archive' } });
      stores.approvalStore.getApproval.mockReturnValue({ status: 'approved' });
      mocks.latest.mockReturnValue({ id: 'manifest-1' });
      mocks.buildReview.mockReturnValue({ approvalId: 'app-1', gate: { id: 'g1' } });
      mocks.buildAudit.mockReturnValue({ status: 'blocked' });
      mocks.verifyGate.mockReturnValue({
        ok: false,
        status: 422,
        error: 'gate mismatch',
        gate: { id: 'g1' },
      });

      const { res } = await invoke(routes, 'post', '/api/agent-runs/:id/approval-resume', {
        params: { id: 'run-1' },
        body: { approvalId: 'app-1', reviewGateId: 'g1', reviewSha256: 'sha' },
      });

      expect(mocks.verifyGate).toHaveBeenCalledWith(
        { approvalId: 'app-1', gate: { id: 'g1' } },
        { reviewGateId: 'g1', reviewSha256: 'sha' },
      );
      expect(mocks.buildAudit).toHaveBeenCalledWith(
        { approvalId: 'app-1', gate: { id: 'g1' } },
        { status: 'blocked', recordedBy: 'owner' },
      );
      expect(res.status).toHaveBeenCalledWith(422);
      expect(res.json).toHaveBeenCalledWith({
        ok: false,
        error: 'gate mismatch',
        resumeReview: { approvalId: 'app-1', gate: { id: 'g1' } },
        resumeReviewGate: { id: 'g1' },
        resumeReviewGateAudit: { status: 'blocked' },
      });
      expect(stores.ideaVerificationExecutor.executeIdeaRun).not.toHaveBeenCalled();
    });

    it('returns 201 with the executor result on full success', async () => {
      stores.agentRunStore.getTimeline.mockReturnValue({ run: { sourceType: 'idea_to_archive' } });
      const approval = { status: 'approved' };
      stores.approvalStore.getApproval.mockReturnValue(approval);
      mocks.latest.mockReturnValue({ id: 'manifest-1' });
      mocks.buildReview.mockReturnValue({ approvalId: 'app-1', gate: { id: 'g1' } });
      mocks.buildAudit.mockReturnValue({ status: 'accepted' });
      mocks.verifyGate.mockReturnValue({ ok: true, gate: { id: 'g1' } });
      stores.agentRunStore.recordApprovalResumeGateAudit.mockReturnValue({ message: 'recorded' });
      stores.ideaVerificationExecutor.executeIdeaRun.mockResolvedValue({ result: 'ok' });

      const { res } = await invoke(routes, 'post', '/api/agent-runs/:id/approval-resume', {
        params: { id: 'run-1' },
        body: { approvalId: 'app-1' },
      });

      expect(stores.ideaVerificationExecutor.executeIdeaRun).toHaveBeenCalledWith(
        'run-1',
        expect.objectContaining({
          id: 'manifest-1',
          approvalId: 'app-1',
          permissionApprovalId: 'app-1',
          resumeApprovalId: 'app-1',
          resumeReviewGate: { id: 'g1' },
          actorType: 'user',
          requestedBy: 'owner',
        }),
      );
      expect(res.status).toHaveBeenCalledWith(201);
      expect(res.json).toHaveBeenCalledWith({
        ok: true,
        approval,
        resumeManifest: { id: 'manifest-1' },
        resumeReview: { approvalId: 'app-1', gate: { id: 'g1' } },
        resumeReviewGate: { id: 'g1' },
        resumeReviewGateAudit: { status: 'accepted' },
        resumeReviewGateAuditMessage: 'recorded',
        result: 'ok',
      });
    });

    it('falls back to a null audit message when the store cannot record audits', async () => {
      delete stores.agentRunStore.recordApprovalResumeGateAudit;
      stores.agentRunStore.getTimeline.mockReturnValue({ run: { sourceType: 'idea_to_archive' } });
      stores.approvalStore.getApproval.mockReturnValue({ status: 'approved' });
      mocks.latest.mockReturnValue({ id: 'manifest-1' });
      mocks.buildReview.mockReturnValue({ approvalId: 'app-1', gate: { id: 'g1' } });
      mocks.buildAudit.mockReturnValue({ status: 'accepted' });
      mocks.verifyGate.mockReturnValue({ ok: true, gate: { id: 'g1' } });
      stores.ideaVerificationExecutor.executeIdeaRun.mockResolvedValue({ result: 'ok' });

      const { res } = await invoke(routes, 'post', '/api/agent-runs/:id/approval-resume', {
        params: { id: 'run-1' },
        body: { approvalId: 'app-1' },
      });

      expect(res.status).toHaveBeenCalledWith(201);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({ resumeReviewGateAuditMessage: null }),
      );
    });

    it('returns 404 when an executor error matches "not found"', async () => {
      stores.agentRunStore.getTimeline.mockReturnValue({ run: { sourceType: 'idea_to_archive' } });
      stores.approvalStore.getApproval.mockReturnValue({ status: 'approved' });
      mocks.latest.mockReturnValue({ id: 'manifest-1' });
      mocks.buildReview.mockReturnValue({ approvalId: 'app-1', gate: { id: 'g1' } });
      mocks.buildAudit.mockReturnValue({ status: 'accepted' });
      mocks.verifyGate.mockReturnValue({ ok: true, gate: { id: 'g1' } });
      stores.ideaVerificationExecutor.executeIdeaRun.mockRejectedValue(new Error('agent run not found'));

      const { res } = await invoke(routes, 'post', '/api/agent-runs/:id/approval-resume', {
        params: { id: 'run-1' },
        body: { approvalId: 'app-1' },
      });

      expect(res.status).toHaveBeenCalledWith(404);
    });
  });
});
