// @ts-check
// P6ProductionEvidenceComposer — builds the evidence JSON consumed by P6 validators.
//
// Inputs are summaries only. Do not pass prompts, owner text, tokens, or raw DB rows.

function finiteNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function bool(value) {
  return value === true;
}

function explicitFalseOrTrue(...values) {
  if (values.some((value) => value === true)) return true;
  if (values.some((value) => value === false)) return false;
  return null;
}

function maxMetric(...values) {
  return Math.max(0, ...values.map((value) => finiteNumber(value, 0)));
}

function rateMetric(...values) {
  const present = values
    .map((value) => Number(value))
    .filter((value) => Number.isFinite(value));
  if (!present.length) return 0;
  return Math.max(0, Math.min(1, present[present.length - 1]));
}

function deriveConfirmedLandingRate(rate, confirmedDelivery, selfTalkOutcomes) {
  const explicit = rateMetric(rate);
  if (explicit > 0) return explicit;
  const delivered = finiteNumber(confirmedDelivery, 0);
  const total = finiteNumber(selfTalkOutcomes, 0);
  if (delivered <= 0 || total <= 0) return 0;
  return Math.max(0, Math.min(1, delivered / total));
}

function evidenceRefs(...groups) {
  const refs = [];
  const seen = new Set();
  for (const group of groups) {
    for (const ref of Array.isArray(group) ? group : []) {
      if (typeof ref !== 'string' || !ref.trim() || seen.has(ref)) continue;
      seen.add(ref);
      refs.push(ref);
    }
  }
  return refs;
}

export function composeP6ProductionEvidence({
  runtime = {},
  db = {},
  auditSummary = {},
  frontendAck = {},
  sampleKind = 'production',
  mode = null,
} = {}) {
  const resolvedMode = mode || runtime.mode || db.mode || null;
  const port = finiteNumber(runtime.port ?? db.port, null);
  const liveVerified = bool(runtime.liveVerified) || (bool(runtime.healthOk) && bool(runtime.readinessOk));
  const dbVerified = bool(db.verified) || bool(db.dbVerified);
  const selfTalkOutcomes = maxMetric(db.selfTalkOutcomes, auditSummary.selfTalkOutcomes);
  const guardRecords = maxMetric(db.guardRecords, auditSummary.guardRecords);
  const confirmedDelivery = maxMetric(db.confirmedDelivery, frontendAck.confirmedDelivery, auditSummary.confirmedDelivery);
  const synthesizedOnlyDelivery = maxMetric(db.synthesizedOnlyDelivery, auditSummary.synthesizedOnlyDelivery);
  const confirmedSelfTalkLandingRate = deriveConfirmedLandingRate(rateMetric(
    auditSummary.confirmedSelfTalkLandingRate,
    db.confirmedSelfTalkLandingRate,
    frontendAck.confirmedSelfTalkLandingRate,
  ), confirmedDelivery, selfTalkOutcomes);
  const landingComplianceRate = rateMetric(auditSummary.landingComplianceRate, db.landingComplianceRate);
  const externalLandingRate = rateMetric(auditSummary.externalLandingRate, db.externalLandingRate);
  const silentClosures = maxMetric(auditSummary.silentClosures, db.silentClosures);
  const ruminationGuardTripRate = rateMetric(auditSummary.ruminationGuardTripRate, db.ruminationGuardTripRate);

  return Object.freeze({
    schemaVersion: 1,
    sampleKind,
    mode: resolvedMode,
    port,
    liveVerified,
    dbVerified,
    no51735Touched: bool(runtime.no51735Touched),
    secretValuesReturned: explicitFalseOrTrue(runtime.secretValuesReturned, db.secretValuesReturned, frontendAck.secretValuesReturned),
    ownerTokenPrinted: explicitFalseOrTrue(runtime.ownerTokenPrinted, db.ownerTokenPrinted, frontendAck.ownerTokenPrinted),
    llmContextAllowed: auditSummary.llmContextAllowed === true,
    selfTalkOutcomes,
    guardRecords,
    confirmedDelivery,
    synthesizedOnlyDelivery,
    confirmedSelfTalkLandingRate,
    landingComplianceRate,
    externalLandingRate,
    silentClosures,
    ruminationGuardTripRate,
    evidenceRefs: evidenceRefs(runtime.evidenceRefs, db.evidenceRefs, frontendAck.evidenceRefs, auditSummary.evidenceRefs),
    runtime: Object.freeze({
      mode: resolvedMode,
      port,
      liveVerified,
      no51735Touched: bool(runtime.no51735Touched),
      evidenceRefs: evidenceRefs(runtime.evidenceRefs),
    }),
    db: Object.freeze({
      verified: dbVerified,
      selfTalkOutcomes,
      guardRecords,
      confirmedDelivery,
      synthesizedOnlyDelivery,
      landingComplianceRate,
      externalLandingRate,
      silentClosures,
      evidenceRefs: evidenceRefs(db.evidenceRefs),
    }),
    frontendAck: Object.freeze({
      confirmedDelivery,
      evidenceRefs: evidenceRefs(frontendAck.evidenceRefs),
    }),
    auditReplay: Object.freeze({
      selfTalkOutcomes: finiteNumber(auditSummary.selfTalkOutcomes, 0),
      guardRecords: finiteNumber(auditSummary.guardRecords, 0),
      confirmedDelivery: finiteNumber(auditSummary.confirmedDelivery, 0),
      synthesizedOnlyDelivery: finiteNumber(auditSummary.synthesizedOnlyDelivery, 0),
      confirmedSelfTalkLandingRate: finiteNumber(auditSummary.confirmedSelfTalkLandingRate, 0),
      landingComplianceRate: finiteNumber(auditSummary.landingComplianceRate, 0),
      externalLandingRate: finiteNumber(auditSummary.externalLandingRate, 0),
      silentClosures: finiteNumber(auditSummary.silentClosures, 0),
      ruminationGuardTripRate: finiteNumber(auditSummary.ruminationGuardTripRate, 0),
      llmContextAllowed: auditSummary.llmContextAllowed === true,
    }),
  });
}
