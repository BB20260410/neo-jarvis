// @ts-check

import {
  candidateHasSourceEvidence,
  candidateNeedsReview,
  candidateNeedsSourceEvidence,
  candidateLooksEphemeral,
  candidateToMemoryInput,
  normalizeMemoryCandidate,
} from './NoeMemoryCandidateSchema.js';
import { NoeMemoryAuditLog } from './NoeMemoryAuditLog.js';

function decision(ok, decisionValue, reason, extra = {}) {
  return { ok, decision: decisionValue, reason, ...extra };
}

function candidateLinks(candidate, memoryId) {
  const links = [{ type: 'candidate', ref: candidate.id }];
  if (candidate.sourceEpisodeId) links.push({ type: 'source_episode', ref: candidate.sourceEpisodeId });
  for (const ref of candidate.sourceEventIds || []) links.push({ type: 'source_event', ref });
  for (const ref of candidate.evidenceRefs || []) links.push({ type: 'evidence_ref', ref });
  return links.filter((link) => link.ref && memoryId);
}

export class NoeMemoryWriteGate {
  constructor({
    memory = null,
    auditLog = null,
    minConfidence = 0.35,
    requireEvidenceForAuto = true,
    now = Date.now,
    logger = console,
  } = {}) {
    this.memory = memory;
    this.auditLog = auditLog || new NoeMemoryAuditLog({ db: () => memory?.db?.(), now });
    this.minConfidence = minConfidence;
    this.requireEvidenceForAuto = requireEvidenceForAuto;
    this.now = now;
    this.logger = logger;
  }

  validate(candidate) {
    if (!candidate.body || candidate.body.length < 2) return decision(false, 'rejected', 'empty_body');
    if (candidate.incomplete) return decision(false, 'rejected', 'incomplete_model_output');
    if (candidate.sensitive) return decision(false, 'quarantined', 'sensitive_text_detected');
    if (candidate.noWriteReason) return decision(false, 'rejected', `no_write:${candidate.noWriteReason}`);
    if (candidateLooksEphemeral(candidate)) return decision(false, 'rejected', 'ephemeral_or_runtime_state');
    if (candidate.confidence < this.minConfidence) return decision(false, 'rejected', 'low_confidence');
    if (this.requireEvidenceForAuto && candidateNeedsSourceEvidence(candidate) && !candidateHasSourceEvidence(candidate)) {
      return decision(false, 'rejected', 'source_evidence_required');
    }
    if (candidateNeedsReview(candidate)) return decision(false, 'needs_review', 'review_required_for_high_risk_memory');
    return decision(true, 'accepted', 'accepted');
  }

  commit(input = {}, opts = {}) {
    const candidate = normalizeMemoryCandidate({ ...input, ...opts }, { now: this.now() });
    const verdict = this.validate(candidate);
    if (!verdict.ok) {
      try { this.auditLog?.recordCandidate?.(candidate, verdict); } catch (e) { this.logger?.warn?.('[noe-memory-gate] 记录候选失败:', e?.message || e); }
      return { ...verdict, candidate, memory: null };
    }
    if (!this.memory?.write) {
      const missing = decision(false, 'rejected', 'memory_not_wired');
      try { this.auditLog?.recordCandidate?.(candidate, missing); } catch { /* ignore */ }
      return { ...missing, candidate, memory: null };
    }
    let memory = null;
    try {
      memory = this.memory.write(candidateToMemoryInput(candidate));
    } catch (e) {
      const failed = decision(false, 'rejected', `memory_write_failed:${e?.message || e}`);
      try { this.auditLog?.recordCandidate?.(candidate, failed); } catch { /* ignore */ }
      return { ...failed, candidate, memory: null };
    }
    const targetMemoryId = memory?.id || null;
    try {
      this.auditLog?.recordCandidate?.(candidate, { ...verdict, targetMemoryId });
      if (targetMemoryId) this.auditLog?.linkMemory?.(targetMemoryId, candidateLinks(candidate, targetMemoryId));
    } catch (e) {
      this.logger?.warn?.('[noe-memory-gate] 记录链接失败:', e?.message || e);
    }
    return { ...verdict, candidate, memory };
  }
}
