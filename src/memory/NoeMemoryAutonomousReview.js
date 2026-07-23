// @ts-check

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { redactSensitiveText } from '../runtime/NoeContextScrubber.js';
import { ensureNoeMemoryV2Schema } from '../storage/NoeMemoryV2Schema.js';
import { NoeMemoryAuditLog } from './NoeMemoryAuditLog.js';
import { candidateLooksEphemeral, detectsSensitiveText, normalizeMemoryCandidate } from './NoeMemoryCandidateSchema.js';
import { STRONG_MEMORY_SOURCE_LINK_TYPES } from './NoeMemoryGovernanceRepair.js';

const GENERIC_SECRET_ASSIGNMENT_RE = /\b(api[_-]?key|token|secret|password|cookie)\s*[:=]\s*['"]?[^'"\s|]+/gi;

function redactReviewText(value) {
  return redactSensitiveText(String(value ?? '')).replace(GENERIC_SECRET_ASSIGNMENT_RE, (_match, key) => `${key}=[redacted]`);
}

function clean(value, max = 1000) {
  if (value === undefined || value === null) return '';
  return redactReviewText(String(value).trim().slice(0, max));
}

function clampLimit(value, fallback = 500) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(1, Math.min(5000, Math.trunc(n)));
}

function strongSourcePlaceholders() {
  return STRONG_MEMORY_SOURCE_LINK_TYPES.map(() => '?').join(',');
}

function mdCell(value) {
  return clean(value, 240).replace(/\|/g, '\\|').replace(/\n/g, ' ');
}

function decisionSummary(items) {
  const out = {};
  for (const item of items) out[item.decision] = (out[item.decision] || 0) + 1;
  return out;
}

export function listAutonomousReviewTargets({
  db,
  projectId = 'noe',
  limit = 500,
} = {}) {
  if (!db?.prepare) throw new Error('db required');
  ensureNoeMemoryV2Schema(db);
  const strong = strongSourcePlaceholders();
  const args = [clean(projectId, 240) || 'noe', Date.now(), ...STRONG_MEMORY_SOURCE_LINK_TYPES, clampLimit(limit)];
  return db.prepare(`
    SELECT id, project_id, scope, title, body, source_type, source_id, source_episode_id,
           tags, confidence, salience, created_at, updated_at, merge_trace
    FROM noe_memory m
    WHERE m.project_id = ?
      AND m.hidden = 0
      AND m.scope = 'fact'
      AND (m.expires_at IS NULL OR m.expires_at > ?)
      AND (m.source_episode_id IS NULL OR m.source_episode_id = '')
      AND (m.source_id IS NULL OR m.source_id = '')
      AND NOT EXISTS(SELECT 1 FROM noe_memory_link l WHERE l.memory_id=m.id AND l.link_type IN (${strong}) LIMIT 1)
    ORDER BY m.updated_at DESC
    LIMIT ?
  `).all(...args);
}

export function classifyAutonomousMemoryReview(row = {}) {
  const candidate = normalizeMemoryCandidate({
    id: `legacy-review-${row.id}`,
    kind: 'fact',
    projectId: row.project_id || 'noe',
    targetMemoryId: row.id,
    title: row.title || '',
    body: row.body || '',
    sourceType: 'legacy_memory_autonomous_review',
    sourceId: row.id,
    evidenceRefs: [`legacy_memory:${row.id}`],
    confidence: row.confidence,
    salience: row.salience,
    actor: 'noe_autonomous_review',
    privacy: 'private',
    writeMode: 'validated_consensus',
    tags: ['legacy-memory', 'autonomous-review'],
  }, { now: Date.now() });

  if (detectsSensitiveText(row.body) || candidate.sensitive) {
    return { candidate, decision: 'auto_quarantined_sensitive', reason: 'sensitive_text_detected', action: 'hide', trust: 'blocked' };
  }
  if (candidateLooksEphemeral(candidate)) {
    return { candidate, decision: 'auto_rejected_ephemeral', reason: 'ephemeral_or_runtime_state', action: 'hide', trust: 'blocked' };
  }
  if (candidate.confidence < 0.35) {
    return { candidate, decision: 'auto_retained_low_confidence', reason: 'low_confidence_legacy_fact', action: 'retain', trust: 'low' };
  }
  if (candidate.salience >= 5) {
    return { candidate, decision: 'auto_retained_guarded', reason: 'high_salience_without_strong_source', action: 'retain', trust: 'guarded' };
  }
  return { candidate, decision: 'auto_accepted_weak', reason: 'low_risk_legacy_fact_with_weak_provenance', action: 'retain', trust: 'weak' };
}

export function runNoeMemoryAutonomousReview({
  db,
  apply = false,
  hideUnsafe = true,
  projectId = 'noe',
  limit = 500,
  now = Date.now,
  auditLog = null,
} = {}) {
  if (!db?.prepare) throw new Error('db required');
  ensureNoeMemoryV2Schema(db);
  const logger = auditLog || new NoeMemoryAuditLog({ db: () => db, now });
  const rows = listAutonomousReviewTargets({ db, projectId, limit });
  const reviews = rows.map((row) => {
    const review = classifyAutonomousMemoryReview(row);
    return {
      memoryId: row.id,
      projectId: row.project_id,
      sourceType: clean(row.source_type, 80),
      confidence: Number(row.confidence) || 0,
      salience: Number(row.salience) || 0,
      bodySnippet: clean(row.body, 180),
      ...review,
    };
  });

  let candidatesRecorded = 0;
  let linksRecorded = 0;
  let hidden = 0;
  if (apply) {
    const hideStmt = db.prepare(`
      UPDATE noe_memory SET hidden=1, hidden_reason=?, updated_at=?
      WHERE id=? AND project_id=? AND hidden=0
    `);
    const deleteEmbeddingStmt = db.prepare("DELETE FROM embeddings WHERE kind='noe_memory' AND ref_id=?");
    const t = now();
    const tx = db.transaction(() => {
      for (const review of reviews) {
        logger.recordCandidate(review.candidate, {
          decision: review.decision,
          reason: review.reason,
          targetMemoryId: review.memoryId,
        });
        candidatesRecorded += 1;
        linksRecorded += logger.linkMemory(review.memoryId, [
          { type: 'autonomous_review', ref: review.candidate.id },
          { type: 'autonomous_review_decision', ref: review.decision },
        ]);
        if (hideUnsafe && review.action === 'hide') {
          hidden += hideStmt.run(`autonomous_review:${review.reason}`, t, review.memoryId, review.projectId).changes || 0;
          deleteEmbeddingStmt.run(review.memoryId);
        }
      }
    });
    tx();
  }

  const summary = decisionSummary(reviews);
  return {
    ok: true,
    projectId: clean(projectId, 240) || 'noe',
    mode: apply ? 'apply' : 'dry_run',
    scanned: rows.length,
    reviewed: reviews.length,
    summary,
    candidatesRecorded,
    linksRecorded,
    hidden,
    policy: {
      noStrongSourceFabrication: true,
      noHumanReviewRequired: true,
      unsafeFactsHiddenReversibly: hideUnsafe,
      bodySnippetsRedacted: true,
    },
    reviews,
  };
}

export function renderAutonomousReviewMarkdown(report = {}) {
  const rows = Array.isArray(report.reviews) ? report.reviews : [];
  const summary = report.summary || {};
  const lines = [
    '---',
    'type: noe_memory_autonomous_review',
    `project_id: ${clean(report.projectId || 'noe', 120)}`,
    `generated_at: ${new Date().toISOString()}`,
    `reviewed: ${Number(report.reviewed) || 0}`,
    `hidden: ${Number(report.hidden) || 0}`,
    'review_mode: autonomous',
    'strong_source_fabrication: false',
    '---',
    '',
    '# Noe Memory Autonomous Review',
    '',
    '## Summary',
    '',
    `- Reviewed: ${Number(report.reviewed) || 0}`,
    `- Hidden: ${Number(report.hidden) || 0}`,
    `- Decisions: ${Object.entries(summary).map(([k, v]) => `${k}=${v}`).join(', ') || 'none'}`,
    '- Strong source status: not promoted; weak legacy facts remain weak unless explicit evidence appears.',
    '',
    '## Items',
    '',
    '| Memory | Decision | Trust | Confidence | Salience | Source | Snippet |',
    '| --- | --- | --- | ---: | ---: | --- | --- |',
  ];
  for (const item of rows) {
    lines.push(`| ${mdCell(item.memoryId)} | ${mdCell(item.decision)} | ${mdCell(item.trust)} | ${Number(item.confidence).toFixed(2)} | ${Number(item.salience).toFixed(0)} | ${mdCell(item.sourceType)} | ${mdCell(item.bodySnippet)} |`);
  }
  lines.push('');
  return `${lines.join('\n')}\n`;
}

export function writeAutonomousReviewMarkdown({
  report,
  dir,
  filename = '',
} = {}) {
  if (!dir) throw new Error('mirror dir required');
  const safeDir = String(dir);
  mkdirSync(safeDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const file = join(safeDir, filename || `${stamp}-noe-memory-autonomous-review.md`);
  if (existsSync(file)) throw new Error(`mirror file exists: ${file}`);
  writeFileSync(file, renderAutonomousReviewMarkdown(report), { mode: 0o600 });
  return file;
}
