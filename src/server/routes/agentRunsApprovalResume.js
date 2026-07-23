import {
  buildApprovalResumeReview,
  buildApprovalResumeGateAudit,
  latestApprovalResumeManifest,
  verifyApprovalResumeReviewGate,
} from '../../agents/AgentRunApprovalResumeReview.js';
import { requireOwnerToken } from '../auth/owner-token.js';

function safeString(value, max = 512) {
  if (value === undefined || value === null || value === '') return '';
  return String(value).slice(0, max).trim();
}

export function registerAgentRunApprovalResumeRoutes(app, {
  agentRunStore,
  approvalStore,
  ideaVerificationExecutor,
} = {}) {
  app.get('/api/agent-runs/:id/approval-resume-preview', requireOwnerToken, (req, res) => {
    try {
      const timeline = agentRunStore.getTimeline(req.params.id);
      if (!timeline) return res.status(404).json({ ok: false, error: 'agent run not found' });
      if (timeline.run?.sourceType !== 'idea_to_archive') {
        return res.status(400).json({ ok: false, error: 'agent run is not an idea_to_archive draft' });
      }
      const approvalId = safeString(req.query?.approvalId || timeline.run?.approvalId || timeline.run?.details?.approvalId, 160);
      const resumeManifest = latestApprovalResumeManifest(timeline, approvalId);
      if (!resumeManifest) return res.status(400).json({ ok: false, error: 'approval resume manifest not found' });
      const resumeReview = buildApprovalResumeReview(resumeManifest, { cwd: process.cwd(), runId: req.params.id });
      res.json({
        ok: true,
        approvalId: approvalId || resumeReview.approvalId,
        resumeReview,
        resumeReviewGate: resumeReview.gate,
        resumeReviewGateAudit: buildApprovalResumeGateAudit(resumeReview, { status: 'previewed', recordedBy: 'owner' }),
      });
    } catch (e) {
      const status = /not found/.test(e.message || '') ? 404 : 400;
      res.status(status).json({ ok: false, error: e.message || String(e) });
    }
  });

  app.get('/api/agent-runs/:id/approval-resume-gate-audit', requireOwnerToken, (req, res) => {
    try {
      const format = safeString(req.query?.format || 'json', 40).toLowerCase();
      const report = typeof agentRunStore.getApprovalResumeGateAuditReport === 'function'
        ? agentRunStore.getApprovalResumeGateAuditReport(req.params.id, { format })
        : null;
      if (!report) return res.status(404).json({ ok: false, error: 'approval resume gate audit not found' });
      if (format === 'markdown' || format === 'md') {
        res.setHeader?.('Content-Type', 'text/markdown; charset=utf-8');
        return res.send ? res.send(report) : res.json({ ok: true, markdown: report });
      }
      res.json({ ok: true, report });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message || String(e) });
    }
  });

  app.post('/api/agent-runs/:id/approval-resume-gate-audit/archive', requireOwnerToken, (req, res) => {
    try {
      if (typeof agentRunStore.recordApprovalResumeGateAuditReportArtifact !== 'function') {
        return res.status(501).json({ ok: false, error: 'gate audit report archive not supported' });
      }
      const result = agentRunStore.recordApprovalResumeGateAuditReportArtifact(req.params.id, {
        ...(req.body || {}),
        actorType: 'user',
        requestedBy: req.body?.requestedBy || 'owner',
      });
      res.status(201).json({ ok: true, ...result });
    } catch (e) {
      const status = /not found/.test(e.message || '') ? 404 : 400;
      res.status(status).json({ ok: false, error: e.message || String(e) });
    }
  });

  app.post('/api/agent-runs/:id/approval-resume', requireOwnerToken, async (req, res) => {
    try {
      const body = req.body || {};
      const timeline = agentRunStore.getTimeline(req.params.id);
      if (!timeline) return res.status(404).json({ ok: false, error: 'agent run not found' });
      if (timeline.run?.sourceType !== 'idea_to_archive') {
        return res.status(400).json({ ok: false, error: 'agent run is not an idea_to_archive draft' });
      }
      const approvalId = safeString(body.approvalId || body.permissionApprovalId || body.resumeApprovalId || timeline.run?.approvalId || timeline.run?.details?.approvalId, 160);
      if (!approvalId) return res.status(400).json({ ok: false, error: 'approvalId required' });
      const approval = approvalStore.getApproval?.(approvalId);
      if (!approval) return res.status(404).json({ ok: false, error: 'approval not found' });
      if (approval.status !== 'approved') {
        return res.status(409).json({ ok: false, error: 'approval is not approved', approval });
      }
      const resumeManifest = latestApprovalResumeManifest(timeline, approvalId);
      if (!resumeManifest) return res.status(400).json({ ok: false, error: 'approval resume manifest not found' });
      const resumeReview = buildApprovalResumeReview(resumeManifest, { cwd: process.cwd(), runId: req.params.id });
      const reviewGate = verifyApprovalResumeReviewGate(resumeReview, {
        reviewGateId: body.reviewGateId || body.resumeReviewGateId || body.approvalResumeReviewGateId,
        reviewSha256: body.reviewSha256 || body.resumeReviewSha256 || body.approvalResumeReviewSha256,
      });
      if (!reviewGate.ok) {
        const blockedAudit = buildApprovalResumeGateAudit(resumeReview, { status: 'blocked', recordedBy: body.requestedBy || 'owner' });
        return res.status(reviewGate.status).json({
          ok: false,
          error: reviewGate.error,
          resumeReview,
          resumeReviewGate: reviewGate.gate,
          resumeReviewGateAudit: blockedAudit,
        });
      }
      const resumeReviewGateAudit = buildApprovalResumeGateAudit(resumeReview, { status: 'accepted', recordedBy: body.requestedBy || 'owner' });
      const auditRecord = typeof agentRunStore.recordApprovalResumeGateAudit === 'function'
        ? agentRunStore.recordApprovalResumeGateAudit(req.params.id, {
          audit: resumeReviewGateAudit,
          actorType: 'user',
          status: 'accepted',
        })
        : null;
      const result = await ideaVerificationExecutor.executeIdeaRun(req.params.id, {
        ...resumeManifest,
        approvalId,
        permissionApprovalId: approvalId,
        resumeApprovalId: approvalId,
        resumeReviewGate: reviewGate.gate,
        resumeReviewGateAudit,
        actorType: 'user',
        requestedBy: body.requestedBy || 'owner',
      });
      res.status(201).json({
        ok: true,
        approval,
        resumeManifest,
        resumeReview,
        resumeReviewGate: reviewGate.gate,
        resumeReviewGateAudit,
        resumeReviewGateAuditMessage: auditRecord?.message || null,
        ...result,
      });
    } catch (e) {
      const status = /not found/.test(e.message || '') ? 404 : 400;
      res.status(status).json({ ok: false, error: e.message || String(e) });
    }
  });
}
