// @ts-check
// P6RuminationReadiness — static/offline verifier for the P6 self-talk guard stack.
//
// This verifier deliberately separates isolated component readiness from
// production readiness. Production completion still requires live + DB evidence.

import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { validateP6ProductionEvidence } from './P6ProductionEvidence.js';
import { parseSelfTalkAuditJsonl, summarizeSelfTalkAudit } from './SelfTalkAuditStore.js';

const CORE_CHECKS = Object.freeze([
  {
    id: 'self_talk_outcome_contract',
    file: 'src/cognition/SelfTalkOutcome.js',
    mustContain: ['proposalId', 'played_to_user_confirmed', 'createAuditSnapshot', 'SelfTalkOutcome'],
  },
  {
    id: 'rumination_guard_modes',
    file: 'src/cognition/RuminationGuard.js',
    mustContain: ["'audit'", "'normal'", "'anchored'", "'off'", 'rotateSemanticSim: 0.40', 'readsVad: false'],
  },
  {
    id: 'audit_store_redaction',
    file: 'src/cognition/SelfTalkAuditStore.js',
    mustContain: ['llmContextAllowed: false', 'TEXT_KEYS', 'NOE_AUDIT_REDACTION', 'summarizeSelfTalkAudit'],
  },
  {
    id: 'runtime_evidence_bridge',
    file: 'src/cognition/SelfTalkRuntimeEvidence.js',
    mustContain: ['noe_self_talk_audit', 'recordDeliveryAck', 'summarizeSelfTalkAuditEvents', 'createSelfTalkRuntimeEvidence'],
  },
  {
    id: 'delivery_ack_confirmation',
    file: 'src/cognition/SelfTalkDeliveryAck.js',
    mustContain: ['isOwnerPerceivedDelivery', 'confirmedAt', 'manual_evidence', 'play_failed'],
  },
  {
    id: 'production_evidence_schema',
    file: 'src/cognition/P6ProductionEvidence.js',
    mustContain: ['validateP6ProductionEvidence', 'owner_confirmed_delivery_missing', 'port_51735_boundary_missing', 'sample_kind_not_production'],
  },
  {
    id: 'production_evidence_composer',
    file: 'src/cognition/P6ProductionEvidenceComposer.js',
    mustContain: ['composeP6ProductionEvidence', 'secretValuesReturned', 'ownerTokenPrinted', 'confirmedDelivery', 'synthesizedOnlyDelivery'],
  },
  {
    id: 'landing_policy',
    file: 'src/cognition/SelfTalkLandingPolicy.js',
    mustContain: ['maxUnlandedStreak', 'mustLandNext', "'silent'", 'externalLandingRate'],
  },
  {
    id: 'affect_guard_signal_contract',
    file: 'src/cognition/NoeAffectEngine.js',
    mustContain: ['isInnerEmotionNeutralized', 'getSignalContract', 'getVadForConsumers', 'ruminationGuardShouldReadVad: false'],
  },
  {
    id: 'inner_monologue_optional_wiring',
    file: 'src/loop/InnerMonologue.js',
    mustContain: ['effectiveInnerMode', "'audit'", 'createSelfTalkOutcome', 'decideRuminationGuard', 'createRuminationAuditRecord'],
  },
  {
    id: 'audit_replay_script',
    file: 'scripts/noe-self-talk-audit-replay.mjs',
    mustContain: ['summarizeSelfTalkAudit', 'audit_file_missing'],
  },
  {
    id: 'guard_fixture_script',
    file: 'scripts/noe-rumination-guard-fixture.mjs',
    mustContain: ['ruminationGuardTripRate', 'audit_shadows_without_blocking'],
  },
  {
    id: 'production_evidence_verify_script',
    file: 'scripts/noe-p6-production-evidence-verify.mjs',
    mustContain: ['validateP6ProductionEvidence', 'evidence_file_required', '--audit-file'],
  },
  {
    id: 'production_evidence_compose_script',
    file: 'scripts/noe-p6-production-evidence-compose.mjs',
    mustContain: ['composeP6ProductionEvidence', '--runtime-file', '--db-file', '--audit-file'],
  },
  {
    id: 'live_evidence_snapshot_script',
    file: 'scripts/noe-p6-live-evidence-snapshot.mjs',
    mustContain: ['SELF_TALK_AUDIT_EVENT_KIND', '/api/noe/readiness', 'p6-runtime-summary.json', 'ownerTokenPrinted'],
  },
  {
    id: 'p6_status_doc',
    file: 'docs/P6_RUMINATION_GUARD_WORKTREE_STATUS_2026-06-12.md',
    mustContain: ['Main worktree port: done', 'Runtime Caveat', 'audit-first', 'played_to_user_confirmed'],
  },
]);

function read(root, rel) {
  const path = join(root, rel);
  if (!existsSync(path)) return { path, text: null };
  return { path, text: readFileSync(path, 'utf8') };
}

function checkFile(root, check) {
  const { path, text } = read(root, check.file);
  if (text == null) {
    return { id: check.id, status: 'fail', path, missing: ['file_missing'] };
  }
  const missing = check.mustContain.filter((needle) => !text.includes(needle));
  return {
    id: check.id,
    status: missing.length ? 'fail' : 'pass',
    path,
    missing,
  };
}

function auditEvidence({ auditFile = null, requireAudit = false } = {}) {
  if (!auditFile) {
    return {
      id: 'audit_jsonl_replay_evidence',
      status: requireAudit ? 'fail' : 'warn',
      reason: 'audit_file_not_provided',
    };
  }
  const file = resolve(auditFile);
  if (!existsSync(file)) {
    return {
      id: 'audit_jsonl_replay_evidence',
      status: 'fail',
      reason: 'audit_file_missing',
      file,
    };
  }
  const parsed = parseSelfTalkAuditJsonl(readFileSync(file, 'utf8'));
  const summary = summarizeSelfTalkAudit(parsed.records, { malformed: parsed.malformed });
  const pass = summary.ok && summary.selfTalkOutcomes > 0 && summary.guardRecords > 0 && summary.llmContextAllowed === false;
  return {
    id: 'audit_jsonl_replay_evidence',
    status: pass ? 'pass' : 'fail',
    file,
    summary,
    reason: pass ? null : 'audit_replay_insufficient',
  };
}

function liveDbEvidence({ liveEvidenceFile = null, requireLive = false, auditSummary = null } = {}) {
  if (!liveEvidenceFile) {
    return {
      id: 'live_db_evidence',
      status: requireLive ? 'fail' : 'warn',
      reason: 'live_evidence_file_not_provided',
    };
  }
  const file = resolve(liveEvidenceFile);
  if (!existsSync(file)) {
    return {
      id: 'live_db_evidence',
      status: 'fail',
      reason: 'live_evidence_file_missing',
      file,
    };
  }
  let parsed = null;
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return {
      id: 'live_db_evidence',
      status: 'fail',
      reason: 'live_evidence_file_malformed',
      file,
    };
  }
  const validated = validateP6ProductionEvidence(parsed, { auditSummary });
  return {
    id: 'live_db_evidence',
    status: validated.ok ? 'pass' : 'fail',
    file,
    summary: validated.summary,
    warnings: validated.warnings,
    blockers: validated.blockers,
    reason: validated.ok ? null : 'live_db_evidence_insufficient',
  };
}

export function verifyP6RuminationReadiness({
  root = process.cwd(),
  auditFile = null,
  liveEvidenceFile = null,
  requireAudit = false,
  requireLive = false,
} = {}) {
  const rootPath = resolve(root);
  const coreChecks = CORE_CHECKS.map((check) => checkFile(rootPath, check));
  const auditCheck = auditEvidence({ auditFile, requireAudit });
  const liveCheck = liveDbEvidence({
    liveEvidenceFile,
    requireLive,
    auditSummary: auditCheck.summary || null,
  });
  const checks = [...coreChecks, auditCheck, liveCheck];
  const failed = checks.filter((check) => check.status === 'fail');
  const warnings = checks.filter((check) => check.status === 'warn');
  const coreReady = coreChecks.every((check) => check.status === 'pass');
  const productionReady = coreReady && auditCheck.status === 'pass' && liveCheck.status === 'pass';
  return {
    ok: failed.length === 0,
    productionReady,
    root: rootPath,
    passed: checks.filter((check) => check.status === 'pass').length,
    failed: failed.length,
    warnings: warnings.length,
    checks,
    blockers: failed.map((check) => check.reason || check.id),
  };
}
