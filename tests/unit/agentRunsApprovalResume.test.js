import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../../src/agents/AgentRunApprovalResumeReview.js', () => ({
  buildApprovalResumeReview: vi.fn(),
  buildApprovalResumeGateAudit: vi.fn(),
  latestApprovalResumeManifest: vi.fn(),
  verifyApprovalResumeReviewGate: vi.fn(),
}));

vi.mock('../../src/server/auth/owner-token.js', () => ({
  requireOwnerToken: (_req, _res, next) => {
    if (typeof next === 'function') next();
  },
}));

import { registerAgentRunApprovalResumeRoutes } from '../../src/server/routes/agentRunsApprovalResume.js';
import {
  buildApprovalResumeReview,
  buildApprovalResumeGateAudit,
  latestApprovalResumeManifest,
  verifyApprovalResumeReviewGate,
} from '../../src/agents/AgentRunApprovalResumeReview.js';

function createApp() {
  const routes = {};
  const app = {
    get(path, ...handlers) {
      routes[`GET ${path}`] = handlers;
    },
    post(path, ...handlers) {
      routes[`POST ${path}`] = handlers;
    },
  };
  return { app, routes };
}

function createRes() {
  const res = {
    statusCode: 200,
    body: null,
    headers: {},
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
      return this;
    },
    send(payload) {
      this.body = payload;
      return this;
    },
    setHeader(key, value) {
      this.headers[key] = value;
      return this;
    },
  };
  return res;
}

describe('registerAgentRunApprovalResumeRoutes', () => {
  let app;
  let routes;
  let res;
  let agentRunStore;
  let approvalStore;
  let ideaVerificationExecutor;

  beforeEach(() => {
    vi.clearAllMocks();
    const created = createApp();
    app = created.app;
    routes = created.routes;
    res = createRes();
    agentRunStore = {};
    approvalStore = {};
    ideaVerificationExecutor = { executeIdeaRun: vi.fn() };
  });

  it('registers the four expected routes on the app', () => {
    registerAgentRunApprovalResumeRoutes(app, { agentRunStore, approvalStore, ideaVerificationExecutor });
    expect(Object.keys(routes).sort()).toEqual([
      'GET /api/agent-runs/:id/approval-resume-gate-audit',
      'GET /api/agent-runs/:id/approval-resume-preview',
      'POST /api/agent-runs/:id/approval-resume',
      'POST /api/agent-runs/:id/approval-resume-gate-audit/archive',
    ]);
  });

  describe('GET /api/agent-runs/:id/approval-resume-preview', () => {
    it('returns 404 when the timeline is missing', () => {
      agentRunStore.getTimeline = vi.fn().mockReturnValue(null);
      registerAgentRunApprovalResumeRoutes(app, { agentRunStore, approvalStore, ideaVerificationExecutor });
      const handler = routes['GET /api/agent-runs/:id/approval-resume-preview'].at(-1);
      handler({ params: { id: 'run-1' }, query: {} }, res);
      expect(res.statusCode).toBe(404);
      expect(res.body).toEqual({ ok: false, error: 'agent run not found' });
    });

    it('returns 400 when the run sourceType is not idea_to_archive', () => {
      agentRunStore.getTimeline = vi.fn().mockReturnValue({ run: { sourceType: 'other' } });
      registerAgentRunApprovalResumeRoutes(app, { agentRunStore, approvalStore, ideaVerificationExecutor });
      const handler = routes['GET /api/agent-runs/:id/approval-resume-preview'].at(-1);
      handler({ params: { id: 'run-1' }, query: {} }, res);
      expect(res.statusCode).toBe(400);
      expect(res.body).toEqual({ ok: false, error: 'agent run is not an idea_to_archive draft' });
    });

    it('returns 400 when the resume manifest is missing', () => {
      agentRunStore.getTimeline = vi.fn().mockReturnValue({ run: { sourceType: 'idea_to_archive' } });
      latestApprovalResumeManifest.mockReturnValue(null);
      registerAgentRunApprovalResumeRoutes(app, { agentRunStore, approvalStore, ideaVerificationExecutor });
      const handler = routes['GET /api/agent-runs/:id/approval-resume-preview'].at(-1);
      handler({ params: { id: 'run-1' }, query: {} }, res);
      expect(res.statusCode).toBe(400);
      expect(res.body.error).toBe('approval resume manifest not found');
    });

    it('returns 200 with the resume review and gate audit on success', () => {
      agentRunStore.getTimeline = vi.fn().mockReturnValue({ run: { sourceType: 'idea_to_archive' } });
      latestApprovalResumeManifest.mockReturnValue({ id: 'manifest-1' });
      buildApprovalResumeReview.mockReturnValue({ approvalId: 'ap-1', gate: { ok: true, id: 'g-1' } });
      buildApprovalResumeGateAudit.mockReturnValue({ status: 'previewed', recordedBy: 'owner' });
      registerAgentRunApprovalResumeRoutes(app, { agentRunStore, approvalStore, ideaVerificationExecutor });
      const handler = routes['GET /api/agent-runs/:id/approval-resume-preview'].at(-1);
      handler({ params: { id: 'run-1' }, query: { approvalId: 'ap-1' } }, res);
      expect(res.statusCode).toBe(200);
      expect(res.body.ok).toBe(true);
      expect(res.body.approvalId).toBe('ap-1');
      expect(res.body.resumeReview.approvalId).toBe('ap-1');
      expect(res.body.resumeReviewGate).toEqual({ ok: true, id: 'g-1' });
      expect(buildApprovalResumeGateAudit).toHaveBeenCalledWith(
        expect.objectContaining({ approvalId: 'ap-1' }),
        { status: 'previewed', recordedBy: 'owner' },
      );
    });
  });

  describe('GET /api/agent-runs/:id/approval-resume-gate-audit', () => {
    it('returns 404 when the store has no report', () => {
      agentRunStore.getApprovalResumeGateAuditReport = vi.fn().mockReturnValue(null);
      registerAgentRunApprovalResumeRoutes(app, { agentRunStore, approvalStore, ideaVerificationExecutor });
      const handler = routes['GET /api/agent-runs/:id/approval-resume-gate-audit'].at(-1);
      handler({ params: { id: 'run-1' }, query: {} }, res);
      expect(res.statusCode).toBe(404);
      expect(res.body).toEqual({ ok: false, error: 'approval resume gate audit not found' });
    });

    it('returns 500 on store error', () => {
      agentRunStore.getApprovalResumeGateAuditReport = vi.fn().mockImplementation(() => {
        throw new Error('store down');
      });
      registerAgentRunApprovalResumeRoutes(app, { agentRunStore, approvalStore, ideaVerificationExecutor });
      const handler = routes['GET /api/agent-runs/:id/approval-resume-gate-audit'].at(-1);
      handler({ params: { id: 'run-1' }, query: {} }, res);
      expect(res.statusCode).toBe(500);
      expect(res.body.error).toBe('store down');
    });

    it('returns a JSON report by default', () => {
      const report = { entries: [] };
      agentRunStore.getApprovalResumeGateAuditReport = vi.fn().mockReturnValue(report);
      registerAgentRunApprovalResumeRoutes(app, { agentRunStore, approvalStore, ideaVerificationExecutor });
      const handler = routes['GET /api/agent-runs/:id/approval-resume-gate-audit'].at(-1);
      handler({ params: { id: 'run-1' }, query: {} }, res);
      expect(res.statusCode).toBe(200);
      expect(res.body).toEqual({ ok: true, report });
    });

    it('returns markdown with text/markdown content-type when format=markdown', () => {
      const md = '# audit';
      agentRunStore.getApprovalResumeGateAuditReport = vi.fn().mockReturnValue(md);
      registerAgentRunApprovalResumeRoutes(app, { agentRunStore, approvalStore, ideaVerificationExecutor });
      const handler = routes['GET /api/agent-runs/:id/approval-resume-gate-audit'].at(-1);
      handler({ params: { id: 'run-1' }, query: { format: 'markdown' } }, res);
      expect(res.statusCode).toBe(200);
      expect(res.body).toBe(md);
      expect(res.headers['Content-Type']).toBe('text/markdown; charset=utf-8');
    });
  });

  describe('POST /api/agent-runs/:id/approval-resume-gate-audit/archive', () => {
    it('returns 501 when the store does not support archiving', () => {
      registerAgentRunApprovalResumeRoutes(app, { agentRunStore, approvalStore, ideaVerificationExecutor });
      const handler = routes['POST /api/agent-runs/:id/approval-resume-gate-audit/archive'].at(-1);
      handler({ params: { id: 'run-1' }, body: {} }, res);
      expect(res.statusCode).toBe(501);
      expect(res.body.error).toBe('gate audit report archive not supported');
    });

    it('returns 201 with the artifact result and forwards the body to the store', () => {
      agentRunStore.recordApprovalResumeGateAuditReportArtifact = vi.fn().mockReturnValue({ artifactId: 'a1' });
      registerAgentRunApprovalResumeRoutes(app, { agentRunStore, approvalStore, ideaVerificationExecutor });
      const handler = routes['POST /api/agent-runs/:id/approval-resume-gate-audit/archive'].at(-1);
      handler({ params: { id: 'run-1' }, body: { requestedBy: 'alice' } }, res);
      expect(res.statusCode).toBe(201);
      expect(res.body).toEqual({ ok: true, artifactId: 'a1' });
      expect(agentRunStore.recordApprovalResumeGateAuditReportArtifact).toHaveBeenCalledWith('run-1', {
        requestedBy: 'alice',
        actorType: 'user',
      });
    });

    it('returns 404 when the store throws a not-found error', () => {
      agentRunStore.recordApprovalResumeGateAuditReportArtifact = vi.fn().mockImplementation(() => {
        throw new Error('artifact not found');
      });
      registerAgentRunApprovalResumeRoutes(app, { agentRunStore, approvalStore, ideaVerificationExecutor });
      const handler = routes['POST /api/agent-runs/:id/approval-resume-gate-audit/archive'].at(-1);
      handler({ params: { id: 'run-1' }, body: {} }, res);
      expect(res.statusCode).toBe(404);
    });
  });

  describe('POST /api/agent-runs/:id/approval-resume', () => {
    const baseTimeline = { run: { sourceType: 'idea_to_archive' } };
    const baseApproval = { id: 'ap-1', status: 'approved' };
    const baseManifest = { id: 'manifest-1' };
    const baseReview = { approvalId: 'ap-1', gate: { ok: true, id: 'g-1' } };
    const baseGateOk = { ok: true, status: 200, gate: { id: 'g-1' }, error: null };

    it('returns 404 when the timeline is missing', async () => {
      agentRunStore.getTimeline = vi.fn().mockReturnValue(null);
      registerAgentRunApprovalResumeRoutes(app, { agentRunStore, approvalStore, ideaVerificationExecutor });
      const handler = routes['POST /api/agent-runs/:id/approval-resume'].at(-1);
      await handler({ params: { id: 'run-1' }, body: {} }, res);
      expect(res.statusCode).toBe(404);
    });

    it('returns 400 when sourceType is not idea_to_archive', async () => {
      agentRunStore.getTimeline = vi.fn().mockReturnValue({ run: { sourceType: 'other' } });
      registerAgentRunApprovalResumeRoutes(app, { agentRunStore, approvalStore, ideaVerificationExecutor });
      const handler = routes['POST /api/agent-runs/:id/approval-resume'].at(-1);
      await handler({ params: { id: 'run-1' }, body: { approvalId: 'ap-1' } }, res);
      expect(res.statusCode).toBe(400);
    });

    it('returns 400 when approvalId is missing', async () => {
      agentRunStore.getTimeline = vi.fn().mockReturnValue(baseTimeline);
      registerAgentRunApprovalResumeRoutes(app, { agentRunStore, approvalStore, ideaVerificationExecutor });
      const handler = routes['POST /api/agent-runs/:id/approval-resume'].at(-1);
      await handler({ params: { id: 'run-1' }, body: {} }, res);
      expect(res.statusCode).toBe(400);
      expect(res.body.error).toBe('approvalId required');
    });

    it('returns 404 when the approval is not found', async () => {
      agentRunStore.getTimeline = vi.fn().mockReturnValue(baseTimeline);
      approvalStore.getApproval = vi.fn().mockReturnValue(null);
      registerAgentRunApprovalResumeRoutes(app, { agentRunStore, approvalStore, ideaVerificationExecutor });
      const handler = routes['POST /api/agent-runs/:id/approval-resume'].at(-1);
      await handler({ params: { id: 'run-1' }, body: { approvalId: 'ap-1' } }, res);
      expect(res.statusCode).toBe(404);
      expect(res.body.error).toBe('approval not found');
    });

    it('returns 409 when the approval is not approved', async () => {
      agentRunStore.getTimeline = vi.fn().mockReturnValue(baseTimeline);
      approvalStore.getApproval = vi.fn().mockReturnValue({ id: 'ap-1', status: 'pending' });
      registerAgentRunApprovalResumeRoutes(app, { agentRunStore, approvalStore, ideaVerificationExecutor });
      const handler = routes['POST /api/agent-runs/:id/approval-resume'].at(-1);
      await handler({ params: { id: 'run-1' }, body: { approvalId: 'ap-1' } }, res);
      expect(res.statusCode).toBe(409);
      expect(res.body.error).toBe('approval is not approved');
    });

    it('returns 400 when the resume manifest is missing', async () => {
      agentRunStore.getTimeline = vi.fn().mockReturnValue(baseTimeline);
      approvalStore.getApproval = vi.fn().mockReturnValue(baseApproval);
      latestApprovalResumeManifest.mockReturnValue(null);
      registerAgentRunApprovalResumeRoutes(app, { agentRunStore, approvalStore, ideaVerificationExecutor });
      const handler = routes['POST /api/agent-runs/:id/approval-resume'].at(-1);
      await handler({ params: { id: 'run-1' }, body: { approvalId: 'ap-1' } }, res);
      expect(res.statusCode).toBe(400);
      expect(res.body.error).toBe('approval resume manifest not found');
    });

    it('returns the gate status with a blocked audit when the review gate fails', async () => {
      agentRunStore.getTimeline = vi.fn().mockReturnValue(baseTimeline);
      approvalStore.getApproval = vi.fn().mockReturnValue(baseApproval);
      latestApprovalResumeManifest.mockReturnValue(baseManifest);
      buildApprovalResumeReview.mockReturnValue(baseReview);
      verifyApprovalResumeReviewGate.mockReturnValue({
        ok: false,
        status: 422,
        gate: { id: 'g-1' },
        error: 'gate mismatch',
      });
      buildApprovalResumeGateAudit.mockReturnValue({ status: 'blocked' });
      registerAgentRunApprovalResumeRoutes(app, { agentRunStore, approvalStore, ideaVerificationExecutor });
      const handler = routes['POST /api/agent-runs/:id/approval-resume'].at(-1);
      await handler({ params: { id: 'run-1' }, body: { approvalId: 'ap-1' } }, res);
      expect(res.statusCode).toBe(422);
      expect(res.body.ok).toBe(false);
      expect(res.body.error).toBe('gate mismatch');
      expect(res.body.resumeReviewGateAudit.status).toBe('blocked');
      expect(ideaVerificationExecutor.executeIdeaRun).not.toHaveBeenCalled();
    });

    it('returns 201 with the full result and forwards options to the executor on success', async () => {
      agentRunStore.getTimeline = vi.fn().mockReturnValue(baseTimeline);
      approvalStore.getApproval = vi.fn().mockReturnValue(baseApproval);
      latestApprovalResumeManifest.mockReturnValue(baseManifest);
      buildApprovalResumeReview.mockReturnValue(baseReview);
      verifyApprovalResumeReviewGate.mockReturnValue(baseGateOk);
      buildApprovalResumeGateAudit.mockReturnValue({ status: 'accepted' });
      agentRunStore.recordApprovalResumeGateAudit = vi.fn().mockReturnValue({ message: 'audit-stored' });
      ideaVerificationExecutor.executeIdeaRun = vi.fn().mockResolvedValue({ status: 'resumed' });
      registerAgentRunApprovalResumeRoutes(app, { agentRunStore, approvalStore, ideaVerificationExecutor });
      const handler = routes['POST /api/agent-runs/:id/approval-resume'].at(-1);
      await handler({ params: { id: 'run-1' }, body: { approvalId: 'ap-1' } }, res);
      expect(res.statusCode).toBe(201);
      expect(res.body.ok).toBe(true);
      expect(res.body.approval).toEqual(baseApproval);
      expect(res.body.resumeReviewGateAuditMessage).toBe('audit-stored');
      expect(res.body.status).toBe('resumed');
      expect(agentRunStore.recordApprovalResumeGateAudit).toHaveBeenCalledWith('run-1', expect.objectContaining({
        audit: { status: 'accepted' },
        actorType: 'user',
        status: 'accepted',
      }));
      expect(ideaVerificationExecutor.executeIdeaRun).toHaveBeenCalledWith('run-1', expect.objectContaining({
        approvalId: 'ap-1',
        permissionApprovalId: 'ap-1',
        resumeApprovalId: 'ap-1',
        actorType: 'user',
        requestedBy: 'owner',
      }));
    });
  });
});
