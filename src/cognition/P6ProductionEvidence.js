// @ts-check
// P6ProductionEvidence — validates real live/DB evidence for P6 readiness.
//
// This guard prevents synthetic, controlled, or TTS-only samples from being
// counted as proof that self-talk actually reached the owner in production.

const ALLOWED_RUNTIME_MODES = new Set(['audit', 'normal', 'anchored']);
const DISALLOWED_SAMPLE_KINDS = new Set(['synthetic', 'fixture', 'test', 'controlled', 'dry_run']);

function bool(value) {
  return value === true;
}

function finiteNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function nonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function getMetric(evidence, key, auditSummary = null) {
  const direct = finiteNumber(evidence?.[key]);
  if (direct != null) return direct;
  const db = finiteNumber(evidence?.db?.[key]);
  if (db != null) return db;
  const audit = finiteNumber(evidence?.audit?.[key]);
  if (audit != null) return audit;
  const replay = finiteNumber(evidence?.auditReplay?.[key]);
  if (replay != null) return replay;
  const summary = finiteNumber(auditSummary?.[key]);
  return summary == null ? 0 : summary;
}

function deriveConfirmedLandingRate(rate, confirmedDelivery, selfTalkOutcomes) {
  if (rate > 0) return rate;
  if (confirmedDelivery <= 0 || selfTalkOutcomes <= 0) return 0;
  return Math.max(0, Math.min(1, confirmedDelivery / selfTalkOutcomes));
}

function evidenceRefCount(evidence) {
  const refs = [
    ...asArray(evidence?.evidenceRefs),
    ...asArray(evidence?.runtime?.evidenceRefs),
    ...asArray(evidence?.db?.evidenceRefs),
    ...asArray(evidence?.frontendAck?.evidenceRefs),
    ...asArray(evidence?.audit?.evidenceRefs),
  ].filter(nonEmptyString);
  return refs.length;
}

function sampleKind(evidence) {
  return String(evidence?.sampleKind || evidence?.sourceKind || 'unknown').toLowerCase();
}

export function validateP6ProductionEvidence(evidence = {}, {
  auditSummary = null,
} = {}) {
  const blockers = [];
  const warnings = [];
  const mode = evidence?.mode || evidence?.innerMode || evidence?.runtime?.mode || null;
  const kind = sampleKind(evidence);
  const port = finiteNumber(evidence?.port ?? evidence?.runtime?.port);
  const selfTalkOutcomes = getMetric(evidence, 'selfTalkOutcomes', auditSummary);
  const guardRecords = getMetric(evidence, 'guardRecords', auditSummary);
  const confirmedDelivery = getMetric(evidence, 'confirmedDelivery', auditSummary);
  const synthesizedOnlyDelivery = getMetric(evidence, 'synthesizedOnlyDelivery', auditSummary);
  const ruminationGuardTripRate = getMetric(evidence, 'ruminationGuardTripRate', auditSummary);
  const confirmedSelfTalkLandingRate = deriveConfirmedLandingRate(
    getMetric(evidence, 'confirmedSelfTalkLandingRate', auditSummary),
    confirmedDelivery,
    selfTalkOutcomes,
  );
  const landingComplianceRate = getMetric(evidence, 'landingComplianceRate', auditSummary);
  const externalLandingRate = getMetric(evidence, 'externalLandingRate', auditSummary);
  const silentClosures = getMetric(evidence, 'silentClosures', auditSummary);
  const hasOwnerDeliveryCandidate = confirmedDelivery > 0 || confirmedSelfTalkLandingRate > 0 || synthesizedOnlyDelivery > 0 || evidence?.requiresOwnerPerceivedDelivery === true;
  const hasClosedSelfTalk = landingComplianceRate > 0 || silentClosures > 0;
  const refs = evidenceRefCount(evidence);

  if (evidence?.schemaVersion !== 1) blockers.push('schema_version_missing_or_unsupported');
  if (DISALLOWED_SAMPLE_KINDS.has(kind)) blockers.push(`sample_kind_not_production:${kind}`);
  if (!ALLOWED_RUNTIME_MODES.has(mode)) blockers.push('runtime_mode_not_auditable');
  if (port !== 51835) blockers.push('live_port_not_51835');
  if (!bool(evidence?.liveVerified ?? evidence?.runtime?.liveVerified)) blockers.push('live_not_verified');
  if (!bool(evidence?.dbVerified ?? evidence?.db?.verified)) blockers.push('db_not_verified');
  if (!bool(evidence?.no51735Touched ?? evidence?.runtime?.no51735Touched)) blockers.push('port_51735_boundary_missing');
  if (evidence?.secretValuesReturned !== false) blockers.push('secret_redaction_not_proven');
  if (evidence?.ownerTokenPrinted !== false) blockers.push('owner_token_print_boundary_not_proven');
  if (evidence?.llmContextAllowed === true || auditSummary?.llmContextAllowed === true) blockers.push('audit_context_leak_risk');
  if (selfTalkOutcomes <= 0) blockers.push('self_talk_outcomes_missing');
  if (guardRecords <= 0) blockers.push('guard_records_missing');
  if (hasOwnerDeliveryCandidate && confirmedDelivery <= 0) blockers.push('owner_confirmed_delivery_missing');
  if (hasOwnerDeliveryCandidate && confirmedSelfTalkLandingRate <= 0) blockers.push('confirmed_landing_rate_missing');
  if (!hasOwnerDeliveryCandidate && !hasClosedSelfTalk) blockers.push('self_talk_closure_missing');
  if (ruminationGuardTripRate < 0 || ruminationGuardTripRate > 1) blockers.push('rumination_guard_trip_rate_invalid');
  if (landingComplianceRate < 0 || landingComplianceRate > 1) blockers.push('landing_compliance_rate_invalid');
  if (refs < 3) blockers.push('evidence_refs_insufficient');
  if (synthesizedOnlyDelivery > 0 && confirmedDelivery <= 0) blockers.push('tts_only_delivery_not_owner_perceived');

  if (kind === 'unknown') warnings.push('sample_kind_unknown_but_not_disallowed');
  if (!hasOwnerDeliveryCandidate) warnings.push('owner_delivery_not_exercised_no_candidate');

  return Object.freeze({
    ok: blockers.length === 0,
    blockers,
    warnings,
    summary: Object.freeze({
      schemaVersion: evidence?.schemaVersion ?? null,
      sampleKind: kind,
      mode,
      port,
      liveVerified: bool(evidence?.liveVerified ?? evidence?.runtime?.liveVerified),
      dbVerified: bool(evidence?.dbVerified ?? evidence?.db?.verified),
      no51735Touched: bool(evidence?.no51735Touched ?? evidence?.runtime?.no51735Touched),
      secretValuesReturned: evidence?.secretValuesReturned ?? null,
      ownerTokenPrinted: evidence?.ownerTokenPrinted ?? null,
      selfTalkOutcomes,
      guardRecords,
      confirmedDelivery,
      synthesizedOnlyDelivery,
      confirmedSelfTalkLandingRate,
      landingComplianceRate,
      externalLandingRate,
      silentClosures,
      ruminationGuardTripRate,
      evidenceRefs: refs,
    }),
  });
}
