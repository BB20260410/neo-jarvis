import { requireOwnerToken } from '../auth/owner-token.js';
import { relative, resolve } from 'node:path';
import {
  decideNoeProposalInboxItem,
  executeNoeProposalInboxItem,
  getNoeProposalInboxItem,
  listNoeProposalInbox,
} from '../../runtime/NoeProposalInbox.js';
import { applySelfModelProposalReport } from '../../../scripts/noe-self-model-proposal-apply.mjs';
import { MemoryCore } from '../../memory/MemoryCore.js';
import { runNoeMemoryCandidateReview } from '../../memory/NoeMemoryCandidateReview.js';
import { runNoeMemoryCandidateApply } from '../../memory/NoeMemoryCandidateApply.js';
import { runNoeMemoryCandidateRollback } from '../../memory/NoeMemoryCandidateRollback.js';
import { buildNoeMemoryCandidateStatus } from '../../memory/NoeMemoryCandidateStatus.js';

function parseLimit(value, fallback = 100) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(1, Math.min(500, Math.trunc(n)));
}

function bodyTooLarge(body, max = 20000) {
  try { return JSON.stringify(body || {}).length > max; } catch { return true; }
}

function resolveRootRef(root, ref) {
  const rootAbs = resolve(root);
  const file = resolve(rootAbs, String(ref || ''));
  const rel = relative(rootAbs, file);
  if (!rel || rel.startsWith('..') || resolve(rel) === rel) return null;
  return file;
}

export function registerNoeProposalRoutes(app, {
  root = process.cwd(),
  createMemoryCore = () => new MemoryCore(),
  selfModelDir = null,
  sendError = (res, e) => res.status(500).json({ ok: false, error: e?.message || String(e) }),
} = {}) {
  app.get('/api/noe/proposals', requireOwnerToken, (req, res) => {
    try {
      return res.json(listNoeProposalInbox({
        root,
        source: req.query?.source || '',
        status: req.query?.status || '',
        limit: parseLimit(req.query?.limit),
      }));
    } catch (e) {
      return sendError(res, e);
    }
  });

  app.get('/api/noe/proposals/:id', requireOwnerToken, (req, res) => {
    try {
      const result = getNoeProposalInboxItem({ root, id: req.params?.id || '' });
      if (!result.ok) return res.status(404).json(result);
      return res.json(result);
    } catch (e) {
      return sendError(res, e);
    }
  });

  app.post('/api/noe/proposals/:id/decision', requireOwnerToken, (req, res) => {
    try {
      if (bodyTooLarge(req.body)) return res.status(413).json({ ok: false, error: 'body_too_large' });
      const result = decideNoeProposalInboxItem({
        root,
        id: req.params?.id || '',
        decision: req.body?.decision || '',
        reason: req.body?.reason || '',
        actor: req.body?.actor || 'owner',
        confirmOwner: req.body?.confirmOwner === true,
      });
      if (!result.ok && result.error === 'proposal_not_found') return res.status(404).json(result);
      if (!result.ok) return res.status(400).json(result);
      return res.json(result);
    } catch (e) {
      return sendError(res, e);
    }
  });

  app.post('/api/noe/proposals/:id/execute', requireOwnerToken, (req, res) => {
    try {
      if (bodyTooLarge(req.body)) return res.status(413).json({ ok: false, error: 'body_too_large' });
      const result = executeNoeProposalInboxItem({
        root,
        id: req.params?.id || '',
        dryRun: req.body?.dryRun !== false,
        confirmOwner: req.body?.confirmOwner === true,
      });
      if (!result.ok && result.error === 'proposal_not_found') return res.status(404).json(result);
      if (!result.ok && result.error === 'proposal_not_approved_for_gated_apply') return res.status(409).json(result);
      if (!result.ok) return res.status(400).json(result);
      return res.json(result);
    } catch (e) {
      return sendError(res, e);
    }
  });

  app.post('/api/noe/proposals/:id/self-model-apply', requireOwnerToken, (req, res) => {
    try {
      if (bodyTooLarge(req.body)) return res.status(413).json({ ok: false, error: 'body_too_large' });
      const dryRun = req.body?.dryRun !== false;
      if (req.body?.confirmOwner !== true) {
        return res.status(400).json({ ok: false, error: 'owner_confirmation_required' });
      }
      const found = getNoeProposalInboxItem({ root, id: req.params?.id || '' });
      if (!found.ok) return res.status(404).json(found);
      const proposal = found.proposal || {};
      if (proposal.source !== 'self_model' || proposal.type !== 'self_model_diff') {
        return res.status(400).json({ ok: false, error: 'unsupported_proposal_type_for_self_model_apply', source: proposal.source || '', type: proposal.type || '' });
      }
      if (!dryRun && proposal.status !== 'approved_for_gated_apply') {
        return res.status(409).json({ ok: false, error: 'proposal_not_approved_for_self_model_apply', status: proposal.status || '' });
      }
      // TOCTOU 防护：审批锁定的 patch 内容指纹必须与当前 latest.json 重新计算的指纹一致，
      // 否则说明 approve 之后 latest.json 的 patch 被改过，拒绝 real apply。
      if (!dryRun) {
        const approvedHash = proposal.ownerDecision?.patchContentHash || '';
        const currentHash = proposal.patchContentHash || '';
        if (!approvedHash || approvedHash !== currentHash) {
          return res.status(409).json({
            ok: false,
            error: 'proposal_patch_changed_since_approval',
            approvedPatchContentHash: approvedHash || null,
            currentPatchContentHash: currentHash || null,
          });
        }
      }
      const source = resolveRootRef(root, proposal.sourceReportRef);
      if (!source) return res.status(400).json({ ok: false, error: 'invalid_source_report_ref' });
      const result = applySelfModelProposalReport({
        source,
        selfModelDir,
        confirmOwner: true,
        dryRun,
      });
      if (!result.ok) return res.status(400).json({ ok: false, selfModelApply: result, error: result.reason || 'self_model_apply_failed' });
      return res.json({
        ok: true,
        dryRun,
        proposalId: proposal.id,
        selfModelApply: result,
        policy: {
          ownerConfirmed: true,
          requiresApprovedProposalForRealApply: true,
          noMacroTickApply: true,
          identityValuesReturned: false,
        },
      });
    } catch (e) {
      return sendError(res, e);
    }
  });

  app.get('/api/noe/memory-candidates/status', requireOwnerToken, (req, res) => {
    try {
      return res.json(buildNoeMemoryCandidateStatus({
        root,
        limit: parseLimit(req.query?.limit, 10),
      }));
    } catch (e) {
      return sendError(res, e);
    }
  });

  app.post('/api/noe/memory-candidates/review', requireOwnerToken, (req, res) => {
    try {
      if (bodyTooLarge(req.body)) return res.status(413).json({ ok: false, error: 'body_too_large' });
      const dryRun = req.body?.dryRun !== false;
      if (!dryRun && req.body?.confirmOwner !== true) {
        return res.status(400).json({ ok: false, error: 'owner_confirmation_required' });
      }
      const result = runNoeMemoryCandidateReview({ root, dryRun });
      if (!result.ok && result.status !== 'skipped') return res.status(400).json(result);
      return res.json(result);
    } catch (e) {
      return sendError(res, e);
    }
  });

  app.post('/api/noe/memory-candidates/apply', requireOwnerToken, (req, res) => {
    try {
      if (bodyTooLarge(req.body)) return res.status(413).json({ ok: false, error: 'body_too_large' });
      const dryRun = req.body?.dryRun !== false;
      const result = runNoeMemoryCandidateApply({
        root,
        dryRun,
        confirmOwner: req.body?.confirmOwner === true,
        memoryCore: dryRun ? null : createMemoryCore(),
      });
      if (!result.ok && result.status !== 'skipped') return res.status(400).json(result);
      return res.json(result);
    } catch (e) {
      return sendError(res, e);
    }
  });

  app.post('/api/noe/memory-candidates/rollback', requireOwnerToken, (req, res) => {
    try {
      if (bodyTooLarge(req.body)) return res.status(413).json({ ok: false, error: 'body_too_large' });
      const dryRun = req.body?.dryRun !== false;
      const result = runNoeMemoryCandidateRollback({
        root,
        applyReportRef: req.body?.applyReportRef || '',
        dryRun,
        confirmOwner: req.body?.confirmOwner === true,
        memoryCore: dryRun ? null : createMemoryCore(),
      });
      if (!result.ok && result.status !== 'skipped') return res.status(400).json(result);
      return res.json(result);
    } catch (e) {
      return sendError(res, e);
    }
  });
}
